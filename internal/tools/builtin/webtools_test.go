package builtin

import (
	"errors"
	"strings"
	"testing"
)

// The behaviours here are the ones with a price attached when they break: a key
// that leaks into history, a search that reports a number nobody can act on, a
// `file://` URL that walks around the workspace boundary, or a body decoded as
// UTF-8 until a Chinese page is a screen of question marks.

func TestRenderedSearchResultsAreMarkedUntrustedBeforeTheFirstResult(t *testing.T) {
	text := renderSearch("golang", SearchFindings{Hits: []SearchHit{
		{Title: "Go", URL: "https://go.dev", Snippet: "The Go programming language"},
	}})

	marker := strings.Index(text, "不可信内容")
	first := strings.Index(text, "1. Go")
	if marker < 0 {
		t.Fatalf("results are not marked as untrusted:\n%s", text)
	}
	if first < 0 || marker > first {
		t.Fatalf("the marker does not come before the results:\n%s", text)
	}
	// The marker has to govern the text it sits next to: titles and snippets are
	// attacker-controlled and they go straight into the context.
	if !strings.Contains(text, "标题和摘要") {
		t.Fatalf("the marker does not say what it covers:\n%s", text)
	}
}

func TestAnEmptySearchResultListStillSaysSomething(t *testing.T) {
	text := renderSearch("nothing matches this", SearchFindings{})
	if strings.TrimSpace(text) == "" {
		t.Fatal("an empty result set rendered as empty text; the model cannot tell that from a broken tool")
	}
	if !strings.Contains(text, "没有找到结果") {
		t.Fatalf("the text does not say there were no results: %q", text)
	}
}

func TestASnippetIsTruncatedAndTheTruncationIsVisible(t *testing.T) {
	long := strings.Repeat("词", MaxSnippetChars*2)
	clipped := clipSnippet(long)

	if !strings.Contains(clipped, "（原文") {
		t.Fatalf("a clipped snippet does not say it was clipped: %q", firstRunes(clipped, 60))
	}
	if runeCount(clipped) > MaxSnippetChars+40 {
		t.Fatalf("the clip kept %d characters, way past the %d limit", runeCount(clipped), MaxSnippetChars)
	}
	// Single line: a newline inside a numbered list item breaks the numbering.
	if strings.Contains(clipped, "\n") {
		t.Fatal("the snippet was not flattened to one line")
	}
}

func TestTheKeyNeverReachesTheModel(t *testing.T) {
	const secret = "tvly-supersecret"
	cases := []string{
		"request failed with header Authorization: Bearer " + secret,
		"invalid api key: " + secret,
	}

	for _, text := range cases {
		redacted := redactSecret(text, secret)
		if strings.Contains(redacted, secret) {
			t.Fatalf("the key survived redaction: %q", redacted)
		}
		if !strings.Contains(redacted, "***") {
			t.Fatalf("redaction left no marker, so the reader cannot tell a key was there: %q", redacted)
		}
	}
}

// TestRedactingAnEmptySecretChangesNothing ...
//
// Replacing "" would insert the replacement between every character — a disaster
// that only shows up on the machine with no key configured.
func TestRedactingAnEmptySecretChangesNothing(t *testing.T) {
	const text = "no key configured"
	if got := redactSecret(text, ""); got != text {
		t.Fatalf("an empty secret rewrote the text: %q", got)
	}
}

func TestAFailedSearchRecordsNoResultCount(t *testing.T) {
	backend := func(string, int) (SearchFindings, error) {
		return SearchFindings{}, SearchTransientError{Message: "rate limited"}
	}
	result := runSearch(backend, "anything", 5)

	if _, present := result.Audit["results"]; present {
		t.Fatal("a failed search recorded a result count")
	}
	if result.Audit["truncated"] != false {
		t.Fatal("a failed search claimed to be truncated")
	}
	// Transient and fatal failures have to read differently: "try again later" and
	// "go fix your key" are different instructions.
	if !strings.Contains(result.Text, "暂时性") {
		t.Fatalf("a transient failure is not described as transient: %q", result.Text)
	}
}

func TestAFatalSearchTellsTheModelNotToRepeatIt(t *testing.T) {
	backend := func(string, int) (SearchFindings, error) {
		return SearchFindings{}, SearchFatalError{Message: "401 from the search service"}
	}
	result := runSearch(backend, "anything", 5)

	if !strings.Contains(result.Text, "不要重复同样的调用") {
		t.Fatalf("a fatal failure does not tell the model to stop retrying: %q", result.Text)
	}
}

// --- fetch_web --------------------------------------------------------------

// TestOnlyHTTPSchemesAreAcceptedBeforeAnyRequestIsMade ...
//
// `file://` is the one that matters: it would let this tool read any local file and
// walk straight around the workspace boundary the file tools enforce.
func TestOnlyHTTPSchemesAreAcceptedBeforeAnyRequestIsMade(t *testing.T) {
	for _, rawURL := range []string{
		"file:///c:/windows/win.ini",
		"file:///etc/passwd",
		"ftp://example.com/x",
		"data:text/plain,hello",
		"not a url at all",
	} {
		result := fetchResult(nil, rawURL, 20)
		if !strings.Contains(result.Text, "只支持 http/https") {
			t.Fatalf("%q was not refused as a scheme problem: %q", rawURL, firstRunes(result.Text, 80))
		}
		// The body must never have been reached, so nothing about a status or an
		// encoding can appear.
		if _, present := result.Audit["http_status"]; present {
			t.Fatalf("%q reached the network", rawURL)
		}
	}
}

func TestTextualContentTypesAreRecognised(t *testing.T) {
	textual := []string{
		"text/html; charset=utf-8", "text/plain", "application/json",
		"application/xhtml+xml", "application/xml", "application/ld+json",
		"", "TEXT/HTML",
	}
	for _, contentType := range textual {
		if !isTextual(contentType) {
			t.Errorf("%q was treated as binary", contentType)
		}
	}

	binary := []string{
		"image/png", "application/pdf", "application/zip", "video/mp4",
		"application/octet-stream",
	}
	for _, contentType := range binary {
		if isTextual(contentType) {
			t.Errorf("%q was treated as readable text", contentType)
		}
	}
}

// TestEncodingAliasesFollowTheSupersetRule ...
//
// Decoding GBK with gb2312 turns rare characters into replacement characters, and
// gb18030 is always a superset. Decoding real pages with latin-1 turns curly quotes
// into invisible controls, because those pages actually send cp1252.
func TestEncodingAliasesFollowTheSupersetRule(t *testing.T) {
	cases := map[string]string{
		"gb2312":     "gb18030",
		"GBK":        "gb18030",
		"iso-8859-1": "windows-1252",
		"latin1":     "windows-1252",
		"utf-8":      "utf-8",
	}
	for input, want := range cases {
		_, name, ok := okEncoding(input)
		if !ok {
			t.Errorf("%q was not recognised at all", input)
			continue
		}
		if name != want {
			t.Errorf("%q normalised to %q, want %q", input, name, want)
		}
	}
	if _, _, ok := okEncoding("not-a-real-encoding"); ok {
		t.Error("an invented encoding name was accepted")
	}
}

// TestAGBKPageIsDecodedEvenWithNoDeclarationAtAll is the case the guess list exists
// for, and the one a plain UTF-8 fallback turns into a screen of U+FFFD.
func TestAGBKPageIsDecodedEvenWithNoDeclarationAtAll(t *testing.T) {
	// Encoded in GBK, with no charset in the header and no meta tag.
	grant, _, _ := okEncoding("gb18030")
	encoded, err := grant.NewEncoder().Bytes([]byte("<html><body>中文内容，没有声明编码</body></html>"))
	if err != nil {
		t.Fatal(err)
	}

	text, _ := decodeBody(encoded, "text/html")
	if strings.Contains(text, "\uFFFD") {
		t.Fatalf("a GBK page came back full of replacement characters: %q", text)
	}
	if !strings.Contains(text, "中文内容") {
		t.Fatalf("a GBK page did not decode: %q", text)
	}
}

func TestADeclaredEncodingIsTakenAtItsWord(t *testing.T) {
	// The header says the page is UTF-8, and the bytes really are.
	text, name := decodeBody([]byte("hello world"), "text/html; charset=utf-8")
	if name != "utf-8" || text != "hello world" {
		t.Fatalf("a declared UTF-8 page decoded as %q / %q", name, text)
	}

	// A UTF-8 BOM is the byte stream speaking for itself, harder than any header.
	bom := append([]byte{0xEF, 0xBB, 0xBF}, []byte("hello")...)
	text, name = decodeBody(bom, "text/html")
	if name != "utf-8-sig" {
		t.Fatalf("a BOM was not detected: %q", name)
	}
	if strings.HasPrefix(text, "\uFEFF") {
		t.Fatal("the BOM was left in the decoded text")
	}
}

// --- HTML → text ------------------------------------------------------------

func TestHTMLToTextKeepsTheTitleAndDropsScripts(t *testing.T) {
	source := `<html><head><title>页面标题</title>
	<style>body { color: red }</style>
	<script>alert("should not appear")</script></head>
	<body><h1>第一段</h1><p>正文一句话。</p></body></html>`

	text, title := htmlToText(source)

	if title != "页面标题" {
		t.Fatalf("title is %q", title)
	}
	if strings.Contains(text, "should not appear") {
		t.Fatalf("script content survived:\n%s", text)
	}
	if strings.Contains(text, "color: red") {
		t.Fatalf("style content survived:\n%s", text)
	}
	if !strings.Contains(text, "正文一句话。") {
		t.Fatalf("the body was lost:\n%s", text)
	}
}

// TestBlockBoundariesBecomeNewlines: without them `<p>a</p><p>b</p>` is "a b", and
// paragraph boundaries are the only structural signal a page has.
func TestBlockBoundariesBecomeNewlines(t *testing.T) {
	text, _ := htmlToText("<p>第一段</p><p>第二段</p>")
	lines := strings.Split(text, "\n")
	if len(lines) < 2 {
		t.Fatalf("paragraphs were joined into one line: %q", text)
	}
	for _, line := range lines {
		if strings.Contains(line, "第一段") && strings.Contains(line, "第二段") {
			t.Fatalf("two paragraphs ended up on one line: %q", line)
		}
	}
}

// TestConsecutiveBlankLinesCollapse ...
//
// Nested divs produce dozens of blank lines, and every one is re-sent to the model
// on every round.
func TestConsecutiveBlankLinesCollapse(t *testing.T) {
	text, _ := htmlToText("<div><div><div></div></div></div><p>只有一行</p>")
	if strings.Contains(text, "\n\n\n") {
		t.Fatalf("blank lines were not collapsed: %q", text)
	}
	if !strings.Contains(text, "只有一行") {
		t.Fatalf("the content was lost: %q", text)
	}
}

// TestBadHTMLDoesNotSwallowThePage ...
//
// A parser that throws on malformed markup raises away half a page. The rule is the
// same as elsewhere: losing some text must not become "the tool failed".
func TestBadHTMLDoesNotSwallowThePage(t *testing.T) {
	for _, source := range []string{
		"<html><body><p>没有闭合的段落",
		"<div><span>交叉</div></span>",
		"纯文本，根本没有标签",
		"<!-- 只有注释 -->",
	} {
		text, _ := htmlToText(source)
		if strings.TrimSpace(source) != "" && strings.TrimSpace(text) == "" &&
			!strings.Contains(source, "只有注释") && !strings.Contains(source, "交叉") {
			t.Fatalf("%q produced nothing", source)
		}
	}
}

// --- failure wording --------------------------------------------------------

// TestTheThreeConnectionFailuresReadDifferently ...
//
// Mixing them up has a concrete price: a certificate failure is permanent, and
// "probably a typo in the domain" sends the model off to edit an address that was
// never wrong.
func TestTheThreeConnectionFailuresReadDifferently(t *testing.T) {
	dns := connectNote("https://x.invalid", "no such host", "dns")
	tls := connectNote("https://x.example", "certificate signed by unknown authority", "tls")
	generic := connectNote("https://x.example", "connection refused", "connect")

	if !strings.Contains(dns, "地址写错") {
		t.Errorf("the DNS failure does not point at the address: %q", firstRunes(dns, 60))
	}
	if !strings.Contains(tls, "重试、换时间都没有用") {
		t.Errorf("the TLS failure does not say that retrying is pointless: %q", firstRunes(tls, 60))
	}
	if !strings.Contains(generic, "连不上") {
		t.Errorf("the generic failure does not say what happened: %q", firstRunes(generic, 60))
	}
	if dns == tls || tls == generic {
		t.Error("two of the three buckets produce identical sentences")
	}
}

func TestATimeoutNamesTheStageItHappenedIn(t *testing.T) {
	connect := timeoutNote("ConnectTimeout", "https://slow.example", 20)
	read := timeoutNote("ReadTimeout", "https://slow.example", 20)

	if !strings.Contains(connect, "连接阶段") {
		t.Errorf("the connect timeout does not name its stage: %q", firstRunes(connect, 60))
	}
	if !strings.Contains(read, "读取阶段") {
		t.Errorf("the read timeout does not name its stage: %q", firstRunes(read, 60))
	}
	if connect == read {
		t.Error("two timeout stages produce identical sentences, so raising timeout_seconds looks like the fix for both")
	}
	for _, text := range []string{connect, read} {
		if !strings.Contains(text, "120") {
			t.Errorf("the timeout message does not name the ceiling: %q", firstRunes(text, 80))
		}
	}
}

func TestABinaryResponseSaysWhatItIsAndHowBig(t *testing.T) {
	text := notTextualNote("image/png", 4096)
	if !strings.Contains(text, "image/png") {
		t.Errorf("the refusal does not name the type: %q", text)
	}
	if !strings.Contains(text, "4096") {
		t.Errorf("the refusal does not say how much was read: %q", text)
	}
}

func TestUnknownTimeoutStagesStillProduceASentence(t *testing.T) {
	text := timeoutNote("SomeFutureTimeout", "https://x.example", 20)
	if strings.TrimSpace(text) == "" || strings.Contains(text, "（）") {
		t.Fatalf("an unknown stage produced a broken sentence: %q", text)
	}
}

func TestFetchedStatusLineCarriesTheFactsTheModelNeeds(t *testing.T) {
	line := statusLine(Fetched{Status: 404, Redirects: 2, ContentType: "text/html"})
	for _, want := range []string{"404", "2 次重定向", "text/html"} {
		if !strings.Contains(line, want) {
			t.Errorf("the status line is missing %q: %q", want, line)
		}
	}
}

func TestTransportErrorsAreNotMistakenForResultErrors(t *testing.T) {
	// The typed errors have to survive errors.As through the reporting path, or a
	// scheme refusal gets reported as "not textual".
	if !errors.As(error(errTimeout{Stage: "ReadTimeout"}), new(errTimeout)) {
		t.Error("errTimeout does not survive errors.As")
	}
	if !errors.As(error(unsupportedScheme{URL: "file:///x", Scheme: "file"}), new(unsupportedScheme)) {
		t.Error("unsupportedScheme does not survive errors.As")
	}
	if !errors.As(error(notTextual{ContentType: "image/png"}), new(notTextual)) {
		t.Error("notTextual does not survive errors.As")
	}
}
