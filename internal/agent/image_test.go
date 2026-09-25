package agent

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
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// A picture a tool read, and how it reaches the model.
//
// This is the seam the design turns on, and it has three parts that must all hold
// at once:
//
//	the tool returns bytes        → not base64, not a description
//	the agent stores an artifact  → the one writer, not the tool
//	the model gets a user message → the position all three protocols accept
//
// The third is the one that looks odd until you know why, and it is worth a test of
// its own because the obvious alternative — putting the picture inside the tool
// result — is refused by the chat completions shape with
//
//	Image URLs are only allowed for messages with role 'user'
//
// which is the shape this program talks to most.

// pictureTool is a stand-in for `read_image`: it returns a picture for the path it
// is given.
//
// It is a fake rather than the real tool so the seam can be tested without a
// workspace, a file, or a schema — what is under test here is the agent's half.
func pictureTool(t *testing.T) tools.Tool {
	return tools.Tool{
		Name:         "read_image",
		Description:  "read a picture",
		Risk:         security.RiskLow,
		ParallelSafe: true,
		Schema: tools.ObjectSchema(map[string]any{
			"path": tools.StringSchema("path", tools.MinLength(1)),
		}, "path"),
		Handler: func(arguments map[string]any) (tools.Result, error) {
			path, _ := arguments["path"].(string)
			return tools.Result{
				Text: "已读取图片 " + path,
				Images: []tools.ImageContent{{
					Body: pictureFor(t, path),
					Name: filepath.Base(path),
					Path: path,
				}},
			}, nil
		},
	}
}

// pictureFor is the picture that tool returns for one path.
//
// **Different paths have to produce different bytes**, and that is a fixture
// requirement rather than a detail: the store is content-addressed, so two calls
// returning identical bytes collapse into one artifact — which is real behaviour
// worth its own test (see TestTheSamePictureReadTwiceIsSentOnce) but makes a
// useless fixture for "two calls produced two pictures".
func pictureFor(t *testing.T, path string) []byte {
	t.Helper()
	width, height := 640, 480
	if path != "architecture.png" {
		width, height = 64+len(path)*8, 96
	}
	return pngBody(t, width, height)
}

// pngBody builds a real PNG: the agent's attach path measures it, so a fake would
// let a broken sniff pass.
func pngBody(t *testing.T, width, height int) []byte {
	t.Helper()
	source := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			source.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 70, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, source); err != nil {
		t.Fatalf("encoding: %v", err)
	}
	return buffer.Bytes()
}

// imageHarness is one agent whose only tool produces a picture.
type imageHarness struct {
	agent   *Agent
	session *state.Session
	store   *context.ArtifactStore
	manager *context.Manager
	model   *fakeModel
	body    []byte
}

func newImageHarness(t *testing.T, script ...model.ModelResponse) *imageHarness {
	t.Helper()
	workspace := t.TempDir()
	store := context.OpenArtifactStore(filepath.Join(workspace, "artifacts"), nil)
	tokens := 200_000
	manager := context.NewManager(store, nil, context.NewBudget(&tokens), nil)

	registry := tools.NewRegistry()
	if err := registry.Register(pictureTool(t)); err != nil {
		t.Fatal(err)
	}

	session := state.NewEmptySession("s")
	session.Append(map[string]any{"role": "system", "content": "prompt"})

	chat := &fakeModel{script: script}
	h := &imageHarness{session: session, store: store, manager: manager, model: chat}
	h.agent = New(Config{
		Chat:     chat,
		Tools:    registry,
		Policy:   security.NewPolicy(),
		Session:  session,
		Context:  manager,
		MaxSteps: 4,
		Vision:   func() bool { return true },
	})
	return h
}

// TestAPictureFromAToolReachesTheModelAsAPicture is the whole chain in one test.
func TestAPictureFromAToolReachesTheModelAsAPicture(t *testing.T) {
	h := newImageHarness(t,
		toolCallResponse("c1", "read_image", `{"path":"architecture.png"}`),
		textResponse("it is a diagram"),
	)

	answer, err := h.agent.RunMessages([]map[string]any{{"role": "user", "content": "看下图"}})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if answer != "it is a diagram" {
		t.Fatalf("answer = %q", answer)
	}

	// 1) The history has a message carrying a picture, and it is a **user** message.
	var carrier map[string]any
	for _, message := range h.session.Messages {
		if content.MessageHasImage(message) {
			carrier = message
		}
	}
	if carrier == nil {
		t.Fatal("no message in history carries the picture")
	}
	if carrier["role"] != "user" {
		t.Fatalf("the picture travels as a %v message; the chat completions shape refuses an image anywhere but 'user'", carrier["role"])
	}
	images := content.Parse(carrier["content"]).Images()
	if len(images) != 1 {
		t.Fatalf("the message carries %d pictures, want 1", len(images))
	}
	if images[0].Name != "architecture.png" {
		t.Errorf("name = %q, want the file's base name", images[0].Name)
	}
	if images[0].Width != 640 || images[0].Height != 480 {
		t.Errorf("dimensions = %dx%d, want 640x480", images[0].Width, images[0].Height)
	}

	// 2) It is in the ledger, so the budget can price it and the ladder can shrink
	// it. A picture that reached the message but not the ledger would be sent at
	// full size for ever.
	item := h.manager.Item(images[0].ArtifactID)
	if item == nil {
		t.Fatal("the picture is in the message but not in the context ledger")
	}
	if item.Pinned {
		t.Error("the picture is pinned, so it can never degrade to a thumbnail")
	}

	// 3) The bytes on disk are the tool's bytes, not an encoding of them.
	stored, ok := h.store.Bytes(images[0].ArtifactID)
	if !ok {
		t.Fatal("the artifact's body cannot be fetched")
	}
	if !bytes.Equal(stored, pictureFor(t, "architecture.png")) {
		t.Error("the stored body is not what the tool returned")
	}

	// 4) And the payload that actually went out carries the picture, not a wall of
	// base64 in the text.
	last := h.model.seen[len(h.model.seen)-1]
	var sent bool
	for _, message := range last {
		if content.MessageHasImage(message) {
			sent = true
		}
		if text, ok := message["content"].(string); ok && strings.Contains(text, "iVBOR") {
			t.Error("base64 reached the payload as text")
		}
	}
	if !sent {
		t.Error("the payload the model was sent carries no picture")
	}
}

// TestThePictureComesAfterEveryToolResult.
//
// The chat completions shape requires every `tool_calls` entry to be answered before
// the conversation moves on, so a user message wedged between two tool results makes
// the request invalid. This is that rule, and it is the reason the pictures are
// collected into one message at the end rather than appended as they are read.
func TestThePictureComesAfterEveryToolResult(t *testing.T) {
	h := newImageHarness(t,
		model.ModelResponse{ToolCalls: []model.ToolCall{
			{ID: "c1", Name: "read_image", Arguments: `{"path":"a.png"}`},
			{ID: "c2", Name: "read_image", Arguments: `{"path":"b.png"}`},
		}},
		textResponse("both are diagrams"),
	)

	if _, err := h.agent.RunMessages([]map[string]any{{"role": "user", "content": "看这两张"}}); err != nil {
		t.Fatalf("run: %v", err)
	}

	// The invariant the endpoint enforces: an assistant turn that asked for tools
	// must be followed **immediately** by one result per call, with nothing
	// interleaved until they are all answered. A picture message between two results
	// is what breaks it — and that is the failure this pins, because putting each
	// picture beside the result it came from is the obvious design.
	//
	// Note what the rule is *not*: "no tool message after any non-tool message". The
	// user's own turn precedes the assistant turn that calls the tools, so that
	// reading fails on every well-formed conversation — it did, on the first version
	// of this test.
	pending := map[string]bool{}
	for index, message := range h.session.Messages {
		role, _ := message["role"].(string)
		if len(pending) > 0 && role != "tool" {
			t.Fatalf("message %d is a %s message while %v were still unanswered: "+
				"the endpoint refuses a tool_calls entry answered after the conversation moved on",
				index, role, pending)
		}
		switch role {
		case "assistant":
			if calls, ok := message["tool_calls"].([]any); ok {
				for _, item := range calls {
					call, _ := item.(map[string]any)
					if id, _ := call["id"].(string); id != "" {
						pending[id] = true
					}
				}
			}
		case "tool":
			if id, _ := message["tool_call_id"].(string); id != "" {
				delete(pending, id)
			}
		}
	}
	if len(pending) > 0 {
		t.Errorf("the turn ended with %v unanswered", pending)
	}

	// Both pictures arrived, in one message, and the tool results are all present.
	var pictures int
	for _, message := range h.session.Messages {
		pictures += len(content.Parse(message["content"]).Images())
	}
	if pictures != 2 {
		t.Errorf("history carries %d pictures, want 2 (one per call)", pictures)
	}
}

// TestThePictureMessageIsNotReadAsAPersonSpeaking.
//
// `RuntimeNoteKey` is what `IsHumanTurn` reads, and the scan stops at the first
// message that is neither `tool` nor `assistant`. An unmarked image message would
// therefore become the evidence that "a person asked for this" — and in an
// autonomous goal round that is exactly the authorization the marker exists to
// withhold: a round could then start, redefine or resume a goal on its own
// authority, because it had read a picture.
func TestThePictureMessageIsNotReadAsAPersonSpeaking(t *testing.T) {
	h := newImageHarness(t,
		toolCallResponse("c1", "read_image", `{"path":"architecture.png"}`),
		textResponse("done"),
	)

	if _, err := h.agent.RunMessages([]map[string]any{{"role": "user", "content": "看下图"}}); err != nil {
		t.Fatalf("run: %v", err)
	}

	marked := false
	for _, message := range h.session.Messages {
		if !content.MessageHasImage(message) {
			continue
		}
		if flag, _ := message[state.RuntimeNoteKey].(bool); !flag {
			t.Error("the picture message is not marked as a runtime note, " +
				"so it reads as a person's own words")
		} else {
			marked = true
		}
	}
	if !marked {
		t.Fatal("no picture message was found to check")
	}

	// And the session as a whole does not claim a person asked for the picture.
	if session := h.session; len(session.UserInputs()) != 1 {
		t.Errorf("UserInputs() = %#v, want only the one turn the person typed", session.UserInputs())
	}
}

// TestAToolWithNoPicturesAddsNoMessage.
//
// The common case is a tool that returns text, and it must not grow a stray empty
// message: every extra message is re-sent every round, and one that says nothing is
// pure cost.
func TestAToolWithNoPicturesAddsNoMessage(t *testing.T) {
	h := newImageHarness(t,
		toolCallResponse("c1", "read_image", `{"path":"architecture.png"}`),
		textResponse("done"),
	)
	// Swap the tool for a text-only one of the same name.
	registry := tools.NewRegistry()
	if err := registry.Register(tools.Tool{
		Name: "read_image", Description: "text only", Risk: security.RiskLow, ParallelSafe: true,
		Schema: tools.ObjectSchema(map[string]any{"path": tools.StringSchema("path", tools.MinLength(1))}, "path"),
		Handler: func(map[string]any) (tools.Result, error) {
			return tools.TextResult("no picture here"), nil
		},
	}); err != nil {
		t.Fatal(err)
	}
	h.agent.Tools = registry

	before := len(h.session.Messages)
	if _, err := h.agent.RunMessages([]map[string]any{{"role": "user", "content": "看下图"}}); err != nil {
		t.Fatalf("run: %v", err)
	}

	for _, message := range h.session.Messages {
		if content.MessageHasImage(message) {
			t.Error("a text-only tool produced a picture message")
		}
	}
	// user + assistant(tool_calls) + tool + assistant(answer)
	if got := len(h.session.Messages) - before; got != 4 {
		t.Errorf("the turn added %d messages, want 4: an empty picture message was appended", got)
	}
}

// TestAnUnstorablePictureIsSaidNotSilentlyDropped.
//
// A store that refuses the bytes (a full disk, a deleted directory) must not look
// like a tool that returned nothing: the tool's own sentence says "已读取图片 …", and
// leaving it alone would tell the model it had seen a picture it never got.
func TestAnUnstorablePictureIsSaidNotSilentlyDropped(t *testing.T) {
	h := newImageHarness(t,
		toolCallResponse("c1", "read_image", `{"path":"architecture.png"}`),
		textResponse("done"),
	)
	// A store rooted at a path that cannot be created: a file, not a directory, so
	// every write under it fails the way a full disk or a deleted directory does.
	blocker := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}
	h.manager.Store = context.OpenArtifactStore(filepath.Join(blocker, "artifacts"), nil)

	if _, err := h.agent.RunMessages([]map[string]any{{"role": "user", "content": "看下图"}}); err != nil {
		t.Fatalf("run: %v", err)
	}

	for _, message := range h.session.Messages {
		if content.MessageHasImage(message) {
			t.Fatal("a picture was stored by a store that cannot store")
		}
	}
	// The model has to be told, or it believes it saw the picture.
	//
	// The sentence travels in a **parts** body, not a string — it is a text part
	// beside the pictures that did arrive — so the check goes through
	// `content.Parse`. Reading `message["content"].(string)` here was the first
	// version of this assertion, and it failed on a history that did say so.
	var told bool
	for _, message := range h.session.Messages {
		if strings.Contains(content.Parse(message["content"]).TextOf(), "没能存进上下文") {
			told = true
		}
	}
	if !told {
		t.Error("the failure was silent: the tool said it read a picture and nothing said it was lost")
	}
}

// TestAPictureFromAToolDegradesLikeAnyOther is the design's central claim, tested.
//
// `read_image` was built to reuse the chain a user's own attachment goes down —
// "和用户主动提供图片走同一条后端链路" — and the point of that choice is that
// everything downstream already works: the budget prices the picture by area, the
// ladder shrinks it to a thumbnail before dropping it, and the renderer re-points it
// at whatever level the ledger decides.
//
// If any of that had needed a second copy for tool-read pictures, this test is where
// the copy would show up as missing. It is deliberately the same assertion the
// runtime's own attachment test makes, because it must be the same behaviour.
func TestAPictureFromAToolDegradesLikeAnyOther(t *testing.T) {
	h := newImageHarness(t,
		toolCallResponse("c1", "read_image", `{"path":"architecture.png"}`),
		textResponse("done"),
	)
	if _, err := h.agent.RunMessages([]map[string]any{{"role": "user", "content": "看下图"}}); err != nil {
		t.Fatalf("run: %v", err)
	}

	// Find the picture the turn put in the ledger.
	var artifactID string
	for _, message := range h.session.Messages {
		for _, image := range content.Parse(message["content"]).Images() {
			artifactID = image.ArtifactID
		}
	}
	if artifactID == "" {
		t.Fatal("no picture reached the ledger")
	}

	// A ceiling nothing that size fits under, so the ladder has to move.
	tokens := 4200
	h.manager.Budget.MaxTokens = &tokens
	renderer := context.NewRenderer(h.store, h.manager)

	// **Several passes, not one.** `Fit` is single-step by design: it drops one
	// level and returns, so that the next step can re-decide with a fresh
	// measurement. It also picks the **oldest** item first, whatever its size —
	// which here is the tool result's own text ("已读取图片 architecture.png", 22
	// characters), because that entered the ledger before the picture did.
	//
	// So one call moves the text and leaves the picture alone. That is the budget
	// working as documented rather than a picture that cannot degrade, and the way
	// to tell the two apart is to keep going until the ladder reaches it.
	before := h.manager.Item(artifactID).Representation
	moved := false
	for pass := 0; pass < 6 && !moved; pass++ {
		if len(h.manager.Fit(renderer.RenderItem, 0)) == 0 {
			break
		}
		if h.manager.Item(artifactID).Representation != before {
			moved = true
		}
	}
	if !moved {
		t.Fatalf("six passes of the budget never reached the picture: the ladder does not apply to what a tool read (level still %s)", before)
	}
	after := h.manager.Item(artifactID).Representation
	if after == before {
		t.Fatalf("the level did not move: %s", after)
	}
	// The step has to be a real rung of the **image** ladder, not a text one: a
	// picture cannot be truncated, so `range` or `preview` on it would be a level
	// that moves while the bytes stay the same.
	switch after {
	case context.RepresentationThumbnail, context.RepresentationMetadata:
	default:
		t.Errorf("the picture stepped to %q, which is not an image rung", after)
	}

	// And the message follows the ledger: re-rendering it produces the level the
	// item is at, rather than the full picture it was written with.
	var carrier map[string]any
	for _, message := range h.session.Messages {
		if content.MessageHasImage(message) {
			carrier = message
		}
	}
	rendered := content.Parse(renderer.RenderMessage(carrier)["content"])
	if images := rendered.Images(); len(images) > 0 {
		if images[0].ArtifactID == artifactID {
			t.Error("the message still points at the original bytes after degrading")
		}
		if images[0].Variant != content.VariantThumbnail {
			t.Errorf("variant = %q, want a thumbnail", images[0].Variant)
		}
	}
}

// TestTheSamePictureReadTwiceIsSentOnce.
//
// Two `read_image` calls naming one file produce one artifact — the store is
// content-addressed — so appending both would put two identical picture blocks in
// the request while the ledger holds a single item. The model would pay for the
// picture twice and the budget would count it once, and **under-counting is the
// dangerous direction**: the request goes out over the window and the 400 that
// follows reads like "context too long" with nothing visibly over.
//
// It is also what the user's own attachment path already does — see
// `runtime.attachPictures`, which drops a second naming of the same artifact for the
// same reason. The two paths agreeing is the design: a picture is the same picture
// however it arrived.
func TestTheSamePictureReadTwiceIsSentOnce(t *testing.T) {
	h := newImageHarness(t,
		model.ModelResponse{ToolCalls: []model.ToolCall{
			{ID: "c1", Name: "read_image", Arguments: `{"path":"architecture.png"}`},
			{ID: "c2", Name: "read_image", Arguments: `{"path":"architecture.png"}`},
		}},
		textResponse("done"),
	)

	if _, err := h.agent.RunMessages([]map[string]any{{"role": "user", "content": "看这张"}}); err != nil {
		t.Fatalf("run: %v", err)
	}

	var ids []string
	for _, message := range h.session.Messages {
		for _, image := range content.Parse(message["content"]).Images() {
			ids = append(ids, image.ArtifactID)
		}
	}
	if len(ids) != 1 {
		t.Fatalf("the request carries %d picture parts for one file: %v", len(ids), ids)
	}

	// And the ledger agrees with the payload: one **picture** item, one picture.
	//
	// The count is over items whose artifact is a picture, not over every item: the
	// tool result's own text is an artifact too (that is what makes history a
	// reference rather than a body), so counting `Live()` outright was the first
	// version of this assertion and it counted the wrong thing.
	pictures := 0
	for _, item := range h.manager.State.Live() {
		if artifact, ok := h.store.Get(item.ArtifactID); ok && artifact.IsImage() {
			pictures++
		}
	}
	if pictures != 1 {
		t.Errorf("the ledger holds %d picture items, want 1", pictures)
	}
}
