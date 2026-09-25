package builtin

import (
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
	result, err := tool.Execute(validated)
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
	if _, err := tool.Execute(map[string]any{"path": "a.txt", "end_line": 0}); err == nil {
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
	result, err := tool.Execute(validated)
	if err != nil {
		t.Fatal(err)
	}

	if result.Audit["start_line"] != 2 || result.Audit["end_line"] != 4 || result.Audit["total_lines"] != 5 {
		t.Fatalf("the interval did not reach the audit: %v", result.Audit)
	}

	// A whole-file read records no interval, so "was this a slice" stays answerable.
	whole, err := tool.Execute(map[string]any{"path": "a.txt"})
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
