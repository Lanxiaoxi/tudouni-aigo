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
func NewSession(sessionID, workspace string) *Session {
	session := NewEmptySession(sessionID)
	osName := runtime.GOOS
	session.Messages = []map[string]any{BuildSystemMessage(workspace, osName)}
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
func BuildSystemMessage(workspace, osName string) map[string]any {
	body := prompts.System()
	if body == "" {
		body = i18nFallbackPrompt
	}

	var env strings.Builder
	env.WriteString("\n\n---\n\n")
	env.WriteString("# 运行环境\n\n")
	env.WriteString("- 操作系统：" + osName + "\n")

	block := AgentMDBlock(workspace)
	if block != "" {
		env.WriteString("\n")
		env.WriteString(block)
	}

	return map[string]any{
		"role":    "system",
		"content": body + env.String(),
	}
}

// i18nFallbackPrompt is used only when the prompt file cannot be found at all.
// That is a packaging failure, not a normal condition; saying something is
// better than sending an empty system message, and the startup notice explains
// what happened.
const i18nFallbackPrompt = "你是 agent runtime 中的执行助手。"

// AgentMDNotes describes what happened to this session's AGENT.md, read back
// from the session rather than from disk.
//
// Reading it from the session is the point: when an old session is restored, the
// report has to describe the prompt that session actually carries, not whatever
// the file says today.
func AgentMDNotes(session *Session, relativeTo string) []map[string]any {
	raw, ok := session.Metadata[AgentMDSessionKey]
	if !ok {
		return nil
	}
	records, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(records))
	for _, item := range records {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, record)
	}
	return out
}
