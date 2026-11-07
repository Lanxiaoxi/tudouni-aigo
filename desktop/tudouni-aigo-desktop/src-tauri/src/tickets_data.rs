//! `~/.tudouni/tickets/` — everything the desktop needs about Tickets.
//!
//! A Ticket is written on every event it receives, while `desktop.json` holds
//! templates and hosts that change a few times a month. Two write rates in one
//! file would mean every Ticket event rewrites the host list, and one damaged
//! file would take both down — so Tickets have a directory of their own (see
//! `docs/design/ticket.md` §6.3). Nothing else about the door differs from
//! `desktop_data`: **it moves bytes, it does not parse them**, and the write is
//! a temp file in the same directory followed by a rename.
//!
//! ## The directory
//!
//! ```text
//! ~/.tudouni/tickets/
//!   tickets.json    the record — the only file the store writes
//!   inbox/          where an outside program drops work (see `inbox_*` below)
//!   processed/      inbox files already turned into a Ticket
//! ```
//!
//! `inbox/` is a **one-way door**: an outside program may write a file there and
//! the desktop turns it into an OPEN Ticket, but nothing outside this app ever
//! writes `tickets.json`. That is what keeps the "exactly one writer" rule
//! (`docs/design/ticket.md` §6.3) true while still letting a script, another
//! agent or a person's editor hand work in.
//!
//! One deliberate exception to "does not parse": the record carries a `schema`
//! number that only grows, and a build that is older than the file must not
//! write it back — it would drop every field it does not know. The front end
//! checks this itself (the store goes read-only), and this module checks it
//! again on the write, reading only that one number, because the front end's
//! copy of the file can be stale by the time it writes (another window of a
//! newer build is the case that matters). A file whose schema cannot be read
//! is not refused: an unreadable file is the front end's "start over" case,
//! and refusing to replace it would make that state permanent.

use crate::config_file::home_dir;
use std::fs;
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "tickets.json";
const RUNTIME_DIR: &str = ".tudouni";
const TICKETS_DIR: &str = "tickets";
const INBOX_DIR: &str = "inbox";
const PROCESSED_DIR: &str = "processed";

/// The directory holding the record and the inbox.
fn tickets_dir() -> Result<PathBuf, String> {
    let home = home_dir().ok_or("the home directory could not be read")?;
    Ok(home.join(RUNTIME_DIR).join(TICKETS_DIR))
}

fn data_path() -> Result<PathBuf, String> {
    Ok(tickets_dir()?.join(FILE_NAME))
}

/// The `schema` number of a document, or `None` when the text is not a JSON
/// object carrying a non-negative integer under that key.
fn schema_of(text: &str) -> Option<u64> {
    #[derive(serde::Deserialize)]
    struct Head {
        schema: u64,
    }
    // `Head` ignores every other key, so a large `tickets` array is skipped
    // rather than held as a tree.
    serde_json::from_str::<Head>(text).ok().map(|head| head.schema)
}

/// Read the file as plain text. `None` is the normal first-launch state.
fn read_at(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

/// Replace the file atomically, unless it was written by a newer schema.
fn write_at(path: &Path, text: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(dir)
        .map_err(|err| format!("{} could not be created: {err}", dir.display()))?;

    // Refuse to downgrade. Only a *readable, larger* number refuses; see the
    // module comment for why an unreadable file does not.
    if let Ok(Some(existing)) = read_at(path) {
        if let (Some(on_disk), Some(incoming)) = (schema_of(&existing), schema_of(text)) {
            if on_disk > incoming {
                return Err(format!(
                    "{} was written by a newer version (schema {on_disk}, this build writes {incoming}); refusing to overwrite it",
                    path.display()
                ));
            }
        }
    }

    // Unique to this process, for the reason `desktop_data` gives: two writers
    // sharing one temp name is a write into another process's rename.
    let tmp = dir.join(format!(".{FILE_NAME}.{}.tmp", std::process::id()));

    fs::write(&tmp, text)
        .map_err(|err| format!("{} could not be written: {err}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        format!("{} could not be replaced: {err}", path.display())
    })
}

/// Read the record as plain text; `None` when the file does not exist yet.
#[tauri::command]
pub(crate) fn tickets_read() -> Result<Option<String>, String> {
    read_at(&data_path()?)
}

/// Replace the record, atomically.
#[tauri::command]
pub(crate) fn tickets_write(text: String) -> Result<(), String> {
    write_at(&data_path()?, &text)
}

/* ============================================================
   The inbox: a one-way door for work that did not come from a button.
   ============================================================ */

/// One file waiting in `inbox/`, as text plus the name it arrived under.
///
/// The name is the idempotence key's other half: a source that re-delivers the
/// same issue overwrites `github-issue-123.md` rather than adding a second one.
#[derive(serde::Serialize)]
pub(crate) struct InboxFile {
    /// The file's stem, without `.md`.
    name: String,
    text: String,
}

/// Why a name is not one this door accepts.
fn inbox_name_problem(name: &str) -> Option<&'static str> {
    if name.is_empty() {
        return Some("the name is empty");
    }
    // A leading dot is how a writer marks its own half-finished file, and the
    // store must not read one — it would turn a half-written brief into a
    // Ticket. `memory`'s candidates reader skips these for the same reason.
    if name.starts_with('.') {
        return Some("the name starts with a dot, which marks a temporary file");
    }
    if name.contains(['/', '\\']) || name.contains("..") {
        return Some("the name contains a path separator");
    }
    None
}

/// List `inbox/*.md` under `root`, oldest name first.
///
/// A file that cannot be read is reported and skipped rather than failing the
/// whole scan: one unreadable drop must not hide the nine good ones beside it.
fn list_inbox(root: &Path) -> Result<Vec<InboxFile>, String> {
    let dir = root.join(INBOX_DIR);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("could not read {}: {e}", dir.display())),
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() || !name.ends_with(".md") {
            continue;
        }
        let stem = name.trim_end_matches(".md").to_string();
        if inbox_name_problem(&stem).is_some() {
            continue;
        }
        match fs::read_to_string(&path) {
            Ok(text) => files.push(InboxFile { name: stem, text }),
            Err(e) => eprintln!("tickets inbox: skipping {name}: {e}"),
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

/// Move one inbox file into `processed/`, where it is kept but no longer
/// scanned.
///
/// Copied then removed rather than renamed, because the two directories may sit
/// on different volumes after a person reorganises the folder, and a rename
/// across volumes fails where a copy does not. A name already in `processed/` is
/// overwritten: by then this file's Ticket exists, so the second copy is the
/// same fact.
fn archive_inbox(root: &Path, name: &str) -> Result<(), String> {
    if let Some(problem) = inbox_name_problem(name) {
        return Err(format!("{name:?} is not an inbox file: {problem}"));
    }
    let from = root.join(INBOX_DIR).join(format!("{name}.md"));
    let to_dir = root.join(PROCESSED_DIR);
    fs::create_dir_all(&to_dir)
        .map_err(|e| format!("{} could not be created: {e}", to_dir.display()))?;
    let to = to_dir.join(format!("{name}.md"));
    let text = match fs::read_to_string(&from) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("could not read {}: {e}", from.display())),
    };
    fs::write(&to, text).map_err(|e| format!("{} could not be written: {e}", to.display()))?;
    fs::remove_file(&from).map_err(|e| format!("{} could not be removed: {e}", from.display()))
}

/// List `inbox/*.md`, oldest name first.
#[tauri::command]
pub(crate) fn inbox_list() -> Result<Vec<InboxFile>, String> {
    list_inbox(&tickets_dir()?)
}

/// Archive one drained inbox file under `processed/`.
#[tauri::command]
pub(crate) fn inbox_archive(name: String) -> Result<(), String> {
    archive_inbox(&tickets_dir()?, &name)
}

/// Where `inbox/` is, for a sentence in the UI that tells a person where to
/// drop a file. The path is the app's, so only the app can say it.
#[tauri::command]
pub(crate) fn inbox_dir() -> Result<String, String> {
    Ok(tickets_dir()?.join(INBOX_DIR).display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory under the system temp dir, removed on drop. Unique
    /// per test so parallel tests never share a file.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "tudouni-tickets-test-{}-{name}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn file(&self) -> PathBuf {
            self.0.join(".tudouni").join(TICKETS_DIR).join(FILE_NAME)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn missing_file_reads_as_none() {
        let s = Scratch::new("missing");
        assert_eq!(read_at(&s.file()).unwrap(), None);
    }

    #[test]
    fn write_then_read_round_trips_bytes_exactly() {
        let s = Scratch::new("roundtrip");
        // Not normalised: bytes in, same bytes out.
        let text = "{ \"schema\": 1,\n  \"tickets\": [] }\n";
        write_at(&s.file(), text).unwrap();
        assert_eq!(read_at(&s.file()).unwrap().as_deref(), Some(text));
    }

    #[test]
    fn write_leaves_no_temp_file_behind() {
        let s = Scratch::new("tmp");
        write_at(&s.file(), "{\"schema\":1,\"tickets\":[]}").unwrap();
        write_at(&s.file(), "{\"schema\":1,\"tickets\":[1]}").unwrap();
        let names: Vec<String> = fs::read_dir(s.file().parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![FILE_NAME.to_string()], "{names:?}");
    }

    #[test]
    fn a_failed_rename_keeps_the_old_content_and_removes_the_temp() {
        let s = Scratch::new("rename-fail");
        // A directory squatting on the target makes the rename fail on every
        // platform, which is the failure the "old content survives" claim is
        // about: the write goes to the temp file first, never to the target.
        let target = s.file();
        fs::create_dir_all(&target).unwrap();
        let err = write_at(&target, "{\"schema\":1,\"tickets\":[]}").unwrap_err();
        assert!(err.contains("could not"), "{err}");
        let leftovers: Vec<String> = fs::read_dir(target.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn a_newer_schema_on_disk_refuses_the_write() {
        let s = Scratch::new("newer");
        let newer = "{\"schema\":2,\"tickets\":[{\"future\":true}]}";
        write_at(&s.file(), newer).unwrap();
        let err = write_at(&s.file(), "{\"schema\":1,\"tickets\":[]}").unwrap_err();
        assert!(err.contains("newer version"), "{err}");
        assert_eq!(read_at(&s.file()).unwrap().as_deref(), Some(newer));
    }

    #[test]
    fn an_equal_or_older_schema_on_disk_is_replaced() {
        let s = Scratch::new("older");
        write_at(&s.file(), "{\"schema\":1,\"tickets\":[]}").unwrap();
        write_at(&s.file(), "{\"schema\":1,\"tickets\":[2]}").unwrap();
        write_at(&s.file(), "{\"schema\":2,\"tickets\":[]}").unwrap();
        assert_eq!(
            read_at(&s.file()).unwrap().as_deref(),
            Some("{\"schema\":2,\"tickets\":[]}")
        );
    }

    #[test]
    fn an_unreadable_existing_file_does_not_block_a_write() {
        let s = Scratch::new("garbage");
        write_at(&s.file(), "not json at all").unwrap();
        write_at(&s.file(), "{\"schema\":1,\"tickets\":[]}").unwrap();
        assert_eq!(
            read_at(&s.file()).unwrap().as_deref(),
            Some("{\"schema\":1,\"tickets\":[]}")
        );
    }

    #[test]
    fn schema_of_reads_only_that_number() {
        assert_eq!(schema_of("{\"schema\":3,\"tickets\":[{}]}"), Some(3));
        assert_eq!(schema_of("{\"tickets\":[]}"), None);
        assert_eq!(schema_of("{\"schema\":\"1\"}"), None);
        assert_eq!(schema_of("[]"), None);
    }

    /* ---------------- the inbox ---------------- */

    /// A scratch tickets directory with an `inbox/` in it.
    fn inbox_root(name: &str) -> Scratch {
        let s = Scratch::new(name);
        fs::create_dir_all(s.0.join(".tudouni").join(TICKETS_DIR).join(INBOX_DIR)).unwrap();
        s
    }

    fn drop_file(root: &Path, name: &str, text: &str) {
        fs::write(root.join(INBOX_DIR).join(format!("{name}.md")), text).unwrap();
    }

    fn root_of(s: &Scratch) -> PathBuf {
        s.0.join(".tudouni").join(TICKETS_DIR)
    }

    #[test]
    fn a_missing_inbox_is_empty_not_an_error() {
        let s = Scratch::new("no-inbox");
        assert!(list_inbox(&root_of(&s)).unwrap().is_empty());
    }

    #[test]
    fn only_md_files_are_read() {
        let s = inbox_root("only-md");
        drop_file(&root_of(&s), "good", "do the thing");
        fs::write(root_of(&s).join(INBOX_DIR).join("notes.txt"), "ignored").unwrap();
        let files = list_inbox(&root_of(&s)).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "good");
        assert_eq!(files[0].text, "do the thing");
    }

    #[test]
    fn a_dot_file_is_a_half_written_temp_and_is_skipped() {
        let s = inbox_root("dot-file");
        drop_file(&root_of(&s), ".partial", "half a brief");
        assert!(list_inbox(&root_of(&s)).unwrap().is_empty());
    }

    #[test]
    fn files_come_back_in_name_order() {
        let s = inbox_root("order");
        drop_file(&root_of(&s), "b", "second");
        drop_file(&root_of(&s), "a", "first");
        let names: Vec<String> = list_inbox(&root_of(&s))
            .unwrap()
            .into_iter()
            .map(|f| f.name)
            .collect();
        assert_eq!(names, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn archiving_moves_the_file_and_keeps_its_text() {
        let s = inbox_root("archive");
        drop_file(&root_of(&s), "github-issue-1", "fix the thing");
        archive_inbox(&root_of(&s), "github-issue-1").unwrap();
        assert!(list_inbox(&root_of(&s)).unwrap().is_empty());
        let kept = root_of(&s).join(PROCESSED_DIR).join("github-issue-1.md");
        assert_eq!(fs::read_to_string(kept).unwrap(), "fix the thing");
    }

    #[test]
    fn archiving_a_file_that_is_already_gone_is_a_no_op() {
        let s = inbox_root("archive-twice");
        drop_file(&root_of(&s), "once", "once");
        archive_inbox(&root_of(&s), "once").unwrap();
        // The second call is what a re-scan after a crash looks like.
        archive_inbox(&root_of(&s), "once").unwrap();
    }

    #[test]
    fn a_name_with_a_separator_is_refused() {
        let s = inbox_root("refuse-sep");
        // A name that walks out of the directory, and one with a separator in
        // the middle: both are refused before a path is built from them.
        let walked = archive_inbox(&root_of(&s), "../escape").unwrap_err();
        assert!(walked.contains("dot"), "{walked}");
        let nested = archive_inbox(&root_of(&s), "a/b").unwrap_err();
        assert!(nested.contains("path separator"), "{nested}");
    }
}
