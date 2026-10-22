//! Writing a pasted picture into the workspace — locally, or up over SFTP into
//! the remote workspace's own staging area.
//!
//! The destination comes from the child, never from the caller: letting a
//! front end name the directory would be letting it choose where a file is
//! written.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};

use crate::bridge::Bridge;
use crate::bridge::ChildKey;
use crate::image::IMAGE_SIGNATURES;
use crate::image::ImageSignature;
use crate::image::MAX_IMAGE_BYTES;
use crate::workspace_staging::PASTE_DIR;
use crate::workspace_staging::PASTE_SUBDIR;
use crate::bridge::RemoteSshConn;
use crate::remote_files;

/// One picture written into the workspace, as the front end needs it back.
#[derive(Clone, Serialize)]
pub(crate) struct StashedImage {
    /// The **workspace-relative** path, with forward slashes.
    ///
    /// Relative because that is what the runtime will be handed: the user's
    /// sentence carries this string, `Workspace.SafePath` resolves it against the
    /// child's working directory, and every notice and rendered label shows the
    /// relative form. An absolute path in the prompt would be long, would name
    /// this machine, and would break the moment the workspace moved.
    ///
    /// Forward slashes always: on Windows a backslash in a prompt reads as an
    /// escape character to anybody who copies it into code, and the runtime's
    /// scanner accepts both separators.
    path: String,
    name: String,
    mime: String,
    bytes: usize,
}

/// Which of the accepted formats these bytes really are.
///
/// Decided from the **bytes**, never from the name or the declared type, because
/// both of those are claims. The runtime sniffs the same way
/// (`content.InspectImage`), so a file accepted here is one that layer accepts —
/// which is the point of asking at all rather than letting the refusal arrive a
/// round trip later.
// Visible to `remote_files` because the remote picture door applies the same
// check to bytes that arrived over the wire: a format accepted locally but
// refused remotely (or the reverse) would be a disagreement between two doors
// for the same picture.
pub(crate) fn sniff_image(bytes: &[u8]) -> Option<&'static ImageSignature> {
    IMAGE_SIGNATURES
        .iter()
        .find(|known| bytes.len() >= known.signature.len() && &bytes[..known.signature.len()] == known.signature)
}

/// Write a pasted picture into the workspace and hand back its path.
///
/// ## Why this command exists at all
///
/// The runtime's only way to receive a picture is a **path in the user's
/// sentence** (`internal/runtime/images.go`: there is no upload command and no
/// markup). A drop already has an absolute path from the OS; a paste does not,
/// because the clipboard carries bytes and a WebView has no filesystem. So the
/// bytes come here, become a file **inside the workspace**, and the front end
/// writes the returned path into the sentence. That is the whole feature.
///
/// ## Why the raw body
///
/// `InvokeBody::Raw`, not a JSON string. Five megabytes as base64 is 6.7MB of
/// text; as a JSON number array it is over 20MB. Tauri supports a raw body on
/// every platform this ships for (windows/amd64, linux/amd64), and the front end
/// passes a `Uint8Array` directly.
///
/// ## What is deliberately not here
///
/// **No width or height.** Measuring a picture means parsing a PNG/JPEG/GIF
/// header, which would be a second image implementation in this file — and the
/// runtime already reports both on its `image_attached` row, measured by the one
/// decoder that exists. Reporting a number this layer guessed is worse than
/// reporting none.
///
/// **No thumbnail.** The runtime's degradation ladder already shrinks a picture
/// before dropping it, and the front end renders its own preview from the bytes
/// it already has. A third copy on disk would be a third thing to keep in step.
///
/// ## Why the session arrives as a header
///
/// The payload **is** the bytes, so there is nowhere to put a second named
/// argument — `invoke` with a raw body carries no JSON object alongside it. With
/// one session that was fine; with several it is not, because the picture has to
/// land in the workspace of the session whose draft it is going into. So the key
/// travels as an `x-tudouni-key` header, which Tauri exposes through
/// `Request::headers()` and which costs nothing alongside a raw body.
///
/// A missing or unknown key is **refused**, never guessed. Guessing the first
/// child would write the file into a workspace the draft is not in, and the
/// sentence would then name a path that resolves to nothing — a paste that
/// silently did nothing, which is this feature's worst failure mode.
///
/// The workspace still comes from the bridge rather than from the caller: the
/// key selects among workspaces this layer already owns, and no
/// caller-supplied string ever reaches this path.
#[tauri::command]
pub(crate) fn image_stash(app: AppHandle, request: Request<'_>) -> Result<StashedImage, String> {
    let key = request
        .headers()
        .get("x-tudouni-key")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<ChildKey>().ok())
        .ok_or("this paste did not say which session it belongs to")?;

    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        // A JSON body means the front end sent a string or an array of numbers.
        // Refused rather than decoded: accepting it would silently double the
        // cost of every paste and leave the fast path unused.
        InvokeBody::Json(_) => {
            return Err("a pasted picture must be sent as raw bytes, not as JSON".to_string())
        }
    };

    if bytes.is_empty() {
        return Err("the clipboard held an empty picture".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "the picture is {} bytes, over the {} byte ceiling for one picture",
            bytes.len(),
            MAX_IMAGE_BYTES
        ));
    }

    let known = sniff_image(&bytes).ok_or_else(|| {
        "the clipboard's image data is not a PNG, JPEG or GIF — those are the three \
         formats this program can measure"
            .to_string()
    })?;
    let (extension, mime) = (known.extension, known.mime);

    // Where the picture lands, decided from the child — its working directory
    // and its own slice of the staging area (local), or its remote workspace
    // and the SSH destination (remote). Both are facts this layer already owns,
    // and never from the caller: letting a front end name the directory would
    // be letting it choose where a file is written, and letting it omit one
    // would leave the picture to land in an arbitrary session's workspace.
    enum StashDestination {
        Local { workspace: PathBuf, staging: PathBuf },
        Remote { workspace: String, ssh: RemoteSshConn },
    }
    let destination = {
        let state: State<Bridge> = app.state();
        let guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        let current = guard
            .children
            .get(&key)
            .ok_or("that session's runtime is not running, so there is nowhere to put the picture")?;
        match (current.workspace.clone(), current.staging.clone()) {
            (Some(workspace), Some(staging)) => StashDestination::Local { workspace, staging },
            _ => {
                let (workspace, ssh) = match (current.remote_workspace.clone(), current.remote_ssh.clone()) {
                    (Some(workspace), Some(ssh)) => (workspace, ssh),
                    _ => {
                        return Err(
                            "that session has no workspace to put the picture in".to_string()
                        )
                    }
                };
                StashDestination::Remote { workspace, ssh }
            }
        }
    };

    // The name is generated here, and that is a security property rather than
    // tidiness: the clipboard's own name is attacker-influenced text that can
    // contain a separator or `..`, and it is never used to build this path.
    // Epoch milliseconds keep the names ordered and collision-free in practice;
    // the counter covers two pastes inside the same millisecond.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0);

    // Both doors return the same two facts — the file's own name and the
    // workspace-relative path the sentence carries — so they are settled in
    // one shape and the answer below is written once. The local door writes to
    // disk; the remote door uploads into the same relative staging area on the
    // far host, where the runtime's own `SafePath` resolves it.
    let (name, relative) = match destination {
        StashDestination::Local { workspace, staging } => {
            fs::create_dir_all(&staging)
                .map_err(|e| format!("could not create {}: {e}", staging.display()))?;

            let mut target = staging.join(format!("paste-{stamp}.{extension}"));
            let mut counter = 1;
            while target.exists() {
                target = staging.join(format!("paste-{stamp}-{counter}.{extension}"));
                counter += 1;
            }

            fs::write(&target, &bytes).map_err(|e| format!("could not write {}: {e}", target.display()))?;

            let relative = target
                .strip_prefix(&workspace)
                .map_err(|_| "the picture was written outside the workspace".to_string())?
                .to_string_lossy()
                .replace('\\', "/");

            let name = target
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            (name, relative)
        }
        StashDestination::Remote { workspace, ssh } => {
            // The staging area is the child's own slice, exactly as the local
            // door's: one directory per key, so two remote sessions in the same
            // workspace do not clear each other's in-flight pastes. The far
            // runtime's startup sweep is what empties a finished session's
            // slice — the same storage/staging split the local sweep relies on.
            let base = format!("{PASTE_DIR}/{PASTE_SUBDIR}/{key}");
            let target = ssh.to_target();
            let mut counter = 1;
            loop {
                let candidate = if counter == 1 {
                    format!("{base}/paste-{stamp}.{extension}")
                } else {
                    format!("{base}/paste-{stamp}-{counter}.{extension}")
                };
                match remote_files::upload_if_new(&target, &workspace, &candidate, &bytes) {
                    Ok(()) => {
                        let name = remote_files::last_component(&candidate, "paste");
                        break (name, candidate);
                    }
                    // The name is taken: the next counter. The collision is the
                    // remote twin of the local `target.exists()` loop.
                    Err(remote_files::UploadError::Exists) => counter += 1,
                    Err(remote_files::UploadError::Io(message)) => return Err(message),
                }
            }
        }
    };

    Ok(StashedImage {
        name,
        path: relative,
        mime: mime.to_string(),
        bytes: bytes.len(),
    })
}
