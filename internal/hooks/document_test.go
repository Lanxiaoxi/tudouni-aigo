package hooks

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func intPtr(value int) *int { return &value }

func boolPtr(value bool) *bool { return &value }

func hooksPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "nested", "hooks.json")
}

func mustSave(t *testing.T, path, revision string, doc Document) *File {
	t.Helper()
	saved, err := Save(path, revision, doc)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	return saved
}

// --- reading ----------------------------------------------------------------

func TestReadingAMissingFileIsAnEmptyDocument(t *testing.T) {
	file, err := ReadFile(hooksPath(t))
	if err != nil {
		t.Fatalf("a missing file is the ordinary state, got %v", err)
	}
	if file.Exists || file.Revision != "" || len(file.Doc.Entries) != 0 || file.Set != nil {
		t.Fatalf("file = %+v, want empty and absent", file)
	}
}

func TestReadingABrokenFileKeepsItsIdentity(t *testing.T) {
	// The caller must be able to say which file is broken and still refuse to overwrite
	// it, so the File comes back populated alongside the error.
	path := hooksPath(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"hooks":{"pre_tool_use":[{"name":"x"}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := ReadFile(path)
	if err == nil {
		t.Fatal("a hook with no command was accepted")
	}
	if file == nil || !file.Exists || file.Revision == "" || file.Path != path {
		t.Fatalf("file = %+v, want path, existence and revision", file)
	}
}

// --- saving -----------------------------------------------------------------

func TestSaveCreatesTheFileAndItReadsBack(t *testing.T) {
	path := hooksPath(t)
	doc := Document{Entries: []Entry{
		{Event: "pre_tool_use", Name: "guard", Matcher: "^shell$", Argv: []string{"python", "C:/h/guard.py"},
			TimeoutMs: intPtr(2000), FailClosed: boolPtr(true), Enabled: true, StatusMessage: "checking"},
		{Event: "stop", Name: "verify", Line: "go test ./...", Enabled: false},
	}}
	saved := mustSave(t, path, "", doc)
	if saved.Revision == "" || saved.Set == nil || saved.Set.Len() != 1 {
		t.Fatalf("saved = %+v, want a revision and one enabled hook", saved)
	}

	read, err := ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if read.Revision != saved.Revision {
		t.Fatalf("revision %q after reading, %q after saving: one set of bytes, one identity", read.Revision, saved.Revision)
	}
	if len(read.Doc.Entries) != 2 {
		t.Fatalf("entries = %+v", read.Doc.Entries)
	}
	guard := read.Doc.Entries[0]
	if guard.Name != "guard" || guard.Matcher != "^shell$" || len(guard.Argv) != 2 || guard.Line != "" {
		t.Fatalf("guard = %+v, want the list spelling preserved", guard)
	}
	if guard.TimeoutMs == nil || *guard.TimeoutMs != 2000 || guard.FailClosed == nil || !*guard.FailClosed {
		t.Fatalf("guard = %+v, want its explicit settings preserved", guard)
	}
	verify := read.Doc.Entries[1]
	if verify.Line != "go test ./..." || len(verify.Argv) != 0 || verify.Enabled {
		t.Fatalf("verify = %+v, want the string spelling and enabled=false preserved", verify)
	}
	if verify.TimeoutMs != nil || verify.FailClosed != nil {
		t.Fatalf("verify = %+v: settings the person did not write must stay unwritten, or they pin a default", verify)
	}
}

func TestSavingWithoutChangesProducesTheSameBytes(t *testing.T) {
	path := hooksPath(t)
	doc := Document{Entries: []Entry{
		{Event: "post_tool_use", Name: "b", Argv: []string{"node", "b.mjs"}, Enabled: true},
		{Event: "pre_tool_use", Name: "a", Argv: []string{"node", "a.mjs"}, Enabled: true},
	}}
	first := mustSave(t, path, "", doc)
	read, err := ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	second := mustSave(t, path, first.Revision, read.Doc)
	if second.Revision != first.Revision {
		t.Fatal("saving an unchanged document changed the file: a form would dirty a file it did not edit")
	}
}

func TestTheDefaultIsNotWrittenForAnEnabledHook(t *testing.T) {
	path := hooksPath(t)
	mustSave(t, path, "", Document{Entries: []Entry{
		{Event: "stop", Name: "a", Argv: []string{"x"}, Enabled: true},
	}})
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "enabled") {
		t.Fatalf("file = %s, want no `enabled` key on an enabled hook", raw)
	}
}

func TestACommandIsWrittenAsTypedNotHTMLEscaped(t *testing.T) {
	path := hooksPath(t)
	mustSave(t, path, "", Document{Entries: []Entry{
		{Event: "stop", Name: "a", Line: "make test && make lint", Enabled: true},
	}})
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "make test && make lint") {
		t.Fatalf("file = %s, want `&&` kept: a command is code somebody reads back", raw)
	}
}

func TestTheCommentSurvivesAnEdit(t *testing.T) {
	path := hooksPath(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	original := `{"version":1,"$comment":"owned by the platform team","hooks":{"stop":[{"name":"a","command":["x"]}]}}`
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	read, err := ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	read.Doc.Entries[0].Name = "renamed"
	mustSave(t, path, read.Revision, read.Doc)
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "owned by the platform team") {
		t.Fatalf("file = %s, want the note kept", raw)
	}
}

// --- what a save refuses ----------------------------------------------------

func TestSaveRefusesAFileThatChangedUnderIt(t *testing.T) {
	path := hooksPath(t)
	first := mustSave(t, path, "", Document{Entries: []Entry{{Event: "stop", Name: "a", Argv: []string{"x"}, Enabled: true}}})

	// Somebody edits the file in a text editor after the panel drew it.
	edited := []byte(`{"version":1,"hooks":{"stop":[{"name":"edited-by-hand","command":["y"]}]}}`)
	if err := os.WriteFile(path, edited, 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := Save(path, first.Revision, Document{Entries: []Entry{{Event: "stop", Name: "b", Argv: []string{"z"}, Enabled: true}}})
	if !errors.Is(err, ErrFileChanged) {
		t.Fatalf("err = %v, want ErrFileChanged", err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != string(edited) {
		t.Fatalf("file = %s: a stale save overwrote somebody's edit", raw)
	}
}

func TestSaveRefusesToCreateOverAFileThatAppeared(t *testing.T) {
	// The panel drew "no file" (revision ""), and a file has been created since.
	path := hooksPath(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"version":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Save(path, "", Document{Entries: []Entry{}})
	if !errors.Is(err, ErrFileChanged) {
		t.Fatalf("err = %v, want ErrFileChanged", err)
	}
}

func TestSaveWritesNothingWhenStartUpWouldRefuseTheResult(t *testing.T) {
	cases := map[string]Entry{
		"matcher does not compile": {Event: "pre_tool_use", Name: "a", Matcher: "([", Argv: []string{"x"}, Enabled: true},
		"no command":               {Event: "pre_tool_use", Name: "a", Enabled: true},
		"unknown event":            {Event: "preToolUse", Name: "a", Argv: []string{"x"}, Enabled: true},
		"timeout out of range":     {Event: "stop", Name: "a", Argv: []string{"x"}, TimeoutMs: intPtr(999999), Enabled: true},
		"empty name":               {Event: "stop", Name: "  ", Argv: []string{"x"}, Enabled: true},
	}
	for label, entry := range cases {
		t.Run(label, func(t *testing.T) {
			path := hooksPath(t)
			if _, err := Save(path, "", Document{Entries: []Entry{entry}}); err == nil {
				t.Fatal("a document start-up refuses was written")
			}
			if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
				t.Fatalf("the file exists after a refused save: %v", statErr)
			}
			entries, _ := os.ReadDir(filepath.Dir(path))
			for _, leftover := range entries {
				t.Fatalf("stray file %q left behind by a refused save", leftover.Name())
			}
		})
	}
}

func TestSaveRefusesTwoHooksWithOneNameOnOneEvent(t *testing.T) {
	path := hooksPath(t)
	_, err := Save(path, "", Document{Entries: []Entry{
		{Event: "stop", Name: "same", Argv: []string{"x"}, Enabled: true},
		{Event: "stop", Name: "same", Argv: []string{"y"}, Enabled: true},
	}})
	if err == nil || !strings.Contains(err.Error(), "same") {
		t.Fatalf("err = %v, want the duplicate named", err)
	}
}

func TestSaveDoesNotOverwriteAFileThatIsBroken(t *testing.T) {
	// The bytes in a broken file are the only copy of what somebody typed.
	path := hooksPath(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	broken := []byte(`{"version":1,"hooks":{`)
	if err := os.WriteFile(path, broken, 0o600); err != nil {
		t.Fatal(err)
	}
	file, _ := ReadFile(path)
	if _, err := Save(path, file.Revision, Document{Entries: []Entry{}}); !errors.Is(err, ErrFileBroken) {
		t.Fatalf("err = %v, want ErrFileBroken: a broken file must not be overwritten", err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != string(broken) {
		t.Fatalf("file = %s, want it untouched", raw)
	}
}

// --- the wire ---------------------------------------------------------------

func TestDocumentFromMapReadsTheFormShape(t *testing.T) {
	doc, err := DocumentFromMap(map[string]any{
		"defaults": map[string]any{"timeout_ms": float64(4000)},
		"entries": []any{
			map[string]any{
				"event": "pre_tool_use", "name": "g", "matcher": "shell",
				"command": `python "C:/my tools/g.py"`, "timeout_ms": float64(1500),
				"fail_closed": nil, "enabled": false,
			},
			map[string]any{
				"event": "stop", "name": "s", "command": "make test && make lint", "shell": true,
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if doc.Defaults.TimeoutMs == nil || *doc.Defaults.TimeoutMs != 4000 {
		t.Fatalf("defaults = %+v", doc.Defaults)
	}
	entry := doc.Entries[0]
	if entry.Enabled || entry.FailClosed != nil || entry.TimeoutMs == nil || *entry.TimeoutMs != 1500 {
		t.Fatalf("entry = %+v", entry)
	}
	if len(entry.Argv) != 2 || entry.Argv[1] != "C:/my tools/g.py" || entry.Line != "" {
		t.Fatalf("argv = %q, want the quoted path kept as one word", entry.Argv)
	}
	shell := doc.Entries[1]
	if len(shell.Argv) != 0 || shell.Line != "make test && make lint" {
		t.Fatalf("shell entry = %+v, want the string spelling", shell)
	}
}

func TestSplitCommandReadsWhatJoinCommandWrites(t *testing.T) {
	cases := [][]string{
		{"python", "C:/tools/guard.py"},
		{"python", "C:/my tools/guard.py"},
		{"node", "-e", `console.log("hi")`},
		{"x", "", "y"},
		{`C:\tools\guard.exe`, "--flag"},
	}
	for _, argv := range cases {
		line := joinCommand(argv)
		got, err := SplitCommand(line)
		if err != nil {
			t.Fatalf("%q: %v", line, err)
		}
		if strings.Join(got, "\x00") != strings.Join(argv, "\x00") {
			t.Errorf("%q -> %q, want %q", line, got, argv)
		}
	}
}

func TestSplitCommandRefusesAnUnterminatedQuote(t *testing.T) {
	// Guessing here would run a different program from the one on screen.
	if _, err := SplitCommand(`python "C:/tools/guard.py`); err == nil {
		t.Fatal("an unterminated quote was accepted")
	}
}

func TestACommandIsShownAsOneLineAndKeepsItsSpelling(t *testing.T) {
	list := Entry{Argv: []string{"python", "C:/my tools/g.py"}}
	if text, shell := list.CommandText(); shell || text != `python "C:/my tools/g.py"` {
		t.Errorf("list -> %q shell=%v", text, shell)
	}
	line := Entry{Line: "  make test && make lint "}
	if text, shell := line.CommandText(); !shell || text != "make test && make lint" {
		t.Errorf("string -> %q shell=%v, want it flagged as a shell command", text, shell)
	}
}

func TestDocumentFromMapRefusesTheWrongTypes(t *testing.T) {
	bad := []map[string]any{
		{},
		{"entries": "nope"},
		{"entries": []any{"nope"}},
		{"entries": []any{map[string]any{"name": 7}}},
		{"entries": []any{map[string]any{"command": []any{"python"}}}},
		{"entries": []any{map[string]any{"command": `python "unterminated`}}},
		{"entries": []any{map[string]any{"shell": "yes"}}},
		{"entries": []any{map[string]any{"timeout_ms": 1.5}}},
		{"entries": []any{map[string]any{"fail_closed": "yes"}}},
		{"defaults": []any{}, "entries": []any{}},
	}
	for index, raw := range bad {
		if _, err := DocumentFromMap(raw); err == nil {
			t.Errorf("case %d (%v) was accepted", index, raw)
		}
	}
}

// --- scripts ----------------------------------------------------------------

func TestListScriptsSuggestsACommandPerExtension(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"guard.py", "fmt.mjs", "check.sh", "tool.exe", ".hidden.py", "left.tmp"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	scripts, err := ListScripts(dir)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string][]string{}
	for _, script := range scripts {
		found[script.Name] = script.Argv
		if strings.Contains(script.Path, `\`) {
			t.Errorf("path %q: forward slashes are the one spelling that needs no escaping", script.Path)
		}
	}
	if len(found) != 4 {
		t.Fatalf("found %v, want the four scripts and neither the hidden file, the temp file nor the folder", found)
	}
	if argv := found["fmt.mjs"]; len(argv) != 2 || argv[0] != "node" {
		t.Errorf("fmt.mjs -> %v", argv)
	}
	if argv := found["tool.exe"]; len(argv) != 1 {
		t.Errorf("tool.exe -> %v, want the file itself", argv)
	}
}

func TestAMissingScriptsFolderIsAnEmptyList(t *testing.T) {
	scripts, err := ListScripts(filepath.Join(t.TempDir(), "absent"))
	if err != nil || len(scripts) != 0 {
		t.Fatalf("scripts = %v, err = %v", scripts, err)
	}
}

func TestSameDefinitionNoticesAChangedCommand(t *testing.T) {
	path := hooksPath(t)
	saved := mustSave(t, path, "", Document{Entries: []Entry{
		{Event: "stop", Name: "a", Argv: []string{"x", "1"}, Enabled: true},
	}})
	before := saved.Set.Hooks(EventStop)[0]

	changed := mustSave(t, path, saved.Revision, Document{Entries: []Entry{
		{Event: "stop", Name: "a", Argv: []string{"x", "2"}, Enabled: true},
	}})
	after := changed.Set.Hooks(EventStop)[0]

	if SameDefinition(before, before) != true {
		t.Error("a hook differs from itself")
	}
	if SameDefinition(before, after) {
		t.Error("a changed argument was not noticed: a result recorded before the edit would be shown for the new command")
	}
}

// --- what each hook has done -------------------------------------------------

func TestStatsRecordACleanRunAndAFailure(t *testing.T) {
	for _, tc := range []struct {
		mode        string
		wantStatus  string
		wantFailure bool
	}{
		{"silent", StatusOK, false},
		{"deny", StatusDenied, false}, // a refusal is the guardrail working, not the hook failing
		{"badjson", StatusBadOutput, true},
		{"exit1", StatusExit, true},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			set := newRunner(t, EventPreToolUse, tc.mode, "")
			if _, ran := set.StatsFor(SourceUser, EventPreToolUse, "helper-"+tc.mode); ran {
				t.Fatal("a hook that has not run has statistics")
			}
			set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))

			stats, ran := set.StatsFor(SourceUser, EventPreToolUse, "helper-"+tc.mode)
			if !ran || stats.Runs != 1 || stats.Last == nil {
				t.Fatalf("stats = %+v, ran = %v", stats, ran)
			}
			if stats.Last.Status != tc.wantStatus {
				t.Fatalf("status = %q, want %q", stats.Last.Status, tc.wantStatus)
			}
			if (stats.Failures == 1) != tc.wantFailure {
				t.Fatalf("failures = %d, want failure=%v", stats.Failures, tc.wantFailure)
			}
		})
	}
}

func TestStatsKeepTheExitCodeAndTheReasonOfACrash(t *testing.T) {
	set := newRunner(t, EventPostToolUse, "exit1", "")
	set.Fire(context.Background(), toolEnvelope(EventPostToolUse, workspace(t)))
	stats, _ := set.StatsFor(SourceUser, EventPostToolUse, "helper-exit1")
	if stats.Last.ExitCode == nil || *stats.Last.ExitCode != 1 {
		t.Fatalf("exit code = %v, want 1", stats.Last.ExitCode)
	}
	if !strings.Contains(stats.Last.Reason, "exited with 1") {
		t.Fatalf("reason = %q, want the executor's own words", stats.Last.Reason)
	}
}

func TestStatsDoNotCountAHookThatWasSkipped(t *testing.T) {
	// The first hook refuses, so the second never runs. Counting the second as a run
	// would make a refusing guardrail look busier than the hooks behind it.
	document := `{"version":1,"hooks":{"pre_tool_use":[` +
		`{"name":"helper-deny","command":["` + strings.ReplaceAll(os.Args[0], `\`, `\\`) + `","-test.run=TestHelperProcess"]},` +
		`{"name":"helper-silent","command":["` + strings.ReplaceAll(os.Args[0], `\`, `\\`) + `","-test.run=TestHelperProcess"]}` +
		`]}}`
	set, err := Parse("hooks.json", []byte(document))
	if err != nil {
		t.Fatal(err)
	}
	set.Fire(context.Background(), toolEnvelope(EventPreToolUse, workspace(t)))
	if _, ran := set.StatsFor(SourceUser, EventPreToolUse, "helper-silent"); ran {
		t.Fatal("a skipped hook was counted as a run")
	}
	if stats, ran := set.StatsFor(SourceUser, EventPreToolUse, "helper-deny"); !ran || stats.Runs != 1 {
		t.Fatalf("stats = %+v", stats)
	}
}

func TestStatsCountEveryRunAndKeepOnlyTheLast(t *testing.T) {
	set := newRunner(t, EventPostToolUse, "silent", "")
	for index := 0; index < 3; index++ {
		set.Fire(context.Background(), toolEnvelope(EventPostToolUse, workspace(t)))
	}
	stats, _ := set.StatsFor(SourceUser, EventPostToolUse, "helper-silent")
	if stats.Runs != 3 || stats.Failures != 0 {
		t.Fatalf("stats = %+v, want 3 runs and no failures", stats)
	}
}

func TestStatsForANilSetIsEmpty(t *testing.T) {
	var set *Set
	if _, ran := set.StatsFor(SourceUser, EventStop, "x"); ran {
		t.Fatal("a nil set has statistics")
	}
	set.remember(Outcome{Hook: "x", Status: StatusOK}) // must not panic
}
