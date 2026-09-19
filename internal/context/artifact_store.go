package context

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Where Artifacts live and how they come back.
//
// It answers one question — where is this Artifact and how do I get it — and it
// does not know that a context exists. Which is why there is no
// `store.AddToContext(...)` in here.
//
//	<workspace>/.tudouni/artifacts/<session>/
//	├── manifest.json        every Artifact's metadata for this session
//	└── refs/art_xxx.txt     bodies, one file each
//
// Why the body is a file and not part of the session file: the session file is
// append-only, so a record costs the size of that record. Putting tens of
// thousands of characters in it means copying the same text to disk every round,
// when it only ever needed writing once. Split apart, the session line is one
// reference (tens of bytes) and the body is content-addressed, so writing the
// same content twice is free.
//
// Why the manifest is rewritten whole: it is the single statement of "which
// artifacts this session has", and artifacts are added and removed rarely — one
// or two per tool call. Incremental writing needs a high-water mark, and when
// that mark and the file disagree the symptom is "some artifacts were gone after
// reopening" — no exception, just a few missing entries. A few hundred KB of
// rewriting buys off a whole class of silent failure.
//
// Why ids come from content:
//
//	artifact_id = art_<sha256(body)[:12]>
//
// A random id differs every round, which makes the rendered prompt differ every
// round, which defeats the prefix cache. Deriving it from the content gives the
// same information the same name, across processes and machines.
//
// The cost, stated plainly: **the same id means the same content, but the
// converse does not hold** — two artifacts with identical bodies from different
// sources each get an id (the second one gains a `-2` suffix). They are two
// different events, and merging them would lose which file was actually read.

const (
	// RefsDirName is where bodies live, inside a session's artifact directory.
	RefsDirName = "refs"
	// ManifestName is the metadata index.
	ManifestName = "manifest.json"

	// HashChars is how many hex digits go into an id. Twelve hex digits is 48
	// bits — a collision inside one session can be ignored — and it is much
	// shorter than the full digest, which matters because the id appears in the
	// prompt every round, in a position billed by the token.
	HashChars = 12

	// CacheEntries is how many bodies stay in memory. One request fetches bodies
	// by representation, and the round right after usually fetches the same ones.
	// Bounded by **count, not bytes**: a body's size is the tool's business, and
	// a byte bound means the largest file never stays cached — precisely the one
	// that costs the most.
	CacheEntries = 32
)

// NewArtifactID derives a stable id from content.
func NewArtifactID(content string) string {
	return "art_" + contentDigest(content)[:HashChars]
}

// contentDigest is the sha256 of the body in hex.
//
// Go strings are byte sequences and are not validated as UTF-8, so arbitrary
// bytes pass through unharmed. The Python original needed an explicit
// "surrogatepass" here for the same reason: computing a hash must not be the
// place where saving a tool result fails.
func contentDigest(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// Snippet is one Artifact opened at one representation.
//
// StartLine and EndLine are 1-based **positions in the original body**, not
// "lines 1..n of what I cut". The two differ once a body has been truncated by
// something upstream.
//
// Truncated means "this is not all of it". It has to survive all the way into
// the rendered text: a model that sees half the content and believes it saw all
// of it is the one silent failure this layer can produce.
type Snippet struct {
	Text       string
	StartLine  int
	EndLine    int
	Truncated  bool
	TotalLines int
}

// ArtifactStore holds one session's artifacts.
type ArtifactStore struct {
	Directory string
	// Clock is injectable so tests can pin creation times.
	Clock func() float64

	mu    sync.Mutex
	items map[string]Artifact
	order []string
	cache map[string]string
	// cacheOrder is the insertion order of `cache`, oldest first. It exists
	// because the map cannot answer "which one went in first", and eviction that
	// does not know that is not the FIFO it is documented to be.
	cacheOrder []string
	byKey      map[string]string
	loaded     bool
}

// OpenArtifactStore prepares the store for a session directory. The directory
// itself is created lazily, on the first write — a session that never calls a
// tool should not leave an empty tree behind.
func OpenArtifactStore(directory string, clock func() float64) *ArtifactStore {
	if clock == nil {
		clock = nowSeconds
	}
	return &ArtifactStore{
		Directory: directory,
		Clock:     clock,
		items:     map[string]Artifact{},
		cache:     map[string]string{},
		byKey:     map[string]string{},
	}
}

// ManifestPath is where the index lives.
func (s *ArtifactStore) ManifestPath() string {
	return filepath.Join(s.Directory, ManifestName)
}

func (s *ArtifactStore) refPath(artifactID string) string {
	return filepath.Join(s.Directory, RefsDirName, refName(artifactID)+".txt")
}

// Load rebuilds metadata from disk, returning the ids whose bodies are gone.
//
// It returns them rather than raising because a session file routinely outlives
// the artifact directory — a person deletes the directory, or a write was cut
// short. The right behaviour is to treat that artifact as nonexistent and render
// the reference line as "no longer available", not to make the whole session
// unopenable. **But never silently**: the caller has to report the list.
func (s *ArtifactStore) Load() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

func (s *ArtifactStore) loadLocked() []string {
	s.items = map[string]Artifact{}
	s.cache = map[string]string{}
	s.cacheOrder = nil
	s.byKey = map[string]string{}
	s.order = nil
	s.loaded = true

	raw, err := os.ReadFile(s.ManifestPath())
	if err != nil {
		return nil
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		// A corrupt manifest means the index is gone. Not fatal: the history is
		// still there in the session file, and all that is lost is "can the
		// bodies be fetched back".
		return nil
	}
	entries, _ := payload["artifacts"].([]any)

	var missing []string
	for _, entry := range entries {
		artifact := artifactFromJSON(entry)
		if artifact.ID == "" {
			continue
		}
		if _, err := os.Stat(s.refPath(artifact.ID)); err != nil {
			missing = append(missing, artifact.ID)
			continue
		}
		s.items[artifact.ID] = artifact
		s.order = append(s.order, artifact.ID)
		// The dedupe table has to be rebuildable from disk. It can collide (the
		// same content and source genuinely stored twice), and then the first
		// entry wins while the rest stay in items — they have their own ids and
		// neither can delete the other.
		key := dedupeKey(artifact.ContentRef, artifact.Source)
		if _, taken := s.byKey[key]; !taken {
			s.byKey[key] = artifact.ID
		}
	}
	return missing
}

// saveManifest rewrites the index whole, atomically.
func (s *ArtifactStore) saveManifestLocked() error {
	if err := os.MkdirAll(s.Directory, 0o755); err != nil {
		return err
	}
	artifacts := make([]any, 0, len(s.order))
	for _, id := range s.order {
		artifacts = append(artifacts, s.items[id].ToJSON())
	}
	payload := map[string]any{"version": 1, "artifacts": artifacts}

	raw, err := json.MarshalIndent(payload, "", " ")
	if err != nil {
		return err
	}
	temporary := s.ManifestPath() + ".tmp"
	if err := os.WriteFile(temporary, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(temporary, s.ManifestPath())
}

// Create takes a body in and returns its Artifact.
//
// Body first, metadata second: the id is known before anything is written
// (content-addressed), so the write order is "body, then index". The other order
// leaves an index entry pointing at nothing when a crash lands in between — and
// that state has to be handled as "the body is gone" on the read side. In this
// order it cannot arise.
func (s *ArtifactStore) Create(content, artifactType string, source ArtifactSource, metadata map[string]any) (Artifact, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.createLocked(content, artifactType, source, metadata)
}

func (s *ArtifactStore) createLocked(content, artifactType string, source ArtifactSource, metadata map[string]any) (Artifact, error) {
	s.ensureLoadedLocked()
	if artifactType == "" {
		artifactType = "text"
	}
	digest := contentDigest(content)
	// The key uses the **short** hash, and it must be exactly as long as what
	// dedupeKey reads back off disk — otherwise "created just now" and "left by a
	// previous session" do not match, and the symptom is a duplicate artifact
	// every time the same file is read after a restart.
	key := digest[:HashChars] + "\x00" + sourceKey(source)

	// This content and source already exist: hand that one back, write nothing.
	//
	// Checking before writing is deliberate. Bodies are content-addressed, so two
	// files with the same content are the same file — rewriting it costs an I/O
	// and buys a new created_at that nobody reads.
	if known, ok := s.byKey[key]; ok {
		if artifact, present := s.items[known]; present {
			return artifact, nil
		}
	}

	artifactID := "art_" + digest[:HashChars]
	if _, taken := s.items[artifactID]; taken {
		// Same body, different source (a file whose content happens to match
		// another). A fresh id rather than reuse: the two metadata records do not
		// say the same thing — the path differs — and "which file was read" is
		// exactly what gets asked afterwards.
		artifactID = s.disambiguateLocked(artifactID)
	}

	path := s.refPath(artifactID)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return Artifact{}, err
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return Artifact{}, err
	}

	copied := map[string]any{}
	for name, value := range metadata {
		copied[name] = value
	}
	artifact := Artifact{
		ID:         artifactID,
		Type:       artifactType,
		Source:     source,
		ContentRef: path,
		Metadata:   copied,
		CreatedAt:  s.Clock(),
		Chars:      runeLen(content),
	}
	s.items[artifactID] = artifact
	s.order = append(s.order, artifactID)
	s.rememberLocked(artifactID, content)
	s.byKey[key] = artifactID
	return artifact, s.saveManifestLocked()
}

// disambiguateLocked picks a non-colliding id for the same content from a
// different source.
//
// The suffix starts at `-2`, not `-1`: side by side, `art_x` and `art_x-2` read
// as "the second one", while `-1` suggests an `art_x-0` that is not shown.
func (s *ArtifactStore) disambiguateLocked(base string) string {
	for n := 2; ; n++ {
		candidate := base + "-" + strconv.Itoa(n)
		if _, taken := s.items[candidate]; !taken {
			return candidate
		}
	}
}

// Delete removes one artifact: body file and index entry. A missing id is not an
// error.
//
// The budget layer calls this when an item has bottomed out at metadata, so it
// has to be idempotent: the same degradation step can call it twice, and raising
// on the second call would turn one over-budget round into a failed run.
func (s *ArtifactStore) Delete(artifactID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLoadedLocked()

	if _, present := s.items[artifactID]; !present {
		delete(s.cache, artifactID)
		return false
	}
	delete(s.items, artifactID)
	delete(s.cache, artifactID)
	for index, id := range s.order {
		if id == artifactID {
			s.order = append(s.order[:index], s.order[index+1:]...)
			break
		}
	}
	// A failed unlink is fine: the index entry is gone, which is the fact that
	// matters ("this artifact is not in the context"). The caller is on the
	// degradation path and its work is already done.
	_ = os.Remove(s.refPath(artifactID))
	_ = s.saveManifestLocked()
	return true
}

// Get returns metadata. It does not read the body.
func (s *ArtifactStore) Get(artifactID string) (Artifact, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLoadedLocked()
	artifact, ok := s.items[artifactID]
	return artifact, ok
}

// All returns every artifact in creation order. It does not read bodies.
func (s *ArtifactStore) All() []Artifact {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLoadedLocked()
	all := make([]Artifact, 0, len(s.order))
	for _, id := range s.order {
		all = append(all, s.items[id])
	}
	return all
}

// Len is how many artifacts are on disk (including ones never in the context).
func (s *ArtifactStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLoadedLocked()
	return len(s.items)
}

// Content returns the whole body, or false when it cannot be fetched.
//
// It does not raise, for the same reason the budget tolerates a missing body: a
// reference whose artifact was deleted is a session-file problem, not a reason
// to abort the turn.
func (s *ArtifactStore) Content(artifactID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLoadedLocked()

	if text, ok := s.cache[artifactID]; ok {
		return text, true
	}
	if _, present := s.items[artifactID]; !present {
		return "", false
	}
	raw, err := os.ReadFile(s.refPath(artifactID))
	if err != nil {
		return "", false
	}
	text := string(raw)
	s.rememberLocked(artifactID, text)
	return text, true
}

// Lines splits the body, or reports that it cannot be fetched.
func (s *ArtifactStore) Lines(artifactID string) ([]string, bool) {
	text, ok := s.Content(artifactID)
	if !ok {
		return nil, false
	}
	return splitLines(text), true
}

// Read returns a line interval (1-based, inclusive).
//
// Out-of-range bounds are clamped rather than refused: the model reads rendered
// text, and "line number out of range" tells it nothing useful — saying which
// lines it actually got does.
//
// maxChars is not optional decoration. Line count is the first gate, and it does
// nothing at all for a body whose lines are enormous: minified JSON, a log built
// by joining an array, anything without newlines, is one line long. There,
// "give it 20 lines" means the whole body, and the degradation loop picks the
// same item over and over without ever shrinking it. So the character budget is
// the second gate, and both have to bite before the item counts as degraded.
func (s *ArtifactStore) Read(artifactID string, start, end *int, maxChars *int) (Snippet, bool) {
	lines, ok := s.Lines(artifactID)
	if !ok {
		return Snippet{}, false
	}
	total := len(lines)
	first := 1
	if start != nil && *start > 1 {
		first = *start
	}
	last := total
	if end != nil && *end < total {
		last = *end
	}
	if last < first {
		// An empty interval: empty text, but honest line numbers, so the caller
		// can see that this level gave nothing.
		return Snippet{Text: "", StartLine: first, EndLine: first - 1, TotalLines: total}, true
	}
	if first-1 > len(lines) {
		return Snippet{Text: "", StartLine: first, EndLine: first - 1, TotalLines: total}, true
	}
	return clip(lines[first-1:last], first, last, total, maxChars), true
}

// Preview returns the first N lines, then clamps by characters.
func (s *ArtifactStore) Preview(artifactID string, lines int, maxChars *int) (Snippet, bool) {
	if lines < 1 {
		lines = 1
	}
	end := lines
	return s.Read(artifactID, nil, &end, maxChars)
}

// MetadataOf is the "metadata level" rendering of an artifact: facts about the
// body, no body.
//
// It is the last level before deletion, so it still has to be useful — path,
// line count, size, source. From it the model can at least tell that something
// exists and how big it is.
func (s *ArtifactStore) MetadataOf(artifactID string) map[string]any {
	artifact, ok := s.Get(artifactID)
	if !ok {
		return map[string]any{}
	}
	data := map[string]any{
		"id":    artifact.ID,
		"type":  artifact.Type,
		"chars": artifact.Chars,
	}
	if artifact.Source.Tool != "" {
		data["tool"] = artifact.Source.Tool
	}
	if artifact.Source.Path != "" {
		data["path"] = artifact.Source.Path
	}
	if artifact.Source.URL != "" {
		data["url"] = artifact.Source.URL
	}
	for key, value := range artifact.Metadata {
		data[key] = value
	}
	return data
}

func (s *ArtifactStore) rememberLocked(artifactID, text string) {
	if _, warm := s.cache[artifactID]; !warm {
		s.cacheOrder = append(s.cacheOrder, artifactID)
	}
	s.cache[artifactID] = text
	// Eviction is FIFO rather than LRU on purpose: the goal is only "do not read
	// the disk on every step", and LRU would require reordering on every hit —
	// an expense paid on every step for a marginal gain.
	//
	// `cacheOrder` is what makes that FIFO true rather than aspirational: ranging
	// over the map would hand back whichever key Go felt like, which can be the
	// entry that was just read from disk. An id deleted underneath the order (see
	// Delete) is skipped when it comes up, because the loop asks the cache
	// whether anything was actually dropped.
	for len(s.cache) > CacheEntries && len(s.cacheOrder) > 0 {
		oldest := s.cacheOrder[0]
		s.cacheOrder = s.cacheOrder[1:]
		delete(s.cache, oldest)
	}
}

func (s *ArtifactStore) ensureLoadedLocked() {
	if !s.loaded {
		s.loadLocked()
	}
}

// --- helpers ----------------------------------------------------------------

// refName maps an id to a safe filename. Anything outside the whitelist is
// replaced, because the id reaches a path and a crafted one could otherwise
// write outside the directory.
func refName(artifactID string) string {
	var builder strings.Builder
	for _, r := range artifactID {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '_', r == '-':
			builder.WriteRune(r)
		default:
			builder.WriteRune('_')
		}
	}
	return builder.String()
}

// dedupeKey rebuilds the dedupe key from an artifact's own metadata.
//
// It reads the hash back out of the path instead of hashing the body again:
// Load would otherwise read every body on disk, and restoring a session would
// mean reading hundreds of megabytes. The suffix (`-2` and friends) is stripped
// because the hash part is unchanged when the source differs, and "have I seen
// this content" must look at the content.
func dedupeKey(contentRef string, source ArtifactSource) string {
	name := strings.TrimSuffix(filepath.Base(contentRef), ".txt")
	name = strings.TrimPrefix(name, "art_")
	if index := strings.Index(name, "-"); index >= 0 {
		name = name[:index]
	}
	if len(name) > HashChars {
		name = name[:HashChars]
	}
	return name + "\x00" + sourceKey(source)
}

// sourceKey is what "the same source" means. It looks at the tool and the
// path/URL only — metadata holds timestamps and line numbers that differ every
// time, and counting those would cancel deduplication altogether.
func sourceKey(source ArtifactSource) string {
	return source.Tool + "\x00" + source.Path + "\x00" + source.URL
}

// clip joins a run of lines and applies the character budget.
//
// Cutting happens on line boundaries only. EndLine is what the model uses to
// judge which part it is looking at, and an interval ending mid-line reads as if
// that whole line arrived. The price is that the last, too-long line is dropped
// entirely; what it buys is that the stated interval is always true. When not
// even one line fits, the head of that single line is given with an ellipsis —
// then "which lines" means nothing anyway, and "it was cut" has to be visible.
func clip(lines []string, first, last, total int, maxChars *int) Snippet {
	var kept []string
	used := 0
	end := first - 1
	cut := false

	for offset, line := range lines {
		if maxChars == nil {
			kept = append(kept, line)
			separator := 0
			if len(kept) > 1 {
				separator = 1
			}
			used += runeLen(line) + separator
			end = first + offset
			continue
		}
		// The separator is the newline **between** lines, so it is owed from the
		// second line on — the same account the unlimited branch above keeps. It
		// used to be charged to the first line instead, which under-counted a run
		// of n lines by n-2 and let the snippet through a budget it had been
		// measured against.
		separator := 0
		if len(kept) > 0 {
			separator = 1
		}
		if used+separator+runeLen(line) <= *maxChars {
			kept = append(kept, line)
			used += separator + runeLen(line)
			end = first + offset
			continue
		}
		cut = true
		if len(kept) == 0 {
			// The first line alone blows the budget. Handling only the
			// "already have content" branch is what made degradation return the
			// whole body again and again while the level genuinely changed — so
			// nothing in the log or the level told you it was stuck.
			//
			// The ellipsis is a character too, so one is held back from the
			// budget for it. Taking it out of `separator` is what this used to
			// do, and a newline is not what that character is.
			allowance := *maxChars - 1
			if allowance < 1 {
				allowance = 1
			}
			kept = append(kept, truncateRunes(line, allowance)+"…")
			end = first + offset
		}
		break
	}

	return Snippet{
		Text:       strings.Join(kept, "\n"),
		StartLine:  first,
		EndLine:    end,
		Truncated:  cut || first > 1 || last < total,
		TotalLines: total,
	}
}

// splitLines splits on newlines and drops one trailing empty element.
//
// `"a\nb\n"` splits into `["a","b",""]`, and that last empty string is not a
// line — it is the fact that the file ends with a newline. Counting it as one
// makes TotalLines permanently one too high, and the model, quoting line numbers
// back, is off by one.
func splitLines(text string) []string {
	if text == "" {
		return nil
	}
	lines := strings.Split(text, "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func runeLen(text string) int {
	count := 0
	for range text {
		count++
	}
	return count
}

// nowSeconds is wall-clock seconds, matching the `created_at` in older session
// files. The agent's own clock is monotonic (it measures durations), and writing
// that into an artifact would date it to 1970.
func nowSeconds() float64 {
	return float64(time.Now().UnixNano()) / 1e9
}

func truncateRunes(text string, limit int) string {
	if limit <= 0 {
		return ""
	}
	count := 0
	for index := range text {
		if count == limit {
			return text[:index]
		}
		count++
	}
	return text
}
