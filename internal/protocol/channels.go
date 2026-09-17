package protocol

import (
	"sync"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
)

// Channels is how a runtime reaches the person on the other side.
//
// It is an interface, not a direct call, and that is constraint number one of this
// rewrite: the runtime must not be able to tell whether the other end is a parent
// process reading a pipe, a socket, or a test harness. The moment the runtime can
// call the front end directly, the boundary stops being a boundary and the tests
// stop being able to replace it.
type Channels struct {
	// Questioner answers `ask_user`. It blocks on a person, and it is nil when
	// there is nobody to ask.
	Questioner Questioner
	// AskerFactory builds the approval function for one runtime, given that
	// runtime's approval memory and trust-group lookup.
	AskerFactory AskerFactory
	// MemoryFactory is unused by the protocol implementation, which keeps one
	// memory on the runtime; it exists so a different front end can supply one.
	MemoryFactory MemoryFactory
}

// Questioner is how the agent asks a person something.
type Questioner func(args AskUserArgs) Answer

// AskUserArgs is one question.
type AskUserArgs struct {
	Question    string
	Header      string
	Options     []string
	MultiSelect bool
}

// Answer is what came back.
type Answer struct {
	Text string
	// Status is one of answered / skipped / unavailable.
	Status string
	// HumanWaitMs is how long the person took, when that is knowable.
	HumanWaitMs int
}

// Statuses an answer can carry. Only the first two are ever returned by a front
// end; `unavailable` is produced by the runtime when there is nobody to ask.
const (
	AnswerAnswered    = "answered"
	AnswerSkipped     = "skipped"
	AnswerUnavailable = "unavailable"
)

// AskerFactory builds the approval function for one runtime.
type AskerFactory func(memory *security.Memory, trust security.TrustGroupLookup) security.AskFunc

// MemoryFactory builds an approval memory.
type MemoryFactory func() *security.Memory

// pendingTable holds the requests that block until a front end answers.
//
// Two kinds travel through it (approval and question) and they share one table
// because they share one lifecycle: a request is created, the turn blocks on it,
// and exactly one answer releases it. Two tables would mean two places to abandon
// on shutdown, and forgetting one leaves a goroutine waiting forever.
type pendingTable struct {
	mu      sync.Mutex
	waiters map[string]*waiter
	nextID  int
}

type waiter struct {
	id      string
	done    chan struct{}
	answer  any
	abandon bool
}

func newPendingTable() *pendingTable {
	return &pendingTable{waiters: map[string]*waiter{}}
}

func (t *pendingTable) open(prefix string) *waiter {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.nextID++
	entry := &waiter{id: prefix + "-" + itoa(t.nextID), done: make(chan struct{})}
	t.waiters[entry.id] = entry
	return entry
}

// Resolve releases one waiter. An unknown id is ignored rather than an error: a
// front end may answer a request that was already abandoned.
func (t *pendingTable) resolve(id string, answer any) {
	t.mu.Lock()
	entry, ok := t.waiters[id]
	if ok {
		delete(t.waiters, id)
	}
	t.mu.Unlock()
	if !ok {
		return
	}
	entry.answer = answer
	close(entry.done)
}

// abandonAll wakes every waiter with no answer.
//
// It runs before the read loop exits. Without it the last approval stays blocked
// forever: the front end is gone, so nothing will ever answer it, and the child
// process never exits — which looks like a hang, not like a bug.
func (t *pendingTable) abandonAll() {
	t.mu.Lock()
	entries := make([]*waiter, 0, len(t.waiters))
	for id, entry := range t.waiters {
		entries = append(entries, entry)
		delete(t.waiters, id)
	}
	t.mu.Unlock()
	for _, entry := range entries {
		entry.abandon = true
		close(entry.done)
	}
}

// Wait blocks until the request is answered or the channel goes away.
func (t *pendingTable) wait(entry *waiter) (any, bool) {
	if entry == nil {
		return nil, false
	}
	<-entry.done
	if entry.abandon || entry.answer == nil {
		// No answer means "could not ask", never "the answer is empty". A front
		// end that treats an empty string as "the user had no opinion" is exactly
		// the mistake this distinction prevents.
		return nil, false
	}
	return entry.answer, true
}

// questionAnswer is a resolved question.
type questionAnswer struct {
	status string
	text   string
}

// askUser opens a question and blocks on it.
func (s *Server) askUser(args AskUserArgs) Answer {
	entry := s.pending.open("q")

	options := args.Options
	if options == nil {
		options = []string{}
	}
	s.Send(map[string]any{
		"v": VERSION, "t": OutQuestionRequest,
		"id": entry.id, "question": args.Question, "header": args.Header,
		"options": options, "multi_select": args.MultiSelect,
	})

	raw, ok := s.pending.wait(entry)
	if !ok {
		return Answer{Status: AnswerUnavailable}
	}
	answer, ok := raw.(questionAnswer)
	if !ok {
		return Answer{Status: AnswerUnavailable}
	}
	return Answer{Text: answer.text, Status: answer.status}
}

// askPermission opens an approval request and blocks on it.
//
// The returned function writes what the user chose into the approval memory itself
// and returns a boolean. Keeping the return type a boolean is what lets the gate
// record "an approval that also changed future behaviour" by comparing snapshots
// taken before and after — see security.Check.
func (s *Server) askPermission(memory *security.Memory, trust security.TrustGroupLookup) security.AskFunc {
	return func(toolName string, risk security.RiskLevel, arguments map[string]any) bool {
		entry := s.pending.open("p")

		// remembered tells the front end what pressing `t` would write. When it is
		// nil the button must not be shown at all: offering "always allow" with
		// nothing to remember is a key that looks like it worked and changes
		// nothing.
		var remembered any
		rememberHint := ""
		if memory != nil {
			if _, isCommand := security.CommandParameter(toolName); !isCommand {
				remembered = map[string]any{"tool": toolName}
				rememberHint = security.RememberHint(risk, nil, toolName, memory.Label)
			} else if command, ok := security.CommandOf(toolName, arguments); ok {
				if prefix, ok := security.SuggestPrefix(command, isWindowsPlatform()); ok {
					list := make([]any, 0, len(prefix))
					for _, token := range prefix {
						list = append(list, token)
					}
					remembered = map[string]any{"prefix": list}
					rememberHint = security.RememberHint(risk, prefix, "", memory.Label)
				}
			}
		}

		// A trust group is released as a snapshot of names: the tools the server
		// offers right now. Anything it adds later still gets asked about, which is
		// the difference between "this server is fine from now on" and what the
		// button actually does.
		var group *security.TrustGroup
		if memory != nil && trust != nil {
			if found, ok := trust(toolName); ok {
				group = &found
			}
		}

		var trustAllHint any
		if group != nil {
			trustAllHint = security.TrustAllHint(*group, memory.Label)
		}

		s.Send(map[string]any{
			"v": VERSION, "t": OutPermissionRequest,
			"id": entry.id, "call_id": s.currentCallID(),
			"tool": toolName, "risk": string(risk),
			// The arguments go out whole, never truncated. This is not a field
			// accompanying an event; it is the material a person decides on. The
			// dangerous half of a shell command is usually the second half.
			"arguments":       arguments,
			"remember":        remembered,
			"remember_hint":   nullable(rememberHint),
			"allow_trust_all": group != nil,
			"trust_all_hint":  trustAllHint,
		})

		raw, ok := s.pending.wait(entry)
		if !ok {
			// Nobody to ask. Fail closed: refusing is the only direction that
			// cannot be wrong when the question was never delivered.
			return false
		}
		decision, _ := raw.(string)

		switch decision {
		case "always":
			if memory != nil {
				if target, ok := remembered.(map[string]any); ok {
					if name, ok := target["tool"].(string); ok {
						memory.Grant(name)
					} else if list, ok := target["prefix"].([]any); ok {
						rule := make(security.Rule, 0, len(list))
						for _, token := range list {
							if text, ok := token.(string); ok {
								rule = append(rule, text)
							}
						}
						memory.GrantPrefix(rule)
					}
				}
			}
			return true
		case "always_group":
			// The front end says only "I agree to release this group". Which tools
			// that covers is looked up here, from the snapshot this server holds —
			// letting the client name them would let the client rewrite the policy.
			if memory != nil && group != nil {
				memory.GrantAll(group.Tools)
			}
			return true
		case "allow":
			return true
		default:
			return false
		}
	}
}

// currentCallID is the call id most recently seen on an event. It is a convenience
// for the front end, which pairs the approval with the tool call it belongs to.
func (s *Server) currentCallID() string {
	s.stateLock.Lock()
	defer s.stateLock.Unlock()
	return s.callID
}

func nullable(text string) any {
	if text == "" {
		return nil
	}
	return text
}
