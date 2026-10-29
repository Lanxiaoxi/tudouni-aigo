package runtime

import (
	"runtime"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	sshlib "github.com/Lanxiaoxi/tudouni-aigo/internal/ssh"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/terminal"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/usage"
)

// hostTriple maps this machine onto the ripgrep release triple whose build is
// vendored under `tools/vendor/rg/`.
//
// It is a deliberate second table rather than a use of `internal/release`'s
// `Targets`: that package builds archives and must not be imported by the runtime
// (and the runtime must not depend on a build-time concern). The two agree on the
// strings, and `paths` looks the binary up by exactly this name.
func hostTriple() (string, bool) {
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "windows/amd64":
		return "x86_64-pc-windows-msvc", true
	case "linux/amd64":
		return "x86_64-unknown-linux-musl", true
	default:
		return "", false
	}
}

// Booted is what stage one produced: everything that needs the disk and nothing
// that needs a model.
type Booted struct {
	Store *state.SessionStore
	Logs  *audit.JsonlSink
	// Usage is the cross-workspace usage ledger: one append-only file in the
	// user's config directory that every session this process mounts appends
	// its token spend to. Nil when it could not be opened — which is a warning
	// and a panel that says so, never a reason to refuse to run.
	Usage *usage.Ledger
	// Terminals owns this workspace's shells. It lives **here** rather than on a
	// runtime, and that placement is the design's central structural point: a
	// session can be switched, deleted or closed while a shell the person is
	// running keeps going. `Booted` is created once per process and handed to every
	// runtime that process mounts, so session and terminal end up as siblings under
	// the workspace rather than parent and child.
	Terminals *terminal.Manager
	// SSH owns this workspace's remote sessions, and it lives here for exactly the
	// same reason the terminals do. A remote shell is a longer-lived resource than
	// a terminal if anything: reconnecting because somebody switched sessions would
	// drop a half-finished deployment, and the far end would keep the login.
	SSH *sshlib.Manager
}

// Boot makes the directories and opens the two append-only stores.
func Boot() (Booted, error) {
	runtimeDir := paths.WorkspaceRuntimeDir()
	store, err := state.NewSessionStore(runtimeDir + "/sessions")
	if err != nil {
		return Booted{}, err
	}
	logs, err := audit.NewJsonlSink(runtimeDir + "/logs")
	if err != nil {
		return Booted{}, err
	}
	// The ledger follows the user rather than the workspace, so it is opened
	// once per process here and shared by every runtime that gets mounted. Its
	// failure is deliberately not this function's failure: a session with no
	// usage history is still a session, and the panel is the place that says
	// "there is no ledger", the way Memory degrades to "no memory".
	ledger, ledgerErr := usage.NewLedger(usage.LedgerPath())
	if ledgerErr != nil {
		warn("usage ledger unavailable: %v", ledgerErr)
	}
	// The workspace boundary is resolved here, once, so the shells and the file
	// tools are checked against the same object. A failure is fatal rather than a
	// reason to start without one: a terminal with no boundary would be a shell
	// that can be pointed anywhere, which is a worse outcome than not starting.
	terminals, err := terminal.NewManager(paths.WorkspaceDir())
	if err != nil {
		return Booted{}, err
	}
	// The SSH manager takes no workspace: its boundary is the remote host's, and
	// the local directory the agent works in has nothing to do with where a remote
	// command runs. What it does read is the user's own `~/.ssh` configuration,
	// with empty arguments meaning "the real one".
	return Booted{
		Store:     store,
		Logs:      logs,
		Usage:     ledger,
		Terminals: terminals,
		SSH:       sshlib.NewManager("", ""),
	}, nil
}

// PreflightCheck reports what the user has to fix before anything can run.
//
// It exists for one caller and one reason: the TUI. Its parent process does not
// assemble a runtime (the real one lives in the `--runtime-stdio` child), but it
// **has to ask this question before entering the alternate screen**. The alternate
// screen has no scrollback, so a child process's configuration error printed after
// `tea.WithAltScreen()` is a truncated, unscrollable mess — the user is left inside a
// full-screen interface looking at a dead runtime with no readable reason. Asking
// first means the sentence lands on an ordinary terminal, where it can be read and
// scrolled.
//
// A nil return means "nothing to report"; it is not a promise that a turn will
// succeed.
//
// `noHooks` is `--no-hooks`, and it is part of the preflight for the same reason
// every other switch is: the question this asks is "will the runtime start", and the
// answer differs depending on whether the broken file is going to be read at all.
func PreflightCheck(noHooks bool) error {
	catalog, err := state.Load(catalogPath())
	if err != nil {
		return err
	}
	if !catalog.Usable() {
		return &NoModelError{Catalog: catalog}
	}
	if _, err := LoadPermissions(); err != nil {
		return err
	}
	if _, err := LoadWebConfig(); err != nil {
		return err
	}
	if _, _, err := LoadMcpServers(); err != nil {
		return err
	}
	// The hooks file is a start-up error for the same reason the others are, and it
	// is asked **here** as well as in `OpenRuntime` because this is the function
	// that runs before the alternate screen: a config error inside a full-screen
	// interface is a truncated, unscrollable sentence over a dead runtime.
	if _, err := LoadHooks(noHooks); err != nil {
		return err
	}
	return nil
}
