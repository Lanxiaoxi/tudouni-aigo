package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/memory"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
)

// The runtime's half of workspace memory: when to look, and how what is found
// reaches the model.
//
// Three triggers, and the design names all three. What is worth stating once, here,
// is what they have in common: **all of them end in the same place** — the payload
// tail built by `notes()`. There is one injection path, so "why is this memory in
// front of the model" has exactly one answer, and turning it off is one switch
// rather than three.
//
//   - turn start: recall against the person's own words. This is where a
//     collaboration preference is found, because a preference is triggered by what
//     somebody is doing rather than by an error message.
//   - tool failure: recall against the error text. The design calls this the most
//     valuable trigger, and it is: it lands at the one moment a remembered fix is
//     worth more than anything else on the screen.
//   - the model's own `memory_search` call: no runtime involvement beyond the tool.
//
// Everything here is best-effort by construction. `recall` runs with a recover, every
// error becomes a note on the struct rather than a returned error, and a nil
// `WorkspaceMemory` is the ordinary case in tests. A memory system that could fail a
// turn would be a memory system people disable.

// memoryRecall is one turn's accumulated memories.
//
// It is per runtime rather than per turn object because the turn loop is not
// re-entrant (one turn at a time per session) while `onToolResult` is called from
// parallel tool goroutines, so the mutex is not decoration.
type memoryRecall struct {
	mu sync.Mutex
	// items are in recall order, which is score order within each trigger and
	// trigger order across them.
	items []memory.Result
	seen  map[string]bool
	// problems are sentences the runtime should surface once — a corrupt memory file,
	// an index that could not be written. They go to the notice stream, not to the
	// model.
	problems []string
}

// reset clears the turn's accumulation.
func (m *memoryRecall) reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.items = nil
	m.seen = map[string]bool{}
}

// add merges results, keeping the best `limit` in score order and dropping ids
// already present. It reports what it added so the audit can name the memories.
func (m *memoryRecall) add(results []memory.Result, limit int) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.seen == nil {
		m.seen = map[string]bool{}
	}
	var added []string
	for _, result := range results {
		if result.Entry == nil || m.seen[result.Entry.ID] {
			continue
		}
		m.seen[result.Entry.ID] = true
		m.items = append(m.items, result)
		added = append(added, result.Entry.ID)
	}
	if limit > 0 && len(m.items) > limit {
		m.items = m.items[:limit]
	}
	return added
}

// snapshot returns the current set in score order.
func (m *memoryRecall) snapshot() []memory.Result {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]memory.Result, len(m.items))
	copy(out, m.items)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].Entry.ID < out[j].Entry.ID
	})
	return out
}

func (m *memoryRecall) noteProblem(text string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.problems = append(m.problems, text)
}

// openMemory prepares the workspace memory and queues what went wrong for the
// start-up notices.
func (r *Runtime) openMemory() {
	workspace, err := memory.Open(paths.WorkspaceDir())
	if err != nil {
		// Nowhere to put memory: the directories could not be created. This is worth a
		// warning because it is permanent for this session, and it is the only memory
		// failure that is not self-healing.
		r.notices = append(r.notices, notice("warn", "memory",
			fmt.Sprintf("[memory] workspace memory is unavailable: %v", err)))
		return
	}
	r.WorkspaceMemory = workspace
	if problem := workspace.Problem(); problem != "" {
		r.notices = append(r.notices, notice("warn", "memory", "[memory] "+problem))
	}
	if !workspace.Enabled() {
		r.notices = append(r.notices, notice("info", "memory",
			"[memory] workspace memory is turned off in "+workspace.Root()))
	}
}

// recallForTurn runs the turn-start retrieval.
//
// It is called from `RunTurn` before the agent runs, so the first request of the turn
// already carries what this workspace knows. The query is the person's own message and
// nothing else: the workspace path is already the boundary, and adding it to the query
// would make every memory containing the project's name look relevant.
func (r *Runtime) recallForTurn(text string) {
	if r.WorkspaceMemory == nil {
		return
	}
	r.memory.reset()
	config := r.WorkspaceMemory.Config()
	if !config.Enabled || !config.AutoInject || !config.RecallOnTurnStart {
		return
	}
	if strings.TrimSpace(text) == "" {
		return
	}
	r.recall("turn", memory.Query{Text: text, Limit: config.MaxRecall}, config.MaxRecall)
}

// onToolResult is the second trigger: a tool failed, and this workspace may already
// have seen that failure.
//
// The full result text is what it is given — not the audit's 200-character preview —
// because the distinctive part of an error is often at the end (a nested exception, a
// "caused by" chain) and matching on the first line alone would miss the very cases a
// remembered fix is worth most for.
//
// Two kinds of failure reach this hook:
//
//   - `status == "error"`: the tool handler returned an error. These are usually
//     environment problems or argument issues, but they still carry an error text
//     that might match a remembered fix.
//
//   - `semanticFailure`: the tool ran without error and returned a result, but the
//     outcome is one the model must react to — a shell command that exited non-zero,
//     a build that broke. This is the case the design originally intended: the
//     command "succeeded" as a tool call, the news is bad, and a remembered fix is
//     worth more here than at any other moment. Without this flag the shell tool's
//     non-zero exit codes would all be `status == "ok"` and the trigger would never
//     fire for them.
func (r *Runtime) onToolResult(name, status, result string, semanticFailure bool) {
	if r.WorkspaceMemory == nil || result == "" {
		return
	}
	// `interrupted` is not a failure of the tool and `denied` is a decision of the
	// person; neither is something a memory can help with, and recalling on them would
	// put a note about a Gradle error in front of a model whose command was refused.
	if status != "error" && !semanticFailure {
		return
	}
	// A memory tool that fails must not trigger a memory lookup: the recursion is not
	// infinite (the lookup does not call tools) but the note it would add is noise about
	// the memory system itself.
	switch name {
	case "memory_search", "memory_get", "memory_propose":
		return
	}
	config := r.WorkspaceMemory.Config()
	if !config.Enabled || !config.AutoInject || !config.RecallOnToolFailure {
		return
	}
	// The failing tool's name goes in front of the text: the name is a real cue (a
	// memory triggered on "shell" is about shell failures) and it costs one token.
	r.recall("tool_failure", memory.Query{
		Text:  name + "\n" + result,
		Limit: config.MaxRecall,
	}, config.MaxRecall)
}

// recall runs one retrieval and reports it, without ever returning an error.
func (r *Runtime) recall(trigger string, query memory.Query, limit int) {
	defer func() {
		// A panic in retrieval is a bug in this package, and it must not take the turn
		// with it — the same rule the tool executor follows.
		if recovered := recover(); recovered != nil {
			r.memory.noteProblem(fmt.Sprintf("[memory] retrieval failed: %v", recovered))
		}
	}()

	results, err := r.WorkspaceMemory.Search(query)
	if err != nil {
		r.memory.noteProblem("[memory] " + err.Error())
		return
	}
	if len(results) == 0 {
		return
	}
	added := r.memory.add(results, limit)
	if len(added) == 0 {
		return
	}
	// Recorded as an event so "why did the model know that" is answerable afterwards.
	// It is **not** a notice: this happens on many turns and a line in the transcript
	// every time would be noise. The run id is empty because a turn-start recall runs
	// before the agent has started one — the same shape `goal_round` has.
	r.onEvent(audit.Event(audit.KindMemoryRecall, r.SessionIDValue, "", 0, map[string]any{
		"trigger":  trigger,
		"ids":      added,
		"query":    firstLine(query.Text, 160),
		"returned": len(results),
	}))
}

// memoryNote renders the injected block, or "".
//
// It is rebuilt on every request rather than captured once per turn, because the
// tool-failure trigger adds to the set mid-turn — and it is capped by the config's
// `note_chars` so a verbose corpus cannot quietly become the prompt.
func (r *Runtime) memoryNote() string {
	if r.WorkspaceMemory == nil {
		return ""
	}
	config := r.WorkspaceMemory.Config()
	if !config.Enabled || !config.AutoInject {
		return ""
	}
	items := r.memory.snapshot()
	if len(items) == 0 {
		return ""
	}

	var parts []string
	used := 0
	for _, item := range items {
		entry := item.Entry
		if entry == nil || entry.ExemptFromInjection() {
			continue
		}
		block := memoryEntryBlock(entry, config.EntryChars)
		if block == "" {
			continue
		}
		// Truncation is per block and the budget is checked before appending, so an
		// entry is either present in full (within its own cap) or not at all. A block
		// cut in the middle of a command would be worse than no block.
		if used+len([]rune(block)) > config.NoteChars && used > 0 {
			break
		}
		parts = append(parts, block)
		used += len([]rune(block))
	}
	if len(parts) == 0 {
		return ""
	}

	header := "[工作区记忆] 以下是以前在这个工作区里记下的经验，作为参考，**不是当前事实**：" +
		"与当前代码、配置或验证结果冲突时以当前证据为准；确实过时了可以用 memory_propose 提一条修正。" +
		"需要用全文时调用 memory_get。"
	return header + "\n\n" + strings.Join(parts, "\n\n")
}

// memoryEntryBlock renders one memory for the payload tail.
func memoryEntryBlock(entry *memory.Entry, bodyChars int) string {
	var builder strings.Builder
	fmt.Fprintf(&builder, "### %s · %s（%s）\n", entry.ID, entry.Title, entry.Confidence)
	if len(entry.Triggers) > 0 {
		fmt.Fprintf(&builder, "线索：%s\n", strings.Join(entry.Triggers, " | "))
	}
	if len(entry.Scope.Paths) > 0 {
		fmt.Fprintf(&builder, "适用范围：%s\n", strings.Join(entry.Scope.Paths, ", "))
	}
	body := strings.TrimSpace(entry.Body)
	if bodyChars > 0 {
		runes := []rune(body)
		if len(runes) > bodyChars {
			body = strings.TrimSpace(string(runes[:bodyChars])) + " …（用 memory_get 看全文）"
		}
	}
	if body != "" {
		builder.WriteString(body)
		builder.WriteString("\n")
	}
	return builder.String()
}

// MemoryProblems returns the sentences the memory subsystem collected during this
// turn, and clears them. The caller turns them into notices.
func (r *Runtime) MemoryProblems() []string {
	r.memory.mu.Lock()
	defer r.memory.mu.Unlock()
	out := append([]string(nil), r.memory.problems...)
	r.memory.problems = nil
	return out
}

// --- protocol surface -------------------------------------------------------

// memoryPending is the state snapshot's count of proposals waiting for review.
//
// It rides on **every** `ui(state)` because that is the only snapshot a tool
// result re-states, and `memory_propose` is a tool: without this, a new proposal
// left the front end's badge empty until a person opened the memory panel (the
// moment the front end first asks for `ui(memory)`). The full snapshot stays on
// `ui(memory)`; this is just the figure a badge needs, counted in `O(files)`
// rather than by parsing every proposal.
func (r *Runtime) memoryPending() int {
	if r.WorkspaceMemory == nil {
		return 0
	}
	return r.WorkspaceMemory.PendingCandidates()
}

// MemoryPanel is the `ui(memory)` payload: everything the workspace-memory panel
// draws, in one message.
//
// One snapshot rather than one request per section, for the reason the terminal list
// is one message: a panel that assembles itself from several replies has a window in
// which two sections disagree about what exists.
func (r *Runtime) MemoryPanel() (map[string]any, error) {
	if r.WorkspaceMemory == nil {
		return nil, fmt.Errorf("this runtime has no workspace memory")
	}
	snapshot := r.WorkspaceMemory.Snapshot()

	// Round-tripped through JSON so the wire types are exactly what a JSON reader
	// expects (arrays as arrays, numbers as numbers) rather than whatever Go's
	// encoder happens to do with a typed slice of structs.
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	payload := map[string]any{}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	return payload, nil
}

// MemoryAction is one reviewed change from the panel.
//
// The verbs are the panel's, and every one of them is a **decision by a person** —
// which is why they live here rather than in a tool. A model cannot publish, reject or
// deprecate; only this surface can, and it is only reachable from a front end a person
// is looking at.
func (r *Runtime) MemoryAction(action string, arguments map[string]any) (map[string]any, error) {
	if r.WorkspaceMemory == nil {
		return nil, fmt.Errorf("this runtime has no workspace memory")
	}
	switch action {
	case MemoryActionPublish:
		id, _ := stringValue(arguments, "proposal_id")
		if id == "" {
			return nil, fmt.Errorf("publish needs proposal_id")
		}
		entry, err := r.WorkspaceMemory.Publish(id)
		if err != nil {
			return nil, err
		}
		if entry == nil {
			return nil, nil
		}
		return map[string]any{"entry_id": entry.ID, "revision": entry.Revision}, nil

	case MemoryActionReject:
		id, _ := stringValue(arguments, "proposal_id")
		if id == "" {
			return nil, fmt.Errorf("reject needs proposal_id")
		}
		return nil, r.WorkspaceMemory.Reject(id)

	case MemoryActionDeprecate:
		id, _ := stringValue(arguments, "entry_id")
		if id == "" {
			return nil, fmt.Errorf("deprecate needs entry_id")
		}
		reason, _ := stringValue(arguments, "reason")
		proposalID, err := r.WorkspaceMemory.Deprecate(id, reason)
		if err != nil {
			return nil, err
		}
		return map[string]any{"proposal_id": proposalID}, nil

	case MemoryActionRebuildIndex:
		status := r.WorkspaceMemory.RebuildIndex()
		return map[string]any{"entries": status.Entries, "built_at": status.BuiltAt}, nil

	case MemoryActionConfig:
		raw, ok := arguments["config"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("config needs a config object")
		}
		config, notes := configFromMap(r.WorkspaceMemory.Config(), raw)
		saved, clampNotes, err := r.WorkspaceMemory.SaveConfig(config)
		if err != nil {
			return nil, err
		}
		notes = append(notes, clampNotes...)
		// Re-read so a toggle takes effect for the rest of this session immediately
		// rather than at the next open.
		r.memory.reset()
		return map[string]any{
			"max_recall":  saved.MaxRecall,
			"max_results": saved.MaxResults,
			"notes":       notes,
		}, nil

	default:
		return nil, fmt.Errorf("unknown memory action %q", action)
	}
}

// MemoryAction names, as the wire spells them.
//
// They are aliases rather than literals: the strings are the protocol's vocabulary, and
// two spellings of "publish" in two packages is how a panel button starts returning
// "unknown action" after a rename.
const (
	MemoryActionPublish      = protocol.MemoryPublish
	MemoryActionReject       = protocol.MemoryReject
	MemoryActionDeprecate    = protocol.MemoryDeprecate
	MemoryActionRebuildIndex = protocol.MemoryRebuild
	MemoryActionConfig       = protocol.MemoryConfig
)

// MemoryActions is the accepted vocabulary. It is the protocol's list rather than a
// second copy of it, so the two cannot drift.
var MemoryActions = protocol.MemoryActions

// configFromMap applies the fields a front end sent onto the current config.
//
// A patch rather than a whole struct, so a panel built against an older build — one
// that has never heard of a knob added since — can still save the knobs it does know.
// Unknown keys are ignored rather than refused, for the same reason: a rejected save
// looks exactly like a broken button.
func configFromMap(base memory.Config, raw map[string]any) (memory.Config, []string) {
	out := base
	var notes []string
	boolean := func(name string, target *bool) {
		if value, ok := raw[name].(bool); ok {
			*target = value
			return
		}
		if value, present := raw[name]; present && value != nil {
			notes = append(notes, fmt.Sprintf("%s was not a boolean and was left as it was", name))
		}
	}
	integer := func(name string, target *int) {
		value, ok := intValue(raw, name)
		if !ok {
			return
		}
		*target = value
	}
	number := func(name string, target *float64) {
		switch typed := raw[name].(type) {
		case float64:
			*target = typed
		case int:
			*target = float64(typed)
		}
	}

	boolean("enabled", &out.Enabled)
	boolean("auto_inject", &out.AutoInject)
	boolean("recall_on_turn_start", &out.RecallOnTurnStart)
	boolean("recall_on_tool_failure", &out.RecallOnToolFailure)
	integer("max_recall", &out.MaxRecall)
	integer("max_results", &out.MaxResults)
	integer("entry_chars", &out.EntryChars)
	integer("note_chars", &out.NoteChars)
	number("min_score", &out.MinScore)
	return out, notes
}

// intValue reads an integer field from a decoded JSON object.
func intValue(raw map[string]any, name string) (int, bool) {
	switch typed := raw[name].(type) {
	case float64:
		return int(typed), true
	case int:
		return typed, true
	case int64:
		return int(typed), true
	default:
		return 0, false
	}
}

// stringValue reads a string field.
func stringValue(raw map[string]any, name string) (string, bool) {
	text, ok := raw[name].(string)
	return strings.TrimSpace(text), ok
}

// firstLine flattens and cuts text for an audit field.
func firstLine(text string, limit int) string {
	flat := strings.Join(strings.Fields(text), " ")
	runes := []rune(flat)
	if len(runes) <= limit {
		return flat
	}
	return string(runes[:limit]) + "…"
}

// memorySearch is the tool-facing query the runtime performs for the model.
//
// It exists so `memory_search` and the automatic recall share one entry point — the
// design's rule that the three triggers use the same service rather than three
// implementations of "find something".
func (r *Runtime) memorySearch(ctx context.Context, query memory.Query) ([]memory.Result, error) {
	if r.WorkspaceMemory == nil {
		return nil, fmt.Errorf("this runtime has no workspace memory")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return r.WorkspaceMemory.Search(query)
}
