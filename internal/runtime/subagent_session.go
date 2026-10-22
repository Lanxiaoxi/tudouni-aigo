package runtime

import (
	"fmt"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/subagent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
)

// subagentMaxDepth is how deep delegation may go: the top-level agent is depth 0,
// so a value of 3 permits three nested levels. It is a constant rather than a
// config field because the number is a budget on the session's own account, and a
// setting nobody asked for is a setting nobody will find.
const subagentMaxDepth = subagent.DefaultMaxDepth

// subagentMaxBackground is how many background delegations may run at once. It
// is a constant for the same reason the depth cap is: a budget on the session's
// own account. Smaller than the depth cap on purpose — depth bounds nesting,
// this bounds width, and each live background delegation is a whole agent loop
// with nobody watching it.
const subagentMaxBackground = subagent.DefaultMaxBackground

// ResolveChild builds the chat client a delegated subagent runs on.
//
// It implements subagent.RouteResolver. The interface lives in the subagent
// package and the implementation lives here because resolving a route means
// knowing the catalogue and which keys are usable — assembly, which the subagent
// package deliberately does not do.
//
// The default is the route this session is **currently** on, not the one it
// started on: a user who switched models mid-session and then delegated would
// otherwise get the old model answering, with nothing on screen saying so.
func (r *Runtime) ResolveChild(route subagent.Route, parentModel, parentProvider string) (subagent.ChildChat, error) {
	// A selection built from the request, so the existing resolution rules apply
	// unchanged: an explicit `provider` is a hard constraint, and a bare model
	// name is looked up across the catalogue. Reimplementing that here is how the
	// `/model` command and delegation would end up disagreeing about what a given
	// model name means.
	selection := state.Selection{
		Model:    firstNonEmpty(route.Model, parentModel),
		Provider: firstNonEmpty(route.Provider, parentProvider),
		Thinking: r.ModelState.Thinking(),
		Effort:   firstNonEmpty(route.Effort, r.ModelState.Effort()),
	}
	metadata := map[string]any{}
	state.StoreSelection(metadata, selection, 0)
	if _, ok := state.LoadSelection(metadata); !ok {
		return subagent.ChildChat{}, errorf("no model named for the subagent")
	}

	modelState := state.NewSessionModel(metadata, selection.Model, selection.Provider)
	chosen, provider, err := resolveModel(modelState, r.Catalog)
	if err != nil {
		return subagent.ChildChat{}, err
	}
	// The key has to be present, and this is the one check the store cannot make:
	// a route with no key is in the catalogue but cannot answer, and a subagent
	// built on it would fail on its first model call with a message about
	// credentials rather than about the delegation.
	if provider.APIKey == "" {
		return subagent.ChildChat{}, fmt.Errorf("route %s has no API key", provider.Name)
	}

	// **The catalogue's key is a copy, and it goes stale while the session
	// lives.** The catalogue is read once at open; when the session later
	// refreshes a managed token (`authCheck`, `RecoverAuth`) the new key is
	// installed on the session's live client and written to the config, but
	// `r.Catalog` is never re-read, so its `api_key` stays on whatever token
	// was current at open. The parent never notices: it sends from the live
	// client, which is exactly what keeps a long session working — "the parent
	// works" proves nothing about the age of the catalogue's copy. A child
	// resolved from the catalogue would therefore ship a token the endpoint
	// already revoked, earn one 401, and have no recovery hook to retry with —
	// the delegation dies on its first model call while the parent carries on.
	//
	// The live client's key is the one the session actually sends, and it is
	// the freshest copy this process has. It is authoritative only for the
	// route it is on — anything else falls back to the catalogue, which is
	// where that route's key came from anyway.
	if r.Chat != nil && provider.Name == r.Chat.ProviderName() {
		if live := r.Chat.Route().APIKey; live != "" {
			provider.APIKey = live
		}
	}

	thinking, effort := modelState.Thinking(), modelState.Effort()
	if route.Effort == "" {
		// An explicit reasoning level for the child would need `reasoning_effort`
		// handling on the request path, which the parent's own `/model` command
		// already covers. Until a caller can actually set ChildEffort, the
		// session's level is the honest answer — and it is the predictable one,
		// since changing a route here would otherwise silently change how hard the
		// model thinks.
		effort = r.ModelState.Effort()
	}

	// The **parent's** session id, deliberately, not the child's own. A delegated
	// call belongs to the same conversation, which is what a gateway asking for a
	// per-conversation identifier is asking about — routing and cache affinity are
	// about the work, and the work is the same session. The child's own id is not
	// available here in any case: it is minted by the spawn path, which calls this
	// resolver before it creates the child session, and threading it through would
	// mean teaching the subagent package about request headers for a distinction the
	// gateway does not make.
	childChat, err := model.New(model.Options{
		Route:    routeOf(provider, chosen, r.SessionIDValue),
		Thinking: thinking,
		Effort:   effort,
	})
	if err != nil {
		return subagent.ChildChat{}, err
	}

	return subagent.ChildChat{
		Chat:     childChat,
		Model:    chosen,
		Provider: provider,
	}, nil
}

// notesFrom is the payload tail a delegated subagent gets: the bodies of the
// skills that are loaded, and nothing else.
//
// The parent's own tail (see notes below) carries four parts, and three of them
// are deliberately withheld from a child. The task list is the parent's stated
// plan and a child has its own task — showing it the parent's list invites it to
// mark steps done that it never ran. The skill *catalogue* is a menu for
// choosing, and which skill to use was the parent's decision, already made before
// it delegated. The background-job warning is about this session's processes, and
// a child cannot delegate at all.
func notesFrom(skills *builtin.SkillBoard) func() string {
	if skills == nil {
		return nil
	}
	return skills.Note
}

// OnDelegationChanged reports that a subagent started or finished.
//
// It is the seam the protocol server uses to push a fresh snapshot at the two
// moments a delegation changes what the screen should say. It takes no arguments
// because the state itself is read back through `StateMessage` — handing the
// payload through here would give the runtime a second definition of what a
// snapshot is.
//
// The body is empty on purpose: the board is already up to date by the time this
// is called (the delegation announced itself before the event went out), so there
// is nothing for the runtime to do. The method exists so the server can ask "may
// I tell somebody about this" without knowing what a board is.
func (r *Runtime) OnDelegationChanged() {}

// subagentPanel renders the delegations in flight for a front end.
//
// A nil board and an empty board both produce an empty list, never nil: a front
// end that has to tell "there are none" apart from "the runtime did not say" is
// a front end with a second definition of the panel's shape, and the first bug it
// produces is a crash on the empty case.
func (r *Runtime) subagentPanel() []any {
	rows := r.Subagents.Panel()
	out := make([]any, 0, len(rows))
	for _, row := range rows {
		out = append(out, row)
	}
	return out
}

// subagentsDonePanel renders the background delegations that have finished and
// are waiting to be collected.
//
// It is a separate list rather than extra rows on `subagents` because the two
// answer different questions: the running list is "is something working", the
// done list is "is there paid-for work nobody has read". A front end that wants
// both draws both; one that ignores the new key keeps working unchanged.
func (r *Runtime) subagentsDonePanel() []any {
	rows := r.Subagents.DonePanel()
	out := make([]any, 0, len(rows))
	for _, row := range rows {
		out = append(out, row)
	}
	return out
}

// SubagentStop answers the protocol's `subagent_stop` request: the user's
// per-child stop for background delegations.
//
// It reports whether a running background delegation was stopped. That
// distinction is the whole answer a front end needs — "already finished" and
// "no such id" are not the same failure, and the notice each deserves is worded
// differently.
//
// The two sentences below are English because that is how they reach a person: the
// protocol layer wraps them in an i18n notice (`channels.subagent.stop_failed`),
// so a Chinese error here produced a sentence that switched language halfway
// through.
func (r *Runtime) SubagentStop(id string) (bool, error) {
	if r.subagentStopper == nil {
		return false, fmt.Errorf("subagent delegation is unavailable in this session")
	}
	stopped := r.subagentStopper.Stop(id)
	if !stopped {
		return false, fmt.Errorf("no background subagent called %s is running (it may have finished, been stopped already, or the id may be wrong)", id)
	}
	return true, nil
}
