package subagent

import (
	"fmt"
	"strings"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/agent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/context"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// spawn runs one delegated task to completion and returns the child's answer.
//
// Everything the child needs is built here rather than borrowed from the parent,
// and the reason for each separation is the same: a child that shared anything
// mutable with its parent would make the parent's behaviour depend on how the
// delegation went.
//
// The one thing that *is* inherited on purpose is the stop flag. Pressing Esc is
// a statement about this whole piece of work, and a subagent that kept going
// after the user interrupted would be the feature overriding the user.
func (t *Tool) spawn(task string) (tools.Result, error) {
	started := time.Now()
	childID, err := t.mintChildID()
	if err != nil {
		return tools.Result{}, err
	}

	parentDepth := DepthOf(t.Parent)
	childDepth := parentDepth + 1

	parentModel, parentProvider := "", ""
	if t.Chat != nil {
		parentModel, parentProvider = t.Chat.ModelName(), t.Chat.ProviderName()
	}

	resolved, err := t.resolveChild(parentModel, parentProvider)
	if err != nil {
		return tools.TextResult(fmt.Sprintf("委派失败：%v。请把这一步自己做完，或在最终答复里说明为什么需要子 agent。", err)), nil
	}
	chosen, route, chat := resolved.Model, resolved.Provider, resolved.Chat
	t.warn(fmt.Sprintf("subagent %s: running with %s/%s", childID, route.Name, chosen))

	session := t.newChildSession(childID, childDepth)
	// The resolved route is written into the child's own session record rather
	// than left implicit. A child session that does not say which model produced
	// it is a transcript somebody will later misattribute, and the resolution may
	// have picked a route the configuration did not name explicitly.
	state.StoreSelection(session.Metadata, state.Selection{
		Provider: route.Name,
		Model:    chosen,
		Thinking: t.Thinking,
		Effort:   t.Effort,
	}, 0)

	// Announced before the child runs rather than after, because the whole point
	// is that the screen can say something while the work is happening. A board
	// updated on completion would only ever show delegations that are already
	// over.
	if t.Board != nil {
		t.Board.Start(Delegation{
			ID:       childID,
			Label:    t.labelText(),
			Model:    chosen,
			Provider: route.Name,
			Depth:    childDepth,
		})
	}

	manager, calls := t.childContext(session, chat)
	// The Session points at the ledger's live state before anything is written
	// down, the same way the parent's Run does it. The manager's OnChange callback
	// also keeps this current, so this line is not what makes the ledger reach the
	// file — it is what removes a window where a checkpoint writes a child session
	// carrying no ledger at all, during which the artifact references already in
	// the message list would name nothing.
	session.Context = manager.State
	childTools := t.toolsForChild()

	sub := agent.New(agent.Config{
		Chat:   chat,
		Tools:  childTools,
		Policy: t.Policy,
		// No asker, deliberately. security.Check turns a missing asker into a
		// refusal, so this is fail-closed: an operation the child is not allowed
		// to perform on its own authority comes back as a denied tool result
		// instead of a question aimed at a user who is watching a different task.
		Ask:    nil,
		Memory: t.Memory,
		// **Autopilot stays off, and that is the whole permission model in one
		// line.** In this program autopilot means "nobody is watching, so let it
		// run" — the gate returns an empty denial for every call. A delegated
		// agent has no such authority: it was handed one task, not the session's
		// permission to spend. With no asker and no autopilot the gate refuses
		// everything that would have needed approval, which is the fail-closed
		// answer the scope declaration promises the child.
		//
		// The consequence is deliberate and worth stating: **the set of things a
		// subagent may do on its own is exactly the set that needs no approval.**
		// That is the tools the policy already auto-approves, minus what the user
		// granted by hand — a hand-granted rule does carry here, because Memory is
		// shared and the user's stated intent outlives one task.
		Autopilot: false,
		Session:   session,
		Model:     state.NewSessionModel(session.Metadata, chosen, route.Name),
		MaxSteps:  t.MaxSteps,
		Debug:     t.Debug,
		Clock:     t.Clock,
		// The parent's flag, not the child's own: an interrupt is about the turn.
		ShouldStop: t.ShouldStop,
		// Never the parent's delta sink. One sink belongs to the interface, and
		// two agents writing into it would interleave two answers into one.
		OnDelta:      nil,
		OnCheckpoint: func() { t.checkpointChild(session) },
		OnEvent:      t.childSink(childID),
		Notes:        t.childNotes,
		Context:      manager,
		Processor:    calls,
	})

	t.emit(audit.Event(KindDelegationStarted, t.parentID(), childID, 0, map[string]any{
		"subagent_id":  childID,
		"depth":        childDepth,
		"max_depth":    t.MaxDepth,
		"model":        chosen,
		"provider":     route.Name,
		"prompt_chars": len([]rune(task)),
	}))

	answer, runErr := sub.Run(task)

	// The child is written down before the outcome is decided, so a session that
	// ended in a step limit or a model error is still there to be read.
	t.checkpointChild(session)
	usage := t.childUsage(childID)

	if t.Board != nil {
		t.Board.Finish(childID)
	}

	t.emit(audit.Event(KindDelegationFinished, t.parentID(), childID, 0, map[string]any{
		"subagent_id":  childID,
		"depth":        childDepth,
		"duration_ms":  int(time.Since(started).Milliseconds()),
		"stop_reason":  stopReasonOf(runErr, answer),
		"answer_chars": len([]rune(answer)),
		"steps":        session.StepCount(),
		"messages":     len(session.Messages),
		"usage":        usage,
	}))

	return tools.Result{
		Text: renderResult(t, childID, answer, runErr, usage),
		// The child's id rides out on the tool result, which is how the parent's
		// own `tool_result` event comes to name the delegation it belongs to. That
		// is the whole correlation an interface needs: the parent's `tool_call`
		// carries the call id, the matching `tool_result` carries the child id, and
		// the two are already adjacent in the stream. Nothing had to be threaded
		// through the agent to make it work.
		Audit: map[string]any{"subagent_id": childID},
	}, nil
}

// newChildSession builds the child's session: empty apart from the scope
// declaration, and never carrying any of the parent's messages.
//
// That emptiness is the feature. A child that started from the parent's history
// would be paying for the same tokens twice — once in the parent, once in the
// child — which is the opposite of what delegation is for.
func (t *Tool) newChildSession(childID string, depth int) *state.Session {
	session := state.NewSession(childID, paths.WorkspaceDir())
	// `labelText`, not `Config.Label`: the model's own description of this task is
	// the per-call one, and reading the static config here would write an empty
	// label for every delegation that supplied a `description` — which is the
	// common case, and the one where the label is the only human-readable clue in
	// the child's file about what it was asked.
	for key, value := range ChildMetadata(t.Parent, depth, t.labelText()) {
		session.Metadata[key] = value
	}
	// The scope declaration goes in before the task, because it is a property of
	// this agent rather than a note about this task. A child that discovers the
	// limit by hitting it wastes the whole delegation working around a wall it was
	// never told about, and reports "I could not" where the truth is "I was not
	// allowed to".
	session.Append(delegationScopeMessage())
	return session
}

// childContext opens the child's own artifact store and ledger.
//
// The directory is keyed by the child's session id, so the two agents never see
// each other's artifacts. That separation is where the saving comes from: a
// `read_file` of a large file lands in the child's store and is degraded and
// evicted there, while the parent's context only ever holds the child's answer.
func (t *Tool) childContext(session *state.Session, chat model.ChatModel) (*context.Manager, *context.ToolResultProcessor) {
	store := context.OpenArtifactStore(paths.SessionArtifactsDir(session.SessionID), nil)
	store.Load()

	var window *int
	if ref, ok := t.Catalog.Find(chat.ModelName(), chat.ProviderName()); ok && ref.Window != nil {
		value := *ref.Window
		window = &value
	}

	manager := context.NewManager(store, nil, context.NewBudget(window), func(current *context.ContextState) {
		// The checkpoint reads the Session, so the Session has to point at the
		// live state. Same arrangement as the parent's, and for the same reason:
		// a process killed mid-delegation still recovers to what really happened.
		session.Context = current
	})

	return manager, context.DefaultProcessor()
}

// childUsage sums the child's own token accounting out of its audit log.
//
// It is read back from the log rather than accumulated in memory because the log
// is already the authoritative record of what the child cost, and a second
// counter would be a second answer to the same question. No log means no line at
// all in the result rather than a line of zeroes: "cost nothing" and "was not
// measured" are different claims, and the first one would be a lie.
func (t *Tool) childUsage(childID string) map[string]any {
	if t.Logs == nil {
		return nil
	}
	events, err := t.Logs.Read(childID)
	if err != nil || len(events) == 0 {
		return nil
	}
	summary := state.Summarize(events)
	usage, _ := summary["usage"].(map[string]any)
	counters, _ := summary["counters"].(map[string]any)
	if usage == nil {
		return nil
	}
	out := map[string]any{
		"prompt":     usage["prompt"],
		"cached":     usage["cached"],
		"completion": usage["completion"],
	}
	if counters != nil {
		out["model_calls"] = counters["model_calls"]
		out["tool_calls"] = counters["tool_calls"]
	}
	return out
}

// toolsForChild is the parent's tool set minus the ability to delegate again.
//
// The subtraction is by name and only reaches the tool this instance owns, so a
// second delegation tool mounted with another name stays available — that is a
// deliberate arrangement by whoever configured it, not recursion this package
// should silently forbid.
func (t *Tool) toolsForChild() *tools.Registry {
	if t.Tools == nil {
		return tools.NewRegistry()
	}
	return t.Tools.Clone(t.Name)
}

// resolveChild picks the route the child runs on.
//
// The default is the parent's model and route, which is what makes a delegation
// predictable: the same question asked of the same session costs the same
// whichever agent answers it. A resolver may override that, and when it does the
// child's session records the resolved route rather than the requested one — a
// session that names a route it did not use is worse than no record at all.
func (t *Tool) resolveChild(parentModel, parentProvider string) (ChildChat, error) {
	if t.Resolver == nil {
		return ChildChat{}, fmt.Errorf("没有配置子 agent 的路由解析器")
	}
	resolved, err := t.Resolver.ResolveChild(Route{
		Model:    t.ChildModel,
		Provider: t.ChildProvider,
		Effort:   t.ChildEffort,
	}, parentModel, parentProvider)
	if err != nil {
		return ChildChat{}, err
	}
	if strings.TrimSpace(resolved.Model) == "" || resolved.Chat == nil {
		return ChildChat{}, fmt.Errorf("路由解析器没有给出可用的模型")
	}
	return resolved, nil
}

// mintChildID finds a session id for the child that nothing has taken yet.
//
// The counter is per process, and the existence check is what makes it correct
// across restarts: ids restart at 1 for a new process, and a resumed parent
// delegating for the first time would otherwise overwrite a child session from
// the previous run — the child would open on somebody else's history, and its
// append-only file would be extended with an unrelated conversation.
func (t *Tool) mintChildID() (string, error) {
	for seq := 1; seq <= 1000; seq++ {
		candidate := ChildID(t.parentID(), seq)
		if t.Store == nil || !t.Store.Exists(candidate) {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("子会话 id 用尽（同一父会话下已有 1000 个子 agent）")
}

// parentID is the delegating session's id, or an empty string when the tool was
// built without one.
func (t *Tool) parentID() string {
	if t.Parent == nil {
		return ""
	}
	return t.Parent.SessionID
}

// checkpointChild writes the child's session down, swallowing the failure.
//
// It cannot return an error to anybody useful: the caller is a tool handler in
// the middle of the parent's turn, and a child whose session could not be saved
// is a diagnostic, not a reason to fail the delegation. The child's answer still
// reaches the parent, which is what the parent asked for.
func (t *Tool) checkpointChild(session *state.Session) {
	if t.Store == nil {
		return
	}
	if err := t.Store.Save(session); err != nil {
		t.warn(fmt.Sprintf("subagent %s: could not save the child session: %v", session.SessionID, err))
	}
}

// childSink routes the child's audit records.
//
// Three things happen to each record, and each has exactly one owner:
//
//   - the **board** folds it into the running row, which is what makes the badge
//     say "reading config.go" instead of just "busy";
//   - the **parent's hook** gets it with its origin marked, so a front end can
//     tell a child's step from the parent's. It reaches the audit log through
//     there — this function deliberately does **not** write to the sink itself,
//     because the runtime's own `onEvent` already writes every record it is
//     handed. Writing here as well put two identical lines in the log for every
//     child event, which would make every count taken from the log wrong by a
//     factor that depends on the nesting depth.
//
// The marker is `ChildOriginKey` rather than the child's id, and the difference is
// load-bearing: the parent's own `tool_result` for a subagent call *also* carries
// that id, so that an interface can connect the two. A front end told to skip
// every record mentioning a subagent would skip the delegation's answer — the one
// place it is shown.
func (t *Tool) childSink(childID string) func(map[string]any) {
	return func(record map[string]any) {
		// A copy: the parent's hook may keep the record, and the board reads it
		// too. Handing the same map to three readers and letting one mutate it
		// would mean the three disagreed about what happened.
		forwarded := make(map[string]any, len(record)+2)
		for key, value := range record {
			forwarded[key] = value
		}
		forwarded[ChildOriginKey] = true
		forwarded["subagent_id"] = childID

		t.Board.Observe(forwarded)
		if t.OnEvent != nil {
			t.OnEvent(forwarded)
		}
	}
}

// childNotes is the payload tail the child gets.
//
// The caller decides what to inject, and the runtime injects only the loaded-skill
// bodies. Three parts of the parent's tail are deliberately not offered here:
//
//   - **the task list.** A todo list is the parent's stated plan, and the child
//     has its own task. Showing it the parent's list invites it to mark steps done
//     that it never ran, which corrupts the one artefact the parent maintains for
//     itself.
//   - **the skill catalogue.** It says "you may load these", and a child's job is
//     one focused piece of work; spending a step choosing a skill is the parent's
//     decision, already made before it delegated.
//   - **the subagent warning.** This agent cannot delegate.
func (t *Tool) childNotes() string {
	if t.Notes == nil {
		return ""
	}
	return t.Notes()
}

// emit reports an event on the parent's hook.
func (t *Tool) emit(record map[string]any) {
	if t.OnEvent == nil {
		return
	}
	// Swallowed, like every other audit path in this program: observation must
	// never be able to damage what it observes, and this runs while the parent's
	// message list is half-built.
	defer func() { _ = recover() }()
	t.OnEvent(record)
}

// warn reports a diagnostic about the child to the parent's stderr sink.
func (t *Tool) warn(text string) {
	if t.Warn != nil {
		t.Warn(text)
	}
}

// stopReasonOf names how the delegation ended, in the vocabulary the parent reads.
func stopReasonOf(runErr error, answer string) string {
	if runErr != nil {
		switch runErr.(type) {
		case *agent.StepLimitExceeded:
			// Separated from a plain failure on purpose: the work may well be
			// salvageable, and "ran out of steps" tells the parent to delegate
			// something smaller rather than to give up on the task.
			return "max_steps"
		case agent.RunCancelled:
			return "cancelled"
		}
		if model.IsFatal(runErr) {
			return "model_fatal"
		}
		return "error"
	}
	if strings.TrimSpace(answer) == "" {
		return "no_output"
	}
	return "answered"
}
