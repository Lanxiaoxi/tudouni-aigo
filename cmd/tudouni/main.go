// Command tudouni-aigo is an agent runtime with a terminal interface.
//
// One binary, four jobs:
//
//	tudouni-aigo                 the full-screen interface
//	tudouni-aigo --cli           the line-oriented REPL
//	tudouni-aigo --runtime-stdio the protocol endpoint a front end starts as a child
//	tudouni-aigo --audit …       the read-only subcommands
//
// `--runtime-stdio` is not an implementation detail of the TUI. It is the same
// entry point a web front end or a test harness would use, and keeping it public
// is what makes the protocol a boundary rather than a formality.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/config"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/context"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/frontends/cli"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/frontends/tui"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/runtime"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/skills"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/version"

	"golang.org/x/term"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

type options struct {
	tui           bool
	cli           bool
	stdio         bool
	session       string
	showList      bool
	showSkills    bool
	showAudit     bool
	showHist      bool
	autopilot     bool
	stream        bool
	streamSet     bool
	noStream      bool
	debug         bool
	maxSteps      int
	showVer       bool
	helpRequested bool
	ericai        bool
	theme         string
	quiet         bool
}

func run(argv []string) int {
	// The missing-key report is the only place a person sees an i18n typo, so it
	// goes to stderr rather than being swallowed.
	i18n.ReportMissing(func(text string) { fmt.Fprintln(os.Stderr, text) })

	opts, err := parse(argv)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if opts.helpRequested {
		return 0
	}

	if opts.showVer {
		fmt.Println(version.Describe())
		return 0
	}
	if opts.showSkills {
		return showSkills()
	}
	if opts.showList {
		return listSessions()
	}
	if opts.showAudit || opts.showHist {
		return showAudit(opts.session, opts.showHist)
	}

	// The token check happens before any interface starts, because its whole
	// purpose is to keep a stale JWT from surfacing mid-session. It prints its
	// own verdict to stderr and never blocks start-up.
	if opts.ericai {
		fmt.Fprintln(os.Stderr, runtime.EnsureEricAI())
	}

	// The workspace check runs before anything else can go wrong. read_file needs
	// no approval, so starting in the home directory would hand over .ssh, other
	// projects' .env files and browser data without anybody being asked twice.
	if err := checkWorkspace(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if opts.session != "" && !state.IsValidSessionID(opts.session) {
		fmt.Fprintln(os.Stderr, i18n.T("check.session_id.invalid",
			"name", opts.session, "dir", paths.RuntimeDirName))
		return 2
	}

	if opts.noStream {
		opts.stream = false
	}

	booted, err := runtime.Boot()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}

	// Which interface this run gets. The rules live in `useFullScreen` so that the
	// precedence can be tested without a terminal.
	if useFullScreen(opts, interactiveTerminal()) {
		// **Before the alternate screen takes over.** The TUI's parent does not
		// assemble a runtime — the real one is the `--runtime-stdio` child — but a
		// configuration problem has to be reported on an ordinary terminal: the
		// alternate screen has no scrollback, so the child's error would arrive as a
		// truncated, unscrollable mess over a dead interface. Asking here is what
		// makes that sentence readable.
		if err := runtime.PreflightCheck(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		// The TUI streams unless told otherwise. `--no-stream` wins over `--stream`
		// (a contradictory command line resolves toward the quieter behaviour, which
		// is the one that cannot surprise anybody).
		tuiStream := true
		if opts.noStream {
			tuiStream = false
		}
		return tui.Run(tui.Options{
			SessionID: opts.session,
			Autopilot: opts.autopilot,
			Stream:    tuiStream,
			Debug:     opts.debug,
			MaxSteps:  opts.maxSteps,
			Theme:     opts.theme,
			Quiet:     opts.quiet,
		})
	}
	if opts.stdio {
		return protocol.Main(func(sessionID string, hooks protocol.RuntimeHooks) (protocol.Runtime, error) {
			return openRuntime(booted, sessionID, hooks, opts)
		}, func() []map[string]any {
			return runtime.SessionSummaries(booted.Store, runtime.SessionListLimit)
		}, opts.session, opts.autopilot, opts.stream, opts.debug)
	}

	// The line REPL cannot stream, and saying so beats silently eating the flag: to
	// someone who typed `--stream`, "the argument was quietly dropped" and "that
	// argument does not exist" look exactly alike, and next time they will conclude
	// the model does not support it.
	if opts.stream {
		fmt.Fprintln(os.Stderr, i18n.T("notice.cli.no_stream"))
	}
	if opts.quiet {
		fmt.Fprintln(os.Stderr, i18n.T("notice.cli.quiet_tui_only"))
	}

	return cli.Run(cli.Options{
		Booted:    booted,
		SessionID: opts.session,
		Autopilot: opts.autopilot,
		Stream:    opts.stream,
		Debug:     opts.debug,
		MaxSteps:  opts.maxSteps,
		Err:       os.Stderr,
		Open: func(sessionID string, hooks protocol.RuntimeHooks) (protocol.Runtime, error) {
			return openRuntime(booted, sessionID, hooks, opts)
		},
	})
}

// interactiveTerminal reports whether both ends of this process are a terminal.
//
// **Both**, not just one. The full-screen interface reads keys from stdin and draws
// on stdout, and a run where only half of that is true cannot work: a redirected
// stdout collects escape sequences nobody can read, and a piped stdin answers every
// keystroke with EOF.
//
// This is what keeps the line REPL's stdout contract intact now that the other
// interface is the default. It is a check rather than a flag because the person who
// needs it is the one who did not know there was anything to choose: `> chat.txt`
// and `| head` are not ways of asking for an interface.
func interactiveTerminal() bool {
	return term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stdout.Fd()))
}

// useFullScreen reports whether this run draws the full-screen interface instead of
// the line REPL.
//
// **The full-screen interface is the default**, because that is what somebody typing
// the program's name is asking for; `--cli` asks for the REPL back. The one fact
// passed in — whether both ends of the process are a terminal — is not a nicety:
// `tudouni-aigo > chat.txt` and `echo hi | tudouni-aigo` are the line REPL's
// documented contract, and a full-screen program on a pipe is not a smaller version of
// that, it either fails to start or writes escape sequences into the redirected file.
// So a bare invocation falls back to the REPL when either end is not a terminal, while
// an explicit `--tui` is honoured either way: it means what it says, and every note
// written before this default changed relies on it.
//
// The rules are a function of the flags rather than a chain of `if`s in `run` because
// each combination below is something a person can type, two of them are
// contradictions, and the order they resolve in is the whole behaviour.
func useFullScreen(opts options, terminal bool) bool {
	switch {
	case opts.cli:
		// A contradiction (`--cli --tui`) resolves toward the quieter interface, the
		// same way `--no-stream` beats `--stream`.
		return false
	case opts.tui:
		return true
	case opts.stdio:
		// A protocol endpoint rather than an interface: the parent owns the terminal,
		// and nothing here draws on it.
		return false
	default:
		return terminal
	}
}

func parse(argv []string) (options, error) {
	opts := options{maxSteps: runtime.DefaultMaxSteps()}

	flags := flag.NewFlagSet(version.Name, flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	flags.Usage = func() { fmt.Fprint(os.Stdout, usageText()) }

	flags.BoolVar(&opts.tui, "tui", false, "force the full-screen interface (it is the default on a terminal)")
	flags.BoolVar(&opts.cli, "cli", false, "use the line-oriented REPL instead of the full-screen interface")
	flags.BoolVar(&opts.stdio, "runtime-stdio", false, "speak the JSONL protocol on stdin/stdout")
	flags.StringVar(&opts.session, "session", "", "session id (a new one is created when it does not exist)")
	flags.BoolVar(&opts.showList, "list", false, "list saved sessions and exit")
	flags.BoolVar(&opts.showSkills, "skills", false, "list the skills this workspace offers and exit")
	flags.BoolVar(&opts.showAudit, "audit", false, "print the audit log of a session and exit")
	flags.BoolVar(&opts.showHist, "history", false, "print a session's messages and exit")
	flags.BoolVar(&opts.autopilot, "autopilot", false, "do not ask for approval (the audit records every release)")
	// The two stream flags default to **off**, and the asymmetry is deliberate: the
	// line REPL must hand back one whole answer so that `tudouni-aigo > chat.txt`
	// stays a clean transcript, while the full-screen interface streams unless told
	// otherwise (see below).
	flags.BoolVar(&opts.stream, "stream", false, "stream the answer as it is written")
	flags.BoolVar(&opts.noStream, "no-stream", false, "do not stream")
	flags.BoolVar(&opts.debug, "debug", false, "print what goes to the model")
	flags.IntVar(&opts.maxSteps, "max-steps", runtime.DefaultMaxSteps(), "how many model calls one turn may take")
	flags.BoolVar(&opts.showVer, "version", false, "print the version and exit")
	flags.BoolVar(&opts.ericai, "ericai", false, "check the EricAI token at start-up and refresh it when it is near expiry")
	flags.StringVar(&opts.theme, "theme", "", "start-up theme: deep clear (default), amber, pink violet — /theme changes it later")
	flags.BoolVar(&opts.quiet, "quiet", false, "start in quiet mode: one line per tool call — /quiet toggles it later")

	if err := flags.Parse(argv); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			// Asking for help is not an error, and printing a complaint after the
			// usage text makes it look like one.
			return options{showVer: false, helpRequested: true}, nil
		}
		return opts, err
	}
	// The two stream flags have to stay distinguishable: `--stream` explicitly asked
	// for streaming, and the line REPL cannot deliver it (see the notice in Run).
	flags.Visit(func(f *flag.Flag) {
		if f.Name == "stream" {
			opts.streamSet = true
		}
	})
	return opts, nil
}

func usageText() string {
	return strings.Join([]string{
		version.Name + " — an agent runtime for the terminal",
		"",
		// The three jobs are padded from `version.Name` rather than typed out: the
		// help, the flag set's name and the archive's contents all have to agree,
		// and a name that is right in two of the three is a name nobody can run.
		fmt.Sprintf("  %-30s %s", version.Name, "the full-screen interface (the default on a terminal)"),
		fmt.Sprintf("  %-30s %s", version.Name+" --cli", "the line-oriented REPL (what a pipe gets)"),
		fmt.Sprintf("  %-30s %s", version.Name+" --runtime-stdio", "speak the JSONL protocol on stdin/stdout"),
		"",
		"  --cli             the line-oriented REPL, not the full-screen interface",
		"  --tui             force the full-screen interface",
		"  --session <id>    use (or create) a session with this id",
		"  --list            list saved sessions",
		"  --skills          list this workspace's skills",
		"  --audit           print a session's audit log",
		"  --history         print a session's messages",
		"  --autopilot       do not ask for approval",
		"  --ericai          refresh the EricAI token at start-up when it is near expiry",
		"  --theme <name>    start-up theme: deep clear (default), amber, pink violet",
		"  --quiet           start in quiet mode: one line per tool call",
		"  --stream/--no-stream",
		"  --debug           print what goes to the model",
		"  --max-steps <n>   how many model calls one turn may take",
		"  --version",
		"",
		"Configuration lives in " + config.ConfigFile() + " (there is no environment variable to set).",
		"",
	}, "\n")
}

// openRuntime is the single place a runtime is assembled, shared by every front
// end. Keeping it in one function is what makes "the REPL and the TUI run the same
// thing" true rather than aspirational.
func openRuntime(booted runtime.Booted, sessionID string,
	hooks protocol.RuntimeHooks, opts options) (*runtime.Runtime, error) {

	session, resumed, err := runtime.ResolveSession(booted.Store, sessionID)
	if err != nil {
		return nil, err
	}

	// The two channels the runtime uses to reach a person.
	//
	// **They come from the front end when there is one.** `--runtime-stdio` puts the
	// front end on the other end of a pipe, so the approval and the question have to
	// travel as protocol messages; only the in-process front ends ask on this
	// terminal. Getting this wrong is not "a missing feature": the TUI draws its
	// approval panel while the child prints the same prompt on stderr underneath it,
	// and waits on a stdin that is a pipe the front end owns — so the prompt can
	// never be answered and the turn never finishes.
	//
	// That is why the fallback below is **not** the terminal one in stdio mode. It
	// used to be, which made a missing field in the protocol layer's own supply into
	// exactly the failure described above: an asker reading the front end's pipe as if
	// it were a person's keyboard, swallowing protocol lines as approvals. An empty
	// `Channels` fails closed instead — `security.Check` refuses anything needing
	// approval when there is no way to ask — which is the direction that cannot be
	// wrong. `serve.go` supplies both, so this branch is a second line of defence
	// rather than a path anything takes.
	channels := hooks.Channels
	switch {
	case channels.AskerFactory != nil && channels.Questioner != nil:
	case opts.stdio:
		channels = protocol.Channels{}
	default:
		channels = cli.Channels(opts.autopilot, os.Stdin, os.Stderr)
	}

	value, err := runtime.OpenRuntime(runtime.Options{
		Booted:      booted,
		Session:     session,
		Channels:    channels,
		Autopilot:   opts.autopilot,
		Debug:       opts.debug,
		Stream:      opts.stream,
		MaxSteps:    opts.maxSteps,
		Resumed:     resumed,
		ShouldStop:  hooks.ShouldStop,
		OnDelta:     hooks.OnDelta,
		OnEventHook: hooks.OnEvent,
	})
	if err != nil {
		var noModel *runtime.NoModelError
		if errors.As(err, &noModel) {
			return nil, fmt.Errorf("%s", noModelMessage(noModel.Catalog))
		}
		return nil, err
	}
	return value, nil
}

// noModelMessage explains a missing model in a way the user can act on.
//
// The template is copied to the default location only at this moment, not on every
// start: a deployment that supplies its configuration another way should not have a
// file appear in its home directory every time it runs.
func noModelMessage(catalog state.Registry) string {
	var builder strings.Builder
	builder.WriteString(i18n.T("no_model.missing",
		"config", config.ConfigFile(), "example", config.ExampleFile()))
	if written := config.Scaffold(); written != "" {
		builder.Reset()
		builder.WriteString(i18n.T("no_model.created", "path", written))
	}
	builder.WriteString("\n")
	builder.WriteString(i18n.T("no_model.intro"))
	builder.WriteString("\n")
	builder.WriteString(i18n.T("no_model.route_fields"))
	builder.WriteString("\n\n")
	if len(catalog.Problems) > 0 {
		builder.WriteString(i18n.T("no_model.problems"))
		builder.WriteString("\n")
		for _, problem := range catalog.Problems {
			builder.WriteString("  - " + problem + "\n")
		}
	}
	return builder.String()
}

func checkWorkspace() error {
	kind := paths.UnsafeWorkspace(paths.WorkspaceDir())
	if kind == paths.WorkspaceOK {
		return nil
	}
	var what string
	switch kind {
	case paths.WorkspaceIsHome:
		what = i18n.T("check.workspace.home", "here", paths.WorkspaceDir())
	case paths.WorkspaceIsRoot:
		what = i18n.T("check.workspace.root", "here", paths.WorkspaceDir())
	default:
		what = i18n.T("check.workspace.above_home", "here", paths.WorkspaceDir())
	}
	return errors.New(i18n.T("check.workspace.refused", "what", what))
}

// showSkills prints what this workspace offers and why some file did not make it.
//
// Two things, matching the two things a person can act on:
//
//   - the skills that were recognised — name, body size, declared tools, and that
//     one-line description. The description is **the only thing the model has** for
//     judging when to use the skill, so whether it is any good is visible here and
//     nowhere else;
//   - the ones that were skipped, each with its file and its specific fault. This is
//     the most valuable half: a file with broken frontmatter produces no symptom
//     from start-up to shutdown — it is simply **absent** from the list the model
//     sees, and if it is not reported here nobody ever learns which file to fix.
//
// The body size is worth showing because it decides the cost of every later request
// (the body is spliced into each one): "is this skill worth 3000 characters" is a
// question skill authors actually ask.
func showSkills() int {
	loader := skills.NewLoader()
	catalog := loader.Reload()

	// Directories lowest priority first, with the ones that **actually exist**
	// marked: the user-level directories sit outside the workspace, so nobody thinks
	// to look there — and "which of them is missing" is exactly the answer to "where
	// do I create one".
	fmt.Println(i18n.T("skills.dirs.header"))
	scanned := map[string]bool{}
	for _, root := range catalog.Existing {
		scanned[root] = true
	}
	for _, root := range loader.Roots {
		mark := " "
		if scanned[root] {
			mark = "✓"
		}
		fmt.Println(i18n.T("skills.dirs.row", "mark", mark, "path", root))
	}

	if len(catalog.Skills) == 0 {
		fmt.Println()
		fmt.Println(i18n.T("skills.empty.howto"))
	} else {
		fmt.Println()
		fmt.Println(i18n.T("skills.available", "n", len(catalog.Skills)))
		nameWidth, charsWidth := 0, 0
		for _, skill := range catalog.Skills {
			if len(skill.Name) > nameWidth {
				nameWidth = len(skill.Name)
			}
			if width := len(strconv.Itoa(skill.BodyChars())); width > charsWidth {
				charsWidth = width
			}
		}
		for _, skill := range catalog.Skills {
			declared := i18n.T("skills.row.no_tools")
			if len(skill.AllowedTools) > 0 {
				declared = strings.Join(skill.AllowedTools, i18n.T("list.separator"))
			}
			fmt.Printf("  %-*s  %s\n", nameWidth, skill.Name,
				i18n.T("skills.row.body",
					"chars", fmt.Sprintf("%*d", charsWidth, skill.BodyChars()),
					"tools", declared))
			pad := strings.Repeat(" ", nameWidth+2)
			fmt.Printf("  %s%s\n", pad, skill.Description)
			fmt.Printf("  %s%s\n", pad, skill.Path)
		}
	}

	for _, item := range catalog.Shadowed {
		fmt.Println(i18n.T("skills.line.skipped", "item", skills.RenderProblem(item)))
	}
	// Problems go to stdout here, not stderr: they are part of what this command
	// was asked to print, and splitting one list across two streams makes `--skills`
	// useless the moment somebody redirects it.
	for _, problem := range catalog.Problems {
		fmt.Println(i18n.T("skills.line.skipped", "item", skills.RenderProblem(problem)))
	}
	return 0
}

// listSessions prints the saved sessions, newest first.
//
// The task column is why this command exists in the shape it does: the list lives in
// the session file, so "which session still has work left in it" is a fact you get
// by reading one file — and it is one of the things somebody actually wants to know
// when picking a session to resume.
func listSessions() int {
	booted, err := runtime.Boot()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	// Delegated subagents keep their sessions in the same store, and they are not
	// sessions a person resumes: each one belongs to a task that is already over.
	// The list is what somebody picks from, so it shows the sessions they started.
	ids := booted.Store.ListParentIDs()
	if len(ids) == 0 {
		fmt.Println(i18n.T("sessions.list.empty"))
		return 0
	}
	fmt.Println(i18n.T("sessions.list.header", "n", len(ids), "dir", booted.Store.Dir()))

	type sessionRow struct {
		id     string
		loaded bool
		count  int
		steps  int
		todos  string
	}
	rows := make([]sessionRow, 0, len(ids))
	nameWidth, countWidth := 0, 0
	for _, id := range ids {
		row := sessionRow{id: id}
		if session, err := booted.Store.Load(id); err == nil {
			row.loaded = true
			row.count = len(session.Messages)
			row.steps = session.StepCount()
			if line := builtin.NewTodoBoard(session.Metadata).ProgressLine(); line != "" {
				row.todos = i18n.T("sessions.list.todos", "line", line)
			}
		}
		if len(id) > nameWidth {
			nameWidth = len(id)
		}
		if width := len(strconv.Itoa(row.count)); width > countWidth {
			countWidth = width
		}
		rows = append(rows, row)
	}

	for _, row := range rows {
		// A file that cannot be read stays on the list, named but bare: dropping it
		// would hide a real problem, and "why is one session gone" has no answer then.
		if !row.loaded {
			fmt.Println("  " + row.id)
			continue
		}
		fmt.Println("  " + i18n.T("sessions.list.row",
			"name", fmt.Sprintf("%-*s", nameWidth, row.id),
			"messages", fmt.Sprintf("%*d", countWidth, row.count),
			"steps", row.steps,
			"todos", row.todos))
	}
	return 0
}

func showAudit(sessionID string, history bool) int {
	if sessionID == "" {
		fmt.Fprintln(os.Stderr, "this subcommand needs --session <id>")
		return 2
	}
	booted, err := runtime.Boot()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}

	if history {
		session, err := booted.Store.Load(sessionID)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		printHistory(session)
		return 0
	}

	records, err := booted.Logs.Read(sessionID)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if len(records) == 0 {
		fmt.Println(i18n.T("audit.no_records", "name", sessionID, "dir", booted.Logs.Dir()))
		return 0
	}
	fmt.Println(i18n.T("audit.header", "name", sessionID, "n", len(records)))
	fmt.Println(strings.Repeat("-", 78))
	for _, record := range records {
		fmt.Println(audit.FormatLine(record))
	}
	fmt.Println(audit.Summarize(records))
	return 0
}

// printHistory prints what happened in a session, one row per message.
//
// Bodies are previews only: history can hold hundreds of thousands of characters of
// file content, and this command is for "what happened", not "print those megabytes
// again".
//
// A tool message whose body became an Artifact holds only a reference
// (`[artifact art_xxx · 12480 chars · read_file]`), which on its own is unreadable —
// so the artifact note says what that reference points at: how big it is, which file
// or URL it came from, and whether the body is still there. It reads the **index on
// disk**, never the body, which is the whole point of the reference.
//
// An unreadable index degrades to one sentence rather than failing: `--history` is a
// troubleshooting command, and it must not fall over because a different directory
// is missing.
func printHistory(session *state.Session) {
	fmt.Println(i18n.T("history.header",
		"name", session.SessionID,
		"messages", len(session.Messages),
		"steps", session.StepCount()))
	fmt.Println(strings.Repeat("-", 72))

	store := context.OpenArtifactStore(paths.SessionArtifactsDir(session.SessionID), nil)
	indexFailed := false
	if problems := store.Load(); len(problems) > 0 {
		indexFailed = true
	}

	for index, message := range session.Messages {
		role, _ := message["role"].(string)
		content, _ := message["content"].(string)
		preview := clipFlat(content, historyPreviewChars)
		prefix := fmt.Sprintf("%3d %-9s ", index, role)

		switch role {
		case "assistant":
			if preview != "" {
				fmt.Println(prefix + preview)
			}
			for _, call := range toolCallsOf(message) {
				fmt.Println(prefix + i18n.T("history.tool_call",
					"name", call.Name,
					"arguments", clipFlat(call.Arguments, historyArgsChars)))
			}
		case "tool":
			fmt.Println(prefix + i18n.T("history.tool_result", "preview", preview))
			if detail := artifactNote(store, indexFailed, message); detail != "" {
				fmt.Println(strings.Repeat(" ", len(prefix)) + "  " + detail)
			}
		default:
			fmt.Println(prefix + i18n.T("history.entry", "preview", preview))
		}
	}
}

// Limits on the previews. 76 characters is about one terminal line with the index
// and role columns in front of it.
const (
	historyPreviewChars = 76
	historyArgsChars    = 64
)

// artifactNote is the one-line summary of the artifact a tool message points at.
func artifactNote(store *context.ArtifactStore, indexFailed bool, message map[string]any) string {
	artifactID := context.ArtifactIDOf(message)
	if artifactID == "" {
		return ""
	}
	if indexFailed {
		return i18n.T("history.artifact.blind", "id", artifactID)
	}
	artifact, ok := store.Get(artifactID)
	if !ok {
		return i18n.T("history.artifact.gone", "id", artifactID)
	}
	where := ""
	if metadata := artifact.Metadata; metadata != nil {
		if path, _ := metadata["path"].(string); path != "" {
			where = path
		}
		if lines, ok := metadata["lines"]; ok && where != "" {
			where += fmt.Sprintf(", %v lines", lines)
		}
	}
	suffix := ""
	if where != "" {
		suffix = ", " + where
	}
	return i18n.T("history.artifact.note",
		"id", artifactID, "chars", artifact.Chars,
		"suffix", suffix, "content_ref", artifact.ContentRef)
}

// clipFlat flattens a body to one line and shortens it, so a single long value
// cannot take over the screen. Flattening is lossless: a newline becomes `\n`.
func clipFlat(text string, limit int) string {
	flat := strings.ReplaceAll(text, "\n", "\\n")
	runes := []rune(flat)
	if limit <= 0 || len(runes) <= limit {
		return flat
	}
	return string(runes[:limit])
}

// toolCallsOf reads the tool calls out of an assistant message.
func toolCallsOf(message map[string]any) []model.ToolCall {
	raw, _ := message["tool_calls"].([]any)
	out := make([]model.ToolCall, 0, len(raw))
	for _, item := range raw {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		function, _ := entry["function"].(map[string]any)
		call := model.ToolCall{}
		call.ID, _ = entry["id"].(string)
		call.Name, _ = function["name"].(string)
		call.Arguments, _ = function["arguments"].(string)
		if call.Name != "" {
			out = append(out, call)
		}
	}
	return out
}
