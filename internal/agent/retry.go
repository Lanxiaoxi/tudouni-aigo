// Package agent is the loop: one model call, then the tools it asked for, then
// another model call, until the model answers or the budget runs out.
//
// Everything here is written around one invariant, and it is worth stating
// before any of the code: **an assistant message that carries `tool_calls` must
// be followed by a tool result for every one of those ids.** Break it and the
// session can never be sent again — the endpoint answers 400 for every later
// turn, and the error looks like "the context is too long". So the only moments a
// session is allowed to be written down are between whole steps, and the
// checkpoint is called only at those moments.
package agent

import (
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
)

// Retry policy.
//
// Three attempts, backing off 0.5s then 1.0s and capped at 8s. The numbers are not
// tuned to anything subtle: long enough to ride out a rate limit, short enough
// that a real outage is reported while the user is still looking at the screen.
const (
	MaxAttempts = 3
	BackoffBase = 0.5
	BackoffCap  = 8.0
)

// Attempt is one try at a model call, as it is recorded in the audit.
type Attempt struct {
	Number     int
	Status     string // "ok" | "error" | "fatal"
	DurationMs int
	Error      string
	Response   *model.ModelResponse
	BackoffMs  *int
}

// RetryHooks are the moments the loop above needs to know about.
type RetryHooks struct {
	// BeforeEach runs before every attempt, including the first.
	//
	// It is how a half-written answer is dropped before its replacement starts.
	// Without it a retry after a partial stream leaves two answers joined end to
	// end, which reads as the model saying everything twice rather than as a
	// plumbing event.
	BeforeEach func()
	// OnRetry runs only when a retry will actually happen, with the backoff the
	// runtime is about to take. Recording a wait that never happened would make
	// the audit claim delays that did not occur.
	OnRetry func(backoffMs int)
	// OnAttempt records the outcome of every attempt.
	OnAttempt func(Attempt)
	// ShouldStop abandons the call between attempts, and is handed to the adapter
	// as well so a stream in flight can be dropped.
	//
	// It has to be consulted **between** attempts too, not only during the model
	// call: a user who presses stop during a backoff would otherwise wait out the
	// delay and then see the request go again.
	ShouldStop func() bool
	// Sleep is injected so tests do not spend real time waiting.
	Sleep func(d time.Duration)
}

// CallWithRetry runs one model call, retrying only the failures worth retrying.
//
// A fatal error is raised immediately. Retrying a bad key, or a model name that
// does not exist, repeats the same failure three times and delays the report by
// three round trips — and the audit then shows three failures where there was
// one problem.
func CallWithRetry(
	chat model.ChatModel,
	messages []map[string]any,
	toolSchemas []map[string]any,
	options model.CompleteOptions,
	hooks RetryHooks,
) (model.ModelResponse, error) {
	sleep := hooks.Sleep
	if sleep == nil {
		sleep = time.Sleep
	}

	var lastErr error
	for number := 1; number <= MaxAttempts; number++ {
		if hooks.ShouldStop != nil && hooks.ShouldStop() {
			return model.ModelResponse{}, RunCancelled{}
		}
		if hooks.BeforeEach != nil {
			hooks.BeforeEach()
		}

		started := time.Now()
		response, err := chat.Complete(messages, toolSchemas, options)
		durationMs := int(time.Since(started).Milliseconds())

		if err == nil {
			if hooks.OnAttempt != nil {
				copied := response
				hooks.OnAttempt(Attempt{Number: number, Status: "ok", DurationMs: durationMs, Response: &copied})
			}
			return response, nil
		}
		// A cancelled turn is not a failure: nothing was learned about the model,
		// and retrying would send the request the user just asked to abandon.
		if model.IsCancelled(err) {
			return model.ModelResponse{}, RunCancelled{}
		}

		fatal := model.IsFatal(err)
		status := "error"
		if fatal {
			status = "fatal"
		}

		var wait int
		var backoffMs *int
		if !fatal && number < MaxAttempts {
			wait = backoffMillis(number)
			backoffMs = &wait
		}
		if hooks.OnAttempt != nil {
			hooks.OnAttempt(Attempt{
				Number: number, Status: status, DurationMs: durationMs,
				Error: err.Error(), BackoffMs: backoffMs,
			})
		}

		if fatal {
			return model.ModelResponse{}, err
		}
		lastErr = err

		if wait > 0 {
			if hooks.OnRetry != nil {
				hooks.OnRetry(wait)
			}
			sleep(time.Duration(wait) * time.Millisecond)
		}
	}
	return model.ModelResponse{}, lastErr
}

// backoffMillis is the wait before the attempt that follows `completed` tries:
// 500ms after the first, 1s after the second, and so on up to the cap.
func backoffMillis(completed int) int {
	wait := BackoffBase * float64(int(1)<<uint(completed-1))
	if wait > BackoffCap {
		wait = BackoffCap
	}
	return int(wait * 1000)
}
