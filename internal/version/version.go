// Package version reports which build this is.
//
// The version string comes from a stamp file that the build writes next to the
// resources. The stamp exists because the built artifact does not carry a build
// manifest, and "did I actually install the new build?" is a question the user
// has to be able to answer.
package version

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
)

// StampFileName is the file the build writes the version into.
const StampFileName = "_version.txt"

// Unknown is what we say when no stamp was found.
const Unknown = "unknown"

// Fallback is compiled in so a plain `go build` still reports something usable.
var Fallback = "dev"

// Current returns the version string of this build.
func Current() string {
	if v := readStamp(); v != "" {
		return v
	}
	if Fallback != "" {
		return Fallback
	}
	return Unknown
}

func readStamp() string {
	candidates := []string{
		filepath.Join(paths.PackageDir(), StampFileName),
	}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), StampFileName))
	}
	for _, path := range candidates {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if text := strings.TrimSpace(string(raw)); text != "" {
			return text
		}
	}
	return ""
}

// Describe returns the one-line identification used by --version.
func Describe() string {
	return "tudouni " + Current()
}
