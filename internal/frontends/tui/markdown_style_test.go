package tui

// Tests for what the answer's styling is allowed to draw with.
//
// The rule they enforce is one sentence long: **everything inside a rendered
// answer comes from the theme, at the colour depth the terminal was detected at.**
// It is easy to state and easy to break, because glamour's base styles are a
// starting point rather than a stylesheet — every field a style builder leaves
// alone keeps glamour's own colour instead of the theme's — and because glamour's
// syntax highlighter installs its palette in a process-wide registry. Both
// failures are invisible in a screenshot, and both are what these tests exist to
// catch.

import (
	"fmt"
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// markdownForeignFixture exercises every element that draws with a colour:
// headings (which used to arrive with a background of their own), prose with
// emphasis, inline and fenced code (syntax highlighting), a quote, lists, a task
// list, a table, a definition list, a rule, a link and an image.
const markdownForeignFixture = "# H1 标题\n\n" +
	"## H2 标题\n\n" +
	"正文里有 *强调*、**加粗**、~~删除线~~ 和 `行内代码`，还有 [链接](https://example.com)。\n\n" +
	"> 引用的一段话\n\n" +
	"- 第一项\n" +
	"  - 嵌套项\n" +
	"- [x] 已完成\n\n" +
	"| 列一 | 列二 |\n|---|---|\n| 一 | 二 |\n\n" +
	"术语\n: 定义\n\n" +
	"---\n\n" +
	"![说明](https://example.com/a.png)\n\n" +
	"```go\nfunc main() {\n\tprintln(\"hello\")\n}\n```\n"

// colourCodes lists the colours in rendered rows, one per sequence: a 24-bit
// triple ("38;2;r;g;b") or an indexed colour ("38;5;n"), foreground or
// background. One SGR sequence routinely carries several of them — a foreground
// and a background arrive in the same escape — so the parameter list is walked
// rather than taken whole. Attributes (bold, italic, reset) are not colours.
func colourCodes(rows []string) []string {
	var out []string
	for _, row := range rows {
		for _, match := range sgrPattern.FindAllStringSubmatch(row, -1) {
			params := strings.Split(match[1], ";")
			for index := 0; index < len(params); index++ {
				if params[index] != "38" && params[index] != "48" {
					continue
				}
				if index+1 >= len(params) {
					break
				}
				switch params[index+1] {
				case "2":
					if index+4 < len(params) {
						out = append(out, strings.Join(params[index:index+5], ";"))
						index += 4
					}
				case "5":
					if index+2 < len(params) {
						out = append(out, strings.Join(params[index:index+3], ";"))
						index += 2
					}
				}
			}
		}
	}
	return out
}

// paletteRoles lists every colour a theme names. A transparent role ("do not
// paint") is not a colour and cannot be written as one, so it is skipped
// wherever it turns up.
func paletteRoles(t theme) []string {
	return []string{
		t.bg, t.chrome, t.surface, t.line, t.ink, t.ink2, t.ink3,
		t.accent, t.warn, t.danger, t.ok, t.rail, t.elevated, t.sunk,
		t.hairline, t.ink4, t.accentSoft, t.dangerSoft, t.skill, t.railBar,
	}
}

// paletteColours is the palette as a rendered answer writes it, keyed on the
// "2;r;g;b" a 24-bit sequence carries after its 38/48.
//
// **Two spellings of every colour are accepted, and that is not laziness.**
// glamour writes a colour through termenv, which parses a hex string into its own
// float representation and serialises it back — a round trip that can move a
// channel by one (`#847968` comes out as 131;121;104). The syntax highlighter
// writes the bytes it parsed. Both are the theme's colour; a set built from raw
// hex bytes alone would report the theme's own blockquote as foreign.
func paletteColours(t theme, profile termenv.Profile) map[string]bool {
	out := map[string]bool{}
	for _, hex := range paletteRoles(t) {
		if parts, err := parseHex(hex); err == nil {
			out[fmt.Sprintf("2;%d;%d;%d", parts[0], parts[1], parts[2])] = true
		}
		if !strings.HasPrefix(hex, "#") {
			continue
		}
		rendered := termenv.String("x").Foreground(profile.Color(hex)).String()
		if codes := colourCodes([]string{rendered}); len(codes) == 1 {
			out[strings.TrimPrefix(codes[0], "38;")] = true
		}
	}
	return out
}

// exactTriple is a palette colour as the syntax highlighter writes it: the bytes
// of the hex string, with no round trip in between.
func exactTriple(t *testing.T, hex string) string {
	t.Helper()
	parts, err := parseHex(hex)
	if err != nil {
		t.Fatalf("%s is not a colour: %v", hex, err)
	}
	return fmt.Sprintf("38;2;%d;%d;%d", parts[0], parts[1], parts[2])
}

// TestNoForeignColourReachesTheAnswer is the whole rule in one assertion: every
// colour in a rendered answer is one the palette names, and none of them is an
// indexed colour.
//
// It fails on the defects this pass fixed, and each of them was real: glamour
// paints a level-1 heading on a blue slab (an indexed `48;5;63` no theme had ever
// heard of), the syntax highlighter brought its own palette, and image links came
// out in glamour's pink.
func TestNoForeignColourReachesTheAnswer(t *testing.T) {
	withColour(t)
	restore := currentTheme
	t.Cleanup(func() { currentTheme = restore })
	resetMarkdownResults()

	rows := renderMarkdown(markdownForeignFixture, 97)
	allowed := paletteColours(currentTheme, markdownProfile())
	seen := map[string]bool{}
	for _, code := range colourCodes(rows) {
		params := strings.Split(code, ";")
		if params[1] == "5" {
			t.Errorf("an indexed colour escaped the palette: %q", code)
			continue
		}
		normalised := strings.Join(params[1:], ";")
		if !allowed[normalised] {
			t.Errorf("the answer drew with rgb(%s), which is not in the %s palette",
				strings.ReplaceAll(normalised[2:], ";", " "), currentTheme.key)
			continue
		}
		seen[normalised] = true
	}
	// A render that lost its colour entirely would pass the check above.
	if len(seen) < 4 {
		t.Fatalf("the answer used %d distinct colours; the fixture is meant to draw with more", len(seen))
	}
}

// TestHeadingsHaveNoSlabOfTheirOwn pins the specific leak: both of glamour's base
// styles give h1 a background, and clearing the heading's prefix is not clearing
// the slab — a document with a `#` title drew one amber-on-blue band.
func TestHeadingsHaveNoSlabOfTheirOwn(t *testing.T) {
	withColour(t)
	restore := currentTheme
	t.Cleanup(func() { currentTheme = restore })
	resetMarkdownResults()

	var checked bool
	for _, row := range renderMarkdown("# 一级标题\n\n正文\n", 97) {
		if !strings.Contains(stripANSI(row), "一级标题") {
			continue
		}
		checked = true
		for _, code := range colourCodes([]string{row}) {
			if strings.HasPrefix(code, "48;") {
				t.Fatalf("the level-1 heading carries a background %q: %q", code, stripANSI(row))
			}
		}
	}
	if !checked {
		t.Fatal("the heading is not in the rendered rows")
	}
}

// TestCodeBlockFollowsTheTheme is the regression for a bug no screenshot would
// show: glamour registers its chroma palette under a fixed name and only when
// that name is free, so the first theme to draw a code block owned the syntax
// colours for the rest of the session and `/theme` repainted everything except
// the inside of a fenced block.
//
// The assertion is a colour the theme owns: the keyword token is the palette's
// accent, so each theme's render has to carry its own accent and not the other's.
func TestCodeBlockFollowsTheTheme(t *testing.T) {
	withColour(t)
	restore := currentTheme
	t.Cleanup(func() { currentTheme = restore })
	resetMarkdownResults()

	const document = "```go\nfunc main() {\n\treturn 1\n}\n```\n"

	setTheme(themeDeepClear)
	dark := strings.Join(renderMarkdown(document, 97), "\n")
	setTheme(themePinkViolet)
	light := strings.Join(renderMarkdown(document, 97), "\n")

	darkAccent := exactTriple(t, themes[themeDeepClear].accent)
	lightAccent := exactTriple(t, themes[themePinkViolet].accent)
	if !strings.Contains(dark, darkAccent) {
		t.Errorf("the code block under %s draws no accent (%s)", themeDeepClear, darkAccent)
	}
	if !strings.Contains(light, lightAccent) {
		t.Errorf("the code block under %s draws no accent (%s) — the highlighter is "+
			"still using the palette of whichever theme rendered first",
			themePinkViolet, lightAccent)
	}
	if dark == light {
		t.Fatal("two palettes produced the same code block")
	}
}

// TestCodeBlockIsOnTheSunkenSurface: the fenced block is the third thing on
// screen that means "quoted material", and it was the only one not drawn on the
// sunken surface. Once highlighting is on the text is written by the highlighter,
// so the block's own background never reached it.
func TestCodeBlockIsOnTheSunkenSurface(t *testing.T) {
	withColour(t)
	restore := currentTheme
	t.Cleanup(func() { currentTheme = restore })
	resetMarkdownResults()

	sunk := "48;" + strings.TrimPrefix(exactTriple(t, currentTheme.sunk), "38;")
	found := false
	for _, code := range colourCodes(renderMarkdown("```go\nvar x = 1\n```\n", 97)) {
		if !strings.HasPrefix(code, "48;") {
			continue
		}
		if code != sunk {
			t.Fatalf("the code block is drawn on %q; the sunken surface is %s", code, sunk)
		}
		found = true
	}
	if !found {
		t.Fatal("the code block has no surface of its own")
	}
}

// TestMarkdownFollowsTheColourProfile: the answer is drawn at the depth the
// terminal was detected at, like every other line on the screen.
//
// glamour defaults to true colour outright, so an answer used to emit 24-bit
// escapes into a terminal the chrome had already decided was plain — the one part
// of the screen that ignored `NO_COLOR`. The second half is the cache: a row
// drawn for a 24-bit terminal is not the row a plain one should be given, so the
// depth has to be part of the renderer identity.
func TestMarkdownFollowsTheColourProfile(t *testing.T) {
	restore := currentTheme
	t.Cleanup(func() { currentTheme = restore })
	previous := lipgloss.ColorProfile()
	t.Cleanup(func() { lipgloss.SetColorProfile(previous) })
	setTheme(defaultTheme)
	resetMarkdownResults()

	const document = "正文 *强调*\n\n```go\nvar x = 1\n```\n"

	lipgloss.SetColorProfile(termenv.Ascii)
	plainRows := renderMarkdown(document, 97)
	if codes := colourCodes(plainRows); len(codes) != 0 {
		t.Fatalf("a colourless terminal still got %d colour sequences: %v", len(codes), codes)
	}
	plain := strings.Join(plainRows, "\n")

	lipgloss.SetColorProfile(termenv.TrueColor)
	colouredRows := renderMarkdown(document, 97)
	coloured := strings.Join(colouredRows, "\n")
	if !strings.Contains(coloured, "\x1b[38;2;") {
		t.Fatalf("a true-colour terminal got no colour:\n%q", coloured)
	}
	// The same document, the same width: the depth changes the colours and
	// nothing else.
	if stripANSI(coloured) != stripANSI(plain) {
		t.Fatal("the colour depth changed the layout of the answer, not only its colours")
	}

	// Switching back must be a cache hit rather than a re-render — which is what
	// proves the depth reached the key instead of merely the renderer.
	before := markdownUncachedRenders
	lipgloss.SetColorProfile(termenv.Ascii)
	again := strings.Join(renderMarkdown(document, 97), "\n")
	if again != plain {
		t.Fatal("the plain render changed after a true-colour render")
	}
	if markdownUncachedRenders != before {
		t.Fatalf("switching the colour depth re-rendered the answer %d times",
			markdownUncachedRenders-before)
	}
}

// TestTableRulesAreTheInterfaceGlyphs: the table's rules are pinned to the glyphs
// the frame and the rail draw with. Left unset, glamour falls back to lipgloss's
// own default border — a character choice made outside the theme — which is how
// the table ended up as the one framed thing on screen with rules of its own.
//
// The config is what is asserted, because the glyphs happen to match lipgloss's
// default: a rendered row cannot tell the two apart, and pinning the choice is
// exactly what the rendered row cannot show.
func TestTableRulesAreTheInterfaceGlyphs(t *testing.T) {
	style := markdownStyle(themes[defaultTheme], "")
	for _, glyph := range []struct {
		name  string
		value *string
		want  string
	}{
		{"row separator", style.Table.RowSeparator, tableRule},
		{"column separator", style.Table.ColumnSeparator, tableBar},
		{"centre separator", style.Table.CenterSeparator, tableCross},
	} {
		if glyph.value == nil {
			t.Errorf("the table's %s is left to glamour's default", glyph.name)
			continue
		}
		if *glyph.value != glyph.want {
			t.Errorf("the table's %s is %q, want %q", glyph.name, *glyph.value, glyph.want)
		}
	}

	// And the rules do reach the screen.
	for _, row := range renderMarkdown("| 列一 | 列二 |\n|---|---|\n| 一 | 二 |\n", 97) {
		if strings.Contains(stripANSI(row), tableRule+tableCross) {
			return
		}
	}
	t.Fatal("the table drew no rule")
}
