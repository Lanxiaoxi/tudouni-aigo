// Package files is the workspace's file-system capability: one directory listing
// and one file read.
//
// It is deliberately not a second file tool. The agent's `read_file` /
// `list_files` in `internal/tools/builtin` answer the *model*, with descriptions
// written for it and results shaped for a transcript; this answers a **front
// end**, which wants the same two facts in a shape it can draw. What the two must
// share is the boundary, and they do: both resolve through `tools.Workspace`, so
// `../../other-project` is refused here for exactly the same reason and by
// exactly the same code as it is there. A second path check would be a second
// door, and one of them would eventually be unguarded.
//
// The vocabulary is **workspace-relative throughout**. `Path` on every entry is
// what a caller sends back, and the empty string means the workspace root. That
// is not a convenience: a front end that had to join a root to a name is a front
// end doing path arithmetic, which is where escapes come from.
package files

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// Entry types. They are the protocol's two values and there is no third: a
// symlink is reported as whatever it points at (see List), because a front end
// that had to resolve one would need the boundary this package exists to hold.
const (
	TypeFile      = "file"
	TypeDirectory = "directory"
)

// Entry is one row of a directory listing.
type Entry struct {
	// Name is the last path component, for display.
	Name string
	// Path is the whole workspace-relative path, for sending back. It is the
	// field a front end uses; `Name` is the one it shows.
	Path string
	Type string
	// Size is the file's byte length, and 0 for a directory — not "unknown".
	// A directory has no meaningful size on any of the three platforms this
	// builds for, and a number derived from "the bytes in its own inode" is a
	// number that means nothing to a person and would be shown anyway.
	Size int64
}

// Row is the wire form. It is defined here, once, so the protocol layer carries
// it and no front end has to be told a second time what a directory row looks
// like.
func (e Entry) Row() map[string]any {
	return map[string]any{
		"name": e.Name,
		"path": e.Path,
		"type": e.Type,
		"size": e.Size,
	}
}

// Content is one file, read and measured.
type Content struct {
	// Path is the workspace-relative path that was resolved — normalised, so
	// `./src/../src/main.go` comes back as `src/main.go` and a caller echoing it
	// does not create the impression of two files.
	Path string
	// Text is the whole body. **It does not travel whole** on the protocol: the
	// runtime stores it as an Artifact and sends a preview plus the reference, for
	// the same reason a tool result does — a session file is appended to, and a
	// multi-megabyte body written into it costs the size of that body every round.
	Text string
	// Chars and Bytes are two numbers because they answer two questions. A UTF-8
	// file of Chinese text is three times the bytes of its characters, and "how
	// long is this" wants the first while "how big is this" wants the second.
	Chars int
	Bytes int
	// TotalLines counts lines the way an editor and `grep -n` do (see countLines).
	TotalLines int
}

// Service reads a workspace's files. It has no state beyond the boundary.
type Service struct {
	workspace *tools.Workspace
}

// NewService resolves the workspace root once, the same way an agent's file tools
// do, so the boundary a terminal's cwd and this share is one object.
func NewService(root string) (*Service, error) {
	workspace, err := tools.NewWorkspace(root)
	if err != nil {
		return nil, err
	}
	return &Service{workspace: workspace}, nil
}

// NewServiceFromWorkspace shares a boundary that has already been resolved.
//
// It exists so the runtime can hand the file tools' own `*tools.Workspace` to
// this service instead of resolving the root a second time. Two resolutions of
// one root would be two objects that agree today and are free to stop agreeing
// tomorrow — and the day they disagree, one door is guarded and the other is not.
func NewServiceFromWorkspace(workspace *tools.Workspace) *Service {
	return &Service{workspace: workspace}
}

// Root is the resolved workspace directory.
func (s *Service) Root() string { return s.workspace.Root() }

// List reads one directory level.
//
// It returns the **normalised** path as well as the entries, and the caller sends
// that back rather than the one it was given: answering a request for `./src` with
// rows under `src` while the response says `./src` gives a front end two spellings
// of one directory, and the next request it builds depends on which it kept.
//
// Sorting happens here rather than in each front end. Directories first, then
// names case-insensitively — the order a person scanning a file tree expects, and
// one order instead of three.
func (s *Service) List(path string) (string, []Entry, error) {
	target, err := s.workspace.SafePath(path)
	if err != nil {
		return "", nil, err
	}
	info, statErr := os.Stat(target)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			return "", nil, fmt.Errorf("no such path in this workspace: %s", display(path))
		}
		return "", nil, statErr
	}
	if !info.IsDir() {
		return "", nil, fmt.Errorf("not a directory: %s", display(path))
	}

	raw, readErr := os.ReadDir(target)
	if readErr != nil {
		return "", nil, readErr
	}
	normalised, err := s.relative(target)
	if err != nil {
		return "", nil, err
	}

	entries := make([]Entry, 0, len(raw))
	for _, item := range raw {
		row, ok := s.entry(target, normalised, item)
		if !ok {
			continue
		}
		entries = append(entries, row)
	}
	sortEntries(entries)
	return normalised, entries, nil
}

// entry turns one directory item into a row, following a link to decide its type.
//
// **A link is resolved before the row is written**, and that is a decision rather
// than a detail. A front end draws a directory as something it can open; a
// symlink to a directory that was drawn as a file would be un-openable, and its
// target could not be reached from the tree at all. Resolving it here means the
// boundary has already been consulted — the target is inside the workspace or the
// row is left out — so opening it is safe by construction.
//
// A link that cannot be resolved (broken, or pointing outside) is **omitted**
// rather than reported as a file. There is nothing a front end can do with it:
// opening it fails, and the boundary that refusal comes from belongs to this
// package. Silent omission of a broken link inside a directory listing is the
// honest reading of "this row has no meaning".
func (s *Service) entry(dir, relative string, item os.DirEntry) (Entry, bool) {
	name := item.Name()
	child := filepath.Join(dir, name)
	childRelative := name
	if relative != "" {
		childRelative = relative + "/" + name
	}

	info, err := item.Info()
	if err != nil {
		return Entry{}, false
	}
	if info.Mode()&os.ModeSymlink != 0 {
		resolved, err := s.workspace.SafePath(child)
		if err != nil {
			return Entry{}, false
		}
		target, err := os.Stat(resolved)
		if err != nil {
			return Entry{}, false
		}
		info = target
	}

	// Dotfiles are listed. `.gitignore`, `.env.example` and the rest are part of
	// what a workspace looks like, and a listing that hid them would send somebody
	// looking for a file that is plainly there. Only two kinds of entry are
	// dropped: any that could not be stat'd, and links that lead out.
	row := Entry{Name: name, Path: childRelative}
	if info.IsDir() {
		row.Type = TypeDirectory
	} else {
		row.Type = TypeFile
		row.Size = info.Size()
	}
	return row, true
}

// Read reads one text file.
//
// A body that is not valid UTF-8 is refused with a sentence rather than being
// returned as a Go string with replacement characters in it. The two differences
// that matter: a front end can draw the refusal and offer the file to some other
// program, while mojibake looks like a successful read of a corrupt file — and it
// would be written into an Artifact, so the corruption would outlive the session.
func (s *Service) Read(path string) (Content, error) {
	target, err := s.workspace.SafePath(path)
	if err != nil {
		return Content{}, err
	}
	info, statErr := os.Stat(target)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			return Content{}, fmt.Errorf("no such file in this workspace: %s", display(path))
		}
		return Content{}, statErr
	}
	if info.IsDir() {
		return Content{}, fmt.Errorf("not a file: %s (use file_list for a directory)", display(path))
	}

	raw, readErr := os.ReadFile(target)
	if readErr != nil {
		return Content{}, readErr
	}
	if !utf8.Valid(raw) {
		return Content{}, fmt.Errorf("not UTF-8 text, so it cannot be shown here: %s", display(path))
	}
	normalised, err := s.relative(target)
	if err != nil {
		return Content{}, err
	}
	text := string(raw)
	return Content{
		Path:       normalised,
		Text:       text,
		Chars:      utf8.RuneCountInString(text),
		Bytes:      len(raw),
		TotalLines: countLines(text),
	}, nil
}

// relative is the workspace-relative spelling of an absolute path inside it.
//
// Separators are converted to `/` on the way out. The wire vocabulary is the one
// a person types, and on Windows `filepath.Rel` answers `src\main.go` — a front
// end would then have to normalise it, and a front end doing path arithmetic is
// precisely what the boundary exists to make unnecessary.
func (s *Service) relative(target string) (string, error) {
	root := s.workspace.Root()
	if target == root {
		// The root is the empty string, the same value the protocol uses for "the
		// workspace itself". `"."` would be a second spelling of one fact.
		return "", nil
	}
	relative, err := filepath.Rel(root, target)
	if err != nil {
		return "", err
	}
	return filepath.ToSlash(relative), nil
}

// sortEntries orders directories first, then names case-insensitively.
//
// Two keys, and the tie-break matters: two names that differ only in case are
// distinct on Linux and the same on Windows. Falling back to the byte order keeps
// the result a total order on both, so the listing a person sees does not shuffle
// between two runs on one machine.
func sortEntries(entries []Entry) {
	sort.SliceStable(entries, func(i, j int) bool {
		left, right := entries[i], entries[j]
		if (left.Type == TypeDirectory) != (right.Type == TypeDirectory) {
			return left.Type == TypeDirectory
		}
		lowerLeft, lowerRight := strings.ToLower(left.Name), strings.ToLower(right.Name)
		if lowerLeft != lowerRight {
			return lowerLeft < lowerRight
		}
		return left.Name < right.Name
	})
}

// countLines counts lines the way an editor does: a trailing newline terminates
// the last line rather than starting an empty one, and an empty file has none.
//
// Matching the artifact store's own splitter is the point — "12 lines" has to
// mean the same thing whether it came from a read or from a range the model asked
// for, or a line number quoted back is off by one.
func countLines(text string) int {
	if text == "" {
		return 0
	}
	count := strings.Count(text, "\n")
	if !strings.HasSuffix(text, "\n") {
		count++
	}
	return count
}

// display renders a path for an error message. The empty string is the workspace
// itself, and "no such path in this workspace: " with nothing after the colon
// tells the reader nothing.
func display(path string) string {
	if path == "" {
		return "."
	}
	return path
}
