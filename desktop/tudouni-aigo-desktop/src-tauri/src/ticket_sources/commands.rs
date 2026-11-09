//! The Tauri doors of the Source layer (`docs/design/ticket-sources.md` 5).
//!
//! Everything lives under `~/.tudouni/tickets/`, beside `tickets.json` and the
//! inbox: one system, one directory. The front end never parses the state
//! file; it only reads `lastScan` through `sources_status`.

use super::config::{parse_source, validate_for_write};
use super::probes::{run_probe, Item, ProbeCtx};
use super::scan::{self, ScanReport, CONFIG_FILE, STATE_FILE};
use super::state::{read_state, write_atomic, LastScan};
use crate::config_file::home_dir;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

/// At most one scan at a time. A second press is refused rather than queued:
/// two scans would diff against the same snapshot and race on its write.
static SCANNING: AtomicBool = AtomicBool::new(false);

/// How many items a dry run hands back: enough to see what the templates will
/// get, not a dump of a repository with a thousand PRs.
const PROBE_PREVIEW: usize = 20;

fn root() -> Result<PathBuf, String> {
    let home = home_dir().ok_or("the home directory could not be read")?;
    Ok(home.join(".tudouni").join("tickets"))
}

/// `sources.json` as text; `None` when it does not exist yet.
#[tauri::command]
pub(crate) fn sources_read() -> Result<Option<String>, String> {
    let path = root()?.join(CONFIG_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

/// Replace `sources.json`, but only with a file every Source of which a scan
/// would accept: the panel must not save something that fails later.
#[tauri::command]
pub(crate) fn sources_write(text: String) -> Result<(), String> {
    validate_for_write(&text)?;
    write_atomic(&root()?.join(CONFIG_FILE), &text)
}

/// Where `sources.json` is, for "Open file".
#[tauri::command]
pub(crate) fn sources_path() -> Result<String, String> {
    Ok(root()?.join(CONFIG_FILE).display().to_string())
}

/// Each Source's last scan, by id.
#[tauri::command]
pub(crate) fn sources_status() -> Result<BTreeMap<String, LastScan>, String> {
    let state = read_state(&root()?.join(STATE_FILE))?;
    Ok(state.sources.into_iter().filter_map(|(id, s)| s.last_scan.map(|l| (id, l))).collect())
}

/// Clears `SCANNING` however the scan ends, including a panic in a probe.
struct ScanGuard;
impl Drop for ScanGuard {
    fn drop(&mut self) {
        SCANNING.store(false, Ordering::SeqCst);
    }
}

/// Run every enabled Source (or those in `only`) and deliver to the inbox.
#[tauri::command]
pub(crate) async fn sources_scan(
    now_ms: i64,
    tz_offset_minutes: i64,
    only: Option<Vec<String>>,
) -> Result<ScanReport, String> {
    if SCANNING.swap(true, Ordering::SeqCst) {
        return Err("a scan is already running".to_string());
    }
    let ctx = ProbeCtx { now_ms, tz_offset_minutes };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ScanGuard;
        let root = root()?;
        scan::scan(&root, &ctx, only.as_deref(), &run_probe)
    })
    .await
    .map_err(|e| format!("the scan stopped unexpectedly: {e}"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeItem {
    key: String,
    version: String,
    fields: Value,
}

impl From<Item> for ProbeItem {
    fn from(item: Item) -> Self {
        ProbeItem { key: item.key, version: item.version, fields: item.fields }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeResult {
    ok: bool,
    error: Option<String>,
    total: usize,
    items: Vec<ProbeItem>,
}

/// Dry run: probe one Source (as the panel has it, saved or not) and show
/// what it sees, after the filter. Writes nothing.
#[tauri::command]
pub(crate) async fn sources_probe(source: String, now_ms: i64, tz_offset_minutes: i64) -> Result<ProbeResult, String> {
    let ctx = ProbeCtx { now_ms, tz_offset_minutes };
    tauri::async_runtime::spawn_blocking(move || Ok(probe_text(&source, &ctx)))
        .await
        .map_err(|e| format!("the dry run stopped unexpectedly: {e}"))?
}

fn probe_text(source: &str, ctx: &ProbeCtx) -> ProbeResult {
    let failed = |error: String| ProbeResult { ok: false, error: Some(error), total: 0, items: Vec::new() };
    let raw: Value = match serde_json::from_str(source) {
        Ok(v) => v,
        Err(e) => return failed(format!("the Source is not valid JSON: {e}")),
    };
    let parsed = match parse_source(&raw) {
        Ok(s) => s,
        Err(e) => return failed(e),
    };
    match run_probe(&parsed.probe, ctx) {
        Ok(output) => {
            let items: Vec<Item> = output.items.into_iter().filter(|i| scan::passes(i, &parsed.filter)).collect();
            let total = items.len();
            let error = (!output.warnings.is_empty()).then(|| output.warnings.join("; "));
            ProbeResult {
                ok: true,
                error,
                total,
                items: items.into_iter().take(PROBE_PREVIEW).map(ProbeItem::from).collect(),
            }
        }
        Err(e) => failed(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_dry_run_reports_bad_input_as_a_result_not_an_error() {
        let ctx = ProbeCtx { now_ms: 0, tz_offset_minutes: 0 };
        let r = probe_text("{", &ctx);
        assert!(!r.ok && r.error.unwrap().contains("JSON"));
        let r = probe_text(&json!({"id": "a", "probe": {"kind": "ftp"}, "emit": {"brief": "x"}}).to_string(), &ctx);
        assert!(!r.ok && r.error.unwrap().contains("unknown probe kind"));
    }

    #[test]
    fn the_result_is_camel_case_json() {
        let r = ProbeResult { ok: true, error: None, total: 0, items: Vec::new() };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v, json!({"ok": true, "error": null, "total": 0, "items": []}));
    }
}
