//! `sources-state.json`: the snapshots and last results the scan keeps
//! (`docs/design/ticket-sources.md` 3.3), plus the atomic write both of this
//! layer's own files and its inbox drops use.
//!
//! Only the scan writes this file. It is a cache of "what each Source saw last
//! time", so losing it costs one rebuilt baseline and never a duplicate
//! Ticket: the inbox's `(source, thread)` check is the real idempotence guard.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub(crate) const STATE_SCHEMA: u64 = 1;

/// The outcome of a Source's most recent scan, as the panel shows it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LastScan {
    pub at_ms: i64,
    pub ok: bool,
    pub error: Option<String>,
    pub emitted: usize,
    pub deferred: usize,
    pub baseline: bool,
    pub total: usize,
}

/// One Source's memory.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceState {
    /// The config fingerprint the snapshot was taken under. Empty means "no
    /// baseline yet" (a Source whose first probe failed).
    #[serde(default)]
    pub fingerprint: String,
    /// `key → version` as last committed.
    #[serde(default)]
    pub items: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_scan: Option<LastScan>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct StateFile {
    pub schema: u64,
    #[serde(default)]
    pub sources: BTreeMap<String, SourceState>,
}

impl Default for StateFile {
    fn default() -> Self {
        StateFile { schema: STATE_SCHEMA, sources: BTreeMap::new() }
    }
}

/// Read the state. A missing or unreadable file is an empty state (the cost
/// is a rebuilt baseline, see the module comment); a file from a newer build
/// is refused so this build does not overwrite what it cannot read.
pub(crate) fn read_state(path: &Path) -> Result<StateFile, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(StateFile::default()),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let Ok(file) = serde_json::from_str::<StateFile>(text.trim_start_matches('\u{feff}')) else {
        return Ok(StateFile::default());
    };
    if file.schema > STATE_SCHEMA {
        return Err(format!(
            "{} was written by a newer version (schema {}); refusing to scan over it",
            path.display(),
            file.schema
        ));
    }
    Ok(StateFile { schema: STATE_SCHEMA, ..file })
}

pub(crate) fn write_state(path: &Path, state: &StateFile) -> Result<(), String> {
    let text = serde_json::to_string_pretty(state).map_err(|e| format!("the scan state could not be encoded: {e}"))?;
    write_atomic(path, &format!("{text}\n"))
}

/// Replace `path` with `text`: a temp file in the same directory, then a
/// rename. The temp name starts with a dot because the inbox reader skips
/// dot-files, so a drop that is still being written is never read.
pub(crate) fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let dir = path.parent().ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(dir).map_err(|e| format!("{} could not be created: {e}", dir.display()))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    fs::write(&tmp, text).map_err(|e| format!("{} could not be written: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{} could not be replaced: {e}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tudouni-src-state-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trip_and_missing() {
        let dir = scratch("rt");
        let path = dir.join("sources-state.json");
        assert_eq!(read_state(&path).unwrap(), StateFile::default());
        let mut state = StateFile::default();
        state.sources.insert(
            "a".into(),
            SourceState {
                fingerprint: "f".into(),
                items: BTreeMap::from([("k".into(), "v".into())]),
                last_scan: Some(LastScan { at_ms: 5, ok: true, total: 1, ..Default::default() }),
            },
        );
        write_state(&path, &state).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"lastScan\"") && text.contains("\"atMs\": 5"), "{text}");
        assert_eq!(read_state(&path).unwrap(), state);
        // No temp file is left behind.
        let left: Vec<_> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn garbage_is_empty_but_newer_is_refused() {
        let dir = scratch("bad");
        let path = dir.join("s.json");
        fs::write(&path, "not json").unwrap();
        assert_eq!(read_state(&path).unwrap(), StateFile::default());
        fs::write(&path, r#"{"schema": 9, "sources": {}}"#).unwrap();
        assert!(read_state(&path).unwrap_err().contains("newer"));
        let _ = fs::remove_dir_all(&dir);
    }
}
