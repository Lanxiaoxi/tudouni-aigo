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
//
// # Why NO_PROXY is honoured, and why it is not a second answer
//
// "Which path does a request take" is not always one answer per machine, and the
// case that proves it is an isolated development server: the model gateway is on
// the internal network and is reached directly, while the identity provider that
// authenticates the session is on the public internet and is reachable only
// through a proxy. One machine, two paths, chosen per destination.
//
// `NO_PROXY` is the machine's own way of saying that — it is the same variable
// curl, Git and Go itself read — so honouring it is not the configuration key this
// package refuses above. It is the machine's answer, read from the machine, and it
// stays the single source of truth: `Resolve` still decides **which** proxy to use,
// and `NO_PROXY` only says which destinations that proxy is not for.
//
// The matching is not reimplemented here. `golang.org/x/net/http/httpproxy` is what
// Go's own `http.ProxyFromEnvironment` uses, and a second implementation of "does
// this host match this pattern" would be exactly the drift this package exists to
// prevent — a machine where curl and this program disagree about `NO_PROXY` for no
// visible reason.
package proxy

import (
	"crypto/tls"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/http/httpproxy"
)

// Resolve reports the proxy to use and where that decision came from.
//
// An empty URL means "connect directly". The description is for the one place a
// person can see the decision (the `/status` screen): a program that silently
// takes a different network path than its owner expects is the failure this
// package exists to remove, and hiding the path again at the last step would put
// it back.
func Resolve() (*url.URL, string) {
	if name, value := environment(); value != "" {
		if parsed, err := parse(value); err == nil {
			return parsed, "environment (" + name + ")"
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

// NoProxy reports the destinations the machine's own `NO_PROXY` excludes from the
// proxy, or "" when it names none.
//
// It is exported because the decision it describes cannot be summarised by `Resolve`
// alone: `Resolve` answers "which proxy", and this answers "which destinations that
// proxy is not for". A startup notice that reported only the first would be telling
// the person something untrue about their own traffic — the failure mode this
// package exists to remove — so both are said out loud.
//
// It returns the value verbatim rather than a parsed form. Nothing in this program
// needs to interrogate it, and re-formatting a list the machine wrote would be a
// second way to spell it.
func NoProxy() string { return noProxy() }

// Problem reports a configured proxy that could not be understood.
//
// It exists so that "your setting was ignored" is never silent. A person who wrote
// a value this program cannot use needs to be told, or the failure that follows
// reads as the network rather than as the typo.
//
// It covers **both** places a setting can be refused, and the second one is the
// reason this reads the machine's own configuration as well. A PAC script is refused
// rather than evaluated (`systemFrom` says why), and `Resolve` — the only production
// caller — used to discard that error and fall through to "direct". The startup
// notice then stated, as a fact, that requests go direct, while the truth was that
// the machine's proxy had been skipped; on a network reachable only through it, every
// model call then timed out with nothing on screen pointing at the cause.
func Problem() string {
	if name, value := environment(); value != "" {
		if _, err := parse(value); err != nil {
			return name + " is set to " + value + " but is not a usable proxy address: " + err.Error()
		}
		// The environment wins over the system setting, so a machine setting that was
		// refused is not what took effect and is not worth reporting alongside it.
		return ""
	}
	if _, _, err := System(); err != nil {
		return err.Error()
	}
	return ""
}

// Variables is every spelling this package reads for the proxy address, in
// priority order.
//
// It is a package-level list rather than a literal inside `environment` so that the
// tests clear exactly what the code reads, and it is **exported** so that the tests
// of another package can do the same: `internal/model` builds its own client from
// `Transport`, and a test there that cleared a hand-copied list would go on
// honouring whatever the developer's own machine had set.
//
// NoProxyVariables is the same idea for the destinations that skip the proxy. The
// two are deliberately **separate lists**: the first names where a proxy address can
// come from, and `Problem` reports a value in it that cannot be parsed. `NO_PROXY`
// holds hosts, not addresses, and the standard library treats a malformed entry as
// "ignore it" rather than as an error — folding it into one list would make a typo
// in `NO_PROXY` report itself as an unusable proxy address.
var (
	Variables        = []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"}
	NoProxyVariables = []string{"NO_PROXY", "no_proxy"}
)

// environment reads the proxy variables Go itself would read, and reports which
// spelling supplied the value.
//
// The name is returned rather than assumed. All four spellings are read, and a
// description that always says `HTTPS_PROXY` is simply wrong on the machine that
// sets only `HTTP_PROXY` — the common case on Linux. The description is the whole
// point of this package (see Resolve), so it has to name the variable that was
// actually used.
//
// The lowercase spellings are checked too: they are the documented form, and a
// machine that sets only `https_proxy` — which every other tool on it honours —
// must not be the one machine where this program goes direct.
func environment() (string, string) { return fromEnvironment(Variables) }

// noProxy returns the machine's skip list, or "" when it has none.
//
// It is read rather than parsed here: the value is handed to `httpproxy` whole, so
// that every pattern it accepts — a host, a domain suffix, a CIDR block, a `host:port`
// pair, `*` — behaves here exactly as it does everywhere else on the machine.
func noProxy() string { return environmentValue(NoProxyVariables) }

// fromEnvironment returns the first name in the list that holds a non-empty value,
// with the name that supplied it.
func fromEnvironment(names []string) (string, string) {
	for _, name := range names {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return name, value
		}
	}
	return "", ""
}

// environmentValue returns the first non-empty value among the names, with no
// trimming: this one is read for a list whose whitespace the standard library
// already trims per entry.
func environmentValue(names []string) string {
	for _, name := range names {
		if value := os.Getenv(name); value != "" {
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
func Transport(skipVerify bool) (*http.Transport, string) {
	configured, source := Resolve()
	return transportFor(configured, skipVerify), source

}

// transportFor builds a transport for one already-made decision.
//
// It is separate from Transport so that the decision and the wiring can be tested
// apart: a test can ask for "this proxy, no matter what this machine says", which
// is the only way to cover the fallback without depending on the machine's own
// settings.
func transportFor(configured *url.URL, skipVerify bool) *http.Transport {
	transport := &http.Transport{
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	if configured != nil {
		transport.Proxy = noProxyAware(configured)
	}
	if skipVerify {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	return transport
}

// noProxyAware returns the proxy function for a configured proxy: the proxy, except
// for the destinations the machine's own `NO_PROXY` names.
//
// The decision is made **per request**, and it has to be: `Resolve` answers "which
// proxy does this machine use", which is one answer, while "is this particular
// destination on the far side of it" is a different question with a different answer
// for every host. This is the only place in the program that needs the second
// question asked, and it is the reason "authenticate through the proxy, reach the
// model directly" was impossible before: the proxy was applied to every destination
// alike.
//
// `NO_PROXY` is read once, here, when the transport is built, and handed to
// `httpproxy` whole. Reading it per request would put an environment lookup in the
// path of every model call for a value no one changes mid-session, and `httpproxy`
// snapshots the parsed config anyway.
//
// The standard library's loopback rule comes along with it and is worth knowing
// about, because it is not something this package wrote: `localhost` and loopback
// addresses are never sent to a proxy, with or without `NO_PROXY`. That is narrower
// than the fallback below, which is about a loopback proxy that is **dead** rather
// than about a destination.
func noProxyAware(configured *url.URL) func(*http.Request) (*url.URL, error) {
	// Both schemes get the one resolved address: this package's whole point is that
	// the machine has a single answer, and `Resolve` returns a single URL rather
	// than a per-scheme pair. The scheme still matters to httpproxy, which looks up
	// the proxy per request scheme and answers with a direct connection when it has
	// none — so leaving one side unset would silently go direct for that scheme.
	config := &httpproxy.Config{
		HTTPProxy:  configured.String(),
		HTTPSProxy: configured.String(),
		// Deliberately not `httpproxy.FromEnvironment`: the proxy address is the
		// decision `Resolve` already made, system setting included. Letting
		// httpproxy read the environment for it would hand the question back to the
		// bug this package exists to fix.
		NoProxy: noProxy(),
	}
	// No CGI flag either. `httpproxy` refuses an `HTTP_PROXY` value outright when
	// `REQUEST_METHOD` is set, to stop a CGI caller injecting one; this program is
	// not a CGI handler and does not spawn one, so that rule would only be a way for
	// an unrelated variable to silently take the proxy away.
	skip := config.ProxyFunc()

	// The dead-loopback fallback is applied to the proxy httpproxy hands back, not
	// in front of it: a destination that `NO_PROXY` skipped must go direct whether
	// or not the proxy would have answered, and a loopback proxy that is not
	// listening must still fall back rather than hang.
	return skipWhenUnreachable(func(request *http.Request) (*url.URL, error) {
		proxy, err := skip(request.URL)
		if err != nil || proxy == nil {
			return nil, err
		}
		return configured, nil
	})
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
// problem behind a second, different path. That restriction is also what keeps this
// honest once `NO_PROXY` is in play: a remote proxy stays the answer for everything
// `NO_PROXY` did not exclude, because "it might be down" is not a reason to take a
// route the machine did not ask for.
//
// `decide` is the proxy function being wrapped, and it is a parameter rather than a
// URL so that the reachability rule composes with the other per-request rule —
// `NO_PROXY` — instead of competing with it: whichever of the two says "direct"
// wins, and this one only ever gets to say it for a loopback proxy that is dead.
func skipWhenUnreachable(decide func(*http.Request) (*url.URL, error)) func(*http.Request) (*url.URL, error) {
	return func(request *http.Request) (*url.URL, error) {
		configured, err := decide(request)
		if err != nil || configured == nil {
			return nil, err
		}
		if !isLoopback(configured.Hostname()) {
			// Not this program's business to second-guess a remote proxy.
			return configured, nil
		}
		key := configured.String()
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
