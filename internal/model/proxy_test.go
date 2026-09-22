package model

import (
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/proxy"
)

// internalDialer sends a destination a test uses for its gateway to a listener,
// which is the only thing these tests add to the production wiring. Nothing resolves
// or binds those names — they stand in for a gateway on a network this machine
// cannot reach, which is the situation every proxy test here has to reproduce.
func internalDialer(gatewayAddr string, hosts ...string) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(addr)
		if err == nil && (host == internalGatewayHost || slices.Contains(hosts, host)) {
			addr = gatewayAddr
		}
		return (&net.Dialer{}).DialContext(ctx, network, addr)
	}
}

// adapterOverInternal is the adapter a real run builds, pointed at an address the
// tests can dial.
//
// The gateway is reached as an internal **address** or **name** rather than as
// `127.0.0.1`, and that is load-bearing. The proxy decision now honours `NO_PROXY`
// through `golang.org/x/net/http/httpproxy`, which applies the standard library's
// rule that a loopback destination is never proxied — so a loopback gateway would be
// reached directly no matter what the proxy setting said, and every proxy test
// written against one would pass while measuring nothing. An internal address is
// also what the real case is: the model gateway is not on the machine running this
// program.
func adapterOverInternal(t *testing.T, gateway string, options Options, hosts ...string) *OpenAICompatible {
	t.Helper()

	adapter := newTestAdapter(t, options)

	transport, ok := adapter.client.Transport.(*http.Transport)
	if !ok {
		t.Fatal("the adapter did not build the transport these tests are about")
	}
	inner := transport.DialContext
	redirect := internalDialer(gateway, hosts...)
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if inner == nil {
			// The production transport leaves this unset, and `net/http` does **not**
			// fall back to a default dialer once it is assigned. Handing back a nil
			// function here is a nil-pointer panic inside the transport rather than
			// an error, so the default has to be spelled out.
			return redirect(ctx, network, addr)
		}
		return inner(ctx, network, addr)
	}
	return adapter
}

// internalGatewayHost stands in for the model gateway on an internal network. Nothing
// resolves or binds it: the dialer above sends it to the test's own listener.
const internalGatewayHost = "10.42.7.9"

// TestTheAdapterFollowsTheEnvironmentsProxy is the regression for the whole reason
// `internal/proxy` exists.
//
// The failure it pins was measured on a real machine: the gateway is reached over a
// path that needs the machine's proxy, the browser on that machine loaded the
// gateway fine, and every model call from this program died on
//
//	net/http: TLS handshake timeout
//
// because the adapter reaches the network through a zero-value `http.Transport`,
// and Go's zero value resolves a proxy from `HTTP_PROXY`/`HTTPS_PROXY` and from
// nothing else. On that machine the browser read the setting from the registry and
// this program read nothing.
//
// The adapter is driven with **no injected client**, which is the path a real run
// takes: an injected client bypasses the transport this is about, so a test using
// one would pass whether or not the bug was fixed. Only the dialer is added, to give
// the internal address somewhere to land.
func TestTheAdapterFollowsTheEnvironmentsProxy(t *testing.T) {
	var proxied []string
	proxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxied = append(proxied, r.URL.String())
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"via proxy"}}]}`))
	}))
	defer proxyServer.Close()

	reached := false
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"direct"}}]}`))
	}))
	defer gateway.Close()

	clearProxyVariables(t)
	t.Setenv("HTTPS_PROXY", proxyServer.URL)

	adapter := adapterOverInternal(t, gateway.Listener.Addr().String(), Options{
		Route: route("http://"+internalGatewayHost, "gpt-x", StyleOpenAI),
	})
	response, err := adapter.Complete([]map[string]any{{"role": "user", "content": "hi"}}, nil, CompleteOptions{})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if response.Content == nil || *response.Content != "via proxy" {
		t.Errorf("content = %v, want the reply that came through the proxy", response.Content)
	}
	if len(proxied) == 0 {
		t.Error("the adapter did not use the proxy from the environment")
	}
	if reached {
		t.Error("the request went straight to the gateway, ignoring a working proxy")
	}
}

// TestTheHTTPSPathTunnelsThroughTheProxy covers the half the plain-HTTP test does
// not: an `https://` request goes through a proxy as a **CONNECT tunnel**, not as an
// absolute-form request, so it is different code inside Go's transport.
//
// That difference is the whole reason this test exists. Every real endpoint this
// program talks to is https, and the bug being fixed was a TLS handshake timeout —
// so a suite that only proved the plain HTTP case would leave the interesting path
// untested.
func TestTheHTTPSPathTunnelsThroughTheProxy(t *testing.T) {
	gateway := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"through the tunnel"}}]}`))
	}))
	defer gateway.Close()

	tunnels := make(chan string, 1)
	proxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			t.Errorf("the proxy saw %s, want a CONNECT tunnel for an https target", r.Method)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		select {
		case tunnels <- r.Host:
		default:
		}

		// The proxy dials the target itself, so it needs the same redirection the
		// client has: the internal address is not resolvable, and the test gateway is.
		upstream, err := internalDialer(gateway.Listener.Addr().String())(
			r.Context(), "tcp", r.Host)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		defer upstream.Close()
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		client, _, err := hijacker.Hijack()
		if err != nil {
			return
		}
		defer client.Close()
		_, _ = client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
		go func() { _, _ = io.Copy(upstream, client) }()
		_, _ = io.Copy(client, upstream)
	}))
	defer proxyServer.Close()

	clearProxyVariables(t)
	t.Setenv("HTTPS_PROXY", proxyServer.URL)

	adapter := adapterOverInternal(t, gateway.Listener.Addr().String(), Options{
		Route: route("https://"+internalGatewayHost, "gpt-x", StyleOpenAI),
	})

	// The adapter is built with the **same** proxy decision production makes; only
	// the certificate trust is relaxed. `httptest` signs its gateway with a throwaway
	// CA **and names it `127.0.0.1`**, so the borrowed trust store would still refuse
	// the internal address this test reaches the gateway by. What is being measured is
	// whether the request takes a CONNECT tunnel through the proxy, and that is
	// decided before the certificate is looked at.
	transport, ok := adapter.client.Transport.(*http.Transport)
	if !ok {
		t.Fatal("the adapter did not build the transport this test is about")
	}
	trusted, ok := gateway.Client().Transport.(*http.Transport)
	if !ok {
		t.Fatal("httptest did not hand back a transport to borrow trust from")
	}
	transport.TLSClientConfig = &tls.Config{
		Certificates:       trusted.TLSClientConfig.Certificates,
		InsecureSkipVerify: true,
	}

	response, err := adapter.client.Get("https://" + internalGatewayHost + "/v1/chat/completions")
	if err != nil {
		t.Fatalf("an https request through the proxy failed: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Errorf("status = %d", response.StatusCode)
	}
	select {
	case host := <-tunnels:
		if !strings.HasPrefix(host, internalGatewayHost) {
			t.Errorf("the tunnel was opened to %q, want the internal gateway", host)
		}
	default:
		t.Error("an https request did not go through the proxy as a CONNECT tunnel")
	}
}

// TestTheAdapterGoesDirectWithNoProxyConfigured: with nothing configured, the
// request goes straight there. A suite that only checked the proxy case could be
// satisfied by "always use a proxy".
func TestTheAdapterGoesDirectWithNoProxyConfigured(t *testing.T) {
	clearProxyVariables(t)

	var seen bool
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = true
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"direct"}}]}`))
	}))
	defer gateway.Close()

	adapter := newTestAdapter(t, Options{Route: route(gateway.URL, "gpt-x", StyleOpenAI)})
	if _, err := adapter.Complete([]map[string]any{{"role": "user", "content": "hi"}}, nil, CompleteOptions{}); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if !seen {
		t.Error("with no proxy configured the request still did not reach the gateway directly")
	}
}

// clearProxyVariables removes every spelling `internal/proxy` reads.
//
// The list comes from that package rather than being spelled out here, and it now
// covers `NO_PROXY` as well as the proxy addresses. Both halves matter for the same
// reason: on Windows environment names are case-insensitive, so setting
// `HTTPS_PROXY` and then clearing `https_proxy` clears the value that was just set —
// and a `NO_PROXY` inherited from the developer's own machine would decide which
// path these tests take.
func clearProxyVariables(t *testing.T) {
	t.Helper()
	for _, name := range proxy.Variables {
		t.Setenv(name, "")
	}
	for _, name := range proxy.NoProxyVariables {
		t.Setenv(name, "")
	}
}

// TestTheInternalModelIsReachedDirectlyWhileTheProxyStaysConfigured pins the
// arrangement this program could not previously express at all: a proxy is
// configured, because the identity provider needs one, and the model gateway is on
// an internal network that the proxy cannot reach.
//
// The failure it pins was reported from an isolated development server. Setting
// `HTTPS_PROXY` there made every model call fail — the address was handed to a proxy
// with no route to the internal network — while **not** setting it made the EricAI
// login fail instead, because `login.microsoftonline.com` is only reachable through
// the proxy. One machine, two destinations, two paths, and no variable combination
// that produced both.
//
// The gateway is reached under an internal **name** rather than as `127.0.0.1`,
// and that detail is the whole test. `httpproxy` never proxies a loopback address
// regardless of `NO_PROXY`, so a loopback gateway would pass even with the bug
// present — the request would go direct for a reason unrelated to what is being
// measured.
func TestTheInternalModelIsReachedDirectlyWhileTheProxyStaysConfigured(t *testing.T) {
	const internalName = "model.corp.internal"

	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"from the internal gateway"}}]}`))
	}))
	defer gateway.Close()

	// The corporate proxy, live and answering, so "the proxy was used" is
	// distinguishable from "the internal gateway was used" only by which reply came
	// back — which is exactly what this asserts.
	proxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"from the proxy"}}]}`))
	}))
	defer proxyServer.Close()

	clearProxyVariables(t)
	t.Setenv("HTTPS_PROXY", proxyServer.URL)
	t.Setenv("NO_PROXY", internalName)

	adapter := adapterOverInternal(t, gateway.Listener.Addr().String(), Options{
		Route: route("http://"+internalName, "gpt-x", StyleOpenAI),
	}, internalName)

	response, err := adapter.Complete([]map[string]any{{"role": "user", "content": "hi"}}, nil, CompleteOptions{})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if response.Content == nil || *response.Content != "from the internal gateway" {
		t.Errorf("content = %v, want the internal gateway's answer", response.Content)
	}
}

// A streamed answer is the path a real turn takes, so the proxy has to work for the
// streaming reader too and not only for the unary one.
func TestTheStreamedPathAlsoUsesTheProxy(t *testing.T) {
	proxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ti\"}}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"dy\"}}]}\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer proxyServer.Close()

	clearProxyVariables(t)
	t.Setenv("HTTPS_PROXY", proxyServer.URL)

	adapter := newTestAdapter(t, Options{Route: route("http://gateway.invalid", "gpt-x", StyleOpenAI)})

	var streamed string
	response, err := adapter.Complete(
		[]map[string]any{{"role": "user", "content": "hi"}}, nil,
		CompleteOptions{OnDelta: func(text, reasoning string) { streamed += text }},
	)
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if streamed != "tidy" {
		t.Errorf("streamed = %q, want the answer the proxy carried", streamed)
	}
	if response.StreamChunks == 0 {
		t.Error("the stream recorded no chunks")
	}
}
