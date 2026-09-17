package builtin

import (
	"fmt"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// Key under which the task list lives in session metadata. Both the writer
// (TodoBoard) and the reader (ProgressLine) share this one constant.
const TodosKey = "todos"

// Status values are fixed literals, so the schema carries an enum and the model
// cannot invent a third spelling that gets stored as a new state.
const (
	Pending    = "pending"
	InProgress = "in_progress"
	Completed  = "completed"
)

// TodoItem is one task as the model supplied it.
type TodoItem struct {
	Content string
	Status  string
}

// todoEntry is the stored shape. It is a map (not a struct) so it round-trips
// through JSON session files and back into the loader unchanged.
type todoEntry struct {
	Content string `json:"content"`
	Status  string `json:"status"`
}

// TodoBoard binds the task list to a session's metadata. It touches nothing else —
// no files, no control plane — which is why the tool is low risk and auto-approvable.
type TodoBoard struct {
	Metadata map[string]any
}

// NewTodoBoard builds a board over the live session metadata.
func NewTodoBoard(metadata map[string]any) *TodoBoard {
	return &TodoBoard{Metadata: metadata}
}

// ProgressLine renders one line for humans: "2/5 done, now: write tests". No tasks
// returns "" so the caller can skip the line entirely.
func (b *TodoBoard) ProgressLine() string {
	items := loadTodos(b.Metadata)
	if len(items) == 0 {
		return ""
	}
	done := 0
	var current string
	for _, it := range items {
		if it.Status == Completed {
			done++
		}
		if it.Status == InProgress && current == "" {
			current = it.Content
		}
	}
	text := i18n.T("todo.progress", "done", done, "total", len(items))
	if current != "" {
		text += i18n.T("todo.progress.current", "what", clipTodo(current, 40))
	}
	return text
}

// NewTodo builds the todo_write tool. The whole list is replaced on every call, so
// the model never has to keep the previous version in its head.
func NewTodo(metadata map[string]any) tools.Tool {
	board := NewTodoBoard(metadata)
	return tools.Tool{
		Name: "todo_write",
		// The description warns against building lists for one-step or cosmetic work;
		// that rule lives here because the description is sent every turn, the system
		// prompt only once.
		Description: `把你当前的多步计划整份写下来，让它在后面几十步里不会走丢。**只在活儿明显不止一两步、而且你能列出具体步骤时用** —— 单步的琐碎事不要建列表，也不要为了好看而建。
每次都要传**完整的新列表**：它会替换上一次的整份列表，不是增量。开工前把步骤列出来；开始做哪条就把它标成 in_progress（真的在并行时可以同时标好几条）；做完一条立刻标 completed，不要攒着一起标。只要还有没做完的，列表里就该有一条 in_progress。全部完成时传空数组把列表清掉。
它是进度，不是任务本身：别把时间花在反复整理列表上。`,
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"todos": tools.ArraySchema(
				"完整的新列表 —— 它**替换**上一次的整份列表，不是增量。传空数组表示清空（这个任务不再需要列表时就这么传）",
				tools.ObjectSchema(map[string]any{
					"content": tools.StringSchema("这一步要做什么，一句话（祈使句，不要写成段落）", tools.MinLength(1)),
					"status": tools.StringSchema(
						"pending 待办 / in_progress 正在做 / completed 已完成",
						tools.Default(Pending),
						tools.Enum(Pending, InProgress, Completed),
					),
				}, "content"),
			),
		}, "todos"),
		Handler: func(args map[string]any) (tools.Result, error) {
			return board.Write(args), nil
		},
		ParallelSafe: false,
		Interactive:  false,
	}
}

// Write replaces the stored list and returns the ack text plus audit counts. It
// only reminds about a missing in_progress item; it never fills one in for the
// model, which would fabricate the model's own stated intent.
func (b *TodoBoard) Write(args map[string]any) tools.Result {
	raw, ok := args["todos"]
	if !ok {
		return tools.TextResult("参数 todos 缺失")
	}
	list, ok := raw.([]any)
	if !ok {
		return tools.TextResult("参数 todos 格式错误")
	}

	items := make([]TodoItem, 0, len(list))
	for _, entry := range list {
		m, ok := entry.(map[string]any)
		if !ok {
			return tools.TextResult("todos 条目格式错误")
		}
		content, _ := m["content"].(string)
		status, _ := m["status"].(string)
		if status == "" {
			status = Pending
		}
		items = append(items, TodoItem{Content: content, Status: status})
	}

	// All completed (or empty) collapses to an empty list: a list of all ticks
	// carries no information and would be replayed forever.
	stored := []map[string]any{}
	if !allCompleted(items) {
		for _, it := range items {
			stored = append(stored, map[string]any{"content": it.Content, "status": it.Status})
		}
	}
	if b.Metadata != nil {
		b.Metadata[TodosKey] = stored
	}

	return tools.Result{
		Text:  ackTodo(items, stored, len(items)),
		Audit: countsTodo(stored),
	}
}

// loadTodos reads the list defensively: one malformed entry discards the whole
// list rather than handing the model a silently partial one.
func loadTodos(metadata map[string]any) []todoEntry {
	raw, ok := metadata[TodosKey]
	if !ok {
		return nil
	}
	list, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]todoEntry, 0, len(list))
	for _, entry := range list {
		m, ok := entry.(map[string]any)
		if !ok {
			return nil
		}
		content, _ := m["content"].(string)
		status, _ := m["status"].(string)
		if status != Pending && status != InProgress && status != Completed {
			return nil
		}
		if content == "" {
			return nil
		}
		out = append(out, todoEntry{Content: content, Status: status})
	}
	return out
}

// ackTodo does not echo the list back — the model just sent it in the assistant
// message, and echoing it would store the same content twice in history.
func ackTodo(items []TodoItem, stored []map[string]any, sent int) string {
	if sent == 0 {
		return "任务列表已清空。"
	}
	if len(stored) == 0 {
		return "任务列表已清空（全部完成）。"
	}
	var parts []string
	for _, status := range []string{InProgress, Pending, Completed} {
		n := 0
		for _, it := range items {
			if it.Status == status {
				n++
			}
		}
		if n > 0 {
			parts = append(parts, fmt.Sprintf("%s %d 项", statusLabel(status), n))
		}
	}
	text := fmt.Sprintf("任务列表已更新：%d 项（%s）。", len(items), strings.Join(parts, "、"))
	if !hasInProgress(items) {
		text += "\n提醒：列表里还有未完成的任务，但没有任何一项标为进行中 —— 把当前正在做的那项改成 in_progress。"
	}
	return text
}

func countsTodo(stored []map[string]any) map[string]any {
	total := len(stored)
	inProgress := 0
	completed := 0
	for _, it := range stored {
		switch it["status"] {
		case InProgress:
			inProgress++
		case Completed:
			completed++
		}
	}
	return map[string]any{
		"todos_total":       total,
		"todos_in_progress": inProgress,
		"todos_completed":   completed,
	}
}

func statusLabel(status string) string {
	switch status {
	case Pending:
		return "待办"
	case InProgress:
		return "进行中"
	case Completed:
		return "已完成"
	default:
		return status
	}
}

func allCompleted(items []TodoItem) bool {
	if len(items) == 0 {
		return false
	}
	for _, it := range items {
		if it.Status != Completed {
			return false
		}
	}
	return true
}

func hasInProgress(items []TodoItem) bool {
	for _, it := range items {
		if it.Status == InProgress {
			return true
		}
	}
	return false
}

func clipTodo(text string, limit int) string {
	runes := []rune(strings.ReplaceAll(text, "\n", " "))
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit]) + "…"
}
