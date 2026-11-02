//! Attaching **files** to a remote session's sentence.
//!
//! The drop and the plus menu's "choose a file" both hand over paths on **this**
//! machine. On a local session a path is the whole story — the runtime's file
//! tools resolve it, and a picture even rides the same channel. On a remote
//! session it is a path the far end has never heard of: the far runtime's
//! `SafePath` refuses it, and the model has no way to reach the bytes. The
//! composer's notice said "the file tools cannot read it directly, the model
//! would go through shell" — a sentence that is simply false there, because the
//! far shell cannot see `C:\Users\me\report.pdf` either.
//!
//! So for a remote child the files are **uploaded into the workspace** and the
//! sentence carries the workspace-relative paths, which is exactly what the
//! pasted picture already does (`image_stash`). This module is that other half.
//!
//! ## One gesture, one call, one connection
//!
//! A drop can carry several files, and that is one act. The command therefore
//! takes the whole list: the SSH connection is dialled once, the staging
//! directory is created once, and every file rides the same SFTP channel — the
//! shape `image_stash` gave the pictures. Dialling per file made three files pay
//! three handshakes.
//!
//! **The answer is one outcome per path, in order, and a failure is that file's
//! own.** A picture paste is all-or-nothing because its frame is validated before
//! a byte is written; files are not, because "this one is a directory" or "that
//! one is over the ceiling" says nothing about the third file. Only a failure that
//! belongs to the whole call (the session is gone, or is not remote) is an `Err`.
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
use std::path::{Path, PathBuf};

use serde::Serialize;
use ssh2::Sftp;
use tauri::{AppHandle, Manager, State};

use crate::bridge::Bridge;
use crate::bridge::ChildKey;
use crate::ssh_backend::SshTarget;

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
///
/// It is a ceiling per file, and files are read one at a time, so a drop of ten
/// files never holds more than one of them in memory.
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

/// What happened to one path of the gesture.
///
/// Exactly one of `file` and `error` is set. `local_path` is echoed back so the
/// caller can match an outcome to the chip it drew without trusting the order
/// alone.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachOutcome {
    local_path: String,
    file: Option<AttachedRemoteFile>,
    error: Option<String>,
}

/// Copy local files into the remote workspace of `key`, and answer with the
/// workspace-relative path of each, in the order they were named.
#[tauri::command]
pub(crate) async fn attach_files_remote(
    app: AppHandle,
    key: ChildKey,
    local_paths: Vec<String>,
) -> Result<Vec<AttachOutcome>, String> {
    // Everything past this point touches a disk — this machine's, or one across
    // the network — so it leaves the main thread before the first syscall. See
    // `image_stash` for the freeze that taught this.
    tauri::async_runtime::spawn_blocking(move || attach_blocking(app, key, local_paths))
        .await
        .map_err(|error| format!("the file upload task failed: {error}"))?
}

/// A local file that passed the checks that need only its metadata.
struct Source {
    path: PathBuf,
    /// The name it will be uploaded under, before any collision counter.
    name: String,
}

fn attach_blocking(
    app: AppHandle,
    key: ChildKey,
    local_paths: Vec<String>,
) -> Result<Vec<AttachOutcome>, String> {
    if local_paths.is_empty() {
        return Ok(Vec::new());
    }

    // The destination, from the bridge — never from the caller. A local child
    // has no `remote_workspace`, and reaching here with one would mean the front
    // end called the wrong door for the session it named. This is the one
    // refusal that belongs to the whole call.
    let (workspace, target) = {
        let state: State<Bridge> = app.state();
        let guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        let current = guard
            .children
            .get(&key)
            .ok_or("that session's runtime is not running, so there is nowhere to put the file")?;
        match (current.remote_workspace.clone(), current.remote_ssh.clone()) {
            (Some(workspace), Some(ssh)) => (workspace, ssh.to_target()),
            _ => {
                return Err(
                    "that session's workspace is local; attach the file the ordinary way"
                        .to_string(),
                )
            }
        }
    };

    // Every refusal that needs only metadata happens here, before the first
    // byte is read or the connection is dialled: a drop of three directories
    // should cost a sentence, not a handshake.
    let checked: Vec<Result<Source, String>> =
        local_paths.iter().map(|path| check_source(path)).collect();
    let mut outcomes: Vec<AttachOutcome> = local_paths
        .iter()
        .zip(&checked)
        .map(|(path, checked)| AttachOutcome {
            local_path: path.clone(),
            file: None,
            error: checked.as_ref().err().cloned(),
        })
        .collect();
    if checked.iter().all(|entry| entry.is_err()) {
        return Ok(outcomes);
    }

    // One directory per child, for the reason the paste's slices are per child:
    // two remote sessions in one workspace must not clear each other's in-flight
    // attachments, and the far runtime's own sweep is per child too.
    let directory = format!(
        "{}/{}/{key}",
        crate::workspace_staging::PASTE_DIR,
        ATTACH_SUBDIR
    );

    // **One connection for the whole gesture**, including every name-collision
    // retry: the upload takes an already-open channel
    // (`remote_files::upload_if_new`), so a collision costs a `stat` instead of
    // a second handshake. If the channel cannot be opened, every file that was
    // fit to send fails with that sentence — the ones already refused keep
    // theirs, which say something truer about them.
    let (_session, sftp) = match open_channel(&target, &workspace, &directory) {
        Ok(channel) => channel,
        Err(message) => {
            for (outcome, entry) in outcomes.iter_mut().zip(&checked) {
                if entry.is_ok() {
                    outcome.error = Some(message.clone());
                }
            }
            return Ok(outcomes);
        }
    };

    for (outcome, entry) in outcomes.iter_mut().zip(&checked) {
        let Ok(source) = entry else { continue };
        match upload_one(&sftp, &workspace, &directory, source) {
            Ok(file) => outcome.file = Some(file),
            Err(message) => outcome.error = Some(message),
        }
    }
    Ok(outcomes)
}

/// The checks that need only the file's metadata. Every sentence is written for
/// a person; the composer shows it verbatim.
fn check_source(local_path: &str) -> Result<Source, String> {
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
    Ok(Source {
        path: source.to_path_buf(),
        name,
    })
}

/// Dial once, make the staging directory once, and open the SFTP channel every
/// upload of the gesture will ride.
///
/// The session is returned beside the channel so the caller can keep it alive
/// for exactly as long as the channel is used.
fn open_channel(
    target: &SshTarget,
    workspace: &str,
    directory: &str,
) -> Result<(ssh2::Session, Sftp), String> {
    let session = crate::ssh_backend::dial_session(target)?;
    let directory_abs = crate::remote_files::resolve_remote_path(workspace, directory)?;
    crate::remote_install::mkdir_remote_recursive(&session, &directory_abs)?;
    let sftp = session
        .sftp()
        .map_err(|e| format!("could not start an SFTP session: {e}"))?;
    Ok((session, sftp))
}

/// Read one file and put it on the open channel, under the first free name.
///
/// Read here rather than up front, so a drop of many large files holds one of
/// them in memory at a time.
fn upload_one(
    sftp: &Sftp,
    workspace: &str,
    directory: &str,
    source: &Source,
) -> Result<AttachedRemoteFile, String> {
    let bytes = fs::read(&source.path)
        .map_err(|e| format!("{} could not be read: {e}", source.path.display()))?;

    // A taken name gets a counter — the paste's name loop, for the same reason:
    // `.stem-1.ext`, never silently replacing what is already there. Files of
    // one gesture are uploaded one after another on this channel, so two files
    // called `report.pdf` see each other's result here.
    let mut counter = 1;
    loop {
        let candidate_name = if counter == 1 {
            source.name.clone()
        } else {
            count_suffix(&source.name, counter)
        };
        let relative = format!("{directory}/{candidate_name}");
        match crate::remote_files::upload_if_new(sftp, workspace, &relative, &bytes) {
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

    #[test]
    fn a_directory_is_refused_with_the_sentence_a_person_reads() {
        let error = check_source(&std::env::temp_dir().to_string_lossy())
            .err()
            .expect("a directory is not a file");
        assert!(error.contains("is a directory"), "{error}");
    }

    #[test]
    fn a_missing_file_is_refused_rather_than_uploaded_empty() {
        let missing = std::env::temp_dir().join("tudouni-attach-test-does-not-exist.bin");
        let error = check_source(&missing.to_string_lossy())
            .err()
            .expect("a missing file cannot be attached");
        assert!(error.contains("could not be read"), "{error}");
    }

    #[test]
    fn an_empty_path_has_no_file_name() {
        let error = check_source("  ").err().expect("nothing was named");
        assert!(error.contains("is not a file name"), "{error}");
    }

    #[test]
    fn a_regular_file_passes_and_keeps_its_own_name() {
        // Unique per process so two test runs on one machine do not collide.
        let path = std::env::temp_dir().join(format!("tudouni-attach-test-{}.txt", std::process::id()));
        fs::write(&path, b"hello").expect("a temp file");

        let checked = check_source(&path.to_string_lossy());
        let _ = fs::remove_file(&path);

        let source = checked.ok().expect("a regular file is attachable");
        assert_eq!(source.name, format!("tudouni-attach-test-{}.txt", std::process::id()));
    }

    #[test]
    fn one_refusal_does_not_decide_the_others() {
        // The property the batch exists for: each path is judged alone.
        let good = std::env::temp_dir().join(format!("tudouni-attach-batch-{}.txt", std::process::id()));
        fs::write(&good, b"x").expect("a temp file");

        let verdicts: Vec<bool> = [
            good.to_string_lossy().to_string(),
            std::env::temp_dir().to_string_lossy().to_string(),
        ]
        .iter()
        .map(|path| check_source(path).is_ok())
        .collect();
        let _ = fs::remove_file(&good);

        assert_eq!(verdicts, vec![true, false]);
    }
}
