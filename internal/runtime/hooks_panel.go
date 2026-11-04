package runtime

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/hooks"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/version"
)

// The hooks panel: one place to see what is configured, how each script has been doing,
// and to edit the user-level file.
//
// Three facts are kept apart on purpose, because a list that blended them would say things
// that are not true:
//
//   - **what the file says** — what a person edits and saves;
//   - **what this session is running** — hooks are read once when a session opens, so a hook
//     saved a minute ago is not running yet, and a hook disabled a minute ago still is;
//   - **what each script has done** — the outcome of its most recent run, as the executor
//     recorded it, never inferred.
//
// Each hook carries a `state` that names how the first two relate (`active`, `pending`,
// `off`, `bypassed`), so the panel can say "saved, takes effect in a new session" instead of
// letting the person wonder why nothing happened.

// HooksActionSave is the one verb the panel has: write the whole document.
const HooksActionSave = "save"

// The words `state` takes.
const (
	// hookActive: the file and this session agree, and the hook runs.
	hookActive = "active"
	// hookPending: the file and this session disagree. Whatever the file says will be true
	// in the next session; this one is still running what it loaded.
	hookPending = "pending"
	// hookOff: switched off in the file and not running here either.
	hookOff = "off"
	// hookBypassed: enabled in the file, but this session was started with `--no-hooks`.
	hookBypassed = "bypassed"
)

// runningHooks is the set this session loaded, nil when it loaded none.
func (r *Runtime) runningHooks() *hooks.Set {
	if r.Hooks == nil {
		return nil
	}
	set, _ := r.Hooks.(*hooks.Set)
	return set
}

// HooksPanel is the `ui(hooks)` payload: everything the panel draws, in one message.
//
// It never fails. A file that cannot be read is a *fact the panel reports* (`file.problem`),
// not a reason to draw nothing: the person's next move is to fix that file, and they need
// the panel to say which one.
func (r *Runtime) HooksPanel() (map[string]any, error) {
	path := HooksFile()
	file, readErr := hooks.ReadFile(path)
	running := r.runningHooks()

	defaults := hooks.Defaults{TimeoutMs: hooks.DefaultTimeoutMs, MaxOutputBytes: hooks.DefaultMaxOutputBytes}
	if file.Set != nil {
		defaults = file.Set.Defaults
	}

	fileRow := map[string]any{"exists": file.Exists, "revision": file.Revision, "problem": ""}
	if readErr != nil {
		fileRow["problem"] = readErr.Error()
	}

	entries := make([]any, 0, len(file.Doc.Entries))
	for _, entry := range file.Doc.Entries {
		entries = append(entries, r.hookEntryRow(entry, file, running))
	}

	events := make([]any, 0, len(hooks.Events))
	for _, event := range hooks.Events {
		events = append(events, map[string]any{
			"name":               string(event),
			"gate":               event.Gate(),
			"tool_event":         event.ToolEvent(),
			"can_decide":         event.CanDecide(),
			"default_timeout_ms": hooks.DefaultTimeoutFor(event, defaults),
			"workspace_allowed":  hooks.RestrictedEvents[event],
		})
	}

	scriptsDir := hooks.ScriptsDir(paths.UserConfigDir())
	scripts := []any{}
	// A folder that cannot be listed is an empty shelf, not a broken panel: nobody is
	// required to keep scripts there.
	if found, err := hooks.ListScripts(scriptsDir); err == nil {
		for _, script := range found {
			scripts = append(scripts, map[string]any{
				"name": script.Name, "path": script.Path, "command": script.Command,
			})
		}
	}

	return map[string]any{
		"path":        path,
		"scripts_dir": filepath.ToSlash(scriptsDir),
		"disabled":    r.hooksDisabled,
		"file":        fileRow,
		"defaults": map[string]any{
			"timeout_ms":       nullableInt(file.Doc.Defaults.TimeoutMs),
			"max_output_bytes": nullableInt(file.Doc.Defaults.MaxOutputBytes),
		},
		"entries":   entries,
		"events":    events,
		"scripts":   scripts,
		"workspace": r.workspaceHooksSection(running),
		"limits": map[string]any{
			"max_timeout_ms":    hooks.MaxTimeoutMs,
			"max_per_event":     hooks.MaxHooksPerEvent,
			"max_output_bytes":  hooks.MaxMaxOutputBytes,
			"default_output":    hooks.DefaultMaxOutputBytes,
			"gate_timeout_ms":   hooks.GateTimeoutMs,
			"default_timeout":   hooks.DefaultTimeoutMs,
			"stderr_reason_cap": 2000,
		},
	}, nil
}

// hookEntryRow is one hook of the user's file, with what the runtime resolved for it and
// what it has done.
func (r *Runtime) hookEntryRow(entry hooks.Entry, file *hooks.File, running *hooks.Set) map[string]any {
	text, shell := entry.CommandText()
	row := map[string]any{
		"event":            entry.Event,
		"name":             entry.Name,
		"matcher":          entry.Matcher,
		"command":          text,
		"shell":            shell,
		"timeout_ms":       nullableInt(entry.TimeoutMs),
		"max_output_bytes": nullableInt(entry.MaxOutputBytes),
		"fail_closed":      nullableBool(entry.FailClosed),
		"enabled":          entry.Enabled,
		"status_message":   entry.StatusMessage,

		"state":                 hookPending,
		"activity":              nil,
		"timeout_effective":     nil,
		"fail_closed_effective": nil,
		"executable_found":      nil,
	}

	var resolved *hooks.Hook
	if file.Set != nil {
		list := file.Set.Hooks(hooks.Event(entry.Event))
		for index := range list {
			if list[index].Name == entry.Name {
				resolved = &list[index]
				break
			}
		}
	}
	if resolved == nil {
		return row
	}

	row["timeout_effective"] = resolved.TimeoutMs
	row["fail_closed_effective"] = resolved.FailClosed
	// Only for a program named directly. A shell command starts `cmd` or `sh`, which
	// always exist, and "found" would then be a claim about nothing the person wrote.
	if !shell {
		row["executable_found"] = resolved.ExecutableFound()
	}

	live := liveHook(running, resolved.Event, resolved.Name)
	same := live != nil && hooks.SameDefinition(*live, *resolved)
	state := r.hookState(*resolved, live, same)
	row["state"] = state

	// What a hook has done is shown only for the definition that did it. After an edit the
	// recorded result belongs to the old command, and printing it beside the new one would
	// be a statement about a script that has not run.
	if state == hookActive {
		stats, ran := running.StatsFor(hooks.SourceUser, resolved.Event, resolved.Name)
		row["activity"] = activityRow(stats, ran)
	}
	return row
}

// liveHook finds the user-level hook this session loaded under that name.
func liveHook(running *hooks.Set, event hooks.Event, name string) *hooks.Hook {
	if running == nil {
		return nil
	}
	list := running.Hooks(event)
	for index := range list {
		if list[index].Source == hooks.SourceUser && list[index].Name == name {
			return &list[index]
		}
	}
	return nil
}

// workspaceHookLoaded reports whether this session loaded the repository's hook of that name.
func workspaceHookLoaded(running *hooks.Set, event hooks.Event, name string) bool {
	if running == nil {
		return false
	}
	for _, hook := range running.Hooks(event) {
		if hook.Source == hooks.SourceWorkspace && hook.Name == name {
			return true
		}
	}
	return false
}

// hookState says how the file's version of a hook relates to what this session runs.
func (r *Runtime) hookState(file hooks.Hook, live *hooks.Hook, same bool) string {
	switch {
	case r.hooksDisabled:
		if file.Enabled {
			return hookBypassed
		}
		return hookOff
	case same && file.Enabled:
		return hookActive
	case same, live == nil && !file.Enabled:
		return hookOff
	default:
		// The session still runs a different version, or none, or still runs a hook the
		// file has since switched off. The file wins in the next session.
		return hookPending
	}
}

// activityRow is the report on how a hook has been doing in this session.
//
// `class` is the verdict (`success`, `refused`, `failed`, `crashed`, `cancelled`) and
// `status` is the executor's own word for it, kept beside it because that is what the audit
// log says and what a person will search for.
func activityRow(stats hooks.Stats, ran bool) map[string]any {
	row := map[string]any{"runs": 0, "failures": 0, "last": nil}
	if !ran || stats.Last == nil {
		return row
	}
	row["runs"] = stats.Runs
	row["failures"] = stats.Failures
	last := map[string]any{
		"class":       hooks.OutcomeClass(stats.Last.Status),
		"status":      stats.Last.Status,
		"at":          stats.Last.At.UTC().Format(time.RFC3339),
		"duration_ms": stats.Last.DurationMs,
		"exit_code":   nil,
		"reason":      stats.Last.Reason,
		"tool":        stats.Last.Tool,
	}
	if stats.Last.ExitCode != nil {
		last["exit_code"] = *stats.Last.ExitCode
	}
	row["last"] = last
	return row
}

// workspaceHooksSection is the repository's own hooks file, read-only.
//
// It is here so "I put a guardrail in the repository and nothing happens" has an answer on
// the screen rather than only in a start-up line: the file is listed, and so is the reason
// it does or does not run. It cannot be edited from here — the file arrives with a clone and
// is approved by hash, and rewriting it would change the bytes that approval was given for.
func (r *Runtime) workspaceHooksSection(running *hooks.Set) map[string]any {
	root := paths.WorkspaceDir()
	if r.Workspace != nil {
		root = r.Workspace.Root()
	}
	file := hooks.WorkspaceFile(filepath.Join(root, paths.RuntimeDirName))

	section := map[string]any{
		"path":          file,
		"exists":        false,
		"trusted":       false,
		"problem":       "",
		"entries":       []any{},
		"trust_command": version.Name + " --trust-workspace-hooks",
	}
	if info, err := os.Stat(file); err != nil || info.IsDir() {
		return section
	}
	section["exists"] = true

	// A trust store that cannot be read is read as "nothing is trusted": it loses a
	// convenience and never grants one.
	store, _ := hooks.LoadTrust(TrustFile())
	trusted, _ := store.Trusted(root, file)
	section["trusted"] = trusted && !r.hooksDisabled

	set, err := hooks.Load(file)
	if err != nil {
		section["problem"] = err.Error()
		return section
	}
	if set == nil {
		return section
	}

	rows := []any{}
	for _, descriptor := range set.Describe() {
		event := hooks.Event(descriptor.Event)
		allowed := hooks.RestrictedEvents[event]
		// "Runs" is a fact about this session, so it needs the session to have loaded the
		// hook. A file approved after the session started is trusted and still not running;
		// saying otherwise would be the same lie as calling a saved edit active.
		effective := trusted && !r.hooksDisabled && descriptor.Enabled && allowed &&
			workspaceHookLoaded(running, event, descriptor.Name)
		row := map[string]any{
			"event":     descriptor.Event,
			"name":      descriptor.Name,
			"matcher":   descriptor.Matcher,
			"command":   descriptor.Command,
			"enabled":   descriptor.Enabled,
			"allowed":   allowed,
			"effective": effective,
			"activity":  nil,
		}
		if effective && running != nil {
			stats, ran := running.StatsFor(hooks.SourceWorkspace, event, descriptor.Name)
			row["activity"] = activityRow(stats, ran)
		}
		rows = append(rows, row)
	}
	section["entries"] = rows
	return section
}

// HooksAction performs one change to the user's hooks file.
//
// Like every verb of this kind it is a decision by a person, reachable only from a front end
// someone is looking at — the model has no tool that reaches it, and its own `write_file` is
// refused for this path by the guardrail.
func (r *Runtime) HooksAction(action string, arguments map[string]any) (map[string]any, error) {
	switch action {
	case HooksActionSave:
		revision, ok := arguments["revision"].(string)
		if !ok {
			return nil, fmt.Errorf("save needs the revision of the file the form was drawn from")
		}
		raw, ok := arguments["document"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("save needs a document object")
		}
		doc, err := hooks.DocumentFromMap(raw)
		if err != nil {
			return nil, err
		}
		saved, err := hooks.Save(HooksFile(), revision, doc)
		if err != nil {
			return nil, hooksSaveError(err)
		}
		return map[string]any{"hooks": len(saved.Doc.Entries), "path": saved.Path}, nil
	default:
		return nil, fmt.Errorf("unknown hooks action %q", action)
	}
}

// hooksSaveError turns a refusal into the sentence the panel shows.
//
// The two refusals that are about the file *on disk* get a sentence of their own, because
// the fix is not in the form: reload and look, or repair the file by hand. A refusal about
// the new document keeps the validator's own words — it is the authority on why.
func hooksSaveError(err error) error {
	switch {
	case errors.Is(err, hooks.ErrFileChanged):
		return fmt.Errorf("%s changed on disk after this panel was drawn, so nothing was saved. The list now shows the file as it is", HooksFile())
	case errors.Is(err, hooks.ErrFileBroken):
		return fmt.Errorf("%s cannot be used as it is, so it was left untouched. Fix or remove it by hand first: %s",
			HooksFile(), errors.Unwrap(err))
	default:
		return err
	}
}

func nullableInt(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableBool(value *bool) any {
	if value == nil {
		return nil
	}
	return *value
}
