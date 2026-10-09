package runtime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// writeAgentMD puts an AGENT.md in a fresh workspace and returns the path.
func writeAgentMD(t *testing.T, body string) string {
	t.Helper()
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, state.AgentMDName), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return workspace
}

// writeAgentMDFile puts one named file in a workspace the caller controls.
func writeAgentMDFile(t *testing.T, workspace, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(workspace, name), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestASessionRecordsWhatItsAgentMDDid is the first half of the wiring that was
// missing: the report reached the system prompt and was then dropped.
//
// Both readers need it and neither can recover it from the prompt text. The startup
// notices name what went in; the rail's session block answers "did my AGENT.md take
// effect" long after the notice has scrolled away. Reading it back from the session
// rather than from disk is what makes a restored session describe the prompt it
// actually carries.
func TestASessionRecordsWhatItsAgentMDDid(t *testing.T) {
	workspace := writeAgentMD(t, "# project\n\nbuild with make\n")
	session := state.NewSession("20260101-120000", workspace)

	block, ok := session.Metadata[state.AgentMDSessionKey].(map[string]any)
	if !ok {
		t.Fatalf("the session did not record its AGENT.md report: %#v", session.Metadata)
	}
	loaded, _ := block["loaded"].([]any)
	if len(loaded) != 1 {
		t.Fatalf("the report carries %d loaded files, want 1: %#v", len(loaded), block)
	}
	// And the txt the rail draws its rows from is no longer empty.
	rows := state.AgentMDForDisplay(session.Metadata[state.AgentMDSessionKey], workspace)
	if len(rows) == 0 {
		t.Error("the rail's AGENT.md block would still be empty for a session that loaded one")
	}
}

// TestASessionWithoutAgentMDRecordsNothing: the normal state stays quiet. A session
// with no file must not carry an empty report, or every session would draw a rail row
// and a notice for a file that does not exist.
func TestASessionWithoutAgentMDRecordsNothing(t *testing.T) {
	session := state.NewSession("20260101-120000", t.TempDir())
	if _, present := session.Metadata[state.AgentMDSessionKey]; present {
		t.Errorf("a session with no AGENT.md recorded a report: %#v", session.Metadata)
	}
}

// TestTheAgentMDNoticesAreActuallyEmitted is the second half: the reporter existed
// and was never called, so a file that was oversized or unreadable silently did
// nothing.
//
// That is the failure the design notes single out — a file that is clearly present
// and has no effect sends a person looking for the problem in the prompt, or in the
// model, rather than in the file that was skipped.
func TestTheAgentMDNoticesAreActuallyEmitted(t *testing.T) {
	workspace := writeAgentMD(t, "# project\n")
	session := state.NewSession("20260101-120000", workspace)

	notices := agentMDNotices(session)
	if len(notices) == 0 {
		t.Fatal("the session loaded an AGENT.md and no notice was produced for it")
	}
	if level, _ := notices[0]["level"].(string); level == "" {
		t.Errorf("the notice has no level: %#v", notices[0])
	}
	if stream, _ := notices[0]["stream"].(string); stream != "err" {
		t.Errorf("the notice is on stream %q, want err — it is a diagnostic, not conversation", stream)
	}
	text, _ := notices[0]["text"].(string)
	if !strings.Contains(text, "["+state.AgentMDName+"]") {
		t.Errorf("the notice is not tagged with the file it is about: %q", text)
	}
	if strings.Contains(text, "⟪") {
		t.Errorf("the notice is a missing i18n key: %q", text)
	}
}

// TestAnOversizedAgentMDIsReportedNotSilent: the file is present and refused, and
// that is exactly the case that used to say nothing at all.
func TestAnOversizedAgentMDIsReportedNotSilent(t *testing.T) {
	workspace := writeAgentMD(t, strings.Repeat("x", int(state.AgentMDMaxBytes)+1))
	session := state.NewSession("20260101-120000", workspace)

	notices := agentMDNotices(session)
	if len(notices) == 0 {
		t.Fatal("an AGENT.md that was too big to read produced no notice")
	}
	var warned bool
	for _, item := range notices {
		if level, _ := item["level"].(string); level == "warn" {
			warned = true
		}
	}
	if !warned {
		t.Errorf("a skipped AGENT.md is not reported as a warning: %#v", notices)
	}
}

// TestAgentMDNoticesSurviveASessionRoundTrip is the reason the report is stored
// rather than recomputed: a resumed session must describe the prompt it was created
// with, not whatever the file says today.
func TestAgentMDNoticesSurviveASessionRoundTrip(t *testing.T) {
	workspace := writeAgentMD(t, "# project\n")
	original := state.NewSession("20260101-120000", workspace)

	// The file changes after the session was built — the common case for a resumed
	// session, where the user has edited AGENT.md since.
	if err := os.WriteFile(filepath.Join(workspace, state.AgentMDName), []byte("# rewritten\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	restored := state.NewEmptySession("20260101-120000")
	restored.Metadata = original.Metadata
	notices := agentMDNotices(restored)
	if len(notices) == 0 {
		t.Fatal("a restored session lost the record of what its prompt carries")
	}
	// The file itself is never named in a way that depends on its current contents,
	// and every line still carries the code the front ends group by.
	for _, item := range notices {
		if code, _ := item["code"].(string); code != "agent_md" {
			t.Errorf("a notice is coded %q, want agent_md", code)
		}
	}
}

// TestABothSpellingsWorkspaceUsesAgentsMD: the reason this feature exists is that a
// workspace arriving with only `AGENTS.md` used to have no instructions at all. The
// same workspace with both files has to pick one, and the pick is the one the user
// asked for.
func TestABothSpellingsWorkspaceUsesAgentsMD(t *testing.T) {
	workspace := t.TempDir()
	writeAgentMDFile(t, workspace, state.AgentMDAltName, "# agents\n\nrun make test\n")
	writeAgentMDFile(t, workspace, state.AgentMDName, "# agent\n\nrun make build\n")

	session := state.NewSession("20260101-120000", workspace)
	message := session.Messages[0]["content"].(string)
	if !strings.Contains(message, "run make test") {
		t.Errorf("the prompt does not carry AGENTS.md: %q", message)
	}
	if strings.Contains(message, "run make build") {
		t.Error("the prompt carries the lower-priority AGENT.md as well")
	}
	// The heading and the fence name the file that was read, or the model goes off
	// to `read_file AGENT.md` and finds a different document.
	if !strings.Contains(message, state.AgentMDAltName) {
		t.Errorf("the injected block does not name the file it came from: %q", message)
	}
	if !strings.Contains(message, agentMDSectionTitleToken(state.AgentMDAltName)) {
		t.Errorf("the section title does not name the file: %q", message)
	}

	// And the file that lost is reported, not dropped in silence. The tag is what a
	// reader scans for, so the check is on the tag rather than on the name — `AGENT.md`
	// is a substring of `AGENTS.md`, and a plain Contains would pass on the wrong line.
	notices := agentMDNotices(session)
	var ignored map[string]any
	for _, item := range notices {
		if text, _ := item["text"].(string); strings.Contains(text, "["+state.AgentMDName+"]") {
			ignored = item
		}
	}
	if ignored == nil {
		t.Fatalf("nothing told the user that AGENT.md was not read: %#v", notices)
	}
	if level, _ := ignored["level"].(string); level != "warn" {
		t.Errorf("the ignored-file notice is %q, want warn: %#v", level, ignored)
	}
	text, _ := ignored["text"].(string)
	if !strings.Contains(text, state.AgentMDAltName) {
		t.Errorf("the ignored-file notice does not name the winner: %q", text)
	}
	// The winning file's own notice is tagged with its own name, or the line that says
	// what went in points at the file that did not.
	for _, item := range notices {
		if text, _ := item["text"].(string); strings.Contains(text, "loaded") {
			if !strings.HasPrefix(text, "["+state.AgentMDAltName+"]") {
				t.Errorf("the loaded notice is tagged with the wrong file: %q", text)
			}
		}
	}
}

// TestAnAgentsMDAloneWorks: one file, no warning, and the block names it.
func TestAnAgentsMDAloneWorks(t *testing.T) {
	workspace := t.TempDir()
	writeAgentMDFile(t, workspace, state.AgentMDAltName, "# agents\n")

	session := state.NewSession("20260101-120000", workspace)
	message := session.Messages[0]["content"].(string)
	if !strings.Contains(message, "# agents") {
		t.Fatalf("an AGENTS.md-only workspace injected nothing: %q", message)
	}
	if !strings.Contains(message, agentMDSectionTitleToken(state.AgentMDAltName)) {
		t.Errorf("the section title does not name AGENTS.md: %q", message)
	}
	for _, item := range agentMDNotices(session) {
		if text, _ := item["text"].(string); strings.Contains(text, "["+state.AgentMDName+"]") {
			t.Errorf("a single-file workspace warned about the other spelling: %q", text)
		}
	}
}

// TestABrokenAgentsMDDoesNotHideAWorkingAgentMD: the fallback is not a nicety. The
// user can see a perfectly good AGENT.md beside the file that failed, and a session
// that reads neither of them while saying only "cannot read AGENTS.md" leaves them
// with a document they believe is in effect.
func TestABrokenAgentsMDDoesNotHideAWorkingAgentMD(t *testing.T) {
	workspace := t.TempDir()
	if err := os.Mkdir(filepath.Join(workspace, state.AgentMDAltName), 0o700); err != nil {
		t.Fatal(err)
	}
	writeAgentMDFile(t, workspace, state.AgentMDName, "# agent\n\nrun make build\n")

	session := state.NewSession("20260101-120000", workspace)
	message := session.Messages[0]["content"].(string)
	if !strings.Contains(message, "run make build") {
		t.Fatalf("a broken AGENTS.md hid a working AGENT.md: %q", message)
	}
	var failed, loaded bool
	for _, item := range agentMDNotices(session) {
		text, _ := item["text"].(string)
		if strings.HasPrefix(text, "["+state.AgentMDAltName+"]") && strings.Contains(text, "directory") {
			failed = true
		}
		if strings.HasPrefix(text, "["+state.AgentMDName+"]") && strings.Contains(text, "loaded") {
			loaded = true
		}
	}
	if !failed {
		t.Error("the unreadable AGENTS.md was not reported")
	}
	if !loaded {
		t.Error("the file that was actually injected was not reported")
	}
}

// TestAnEmptyAgentsMDFallsThroughToAgentMD: an empty file is "nothing written here",
// which is the same as no file. Treating it as a winner would leave a workspace with
// two files carrying no instructions while a full brief sits one name away.
func TestAnEmptyAgentsMDFallsThroughToAgentMD(t *testing.T) {
	workspace := t.TempDir()
	writeAgentMDFile(t, workspace, state.AgentMDAltName, "")
	writeAgentMDFile(t, workspace, state.AgentMDName, "# agent\n\nrun make build\n")

	session := state.NewSession("20260101-120000", workspace)
	message := session.Messages[0]["content"].(string)
	if !strings.Contains(message, "run make build") {
		t.Fatalf("an empty AGENTS.md blocked AGENT.md: %q", message)
	}
}

// TestTheIgnoredRowReachesTheInterface: the rail reads rows, not notices, and an
// ignored file is a row a person has to be able to see — otherwise the stored report
// says one thing and the screen another.
func TestTheIgnoredRowReachesTheInterface(t *testing.T) {
	workspace := t.TempDir()
	writeAgentMDFile(t, workspace, state.AgentMDAltName, "# agents\n")
	writeAgentMDFile(t, workspace, state.AgentMDName, "# agent\n")

	session := state.NewSession("20260101-120000", workspace)
	rows := state.AgentMDForDisplay(session.Metadata[state.AgentMDSessionKey], workspace)
	var found bool
	for _, row := range rows {
		if status, _ := row["status"].(string); status != "ignored" {
			continue
		}
		found = true
		if path, _ := row["path"].(string); path != state.AgentMDName {
			t.Errorf("the ignored row names %q, want %q", path, state.AgentMDName)
		}
		problem, _ := row["problem"].(string)
		if !strings.Contains(problem, state.AgentMDAltName) {
			t.Errorf("the ignored row does not say who won: %q", problem)
		}
	}
	if !found {
		t.Errorf("no ignored row for the losing file: %#v", rows)
	}
}

// agentMDSectionTitleToken is the part of the section title that names the file.
//
// Written as a helper so the test does not hard-code the Chinese heading: the point
// is that *some* title carries the right name, not that the wording is stable.
func agentMDSectionTitleToken(name string) string { return "（" + name + "）" }
