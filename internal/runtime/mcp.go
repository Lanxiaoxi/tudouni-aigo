package runtime

import (
	"sort"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/mcp"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
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
	r.mcpMu.Lock()
	if r.mcpMounts == nil {
		r.mcpMounts = map[string]*mcpMount{}
	}
	r.mcpMu.Unlock()

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

// McpTrustGroup answers the `a` key at an approval: which group does this tool
// belong to?
//
// The group is "every tool this server contributed, **as of now**". Two details
// matter and both are deliberate:
//
//   - it reads the mounts that are running right now, so a server that was just
//     unloaded no longer offers "this whole server" — otherwise the prompt would say
//     "all 12 tools of server github run without asking" while three of them no
//     longer exist;
//   - it is a snapshot of names rather than "anything from this server, ever". A
//     server that ships a `delete_everything` tool tomorrow must ask about it; a
//     release that widened itself is exactly what "trust the whole server" must not
//     mean.
//
// A tool name cannot belong to two mounts: registration refuses a clash rather than
// letting the second server overwrite the first (see mcpLoad).
func (r *Runtime) McpTrustGroup(toolName string) (security.TrustGroup, bool) {
	mounts := r.mcpMountsSnapshot()
	for name, mount := range mounts {
		for _, registered := range mount.tools {
			if registered != toolName {
				continue
			}
			return security.TrustGroup{Label: name, Tools: append([]string{}, mount.tools...)}, true
		}
	}
	return security.TrustGroup{}, false
}

// mcpLoad brings one server up and registers its tools.
func (r *Runtime) mcpLoad(spec McpServerSpec) []string {
	if mount, present := r.mcpMountsSnapshot()[spec.Name]; present {
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

	r.mcpMu.Lock()
	r.mcpMounts[spec.Name] = &mcpMount{connection: loaded.Connection, tools: registered}
	r.mcpMu.Unlock()
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
	mount, present := r.mcpMountsSnapshot()[spec.Name]
	if !present {
		return []string{i18n.T("mcp.host.not_running", "name", spec.Name)}
	}

	for _, name := range mount.tools {
		r.Tools.Unregister(name)
	}
	r.mcpMu.Lock()
	delete(r.mcpMounts, spec.Name)
	r.mcpMu.Unlock()

	if err := mount.connection.Close(); err != nil {
		return []string{
			i18n.T("mcp.host.unloaded", "name", spec.Name, "n", len(mount.tools)),
			i18n.T("mcp.host.close_failed", "name", spec.Name, "problem", err.Error()),
		}
	}
	return []string{i18n.T("mcp.host.unloaded", "name", spec.Name, "n", len(mount.tools))}
}

// mcpPanel is the data `/mcp` draws.
//
// The field is `mcp_servers`, not `mcp`: that is the name in the reply to an
// `mcp` message, and the front end reads exactly that key. The `ui(state)`
// snapshot right behind it carries the same rows under `mcp` — two names for two
// messages, which protocol 3.12 spells out, and the reason this one silently
// showed nothing when it was called `mcp` too.
func (r *Runtime) mcpPanel(specs []McpServerSpec) map[string]any {
	rows, running := r.mcpInventory(specs)
	return map[string]any{"mcp_servers": rows, "mcp_running": running}
}

// mcpInventory is the same rows as concrete Go values, plus how many are up.
//
// It exists because two messages carry these rows under **two** names — the
// `ui(mcp)` reply says `mcp_servers`, the `ui(state)` snapshot behind it says
// `mcp` (protocol 3.12) — and both have to be built from one walk. Returning the
// rows as `[]any` for the wire and the count as an `int` keeps the two callers
// from each re-deriving "what is mounted", which is how the snapshot came to be
// hard-coded empty in the first place.
func (r *Runtime) mcpInventory(specs []McpServerSpec) ([]any, int) {
	rows := make([]any, 0, len(specs))
	running := 0
	mounts := r.mcpMountsSnapshot()
	for _, spec := range specs {
		row := map[string]any{"name": spec.Name, "where": toMcpSpec(spec).Where()}
		if mount, present := mounts[spec.Name]; present {
			row["state"] = "loaded"
			row["tools"] = len(mount.tools)
			running++
		} else {
			row["state"] = "unload"
			row["tools"] = 0
		}
		rows = append(rows, row)
	}
	return rows, running
}

// mcpMountsSnapshot is the mounts read under the lock, as a copy.
//
// The map has readers on three goroutines now — a `/mcp` reply, the `ui(state)`
// snapshot that follows every mount, and an approval asking which server a tool
// belongs to (see McpTrustGroup) — while `load` / `unload` still write it from
// the goroutine that waited for the running turn. Handing back the live map
// would move the race from here to whoever iterates it; a copy under the lock
// gives every reader one consistent list and keeps the mount structs themselves
// read-only, since nothing ever writes through them.
func (r *Runtime) mcpMountsSnapshot() map[string]*mcpMount {
	r.mcpMu.Lock()
	defer r.mcpMu.Unlock()
	out := make(map[string]*mcpMount, len(r.mcpMounts))
	for name, mount := range r.mcpMounts {
		out[name] = mount
	}
	return out
}

// CloseMcp collects every mounted server. It is called on shutdown: a mounted
// server is a child process, and leaving children behind on exit is how ports and
// file handles stay held after the window is closed.
func (r *Runtime) CloseMcp() []string {
	var problems []string
	mounts := r.mcpMountsSnapshot()
	names := make([]string, 0, len(mounts))
	for name := range mounts {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		mount := mounts[name]
		for _, tool := range mount.tools {
			r.Tools.Unregister(tool)
		}
		if err := mount.connection.Close(); err != nil {
			problems = append(problems, i18n.T("mcp.host.close_failed", "name", name, "problem", err.Error()))
		}
		r.mcpMu.Lock()
		delete(r.mcpMounts, name)
		r.mcpMu.Unlock()
	}
	return problems
}

// MountedNames lists the servers currently up, for the status line.
func (r *Runtime) MountedNames() []string {
	mounts := r.mcpMountsSnapshot()
	names := make([]string, 0, len(mounts))
	for name := range mounts {
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
