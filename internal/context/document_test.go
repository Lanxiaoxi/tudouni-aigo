package context

import (
	"strings"
	"testing"
)

// A read_document result is a document's rewritten Markdown, and it must survive the context
// ladder as such: typed `document` (so a line range is never mistaken for a range of the
// .docx), carrying which part it is, and still saying so once it degrades to a metadata line.

func documentExecution(pages string) ToolExecution {
	args := map[string]any{"path": "docs/spec.pptx"}
	if pages != "" {
		args["pages"] = pages
	}
	return ToolExecution{
		Tool:      "read_document",
		Arguments: args,
		Text:      "[read_document] docs/spec.pptx · pptx\n\n" + bigText(60),
		Status:    "ok",
	}
}

func TestADocumentResultIsTypedDocumentAndRemembersWhichPart(t *testing.T) {
	h := newHarness(t, nil)
	artifacts, err := DefaultProcessor().Process(h.store, documentExecution("3-5"))
	if err != nil {
		t.Fatal(err)
	}
	artifact := artifacts[0]
	if artifact.Type != "document" {
		t.Errorf("type = %q, want document", artifact.Type)
	}
	if artifact.Metadata["pages"] != "3-5" || artifact.Metadata["path"] != "docs/spec.pptx" {
		t.Errorf("metadata = %v", artifact.Metadata)
	}
	if artifact.Source.Tool != "read_document" {
		t.Errorf("source = %+v", artifact.Source)
	}
}

func TestTwoPartsOfOneDocumentAreTwoArtifacts(t *testing.T) {
	h := newHarness(t, nil)
	processor := DefaultProcessor()
	first, _ := processor.Process(h.store, documentExecution("1-2"))
	exec := documentExecution("8-9")
	exec.Text += "\nsecond part"
	second, _ := processor.Process(h.store, exec)
	if first[0].ID == second[0].ID {
		t.Fatalf("two different parts collapsed into %s", first[0].ID)
	}
}

func TestADegradedDocumentStillSaysWhichPartItWas(t *testing.T) {
	h := newHarness(t, nil)
	artifacts, err := DefaultProcessor().Process(h.store, documentExecution("3-5"))
	if err != nil {
		t.Fatal(err)
	}
	line := h.renderer.MetadataLine(artifacts[0])
	for _, want := range []string{"read_document", "docs/spec.pptx", "页=3-5"} {
		if !strings.Contains(line, want) {
			t.Errorf("metadata line lacks %q: %s", want, line)
		}
	}

	preview := h.renderer.RenderArtifact(artifacts[0], RepresentationPreview, nil).Text
	if !strings.Contains(preview, "docs/spec.pptx 页 3-5") {
		t.Errorf("the preview header does not name the part: %q", firstLine(preview))
	}
}

func TestTheContinuationRecipeSurvivesThePreviewLevel(t *testing.T) {
	// The tool puts the recipe on the first lines because the preview keeps the top of an
	// artifact; this pins the assumption that makes that placement correct.
	h := newHarness(t, nil)
	body := "[read_document] a.docx · docx\n[续读] 还没读完。再调用 read_document(path=\"a.docx\", cursor=\"1:900\")\n\n" + bigText(300)
	artifact, err := h.store.Create(body, "document", ArtifactSource{Tool: "read_document", Path: "a.docx"},
		map[string]any{"path": "a.docx", "lines": CountLines(body)})
	if err != nil {
		t.Fatal(err)
	}
	preview := h.renderer.RenderArtifact(artifact, RepresentationPreview, nil).Text
	if !strings.Contains(preview, `cursor="1:900"`) {
		t.Errorf("the preview dropped the continuation recipe:\n%s", firstLine(preview))
	}
	if len(preview) >= len(body)/2 {
		t.Errorf("the preview did not shrink the body (%d of %d)", len(preview), len(body))
	}
}

func TestADocumentReferenceLineNamesTheTool(t *testing.T) {
	line := BuildReference("art_0123456789ab", 5000, "read_document")
	if !strings.Contains(line, "read_document") || ParseReference(line) != "art_0123456789ab" {
		t.Errorf("reference = %q", line)
	}
}

func TestAWholeDocumentReadInventsNoPageRange(t *testing.T) {
	h := newHarness(t, nil)
	artifacts, _ := DefaultProcessor().Process(h.store, documentExecution(""))
	preview := h.renderer.RenderArtifact(artifacts[0], RepresentationPreview, nil).Text
	if strings.Contains(preview, "页 ") {
		t.Errorf("a whole-document read invented a page range: %q", firstLine(preview))
	}
}
