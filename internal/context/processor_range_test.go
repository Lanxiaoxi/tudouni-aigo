package context

import (
	"strings"
	"testing"
)

// The interval a ranged read carries has to survive into the Artifact's metadata.
//
// History stores a reference line, `[artifact art_x · 1200 字符 · read_file]`, which
// names the size and the tool and **nothing about which part of the file was read**.
// Two reads of one file — line 10-19 and line 900-990 — therefore look identical in
// the session file, and the compaction skeleton, which keeps only that line, cannot
// tell them apart either.
//
// The interval travels out on the tool's audit fields, and this is the link that has
// to hold: a tool's audit is copied into the artifact's metadata, so a fact only the
// tool knew becomes a fact recorded beside the body.
func TestTheReadIntervalReachesTheArtifactMetadata(t *testing.T) {
	h := newHarness(t, nil)

	body := bigText(20)
	execution := ToolExecution{
		Tool:      "read_file",
		Arguments: map[string]any{"path": "a.txt", "start_line": 10, "end_line": 19},
		Text:      body,
		Status:    "ok",
		Audit: map[string]any{
			"start_line":  10,
			"end_line":    19,
			"total_lines": 1185,
		},
	}

	artifacts, err := DefaultProcessor().Process(h.store, execution)
	if err != nil {
		t.Fatal(err)
	}
	if len(artifacts) == 0 {
		t.Fatal("no artifact was produced")
	}
	metadata := artifacts[0].Metadata

	if asInt(metadata["start_line"]) != 10 || asInt(metadata["end_line"]) != 19 {
		t.Fatalf("the interval did not reach the metadata: %v", metadata)
	}
	// The file's own length is what makes "this was a slice" readable afterwards; it
	// is a different number from the body's, which is the point of recording both.
	if asInt(metadata["total_lines"]) != 1185 {
		t.Fatalf("the file's total did not reach the metadata: %v", metadata)
	}
	// `lines` stays the **body's** count, because that is the measure the degradation
	// window is computed against: the artifact holds the slice, not the file.
	if asInt(metadata["lines"]) != CountLines(body) {
		t.Fatalf("lines is %v, want the body's own count %d", metadata["lines"], CountLines(body))
	}
	if metadata["path"] != "a.txt" {
		t.Fatalf("the path was lost: %v", metadata["path"])
	}
}

// A whole-file read records no interval, so "was this read a slice" stays answerable
// from the metadata alone. Without that, every read would look like a range and the
// question the interval exists to answer would have no answer.
func TestAWholeFileReadRecordsNoInterval(t *testing.T) {
	h := newHarness(t, nil)

	artifacts, err := DefaultProcessor().Process(h.store, ToolExecution{
		Tool:      "read_file",
		Arguments: map[string]any{"path": "a.txt"},
		Text:      bigText(20),
		Status:    "ok",
		Audit:     map[string]any{"chars": 100},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, present := artifacts[0].Metadata["start_line"]; present {
		t.Fatalf("a whole-file read recorded a range: %v", artifacts[0].Metadata)
	}
}

// The metadata level is one line, and the fields on it are chosen sparingly, so the
// interval is deliberately **not** rendered there — it stays a fact about the body
// rather than a label on the line. This pins that choice so it is not undone by
// accident: the metadata line growing three more fields is a per-round cost on every
// degraded artifact in the session.
func TestTheMetadataLineDoesNotGrowTheInterval(t *testing.T) {
	h := newHarness(t, nil)

	artifacts, err := DefaultProcessor().Process(h.store, ToolExecution{
		Tool:      "read_file",
		Arguments: map[string]any{"path": "a.txt", "start_line": 10, "end_line": 19},
		Text:      bigText(10),
		Status:    "ok",
		Audit:     map[string]any{"start_line": 10, "end_line": 19, "total_lines": 1185},
	})
	if err != nil {
		t.Fatal(err)
	}

	line := h.renderer.MetadataLine(artifacts[0])
	if strings.Contains(line, "start_line") || strings.Contains(line, "total_lines") {
		t.Fatalf("the metadata line grew the interval fields: %q", line)
	}
	if !strings.Contains(line, "路径=a.txt") {
		t.Fatalf("the metadata line lost the path: %q", line)
	}
}
