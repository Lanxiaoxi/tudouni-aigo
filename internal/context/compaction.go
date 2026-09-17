package context

import (
	"fmt"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/prompts"
)

// History compaction: an older stretch of detail becomes a working memory.
//
// It is not the same thing as degradation. Budget degrades **artifacts** — how
// much of a tool result fits in this request. Compaction touches **history
// itself** — which messages still appear in full. They answer different
// questions:
//
//	Budget      "this information, how much of it this time?"
//	Compaction  "this stretch of history, does it still need to be verbatim?"
//
// So its place on the ladder is one rung past degradation: when every artifact
// sits at metadata and it still does not fit, what is actually over the window
// is the pile of messages — and the only room left is folding old history away.
//
// Three principles, and every judgement in this file follows from them:
//
//  1. **It compacts history, not the current working state.** A summary has to
//     answer "what am I doing, what have I done, what did I find, what did I
//     decide, what is left" — that is what the model needs to keep working.
//  2. **Recent information is not compacted.** The last few steps are what the
//     model is reasoning about; they stay verbatim.
//  3. **The original history still exists.** This file does not touch
//     `session.messages` — not one byte. It only answers "fold up to here" and
//     "what is the summary", and the rendering side substitutes accordingly:
//
//     full history = the archive (the session file)
//     summary      = working memory (one artifact)
//     recent       = current attention (the messages kept verbatim)
//
//     The cost is on the record: the session file and `--history` do not shrink
//     when this runs. Saving tokens and saving disk are two different things.
//
// The boundary has to land on a `user` message. The provider requires every
// tool_calls to have a paired result, and cutting mid-turn produces a payload
// that cannot be sent — a 400 that reads like "context too long". A user message
// is always the mark of "the previous turn finished cleanly".

const (
	// CompactionKey is the metadata key. It sits at the same level as
	// model_selection (facts about the session) rather than inside ContextState,
	// because that block is only written when its version moves, and a change of
	// fold boundary should not slip through that gate.
	CompactionKey = "context_compaction"

	// BlockVersion describes the meaning of the fields in that key. It is
	// independent of the session file's own version: this one is "what does this
	// block mean". When the meaning changes, an old session should degrade to
	// "never compacted" rather than become unopenable.
	BlockVersion = 1

	// SummaryHeader says how the fold boundary is put to the model. It has to be
	// self-explanatory: the model should read "earlier conversation was replaced
	// by a summary", not "the session starts here".
	SummaryHeader = "【历史摘要】（以下是较早对话的压缩结果，更早的原文不在本次上下文里）"

	// KeepRecentMessages is how many of the most recent messages stay verbatim.
	// Counted in messages rather than tokens: tokens are estimated, while "the
	// last few turns" is a count by nature. Twelve is about six exchanges.
	KeepRecentMessages = 12

	// MinFoldMessages is the smallest fold worth doing. It blocks "compacting for
	// nothing": folding two messages costs a round trip and invalidates the
	// prefix cache — a net loss.
	MinFoldMessages = 8

	// DigestMaxChars caps the skeleton handed to the summarising model. Over the
	// cap, the **earliest** part is dropped (the latest stays) and the count is
	// stated: what happened recently matters more for "current state".
	DigestMaxChars = 24_000

	// DigestArgsChars caps one tool call's arguments. An argument can be an
	// entire file body (write_file), and what the summary needs is what changed,
	// not the whole text.
	DigestArgsChars = 160
)

// Compaction is how far this session has been folded. It is the sole carrier of
// "the summary plus the boundary".
//
// FoldedMessages is a **message count**, not an index: it is the same measure as
// the store's high-water mark ("the first N are folded into the summary"), and
// the next compaction continues from there — which is the entire basis for
// incremental folding.
//
// SummaryID points at an artifact. **Old summaries are not deleted**: each
// compaction produces a new one (with a different content-addressed id) and the
// old ones stay in the store — that is what "archive" means concretely, and it
// is the only way to see afterwards how the summary became what it is.
type Compaction struct {
	FoldedMessages int
	SummaryID      string
	Generation     int
	UpdatedAt      float64
}

// Active reports whether anything was folded and the summary is still there —
// both conditions, not either.
//
// A boundary with no summary (somebody deleted the body) is not active: then
// rendering falls back to sending history verbatim, which is safer than
// announcing a missing summary (that would make the model believe history was
// cleared).
func (c Compaction) Active() bool {
	return c.FoldedMessages > 0 && c.SummaryID != ""
}

// LoadCompaction reads the state out of session metadata. Unreadable is "not
// compacted", never an error.
//
// An old session file has no such key, and a broken key must not make a session
// unopenable — the same rule the model selection and the AGENT.md block follow.
func LoadCompaction(metadata map[string]any) (Compaction, bool) {
	if metadata == nil {
		return Compaction{}, false
	}
	return CompactionFromBlock(metadata[CompactionKey])
}

// StoreCompaction writes the state into session metadata. It does not write to
// disk — that is the checkpoint's job.
func StoreCompaction(metadata map[string]any, state Compaction) Compaction {
	if metadata != nil {
		metadata[CompactionKey] = CompactionToBlock(state)
	}
	return state
}

// CompactionToBlock is the stored shape.
func CompactionToBlock(state Compaction) map[string]any {
	return map[string]any{
		"version":         BlockVersion,
		"folded_messages": state.FoldedMessages,
		"summary_id":      state.SummaryID,
		"generation":      state.Generation,
		"updated_at":      state.UpdatedAt,
	}
}

// CompactionFromBlock is the read side. Unreadable yields false.
func CompactionFromBlock(block any) (Compaction, bool) {
	object, ok := block.(map[string]any)
	if !ok {
		return Compaction{}, false
	}
	folded := intOf(object["folded_messages"])
	if folded <= 0 {
		// Zero folded means never compacted. An "empty Compaction" is not
		// returned, because callers test "is there state at all" and a non-nil
		// empty value would answer yes.
		return Compaction{}, false
	}
	return Compaction{
		FoldedMessages: folded,
		SummaryID:      textOf(object["summary_id"]),
		Generation:     intOf(object["generation"]),
		UpdatedAt:      floatOf(object["updated_at"]),
	}, true
}

// --- boundary ---------------------------------------------------------------

// FirstUserIndex is where the first user message is. -1 when there is none.
func FirstUserIndex(messages []map[string]any) int {
	for index, message := range messages {
		if message["role"] == "user" {
			return index
		}
	}
	return -1
}

// FoldPoint is how far to fold, half-open: fold `[0, result)`.
//
// Zero means nothing gets folded this time (history too short, or no legal
// boundary). The conditions, in priority order:
//
//  1. the folded stretch needs at least MinFoldMessages, and at least
//     KeepRecentMessages have to remain after it;
//  2. the boundary must land on a **user** message;
//  3. it may not cross the first user message (that position stays verbatim);
//  4. it has to be further along than last time, or this compaction adds nothing
//     and regenerating an identical summary is a wasted model call.
//
// ## How the boundary is chosen (two stages, and the order matters)
//
// **Stage one: position.** Take `upper = total - KeepRecentMessages`, the line
// that keeps only the last KeepRecentMessages. That decides how much gets
// folded: folding more means less verbatim history for the model to carry, and
// the summary's round trip costs the same either way. The other direction —
// "fold as little as possible, just enough to fit" — buys a few percent of
// headroom per compaction while the summary costs full price every time.
// Measured: folding 5 of 49 messages produced a summary more expensive than the
// messages it replaced.
//
// **Stage two: alignment.** `upper` may not land on a user message, and the
// boundary must. So walk **backwards** from `upper` to the latest user message —
// the start of the most recent complete turn:
//
//	fold here ↓
//	[ folded history ][user first kept turn][assistant][tool]…[newest]
//
// Why a complete turn rather than "stop once enough messages are kept": an
// assistant's tool_calls and the tool results that follow are a **pair**, and
// cutting between them leaves a message with tool_calls and no result, which the
// provider rejects with a 400 that reads like "context too long". Walking back a
// few steps keeps a few more messages verbatim, which is far cheaper.
//
// Taking the **latest** such user message rather than the earliest: recent
// information should stay verbatim, and "fold as much as legally possible"
// follows from that.
func FoldPoint(messages []map[string]any, folded int) int {
	total := len(messages)
	upper := total - KeepRecentMessages
	if folded < 0 {
		folded = 0
	}
	if upper-folded < MinFoldMessages {
		return 0
	}

	floor := folded
	if first := FirstUserIndex(messages) + 1; first > floor {
		floor = first
	}
	if floor < 1 {
		floor = 1
	}

	for index := upper - 1; index >= floor; index-- {
		if messages[index]["role"] == "user" {
			return index
		}
	}
	return 0
}

// --- skeleton fed to the summarising model ----------------------------------

// DigestMessages flattens the stretch that is about to be folded: it is written
// **for the summarising model, not for a person**.
//
// `[start, stop)` is the stretch.
//
// ## Why tool results are not included
//
// Two reasons pointing the same way:
//
//   - **It does not need them.** The summary has to say what happened, what was
//     found and what was decided, and none of those live in the 120k characters
//     a read_file returned — they live in the model's own sentence "I confirmed
//     X", and that sentence is already in the skeleton.
//   - **Including them defeats the purpose.** Folding a 200k-token stretch would
//     require reading 200k tokens of body, and the point of compaction is to
//     make that stretch cheap. Reading everything to write a summary buys
//     nothing but another bill.
//
// So a tool result contributes only its **reference** line
// (`[artifact art_x · 12480 字符 · read_file]`), which already carries "there
// was something this big here".
//
// ## What gets dropped is the earliest part
//
// Over the limit, the cut comes off the **front**, because "current state" and
// "next step" depend on what happened recently. How many messages were dropped
// is stated up front: with no note, "I am missing a stretch" and "that stretch
// was uneventful" look identical.
func DigestMessages(messages []map[string]any, start int, stop *int, limit int) string {
	blocks := []string{}
	used := 0

	end := len(messages)
	if stop != nil {
		end = *stop
		if end > len(messages) {
			end = len(messages)
		}
		if end < start {
			end = start
		}
	}
	keptFrom := end

	for index := end - 1; index >= start; index-- {
		block := DescribeMessage(messages[index])
		if block == "" {
			keptFrom = index
			continue
		}
		if used+runeLen(block) > limit && len(blocks) > 0 {
			break
		}
		blocks = append(blocks, block)
		used += runeLen(block)
		keptFrom = index
	}

	// Collected backwards, so put it back in order.
	for left, right := 0, len(blocks)-1; left < right; left, right = left+1, right-1 {
		blocks[left], blocks[right] = blocks[right], blocks[left]
	}

	head := ""
	if dropped := keptFrom - start; dropped > 0 {
		head = fmt.Sprintf("（更早的 %d 条消息没有列在这里 —— 它们发生得更早，而这一段骨架只保留最近的部分）\n", dropped)
	}
	return head + strings.Join(blocks, "\n")
}

// DescribeMessage is how one history message appears in the skeleton. An empty
// string means it need not appear.
//
// Four classes, each keeping what it should:
//
//   - **user** verbatim — what the person said is a fact that matters, and
//     condensing it is the summary's own job;
//   - **assistant** verbatim, plus which tools it called (name and an argument
//     preview);
//   - **tool** only the reference line;
//   - anything else (a system aside like `[model changed: …]`) as-is.
func DescribeMessage(message map[string]any) string {
	role, _ := message["role"].(string)
	text, _ := message["content"].(string)

	if role == "tool" {
		if text == "" {
			return ""
		}
		return "[工具结果] " + firstLine(text)
	}

	label := "[" + role + "]"
	switch role {
	case "user":
		label = "[用户]"
	case "assistant":
		label = "[助手]"
	case "system":
		label = "[系统]"
	}

	parts := []string{}
	if text != "" {
		parts = append(parts, strings.TrimRight(label+" "+text, " \t\n"))
	}
	if calls, ok := message["tool_calls"].([]any); ok {
		for _, entry := range calls {
			call, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			name, arguments := "", ""
			if function, ok := call["function"].(map[string]any); ok {
				name, _ = function["name"].(string)
				arguments, _ = function["arguments"].(string)
			} else if raw, ok := call["name"].(string); ok {
				name = raw
				arguments, _ = call["arguments"].(string)
			}
			parts = append(parts, "  → 调用 "+name+"("+clipFlat(arguments, DigestArgsChars)+")")
		}
	}

	kept := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, "\n")
}

func firstLine(text string) string {
	line := text
	if index := strings.Index(text, "\n"); index >= 0 {
		line = text[:index]
	}
	return clipFlat(line, DigestArgsChars)
}

// clipFlat collapses whitespace and cuts to a limit.
func clipFlat(text string, limit int) string {
	flat := strings.Join(strings.Fields(text), " ")
	if runeLen(flat) <= limit {
		return flat
	}
	return truncateRunes(flat, limit) + "…"
}

// --- rendering --------------------------------------------------------------

// SummaryMessage is what the summary message looks like. **It is a plain user
// message.**
//
// Not a system message: the folded stretch contained things the user and the
// assistant said, and turning those into one system message would falsify "who
// is speaking" for that whole stretch — a model reading "the system asks me to
// analyse this project" and "the user asks me to analyse this project" are two
// different situations. A user message is also shape-identical to the user
// message it replaces (the original first user message occupied this position
// anyway).
func SummaryMessage(text string) map[string]any {
	return map[string]any{
		"role":    "user",
		"content": SummaryHeader + "\n\n" + strings.TrimSpace(text),
	}
}

// Attention is the history this request actually looks at: system prompt,
// summary, and the messages that were not folded.
//
// ## Why the system prompt is pulled out separately
//
// It is `messages[0]` (written once by Session.New), and the folded stretch is
// `[0, folded)` — the two overlap numerically. **It has to stay in the
// payload**, for three reasons, each harder than the last:
//
//   - it is the whole session's behaviour contract ("only use the tools
//     provided", "verify after writing"); without it the model behaves
//     differently;
//   - it is marked pinned precisely because it is the first system message, and
//     that judgement presumes it really is in history;
//   - the renderer passes it through untouched and tool_calls pairing has
//     nothing to do with it.
//
// So the folded stretch **never contains it**, and this function (rather than
// the caller) guarantees that: the caller should only know "fold up to here",
// while "the system prompt may not be folded away" is this module's boundary
// rule.
//
// With `folded <= 0` it returns the list unchanged, so an uncompacted session
// takes a path byte-identical to before compaction existed.
func Attention(messages []map[string]any, folded int) []map[string]any {
	if folded <= 0 {
		return messages
	}
	head := 0
	if len(messages) > 0 && messages[0]["role"] == "system" {
		head = 1
	}
	start := folded
	if start > len(messages) {
		start = len(messages)
	}
	view := make([]map[string]any, 0, head+len(messages)-start)
	view = append(view, messages[:head]...)
	view = append(view, messages[start:]...)
	return view
}

// FoldedView is what actually goes out after folding:
//
//	[system, summary(user), unfolded history…]
//
// The summary comes **after** the system prompt: that is the first message of
// the whole request (and the only section that reliably hits the prefix cache),
// while a summary is a statement about the past — there is no reason for it to
// precede the behaviour contract. The payload thus reads "contract → memory →
// recent", the order a person reads a conversation in.
//
// `summary == nil` gives exactly Attention's result, so that path is
// byte-identical to before compaction existed.
func FoldedView(messages []map[string]any, folded int, summary map[string]any) []map[string]any {
	view := Attention(messages, folded)
	if summary == nil {
		return view
	}
	head := 0
	if len(view) > 0 && view[0]["role"] == "system" {
		head = 1
	}
	result := make([]map[string]any, 0, len(view)+1)
	result = append(result, view[:head]...)
	result = append(result, summary)
	result = append(result, view[head:]...)
	return result
}

// SummaryText is the summary's body. Unavailable yields false, and the caller
// says so — see MissingSummary.
func SummaryText(store *ArtifactStore, state Compaction) (string, bool) {
	if state.SummaryID == "" {
		return "", false
	}
	text, ok := store.Content(state.SummaryID)
	if !ok || text == "" {
		return "", false
	}
	return text, true
}

// MissingSummary is the line the payload carries when the summary's body is
// gone (somebody deleted the artifact directory).
//
// Not an empty string. Empty reads as "nothing happened in that whole stretch",
// which is wrong — it lets the model cheerfully redo work it already did. Saying
// how many messages were folded and where to look is what gets a useful
// response.
func MissingSummary(state Compaction) string {
	return fmt.Sprintf("%s\n\n（摘要正文已经取不到了，它原本概括了最早的 %d 条消息。如果需要那段细节，请让用户重新读一次相关文件，或者查看会话文件。）",
		SummaryHeader, state.FoldedMessages)
}

// CompactionPrompt reads the summarising prompt from the embedded package.
//
// It travels with the code rather than with the workspace: this prompt describes
// how to summarise this agent's memory, so it has the same owner as
// `prompts/system.zh.md`. A workspace's AGENT.md is somebody else's text.
func CompactionPrompt() string {
	return prompts.Compact()
}
