package tui

import (
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
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
