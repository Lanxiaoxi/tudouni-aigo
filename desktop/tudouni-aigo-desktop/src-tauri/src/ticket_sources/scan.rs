//! One scan over every Source (`docs/design/ticket-sources.md` 2, 5).
//!
//! Order per Source: probe → filter → diff → write every selected drop →
//! commit the snapshot. The snapshot is written last and only records events
//! that reached the inbox (or that the Source does not deliver), so a crash or
//! a failed write leaves those events to be found again next time. A probe
//! failure touches nothing but `lastScan`, and never stops the next Source.
//!
//! The probe is a parameter, so the whole flow is tested against a fake one in
//! a scratch directory; the commands pass `probes::run_probe`.

use super::config::{parse_config, Source};
use super::diff::{self, Event};
use super::emit;
use super::filter::glob_match;
use super::probes::{Item, ProbeCtx, ProbeOutput};
use super::state::{read_state, write_state, LastScan, SourceState};
use super::template::{as_text, walk};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::Path;

pub(crate) const CONFIG_FILE: &str = "sources.json";
pub(crate) const STATE_FILE: &str = "sources-state.json";
pub(crate) const INBOX_DIR: &str = "inbox";

/// The probe the scan calls; `probes::run_probe` in the app.
pub(crate) type ProbeFn<'a> = &'a dyn Fn(&Map<String, Value>, &ProbeCtx) -> Result<ProbeOutput, String>;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceReport {
    pub id: String,
    pub ok: bool,
    pub error: Option<String>,
    /// `"disabled"` or `"invalid"` when the Source was not run.
    pub skipped: Option<&'static str>,
    pub baseline: bool,
    pub total: usize,
    pub emitted: usize,
    pub deferred: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanReport {
    pub config_error: Option<String>,
    pub sources: Vec<SourceReport>,
}

/// Scan the Sources configured under `root` (`~/.tudouni/tickets` in the app).
/// `only`, when given, limits the scan to those ids; the rest keep their state.
pub(crate) fn scan(root: &Path, ctx: &ProbeCtx, only: Option<&[String]>, probe: ProbeFn) -> Result<ScanReport, String> {
    let config_text = match std::fs::read_to_string(root.join(CONFIG_FILE)) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("could not read {CONFIG_FILE}: {e}")),
    };
    let config = match parse_config(config_text.as_deref()) {
        Ok(config) => config,
        Err(e) => return Ok(ScanReport { config_error: Some(e), sources: Vec::new() }),
    };
    let state_path = root.join(STATE_FILE);
    let mut state = read_state(&state_path)?;
    let wanted = |id: &str| only.is_none_or(|ids| ids.iter().any(|w| w == id));

    let mut reports = Vec::new();
    for bad in &config.invalid {
        if wanted(&bad.id) {
            reports.push(SourceReport {
                id: bad.id.clone(),
                ok: false,
                error: Some(bad.reason.clone()),
                skipped: Some("invalid"),
                baseline: false,
                total: 0,
                emitted: 0,
                deferred: 0,
            });
        }
    }

    // A Source deleted from the file takes its memory with it, so re-adding
    // one with the same id starts from a fresh baseline. Invalid ones keep
    // theirs: a typo the person is about to fix should not cost a baseline.
    let known: HashSet<&str> =
        config.sources.iter().map(|s| s.id.as_str()).chain(config.invalid.iter().map(|i| i.id.as_str())).collect();
    state.sources.retain(|id, _| known.contains(id.as_str()));

    let inbox = root.join(INBOX_DIR);
    for source in &config.sources {
        if !wanted(&source.id) {
            continue;
        }
        if !source.enabled {
            reports.push(SourceReport {
                id: source.id.clone(),
                ok: true,
                error: None,
                skipped: Some("disabled"),
                baseline: false,
                total: 0,
                emitted: 0,
                deferred: 0,
            });
            continue;
        }
        let entry = state.sources.entry(source.id.clone()).or_default();
        let report = scan_one(source, entry, &inbox, ctx, probe);
        entry.last_scan = Some(LastScan {
            at_ms: ctx.now_ms,
            ok: report.ok,
            error: report.error.clone(),
            emitted: report.emitted,
            deferred: report.deferred,
            baseline: report.baseline,
            total: report.total,
        });
        reports.push(report);
    }

    write_state(&state_path, &state)?;
    Ok(ScanReport { config_error: None, sources: reports })
}

fn scan_one(source: &Source, entry: &mut SourceState, inbox: &Path, ctx: &ProbeCtx, probe: ProbeFn) -> SourceReport {
    let mut report = SourceReport {
        id: source.id.clone(),
        ok: false,
        error: None,
        skipped: None,
        baseline: false,
        total: 0,
        emitted: 0,
        deferred: 0,
    };
    let output = match probe(&source.probe, ctx) {
        Ok(output) => output,
        Err(e) => {
            report.error = Some(e);
            return report;
        }
    };
    let items = prepare(output.items, &source.filter);
    report.total = items.len();
    let mut problems = output.warnings;

    let prev = (entry.fingerprint == source.fingerprint).then_some(&entry.items);
    let d = diff::diff(prev, &items, &source.on, source.limit, source.initial_emit);

    if d.baseline {
        entry.fingerprint = source.fingerprint.clone();
        entry.items = items.iter().map(|i| (i.key.clone(), i.version.clone())).collect();
        report.ok = true;
        report.baseline = true;
        report.error = joined(&problems);
        return report;
    }

    // The base the events were computed against: the old snapshot, or empty
    // on an `initial: emit` first scan / a fingerprint change.
    let mut next = prev.cloned().unwrap_or_default();
    let mut committed: Vec<&Event> = d.silent.iter().collect();
    for ev in &d.selected {
        match emit::render(source, ev).and_then(|drop| emit::write(inbox, &drop)) {
            Ok(_) => {
                report.emitted += 1;
                committed.push(ev);
            }
            Err(e) => problems.push(e),
        }
    }
    for ev in committed {
        diff::apply(&mut next, ev);
    }
    entry.fingerprint = source.fingerprint.clone();
    entry.items = next;
    report.deferred = d.deferred.len();
    report.ok = true;
    report.error = joined(&problems);
    report
}

/// Drop items that fail the filter and keep the first of any repeated key.
fn prepare(items: Vec<Item>, filter: &[(String, String)]) -> Vec<Item> {
    let mut seen = HashSet::new();
    items.into_iter().filter(|item| passes(item, filter) && seen.insert(item.key.clone())).collect()
}

/// Every `(path, glob)` must match. Arrays match when any element does.
pub(crate) fn passes(item: &Item, filter: &[(String, String)]) -> bool {
    filter.iter().all(|(path, glob)| {
        let value = match path.as_str() {
            "key" => Value::String(item.key.clone()),
            "version" => Value::String(item.version.clone()),
            p => match p.strip_prefix("fields.") {
                Some(rest) => walk(&item.fields, rest).cloned().unwrap_or(Value::Null),
                None if p == "fields" => item.fields.clone(),
                None => Value::Null,
            },
        };
        match &value {
            Value::Array(list) => list.iter().any(|v| glob_match(glob, &as_text(v))),
            other => glob_match(glob, &as_text(other)),
        }
    })
}

fn joined(problems: &[String]) -> Option<String> {
    (!problems.is_empty()).then(|| problems.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;
    use std::fs;
    use std::path::PathBuf;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("tudouni-src-scan-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn config(&self, sources: Value) {
            fs::write(self.0.join(CONFIG_FILE), json!({"schema": 1, "sources": sources}).to_string()).unwrap();
        }
        fn inbox(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(self.0.join(INBOX_DIR))
                .map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
                .unwrap_or_default();
            names.sort();
            names
        }
        fn clear_inbox(&self) {
            let _ = fs::remove_dir_all(self.0.join(INBOX_DIR));
        }
        fn state(&self) -> Value {
            serde_json::from_str(&fs::read_to_string(self.0.join(STATE_FILE)).unwrap()).unwrap()
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const CTX: ProbeCtx = ProbeCtx { now_ms: 1000, tz_offset_minutes: 0 };

    /// A probe that returns whatever the test last put in `world`, keyed by
    /// the probe's `name` parameter; a `fail` parameter makes it fail.
    struct World(RefCell<std::collections::HashMap<String, Vec<(String, String)>>>);
    impl World {
        fn new() -> Self {
            World(RefCell::new(Default::default()))
        }
        fn set(&self, name: &str, items: &[(&str, &str)]) {
            self.0.borrow_mut().insert(name.into(), items.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect());
        }
        fn probe(&self) -> impl Fn(&Map<String, Value>, &ProbeCtx) -> Result<ProbeOutput, String> + '_ {
            move |probe, _| {
                if probe.get("fail").and_then(Value::as_bool) == Some(true) {
                    return Err("boom".into());
                }
                let name = probe.get("name").and_then(Value::as_str).unwrap_or("");
                let items = self.0.borrow().get(name).cloned().unwrap_or_default();
                Ok(ProbeOutput {
                    items: items
                        .into_iter()
                        .map(|(k, v)| Item { key: k.clone(), version: v, fields: json!({"tag": format!("t-{k}")}) })
                        .collect(),
                    warnings: Vec::new(),
                })
            }
        }
    }

    fn src(id: &str, name: &str, extra: Value) -> Value {
        let mut v = json!({
            "id": id,
            "probe": {"kind": "schedule", "every": "daily", "name": name},
            "emit": {"thread": "{key}@{version}", "brief": "do {key}"}
        });
        for (k, val) in extra.as_object().unwrap() {
            v[k] = val.clone();
        }
        v
    }

    fn run(s: &Scratch, world: &World) -> ScanReport {
        let probe = world.probe();
        scan(&s.0, &CTX, None, &probe).unwrap()
    }

    #[test]
    fn baseline_then_changes() {
        let s = Scratch::new("basic");
        let w = World::new();
        s.config(json!([src("a", "a", json!({}))]));
        w.set("a", &[("1", "v1"), ("2", "v1")]);

        let r = run(&s, &w);
        assert!(r.sources[0].baseline && r.sources[0].ok);
        assert_eq!(r.sources[0].total, 2);
        assert!(s.inbox().is_empty(), "a baseline delivers nothing");

        w.set("a", &[("1", "v2"), ("2", "v1"), ("3", "v1")]);
        let r = run(&s, &w);
        assert_eq!((r.sources[0].emitted, r.sources[0].baseline), (2, false));
        assert_eq!(s.inbox().len(), 2);
        let text = fs::read_to_string(s.0.join(INBOX_DIR).join(emit::file_name("a", "1@v2"))).unwrap();
        assert!(text.contains("source: a\nthread: 1@v2\n") && text.ends_with("do 1\n"), "{text}");

        // Nothing new: nothing delivered.
        s.clear_inbox();
        assert_eq!(run(&s, &w).sources[0].emitted, 0);
        assert!(s.inbox().is_empty());
        assert_eq!(s.state()["sources"]["a"]["lastScan"]["atMs"], 1000);
    }

    #[test]
    fn initial_emit_delivers_the_present() {
        let s = Scratch::new("initial");
        let w = World::new();
        s.config(json!([src("a", "a", json!({"initial": "emit"}))]));
        w.set("a", &[("1", "v1")]);
        let r = run(&s, &w);
        assert_eq!((r.sources[0].emitted, r.sources[0].baseline), (1, false));
    }

    #[test]
    fn a_changed_probe_rebuilds_the_baseline_but_a_changed_template_does_not() {
        let s = Scratch::new("fingerprint");
        let w = World::new();
        w.set("a", &[("1", "v1")]);
        w.set("b", &[("9", "v1")]);
        s.config(json!([src("x", "a", json!({}))]));
        run(&s, &w);

        // Another brief: the snapshot still describes the same place.
        let mut changed = src("x", "a", json!({}));
        changed["emit"]["brief"] = json!("other {key}");
        s.config(json!([changed]));
        w.set("a", &[("1", "v2")]);
        assert_eq!(run(&s, &w).sources[0].emitted, 1);

        // Another place: start over rather than deliver its whole present.
        s.clear_inbox();
        s.config(json!([src("x", "b", json!({}))]));
        let r = run(&s, &w);
        assert!(r.sources[0].baseline);
        assert!(s.inbox().is_empty());
    }

    #[test]
    fn the_limit_defers_and_the_rest_arrive_next_time() {
        let s = Scratch::new("limit");
        let w = World::new();
        s.config(json!([src("a", "a", json!({"limit": 2, "on": ["added", "changed", "removed"]}))]));
        w.set("a", &[("old", "1"), ("keep", "1")]);
        run(&s, &w);

        w.set("a", &[("keep", "2"), ("n1", "1"), ("n2", "1")]);
        let r = run(&s, &w);
        // Order: changed keep, added n1 | deferred: added n2, removed old.
        assert_eq!((r.sources[0].emitted, r.sources[0].deferred), (2, 2));
        let items = &s.state()["sources"]["a"]["items"];
        assert_eq!(items["keep"], "2");
        assert_eq!(items["n1"], "1");
        assert!(items.get("n2").is_none(), "a deferred add is not recorded");
        assert_eq!(items["old"], "1", "a deferred removal keeps the old entry");

        s.clear_inbox();
        let r = run(&s, &w);
        assert_eq!((r.sources[0].emitted, r.sources[0].deferred), (2, 0));
        assert!(s.inbox().iter().any(|n| *n == emit::file_name("a", "n2@1")));
        assert!(s.inbox().iter().any(|n| *n == emit::file_name("a", "old@1")));
    }

    #[test]
    fn a_kind_not_delivered_is_still_recorded() {
        let s = Scratch::new("silent");
        let w = World::new();
        s.config(json!([src("a", "a", json!({"on": ["added"]}))]));
        w.set("a", &[("1", "v1")]);
        run(&s, &w);
        w.set("a", &[("1", "v2")]);
        assert_eq!(run(&s, &w).sources[0].emitted, 0);
        assert_eq!(s.state()["sources"]["a"]["items"]["1"], "v2");
    }

    #[test]
    fn a_failing_probe_changes_nothing_and_stops_nothing() {
        let s = Scratch::new("fail");
        let w = World::new();
        w.set("a", &[("1", "v1")]);
        w.set("b", &[("1", "v1")]);
        s.config(json!([src("a", "a", json!({})), src("b", "b", json!({}))]));
        run(&s, &w);
        let before = s.state()["sources"]["a"]["items"].clone();

        let mut failing = src("a", "a", json!({}));
        failing["probe"]["fail"] = json!(true);
        // Keep the fingerprint comparable: the failure is about this scan, and
        // the config change also must not wipe the snapshot.
        s.config(json!([failing, src("b", "b", json!({}))]));
        w.set("b", &[("1", "v2")]);
        let r = run(&s, &w);
        assert!(!r.sources[0].ok);
        assert_eq!(r.sources[0].error.as_deref(), Some("boom"));
        assert_eq!(r.sources[1].emitted, 1, "the next Source still ran");
        assert_eq!(s.state()["sources"]["a"]["items"], before);
        assert_eq!(s.state()["sources"]["a"]["lastScan"]["ok"], false);
    }

    #[test]
    fn an_empty_thread_is_skipped_and_retried() {
        let s = Scratch::new("thread");
        let w = World::new();
        let mut a = src("a", "a", json!({}));
        a["emit"]["thread"] = json!("{fields.nope}");
        s.config(json!([a]));
        w.set("a", &[]);
        run(&s, &w);
        w.set("a", &[("1", "v1")]);
        let r = run(&s, &w);
        assert_eq!(r.sources[0].emitted, 0);
        assert!(r.sources[0].error.as_deref().unwrap().contains("thread"));
        assert!(s.state()["sources"]["a"]["items"].get("1").is_none(), "not committed, so retried next scan");
    }

    #[test]
    fn filters_apply_before_the_diff() {
        let s = Scratch::new("filter");
        let w = World::new();
        s.config(json!([src("a", "a", json!({"filter": {"fields.tag": "t-1*"}}))]));
        w.set("a", &[]);
        run(&s, &w);
        w.set("a", &[("1", "v"), ("2", "v"), ("10", "v"), ("1", "dup")]);
        let r = run(&s, &w);
        assert_eq!((r.sources[0].total, r.sources[0].emitted), (2, 2));
    }

    #[test]
    fn disabled_invalid_deleted_and_only() {
        let s = Scratch::new("misc");
        let w = World::new();
        w.set("a", &[("1", "v")]);
        s.config(json!([src("a", "a", json!({})), src("gone", "a", json!({}))]));
        run(&s, &w);
        assert!(s.state()["sources"].get("gone").is_some());

        s.config(json!([src("a", "a", json!({"enabled": false})), {"id": "bad", "probe": {"kind": "nope"}}]));
        let r = run(&s, &w);
        let by: std::collections::HashMap<_, _> = r.sources.iter().map(|x| (x.id.as_str(), x)).collect();
        assert_eq!(by["a"].skipped, Some("disabled"));
        assert_eq!(by["bad"].skipped, Some("invalid"));
        assert!(s.state()["sources"].get("gone").is_none(), "a deleted Source's state is dropped");
        assert!(s.state()["sources"].get("a").is_some(), "a disabled Source keeps its snapshot");

        s.config(json!([src("a", "a", json!({})), src("b", "a", json!({}))]));
        let probe = w.probe();
        let r = scan(&s.0, &CTX, Some(&["b".to_string()]), &probe).unwrap();
        assert_eq!(r.sources.len(), 1);
        assert_eq!(r.sources[0].id, "b");
    }

    #[test]
    fn a_broken_config_is_reported_not_scanned() {
        let s = Scratch::new("broken");
        let w = World::new();
        fs::write(s.0.join(CONFIG_FILE), "{").unwrap();
        let r = run(&s, &w);
        assert!(r.config_error.unwrap().contains("JSON"));
        assert!(r.sources.is_empty());
        // No config at all is simply nothing to do.
        fs::remove_file(s.0.join(CONFIG_FILE)).unwrap();
        let r = run(&s, &w);
        assert!(r.config_error.is_none() && r.sources.is_empty());
    }

    #[test]
    fn report_serializes_in_camel_case() {
        let r = ScanReport {
            config_error: None,
            sources: vec![SourceReport {
                id: "a".into(),
                ok: true,
                error: None,
                skipped: None,
                baseline: true,
                total: 1,
                emitted: 0,
                deferred: 0,
            }],
        };
        let v = serde_json::to_value(&r).unwrap();
        assert!(v.get("configError").is_some());
        assert_eq!(v["sources"][0]["baseline"], true);
    }
}
