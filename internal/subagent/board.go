package subagent

import (
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Board is the runtime's tally of delegations that are in flight.
//
// It exists because a subagent is invisible otherwise. The child's own audit
// records go to its own log under its own session id, which is right for reading
// a transcript afterwards but means nothing announces "a subagent is running" to
// the thing that draws the screen. The board is that announcement in declarative
// form: a list of what is running right now, recomputed on every state snapshot
// rather than accumulated by a front end from the event stream.
//
// The declarative shape is the point. A front end that counted `delegation_started`
// and `delegation_finished` events would be a second implementation of the same
// bookkeeping, and the two would disagree the first time one was missed — at
// which point the badge shows a subagent that finished ten minutes ago, which is
// worse than showing nothing.
type Board struct {
	mu      sync.Mutex
	running map[string]*Delegation
	clock   func() float64
}

// Delegation is one delegation as the interfaces report it.
type Delegation struct {
	// ID is the child's session id. It is the same string the parent's audit log
	// and the child's own file are keyed by, so a reader can go from the badge on
	// screen to the child's whole transcript.
	ID string
	// Label is the short description the delegating model supplied.
	Label string
	// Model and Provider are the route the child actually resolved to, not the one
	// that was requested — those differ whenever a delegation inherits a route.
	Model    string
	Provider string
	// Depth is the child's own depth: 1 for a child of the top-level agent.
	Depth int
	// Started is when the delegation began, on the injected clock.
	Started float64
	// Steps and ToolCalls are what the child has done so far, which is the
	// difference between "working" and "stuck".
	Steps     int
	ToolCalls int
	// Activity is the child's own last reported action, in the runtime's words.
	Activity string
}

// Duration is how long the delegation has been running, in seconds.
func (d Delegation) Duration(now float64) float64 {
	if now < d.Started {
		return 0
	}
	return now - d.Started
}

// NewBoard creates a board. A nil clock falls back to wall time; the runtime
// passes the same injected clock everything else uses, so a duration on screen
// and a duration in the audit are the same measurement.
func NewBoard(clock func() float64) *Board {
	if clock == nil {
		clock = func() float64 { return 0 }
	}
	return &Board{running: map[string]*Delegation{}, clock: clock}
}

// Start records a delegation that has begun.
func (b *Board) Start(d Delegation) {
	if b == nil {
		return
	}
	if d.Started == 0 {
		d.Started = b.clock()
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	entry := d
	b.running[d.ID] = &entry
}

// Finish records that a delegation is over, whatever its outcome.
//
// The row is **removed** rather than kept and marked done. Every other panel in
// this program keeps finished work visible because somebody still has to collect
// it; a delegation has nobody to collect it — its whole answer went back to the
// parent as a tool result, which is already in the transcript. A row that stayed
// would be a second, worse copy of something the transcript says better.
func (b *Board) Finish(id string) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.running, id)
}

// Progress records what one child is doing, so the badge can say more than "busy".
func (b *Board) Progress(id string, update func(*Delegation)) {
	if b == nil || update == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if entry, ok := b.running[id]; ok {
		update(entry)
	}
}

// Observe folds one of a child's own audit records into its row.
//
// The child's records already travel through the runtime's event path — they are
// what `--audit <child id>` reads — so the board reads the same stream instead of
// asking the child to report itself. A second reporting channel would be a second
// answer to "what is it doing", and the two would disagree.
//
// The record's `session_id` is the child's id, which is also the board's key. It
// is read rather than passed because this runs on the same path as every other
// audit record and the caller does not unpack them.
func (b *Board) Observe(record map[string]any) {
	if b == nil {
		return
	}
	id, _ := record["subagent_id"].(string)
	if id == "" {
		return
	}
	kind, _ := record["kind"].(string)
	b.mu.Lock()
	defer b.mu.Unlock()
	entry, ok := b.running[id]
	if !ok {
		// A record for a delegation this board never saw start — a restored
		// session replaying its log, say. Dropping it is right: inventing a row
		// from a fragment would show a subagent whose start time is a guess.
		return
	}
	switch kind {
	case "model_call":
		// A model round trip is a step of the child's own loop. Counting them is
		// what turns "running for 40 seconds" into "40 seconds and 9 steps", and
		// the second number is the one that says whether it is working or stuck.
		if status, _ := record["status"].(string); status == "ok" {
			entry.Steps++
		}
	case "tool_call":
		entry.ToolCalls++
		if tool, _ := record["tool"].(string); tool != "" {
			entry.Activity = tool
		} else {
			entry.Activity = ""
		}
	case "tool_result":
		// The activity is cleared rather than left standing: a tool name that
		// stays on screen after the call returned reads as "still doing that",
		// which is exactly the wrong answer while the child thinks about what to
		// do next.
		entry.Activity = ""
	}
}

// Count is how many delegations are in flight.
func (b *Board) Count() int {
	if b == nil {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.running)
}

// Panel renders the running delegations for a front end.
//
// Sorted by start time so two snapshots of the same state describe the rows in
// the same order: a list that reordered itself between two draws would make the
// screen flicker for no reason a reader could name.
func (b *Board) Panel() []map[string]any {
	if b == nil {
		return nil
	}
	now := b.clock()
	b.mu.Lock()
	entries := make([]Delegation, 0, len(b.running))
	for _, entry := range b.running {
		entries = append(entries, *entry)
	}
	b.mu.Unlock()

	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Started < entries[j].Started })

	rows := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		rows = append(rows, map[string]any{
			"id":         entry.ID,
			"label":      entry.Label,
			"model":      entry.Model,
			"provider":   entry.Provider,
			"depth":      entry.Depth,
			"seconds":    int(entry.Duration(now)),
			"steps":      entry.Steps,
			"tool_calls": entry.ToolCalls,
			"activity":   entry.Activity,
		})
	}
	return rows
}

// Note is the payload-tail block that tells the model a delegation is in flight.
//
// It rides in `Notes` rather than in the history because of where a delegation
// happens: the parent's model is **blocked** inside the subagent tool call for
// the whole time, so it cannot act on this note and will not read it. What the
// note is for is the other direction — a child that is interrupted, or a session
// restored while one was running, leaves the parent's next request with no
// evidence of the work that was already paid for, and this is that evidence.
//
// It is worded as a fact rather than an instruction, because for a live
// delegation there is no instruction the parent could follow.
func (b *Board) Note() string {
	rows := b.Panel()
	if len(rows) == 0 {
		return ""
	}
	parts := make([]string, 0, len(rows))
	for _, row := range rows {
		id, _ := row["id"].(string)
		label, _ := row["label"].(string)
		seconds, _ := row["seconds"].(int)
		entry := id
		if label != "" {
			entry += "（" + label + "）"
		}
		entry += "，已跑 " + strconv.Itoa(seconds) + " 秒"
		parts = append(parts, entry)
	}
	return "## 子 agent\n" +
		strings.Join(parts, "；") + "。\n" +
		"它的完整过程在它自己的会话文件里（用上面的 id 可以查），不要凭猜测替它下结论。"
}
