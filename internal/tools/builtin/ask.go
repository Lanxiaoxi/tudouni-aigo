package builtin

import (
	"strconv"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// Maximum length of an answer kept in the conversation. The answer is replayed on
// every later turn, so a pasted document would be paid for forever; when it is
// cut, the text says so, otherwise the model would believe it saw the whole thing.
const MaxAnswerChars = 4000

// Three outcomes, not one boolean: who answered, who skipped, and whether anyone
// was present. The third is a failure of "nobody answered", never a默许.
const (
	Answered    = "answered"
	Skipped     = "skipped"
	Unavailable = "unavailable"
)

// AskArgs is what the model can ask. One question only.
type AskArgs struct {
	Question    string
	Header      string
	Options     []string
	MultiSelect bool
}

// Answer is the result of one question. waited_ms is measured by the channel and
// carried into the audit, where it is subtracted from the tool's wall time.
type Answer struct {
	Text        string
	Status      string
	HumanWaitMs int
}

// Questioner is the channel: given a question, return an answer. The tool itself
// never touches stdin or the terminal — that is the injected implementation's job.
type Questioner func(args AskArgs) Answer

// unavailableQuestioner is the fallback when no channel was wired in (--autopilot,
// stdin stolen, CI). It is deliberately not an empty string and not a "no opinion":
// both would read as默许, and nobody actually answered.
func unavailableQuestioner(args AskArgs) Answer {
	return Answer{Text: "", Status: Unavailable, HumanWaitMs: 0}
}

// NewAskUser builds the ask_user tool. A nil questioner behaves like
// unavailableQuestioner, so "configured to ask but no channel" fails the same way
// as "not configured" — never toward allowing.
func NewAskUser(questioner Questioner) tools.Tool {
	return tools.Tool{
		Name: "ask_user",
		// The description carries the "when NOT to ask" list, because it is sent
		// every turn while the system prompt is only written once for new sessions.
		Description: "向用户提一个问题，并把他的回答作为这次调用的结果拿到。只在缺了它就没法选对工具或参数时才用：能从工作区里自己查清的一律自己查，偏好类的问题不要问。更不要拿它去征求执行许可 —— 审批由 runtime 负责，你照常调用即可；用提问代替审批只会多一次打断。options 给了就按编号显示给用户，留空表示让他自由作答。一次只问一个问题，同一个问题不要问第二遍。",
		Risk:        security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"question":     tools.StringSchema("要问的问题", tools.MinLength(1)),
			"header":       tools.StringSchema("不超过 12 字的标签，供界面显示；空串表示没有"),
			"options":      tools.ArraySchema("给了选项就按编号显示给用户；留空表示让他自由作答", tools.StringSchema("一个选项")),
			"multi_select": tools.BoolSchema("是否允许选多个（只在给了 options 时有意义）", tools.Default(false)),
		}, "question"),
		Handler: func(args map[string]any) (tools.Result, error) {
			return askUser(questioner, args), nil
		},
		ParallelSafe: false,
		Interactive:  true,
	}
}

func askUser(questioner Questioner, args map[string]any) tools.Result {
	asked := AskArgs{
		Question:    stringArg(args, "question"),
		Header:      stringArg(args, "header"),
		Options:     stringSliceArg(args, "options"),
		MultiSelect: boolArg(args, "multi_select"),
	}

	channel := questioner
	if channel == nil {
		channel = unavailableQuestioner
	}
	answer := channel(asked)

	return tools.Result{
		Text: renderAsk(answer),
		Audit: map[string]any{
			"question_status": answer.Status,
			"human_wait_ms":   answer.HumanWaitMs,
			"status":          "ok",
		},
	}
}

// renderAsk turns the answer into text for the model. Only answered gets the
// "用户回答：" prefix; skipped and unavailable tell the model to decide on its own
// and state assumptions, never to read either as consent.
func renderAsk(answer Answer) string {
	switch answer.Status {
	case Unavailable:
		return "没有人可以回答这个问题，这次调用没有拿到任何答案。" +
			"请基于最合理的默认继续，并在最终答复里说明你假设了什么 —— " +
			"不要把它当成默许，也不要在同一个问题上重复调用 ask_user。"
	case Skipped:
		return "用户跳过了这个问题，没有给答案。自行选一个最合理的做法并在最终答复里说明，不要再问一遍。"
	default:
		text := answer.Text
		runes := []rune(text)
		if len(runes) > MaxAnswerChars {
			text = string(runes[:MaxAnswerChars]) + "…（回答被截断，共 " + strconv.Itoa(len(runes)) + " 字符）"
		}
		return "用户回答：" + text
	}
}

func stringArg(args map[string]any, key string) string {
	if v, ok := args[key].(string); ok {
		return v
	}
	return ""
}

func stringSliceArg(args map[string]any, key string) []string {
	list, ok := args[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func boolArg(args map[string]any, key string) bool {
	if v, ok := args[key].(bool); ok {
		return v
	}
	return false
}
