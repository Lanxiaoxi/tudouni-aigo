package builtin

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// newReadWorkspace makes a workspace with one file in it.
func newReadWorkspace(t *testing.T, name, body string) (*tools.Workspace, tools.Tool) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	workspace, err := tools.NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range NewFileTools(workspace) {
		if tool.Name == "read_file" {
			return workspace, tool
		}
	}
	t.Fatal("read_file is not registered")
	return nil, tools.Tool{}
}

// call runs read_file the way the agent does, through the schema, so defaults and
// coercion are exercised rather than assumed.
func call(t *testing.T, tool tools.Tool, arguments map[string]any) string {
	t.Helper()
	validated, err := tools.Validate(tool.Parameters(), arguments)
	if err != nil {
		t.Fatalf("the arguments do not validate: %v", err)
	}
	result, err := tool.Execute(context.Background(), validated)
	if err != nil {
		t.Fatalf("read_file returned an error: %v", err)
	}
	return result.Text
}

// TestAReadWithoutBoundsReturnsTheBytesVerbatim is the compatibility contract.
//
// A full-level artifact is rendered with no additions, so if the tool starts
// decorating the whole-file answer — a header, a line count, normalised endings —
// then every read in every session changes shape at once, and a session written
// before these parameters existed comes back through a different path than the one
// that wrote it. The body has to be the file's own bytes, exactly.
func TestAReadWithoutBoundsReturnsTheBytesVerbatim(t *testing.T) {
	body := "one\ntwo\nthree\n"
	_, tool := newReadWorkspace(t, "a.txt", body)

	got := call(t, tool, map[string]any{"path": "a.txt"})
	if got != body {
		t.Fatalf("the whole-file read was not verbatim:\nwant %q\ngot  %q", body, got)
	}
}

// TestARangeReadReturnsExactlyThoseLines pins the numbering: 1-based and inclusive
// on both ends, which is what grep prints and what the range level renders with.
//
// If either end were exclusive, a line number copied out of a grep result would
// silently address a neighbour — the model would read the line before the hit and
// have no way to tell.
func TestARangeReadReturnsExactlyThoseLines(t *testing.T) {
	_, tool := newReadWorkspace(t, "a.txt", "one\ntwo\nthree\nfour\nfive\n")

	got := call(t, tool, map[string]any{"path": "a.txt", "start_line": 2, "end_line": 4})

	if !strings.Contains(got, "two\nthree\nfour\n") {
		t.Fatalf("the interval is not 2..4 inclusive:\n%s", got)
	}
	if strings.Contains(got, "one") || strings.Contains(got, "five") {
		t.Fatalf("the slice ran past its bounds:\n%s", got)
	}
}

// TestARangeReadSaysHowMuchItDidNotShow is the one failure this layer exists to
// prevent: half the content presented as all of it.
//
// The interval and the file's real length both have to be in the text, because that
// is the only thing the model reads. Nothing downstream adds them for a full-level
// render.
func TestARangeReadSaysHowMuchItDidNotShow(t *testing.T) {
	lines := make([]string, 100)
	for index := range lines {
		lines[index] = "line"
	}
	_, tool := newReadWorkspace(t, "a.txt", strings.Join(lines, "\n")+"\n")

	got := call(t, tool, map[string]any{"path": "a.txt", "start_line": 10, "end_line": 19})

	if !strings.Contains(got, "10-19") {
		t.Errorf("the header does not state the interval:\n%s", got)
	}
	if !strings.Contains(got, "100") {
		t.Errorf("the header does not state the file's total:\n%s", got)
	}
}

// TestOneSidedBoundsTakeWhatTheyMean: the two bounds are independent, and leaving one
// out means "from the start" or "to the end" rather than "no range at all".
func TestOneSidedBoundsTakeWhatTheyMean(t *testing.T) {
	_, tool := newReadWorkspace(t, "a.txt", "one\ntwo\nthree\nfour\n")

	head := call(t, tool, map[string]any{"path": "a.txt", "end_line": 2})
	if !strings.Contains(head, "one\ntwo\n") || strings.Contains(head, "three") {
		t.Fatalf("end_line alone did not mean 1..2:\n%s", head)
	}

	tail := call(t, tool, map[string]any{"path": "a.txt", "start_line": 3})
	if !strings.Contains(tail, "three\nfour\n") || strings.Contains(tail, "two") {
		t.Fatalf("start_line alone did not mean 3..end:\n%s", tail)
	}
}

// TestBoundsPastTheEndAreClampedAndSaid: an interval that runs off the file is the
// common case when a model guesses a little long, and the answer has to be the lines
// that exist rather than an error or an empty body.
func TestBoundsPastTheEndAreClampedAndSaid(t *testing.T) {
	_, tool := newReadWorkspace(t, "a.txt", "one\ntwo\nthree\n")

	got := call(t, tool, map[string]any{"path": "a.txt", "start_line": 2, "end_line": 999})

	if !strings.Contains(got, "two\nthree\n") {
		t.Fatalf("the interval was not clamped to the file's end:\n%s", got)
	}
	if !strings.Contains(got, "2-3") || !strings.Contains(got, "共 3 行") {
		t.Fatalf("the header does not report the interval actually returned:\n%s", got)
	}
}

// TestAStartPastTheEndIsAnsweredWithTheLength, not with an empty body.
//
// An empty body is indistinguishable from "this file has no content" — a wrong
// conclusion that sends the model off to find a different file. Saying how long the
// file is lets it correct the number it guessed.
func TestAStartPastTheEndIsAnsweredWithTheLength(t *testing.T) {
	_, tool := newReadWorkspace(t, "a.txt", "one\ntwo\nthree\n")

	got := call(t, tool, map[string]any{"path": "a.txt", "start_line": 900})

	if !strings.Contains(got, "3 行") {
		t.Fatalf("the refusal does not state the file's length:\n%s", got)
	}
	if strings.Contains(got, "one") {
		t.Fatalf("a start past the end returned body content:\n%s", got)
	}
}

// TestLinesAreNumberedTheWayGrepNumbersThem, on a CRLF file.
//
// A CRLF file split naively on "\n" leaves a stray "\r" at the end of every line, and
// splitting on "\r\n" as well would be worse in the other direction: an LF file's
// numbering must not move either. Splitting on "\n" alone is what keeps one rule for
// both, and keeping each line's own terminator is what lets a slice be pasted back
// into edit_file without rewriting the whole file's endings.
func TestLinesAreNumberedTheWayGrepNumbersThem(t *testing.T) {
	_, tool := newReadWorkspace(t, "a.txt", "one\r\ntwo\r\nthree\r\nfour\r\n")

	got := call(t, tool, map[string]any{"path": "a.txt", "start_line": 2, "end_line": 3})

	if !strings.Contains(got, "two\r\nthree\r\n") {
		t.Fatalf("the slice lost the file's own line endings:\n%q", got)
	}
	if !strings.Contains(got, "共 4 行") {
		t.Fatalf("a CRLF file was counted as the wrong number of lines:\n%q", got)
	}
}

// TestBackwardsBoundsAreRefusedInWords: start after end cannot be clamped into
// anything sensible, so it is named as the mistake it is rather than returning an
// empty body the model would read as an empty region.
func TestBackwardsBoundsAreRefusedInWords(t *testing.T) {
	_, tool := newReadWorkspace(t, "a.txt", "one\ntwo\nthree\n")

	got := call(t, tool, map[string]any{"path": "a.txt", "start_line": 3, "end_line": 2})

	if !strings.Contains(got, "end_line") {
		t.Fatalf("the message does not name the argument at fault:\n%s", got)
	}
	if strings.Contains(got, "three") {
		t.Fatalf("a backwards interval returned body content:\n%s", got)
	}
}

// TestAnEmptyFileWithBoundsSaysSo: zero lines is a fact, not a missing body.
func TestAnEmptyFileWithBoundsSaysSo(t *testing.T) {
	_, tool := newReadWorkspace(t, "a.txt", "")

	got := call(t, tool, map[string]any{"path": "a.txt", "start_line": 1, "end_line": 10})

	if !strings.Contains(got, "空") {
		t.Fatalf("an empty file was not reported as empty:\n%s", got)
	}
}

// TestTheBoundsAreOptionalAndBoundedByTheSchema pins the schema contract the handler
// depends on: neither bound has a default.
//
// A default would be filled in by the validator, and then the handler could no longer
// tell "the model asked for the whole file" from "the model asked for 1..the end" —
// which is exactly the distinction that decides whether a header is added. Zero is
// also rejected rather than treated as "unset": a line number of 0 is not a range.
func TestTheBoundsAreOptionalAndBoundedByTheSchema(t *testing.T) {
	_, tool := newReadWorkspace(t, "a.txt", "one\ntwo\n")

	validated, err := tools.Validate(tool.Parameters(), map[string]any{"path": "a.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if _, present := validated["start_line"]; present {
		t.Errorf("start_line was filled in with a default: %v", validated["start_line"])
	}
	if _, present := validated["end_line"]; present {
		t.Errorf("end_line was filled in with a default: %v", validated["end_line"])
	}

	for _, bad := range []any{0, -3} {
		if _, err := tools.Validate(tool.Parameters(),
			map[string]any{"path": "a.txt", "start_line": bad}); err == nil {
			t.Errorf("start_line=%v was accepted; line numbers are 1-based", bad)
		}
	}
	// The same call through the tool reports it as invalid arguments, which is the
	// path the model actually experiences.
	if _, err := tool.Execute(context.Background(), map[string]any{"path": "a.txt", "end_line": 0}); err == nil {
		t.Error("end_line=0 reached the handler")
	}
}

// TestTheIntervalReachesTheAudit is what carries the range into the artifact's
// metadata.
//
// The reference line in history names the size and the tool and nothing about which
// part was read, so two reads of one file are indistinguishable after the fact
// unless the interval travels out with the result. The agent copies a tool's audit
// fields into the artifact, which is why they are set here rather than described in
// the text alone.
func TestTheIntervalReachesTheAudit(t *testing.T) {
	_, tool := newReadWorkspace(t, "a.txt", "one\ntwo\nthree\nfour\nfive\n")

	validated, err := tools.Validate(tool.Parameters(),
		map[string]any{"path": "a.txt", "start_line": 2, "end_line": 4})
	if err != nil {
		t.Fatal(err)
	}
	result, err := tool.Execute(context.Background(), validated)
	if err != nil {
		t.Fatal(err)
	}

	if result.Audit["start_line"] != 2 || result.Audit["end_line"] != 4 || result.Audit["total_lines"] != 5 {
		t.Fatalf("the interval did not reach the audit: %v", result.Audit)
	}

	// A whole-file read records no interval, so "was this a slice" stays answerable.
	whole, err := tool.Execute(context.Background(), map[string]any{"path": "a.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if _, present := whole.Audit["start_line"]; present {
		t.Errorf("a whole-file read recorded a range: %v", whole.Audit)
	}
}

// TestARangeReadIsStillLowRiskAndParallelSafe: the range arguments do not widen what
// this tool can reach.
//
// It is still one file inside the workspace, so it stays in the band that needs no
// approval and may run alongside other reads. Moving it out of that band because it
// grew two integers would make every ranged read in a batch prompt separately.
func TestARangeReadIsStillLowRiskAndParallelSafe(t *testing.T) {
	_, tool := newReadWorkspace(t, "a.txt", "one\n")

	if !tool.ParallelSafe {
		t.Error("read_file lost its parallel-safe marking")
	}
	if string(tool.Risk) != "low" {
		t.Errorf("read_file risk is now %q", tool.Risk)
	}
}

// TestARangePastTheEndOfATrailingNewlineFile: the last line is not counted twice.
//
// "a\nb\n" is two lines. Counting the empty element after the final newline would
// make it three, and every line number the model quoted back would be one out — the
// same off-by-one the context store's own splitter documents.
func TestARangePastTheEndOfATrailingNewlineFile(t *testing.T) {
	_, tool := newReadWorkspace(t, "a.txt", "a\nb\n")

	got := call(t, tool, map[string]any{"path": "a.txt", "start_line": 1, "end_line": 10})

	if !strings.Contains(got, "共 2 行") {
		t.Fatalf("a trailing newline added a phantom line:\n%q", got)
	}
	if !strings.Contains(got, "1-2") {
		t.Fatalf("the interval was not clamped to two lines:\n%q", got)
	}
}

// --- The size ceilings. They live on the read_file and edit_file handlers,
// and the files involved are over maxWholeReadBytes, which newReadWorkspace's
// small-file helper is not built for.

// bigBody builds text just over maxWholeReadBytes, one deterministic line per
// repeat. The line count is derived from the body's own length, never from a
// remembered width — counting that width by eye is how the first version of
// these tests got the expected totals wrong.
func bigBody(t *testing.T) (body string, lines int) {
	t.Helper()
	unit := "x0123456789abcd\n"
	if len(unit) != 16 {
		t.Fatalf("the unit's width changed: %d bytes", len(unit))
	}
	count := maxWholeReadBytes/len(unit) + 1
	return strings.Repeat(unit, count), count
}

// bigWorkspace makes a workspace holding one file just over the whole-read
// ceiling and returns both the read_file and the edit_file tools.
func bigWorkspace(t *testing.T, name, body string) (*tools.Workspace, tools.Tool, tools.Tool) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	workspace, err := tools.NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	var read, edit tools.Tool
	for _, tool := range NewFileTools(workspace) {
		switch tool.Name {
		case "read_file":
			read = tool
		case "edit_file":
			edit = tool
		}
	}
	if read.Name == "" || edit.Name == "" {
		t.Fatal("read_file and edit_file are not registered")
	}
	return workspace, read, edit
}

// TestAWholeReadOverTheCeilingIsRefusedWithTheWayOut: the refusal is the
// whole point of the ceiling, and the message has to hand the model the one
// path that does work — grep, then a bounded read. A bare "too big" sends the
// model retrying the same call.
func TestAWholeReadOverTheCeilingIsRefusedWithTheWayOut(t *testing.T) {
	body, _ := bigBody(t)
	_, read, _ := bigWorkspace(t, "big.txt", body)

	got := call(t, read, map[string]any{"path": "big.txt"})

	if strings.Contains(got, "x0123456789abcd") {
		t.Fatalf("an over-ceiling whole read returned body:\n%q", got)
	}
	if !strings.Contains(got, "grep") {
		t.Errorf("the refusal does not point at grep:\n%q", got)
	}
	if !strings.Contains(got, "start_line") {
		t.Errorf("the refusal does not point at a bounded read:\n%q", got)
	}
}

// TestARangedReadOfABigFileStreams: the file is too big to hold, but the
// interval the model asked for is small, and that is exactly the case the
// streaming path exists for. The content, the header's interval, and the
// file's true line count all have to come out right — the count is the part
// only a pass over the whole file can know.
func TestARangedReadOfABigFileStreams(t *testing.T) {
	body, lines := bigBody(t)
	_, read, _ := bigWorkspace(t, "big.txt", body)

	got := call(t, read, map[string]any{"path": "big.txt", "start_line": lines - 2, "end_line": lines})

	for _, want := range []string{
		"x0123456789abcd",                 // the content itself
		fmt.Sprintf("第 %d-%d 行", lines-2, lines),
		fmt.Sprintf("共 %d 行", lines),
	} {
		if !strings.Contains(got, want) {
			t.Errorf("the streamed read is missing %q:\n%q", want, got)
		}
	}
	// Only three lines are in the answer, not the whole file.
	if count := strings.Count(got, "x0123456789abcd"); count != 3 {
		t.Errorf("the interval returned %d lines, want 3:\n%q", count, got)
	}
}

// TestASingleLineFileCannotEscapeTheRangeCap: a 17MB file with no newline is
// one line, so start_line=1, end_line=1 asks for the whole file inside a
// range read. The cap has to refuse it — this is the hole the cap exists to
// close, and a pass that collects everything first would fail by returning
// 17MB.
func TestASingleLineFileCannotEscapeTheRangeCap(t *testing.T) {
	body := strings.Repeat("y", maxWholeReadBytes+1024)
	_, read, _ := bigWorkspace(t, "oneline.txt", body)

	got := call(t, read, map[string]any{"path": "oneline.txt", "start_line": 1, "end_line": 1})

	if strings.Contains(got, "y") {
		t.Fatalf("an over-cap interval returned body:\n%q", got)
	}
	if !strings.Contains(got, "区间上限") {
		t.Errorf("the refusal does not name the interval cap:\n%q", got)
	}
}

// TestASmallIntervalInASingleLineFileStillReads: the cap refuses the whole
// line, not ranges of lines. A two-line file whose first line is huge must
// still answer a read of the second line — the common "skip the minified blob
// and read the manifest" shape.
func TestASmallIntervalInASingleLineFileStillReads(t *testing.T) {
	body := strings.Repeat("y", maxWholeReadBytes+1024) + "\nmanifest line\n"
	_, read, _ := bigWorkspace(t, "oneline.txt", body)

	got := call(t, read, map[string]any{"path": "oneline.txt", "start_line": 2, "end_line": 2})

	if !strings.Contains(got, "manifest line") {
		t.Fatalf("the small interval was not returned:\n%q", got)
	}
	if !strings.Contains(got, "共 2 行") {
		t.Errorf("the total is wrong for a one-huge-line file:\n%q", got)
	}
}

// TestACRLFBigFileKeepsGrepNumbering: the streamed pass must count lines the
// way readRange's splitter does — a "\r" stays inside the line it belongs to
// and never becomes a line of its own, or every line number the model copies
// from grep is off by as much as the file has lines.
func TestACRLFBigFileKeepsGrepNumbering(t *testing.T) {
	unit := "x0123456789abcd\r\n"
	if len(unit) != 17 {
		t.Fatalf("the unit's width changed: %d bytes", len(unit))
	}
	count := maxWholeReadBytes/len(unit) + 1
	body := strings.Repeat(unit, count)
	_, read, _ := bigWorkspace(t, "bigcrlf.txt", body)

	got := call(t, read, map[string]any{"path": "bigcrlf.txt", "start_line": 5, "end_line": 6})

	if !strings.Contains(got, "x0123456789abcd\r\nx0123456789abcd\r\n") {
		t.Fatalf("the CRLF lines lost their own endings:\n%q", got)
	}
	if !strings.Contains(got, fmt.Sprintf("共 %d 行", count)) {
		t.Errorf("a CRLF file was counted the wrong number of lines:\n%q", got)
	}
}

// TestAnEditOfABigFileIsRefused: an edit must hold the full text to replace
// in it, so the ceiling applies with no streaming escape — and the refusal
// says why, so the model does not retry with different old_string values.
func TestAnEditOfABigFileIsRefused(t *testing.T) {
	body, _ := bigBody(t)
	workspace, _, edit := bigWorkspace(t, "big.txt", body)

	validated, err := tools.Validate(edit.Parameters(), map[string]any{
		"path":       "big.txt",
		"old_string": "x0123456789abcd",
		"new_string": "z0123456789abcd",
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := edit.Execute(context.Background(), validated)
	if err != nil {
		t.Fatalf("the refusal came back as an error: %v", err)
	}
	if !strings.Contains(result.Text, "编辑上限") {
		t.Fatalf("the edit refusal does not name the ceiling:\n%q", result.Text)
	}
	// The file is untouched.
	raw, _ := os.ReadFile(filepath.Join(workspace.Root(), "big.txt"))
	if string(raw) != body {
		t.Fatal("a refused edit modified the file")
	}
}
