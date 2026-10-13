// Package bootstrap's configsync.go is Phase 4 of the design (§9): deciding
// what state a remote `~/.tudouni/config.json` is in, and computing the
// content fingerprint the conflict-detection rule (§9.5) compares against a
// baseline.
//
// This file deliberately does not re-implement JSON validation: it writes
// the bytes a caller already read (over SFTP, on the Rust side) to a throwaway
// temp file and calls `config.Read` on it — the one function that already
// knows every rule a config.json must satisfy (unknown top-level keys, a
// non-object `providers`, a non-string-map `web`/`ui`). Two parsers for one
// file format is exactly the kind of drift the rest of this project avoids,
// and `config.Read`'s existing tests already cover the rules this depends on.
package bootstrap

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/config"
)

// ConfigStatus is the remote config.json's state, per §9.3 of the design.
type ConfigStatus string

const (
	// ConfigMissing means no file exists at the remote path.
	ConfigMissing ConfigStatus = "missing"
	// ConfigEmptyTemplate means the file exists but has no provider routes
	// at all — the shape `config.Scaffold` writes, untouched.
	ConfigEmptyTemplate ConfigStatus = "empty_template"
	// ConfigNoUsableRoute means at least one route is listed, but none of
	// them carry an API key — present but not actually usable.
	ConfigNoUsableRoute ConfigStatus = "no_usable_route"
	// ConfigValid means at least one route has a key and is usable.
	ConfigValid ConfigStatus = "valid"
	// ConfigCorrupt means the file could not be parsed at all — invalid
	// JSON, a wrong-shaped section, an unknown top-level key. Per §9.3,
	// corrupt config must never be treated as an empty template.
	ConfigCorrupt ConfigStatus = "corrupt"
)

// ConfigInspection is what a caller needs to decide a sync policy (§9.4):
// the status, and a fingerprint of the exact bytes inspected.
type ConfigInspection struct {
	Status ConfigStatus
	// Fingerprint is the SHA256 of the raw bytes, hex-encoded. Empty when
	// Status is ConfigMissing — there are no bytes to fingerprint.
	//
	// Content, not mtime, per §9.5: "modification time must not be the only
	// signal used to decide whether a configuration has changed." A caller
	// compares this against a stored baseline fingerprint to detect drift,
	// never a timestamp.
	Fingerprint string
	// Error carries the parse failure's own message when Status is
	// ConfigCorrupt, since "corrupt" alone is not something a person can
	// act on.
	Error string
}

// InspectConfigBytes classifies a config.json's content, exactly as if it
// had been read from the real path — see the package doc for why this goes
// through `config.Read` rather than its own parser. present must be false
// when the remote path does not exist at all (there is no byte sequence
// that could stand for "missing" when a file with zero bytes also exists in
// the real world: an empty file and a missing one are different facts about
// the same path).
func InspectConfigBytes(present bool, raw []byte) ConfigInspection {
	if !present {
		return ConfigInspection{Status: ConfigMissing}
	}

	fingerprint := Fingerprint(raw)

	cfg, err := readConfigBytes(raw)
	if err != nil {
		return ConfigInspection{Status: ConfigCorrupt, Fingerprint: fingerprint, Error: err.Error()}
	}

	if len(cfg.Providers) == 0 {
		return ConfigInspection{Status: ConfigEmptyTemplate, Fingerprint: fingerprint}
	}

	if !hasUsableRoute(cfg) {
		return ConfigInspection{Status: ConfigNoUsableRoute, Fingerprint: fingerprint}
	}

	return ConfigInspection{Status: ConfigValid, Fingerprint: fingerprint}
}

// hasUsableRoute reports whether at least one provider route carries a
// non-empty api_key — the same bar `state.Registry` uses to decide a route
// is actually usable, read directly off the raw map here rather than
// through that package: configsync only needs this one yes/no fact, and
// depending on `internal/state` for it would pull the whole model catalogue
// (and its own `internal/model` dependency) into a package that otherwise
// imports only `internal/config`.
func hasUsableRoute(cfg config.UserConfig) bool {
	for _, raw := range cfg.Providers {
		route, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		key, _ := route["api_key"].(string)
		if key != "" {
			return true
		}
	}
	return false
}

// readConfigBytes writes raw to a temp file and reads it back through
// config.Read, so every validation rule that function already enforces
// (unknown keys, wrong-shaped sections) applies without being restated here.
func readConfigBytes(raw []byte) (config.UserConfig, error) {
	dir, err := os.MkdirTemp("", "tudouni-configsync-")
	if err != nil {
		return config.UserConfig{}, err
	}
	defer os.RemoveAll(dir)

	target := filepath.Join(dir, "config.json")
	if err := os.WriteFile(target, raw, 0o600); err != nil {
		return config.UserConfig{}, err
	}
	return config.Read(target)
}

// Fingerprint is the hex-encoded SHA256 of raw — the one function both the
// baseline a workspace stores and every later inspection call through.
// Content fingerprints, not modification times, are what §9.5's conflict
// rule compares.
func Fingerprint(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// ConfigConflict is §9.5's four-way outcome of comparing a stored baseline
// against the local and remote configs' current fingerprints.
type ConfigConflict string

const (
	// ConflictNone means neither side has changed since the baseline, or
	// only the side the policy already permits to change has.
	ConflictNone ConfigConflict = "none"
	// ConflictRemoteChanged means the remote file changed and the local
	// one did not — per §9.5, this must never be silently overwritten.
	ConflictRemoteChanged ConfigConflict = "remote_changed"
	// ConflictLocalChanged means the local file changed and the remote one
	// did not — safe to apply per the saved sync policy.
	ConflictLocalChanged ConfigConflict = "local_changed"
	// ConflictBoth means both sides changed since the baseline — a real
	// conflict needing a user decision or an explicit resolution policy.
	ConflictBoth ConfigConflict = "both_changed"
)

// DetectConflict compares the two current fingerprints against the
// fingerprint recorded the last time a sync succeeded. An empty
// baselineFingerprint (no prior sync) is treated as "cannot accurately
// compare," which per §9.5 resolves to ConflictBoth rather than a silent
// overwrite — "when an accurate comparison is not possible, treat it as a
// conflict; never default to overwriting."
func DetectConflict(baselineFingerprint, localFingerprint, remoteFingerprint string) ConfigConflict {
	if baselineFingerprint == "" {
		return ConflictBoth
	}
	localChanged := localFingerprint != baselineFingerprint
	remoteChanged := remoteFingerprint != baselineFingerprint
	switch {
	case localChanged && remoteChanged:
		return ConflictBoth
	case remoteChanged:
		return ConflictRemoteChanged
	case localChanged:
		return ConflictLocalChanged
	default:
		return ConflictNone
	}
}
