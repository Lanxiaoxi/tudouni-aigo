package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// netprobe measures one real streaming chat request against one endpoint.
//
// It exists to answer a question that "can I reach the host" cannot: **is this
// path usable for a conversation**. A TLS handshake that succeeds and a reply that
// arrives in four minutes are the same "reachable" to a ping test and completely
// different to a person waiting for the first token. So the two numbers this
// prints are
//
//   - TTFB, the time to the **first content chunk** — what "responsive" means
//     while you are watching the screen;
//   - total, the whole answer.
//
// It is deliberately not part of the program. Probing the network is a
// diagnostic, not a feature: nothing here is imported by the runtime, and a
// failure proves something about the network rather than about the code.
func main() {
	var (
		via    = flag.String("via", "proxy", `how to connect: "direct" (ignore every proxy), "proxy" (use -proxy), "env" (let HTTP(S)_PROXY decide), "system" (read the Windows system proxy)`)
		proxy  = flag.String("proxy", "http://127.0.0.1:7897", "proxy URL for -via=proxy")
		base   = flag.String("base", "https://opencode.ai/zen/go/v1", "base URL, the same shape the config file uses")
		style  = flag.String("style", "openai", "wire protocol: openai | anthropic | responses")
		model  = flag.String("model", "glm-5.3-flash", "model id")
		key    = flag.String("key", "", "API key (required)")
		ua     = flag.String("ua", "tudouni-netprobe/0.1", "User-Agent; the Go gateway requires a client to identify itself")
		sess   = flag.String("session", "netprobe-0001", "x-opencode-session value")
		repeat = flag.Int("n", 1, "how many requests to send, sequentially")
		wait   = flag.Duration("timeout", 45*time.Second, "whole-request timeout")
	)
	flag.Parse()

	if *key == "" {
		fmt.Fprintln(os.Stderr, "netprobe: -key is required (the API key is never read from the config file: this tool must not be able to leak it)")
		os.Exit(2)
	}

	transport, description, err := transportFor(*via, *proxy)
	if err != nil {
		fmt.Fprintln(os.Stderr, "netprobe:", err)
		os.Exit(2)
	}
	client := &http.Client{Transport: transport, Timeout: *wait}

	url := strings.TrimRight(*base, "/") + pathFor(*style)
	body := bodyFor(*style, *model)

	fmt.Printf("via       %s\n", description)
	fmt.Printf("target    %s\n", url)
	fmt.Printf("model     %s   style=%s\n\n", *model, *style)

	failures := 0
	for i := 0; i < *repeat; i++ {
		if i > 0 {
			time.Sleep(400 * time.Millisecond)
		}
		result := probe(client, url, *key, *ua, *sess, body, *style == "anthropic")
		fmt.Printf("%s\n", result)
		if result.failed() {
			failures++
		}
	}
	if failures > 0 {
		fmt.Printf("\n%d/%d failed\n", failures, *repeat)
	}
}

// outcome is one probe's measurement.
//
// Connect and TTFB are separate on purpose: a TLS handshake that takes ten
// seconds and a decode that takes ten seconds are different problems with
// different fixes, and a single total cannot tell them apart.
type outcome struct {
	connect   time.Duration
	ttfb      time.Duration
	total     time.Duration
	status    int
	bytes     int
	firstText string
	err       error
}

func (o outcome) failed() bool { return o.err != nil || o.status >= 400 }

func (o outcome) String() string {
	if o.err != nil {
		return fmt.Sprintf("  connect=%-8s total=%-9s  FAIL  %v", fmtDur(o.connect), fmtDur(o.total), o.err)
	}
	head := fmt.Sprintf("  HTTP %d", o.status)
	line := fmt.Sprintf("%s  connect=%-8s ttfb=%-9s total=%-9s %d bytes",
		head, fmtDur(o.connect), fmtDur(o.ttfb), fmtDur(o.total), o.bytes)
	if o.firstText != "" {
		line += "\n            first text: " + o.firstText
	}
	return line
}

// probe sends one streaming request and times it.
//
// Connect is measured separately from the rest because a TLS handshake that takes
// ten seconds and a decode that takes ten seconds are different problems with
// different fixes, and total time alone cannot tell them apart.
func probe(client *http.Client, url, key, ua, sess string, body []byte, anthropic bool) outcome {
	var out outcome
	start := time.Now()

	request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		out.err = err
		return out
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("User-Agent", ua)
	request.Header.Set("x-opencode-session", sess)
	if anthropic {
		request.Header.Set("x-api-key", key)
	} else {
		request.Header.Set("Authorization", "Bearer "+key)
	}

	response, err := client.Do(request)
	out.connect = time.Since(start)
	if err != nil {
		out.total = time.Since(start)
		out.err = tidy(err)
		return out
	}
	defer response.Body.Close()
	out.status = response.StatusCode

	reader := bufio.NewReaderSize(response.Body, 4096)
	first := true
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			out.bytes += len(line)
			if first && isContent(line) {
				out.ttfb = time.Since(start)
				out.firstText = snippet(line)
				first = false
			}
		}
		if err != nil {
			// EOF is how a stream ends normally; anything else is a broken read.
			if err != io.EOF {
				out.err = tidy(err)
			}
			break
		}
	}
	out.total = time.Since(start)
	if out.status >= 400 {
		// The status is the measurement here. The body is the endpoint's own
		// explanation and it is not this tool's job to interpret it, but a refusal
		// with no output must not read as a success.
		out.err = fmt.Errorf("endpoint refused the request (HTTP %d) — check -model/-style against the vendor's endpoint table", out.status)
	}
	return out
}

// isContent reports whether one SSE line carries actual output.
//
// Only the events that mean "the model said something" count, on both wire
// shapes: an OpenAI-compatible stream puts text in `choices[].delta.content`, the
// Messages shape in `content_block_delta`. Counting the first byte of the
// response instead would report the moment the headers arrived, which is early by
// exactly the amount that matters.
func isContent(line string) bool {
	data, ok := strings.CutPrefix(strings.TrimSpace(line), "data:")
	if !ok {
		return false
	}
	data = strings.TrimSpace(data)
	if data == "" || data == "[DONE]" {
		return false
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(data), &payload); err != nil {
		return false
	}
	if choices, ok := payload["choices"].([]any); ok && len(choices) > 0 {
		choice, _ := choices[0].(map[string]any)
		delta, _ := choice["delta"].(map[string]any)
		if delta == nil {
			delta, _ = choice["message"].(map[string]any)
		}
		if text, _ := delta["content"].(string); text != "" {
			return true
		}
	}
	switch payload["type"] {
	case "content_block_delta", "response.output_text.delta", "response.reasoning_summary_text.delta":
		return true
	}
	return false
}

func snippet(line string) string {
	text := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "data:"))
	if len(text) > 90 {
		text = text[:90] + "…"
	}
	return text
}

func fmtDur(d time.Duration) string {
	if d <= 0 {
		return "—"
	}
	return fmt.Sprintf("%.2fs", d.Seconds())
}

// tidy shortens the errors that matter and keeps the ones that name a cause.
func tidy(err error) error {
	text := err.Error()
	lower := strings.ToLower(text)
	switch {
	case strings.Contains(lower, "tls handshake timeout"):
		return fmt.Errorf("TLS handshake timeout — the connection was never established (network path, not the endpoint)")
	case strings.Contains(lower, "connection refused"):
		return fmt.Errorf("connection refused — the proxy is not there or not routing: %v", err)
	case strings.Contains(text, "Client.Timeout"):
		return fmt.Errorf("timed out after the whole-request budget")
	}
	return err
}

func pathFor(style string) string {
	switch style {
	case "anthropic":
		return "/v1/messages"
	case "responses":
		return "/v1/responses"
	default:
		return "/chat/completions"
	}
}

// bodyFor builds a minimal streaming request for each shape.
func bodyFor(style, model string) []byte {
	switch style {
	case "anthropic":
		return mustJSON(map[string]any{
			"model": model, "max_tokens": 16, "stream": true,
			"messages": []any{map[string]any{"role": "user", "content": "Say the word: pong"}},
		})
	case "responses":
		return mustJSON(map[string]any{
			"model": model, "input": "Say the word: pong",
			"max_output_tokens": 16, "stream": true, "store": false,
		})
	default:
		return mustJSON(map[string]any{
			"model": model, "max_tokens": 16, "stream": true,
			"messages": []any{map[string]any{"role": "user", "content": "Say the word: pong"}},
		})
	}
}

func mustJSON(value any) []byte {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return raw
}

// transportFor builds the three ways of reaching the same host.
//
// "system" reads the Windows system proxy the way a browser does. Go's own
// DefaultTransport never does — it reads environment variables only — which is
// exactly the difference this tool exists to show.
func transportFor(via, proxyURL string) (*http.Transport, string, error) {
	base := &http.Transport{
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          4,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second, // Go's default, kept so timings are comparable
		ExpectContinueTimeout: time.Second,
	}
	switch via {
	case "direct":
		base.Proxy = nil
		return base, "direct (no proxy at all — this is what tudouni does today)", nil
	case "env":
		base.Proxy = http.ProxyFromEnvironment
		return base, "env (HTTP_PROXY/HTTPS_PROXY, what tudouni honours)", nil
	case "proxy":
		parsed, err := url.Parse(proxyURL)
		if err != nil {
			return nil, "", fmt.Errorf("bad -proxy %q: %w", proxyURL, err)
		}
		base.Proxy = http.ProxyURL(parsed)
		return base, "proxy " + proxyURL, nil
	case "system":
		system, found, err := systemProxy()
		if err != nil {
			return nil, "", err
		}
		if !found {
			return nil, "", fmt.Errorf("no Windows system proxy is configured (ProxyEnable=0 and no PAC)")
		}
		base.Proxy = http.ProxyURL(system)
		return base, "system proxy " + system.String(), nil
	}
	return nil, "", fmt.Errorf("unknown -via %q: direct | proxy | env | system", via)
}
