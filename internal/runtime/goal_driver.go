package runtime

import (
	"errors"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/agent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// The goal driver: the thing that starts the next round when nobody asked.
//
// Everything else about a goal is bookkeeping. This is the part that changes what
// the program does — with a goal active and armed, the session no longer stops when
// a turn ends, and the risk that creates is entirely about *when it is allowed to*.
// The design is therefore three rules and no cleverness:
//
//  1. **It is asked only at one point**: after a turn has finished and the session
//     file holds it. Not on a timer, not from a goroutine of its own. There is
//     exactly one such instant in `protocol/server.go`, and the driver is a pure
//     function of the state at that instant.
//  2. **It reserves before it runs.** The round number is claimed while the turn is
//     still being queued, and spent only when the round's prompt actually enters
//     history. A reservation that goes stale — because a person edited the goal in
//     between, or paused it — spends nothing.
//  3. **Anything that is not "the turn finished normally" disarms.** A person
//     interrupting, a model failure, a cancelled stream: each of those turns
//     autonomous work *off* rather than merely ending the current round. Ctrl+C
//     that is followed by another round is a Ctrl+C that does not work.
//
// What the driver deliberately does not do is decide whether the objective is
// achieved. That is the model's claim to make (with evidence, per the prompt) and
// the completion gate's job to check, and neither belongs in the scheduler.

// Decision is what the driver concluded about starting another round.
type Decision string

const (
	// DecisionContinue means a round was reserved and should be run.
	DecisionContinue Decision = "continue"
	// DecisionIdle means there is nothing to continue right now — no goal, or one
	// that is complete. It is not a failure and not a disarm.
	DecisionIdle Decision = "idle"
	// DecisionRefused means the loop stopped itself and the goal was disarmed: a
	// finished round with no budget left, a turn that did not finish normally, or a
	// stop request.
	DecisionRefused Decision = "refused"
)

// roundReason codes are the stable explanations written to the audit. They are
// codes rather than sentences for the same reason blocker codes are: a reader
// branching on "why did it stop" needs something a program can match.
//
// Only the codes something actually returns live here. A declared code with no
// producer reads like a state the runtime can report, and a reader who greps for it
// and finds nothing learns the wrong thing about the system.
const (
	ReasonGoalComplete    = "complete"
	ReasonGoalPaused      = "paused"
	ReasonNotArmed        = "not-armed"
	ReasonRoundLimit      = "round-limit"
	ReasonAlreadyPending  = "already-pending"
	ReasonAutomaticRound  = "automatic-round"
	ReasonStopRequested   = "stop-requested"
	ReasonCancelled       = "cancelled"
	ReasonModelFailed     = "model-failed"
	ReasonQueueFailed     = "queue-failed"
	ReasonAdmissionFailed = "admission-failed"
)

// Reservation is one claimed round.
//
// It exists so that the claim and the spending are separate acts. `Messages` is
// built at reservation time and admitted later, which is what makes the window
// between "the driver decided" and "the round started" survivable: anything that
// happens in it invalidates the reservation instead of being overwritten.
//
// The accessors exist because this type crosses into the protocol layer, which
// carries it without reading it. Fields would invite that layer to start deciding
// things about rounds.
type Reservation struct {
	goalID   string
	revision int
	round    int
	// messages is the prompt that opens the round. It is the runtime's own text,
	// marked so that nothing downstream reads it as something the user said.
	messages []map[string]any
}

// GoalID is which goal this round is for.
func (r *Reservation) GoalID() string { return r.goalID }

// Revision is the goal revision the round was reserved against.
func (r *Reservation) Revision() int { return r.revision }

// Round is the round number the reservation claims.
func (r *Reservation) Round() int { return r.round }

// Messages is the opening prompt for the round.
func (r *Reservation) Messages() []map[string]any { return r.messages }

// Driver observes finished turns and decides whether the goal gets another one.
type Driver struct {
	rt *Runtime
	// pending is the reservation that has been claimed and not yet spent or
	// dismissed. One at a time: two rounds in flight would be two turns, and turns
	// never overlap.
	pending *Reservation
}

// NewDriver builds the driver for one runtime.
func NewDriver(rt *Runtime) *Driver {
	return &Driver{rt: rt}
}

// Pending reports the claimed-but-unspent reservation, if any.
func (d *Driver) Pending() *Reservation {
	if d == nil {
		return nil
	}
	return d.pending
}

// Observe processes one finished turn and acts on it.
//
// `outcome` is what `Agent.Run` returned: nil for a turn that answered, a
// `StepLimitExceeded` for one that ran out of steps, and anything else for a turn
// that did not finish. The distinction matters more than it looks — running out of
// steps is "the budget for this turn is spent, the session is intact, carry on",
// which is exactly the case a long task hits, while a model error is a reason to
// stop and wait for a person.
//
// It queues the next round through `queue`, which is the server's own turn entry
// point, so an automatic round takes the same path as a human one: it waits for
// whatever is running, it is serialised, and it is reported the same way. A driver
// that started turns by itself would be a second scheduler.
func (d *Driver) Observe(outcome error, stopped bool, queue func(*Reservation) bool) Decision {
	if d == nil {
		return DecisionIdle
	}
	decision, reason := d.advance(outcome, stopped)
	if decision != DecisionContinue {
		if reason != "" {
			d.record(decision, reason, nil)
		}
		return decision
	}

	reservation := d.reserve()
	if reservation == nil {
		d.record(DecisionRefused, ReasonAlreadyPending, nil)
		return DecisionRefused
	}
	if queue == nil || !queue(reservation) {
		// Nothing took the round. The reservation is dropped rather than kept, so
		// the number stays unspent and the next finished turn can claim it again.
		d.pending = nil
		d.record(DecisionRefused, ReasonQueueFailed, reservation)
		return DecisionRefused
	}
	d.record(DecisionContinue, "", reservation)
	return DecisionContinue
}

// Admit validates a reservation and reports whether the round may start.
//
// This is the second half of reserve-then-admit, and it is the reason the ordering
// is worth the trouble: between the two calls a person may have sent a message,
// edited the goal, or paused it. The check is against the goal as it is **now**, so
// the answer can honestly be no.
func (d *Driver) Admit(reservation *Reservation) bool {
	if d == nil || reservation == nil || d.pending != reservation {
		return false
	}
	d.pending = nil

	current, ok := state.LoadGoal(d.rt.SessionValue.Metadata)
	if !ok || current.ID != reservation.goalID || current.Revision != reservation.revision {
		d.record(DecisionRefused, ReasonAdmissionFailed, reservation)
		return false
	}
	if current.Phase != state.PhaseActive || !d.rt.GoalArmed() || current.RoundLimitReached() {
		d.record(DecisionRefused, ReasonAdmissionFailed, reservation)
		return false
	}

	// Only now is the round spent. `AdmitGoalRound` also moves the revision, so an
	// admission is itself a change that invalidates any later reservation taken
	// against the old revision.
	if _, err := state.AdmitGoalRound(d.rt.SessionValue.Metadata, reservation.goalID, reservation.revision, reservation.round); err != nil {
		d.record(DecisionRefused, ReasonAdmissionFailed, reservation)
		return false
	}
	d.rt.Checkpoint()
	d.record(DecisionContinue, "", reservation)
	return true
}

// advance decides whether another round is allowed, and normalises the armed flag.
//
// The armed flag is written here rather than only when a round is refused. The
// difference between "armed but not running yet" and "disarmed" is what
// `get_goal` reports and what the payload tail says every round, and a flag that is
// only ever cleared would report a session as ready to continue when it is not.
func (d *Driver) advance(outcome error, stopped bool) (Decision, string) {
	goal, ok := state.LoadGoal(d.rt.SessionValue.Metadata)
	if !ok {
		return DecisionIdle, ""
	}

	// A stop request is the strongest signal there is: the person wants this to
	// stop, and the only acceptable response is to stop *and* turn continuation
	// off. Ending the round but arming the next one is the failure this rule exists
	// to prevent.
	if stopped {
		d.rt.SetGoalArmed(false)
		return DecisionRefused, ReasonStopRequested
	}
	if outcome != nil {
		// A step limit is checked **before** the disarm, because it is the one
		// outcome that means "carry on": the turn spent this turn's step budget and
		// the session is intact. Disarming first and asking afterwards would make
		// the round budget unreachable — a long task dies on the first turn that
		// hits the step cap, which is precisely the case the goal exists for.
		if isStepLimit(outcome) {
			return DecisionContinue, ""
		}
		d.rt.SetGoalArmed(false)
		if isTurnCancelled(outcome) {
			return DecisionRefused, ReasonCancelled
		}
		return DecisionRefused, ReasonModelFailed
	}

	switch goal.Phase {
	case state.PhaseComplete:
		d.rt.SetGoalArmed(false)
		return DecisionIdle, ReasonGoalComplete
	case state.PhasePaused:
		d.rt.SetGoalArmed(false)
		return DecisionRefused, ReasonGoalPaused
	case state.PhaseBlocked:
		// Already stopped, and by something with a reason attached. Repeating the
		// reason on every subsequent turn would fill the log with the same line.
		d.rt.SetGoalArmed(false)
		return DecisionIdle, ""
	}

	if !d.rt.GoalArmed() {
		return DecisionRefused, ReasonNotArmed
	}
	if goal.RoundLimitReached() {
		d.rt.SetGoalArmed(false)
		return DecisionRefused, ReasonRoundLimit
	}
	// **A turn that was itself an automatic round does not get another one.**
	//
	// This is the rule that keeps the loop from chaining without a person in it:
	// one authorization produces one round, and the round after that needs either
	// the user to say something more or the model to have called `update_goal
	// resume` inside a turn a person started. Without it, a single arming would
	// spend the whole round budget back to back with nobody watching.
	//
	// The converse is what makes the feature work at all: after a **human** turn
	// the goal keeps its arming, because that turn is where the authorization came
	// from. Refusing there would make a goal created in a person's turn stop
	// immediately — the exact failure this batch exists to fix.
	if state.IsGoalRound(lastMessage(d.rt.SessionValue.Messages)) {
		d.rt.SetGoalArmed(false)
		return DecisionRefused, ReasonAutomaticRound
	}
	return DecisionContinue, ""
}

// lastMessage is the newest message, or nil for an empty history.
func lastMessage(messages []map[string]any) map[string]any {
	if len(messages) == 0 {
		return nil
	}
	return messages[len(messages)-1]
}

// reserve claims the next round number.
//
// Nothing is written down: the reservation is a value in memory, because a
// reservation is a plan and plans do not belong in a file that has to survive a
// crash. If the process dies between reserving and admitting, the file still says
// the round was never spent, which is true.
//
// One at a time. A second reservation while one is unspent would be a claim on a
// round number that the first claim has not yet given up, and admitting either of
// them would make the other's number wrong.
func (d *Driver) reserve() *Reservation {
	if d.pending != nil {
		return nil
	}
	goal, ok := state.LoadGoal(d.rt.SessionValue.Metadata)
	if !ok || goal.Phase != state.PhaseActive {
		return nil
	}
	round := goal.Rounds + 1
	d.pending = &Reservation{
		goalID:   goal.ID,
		revision: goal.Revision,
		round:    round,
		messages: []map[string]any{state.GoalRoundPrompt(goal, round)},
	}
	return d.pending
}

// ObserveTurn is the protocol layer's view of `Observe`.
//
// The adapter exists so that neither side has to know the other's types: the
// protocol layer carries an opaque `protocol.GoalRound` interface, which
// `*Reservation` satisfies by shape, and the runtime keeps its `Decision` to
// itself. `queue` is called at most once per turn.
func (r *Runtime) ObserveTurn(outcome error, stopped bool, queue func(protocol.GoalRound) bool) string {
	if r.Driver == nil {
		return string(DecisionIdle)
	}
	decision := r.Driver.Observe(outcome, stopped, func(reservation *Reservation) bool {
		if queue == nil {
			return false
		}
		return queue(reservation)
	})
	return string(decision)
}

// record writes the driver's decision to the audit. It never fails the turn: the
// same rule the rest of the audit path follows — observation must not be able to
// damage what it observes.
func (d *Driver) record(decision Decision, reason string, reservation *Reservation) {
	if d.rt == nil {
		return
	}
	data := map[string]any{
		"decision": string(decision),
		"armed":    d.rt.GoalArmed(),
	}
	if reason != "" {
		data["reason"] = reason
	}
	if goal, ok := state.LoadGoal(d.rt.SessionValue.Metadata); ok {
		data["goal_id"] = goal.ID
		data["goal_revision"] = goal.Revision
		data["goal_phase"] = string(goal.Phase)
		data["goal_rounds"] = goal.Rounds
		data["goal_max_rounds"] = goal.MaxRounds
	} else {
		data["goal_present"] = false
	}
	if reservation != nil {
		data["round"] = reservation.round
	}
	d.rt.onEvent(audit.Event(audit.KindGoalRound, d.rt.SessionIDValue, "", 0, data))
}

// isTurnCancelled reports whether a turn ended because somebody asked it to.
//
// A type test, not a message match: the agent's cancellation is a distinct type so
// that "the user interrupted" can be told apart from "something broke", and
// matching on text would throw that distinction away and then break the day
// somebody rewords the sentence.
func isTurnCancelled(err error) bool {
	var cancelled agent.RunCancelled
	return errors.As(err, &cancelled)
}

// isStepLimit reports whether a turn ended because it ran out of steps.
//
// This is the one error that means "carry on". It is not a failure: the session is
// intact, every tool result is paired, and the only thing that ran out is this
// turn's step budget — which is exactly what the next round is for.
func isStepLimit(err error) bool {
	var limited *agent.StepLimitExceeded
	return errors.As(err, &limited)
}
