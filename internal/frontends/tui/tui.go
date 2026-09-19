// Package tui is the full-screen front end.
//
// It is a **client**: it starts the runtime as a child process and talks the JSONL
// protocol to it. That is not an implementation detail — the two are separate
// programs on purpose, and the interface above is one of several the protocol
// allows. The line REPL, a web front end and the tests all speak the same thing.
//
// Two things about a terminal interface drive most of the code here:
//
//   - Width is measured in **cells**, not characters. Model answers, tool output and
//     workspace paths are frequently Chinese, and a CJK character occupies two
//     cells. Getting this wrong does not produce an error; it produces a misaligned
//     screen that looks like a rendering bug in the content.
//   - The interface must never look frozen. Tool execution is silent — there are no
//     incremental events between a call and its result, and a read_file followed by
//     a shell command can take seconds. So every state the interface can be in has
//     a visible line saying so.
package tui

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
)

// Options configures one TUI run.
type Options struct {
	SessionID string
	Autopilot bool
	Stream    bool
	Debug     bool
	MaxSteps  int
	// Theme and Quiet are display preferences set at start-up (--theme, --quiet)
	// and changeable in-session (/theme, /quiet). They never reach the runtime.
	Theme string
	Quiet bool
}

// Run starts the interface and returns the process exit code.
func Run(options Options) int {
	hooks := &bridge{messages: make(chan tea.Msg, 256)}

	client := protocol.NewClient(hooks)
	arguments := []string{}
	if options.SessionID != "" {
		arguments = append(arguments, "--session", options.SessionID)
	}
	if options.Stream {
		arguments = append(arguments, "--stream")
	} else {
		arguments = append(arguments, "--no-stream")
	}
	if options.Autopilot {
		arguments = append(arguments, "--autopilot")
	}
	if options.Debug {
		arguments = append(arguments, "--debug")
	}
	// The limit has to travel with the child, not just sit on the status bar:
	// showing "up to 5 steps" over a runtime allowed forty is a number the user
	// cannot act on.
	if options.MaxSteps > 0 {
		arguments = append(arguments, "--max-steps", fmt.Sprint(options.MaxSteps))
	}

	if err := client.Start(arguments); err != nil {
		fmt.Fprintln(os.Stderr, "cannot start the runtime:", err)
		return 2
	}

	model := newModel(client, hooks, options)
	// **Alt screen only — no mouse reporting, deliberately.** Reporting the mouse
	// would make the wheel work in every terminal, but it also takes drags away
	// from the terminal, so selecting text to copy needs Shift held down. That
	// trade is the wrong way round for this interface: text is what a user takes
	// out of it. Where the terminal translates a wheel notch into arrow keys
	// (Windows Terminal does, in the alternate screen), the log scrolls anyway —
	// see `handleEditorKey`'s Up/Down, which is the one scroll path there is.
	program := tea.NewProgram(model, tea.WithAltScreen())

	hooks.program = program
	if _, err := program.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		client.Kill()
		return 1
	}
	return client.Close()
}

// bridge turns protocol callbacks into Bubble Tea messages.
//
// The runtime's reader calls these from its own goroutine, and Bubble Tea expects
// messages on its own loop, so they cross a channel. The buffer is generous because
// a streamed answer can produce hundreds of increments per second and blocking the
// reader would stall the protocol.
type bridge struct {
	program  *tea.Program
	messages chan tea.Msg
}

func (b *bridge) send(message tea.Msg) {
	if b.program == nil {
		return
	}
	b.program.Send(message)
}

// OnMessage receives everything that does not need an answer.
func (b *bridge) OnMessage(message map[string]any) {
	b.send(serverMessage{payload: message})
}

// OnPermission returns ok=false: the interface answers after the user chooses.
//
// Returning a fallback here instead is the mistake this protocol exists to prevent.
// The client would send it immediately, the runtime would refuse and move on, and by
// the time the user pressed "allow" the answer would have nobody to reach — worse,
// the refusal in between lands in the audit as a decision the user never made.
func (b *bridge) OnPermission(request map[string]any) (string, bool) {
	b.send(permissionAsked{request: request})
	return "", false
}

// OnQuestion returns ok=false for the same reason.
func (b *bridge) OnQuestion(request map[string]any) (string, string, bool) {
	b.send(questionAsked{request: request})
	return "", "", false
}
