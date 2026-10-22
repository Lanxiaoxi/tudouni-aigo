package runtime

import (
	"fmt"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// resolveModel picks the model and route this session should use.
//
// Priority: the session's own choice, then the first model on the default route,
// then any other usable route. The last step exists because a session can outlive
// the route it was using — a key removed from the config, say — and refusing to
// start would strand a session that is otherwise fine.
func resolveModel(modelState *state.SessionModel, catalog state.Registry) (string, state.Provider, error) {
	selected := modelState.Selected()
	provider := modelState.SelectedProvider()

	if provider != "" {
		if route, ok := catalog.ProviderByName(provider); ok {
			if ref, found := route.Find(selected); found {
				return ref.ID, route, nil
			}
		}
	}
	if ref, ok := catalog.Find(selected, ""); ok {
		route, _ := catalog.ProviderByName(ref.Provider)
		return ref.ID, route, nil
	}
	if ref, ok := catalog.DefaultModel(); ok {
		route, _ := catalog.ProviderByName(ref.Provider)
		return ref.ID, route, nil
	}
	for _, route := range catalog.Providers {
		if route.Usable() && len(route.Models) > 0 {
			return route.Models[0].ID, route, nil
		}
	}
	return "", state.Provider{}, errorf("no usable model route")
}

// routeOf turns one catalogue entry into the model package's route value.
//
// It is the **only** place the two descriptions of a route meet, which is the
// point of it existing: the catalogue says where requests go, and the model
// package says how to send them, and neither has to know the other's field names
// beyond this one conversion. A new route capability is added here once, instead
// of at every construction site — and there is more than one, because delegated
// subagents build their own adapter.
//
// The session id is threaded through here for the same reason. A vendor that asks
// for a per-conversation header gets one without the model package knowing that
// vendor's name and without the configuration file naming a session it cannot see:
// the configuration writes the placeholder, and this is where the value is filled
// in.
func routeOf(provider state.Provider, modelID, sessionID string) model.Route {
	return model.Route{
		Name:      provider.Name,
		APIKey:    provider.APIKey,
		BaseURL:   provider.BaseURL,
		Model:     modelID,
		SessionID: sessionID,
		Verify:    provider.Verify,
		Style:     model.NormalizeStyle(provider.APIStyle),
		Headers:   provider.Headers,
	}
}

// SetModel implements protocol.Runtime.
//
// Name resolution, in this order and for this reason:
//
//  1. `provider/model` splits on the slash;
//  2. a bare name that is **a route** resolves to that route's first model — checked
//     *before* the model lookup, because a route whose name happens to equal a model
//     name (`/model flash`) would otherwise switch models when the user meant the
//     route. The two differ on the bill;
//  3. otherwise it is a model id, and an id that exists on two routes is refused
//     rather than guessed: the two answers differ in billing and in compliance.
//
// A model that is already the current one answers "already" rather than reporting a
// switch — the interface echoes that sentence verbatim, and "switched to X from X"
// reads like something happened.
func (r *Runtime) SetModel(name string) (bool, string) {
	catalog := r.Catalog

	wanted := strings.TrimSpace(name)
	providerName := ""
	if split := strings.Index(wanted, "/"); split >= 0 {
		providerName = strings.TrimSpace(wanted[:split])
		wanted = strings.TrimSpace(wanted[split+1:])
	}

	if wanted == "" && providerName != "" {
		found, ok := catalog.ProviderByName(providerName)
		if !ok {
			return false, i18n.T("model.select.no_route", "route", providerName, "names", strings.Join(routeNames(catalog), ", "))
		}
		if len(found.Models) == 0 {
			return false, i18n.T("model.select.route_empty", "route", providerName)
		}
		wanted = found.Models[0].ID
	} else if providerName == "" {
		if found, ok := catalog.ProviderByName(wanted); ok {
			if len(found.Models) == 0 {
				return false, i18n.T("model.select.route_empty", "route", wanted)
			}
			providerName, wanted = wanted, found.Models[0].ID
		}
	}

	ref, ok := catalog.Find(wanted, providerName)
	if !ok {
		if hits := catalog.Ambiguous(wanted); len(hits) > 1 {
			var names []string
			for _, hit := range hits {
				names = append(names, hit.Qualified())
			}
			return false, i18n.T("model.select.ambiguous", "name", wanted, "names", strings.Join(names, ", "))
		}
		var known []string
		for _, model := range catalog.Models() {
			known = append(known, model.ID)
		}
		if len(known) == 0 {
			known = []string{i18n.T("model.select.none_known")}
		}
		return false, i18n.T("model.select.unknown", "name", wanted, "known", strings.Join(known, ", "))
	}

	route, ok := catalog.ProviderByName(ref.Provider)
	if !ok {
		return false, i18n.T("model.select.route_gone", "route", ref.Provider)
	}
	if !route.Usable() {
		return false, i18n.T("model.select.no_key", "route", ref.Provider, "path", r.Catalog.Source)
	}

	if r.ModelState.Selected() == ref.ID && r.ModelState.SelectedProvider() == ref.Provider {
		return true, i18n.T("model.select.already", "name", ref.Qualified())
	}

	previous := r.ModelState.RouteName()

	// The adapter has to accept the change before the session records it. Recording
	// first would leave the session claiming a model the client is not using, and
	// nothing anywhere would report the divergence.
	//
	// **Same route or another route is a real distinction.** Renaming the model on
	// the same route only changes one request field; moving to another route changes
	// the key and the endpoint, which is what `Install` is for. Using `SwitchModel`
	// for both is the worst shape of bug available here: the interface, the session
	// and the audit all say the new route while the request keeps going to the old
	// endpoint on the old key.
	if !r.switchChat(ref, route) {
		return false, i18n.T("model.select.no_switch", "kind", fmt.Sprintf("%T", r.Chat), "path", r.Catalog.Source)
	}
	r.ModelState.SelectRoute(ref.Provider, ref.ID, 0)
	r.applyDefaultEffortFor(ref)
	r.syncReasoning()
	r.rebindContextWindow()
	r.checkpoint()

	if previous == "" {
		previous = i18n.T("model.select.unknown_previous")
	}
	return true, i18n.T("model.select.switched", "name", ref.Qualified(), "previous", previous)
}

// switchChat moves the adapter onto one catalogue entry, choosing the cheap path
// when it can.
func (r *Runtime) switchChat(ref state.ModelRef, route state.Provider) bool {
	if r.sameRoute(route) {
		return r.Chat.SwitchModel(ref.ID)
	}
	// Another route: the key, the endpoint and the protocol have to move as well.
	// An adapter that cannot do that is refused rather than renamed, because
	// renaming alone leaves the request going to the old endpoint on the old key
	// while `/status` and the session record both say the new route.
	return r.Chat.Install(routeOf(route, ref.ID, r.SessionIDValue))
}

// sameRoute reports whether the adapter is already pointed at this route.
//
// The comparison is now the whole route rather than a field of it — the same
// test, extended to the parts that did not exist when it was written. It matters
// that the protocol and the extra headers are compared too: a route that changed
// from chat completions to Messages, or that gained a header the vendor now
// requires, is a different endpoint in every sense that matters, and taking the
// cheap "rename the model" path across that change is how the screen ends up
// describing a route that is not the one being talked to.
//
// An adapter that does not describe itself as a route at all falls back to the
// name test: refusing to switch would be worse than a conservative answer, and
// the only adapters in this program do implement it.
func (r *Runtime) sameRoute(route state.Provider) bool {
	if r.Chat.ProviderName() != route.Name {
		return false
	}
	return r.Chat.SameEndpoint(routeOf(route, r.Chat.ModelName(), r.SessionIDValue))
}

// managedLevels is the effort vocabulary the runtime offers and enforces: the
// list the model in use declares, or the broad default when it declares none.
//
// It is asked of the catalogue every time rather than remembered in a field. A
// cached copy was tried and removed the same day: it made "which levels apply"
// have two answers — the field and the catalogue — and a runtime built anywhere
// other than the assembly path had an empty field, so it silently offered the
// broad vocabulary for a model that had declared a narrow one. The catalogue is
// the only thing that knows, so it is the only thing asked.
func (r *Runtime) managedLevels() []string {
	return r.Catalog.EffortLevelsFor(r.ModelState.Selected(), r.ModelState.SelectedProvider())
}

// applyDefaultEffortFor moves the session onto a model's own default level.
//
// Only when nobody has chosen one. A level a person set is not this function's
// to overwrite, even when the new model would rather have another — and when the
// new model cannot take it, the refusal comes from the endpoint at the next
// request, which is the one place that actually knows. Silently meeting the new
// model halfway is what this deliberately does not do: it would change the
// request while leaving the chosen level on screen unchanged.
func (r *Runtime) applyDefaultEffortFor(ref state.ModelRef) {
	if r.ModelState.EffortChosen() || ref.DefaultEffort == "" {
		return
	}
	if r.ModelState.Effort() != ref.DefaultEffort {
		r.ModelState.SelectEffort(ref.DefaultEffort, 0)
	}
}

// syncReasoning hands both thinking knobs back to the adapter.
//
// One place does this, and it is called from both paths that can change what
// `/effort` may offer — composing a session and switching models — because two
// call sites resolving the same question is two answers waiting to disagree.
func (r *Runtime) syncReasoning() {
	r.Chat.SetReasoning(r.ModelState.Thinking(), r.ModelState.Effort())
}

// rebindContextWindow re-points the context budget at the model now in use.
//
// **The budget is built once, at assembly, and a model switch does not rebuild
// it.** That is the whole bug this fixes: `/model` moves the adapter, the session
// record and the audit, and the context layer kept whatever window it was handed
// when the runtime opened. A session that opened on a 262144 model and moved to a
// 524288 one went on compacting at the smaller model's threshold — it folded
// history at ~200k on a half-million-token window, which reads from the outside
// as "the context window was misjudged". The ledger made the contradiction
// visible in one screen: `window` tracked the live model while `limit_tokens`
// did not.
//
// Nil-safe on both sides. A runtime assembled without a context layer has
// nothing to re-point, and a model that declares no window turns the budget
// **off** (see Budget.SetWindow) rather than keeping a ceiling that belonged to
// a model this session is no longer talking to.
func (r *Runtime) rebindContextWindow() {
	if r.ContextValue == nil {
		return
	}
	r.ContextValue.Budget.SetWindow(
		windowFor(r.Chat.ModelName(), r.Chat.ProviderName(), r.Catalog))
}

// routeNames lists the configured route names, for a "no such route" message that
// tells the user what there is.
func routeNames(catalog state.Registry) []string {
	out := make([]string, 0, len(catalog.Providers))
	for _, provider := range catalog.Providers {
		out = append(out, provider.Name)
	}
	return out
}

// SetThinking implements protocol.Runtime.
func (r *Runtime) SetThinking(on bool) (bool, string) {
	r.ModelState.SelectThinking(on, 0)
	r.Chat.SetReasoning(on, r.ModelState.Effort())
	r.checkpoint()
	if on {
		return true, i18n.T("thinking.select.on", "effort", r.ModelState.Effort())
	}
	return true, i18n.T("thinking.select.off")
}

// SetEffort implements protocol.Runtime.
//
// The list it checks against is the one the model in use declares, so a level a
// neighbouring model takes is refused here with a sentence naming what this one
// takes, rather than travelling to the endpoint to earn a bare 400.
func (r *Runtime) SetEffort(level string) (bool, string) {
	levels := r.managedLevels()
	if state.IsOff(level) {
		return false, i18n.T("effort.select.off_word", "levels", strings.Join(levels, " / "))
	}
	resolved, ok := state.ResolveEffort(level, levels)
	if !ok {
		return false, i18n.T("effort.select.unknown",
			"effort", level,
			"levels", strings.Join(levels, " / "))
	}
	r.ModelState.SelectEffort(resolved, 0)
	r.Chat.SetReasoning(r.ModelState.Thinking(), resolved)
	r.checkpoint()
	if !r.ModelState.Thinking() {
		return true, i18n.T("effort.select.ok_off", "level", resolved)
	}
	return true, i18n.T("effort.select.ok", "level", resolved)
}

// windowFor is the declared context window of one catalogue entry, or nil when
// the model is unknown or declares none.
//
// It is one function because two callers have to agree: assembling the context
// budget and re-pointing it after a model switch. A second lookup would be a
// second answer to "how big is this model's window", and the symptom when they
// disagree is a budget that compacts against one model while the request goes to
// another.
func windowFor(modelID, provider string, catalog state.Registry) *int {
	ref, ok := catalog.Find(modelID, provider)
	if !ok || ref.Window == nil {
		return nil
	}
	value := *ref.Window
	return &value
}

func (r *Runtime) modelWindow() any {
	window := windowFor(r.Chat.ModelName(), r.Chat.ProviderName(), r.Catalog)
	if window == nil {
		return nil
	}
	return *window
}

func (r *Runtime) contextTokens() any { return r.modelWindow() }

func (r *Runtime) modelCatalog() map[string]any {
	rows := make([]any, 0)
	aliases := make([]any, 0)
	current := r.Chat.ModelName()
	currentProvider := r.Chat.ProviderName()
	for _, model := range r.Catalog.Models() {
		isCurrent := model.ID == current && model.Provider == currentProvider
		// The row for the model in use carries the level actually set, which may
		// not be that model's default; every other row carries what picking it
		// would give. A row that reported the declared default while the session
		// ran on something else would describe a request nobody is making.
		effort := ""
		if isCurrent {
			effort = r.ModelState.Effort()
		}
		rows = append(rows, model.AsRow(isCurrent, effort))
	}
	return map[string]any{"models": rows, "aliases": aliases}
}
