package protocol

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/files"
)

// realFileRuntime is a Runtime whose file capability is the real
// internal/files.Service over a real directory on this machine — not a map of
// canned answers like terminalStub's. It exists for one claim this phase's
// design makes and that nothing elsewhere in this package actually exercises
// end to end: file_list/file_read already run on **whatever machine the
// runtime process is executing on**, with no code path that is aware of
// "local" or "remote" at all.
//
// Phase 1 made the Runtime itself able to run on a remote host, reached over
// SSH (RemoteBackend). This type is how Phase 2's own requirement — that a
// desktop front end can browse a remote workspace through this same
// file_list/file_read protocol, with the same path-escape boundary — is
// verified without actually opening an SSH connection: the file-serving layer
// below the dispatch in workspace_handlers.go has no branch for where the
// process is running, so a Runtime pointed at an ordinary temp directory on
// this machine exercises exactly the code a remote-hosted process would run,
// against its own (remote) filesystem.
type realFileRuntime struct {
	stubRuntime
	service *files.Service
}

func newRealFileRuntime(t *testing.T) (*realFileRuntime, string) {
	t.Helper()
	root := t.TempDir()
	service, err := files.NewService(root)
	if err != nil {
		t.Fatalf("files.NewService: %v", err)
	}
	return &realFileRuntime{service: service}, service.Root()
}

func (r *realFileRuntime) ListFiles(path string) (map[string]any, error) {
	normalised, entries, err := r.service.List(path)
	if err != nil {
		return nil, err
	}
	rows := make([]any, 0, len(entries))
	for _, entry := range entries {
		rows = append(rows, entry.Row())
	}
	return map[string]any{"path": normalised, "entries": rows}, nil
}

func (r *realFileRuntime) ReadFile(path string) (map[string]any, error) {
	content, err := r.service.Read(path)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"path": content.Path, "artifact_id": "", "content": content.Text,
		"chars": content.Chars, "bytes": content.Bytes, "truncated": false,
		"total_lines": content.TotalLines,
	}, nil
}

// TestFileListServesWhicheverFilesystemTheRuntimeProcessIsOn is the Phase 2
// claim stated as a test: the server's file_list dispatch, run against a real
// directory, returns exactly what is on that directory's disk — the same
// path the design's §7.2 calls "the far end's own job" once the runtime is
// the thing running there.
func TestFileListServesWhicheverFilesystemTheRuntimeProcessIsOn(t *testing.T) {
	runtime, root := newRealFileRuntime(t)
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	raw := driveServer(t, runtime, map[string]any{"v": VERSION, "t": InFileList, "path": ""})
	message := onlyMessage(t, raw)
	if TypeOf(message) != OutUI {
		t.Fatalf("file_list answered with %v, want a ui message", message)
	}
	entries, ok := message["entries"].([]any)
	if !ok || len(entries) != 1 {
		t.Fatalf("entries = %v, want exactly one row (src/)", message["entries"])
	}
}

// TestFileReadServesWhicheverFilesystemTheRuntimeProcessIsOn is file_read's
// half of the same claim.
func TestFileReadServesWhicheverFilesystemTheRuntimeProcessIsOn(t *testing.T) {
	runtime, root := newRealFileRuntime(t)
	if err := os.WriteFile(filepath.Join(root, "notes.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	raw := driveServer(t, runtime, map[string]any{"v": VERSION, "t": InFileRead, "path": "notes.txt"})
	message := onlyMessage(t, raw)
	if TypeOf(message) != OutUI {
		t.Fatalf("file_read answered with %v, want a ui message", message)
	}
	if message["content"] != "hello\n" {
		t.Errorf("content = %v, want %q", message["content"], "hello\n")
	}
}

// TestFileListRejectsAnEscapeRegardlessOfWhereTheWorkspaceLives is §7.5's own
// requirement, proven at the same layer the previous two tests exercise: the
// path-escape boundary is tools.Workspace.SafePath, reached through
// files.Service, with no branch anywhere above it for "but this one is
// remote, go easier." A RemoteBackend session asking the far end's own
// runtime process to list ".." runs into exactly this refusal, on that
// process's own filesystem, because the boundary travels with the runtime
// rather than living in the transport.
func TestFileListRejectsAnEscapeRegardlessOfWhereTheWorkspaceLives(t *testing.T) {
	runtime, _ := newRealFileRuntime(t)

	raw := driveServer(t, runtime, map[string]any{"v": VERSION, "t": InFileList, "path": "../../etc"})
	message := onlyMessage(t, raw)
	if TypeOf(message) != OutNotice {
		t.Fatalf("file_list(..) answered with %v, want a refusal notice", message)
	}
}

// TestFileReadRejectsAnEscapeRegardlessOfWhereTheWorkspaceLives is file_read's
// half of the same proof.
func TestFileReadRejectsAnEscapeRegardlessOfWhereTheWorkspaceLives(t *testing.T) {
	runtime, root := newRealFileRuntime(t)
	// A real file that exists, but outside the workspace root — the case that
	// matters: SafePath has to refuse this on the resolved path, not merely on
	// the literal string "..".
	outside := filepath.Join(filepath.Dir(root), "secret.txt")
	if err := os.WriteFile(outside, []byte("do not read this\n"), 0o600); err != nil {
		t.Fatalf("write outside the workspace: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(outside) })

	raw := driveServer(t, runtime, map[string]any{
		"v": VERSION, "t": InFileRead, "path": "../secret.txt",
	})
	message := onlyMessage(t, raw)
	if TypeOf(message) != OutNotice {
		t.Fatalf("file_read(../secret.txt) answered with %v, want a refusal notice", message)
	}
}
