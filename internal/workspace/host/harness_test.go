package host

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// harness runs a real Host over in-memory pipes, the way the desktop does over
// stdio, so the tests exercise framing, ordering and shutdown rather than only
// the handlers.
type harness struct {
	t    *testing.T
	in   *io.PipeWriter
	msgs chan map[string]any
	exit chan int
	seq  int
	mu   sync.Mutex
	// backlog keeps messages that were read while waiting for another one.
	backlog []map[string]any
}

type harnessOptions struct {
	root           string
	disableWatcher bool
	hub            HubConfig
}

func startHost(t *testing.T, opts harnessOptions) *harness {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	h := &harness{t: t, in: inW, msgs: make(chan map[string]any, 4096), exit: make(chan int, 1)}

	go func() {
		scanner := bufio.NewScanner(outR)
		scanner.Buffer(make([]byte, 1<<20), 64<<20)
		for scanner.Scan() {
			var msg map[string]any
			if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
				t.Errorf("host wrote a line that is not JSON: %q", scanner.Text())
				continue
			}
			h.msgs <- msg
		}
		close(h.msgs)
	}()
	go func() {
		code := Run(Options{
			WorkspaceID:    "ws-test",
			Root:           opts.root,
			In:             inR,
			Out:            outW,
			Err:            io.Discard,
			Version:        "9.9.9",
			DisableWatcher: opts.disableWatcher,
			Hub:            opts.hub,
		})
		outW.Close()
		h.exit <- code
	}()
	t.Cleanup(func() {
		h.in.Close()
		select {
		case <-h.exit:
		case <-time.After(10 * time.Second):
			t.Errorf("host did not stop after its input closed")
		}
	})
	return h
}

func (h *harness) write(msg map[string]any) {
	h.t.Helper()
	if _, ok := msg["v"]; !ok {
		msg["v"] = 1
	}
	raw, err := json.Marshal(msg)
	if err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.in.Write(append(raw, '\n')); err != nil {
		h.t.Fatalf("write to host: %v", err)
	}
}

// next returns the next message matching pred, keeping the ones it skips.
func (h *harness) next(timeout time.Duration, pred func(map[string]any) bool) (map[string]any, bool) {
	h.t.Helper()
	h.mu.Lock()
	for i, m := range h.backlog {
		if pred(m) {
			h.backlog = append(h.backlog[:i], h.backlog[i+1:]...)
			h.mu.Unlock()
			return m, true
		}
	}
	h.mu.Unlock()
	deadline := time.After(timeout)
	for {
		select {
		case m, ok := <-h.msgs:
			if !ok {
				return nil, false
			}
			if pred(m) {
				return m, true
			}
			h.mu.Lock()
			h.backlog = append(h.backlog, m)
			h.mu.Unlock()
		case <-deadline:
			return nil, false
		}
	}
}

func (h *harness) expect(t string) map[string]any {
	h.t.Helper()
	m, ok := h.next(10*time.Second, func(m map[string]any) bool { return m["t"] == t })
	if !ok {
		h.t.Fatalf("no %q message arrived", t)
	}
	return m
}

// call sends a request and returns the matching result envelope.
func (h *harness) call(t string, fields map[string]any) map[string]any {
	h.t.Helper()
	h.seq++
	req := fmt.Sprintf("r%d", h.seq)
	msg := map[string]any{"t": t, "req": req}
	for k, v := range fields {
		msg[k] = v
	}
	h.write(msg)
	m, ok := h.next(15*time.Second, func(m map[string]any) bool { return m["t"] == "result" && m["req"] == req })
	if !ok {
		h.t.Fatalf("no result for %s", t)
	}
	return m
}

// ok asserts a success and returns its data object.
func (h *harness) ok(t string, fields map[string]any) map[string]any {
	h.t.Helper()
	res := h.call(t, fields)
	if res["ok"] != true {
		h.t.Fatalf("%s failed: %v", t, res["error"])
	}
	data, _ := res["data"].(map[string]any)
	return data
}

// fail asserts a failure with the given code.
func (h *harness) fail(t string, fields map[string]any, code string) {
	h.t.Helper()
	res := h.call(t, fields)
	if res["ok"] == true {
		h.t.Fatalf("%s %v succeeded, want %s", t, fields, code)
	}
	errObj, _ := res["error"].(map[string]any)
	if errObj["code"] != code {
		h.t.Fatalf("%s %v failed with %v, want %s", t, fields, errObj, code)
	}
}

func contains(s, sub string) bool { return strings.Contains(s, sub) }
