package runtime

import "github.com/Lanxiaoxi/tudouni-aigo/internal/agent"

// DefaultMaxSteps is how many model calls one turn may take before it is stopped.
//
// The number is a budget, not a quality setting: it exists so a model that loops
// cannot spend the user's money forever. Reaching it is not a failure — the session
// is intact and the turn can be continued — which is why the agent reports it as
// its own stop reason rather than as an error.
func DefaultMaxSteps() int { return agent.DefaultMaxSteps }

// RuntimeDir is where sessions and audit logs live.
func RuntimeDir() string { return workspaceRuntimeDir() }
