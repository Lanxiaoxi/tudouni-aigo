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
		d.Discard(reservation)
		d.record(DecisionRefused, ReasonQueueFailed, reservation)
		return DecisionRefused
	}
	d.record(DecisionContinue, "", reservation)
	return DecisionContinue
}

// Discard releases a reservation without spending it, and reports whether there was
// one to release.
//
// It is the **one** place a claim stops being held, and that is the whole point of
// it. Every path that consumes a claim, abandons one, or discovers it is unusable
// goes through here, so "a reservation that has been dealt with is not still held"
// is a property of the type instead of something each caller has to remember. The
// version before it wrote the release into `Admit` alone, and the automatic round's
// own entry point — which did its own admitting — left the claim held. The next
// finished turn then found `pending` occupied, refused it as `already-pending`, and
// that goal ran exactly one round for the life of the process: not even a later
// message from the person could start another, because nothing ever released the
// claim the first round had already spent.
//
// Nil receivers and nil reservations answer false rather than panicking. The callers
// are refusal paths, and a refusal path that can crash is worse than the refusal it
// was there to report.
func (d *Driver) Discard(reservation *Reservation) bool {
	if d == nil || reservation == nil || d.pending != reservation {
		return false
	}
	d.pending = nil
	return true
}

// Admit validates a reservation, spends the round, and reports the admitted goal.
//
// This is the second half of reserve-then-admit, and it is the reason the ordering
// is worth the trouble: between the two calls a person may have sent a message,
// edited the goal, or paused it. The check is against the goal as it is **now**, so
// the answer can honestly be no.
//
// The goal comes back rather than just a yes, because the caller that runs the round
// has to record which revision of which goal it actually ran — and this is the only
// place that knows. Reporting the admission off the session instead would let a
// person's edit in the gap be attributed to the round that was refused.
//
// Releasing the claim comes **first**, before any check that can fail. A stale
// reservation is not a reservation that should be kept: the whole reason to hold one
// is that a later round may spend it, and a round that has just been refused will
// never be that. Doing the release last means every early return leaks, which is the
// defect this ordering exists to make unrepresentable.
func (d *Driver) Admit(reservation *Reservation) (state.Goal, bool) {
	if !d.Discard(reservation) {
		return state.Goal{}, false
	}

	current, ok := state.LoadGoal(d.rt.SessionValue.Metadata)
	if !ok || current.ID != reservation.goalID || current.Revision != reservation.revision {
		d.record(DecisionRefused, ReasonAdmissionFailed, reservation)
		return state.Goal{}, false
	}
	if current.Phase != state.PhaseActive || !d.rt.GoalArmed() || current.RoundLimitReached() {
		d.record(DecisionRefused, ReasonAdmissionFailed, reservation)
		return state.Goal{}, false
	}

	// Only now is the round spent. `AdmitGoalRound` also moves the revision, so an
	// admission is itself a change that invalidates any later reservation taken
	// against the old revision.
	admitted, err := state.AdmitGoalRound(d.rt.SessionValue.Metadata, reservation.goalID, reservation.revision, reservation.round)
	if err != nil {
		d.record(DecisionRefused, ReasonAdmissionFailed, reservation)
		return state.Goal{}, false
	}
	d.rt.Checkpoint()
	// No record here. The decision was already written when the round was
	// reserved, and the fact that it *ran* is the caller's to write —
	// `StartGoalRound` writes it as `started`. Writing "continue" again from this
	// point would put two identical lines in the log for one round and no way to
	// tell the claim from the admission.
	return admitted, true
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
	// A step limit is the one outcome that means "carry on": the turn spent this
	// turn's step budget, every tool result is paired and the session is intact.
	// That is what a long task hits first, so it is checked **before** the disarm —
	// disarming first would make the round budget unreachable, and the goal would
	// die on the first turn that hit the step cap.
	//
	// It also carries past the automatic-round rule at the bottom. That rule exists
	// so one authorization does not spend the whole budget back to back, and a round
	// that ran out of steps has not finished the work it was authorized for: a
	// goal whose rounds each end at the cap would otherwise get exactly one round
	// per message from a person, which is the case the round budget is there for.
	// A round that *answered* is a different thing and still stops.
	stepLimited := outcome != nil && isStepLimit(outcome)
	if outcome != nil && !stepLimited {
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
	//
	// "Was this turn an automatic round" is asked of the turn's **opener**, not of
	// the newest message. This check used to read `IsGoalRound(lastMessage(...))`,
	// and that question has no answer in production: a turn that has finished ends
	// on the assistant's answer, or on the tool result of its last step, so the
	// round's own prompt is never the newest message by the time the driver is
	// asked. The rule was therefore never the thing stopping the chain — the leaked
	// reservation was, and it stopped it by refusing *every* subsequent round
	// instead of the one it was written for.
	//
	// A step-capped round is exempt, and that exemption is the whole reason the
	// check above is not an early return: a round that ran out of steps did not
	// finish the work it was authorized for, so stopping there would give a long
	// task exactly one round per message from a person. A round that *answered* has
	// spent its authorization and stops.
	if !stepLimited && d.rt.SessionValue.TurnOrigin() == state.TurnOriginAutomatic {
		d.rt.SetGoalArmed(false)
		return DecisionRefused, ReasonAutomaticRound
	}
	return DecisionContinue, ""
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
