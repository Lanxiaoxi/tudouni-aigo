package terminal

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Shell is the program a terminal runs, and how it is named on screen.
//
// The two are separate fields because they are separate facts: `Argv` may carry
// a path with arguments in it, while `Display` is what a person reads in a list
// and what a front end shows in a tab. Keeping one string for both would end up
// either printing flags at a person or launching a command with a friendly name.
type Shell struct {
	Display string
	Argv    []string
}

// defaultShell picks the shell this platform's terminals run.
//
// **The runtime decides this, not the client.** The protocol deliberately has no
// `shell` field: a front end that could name the program to run would be a front
// end that has to know where that program lives on this machine, and the desktop
// and the terminal interface would then disagree about what "a terminal" is.
//
// The choice per platform:
//
//   - Unix: `$SHELL`, falling back to `/bin/sh`. `$SHELL` is the one place the
//     person has already said which shell they want, and honouring it is the
//     difference between a terminal that feels like theirs and one that does not.
//     No arguments are passed: the shell starts interactive and reads its own rc
//     file, which is where a PATH or a prompt is actually configured. Passing `-l`
//     was considered and rejected — it changes which of that person's startup
//     files run, and it is not portable to every shell `$SHELL` might name.
//
//   - Windows: PowerShell 7 (`pwsh`) when it is installed, then Windows
//     PowerShell (`powershell`), then `cmd.exe`. The order is "the newest one
//     that is actually here", and the last fallback is unconditional because a
//     Windows machine without `cmd.exe` is not a machine this program can run on
//     anyway. `-NoLogo` only: the profile is the person's environment and is
//     meant to load — a terminal that skipped it would have a different PATH
//     from every other terminal on the machine, which is a bug that reads as
//     "the build tool is not installed".
func defaultShell() Shell {
	return platformShell()
}

// envFor builds the child's environment: the runtime's own, with the few
// variables a terminal must set for itself.
//
// `TERM` is set rather than inherited, and that is the point of the function.
// Under a full-screen front end this process's own `TERM` describes *that*
// interface's terminal, and a program that inherited it would emit sequences for
// the wrong kind of emulator — or, worse, believe it is attached to one when it
// is behind a PTY this program is relaying. `xterm-256color` is the honest
// description: a full-color VT-style terminal, which is what a front end drawing
// ANSI is.
//
// `COLORTERM` rides along for the same reason: without it a good many programs
// fall back to 16 colours, and the symptom is a terminal that looks worse than
// the person's real one for no reason they can see.
//
// **The forcing is unconditional, including over an explicit environment**, and
// that is a correction rather than a detail. The first version short-circuited on
// `spec.Env != nil` and returned it untouched — which made the one rule this
// function exists for stop applying exactly when a caller had supplied a base.
// The two facts are independent (what the base is, and which names must describe
// *this* terminal) and are now written as such.
//
// `spec.Env` stays as the way to say "start from this instead of my own
// environment": it is what makes the function testable, and a caller that needs a
// shell with no inherited PATH should be able to ask for one.
func envFor(spec spawnSpec) []string {
	base := spec.Env
	if base == nil {
		base = os.Environ()
	}
	overrides := map[string]string{
		"TERM":      "xterm-256color",
		"COLORTERM": "truecolor",
	}
	out := make([]string, 0, len(base)+len(overrides))
	for _, entry := range base {
		name, _, found := strings.Cut(entry, "=")
		if !found {
			out = append(out, entry)
			continue
		}
		// Case-folded on Windows, where names are case-insensitive and `Term` and
		// `TERM` are the same variable to every program that reads them.
		if _, replaced := overrides[foldName(name)]; replaced {
			continue
		}
		out = append(out, entry)
	}
	for name, value := range overrides {
		out = append(out, name+"="+value)
	}
	return out
}

func foldName(name string) string {
	if isWindows() {
		return strings.ToUpper(name)
	}
	return name
}

// isWindows names one question in one place.
//
// It exists rather than the three separate `runtime.GOOS == "windows"` tests it
// replaces so that the tests can ask the same question the implementation does:
// a test that decided "am I on Windows" its own way would keep passing while the
// code under it took the other branch.
func isWindows() bool { return runtime.GOOS == "windows" }

// lookupShell picks the first program that exists, in the order given.
//
// It resolves through PATH and then checks the candidate, so an installed-but-not-
// on-PATH `pwsh` is found: on Windows PowerShell 7 installs to a fixed location
// that a GUI-launched process does not always have on its PATH.
func lookupShell(candidates []Shell) Shell {
	for _, candidate := range candidates {
		if len(candidate.Argv) == 0 {
			continue
		}
		program := candidate.Argv[0]
		if filepath.IsAbs(program) {
			if info, err := os.Stat(program); err == nil && !info.IsDir() {
				return candidate
			}
			continue
		}
		if resolved, err := lookPath(program); err == nil {
			return Shell{Display: candidate.Display, Argv: append([]string{resolved}, candidate.Argv[1:]...)}
		}
	}
	// Nothing found. Returning an empty shell is worse than returning the last
	// candidate: the caller reports the failure, and a sentence naming the program
	// it tried to run is a sentence somebody can act on.
	if len(candidates) > 0 {
		return candidates[len(candidates)-1]
	}
	return Shell{Display: "sh", Argv: []string{"sh"}}
}
