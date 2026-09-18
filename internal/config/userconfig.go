// Package config reads the per-machine configuration file.
//
// There is exactly one configuration file: `~/.tudouni/config.json`. It follows
// the person, not the workspace — moving to another project to do work should
// not change your keys.
//
// It replaced a set of files anchored to the source directory (.env,
// models.local.json, a fallback under ~/.tudouni). Those stopped working the
// moment the program was installed as a command: the package lives in a place
// nobody edits, and "which directory am I working in" and "which key am I using"
// are unrelated questions.
//
// There is **no second source**: no environment variables, no .env. The one
// environment variable that remains (AGENT_CONFIG_FILE) answers "which file do
// we read", not "what is the value of some setting". It survives because tests
// need to point a child process at an isolated configuration and there is no
// other channel to do it through.
//
// This package is a leaf: it imports the standard library and `paths` only. Two
// other packages interpret what is inside it — the model catalog reads
// `providers`, the web tools read `web` — and keeping the reading here means the
// question "where does the config live and how is it parsed" has one answer.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
)

// File names.
const (
	ConfigFileName = "config.json"
	// ExampleFileName travels with the code. It is committed, so it must never
	// hold a real key.
	ExampleFileName = "config.example.json"
	// FileEnv says which configuration file to read this time.
	FileEnv = "AGENT_CONFIG_FILE"
)

// topKeys are the keys recognised at the top level.
//
// `ui` is accepted but does nothing: this build speaks English only, so the
// language key lost its meaning. It is recognised rather than rejected because
// an existing configuration would otherwise fail to load with a message about a
// typo — and it is not a typo, it is a removed feature. The startup notices
// explain that; see UiLanguageIgnored.
var topKeys = map[string]bool{
	"providers": true,
	"web":       true,
	"ui":        true,
	"$comment":  true,
}

// Error is raised when the configuration cannot be understood.
//
// It means "the user has to do something", not "there is a bug". The entry
// points catch it, print the message to stderr and exit with code 2 — never a
// stack trace, because this is the first file a new user edits.
type Error struct {
	Msg string
}

func (e *Error) Error() string { return e.Msg }

func errorf(format string, args ...any) *Error {
	return &Error{Msg: fmt.Sprintf(format, args...)}
}

// Unwrap lets errors.Is/As see through to a wrapped cause where one exists.
func (e *Error) Unwrap() error { return nil }

// UserConfig is what a read produced. There is no "no config" state: a missing
// file yields an empty value, so every consumer can ask for a key without first
// asking whether the file exists.
type UserConfig struct {
	// Path is the file we looked at, whether or not it is there. It is kept
	// apart from Found on purpose: Path answers "where did we look", Found
	// answers "did we find it". Collapsing the two would make the error message
	// point at the default location when the user explicitly named another one.
	Path  string
	Found bool
	// Providers is the raw `providers` section. This package does not interpret
	// it; the model catalog does.
	Providers map[string]any
	// Web is the raw `web` section, flattened to string values.
	Web map[string]string
	// UI is the raw `ui` section. Retained only so UiLanguageIgnored can say
	// whether it was present.
	UI map[string]string
	// LegacyEnvPath is set when a leftover `.env` sits next to the package.
	// Nothing reads it; the notices say so.
	LegacyEnvPath string
}

// ExampleFile returns the template's location for a message that has to name a
// path. See example.go: the bytes are always available even when no file is.

// ConfigFile returns which file to read.
//
// It does not check existence: the error message and the "where to write the
// template" answer both need the path before the file is there.
func ConfigFile() string {
	if forced := strings.TrimSpace(os.Getenv(FileEnv)); forced != "" {
		if abs, err := filepath.Abs(forced); err == nil {
			return abs
		}
		return forced
	}
	return filepath.Join(paths.UserConfigDir(), ConfigFileName)
}

// Scaffold copies the template to the default location and returns the path it
// wrote, or "" when it did nothing.
//
// It is called at the moment a missing key is reported, not on every start.
// "Make sure it exists every time" reads tidier, but it would have a deployment
// that supplies everything another way write a file into $HOME on every run —
// and in a container that home is often temporary or read-only.
//
// Three edges: it only touches the default location; it creates exclusively, so
// there is no window in which an existing file could be overwritten (this file
// will hold keys, and any overwrite is data loss); and on POSIX the file and its
// directory are tightened to 0600/0700, because the user is about to paste a
// secret into it.
func Scaffold() string {
	if strings.TrimSpace(os.Getenv(FileEnv)) != "" {
		return ""
	}
	target := filepath.Join(paths.UserConfigDir(), ConfigFileName)
	raw := ExampleBytes()

	if len(raw) == 0 {
		return ""
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return ""
	}
	tighten(filepath.Dir(target), 0o700)

	file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		// Already there, or the home directory is read-only, or the disk is
		// full. None of those should turn "report a missing key" into a crash;
		// the caller falls back to telling the user to create one.
		return ""
	}
	if _, err := file.Write(raw); err != nil {
		file.Close()
		return ""
	}
	if err := file.Close(); err != nil {
		return ""
	}
	tighten(target, 0o600)
	return target
}

// tighten narrows permissions, and gives up quietly if it cannot.
//
// Windows has no notion of group or other permissions, so the call is
// meaningless there; some network filesystems refuse chmod outright. Neither is
// worth an error.
func tighten(path string, mode os.FileMode) {
	if isWindows() {
		return
	}
	_ = os.Chmod(path, mode)
}

// Read loads the configuration.
//
// A missing file is not an error: it yields an empty value, and the caller
// reports "no usable model route" in words the user can act on. The exception is
// AGENT_CONFIG_FILE pointing at a file that is not there — that is almost always
// a mistyped path, and silently falling back to "no configuration" would send
// the user hunting through a file that never took effect.
func Read(path string) (UserConfig, error) {
	explicit := path != ""
	if !explicit {
		path = ConfigFile()
	}
	target := path

	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		if !explicit && strings.TrimSpace(os.Getenv(FileEnv)) != "" {
			return UserConfig{}, errorf(
				"%s=%s points at a file that does not exist — create it, or remove the variable (that reads the default location)",
				FileEnv, target)
		}
		return UserConfig{Path: target, LegacyEnvPath: legacyEnvPath()}, nil
	}

	raw, err := readJSONObject(target)
	if err != nil {
		return UserConfig{}, err
	}

	var unknown []string
	for key := range raw {
		if !topKeys[key] {
			unknown = append(unknown, key)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		known := []string{"providers", "web", "ui"}
		return UserConfig{}, errorf(
			"%s has unknown top-level keys: %s\n  the ones it knows are: %s\n  (a misspelled key that silently does nothing is the worst kind of failure, so this stops here)",
			target, strings.Join(unknown, ", "), strings.Join(known, ", "))
	}

	providers := map[string]any{}
	if value, ok := raw["providers"]; ok && value != nil {
		object, ok := value.(map[string]any)
		if !ok {
			return UserConfig{}, errorf(
				"\"providers\" in %s must be an object (route name → route config)", target)
		}
		providers = object
	}

	web, err := stringMap(raw["web"], target, "web")
	if err != nil {
		return UserConfig{}, err
	}
	ui, err := stringMap(raw["ui"], target, "ui")
	if err != nil {
		return UserConfig{}, err
	}

	return UserConfig{
		Path: target, Found: true,
		Providers: providers, Web: web, UI: ui,
		LegacyEnvPath: legacyEnvPath(),
	}, nil
}

// Text reads one value out of a string→string section. An empty string counts
// as "not filled in", which is what the template's blank lines mean.
func Text(mapping map[string]string, name, fallback string) string {
	if value := strings.TrimSpace(mapping[name]); value != "" {
		return value
	}
	return fallback
}

// UiLanguageIgnored reports whether a `ui` section is present, which is worth
// one line at startup: the language switch is gone, and a configuration that
// still sets it should not be silently ignored.
func UiLanguageIgnored(cfg UserConfig) bool { return len(cfg.UI) > 0 }

func stringMap(value any, where, section string) (map[string]string, error) {
	if value == nil {
		return map[string]string{}, nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, errorf("%q in %s must be an object (key → value)", section, where)
	}
	out := map[string]string{}
	for key, item := range object {
		// A key starting with `$` is a comment. JSON has none, and this file is
		// written by hand, so the note explaining an optional key has to sit
		// next to the thing it explains.
		if strings.HasPrefix(key, "$") {
			continue
		}
		text, ok := item.(string)
		if !ok {
			return nil, errorf(
				"%s[\"%s\"] in %s must be a string, got %T (numbers and true/false have to be quoted too, otherwise a pair of quotes is probably missing)",
				section, key, where, item)
		}
		out[key] = text
	}
	return out, nil
}

// ReadJSONObject reads the config file's raw top-level object, preserving every
// key it carries. It is exported for the ericai writer, whose contract is to
// change one field and leave the rest byte-equivalent.
func ReadJSONObject(path string) (map[string]any, error) {
	return readJSONObject(path)
}

func readJSONObject(path string) (map[string]any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, errorf("%s", i18n.T("config.error.unreadable", "path", path, "error", err.Error()))
	}
	text := stripBOM(raw)
	if !isValidUTF8(text) {
		return nil, errorf("%s", i18n.T("config.error.not_utf8", "path", path))
	}

	var value any
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		line, column, message := describeJSONError(text, err)
		return nil, errorf("%s", i18n.T("config.error.bad_json",
			"path", path, "line", line, "column", column, "message", message))
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, errorf("%s", i18n.T("config.error.not_object",
			"path", path, "kind", jsonKindName(value)))
	}
	return object, nil
}

// describeJSONError turns encoding/json's offset into a line and column.
//
// The offset is what json gives us; a line and column is what a person needs.
func describeJSONError(text string, err error) (int, int, string) {
	var syntax *json.SyntaxError
	message := err.Error()
	offset := int64(-1)
	if errors.As(err, &syntax) {
		offset = syntax.Offset
		message = syntax.Error()
	}
	if offset < 0 {
		return 1, 1, message
	}
	line, column := 1, 1
	for index, r := range text {
		if int64(index) >= offset-1 {
			break
		}
		if r == '\n' {
			line++
			column = 1
			continue
		}
		column++
	}
	return line, column, message
}

func legacyEnvPath() string {
	candidate := filepath.Join(paths.PackageDir(), ".env")
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		return candidate
	}
	return ""
}

func jsonKindName(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case json.Number, float64:
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	default:
		return "object"
	}
}
