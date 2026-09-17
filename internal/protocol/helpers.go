package protocol

import (
	"errors"
	"runtime"
	"strconv"
)

func itoa(value int) string { return strconv.Itoa(value) }

func isWindowsPlatform() bool { return runtime.GOOS == "windows" }

// closedChan returns an already-closed channel, which is what "no turn is running"
// looks like to joinTurn.
func closedChan() chan struct{} {
	done := make(chan struct{})
	close(done)
	return done
}

// isCancel reports whether an error is the agent's "this turn was interrupted".
//
// It matches on the error text rather than on the type because the protocol layer
// must not import the agent: the dependency would point the wrong way and make the
// boundary a formality. The text is fixed by the agent package for exactly this
// reason.
func isCancel(err error) bool {
	if err == nil {
		return false
	}
	var cancelled interface{ Error() string }
	if errors.As(err, &cancelled) {
		return cancelled.Error() == "this turn was interrupted"
	}
	return false
}
