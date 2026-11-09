//! Turning one event into one inbox file (`docs/design/ticket-sources.md` 3.4).
//!
//! The file name is derived from the thread, so the same thread always lands
//! on the same name: a redelivery overwrites rather than piling up, and the
//! inbox's `(source, thread)` check makes even an overwrite after the Ticket
//! exists a no-op.

use super::config::Source;
use super::diff::Event;
use super::probes::sha256_hex;
use super::state::write_atomic;
use super::template::{self, Scope};
use std::path::{Path, PathBuf};

/// A rendered drop, before it is written.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Drop {
    pub file_name: String,
    pub text: String,
}

/// Render `ev` for `source`. `Err` when the result could not be a drop (an
/// empty thread or brief); the scan then leaves the event for the next scan.
pub(crate) fn render(source: &Source, ev: &Event) -> Result<Drop, String> {
    let scope = Scope {
        key: &ev.key,
        version: &ev.version,
        event: ev.kind.name(),
        source: &source.id,
        fields: &ev.fields,
    };
    let emit = &source.emit;
    let thread = template::one_line(&template::render(&emit.thread, &scope));
    if thread.is_empty() {
        return Err(format!("{} {}: the thread template rendered empty", ev.kind.name(), ev.key));
    }
    let brief = template::render(&emit.brief, &scope);
    if brief.trim().is_empty() {
        return Err(format!("{} {}: the brief template rendered empty", ev.kind.name(), ev.key));
    }
    let title = template::one_line(&template::render(&emit.title, &scope));
    let url = template::one_line(&template::render(&emit.url, &scope));

    let mut text = String::from("---\n");
    text.push_str(&format!("source: {}\n", source.id));
    text.push_str(&format!("thread: {thread}\n"));
    if !title.is_empty() {
        text.push_str(&format!("title: {title}\n"));
    }
    text.push_str(&format!("workspace: {}\n", emit.workspace.front_matter()));
    if !emit.model.is_empty() {
        text.push_str(&format!("model: {}\n", emit.model));
    }
    if !url.is_empty() {
        text.push_str(&format!("url: {url}\n"));
    }
    text.push_str("---\n");
    text.push_str(brief.trim_end());
    text.push('\n');

    Ok(Drop { file_name: file_name(&source.id, &thread), text })
}

/// `src-<id>-<first 16 hex of sha256(thread)>.md`. The id is in the name so
/// two Sources never overwrite each other's drop for an equal thread.
pub(crate) fn file_name(source_id: &str, thread: &str) -> String {
    format!("src-{source_id}-{}.md", &sha256_hex(thread.as_bytes())[..16])
}

/// Write a rendered drop into `inbox`, atomically.
pub(crate) fn write(inbox: &Path, drop: &Drop) -> Result<PathBuf, String> {
    let path = inbox.join(&drop.file_name);
    write_atomic(&path, &drop.text)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ticket_sources::config::{parse_source, EventKind};
    use serde_json::json;

    fn source(emit: serde_json::Value) -> Source {
        parse_source(&json!({"id": "repo-a", "probe": {"kind": "schedule", "every": "daily"}, "emit": emit})).unwrap()
    }
    fn ev(fields: serde_json::Value) -> Event {
        Event { kind: EventKind::Added, key: "12".into(), version: "3f2a1b9c".into(), fields }
    }

    #[test]
    fn a_full_drop() {
        let s = source(json!({
            "thread": "pr#{key}",
            "title": "PR #{key}:\n{fields.title}",
            "brief": "Review {fields.url}\n",
            "url": "{fields.url}",
            "workspace": {"kind": "local", "path": "D:/repo-a"},
            "model": "m1"
        }));
        let drop = render(&s, &ev(json!({"title": "Fix", "url": "https://x/pr/12"}))).unwrap();
        assert_eq!(
            drop.text,
            "---\nsource: repo-a\nthread: pr#12\ntitle: PR #12: Fix\nworkspace: local:D:/repo-a\nmodel: m1\nurl: https://x/pr/12\n---\nReview https://x/pr/12\n"
        );
        assert_eq!(drop.file_name, file_name("repo-a", "pr#12"));
        assert!(drop.file_name.starts_with("src-repo-a-") && drop.file_name.ends_with(".md"));
        assert_eq!(drop.file_name.len(), "src-repo-a-".len() + 16 + 3);
    }

    #[test]
    fn empty_optional_lines_are_left_out() {
        let drop = render(&source(json!({"brief": "do it"})), &ev(json!({}))).unwrap();
        assert_eq!(drop.text, "---\nsource: repo-a\nthread: added:12@3f2a1b9c\nworkspace: active\n---\ndo it\n");
    }

    #[test]
    fn empty_thread_or_brief_is_refused() {
        let s = source(json!({"thread": "{fields.nope}", "brief": "x"}));
        assert!(render(&s, &ev(json!({}))).unwrap_err().contains("thread"));
        let s = source(json!({"brief": "{fields.nope}"}));
        assert!(render(&s, &ev(json!({}))).unwrap_err().contains("brief"));
    }

    #[test]
    fn write_is_atomic_and_overwrites() {
        let dir = std::env::temp_dir().join(format!("tudouni-src-emit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let drop = Drop { file_name: "src-a-0.md".into(), text: "one".into() };
        write(&dir, &drop).unwrap();
        write(&dir, &Drop { text: "two".into(), ..drop.clone() }).unwrap();
        let names: Vec<String> =
            std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["src-a-0.md".to_string()]);
        assert_eq!(std::fs::read_to_string(dir.join("src-a-0.md")).unwrap(), "two");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
