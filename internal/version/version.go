// Package version reports which build this is.
//
// The version is **compiled into the binary** by the build, through
//
//	go build -ldflags "-X github.com/Lanxiaoxi/tudouni-aigo/internal/version.Version=0.1.0"
//
// It used to be read from a `_version.txt` file sitting next to the executable,
// and that was wrong in a way worth recording: a file on disk can be newer than
// the binary it is supposed to describe. Replacing the executable silently failed
// once (the copy reported success and did not happen), the old binary printed the
// new version anyway, and the answer to "did I install the new build?" — the one
// question this package exists for — was a confident lie. A string inside the
// binary cannot disagree with the binary.
//
// A plain `go build` with no flags reports "dev", which is honest: that binary
// did not come from the build, so it has no version.
package version

// Version is set by the build through -ldflags -X. Nothing assigns to it at run
// time; the variable exists so the linker has somewhere to write.
var Version = "dev"

// Current returns the version string of this build.
func Current() string {
	if Version == "" {
		return "dev"
	}
	return Version
}

// Describe returns the one-line identification used by --version.
func Describe() string {
	return "tudouni " + Current()
}
