// Package model is the one place that knows what a chat completion looks like.
//
// Above it, the agent asks for "a completion given these messages and tools" and
// gets a ModelResponse back. Below it sits whichever OpenAI-compatible endpoint
// the user configured. Nothing above this package knows the wire format, and
// nothing in it knows about tools, permissions or sessions.
package model

import (
	"errors"
	"fmt"
)

// Error is the base class for everything this package raises.
//
// The two subclasses exist because retrying is a decision, and a decision needs a
// classification. Everything above this package sees only these two; SDK-specific
// errors are translated here and never escape.
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

// TransientError is worth retrying: network trouble, a timeout, a rate limit, a
// server-side hiccup.
type TransientError struct{ Msg string }

func (e *TransientError) Error() string { return e.Msg }

// FatalError will not get better by trying again: a bad key, a malformed request,
// a model that does not exist.
type FatalError struct{ Msg string }

func (e *FatalError) Error() string { return e.Msg }

// IsFatal reports whether an error should stop the retry loop immediately.
//
// Anything unrecognised counts as fatal. Failing fast on an error we do not
// understand is the safe direction: retrying three times against something that
// will never work just delays the report by three round trips.
func IsFatal(err error) bool {
	var fatal *FatalError
	return errors.As(err, &fatal)
}

// AsTransient wraps a message as a retryable failure.
func AsTransient(format string, args ...any) error {
	return &TransientError{Msg: fmt.Sprintf(format, args...)}
}

// AsFatal wraps a message as a permanent failure.
func AsFatal(format string, args ...any) error {
	return &FatalError{Msg: fmt.Sprintf(format, args...)}
}

// TokenUsage is what one call cost.
type TokenUsage struct {
	PromptTokens     int
	CachedTokens     int
	CompletionTokens int
}

// MissTokens is the part of the prompt that was not served from cache.
func (u TokenUsage) MissTokens() int {
	if u.PromptTokens > u.CachedTokens {
		return u.PromptTokens - u.CachedTokens
	}
	return 0
}

// ToolCall is one call the model asked for.
type ToolCall struct {
	ID        string
	Name      string
	Arguments string
}

// ModelResponse is one completed model turn.
type ModelResponse struct {
	// Content is nil, not empty, on a turn that only asked for tools. The
	// difference matters: an empty string would be appended to the history as
	// "the model said nothing", which is not what happened.
	Content   *string
	ToolCalls []ToolCall
	Usage     *TokenUsage
	// Reasoning is the model's thinking, when the gateway reports it. It goes to
	// the audit and to the interface; it is never fed back into the next request.
	Reasoning *string
	// Streamed reports whether this turn was delivered incrementally.
	Streamed bool
	// StreamChunks counts both kinds of increment (text and reasoning). It is
	// what lands in the audit instead of the stream itself.
	StreamChunks int
}

// StreamedChars is how much text passed through the stream.
func (r ModelResponse) StreamedChars() int {
	if r.Content == nil {
		return 0
	}
	return len([]rune(*r.Content))
}

// DeltaSink receives one increment. Both parameters are the **new** piece, not the
// running total: accumulating is the caller's job.
//
// The two channels are separate fields rather than a tagged union because both
// carry strings, and routing them wrongly puts a stretch of the model thinking
// out loud into the middle of the answer — which then looks like a model problem
// rather than a plumbing problem.
type DeltaSink func(text, reasoning string)

// CompleteOptions carries the callbacks one request may want.
type CompleteOptions struct {
	// OnDelta receives stream increments. When it is nil the request is not
	// streamed at all: asking for a stream nobody reads costs the same and
	// delivers less.
	OnDelta DeltaSink
	// OnAttemptStarted runs before each attempt, including the first. It lets the
	// interface drop the half-written text of the previous attempt before the
	// next one restates the whole thing.
	OnAttemptStarted func()
}

// ChatModel is what the agent talks to.
type ChatModel interface {
	// Complete runs one request. The returned error is always a *TransientError
	// or a *FatalError.
	Complete(messages []map[string]any, tools []map[string]any, options CompleteOptions) (ModelResponse, error)
	// SwitchModel changes the model for subsequent requests. It returns false when
	// this adapter cannot do that mid-session.
	SwitchModel(name string) bool
	// SetReasoning updates the two thinking knobs for subsequent requests.
	SetReasoning(thinking bool, effort string)
	// ModelName is the model currently in use.
	ModelName() string
	// ProviderName is the route currently in use.
	ProviderName() string
	// BaseURL is where requests currently go.
	BaseURL() string
}
