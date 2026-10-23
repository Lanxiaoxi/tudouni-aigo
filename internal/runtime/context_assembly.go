package runtime

import (
	ctxwin "github.com/Lanxiaoxi/tudouni-aigo/internal/context"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// openContext assembles the context system for one session.
//
// Three things happen here that are individually easy to get wrong:
//
//  1. the artifact store is rooted at **this session's** directory, so two
//     sessions in one workspace cannot reach each other's bodies;
//  2. saved context state is restored, and a session written before this layer
//     existed has its inline tool bodies turned into artifacts — without that,
//     an old session's tool results stay inline forever and the first degradation
//     has nothing to act on;
//  3. artifacts whose bodies are gone are **reported**, not swallowed: "the
//     session opened but some content is unavailable" is something the person has
//     to know, because the alternative is a model silently working from a
//     reference it can never fetch.
//
// The budget comes from the model's declared window. A model that declares none
// gets the budget switched off rather than a guess: an invented ceiling degrades
// a context that would have fit, and then "why can the model not see the whole
// file" has no answer anywhere.
func openContext(session *state.Session, chat model.ChatModel, catalog state.Registry) (*ctxwin.Manager, *ctxwin.ToolResultProcessor, []string, error) {
	store := ctxwin.OpenArtifactStore(paths.SessionArtifactsDir(session.SessionID), nil)
	missing := store.Load()

	var restored *ctxwin.ContextState
	if saved := session.ContextHandle(); saved != nil {
		decoded, err := ctxwin.ContextStateFromJSON(saved)
		if err != nil {
			// A context record this version cannot read is reported and dropped.
			// The artifacts are still on disk and the messages are still in
			// history, so the session opens with a fresh ledger rather than
			// refusing to open at all.
			warn("could not read the saved context state: %v", err)
		} else {
			restored = decoded
		}
	}

	window := windowFor(chat.ModelName(), chat.ProviderName(), catalog)

	manager := ctxwin.NewManager(store, restored, ctxwin.NewBudget(window),
		func(current *ctxwin.ContextState) {
			// The checkpoint reads the Session, so the Session has to point at the
			// live state. Doing this on every change rather than at the end of the
			// turn is what makes a killed process recover to where it really was.
			session.SetContext(current)
		})

	// Legacy sessions: tool bodies are sitting in history as text. Hydrate
	// collects them into the store and gives each a full-level item — which is
	// what happened before, made explicit so it can be degraded later.
	if _, err := manager.Hydrate(session.MessagesSnapshot(), ctxwin.ZoneDynamic, 0); err != nil {
		return nil, nil, missing, err
	}

	return manager, ctxwin.DefaultProcessor(), missing, nil
}

// contextHandle is the serialisable half of the context ledger. The artifact bodies
// are on disk; only references travel.
//
// It returns the live state object rather than a copy: the state is the manager's
// working memory and the checkpoint is a read of it. Copying here would mean two
// objects claiming to be "the context", and the one written to disk would stop
// tracking the one being degraded.
func (r *Runtime) contextHandle() any {
	if r.ContextValue == nil {
		return nil
	}
	return r.ContextValue.State
}

// Context is the session's context ledger, or nil when the layer is off.
func (r *Runtime) Context() *ctxwin.Manager { return r.ContextValue }

// ContextMessage implements protocol.Runtime.
//
// The nesting is deliberate and matches what the interface reads: the outer
// object is "the context feature", the inner one is "the ledger". An empty outer
// object has to make a front end print "there is no context management here"
// rather than a row of zeroes — a row of zeroes reads as "enabled, and it did
// nothing", which is a different and false statement.
//
// Three numbers travel together on purpose: used, limit and the compaction
// line. Reported alone, "151k" is neither big nor small. The third one is what
// answers "when does it compact by itself".
func (r *Runtime) ContextMessage() map[string]any {
	if r.ContextValue == nil {
		return map[string]any{}
	}
	return map[string]any{"context": r.contextPayload()}
}

// contextLedger is the context layer's own numbers, or nil when there is none.
//
// Nil rather than an empty object: an empty object makes a front end print a row
// of zeroes, which reads as "the context system is on and did nothing". "There is
// no context management here" is a different and true statement.
func (r *Runtime) contextLedger() any {
	if r.ContextValue == nil {
		return nil
	}
	return r.ContextValue.Stats()
}

func (r *Runtime) contextPayload() map[string]any {
	if r.ContextValue == nil {
		return nil
	}
	// Measure before reporting. The estimate is normally left behind by a
	// request, so `/context` on a session that has not sent one yet would show
	// zero tokens — and a ledger that reads zero on its own first screen teaches
	// the reader to distrust it. The cost is one linear scan, the same order as
	// the estimate the request path already computes every step.
	if r.Agent != nil {
		r.Agent.RefreshEstimate()
	}
	payload := map[string]any{
		"context": r.ContextValue.Stats(),
		"window":  r.modelWindow(),
	}
	if r.SessionValue != nil {
		payload["messages"] = r.SessionValue.MessageCount()
		if state, ok := ctxwin.LoadCompaction(r.metaSnapshot()); ok {
			payload["active"] = state.Active()
			payload["folded"] = state.FoldedMessages
			payload["generation"] = state.Generation
			payload["summary_id"] = state.SummaryID
			if artifact, present := r.ContextValue.Store.Get(state.SummaryID); present {
				payload["summary_chars"] = artifact.Chars
			}
		} else {
			payload["active"] = false
			payload["folded"] = 0
		}
	}
	return payload
}
