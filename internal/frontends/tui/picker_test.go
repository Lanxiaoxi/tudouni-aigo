package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
)

// TestTheModelPickerMarksTheModelInEffect — the row in effect carries the dot, and
// the cursor opens on the row after it.
//
// The marker used to be the word "(current)" inside the row's note, found by an
// exact match — but the note also carries the label and the context window, so the
// match failed on every row that had either. That is the picker with the most to
// say: the dot vanished exactly there, and the cursor stopped skipping the row in
// effect, so Enter landed on the model already in use and answered "already on …"
// — the no-op the skip exists to avoid.
func TestTheModelPickerMarksTheModelInEffect(t *testing.T) {
	withColour(t)

	m := filledModel(120, 40)
	m.railHidden = true
	m.panel.model = "deepseek/deepseek-flash"
	m.modelCatalog = []any{
		map[string]any{"provider": "deepseek", "id": "deepseek-flash", "label": "DeepSeek Flash",
			"window": float64(1000000), "summary": "fast, cheap"},
		map[string]any{"provider": "deepseek", "id": "deepseek-v4-pro", "label": "DeepSeek V4 Pro",
			"window": float64(1000000)},
		map[string]any{"provider": "gateway", "id": "deepseek-flash", "label": "Flash (self-hosted)"},
	}

	options := m.modelOptions()
	current := -1
	for index, opt := range options {
		if !opt.current {
			continue
		}
		if current >= 0 {
			t.Fatalf("rows %d and %d both claim to be in effect", current, index)
		}
		current = index
	}
	if current != 0 {
		t.Fatalf("the row in effect is row %d, want 0 (deepseek/deepseek-flash)", current)
	}

	m.openOptionPicker(i18n.T("model.pick.title"), options, pickerStartNext)
	if m.overlay.cursor != 1 {
		t.Errorf("the cursor opens on row %d, want 1 — the row after the one in effect",
			m.overlay.cursor)
	}

	rendered := stripANSI(m.renderOverlay(112))
	if !strings.Contains(rendered, "●") {
		t.Fatalf("no row carries the dot:\n%s", rendered)
	}
	for _, line := range strings.Split(rendered, "\n") {
		if strings.Contains(line, "deepseek/deepseek-flash  fast, cheap") &&
			!strings.Contains(line, "●") {
			t.Errorf("the row in effect is drawn without the dot: %q", line)
		}
	}
}

// TestAPickersNoteCarriesNoCurrentMarker — the note is display text only.
//
// A row that spells "(current)" in its note is a row whose dot breaks again the
// next time somebody adds a field to that note; the theme picker did exactly that
// by prefixing the palette's source, which is why its dot never appeared either.
func TestAPickersNoteCarriesNoCurrentMarker(t *testing.T) {
	setTheme(defaultTheme)
	t.Cleanup(func() { setTheme(defaultTheme) })

	m := filledModel(120, 40)
	m.effortLevels = []string{"low", "high"}
	m.panel.effort = "high"

	for name, options := range map[string][]option{
		"theme":  pickerThemeOptions(),
		"effort": m.effortOptions(),
	} {
		marked := 0
		for _, opt := range options {
			if strings.Contains(opt.note, "(current)") {
				t.Errorf("%s: the note carries the marker as text: %q", name, opt.note)
			}
			if opt.current {
				marked++
			}
		}
		if marked != 1 {
			t.Errorf("%s: %d rows claim to be in effect, want exactly 1", name, marked)
		}
	}
}

// TestEnterOnAModelRowClosesThePicker — the model list is a "pick one and it goes
// away" control, not something that stands there afterwards.
//
// It used to stay up for the whole round trip: first "waiting for the runtime to
// apply X…", then the runtime's own sentence drawn under the list. That sentence
// is appended to the log as well, so the panel was covering the one line that
// answers "did it switch" with a copy of itself, and the keyboard only came back
// after Esc — which is the whole of the complaint.
func TestEnterOnAModelRowClosesThePicker(t *testing.T) {
	withColour(t)

	m := filledModel(120, 40)
	m.railHidden = true
	// nil stdin: `SetModel` writes nowhere, which is all a front-end test needs.
	// What the runtime does with the name is `internal/runtime`'s business.
	m.client = protocol.NewClient(nil)
	m.panel.model = "deepseek/deepseek-flash"
	m.modelCatalog = []any{
		map[string]any{"provider": "deepseek", "id": "deepseek-flash"},
		map[string]any{"provider": "deepseek", "id": "deepseek-v4-pro"},
	}

	m.openOptionPicker(i18n.T("model.pick.title"), m.modelOptions(), pickerStartNext)
	if m.overlay.kind != overlayOptions {
		t.Fatalf("the picker did not open: kind = %v", m.overlay.kind)
	}
	if chosen := m.overlay.options[m.overlay.cursor].value; chosen != "deepseek/deepseek-v4-pro" {
		t.Fatalf("the cursor is on %q, want the row after the one in effect", chosen)
	}

	next, _ := m.handleOverlayKey(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(model)

	if m.overlay.kind != overlayNone || m.overlay.waiting != "" {
		t.Errorf("the picker survived Enter: kind = %v, cursor = %d, waiting = %q",
			m.overlay.kind, m.overlay.cursor, m.overlay.waiting)
	}
	if rendered := stripANSI(m.renderOverlay(112)); rendered != "" {
		t.Errorf("a closed overlay still draws:\n%s", rendered)
	}
}

// TestAModelNoticeDoesNotSettleAnotherPicker — the notice belongs to the panel
// that asked for it, and `/model` is not that panel any more.
//
// `settleOverlay` matched on the notice's code alone, so a model notice arriving
// while a *theme* picker was open was written under the colour list as a warning
// line: a fact about the model, under a list of palettes. With `/model` closing
// on Enter there is no panel left for a model notice to settle at all, and the
// title — not the kind — is what says so.
func TestAModelNoticeDoesNotSettleAnotherPicker(t *testing.T) {
	withColour(t)
	setTheme(defaultTheme)
	t.Cleanup(func() { setTheme(defaultTheme) })

	m := filledModel(120, 40)
	m.openOptionPicker(i18n.T("theme.pick.title"), pickerThemeOptions(), pickerStartCurrent)

	m.settleOverlay("model", "Switched to deepseek/deepseek-v4-pro (previous: deepseek/deepseek-flash)")

	if m.overlay.waiting != "" {
		t.Errorf("a model notice was written into the theme picker: %q", m.overlay.waiting)
	}
	if rendered := stripANSI(m.renderOverlay(112)); strings.Contains(rendered, "Switched to") {
		t.Errorf("the theme picker is drawing a sentence about the model:\n%s", rendered)
	}
}

// TestAnEffortNoticeStillSettlesTheEffortPicker — the other half of the rule, and
// the reason the title check is safe to add: the panel that *does* stay open still
// takes its own answer.
func TestAnEffortNoticeStillSettlesTheEffortPicker(t *testing.T) {
	withColour(t)

	m := filledModel(120, 40)
	m.effortLevels = []string{"low", "high"}
	m.panel.effort = "low"
	m.openOptionPicker(i18n.T("effort.pick.title"), m.effortOptions(), pickerStartCurrent)

	const notice = "Effort is now high."
	m.settleOverlay("effort", notice)

	if m.overlay.waiting != notice {
		t.Fatalf("the effort picker did not take its own notice: %q", m.overlay.waiting)
	}
}
