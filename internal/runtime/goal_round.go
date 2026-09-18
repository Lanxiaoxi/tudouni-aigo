package runtime

import (
	"errors"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// The runtime's half of the goal loop: arming, and running one round.
//
// The separation from `goal_driver.go` is the separation between deciding and
// doing. The driver decides whether another round is allowed; this file is what
// happens when the answer is yes — the round's prompt enters history, the round
// number is spent, and the agent runs a turn that was started by nobody.
//
// It lives on the runtime rather than in the protocol server because the runtime
// owns the three things a round needs to touch: the session metadata (the goal),
// the session messages (the prompt), and the checkpoint (making both survive).

// ErrGoalNotArmed is returned when a round is asked for on a goal this process is
// not authorized to continue.
//
// It is a distinct error rather than a silent false because the two ways to get
// here need different answers: a driver that raced with a pause should drop its
// reservation, while a caller that never armed anything has a bug.
var ErrGoalNotArmed = errors.New("goal continuation is not armed in this process")

// GoalArmed reports whether this process may start autonomous rounds.
//
// It is the live observation, never read from the session file: `Resumed` pins it
// to false for the whole life of a resumed runtime, so reopening a session cannot
// resume work the person at the keyboard never asked for.
func (r *Runtime) GoalArmed() bool {
	r.goalMu.Lock()
	defer r.goalMu.Unlock()
	return r.goalArmedLocked()
}

func (r *Runtime) goalArmedLocked() bool {
	if r.Resumed {
		return false
	}
	return r.goalActivated
}

// SetGoalArmed turns autonomous continuation on or off for this process.
//
// Arming a resumed session is refused rather than ignored, and the refusal is
// silent in the sense that matters: the flag simply does not become true, so
// `GoalArmed` stays false and every reader — the tools, the payload tail, the
// driver — agrees. A person who wants a resumed session to continue says so
// again in the session they are actually looking at.
func (r *Runtime) SetGoalArmed(on bool) {
	r.goalMu.Lock()
	defer r.goalMu.Unlock()
	if on && r.Resumed {
		return
	}
	r.goalActivated = on
}

// armFromTurn decides whether a turn that just finished leaves the goal running.
//
// This is where a goal the model created for itself starts actually running, and it
// is deliberately a **separate act from creating one**. The tool layer knows how to
// write a goal down; whether the session then continues is this process's decision,
// and it is taken in one place so there is one answer to read:
//
//   - a whole turn has finished, so nothing is mid-step;
//   - the goal is loaded and active (paused, blocked and complete are not
//     candidates, and the driver already disarms those on its own path);
//   - a person started this turn.
//
// The last condition is the one that matters. A model that could arm itself from
// inside its own round would be deciding how long it runs, and the round budget
// would stop bounding anything. A person asking — in any words — for the work to
// continue is the authorization; the model noticing that and writing the goal down
// is bookkeeping.
func (r *Runtime) armFromTurn() {
	goal, ok := state.LoadGoal(r.SessionValue.Metadata)
	if !ok || goal.Phase != state.PhaseActive {
		return
	}
	if !r.SessionValue.IsHumanTurn() {
		return
	}
	r.SetGoalArmed(true)
}

// ArmFromTurn is the protocol layer's view of `armFromTurn`.
//
// Exported through the interface so the server can call it at the one instant it
// knows about — a finished turn — without knowing anything about goals.
func (r *Runtime) ArmFromTurn() { r.armFromTurn() }

// GoalPanel renders the goal for a front end, or the empty payload when there is
// none.
//
// It is the read side of the command surface: `/goal` and the rail need the same
// facts, and they need them from the same place the tools write, or the model and
// the person would be looking at two different goals.
func (r *Runtime) GoalPanel() map[string]any {
	goal, ok := state.LoadGoal(r.SessionValue.Metadata)
	if !ok {
		return state.NoGoalSnapshot(r.activation())
	}
	return state.GoalSnapshot(goal, r.activation())
}

// GoalCommand performs a goal action a person asked for.
//
// It arms or disarms according to the resulting phase, so the command and the driver
// cannot disagree about what "paused" means: a paused goal is disarmed here rather
// than left armed for the driver to refuse on some later turn.
func (r *Runtime) GoalCommand(action string) (map[string]any, error) {
	snapshot, err := state.GoalAction(r.SessionValue.Metadata, action, 0)
	if err != nil {
		return nil, err
	}
	r.Checkpoint()

	switch action {
	case state.GoalActionResume:
		r.SetGoalArmed(true)
		// Re-read from the live state rather than returning the snapshot built
		// above: `SetGoalArmed` refuses on a resumed session, and a panel claiming
		// "armed" there would tell a person their goal will continue when it will
		// not.
		return r.GoalPanel(), nil
	case state.GoalActionPause, state.GoalActionClear:
		r.SetGoalArmed(false)
	}
	return snapshot, nil
}

// StartGoalRound admits a reserved round and runs it.
//
// It returns the answer and whether a turn ran at all. `started == false` means the
// reservation was stale — the goal moved, was paused, or its budget ran out between
// the driver's claim and this call — and **nothing happened**: no round was spent,
// no prompt entered history, and the caller should hand the turn back to whatever
// else was queued.
//
// The order is what makes that promise true:
//
//  1. check the reservation against the goal as it is now;
//  2. admit the round (which spends the number and moves the revision);
//  3. checkpoint, so a crash cannot leave the number spent with no prompt to show
//     for it;
//  4. append the prompt;
//  5. run.
//
// Steps 2–4 are in that order because each is the undo of the one before it: a
// round with no prompt is a number spent on nothing, and a prompt with no round is
// a free round.
func (r *Runtime) StartGoalRound(reservation protocol.GoalRound) (string, bool, error) {
	if reservation == nil || r.Agent == nil {
		return "", false, ErrGoalNotArmed
	}
	if !r.GoalArmed() {
		return "", false, ErrGoalNotArmed
	}
	goal, ok := state.LoadGoal(r.SessionValue.Metadata)
	if !ok || goal.ID != reservation.GoalID() || goal.Revision != reservation.Revision() {
		return "", false, nil
	}
	if goal.Phase != state.PhaseActive || goal.RoundLimitReached() {
		return "", false, nil
	}

	admitted, err := state.AdmitGoalRound(r.SessionValue.Metadata, reservation.GoalID(), reservation.Revision(), reservation.Round())
	if err != nil {
		return "", false, nil
	}
	r.Checkpoint()
	r.recordGoalRound(admitted, reservation.Round())
	answer, err := r.Agent.RunMessages(reservation.Messages())
	return answer, true, err
}

// recordGoalRound writes the one audit line that answers "did an autonomous round
// actually run, and at which revision of which goal".
//
// It is written here rather than in the driver because this is the moment the round
// becomes real: the driver's own record says a round was *queued*, and the two
// disagreeing is itself the useful signal a reader is looking for.
func (r *Runtime) recordGoalRound(goal state.Goal, round int) {
	r.onEvent(audit.Event(audit.KindGoalRound, r.SessionIDValue, "", 0, map[string]any{
		"decision":        "started",
		"round":           round,
		"goal_id":         goal.ID,
		"goal_revision":   goal.Revision,
		"goal_phase":      string(goal.Phase),
		"goal_rounds":     goal.Rounds,
		"goal_max_rounds": goal.MaxRounds,
		"armed":           r.GoalArmed(),
	}))
}
