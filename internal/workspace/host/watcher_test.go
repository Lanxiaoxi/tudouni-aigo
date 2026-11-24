package host

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// waitEvent waits for a workspace_event satisfying pred.
func waitEvent(h *harness, timeout time.Duration, pred func(map[string]any) bool) (map[string]any, bool) {
	return h.next(timeout, func(m map[string]any) bool { return m["t"] == "workspace_event" && pred(m) })
}

func hasChange(ev map[string]any, path, typ string) bool {
	changes, _ := ev["changes"].([]any)
	for _, c := range changes {
		cm := c.(map[string]any)
		if cm["path"] == path && (typ == "" || cm["type"] == typ) {
			return true
		}
	}
	return false
}

func TestWatcherReportsCreatedFileAndNewDirectories(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	h := startHost(t, harnessOptions{root: root})
	init := h.expect("host_init")
	caps := init["workspace_capabilities"].(map[string]any)
	if caps["file_watch"] != true {
		t.Skipf("watcher unavailable on this machine: %v", caps)
	}
	// The recursive walk finishes in the background; give it a moment so the
	// existing directory is watched before it is written into.
	time.Sleep(300 * time.Millisecond)

	writeFile(t, filepath.Join(root, "src", "a.go"), []byte("package a\n"))
	ev, ok := waitEvent(h, 5*time.Second, func(m map[string]any) bool { return hasChange(m, "src/a.go", "") })
	if !ok {
		t.Fatal("no workspace_event for a file created in a watched directory")
	}
	if ev["workspace_id"] != "ws-test" || ev["revision"].(float64) < 1 || ev["reset_required"] != false {
		t.Fatalf("event envelope: %v", ev)
	}

	// A directory created later is watched too, including a file written into it.
	if err := os.MkdirAll(filepath.Join(root, "newdir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, ok := waitEvent(h, 5*time.Second, func(m map[string]any) bool { return hasChange(m, "newdir", ChangeCreated) }); !ok {
		t.Fatal("no event for a new directory")
	}
	time.Sleep(300 * time.Millisecond)
	writeFile(t, filepath.Join(root, "newdir", "b.txt"), []byte("x"))
	if _, ok := waitEvent(h, 5*time.Second, func(m map[string]any) bool { return hasChange(m, "newdir/b.txt", "") }); !ok {
		t.Fatal("no event for a file inside a directory created after start-up")
	}

	if err := os.Remove(filepath.Join(root, "src", "a.go")); err != nil {
		t.Fatal(err)
	}
	if _, ok := waitEvent(h, 5*time.Second, func(m map[string]any) bool { return hasChange(m, "src/a.go", ChangeDeleted) }); !ok {
		t.Fatal("no delete event")
	}
}

// A burst of new directories must not wedge the watcher. Each created
// directory makes the watcher add watches; if that happens on the goroutine
// that drains fsnotify's Events channel, fsnotify's reader (which serves Add)
// can be blocked delivering the next event to that same goroutine, and both
// wait forever. The symptom is a host that keeps answering requests and
// streaming terminal output but never sends another workspace_event.
func TestWatcherSurvivesDirectoryBurst(t *testing.T) {
	root := t.TempDir()
	h := startHost(t, harnessOptions{root: root})
	init := h.expect("host_init")
	if init["workspace_capabilities"].(map[string]any)["file_watch"] != true {
		t.Skip("watcher unavailable")
	}
	time.Sleep(300 * time.Millisecond)

	for i := 0; i < 200; i++ {
		dir := filepath.Join(root, "burst", fmt.Sprintf("d%03d", i), "inner")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		writeFile(t, filepath.Join(dir, "f.txt"), []byte("x"))
	}

	// Drain whatever the burst produced, then prove the watcher still works.
	time.Sleep(time.Second)
	writeFile(t, filepath.Join(root, "after-burst.txt"), []byte("x"))
	if _, ok := waitEvent(h, 10*time.Second, func(m map[string]any) bool {
		return hasChange(m, "after-burst.txt", "") || m["reset_required"] == true
	}); !ok {
		t.Fatal("no workspace_event after a burst of new directories: the watcher is wedged")
	}
}

func TestWatcherIgnoresNodeModules(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "node_modules", "pkg"), 0o755); err != nil {
		t.Fatal(err)
	}
	h := startHost(t, harnessOptions{root: root})
	init := h.expect("host_init")
	if init["workspace_capabilities"].(map[string]any)["file_watch"] != true {
		t.Skip("watcher unavailable")
	}
	time.Sleep(300 * time.Millisecond)
	writeFile(t, filepath.Join(root, "node_modules", "pkg", "x.js"), []byte("x"))
	writeFile(t, filepath.Join(root, "marker.txt"), []byte("x"))
	var sawMarker bool
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && !sawMarker {
		ev, ok := waitEvent(h, time.Until(deadline), func(m map[string]any) bool { return true })
		if !ok {
			break
		}
		if hasChange(ev, "node_modules/pkg/x.js", "") {
			t.Fatalf("an ignored tree produced an event: %v", ev)
		}
		sawMarker = hasChange(ev, "marker.txt", "")
	}
	if !sawMarker {
		t.Fatal("never saw the marker file")
	}
}
