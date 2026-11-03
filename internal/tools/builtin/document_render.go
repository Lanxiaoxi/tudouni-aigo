package builtin

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/content"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// Scanned PDF pages, shown to a model that can look at them.
//
// A page with no text layer cannot be read by an extractor, and this program does not ship an
// OCR engine (the model weights alone are ~2 GB). What it can do is the thing that already
// works for screenshots: hand the page to the model as a picture, through the same
// `Result.Images` channel read_image uses — so the budget prices it by area, the ladder shrinks
// it to a thumbnail before dropping it, and nothing downstream knows this picture came from a
// PDF.
//
// ## Windows only, like the tool
//
// The renderer is `Windows.Data.Pdf`, the PDF engine that ships with the operating system: no
// new dependency, no licence to carry (the Linux candidates were AGPL or needed cgo), and the
// proof of concept measured it at ~90ms a page. It is reached through the Windows PowerShell
// that is on every supported machine, because Go has no WinRT binding in the standard library.
// Linux and remote workspaces do not have `read_document` at all, so there is nothing to port.
//
// ## What bounds the cost
//
//   - **only when the model can see.** The decision is read on every call (the model can be
//     switched mid-session), and without vision the answer is a sentence, never a render that
//     would be stored and then refused by the renderer;
//   - **maxRenderedPagesPerCall** pages per call, **maxRenderedPagesPerTurn** per turn. A
//     scanned 80-page contract must not become 80 pictures because the model asked for "all of
//     it"; the sentence names the pages left and says to read them in batches;
//   - **a fixed width** and **JPEG**: the proof of concept's 1600px PNGs were 200–900KB a page,
//     and a provider bills a picture by area, not by bytes — so the width is chosen near where
//     the providers tile (see context.ThumbnailMaxDimension), and JPEG keeps the request small.

const (
	// renderWidth is the page width in pixels. 1400 keeps small print in a scanned form
	// legible while staying close to the ~1024px the providers tile at.
	renderWidth = 1400
	// renderJPEGQuality is a size decision: text on white survives 80 without visible rings.
	renderJPEGQuality = 80
	// maxRenderedPagesPerCall is how many pages one call may attach (design: 3).
	maxRenderedPagesPerCall = 3
	// maxRenderedPagesPerTurn bounds a turn that keeps asking for more.
	maxRenderedPagesPerTurn = 12
)

// renderedPage is one page, already a JPEG.
type renderedPage struct {
	Page int
	Body []byte
}

// pageRenderer turns pages of a PDF into JPEGs. A field so the logic around it can be tested
// without PowerShell, and so a machine without a renderer is a value, not a branch.
type pageRenderer func(turn context.Context, pdf string, pages []int) ([]renderedPage, error)

// pageVisuals is what the scanned-page handling contributes to one result.
type pageVisuals struct {
	// Note is the sentence about the scanned pages, whatever happened to them.
	Note string
	// Images are the pages that were rendered.
	Images []tools.ImageContent
	// Shown lists those pages' numbers.
	Shown []int
}

// documentVisuals is the state behind that handling: whether the model can see, and how many
// pages this turn has already spent.
type documentVisuals struct {
	vision  func() bool
	runID   func() string
	render  pageRenderer
	counter pageCounter
}

func newDocumentVisuals(vision func() bool, runID func() string) *documentVisuals {
	return &documentVisuals{vision: vision, runID: runID, render: renderPDFPages}
}

// canSee reports whether the model in use can be shown pictures. Read on every call.
func (v *documentVisuals) canSee() bool {
	return v != nil && v.vision != nil && v.vision()
}

// resolve decides what to say and what to attach for the scanned pages of one PDF read.
func (v *documentVisuals) resolve(turn context.Context, request documentRequest, scanned []int) pageVisuals {
	base := scannedNote(scanned)
	if !v.canSee() {
		return pageVisuals{Note: base + " 当前模型看不到图片，这些页的内容我读不到：" +
			"如实告诉用户；需要的话请他提供可复制文字的版本，或换用能看图的模型。"}
	}

	runID := ""
	if v.runID != nil {
		runID = v.runID()
	}
	want := min(len(scanned), maxRenderedPagesPerCall)
	granted := v.counter.take(runID, want, maxRenderedPagesPerTurn)
	if granted == 0 {
		return pageVisuals{Note: fmt.Sprintf("%s 这一轮已经渲染了 %d 页图片，不再继续。"+
			"先基于已经看到的内容回答，或请用户指明最关心哪几页（第 %s 页还没看）。",
			base, maxRenderedPagesPerTurn, pageRanges(scanned))}
	}
	pages := scanned[:granted]

	rendered, err := v.render(turn, request.target, pages)
	if err != nil || len(rendered) == 0 {
		v.counter.refund(runID, granted)
		reason := "没有产出图片"
		if err != nil {
			reason = err.Error()
		}
		return pageVisuals{Note: base + " 本机没能把这些页渲染成图片（" + reason + "），所以这些页的内容我读不到：如实告诉用户。"}
	}
	// A page that rendered but could not be attached gives its slot back too: the turn's
	// budget is about pictures the model got, not pictures that were attempted.
	if len(rendered) < granted {
		v.counter.refund(runID, granted-len(rendered))
	}

	visuals := pageVisuals{}
	label := filepath.Base(request.display)
	for _, page := range rendered {
		visuals.Shown = append(visuals.Shown, page.Page)
		visuals.Images = append(visuals.Images, tools.ImageContent{
			Body: page.Body,
			Name: fmt.Sprintf("%s 第%d页.jpg", label, page.Page),
			// The path is what the artifact is named by (its base name becomes the label the
			// model reads), so it carries the page: two pages of one file must not both be
			// "scan.pdf".
			Path: request.display + "#p" + strconv.Itoa(page.Page),
		})
	}

	note := fmt.Sprintf("%s 已把第 %s 页渲染成图片附在后面，请直接看图，不要凭空描述；图片会随上下文预算自动缩小，看完要点请写进回复。",
		base, pageRanges(visuals.Shown))
	if rest := difference(scanned, visuals.Shown); len(rest) > 0 {
		note += fmt.Sprintf(" 第 %s 页这次没有渲染（每次最多 %d 页），要看就带 pages 分批读。",
			pageRanges(rest), maxRenderedPagesPerCall)
	}
	visuals.Note = note
	return visuals
}

// difference lists the members of `all` that are not in `taken`, keeping order.
func difference(all, taken []int) []int {
	seen := map[int]bool{}
	for _, page := range taken {
		seen[page] = true
	}
	var rest []int
	for _, page := range all {
		if !seen[page] {
			rest = append(rest, page)
		}
	}
	return rest
}

// pageCounter is the per-turn page budget.
//
// It compares the run id instead of being reset, for the reason generate_image's counter
// gives: a tool that had to be told a turn ended needs a reset someone can forget, and a
// counter that never resets refuses every turn after the first.
type pageCounter struct {
	mu    sync.Mutex
	runID string
	count int
}

// take reserves up to `want` pages and returns how many it got.
func (c *pageCounter) take(runID string, want, limit int) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.runID != runID {
		c.runID, c.count = runID, 0
	}
	granted := min(want, limit-c.count)
	if granted < 0 {
		granted = 0
	}
	c.count += granted
	return granted
}

func (c *pageCounter) refund(runID string, n int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.runID == runID {
		c.count = max(c.count-n, 0)
	}
}

// --- the Windows renderer ----------------------------------------------------

// renderScript runs in Windows PowerShell 5.1 (WinRT projection is not available in 7).
//
// It takes its inputs from environment variables rather than arguments: the path of a
// document is whatever a person named it, and quoting that through a command line is how a
// file called `Q3 "final".pdf` becomes someone else's command. It is passed with
// -EncodedCommand, which also means no script file is written and the machine's execution
// policy — which governs files, not commands — has nothing to refuse.
//
// No backticks anywhere: the script lives in a Go raw string.
const renderScript = `
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

    $opName = 'IAsyncOperation' + [char]96 + '1'
    $asTaskOp = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq $opName } | Select-Object -First 1
    $asTaskAction = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
    function Await($op, [Type]$type) {
        $t = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(); $t.Result
    }
    function AwaitAction($op) { $t = $asTaskAction.Invoke($null, @($op)); $t.Wait() }

    $path = [IO.Path]::GetFullPath($env:TUDOUNI_PDF)
    $out = $env:TUDOUNI_OUT
    $width = [uint32]$env:TUDOUNI_WIDTH
    $pages = @($env:TUDOUNI_PAGES -split ',' | ForEach-Object { [int]$_ })

    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
    foreach ($n in $pages) {
        if ($n -lt 1 -or $n -gt $doc.PageCount) {
            throw ('page ' + $n + ' is out of range, the document has ' + $doc.PageCount + ' pages')
        }
        $page = $doc.GetPage([uint32]($n - 1))
        $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
        $opts.DestinationWidth = $width
        $mem = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
        AwaitAction ($page.RenderToStreamAsync($mem, $opts))
        $null = $mem.Seek(0)
        $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($mem)
        $fs = [IO.File]::Create((Join-Path $out ('page-' + $n + '.png')))
        $net.CopyTo($fs)
        $fs.Close(); $net.Dispose(); $page.Dispose()
    }
    exit 0
} catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    # A file, not stderr: with -EncodedCommand PowerShell wraps stderr in CLIXML ("#< CLIXML"),
    # which would be the only thing the caller could read of the reason.
    [IO.File]::WriteAllText((Join-Path $env:TUDOUNI_OUT 'error.txt'), [string]$e.Message)
    exit 1
}
`

// powershellPath is the Windows PowerShell 5.1 that ships with the operating system. The
// full path rather than a PATH lookup: a `powershell.exe` earlier on PATH is not necessarily
// the one with the WinRT projection, and not necessarily ours to run.
func powershellPath() (string, bool) {
	if runtime.GOOS != "windows" {
		return "", false
	}
	root := os.Getenv("SystemRoot")
	if root == "" {
		return "", false
	}
	candidate := filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		return candidate, true
	}
	return "", false
}

// encodedCommand is the form -EncodedCommand wants: base64 of the UTF-16LE text.
func encodedCommand(script string) string {
	units := utf16.Encode([]rune(script))
	raw := make([]byte, 0, len(units)*2)
	for _, unit := range units {
		raw = append(raw, byte(unit), byte(unit>>8))
	}
	return base64.StdEncoding.EncodeToString(raw)
}

// renderPDFPages renders the given 1-based pages of a PDF to JPEGs, in the order asked.
func renderPDFPages(turn context.Context, pdf string, pages []int) ([]renderedPage, error) {
	shell, ok := powershellPath()
	if !ok {
		return nil, fmt.Errorf("这台机器上没有 Windows PowerShell，渲染器起不来")
	}
	dir, err := os.MkdirTemp("", "read-document-pages-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)

	names := make([]string, len(pages))
	for index, page := range pages {
		names[index] = strconv.Itoa(page)
	}
	argv := []string{shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand(renderScript)}
	outcome := runExtractor(turn, argv,
		"TUDOUNI_PDF="+pdf,
		"TUDOUNI_OUT="+dir,
		"TUDOUNI_WIDTH="+strconv.Itoa(renderWidth),
		"TUDOUNI_PAGES="+strings.Join(names, ","),
	)
	switch {
	case outcome.startErr != nil:
		return nil, outcome.startErr
	case outcome.cancelled:
		return nil, fmt.Errorf("被中断了")
	case outcome.timedOut:
		return nil, fmt.Errorf("渲染超时")
	case outcome.code != 0:
		reason := ""
		if raw, readErr := os.ReadFile(filepath.Join(dir, "error.txt")); readErr == nil {
			reason = firstNonEmptyLine(string(raw), "")
		}
		if reason == "" {
			reason = "渲染器没有给出原因（退出码 " + strconv.Itoa(outcome.code) + "）"
		}
		return nil, fmt.Errorf("%s", clipTitle(reason, 200))
	}

	var rendered []renderedPage
	for _, page := range pages {
		raw, err := os.ReadFile(filepath.Join(dir, "page-"+strconv.Itoa(page)+".png"))
		if err != nil {
			continue
		}
		body, err := flattenToJPEG(raw)
		if err != nil {
			continue
		}
		rendered = append(rendered, renderedPage{Page: page, Body: body})
	}
	return rendered, nil
}

func firstNonEmptyLine(text, fallback string) string {
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(line) != "" {
			return strings.TrimSpace(line)
		}
	}
	return fallback
}

// flattenToJPEG decodes a rendered PNG, lays it on white and encodes a JPEG.
//
// The white is not cosmetic: a page rendered with an alpha channel and no background turns
// black when JPEG drops the channel, and a black page is a page nobody can read. The size
// check runs on the header first so that a pathological page (a poster that is one pixel
// wide and a metre tall) is refused before it is decoded.
func flattenToJPEG(raw []byte) ([]byte, error) {
	config, err := png.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	if config.Width*config.Height > content.MaxImagePixels {
		return nil, fmt.Errorf("the page renders to %dx%d, over the %d-pixel ceiling", config.Width, config.Height, content.MaxImagePixels)
	}
	decoded, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	bounds := decoded.Bounds()
	canvas := image.NewRGBA(bounds)
	draw.Draw(canvas, bounds, image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(canvas, bounds, decoded, bounds.Min, draw.Over)

	var out bytes.Buffer
	if err := jpeg.Encode(&out, canvas, &jpeg.Options{Quality: renderJPEGQuality}); err != nil {
		return nil, err
	}
	// The same check the context layer will make on the way in, made here so a refusal is a
	// sentence in this result and not a lost picture in the next one.
	if out.Len() > content.MaxImageBytes {
		return nil, fmt.Errorf("the page is %s as a JPEG, over the %s ceiling for one image",
			content.HumanSize(out.Len()), content.HumanSize(content.MaxImageBytes))
	}
	if _, err := content.InspectImage(out.Bytes()); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
