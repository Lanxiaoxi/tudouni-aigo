// Package proxy decides how this program reaches the network, by following the
// machine's own configuration rather than by adding a preference of its own.
//
// # Why this package exists
//
// Go's `net/http` resolves a proxy from `HTTP_PROXY`/`HTTPS_PROXY` and from
// nothing else. Browsers on Windows resolve it from the user's Internet Settings
// (WinINET, in the registry). A machine can therefore have a browser that loads a
// page and a program that cannot reach the same host — with no visible reason for
// the difference, because both are "the network" to the person watching.
//
// That is not hypothetical. It produced a session whose every model call died on
// `net/http: TLS handshake timeout` while the browser was fine: the gateway is
// reached over a path that needs the machine's proxy, the proxy was configured,
// and this program never looked at it.
//
// # Why there is no configuration key for it
//
// Deliberately none. Which network path a request takes is a property of the
// machine, decided once for every program on it. A second place to write it down
// would be a second answer to the same question — the drift this codebase refuses
// everywhere else — and it would drift quietly, because both answers look
// plausible until one of them is stale.
//
// An environment variable is still honoured, and ahead of the system setting,
// because it is the more specific instruction: `HTTPS_PROXY=… some-command` says
// "for this invocation, use this", while the system proxy says "on this machine,
// use this". Specific beats general.
package proxy

import (
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Resolve reports the proxy to use and where that decision came from.
//
// An empty URL means "connect directly". The description is for the one place a
// person can see the decision (the `/status` screen): a program that silently
// takes a different network path than its owner expects is the failure this
// package exists to remove, and hiding the path again at the last step would put
// it back.
func Resolve() (*url.URL, string) {
	if value := environment(); value != "" {
		if parsed, err := parse(value); err == nil {
			return parsed, "environment (HTTPS_PROXY)"
		}
	}
	if parsed, found, _ := System(); found {
		return parsed, "system proxy"
	}
	return nil, "direct"
}

// System reports the machine's own proxy setting, with no environment variable and
// no fallback applied.
//
// It is exported for the diagnostic tool (`tools/netprobe`), which measures each
// path **separately** and therefore must be able to ask "what does the system say"
// without the program's own resolution and fallback folded in. That tool importing
// this package rather than re-reading the registry is the point: a probe that
// measures a different path than the program takes would answer a question nobody
// asked, confidently.
func System() (*url.URL, bool, error) { return system() }

// Problem reports a configured proxy that could not be understood.
//
// It exists so that "your setting was ignored" is never silent. A person who wrote
// a value this program cannot use needs to be told, or the failure that follows
// reads as the network rather than as the typo.
func Problem() string {
	if value := environment(); value != "" {
		if _, err := parse(value); err != nil {
			return "HTTPS_PROXY is set to " + value + " but is not a usable proxy address: " + err.Error()
		}
	}
	return ""
}

// proxyVariables is every spelling this package reads, in priority order.
//
// It is a package-level list rather than a literal inside `environment` so that the
// tests clear exactly what the code reads. That matters more than it looks: on
// Windows environment names are **case-insensitive**, so a test that sets
// `HTTPS_PROXY` and then clears `https_proxy` clears the value it just set — a
// mistake that reads as "the environment was ignored".
var proxyVariables = []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"}

// environment reads the proxy variables Go itself would read.
//
// The lowercase spellings are checked too: they are the documented form, and a
// machine that sets only `https_proxy` — which every other tool on it honours —
// must not be the one machine where this program goes direct.
func environment() string {
	for _, name := range proxyVariables {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	return ""
}

// parse accepts what the proxy variables accept: a full URL, or a bare
// `host:port` which is read as HTTP.
//
// The bare form is what people paste out of their proxy client's documentation,
// so it is accepted rather than refused. It is also the form `url.Parse` cannot
// make sense of on its own, which is why this is a function and not one call.
func parse(value string) (*url.URL, error) {
	candidate := value
	if !strings.Contains(candidate, "://") {
		candidate = "http://" + candidate
	}
	parsed, err := url.Parse(candidate)
	if err != nil {
		return nil, err
	}
	if parsed.Host == "" {
		return nil, errNoHost{}
	}
	return parsed, nil
}

type errNoHost struct{}

func (errNoHost) Error() string { return "it has no host:port" }

// Transport builds the transport this program reaches the network with, and
// reports which path that is.
//
// The proxy function Go would normally use is left nil on purpose: the decision is
// made once here, and asking Go to make it again would re-read only the
// environment — which is the bug this package exists to fix, not the fix.
func Transport() (*http.Transport, string) {
	configured, source := Resolve()
	return transportFor(configured), source
}

// transportFor builds a transport for one already-made decision.
//
// It is separate from Transport so that the decision and the wiring can be tested
// apart: a test can ask for "this proxy, no matter what this machine says", which
// is the only way to cover the fallback without depending on the machine's own
// settings.
func transportFor(configured *url.URL) *http.Transport {
	transport := &http.Transport{
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	if configured != nil {
		transport.Proxy = skipWhenUnreachable(configured)
	}
	return transport
}

// loopbackProbeTTL is how long a "nothing is listening" answer is trusted.
//
// Long enough that a per-request check costs one dial in a burst of tool calls,
// short enough that starting the proxy client is noticed without restarting this
// program. Ten seconds is well under the time it takes a person to switch windows
// and click connect.
const loopbackProbeTTL = 10 * time.Second

var (
	loopbackMu   sync.Mutex
	loopbackDead map[string]time.Time
)

// skipWhenUnreachable returns the proxy function that falls back to a direct
// connection when a **loopback** proxy is not accepting connections.
//
// The case it exists for is ordinary: proxy clients commonly leave the system
// setting pointing at themselves after they exit, so `ProxyEnable` can be on, the
// address can be right, and nothing can be listening. Following that setting
// blindly would turn "the browser works" into "this program never connects" — the
// exact inversion of the bug being fixed. Measured on the machine that produced
// this package: a closed loopback port refuses in single-digit milliseconds, so
// the fallback costs nothing worth counting.
//
// The check is restricted to loopback on purpose. For a remote proxy, "not
// reachable" is indistinguishable from a slow network, and a failed connection to
// it is the honest answer — retrying the same request around it would hide a real
// problem behind a second, different path.
func skipWhenUnreachable(configured *url.URL) func(*http.Request) (*url.URL, error) {
	if !isLoopback(configured.Hostname()) {
		// Not this program's business to second-guess a remote proxy.
		return http.ProxyURL(configured)
	}
	key := configured.String()
	return func(*http.Request) (*url.URL, error) {
		if !loopbackAlive(key, configured) {
			return nil, nil
		}
		return configured, nil
	}
}

// loopbackAlive reports whether something accepts a connection there, remembering
// a refusal for loopbackProbeTTL.
func loopbackAlive(key string, configured *url.URL) bool {
	loopbackMu.Lock()
	if deadAt, seen := loopbackDead[key]; seen && time.Since(deadAt) < loopbackProbeTTL {
		loopbackMu.Unlock()
		return false
	}
	loopbackMu.Unlock()

	address := configured.Host
	if configured.Port() == "" {
		address = net.JoinHostPort(configured.Hostname(), "80")
	}
	connection, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		loopbackMu.Lock()
		if loopbackDead == nil {
			loopbackDead = map[string]time.Time{}
		}
		loopbackDead[key] = time.Now()
		loopbackMu.Unlock()
		return false
	}
	_ = connection.Close()
	return true
}

// isLoopback reports whether a host is this machine. `localhost` counts: it is what
// a proxy client writes in its own instructions.
func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	address, err := net.ResolveIPAddr("ip", host)
	if err != nil {
		return false
	}
	return address.IP.IsLoopback()
}
