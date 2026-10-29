package hooks

import (
	"strings"
	"sync"
)

// Context is what hooks have asked to be appended to the request tail.
//
// It has **no way to reach a session's messages**, and that absence is the whole
// design: a hook's note describes *this request*, not anything either party said,
// so putting it in history would make the session file a record of something that
// never happened — and every later replay would then have to decide whether the
// note still applies. Two lifetimes are enough to express what hooks need:
//
//   - **Turn**: `session_start` (injected into the first turn only) and
//     `user_prompt_submit` (every turn). Cleared when the turn ends.
//   - **Batch**: `post_tool_use`. Cleared when the next batch begins, because what
//     it describes is the batch that just finished.
//
// `Text()` is a pure read and does not clear anything. That matters for a retried
// request: the same turn's payload is rebuilt from scratch, and the note has to
// come back unchanged — a `Text()` that consumed its input would make a retry send
// a different request than the attempt it replaces.
type Context struct {
	mu    sync.Mutex
	turn  []Part
	batch []Part
	// used counts the runes in play, so the total-budget check does not have to
	// re-measure everything on every append.
	used int
	// truncated records that something was cut for budget, so the audit can say so
	// once rather than per hook.
	truncated bool
}

// Part is one hook's contribution, kept with its source so the rendered block can
// say where it came from.
//
// It is a value rather than pre-rendered text and that is load-bearing: the block's
// wrapper is applied once, at the end, so a caller that collects parts from several
// events cannot end up with `<hook_context>` nested inside itself.
type Part struct {
	Hook  string
	Event Event
	Text  string
}

// Zero-value usability: a nil `*Context` is a legal "no hooks", and every method
// tolerates it. The callers hold the pointer from `runtime` and would otherwise
// need a nil check at each of them.

// AddTurn appends context that is good for the rest of this turn.
func (c *Context) AddTurn(hook string, event Event, text string) {
	c.AddTurnParts([]Part{{Hook: hook, Event: event, Text: text}})
}

// AddTurnParts is AddTurn for a whole chain's output.
func (c *Context) AddTurnParts(parts []Part) {
	c.add(parts, true)
}

// AddBatch appends context that is good until the next batch begins.
func (c *Context) AddBatch(hook string, event Event, text string) {
	c.AddBatchParts([]Part{{Hook: hook, Event: event, Text: text}})
}

// AddBatchParts is AddBatch for a whole chain's output.
func (c *Context) AddBatchParts(parts []Part) {
	c.add(parts, false)
}

func (c *Context) add(parts []Part, turn bool) {
	if c == nil || len(parts) == 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, part := range parts {
		text := strings.TrimSpace(part.Text)
		if text == "" {
			continue
		}
		clipped, truncated := clipContext(text, c.used)
		c.truncated = c.truncated || truncated
		if clipped == "" {
			continue
		}
		c.used += len([]rune(clipped))
		entry := Part{Hook: part.Hook, Event: part.Event, Text: clipped}
		if turn {
			c.turn = append(c.turn, entry)
			continue
		}
		c.batch = append(c.batch, entry)
	}
}

// ClearTurn drops the turn-scoped notes. Called when a turn ends.
//
// It clears the batch too: a batch note outliving its turn would be injected into a
// request that has nothing to do with the tool calls it describes.
func (c *Context) ClearTurn() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.turn = nil
	c.batch = nil
	c.used = 0
	c.truncated = false
}

// ClearBatch drops the batch-scoped notes. Called when a batch begins.
func (c *Context) ClearBatch() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	// Only what the batch added comes off the budget; the turn's own notes stay.
	released := 0
	for _, part := range c.batch {
		released += len([]rune(part.Text))
	}
	c.used -= released
	if c.used < 0 {
		c.used = 0
	}
	c.batch = nil
}

// Text renders the tail block, or "" when there is nothing to say.
//
// The order is Turn then Batch, which is the order they were produced in, and each
// part carries its source so a reader of the payload can tell which hook said what
// — including the model, which is why the marker is in the text rather than in a
// side table.
func (c *Context) Text() string {
	if c == nil {
		return ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.turn) == 0 && len(c.batch) == 0 {
		return ""
	}
	parts := make([]Part, 0, len(c.turn)+len(c.batch))
	parts = append(parts, c.turn...)
	parts = append(parts, c.batch...)
	return RenderContext(parts)
}

// Empty reports whether anything is currently injectable.
func (c *Context) Empty() bool {
	if c == nil {
		return true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.turn) == 0 && len(c.batch) == 0
}

// Truncated reports whether a contribution was cut for budget.
func (c *Context) Truncated() bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.truncated
}

// RenderContext turns parts into the block that goes in the payload tail.
//
// One element per hook, each wrapped in its own tag. The tag is the only thing that
// makes the block readable as **not** the user speaking: everything in this tail is
// appended as a `user` message, and an untagged paragraph of instructions would be
// indistinguishable from something a person typed.
func RenderContext(parts []Part) string {
	if len(parts) == 0 {
		return ""
	}
	var builder strings.Builder
	for _, part := range parts {
		text := strings.TrimSpace(part.Text)
		if text == "" {
			continue
		}
		if builder.Len() > 0 {
			builder.WriteString("\n")
		}
		builder.WriteString(`<hook_context source="`)
		builder.WriteString(string(part.Event))
		builder.WriteString(`" hook="`)
		builder.WriteString(part.Hook)
		builder.WriteString(`">` + "\n")
		builder.WriteString(text)
		builder.WriteString("\n</hook_context>")
	}
	return builder.String()
}

// clipContext enforces the two limits: one contribution, and everything in total.
//
// `used` is how many runes are already in play. A contribution that would cross the
// total limit is cut to what is left rather than dropped: a hook that says "the
// repository uses pnpm" in its first line still gets that line through even if
// something else filled the budget first.
func clipContext(text string, used int) (string, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", false
	}
	truncated := false
	if clipped, cut := clipText(text, ContextPartBytes); cut {
		text, truncated = clipped, true
	}
	room := ContextTotalChars - used
	if room <= 0 {
		return "", true
	}
	if count := len([]rune(text)); count > room {
		clipped, _, _ := clipRunes(text, room)
		return clipped, true
	}
	return text, truncated
}

// ContextPartBytes is one contribution's ceiling (8 KiB) and ContextTotalChars is
// everything a session may inject per request (32 KiB, counted in runes because the
// budget the request pays is measured in characters the model reads).
const (
	ContextPartBytes  = 8 * 1024
	ContextTotalChars = 32 * 1024
)

// PromptBlocked is what `RunTurn` returns when a `user_prompt_submit` hook refused
// the message.
//
// It is a distinct type because the front end does something different with it: the
// turn never happened, so nothing may be appended to the session and the person gets
// a notice rather than an empty answer. An empty answer would be a turn that ran and
// said nothing, which is a different — and false — story.
type PromptBlocked struct {
	Hook   string
	Reason string
}

func (e *PromptBlocked) Error() string {
	return "the prompt was refused by hook " + e.Hook + ": " + e.Reason
}
