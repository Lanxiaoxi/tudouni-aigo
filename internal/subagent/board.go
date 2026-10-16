package subagent

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Board is the runtime's tally of delegations.
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
//
// A background delegation (see ToolArgs.Background) ends in a state the
// foreground path never had: finished, with its answer in hand, but
// **uncollected** — the parent's turn has moved on and the answer is still
// sitting in memory. Those rows move to the done table, listed by DonePanel and
// named by Note, until Collect removes them. A process restart loses them; the
// child's own session file is the durable copy, which is what Note already
// points at.
type Board struct {
	mu      sync.Mutex
	running map[string]*Delegation
	done    map[string]*Settlement
	clock   func() float64
}

// Settlement is a finished background delegation waiting to be collected.
type Settlement struct {
	// Text is the rendered result the parent would have read as the tool result
	// of a foreground delegation: the same header, the child's answer and the
	// usage line. Rendering at settle time rather than collect time freezes the
	// wording together with the facts it describes.
	Text string
	// StopReason is the parent-readable ending: answered / max_steps / cancelled
	// / model_fatal / error / no_output. The foreground result renders it inline;
	// here it is a field so a front end can colour the row.
	StopReason string
	// Usage is the child's token accounting, as childUsage built it.
	Usage map[string]any
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
	// Background marks a delegation that outlives the turn that started it. It is
	// display-only: the runtime's own bookkeeping distinguishes the two by where
	// the result goes, not by this flag.
	Background bool
	// Ended is when the delegation finished, on the same clock. Zero while
	// running; set by Settle. It is display-only for the done panel.
	Ended float64
}

// Duration is how long the delegation has been running, in seconds.
func (d Delegation) Duration(now float64) float64 {
	if now < d.Started {
		return 0
	}
	return now - d.Started
}

// Elapsed is how long the delegation ran: the total once it has finished, and the
// time so far while it is still going.
//
// `Duration` alone is not that, and the difference is visible. A settled background
// delegation stays in the running table until it is collected, so a panel built
// from `Duration(now)` kept a timer climbing on a child that had already stopped —
// beside the frozen total the done panel reports for the very same row.
func (d Delegation) Elapsed(now float64) float64 {
	if d.Ended != 0 {
		return d.Ended - d.Started
	}
	return d.Duration(now)
}

// NewBoard creates a board. A nil clock falls back to wall time; the runtime
// passes the same injected clock everything else uses, so a duration on screen
// and a duration in the audit are the same measurement.
func NewBoard(clock func() float64) *Board {
	if clock == nil {
		clock = func() float64 { return 0 }
	}
	return &Board{running: map[string]*Delegation{}, done: map[string]*Settlement{}, clock: clock}
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

// Finish records that a foreground delegation is over, whatever its outcome.
//
// The row is **removed** rather than kept and marked done. Every other panel in
// this program keeps finished work visible because somebody still has to collect
// it; a foreground delegation has nobody to collect it — its whole answer went
// back to the parent as a tool result, which is already in the transcript. A row
// that stayed would be a second, worse copy of something the transcript says
// better.
//
// A **background** delegation is the exception, and it does not come through
// here: its result has nowhere to go yet, so Settle keeps the answer for the
// collect tool to hand over and remove.
func (b *Board) Finish(id string) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.running, id)
}

// Settle records that a background delegation is over and keeps its answer.
//
// The row stays in the running table until Collect hands the answer over and
// removes both, and the settlement goes into the done table, where Collect and
// DonePanel find it. A front end's snapshot is consistent either way — `Ended`
// marks the row finished while it waits. An id this board never saw start is
// dropped, for the same reason Observe drops unknown records — inventing a row
// from a fragment would show a subagent whose start time is a guess.
func (b *Board) Settle(id string, settlement Settlement, ended float64) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	entry, ok := b.running[id]
	if !ok {
		return
	}
	if ended == 0 {
		ended = b.clock()
	}
	entry.Ended = ended
	b.done[id] = &settlement
}

// Collect hands over a finished background delegation's result and forgets it.
//
// **The row goes with the settlement.** Every reader of `b.running` treats it as
// "work in flight": `Panel` draws a row per entry, `BackgroundRunning` counts the
// `Background` ones, and `DonePanel` answers `running` for an entry whose
// settlement is missing. So a row left behind here would keep a finished
// delegation on the badge with a timer that never stops, flip its done-panel row
// back from `uncollected` to `running`, and — the expensive one — hold a slot in
// the background cap for the rest of the session, because that cap is
// `BackgroundRunning() >= max`: collect three delegations and `background: true`
// is refused forever with nothing running.
//
// The bool distinguishes the two cases a collect tool must not confuse: "not
// there" (unknown id, or already collected) and a real result. "Still running"
// never reaches this method — the caller checks the running table first, because
// the difference in wording ("wait for it" vs "nothing by that id") matters to
// the model reading the answer.
func (b *Board) Collect(id string) (Settlement, bool) {
	if b == nil {
		return Settlement{}, false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	settlement, ok := b.done[id]
	if !ok {
		return Settlement{}, false
	}
	delete(b.done, id)
	delete(b.running, id)
	return *settlement, true
}

// Uncollected is how many finished background delegations nobody has read yet.
//
// This is the number the payload tail needs: a settled delegation is paid-for
// work whose answer exists only in memory until the parent reads it, so it is
// the one state that has to nag.
func (b *Board) Uncollected() int {
	if b == nil {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.done)
}

// BackgroundRunning is how many background delegations are in flight.
//
// It is the cap counter: each live background delegation is a whole agent loop
// burning tokens with nobody watching it, so the width of a fan-out is bounded
// independently of the depth bound (which limits nesting, not width).
func (b *Board) BackgroundRunning() int {
	if b == nil {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	count := 0
	for _, entry := range b.running {
		if entry.Background {
			count++
		}
	}
	return count
}

// IsRunning reports whether the id names a delegation still doing work.
//
// A settled background row is **not** running — it is finished and waiting to
// be collected, which is a different answer with a different next move. The
// settled check is part of this predicate for exactly that reason: the collect
// tool reads it to distinguish "not yet" (running) from "ready" (settled), and
// a row that counted as both would always answer the first one.
func (b *Board) IsRunning(id string) bool {
	if b == nil {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, settled := b.done[id]; settled {
		return false
	}
	entry, ok := b.running[id]
	if !ok {
		return false
	}
	// A settled row is finished whether or not it is still in the table: Settle
	// marks `Ended` and Collect takes the row and the settlement away together,
	// so `Ended != 0` can only ever mean "over".
	return entry.Ended == 0
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

// Snapshot renders one running delegation as a one-line progress report, for
// the collect tool's "still running" answer. The seconds and the steps are the
// difference between "working" and "stuck"; the activity is what it is doing
// right now, and it is empty while the child is between calls.
//
// It renders in the board rather than in the caller because the numbers come
// from the injected clock, which the caller does not hold.
func (b *Board) Snapshot(id string) string {
	if b == nil {
		return ""
	}
	now := b.clock()
	b.mu.Lock()
	defer b.mu.Unlock()
	entry, ok := b.running[id]
	if !ok {
		return ""
	}
	// English, because this line is not only the model's "still running" answer: it
	// is the first 200 characters of a tool result, so a person reads it in the
	// desktop client's OUTPUT row. See `renderResult` for the same rule.
	line := "subagent " + id
	if entry.Label != "" {
		line += " (" + entry.Label + ")"
	}
	line += fmt.Sprintf(", running %ds, %d steps, %d tool calls",
		int(entry.Elapsed(now)), entry.Steps, entry.ToolCalls)
	if entry.Activity != "" {
		line += ", currently " + entry.Activity
	}
	return line
}

// Observe folds one of a child's own audit records into its row.
//
// The child's records already travel through the runtime's event path — they are
// what `--audit <child id>` reads — so the board reads the same stream instead of
// asking the child to report itself. A second reporting channel would be a second
// answer to "what is it doing", and the two would disagree.
//
// The record's `subagent_id` is the child's id, which is also the board's key. It
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

// Count is how many delegations are in flight, both kinds.
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
//
// Background delegations are ordinary rows here — a subagent running while no
// turn is active is exactly what the badge is for.
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
			"seconds":    int(entry.Elapsed(now)),
			"steps":      entry.Steps,
			"tool_calls": entry.ToolCalls,
			"activity":   entry.Activity,
			"background": entry.Background,
		})
	}
	return rows
}

// DonePanel renders the finished background delegations for a front end.
//
// A background delegation that is still running appears here too, as `running` —
// so a front end that draws the done panel shows one delegation in exactly one
// place. Newer first, because the row a person wants to act on is the one that
// just finished; the running panel is oldest first for order stability.
//
// Collected rows are gone by the time this is read (Collect deletes them), so
// `state` is only ever `running` or `uncollected` — the two answers to "does
// somebody still have to act".
func (b *Board) DonePanel() []map[string]any {
	if b == nil {
		return nil
	}
	now := b.clock()
	b.mu.Lock()
	// One lock over the whole read: the rows mix the running and done tables,
	// and two snapshots taken under separate locks could disagree with each
	// other — a row settled between them would show as running with a finished
	// duration.
	type rowPair struct {
		entry      Delegation
		settlement *Settlement
	}
	pairs := make([]rowPair, 0, len(b.running))
	for _, entry := range b.running {
		if !entry.Background {
			continue
		}
		pairs = append(pairs, rowPair{entry: *entry, settlement: b.done[entry.ID]})
	}
	b.mu.Unlock()

	sort.SliceStable(pairs, func(i, j int) bool { return pairs[i].entry.Started > pairs[j].entry.Started })

	rows := make([]map[string]any, 0, len(pairs))
	for _, pair := range pairs {
		entry, settlement := pair.entry, pair.settlement
		state := "running"
		// `Elapsed`, not `Duration`: a settled row's run is over, so its seconds
		// must not go on climbing (see `Delegation.Elapsed`).
		elapsed := entry.Elapsed(now)
		stopReason := ""
		if settlement != nil {
			state = "uncollected"
			stopReason = settlement.StopReason
		}
		rows = append(rows, map[string]any{
			"id":          entry.ID,
			"label":       entry.Label,
			"model":       entry.Model,
			"provider":    entry.Provider,
			"depth":       entry.Depth,
			"seconds":     int(elapsed),
			"steps":       entry.Steps,
			"tool_calls":  entry.ToolCalls,
			"activity":    entry.Activity,
			"state":       state,
			"stop_reason": stopReason,
		})
	}
	return rows
}

// noteRow is one board row as the note names it. A value type rather than the
// Delegation pointer: the note is read after the lock is dropped, so it works
// from a copy.
type noteRow struct {
	id, label, activity string
	seconds             int
}

// Note is the payload-tail block that tells the model about the board.
//
// It rides in `Notes` rather than in the history because of where a delegation
// happens: the parent's model is **blocked** inside a foreground subagent tool
// call for the whole time, so it cannot act on this note and will not read it.
// What the note is for is the other direction — a child that was interrupted, a
// session restored while one was running, and now a **background delegation**
// that finished after the turn ended all leave the parent's next request with no
// evidence of work that was already paid for, and this is that evidence.
//
// It is worded as facts rather than instructions where a live delegation is
// concerned — there is no instruction the parent could follow for one — but the
// uncollected section is an instruction, because collecting is exactly the move
// the parent can make.
func (b *Board) Note() string {
	if b == nil {
		return ""
	}
	now := b.clock()
	b.mu.Lock()
	asRow := func(id string, entry *Delegation) noteRow {
		return noteRow{
			id:       id,
			label:    entry.Label,
			activity: entry.Activity,
			seconds:  int(entry.Duration(now)),
		}
	}
	runningRows := make([]noteRow, 0, len(b.running))
	uncollectedRows := make([]noteRow, 0, len(b.done))
	for id, entry := range b.running {
		row := asRow(id, entry)
		if _, settled := b.done[id]; settled {
			uncollectedRows = append(uncollectedRows, row)
			continue
		}
		runningRows = append(runningRows, row)
	}
	b.mu.Unlock()

	sort.SliceStable(runningRows, func(i, j int) bool { return runningRows[i].id < runningRows[j].id })
	sort.SliceStable(uncollectedRows, func(i, j int) bool { return uncollectedRows[i].id < uncollectedRows[j].id })

	var parts []string
	for _, row := range runningRows {
		parts = append(parts, noteEntry(row))
	}
	var out strings.Builder
	if len(parts) > 0 {
		out.WriteString("## 子 agent\n")
		out.WriteString(strings.Join(parts, "；") + "。\n")
		out.WriteString("不要频繁轮询它：需要它结果时调一次 subagent_output(id=...)，" +
			"默认会等到它完成（wait_seconds 可调大，中途看进度用 wait=false）；" +
			"等待期间先做不依赖这个结果的事。不要凭猜测替它下结论。")
	}
	if len(uncollectedRows) > 0 {
		if len(parts) > 0 {
			out.WriteString("\n\n")
		}
		out.WriteString("## 已完成待收取的子 agent\n")
		list := make([]string, 0, len(uncollectedRows))
		for _, row := range uncollectedRows {
			list = append(list, noteEntry(row))
		}
		out.WriteString(strings.Join(list, "；") + "。\n")
		out.WriteString("它们的结果还在等收取：用 subagent_output 带上 id 逐个收取，再决定是否影响你接下来的回答。")
	}
	return out.String()
}

// noteEntry is one board row as the note names it: id first (it is the handle
// every other tool takes), label in brackets (it is what the row means), then
// the fact that varies.
func noteEntry(row noteRow) string {
	entry := row.id
	if row.label != "" {
		entry += "（" + row.label + "）"
	}
	entry += "，" + strconv.Itoa(row.seconds) + " 秒"
	if row.activity != "" {
		entry += "，正在 " + row.activity
	}
	return entry
}
