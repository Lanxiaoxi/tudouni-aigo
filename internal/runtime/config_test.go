package runtime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
)

// The two tests here cover a **data-loss fix**, and they exist because the
// failure they prevent is silent.
//
// `permissions.json` is written by every runtime in a workspace, and a workspace
// can now hold several at once (one process per conversation). The file is
// rewritten whole — read, modify, rename — so a write that carried only *this*
// process's remembered set would delete whatever another session granted since
// this one started. Nothing would report it: the person would simply be asked
// again for something they had already approved.
//
// The union is the fix. It narrows the window to the microseconds between the
// read and the write rather than closing it — closing it needs a file lock,
// which the design records as the optional second step.

// permissionsOnDisk reads the file the way a second process would.
func permissionsOnDisk(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(PermissionFile())
	if err != nil {
		t.Fatalf("permissions.json is not readable: %v", err)
	}
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil {
		t.Fatalf("permissions.json is not an object: %v", err)
	}
	return object
}

func toolNames(t *testing.T, object map[string]any) []string {
	t.Helper()
	raw, _ := object["auto_approve_tools"].([]any)
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

// A workspace directory whose `.tudouni/` the test owns. `PermissionFile()`
// resolves through the working directory, so that is what moves.
func permissionWorkspace(t *testing.T) {
	t.Helper()
	t.Chdir(t.TempDir())
	if err := os.MkdirAll(paths.WorkspaceRuntimeDir(), 0o700); err != nil {
		t.Fatalf("could not make the runtime directory: %v", err)
	}
}

func TestApprovalsAreUnionedWithWhatIsAlreadyOnDisk(t *testing.T) {
	permissionWorkspace(t)

	// Another session granted `read_file` a moment ago. This process has never
	// heard of it: its own set was loaded when it started.
	seed := map[string]any{
		"auto_approve":       []string{"low"},
		"auto_approve_tools": []string{"read_file"},
		"deny_tools":         []string{},
	}
	raw, err := json.Marshal(seed)
	if err != nil {
		t.Fatalf("could not encode the seed: %v", err)
	}
	if err := os.WriteFile(PermissionFile(), raw, 0o600); err != nil {
		t.Fatalf("could not seed permissions.json: %v", err)
	}

	// This session presses "always allow" for `shell`.
	if err := SaveApprovals([]string{"shell"}, nil); err != nil {
		t.Fatalf("SaveApprovals: %v", err)
	}

	got := toolNames(t, permissionsOnDisk(t))
	if len(got) != 2 {
		t.Fatalf("both sessions' grants must survive, got %v", got)
	}
	// `read_file` is the one that used to disappear — and losing it is
	// invisible: the next request for it simply asks again.
	var hasShell, hasRead bool
	for _, name := range got {
		hasShell = hasShell || name == "shell"
		hasRead = hasRead || name == "read_file"
	}
	if !hasShell || !hasRead {
		t.Fatalf("expected shell and read_file, got %v", got)
	}
}

func TestApprovalsKeepTheConfigKeysThisProcessDoesNotOwn(t *testing.T) {
	permissionWorkspace(t)

	// The keys this function does not write are the person's, and a save must
	// carry them through untouched. `auto_approve` in particular decides which
	// risk levels run without asking at all.
	seed := map[string]any{
		"auto_approve":       []string{"low", "medium"},
		"auto_approve_tools": []string{},
		"deny_tools":         []string{"shell"},
	}
	raw, err := json.Marshal(seed)
	if err != nil {
		t.Fatalf("could not encode the seed: %v", err)
	}
	if err := os.WriteFile(PermissionFile(), raw, 0o600); err != nil {
		t.Fatalf("could not seed permissions.json: %v", err)
	}

	if err := SaveApprovals([]string{"read_file"}, nil); err != nil {
		t.Fatalf("SaveApprovals: %v", err)
	}

	object := permissionsOnDisk(t)

	levels, _ := object["auto_approve"].([]any)
	if len(levels) != 2 {
		t.Fatalf("the risk levels must survive, got %v", object["auto_approve"])
	}

	denied, _ := object["deny_tools"].([]any)
	if len(denied) != 1 || denied[0] != "shell" {
		t.Fatalf("the deny list must survive, got %v", object["deny_tools"])
	}
}

func TestShellRulesAreUnionedRatherThanReplaced(t *testing.T) {
	permissionWorkspace(t)

	// Same rule, for the other remembered set: command prefixes. This one has a
	// second way to go wrong — a rule is deduplicated by its **formatted** text,
	// so the union must not produce the same rule twice.
	seed := map[string]any{
		"auto_approve":       []string{"low"},
		"auto_approve_tools": []string{},
		"deny_tools":         []string{},
		"shell_allow":        []string{"git add"},
	}
	raw, err := json.Marshal(seed)
	if err != nil {
		t.Fatalf("could not encode the seed: %v", err)
	}
	if err := os.WriteFile(PermissionFile(), raw, 0o600); err != nil {
		t.Fatalf("could not seed permissions.json: %v", err)
	}

	// This session grants `git add` again (already on disk) and `git commit`.
	rule, err := security.ParseRule("git add", false)
	if err != nil {
		t.Fatalf("could not parse the rule: %v", err)
	}
	second, err := security.ParseRule("git commit", false)
	if err != nil {
		t.Fatalf("could not parse the rule: %v", err)
	}
	if err := SaveApprovals(nil, []security.Rule{rule, second}); err != nil {
		t.Fatalf("SaveApprovals: %v", err)
	}

	rules, _ := permissionsOnDisk(t)["shell_allow"].([]any)
	seen := map[string]bool{}
	for _, item := range rules {
		text, _ := item.(string)
		if seen[text] {
			t.Fatalf("the same rule appears twice: %v", rules)
		}
		seen[text] = true
	}
	if len(rules) != 2 {
		t.Fatalf("expected two distinct rules, got %v", rules)
	}
}

func TestAnUnreadableFileIsNeverOverwritten(t *testing.T) {
	permissionWorkspace(t)

	// Not valid JSON: the person's rules are in there and this process cannot
	// see them. Writing this session's set over the top would delete them, and
	// the file is the only copy.
	if err := os.WriteFile(PermissionFile(), []byte("{not json"), 0o600); err != nil {
		t.Fatalf("could not write the broken file: %v", err)
	}

	if err := SaveApprovals([]string{"shell"}, nil); err == nil {
		t.Fatal("a save over an unreadable file must fail rather than proceed")
	}

	raw, err := os.ReadFile(PermissionFile())
	if err != nil {
		t.Fatalf("the file must still be there: %v", err)
	}
	if string(raw) != "{not json" {
		t.Fatalf("the file must be untouched, got %q", string(raw))
	}
}

// The path helper is asserted rather than assumed: every test above depends on
// `PermissionFile()` living under a directory the test moved into, and a change
// to `paths` that broke that would turn them into tests of a file in the
// repository root.
func TestThePermissionFileLivesUnderTheWorkingDirectory(t *testing.T) {
	permissionWorkspace(t)
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("could not read the working directory: %v", err)
	}
	want := filepath.Join(cwd, paths.RuntimeDirName, "permissions.json")
	if got := PermissionFile(); got != want {
		t.Fatalf("PermissionFile() = %q, want %q", got, want)
	}
}
