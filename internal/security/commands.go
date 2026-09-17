// Package security decides what the agent is allowed to do without asking.
//
// Three layers, each answering a different question:
//
//   - policy: by risk level and by tool name. Coarse, declarative, written by the user.
//   - commands: for tools that carry a command line, does a rule the user wrote
//     cover every segment of it?
//   - gate: brings the two together, asks a human when neither settles it, and
//     reports which of the eight outcomes it reached.
//
// The direction of every uncertain case is the same: it asks. There is no
// "read-only command" list here, no heuristics and no classifier — rules are
// written by a person and this only matches them conservatively.
package security

import (
	"fmt"
	"strings"
	"unicode"
)

// Rule is a command prefix: the tokens a command may start with.
type Rule []string

// Segment separators. `&` is really the call operator in PowerShell rather than a
// separator, and it is treated as one anyway: splitting too eagerly means segments
// fail to match and a human gets asked, which is the safe direction, while
// splitting too little means releasing a compound command.
var separators = []string{"&&", "||", ";", "|", "&", "\n", "\r"}

// unsafeSubstrings abandon the judgement.
//
// `$(` and a backtick are command substitution — another command spliced into
// this one; `${` is a variable or sub-expression; `>` and `<` are redirection,
// which writes files. Any of them means "the first few words" no longer describe
// what the command will actually do.
var unsafeSubstrings = []string{"$(", "`", "${", ">", "<"}

// commandArguments lists which tools carry a command line, and in which parameter.
//
// An explicit table rather than "the parameter is called command": a new tool only
// takes part in prefix rules once it appears here, and a rule that takes effect by
// accident is harder to find than no rule at all.
//
// shell_background has a concrete consequence: leave it out and the same prefix
// rule applies to commands you run in the foreground but not to the ones you run
// in the background. The symptom is "why is it asking me again", and the cause —
// a missing line in a table — is visible in no output at all.
var commandArguments = map[string]string{
	"shell":            "command",
	"shell_background": "command",
}

// CommandParameter returns which parameter of this tool holds a command line.
func CommandParameter(toolName string) (string, bool) {
	name, ok := commandArguments[toolName]
	return name, ok
}

// RegisterCommandParameter adds a tool to the command-carrying table.
//
// New tools are expected to declare this where they are defined rather than being
// edited into the table above: a rule that takes effect by accident is harder to
// find than no rule at all, and this way the declaration sits next to the schema
// it describes.
func RegisterCommandParameter(toolName, parameter string) {
	if toolName == "" || parameter == "" {
		return
	}
	commandArguments[toolName] = parameter
}

// CommandOf returns the command line of one call, if there is one.
func CommandOf(toolName string, arguments map[string]any) (string, bool) {
	parameter, ok := commandArguments[toolName]
	if !ok {
		return "", false
	}
	value, ok := arguments[parameter].(string)
	if !ok || strings.TrimSpace(value) == "" {
		return "", false
	}
	return value, true
}

// Parse splits a command line into one token list per segment.
//
// A nil result means "cannot tell" and the caller must ask a human. The returned
// segments have their quotes removed, because that is the shell's own semantics
// (`git "add"` runs `git add`). Empty segments are dropped: they do nothing.
func Parse(command string, windows bool) [][]string {
	for _, bad := range unsafeSubstrings {
		if strings.Contains(command, bad) {
			return nil
		}
	}
	var parsed [][]string
	for _, segment := range splitSegments(command) {
		tokens, ok := tokenize(segment, windows)
		if !ok {
			return nil
		}
		if len(tokens) > 0 {
			parsed = append(parsed, tokens)
		}
	}
	return parsed
}

// Covered reports whether every segment of the command is covered by a rule.
//
// It returns the rule matched by the **first** segment: in a chained command that
// one best explains "why was this not asked about". Later segments may match other
// rules, but the audit wants the reason, not every reason.
func Covered(command string, rules []Rule, windows bool) (Rule, bool) {
	parsed := Parse(command, windows)
	if len(parsed) == 0 || len(rules) == 0 {
		return nil, false
	}
	var first Rule
	for index, tokens := range parsed {
		matched, ok := matchSegment(tokens, rules, windows)
		if !ok {
			// One segment nobody claims means the whole thing gets asked about.
			return nil, false
		}
		if index == 0 {
			first = matched
		}
	}
	return first, true
}

// SuggestPrefix derives the prefix "always allow" should remember.
//
// It takes the command word of the first segment: the first token, plus the second
// if that is not an option. `git add -p x.py` gives `git add`; `ls -la` gives `ls`;
// `python -m pytest` gives `python`.
//
// That last one is coarse (`-m` is an option, so `pytest` cannot be recovered) —
// which is why the approval prompt prints the derived prefix verbatim: if it looks
// wrong, do not press t, and write a finer rule by hand instead. A hand-written
// rule may be any token prefix, such as `python -m pytest`.
//
// A chained command always yields nothing. `git status && rm -rf build` would
// derive `git status`, which does not cover the chain (coverage requires every
// segment), so pressing t would remember something that fails to help next time —
// a key that looks like "never ask about this again" and remembers nothing is
// worse than not offering it.
func SuggestPrefix(command string, windows bool) (Rule, bool) {
	parsed := Parse(command, windows)
	if len(parsed) != 1 {
		return nil, false
	}
	tokens := parsed[0]
	if len(tokens) > 1 && !strings.HasPrefix(tokens[1], "-") {
		return Rule{tokens[0], tokens[1]}, true
	}
	return Rule{tokens[0]}, true
}

// ParseRule turns one rule string from the configuration file into tokens.
//
// A rule is a command **prefix**, not a command, so there is no splitting here:
// a separator, a redirection or an unbalanced quote means it was written wrong.
// Catching it at load time rather than leaving it to the matcher matters, because
// "one rule was read as two" has to be said at startup instead of surfacing later
// as a quietly released approval.
func ParseRule(text string, windows bool) (Rule, error) {
	for _, separator := range separators {
		if strings.Contains(text, separator) {
			return nil, fmt.Errorf("a rule may not contain a separator (; | && newline, …): %q — a rule is a command prefix, not a command", text)
		}
	}
	for _, bad := range unsafeSubstrings {
		if strings.Contains(text, bad) {
			return nil, fmt.Errorf("a rule may not contain a redirection or a command substitution: %q", text)
		}
	}
	tokens, ok := tokenize(text, windows)
	if !ok || len(tokens) == 0 {
		return nil, fmt.Errorf("the rule is empty or has an unbalanced quote: %q", text)
	}
	return Rule(tokens), nil
}

// FormatRule writes a rule back as one line of the configuration file.
//
// A token containing whitespace or a quote gets quoted again; otherwise a rule
// like `git commit -m "wip wip"` would read back as two tokens. A configuration
// file broken by its own write-back step is the hardest class of bug to find.
func FormatRule(rule Rule) (string, error) {
	parts := make([]string, 0, len(rule))
	for _, token := range rule {
		quoted, err := quoteToken(token)
		if err != nil {
			return "", err
		}
		parts = append(parts, quoted)
	}
	return strings.Join(parts, " "), nil
}

func quoteToken(token string) (string, error) {
	if !strings.ContainsAny(token, " \t\"'") {
		return token, nil
	}
	if !strings.Contains(token, "'") {
		return "'" + token + "'", nil
	}
	if !strings.Contains(token, `"`) {
		return `"` + token + `"`, nil
	}
	return "", fmt.Errorf("this token has both kinds of quote in it and cannot be written back: %q", token)
}

// splitSegments cuts the command at separators, ignoring separators inside quotes.
// An unbalanced quote is left for the tokenizer to reject.
func splitSegments(command string) []string {
	var segments []string
	var current strings.Builder
	var quote rune

	runes := []rune(command)
	for index := 0; index < len(runes); {
		char := runes[index]
		if quote != 0 {
			current.WriteRune(char)
			if char == quote {
				quote = 0
			}
			index++
			continue
		}
		if char == '\'' || char == '"' {
			quote = char
			current.WriteRune(char)
			index++
			continue
		}
		rest := string(runes[index:])
		matched := ""
		for _, separator := range separators {
			if strings.HasPrefix(rest, separator) {
				matched = separator
				break
			}
		}
		if matched == "" {
			current.WriteRune(char)
			index++
			continue
		}
		segments = append(segments, current.String())
		current.Reset()
		index += len([]rune(matched))
	}
	segments = append(segments, current.String())
	return segments
}

// tokenize splits one segment into tokens the way a shell would, removing quotes.
// An unbalanced quote yields ok=false: the intent is not guessed at.
//
// The escape character follows the platform: a backslash for sh, a backtick for
// PowerShell. Single quotes are entirely literal on both.
func tokenize(segment string, windows bool) ([]string, bool) {
	escape := '\\'
	if windows {
		escape = '`'
	}

	var tokens []string
	var current strings.Builder
	var quote rune

	runes := []rune(segment)
	for index := 0; index < len(runes); index++ {
		char := runes[index]

		switch quote {
		case '\'':
			if char == '\'' {
				quote = 0
			} else {
				current.WriteRune(char)
			}
			continue
		case '"':
			switch {
			case char == quote:
				quote = 0
			case char == escape && index+1 < len(runes):
				current.WriteRune(runes[index+1])
				index++
			default:
				current.WriteRune(char)
			}
			continue
		}

		switch {
		case char == '\'' || char == '"':
			quote = char
		case char == escape && index+1 < len(runes):
			current.WriteRune(runes[index+1])
			index++
		case unicode.IsSpace(char):
			if current.Len() > 0 {
				tokens = append(tokens, current.String())
				current.Reset()
			}
		default:
			current.WriteRune(char)
		}
	}

	if quote != 0 {
		return nil, false
	}
	if current.Len() > 0 {
		tokens = append(tokens, current.String())
	}
	return tokens, true
}

func matchSegment(tokens []string, rules []Rule, windows bool) (Rule, bool) {
	for _, rule := range rules {
		if len(rule) > len(tokens) {
			continue
		}
		matches := true
		for index, expected := range rule {
			if !sameToken(tokens[index], expected, index, windows) {
				matches = false
				break
			}
		}
		if matches {
			return rule, true
		}
	}
	return nil, false
}

// sameToken compares two tokens.
//
// The command name is case-insensitive on Windows (executables are), and only the
// first token is folded: the case of an argument may be a path, and git's own
// subcommands are case-sensitive.
func sameToken(token, expected string, index int, windows bool) bool {
	if index == 0 && windows {
		return strings.EqualFold(token, expected)
	}
	return token == expected
}
