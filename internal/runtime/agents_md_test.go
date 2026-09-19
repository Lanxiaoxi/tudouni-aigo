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
	if !strings.Contains(text, state.AgentMDName) {
		t.Errorf("the notice does not name the file: %q", text)
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
