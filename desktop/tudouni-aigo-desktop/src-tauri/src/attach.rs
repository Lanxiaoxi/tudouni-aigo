//! Attaching a **file** to a remote session's sentence.
//!
//! The drop and the plus menu's "choose a file" both hand over a path on **this**
//! machine. On a local session that path is the whole story — the runtime's file
//! tools resolve it, and a picture even rides the same channel. On a remote
//! session it is a path the far end has never heard of: the far runtime's
//! `SafePath` refuses it, and the model has no way to reach the bytes. The
//! composer's notice said "the file tools cannot read it directly, the model
//! would go through shell" — a sentence that is simply false there, because the
//! far shell cannot see `C:\Users\me\report.pdf` either.
//!
//! So for a remote child the file is **uploaded into the workspace** and the
//! sentence carries the workspace-relative path, which is exactly what the pasted
//! picture already does (`image_stash`). This module is that other half.
//!
//! ## Why the child key, and not an SSH target
//!
//! The destination comes from the bridge's child — its `remote_workspace` and
//! `remote_ssh` — never from the caller. Letting a front end name the
//! destination would let it upload into a machine the session does not run on,
//! and would additionally require it to hold credentials, which is precisely what
//! `remoteConnectionOf` (the layer that builds display facts) does not carry. The
//! key selects among workspaces this process already owns; no caller-supplied
//! string ever reaches the path.
//!
//! ## Where it lands
//!
//! `.tudouni/attach/<key>/<name>`, under the remote workspace: inside the
//! boundary `SafePath` enforces (a file outside it could be named in the sentence
//! and could never be attached), and in the same per-child staging area the
//! paste uses, so the far runtime's own sweep and this program's local sweep treat
//! it the same way. A name already taken gets a counter, exactly as the paste's
//! name loop does — dropping two files called `report.pdf` must not silently
//! replace the first.
//!
//! ## What it refuses
//!
//! A directory (there is nothing to upload), a file over `MAX_ATTACH_BYTES`, and
//! anything that is not a regular file. Each sentence is written for a person and
//! is shown where the composer's notice goes.

use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::bridge::Bridge;
use crate::bridge::ChildKey;

/// The subdirectory one file attach lands in, beside `paste`.
pub(crate) const ATTACH_SUBDIR: &str = "attach";

/// The ceiling on one attached file.
///
/// Deliberate rather than "whatever the disk allows": the whole file is read into
/// memory and then pushed over one SFTP session, and a multi-gigabyte artifact is
/// not something to put in a chat sentence. The number matches the deliverable
/// download's ceiling for the opposite direction — a file a person is plausibly
/// *sending* is of the same order as one they are receiving, and having two
/// different round numbers for the same kind of thing would be a choice nobody
/// could defend.
pub(crate) const MAX_ATTACH_BYTES: u64 = 64 * 1024 * 1024;

/// One file uploaded into a remote workspace, as the composer needs it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachedRemoteFile {
    /// The **workspace-relative** path, forward slashes — what the sentence
    /// carries, and what the far `SafePath` resolves against the child's working
    /// directory.
    path: String,
    /// The file's own name, for the tray's chip.
    name: String,
    /// How many bytes went over. Shown when it is large enough to be worth
    /// knowing; the tray uses it for the tooltip.
    bytes: usize,
}

/// Copy one local file into the remote workspace of `key`, and answer with the
/// workspace-relative path to put in the sentence.
#[tauri::command]
pub(crate) async fn attach_file_remote(
    app: AppHandle,
    key: ChildKey,
    local_path: String,
) -> Result<AttachedRemoteFile, String> {
    tauri::async_runtime::spawn_blocking(move || attach_blocking(app, key, local_path))
        .await
        .map_err(|error| format!("the file upload task failed: {error}"))?
}

fn attach_blocking(
    app: AppHandle,
    key: ChildKey,
    local_path: String,
) -> Result<AttachedRemoteFile, String> {
    let source = Path::new(local_path.trim());
    let name = source
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("{} is not a file name", local_path.trim()))?;

    let metadata = fs::metadata(source)
        .map_err(|e| format!("{} could not be read: {e}", source.display()))?;
    if metadata.is_dir() {
        return Err(format!(
            "{} is a directory — attach a file, or put it in the workspace first",
            source.display()
        ));
    }
    if !metadata.is_file() {
        return Err(format!("{} is not a regular file", source.display()));
    }
    if metadata.len() > MAX_ATTACH_BYTES {
        return Err(format!(
            "{} is {} bytes, over the {} byte ceiling for one attached file \
             — put it in the workspace with another tool instead",
            source.display(),
            metadata.len(),
            MAX_ATTACH_BYTES
        ));
    }

    let bytes = fs::read(source)
        .map_err(|e| format!("{} could not be read: {e}", source.display()))?;

    // The destination, from the bridge — never from the caller. A local child
    // has no `remote_workspace`, and reaching here with one would mean the front
    // end called the wrong door for the session it named.
    let (workspace, ssh) = {
        let state: State<Bridge> = app.state();
        let guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        let current = guard
            .children
            .get(&key)
            .ok_or("that session's runtime is not running, so there is nowhere to put the file")?;
        match (current.remote_workspace.clone(), current.remote_ssh.clone()) {
            (Some(workspace), Some(ssh)) => (workspace, ssh),
            _ => {
                return Err(
                    "that session's workspace is local; attach the file the ordinary way"
                        .to_string(),
                )
            }
        }
    };

    let target = ssh.to_target();
    // One directory per child, for the reason the paste's slices are per child:
    // two remote sessions in one workspace must not clear each other's in-flight
    // attachments, and the far runtime's own sweep is per child too.
    let base = format!(
        "{}/{}",
        crate::workspace_staging::PASTE_DIR,
        ATTACH_SUBDIR
    );
    let directory = format!("{base}/{key}");
    // **One connection for the whole name loop**, including a retry: the
    // upload takes an already-open channel (`remote_files::upload_if_new`), so a
    // collision costs a `stat` instead of a second handshake.
    let session = crate::ssh_backend::dial_session(&target)?;
    let directory_abs = crate::remote_files::resolve_remote_path(&workspace, &directory)?;
    crate::remote_install::mkdir_remote_recursive(&session, &directory_abs)?;
    let sftp = session
        .sftp()
        .map_err(|e| format!("could not start an SFTP session: {e}"))?;
    // A taken name gets a counter — the paste's name loop, for the same reason:
    // `.stem-1.ext`, never silently replacing what is already there.
    let mut counter = 1;
    loop {
        let candidate_name = if counter == 1 {
            name.clone()
        } else {
            count_suffix(&name, counter)
        };
        let relative = format!("{directory}/{candidate_name}");
        match crate::remote_files::upload_if_new(&sftp, &workspace, &relative, &bytes) {
            Ok(()) => {
                return Ok(AttachedRemoteFile {
                    path: relative,
                    name: candidate_name,
                    bytes: bytes.len(),
                })
            }
            // The remote twin of the local `target.exists()` loop.
            Err(crate::remote_files::UploadError::Exists) => counter += 1,
            Err(crate::remote_files::UploadError::Io(message)) => return Err(message),
        }
    }
}

/// `report.pdf` + 2 → `report-2.pdf`. The extension is kept last so the far
/// runtime's scanner still recognizes the file's kind by name.
fn count_suffix(name: &str, counter: usize) -> String {
    match name.rfind('.') {
        // A leading dot is a hidden file, not an extension: `.env` + 2 is
        // `.env-2`, never `-2.env`.
        Some(at) if at > 0 => format!("{}-{}{}", &name[..at], counter, &name[at..]),
        _ => format!("{name}-{counter}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_file_with_the_same_name_gets_a_counter() {
        assert_eq!(count_suffix("report.pdf", 2), "report-2.pdf");
        assert_eq!(count_suffix("report.pdf", 10), "report-10.pdf");
    }

    #[test]
    fn an_extension_less_name_still_gets_one() {
        assert_eq!(count_suffix("Makefile", 2), "Makefile-2");
    }

    #[test]
    fn a_hidden_file_keeps_its_dot_first() {
        // `.env` is a name, not an empty stem and an extension. Writing
        // `-2.env` would produce a visible file that no longer looks hidden.
        assert_eq!(count_suffix(".env", 2), ".env-2");
    }

    #[test]
    fn a_name_that_is_only_an_extension_is_handled() {
        // `..pdf` is odd but legal on POSIX; the split is at the last dot and
        // the stem is not empty, so the ordinary rule applies.
        assert_eq!(count_suffix("a..pdf", 2), "a.-2.pdf");
    }
}
