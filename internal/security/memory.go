package security

import "sort"

// SaveFailedNote is printed when the things you pressed "always allow" for could
// not be written to the configuration file.
const SaveFailedNote = "[权限] 记住的东西没能写进配置文件"

// Persist writes the two sets back to the configuration file.
type Persist func(tools []string, prefixes []Rule) error

// Memory is what the user has already agreed to, so nobody is asked twice.
//
// Two sets, and only two:
//
//   - tools — tool names the user pressed `t` on;
//   - prefixes — command prefixes the user pressed `t` on.
//
// There is deliberately no "denied tools" set here. Refusal lives in the policy
// layer (`Policy.DenyTools`), which is checked before anything reaches this type;
// mixing the two would mean two places could answer "is this refused", and they
// would eventually disagree.
type Memory struct {
	tools    map[string]bool
	prefixes []Rule
	onChange Persist
	// Label names the file the rules were written to, for the sentence that tells
	// the user where their decision went.
	Label string
	// Sink reports a persistence failure. It never returns an error upward:
	// agreeing and then failing to remember is worse than refusing, but crashing
	// on the save would take the session down.
	Sink func(string)
}

// NewMemory builds the in-memory view of the configuration file.
func NewMemory(tools []string, prefixes []Rule, label string, onChange Persist) *Memory {
	memory := &Memory{
		tools:    map[string]bool{},
		onChange: onChange,
		Label:    label,
		Sink:     func(string) {},
	}
	for _, name := range tools {
		memory.tools[name] = true
	}
	memory.prefixes = append([]Rule(nil), prefixes...)
	return memory
}

// Tools returns a snapshot of the remembered tool names.
func (m *Memory) Tools() []string {
	out := make([]string, 0, len(m.tools))
	for name := range m.tools {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// Has reports whether a tool is remembered.
func (m *Memory) Has(toolName string) bool { return m.tools[toolName] }

// Prefixes returns a snapshot of the remembered command prefixes.
func (m *Memory) Prefixes() []Rule {
	return append([]Rule(nil), m.prefixes...)
}

// Grant remembers one tool. Idempotent.
func (m *Memory) Grant(toolName string) {
	if m.tools[toolName] {
		return
	}
	m.tools[toolName] = true
	m.persist()
}

// GrantPrefix remembers one command prefix. Idempotent.
func (m *Memory) GrantPrefix(rule Rule) {
	for _, existing := range m.prefixes {
		if sameRule(existing, rule) {
			return
		}
	}
	m.prefixes = append(m.prefixes, append(Rule(nil), rule...))
	m.persist()
}

// GrantAll remembers a whole group at once and writes once.
//
// One write, not a loop of grants: a trust group is one decision, and making it
// produce N file writes means a failure halfway through leaves half the group
// released — with nothing saying which half.
func (m *Memory) GrantAll(tools []string) {
	changed := false
	for _, name := range tools {
		if !m.tools[name] {
			m.tools[name] = true
			changed = true
		}
	}
	if changed {
		m.persist()
	}
}

func (m *Memory) persist() {
	if m.onChange == nil {
		return
	}
	// Order is stable so the file does not churn: the same set of rules always
	// writes the same bytes.
	sortedPrefixes := append([]Rule(nil), m.prefixes...)
	sort.Slice(sortedPrefixes, func(i, j int) bool {
		return ruleKey(sortedPrefixes[i]) < ruleKey(sortedPrefixes[j])
	})
	if err := m.onChange(m.Tools(), sortedPrefixes); err != nil {
		m.Sink(SaveFailedNote)
	}
}

func sameRule(a, b Rule) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}

func ruleKey(rule Rule) string {
	key := ""
	for _, token := range rule {
		key += token + "\x00"
	}
	return key
}
