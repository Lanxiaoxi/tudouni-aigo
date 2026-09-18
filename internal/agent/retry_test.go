package agent

import (
	"testing"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
)

// TestAStopBetweenAttemptsAbandonsTheCall pins the half of "stop" that is easy to
// miss: the check has to run **between** attempts too.
//
// A user who presses stop during a backoff would otherwise wait out the delay and
// then watch the request go out again — which reads as the interface ignoring them.
func TestAStopBetweenAttemptsAbandonsTheCall(t *testing.T) {
	chat := &recordingModel{errs: []error{model.AsTransient("boom"), nil}}
	stopped := false
	attempts := 0

	_, err := CallWithRetry(chat, nil, nil, model.CompleteOptions{}, RetryHooks{
		ShouldStop: func() bool { return stopped },
		Sleep:      func(time.Duration) { stopped = true },
		OnAttempt:  func(Attempt) { attempts++ },
	})

	if !IsRunCancelled(err) {
		t.Fatalf("err = %v, want RunCancelled", err)
	}
	if chat.calls != 1 {
		t.Errorf("the model was called %d times, want 1: the retry went out anyway", chat.calls)
	}
	if attempts != 1 {
		t.Errorf("recorded %d attempts, want 1 (the first failure)", attempts)
	}
}

// TestACancelledStreamIsNotRetried: an interrupted turn is not a model failure, so
// it must neither be retried nor recorded as an error attempt.
func TestACancelledStreamIsNotRetried(t *testing.T) {
	chat := &recordingModel{errs: []error{model.CancelledError{}, nil}}
	attempts := 0

	_, err := CallWithRetry(chat, nil, nil, model.CompleteOptions{}, RetryHooks{
		OnAttempt: func(Attempt) { attempts++ },
	})

	if !IsRunCancelled(err) {
		t.Fatalf("err = %v, want RunCancelled", err)
	}
	if chat.calls != 1 {
		t.Errorf("the model was called %d times, want 1", chat.calls)
	}
	if attempts != 0 {
		t.Errorf("a cancelled call recorded %d attempts, want 0", attempts)
	}
}

// TestAStopBeforeTheFirstAttempt: the flag can already be set when the turn starts
// (a stop that arrived while the previous step was finishing).
func TestAStopBeforeTheFirstAttempt(t *testing.T) {
	chat := &recordingModel{}
	_, err := CallWithRetry(chat, nil, nil, model.CompleteOptions{}, RetryHooks{
		ShouldStop: func() bool { return true },
	})
	if !IsRunCancelled(err) {
		t.Fatalf("err = %v, want RunCancelled", err)
	}
	if chat.calls != 0 {
		t.Errorf("the model was called %d times, want 0", chat.calls)
	}
}

// recordingModel answers with a scripted sequence of errors.
type recordingModel struct {
	errs  []error
	calls int
}

func (m *recordingModel) Complete(messages []map[string]any, tools []map[string]any,
	options model.CompleteOptions) (model.ModelResponse, error) {
	index := m.calls
	m.calls++
	if index < len(m.errs) && m.errs[index] != nil {
		return model.ModelResponse{}, m.errs[index]
	}
	text := "ok"
	return model.ModelResponse{Content: &text}, nil
}

func (m *recordingModel) SwitchModel(string) bool                     { return true }
func (m *recordingModel) Install(string, string, string, string) bool { return true }
func (m *recordingModel) SetReasoning(bool, string)                   {}
func (m *recordingModel) ModelName() string                           { return "recording" }
func (m *recordingModel) ProviderName() string                        { return "test" }
func (m *recordingModel) BaseURL() string                             { return "http://localhost" }

// IsRunCancelled reports whether the error is this package's cancellation, without
// tripping over the type's shape from the outside.
func IsRunCancelled(err error) bool {
	_, ok := err.(RunCancelled)
	return ok
}
