package host

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestRingWindowAndGap(t *testing.T) {
	r := newRing(8)
	r.write([]byte("abcd"))
	data, from, gap := r.window(0)
	if string(data) != "abcd" || from != 0 || gap {
		t.Fatalf("before wrap: %q %d %v", data, from, gap)
	}
	r.write([]byte("efghij")) // head=10, holds [2,10) = "cdefghij"
	if r.start() != 2 || r.head != 10 {
		t.Fatalf("start=%d head=%d", r.start(), r.head)
	}
	data, from, gap = r.window(0)
	if string(data) != "cdefghij" || from != 2 || !gap {
		t.Fatalf("reaching back past the buffer must report a gap: %q %d %v", data, from, gap)
	}
	data, from, gap = r.window(5)
	if string(data) != "fghij" || from != 5 || gap {
		t.Fatalf("inside the buffer: %q %d %v", data, from, gap)
	}
	data, from, gap = r.window(10)
	if len(data) != 0 || from != 10 || gap {
		t.Fatalf("caught up: %q %d %v", data, from, gap)
	}
	data, from, _ = r.window(99)
	if len(data) != 0 || from != 10 {
		t.Fatalf("a from_seq ahead of the head is clamped: %q %d", data, from)
	}
}

func TestRingOversizedWriteKeepsOffsetsTrue(t *testing.T) {
	r := newRing(4)
	r.write([]byte("0123456789")) // only "6789" survives, at offsets 6..10
	if r.head != 10 || r.start() != 6 {
		t.Fatalf("head=%d start=%d", r.head, r.start())
	}
	data, from, gap := r.window(0)
	if string(data) != "6789" || from != 6 || !gap {
		t.Fatalf("%q %d %v", data, from, gap)
	}
	// Many small writes wrap correctly.
	r2 := newRing(5)
	var all []byte
	for i := 0; i < 50; i++ {
		chunk := []byte(fmt.Sprintf("%d,", i))
		all = append(all, chunk...)
		r2.write(chunk)
	}
	data, from, _ = r2.window(0)
	if !bytes.Equal(data, all[len(all)-5:]) || from != int64(len(all)-5) {
		t.Fatalf("wrapped content %q from %d", data, from)
	}
}

// echoCommand is a command that prints a marker and exits, for the default shell
// of the platform.
func echoAndExit(marker string) string {
	if runtime.GOOS == "windows" {
		// Works in cmd.exe and PowerShell alike.
		return "echo " + marker + "\r\nexit 7\r\n"
	}
	return "echo " + marker + "\nexit 7\n"
}

func TestTerminalLifecycleWithRealPTY(t *testing.T) {
	root := t.TempDir()
	h := startHost(t, harnessOptions{root: root, disableWatcher: true})
	h.expect("host_init")

	created := h.ok("term_create", map[string]any{"cols": 100, "rows": 30, "title": "work"})
	term := created["terminal"].(map[string]any)
	id := term["id"].(string)
	if term["state"] != "running" || term["exit_code"] != nil || term["title"] != "work" ||
		term["workspace_id"] != "ws-test" || term["cwd"] != "" || term["cols"].(float64) != 100 {
		t.Fatalf("created: %v", term)
	}

	// Creating does not attach: no output may be pushed yet.
	list := h.ok("term_list", nil)["terminals"].([]any)
	if len(list) != 1 {
		t.Fatalf("list: %v", list)
	}

	att := h.ok("term_attach", map[string]any{"id": id})
	if att["gap"] != false {
		t.Fatalf("first attach: %v", att)
	}
	// Reassemble the stream: the replay in the attach result, then pushes.
	var stream bytes.Buffer
	replay, _ := base64.StdEncoding.DecodeString(att["data"].(string))
	stream.Write(replay)
	next := int64(att["from_seq"].(float64)) + int64(len(replay))

	marker := "hostmarker42"
	h.ok("term_input", map[string]any{"id": id, "data": echoAndExit(marker)})

	deadline := time.After(30 * time.Second)
	var exitCode any = "unset"
	gotExit := false
	for !gotExit {
		select {
		case <-deadline:
			t.Fatalf("terminal did not exit; output so far: %q", stream.String())
		default:
		}
		m, ok := h.next(30*time.Second, func(m map[string]any) bool {
			return (m["t"] == "term_output" || m["t"] == "term_exit") && m["id"] == id
		})
		if !ok {
			t.Fatalf("no more terminal messages; output so far: %q", stream.String())
		}
		if m["t"] == "term_exit" {
			exitCode, gotExit = m["exit_code"], true
			break
		}
		seq := int64(m["seq"].(float64))
		if seq != next {
			t.Fatalf("seq %d, want %d: pushes must be contiguous", seq, next)
		}
		chunk, err := base64.StdEncoding.DecodeString(m["data"].(string))
		if err != nil {
			t.Fatal(err)
		}
		stream.Write(chunk)
		next += int64(len(chunk))
	}
	if !strings.Contains(stream.String(), marker) {
		t.Fatalf("output lacks the marker: %q", stream.String())
	}
	if exitCode != nil && exitCode.(float64) != 7 {
		t.Fatalf("exit code %v, want 7 (or null where the platform has none)", exitCode)
	}

	// The entry survives its process, with the state and code.
	after := h.ok("term_list", nil)["terminals"].([]any)[0].(map[string]any)
	if after["state"] != "exited" {
		t.Fatalf("after exit: %v", after)
	}
	if after["output_seq"].(float64) != float64(next) {
		t.Fatalf("output_seq %v, want %d", after["output_seq"], next)
	}

	// Re-attaching replays everything, and no new process is created.
	again := h.ok("term_attach", map[string]any{"id": id, "from_seq": 0})
	all, _ := base64.StdEncoding.DecodeString(again["data"].(string))
	if !bytes.Equal(all, stream.Bytes()) {
		t.Fatalf("replay differs from the live stream")
	}
	h.fail("term_input", map[string]any{"id": id, "data": "x"}, CodeBadRequest)

	h.ok("term_close", map[string]any{"id": id})
	if got := h.ok("term_list", nil)["terminals"].([]any); len(got) != 0 {
		t.Fatalf("close must remove the entry: %v", got)
	}
	h.fail("term_attach", map[string]any{"id": id}, CodeNotFound)
}

func TestTerminalKillKeepsEntryAndExitIsPushedWithoutAttach(t *testing.T) {
	h := startHost(t, harnessOptions{root: t.TempDir(), disableWatcher: true})
	h.expect("host_init")
	id := h.ok("term_create", nil)["terminal"].(map[string]any)["id"].(string)

	h.ok("term_kill", map[string]any{"id": id})
	if _, ok := h.next(10*time.Second, func(m map[string]any) bool { return m["t"] == "term_exit" && m["id"] == id }); !ok {
		t.Fatal("term_exit must be pushed even when nobody attached")
	}
	list := h.ok("term_list", nil)["terminals"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["state"] != "exited" {
		t.Fatalf("kill keeps the entry: %v", list)
	}
	// No term_output was ever pushed to an unattached terminal.
	h.mu.Lock()
	for _, m := range h.backlog {
		if m["t"] == "term_output" {
			t.Fatalf("output was pushed to a terminal nobody attached: %v", m)
		}
	}
	h.mu.Unlock()
	h.ok("term_close", map[string]any{"id": id})
}

func TestTerminalCwdMustStayInsideWorkspace(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root+"/sub/keep.txt", []byte("x"))
	h := startHost(t, harnessOptions{root: root, disableWatcher: true})
	h.expect("host_init")
	h.fail("term_create", map[string]any{"cwd": ".."}, CodePathEscape)
	h.fail("term_create", map[string]any{"cwd": "missing"}, CodeNotFound)
	h.fail("term_create", map[string]any{"cwd": "sub/keep.txt"}, CodeBadRequest)
	got := h.ok("term_create", map[string]any{"cwd": "sub"})["terminal"].(map[string]any)
	if got["cwd"] != "sub" {
		t.Fatalf("cwd: %v", got)
	}
	h.ok("term_close", map[string]any{"id": got["id"]})
}

func TestShutdownKillsTerminals(t *testing.T) {
	h := startHost(t, harnessOptions{root: t.TempDir(), disableWatcher: true})
	h.expect("host_init")
	h.ok("term_create", nil)
	h.ok("term_create", nil)
	h.write(map[string]any{"t": "shutdown"})
	select {
	case code := <-h.exit:
		if code != 0 {
			t.Fatalf("exit code %d", code)
		}
		h.exit <- code
	case <-time.After(15 * time.Second):
		t.Fatal("shutdown hung with live terminals")
	}
}
