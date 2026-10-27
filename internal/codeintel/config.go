package codeintel

// The workspace's own settings for the code index.
//
// A file rather than a field on the session, for the reason the index itself is
// per-workspace: the answer to "does this workspace want code intelligence" has to
// outlive the conversation that happened to ask, and the next session — or another
// front end — has to see the same answer.
//
// **`Enabled` is not the same fact as "an index exists".** They are two questions
// with two different owners: `Enabled` is the person's permission and lives here,
// while "an index exists" is the filesystem's answer and lives in the index
// directory. A build that folded them together could not express either of the two
// states a user actually reaches — "I built one and then turned it off" and "I
// turned it on and there is nothing to search yet" — and would have to guess which
// one was meant.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
)

// ConfigVersion is the shape of config.json this build writes.
const ConfigVersion = 1

// Config is the workspace's code-intelligence settings.
type Config struct {
	Version int `json:"version"`
	// Enabled is the person's permission for the model to use the code index.
	//
	// It defaults to **false**, so the capability is something somebody turns on
	// rather than something they discover by being charged for it: a workspace with
	// a 50MB index and a tool in every request is a cost nobody asked for, and the
	// switch is one click.
	Enabled bool `json:"enabled"`
	// Repos is the person's selection of which repositories the index covers, as
	// workspace-relative paths ("" is the whole workspace, "a/b" a sub-repo).
	//
	// Empty means **nothing has been chosen yet** — a distinct state from "the
	// person chose nothing", which this file cannot express and does not need to:
	// the panel re-offers the checklist whenever an empty selection is read back.
	// The selection is locked once made: changing it clears the index first, so a
	// saved choice never describes a database it does not match.
	Repos []string `json:"repos,omitempty"`
}

// DefaultConfig is what a workspace that has never been configured gets.
func DefaultConfig() Config {
	return Config{Version: ConfigVersion, Enabled: false}
}

// ConfigPath is `<workspace>/.tudouni/codeintel/config.json`.
//
// Beside the memory settings rather than inside them: they are two independent
// features, and one file with two features' keys is how a rewrite of one drops the
// other's field.
func ConfigPath(root string) string {
	return filepath.Join(root, paths.RuntimeDirName, "codeintel", "config.json")
}

// LoadConfig reads config.json, returning the defaults when it is absent.
//
// **An unreadable or unparsable file is the defaults, not an error.** This is read
// on the path that builds the tool registry, and a session that refused to start
// because a settings file was truncated would be a worse outcome than a session that
// started with code intelligence off — which is the state the person is shown and
// can fix in one click.
func LoadConfig(root string) Config {
	config := DefaultConfig()
	raw, err := os.ReadFile(ConfigPath(root))
	if err != nil {
		return config
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		return DefaultConfig()
	}
	// A file written by a future build is still read for the fields this one knows:
	// the version is recorded rather than enforced, because a refusal here would
	// make a downgrade break a workspace for a reason nobody can see.
	if config.Version == 0 {
		config.Version = ConfigVersion
	}
	return config
}

// Enabled reports whether this workspace has code intelligence turned on.
func Enabled(root string) bool {
	return LoadConfig(root).Enabled
}

// SaveConfig writes the settings atomically.
//
// Temp file then rename, for the reason every other settings writer in this
// program does it: a half-written config.json is indistinguishable from a
// deliberately empty one, and it is read at start-up, so the failure would appear
// as "code intelligence turned itself off" rather than as a write error.
func SaveConfig(root string, config Config) error {
	if config.Version == 0 {
		config.Version = ConfigVersion
	}
	path := ConfigPath(root)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("codeintel: create %s: %w", filepath.Dir(path), err)
	}
	raw, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')

	temp, err := os.CreateTemp(filepath.Dir(path), "config-*.json")
	if err != nil {
		return fmt.Errorf("codeintel: create temp config: %w", err)
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if _, err := temp.Write(raw); err != nil {
		temp.Close()
		return fmt.Errorf("codeintel: write %s: %w", tempName, err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("codeintel: close %s: %w", tempName, err)
	}
	if err := os.Rename(tempName, path); err != nil {
		return fmt.Errorf("codeintel: replace %s: %w", path, err)
	}
	return nil
}

// SetEnabled writes the one switch and returns the config it saved.
func SetEnabled(root string, enabled bool) (Config, error) {
	config := LoadConfig(root)
	config.Enabled = enabled
	if err := SaveConfig(root, config); err != nil {
		return config, err
	}
	return config, nil
}

// SetRepos writes the repository selection and returns the config it saved.
//
// Callers are responsible for the lock: a selection that differs from a
// saved one invalidates the index it describes, and the panel is the side
// that knows whether the index has been cleared first. This function only
// writes what it is told.
func SetRepos(root string, repos []string) (Config, error) {
	config := LoadConfig(root)
	config.Repos = repos
	if err := SaveConfig(root, config); err != nil {
		return config, err
	}
	return config, nil
}
