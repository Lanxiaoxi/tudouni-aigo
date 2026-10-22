package runtime

// The code index, as the workbench panel and the model see it.
//
// One workspace, one index, and **two facts that are deliberately separate**:
//
//   - `enabled` is the person's permission, read from
//     `<workspace>/.tudouni/codeintel/config.json`. It decides whether the
//     `code_explore` tool is in the model's schema at all.
//   - `indexed`/`stale` is the filesystem's answer. An index can exist while the
//     switch is off (the person built one, then turned the capability off) and the
//     switch can be on with nothing to search (they turned it on and never pressed
//     init).
//
// Folding the two together would make one of those two states unrepresentable, and
// both are things a person actually reaches. The panel draws all four combinations.
//
// Nothing here rebuilds on its own. A build happens because somebody pressed a
// button, or because `code_explore` asked for a small inline catch-up — which is the
// tool's own path (internal/codeintel/refresh.go), not this one.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel/cggraph"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
)

// codeIntelProgressEvery throttles progress messages.
//
// The indexer reports per batch, which on a large tree is hundreds of times a second.
// A message per report would make the panel's progress the busiest channel on the wire
// for something a person reads at a glance — so a phase change always sends (it is the
// news) and within a phase at most this often. Each of these messages also reads the
// whole graph's counts, so twice a second is already more than the bar needs.
const codeIntelProgressEvery = 500 * time.Millisecond

// codeIntelRun is the last deliberate build this session ran, for the panel's "last
// run" line.
//
// Deliberately **in memory only**: it describes what this process did, and a saved
// copy would let a workspace open with a claim about a build that happened in a
// window somebody has since closed.
type codeIntelRun struct {
	Full       bool
	Files      int
	Nodes      int
	Edges      int
	Unresolved int
	Problem    string
	At         time.Time
}

// codeIntelState is one runtime's view of its workspace's index.
type codeIntelState struct {
	workspace *tools.Workspace
	refresher *codeintel.Refresher

	mu       sync.Mutex
	enabled  bool
	building bool
	phase    string
	done     int
	total    int
	last     *codeIntelRun

	// The config file's mtime as of the last read. `enabled` is a cache of a file
	// other processes write (one runtime child per conversation), so the cache has
	// to notice when somebody else replaced it.
	configSeen bool
	configMod  time.Time
	configSize int64
}

// newCodeIntelState builds the handle.
//
// `refresher` may carry no parser path, which is a state and not a nil: an index built
// earlier is still queryable, and the panel says the index cannot be updated rather
// than pretending there is no index.
func newCodeIntelState(workspace *tools.Workspace, refresher *codeintel.Refresher, enabled bool) *codeIntelState {
	state := &codeIntelState{workspace: workspace, refresher: refresher, enabled: enabled}
	// `enabled` was read from this file a moment ago. Seeding the stamp is what makes
	// the first refresh a no-op instead of a second read that could disagree with the
	// value the caller just used to decide whether to register the tool.
	state.configSeen = true
	if workspace != nil {
		state.configMod, state.configSize = configStamp(workspace.Root())
	}
	return state
}

// configStamp is the identity of the config file as of now. A missing file is the
// zero pair, which is also what a refresh should see until somebody creates one.
func configStamp(root string) (time.Time, int64) {
	info, err := os.Stat(codeintel.ConfigPath(root))
	if err != nil {
		return time.Time{}, 0
	}
	return info.ModTime(), info.Size()
}

// Root is the workspace this index belongs to.
func (s *codeIntelState) Root() string {
	if s == nil || s.workspace == nil {
		return ""
	}
	return s.workspace.Root()
}

// indexPresent reports whether the index database is on disk.
//
// A stat, not a full snapshot: this is asked on every `ui(state)` to decide whether the
// panel should offer "initialize" or "sync", and walking the tree there would make a
// badge the most expensive thing in a turn.
func (s *codeIntelState) indexPresent() bool {
	root := s.Root()
	if root == "" {
		return false
	}
	path := filepath.Join(root, filepath.FromSlash(cggraph.IndexDirName), cggraph.DefaultDBName)
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// Enabled reports whether the person has turned the capability on.
func (s *codeIntelState) Enabled() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.enabled
}

// setEnabled records a permission change.
func (s *codeIntelState) setEnabled(on bool) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.enabled = on
}

// refreshEnabled re-reads config.json when another process has replaced it.
//
// The file is the shared fact, not this field: two conversations on one workspace
// are two runtime processes, and the switch is workspace-scoped. Without this, the
// second window keeps showing the old state — and, worse, keeps the model's tool
// set at the old state — until that session is restarted.
//
// Returns whether the value changed, so the caller can reconcile the registry. The
// read is guarded by the file's mtime and size, so the common case is one stat.
func (s *codeIntelState) refreshEnabled() bool {
	if s == nil {
		return false
	}
	root := s.Root()
	if root == "" {
		return false
	}
	mod, size := configStamp(root)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.configSeen && mod.Equal(s.configMod) && size == s.configSize {
		return false
	}
	s.configSeen = true
	s.configMod, s.configSize = mod, size
	on := codeintel.Enabled(root)
	if on == s.enabled {
		return false
	}
	s.enabled = on
	return true
}

// beginBuild claims the build slot, reporting false when one is already running.
//
// The claim is what makes "press init twice" one build rather than two: the second
// press would otherwise queue a second full pass behind the first, and the panel would
// show two progress lines that finish at different times.
func (s *codeIntelState) beginBuild() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.building {
		return false
	}
	s.building = true
	s.phase = "starting"
	s.done, s.total = 0, 0
	return true
}

// setProgress records a phase advance.
func (s *codeIntelState) setProgress(phase string, done, total int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.phase = phase
	s.done, s.total = done, total
}

// finishBuild records the outcome and releases the slot.
func (s *codeIntelState) finishBuild(full bool, result buildSummary, problem string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.building = false
	s.phase = ""
	s.done, s.total = 0, 0
	s.last = &codeIntelRun{
		Full:       full,
		Files:      result.Files,
		Nodes:      result.Nodes,
		Edges:      result.Edges,
		Unresolved: result.Unresolved,
		Problem:    problem,
		At:         time.Now(),
	}
}

// buildSummary is the part of a build's result the panel shows.
type buildSummary struct {
	Files      int
	Nodes      int
	Edges      int
	Unresolved int
}

// snapshot is everything the panel draws, in one message.
func (s *codeIntelState) snapshot(ctx context.Context) map[string]any {
	var enabled, building bool
	var phase string
	var done, total int
	var last *codeIntelRun
	if s != nil {
		s.mu.Lock()
		enabled, building, phase, done, total, last = s.enabled, s.building, s.phase, s.done, s.total, s.last
		s.mu.Unlock()
	}

	root := ""
	index := codeintel.IndexSnapshot{}
	if s != nil {
		root = s.Root()
		if s.refresher != nil {
			// While a pass is running the comparison can only describe the
			// half-written graph, and the walk is the expensive part of a message
			// sent twice a second. The panel shows progress instead.
			index = s.refresher.Snapshot(ctx, codeintel.SnapshotOptions{SkipStaleness: building})
		}
	}

	payload := map[string]any{
		"workspace":             root,
		"enabled":               enabled,
		"indexed":               index.Indexed,
		"path":                  index.Path,
		"size_bytes":            index.SizeBytes,
		"files":                 index.Files,
		"nodes":                 index.Nodes,
		"edges":                 index.Edges,
		"unresolved":            index.Unresolved,
		"pending":               index.Pending,
		"ambiguous_edges":       index.AmbiguousEdges,
		"deferred":              index.Deferred,
		"heuristic":             index.Heuristic,
		"deferred_by_language":  stringKeyed(index.DeferredByLanguage),
		"heuristic_by_language": stringKeyed(index.HeuristicByLanguage),
		// `stale` is an object rather than one number because the three counts mean
		// different things to a reader: "12 modified" is a working tree that moved,
		// "3 deleted" is files the index still thinks exist.
		"stale": map[string]any{
			"added":   index.Added,
			"changed": index.Changed,
			"removed": index.Removed,
			"checked": index.Checked,
			"count":   index.Added + index.Changed + index.Removed,
		},
		// Whether this installation can rebuild at all. False is a fact about the
		// build (no parser binary vendored for this platform), not about the index.
		"parser":   s != nil && s.refresher != nil && s.refresher.CanRebuild(),
		"building": building,
		"problem":  index.Problem,
	}
	if !index.IndexedAt.IsZero() {
		payload["indexed_at"] = index.IndexedAt.UTC().Format(time.RFC3339)
	}
	if building {
		payload["progress"] = map[string]any{"phase": phase, "done": done, "total": total}
	}
	if last != nil {
		payload["last"] = map[string]any{
			"full":       last.Full,
			"ok":         last.Problem == "",
			"files":      last.Files,
			"nodes":      last.Nodes,
			"edges":      last.Edges,
			"unresolved": last.Unresolved,
			"problem":    last.Problem,
			"at":         last.At.UTC().Format(time.RFC3339),
		}
	}
	return payload
}

// stringKeyed renders a language→count map for the wire, with no nil on the empty case.
//
// A front end that has to tell "no languages" from "the runtime did not say" is a front
// end with a second definition of this panel's shape, and its first bug is a crash on
// the empty case — the same rule the state snapshot's lists follow.
func stringKeyed(counts map[string]int) map[string]any {
	out := make(map[string]any, len(counts))
	for language, count := range counts {
		out[language] = count
	}
	return out
}

// CodeIntelPanel is the `ui(codeintel)` payload.
func (r *Runtime) CodeIntelPanel() (map[string]any, error) {
	if r.CodeIntel == nil {
		return nil, fmt.Errorf("this runtime has no code index")
	}
	// Opening the panel is also the point at which another window's permission
	// change becomes visible here. Reconciling the registry is what makes the
	// switch workspace-scoped rather than session-scoped.
	r.refreshCodeIntelPermission()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return r.CodeIntel.snapshot(ctx), nil
}

// WarmupIndex brings the index up to date in the background so the first
// `code_explore` call of the session does not pay for it.
//
// Optional, in the same sense as StartupAuth: a runtime without an index
// handle simply does not implement it, and the caller does not have to know.
//
// It is called once the opening is on the wire — never during assembly — for
// exactly the reason StartAuth is: the pass can take seconds, and holding back
// `init` for it would make a new session look dead. By the time it runs, the
// front end is already drawing and the pass overlaps whatever the person is
// reading and typing.
//
// Gated on the same two facts the panel separates: the switch is on and an
// index exists. Off means the model will never see the tool, so warming it is
// paid latency with no consumer; no index means `EnsureFresh` can only answer
// "unavailable", which is a full staleness scan spent on a no-op.
//
// Deliberately silent on every outcome, and deliberately **not** recorded in
// `last`: the panel's "last run" line describes a build a person pressed for,
// and a warm-up the person never asked for would sit there claiming credit.
// `EnsureFresh`'s own guarantees keep it bounded: the locks are tried, never
// waited on, and a divergence above the inline budget is left alone.
func (r *Runtime) WarmupIndex() {
	if r == nil || r.CodeIntel == nil || r.CodeIntel.refresher == nil {
		return
	}
	if !r.CodeIntel.shouldWarmup() {
		return
	}
	r.CodeIntel.refresher.Warmup()
}

// shouldWarmup is the gate the warm-up has to pass: the same two facts the
// panel separates, both true. Pulled out of WarmupIndex so the decision is
// testable without a parser binary or a real index pass.
func (s *codeIntelState) shouldWarmup() bool {
	return s.Enabled() && s.indexPresent()
}

// codeIntelFlags is what every `ui(state)` carries: three booleans, no counts.
//
// Counts belong on the panel's own snapshot. This rides on every tool result, and a
// badge needs "is it on" and "is anything happening", not how many edges the graph has.
func (r *Runtime) codeIntelFlags() map[string]any {
	if r.CodeIntel == nil {
		return map[string]any{"enabled": false, "indexed": false, "building": false}
	}
	// A stat per ui(state), which is the same cost indexPresent already pays; the
	// badge must not show a permission this process no longer has.
	r.CodeIntel.refreshEnabled()
	r.CodeIntel.mu.Lock()
	enabled, building := r.CodeIntel.enabled, r.CodeIntel.building
	r.CodeIntel.mu.Unlock()

	return map[string]any{
		"enabled":  enabled,
		"indexed":  r.CodeIntel.indexPresent(),
		"building": building,
	}
}

// CodeIntelAction performs one panel verb.
//
// `status` and `config` answer by return value; `init` and `sync` start a build and
// answer immediately, because a full pass takes minutes on a large tree and a protocol
// reply that waited for it would block every other message on the connection — including
// the ones drawing the progress it was waiting for.
func (r *Runtime) CodeIntelAction(action string, arguments map[string]any) (map[string]any, error) {
	if r.CodeIntel == nil {
		return nil, fmt.Errorf("this runtime has no code index")
	}
	switch action {
	case protocol.CodeIntelStatus:
		return nil, nil

	case protocol.CodeIntelConfig:
		raw, ok := arguments["enabled"].(bool)
		if !ok {
			return nil, fmt.Errorf("config needs an enabled flag")
		}
		root := r.CodeIntel.Root()
		if root == "" {
			return nil, fmt.Errorf("this runtime has no workspace")
		}
		if _, err := codeintel.SetEnabled(root, raw); err != nil {
			return nil, err
		}
		r.CodeIntel.setEnabled(raw)
		// **The tool set changes now, not at the next session.** Tool definitions are
		// snapshotted at the start of a turn, so a turn already running finishes with
		// the schema it began with — which is the same rule the MCP mount follows, and
		// why the protocol layer waits for the turn before this runs.
		if err := r.applyCodeIntelTool(); err != nil {
			return nil, err
		}
		return map[string]any{"enabled": raw}, nil

	case protocol.CodeIntelInit:
		if err := r.startCodeIntelBuild(true); err != nil {
			return nil, err
		}
		return map[string]any{"started": true, "full": true}, nil

	case protocol.CodeIntelSync:
		if err := r.startCodeIntelBuild(false); err != nil {
			return nil, err
		}
		return map[string]any{"started": true, "full": false}, nil

	default:
		return nil, fmt.Errorf("unknown code index action %q", action)
	}
}

// applyCodeIntelTool brings the registry in line with the switch.
//
// Three outcomes, and each is deliberate:
//   - enabled and an index exists → registered;
//   - enabled and no index → **not** registered, because a tool that can only answer
//     "there is no index" costs the model a schema in every request; the panel's init
//     button is the way out, and the next build calls this again;
//   - disabled → unregistered, so the next turn's schema does not mention it.
func (r *Runtime) applyCodeIntelTool() error {
	if r.Tools == nil || r.CodeIntel == nil {
		return nil
	}
	enabled := r.CodeIntel.Enabled()
	_, present := r.Tools.Get(builtin.CodeExploreToolName)

	if !enabled {
		if present {
			r.Tools.Unregister(builtin.CodeExploreToolName)
		}
		return nil
	}
	if present {
		return nil
	}
	tool, ok := builtin.NewCodeExplore(r.Workspace, r.CodeIntel.refresher)
	if !ok {
		// No index yet. Not an error: the panel offers "initialize" and the tool
		// appears when that finishes.
		return nil
	}
	if err := r.Tools.Register(tool); err != nil {
		// A name clash means something else already owns `code_explore`, which is a
		// fact the person has to see rather than one to paper over.
		return fmt.Errorf("could not register %s: %w", builtin.CodeExploreToolName, err)
	}
	return nil
}

// refreshCodeIntelPermission notices a config.json written by another session.
//
// Called at turn start as well as from the panel: the tool set has to match the
// workspace's permission before the turn's first request is assembled, not only
// when somebody happens to have the panel open.
func (r *Runtime) refreshCodeIntelPermission() {
	if r == nil || r.CodeIntel == nil || r.Tools == nil {
		return
	}
	if !r.CodeIntel.refreshEnabled() {
		return
	}
	if err := r.applyCodeIntelTool(); err != nil {
		warn("%s", err)
	}
}

// startCodeIntelBuild runs one build in the background.
func (r *Runtime) startCodeIntelBuild(full bool) error {
	if r.CodeIntel == nil || r.CodeIntel.refresher == nil {
		return fmt.Errorf("this runtime has no code index")
	}
	if !r.CodeIntel.refresher.CanRebuild() {
		return fmt.Errorf("this installation carries no index parser, so the index cannot be built")
	}
	if !r.CodeIntel.beginBuild() {
		return fmt.Errorf("an index build is already running")
	}
	go r.runCodeIntelBuild(full)
	return nil
}

// runCodeIntelBuild does the work and narrates it.
//
// Not cancellable, on purpose: the build writes the index in place, so a cancelled
// pass would leave a half-updated graph rather than the previous one. The panel says
// so before the person starts one instead of offering a stop button that cannot put
// the old index back.
func (r *Runtime) runCodeIntelBuild(full bool) {
	state := r.CodeIntel

	lastPhase := ""
	var lastSent time.Time
	onProgress := func(phase string, done, total int) {
		state.setProgress(phase, done, total)
		now := time.Now()
		if phase == lastPhase && now.Sub(lastSent) < codeIntelProgressEvery {
			return
		}
		lastPhase = phase
		lastSent = now
		r.emitCodeIntelEvent("")
	}

	ctx := context.Background()
	result, err := state.refresher.Rebuild(ctx, codeintel.BuildOptions{
		Full:       full,
		OnProgress: onProgress,
	})

	problem := ""
	if err != nil {
		problem = err.Error()
	}
	state.finishBuild(full, buildSummary{
		Files:      result.FilesParsed,
		Nodes:      result.Nodes,
		Edges:      result.Edges,
		Unresolved: result.Unresolved,
	}, problem)

	// An index now exists where there was none, so the tool the switch promised can
	// finally be registered. This is the step that makes "enable, initialize, ask a
	// question" work without reopening the session.
	if problem == "" {
		if err := r.applyCodeIntelTool(); err != nil {
			problem = err.Error()
		}
	}
	r.emitCodeIntelEvent(problem)
}

// emitCodeIntelEvent pushes the panel's snapshot through the runtime→front-end hook.
//
// A non-empty `problem` is attached **beside** the snapshot on one message, so the panel
// never has to pair a state with a separate failure line it might receive in either
// order.
func (r *Runtime) emitCodeIntelEvent(problem string) {
	if r.onCodeIntelEvent == nil || r.CodeIntel == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	payload := map[string]any{"kind": protocol.UICodeIntel, "codeintel": r.CodeIntel.snapshot(ctx)}
	if problem != "" {
		payload["problem"] = problem
	}
	r.onCodeIntelEvent(payload)
}
