package builtin

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/release"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// repoRootForTest walks up to go.mod so the tests can point TUDOUNI_HOME at the checkout
// that holds tools/vendor/anymd.
func repoRootForTest(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("no go.mod above the test's directory")
		}
		dir = parent
	}
}

// documentToolForTest builds the real tool over a temp workspace, or skips when this machine
// does not ship the extractor (every non-Windows machine, by design).
func documentToolForTest(t *testing.T) (tools.Tool, string) {
	t.Helper()
	if !AnymdPlatformSupported() {
		t.Skipf("%s/%s does not ship the document extractor", runtime.GOOS, runtime.GOARCH)
	}
	t.Setenv(paths.EnvHome, repoRootForTest(t))
	root := t.TempDir()
	workspace, err := tools.NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	tool, ok := NewReadDocument(workspace, nil, nil)
	if !ok {
		t.Fatalf("the vendored extractor is missing under %s", paths.VendorAnymd())
	}
	return tool, workspace.Root()
}

func callDocument(t *testing.T, tool tools.Tool, args map[string]any) tools.Result {
	t.Helper()
	result, err := tool.Handler(context.Background(), args)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	return result
}

func writeSampleDocx(t *testing.T, path string, paragraphs ...string) {
	t.Helper()
	raw, err := release.SampleDocx(paragraphs...)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestAPinnedVersionIsTheVersionOfTheVendoredBinary(t *testing.T) {
	if !AnymdPlatformSupported() {
		t.Skip("no extractor on this platform")
	}
	t.Setenv(paths.EnvHome, repoRootForTest(t))
	binary, ok := AnymdBinary()
	if !ok {
		t.Fatal("no vendored extractor")
	}
	outcome := runExtractor(context.Background(), []string{binary, "version"})
	if !outcome.ok() || !strings.Contains(outcome.stdout, release.AnymdVersion) {
		t.Fatalf("the binary says %q (stderr %q), the pin is %s", outcome.stdout, outcome.stderr, release.AnymdVersion)
	}
}

func TestASmallDocxIsReturnedWhole(t *testing.T) {
	tool, root := documentToolForTest(t)
	writeSampleDocx(t, filepath.Join(root, "memo.docx"), "Quarterly memo", "the-sentinel-sentence")

	result := callDocument(t, tool, map[string]any{"path": "memo.docx"})
	for _, want := range []string{"[read_document] memo.docx", "docx", "the-sentinel-sentence"} {
		if !strings.Contains(result.Text, want) {
			t.Errorf("result lacks %q:\n%s", want, result.Text)
		}
	}
	if strings.Contains(result.Text, "source:") || strings.Contains(result.Text, "---\n") {
		t.Errorf("the extractor's front matter leaked:\n%s", result.Text)
	}
	if result.Audit["document_format"] != "docx" {
		t.Errorf("audit = %v", result.Audit)
	}
}

func TestTheContentDecidesNotTheExtension(t *testing.T) {
	tool, root := documentToolForTest(t)
	// A docx with no extension and one with the wrong one: the extractor refuses both by
	// name, and the wrapper reads them anyway.
	writeSampleDocx(t, filepath.Join(root, "report"), "no-extension-sentinel")
	writeSampleDocx(t, filepath.Join(root, "report.dat"), "wrong-extension-sentinel")

	if got := callDocument(t, tool, map[string]any{"path": "report"}).Text; !strings.Contains(got, "no-extension-sentinel") {
		t.Errorf("a docx without an extension was not read:\n%s", got)
	}
	got := callDocument(t, tool, map[string]any{"path": "report.dat"}).Text
	if !strings.Contains(got, "wrong-extension-sentinel") {
		t.Errorf("a docx named .dat was not read:\n%s", got)
	}
	if strings.Contains(got, "read-document-") {
		t.Errorf("the temp copy's name leaked into the answer:\n%s", got)
	}
}

func TestABigDocumentGetsADirectoryFirstThenBoundedReads(t *testing.T) {
	tool, root := documentToolForTest(t)
	paragraphs := make([]string, 0, 400)
	for i := 0; i < 400; i++ {
		paragraphs = append(paragraphs, strings.Repeat("filler words for the size ", 6)+itoa(i))
	}
	writeSampleDocx(t, filepath.Join(root, "big.docx"), paragraphs...)

	first := callDocument(t, tool, map[string]any{"path": "big.docx"})
	if first.Audit["document_mode"] != "outline" {
		t.Fatalf("a big document should come back as a directory, got:\n%.400s", first.Text)
	}
	if strings.Contains(first.Text, "filler words") {
		t.Errorf("the directory carried document text")
	}
	if !strings.Contains(first.Text, "node=") {
		t.Errorf("the directory does not say how to read a part:\n%s", first.Text)
	}

	// Reading it as a whole is bounded, and says how to go on.
	read := callDocument(t, tool, map[string]any{"path": "big.docx", "node": "n1"})
	if read.Audit["document_mode"] != "read" {
		t.Fatalf("audit = %v\n%.300s", read.Audit, read.Text)
	}
	if !strings.Contains(read.Text, "[续读]") || !strings.Contains(read.Text, `cursor="`) || !strings.Contains(read.Text, `node="n1"`) {
		t.Fatalf("a stopped read must say how to continue:\n%.500s", read.Text)
	}
	if strings.Index(read.Text, "[续读]") > strings.Index(read.Text, "filler words") {
		t.Errorf("the continuation recipe must come before the body (the preview level cuts from the bottom)")
	}
	if strings.Contains(read.Text, "max_tokens") {
		t.Errorf("the model was told about a knob it does not have")
	}
	if len([]rune(read.Text)) > documentMaxChars+2000 {
		t.Errorf("one read returned %d chars, ceiling is %d", len([]rune(read.Text)), documentMaxChars)
	}

	// And the cursor really does continue.
	start := strings.Index(read.Text, `cursor="`) + len(`cursor="`)
	cursor := read.Text[start : start+strings.Index(read.Text[start:], `"`)]
	next := callDocument(t, tool, map[string]any{"path": "big.docx", "node": "n1", "cursor": cursor})
	if !strings.Contains(next.Text, "filler words") || !strings.Contains(next.Text, "续读") {
		t.Errorf("the continuation did not read on:\n%.400s", next.Text)
	}
}

func TestFailuresAreSentencesTheModelCanActOn(t *testing.T) {
	tool, root := documentToolForTest(t)
	writeSampleDocx(t, filepath.Join(root, "ok.docx"), "text")
	if err := os.WriteFile(filepath.Join(root, "notes.txt"), []byte("plain text\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "old.doc"), append([]byte{0xD0, 0xCF, 0x11, 0xE0}, make([]byte, 64)...), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "broken.docx"), []byte("PK\x03\x04 not really a zip"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "empty.pdf"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "folder"), 0o755); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		args map[string]any
		want string
	}{
		{"missing", map[string]any{"path": "nope.docx"}, "文件不存在"},
		{"directory", map[string]any{"path": "folder"}, "这是目录"},
		{"outside the workspace", map[string]any{"path": "../../outside.docx"}, "PermissionError"},
		{"text file", map[string]any{"path": "notes.txt"}, "read_file"},
		{"old binary office", map[string]any{"path": "old.doc"}, "另存为"},
		{"corrupt zip", map[string]any{"path": "broken.docx"}, "打不开"},
		{"empty file", map[string]any{"path": "empty.pdf"}, "文件是空的"},
		{"range that does not exist", map[string]any{"path": "ok.docx", "pages": "99"}, "这个范围不存在"},
		{"node that does not exist", map[string]any{"path": "ok.docx", "node": "n9"}, "没有这个目录节点"},
		{"pages that look like a flag", map[string]any{"path": "ok.docx", "pages": "--ocr"}, "pages 的写法不对"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := callDocument(t, tool, c.args).Text
			if !strings.Contains(got, c.want) {
				t.Errorf("answer lacks %q:\n%s", c.want, got)
			}
			if strings.Contains(got, root) {
				t.Errorf("the answer leaks the absolute workspace path:\n%s", got)
			}
		})
	}
}

func TestTheExtractorNeverRunsInTheWorkspace(t *testing.T) {
	// A cloned repository can carry a file the extractor would pick up from its working
	// directory; the wrapper runs it from the temp directory instead.
	tool, root := documentToolForTest(t)
	writeSampleDocx(t, filepath.Join(root, "a.docx"), "x")
	callDocument(t, tool, map[string]any{"path": "a.docx"})
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("reading a document left files in the workspace: %v", names)
	}
}

func TestACancelledTurnStopsTheExtractor(t *testing.T) {
	tool, root := documentToolForTest(t)
	writeSampleDocx(t, filepath.Join(root, "a.docx"), "x")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result, err := tool.Handler(ctx, map[string]any{"path": "a.docx", "pages": "1"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Text, "中断") {
		t.Errorf("a cancelled read should say it was interrupted: %q", result.Text)
	}
}

// The acceptance samples from the design document live in the untracked .poc-anymd
// directory; the tests that need them skip when a checkout does not have it.
func sampleForTest(t *testing.T, name string) string {
	t.Helper()
	matches, _ := filepath.Glob(filepath.Join(repoRootForTest(t), ".poc-anymd", "samples", name))
	if len(matches) == 0 {
		t.Skipf("acceptance sample %q is not in this checkout", name)
	}
	return matches[0]
}

func TestAcceptanceScannedPdfIsOneSentenceNotThirteenAdvertisements(t *testing.T) {
	tool, root := documentToolForTest(t)
	source := sampleForTest(t, "TR_*deep_research.pdf")
	raw, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "scan.pdf"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	got := callDocument(t, tool, map[string]any{"path": "scan.pdf"}).Text
	for _, want := range []string{"无文字层", "第 1-13 页", "不做 OCR"} {
		if !strings.Contains(got, want) {
			t.Errorf("answer lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "setup ocr") || strings.Contains(got, "2 GB") {
		t.Errorf("the OCR install advice reached the model:\n%s", got)
	}
	if len(got) > 1500 {
		t.Errorf("a 13-page scan cost %d bytes; the measured noise was ~4KB", len(got))
	}
}

func TestAcceptanceSpreadsheetSheetTruncationIsExplained(t *testing.T) {
	tool, root := documentToolForTest(t)
	source := sampleForTest(t, "All_Inflow*.xlsx")
	raw, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "data.xlsx"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	outline := callDocument(t, tool, map[string]any{"path": "data.xlsx"})
	if outline.Audit["document_mode"] != "outline" || !strings.Contains(outline.Text, "pandas") {
		t.Fatalf("a 43MB spreadsheet must come back as a directory:\n%.500s", outline.Text)
	}
	if len(outline.Text) > 4000 {
		t.Errorf("the directory is %d bytes", len(outline.Text))
	}

	// Sheet 1 is the one the proof of concept saw cut at 2000 rows. Read in budgeted pieces
	// it is not cut by the row ceiling in a single call, so only the bound is asserted here.
	read := callDocument(t, tool, map[string]any{"path": "data.xlsx", "pages": "1"})
	if len([]rune(read.Text)) > documentMaxChars+2000 {
		t.Errorf("one spreadsheet read returned %d chars", len([]rune(read.Text)))
	}
	if !strings.Contains(read.Text, "[续读]") {
		t.Errorf("a sheet this big must be a stopped read:\n%.400s", read.Text)
	}
}

func TestAcceptancePptxKeepsAnchorsAndStaysSmall(t *testing.T) {
	tool, root := documentToolForTest(t)
	source := sampleForTest(t, "SA issue report.pptx")
	raw, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "deck.pptx"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	got := callDocument(t, tool, map[string]any{"path": "deck.pptx"}).Text
	for _, want := range []string{"共 11 张幻灯片", "<!-- slide 1 -->", "Security Asset"} {
		if !strings.Contains(got, want) {
			t.Errorf("answer lacks %q:\n%.600s", want, got)
		}
	}
}
