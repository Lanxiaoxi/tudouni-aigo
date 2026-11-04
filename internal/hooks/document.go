package hooks

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Editing `hooks.json` as data.
//
// The file is read by `Load` at start-up and edited by a person in a text editor; this
// file is the third reader, for a front end that edits it through a form. The rule that
// shapes everything below is that **a form may never write a file start-up would refuse**:
// a broken `hooks.json` stops every new session, which is the worst outcome a settings
// screen could have. So the validator is not rewritten here. `Save` encodes the document
// and then runs the same `Parse` start-up runs over the bytes, and writes nothing unless
// that accepts them.
//
// What is edited is the **user-level** file only. A workspace's file arrives with a cloned
// repository and is reviewed by hash (`trust.go`); letting a form rewrite it would change
// the bytes that approval was given for.

// Entry is one hook as a form shows it.
//
// Optional settings are pointers because "not written in the file" and "written with the
// default's value" are different files: the first follows the default if it ever moves,
// the second pins it. A form that always wrote the resolved value would silently pin every
// hook it touched.
type Entry struct {
	Event   string
	Name    string
	Matcher string
	// Argv and Line are the two spellings of `command`, and exactly one of them is used:
	// a list when Argv is non-empty, a string otherwise. They stay two fields because the
	// file allows both and a round trip must not change which one a person chose — the
	// list form has no quoting, the string form goes through the platform shell.
	Argv []string
	Line string

	TimeoutMs      *int
	MaxOutputBytes *int
	FailClosed     *bool
	Enabled        bool
	StatusMessage  string
}

// CommandText is the command as one editable line, and whether it runs through the shell.
//
// A form has one text box for this, so the two spellings meet here: a list is joined with
// the quoting `SplitCommand` reads back, a string is shown as written. `shell` is what lets
// the form keep a hand-written `a && b` as the shell command it is instead of quietly
// turning it into a program called `&&`.
func (e Entry) CommandText() (text string, shell bool) {
	if len(e.Argv) > 0 {
		return joinCommand(e.Argv), false
	}
	return strings.TrimSpace(e.Line), true
}

// SplitCommand is the inverse of the quoting `joinCommand` applies: whitespace separates
// words, a double-quoted run is one word, `\"` inside quotes is a quote, and every other
// backslash is literal — so `C:\tools\guard.py` means what it says.
//
// An unterminated quote is an error rather than a guess: a command that quietly runs a
// different program than the one on screen is worse than one that is refused.
func SplitCommand(text string) ([]string, error) {
	words := []string{}
	var current strings.Builder
	started, quoted := false, false
	runes := []rune(text)
	for index := 0; index < len(runes); index++ {
		char := runes[index]
		switch {
		case quoted && char == '\\' && index+1 < len(runes) && runes[index+1] == '"':
			current.WriteRune('"')
			index++
		case char == '"':
			quoted = !quoted
			started = true
		case !quoted && (char == ' ' || char == '\t' || char == '\n' || char == '\r'):
			if started {
				words = append(words, current.String())
				current.Reset()
				started = false
			}
		default:
			current.WriteRune(char)
			started = true
		}
	}
	if quoted {
		return nil, fmt.Errorf("the command has an opening quote with no closing one")
	}
	if started {
		words = append(words, current.String())
	}
	return words, nil
}

// DocumentDefaults is the file's `defaults` block, nil where the file says nothing.
type DocumentDefaults struct {
	TimeoutMs      *int `json:"timeout_ms"`
	MaxOutputBytes *int `json:"max_output_bytes"`
}

// Document is the editable content of a hooks file.
type Document struct {
	Defaults DocumentDefaults `json:"defaults"`
	Entries  []Entry          `json:"entries"`

	// Comment is the top-level `$comment`, which the loader accepts and a form has no
	// field for. It is carried so saving does not delete a note somebody wrote.
	Comment any `json:"-"`
}

// File is a hooks file as it is on disk right now.
type File struct {
	Path   string
	Exists bool
	// Revision identifies the exact bytes that were read (a SHA-256), "" when there is no
	// file. A save carries the revision it was drawn from, which is how two windows — or a
	// window and a text editor — cannot silently overwrite each other.
	Revision string
	Doc      Document
	// Set is the validated, resolved configuration, nil when there is no file. It is what
	// start-up would load, so a form can show the timeout a hook will actually get.
	Set *Set
}

// ErrFileChanged is returned by `Save` when the file is not the one the caller read.
var ErrFileChanged = errors.New("hooks.json changed on disk after it was read")

// ErrFileBroken is returned by `Save` when the file on disk cannot be used. It is a
// different refusal from an invalid *new* document: here the bytes already on disk are the
// problem, and they are left exactly as they are.
var ErrFileBroken = errors.New("hooks.json on disk cannot be used")

// revisionOf is the identity of a file's bytes.
func revisionOf(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// ReadFile reads and validates the file at `path`.
//
// A missing file is not an error: it is the ordinary state, and the result is an empty
// document. A file that exists and cannot be used **is** an error, and the returned File is
// still non-nil with its path and revision, so the caller can say which file and still
// refuse to overwrite it.
func ReadFile(path string) (*File, error) {
	file := &File{Path: path, Doc: Document{Entries: []Entry{}}}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return file, nil
		}
		file.Exists = true
		return file, fmt.Errorf("%s: %w", path, err)
	}
	file.Exists = true
	file.Revision = revisionOf(raw)

	set, err := Parse(path, raw)
	if err != nil {
		return file, err
	}
	file.Set = set

	doc, err := documentFromRaw(raw)
	if err != nil {
		return file, &ConfigError{Path: path, Detail: err.Error()}
	}
	file.Doc = doc
	return file, nil
}

// documentFromRaw lifts bytes `Parse` has already accepted into an editable document.
//
// It runs only after `Parse` succeeded, so the shapes here are known; the type switches
// still do not assume, because a panic in a reader of a user's file would be a worse
// failure than a field coming back empty.
func documentFromRaw(raw []byte) (Document, error) {
	doc := Document{Entries: []Entry{}}
	var top map[string]any
	if err := json.Unmarshal([]byte(strings.TrimPrefix(string(raw), "\ufeff")), &top); err != nil {
		return doc, err
	}
	if comment, present := top["$comment"]; present {
		doc.Comment = comment
	}
	if block, ok := top["defaults"].(map[string]any); ok {
		doc.Defaults.TimeoutMs = optionalInt(block["timeout_ms"])
		doc.Defaults.MaxOutputBytes = optionalInt(block["max_output_bytes"])
	}
	byEvent, _ := top["hooks"].(map[string]any)
	// The canonical event order, not the file's: a JSON object has none, and a stable order
	// is what makes "save without changing anything" produce the same file twice.
	for _, event := range Events {
		list, _ := byEvent[string(event)].([]any)
		for _, item := range list {
			object, _ := item.(map[string]any)
			doc.Entries = append(doc.Entries, entryFromObject(event, object))
		}
	}
	return doc, nil
}

func entryFromObject(event Event, object map[string]any) Entry {
	entry := Entry{Event: string(event), Enabled: true, Argv: []string{}}
	if name, ok := object["name"].(string); ok {
		entry.Name = strings.TrimSpace(name)
	}
	if text, ok := object["matcher"].(string); ok {
		entry.Matcher = text
	}
	switch command := object["command"].(type) {
	case string:
		entry.Line = strings.TrimSpace(command)
	case []any:
		for _, item := range command {
			if text, ok := item.(string); ok {
				entry.Argv = append(entry.Argv, text)
			}
		}
	}
	entry.TimeoutMs = optionalInt(object["timeout_ms"])
	entry.MaxOutputBytes = optionalInt(object["max_output_bytes"])
	if flag, ok := object["fail_closed"].(bool); ok {
		entry.FailClosed = &flag
	}
	if flag, ok := object["enabled"].(bool); ok {
		entry.Enabled = flag
	}
	if text, ok := object["status_message"].(string); ok {
		entry.StatusMessage = text
	}
	return entry
}

// optionalInt reads a JSON number as a pointer, nil for anything that is not a whole one.
func optionalInt(value any) *int {
	switch typed := value.(type) {
	case float64:
		if typed != float64(int(typed)) {
			return nil
		}
		number := int(typed)
		return &number
	case int:
		return &typed
	default:
		return nil
	}
}

// DocumentFromMap reads the document a front end sends.
//
// This is the boundary between a form and the file, so it is strict about **types** and
// says nothing about **meaning**: whether a timeout is in range or a matcher compiles is
// `Parse`'s judgement, made once, on the bytes that would actually be written.
func DocumentFromMap(raw map[string]any) (Document, error) {
	doc := Document{Entries: []Entry{}}
	if block, present := raw["defaults"]; present && block != nil {
		object, ok := block.(map[string]any)
		if !ok {
			return doc, fmt.Errorf("`defaults` must be an object")
		}
		var err error
		if doc.Defaults.TimeoutMs, err = wireInt(object, "timeout_ms"); err != nil {
			return doc, fmt.Errorf("`defaults`: %w", err)
		}
		if doc.Defaults.MaxOutputBytes, err = wireInt(object, "max_output_bytes"); err != nil {
			return doc, fmt.Errorf("`defaults`: %w", err)
		}
	}
	list, ok := raw["entries"].([]any)
	if !ok {
		return doc, fmt.Errorf("`entries` must be a list")
	}
	for index, item := range list {
		object, ok := item.(map[string]any)
		if !ok {
			return doc, fmt.Errorf("entry %d must be an object", index+1)
		}
		entry, err := entryFromWire(object)
		if err != nil {
			return doc, fmt.Errorf("entry %d: %w", index+1, err)
		}
		doc.Entries = append(doc.Entries, entry)
	}
	return doc, nil
}

func entryFromWire(object map[string]any) (Entry, error) {
	entry := Entry{Enabled: true, Argv: []string{}}
	var err error
	if entry.Event, err = wireString(object, "event"); err != nil {
		return entry, err
	}
	if entry.Name, err = wireString(object, "name"); err != nil {
		return entry, err
	}
	if entry.Matcher, err = wireString(object, "matcher"); err != nil {
		return entry, err
	}
	if entry.StatusMessage, err = wireString(object, "status_message"); err != nil {
		return entry, err
	}
	// One line of text and one flag, not the file's two spellings: a form has a single text
	// box, and the quoting rules live in `SplitCommand` so they exist exactly once.
	command, err := wireString(object, "command")
	if err != nil {
		return entry, err
	}
	shell := false
	if value, present := object["shell"]; present && value != nil {
		flag, ok := value.(bool)
		if !ok {
			return entry, fmt.Errorf("`shell` must be true or false")
		}
		shell = flag
	}
	if shell {
		entry.Line = strings.TrimSpace(command)
	} else if entry.Argv, err = SplitCommand(command); err != nil {
		return entry, err
	}
	if entry.TimeoutMs, err = wireInt(object, "timeout_ms"); err != nil {
		return entry, err
	}
	if entry.MaxOutputBytes, err = wireInt(object, "max_output_bytes"); err != nil {
		return entry, err
	}
	if value, present := object["fail_closed"]; present && value != nil {
		flag, ok := value.(bool)
		if !ok {
			return entry, fmt.Errorf("`fail_closed` must be true, false or null")
		}
		entry.FailClosed = &flag
	}
	if value, present := object["enabled"]; present && value != nil {
		flag, ok := value.(bool)
		if !ok {
			return entry, fmt.Errorf("`enabled` must be true or false")
		}
		entry.Enabled = flag
	}
	return entry, nil
}

// wireString reads an optional string; absent and null are "".
func wireString(object map[string]any, key string) (string, error) {
	value, present := object[key]
	if !present || value == nil {
		return "", nil
	}
	text, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("`%s` must be a string", key)
	}
	return text, nil
}

// wireInt reads an optional whole number; absent and null are nil ("not set").
func wireInt(object map[string]any, key string) (*int, error) {
	value, present := object[key]
	if !present || value == nil {
		return nil, nil
	}
	number := optionalInt(value)
	if number == nil {
		return nil, fmt.Errorf("`%s` must be a whole number or null", key)
	}
	return number, nil
}

// The on-disk shape. Structs rather than maps so the keys come out in the order a person
// reads them (version first, a hook's name before its command), which `encoding/json`
// would otherwise sort alphabetically.
type fileJSON struct {
	Version  int                   `json:"version"`
	Comment  any                   `json:"$comment,omitempty"`
	Defaults *defaultsJSON         `json:"defaults,omitempty"`
	Hooks    map[string][]hookJSON `json:"hooks"`
}

type defaultsJSON struct {
	TimeoutMs      *int `json:"timeout_ms,omitempty"`
	MaxOutputBytes *int `json:"max_output_bytes,omitempty"`
}

type hookJSON struct {
	Name           string `json:"name"`
	Matcher        string `json:"matcher,omitempty"`
	Command        any    `json:"command"`
	TimeoutMs      *int   `json:"timeout_ms,omitempty"`
	MaxOutputBytes *int   `json:"max_output_bytes,omitempty"`
	FailClosed     *bool  `json:"fail_closed,omitempty"`
	// Enabled is written only when it is false. `true` is the default, and a file full of
	// `"enabled": true` is noise that hides the one hook that is switched off.
	Enabled       *bool  `json:"enabled,omitempty"`
	StatusMessage string `json:"status_message,omitempty"`
}

func (e Entry) toJSON() hookJSON {
	out := hookJSON{
		Name:           strings.TrimSpace(e.Name),
		Matcher:        e.Matcher,
		TimeoutMs:      e.TimeoutMs,
		MaxOutputBytes: e.MaxOutputBytes,
		FailClosed:     e.FailClosed,
		StatusMessage:  e.StatusMessage,
	}
	if len(e.Argv) > 0 {
		out.Command = e.Argv
	} else {
		out.Command = strings.TrimSpace(e.Line)
	}
	if !e.Enabled {
		off := false
		out.Enabled = &off
	}
	return out
}

// Encode renders the document as the file's bytes.
func (d Document) Encode() ([]byte, error) {
	byEvent := map[string][]hookJSON{}
	for _, entry := range d.Entries {
		byEvent[entry.Event] = append(byEvent[entry.Event], entry.toJSON())
	}
	out := fileJSON{Version: ConfigVersion, Comment: d.Comment, Hooks: byEvent}
	if d.Defaults.TimeoutMs != nil || d.Defaults.MaxOutputBytes != nil {
		out.Defaults = &defaultsJSON{TimeoutMs: d.Defaults.TimeoutMs, MaxOutputBytes: d.Defaults.MaxOutputBytes}
	}

	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	// A command is code a person reads back: `&&` must not become `\u0026\u0026`.
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(out); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// Save writes `doc` over the file at `path` — if the file is still the one the caller read.
//
// Four ways to refuse, none of which touches the disk:
//
//   - the file on disk is not valid (somebody is mid-edit, or it was broken by hand): it
//     is not overwritten, because the bytes in it are the only copy of what they wrote;
//   - the file's revision is not `baseRevision`: it changed since the caller drew it;
//   - the document does not survive `Parse`, the validator start-up uses;
//   - the directory cannot be written.
//
// The write is a rename of a complete temporary file, so a crash leaves either the old
// file or the new one and never half of each.
func Save(path, baseRevision string, doc Document) (*File, error) {
	current, err := ReadFile(path)
	if err != nil {
		return current, fmt.Errorf("%w: %v", ErrFileBroken, err)
	}
	if current.Revision != baseRevision {
		return current, ErrFileChanged
	}
	doc.Comment = current.Doc.Comment

	encoded, err := doc.Encode()
	if err != nil {
		return current, err
	}
	set, err := Parse(path, encoded)
	if err != nil {
		return current, err
	}
	if err := writeAtomic(path, encoded); err != nil {
		return current, err
	}
	return &File{Path: path, Exists: true, Revision: revisionOf(encoded), Doc: doc, Set: set}, nil
}

func writeAtomic(path string, body []byte) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, "hooks-*.tmp")
	if err != nil {
		return err
	}
	name := temporary.Name()
	if _, err := temporary.Write(body); err != nil {
		_ = temporary.Close()
		_ = os.Remove(name)
		return err
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	if err := os.Rename(name, path); err != nil {
		_ = os.Remove(name)
		return err
	}
	return nil
}

// SameDefinition reports whether two parsed hooks would behave identically.
//
// It is how a panel tells "this hook is what the running session loaded" from "this hook
// was saved after the session started": the second kind has not run yet, and a result
// recorded under the same name before the edit describes a different command.
func SameDefinition(a, b Hook) bool {
	if a.Enabled != b.Enabled || a.MatcherSource != b.MatcherSource || a.Command != b.Command ||
		a.TimeoutMs != b.TimeoutMs || a.MaxOutputBytes != b.MaxOutputBytes ||
		a.FailClosed != b.FailClosed || a.StatusMessage != b.StatusMessage ||
		len(a.Argv) != len(b.Argv) {
		return false
	}
	for index := range a.Argv {
		if a.Argv[index] != b.Argv[index] {
			return false
		}
	}
	return true
}

// ExecutableFound reports whether the program this hook starts exists, looked up the way
// the runner will look it up: the same `PATH`, because the hook process inherits it from
// this one. It is a hint for a person looking at a list, never a decision.
func (h Hook) ExecutableFound() bool {
	if len(h.Argv) == 0 {
		return false
	}
	return looksExecutable(h.Argv[0])
}

// Script is a file in the scripts folder, with the command that would run it.
type Script struct {
	Name string
	Path string
	Argv []string
	// Command is Argv as the one editable line a form shows, quoted the way
	// `SplitCommand` reads it back.
	Command string
}

// MaxScripts bounds the list: it is a convenience for picking a file, and a folder with
// thousands of entries is not one a person picks from.
const MaxScripts = 200

// ScriptsDir is the folder a person keeps their hook scripts in, beside the file that
// names them.
func ScriptsDir(userConfigDir string) string {
	return filepath.Join(userConfigDir, "hooks")
}

// ListScripts lists one level of `dir`. A missing folder is an empty list, not an error:
// nobody is required to have one.
func ListScripts(dir string) ([]Script, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []Script
	for _, entry := range entries {
		if entry.IsDir() || strings.HasPrefix(entry.Name(), ".") || strings.HasSuffix(entry.Name(), ".tmp") {
			continue
		}
		path := filepath.ToSlash(filepath.Join(dir, entry.Name()))
		argv := suggestArgv(path)
		out = append(out, Script{Name: entry.Name(), Path: path, Argv: argv, Command: joinCommand(argv)})
		if len(out) >= MaxScripts {
			break
		}
	}
	return out, nil
}

// suggestArgv is the command that would run a script, by its extension.
//
// A suggestion and not a rule: the person sees the argument list it fills in and can change
// every word. Forward slashes on every platform, because they are the one spelling that
// needs no escaping in JSON and that Windows programs accept.
func suggestArgv(path string) []string {
	windows := runtime.GOOS == "windows"
	switch strings.ToLower(filepath.Ext(path)) {
	case ".py":
		if windows {
			return []string{"python", path}
		}
		return []string{"python3", path}
	case ".js", ".mjs", ".cjs":
		return []string{"node", path}
	case ".ps1":
		if windows {
			return []string{"powershell", "-NoProfile", "-File", path}
		}
		return []string{"pwsh", "-NoProfile", "-File", path}
	case ".sh":
		return []string{"sh", path}
	default:
		return []string{path}
	}
}
