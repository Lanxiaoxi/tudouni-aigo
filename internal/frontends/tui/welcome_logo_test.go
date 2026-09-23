package tui

import (
	"strings"
	"testing"

	"github.com/mattn/go-runewidth"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// TestTheMarkIsOneWidthAndOneAlphabet is the invariant that made the empty
// state's mark blocks in the first place, and the one a redrawing is most likely
// to spend: **half- and full-block characters only**, so no character can go
// double-width under a CJK font and shove the mark — or the box's right border —
// sideways, and **every line the same width**, because the rows are centred one
// at a time and a short row leans against the greeting under it.
//
// It measures with the same function the centring does, which is the point: this
// pins the arithmetic the layout uses, not what one particular terminal does with
// an ambiguous-width block.
func TestTheMarkIsOneWidthAndOneAlphabet(t *testing.T) {
	withColour(t)
	if len(welcomeLogo) == 0 {
		t.Fatal("the empty state has no mark")
	}
	want := runewidth.StringWidth(welcomeLogo[0])
	if want == 0 {
		t.Fatal("the mark's first row is empty")
	}
	for index, row := range welcomeLogo {
		if got := runewidth.StringWidth(row); got != want {
			t.Errorf("mark row %d is %d cells, row 0 is %d: %q", index, got, want, row)
		}
		for _, char := range row {
			if !strings.ContainsRune(" ▄▀█", char) {
				t.Errorf("mark row %d contains %q; half- and full-block characters only", index, char)
			}
		}
	}
	if inner := welcomeStartWidth - 4 - 2; want > inner {
		t.Errorf("the mark is %d cells, the start box has %d inside its padding", want, inner)
	}
}

// TestTheFullCardStillHoldsEverything is what the mark's extra line costs, and
// what it may not cost.
//
// `welcomeBoxLines` is a budget, and the trimming rule is that the tail — "where
// to type" — goes before the identity does. At the full height nothing is
// trimmed at all, so the whole mark, the greeting and the palette row are all
// there; the mark was four lines tall and the box was eleven the day the drawing
// changed, and this is the test that fails if one moves without the other.
func TestTheFullCardStillHoldsEverything(t *testing.T) {
	withColour(t)
	setTheme(defaultTheme)
	m := emptyModel(120, 40)
	rows := m.startRows(welcomeBoxLines)
	if len(rows) != welcomeBoxLines {
		t.Fatalf("the identity panel is %d rows at its full height, want %d",
			len(rows), welcomeBoxLines)
	}
	card := stripANSI(strings.Join(rows, "\n"))
	for _, row := range welcomeLogo {
		if mark := strings.TrimSpace(row); !strings.Contains(card, mark) {
			t.Errorf("the full card is missing a line of the mark: %q\n%s", mark, card)
		}
	}
	if greeting := i18n.T("welcome.back", "name", userName()); !strings.Contains(card, greeting) {
		t.Errorf("the full card is missing the greeting: %q\n%s", greeting, card)
	}
	if hint := i18n.T("welcome.palette_hint"); !strings.Contains(card, hint) {
		t.Errorf("the full card is missing the palette row: %q\n%s", hint, card)
	}
}
