package builtin

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/content"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// read_image, and the four refusals it has to make before it hands bytes on.
//
// The tool exists because a model could see `architecture.png` in a listing, could
// not `read_file` it (that tool refuses anything that is not UTF-8), and had no way
// to get at the pixels — so it went around: four PowerShell `System.Drawing` scans
// in one turn. What these tests pin is that the front door works and that every way
// in is closed properly, because a refusal the model cannot act on is the same dead
// end as no tool at all.

// pngBytes builds a real PNG, because the sniff is what decides whether a file is a
// picture: a fake would let a broken detector pass.
func pngBytes(t *testing.T, width, height int) []byte {
	t.Helper()
	source := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			source.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 90, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, source); err != nil {
		t.Fatalf("encoding a %dx%d png: %v", width, height, err)
	}
	return buffer.Bytes()
}

// imageHarness is a workspace plus the tool bound to it.
func imageHarness(t *testing.T) (*tools.Workspace, string, tools.Tool) {
	t.Helper()
	dir := t.TempDir()
	workspace, err := tools.NewWorkspace(dir)
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	return workspace, dir, NewReadImage(workspace)
}

// callImage runs one call through Execute, so schema validation and argument
// decoding are exercised as well.
//
// It is not named `call` because `fs_test.go` already has one of those returning a
// string — the shape every text tool produces. This one returns the whole result,
// which is the difference this feature is about.
func callImage(t *testing.T, tool tools.Tool, arguments map[string]any) tools.Result {
	t.Helper()
	result, err := tool.Execute(context.Background(), arguments)
	if err != nil {
		t.Fatalf("the tool returned an error rather than a result: %v", err)
	}
	return result
}

// TestAPictureComesBackAsBytesNotAsText is the whole point of the tool.
//
// Base64 in `Text` is the obvious thing to do and the wrong one for three separate
// reasons: the estimator would count it as characters (a megabyte of "text" that is
// not text), the session file would store it and re-send it on every later turn, and
// the model would receive an undecodable wall of letters rather than a picture.
func TestAPictureComesBackAsBytesNotAsText(t *testing.T) {
	_, dir, tool := imageHarness(t)
	body := pngBytes(t, 320, 200)
	if err := os.WriteFile(filepath.Join(dir, "shot.png"), body, 0o644); err != nil {
		t.Fatalf("writing: %v", err)
	}

	result := callImage(t, tool, map[string]any{"path": "shot.png"})

	if len(result.Images) != 1 {
		t.Fatalf("the tool returned %d pictures, want 1", len(result.Images))
	}
	picture := result.Images[0]
	if !bytes.Equal(picture.Body, body) {
		t.Error("the bytes are not the file's bytes")
	}
	if picture.Name != "shot.png" {
		t.Errorf("name = %q, want the file's base name", picture.Name)
	}
	if picture.Path != "shot.png" {
		t.Errorf("path = %q", picture.Path)
	}
	// The text says what happened and how big it is — the facts a later turn can
	// still act on after the picture has degraded to a thumbnail.
	for _, wanted := range []string{"shot.png", "image/png", "320×200"} {
		if !strings.Contains(result.Text, wanted) {
			t.Errorf("the sentence does not mention %q: %q", wanted, result.Text)
		}
	}
	// And it is **not** the picture. A base64 payload would be thousands of
	// characters; the sentence is one line.
	if len(result.Text) > 200 {
		t.Errorf("the text is %d characters, which is not a sentence: %q", len(result.Text), result.Text)
	}
	if strings.Contains(result.Text, "iVBOR") {
		t.Error("the text carries base64")
	}
}

// TestTheSizeCeilingIsCheckedBeforeTheRead.
//
// The ceiling exists to keep a large file out of memory, so holding it in memory to
// measure it defeats the purpose. This writes a file that is over the limit **and is
// not a picture at all** — if the size check ran after the sniff, the refusal would
// name the content instead of the size, and the ordering would be visible in the
// wrong sentence.
func TestTheSizeCeilingIsCheckedBeforeTheRead(t *testing.T) {
	_, dir, tool := imageHarness(t)
	// Cheap to write: 5MB of zeros is not a PNG, and it must never be sniffed.
	huge := make([]byte, content.MaxImageBytes+1)
	if err := os.WriteFile(filepath.Join(dir, "huge.png"), huge, 0o644); err != nil {
		t.Fatalf("writing: %v", err)
	}

	result := callImage(t, tool, map[string]any{"path": "huge.png"})

	if len(result.Images) != 0 {
		t.Fatal("an oversized file came back as a picture")
	}
	if !strings.Contains(result.Text, "太大") {
		t.Errorf("the refusal does not name the size: %q", result.Text)
	}
	if !strings.Contains(result.Text, "5.0MB") {
		t.Errorf("the refusal does not say the limit: %q", result.Text)
	}
}

// TestATextFileNamedPngIsRefusedByName.
//
// The extension is what the *scan* goes on; the bytes are what the tool goes on, and
// the difference is the sentence the model gets. "It is text/plain" sends it looking
// for a different file, where "the tool failed" would send it looking for a bug.
func TestATextFileNamedPngIsRefusedByName(t *testing.T) {
	_, dir, tool := imageHarness(t)
	if err := os.WriteFile(filepath.Join(dir, "fake.png"), []byte("this is prose, not a picture"), 0o644); err != nil {
		t.Fatalf("writing: %v", err)
	}

	result := callImage(t, tool, map[string]any{"path": "fake.png"})

	if len(result.Images) != 0 {
		t.Fatal("a text file came back as a picture")
	}
	if !strings.Contains(result.Text, "text/plain") {
		t.Errorf("the refusal does not say what the file really is: %q", result.Text)
	}
	// The formats it *does* take are named, so the model can tell "wrong file" from
	// "wrong tool".
	for _, wanted := range []string{"image/png", "image/jpeg", "image/gif"} {
		if !strings.Contains(result.Text, wanted) {
			t.Errorf("the refusal does not list %q: %q", wanted, result.Text)
		}
	}
}

// TestTheWorkspaceBoundaryStillApplies.
//
// Nothing about a picture makes an outside path readable. The tool goes through the
// same `SafePath` the file tools use, and this is the test that says so — a second
// path check is how one door ends up guarded and the other does not.
func TestTheWorkspaceBoundaryStillApplies(t *testing.T) {
	_, dir, tool := imageHarness(t)

	// A real picture, outside the workspace: the refusal has to be about the
	// boundary rather than about the file being missing or unreadable.
	outside := filepath.Join(filepath.Dir(dir), "outside.png")
	if err := os.WriteFile(outside, pngBytes(t, 40, 40), 0o644); err != nil {
		t.Fatalf("writing: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(outside) })

	result := callImage(t, tool, map[string]any{"path": "../outside.png"})

	if len(result.Images) != 0 {
		t.Fatal("a picture from outside the workspace was read")
	}
	if !strings.Contains(result.Text, "PermissionError") {
		t.Errorf("the refusal is not the structured one read_file produces: %q", result.Text)
	}
}

// TestAMissingFileAndADirectoryAreToldApart.
//
// Both are failures, and they have different remedies — "find the real path" against
// "that is a directory, list it instead" — so one sentence for both would waste the
// model's next call.
func TestAMissingFileAndADirectoryAreToldApart(t *testing.T) {
	_, dir, tool := imageHarness(t)
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	missing := callImage(t, tool, map[string]any{"path": "nope.png"})
	if !strings.Contains(missing.Text, "不存在") {
		t.Errorf("a missing file reads as: %q", missing.Text)
	}
	if !strings.Contains(missing.Text, "list_files") {
		t.Errorf("the sentence does not point at how to find it: %q", missing.Text)
	}

	directory := callImage(t, tool, map[string]any{"path": "assets"})
	if !strings.Contains(directory.Text, "目录") {
		t.Errorf("a directory reads as: %q", directory.Text)
	}
}

// TestItIsLowRiskAndParallelSafe.
//
// The same pair `read_file` declares, and for the same reasons: two integers do not
// widen what this can reach, and holding it out of the parallel band would make
// every batch containing one picture run serially. The registry refuses the
// combination if either claim is wrong, so this also pins that it is accepted.
func TestItIsLowRiskAndParallelSafe(t *testing.T) {
	workspace, _, tool := imageHarness(t)
	if tool.Risk != "low" {
		t.Errorf("risk = %q, want low (it only reads, inside the workspace)", tool.Risk)
	}
	if !tool.ParallelSafe {
		t.Error("read_image is not parallel_safe, so one picture makes a whole batch serial")
	}
	registry := tools.NewRegistry()
	if err := registry.Register(tool); err != nil {
		t.Fatalf("the registry refused the declaration: %v", err)
	}
	_ = workspace
}
