package runtime

import (
	"fmt"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/agent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/imagegen"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// Image generation, as the runtime sees it.
//
// The route is **optional**. A machine with no `image_generation` section has
// no picture generator, and that is a normal state rather than a problem: the
// capability was never promised, so the tool is simply absent from the schema
// and one info line says why. The rule this program holds everywhere applies —
// a tool the model can see but that can only ever answer "not configured" costs
// a round trip every time it is tried, and teaches it that tools lie.

// runIDHolder hands out the current turn's identifier.
//
// It is a holder rather than a plain function because **assembly has an order
// the tool set does not**: the registry is built before the agent, because the
// registry's tools are the agent's tools. The picture counter needs the turn's
// id and the agent owns it.
//
// The same trick `artifactImages` uses for the picture loader, and for the same
// reason: the field is written once and read only later.
//
// The value is read through the agent rather than copied, because the id
// changes on every turn and a copy would answer for the turn that was current
// when the holder was filled in.
type runIDHolder struct {
	agent *agent.Agent
}

// ID reports the current turn's identifier.
//
// An empty string means "no turn has run yet", which is the honest answer: the
// counter treats it as its own turn, and the first real turn resets it.
func (h *runIDHolder) ID() string {
	if h == nil || h.agent == nil {
		return ""
	}
	return h.agent.RunID()
}

// buildImageClient builds the picture generator, or reports that there is none.
//
// The two failure shapes are different and are kept apart:
//
//   - **no section at all** — not an error. The capability is not here, and
//     the caller says so in one line.
//   - **a section that cannot be used** — an error. A misspelled key or a
//     `provider` that names nothing is a mistake somebody has to fix, and
//     silently ignoring it would leave a tool that is not there for a reason
//     nobody can see.
//
// The transport is the runtime's own, so the machine's proxy setting applies
// to a generation exactly as it does to a chat request.
func (r *Runtime) buildImageClient(catalog state.Registry) (*imagegen.Client, error) {
	route := catalog.Image
	if !route.Configured() {
		return nil, nil
	}
	client, err := imagegen.New(imagegen.Route{
		Name:    route.Provider,
		BaseURL: route.BaseURL,
		APIKey:  route.APIKey,
		Model:   route.Model,
		Style:   imagegen.Style(route.APIStyle),
		Headers: route.Headers,
	}, r.httpClient)
	if err != nil {
		return nil, fmt.Errorf("%w", err)
	}
	return client, nil
}
