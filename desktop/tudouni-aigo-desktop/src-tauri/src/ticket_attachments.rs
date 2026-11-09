//! Files attached to a Ticket — the debug log, the crash dump, the spec.
//!
//! ## Two copies, one authority
//!
//! A Ticket outlives every session it is worked in (`docs/design/ticket.md`), so
//! its attachments cannot live in a session's paste/attach staging area: those
//! directories are swept by `sweep_staging` / `sweep_remote_paste` the next time a
//! session starts, which is exactly when a Ticket is started over or continued.
//!
//! ```text
//! ~/.tudouni/tickets/attachments/<ticketId>/<name>                 the authority
//! <workspace>/.tudouni/ticket-attachments/<ticketId>/<name>        a staged copy
//! ```
//!
//! The authority is a **copy** of what the person picked, taken at attach time:
//! a log that is rotated or deleted afterwards must not leave a Ticket pointing at
//! nothing. Each Start (and each replacement session) stages the copies into the
//! session's workspace — locally with a file copy, remotely over SFTP — and the
//! runtime is told the workspace-relative paths through `ticket_bind` (protocol
//! 19), so the agent can `read_file` them inside `SafePath`.
//!
//! The staged directory is **not** a sweep target: a resumed session reads the
//! same paths back from its metadata, and they must still resolve. It is
//! overwritten on the next stage, and it lives under `.tudouni/`, which is the
//! workspace's own ignored state directory.
//!
//! ## What the caller may name
//!
//! A Ticket id and attachment names, both validated as single path components
//! before any path is built. The destination workspace comes from the bridge's
//! child (by key), never from the caller — the same rule `attach` and
//! `image_stash` follow.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::attach::MAX_ATTACH_BYTES;
use crate::bridge::{Bridge, ChildKey};

const ATTACHMENTS_DIR: &str = "attachments";

/// Where staged copies land, under the session's workspace. Mirrored by
/// `TICKET_STAGE_DIR` in `src/ticket/attachments.ts`.
const STAGE_DIR: &str = ".tudouni/ticket-attachments";

/// How many files one Ticket may carry. Mirrors the runtime's ceiling on
/// `ticket_bind.ticket.attachments` (a bind with more is refused whole).
pub(crate) const MAX_ATTACHMENTS_PER_TICKET: usize = 50;

/// One attachment as the record stores it.
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredAttachment {
    name: String,
    bytes: u64,
}

/// What happened to one picked path.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportOutcome {
    local_path: String,
    attachment: Option<StoredAttachment>,
    error: Option<String>,
}

/// One attachment staged into a session's workspace.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StagedAttachment {
    name: String,
    /// Workspace-relative, forward slashes: what `ticket_bind` carries.
    path: String,
    bytes: u64,
}

/* ============================================================
   Validation
   ============================================================ */

/// A Ticket id is minted by the desktop as `tk-<time36>-<rand>`. Only that
/// alphabet is accepted, so the id is always one harmless path component.
fn check_ticket_id(id: &str) -> Result<(), String> {
    let ok = id.starts_with("tk-")
        && id.len() <= 64
        && id
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-');
    if ok {
        Ok(())
    } else {
        Err(format!("{id:?} is not a Ticket id"))
    }
}

/// An attachment name is one path component: no separator, no `..`, not a
/// dot-file (which is how a half-written temp is marked), not empty.
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 255 {
        return Err("the attachment name is empty or too long".to_string());
    }
    if name.contains(['/', '\\', '\0']) || name == "." || name == ".." || name.starts_with('.') {
        return Err(format!("{name:?} is not a usable attachment name"));
    }
    Ok(())
}

/// The name a picked file is stored under: its own name with the characters a
/// Windows or Linux file system would refuse folded away, and a leading dot
/// dropped so the file is never mistaken for a temp.
fn storable_name(local: &Path) -> Result<String, String> {
    let raw = local
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let folded = crate::remote_files::sanitize_component(&raw);
    let trimmed = folded.trim_start_matches('.').trim().to_string();
    if trimmed.is_empty() {
        return Err(format!("{} has no usable file name", local.display()));
    }
    check_name(&trimmed)?;
    Ok(trimmed)
}

/// `report.log` + 2 → `report-2.log`; a hidden-looking name never gets here.
fn count_suffix(name: &str, counter: usize) -> String {
    match name.rfind('.') {
        Some(at) if at > 0 => format!("{}-{}{}", &name[..at], counter, &name[at..]),
        _ => format!("{name}-{counter}"),
    }
}

/* ============================================================
   The authority: ~/.tudouni/tickets/attachments/<id>/
   ============================================================ */

fn ticket_dir_under(root: &Path, ticket_id: &str) -> Result<PathBuf, String> {
    check_ticket_id(ticket_id)?;
    Ok(root.join(ATTACHMENTS_DIR).join(ticket_id))
}

fn ticket_dir(ticket_id: &str) -> Result<PathBuf, String> {
    ticket_dir_under(&crate::tickets_data::tickets_dir()?, ticket_id)
}

/// Copy one picked file into the Ticket's directory under the first free name.
fn import_one(dir: &Path, local_path: &str) -> Result<StoredAttachment, String> {
    let source = Path::new(local_path.trim());
    let metadata =
        fs::metadata(source).map_err(|e| format!("{} could not be read: {e}", source.display()))?;
    if metadata.is_dir() {
        return Err(format!("{} is a directory — attach a file", source.display()));
    }
    if !metadata.is_file() {
        return Err(format!("{} is not a regular file", source.display()));
    }
    if metadata.len() > MAX_ATTACH_BYTES {
        return Err(format!(
            "{} is {} bytes, over the {} byte ceiling for one attachment — attach the relevant part instead",
            source.display(),
            metadata.len(),
            MAX_ATTACH_BYTES
        ));
    }
    let name = storable_name(source)?;
    fs::create_dir_all(dir).map_err(|e| format!("{} could not be created: {e}", dir.display()))?;

    let mut counter = 1;
    let target = loop {
        let candidate = if counter == 1 { name.clone() } else { count_suffix(&name, counter) };
        let path = dir.join(&candidate);
        if !path.exists() {
            break (candidate, path);
        }
        counter += 1;
    };
    // Copied to a dot-temp first, then renamed: a crash mid-copy must not leave
    // a truncated log that looks like the real one.
    let tmp = dir.join(format!(".{}.{}.tmp", target.0, std::process::id()));
    let copied = fs::copy(source, &tmp).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{} could not be copied: {e}", source.display())
    })?;
    fs::rename(&tmp, &target.1).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{} could not be stored: {e}", target.1.display())
    })?;
    Ok(StoredAttachment { name: target.0, bytes: copied })
}

fn import_into(dir: &Path, existing: usize, local_paths: &[String]) -> Vec<ImportOutcome> {
    let mut room = MAX_ATTACHMENTS_PER_TICKET.saturating_sub(existing);
    local_paths
        .iter()
        .map(|path| {
            if room == 0 {
                return ImportOutcome {
                    local_path: path.clone(),
                    attachment: None,
                    error: Some(format!(
                        "a Ticket carries at most {MAX_ATTACHMENTS_PER_TICKET} attachments"
                    )),
                };
            }
            match import_one(dir, path) {
                Ok(attachment) => {
                    room -= 1;
                    ImportOutcome { local_path: path.clone(), attachment: Some(attachment), error: None }
                }
                Err(error) => ImportOutcome { local_path: path.clone(), attachment: None, error: Some(error) },
            }
        })
        .collect()
}

/// Copy picked files into a Ticket's attachment directory. One outcome per path,
/// in order; a failure is that file's own. `existing` is how many the Ticket
/// already carries, so the per-Ticket ceiling holds across several gestures.
#[tauri::command]
pub(crate) async fn ticket_attachment_import(
    ticket_id: String,
    local_paths: Vec<String>,
    existing: usize,
) -> Result<Vec<ImportOutcome>, String> {
    let dir = ticket_dir(&ticket_id)?;
    tauri::async_runtime::spawn_blocking(move || import_into(&dir, existing, &local_paths))
        .await
        .map_err(|e| format!("the attachment copy failed: {e}"))
}

/// Remove one stored attachment. A file already gone is not an error.
#[tauri::command]
pub(crate) fn ticket_attachment_remove(ticket_id: String, name: String) -> Result<(), String> {
    check_name(&name)?;
    let path = ticket_dir(&ticket_id)?.join(&name);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{} could not be removed: {e}", path.display())),
    }
}

/// Remove a Ticket's whole attachment directory — the Ticket itself is gone.
#[tauri::command]
pub(crate) fn ticket_attachments_purge(ticket_id: String) -> Result<(), String> {
    let dir = ticket_dir(&ticket_id)?;
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{} could not be removed: {e}", dir.display())),
    }
}

/// Open one stored attachment in the OS default application.
#[tauri::command]
pub(crate) fn ticket_attachment_open(ticket_id: String, name: String) -> Result<(), String> {
    check_name(&name)?;
    let path = ticket_dir(&ticket_id)?.join(&name);
    if !path.is_file() {
        return Err(format!("{name} is not there any more"));
    }
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|e| format!("the system could not open it: {e}"))
}

/* ============================================================
   Staging into a session's workspace
   ============================================================ */

fn stage_local(
    authority: &Path,
    workspace: &Path,
    ticket_id: &str,
    names: &[String],
) -> Result<Vec<StagedAttachment>, String> {
    let relative_dir = format!("{STAGE_DIR}/{ticket_id}");
    let dest = workspace.join(&relative_dir);
    fs::create_dir_all(&dest).map_err(|e| format!("{} could not be created: {e}", dest.display()))?;
    let mut staged = Vec::with_capacity(names.len());
    for name in names {
        let from = authority.join(name);
        let to = dest.join(name);
        let bytes = fs::copy(&from, &to)
            .map_err(|e| format!("{name} could not be copied into the workspace: {e}"))?;
        staged.push(StagedAttachment { name: name.clone(), path: format!("{relative_dir}/{name}"), bytes });
    }
    Ok(staged)
}

fn stage_remote(
    authority: &Path,
    workspace: &str,
    target: &crate::ssh_backend::SshTarget,
    ticket_id: &str,
    names: &[String],
) -> Result<Vec<StagedAttachment>, String> {
    let relative_dir = format!("{STAGE_DIR}/{ticket_id}");
    let session = crate::ssh_backend::dial_session(target)?;
    let dir_abs = crate::remote_files::resolve_remote_path(workspace, &relative_dir)?;
    crate::remote_install::mkdir_remote_recursive(&session, &dir_abs)?;
    let sftp = session.sftp().map_err(|e| format!("could not start an SFTP session: {e}"))?;
    let mut staged = Vec::with_capacity(names.len());
    for name in names {
        // One file in memory at a time; each is under the attach ceiling.
        let bytes = fs::read(authority.join(name)).map_err(|e| format!("{name} could not be read: {e}"))?;
        let relative = format!("{relative_dir}/{name}");
        let remote = crate::remote_files::resolve_remote_path(workspace, &relative)?;
        // Overwritten on purpose: the same Ticket staging the same name again is
        // the same file, and a fresh copy is what a restarted run should read.
        let mut file = sftp
            .create(Path::new(&remote))
            .map_err(|e| format!("could not create {relative} on the remote host: {e}"))?;
        file.write_all(&bytes)
            .map_err(|e| format!("could not write {relative} to the remote host: {e}"))?;
        staged.push(StagedAttachment { name: name.clone(), path: relative, bytes: bytes.len() as u64 });
    }
    Ok(staged)
}

/// Copy a Ticket's attachments into the workspace of session `key`, and answer
/// with the workspace-relative paths the bind will carry. All or nothing: a
/// Ticket started with half its evidence would mislead the agent, so any
/// failure is an `Err` the caller reports and binds without.
#[tauri::command]
pub(crate) async fn ticket_attachments_stage(
    app: AppHandle,
    key: ChildKey,
    ticket_id: String,
    names: Vec<String>,
) -> Result<Vec<StagedAttachment>, String> {
    let authority = ticket_dir(&ticket_id)?;
    for name in &names {
        check_name(name)?;
    }
    if names.is_empty() {
        return Ok(Vec::new());
    }
    enum Dest {
        Local(PathBuf),
        Remote(String, crate::ssh_backend::SshTarget),
    }
    let dest = {
        let state: State<Bridge> = app.state();
        let guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        let child = guard
            .children
            .get(&key)
            .ok_or("that session's runtime is not running, so there is nowhere to put the attachments")?;
        match (&child.workspace, &child.remote_workspace, &child.remote_ssh) {
            (Some(workspace), _, _) => Dest::Local(workspace.clone()),
            (None, Some(workspace), Some(ssh)) => Dest::Remote(workspace.clone(), ssh.to_target()),
            _ => return Err("that session has no workspace to put the attachments in".to_string()),
        }
    };
    tauri::async_runtime::spawn_blocking(move || match dest {
        Dest::Local(workspace) => stage_local(&authority, &workspace, &ticket_id, &names),
        Dest::Remote(workspace, target) => stage_remote(&authority, &workspace, &target, &ticket_id, &names),
    })
    .await
    .map_err(|e| format!("the attachment staging failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("tudouni-tkatt-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn ticket_ids_are_one_harmless_component() {
        assert!(check_ticket_id("tk-mabc12-x9y8z7").is_ok());
        assert!(check_ticket_id("../etc").is_err());
        assert!(check_ticket_id("tk-a/b").is_err());
        assert!(check_ticket_id("tk-A").is_err());
        assert!(check_ticket_id("abc").is_err());
    }

    #[test]
    fn names_with_separators_or_dots_are_refused() {
        assert!(check_name("server.log").is_ok());
        for bad in ["", "a/b", "a\\b", "..", ".env", "x\0"] {
            assert!(check_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn import_copies_the_bytes_and_numbers_a_taken_name() {
        let s = Scratch::new("import");
        let src = s.0.join("server.log");
        fs::write(&src, b"line 1\nline 2\n").unwrap();
        let dir = s.0.join("store");
        let paths = vec![src.to_string_lossy().to_string(), src.to_string_lossy().to_string()];
        let out = import_into(&dir, 0, &paths);
        let names: Vec<String> = out.iter().map(|o| o.attachment.as_ref().unwrap().name.clone()).collect();
        assert_eq!(names, vec!["server.log".to_string(), "server-2.log".to_string()]);
        assert_eq!(fs::read(dir.join("server-2.log")).unwrap(), b"line 1\nline 2\n");
        assert_eq!(out[0].attachment.as_ref().unwrap().bytes, 14);
        // No temp file left behind.
        let leftovers = fs::read_dir(&dir)
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn a_directory_and_a_missing_file_fail_alone() {
        let s = Scratch::new("mixed");
        let good = s.0.join("a.txt");
        fs::write(&good, b"x").unwrap();
        let paths = vec![
            s.0.to_string_lossy().to_string(),
            s.0.join("missing.txt").to_string_lossy().to_string(),
            good.to_string_lossy().to_string(),
        ];
        let out = import_into(&s.0.join("store"), 0, &paths);
        assert!(out[0].error.as_ref().unwrap().contains("directory"));
        assert!(out[1].error.is_some());
        assert!(out[2].attachment.is_some());
    }

    #[test]
    fn the_per_ticket_ceiling_holds_across_gestures() {
        let s = Scratch::new("ceiling");
        let src = s.0.join("a.txt");
        fs::write(&src, b"x").unwrap();
        let p = src.to_string_lossy().to_string();
        let out = import_into(&s.0.join("store"), MAX_ATTACHMENTS_PER_TICKET - 1, &[p.clone(), p]);
        assert!(out[0].attachment.is_some());
        assert!(out[1].error.as_ref().unwrap().contains("at most"));
    }

    #[test]
    fn a_hidden_looking_name_is_stored_visibly() {
        let s = Scratch::new("hidden");
        let src = s.0.join(".env");
        fs::write(&src, b"K=V").unwrap();
        let out = import_into(&s.0.join("store"), 0, &[src.to_string_lossy().to_string()]);
        assert_eq!(out[0].attachment.as_ref().unwrap().name, "env");
    }

    #[test]
    fn local_staging_writes_under_the_workspace_and_answers_relative_paths() {
        let s = Scratch::new("stage");
        let authority = s.0.join("auth");
        fs::create_dir_all(&authority).unwrap();
        fs::write(authority.join("server.log"), b"boom").unwrap();
        let workspace = s.0.join("ws");
        fs::create_dir_all(&workspace).unwrap();
        let staged = stage_local(&authority, &workspace, "tk-1-a", &["server.log".to_string()]).unwrap();
        assert_eq!(staged[0].path, ".tudouni/ticket-attachments/tk-1-a/server.log");
        assert_eq!(staged[0].bytes, 4);
        assert_eq!(fs::read(workspace.join(&staged[0].path)).unwrap(), b"boom");
        // Staging again overwrites rather than failing.
        assert!(stage_local(&authority, &workspace, "tk-1-a", &["server.log".to_string()]).is_ok());
    }

    #[test]
    fn purge_dir_is_scoped_to_one_ticket() {
        let s = Scratch::new("purge");
        let dir = ticket_dir_under(&s.0, "tk-1-a").unwrap();
        assert!(dir.ends_with(Path::new("attachments").join("tk-1-a")));
        assert!(ticket_dir_under(&s.0, "..").is_err());
    }
}
