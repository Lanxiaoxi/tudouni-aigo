//! `sources.json`: reading and validating the person's Source configuration
//! (`docs/design/ticket-sources.md` 3.1).
//!
//! One validator serves two callers that must agree: the scan (which skips an
//! invalid Source and reports why) and `sources_write` (which refuses to save a
//! file the scan would later reject). Unknown fields are ignored rather than
//! refused, so a newer panel adding a field does not break an older engine.

use super::probes::{sha256_hex, validate_probe};
use super::template;
use serde_json::{Map, Value};

pub(crate) const CONFIG_SCHEMA: u64 = 1;
const DEFAULT_LIMIT: usize = 20;
const DEFAULT_THREAD: &str = "{event}:{key}@{version}";

/// Which kinds of change a Source delivers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EventKind {
    Added,
    Changed,
    Removed,
}

impl EventKind {
    pub fn name(self) -> &'static str {
        match self {
            EventKind::Added => "added",
            EventKind::Changed => "changed",
            EventKind::Removed => "removed",
        }
    }
    fn parse(text: &str) -> Option<Self> {
        match text {
            "added" => Some(EventKind::Added),
            "changed" => Some(EventKind::Changed),
            "removed" => Some(EventKind::Removed),
            _ => None,
        }
    }
}

/// Where the Ticket runs, already rendered as the inbox writes it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Workspace {
    Active,
    Local(String),
    Remote(String),
}

impl Workspace {
    /// The inbox's `workspace:` value (`src/ticket/inbox.ts parseWorkspaceField`).
    pub fn front_matter(&self) -> String {
        match self {
            Workspace::Active => "active".to_string(),
            Workspace::Local(path) => format!("local:{path}"),
            Workspace::Remote(id) => format!("remote:{id}"),
        }
    }
}

/// The `emit` block: templates plus the two fixed fields.
#[derive(Debug, Clone)]
pub(crate) struct Emit {
    pub thread: String,
    pub title: String,
    pub brief: String,
    pub url: String,
    pub workspace: Workspace,
    pub model: String,
}

/// One valid Source.
#[derive(Debug, Clone)]
pub(crate) struct Source {
    pub id: String,
    pub enabled: bool,
    pub probe: Map<String, Value>,
    pub on: Vec<EventKind>,
    /// `(path, glob)` pairs, all of which must match.
    pub filter: Vec<(String, String)>,
    pub initial_emit: bool,
    pub limit: usize,
    pub emit: Emit,
    /// Hash of `probe` + `filter`: when it changes, the old snapshot describes
    /// a different place, so the next scan rebuilds the baseline.
    pub fingerprint: String,
}

/// A Source the scan skips, with the reason.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Invalid {
    /// Its id when it had a readable one, otherwise `#<position>`.
    pub id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Config {
    pub sources: Vec<Source>,
    pub invalid: Vec<Invalid>,
}

/// Parse the whole file. `Err` is a file-level problem (not JSON, wrong
/// schema): no Source is scanned. A missing file is an empty configuration.
pub(crate) fn parse_config(text: Option<&str>) -> Result<Config, String> {
    let Some(text) = text else {
        return Ok(Config::default());
    };
    let text = text.trim_start_matches('\u{feff}');
    let root: Value = serde_json::from_str(text).map_err(|e| format!("sources.json is not valid JSON: {e}"))?;
    let root = root.as_object().ok_or("sources.json must be a JSON object")?;
    match root.get("schema").and_then(Value::as_u64) {
        Some(CONFIG_SCHEMA) => {}
        Some(other) => return Err(format!("sources.json has schema {other}; this build reads schema {CONFIG_SCHEMA}")),
        None => return Err("sources.json has no \"schema\": 1".to_string()),
    }
    let list = match root.get("sources") {
        None | Some(Value::Null) => return Ok(Config::default()),
        Some(Value::Array(list)) => list,
        Some(_) => return Err("\"sources\" must be an array".to_string()),
    };

    let mut config = Config::default();
    let mut seen: Vec<String> = Vec::new();
    for (index, raw) in list.iter().enumerate() {
        let fallback_id = raw
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map_or_else(|| format!("#{}", index + 1), str::to_string);
        match parse_source(raw) {
            Ok(source) => {
                // The second of two equal ids is the one refused: the first is
                // what the person has been scanning, and its snapshot stays its.
                if seen.contains(&source.id) {
                    config.invalid.push(Invalid { id: fallback_id, reason: format!("duplicate id {:?}", source.id) });
                } else {
                    seen.push(source.id.clone());
                    config.sources.push(source);
                }
            }
            Err(reason) => config.invalid.push(Invalid { id: fallback_id, reason }),
        }
    }
    Ok(config)
}

/// The check `sources_write` runs: the file must parse **and** every Source in
/// it must be valid, so the panel cannot save something a scan would skip.
pub(crate) fn validate_for_write(text: &str) -> Result<(), String> {
    let config = parse_config(Some(text))?;
    if config.invalid.is_empty() {
        return Ok(());
    }
    let reasons: Vec<String> = config.invalid.iter().map(|i| format!("{}: {}", i.id, i.reason)).collect();
    Err(reasons.join("; "))
}

/// Whether `id` is one this layer accepts: it becomes the inbox `source` and
/// part of a file name, so it is kept to a safe, case-stable alphabet.
pub(crate) fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let ok = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    ok(bytes[0]) && bytes[1..].iter().all(|&b| ok(b) || b == b'_' || b == b'-')
}

/// Parse one Source object.
pub(crate) fn parse_source(raw: &Value) -> Result<Source, String> {
    let obj = raw.as_object().ok_or("a Source must be a JSON object")?;

    let id = match obj.get("id") {
        Some(Value::String(s)) => s.clone(),
        _ => return Err("\"id\" is required".to_string()),
    };
    if !valid_id(&id) {
        return Err(format!(
            "id {id:?} must be 1–64 characters of a-z, 0-9, '-' or '_', starting with a letter or digit"
        ));
    }
    let enabled = match obj.get("enabled") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("\"enabled\" must be true or false".to_string()),
    };
    if !matches!(obj.get("name"), None | Some(Value::Null) | Some(Value::String(_))) {
        return Err("\"name\" must be a string".to_string());
    }

    let probe = obj.get("probe").and_then(Value::as_object).ok_or("\"probe\" must be an object with a \"kind\"")?.clone();
    validate_probe(&probe)?;

    let on = match obj.get("on") {
        None | Some(Value::Null) => vec![EventKind::Added, EventKind::Changed],
        Some(Value::Array(list)) => {
            let mut on = Vec::new();
            for v in list {
                let kind = v
                    .as_str()
                    .and_then(EventKind::parse)
                    .ok_or_else(|| format!("\"on\" may contain only added, changed, removed; got {v}"))?;
                if !on.contains(&kind) {
                    on.push(kind);
                }
            }
            if on.is_empty() {
                return Err("\"on\" must name at least one event".to_string());
            }
            on
        }
        Some(_) => return Err("\"on\" must be an array".to_string()),
    };

    let mut filter = Vec::new();
    match obj.get("filter") {
        None | Some(Value::Null) => {}
        Some(Value::Object(map)) => {
            for (path, glob) in map {
                let glob = glob.as_str().ok_or_else(|| format!("filter {path:?} must be a string pattern"))?;
                if path.trim().is_empty() {
                    return Err("a filter has an empty path".to_string());
                }
                filter.push((path.clone(), glob.to_string()));
            }
        }
        Some(_) => return Err("\"filter\" must be an object of path → pattern".to_string()),
    }

    let initial_emit = match obj.get("initial") {
        None | Some(Value::Null) => false,
        Some(Value::String(s)) if s == "baseline" => false,
        Some(Value::String(s)) if s == "emit" => true,
        Some(_) => return Err("\"initial\" must be \"baseline\" or \"emit\"".to_string()),
    };

    let limit = match obj.get("limit") {
        None | Some(Value::Null) => DEFAULT_LIMIT,
        Some(Value::Number(n)) => match n.as_u64() {
            Some(v) if (1..=200).contains(&v) => v as usize,
            _ => return Err("\"limit\" must be a whole number from 1 to 200".to_string()),
        },
        Some(_) => return Err("\"limit\" must be a number".to_string()),
    };

    let emit = parse_emit(obj.get("emit"))?;
    let fingerprint = fingerprint_of(&probe, &filter);
    Ok(Source { id, enabled, probe, on, filter, initial_emit, limit, emit, fingerprint })
}

fn parse_emit(raw: Option<&Value>) -> Result<Emit, String> {
    let obj = raw.and_then(Value::as_object).ok_or("\"emit\" must be an object with at least a \"brief\"")?;
    let text = |key: &str, default: &str| -> Result<String, String> {
        match obj.get(key) {
            None | Some(Value::Null) => Ok(default.to_string()),
            Some(Value::String(s)) => {
                template::validate(s).map_err(|e| format!("emit.{key}: {e}"))?;
                Ok(s.clone())
            }
            Some(_) => Err(format!("emit.{key} must be a string")),
        }
    };
    let brief = text("brief", "")?;
    if brief.trim().is_empty() {
        return Err("emit.brief is required".to_string());
    }
    let mut thread = text("thread", DEFAULT_THREAD)?;
    if thread.trim().is_empty() {
        thread = DEFAULT_THREAD.to_string();
    }
    let workspace = parse_workspace(obj.get("workspace"))?;
    let model = match obj.get("model") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => template::one_line(s),
        Some(_) => return Err("emit.model must be a string".to_string()),
    };
    Ok(Emit { thread, title: text("title", "")?, brief, url: text("url", "")?, workspace, model })
}

/// A `TaskWorkspaceRef`, as the Ticket dialog writes it.
fn parse_workspace(raw: Option<&Value>) -> Result<Workspace, String> {
    let Some(raw) = raw.filter(|v| !v.is_null()) else {
        return Ok(Workspace::Active);
    };
    let obj = raw.as_object().ok_or("emit.workspace must be an object")?;
    let field = |key: &str| obj.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    match obj.get("kind").and_then(Value::as_str) {
        Some("active") => Ok(Workspace::Active),
        Some("local") => field("path")
            .map(|p| Workspace::Local(template::one_line(p)))
            .ok_or_else(|| "emit.workspace of kind local needs a \"path\"".to_string()),
        Some("remote") => field("id")
            .map(|id| Workspace::Remote(template::one_line(id)))
            .ok_or_else(|| "emit.workspace of kind remote needs an \"id\"".to_string()),
        _ => Err("emit.workspace.kind must be active, local or remote".to_string()),
    }
}

/// sha256 of `{probe, filter}` with object keys sorted, so reordering keys in
/// an editor (or the panel writing them in another order) is not a "change".
pub(crate) fn fingerprint_of(probe: &Map<String, Value>, filter: &[(String, String)]) -> String {
    let mut filter_map = Map::new();
    for (path, glob) in filter {
        filter_map.insert(path.clone(), Value::String(glob.clone()));
    }
    let mut text = String::new();
    canonical(&Value::Object(probe.clone()), &mut text);
    text.push('\n');
    canonical(&Value::Object(filter_map), &mut text);
    sha256_hex(text.as_bytes())
}

fn canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String((*key).clone()).to_string());
                out.push(':');
                canonical(&map[*key], out);
            }
            out.push('}');
        }
        Value::Array(list) => {
            out.push('[');
            for (i, item) in list.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn source(extra: Value) -> Value {
        let mut base = json!({
            "id": "repo-a",
            "probe": {"kind": "schedule", "every": "daily"},
            "emit": {"brief": "do {key}"}
        });
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    }

    fn file(sources: Vec<Value>) -> String {
        json!({"schema": 1, "sources": sources}).to_string()
    }

    #[test]
    fn defaults_fill_in() {
        let config = parse_config(Some(&file(vec![source(json!({}))]))).unwrap();
        let s = &config.sources[0];
        assert!(s.enabled);
        assert_eq!(s.on, vec![EventKind::Added, EventKind::Changed]);
        assert_eq!(s.limit, 20);
        assert!(!s.initial_emit);
        assert_eq!(s.emit.thread, DEFAULT_THREAD);
        assert_eq!(s.emit.workspace, Workspace::Active);
    }

    #[test]
    fn file_level_problems() {
        assert!(parse_config(None).unwrap().sources.is_empty());
        assert!(parse_config(Some("nope")).unwrap_err().contains("not valid JSON"));
        assert!(parse_config(Some("[]")).unwrap_err().contains("object"));
        assert!(parse_config(Some(r#"{"schema":2}"#)).unwrap_err().contains("schema 2"));
        assert!(parse_config(Some(r#"{"sources":[]}"#)).unwrap_err().contains("schema"));
        assert!(parse_config(Some(r#"{"schema":1,"sources":{}}"#)).unwrap_err().contains("array"));
        // A BOM from Notepad must not make the file unreadable.
        assert!(parse_config(Some("\u{feff}{\"schema\":1}")).is_ok());
    }

    #[test]
    fn one_bad_source_does_not_hide_the_rest() {
        let config = parse_config(Some(&file(vec![
            source(json!({"id": "Bad Id"})),
            source(json!({"id": "good"})),
            source(json!({"id": "good"})),
            json!(3),
        ])))
        .unwrap();
        assert_eq!(config.sources.len(), 1);
        assert_eq!(config.sources[0].id, "good");
        assert_eq!(config.invalid.len(), 3);
        assert!(config.invalid[0].reason.contains("must be 1–64"));
        assert!(config.invalid[1].reason.contains("duplicate"));
        assert_eq!(config.invalid[2].id, "#4");
    }

    #[test]
    fn each_field_is_checked() {
        let bad = |extra: Value| parse_source(&source(extra)).unwrap_err();
        assert!(bad(json!({"probe": {"kind": "ftp"}})).contains("unknown probe kind"));
        assert!(bad(json!({"on": []})).contains("at least one"));
        assert!(bad(json!({"on": ["created"]})).contains("only added"));
        assert!(bad(json!({"limit": 0})).contains("1 to 200"));
        assert!(bad(json!({"limit": 201})).contains("1 to 200"));
        assert!(bad(json!({"initial": "now"})).contains("initial"));
        assert!(bad(json!({"filter": {"key": 3}})).contains("pattern"));
        assert!(bad(json!({"enabled": "yes"})).contains("enabled"));
        assert!(bad(json!({"emit": {}})).contains("brief is required"));
        assert!(bad(json!({"emit": {"brief": "x {key"}})).contains("emit.brief"));
        assert!(bad(json!({"emit": {"brief": "x", "workspace": {"kind": "local"}}})).contains("path"));
        assert!(bad(json!({"emit": {"brief": "x", "workspace": {"kind": "moon"}}})).contains("kind"));
    }

    #[test]
    fn workspace_renders_for_the_inbox() {
        let s = parse_source(&source(json!({"emit": {"brief": "x", "workspace": {"kind": "local", "path": "D:/repo-a"}}}))).unwrap();
        assert_eq!(s.emit.workspace.front_matter(), "local:D:/repo-a");
        let s = parse_source(&source(json!({"emit": {"brief": "x", "workspace": {"kind": "remote", "id": "rw-1"}}}))).unwrap();
        assert_eq!(s.emit.workspace.front_matter(), "remote:rw-1");
    }

    #[test]
    fn ids() {
        assert!(valid_id("repo-a_1"));
        assert!(valid_id("0x"));
        assert!(!valid_id("-a"));
        assert!(!valid_id("A"));
        assert!(!valid_id(""));
        assert!(!valid_id(&"a".repeat(65)));
    }

    #[test]
    fn fingerprint_ignores_key_order_but_not_values() {
        let a = json!({"kind": "schedule", "every": "daily", "at": "09:00"});
        let b = json!({"at": "09:00", "every": "daily", "kind": "schedule"});
        let c = json!({"kind": "schedule", "every": "weekly", "at": "09:00"});
        let f = |v: &Value, filter: &[(String, String)]| fingerprint_of(v.as_object().unwrap(), filter);
        assert_eq!(f(&a, &[]), f(&b, &[]));
        assert_ne!(f(&a, &[]), f(&c, &[]));
        assert_ne!(f(&a, &[]), f(&a, &[("key".into(), "x".into())]));
    }

    #[test]
    fn emit_does_not_move_the_fingerprint() {
        let a = parse_source(&source(json!({"emit": {"brief": "one"}}))).unwrap();
        let b = parse_source(&source(json!({"emit": {"brief": "two"}, "limit": 5, "on": ["removed"]}))).unwrap();
        assert_eq!(a.fingerprint, b.fingerprint);
    }

    #[test]
    fn write_refuses_any_invalid_source() {
        assert!(validate_for_write(&file(vec![source(json!({}))])).is_ok());
        let err = validate_for_write(&file(vec![source(json!({})), source(json!({"limit": 0}))])).unwrap_err();
        assert!(err.contains("repo-a") && err.contains("1 to 200"), "{err}");
        let err = validate_for_write(&file(vec![source(json!({})), source(json!({}))])).unwrap_err();
        assert!(err.contains("duplicate"), "{err}");
    }
}
