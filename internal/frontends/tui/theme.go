package tui

import (
	"fmt"
	"math"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// The palette layer: **three themes, pure data**.
//
// The original had thirteen; the ones kept here are the three that were actually
// named: `A` (the default the user picked), `A-T2` (the deep clear variant the
// user asked for on top of it) and `P3` (the only light palette). The rest were
// never settled on, and a palette nobody looks at is a liability — nine hand-
// written hex values each.
//
// A theme is nine tokens plus nine derived roles. The tokens come from a card and
// are copied **byte for byte**; the roles are computed, because writing them out
// would be three×eight numbers nobody has verified, and every theme would start to
// drift in its own direction. The rules (identical for every theme):
//
//  1. lighten (rail / elevated): blend toward the ink — a dark theme gets lighter,
//     a light theme darker; the direction comes from `dark`;
//  2. darken (sunk): blend toward the far endpoint — the "sunken" bottom of the
//     thinking block;
//  3. soften (hairline / ink4 / accent_soft / danger_soft / skill): blend toward
//     the background — keep the hue, drop the contrast.

// themeKey identifies a theme in the config and in `/theme`.
type themeKey string

const (
	themeAmber      themeKey = "A"    // 石墨琥珀, the default
	themeDeepClear  themeKey = "A-T2" // 石墨琥珀 · 深透明
	themePinkViolet themeKey = "P3"   // 粉紫, the only light one
)

const defaultTheme = themeAmber

// ansiDefault is not a colour — it is "do not paint". The terminal's own
// background shows through wherever it is used. Bubble Tea has no special value
// for this the way Textual does (`ansi=-1`); the equivalent is simply not setting
// a background, which is what the renderer does when it sees this sentinel.
const ansiDefault = "ansi_default"

// palette is the raw card: nine tokens, unmodified.
type palette struct {
	key     themeKey
	name    string // 中文（长在主题上的数据，不走 i18n）
	nameEn  string
	source  string
	dark    bool
	bg      string
	chrome  string
	surface string
	line    string
	ink     string
	ink2    string
	ink3    string
	accent  string
	warn    string
	danger  string
	ok      string

	// clear roles lists the roles **besides bg** that are handed to the terminal.
	// The deep clear variant paints neither the bars nor the welcome boxes; the
	// frame lines and text keep their theme colours — transparency is about the
	// surfaces, never about the strokes.
	clearRoles map[string]bool
}

// theme is a palette with the derived roles filled in.
type theme struct {
	palette

	rail       string
	elevated   string
	sunk       string
	hairline   string
	ink4       string
	accentSoft string
	dangerSoft string
	skill      string
	railBar    string
}

// blend linearly interpolates between two hex colours in RGB space.
//
// Not HSL: interpolating two near-neutral colours through HSL takes a detour
// around the colour wheel that shows up as an unexpected tint. RGB interpolation
// is predictable, and predictable is what a test can bite.
//
// The rounding is Python's `round()`, i.e. half to even. Truncation toward zero
// is *not* the same thing: for a negative delta it rounds up instead of down and
// lands one step lighter on every channel. That is invisible on screen and it
// makes the derived layer disagree with the palette it was derived from — which
// is exactly what a golden table is for.
func blend(base, toward string, amount float64) string {
	a, errA := parseHex(base)
	b, errB := parseHex(toward)
	if errA != nil || errB != nil {
		return base
	}
	mix := func(x, y int) int {
		return clampByte(int(math.RoundToEven(float64(x) + float64(y-x)*amount)))
	}
	return fmt.Sprintf("#%02X%02X%02X", mix(a[0], b[0]), mix(a[1], b[1]), mix(a[2], b[2]))
}

func parseHex(value string) ([3]int, error) {
	text := strings.TrimPrefix(value, "#")
	if len(text) != 6 {
		return [3]int{}, fmt.Errorf("not a hex colour: %s", value)
	}
	var out [3]int
	for i := 0; i < 3; i++ {
		if _, err := fmt.Sscanf(text[i*2:i*2+2], "%02X", &out[i]); err != nil {
			return [3]int{}, err
		}
	}
	return out, nil
}

func clampByte(value int) int {
	if value < 0 {
		return 0
	}
	if value > 255 {
		return 255
	}
	return value
}

// deriveTheme computes the nine derived roles.
//
// The blend base is the palette's **original** bg even for the transparent
// variant: `ansi_default` is not a colour and cannot take part in an
// interpolation, and the derived roles are supposed to follow the original theme
// anyway — the whole point of the clear variant is that only the listed surfaces
// change, while the rail and the thinking block stay put.
func deriveTheme(p palette) theme {
	base := p.bg
	if p.clearRoles["bg"] {
		base = originalBgOf(p)
	}
	down := "#000000"
	if !p.dark {
		down = "#FFFFFF"
	}
	return theme{
		palette:    p,
		rail:       blend(base, p.ink, 0.045),
		elevated:   blend(base, p.ink, 0.10),
		sunk:       blend(base, down, 0.35),
		hairline:   blend(base, p.ink, 0.14),
		ink4:       blend(base, p.ink, 0.30),
		accentSoft: blend(base, p.accent, 0.42),
		dangerSoft: blend(base, p.danger, 0.42),
		skill:      blend(p.line, p.ink, 0.20),
		railBar:    blend(p.line, base, 0.30),
	}
}

// originalBgOf recovers the real background behind a transparent variant.
func originalBgOf(p palette) string {
	if p.key == themeDeepClear {
		return "#131210" // A 的 bg，见 ambersPalette
	}
	return p.bg
}

var (
	ambersPalette = palette{
		key: themeAmber, name: "石墨琥珀", nameEn: "Graphite Amber",
		source: "F7-A · 默认", dark: true,
		bg: "#131210", chrome: "#1A1815", surface: "#221F18", line: "#342B24",
		ink: "#EDE6DA", ink2: "#AFA395", ink3: "#847968",
		accent: "#E0A83E", warn: "#E0703A", danger: "#C64A3E", ok: "#8AA63F",
	}
	deepClearPalette = palette{
		key: themeDeepClear, name: "石墨琥珀 · 深透明", nameEn: "Graphite Amber · Deep Clear",
		source: "F7-A · 默认 · 透明版②", dark: true,
		bg: ansiDefault, chrome: ansiDefault, surface: ansiDefault,
		line: "#342B24",
		ink:  "#EDE6DA", ink2: "#AFA395", ink3: "#847968",
		accent: "#E0A83E", warn: "#E0703A", danger: "#C64A3E", ok: "#8AA63F",
		clearRoles: map[string]bool{"bg": true, "chrome": true, "surface": true},
	}
	pinkVioletPalette = palette{
		key: themePinkViolet, name: "粉紫", nameEn: "Pink Violet",
		source: "色卡③ · 亮色主题", dark: false,
		bg: "#EAF2FE", chrome: "#E1E8F4", surface: "#D8DEEA", line: "#C5ABD3",
		ink: "#363044", ink2: "#7E7E8E", ink3: "#A9ACBB",
		accent: "#8E5E6E", warn: "#9582A1", danger: "#C0362E", ok: "#57956D",
	}
)

var themes = map[themeKey]theme{
	themeAmber:      deriveTheme(ambersPalette),
	themeDeepClear:  deriveTheme(deepClearPalette),
	themePinkViolet: deriveTheme(pinkVioletPalette),
}

var themeOrder = []themeKey{themeAmber, themeDeepClear, themePinkViolet}

// currentTheme is the active theme. One global, because lipgloss styles are
// built once per render and threading a theme through every render call would
// touch every line for no gain — the theme changes at most once per session.
var currentTheme = themes[defaultTheme]

func themeOf(key themeKey) theme {
	if value, ok := themes[key]; ok {
		return value
	}
	// A mistyped key must not keep the interface from starting; switching a
	// palette is decoration, and decoration that crashes is the worst trade.
	return themes[defaultTheme]
}

// setTheme switches the active palette and returns whether it existed.
func setTheme(key themeKey) bool {
	if _, ok := themes[key]; !ok {
		return false
	}
	currentTheme = themes[key]
	return true
}

// styleMark is the one-off colour for a status mark whose colour follows the
// phase instead of a fixed role.
func (t theme) styleMark(hex string) lipgloss.Style {
	return lipgloss.NewStyle().Foreground(lipgloss.Color(hex))
}

// resolveTheme maps what the user typed to a theme key.
//
// Three ways to name one: the key itself (`a-t2`, hyphens optional), an ordinal
// into the list, or a fragment of either name. Several matches resolve to the
// most precise one — the match that **starts with** the fragment wins, then the
// shorter name, then the display order just to keep it stable.
func resolveTheme(query string) (themeKey, bool) {
	text := strings.TrimSpace(query)
	if text == "" {
		return "", false
	}
	upper := strings.ToUpper(text)
	if _, ok := themes[themeKey(upper)]; ok {
		return themeKey(upper), true
	}
	squashed := strings.NewReplacer("-", "", "_", "").Replace(upper)
	for _, key := range themeOrder {
		if strings.NewReplacer("-", "", "_", "").Replace(string(key)) == squashed {
			return key, true
		}
	}
	if number, ok := parseNumber(text); ok && number >= 1 && number <= len(themeOrder) {
		return themeOrder[number-1], true
	}
	needle := strings.ToLower(text)
	type hit struct {
		key  themeKey
		name string
	}
	var hits []hit
	for _, key := range themeOrder {
		for _, name := range []string{themes[key].name, themes[key].nameEn} {
			if strings.Contains(strings.ToLower(name), needle) {
				hits = append(hits, hit{key, name})
			}
		}
	}
	if len(hits) == 0 {
		return "", false
	}
	best := hits[0]
	for _, candidate := range hits[1:] {
		better := false
		if strings.HasPrefix(strings.ToLower(candidate.name), needle) &&
			!strings.HasPrefix(strings.ToLower(best.name), needle) {
			better = true
		} else if strings.HasPrefix(strings.ToLower(candidate.name), needle) ==
			strings.HasPrefix(strings.ToLower(best.name), needle) &&
			len(candidate.name) < len(best.name) {
			better = true
		}
		if better {
			best = candidate
		}
	}
	return best.key, true
}

// themeListing is the one-line catalogue `/theme` prints.
func themeListing() string {
	parts := make([]string, 0, len(themeOrder))
	for index, key := range themeOrder {
		parts = append(parts, fmt.Sprintf("%d %s %s", index+1, key, themes[key].name))
	}
	return strings.Join(parts, " · ")
}
