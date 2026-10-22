//! Reading and writing the configuration the desktop edits directly.
//!
//! The rules that keep a save from destroying what the form does not draw live
//! in [`config_file`]; these are the command wrappers around it.


use serde::Serialize;

use crate::config_file;
use crate::remote_config;

/// Read `~/.tudouni/config.json` and `mcp.json` for the config panel.
///
/// The front end draws this, so it is the panel's own shape rather than the
/// runtime's `providers` object: routes as a **list** (which keeps the file's
/// order, and the order is what decides the default route), headers as pairs (a
/// map would re-arrange itself between renders), and a `problem` field per file
/// instead of an error.
///
/// That last one is the load-bearing part. A file that will not parse still has
/// to be **shown** — its path, and the sentence saying what is wrong — because a
/// panel that answers "it could not be read" with nothing on screen leaves the
/// person with no idea which file to open. The `problem` is also what the panel
/// reads to decide that saving is off: a merge needs an object to preserve, and
/// there is none.
#[tauri::command]
pub(crate) fn config_read() -> Result<config_file::ConfigDocument, String> {
    config_file::read_document()
}

/// Reads the local config.json as plain text — Phase 4's one addition to
/// this command set, for config sync (§9). See
/// `config_file::read_local_config_text` for why this is a separate,
/// un-parsed read rather than reusing `config_read`'s structured document.
///
/// Returns the text alongside its fingerprint (SHA256, hex) so the caller
/// never needs a second hashing dependency on the JS side just to compare
/// it against a remote one — `remote_config::fingerprint_hex` is the exact
/// same function `check_remote_config`/`write_remote_config` already use,
/// so a local and a remote fingerprint are always computed the same way.
#[tauri::command]
pub(crate) fn read_local_config_text() -> Result<Option<LocalConfigTextPayload>, String> {
    let text = config_file::read_local_config_text()?;
    Ok(text.map(|text| {
        let fingerprint = remote_config::fingerprint_hex(text.as_bytes());
        LocalConfigTextPayload { text, fingerprint }
    }))
}

#[derive(Serialize)]
pub(crate) struct LocalConfigTextPayload {
    text: String,
    fingerprint: String,
}

/// Apply one save and return the files as they are **afterwards**.
///
/// The reply is a fresh read, not the patch echoed back: what the panel draws
/// next is therefore the file's own content. That is the same rule the settings
/// panel follows when it shows the argv a child was actually given rather than
/// what somebody typed — a remembered value must not read as "this is in force".
///
/// Failures are sentences for a person, and every one of them is a reason
/// **nothing was written**: the merge is built in memory and the rename at the
/// end is the only step that touches the file.
#[tauri::command]
pub(crate) fn config_write(patch: config_file::ConfigPatch) -> Result<config_file::ConfigDocument, String> {
    config_file::write_document(patch)
}
