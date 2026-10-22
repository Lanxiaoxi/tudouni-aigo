package runtime

import (
	"fmt"
	"os"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/version"
)

func stringOf(value any) string {
	text, _ := value.(string)
	return text
}

// NoModelError means no usable route is configured. It carries the catalogue so the
// message can list what was read and what was wrong with each route.
type NoModelError struct{ Catalog state.Registry }

func (e *NoModelError) Error() string { return "no usable model route" }

func catalogPath() string { return "" }

func questionerOf(channels protocol.Channels) builtin.Questioner {
	if channels.Questioner == nil {
		return nil
	}
	questioner := channels.Questioner
	return func(questions []builtin.AskArgs) []builtin.Answer {
		arguments := make([]protocol.AskUserArgs, len(questions))
		for index, question := range questions {
			arguments[index] = protocol.AskUserArgs{
				Question: question.Question, Header: question.Header,
				Options: question.Options, MultiSelect: question.MultiSelect,
			}
		}
		result := questioner(protocol.AskUserBatchArgs{Questions: arguments})
		answers := make([]builtin.Answer, len(result.Answers))
		for index, answer := range result.Answers {
			answers[index] = builtin.Answer{
				Text: answer.Text, Status: answer.Status, HumanWaitMs: answer.HumanWaitMs,
			}
		}
		return answers
	}
}

// firstNonEmpty returns the first value that is not blank.
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// intOf reads a whole number out of a decoded JSON object.
//
// It exists here rather than being shared with the agent-facing helpers because the
// shapes differ: this side reads what `encoding/json` produced (float64 for every
// number) out of stored metadata, and a missing or mistyped field is not an error —
// the count it feeds is a display figure, and zero is the honest reading of "not
// recorded".
func intOf(value any) int {
	switch number := value.(type) {
	case int:
		return number
	case int64:
		return int(number)
	case float64:
		return int(number)
	default:
		return 0
	}
}

// notice builds one start-up line.//
// `stream` says where it belongs: "err" for diagnostics, "out" for the one thing
// that is part of the session's own output. The distinction is not cosmetic — the
// line REPL's stdout is a documented contract (`tudouni-aigo > chat.txt` has to contain
// the conversation and nothing else), so a notice that lands on the wrong stream
// either pollutes the transcript or hides a warning where nobody reads it.
func notice(level, code, text string) map[string]any {
	return map[string]any{"level": level, "code": code, "text": text, "stream": "err"}
}

// outNotice is a notice that belongs on stdout. There is exactly one kind — the
// list of registered tools — and it is there because the previous generation put it
// there and the ordering of the start-up output is a contract too.
func outNotice(level, code, text string) map[string]any {
	return map[string]any{"level": level, "code": code, "text": text, "stream": "out"}
}

// renderRegisteredTools is the one-row-per-tool part of the start-up table.
//
// Sorted by the registry already, so two runs of the same build produce the same
// text — a diff of two sessions means something only if the constant part really is
// constant.
func renderRegisteredTools(registry *tools.Registry) string {
	rows := make([]string, 0, registry.Len())
	for _, tool := range registry.All() {
		rows = append(rows, i18n.T("notice.tools.row", "name", tool.Name, "risk", string(tool.Risk)))
	}
	return strings.Join(rows, "\n")
}

func panelOf(jobs *builtin.JobBoard) []any {
	if jobs == nil {
		return []any{}
	}
	rows := jobs.Panel()
	out := make([]any, 0, len(rows))
	for _, row := range rows {
		out = append(out, row)
	}
	return out
}

func formattedRules(rules []security.Rule) []string {
	out := make([]string, 0, len(rules))
	for _, rule := range rules {
		if text, err := security.FormatRule(rule); err == nil {
			out = append(out, text)
		}
	}
	return out
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}

func intOrNil(value any) any {
	switch number := value.(type) {
	case int:
		return number
	case float64:
		return int(number)
	default:
		return nil
	}
}

// intPtr reads a nullable number out of an audit record or a summary map. The
// pointer matters: "no reading yet" and "zero" are different facts, and a stats line
// that prints 0 for both tells the reader something false.
func intPtr(value any) *int {
	switch number := value.(type) {
	case int:
		return &number
	case int64:
		converted := int(number)
		return &converted
	case float64:
		converted := int(number)
		return &converted
	default:
		return nil
	}
}

// warn writes a diagnostic to stderr.
//
// Never to stdout: stdout carries the protocol when this process is a child, and
// prose mixed into it corrupts the stream for every reader that is parsing it.
func warn(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}

// Version is the build identification reported by --version.
func Version() string { return version.Current() }
