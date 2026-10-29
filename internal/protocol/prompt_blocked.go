package protocol

import (
	"errors"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/hooks"
)

// asPromptBlocked reports whether this turn never started because a
// `user_prompt_submit` hook refused the message.
//
// The protocol layer needs the distinction and nothing else about the hook layer —
// it is the same shape as `isCancel`, one type test, and it keeps this package from
// importing the executor. `hooks.PromptBlocked` stays the single definition of what
// a refusal is, so the two ends cannot drift into two spellings of one error.
func asPromptBlocked(err error) (*hooks.PromptBlocked, bool) {
	var blocked *hooks.PromptBlocked
	if errors.As(err, &blocked) {
		return blocked, true
	}
	return nil, false
}

// closeForSwitch closes a runtime because another one is taking its place.
//
// All three call sites — a session switch, deleting the mounted session, a fork
// opening its copy — are the same event from the runtime's point of view: this
// session is being put down while somebody else is still looking at it. They go
// through one function so `session_end.reason` is reported the same way by all
// three, and so the optional interface below has one spelling.
//
// A runtime that does not implement the labeller is closed the ordinary way: the
// hook then sees `shutdown`, which is the conservative direction — claiming a
// switch that did not happen is worse than being vague about one that did.
func closeForSwitch(runtime Runtime) error {
	if switcher, ok := runtime.(interface{ CloseForSwitch() error }); ok {
		return switcher.CloseForSwitch()
	}
	return runtime.Close()
}
