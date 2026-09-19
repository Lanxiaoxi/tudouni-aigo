package state

import (
	"fmt"
	"os"
	"sync"
	"testing"
)

// TestTheStoreTakesConcurrentLoadsAndSaves is the half of the watermark's concurrency
// that was missing.
//
// `Save` holds the mutex for its whole body and says why; `Load` wrote the same map
// without it. The two really do run at once — a turn is on its own goroutine, and the
// session picker lists the stored sessions, this one included, from the protocol read
// loop — so `/resume` while a turn was running was enough.
//
// Both consequences are watched for here. An unsynchronised map write is a fatal
// error the runtime cannot recover from, and it takes the whole session with it. And
// a `Load` that installed the message count it read while a `Save` was already past
// it would make the next save append those messages to the file a second time.
func TestTheStoreTakesConcurrentLoadsAndSaves(t *testing.T) {
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const id = "live"
	const rounds = 400

	session := NewEmptySession(id)
	if err := store.Save(session); err != nil {
		t.Fatal(err)
	}

	var wait sync.WaitGroup
	done := make(chan struct{})

	// The turn: append and save, the way a running step does.
	wait.Add(1)
	go func() {
		defer wait.Done()
		defer close(done)
		for round := 0; round < rounds; round++ {
			session.Append(map[string]any{"role": "user", "content": fmt.Sprintf("m%d", round)})
			if err := store.Save(session); err != nil {
				t.Errorf("save round %d: %v", round, err)
				return
			}
		}
	}()

	// The picker: reads the very session the turn is writing.
	wait.Add(1)
	go func() {
		defer wait.Done()
		for {
			select {
			case <-done:
				return
			default:
			}
			if _, err := store.Load(id); err != nil {
				t.Errorf("load: %v", err)
				return
			}
		}
	}()
	wait.Wait()

	saved, err := store.Load(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Messages) != len(session.Messages) {
		t.Fatalf("the file holds %d messages and the session has %d",
			len(saved.Messages), len(session.Messages))
	}
	seen := map[string]bool{}
	for _, message := range saved.Messages {
		text, _ := message["content"].(string)
		if seen[text] {
			t.Fatalf("message %q was written to the file twice", text)
		}
		seen[text] = true
	}
}

// TestAHalfLineDoesNotSwallowTheNextRecord is the failure the tolerance in `Load` was
// written to prevent and did not.
//
// A process killed mid-write leaves a record with no trailing newline. Skipping it is
// the intended behaviour — but the next `Save` appended straight onto the end of that
// half line, so the record it wrote became part of an unparseable line and was skipped
// in turn. When the swallowed record is an assistant turn that asked for a tool, its
// results each survive on their own line, and the session is then refused by the
// endpoint for good with an error that reads like "the context is too long".
func TestAHalfLineDoesNotSwallowTheNextRecord(t *testing.T) {
	dir := t.TempDir()
	store, err := NewSessionStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	const id = "half"
	session := NewEmptySession(id)
	session.Append(map[string]any{"role": "user", "content": "first"})
	if err := store.Save(session); err != nil {
		t.Fatal(err)
	}

	// The kill: a record cut off before its newline.
	path, err := store.Path(id)
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(`{"v":1,"type":"msg","message":{"role":"user","conte`); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	// A fresh process reads the file: the half line is skipped, the session opens,
	// and the turn continues.
	restored, err := NewSessionStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := restored.Load(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(reloaded.Messages) != 1 {
		t.Fatalf("the half line was replayed as a message (%d messages)", len(reloaded.Messages))
	}
	reloaded.Append(map[string]any{"role": "assistant", "content": "second"})
	if err := restored.Save(reloaded); err != nil {
		t.Fatal(err)
	}

	// And again, which is where the record written after recovery used to disappear.
	third, err := NewSessionStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	final, err := third.Load(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(final.Messages) != 2 {
		t.Fatalf("the session has %d messages, want 2: the record written after recovery was swallowed",
			len(final.Messages))
	}
	if text, _ := final.Messages[1]["content"].(string); text != "second" {
		t.Errorf("the recovered record reads %q, want \"second\"", text)
	}
}
