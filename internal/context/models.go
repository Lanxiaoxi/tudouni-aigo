// Package context decides what the model gets to see this round.
//
// Four objects, each answering a different question, and the separation is the
// whole point — mixed together, the questions stop being separable:
//
//	ToolExecution   "what just happened?"
//	Artifact        "what information do I have?"
//	ContextItem     "which of it should the model see now, and how much of it?"
//	ContextState    "what does the context look like at this moment?"
//
// The invariant worth stating up front: **an Artifact's body never lives in a
// ContextState.** The state is written to the session file and walked on every
// request; the moment it can hold a 120k-character file, "large data never
// enters the state" is a comment rather than a property. It holds pointers.
//
// The other invariant: **the shape of the payload never changes.** Degradation
// swaps representation and re-renders; it never reorders, merges or drops
// messages. Message order is what the provider's prefix cache is computed over,
// and a cache miss on a long conversation costs about fifty times more than a
// hit — so "tidy up the history" is not a neutral act.
package context

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Representation is how much of an Artifact's body is in play this round.
//
// The four levels are ordered, and **the order is the direction of
// degradation**: when tokens run short an item walks from full toward metadata,
// rather than the old message being deleted. "Delete the old message" turns one
// piece of information into nothing; degrading turns it into "the model still
// knows it exists and can read it again" — which in a long task is nearly free
// insurance.
type Representation string

const (
	// RepresentationMetadata gives facts about the body and no body at all.
	RepresentationMetadata Representation = "metadata"
	// RepresentationThumbnail is a downscaled copy of a picture.
	//
	// It sits between metadata and preview, and it is only ever set on an image
	// item: a text body has nothing between "the head of it" and "the facts about
	// it". The rung exists because an image cannot be **truncated** — half a JPEG
	// is not half an image — so the only honest way to make a picture cheaper
	// without losing the picture is to send a smaller one.
	RepresentationThumbnail Representation = "thumbnail"
	// RepresentationPreview is a truncated head.
	RepresentationPreview Representation = "preview"
	// RepresentationRange is a line interval.
	RepresentationRange Representation = "range"
	// RepresentationFull is the whole thing. Nothing is added to it.
	RepresentationFull Representation = "full"
)

// representationOrder is the **text** ladder, cheapest first.
//
// Thumbnail is deliberately not in it. The ladder is not one order: a text body
// walks full → range → preview → metadata, and a picture walks full → thumbnail →
// metadata. Writing them as one list was tried and produces a rung either kind can
// land on but only one kind can use — a "thumbnail" of a log file, or a "range" of
// a JPEG — and the degradation loop then moves an item without shrinking it, which
// is invisible in both the level and the token bill.
//
// The per-kind step is NextLevel below; this list stays the text ladder so the
// existing behaviour of every text artifact is byte-for-byte unchanged.
var representationOrder = [...]Representation{
	RepresentationMetadata,
	RepresentationPreview,
	RepresentationRange,
	RepresentationFull,
}

// Rank is a total order over every level, cheapest first, with the image rung
// sitting where its cost sits.
//
// **Nothing derives the next level from this number.** That was tried, and it
// broke the moment a second ladder existed: `Degraded` indexed the text-only array
// with a rank that counted the image rung, so `full` stepped down to `full` and
// degradation became an item that moved without shrinking — the exact failure this
// ladder is built to make impossible. Rank answers "which of these two is
// cheaper"; the steps are written out in Degraded and NextLevel.
func (r Representation) Rank() int {
	switch r {
	case RepresentationMetadata:
		return 0
	case RepresentationThumbnail:
		return 1
	case RepresentationPreview:
		return 2
	case RepresentationRange:
		return 3
	case RepresentationFull:
		return 4
	default:
		return -1
	}
}

// Degraded steps down one rung of the **text** ladder. **Already at metadata
// returns itself**, and the caller reads that as "there is nothing left to give" —
// which is how it decides to evict instead.
//
// Images do not go through here: see NextLevel, which is what the degradation loop
// calls. It is `limit`ed to the text ladder on purpose — a picture sitting on
// "full" must step to the thumbnail rung, and sending it through this function
// would step it to "range", which renders the same bytes back.
func (r Representation) Degraded() Representation {
	switch r {
	case RepresentationFull:
		return RepresentationRange
	case RepresentationRange:
		return RepresentationPreview
	case RepresentationPreview:
		return RepresentationMetadata
	default:
		// Metadata is the floor; a picture's rungs and an unknown name both stay
		// put here, and NextLevel is what moves them.
		return r
	}
}

// NextLevel is the rung below this one **for this kind of body**, and it is the
// only step the degradation loop is allowed to take.
//
// The two ladders:
//
//	text   full → range → preview → metadata → (evicted)
//	image  full → thumbnail → metadata → (evicted)
//
// Why one function rather than a method on the representation: which rung comes
// next is a fact about the *body*, and a representation on its own cannot know
// whether it is describing a JPEG or a log file. Putting the decision on the
// representation was the first shape tried, and it produced a "range" level on an
// image (which renders the same bytes back, so degradation ran and nothing shrank)
// and a "thumbnail" level on a text body (which is not a thing).
func (r Representation) NextLevel(isImage bool) Representation {
	if !isImage {
		return r.Degraded()
	}
	switch r {
	case RepresentationFull:
		return RepresentationThumbnail
	case RepresentationThumbnail:
		return RepresentationMetadata
	default:
		// An image sitting on a text-only rung (a level restored from a session
		// file written before pictures had their own ladder, say) steps to metadata
		// rather than through a rung that cannot shrink a picture. Metadata is also
		// the answer at metadata itself, and the caller reads that as "nothing left
		// to give".
		return RepresentationMetadata
	}
}

// ParseRepresentation accepts the wire form.
//
// An unrecognised name is an error, never a silent fall back to full. Silent
// fallback is the worst failure shape available here: a typo in a level name
// that still renders everything in full means "the compaction I configured"
// becomes a phenomenon nobody can reproduce.
func ParseRepresentation(value string) (Representation, error) {
	switch Representation(value) {
	case RepresentationMetadata, RepresentationThumbnail, RepresentationPreview,
		RepresentationRange, RepresentationFull:
		return Representation(value), nil
	}
	return "", fmt.Errorf("unknown representation %q (known: %s)",
		value, strings.Join(representationNames(), ", "))
}

func representationNames() []string {
	names := make([]string, 0, len(representationOrder)+1)
	names = append(names, string(RepresentationThumbnail))
	for _, value := range representationOrder {
		names = append(names, string(value))
	}
	return names
}

// Zone is which band of the request an item belongs to.
//
// It is derived from the provider's prefix cache: only the stable prefix is
// cheap to re-send. So "does this change between rounds" has to be a property of
// the data, not a judgement made at render time — guessing wrong means paying
// the uncached rate for the same paragraph on every step.
type Zone string

const (
	// ZoneSystem renders as the standalone role="system" message.
	ZoneSystem Zone = "system"
	// ZoneStable is history that is not expected to change.
	ZoneStable Zone = "stable"
	// ZoneDynamic is tool output and this round's context: first to be touched.
	ZoneDynamic Zone = "dynamic"
)

// ParseZone accepts the wire form, with the same no-silent-fallback rule as
// ParseRepresentation.
func ParseZone(value string) (Zone, error) {
	switch Zone(value) {
	case ZoneSystem, ZoneStable, ZoneDynamic:
		return Zone(value), nil
	}
	return "", fmt.Errorf("unknown zone %q (known: system, stable, dynamic)", value)
}

// ArtifactSource records where a piece of information came from.
//
// The model never sees it. It exists because the first question asked afterwards
// is always "where did this text come from" — and the useful answer is the shape
// of the origin (which tool, which path, which URL), not a sentence somebody
// wrote about it.
type ArtifactSource struct {
	Tool string
	Path string
	URL  string
}

// ToJSON writes only the fields that are set. A key that is always the empty
// string makes a reader conclude that run really had no path.
func (s ArtifactSource) ToJSON() map[string]any {
	data := map[string]any{}
	for name, value := range map[string]string{"tool": s.Tool, "path": s.Path, "url": s.URL} {
		if value != "" {
			data[name] = value
		}
	}
	return data
}

func artifactSourceFromJSON(raw any) ArtifactSource {
	object, _ := raw.(map[string]any)
	return ArtifactSource{
		Tool: textOf(object["tool"]),
		Path: textOf(object["path"]),
		URL:  textOf(object["url"]),
	}
}

// Artifact is one piece of information that can be referenced later. Its body is
// on disk, not in here.
//
// The fields earn their places:
//
//   - ID is a stable identity, because a random id makes the rendered prompt
//     differ every round and that alone defeats the prefix cache.
//   - Type is a coarse class (file / command / search / web / text) that decides
//     how a range is sliced; it does not need to be precise.
//   - Metadata holds facts the tool knew and this layer cannot derive (path,
//     status code, exit code). It is the entire basis for the range and metadata
//     levels.
//   - Chars is the body length. It lives here rather than being counted on
//     demand because the budget needs it on every step, and counting means
//     reading the body into memory.
//
// Artifact also carries the two facts an image needs and a text body does not:
// a byte size, and a mime type. They are not a separate type of artifact — an
// image is an artifact whose type is "image" and whose body is bytes rather than
// text — because the whole rest of the system (identity, dedupe, the manifest,
// degradation, eviction) is about "a body on disk" and needs no second copy.
type Artifact struct {
	ID         string
	Type       string
	Source     ArtifactSource
	ContentRef string
	Metadata   map[string]any
	CreatedAt  float64
	// Chars is the body length **in characters**, which is the file-size measure a
	// text artifact is described by. It is 0 for an image: a byte stream is not
	// made of characters, and counting runes over a JPEG produces a number that
	// looks like a size and is not one.
	Chars int
	// Bytes is the body length in bytes, for every artifact. It is what an image's
	// size is reported from, and it is the fallback measure for a text body whose
	// rune count nobody needs.
	Bytes int
}

// ToJSON is the session-file form.
func (a Artifact) ToJSON() map[string]any {
	metadata := map[string]any{}
	for key, value := range a.Metadata {
		metadata[key] = value
	}
	return map[string]any{
		"id":          a.ID,
		"type":        a.Type,
		"source":      a.Source.ToJSON(),
		"content_ref": a.ContentRef,
		"metadata":    metadata,
		"created_at":  a.CreatedAt,
		"chars":       a.Chars,
		"bytes":       a.Bytes,
	}
}

func artifactFromJSON(raw any) Artifact {
	object, _ := raw.(map[string]any)
	artifact := Artifact{
		ID:         textOf(object["id"]),
		Type:       textOrDefault(object["type"], "text"),
		Source:     artifactSourceFromJSON(object["source"]),
		ContentRef: textOf(object["content_ref"]),
		Metadata:   objectOf(object["metadata"]),
		CreatedAt:  floatOf(object["created_at"]),
		Chars:      intOf(object["chars"]),
		Bytes:      intOf(object["bytes"]),
	}
	// A session file written before `bytes` existed has a text artifact with no
	// byte count. The rune count stands in for it, which is the honest reading:
	// for the bodies those files hold, the two numbers were the same fact.
	if artifact.Bytes == 0 && !artifact.IsImage() {
		artifact.Bytes = artifact.Chars
	}
	return artifact
}

// IsImage reports whether this artifact's body is a picture.
//
// The test is the type, never the mime metadata: mime is a fact the read path
// recorded, while the type is what decides how the body may be rendered and
// degraded, and a body whose mime sniffing failed is still an image.
func (a Artifact) IsImage() bool { return a.Type == TypeImage }

// Size is the body size in the measure that suits this artifact: bytes for a
// picture, characters for text.
func (a Artifact) Size() int {
	if a.IsImage() {
		return a.Bytes
	}
	return a.Chars
}

// MetadataString reads one metadata field as a string. Absent and non-string are
// both the empty answer, because metadata is untyped by design.
func (a Artifact) MetadataString(key string) string { return textOf(a.Metadata[key]) }

// MetadataInt reads one metadata field as an int.
func (a Artifact) MetadataInt(key string) int { return intOf(a.Metadata[key]) }

// TypeImage is the artifact type of a picture. It is a named constant because
// three places test it (the renderer, the degradation ladder and the vision gate)
// and a string literal repeated three times is how one of them drifts.
const TypeImage = "image"

// Image metadata keys. They live in Metadata rather than in new Artifact fields
// because they are "facts the tool knew and this layer cannot derive" — exactly
// what that bag is for — and because an older session file that lacks them reads
// as "unknown", which is the correct answer.
const (
	MetaMIME     = "mime"
	MetaWidth    = "width"
	MetaHeight   = "height"
	MetaName     = "name"
	MetaVariants = "variants"
)

// ContextItem is "how the model should see this information right now".
//
// It is the only bridge between what exists and what is sent. The Artifact
// answers "what do I have"; this answers "in what form, in which band, and is it
// worth pushing someone else out".
//
// Representation is decided once, when the item enters, and then only ever
// moves down. Recomputing it every round would make the prompt differ every
// round — the same cache problem as random ids.
type ContextItem struct {
	ArtifactID     string
	Representation Representation
	Zone           Zone
	// Priority: higher is more important, so higher degrades later.
	Priority int
	// Pinned means "do not touch it, even when tokens run short".
	Pinned bool
	// Sequence only ever grows. It is the stable tie-break for "who goes first".
	Sequence int
	// Options carries what rendering needs (start_line / end_line / preview_lines).
	Options map[string]any
	// Removed means evicted: out of the context, body still on disk.
	//
	// The item stays in the list rather than being deleted, for two reasons: an
	// artifact that bottomed out must not reappear when the budget loosens
	// (degradation never reverses), so "it was here and now it is not" has to be
	// remembered; and "why did this round not show that file" needs an answer
	// that survives in the session file.
	Removed bool
}

// ToJSON writes the full set. Empty options and a default level are written too:
// they have defaults on the way back in, but "which level was it at" has to be
// readable exactly — omitting it makes whoever restores the session guess.
func (i ContextItem) ToJSON() map[string]any {
	options := map[string]any{}
	for key, value := range i.Options {
		options[key] = value
	}
	return map[string]any{
		"artifact_id":    i.ArtifactID,
		"representation": string(i.Representation),
		"zone":           string(i.Zone),
		"priority":       i.Priority,
		"pinned":         i.Pinned,
		"sequence":       i.Sequence,
		"options":        options,
		"removed":        i.Removed,
	}
}

func contextItemFromJSON(raw any) (*ContextItem, error) {
	object, _ := raw.(map[string]any)
	representation, err := ParseRepresentation(textOrDefault(object["representation"], "full"))
	if err != nil {
		return nil, err
	}
	zone, err := ParseZone(textOrDefault(object["zone"], "dynamic"))
	if err != nil {
		return nil, err
	}
	return &ContextItem{
		ArtifactID:     textOf(object["artifact_id"]),
		Representation: representation,
		Zone:           zone,
		Priority:       intOf(object["priority"]),
		Pinned:         boolOf(object["pinned"]),
		Sequence:       intOf(object["sequence"]),
		Options:        objectOf(object["options"]),
		Removed:        boolOf(object["removed"]),
	}, nil
}

// ContextNote is text rebuilt every round: it never enters history and never
// reaches disk.
//
// Only one thing is in this class today — the session-state line at the tail of
// the payload. It has to be in the ledger, or the budget treats it as air: a
// 200-token reminder is nothing inside a 100K request, and it is the straw when
// the budget is already pressed against the ceiling.
//
// It is a separate type from ContextItem because that one requires an
// artifact_id, and this kind of content has no Artifact at all: it differs every
// round, so storing it stores rubbish. Inventing a fake id would make "which
// things have a body on disk" answer wrongly.
type ContextNote struct {
	Text     string
	Zone     Zone
	Priority int
	Pinned   bool
	Sequence int
}

// ContextState is the whole of one round's context. Pointers only, no bodies.
//
// Version increments on every change, and it is more than bookkeeping: the store
// only writes a context record when the version moved, which is what makes
// "recompute the same batch of items twice in one round" structurally
// impossible.
type ContextState struct {
	Items   []*ContextItem
	Version int
	// Notes deliberately stay out of ToJSON. The session file records "the
	// context state at this moment"; notes differ every round, and persisting
	// them would make whoever restores the session believe that was what went
	// out.
	Notes []*ContextNote
}

// Get finds an item by artifact id.
func (s *ContextState) Get(artifactID string) *ContextItem {
	for _, item := range s.Items {
		if item.ArtifactID == artifactID {
			return item
		}
	}
	return nil
}

// Live is the items that actually render (the ones not evicted).
func (s *ContextState) Live() []*ContextItem {
	live := make([]*ContextItem, 0, len(s.Items))
	for _, item := range s.Items {
		if !item.Removed {
			live = append(live, item)
		}
	}
	return live
}

// NextSequence is derived from the items rather than kept in a counter.
//
// A separate counter is a second copy of the same fact, and it goes wrong on
// exactly one path: restoring a session. The items come back with their
// sequences while the counter starts fresh, so new items are inserted into the
// middle of the old ordering.
func (s *ContextState) NextSequence() int {
	highest := -1
	for _, item := range s.Items {
		if item.Sequence > highest {
			highest = item.Sequence
		}
	}
	return highest + 1
}

// NextNoteSequence counts separately: notes and items are not one numbering.
func (s *ContextState) NextNoteSequence() int {
	highest := -1
	for _, note := range s.Notes {
		if note.Sequence > highest {
			highest = note.Sequence
		}
	}
	return highest + 1
}

// ToJSON is the session-file form. Notes are excluded by design.
func (s *ContextState) ToJSON() map[string]any {
	items := make([]any, 0, len(s.Items))
	for _, item := range s.Items {
		items = append(items, item.ToJSON())
	}
	return map[string]any{"version": s.Version, "items": items}
}

// MarshalJSON writes the session-file form.
//
// It exists so the field names on disk are the snake_case ones this format has
// always used rather than Go's exported names. A session file outlives the
// program that wrote it, and a rename here would make every older file read as
// an empty context — quietly, since a missing key is not an error.
func (s *ContextState) MarshalJSON() ([]byte, error) {
	return json.Marshal(s.ToJSON())
}

// ContextStateFromJSON rebuilds a state, or fails on a level name it does not
// recognise. Failing matters here: the session file is the only record of what
// the model was shown.
func ContextStateFromJSON(raw any) (*ContextState, error) {
	object, _ := raw.(map[string]any)
	state := &ContextState{Version: intOf(object["version"])}
	entries, _ := object["items"].([]any)
	for _, entry := range entries {
		item, err := contextItemFromJSON(entry)
		if err != nil {
			return nil, err
		}
		state.Items = append(state.Items, item)
	}
	return state, nil
}

// --- small coercions --------------------------------------------------------
//
// These exist because the session file is read as generic JSON. Every one of
// them has a total answer: a wrong type yields the zero value rather than an
// error, because a malformed optional field must not make a session unopenable.

func textOf(value any) string {
	text, _ := value.(string)
	return text
}

func textOrDefault(value any, fallback string) string {
	if text, ok := value.(string); ok && text != "" {
		return text
	}
	return fallback
}

func intOf(value any) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case int:
		return number
	case int64:
		return int(number)
	default:
		return 0
	}
}

func floatOf(value any) float64 {
	switch number := value.(type) {
	case float64:
		return number
	case int:
		return float64(number)
	case int64:
		return float64(number)
	default:
		return 0
	}
}

func boolOf(value any) bool {
	flag, _ := value.(bool)
	return flag
}

func objectOf(value any) map[string]any {
	object, _ := value.(map[string]any)
	if object == nil {
		return map[string]any{}
	}
	return object
}
