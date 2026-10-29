package hooks

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// The limits. They are constants rather than fields because every one of them is
// a decision about what this program is willing to do to itself on a user's
// behalf, not a knob: a hook that needs longer than a minute before a tool call is
// a redesign, and a hook whose output this program parses by halves is worse than
// one that fails.
const (
	// ConfigVersion is the only `version` this build accepts. A mismatch is a
	// configuration error rather than a guess: the field exists so that a future
	// incompatible shape is refused loudly instead of being half-read.
	ConfigVersion = 1

	// DefaultTimeoutMs is the timeout of an ordinary event.
	DefaultTimeoutMs = 5000
	// GateTimeoutMs is the timeout of an event on the hot path.
	GateTimeoutMs = 3000
	// MaxTimeoutMs is the ceiling a configuration may ask for.
	MaxTimeoutMs = 60000

	// DefaultMaxOutputBytes is how much stdout is read before the hook is treated
	// as failed. "Failed", not "truncated then parsed": half a JSON document
	// parsed into half a decision is the most dangerous shape this feature has.
	DefaultMaxOutputBytes = 256 * 1024
	// MaxMaxOutputBytes is the ceiling a configuration may ask for.
	MaxMaxOutputBytes = 1024 * 1024
	// StderrLimitBytes is how much of a hook's stderr is kept. Only the first
	// 2 KiB of it ever reaches a model, and only when the hook exited 2.
	StderrLimitBytes = 8 * 1024

	// Input limits. Input truncation and output truncation are opposite operations
	// with opposite safety arguments: a hook that sees less is still able to decide,
	// while a hook whose answer is cut in half has answered nothing.
	InputToolResultBytes  = 1024 * 1024
	InputLastMessageBytes = 16 * 1024
	InputPromptBytes      = 64 * 1024

	// MaxHooksPerEvent bounds one event's list. A configuration is allowed to be
	// wrong, but not allowed to turn every tool call into forty processes.
	MaxHooksPerEvent = 16
)

// Defaults is the `defaults` block: what a hook inherits when it says nothing.
type Defaults struct {
	TimeoutMs      int `json:"timeout_ms"`
	MaxOutputBytes int `json:"max_output_bytes"`
}

// Hook is one configured script.
type Hook struct {
	Name string
	// Matcher is the compiled tool-name pattern. Nil means "every tool", which is
	// what an empty `matcher` means and not a different thing: `""` matching
	// everything and nil matching nothing would be two ways to spell one intent.
	Matcher *regexp.Regexp
	// MatcherSource is the text, kept for `--hooks` and the audit. A compiled
	// regexp prints with its own quoting, and the person comparing the listing to
	// their file needs to see their file.
	MatcherSource string
	// Argv is the command. A string command is split through the platform shell
	// and arrives here as an argv, which is the only form the runner executes:
	// two execution paths would mean two quoting behaviours to get right on
	// Windows.
	Argv []string
	// Command is the original spelling, kept for `--hooks`.
	Command string

	TimeoutMs      int
	MaxOutputBytes int
	FailClosed     bool
	Enabled        bool
	StatusMessage  string
	Event          Event
	// Source is `user` or `workspace`: which file this hook came from.
	//
	// It is copied onto each hook rather than read off the set at fire time, because
	// the restriction a workspace's hooks live under is decided **per hook** and the
	// runner holds a `Hook` value, not a `Set`. See `Set.Restricted`.
	Source string
	// Index is the position within its event, which is the order it runs in and
	// the order `--hooks` lists. It is what the audit's `hook_index` names.
	Index int
}

// Source names. They are the `source` field of a `hook_result` record.
const (
	SourceUser      = "user"
	SourceWorkspace = "workspace"
)

// Problem is one thing that is wrong with a hook definition.
//
// It is a value rather than an error so a caller can report **every** problem in
// one pass — `--hooks` exists for exactly that — while `Load` still refuses the
// file when any of them is fatal.
type Problem struct {
	Event  Event
	Name   string
	Detail string
}

func (p Problem) String() string {
	where := string(p.Event)
	if where == "" {
		where = "config"
	}
	if p.Name != "" {
		return where + "/" + p.Name + ": " + p.Detail
	}
	return where + ": " + p.Detail
}

// Set is the loaded configuration: every hook, by event, in the order they run.
//
// It is immutable after `Load`, which is what makes it safe to hand to the child
// agents' goroutines without a lock. The design's rule — "no hot reload" — buys
// that property, so it is worth the line.
type Set struct {
	Path string
	// Source is `user` or `workspace`: which file this set was read from. It is
	// inherited by every hook in the set (see `Hook.Source`) and travels onto the
	// audit row, because two hooks with one name can come from the two files and
	// "which of them refused this" is unanswerable from the name alone.
	//
	// **The restriction a workspace's hooks live under is decided per hook**, from
	// `Hook.Source`, not from this field: a merged set holds both kinds at once, so
	// a single flag on the set could not say which hooks it applies to.
	Source string
	// Workspace is the directory relative script paths resolve against, and the
	// working directory every hook runs in. Empty means "ask the process", which is
	// what a set loaded only for `--hooks` does.
	Workspace string
	ByEvent   map[Event][]Hook
	// Defaults is what the file said, after the built-in defaults were filled in.
	Defaults Defaults
	// Problems is everything that was skipped. It is reported and never fatal
	// here: `Load` has already refused the file when something was fatal.
	Problems []Problem
	// Warnings is what looks wrong but is not: today, an argv whose first element
	// is not found on PATH. It cannot be fatal because PATH at hook-run time is
	// not necessarily PATH now, and refusing to start over that would be a
	// guess dressed up as a check.
	Warnings []string

	// emitMu guards `emit` and `debug`, the set's only mutable fields.
	//
	// They are mutable because the sinks are `runtime.onEvent` and the runtime's own
	// debug writer, and the runtime does not exist yet when the file is read — so the
	// values are installed afterwards, from the assembly goroutine, while child agents
	// may already be firing hooks on theirs. Plain fields would be a data race on the
	// one path that writes the audit record, which is the last place to find one.
	emitMu sync.RWMutex
	emit   func(record map[string]any)
	// debug prints one line per invocation when `--debug` asked for it. Nil is
	// "nobody is reading", which is the ordinary case.
	debug func(text string)
}

// Empty is the "no hooks configured" set.
//
// It is a real value rather than nil so every caller can treat `Set` the same
// way, but the call sites still check `Set == nil` first: a nil `Set` means "this
// session has no hooks at all", which is what skips even the envelope build.
func Empty() *Set {
	return &Set{ByEvent: map[Event][]Hook{}}
}

// Len is how many enabled hooks could fire.
func (s *Set) Len() int {
	if s == nil {
		return 0
	}
	total := 0
	for _, list := range s.ByEvent {
		for _, hook := range list {
			if hook.Enabled {
				total++
			}
		}
	}
	return total
}

// Has reports whether any enabled hook listens to this event.
func (s *Set) Has(event Event) bool {
	if s == nil {
		return false
	}
	for _, hook := range s.ByEvent[event] {
		if hook.Enabled {
			return true
		}
	}
	return false
}

// Hooks returns the list for one event, in run order.
func (s *Set) Hooks(event Event) []Hook {
	if s == nil {
		return nil
	}
	return s.ByEvent[event]
}

// Events returns the event names this set has hooks for, sorted, so both `--hooks`
// and the start-up notice print the same order twice.
func (s *Set) Events() []Event {
	if s == nil {
		return nil
	}
	out := make([]Event, 0, len(s.ByEvent))
	for event := range s.ByEvent {
		out = append(out, event)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// Descriptors flattens every hook into a printable row.
//
// Rows rather than the `Hook` type because the two readers — `--hooks` and the
// start-up notice — want the same fields spelled the same way, and a formatter
// per reader is how two listings of one file come to disagree.
type Descriptor struct {
	Event         string
	Name          string
	Matcher       string
	Command       string
	TimeoutMs     int
	FailClosed    bool
	Enabled       bool
	StatusMessage string
	OutputLimit   int
}

// ProtectedPaths lists the files this configuration depends on: the file itself and
// every script it names that exists on disk.
//
// It exists for the guardrail guard. "The model may not edit the hooks file" cannot be
// a promise the runtime makes about itself — `write_file` is exactly the tool that
// would do it — so the paths are collected here, from the configuration, and the agent
// refuses them by name.
//
// What it **cannot** do is stated rather than hidden: `shell` can still write any of
// these, because a shell is the authority the user granted. The guard raises the bar
// and leaves a trace; it is not a boundary.
func (s *Set) ProtectedPaths() []string {
	if s == nil {
		return nil
	}
	paths := map[string]bool{}
	if s.Path != "" {
		paths[s.Path] = true
	}
	for _, list := range s.ByEvent {
		for _, hook := range list {
			if !hook.Enabled || len(hook.Argv) < 2 {
				continue
			}
			// Every element after the executable, not a guessed list of extensions: a
			// hook may be `["node", "fmt.mjs"]`, `["python3", "no_secrets.py"]` or
			// `["/some/binary", "--config", "/path/hooks.conf"]`, and a rule that
			// recognised only some of those shapes would protect only some of them.
			for _, argument := range hook.Argv[1:] {
				if strings.HasPrefix(argument, "-") {
					continue
				}
				absolute := argument
				if !filepath.IsAbs(absolute) {
					absolute = filepath.Join(s.workspaceDir(), argument)
				}
				if info, err := os.Stat(absolute); err == nil && !info.IsDir() {
					paths[absolute] = true
				}
			}
		}
	}
	out := make([]string, 0, len(paths))
	for path := range paths {
		out = append(out, path)
	}
	sort.Strings(out)
	return out
}

// workspaceDir is where a relative script path resolves.
//
// Empty means "this machine's working directory", which is the workspace a hook runs
// in. It is a method rather than a field so a set loaded by `--hooks` — which never
// runs anything — still answers without one.
func (s *Set) workspaceDir() string {
	if s.Workspace != "" {
		return s.Workspace
	}
	dir, err := os.Getwd()
	if err != nil {
		return "."
	}
	return dir
}

// Merge is this set plus another, in the order they should run.
//
// The two files are **not** merged into one list per event by preference or
// override: every hook of `first` runs before every hook of `second`. That order is
// the trust order — a person's own guardrail is consulted before a repository's —
// and it also means a workspace hook cannot shadow a user hook by taking its name.
//
// Both sets are left untouched; the result owns a fresh map. A nil `first` is not
// special-cased to return `second` itself, because the caller then holds two names
// for one value and a later mutation of either would be a surprise.
func Merge(first, second *Set) *Set {
	if first == nil && second == nil {
		return nil
	}
	out := &Set{
		ByEvent:  map[Event][]Hook{},
		Defaults: Defaults{TimeoutMs: DefaultTimeoutMs, MaxOutputBytes: DefaultMaxOutputBytes},
	}
	for _, part := range []*Set{first, second} {
		if part == nil {
			continue
		}
		if part.Path != "" {
			out.Path = part.Path
		}
		if part.Defaults.TimeoutMs > 0 {
			out.Defaults = part.Defaults
		}
		if part.Source != "" {
			out.Source = part.Source
		}
		out.Problems = append(out.Problems, part.Problems...)
		out.Warnings = append(out.Warnings, part.Warnings...)
		for event, list := range part.ByEvent {
			out.ByEvent[event] = append(out.ByEvent[event], list...)
		}
	}
	return out
}

// Describe returns one row per configured hook, in event order and then in run
// order.
func (s *Set) Describe() []Descriptor {
	if s == nil {
		return nil
	}
	var out []Descriptor
	for _, event := range s.Events() {
		for _, hook := range s.ByEvent[event] {
			matcher := hook.MatcherSource
			if matcher == "" {
				matcher = "*"
			}
			out = append(out, Descriptor{
				Event:         string(event),
				Name:          hook.Name,
				Matcher:       matcher,
				Command:       hook.Command,
				TimeoutMs:     hook.TimeoutMs,
				FailClosed:    hook.FailClosed,
				Enabled:       hook.Enabled,
				StatusMessage: hook.StatusMessage,
				OutputLimit:   hook.MaxOutputBytes,
			})
		}
	}
	return out
}

// SetEmit installs the audit sink.
//
// It is a setter rather than a `Load` argument because the sink is
// `runtime.onEvent`, which does not exist until the runtime does — and a hook that
// was loaded before assembly must still report through the same single exit. The
// value is read from goroutines, so it is stored behind the set's only mutable
// field.
func (s *Set) SetEmit(emit func(record map[string]any)) {
	if s == nil {
		return
	}
	s.emitMu.Lock()
	defer s.emitMu.Unlock()
	s.emit = emit
}

// sink returns the installed audit sink, if any.
func (s *Set) sink() func(record map[string]any) {
	if s == nil {
		return nil
	}
	s.emitMu.RLock()
	defer s.emitMu.RUnlock()
	return s.emit
}

// SetDebug installs the `--debug` writer.
//
// It is where `status_message` is honoured (design §11: "stage 1 only reaches
// `--debug`'s stderr"). The alternative — a live status line — was decided against
// for a reason worth writing down: a hook's typical cost is tens of milliseconds, so
// a line that says "checking for secrets" is visible for about one frame. What the
// field is actually good for is a person watching a slow hook in `--debug` and
// wanting to know which one they are waiting on.
func (s *Set) SetDebug(debug func(text string)) {
	if s == nil {
		return
	}
	s.emitMu.Lock()
	defer s.emitMu.Unlock()
	s.debug = debug
}

// debugLine reports one invocation, with the hook's own `status_message` when it
// declared one.
//
// Nil-safe and silent when nobody is reading: `--debug` off is the ordinary case, and
// building the string for it would be work spent to throw away.
func (s *Set) debugLine(hook Hook, outcome Outcome) {
	if s == nil {
		return
	}
	s.emitMu.RLock()
	write := s.debug
	s.emitMu.RUnlock()
	if write == nil {
		return
	}
	label := hook.StatusMessage
	if label == "" {
		label = hook.Name
	}
	write(fmt.Sprintf("[hook] %s %s → %s (%dms)%s",
		hook.Event, label, outcome.Status, outcome.DurationMs, toolSuffix(outcome)))
}

// toolSuffix names the tool a hook was asked about, for the debug line.
func toolSuffix(outcome Outcome) string {
	if outcome.Tool == "" {
		return ""
	}
	return " · " + outcome.Tool
}

// Emit hands one audit record to the sink, swallowing anything it does.
//
// Swallowed for the same reason `agent.emit` swallows: a hook's report must never
// be able to fail the call it describes, and this runs after the decision has
// already been made.
func (s *Set) Emit(record map[string]any) {
	sink := s.sink()
	if sink == nil || record == nil {
		return
	}
	defer func() { _ = recover() }()
	sink(record)
}

// Load reads and validates `hooks.json`.
//
// A **missing file is not an error** — it is the ordinary state of a machine where
// nobody has configured hooks — and the result is `nil`, which every caller reads
// as "there is nothing to fire". A file that exists and is wrong **is** an error:
// silence there is the failure mode the whole design spends a section on, because
// a misspelled `fail_closed` that quietly becomes a default is impossible to
// notice and impossible to explain later.
func Load(path string) (*Set, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return Parse(path, raw)
}

// Parse is Load for bytes this program already has.
//
// It is exported because the tests need to load documents that never touch a
// disk, and because a future `/hooks reload` has the same need.
func Parse(path string, raw []byte) (*Set, error) {
	text := strings.TrimPrefix(string(raw), "\ufeff")
	var decoded any
	if err := json.Unmarshal([]byte(text), &decoded); err != nil {
		return nil, &ConfigError{Path: path, Detail: "the file is not valid JSON: " + err.Error()}
	}
	object, ok := decoded.(map[string]any)
	if !ok {
		return nil, &ConfigError{Path: path, Detail: "the top level must be an object"}
	}

	set := &Set{Path: path, ByEvent: map[Event][]Hook{}, Source: SourceUser}

	for _, key := range sortedKeys(object) {
		switch key {
		case "version", "defaults", "hooks", "$comment":
		default:
			return nil, &ConfigError{Path: path, Detail: fmt.Sprintf(
				"unknown key %q (known: version, defaults, hooks)", key)}
		}
	}

	version, present := object["version"]
	if !present {
		return nil, &ConfigError{Path: path, Detail: "`version` is required and must be 1"}
	}
	if number, ok := version.(float64); !ok || int(number) != ConfigVersion {
		return nil, &ConfigError{Path: path, Detail: fmt.Sprintf(
			"`version` must be %d", ConfigVersion)}
	}

	set.Defaults = Defaults{TimeoutMs: DefaultTimeoutMs, MaxOutputBytes: DefaultMaxOutputBytes}
	if rawDefaults, present := object["defaults"]; present && rawDefaults != nil {
		block, ok := rawDefaults.(map[string]any)
		if !ok {
			return nil, &ConfigError{Path: path, Detail: "`defaults` must be an object"}
		}
		for _, key := range sortedKeys(block) {
			switch key {
			case "timeout_ms":
				value, err := intField(block[key])
				if err != nil || value < 1 || value > MaxTimeoutMs {
					return nil, &ConfigError{Path: path, Detail: fmt.Sprintf(
						"`defaults.timeout_ms` must be a whole number between 1 and %d", MaxTimeoutMs)}
				}
				set.Defaults.TimeoutMs = value
			case "max_output_bytes":
				value, err := intField(block[key])
				if err != nil || value < 1 || value > MaxMaxOutputBytes {
					return nil, &ConfigError{Path: path, Detail: fmt.Sprintf(
						"`defaults.max_output_bytes` must be a whole number between 1 and %d", MaxMaxOutputBytes)}
				}
				set.Defaults.MaxOutputBytes = value
			default:
				return nil, &ConfigError{Path: path, Detail: fmt.Sprintf(
					"unknown key `defaults.%s` (known: timeout_ms, max_output_bytes)", key)}
			}
		}
	}

	rawHooks, present := object["hooks"]
	if !present || rawHooks == nil {
		return set, nil
	}
	byEvent, ok := rawHooks.(map[string]any)
	if !ok {
		return nil, &ConfigError{Path: path, Detail: "`hooks` must be an object mapping each event name to a list"}
	}

	for _, eventName := range sortedKeys(byEvent) {
		event := Event(eventName)
		if !event.Valid() {
			return nil, &ConfigError{Path: path, Detail: fmt.Sprintf(
				"unknown event %q (known: %s)", eventName, eventList())}
		}
		list, ok := byEvent[eventName].([]any)
		if !ok {
			return nil, &ConfigError{Path: path, Detail: fmt.Sprintf(
				"`hooks.%s` must be a list", eventName)}
		}
		if len(list) > MaxHooksPerEvent {
			return nil, &ConfigError{Path: path, Detail: fmt.Sprintf(
				"`hooks.%s` has %d entries; at most %d are allowed", eventName, len(list), MaxHooksPerEvent)}
		}
		names := map[string]bool{}
		for index, item := range list {
			entry, ok := item.(map[string]any)
			if !ok {
				return nil, &ConfigError{Path: path, Detail: fmt.Sprintf(
					"`hooks.%s[%d]` must be an object", eventName, index)}
			}
			hook, err := parseHook(set, event, entry, index)
			if err != nil {
				return nil, err
			}
			if hook == nil {
				continue
			}
			if names[hook.Name] {
				return nil, &ConfigError{Path: path, Detail: fmt.Sprintf(
					"`hooks.%s` has two hooks named %q; a name identifies one hook", eventName, hook.Name)}
			}
			names[hook.Name] = true
			set.ByEvent[event] = append(set.ByEvent[event], *hook)
		}
	}
	return set, nil
}

// hookKeys is everything one hook object may contain. An unknown key is refused:
// a misspelled `fail_closed` silently taking the default is the failure this check
// exists for.
var hookKeys = []string{
	"name", "matcher", "command", "timeout_ms", "max_output_bytes",
	"fail_closed", "enabled", "status_message",
}

func parseHook(set *Set, event Event, entry map[string]any, index int) (*Hook, error) {
	for _, key := range sortedKeys(entry) {
		known := false
		for _, allowed := range hookKeys {
			if key == allowed {
				known = true
				break
			}
		}
		if !known {
			return nil, &ConfigError{Path: set.Path, Detail: fmt.Sprintf(
				"`hooks.%s[%d]` has an unknown key %q (known: %s)",
				event, index, key, strings.Join(hookKeys, ", "))}
		}
	}

	hook := Hook{Event: event, Index: index, Enabled: true}
	name, _ := entry["name"].(string)
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, &ConfigError{Path: set.Path, Detail: fmt.Sprintf(
			"`hooks.%s[%d]` needs a `name`", event, index)}
	}
	hook.Name = name

	// Enabled is read before anything can skip the hook: `enabled: false` is a
	// documented way to switch one off without deleting it, so it must survive
	// every other check.
	if rawEnabled, present := entry["enabled"]; present && rawEnabled != nil {
		flag, ok := rawEnabled.(bool)
		if !ok {
			return nil, &ConfigError{Path: set.Path, Detail: fmt.Sprintf(
				"`%s.enabled` must be true or false", name)}
		}
		hook.Enabled = flag
	}

	if rawMatcher, present := entry["matcher"]; present && rawMatcher != nil {
		text, ok := rawMatcher.(string)
		if !ok {
			return nil, &ConfigError{Path: set.Path, Detail: fmt.Sprintf(
				"`%s.matcher` must be a string", name)}
		}
		hook.MatcherSource = text
		if text != "" {
			compiled, err := regexp.Compile(text)
			if err != nil {
				return nil, &ConfigError{Path: set.Path, Detail: fmt.Sprintf(
					"`%s.matcher` is not a valid regular expression: %v", name, err)}
			}
			hook.Matcher = compiled
		}
	}

	commandRaw, present := entry["command"]
	if !present || commandRaw == nil {
		return nil, &ConfigError{Path: set.Path, Detail: fmt.Sprintf(
			"`%s.command` is required", name)}
	}
	switch typed := commandRaw.(type) {
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return nil, &ConfigError{Path: set.Path, Detail: fmt.Sprintf(
				"`%s.command` is empty", name)}
		}
		hook.Command = trimmed
		hook.Argv = shellArgv(trimmed)
	case []any:
		var argv []string
		for _, item := range typed {
			text, ok := item.(string)
			if !ok {
				return nil, &ConfigError{Path: set.Path, Detail: fmt.Sprintf(
					"`%s.command` list entries must all be strings", name)}
			}
			argv = append(argv, text)
		}
		if len(argv) == 0 || strings.TrimSpace(argv[0]) == "" {
			return nil, &ConfigError{Path: set.Path, Detail: fmt.Sprintf(
				"`%s.command` needs at least an executable", name)}
		}
		hook.Argv = argv
		hook.Command = joinCommand(argv)
	default:
		return nil, &ConfigError{Path: set.Path, Detail: fmt.Sprintf(
			"`%s.command` must be a string or a list of strings", name)}
	}

	hook.TimeoutMs = set.Defaults.TimeoutMs
	if event.Gate() && hook.TimeoutMs > GateTimeoutMs {
		// The gate's default is tighter than the file's default, and a hook on the
		// hot path inherits the tighter one. A configuration that asks for more
		// explicitly still gets it: this is a default, not a cap.
		hook.TimeoutMs = GateTimeoutMs
	}
	if rawTimeout, present := entry["timeout_ms"]; present && rawTimeout != nil {
		value, err := intField(rawTimeout)
		if err != nil || value < 1 || value > MaxTimeoutMs {
			return nil, &ConfigError{Path: set.Path, Detail: fmt.Sprintf(
				"`%s.timeout_ms` must be a whole number between 1 and %d", name, MaxTimeoutMs)}
		}
		hook.TimeoutMs = value
	}

	hook.MaxOutputBytes = set.Defaults.MaxOutputBytes
	if rawLimit, present := entry["max_output_bytes"]; present && rawLimit != nil {
		value, err := intField(rawLimit)
		if err != nil || value < 1 || value > MaxMaxOutputBytes {
			return nil, &ConfigError{Path: set.Path, Detail: fmt.Sprintf(
				"`%s.max_output_bytes` must be a whole number between 1 and %d", name, MaxMaxOutputBytes)}
		}
		hook.MaxOutputBytes = value
	}

	hook.FailClosed = event.Gate()
	if rawFail, present := entry["fail_closed"]; present && rawFail != nil {
		flag, ok := rawFail.(bool)
		if !ok {
			return nil, &ConfigError{Path: set.Path, Detail: fmt.Sprintf(
				"`%s.fail_closed` must be true or false", name)}
		}
		hook.FailClosed = flag
	}

	if rawStatus, present := entry["status_message"]; present && rawStatus != nil {
		text, ok := rawStatus.(string)
		if !ok {
			return nil, &ConfigError{Path: set.Path, Detail: fmt.Sprintf(
				"`%s.status_message` must be a string", name)}
		}
		hook.StatusMessage = text
	}

	// A argv whose executable cannot be found is a warning and not a refusal: PATH
	// when the hook runs is not necessarily PATH now, and a hook may name a script
	// it creates later. Saying so beats guessing either way.
	if hook.Enabled && !looksExecutable(hook.Argv[0]) {
		set.Warnings = append(set.Warnings, fmt.Sprintf(
			"%s/%s: the command %s was not found on PATH (hooks run with the workspace's PATH, so this may still work)",
			event, name, hook.Argv[0]))
	}
	// The set's origin is copied onto each hook rather than read back at fire time:
	// the runner aggregates a `Hook` value and never sees the `Set`, and a merged
	// configuration holds both origins in one list. See `Set.Source`.
	hook.Source = set.Source
	return &hook, nil
}

// looksExecutable answers "is there such a program", cheaply.
//
// A path with a separator is checked as a file; a bare name is looked up on PATH.
// It is a hint for the human reading `--hooks`, never a decision.
func looksExecutable(name string) bool {
	if strings.ContainsRune(name, '/') || strings.ContainsRune(name, '\\') {
		info, err := os.Stat(name)
		return err == nil && !info.IsDir()
	}
	_, err := lookPath(name)
	return err == nil
}

// lookPath is a seam for tests: the real one is exec.LookPath, and a test that
// needs a deterministic answer replaces this rather than depending on what happens
// to be installed.
var lookPath = defaultLookPath

func shellArgv(command string) []string {
	return shellArgvFor(command)
}

func joinCommand(argv []string) string {
	var parts []string
	for _, item := range argv {
		if strings.ContainsAny(item, " \t\"") {
			parts = append(parts, `"`+strings.ReplaceAll(item, `"`, `\"`)+`"`)
			continue
		}
		parts = append(parts, item)
	}
	return strings.Join(parts, " ")
}

func eventList() string {
	names := make([]string, 0, len(Events))
	for _, event := range Events {
		names = append(names, string(event))
	}
	return strings.Join(names, ", ")
}

// ConfigError is a `hooks.json` problem the person has to fix.
//
// It is a distinct type so an entry point can tell "the file is wrong" (exit 2,
// with the path in the sentence) apart from "the hook failed at run time" (a
// recorded outcome, never a refusal to start).
type ConfigError struct {
	Path   string
	Detail string
}

func (e *ConfigError) Error() string {
	if e.Path == "" {
		return e.Detail
	}
	return e.Path + ": " + e.Detail
}

func intField(value any) (int, error) {
	switch typed := value.(type) {
	case float64:
		if typed != float64(int(typed)) {
			return 0, fmt.Errorf("not a whole number")
		}
		return int(typed), nil
	case int:
		return typed, nil
	default:
		return 0, fmt.Errorf("not a number")
	}
}

func sortedKeys(object map[string]any) []string {
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// HooksFile is where the user's hooks live: `~/.tudouni/hooks.json`.
//
// It is user-level and that is a security boundary rather than a convenience, the
// same one `mcp.json` draws: the `command` in this file is code, and a file inside
// a workspace arrives with a cloned repository.
func HooksFile(home string) string { return filepath.Join(home, "hooks.json") }

// WorkspaceFile is where a workspace's hooks would be, for the notice that says
// they are not read. It exists so the sentence can name the path a person is
// looking at.
func WorkspaceFile(workspaceRuntimeDir string) string {
	return filepath.Join(workspaceRuntimeDir, "hooks.json")
}
