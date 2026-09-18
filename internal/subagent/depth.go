// Package subagent gives the model one tool that hands a task to a fresh agent.
//
// The child is a whole agent, not a subroutine: its own session, its own
// context ledger, its own tool registry. What the parent gets back is one
// sentence of result. That separation is the point of the feature — the reading,
// the searching and the dead ends stay in the child's context, and the parent
// pays only for the answer.
//
// Three decisions shape everything here:
//
//   - **spawn, not fork.** The child starts from an empty conversation, so the
//     task it is given has to stand on its own. Copying the parent's turns in
//     would be the expensive half of delegation, and the costly part of a
//     subagent is precisely the context it must *not* carry.
//   - **it cannot ask.** The child is built with no asker, so a tool call that
//     needs approval is refused rather than forwarded. A subagent that could
//     prompt would interrupt the user in the middle of somebody else's job, with
//     no way for them to tell which task the question belongs to.
//   - **depth is persisted, never inferred.** See DepthOf.
//
// The package sits above agent, model and state, and below runtime, which is the
// only place that knows how to build a chat client for a chosen route. That is
// why the two things it cannot do itself — resolving a route and serving the tool
// to a model — arrive as the interfaces in this file.
package subagent

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// DefaultMaxDepth is how many levels of delegation are allowed when nothing says
// otherwise. The top-level agent is depth 0; a child of it is depth 1 and may
// delegate while 1 < MaxDepth. So 3 permits three nested levels, and MaxDepth 0
// means no delegation tool at all.
//
// A cap exists because each level multiplies: one delegation costs one extra
// context, but a chain of them costs one per link, and every link is billed to
// the same account. The default is deliberately small — three is deep enough for
// "split this into parts, and one part needs its own split" and shallow enough
// that a mis-set prompt cannot spend a session's budget on recursion.
const DefaultMaxDepth = 3

// Session-metadata keys the delegation bookkeeping lives under. They travel in
// the child's own session file, which is what makes them survive a restart; see
// DepthOf for why that matters.
const (
	// DepthKey is the agent's delegation depth, stored as an int.
	DepthKey = "delegation_depth"
	// ParentKey is the session id this agent was delegated from.
	ParentKey = "parent_session"
	// LabelKey is the short human-facing description the parent gave the task.
	LabelKey = "delegation_label"
)

// sessionIDPattern mirrors the one the store enforces, so an id this package
// mints can always be used as a file name. It is duplicated rather than exported
// from state because the two answer different questions — this one is "may I
// build such a string", the store's is "may I open such a file".
var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// ChildID is the session id of a delegated agent.
//
// The prefix is not decoration. Subagent sessions live in the same store as
// ordinary ones, and the name is what lets the session picker tell them apart
// without opening every file to read its metadata — which is why the constant
// lives in `state`, beside the rule for what a file name may look like. It also
// keeps the id inside the pattern the store accepts, so a child session is an
// ordinary session everywhere below this package.
func ChildID(parentID string, seq int) string {
	// The id is allowed 64 characters, and the two ends of it are fixed: `sub-`
	// in front, `-<seq>` behind. So the parent segment gets whatever is left, and
	// it is truncated from the **left** — the parent's timestamp is the part that
	// can go without making the name ambiguous, while the sequence number at the
	// other end is what makes it unique. Uniqueness is the property a file name
	// cannot lose; identifiability is a convenience.
	suffix := "-" + strconv.Itoa(seq)
	// Strip whatever cannot appear in a file name rather than escaping it: an id
	// that only survives because the pattern was loosened is an id that will one
	// day be handed to a function that validates strictly.
	parent := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			return r
		default:
			return -1
		}
	}, parentID)

	const maxBase = 64
	room := maxBase - len(state.ChildSessionPrefix) - len(suffix)
	if len(parent) > room {
		parent = parent[len(parent)-max(room, 0):]
	}
	if parent == "" {
		parent = "anon"
	}
	id := state.ChildSessionPrefix + parent + suffix
	// The pattern is the contract, so the result is checked against it rather than
	// assumed to fit. Reaching here with a bad id means one of the two arithmetic
	// steps above is wrong, and a silently unusable session id is a bug that only
	// shows up as a failed save much later.
	if !sessionIDPattern.MatchString(id) {
		return state.ChildSessionPrefix + "anon" + suffix
	}
	return id
}

// IsChildID reports whether a session id names a delegated agent.
func IsChildID(id string) bool {
	return state.IsChildSessionID(id)
}

// DepthOf reads an agent's delegation depth out of its session metadata.
//
// Absence means depth zero, which is the top-level agent. The stored value is
// **authoritative** rather than a hint: a child session that is restored arrives
// with fresh in-memory state, and counting it from zero would let it delegate as
// though it were still top-level — the cap would look enforced and would not be.
//
// The only thing an in-memory value may do is push the number **up**. A resumed
// child whose runtime options claim a deeper position is telling the truth about
// a chain the file does not know about, and refusing that would under-count.
func DepthOf(session *state.Session) int {
	return max(DepthOfMetadata(session.Metadata), 0)
}

// DepthOfMetadata is DepthOf for a metadata map, for callers holding one but not
// a whole session.
func DepthOfMetadata(metadata map[string]any) int {
	if metadata == nil {
		return 0
	}
	return max(intField(metadata[DepthKey]), 0)
}

// intField reads an int out of a metadata value, accepting every shape a JSON
// round trip can produce. A value of the wrong type reads as zero rather than as
// an error: the alternative is a session that cannot be opened because one
// bookkeeping field was written by a different version.
func intField(value any) int {
	switch number := value.(type) {
	case int:
		return number
	case int64:
		return int(number)
	case float64:
		return int(number)
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(number))
		if err != nil {
			return 0
		}
		return parsed
	default:
		return 0
	}
}

// ChildMetadata builds the metadata block for a delegated session.
//
// Everything in it is a fact about lineage that the child itself may need later:
// the depth caps its own delegation, and the parent id is how a person reading
// the child's file finds their way back. The label is for the interfaces — a
// row that says `sub-20260101-120000-1` is a row nobody can act on.
func ChildMetadata(parent *state.Session, depth int, label string) map[string]any {
	metadata := map[string]any{DepthKey: depth}
	if parent != nil {
		metadata[ParentKey] = parent.SessionID
	}
	if label != "" {
		metadata[LabelKey] = label
	}
	return metadata
}
