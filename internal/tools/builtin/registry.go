package builtin

import (
	"fmt"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// Assembly is everything the registry needs from outside.
//
// The capability flags exist so the descriptions can point at their neighbours.
// shell's text tells the model to use shell_background for servers and fetch_web
// for pages — but only when those tools are actually registered. Naming a tool
// that is not in the schema sends the model after something it cannot call, and
// the failure looks like the model being stupid.
//
// A missing dependency means the tool is **absent from the schema**, not present
// and answering "not configured". A tool the model can see but that never works
// costs a round trip every time it is tried, and teaches it that tools lie.
type Assembly struct {
	Workspace *tools.Workspace
	// TodoMetadata is the session metadata the task list is bound to. Nil means no
	// task-list tool.
	TodoMetadata map[string]any
	// Questioner is how ask_user reaches a person. Nil means nobody to ask, which
	// is a normal state, not an error.
	Questioner Questioner

	HasJobs      bool
	HasWebFetch  bool
	HasWebSearch bool

	// Extra holds the tools built by the assembly layer — background jobs, the
	// network tools, the skill loader. They live elsewhere because they own
	// resources (process handles, HTTP clients, a directory scan) that this file
	// has no business constructing.
	Extra []tools.Tool
}

// Result is the registry plus the reasons some tools are missing.
type Result struct {
	Tools *tools.Registry
	// Missing names tools that were not registered, for the startup notices.
	// "The file is right there but does nothing" is the worst failure shape, and a
	// missing ripgrep build or search key is exactly that.
	Missing []string
}

// CreateRegistry builds the tool set for one runtime.
//
// Registration order does not matter: the registry sorts by name, so the schema
// the model sees is stable between runs and a diff of two sessions means
// something.
func CreateRegistry(assembly Assembly) (*Result, error) {
	registry := tools.NewRegistry()
	result := &Result{Tools: registry}

	if assembly.Workspace == nil {
		return nil, fmt.Errorf("a tool registry needs a workspace")
	}

	for _, tool := range NewFileTools(assembly.Workspace) {
		if err := registry.Register(tool); err != nil {
			return nil, err
		}
	}
	if err := registry.Register(NewGetCurrentTime()); err != nil {
		return nil, err
	}
	if err := registry.Register(NewAskUser(assembly.Questioner)); err != nil {
		return nil, err
	}
	if assembly.TodoMetadata != nil {
		if err := registry.Register(NewTodo(assembly.TodoMetadata)); err != nil {
			return nil, err
		}
	}
	if err := registry.Register(NewShell(assembly.Workspace,
		assembly.HasJobs, assembly.HasWebFetch, assembly.HasWebSearch)); err != nil {
		return nil, err
	}

	// grep depends on a vendored ripgrep build. When this platform has none, the
	// tool is simply not there and the notice says why — text search then falls
	// back to shell, which asks for approval every time.
	if grepTool, ok := NewGrep(assembly.Workspace); ok {
		if err := registry.Register(grepTool); err != nil {
			return nil, err
		}
	} else {
		result.Missing = append(result.Missing, "grep")
	}

	for _, tool := range assembly.Extra {
		if err := registry.Register(tool); err != nil {
			return nil, err
		}
	}
	return result, nil
}
