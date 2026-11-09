//! Probes: the only part of the Source layer that knows about a place.
//!
//! **The contract** (frozen; the engine is written against it):
//!
//! - `run_probe(probe, ctx)` looks once and returns *the current* items. It
//!   keeps no state of its own: "what changed" is the engine's diff against the
//!   snapshot it stored, which is what keeps every kind's cursor the same shape.
//! - `validate_probe(probe)` checks the `kind` is known and the required
//!   parameters are present and well typed, without touching the network or
//!   the disk. The engine calls it while validating `sources.json`, so a bad
//!   probe is reported when the file is saved rather than at the next scan.
//! - `KINDS` lists every kind this build knows.
//!
//! `probe` is the Source's whole `probe` object, `kind` included. Each family
//! of kinds lives in its own file and exposes `run(kind, probe, ctx)` and
//! `validate(kind, probe)`; this file only dispatches.

use serde_json::{Map, Value};
use std::time::Duration;

mod command;
mod fs;
mod git;
mod github;
mod http_json;
pub(crate) mod process;
mod schedule;

/// One thing a probe saw. `key` identifies it across scans; `version` changes
/// when it changes; `fields` is what templates can read (always a JSON object).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Item {
    pub key: String,
    pub version: String,
    pub fields: Value,
}

/// What a probe is told about the moment it runs. The clock is the front
/// end's, passed in, so `schedule` needs no time-zone database and a test can
/// pin it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ProbeCtx {
    pub now_ms: i64,
    /// `Date#getTimezoneOffset()`: minutes to *add* to local time to get UTC
    /// (UTC+8 is `-480`).
    pub tz_offset_minutes: i64,
}

/// A successful look. `warnings` are partial problems (an item without a key,
/// skipped) that do not fail the Source but are worth telling the person.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ProbeOutput {
    pub items: Vec<Item>,
    pub warnings: Vec<String>,
}

/// Every probe kind this build knows, in the order the design lists them.
pub(crate) const KINDS: &[&str] = &[
    "github.pulls",
    "github.issues",
    "github.branch",
    "github.releases",
    "github.checks",
    "git.remote",
    "git.local",
    "file",
    "dir",
    "http.json",
    "schedule",
    "command",
];

fn kind_of(probe: &Map<String, Value>) -> Result<&str, String> {
    match probe.get("kind").and_then(Value::as_str) {
        Some(kind) if KINDS.contains(&kind) => Ok(kind),
        Some(kind) => Err(format!("unknown probe kind {kind:?}")),
        None => Err("the probe has no kind".to_string()),
    }
}

/// Look once. An `Err` fails this Source's scan and leaves its snapshot alone.
pub(crate) fn run_probe(probe: &Map<String, Value>, ctx: &ProbeCtx) -> Result<ProbeOutput, String> {
    validate_probe(probe)?;
    let kind = kind_of(probe)?;
    match kind {
        k if k.starts_with("github.") => github::run(k, probe, ctx),
        "git.remote" | "git.local" => git::run(kind, probe, ctx),
        "file" | "dir" => fs::run(kind, probe, ctx),
        "http.json" => http_json::run(kind, probe, ctx),
        "schedule" => schedule::run(kind, probe, ctx),
        "command" => command::run(kind, probe, ctx),
        _ => Err(format!("unknown probe kind {kind:?}")),
    }
}

/// Check a probe object without running it.
pub(crate) fn validate_probe(probe: &Map<String, Value>) -> Result<(), String> {
    let kind = kind_of(probe)?;
    timeout_of(probe)?;
    match kind {
        k if k.starts_with("github.") => github::validate(k, probe),
        "git.remote" | "git.local" => git::validate(kind, probe),
        "file" | "dir" => fs::validate(kind, probe),
        "http.json" => http_json::validate(kind, probe),
        "schedule" => schedule::validate(kind, probe),
        "command" => command::validate(kind, probe),
        _ => Err(format!("unknown probe kind {kind:?}")),
    }
}

/* ============================================================
   Parameter helpers, shared by every family so a missing or
   mistyped parameter reads the same everywhere.
   ============================================================ */

/// An optional string parameter; empty counts as absent. A present value that
/// is not a string is an error rather than silently ignored.
pub(crate) fn opt_str<'a>(probe: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, String> {
    match probe.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(_) => Err(format!("probe parameter {key:?} must be a string")),
    }
}

/// A required, non-empty string parameter.
pub(crate) fn req_str<'a>(probe: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    opt_str(probe, key)?.ok_or_else(|| format!("probe parameter {key:?} is required"))
}

/// An optional integer parameter inside `[min, max]`.
pub(crate) fn opt_int(probe: &Map<String, Value>, key: &str, min: i64, max: i64) -> Result<Option<i64>, String> {
    match probe.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => match n.as_i64() {
            Some(v) if (min..=max).contains(&v) => Ok(Some(v)),
            _ => Err(format!("probe parameter {key:?} must be a whole number from {min} to {max}")),
        },
        Some(_) => Err(format!("probe parameter {key:?} must be a number")),
    }
}

/// An optional boolean parameter.
pub(crate) fn opt_bool(probe: &Map<String, Value>, key: &str) -> Result<Option<bool>, String> {
    match probe.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(format!("probe parameter {key:?} must be true or false")),
    }
}

/// `timeoutSec`, common to every probe: the limit on each program it starts.
pub(crate) fn timeout_of(probe: &Map<String, Value>) -> Result<Duration, String> {
    Ok(Duration::from_secs(opt_int(probe, "timeoutSec", 1, 600)?.unwrap_or(60) as u64))
}

/// Lowercase hex sha256, for versions derived from content.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn unknown_and_missing_kinds_are_refused() {
        assert!(validate_probe(&obj(json!({}))).unwrap_err().contains("no kind"));
        assert!(validate_probe(&obj(json!({"kind": "ftp"}))).unwrap_err().contains("unknown"));
    }

    #[test]
    fn timeout_is_bounded() {
        assert_eq!(timeout_of(&obj(json!({}))).unwrap(), Duration::from_secs(60));
        assert_eq!(timeout_of(&obj(json!({"timeoutSec": 5}))).unwrap(), Duration::from_secs(5));
        assert!(timeout_of(&obj(json!({"timeoutSec": 0}))).is_err());
        assert!(timeout_of(&obj(json!({"timeoutSec": "5"}))).is_err());
    }

    #[test]
    fn string_params() {
        let p = obj(json!({"a": "x", "b": "  ", "c": 3}));
        assert_eq!(req_str(&p, "a").unwrap(), "x");
        assert!(req_str(&p, "b").is_err());
        assert!(opt_str(&p, "c").is_err());
        assert_eq!(opt_str(&p, "zz").unwrap(), None);
    }

    #[test]
    fn sha_is_hex() {
        assert_eq!(sha256_hex(b"").len(), 64);
        assert!(sha256_hex(b"abc").starts_with("ba7816bf"));
    }
}
