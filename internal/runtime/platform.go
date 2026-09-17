package runtime

import (
	"runtime"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
)

// isWindows decides how command rules are compared: the command name is
// case-insensitive there, because executables are.
func isWindows() bool { return runtime.GOOS == "windows" }

func workspaceRuntimeDir() string { return paths.WorkspaceRuntimeDir() }
