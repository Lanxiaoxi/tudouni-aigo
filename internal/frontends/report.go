// Package frontends holds what the two interfaces share.
//
// The rule here is narrow on purpose: **anything two front ends both say has to
// be written once.** A number that appears in three places in three shapes makes
// the reader believe there are three numbers — and the compaction report is
// exactly that kind of text, since every figure in it (how many messages were
// folded, how many tokens were saved, how long it took) comes from one run and
// has to agree wherever it is shown.
package frontends

import (
	"fmt"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// RenderContext is the `/context` screen, as plain text.
//
// Why this is its own screen rather than a block inside `/status`: `/status`
// answers "what state is it in" (session, model, ledger, environment), while
// this answers "how much can the model see, how much has been folded away, how
// far has history been compacted". Those are the numbers people watch
// repeatedly — right after a compaction, or when they suspect the context is
// nearly full — and buried in the other screen they would not be visible.
//
// An empty payload means "this runtime has no context management", which is said
// in words rather than shown as a row of zeroes: a row of zeroes reads as
// "enabled, and it did nothing".
func RenderContext(message map[string]any) string {
	container, _ := message["context"].(map[string]any)
	if len(container) == 0 {
		return i18n.T("context.none")
	}
	stats, _ := container["context"].(map[string]any)

	used := numberOr(stats["estimated_tokens"])
	limit := numberOr(stats["limit_tokens"])
	threshold := numberOr(stats["compact_threshold"])

	lines := []string{i18n.T("context.title")}

	if window := numberOr(container["window"]); window > 0 {
		lines = append(lines, kvLine(i18n.T("context.kv.window"), state.TokensText(&window)))
	}

	if limit > 0 {
		percent := fmt.Sprintf("%.0f", float64(used)/float64(limit)*100)
		lines = append(lines, kvLine(i18n.T("context.kv.tokens"), i18n.T("context.tokens",
			"used", state.TokensText(&used),
			"limit", state.TokensText(&limit),
			"percent", percent)))
		// The compaction line is the answer to "when does it compact by itself",
		// which is the question people actually ask; the other two numbers are
		// what makes it interpretable.
		thresholdText := i18n.T("context.no_window")
		if threshold > 0 {
			thresholdText = i18n.T("context.threshold", "line", state.TokensText(&threshold))
		}
		lines = append(lines, kvLine(i18n.T("context.kv.threshold"), thresholdText))
	} else {
		// Window unknown: usage without a ratio. A wrong percentage is worse than
		// none, the same rule the status bar follows.
		lines = append(lines, kvLine(i18n.T("context.kv.tokens"),
			i18n.T("context.tokens_plain", "used", state.TokensText(&used))))
		lines = append(lines, kvLine(i18n.T("context.kv.threshold"), i18n.T("context.no_window")))
	}

	lines = append(lines, kvLine(i18n.T("context.kv.artifacts"), i18n.T("context.artifacts",
		"artifacts", numberOr(stats["artifacts"]),
		"open", numberOr(stats["open"]),
		"live", numberOr(stats["items"]),
		"removed", numberOr(stats["removed"]),
		"pinned", numberOr(stats["pinned"]),
		"degraded", numberOr(stats["degraded"]))))

	// The compaction half. **Not compacted says so**, rather than a row of
	// zeroes — a row of zeroes reads as "it compacted and folded nothing".
	if flag, _ := container["active"].(bool); flag {
		lines = append(lines, kvLine(i18n.T("context.kv.folded"), i18n.T("context.folded",
			"folded", numberOr(container["folded"]),
			"messages", numberOr(container["messages"]),
			"generation", numberOr(container["generation"]))))
		summaryID := textOr(container["summary_id"])
		if len(summaryID) > 24 {
			summaryID = summaryID[:24]
		}
		lines = append(lines, kvLine(i18n.T("context.kv.summary"), i18n.T("context.summary",
			"id", summaryID, "chars", grouped(numberOr(container["summary_chars"])))))
	} else {
		lines = append(lines, kvLine(i18n.T("context.kv.folded"), i18n.T("context.not_folded")))
	}

	// That last line is a cost disclosure, not decoration: compaction does not
	// touch the session file, and "is the original still there" is the first
	// question everybody asks after using it once.
	lines = append(lines, i18n.T("context.footer"))
	return strings.Join(lines, "\n")
}

// RenderCompaction is the answer to `/compact`.
//
// Five outcomes get five sentences, because what the user should do differs
// completely: it compacted (read the numbers), nothing to fold (do nothing), one
// is already running (wait), this runtime cannot compact (nothing here will
// help), or it failed (nothing changed — look at stderr). Collapsing them into
// "compaction finished" would hide the last four, which is the worst failure this
// feature can have.
func RenderCompaction(result map[string]any) string {
	switch textOr(result["status"]) {
	case "compacted":
		common := []any{
			"folded", numberOr(result["folded"]),
			"total", numberOr(result["total_folded"]),
			"messages", numberOr(result["messages"]),
			"chars", grouped(numberOr(result["summary_chars"])),
			"seconds", fmt.Sprintf("%.1f", float64(numberOr(result["duration_ms"]))/1000),
		}
		before, after := numberOr(result["before"]), numberOr(result["after"])
		if before > 0 && after > 0 {
			common = append(common,
				"before", state.TokensText(&before),
				"after", state.TokensText(&after))
			return i18n.T("channels.compact.done", common...)
		}
		return i18n.T("channels.compact.done_no_tokens", common...)
	case "busy":
		return i18n.T("channels.compact.busy")
	case "no_context":
		return i18n.T("channels.compact.no_context")
	default:
		return i18n.T("channels.compact.nothing")
	}
}

// RenderTools is the tool list plus the rules that release a command without
// asking.
//
// The disposition is on every row rather than summarised, because "will this one
// ask me" is the only question the list is consulted for, and a summary at the
// bottom would make the reader join two lists by eye.
func RenderTools(message map[string]any) string {
	tools, _ := message["tools"].([]any)
	if len(tools) == 0 {
		return i18n.T("tools.none")
	}
	var builder strings.Builder
	for _, item := range tools {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		disposition, _ := row["disposition"].(string)
		fmt.Fprintf(&builder, "  %-18s %-7s %s\n", row["name"], row["risk"], dispositionText(disposition))
	}
	prefixes, _ := message["granted_prefixes"].([]string)
	if len(prefixes) > 0 {
		builder.WriteString(i18n.T("tools.prefixes", "rules", strings.Join(prefixes, ", ")) + "\n")
	}
	builder.WriteString(i18n.T("tools.footer"))
	return builder.String()
}

// RenderSkills is the `/skills` listing.
//
// The path travels with every name because "where did this one come from" is the
// only question the list is consulted for that a name cannot answer — there are six
// possible directories, and whether the file somebody just edited is the one in
// effect depends entirely on which.
//
// The scanned directories always print, even when nothing was found: the
// user-level ones sit outside the workspace, so nobody thinks to look there unless
// they are named. And shadowed copies are printed because they are the worst of the
// three — the file exists on disk and does not count, so silence means somebody
// edits a file that never takes effect.
func RenderSkills(message map[string]any) string {
	var lines []string

	rows, _ := message["skills"].([]any)
	if len(rows) == 0 {
		lines = append(lines, i18n.T("skills.empty"))
	} else {
		lines = append(lines, i18n.T("skills.title"))
		for _, item := range rows {
			row, ok := item.(map[string]any)
			if !ok {
				continue
			}
			lines = append(lines, fmt.Sprintf("  %s（%s）", textOr(row["name"]), textOr(row["path"])))
		}
	}

	if active := stringList(message["active"]); len(active) > 0 {
		lines = append(lines, i18n.T("skills.active_label")+strings.Join(active, "、"))
	}

	roots := stringList(message["roots"])
	if len(roots) > 0 {
		lines = append(lines, i18n.T("skills.scan_dirs"))
		for _, root := range roots {
			lines = append(lines, "    "+root)
		}
	} else {
		lines = append(lines, i18n.T("skills.scan_dirs"), i18n.T("skills.scan_none"))
	}

	for _, problem := range stringList(message["problems"]) {
		lines = append(lines, problem)
	}
	for _, item := range stringList(message["shadowed"]) {
		lines = append(lines, i18n.T("skills.shadowed_line", "item", item))
	}

	return strings.Join(lines, "\n")
}

func stringList(value any) []string {
	items, ok := value.([]any)
	if !ok {
		if direct, ok := value.([]string); ok {
			return direct
		}
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, fmt.Sprint(item))
	}
	return out
}

func dispositionText(disposition string) string {
	switch disposition {
	case "auto":
		return i18n.T("tools.disposition.auto")
	case "deny":
		return i18n.T("tools.disposition.deny")
	default:
		return i18n.T("tools.disposition.ask")
	}
}

func kvLine(label, value string) string {
	return fmt.Sprintf("  %s  %s", label, value)
}

// grouped writes 8412 as 8,412. The character count of a tool result is the only
// number on this screen that reaches five digits, and it is read at a glance.
func grouped(count int) string {
	digits := fmt.Sprintf("%d", count)
	if count < 0 || len(digits) <= 3 {
		return digits
	}
	var builder strings.Builder
	for index, r := range digits {
		if index > 0 && (len(digits)-index)%3 == 0 {
			builder.WriteByte(',')
		}
		builder.WriteRune(r)
	}
	return builder.String()
}

func numberOr(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	default:
		return 0
	}
}

func textOr(value any) string {
	text, _ := value.(string)
	return text
}
