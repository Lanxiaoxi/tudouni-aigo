//! The Remote Bootstrapper's transport half (§3.5, §8 of the design):
//! detecting the remote platform, uploading the matching release archive
//! over SFTP, and running the verify-and-switch sequence that
//! `internal/bootstrap` (Go) computes.
//!
//! # Division of labour with `internal/bootstrap`
//!
//! Every *decision* — which platform a `uname` answer maps to, what the
//! install's directory layout is, what shell command does the atomic
//! switch — is specified once, in Go, with tests that run without a
//! network (`internal/bootstrap/detect.go`, `layout.go`, `commands.go`).
//! This module does not re-derive any of those rules; it mirrors them in
//! Rust so they can run inside the Tauri process, the same relationship
//! `ssh_backend::connect` already has with `ssh.DialRuntimeSession` and
//! `quote_shell_argument` has with `ssh.QuoteShellArgument`. Keeping the
//! mirrored logic small and the test coverage on the Go side is what makes
//! "do the two sides agree" a question with one obvious owner.
//!
//! # Why SFTP rather than piping through a shell command
//!
//! The archive is tens of megabytes of binary data. `cat > file` through an
//! exec channel would work but has no flow control signal distinguishable
//! from "the remote disk is full" versus "the network is slow", and no way
//! to resume. SFTP is a real file-transfer subsystem — `ssh2::Sftp` opens a
//! second channel multiplexed over the same connection, writes in whatever
//! chunks are given to it, and reports I/O errors as I/O errors.

use crate::ssh_backend::{dial_session, SshTarget};
use ssh2::Session;
use std::io::{Read, Write};
use std::path::Path;

/// The remote platform, as this module can detect it — the Rust mirror of
/// `release.Target` plus enough of `internal/bootstrap.DetectTarget`'s
/// decision to pick the right bundled archive. Only the two fields actually
/// needed here are kept; everything else about a Target (RgName,
/// BinaryName) is recomputed from these two exactly the way the Go side
/// does, in `archive_file_name`/`binary_file_name` below.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoteTarget {
    pub goos: Goos,
    pub triple: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Goos {
    Linux,
    Windows,
}

impl RemoteTarget {
    pub fn binary_name(&self) -> &'static str {
        match self.goos {
            Goos::Windows => "tudouni-aigo.exe",
            Goos::Linux => "tudouni-aigo",
        }
    }

    pub fn rg_name(&self) -> &'static str {
        match self.goos {
            Goos::Windows => "rg.exe",
            Goos::Linux => "rg",
        }
    }
}

const LINUX_AMD64: RemoteTarget = RemoteTarget { goos: Goos::Linux, triple: "x86_64-unknown-linux-musl" };
const WINDOWS_AMD64: RemoteTarget = RemoteTarget { goos: Goos::Windows, triple: "x86_64-pc-windows-msvc" };

/// Detects the remote platform by running `uname -s` and `uname -m` as two
/// separate, non-interactive exec requests over `session`.
///
/// Mirrors `bootstrap.DetectTarget` exactly: only the two architectures and
/// the one operating system this project ships a build for are accepted,
/// and anything else — a recognisable but unshipped platform (`aarch64`,
/// `Darwin`), or a command that failed outright, meaning this is probably a
/// Windows host whose non-interactive shell has no `uname` at all — is
/// refused by name rather than guessed at. §8.1: "must not assume full
/// compatibility based solely on uname -m."
///
/// A `uname` failure (non-zero exit, or the command not found) is treated as
/// "possibly Windows" rather than an immediate refusal, since that is
/// exactly what a Windows OpenSSH server with no POSIX layer looks like from
/// here — there is no portable way to ask "are you Windows" other than
/// noticing that the POSIX probe did not work.
pub fn detect_remote_target(session: &Session) -> Result<RemoteTarget, String> {
    let uname_s = exec_capture(session, "uname -s").ok();
    let uname_m = exec_capture(session, "uname -m").ok();

    if let (Some(os), Some(arch)) = (uname_s.as_deref(), uname_m.as_deref()) {
        let os = os.trim();
        let arch = arch.trim();
        if os == "Linux" && (arch == "x86_64" || arch == "amd64") {
            return Ok(LINUX_AMD64);
        }
        if !os.is_empty() {
            return Err(format!(
                "the remote host reports a platform this program does not ship a Runtime build for \
                 (uname -s={os:?}, uname -m={arch:?}); supported platforms are: linux/amd64, windows/amd64"
            ));
        }
    }

    // uname produced nothing usable — try the one check that works without
    // POSIX tools: `cmd.exe` understands `ver`, `sh`/`bash` do not.
    if let Ok(ver) = exec_capture(session, "ver") {
        if ver.to_lowercase().contains("windows") {
            return Ok(WINDOWS_AMD64);
        }
    }

    Err(
        "could not identify the remote platform: neither `uname` nor `ver` produced a recognisable answer; \
         supported platforms are: linux/amd64, windows/amd64"
            .to_string(),
    )
}

/// Reads `$HOME` on the remote host, for `internal/bootstrap.RemoteLayout`'s
/// own requirement that the install root is the account's *actual* home —
/// "never assumed to be a fixed string."
pub fn remote_home_dir(session: &Session) -> Result<String, String> {
    let home = exec_capture(session, "printf '%s' \"$HOME\"")
        .map_err(|e| format!("could not read the remote account's home directory: {e}"))?;
    let home = home.trim().to_string();
    if home.is_empty() {
        return Err("the remote account's $HOME is empty".to_string());
    }
    Ok(home)
}

/// The absolute path to the installed runtime for an account, given its home
/// and the platform that was detected for it.
///
/// Exposed so the connection probe (`remote_probe.rs`) cannot disagree with
/// the installer about where an install lands: both go through
/// `RemoteLayout`, so the "is the Runtime already installed?" question is
/// answered by reading the same `CurrentLink` this module writes.
/// `install_or_upgrade` returns exactly this string on success.
pub fn current_binary_for(home_dir: &str, target: RemoteTarget) -> String {
    let layout = RemoteLayout::new(home_dir, "", target);
    format!("{}/{}", layout.current_link(), target.binary_name())
}

/// Which version `CurrentLink` points at, or `None` when there is no link, or
/// it points nowhere this call can resolve.
///
/// The version is the **name of the directory the link resolves to**, by
/// construction (`CurrentLink -> .../runtime/<version>`), so `readlink` plus a
/// basename is the whole answer. Public because the connection probe reports
/// the installed version as a fact about the host, and it must read it the same
/// way `install_or_upgrade` decides whether an install is needed.
pub fn installed_version(session: &Session, home_dir: &str) -> Option<String> {
    let layout = RemoteLayout::new(home_dir, "", LINUX_AMD64);
    let command = format!("readlink {}", q(&layout.current_link()));
    exec_capture(session, &command)
        .ok()
        .map(|out| out.trim().to_string())
        .filter(|value| !value.is_empty())
        .and_then(|target| {
            // Trim a trailing slash first: `readlink` may print either form,
            // and `file_name` on ".../1.2.3/" answers only by luck.
            std::path::Path::new(target.trim_end_matches('/'))
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
}

/// Runs one non-interactive command to completion and returns its stdout,
/// refusing a non-zero exit — the shape every detection probe and every
/// verify-and-switch step in this module needs, written once rather than
/// at each call site.
pub fn exec_capture(session: &Session, command: &str) -> Result<String, String> {
    let mut channel = session
        .channel_session()
        .map_err(|e| format!("could not open a channel: {e}"))?;
    channel.exec(command).map_err(|e| format!("could not run `{command}`: {e}"))?;
    let mut output = String::new();
    channel
        .read_to_string(&mut output)
        .map_err(|e| format!("could not read the output of `{command}`: {e}"))?;
    channel.wait_close().map_err(|e| format!("could not close the channel for `{command}`: {e}"))?;
    let code = channel.exit_status().unwrap_or(-1);
    if code != 0 {
        return Err(format!("`{command}` exited with status {code}"));
    }
    Ok(output)
}

/// Runs one non-interactive command, requiring success, discarding its
/// output — the shape `run_shell_sequence` needs for the actual install
/// steps (`PrepareStagingCommand`, `VerifyAndSwitchCommand`, ...), whose
/// output on success is not meaningful but whose stderr matters a great
/// deal on failure.
pub fn run_shell_sequence(session: &Session, command: &str) -> Result<(), String> {
    let mut channel = session
        .channel_session()
        .map_err(|e| format!("could not open a channel: {e}"))?;
    channel.exec(command).map_err(|e| format!("could not run the install command: {e}"))?;
    let mut stdout = String::new();
    let _ = channel.read_to_string(&mut stdout);
    let mut stderr = String::new();
    let _ = channel.stderr().read_to_string(&mut stderr);
    channel.wait_close().map_err(|e| format!("could not close the channel: {e}"))?;
    let code = channel.exit_status().unwrap_or(-1);
    if code != 0 {
        let mut detail = stderr.trim().to_string();
        if detail.is_empty() {
            detail = stdout.trim().to_string();
        }
        if detail.is_empty() {
            return Err(format!("the install command exited with status {code}"));
        }
        return Err(format!("the install command exited with status {code}: {detail}"));
    }
    Ok(())
}

/// Uploads one local file to `remote_path` over SFTP, creating the file
/// (truncating it if it already exists — a staging directory is always
/// freshly prepared before this is called, so there is nothing to merge
/// with). The parent directory must already exist; the caller
/// (`upload_archive_contents`) creates the directory tree itself since SFTP
/// has no "create intermediate directories" option the way `mkdir -p` does.
pub fn upload_file(session: &Session, local_path: &Path, remote_path: &str) -> Result<(), String> {
    let sftp = session.sftp().map_err(|e| format!("could not start an SFTP session: {e}"))?;
    let mut remote_file = sftp
        .create(Path::new(remote_path))
        .map_err(|e| format!("could not create {remote_path} on the remote host: {e}"))?;
    let mut local_file =
        std::fs::File::open(local_path).map_err(|e| format!("could not open {}: {e}", local_path.display()))?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = local_file
            .read(&mut buffer)
            .map_err(|e| format!("could not read {}: {e}", local_path.display()))?;
        if read == 0 {
            break;
        }
        remote_file
            .write_all(&buffer[..read])
            .map_err(|e| format!("could not write to {remote_path} on the remote host: {e}"))?;
    }
    Ok(())
}

/// Creates one directory on the remote host over SFTP, tolerating "already
/// exists" — the SFTP equivalent of `mkdir -p` applied one path segment at a
/// time, since `ssh2::Sftp::mkdir` (like the SFTP protocol itself) only
/// creates one level and refuses if the parent is missing.
pub fn mkdir_remote_recursive(session: &Session, remote_dir: &str) -> Result<(), String> {
    let sftp = session.sftp().map_err(|e| format!("could not start an SFTP session: {e}"))?;
    let mut built = String::new();
    for segment in remote_dir.trim_start_matches('/').split('/') {
        if segment.is_empty() {
            continue;
        }
        built.push('/');
        built.push_str(segment);
        match sftp.mkdir(Path::new(&built), 0o755) {
            Ok(()) => {}
            Err(e) => {
                // "Already exists" is not an error here; anything else is.
                if sftp.stat(Path::new(&built)).is_err() {
                    return Err(format!("could not create {built} on the remote host: {e}"));
                }
            }
        }
    }
    Ok(())
}

/// Builds an [`SshTarget`] from the pieces the front end already has, so
/// `detect_remote_target`/the upload functions can be driven with the same
/// connection `connect` would open — kept here rather than constructed ad
/// hoc at each call site in `lib.rs`, since `dial_session` is this module's
/// one connection entry point for everything that is not starting the
/// runtime itself.
pub fn open_install_session(target: &SshTarget) -> Result<Session, String> {
    dial_session(target)
}

/// The remote layout for one version's install — the Rust mirror of
/// `internal/bootstrap.RemoteLayout`. Every method here produces the exact
/// same path or shell command the Go side's tests already pin, which is
/// what keeps "do the two sides agree" true by inspection rather than by
/// trust: a future change to one has to be made in both, and a reviewer
/// reading either file can check it against the other directly.
pub struct RemoteLayout {
    home_dir: String,
    version: String,
    target: RemoteTarget,
}

impl RemoteLayout {
    pub fn new(home_dir: &str, version: &str, target: RemoteTarget) -> Self {
        Self {
            home_dir: home_dir.trim_end_matches('/').to_string(),
            version: version.to_string(),
            target,
        }
    }

    pub fn root(&self) -> String { format!("{}/.tudouni", self.home_dir) }
    pub fn runtime_root(&self) -> String { format!("{}/runtime", self.root()) }
    pub fn version_dir(&self) -> String { format!("{}/{}", self.runtime_root(), self.version) }
    pub fn staging_dir(&self) -> String { format!("{}/.staging-{}", self.runtime_root(), self.version) }
    pub fn version_dir_for(&self, version: &str) -> String { format!("{}/{}", self.runtime_root(), version) }
    pub fn current_link(&self) -> String { format!("{}/current", self.runtime_root()) }
    pub fn backup_dir(&self, previous_version: &str) -> String {
        format!("{}/backups/{}", self.root(), previous_version)
    }

    pub fn staging_binary_path(&self) -> String {
        format!("{}/{}", self.staging_dir(), self.target.binary_name())
    }
    pub fn staging_prompts_dir(&self) -> String { format!("{}/prompts", self.staging_dir()) }
    pub fn staging_rg_path(&self) -> String {
        format!("{}/tools/vendor/rg/{}/{}", self.staging_dir(), self.target.triple, self.target.rg_name())
    }

    /// Within StagingDir, where one archive entry (named relative to the
    /// archive root, forward-slash, exactly as `zip::ZipArchive` reports it)
    /// should land.
    pub fn staging_path_for_entry(&self, entry_name: &str) -> String {
        format!("{}/{}", self.staging_dir(), entry_name.trim_start_matches('/'))
    }
}

/// Quotes one argument for a POSIX shell command, mirroring
/// `ssh.QuoteShellArgument` / `bootstrap.quoteShellArgument` / the local
/// `quote_shell_argument` the runtime-launch command already uses in
/// `lib.rs` — see any of those for why single-quoting is the one truly inert
/// form and the single character that needs escaping.
fn q(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// The shell command that empties and recreates StagingDir — run before any
/// file is uploaded into it, mirroring
/// `bootstrap.RemoteLayout.PrepareStagingCommand` exactly.
pub fn prepare_staging_command(layout: &RemoteLayout) -> String {
    format!("rm -rf {} && mkdir -p {}", q(&layout.staging_dir()), q(&layout.staging_dir()))
}

/// The shell command that verifies StagingDir is complete and switches
/// CurrentLink to it, mirroring
/// `bootstrap.RemoteLayout.VerifyAndSwitchCommand` exactly — same steps,
/// same order (every verification step before the first step that touches
/// VersionDir or CurrentLink), same optional backup when `backup_version`
/// is non-empty. See that Go function's own doc for why each piece is
/// there; this is kept byte-for-byte equivalent rather than re-derived so
/// the two can be read side by side.
pub fn verify_and_switch_command(layout: &RemoteLayout, backup_version: &str) -> String {
    let mut steps = vec![
        format!("chmod +x {}", q(&layout.staging_binary_path())),
        format!("chmod +x {} 2>/dev/null || true", q(&layout.staging_rg_path())),
        format!("test -f {}", q(&layout.staging_binary_path())),
        format!("test -d {}", q(&layout.staging_prompts_dir())),
        format!("test -f {}", q(&layout.staging_rg_path())),
        format!("rm -rf {}", q(&layout.version_dir())),
    ];
    if !backup_version.is_empty() {
        let previous_dir = layout.version_dir_for(backup_version);
        let backup_dir = layout.backup_dir(backup_version);
        // path.Dir(backup_dir) on the Go side; backup_dir is always
        // "<root>/backups/<version>", so its parent is always "<root>/backups".
        let backup_parent = format!("{}/backups", layout.root());
        steps.push(format!("mkdir -p {}", q(&backup_parent)));
        steps.push(format!("rm -rf {}", q(&backup_dir)));
        steps.push(format!(
            "test -d {} && mv {} {} || true",
            q(&previous_dir), q(&previous_dir), q(&backup_dir)
        ));
    }
    steps.push(format!("mv {} {}", q(&layout.staging_dir()), q(&layout.version_dir())));
    steps.push(format!("mkdir -p {}", q(&layout.runtime_root())));
    steps.push(format!("ln -sfn {} {}", q(&layout.version_dir()), q(&layout.current_link())));
    steps.join(" && ")
}

/// Mirrors `bootstrap.RemoteLayout.RollbackCommand`.
pub fn rollback_command(layout: &RemoteLayout, restore_version: &str) -> String {
    let restore_dir = layout.backup_dir(restore_version);
    format!("test -d {} && ln -sfn {} {}", q(&restore_dir), q(&restore_dir), q(&layout.current_link()))
}

/// Mirrors `bootstrap.RemoteLayout.CleanupStagingCommand`.
pub fn cleanup_staging_command(layout: &RemoteLayout) -> String {
    format!("rm -rf {}", q(&layout.staging_dir()))
}

/// Reads one local release archive and uploads every regular-file entry
/// into `layout`'s StagingDir over SFTP, creating directories as needed.
///
/// This is the SFTP equivalent of `unzip` run on the remote host — chosen
/// over actually running `unzip` remotely because that would assume the
/// remote account has it installed, which is exactly the kind of
/// dependency on the remote environment §8.2 rules out ("the remote server
/// does not need to access GitHub or any other external download source",
/// and by the same reasoning, does not need any tool this program itself
/// does not bring). Reading the archive here and writing each entry's bytes
/// through SFTP needs nothing on the far end but an SSH server.
///
/// Permission bits are **not** set here — a zip entry's Unix mode is
/// metadata this function could read (`ZipFile::unix_mode`), but applying
/// it over SFTP one file at a time would be one more round trip per file,
/// for a property only two files actually need (the binary and ripgrep,
/// both executables). `verify_and_switch_command` sets exactly those two
/// bits in one remote shell command instead, after every file has already
/// arrived — see that function and `release.Layout.Zip`'s own comment on
/// why a zip archive carries no POSIX permission bits to begin with.
pub fn upload_archive_contents(
    session: &Session,
    archive_path: &Path,
    layout: &RemoteLayout,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<(), String> {
    let file = std::fs::File::open(archive_path)
        .map_err(|e| format!("could not open {}: {e}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("{} is not a readable zip archive: {e}", archive_path.display()))?;

    let total = archive.len();
    let mut created_dirs = std::collections::HashSet::new();

    for index in 0..total {
        let (name, is_dir, mut buffer) = {
            let mut entry = archive
                .by_index(index)
                .map_err(|e| format!("could not read entry {index} of {}: {e}", archive_path.display()))?;
            let name = entry.name().to_string();
            let is_dir = entry.is_dir();
            let mut buffer = Vec::with_capacity(entry.size() as usize);
            if !is_dir {
                entry
                    .read_to_end(&mut buffer)
                    .map_err(|e| format!("could not read {name} from the archive: {e}"))?;
            }
            (name, is_dir, buffer)
        };

        let remote_path = layout.staging_path_for_entry(&name);

        if is_dir {
            mkdir_remote_recursive(session, &remote_path)?;
            on_progress(index + 1, total);
            continue;
        }

        // Every file's parent directory must exist before SFTP can create
        // the file inside it, and a zip archive is not required to list a
        // directory entry before the files inside it — ensure it ourselves,
        // once per distinct parent.
        if let Some(parent) = parent_of(&remote_path) {
            if created_dirs.insert(parent.clone()) {
                mkdir_remote_recursive(session, &parent)?;
            }
        }

        upload_bytes(session, &mut buffer, &remote_path)?;
        on_progress(index + 1, total);
    }

    Ok(())
}

fn parent_of(path: &str) -> Option<String> {
    let index = path.rfind('/')?;
    if index == 0 {
        return Some("/".to_string());
    }
    Some(path[..index].to_string())
}

/// Writes an in-memory buffer to the remote host over SFTP — the archive
/// upload's own primitive, kept distinct from [`upload_file`] (which reads
/// from a local path) because the archive's entries never touch this
/// process's own filesystem: they are decompressed straight from the zip
/// into memory and from there straight to the SFTP write.
fn upload_bytes(session: &Session, bytes: &mut [u8], remote_path: &str) -> Result<(), String> {
    let sftp = session.sftp().map_err(|e| format!("could not start an SFTP session: {e}"))?;
    let mut remote_file = sftp
        .create(Path::new(remote_path))
        .map_err(|e| format!("could not create {remote_path} on the remote host: {e}"))?;
    remote_file
        .write_all(bytes)
        .map_err(|e| format!("could not write to {remote_path} on the remote host: {e}"))
}

/// Reads which version CurrentLink points at, if any — §8.4's "version
/// detection covers both the PATH-installed version and the version at the
/// conventional path." `None` means a fresh install (no CurrentLink, or it
/// points nowhere this call can resolve); `Some(version)` is what becomes
/// `backup_version` for `verify_and_switch_command`, so a successful
/// upgrade preserves it and a failed one leaves it exactly as it was —
/// CurrentLink is never touched until the new version has already passed
/// verification.
pub fn current_installed_version(session: &Session, layout: &RemoteLayout) -> Option<String> {
    // readlink prints the symlink's target; basename of that target is the
    // version, by construction (CurrentLink -> ".../runtime/<version>").
    let command = format!(
        "readlink {} 2>/dev/null | xargs -I{{}} basename {{}}",
        q(&layout.current_link())
    );
    exec_capture(session, &command)
        .ok()
        .map(|out| out.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// One progress event the install flow reports back to its caller, which in
/// `lib.rs` becomes the `remote-install://progress` event the WebView draws
/// as `connection.phase = 'installing'` (§6 of the design: the connection's
/// own state machine, not a value borrowed from the turn/approval state).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallStage {
    DetectingPlatform,
    CheckingExistingInstall,
    PreparingStaging,
    Uploading,
    VerifyingAndSwitching,
    Done,
}

/// Installs or upgrades the Runtime on the host `session` is already
/// connected to, running every step in order and reporting each one through
/// `on_stage` as it starts.
///
/// `archive_path` must already be the correct platform's archive — selected
/// by the caller after `detect_remote_target` answers, from the two bundled
/// under `remote-packages/` (`lib.rs`'s `install_remote_runtime` command is
/// what makes that selection; this function only ever uploads the one
/// archive it is given).
///
/// Failure at any step before `verify_and_switch_command` leaves the
/// previous install, if any, completely untouched — nothing before that
/// point writes anywhere but StagingDir. A failure *during*
/// `verify_and_switch_command` is reported with the staging directory left
/// in place (never cleaned up on this path) so the actual state of a failed
/// upload is still inspectable, matching `bootstrap.RollbackCommand`'s own
/// "do not delete the evidence" rule on the Go side.
pub fn install_or_upgrade(
    session: &Session,
    archive_path: &Path,
    version: &str,
    mut on_stage: impl FnMut(InstallStage),
    mut on_upload_progress: impl FnMut(usize, usize),
) -> Result<String, String> {
    on_stage(InstallStage::DetectingPlatform);
    let remote_target = detect_remote_target(session)?;
    let home = remote_home_dir(session)?;
    let layout = RemoteLayout::new(&home, version, remote_target);

    on_stage(InstallStage::CheckingExistingInstall);
    let backup_version = current_installed_version(session, &layout).unwrap_or_default();
    if backup_version == version {
        // Already installed at this exact version: nothing to do, and
        // nothing is uploaded on this path at all — re-uploading an
        // identical version would still work, but the point of version
        // detection (§8.4) is specifically to skip that when it is not
        // necessary.
        on_stage(InstallStage::Done);
        return Ok(layout.current_link() + "/" + remote_target.binary_name());
    }

    on_stage(InstallStage::PreparingStaging);
    run_shell_sequence(session, &prepare_staging_command(&layout))?;

    on_stage(InstallStage::Uploading);
    upload_archive_contents(session, archive_path, &layout, &mut on_upload_progress)?;

    on_stage(InstallStage::VerifyingAndSwitching);
    run_shell_sequence(session, &verify_and_switch_command(&layout, &backup_version))?;

    on_stage(InstallStage::Done);
    Ok(format!("{}/{}", layout.current_link(), remote_target.binary_name()))
}


