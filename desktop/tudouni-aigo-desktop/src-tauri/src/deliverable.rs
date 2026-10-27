//! Opening a declared deliverable, locally or as a downloaded copy from a
//! remote workspace.
//!
//! The local boundary is a `canonicalize` under the workspace, which cannot
//! reach the far host — hence the download-then-open path for remote sessions.

use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::bridge::Bridge;
use crate::bridge::ChildKey;
use crate::remote_files;

/// Open one **declared deliverable** in the operating system's default
/// application.
///
/// This exists as a command rather than as a direct `openPath` call from the
/// page for one reason: **the boundary has to be re-checked on this side of the
/// IPC**, against the file that is actually there. The path arrives from the
/// model, through the runtime, through the card — three hops in which nothing
/// verified that it names a file inside the workspace whose session declared it.
/// The Go runtime checks it when the declaration is made, and that check is
/// right; but a check made once, in another process, minutes ago, about a path
/// that is a *string* in between, is not the thing to hand to `explorer.exe`.
///
/// So the same rule is applied here, at the moment of the act: join the
/// workspace and the relative path, canonicalize both, and require the result to
/// stay under the root. A `..` that escapes, a symlink pointing out, or a file
/// that has been replaced since the declaration all fail the same way.
///
/// **It does not open through the plugin's own scope check.** `openPath` takes a
/// path and learns nothing about workspaces, so the scope check would be the
/// front end's, which is the layer this command exists to stop trusting.
///
/// The error string is written for a person: it is shown on the card, next to
/// the file it is about, and "the file is gone" is the one outcome a reader can
/// act on.
#[tauri::command]
pub(crate) fn deliverable_open(workspace: String, path: String) -> Result<(), String> {
    let relative = path.trim();
    if relative.is_empty() {
        return Err("no file was named".to_string());
    }
    // An absolute path is refused rather than joined: `Path::join` with an
    // absolute argument **replaces** the base, so passing one through would skip
    // the boundary below by construction.
    if Path::new(relative).is_absolute() {
        return Err("the card names a path outside the workspace".to_string());
    }

    let root = fs::canonicalize(workspace.trim())
        .map_err(|e| format!("cannot read the workspace directory: {e}"))?;
    let target = fs::canonicalize(root.join(relative)).map_err(|_| {
        format!("{relative} is not there any more — it may have been moved or deleted")
    })?;
    if target.strip_prefix(&root).is_err() {
        return Err(format!("{relative} is outside the workspace"));
    }
    if !target.is_file() {
        return Err(format!("{relative} is not a regular file"));
    }

    tauri_plugin_opener::open_path(&target, None::<&str>)
        .map_err(|e| format!("the system could not open it: {e}"))
}

/// The destination of one downloaded remote deliverable.
#[derive(Clone, Serialize)]
pub(crate) struct DownloadedDeliverable {
    /// The absolute path of the local copy — what the OS is handed and what
    /// the card shows as "the copy is here".
    path: String,
    /// False when the copy was already cached and nothing was transferred.
    /// The front end says "the copy is here" rather than "downloaded" for
    /// that, because saying it downloaded a file it did not touch would be
    /// a sentence about an act that did not happen.
    from_cache: bool,
}

/// Open a **local copy** of a downloaded remote deliverable in the OS default
/// application — the second half of the remote card's gesture.
///
/// `deliverable_open` cannot be reused for this: its boundary is the
/// workspace root, and the copy lives under this app's own data directory
/// (`deliverable_download` put it there). The same rule applies with a
/// different root: the path is canonicalized and required to stay under the
/// downloads tree, so a string the page hands back cannot reach anywhere else
/// on disk, even if it was never produced by `deliverable_download`.
#[tauri::command]
pub(crate) fn deliverable_open_local(app: AppHandle, path: String) -> Result<(), String> {
    let target = fs::canonicalize(path.trim()).map_err(|_| {
        "the downloaded copy is not there any more — it may have been moved or deleted"
            .to_string()
    })?;
    let downloads = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("cannot find this app's data directory: {e}"))?
        .join("downloads");
    let downloads = fs::canonicalize(&downloads).map_err(|_| {
        "the downloads directory is not there — the copy cannot be located".to_string()
    })?;
    if target.strip_prefix(&downloads).is_err() {
        return Err("that file is outside the downloads directory and is not opened".to_string());
    }
    if !target.is_file() {
        return Err("the downloaded copy is not a regular file".to_string());
    }
    tauri_plugin_opener::open_path(&target, None::<&str>)
        .map_err(|e| format!("the system could not open it: {e}"))
}

/// Open a file **mentioned in the model's reply text** in the OS default
/// application.
///
/// Unlike `deliverable_open`, this command accepts **both** relative paths
/// (resolved against the workspace root) and absolute paths. The model's prose
/// often names files by relative path (`src/main.rs`) or by absolute path
/// (`C:/tmp/out.png`), and the front end has already narrowed the call to a
/// allow-list of extensions before invoking this command — so the trust model
/// is "the user clicked a path the model wrote, and the extension is one we
/// agreed to open." This is deliberately less strict than the deliverable
/// boundary, which guards a *declared* output the runtime vouched for.
///
/// Relative paths are canonicalized under the workspace root; absolute paths
/// are canonicalized as-is. Either way, the file must exist and be a regular
/// file — a directory or a missing path is refused with a sentence written
/// for the person reading the reply.
#[tauri::command]
pub(crate) fn open_file_path(workspace: String, path: String) -> Result<(), String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("no file was named".to_string());
    }

    let target = if Path::new(raw).is_absolute() {
        fs::canonicalize(raw).map_err(|_| {
            format!("{raw} is not there — it may have been moved or deleted")
        })?
    } else {
        let root = fs::canonicalize(workspace.trim())
            .map_err(|e| format!("cannot read the workspace directory: {e}"))?;
        fs::canonicalize(root.join(raw)).map_err(|_| {
            format!("{raw} is not there — it may have been moved or deleted")
        })?
    };

    if !target.is_file() {
        return Err(format!("{} is not a regular file", raw));
    }

    tauri_plugin_opener::open_path(&target, None::<&str>)
        .map_err(|e| format!("the system could not open it: {e}"))
}

/// Download one declared deliverable from the session's remote workspace into
/// the local cache tree, so the card's "open" can hand the local copy to the
/// OS default application — the act `deliverable_open` refuses for a remote
/// workspace, because its boundary is a local `canonicalize`.
///
/// The session is named by its child's **key**, never by the connection
/// parameters: the host, credentials and remote workspace all come from the
/// child this layer started, the same rule `image_stash` follows. A caller
/// that could name the destination could pull a file from a machine the
/// session does not run on, which is exactly the trust this layer exists to
/// withhold.
///
/// The local destination keeps the workspace's own shape per segment
/// (`remote_files::local_download_path`): one directory per
/// (host, user, remote workspace), then the file's own relative path. An
/// existing copy is served as-is — a second press is "open the copy", not a
/// re-download.
#[tauri::command]
pub(crate) async fn deliverable_download(
    app: AppHandle,
    key: ChildKey,
    path: String,
) -> Result<DownloadedDeliverable, String> {
    tauri::async_runtime::spawn_blocking(move || deliverable_download_blocking(app, key, path))
        .await
        .map_err(|error| format!("the download task failed: {error}"))?
}

fn deliverable_download_blocking(
    app: AppHandle,
    key: ChildKey,
    path: String,
) -> Result<DownloadedDeliverable, String> {
    let (workspace, ssh, dest) = {
        let state: State<Bridge> = app.state();
        let guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        let current = guard
            .children
            .get(&key)
            .ok_or("that session's runtime is not running, so there is no file to pull")?;
        let (workspace, ssh) = match (current.remote_workspace.clone(), current.remote_ssh.clone()) {
            (Some(workspace), Some(ssh)) => (workspace, ssh),
            _ => return Err("that session's workspace is local; use the ordinary open for it".to_string()),
        };
        // The destination is decided here, under the same lock that owns the
        // connection facts it is built from — and before the network is
        // touched, because a path that fails the boundary check should not
        // cost a handshake.
        let app_data = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("cannot find this app's data directory: {e}"))?;
        let dest = remote_files::local_download_path(
            &app_data,
            &ssh.host,
            &ssh.user,
            &workspace,
            &path,
        )?;
        (workspace, ssh, dest)
    };

    if dest.is_file() {
        return Ok(DownloadedDeliverable {
            path: dest.to_string_lossy().to_string(),
            from_cache: true,
        });
    }

    let target = ssh.to_target();
    remote_files::download(&target, &workspace, path.trim(), &dest, remote_files::MAX_DOWNLOAD_BYTES)?;

    Ok(DownloadedDeliverable {
        path: dest.to_string_lossy().to_string(),
        from_cache: false,
    })
}
