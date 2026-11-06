//! `~/.tudouni/tickets.json` — the desktop's Tickets.
//!
//! A Ticket is written on every event it receives, while `desktop.json` holds
//! templates and hosts that change a few times a month. Two write rates in one
//! file would mean every Ticket event rewrites the host list, and one damaged
//! file would take both down — so Tickets have a file of their own (see
//! `docs/design/ticket.md` §6.3). Nothing else about the door differs from
//! `desktop_data`: **it moves bytes, it does not parse them**, and the write is
//! a temp file in the same directory followed by a rename.
//!
//! One deliberate exception to "does not parse": the file carries a `schema`
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

fn data_path() -> Result<PathBuf, String> {
    let home = home_dir().ok_or("the home directory could not be read")?;
    Ok(home.join(RUNTIME_DIR).join(FILE_NAME))
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
            self.0.join(".tudouni").join(FILE_NAME)
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
}
