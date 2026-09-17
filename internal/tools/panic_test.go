package tools

import (
	"strings"
	"testing"
)

// A panic inside a handler is a bug, and it must not end the session.
//
// Go panics are not errors: unrecovered, one bad index or one malformed regexp in
// one tool exits the process — mid-turn, with no answer and a stack trace instead
// of a sentence. The recovery turns it into what every other tool failure is: text
// the model can read, and a turn that continues with the rest of the batch.
func TestAPanickingHandlerBecomesAnErrorNotAnExit(t *testing.T) {
	tool := Tool{
		Name:        "explodes",
		Description: "for the test",
		Risk:        "low",
		Schema:      EmptySchema(),
		Handler: func(map[string]any) (Result, error) {
			var empty []string
			return Result{Text: empty[3]}, nil // index out of range
		},
	}
	if err := NewRegistry().Register(tool); err != nil {
		t.Fatalf("registration: %v", err)
	}

	result, err := tool.Execute(map[string]any{})
	if err == nil {
		t.Fatal("a panicking handler returned no error, so the caller would treat it as success")
	}
	if !strings.Contains(err.Error(), "explodes") {
		t.Fatalf("the error does not name the tool: %v", err)
	}
	if strings.TrimSpace(result.Text) != "" {
		t.Fatalf("a panicking handler produced text: %q", result.Text)
	}
}

// TestARegistryOfPanickingToolsIsStillUsable: the point of recovering here is that
// the next tool in the batch still runs.
func TestARegistryOfPanickingToolsIsStillUsable(t *testing.T) {
	exploding := Tool{
		Name: "boom", Description: "x", Risk: "low", Schema: EmptySchema(),
		Handler: func(map[string]any) (Result, error) { panic("deliberate") },
	}
	working := Tool{
		Name: "fine", Description: "x", Risk: "low", Schema: EmptySchema(),
		Handler: func(map[string]any) (Result, error) { return TextResult("answered"), nil },
	}

	if _, err := exploding.Execute(map[string]any{}); err == nil {
		t.Fatal("the panicking tool did not fail")
	}
	result, err := working.Execute(map[string]any{})
	if err != nil || result.Text != "answered" {
		t.Fatalf("the next tool did not run: %q / %v", result.Text, err)
	}
}
