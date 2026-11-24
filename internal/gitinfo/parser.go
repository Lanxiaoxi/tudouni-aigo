package gitinfo

import (
	"strconv"
	"strings"
)

// Entry is one changed path.
//
// Index and Worktree are porcelain v2's single letters, kept apart: a file with
// staged and unstaged edits is `M` / `M`, and collapsing that into one "modified"
// is exactly the loss a Git panel exists to avoid.
type Entry struct {
	Path     string `json:"path"`
	OrigPath string `json:"orig_path"`
	// Index is the staged state ('.' = unchanged), Worktree the unstaged one.
	Index    string `json:"index"`
	Worktree string `json:"worktree"`
	Conflict bool   `json:"conflict"`
	// Untracked entries carry '?' in both columns.
	Untracked bool `json:"untracked"`
}

// parsed is the raw result of one `git status --porcelain=v2 --branch -z`.
// Paths are still relative to the repository root.
type parsed struct {
	Branch   string
	OID      string
	Upstream string
	Ahead    int
	Behind   int
	Detached bool
	Unborn   bool
	Entries  []Entry
}

// parseStatus parses `git status --porcelain=v2 --branch -z` output.
//
// With -z every record ends in NUL and paths are not quoted. A rename record
// ("2 ...") is followed by one extra NUL-terminated piece holding the original
// path, which is why the loop advances by hand.
func parseStatus(output string) parsed {
	var result parsed
	pieces := strings.Split(output, "\x00")
	for i := 0; i < len(pieces); i++ {
		piece := pieces[i]
		if piece == "" {
			continue
		}
		switch {
		case strings.HasPrefix(piece, "# branch.oid "):
			oid := strings.TrimPrefix(piece, "# branch.oid ")
			if oid == "(initial)" {
				result.Unborn = true
			} else {
				result.OID = oid
			}
		case strings.HasPrefix(piece, "# branch.head "):
			head := strings.TrimPrefix(piece, "# branch.head ")
			if head == "(detached)" {
				result.Detached = true
			} else {
				result.Branch = head
			}
		case strings.HasPrefix(piece, "# branch.upstream "):
			result.Upstream = strings.TrimPrefix(piece, "# branch.upstream ")
		case strings.HasPrefix(piece, "# branch.ab "):
			for _, field := range strings.Fields(strings.TrimPrefix(piece, "# branch.ab ")) {
				if len(field) < 2 {
					continue
				}
				n, _ := strconv.Atoi(field[1:])
				switch field[0] {
				case '+':
					result.Ahead = n
				case '-':
					result.Behind = n
				}
			}
		case strings.HasPrefix(piece, "1 "):
			// 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
			if parts := strings.SplitN(piece, " ", 9); len(parts) == 9 && len(parts[1]) == 2 {
				result.Entries = append(result.Entries, Entry{
					Path: parts[8], Index: parts[1][:1], Worktree: parts[1][1:],
				})
			}
		case strings.HasPrefix(piece, "2 "):
			// 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> NUL <orig>
			parts := strings.SplitN(piece, " ", 10)
			orig := ""
			if i+1 < len(pieces) {
				i++
				orig = pieces[i]
			}
			if len(parts) == 10 && len(parts[1]) == 2 {
				result.Entries = append(result.Entries, Entry{
					Path: parts[9], OrigPath: orig, Index: parts[1][:1], Worktree: parts[1][1:],
				})
			}
		case strings.HasPrefix(piece, "u "):
			// u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
			if parts := strings.SplitN(piece, " ", 11); len(parts) == 11 && len(parts[1]) == 2 {
				result.Entries = append(result.Entries, Entry{
					Path: parts[10], Index: parts[1][:1], Worktree: parts[1][1:], Conflict: true,
				})
			}
		case strings.HasPrefix(piece, "? "):
			result.Entries = append(result.Entries, Entry{
				Path: piece[2:], Index: "?", Worktree: "?", Untracked: true,
			})
		}
		// "! " (ignored) is never requested; anything else is a future record type
		// and is skipped rather than guessed at.
	}
	return result
}

// relativize rewrites a repository-root-relative path as workspace-relative.
//
// prefix is the workspace's own location with a trailing slash. ok is false when
// the path is outside the workspace. withDots lets a caller keep an out-of-tree
// path as `../x` (a rename's origin may legitimately lie outside the workspace,
// and dropping it would make the row look like a plain addition).
func relativize(path, prefix string, withDots bool) (string, bool) {
	if prefix == "" {
		return path, true
	}
	if strings.HasPrefix(path, prefix) {
		return strings.TrimPrefix(path, prefix), true
	}
	if !withDots {
		return "", false
	}
	// Walk up one `..` per prefix component not shared with the path.
	prefixParts := strings.Split(strings.TrimSuffix(prefix, "/"), "/")
	pathParts := strings.Split(path, "/")
	common := 0
	for common < len(prefixParts) && common < len(pathParts)-1 && prefixParts[common] == pathParts[common] {
		common++
	}
	up := strings.Repeat("../", len(prefixParts)-common)
	return up + strings.Join(pathParts[common:], "/"), true
}
