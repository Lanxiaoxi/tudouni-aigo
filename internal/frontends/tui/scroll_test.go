package tui

import (
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/mattn/go-runewidth"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// ── the log's window ──────────────────────────────────────────────────────────
//
// Two complaints, one cause. The window used to be measured as "how many rows
// back from the bottom the log is drawn", so **anything that made the log
// taller** moved it: a streamed answer grew inside its entry, a report arrived as
// one multi-row entry, and the row the reader was on slid away each time. And
// while the empty state was up the position was ignored outright (`start := 0`),
// which made the init notices below the welcome card both off-screen and
// unreachable. These tests pin the behaviour that replaces both.

// historyModel is a conversation long enough to scroll: a turn already finished,
// then forty single-row lines.
func historyModel(width, height int) model {
	m := newModel(nil, nil, Options{})
	m.width, m.height = width, height
	m.booting = false
	m.turnSeq = 1
	m.transcript = append(m.transcript, entry{
		turn: &turnData{index: 0, runID: "r0", startedAt: time.Now()}})
	for index := 0; index < 40; index++ {
		m.appendLine(renderLine{segments: []seg{
			{text: fmt.Sprintf("history line %02d", index), role: "rule"},
		}}, "notice", "")
	}
	return m
}

// topRow is the first visible row of the log — the row a reader would name if
// asked where they are.
func topRow(m model) string {
	for _, row := range strings.Split(stripANSI(m.renderTranscript(m.width, m.bodyHeight())), "\n") {
		if text := strings.TrimSpace(row); text != "" {
			return text
		}
	}
	return ""
}

// historyIndex reads `history line NN` back out, so "moved up" can be asserted
// rather than "changed".
func historyIndex(t *testing.T, row string) int {
	t.Helper()
	value, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(row, "history line")))
	if err != nil {
		t.Fatalf("not a history row: %q", row)
	}
	return value
}

// scrollUp / scrollDown are the interface's own scroll gesture: the arrow keys,
// driven through Update rather than by calling the window directly, because "the
// key reaches the window" is half of what the empty state broke. Mouse reporting
// is off on purpose (see Run), so a terminal that turns a wheel notch into these
// keys is scrolling the log through exactly this path.
func scrollUp(m model) model {
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyUp})
	return next.(model)
}

func scrollDown(m model) model {
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyDown})
	return next.(model)
}

func scrollUpBy(m model, rows int) model {
	for step := 0; step < rows; step++ {
		m = scrollUp(m)
	}
	return m
}

func scrollDownBy(m model, rows int) model {
	for step := 0; step < rows; step++ {
		m = scrollDown(m)
	}
	return m
}

// TestTheLogHoldsStillWhileTheAnswerStreams is the reported bug: scrolling up
// while the model streamed dragged the text back down, one row per delta.
func TestTheLogHoldsStillWhileTheAnswerStreams(t *testing.T) {
	setTheme(defaultTheme)
	m := historyModel(100, 24)
	m.busy = true
	m.current = &turnData{index: 1, runID: "r1", startedAt: time.Now()}
	m.transcript = append(m.transcript, entry{turn: m.current})
	m.streamRunID, m.streamStep = "r1", 1
	m.streamedText = "first chunk"
	m.updateStreamingAnswer()

	topRow(m) // one frame, so the window knows where the bottom is
	m = scrollUp(m)
	before := topRow(m)
	if before == "" {
		t.Fatal("the fixture drew nothing to scroll to")
	}
	start := historyIndex(t, before)

	for delta := 0; delta < 40; delta++ {
		// A delta that only makes the block **taller**: this is the case that
		// used to shift the window, because the row count below it grew.
		m.streamedText += " more words that make this block longer"
		m.updateStreamingAnswer()
		if after := topRow(m); after != before {
			t.Fatalf("delta %d dragged the reader: %q → %q", delta, before, after)
		}
	}
	if got := historyIndex(t, topRow(m)); got != start {
		t.Fatalf("the window left row %d for %d while the answer streamed", start, got)
	}
}

// TestAMultiRowEntryDoesNotMoveTheReader is the same property for the other shape
// of growth: one entry that renders as many rows. The old compensation counted
// **entries**, so a six-row report moved the window by five.
func TestAMultiRowEntryDoesNotMoveTheReader(t *testing.T) {
	setTheme(defaultTheme)
	m := historyModel(100, 24)
	topRow(m)
	m = scrollUpBy(m, 6)
	before := topRow(m)

	var block []renderLine
	for index := 0; index < 6; index++ {
		block = append(block, renderLine{segments: []seg{
			{text: fmt.Sprintf("report row %d", index), role: "rule"},
		}})
	}
	m.appendLines(block)

	if after := topRow(m); after != before {
		t.Fatalf("a six-row entry moved the reader: %q → %q", before, after)
	}
}

// TestTheConversationOpensOnTheNewestRow — following the bottom is the default,
// and it is the only state in which growth may move the window.
func TestTheConversationOpensOnTheNewestRow(t *testing.T) {
	setTheme(defaultTheme)
	m := historyModel(100, 24)
	if body := stripANSI(m.renderTranscript(m.width, m.bodyHeight())); !strings.Contains(body, "history line 39") {
		t.Fatalf("the conversation did not open on its newest row:\n%s", body)
	}
	// And it keeps following while the reader has not taken the window over.
	m.appendLine(renderLine{segments: []seg{{text: "the newest line", role: "rule"}}}, "notice", "")
	if body := stripANSI(m.renderTranscript(m.width, m.bodyHeight())); !strings.Contains(body, "the newest line") {
		t.Fatal("a new line arrived and the window did not follow it")
	}
}

// TestScrollingDownReturnsToTheBottom — walking down past the newest row means
// "keep me here", which is what re-arms following.
func TestScrollingDownReturnsToTheBottom(t *testing.T) {
	setTheme(defaultTheme)
	m := historyModel(100, 24)
	topRow(m)
	m = scrollUpBy(m, 12)
	if topRow(m) == "history line 39" {
		t.Fatal("scrolling up did not leave the bottom")
	}
	m = scrollDownBy(m, 40)
	if body := stripANSI(m.renderTranscript(m.width, m.bodyHeight())); !strings.Contains(body, "history line 39") {
		t.Fatalf("scrolling down never returned to the bottom:\n%s", body)
	}
	m.appendLine(renderLine{segments: []seg{{text: "after the return", role: "rule"}}}, "notice", "")
	if body := stripANSI(m.renderTranscript(m.width, m.bodyHeight())); !strings.Contains(body, "after the return") {
		t.Fatal("following was not re-armed at the bottom")
	}
}

// TestScrollingUpPastTheTopStops — the position is a row index, so it cannot run
// off the top and leave the reader holding a key that does nothing visible.
func TestScrollingUpPastTheTopStops(t *testing.T) {
	setTheme(defaultTheme)
	m := historyModel(100, 24)
	topRow(m)
	m = scrollUpBy(m, 200)
	// The fixture opens with a turn, so the first row of the log is its header.
	if got := topRow(m); !strings.HasPrefix(got, "Turn 0") {
		t.Fatalf("the window did not stop at the top of the log: %q", got)
	}
	parked := topRow(m)
	m = scrollUp(m)
	if topRow(m) != parked {
		t.Fatal("scrolling up again moved a window that was already at the top")
	}
}

// TestScrollingLeavesTheCaretAlone — the arrow keys scroll the log only from the
// box's own edge; with text in the box they move the caret first, which is what
// keeps Up from being a dead key while typing.
func TestScrollingLeavesTheCaretAlone(t *testing.T) {
	setTheme(defaultTheme)
	m := historyModel(100, 24)
	m.input = "one\ntwo\nthree"
	m.inputCursor = len([]rune(m.input))
	topRow(m)
	parked := topRow(m)
	m = scrollUp(m)
	if got := topRow(m); got != parked {
		t.Fatalf("Up scrolled the log while the caret was not on the top row: %q → %q", parked, got)
	}
	if m.inputCursor == len([]rune(m.input)) {
		t.Fatal("Up did not move the caret inside the box")
	}
}

// ── the empty state ───────────────────────────────────────────────────────────

// emptyModel is a session that has not spoken yet: the cover page, and nothing
// else.
func emptyModel(width, height int) model {
	m := newModel(nil, nil, Options{})
	m.width, m.height = width, height
	m.booting = false
	return m
}

// TestTheEmptyStateOpensAtTheTop — the card is a cover page, so the window starts
// on its first row rather than on the newest notice.
func TestTheEmptyStateOpensAtTheTop(t *testing.T) {
	setTheme(defaultTheme)
	m := emptyModel(120, 40)
	if !m.welcomeVisible() {
		t.Fatal("a session that has not spoken must show the empty state")
	}
	if first := topRow(m); !strings.Contains(first, i18n.T("welcome.box.start")) {
		t.Fatalf("the empty state did not open on the card's top edge: %q", first)
	}
}

// TestTheEmptyStateFitsAndItsNoticesAreReachable is the first reported bug. The
// card is drawn inside the rows the body has — so it is not cut in half — and the
// init notices below it can be scrolled to, which is what `start := 0` made
// impossible.
func TestTheEmptyStateFitsAndItsNoticesAreReachable(t *testing.T) {
	setTheme(defaultTheme)
	m := emptyModel(120, 24)
	for index := 0; index < 10; index++ {
		m.appendLine(renderLine{segments: []seg{
			{text: fmt.Sprintf("init notice %d", index), role: "rule"},
		}}, "notice", "")
	}
	if !m.welcomeVisible() {
		t.Fatal("the empty state must still be up: no turn has run")
	}
	budget := m.bodyHeight() - 1 // the blank line under the card
	if card := m.renderWelcome(m.width-2, budget); len(card) > budget {
		t.Fatalf("the card draws %d rows into the %d it was given", len(card), budget)
	}
	if strings.Contains(stripANSI(m.View()), "init notice 9") {
		t.Fatal("this fixture is meant to need scrolling to reach the last notice")
	}

	m = scrollDownBy(m, 40)
	if screen := stripANSI(m.View()); !strings.Contains(screen, "init notice 9") {
		t.Fatalf("the init notices below the card are unreachable:\n%s", screen)
	}
	if first := topRow(m); strings.Contains(first, i18n.T("welcome.box.start")) {
		t.Fatal("scrolling down never left the top of the card")
	}
}

// TestTheEmptyStateGivesUpTheKeyCardFirst — what is dropped when the terminal is
// short is the block that repeats something else, not the card's own identity.
func TestTheEmptyStateGivesUpTheKeyCardFirst(t *testing.T) {
	setTheme(defaultTheme)
	short := emptyModel(120, 24)
	card := stripANSI(strings.Join(short.renderWelcome(short.width-2, short.bodyHeight()-1), "\n"))
	if !strings.Contains(card, i18n.T("welcome.box.start")) {
		t.Fatalf("the identity card must survive a short terminal:\n%s", card)
	}
	if strings.Contains(card, i18n.T("welcome.box.hint")) {
		t.Fatalf("the key card must be the first thing given up:\n%s", card)
	}
	if !strings.Contains(card, i18n.T("welcome.back", "name", userName())) {
		t.Fatalf("the greeting must not be trimmed away before the key card:\n%s", card)
	}

	tall := emptyModel(120, 40)
	full := stripANSI(strings.Join(tall.renderWelcome(tall.width-2, tall.bodyHeight()-1), "\n"))
	if !strings.Contains(full, i18n.T("welcome.box.hint")) {
		t.Fatalf("a terminal with room must still get the key card:\n%s", full)
	}
}

// TestTheEmptyStateNeverOverflowsTheTerminal is the invariant a fitted card must
// not trade away: whatever the size, and wherever the window has been scrolled,
// the frame is exactly as tall and as wide as the terminal. One row too many
// pushes the status bar and the input line off the bottom.
func TestTheEmptyStateNeverOverflowsTheTerminal(t *testing.T) {
	setTheme(defaultTheme)
	sizes := []struct{ width, height int }{
		{60, 12}, {70, 18}, {80, 24}, {90, 20}, {100, 30}, {120, 24}, {120, 36}, {200, 60},
	}
	for _, size := range sizes {
		m := emptyModel(size.width, size.height)
		for index := 0; index < 4; index++ {
			m.appendLine(renderLine{segments: []seg{
				{text: fmt.Sprintf("init notice %d", index), role: "rule"},
			}}, "notice", "")
		}
		for frame := 0; frame < 4; frame++ {
			lines := strings.Split(m.View(), "\n")
			if len(lines) > size.height {
				t.Errorf("%dx%d frame %d: %d rows drawn", size.width, size.height, frame, len(lines))
			}
			for index, line := range lines {
				if got := runewidth.StringWidth(stripANSI(line)); got > size.width {
					t.Errorf("%dx%d frame %d: row %d is %d cells: %q",
						size.width, size.height, frame, index, got, stripANSI(line))
				}
			}
			m = scrollDownBy(m, 8)
		}
	}
}
