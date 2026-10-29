package runtime

import (
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/agent"
	ctxwin "github.com/Lanxiaoxi/tudouni-aigo/internal/context"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// brokenDownRuntime is a runtime that has both halves of the context screen: a
// ledger, and an agent to decompose the request it is reporting.
//
// The agent is built here rather than through Compose for the same reason
// `effortRuntime` is: the property under test is what this layer sends, and a
// runtime assembled by the production path drags in a workspace, a policy and a
// model. `Context` is the ledger the harness already made.
func brokenDownRuntime(t *testing.T) *Runtime {
	t.Helper()
	runtimeValue := budgetRuntime(t, "big")

	runtimeValue.Agent = agent.New(agent.Config{
		Chat:      runtimeValue.Chat,
		Tools:     tools.NewRegistry(),
		Session:   runtimeValue.SessionValue,
		Context:   runtimeValue.ContextValue,
		Processor: ctxwin.DefaultProcessor(),
	})

	runtimeValue.SessionValue.Messages = append(runtimeValue.SessionValue.Messages,
		map[string]any{"role": "system", "content": "你是 Tudouni，一个在终端里干活的助手。"},
		map[string]any{"role": "user", "content": "看一下 main.go 的入口在哪里"},
		map[string]any{"role": "assistant", "content": "入口在 run() 里。"},
	)
	return runtimeValue
}

// TestTheContextPayloadCarriesTheBreakdown is the wire contract the panel draws.
//
// The rows are the point, so the assertions are about them: every row is a
// `{key, tokens}` pair, the keys are the runtime's own untranslated names, and —
// the one that matters — **the rows add up to `estimated_tokens`**. That last one
// is what lets the interface print a bar and a headline from one message: a
// breakdown that summed to something else would be a chart that disagrees with
// the number printed above it, and the reader has no way to tell which is wrong.
//
// The fixture has never sent a request, which is the state `/context` is opened
// in on a restored session: `contextPayload` measures before reporting, so the
// two numbers are fresh rather than "zero under a list of rows".
func TestTheContextPayloadCarriesTheBreakdown(t *testing.T) {
	runtimeValue := brokenDownRuntime(t)

	payload := runtimeValue.contextPayload()
	ledger, ok := payload["context"].(map[string]any)
	if !ok {
		t.Fatalf("context is %T, want the ledger object", payload["context"])
	}
	used, ok := ledger["estimated_tokens"].(int)
	if !ok || used <= 0 {
		t.Fatalf("estimated_tokens is %v; a session with history must not report zero", ledger["estimated_tokens"])
	}

	rows, ok := payload["parts"].([]any)
	if !ok {
		t.Fatalf("parts is %T, want a list (the panel draws rows from it)", payload["parts"])
	}
	if len(rows) == 0 {
		t.Fatal("parts is empty; a request with a system prompt and history has shares")
	}

	known := map[string]bool{
		agent.PartSystem: true, agent.PartMessages: true, agent.PartToolResults: true,
		agent.PartSummary: true, agent.PartNote: true, agent.PartFiles: true,
		agent.PartCommands: true, agent.PartSearch: true, agent.PartImages: true,
	}

	total := 0
	previous := -1
	seen := map[string]bool{}
	for _, raw := range rows {
		row, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("a part is %T, want an object", raw)
		}
		key, ok := row["key"].(string)
		if !ok {
			t.Fatalf("a part has no string key: %#v", row)
		}
		tokens, ok := row["tokens"].(int)
		if !ok {
			t.Fatalf("part %q has tokens of type %T, want an int", key, row["tokens"])
		}
		if !known[key] {
			t.Errorf("part %q is not one of the runtime's part names — the panel would draw it raw", key)
		}
		if seen[key] {
			t.Errorf("part %q appears twice", key)
		}
		seen[key] = true
		if tokens <= 0 {
			t.Errorf("part %q is %d tokens; zero rows must be dropped, not sent", key, tokens)
		}
		if previous >= 0 && tokens > previous {
			t.Errorf("part %q (%d) follows a smaller one (%d): the rows are not largest first", key, tokens, previous)
		}
		previous = tokens
		total += tokens
	}

	if total != used {
		t.Errorf("the parts add up to %d but estimated_tokens says %d: the panel's rows would not "+
			"match the number printed above them", total, used)
	}

	// The two rows this fixture must have: the system prompt is always there, and
	// so is the conversation. If either is missing the arithmetic above passed by
	// luck rather than by covering them.
	if !seen[agent.PartSystem] {
		t.Error("no system row; the system prompt is part of every request")
	}
	if !seen[agent.PartMessages] {
		t.Error("no messages row; the fixture has history")
	}
	// Zeros are dropped, and this session has no pictures and was never compacted.
	if seen[agent.PartImages] || seen[agent.PartSummary] {
		t.Error("a row that costs nothing was sent")
	}
}

// TestTheBreakdownSitsInsideTheContextFeature pins the nesting, because the
// front end reaches for `context.parts` and nothing else.
//
// `ContextMessage` returns the *feature* — the object that also carries
// `window`/`messages` — and the ledger is its `context` key. A `parts` list sent
// one level higher would be invisible to every reader of the panel, and the panel
// would show the rows only on the in-stream `/context` block.
func TestTheBreakdownSitsInsideTheContextFeature(t *testing.T) {
	runtimeValue := brokenDownRuntime(t)

	feature, ok := runtimeValue.ContextMessage()["context"].(map[string]any)
	if !ok {
		t.Fatal("ContextMessage has no context feature")
	}
	if _, present := feature["parts"]; !present {
		t.Error("the feature has no parts; they are sitting somewhere the panel does not read")
	}
	if window, _ := feature["window"].(int); window != 500000 {
		t.Errorf("window = %v, want the model's 500000", feature["window"])
	}
}

// TestARuntimeWithoutAnAgentSendsNoBreakdown keeps "this runtime does not break
// the request down" distinct from "there is nothing in the request".
//
// Absent, not empty: an empty list is a claim that the request is made of no
// parts, and the panel would draw an empty bar over a ledger with a real token
// count in it. The ledger itself still travels — it is the part that was there
// before.
func TestARuntimeWithoutAnAgentSendsNoBreakdown(t *testing.T) {
	runtimeValue := budgetRuntime(t, "big")
	runtimeValue.Agent = nil

	payload := runtimeValue.contextPayload()
	if _, present := payload["parts"]; present {
		t.Errorf("a runtime with no agent sent parts: %#v", payload["parts"])
	}
	if _, present := payload["context"]; !present {
		t.Error("the ledger was dropped along with the breakdown")
	}
}
