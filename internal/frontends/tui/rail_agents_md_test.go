package tui

import (
	"strings"
	"testing"
)

// TestAFailedAgentMDRowShowsItsReason: the rail's rows are built by
// `state.AgentMDForDisplay`, which marks a file that could not be injected with
// `status: "failed"` and puts the reason under `problem`. The reader looked for `failed`
// and `reason`, which nothing writes — so the one case the mark exists for was drawn as
// though the file had loaded, with its line count where the reason should be.
func TestAFailedAgentMDRowShowsItsReason(t *testing.T) {
	setTheme(defaultTheme)
	t.Cleanup(func() { setTheme(defaultTheme) })

	m := model{width: 120, height: 40, theme: defaultTheme}
	m.sessionID = "20260101-120000"
	m.panel.thinking = true
	m.panel.agentsMD = []any{
		map[string]any{"path": "AGENT.md", "status": "failed", "problem": "读不了：权限不足"},
	}

	rows := m.sessionRows()
	if len(rows) == 0 {
		t.Fatal("a failed AGENT.md produced no rail row at all")
	}
	joined := strings.Join(rows, "\n")
	if !strings.Contains(joined, "!") {
		t.Errorf("a failed file is not marked as failed: %q", joined)
	}
	if !strings.Contains(joined, "权限不足") {
		t.Errorf("the reason is not drawn: %q", joined)
	}
}
