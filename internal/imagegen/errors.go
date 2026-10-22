package imagegen

import (
	"errors"
	"fmt"
)

// The error classes are the whole of this file, and they exist for one reason:
// **the caller above needs to know who has to fix what**.
//
// A failure the model can fix by changing an argument is a sentence it should
// read. A failure only a person can fix is an error, because retrying it would
// burn a step and teach the model that the tool lies. The split is the same one
// `present` draws, and it is drawn in the same place: the tool, not the
// transport.

// RequestError is a malformed request or an answer this build cannot use.
//
// It covers the 4xx that are neither a policy refusal nor a credential
// refusal — 404 above all, which is what an inherited base URL produces when
// the endpoint does not offer `/images/generations`.
type RequestError struct{ Msg string }

func (e *RequestError) Error() string { return e.Msg }

// CredentialError is a refusal of the key.
//
// The endpoint answered, and it said the credential is not acceptable. No
// amount of retrying changes that; somebody has to look at the key.
type CredentialError struct{ Msg string }

func (e *CredentialError) Error() string { return e.Msg }

// PolicyError is the endpoint refusing the content of the prompt.
//
// This is the one failure where the message to the model matters most: the
// endpoint has already decided, and a request that repeats itself is
// observable behaviour on the provider's side, charged to the user's account.
// So the answer to the model has to say "do not send this again", and it has to
// offer the way out that actually works.
type PolicyError struct{ Msg string }

func (e *PolicyError) Error() string { return e.Msg }

// RateLimitError is a 429.
//
// Worth retrying, and the endpoint may have said how long to wait.
type RateLimitError struct{ Msg string }

func (e *RateLimitError) Error() string { return e.Msg }

// ServerError is a 5xx.
type ServerError struct{ Msg string }

func (e *ServerError) Error() string { return e.Msg }

// TimeoutError is a request that ran out of time.
type TimeoutError struct{ Msg string }

func (e *TimeoutError) Error() string { return e.Msg }

// CancelledError is the turn being stopped mid-generation.
//
// A distinct class rather than a network failure: the endpoint was never at
// fault, and the model must not be told to try a different prompt.
type CancelledError struct{ Msg string }

func (e *CancelledError) Error() string { return e.Msg }

// NetworkError is a connection that could not be made or read.
type NetworkError struct{ Msg string }

func (e *NetworkError) Error() string { return e.Msg }

// NotAnImageError is an answer that is not a picture.
//
// Zero bytes, a `text/html` body, a body that is not base64, a URL that is not
// http. One class, because the model has one thing to do about all of them:
// treat it as "the endpoint did not give me a picture".
type NotAnImageError struct{ Msg string }

func (e *NotAnImageError) Error() string { return e.Msg }

// TooLargeError is a picture over the ceiling.
type TooLargeError struct{ Msg string }

func (e *TooLargeError) Error() string { return e.Msg }

// IsCancelled reports whether the failure was the turn being stopped.
func IsCancelled(err error) bool {
	var cancelled *CancelledError
	return errors.As(err, &cancelled)
}

// IsCredential reports whether the failure was a refused credential.
func IsCredential(err error) bool {
	var refusal *CredentialError
	return errors.As(err, &refusal)
}

// IsPolicy reports whether the failure was the endpoint refusing the content.
func IsPolicy(err error) bool {
	var refusal *PolicyError
	return errors.As(err, &refusal)
}

// IsRateLimit reports whether the failure was a rate limit.
func IsRateLimit(err error) bool {
	var refusal *RateLimitError
	return errors.As(err, &refusal)
}

// IsServer reports whether the failure was the endpoint's own fault.
func IsServer(err error) bool {
	var failure *ServerError
	return errors.As(err, &failure)
}

// IsTimeout reports whether the failure was a timeout.
func IsTimeout(err error) bool {
	var timeout *TimeoutError
	return errors.As(err, &timeout)
}

// IsNotAnImage reports whether the endpoint answered with something that is not
// a picture.
func IsNotAnImage(err error) bool {
	var failure *NotAnImageError
	return errors.As(err, &failure)
}

// IsTooLarge reports whether the picture was over the ceiling.
func IsTooLarge(err error) bool {
	var failure *TooLargeError
	return errors.As(err, &failure)
}

// IsRequest reports whether the request itself was refused.
func IsRequest(err error) bool {
	var failure *RequestError
	return errors.As(err, &failure)
}

// errorsAs is errors.As, named locally so the call sites in this package read
// as one idea rather than two.
func errorsAs(err error, target any) bool { return errors.As(err, target) }

// errorf is fmt.Errorf, named locally for the same reason.
func errorf(format string, args ...any) error { return fmt.Errorf(format, args...) }
