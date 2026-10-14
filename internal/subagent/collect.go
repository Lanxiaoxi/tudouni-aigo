package subagent

import (
	"context"
	"fmt"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// DefaultCollectName is the collect tool's name. It is a separate constant
// rather than a field on Config because the tool has no configuration of its
// own: it reads the board, and everything else about a delegation is the
// delegating tool's business.
const DefaultCollectName = "subagent_output"

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
		Description: "收取已完成的后台子 agent 的结果。带上启动时返回的 id；" +
			"不带 id 则列出所有还在等收取的子 agent。收取会把结果从待收取列表里移除，" +
			"所以每个结果只取一次。还在跑的子 agent 不能收取，等它完成。",
		// Read on the runtime's own state, not a workspace or process operation:
		// the answer exists only in memory, and handing it over changes nothing
		// but the board's bookkeeping. Low risk keeps it inside the set a
		// delegated agent could use — which is exactly why it is withheld from
		// them by name instead (see sessionScopedToolNames).
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"id": tools.StringSchema(
				"要收取的子 agent 的 id，来自后台委派启动时返回的那一条。不填则只列出待收取的。"),
		}),
		ParallelSafe: true,
		Handler: func(_ context.Context, arguments map[string]any) (tools.Result, error) {
			id := strings.TrimSpace(stringArg(arguments, "id"))
			return collectExecute(board, id), nil
		},
	}, true
}

// collectExecute is the handler body, split out so the board is the only
// dependency and tests can drive it without a whole registry.
func collectExecute(board *Board, id string) tools.Result {
	if id == "" {
		return tools.TextResult(listUncollected(board))
	}

	// Still running? The wording matters: "wait" and "nothing by that id" are
	// different next moves, and a collect result that conflated them would send
	// the model re-delegating work that is about to arrive.
	if board.IsRunning(id) {
		return tools.TextResult(fmt.Sprintf(
			"子 agent %s 还在跑，不能收取。先做别的，等它完成后再来收取。", id))
	}

	settlement, ok := board.Collect(id)
	if !ok {
		return tools.TextResult(fmt.Sprintf(
			"没有待收取的子 agent 叫 %s：id 可能写错了，或者结果已经被收取过（每个结果只收一次）。"+
				"不带 id 调用可以列出还在等收取的。", id))
	}
	return tools.TextResult(settlement.Text)
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
		return "当前没有待收取的后台子 agent。"
	}
	parts := make([]string, 0, len(waiting))
	for _, row := range waiting {
		entry, _ := row["id"].(string)
		if label, _ := row["label"].(string); label != "" {
			entry += "（" + label + "）"
		}
		if reason, _ := row["stop_reason"].(string); reason != "" && reason != "answered" {
			entry += "【" + reason + "】"
		}
		parts = append(parts, entry)
	}
	return strings.Join(parts, "、")
}
