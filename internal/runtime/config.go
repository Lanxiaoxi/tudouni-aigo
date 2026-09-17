// Package runtime assembles a working agent out of configuration, a session, the
// tool registry and a model client — and closes it down again.
//
// The assembly is in two stages, and the split is load-bearing:
//
//   - **boot** touches the disk and nothing else. It makes the session store, the
//     audit sink and the skill directory. It needs no model, so it can run before
//     anybody knows whether a key is configured — which is what lets a missing key
//     be reported as a sentence rather than as a crash.
//   - **open** builds the model client, the tools, the agent and the MCP
//     connections. It is the expensive half, and it is the half a session switch
//     re-runs.
//
// A session switch rebuilds the runtime completely: new model client, new tool
// registry, new agent. Reusing the old tool registry would be wrong in a way that
// is hard to see — the task list and the loaded skills are members of that registry
// and are bound to the *old* session's metadata, so the new session would come up
// showing the previous conversation's tasks.
package runtime

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/config"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
)

// Error is a configuration problem: the user has to do something about it. The
// entry points catch it, print the message to stderr and exit with code 2.
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

func errorf(format string, args ...any) *Error {
	return &Error{Msg: fmt.Sprintf(format, args...)}
}

// PermissionFile is where the approval policy lives.
//
// It is a function, not a constant: the file sits under the *workspace*, and the
// workspace is the directory the program was started in.
func PermissionFile() string {
	return filepath.Join(paths.WorkspaceRuntimeDir(), "permissions.json")
}

// MCPFile is where the MCP server list lives.
//
// It is user-level on purpose, and that is a security boundary rather than a
// convenience: `command` in that file is code executed at startup, and workspace
// files can be cloned in with a repository. A workspace-level list would mean that
// cloning a repository is enough to run something.
func MCPFile() string {
	return filepath.Join(paths.UserConfigDir(), "mcp.json")
}

// WebFile returns the configuration file the `web` section is read from.
func WebFile() string { return config.ConfigFile() }

// PermissionConfig is the approval policy as read from disk.
type PermissionConfig struct {
	// AutoApprove holds risk level names. `high` is not accepted here: risk is
	// declared per tool, so "auto-approve everything high" would silently widen as
	// tools are added. Naming a specific tool is the way to do that.
	AutoApprove      []string
	AutoApproveTools []string
	DenyTools        []string
	ShellAllow       []security.Rule
}

// DefaultPermissions is what a missing file means: only `low` runs without asking.
func DefaultPermissions() PermissionConfig {
	return PermissionConfig{AutoApprove: []string{string(security.RiskLow)}}
}

var permissionKeys = []string{"auto_approve", "auto_approve_tools", "deny_tools", "shell_allow"}

// LoadPermissions reads permissions.json.
//
// A missing file is not an error — it means the defaults — and the file lives under
// the workspace so it is computed at call time rather than cached.
func LoadPermissions() (PermissionConfig, error) {
	path := PermissionFile()
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return DefaultPermissions(), nil
		}
		return PermissionConfig{}, errorf("%s", i18n.T("config.error.unreadable", "path", path, "error", err.Error()))
	}
	object, err := decodeObject(path, raw)
	if err != nil {
		return PermissionConfig{}, err
	}
	if unknown := unknownKeys(object, permissionKeys); len(unknown) > 0 {
		return PermissionConfig{}, errorf("%s", i18n.T("config.error.unknown_keys",
			"where", path, "names", strings.Join(unknown, ", "), "known", strings.Join(permissionKeys, ", ")))
	}

	cfg := DefaultPermissions()
	if value, present := object["auto_approve"]; present {
		levels, err := stringList(value, path, "auto_approve")
		if err != nil {
			return PermissionConfig{}, err
		}
		for _, level := range levels {
			switch level {
			case "low", "medium":
			case "high":
				return PermissionConfig{}, errorf("%s", i18n.T("config.error.auto_approve_high", "file", path))
			default:
				return PermissionConfig{}, errorf("%s", i18n.T("config.error.auto_approve_unknown",
					"file", path, "levels", level, "allowed", strings.Join([]string{"low", "medium"}, ", ")))
			}
		}
		cfg.AutoApprove = levels
	}

	tools, err := stringList(object["auto_approve_tools"], path, "auto_approve_tools")
	if err != nil {
		return PermissionConfig{}, err
	}
	denied, err := stringList(object["deny_tools"], path, "deny_tools")
	if err != nil {
		return PermissionConfig{}, err
	}
	cfg.AutoApproveTools = tools
	cfg.DenyTools = denied

	// A tool in both lists is a contradiction, and the policy must not be asked to
	// guess which wins — whichever way it guessed, one of the two lines would be a
	// lie about what happens.
	if both := intersect(tools, denied); len(both) > 0 {
		return PermissionConfig{}, errorf("%s", i18n.T("config.error.contradictory",
			"file", path, "names", strings.Join(both, ", ")))
	}

	rules, err := stringList(object["shell_allow"], path, "shell_allow")
	if err != nil {
		return PermissionConfig{}, err
	}
	for _, text := range rules {
		rule, err := security.ParseRule(text, isWindows())
		if err != nil {
			return PermissionConfig{}, errorf("%s", i18n.T("config.error.bad_shell_rule", "file", path, "problem", err.Error()))
		}
		cfg.ShellAllow = append(cfg.ShellAllow, rule)
	}
	return cfg, nil
}

// SaveApprovals writes the two remembered sets back to permissions.json.
//
// The write is atomic: a temporary file is written and renamed over the target. A
// half-written policy file would be read back as "no rules", which fails closed but
// silently forgets everything the user agreed to.
func SaveApprovals(tools []string, prefixes []security.Rule) error {
	path := PermissionFile()
	cfg, err := LoadPermissions()
	if err != nil {
		// An unreadable file is never overwritten: the user's rules are in there,
		// and a save that replaced them with the two sets from this run would
		// delete them.
		return err
	}

	object := map[string]any{
		"auto_approve":       cfg.AutoApprove,
		"auto_approve_tools": dedupe(tools),
		"deny_tools":         cfg.DenyTools,
	}
	if len(cfg.ShellAllow) > 0 {
		rules := append([]security.Rule(nil), cfg.ShellAllow...)
		rules = append(rules, prefixes...)
		formatted := make([]string, 0, len(rules))
		seen := map[string]bool{}
		for _, rule := range rules {
			text, err := security.FormatRule(rule)
			if err != nil {
				continue
			}
			if seen[text] {
				continue
			}
			seen[text] = true
			formatted = append(formatted, text)
		}
		object["shell_allow"] = formatted
	} else if len(prefixes) > 0 {
		formatted := make([]string, 0, len(prefixes))
		for _, rule := range prefixes {
			if text, err := security.FormatRule(rule); err == nil {
				formatted = append(formatted, text)
			}
		}
		object["shell_allow"] = formatted
	}

	raw, err := json.MarshalIndent(object, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

// MemoryFromPermissions builds the approval memory backed by permissions.json.
//
// The two sets that live in memory are exactly the two that a person can create by
// pressing `t`: tool names and command prefixes. There is no "denied" set here, and
// deliberately so — refusal lives in the policy, which is checked before a request
// ever reaches the memory. Two places answering "is this refused" would eventually
// disagree.
func MemoryFromPermissions() (*security.Memory, error) {
	cfg, err := LoadPermissions()
	if err != nil {
		return nil, err
	}
	memory := security.NewMemory(cfg.AutoApproveTools, cfg.ShellAllow,
		PermissionFile(), SaveApprovals)
	return memory, nil
}

// McpServerSpec is one configured MCP server.
type McpServerSpec struct {
	Name    string
	Command string
	Args    []string
	Env     map[string]string
	URL     string
	Headers map[string]string
	Timeout float64
}

// LoadMcpServers reads mcp.json.
func LoadMcpServers() ([]McpServerSpec, []string, error) {
	path := MCPFile()
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, nil
		}
		return nil, nil, errorf("%s", i18n.T("config.error.unreadable", "path", path, "error", err.Error()))
	}
	object, err := decodeObject(path, raw)
	if err != nil {
		return nil, nil, err
	}
	return parseMcpServers(object, path)
}

func parseMcpServers(object map[string]any, path string) ([]McpServerSpec, []string, error) {
	for key := range object {
		if key != "servers" {
			return nil, nil, errorf("%s", i18n.T("config.error.mcp_problem", "file", path,
				"problem", i18n.T("mcp.cfg.unknown_top_keys", "names", key)))
		}
	}
	serversRaw, present := object["servers"]
	if !present || serversRaw == nil {
		return nil, nil, nil
	}
	servers, ok := serversRaw.(map[string]any)
	if !ok {
		return nil, nil, errorf("%s", i18n.T("config.error.mcp_problem", "file", path,
			"problem", i18n.T("mcp.cfg.servers_not_object")))
	}

	names := make([]string, 0, len(servers))
	var specs []McpServerSpec
	for name, value := range servers {
		entry, ok := value.(map[string]any)
		if !ok {
			return nil, nil, errorf("%s", i18n.T("config.error.mcp_problem", "file", path,
				"problem", i18n.T("mcp.cfg.server_not_object", "name", name)))
		}
		spec := McpServerSpec{Name: name}
		spec.Command, _ = entry["command"].(string)
		spec.URL, _ = entry["url"].(string)
		if list, ok := entry["args"].([]any); ok {
			for _, item := range list {
				if text, ok := item.(string); ok {
					spec.Args = append(spec.Args, text)
				}
			}
		}
		spec.Env = stringMapOf(entry["env"])
		spec.Headers = stringMapOf(entry["headers"])
		if timeout, ok := entry["timeout_seconds"].(float64); ok {
			spec.Timeout = timeout
		}
		if (spec.Command == "") == (spec.URL == "") {
			given := i18n.T("mcp.cfg.neither_given")
			if spec.Command != "" {
				given = i18n.T("mcp.cfg.both_given")
			}
			return nil, nil, errorf("%s", i18n.T("config.error.mcp_problem", "file", path,
				"problem", i18n.T("mcp.cfg.both_or_neither", "name", name, "given", given)))
		}
		specs = append(specs, spec)
		names = append(names, name)
	}
	return specs, names, nil
}

// WebConfig is the `web` section.
type WebConfig struct {
	TavilyAPIKey  string
	TavilyBaseURL string
}

// DefaultTavilyBaseURL is where search requests go unless the config says otherwise.
const DefaultTavilyBaseURL = "https://api.tavily.com/v1"

// LoadWebConfig reads the `web` section.
func LoadWebConfig() (WebConfig, error) {
	cfg, err := config.Read("")
	if err != nil {
		return WebConfig{}, err
	}
	for key := range cfg.Web {
		if key != "tavily_api_key" && key != "tavily_base_url" {
			known := []string{"tavily_api_key", "tavily_base_url"}
			return WebConfig{}, errorf("%s", i18n.T("config.error.unknown_web_keys",
				"path", cfg.Path, "names", key, "known", strings.Join(known, ", ")))
		}
	}
	return WebConfig{
		TavilyAPIKey:  config.Text(cfg.Web, "tavily_api_key", ""),
		TavilyBaseURL: strings.TrimRight(config.Text(cfg.Web, "tavily_base_url", DefaultTavilyBaseURL), "/"),
	}, nil
}

func decodeObject(path string, raw []byte) (map[string]any, error) {
	text := strings.TrimPrefix(string(raw), "\ufeff")
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		return nil, errorf("%s", i18n.T("config.error.bad_json",
			"path", path, "line", 1, "column", 1, "message", err.Error()))
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, errorf("%s", i18n.T("config.error.not_object", "path", path, "kind", "non-object"))
	}
	return object, nil
}

func stringList(value any, file, key string) ([]string, error) {
	if value == nil {
		return nil, nil
	}
	items, ok := value.([]any)
	if !ok {
		return nil, errorf("%s", i18n.T("config.error.not_string_list", "key", key, "file", file))
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			return nil, errorf("%s", i18n.T("config.error.not_string_list", "key", key, "file", file))
		}
		if strings.TrimSpace(text) == "" {
			return nil, errorf("%s", i18n.T("config.error.empty_string_in_list", "key", key, "file", file))
		}
		out = append(out, strings.TrimSpace(text))
	}
	return out, nil
}

func stringMapOf(value any) map[string]string {
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]string{}
	for key, item := range object {
		if text, ok := item.(string); ok {
			out[key] = text
		}
	}
	return out
}

func unknownKeys(object map[string]any, allowed []string) []string {
	known := map[string]bool{}
	for _, key := range allowed {
		known[key] = true
	}
	var out []string
	for key := range object {
		if !known[key] {
			out = append(out, key)
		}
	}
	return out
}

func intersect(a, b []string) []string {
	set := map[string]bool{}
	for _, item := range a {
		set[item] = true
	}
	var out []string
	for _, item := range b {
		if set[item] {
			out = append(out, item)
		}
	}
	return out
}

func dedupe(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}
