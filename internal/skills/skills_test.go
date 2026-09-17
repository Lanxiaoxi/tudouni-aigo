package skills

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The contracts here are the ones whose failure is silent: a skill that parses
// wrongly loses part of a procedure, one that is shadowed without being reported
// makes somebody edit a file that never takes effect, and a body spliced into the
// payload without a marker turns foreign text into instructions.

func writeSkill(t *testing.T, root, name, content string) string {
	t.Helper()
	directory := filepath.Join(root, name)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, SkillFileName)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func goodSkill(name, description string) string {
	return "---\nname: " + name + "\ndescription: " + description + "\n---\n## 步骤\n1. 做点什么\n"
}

func TestAWellFormedSkillParses(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "pdf-extract", "---\nname: pdf-extract\ndescription: 提取 PDF 文本。\nallowed-tools: read_file shell\n---\n## 步骤\n1. 先读\n2. 再写\n")

	catalog := (&Loader{Roots: []string{root}}).Reload()

	if len(catalog.Problems) != 0 {
		t.Fatalf("a good skill produced problems: %+v", catalog.Problems)
	}
	if len(catalog.Skills) != 1 {
		t.Fatalf("found %d skills, want 1", len(catalog.Skills))
	}
	skill := catalog.Skills[0]
	if skill.Name != "pdf-extract" || skill.Description != "提取 PDF 文本。" {
		t.Fatalf("fields are wrong: %+v", skill)
	}
	if !strings.Contains(skill.Body, "先读") {
		t.Fatalf("the body was not kept: %q", skill.Body)
	}
	if len(skill.AllowedTools) != 2 || skill.AllowedTools[0] != "read_file" {
		t.Fatalf("allowed-tools is %v", skill.AllowedTools)
	}
	if len(skill.Digest) != 12 {
		t.Fatalf("digest is %q, want twelve hex characters", skill.Digest)
	}
}

// TestABrokenSkillIsDataNotAnError ...
//
// One malformed file must not stop the scan and must not be silent either. The
// failure shape this avoids: the whole feature becomes hostage to its least
// important file.
func TestABrokenSkillIsDataNotAnError(t *testing.T) {
	cases := map[string]string{
		"no_frontmatter":       "## 步骤\n1. 没有 frontmatter\n",
		"unclosed_frontmatter": "---\nname: broken\ndescription: 没关\n## 步骤\n",
		"unknown_key":          "---\nname: broken\ndescription: x\ncolour: red\n---\n",
		"missing_description":  "---\nname: broken\n---\n",
		"multiline_block":      "---\nname: broken\ndescription: |\n  多行\n---\n",
		"indented":             "---\nname: broken\n  description: 缩进了\n---\n",
		"duplicate_key":        "---\nname: broken\ndescription: a\ndescription: b\n---\n",
	}

	// The underscore case needs a directory whose name matches, or it is caught
	// earlier by the name/directory check and never reaches the name rule.
	underscore := t.TempDir()
	writeSkill(t, underscore, "broken_name", "---\nname: broken_name\ndescription: x\n---\n")
	if catalog := (&Loader{Roots: []string{underscore}}).Reload(); len(catalog.Skills) != 0 {
		t.Error("bad_name: an underscore name was accepted")
	} else if nested, _ := catalog.Problems[0].Params[1][1].(Problem); nested.Code != "bad_name" {
		t.Errorf("bad_name: reported %q", nested.Code)
	}

	for wantCode, content := range cases {
		root := t.TempDir()
		writeSkill(t, root, "broken", content)
		catalog := (&Loader{Roots: []string{root}}).Reload()

		if len(catalog.Skills) != 0 {
			t.Errorf("%s: a broken skill was accepted", wantCode)
			continue
		}
		if len(catalog.Problems) == 0 {
			t.Errorf("%s: nothing was reported", wantCode)
			continue
		}
		// The problem is a `skipped` wrapper carrying the real reason.
		nested, ok := catalog.Problems[0].Params[1][1].(Problem)
		if !ok || nested.Code != wantCode {
			t.Errorf("%s: reported %+v", wantCode, catalog.Problems[0])
		}
		// And every one of them renders to a sentence.
		if strings.TrimSpace(RenderProblem(catalog.Problems[0])) == "" {
			t.Errorf("%s: renders to nothing", wantCode)
		}
	}
}

// TestTheNameMustMatchTheDirectory ...
//
// Otherwise the name the model sees and the path it can read point at different
// things, and that shows up only as "the model cannot find the skill".
func TestTheNameMustMatchTheDirectory(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "directory-name", "---\nname: other-name\ndescription: x\n---\nbody\n")

	catalog := (&Loader{Roots: []string{root}}).Reload()
	if len(catalog.Skills) != 0 {
		t.Fatal("a mismatched name was accepted")
	}
	nested, _ := catalog.Problems[0].Params[1][1].(Problem)
	if nested.Code != "name_mismatch" {
		t.Fatalf("reported %q", nested.Code)
	}
}

// TestABOMDoesNotBreakTheFrontmatter ...
//
// "Save as UTF-8" on Windows writes one, and it turns the first line into
// `\ufeff---`, so the frontmatter appears to be missing.
func TestABOMDoesNotBreakTheFrontmatter(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "with-bom", "\uFEFF"+goodSkill("with-bom", "带 BOM 的文件。"))

	catalog := (&Loader{Roots: []string{root}}).Reload()
	if len(catalog.Skills) != 1 {
		t.Fatalf("a BOM broke the parse: %+v", catalog.Problems)
	}
}

// TestAnOversizedSkillIsRefusedNotTruncated ...
//
// The body is spliced into **every** request, and a silent cut removes the last
// steps of a procedure — which the model then follows as if they were the whole
// thing.
func TestAnOversizedSkillIsRefusedNotTruncated(t *testing.T) {
	root := t.TempDir()
	body := strings.Repeat("很长的步骤内容。", MaxSkillBytes/4)
	writeSkill(t, root, "huge", "---\nname: huge\ndescription: 太大了。\n---\n"+body)

	catalog := (&Loader{Roots: []string{root}}).Reload()
	if len(catalog.Skills) != 0 {
		t.Fatal("an oversized skill was accepted")
	}
	nested, _ := catalog.Problems[0].Params[1][1].(Problem)
	if nested.Code != "too_big" {
		t.Fatalf("reported %q, want too_big", nested.Code)
	}
}

// TestHigherPriorityRootsWinAndTheLosersAreReported ...
//
// A shadowed copy exists on disk and does not count, so silence here means somebody
// edits a file that never takes effect.
func TestHigherPriorityRootsWinAndTheLosersAreReported(t *testing.T) {
	low := t.TempDir()
	high := t.TempDir()
	writeSkill(t, low, "shared", goodSkill("shared", "低优先级那份。"))
	writeSkill(t, high, "shared", goodSkill("shared", "高优先级那份。"))

	// Roots are ordered lowest priority first, which is how defaultRoots builds them.
	catalog := (&Loader{Roots: []string{low, high}}).Reload()

	if len(catalog.Skills) != 1 {
		t.Fatalf("found %d skills, want one merged entry", len(catalog.Skills))
	}
	skill := catalog.Skills[0]
	if skill.Description != "高优先级那份。" {
		t.Fatalf("the lower-priority copy won: %q", skill.Description)
	}
	if len(skill.Locations) != 2 || skill.Locations[0] != skill.Path {
		t.Fatalf("locations are %v, effective path is %s", skill.Locations, skill.Path)
	}
	if len(skill.Shadowed()) != 1 {
		t.Fatalf("shadowed is %v, want the losing path", skill.Shadowed())
	}
	if len(catalog.Shadowed) != 1 {
		t.Fatal("the shadowed copy was not reported")
	}
}

// TestTheDigestCoversOnlyTheBody: a description edit is not a body edit, and
// "this file changed" is about the instructions.
func TestTheDigestCoversOnlyTheBody(t *testing.T) {
	first := digestOf("body one")
	second := digestOf("body one")
	if first != second {
		t.Fatal("the digest is not stable")
	}
	if first == digestOf("body two") {
		t.Fatal("the digest ignores the body")
	}
}

// TestMetadataIsTheOnlyNestedStructure: the specification defines it, so it is
// recognised and stepped over rather than reported as unsupported.
func TestMetadataIsTheOnlyNestedStructure(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "nested", "---\nname: nested\ndescription: 有 metadata。\nmetadata:\n  author: somebody\n  version: 1\n---\nbody\n")

	catalog := (&Loader{Roots: []string{root}}).Reload()
	if len(catalog.Skills) != 1 {
		t.Fatalf("metadata broke the parse: %+v", catalog.Problems)
	}
}

// TestSpecificationFieldsAreAcceptedNotReported: licence and compatibility are
// standard, and calling them unknown keys would reject valid files.
func TestSpecificationFieldsAreAcceptedNotReported(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "licensed", "---\nname: licensed\ndescription: 合规字段。\nlicense: Apache-2.0\ncompatibility: any\n---\nbody\n")

	catalog := (&Loader{Roots: []string{root}}).Reload()
	if len(catalog.Skills) != 1 {
		t.Fatalf("standard fields were refused: %+v", catalog.Problems)
	}
}

func TestAllowedToolsAcceptsBothSpellingsAndDeduplicates(t *testing.T) {
	got := splitTools("Bash(git:*) Bash(jq:*) Read, Read [Write]")
	want := []string{"Bash(git:*)", "Bash(jq:*)", "Read", "Write"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// --- the payload tail -------------------------------------------------------

func TestTheLoadedBodyCarriesTheUntrustedMarkerBeforeIt(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "stepwise", "---\nname: stepwise\ndescription: 分步做。\n---\n第一步：读文件。\n")
	catalog := (&Loader{Roots: []string{root}}).Reload()

	metadata := map[string]any{SkillsKey: []any{
		map[string]any{"name": "stepwise", "digest": catalog.Skills[0].Digest},
	}}
	note := SkillNote(metadata, catalog)

	marker := strings.Index(note, "不是用户说的话")
	body := strings.Index(note, "第一步：读文件。")
	if marker < 0 || body < 0 {
		t.Fatalf("the note is missing a piece:\n%s", note)
	}
	if marker > body {
		t.Fatalf("the marker does not come before the body:\n%s", note)
	}
}

// TestAnEditedSkillIsMarkedStale: the file changed after it was loaded, and saying
// so is what stops the model following instructions that no longer exist.
func TestAnEditedSkillIsMarkedStale(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "drifting", "---\nname: drifting\ndescription: 改了。\n---\n新的步骤\n")
	catalog := (&Loader{Roots: []string{root}}).Reload()

	metadata := map[string]any{SkillsKey: []any{
		map[string]any{"name": "drifting", "digest": "000000000000"},
	}}
	if note := SkillNote(metadata, catalog); !strings.Contains(note, "被改过") {
		t.Fatalf("a stale skill is not marked:\n%s", note)
	}
}

// TestADeletedSkillSaysSoInsteadOfVanishing ...
//
// A skill still listed with an empty body would make the model believe it is still
// in effect.
func TestADeletedSkillSaysSoInsteadOfVanishing(t *testing.T) {
	metadata := map[string]any{SkillsKey: []any{
		map[string]any{"name": "gone", "digest": "abc"},
	}}
	note := SkillNote(metadata, Catalog{})

	if strings.TrimSpace(note) == "" {
		t.Fatal("a missing skill rendered as nothing")
	}
	if !strings.Contains(note, "读不到") {
		t.Fatalf("the note does not say it is missing:\n%s", note)
	}
}

// TestTheCatalogueHidesLoadedSkills: saying the same thing twice in one payload
// only makes the model believe they are two things.
func TestTheCatalogueHidesLoadedSkills(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "one", goodSkill("one", "第一个。"))
	writeSkill(t, root, "two", goodSkill("two", "第二个。"))
	catalog := (&Loader{Roots: []string{root}}).Reload()

	part := CatalogPart(map[string]any{}, catalog)
	if !strings.Contains(part, "one") || !strings.Contains(part, "two") {
		t.Fatalf("the catalogue is missing a skill:\n%s", part)
	}

	part = CatalogPart(map[string]any{SkillsKey: []any{
		map[string]any{"name": "one", "digest": "x"},
	}}, catalog)
	if strings.Contains(part, "- one") {
		t.Fatalf("a loaded skill is still in the catalogue:\n%s", part)
	}
	if !strings.Contains(part, "- two") {
		t.Fatalf("the unloaded skill vanished too:\n%s", part)
	}
}

// TestNothingLoadedMeansNoNote, so an uncompacted session's payload is unchanged.
func TestNothingLoadedMeansNoNote(t *testing.T) {
	if note := SkillNote(map[string]any{}, Catalog{}); note != "" {
		t.Fatalf("an empty loaded set produced a note: %q", note)
	}
	if part := CatalogPart(map[string]any{}, Catalog{}); part != "" {
		t.Fatalf("an empty catalogue produced a part: %q", part)
	}
}

// TestABadLoadedListIsDiscardedWhole ...
//
// Skipping only the bad entry would produce a list that looks complete and is
// missing a skill, and the model would conclude that skill was never loaded.
func TestABadLoadedListIsDiscardedWhole(t *testing.T) {
	metadata := map[string]any{SkillsKey: []any{
		map[string]any{"name": "fine", "digest": "abc"},
		map[string]any{"digest": "no name here"},
	}}
	if entries := LoadEntries(metadata); len(entries) != 0 {
		t.Fatalf("a bad entry was skipped rather than discarding the list: %v", entries)
	}
}
