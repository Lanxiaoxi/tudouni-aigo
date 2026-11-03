package builtin

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/content"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// fakeRenderer records what it was asked for and returns a tiny valid JPEG per page.
type fakeRenderer struct {
	calls [][]int
	err   error
	skip  map[int]bool
}

func (f *fakeRenderer) render(_ context.Context, _ string, pages []int) ([]renderedPage, error) {
	f.calls = append(f.calls, append([]int(nil), pages...))
	if f.err != nil {
		return nil, f.err
	}
	var out []renderedPage
	for _, page := range pages {
		if f.skip[page] {
			continue
		}
		body, _ := flattenToJPEG(tinyPNG())
		out = append(out, renderedPage{Page: page, Body: body})
	}
	return out, nil
}

func tinyPNG() []byte {
	canvas := image.NewNRGBA(image.Rect(0, 0, 8, 8))
	for x := 0; x < 8; x++ {
		for y := 0; y < 8; y++ {
			canvas.Set(x, y, color.NRGBA{R: 10, G: 20, B: 30, A: 0}) // fully transparent
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, canvas)
	return buf.Bytes()
}

func visualsWith(sees bool, run *string, renderer *fakeRenderer) *documentVisuals {
	return &documentVisuals{
		vision: func() bool { return sees },
		runID:  func() string { return *run },
		render: renderer.render,
	}
}

func scannedRequest() documentRequest {
	return documentRequest{display: "docs/scan.pdf", target: "scan.pdf", format: "pdf"}
}

func pages(from, to int) []int {
	var out []int
	for p := from; p <= to; p++ {
		out = append(out, p)
	}
	return out
}

func TestWithoutVisionScannedPagesAreOnlyReportedAndNothingIsRendered(t *testing.T) {
	run, renderer := "r1", &fakeRenderer{}
	got := visualsWith(false, &run, renderer).resolve(context.Background(), scannedRequest(), pages(1, 5))

	if len(renderer.calls) != 0 || len(got.Images) != 0 {
		t.Fatalf("a model that cannot see must not cost a render: calls=%v images=%d", renderer.calls, len(got.Images))
	}
	for _, want := range []string{"第 1-5 页", "看不到图片", "如实告诉用户"} {
		if !strings.Contains(got.Note, want) {
			t.Errorf("note lacks %q: %s", want, got.Note)
		}
	}
}

func TestANilVisionFunctionMeansNoPictures(t *testing.T) {
	visuals := &documentVisuals{render: (&fakeRenderer{}).render}
	if got := visuals.resolve(context.Background(), scannedRequest(), []int{1}); len(got.Images) != 0 {
		t.Errorf("no vision function, yet %d pictures were attached", len(got.Images))
	}
}

func TestAVisionModelGetsAtMostThreePagesAndIsToldWhichOnesWait(t *testing.T) {
	run, renderer := "r1", &fakeRenderer{}
	got := visualsWith(true, &run, renderer).resolve(context.Background(), scannedRequest(), pages(1, 13))

	if len(renderer.calls) != 1 || len(renderer.calls[0]) != maxRenderedPagesPerCall {
		t.Fatalf("render calls = %v, want one call of %d pages", renderer.calls, maxRenderedPagesPerCall)
	}
	if len(got.Images) != 3 || len(got.Shown) != 3 {
		t.Fatalf("images=%d shown=%v", len(got.Images), got.Shown)
	}
	for _, want := range []string{"第 1-3 页", "渲染成图片", "第 4-13 页这次没有渲染", "pages 分批"} {
		if !strings.Contains(got.Note, want) {
			t.Errorf("note lacks %q: %s", want, got.Note)
		}
	}
	// Two pages of one file must be two pictures with two names; the artifact is labelled by
	// the base name of the path.
	if got.Images[0].Path == got.Images[1].Path || got.Images[0].Name == got.Images[1].Name {
		t.Errorf("pages are not told apart: %+v / %+v", got.Images[0], got.Images[1])
	}
	if !strings.Contains(got.Images[1].Name, "第2页") || !strings.Contains(got.Images[1].Path, "#p2") {
		t.Errorf("page 2 is labelled %q / %q", got.Images[1].Name, got.Images[1].Path)
	}
}

func TestThePageBudgetIsPerTurnAndResetsByComparingTheRunID(t *testing.T) {
	run, renderer := "turn-1", &fakeRenderer{}
	visuals := visualsWith(true, &run, renderer)
	ctx := context.Background()

	rendered := 0
	for i := 0; i < 6; i++ {
		rendered += len(visuals.resolve(ctx, scannedRequest(), pages(1, 3)).Images)
	}
	if rendered != maxRenderedPagesPerTurn {
		t.Fatalf("a turn rendered %d pages, ceiling is %d", rendered, maxRenderedPagesPerTurn)
	}
	refused := visuals.resolve(ctx, scannedRequest(), pages(1, 3))
	if len(refused.Images) != 0 || !strings.Contains(refused.Note, "不再继续") {
		t.Errorf("past the ceiling the answer is a sentence: %+v", refused)
	}

	run = "turn-2"
	if got := visuals.resolve(ctx, scannedRequest(), pages(1, 3)); len(got.Images) != 3 {
		t.Errorf("a new turn must start with a fresh budget, got %d pictures", len(got.Images))
	}
}

func TestAFailedRenderGivesTheBudgetBackAndSaysSo(t *testing.T) {
	run := "r1"
	renderer := &fakeRenderer{err: errors.New("渲染器起不来")}
	visuals := visualsWith(true, &run, renderer)

	got := visuals.resolve(context.Background(), scannedRequest(), pages(1, 3))
	if len(got.Images) != 0 || !strings.Contains(got.Note, "没能把这些页渲染成图片") || !strings.Contains(got.Note, "渲染器起不来") {
		t.Fatalf("a render failure must be a sentence naming the reason: %+v", got)
	}
	if !strings.Contains(got.Note, "如实告诉用户") {
		t.Errorf("the model must be told not to invent the content: %s", got.Note)
	}

	// The failed attempt cost no picture, so it must not eat the turn's budget.
	renderer.err = nil
	total := 0
	for i := 0; i < 4; i++ {
		total += len(visuals.resolve(context.Background(), scannedRequest(), pages(1, 3)).Images)
	}
	if total != maxRenderedPagesPerTurn {
		t.Errorf("after a failure the turn rendered %d, want the full %d", total, maxRenderedPagesPerTurn)
	}
}

func TestAPageThatCouldNotBeEncodedIsRefundedAndTheRestStillGo(t *testing.T) {
	run := "r1"
	renderer := &fakeRenderer{skip: map[int]bool{2: true}}
	got := visualsWith(true, &run, renderer).resolve(context.Background(), scannedRequest(), pages(1, 3))
	if len(got.Shown) != 2 || got.Shown[0] != 1 || got.Shown[1] != 3 {
		t.Fatalf("shown = %v, want [1 3]", got.Shown)
	}
	if !strings.Contains(got.Note, "第 2 页这次没有渲染") {
		t.Errorf("the missing page is not reported: %s", got.Note)
	}
}

func TestFlattenToJPEGPutsATransparentPageOnWhite(t *testing.T) {
	body, err := flattenToJPEG(tinyPNG())
	if err != nil {
		t.Fatal(err)
	}
	info, err := content.InspectImage(body)
	if err != nil || info.MIME != "image/jpeg" {
		t.Fatalf("info=%+v err=%v", info, err)
	}
	decoded, _, err := image.Decode(bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r, g, b, _ := decoded.At(4, 4).RGBA()
	if r>>8 < 240 || g>>8 < 240 || b>>8 < 240 {
		t.Errorf("a transparent page came out dark (%d,%d,%d) — unreadable once the alpha is dropped", r>>8, g>>8, b>>8)
	}
}

func TestFlattenToJPEGRefusesAPageOverThePixelCeilingBeforeDecoding(t *testing.T) {
	// 7000x7000 = 49M pixels. Only the header is needed to refuse it, so the PNG is built
	// with a real header and a deliberately empty body: decoding it would fail loudly.
	canvas := image.NewGray(image.Rect(0, 0, 7000, 7000))
	var buf bytes.Buffer
	if err := png.Encode(&buf, canvas); err != nil {
		t.Fatal(err)
	}
	if _, err := flattenToJPEG(buf.Bytes()); err == nil || !strings.Contains(err.Error(), "pixel ceiling") {
		t.Errorf("err = %v, want the ceiling named", err)
	}
}

func TestEncodedCommandIsUTF16LEBase64(t *testing.T) {
	// "A" is 0x41 0x00 in UTF-16LE, which is "QQA=" in base64.
	if got := encodedCommand("A"); got != "QQA=" {
		t.Errorf("encodedCommand(A) = %q, want QQA=", got)
	}
	if strings.Contains(renderScript, "`") {
		t.Error("the script lives in a Go raw string and cannot contain a backtick")
	}
}

func TestACompleteReadOfAScannedPdfCarriesThePicturesInTheResult(t *testing.T) {
	// The wiring from the rewrite to the result, with no binary and no renderer: a PDF output
	// whose pages 1-4 are scanned.
	var raw strings.Builder
	raw.WriteString("---\npages: 4\nscanned_pages: [1, 2, 3, 4]\nshowing: pages 1-4\n---\n\n")
	for p := 1; p <= 4; p++ {
		raw.WriteString("<!-- page " + itoa(p) + " -->\n\n<!-- page " + itoa(p) + ": scanned image, no text layer; run `anymd setup ocr` -->\n\n")
	}
	run, renderer := "r1", &fakeRenderer{}
	result := assembleDocument(context.Background(), scannedRequest(), raw.String(), visualsWith(true, &run, renderer))

	if len(result.Images) != 3 {
		t.Fatalf("images = %d, want 3", len(result.Images))
	}
	if result.Audit["document_pages_rendered"] != 3 || result.Audit["document_scanned_pages"] != 4 {
		t.Errorf("audit = %v", result.Audit)
	}
	if strings.Contains(result.Text, "setup ocr") {
		t.Errorf("the install advice reached the model:\n%s", result.Text)
	}
	if !strings.Contains(result.Text, "第 4 页这次没有渲染") {
		t.Errorf("the page left over is not named:\n%s", result.Text)
	}
	// And the same input without vision attaches nothing and says why.
	blind := assembleDocument(context.Background(), scannedRequest(), raw.String(), visualsWith(false, &run, renderer))
	if len(blind.Images) != 0 || blind.Audit["document_pages_rendered"] != 0 {
		t.Errorf("blind result carries pictures: %d %v", len(blind.Images), blind.Audit)
	}
}

// The real renderer, against the real scanned sample. Skipped off Windows and when the sample
// is not in the checkout.
func TestAcceptanceRealPagesRenderToJPEGs(t *testing.T) {
	if _, ok := powershellPath(); !ok {
		t.Skip("no Windows PowerShell on this machine")
	}
	source := sampleForTest(t, "TR_*deep_research.pdf")
	rendered, err := renderPDFPages(context.Background(), source, []int{1, 3})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if len(rendered) != 2 || rendered[0].Page != 1 || rendered[1].Page != 3 {
		t.Fatalf("rendered = %+v", rendered)
	}
	for _, page := range rendered {
		info, err := content.InspectImage(page.Body)
		if err != nil || info.MIME != "image/jpeg" || info.Width < 1000 {
			t.Errorf("page %d: info=%+v err=%v", page.Page, info, err)
		}
		if len(page.Body) > content.MaxImageBytes {
			t.Errorf("page %d is %d bytes", page.Page, len(page.Body))
		}
	}

	if _, err := renderPDFPages(context.Background(), source, []int{99}); err == nil || !strings.Contains(err.Error(), "out of range") {
		t.Errorf("a page past the end must be a readable error, got %v", err)
	}
}

// End to end through the tool: a vision model reading the scanned sample gets pictures.
func TestAcceptanceTheToolAttachesScannedPagesForAVisionModelOnly(t *testing.T) {
	if _, ok := powershellPath(); !ok {
		t.Skip("no Windows PowerShell on this machine")
	}
	if !AnymdPlatformSupported() {
		t.Skip("no extractor on this platform")
	}
	t.Setenv(paths.EnvHome, repoRootForTest(t))
	source := sampleForTest(t, "TR_*deep_research.pdf")
	raw, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	workspace, err := tools.NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "scan.pdf"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	sees := true
	tool, ok := NewReadDocument(workspace, func() bool { return sees }, func() string { return "run-1" })
	if !ok {
		t.Fatal("no tool")
	}
	result := callDocument(t, tool, map[string]any{"path": "scan.pdf"})
	if len(result.Images) != 3 || !strings.Contains(result.Text, "渲染成图片") {
		t.Fatalf("a vision model should get 3 pages, got %d:\n%s", len(result.Images), result.Text)
	}
	if result.Audit["document_pages_rendered"] != 3 {
		t.Errorf("audit = %v", result.Audit)
	}

	// The model can be switched mid-session: the same tool instance, asked again.
	sees = false
	blind := callDocument(t, tool, map[string]any{"path": "scan.pdf"})
	if len(blind.Images) != 0 || !strings.Contains(blind.Text, "看不到图片") {
		t.Errorf("after switching to a blind model: %d images\n%s", len(blind.Images), blind.Text)
	}
}
