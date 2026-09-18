package config

import (
	_ "embed"
	"os"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
)

// The template is committed **twice**: at the repository root, where a person looks
// for it, and here, where `go:embed` can reach it. `go:embed` may not cross the
// module root and may not use `..`, so a copy is the only option — and a copy that
// can drift is exactly the kind of thing this project refuses to leave unwatched, so
// `example_test.go` asserts the two are byte-identical.
//
//go:embed config.example.json
var embeddedExample []byte

// ExampleBytes is the template's contents, whatever is on disk.
//
// The bytes are **embedded**, and that is not an optimisation: the release archive
// carries only what has to be an executable on disk (`prompts/` and the vendored
// ripgrep), so on an installed copy there is no `config.example.json` next to the
// program. Reading it from disk would make the one message a user with no key ever
// sees — "here is a template, go fill it in" — name a path that does not exist, in
// the exact situation it was written for.
//
// A file next to the program still wins when there is one: the template is the first
// thing somebody edits to try the program out, and a source checkout should not
// require a rebuild to change a comment in it.
func ExampleBytes() []byte {
	if raw, err := os.ReadFile(paths.ExampleConfigPath()); err == nil && len(raw) > 0 {
		return raw
	}
	return embeddedExample
}

// ExampleFile returns where the template is, for a message that has to name a path.
//
// It answers with a path that **exists** whenever one does. When the on-disk copy is
// absent — an installed release — it names the default configuration location
// instead: pointing somebody at a file that is not there is worse than pointing at
// the one they are about to create.
func ExampleFile() string {
	if _, err := os.Stat(paths.ExampleConfigPath()); err == nil {
		return paths.ExampleConfigPath()
	}
	return paths.UserConfigDir() + string(os.PathSeparator) + ConfigFileName
}
