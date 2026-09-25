package runtime

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/content"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/context"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// The end-to-end path a picture takes: a path in a sentence → an artifact → a
// message body → the context ledger.
//
// Each layer is unit-tested on its own (internal/content for the scan, internal/context
// for the store and the ladder, internal/model for the wire). What this file covers is
// the **seam**, which is where the interesting failures live: a scanner that finds a
// path nobody can read, a picture that is stored but never added to the ledger (so it
// can never be degraded and is invisible to the budget), a model that cannot see
// pictures but gets sent one anyway.

// attachRuntime is the smallest runtime that can attach a picture.
//
// `vision` decides whether the catalog's model declares it, because that flag is the
// feature's single capability switch — there is no second one, deliberately.
func attachRuntime(t *testing.T, vision bool) (*Runtime, string) {
	t.Helper()
	workspaceDir := t.TempDir()
	workspace, err := tools.NewWorkspace(workspaceDir)
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	store := context.OpenArtifactStore(filepath.Join(workspaceDir, ".tudouni", "artifacts", "s"), nil)
	manager := context.NewManager(store, nil, context.NewBudget(nil), nil)

	catalog := state.Registry{Providers: []state.Provider{{
		Name: "one", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []state.ModelRef{{ID: "m-one", Vision: vision}},
	}}}

	return &Runtime{
		SessionIDValue: "s",
		SessionValue:   &state.Session{SessionID: "s", Metadata: map[string]any{}},
		Workspace:      workspace,
		ContextValue:   manager,
		Catalog:        catalog,
		Chat:           &statusChat{},
		ModelState:     state.NewSessionModel(map[string]any{}, "m-one", "one"),
	}, workspaceDir
}

// writePNG puts a picture in the workspace and returns its workspace-relative path.
func writePNG(t *testing.T, workspaceDir, name string, width, height int) string {
	t.Helper()
	path := filepath.Join(workspaceDir, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, gradientPNG(t, width, height), 0o644); err != nil {
		t.Fatalf("writing the picture: %v", err)
	}
	return name
}

func gradientPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	source := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			source.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 90, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, source); err != nil {
		t.Fatalf("encoding: %v", err)
	}
	return buffer.Bytes()
}

// bodyOfTurn reads the opening message's body.
func bodyOfTurn(t *testing.T, messages []map[string]any) content.Content {
	t.Helper()
	if len(messages) != 1 {
		t.Fatalf("the turn has %d opening messages, want 1", len(messages))
	}
	return content.Parse(messages[0]["content"])
}

// TestAPathInASentenceBecomesAnAttachment is the feature, end to end.
func TestAPathInASentenceBecomesAnAttachment(t *testing.T) {
	runtimeValue, workspaceDir := attachRuntime(t, true)
	writePNG(t, workspaceDir, "shot.png", 320, 200)

	body := bodyOfTurn(t, runtimeValue.turnMessages("看看这个页面 shot.png 有什么问题"))
	if !body.HasImage() {
		t.Fatal("the picture was not attached")
	}
	images := body.Images()
	if len(images) != 1 {
		t.Fatalf("attached %d pictures, want 1", len(images))
	}
	if images[0].Name != "shot.png" {
		t.Errorf("name = %q, want the file's base name", images[0].Name)
	}
	if images[0].Width != 320 || images[0].Height != 200 {
		t.Errorf("dimensions = %dx%d, want 320x200", images[0].Width, images[0].Height)
	}
	// The user's words are still there, and so is the label — the model has to be able
	// to say *which* picture it means.
	text := body.TextOf()
	if !strings.Contains(text, "看看这个页面") {
		t.Errorf("the user's words were lost: %q", text)
	}
	if !strings.Contains(text, "shot.png") {
		t.Errorf("the picture is not labelled: %q", text)
	}

	// It has to be in the **ledger**, not only in the message. An artifact that reached
	// the store and not the context is one the budget can never degrade and the
	// renderer can never re-point — so it would be sent at full size for ever.
	item := runtimeValue.ContextValue.Item(images[0].ArtifactID)
	if item == nil {
		t.Fatal("the picture is in the message but not in the context ledger")
	}
	if item.Zone != context.ZoneStable {
		t.Errorf("zone = %q, want the stable band", item.Zone)
	}
	if item.Pinned {
		t.Error("the picture is pinned; it has a whole ladder of cheaper levels to use first")
	}
}

// TestATextOnlyTurnIsUnchanged is the prefix-cache guard at the highest level.
//
// A message that names no picture has to come out as the same plain string it always
// was. Every request in a session is priced on the longest common prefix with the
// previous one, so wrapping the body in an array for every turn would invalidate the
// cache for every token after the first changed byte.
func TestATextOnlyTurnIsUnchanged(t *testing.T) {
	runtimeValue, _ := attachRuntime(t, true)

	messages := runtimeValue.turnMessages("只是一个普通问题")
	body, ok := messages[0]["content"].(string)
	if !ok {
		t.Fatalf("content = %#v, want a plain string", messages[0]["content"])
	}
	if body != "只是一个普通问题" {
		t.Errorf("content = %q", body)
	}
}

// TestAWordThatIsNotAFileIsLeftAlone.
//
// Prose that mentions a `.png` must not become an attachment attempt or an error: the
// model can read the sentence perfectly well, and refusing the turn over a word would
// make the feature actively harmful.
func TestAWordThatIsNotAFileIsLeftAlone(t *testing.T) {
	runtimeValue, _ := attachRuntime(t, true)

	for _, text := range []string{
		"the .png format is lossless",
		"看看 missing/shot.png 这个文件",
		"no pictures here",
	} {
		messages := runtimeValue.turnMessages(text)
		body, ok := messages[0]["content"].(string)
		if !ok {
			t.Errorf("text %q produced a parts body", text)
			continue
		}
		if body != text {
			t.Errorf("text %q was rewritten to %q", text, body)
		}
	}
}

// TestAModelWithoutVisionDoesNotGetAPicture.
//
// The gate, and the shape of it matters as much as the fact: the **turn still runs**,
// with the file named in the text. Two alternatives are both worse —
//
//   - refusing the turn would make the feature unusable on every model that has not
//     declared vision, which is most of them;
//   - attaching and letting the renderer drop it would leave the user with no idea why
//     the model ignored their screenshot.
func TestAModelWithoutVisionDoesNotGetAPicture(t *testing.T) {
	runtimeValue, workspaceDir := attachRuntime(t, false)
	writePNG(t, workspaceDir, "shot.png", 320, 200)

	messages := runtimeValue.turnMessages("看看这个 shot.png")
	body := content.Parse(messages[0]["content"])
	if body.HasImage() {
		t.Fatal("a picture was attached for a model that cannot be shown one")
	}
	// The file is still named, so the model can tell the user it could not look.
	if !strings.Contains(body.TextOf(), "shot.png") {
		t.Errorf("the picture was silently dropped: %q", body.TextOf())
	}
	// And nothing entered the ledger: a picture the model cannot be shown would still
	// be counted against the budget and would still be rendered every round.
	if runtimeValue.ContextValue.Stats()["items"].(int) != 0 {
		t.Error("a refused picture was added to the context")
	}
}

// TestOnlyTheFirstFewPicturesAreAttached.
//
// A glob pasted into the input, or a script that printed a hundred file names, must not
// build a request that cannot be sent. Past the cap the rest are **named**, not
// silently dropped — the count is a fact the user has to be able to see.
func TestOnlyTheFirstFewPicturesAreAttached(t *testing.T) {
	runtimeValue, workspaceDir := attachRuntime(t, true)

	var names []string
	for index := 0; index < content.MaxImagesPerMessage+3; index++ {
		names = append(names, writePNG(t, workspaceDir, "shot"+string(rune('a'+index))+".png", 40, 40))
	}

	body := bodyOfTurn(t, runtimeValue.turnMessages("这批截图 "+strings.Join(names, " ")))
	if got := len(body.Images()); got != content.MaxImagesPerMessage {
		t.Fatalf("attached %d pictures, want the cap of %d", got, content.MaxImagesPerMessage)
	}
}

// TestAnUnreadablePictureIsSkippedNotFatal.
//
// An oversized file, a `.png` that is really text: each is reported and skipped. The
// turn's job is to answer the user, not to validate an attachment — and one bad file in
// a message that names three must not cost the other two.
func TestAnUnreadablePictureIsSkippedNotFatal(t *testing.T) {
	runtimeValue, workspaceDir := attachRuntime(t, true)
	writePNG(t, workspaceDir, "good.png", 40, 40)
	// A `.png` that is really text. The extension is what the scan goes on; the bytes
	// are what the sniff refuses.
	if err := os.WriteFile(filepath.Join(workspaceDir, "fake.png"), []byte("not a picture"), 0o644); err != nil {
		t.Fatalf("writing: %v", err)
	}

	body := bodyOfTurn(t, runtimeValue.turnMessages("看 good.png 和 fake.png"))
	images := body.Images()
	if len(images) != 1 {
		t.Fatalf("attached %d pictures, want the one that is really a picture", len(images))
	}
	if images[0].Name != "good.png" {
		t.Errorf("the wrong picture was attached: %q", images[0].Name)
	}
	// The bad name is still in the text, so the model can mention it.
	if !strings.Contains(body.TextOf(), "fake.png") {
		t.Errorf("the skipped picture vanished from the text: %q", body.TextOf())
	}
}

// TestAPathOutsideTheWorkspaceIsNotAttached.
//
// The attachment path goes through `Workspace.SafePath`, the same boundary the file
// tools use — and that is the whole reason this code lives in the runtime rather than
// in the scanner. A second path check is how one door ends up guarded and the other
// does not.
func TestAPathOutsideTheWorkspaceIsNotAttached(t *testing.T) {
	runtimeValue, workspaceDir := attachRuntime(t, true)

	// A real picture, outside the workspace: the refusal has to be about the boundary
	// rather than about the file being missing.
	outside := filepath.Join(filepath.Dir(workspaceDir), "outside.png")
	if err := os.WriteFile(outside, gradientPNG(t, 40, 40), 0o644); err != nil {
		t.Fatalf("writing: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(outside) })

	body := bodyOfTurn(t, runtimeValue.turnMessages("看这个 ../outside.png"))
	if body.HasImage() {
		t.Fatal("a picture from outside the workspace was attached")
	}
}

// TestTheWireLayerCanFetchTheBytes.
//
// This is the seam the whole design turns on, and it is a seam rather than a call
// because the two layers must not know each other: the adapter is handed an
// `ImageLoader` — "give me the bytes of this id" — and the runtime supplies it from the
// artifact store. So the wire layer stays free of the context package, and this test is
// what pins that the function actually reaches the bytes it names.
//
// Two halves, and the second is the one that matters: the id the ledger holds has to be
// the id whose bytes come back. An off-by-one here — the thumbnail's id when the level
// says original, or vice versa — produces a request that is legal, is billed for, and
// contains the wrong picture.
func TestTheWireLayerCanFetchTheBytes(t *testing.T) {
	runtimeValue, workspaceDir := attachRuntime(t, true)
	writePNG(t, workspaceDir, "big.png", 2400, 1600)

	body := bodyOfTurn(t, runtimeValue.turnMessages("看 big.png"))
	images := body.Images()
	if len(images) != 1 {
		t.Fatalf("attached %d pictures, want 1", len(images))
	}

	loader := &artifactImages{manager: runtimeValue.ContextValue}
	original, ok := loader.Load(images[0].ArtifactID)
	if !ok {
		t.Fatal("the loader cannot fetch the picture the message names")
	}
	if len(original) == 0 {
		t.Fatal("the loader returned an empty body")
	}

	// An id nothing knows about is a false answer, not an empty body: the dialects turn
	// false into a sentence naming the picture, and an empty body would be sent as an
	// empty image block — which two of the three endpoints refuse and the third accepts
	// while showing the model nothing.
	if _, ok := loader.Load("art_nonexistent"); ok {
		t.Error("the loader claimed to have bytes for an id that was never stored")
	}

	// The thumbnail, when there is one, comes back as **different** bytes. That is the
	// level's whole meaning, and getting it wrong sends the original at a level that
	// says it is smaller.
	stored, _ := runtimeValue.ContextValue.Store.Get(images[0].ArtifactID)
	if thumbnailID := stored.MetadataString(context.MetaThumbnailID); thumbnailID != "" {
		smaller, ok := loader.Load(thumbnailID)
		if !ok {
			t.Fatalf("the ledger names thumbnail %s but the loader cannot fetch it", thumbnailID)
		}
		if string(smaller) == string(original) {
			t.Error("the thumbnail is the original's bytes under another id")
		}
	}
}

// TestAVisionModelSwitchTakesEffectWithoutBrickingTheSession.
//
// `vision` is a property of the model **in use**, so it can change mid-session — and a
// picture attached while a vision model was running must not be sent to the model
// afterwards. The other half is the one that is easy to get wrong: the turn must still
// **succeed**. The picture is in the session file, so a render that failed would make
// every later turn of that session fail identically, and switching back to a vision
// model — the one action that can fix it — would not be reachable.
func TestAVisionModelSwitchTakesEffectWithoutBrickingTheSession(t *testing.T) {
	runtimeValue, workspaceDir := attachRuntime(t, true)
	writePNG(t, workspaceDir, "shot.png", 320, 200)

	messages := runtimeValue.turnMessages("看 shot.png")
	images := bodyOfTurn(t, messages).Images()
	if len(images) != 1 {
		t.Fatalf("attached %d pictures, want 1", len(images))
	}

	renderer := context.NewRenderer(runtimeValue.ContextValue.Store, runtimeValue.ContextValue)
	renderer.AllowImages = func() (bool, string) {
		return runtimeValue.modelVision(), "the model in use cannot be shown pictures"
	}

	// The model can see: the picture is sent.
	if got := content.Parse(renderer.RenderMessage(messages[0])["content"]); !got.HasImage() {
		t.Fatal("a picture was not sent to a vision model")
	}

	// Now the catalogue says the model cannot. The same stored message has to render —
	// not fail — and it has to come back without a picture.
	runtimeValue.Catalog.Providers[0].Models[0].Vision = false
	rendered := content.Parse(renderer.RenderMessage(messages[0])["content"])
	if rendered.HasImage() {
		t.Fatal("a picture was sent to a model that cannot be shown one")
	}
	if !strings.Contains(rendered.TextOf(), "shot.png") {
		t.Errorf("the model was not told which picture it cannot see: %q", rendered.TextOf())
	}

	// And back, to prove the gate is a reading rather than a one-way latch.
	runtimeValue.Catalog.Providers[0].Models[0].Vision = true
	if got := content.Parse(renderer.RenderMessage(messages[0])["content"]); !got.HasImage() {
		t.Fatal("the picture did not come back when the model could see again")
	}
}

// TestThePictureIsDegradableLikeAnythingElse.
//
// The design's requirement that this feature **reuses** the existing mechanisms rather
// than adding a parallel one: a picture in the context has to walk the ladder under
// budget pressure, and the message it lives in has to follow it down. If it did not, the
// feature would be a second mechanism that happens to look like the first.
func TestThePictureIsDegradableLikeAnythingElse(t *testing.T) {
	runtimeValue, workspaceDir := attachRuntime(t, true)
	writePNG(t, workspaceDir, "big.png", 2400, 1600)

	messages := runtimeValue.turnMessages("看 big.png")
	body := bodyOfTurn(t, messages)
	images := body.Images()
	if len(images) != 1 {
		t.Fatalf("attached %d pictures, want 1", len(images))
	}

	// A ceiling nothing that size fits under, so every rung gets taken.
	tokens := 4200
	runtimeValue.ContextValue.Budget.MaxTokens = &tokens
	renderer := context.NewRenderer(runtimeValue.ContextValue.Store, runtimeValue.ContextValue)
	if len(runtimeValue.ContextValue.Fit(renderer.RenderItem, 0)) == 0 {
		t.Fatal("the picture did not degrade at all; the ladder does not apply to it")
	}

	// And the message follows: re-rendering it produces the level the ledger is at,
	// rather than the full picture it was written with.
	rendered := renderer.RenderMessage(messages[0])
	renderedBody := content.Parse(rendered["content"])
	if len(renderedBody.Images()) == 0 {
		return // degraded all the way to a sentence, which is a valid rung
	}
	after := renderedBody.Images()[0]
	if after.ArtifactID == images[0].ArtifactID {
		t.Error("the message still points at the original bytes after degrading")
	}
}
