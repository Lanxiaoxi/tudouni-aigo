//! Cross-session keyword search over one workspace's session files.
//!
//! **The host process does this, not a runtime child.** Sessions are stored
//! per workspace at `<workspace>/.tudouni/sessions/<id>.jsonl`, and every
//! runtime child opens the store for its own workspace only — asking one of
//! them to search would return an answer about a slice of the question and
//! would require a live child where none may be running. The desktop host is
//! the one process that is always there, sees the local disk, and belongs to
//! no session, which is exactly who a read-only search is (the same division
//! `config_file` draws for the configuration files: the host reads and writes
//! a file the runtime also owns, in read-only form here).
//!
//! The scan mirrors the runtime's own `LoadSummary`
//! (`internal/state/store.go`) in the parts the two must agree on:
//!
//! - a line starting `{"context":` is skipped **before** the JSON decoder sees
//!   it. `ctx` records are the bulk of a real file (one measured session kept
//!   47 MB of its 52 MB in them) and nothing in a search looks at them;
//! - `msg` records are read through `MessageText`'s rules: a string content,
//!   or a list of parts where text parts contribute their text and an image
//!   part is named, not dropped (`[Image: name]`);
//! - a line that does not parse is a half line from a killed write, and it is
//!   skipped rather than made to fail the file;
//! - a file whose version is newer than the one this reader knows is refused
//!   rather than guessed at (the runtime's `newer_version` rule).
//!
//! What is deliberately different: only `user` and `assistant` messages are
//! searched. `tool` messages hold command output and code, and a keyword
//! there is a hit nobody asked for — the same allowlist decision the
//! front end's in-transcript search makes (`find/matches.ts`).
//!
//! The search stops at the first match in a file: the question is "which
//! sessions contain this", and reading the rest of a hit would only make the
//! answer slower.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

/// The per-workspace state directory (`paths.RuntimeDirName`).
const RUNTIME_DIR: &str = ".tudouni";
/// The sessions directory inside it (`state` package).
const SESSIONS_DIR: &str = "sessions";
/// The session file suffix (`state.Suffix`).
const SUFFIX: &str = ".jsonl";
/// The delegated-subagent prefix (`state.ChildSessionPrefix`). Child sessions
/// belong to a task in their parent's transcript, and the runtime's
/// `ListParentIDs` hides them from anything a person picks from — the search
/// must hide them too, by name, without opening the files.
const CHILD_PREFIX: &str = "sub-";
/// `state.StateVersion`, as this reader knows it. A higher version is a file
/// a future runtime wrote, and skipping it loudly-ish (no hit, no error) is
/// the same judgement the runtime's loader makes.
const KNOWN_STATE_VERSION: u64 = 1;
/// How many hits a search answers with, newest first. The rail cannot scroll
/// a five-hundred-row list, and a keyword in five hundred sessions is an
/// answer the person has to narrow, not one to be shown.
const MAX_RESULTS: usize = 50;
/// The leading bytes of an encoded `ctx` record. See the module comment.
const CTX_PREFIX: &[u8] = b"{\"context\":";
/// How many characters of the folded text the snippet keeps on each side of
/// the match: enough to say where it is, not enough to re-read the transcript.
const SNIPPET_BEFORE: usize = 30;
const SNIPPET_AFTER: usize = 60;

/// One search hit: the session, and the one line of evidence.
///
/// `snippet` is the matched message folded to one line and cut around the
/// match — it is the proof that the row is there, which is all a search
/// result needs. The row does **not** carry the runtime's `preview`,
/// `messages` or `steps`: those are computed by the runtime under its own
/// rules, and a second copy computed here would disagree with the saved
/// list about the same session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchHit {
    pub session_id: String,
    pub snippet: String,
    /// The file's mtime in epoch seconds, `null` when it cannot be stated —
    /// the same fact the session list's `modified_at` reports.
    pub modified_at: Option<i64>,
}

/// Search every parent session of `workspace` for `query` (case-insensitive
/// substring) and return the hits, newest first.
///
/// A missing sessions directory is an empty answer, not an error: a
/// workspace with no saved session is a normal state, and the front end
/// already draws "no match" for the empty list.
pub fn search(workspace: &Path, query: &str) -> Result<Vec<SessionSearchHit>, String> {
    let sessions_dir = workspace.join(RUNTIME_DIR).join(SESSIONS_DIR);
    let entries = match fs::read_dir(&sessions_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => {
            return Err(format!(
                "{} could not be read: {err}",
                sessions_dir.display()
            ))
        }
    };

    let needle = query.to_lowercase();
    let mut hits: Vec<SessionSearchHit> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(id) = name.strip_suffix(SUFFIX) else {
            continue;
        };
        if id.starts_with(CHILD_PREFIX) || !valid_session_id(id) {
            continue;
        }

        let modified_at = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);

        if let Some(snippet) = scan_file(&path, &needle) {
            hits.push(SessionSearchHit {
                session_id: id.to_string(),
                snippet,
                modified_at,
            });
        }
    }

    hits.sort_by(|a, b| b.modified_at.unwrap_or(0).cmp(&a.modified_at.unwrap_or(0)));
    hits.truncate(MAX_RESULTS);
    Ok(hits)
}

/// `state.sessionIDPattern` as a loop rather than a regex: the ids are ASCII
/// by construction, and the pattern is the one place they are validated
/// before being spliced into file names.
fn valid_session_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Scan one session file for the first matching message.
///
/// Returns `None` for a file with no match and for a file a newer version
/// wrote — the two are deliberately indistinguishable to the caller, because
/// the row simply does not appear in either case, and a search that errors
/// on one unreadable file would hide every hit after it.
fn scan_file(path: &Path, needle: &str) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line).ok()? == 0 {
            break;
        }
        // Strip the line ending and the outer whitespace `Load` skips.
        let mut end = line.len();
        while end > 0 && matches!(line[end - 1], b'\n' | b'\r' | b' ' | b'\t') {
            end -= 1;
        }
        let start = line
            .iter()
            .take_while(|b| matches!(**b, b' ' | b'\t' | b'\r'))
            .count();
        let data = &line[start..end];
        if data.is_empty() {
            continue;
        }
        // Fast path: a `ctx` record is the bulk of a real file and nothing in
        // a search reads one.
        if data.starts_with(CTX_PREFIX) {
            continue;
        }
        let Ok(record) = serde_json::from_slice::<Value>(data) else {
            // A line that does not parse is a half line from a killed write.
            continue;
        };
        if record
            .get("v")
            .and_then(Value::as_u64)
            .is_some_and(|v| v > KNOWN_STATE_VERSION)
        {
            return None;
        }
        let Some(message) = record.get("message").and_then(Value::as_object) else {
            continue;
        };
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = message_text(message);
        if text.is_empty() {
            continue;
        }
        let folded: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let lower = folded.to_lowercase();
        let Some(pos) = lower.find(needle) else {
            continue;
        };
        return Some(snippet_around(&folded, pos, needle.len()));
    }
    None
}

/// The plain text of a message, by the rules the runtime's `MessageText`
/// states: a string, or a list of parts where a text part contributes its
/// text and an image part is **named, not dropped** — a body that quietly
/// loses its picture reads as a message that never had one.
fn message_text(message: &serde_json::Map<String, Value>) -> String {
    let Some(content) = message.get("content") else {
        return String::new();
    };
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => {
            let mut pieces: Vec<String> = Vec::new();
            for part in parts {
                let Some(obj) = part.as_object() else {
                    continue;
                };
                if let Some(text) = obj.get("text").and_then(Value::as_str) {
                    pieces.push(text.to_string());
                    continue;
                }
                if obj.get("type").and_then(Value::as_str) == Some("image") {
                    let name = obj
                        .get("name")
                        .and_then(Value::as_str)
                        .or_else(|| obj.get("mime").and_then(Value::as_str))
                        .unwrap_or("image");
                    pieces.push(format!("[Image: {name}]"));
                }
            }
            pieces.join("")
        }
        _ => String::new(),
    }
}

/// Cut the folded text around the match: `SNIPPET_BEFORE` characters ahead,
/// `SNIPPET_AFTER` behind, ellipses where the cut lands.
fn snippet_around(folded: &str, match_start: usize, match_len: usize) -> String {
    let chars: Vec<char> = folded.chars().collect();
    let end = (match_start + match_len).min(chars.len());
    let begin = match_start.saturating_sub(SNIPPET_BEFORE);
    let finish = (end + SNIPPET_AFTER).min(chars.len());
    let mut out = String::new();
    if begin > 0 {
        out.push('…');
    }
    out.extend(&chars[begin..finish]);
    if finish < chars.len() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A throwaway workspace with a sessions directory.
    fn temp_workspace() -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "tudouni-search-test-{}-{}-{n}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        fs::create_dir_all(dir.join(RUNTIME_DIR).join(SESSIONS_DIR)).unwrap();
        dir
    }

    fn write_session(workspace: &Path, id: &str, lines: &[&str]) {
        let path = workspace.join(RUNTIME_DIR).join(SESSIONS_DIR).join(format!("{id}{SUFFIX}"));
        fs::write(&path, lines.join("\n") + "\n").unwrap();
    }

    fn hits_for(workspace: &Path, query: &str) -> Vec<SessionSearchHit> {
        search(workspace, query).unwrap()
    }

    fn id_of(hit: &SessionSearchHit) -> &str {
        &hit.session_id
    }

    #[test]
    fn a_user_message_match_is_found_case_insensitively() {
        let ws = temp_workspace();
        write_session(
            &ws,
            "20260101-120000",
            &[
                r#"{"v":1,"type":"head","session_id":"20260101-120000","created_at":100}"#,
                r#"{"v":1,"type":"msg","message":{"role":"user","content":"how do I install the release build?"}}"#,
                r#"{"v":1,"type":"msg","message":{"role":"assistant","content":"Use make release."}}"#,
            ],
        );
        let hits = hits_for(&ws, "INSTALL");
        assert_eq!(hits.len(), 1);
        assert_eq!(id_of(&hits[0]), "20260101-120000");
        assert!(hits[0].snippet.contains("install"), "snippet: {}", hits[0].snippet);
    }

    #[test]
    fn an_assistant_message_match_is_found_too() {
        let ws = temp_workspace();
        write_session(
            &ws,
            "20260101-120000",
            &[
                r#"{"v":1,"type":"head","session_id":"20260101-120000","created_at":100}"#,
                r#"{"v":1,"type":"msg","message":{"role":"assistant","content":"Run npm run installer when ready."}}"#,
            ],
        );
        let hits = hits_for(&ws, "installer");
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn tool_messages_are_not_searched() {
        let ws = temp_workspace();
        write_session(
            &ws,
            "20260101-120000",
            &[
                r#"{"v":1,"type":"head","session_id":"20260101-120000","created_at":100}"#,
                r#"{"v":1,"type":"msg","message":{"role":"tool","content":"install exit 0 install ok install done"}}"#,
                r#"{"v":1,"type":"msg","message":{"role":"user","content":"nothing about the release here"}}"#,
            ],
        );
        assert!(hits_for(&ws, "install").is_empty());
    }

    #[test]
    fn child_sessions_are_excluded_by_name() {
        let ws = temp_workspace();
        write_session(
            &ws,
            "sub-20260101-120000",
            &[r#"{"v":1,"type":"msg","message":{"role":"user","content":"install the agent"}}"#],
        );
        assert!(hits_for(&ws, "install").is_empty());
    }

    #[test]
    fn a_ctx_record_cannot_match_and_cannot_break_the_scan() {
        let ws = temp_workspace();
        let big = "install".repeat(5000);
        write_session(
            &ws,
            "20260101-120000",
            &[
                &format!(r#"{{"context":{{"blob":"{big}"}},"type":"ctx","v":1}}"#),
                r#"{"v":1,"type":"msg","message":{"role":"user","content":"please install it"}}"#,
            ],
        );
        let hits = hits_for(&ws, "install");
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("please install it"));
    }

    #[test]
    fn a_content_part_list_is_searched_and_images_are_named() {
        let ws = temp_workspace();
        write_session(
            &ws,
            "20260101-120000",
            &[
                r#"{"v":1,"type":"msg","message":{"role":"user","content":[{"type":"text","text":"look at"},{"type":"image","name":"shot.png"},{"type":"text","text":" before you install"}]}}"#,
            ],
        );
        let hits = hits_for(&ws, "install");
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("[Image: shot.png]"), "snippet: {}", hits[0].snippet);
    }

    #[test]
    fn a_newer_version_file_is_skipped() {
        let ws = temp_workspace();
        write_session(
            &ws,
            "20260101-120000",
            &[
                r#"{"v":2,"type":"head","session_id":"20260101-120000","created_at":100}"#,
                r#"{"v":2,"type":"msg","message":{"role":"user","content":"install"}}"#,
            ],
        );
        assert!(hits_for(&ws, "install").is_empty());
    }

    #[test]
    fn a_half_line_does_not_fail_the_file() {
        let ws = temp_workspace();
        write_session(
            &ws,
            "20260101-120000",
            &[
                r#"{"v":1,"type":"msg","message":{"role":"user","content":"install please"}}"#,
                r#"{"v":1,"type":"msg","mess"#, // a killed write, no trailing newline
            ],
        );
        assert_eq!(hits_for(&ws, "install").len(), 1);
    }

    #[test]
    fn a_missing_sessions_dir_is_an_empty_answer() {
        let dir = temp_workspace();
        let _ = fs::remove_dir_all(dir.join(RUNTIME_DIR).join(SESSIONS_DIR));
        assert!(search(&dir, "install").unwrap().is_empty());
    }

    #[test]
    fn the_snippet_keeps_context_on_both_sides() {
        let ws = temp_workspace();
        let long = format!("{} the keyword {} tail", "x".repeat(100), "needle-abc".repeat(10));
        write_session(
            &ws,
            "20260101-120000",
            &[&format!(
                r#"{{"v":1,"type":"msg","message":{{"role":"user","content":"{long}"}}}}"#
            )],
        );
        let hits = hits_for(&ws, "needle-abc");
        assert_eq!(hits.len(), 1);
        let snippet = &hits[0].snippet;
        assert!(snippet.starts_with('…'), "starts with ellipsis: {snippet}");
        assert!(snippet.ends_with('…'), "ends with ellipsis: {snippet}");
        assert!(snippet.contains("needle-abc"));
    }
}
