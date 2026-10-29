package runtime

import (
	"os"
	"path/filepath"
	"sort"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/hooks"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
)

// Loading, trusting and reporting the user's hooks.
//
// The three questions this file answers are deliberately answered in one place:
//
//   - **is there a file at all** (`LoadHooks`) — a missing file is the ordinary
//     state, a corrupt one is a start-up error, and the two must never collapse
//     into "there are no hooks" together;
//   - **may a workspace's file run** (`LoadWorkspaceHooks`) — never in phase 1, and
//     only with an explicit, hashed approval in phase 2, and even then only with
//     the restricted vocabulary `hooks.Restrict` enforces;
//   - **what should a person be told** (`hooksNotices`) — every silent failure this
//     feature can have is a start-up line here, because a guardrail that is present
//     and does nothing is worse than one that is absent.

// HookLoad is what assembly learned about hooks: the set (possibly empty) and the
// lines the start-up screen should show.
//
// It is one value rather than two returns because the two are produced together and
// a caller that took only the set would drop the notices — which is exactly how the
// "workspace hooks were ignored" warning disappears.
type HookLoad struct {
	// Set is nil when there is no file at all. A non-nil set with no hooks is the
	// "file exists, everything in it is disabled" state, which is different.
	Set *hooks.Set
	// Notices are start-up lines, in the order they should be read.
	Notices []map[string]any
	// Disabled is `--no-hooks`. It is carried so the notice can say the file was
	// **skipped** rather than absent: "silently disabled guardrail" is the failure
	// this flag is written to avoid.
	Disabled bool
}

// LoadHooks reads the user-level hooks file.
//
// `disabled` is `--no-hooks`. It returns early — before reading the file — so a
// broken configuration cannot stop a session someone started with the feature
// switched off; that is the whole purpose of an escape hatch.
func LoadHooks(disabled bool) (HookLoad, error) {
	if disabled {
		return HookLoad{
			Disabled: true,
			Notices: []map[string]any{notice("info", "hooks",
				i18n.T("notice.hooks.disabled", "path", HooksFile()))},
		}, nil
	}

	path := HooksFile()
	set, err := hooks.Load(path)
	if err != nil {
		return HookLoad{}, errorf("%s", i18n.T("notice.hooks.load_failed",
			"path", path, "problem", err.Error()))
	}

	load := HookLoad{Set: set}
	if set != nil {
		// The listing is a start-up line rather than only a `--hooks` output: a
		// person who configured a guardrail needs to see it is running, and the one
		// line that says so also names the file it came from.
		if set.Len() > 0 {
			// A code of its own (`hooks.loaded`) so `--hooks`, which prints the same
			// rows itself, can skip this line instead of printing the count twice.
			load.Notices = append(load.Notices, notice("info", "hooks.loaded",
				i18n.T("notice.hooks.loaded", "n", set.Len(), "path", path,
					"events", hookEventsLine(set))))
		}
		for _, warning := range set.Warnings {
			load.Notices = append(load.Notices, notice("warn", "hooks",
				i18n.T("notice.hooks.warning", "problem", warning)))
		}
		for _, problem := range set.Problems {
			load.Notices = append(load.Notices, notice("warn", "hooks",
				i18n.T("notice.hooks.problem", "problem", problem.String())))
		}
	}

	// The workspace's own file is **not** read, and saying so is the whole point.
	// A repository that ships `.tudouni/hooks.json` is a repository whose author
	// expects it to run; leaving that to silence would be the failure the mcp.json
	// notice already exists to prevent.
	//
	// It is checked **outside** the `set != nil` branch on purpose: the case that
	// most needs the sentence is the one where the person has configured no
	// user-level file at all and wonders why the repository's guardrail is not
	// firing.
	workspaceFile := hooks.WorkspaceFile(paths.WorkspaceRuntimeDir())
	if info, err := os.Stat(workspaceFile); err == nil && !info.IsDir() {
		load.Notices = append(load.Notices, notice("warn", "hooks",
			i18n.T("notice.hooks.ignored_workspace_file",
				"path", workspaceFile, "file", path,
				"trust", "trust-workspace-hooks")))
	}
	return load, nil
}

// LoadWorkspaceHooks is phase 2's half: a trusted workspace's file, restricted.
//
// It runs on every assembly, and what it is allowed to do is decided by two things
// that must both hold:
//
//   - `trust.json` holds a record for this workspace **and** its hash still matches
//     the file (a repository edited after approval is untrusted again);
//   - `hooks.RestrictSet` leaves only `pre_tool_use` / `post_tool_use`, and each of
//     those hooks is marked `SourceWorkspace` so the runner narrows what it may say
//     to `deny` / `ask`.
//
// A nil set with non-nil notices means "the file is there but it may not run", which
// is a different state from "there is no file", and the notice says which.
func LoadWorkspaceHooks(trustPath, workspace, file string) (*hooks.Set, []map[string]any, error) {
	if info, err := os.Stat(file); err != nil || info.IsDir() {
		return nil, nil, nil
	}
	store, err := hooks.LoadTrust(trustPath)
	if err != nil {
		return nil, nil, err
	}
	trusted, _ := store.Trusted(workspace, file)
	if !trusted {
		return nil, []map[string]any{notice("warn", "hooks",
			i18n.T("notice.hooks.workspace_untrusted", "path", file, "trust", trustPath))}, nil
	}
	set, err := hooks.Load(file)
	if err != nil {
		return nil, nil, err
	}
	if set == nil {
		return nil, nil, nil
	}
	restricted := hooks.RestrictSet(set)
	return restricted, []map[string]any{notice("info", "hooks",
		i18n.T("notice.hooks.workspace_trusted", "path", file, "n", restricted.Len()))}, nil
}

// assembleHooks loads both files and folds them into the one set the session runs.
//
// The two are kept in a fixed order — the person's hooks first, then the trusted
// workspace's — and the order is the trust order rather than a preference: a
// repository's guardrail cannot pre-empt the person's by running earlier, and it
// cannot shadow a hook of the same name, because both run.
//
// `--no-hooks` short-circuits **before anything is read**, workspace file included.
// A switch that still loaded a repository's scripts would be a switch that only half
// works, and the half it left on is the one nobody asked for.
func assembleHooks(disabled bool, workspace string) (HookLoad, error) {
	load, err := LoadHooks(disabled)
	if err != nil || disabled {
		return load, err
	}

	workspaceFile := hooks.WorkspaceFile(filepath.Join(workspace, paths.RuntimeDirName))
	workspaceSet, notices, err := LoadWorkspaceHooks(TrustFile(), workspace, workspaceFile)
	if err != nil {
		return HookLoad{}, errorf("%s", i18n.T("notice.hooks.load_failed",
			"path", workspaceFile, "problem", err.Error()))
	}
	// The "workspace file exists but is not trusted" line was already added by
	// `LoadHooks`; only the trusted case adds its own, so a person who has not
	// approved the file is told once.
	if workspaceSet != nil && workspaceSet.Len() > 0 {
		load.Notices = append(load.Notices, notices...)
		load.Set = hooks.Merge(load.Set, workspaceSet)
		return load, nil
	}
	// A trusted file with nothing enabled still says so: "I approved this and it does
	// nothing" is a state a person needs to be able to see.
	if workspaceSet != nil {
		load.Notices = append(load.Notices, notices...)
	}
	return load, nil
}

// configuredHooks turns a possibly-nil set into the interface the runtime holds.
//
// **A nil `*hooks.Set` stored in an interface is not a nil interface**, and this is the
// one place that has to know: `Runtime.Hooks` is `hooks.Configurable`, so assigning a
// nil `*Set` to it produces a non-nil interface whose every method panics on the nil
// receiver — except that `Fire` is written to tolerate it, which is worse: the session
// looks configured, runs a nil-safe no-op on every tool call, and every `if r.Hooks !=
// nil` guard in the runtime silently takes the wrong branch.
//
// It has one caller and it returns `nil` as a `hooks.Configurable`, so the guards stay
// honest: with no file, or with `--no-hooks`, `Hooks` really is nil.
func configuredHooks(set *hooks.Set) hooks.Configurable {
	if set == nil {
		return nil
	}
	return set
}

// hookEventsLine renders "pre_tool_use 2, post_tool_use 1" for the notice.
func hookEventsLine(set *hooks.Set) string {
	if set == nil {
		return ""
	}
	line := ""
	for _, event := range set.Events() {
		count := 0
		for _, hook := range set.Hooks(event) {
			if hook.Enabled {
				count++
			}
		}
		if count == 0 {
			continue
		}
		if line != "" {
			line += ", "
		}
		line += string(event) + " " + itoa(count)
	}
	return line
}

// itoa is strconv.Itoa without the import, for one call site in a notice.
func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 4)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

// HooksPath is where the trust store lives, exposed for `--trust-workspace-hooks`.
func HooksPath() string { return HooksFile() }

// guardrailPaths are the files this session's guardrail depends on.
//
// It is the user-level file always — even when `--no-hooks` skipped reading it,
// because the switch is for this process and the next one will read it — plus every
// script the configuration names. The workspace file is included when it exists, for
// the same reason: the next process may be the one that trusts it.
//
// The list is collected here rather than in `internal/agent` because this is where the
// paths are known; the agent only compares. See §7.3 for what the guard can and cannot
// promise.
func (r *Runtime) guardrailPaths() []string {
	guarded := map[string]bool{}
	add := func(path string) {
		if path == "" {
			return
		}
		if absolute, err := filepath.Abs(path); err == nil {
			path = absolute
		}
		guarded[path] = true
	}

	add(HooksFile())
	if r.Workspace != nil {
		add(hooks.WorkspaceFile(filepath.Join(r.Workspace.Root(), paths.RuntimeDirName)))
	}
	if r.Hooks == nil {
		return sortedKeysOf(guarded)
	}
	// The scripts the configuration names. `*hooks.Set` is the only implementation
	// that has any, and the interface above does not expose them because nothing else
	// needs to know a hook has a script.
	if set, ok := r.Hooks.(*hooks.Set); ok {
		for _, path := range set.ProtectedPaths() {
			add(path)
		}
	}
	return sortedKeysOf(guarded)
}

// sortedKeysOf is stable output for a list a person may read in a notice or a debug
// line: two runs of the same build have to print the same order.
func sortedKeysOf(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for key := range set {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

// WorkspaceHooksPath is the path a workspace's hooks would be at.
func WorkspaceHooksPath() string {
	return filepath.Join(paths.WorkspaceRuntimeDir(), "hooks.json")
}
