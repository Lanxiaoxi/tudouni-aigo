// Command tudouni is an agent runtime with a terminal interface.
//
// One binary, four jobs:
//
//	tudouni                 the line-oriented REPL
//	tudouni --tui           the full-screen interface
//	tudouni --runtime-stdio the protocol endpoint a front end starts as a child
//	tudouni --audit …       the read-only subcommands
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
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/config"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/frontends/cli"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/frontends/tui"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/runtime"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/skills"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/version"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

type options struct {
	tui           bool
	stdio         bool
	session       string
	showList      bool
	showSkills    bool
	showAudit     bool
	showHist      bool
	autopilot     bool
	stream        bool
	noStream      bool
	debug         bool
	maxSteps      int
	showVer       bool
	helpRequested bool
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

	if opts.tui {
		return tui.Run(tui.Options{
			SessionID: opts.session,
			Autopilot: opts.autopilot,
			Stream:    opts.stream,
			Debug:     opts.debug,
			MaxSteps:  opts.maxSteps,
		})
	}
	if opts.stdio {
		return protocol.Main(func(sessionID string, hooks protocol.RuntimeHooks) (protocol.Runtime, error) {
			return openRuntime(booted, sessionID, hooks, opts)
		}, func() []map[string]any {
			return runtime.SessionSummaries(booted.Store, runtime.SessionListLimit)
		}, opts.session, opts.autopilot, opts.stream, opts.debug)
	}

	return cli.Run(cli.Options{
		Booted:    booted,
		SessionID: opts.session,
		Autopilot: opts.autopilot,
		Stream:    opts.stream,
		Debug:     opts.debug,
		MaxSteps:  opts.maxSteps,
		Open: func(sessionID string, hooks protocol.RuntimeHooks) (protocol.Runtime, error) {
			return openRuntime(booted, sessionID, hooks, opts)
		},
	})
}

func parse(argv []string) (options, error) {
	opts := options{stream: true, maxSteps: runtime.DefaultMaxSteps()}

	flags := flag.NewFlagSet("tudouni", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	flags.Usage = func() { fmt.Fprint(os.Stdout, usageText()) }

	flags.BoolVar(&opts.tui, "tui", false, "full-screen interface")
	flags.BoolVar(&opts.stdio, "runtime-stdio", false, "speak the JSONL protocol on stdin/stdout")
	flags.StringVar(&opts.session, "session", "", "session id (a new one is created when it does not exist)")
	flags.BoolVar(&opts.showList, "list", false, "list saved sessions and exit")
	flags.BoolVar(&opts.showSkills, "skills", false, "list the skills this workspace offers and exit")
	flags.BoolVar(&opts.showAudit, "audit", false, "print the audit log of a session and exit")
	flags.BoolVar(&opts.showHist, "history", false, "print a session's messages and exit")
	flags.BoolVar(&opts.autopilot, "autopilot", false, "do not ask for approval (the audit records every release)")
	flags.BoolVar(&opts.stream, "stream", true, "stream the answer as it is written")
	flags.BoolVar(&opts.noStream, "no-stream", false, "do not stream")
	flags.BoolVar(&opts.debug, "debug", false, "print what goes to the model")
	flags.IntVar(&opts.maxSteps, "max-steps", runtime.DefaultMaxSteps(), "how many model calls one turn may take")
	flags.BoolVar(&opts.showVer, "version", false, "print the version and exit")

	if err := flags.Parse(argv); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			// Asking for help is not an error, and printing a complaint after the
			// usage text makes it look like one.
			return options{showVer: false, helpRequested: true}, nil
		}
		return opts, err
	}
	return opts, nil
}

func usageText() string {
	return strings.Join([]string{
		"tudouni — an agent runtime for the terminal",
		"",
		"  tudouni                     the line-oriented REPL",
		"  tudouni --tui               the full-screen interface",
		"  tudouni --runtime-stdio     speak the JSONL protocol on stdin/stdout",
		"",
		"  --session <id>    use (or create) a session with this id",
		"  --list            list saved sessions",
		"  --skills          list this workspace's skills",
		"  --audit           print a session's audit log",
		"  --history         print a session's messages",
		"  --autopilot       do not ask for approval",
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

	// The two channels the runtime uses to reach a person. In `--runtime-stdio`
	// mode the protocol server replaces them; here they are the terminal itself.
	channels := cli.Channels(opts.autopilot)

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

func showSkills() int {
	catalog := skills.NewLoader().Reload()

	if len(catalog.Skills) == 0 {
		fmt.Println(i18n.T("skills.empty"))
	} else {
		fmt.Println(i18n.T("skills.title"))
		for _, line := range skills.CatalogEntries(catalog) {
			fmt.Println("  " + line)
		}
	}
	// Provenance always prints: the user-level directories sit outside the
	// workspace, so nobody thinks to look there — and a shadowed copy is worse,
	// because it exists on disk and does not count.
	for _, line := range skills.SourceLines(catalog) {
		fmt.Println(line)
	}
	// Problems are data, not errors: one malformed file must not stop the scan,
	// and it must not be silent either.
	for _, problem := range catalog.Problems {
		fmt.Fprintln(os.Stderr, skills.RenderProblem(problem))
	}
	return 0
}

func listSessions() int {
	booted, err := runtime.Boot()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	rows := runtime.SessionSummaries(booted.Store, runtime.SessionListLimit)
	if len(rows) == 0 {
		fmt.Println(i18n.T("session_dialog.empty"))
		return 0
	}
	for _, row := range rows {
		fmt.Printf("%s  messages=%v steps=%v  %s\n",
			row["session_id"], row["messages"], row["steps"], row["preview"])
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
		for _, message := range session.Messages {
			role, _ := message["role"].(string)
			text, _ := state.MessageText(message)
			fmt.Printf("--- %s ---\n%s\n", role, text)
		}
		return 0
	}

	records, err := booted.Logs.Read(sessionID)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if len(records) == 0 {
		fmt.Println("no audit records for this session")
		return 0
	}
	for _, record := range records {
		fmt.Println(audit.FormatLine(record))
	}
	return 0
}
