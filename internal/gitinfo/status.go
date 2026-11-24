package gitinfo

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// MaxEntries caps the entries of one status. A fresh `npm install` without a
// .gitignore produces hundreds of thousands, and the panel cannot show them
// anyway; `Truncated` says the list is not the whole truth.
const MaxEntries = 2000

// Status is the wire shape of `git_status`.
type Status struct {
	Repo      bool    `json:"repo"`
	Branch    string  `json:"branch"`
	Head      string  `json:"head"`
	Upstream  string  `json:"upstream"`
	Ahead     int     `json:"ahead"`
	Behind    int     `json:"behind"`
	Detached  bool    `json:"detached"`
	Unborn    bool    `json:"unborn"`
	Operation string  `json:"operation"`
	Entries   []Entry `json:"entries"`
	Truncated bool    `json:"truncated"`
}

// GetStatus reports the state of the repository around dir, limited to dir.
//
// A directory that is not in a repository is not an error: it returns
// `Status{Repo:false}` with an empty entry list. ErrNoGit is the only failure the
// caller has to map, because it means the capability itself is missing.
func GetStatus(ctx context.Context, dir string) (*Status, error) {
	empty := &Status{Entries: []Entry{}}
	repo, err := Open(ctx, dir)
	if err == ErrNotRepo {
		return empty, nil
	}
	if err != nil {
		return nil, err
	}

	// `-- .` limits the report to the workspace subtree; the paths in the answer
	// are still root-relative, which is what `relativize` undoes. `-uall` lists
	// untracked files one by one: the default collapses a new directory into one
	// `dir/` row, which a file tree cannot place a badge on.
	out, stderr, code, err := run(ctx, dir, "status", "--porcelain=v2", "--branch", "-z",
		"--untracked-files=all", "--", ".")
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, fmt.Errorf("git status failed (exit %d): %s", code, strings.TrimSpace(stderr))
	}

	raw := parseStatus(out)
	status := &Status{
		Repo:      true,
		Branch:    raw.Branch,
		Upstream:  raw.Upstream,
		Ahead:     raw.Ahead,
		Behind:    raw.Behind,
		Detached:  raw.Detached,
		Unborn:    raw.Unborn,
		Operation: repo.Operation(),
		Entries:   make([]Entry, 0, len(raw.Entries)),
	}
	if len(raw.OID) >= 7 {
		status.Head = raw.OID[:7]
	} else {
		status.Head = raw.OID
	}

	for _, entry := range raw.Entries {
		path, inside := relativize(entry.Path, repo.Prefix, false)
		if !inside {
			// The pathspec should have excluded it; this is the second line of
			// defence for "nothing outside the workspace reaches the UI".
			continue
		}
		entry.Path = path
		if entry.OrigPath != "" {
			entry.OrigPath, _ = relativize(entry.OrigPath, repo.Prefix, true)
		}
		status.Entries = append(status.Entries, entry)
	}
	sort.Slice(status.Entries, func(i, j int) bool { return status.Entries[i].Path < status.Entries[j].Path })
	if len(status.Entries) > MaxEntries {
		status.Entries = status.Entries[:MaxEntries]
		status.Truncated = true
	}
	return status, nil
}
