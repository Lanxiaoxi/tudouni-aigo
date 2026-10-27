//! `~/.tudouni/desktop.json` — the desktop's user data.
//!
//! The window used to keep everything in one `localStorage` record: the
//! user's data (task templates, run history, saved hosts, remote workspaces,
//! the remembered workspace) *and* the window's own presentation state (rail
//! widths, folded blocks) in the same opaque leveldb. The user data is
//! somebody's work — it should live in the per-user directory that follows the
//! person (`paths.UserConfigDir` on the Go side, the same place `config.json`
//! and `mcp.json` live), as a file that can be read, diffed, backed up and
//! copied between machines.
//!
//! **This module is deliberately dumb: it moves bytes, it does not parse them.**
//! The front end owns the record's shape — the validators that drop a
//! malformed `tasks` or `sshHosts` entry are in `state/prefs.ts` — and the
//! rules that go with it (what counts as user data, what stays a window
//! preference) are the front end's to change without a Rust release. That is
//! the same division `read_local_config_text` draws: a text door, not a
//! second definition of the document.
//!
//! The write follows `config_file::write_object`'s rule — a temp file in the
//! same directory, then a rename — because a half-written data file is the
//! same data loss a half-written `config.json` is: this file holds the task
//! templates and the SSH host entries.

use crate::config_file::home_dir;
use std::fs;
use std::path::PathBuf;

const FILE_NAME: &str = "desktop.json";
const RUNTIME_DIR: &str = ".tudouni";

/// Where the record lives.
///
/// `USERPROFILE` then `HOME`, the same set `config_file::home_dir` consults —
/// and the same function is reused rather than re-stated, for the reason that
/// function gives: two doors that resolve the home differently would agree
/// about nothing.
fn data_path() -> Result<PathBuf, String> {
    let home = home_dir().ok_or("the home directory could not be read")?;
    Ok(home.join(RUNTIME_DIR).join(FILE_NAME))
}

/// Read the record as plain text.
///
/// `None` means the file does not exist, which is the normal first-launch
/// state rather than an error — the same reading `read_local_config_text`
/// gives. A file that cannot be read for any other reason is an error the
/// front end shows, because "the data is there and unreadable" is a different
/// answer from "there is no data yet".
#[tauri::command]
pub(crate) fn desktop_data_read() -> Result<Option<String>, String> {
    let path = data_path()?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

/// Replace the record, atomically.
///
/// The text rather than a structured patch: the front end holds the whole
/// record and validates it on read, so a field-wise merge on this side would
/// be a second, drifting copy of rules that belong in one place. The atomic
/// half is the one that cannot live anywhere but here — see the module
/// comment for why a rename is the only safe spelling.
#[tauri::command]
pub(crate) fn desktop_data_write(text: String) -> Result<(), String> {
    let path = data_path()?;
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(dir)
        .map_err(|err| format!("{} could not be created: {err}", dir.display()))?;

    // Unique to this process: `config_file::write_object` names its temp the
    // same way, and the reason is the same — two writers sharing one temp
    // name is a write into another process's rename.
    let tmp = dir.join(format!(".{FILE_NAME}.{}.tmp", std::process::id()));

    fs::write(&tmp, &text).map_err(|err| {
        format!("{} could not be written: {err}", tmp.display())
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Windows has no group or other permissions; the record is not a key
        // file, but the same spelling keeps the two doors of this program
        // agreeing about how a user file is written.
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, &path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        format!("{} could not be replaced: {err}", path.display())
    })
}
