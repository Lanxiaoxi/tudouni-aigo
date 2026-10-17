package memory

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// openWorkspace opens a memory subsystem rooted at a fresh temp directory.
func openWorkspace(t *testing.T) *Workspace {
	t.Helper()
	workspace, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return workspace
}

// publish is the shortest path to a published memory: propose, then approve.
func publish(t *testing.T, workspace *Workspace, proposal Proposal) *Entry {
	t.Helper()
	id, err := workspace.Propose(proposal)
	if err != nil {
		t.Fatalf("Propose: %v", err)
	}
	entry, err := workspace.Publish(id)
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}
	return entry
}

func TestEntryRoundTrip(t *testing.T) {
	original := &Entry{
		ID:         "mem_001",
		Revision:   2,
		CreatedAt:  "2026-10-17",
		UpdatedAt:  "2026-10-18",
		Title:      "Android 构建中的 JDK 版本兼容问题",
		Body:       "遇到 Java 版本识别问题时，先看 Gradle Wrapper。\n\n## 适用条件\n\n- 构建环境里出现相关错误\n",
		Scope:      Scope{Paths: []string{"android/", "build.gradle"}},
		Triggers:   []string{"Could not determine java version", "Unsupported class file major version"},
		Tags:       []string{"gradle", "jdk"},
		Confidence: ConfidenceVerified,
	}

	rendered := original.Render()
	parsed, err := ParseEntry(rendered)
	if err != nil {
		t.Fatalf("ParseEntry(%q): %v", rendered, err)
	}
	if parsed.ID != original.ID || parsed.Revision != original.Revision {
		t.Errorf("identity did not survive: got %q r%d", parsed.ID, parsed.Revision)
	}
	if parsed.Title != original.Title {
		t.Errorf("title = %q, want %q", parsed.Title, original.Title)
	}
	if strings.TrimSpace(parsed.Body) != strings.TrimSpace(original.Body) {
		t.Errorf("body = %q, want %q", parsed.Body, original.Body)
	}
	if len(parsed.Triggers) != 2 || parsed.Triggers[0] != original.Triggers[0] {
		t.Errorf("triggers = %v, want %v", parsed.Triggers, original.Triggers)
	}
	if len(parsed.Scope.Paths) != 2 || parsed.Scope.Paths[0] != "android/" {
		t.Errorf("scope paths = %v, want %v", parsed.Scope.Paths, original.Scope.Paths)
	}
	if parsed.Confidence != ConfidenceVerified {
		t.Errorf("confidence = %q, want %q", parsed.Confidence, ConfidenceVerified)
	}
	// Deterministic output is the property that makes `git diff` on this directory
	// meaningful, so it is asserted rather than assumed.
	if again := parsed.Render(); again != rendered {
		t.Errorf("re-render differs from the original:\n--- first\n%s\n--- second\n%s", rendered, again)
	}
}

// TestFrontmatterSurvivesAwkwardValues covers the values that a naive renderer
// breaks: a colon inside a string, a `#`, a leading dash, a string that looks like a
// number, and quotes.
func TestFrontmatterSurvivesAwkwardValues(t *testing.T) {
	cases := []string{
		"error: the build failed",
		"#1 priority",
		"- not a list item",
		"42",
		`say "hello"`,
		"a value with # a hash",
	}
	for _, value := range cases {
		entry := &Entry{ID: "mem_009", Revision: 1, Title: "t", Triggers: []string{value}}
		parsed, err := ParseEntry(entry.Render())
		if err != nil {
			t.Fatalf("ParseEntry for %q: %v", value, err)
		}
		if len(parsed.Triggers) != 1 || parsed.Triggers[0] != value {
			t.Errorf("trigger %q round-tripped as %v", value, parsed.Triggers)
		}
	}
}

// TestUnknownFrontmatterKeysArePreserved: a field this build does not understand
// must not be dropped when a memory is updated through a proposal.
func TestUnknownFrontmatterKeysArePreserved(t *testing.T) {
	entry := &Entry{
		ID:       "mem_002",
		Revision: 1,
		Title:    "t",
		Body:     "b",
		Extra:    map[string]any{"owner": "ops-team", "reviewed_by": "li"},
	}
	parsed, err := ParseEntry(entry.Render())
	if err != nil {
		t.Fatalf("ParseEntry: %v", err)
	}
	if parsed.Extra["owner"] != "ops-team" {
		t.Errorf("owner = %v, want ops-team", parsed.Extra["owner"])
	}
}

func TestBrokenFileIsSkippedNotFatal(t *testing.T) {
	workspace := openWorkspace(t)
	publish(t, workspace, Proposal{
		Op: OpCreate, Title: "good one", Body: "body",
		Triggers: []string{"gradle"}, Confidence: ConfidenceVerified,
	})
	broken := filepath.Join(workspace.Root(), entriesDirName, "mem_900.md")
	if err := os.WriteFile(broken, []byte("no frontmatter here\n"), 0o644); err != nil {
		t.Fatalf("writing the broken file: %v", err)
	}

	// A rebuild must report the broken file and keep the good one.
	status := workspace.RebuildIndex()
	if status.Entries != 1 {
		t.Errorf("index holds %d entries, want 1", status.Entries)
	}
	if !strings.Contains(workspace.Problem(), "mem_900") {
		t.Errorf("the problem does not name the broken file: %q", workspace.Problem())
	}
	results, err := workspace.Search(Query{Text: "gradle"})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("got %d results, want 1", len(results))
	}
}

func TestProposalIsNotAMemoryUntilPublished(t *testing.T) {
	workspace := openWorkspace(t)
	id, err := workspace.Propose(Proposal{
		Op: OpCreate, Title: "unreviewed", Body: "should stay out of search",
		Triggers: []string{"gradle"}, Confidence: ConfidenceVerified,
	})
	if err != nil {
		t.Fatalf("Propose: %v", err)
	}
	if id != "proposal_001" {
		t.Errorf("proposal id = %q, want proposal_001", id)
	}

	results, err := workspace.Search(Query{Text: "gradle"})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("an unpublished proposal was retrievable: %d results", len(results))
	}
	if _, err := workspace.Get("mem_001"); err == nil {
		t.Error("Get answered for a memory that was never published")
	}

	candidates, err := workspace.Candidates()
	if err != nil || len(candidates) != 1 {
		t.Fatalf("Candidates = %v, %v", candidates, err)
	}
	if candidates[0].Op != OpCreate || candidates[0].Title != "unreviewed" {
		t.Errorf("candidate = %+v", candidates[0])
	}

	entry, err := workspace.Publish(id)
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if entry.ID != "mem_001" || entry.Revision != 1 {
		t.Errorf("published = %s r%d, want mem_001 r1", entry.ID, entry.Revision)
	}
	if left, _ := workspace.Candidates(); len(left) != 0 {
		t.Errorf("the proposal survived its own publication: %d left", len(left))
	}
	results, _ = workspace.Search(Query{Text: "gradle"})
	if len(results) != 1 {
		t.Fatalf("after publishing, search returned %d results", len(results))
	}
}

func TestRejectLeavesNothing(t *testing.T) {
	workspace := openWorkspace(t)
	id, err := workspace.Propose(Proposal{Op: OpCreate, Title: "nope", Body: "body"})
	if err != nil {
		t.Fatalf("Propose: %v", err)
	}
	if err := workspace.Reject(id); err != nil {
		t.Fatalf("Reject: %v", err)
	}
	if candidates, _ := workspace.Candidates(); len(candidates) != 0 {
		t.Errorf("a rejected proposal is still listed")
	}
	if err := workspace.Reject(id); err == nil {
		t.Error("rejecting the same proposal twice succeeded")
	}
}

// TestUpdateConflictsAreRefused is the concurrent-write test the design asks for:
// a proposal written against revision 1 must not overwrite revision 2.
func TestUpdateConflictsAreRefused(t *testing.T) {
	workspace := openWorkspace(t)
	first := publish(t, workspace, Proposal{
		Op: OpCreate, Title: "original", Body: "v1", Triggers: []string{"build"},
		Confidence: ConfidenceObserved,
	})

	// Two proposals written against the same revision.
	stale, err := workspace.Propose(Proposal{
		Op: OpUpdate, TargetID: first.ID, ExpectedRevision: first.Revision,
		Title: "stale edit", Body: "this one comes second",
	})
	if err != nil {
		t.Fatalf("Propose (stale): %v", err)
	}
	winner, err := workspace.Propose(Proposal{
		Op: OpUpdate, TargetID: first.ID, ExpectedRevision: first.Revision,
		Title: "winning edit", Body: "this one lands first",
	})
	if err != nil {
		t.Fatalf("Propose (winner): %v", err)
	}
	if _, err := workspace.Publish(winner); err != nil {
		t.Fatalf("Publish (winner): %v", err)
	}

	if _, err := workspace.Publish(stale); err == nil {
		t.Fatal("a stale proposal overwrote a newer revision")
	} else {
		var conflict *ConflictError
		if !errors.As(err, &conflict) {
			t.Fatalf("error = %v, want a *ConflictError", err)
		}
		if conflict.Current != 2 {
			t.Errorf("conflict reports current revision %d, want 2", conflict.Current)
		}
	}

	entry, err := workspace.Get(first.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if entry.Title != "winning edit" || entry.Revision != 2 {
		t.Errorf("published memory = %q r%d, want \"winning edit\" r2", entry.Title, entry.Revision)
	}
	// The refused proposal is still there, so the reviewer can see it and redo it
	// against the current revision rather than losing the work.
	if candidates, _ := workspace.Candidates(); len(candidates) != 1 {
		t.Errorf("after a conflict there are %d proposals, want 1", len(candidates))
	}
}

func TestUpdateArchivesThePreviousRevision(t *testing.T) {
	workspace := openWorkspace(t)
	first := publish(t, workspace, Proposal{
		Op: OpCreate, Title: "before", Body: "v1", Confidence: ConfidenceObserved,
	})
	if _, err := workspace.Propose(Proposal{
		Op: OpUpdate, TargetID: first.ID, ExpectedRevision: first.Revision,
		Title: "after", Body: "v2",
	}); err != nil {
		t.Fatalf("Propose: %v", err)
	}
	candidates, _ := workspace.Candidates()
	if _, err := workspace.Publish(candidates[0].ID); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	archived := filepath.Join(workspace.Root(), archiveDirName, archiveEntries, first.ID+"-r1.md")
	if _, err := os.Stat(archived); err != nil {
		t.Errorf("the superseded revision was not archived: %v", err)
	}
}

func TestDeprecateRemovesFromSearchAndKeepsTheArchive(t *testing.T) {
	workspace := openWorkspace(t)
	entry := publish(t, workspace, Proposal{
		Op: OpCreate, Title: "old workaround", Body: "no longer true",
		Triggers: []string{"gradle daemon died"}, Confidence: ConfidenceVerified,
	})

	proposalID, err := workspace.Deprecate(entry.ID, "the plugin was upgraded")
	if err != nil {
		t.Fatalf("Deprecate: %v", err)
	}
	// Still retrievable until somebody approves the deprecation: a proposal is not a
	// decision.
	if results, _ := workspace.Search(Query{Text: "gradle daemon died"}); len(results) != 1 {
		t.Fatalf("deprecating removed the memory before it was published")
	}
	if _, err := workspace.Publish(proposalID); err != nil {
		t.Fatalf("Publish(deprecate): %v", err)
	}

	if results, _ := workspace.Search(Query{Text: "gradle daemon died"}); len(results) != 0 {
		t.Fatalf("a deprecated memory is still retrievable: %d results", len(results))
	}
	if _, err := workspace.Get(entry.ID); err == nil {
		t.Error("a deprecated memory is still readable through Get")
	}
	archived := filepath.Join(workspace.Root(), archiveDirName, archiveEntries, entry.ID+"-deprecated.md")
	raw, err := os.ReadFile(archived)
	if err != nil {
		t.Fatalf("reading the archive copy: %v", err)
	}
	if !strings.Contains(string(raw), "the plugin was upgraded") {
		t.Errorf("the archive copy does not explain why it was retired:\n%s", raw)
	}
}

func TestIndexIsRebuiltFromMarkdown(t *testing.T) {
	workspace := openWorkspace(t)
	publish(t, workspace, Proposal{
		Op: OpCreate, Title: "survives", Body: "body", Triggers: []string{"unique-trigger"},
		Confidence: ConfidenceVerified,
	})

	indexPath := filepath.Join(workspace.Root(), indexFileName)
	if err := os.Remove(indexPath); err != nil {
		t.Fatalf("removing the index: %v", err)
	}
	// A corrupted index must be repaired the same way a missing one is.
	if err := os.WriteFile(indexPath, []byte("{ this is not json"), 0o644); err != nil {
		t.Fatalf("corrupting the index: %v", err)
	}

	reopened, err := Open(filepath.Dir(filepath.Dir(workspace.Root())))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	results, err := reopened.Search(Query{Text: "unique-trigger"})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("after a rebuild the memory is gone: %d results", len(results))
	}
	if !reopened.IndexStatus().Rebuilt {
		t.Error("the status does not say the index was rebuilt")
	}
	if _, err := os.Stat(indexPath); err != nil {
		t.Errorf("the index was not written back: %v", err)
	}
}

// TestExternalEditIsNoticed is the "somebody opened the file in an editor" case: the
// ids are unchanged, so only the timestamp can reveal that the text moved on.
func TestExternalEditIsNoticed(t *testing.T) {
	workspace := openWorkspace(t)
	entry := publish(t, workspace, Proposal{
		Op: OpCreate, Title: "hand edited", Body: "body", Triggers: []string{"first-trigger"},
		Confidence: ConfidenceVerified,
	})

	path := filepath.Join(workspace.Root(), entriesDirName, entry.ID+".md")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading the memory: %v", err)
	}
	edited := strings.ReplaceAll(string(raw), "first-trigger", "second-trigger")
	if err := os.WriteFile(path, []byte(edited), 0o644); err != nil {
		t.Fatalf("editing the memory: %v", err)
	}

	// The staleness probe is throttled, so force it rather than sleeping in a test.
	workspace.checkedAt = workspace.checkedAt.Add(-2 * StaleCheckInterval)
	results, err := workspace.Search(Query{Text: "second-trigger"})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("the edited trigger is not retrievable: %d results", len(results))
	}
	if results[0].Entry.Triggers[0] != "second-trigger" {
		t.Errorf("the loaded entry is the stale one: %v", results[0].Entry.Triggers)
	}
}

func TestSearchRanksTriggersAboveBodyText(t *testing.T) {
	workspace := openWorkspace(t)
	publish(t, workspace, Proposal{
		Op: OpCreate, Title: "exact", Body: "unrelated words",
		Triggers: []string{"Could not determine java version"}, Confidence: ConfidenceVerified,
	})
	publish(t, workspace, Proposal{
		Op: OpCreate, Title: "mentions java in the body", Body: "a long note about java and version handling",
		Tags: []string{"java"}, Confidence: ConfidenceVerified,
	})

	results, err := workspace.Search(Query{Text: "error: Could not determine java version from '21.0.1'"})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("got %d results, want 2", len(results))
	}
	if results[0].Entry.Title != "exact" {
		t.Errorf("top result = %q, want the trigger hit \"exact\"", results[0].Entry.Title)
	}
	if len(results[0].Reasons) == 0 {
		t.Error("the top result explains nothing about why it was recalled")
	}
}

func TestSearchRequiresARealCue(t *testing.T) {
	workspace := openWorkspace(t)
	publish(t, workspace, Proposal{
		Op: OpCreate, Title: "about gradle", Body: "a note mentioning java once",
		Confidence: ConfidenceVerified,
	})
	// One body word in common is below the floor: a memory that exists is not a
	// memory that is relevant.
	results, err := workspace.Search(Query{Text: "java"})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("a single body word recalled a memory: %v", results)
	}
}

func TestSearchFindsChineseTriggersFromADifferentSentence(t *testing.T) {
	workspace := openWorkspace(t)
	publish(t, workspace, Proposal{
		Op: OpCreate, Title: "方案讨论偏好", Body: "先讲原则，再讲细节。",
		Triggers: []string{"方案设计", "技术讨论"}, Tags: []string{"collaboration"},
		Confidence: ConfidenceObserved,
	})
	results, err := workspace.Search(Query{Text: "帮我把这个功能的方案整理一下，先讨论技术选型"})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("a preference expressed in different words was not recalled: %d results", len(results))
	}
}

func TestScopeFilterDropsOtherSubtrees(t *testing.T) {
	workspace := openWorkspace(t)
	publish(t, workspace, Proposal{
		Op: OpCreate, Title: "android only", Body: "body",
		Triggers:   []string{"build fails"},
		Scope:      Scope{Paths: []string{"android/"}},
		Confidence: ConfidenceVerified,
	})

	if results, _ := workspace.Search(Query{Text: "build fails", Paths: []string{"android/app/build.gradle"}}); len(results) != 1 {
		t.Errorf("a memory scoped to the path in play was dropped")
	}
	if results, _ := workspace.Search(Query{Text: "build fails", Paths: []string{"backend/server.go"}}); len(results) != 0 {
		t.Errorf("a memory scoped to another subtree was recalled: %v", results)
	}
	// No paths in the query means "unknown", which must not be read as "does not
	// apply" — otherwise a turn-start recall loses every scoped memory.
	if results, _ := workspace.Search(Query{Text: "build fails"}); len(results) != 1 {
		t.Errorf("a scoped memory was dropped from an unscoped query")
	}
}

func TestIDsCannotEscapeTheDirectory(t *testing.T) {
	workspace := openWorkspace(t)
	for _, id := range []string{"../secrets", "a/b", "..", "", "mem_001/../../x"} {
		if _, err := workspace.Get(id); err == nil {
			t.Errorf("Get(%q) was allowed", id)
		}
	}
}

func TestConfigDefaultsAndClamping(t *testing.T) {
	workspace := openWorkspace(t)
	config := workspace.Config()
	if !config.Enabled || config.MaxRecall != 3 {
		t.Errorf("defaults = %+v", config)
	}

	saved, notes, err := workspace.SaveConfig(Config{
		Enabled: true, AutoInject: true,
		MaxRecall: 500, MaxResults: 0, MinScore: 0,
		EntryChars: 10, NoteChars: 5,
	})
	if err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	if saved.MaxRecall != maxRecallCeiling {
		t.Errorf("max_recall = %d, want the ceiling %d", saved.MaxRecall, maxRecallCeiling)
	}
	if saved.MaxResults != 1 {
		t.Errorf("max_results = %d, want the floor 1", saved.MaxResults)
	}
	if len(notes) == 0 {
		t.Error("clamping reported nothing, so a person would never learn their setting was ignored")
	}

	raw, err := os.ReadFile(filepath.Join(workspace.Root(), configFileName))
	if err != nil {
		t.Fatalf("reading config.json: %v", err)
	}
	if !strings.Contains(string(raw), `"max_recall": 10`) {
		t.Errorf("config.json was not written in the clamped form:\n%s", raw)
	}
}

func TestMalformedConfigFallsBackToDefaults(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, ".tudouni", DirName)
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, configFileName), []byte("{oops"), 0o644); err != nil {
		t.Fatalf("writing the bad config: %v", err)
	}

	workspace, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if !workspace.Enabled() {
		t.Error("a malformed config turned memory off instead of falling back")
	}
	if !strings.Contains(workspace.Problem(), "not valid JSON") {
		t.Errorf("the malformed config was not reported: %q", workspace.Problem())
	}
}

func TestDisabledMemoryAnswersNothing(t *testing.T) {
	workspace := openWorkspace(t)
	publish(t, workspace, Proposal{
		Op: OpCreate, Title: "t", Body: "b", Triggers: []string{"gradle"},
		Confidence: ConfidenceVerified,
	})
	if _, _, err := workspace.SaveConfig(Config{Enabled: false, MaxRecall: 3, MaxResults: 5,
		MinScore: 2, EntryChars: 600, NoteChars: 2400}); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	if results, _ := workspace.Search(Query{Text: "gradle"}); len(results) != 0 {
		t.Error("a disabled memory system still retrieved")
	}
	if _, err := workspace.Propose(Proposal{Op: OpCreate, Title: "t", Body: "b"}); err == nil {
		t.Error("a disabled memory system still accepted a proposal")
	}
}

func TestProposeRejectsUnknownConfidence(t *testing.T) {
	workspace := openWorkspace(t)
	if _, err := workspace.Propose(Proposal{
		Op: OpCreate, Title: "t", Body: "b", Confidence: "certain",
	}); err == nil {
		t.Fatal("an unknown confidence was accepted and would have been ignored for ever")
	}
}

func TestSnapshotDescribesBothDirectories(t *testing.T) {
	workspace := openWorkspace(t)
	publish(t, workspace, Proposal{
		Op: OpCreate, Title: "published", Body: "b", Triggers: []string{"a"},
		Confidence: ConfidenceVerified,
	})
	if _, err := workspace.Propose(Proposal{Op: OpCreate, Title: "waiting", Body: "b"}); err != nil {
		t.Fatalf("Propose: %v", err)
	}

	snapshot := workspace.Snapshot()
	if len(snapshot.Entries) != 1 || snapshot.Entries[0].Title != "published" {
		t.Fatalf("entries = %+v", snapshot.Entries)
	}
	if len(snapshot.Candidates) != 1 || snapshot.Candidates[0].Title != "waiting" {
		t.Fatalf("candidates = %+v", snapshot.Candidates)
	}
	if snapshot.Index.Entries != 1 {
		t.Errorf("index status = %+v", snapshot.Index)
	}
	if snapshot.Root == "" {
		t.Error("the snapshot does not say where memory lives")
	}
}

func TestNextIDSkipsArchivedNumbers(t *testing.T) {
	got := nextID("mem", []string{"mem_001", "mem_002-r1", "mem_002-deprecated"})
	if got != "mem_003" {
		t.Errorf("nextID = %q, want mem_003", got)
	}
	if got := nextID("mem", nil); got != "mem_001" {
		t.Errorf("nextID on an empty directory = %q", got)
	}
}

// TestTokenizeKeepsChineseWordsUseful pins the CJK rule: bigrams, not single runes,
// because single runes make every Chinese sentence match every Chinese note.
func TestTokenizeKeepsChineseWordsUseful(t *testing.T) {
	tokens := tokenize("方案设计")
	set := map[string]bool{}
	for _, token := range tokens {
		set[token] = true
	}
	for _, want := range []string{"方案", "案设", "设计"} {
		if !set[want] {
			t.Errorf("tokenize(%q) has no %q: %v", "方案设计", want, tokens)
		}
	}
	if set["方"] {
		t.Error("tokenize emitted a single CJK rune, which matches almost everything")
	}

	latin := tokenize("Could not determine java version")
	for _, want := range []string{"could", "determine", "java", "version"} {
		found := false
		for _, token := range latin {
			if token == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("tokenize dropped %q: %v", want, latin)
		}
	}
}
