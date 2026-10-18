// Package skills finds and parses the step-by-step instructions a workspace
// offers.
//
// It is a leaf: it reads the disk and answers questions about what it found. It
// does not know what a tool is, which way the dependency has to run — otherwise
// `skills → tools` plus `tools/builtin → skills` (to register the loader) is a
// cycle.
//
// A skill is a directory with a `SKILL.md` in it, and the file has a frontmatter
// block with a name and a description. The description is the only thing the model
// sees until it loads the skill, so it decides everything about whether the skill
// gets used.
package skills

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
)

const (
	// AgentsDirName and GenericDirName are directories other tools also read, so
	// skills placed there are picked up here too.
	AgentsDirName  = ".agents"
	GenericDirName = ".skills"
	// SkillsDirName is this program's own skill directory.
	SkillsDirName = "skills"
	// SkillFileName is the file every skill directory must contain.
	SkillFileName = "SKILL.md"
	// SkillsKey is the session-metadata key holding the loaded skills. Both sides
	// (reading to render, writing on load) use this one constant.
	SkillsKey = "skills"

	// MaxSkillBytes bounds the body. Over the limit the skill is refused with an
	// explanation rather than truncated: the body is spliced into **every**
	// request, so a 500 KB skill is not a big skill, it is a large recurring bill.
	MaxSkillBytes = 64_000

	// MaxActiveSkills bounds how many are in effect at once. Over the limit new
	// loads are refused rather than old ones displaced — see SkillBoard.Load.
	MaxActiveSkills = 3

	// MaxNoteChars is the last gate on the rendered note.
	MaxNoteChars = 40_000
)

var namePattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// knownFrontmatterKeys are the keys this parser understands. The last three are
// specification fields: recognised so they can be accepted rather than reported as
// unknown, and not used.
var knownFrontmatterKeys = []string{
	"name", "description", "allowed-tools",
	"license", "compatibility", "metadata",
}

// unsupportedInValue are characters that only make sense in a nested structure,
// which this parser does not have. `metadata` is exempt.
const unsupportedInValue = "#{}"

// Skill is one parsed skill.
type Skill struct {
	Name         string
	Description  string
	Path         string
	Body         string
	AllowedTools []string
	// Digest covers only the body. What goes into session metadata is "name plus
	// digest", never the body.
	Digest string
	// Locations is every directory holding this name, highest priority first.
	// Locations[0] is the one in effect.
	Locations []string
}

// Shadowed is the copies that lost to a higher-priority directory.
func (s Skill) Shadowed() []string {
	if len(s.Locations) < 2 {
		return nil
	}
	return s.Locations[1:]
}

// BodyChars is the body length.
func (s Skill) BodyChars() int { return len(s.Body) }

// Problem is a machine-recognisable code plus its parameters, not a finished
// sentence: rendering it is the consumer's job, in the consumer's language.
type Problem struct {
	Code   string
	Params [][2]any
}

// Catalog is what one scan found.
type Catalog struct {
	Skills   []Skill
	Problems []Problem
	// Roots are every directory that was **looked at**, lowest priority first. It
	// includes the ones that do not exist, because "where could I put a skill" is
	// answered by the directories that are not there yet.
	Roots []string
	// Existing is the subset of Roots that is actually on disk. It is what the
	// `✓` in `--skills` means, and without it that mark is a lie: every candidate
	// directory would appear to exist.
	Existing []string
	// Shadowed records names that lost to a higher-priority copy.
	Shadowed []Problem
}

// ByName finds a skill.
func (c Catalog) ByName(name string) (Skill, bool) {
	for _, skill := range c.Skills {
		if skill.Name == name {
			return skill, true
		}
	}
	return Skill{}, false
}

// Loader scans the skill directories.
type Loader struct {
	Roots []string
}

// NewLoader builds a loader over the default directories.
//
// **The paths are computed here and never come from the model.** The user-level
// directories sit outside the workspace, and `write_file` cannot reach them
// either — so "only a person can change a skill" is guaranteed by the operating
// system for that half.
func NewLoader() *Loader {
	return &Loader{Roots: defaultRoots()}
}

// defaultRoots lists the directories, **lowest priority first**. Later scans beat
// earlier ones, and the personal level beats the project level — the same logic as
// git config: the machine belongs to the person, the repository belongs to somebody
// else.
//
// The first two of each group are directories other tools also read, which is why
// they are not inside this program's own runtime directory.
func defaultRoots() []string {
	home := paths.HomeDir()
	workspace := paths.WorkspaceDir()

	return []string{
		filepath.Join(home, GenericDirName),
		filepath.Join(home, AgentsDirName, SkillsDirName),
		filepath.Join(home, paths.RuntimeDirName, SkillsDirName),

		filepath.Join(workspace, GenericDirName),
		filepath.Join(workspace, AgentsDirName, SkillsDirName),
		filepath.Join(workspace, paths.RuntimeDirName, SkillsDirName),
	}
}

// Reload rescans. It is called on every use rather than cached, because the
// directory listing is rendered into the payload every round: a model that can see
// a skill it cannot load is a self-contradictory state.
//
// Every failure is data, not an error: a malformed file lands in Problems and the
// scan carries on. Refusing to start because one skill file has a bad hyphen would
// make the whole feature hostage to its least important file.
func (l *Loader) Reload() Catalog {
	catalog := Catalog{Roots: l.Roots}

	byName := map[string]*Skill{}
	var order []string

	// Scanned **highest priority first** so that Locations[0] is the winner, while
	// Roots is reported lowest first.
	for index := len(l.Roots) - 1; index >= 0; index-- {
		root := l.Roots[index]
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		catalog.Existing = append(catalog.Existing, root)
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			if entry.IsDir() {
				names = append(names, entry.Name())
			}
		}
		sort.Strings(names)

		for _, name := range names {
			path, problem, ok := l.skillFile(root, name)
			if !ok {
				if problem != nil {
					catalog.Problems = append(catalog.Problems, Problem{
						Code: "skipped",
						Params: [][2]any{
							{"name", name},
							{"reason", *problem},
						},
					})
				}
				continue
			}

			skill, problem, ok := parseSkill(path, name)
			if !ok {
				catalog.Problems = append(catalog.Problems, Problem{
					Code: "skipped",
					Params: [][2]any{
						{"name", name},
						{"reason", *problem},
					},
				})
				continue
			}

			if existing, seen := byName[name]; seen {
				existing.Locations = append(existing.Locations, path)
				continue
			}
			copied := skill
			byName[name] = &copied
			order = append(order, name)
		}
	}

	sort.Strings(order)
	for _, name := range order {
		skill := *byName[name]
		catalog.Skills = append(catalog.Skills, skill)
		if len(skill.Locations) > 1 {
			catalog.Shadowed = append(catalog.Shadowed, Problem{
				Code: "shadowed",
				Params: [][2]any{
					{"name", name},
					{"winner", skill.Locations[0]},
					{"losers", strings.Join(skill.Locations[1:], "、")},
				},
			})
		}
	}
	// The scan walks highest-priority-first; the reported list is lowest-first, to
	// match Roots, which is the order a reader compares the two against.
	for left, right := 0, len(catalog.Existing)-1; left < right; left, right = left+1, right-1 {
		catalog.Existing[left], catalog.Existing[right] = catalog.Existing[right], catalog.Existing[left]
	}
	return catalog
}

// skillFile locates a skill's file inside one root.
//
// The symlink check is written out here rather than reusing the filesystem tools'
// path helper, to keep the dependency arrow pointing one way.
func (l *Loader) skillFile(root, name string) (string, *Problem, bool) {
	directory := filepath.Join(root, name)
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		resolvedRoot = root
	}
	resolved, err := filepath.EvalSymlinks(directory)
	if err != nil {
		// A directory that cannot be resolved is simply not there. A skill being
		// written right now is a normal intermediate state.
		return "", nil, false
	}
	if !strings.HasPrefix(resolved+string(filepath.Separator),
		strings.TrimRight(resolvedRoot, string(filepath.Separator))+string(filepath.Separator)) {
		problem := Problem{Code: "escape", Params: [][2]any{{"path", directory}}}
		return "", &problem, false
	}

	path := filepath.Join(directory, SkillFileName)
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return "", nil, false
	}
	return path, nil, true
}

// parseSkill reads and validates one file.
func parseSkill(path, directoryName string) (Skill, *Problem, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		problem := Problem{Code: "unreadable", Params: [][2]any{
			{"file", SkillFileName},
			{"problem", err.Error()},
		}}
		return Skill{}, &problem, false
	}
	// A BOM is tolerated: "save as UTF-8" on Windows writes one, and it turns the
	// first line into `\ufeff---`, so the frontmatter appears to be missing.
	text := strings.TrimPrefix(string(raw), "\uFEFF")
	// Windows line endings are tolerated too: split on `\n` alone would leave a
	// trailing `\r` on every line, and `---\r` is not a delimiter — the whole
	// frontmatter block silently disappears.
	text = strings.ReplaceAll(text, "\r\n", "\n")

	fields, body, problem := parseFrontmatter(text)
	if problem != nil {
		return Skill{}, problem, false
	}

	name := fields["name"]
	if name == "" {
		return Skill{}, &Problem{Code: "missing_name"}, false
	}
	if name != directoryName {
		// The two have to agree, or the name the model sees and the path it can
		// read point at different things.
		return Skill{}, &Problem{Code: "name_mismatch", Params: [][2]any{
			{"name", name}, {"directory", directoryName},
		}}, false
	}
	if !namePattern.MatchString(name) {
		return Skill{}, &Problem{Code: "bad_name", Params: [][2]any{{"name", name}}}, false
	}
	if len(name) > 64 {
		return Skill{}, &Problem{Code: "name_too_long", Params: [][2]any{{"length", len(name)}}}, false
	}
	description := fields["description"]
	if strings.TrimSpace(description) == "" {
		return Skill{}, &Problem{Code: "missing_description"}, false
	}
	if len(raw) > MaxSkillBytes {
		// Measured in bytes, and refused rather than truncated. A silent cut here
		// removes the last steps of a procedure, which the model then follows as
		// if they were the whole thing.
		return Skill{}, &Problem{Code: "too_big", Params: [][2]any{
			{"size", len(raw)}, {"limit", MaxSkillBytes},
		}}, false
	}

	return Skill{
		Name:         name,
		Description:  strings.TrimSpace(description),
		Path:         path,
		Body:         strings.TrimSpace(body),
		AllowedTools: splitTools(fields["allowed-tools"]),
		Digest:       digestOf(body),
		Locations:    []string{path},
	}, nil, true
}

// parseFrontmatter reads the block between the two `---` lines.
//
// It parses by hand rather than pulling in a YAML library: the project has no
// runtime dependencies to spare, and the block has a handful of keys. **Anything it
// does not understand becomes a problem rather than a guess** — mis-guessing a quote
// or an indent silently drops part of a skill's instructions, and the model then
// follows a procedure with a hole in it.
//
// The one thing it steps over instead of refusing is a key it does not know. A
// frontmatter field is metadata; the instructions are in the body, so stepping
// over a field cannot change what the model is told. Every skill written for
// another agent carries keys this program has no use for — Claude Code alone
// adds `argument-hint`, `model`, `context` and more — and refusing the file over
// one of them would make that whole catalogue unusable here for no gain.
func parseFrontmatter(text string) (map[string]string, string, *Problem) {
	lines := strings.Split(text, "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return nil, "", &Problem{Code: "no_frontmatter"}
	}

	end := -1
	for index := 1; index < len(lines); index++ {
		if strings.TrimSpace(lines[index]) == "---" {
			end = index
			break
		}
	}
	if end < 0 {
		return nil, "", &Problem{Code: "unclosed_frontmatter"}
	}

	fields := map[string]string{}
	inMetadata := false
	// inListKey is the key whose value is being built from YAML list items on
	// the following indented lines (e.g. `allowed-tools:` followed by
	// `  - shell`). Empty means no list is in progress.
	inListKey := ""
	// inIgnoredKey is the unknown key whose indented continuation is being
	// stepped over along with it. Empty means no key is being ignored.
	inIgnoredKey := ""

	for index := 1; index < end; index++ {
		raw := lines[index]
		if strings.TrimSpace(raw) == "" {
			continue
		}
		trimmed := strings.TrimSpace(raw)

		// Indentation is allowed under `metadata` (skipped without being
		// interpreted), under a key this parser does not know (skipped along
		// with the key), and as YAML list items under a key that had an empty
		// value (e.g. `allowed-tools:` followed by `  - shell`).
		if raw != trimmed {
			if inMetadata || inIgnoredKey != "" {
				continue
			}
			if inListKey != "" && strings.HasPrefix(trimmed, "- ") {
				item := strings.TrimSpace(strings.TrimPrefix(trimmed, "-"))
				if fields[inListKey] == "" {
					fields[inListKey] = item
				} else {
					fields[inListKey] += " " + item
				}
				continue
			}
			return nil, "", &Problem{Code: "indented", Params: [][2]any{{"line", trimmed}}}
		}
		inListKey = ""
		inMetadata = false
		inIgnoredKey = ""

		if strings.HasPrefix(trimmed, "- ") {
			return nil, "", &Problem{Code: "unparsable", Params: [][2]any{{"line", trimmed}}}
		}

		key, value, found := strings.Cut(trimmed, ":")
		if !found {
			return nil, "", &Problem{Code: "missing_key", Params: [][2]any{{"line", trimmed}}}
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key == "" {
			return nil, "", &Problem{Code: "missing_key", Params: [][2]any{{"line", trimmed}}}
		}

		if !contains(knownFrontmatterKeys, key) {
			// Stepped over rather than refused: the field is metadata, and one
			// that is stepped over cannot change the body, which is where the
			// instructions live.
			inIgnoredKey = key
			continue
		}
		if _, duplicate := fields[key]; duplicate {
			return nil, "", &Problem{Code: "duplicate_key", Params: [][2]any{{"key", key}}}
		}

		if key == "metadata" {
			// The one nested structure the specification defines. Recognised, then
			// stepped over.
			inMetadata = true
			inListKey = ""
			continue
		}

		// A block scalar (`key: |` or `key: >`) puts its value on the indented
		// lines below, which the one-line `key: value` shape cannot express.
		if style, chomp, isBlock := blockHeader(value); isBlock {
			block, last := readBlock(lines, index+1, end, style, chomp)
			fields[key] = block
			index = last
			continue
		}

		// A quoted value is how a `#` or a `{` is written without being read as
		// the start of a nested structure, so the character check below applies
		// to the value as written, and the quotes come off only afterwards.
		if quote, isQuoted := quoteStyle(value); isQuoted {
			value = unquote(value, quote)
		} else if key != "license" && key != "compatibility" {
			// Only licence and compatibility are read for their value; the rest
			// are carried as text.
			if chars := unsupportedChars(value); chars != "" {
				return nil, "", &Problem{Code: "bad_chars", Params: [][2]any{
					{"key", key}, {"chars", chars},
				}}
			}
		}
		if value == "" {
			// An empty value may introduce a YAML list on the following indented
			// lines (the standard multi-line form of `allowed-tools`). The items
			// are collected and joined into this field when they arrive.
			inListKey = key
		} else {
			fields[key] = value
		}
	}

	body := strings.Join(lines[end+1:], "\n")
	return fields, body, nil
}

// quoteStyle reports whether a value is a quoted YAML scalar, and which quote
// character delimits it.
//
// It checks the whole value rather than its first and last byte, because
// `"one" and "two"` starts and ends with a quote and is not one scalar: trimming
// there would hand the model half a sentence with a stray mark on it.
func quoteStyle(value string) (byte, bool) {
	if len(value) < 2 {
		return 0, false
	}
	quote := value[0]
	if quote != '"' && quote != '\'' {
		return 0, false
	}
	if value[len(value)-1] != quote {
		return 0, false
	}
	inner := value[1 : len(value)-1]
	for index := 0; index < len(inner); index++ {
		if quote == '"' && inner[index] == '\\' {
			index++ // the escaped character cannot close the scalar
			continue
		}
		if inner[index] == quote {
			if quote == '\'' && index+1 < len(inner) && inner[index+1] == '\'' {
				index++ // a doubled quote is an escaped quote
				continue
			}
			return 0, false
		}
	}
	return quote, true
}

// unquote removes the delimiters and the escaping YAML puts inside them. The two
// styles escape differently: a single-quoted scalar doubles the quote, a
// double-quoted one uses a backslash.
func unquote(value string, quote byte) string {
	inner := value[1 : len(value)-1]
	if quote == '\'' {
		return strings.ReplaceAll(inner, "''", "'")
	}
	var out strings.Builder
	out.Grow(len(inner))
	for index := 0; index < len(inner); index++ {
		if inner[index] != '\\' || index+1 >= len(inner) {
			out.WriteByte(inner[index])
			continue
		}
		index++
		switch inner[index] {
		case 'n':
			out.WriteByte('\n')
		case 't':
			out.WriteByte('\t')
		case 'r':
			out.WriteByte('\r')
		default:
			out.WriteByte(inner[index])
		}
	}
	return out.String()
}

// blockHeader recognises a block scalar header: `|` (literal) or `>` (folded),
// with an optional chomping indicator (`-` strips the trailing newline, `+`
// keeps every one) and an optional indentation digit.
func blockHeader(value string) (style, chomp byte, ok bool) {
	if value == "" {
		return 0, 0, false
	}
	style = value[0]
	if style != '|' && style != '>' {
		return 0, 0, false
	}
	for index := 1; index < len(value); index++ {
		switch {
		case value[index] == '-' || value[index] == '+':
			if chomp != 0 {
				return 0, 0, false
			}
			chomp = value[index]
		case value[index] >= '1' && value[index] <= '9':
			// The indentation digit is accepted and not interpreted: the block's
			// own indentation is measured from its lines either way.
		default:
			return 0, 0, false
		}
	}
	return style, chomp, true
}

// readBlock collects the indented lines that follow a block scalar header,
// starting at `start` and stopping at the first line that is neither blank nor
// indented. It returns the value and the index of the last line it consumed, so
// the caller's loop resumes below the block rather than inside it.
func readBlock(lines []string, start, end int, style, chomp byte) (string, int) {
	var block []string
	last := start - 1
	for index := start; index < end; index++ {
		line := lines[index]
		if strings.TrimSpace(line) == "" {
			block = append(block, "")
			last = index
			continue
		}
		if line == strings.TrimSpace(line) {
			break
		}
		block = append(block, line)
		last = index
	}
	// Trailing blank lines belong to the chomping indicator, not to the text.
	for len(block) > 0 && block[len(block)-1] == "" {
		block = block[:len(block)-1]
	}

	if indent := commonIndent(block); indent > 0 {
		for index, line := range block {
			if len(line) >= indent {
				block[index] = line[indent:]
			}
		}
	}

	var value string
	if style == '|' {
		// Literal: a newline is a newline.
		value = strings.Join(block, "\n")
	} else {
		// Folded: a newline inside a paragraph is a space.
		value = foldBlock(block)
	}

	trimmed := strings.TrimRight(value, "\n")
	if trimmed == "" {
		return "", last
	}
	switch chomp {
	case '-': // strip: the value ends where the text does
		return trimmed, last
	case '+': // keep: every trailing newline stays
		return value, last
	default: // clip: exactly one trailing newline
		return trimmed + "\n", last
	}
}

// commonIndent is the smallest indentation among the block's non-blank lines:
// the amount all of them share, and therefore the amount the block is indented
// by rather than made of.
func commonIndent(block []string) int {
	indent := -1
	for _, line := range block {
		if line == "" {
			continue
		}
		width := len(line) - len(strings.TrimLeft(line, " "))
		if indent < 0 || width < indent {
			indent = width
		}
	}
	if indent < 0 {
		return 0
	}
	return indent
}

// foldBlock joins a folded (`>`) block: the lines of one paragraph become one
// line separated by spaces, and each blank line becomes the break between
// paragraphs.
func foldBlock(block []string) string {
	var out strings.Builder
	blank := 0
	started := false
	for _, line := range block {
		if strings.TrimSpace(line) == "" {
			blank++
			continue
		}
		if started {
			if blank > 0 {
				out.WriteString(strings.Repeat("\n", blank))
			} else {
				out.WriteByte(' ')
			}
		}
		out.WriteString(line)
		started = true
		blank = 0
	}
	if started {
		out.WriteByte('\n')
	}
	return out.String()
}

// splitTools reads `allowed-tools`. It accepts the `Tool(specifier)` spelling and
// also commas and brackets, and it **does not interpret the permission syntax** —
// that belongs to the security layer. This is a hint for a reader, nothing more.
func splitTools(value string) []string {
	replacer := strings.NewReplacer(",", " ", "[", " ", "]", " ")
	var tools []string
	seen := map[string]bool{}
	for _, field := range strings.Fields(replacer.Replace(value)) {
		if field == "" || seen[field] {
			continue
		}
		seen[field] = true
		tools = append(tools, field)
	}
	return tools
}

func digestOf(body string) string {
	sum := sha256.Sum256([]byte(body))
	return hex.EncodeToString(sum[:])[:12]
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func unsupportedChars(value string) string {
	var found []string
	for _, r := range unsupportedInValue {
		if strings.ContainsRune(value, r) {
			found = append(found, string(r))
		}
	}
	return strings.Join(found, " ")
}

// RenderProblem turns a problem into a sentence.
//
// The wording lives in the interface catalogue rather than here, because the
// parameters can nest (a `skipped` carries the problem that caused it) and the
// sentence has to be assembled in one place.
func RenderProblem(problem Problem) string {
	key := "skills.problem." + problem.Code
	flat := make([]any, 0, len(problem.Params)*2)
	for _, pair := range problem.Params {
		if nested, ok := pair[1].(Problem); ok {
			flat = append(flat, pair[0], RenderProblem(nested))
			continue
		}
		flat = append(flat, pair[0], fmt.Sprint(pair[1]))
	}
	return i18n.T(key, flat...)
}
