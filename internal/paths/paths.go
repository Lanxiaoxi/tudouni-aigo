// Package paths answers one question: where does everything live?
//
// Two roots matter, and they are deliberately different:
//
//   - the **package root**: where the program was installed. Prompts, the
//     protocol schema and the vendored ripgrep live under it. It follows the
//     installation, not the person.
//   - the **home dir**: `~/.tudouni`. The config file and mcp.json live there.
//     It follows the person — moving to another directory to do work should not
//     change your keys.
//
// The **workspace** is the current working directory. It is the one thing the
// agent's file tools are allowed to touch, so it gets its own set of derived
// paths under `<workspace>/.tudouni`.
package paths

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	// RuntimeDirName is the per-workspace state directory.
	RuntimeDirName = ".tudouni"
	// ArtifactsDirName sits inside a session's artifact directory.
	ArtifactsDirName = "artifacts"
	// EnvHome overrides the package root. Used by tests and by an install
	// that keeps its resources somewhere other than next to the binary.
	EnvHome = "TUDOUNI_HOME"
)

// PackageDir returns the directory the program's resources are read from.
//
// Resolution order:
//  1. $TUDOUNI_HOME, when set and usable;
//  2. the directory holding the running executable, and its parent (so a
//     `go build ./cmd/tudouni` layout with the resources at the repo root
//     resolves too);
//  3. the current working directory.
//
// A candidate only counts if it actually looks like a package root — that is,
// it has a `prompts` directory. Guessing wrong here produces the worst kind of
// failure: the program starts and one feature is quietly missing.
func PackageDir() string {
	if fromEnv := strings.TrimSpace(os.Getenv(EnvHome)); fromEnv != "" {
		if abs, err := filepath.Abs(fromEnv); err == nil {
			return abs
		}
		return fromEnv
	}

	var candidates []string
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		dir := filepath.Dir(exe)
		candidates = append(candidates, dir, filepath.Dir(dir))
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, cwd)
	}

	for _, c := range candidates {
		if looksLikePackageDir(c) {
			return c
		}
	}
	if len(candidates) > 0 {
		return candidates[0]
	}
	dir, _ := os.Getwd()
	return dir
}

func looksLikePackageDir(dir string) bool {
	info, err := os.Stat(filepath.Join(dir, PromptsDirName))
	return err == nil && info.IsDir()
}

// PromptsDirName is where the system and compaction prompts live.
const PromptsDirName = "prompts"

// UserConfigDir returns ~/.tudouni. The config file and mcp.json live here.
func UserConfigDir() string {
	return filepath.Join(HomeDir(), RuntimeDirName)
}

// HomeDir is the user's home directory.
//
// It is separate from UserConfigDir because not everything that follows the person
// lives inside this program's own directory: the shared skill locations are
// `~/.skills` and `~/.agents/skills`, which belong to other tools as much as to
// this one.
func HomeDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "."
	}
	return home
}

// WorkspaceDir returns the current working directory.
//
// The workspace is the current directory, deliberately: that is what the user
// typed `tudouni-aigo` in, and it is the one thing the file tools may touch.
func WorkspaceDir() string {
	cwd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return cwd
}

// WorkspaceRuntimeDir returns <workspace>/.tudouni.
//
// It is a function, not a constant: permissions.json lives here, and the
// workspace changes with the working directory.
func WorkspaceRuntimeDir() string {
	return filepath.Join(WorkspaceDir(), RuntimeDirName)
}

// WorkspaceArtifactsDir returns <workspace>/.tudouni/artifacts.
func WorkspaceArtifactsDir() string {
	return filepath.Join(WorkspaceRuntimeDir(), ArtifactsDirName)
}

// SessionArtifactsDir returns the artifact directory for one session.
//
// It only joins names; it does not validate the id. Validation belongs to the
// session store, which is the one place that knows what an id may look like.
func SessionArtifactsDir(sessionID string) string {
	return filepath.Join(WorkspaceArtifactsDir(), sessionID)
}

// VendorRG returns the directory holding the ripgrep builds.
func VendorRG() string {
	return filepath.Join(PackageDir(), "tools", "vendor", "rg")
}

// SchemaDir returns the directory holding the protocol schema files.
func SchemaDir() string {
	return filepath.Join(PackageDir(), "protocol", "schema")
}

// ExampleConfigPath returns the repository's config.example.json.
func ExampleConfigPath() string {
	return filepath.Join(PackageDir(), "config.example.json")
}

// UnsafeWorkspaceKind explains why a directory must not be used as a workspace.
type UnsafeWorkspaceKind string

const (
	// WorkspaceOK means the directory is a usable workspace.
	WorkspaceOK UnsafeWorkspaceKind = ""
	// WorkspaceIsHome means it is the user's home directory.
	WorkspaceIsHome UnsafeWorkspaceKind = "home"
	// WorkspaceIsRoot means it is the root of the filesystem.
	WorkspaceIsRoot UnsafeWorkspaceKind = "root"
	// WorkspaceAboveHome means it is an ancestor of the home directory.
	WorkspaceAboveHome UnsafeWorkspaceKind = "above-home"
)

// UnsafeWorkspace reports why the given directory must not be a workspace.
//
// The check exists because read_file needs no approval: starting in the home
// directory hands over .ssh, other projects' .env files and browser data
// without the user ever being asked twice. So the three cases that make the
// workspace strictly larger than "one project" are refused up front.
func UnsafeWorkspace(dir string) UnsafeWorkspaceKind {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return WorkspaceOK
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err == nil {
		abs = resolved
	}

	volumeRoot := filepath.VolumeName(abs) + string(filepath.Separator)
	if samePath(abs, volumeRoot) {
		return WorkspaceIsRoot
	}

	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return WorkspaceOK
	}
	homeAbs, err := filepath.Abs(home)
	if err != nil {
		return WorkspaceOK
	}
	if resolvedHome, err := filepath.EvalSymlinks(homeAbs); err == nil {
		homeAbs = resolvedHome
	}

	if samePath(abs, homeAbs) {
		return WorkspaceIsHome
	}
	if isAncestor(abs, homeAbs) {
		return WorkspaceAboveHome
	}
	return WorkspaceOK
}

func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

// isAncestor reports whether ancestor is a strict ancestor of child.
func isAncestor(ancestor, child string) bool {
	rel, err := filepath.Rel(ancestor, child)
	if err != nil {
		return false
	}
	if rel == "." || filepath.IsAbs(rel) {
		return false
	}
	return !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != ".."
}
