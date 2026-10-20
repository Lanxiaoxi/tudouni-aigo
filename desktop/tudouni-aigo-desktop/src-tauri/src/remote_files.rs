//! Remote file access for the doors that used to be local-only.
//!
//! Three acts, all the same shape — **dial a fresh SSH connection, do one SFTP
//! act, drop everything** — and none of them may touch the runtime's own
//! channel:
//!
//!   - **download** — a declared deliverable is a path on the far end, and
//!     `deliverable_open`'s local `canonicalize`/`open_path` cannot reach it.
//!     The card's "open" becomes "download": pull the bytes here, and the OS
//!     opens the local copy.
//!   - **read image** — the transcript's `inline_image` has the same problem
//!     for a picture the model generated remotely; the bytes travel back as a
//!     `data:` URL exactly the local command returns.
//!   - **upload image** — a pasted picture's bytes are already local, and the
//!     runtime's only image channel is a path in the sentence resolved on the
//!     far end. So the bytes go *there*, into the remote workspace's own
//!     `.tudouni/paste/` staging area, and the sentence carries the same
//!     workspace-relative path the local stash returns.
//!
//! # Why a separate connection per act
//!
//! The runtime's channel (`ssh_backend::connect`) is a non-blocking, lock-
//! shared session driven by three threads; reaching into it for a file
//! transfer would mean either serialising a multi-megabyte transfer behind
//! the protocol's `WouldBlock` polling, or a second set of locks on one
//! object. A fresh `dial_session` per act is what `remote_install` and
//! `remote_probe` already do for their own multi-step work — the handshake
//! costs tens of milliseconds against a file transfer measured in its own
//! round trips, and the act is one that the person just pressed a button for,
//! not something the runtime's conversation waits on.
//!
//! # The boundary
//!
//! The local `deliverable_open`/`inline_image` commands canonicalize against
//! the workspace root — `..`, an absolute path, and a symlink escaping all
//! fail. Nothing equivalent is possible here, because canonicalizing means
//! a syscall on the machine that holds the file. What is possible, and what
//! this module does, is the same *decision* in string form: refuse an empty
//! name, a control character, an absolute path (joining with one replaces
//! the base, which would skip the boundary by construction), and any `..`
//! segment. The rest is held by the far end's own account: SFTP resolves
//! against that account's filesystem, and a path that stays textually under
//! the workspace root names something inside it — the account that owns the
//! workspace is the account that runs the runtime in it, the same fact the
//! local boundary rests on.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::ssh_backend::{dial_session, SshTarget};

/// Joins one workspace-relative path onto the remote workspace root and
/// checks it stays inside it — the string form of the boundary
/// `deliverable_open` and `inline_image` apply locally (see the module doc
/// for why a canonicalize is not an option on this side of the wire).
pub fn resolve_remote_path(workspace: &str, relative: &str) -> Result<String, String> {
    let rel = relative.trim().replace('\\', "/");
    if rel.is_empty() {
        return Err("no file was named".to_string());
    }
    if rel.contains('\0') {
        return Err("the path carries a control character and is refused".to_string());
    }
    let is_windows_absolute = rel.len() >= 3
        && rel.as_bytes()[0].is_ascii_alphabetic()
        && rel.as_bytes()[1] == b':';
    if rel.starts_with('/') || is_windows_absolute {
        return Err(format!("{relative} names a path outside the workspace"));
    }
    for segment in rel.split('/') {
        if segment == ".." {
            return Err(format!("{relative} names a path outside the workspace"));
        }
    }
    let root = workspace.trim().trim_end_matches('/');
    if root.is_empty() {
        return Err("the remote workspace is not known".to_string());
    }
    Ok(format!("{root}/{rel}"))
}

/// The parent directory of one absolute-style remote path, or `None` for a
/// path with no parent at all. Kept separate from
/// `remote_install::parent_of` rather than made `pub` there, because that
/// module's private helper mirrors a Go-side rule — widening its visibility
/// for a different job would blur which rules it owns.
fn parent_of(path: &str) -> Option<String> {
    let index = path.rfind('/')?;
    if index == 0 {
        return Some("/".to_string());
    }
    Some(path[..index].to_string())
}

/// The ceiling on one downloaded deliverable.
///
/// Deliberate rather than the network's own limit: a deliverable is a file a
/// person will open, and a multi-gigabyte build artifact is not that — the
/// right answer to one is "open it on the host or fetch it with a tool that
/// shows progress", not a window that quietly fills the disk. Checked before
/// the first byte is read, for the same reason the picture ceiling is.
pub const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;

/// Copies one remote file to `local_dest`, refusing it first when it is over
/// `max_bytes`, and writing to a `.part` file so a failure mid-transfer never
/// leaves a half file behind — the front end treats an existing local copy as
/// the cache and opens it without re-downloading, so a truncated file would be
/// served to the person as the deliverable itself.
pub fn download(
    target: &SshTarget,
    remote_workspace: &str,
    relative: &str,
    local_dest: &Path,
    max_bytes: u64,
) -> Result<(), String> {
    let remote_path = resolve_remote_path(remote_workspace, relative)?;
    let session = dial_session(target)?;
    let sftp = session
        .sftp()
        .map_err(|e| format!("could not start an SFTP session: {e}"))?;

    let metadata = sftp.stat(Path::new(&remote_path)).map_err(|_| {
        format!(
            "{relative} is not there on the remote host — it may have been moved or deleted"
        )
    })?;
    // `size` is an `Option`: some servers report no length for a stream, and
    // `None` here means "no ceiling to enforce", not "zero bytes".
    let size = metadata.size.unwrap_or(0);
    if size > max_bytes {
        return Err(format!(
            "{relative} is {size} bytes, over the {} byte ceiling for a download",
            max_bytes
        ));
    }
    let mut remote = sftp
        .open(Path::new(&remote_path))
        .map_err(|e| format!("could not open {relative} on the remote host: {e}"))?;

    if let Some(parent) = local_dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let partial = PathBuf::from(format!("{}.part", local_dest.to_string_lossy()));

    let copy = (|| -> std::io::Result<()> {
        let mut local = std::fs::File::create(&partial)?;
        let mut chunk = [0u8; 256 * 1024];
        loop {
            let read = remote.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            local.write_all(&chunk[..read])?;
        }
        Ok(())
    })();

    if let Err(e) = copy {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("the download stopped part way: {e}"));
    }
    std::fs::rename(&partial, local_dest).map_err(|e| {
        let _ = std::fs::remove_file(&partial);
        format!("could not move the downloaded file into place: {e}")
    })
}

/// Reads one remote file into memory, refusing (by size, twice — before the
/// read and against what actually arrived) anything over `limit` bytes. The
/// before-the-read check matters because the ceiling exists to keep a large
/// file out of memory, and holding it in memory to measure it defeats that:
/// the same rule `image_stash` applies to the local clipboard path.
pub fn read_image(
    target: &SshTarget,
    remote_workspace: &str,
    relative: &str,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let remote_path = resolve_remote_path(remote_workspace, relative)?;
    let session = dial_session(target)?;
    let sftp = session
        .sftp()
        .map_err(|e| format!("could not start an SFTP session: {e}"))?;

    let metadata = sftp.stat(Path::new(&remote_path)).map_err(|_| {
        format!("{relative} is not there on the remote host — the picture may not have been written yet")
    })?;
    // Same rule as the download's size check: `None` is "no length reported",
    // and the ceiling is still enforced against what actually arrives below.
    let size = metadata.size.unwrap_or(0);
    if size > limit as u64 {
        return Err(format!(
            "{relative} is {size} bytes, over the {} byte ceiling for one picture",
            limit
        ));
    }

    let mut file = sftp
        .open(Path::new(&remote_path))
        .map_err(|e| format!("could not open {relative} on the remote host: {e}"))?;
    let mut bytes = Vec::with_capacity(size as usize);
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut chunk)
            .map_err(|e| format!("could not read {relative} from the remote host: {e}"))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() > limit {
            return Err(format!(
                "{relative} is over the {} byte ceiling for one picture",
                limit
            ));
        }
    }
    Ok(bytes)
}

/// One way an upload can be refused, for a caller that can distinguish the
/// two: "that name is taken" is a fact the name-generation loop can act on
/// (try the next counter), while a connection or I/O failure is a fact to
/// report to the person as-is.
pub enum UploadError {
    /// The path already exists on the far end — the remote twin of the local
    /// `target.exists()` check in the stash's name-generation loop.
    Exists,
    /// Anything else, with the sentence already written for a person.
    Io(String),
}

/// Like the plain upload, but a taken name is `UploadError::Exists` rather than
/// a sentence — the caller (the stash's name loop) decides what to do with it.
pub fn upload_if_new(
    target: &SshTarget,
    remote_workspace: &str,
    relative: &str,
    bytes: &[u8],
) -> Result<(), UploadError> {
    upload_bytes_checked(target, remote_workspace, relative, bytes)
}

fn upload_bytes_checked(
    target: &SshTarget,
    remote_workspace: &str,
    relative: &str,
    bytes: &[u8],
) -> Result<(), UploadError> {
    let remote_path = resolve_remote_path(remote_workspace, relative).map_err(UploadError::Io)?;
    let session = dial_session(target).map_err(UploadError::Io)?;
    let sftp = session
        .sftp()
        .map_err(|e| UploadError::Io(format!("could not start an SFTP session: {e}")))?;

    if sftp.stat(Path::new(&remote_path)).is_ok() {
        return Err(UploadError::Exists);
    }
    if let Some(parent) = parent_of(&remote_path) {
        crate::remote_install::mkdir_remote_recursive(&session, &parent)
            .map_err(UploadError::Io)?;
    }
    let mut file = sftp
        .create(Path::new(&remote_path))
        .map_err(|e| UploadError::Io(format!("could not create {relative} on the remote host: {e}")))?;
    file.write_all(bytes)
        .map_err(|e| UploadError::Io(format!("could not write {relative} to the remote host: {e}")))
}

/// A name usable as one local path component, for the destination's host,
/// workspace and file names. A remote name is legal on the far end and
/// illegal on this one (`a:b` is a file on Linux and cannot be a name on
/// Windows), so the reserved characters are folded rather than trusted.
///
/// It is applied to **every** segment of the local destination, not just the
/// last: a subdirectory a model named is a subdirectory that must exist
/// under the cache tree, and a separator is a local path fact this machine
/// decides.
pub(crate) fn sanitize_component(name: &str) -> String {
    const RESERVED: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    name.chars()
        .map(|ch| {
            if RESERVED.contains(&ch) {
                '_'
            } else {
                ch
            }
        })
        .collect()
}

/// The file's own name, from one remote path. The local twin of `Path::file_name`
/// for the segments this module already normalizes to forward slashes; it is
/// used for the name the answer reports, which is a label for a person, not a
/// path — so it needs no further local-fitness handling.
pub fn file_name_of(path: &str) -> String {
    let normalized = path.trim_end_matches('/').replace('\\', "/");
    match normalized.rfind('/') {
        Some(index) => normalized[index + 1..].to_string(),
        None => normalized,
    }
}

/// The **local** destination of a downloaded remote file: one directory per
/// (host, user, remote workspace), then the file's own path **kept per
/// segment** — a download of `out/report.xlsx` from workspace `/home/dev/proj`
/// lands under `proj/out/report.xlsx`, which is what a person expects from a
/// name that is relative to a directory.
///
/// Kept in one place because the front end shows this path to the person
/// ("the copy is here") and the download writes it: two ways of spelling the
/// same destination is how the message and the file end up disagreeing.
pub fn local_download_dir(app_data: &Path, host: &str, user: &str, remote_workspace: &str) -> PathBuf {
    let mut dir = app_data.join("downloads");
    dir = dir.join(sanitize_component(host));
    dir = dir.join(sanitize_component(user));
    for segment in remote_workspace
        .trim_end_matches(['/', '\\'])
        .split(['/', '\\'])
        .filter(|segment| !segment.trim().is_empty())
    {
        dir = dir.join(sanitize_component(segment));
    }
    dir
}

/// The complete **local** destination of a downloaded remote file: the
/// per-(host, user, remote workspace) directory, then the file's own relative
/// path joined segment by segment. `..` is refused on the way (the callers
/// have already passed the boundary check, and this is the second door, not
/// a guess).
pub fn local_download_path(
    app_data: &Path,
    host: &str,
    user: &str,
    remote_workspace: &str,
    relative: &str,
) -> Result<PathBuf, String> {
    let normalized = relative.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("no file was named".to_string());
    }
    let mut dest = local_download_dir(app_data, host, user, remote_workspace);
    for segment in normalized.split('/') {
        if segment.is_empty() {
            continue;
        }
        if segment == ".." {
            return Err(format!("{relative} names a path outside the workspace"));
        }
        dest = dest.join(sanitize_component(segment));
    }
    Ok(dest)
}

/// One local path component, or `fallback` when the path carries no usable
/// last segment at all (a root, an empty string, a string of separators).
pub(crate) fn last_component(path: &str, fallback: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .find(|segment| !segment.trim().is_empty())
        .map(sanitize_component)
        .filter(|segment| !segment.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// Removes one directory and everything in it, from the far end.
///
/// SFTP has no recursive delete, so this is the obvious thing it implies:
/// remove every file, then the directory itself. It is used for exactly one
/// purpose — a finished session's slice of the remote paste staging area —
/// and a refusal to remove a file is tolerated rather than an error, because
/// the goal is "nothing left behind" and a file the server will not release
/// stays there without anything to do about it.
fn remove_remote_tree(sftp: &ssh2::Sftp, remote_dir: &str) {
    let entries = match sftp.readdir(Path::new(remote_dir)) {
        Ok(entries) => entries,
        // Not there: nothing to clear, and that is the ordinary case for a
        // session that never pasted a picture.
        Err(_) => return,
    };
    for (name, _stat) in entries {
        let name = name.to_string_lossy();
        let child = format!("{remote_dir}/{name}");
        // The paste area is files in one directory; a subdirectory is not
        // expected, and removing a file's parent is the only step that can
        // fail usefully here.
        let _ = sftp.unlink(Path::new(&child));
    }
    let _ = sftp.rmdir(Path::new(remote_dir));
}

/// Clears the finished sessions' slices of the remote workspace's paste
/// staging area — the remote twin of the local `sweep_staging`, called from
/// the same moment the local sweep runs (a local child starting, when the
/// person is in that workspace), with the same argument: which directories
/// belong to a session still running.
///
/// Without it, a picture pasted into a remote session would outlive that
/// session forever: the local runtime never cleans a workspace it does not
/// run in, and this process is the one that wrote the file, so it is the one
/// that takes it away.
pub fn sweep_remote_paste(target: &SshTarget, remote_workspace: &str, live: &[String]) {
    let root = format!(
        "{}/{}",
        remote_workspace.trim().trim_end_matches('/'),
        format!("{}/{}", crate::PASTE_DIR, crate::PASTE_SUBDIR)
    );
    let session = match dial_session(target) {
        Ok(session) => session,
        Err(_) => return, // The connection is down; the local sweep has run and
                          // the session that cannot be reached also cannot be
                          // started, so there is nothing to protect here.
    };
    let sftp = match session.sftp() {
        Ok(sftp) => sftp,
        Err(_) => return,
    };
    let entries = match sftp.readdir(Path::new(&root)) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for (name, stat) in entries {
        let name = name.to_string_lossy().to_string();
        // A directory for a live child is protected exactly as the local sweep
        // protects its `live` set; anything else is a finished session's
        // leftover.
        if live.iter().any(|key| key == &name) {
            continue;
        }
        // Only directories are slice candidates: a stray file at the root is
        // not something this process wrote, and this sweep does not delete
        // what it did not write.
        if !stat.is_dir() {
            continue;
        }
        remove_remote_tree(&sftp, &format!("{root}/{name}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relative_path_joins_under_the_root() {
        assert_eq!(
            resolve_remote_path("/home/dev/proj", "out/chart.png").unwrap(),
            "/home/dev/proj/out/chart.png"
        );
    }

    #[test]
    fn backslashes_are_a_separator_too() {
        // A Windows-shaped relative path from a model's sentence: the far end
        // may be Linux, so the path is normalized to forward slashes, which
        // SFTP always reads.
        assert_eq!(
            resolve_remote_path("/home/dev/proj", "out\\chart.png").unwrap(),
            "/home/dev/proj/out/chart.png"
        );
    }

    #[test]
    fn a_dot_slash_prefix_stays_inside_the_root() {
        assert_eq!(
            resolve_remote_path("/home/dev/proj", "./out/chart.png").unwrap(),
            "/home/dev/proj/./out/chart.png"
        );
    }

    #[test]
    fn a_trailing_slash_on_the_workspace_is_not_doubled() {
        assert_eq!(
            resolve_remote_path("/home/dev/proj/", "out/chart.png").unwrap(),
            "/home/dev/proj/out/chart.png"
        );
    }

    #[test]
    fn an_absolute_path_is_refused() {
        // Joining with an absolute path replaces the base — the one input that
        // would skip the boundary by construction, so it is refused rather
        // than joined. Both spellings of absolute, because the far end and the
        // author of the sentence may not agree on an OS.
        for absolute in ["/etc/passwd", "C:/Windows/system.ini", "C:\\temp\\x.png", "//server/share"] {
            assert!(
                resolve_remote_path("/home/dev/proj", absolute).is_err(),
                "{absolute} slipped through the boundary"
            );
        }
    }

    #[test]
    fn a_parent_reference_is_refused() {
        for escaping in ["..", "../a.png", "a/../../b.png", "a/.."] {
            assert!(
                resolve_remote_path("/home/dev/proj", escaping).is_err(),
                "{escaping} slipped through the boundary"
            );
        }
    }

    #[test]
    fn empty_and_control_characters_are_refused() {
        assert!(resolve_remote_path("/home/dev/proj", "").is_err());
        assert!(resolve_remote_path("/home/dev/proj", "   ").is_err());
        assert!(resolve_remote_path("/home/dev/proj", "a\0b.png").is_err());
    }

    #[test]
    fn a_missing_workspace_is_refused() {
        assert!(resolve_remote_path("", "a.png").is_err());
        assert!(resolve_remote_path("   ", "a.png").is_err());
    }

    #[test]
    fn the_parent_of_a_deep_path_is_everything_but_the_last_segment() {
        assert_eq!(parent_of("/a/b/c.png"), Some("/a/b".to_string()));
        assert_eq!(parent_of("/c.png"), Some("/".to_string()));
        assert_eq!(parent_of("relative.png"), None);
    }

    #[test]
    fn a_file_name_is_the_last_segment() {
        assert_eq!(file_name_of("out/chart.png"), "chart.png");
        assert_eq!(file_name_of("/home/dev/proj"), "proj");
        assert_eq!(file_name_of("relative.txt"), "relative.txt");
        assert_eq!(file_name_of("a/b/"), "b");
    }

    #[test]
    fn the_local_destination_keeps_the_workspace_shape() {
        let dir = local_download_dir(
            Path::new("/data"),
            "10.0.1.5",
            "deploy",
            "/home/dev/proj",
        );
        assert_eq!(dir, Path::new("/data/downloads/10.0.1.5/deploy/home/dev/proj"));
        // A trailing slash is the same directory, not an empty segment.
        let dir = local_download_dir(Path::new("/data"), "h", "u", "/home/dev/proj/");
        assert_eq!(dir, Path::new("/data/downloads/h/u/home/dev/proj"));
    }

    #[test]
    fn a_remote_name_legal_there_and_illegal_here_is_folded() {
        assert_eq!(last_component("projs:2026", "workspace"), "projs_2026");
        assert_eq!(last_component("a|b", "workspace"), "a_b");
        assert_eq!(last_component("/home/dev/", "workspace"), "dev");
        assert_eq!(last_component("", "workspace"), "workspace");
    }
}
