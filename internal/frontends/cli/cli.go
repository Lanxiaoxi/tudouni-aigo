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
	"os/signal"
	"sort"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/frontends"
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
	Err io.Writer
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

// emitNotices prints the assembly's start-up notices, each on **its own stream**.
//
// One pass dispatching on the notice's own `stream` field, rather than two passes
// (all of stdout, then all of stderr): two passes would reorder the two relative to
// each other, and both the terminal and a redirected transcript depend on that
// order.
//
// These lines are not decoration. Everything here is something this program found
// out that the user cannot see from the outside — a route with no key, a rule naming
// a tool that does not exist, background commands from a killed session that may
// still be running — and the previous generation's rule was that a silent downgrade
// of a guarantee is a lie of omission.
func emitNotices(current protocol.Runtime, out, diag io.Writer) {
	fields := current.InitFields()
	notices, _ := fields["notices"].([]any)
	for _, item := range notices {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		text, _ := record["text"].(string)
		if text == "" {
			continue
		}
		target := out
		if stream, _ := record["stream"].(string); stream != "out" {
			target = diag
		}
		fmt.Fprintln(target, text)
	}
}

// exitWords leave the session. The previous generation also treated an empty line
// as "leave", and both words are the ones its help text promised.
func isExitWord(text string) bool {
	switch strings.ToLower(strings.TrimSpace(text)) {
	case "exit", "quit":
		return true
	}
	return false
}

// Run drives the REPL until the user leaves.
//
// **stdout carries the conversation and nothing else.** The prompt, the version
// line, the notices and every answer to a `/` command go to stderr, because
// `tudouni > chat.txt` is a documented contract: the file has to contain what the
// user asked and what the model answered, not the plumbing around it. Mixing them
// is the kind of thing that looks harmless on a terminal and ruins the only way to
// keep a transcript.
func Run(options Options) int {
	in := options.In
	if in == nil {
		in = os.Stdin
	}
	out := options.Out
	if out == nil {
		out = os.Stdout
	}
	diag := options.Err
	if diag == nil {
		diag = os.Stderr
	}

	// The session's identity is *content* — it is what the user needs to know to
	// come back — so it goes to stdout, like the previous generation did.
	fmt.Fprintln(out, version.Describe())

	var current protocol.Runtime
	sessionID := options.SessionID

	open := func(id string) bool {
		value, err := options.Open(id, protocol.RuntimeHooks{
			// The REPL is in-process, so a turn is never interrupted from another
			// goroutine, and there is nobody to stream to: writing the answer in
			// pieces is what a redirected transcript must not contain.
			ShouldStop: func() bool { return false },
		})
		if err != nil {
			fmt.Fprintln(diag, err)
			return false
		}
		current = value
		return true
	}
	if !open(sessionID) {
		return 2
	}

	// The assembly's own notices, then the audit line — the previous generation's
	// order, kept because `> 对话.txt` and what somebody saw on the terminal both
	// depend on it.
	emitNotices(current, out, diag)
	fmt.Fprintf(out, "%s\n\n", i18n.T("notice.audit_line", "path", runtime.RuntimeDir()+"/logs"))

	// Closing the runtime has to happen on **every** way out, not only the polite
	// one. A runtime owns child processes — MCP servers it mounted, background
	// commands it started — and leaving them behind produces the symptom this
	// program's own notes call out: a port still held by something nobody can name,
	// because "address already in use" points at no session.
	closeRuntime := func() {
		if current != nil {
			_ = current.Close()
		}
	}
	defer closeRuntime()

	// Ctrl+C at the prompt is the documented way out of a line terminal, and the
	// default disposition would kill this process without running any of the above.
	// The signal is turned into an ordinary exit so the deferred close still runs.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt)
	defer signal.Stop(signals)
	go func() {
		<-signals
		closeRuntime()
		os.Exit(0)
	}()

	reader := bufio.NewReader(in)
	for {
		fmt.Fprint(diag, "> ")
		line, err := reader.ReadString('\n')
		if err != nil && line == "" {
			fmt.Fprintln(diag)
			return 0
		}
		text := strings.TrimSpace(line)
		// An empty line is the previous generation's "leave", and it is also what a
		// stray Enter at the prompt means to most people.
		if text == "" || isExitWord(text) {
			return 0
		}
		if strings.HasPrefix(text, "/") {
			handled, leave, nextID := handleCommand(current, text, diag)
			if leave {
				return 0
			}
			if nextID != "" {
				closeRuntime()
				open(nextID)
			}
			if handled {
				continue
			}
			// A line that starts with `/` but is not a command the REPL knows is
			// **sent to the model**, not swallowed. A path, a regex or a typo would
			// otherwise be silently discarded — and losing something the user meant
			// to say costs more than one wasted round trip on a typo.
		}

		answer, err := current.RunTurn(text)
		if err != nil {
			fmt.Fprintln(diag, err)
			continue
		}
		fmt.Fprintln(out, answer)
		fmt.Fprintln(out)
		reportTurn(diag, current)
	}
}

// reportTurn is what the line terminal says after each turn.
//
// A line terminal has no permanent panel, so progress has to be re-stated every
// round. All of it goes to stderr: stdout carries the conversation and nothing else.
//
// The task line is the human's view of a list the model sees in full at the end of
// its payload — the same fact, deliberately two renderings, because the model wants
// "what is left, what is in progress" and a person wants "2/5 done" at a glance.
//
// The background line is one notch more important than the task line: a stale task
// list is stale information, while an uncollected background job is **a process still
// running on somebody's machine**, holding a port — and "address already in use"
// contains no clue that the previous session left it there.
func reportTurn(diag io.Writer, current protocol.Runtime) {
	if line := current.ProgressLine(); line != "" {
		fmt.Fprintln(diag, i18n.T("stats.todos", "line", line))
	}
	if line := current.JobsProgressLine(); line != "" {
		fmt.Fprintln(diag, i18n.T("stats.jobs", "line", line))
	}
	if body := current.StatsLine(); body != "" {
		fmt.Fprintln(diag, i18n.T("stats.line",
			"name", current.SessionID(),
			"messages", i18n.Tn("status.session.messages", messageCount(current)),
			"steps", i18n.Tn("status.session.steps", stepCount(current)),
			"body", body))
	}
}

// messageCount and stepCount read the two cumulative figures out of the runtime's
// own state message, so this line and `/status` can never disagree.
func messageCount(current protocol.Runtime) int {
	status, _ := current.StatusMessage()["status"].(map[string]any)
	session, _ := status["session"].(map[string]any)
	return intOf(session["messages"])
}

func stepCount(current protocol.Runtime) int {
	status, _ := current.StatusMessage()["status"].(map[string]any)
	session, _ := status["session"].(map[string]any)
	return intOf(session["steps"])
}

// jobsProgressLine renders the background-job summary, or "" when there is none.

// handleCommand runs one slash command.
//
// It returns whether the line was a command this REPL knows, whether to leave, and
// the id of a session to switch to. The first return matters: an unrecognised `/`
// line has to reach the model, and only the caller can do that.
func handleCommand(current protocol.Runtime, line string, out io.Writer) (bool, bool, string) {
	fields := strings.Fields(line)
	name := fields[0]
	rest := strings.TrimSpace(strings.TrimPrefix(line, name))
	arguments := strings.Fields(rest)

	switch name {
	case "/exit", "/quit":
		return true, true, ""

	case "/help":
		printHelp(out)

	case "/new":
		return true, false, "__new__"

	case "/resume":
		if len(arguments) == 0 {
			printSessions(current, out)
			return true, false, ""
		}
		return true, false, arguments[0]

	case "/status":
		fmt.Fprintln(out, renderStatus(current.StatusMessage()))

	case "/tools":
		fmt.Fprintln(out, frontends.RenderTools(current.ToolsMessage()))

	case "/context":
		fmt.Fprintln(out, frontends.RenderContext(current.ContextMessage()))

	case "/compact":
		result, err := current.Compact()
		if err != nil {
			fmt.Fprintln(out, i18n.T("channels.compact.failed", "problem", err.Error()))
			return true, false, ""
		}
		compaction, _ := result["compaction"].(map[string]any)
		fmt.Fprintln(out, frontends.RenderCompaction(compaction))

	case "/model":
		if len(arguments) == 0 {
			printModels(current, out)
			return true, false, ""
		}
		// The whole remainder goes through: a model name may contain a space, and
		// taking only the first word would silently drop the rest.
		ok, message := current.SetModel(rest)
		report(out, ok, message)
		if !ok {
			// A refused switch lists what there is, which is the next thing the user
			// needs. Printing the error alone leaves them guessing.
			printModels(current, out)
		}

	case "/thinking":
		if len(arguments) == 0 {
			printThinking(current, out, "")
			return true, false, ""
		}
		on, known := state.ResolveThinking(arguments[0])
		if !known {
			// A bad value re-prints the state, so the answer to "then what is it
			// now" is on screen next to the complaint.
			printThinking(current, out, i18n.T("thinking.unknown", "rest", arguments[0]))
			return true, false, ""
		}
		ok, message := current.SetThinking(on)
		report(out, ok, message)

	case "/effort":
		if len(arguments) == 0 {
			printEffort(current, out, "")
			return true, false, ""
		}
		ok, message := current.SetEffort(arguments[0])
		report(out, ok, message)
		if !ok {
			printEffort(current, out, "")
		}

	case "/autopilot":
		current.SetAutopilot(true)
		fmt.Fprintln(out, i18n.T("autopilot.report_on"))

	case "/skills":
		fmt.Fprintln(out, frontends.RenderSkills(current.SkillsMessage()))

	case "/audit":
		fmt.Fprintln(out, i18n.T("cmd.audit.line", "path", runtime.RuntimeDir()+"/logs"))

	case "/mcp":
		action := "list"
		var names []string
		if len(arguments) >= 1 {
			action = arguments[0]
			names = arguments[1:]
		}
		if action != "list" && action != "load" && action != "unload" {
			fmt.Fprintln(out, i18n.T("cmd.mcp.unknown", "rest", rest))
			action, names = "list", nil
		} else if action != "list" && len(names) == 0 {
			fmt.Fprintln(out, i18n.T("cmd.mcp.unknown", "rest", rest))
			action, names = "list", nil
		}
		panel, notes := current.MCPMessage(action, names)
		for _, note := range notes {
			fmt.Fprintln(out, note)
		}
		if panel != nil {
			fmt.Fprintln(out, frontends.RenderMCP(panel))
		}

	default:
		// Not a command: the caller sends the line to the model.
		return false, false, ""
	}
	return true, false, ""
}

// printThinking reports the real state of both knobs.
//
// "on"/"off" alone is the whole answer to one of the two questions the user asked.
// The effort line is printed even while thinking is off, because "did I lose the
// level I set" is the next thing they wonder — and the answer is no.
func printThinking(current protocol.Runtime, out io.Writer, prefix string) {
	if prefix != "" {
		fmt.Fprintln(out, prefix)
	}
	thinking, effort := reasoningOf(current)
	word := i18n.T("thinking.on")
	if !thinking {
		word = i18n.T("thinking.off")
	}
	fmt.Fprintln(out, i18n.T("thinking.mode", "state", word))
	if thinking {
		fmt.Fprintln(out, i18n.T("thinking.effort", "effort", effort))
	} else {
		fmt.Fprintln(out, i18n.T("thinking.effort", "effort", effort)+
			i18n.T("thinking.effort_off_note"))
	}
	fmt.Fprintln(out, i18n.T("thinking.howto"))
}

// printEffort reports the current level and what else can be chosen.
func printEffort(current protocol.Runtime, out io.Writer, prefix string) {
	if prefix != "" {
		fmt.Fprintln(out, prefix)
	}
	thinking, effort := reasoningOf(current)
	line := i18n.T("effort.current", "effort", effort)
	if !thinking {
		line += i18n.T("effort.off_note")
	}
	fmt.Fprintln(out, line)

	levels := effortLevels(current)
	if len(levels) == 0 {
		fmt.Fprintln(out, i18n.T("effort.no_catalog"))
		fmt.Fprintln(out, i18n.T("effort.howto_bare"))
		return
	}
	fmt.Fprintln(out, i18n.T("effort.howto", "levels", strings.Join(levels, " / ")))
}

// reasoningOf reads the two knobs out of the runtime's own init fields, which are
// the same facts `/status` reads. It never guesses: an absent value falls back to
// the documented default rather than to an arbitrary one.
func reasoningOf(current protocol.Runtime) (bool, string) {
	fields := current.InitFields()
	thinking := state.DefaultThinking
	if value, ok := fields["thinking"].(bool); ok {
		thinking = value
	}
	effort := state.DefaultEffort
	if value, ok := fields["effort"].(string); ok && value != "" {
		effort = value
	}
	return thinking, effort
}

// effortLevels is the list the runtime said it offers. An empty list means the
// runtime did not say, which is reported rather than filled in with a guess.
func effortLevels(current protocol.Runtime) []string {
	fields := current.InitFields()
	raw, _ := fields["effort_levels"].([]any)
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok && text != "" {
			out = append(out, text)
		}
	}
	return out
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

// printModels lists the models and says which one is in use.
//
// The name is written `provider/model`, because the same model id can sit on two
// routes and those two rows would otherwise be identical — while which one is
// selected decides which account the request goes to and who gets the bill.
func printModels(current protocol.Runtime, out io.Writer) {
	fields := current.InitFields()
	catalog, _ := fields["model_catalog"].(map[string]any)
	models, _ := catalog["models"].([]any)

	here, _ := fields["model"].(string)
	if provider, _ := fields["provider"].(string); provider != "" {
		here = provider + "/" + here
	}
	if here == "" {
		here = "—"
	}
	fmt.Fprintln(out, i18n.T("model.current", "name", here))

	// The name column is measured, so a longer model id shifts the columns rather
	// than running into the next one.
	names := make([]string, 0, len(models))
	rows := make([]map[string]any, 0, len(models))
	for _, item := range models {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id, _ := row["id"].(string)
		provider, _ := row["provider"].(string)
		if provider != "" {
			id = provider + "/" + id
		}
		names = append(names, id)
		rows = append(rows, row)
	}
	width := 0
	for _, name := range names {
		if len(name) > width {
			width = len(name)
		}
	}

	if len(rows) > 0 {
		fmt.Fprintln(out, i18n.T("list.available"))
	}
	for index, row := range rows {
		marker := " "
		if current, _ := row["current"].(bool); current {
			marker = "●"
		}
		window := ""
		if value, ok := row["window"]; ok && value != nil {
			window = i18n.T("model.window", "window", value)
		}
		label, _ := row["label"].(string)
		summary, _ := row["summary"].(string)
		fmt.Fprintf(out, "  %s %-*s  %s   （%s%s）\n",
			marker, width, names[index], summary, label, window)
		if note, _ := row["note"].(string); note != "" {
			fmt.Fprintf(out, "      %s\n", note)
		}
	}
	// Retired names get their own list: they are **recognised**, not selectable
	// (the endpoint has retired the model and a newer one serves the requests).
	// Putting them in the main list would offer two options with the same effect.
	aliases, _ := catalog["aliases"].([]any)
	for _, item := range aliases {
		alias, ok := item.(map[string]any)
		if !ok {
			continue
		}
		fmt.Fprintln(out, i18n.T("model.aliases",
			"old", alias["id"], "new", alias["of"]))
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
