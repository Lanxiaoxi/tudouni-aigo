// Package ssh gives the agent an interactive shell on a remote host.
//
// It is the remote twin of `internal/terminal`: the same three-goroutine shape
// (read / write / wait), the same bounded output buffer that drops the oldest
// bytes rather than stalling the far end, and the same rule that the session's
// own state is the only truth about whether it is still running. What differs is
// the transport — an SSH session channel carrying a PTY instead of a local
// pseudoterminal — and the direction of the output: a terminal pushes bytes at a
// front end, while an agent has no event channel and pulls them with a blocking
// read.
//
// Nothing here knows that a model exists. `internal/tools/builtin` is the only
// place that turns a session into something the agent can call.
//
// **Host configuration is read from the user's own `~/.ssh/config`.** There is no
// second place to configure a host, and that is the whole design: a person who has
// ever run `ssh` has already configured this, and a program that asked them to
// write it down again would be a program that asks for the same fact twice.
package ssh

import (
	"fmt"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// DefaultConfigPath is where OpenSSH keeps its client configuration.
func DefaultConfigPath(home string) string {
	return filepath.Join(home, ".ssh", "config")
}

// DefaultKnownHostsPath is where OpenSSH keeps the host keys it has already seen.
func DefaultKnownHostsPath(home string) string {
	return filepath.Join(home, ".ssh", "known_hosts")
}

// DefaultIdentityNames are the keys OpenSSH offers when a `Host` block names none.
//
// The order is OpenSSH's own and it matters: it is the order the files are tried
// against a server, and a machine with both an ed25519 and an RSA key must offer
// the same one through this program as it does through `ssh`.
var DefaultIdentityNames = []string{"id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"}

// DefaultPort is what a host is reached on when nothing says otherwise.
const DefaultPort = 22

// maxIncludeDepth bounds `Include` recursion. A configuration that includes
// itself is a mistake somebody will make, and the alternative to a bound is a
// parser that hangs while walking it.
const maxIncludeDepth = 8

// rejectedFields are the directives this parser refuses to ignore.
//
// Every one of them changes **where the connection goes, who it authenticates as,
// or how the peer is verified** — the three things nobody expects to be adjusted
// behind their back. Ignoring `ProxyJump` is the worst of them: the address under
// `HostName` is usually unroutable from here (that is why a jump host is
// configured at all), so the symptom would be a bare connection timeout with the
// one line that explains it dropped on the floor — and on a network where that
// address happens to resolve to something else, it is a working session on a
// machine nobody chose.
//
// Refusing is the honest half of the choice. The other half is that these hosts
// cannot be reached through this program at all until the field is supported, and
// that cost is accepted deliberately: a wrong machine is worth more than a
// missing feature.
var rejectedFields = map[string]string{
	"proxyjump":             "a jump host changes the route the connection takes",
	"proxycommand":          "an external proxy command is not supported",
	"canonicalizehostname":  "hostname rewriting changes which machine is connected to",
	"canonicaldomains":      "hostname rewriting changes which machine is connected to",
	"stricthostkeychecking": "the host-key policy here is fail-closed and cannot be widened",
	"userknownhostsfile":    "the known_hosts file is fixed",
	"hostkeyalgorithms":     "restricting host-key algorithms is not supported",
	"certificatefile":       "host certificates are not supported",
	"identityagent":         "an identity agent changes which key is offered",
	"pkcs11provider":        "a PKCS#11 provider changes which key is offered",
	"securitykeyprovider":   "a security-key provider changes which key is offered",
}

// toleratedFields are the directives this parser reads past rather than refusing.
//
// None of them can change the route, the identity or the verification, so
// ignoring one cannot send a command somewhere unexpected. Telling the person is
// still required — "I wrote it and it did nothing" is a fact they have to be able
// to find out — but the distinction from `rejectedFields` is real and is what
// keeps a machine with a harmless `UseKeychain` line usable.
var toleratedFields = map[string]bool{
	"serveraliveinterval": true,
	"serveralivecountmax": true,
	"tcpkeepalive":        true,
	"compression":         true,
	"loglevel":            true,
	"addkeystoagent":      true,
	"usekeychain":         true,
	"forwardagent":        true,
	"sendenv":             true,
	"setenv":              true,
	"requesttty":          true,
	"localforward":        true,
	"remoteforward":       true,
	"dynamicforward":      true,
	"controlmaster":       true,
	"controlpath":         true,
	"controlpersist":      true,
	"hashknownhosts":      true,
	"preferredauthentications": true,
	"pubkeyacceptedalgorithms": true,
	"batchmode":           true,
	"connectionattempts":  true,
	"connecttimeout":      true,
	"passwordauthentication": true,
	"kbdinteractiveauthentication": true,
	"challengeresponseauthentication": true,
	"verifyhostkeydns":    true,
	"updatehostkeys":      true,
	"visualhostkey":       true,
	"ipqos":               true,
	"rekeylimit":          true,
	"streamlocalbindunlink": true,
}

// directive is one `Key value` line, with where it came from.
//
// The source is carried because an error has to name the file a person has to
// edit, and by the time the directives are flattened into blocks the file they
// were read from is no longer obvious — `Include` made sure of that.
type directive struct {
	key    string
	value  string
	source string
	line   int
}

// block is one `Host` stanza: the patterns it applies to, and the directives it
// sets. Directives before the first `Host` form the global block, which matches
// everything and is consulted first — OpenSSH's own rule, and the reason `Host *`
// followed by `Host prod` works the way people expect.
type block struct {
	patterns []string
	fields   []directive
}

// Host is one resolved destination: everything needed to open a connection.
type Host struct {
	// Alias is what the caller asked for, exactly as it was written.
	Alias string
	// HostName is the name or address the connection actually opens to. It is
	// this value — never the alias — that must be shown at an approval, because
	// the alias is a label a person chose and `%h` substitutions and redirects
	// mean the two can differ.
	HostName string
	Port     int
	User     string
	// IdentityFiles are the private keys to try, in order. At least one, or the
	// connection cannot be attempted.
	IdentityFiles []string
	// Warnings are the fields that were read past, for the audit log.
	Warnings []string
}

// Address is what a dialer needs: host and port together.
func (h Host) Address() string {
	return net.JoinHostPort(h.HostName, strconv.Itoa(h.Port))
}

// Display is the human sentence for an approval panel and an audit record.
func (h Host) Display() string {
	return h.User + "@" + h.Address()
}

// Config is a parsed `~/.ssh/config`.
//
// A missing file is not an error and not an empty config: it means "the user has
// no aliases", which is a perfectly ordinary state, and the connection then goes
// to whatever name the caller asked for.
type Config struct {
	path    string
	missing bool
	global  block
	blocks  []block
	// matchSites records every `Match` encountered. A `Match` block is
	// conditional, and this parser does not evaluate conditions, so its fields
	// cannot be applied *or* ruled out — which leaves refusing as the only honest
	// answer. See `Lookup`.
	matchSites []directive
	warnings   []string
}

// LoadConfig reads the configuration file.
//
// `home` is passed in rather than looked up so that a test can point the parser
// at a directory it made. `path` may be empty, meaning the default location.
func LoadConfig(path, home string) (*Config, error) {
	if path == "" {
		path = DefaultConfigPath(home)
	}
	config := &Config{path: path}

	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			config.missing = true
			return config, nil
		}
		return nil, fmt.Errorf("cannot read %s: %w", path, err)
	}

	var flat []directive
	seen := map[string]bool{}
	if err := config.readInto(path, string(raw), 0, seen, home, &flat); err != nil {
		return nil, err
	}
	config.build(flat)
	return config, nil
}

// Warnings returns everything the parser read past while loading, sorted.
func (c *Config) Warnings() []string {
	out := append([]string(nil), c.warnings...)
	sort.Strings(out)
	return out
}

// Path is the file this configuration was read from.
func (c *Config) Path() string { return c.path }

// Missing reports whether there was no file at all.
func (c *Config) Missing() bool { return c.missing }

// readInto flattens one file into directives, expanding `Include` in place.
//
// In place is the point: OpenSSH documents an included file as being processed
// "as if it were part of the file", so a `Host` started in one file and finished
// in another has to behave the same way here. Splitting the work into a second
// pass would have to re-derive that, and would get it wrong for the case that
// matters — an include *inside* a `Host` block, which is how people keep one
// host's settings together.
func (c *Config) readInto(path, text string, depth int, seen map[string]bool, home string, out *[]directive) error {
	if depth > maxIncludeDepth {
		return fmt.Errorf("%s: Include nesting is deeper than %d levels — there is probably a cycle", path, maxIncludeDepth)
	}
	// Cycles are skipped rather than refused, and the difference is deliberate: a
	// file that includes itself once is a mistake worth a warning, not a reason to
	// make every host in the file unreachable.
	key := path
	if absolute, err := filepath.Abs(path); err == nil {
		key = absolute
	}
	if seen[key] {
		c.warnings = append(c.warnings, fmt.Sprintf("%s is included more than once; the second time was skipped", path))
		return nil
	}
	seen[key] = true

	for number, line := range strings.Split(text, "\n") {
		key, value, ok := parseLine(line)
		if !ok {
			continue
		}
		lower := strings.ToLower(key)

		if lower == "include" {
			for _, pattern := range strings.Fields(value) {
				matches := expandInclude(pattern, home)
				if len(matches) == 0 {
					// A glob that matches nothing is how `Include ~/.ssh/conf.d/*`
					// behaves on a machine with no conf.d, and OpenSSH ignores it.
					// A literal path that is not there is a typo, and saying so is
					// the difference between "my settings did nothing" and knowing
					// which line to fix.
					if !hasMeta(pattern) {
						c.warnings = append(c.warnings,
							fmt.Sprintf("%s:%d: Include %s matched no file", path, number+1, pattern))
					}
					continue
				}
				for _, match := range matches {
					nested, err := os.ReadFile(match)
					if err != nil {
						c.warnings = append(c.warnings,
							fmt.Sprintf("%s:%d: Include %s could not be read: %v", path, number+1, match, err))
						continue
					}
					if err := c.readInto(match, string(nested), depth+1, seen, home, out); err != nil {
						return err
					}
				}
			}
			continue
		}

		*out = append(*out, directive{key: lower, value: value, source: path, line: number + 1})
	}
	return nil
}

// build turns the flat directive list into the global block and the `Host` blocks.
func (c *Config) build(flat []directive) {
	current := &c.global
	for _, item := range flat {
		switch item.key {
		case "host":
			c.blocks = append(c.blocks, block{
				patterns: strings.Fields(item.value),
			})
			current = &c.blocks[len(c.blocks)-1]
		case "match":
			// Recorded and then ignored, so the directives under it cannot be
			// mistaken for unconditional ones. They are dropped from the block
			// list rather than attached to a block nothing matches, because
			// attaching them would make their fields look like they had been
			// considered.
			c.matchSites = append(c.matchSites, item)
			current = &block{patterns: nil}
		default:
			current.fields = append(current.fields, item)
		}
	}
}

// Lookup resolves one alias into everything needed to connect.
//
// The alias may be written `user@host`; the user half then wins over whatever the
// configuration says, because a person who typed it meant it.
//
// Values are collected **per field, first obtained wins**, across the global block
// and every matching `Host` block in order — not "the first matching block wins".
// The difference is not pedantry, it is the `Host *` idiom:
//
//	Host *
//	    User admin
//	Host prod
//	    HostName 10.0.1.5
//
// Connecting to `prod` has to give `User=admin`; a block-at-a-time reading would
// find no user at all and fall back to the local login name, which is a different
// account on the far end.
func (c *Config) Lookup(alias string) (Host, error) {
	requested := strings.TrimSpace(alias)
	if requested == "" {
		return Host{}, fmt.Errorf("no host was named")
	}
	overrideUser := ""
	name := requested
	if index := strings.LastIndex(requested, "@"); index >= 0 {
		overrideUser = requested[:index]
		name = requested[index+1:]
		if name == "" {
			return Host{}, fmt.Errorf("%q names no host after the @", alias)
		}
	}

	if len(c.matchSites) > 0 {
		site := c.matchSites[0]
		return Host{}, fmt.Errorf(
			"%s:%d uses a Match block, which this program cannot evaluate — the fields under it "+
				"may or may not apply, and guessing would mean connecting as somebody else or to "+
				"somewhere else. Remove the Match block for %q, or reach this host another way",
			site.source, site.line, name)
	}

	// Every matching scope, in the order OpenSSH consults them.
	scopes := make([]*block, 0, len(c.blocks)+1)
	scopes = append(scopes, &c.global)
	for index := range c.blocks {
		if hostMatches(c.blocks[index].patterns, name) {
			scopes = append(scopes, &c.blocks[index])
		}
	}

	// A refused field is refused wherever it appears in a scope that applies,
	// even if an earlier scope already set the same key to something harmless:
	// the field is still in the file, and a person who removes the harmless one
	// would then be silently routed by the other.
	var refused []directive
	for _, scope := range scopes {
		for _, field := range scope.fields {
			if _, bad := rejectedFields[field.key]; bad {
				refused = append(refused, field)
			}
		}
	}
	if len(refused) > 0 {
		first := refused[0]
		reason := rejectedFields[first.key]
		return Host{}, fmt.Errorf(
			"%s:%d sets %s, which this program will not ignore: %s. "+
				"Nothing is connected, rather than connecting somewhere or as somebody you did not ask for",
			first.source, first.line, strings.ToUpper(first.key), reason)
	}

	values := map[string]directive{}
	var warnings []string
	for _, scope := range scopes {
		for _, field := range scope.fields {
			if _, taken := values[field.key]; taken {
				// First obtained wins — including over a later, more specific
				// block. Saying nothing here would be wrong; the person needs to
				// know their later line did not take effect.
				continue
			}
			values[field.key] = field
		}
	}
	// Warnings come from every matching scope rather than from the winning value
	// alone: a tolerated field that lost the first-obtained race still did nothing,
	// and that is exactly the fact worth reporting.
	for _, scope := range scopes {
		for _, field := range scope.fields {
			if toleratedFields[field.key] {
				warnings = append(warnings, fmt.Sprintf("%s:%d: %s is not applied by this program",
					field.source, field.line, strings.ToUpper(field.key)))
				continue
			}
			if _, known := rejectedFields[field.key]; known {
				continue
			}
			if !knownFields[field.key] {
				warnings = append(warnings, fmt.Sprintf("%s:%d: %s is not a field this program knows; it was not applied",
					field.source, field.line, strings.ToUpper(field.key)))
			}
		}
	}
	sort.Strings(warnings)

	resolved := Host{Alias: requested, HostName: name, Port: DefaultPort, User: localUsername(), Warnings: dedupe(warnings)}

	if field, ok := values["hostname"]; ok && strings.TrimSpace(field.value) != "" {
		resolved.HostName = expandTokens(field.value, name, resolved.User, "")
	}
	if field, ok := values["user"]; ok && strings.TrimSpace(field.value) != "" {
		resolved.User = field.value
	}
	if overrideUser != "" {
		resolved.User = overrideUser
	}
	if field, ok := values["port"]; ok {
		port, err := strconv.Atoi(strings.TrimSpace(field.value))
		if err != nil || port < 1 || port > 65535 {
			return Host{}, fmt.Errorf("%s:%d: Port %q is not a port number", field.source, field.line, field.value)
		}
		resolved.Port = port
	}
	if strings.TrimSpace(resolved.User) == "" {
		return Host{}, fmt.Errorf(
			"no user name for %q: the local login could not be determined, so add `User` to its Host block",
			requested)
	}

	// Identity files. An explicit list is used as given (resolved against the home
	// directory, so `~` and bare names both work); with none, the OpenSSH defaults
	// are tried in order and **only the ones that exist**, because a missing file
	// would otherwise become an authentication failure that names a file the
	// person never mentioned.
	if field, ok := values["identityfile"]; ok {
		for _, candidate := range strings.Fields(field.value) {
			path := expandTokens(candidate, name, resolved.User, homeDirFor(c.path))
			resolved.IdentityFiles = append(resolved.IdentityFiles, path)
		}
	}
	if len(resolved.IdentityFiles) == 0 {
		for _, name := range DefaultIdentityNames {
			candidate := filepath.Join(homeDirFor(c.path), ".ssh", name)
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				resolved.IdentityFiles = append(resolved.IdentityFiles, candidate)
			}
		}
	}
	if len(resolved.IdentityFiles) == 0 {
		return Host{}, fmt.Errorf(
			"no private key for %q: none is named by IdentityFile and none of the usual files "+
				"(%s) exist in %s. Create a key, or add IdentityFile to its Host block",
			requested, strings.Join(DefaultIdentityNames, ", "), filepath.Join(homeDirFor(c.path), ".ssh"))
	}
	return resolved, nil
}

// knownFields are the directives this parser understands and applies.
//
// Anything else is reported as unknown rather than silently dropped. It is not an
// error — a newer OpenSSH keyword the user's version writes and this one has never
// heard of must not make a host unreachable — but it is said out loud, because a
// setting that quietly did nothing is the failure this whole file is arranged to
// avoid.
var knownFields = map[string]bool{
	"hostname":     true,
	"port":         true,
	"user":         true,
	"identityfile": true,
	"identitiesonly": true,
}

// hostMatches reports whether a `Host` block applies to a name.
//
// Negation is checked first and beats everything: OpenSSH's rule is that a pattern
// beginning with `!` that matches disqualifies the block outright, whatever the
// positive patterns said. Getting that backwards would apply a block to the one
// host a person explicitly excluded.
func hostMatches(patterns []string, name string) bool {
	matched := false
	for _, pattern := range patterns {
		if strings.HasPrefix(pattern, "!") {
			if globMatch(pattern[1:], name) {
				return false
			}
			continue
		}
		if globMatch(pattern, name) {
			matched = true
		}
	}
	return matched
}

// globMatch is OpenSSH's pattern match: `*` and `?`, case-insensitive.
func globMatch(pattern, name string) bool {
	return globFold(strings.ToLower(pattern), strings.ToLower(name))
}

func globFold(pattern, name string) bool {
	for len(pattern) > 0 {
		switch pattern[0] {
		case '*':
			// Collapse runs of `*`: they are one wildcard, and recursing on each
			// of them turns a pathological pattern into exponential work.
			for len(pattern) > 1 && pattern[1] == '*' {
				pattern = pattern[1:]
			}
			if len(pattern) == 1 {
				return true
			}
			for index := 0; index <= len(name); index++ {
				if globFold(pattern[1:], name[index:]) {
					return true
				}
			}
			return false
		case '?':
			if len(name) == 0 {
				return false
			}
			pattern, name = pattern[1:], name[1:]
		default:
			if len(name) == 0 || pattern[0] != name[0] {
				return false
			}
			pattern, name = pattern[1:], name[1:]
		}
	}
	return len(name) == 0
}

// expandInclude resolves one `Include` argument into file paths.
func expandInclude(pattern, home string) []string {
	expanded := expandTokens(pattern, "", "", home)
	matches, err := filepath.Glob(expanded)
	if err != nil {
		return nil
	}
	sort.Strings(matches)
	return matches
}

// expandTokens applies the `~` and `%` substitutions OpenSSH accepts in paths and
// host names.
//
// `%h` is the name the person typed, not the name it resolved to, which is what
// makes `HostName %h.internal` mean "the same alias, in another domain" — the
// substitution has to happen against the alias or it would be a no-op. `%d` and
// `%u` are the local home and login, `%r` the remote user.
func expandTokens(value, alias, remoteUser, home string) string {
	text := strings.TrimSpace(value)
	if home == "" {
		home = homeDirFor("")
	}
	if strings.HasPrefix(text, "~/") || text == "~" {
		text = filepath.Join(home, strings.TrimPrefix(text[1:], "/"))
	}
	replacer := strings.NewReplacer(
		"%h", alias,
		"%n", alias,
		"%r", remoteUser,
		"%d", home,
		"%u", localUsername(),
		"%%", "%",
	)
	return replacer.Replace(text)
}

// homeDirFor answers "whose home directory is this configuration in".
//
// It is derived from the configuration path (its grandparent is the home
// directory, because the file lives in `<home>/.ssh/config`) rather than from the
// process environment, and that is not a shortcut: a test that points the parser
// at a directory it made must not have the real user's `~/.ssh/id_rsa` offered as
// a candidate, or the test would pass on the machine of whoever wrote it and
// nowhere else.
func homeDirFor(configPath string) string {
	if configPath != "" {
		sshDir := filepath.Dir(configPath)
		if filepath.Base(sshDir) == ".ssh" {
			return filepath.Dir(sshDir)
		}
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return home
	}
	return "."
}

// localUsername is who a connection authenticates as when nothing says.
//
// The operating system is asked rather than `$USER`, because a session started
// from a desktop icon has no `USER` in its environment while it very much still
// has a login name. Windows answers `DOMAIN\user`, and the domain half is an
// Active Directory artifact that means nothing to a Linux server on the other
// end, so it is dropped.
func localUsername() string {
	if current, err := user.Current(); err == nil && current.Username != "" {
		name := current.Username
		if index := strings.LastIndexAny(name, `\/`); index >= 0 {
			name = name[index+1:]
		}
		if name != "" {
			return name
		}
	}
	for _, key := range []string{"USER", "USERNAME", "LOGNAME"} {
		if name := strings.TrimSpace(os.Getenv(key)); name != "" {
			return name
		}
	}
	return ""
}

// parseLine splits one configuration line into a key and a value.
//
// `Key value` and `Key=value` are both accepted because both are real; a `#`
// inside a quoted value is text rather than a comment; an empty or comment-only
// line reports ok=false.
func parseLine(line string) (string, string, bool) {
	text := strings.TrimSpace(stripComment(line))
	if text == "" {
		return "", "", false
	}
	index := 0
	for index < len(text) && !isSpace(text[index]) && text[index] != '=' {
		index++
	}
	key := text[:index]
	if key == "" {
		return "", "", false
	}
	rest := strings.TrimLeft(text[index:], " \t")
	rest = strings.TrimPrefix(rest, "=")
	rest = strings.TrimLeft(rest, " \t")
	return key, unquote(rest), true
}

// stripComment removes a trailing comment, leaving `#` inside quotes alone.
func stripComment(line string) string {
	var quote byte
	for index := 0; index < len(line); index++ {
		char := line[index]
		if quote != 0 {
			if char == quote {
				quote = 0
			}
			continue
		}
		switch char {
		case '\'', '"':
			quote = char
		case '#':
			return line[:index]
		}
	}
	return line
}

// unquote removes one layer of matching quotes.
func unquote(value string) string {
	if len(value) >= 2 {
		first, last := value[0], value[len(value)-1]
		if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
			return value[1 : len(value)-1]
		}
	}
	return value
}

func isSpace(char byte) bool { return char == ' ' || char == '\t' }

// hasMeta reports whether a path contains glob characters, which decides whether
// an `Include` that matched nothing is a mistake or the ordinary case.
func hasMeta(path string) bool { return strings.ContainsAny(path, "*?[") }

func dedupe(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	sort.Strings(values)
	out := values[:1]
	for _, value := range values[1:] {
		if value != out[len(out)-1] {
			out = append(out, value)
		}
	}
	return out
}
