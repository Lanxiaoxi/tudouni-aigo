package tui

import (
	"strings"
	"testing"
)

// The SSH block is display only: the rows answer "what am I connected to and
// is it still alive", and the operations stay with the ssh_* tools. These
// tests pin the shape — mark for live/ended, the alias when it differs, the
// ended row's reason — because a monochrome terminal must still tell them
// apart (shape first, colour second).
func TestSSHRailBlockDrawsLiveAndEndedSessions(t *testing.T) {
	withColour(t)

	m := filledModel(120, 40)
	m.panel.ssh = []any{
		map[string]any{
			"id": "ssh-01", "alias": "tudouni", "destination": "tudouni@192.168.1.200:22",
			"status": "running", "exit_code": nil,
		},
		map[string]any{
			"id": "ssh-02", "alias": "", "destination": "deploy@10.0.1.5:22",
			"status": "exited", "exit_code": 0,
		},
	}
	rendered := stripANSI(m.renderRail(m.railWidthFor(), 40))

	if !strings.Contains(rendered, "SSH sessions") {
		t.Errorf("the SSH block is missing:\n%s", rendered)
	}
	if !strings.Contains(rendered, "● tudouni →") {
		// What must be there is the live mark and the alias; the destination
		// follows after the arrow (line wrapping may split it, so asserting
		// on the joined name would fight the wrap, not the block).
		t.Errorf("the live session row is missing or unmarked:\n%s", rendered)
	}
	if strings.Count(rendered, "● tudouni") != 1 {
		t.Errorf("the live mark appears other than once:\n%s", rendered)
	}
	if !strings.Contains(rendered, "○ deploy@10.0.1.5") {
		t.Errorf("the ended session row is missing or unmarked:\n%s", rendered)
	}
	// Ended rows say how they ended: a hollow dot alone could read as
	// "connecting".
	if !strings.Contains(rendered, "ended") {
		t.Errorf("the ended session does not say how it ended:\n%s", rendered)
	}
}

// The badge counts only the live sessions: ended ones the workspace keeps on
// its list are history, and counting them over "No SSH sessions"' own block
// would read as a connection that is gone.
func TestSSHRailBadgeCountsLiveOnly(t *testing.T) {
	withColour(t)

	m := filledModel(120, 40)
	m.panel.ssh = []any{
		map[string]any{"id": "ssh-01", "destination": "a@h:22", "status": "running", "exit_code": nil},
		map[string]any{"id": "ssh-02", "destination": "b@h:22", "status": "exited", "exit_code": 0},
		map[string]any{"id": "ssh-03", "destination": "c@h:22", "status": "killed", "exit_code": nil},
	}
	rendered := stripANSI(m.renderRail(m.railWidthFor(), 40))

	if !strings.Contains(rendered, "SSH sessions · 1") {
		t.Errorf("the badge should read 1 live of 3 known:\n%s", rendered)
	}
	// An empty list takes the empty state, not a zero badge.
	empty := filledModel(120, 40)
	renderedEmpty := stripANSI(empty.renderRail(empty.railWidthFor(), 40))
	if strings.Contains(renderedEmpty, "SSH sessions · 0") {
		t.Errorf("an empty SSH list drew a zero badge:\n%s", renderedEmpty)
	}
}

// The folded rail's summary line answers the same question in one row.
func TestSSHRailSummarySoundsOnlyWhenLive(t *testing.T) {
	withColour(t)

	m := filledModel(120, 40)
	m.panel.ssh = []any{
		map[string]any{"id": "ssh-01", "destination": "a@h:22", "status": "running", "exit_code": nil},
		map[string]any{"id": "ssh-02", "destination": "b@h:22", "status": "exited", "exit_code": 0},
	}
	summary := m.renderRailSummary()
	if !strings.Contains(summary, "1 SSH session") {
		t.Errorf("the summary does not mention the live session: %q", stripANSI(summary))
	}

	ended := filledModel(120, 40)
	ended.panel.ssh = []any{
		map[string]any{"id": "ssh-02", "destination": "b@h:22", "status": "exited", "exit_code": 0},
	}
	if summary := ended.renderRailSummary(); strings.Contains(stripANSI(summary), "SSH session") {
		t.Errorf("an all-ended list is not worth a summary segment: %q", stripANSI(summary))
	}
}
