package agent

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"path/filepath"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/content"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/context"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// How a picture is counted, and the twice-counted bug this pins.
//
// A picture that the user attached is in **two** places at once, and that is not
// duplication — each exists for a reason:
//
//	the ledger item   so it can be degraded and evicted like anything else
//	the message body  because that is where the model reads it
//
// The estimator walks both. The ledger walk prices what the item renders **at its
// current level** (the thumbnail, or the sentence it degraded to); the message walk
// reads the *stored* body, whose part still names the full-size artifact however far
// the ladder has taken it.
//
// So counting the body's copy as well charges the session twice for one screenshot,
// and the second charge never gets cheaper as the picture degrades — a picture that
// looks twice as expensive as it is and stays that way. That is the opposite of what
// the ladder is for, and it is invisible: the numbers are plausible, the request is
// under budget, and nothing reports that one image was billed twice.
//
// The rule is the one tool messages already followed — a **reference** is counted by
// the item estimate and only a genuinely inline body is counted in full — applied to
// the other kind of part that can be a reference.

// pngBytes builds a real PNG, because the attach path measures it: a fake would let a
// broken sniff pass, and the dimensions it reports are what the estimate reads.
func pngBytes(t *testing.T, width, height int) []byte {
	t.Helper()
	source := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			source.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 60, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, source); err != nil {
		t.Fatalf("encoding: %v", err)
	}
	return buffer.Bytes()
}

// countedHarness is one agent whose history carries a picture, plus the ledger that
// knows about it.
type countedHarness struct {
	agent   *Agent
	store   *context.ArtifactStore
	manager *context.Manager
	image   content.Content
}

// newCountedHarness builds the agent and the body, and leaves it to the caller to say
// whether the ledger should know about the picture.
func newCountedHarness(t *testing.T) *countedHarness {
	t.Helper()
	workspace := t.TempDir()
	store := context.OpenArtifactStore(filepath.Join(workspace, "artifacts"), nil)
	tokens := 200_000
	manager := context.NewManager(store, nil, context.NewBudget(&tokens), nil)

	artifact, err := context.AttachImage(store, pngBytes(t, 1200, 900), context.ArtifactSource{
		Tool: "attach_image", Path: "shot.png",
	})
	if err != nil {
		t.Fatalf("AttachImage: %v", err)
	}

	session := state.NewEmptySession("s")
	session.Append(map[string]any{"role": "system", "content": "prompt"})
	body := content.Content{}.
		WithText("这张图怎么了？").
		WithImage(context.ImageRefFor(artifact, content.VariantOriginal))
	session.Append(map[string]any{"role": "user", "content": body.ToParts()})

	registry := tools.NewRegistry()
	agent := New(Config{
		Chat:     &fakeModel{},
		Tools:    registry,
		Policy:   security.NewPolicy(),
		Session:  session,
		Context:  manager,
		MaxSteps: 1,
		Vision:   func() bool { return true },
	})
	return &countedHarness{agent: agent, store: store, manager: manager, image: body}
}

// TestAPictureTheLedgerKnowsAboutIsNotCountedTwice is the regression.
func TestAPictureTheLedgerKnowsAboutIsNotCountedTwice(t *testing.T) {
	h := newCountedHarness(t)
	images := h.image.Images()
	if len(images) != 1 {
		t.Fatalf("the body carries %d pictures", len(images))
	}

	// The picture is in the ledger: the item estimate prices it, so the fixed
	// overhead must not.
	h.manager.Add(images[0].ArtifactID, context.AddOptions{})
	withLedger := h.agent.FixedPayloadTokens()

	// And now the same body with no ledger entry for it — the state after a context
	// record that did not decode. Here nothing else prices the picture, so **this**
	// walk has to, or the estimate would call a request cheap that is not.
	h.manager.State.Items = nil
	withoutLedger := h.agent.FixedPayloadTokens()

	if withLedger == withoutLedger {
		t.Fatal("the ledger entry made no difference to the fixed overhead: " +
			"the body's copy of the picture is being counted either way")
	}
	if withoutLedger <= withLedger {
		t.Fatalf("an unpriced picture made the overhead smaller (%d → %d)", withLedger, withoutLedger)
	}
	// The difference is the picture, and it is a picture-sized number rather than a
	// couple of characters' worth: a 1200x900 image is thousands of tokens by either
	// published rule, so a handful here would mean the body was misread.
	if gap := withoutLedger - withLedger; gap < 500 {
		t.Errorf("the picture was worth only %d tokens to the fixed overhead", gap)
	}
}

// TestAnUnreferencedPictureIsStillPaidFor is the other direction, and it is the
// dangerous one: under-estimating fails the request outright, so a picture nobody
// prices must be counted here.
func TestAnUnreferencedPictureIsStillPaidFor(t *testing.T) {
	h := newCountedHarness(t)
	// No ledger entry at all: nothing else in the estimate knows this picture exists.
	textOnly := h.agent.FixedPayloadTokens()

	// The same history with the words and no picture: whatever the difference is, the
	// picture has to be worth something.
	h.agent.Session.Messages[1]["content"] = "这张图怎么了？"
	if after := h.agent.FixedPayloadTokens(); after >= textOnly {
		t.Fatalf("dropping the picture did not lower the estimate (%d → %d)", textOnly, after)
	}
}

// TestMeasureCountsAPictureExactlyOnce goes through the whole sum rather than the
// fixed half, because that is the number a person reads on `/context` and the one a
// compaction's before/after is computed from.
func TestMeasureCountsAPictureExactlyOnce(t *testing.T) {
	h := newCountedHarness(t)
	image := h.image.Images()[0]
	h.manager.Add(image.ArtifactID, context.AddOptions{})

	// The item estimate alone is what the picture is supposed to cost.
	renderer := context.NewRenderer(h.store, h.manager)
	itemHalf := h.manager.Budget.EstimateItems(h.manager.State.Live(), renderer.RenderItem)

	// Measure adds the fixed overhead, the system prompt and the trailing note on top.
	// So: measure minus those three equals the item half, and the picture is in it
	// once. Computing the other three here is what makes this a statement about the
	// arithmetic rather than about a number I chose.
	full := h.agent.Measure()
	overhead := h.agent.FixedPayloadTokens()
	system := h.manager.Budget.Tokens("prompt") + context.MessageOverhead
	if got := full - overhead - system; got != itemHalf {
		t.Fatalf("measure's artifact half is %d but the item estimate says %d: "+
			"the picture is being counted somewhere else as well", got, itemHalf)
	}
}
