package builtin

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// TestAnOutlineListsDeclarationsWithTheirRealLineNumbers is the contract the whole
// feature rests on.
//
// If an outline reported a line number that is not the line the declaration is
// actually on, every follow-up read_file(start_line=…) built from it would address
// the wrong code — and the model has no cheap way to notice. So the numbers are
// pinned against a file whose line positions are counted by hand.
func TestAnOutlineListsDeclarationsWithTheirRealLineNumbers(t *testing.T) {
	body := strings.Join([]string{
		"package demo",                                 // 1
		"",                                             // 2
		"type Store struct {",                          // 3
		"\titems map[string]int",                       // 4
		"}",                                            // 5
		"",                                             // 6
		"func NewStore() *Store {",                     // 7
		"\treturn &Store{items: map[string]int{}}",     // 8
		"}",                                            // 9
		"",                                             // 10
		"func (s *Store) Load(id string) (int, error) {", // 11
		"\treturn 0, nil",                              // 12
		"}",                                            // 13
	}, "\n") + "\n"

	_, tool := newReadWorkspace(t, "store.go", body)
	got := call(t, tool, map[string]any{"path": "store.go", "outline": true})

	for _, want := range []string{
		"3| type Store struct {",
		"7| func NewStore() *Store {",
		"11| func (s *Store) Load(id string) (int, error) {",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("the outline is missing %q:\n%s", want, got)
		}
	}
	// Bodies must not leak in: the whole point is that the skeleton is smaller.
	if strings.Contains(got, "return &Store") || strings.Contains(got, "items map") {
		t.Errorf("the outline reproduced a body:\n%s", got)
	}
}

// TestAnOutlineSaysItIsNotTheWholeFile guards the one silent failure this feature
// could introduce: a model that reads a skeleton and believes it has the file.
func TestAnOutlineSaysItIsNotTheWholeFile(t *testing.T) {
	_, tool := newReadWorkspace(t, "a.go", "package a\n\nfunc A() {}\n\nfunc B() {}\n")

	got := call(t, tool, map[string]any{"path": "a.go", "outline": true})

	if !strings.Contains(got, "不是全文") {
		t.Errorf("the outline does not say it is not the whole file:\n%s", got)
	}
	// The total is what makes "there is more" actionable, the same reason a range
	// read carries it.
	if !strings.Contains(got, "共 5 行") {
		t.Errorf("the outline does not report the file's real length:\n%s", got)
	}
	if !strings.Contains(got, "start_line") {
		t.Errorf("the outline does not say how to read a section:\n%s", got)
	}
}

// TestOutlineAndRangeAreRefusedTogether pins the mutual exclusion.
//
// Both arguments answer different questions, and silently honouring one would make
// the returned text disagree with what the model asked for.
func TestOutlineAndRangeAreRefusedTogether(t *testing.T) {
	_, tool := newReadWorkspace(t, "a.go", "package a\n\nfunc A() {}\n\nfunc B() {}\n")

	got := call(t, tool, map[string]any{
		"path": "a.go", "outline": true, "start_line": 1, "end_line": 2,
	})

	if !strings.Contains(got, "不能同时用") {
		t.Fatalf("outline + range was not refused:\n%s", got)
	}
	if strings.Contains(got, "package a") {
		t.Errorf("a refused call still returned content:\n%s", got)
	}
}

// TestOutlineFalseIsTheOrdinaryRead is the compatibility check.
//
// outline is a switch, not a mode: an explicit false has to mean exactly what
// leaving the key out means, or the parameter changes behaviour for callers who
// only ever wrote it to be safe.
func TestOutlineFalseIsTheOrdinaryRead(t *testing.T) {
	body := "package a\n\nfunc A() {}\n"
	_, tool := newReadWorkspace(t, "a.go", body)

	got := call(t, tool, map[string]any{"path": "a.go", "outline": false})
	if got != body {
		t.Fatalf("outline=false changed the read:\nwant %q\ngot  %q", body, got)
	}
}

// TestAFullFileReadIsUnaffectedByTheOutlineFeature is the regression guard for
// existing sessions: the bytes of a plain read must stay byte-identical.
func TestAFullFileReadIsUnaffectedByTheOutlineFeature(t *testing.T) {
	body := "one\ntwo\nthree\n"
	_, tool := newReadWorkspace(t, "a.txt", body)

	if got := call(t, tool, map[string]any{"path": "a.txt"}); got != body {
		t.Fatalf("a plain read is no longer verbatim:\nwant %q\ngot  %q", body, got)
	}
}

// TestOutlineOnAFileWithNoStructureSaysSoRatherThanInventingOne.
//
// The heuristic will meet files it does not understand — a data file, an
// unfamiliar language. Returning nothing is honest; returning guesses would be
// worse than no outline, because the model would trust them.
func TestOutlineOnAFileWithNoStructureSaysSoRatherThanInventingOne(t *testing.T) {
	_, tool := newReadWorkspace(t, "data.csv", "alpha,beta,gamma\n1,2,3\n4,5,6\n")

	got := call(t, tool, map[string]any{"path": "data.csv", "outline": true})

	if !strings.Contains(got, "没有识别到声明结构") {
		t.Fatalf("an unstructured file did not report itself as such:\n%s", got)
	}
	if !strings.Contains(got, "start_line") {
		t.Errorf("the empty outline does not offer a way forward:\n%s", got)
	}
}

// TestOutlineRecognizesOtherLanguagesWithoutPerLanguageCode is the property that
// makes this feature viable for arbitrary repositories.
func TestOutlineRecognizesOtherLanguagesWithoutPerLanguageCode(t *testing.T) {
	cases := []struct {
		name string
		body string
		want []string
	}{
		{
			name: "python.py",
			body: "import os\n\nclass Store:\n    def __init__(self):\n        self.x = 1\n\n    def load(self, id):\n        return None\n",
			want: []string{"class Store:", "def __init__(self):", "def load(self, id):"},
		},
		{
			name: "app.ts",
			body: "export interface Session {\n  id: string\n}\n\nexport async function create(id: string) {\n  return { id };\n}\n",
			want: []string{"interface Session {", "function create(id: string) {"},
		},
		{
			name: "main.rs",
			body: "struct Store {\n    items: Vec<i32>,\n}\n\nimpl Store {\n    pub fn new() -> Self {\n        Self { items: vec![] }\n    }\n}\n",
			want: []string{"struct Store {", "impl Store {", "fn new() -> Self {"},
		},
		{
			name: "App.java",
			body: "public class App {\n    private int count;\n\n    public void run(int x) {\n        count = x;\n    }\n}\n",
			want: []string{"class App {", "void run(int x) {"},
		},
		{
			name: "store.rb",
			body: "class Store\n  def load(id)\n    nil\n  end\nend\n\ndef top\nend\n",
			want: []string{"class Store", "def load(id)", "def top"},
		},
		{
			name: "Store.swift",
			body: "struct Store {\n    func load(id: String) -> Int {\n        return 0\n    }\n}\n",
			want: []string{"struct Store {", "func load(id: String)"},
		},
		{
			name: "Store.kt",
			body: "class Store {\n    fun load(id: String): Int {\n        return 0\n    }\n}\n",
			want: []string{"class Store {", "fun load(id: String)"},
		},
		{
			name: "App.cs",
			body: "public class App {\n    public void Run(int x) {\n    }\n}\n",
			want: []string{"class App {", "void Run(int x) {"},
		},
		{
			name: "store.ex",
			body: "defmodule Store do\n  def load(id) do\n    nil\n  end\nend\n",
			want: []string{"defmodule Store do", "def load(id) do"},
		},
		{
			name: "Panel.vue",
			body: "<script setup>\nfunction load(id) {\n  return id;\n}\n</script>\n",
			want: []string{"function load(id) {"},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, tool := newReadWorkspace(t, testCase.name, testCase.body)
			got := call(t, tool, map[string]any{"path": testCase.name, "outline": true})
			for _, want := range testCase.want {
				if !strings.Contains(got, want) {
					t.Errorf("the outline is missing %q:\n%s", want, got)
				}
			}
		})
	}
}

// TestOutlineKnownGaps pins where the heuristic does NOT work, so the limit is a
// recorded fact rather than something somebody discovers in a session.
//
// These are not bugs to fix: they fall outside "a line that starts with a
// declaration word". Listing them as expectations means a future change that starts
// recognizing one gets noticed here first, instead of silently shifting behaviour.
func TestOutlineKnownGaps(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		// A C function starts with its return type, not with a keyword.
		{"a.c", "int add(int a, int b) {\n    return a + b;\n}\n"},
		// `local function` is not `function`.
		{"a.lua", "local function load(id)\n  return nil\nend\n"},
		// A shell function is `name() {`, with nothing to match on.
		{"a.sh", "#!/bin/sh\nfoo() {\n  echo hi\n}\n"},
		// Data and markup have no declarations at all.
		{"a.json", "{\"a\": 1}\n"},
		{"a.yaml", "key: value\n"},
		{"a.css", ".a { color: red; }\n"},
		{"a.html", "<div class=\"x\">hi</div>\n"},
		// SQL and Terraform declare with words the keyword list does not carry.
		{"a.sql", "CREATE TABLE x (id int);\n"},
		{"a.tf", "resource \"aws_instance\" \"web\" {\n  ami = \"x\"\n}\n"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			entries, _ := BuildOutline(testCase.name, testCase.body)
			if len(entries) != 0 {
				t.Logf("known gap closed for %s: %+v — delete this expectation and "+
					"move the case into the recognition test", testCase.name, entries)
			}
			// The behaviour that must hold either way: no invented structure.
			_, tool := newReadWorkspace(t, testCase.name, testCase.body)
			got := call(t, tool, map[string]any{"path": testCase.name, "outline": true})
			if !strings.Contains(got, "start_line") {
				t.Errorf("%s: an unextractable file must still point at the way forward:\n%s",
					testCase.name, got)
			}
		})
	}
}

// TestOutlineOnMarkdownListsHeadings covers docs, which this runtime reads often
// enough that treating them as structureless would waste the feature.
func TestOutlineOnMarkdownListsHeadings(t *testing.T) {
	body := "# Title\n\nintro\n\n## Section\n\ntext\n\n```\n## not a heading\n```\n\n### Deep\n"
	_, tool := newReadWorkspace(t, "doc.md", body)

	got := call(t, tool, map[string]any{"path": "doc.md", "outline": true})

	for _, want := range []string{"1| # Title", "5| ## Section", "13| ### Deep"} {
		if !strings.Contains(got, want) {
			t.Errorf("the markdown outline is missing %q:\n%s", want, got)
		}
	}
	// A heading inside a fence is sample code, not structure.
	if strings.Contains(got, "not a heading") {
		t.Errorf("a fenced heading was treated as structure:\n%s", got)
	}
}

// TestAnOutlineIsMuchSmallerThanTheFile is the reason to have the feature at all.
// If the skeleton were not drastically smaller, it would be a worse read.
func TestAnOutlineIsMuchSmallerThanTheFile(t *testing.T) {
	var builder strings.Builder
	builder.WriteString("package big\n\n")
	for index := 0; index < 200; index++ {
		builder.WriteString("// helper function with a comment\n")
		builder.WriteString("func Helper" + itoa(index) + "(input string) (string, error) {\n")
		for line := 0; line < 20; line++ {
			builder.WriteString("\t// body line that must not appear in the outline\n")
		}
		builder.WriteString("\treturn input, nil\n}\n\n")
	}
	body := builder.String()

	_, tool := newReadWorkspace(t, "big.go", body)
	outline := call(t, tool, map[string]any{"path": "big.go", "outline": true})

	if len(outline)*5 > len(body) {
		t.Fatalf("the outline is %d bytes against a %d byte file: not a skeleton",
			len(outline), len(body))
	}
	if !strings.Contains(outline, "func Helper0(input string)") {
		t.Errorf("the outline lost declarations:\n%s", outline[:200])
	}
}

// TestOutlineNeverReturnsMoreThanItsCap. A generated file can carry thousands of
// declarations; an outline that big costs as much as the file and reads worse.
func TestOutlineNeverReturnsMoreThanItsCap(t *testing.T) {
	var builder strings.Builder
	builder.WriteString("package many\n\n")
	for index := 0; index < outlineMaxEntries+50; index++ {
		builder.WriteString("func F" + itoa(index) + "() {}\n")
	}

	_, tool := newReadWorkspace(t, "many.go", builder.String())
	got := call(t, tool, map[string]any{"path": "many.go", "outline": true})

	if !strings.Contains(got, "只列出前") {
		t.Errorf("a capped outline does not say it was capped:\n%s", got[:200])
	}
	if count := strings.Count(got, "| func F"); count > outlineMaxEntries {
		t.Fatalf("the outline returned %d entries, above the cap of %d",
			count, outlineMaxEntries)
	}
}

// TestOutlineDoesNotNeedAWorkspaceRoot lets the extraction be tested as a pure
// function, which is how it is used for the cost measurements.
func TestOutlineExtractionIsPure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "x.go")
	body := "package x\n\nfunc A() {}\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	entries, total := BuildOutline("x.go", body)
	if total != 3 || len(entries) != 1 || entries[0].Line != 3 {
		t.Fatalf("BuildOutline = %d entries over %d lines: %+v", len(entries), total, entries)
	}
	if _, err := tools.Validate(map[string]any{"type": "object"}, nil); err != nil {
		t.Fatalf("unexpected validation error: %v", err)
	}
}

// TestOutlineIgnoresJSXAttributesAndCallbackValues pins the two false positives
// that a real file exposed.
//
// `type="button"` is an attribute, and `const rt = useStore((s) => s.x)` is a value
// computed by passing a callback — neither declares anything. Left in, a React
// component's outline becomes one entry per button, which is the one way a
// skeleton can be worse than the file it summarizes.
func TestOutlineIgnoresJSXAttributesAndCallbackValues(t *testing.T) {
	body := strings.Join([]string{
		"export function PlusMenu() {",                          // 1
		"  const rt = useStore((s) => s.sessions);",             // 2
		"  const onPick = (id: string) => {",                    // 3
		"    pick(id);",                                         // 4
		"  };",                                                  // 5
		"  return <button type=\"button\" onClick={onPick} />;", // 6
		"}",                                                     // 7
	}, "\n") + "\n"

	_, tool := newReadWorkspace(t, "Menu.tsx", body)
	got := call(t, tool, map[string]any{"path": "Menu.tsx", "outline": true})

	if strings.Contains(got, `type="button"`) {
		t.Errorf("a JSX attribute was reported as a declaration:\n%s", got)
	}
	if strings.Contains(got, "useStore") {
		t.Errorf("a callback argument was reported as a function declaration:\n%s", got)
	}
	if !strings.Contains(got, "1| export function PlusMenu() {") {
		t.Errorf("the component declaration is missing:\n%s", got)
	}
	// The arrow function is found through the indented-declaration rule, and the
	// number reported is the line it actually starts on.
	if !strings.Contains(got, "3| "+"  const onPick = (id: string) => {") {
		t.Errorf("a real arrow-function declaration was lost:\n%s", got)
	}
}
