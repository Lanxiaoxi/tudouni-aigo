// Package tools is what the model can actually do.
//
// A tool is a name, a description, a JSON schema for its arguments and a handler.
// The description and the schema are what the model sees; the handler is what
// runs. Keeping them in one value means the schema cannot drift away from the code
// that reads the arguments.
//
// Three rules are enforced at registration time rather than left to discipline:
//
//   - risk must be declared. A tool that forgets would land on the safest-looking
//     value, which is the worst possible failure shape for a permission system;
//   - a tool that claims to be safe to run in parallel must be low risk, because a
//     parallel batch does not prompt and prompting from several goroutines would
//     fight over the same stdin;
//   - a tool that asks the user something may never be parallel-safe.
package tools

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
)

// Result is what a handler returns.
type Result struct {
	// Text is what goes back to the model.
	Text string
	// Audit carries the facts only this tool knows — an exit code, how a question
	// was answered, which skill action happened. The agent cannot derive them, and
	// they are what makes the audit log worth reading.
	Audit map[string]any
}

// TextResult is the common case: a string and nothing extra.
func TextResult(text string) Result { return Result{Text: text} }

// Handler runs one call. The arguments have already been validated against the
// tool's schema, so the handler may read them without re-checking types.
//
// A handler returns an error only for conditions that are genuinely exceptional;
// ordinary failures (a missing file, a non-zero exit code, no matches) are results
// with text explaining them, because the model has to see them and try something
// else.
type Handler func(arguments map[string]any) (Result, error)

// Tool is one capability.
type Tool struct {
	Name        string
	Description string
	Risk        security.RiskLevel
	// Schema is a JSON Schema object describing the arguments.
	Schema  map[string]any
	Handler Handler
	// ParallelSafe marks a tool that may run alongside others in one batch.
	ParallelSafe bool
	// Interactive marks a tool whose handler blocks on a person answering.
	Interactive bool
	// External marks a tool that came from an MCP server.
	External bool
	// CommandParam names the argument holding a command line, when there is one.
	// Only prefix rules care about it.
	CommandParam string
}

// Parameters returns the schema, or an object schema with no properties.
func (t Tool) Parameters() map[string]any {
	if t.Schema != nil {
		return t.Schema
	}
	return EmptySchema()
}

// OpenAISchema renders the shape the model is given.
//
// Risk is deliberately absent: it is a statement about this tool for the
// permission layer, and the model has no business seeing — or being able to
// influence — how dangerous it is considered.
func (t Tool) OpenAISchema() map[string]any {
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        t.Name,
			"description": t.Description,
			"parameters":  t.Parameters(),
		},
	}
}

// Execute validates the arguments and runs the handler.
func (t Tool) Execute(arguments map[string]any) (Result, error) {
	validated, err := Validate(t.Parameters(), arguments)
	if err != nil {
		return Result{}, &InvalidArgumentsError{Msg: err.Error()}
	}
	if t.Handler == nil {
		return Result{}, fmt.Errorf("tool %s has no handler", t.Name)
	}
	result, err := t.Handler(validated)
	if err != nil {
		return Result{}, err
	}
	if result.Audit == nil {
		result.Audit = map[string]any{}
	}
	return result, nil
}

// InvalidArgumentsError means the model passed something the schema rejects.
//
// It is separated from other errors because the handling differs: this one is the
// model's mistake and it is reported back as an invalid-arguments tool result,
// not as an execution failure.
type InvalidArgumentsError struct{ Msg string }

func (e *InvalidArgumentsError) Error() string { return e.Msg }

// Registry holds the tools available this run.
type Registry struct {
	tools map[string]Tool
	order []string
}

// NewRegistry creates an empty registry.
func NewRegistry() *Registry {
	return &Registry{tools: map[string]Tool{}}
}

// Register adds a tool.
//
// The three invariants are checked here, at startup, so a broken declaration is a
// crash on the first run rather than a surprise during an approval.
func (r *Registry) Register(tool Tool) error {
	if tool.Name == "" {
		return fmt.Errorf("a tool must have a name")
	}
	if !tool.Risk.Valid() {
		return fmt.Errorf("tool %s must declare a risk level (low/medium/high); a missing one would silently land on low", tool.Name)
	}
	if tool.ParallelSafe && tool.Risk != security.RiskLow {
		return fmt.Errorf("tool %s is declared parallel_safe but its risk is %s: a parallel batch does not prompt, so only low risk tools may run in one", tool.Name, tool.Risk)
	}
	if tool.Interactive && tool.ParallelSafe {
		return fmt.Errorf("tool %s is declared both interactive and parallel_safe: a tool that asks the user can never run alongside others", tool.Name)
	}
	if _, exists := r.tools[tool.Name]; exists {
		return fmt.Errorf("tool %s is already registered", tool.Name)
	}
	r.tools[tool.Name] = tool
	r.order = append(r.order, tool.Name)
	sort.Strings(r.order)
	if tool.CommandParam != "" {
		registerCommandParameter(tool.Name, tool.CommandParam)
	}
	return nil
}

// MustRegister panics on a registration error, for the assembly path where a bad
// declaration is a programming mistake.
func (r *Registry) MustRegister(tool Tool) {
	if err := r.Register(tool); err != nil {
		panic(err)
	}
}

// Get looks a tool up.
func (r *Registry) Get(name string) (Tool, bool) {
	tool, ok := r.tools[name]
	return tool, ok
}

// Unregister removes one tool.
func (r *Registry) Unregister(name string) {
	if _, ok := r.tools[name]; !ok {
		return
	}
	delete(r.tools, name)
	r.reindex()
}

// UnregisterPrefix removes every tool whose name starts with prefix.
//
// It is how an MCP server's tools are removed together: they share the
// `mcp__<server>__` prefix, so one call takes exactly that server's tools and
// nothing else.
func (r *Registry) UnregisterPrefix(prefix string) {
	changed := false
	for name := range r.tools {
		if strings.HasPrefix(name, prefix) {
			delete(r.tools, name)
			changed = true
		}
	}
	if changed {
		r.reindex()
	}
}

// All returns the tools in name order.
func (r *Registry) All() []Tool {
	out := make([]Tool, 0, len(r.order))
	for _, name := range r.order {
		out = append(out, r.tools[name])
	}
	return out
}

// Names returns the tool names in order.
func (r *Registry) Names() []string { return append([]string(nil), r.order...) }

// Schemas returns the schemas handed to the model.
func (r *Registry) Schemas() []map[string]any {
	out := make([]map[string]any, 0, len(r.order))
	for _, name := range r.order {
		out = append(out, r.tools[name].OpenAISchema())
	}
	return out
}

// Len is how many tools are registered.
func (r *Registry) Len() int { return len(r.tools) }

func (r *Registry) reindex() {
	r.order = r.order[:0]
	for name := range r.tools {
		r.order = append(r.order, name)
	}
	sort.Strings(r.order)
}

// registerCommandParameter tells the permission layer that this tool carries a
// command line. The fact is declared where the tool is defined and consumed where
// prefix rules are matched, so the two cannot drift apart.
func registerCommandParameter(toolName, parameter string) {
	security.RegisterCommandParameter(toolName, parameter)
}

// MarshalSchema is a helper for tools whose schema comes from a map literal.
func MarshalSchema(schema map[string]any) string {
	raw, err := json.Marshal(schema)
	if err != nil {
		return "{}"
	}
	return string(raw)
}
