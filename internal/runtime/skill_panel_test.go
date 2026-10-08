package runtime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/skills"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
)

// skillPanelRuntime is a statePanelRuntime with a skill board attached over a
// temporary directory, so the catalogue is real and controllable.
func skillPanelRuntime(t *testing.T, session *state.Session, skillRoot string) *Runtime {
	t.Helper()
	runtimeValue := statePanelRuntime(session)
	runtimeValue.Skills = builtin.NewSkillBoard(session.Metadata, &skills.Loader{Roots: []string{skillRoot}})
	return runtimeValue
}

// skillPointersInPayload reads the loaded-skill pointers the way a front end
// does: out of the JSON that actually crosses the wire.
func skillPointersInPayload(t *testing.T, payload map[string]any) []any {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("the state payload does not encode: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("the state payload does not decode: %v", err)
	}
	rows, ok := decoded["skills"].([]any)
	if !ok {
		t.Fatalf("skills is %T on the wire, want a list", decoded["skills"])
	}
	return rows
}

// TestTheStatePayloadCarriesSkillsLoadedThisSession is the regression for the
// sidebar's "Loaded skills" block reading this list and seeing an empty one for
// the whole life of a live session: the snapshot had it hard-coded to `[]`, so
// a `load_skill` this process wrote only appeared after a `/resume`, when the
// list had been through the session file once — and even then, not at all,
// because the field never read the metadata.
func TestTheStatePayloadCarriesSkillsLoadedThisSession(t *testing.T) {
	skillRoot := t.TempDir()
	skillFile := filepath.Join(skillRoot, "pdf-extract", skills.SkillFileName)
	if err := os.MkdirAll(filepath.Dir(skillFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(skillFile, []byte("---\nname: pdf-extract\ndescription: 提取 PDF 文本。\n---\n## 步骤\n1. 读\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	session := state.NewEmptySession("s")
	if result := builtin.NewSkillBoard(session.Metadata, &skills.Loader{Roots: []string{skillRoot}}).Call("pdf-extract", false); !okResult(result) {
		t.Fatalf("load_skill reported: %s", result.Text)
	}

	rows := skillPointersInPayload(t, skillPanelRuntime(t, session, skillRoot).StateMessage(false))
	if len(rows) != 1 {
		t.Fatalf("the skills block got %d rows, want 1 (the skill loaded this session)", len(rows))
	}
	row, _ := rows[0].(map[string]any)
	if name, _ := row["name"].(string); name != "pdf-extract" {
		t.Errorf("pointer name = %v, want the skill the model loaded", name)
	}
	if digest, _ := row["digest"].(string); digest == "" {
		t.Errorf("the pointer carries no digest — that is the field the front end needs")
	}
}

// TestTheStatePayloadCarriesSkillsLoadedFromDisk is the other half of the same
// rule: a resumed session hands the list over through JSON, and a fix that only
// taught the reader the in-memory shape would trade one empty block for another.
func TestTheStatePayloadCarriesSkillsLoadedFromDisk(t *testing.T) {
	session := state.NewEmptySession("s")
	loaded, err := json.Marshal([]map[string]any{
		{"name": "pdf-extract", "digest": "0123456789ab"},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var fromFile any
	if err := json.Unmarshal(loaded, &fromFile); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	session.Metadata[skills.SkillsKey] = fromFile

	rows := skillPointersInPayload(t, skillPanelRuntime(t, session, t.TempDir()).StateMessage(false))
	if len(rows) != 1 {
		t.Fatalf("the skills block got %d rows, want 1 (the list read back from a session file)", len(rows))
	}
	row, _ := rows[0].(map[string]any)
	if digest, _ := row["digest"].(string); digest != "0123456789ab" {
		t.Errorf("digest = %v, want the one the session file recorded", digest)
	}
}

// TestTheStatePayloadSaysNoSkillsInTheEmptyShapes: absent, null and an empty
// list all mean "nothing loaded", and every one of them has to leave the
// payload's shape alone — a front end with two empty cases has two places to
// get the empty one wrong. A malformed entry discards the whole list rather
// than reporting a half list that looks complete.
func TestTheStatePayloadSaysNoSkillsInTheEmptyShapes(t *testing.T) {
	for name, value := range map[string]any{
		"absent":    nil,
		"null":      nil,
		"empty":     []any{},
		"empty map": []map[string]any{},
		"malformed": []any{map[string]any{"name": ""}},
		"no name":   []any{map[string]any{"digest": "0123456789ab"}},
	} {
		session := state.NewEmptySession("s")
		if value != nil {
			session.Metadata[skills.SkillsKey] = value
		}
		rows := skillPointersInPayload(t, skillPanelRuntime(t, session, t.TempDir()).StateMessage(false))
		if len(rows) != 0 {
			t.Errorf("%s: reported %d rows, want 0", name, len(rows))
		}
	}
}

// TestTheFirstSnapshotCarriesTheSkillCatalogue is the counterpart on the
// "what could be loaded" side: the first snapshot (and only the first) carries
// the catalogue's one-line descriptions, and a runtime with no skill board
// says "there are none" with an empty list rather than a missing key.
func TestTheFirstSnapshotCarriesTheSkillCatalogue(t *testing.T) {
	skillRoot := t.TempDir()
	skillFile := filepath.Join(skillRoot, "pdf-extract", skills.SkillFileName)
	if err := os.MkdirAll(filepath.Dir(skillFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(skillFile, []byte("---\nname: pdf-extract\ndescription: 提取 PDF 文本。\n---\n## 步骤\n1. 读\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	session := state.NewEmptySession("s")
	runtimeValue := skillPanelRuntime(t, session, skillRoot)

	// The first snapshot carries it.
	payload := runtimeValue.StateMessage(true)
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("the state payload does not encode: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("the state payload does not decode: %v", err)
	}
	catalog, ok := decoded["skill_catalog"].([]any)
	if !ok {
		t.Fatalf("skill_catalog is %T on the wire, want a list", decoded["skill_catalog"])
	}
	if len(catalog) != 1 {
		t.Fatalf("the catalogue got %d rows, want 1", len(catalog))
	}
	row, _ := catalog[0].(map[string]any)
	if name, _ := row["name"].(string); name != "pdf-extract" {
		t.Errorf("catalogue name = %v", name)
	}
	if description, _ := row["description"].(string); description != "提取 PDF 文本。" {
		t.Errorf("catalogue description = %v", description)
	}

	// A later snapshot does not re-scan: the field is absent, not empty.
	if _, present := runtimeValue.StateMessage(false)["skill_catalog"]; present {
		t.Error("a later snapshot re-sent the catalogue")
	}
}

// okResult distinguishes "the load happened" from a board refusal (unknown
// name, full), which arrives as plain text like the other tools do.
func okResult(result tools.Result) bool {
	return result.Audit["skill_action"] == "load"
}
