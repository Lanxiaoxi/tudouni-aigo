package cggraph

// Detecting build-tool conventions that a resolver cannot infer.
//
// Two of them matter:
//
//   - the Go module path, which maps `github.com/x/y/internal/tools` onto `internal/tools`;
//   - TypeScript path aliases, which map `@/components/Foo` onto `src/components/Foo`.
//
// Both are facts about the project rather than rules of the language, so they are read
// from the project's own configuration instead of guessed. A resolver without them treats
// an aliased import as a bare package specifier — an external dependency — and quietly
// drops every edge through it.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// DetectPathAliases reads a tsconfig.json's `compilerOptions.paths` and returns the
// prefix→directory table the JS tier needs.
//
// `baseUrl` is applied to each target, because a target in tsconfig is relative to
// baseUrl, not to the config file. Both keys are commonly written with a trailing slash
// (`"@/*": ["src/*"]`), and the `*` is the wildcard the alias stands for — so `@/` maps to
// `src/` and a reference `@/foo/Bar` becomes `src/foo/Bar`.
//
// tsconfig files are JSON with comments and trailing commas, which `encoding/json` refuses.
// The parser here is deliberately not a JSON parser: it locates the `paths` object and reads
// its string arrays, which is enough for a table and immune to the comment problem.
func DetectPathAliases(root string) map[string]string {
	for _, name := range []string{"tsconfig.json", "tsconfig.base.json", "jsconfig.json"} {
		raw, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			continue
		}
		if aliases := parseTsconfigPaths(string(raw)); len(aliases) > 0 {
			return aliases
		}
	}
	return nil
}

// tsPathEntryRE finds one `"prefix": ["target", ...]` entry.
var tsPathEntryRE = regexp.MustCompile(`"([^"]+)"\s*:\s*\[([^\]]*)\]`)

// tsTargetRE finds one quoted target inside an entry's array.
var tsTargetRE = regexp.MustCompile(`"([^"]+)"`)

// extractPathsBlock returns the body of the `paths` object.
//
// Located by brace matching rather than a character class: a `paths` object's values are
// arrays, and a pattern that stops at the first `}` would either cut the block short or
// (as an earlier version did) fail to match at all once the body contains a nested `{`.
func extractPathsBlock(text string) string {
	// Find the key itself, so a string value containing "paths" cannot match.
	keyIndex := -1
	for _, match := range regexp.MustCompile(`"paths"\s*:`).FindAllStringIndex(text, -1) {
		keyIndex = match[1]
		break
	}
	if keyIndex < 0 {
		return ""
	}
	open := strings.IndexByte(text[keyIndex:], '{')
	if open < 0 {
		return ""
	}
	open += keyIndex
	depth := 0
	for i := open; i < len(text); i++ {
		switch text[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return text[open+1 : i]
			}
		}
	}
	return ""
}

// parseTsconfigPaths extracts the alias table from a tsconfig body.
func parseTsconfigPaths(text string) map[string]string {
	// Strip comments first: a `//` or `/* */` inside the paths block would otherwise be
	// read as part of a key or target.
	text = stripJSONComments(text)

	block := extractPathsBlock(text)
	if block == "" {
		return nil
	}
	baseURL := parseTsconfigBaseURL(text)

	aliases := map[string]string{}
	for _, entry := range tsPathEntryRE.FindAllStringSubmatch(block, -1) {
		targets := tsTargetRE.FindAllStringSubmatch(entry[2], -1)
		if len(targets) == 0 {
			continue
		}
		target := targets[0][1]
		// A target is relative to baseUrl when one is declared.
		if baseURL != "" && !strings.HasPrefix(target, ".") {
			target = filepath.ToSlash(filepath.Join(baseURL, target))
		}
		// `src/*` stands for the directory `src/`, and `@/*` matches a reference written
		// `@/foo` — so the wildcard is stripped from BOTH sides. Keeping it on the key
		// would make every lookup a prefix test against a literal `*`, which never matches.
		target = strings.TrimSuffix(target, "*")
		prefix := strings.TrimSuffix(entry[1], "*")
		aliases[prefix] = target
	}
	if len(aliases) == 0 {
		return nil
	}
	return aliases
}

// parseTsconfigBaseURL reads `compilerOptions.baseUrl`.
func parseTsconfigBaseURL(text string) string {
	match := regexp.MustCompile(`"baseUrl"\s*:\s*"([^"]+)"`).FindStringSubmatch(text)
	if match == nil {
		return ""
	}
	base := filepath.ToSlash(match[1])
	// `"."` means the config file's own directory, which is the default; representing it
	// as an empty prefix lets filepath.Join do the right thing.
	if base == "." {
		return ""
	}
	return strings.TrimSuffix(base, "/")
}

// stripJSONComments removes `//` and `/* */` comments from JSON-looking text.
//
// String literals are skipped so a `//` inside a path is not mistaken for a comment.
func stripJSONComments(text string) string {
	var out strings.Builder
	inString := false
	for i := 0; i < len(text); i++ {
		c := text[i]
		if inString {
			out.WriteByte(c)
			if c == '\\' && i+1 < len(text) {
				out.WriteByte(text[i+1])
				i++
				continue
			}
			if c == '"' {
				inString = false
			}
			continue
		}
		switch {
		case c == '"':
			inString = true
			out.WriteByte(c)
		case c == '/' && i+1 < len(text) && text[i+1] == '/':
			for i < len(text) && text[i] != '\n' {
				i++
			}
			out.WriteByte('\n')
		case c == '/' && i+1 < len(text) && text[i+1] == '*':
			end := strings.Index(text[i+2:], "*/")
			if end < 0 {
				return out.String()
			}
			i += 2 + end + 1
		default:
			out.WriteByte(c)
		}
	}
	return out.String()
}

// DetectGoModule reads the module path from a go.mod at or above `root`.
func DetectGoModule(root string) string {
	dir := root
	for {
		raw, err := os.ReadFile(filepath.Join(dir, "go.mod"))
		if err == nil {
			for _, line := range strings.Split(string(raw), "\n") {
				line = strings.TrimSpace(line)
				if !strings.HasPrefix(line, "module") {
					continue
				}
				rest := strings.TrimSpace(strings.TrimPrefix(line, "module"))
				rest = strings.Trim(rest, "\"`")
				if fields := strings.Fields(rest); len(fields) > 0 {
					return fields[0]
				}
			}
			return ""
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// DescribeProject reports what a project's configuration provides a resolver.
//
// Exposed so `cg status` can say which conventions were detected: a run that found no
// tsconfig reports zero aliases, and that is the difference between "the resolver chose
// not to narrow" and "the aliases were never read".
type ProjectConfig struct {
	GoModule    string
	PathAliases map[string]string
}

// DetectProjectConfig reads what it can from a root.
func DetectProjectConfig(root string) ProjectConfig {
	return ProjectConfig{
		GoModule:    DetectGoModule(root),
		PathAliases: DetectPathAliases(root),
	}
}

var _ = json.Marshal
