package host

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/fsnotify/fsnotify"
)

// Watcher feeds an EventHub from the operating system's change notifications.
//
// fsnotify v1.8 watches one directory per Add (no recursion on any platform), so
// the tree is walked and every directory added, and directories that appear later
// are added as their create events arrive. Three consequences shape the code:
//
//   - **Ignored trees are never added.** node_modules, dist, target and the code
//     index are the directories that make recursive watching expensive (inotify's
//     watch limit, ReadDirectoryChangesW's buffer), and nothing a person browses
//     lives in them.
//   - **A new directory is scanned when it is added.** `mkdir -p a/b && touch
//     a/b/c` can finish before the watch on `a` exists, so the files already inside
//     are reported as created instead of being lost in the gap.
//   - **Anything that may have been missed becomes a reset.** An overflow, a watcher
//     error or a directory that could not be watched all say "the picture may be
//     incomplete", and the honest answer is to ask the front end to resync.
type Watcher struct {
	root string
	fw   *fsnotify.Watcher
	hub  *EventHub
	logf func(string, ...any)

	// walks queues directories whose watches still have to be added. Adding a
	// watch must never happen on the goroutine that drains fsnotify's Events:
	// fsnotify serves Add from its own reader, and that reader can be blocked
	// handing us the next event, so an Add from the event loop deadlocks both
	// (on Windows a burst of `mkdir`s was enough). The walker goroutine owns
	// every Add after start-up.
	walks chan walkRequest

	done chan struct{}
	wg   sync.WaitGroup
	once sync.Once
}

type walkRequest struct {
	dir    string
	report bool
}

// walkQueueLen bounds pending directory walks. Overflow is not waited out (the
// event loop must not block); it becomes a reset, like any other lost coverage.
const walkQueueLen = 4096

// ignoredDirNames are skipped wherever they occur: they are build output or
// dependency trees, large and constantly changing.
var ignoredDirNames = map[string]bool{
	"node_modules": true,
	"dist":         true,
	"target":       true,
}

// skipDir reports whether a workspace-relative directory is left unwatched.
func skipDir(rel string) bool {
	if rel == ".tudouni/index" || strings.HasPrefix(rel, ".tudouni/index/") {
		return true
	}
	name := rel
	if i := strings.LastIndexByte(rel, '/'); i >= 0 {
		name = rel[i+1:]
	}
	return ignoredDirNames[name]
}

// watchableDir reports whether a directory should get a watch.
//
// `.git` is the special case: only its top level (HEAD, index, MERGE_HEAD, ...)
// and `refs/` are watched. The object store is where the churn is, and none of it
// changes what a status panel would show that refs and the index do not.
func watchableDir(rel string) bool {
	if rel == ".git" || rel == ".git/refs" || strings.HasPrefix(rel, ".git/refs/") {
		return true
	}
	if rel == ".git" || strings.HasPrefix(rel, ".git/") {
		return false
	}
	return !skipDir(rel)
}

// gitFileRelevant reports whether a path inside `.git` is worth an event.
func gitFileRelevant(inside string) bool {
	if strings.HasSuffix(inside, ".lock") {
		// A lock file is a transient: its removal is followed by the real change.
		return false
	}
	if inside == "refs" || strings.HasPrefix(inside, "refs/") {
		return true
	}
	switch inside {
	case "HEAD", "index", "packed-refs", "MERGE_HEAD", "CHERRY_PICK_HEAD",
		"REVERT_HEAD", "BISECT_LOG", "ORIG_HEAD":
		return true
	}
	return strings.HasPrefix(inside, "REBASE_") || strings.HasPrefix(inside, "rebase-")
}

// StartWatcher begins watching root. It returns once the root itself is watched,
// which is what decides whether `file_watch` can be advertised; the rest of the
// tree is added in the background so a huge workspace does not delay the handshake.
func StartWatcher(root string, hub *EventHub, logf func(string, ...any)) (*Watcher, error) {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	if err := fw.Add(root); err != nil {
		fw.Close()
		return nil, err
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	w := &Watcher{
		root: root, fw: fw, hub: hub, logf: logf,
		walks: make(chan walkRequest, walkQueueLen),
		done:  make(chan struct{}),
	}
	w.walks <- walkRequest{dir: root}
	w.wg.Add(2)
	go func() {
		defer w.wg.Done()
		w.walker()
	}()
	go func() {
		defer w.wg.Done()
		w.loop()
	}()
	return w, nil
}

// walker performs queued walks, the initial one first.
func (w *Watcher) walker() {
	for {
		select {
		case <-w.done:
			return
		case req := <-w.walks:
			w.walk(req.dir, req.report)
		}
	}
}

// queueWalk hands a directory to the walker without ever blocking the caller.
func (w *Watcher) queueWalk(dir string, report bool) {
	select {
	case w.walks <- walkRequest{dir: dir, report: report}:
	default:
		w.logf("watch queue full; asking for a resync")
		w.hub.Reset()
	}
}

// Close stops the watcher and waits for its goroutines.
func (w *Watcher) Close() {
	w.once.Do(func() {
		close(w.done)
		_ = w.fw.Close()
	})
	w.wg.Wait()
}

func (w *Watcher) rel(path string) (string, bool) {
	rel, err := filepath.Rel(w.root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	if rel == "." {
		return "", true
	}
	return filepath.ToSlash(rel), true
}

// walk adds watches below dir. With report set, what it finds is also reported as
// created (the "directory appeared while we were not looking" case).
func (w *Watcher) walk(dir string, report bool) {
	failures := 0
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		select {
		case <-w.done:
			return fs.SkipAll
		default:
		}
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		rel, ok := w.rel(path)
		if !ok {
			return nil
		}
		if !d.IsDir() {
			if report && d.Type()&fs.ModeSymlink == 0 {
				w.hub.Add(rel, ChangeCreated)
			}
			return nil
		}
		if path != dir || dir != w.root {
			if rel != "" && !watchableDir(rel) {
				if report && rel != ".git" && !strings.HasPrefix(rel, ".git/") {
					w.hub.Add(rel, ChangeCreated)
				}
				return fs.SkipDir
			}
		}
		// Links and junctions are not followed: a watch through one would report
		// paths outside the workspace.
		if d.Type()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
			return fs.SkipDir
		}
		if report && path != dir {
			w.hub.Add(rel, ChangeCreated)
		}
		if path != w.root {
			if err := w.fw.Add(path); err != nil {
				failures++
				w.logf("cannot watch %s: %v", rel, err)
			}
		}
		if rel == ".git" {
			// Only refs/ below .git is walked; everything else is skipped by
			// watchableDir on the way down.
			return nil
		}
		return nil
	})
	if failures > 0 {
		// Typically the inotify watch limit. Coverage is incomplete, and the front
		// end must not trust its caches to be kept fresh.
		w.hub.Reset()
	}
}

func (w *Watcher) loop() {
	for {
		select {
		case <-w.done:
			return
		case event, ok := <-w.fw.Events:
			if !ok {
				return
			}
			w.handle(event)
		case err, ok := <-w.fw.Errors:
			if !ok {
				return
			}
			// Overflow and every other watcher error alike: events may have been
			// lost, so the only safe statement is "resync".
			if !errors.Is(err, fsnotify.ErrClosed) {
				w.logf("watcher error: %v", err)
				w.hub.Reset()
			}
		}
	}
}

func (w *Watcher) handle(event fsnotify.Event) {
	rel, ok := w.rel(event.Name)
	if !ok || rel == "" {
		return
	}
	if rel == ".git" {
		w.hub.AddGit()
		if event.Has(fsnotify.Create) {
			w.queueWalk(event.Name, false)
		}
		return
	}
	if strings.HasPrefix(rel, ".git/") {
		inside := strings.TrimPrefix(rel, ".git/")
		if !gitFileRelevant(inside) {
			return
		}
		w.hub.AddGit()
		if event.Has(fsnotify.Create) && (inside == "refs" || strings.HasPrefix(inside, "refs/")) {
			if info, err := os.Lstat(event.Name); err == nil && info.IsDir() {
				w.queueWalk(event.Name, false)
			}
		}
		return
	}
	// A path inside an ignored tree can still be reported by its parent's watch
	// (the directory's own creation); nothing deeper is ever watched.
	switch {
	case event.Has(fsnotify.Create):
		info, err := os.Lstat(event.Name)
		if err == nil && info.IsDir() && info.Mode()&(fs.ModeSymlink|fs.ModeIrregular) == 0 {
			w.hub.Add(rel, ChangeCreated)
			if watchableDir(rel) {
				w.queueWalk(event.Name, true)
			}
			return
		}
		w.hub.Add(rel, ChangeCreated)
	case event.Has(fsnotify.Write):
		w.hub.Add(rel, ChangeModified)
	case event.Has(fsnotify.Remove):
		w.hub.Add(rel, ChangeDeleted)
	case event.Has(fsnotify.Rename):
		// fsnotify reports the name that went away; the name it arrived under
		// comes as its own Create.
		w.hub.Add(rel, ChangeRenamed)
	}
}
