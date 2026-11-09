//! Snapshot diffing: the one rule every Source shares
//! (`docs/design/ticket-sources.md` 2).
//!
//! The diff only *proposes*. It splits events into `selected` (deliver now),
//! `deferred` (over the limit) and `silent` (a kind the Source does not
//! deliver). The scan then commits `silent` plus whatever `selected` events
//! actually reached the inbox; deferred and failed events are left out of the
//! snapshot, so the next scan sees them as events again. That is the whole of
//! "nothing is lost": no event is marked seen unless it was delivered or the
//! person said they do not want that kind.

use super::config::EventKind;
use super::probes::Item;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Event {
    pub kind: EventKind,
    pub key: String,
    /// The new version; for `removed`, the last version seen.
    pub version: String,
    /// The item's fields; `{}` for `removed` (the snapshot keeps versions only).
    pub fields: Value,
}

#[derive(Debug, Default)]
pub(crate) struct Diff {
    /// No usable previous snapshot and no `initial: emit`: record, deliver nothing.
    pub baseline: bool,
    pub selected: Vec<Event>,
    pub deferred: Vec<Event>,
    pub silent: Vec<Event>,
}

/// Compare `items` (deduplicated, filtered) with the previous snapshot.
///
/// `prev` is `None` when there is no baseline under the current fingerprint.
/// Events are ordered as the probe ordered its items, then removals in key
/// order, so `limit` keeps the ones the source considered first.
pub(crate) fn diff(
    prev: Option<&BTreeMap<String, String>>,
    items: &[Item],
    on: &[EventKind],
    limit: usize,
    initial_emit: bool,
) -> Diff {
    let empty = BTreeMap::new();
    let prev = match prev {
        Some(p) => p,
        None if initial_emit => &empty,
        None => return Diff { baseline: true, ..Diff::default() },
    };

    let mut all = Vec::new();
    for item in items {
        match prev.get(&item.key) {
            None => all.push(event(EventKind::Added, item)),
            Some(old) if *old != item.version => all.push(event(EventKind::Changed, item)),
            Some(_) => {}
        }
    }
    let now: std::collections::HashSet<&str> = items.iter().map(|i| i.key.as_str()).collect();
    for (key, version) in prev {
        if !now.contains(key.as_str()) {
            all.push(Event {
                kind: EventKind::Removed,
                key: key.clone(),
                version: version.clone(),
                fields: Value::Object(Map::new()),
            });
        }
    }

    let mut out = Diff::default();
    for ev in all {
        if !on.contains(&ev.kind) {
            out.silent.push(ev);
        } else if out.selected.len() < limit {
            out.selected.push(ev);
        } else {
            out.deferred.push(ev);
        }
    }
    out
}

fn event(kind: EventKind, item: &Item) -> Event {
    Event { kind, key: item.key.clone(), version: item.version.clone(), fields: item.fields.clone() }
}

/// Record one committed event in a snapshot.
pub(crate) fn apply(snapshot: &mut BTreeMap<String, String>, ev: &Event) {
    match ev.kind {
        EventKind::Added | EventKind::Changed => {
            snapshot.insert(ev.key.clone(), ev.version.clone());
        }
        EventKind::Removed => {
            snapshot.remove(&ev.key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(key: &str, version: &str) -> Item {
        Item { key: key.into(), version: version.into(), fields: json!({}) }
    }
    fn snap(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }
    const ALL: &[EventKind] = &[EventKind::Added, EventKind::Changed, EventKind::Removed];

    #[test]
    fn added_changed_removed() {
        let prev = snap(&[("a", "1"), ("b", "1"), ("c", "1")]);
        let d = diff(Some(&prev), &[item("a", "1"), item("b", "2"), item("d", "1")], ALL, 20, false);
        let kinds: Vec<_> = d.selected.iter().map(|e| (e.kind, e.key.as_str())).collect();
        assert_eq!(kinds, vec![(EventKind::Changed, "b"), (EventKind::Added, "d"), (EventKind::Removed, "c")]);
        assert_eq!(d.selected[2].version, "1");
        assert!(!d.baseline);
    }

    #[test]
    fn kinds_not_in_on_are_silent() {
        let prev = snap(&[("a", "1")]);
        let d = diff(Some(&prev), &[item("b", "1")], &[EventKind::Added], 20, false);
        assert_eq!(d.selected.len(), 1);
        assert_eq!(d.silent.len(), 1);
        assert_eq!(d.silent[0].kind, EventKind::Removed);
    }

    #[test]
    fn first_scan_is_a_baseline_unless_initial_emit() {
        let d = diff(None, &[item("a", "1")], ALL, 20, false);
        assert!(d.baseline && d.selected.is_empty());
        let d = diff(None, &[item("a", "1"), item("b", "1")], ALL, 1, true);
        assert!(!d.baseline);
        assert_eq!(d.selected.len(), 1);
        assert_eq!(d.deferred.len(), 1);
    }

    #[test]
    fn over_the_limit_is_deferred() {
        let prev = snap(&[]);
        let items: Vec<_> = (0..5).map(|i| item(&i.to_string(), "1")).collect();
        let d = diff(Some(&prev), &items, ALL, 2, false);
        assert_eq!(d.selected.len(), 2);
        assert_eq!(d.deferred.len(), 3);
        assert_eq!(d.selected[0].key, "0");
    }

    #[test]
    fn apply_records_and_forgets() {
        let mut s = snap(&[("a", "1")]);
        apply(&mut s, &Event { kind: EventKind::Changed, key: "a".into(), version: "2".into(), fields: json!({}) });
        apply(&mut s, &Event { kind: EventKind::Added, key: "b".into(), version: "1".into(), fields: json!({}) });
        assert_eq!(s, snap(&[("a", "2"), ("b", "1")]));
        apply(&mut s, &Event { kind: EventKind::Removed, key: "a".into(), version: "2".into(), fields: json!({}) });
        assert_eq!(s, snap(&[("b", "1")]));
    }
}
