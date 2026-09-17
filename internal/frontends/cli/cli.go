// Package cli is the line-oriented front end: one prompt, one answer, no screen
// control.
//
// It is the fallback that always works — over SSH, in a pipe, in a CI log — and it
// is also the reference for what the protocol can carry, because it uses the same
// runtime through an in-process implementation of the same channels. Nothing here
// reaches into the runtime's internals: if it did, the boundary would be a
// formality and the TUI would be free to break it too.
package cli

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/runtime"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/version"
)

// Opener builds a runtime for one session. It is the same shape the protocol
// server uses, which is how the two front ends stay honest about running the same
// thing.
type Opener func(sessionID string, hooks protocol.RuntimeHooks) (protocol.Runtime, error)

// Options configures one REPL run.
type Options struct {
	Booted    runtime.Booted
	SessionID string
	Autopilot bool
	Stream    bool
	Debug     bool
	MaxSteps  int
	Open      Opener

	In  io.Reader
	Out io.Writer
}

// Channels builds the two things a runtime may ask a person about, answered on the
// terminal.
//
// The approval function is `security.CLIAsker`, so the line REPL and the TUI ask
// the same questions with the same wording; only the way the answer is collected
// differs.
func Channels(autopilot bool) protocol.Channels {
	memory, err := runtime.MemoryFromPermissions()
	if err != nil {
		memory = security.NewMemory(nil, nil, runtime.PermissionFile(), runtime.SaveApprovals)
	}
	memory.Sink = func(text string) { fmt.Fprintln(os.Stderr, text) }

	asker := security.CLIAsker(security.CLIOptions{
		In:     os.Stdin,
		Prompt: os.Stderr,
		Memory: memory,
	})
	if autopilot {
		asker = security.AlwaysAllow
	}

	return protocol.Channels{
		Questioner: func(args protocol.AskUserArgs) protocol.Answer {
			return askOnTerminal(args)
		},
		AskerFactory: func(_ *security.Memory, trust security.TrustGroupLookup) security.AskFunc {
			return asker
		},
	}
}

// askOnTerminal asks a question on stderr and reads the answer from stdin.
//
// The question goes to stderr because stdout carries the result: mixing the two
// pollutes it, most visibly when the output is redirected to a file.
func askOnTerminal(args protocol.AskUserArgs) protocol.Answer {
	if args.Header != "" {
		fmt.Fprintf(os.Stderr, "[提问] %s\n", args.Header)
	}
	fmt.Fprintf(os.Stderr, "[提问] %s\n", args.Question)
	for index, option := range args.Options {
		fmt.Fprintf(os.Stderr, "  %d) %s\n", index+1, option)
	}
	fmt.Fprint(os.Stderr, "[提问] 回答（回车=跳过）：")

	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil && line == "" {
		// Nobody to ask is a different thing from an empty answer, and the model is
		// told so explicitly: it has to decide on its own and say what it assumed.
		return protocol.Answer{Status: protocol.AnswerUnavailable}
	}
	answer := strings.TrimSpace(line)
	if answer == "" {
		// Enter means skip, not consent. It is the easiest key to press, so making
		// it mean "yes" would turn the most dangerous path into a slip of the hand.
		return protocol.Answer{Status: protocol.AnswerSkipped}
	}
	// A number is translated to the option's text: what goes back is the text, not
	// its position, because numbers are only how this panel happens to show them.
	if index, err := parseIndex(answer); err == nil && index >= 1 && index <= len(args.Options) {
		return protocol.Answer{Text: args.Options[index-1], Status: protocol.AnswerAnswered}
	}
	return protocol.Answer{Text: answer, Status: protocol.AnswerAnswered}
}

func parseIndex(text string) (int, error) {
	var value int
	_, err := fmt.Sscanf(strings.ReplaceAll(text, "，", ","), "%d", &value)
	return value, err
}

// Run drives the REPL until the user leaves.
func Run(options Options) int {
	in := options.In
	if in == nil {
		in = os.Stdin
	}
	out := options.Out
	if out == nil {
		out = os.Stdout
	}

	fmt.Fprintln(out, version.Describe())
	fmt.Fprintf(out, "%s\n\n", i18n.T("notice.audit_line", "path", runtime.RuntimeDir()+"/logs"))

	var current protocol.Runtime
	sessionID := options.SessionID

	open := func(id string) bool {
		value, err := options.Open(id, protocol.RuntimeHooks{
			// The REPL is in-process, so a turn is never interrupted from another
			// goroutine and there is nobody to stream to.
			ShouldStop: func() bool { return false },
		})
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return false
		}
		current = value
		return true
	}
	if !open(sessionID) {
		return 2
	}

	reader := bufio.NewReader(in)
	for {
		fmt.Fprint(out, "> ")
		line, err := reader.ReadString('\n')
		if err != nil && line == "" {
			fmt.Fprintln(out)
			return 0
		}
		text := strings.TrimSpace(line)
		if text == "" {
			continue
		}
		if strings.HasPrefix(text, "/") {
			leave, nextID := handleCommand(current, text, out)
			if leave {
				_ = current.Close()
				return 0
			}
			if nextID != "" {
				_ = current.Close()
				open(nextID)
			}
			continue
		}

		answer, err := current.RunTurn(text)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			continue
		}
		fmt.Fprintln(out, answer)
		fmt.Fprintln(out)
	}
}

// handleCommand runs one slash command. It returns whether to leave, and the id of
// a session to switch to.
func handleCommand(current protocol.Runtime, line string, out io.Writer) (bool, string) {
	fields := strings.Fields(line)
	name := fields[0]
	rest := strings.TrimSpace(strings.TrimPrefix(line, name))
	arguments := strings.Fields(rest)

	switch name {
	case "/exit", "/quit":
		return true, ""

	case "/help":
		printHelp(out)

	case "/new":
		return false, "__new__"

	case "/resume":
		if len(arguments) == 0 {
			printSessions(current, out)
			return false, ""
		}
		return false, arguments[0]

	case "/status":
		fmt.Fprintln(out, renderStatus(current.StatusMessage()))

	case "/tools":
		fmt.Fprintln(out, renderTools(current.ToolsMessage()))

	case "/context":
		fmt.Fprintln(out, renderContext(current.ContextMessage()))

	case "/compact":
		if _, err := current.Compact(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return false, ""
		}
		fmt.Fprintln(out, i18n.T("cmd.compact.waiting"))

	case "/model":
		if len(arguments) == 0 {
			printModels(current, out)
			return false, ""
		}
		ok, message := current.SetModel(arguments[0])
		report(out, ok, message)

	case "/thinking":
		if len(arguments) == 0 {
			fmt.Fprintln(out, i18n.T("thinking.mode",
				"state", i18n.T("thinking.on")))
			return false, ""
		}
		on, known := state.ResolveThinking(arguments[0])
		if !known {
			fmt.Fprintln(out, i18n.T("cmd.thinking.unknown", "rest", arguments[0]))
			return false, ""
		}
		ok, message := current.SetThinking(on)
		report(out, ok, message)

	case "/effort":
		if len(arguments) == 0 {
			fmt.Fprintln(out, i18n.T("effort.current", "effort", strings.Join(state.EffortLevels, " / ")))
			return false, ""
		}
		ok, message := current.SetEffort(arguments[0])
		report(out, ok, message)

	case "/autopilot":
		current.SetAutopilot(true)
		fmt.Fprintln(out, i18n.T("autopilot.report_on"))

	case "/skills":
		fmt.Fprintln(out, i18n.T("skills.empty"))

	case "/audit":
		fmt.Fprintln(out, i18n.T("cmd.audit.line", "path", runtime.RuntimeDir()+"/logs"))

	case "/mcp":
		if len(arguments) >= 2 {
			_, notes := current.MCPMessage(arguments[0], arguments[1:])
			for _, note := range notes {
				fmt.Fprintln(out, note)
			}
			return false, ""
		}
		_, notes := current.MCPMessage("list", nil)
		for _, note := range notes {
			fmt.Fprintln(out, note)
		}

	default:
		fmt.Fprintln(out, i18n.T("cmd.unknown", "name", name))
	}
	return false, ""
}

func report(out io.Writer, ok bool, message string) {
	if ok {
		fmt.Fprintln(out, message)
		return
	}
	fmt.Fprintln(out, message)
}

func printHelp(out io.Writer) {
	fmt.Fprintln(out, i18n.T("help.commands_title"))
	keys := []string{"/new", "/resume", "/status", "/tools", "/context", "/compact",
		"/model", "/thinking", "/effort", "/mcp", "/skills", "/autopilot", "/audit",
		"/exit"}
	sort.Strings(keys)
	for _, key := range keys {
		fmt.Fprintf(out, "  %s\n", key)
	}
}

func printSessions(current protocol.Runtime, out io.Writer) {
	for _, row := range current.SessionSummaries() {
		fmt.Fprintf(out, "  %s  messages=%v steps=%v  %s\n",
			row["session_id"], row["messages"], row["steps"], row["preview"])
	}
}

func printModels(current protocol.Runtime, out io.Writer) {
	fields := current.InitFields()
	catalog, _ := fields["model_catalog"].(map[string]any)
	models, _ := catalog["models"].([]any)
	fmt.Fprintln(out, i18n.T("model.current", "name", fields["model"]))
	fmt.Fprintln(out, i18n.T("list.available"))
	for _, item := range models {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		marker := "  "
		if currentModel, _ := row["current"].(bool); currentModel {
			marker = "● "
		}
		fmt.Fprintf(out, "  %s%s\n", marker, row["id"])
	}
	fmt.Fprintln(out, i18n.T("model.howto"))
}

func renderStatus(message map[string]any) string {
	status, _ := message["status"].(map[string]any)
	if status == nil {
		return i18n.T("status.no_state")
	}
	var builder strings.Builder
	builder.WriteString(i18n.T("status.title") + "\n")

	session, _ := status["session"].(map[string]any)
	if session != nil {
		fmt.Fprintf(&builder, "  %s: %s\n", i18n.T("status.kv.session"), session["id"])
		fmt.Fprintf(&builder, "  %s: %s\n", i18n.T("status.kv.workspace"), session["workspace"])
		fmt.Fprintf(&builder, "  %s: %s\n", i18n.T("status.kv.size"),
			i18n.T("status.session.span",
				"messages", i18n.Tn("status.session.messages", intOf(session["messages"])),
				"steps", i18n.Tn("status.session.steps", intOf(session["steps"]))))
	}

	model, _ := status["model"].(map[string]any)
	if model != nil {
		fmt.Fprintf(&builder, "  %s: %s\n", i18n.T("status.kv.model"), model["current"])
		fmt.Fprintf(&builder, "  %s: %s\n", i18n.T("status.kv.endpoint"), model["base_url"])
	}

	counters, _ := status["counters"].(map[string]any)
	if counters != nil {
		fmt.Fprintf(&builder, "  %s: %v runs · %v model calls · %v tool calls\n",
			i18n.T("status.kv.turns"), counters["runs"], counters["model_calls"], counters["tool_calls"])
	}
	return strings.TrimRight(builder.String(), "\n")
}

func renderTools(message map[string]any) string {
	tools, _ := message["tools"].([]any)
	if len(tools) == 0 {
		return i18n.T("tools.none")
	}
	var builder strings.Builder
	for _, item := range tools {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		disposition, _ := row["disposition"].(string)
		fmt.Fprintf(&builder, "  %-18s %-7s %s\n", row["name"], row["risk"], dispositionText(disposition))
	}
	prefixes, _ := message["granted_prefixes"].([]string)
	if len(prefixes) > 0 {
		builder.WriteString(i18n.T("tools.prefixes", "rules", strings.Join(prefixes, ", ")) + "\n")
	}
	builder.WriteString(i18n.T("tools.footer"))
	return builder.String()
}

func dispositionText(disposition string) string {
	switch disposition {
	case "auto":
		return i18n.T("tools.disposition.auto")
	case "deny":
		return i18n.T("tools.disposition.deny")
	default:
		return i18n.T("tools.disposition.ask")
	}
}

func renderContext(message map[string]any) string {
	context, _ := message["context"].(map[string]any)
	if context == nil || !truthy(context["active"]) {
		return i18n.T("context.none")
	}
	return i18n.T("context.title")
}

func truthy(value any) bool {
	flag, _ := value.(bool)
	return flag
}

func intOf(value any) int {
	switch number := value.(type) {
	case int:
		return number
	case float64:
		return int(number)
	default:
		return 0
	}
}
