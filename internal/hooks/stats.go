package hooks

import "time"

// What each hook has done in this process.
//
// The audit log already has one row per execution, but a front end has no audit file
// to read (the desktop reads none), and "did my script run, and how did it end" is the
// first question a person asks after writing one. The answer is kept here, next to the
// executor that produced it, so there is one source for it: `Fire` records an outcome in
// the same breath as it writes the audit row.
//
// **It is the session's memory and nothing more.** It is not persisted and it does not
// aggregate across sessions, because a number that silently mixed two processes' runs
// would be a claim about a history this process never saw.

// StatusCancelled is the outcome of a hook that was still running when the turn was
// interrupted. The executor records it as a timeout carrying `Cancelled`; it is its own
// word here because "the person pressed stop" must not be read as "your script is slow".
const StatusCancelled = "cancelled"

// statKey names one configured hook across the three things that make it unique: the
// file it came from, the event it listens to, and its name. Two files may each define a
// hook called `guard`, and "which of them failed" is the question the key exists to answer.
type statKey struct {
	source string
	event  Event
	name   string
}

// LastRun is how a hook's most recent execution ended.
type LastRun struct {
	// Status is one of the `Status*` words, or `StatusCancelled`. It is the executor's
	// own vocabulary and is not translated: it is what the audit log says, so it is what
	// a person will search for.
	Status     string
	At         time.Time
	DurationMs int
	// ExitCode is nil when the process never produced one (it did not start, or it was
	// killed). Nil and 0 are different facts.
	ExitCode *int
	// Reason is the executor's own preview of why — for a crash, the exit code and the
	// start of stderr. It is user text, clipped by the executor; it is not clipped again.
	Reason string
	// Tool is the tool the invocation was about, when the event had one.
	Tool string
}

// Stats is one hook's record for this process.
type Stats struct {
	// Runs counts executions that actually started a process. A hook that was skipped
	// because an earlier one refused did not run, and counting it would make a refusing
	// guardrail look busier than the hooks behind it.
	Runs int
	// Failures counts the runs that ended in something other than a clean answer. A
	// refusal (`denied`) is a clean answer — the guardrail doing its job — and an
	// interruption is not the hook's doing.
	Failures int
	Last     *LastRun
}

// The words a front end uses to say how a run ended. Five and not ten: the executor's
// statuses are precise because an audit reader needs the repair, while a person looking at
// a list wants the verdict, so `OutcomeClass` folds the statuses into it and the raw status
// still travels beside it for anybody who wants to search the log.
const (
	// ClassSuccess: the script ran and gave a usable answer (possibly "no opinion").
	ClassSuccess = "success"
	// ClassRefused: the script ran and said no. That is a guardrail working, so it is not
	// a failure and is never counted as one.
	ClassRefused = "refused"
	// ClassFailed: the script did not produce a usable answer — it could not be started,
	// ran out of time, printed something that is not a decision, or printed too much.
	ClassFailed = "failed"
	// ClassCrashed: the script started and exited abnormally (a non-zero exit code other
	// than the deliberate 2).
	ClassCrashed = "crashed"
	// ClassCancelled: the turn was interrupted while the script was running. Not the
	// script's doing, and kept apart so it is never read as "your script is slow".
	ClassCancelled = "cancelled"
)

// OutcomeClass folds an executor status into the five words above.
func OutcomeClass(status string) string {
	switch status {
	case StatusOK:
		return ClassSuccess
	case StatusDenied:
		return ClassRefused
	case StatusExit:
		return ClassCrashed
	case StatusTimeout, StatusSpawn, StatusBadOutput, StatusTruncated:
		return ClassFailed
	case StatusCancelled:
		return ClassCancelled
	default:
		// A status this build does not know is not assumed to be fine.
		return ClassFailed
	}
}

// failureStatus reports whether a status means the hook did not do its job.
func failureStatus(status string) bool {
	class := OutcomeClass(status)
	return class == ClassFailed || class == ClassCrashed
}

// remember records one finished invocation.
//
// A skipped hook is not recorded: it did not run. Called after the outcome has been
// tightened, so a workspace hook's record is the one that took effect.
func (s *Set) remember(outcome Outcome) {
	if s == nil || outcome.Status == StatusSkipped {
		return
	}
	status := outcome.Status
	if outcome.Cancelled {
		status = StatusCancelled
	}
	last := LastRun{
		Status:     status,
		At:         time.Now(),
		DurationMs: outcome.DurationMs,
		Reason:     outcome.ReasonPreview,
		Tool:       outcome.Tool,
	}
	if outcome.ExitCode != nil {
		// A copy: the outcome belongs to the caller and may be reused.
		code := *outcome.ExitCode
		last.ExitCode = &code
	}

	key := statKey{source: outcome.Source, event: outcome.Event, name: outcome.Hook}
	s.statsMu.Lock()
	defer s.statsMu.Unlock()
	if s.stats == nil {
		s.stats = map[statKey]*Stats{}
	}
	entry := s.stats[key]
	if entry == nil {
		entry = &Stats{}
		s.stats[key] = entry
	}
	entry.Runs++
	if failureStatus(status) {
		entry.Failures++
	}
	entry.Last = &last
}

// StatsFor returns what one hook has done in this process. The second result is false
// for a hook that has not run yet, which is a different statement from a hook that ran
// and succeeded.
func (s *Set) StatsFor(source string, event Event, name string) (Stats, bool) {
	if s == nil {
		return Stats{}, false
	}
	s.statsMu.Lock()
	defer s.statsMu.Unlock()
	entry := s.stats[statKey{source: source, event: event, name: name}]
	if entry == nil {
		return Stats{}, false
	}
	out := *entry
	if entry.Last != nil {
		// A copy, so the caller never holds a pointer into a record `remember` mutates.
		last := *entry.Last
		out.Last = &last
	}
	return out, true
}
