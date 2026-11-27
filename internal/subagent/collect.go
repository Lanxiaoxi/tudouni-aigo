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

// The wait bounds mirror job_output's numbers so the two kinds of background
// work time out on the same scale. The **shape** of the wait differs on purpose:
// a job is waited for by id, a delegation is not (see collectAny).
const (
	DocumentedCollectWaitSeconds = 30
	MaxCollectWaitSeconds        = 300
)

// collectPollInterval is how often the wait below looks at the board. It is a
// variable rather than a constant only so a test can shorten it.
var collectPollInterval = 100 * time.Millisecond

// BuildCollect returns the tool that hands finished background delegations'
// results to the parent. It is registered beside the delegating tool whenever
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
			"收取后台子 agent 的结果。**不要指定等哪一个**：不带 id 调用，就等到**任意一个**子 agent 结束，"+
				"并把那一刻所有已结束的结果一起交给你（按结束先后排）；拿到后先处理，还有在跑的就再调一次。"+
				"你不知道谁先完成，按 id 去等只会让先完成的干等着。\n"+
				"它**结束了才叫结果**：到点还没有任何一个结束时，返回的是所有在跑的子 agent 的进度快照（跑了多久、几步、正在做什么），那不是结果。"+
				"没有在跑、也没有待收取的子 agent 时立刻返回。每个结果只交付一次。\n"+
				"默认最多等 %d 秒，知道它们要跑更久就自己给 wait_seconds（上限 %d）；wait=false 表示不等，立刻交出已结束的、报告在跑的。\n"+
				"带 id 只用来**看一眼**某一个：结束了就交出它的结果，没结束就返回它的进度快照，**不会等**。",
			DocumentedCollectWaitSeconds, MaxCollectWaitSeconds),
		// Read on the runtime's own state, not a workspace or process operation:
		// the answer exists only in memory, and handing it over changes nothing
		// but the board's bookkeeping. Low risk keeps it inside the set a
		// delegated agent could use — which is exactly why it is withheld from
		// them by name instead (see sessionScopedToolNames).
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"id": tools.StringSchema(
				"可选。只在想看某一个子 agent 时填：结束了就交出它的结果，没结束就返回它的进度快照，不会等。要等结果就不要填。"),
			"wait": tools.BoolSchema(
				"不带 id 时有效：true（默认）表示还没有任何一个结束就等一会儿；false 表示立刻返回",
				tools.Default(true)),
			"wait_seconds": tools.IntSchema(
				fmt.Sprintf("wait=true 时最多等多少秒（上限 %d）。到点还没有任何一个结束，返回的就是进度快照 —— 那不是结果", MaxCollectWaitSeconds),
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
//
// An id is a look, never a wait. The schema fills `wait` with its default, so a
// call with an id cannot be told apart from one that asked to wait; ignoring
// `wait` there is what keeps "block on one chosen child" out of the tool
// entirely, rather than merely discouraged by its description.
func collectExecute(ctx context.Context, board *Board, id string, wait bool, seconds int) tools.Result {
	if id != "" {
		return collectOne(board, id)
	}
	if seconds <= 0 {
		seconds = DocumentedCollectWaitSeconds
	}
	if seconds > MaxCollectWaitSeconds {
		seconds = MaxCollectWaitSeconds
	}
	return collectAny(ctx, board, wait, time.Duration(seconds)*time.Second)
}

// collectOne is the look at one named delegation.
func collectOne(board *Board, id string) tools.Result {
	if board.IsRunning(id) {
		return tools.Result{
			Text: fmt.Sprintf("**not finished yet**: %s.\nThis is not a result. To wait, call %s without an id: it returns as soon as any subagent finishes.",
				board.Snapshot(id), DefaultCollectName),
			Audit: map[string]any{"subagent_id": id, "subagent_status": "running"},
		}
	}
	return tools.Result{
		Text:  collectFinished(board, id),
		Audit: map[string]any{"subagent_id": id, "subagent_status": "collected"},
	}
}

// collectAny is the wait-any: it returns as soon as **any** background
// delegation has settled, and hands over every one that has by then.
//
// The parent cannot know which child finishes first, so a wait pinned to one id
// is a guess, and a wrong guess leaves every earlier finisher unread until the
// chosen one ends. Waiting on the board as a whole removes the guess. Taking all
// settled results at once means a burst of finishes costs one round trip, not
// one per child.
func collectAny(ctx context.Context, board *Board, wait bool, limit time.Duration) tools.Result {
	deadline := time.Now().Add(limit)
	for {
		ready, running := board.TakeReady()
		if len(ready) > 0 {
			return readyResult(ready, running)
		}
		if running == 0 {
			// Waiting here could only ever end at the deadline: nothing is in
			// flight that could settle.
			return tools.Result{
				Text:  "no background subagent is running or waiting to be collected; there is nothing to wait for.",
				Audit: map[string]any{"subagent_status": "none"},
			}
		}
		if !wait {
			return runningAll(board, false, false)
		}
		if !sleepOrDone(ctx, collectPollInterval) {
			return runningAll(board, true, false)
		}
		if time.Now().After(deadline) {
			return runningAll(board, false, true)
		}
	}
}

// readyResult renders the handed-over results, followed by what is still going
// so the parent knows whether to wait again.
func readyResult(ready []Ready, running int) tools.Result {
	var out strings.Builder
	ids := make([]string, 0, len(ready))
	for index, item := range ready {
		if index > 0 {
			out.WriteString("\n\n")
		}
		out.WriteString(item.Settlement.Text)
		ids = append(ids, item.ID)
	}
	out.WriteString("\n\n")
	if running > 0 {
		out.WriteString(fmt.Sprintf("%d background subagent(s) still running; call %s again without an id to wait for the next one.",
			running, DefaultCollectName))
	} else {
		out.WriteString("no background subagent is still running.")
	}
	audit := map[string]any{"subagent_status": "collected", "subagent_ids": ids}
	if len(ids) == 1 {
		audit["subagent_id"] = ids[0]
	}
	return tools.Result{Text: out.String(), Audit: audit}
}

// collectFinished settles a delegation that is no longer running.
func collectFinished(board *Board, id string) string {
	settlement, ok := board.Collect(id)
	if !ok {
		if board.WasCollected(id) {
			return fmt.Sprintf(
				"subagent %s was already collected: each result is handed over once, and its answer is in an earlier subagent_output result.", id)
		}
		return fmt.Sprintf(
			"no subagent waiting to be collected is called %s: the id may be wrong, or its result has already been collected (each result is handed over once). "+
				"Call without an id to wait for whatever is still running.", id)
	}
	return settlement.Text
}

// runningAll is the answer for a wait that produced no result: every child
// still doing work, as progress lines. interrupted marks a wait cut short by a
// stop rather than by its own deadline, and that is a different fact from "they
// are still running": the model has to know its wait did not run to completion,
// for the reason the jobs board states for the same case.
func runningAll(board *Board, interrupted, timedOut bool) tools.Result {
	lines := board.RunningSnapshots()
	text := fmt.Sprintf("**none finished yet**: %d background subagent(s) still running.\n- %s\nThis is not a result.",
		len(lines), strings.Join(lines, "\n- "))
	switch {
	case interrupted:
		text = "**this wait was interrupted** (no subagent ended, and the deadline was not reached) — " + text
	case timedOut:
		text += " The wait reached its deadline; call again (with a larger wait_seconds if they need longer)."
	}
	audit := map[string]any{"subagent_status": "running"}
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
