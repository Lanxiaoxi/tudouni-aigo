package runtime

import (
	"fmt"
	"os"
	"sync"
	"sync/atomic"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// `--ericai` inside a running session.
//
// `ericai.go` owns the flow itself: read the token, refresh it when it is near
// expiry, write it back. It is deliberately ignorant of sessions. This file is the
// other half, and it exists because of one fact about the running process:
//
//	**The catalogue is read once, at open, and the route's key is copied into the
//	model client there.** Writing a fresh token into the config therefore changes
//	nothing for a session that is already running — every later request still
//	carries the key that was current when the session started, and the answer is a
//	401 until the person quits and starts again. Refreshing the file was never
//	enough; the key has to be **installed on the live client** as well.
//
// Two moments trigger that, and they are the two ways a session can find itself
// holding a dead token:
//
//   - **before a request** (authCheck, through the agent's RetryHooks.BeforeEach).
//     The token is checked at the one moment its answer matters, so the ordinary
//     case — a session left open past the token's ~70 minute lifetime — repairs
//     itself with nobody typing anything;
//   - **after a refusal** (RecoverAuth, through RetryHooks.OnFatal). The clock
//     cannot see a token the endpoint has revoked, or a machine whose clock
//     disagrees with the server's. The refusal is the only evidence there is, and
//     it arrives classified as fatal, which is exactly why recovery has to be
//     allowed to overrule that classification once.
//
// Both are gated on `--ericai`. Without the flag this program does not manage
// anybody's credentials: a route is whatever the configuration says, and an
// authentication failure is reported exactly as any other fatal failure is.

// ericAuth is the session's EricAI token state.
//
// It is a field on Runtime rather than package state, because the failure mode of
// package state here is silent and specific: two runtimes in one process (a session
// switch builds a second one) would share a memo of "already installed" and one of
// them would go on sending a dead key.
type ericAuth struct {
	// route is the provider this session actually opened on, captured before
	// anything can move the client. Empty means no route was resolved, and every
	// method degrades to a sentence rather than guessing.
	route string
	// path is the configuration file, fixed at open. Empty means the user's own,
	// which is what RefreshEricAI resolves.
	path string

	// mu serializes refreshes **and installs**.
	//
	// Two refreshes at once are worse than slow: the interactive fallback would
	// open two device-code logins, and the person would be shown one code while the
	// other expired. The install needs the same lock for a different reason —
	// `Install` rewrites the adapter's route while a request may be reading it, so
	// two writers of that field is a race whose symptom is a request carrying half
	// of one route and half of another.
	//
	// The pre-request check and a 401 recovery both run on the turn's goroutine,
	// but a session switch or a `/model` runs on the server's, so this is a real
	// collision and not a theoretical one.
	mu sync.Mutex
	// key is the access token most recently written back, kept so a failed install
	// can be retried without minting a second token. `installed` records whether the
	// last refresh actually moved the client onto it — which is the only honest
	// answer to "is it worth sending that request again".
	key       string
	installed bool
	// recovered latches "this refusal was already answered with a refresh". It is
	// what keeps a genuine 401 loop — a revoked token, or a route that is wrong in
	// some other way — from becoming an endless one: the second refusal is reported.
	recovered atomic.Bool
	// pending is what the session has to say about the token and has not said yet.
	//
	// It is a queue rather than an immediate send because this file has no way to
	// send one: notices reach a person through the protocol server, and the server
	// collects them when the turn that earned them ends (see
	// Runtime.DrainAuthNotices). A credential event is not urgent enough to deserve
	// its own channel — the request it belongs to is over by the time anyone could
	// read it.
	pendingMu sync.Mutex
	pending   []map[string]any
}

// initAuth captures what the session opened with, and only for a session that
// asked for this.
//
// `--ericai` is the switch, and this is the whole of it: a session without the flag
// gets a nil auth, which every method below reads as "not mine to manage". Nothing
// is refreshed, no token is inspected, and a 401 is an ordinary fatal error.
func (r *Runtime) initAuth(enabled bool) {
	if !enabled || r.Chat == nil || r.Chat.ProviderName() == "" {
		return
	}
	r.auth = &ericAuth{route: r.Chat.ProviderName()}
}

// StartupAuth is the `--ericai` check at open: refresh before the first turn, so a
// stale token never survives into a session.
//
// It runs at open rather than in the entry point because both halves have to
// happen in the process that owns the client — the file is written *and* the key is
// installed — and because the interactive login's instructions have to travel
// somewhere a person can see them. At this point that is stderr: the interface has
// drawn nothing yet, and the entry point's terminal is still an ordinary one.
//
// The outcome is **queued rather than sent**, because the protocol has not opened
// yet: it becomes one of the start-up notices, which travel with the handshake.
func (r *Runtime) StartupAuth() {
	if r.auth == nil {
		return
	}
	status, detail := r.refresh(false)
	if text := joinAuth(status, detail); text != "" {
		r.notices = append(r.notices, notice(authLevel(detail), "auth", text))
	}
}

// authCheck runs before every model call, through the agent's
// RetryHooks.BeforeEach.
//
// It refreshes **only when one is due** — a JWT decode, and a read of the config
// only when something is actually near expiry. Nothing here starts a timer or
// polls: the refresh happens at the moment the token is about to be used, which is
// the only moment the answer matters, and that is also why a session left idle for
// hours costs nothing.
//
// A failure is reported and swallowed. The request is about to go out and is
// entitled to make its own attempt with whatever key is in place; turning a
// refresh problem into a failed turn would replace "401, here is why" with
// something less true.
func (r *Runtime) authCheck() {
	if r.auth == nil {
		return
	}
	status, detail := r.refresh(false)
	if text := joinAuth(status, detail); text != "" {
		r.auth.queue(authLevel(detail), text)
	}
}

// RecoverAuth answers a fatal model error with one refresh, and reports whether the
// request is worth sending again. It is what the agent's OnFatal hook calls.
//
// **Why a refusal gets a second chance when nothing else does.** A fatal error is
// final by definition, and retrying one normally means repeating the same failure
// and delaying the report by a round trip. A credential refusal is the one case
// where the error is about *what we sent to authenticate* rather than about the
// request, and this process can change that — so the classification is overruled
// once, and only for a failure of that kind.
func (r *Runtime) RecoverAuth(err error) bool {
	if r.auth == nil || err == nil {
		return false
	}
	if !model.IsCredential(err) {
		return false
	}
	if !r.auth.recovered.CompareAndSwap(false, true) {
		// A refusal was already answered with a refresh and the endpoint refused
		// again. That is a revoked token, or a route that is wrong in some other
		// way, and a third request would earn a third refusal.
		return false
	}
	_, detail := r.refresh(true)
	if text := joinAuth("", detail); text != "" {
		r.auth.queue(authLevel(detail), text)
	}
	// Retry only when that refresh actually put a **new** token on the client. A
	// refresh that failed, or one whose install was refused, leaves exactly the
	// request that just failed — and asking the weaker question ("does this session
	// have a key at all") answers yes for the token the endpoint has already
	// rejected, which is how a revoked token gets sent a second time.
	return r.auth.installChanged()
}

// DrainAuthNotices is what the protocol server collects once a turn ends.
//
// Optional-interface style, like the goal hooks: a runtime that has nothing to say
// about credentials simply does not implement it, and the server needs no
// knowledge of what a token is.
func (r *Runtime) DrainAuthNotices() []map[string]any {
	if r.auth == nil {
		return nil
	}
	return r.auth.drain()
}

// queue holds one sentence until the turn it belongs to is over.
func (a *ericAuth) queue(level, text string) {
	a.pendingMu.Lock()
	defer a.pendingMu.Unlock()
	a.pending = append(a.pending, notice(level, "auth", text))
}

func (a *ericAuth) drain() []map[string]any {
	a.pendingMu.Lock()
	defer a.pendingMu.Unlock()
	if len(a.pending) == 0 {
		return nil
	}
	out := a.pending
	a.pending = nil
	return out
}

// installChanged reports whether the last refresh actually moved the live client
// onto a different key.
func (a *ericAuth) installChanged() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.installed
}

// refresh mints a token when one is due and installs it on the live client.
//
// It returns the sentence for a successful refresh and, separately, whatever the
// install itself had to say. **The two are kept apart because they fail
// differently**: a refresh that fails leaves the session exactly as it was, while a
// refresh that succeeds and an install that fails leaves a good token on disk that
// this process is not using — a state worth saying out loud, since the next request
// will still be refused.
func (r *Runtime) refresh(force bool) (status, detail string) {
	auth := r.auth
	auth.mu.Lock()
	// Cleared first: the flag answers "did **this** refresh move the client", and a
	// value left over from the last one would let a no-op install claim it did.
	auth.installed = false
	result, err := RefreshEricAI(RefreshOptions{
		Path:     auth.path,
		Force:    force,
		Reporter: func(line string) { fmt.Fprintln(os.Stderr, line) },
	})
	if err != nil {
		auth.mu.Unlock()
		// The parenthetical is part of the sentence rather than something each caller
		// adds: what a person needs to know about a failed refresh is never just the
		// error — it is that the session is left exactly as it was, which is what
		// decides whether restarting would help.
		return "", fmt.Sprintf("%v (the old token stays)", err)
	}
	if result.Key != "" {
		auth.key = result.Key
	}
	key := auth.key
	installDetail, installErr := r.installAuth(key)
	auth.installed = installDetail != ""
	auth.mu.Unlock()

	if installErr != nil {
		return result.Status, installErr.Error()
	}
	return result.Status, installDetail
}

// installAuth re-reads the catalogue and moves the live client onto the route as it
// now stands in the configuration.
//
// Re-reading rather than patching the key in place is deliberate: it goes through
// `state.Load` and `routeOf`, the same two functions the session opened with, so
// everything else about the route — endpoint, protocol, headers — arrives exactly
// as a fresh start would have had it. A hand-patched key would be a second,
// subtly different route, and the moment a person edits their config the difference
// starts to show.
func (r *Runtime) installAuth(key string) (string, error) {
	auth := r.auth
	if key == "" || auth == nil || auth.route == "" || r.Chat == nil {
		return "", nil
	}
	if r.Chat.Route().APIKey == key {
		// Nothing to install: a token that arrived from another window, or a
		// refresh that handed back the key already being sent. Reporting "installed"
		// here would be a claim about activity that did not happen.
		return "", nil
	}
	catalog, err := state.Load(auth.path)
	if err != nil {
		return "", fmt.Errorf("could not re-read the config (%w)", err)
	}
	route, ok := catalog.ProviderByName(auth.route)
	if !ok {
		return "", fmt.Errorf("route %s is no longer in the config", auth.route)
	}
	if !route.Usable() {
		return "", fmt.Errorf("route %s has no api_key in the config", auth.route)
	}
	// **`Install`, not the switch path.** `switchChat` decides between "rename the
	// model" and "move the whole route" by asking whether the endpoint is the same —
	// and a refreshed token is always the same endpoint, so it would take the cheap
	// path and rename the model, leaving the dead key exactly where it was. The
	// install then reports nothing changed, which is true and useless: the session
	// keeps sending the token the endpoint just refused.
	if !r.Chat.Install(routeOf(route, r.Chat.ModelName(), r.SessionIDValue)) {
		return "", fmt.Errorf("the model client refused the refreshed route (%s)", auth.route)
	}
	return i18n.T("auth.installed", "route", auth.route), nil
}

// authLevel paints a failure as a warning and a plain outcome as information, so an
// ordinary "token refreshed" does not read like a problem.
func authLevel(detail string) string {
	if detail != "" {
		return "warn"
	}
	return "info"
}

// joinAuth folds the two halves of a refresh into one sentence for a person.
func joinAuth(status, detail string) string {
	switch {
	case status == "" && detail == "":
		return ""
	case status == "":
		return fmt.Sprintf("[ericai] %s", detail)
	case detail == "":
		return status
	default:
		return status + "\n" + detail
	}
}
