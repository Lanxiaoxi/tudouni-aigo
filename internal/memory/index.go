package memory

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// IndexVersion is the shape of index.json this build writes.
const IndexVersion = 1

// Index is the derived retrieval data.
//
// Everything in it is reproducible from `entries/`, and that is the property the
// whole design leans on: a corrupt, truncated or hand-mangled index is repaired by
// deleting it, and the memories are still there. The index therefore holds no fact
// that is not also in a file — the body digest included, which is a lowercased
// excerpt of something that is on disk.
type Index struct {
	Version int `json:"version"`
	// BuiltAt is informational; correctness is decided by comparing the entry files
	// against `Entries` (see `indexMismatch`). A timestamp alone would trust the
	// clock, and two writes inside one second are not distinguishable by it.
	BuiltAt string       `json:"built_at"`
	Entries []IndexEntry `json:"entries"`
}

// IndexEntry is one memory's retrieval row.
type IndexEntry struct {
	ID string `json:"id"`
	// Revision is carried so the panel can show what is current without opening
	// files, and so a stale index is detectable in a way a person can read.
	Revision   int      `json:"revision"`
	Title      string   `json:"title"`
	File       string   `json:"file"`
	UpdatedAt  string   `json:"updated_at"`
	Confidence string   `json:"confidence"`
	Triggers   []string `json:"triggers"`
	Tags       []string `json:"tags"`
	ScopePaths []string `json:"scope_paths"`
	Digest     string   `json:"digest"`
	// MTime is the file's modification time in unix nanoseconds at the moment the
	// index was built. It is how an edit made **outside** this program — somebody
	// opening a memory in an editor — is noticed: ids alone would keep describing
	// the old text for ever, and a corpus that silently ignores edits is a corpus
	// that stops being trusted.
	MTime int64 `json:"mtime"`
}

// IndexStatus is what the panel needs to say about the index.
type IndexStatus struct {
	Entries int    `json:"entries"`
	BuiltAt string `json:"built_at"`
	// Rebuilt means this process found the file missing, stale or corrupt and
	// rebuilt it during the current open. It is worth showing: it is the difference
	// between "your index is fine" and "your index was broken and has been fixed".
	Rebuilt bool   `json:"rebuilt"`
	Problem string `json:"problem"`
}

// buildIndex reads every published memory and produces the retrieval rows.
//
// It returns the problems it hit alongside the index rather than failing: one
// unreadable memory must not make the other thirty unreachable.
func buildIndex(repo *repository) (*Index, []string) {
	entries, problems := repo.loadAll(repo.entriesDir())
	mtimes := repo.mtimes(repo.entriesDir())

	index := &Index{Version: IndexVersion, BuiltAt: nowStamp(), Entries: make([]IndexEntry, 0, len(entries))}
	for _, entry := range entries {
		index.Entries = append(index.Entries, IndexEntry{
			ID:         entry.ID,
			Revision:   entry.Revision,
			Title:      entry.Title,
			File:       entry.ID + ".md",
			UpdatedAt:  entry.UpdatedAt,
			Confidence: entry.Confidence,
			Triggers:   entry.Triggers,
			Tags:       entry.Tags,
			ScopePaths: entry.Scope.Paths,
			Digest:     entry.Digest(),
			MTime:      mtimes[entry.ID],
		})
	}
	return index, problems
}

// loadIndex returns the index, rebuilding it when the file is missing, unreadable,
// or does not describe what is actually in `entries/`.
func loadIndex(repo *repository) (*Index, IndexStatus, string) {
	status := IndexStatus{}
	raw, err := os.ReadFile(repo.indexPath())
	if err == nil {
		var index Index
		if decodeErr := json.Unmarshal(raw, &index); decodeErr == nil && index.Version == IndexVersion {
			if !indexMismatch(repo, &index) {
				status.Entries = len(index.Entries)
				status.BuiltAt = index.BuiltAt
				return &index, status, ""
			}
			// A stale index is not a problem to report; it is the design working.
			// Something changed on disk and the derived data follows the fact.
		}
	}

	index, problems := buildIndex(repo)
	status.Entries = len(index.Entries)
	status.BuiltAt = index.BuiltAt
	status.Rebuilt = true
	if err := saveIndex(repo, index); err != nil {
		// The in-memory index is still correct and usable; only persistence failed.
		// Reporting it matters because the next open will have to rebuild again.
		problem := fmt.Sprintf("the index could not be written (%v); it will be rebuilt on the next open", err)
		status.Problem = problem
		problems = append(problems, problem)
	}
	return index, status, strings.Join(problems, "; ")
}

// indexMismatch reports whether the index no longer describes the directory.
//
// Two checks, and both are needed: the id sets catch a memory added or deleted by
// something else, and the mtimes catch an edited one — the case ids cannot see and
// the one a person is most likely to create by opening a file in an editor.
func indexMismatch(repo *repository, index *Index) bool {
	known := make(map[string]int64, len(index.Entries))
	for _, row := range index.Entries {
		known[row.ID] = row.MTime
	}
	current := repo.mtimes(repo.entriesDir())
	if len(current) != len(known) {
		return true
	}
	for id, mtime := range current {
		recorded, present := known[id]
		if !present || recorded != mtime {
			return true
		}
	}
	return false
}

// saveIndex writes the index atomically.
func saveIndex(repo *repository, index *Index) error {
	if index.Version == 0 {
		index.Version = IndexVersion
	}
	payload, err := json.MarshalIndent(index, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	return writeAtomic(repo.indexPath(), payload)
}

// nowStamp is the timestamp format used for `built_at`.
//
// RFC3339 with nanoseconds: two rebuilds inside one second have to be
// distinguishable, because the panel shows the time and "built at the same second
// as the last one" would otherwise be a claim it cannot make.
func nowStamp() string { return time.Now().Format(time.RFC3339Nano) }

// today is the format used for `created_at` / `updated_at` on a memory.
//
// A date, not a timestamp: a memory's value is not its minute. It is also what the
// design's own example files carry, and a format mismatch would make every file
// written by a person and every file written by this program look different.
func today() string { return time.Now().Format("2006-01-02") }
