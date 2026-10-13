package bootstrap

import (
	"fmt"
	"path"
	"strings"
)

// quoteShellArgument mirrors ssh.QuoteShellArgument / the Rust side's
// quote_shell_argument exactly — single-quoting, with an embedded quote
// closed, escaped and reopened. Repeated here rather than imported from
// internal/ssh because that package is about the SSH *transport* (dialling,
// sessions, the agent's interactive shell tool) and has no reason to depend
// on, or be depended on by, the install sequencing in this package. Three
// implementations of one four-line algorithm (Go here, Go in internal/ssh,
// Rust in ssh_backend.rs) is a smaller risk than a dependency that only
// exists to share it; what actually matters — that all three agree on the
// escaping rule — is pinned by TestQuoteShellArgumentMatchesTheSshPackages
// below.
func quoteShellArgument(argument string) string {
	var out strings.Builder
	out.WriteByte('\'')
	for i := 0; i < len(argument); i++ {
		if argument[i] == '\'' {
			out.WriteString(`'\''`)
			continue
		}
		out.WriteByte(argument[i])
	}
	out.WriteByte('\'')
	return out.String()
}

// q is quoteShellArgument, named for density in the command builders below,
// where every path and version string passing through a shell command is
// quoted — per §4.1's "command arguments and remote paths must be safely
// escaped" — and the full name would make each line wrap.
func q(s string) string { return quoteShellArgument(s) }

// PrepareStagingCommand returns the shell command that makes StagingDir
// ready for an upload: removed if a previous attempt left one behind, then
// recreated empty. Run before any file is uploaded into it.
//
// `rm -rf` on a path this package itself computed (never on anything a
// caller supplies) is safe here for the same reason it is safe in
// `packaging/install.sh`: the target is a `.staging-<version>` directory
// this program minted, not a path named by outside input.
func (l RemoteLayout) PrepareStagingCommand() string {
	return fmt.Sprintf("rm -rf %s && mkdir -p %s", q(l.StagingDir()), q(l.StagingDir()))
}

// VerifyAndSwitchCommand is the one shell command that does everything §8.4
// requires to happen **atomically relative to CurrentLink**: set the
// executable bit on the binary and the vendored ripgrep (zip, like the
// local release archive, carries no POSIX permission bits — see
// release.Layout.Zip's own comment on exactly this), confirm the three
// required files exist, move StagingDir into place as VersionDir, and only
// then repoint CurrentLink.
//
// It is one command (`&&`-chained) rather than several round trips so that
// a connection dropping partway through fails before the switch rather than
// at some arbitrary point after it: `set -e`-equivalent chaining via `&&`
// means the first failing step stops the line, and CurrentLink is the very
// last thing touched. If backupVersion is non-empty, the version CurrentLink
// is about to stop pointing at is preserved under BackupDir first — see
// §8.4's "keep the old version... and allow restoring to it."
//
// mv rather than cp for StagingDir -> VersionDir: a rename inside one
// filesystem is a single directory-entry update, not a byte-for-byte copy,
// which is both faster for an 18 MB binary and avoids a window where
// VersionDir exists partially written.
func (l RemoteLayout) VerifyAndSwitchCommand(backupVersion string) string {
	steps := []string{
		fmt.Sprintf("chmod +x %s", q(l.StagingBinaryPath())),
		fmt.Sprintf("chmod +x %s 2>/dev/null || true", q(l.StagingRgPath())),
		fmt.Sprintf("test -f %s", q(l.StagingBinaryPath())),
		fmt.Sprintf("test -d %s", q(l.StagingPromptsDir())),
		fmt.Sprintf("test -f %s", q(l.StagingRgPath())),
		fmt.Sprintf("rm -rf %s", q(l.VersionDir())),
	}
	if backupVersion != "" {
		previousDir := l.VersionDirFor(backupVersion)
		steps = append(steps,
			fmt.Sprintf("mkdir -p %s", q(path.Dir(l.BackupDir(backupVersion)))),
			fmt.Sprintf("rm -rf %s", q(l.BackupDir(backupVersion))),
			// CurrentLink itself is a symlink, not the version directory, so
			// moving "the version CurrentLink points at" means resolving the
			// version from the layout the caller already knows (backupVersion)
			// rather than reading the link — the directory to back up is simply
			// another VersionDir-shaped path for the old version.
			fmt.Sprintf("test -d %s && mv %s %s || true",
				q(previousDir), q(previousDir), q(l.BackupDir(backupVersion))),
		)
	}
	steps = append(steps,
		fmt.Sprintf("mv %s %s", q(l.StagingDir()), q(l.VersionDir())),
		fmt.Sprintf("mkdir -p %s", q(l.RuntimeRoot())),
		fmt.Sprintf("ln -sfn %s %s", q(l.VersionDir()), q(l.CurrentLink())),
	)
	return strings.Join(steps, " && ")
}

// RollbackCommand restores CurrentLink to point at a previously-backed-up
// version, for §8.4's "allow restoring to the last verified version." It
// does not delete the version that failed verification — a failed upload
// left in VersionDir or StagingDir is diagnostic evidence, and §8.4 requires
// the failure to be reported with the information needed to act on it, not
// cleaned up silently before anyone can look at it.
func (l RemoteLayout) RollbackCommand(restoreVersion string) string {
	restoreDir := l.BackupDir(restoreVersion)
	return fmt.Sprintf("test -d %s && ln -sfn %s %s", q(restoreDir), q(restoreDir), q(l.CurrentLink()))
}

// CleanupStagingCommand removes a staging directory a failed verification
// left behind, for a caller that has already reported the failure and
// decided not to keep it around (contrast with RollbackCommand's "do not
// delete the evidence" above: this is the explicit, later clean-up step, not
// something VerifyAndSwitchCommand ever does on its own failure path).
func (l RemoteLayout) CleanupStagingCommand() string {
	return fmt.Sprintf("rm -rf %s", q(l.StagingDir()))
}
