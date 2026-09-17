// Package prompts holds the text the model is given.
//
// This is **content**, not interface text: it is Chinese, and it stays Chinese
// no matter what language the interface speaks. Changing the interface language
// must not change what the model is told.
//
// The files are embedded so a built binary has no runtime dependencies. A copy
// on disk next to the program wins over the embedded one, which keeps the
// prompt tunable in a source checkout without a rebuild — and the bytes are
// identical either way, so it makes no difference to a release build.
package prompts

import (
	_ "embed"
	"os"
	"path/filepath"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
)

// File names, relative to the package root's `prompts/` directory.
const (
	SystemFileName  = "system.zh.md"
	CompactFileName = "compact.zh.md"
)

//go:embed system.zh.md
var embeddedSystem string

//go:embed compact.zh.md
var embeddedCompact string

// System returns the system prompt.
//
// It is read on every call rather than cached at init: the prompt is read once
// per new session, and reading it late means a missing file is reported at the
// moment it matters instead of at import time.
func System() string {
	if text, ok := readOverride(SystemFileName); ok {
		return text
	}
	return embeddedSystem
}

// Compact returns the prompt used to summarise an older stretch of history.
func Compact() string {
	if text, ok := readOverride(CompactFileName); ok {
		return text
	}
	return embeddedCompact
}

func readOverride(name string) (string, bool) {
	path := filepath.Join(paths.PackageDir(), paths.PromptsDirName, name)
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	if text := string(raw); text != "" {
		return text, true
	}
	return "", false
}

// SystemPath returns where the system prompt is expected on disk. It is used to
// explain a missing file, which is not an optional condition: the agent sends
// this text to the model on every turn.
func SystemPath() string {
	return filepath.Join(paths.PackageDir(), paths.PromptsDirName, SystemFileName)
}
