//! The one SSH call the "add a remote workspace" flow makes **before** it can
//! ask anybody anything: connect, and report what is actually on the other end.
//!
//! # Why this exists as its own step
//!
//! The first version of this feature asked for everything up front — a host, a
//! port, a user, key paths, a password, a workspace directory and a runtime
//! binary path — in one form, and then saved all of it without connecting. That
//! is the shape the flow was rebuilt to remove, and the reason is visible in
//! what that form could not tell the person filling it in:
//!
//!   - whether the credentials they just typed work at all;
//!   - what platform the far end is, and therefore whether a runtime is even
//!     published for it;
//!   - where that account's home is, which is the root every sensible workspace
//!     path is relative to;
//!   - which directories exist, which is the question "where should I work?"
//!     actually is, and which a free-text path field answers by making the
//!     person guess a string that is only validated on connect;
//!   - whether the runtime is already installed, and at which version.
//!
//! All five are answers from the remote host, so the flow now **connects
//! first** and asks the person only what remains — which directory — with the
//! real list in front of them. This module is that connect: one dial, a handful
//! of cheap probes over it, and one directory listing.
//!
//! # What it deliberately does not do
//!
//!   - **It writes nothing.** Creating a directory is a separate command
//!     (`create_remote_directory`), so merely looking around a host someone
//!     typed a password for cannot leave anything behind on it.
//!   - **It installs nothing.** Whether the runtime is present is reported as a
//!     fact; installing it stays `install_remote_runtime`'s job, reached by an
//!     explicit press.
//!   - **It re-derives no install rule.** The path it looks for, and the
//!     version it reads, both come from `remote_install::RemoteLayout` —
//!     `current_binary_for` and `installed_version` — so a change to the layout
//!     cannot leave this probe looking somewhere else than the installer wrote.

use crate::remote_install;
use crate::ssh_backend::SshTarget;
use ssh2::Session;
use std::path::Path;

/// One directory the person could choose as a workspace.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirEntry {
    /// The directory's own name, for the row.
    pub name: String,
    /// Its absolute path — what choosing it actually means.
    pub path: String,
}

/// Everything the wizard's second step draws, in one round trip.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProbe {
    /// The remote account's `$HOME`, the root the browser starts at.
    pub home: String,
    /// The directory this reply actually describes (after `realpath`), so a
    /// listing reached through a symlink names where it really is.
    pub path: String,
    /// The parent directory, or `null` at the filesystem root — the browser's
    /// "up" row, decided here rather than string-sliced in the front end.
    pub parent: Option<String>,
    /// `"linux"`, `"windows"`, or `"unknown"` when neither probe answered.
    pub os: String,
    /// `"x86_64"`, `"aarch64"`, … as the far end reported it.
    pub arch: String,
    /// Whether this program publishes a Runtime for that platform.
    pub supported: bool,
    /// Why it does not, when it does not — `detect_remote_target`'s own
    /// sentence, shown verbatim rather than reworded.
    pub platform_problem: Option<String>,
    /// The installed runtime's absolute path, when one is already there.
    pub runtime_binary: Option<String>,
    /// The version `CurrentLink` points at, when one is. `null` alongside a
    /// set `runtime_binary` means a runtime at the conventional path that this
    /// probe could not date.
    pub runtime_version: Option<String>,
    /// `~/.tudouni/config.json`'s state — `remote_config`'s own classification
    /// (`missing`/`empty_template`/`no_usable_route`/`valid`/`corrupt`), so the
    /// connection step can say whether the far end has a model configured
    /// without a second round trip.
    pub config_status: String,
    /// Why this listed directory cannot itself be the workspace — the remote
    /// mirror of the local `unsafe_workspace` refusal (the home directory, a
    /// volume root). `null` when it is usable.
    pub workspace_problem: Option<String>,
    /// The directories inside `path`, sorted, with dot-directories omitted.
    pub entries: Vec<RemoteDirEntry>,
}

/// Connects, probes, and lists one directory.
///
/// `path` empty or `None` means the account's home directory, which is where a
/// browser has to start: it is the only directory whose absolute location the
/// far end can name without being told.
pub fn probe(target: &SshTarget, path: Option<&str>) -> Result<RemoteProbe, String> {
    let session = crate::ssh_backend::dial_session(target)?;

    let home = remote_install::remote_home_dir(&session)?;

    // The detected target is what the install path and the archive name are
    // derived from, so it is resolved once here and reused for every question
    // below. A refused platform is **not** an error: it is one of the facts
    // this step exists to report, and failing the whole probe would hide the
    // home directory and the listing — exactly what a person needs in order to
    // understand that this host is out of scope.
    let detected = remote_install::detect_remote_target(&session);
    let (os, arch) = describe_platform(&session);
    let (supported, platform_problem) = match &detected {
        Ok(_) => (true, None),
        Err(reason) => (false, Some(reason.clone())),
    };

    // Installed-runtime questions only make sense for a platform this program
    // can install for; there is no layout to ask about otherwise.
    let (runtime_binary, runtime_version) = match &detected {
        Ok(target) => {
            let path = remote_install::current_binary_for(&home, *target);
            let version = remote_install::installed_version(&session, &home);
            if remote_file_exists(&session, &path) {
                (Some(path), version)
            } else {
                (None, None)
            }
        }
        Err(_) => (None, None),
    };

    let config_status = crate::remote_config::check_remote_config(&session, &home)
        .map(|inspection| inspection.status.as_str().to_string())
        .unwrap_or_else(|_| "missing".to_string());

    let requested = match path.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value.to_string(),
        None => home.clone(),
    };

    let resolved = resolve_dir(&session, &requested)?;
    let entries = list_directories(&session, &resolved)?;
    let parent = parent_of(&resolved);
    let workspace_problem = workspace_problem_for(&resolved, &home);

    Ok(RemoteProbe {
        home,
        path: resolved,
        parent,
        os,
        arch,
        supported,
        platform_problem,
        runtime_binary,
        runtime_version,
        config_status,
        workspace_problem,
        entries,
    })
}

/// Creates one directory on the remote host, recursively — the wizard's "new
/// folder". Deliberately a **separate command** from `probe`, so browsing a
/// host cannot create anything on it.
///
/// Refuses a relative path rather than resolving it against some guess: the
/// failure mode of guessing is creating a directory somewhere nobody asked for,
/// on a machine that is not this one.
pub fn create_directory(target: &SshTarget, path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("no directory name was given".to_string());
    }
    if !trimmed.starts_with('/') && !trimmed.starts_with('~') {
        return Err(format!(
            "{trimmed} is not an absolute path — name the directory from the remote account's home, or from /"
        ));
    }

    let session = crate::ssh_backend::dial_session(target)?;
    let home = remote_install::remote_home_dir(&session)?;
    let expanded = expand_home(trimmed, &home);

    remote_install::mkdir_remote_recursive(&session, &expanded)?;
    // Confirm rather than assume: `mkdir_remote_recursive` tolerates "already
    // exists", so the caller is handed the directory's real location — which is
    // also what the browser will list next.
    resolve_dir(&session, &expanded)
}

/* ============================================================
   Probes over one session
   ============================================================ */

/// The platform, reduced to what the UI says out loud.
///
/// `detect_remote_target` decides "can a runtime be installed here" and its
/// refusal sentence is carried through unchanged; the two `uname` answers are
/// collected separately only so the connection step can show what the far end
/// actually is, which is what a person looking at "this platform is not
/// supported" needs in order to act on it.
fn describe_platform(session: &Session) -> (String, String) {
    let os = remote_install::exec_capture(session, "uname -s")
        .ok()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    let arch = remote_install::exec_capture(session, "uname -m")
        .ok()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    (os, arch)
}

fn remote_file_exists(session: &Session, path: &str) -> bool {
    session
        .sftp()
        .ok()
        .and_then(|sftp| sftp.stat(Path::new(path)).ok())
        .map(|stat| !stat.is_dir())
        .unwrap_or(false)
}

/// The absolute form of a directory, following symlinks — so the listing and
/// the path shown are the directory's real location, and going "up" from a
/// symlinked entry cannot walk out of where the person thinks they are.
fn resolve_dir(session: &Session, dir: &str) -> Result<String, String> {
    let sftp = session.sftp().map_err(|e| format!("could not start an SFTP session: {e}"))?;
    let stat = sftp
        .stat(Path::new(dir))
        .map_err(|e| format!("{dir} cannot be read on the remote host: {e}"))?;
    if !stat.is_dir() {
        return Err(format!("{dir} is not a directory on the remote host"));
    }
    // `realpath` is the authority; falling back to the requested string keeps a
    // server that refuses the call from failing the whole probe, and the path
    // is still one the person chose.
    Ok(sftp
        .realpath(Path::new(dir))
        .ok()
        .and_then(|path| path.to_str().map(|text| text.to_string()))
        .unwrap_or_else(|| dir.to_string()))
}

/// The directory's own entries: directories only, dot-directories omitted.
///
/// Directories only, because the question this list answers is "which directory
/// should the runtime treat as its workspace" — a file cannot be chosen, and
/// offering one would be an option that always fails. Dot-directories are
/// omitted for the same reason this is a *workspace* picker rather than a file
/// manager: `.ssh`, `.cache` and `.local` are noise in that list, and a person
/// who genuinely wants one can still type its path.
fn list_directories(session: &Session, dir: &str) -> Result<Vec<RemoteDirEntry>, String> {
    let sftp = session.sftp().map_err(|e| format!("could not start an SFTP session: {e}"))?;
    let raw = sftp
        .readdir(Path::new(dir))
        .map_err(|e| format!("could not list {dir} on the remote host: {e}"))?;

    let mut entries: Vec<RemoteDirEntry> = raw
        .into_iter()
        .filter(|(path, stat)| stat.is_dir() && !is_dot_entry(path))
        .map(|(path, _)| {
            let name = path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_default();
            let full = path.to_string_lossy().to_string();
            RemoteDirEntry { name, path: full }
        })
        .collect();
    // Sorted here rather than trusting the server: SFTP's own order is whatever
    // the remote filesystem returns, and a list that reshuffles between two
    // visits to the same directory reads as a bug.
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

/// Whether an entry is `.`, `..` or a hidden directory.
///
/// SFTP servers vary in whether they report `.` and `..` at all, so both are
/// dropped by name rather than assumed absent.
fn is_dot_entry(path: &Path) -> bool {
    match path.file_name() {
        Some(name) => name.to_string_lossy().starts_with('.'),
        None => true,
    }
}

/// The parent directory, or `None` at the root.
fn parent_of(dir: &str) -> Option<String> {
    let trimmed = dir.trim_end_matches('/');
    if trimmed.is_empty() {
        // "/" itself, or a path that reduced to nothing: there is nowhere up.
        return None;
    }
    match trimmed.rfind('/') {
        Some(0) => Some("/".to_string()),
        Some(index) => Some(trimmed[..index].to_string()),
        None => None,
    }
}

/// Why this directory cannot be a workspace, mirroring the local refusal.
///
/// The runtime makes this check itself on start-up and exits with code 2 — but
/// that happens *after* an SSH connection, an install and a spawn, and its
/// message would arrive as a dead session rather than as a sentence next to the
/// directory the person just picked. Asking here means the picker can disable
/// its button and say why, while the choice is still in front of them.
fn workspace_problem_for(dir: &str, home: &str) -> Option<String> {
    let normalised = dir.trim_end_matches('/');
    if normalised.is_empty() {
        return Some("it is the filesystem root".to_string());
    }
    if normalised == home.trim_end_matches('/') {
        return Some(
            "it is the account's home directory, and the runtime refuses it: the file tools' \
             boundary would be everything below it"
                .to_string(),
        );
    }
    None
}

/// Expands a leading `~` against the remote account's own home, so a person
/// typing `~/work` is not required to know the absolute path.
fn expand_home(path: &str, home: &str) -> String {
    let home = home.trim_end_matches('/');
    if path == "~" {
        return home.to_string();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return format!("{}/{}", home, rest.trim_start_matches('/'));
    }
    path.to_string()
}
