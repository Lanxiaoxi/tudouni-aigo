package bootstrap

import (
	"path"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/release"
)

// RemoteLayout names every path one versioned install occupies under the
// remote account's home — §8.3 of the design, adapted from the directory
// sketch it gives:
//
//	~/.tudouni/
//	├── runtime/
//	│   ├── <version>/
//	│   │   ├── <runtime-binary>
//	│   │   ├── prompts/
//	│   │   └── tools/vendor/rg/<triple>/rg[.exe]
//	│   └── current -> <version>          (a symlink, the atomic switch point)
//	└── backups/
//	    └── <previous-version>/            (kept on a successful upgrade, see §8.4)
//
// Every path is forward-slash, POSIX-style, because every remote host this
// phase targets is Linux (release.Targets' only non-Windows entry) and the
// paths are built into shell commands the SSH session runs — see
// `PrepareStagingCommand` and `VerifyAndSwitchCommand` in commands.go —
// where a backslash would not be a separator at all.
//
// `homeDir` is the remote account's home directory as the far end reports
// it (`$HOME`, read once at connect time), never assumed to be a fixed
// string: a service account's home is routinely something other than
// `/home/<user>`.
type RemoteLayout struct {
	homeDir string
	version string
	target  release.Target
}

// NewRemoteLayout builds the layout for one version's install under homeDir.
// homeDir must already be the remote account's resolved home directory —
// this type does no resolution of its own, so a caller that passes `~`
// literally would get a layout rooted at a literal directory named `~`.
func NewRemoteLayout(homeDir, version string, target release.Target) RemoteLayout {
	return RemoteLayout{homeDir: strings.TrimRight(homeDir, "/"), version: version, target: target}
}

// Root is `~/.tudouni`.
func (l RemoteLayout) Root() string { return path.Join(l.homeDir, ".tudouni") }

// RuntimeRoot is `~/.tudouni/runtime`, the directory every version lives
// under.
func (l RemoteLayout) RuntimeRoot() string { return path.Join(l.Root(), "runtime") }

// VersionDir is `~/.tudouni/runtime/<version>` — this install's own
// directory, written in full before anything is switched to point at it.
func (l RemoteLayout) VersionDir() string { return path.Join(l.RuntimeRoot(), l.version) }

// StagingDir is where the uploaded archive is extracted **before** it
// becomes VersionDir, named so a staging directory left behind by an
// interrupted upload can never be mistaken for a verified version — see
// §8.4's "write to a temporary directory or new version directory... switch
// only after verification succeeds."
func (l RemoteLayout) StagingDir() string {
	return path.Join(l.RuntimeRoot(), ".staging-"+l.version)
}

// BinaryPath is where the runtime executable lives inside VersionDir.
func (l RemoteLayout) BinaryPath() string {
	return path.Join(l.VersionDir(), l.target.BinaryName())
}

// StagingBinaryPath is BinaryPath's equivalent inside StagingDir, used while
// verifying before the switch.
func (l RemoteLayout) StagingBinaryPath() string {
	return path.Join(l.StagingDir(), l.target.BinaryName())
}

// StagingPromptsDir is PromptsDir's equivalent inside StagingDir, used while
// verifying before the switch.
func (l RemoteLayout) StagingPromptsDir() string { return path.Join(l.StagingDir(), "prompts") }

// StagingRgPath is RgPath's equivalent inside StagingDir, used while
// verifying before the switch.
func (l RemoteLayout) StagingRgPath() string {
	return path.Join(l.StagingDir(), "tools", "vendor", "rg", l.target.Triple, l.target.RgName())
}

// PromptsDir is the prompts directory inside VersionDir — required for
// `paths.PackageDir` to recognise the install as a package root at all (see
// release.Layout.RequiredFiles' own comment on the Go side, which this
// mirrors for the remote tree).
func (l RemoteLayout) PromptsDir() string { return path.Join(l.VersionDir(), "prompts") }

// RgPath is the vendored ripgrep binary's path inside VersionDir, under the
// same `tools/vendor/rg/<triple>/` layout the local release archive uses —
// kept identical so the same checksum manifest format works for both a
// local install and a remote one.
func (l RemoteLayout) RgPath() string {
	return path.Join(l.VersionDir(), "tools", "vendor", "rg", l.target.Triple, l.target.RgName())
}

// CurrentLink is `~/.tudouni/runtime/current` — the one path every
// connection's launch command actually names (see §4.1's "start the actual
// Runtime binary via an absolute path"). It is a symlink to VersionDir,
// repointed only after StagingDir has been verified and renamed into place,
// which is what makes the switch atomic: `ln -sfn` replaces the symlink
// target in one syscall, so a session reading through CurrentLink never
// observes a half-written version.
func (l RemoteLayout) CurrentLink() string { return path.Join(l.RuntimeRoot(), "current") }

// CurrentBinaryPath is the absolute path a RemoteBackend should actually
// launch — through CurrentLink, not through VersionDir directly, so an
// upgrade that repoints the link takes effect for the next connection without
// this layout needing to be recomputed.
func (l RemoteLayout) CurrentBinaryPath() string {
	return path.Join(l.CurrentLink(), l.target.BinaryName())
}

// VersionDirFor is VersionDir's equivalent for an arbitrary version string,
// not necessarily this layout's own l.version — used by the backup/rollback
// commands, which need to name the version being replaced rather than the
// one being installed.
func (l RemoteLayout) VersionDirFor(version string) string {
	return path.Join(l.RuntimeRoot(), version)
}

// BackupDir is where the previously-current version is kept after a
// successful upgrade — §8.4's "keep the old version on an upgrade failure,
// and allow restoring to the last verified version." It is named by the
// version being backed up, not by a timestamp, so RollbackCommand can name
// it back exactly.
func (l RemoteLayout) BackupDir(previousVersion string) string {
	return path.Join(l.Root(), "backups", previousVersion)
}

// RequiredRemoteFiles lists what must exist in VersionDir (or, during
// verification, in StagingDir with VersionDir substituted) for an install to
// be considered complete — the remote equivalent of
// release.Layout.RequiredFiles, trimmed to what §8.2 actually requires the
// Runtime to run: the binary, prompts/ (for package-root detection) and the
// vendored ripgrep. config.example.json is deliberately not required here:
// it is a template for a person setting up local configuration, not
// something a running Runtime reads, and the remote account's own
// `~/.tudouni/config.json` is an entirely separate concern (configuration
// sync, §9 — a later phase).
func (l RemoteLayout) RequiredRemoteFiles() map[string]string {
	return map[string]string{
		"the executable":        l.BinaryPath(),
		"the prompts directory": l.PromptsDir(),
		"the vendored ripgrep":  l.RgPath(),
	}
}
