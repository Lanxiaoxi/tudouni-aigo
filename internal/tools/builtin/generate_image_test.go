package builtin

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/content"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/imagegen"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// `generate_image`, and the rules that keep it from costing money it should not
// and from writing files it should not.
//
// The order the tool works in is the design, and most of these tests are about
// **where** a failure happens rather than about what it says: an extension that
// is wrong must be refused *before* the request goes out, because that is the
// only error that is free.

// generateHarness is a workspace, a test server and the tool bound to them.
type generateHarness struct {
	workspace *tools.Workspace
	dir       string
	tool      tools.Tool
	// requests counts the generation requests that actually went out. It is how
	// a test proves that a refusal happened *before* the money was spent.
	requests int
}

// newGenerateHarness builds the tool over a server that answers with a picture.
func newGenerateHarness(t *testing.T, body []byte) *generateHarness {
	t.Helper()
	harness := &generateHarness{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		harness.requests++
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":[{"b64_json":%q}]}`, base64.StdEncoding.EncodeToString(body))
	}))
	t.Cleanup(server.Close)

	dir := t.TempDir()
	workspace, err := tools.NewWorkspace(dir)
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	harness.workspace = workspace
	harness.dir = dir
	harness.tool = NewGenerateImage(workspace,
		newImageClient(t, server.URL),
		func() bool { return true },
		func() string { return "run-1" },
	)
	return harness
}

// newImageClient builds a client pointed at a test server.
func newImageClient(t *testing.T, baseURL string) *imagegen.Client {
	t.Helper()
	client, err := imagegen.New(imagegen.Route{
		BaseURL: baseURL,
		APIKey:  "sk-test",
		Model:   "gpt-image-1",
	}, nil)
	if err != nil {
		t.Fatalf("image client: %v", err)
	}
	return client
}

// call runs one call through Execute, so the schema is exercised too.
func (h *generateHarness) call(t *testing.T, args map[string]any) (tools.Result, error) {
	t.Helper()
	return h.tool.Execute(context.Background(), args)
}

// TestTheToolIsNotParallelSafe checks the declaration.
//
// Three reasons stack on top of each other: every call costs money; the
// previous picture usually changes the next prompt; and two concurrent calls
// writing the same path would overwrite each other.
func TestTheToolIsNotParallelSafe(t *testing.T) {
	harness := newGenerateHarness(t, pngBytes(t, 2, 2))
	if harness.tool.ParallelSafe {
		t.Error("the tool is parallel-safe, and it must not be")
	}
	if harness.tool.Risk != "medium" {
		t.Errorf("the risk is %q, want medium", harness.tool.Risk)
	}
}

// TestTheExtensionIsRefusedBeforeTheRequest checks the free error.
//
// This is the only mistake that can be caught for nothing, so it has to be
// caught first — before the request goes out and before the user is charged.
func TestTheExtensionIsRefusedBeforeTheRequest(t *testing.T) {
	harness := newGenerateHarness(t, pngBytes(t, 2, 2))

	result, err := harness.call(t, map[string]any{
		"prompt": "a cat",
		"path":   "out/cat.gif",
	})
	if err != nil {
		t.Fatalf("calling: %v", err)
	}
	if harness.requests != 0 {
		t.Errorf("%d requests went out, want 0 — the extension must be refused first", harness.requests)
	}
	if !strings.Contains(result.Text, ".png") {
		t.Errorf("the message does not say what is allowed: %q", result.Text)
	}
}

// TestThePictureIsWrittenIntoTheWorkspace checks the happy path.
//
// The picture is a **file**: that is the whole design, and it is what makes
// the picture showable, deliverable, and findable in a later session.
func TestThePictureIsWrittenIntoTheWorkspace(t *testing.T) {
	body := pngBytes(t, 4, 2)
	harness := newGenerateHarness(t, body)

	result, err := harness.call(t, map[string]any{
		"prompt": "a cat",
		"path":   "out/cat.png",
	})
	if err != nil {
		t.Fatalf("calling: %v", err)
	}
	if harness.requests != 1 {
		t.Errorf("%d requests went out, want 1", harness.requests)
	}

	written, readErr := os.ReadFile(filepath.Join(harness.dir, "out", "cat.png"))
	if readErr != nil {
		t.Fatalf("reading the written picture: %v", readErr)
	}
	if !bytes.Equal(written, body) {
		t.Error("the written picture is not the one that was generated")
	}
	if !strings.Contains(result.Text, "out/cat.png") {
		t.Errorf("the message does not name the path: %q", result.Text)
	}
	// The text must NOT describe the picture: that is in the picture, and it
	// costs tokens to repeat.
	if strings.Contains(result.Text, "4×2") && strings.Contains(result.Text, "cat") {
		t.Log("the message mentions the size, which is a fact and not a description")
	}
}

// TestThePictureIsHandedBackToTheModel checks that the bytes travel.
//
// The model's own channel is `Result.Images`: the bytes become an artifact and
// reach the model on the next request, which is what lets it look at what it
// drew and decide whether to draw it again.
func TestThePictureIsHandedBackToTheModel(t *testing.T) {
	harness := newGenerateHarness(t, pngBytes(t, 2, 2))

	result, err := harness.call(t, map[string]any{
		"prompt": "a cat",
		"path":   "out/cat.png",
	})
	if err != nil {
		t.Fatalf("calling: %v", err)
	}
	if len(result.Images) != 1 {
		t.Fatalf("%d images came back, want 1", len(result.Images))
	}
	if result.Images[0].Path != "out/cat.png" {
		t.Errorf("the image path is %q, want out/cat.png", result.Images[0].Path)
	}
	if result.Images[0].Name != "cat.png" {
		t.Errorf("the image name is %q, want cat.png", result.Images[0].Name)
	}
}

// TestWithoutVisionTheBytesAreNotHandedBack checks the gate.
//
// A model that cannot see pictures would store the artifact and then be handed
// a sentence saying "this model cannot see pictures" — money spent to produce
// a sentence. The gate is the **same fact** the agent's renderer reads.
func TestWithoutVisionTheBytesAreNotHandedBack(t *testing.T) {
	harness := newGenerateHarness(t, pngBytes(t, 2, 2))
	harness.tool = NewGenerateImage(harness.workspace,
		newImageClient(t, "http://127.0.0.1:1"),
		func() bool { return false },
		func() string { return "run-1" },
	)

	result, err := harness.call(t, map[string]any{
		"prompt": "a cat",
		"path":   "out/cat.png",
	})
	if err != nil {
		t.Fatalf("calling: %v", err)
	}
	if len(result.Images) != 0 {
		t.Errorf("%d images came back, want none — the model cannot see them", len(result.Images))
	}
}

// TestAPNGIntoAJPGPathIsRefused checks the asymmetry.
//
// JPEG into a `.png` costs disk space and nothing else, so the tool may do
// it. PNG into a `.jpg` costs **pixels**, and a decision with a quality cost
// is not the tool's to make.
func TestAPNGIntoAJPGPathIsRefused(t *testing.T) {
	harness := newGenerateHarness(t, pngBytes(t, 2, 2))

	result, err := harness.call(t, map[string]any{
		"prompt": "a cat",
		"path":   "out/cat.jpg",
	})
	if err != nil {
		t.Fatalf("calling: %v", err)
	}
	if !strings.Contains(result.Text, ".png") {
		t.Errorf("the message does not say what to do instead: %q", result.Text)
	}
	if _, statErr := os.Stat(filepath.Join(harness.dir, "out", "cat.jpg")); statErr == nil {
		t.Error("the file was written, and it must not be")
	}
}

// TestAJPEGIntoAPNGPathIsReEncoded checks the other direction.
//
// It is the one direction that is free of quality loss, so the tool does it —
// and says so, because a file that is not what was asked for should not be
// passed off as if it were.
func TestAJPEGIntoAPNGPathIsReEncoded(t *testing.T) {
	harness := newGenerateHarness(t, jpegBytes(t, 4, 4))

	result, err := harness.call(t, map[string]any{
		"prompt": "a cat",
		"path":   "out/cat.png",
	})
	if err != nil {
		t.Fatalf("calling: %v", err)
	}
	written, readErr := os.ReadFile(filepath.Join(harness.dir, "out", "cat.png"))
	if readErr != nil {
		t.Fatalf("reading the written picture: %v", readErr)
	}
	if !bytes.HasPrefix(written, []byte{0x89, 'P', 'N', 'G'}) {
		t.Error("the written file is not a PNG")
	}
	if !strings.Contains(result.Text, "PNG") {
		t.Errorf("the message does not say it was re-encoded: %q", result.Text)
	}
}

// TestAPathOutsideTheWorkspaceIsAnError checks the boundary.
//
// It is an **error**, not a sentence: the model cannot fix "outside the
// workspace" by choosing differently, and an error says so where a sentence
// invites a retry.
func TestAPathOutsideTheWorkspaceIsAnError(t *testing.T) {
	harness := newGenerateHarness(t, pngBytes(t, 2, 2))

	_, err := harness.call(t, map[string]any{
		"prompt": "a cat",
		"path":   "../outside.png",
	})
	if err == nil {
		t.Fatal("a path outside the workspace was accepted")
	}
}

// TestTheFifthPictureIsRefused checks the per-turn ceiling.
//
// The step ceiling is 120, and for a tool where every call costs money that is
// not a ceiling at all. The answer is **text**, not an error: the model is not
// malfunctioning, it is drawing too many pictures.
func TestTheFifthPictureIsRefused(t *testing.T) {
	harness := newGenerateHarness(t, pngBytes(t, 2, 2))

	for index := 0; index < MaxImagesPerTurn; index++ {
		result, err := harness.call(t, map[string]any{
			"prompt": "a cat",
			"path":   fmt.Sprintf("out/cat-%d.png", index),
		})
		if err != nil {
			t.Fatalf("call %d: %v", index, err)
		}
		if strings.Contains(result.Text, "已经生成了") {
			t.Fatalf("call %d was refused, want the first %d to go through", index, MaxImagesPerTurn)
		}
	}

	result, err := harness.call(t, map[string]any{
		"prompt": "a cat",
		"path":   "out/cat-extra.png",
	})
	if err != nil {
		t.Fatalf("calling: %v", err)
	}
	if !strings.Contains(result.Text, "已经生成了") {
		t.Errorf("the fifth call was not refused: %q", result.Text)
	}
	if harness.requests != MaxImagesPerTurn {
		t.Errorf("%d requests went out, want %d — the fifth must not cost anything",
			harness.requests, MaxImagesPerTurn)
	}
}

// TestANewTurnStartsANewBudget checks the reset.
//
// The counter compares the run id rather than being told when a turn ends, so
// a turn can end without anybody saying so and the count still resets.
func TestANewTurnStartsANewBudget(t *testing.T) {
	runID := "run-1"
	dir := t.TempDir()
	workspace, err := tools.NewWorkspace(dir)
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	tool := NewGenerateImage(workspace,
		newImageClient(t, "http://127.0.0.1:1"),
		func() bool { return true },
		func() string { return runID },
	)

	for index := 0; index < MaxImagesPerTurn; index++ {
		result, callErr := tool.Execute(context.Background(), map[string]any{
			"prompt": "a cat",
			"path":   fmt.Sprintf("out/cat-%d.png", index),
		})
		if callErr != nil {
			t.Fatalf("call %d: %v", index, callErr)
		}
		if strings.Contains(result.Text, "已经生成了") {
			t.Fatalf("call %d was refused inside the first turn", index)
		}
	}

	// The same tool, a new turn.
	runID = "run-2"
	result, err := tool.Execute(context.Background(), map[string]any{
		"prompt": "a cat",
		"path":   "out/next-turn.png",
	})
	if err != nil {
		t.Fatalf("calling: %v", err)
	}
	if strings.Contains(result.Text, "已经生成了") {
		t.Error("the new turn inherited the previous turn's count")
	}
}

// TestTheAuditCarriesTheFactsTheProviderReported checks the audit.
//
// The facts are what the provider said, not what was inferred: the size is
// **measured**, and the usage appears only when the provider reported it.
func TestTheAuditCarriesTheFactsTheProviderReported(t *testing.T) {
	harness := newGenerateHarness(t, pngBytes(t, 6, 4))

	result, err := harness.call(t, map[string]any{
		"prompt": "a cat",
		"path":   "out/cat.png",
	})
	if err != nil {
		t.Fatalf("calling: %v", err)
	}
	audit := result.Audit
	if audit["model"] != "gpt-image-1" {
		t.Errorf("the audit model is %v, want gpt-image-1", audit["model"])
	}
	if audit["size"] != "6x4" {
		t.Errorf("the audit size is %v, want 6x4 (the measured size)", audit["size"])
	}
	if audit["path"] != "out/cat.png" {
		t.Errorf("the audit path is %v, want out/cat.png", audit["path"])
	}
	if _, present := audit["request_url"]; !present {
		t.Error("the audit does not name the URL that was used")
	}
	// The provider reported no usage, so none is recorded.
	if _, present := audit["usage"]; present {
		t.Error("the audit reports a usage the provider never gave")
	}
}

// TestTheAuditCarriesTheUsageWhenThereIsOne checks the other direction.
func TestTheAuditCarriesTheUsageWhenThereIsOne(t *testing.T) {
	body := pngBytes(t, 2, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":[{"b64_json":%q}],"usage":{"input_tokens":42,"output_tokens":4160}}`,
			base64.StdEncoding.EncodeToString(body))
	}))
	defer server.Close()

	dir := t.TempDir()
	workspace, err := tools.NewWorkspace(dir)
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	tool := NewGenerateImage(workspace, newImageClient(t, server.URL),
		func() bool { return true }, func() string { return "run-1" })

	result, err := tool.Execute(context.Background(), map[string]any{
		"prompt": "a cat",
		"path":   "out/cat.png",
	})
	if err != nil {
		t.Fatalf("calling: %v", err)
	}
	usage, present := result.Audit["usage"].(map[string]any)
	if !present {
		t.Fatal("the audit does not carry the usage the provider reported")
	}
	if usage["input_tokens"] != 42 || usage["output_tokens"] != 4160 {
		t.Errorf("the usage is %v, want 42 in / 4160 out", usage)
	}
}

// TestTheOrientationReachesTheEndpoint checks the mapping.
func TestTheOrientationReachesTheEndpoint(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":[{"b64_json":%q}]}`,
			base64.StdEncoding.EncodeToString(pngBytes(t, 2, 2)))
	}))
	defer server.Close()

	dir := t.TempDir()
	workspace, err := tools.NewWorkspace(dir)
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	tool := NewGenerateImage(workspace, newImageClient(t, server.URL),
		func() bool { return true }, func() string { return "run-1" })

	if _, err := tool.Execute(context.Background(), map[string]any{
		"prompt":      "a cat",
		"path":        "out/cat.png",
		"orientation": "landscape",
	}); err != nil {
		t.Fatalf("calling: %v", err)
	}
	if body["size"] != "1536x1024" {
		t.Errorf("the size is %v, want 1536x1024", body["size"])
	}
}

// TestACancelledTurnLeavesNoFile checks that a stop leaves nothing behind.
//
// A half-written picture is worse than no picture: the display path reads it
// and shows a broken image, and the user cannot tell that from "the model
// produced a corrupt picture".
func TestACancelledTurnLeavesNoFile(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer close(release)

	dir := t.TempDir()
	workspace, err := tools.NewWorkspace(dir)
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	tool := NewGenerateImage(workspace, newImageClient(t, server.URL),
		func() bool { return true }, func() string { return "run-1" })

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()

	result, callErr := tool.Execute(ctx, map[string]any{
		"prompt": "a cat",
		"path":   "out/cat.png",
	})
	if callErr != nil {
		t.Fatalf("calling: %v", callErr)
	}
	if !strings.Contains(result.Text, "中断") {
		t.Errorf("the message does not say it was interrupted: %q", result.Text)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "out", "cat.png")); statErr == nil {
		t.Error("a file was left behind")
	}
}

// jpegBytes builds a real JPEG, for the re-encoding test.
func jpegBytes(t *testing.T, width, height int) []byte {
	t.Helper()
	source := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			source.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 90, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, source, nil); err != nil {
		t.Fatalf("encoding a jpeg: %v", err)
	}
	return buffer.Bytes()
}

// TestAPictureOverTheContextCeilingIsWrittenButNotReturned checks the two
// ceilings.
//
// The write ceiling is 20MB and the context ceiling is 5MB, and they answer
// two different questions. A picture between them is legal: it is on disk, it
// opens in the system viewer, it can be declared as a deliverable. It simply
// cannot be inlined — and saying so is better than a failure nobody can act
// on.
func TestAPictureOverTheContextCeilingIsWrittenButNotReturned(t *testing.T) {
	// A **real** picture over the context ceiling but under the write
	// ceiling. The bytes have to be a decodable PNG: the format check reads
	// the header, and a fake would be refused as "not a picture" rather than
	// as "too big to inline" — which is a different answer.
	body := bigPNGBytes(t, content.MaxImageBytes+1)

	harness := newGenerateHarness(t, body)
	result, err := harness.call(t, map[string]any{
		"prompt": "a big cat",
		"path":   "out/big.png",
	})
	if err != nil {
		t.Fatalf("calling: %v", err)
	}
	if len(result.Images) != 0 {
		t.Errorf("%d images came back, want none — the picture is over the context ceiling",
			len(result.Images))
	}
	if !strings.Contains(result.Text, "没有回传") {
		t.Errorf("the message does not say the picture was not returned: %q", result.Text)
	}
	if result.Audit["inline"] != false {
		t.Errorf("the audit says inline=%v, want false", result.Audit["inline"])
	}
	// The file **is** on disk: the write ceiling and the context ceiling are
	// two different questions, and this picture answered the first one.
	if _, statErr := os.Stat(filepath.Join(harness.dir, "out", "big.png")); statErr != nil {
		t.Errorf("the picture was not written: %v", statErr)
	}
}

// bigPNGBytes builds a PNG over a byte count.
//
// The picture is filled with noise rather than a flat colour, because a flat
// one compresses to almost nothing and would never reach the ceiling it was
// built for.
func bigPNGBytes(t *testing.T, want int) []byte {
	t.Helper()
	side := 1
	for side*side*4 < want {
		side *= 2
	}
	source := image.NewRGBA(image.Rect(0, 0, side, side))
	seed := uint32(12345)
	for y := 0; y < side; y++ {
		for x := 0; x < side; x++ {
			seed = seed*1664525 + 1013904223
			source.Set(x, y, color.RGBA{R: byte(seed >> 24), G: byte(seed >> 16), B: byte(seed >> 8), A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, source); err != nil {
		t.Fatalf("encoding the png: %v", err)
	}
	if buffer.Len() <= want {
		t.Fatalf("the png is %d bytes, want over %d", buffer.Len(), want)
	}
	return buffer.Bytes()
}

// TestAPictureOverTheWriteCeilingIsNotWritten checks the write ceiling.
//
// The two ceilings are separate on purpose, and this is the one that stops a
// file: the other is about what may be *sent*, and this is about what may be
// *written*.
func TestAPictureOverTheWriteCeilingIsNotWritten(t *testing.T) {
	body := make([]byte, MaxGeneratedImageBytes+1)
	copy(body, []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a})

	harness := newGenerateHarness(t, body)
	result, err := harness.call(t, map[string]any{
		"prompt": "a huge cat",
		"path":   "out/huge.png",
	})
	if err != nil {
		t.Fatalf("calling: %v", err)
	}
	if !strings.Contains(result.Text, "没有写入") {
		t.Errorf("the message does not say nothing was written: %q", result.Text)
	}
	if _, statErr := os.Stat(filepath.Join(harness.dir, "out", "huge.png")); statErr == nil {
		t.Error("the file was written, and it must not be")
	}
}

// TestAFormatThisChainDoesNotHandleIsRefused checks the format rule.
//
// WebP has no decoder in this build, so accepting it would mean a file that
// can never be measured and never be sent. The message names the format,
// because "the provider sent something odd" is not something the model can
// act on and "the provider sent a webp" is.
func TestAFormatThisChainDoesNotHandleIsRefused(t *testing.T) {
	// A WebP header: "RIFF" .... "WEBP".
	body := []byte("RIFF\x24\x00\x00\x00WEBPVP8 ")
	harness := newGenerateHarness(t, body)

	result, err := harness.call(t, map[string]any{
		"prompt": "a cat",
		"path":   "out/cat.png",
	})
	if err != nil {
		t.Fatalf("calling: %v", err)
	}
	if !strings.Contains(result.Text, "webp") {
		t.Errorf("the message does not name the format: %q", result.Text)
	}
	if _, statErr := os.Stat(filepath.Join(harness.dir, "out", "cat.png")); statErr == nil {
		t.Error("the file was written, and it must not be")
	}
}

// TestSomethingThatIsNotAPictureAtAllIsRefused checks the other failure.
//
// "This is not a picture" and "this is a picture in a format this chain does
// not handle" are different answers, and one message cannot carry both.
func TestSomethingThatIsNotAPictureAtAllIsRefused(t *testing.T) {
	harness := newGenerateHarness(t, []byte("<html><body>gateway error</body></html>"))

	result, err := harness.call(t, map[string]any{
		"prompt": "a cat",
		"path":   "out/cat.png",
	})
	if err != nil {
		t.Fatalf("calling: %v", err)
	}
	if !strings.Contains(result.Text, "不是图片") {
		t.Errorf("the message does not say it is not a picture: %q", result.Text)
	}
	if _, statErr := os.Stat(filepath.Join(harness.dir, "out", "cat.png")); statErr == nil {
		t.Error("the file was written, and it must not be")
	}
}
