package model

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/proxy"
)

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
// The test drives the adapter with **no injected client**, which is the path a real
// run takes: an injected client bypasses the transport this is about, so a test
// using one would pass whether or not the bug was fixed.
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

	adapter := newTestAdapter(t, Options{Route: route(gateway.URL, "gpt-x", StyleOpenAI)})
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

	var tunnels []string
	proxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			t.Errorf("the proxy saw %s, want a CONNECT tunnel for an https target", r.Method)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		tunnels = append(tunnels, r.Host)

		upstream, err := net.Dial("tcp", r.Host)
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

	// The adapter is built with the **same** proxy decision production makes; only
	// the certificate trust is swapped in, because httptest signs its gateway with a
	// throwaway CA. That is the only difference from a real run, and it is unrelated
	// to what is being measured.
	transport, source := proxy.Transport()
	if source == "" {
		t.Fatal("no source reported for the proxy decision")
	}
	trusted, ok := gateway.Client().Transport.(*http.Transport)
	if !ok {
		t.Fatal("httptest did not hand back a transport to borrow trust from")
	}
	transport.TLSClientConfig = trusted.TLSClientConfig

	response, err := (&http.Client{Transport: transport}).Get(gateway.URL)
	if err != nil {
		t.Fatalf("an https request through the proxy failed: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Errorf("status = %d", response.StatusCode)
	}
	if len(tunnels) == 0 {
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
// All four, and in one place, because on Windows environment names are
// case-insensitive: setting `HTTPS_PROXY` and then clearing `https_proxy` clears
// the value that was just set. That trap is why the list lives in the package under
// test rather than being spelled out per test.
func clearProxyVariables(t *testing.T) {
	t.Helper()
	for _, name := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"} {
		t.Setenv(name, "")
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
