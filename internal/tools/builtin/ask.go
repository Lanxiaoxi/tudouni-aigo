package builtin

import (
	"context"
	"fmt"
	"strconv"
	"strings"

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

// AskArgs is one question — the unit the channel underneath carries. It is still
// one question, because the channel blocks on a person and speaks one question
// per round trip; a single `ask_user` call may hand it several of these and ask
// them one at a time.
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
//
// One call may carry **several** questions. They are asked one after another over
// the same channel — each still a single `question_request` a front end already
// knows how to answer — and their answers come back together in one result. The
// tool deliberately does not batch them into one wire message: the blocking
// channel's whole contract is one request, one answer, and a person at a keyboard
// answers one box at a time anyway.
func NewAskUser(questioner Questioner) tools.Tool {
	return tools.Tool{
		Name: "ask_user",
		// The description carries the "when NOT to ask" list, because it is sent
		// every turn while the system prompt is only written once for new sessions.
		Description: "向用户提一到多个问题，并把他的回答作为这次调用的结果拿到。只在缺了它就没法选对工具或参数时才用：能从工作区里自己查清的一律自己查，偏好类的问题不要问。更不要拿它去征求执行许可 —— 审批由 runtime 负责，你照常调用即可；用提问代替审批只会多一次打断。questions 里每个问题一项：options 给了就按编号显示给用户，留空表示让他自由作答；多个问题会依次问给用户，答案按顺序一起返回。能一次问清的就放进一次调用，不要拆成多次；同一个问题不要问第二遍。",
		Risk:        security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"questions": tools.ArraySchema(
				"要问的问题，一次一到多个，按顺序依次问给用户。",
				tools.ObjectSchema(map[string]any{
					"question":     tools.StringSchema("要问的问题", tools.MinLength(1)),
					"header":       tools.StringSchema("不超过 12 字的标签，供界面显示；空串表示没有"),
					"options":      tools.ArraySchema("给了选项就按编号显示给用户；留空表示让他自由作答", tools.StringSchema("一个选项")),
					"multi_select": tools.BoolSchema("是否允许选多个（只在给了 options 时有意义）", tools.Default(false)),
				}, "question"),
			),
		}, "questions"),
		Handler: func(ctx context.Context, args map[string]any) (tools.Result, error) {
			return askUser(questioner, args), nil
		},
		ParallelSafe: false,
		Interactive:  true,
	}
}

func askUser(questioner Questioner, args map[string]any) tools.Result {
	questions := questionsArg(args, "questions")
	if len(questions) == 0 {
		// An empty list is not a request for anything. Saying so explicitly keeps
		// the model from reading the empty result as "the user had no opinion".
		return tools.Result{
			Text: "这次调用没有要问的问题（questions 为空），所以没有打扰用户。" +
				"请继续推进；需要假设时在最终答复里说明。",
			Audit: map[string]any{
				"question_status":   Unavailable,
				"question_statuses": []string{},
				"question_count":    0,
				"human_wait_ms":     0,
				"status":            "ok",
			},
		}
	}

	channel := questioner
	if channel == nil {
		channel = unavailableQuestioner
	}

	answers := make([]Answer, 0, len(questions))
	totalWait := 0
	for _, asked := range questions {
		answer := channel(asked)
		totalWait += answer.HumanWaitMs
		answers = append(answers, answer)
	}

	return tools.Result{
		Text: renderAsks(questions, answers),
		Audit: map[string]any{
			// The single word the audit has always carried, plus the per-question
			// list. The word keeps `state/status.go`'s `asks` counter and the TUI's
			// WAITING_HUMAN state working unchanged; the list is the truth when
			// several questions had different fates.
			"question_status":   aggregateStatus(answers),
			"question_statuses": statusList(answers),
			"question_count":    len(questions),
			"human_wait_ms":     totalWait,
			"status":            "ok",
		},
	}
}

// renderAsks turns the answers into text for the model. One question keeps the
// exact wording of the single-question tool; several are numbered so each answer
// is attached to the question it belongs to.
func renderAsks(questions []AskArgs, answers []Answer) string {
	if len(questions) == 1 {
		return renderAsk(answers[0])
	}

	var builder strings.Builder
	needGuidance := false
	for index, asked := range questions {
		if index > 0 {
			builder.WriteString("\n")
		}
		fmt.Fprintf(&builder, "问题 %d/%d：%s\n", index+1, len(questions), asked.Question)
		switch answers[index].Status {
		case Answered:
			builder.WriteString("用户回答：" + clipAnswer(answers[index].Text))
		case Skipped:
			builder.WriteString("用户跳过，没有给答案。")
			needGuidance = true
		default:
			builder.WriteString("没有人可以回答。")
			needGuidance = true
		}
	}
	if needGuidance {
		builder.WriteString("\n被跳过或没人回答的问题，请自行选最合理的做法并在最终答复里说明假设 —— " +
			"不要把它当成默许，也不要重复调用 ask_user。")
	}
	return builder.String()
}

// renderAsk turns one answer into text for the model. Only answered gets the
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
		return "用户回答：" + clipAnswer(answer.Text)
	}
}

// clipAnswer bounds one answer, and says so when it does.
func clipAnswer(text string) string {
	runes := []rune(text)
	if len(runes) > MaxAnswerChars {
		return string(runes[:MaxAnswerChars]) + "…（回答被截断，共 " + strconv.Itoa(len(runes)) + " 字符）"
	}
	return text
}

// aggregateStatus folds several answers into the one word the audit carries.
// `answered` means every question was answered, `unavailable` means none of them
// reached a person; anything else is `skipped` — a partial answer is not consent.
// The per-question list beside it carries the detail.
func aggregateStatus(answers []Answer) string {
	everyAnswered := true
	anyReached := false
	for _, answer := range answers {
		if answer.Status == Answered {
			anyReached = true
			continue
		}
		everyAnswered = false
	}
	switch {
	case everyAnswered && len(answers) > 0:
		return Answered
	case !anyReached:
		return Unavailable
	default:
		return Skipped
	}
}

func statusList(answers []Answer) []string {
	out := make([]string, 0, len(answers))
	for _, answer := range answers {
		out = append(out, answer.Status)
	}
	return out
}

// questionsArg reads the `questions` array into one AskArgs per entry. A malformed
// entry is skipped rather than crashing the handler; validation has already
// rejected the shapes the schema knows about.
func questionsArg(args map[string]any, key string) []AskArgs {
	list, ok := args[key].([]any)
	if !ok {
		return nil
	}
	out := make([]AskArgs, 0, len(list))
	for _, item := range list {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, AskArgs{
			Question:    stringArg(record, "question"),
			Header:      stringArg(record, "header"),
			Options:     stringSliceArg(record, "options"),
			MultiSelect: boolArg(record, "multi_select"),
		})
	}
	return out
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
