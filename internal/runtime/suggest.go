package runtime

import (
	"context"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/usage"
)

// Suggested replies: after a turn the person started ends with an answer, one
// small side request asks the session's model what the person is likely to say
// next, and the front end draws the answers as buttons.
//
// **It is a feature of the program, not part of the conversation.** Nothing here
// touches the session's messages, the context window or the agent loop: the
// request is built from two strings (the person's last message and the final
// answer), goes out through `CompleteOneShot` — which writes neither the
// adapter's reasoning knobs nor the process-wide endpoint memories a turn reads —
// and its answer goes to the interface only. A click is the person sending that
// sentence, and it is approved like anything else they type.

// Limits on what the side request sees and what it may produce.
const (
	// suggestPromptRunes and suggestAnswerRunes bound the input. The answer keeps
	// its **tail**: the offer worth turning into a button ("want me to push?") is
	// where an answer ends, and the head is usually the work it reports on.
	suggestPromptRunes = 2000
	suggestAnswerRunes = 6000
	// MaxSuggestedReplies is the ceiling the person chose. The model is told it
	// and the parser enforces it: an instruction is a request, not a limit.
	MaxSuggestedReplies = 3
	// suggestReplyRunes caps one button. A longer "reply" is a paragraph, and a
	// paragraph is not something a person would send by clicking.
	suggestReplyRunes = 60
)

// suggestInstruction is the side request's whole system prompt.
const suggestInstruction = `You write quick-reply buttons for a coding assistant's chat window.
You are given the user's last message and the assistant's final reply. Predict what the user is most likely to send next, as short messages they could send with one click.

Rules:
- Only suggest a reply when the assistant's reply ends with a clear, concrete next step the user is likely to accept (for example the assistant offers to push, run the tests, build the installer, apply a change it proposed).
- Only affirmative next actions. Never suggest declining, waiting, "not now", thanks, or questions about what was done: not clicking already means no.
- At most 3, ordered by likelihood. Each one is a short message in the user's own language (the language of the user's message), under 30 characters where possible, written as the user speaking to the assistant.
- When there is no obvious next step, return an empty list. An empty list is the common, correct answer.

Answer with a JSON array of strings and nothing else, for example ["push 吧"] or [].`

// oneShotModel is what the session's adapter must offer for suggestions to run.
//
// Asserted rather than added to model.ChatModel: a test adapter, or any future
// adapter without an isolated path, simply gets no suggestions, which is the
// fail-closed reading — the alternative would be falling back to `Complete`,
// which is exactly the shared path this feature must not use.
type oneShotModel interface {
	CompleteOneShot(ctx context.Context, messages []map[string]any) (model.ModelResponse, error)
}

// SuggestReplies asks the session's model for up to three next messages.
//
// It returns an empty list, not an error, for "nothing worth suggesting" — that
// is the expected answer for most turns. An error means the request failed or
// came back unreadable, and the caller shows nothing either way.
//
// It is safe to call while a turn runs: it reads the route once through the
// adapter's own lock and writes nothing shared except the two append-only sinks,
// which are locked themselves.
func (r *Runtime) SuggestReplies(ctx context.Context, runID, prompt, answer string) ([]string, error) {
	chat, ok := r.Chat.(oneShotModel)
	if !ok || r.Chat == nil {
		return nil, errorf("this model adapter has no isolated request path")
	}
	prompt = strings.TrimSpace(prompt)
	answer = strings.TrimSpace(answer)
	if prompt == "" || answer == "" {
		return nil, nil
	}

	messages := []map[string]any{
		{"role": "system", "content": suggestInstruction},
		{"role": "user", "content": "<user_message>\n" + headRunes(prompt, suggestPromptRunes) +
			"\n</user_message>\n\n<assistant_reply>\n" + tailRunes(answer, suggestAnswerRunes) +
			"\n</assistant_reply>"},
	}

	started := time.Now()
	response, err := chat.CompleteOneShot(ctx, messages)
	durationMs := time.Since(started).Milliseconds()
	if err != nil {
		return nil, err
	}
	r.recordSuggestionCall(runID, response.Usage, durationMs)

	content := ""
	if response.Content != nil {
		content = *response.Content
	}
	return parseSuggestedReplies(content)
}

// recordSuggestionCall books the side request's spend.
//
// It goes to the two sinks directly rather than through `onEvent`, because
// `onEvent` also forwards to the front end as a transcript event, and a request
// that is not part of the conversation must not draw a row in it. The audit
// record has a kind of its own so `/status` (which folds `model_call`) keeps
// describing the conversation, and the ledger files it as its own row kind.
func (r *Runtime) recordSuggestionCall(runID string, spent *model.TokenUsage, durationMs int64) {
	data := map[string]any{
		"status":      "ok",
		"duration_ms": durationMs,
		"model":       r.Chat.ModelName(),
	}
	if spent != nil {
		data["prompt_tokens"] = spent.PromptTokens
		data["cached_tokens"] = spent.CachedTokens
		data["miss_tokens"] = spent.MissTokens()
		data["completion_tokens"] = spent.CompletionTokens
	}
	record := audit.Event(usage.KindSuggestionCall, r.SessionIDValue, runID, 0, data)
	if r.Logs != nil {
		if err := r.Logs.Write(record); err != nil {
			warn("audit write failed: %v", err)
		}
	}
	if r.Usage != nil {
		r.Usage.Observe(record)
	}
}

// parseSuggestedReplies reads the model's JSON array, defensively.
//
// The array is cut out of whatever surrounds it (a code fence, a sentence of
// preamble) because models add those even when told not to; anything that is not
// an array of strings is an error, not a guess. Each entry is trimmed, deduped,
// capped in length and the list is capped at MaxSuggestedReplies.
func parseSuggestedReplies(content string) ([]string, error) {
	start := strings.Index(content, "[")
	end := strings.LastIndex(content, "]")
	if start < 0 || end < start {
		return nil, errorf("the suggestion answer is not a JSON array")
	}
	var raw []string
	if err := json.Unmarshal([]byte(content[start:end+1]), &raw); err != nil {
		return nil, errorf("the suggestion answer is not a JSON array of strings: %v", err)
	}
	out := make([]string, 0, MaxSuggestedReplies)
	seen := map[string]bool{}
	for _, item := range raw {
		// One line: a newline inside a button is a paragraph in disguise.
		text := strings.Join(strings.Fields(item), " ")
		if text == "" || utf8.RuneCountInString(text) > suggestReplyRunes || seen[text] {
			continue
		}
		seen[text] = true
		out = append(out, text)
		if len(out) == MaxSuggestedReplies {
			break
		}
	}
	return out, nil
}

// headRunes keeps the first n runes of s.
func headRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}

// tailRunes keeps the last n runes of s.
func tailRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return "…" + string(runes[len(runes)-n:])
}
