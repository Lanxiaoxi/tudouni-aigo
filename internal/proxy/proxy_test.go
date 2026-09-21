package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// These tests are written around one Windows trap that cost a debugging round:
// **environment variable names are case-insensitive there**, so
// `Setenv("HTTPS_PROXY", "…")` followed by `Setenv("https_proxy", "")` does not
// set one and clear the other — it clears the value that was just set. Every test
// below therefore clears the whole family first and then sets exactly one name.

// clearProxyVariables removes every spelling this package reads.
func clearProxyVariables(t *testing.T) {
	t.Helper()
	for _, name := range proxyVariables {
		t.Setenv(name, "")
	}
}

// withoutProxy runs a test body with no proxy variable set at all, so what it
// observes can only come from the machine's own setting.
func withoutProxy(t *testing.T) {
	t.Helper()
	clearProxyVariables(t)
}

func TestTheEnvironmentWinsOverTheMachine(t *testing.T) {
	clearProxyVariables(t)
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1234")

	resolved, source := Resolve()
	if resolved == nil || resolved.String() != "http://127.0.0.1:1234" {
		t.Fatalf("resolved = %v, want the environment's proxy", resolved)
	}
	if source != "environment (HTTPS_PROXY)" {
		t.Errorf("source = %q, want it to name the environment", source)
	}
}

// A machine setting must not be able to override an explicit instruction, and the
// URL and the description must always agree about whether a proxy is in use.
func TestTheMachineSettingIsOnlyAFallback(t *testing.T) {
	withoutProxy(t)

	resolved, source := Resolve()
	switch {
	case resolved == nil && source == "direct":
	case resolved != nil && source != "direct":
	default:
		t.Fatalf("resolved=%v and source=%q disagree about whether a proxy is in use", resolved, source)
	}
}

// The lowercase spelling is the documented form, and a machine that sets only it —
// which every other tool on that machine honours — must not be the one machine
// where this program goes direct.
func TestTheLowercaseVariableIsHonoured(t *testing.T) {
	clearProxyVariables(t)
	t.Setenv("https_proxy", "http://127.0.0.1:2345")

	resolved, _ := Resolve()
	if resolved == nil || resolved.String() != "http://127.0.0.1:2345" {
		t.Fatalf("resolved = %v, want the lowercase variable", resolved)
	}
}

// A bare `host:port` is what people paste from their proxy client's documentation,
// so it has to be usable rather than refused for a missing scheme.
func TestABareHostPortIsReadable(t *testing.T) {
	for _, item := range []struct{ given, want string }{
		{"127.0.0.1:7897", "http://127.0.0.1:7897"},
		{"http://127.0.0.1:7897", "http://127.0.0.1:7897"},
		{"http://user:pass@127.0.0.1:7897", "http://user:pass@127.0.0.1:7897"},
		{"socks5://127.0.0.1:1080", "socks5://127.0.0.1:1080"},
	} {
		t.Run(item.given, func(t *testing.T) {
			clearProxyVariables(t)
			t.Setenv("HTTPS_PROXY", item.given)
			resolved, _ := Resolve()
			if resolved == nil || resolved.String() != item.want {
				t.Errorf("Resolve(%q) = %v, want %s", item.given, resolved, item.want)
			}
		})
	}
}

// A value that cannot be used is reported rather than silently ignored: the next
// failure would otherwise read as the network instead of as the typo.
func TestAnUnusableValueIsReported(t *testing.T) {
	clearProxyVariables(t)
	t.Setenv("HTTPS_PROXY", "http://")
	if Problem() == "" {
		t.Error("a proxy value with no host was accepted without a word")
	}

	clearProxyVariables(t)
	t.Setenv("HTTPS_PROXY", "127.0.0.1:7897")
	if Problem() != "" {
		t.Errorf("a usable value was reported as a problem: %s", Problem())
	}
}

// TestADeadLoopbackProxyFallsBackToDirect is the behaviour the fallback exists for,
// measured through a real request rather than through the predicate: a proxy that
// is not accepting connections must not be able to stop a request that would
// otherwise succeed.
func TestADeadLoopbackProxyFallsBackToDirect(t *testing.T) {
	resetLoopbackCache()

	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("reached directly"))
	}))
	defer target.Close()

	// Port 9 is the discard port: nothing listens there, and nothing will.
	dead, err := url.Parse("http://127.0.0.1:9")
	if err != nil {
		t.Fatal(err)
	}

	client := &http.Client{Transport: transportFor(dead, false)}
	response, err := client.Get(target.URL)
	if err != nil {
		t.Fatalf("a dead loopback proxy stopped the request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want the direct connection to have been used", response.StatusCode)
	}
}

// And the live case, which is what stops the fallback from degenerating into
// "always go direct": an HTTP target asked for through a live HTTP proxy arrives
// as an absolute-form request at the proxy and never touches the target.
func TestALiveLoopbackProxyIsUsed(t *testing.T) {
	resetLoopbackCache()

	var seen []string
	proxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.String())
		_, _ = w.Write([]byte("via proxy"))
	}))
	defer proxyServer.Close()

	targetHit := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetHit = true
		_, _ = w.Write([]byte("direct"))
	}))
	defer target.Close()

	configured, err := url.Parse(proxyServer.URL)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: transportFor(configured, false)}
	response, err := client.Get(target.URL)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	defer response.Body.Close()

	if len(seen) == 0 {
		t.Error("a live loopback proxy was not used")
	}
	if targetHit {
		t.Error("the request reached the target directly, bypassing a live proxy")
	}
}

// transportFor must not re-read the environment: the decision belongs to Resolve,
// and asking Go to make it again would consult only the variables — the original
// bug rather than the fix.
func TestTheTransportDoesNotSecondGuessTheDecision(t *testing.T) {
	clearProxyVariables(t)
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:9")

	if transportFor(nil, false).Proxy != nil {
		t.Error("a direct transport still carries a proxy function")
	}
	configured, _ := url.Parse("http://127.0.0.1:9")
	if transportFor(configured, false).Proxy == nil {
		t.Error("a configured proxy was dropped")
	}
}

// resetLoopbackCache forgets the "nothing is listening" answers, so one test's dead
// proxy cannot decide another test's result.
func resetLoopbackCache() {
	loopbackMu.Lock()
	defer loopbackMu.Unlock()
	loopbackDead = nil
}
