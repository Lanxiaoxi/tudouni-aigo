package runtime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/config"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/hooks"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// The assembled-runtime tests for hooks.
//
// The other tests in this package build a `Runtime` by hand, which is the right shape
// for asking about one method. These go through `OpenRuntime`, and they exist because
// a hand-built runtime cannot catch the one failure they are about: a loader that is
// correct, tested, and **never called**. That is exactly what happened —
// `--trust-workspace-hooks` recorded a hash, `LoadWorkspaceHooks` was covered by a
// unit test, and the repository's guardrail still did not run, because assembly read
// only the user's file.

// sandbox is a throwaway home plus a throwaway workspace, with the process pointed at
// both.
//
// **The ordering is the whole reason this type exists.** `HOME`/`USERPROFILE` and the
// working directory decide where `paths.UserConfigDir()` and
// `paths.WorkspaceRuntimeDir()` point, and those are computed at call time — so a file
// written before this constructor returned went to the developer's real
// `~/.tudouni/hooks.json`. That is not hypothetical: the first version of this test
// did it, and left a `hooks.json` and a `trust.json` behind in the real home
// directory. Nothing may be written until `newSandbox` has returned.
type sandbox struct {
	Home      string
	Workspace string
}

func newSandbox(t *testing.T) sandbox {
	t.Helper()

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	workspace := t.TempDir()
	t.Chdir(workspace)

	// `AGENT_CONFIG_FILE` is how the catalogue is pointed somewhere disposable. A
	// route with no key is enough: nothing here sends a request.
	//
	// The default route is **the first provider that has a key** — there is no
	// `default_provider` key, and writing one is a start-up error — so the single
	// route in this file is the default by being alone.
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(configPath, []byte(`{"providers":{"p":{"api_style":"openai","api_key":"k","base_url":"http://127.0.0.1:1","models":[{"id":"m","context_window":1000}]}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(config.FileEnv, configPath)

	return sandbox{Home: home, Workspace: workspace}
}

// userHooksFile / workspaceHooksFile write one hook into each file.
//
// They are methods on the sandbox rather than free functions so a caller cannot reach
// them before the paths point at temporary directories.
func (s sandbox) userHooksFile(t *testing.T) string {
	t.Helper()
	path := HooksFile()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"hooks":{
		"pre_tool_use":[{"name":"mine","command":["sh"]}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func (s sandbox) workspaceHooksFile(t *testing.T) string {
	t.Helper()
	path := WorkspaceHooksPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"hooks":{
		"pre_tool_use":[{"name":"theirs","command":["sh"]}],
		"stop":[{"name":"loop","command":["sh"]}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// open assembles a real runtime in this sandbox.
//
// The session store and the audit sink are real; the model client is a route that
// never answers, because the question is which hooks the session will run and not
// what the model says.
func (s sandbox) open(t *testing.T, noHooks bool) *Runtime {
	t.Helper()
	session := state.NewEmptySession("20260101-120000")
	runtimeValue, err := OpenRuntime(Options{Session: session, NoHooks: noHooks})
	if err != nil {
		t.Fatalf("assembling a runtime: %v", err)
	}
	t.Cleanup(func() {
		if runtimeValue.Jobs != nil {
			_ = runtimeValue.Jobs.Close()
		}
	})
	return runtimeValue
}

// TestAssemblyRunsTheTrustedWorkspaceHooks is the regression.
//
// It asserts on the **assembled runtime's** hook set, which is the value the turn loop
// actually uses. Before the fix this was the user's file alone: the workspace edit was
// recorded in `trust.json` and ignored.
func TestAssemblyRunsTheTrustedWorkspaceHooks(t *testing.T) {
	scene := newSandbox(t)
	scene.userHooksFile(t)
	workspaceFile := scene.workspaceHooksFile(t)

	// Untrusted first: assembly must not fold the repository's file in quietly.
	runtimeValue := scene.open(t, false)
	set, ok := runtimeValue.Hooks.(*hooks.Set)
	if !ok || set == nil {
		t.Fatalf("Hooks is %T, want a set with the person's hook", runtimeValue.Hooks)
	}
	if got := len(set.Hooks(hooks.EventPreToolUse)); got != 1 {
		t.Fatalf("before approval pre_tool_use has %d hooks, want only the person's", got)
	}

	// Approve, then assemble again: both files, the person's first, and the `stop`
	// hook still absent.
	store, err := hooks.LoadTrust(TrustFile())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Approve(scene.Workspace, workspaceFile, "test"); err != nil {
		t.Fatal(err)
	}
	runtimeValue = scene.open(t, false)
	set, ok = runtimeValue.Hooks.(*hooks.Set)
	if !ok {
		t.Fatalf("Hooks is %T, want *hooks.Set", runtimeValue.Hooks)
	}
	list := set.Hooks(hooks.EventPreToolUse)
	if len(list) != 2 {
		t.Fatalf("pre_tool_use has %d hooks, want both files' — the workspace file was not folded in", len(list))
	}
	if list[0].Source != hooks.SourceUser || list[1].Source != hooks.SourceWorkspace {
		t.Fatalf("order = %s then %s, want the person's first", list[0].Source, list[1].Source)
	}
	if set.Has(hooks.EventStop) {
		t.Fatal("a workspace hook kept the stop event, which it may not have")
	}
	// And the permission paths include both files, so the model cannot rewrite the
	// guardrail it is passing through.
	guarded := runtimeValue.guardrailPaths()
	if len(guarded) < 2 {
		t.Fatalf("guardrail paths = %v, want the user file and the workspace file", guarded)
	}
}

// TestAssemblyWithNoHooksIgnoresBothFiles: the escape hatch has to cover the
// repository's file too, or it is a switch that only half works.
func TestAssemblyWithNoHooksIgnoresBothFiles(t *testing.T) {
	scene := newSandbox(t)
	scene.userHooksFile(t)
	workspaceFile := scene.workspaceHooksFile(t)
	store, err := hooks.LoadTrust(TrustFile())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Approve(scene.Workspace, workspaceFile, "test"); err != nil {
		t.Fatal(err)
	}

	runtimeValue := scene.open(t, true)
	if runtimeValue.Hooks != nil {
		if set, ok := runtimeValue.Hooks.(*hooks.Set); ok {
			t.Fatalf("--no-hooks still ran with %d hooks", set.Len())
		}
	}
	if !runtimeValue.hooksDisabled {
		t.Fatal("--no-hooks was not recorded on the runtime")
	}
}

// TestTheSandboxActuallyRelocatesTheHomeDirectory is the guard on the fixture itself.
//
// The first version of these tests wrote into the developer's real `~/.tudouni`
// because it called the writer before the environment moved. That failure is silent
// (the tests went on to fail for an unrelated-looking reason), so the property that
// matters is asserted directly: after construction, the paths a test would write to
// are inside the temporary directories.
func TestTheSandboxActuallyRelocatesTheHomeDirectory(t *testing.T) {
	scene := newSandbox(t)
	if got := HooksFile(); !within(got, scene.Home) {
		t.Fatalf("HooksFile = %q, want it under %q", got, scene.Home)
	}
	if got := WorkspaceHooksPath(); !within(got, scene.Workspace) {
		t.Fatalf("WorkspaceHooksPath = %q, want it under %q", got, scene.Workspace)
	}
	if got := TrustFile(); !within(got, scene.Home) {
		t.Fatalf("TrustFile = %q, want it under %q", got, scene.Home)
	}
	if got := paths.WorkspaceDir(); got != scene.Workspace {
		t.Fatalf("workspace = %q, want %q", got, scene.Workspace)
	}
}

// within reports whether path is inside dir.
func within(path, dir string) bool {
	relative, err := filepath.Rel(dir, path)
	if err != nil {
		return false
	}
	return relative != ".." && !filepath.IsAbs(relative) && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
