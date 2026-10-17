package memory

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// The on-disk layout, exactly as the design describes it:
//
//	<workspace>/.tudouni/memory/
//	  config.json
//	  index.json
//	  entries/      published memories — the fact
//	  candidates/   proposals waiting for review
//	  archive/      deprecated memories and superseded revisions
//
// No extra directories, and in particular no per-kind directories: the design's
// first principle is one model for everything, and a `workarounds/` beside a
// `preferences/` is that principle being contradicted by the filesystem.
const (
	// DirName is the directory under `.tudouni`.
	DirName = "memory"

	entriesDirName    = "entries"
	candidatesDirName = "candidates"
	archiveDirName    = "archive"
	archiveEntries    = "entries"
	indexFileName     = "index.json"
	configFileName    = "config.json"
	lockFileName      = "write.lock"
	tempPrefix        = ".tmp-"
)

// lockStaleAfter is when a lock file is considered abandoned.
//
// A lock is created by a publishing runtime and removed by the same one. A process
// killed between those two points leaves the file behind, and a memory system that
// then refuses to publish for ever is worse than the concurrent write the lock
// exists to prevent — so an old lock is stolen. The number is far above the
// longest critical section (a few writes and a rename) and far below the patience
// of a person pressing a button.
const lockStaleAfter = 30 * time.Second

// lockTimeout bounds how long a publish waits for another runtime's lock.
//
// Several runtimes run at once in one workspace (one per open session), so this is
// a real wait and not a formality; it is short because the work being serialised
// is short, and a person is watching a button.
const lockTimeout = 3 * time.Second

// repository is the file layout. It holds no cached state: every caller goes to
// the disk, which is what keeps "the files are the fact" true rather than a claim.
type repository struct {
	root string
}

func newRepository(root string) *repository { return &repository{root: root} }

func (r *repository) entriesDir() string    { return filepath.Join(r.root, entriesDirName) }
func (r *repository) candidatesDir() string { return filepath.Join(r.root, candidatesDirName) }
func (r *repository) archiveDir() string    { return filepath.Join(r.root, archiveDirName) }
func (r *repository) archives() string      { return filepath.Join(r.archiveDir(), archiveEntries) }
func (r *repository) indexPath() string     { return filepath.Join(r.root, indexFileName) }
func (r *repository) configPath() string    { return filepath.Join(r.root, configFileName) }

// ensureDirs creates the tree. It is the only operation whose failure aborts
// Open: without directories there is no memory at all, while a broken file inside
// them is a thing that can be reported and worked around.
func (r *repository) ensureDirs() error {
	for _, dir := range []string{r.root, r.entriesDir(), r.candidatesDir(), r.archives()} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("creating %s: %w", dir, err)
		}
	}
	return nil
}

// listIDs returns the file stems of one directory, sorted.
//
// The stem **is** the id. That is an invariant rather than a convention: `Get` and
// `Publish` both resolve an id to a filename, and two files claiming the same id —
// `mem_001.md` and `mem_001.markdown` — would make "which one is mem_001" depend
// on directory order.
func (r *repository) listIDs(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".md") || strings.HasPrefix(name, tempPrefix) {
			continue
		}
		ids = append(ids, strings.TrimSuffix(name, ".md"))
	}
	sort.Strings(ids)
	return ids, nil
}

// load reads one memory from a directory, with a report that names the file.
//
// The path goes into the error because a broken memory has to be findable: "cannot
// read the frontmatter" with no path sends somebody looking through the whole
// directory, and one stray file there makes every search fall back to nothing.
func (r *repository) load(dir, id string) (*Entry, error) {
	path := filepath.Join(dir, id+".md")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	entry, err := ParseEntry(string(raw))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if entry.ID == "" {
		entry.ID = id
	}
	if entry.ID != id {
		return nil, fmt.Errorf("%s declares id %q but its file is named %q",
			path, entry.ID, id)
	}
	return entry, nil
}

// loadAll reads every memory in a directory, skipping (and reporting) the ones
// that will not parse.
//
// A broken file must not take the others with it: a workspace with forty memories
// and one bad line still has forty usable ones, and refusing all of them because
// of the forty-first is how a memory system becomes something people switch off.
func (r *repository) loadAll(dir string) ([]*Entry, []string) {
	ids, err := r.listIDs(dir)
	if err != nil {
		return nil, []string{fmt.Sprintf("cannot list %s: %v", dir, err)}
	}
	out := make([]*Entry, 0, len(ids))
	var problems []string
	for _, id := range ids {
		entry, err := r.load(dir, id)
		if err != nil {
			problems = append(problems, err.Error())
			continue
		}
		out = append(out, entry)
	}
	return out, problems
}

// save writes one memory atomically into a directory.
func (r *repository) save(dir, id string, entry *Entry) error {
	return writeAtomic(filepath.Join(dir, id+".md"), []byte(entry.Render()))
}

// writeAtomic replaces a file in one step.
//
// Write to a temp file in the same directory, fsync, then rename. The rename is
// what makes the transition atomic from a reader's point of view, and the fsync is
// what stops a power loss from leaving a zero-length memory where a real one used
// to be. The rename also keeps Windows working: Go's os.Rename replaces an
// existing destination there, so the same code path serves both platforms.
func writeAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	file, err := os.CreateTemp(dir, tempPrefix+"*")
	if err != nil {
		return fmt.Errorf("creating a temporary file beside %s: %w", path, err)
	}
	temp := file.Name()
	cleanup := func() {
		file.Close()
		os.Remove(temp)
	}
	if _, err := file.Write(data); err != nil {
		cleanup()
		return fmt.Errorf("writing %s: %w", temp, err)
	}
	if err := file.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("flushing %s: %w", temp, err)
	}
	if err := file.Close(); err != nil {
		os.Remove(temp)
		return fmt.Errorf("closing %s: %w", temp, err)
	}
	if err := os.Rename(temp, path); err != nil {
		os.Remove(temp)
		return fmt.Errorf("replacing %s: %w", path, err)
	}
	return nil
}

// lock takes the cross-process write lock and returns the release function.
//
// Several runtimes share a workspace — one child per open session — so an
// in-process mutex is not enough: two sessions publishing at the same instant
// would each read the index, each write their own version, and the second write
// would silently undo the first. The lock is a file created with O_EXCL, which is
// atomic on every platform this program ships on.
func (r *repository) lock() (func(), error) {
	path := filepath.Join(r.root, lockFileName)
	deadline := time.Now().Add(lockTimeout)
	for {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			fmt.Fprintf(file, "%d %s\n", os.Getpid(), time.Now().Format(time.RFC3339))
			file.Close()
			return func() { os.Remove(path) }, nil
		}
		if !os.IsExist(err) {
			// A directory that does not exist, or a permission problem: the caller
			// is told, because guessing "no lock is fine" is how two writers end up
			// in one file.
			return nil, fmt.Errorf("taking the memory write lock: %w", err)
		}
		if info, statErr := os.Stat(path); statErr == nil && time.Since(info.ModTime()) > lockStaleAfter {
			os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("another process is writing to this workspace's memory (waited %s)", lockTimeout)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// nextID returns the next free id in a numbered series (`mem_003`).
//
// The number is one past the highest existing one, read from the files. It is
// deliberately not "count + 1": after a deprecation the count and the highest
// number differ, and reusing a number would let a new memory inherit the archive
// entry of an old one with the same id.
func nextID(prefix string, existing []string) string {
	highest := 0
	for _, id := range existing {
		if !strings.HasPrefix(id, prefix+"_") {
			continue
		}
		number := 0
		if _, err := fmt.Sscanf(strings.TrimPrefix(id, prefix+"_"), "%d", &number); err != nil {
			continue
		}
		if number > highest {
			highest = number
		}
	}
	return fmt.Sprintf("%s_%03d", prefix, highest+1)
}

// maxMTimes maps each memory file name to its modification time in unix
// nanoseconds, which is how an external edit is noticed.
func (r *repository) mtimes(dir string) map[string]int64 {
	out := map[string]int64{}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		out[strings.TrimSuffix(entry.Name(), ".md")] = info.ModTime().UnixNano()
	}
	return out
}
