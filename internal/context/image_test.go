package context

import (
	"bytes"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/content"
)

// Pictures as artifacts, and the ladder they degrade along.
//
// The thing being pinned here is that an image's ladder is **not** the text ladder.
// An image cannot be truncated — half a JPEG is not half an image — so the only
// honest way to make one cheaper while keeping the picture is to send a smaller
// copy, and the only step after that is to describe it in words. A ladder that
// offered "range" or "preview" to a picture would move the level and render the
// same bytes back, which is a degradation that does not degrade and is invisible in
// both the level and the token bill.

// pngOf builds a real PNG of the given size.
//
// Real bytes rather than a magic header, because everything under test — the size
// check, the thumbnail, the media type — depends on the picture being decodable. A
// fake would let a broken decoder pass.
func pngOf(t *testing.T, width, height int) []byte {
	t.Helper()
	source := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			// A gradient rather than a flat colour: a flat image compresses to
			// almost nothing, so a thumbnail of it would not reliably come out
			// smaller and the test would be measuring the codec rather than the
			// ladder.
			source.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 128, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, source); err != nil {
		t.Fatalf("encoding a %dx%d png: %v", width, height, err)
	}
	return buffer.Bytes()
}

// attachFor stores a picture in a harness's store.
func attachFor(t *testing.T, h *harness, body []byte, path string) Artifact {
	t.Helper()
	artifact, err := AttachImage(h.store, body, ArtifactSource{Tool: "attach_image", Path: path})
	if err != nil {
		t.Fatalf("AttachImage: %v", err)
	}
	return artifact
}

// TestAttachRecordsTheFactsTheProvidersNeed.
//
// The media type comes from the bytes and not from the file name, and the
// dimensions are measured — both are facts a dialect needs and neither can be
// derived later. A `.png` that is really a JPEG is common enough that believing the
// name would put a wrong media type on the wire, which the endpoint refuses with a
// message about the media type rather than about the file.
func TestAttachRecordsTheFactsTheProvidersNeed(t *testing.T) {
	h := newHarness(t, nil)
	artifact := attachFor(t, h, pngOf(t, 40, 30), "docs/shot.png")

	if artifact.Type != TypeImage {
		t.Fatalf("type = %q, want %q", artifact.Type, TypeImage)
	}
	if got := artifact.MetadataString(MetaMIME); got != "image/png" {
		t.Errorf("mime = %q", got)
	}
	if w, ht := artifact.MetadataInt(MetaWidth), artifact.MetadataInt(MetaHeight); w != 40 || ht != 30 {
		t.Errorf("dimensions = %dx%d, want 40x30", w, ht)
	}
	if got := artifact.MetadataString(MetaName); got != "shot.png" {
		t.Errorf("name = %q", got)
	}
	// A picture has no characters. Counting runes over a JPEG produces a number
	// that looks like a size and is not one, so Chars is deliberately 0 and Bytes
	// carries the real figure.
	if artifact.Chars != 0 {
		t.Errorf("chars = %d, want 0 for an image", artifact.Chars)
	}
	if artifact.Bytes != len(pngOf(t, 40, 30)) && artifact.Bytes == 0 {
		t.Errorf("bytes = %d, want the body's size", artifact.Bytes)
	}
	// The body on disk is the file's own bytes, never base64: storing the encoded
	// form would inflate it by a third and be re-sent with the session every round.
	stored, ok := h.store.Bytes(artifact.ID)
	if !ok {
		t.Fatal("the body cannot be fetched")
	}
	if !bytes.Equal(stored, pngOf(t, 40, 30)) {
		t.Error("the stored body is not the picture")
	}
}

// TestANonPictureIsRefusedByName: the sniff is what decides, so a text file named
// `.png` is refused and the reason names what it actually is.
func TestANonPictureIsRefusedByName(t *testing.T) {
	h := newHarness(t, nil)
	_, err := AttachImage(h.store, []byte("this is plain text, not a picture"), ArtifactSource{Path: "fake.png"})
	if err == nil {
		t.Fatal("a text file was accepted as a picture")
	}
	if !strings.Contains(err.Error(), "text/plain") {
		t.Errorf("the refusal does not say what the file really is: %v", err)
	}
}

// TestAnOversizedPictureIsRefusedFromItsHeader.
//
// The ceiling is about memory, not about taste: a 20000×20000 PNG is a few hundred
// kilobytes on disk and 1.6GB once decoded, and every accepted picture is measured in
// order to be sent. So the guard has to trip on a header, and the test builds the
// smallest thing that has one — a valid IHDR claiming a huge canvas and no pixel data
// at all. That the file has no image in it is the point: nothing here should ever
// reach a decoder.
func TestAnOversizedPictureIsRefusedFromItsHeader(t *testing.T) {
	h := newHarness(t, nil)
	huge := pngHeaderClaiming(65536, 65536)

	_, err := AttachImage(h.store, huge, ArtifactSource{Path: "huge.png"})
	if err == nil {
		t.Fatal("a picture claiming 65536x65536 was accepted")
	}
	if !strings.Contains(err.Error(), "ceiling") {
		t.Errorf("the refusal does not mention the ceiling: %v", err)
	}
}

// TestABombIsRefusedRatherThanDecoded is the guard's whole reason for existing,
// stated as the property that matters: the refusal happens **before** any pixel data
// is touched. The file above has no pixel data, so a refusal that mentioned a decode
// failure instead of the ceiling would mean the guard ran too late.
func TestABombIsRefusedRatherThanDecoded(t *testing.T) {
	info, err := inspectImage(pngHeaderClaiming(30000, 30000))
	if err == nil {
		t.Fatal("a 30000x30000 header was accepted")
	}
	if !strings.Contains(err.Error(), "pixel ceiling") {
		t.Errorf("the refusal is about something else: %v", err)
	}
	// A header that is genuinely too big must not report a size it invented.
	if info.Width != 0 && info.Width*info.Height <= MaxImagePixels {
		t.Errorf("the guard reported %dx%d, which is under the ceiling", info.Width, info.Height)
	}
}

// pngHeaderClaiming builds a PNG signature plus a valid IHDR for the given canvas,
// and nothing else.
//
// The CRC is real, and that is what makes the test about the ceiling rather than
// about header parsing: with a bad checksum `DecodeConfig` fails first and the
// assertion would pass for the wrong reason. No IDAT is needed — `DecodeConfig` reads
// the header and returns, which is exactly the behaviour the guard relies on.
func pngHeaderClaiming(width, height int) []byte {
	signature := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
	payload := make([]byte, 13)
	payload[0], payload[1], payload[2], payload[3] = byte(width>>24), byte(width>>16), byte(width>>8), byte(width)
	payload[4], payload[5], payload[6], payload[7] = byte(height>>24), byte(height>>16), byte(height>>8), byte(height)
	payload[8] = 8  // bit depth
	payload[9] = 6  // colour type: RGBA
	payload[10] = 0 // compression
	payload[11] = 0 // filter
	payload[12] = 0 // interlace

	chunk := append([]byte("IHDR"), payload...)
	length := []byte{0, 0, 0, 13}
	checksum := make([]byte, 4)
	sum := crc32.ChecksumIEEE(chunk)
	checksum[0], checksum[1], checksum[2], checksum[3] = byte(sum>>24), byte(sum>>16), byte(sum>>8), byte(sum)

	file := append([]byte(nil), signature...)
	file = append(file, length...)
	file = append(file, chunk...)
	return append(file, checksum...)
}

// TestABigPictureGetsAThumbnailAndASmallOneDoesNot.
//
// The thumbnail is made eagerly, at attach time, and the reason is that the budget
// has to know what the picture costs **before** the first request goes out. A lazily
// built one would mean encoding an image while a request is being measured.
func TestABigPictureGetsAThumbnailAndASmallOneDoesNot(t *testing.T) {
	h := newHarness(t, nil)

	big := attachFor(t, h, pngOf(t, 2000, 1400), "big.png")
	thumbnailID := big.MetadataString(MetaThumbnailID)
	if thumbnailID == "" {
		t.Fatal("a 2000x1400 picture came back with no thumbnail")
	}
	smaller, ok := h.store.Get(thumbnailID)
	if !ok {
		t.Fatal("the thumbnail is named but not stored")
	}
	width, height := artifactDimensions(smaller)
	if width > ThumbnailMaxDimension || height > ThumbnailMaxDimension {
		t.Errorf("the thumbnail is %dx%d, over the %d ceiling", width, height, ThumbnailMaxDimension)
	}
	if width >= 2000 || height >= 1400 {
		t.Errorf("the thumbnail is %dx%d, not smaller than the original", width, height)
	}
	// The aspect ratio has to survive, or the model is shown a distorted picture.
	// Compared as a cross-multiplication so the rounding in fitWithin does not make
	// this flaky.
	if diff := width*1400 - height*2000; diff > 2000 || diff < -2000 {
		t.Errorf("the thumbnail's aspect ratio drifted: %dx%d from 2000x1400", width, height)
	}
	// **What has to shrink is the cost, not the file.** This was measured rather than
	// assumed: a 2000×1400 gradient PNG of 55KB encodes to a 68KB JPEG thumbnail, so
	// the byte count went *up* while the picture went to a quarter of the pixels. That
	// is the common case for the files this feature exists for — screenshots and
	// photographs compress well as PNG — and a byte gate would reject the thumbnail for
	// precisely those, leaving the ladder no rung between the whole picture and a
	// sentence about it. The window is spent on pixels, so that is what the gate and
	// this assertion both read.
	if ImageRefCost(ImageRefFor(smaller, content.VariantThumbnail)) >=
		ImageRefCost(ImageRefFor(big, content.VariantOriginal)) {
		t.Errorf("the thumbnail costs %d tokens and the original %d",
			ImageRefCost(ImageRefFor(smaller, content.VariantThumbnail)),
			ImageRefCost(ImageRefFor(big, content.VariantOriginal)))
	}

	small := attachFor(t, h, pngOf(t, 32, 32), "small.png")
	if small.MetadataString(MetaThumbnailID) != "" {
		t.Error("a 32x32 picture got a thumbnail; there is nothing to shrink")
	}
}

// TestTheImageLadderIsItsOwn is the central rule of this file.
//
// full → thumbnail → metadata, and never through a text rung. Each step has to
// actually shrink the rendered cost, which is the property the text ladder's test
// pins for text and which has its own way of failing for pictures.
func TestTheImageLadderIsItsOwn(t *testing.T) {
	// The window is deliberately tiny. What is being tested is the **order** of the
	// rungs, and the way to make every rung get taken is a ceiling nothing fits under —
	// a generous one would let the picture sit at full and the ladder would never move,
	// which is what the first version of this test did and what made it prove nothing.
	h := newHarness(t, windowOf(4200))
	artifact := attachFor(t, h, pngOf(t, 2000, 1400), "big.png")
	h.manager.Add(artifact.ID, AddOptions{})

	render := h.renderer.RenderItem
	item := h.manager.Item(artifact.ID)

	var ladder []string
	previous := h.manager.Estimate(render, 0)
	ladder = append(ladder, string(item.Representation))

	for pass := 0; pass < 8; pass++ {
		if len(h.manager.Fit(render, 0)) == 0 {
			break
		}
		item = h.manager.Item(artifact.ID)
		current := h.manager.Estimate(render, 0)
		if item.Representation != RepresentationMetadata && !item.Removed {
			if current >= previous {
				t.Fatalf("step to %s did not shrink: %d → %d", item.Representation, previous, current)
			}
		}
		previous = current
		ladder = append(ladder, string(item.Representation))
		if item.Removed {
			ladder[len(ladder)-1] = "removed"
			break
		}
	}

	want := []string{"full", "thumbnail", "metadata", "removed"}
	for index, step := range ladder {
		if index >= len(want) || step != want[index] {
			t.Fatalf("the ladder was %v, which is not a prefix of %v", ladder, want)
		}
	}
	if len(ladder) < 2 {
		t.Fatal("nothing degraded at all")
	}
}

// TestAThumbnailLevelSendsTheSmallerBody: the level has to name a different
// artifact, or the step moved and the bytes did not.
func TestAThumbnailLevelSendsTheSmallerBody(t *testing.T) {
	h := newHarness(t, nil)
	artifact := attachFor(t, h, pngOf(t, 2000, 1400), "big.png")

	full := h.renderer.RenderArtifact(artifact, RepresentationFull, nil)
	small := h.renderer.RenderArtifact(artifact, RepresentationThumbnail, nil)

	if !full.Parts.HasImage() {
		t.Fatal("the full level did not render a picture")
	}
	if !small.Parts.HasImage() {
		t.Fatal("the thumbnail level did not render a picture")
	}
	fullImage := full.Parts.Images()[0]
	smallImage := small.Parts.Images()[0]
	if fullImage.ArtifactID == smallImage.ArtifactID {
		t.Fatal("the thumbnail level points at the original's bytes")
	}
	if smallImage.Variant != content.VariantThumbnail {
		t.Errorf("variant = %q", smallImage.Variant)
	}
	if ImageRefCost(smallImage) >= ImageRefCost(fullImage) {
		t.Errorf("the thumbnail costs %d and the original %d tokens",
			ImageRefCost(smallImage), ImageRefCost(fullImage))
	}
}

// TestAPictureWithNoThumbnailSkipsThatRung.
//
// A picture this build cannot shrink has nowhere to go but the facts. Taking the
// thumbnail rung anyway would leave the level moved, the bytes unchanged and the
// loop picking the same item for ever — the failure the text ladder's own test was
// written for, one layer down.
func TestAPictureWithNoThumbnailSkipsThatRung(t *testing.T) {
	// Tiny window again, for the same reason as the ladder test: the picture has to be
	// under pressure for the rung to be considered at all.
	h := newHarness(t, windowOf(4200))
	artifact := attachFor(t, h, pngOf(t, 32, 32), "small.png")
	h.manager.Add(artifact.ID, AddOptions{})

	render := h.renderer.RenderItem
	before := h.manager.Estimate(render, 0)
	degraded := h.manager.Fit(render, 0)
	if len(degraded) == 0 {
		t.Fatal("nothing degraded, so the test proves nothing")
	}
	item := h.manager.Item(artifact.ID)
	if item.Representation != RepresentationMetadata {
		t.Fatalf("level = %s, want metadata: there is no thumbnail to step onto", item.Representation)
	}
	if after := h.manager.Estimate(render, 0); after >= before {
		t.Errorf("metadata did not shrink the request: %d → %d", before, after)
	}
}

// TestTheMetadataLevelNamesThePicture: the last level before eviction still has to
// be useful, and for a picture that means its name, its size and its type.
func TestTheMetadataLevelNamesThePicture(t *testing.T) {
	h := newHarness(t, nil)
	artifact := attachFor(t, h, pngOf(t, 640, 480), "docs/rail.png")

	line := h.renderer.MetadataLine(artifact)
	for _, wanted := range []string{"rail.png", "640×480", "image/png", "docs/rail.png", artifact.ID} {
		if !strings.Contains(line, wanted) {
			t.Errorf("the metadata line does not mention %q:\n%s", wanted, line)
		}
	}
	// And it is a picture line, not a text one: a line count would be a fact about a
	// body that has no lines.
	if strings.Contains(line, "行数") {
		t.Errorf("the metadata line reports a line count for a picture:\n%s", line)
	}
}

// TestAMissingPictureRendersASentence.
//
// An empty render reads as "the tool produced nothing", which is a wrong conclusion
// that sends the model down a needless path. The sentence is the only evidence that
// a picture was meant to be there.
func TestAMissingPictureRendersASentence(t *testing.T) {
	h := newHarness(t, nil)
	artifact := attachFor(t, h, pngOf(t, 64, 64), "gone.png")

	if err := removeBody(h.store, artifact.ID); err != nil {
		t.Fatalf("removing the body: %v", err)
	}
	rendered := h.renderer.RenderArtifact(artifact, RepresentationFull, nil)
	if !rendered.Missing {
		t.Fatal("a missing picture was not reported as missing")
	}
	if strings.TrimSpace(rendered.Text) == "" {
		t.Fatal("a missing picture rendered as empty text")
	}
	if !strings.Contains(rendered.Text, artifact.ID) {
		t.Errorf("the sentence does not name the artifact: %q", rendered.Text)
	}
}

// TestAnEvictedPictureIsNamedNotBlanked: same rule one step further along the
// ladder. The user can send it again, and only a sentence telling them it is gone
// makes that possible.
func TestAnEvictedPictureIsNamedNotBlanked(t *testing.T) {
	h := newHarness(t, nil)
	artifact := attachFor(t, h, pngOf(t, 64, 64), "shot.png")
	h.manager.Add(artifact.ID, AddOptions{})
	h.manager.Remove(artifact.ID)

	body := h.renderer.RenderMessageContent(map[string]any{
		"role": "user",
		"content": content.Content{}.
			WithText("看看这个").
			WithImage(ImageRefFor(artifact, content.VariantOriginal)).
			ToParts(),
	})
	if body.HasImage() {
		t.Fatal("an evicted picture was still rendered as a picture")
	}
	text := body.TextOf()
	if !strings.Contains(text, "shot.png") {
		t.Errorf("the sentence does not name the picture: %q", text)
	}
	if !strings.Contains(text, "预算") {
		t.Errorf("the sentence does not say why it is gone: %q", text)
	}
}

// TestTheVisionGateDescribesRatherThanDrops.
//
// Three things have to hold at once, and the third is the one that is easy to get
// wrong:
//
//  1. a picture the model cannot be shown is **not** sent as an image block;
//  2. it is not silently dropped either — the model is told, by name;
//  3. the render **still succeeds**, so the session is not bricked. The picture is
//     in the session file, and a render that failed would make every later turn
//     fail the same way — the one failure shape a later model switch could not fix.
func TestTheVisionGateDescribesRatherThanDrops(t *testing.T) {
	h := newHarness(t, nil)
	artifact := attachFor(t, h, pngOf(t, 200, 200), "shot.png")
	h.manager.Add(artifact.ID, AddOptions{})
	h.renderer.AllowImages = func() (bool, string) { return false, "the model cannot be shown pictures" }

	rendered := h.renderer.RenderArtifact(artifact, RepresentationFull, nil)
	if rendered.Missing {
		t.Fatal("the render failed; a session would be bricked by a picture it cannot send")
	}
	if len(rendered.Parts) != 0 {
		t.Fatalf("a picture was rendered for a model that cannot see one: %#v", rendered.Parts)
	}
	if !strings.Contains(rendered.Text, "shot.png") {
		t.Errorf("the model was not told which picture it cannot see: %q", rendered.Text)
	}
	if !strings.Contains(rendered.Text, "cannot be shown") {
		t.Errorf("the reason is missing: %q", rendered.Text)
	}
	// And the item is still in the context, at the same level: the gate is about
	// this request, not about the picture.
	if item := h.manager.Item(artifact.ID); item.Removed {
		t.Error("the gate evicted the picture")
	}
}

// TestATextArtifactIsUnaffectedByTheImageGate: the gate must not leak into text.
func TestATextArtifactIsUnaffectedByTheImageGate(t *testing.T) {
	h := newHarness(t, nil)
	artifact := h.add(t, bigText(10), AddOptions{})
	h.renderer.AllowImages = func() (bool, string) { return false, "no pictures" }

	rendered := h.renderer.RenderItem(h.manager.Item(artifact.ID))
	if rendered.Missing || rendered.Text == "" {
		t.Fatalf("a text artifact was refused by the image gate: %#v", rendered)
	}
}

// TestRenderMessageLeavesTextOnlyMessagesAlone is the prefix-cache guard, one layer
// up from the content package's own: the renderer must hand back the **same map**,
// not a copy of it, so that nothing about the payload changes for a session that has
// never seen a picture.
func TestRenderMessageLeavesTextOnlyMessagesAlone(t *testing.T) {
	h := newHarness(t, nil)
	message := map[string]any{"role": "user", "content": "just words"}
	rendered := h.renderer.RenderMessage(message)
	if rendered["content"] != "just words" {
		t.Errorf("content = %#v", rendered["content"])
	}
	if _, isArray := rendered["content"].([]any); isArray {
		t.Error("a text body was wrapped in an array")
	}
}

// removeBody deletes an artifact's body behind the store's back, the way a person
// deleting the directory would. The store's index is dropped so the next read goes
// to disk again rather than to the cache.
func removeBody(store *ArtifactStore, artifactID string) error {
	if err := os.Remove(filepath.Join(store.Directory, RefsDirName, refName(artifactID)+".txt")); err != nil {
		return err
	}
	store.mu.Lock()
	store.loaded = false
	store.mu.Unlock()
	return nil
}
