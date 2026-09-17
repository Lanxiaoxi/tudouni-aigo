package runtime

import (
	"sort"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/mcp"
)

// Mounting and unmounting MCP servers at runtime.
//
// **Nothing is mounted at start-up.** A server is a program that runs on this
// machine with this user's privileges, so mounting one is a decision a person makes
// rather than a consequence of having written it into a config file. The file says
// what is available; `/mcp load` says what is running.
//
// The tool registry is live, so mounting adds tools the very next request can use —
// and unmounting takes them away. Both directions have to be real: a tool that stays
// in the schema after its server is gone costs a failed call every time the model
// tries it.

// mcpMount is one server that is currently up.
type mcpMount struct {
	connection *mcp.Connection
	tools      []string
}

// MCPMessage implements protocol.Runtime.
//
// It returns the panel data and the sentences to show. The two are separate because
// they have different readers: the panel is drawn, the notes are read — and one of
// the notes being a warning is something the caller decides, not this function.
func (r *Runtime) MCPMessage(action string, servers []string) (map[string]any, []string) {
	if r.mcpMounts == nil {
		r.mcpMounts = map[string]*mcpMount{}
	}

	// Re-read the file every time: a server added while this session is open should
	// be loadable without a restart, and a file that has become unreadable is worth
	// saying out loud.
	specs, _, err := LoadMcpServers()
	var notes []string
	if err != nil {
		notes = append(notes, i18n.T("mcp.host.reread_failed", "file", MCPFile(), "problem", err.Error()))
		specs = r.McpCfg
	}
	r.McpCfg = specs

	switch strings.ToLower(strings.TrimSpace(action)) {
	case "", "list":
		return r.mcpPanel(specs), notes
	case "load", "unload":
	default:
		// An unknown action falls back to listing rather than guessing: the panel
		// is what a person wanted anyway, and a wrong guess could mount something.
		return r.mcpPanel(specs), notes
	}

	if len(servers) == 0 {
		return r.mcpPanel(specs), notes
	}

	for _, name := range servers {
		spec, found := findSpec(specs, name)
		if !found {
			notes = append(notes, i18n.T("mcp.host.unknown_server",
				"name", name, "known", strings.Join(mcp.Names(toMcpSpecs(specs)), ", ")))
			continue
		}
		if action == "load" {
			notes = append(notes, r.mcpLoad(spec)...)
		} else {
			notes = append(notes, r.mcpUnload(spec)...)
		}
	}
	return r.mcpPanel(specs), notes
}

// mcpLoad brings one server up and registers its tools.
func (r *Runtime) mcpLoad(spec McpServerSpec) []string {
	if mount, present := r.mcpMounts[spec.Name]; present {
		return []string{i18n.T("mcp.host.already_loaded", "name", spec.Name, "n", len(mount.tools))}
	}

	loaded := mcp.LoadServer(toMcpSpec(spec), r.httpClient)
	if loaded.Error != "" {
		return []string{i18n.T("mcp.host.load_failed", "name", spec.Name, "problem", loaded.Error)}
	}

	var registered []string
	var notes []string
	for _, tool := range loaded.Tools {
		if err := r.Tools.Register(tool); err != nil {
			// A clash with a built-in name is refused rather than allowed to
			// overwrite it: the model-facing name is the only handle the model has,
			// and a silent takeover would redirect calls without anything saying so.
			notes = append(notes, i18n.T("mcp.name_clash",
				"tool", tool.Name, "name", spec.Name, "other", "already registered"))
			continue
		}
		registered = append(registered, tool.Name)
	}

	r.mcpMounts[spec.Name] = &mcpMount{connection: loaded.Connection, tools: registered}
	if len(registered) == 0 {
		notes = append(notes, i18n.T("mcp.no_tools_capability", "name", spec.Name))
		return notes
	}
	// Every one of these tools is high risk, and the sentence says so: a person who
	// mounts a server should know before the first prompt arrives that every call
	// will ask.
	return append(notes, i18n.T("mcp.host.loaded", "name", spec.Name, "n", len(registered)))
}

// mcpUnload takes the tools out and collects the process.
func (r *Runtime) mcpUnload(spec McpServerSpec) []string {
	mount, present := r.mcpMounts[spec.Name]
	if !present {
		return []string{i18n.T("mcp.host.not_running", "name", spec.Name)}
	}

	for _, name := range mount.tools {
		r.Tools.Unregister(name)
	}
	delete(r.mcpMounts, spec.Name)

	if err := mount.connection.Close(); err != nil {
		return []string{
			i18n.T("mcp.host.unloaded", "name", spec.Name, "n", len(mount.tools)),
			i18n.T("mcp.host.close_failed", "name", spec.Name, "problem", err.Error()),
		}
	}
	return []string{i18n.T("mcp.host.unloaded", "name", spec.Name, "n", len(mount.tools))}
}

// mcpPanel is the data `/mcp` draws.
func (r *Runtime) mcpPanel(specs []McpServerSpec) map[string]any {
	rows := make([]any, 0, len(specs))
	running := 0
	for _, spec := range specs {
		row := map[string]any{"name": spec.Name, "where": toMcpSpec(spec).Where()}
		if mount, present := r.mcpMounts[spec.Name]; present {
			row["state"] = "loaded"
			row["tools"] = len(mount.tools)
			running++
		} else {
			row["state"] = "unload"
			row["tools"] = 0
		}
		rows = append(rows, row)
	}
	return map[string]any{"mcp": rows, "mcp_running": running}
}

// CloseMcp collects every mounted server. It is called on shutdown: a mounted
// server is a child process, and leaving children behind on exit is how ports and
// file handles stay held after the window is closed.
func (r *Runtime) CloseMcp() []string {
	var problems []string
	names := make([]string, 0, len(r.mcpMounts))
	for name := range r.mcpMounts {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		mount := r.mcpMounts[name]
		for _, tool := range mount.tools {
			r.Tools.Unregister(tool)
		}
		if err := mount.connection.Close(); err != nil {
			problems = append(problems, i18n.T("mcp.host.close_failed", "name", name, "problem", err.Error()))
		}
		delete(r.mcpMounts, name)
	}
	return problems
}

// MountedNames lists the servers currently up, for the status line.
func (r *Runtime) MountedNames() []string {
	names := make([]string, 0, len(r.mcpMounts))
	for name := range r.mcpMounts {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func findSpec(specs []McpServerSpec, name string) (McpServerSpec, bool) {
	for _, spec := range specs {
		if spec.Name == name {
			return spec, true
		}
	}
	return McpServerSpec{}, false
}

func toMcpSpec(spec McpServerSpec) mcp.ServerSpec {
	return mcp.ServerSpec{
		Name:    spec.Name,
		Command: spec.Command,
		Args:    spec.Args,
		Env:     spec.Env,
		URL:     spec.URL,
		Headers: spec.Headers,
		Timeout: spec.Timeout,
	}
}

func toMcpSpecs(specs []McpServerSpec) []mcp.ServerSpec {
	out := make([]mcp.ServerSpec, 0, len(specs))
	for _, spec := range specs {
		out = append(out, toMcpSpec(spec))
	}
	return out
}

// mcpNotice is the start-up line about configured servers.
//
// It says **"none of them is mounted yet"** on purpose: mounting is a decision, and
// a person who reads only this line should not be left believing the servers are
// already running.
func mcpNotice(specs []McpServerSpec) string {
	if len(specs) == 0 {
		return ""
	}
	return i18n.T("notice.mcp.configured",
		"n", len(specs),
		"file", MCPFile(),
		"names", strings.Join(mcp.Names(toMcpSpecs(specs)), ", "))
}
