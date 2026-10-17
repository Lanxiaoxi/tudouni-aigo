// Package memory is the workspace's long-lived memory: project experience,
// solutions to problems that already came up here, and the way the person in
// this workspace prefers to work.
//
// Three decisions shape everything in this package, and each of them exists to
// prevent a specific failure that the alternative has:
//
//  1. **Markdown files are the fact; the index is derived.** A memory that only
//     exists in `index.json` is a memory one bad write from being gone, and a
//     person who opens `.tudouni/memory/entries/mem_003.md` in an editor must be
//     looking at the real thing. So `index.json` is rebuilt from the Markdown at
//     will, carries no content that is not also in a file, and every read path
//     can answer "what is there" by scanning the directory.
//
//  2. **Nothing is published without review.** The agent may only *propose*
//     (`candidates/`); a candidate becomes a `entries/` record when a person
//     publishes it. That is why the model's write tool is called `propose` and
//     why `Publish` takes a proposal id rather than a memory.
//
//  3. **A failure here is never a failure of the task.** Every exported method
//     returns an error or an empty result, and the runtime treats both as "this
//     session carries on without memory". A run that dies because a memory file
//     had a stray colon would be a much worse bug than a session that forgot
//     something.
//
// The package has no dependency on the agent, the tools or the protocol. It is a
// store with a retrieval function; who calls it, and when, is somebody else's
// decision.
package memory

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Entry is one memory.
//
// There is deliberately no `type` field. The design's first principle is one
// model for everything: an error-and-fix note and a working preference are the
// same shape, and telling them apart is what `triggers` and `scope` are for. A
// taxonomy would need a rule for every combination and would be wrong the first
// time somebody wrote something that is two kinds at once.
type Entry struct {
	// ID is stable for the life of the memory; an update keeps it. It is also the
	// file's name (`entries/mem_003.md`) minus the extension, which is what makes
	// the directory listing a cheap index of ids.
	ID string
	// Revision detects a concurrent update. Every proposal carries the revision it
	// was written against, and `Publish` refuses to overwrite a newer one — a
	// silent overwrite is how two people's notes become one person's note.
	Revision  int
	CreatedAt string
	UpdatedAt string
	// Title is the first `# ` heading. It is also what the retrieval result and the
	// panel row show, so it has to be a sentence a person can recognise: "Android
	// 构建中的 JDK 版本兼容问题", not "note 001".
	Title string
	// Body is the Markdown after the title, and it is the memory itself: what was
	// learned, under what conditions, and how it was verified.
	Body string
	// Scope narrows where this applies. Empty means "this workspace, generally".
	Scope Scope
	// Triggers are the retrieval cues: error text, a command, a topic in the
	// person's own words. They are the strongest signal a query can hit, because
	// they are what somebody wrote down *as* the thing to recognise next time.
	Triggers []string
	// Tags are a coarse second signal. Optional, and deliberately not a taxonomy.
	Tags []string
	// Confidence is one of ConfidenceObserved / Verified / Inferred.
	Confidence string
	// Extra preserves frontmatter keys this build does not know about, so editing
	// a file by hand and then updating it through a proposal cannot silently drop
	// somebody's field.
	Extra map[string]any
}

// Scope is the applicability of a memory.
type Scope struct {
	// Paths are workspace-relative prefixes ("android/", "internal/protocol").
	// Empty means the whole workspace.
	Paths []string
}

// Evidence states. They are states of knowledge, not kinds of content: the same
// note about the same build error is `inferred` the first time and `verified`
// after somebody reproduced it.
const (
	// ConfidenceObserved is "this happened in a session". It is the honest default
	// for something the agent saw and nobody confirmed.
	ConfidenceObserved = "observed"
	// ConfidenceVerified is "this was reproduced, tested or otherwise confirmed".
	// It is the only state that may be claimed on the strength of a tool result.
	ConfidenceVerified = "verified"
	// ConfidenceInferred is "this was concluded from other information". A habit
	// guessed from a single action belongs here, and the design is explicit that
	// such a guess must never be published as a preference the person expressed.
	ConfidenceInferred = "inferred"
)

// ConfidenceLevels is the accepted vocabulary, in rising order of weight.
var ConfidenceLevels = []string{ConfidenceInferred, ConfidenceObserved, ConfidenceVerified}

// ValidConfidence reports whether a string is a confidence this build knows.
func ValidConfidence(value string) bool {
	for _, candidate := range ConfidenceLevels {
		if value == candidate {
			return true
		}
	}
	return false
}

// NormaliseConfidence maps an empty value to the safe default and leaves a known
// one alone. An unknown value is an error rather than a silent downgrade: the
// word would otherwise be written to a file and then ignored by retrieval for
// ever, which is the kind of bug nobody reports.
func NormaliseConfidence(value string) (string, error) {
	value = strings.TrimSpace(strings.ToLower(value))
	if value == "" {
		return ConfidenceObserved, nil
	}
	if !ValidConfidence(value) {
		return "", fmt.Errorf("unknown confidence %q (expected one of %s)",
			value, strings.Join(ConfidenceLevels, ", "))
	}
	return value, nil
}

// frontmatterKeyOrder is the order fields are written in.
//
// Fixed rather than map order because a memory file is read, diffed and edited by
// people: the same memory rewritten must produce the same bytes, or every save
// looks like a change and `git diff` stops being useful on this directory.
var frontmatterKeyOrder = []string{
	"id", "revision", "created_at", "updated_at",
	"scope", "triggers", "tags", "evidence",
}

// ParseEntry decodes one memory file.
//
// It is strict about the two `---` lines and lenient about everything else: a
// file whose frontmatter cannot be found is an error (silently treating the whole
// file as body would hide a broken memory), while an unknown key, an unquoted
// value with a colon in it, or a missing title is accepted. Refusing to load a
// memory because a person wrote it slightly differently is exactly the kind of
// brittleness that makes a feature get turned off.
func ParseEntry(text string) (*Entry, error) {
	fields, body, err := splitFrontmatter(text)
	if err != nil {
		return nil, err
	}
	entry := &Entry{Extra: map[string]any{}}
	for key, value := range fields {
		switch key {
		case "id":
			entry.ID = scalarString(value)
		case "revision":
			entry.Revision = scalarInt(value)
		case "created_at":
			entry.CreatedAt = scalarString(value)
		case "updated_at":
			entry.UpdatedAt = scalarString(value)
		case "scope":
			entry.Scope = Scope{Paths: nestedList(value, "paths")}
		case "triggers":
			entry.Triggers = listOf(value)
		case "tags":
			entry.Tags = listOf(value)
		case "evidence":
			entry.Confidence, _ = NormaliseConfidence(nestedString(value, "confidence"))
		default:
			entry.Extra[key] = value
		}
	}
	entry.Title, entry.Body = splitTitle(body)
	if entry.Title == "" && strings.TrimSpace(entry.Body) == "" {
		return nil, fmt.Errorf("the memory is empty: it has no title and no body")
	}
	return entry, nil
}

// Render writes the memory back out in the canonical form.
//
// Anything parsed is reproduced: the known fields in a fixed order, then unknown
// ones sorted. Round-tripping a file this build does not fully understand must not
// lose what it does not understand.
func (e *Entry) Render() string {
	fields := map[string]any{}
	for _, key := range frontmatterKeyOrder {
		switch key {
		case "id":
			if e.ID != "" {
				fields[key] = e.ID
			}
		case "revision":
			fields[key] = e.Revision
		case "created_at":
			if e.CreatedAt != "" {
				fields[key] = e.CreatedAt
			}
		case "updated_at":
			if e.UpdatedAt != "" {
				fields[key] = e.UpdatedAt
			}
		case "scope":
			if len(e.Scope.Paths) > 0 {
				fields[key] = map[string]any{"paths": e.Scope.Paths}
			}
		case "triggers":
			if len(e.Triggers) > 0 {
				fields[key] = e.Triggers
			}
		case "tags":
			if len(e.Tags) > 0 {
				fields[key] = e.Tags
			}
		case "evidence":
			confidence := e.Confidence
			if confidence == "" {
				confidence = ConfidenceObserved
			}
			fields[key] = map[string]any{"confidence": confidence}
		}
	}
	for key, value := range e.Extra {
		if _, taken := fields[key]; taken {
			continue
		}
		fields[key] = value
	}

	var builder strings.Builder
	builder.WriteString("---\n")
	writeFrontmatter(&builder, fields)
	builder.WriteString("---\n\n")
	title := strings.TrimSpace(e.Title)
	if title != "" {
		builder.WriteString("# " + title + "\n\n")
	}
	body := strings.TrimRight(e.Body, "\n")
	if body != "" {
		builder.WriteString(body)
		builder.WriteString("\n")
	}
	return builder.String()
}

// Digest is the searchable text of a memory, lowercased and capped.
//
// It exists because retrieval must not open every file: an index that has to read
// forty Markdown bodies to answer one query is an index that made the disk the
// bottleneck instead of the memory count. The cap is generous enough that every
// realistic note fits and small enough that a pathological one cannot bloat
// `index.json`.
func (e *Entry) Digest() string {
	parts := []string{e.Title}
	parts = append(parts, e.Triggers...)
	parts = append(parts, e.Tags...)
	parts = append(parts, e.Body)
	text := strings.ToLower(strings.Join(parts, "\n"))
	runes := []rune(text)
	if len(runes) > DigestChars {
		text = string(runes[:DigestChars])
	}
	return text
}

// DigestChars bounds what one memory contributes to the index.
const DigestChars = 4000

// ExemptFromInjection is the one place a memory is kept out of the automatic
// payload even though retrieval found it.
//
// Nothing is exempt today, and the function exists rather than the rule being
// absent: the design says a preference must never override the current request,
// and the place that rule will be enforced is here, on the way into the payload.
func (e *Entry) ExemptFromInjection() bool { return false }

// --- frontmatter plumbing ---------------------------------------------------

// splitFrontmatter returns the decoded header and the body after it.
func splitFrontmatter(text string) (map[string]any, string, error) {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	lines := strings.Split(text, "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return nil, "", fmt.Errorf("no frontmatter: a memory file must start with a --- line")
	}
	end := -1
	for index := 1; index < len(lines); index++ {
		if strings.TrimSpace(lines[index]) == "---" {
			end = index
			break
		}
	}
	if end < 0 {
		return nil, "", fmt.Errorf("the frontmatter is not closed: no second --- line")
	}

	fields := map[string]any{}
	key := ""
	sub := ""
	for _, raw := range lines[1:end] {
		if strings.TrimSpace(raw) == "" || strings.HasPrefix(strings.TrimSpace(raw), "#") {
			continue
		}
		indent := len(raw) - len(strings.TrimLeft(raw, " \t"))
		trimmed := strings.TrimSpace(raw)

		if indent == 0 {
			name, rest, ok := splitKey(trimmed)
			if !ok {
				return nil, "", fmt.Errorf("cannot read frontmatter line %q", trimmed)
			}
			key, sub = name, ""
			if rest != "" {
				fields[key] = parseScalar(rest)
			} else if _, exists := fields[key]; !exists {
				fields[key] = nil
			}
			continue
		}

		if strings.HasPrefix(trimmed, "- ") || trimmed == "-" {
			item := scalarString(parseScalar(strings.TrimSpace(strings.TrimPrefix(trimmed, "-"))))
			fields = appendListItem(fields, key, sub, item)
			continue
		}

		name, rest, ok := splitKey(trimmed)
		if !ok {
			return nil, "", fmt.Errorf("cannot read frontmatter line %q", trimmed)
		}
		if sub != "" {
			// A third level is not part of this format. Accepting it silently would
			// make the value disappear on the next render, so it is kept as a raw
			// string under its own name instead of being dropped.
			fields = appendListItem(fields, key, sub, trimmed)
			continue
		}
		container := ensureMap(fields, key)
		sub = name
		if rest != "" {
			container[name] = parseScalar(rest)
		} else if _, exists := container[name]; !exists {
			container[name] = nil
		}
	}

	return normaliseLists(fields), strings.Join(lines[end+1:], "\n"), nil
}

// splitKey splits `name: rest` at the first colon that is outside quotes.
func splitKey(line string) (string, string, bool) {
	quoted := false
	for index := 0; index < len(line); index++ {
		switch line[index] {
		case '"':
			quoted = !quoted
		case ':':
			if quoted {
				continue
			}
			name := strings.TrimSpace(line[:index])
			if name == "" {
				return "", "", false
			}
			return name, strings.TrimSpace(line[index+1:]), true
		}
	}
	return "", "", false
}

// appendListItem adds one `- item` to the list that the current key points at.
func appendListItem(fields map[string]any, key, sub string, item string) map[string]any {
	if key == "" {
		return fields
	}
	if sub == "" {
		list, _ := fields[key].([]string)
		fields[key] = append(list, scalarString(item))
		return fields
	}
	container := ensureMap(fields, key)
	list, _ := container[sub].([]string)
	container[sub] = append(list, scalarString(item))
	return fields
}

func ensureMap(fields map[string]any, key string) map[string]any {
	if existing, ok := fields[key].(map[string]any); ok {
		return existing
	}
	created := map[string]any{}
	fields[key] = created
	return created
}

// normaliseLists turns a `nil` that stood for "a block follows" into an empty
// list, so `triggers:` with no items reads as "none" rather than as a nil.
func normaliseLists(fields map[string]any) map[string]any {
	for key, value := range fields {
		if value == nil {
			if key == "scope" || key == "evidence" {
				fields[key] = map[string]any{}
				continue
			}
			fields[key] = []string{}
		}
	}
	return fields
}

// parseScalar reads one value: a quoted string, an inline list, or a bare token.
func parseScalar(raw string) any {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if raw == "[]" {
		return []string{}
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		inner := strings.TrimSpace(raw[1 : len(raw)-1])
		if inner == "" {
			return []string{}
		}
		items := []string{}
		for _, piece := range strings.Split(inner, ",") {
			items = append(items, scalarString(parseScalar(piece)))
		}
		return items
	}
	if len(raw) >= 2 && (raw[0] == '"' || raw[0] == '\'') && raw[len(raw)-1] == raw[0] {
		return unquote(raw)
	}
	if number, err := strconv.Atoi(raw); err == nil {
		return number
	}
	return raw
}

func unquote(raw string) string {
	inner := raw[1 : len(raw)-1]
	if raw[0] == '\'' {
		return strings.ReplaceAll(inner, "''", "'")
	}
	var builder strings.Builder
	for index := 0; index < len(inner); index++ {
		if inner[index] == '\\' && index+1 < len(inner) {
			index++
			switch inner[index] {
			case 'n':
				builder.WriteByte('\n')
			case 't':
				builder.WriteByte('\t')
			default:
				builder.WriteByte(inner[index])
			}
			continue
		}
		builder.WriteByte(inner[index])
	}
	return builder.String()
}

func scalarString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case int:
		return strconv.Itoa(typed)
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", typed)
	}
}

func scalarInt(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		if err == nil {
			return parsed
		}
	}
	return 0
}

func listOf(value any) []string {
	switch typed := value.(type) {
	case []string:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			if trimmed := strings.TrimSpace(item); trimmed != "" {
				out = append(out, trimmed)
			}
		}
		return out
	case string:
		if strings.TrimSpace(typed) == "" {
			return nil
		}
		return []string{strings.TrimSpace(typed)}
	default:
		return nil
	}
}

func nestedList(value any, name string) []string {
	container, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return listOf(container[name])
}

func nestedString(value any, name string) string {
	container, ok := value.(map[string]any)
	if !ok {
		return scalarString(value)
	}
	return scalarString(container[name])
}

// splitTitle takes the first `# ` heading as the title and the rest as the body.
//
// Lenient on purpose: a file with no heading keeps its first non-empty line as the
// title and the remainder as the body, so a memory written by hand in a hurry is
// still readable instead of being refused.
func splitTitle(body string) (string, string) {
	lines := strings.Split(body, "\n")
	// Skip a leading run of blank lines.
	start := 0
	for start < len(lines) && strings.TrimSpace(lines[start]) == "" {
		start++
	}
	if start >= len(lines) {
		return "", ""
	}
	first := strings.TrimSpace(lines[start])
	if strings.HasPrefix(first, "# ") {
		title := strings.TrimSpace(strings.TrimPrefix(first, "# "))
		return title, trimLeadingBlank(lines[start+1:])
	}
	title := strings.TrimLeft(first, "#")
	return strings.TrimSpace(title), trimLeadingBlank(lines[start+1:])
}

// trimLeadingBlank drops the empty lines between a title and the body.
//
// It is what makes `Render` idempotent: the renderer owns the separation between the
// title and the body, so a body that kept the file's own blank line would gain one
// more on every save.
func trimLeadingBlank(lines []string) string {
	for len(lines) > 0 && strings.TrimSpace(lines[0]) == "" {
		lines = lines[1:]
	}
	return strings.Join(lines, "\n")
}

// writeFrontmatter renders fields as the block YAML subset this format uses.
func writeFrontmatter(builder *strings.Builder, fields map[string]any) {
	// Known keys first in canonical order, then the rest sorted: two renders of the
	// same memory have to be byte-identical.
	ordered := make([]string, 0, len(fields))
	seen := map[string]bool{}
	for _, key := range frontmatterKeyOrder {
		if _, ok := fields[key]; ok {
			ordered = append(ordered, key)
			seen[key] = true
		}
	}
	rest := make([]string, 0, len(fields))
	for key := range fields {
		if !seen[key] {
			rest = append(rest, key)
		}
	}
	sort.Strings(rest)
	ordered = append(ordered, rest...)

	for _, key := range ordered {
		writeField(builder, key, fields[key], "")
	}
}

func writeField(builder *strings.Builder, key string, value any, indent string) {
	switch typed := value.(type) {
	case map[string]any:
		builder.WriteString(indent + key + ":\n")
		names := make([]string, 0, len(typed))
		for name := range typed {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			writeField(builder, name, typed[name], indent+"  ")
		}
	case []string:
		if len(typed) == 0 {
			builder.WriteString(indent + key + ": []\n")
			return
		}
		builder.WriteString(indent + key + ":\n")
		for _, item := range typed {
			builder.WriteString(indent + "  - " + quoteIfNeeded(item) + "\n")
		}
	case []any:
		if len(typed) == 0 {
			builder.WriteString(indent + key + ": []\n")
			return
		}
		builder.WriteString(indent + key + ":\n")
		for _, item := range typed {
			builder.WriteString(indent + "  - " + quoteIfNeeded(scalarString(item)) + "\n")
		}
	case nil:
		builder.WriteString(indent + key + ": []\n")
	case int:
		builder.WriteString(indent + key + ": " + strconv.Itoa(typed) + "\n")
	default:
		builder.WriteString(indent + key + ": " + quoteIfNeeded(scalarString(typed)) + "\n")
	}
}

// quoteIfNeeded quotes a scalar when a bare one would round-trip differently.
//
// The set that needs it is small and worth stating: a leading or trailing space, a
// `:` (which the parser reads as a key separator), a `#` (which starts a comment in
// YAML and would silently truncate the value), a leading `-` or `[`, and a string
// that looks like a number.
func quoteIfNeeded(value string) string {
	if value == "" {
		return `""`
	}
	needs := strings.TrimSpace(value) != value
	if !needs {
		switch value[0] {
		case '-', '[', '#', '&', '*', '!', '|', '>', '@', '`':
			needs = true
		}
	}
	if !needs {
		for _, marker := range []string{": ", " #", "\n", "\t", "\""} {
			if strings.Contains(value, marker) {
				needs = true
				break
			}
		}
	}
	if !needs && strings.HasSuffix(value, ":") {
		needs = true
	}
	if !needs {
		if _, err := strconv.Atoi(value); err == nil {
			needs = true
		}
	}
	if !needs {
		return value
	}
	escaped := strings.NewReplacer(
		`\`, `\\`,
		`"`, `\"`,
		"\n", `\n`,
		"\t", `\t`,
	).Replace(value)
	return `"` + escaped + `"`
}
