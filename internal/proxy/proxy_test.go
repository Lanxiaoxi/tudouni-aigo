package proxy

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"
)

// These tests are written around one Windows trap that cost a debugging round:
// **environment variable names are case-insensitive there**, so
// `Setenv("HTTPS_PROXY", "…")` followed by `Setenv("https_proxy", "")` does not
// set one and clear the other — it clears the value that was just set. Every test
// below therefore clears the whole family first and then sets exactly one name.

// clearProxyVariables removes every spelling this package reads.
//
// Both lists, not just the proxy addresses: `NO_PROXY` is read by the transport
// too, so a developer whose own machine sets it would otherwise decide the result
// of the transport tests below.
func clearProxyVariables(t *testing.T) {
	t.Helper()
	for _, name := range Variables {
		t.Setenv(name, "")
	}
	for _, name := range NoProxyVariables {
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
//
// The destination is an internal **address** rather than a loopback one, and that is
// load-bearing rather than cosmetic: the matching code applies the standard
// library's rule that a loopback destination is never proxied, so a loopback target
// would be answered directly with or without a live proxy — the test would pass
// while measuring nothing. The dialer below is only here to resolve the address that
// cannot exist.
func TestALiveLoopbackProxyIsUsed(t *testing.T) {
	resetLoopbackCache()
	clearProxyVariables(t)

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

	transport := transportFor(configured, false)
	transport.DialContext = directTarget(t, "direct")
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}

	response, err := client.Get("http://" + testTargetIP + "/anything")
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

// testTargetIP is the internal address the tests below dial. Nothing binds it: the
// dialer in each test sends it to a local listener.
//
// Why not simply use `127.0.0.1` as the destination. Because the matching code
// applies the standard library's rule that a **loopback destination is never
// proxied**, whatever `NO_PROXY` says — so a loopback target would go direct with
// the bug present and prove nothing about the rule under test. An internal address
// is also what the real case is: the model gateway is not on this machine.
const testTargetIP = "10.42.7.9"

// directTarget starts the server that stands in for the internal gateway, and
// returns the dialer that reaches it under testTargetIP.
func directTarget(t *testing.T, answer string) func(context.Context, string, string) (net.Conn, error) {
	t.Helper()
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(answer))
	}))
	t.Cleanup(gateway.Close)
	targetAddr := gateway.Listener.Addr().String()

	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		if host, _, err := net.SplitHostPort(addr); err == nil && host == testTargetIP {
			addr = targetAddr
		}
		return (&net.Dialer{}).DialContext(ctx, network, addr)
	}
}

// liveProxy starts the proxy and returns it, along with the dialer to swap in when
// the destination is a name rather than the internal address.
func liveProxy(t *testing.T, hits *atomic.Int32) *url.URL {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte("via the proxy"))
	}))
	t.Cleanup(server.Close)

	configured, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return configured
}

// TestNoProxyDecidesPerDestination is the regression for the arrangement this
// package could not express before: a proxy configured for the outer network, and a
// destination on the inner one that must not be sent to it.
//
// Every case runs a real request through the transport production builds, and the
// two servers answer differently, so which path was taken is read from the reply
// rather than inferred from a predicate. The proxy is **live** throughout: a dead
// one would fall back to direct through the other rule and mask the one under test.
func TestNoProxyDecidesPerDestination(t *testing.T) {
	resetLoopbackCache()

	cases := []struct {
		name    string
		noProxy string
		want    string
	}{
		{"the named address goes direct", testTargetIP, "direct"},
		{"a CIDR covers the internal subnet", "10.0.0.0/8", "direct"},
		{"a host:port entry matches the host", testTargetIP + ":80", "direct"},
		{"everything is skipped", "*", "direct"},
		{"nothing is named, so the proxy is used", "", "via the proxy"},
	}

	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			var proxyHits atomic.Int32
			configured := liveProxy(t, &proxyHits)

			clearProxyVariables(t)
			t.Setenv("NO_PROXY", item.noProxy)

			transport := transportFor(configured, false)
			transport.DialContext = directTarget(t, "direct")
			client := &http.Client{Transport: transport, Timeout: 5 * time.Second}

			response, err := client.Get("http://" + testTargetIP + "/v1/chat/completions")
			if err != nil {
				t.Fatalf("request failed: %v", err)
			}
			defer response.Body.Close()

			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if string(body) != item.want {
				t.Errorf("NO_PROXY=%q answered %q, want %q", item.noProxy, body, item.want)
			}
			if item.want == "via the proxy" && proxyHits.Load() == 0 {
				t.Error("the reply claims the proxy was used, but the proxy saw nothing")
			}
			if item.want == "direct" && proxyHits.Load() != 0 {
				t.Error("the internal address was sent to the proxy")
			}
		})
	}
}

// The names `NO_PROXY` is written with are hostnames, and the matching is the part
// worth pinning: a bare domain covers its subdomains, a leading dot covers only the
// subdomains, and a hostname is not an address.
func TestNoProxyMatchesHostnames(t *testing.T) {
	resetLoopbackCache()

	const internalName = "model.corp.internal"

	cases := []struct {
		name    string
		noProxy string
		want    string
	}{
		{"the exact name", internalName, "direct"},
		{"a bare domain covers itself and its subdomains", "corp.internal", "direct"},
		{"a leading dot covers the subdomain too", ".corp.internal", "direct"},
		{"an unrelated domain does not match", "other.internal", "via the proxy"},
		{"a host:port entry matches the host", internalName + ":80", "direct"},
	}

	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			var proxyHits atomic.Int32
			configured := liveProxy(t, &proxyHits)

			clearProxyVariables(t)
			t.Setenv("NO_PROXY", item.noProxy)

			// A hostname cannot be dialled, so the name is pointed at the local
			// listener. The decision — which proxy, whether any — is made before the
			// dial and is unaffected by this.
			reachesGateway := directTarget(t, "direct")
			transport := transportFor(configured, false)
			transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
				if host, _, err := net.SplitHostPort(addr); err == nil && host == internalName {
					addr = testTargetIP + ":80"
				}
				return reachesGateway(ctx, network, addr)
			}
			client := &http.Client{Transport: transport, Timeout: 5 * time.Second}

			response, err := client.Get("http://" + internalName + "/v1/chat/completions")
			if err != nil {
				t.Fatalf("request failed: %v", err)
			}
			defer response.Body.Close()

			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if string(body) != item.want {
				t.Errorf("NO_PROXY=%q answered %q, want %q", item.noProxy, body, item.want)
			}
		})
	}
}

// The proxy is still the answer for everything `NO_PROXY` did not name. Without
// this, "skip the proxy" could be satisfied by never using one at all.
func TestNoProxyLeavesTheProxyInPlaceForEverythingElse(t *testing.T) {
	resetLoopbackCache()

	var proxyHits atomic.Int32
	configured := liveProxy(t, &proxyHits)

	// The identity provider is the destination that must keep using the proxy: it is
	// the reason a proxy is configured on the machine at all.
	clearProxyVariables(t)
	t.Setenv("NO_PROXY", "model.corp.internal,10.0.0.0/8,localhost")

	client := &http.Client{Transport: transportFor(configured, false), Timeout: 5 * time.Second}
	response, err := client.Get("http://login.microsoftonline.com/oauth2/v2.0/token")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	defer response.Body.Close()

	if proxyHits.Load() == 0 {
		t.Error("a destination outside NO_PROXY did not use the proxy")
	}
}

// A loopback destination is never proxied, with or without `NO_PROXY` — that rule is
// the standard library's, and it arrived with the matching implementation rather
// than being written here. It is asserted because it is easy to break by accident
// while changing the proxy function, and because "the machine's own NO_PROXY" is
// what people reach for first when this is actually the reason.
func TestALoopbackDestinationIsNeverProxied(t *testing.T) {
	resetLoopbackCache()

	var proxyHits atomic.Int32
	configured := liveProxy(t, &proxyHits)

	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("direct"))
	}))
	defer target.Close()

	clearProxyVariables(t)

	client := &http.Client{Transport: transportFor(configured, false), Timeout: 5 * time.Second}
	response, err := client.Get(target.URL)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	defer response.Body.Close()

	if proxyHits.Load() != 0 {
		t.Error("a loopback destination was sent to the proxy")
	}
}
