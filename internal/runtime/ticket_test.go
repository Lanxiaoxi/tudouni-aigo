package runtime

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
)

// ticketRuntime builds the smallest runtime that can bind a ticket: a registry, a
// session, and a real store so a checkpoint really lands on disk.
func ticketRuntime(t *testing.T) (*Runtime, *state.SessionStore) {
	t.Helper()
	store, err := state.NewSessionStore(filepath.Join(t.TempDir(), "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	return &Runtime{
		SessionIDValue: "20260101-000000",
		SessionValue:   state.NewEmptySession("20260101-000000"),
		Store:          store,
		Tools:          tools.NewRegistry(),
	}, store
}

func hasTicketReport(r *Runtime) bool {
	_, present := r.Tools.Get(builtin.TicketReportToolName)
	return present
}

func bindSpec(id string) map[string]any {
	return map[string]any{"id": id, "title": "Fix reconnect", "brief": "make the websocket reconnect"}
}

func callReport(t *testing.T, r *Runtime, args map[string]any) (tools.Result, error) {
	t.Helper()
	tool, ok := r.Tools.Get(builtin.TicketReportToolName)
	if !ok {
		t.Fatal("ticket_report is not registered")
	}
	return tool.Execute(context.Background(), args)
}

func TestBindingRegistersAndUnbindingUnregistersTheTool(t *testing.T) {
	r, _ := ticketRuntime(t)
	if hasTicketReport(r) {
		t.Fatal("ticket_report was registered before anything was bound")
	}
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatal(err)
	}
	if !hasTicketReport(r) {
		t.Fatal("binding did not register ticket_report")
	}
	// A second bind of the same ticket must not trip over the registration.
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatalf("re-binding the same ticket failed: %v", err)
	}
	if err := r.BindTicket(nil); err != nil {
		t.Fatal(err)
	}
	if hasTicketReport(r) {
		t.Fatal("unbinding left ticket_report registered")
	}
	if _, ok := r.ticket(); ok {
		t.Fatal("unbinding left the record in metadata")
	}
}

func TestBlockedWithoutAQuestionIsRefused(t *testing.T) {
	r, _ := ticketRuntime(t)
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatal(err)
	}
	_, err := callReport(t, r, map[string]any{"status": "blocked", "summary": "stuck"})
	if err == nil {
		t.Fatal("a blocked report without a question was accepted")
	}
	if !strings.Contains(err.Error(), "question") {
		t.Errorf("the refusal does not say why: %v", err)
	}
	if _, err := callReport(t, r, map[string]any{"status": "done"}); err == nil {
		t.Error("a report without a summary was accepted")
	}
	if ticket, _ := r.ticket(); len(ticket.Reports) != 0 {
		t.Errorf("a refused call left reports behind: %v", ticket.Reports)
	}
}

// The ordering rule: by the time the front end hears about a report, the session
// file already holds it.
func TestAReportIsOnDiskBeforeItIsAnnounced(t *testing.T) {
	r, store := ticketRuntime(t)
	var announced []map[string]any
	var onDiskAtAnnounce []state.TicketReport
	r.onTicketEvent = func(payload map[string]any) {
		announced = append(announced, payload)
		loaded, err := store.Load(r.SessionIDValue)
		if err != nil {
			t.Errorf("the session file could not be loaded at announce time: %v", err)
			return
		}
		ticket, _ := state.LoadTicket(loaded.Metadata)
		onDiskAtAnnounce = ticket.Reports
	}
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatal(err)
	}

	result, err := callReport(t, r, map[string]any{
		"status": "blocked", "summary": "need a decision", "question": "which port?",
		"evidence": []any{"go test ./..."},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Text, "rpt-") {
		t.Errorf("the model was not told the report id: %q", result.Text)
	}
	if len(announced) != 1 {
		t.Fatalf("%d announcements, want 1", len(announced))
	}
	if len(onDiskAtAnnounce) != 1 || onDiskAtAnnounce[0].ID != announced[0]["report_id"] {
		t.Fatalf("at announce time the file held %v, want the announced report", onDiskAtAnnounce)
	}

	got := announced[0]
	if got["kind"] != "ticket_report" || got["ticket_id"] != "tk-1" || got["session_id"] != r.SessionIDValue {
		t.Errorf("announcement identity wrong: %v", got)
	}
	if got["status"] != "blocked" || got["summary"] != "need a decision" || got["question"] != "which port?" {
		t.Errorf("announcement content wrong: %v", got)
	}
	if evidence, _ := got["evidence"].([]any); len(evidence) != 1 || evidence[0] != "go test ./..." {
		t.Errorf("evidence = %v", got["evidence"])
	}
	if at, _ := got["at_ms"].(int64); at <= 0 {
		t.Errorf("at_ms = %v", got["at_ms"])
	}

	// A done report: question is null, evidence is an empty list, never absent.
	announced = nil
	if _, err := callReport(t, r, map[string]any{"status": "done", "summary": "fixed", "question": "ignored"}); err != nil {
		t.Fatal(err)
	}
	done := announced[0]
	if done["question"] != nil {
		t.Errorf("a done report carried question %v, want null", done["question"])
	}
	if evidence, ok := done["evidence"].([]any); !ok || len(evidence) != 0 {
		t.Errorf("evidence = %#v, want an empty list", done["evidence"])
	}
	if ticket, _ := r.ticket(); len(ticket.Reports) != 2 {
		t.Errorf("metadata holds %d reports, want 2", len(ticket.Reports))
	}
}

// The race the design names: the model's call lands after the unbind. The registry
// has been updated by then in the ordinary case; this exercises the tool's own check.
func TestAReportAfterTheUnbindIsRefused(t *testing.T) {
	r, _ := ticketRuntime(t)
	var announced int
	r.onTicketEvent = func(map[string]any) { announced++ }
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatal(err)
	}
	// Take the tool while it is still registered, as a turn that began before the
	// unbind would have.
	tool, _ := r.Tools.Get(builtin.TicketReportToolName)
	if err := r.BindTicket(nil); err != nil {
		t.Fatal(err)
	}
	result, err := tool.Execute(context.Background(), map[string]any{"status": "done", "summary": "late"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Text, "no longer bound") {
		t.Errorf("the refusal does not say the session was unbound: %q", result.Text)
	}
	if announced != 0 {
		t.Error("a report was announced after the unbind")
	}
	if _, ok := r.ticket(); ok {
		t.Error("the late report resurrected the binding")
	}
}

func TestRebindingTheSameTicketKeepsItsReportsAndANewOneClearsThem(t *testing.T) {
	r, _ := ticketRuntime(t)
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatal(err)
	}
	if _, err := callReport(t, r, map[string]any{"status": "done", "summary": "x"}); err != nil {
		t.Fatal(err)
	}
	if err := r.BindTicket(map[string]any{"id": "tk-1", "title": "renamed", "brief": "b"}); err != nil {
		t.Fatal(err)
	}
	ticket, _ := r.ticket()
	if ticket.Title != "renamed" || len(ticket.Reports) != 1 {
		t.Errorf("same-id rebind: %+v", ticket)
	}
	if err := r.BindTicket(bindSpec("tk-2")); err != nil {
		t.Fatal(err)
	}
	ticket, _ = r.ticket()
	if ticket.ID != "tk-2" || len(ticket.Reports) != 0 {
		t.Errorf("a different ticket kept the old reports: %+v", ticket)
	}
}

func TestTheBindingCarriesAnOversizedBriefOnlyUpToTheCeiling(t *testing.T) {
	r, _ := ticketRuntime(t)
	err := r.BindTicket(map[string]any{"id": "tk-1", "brief": strings.Repeat("x", state.TicketBriefCeiling+1)})
	if err == nil {
		t.Fatal("an oversized brief was accepted")
	}
	if hasTicketReport(r) {
		t.Error("a refused bind registered the tool")
	}
}

func TestInitCarriesTheTicket(t *testing.T) {
	r, _ := ticketRuntime(t)
	r.Chat = nil // InitFields is exercised through ticketInit; the rest needs a model.

	if got := r.ticketInit(); got != nil {
		t.Errorf("unbound init.ticket = %#v, want nil (JSON null)", got)
	}
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatal(err)
	}
	if _, err := callReport(t, r, map[string]any{
		"status": "blocked", "summary": "s", "question": "q?",
	}); err != nil {
		t.Fatal(err)
	}
	block, ok := r.ticketInit().(map[string]any)
	if !ok {
		t.Fatalf("init.ticket = %#v", r.ticketInit())
	}
	if block["id"] != "tk-1" || block["title"] != "Fix reconnect" || block["brief"] != "make the websocket reconnect" {
		t.Errorf("init.ticket identity: %v", block)
	}
	reports, _ := block["reports"].([]any)
	if len(reports) != 1 {
		t.Fatalf("reports = %v", block["reports"])
	}
	row := reports[0].(map[string]any)
	for _, key := range []string{"report_id", "status", "summary", "question", "evidence", "at_ms"} {
		if _, present := row[key]; !present {
			t.Errorf("init.ticket.reports[0] lacks %q: %v", key, row)
		}
	}
	if row["question"] != "q?" || row["status"] != "blocked" {
		t.Errorf("report row: %v", row)
	}
}

func TestTheTicketReachesThePayloadTailOnlyWhileBound(t *testing.T) {
	r, _ := ticketRuntime(t)
	if note := r.notes(); strings.Contains(note, "ticket_report") {
		t.Fatalf("an unbound session was charged for the ticket note:\n%s", note)
	}
	if err := r.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatal(err)
	}
	note := r.notes()
	for _, want := range []string{"Fix reconnect", "make the websocket reconnect", "ticket_report"} {
		if !strings.Contains(note, want) {
			t.Errorf("the payload tail lacks %q:\n%s", want, note)
		}
	}
	// It is the tail, not the conversation.
	for _, message := range r.SessionValue.MessagesSnapshot() {
		if text, _ := state.MessageText(message); strings.Contains(text, "make the websocket reconnect") {
			t.Error("the ticket note entered session.Messages")
		}
	}
	if err := r.BindTicket(nil); err != nil {
		t.Fatal(err)
	}
	if note := r.notes(); strings.Contains(note, "ticket_report") {
		t.Errorf("the note outlived the unbind:\n%s", note)
	}
}

// The assembled path: bind, close, reopen from the file the way /resume does.
func TestTheBindingAndTheToolSurviveAResume(t *testing.T) {
	scene := newSandbox(t)
	store, err := state.NewSessionStore(filepath.Join(scene.Workspace, ".tudouni", "test-sessions"))
	if err != nil {
		t.Fatal(err)
	}
	booted := Booted{Store: store}

	first, err := OpenRuntime(Options{Booted: booted, Session: state.NewEmptySession("20260101-120000")})
	if err != nil {
		t.Fatalf("assembling: %v", err)
	}
	t.Cleanup(func() { _ = first.Jobs.Close() })
	if hasTicketReport(first) {
		t.Fatal("a fresh session already had ticket_report")
	}
	if err := first.BindTicket(bindSpec("tk-1")); err != nil {
		t.Fatal(err)
	}
	if _, err := callReport(t, first, map[string]any{"status": "done", "summary": "fixed"}); err != nil {
		t.Fatal(err)
	}

	path, err := store.Path("20260101-120000")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the session file was never written: %v", err)
	}

	loaded, err := store.Load("20260101-120000")
	if err != nil {
		t.Fatal(err)
	}
	second, err := OpenRuntime(Options{Booted: booted, Session: loaded, Resumed: true})
	if err != nil {
		t.Fatalf("reopening: %v", err)
	}
	t.Cleanup(func() { _ = second.Jobs.Close() })

	if !hasTicketReport(second) {
		t.Fatal("the resumed session did not get ticket_report back")
	}
	init := second.InitFields()
	block, ok := init["ticket"].(map[string]any)
	if !ok {
		t.Fatalf("init.ticket after resume = %#v", init["ticket"])
	}
	if block["id"] != "tk-1" {
		t.Errorf("init.ticket.id = %v", block["id"])
	}
	if reports, _ := block["reports"].([]any); len(reports) != 1 {
		t.Errorf("the resumed session lost its reports: %v", block["reports"])
	}

	// An unbound session says null, and the key is present.
	third, err := OpenRuntime(Options{Booted: booted, Session: state.NewEmptySession("20260101-130000")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = third.Jobs.Close() })
	value, present := third.InitFields()["ticket"]
	if !present || value != nil {
		t.Errorf("unbound init.ticket = %#v (present=%v), want a present null", value, present)
	}
}
