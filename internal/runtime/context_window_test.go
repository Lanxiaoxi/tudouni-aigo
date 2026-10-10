package runtime

import (
	"path/filepath"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/context"
)

// The context budget must follow the model, not the model the session happened
// to open on.
//
// This is the regression for a real report: a session on a 524288-token model
// compacted its history at ~200k. The arithmetic in the ledger made it plain —
// `limit_tokens` was 232243, which is (262144−4096)×0.9, the number belonging to
// the config's *first* model — while `window` on the same screen said 524288.
// The budget is built once, at assembly, and a `/model` moved the adapter, the
// session record and the audit but left the budget behind.
const twoWindowsConfig = `{
	"providers": {
		"p": {
			"base_url": "https://api.example",
			"api_key": "k",
			"models": [
				{"id": "small", "context_window": 100000},
				{"id": "big", "context_window": 500000},
				{"id": "windowless"}
			]
		}
	}
}`

// budgetRuntime is a runtime that has a context layer, opened on `current`.
func budgetRuntime(t *testing.T, current string) *Runtime {
	t.Helper()
	runtimeValue, _ := effortRuntime(t, twoWindowsConfig, current)
	store := context.OpenArtifactStore(filepath.Join(t.TempDir(), "artifacts"), nil)
	runtimeValue.ContextValue = context.NewManager(store, nil,
		context.NewBudget(windowFor(current, "p", runtimeValue.Catalog)), nil)
	return runtimeValue
}

// TestSwitchingModelRebindsTheContextBudget is the fix: after a switch, the
// budget sizes against the model being talked to.
func TestSwitchingModelRebindsTheContextBudget(t *testing.T) {
	runtimeValue := budgetRuntime(t, "small")

	opened := runtimeValue.ContextValue.Budget.EffectiveLimit()
	if opened != (100000-4096)*9/10 {
		t.Fatalf("the budget opened at limit %d, want the small model's window", opened)
	}

	if ok, message := runtimeValue.SetModel("big"); !ok {
		t.Fatalf("switching to big failed: %s", message)
	}

	if got, want := runtimeValue.ContextValue.Budget.EffectiveLimit(), (500000-4096)*9/10; got != want {
		t.Errorf("after switching to a 500k model the limit is %d, want %d — "+
			"the budget is still sizing against the old model", got, want)
	}
	// The window reported to the front end and the window the budget uses are
	// the same fact, so they must agree.
	if window, _ := runtimeValue.modelWindow().(int); window != 500000 {
		t.Errorf("the reported window is %v, want 500000", runtimeValue.modelWindow())
	}
}

// TestSwitchingToAModelWithNoWindowTurnsTheBudgetOff guards the other direction:
// keeping the previous ceiling would degrade a context that fits, under a model
// the session is no longer talking to.
func TestSwitchingToAModelWithNoWindowTurnsTheBudgetOff(t *testing.T) {
	runtimeValue := budgetRuntime(t, "small")

	if ok, message := runtimeValue.SetModel("windowless"); !ok {
		t.Fatalf("switching to windowless failed: %s", message)
	}

	if runtimeValue.ContextValue.Budget.Enabled() {
		t.Errorf("a model declaring no window left the budget on (limit %d): "+
			"it is sizing against a model this session is not using",
			runtimeValue.ContextValue.Budget.EffectiveLimit())
	}
	if runtimeValue.modelWindow() != nil {
		t.Errorf("a model declaring no window reported %v", runtimeValue.modelWindow())
	}
}

// TestRebindingTheBudgetIsSafeWithoutAContextLayer keeps a runtime assembled
// without context management from panicking on a model switch.
func TestRebindingTheBudgetIsSafeWithoutAContextLayer(t *testing.T) {
	runtimeValue, _ := effortRuntime(t, twoWindowsConfig, "small")
	if runtimeValue.ContextValue != nil {
		t.Fatal("the harness grew a context layer; this test no longer covers its case")
	}
	if ok, message := runtimeValue.SetModel("big"); !ok {
		t.Fatalf("switching without a context layer failed: %s", message)
	}
}
