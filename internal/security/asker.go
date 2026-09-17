package security

import (
	"bufio"
	"fmt"
	"io"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// TrustGroup is a set of tools that can be released in one go.
//
// Currently only "the tools of one MCP server" forms a group. The granularity is
// "release this group once", and it must not be implemented as "anything from this
// server never asks again": that would let the release surface widen on its own
// the next time the server ships a `delete_everything` tool, with the
// configuration file untouched. So what is released is the **snapshot of names**
// taken now — it lands in the configuration file, can be diffed and revoked, and
// anything the server adds later still gets asked about.
type TrustGroup struct {
	// Label is the wording shown to a person. It should not have to know what the
	// tool names look like.
	Label string
	// Tools is the snapshot of names at this moment.
	Tools []string
}

// TrustGroupLookup finds the group a tool belongs to, if any.
//
// It is a function rather than a value because the group is a snapshot taken at
// the moment of the request: what is released is the tools that exist now, and a
// lookup that ran earlier would release a different set.
type TrustGroupLookup func(toolName string) (TrustGroup, bool)

// Preview limits by risk.
//
// Low and medium risk tools are judged by the kind of action they are (write_file
// carrying 3401 characters of content would push the path off the screen if
// printed whole). A high risk tool is judged by the arguments themselves, so
// truncating them means asking the user to sign without seeing everything — the
// important half of a shell command is usually the second half.
const (
	previewLimit = 120
)

// Preview flattens and optionally truncates a value for the approval prompt.
//
// Flattening always happens, because the prompt is read line by line and a
// multi-line value pushes later arguments off the screen. It is lossless: a
// newline becomes a literal `\n`, so nothing can be hidden by it.
func Preview(value any, limit int) string {
	var text string
	if asString, ok := value.(string); ok {
		text = asString
	} else {
		text = fmt.Sprintf("%v", value)
	}
	flat := strings.ReplaceAll(text, "\n", "\\n")
	if limit <= 0 || len([]rune(flat)) <= limit {
		return flat
	}
	runes := []rune(flat)
	return string(runes[:limit]) + fmt.Sprintf("…(共 %d 字符)", len(runes))
}

// previewLimitFor returns the limit for a risk level, or 0 meaning "print it whole".
func previewLimitFor(risk RiskLevel) int {
	if risk == RiskHigh {
		return 0
	}
	return previewLimit
}

// rememberConsequence follows the risk level, so a level added later still lands
// on the safe wording.
func rememberConsequence(risk RiskLevel) string {
	if risk == RiskHigh {
		return i18n.T("asker.remember.high")
	}
	return i18n.T("asker.remember.default")
}

// RememberHint is the line explaining what pressing `t` will remember.
//
// It has to say what will be remembered. A command-carrying tool remembers a
// **prefix** (`git add`), not "the whole shell never asks" — those two differ by
// orders of magnitude, and this line is the only thing the user has to judge by.
func RememberHint(risk RiskLevel, target Rule, toolTarget string, label string) string {
	tail := i18n.T("asker.remember.tail", "label", label)
	if len(target) > 0 {
		return i18n.T("asker.remember.prefix", "prefix", strings.Join(target, " ")) + tail
	}
	return rememberConsequence(risk) + tail
}

// TrustAllHint is the line explaining what pressing `a` will remember.
//
// It carries one thing more than the `t` line: **that this is a snapshot**. Without
// it a person reads "this server is fine from now on", while what actually happens
// is "these N tools went on the list" — and those two diverge the next time the
// server is upgraded.
func TrustAllHint(group TrustGroup, label string) string {
	return i18n.T("asker.trust_all", "group", group.Label) +
		i18n.T("asker.trust_all.snapshot", "label", label)
}

// CLIOptions configures the line-oriented asker.
type CLIOptions struct {
	// In is the input stream. A read failure means "cannot read", which is a refusal.
	In io.Reader
	// Prompt is where the prompt goes. It is stderr, never stdout: stdout carries
	// the agent's result, and mixing the two pollutes it (most visibly when the
	// output is redirected to a file).
	Prompt io.Writer
	// Memory is written to directly when the user presses `t` or `a`.
	Memory *Memory
	// TrustGroup looks up a group for a tool name.
	TrustGroup func(toolName string) (TrustGroup, bool)
}

// CLIAsker prints the prompt and reads one line.
//
// Five deliberate details, each of which was learned the hard way:
//
//  1. the prompt goes to stderr, because stdout carries the result;
//  2. arguments are printed as fully as the risk level allows;
//  3. a read failure returns **false**. A non-interactive environment raises EOF;
//     pressing enter also lands on the refusal branch (the prompt says `[y/N]`,
//     not `[Y/n]`). A read error on stdin is also "cannot read" — letting it
//     propagate would turn one approval into "the tool failed to run";
//  4. `t` is only offered when it can actually remember something, and it says
//     what. When there is no memory, `t` typed anyway lands on the refusal branch:
//     agreeing and then failing to remember is worse than refusing;
//  5. `a` is only offered when there is a group, and it releases a snapshot.
func CLIAsker(options CLIOptions) AskFunc {
	return func(toolName string, risk RiskLevel, arguments map[string]any) bool {
		reader := bufio.NewReader(options.In)
		prompt := options.Prompt
		memory := options.Memory

		limit := previewLimitFor(risk)
		var pairs []string
		for _, name := range sortedArgumentNames(arguments) {
			pairs = append(pairs, name+"="+Preview(arguments[name], limit))
		}
		argsPreview := strings.Join(pairs, ", ")

		var target Rule
		hasTarget := false
		if memory != nil {
			if _, isCommand := CommandParameter(toolName); !isCommand {
				target = Rule{toolName}
				hasTarget = true
			} else if command, ok := CommandOf(toolName, arguments); ok {
				if prefix, ok := SuggestPrefix(command, platformIsWindows); ok {
					target = prefix
					hasTarget = true
				}
			}
		}

		var group TrustGroup
		hasGroup := false
		if memory != nil && options.TrustGroup != nil {
			if found, ok := options.TrustGroup(toolName); ok {
				group = found
				hasGroup = true
			}
		}

		fmt.Fprintf(prompt, "[审批] 工具 %s  风险 %s\n", toolName, risk)
		fmt.Fprintf(prompt, "[审批] 参数 %s\n", argsPreview)
		if hasTarget {
			fmt.Fprintf(prompt, "[审批] t = %s\n", RememberHint(risk, target, "", memory.Label))
		}
		if hasGroup {
			fmt.Fprintf(prompt, "[审批] a = %s\n", TrustAllHint(group, memory.Label))
		}

		keys := []string{"y/N"}
		if hasTarget {
			keys = append(keys, "t")
		}
		if hasGroup {
			keys = append(keys, "a")
		}
		fmt.Fprintf(prompt, "[审批] 是否执行？[%s] ", strings.Join(keys, "/"))

		line, err := reader.ReadString('\n')
		if err != nil && line == "" {
			fmt.Fprintln(prompt)
			return false
		}
		answer := strings.ToLower(strings.TrimSpace(line))

		switch answer {
		case "t":
			if hasTarget && memory != nil {
				if len(target) == 1 && target[0] == toolName {
					memory.Grant(toolName)
				} else {
					memory.GrantPrefix(target)
				}
				return true
			}
		case "a":
			if hasGroup && memory != nil {
				memory.GrantAll(group.Tools)
				return true
			}
		}
		return answer == "y" || answer == "yes"
	}
}

// AlwaysAllow is the asker for unattended runs: it approves everything.
//
// It exists for `--autopilot` — which is a different thing from the runtime
// autopilot flag in the gate: the gate's flag records `outcome=autopilot` in the
// audit, so "was anybody watching" stays answerable afterwards.
func AlwaysAllow(toolName string, risk RiskLevel, arguments map[string]any) bool { return true }

func sortedArgumentNames(arguments map[string]any) []string {
	names := make([]string, 0, len(arguments))
	for name := range arguments {
		names = append(names, name)
	}
	// Sorted so the prompt is stable between runs; a prompt whose field order
	// changes run to run is harder to read and harder to diff.
	for i := 1; i < len(names); i++ {
		for j := i; j > 0 && names[j] < names[j-1]; j-- {
			names[j], names[j-1] = names[j-1], names[j]
		}
	}
	return names
}
