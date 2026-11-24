package host

import (
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestHandshakeAndShutdown(t *testing.T) {
	root := t.TempDir()
	h := startHost(t, harnessOptions{root: root, disableWatcher: true})
	init := h.expect("host_init")
	if init["workspace_id"] != "ws-test" || init["v"].(float64) != 1 {
		t.Fatalf("bad host_init: %v", init)
	}
	if init["host_protocol"].(float64) != HostProtocol || init["version"] != "9.9.9" {
		t.Fatalf("bad host_init: %v", init)
	}
	caps := init["workspace_capabilities"].(map[string]any)
	if caps["file_watch"] != false {
		t.Errorf("file_watch must be false when the watcher is disabled: %v", caps)
	}
	if caps["system_open"] != false || caps["files"] != true || caps["terminal"] != true {
		t.Errorf("unexpected capabilities: %v", caps)
	}

	h.write(map[string]any{"t": "shutdown"})
	select {
	case code := <-h.exit:
		if code != 0 {
			t.Fatalf("exit code %d", code)
		}
		h.exit <- code // let Cleanup see it
	case <-time.After(10 * time.Second):
		t.Fatal("host did not exit on shutdown")
	}
}

func TestStdinEOFStopsTheHost(t *testing.T) {
	h := startHost(t, harnessOptions{root: t.TempDir(), disableWatcher: true})
	h.expect("host_init")
	h.in.Close()
	select {
	case code := <-h.exit:
		if code != 0 {
			t.Fatalf("exit code %d", code)
		}
		h.exit <- code
	case <-time.After(10 * time.Second):
		t.Fatal("host did not exit on EOF")
	}
}

func TestUnknownRequestAndVersion(t *testing.T) {
	h := startHost(t, harnessOptions{root: t.TempDir(), disableWatcher: true})
	h.expect("host_init")
	h.fail("no_such_message", map[string]any{"extra": 1}, CodeUnsupported)

	// A message without a req and with an unknown t is silently ignored; the
	// next request still works.
	h.write(map[string]any{"t": "from_the_future"})
	h.ok("fs_list", map[string]any{"path": "", "unknown_field": true})

	h.write(map[string]any{"v": 2, "t": "fs_list", "req": "vx"})
	m, ok := h.next(5*time.Second, func(m map[string]any) bool { return m["t"] == "error" })
	if !ok || m["code"] != CodeBadVersion {
		t.Fatalf("want bad_version error, got %v", m)
	}
}

func TestMessageNamesAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, name := range MessageNames {
		if seen[name] {
			t.Errorf("duplicate message name %q", name)
		}
		seen[name] = true
	}
	for _, want := range []string{"host_init", "fs_read", "git_diff", "term_attach", "workspace_event", "term_exit", "shutdown"} {
		if !seen[want] {
			t.Errorf("MessageNames lacks %q", want)
		}
	}
}

func TestFsListStatSearch(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "b.txt"), []byte("b"))
	writeFile(t, filepath.Join(root, "A.txt"), []byte("a"))
	writeFile(t, filepath.Join(root, ".hidden"), []byte("h"))
	writeFile(t, filepath.Join(root, "sub", "Needle.go"), []byte("package x\n"))
	writeFile(t, filepath.Join(root, "node_modules", "needle.js"), []byte("x"))
	writeFile(t, filepath.Join(root, ".git", "needle"), []byte("x"))
	h := startHost(t, harnessOptions{root: root, disableWatcher: true})
	h.expect("host_init")

	data := h.ok("fs_list", map[string]any{"path": ""})
	entries := data["entries"].([]any)
	var names []string
	for _, e := range entries {
		names = append(names, e.(map[string]any)["name"].(string))
	}
	// Directories first, then by case-insensitive name.
	want := ".git,node_modules,sub,.hidden,A.txt,b.txt"
	if got := strings.Join(names, ","); got != want {
		t.Fatalf("order = %s, want %s", got, want)
	}
	hidden := entries[3].(map[string]any)
	if hidden["hidden"] != true || hidden["kind"] != "file" {
		t.Errorf("hidden entry wrong: %v", hidden)
	}

	sub := h.ok("fs_list", map[string]any{"path": "sub"})
	first := sub["entries"].([]any)[0].(map[string]any)
	if first["path"] != "sub/Needle.go" {
		t.Errorf("path is not workspace relative with /: %v", first)
	}

	st := h.ok("fs_stat", map[string]any{"path": "sub/Needle.go"})
	if st["kind"] != "file" || st["size"].(float64) != 10 {
		t.Errorf("stat: %v", st)
	}
	h.fail("fs_stat", map[string]any{"path": "missing"}, CodeNotFound)
	h.fail("fs_list", map[string]any{"path": "b.txt"}, CodeBadRequest)

	res := h.ok("fs_search", map[string]any{"query": "NEEDLE"})
	results := res["results"].([]any)
	if len(results) != 1 || results[0].(map[string]any)["path"] != "sub/Needle.go" {
		t.Fatalf("search should skip .git and node_modules: %v", results)
	}
}

func TestFsPathSafety(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "ws")
	writeFile(t, filepath.Join(root, "in.txt"), []byte("in"))
	writeFile(t, filepath.Join(parent, "secret.txt"), []byte("secret"))
	h := startHost(t, harnessOptions{root: root, disableWatcher: true})
	h.expect("host_init")

	for _, req := range []string{"fs_list", "fs_stat", "fs_read", "fs_read_bytes"} {
		h.fail(req, map[string]any{"path": "../secret.txt"}, CodePathEscape)
		h.fail(req, map[string]any{"path": "sub/../../secret.txt"}, CodePathEscape)
		h.fail(req, map[string]any{"path": filepath.Join(parent, "secret.txt")}, CodePathEscape)
	}
	h.fail("fs_list", map[string]any{"path": ".."}, CodePathEscape)
	// A Windows-style separator must not be a way around the check. On Windows
	// `\` is a separator, so this names the parent's file and must be refused as
	// an escape. On POSIX `\` is an ordinary filename character: `..\secret.txt`
	// is one (absent) file *inside* the workspace, so the honest answer is
	// not_found — refusing it as an escape would make such legal files
	// unreadable. Either way the secret outside must never come back.
	if runtime.GOOS == "windows" {
		h.fail("fs_read", map[string]any{"path": `..\secret.txt`}, CodePathEscape)
	} else {
		h.fail("fs_read", map[string]any{"path": `..\secret.txt`}, CodeNotFound)
	}
}

func TestFsLinkRefused(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "ws")
	outside := filepath.Join(parent, "outside")
	writeFile(t, filepath.Join(outside, "secret.txt"), []byte("secret"))
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err != nil {
		// A junction needs no privilege on Windows and goes through the same check.
		if runtime.GOOS == "windows" {
			if out, jerr := exec.Command("cmd", "/c", "mklink", "/J", link, outside).CombinedOutput(); jerr != nil {
				t.Skipf("cannot create a symlink or junction here: %v / %v %s", err, jerr, out)
			}
		} else {
			t.Skipf("cannot create a symlink here: %v", err)
		}
	}
	h := startHost(t, harnessOptions{root: root, disableWatcher: true})
	h.expect("host_init")
	h.fail("fs_read", map[string]any{"path": "link/secret.txt"}, CodePathEscape)
	h.fail("fs_list", map[string]any{"path": "link"}, CodePathEscape)
	h.fail("fs_read_bytes", map[string]any{"path": "link/secret.txt"}, CodePathEscape)
}

func TestFsReadRangeAndTruncation(t *testing.T) {
	root := t.TempDir()
	var sb strings.Builder
	for i := 0; i < 100; i++ {
		sb.WriteString("line\n")
	}
	content := sb.String() // 500 bytes, 100 lines
	writeFile(t, filepath.Join(root, "a.txt"), []byte(content))
	h := startHost(t, harnessOptions{root: root, disableWatcher: true})
	h.expect("host_init")

	whole := h.ok("fs_read", map[string]any{"path": "a.txt"})
	if whole["status"] != "ok" || whole["truncated"] != false || whole["next_offset"] != nil {
		t.Fatalf("whole read: %v", whole)
	}
	if whole["total_lines"].(float64) != 100 || whole["bytes_read"].(float64) != 500 || whole["content"] != content {
		t.Fatalf("whole read: %v", whole)
	}

	part := h.ok("fs_read", map[string]any{"path": "a.txt", "limit": 100})
	if part["truncated"] != true || part["next_offset"].(float64) != 100 || part["total_lines"] != nil {
		t.Fatalf("a partial read must not claim a line count: %v", part)
	}
	if part["size"].(float64) != 500 {
		t.Fatalf("size: %v", part)
	}

	// Resuming from next_offset reassembles the file.
	var got strings.Builder
	offset := float64(0)
	for i := 0; i < 20; i++ {
		page := h.ok("fs_read", map[string]any{"path": "a.txt", "offset": offset, "limit": 64})
		got.WriteString(page["content"].(string))
		if page["next_offset"] == nil {
			break
		}
		offset = page["next_offset"].(float64)
	}
	if got.String() != content {
		t.Fatalf("pages did not reassemble the file")
	}

	tail := h.ok("fs_read", map[string]any{"path": "a.txt", "offset": 495})
	if tail["truncated"] != false || tail["next_offset"] != nil || tail["total_lines"] != nil {
		t.Fatalf("tail read from the middle: %v", tail)
	}
	h.fail("fs_read", map[string]any{"path": "a.txt", "limit": 0}, CodeBadRequest)
	h.fail("fs_read", map[string]any{"path": "a.txt", "offset": -1}, CodeBadRequest)
	h.fail("fs_read", map[string]any{"path": "."}, CodeBadRequest)
	h.fail("fs_read", map[string]any{"path": "nope.txt"}, CodeNotFound)
}

func TestFsReadUTF8Boundary(t *testing.T) {
	root := t.TempDir()
	// Each 汉 is 3 bytes; 20 of them = 60 bytes.
	content := strings.Repeat("汉", 20)
	writeFile(t, filepath.Join(root, "u.txt"), []byte(content))
	h := startHost(t, harnessOptions{root: root, disableWatcher: true})
	h.expect("host_init")

	// 10 bytes ends inside the fourth character: back off to 9.
	page := h.ok("fs_read", map[string]any{"path": "u.txt", "limit": 10})
	if page["bytes_read"].(float64) != 9 || page["next_offset"].(float64) != 9 || page["status"] != "ok" {
		t.Fatalf("boundary backoff: %v", page)
	}
	if page["content"] != strings.Repeat("汉", 3) {
		t.Fatalf("content: %q", page["content"])
	}

	// Pages of 10 bytes still reassemble to the original text.
	var got strings.Builder
	offset := float64(0)
	for i := 0; i < 30; i++ {
		p := h.ok("fs_read", map[string]any{"path": "u.txt", "offset": offset, "limit": 10})
		got.WriteString(p["content"].(string))
		if p["next_offset"] == nil {
			break
		}
		offset = p["next_offset"].(float64)
	}
	if got.String() != content {
		t.Fatalf("pages = %q", got.String())
	}

	// An arbitrary offset inside a character skips to the next boundary and says
	// where it really started.
	mid := h.ok("fs_read", map[string]any{"path": "u.txt", "offset": 4, "limit": 9})
	if mid["status"] != "ok" || mid["offset"].(float64) != 6 {
		t.Fatalf("mid-character offset: %v", mid)
	}
}

func TestFsReadStatuses(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "bin.dat"), append([]byte("MZ\x00\x01"), make([]byte, 100)...))
	writeFile(t, filepath.Join(root, "latin.txt"), []byte("caf\xe9 au lait\n"))
	writeFile(t, filepath.Join(root, "empty.txt"), nil)
	h := startHost(t, harnessOptions{root: root, disableWatcher: true})
	h.expect("host_init")

	bin := h.ok("fs_read", map[string]any{"path": "bin.dat"})
	if bin["status"] != "binary" || bin["content"] != "" {
		t.Fatalf("binary: %v", bin)
	}
	non := h.ok("fs_read", map[string]any{"path": "latin.txt"})
	if non["status"] != "non_utf8" || non["content"] != "" {
		t.Fatalf("non_utf8: %v", non)
	}
	empty := h.ok("fs_read", map[string]any{"path": "empty.txt"})
	if empty["status"] != "ok" || empty["total_lines"].(float64) != 0 || empty["truncated"] != false {
		t.Fatalf("empty: %v", empty)
	}
}

func TestFsReadBytes(t *testing.T) {
	root := t.TempDir()
	payload := []byte{0x89, 'P', 'N', 'G', 0, 1, 2, 3}
	writeFile(t, filepath.Join(root, "p.png"), payload)
	h := startHost(t, harnessOptions{root: root, disableWatcher: true})
	h.expect("host_init")

	data := h.ok("fs_read_bytes", map[string]any{"path": "p.png"})
	raw, err := base64.StdEncoding.DecodeString(data["data"].(string))
	if err != nil || string(raw) != string(payload) {
		t.Fatalf("payload mismatch: %v %v", raw, err)
	}
	if data["mime"] != "image/png" || data["size"].(float64) != 8 {
		t.Fatalf("meta: %v", data)
	}
	h.fail("fs_read_bytes", map[string]any{"path": "p.png", "max": 4}, CodeTooLarge)
	h.fail("fs_read_bytes", map[string]any{"path": "."}, CodeBadRequest)
}
