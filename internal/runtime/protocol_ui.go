package runtime

import (
	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/skills"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
)

// InitFields implements protocol.Runtime.
func (r *Runtime) InitFields() map[string]any {
	rows := make([]any, 0, r.Tools.Len())
	for _, tool := range r.Tools.All() {
		rows = append(rows, map[string]any{
			"name":          tool.Name,
			"risk":          string(tool.Risk),
			"parallel_safe": tool.ParallelSafe,
			"interactive":   tool.Interactive,
		})
	}
	notices := make([]any, 0, len(r.notices))
	for _, item := range r.notices {
		notices = append(notices, item)
	}

	provider := r.Chat.ProviderName()
	return map[string]any{
		"session_id":     r.SessionIDValue,
		"resumed":        r.Resumed,
		"model":          r.Chat.ModelName(),
		"provider":       provider,
		"thinking":       r.ModelState.Thinking(),
		"effort":         r.ModelState.Effort(),
		"effort_levels":  r.managedLevels(),
		"model_catalog":  r.modelCatalog(),
		"workspace":      paths.WorkspaceDir(),
		"max_steps":      r.MaxSteps,
		"stream":         r.Stream,
		"context_tokens": r.contextTokens(),
		"tools":          rows,
		"permissions":    r.nonDefaultPermissions(),
		"audit_path":     r.auditPath(),
		"notices":        notices,
	}
}

// StateMessage implements protocol.Runtime.
func (r *Runtime) StateMessage(withCatalog bool) map[string]any {
	// The mounted servers, under the name protocol 3.12 gives this snapshot
	// (`mcp`). The `ui(mcp)` reply carries the same rows as `mcp_servers`; this
	// one is what the rail and the `/mcp` panel are drawn from, so hard-coding it
	// empty is what made a mounted server invisible everywhere except the notice
	// that announced it.
	mcpRows, _ := r.mcpInventory(r.mcpConfig())
	payload := map[string]any{
		"todos":            r.todos(),
		"skills":           r.skillPointers(),
		"jobs":             panelOf(r.Jobs),
		"subagents":        r.subagentPanel(),
		"subagents_done":   r.subagentsDonePanel(),
		"messages":         len(r.Messages()),
		"steps":            r.SessionValue.StepCount(),
		"model":            r.Chat.ModelName(),
		"model_provider":   r.Chat.ProviderName(),
		"model_window":     r.modelWindow(),
		"thinking":         r.ModelState.Thinking(),
		"effort":           r.ModelState.Effort(),
		"effort_levels":    r.managedLevels(),
		"autopilot":        r.Agent.Autopilot(),
		"granted_tools":    r.Memory.Tools(),
		"granted_prefixes": formattedRules(r.Memory.Prefixes()),
		"denied_tools":     r.Policy.DenyTools,
		"risk_scope":       r.riskScope(),
		"agents_md":        agentsMDRows(r.SessionValue),
		"mcp":              mcpRows,
		// The workspace's terminals. They are carried on **this** snapshot
		// although they belong to the workspace rather than the session, and that
		// is the point: every tool result and every turn's end re-states the list,
		// so a front end that started after a shell was created — or one that lost
		// the `terminal_created` message — learns about it from the next snapshot
		// instead of never.
		"terminals": r.terminalsPanel(),
		// The workspace's SSH remote sessions. They are carried on this snapshot
		// for the same reason the terminals are: the session list belongs to the
		// workspace, the snapshot is restated on every tool result and turn end,
		// and a front end that lost or never saw a connect learns the current
		// list from the next snapshot instead of never.
		"ssh": r.sshPanel(),
		// The count of memory proposals waiting for review, and the same reason it
		// is here at all: the model's `memory_propose` is a tool, and the only
		// snapshot a tool result re-states is this one. The full snapshot travels
		// on `ui(memory)`, which the front end only asks for when the panel is
		// open — so without this figure a new proposal left the workbench badge
		// empty until a person happened to open the panel, which is how the badge
		// learned about its own queue. A count rather than the list, because this
		// rides on every tool result and parsing every proposal there would make
		// the review queue the workspace's hottest file.
		"memory_pending": r.memoryPending(),
		// The code index, in three booleans: is the capability on, does an index
		// exist, is a build running. Counts stay on `ui(codeintel)` — this rides on
		// every tool result and the workbench only needs enough to decide whether to
		// draw the row at all and whether to badge it.
		"codeintel": r.codeIntelFlags(),
		// Always present, in both the "there is one" and "there is not" shapes: a
		// front end with two cases to draw has two places to get the empty one
		// wrong.
		"goal": r.GoalPanel(),
	}
	// Empty lists go out as `[]`, never as `null`. A front end that has to tell
	// "there are none" apart from "the runtime did not say" is a front end with a
	// second definition of the panel's shape, and the first bug it produces is a
	// crash on the empty case.
	if payload["granted_tools"] == nil {
		payload["granted_tools"] = []string{}
	}
	if payload["denied_tools"] == nil {
		payload["denied_tools"] = []string{}
	}
	if payload["granted_prefixes"] == nil {
		payload["granted_prefixes"] = []string{}
	}
	if withCatalog {
		payload["skill_catalog"] = r.skillCatalogRows()
	}
	return payload
}

// skillPointers is the loaded-skill pointers the state snapshot carries:
// `name` + `digest` for each skill this session has loaded. The digest is the
// only place it travels — a front end needs it to tell "the skill on disk
// changed since it was loaded" (stale) from "still what I loaded" — and it
// must be re-read from the live session metadata on **every** snapshot so the
// one `load_skill` wrote this process shows up on the very next one, and the
// same list read back from a session file survives a `/resume`.
//
// An absent or malformed entry list means "nothing loaded" and goes out as
// `[]`, never `null`: a front end that has to tell the two apart has a second
// definition of the panel's shape, and the first bug it produces is a crash on
// the empty case.
func (r *Runtime) skillPointers() []any {
	snapshot := r.metaSnapshot()
	entries := skills.LoadEntries(snapshot)
	rows := make([]any, 0, len(entries))
	for _, entry := range entries {
		rows = append(rows, map[string]any{"name": entry.Name, "digest": entry.Digest})
	}
	return rows
}

// skillCatalogRows is the one-line-per-skill catalogue the **first** snapshot
// carries: everything this session *can* load, `name` + `description`. It is
// what answers "what exists that I could still load" and is only sent once,
// because a directory scan at boot is the only time the cost is worth it and
// the answer almost never changes. With no board (a runtime built without the
// skill tool) it is an empty `[]` — "there are none" — rather than `null`.
func (r *Runtime) skillCatalogRows() []any {
	if r.Skills == nil {
		return []any{}
	}
	catalog := r.Skills.Catalog()
	rows := make([]any, 0, len(catalog.Skills))
	for _, skill := range catalog.Skills {
		rows = append(rows, map[string]any{"name": skill.Name, "description": skill.Description})
	}
	return rows
}

// StatusMessage implements protocol.Runtime.
func (r *Runtime) StatusMessage() map[string]any {
	var summary map[string]any
	var timing audit.Timing
	hasTurn := false
	if r.Logs != nil {
		summary, timing, hasTurn = r.Logs.Summary(r.SessionIDValue)
	} else {
		summary = state.Summarize(nil)
	}

	counters, _ := summary["counters"].(map[string]any)
	usage, _ := summary["usage"].(map[string]any)

	lastPrompt := intOrNil(summary["last_prompt_tokens"])
	window := r.modelWindow()

	startedAt := "started: new"
	if r.Resumed {
		startedAt = "started: resumed"
	}

	// A status screen must be answerable before anything has run — that is exactly
	// when somebody wants to look at it. Each of these is a nil-safe read rather
	// than an invariant, so building the payload can never be the thing that fails.
	autopilot := false
	if r.Agent != nil {
		autopilot = r.Agent.Autopilot()
	}
	messages, steps := 0, 0
	if r.SessionValue != nil {
		messages = r.SessionValue.MessageCount()
		steps = r.SessionValue.StepCount()
	}
	toolCount := 0
	if r.Tools != nil {
		toolCount = r.Tools.Len()
	}

	// The wall time the **last turn** spent, one field per bucket, plus the
	// turn's own total and whatever nothing measured of it. It is the same
	// breakdown `audit.LastTurnTime` gives — `SummarizeTime` over that turn's
	// `run_id` — not a re-derivation: the `--audit` line and this group must agree
	// about what a bucket *is*, and a second division of the same events is a
	// second source for the same fact. The sink folds it in as the records are
	// read, so this panel costs nothing extra.
	//
	// **Per turn, not cumulative.** The panel that reaches for this is reached
	// from the status bar's turn chip, and the chip's number is one turn's
	// total — a session-cumulative bucket beside it would not add up to it,
	// which is the mixture `stats.turn` refuses. `run_ms` and
	// `unattributed` ride here rather than in the session group: they are
	// defined against a turn's total, and the total is the turn's own
	// `run_finished.duration_ms`.
	//
	// **null, not a zero row, when no turn has run.** The session totals above
	// answer before anything has run because a zero row there reads "new
	// session". A zero row *here* would read "the turn you clicked on took
	// 0ms of model time and 0ms of tools", which is a false statement about a
	// turn that does not exist yet; the absent group is the true one, and a
	// front end that predates protocol 5 ignores it either way.
	var timingRow map[string]any
	if hasTurn {
		timingRow = map[string]any{
			"run_ms":       timing.RunMs,
			"model_ms":     timing.ModelMs,
			"tool_ms":      timing.ToolMs,
			"waited_ms":    timing.WaitedMs,
			"human_ms":     timing.HumanMs,
			"backoff_ms":   timing.BackoffMs,
			"saved_ms":     timing.SavedMs,
			"unattributed": timing.UnattributedMs(),
		}
	}

	status := map[string]any{
		"session": map[string]any{
			"id":        r.SessionIDValue,
			"resumed":   r.Resumed,
			"workspace": paths.WorkspaceDir(),
			"messages":  messages,
			"steps":     steps,
		},
		"model": map[string]any{
			"provider":  r.Chat.ProviderName(),
			"current":   r.Chat.ModelName(),
			"selected":  r.ModelState.Selected(),
			"last_used": r.ModelState.LastUsed(),
			"since":     r.ModelState.SelectedSince(),
			"window":    window,
			"base_url":  r.Chat.BaseURL(),
			// The two thinking knobs are session-level settings, exactly like the
			// model, so they live in the same group: "what is it using" means who,
			// which route, whether it thinks, and how hard.
			//
			// It is an **object**, not the effort string. A front end reading
			// `reasoning["thinking"]` off a string gets nothing, falls back to its
			// own default, and reports "thinking: on" for a session where it is off.
			"reasoning": map[string]any{
				"thinking": r.ModelState.Thinking(),
				"effort":   r.ModelState.Effort(),
			},
		},
		"counters": counters,
		"usage":    usage,
		"timing":   timingRow,
		// The context ledger travels with the status screen rather than only with
		// `/context`: "how much can it see, and how much did the budget drop" is
		// part of the question `/status` exists to answer. Nil means this runtime
		// has no context layer, which is a different statement from a zero row.
		"context": r.contextLedger(),
		"meta": map[string]any{
			"max_steps":   r.MaxSteps,
			"stream":      r.Stream,
			"autopilot":   autopilot,
			"tool_count":  toolCount,
			"audit_path":  r.auditPath(),
			"permissions": r.nonDefaultPermissions(),
			"started":     startedAt,
			// Which file the catalogue came from. It is a fact rather than
			// decoration: it is the answer to "why did my edit not take effect".
			"catalog": r.Catalog.Source,
		},
	}
	return map[string]any{
		"status":             status,
		"last_prompt_tokens": lastPrompt,
		"context_tokens":     window,
	}
}

// ToolsMessage implements protocol.Runtime.
func (r *Runtime) ToolsMessage() map[string]any {
	rows := make([]any, 0, r.Tools.Len())
	for _, tool := range r.Tools.All() {
		disposition := r.Policy.Disposition(tool.Name, tool.Risk)
		var command any
		if parameter, ok := security.CommandParameter(tool.Name); ok {
			command = parameter
		}
		rows = append(rows, map[string]any{
			"name":          tool.Name,
			"risk":          string(tool.Risk),
			"disposition":   disposition,
			"parallel_safe": tool.ParallelSafe,
			"interactive":   tool.Interactive,
			"external":      tool.External,
			"granted":       r.Memory.Has(tool.Name),
			"command":       command,
		})
	}
	return map[string]any{
		"tools":            rows,
		"granted_prefixes": formattedRules(r.Memory.Prefixes()),
	}
}

// SkillsMessage implements protocol.Runtime.
//
// It lists what **this session** can load, not what a fresh scan would find: the
// board rescans on read, so a skill added while the session is open appears here
// and is immediately loadable. A catalogue that shows a skill the loader cannot
// find is the one state this must never be in.
func (r *Runtime) SkillsMessage() map[string]any {
	empty := map[string]any{
		"skills": []any{}, "active": []any{}, "roots": []any{},
		"problems": []any{}, "shadowed": []any{},
	}
	if r.Skills == nil || r.SessionValue == nil {
		return empty
	}
	catalog := r.Skills.Catalog()

	rows := make([]any, 0, len(catalog.Skills))
	for _, skill := range catalog.Skills {
		shadowed := make([]any, 0)
		for _, path := range skill.Shadowed() {
			shadowed = append(shadowed, path)
		}
		rows = append(rows, map[string]any{
			"name":        skill.Name,
			"description": skill.Description,
			"path":        skill.Path,
			"shadowed":    shadowed,
		})
	}

	active := make([]any, 0)
	for _, name := range skills.ActiveNames(r.metaSnapshot()) {
		active = append(active, name)
	}

	roots := make([]any, 0, len(catalog.Roots))
	for _, root := range catalog.Roots {
		roots = append(roots, root)
	}

	// Problems are rendered here rather than sent as codes: the sentence belongs to
	// the interface's language, and every front end would otherwise carry a copy of
	// the same switch.
	problems := make([]any, 0, len(catalog.Problems))
	for _, problem := range catalog.Problems {
		problems = append(problems, skills.RenderProblem(problem))
	}
	shadowedLines := make([]any, 0, len(catalog.Shadowed))
	for _, problem := range catalog.Shadowed {
		shadowedLines = append(shadowedLines, skills.RenderProblem(problem))
	}

	return map[string]any{
		"skills":   rows,
		"active":   active,
		"roots":    roots,
		"problems": problems,
		"shadowed": shadowedLines,
	}
}

// Compact implements protocol.Runtime.
//
// "no_context" is reported by this layer rather than by the agent: a runtime
// built without the context system cannot compact at all, and that is a
// different answer from "there was nothing to fold" — the user's move differs
// (nothing to do versus nothing to do here).
func (r *Runtime) Compact() (map[string]any, error) {
	if r.Agent == nil || r.ContextValue == nil {
		return map[string]any{
			"compaction": map[string]any{"status": "no_context"},
		}, nil
	}
	return map[string]any{
		"compaction": r.Agent.CompactNow(),
		"context":    r.contextPayload(),
	}, nil
}

// --- helpers ----------------------------------------------------------------

// todos is the task list as the panel payload carries it.
//
// The reading of the two stored shapes lives in `builtin.TodoRows`, not here: this
// function used to accept only the `[]any` a session file decodes to, so a list the
// model had just written (a `[]map[string]any` in live metadata) came back as "no
// tasks" for the whole session — the rail's Tasks block stayed empty until the
// session was resumed, which is the one moment the list has been through JSON.
func (r *Runtime) todos() []any {
	return builtin.TodoRows(r.metaSnapshot())
}

func (r *Runtime) riskScope() []any {
	rows := make([]any, 0, 3)
	for _, risk := range []security.RiskLevel{security.RiskLow, security.RiskMedium, security.RiskHigh} {
		disposition := "ask"
		if r.Policy.AutoApproves(risk) {
			disposition = "auto"
		}
		rows = append(rows, map[string]any{"risk": string(risk), "disposition": disposition})
	}
	return rows
}

// nonDefaultPermissions reports only what differs from the default, so the
// interface can leave the line out entirely on an ordinary run.
//
// Deciding what counts as non-default is the configuration's knowledge; a front end
// hard-coding its own idea of "default" would be a second source for the same fact,
// and it drifts by *failing to show something it should*.
func (r *Runtime) nonDefaultPermissions() map[string]any {
	out := map[string]any{}
	if !sameStrings(r.Permissions.AutoApprove, []string{string(security.RiskLow)}) {
		out["auto_approve"] = r.Permissions.AutoApprove
	}
	if len(r.Permissions.AutoApproveTools) > 0 {
		out["auto_approve_tools"] = r.Permissions.AutoApproveTools
	}
	if len(r.Permissions.DenyTools) > 0 {
		out["deny_tools"] = r.Permissions.DenyTools
	}
	if len(r.Permissions.ShellAllow) > 0 {
		out["shell_allow"] = formattedRules(r.Permissions.ShellAllow)
	}
	return out
}

func (r *Runtime) auditPath() string {
	if r.Logs == nil {
		return ""
	}
	path, err := r.Logs.Path(r.SessionIDValue)
	if err != nil {
		return ""
	}
	return path
}

// agentMDNotices turns the AGENT.md report stored in a session's metadata back into
// the start-up lines about it.
//
// The report is read back from the session rather than from disk, for the reason
// `AgentMDForDisplay` gives for doing the same: a restored session has to describe
// the prompt it actually carries. The file may have been fixed, deleted or grown
// since, and a notice about today's copy would be a statement about a different
// session's prompt.
//
// A session with no AGENT.md has no record and produces no lines: not having the file
// is the normal state, and a line for it would bury the cases that do matter.
func agentMDNotices(session *state.Session) []map[string]any {
	if session == nil {
		return nil
	}
	value, _ := session.Meta().Value(state.AgentMDSessionKey)
	block, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	var report state.AgentMDReport
	if loaded, ok := block["loaded"].([]any); ok {
		for _, item := range loaded {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			report.Loaded = append(report.Loaded, state.AgentMDLoaded{
				Path:       stringOf(entry["path"]),
				Lines:      intOf(entry["lines"]),
				TotalLines: intOf(entry["total_lines"]),
				Dropped:    intOf(entry["dropped"]),
				Omitted:    intOf(entry["omitted"]),
			})
		}
	}
	if failures, ok := block["failures"].([]any); ok {
		for _, item := range failures {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			report.Failures = append(report.Failures, state.AgentMDFailure{
				Path:   stringOf(entry["path"]),
				Reason: stringOf(entry["reason"]),
			})
		}
	}
	// Sessions written before both spellings were read have no `ignored` list, and a
	// missing one is not a zero — it means the question was never asked.
	if ignored, ok := block["ignored"].([]any); ok {
		for _, item := range ignored {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			report.Ignored = append(report.Ignored, state.AgentMDIgnored{
				Path:   stringOf(entry["path"]),
				Winner: stringOf(entry["winner"]),
			})
		}
	}
	if !report.HasAnything() {
		return nil
	}
	out := make([]map[string]any, 0, 2)
	for _, line := range state.AgentMDNotices(report, paths.WorkspaceDir()) {
		out = append(out, notice(line[0], line[1], line[2]))
	}
	return out
}

func agentsMDRows(session *state.Session) []any {
	block, _ := session.Meta().Value(state.AgentMDSessionKey)
	rows := state.AgentMDForDisplay(block, paths.WorkspaceDir())
	out := make([]any, 0, len(rows))
	for _, row := range rows {
		out = append(out, row)
	}
	return out
}
