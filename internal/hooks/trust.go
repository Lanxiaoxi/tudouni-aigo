package hooks

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// The trust layer: can a **workspace**'s hooks run, and what may they do.
//
// The rule this file implements is the one the design states as non-negotiable:
// a workspace's `hooks.json` arrives with a cloned repository, so it is untrusted
// code by default — and even when a person trusts it, it may only ever **tighten**
// what is allowed. `deny` and `ask` are the whole vocabulary it is given; it may
// not allow, may not rewrite arguments, and may not inject context, because each of
// those turns "a repository asked for something" into "a repository decided
// something".
//
// This is a file and not a per-hook flag on purpose: the unit of trust is the file
// a person reviewed, and a hash of that file is the smallest thing that can answer
// "is this still what I said yes to".

// TrustRecord is one workspace's approval.
type TrustRecord struct {
	// SHA256 is the hash of the `hooks.json` bytes that were trusted.
	//
	// It covers the file and nothing else, and the limit is stated rather than
	// papered over: a hook that names a script on disk can have that script's
	// content changed without the hash moving. Every implementation in this space
	// has the same hole, because the alternative is re-reading an arbitrary tree of
	// user code, so the honest thing is to say so in the notice and here.
	SHA256     string `json:"hooks_sha256"`
	ApprovedAt string `json:"approved_at"`
	// ApprovedBy is what the record is for: months later, "who said yes to this"
	// is the question nobody can answer from a bare hash.
	ApprovedBy string `json:"approved_by,omitempty"`
}

// TrustStore is `~/.tudouni/trust.json`, keyed by absolute workspace path.
type TrustStore struct {
	Path       string
	Workspaces map[string]TrustRecord `json:"workspaces"`
}

// LoadTrust reads the trust store. A missing file is an empty store.
func LoadTrust(path string) (*TrustStore, error) {
	store := &TrustStore{Path: path, Workspaces: map[string]TrustRecord{}}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return store, nil
		}
		return nil, err
	}
	text := strings.TrimPrefix(string(raw), "\ufeff")
	if err := json.Unmarshal([]byte(text), store); err != nil {
		// A corrupt trust store fails **closed**: it is read as "nothing is
		// trusted", which loses a convenience and never grants one.
		return &TrustStore{Path: path, Workspaces: map[string]TrustRecord{}}, nil
	}
	if store.Workspaces == nil {
		store.Workspaces = map[string]TrustRecord{}
	}
	store.Path = path
	return store, nil
}

// Trusted reports whether this workspace's file at `path` is approved.
//
// The comparison is by hash, so editing one byte of the file revokes the trust —
// which is the behaviour a person expects from "I reviewed this" and the reason the
// record is not keyed on the path alone.
func (s *TrustStore) Trusted(workspace, path string) (bool, TrustRecord) {
	if s == nil {
		return false, TrustRecord{}
	}
	record, present := s.Workspaces[normaliseWorkspace(workspace)]
	if !present {
		return false, TrustRecord{}
	}
	hash, err := HashFile(path)
	if err != nil {
		return false, record
	}
	return strings.EqualFold(hash, record.SHA256), record
}

// Approve records trust for one workspace's current file and writes the store.
func (s *TrustStore) Approve(workspace, path, reviewer string) (TrustRecord, error) {
	hash, err := HashFile(path)
	if err != nil {
		return TrustRecord{}, err
	}
	record := TrustRecord{
		SHA256:     hash,
		ApprovedAt: time.Now().Format(time.RFC3339),
		ApprovedBy: reviewer,
	}
	if s.Workspaces == nil {
		s.Workspaces = map[string]TrustRecord{}
	}
	key := normaliseWorkspace(workspace)
	s.Workspaces[key] = record
	if err := s.save(); err != nil {
		return record, err
	}
	return record, nil
}

// Revoke drops one workspace's record.
func (s *TrustStore) Revoke(workspace string) error {
	delete(s.Workspaces, normaliseWorkspace(workspace))
	return s.save()
}

// Workspaces returns the trusted workspaces, sorted, for a listing.
func (s *TrustStore) List() []string {
	keys := make([]string, 0, len(s.Workspaces))
	for key := range s.Workspaces {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (s *TrustStore) save() error {
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	temporary := s.Path + ".tmp"
	if err := os.WriteFile(temporary, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, s.Path)
}

// HashFile is the hash a trust record stores.
func HashFile(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// normaliseWorkspace makes two spellings of one directory compare equal.
//
// Case folding only on Windows: it is the one platform where `C:\work` and
// `c:\work` are the same directory, and folding everywhere would let a record
// approved on Linux apply to a differently-cased path that is a different
// directory there.
func normaliseWorkspace(path string) string {
	absolute, err := filepath.Abs(path)
	if err != nil {
		absolute = path
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err == nil {
		absolute = resolved
	}
	absolute = filepath.Clean(absolute)
	if isWindowsPath(absolute) {
		return strings.ToLower(absolute)
	}
	return absolute
}

// isWindowsPath reports whether this is a Windows-style path.
//
// Runtime.GOOS is not imported here because a test on one platform may hand a path
// spelled for the other; the shape of the string is what this is actually about.
func isWindowsPath(path string) bool {
	if len(path) >= 3 && path[1] == ':' && (path[2] == '\\' || path[2] == '/') {
		return true
	}
	return strings.HasPrefix(path, `\\`)
}

// Restrict is what a workspace's set is allowed to do.
//
// It is applied **after** the chain has run, not inside it, and that ordering is
// deliberate: the hooks still execute and each still produces its audit row, so
// "this repository's guardrail saw the call and refused it" stays visible, while a
// decision the design does not grant it — `allow`, a rewrite, an injection — is
// dropped and recorded as dropped.
//
// Returning the dropped capability's names rather than a bare bool is what lets the
// notice say **which** part of a workspace hook had no effect, which is the only
// version of this that is not "it silently did not work".
func Restrict(result Result, event Event) (Result, []string) {
	var refused []string

	// Stage 2's allowlist: a workspace may only speak about tool calls. A
	// repository that could run code on `user_prompt_submit` or `stop` would be
	// shaping the conversation rather than guarding its own calls.
	if event != EventPreToolUse && event != EventPostToolUse {
		if len(result.Outcomes) > 0 {
			refused = append(refused, "event")
		}
		return Result{Outcomes: skippedOutcomes(result, "a workspace hook may only run on pre_tool_use and post_tool_use")}, refused
	}

	if result.Decision == DecisionAllow {
		result.Decision = DecisionNone
		result.Reason = ""
		refused = append(refused, "allow")
	}
	if result.Rewritten {
		result.Updated = nil
		result.Rewritten = false
		refused = append(refused, "updated_input")
	}
	if result.Context != "" {
		result.Context = ""
		refused = append(refused, "additional_context")
	}
	// `ask` needs no special case: it is one of the two decisions a workspace hook
	// is allowed, and it can only ever make the gate stricter.
	if result.Decision == DecisionDeny && result.DeniedBy == "" {
		result.DeniedBy = "workspace"
	}
	return result, refused
}

// skippedOutcomes rewrites every outcome to say it had no effect.
func skippedOutcomes(result Result, why string) []Outcome {
	out := make([]Outcome, 0, len(result.Outcomes))
	for _, outcome := range result.Outcomes {
		outcome.Status = StatusSkipped
		outcome.Decision = DecisionNone
		outcome.ReasonPreview = why
		out = append(out, outcome)
	}
	return out
}

// RestrictedEvents are the only events a workspace's hooks may listen to.
//
// Phase 2's rule, written as a set rather than as a branch inside `Restrict`, so a
// future event has to be added here on purpose. `pre_tool_use` and
// `post_tool_use` are the two a guardrail needs and the two that cannot shape a
// conversation: everything else either speaks for the person (the prompt), decides
// how long a turn runs (stop), or reaches a subsystem the workspace does not own
// (session lifecycle, compaction, delegation).
var RestrictedEvents = map[Event]bool{
	EventPreToolUse:  true,
	EventPostToolUse: true,
}

// RestrictSet is `Restrict` applied to a whole configuration: what a trusted
// workspace's file is allowed to be, before anything runs.
//
// Dropping the hooks outright rather than clipping them per call is deliberate. A
// `stop` hook that runs and is then ignored still pays a process per turn, and the
// person who wrote it learns nothing; leaving it out of the set means `--hooks`
// lists it as unfireable and the notice can say why.
//
// What survives is **what kind** of hook, not just which event: a `pre_tool_use`
// hook that returns `allow` still runs (its `deny` and `ask` are useful) and its
// allow is dropped where it happens. That is why the restriction has to be applied
// in two places — here for events, and in `Restrict` for kinds — and why both
// exist rather than one.
func RestrictSet(set *Set) *Set {
	if set == nil {
		return nil
	}
	out := &Set{
		Path:      set.Path,
		Source:    SourceWorkspace,
		Workspace: set.Workspace,
		ByEvent:   map[Event][]Hook{},
		Defaults:  set.Defaults,
		Problems:  set.Problems,
		Warnings:  set.Warnings,
	}
	for event, list := range set.ByEvent {
		if !RestrictedEvents[event] {
			continue
		}
		// The origin is rewritten on the copy: these hooks are about to be folded into
		// the session's configuration, where `Source` on each hook is the only thing
		// that still says which of them may only tighten.
		tightened := make([]Hook, 0, len(list))
		for _, hook := range list {
			hook.Source = SourceWorkspace
			tightened = append(tightened, hook)
		}
		out.ByEvent[event] = tightened
	}
	return out
}

// TrustCommand is `--trust-workspace-hooks`: print what will be trusted, then
// record it.
//
// Printing first is the whole point — the command exists so a person can see the
// commands a repository is about to run, and a version that recorded trust without
// showing them would be an approval prompt with the text hidden.
func TrustCommand(trustPath, workspace, file, reviewer string, out func(string)) error {
	set, err := Load(file)
	if err != nil {
		return err
	}
	if set == nil || set.Len() == 0 {
		return fmt.Errorf("%s has no enabled hooks", file)
	}
	out(fmt.Sprintf("trusting %s (%d hooks, %d problems)", file, set.Len(), len(set.Problems)))
	for _, row := range set.Describe() {
		out(fmt.Sprintf("  %-18s %-20s %-24s %s", row.Event, row.Name, row.Matcher, row.Command))
	}
	for _, warning := range set.Warnings {
		out("  warning: " + warning)
	}
	for _, problem := range set.Problems {
		out("  skipped: " + problem.String())
	}
	store, err := LoadTrust(trustPath)
	if err != nil {
		return err
	}
	record, err := store.Approve(workspace, file, reviewer)
	if err != nil {
		return err
	}
	out(fmt.Sprintf("recorded in %s: %s (%s)", trustPath, record.SHA256[:12], record.ApprovedAt))
	out("a workspace hook may only deny or ask, and only on pre_tool_use / post_tool_use")
	return nil
}
