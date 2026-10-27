package protocol

import (
	"strings"
	"testing"
	"time"
)

// probeStub is a runtime with the effort-probe capability.
type probeStub struct {
	stubRuntime

	snapshot map[string]any
	probeErr error
	// asks counts the calls, so "the handler asked once" is assertable.
	asks int
}

func (s *probeStub) ProbeEffort() (map[string]any, error) {
	s.asks++
	if s.probeErr != nil {
		return nil, s.probeErr
	}
	return s.snapshot, nil
}

// The probe answers on its own goroutine (six serial asks to a slow endpoint
// must not block the read loop), so these tests wait for the line rather than
// reading the buffer straight after Dispatch.
func probeAnswer(t *testing.T, output *safeBuffer) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if message, ok := lastProbeMessage(t, output.String()); ok {
			return message
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("the probe never answered:\n%s", output.String())
	return nil
}

func lastProbeMessage(t *testing.T, raw string) (map[string]any, bool) {
	t.Helper()
	var found map[string]any
	for _, message := range decodeAll(t, raw) {
		if kind, _ := String(message, "kind"); kind == UIProbeEffort {
			found = message
		}
	}
	return found, found != nil
}

// TestProbeEffortAnswersUnderTheProbeKey is the shape test this feature was
// missing.
//
// The snapshot is **one object under `probe`**, the way `memory` and `usage`
// carry theirs. Spreading `model` / `provider` / `levels` beside the envelope
// instead is not a cosmetic difference: the schema declares a single `probe`
// field, and a front end reads `probe.levels`, so a flat answer parses as "no
// result at all" — the panel draws nothing, no problem is reported, and the
// person who just paid for six real requests is told nothing.
func TestProbeEffortAnswersUnderTheProbeKey(t *testing.T) {
	runtime := &probeStub{snapshot: map[string]any{
		"model":    "m",
		"provider": "p",
		"levels": []any{
			map[string]any{"level": "low", "result": "ok"},
			map[string]any{"level": "xhigh", "result": "rejected"},
		},
	}}
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	server.Attach(runtime)
	server.Dispatch(map[string]any{"v": VERSION, "t": InProbeEffort})

	message := probeAnswer(t, output)
	payload, ok := message["probe"].(map[string]any)
	if !ok {
		t.Fatalf("probe = %T, want the snapshot as one object beside the envelope: %v",
			message["probe"], message)
	}
	if model, _ := String(payload, "model"); model != "m" {
		t.Errorf("probe.model = %q, want the runtime's own model", model)
	}
	if provider, _ := String(payload, "provider"); provider != "p" {
		t.Errorf("probe.provider = %q, want the runtime's own provider", provider)
	}
	if rows, _ := payload["levels"].([]any); len(rows) != 2 {
		t.Errorf("probe.levels = %v, want one row per probed level", payload["levels"])
	}

	// And nothing leaked out beside it. A flat answer that also carried `probe`
	// would satisfy the assertions above while still putting fields on the wire
	// the schema never declared.
	for _, key := range []string{"model", "provider", "levels"} {
		if _, spread := message[key]; spread {
			t.Errorf("%q was sent beside the envelope as well as inside `probe`", key)
		}
	}
	if runtime.asks != 1 {
		t.Errorf("the runtime was asked %d times, want once", runtime.asks)
	}
}

// TestProbeEffortAnswersWithTheEnvelope pins the three required keys, because the
// outbound schema's `ui.required` is exactly `v`/`t`/`kind` and a message missing
// one of them is not the message kind a front end dispatches on.
func TestProbeEffortAnswersWithTheEnvelope(t *testing.T) {
	runtime := &probeStub{snapshot: map[string]any{"model": "m", "provider": "p", "levels": []any{}}}
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	server.Attach(runtime)
	server.Dispatch(map[string]any{"v": VERSION, "t": InProbeEffort})

	message := probeAnswer(t, output)
	if TypeOf(message) != OutUI {
		t.Errorf("t = %q, want %q", TypeOf(message), OutUI)
	}
	if version, _ := message["v"].(float64); int(version) != VERSION {
		t.Errorf("v = %v, want %d", message["v"], VERSION)
	}
}

// TestProbeEffortRefusalReachesThePanel: a probe that could not run sends its
// sentence on the panel's own kind, beside `problem`, and no `probe` object —
// the reason the memory and codeintel handlers give: a notice lands behind the
// panel that asked.
func TestProbeEffortRefusalReachesThePanel(t *testing.T) {
	runtime := &probeStub{probeErr: &stubError{"the endpoint cannot be reached"}}
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	server.Attach(runtime)
	server.Dispatch(map[string]any{"v": VERSION, "t": InProbeEffort})

	message := probeAnswer(t, output)
	problem, _ := String(message, "problem")
	if !strings.Contains(problem, "cannot be reached") {
		t.Errorf("problem = %q, want the runtime's sentence", problem)
	}
	if _, present := message["probe"]; present {
		t.Error("a probe that failed sent a snapshot anyway")
	}
}

// TestProbeEffortIsOptional: a runtime without the capability must say so. An
// empty result and "this build cannot probe" look identical on screen, and the
// second one is the only one the person can act on.
func TestProbeEffortIsOptional(t *testing.T) {
	output := &safeBuffer{}
	server := NewServer(OpenStreams(strings.NewReader(""), output), Bootstrap{})
	server.Attach(&stubRuntime{})
	server.Dispatch(map[string]any{"v": VERSION, "t": InProbeEffort})

	message := probeAnswer(t, output)
	if problem, _ := String(message, "problem"); problem == "" {
		t.Fatalf("a runtime without the capability answered %v, want a problem sentence", message)
	}
}
