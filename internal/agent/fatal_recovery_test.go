package agent

import (
	"testing"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
)

// TestAFatalErrorIsOfferedToOnFatalBeforeItIsReported — the hook exists to give a
// caller that can replace a credential one chance to do it, and the loop has to ask
// before it gives up.
//
// The retry is **immediate**: nothing was overloaded, so the person should not wait
// out a backoff for a failure that was already fixed.
func TestAFatalErrorIsOfferedToOnFatalBeforeItIsReported(t *testing.T) {
	refusal := &model.CredentialError{Msg: "HTTP 401 from https://eric.example: invalid token"}
	chat := &recordingModel{errs: []error{refusal, nil}}

	offered := 0
	waited := 0
	answer, err := CallWithRetry(chat, nil, nil, model.CompleteOptions{}, RetryHooks{
		OnFatal: func(err error) bool { offered++; return true },
		Sleep:   func(time.Duration) { waited++ },
	})

	if err != nil {
		t.Fatalf("a recovered refusal still failed the call: %v", err)
	}
	if answer.Content == nil || *answer.Content != "ok" {
		t.Fatalf("the retry's answer was not returned: %+v", answer)
	}
	if chat.calls != 2 {
		t.Errorf("the model was called %d times, want 2 (the refusal, then the retry)", chat.calls)
	}
	if offered != 1 {
		t.Errorf("OnFatal was offered the error %d times, want 1", offered)
	}
	if waited != 0 {
		t.Errorf("the recovery was backed off %d times; a fixed credential needs no wait", waited)
	}
}

// TestAnUnrecoveredFatalErrorIsReportedAtOnce is the other half, and it is the one
// that protects the common case: a 401 nobody can fix must not become three
// identical requests three round trips later.
func TestAnUnrecoveredFatalErrorIsReportedAtOnce(t *testing.T) {
	refusal := &model.CredentialError{Msg: "HTTP 401"}
	chat := &recordingModel{errs: []error{refusal, nil}}

	_, err := CallWithRetry(chat, nil, nil, model.CompleteOptions{}, RetryHooks{
		OnFatal: func(error) bool { return false },
	})

	if !model.IsFatal(err) {
		t.Fatalf("err = %v, want the fatal refusal", err)
	}
	if chat.calls != 1 {
		t.Errorf("the model was called %d times, want 1: a refused recovery must not retry", chat.calls)
	}
}

// TestEveryOtherFatalErrorStillStopsTheLoop — the hook is asked about every fatal
// error, and a caller whose recovery is narrow (only credential refusals) has to be
// able to say no. A hook that answered yes to everything would turn a permanently
// bad request into a loop.
func TestEveryOtherFatalErrorStillStopsTheLoop(t *testing.T) {
	bad := model.AsFatal("HTTP 400: unknown model")
	chat := &recordingModel{errs: []error{bad}}

	_, err := CallWithRetry(chat, nil, nil, model.CompleteOptions{}, RetryHooks{
		OnFatal: func(error) bool { return false },
	})

	if !model.IsFatal(err) {
		t.Fatalf("err = %v, want the fatal error", err)
	}
	if chat.calls != 1 {
		t.Errorf("the model was called %d times, want 1", chat.calls)
	}
}

// TestTheRecoveryLatchIsPerTurn pins the guard that makes the hook safe: the agent
// answers yes at most once per turn, because the retry loop cannot tell "fixed it"
// from "believes it fixed it".
//
// A latch that survived the turn would be the worse failure of the two: the next
// time the token genuinely expired, the recovery would silently refuse to run and
// the session would look broken for no reason on screen.
func TestTheRecoveryLatchIsPerTurn(t *testing.T) {
	a := &Agent{Config: Config{
		OnFatal: func(error) bool { return true },
	}}

	if !a.recoverFromFatal(model.AsFatal("first")) {
		t.Fatal("the first fatal error was not offered to the hook")
	}
	if a.recoverFromFatal(model.AsFatal("second")) {
		t.Fatal("a second fatal error in the same turn was recovered; the latch is not holding")
	}
}
