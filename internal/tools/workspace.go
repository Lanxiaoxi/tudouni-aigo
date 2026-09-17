package tools

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ControlPlane names what only a person and the program itself may write.
//
// `SafePath` answers "do not go outside"; it cannot answer "do not come in here".
// What lives in these paths is not task content — it decides whether this run can
// be trusted at all:
//
//	.tudouni/
//	  permissions.json   the permission policy. Write it and you can grant yourself
//	                     anything (put shell on the no-approval list).
//	  sessions/          the conversation history. Write it and you can forge a
//	                     record of the user having approved something.
//	  logs/              the audit log. Write it and you can erase the evidence of
//	                     who approved what.
//	  skills/            skills. Write it and you can rewrite your own instructions
//	                     for every turn from now on.
//
// Guarding one directory rather than naming four paths is deliberate: these are
// four parts of one thing (this run's own state), and adding a fifth needs no edit
// here. Naming them one by one would leak, and the same instinct is why
// auto_approve refuses "high": the scope of a rule has to be readable at a glance
// and must not widen on its own as new things are added.
//
// Guarding the directory rather than each file inside it is what makes the fourth
// entry the quietest and the most durable. A skill's body is spliced into every
// request after it is loaded, so being able to write it means rewriting your own
// instructions from then on — permanently, and with no permission event to show
// for it.
//
// The old locations stay in the list. The program no longer reads or writes them,
// but they may still be on disk holding the same kind of thing, and leaving them
// out would leave a writable road back to the old layout.
//
// Only writing is blocked. Reading these files is legitimate — the agent should be
// able to see its own project's policy, and a skill's body has to be readable —
// and an agent that cannot tell why it was refused just retries.
var ControlPlane = []string{".tudouni.json", ".tudouni", ".sessions", ".logs"}

// Workspace enforces the boundary around the directory the agent works in.
type Workspace struct {
	root string
}

// NewWorkspace resolves the workspace root once.
func NewWorkspace(root string) (*Workspace, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	// Resolve symlinks now, so a link created later pointing outside is still
	// caught: the comparison happens against the resolved root every time.
	if resolved, err := filepath.EvalSymlinks(absolute); err == nil {
		absolute = resolved
	}
	return &Workspace{root: absolute}, nil
}

// Root is the resolved workspace directory.
func (w *Workspace) Root() string { return w.root }

// SafePath resolves a path inside the workspace.
//
// The comparison is made on resolved paths, so `..` and symlinks both land on the
// same check — "create a link that points at .tudouni and write through it" goes
// through this door like everything else.
func (w *Workspace) SafePath(path string) (string, error) {
	target := path
	if !filepath.IsAbs(target) {
		target = filepath.Join(w.root, target)
	}
	absolute, err := filepath.Abs(target)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(absolute); err == nil {
		absolute = resolved
	}
	if !within(absolute, w.root) {
		return "", fmt.Errorf("Path escapes workspace")
	}
	return absolute, nil
}

// WritablePath resolves a path for a write and refuses the control plane.
//
// It is a separate function rather than a flag on SafePath because the two
// failures point in opposite directions: escaping is "should not go out",
// control plane is "should not come in". Merged, the read path would be blocked
// by the second check too, and reading these files is legitimate.
func (w *Workspace) WritablePath(path string) (string, error) {
	target, err := w.SafePath(path)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(w.root, target)
	if err != nil {
		return "", err
	}
	// Only the first path segment counts: the control plane is "that file and
	// those two directories at the root", not "anything with that name". A
	// `sub/.tudouni.json` further down is an ordinary file.
	first := rel
	if index := strings.IndexAny(rel, `/\`); index >= 0 {
		first = rel[:index]
	}
	for _, name := range ControlPlane {
		// Case is folded because Windows filesystems are case-insensitive, so
		// `.TUDOUNI.JSON` writes the same thing. On Linux it is another file, but
		// there is no reason to release either spelling.
		if strings.EqualFold(first, name) {
			return "", fmt.Errorf("Path is control plane, agent must not write it: %s", first)
		}
	}
	return target, nil
}

// ReadFile reads a UTF-8 text file inside the workspace.
func (w *Workspace) ReadFile(path string) (string, error) {
	target, err := w.SafePath(path)
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(target)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("File not found: %s", path)
		}
		if os.IsPermission(err) {
			return "", fmt.Errorf("Permission denied: %s", path)
		}
		return "", err
	}
	if !isUTF8(raw) {
		return "", fmt.Errorf("不是 UTF-8 文本，读不了：%s", path)
	}
	return string(raw), nil
}

// WriteFile writes a file inside the workspace, creating parent directories.
func (w *Workspace) WriteFile(path, content string) (string, error) {
	target, err := w.WritablePath(path)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		return "", err
	}
	return "Written: " + path, nil
}

// ListDir returns the entry names of one directory. One level, no recursion.
func (w *Workspace) ListDir(path string) ([]string, error) {
	target, err := w.SafePath(path)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("Directory not found: %s", path)
		}
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names, nil
}

// within reports whether path is root or lives under it.
func within(path, root string) bool {
	if path == root {
		return true
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	return !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != ".."
}

func isUTF8(raw []byte) bool {
	return utf8Valid(raw)
}
