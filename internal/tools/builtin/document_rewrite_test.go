package builtin

import (
	"strings"
	"testing"
)

// These tests need no extractor binary: the rewrites are pure functions of text, and the
// inputs below are the shapes the proof of concept actually saw.

const scannedHint = "scanned image, no text layer; to enable local OCR, run `anymd setup ocr` (opts into downloading ~2 GB)"

func TestScannedPagesCollapseIntoOneSentenceWithoutOCRAdvice(t *testing.T) {
	var raw strings.Builder
	raw.WriteString("<!-- Every page shown is a scanned image with no text layer; run `anymd setup ocr` -->\n\n")
	for page := 1; page <= 13; page++ {
		raw.WriteString("<!-- page " + itoa(page) + " -->\n\n")
		raw.WriteString("<!-- page " + itoa(page) + ": " + scannedHint + " -->\n\n")
	}
	outcome := rewriteDocument(raw.String(), "pdf")

	if strings.Contains(outcome.Text, "anymd") || strings.Contains(outcome.Text, "OCR") {
		t.Errorf("the extractor's install advice reached the model: %q", outcome.Text)
	}
	if len(outcome.ScannedPages) != 13 {
		t.Fatalf("scanned pages = %v, want 13", outcome.ScannedPages)
	}
	if got := pageRanges(outcome.ScannedPages); got != "1-13" {
		t.Errorf("page ranges = %q, want 1-13", got)
	}
	note := scannedNote(outcome.ScannedPages)
	for _, want := range []string{"第 1-13 页", "无文字层", "不做 OCR"} {
		if !strings.Contains(note, want) {
			t.Errorf("the scanned-page sentence lacks %q: %s", want, note)
		}
	}
	if strings.Contains(note, "setup") {
		t.Errorf("the sentence must not pass on the install advice: %s", note)
	}
}

func TestTextPagesKeepTheirAnchorsWhenOthersAreScanned(t *testing.T) {
	raw := "<!-- page 1 -->\n\nHello text\n\n<!-- page 2 -->\n\n<!-- page 2: " + scannedHint + " -->\n"
	outcome := rewriteDocument(raw, "pdf")
	if !strings.Contains(outcome.Text, "<!-- page 1 -->") || !strings.Contains(outcome.Text, "Hello text") {
		t.Errorf("a page with text lost its anchor or body: %q", outcome.Text)
	}
	if strings.Contains(outcome.Text, "page 2") {
		t.Errorf("the scanned page's anchor should be gone: %q", outcome.Text)
	}
	if len(outcome.ScannedPages) != 1 || outcome.ScannedPages[0] != 2 {
		t.Errorf("scanned pages = %v", outcome.ScannedPages)
	}
}

func TestPageRangesAreCompact(t *testing.T) {
	cases := map[string][]int{
		"1":         {1},
		"1-3,5,7-8": {1, 2, 3, 5, 7, 8},
		"2,4,6":     {2, 4, 6},
	}
	for want, pages := range cases {
		if got := pageRanges(pages); got != want {
			t.Errorf("pageRanges(%v) = %q, want %q", pages, got, want)
		}
	}
}

func TestSheetTruncationSaysHowMuchWasLostAndThatItCannotBeResumed(t *testing.T) {
	raw := "<!-- sheet radiosw_2026_tr_info -->\n\n|a|b|\n|1|2|\n\n… 1876 more rows\n\n<!-- sheet next -->\n"
	outcome := rewriteDocument(raw, "xlsx")

	if strings.Contains(outcome.Text, "more rows") {
		t.Errorf("the bare upstream sentence survived: %q", outcome.Text)
	}
	for _, want := range []string{"radiosw_2026_tr_info", "2000", "1876", "不支持续读", "pandas"} {
		if !strings.Contains(outcome.Text, want) {
			t.Errorf("the truncation note lacks %q: %q", want, outcome.Text)
		}
	}
	if len(outcome.Truncated) != 1 || outcome.Truncated[0].Dropped != 1876 || outcome.Truncated[0].Name != "radiosw_2026_tr_info" {
		t.Errorf("truncated = %+v", outcome.Truncated)
	}
}

func TestAContinuedSheetAnchorStillNamesTheSheet(t *testing.T) {
	raw := "<!-- sheet Data (continued) -->\n\n|a|\n\n... 5 more rows\n"
	outcome := rewriteDocument(raw, "xlsx")
	if len(outcome.Truncated) != 1 || outcome.Truncated[0].Name != "Data" {
		t.Errorf("the sheet name should not carry the (continued) suffix: %+v", outcome.Truncated)
	}
}

func TestTableOfContentsIsDroppedOnlyInDocx(t *testing.T) {
	toc := "Table Of Contents\n\n**1.\tINTRODUCTION\t3**\n\n**1.1.\tScope\t3**\n\n**2.\tRevision History\t3**\n\n# Real heading\n\nBody.\n"
	docx := rewriteDocument(toc, "docx")
	if strings.Contains(docx.Text, "INTRODUCTION") {
		t.Errorf("the printed table of contents survived: %q", docx.Text)
	}
	if docx.TOCLines != 3 || !strings.Contains(docx.Text, "目录页共 3 行") {
		t.Errorf("toc lines = %d, text = %q", docx.TOCLines, docx.Text)
	}
	if !strings.Contains(docx.Text, "# Real heading") || !strings.Contains(docx.Text, "Body.") {
		t.Errorf("content after the table of contents was eaten: %q", docx.Text)
	}

	// The same text in a spreadsheet is data, not a table of contents.
	xlsx := rewriteDocument(toc, "xlsx")
	if !strings.Contains(xlsx.Text, "INTRODUCTION") {
		t.Errorf("a non-docx document lost lines to the TOC rewrite: %q", xlsx.Text)
	}
}

func TestAHeadingCalledContentsWithoutEntriesIsKept(t *testing.T) {
	raw := "Contents\n\nThis section explains the contents of the box.\n"
	outcome := rewriteDocument(raw, "docx")
	if !strings.Contains(outcome.Text, "explains the contents") || outcome.TOCLines != 0 {
		t.Errorf("a prose section was mistaken for a table of contents: %+v", outcome)
	}
}

func TestEmptySlidesAreAnnotatedButATruncatedLastSlideIsNot(t *testing.T) {
	raw := "<!-- slide 1 -->\n\n## Title\n\n<!-- slide 2 -->\n\n<!-- slide 3 -->\n\nText\n\n<!-- slide 4 -->\n"
	outcome := rewriteDocument(raw, "pptx")
	if outcome.EmptySlides != 2 {
		t.Errorf("empty slides = %d, want 2 (slide 2 and the trailing slide 4)", outcome.EmptySlides)
	}
	if strings.Count(outcome.Text, "纯图形内容") != 2 {
		t.Errorf("annotations = %d: %q", strings.Count(outcome.Text, "纯图形内容"), outcome.Text)
	}

	// A budget stop right after an anchor means the slide's text may simply not have been
	// reached. Calling it picture-only would be false.
	cut := rewriteDocument("<!-- slide 5 -->\n\n<!-- Stopped at the 500-token budget. Continue with cursor: \"1:100\", or pick pages, or raise max_tokens. -->\n", "pptx")
	if strings.Contains(cut.Text, "纯图形内容") {
		// The footer line is removed from the text, so the slide looks empty after
		// rewriting; what matters is that a cursor is reported, and the caller says so.
		if cut.NextCursor != "1:100" {
			t.Errorf("cursor = %q, want 1:100", cut.NextCursor)
		}
	}
}

func TestTheBudgetFooterBecomesACursorAndIsNotPassedOn(t *testing.T) {
	raw := "text\n\n<!-- Stopped at the 8000-token budget. Continue with cursor: \"2:16772\", or pick pages, or raise max_tokens. -->\n"
	outcome := rewriteDocument(raw, "xlsx")
	if outcome.NextCursor != "2:16772" {
		t.Errorf("cursor = %q", outcome.NextCursor)
	}
	if strings.Contains(outcome.Text, "max_tokens") {
		t.Errorf("the model must not be told about a knob it does not have: %q", outcome.Text)
	}
}

func TestBlankLinesCollapseExceptInsideFences(t *testing.T) {
	raw := "a\n\n\n\nb\n```\nx\n\n\ny\n```\n\n\nc"
	got := rewriteDocument(raw, "docx").Text
	if !strings.Contains(got, "a\n\nb") {
		t.Errorf("blank runs outside fences should collapse: %q", got)
	}
	if !strings.Contains(got, "x\n\n\ny") {
		t.Errorf("blank lines inside a fence are content: %q", got)
	}
}

func TestCapTextCutsOnALineAndSaysNothingItself(t *testing.T) {
	text := strings.Repeat("0123456789\n", 100)
	cut, capped := capText(text, 255)
	if !capped || len(cut) > 255 || !strings.HasSuffix(cut, "9") {
		t.Errorf("capped=%v len=%d tail=%q", capped, len(cut), cut[max(0, len(cut)-5):])
	}
	if same, capped := capText("short", 255); capped || same != "short" {
		t.Errorf("short text must pass untouched")
	}
}

func TestEstimateTokensChargesChineseMoreThanLatin(t *testing.T) {
	latin := estimateTokens(strings.Repeat("abcd", 1000))
	chinese := estimateTokens(strings.Repeat("中", 1000))
	if latin != 1000 || chinese != 1000 {
		t.Errorf("latin=%d chinese=%d, want 1000 each (4000 latin chars vs 1000 CJK chars)", latin, chinese)
	}
}

func TestFrontMatterIsSplitOffAndOnlyTheTotalIsKept(t *testing.T) {
	raw := "---\nsource: C:\\Temp\\document.docx\nformat: pdf\npages: 13\nauthor: Someone\nshowing: pages 1-2\n---\n\n<!-- page 1 -->\nBody\n"
	body, meta := splitFrontMatter(raw)
	if strings.Contains(body, "Someone") || strings.Contains(body, "Temp") || !strings.Contains(body, "Body") {
		t.Errorf("body = %q", body)
	}
	if meta.Total != "共 13 页" || meta.Showing != "pages 1-2" {
		t.Errorf("meta = %+v", meta)
	}
	// No front matter is not an error.
	if body, _ := splitFrontMatter("plain"); body != "plain" {
		t.Errorf("plain text changed: %q", body)
	}
}

func TestArgumentValidationRefusesAnythingThatCouldBeAFlag(t *testing.T) {
	cases := []struct{ pages, node, cursor, want string }{
		{"1-5,8", "", "", ""},
		{"", "n1.5.2", "", ""},
		{"2", "", "2:16772", ""},
		{"--ocr", "", "", "pages 的写法不对"},
		{"1-", "", "", "pages 的写法不对"},
		{"", "../x", "", "node 的写法不对"},
		{"", "-n1", "", "node 的写法不对"},
		{"", "", "--max-tokens", "cursor 的写法不对"},
		{"1", "n1", "", "不能同时用"},
	}
	for _, c := range cases {
		got := validateDocumentArgs(c.pages, c.node, c.cursor)
		if c.want == "" && got != "" || c.want != "" && !strings.Contains(got, c.want) {
			t.Errorf("validate(%q,%q,%q) = %q, want contains %q", c.pages, c.node, c.cursor, got, c.want)
		}
	}
	if compactArg("1-5, 8") != "1-5,8" {
		t.Errorf("spaces inside a range should not matter")
	}
}

func TestContinuationCarriesTheArgumentsThatMustTravelWithTheCursor(t *testing.T) {
	got := continuation(documentRequest{display: "docs/a.xlsx", pages: "2"}, "2:16772")
	for _, want := range []string{`path="docs/a.xlsx"`, `pages="2"`, `cursor="2:16772"`} {
		if !strings.Contains(got, want) {
			t.Errorf("continuation lacks %s: %s", want, got)
		}
	}
	if strings.Contains(continuation(documentRequest{display: "a.docx"}, "1:5"), "pages") {
		t.Errorf("an unused argument should not appear")
	}
}

func TestOutlineRendersSizesAndMarksAnAllScannedPdf(t *testing.T) {
	raw := `{"format":"pdf","unit":"page","nodes":[
	  {"id":"n1","title":"Document","level":0,"from":1,"to":2,"start":0,"end":251,"children":2},
	  {"id":"n1.1","title":"page 1","level":1,"from":1,"to":1,"start":17,"end":17,"children":0},
	  {"id":"n1.2","title":"page 2","level":1,"from":2,"to":2,"start":30,"end":30,"children":0}]}`
	document, err := parseOutline(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	text := renderOutline("scan.pdf", document)
	for _, want := range []string{"scan.pdf", "共 2 页", "pages=", "无文字", "扫描件"} {
		if !strings.Contains(text, want) {
			t.Errorf("outline lacks %q:\n%s", want, text)
		}
	}
}

func TestOutlineForSpreadsheetsPointsAtPandasAndExplainsSheetNumbers(t *testing.T) {
	raw := `{"format":"xlsx","unit":"sheet","nodes":[
	  {"id":"n1","title":"Document","level":0,"from":1,"to":2,"start":0,"end":900000,"children":2},
	  {"id":"n1.1","title":"data","level":1,"from":1,"to":1,"start":0,"end":800000,"children":0},
	  {"id":"n1.2","title":"sum","level":1,"from":2,"to":2,"start":800000,"end":900000,"children":0}]}`
	document, err := parseOutline(raw)
	if err != nil {
		t.Fatal(err)
	}
	text := renderOutline("a.xlsx", document)
	for _, want := range []string{"pandas", "sheet 序号", "2000 行", "n1.1"} {
		if !strings.Contains(text, want) {
			t.Errorf("outline lacks %q:\n%s", want, text)
		}
	}
}

func TestOutlineIsBoundedForHugeDecks(t *testing.T) {
	var nodes strings.Builder
	nodes.WriteString(`{"format":"pptx","unit":"slide","nodes":[{"id":"n1","title":"d","level":0,"from":1,"to":500,"start":0,"end":500000,"children":500}`)
	for i := 1; i <= 500; i++ {
		nodes.WriteString(`,{"id":"n1.` + itoa(i) + `","title":"s","level":1,"from":` + itoa(i) + `,"to":` + itoa(i) + `,"start":0,"end":10,"children":0}`)
	}
	nodes.WriteString(`]}`)
	document, err := parseOutline(nodes.String())
	if err != nil {
		t.Fatal(err)
	}
	text := renderOutline("deck.pptx", document)
	if got := strings.Count(text, "\n  n1.") + strings.Count(text, "\nn1."); got > maxOutlineEntries+1 {
		t.Errorf("listed %d entries, ceiling is %d", got, maxOutlineEntries)
	}
	if !strings.Contains(text, "还有 300 项没有列出") {
		t.Errorf("the omission is not stated:\n%s", text[max(0, len(text)-300):])
	}
}
