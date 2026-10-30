//! Writing a pasted picture into the workspace — locally, or up over SFTP into
//! the remote workspace's own staging area.
//!
//! The destination comes from the child, never from the caller: letting a
//! front end name the directory would be letting it choose where a file is
//! written.
//!
//! **One call carries the whole paste gesture, not one picture.** A person
//! pasting three screenshots makes one gesture, and the front end sends the
//! three pictures in one framed body. The reason is not tidiness: the remote
//! door dials a fresh SSH connection per call (§ `remote_files`), so
//! one-call-per-picture paid the handshake three times for one gesture. The
//! frame is described by `frame_pictures` below and built by `framePictures`
//! in `runtime/paste.ts`; the two must not drift.

use std::fs;
use std::ops::Range;
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

/// The first eight bytes of every pasted-picture body.
///
/// A version tag rather than a bare header: a front end and a shell that
/// disagree about the layout (a stale document after a reload, a hand-written
/// call in a test) then fail with a sentence about the format instead of being
/// parsed into pictures made of header bytes.
const FRAME_MAGIC: &[u8; 8] = b"TUDOIMG1";

/// Where the lengths start: magic, then a `u32` count.
const FRAME_HEADER: usize = 12;

/// How many pictures one gesture may carry.
///
/// Mirrors `MAX_IMAGES_PER_MESSAGE` in `runtime/paste.ts`, which is itself the
/// front end's share of the runtime's `content.MaxImagesPerMessage`. This is a
/// ceiling on one body rather than on one message: the runtime still counts
/// every path the finished sentence names.
const MAX_PICTURES_PER_PASTE: usize = 10;

/// One picture of a paste gesture, after the frame around it has been checked.
struct Picture {
    /// The slice of the request body this picture occupies. Kept as a range
    /// rather than a copy: the body is one allocation, and a copy per picture
    /// would double the memory a five-megabyte paste already costs.
    range: Range<usize>,
    extension: &'static str,
    mime: &'static str,
}

/// Split a framed body into its pictures, refusing anything malformed **before**
/// a byte is written.
///
/// The layout, little-endian, mirrored by `framePictures` in `runtime/paste.ts`:
///
/// ```text
///  0   8   "TUDOIMG1"
///  8   4   count
/// 12  4×n  each picture's length, in order
/// 12+4n    the pictures' bytes, back to back
/// ```
///
/// The whole frame is validated here — magic, count, every length, every
/// picture's ceiling and format — so a paste either writes every picture or
/// none. That is the same promise the front end makes when it draws the chips:
/// a chip that ships nothing is this feature's worst failure mode, and a
/// half-written batch would be exactly that for the tail of the gesture.
fn frame_pictures(body: &[u8]) -> Result<Vec<Picture>, String> {
    if body.len() < FRAME_HEADER || &body[..8] != FRAME_MAGIC {
        return Err("this paste was not in the picture frame this program sends".to_string());
    }
    let count = u32::from_le_bytes([body[8], body[9], body[10], body[11]]) as usize;
    if count == 0 {
        return Err("the clipboard held no pictures".to_string());
    }
    if count > MAX_PICTURES_PER_PASTE {
        return Err(format!(
            "this paste carried {count} pictures, over the {MAX_PICTURES_PER_PASTE} one gesture may carry"
        ));
    }
    // `count` is already capped, so this cannot overflow on any target this
    // ships for; the checked arithmetic below still says what it means.
    let body_start = FRAME_HEADER
        .checked_add(count * 4)
        .ok_or("this paste's header is larger than the message")?;
    if body.len() < body_start {
        return Err("this paste's header is shorter than the pictures it announces".to_string());
    }

    let mut pictures = Vec::with_capacity(count);
    let mut cursor = body_start;
    for index in 0..count {
        let at = FRAME_HEADER + index * 4;
        let length = u32::from_le_bytes([body[at], body[at + 1], body[at + 2], body[at + 3]]) as usize;
        if length == 0 {
            return Err("the clipboard held an empty picture".to_string());
        }
        if length > MAX_IMAGE_BYTES {
            return Err(format!(
                "the picture is {length} bytes, over the {MAX_IMAGE_BYTES} byte ceiling for one picture"
            ));
        }
        let end = cursor
            .checked_add(length)
            .ok_or("this paste's pictures are larger than the message")?;
        if end > body.len() {
            return Err("this paste's pictures are shorter than the lengths it announces".to_string());
        }

        let known = sniff_image(&body[cursor..end]).ok_or_else(|| {
            "the clipboard's image data is not a PNG, JPEG or GIF — those are the three \
             formats this program can measure"
                .to_string()
        })?;
        pictures.push(Picture {
            range: cursor..end,
            extension: known.extension,
            mime: known.mime,
        });
        cursor = end;
    }

    Ok(pictures)
}

/// Write a paste's pictures into the workspace and hand back their paths.
///
/// ## Why this command exists at all
///
/// The runtime's only way to receive a picture is a **path in the user's
/// sentence** (`internal/runtime/images.go`: there is no upload command and no
/// markup). A drop already has an absolute path from the OS; a paste does not,
/// because the clipboard carries bytes and a WebView has no filesystem. So the
/// bytes come here, become files **inside the workspace**, and the front end
/// writes the returned paths into the sentence. That is the whole feature.
///
/// ## Why the raw body
///
/// `InvokeBody::Raw`, not a JSON string. Five megabytes as base64 is 6.7MB of
/// text; as a JSON number array it is over 20MB. Tauri supports a raw body on
/// every platform this ships for (windows/amd64, linux/amd64), and the front end
/// passes a `Uint8Array` directly. Several pictures ride the same raw body in
/// the frame `frame_pictures` documents — there is still no base64 anywhere.
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
///
/// ## Why `async`, and why that is a fix rather than a style
///
/// A synchronous `#[tauri::command]` body runs on the **main thread** — the one
/// that pumps the window's event loop — so everything below used to happen with
/// the window unable to repaint or handle input. On a local session that is one
/// `fs::write` and nobody noticed. On a **remote** session it is an SSH
/// handshake, the staging directories, and up to five megabytes over SFTP: the
/// application looked hung for the whole upload, and pasting a screenshot is a
/// gesture people make while still typing.
///
/// So the I/O moves to `spawn_blocking`, exactly as every other remote door in
/// this crate does it (`attach_file_remote`, `deliverable_download`,
/// `inline_image_remote`, `install_remote_runtime`). The refusals stay on this
/// side of the hop: they are a header lookup and a sniff of eight bytes per
/// picture, and a sentence about a paste should not need a task boundary to be
/// written.
#[tauri::command]
pub(crate) async fn image_stash(app: AppHandle, request: Request<'_>) -> Result<Vec<StashedImage>, String> {
    let key = request
        .headers()
        .get("x-tudouni-key")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<ChildKey>().ok())
        .ok_or("this paste did not say which session it belongs to")?;

    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        // A JSON body means the front end sent a string or an array of numbers.
        // Refused rather than decoded: accepting it would silently double the
        // cost of every paste and leave the fast path unused.
        InvokeBody::Json(_) => {
            return Err("a pasted picture must be sent as raw bytes, not as JSON".to_string())
        }
    };

    // Every refusal — the frame, the ceilings, the formats — happens here, while
    // the whole body is still in hand and nothing has been written.
    let pictures = frame_pictures(&body)?;

    // Everything past this point touches a disk — this machine's, or one across
    // the network — so it leaves the main thread before the first syscall.
    tauri::async_runtime::spawn_blocking(move || stash_blocking(app, key, body, pictures))
        .await
        .map_err(|error| format!("the picture could not be written: {error}"))?
}

/// The write itself, off the main thread: decide the destination from the child,
/// put every picture of the gesture there, and answer with the paths the
/// sentence will carry.
fn stash_blocking(
    app: AppHandle,
    key: ChildKey,
    body: Vec<u8>,
    pictures: Vec<Picture>,
) -> Result<Vec<StashedImage>, String> {
    // Where the pictures land, decided from the child — its working directory
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
    // the counter covers two pictures inside the same millisecond.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0);

    // Both doors report the same facts — the file's own name and the
    // workspace-relative path the sentence carries — so they are settled in
    // one shape and the answer is written once. The local door writes to
    // disk; the remote door uploads into the same relative staging area on the
    // far host, where the runtime's own `SafePath` resolves it.
    //
    // **One connection for the whole gesture.** The remote door used to dial per
    // picture (the upload used to be a command of its own); a paste of three
    // screenshots therefore paid three handshakes. The channel is opened once
    // here and every picture rides it.
    let mut written = Vec::with_capacity(pictures.len());
    match destination {
        StashDestination::Local { workspace, staging } => {
            fs::create_dir_all(&staging)
                .map_err(|e| format!("could not create {}: {e}", staging.display()))?;

            for picture in &pictures {
                let bytes = &body[picture.range.clone()];
                let mut target = staging.join(format!("paste-{stamp}.{}", picture.extension));
                let mut counter = 1;
                while target.exists() {
                    target = staging.join(format!("paste-{stamp}-{counter}.{}", picture.extension));
                    counter += 1;
                }

                fs::write(&target, bytes)
                    .map_err(|e| format!("could not write {}: {e}", target.display()))?;

                let relative = target
                    .strip_prefix(&workspace)
                    .map_err(|_| "the picture was written outside the workspace".to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                let name = target
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default();
                written.push(StashedImage {
                    path: relative,
                    name,
                    mime: picture.mime.to_string(),
                    bytes: bytes.len(),
                });
            }
        }
        StashDestination::Remote { workspace, ssh } => {
            // The staging area is the child's own slice, exactly as the local
            // door's: one directory per key, so two remote sessions in the same
            // workspace do not clear each other's in-flight pastes. The far
            // runtime's startup sweep is what empties a finished session's
            // slice — the same storage/staging split the local sweep relies on.
            //
            // Created **once** for the gesture, then reused by every upload:
            // the directory is the same for all of them, and a `mkdir` per
            // picture would be one round trip per picture for nothing.
            let base = format!("{PASTE_DIR}/{PASTE_SUBDIR}/{key}");
            let target = ssh.to_target();
            let session = crate::ssh_backend::dial_session(&target)?;
            let base_abs = remote_files::resolve_remote_path(&workspace, &base)?;
            crate::remote_install::mkdir_remote_recursive(&session, &base_abs)?;
            let sftp = session
                .sftp()
                .map_err(|e| format!("could not start an SFTP session: {e}"))?;

            for picture in &pictures {
                let bytes = &body[picture.range.clone()];
                let mut counter = 1;
                loop {
                    let candidate = if counter == 1 {
                        format!("{base}/paste-{stamp}.{}", picture.extension)
                    } else {
                        format!("{base}/paste-{stamp}-{counter}.{}", picture.extension)
                    };
                    match remote_files::upload_if_new(&sftp, &workspace, &candidate, bytes) {
                        Ok(()) => {
                            let name = remote_files::last_component(&candidate, "paste");
                            written.push(StashedImage {
                                path: candidate,
                                name,
                                mime: picture.mime.to_string(),
                                bytes: bytes.len(),
                            });
                            break;
                        }
                        // The name is taken: the next counter. The collision is
                        // the remote twin of the local `target.exists()` loop.
                        Err(remote_files::UploadError::Exists) => counter += 1,
                        Err(remote_files::UploadError::Io(message)) => return Err(message),
                    }
                }
            }
        }
    }

    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A PNG's signature, which is all `sniff_image` needs.
    const PNG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

    /// The frame `framePictures` in `runtime/paste.ts` builds, written out here
    /// independently: this is the one place the two implementations are held
    /// against a literal, so a change on either side shows up as a failure
    /// rather than as a paste that arrives empty.
    fn frame(pictures: &[&[u8]]) -> Vec<u8> {
        let header = FRAME_HEADER + pictures.len() * 4;
        let mut body = Vec::with_capacity(header);
        body.extend_from_slice(FRAME_MAGIC);
        body.extend_from_slice(&(pictures.len() as u32).to_le_bytes());
        for picture in pictures {
            body.extend_from_slice(&(picture.len() as u32).to_le_bytes());
        }
        for picture in pictures {
            body.extend_from_slice(picture);
        }
        body
    }

    #[test]
    fn a_frame_of_two_pictures_round_trips_in_order() {
        let first = [PNG.as_slice(), &[7, 7]].concat();
        let second = [PNG.as_slice(), &[9]].concat();
        let body = frame(&[&first, &second]);

        let pictures = frame_pictures(&body).expect("a well-formed frame");

        assert_eq!(pictures.len(), 2);
        assert_eq!(&body[pictures[0].range.clone()], first.as_slice());
        assert_eq!(&body[pictures[1].range.clone()], second.as_slice());
        assert_eq!(pictures[0].extension, "png");
        assert_eq!(pictures[0].mime, "image/png");
    }

    #[test]
    fn a_body_that_is_not_a_frame_is_refused_rather_than_guessed_at() {
        // A bare picture — what the single-picture protocol used to send. Refused
        // by name: silently accepting it would be two layouts to keep in step.
        let bare = PNG.as_slice();
        assert!(frame_pictures(bare).is_err());
    }

    #[test]
    fn a_length_that_reaches_past_the_body_is_refused() {
        let mut body = frame(&[PNG.as_slice()]);
        // Announce one byte more than the frame actually carries.
        body[FRAME_HEADER..FRAME_HEADER + 4].copy_from_slice(&((PNG.len() + 1) as u32).to_le_bytes());

        assert!(frame_pictures(&body).is_err());
    }

    #[test]
    fn a_picture_that_is_not_png_jpeg_or_gif_is_refused() {
        let not_a_picture = [0u8, 1, 2, 3, 4, 5, 6, 7];
        assert!(frame_pictures(&frame(&[&not_a_picture])).is_err());
    }

    #[test]
    fn an_empty_gesture_is_refused() {
        assert!(frame_pictures(&frame(&[])).is_err());
    }
}
