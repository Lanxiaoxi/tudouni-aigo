package builtin

import (
	"fmt"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/skills"
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

	// SkillLoader scans the skill directories. Nil means no skill tool: a schema
	// sent every round that can only ever answer "there is nothing here" costs the
	// model a round trip for nothing.
	SkillLoader *skills.Loader
	// SkillMetadata is the session metadata the loaded-skill list is bound to.
	SkillMetadata map[string]any

	// CodeIntel is the workspace's index handle, and the pair below it is the answer
	// to "should the model have a code-intelligence tool at all".
	//
	// Refresher is built by the runtime rather than here because the same instance has
	// to serve the panel's init/sync: two refreshers over one index would be two mutexes
	// pretending to serialize one write path.
	//
	// CodeIntelEnabled is the person's permission, from the workspace's
	// `<workspace>/.tudouni/codeintel/config.json`. It is **separate** from "the index
	// exists" on purpose — see internal/codeintel's config.go for the two states that
	// distinction makes expressible. When it is false the tool is not even built, so a
	// workspace that never asked for code intelligence pays nothing for it.
	CodeIntel        *codeintel.Refresher
	CodeIntelEnabled bool

	// Extra holds the tools built by the assembly layer — background jobs, the
	// network tools, the skill loader. They live elsewhere because they own
	// resources (process handles, HTTP clients, a directory scan) that this file
	// has no business constructing.
	Extra []tools.Tool
}

// Result is the registry plus the reasons some tools are missing.
type Result struct {
	Tools *tools.Registry
	// Skills is the board bound to this session, so the runtime can render the
	// loaded bodies into the payload tail. It is the **same** board the tool
	// writes through — two boards over one metadata map would work, and would also
	// mean two objects claiming to be the answer to "what is loaded".
	Skills *SkillBoard
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
	// git_snapshot is read-only and workspace-bound like read_file: repo_path goes
	// through SafePath, so it never observes a repository outside the workspace.
	if err := registry.Register(NewGitSnapshot(assembly.Workspace)); err != nil {
		return nil, err
	}
	// present is the fifth file-facing tool and the only one that touches nothing:
	// it declares paths the other tools already wrote. It is registered on its own
	// rather than inside `NewFileTools` because those four share a shape — resolve,
	// act, report a changed file — that this one does not have: it reads no bytes,
	// writes no bytes, and its whole product is a fact for the interface.
	if err := registry.Register(NewPresent(assembly.Workspace)); err != nil {
		return nil, err
	}
	// read_image sits beside the file tools rather than inside NewFileTools, and the
	// separation is the design rather than tidiness: those four return **text** and
	// this one returns bytes, and a reader who sees them in one list would reasonably
	// assume they work the same way. See the tool's own comment for why a picture
	// cannot travel as text.
	if err := registry.Register(NewReadImage(assembly.Workspace)); err != nil {
		return nil, err
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

	// The code index is optional twice over: the person has to turn the capability on,
	// and an index has to exist. Either being false means no tool, and only the second
	// of the two is worth a notice — "you have not enabled this" is a setting, not a
	// missing piece. See internal/codeintel.
	if assembly.CodeIntelEnabled {
		if codeExplore, ok := NewCodeExplore(assembly.Workspace, assembly.CodeIntel); ok {
			if err := registry.Register(codeExplore); err != nil {
				return nil, err
			}
		} else {
			result.Missing = append(result.Missing, CodeExploreToolName)
		}
	}

	if assembly.SkillLoader != nil {
		// Registered only when there is something to load. A skill directory that
		// does not exist is not a configuration error — skills are optional, and
		// absent means "this capability is not here".
		if catalog := assembly.SkillLoader.Reload(); len(catalog.Skills) > 0 {
			board := NewSkillBoard(assembly.SkillMetadata, assembly.SkillLoader)
			if err := registry.Register(NewLoadSkill(board)); err != nil {
				return nil, err
			}
			result.Skills = board
		}
	}

	for _, tool := range assembly.Extra {
		if err := registry.Register(tool); err != nil {
			return nil, err
		}
	}
	return result, nil
}
