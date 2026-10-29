package agent

import (
	"path/filepath"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/context"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// TestContextPartsAddUpToMeasure is the one rule the breakdown exists to keep:
// the rows printed under "used" are the number printed as "used".
//
// It walks the same harness `Measure` is tested against — a system prompt, a
// user message, one artifact in the ledger and a trailing note — so the sum is a
// statement about this request rather than about a number chosen to match.
func TestContextPartsAddUpToMeasure(t *testing.T) {
	workspace := t.TempDir()
	store := context.OpenArtifactStore(filepath.Join(workspace, "artifacts"), nil)
	tokens := 200_000
	manager := context.NewManager(store, nil, context.NewBudget(&tokens), nil)

	command, err := store.Create("total 0\ndrwxr-xr-x  2 user user 4096 .\n", "command",
		context.ArtifactSource{Tool: "run_command"}, map[string]any{"command": "ls -l"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	manager.Add(command.ID, context.AddOptions{})

	session := state.NewEmptySession("s")
	session.Append(map[string]any{"role": "system", "content": "you are a test"})
	session.Append(map[string]any{"role": "user", "content": "what is in this directory"})
	session.Append(map[string]any{
		"role": "assistant", "content": "let me look",
	})
	session.Append(map[string]any{
		"role":    "tool",
		"content": "see art row",
		"artifact_id": command.ID,
	})

	agent := New(Config{
		Chat:     &fakeModel{},
		Tools:    tools.NewRegistry(),
		Policy:   security.NewPolicy(),
		Session:  session,
		Context:  manager,
		MaxSteps: 1,
		Notes:    func() string { return "task: look around" },
	})

	parts := agent.ContextParts()
	if len(parts) == 0 {
		t.Fatal("ContextParts said nothing about a request that has a system prompt and a ledger")
	}
	sum := 0
	seen := map[string]int{}
	for _, part := range parts {
		if part.Tokens <= 0 {
			t.Fatalf("part %q carries %d tokens; a zero row is a claim about nothing", part.Key, part.Tokens)
		}
		if seen[part.Key] != 0 {
			t.Fatalf("part %q appears twice", part.Key)
		}
		seen[part.Key] = part.Tokens
		sum += part.Tokens
	}

	if measured := agent.Measure(); sum != measured {
		t.Fatalf("the parts add up to %d but Measure says %d", sum, measured)
	}
	for _, key := range []string{PartSystem, PartMessages, PartCommands, PartNote} {
		if seen[key] == 0 {
			t.Fatalf("part %q is missing from a request that carries one: %v", key, seen)
		}
	}
	// The tool body is in the ledger, so the tool message is only its reference
	// line — which is still a part of the request.
	if seen[PartToolResults] == 0 {
		t.Fatalf("the tool message's reference line was not priced: %v", seen)
	}
}

// TestContextPartsIsOrderedLargestFirst pins the order the panel draws: the row
// a reader looks at first is the one that costs the most.
func TestContextPartsIsOrderedLargestFirst(t *testing.T) {
	workspace := t.TempDir()
	store := context.OpenArtifactStore(filepath.Join(workspace, "artifacts"), nil)
	manager := context.NewManager(store, nil, context.NewBudget(nil), nil)

	big, err := store.Create(stringOf('x', 40_000), "file",
		context.ArtifactSource{Tool: "read_file"}, nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	manager.Add(big.ID, context.AddOptions{})

	session := state.NewEmptySession("s")
	session.Append(map[string]any{"role": "system", "content": "short"})
	session.Append(map[string]any{"role": "user", "content": "hi"})

	agent := New(Config{
		Chat:     &fakeModel{},
		Tools:    tools.NewRegistry(),
		Policy:   security.NewPolicy(),
		Session:  session,
		Context:  manager,
		MaxSteps: 1,
	})

	parts := agent.ContextParts()
	if len(parts) < 2 {
		t.Fatalf("expected several parts, got %v", parts)
	}
	for i := 1; i < len(parts); i++ {
		if parts[i-1].Tokens < parts[i].Tokens {
			t.Fatalf("parts are not ordered largest first: %v", parts)
		}
	}
	if parts[0].Key != PartFiles {
		t.Fatalf("a 40k-character file should lead the breakdown, got %q", parts[0].Key)
	}
}

// TestContextPartsSaysNothingWithoutALedger keeps "there is no breakdown here"
// distinct from "the breakdown is empty": the panel draws the second as zeroes,
// which is a claim that the context system is on and doing nothing.
func TestContextPartsWithoutALedger(t *testing.T) {
	session := state.NewEmptySession("s")
	session.Append(map[string]any{"role": "user", "content": "hello there"})

	agent := New(Config{
		Chat:     &fakeModel{},
		Tools:    tools.NewRegistry(),
		Policy:   security.NewPolicy(),
		Session:  session,
		MaxSteps: 1,
	})
	if parts := agent.ContextParts(); parts != nil {
		t.Fatalf("no ledger means no breakdown, got %v", parts)
	}
}

// TestContextPartsOfAPlainExchange is the smallest real case: history only. Every
// token belongs to the messages, and the row still adds up.
func TestContextPartsOfAPlainExchange(t *testing.T) {
	manager := context.NewManager(context.OpenArtifactStore(filepath.Join(t.TempDir(), "a"), nil),
		nil, context.NewBudget(nil), nil)
	session := state.NewEmptySession("s")
	session.Append(map[string]any{"role": "system", "content": "short prompt"})
	session.Append(map[string]any{"role": "user", "content": "hello there"})

	agent := New(Config{
		Chat:     &fakeModel{},
		Tools:    tools.NewRegistry(),
		Policy:   security.NewPolicy(),
		Session:  session,
		Context:  manager,
		MaxSteps: 1,
	})

	parts := agent.ContextParts()
	if len(parts) != 2 {
		t.Fatalf("a system prompt and one question are two parts, got %v", parts)
	}
	sum := 0
	for _, part := range parts {
		sum += part.Tokens
	}
	if sum != agent.Measure() {
		t.Fatalf("the parts add up to %d but Measure says %d", sum, agent.Measure())
	}
}

func stringOf(ch rune, n int) string {
	out := make([]rune, n)
	for i := range out {
		out[i] = ch
	}
	return string(out)
}
