package state

import (
	"regexp"
	"strings"
	"time"
)

// The goal: one long-running completion objective per session.
//
// A goal is the answer to "why is this session still running". It exists because
// a session only ends when a turn ends, and a turn only ends when the model
// answers — so a task that takes more than one turn has nowhere to keep the
// statement of what it is for, except in the conversation, where it is exactly
// what compaction folds away first.
//
// Three rules decide the shape of everything in this file:
//
//  1. **The goal is session state, not conversation.** It lives in
//     `session.Metadata` beside `model_selection` and `context_compaction`, so it
//     survives a restart, a `/resume`, and a compaction — compaction only folds
//     messages, and this is not a message.
//  2. **The durable half and the live half are separate.** `phase`, the
//     objective, the revision and the round budget are facts about the goal and
//     are written down. "May this process start the next round on its own" is an
//     authorization, it is observed at run time, and it is deliberately **not**
//     written down: a permission read back from disk is a permission that can be
//     stale, and stale authority over an autonomous loop is the one failure this
//     feature must not have.
//  3. **Round numbers are a runtime invariant, not a field the model can set.**
//     `rounds_started` moves by exactly one per admitted round and by nothing
//     else. The model has no argument that reaches it.
const (
	// GoalKey is where the goal block lives in session metadata. It sits at the
	// same level as model_selection and context_compaction rather than inside
	// ContextState, because that block is only written when its version moves and
	// a goal change must not slip through that gate.
	GoalKey = "goal"

	// GoalBlockVersion is the block format version. Like the compaction block's,
	// it is independent of the session file's version: its job is "what does this
	// block mean". When the meaning changes, an old session should degrade to "no
	// goal" rather than become unopenable.
	GoalBlockVersion = 1

	// DefaultMaxGoalRounds is how many autonomous rounds a goal gets when the
	// caller does not say. It is a backstop, not a budget the user is expected to
	// tune: the value's only job is to make "this never stops" impossible.
	DefaultMaxGoalRounds = 256

	// MaxGoalRoundsCeiling bounds what a single goal may ask for. A round is a
	// full turn and a full turn can cost real money, so the ceiling has to exist
	// somewhere and the definition of the goal is where it belongs.
	MaxGoalRoundsCeiling = 1000

	// ObjectiveCeiling caps the objective text. It is the one string that goes
	// into the payload every round, so an accidental paste of a whole file must
	// not become a permanent tax on every request.
	ObjectiveCeiling = 4000
)

// Phase is the durable lifecycle state of a goal.
type Phase string

const (
	// PhaseActive is a goal that may run. Whether it *does* run is Activation.
	PhaseActive Phase = "active"
	// PhasePaused is a goal a person stopped. Only a person resumes it: the
	// model asking is how "pause" quietly turns into "ignore".
	PhasePaused Phase = "paused"
	// PhaseBlocked is a goal stopped by a concrete condition, which is carried
	// in the block.
	PhaseBlocked Phase = "blocked"
	// PhaseComplete is terminal. A completed goal is kept, not deleted: the
	// answer to "what was this session for, and did it get there" has to outlive
	// the loop.
	PhaseComplete Phase = "complete"
)

// Goal operations, as they appear in the audit trail.
const (
	GoalOpCreate   = "create"
	GoalOpEdit     = "edit"
	GoalOpPause    = "pause"
	GoalOpResume   = "resume"
	GoalOpComplete = "complete"
	GoalOpBlock    = "block"
)

// Goal actions a person may take from the command surface.
//
// They are the human half of the same three tools: the model can create, end and
// (from a turn a person started) change a goal, and a person can stop it, restart
// it or throw it away without having to phrase any of that as a request to a model.
// Without this half, a goal the model created for itself would be invisible and
// unstoppable.
const (
	GoalActionPause  = "pause"
	GoalActionResume = "resume"
	GoalActionClear  = "clear"
)

// GoalSnapshot is the goal as a front end needs it: flat, and safe to send over
// the protocol.
//
// It is deliberately not `GoalToBlock`. That shape is the storage format, and its
// job is to be compared byte for byte to decide whether the file needs a new
// `meta` record — a transport that reused it would couple the wire format to the
// watermark, and a field added for the interface would start costing a disk write.
//
// `armed` travels here and not in the goal block for the third time, and this is
// the place it matters most: a panel that read arming out of the file would show a
// resumed session as ready to continue when nothing in this process ever said so.
func GoalSnapshot(goal Goal, activation Activation) map[string]any {
	return map[string]any{
		"id":              goal.ID,
		"objective":       goal.Objective,
		"phase":           string(goal.Phase),
		"revision":        goal.Revision,
		"rounds":          goal.Rounds,
		"max_rounds":      goal.MaxRounds,
		"rounds_text":     goal.RoundsText(),
		"limit_reached":   goal.RoundLimitReached(),
		"armed":           activation == ActivationArmed,
		"blocked_code":    goal.BlockedCode,
		"blocked_message": goal.BlockedText,
	}
}

// NoGoalSnapshot is the same shape with nothing in it.
//
// It exists so that "this session has no goal" is a payload with `goal: null`
// rather than a missing key. A front end that has to tell "absent" apart from
// "empty" is a front end with a second definition of the panel's shape, and the
// first bug that produces is a crash on the empty case.
func NoGoalSnapshot(activation Activation) map[string]any {
	return map[string]any{
		"id":        "",
		"objective": "",
		"phase":     "",
		"armed":     activation == ActivationArmed,
	}
}

// GoalAction performs one of the commands a person may give about the goal.
//
// It is the human counterpart of the goal tools, and the differences are the
// point:
//
//   - **No revision fence.** The tools carry an id and a revision because the model
//     reads, thinks for a while, and then writes — a window in which another
//     change can land. A person pressing a key is acting on what they are looking
//     at right now, and refusing their command because a round moved the revision
//     two seconds ago would be a bug from where they sit.
//   - **`clear` exists here and not in the tools.** A goal the model created for
//     itself has to be removable by the person who did not ask for it. Models get
//     to complete goals, not to delete other people's work.
//   - **Resuming a completed goal is refused.** `complete` is terminal; wanting to
//     keep going after that is a new goal with a new objective, and letting resume
//     reopen a finished one would make the completion report a lie.
//
// The returned snapshot reflects the state after the action.
func GoalAction(metadata map[string]any, action string, now float64) (map[string]any, error) {
	switch action {
	case GoalActionClear:
		ClearGoal(metadata)
		return NoGoalSnapshot(ActivationDisarmed), nil
	case GoalActionPause, GoalActionResume:
	default:
		return nil, &GoalError{Code: GoalErrInvalidOp, Message: "unknown goal action: " + action}
	}

	current, ok := LoadGoal(metadata)
	if !ok {
		return NoGoalSnapshot(ActivationDisarmed), nil
	}

	if action == GoalActionPause {
		// An active goal becomes paused. A blocked one is already stopped, and
		// moving it to paused would throw away the reason — so the command reports
		// the phase as it is and the caller disarms. Either way the goal is not
		// running when this returns.
		if current.Phase == PhaseActive {
			changed, err := ApplyGoalChange(metadata, current.ID, current.Revision,
				GoalChange{Op: GoalOpPause, Now: now})
			if err != nil {
				return nil, err
			}
			return GoalSnapshot(changed, ActivationDisarmed), nil
		}
		return GoalSnapshot(current, ActivationDisarmed), nil
	}

	// Resume.
	if current.Phase == PhaseComplete {
		return nil, &GoalError{
			Code:    GoalErrPhase,
			Message: "a completed goal cannot be resumed; create a new goal instead",
		}
	}
	changed, err := ApplyGoalChange(metadata, current.ID, current.Revision,
		GoalChange{Op: GoalOpResume, Now: now})
	if err != nil {
		return nil, err
	}
	return GoalSnapshot(changed, ActivationArmed), nil
}

// blockerCodePattern is the only shape a blocker code may take. The code is
// machine-routable — it is the part a program can branch on — so a free-form
// sentence in that field would make it useless for the thing it exists for.
var blockerCodePattern = regexp.MustCompile(`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`)

// Goal is one long-running completion objective.
//
// ID is not derived from the objective: editing the objective keeps the id, so
// "the same goal, restated" stays one goal and its round history stays attached
// to it. Revision is a fence — every accepted change moves it, and a caller
// acting on a revision that is no longer current is refused rather than obeyed,
// which is what makes "read, then write" safe across two round trips.
type Goal struct {
	ID          string
	Objective   string
	Phase       Phase
	Revision    int
	MaxRounds   int
	Rounds      int
	BlockedCode string
	BlockedText string
	CreatedAt   float64
	UpdatedAt   float64
}

// Activation is whether this process may start autonomous rounds for the goal.
//
// It is not a field of Goal on purpose. See rule 2 at the top of this file: an
// authorization restored from a file is an authorization nobody granted in this
// process, and an autonomous loop acting on one is the failure mode that makes
// people turn the feature off.
type Activation string

const (
	// ActivationArmed means the driver may start the next round when the agent
	// goes idle.
	ActivationArmed Activation = "armed"
	// ActivationDisarmed means it may not, and a person has to say so.
	ActivationDisarmed Activation = "disarmed"
)

// GoalView is what a caller reads: the goal as persisted, plus the authorization
// that only exists at run time.
type GoalView struct {
	Goal       Goal
	Activation Activation
}

// RoundLimitReached reports whether the goal has spent its round budget.
func (g Goal) RoundLimitReached() bool { return g.Rounds >= g.MaxRounds }

// RoundsText renders "3/256" for a person and for the model.
func (g Goal) RoundsText() string { return itoa(g.Rounds) + "/" + itoa(g.MaxRounds) }

// GoalFold is a replayed goal state.
//
// Seen distinguishes "there has never been a goal here" from "there was one and
// it was cleared". The difference matters to anyone reconstructing what happened:
// with only Current, a cleared goal and a goal that never existed look identical.
type GoalFold struct {
	Current *Goal
	Seen    bool
}

// --- metadata block ---------------------------------------------------------

// LoadGoal reads the goal out of session metadata.
//
// Anything unreadable yields ok=false rather than an error, the same rule the
// model selection and the AGENT.md block follow: an old session file has no such
// key, and a damaged key must not make the whole session unopenable. "No goal" is
// the safe reading — a session that runs without an objective is the behaviour
// from before this feature existed.
func LoadGoal(metadata map[string]any) (Goal, bool) {
	if metadata == nil {
		return Goal{}, false
	}
	return GoalFromBlock(metadata[GoalKey])
}

// SaveGoal writes the goal into session metadata. It does not touch the disk —
// checkpointing is the agent's job.
func SaveGoal(metadata map[string]any, goal Goal) Goal {
	if metadata != nil {
		metadata[GoalKey] = GoalToBlock(goal)
	}
	return goal
}

// ClearGoal removes the goal from session metadata.
func ClearGoal(metadata map[string]any) {
	if metadata != nil {
		delete(metadata, GoalKey)
	}
}

// FoldGoal replays the goal block into a fold state.
//
// It exists so that a caller can ask the two questions the goal tool and the
// status panel both ask — "which goal is current" and "has there been one" —
// without either of them reaching into a bare map.
func FoldGoal(metadata map[string]any) GoalFold {
	goal, ok := LoadGoal(metadata)
	if !ok {
		return GoalFold{}
	}
	return GoalFold{Current: &goal, Seen: true}
}

// GoalToBlock is the stored shape.
//
// Every field is written, including the empty blocker ones, because this block's
// canonical form is also the watermark the session store compares to decide
// whether metadata changed: a block that omits empty fields would compare
// different on every round and append a `meta` record for nothing.
func GoalToBlock(goal Goal) map[string]any {
	return map[string]any{
		"version":      GoalBlockVersion,
		"id":           goal.ID,
		"objective":    goal.Objective,
		"phase":        string(goal.Phase),
		"revision":     goal.Revision,
		"max_rounds":   goal.MaxRounds,
		"rounds":       goal.Rounds,
		"blocked_code": goal.BlockedCode,
		"blocked_text": goal.BlockedText,
		"created_at":   goal.CreatedAt,
		"updated_at":   goal.UpdatedAt,
	}
}

// GoalFromBlock is the read side: unreadable yields false.
//
// **A self-contradictory block is refused, not repaired.** `rounds` above
// `max_rounds` cannot be produced by any legal transition, so a file containing
// it was written by a bug or edited by hand; accepting it would make
// "RoundLimitReached" permanently true and leave a goal that can be neither
// continued nor honestly reported. Refusing it degrades a damaged session to
// "no goal", which is the state the model and the person both understand.
func GoalFromBlock(block any) (Goal, bool) {
	object, ok := block.(map[string]any)
	if !ok {
		return Goal{}, false
	}
	if version := intOf(object["version"]); version != GoalBlockVersion {
		return Goal{}, false
	}
	id := textOf(object["id"])
	objective := textOf(object["objective"])
	phase := Phase(textOf(object["phase"]))
	if id == "" || strings.TrimSpace(objective) == "" || !knownPhase(phase) {
		return Goal{}, false
	}

	rounds := intOf(object["rounds"])
	if rounds < 0 {
		return Goal{}, false
	}
	maxRounds := intOf(object["max_rounds"])
	if maxRounds <= 0 || rounds > maxRounds {
		return Goal{}, false
	}

	goal := Goal{
		ID:          id,
		Objective:   objective,
		Phase:       phase,
		Revision:    intOf(object["revision"]),
		MaxRounds:   maxRounds,
		Rounds:      rounds,
		BlockedCode: textOf(object["blocked_code"]),
		BlockedText: textOf(object["blocked_text"]),
		CreatedAt:   floatOf(object["created_at"]),
		UpdatedAt:   floatOf(object["updated_at"]),
	}
	if goal.Revision < 1 {
		return Goal{}, false
	}
	// A blocker belongs to the blocked phase and to nothing else. The two
	// directions are both wrong: blocked with no reason is an accusation without
	// a subject, and a reason left behind on a resumed goal is a stale sentence
	// that later reads as a current one.
	if phase == PhaseBlocked {
		if goal.BlockedCode == "" || goal.BlockedText == "" {
			return Goal{}, false
		}
	} else if goal.BlockedCode != "" || goal.BlockedText != "" {
		return Goal{}, false
	}
	return goal, true
}

func knownPhase(phase Phase) bool {
	switch phase {
	case PhaseActive, PhasePaused, PhaseBlocked, PhaseComplete:
		return true
	default:
		return false
	}
}

// --- transitions ------------------------------------------------------------

// GoalSpec is the input to CreateGoal. It is a struct rather than a parameter
// list because two of its fields are optional and "which of the two numbers did
// the caller mean" is not a question a positional argument can answer honestly.
type GoalSpec struct {
	Objective string
	MaxRounds int
	ID        string
	Now       float64
}

// CreateGoal starts a new goal.
//
// Creating over an existing goal is refused: the alternative is what "start a new
// task" silently discarding the round history of the old one, and the two
// questions "did I overwrite something" and "did this fail" would have the same
// answer.
func CreateGoal(metadata map[string]any, spec GoalSpec) (Goal, error) {
	if current, ok := LoadGoal(metadata); ok {
		return Goal{}, &GoalError{Code: GoalErrExists, Message: "session already has a goal: " + current.ID}
	}
	objective, err := validateObjective(spec.Objective)
	if err != nil {
		return Goal{}, err
	}
	maxRounds, err := ResolveMaxRounds(spec.MaxRounds)
	if err != nil {
		return Goal{}, err
	}
	now := stamp(spec.Now)
	goal := Goal{
		ID:        goalID(spec.ID, now),
		Objective: objective,
		Phase:     PhaseActive,
		Revision:  1,
		MaxRounds: maxRounds,
		CreatedAt: now,
		UpdatedAt: now,
	}
	return SaveGoal(metadata, goal), nil
}

// GoalChange is one requested transition.
type GoalChange struct {
	Op          string
	Objective   string
	MaxRounds   int
	BlockedCode string
	BlockedText string
	Now         float64
}

// ApplyGoalChange performs one transition, checking first that the caller is
// acting on the goal that is actually there.
//
// `goalID` and `revision` are the ones the caller read. They are compared, never
// taken on trust: the whole reason the model is made to read before it writes is
// that between the read and the write another change may have landed, and
// applying a change designed against a goal that no longer exists is how a
// "complete" arrives on a goal that was redefined two rounds ago.
func ApplyGoalChange(metadata map[string]any, goalID string, revision int, change GoalChange) (Goal, error) {
	current, ok := LoadGoal(metadata)
	if !ok {
		return Goal{}, &GoalError{Code: GoalErrNotFound, Message: "session has no goal"}
	}
	if goalID == "" || goalID != current.ID {
		return Goal{}, &GoalError{
			Code:    GoalErrStale,
			Message: "goal id is not the current goal (" + current.ID + ")",
		}
	}
	if revision != current.Revision {
		return Goal{}, &GoalError{
			Code: GoalErrStale,
			Message: "goal revision is " + itoa(current.Revision) + ", not " + itoa(revision) +
				"; read the goal again before changing it",
		}
	}

	next := current
	if err := applyOperation(&next, current, change); err != nil {
		return Goal{}, err
	}
	next.Revision = current.Revision + 1
	next.UpdatedAt = stamp(change.Now)
	return SaveGoal(metadata, next), nil
}

// AdmitGoalRound admits one autonomous round.
//
// It is the **only** way `rounds` moves, and it is called by the driver at the
// moment the round's prompt is appended to history — not when it is reserved.
// A reservation that is refused for being stale must not spend the round number:
// the numbers exist to bound how much work the goal may do, and a number spent on
// a round that never ran makes that bound a lie in the safe-looking direction.
//
// Admitting a round is a change like any other, so it moves the revision. That is
// what makes holding a reservation across the gap between "the driver decided to
// queue a round" and "the prompt entered history" safe: anything that changed the
// goal in that gap — a person's edit, a pause, an earlier admission — invalidates
// the reservation instead of being silently overwritten by it.
func AdmitGoalRound(metadata map[string]any, goalID string, revision, round int) (Goal, error) {
	current, ok := LoadGoal(metadata)
	if !ok {
		return Goal{}, &GoalError{Code: GoalErrNotFound, Message: "session has no goal"}
	}
	if goalID != current.ID {
		return Goal{}, &GoalError{Code: GoalErrStale, Message: "reservation does not match the current goal"}
	}
	// The order of the next two checks is the point of them. Round order first: a
	// reservation for a round that is not the next one was never admissible, so a
	// stale revision is not the interesting fact about it. Revision second, and it
	// is what refuses a reservation that *was* for the next round when the goal
	// moved underneath it.
	if round != current.Rounds+1 {
		return Goal{}, &GoalError{
			Code:    GoalErrRound,
			Message: "round must be the next one (" + itoa(current.Rounds+1) + ")",
		}
	}
	if revision != current.Revision {
		return Goal{}, &GoalError{Code: GoalErrStale, Message: "reservation does not match the current goal"}
	}
	if current.Phase != PhaseActive {
		return Goal{}, &GoalError{Code: GoalErrPhase, Message: "goal is " + string(current.Phase) + ", not active"}
	}
	if current.RoundLimitReached() {
		return Goal{}, &GoalError{Code: GoalErrRoundLimit, Message: "goal exhausted its round budget"}
	}
	next := current
	next.Rounds = round
	next.Revision = current.Revision + 1
	next.UpdatedAt = nowSeconds()
	return SaveGoal(metadata, next), nil
}

// AuthorizedBy reports whether an operation may run in a turn of the given
// origin.
//
// The split is the difference between "the model is steering" and "the model is
// driving". Reading the goal and *ending* it are things a running loop must be
// able to do — a round that discovers the objective is unreachable has to be able
// to say so, or the loop can only ever end by exhausting its budget. Starting,
// redefining, pausing and resuming are things only a person may do: they decide
// what the session is for and whether it runs unattended, and a model allowed to
// resume would undo a pause by asking nicely.
func AuthorizedBy(op string, human bool) bool {
	switch op {
	case GoalOpCreate, GoalOpEdit, GoalOpPause, GoalOpResume:
		return human
	case GoalOpComplete, GoalOpBlock:
		return true
	default:
		return false
	}
}

func applyOperation(next *Goal, current Goal, change GoalChange) error {
	switch change.Op {
	case GoalOpEdit:
		if change.Objective == "" && change.MaxRounds == 0 {
			return &GoalError{Code: GoalErrInvalidEdit, Message: "edit requires objective and/or max_rounds"}
		}
		if current.Phase == PhaseComplete {
			return &GoalError{Code: GoalErrPhase, Message: "a completed goal cannot be edited"}
		}
		if change.Objective != "" {
			objective, err := validateObjective(change.Objective)
			if err != nil {
				return err
			}
			next.Objective = objective
		}
		if change.MaxRounds != 0 {
			maxRounds, err := ResolveMaxRounds(change.MaxRounds)
			if err != nil {
				return err
			}
			if maxRounds < current.Rounds {
				return &GoalError{
					Code:    GoalErrInvalidEdit,
					Message: "max_rounds cannot be below the " + itoa(current.Rounds) + " rounds already spent",
				}
			}
			next.MaxRounds = maxRounds
		}
		return nil

	case GoalOpPause:
		if current.Phase != PhaseActive {
			return &GoalError{Code: GoalErrPhase, Message: "only an active goal can be paused"}
		}
		next.Phase = PhasePaused
		return nil

	case GoalOpResume:
		switch current.Phase {
		case PhasePaused, PhaseBlocked:
			next.Phase = PhaseActive
			next.BlockedCode = ""
			next.BlockedText = ""
			return nil
		default:
			return &GoalError{Code: GoalErrPhase, Message: "only a paused or blocked goal can be resumed"}
		}

	case GoalOpComplete:
		if current.Phase == PhaseComplete {
			// Idempotent on purpose. Two rounds racing to declare the same
			// success is a normal outcome, not an error, and refusing the second
			// would put a failure in the history for the case that went right.
			return nil
		}
		next.Phase = PhaseComplete
		next.BlockedCode = ""
		next.BlockedText = ""
		return nil

	case GoalOpBlock:
		code := strings.TrimSpace(change.BlockedCode)
		text := strings.TrimSpace(change.BlockedText)
		if text == "" {
			return &GoalError{Code: GoalErrInvalidBlock, Message: "blocked_reason is required"}
		}
		if code == "" {
			code = BlockCodeModelReported
		}
		if !blockerCodePattern.MatchString(code) {
			return &GoalError{Code: GoalErrInvalidBlock, Message: "blocked code must be lower kebab case"}
		}
		if current.Phase == PhaseComplete {
			return &GoalError{Code: GoalErrPhase, Message: "a completed goal cannot be blocked"}
		}
		next.Phase = PhaseBlocked
		next.BlockedCode = code
		next.BlockedText = text
		return nil

	default:
		return &GoalError{Code: GoalErrInvalidOp, Message: "unknown operation: " + change.Op}
	}
}

// BlockCodeModelReported is the stable code for "the model says this is stuck".
//
// It is a code rather than free text because the two kinds of blocker need to be
// told apart later: a condition the runtime found (an exhausted round budget, a
// failed persistence write) is evidence, while this one is a claim, and a report
// that mixes the two teaches the reader to trust neither.
const BlockCodeModelReported = "model-reported"

// ResolveMaxRounds validates and defaults a round budget.
func ResolveMaxRounds(value int) (int, error) {
	if value == 0 {
		return DefaultMaxGoalRounds, nil
	}
	if value < 0 {
		return 0, &GoalError{Code: GoalErrInvalidMaxRounds, Message: "max_rounds must be positive"}
	}
	if value > MaxGoalRoundsCeiling {
		return 0, &GoalError{
			Code:    GoalErrInvalidMaxRounds,
			Message: "max_rounds cannot exceed " + itoa(MaxGoalRoundsCeiling),
		}
	}
	return value, nil
}

func validateObjective(text string) (string, error) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", &GoalError{Code: GoalErrInvalidObjective, Message: "objective is required"}
	}
	if len([]rune(trimmed)) > ObjectiveCeiling {
		return "", &GoalError{
			Code:    GoalErrInvalidObjective,
			Message: "objective is longer than " + itoa(ObjectiveCeiling) + " characters",
		}
	}
	return trimmed, nil
}

func stamp(now float64) float64 {
	if now != 0 {
		return now
	}
	return nowSeconds()
}

func nowSeconds() float64 {
	return float64(time.Now().UnixNano()) / 1e9
}

// goalID mints an id. The hook exists for tests, which need an id that is stable
// across runs to compare a block byte for byte.
var goalIDHook = func(now float64) string {
	return "goal-" + itoa(int(now))
}

func goalID(explicit string, now float64) string {
	if trimmed := strings.TrimSpace(explicit); trimmed != "" {
		return trimmed
	}
	return goalIDHook(now)
}

// --- text building ----------------------------------------------------------

// The builders below are the interface between this file and the two places a
// goal is read by a language model — the per-round payload tail and the
// continuation prompt. They live here rather than in the tools package because
// the tools must not be the only thing that can describe a goal: a resumed
// session, a status panel and a test all need the same sentences, and two
// builders for one fact drift.

// GoalText is the goal as the payload tail shows it every round.
//
// It carries the round count with the objective because the count is what turns
// "keep going" into "keep going, and you have spent 3 of 20". The runtime does not
// act on how the model feels about that number; the model does, and it is the only
// party that can decide whether this round is the one to spend on verifying.
func GoalText(goal Goal, activation Activation) string {
	var builder strings.Builder
	builder.WriteString("## 当前目标（运行时持有，跨轮持续）\n\n")
	builder.WriteString("目标：" + goal.Objective + "\n")
	builder.WriteString("状态：" + string(goal.Phase) + "；轮次：" + goal.RoundsText() + "\n")
	if goal.Phase == PhaseBlocked && goal.BlockedText != "" {
		builder.WriteString("阻塞（" + goal.BlockedCode + "）：" + goal.BlockedText + "\n")
	}
	if activation == ActivationDisarmed {
		// Said out loud because the alternative is a model that reads "active",
		// assumes the loop will carry on, and ends its round with a plan for work
		// nobody is going to start.
		builder.WriteString("续行：未启用 —— 这一轮结束后不会自动继续，除非用户明确要求继续。\n")
	}
	return strings.TrimRight(builder.String(), "\n")
}

// GoalRoundPrompt is the message that opens one autonomous round.
//
// It is deliberately a **user** message carrying the runtime-note marker: it is
// the runtime speaking, not the person, and it must not turn up in "what the user
// actually asked". The invariants it states are the ones a round that has lost its
// memory of the last one gets wrong — treat the workspace as authoritative, and do
// not claim completion without evidence.
func GoalRoundPrompt(goal Goal, round int) map[string]any {
	var builder strings.Builder
	builder.WriteString("<goal_round>\n")
	builder.WriteString("目标：" + goal.Objective + "\n")
	builder.WriteString("轮次：" + itoa(round) + "/" + itoa(goal.MaxRounds) + "\n\n")
	builder.WriteString("在同一个会话里继续推进这个目标。以当前工作区、工具结果和持久状态为准，" +
		"需要事实就去查，不要把先前轮次的叙述当成现状。这一轮要取得具体进展并验证结果。" +
		"在宣称完成之前，先收集能证明整个目标已经达成的证据、读一次当前目标，再把它标记为完成。" +
		"如果还有活没干完，就让它保持 active，留给下一轮。确实卡住时按 goal 工具的要求报告阻塞。\n")
	builder.WriteString("</goal_round>")
	return map[string]any{
		"role":         "user",
		"content":      builder.String(),
		RuntimeNoteKey: true,
		GoalRoundKey:   true,
	}
}

// GoalRoundKey marks a runtime note as an autonomous round prompt.
//
// Two markers rather than one because "not typed by a human" and "a goal round"
// are different questions. `UserInputs` asks the first; the driver asks the
// second, and it must be able to answer it from the message alone after a restart,
// when nothing in memory remembers what it queued.
const GoalRoundKey = "__goal_round"

// IsGoalRound reports whether a message is an autonomous round prompt.
func IsGoalRound(message map[string]any) bool {
	value, _ := message[GoalRoundKey].(bool)
	return value
}

// --- errors -----------------------------------------------------------------

// Goal error codes. They are stable strings because the model is the caller: a
// code lets the next turn say precisely what was refused, and a refusal the model
// cannot act on is a refusal that repeats.
const (
	GoalErrExists           = "GOAL_EXISTS"
	GoalErrNotFound         = "GOAL_NOT_FOUND"
	GoalErrStale            = "GOAL_STALE"
	GoalErrPhase            = "GOAL_INVALID_PHASE"
	GoalErrRound            = "GOAL_INVALID_ROUND"
	GoalErrRoundLimit       = "GOAL_ROUND_LIMIT"
	GoalErrInvalidOp        = "GOAL_INVALID_OPERATION"
	GoalErrInvalidEdit      = "GOAL_INVALID_EDIT"
	GoalErrInvalidBlock     = "GOAL_INVALID_BLOCK"
	GoalErrInvalidObjective = "GOAL_INVALID_OBJECTIVE"
	GoalErrInvalidMaxRounds = "GOAL_INVALID_MAX_ROUNDS"
	GoalErrNotHuman         = "GOAL_NOT_HUMAN"
)

// GoalError is a refusal with a machine-routable code.
type GoalError struct {
	Code    string
	Message string
}

func (e *GoalError) Error() string { return e.Code + ": " + e.Message }

// GoalErrorOf reads the code out of an error, if it is a goal refusal.
func GoalErrorOf(err error) (string, bool) {
	if goalErr, ok := err.(*GoalError); ok {
		return goalErr.Code, true
	}
	return "", false
}

func textOf(value any) string {
	text, _ := value.(string)
	return text
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
