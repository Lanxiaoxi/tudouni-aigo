package tui

import (
	"fmt"
	"strings"

	"github.com/mattn/go-runewidth"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// The `/status` screen and the `/tools` list.
//
// They are rendered here rather than reused from the line interface because the
// two front ends answer different questions with them. The line interface prints
// plain text to a terminal that is already scrolling; this one has colour roles
// and a screen that is looked at repeatedly, so the figures are separated into
// labelled rows and the risk column is painted. What must not differ is the
// numbers — they all come from the same payload.

// kvLine is `  label  value`, aligned on a label column.
//
// The label width is measured per screen rather than fixed: the labels are
// translated, and a fixed width would either clip the longest one or leave the
// values stranded far to the right.
func kvLine(label, value string, labelWidth int) renderLine {
	pad := labelWidth - runewidth.StringWidth(label)
	if pad < 1 {
		pad = 1
	}
	return renderLine{segments: []seg{
		{text: "  " + label + strings.Repeat(" ", pad), role: "rule"},
		{text: value, role: "process"},
	}}
}

// statusScreen renders `/status`: which session, which model, what it has cost,
// and the environment this run is in.
//
// The order is the order the questions get asked. "Which session am I in and
// what is it using" comes first; the audit path, which is also available from
// `/audit`, comes last.
func (m model) statusScreen(payload map[string]any) []renderLine {
	status, _ := payload["status"].(map[string]any)
	session, _ := status["session"].(map[string]any)
	if len(session) == 0 {
		// Nothing has run yet: saying "0 turns · 0 calls" would present a fact
		// that does not exist. What is true is that no turn has happened.
		return []renderLine{{segments: []seg{{text: i18n.T("status.no_state"), role: "rule"}}}}
	}
	modelInfo, _ := status["model"].(map[string]any)
	counters, _ := status["counters"].(map[string]any)
	usage, _ := status["usage"].(map[string]any)
	meta, _ := status["meta"].(map[string]any)

	rows := [][2]string{}
	labelWidth := 0
	add := func(label, value string) {
		if width := runewidth.StringWidth(label) + 2; width > labelWidth {
			labelWidth = width
		}
		rows = append(rows, [2]string{label, value})
	}

	resumed := false
	if value, ok := session["resumed"].(bool); ok {
		resumed = value
	}
	started := i18n.T("status.started.new")
	if resumed {
		started = i18n.T("status.started.resumed")
	}
	add(i18n.T("status.kv.session"), i18n.T("status.session_id",
		"name", textOf2(session, "id", "?"), "started", started))
	add(i18n.T("status.kv.workspace"), workspaceName(textOf2(session, "workspace", "—")))
	add(i18n.T("status.kv.size"), i18n.T("rail.session.size",
		"messages", i18n.Tn("rail.session.messages", intOf(session["messages"]), "n", intOf(session["messages"])),
		"steps", i18n.Tn("rail.session.steps", intOf(session["steps"]), "n", intOf(session["steps"]))))

	// "What it is using" versus "what it was asked for" are different facts: the
	// second is only briefly ahead of the first, right after `/model`. Not saying
	// so makes "I changed it and nothing happened" the natural reading of a
	// perfectly correct sequence.
	current := textOf2(modelInfo, "current", "—")
	provider := textOf2(modelInfo, "provider", "")
	selected := textOf2(modelInfo, "selected", "")
	pending := selected != "" && selected != current
	if pending {
		current = i18n.T("status.model.pending", "current", current, "selected", selected)
	}
	if provider != "" {
		current = fmt.Sprintf("%s  @%s", current, provider)
	}
	add(i18n.T("status.kv.model"), current)
	if base := textOf2(modelInfo, "base_url", ""); base != "" && !strings.Contains(base, "api.deepseek.com") {
		add(i18n.T("status.kv.endpoint"), base)
	}

	reasoning, _ := modelInfo["reasoning"].(map[string]any)
	thinking := true
	if value, ok := reasoning["thinking"].(bool); ok {
		thinking = value
	}
	effort := textOf2(reasoning, "effort", "")
	if thinking {
		add(i18n.T("status.kv.thinking"), i18n.T("status.thinking.on", "effort", effort))
	} else {
		add(i18n.T("status.kv.thinking"), i18n.T("status.thinking.off"))
	}

	// The context row: numerator from the last request (the provider's own
	// number), denominator from the model's window. With no window there is no
	// percentage — a wrong one is worse than none.
	used, hasUsed := intOrNil(payload["last_prompt_tokens"])
	window := intOf(payload["context_tokens"])
	switch {
	case !hasUsed:
		add(i18n.T("status.kv.context"), i18n.T("status.context.unknown"))
	case window > 0:
		add(i18n.T("status.kv.context"), i18n.T("status.context.ratio",
			"used", stateTokensText(used), "window", stateTokensText(window),
			"percent", fmt.Sprintf("%.1f", float64(used)/float64(window)*100)))
	default:
		add(i18n.T("status.kv.context"), i18n.T("status.context.no_window",
			"used", stateTokensText(used)))
	}

	// The context system's own ledger. It is a different fact from the row above
	// — local estimate plus tiers versus what the provider actually received —
	// so both are shown; only the first would hide how much was degraded.
	if ledger, ok := status["context"].(map[string]any); ok && len(ledger) > 0 {
		add(i18n.T("status.kv.artifacts"), i18n.T("status.artifacts.value",
			"total", intOf(ledger["artifacts"]), "open", intOf(ledger["open"]),
			"compact", intOf(ledger["compact"]), "removed", intOf(ledger["removed"]),
			"pinned", intOf(ledger["pinned"])))
		limit := intOf(ledger["limit_tokens"])
		estimate := intOf(ledger["estimated_tokens"])
		if limit > 0 {
			add(i18n.T("status.kv.budget"), i18n.T("status.budget.ratio",
				"used", stateTokensText(estimate), "limit", stateTokensText(limit),
				"percent", fmt.Sprintf("%.0f", float64(estimate)/float64(limit)*100)))
		} else {
			add(i18n.T("status.kv.budget"), i18n.T("status.budget.no_window",
				"used", stateTokensText(estimate)))
		}
	}

	// Money. The cache rate is the one number that explains why two identical
	// turns differ in cost, and it is only meaningful next to the total.
	if prompt := intOf(usage["prompt"]); prompt > 0 {
		cached := intOf(usage["cached"])
		add(i18n.T("status.kv.input_total"), i18n.T("status.usage.input",
			"tokens", stateTokensText(prompt), "cached", stateTokensText(cached),
			"rate", fmt.Sprintf("%.0f%%", float64(cached)/float64(prompt)*100)))
		// The output row carries the **session's** average rate rather than the
		// last call's, and the wording says "over N calls" so the two on-screen
		// rates cannot be mistaken for each other: this screen answers "what has
		// this session cost", while the status bar's segment answers "how fast was
		// the step that just finished". Same figure family, two different
		// questions, and only the label keeps them apart.
		completion := intOf(usage["completion"])
		modelMs := intOf(usage["model_ms"])
		if rate, ok := state.OutputRateText(completion, modelMs); ok {
			add(i18n.T("status.kv.output_total"), i18n.T("status.usage.output.rate",
				"tokens", stateTokensText(completion), "rate", rate,
				"calls", intOf(counters["model_ok"])))
		} else {
			// No measurable call: the row still exists, because a reader looking
			// for "how much did it write" is owed the token count either way.
			add(i18n.T("status.kv.output_total"), i18n.T("status.usage.output",
				"tokens", stateTokensText(completion)))
		}
	} else {
		add(i18n.T("status.kv.usage_total"), i18n.T("status.usage.none"))
	}

	// Turns and calls. "Tool calls" includes the refused ones: the number answers
	// "how much work happened", not "how much succeeded".
	waits, asks := intOf(counters["permission_waits"]), intOf(counters["asks"])
	tail := ""
	if waits > 0 || asks > 0 {
		tail = i18n.T("status.turns.waits", "waits", waits)
		if asks > 0 {
			tail += i18n.T("status.turns.asks", "asks", asks)
		} else {
			tail += i18n.T("status.turns.close")
		}
	}
	add(i18n.T("status.kv.turns"), i18n.T("status.turns.value",
		"runs", intOf(counters["runs"]), "model_calls", intOf(counters["model_calls"]),
		"tool_calls", intOf(counters["tool_calls"]), "tail", tail))

	streamKey := "status.run.no_stream"
	if flag, _ := meta["stream"].(bool); flag {
		streamKey = "status.run.stream"
	}
	autopilotKey := "status.run.ask"
	if flag, _ := meta["autopilot"].(bool); flag {
		autopilotKey = "status.run.autopilot"
	}
	add(i18n.T("status.kv.run"), strings.Join([]string{
		i18n.T("status.run.max_steps", "n", intOf(meta["max_steps"])),
		i18n.T(streamKey),
		i18n.T(autopilotKey),
	}, " · "))
	add(i18n.T("status.kv.tools"), i18n.T("status.tools.count", "n", intOf(meta["tool_count"])))
	add(i18n.T("status.kv.audit"), textOf2(meta, "audit_path", "—"))

	out := []renderLine{{segments: []seg{{text: i18n.T("status.title"), role: "rule"}}}}
	for _, row := range rows {
		out = append(out, kvLine(row[0], row[1], labelWidth))
	}
	return out
}

// toolsScreen renders `/tools`.
//
// Every tool is listed, not only the ones that run without asking: "does this
// tool exist" and "will it ask me" are two questions, and this screen is the one
// place that answers both. The marks say what the risk column cannot — that a
// tool is external, that it cannot run in parallel, that it takes over the input.
func (m model) toolsScreen(payload map[string]any) []renderLine {
	rows, _ := payload["tools"].([]any)
	if len(rows) == 0 {
		// Not an empty list: it means nothing registered at all (a missing binary
		// or a missing key drops the tool). Saying so beats a blank screen.
		return []renderLine{{segments: []seg{{text: i18n.T("tools.none"), role: "warn"}}}}
	}
	width := 0
	for _, item := range rows {
		if row, ok := item.(map[string]any); ok {
			if name, ok := row["name"].(string); ok && len(name) > width {
				width = len(name)
			}
		}
	}
	out := []renderLine{{segments: []seg{{text: i18n.T("status.kv.tools"), role: "rule"}}}}
	for _, item := range rows {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name := textOf2(row, "name", "?")
		disposition := textOf2(row, "disposition", "")
		role := "rule"
		switch disposition {
		case "ask":
			role = "waiting"
		case "deny":
			role = "denied"
		}
		parts := []seg{
			{text: "  " + name + strings.Repeat(" ", maxInt(2, width-len(name)+2)), role: "process"},
			{text: fmt.Sprintf("%-7s", textOf2(row, "risk", "?")), role: "rule"},
			{text: i18n.LookupOr("tools.disposition."+disposition, "?"), role: role},
		}
		var marks []string
		if flag, _ := row["granted"].(bool); flag {
			marks = append(marks, i18n.T("tools.mark.granted"))
		}
		if flag, _ := row["external"].(bool); flag {
			marks = append(marks, i18n.T("tools.mark.external"))
		}
		interactive, _ := row["interactive"].(bool)
		parallel, _ := row["parallel_safe"].(bool)
		if interactive {
			marks = append(marks, i18n.T("tools.mark.interactive"))
		} else if parallel {
			marks = append(marks, i18n.T("tools.mark.parallel"))
		}
		if len(marks) > 0 {
			parts = append(parts, seg{text: "  ·  " + strings.Join(marks, i18n.T("list.separator")), role: "rule"})
		}
		out = append(out, renderLine{segments: parts})
	}
	if rules := stringList(payload["granted_prefixes"]); len(rules) > 0 {
		// Command-prefix rules only apply to tools that take a command line.
		// Without that sentence the reader assumes "git add" also releases
		// read_file.
		out = append(out, renderLine{segments: []seg{
			{text: i18n.T("tools.prefixes", "rules", strings.Join(rules, i18n.T("list.separator"))), role: "rule"},
		}})
	}
	out = append(out, renderLine{segments: []seg{{text: i18n.T("tools.footer"), role: "rule"}}})
	return out
}

// textOf2 reads a string field with a fallback.
func textOf2(row map[string]any, key, fallback string) string {
	if text, ok := row[key].(string); ok && text != "" {
		return text
	}
	return fallback
}

// intOrNil reports a number only when the field was present: "no request has
// succeeded yet" and "the last request sent zero tokens" are different facts.
func intOrNil(value any) (int, bool) {
	switch typed := value.(type) {
	case nil:
		return 0, false
	case int:
		return typed, true
	case int64:
		return int(typed), true
	case float64:
		return int(typed), true
	}
	return 0, false
}
