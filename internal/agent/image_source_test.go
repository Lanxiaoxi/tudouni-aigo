package agent

import (
	"context"
	"path/filepath"
	"testing"

	ctxwin "github.com/Lanxiaoxi/tudouni-aigo/internal/context"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// The artifact's source must say **which tool produced the picture**.
//
// It used to be written down as `read_image` for every picture, which was true
// while `read_image` was the only tool that could produce one. The moment a
// second tool joined it — `generate_image`, which draws a picture rather than
// reading one — the hardcoded name became a lie: a generated picture was
// recorded as one that had been read.
//
// It is a small thing, and it is exactly the kind of small thing that is worth
// a test: the audit is what somebody reads afterwards to answer "where did
// this come from", and a lie in it is worse than a missing field.

// generatingTool is a stand-in for `generate_image`: it returns a picture the
// way the real tool does.
func generatingTool(t *testing.T) tools.Tool {
	return tools.Tool{
		Name:        "generate_image",
		Description: "draw a picture",
		Risk:        security.RiskMedium,
		Schema: tools.ObjectSchema(map[string]any{
			"path": tools.StringSchema("path", tools.MinLength(1)),
		}, "path"),
		Handler: func(_ context.Context, arguments map[string]any) (tools.Result, error) {
			path, _ := arguments["path"].(string)
			return tools.Result{
				Text: "已生成 " + path,
				Images: []tools.ImageContent{{
					Body: pictureFor(t, path),
					Name: filepath.Base(path),
					Path: path,
				}},
			}, nil
		},
	}
}

// sourceHarness is an agent with two picture-producing tools.
type sourceHarness struct {
	agent   *Agent
	session *state.Session
	store   *ctxwin.ArtifactStore
}

func newSourceHarness(t *testing.T, script ...model.ModelResponse) *sourceHarness {
	t.Helper()
	workspace := t.TempDir()
	store := ctxwin.OpenArtifactStore(filepath.Join(workspace, "artifacts"), nil)
	tokens := 200_000
	manager := ctxwin.NewManager(store, nil, ctxwin.NewBudget(&tokens), nil)

	registry := tools.NewRegistry()
	if err := registry.Register(pictureTool(t)); err != nil {
		t.Fatal(err)
	}
	if err := registry.Register(generatingTool(t)); err != nil {
		t.Fatal(err)
	}

	session := state.NewEmptySession("s")
	session.Append(map[string]any{"role": "system", "content": "prompt"})

	chat := &fakeModel{script: script}
	h := &sourceHarness{session: session, store: store}
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

// TestTheArtifactSaysWhichToolProducedThePicture is the regression.
//
// A generated picture recorded as "read" is a lie in the one place somebody
// would go looking for it.
func TestTheArtifactSaysWhichToolProducedThePicture(t *testing.T) {
	h := newSourceHarness(t,
		toolCallResponse("c1", "generate_image", `{"path":"out/poster.png"}`),
		textResponse("done"),
	)

	if _, err := h.agent.RunMessages(context.Background(),
		[]map[string]any{{"role": "user", "content": "画一张海报"}}); err != nil {
		t.Fatalf("run: %v", err)
	}

	artifacts := h.store.All()
	if len(artifacts) == 0 {
		t.Fatal("no artifact was stored")
	}
	// The store keeps the original and, when one is worth making, a thumbnail.
	// Both carry the same source, so the check is on the **original** — the one
	// whose variant is not "thumbnail".
	original := findOriginal(artifacts)
	if original == nil {
		t.Fatal("no original artifact was stored")
	}
	if original.Source.Tool != "generate_image" {
		t.Errorf("the artifact says it came from %q, want generate_image",
			original.Source.Tool)
	}
}

// TestTheReadToolStillSaysReadImage checks the other direction.
//
// The fix must not have broken the case that was already right.
func TestTheReadToolStillSaysReadImage(t *testing.T) {
	h := newSourceHarness(t,
		toolCallResponse("c1", "read_image", `{"path":"architecture.png"}`),
		textResponse("done"),
	)

	if _, err := h.agent.RunMessages(context.Background(),
		[]map[string]any{{"role": "user", "content": "看下图"}}); err != nil {
		t.Fatalf("run: %v", err)
	}

	artifacts := h.store.All()
	if len(artifacts) == 0 {
		t.Fatal("no artifact was stored")
	}
	original := findOriginal(artifacts)
	if original == nil {
		t.Fatal("no original artifact was stored")
	}
	if original.Source.Tool != "read_image" {
		t.Errorf("the artifact says it came from %q, want read_image",
			original.Source.Tool)
	}
}

// findOriginal picks the original out of a store's contents.
//
// The store keeps the picture and — when one is worth making — a thumbnail of
// it. The thumbnail is a separate artifact with the same source, so a test that
// looks at "the artifacts" without telling them apart sees two and concludes
// something is wrong.
func findOriginal(artifacts []ctxwin.Artifact) *ctxwin.Artifact {
	for index := range artifacts {
		if artifacts[index].MetadataString("variant") == "thumbnail" {
			continue
		}
		return &artifacts[index]
	}
	return nil
}
