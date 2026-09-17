package mcp

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// Turning configured servers into tools the registry can hold.
//
// Every tool from every server is **high risk**, and the level is not configurable:
// the side effects of an external tool cannot be verified at runtime, and a setting
// that could lower it would be a setting that turns a boundary into a checkbox. So
// every call is approved, and the notice says so.

// ServerSpec is one configured server, already validated.
type ServerSpec struct {
	Name    string
	Command string
	Args    []string
	Env     map[string]string
	URL     string
	Headers map[string]string
	Timeout float64
}

// IsRemote reports whether this server is reached over HTTP.
func (s ServerSpec) IsRemote() bool { return s.URL != "" }

// Where is the redacted location: remote servers report `scheme://host`, local ones
// report nothing at all.
func (s ServerSpec) Where() string {
	if !s.IsRemote() {
		// A local server's command line can carry paths, and this string reaches
		// the model.
		return ""
	}
	channel := NewHTTPChannel(s.Name, s.URL, nil, nil)
	return channel.Where()
}

// Group is the set of tools one server contributed.
type Group struct {
	Label string
	Tools []string
}

// Toolset is the result of connecting to a batch of servers.
type Toolset struct {
	Tools       []tools.Tool
	Groups      []Group
	Connections map[string]*Connection
	// Counts holds the tool count for servers that **connected**. A server that
	// failed is absent rather than zero: "did not connect" and "connected with no
	// tools" are two different facts, and the panel shows them differently.
	Counts map[string]int
	// Problems are sentences for the person running this. They never reach the
	// model.
	Problems []string
}

// Connect brings up every server, one at a time.
//
// **A server that fails does not stop the others.** Fail-open assembly is right
// here for the same reason a missing ripgrep does not stop the program: an
// external service being down is not a reason for the agent to be unusable, and
// the problem is reported rather than hidden.
func Connect(specs []ServerSpec, client *http.Client) *Toolset {
	toolset := &Toolset{
		Connections: map[string]*Connection{},
		Counts:      map[string]int{},
	}

	taken := map[string]string{} // exposed name → the tool that already owns it
	var loaded []*Loaded

	for _, spec := range specs {
		item := LoadServer(spec, client)
		if item.Error != "" {
			toolset.Problems = append(toolset.Problems, i18n.T("mcp.load_failed",
				"name", spec.Name, "problem", item.Error))
			continue
		}
		loaded = append(loaded, item)
	}

	// Names are assigned across all servers at once, because a clash is a fact
	// about the whole set: two servers can offer the same tool name, and the second
	// one has to be refused rather than silently overwrite the first.
	for _, item := range loaded {
		var kept []tools.Tool
		for _, tool := range item.Tools {
			if other, clash := taken[tool.Name]; clash {
				toolset.Problems = append(toolset.Problems, i18n.T("mcp.name_clash",
					"tool", tool.Name, "name", item.Spec.Name, "other", other))
				continue
			}
			taken[tool.Name] = item.Spec.Name
			kept = append(kept, tool)
		}

		toolset.Connections[item.Spec.Name] = item.Connection
		toolset.Counts[item.Spec.Name] = len(kept)
		toolset.Tools = append(toolset.Tools, kept...)

		if len(kept) > 0 || item.Connection.OffersTools() {
			names := make([]string, 0, len(kept))
			for _, tool := range kept {
				names = append(names, tool.Name)
			}
			toolset.Groups = append(toolset.Groups, Group{Label: item.Spec.Name, Tools: names})
		} else {
			// Connected, declared no tools capability. Said out loud, because
			// otherwise it looks like a connection problem.
			toolset.Problems = append(toolset.Problems, i18n.T("mcp.no_tools_capability",
				"name", item.Spec.Name))
		}
	}

	return toolset
}

// Loaded is one server that came up.
type Loaded struct {
	Spec       ServerSpec
	Connection *Connection
	Tools      []tools.Tool
	// Error is the reason it did not come up. It is a field rather than a returned
	// error because loading is allowed to fail without stopping anything.
	Error string
}

// LoadServer connects to one server and builds its tools.
//
// It **registers nothing**: the caller decides what to do with the tools, which is
// what lets the runtime mount a server later without going through a second
// implementation of the same thing.
func LoadServer(spec ServerSpec, client *http.Client) *Loaded {
	loaded := &Loaded{Spec: spec}

	var channel Channel
	if spec.IsRemote() {
		channel = NewHTTPChannel(spec.Name, spec.URL, spec.Headers, client)
	} else {
		stdio := NewStdioChannel(spec.Name, spec.Command, spec.Args, spec.Env)
		if err := stdio.Start(); err != nil {
			loaded.Error = err.Error()
			return loaded
		}
		channel = stdio
	}

	connection := NewConnection(spec.Name, channel, timeoutOr(spec.Timeout))
	if err := connection.Open(); err != nil {
		channel.Close()
		loaded.Error = err.Error()
		return loaded
	}
	loaded.Connection = connection

	if !connection.OffersTools() {
		return loaded
	}

	specs, err := connection.ListTools()
	if err != nil {
		loaded.Error = err.Error()
		return loaded
	}

	for _, toolSpec := range specs {
		loaded.Tools = append(loaded.Tools, buildTool(spec, connection, toolSpec))
	}
	return loaded
}

// buildTool wraps one remote tool as a local one.
func buildTool(spec ServerSpec, connection *Connection, toolSpec ToolSpec) tools.Tool {
	exposed := ExposedName(spec.Name, toolSpec.Name)

	schema := toolSpec.Schema
	if schema == nil {
		// A server that declares no schema gets an empty one rather than none: a
		// missing schema would be sent as null, and providers reject that outright.
		schema = tools.EmptySchema()
	}

	description := toolSpec.Description
	if description == "" {
		description = fmt.Sprintf("（%s 提供的一个工具，它没有给说明。）", spec.Name)
	}

	return tools.Tool{
		Name:        exposed,
		Description: description,
		// Fixed, not configurable. The side effects of an external tool cannot be
		// verified at runtime, so there is no honest lower level to offer — and a
		// setting that lowered it would turn a boundary into a checkbox.
		Risk: security.RiskHigh,
		// External: the schema came from somewhere else, so argument validation is
		// the server's to do and this side passes the arguments through.
		External: true,
		Schema:   schema,
		Handler: func(arguments map[string]any) (tools.Result, error) {
			text, err := connection.CallTool(toolSpec.Name, arguments)
			if err != nil {
				// Returned as a result, not raised: the same reasoning as every
				// other external tool. A raised error gets recorded as a tool
				// fault, and the model is precisely the one who does not get the
				// sentence it could act on.
				return tools.Result{
					Text: fmt.Sprintf("调用 %s 失败：%v", toolSpec.Name, err),
					Audit: map[string]any{
						"mcp_server": spec.Name,
						"mcp_tool":   toolSpec.Name,
						"mcp_error":  true,
						"mcp_where":  connection.Where(),
					},
				}, nil
			}
			audit := map[string]any{
				"mcp_server": spec.Name,
				"mcp_tool":   toolSpec.Name,
			}
			if where := connection.Where(); where != "" {
				audit["mcp_where"] = where
			}
			return tools.Result{Text: text, Audit: audit}, nil
		},
	}
}

// ExposedName is the name the model sees for one remote tool.
//
// The prefix marks it as external, so a person reading an approval prompt can tell
// an outside tool from a built-in one without knowing the configuration. Tool names
// are sanitised because the model-facing name has to survive being written into a
// JSON schema and matched case-sensitively.
func ExposedName(server, tool string) string {
	sanitised := strings.NewReplacer(".", "_", "/", "_", " ", "_").Replace(tool)
	candidate := NamePrefix + server + Separator + sanitised
	if len(candidate) <= ToolNameMax {
		return candidate
	}
	// Truncating alone would make two long names from one server collide, which
	// would silently drop a tool. The digest keeps them distinct.
	sum := sha1.Sum([]byte(tool))
	suffix := hex.EncodeToString(sum[:])[:8]
	keep := ToolNameMax - len(NamePrefix) - len(server) - len(Separator) - len(suffix) - 1
	if keep < 1 {
		keep = 1
	}
	if keep > len(sanitised) {
		keep = len(sanitised)
	}
	return NamePrefix + server + Separator + sanitised[:keep] + "_" + suffix
}

// Names lists the servers in a batch, sorted, for the notices.
func Names(specs []ServerSpec) []string {
	names := make([]string, 0, len(specs))
	for _, spec := range specs {
		names = append(names, spec.Name)
	}
	sort.Strings(names)
	return names
}

func timeoutOr(seconds float64) float64 {
	if seconds < MinTimeoutSeconds || seconds > MaxTimeoutSeconds {
		return DefaultTimeoutSeconds
	}
	return seconds
}

// ValidateServerName checks a name before it is used to build tool names.
func ValidateServerName(name string) bool { return ServerNamePattern.MatchString(name) }
