package tui

import (
	"regexp"
	"strings"
	"testing"
)

var sgrPattern = regexp.MustCompile(`\x1b\[([0-9;]*)m`)

// backgroundOf reports the last background a row sets. Every styled fragment ends
// with a reset, so the row's colour is the last `48;2;` it emitted.
func backgroundOf(line string) string {
	last := ""
	for _, match := range sgrPattern.FindAllStringSubmatch(line, -1) {
		params := match[1]
		if index := strings.Index(params, "48;2;"); index >= 0 {
			last = params[index:]
		}
	}
	return last
}

// TestTheApprovalPanelIsPaintedOnOneSurface is the regression test for a panel that
// looked wrong on a real terminal.
//
// `elevated` (the card) and `sunk` (the argument block) are **derived** roles, so
// they stay opaque even when the theme is transparent — while the card's own
// background was the "do not paint" sentinel. The result was three surfaces in one
// rectangle: a terminal-coloured body, one lighter row and one darker row. On screen
// that reads as a patchwork, and the light/dark bands stop meaning anything because
// there is nothing for them to be lighter or darker *than*.
//
// The measurement is the escape sequences rather than a screenshot: a screenshot has
// antialiased text and a scaled cell grid, and "which colour did the program emit for
// this row" is the question.
func TestTheApprovalPanelIsPaintedOnOneSurface(t *testing.T) {
	withColour(t)
	restore := currentTheme
	t.Cleanup(func() { currentTheme = restore })

	for _, key := range themeOrder {
		setTheme(key)

		m := filledModel(120, 40)
		m.pendingPermission = map[string]any{
			"id": "p1", "tool": "shell", "risk": "high",
			"arguments":       map[string]any{"command": "pwd"},
			"remember_hint":   "commands starting with pwd will run directly",
			"allow_trust_all": false,
		}
		block := m.renderPermissionDialog()

		// How many rows are painted at all, and on how many distinct colours. The
		// card is whichever colour the most rows use; what matters is that almost
		// every row uses it, rather than the body being left to the terminal.
		counts := map[string]int{}
		for _, line := range strings.Split(block, "\n") {
			if background := backgroundOf(line); background != "" {
				counts[background]++
			}
		}
		dominant := 0
		for _, count := range counts {
			if count > dominant {
				dominant = count
			}
		}
		if dominant < 8 {
			t.Errorf("theme %s: only %d rows share one surface — the panel is transparent while its contents are not: %v",
				key, dominant, counts)
		}
		// Exactly one other surface is expected: the risk badge. A second one means a
		// row is painted on something the card does not use.
		if len(counts) > 2 {
			t.Errorf("theme %s: the panel uses %d surfaces: %v", key, len(counts), counts)
		}
		if colour := panelBackground(); colour == "" || colour == ansiDefault {
			t.Errorf("theme %s: the card background is the do-not-paint sentinel (%q)", key, colour)
		}
	}
}

// TestThePermissionCardIsNotTransparent pins the decision in `panelBackground`: the
// modal is opaque under every theme, including the deep clear variant.
//
// A modal is the one surface with other surfaces on top of it. Handing its background
// to the terminal makes the raised card and the sunken argument block meaningless —
// they are then lighter and darker than nothing.
func TestThePermissionCardIsNotTransparent(t *testing.T) {
	withColour(t)
	restore := currentTheme
	t.Cleanup(func() { currentTheme = restore })

	for _, key := range themeOrder {
		setTheme(key)
		if colour := panelBackground(); colour == "" || colour == ansiDefault {
			t.Errorf("theme %s: the card background is the do-not-paint sentinel (%q)", key, colour)
		}
	}
}

// TestTheArgumentBlockIsWiderThanItsText checks the argument block spans the panel's
// inner width.
//
// A block that stops at the end of its text reads as an unfinished rectangle, and
// the cells after it fall back to whatever is underneath — which is a different
// colour from the card. That is the "dark band stops halfway" shape.
func TestTheArgumentBlockIsWiderThanItsText(t *testing.T) {
	withColour(t)
	m := filledModel(120, 40)
	m.pendingPermission = map[string]any{
		"id": "p1", "tool": "shell", "risk": "high",
		"arguments": map[string]any{"command": "pwd"},
	}
	block := m.renderPermissionDialog()

	var line string
	for _, candidate := range strings.Split(block, "\n") {
		if strings.Contains(stripANSI(candidate), "pwd") {
			line = candidate
			break
		}
	}
	if line == "" {
		t.Fatal("the argument row is not in the panel")
	}
	if visible := len([]rune(stripANSI(line))); visible < 60 {
		t.Errorf("the argument row is %d cells wide; it should fill the card: %q",
			visible, stripANSI(line))
	}
}

// escapeBackground renders a hex colour the way lipgloss writes it.
func escapeBackground(hex string) string {
	if len(hex) != 7 || hex[0] != '#' {
		return ""
	}
	value := func(index int) int {
		digit := func(char byte) int {
			switch {
			case char >= '0' && char <= '9':
				return int(char - '0')
			case char >= 'A' && char <= 'F':
				return int(char-'A') + 10
			case char >= 'a' && char <= 'f':
				return int(char-'a') + 10
			}
			return 0
		}
		return digit(hex[index])*16 + digit(hex[index+1])
	}
	return "48;2;" + itoa(value(1)) + ";" + itoa(value(3)) + ";" + itoa(value(5))
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}
