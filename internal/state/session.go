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

// IsHumanTurn reports whether the turn in progress was started by a person.
//
// It is what tells "the model is steering" apart from "the model is driving", and
// the goal tools depend on it: starting, redefining, pausing and resuming a goal
// are things only a person may ask for.
//
// The rule is a backwards scan, and **the details are the whole function**:
//
//   - Tool results are skipped. A tool call is always issued from an assistant
//     message, so the current turn's results sit after the message that explains
//     why the turn started; stopping at the first one would answer "not human" for
//     every turn that used a tool before reaching for a goal tool.
//   - Assistant messages are skipped **for the same reason, one step further
//     out**. The model's own narration is not evidence about who asked.
//   - A runtime note ends the scan as "not human". This is what makes an autonomous
//     goal round answer false, and it is the reason round prompts carry
//     RuntimeNoteKey at all: without it a round could authorize its own successor,
//     and the round budget would stop meaning anything.
//   - Anything else decides it (and only a user message can be anything else in
//     practice — but the default is "not human", because the one thing this
//     function must never do is grant authority it cannot prove).
//
// A turn where the user's message is followed by assistant output and then by a
// goal tool call therefore answers true. That is correct: the person asked, and the
// model is one step into answering.
func (s *Session) IsHumanTurn() bool {
	for index := len(s.Messages) - 1; index >= 0; index-- {
		message := s.Messages[index]
		role, _ := message["role"].(string)
		switch role {
		case "tool", "assistant":
			continue
		}
		if isRuntimeNote(message) {
			return false
		}
		return role == "user"
	}
	return false
}

func isRuntimeNote(message map[string]any) bool {
	value, _ := message[RuntimeNoteKey].(bool)
	return value
}

// MessageText returns the plain text of a message.
//
// A message may carry a string or a list of content parts (the shape some
// gateways use). Both are accepted; anything else yields no text rather than an
// error, because a message with an unexpected shape should not stop a turn.
func MessageText(message map[string]any) (string, bool) {
	switch content := message["content"].(type) {
	case string:
		return content, true
	case []any:
		var parts []string
		for _, item := range content {
			part, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := part["text"].(string); ok {
				parts = append(parts, text)
			}
		}
		if len(parts) == 0 {
			return "", false
		}
		return strings.Join(parts, ""), true
	default:
		return "", false
	}
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
