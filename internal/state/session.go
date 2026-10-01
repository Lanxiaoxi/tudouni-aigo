package state

import (
	"runtime"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/prompts"
)

// Session is one conversation.
type Session struct {
	SessionID string
	Messages  []map[string]any
	Metadata  map[string]any
	// Context is the serialisable handle of the context ledger. The artifact
	// bodies are on disk; this holds references only, so a session file never
	// grows with the size of what the agent read.
	Context   any
	CreatedAt float64
	// Resumed reports whether this session was loaded from disk. It is a
	// property of this run, not of the file.
	Resumed bool
}

// NewSession creates a session with a freshly built system message.
//
// The system message is written once, here. That is why editing AGENT.md only
// affects sessions created afterwards: the prompt a session runs on is fixed at
// the moment the session starts.
//
// **The AGENT.md report is kept as well as the block**, under `agent_md` in the
// metadata. Two readers need it and neither can recover it from the prompt text:
// the startup notices ("which files went in, which were cut, which failed") and the
// rail's session block, which answers "did my AGENT.md take effect" long after the
// notice has scrolled away. Reading it from the session rather than from disk is
// what makes a restored session describe the prompt it actually carries.
func NewSession(sessionID, workspace string) *Session {
	session := NewEmptySession(sessionID)
	message, report := buildSystemMessage(workspace, runtime.GOOS)
	session.Messages = []map[string]any{message}
	if report.HasAnything() {
		session.Metadata[AgentMDSessionKey] = AgentMDToBlock(report)
	}
	return session
}

// NewEmptySession creates a session with no messages.
func NewEmptySession(sessionID string) *Session {
	return &Session{
		SessionID: sessionID,
		Messages:  []map[string]any{},
		Metadata:  map[string]any{},
	}
}

// StepCount counts assistant messages.
//
// It is the number of model round trips the session has made, which is what the
// interface shows as "steps".
func (s *Session) StepCount() int {
	count := 0
	for _, message := range s.Messages {
		if role, _ := message["role"].(string); role == "assistant" {
			count++
		}
	}
	return count
}

// Append adds one message.
func (s *Session) Append(message map[string]any) {
	s.Messages = append(s.Messages, message)
}

// UserInputs returns the text of every user message that came from a human.
//
// A handful of user-role messages are runtime notes ("the model changed, from
// here on it is Y") rather than things the user typed; they carry a marker so
// they can be told apart when something needs "what did the user actually ask".
func (s *Session) UserInputs() []string {
	var out []string
	for _, message := range s.Messages {
		role, _ := message["role"].(string)
		if role != "user" {
			continue
		}
		if isRuntimeNote(message) {
			continue
		}
		if text, ok := MessageText(message); ok {
			out = append(out, text)
		}
	}
	return out
}

// RuntimeNoteKey marks a user-role message the runtime inserted itself.
const RuntimeNoteKey = "__runtime_note"

// TurnOrigin is who opened the turn in progress.
//
// It is a value rather than a boolean because two callers ask the same scan two
// different questions, and answering the second with the first is how the
// automatic-round rule came to be written against the wrong fact. `IsHumanTurn`
// asks "may the model change the goal" — a person or not. The goal driver asks "was
// *this* turn an autonomous round" — an automatic round or not. A turn opened by a
// model change notice is neither, and only the three-valued answer says so.
type TurnOrigin int

const (
	// TurnOriginUnknown means nothing in the history decided the question: an empty
	// session, or one whose last word was the system prompt. Both callers read it as
	// "no authority and no round", which is the safe direction for a fact that could
	// not be established.
	TurnOriginUnknown TurnOrigin = iota
	// TurnOriginHuman means a person's own message opened the turn.
	TurnOriginHuman
	// TurnOriginAutomatic means the runtime's `<goal_round>` prompt opened it.
	TurnOriginAutomatic
	// TurnOriginRuntime means another runtime note opened it — today, the notice
	// that the model changed. It is not a person, and it is not a round.
	TurnOriginRuntime
)

// String names the origin, because a bare number in a failed assertion or an audit
// line is a number the reader has to go and look up.
func (o TurnOrigin) String() string {
	switch o {
	case TurnOriginHuman:
		return "human"
	case TurnOriginAutomatic:
		return "automatic"
	case TurnOriginRuntime:
		return "runtime"
	default:
		return "unknown"
	}
}

// TurnOrigin reports who opened the turn in progress.
//
// The rule is a backwards scan, and **the details are the whole function**:
//
//   - Tool results are skipped. A tool call is always issued from an assistant
//     message, so the current turn's results sit after the message that explains
//     why the turn started; stopping at the first one would answer "not human" for
//     every turn that used a tool before reaching for a goal tool.
//   - Assistant messages are skipped **for the same reason, one step further
//     out**. The model's own narration is not evidence about who asked — and it is
//     what a round that has finished ends on, which is why asking about the newest
//     message rather than about the turn is the question that keeps being wrong.
//   - A goal round prompt decides the scan as automatic. It carries RuntimeNoteKey
//     as well, so the marked check has to come first: the driver needs to know that
//     this turn was the round it queued, and "some runtime note" does not say that.
//   - Any other runtime note decides it as runtime. This is what makes an
//     autonomous goal round unable to authorize its own successor: without it a
//     round would land here and answer "a person asked", and the round budget would
//     stop meaning anything.
//   - Anything else decides it (and only a user message can be anything else in
//     practice — but the default is "unknown", because the one thing this scan must
//     never do is grant authority it cannot prove).
//
// A turn where the user's message is followed by assistant output and then by a
// goal tool call therefore answers `TurnOriginHuman`. That is correct: the person
// asked, and the model is one step into answering.
func (s *Session) TurnOrigin() TurnOrigin {
	for index := len(s.Messages) - 1; index >= 0; index-- {
		message := s.Messages[index]
		role, _ := message["role"].(string)
		switch role {
		case "tool", "assistant":
			continue
		}
		if IsGoalRound(message) {
			return TurnOriginAutomatic
		}
		if isRuntimeNote(message) {
			return TurnOriginRuntime
		}
		if role == "user" {
			return TurnOriginHuman
		}
		return TurnOriginUnknown
	}
	return TurnOriginUnknown
}

// IsHumanTurn reports whether the turn in progress was started by a person.
//
// It is what tells "the model is steering" apart from "the model is driving", and
// the goal tools depend on it: starting, redefining, pausing and resuming a goal
// are things only a person may ask for. The scan itself is `TurnOrigin`'s.
func (s *Session) IsHumanTurn() bool { return s.TurnOrigin() == TurnOriginHuman }

func isRuntimeNote(message map[string]any) bool {
	value, _ := message[RuntimeNoteKey].(bool)
	return value
}

// MessageText returns the plain text of a message.
//
// A message may carry a string or a list of content parts (the shape some
// gateways use, and the shape this program uses for a message with a picture in
// it). Both are accepted; anything else yields no text rather than an error,
// because a message with an unexpected shape should not stop a turn.
//
// **A picture is named, not dropped.** This function is what the session list's
// preview, the compaction skeleton and the interface's replay read a body through,
// and a body that quietly loses its image reads as a message that never had one —
// which is the difference between "the user sent a screenshot" and "the user sent a
// sentence". The label is the same one the model is shown, so a person reading the
// transcript sees what the model saw.
func MessageText(message map[string]any) (string, bool) {
	switch content := message["content"].(type) {
	case string:
		return content, true
	case []any:
		described := describeParts(content)
		if described == "" {
			return "", false
		}
		return described, true
	default:
		return "", false
	}
}

// describeParts joins a body's text and names its pictures.
//
// It walks the parts rather than going through `internal/content`, because this
// package is the session file's own format and the reading here has to stay total: a
// part whose shape nobody recognises contributes nothing rather than making the
// whole message unreadable.
func describeParts(parts []any) string {
	var pieces []string
	for _, item := range parts {
		part, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if text, ok := part["text"].(string); ok {
			pieces = append(pieces, text)
			continue
		}
		if kind, _ := part["type"].(string); kind == "image" {
			pieces = append(pieces, imagePartLabel(part))
		}
	}
	return strings.Join(pieces, "")
}

// imagePartLabel names one picture part for a reader who cannot see it.
//
// The dimensions are stated when they are known and omitted when they are not: a
// made-up `0×0` would read as a measured size, and the label is what a person uses to
// decide which picture is being discussed.
func imagePartLabel(part map[string]any) string {
	name, _ := part["name"].(string)
	if name == "" {
		name, _ = part["mime"].(string)
	}
	if name == "" {
		name = "image"
	}
	width, height := intOf(part["width"]), intOf(part["height"])
	if width > 0 && height > 0 {
		return "[Image: " + name + " " + itoa(width) + "×" + itoa(height) + "]"
	}
	return "[Image: " + name + "]"
}

// BuildSystemMessage assembles the system message for a new session.
//
// The order is by mutability, not by topic:
//
//  1. the static guidance, which never changes;
//  2. the environment (which operating system), which is stable for the life
//     of the install;
//  3. the AGENT.md block, which is the only part a person edits by hand.
//
// Putting the mutable part last means editing it invalidates only the tail of
// the prompt instead of every token after it.
//
// This is the entry point for callers that only want the message. `NewSession` uses
// `buildSystemMessage` directly, because it has to keep the AGENT.md report as well —
// see the note there.
func BuildSystemMessage(workspace, osName string) map[string]any {
	message, _ := buildSystemMessage(workspace, osName)
	return message
}

// buildSystemMessage is BuildSystemMessage plus the AGENT.md report it read.
//
// The report is returned rather than looked up again because reading the file twice
// would be two answers to "what is in this session's prompt": the file can change
// between the two reads, and the notice would then describe a prompt the session does
// not carry.
func buildSystemMessage(workspace, osName string) (map[string]any, AgentMDReport) {
	body := prompts.System()
	if body == "" {
		body = i18nFallbackPrompt
	}

	var env strings.Builder
	env.WriteString("\n\n---\n\n")
	env.WriteString("# 运行环境\n\n")
	env.WriteString("- 操作系统：" + osName + "\n")

	text, report := LoadAgentMD(workspace)
	block := AgentMDTextBlock(text, report)
	if block != "" {
		env.WriteString("\n")
		env.WriteString(block)
	}

	return map[string]any{
		"role":    "system",
		"content": body + env.String(),
	}, report
}

// i18nFallbackPrompt is used only when the prompt file cannot be found at all.
// That is a packaging failure, not a normal condition; saying something is
// better than sending an empty system message, and the startup notice explains
// what happened.
const i18nFallbackPrompt = "你是 agent runtime 中的执行助手。"
