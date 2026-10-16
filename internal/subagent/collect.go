package subagent

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// DefaultCollectName is the collect tool's name. It is a separate constant
// rather than a field on Config because the tool has no configuration of its
// own: it reads the board, and everything else about a delegation is the
// delegating tool's business.
const DefaultCollectName = "subagent_output"

// The wait parameters mirror job_output on purpose: the two tools answer the
// same question ("is my background work done, and if so what did it say") for
// two different kinds of background work, and two tools that wait differently
// would teach the model two habits for one situation. The documented default
// is what the default must be, for the reason the jobs board states.
const (
	DocumentedCollectWaitSeconds = 30
	MaxCollectWaitSeconds        = 300
)

// collectPollInterval is how often the wait below looks at the board. It is a
// variable rather than a constant only so a test can shorten it.
var collectPollInterval = 100 * time.Millisecond

// BuildCollect returns the tool that hands a finished background delegation's
// result to the parent. It is registered beside the delegating tool whenever
// that tool exists; there is nothing to collect without delegation, and a tool
// that can never answer is a round trip wasted every time it is tried.
//
// The tool is deliberately **session-scoped**: it reads the runtime's board,
// which is the delegating session's own state, so it is withheld from children
// exactly like todo_write and the goal tools (see sessionScopedToolNames).
func BuildCollect(board *Board) (tools.Tool, bool) {
	if board == nil {
		return tools.Tool{}, false
	}
	return tools.Tool{
		Name: DefaultCollectName,
		Description: fmt.Sprintf(
			"收取后台子 agent 的结果，参照 job_output 的等待语义：它**结束了才叫结果**，"+
				"还没结束时返回的是进度快照（跑了多久、几步、正在做什么），那不是结果。\n"+
				"带上启动时返回的 id；不带 id 则列出所有还在等收取的子 agent。收取会把结果从待收取列表里移除，"+
				"所以每个结果只取一次。\n"+
				"默认等最多 %d 秒，到点它还没结束就返回进度快照；知道它要跑更久就自己给 wait_seconds（上限 %d）。\n"+
				"中途只想看它跑到哪儿了、不想占着：wait=false，立刻返回进度快照。",
			DocumentedCollectWaitSeconds, MaxCollectWaitSeconds),
		// Read on the runtime's own state, not a workspace or process operation:
		// the answer exists only in memory, and handing it over changes nothing
		// but the board's bookkeeping. Low risk keeps it inside the set a
		// delegated agent could use — which is exactly why it is withheld from
		// them by name instead (see sessionScopedToolNames).
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"id": tools.StringSchema(
				"要收取的子 agent 的 id，来自后台委派启动时返回的那一条。不填则只列出待收取的。"),
			"wait": tools.BoolSchema(
				"true（默认）表示它还没结束就等一会儿；false 表示立刻返回**到目前为止**的进度快照",
				tools.Default(true)),
			"wait_seconds": tools.IntSchema(
				fmt.Sprintf("wait=true 时最多等多少秒（上限 %d）。到点它还没结束，返回的就是进度快照 —— 那不是结果", MaxCollectWaitSeconds),
				tools.Default(DocumentedCollectWaitSeconds), tools.Minimum(1), tools.Maximum(MaxCollectWaitSeconds)),
		}),
		ParallelSafe: true,
		Handler: func(ctx context.Context, arguments map[string]any) (tools.Result, error) {
			id := strings.TrimSpace(stringArg(arguments, "id"))
			wait, _ := arguments["wait"].(bool)
			seconds, _ := arguments["wait_seconds"].(int)
			return collectExecute(ctx, board, id, wait, seconds), nil
		},
	}, true
}

// collectExecute is the handler body, split out so the board is the only
// dependency and tests can drive it without a whole registry.
func collectExecute(ctx context.Context, board *Board, id string, wait bool, seconds int) tools.Result {
	if id == "" {
		return tools.TextResult(listUncollected(board))
	}
	if seconds <= 0 {
		seconds = DocumentedCollectWaitSeconds
	}

	// A delegation that is not running has a definite answer, and the wait
	// cannot change it: settle it or report that the id names nothing.
	if !board.IsRunning(id) {
		return tools.Result{
			Text:  collectFinished(board, id),
			Audit: map[string]any{"subagent_id": id, "subagent_status": "collected"},
		}
	}

	if !wait {
		return runningResult(board, id, false)
	}

	// The wait: poll the board until the delegation stops running, the
	// deadline passes, or the context is cancelled. A delegation that
	// settles **during** the wait is collected here, which is the whole
	// point of the parameter — the parent asks once and gets the answer,
	// instead of polling every few seconds and paying a model round trip
	// per poll.
	deadline := time.Now().Add(time.Duration(seconds) * time.Second)
	for board.IsRunning(id) {
		if !sleepOrDone(ctx, collectPollInterval) {
			return runningResult(board, id, true)
		}
		if time.Now().After(deadline) {
			return runningResult(board, id, false)
		}
	}
	return tools.Result{
		Text:  collectFinished(board, id),
		Audit: map[string]any{"subagent_id": id, "subagent_status": "collected"},
	}
}

// collectFinished settles a delegation that is no longer running.
func collectFinished(board *Board, id string) string {
	settlement, ok := board.Collect(id)
	if !ok {
		return fmt.Sprintf(
			"no subagent waiting to be collected is called %s: the id may be wrong, or its result has already been collected (each result is handed over once). "+
				"Call without an id to list what is still waiting.", id)
	}
	return settlement.Text
}

// runningResult is the answer for a delegation that is still doing work.
// interrupted marks a wait that was cut short by a stop rather than by its own
// deadline, and that is a different fact from "it is still running": the model
// has to know its wait did not run to completion, for the reason the jobs
// board states for the same case.
func runningResult(board *Board, id string, interrupted bool) tools.Result {
	text := fmt.Sprintf("**not finished yet**: %s.\nThis is not a result; collect it once it ends (or pass wait=true and wait).",
		board.Snapshot(id))
	if interrupted {
		text = "**this wait was interrupted** (the child did not end, and the deadline was not reached) — " + text
	}
	audit := map[string]any{"subagent_id": id, "subagent_status": "running"}
	if interrupted {
		audit[tools.InterruptedAuditKey] = true
	}
	return tools.Result{Text: text, Audit: audit}
}

// sleepOrDone waits for d and reports whether it got there. A false answer
// means the context was cancelled first, which is the caller's signal to stop
// waiting.
func sleepOrDone(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

// listUncollected renders the waiting list. Sorted by the board's own order
// (newest first, the done panel's), because the freshest result is the one the
// turn most likely came back for.
func listUncollected(board *Board) string {
	rows := board.DonePanel()
	var waiting []map[string]any
	for _, row := range rows {
		if state, _ := row["state"].(string); state == "uncollected" {
			waiting = append(waiting, row)
		}
	}
	if len(waiting) == 0 {
		return "no background subagent is waiting to be collected."
	}
	parts := make([]string, 0, len(waiting))
	for _, row := range waiting {
		entry, _ := row["id"].(string)
		if label, _ := row["label"].(string); label != "" {
			entry += " (" + label + ")"
		}
		if reason, _ := row["stop_reason"].(string); reason != "" && reason != "answered" {
			entry += " [" + reason + "]"
		}
		parts = append(parts, entry)
	}
	return strings.Join(parts, ", ")
}
