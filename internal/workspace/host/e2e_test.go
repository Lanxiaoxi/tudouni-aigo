package host

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// This file is the end-to-end scenario from docs/design/workspace-dock.md
// section 13, driven through the host's real JSONL interface with a real PTY and
// a real file watcher:
//
//	terminal edits src/main.go -> Explorer is told -> Git sees it -> diff shows it
//	-> the person switches session away (detach) -> the terminal keeps running
//	-> switches back (attach from the last seq) -> nothing lost, nothing created.

// shellKind is the dialect of the shell internal/terminal picked. The host
// decides the shell, not the front end, so the test has to ask which one it got
// before it can type a command that means the same thing in it.
type shellKind int

const (
	shellPOSIX shellKind = iota
	shellPowerShell
	shellCmd
)

func detectShell(display string) shellKind {
	if runtime.GOOS != "windows" {
		return shellPOSIX
	}
	// Windows picks pwsh, then powershell, then cmd.exe (see shell_windows.go).
	if strings.Contains(strings.ToLower(display), "cmd") {
		return shellCmd
	}
	return shellPowerShell
}

// enter is what the Enter key sends on that platform's PTY.
func (k shellKind) enter() string {
	if k == shellPOSIX {
		return "\n"
	}
	return "\r\n"
}

// appendComment appends "// e2e" to src/main.go.
func (k shellKind) appendComment() string {
	switch k {
	case shellPowerShell:
		return `Add-Content -Path src/main.go -Value '// e2e'`
	case shellCmd:
		return `echo // e2e >> src\main.go`
	}
	return `echo '// e2e' >> src/main.go`
}

// printMarker prints "e2e-<word>" such that the typed command line does not itself
// contain that text. The terminal echoes what is typed, so a marker that appears
// verbatim in the command would be "found" before the command ever ran.
func (k shellKind) printMarker(word string) string {
	switch k {
	case shellPowerShell:
		return fmt.Sprintf(`Write-Output ('e2e-' + '%s')`, word)
	case shellCmd:
		// A caret escapes the next character, so the echo shows "e2e-a^way" and the
		// output shows "e2e-away".
		return fmt.Sprintf("echo e2e-%s^%s", word[:1], word[1:])
	}
	return fmt.Sprintf(`printf 'e2e-%%s\n' %s`, word)
}

// chain joins two commands so the second runs after the first.
func (k shellKind) chain(first, second string) string {
	if k == shellCmd {
		return first + " & " + second
	}
	return first + "; " + second
}

// termStream reassembles one terminal's output the way a front end does: the
// replay in an attach result, then contiguous term_output pushes.
type termStream struct {
	t    *testing.T
	h    *harness
	id   string
	buf  bytes.Buffer
	next int64 // the seq the next byte must carry
}

// absorb takes the replay of an attach result. The attach has to resume exactly
// where the stream stopped and must not report a gap.
func (s *termStream) absorb(att map[string]any) {
	s.t.Helper()
	if att["gap"] != false {
		s.t.Fatalf("attach reported a gap: %v", att["gap"])
	}
	from := int64(att["from_seq"].(float64))
	if from != s.next {
		s.t.Fatalf("attach resumed at seq %d, want %d", from, s.next)
	}
	replay, err := base64.StdEncoding.DecodeString(att["data"].(string))
	if err != nil {
		s.t.Fatalf("attach data is not base64: %v", err)
	}
	s.buf.Write(replay)
	s.next += int64(len(replay))
}

// consumeOne reads the next terminal push, requiring it to continue the stream.
func (s *termStream) consumeOne(timeout time.Duration) {
	s.t.Helper()
	m, ok := s.h.next(timeout, func(m map[string]any) bool {
		switch m["t"] {
		case "term_output", "term_exit", "term_gap":
			return m["id"] == s.id
		}
		return false
	})
	if !ok {
		s.t.Fatalf("no terminal message within %v; output so far: %q", timeout, s.buf.String())
	}
	switch m["t"] {
	case "term_exit":
		s.t.Fatalf("the terminal exited while it was expected to keep running: %v; output so far: %q", m, s.buf.String())
	case "term_gap":
		s.t.Fatalf("unexpected output gap %v; output so far: %q", m, s.buf.String())
	}
	seq := int64(m["seq"].(float64))
	if seq != s.next {
		s.t.Fatalf("term_output seq %d, want %d: pushes must be contiguous", seq, s.next)
	}
	chunk, err := base64.StdEncoding.DecodeString(m["data"].(string))
	if err != nil {
		s.t.Fatalf("term_output data is not base64: %v", err)
	}
	s.buf.Write(chunk)
	s.next += int64(len(chunk))
}

// waitFor consumes output until marker has shown up in the stream.
func (s *termStream) waitFor(marker string, timeout time.Duration) {
	s.t.Helper()
	deadline := time.Now().Add(timeout)
	for !strings.Contains(s.buf.String(), marker) {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			s.t.Fatalf("marker %q did not appear within %v; output so far: %q", marker, timeout, s.buf.String())
		}
		s.consumeOne(remaining)
	}
}

// head is the terminal's output_seq as the host reports it.
func (s *termStream) head() int64 {
	s.t.Helper()
	for _, raw := range s.h.ok("term_list", nil)["terminals"].([]any) {
		if m := raw.(map[string]any); m["id"] == s.id {
			return int64(m["output_seq"].(float64))
		}
	}
	s.t.Fatalf("terminal %s is not in term_list", s.id)
	return 0
}

// settle consumes pushes until everything the shell has written so far has been
// received. A detach while a push is still in flight could otherwise leave a stray
// chunk behind the detach result, which would make "the last seq I saw" a moving
// target rather than a fact.
func (s *termStream) settle(timeout time.Duration) {
	s.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		head := s.head()
		if head == s.next {
			return
		}
		if head < s.next {
			s.t.Fatalf("received up to seq %d but the host's output_seq is only %d", s.next, head)
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			s.t.Fatalf("terminal output did not go quiet within %v (received %d, host has %d)", timeout, s.next, head)
		}
		s.consumeOne(remaining)
	}
}

// eventually polls check until it succeeds. The detail it returns is shown if the
// deadline passes, so a timeout says what the last observed state was.
func eventually(t *testing.T, timeout time.Duration, what string, check func() (bool, string)) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		ok, detail := check()
		if ok {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %v waiting for %s; last state: %s", timeout, what, detail)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// eventSummary lists the workspace events that were received but not consumed,
// for failure messages.
func eventSummary(h *harness) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var parts []string
	for _, m := range h.backlog {
		if m["t"] == "workspace_event" {
			parts = append(parts, fmt.Sprintf("rev=%v changes=%v invalidates=%v reset=%v",
				m["revision"], m["changes"], m["invalidates"], m["reset_required"]))
		}
	}
	if len(parts) == 0 {
		return "(none)"
	}
	return strings.Join(parts, "; ")
}

func invalidates(ev map[string]any, cache string) bool {
	list, _ := ev["invalidates"].([]any)
	for _, v := range list {
		if v == cache {
			return true
		}
	}
	return false
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

func TestE2ETerminalEditTriggersWatcherGitAndSurvivesSessionSwitch(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not on PATH")
	}

	// 1. A git workspace with one committed file. The repository is built before
	// the host starts so that its own churn is not mistaken for the edit under test.
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "src", "main.go"), []byte("package main\n\nfunc main() {}\n"))
	runGit(t, root, "init", "-q")
	// Local config only. autocrlf is pinned off so a Windows machine's global
	// setting cannot change what is committed or what counts as modified.
	runGit(t, root, "config", "core.autocrlf", "false")
	runGit(t, root, "config", "commit.gpgsign", "false")
	runGit(t, root, "add", "src/main.go")
	runGit(t, root, "-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "initial")

	h := startHost(t, harnessOptions{root: root})
	init := h.expect("host_init")
	caps := init["workspace_capabilities"].(map[string]any)
	if caps["file_watch"] != true || caps["git"] != true {
		t.Skipf("watcher or git unavailable on this machine: %v", caps)
	}

	// The recursive walk that adds src/ runs in the background. Rather than sleep
	// and hope, write a probe file until the watcher reports it, which proves src/
	// is being watched before the terminal touches it.
	probe := filepath.Join(root, "src", "probe.tmp")
	watching := false
	for attempt := 0; attempt < 20 && !watching; attempt++ {
		writeFile(t, probe, []byte(fmt.Sprintf("probe %d\n", attempt)))
		_, watching = waitEvent(h, time.Second, func(m map[string]any) bool { return hasChange(m, "src/probe.tmp", "") })
	}
	if !watching {
		t.Fatal("the watcher never reported a file written to src/ (20 attempts)")
	}
	if err := os.Remove(probe); err != nil {
		t.Fatal(err)
	}

	// 2. Create a terminal and attach to it.
	created := h.ok("term_create", map[string]any{"cwd": ""})["terminal"].(map[string]any)
	id := created["id"].(string)
	kind := detectShell(created["shell"].(string))
	stream := &termStream{t: t, h: h, id: id}
	stream.absorb(h.ok("term_attach", map[string]any{"id": id}))

	// 3. Edit the file from inside the terminal, then print a marker so there is a
	// moment at which the command is known to have finished.
	command := kind.chain(kind.appendComment(), kind.printMarker("done"))
	h.ok("term_input", map[string]any{"id": id, "data": command + kind.enter()})
	// A cold PowerShell can take many seconds to show a prompt; the input waits in
	// the PTY until it does.
	stream.waitFor("e2e-done", 60*time.Second)

	// 4. The watcher reports the change, and says the file list is stale.
	ev, ok := waitEvent(h, 15*time.Second, func(m map[string]any) bool {
		changes, _ := m["changes"].([]any)
		for _, c := range changes {
			cm := c.(map[string]any)
			if cm["path"] == "src/main.go" && (cm["type"] == ChangeModified || cm["type"] == ChangeCreated) {
				return true
			}
		}
		return false
	})
	if !ok {
		t.Fatalf("no workspace_event reporting src/main.go as modified or created within 15s; unconsumed events: %s", eventSummary(h))
	}
	if !invalidates(ev, InvalidateFiles) {
		t.Fatalf("the event for src/main.go must invalidate %q: %v", InvalidateFiles, ev)
	}

	// 5. Git sees the edit, and the diff contains it. Polled because git reads the
	// index and the file's stat data itself; the command has finished, but this is
	// the cheapest way to not depend on that.
	eventually(t, 10*time.Second, "git_status to list src/main.go as modified", func() (bool, string) {
		status := h.ok("git_status", nil)
		entries, _ := status["entries"].([]any)
		for _, raw := range entries {
			e := raw.(map[string]any)
			if e["path"] == "src/main.go" {
				return e["worktree"] == "M", fmt.Sprintf("%v", e)
			}
		}
		return false, fmt.Sprintf("repo=%v entries=%v", status["repo"], entries)
	})
	eventually(t, 10*time.Second, "git_diff (worktree) to contain the edit", func() (bool, string) {
		diff := h.ok("git_diff", map[string]any{"path": "src/main.go", "source": "worktree"})
		text, _ := diff["diff"].(string)
		return strings.Contains(text, "// e2e"), fmt.Sprintf("%q", text)
	})

	// 6. Switch session away: detach. The terminal must keep running, and what it
	// writes meanwhile must be waiting when we come back.
	stream.settle(15 * time.Second)
	seen := stream.next
	h.ok("term_detach", map[string]any{"id": id})
	h.ok("term_input", map[string]any{"id": id, "data": kind.printMarker("away") + kind.enter()})
	eventually(t, 30*time.Second, "output to accumulate while detached", func() (bool, string) {
		head := stream.head()
		return head > seen, fmt.Sprintf("output_seq=%d, last seen=%d", head, seen)
	})

	// Switch back: attach from the last seq seen.
	att := h.ok("term_attach", map[string]any{"id": id, "from_seq": seen})
	back := att["terminal"].(map[string]any)
	if back["id"] != id || back["state"] != "running" || back["exit_code"] != nil {
		t.Fatalf("after reattaching the terminal must still be the same running one: %v", back)
	}
	stream.absorb(att) // fails on a gap or if the attach did not resume at `seen`
	if stream.next == seen {
		t.Fatalf("the output written while detached was not replayed (seq stayed at %d)", seen)
	}
	stream.waitFor("e2e-away", 30*time.Second)

	// Reconnecting must never create: still exactly the one terminal.
	list := h.ok("term_list", nil)["terminals"].([]any)
	if len(list) != 1 {
		t.Fatalf("term_list has %d terminals after reconnecting, want 1: %v", len(list), list)
	}
	if only := list[0].(map[string]any); only["id"] != id || only["state"] != "running" {
		t.Fatalf("term_list entry changed across the reconnect: %v", only)
	}

	// 7. Close the terminal and shut the host down.
	h.ok("term_close", map[string]any{"id": id})
	if left := h.ok("term_list", nil)["terminals"].([]any); len(left) != 0 {
		t.Fatalf("term_close must remove the entry: %v", left)
	}
	h.write(map[string]any{"t": "shutdown"})
	select {
	case code := <-h.exit:
		if code != 0 {
			t.Fatalf("host exit code %d after shutdown, want 0", code)
		}
		// startHost's cleanup waits on this channel too.
		h.exit <- code
	case <-time.After(20 * time.Second):
		t.Fatal("the host did not return within 20s of shutdown")
	}
}
