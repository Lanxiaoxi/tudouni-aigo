//! The composer's prompt history: what a workspace has been asked before.
//!
//! **The sidecar, not the sessions, is what the composer reads.** Every sent
//! sentence is appended here as one JSON line, by the window that sent it, so
//! the keystroke path never opens a session file — a real one can be tens of
//! megabytes, and the file is being appended to while a turn runs. The sessions
//! are read exactly once, to **seed** a workspace that predates this feature:
//! the reading rules are `session_search`'s (skip `ctx` records before decoding,
//! skip half lines, stop at a newer version), and the message text is the same
//! `MessageText` rule.
//!
//! **The file is an index, not the only copy.** The sentences exist in the
//! workspace's sessions; losing this file costs the suggestions until the next
//! send, never a conversation. That is why it lives under the user's config
//! directory (`~/.tudouni/prompt-history/`) rather than in the workspace: a
//! remote workspace's directory is on the other machine, and its child is not
//! the process that has this disk.
//!
//! **One file per workspace, named by a stable hash** — the workspace key is a
//! path (`C:\work\app`) or `rw:<id>`, and neither is a legal file name on
//! Windows. The hash is computed by the front end (`promptHistory.ts`), so this
//! module only has to refuse a key that is not a hash.
//!
//! The append is the one write that happens while somebody is working, so it is
//! append-only and never rewrites: a crash can lose the last line at worst. The
//! compaction write is the exception, and it goes through the same
//! temp-then-rename as `desktop_data`, because it is the one operation that
//! replaces the whole file.

use crate::config_file::home_dir;
use crate::session_search::{
    for_each_message, message_text, valid_session_id, CHILD_PREFIX, RUNTIME_DIR, SESSIONS_DIR,
    SUFFIX,
};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

const DIR: &str = "prompt-history";
/// A record newer than this reader's shape is not reinterpreted.
const RECORD_VERSION: u64 = 1;
/// Same ceiling as `PROMPT_TEXT_MAX` on the front end. A recalled document is a
/// worse suggestion than none: the person would have to delete most of it.
const MAX_TEXT_CHARS: usize = 2000;
/// How many session files the seed opens, newest first. The seed is a one-time
/// courtesy, not a full archive; the newest sessions are where the habits are.
const MAX_SEED_FILES: usize = 60;
/// How many distinct sentences the seed keeps.
const MAX_SEED_UNIQUE: usize = 500;
/// The seed's time budget. Scanning is I/O-bound and a workspace can hold years
/// of sessions; whatever is collected by now is enough to make the first day
/// feel familiar, and the rest arrives with each send.
const SEED_BUDGET: Duration = Duration::from_millis(1500);

static WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn history_dir() -> Result<PathBuf, String> {
    let home = home_dir().ok_or("the home directory could not be read")?;
    Ok(home.join(RUNTIME_DIR).join(DIR))
}

/// A key is the hex hash the front end minted. Anything else is refused rather
/// than resolved: this is the one place a string becomes a file name.
fn file_path(key: &str) -> Result<PathBuf, String> {
    let valid = (1..=64).contains(&key.len())
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !valid {
        return Err(format!("{key} is not a prompt-history key"));
    }
    Ok(history_dir()?.join(format!("{key}.jsonl")))
}

/// Read one workspace's sidecar, or `None` when it has not been written yet.
#[tauri::command]
pub(crate) fn prompt_history_read(key: String) -> Result<Option<String>, String> {
    let path = file_path(&key)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("{} could not be read: {err}", path.display())),
    }
}

/// Append one sent sentence. The line is serialised here, not by the caller, so
/// the escaping is the same on every send and a sentence with a newline cannot
/// break the file's one-record-per-line shape.
#[tauri::command]
pub(crate) fn prompt_history_append(key: String, text: String, at: u64) -> Result<(), String> {
    let path = file_path(&key)?;
    append_line(&path, &text, at)
}

fn append_line(path: &Path, text: &str, at: u64) -> Result<(), String> {
    let prompt = text.trim();
    if prompt.is_empty() || prompt.chars().count() > MAX_TEXT_CHARS {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)
            .map_err(|err| format!("{} could not be created: {err}", dir.display()))?;
    }
    let record = serde_json::json!({
        "v": RECORD_VERSION,
        "text": prompt,
        "at": at,
        "count": 1,
    });
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("{} could not be opened: {err}", path.display()))?;
    let mut line = record.to_string();
    line.push('\n');
    file.write_all(line.as_bytes())
        .map_err(|err| format!("{} could not be appended: {err}", path.display()))
}

/// Replace one workspace's sidecar — the load-time compaction, and the seed's
/// one write. Atomic by the same temp-then-rename rule `desktop_data` follows:
/// this is the only operation that can lose the whole file.
#[tauri::command]
pub(crate) fn prompt_history_write(key: String, text: String) -> Result<(), String> {
    let path = file_path(&key)?;
    write_atomic(&path, &text)
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(dir)
        .map_err(|err| format!("{} could not be created: {err}", dir.display()))?;
    let unique = WRITE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("prompts"),
        std::process::id(),
        unique
    ));
    fs::write(&tmp, text)
        .map_err(|err| format!("{} could not be written: {err}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        format!("{} could not be replaced: {err}", path.display())
    })
}

/// Seed a workspace's sidecar from its saved sessions, once.
///
/// The scan runs on a blocking thread: the file reads are the slow half and a
/// sync command would hold the IPC thread while it works. `None` means "nothing
/// to do" — a sidecar that already has content (including one another window
/// just seeded) is never overwritten.
#[tauri::command]
pub(crate) async fn prompt_history_seed(
    workspace: String,
    key: String,
) -> Result<Option<String>, String> {
    let path = file_path(&key)?;
    if fs::metadata(&path).map(|meta| meta.len() > 0).unwrap_or(false) {
        return Ok(None);
    }
    let root = PathBuf::from(workspace);
    let text = tauri::async_runtime::spawn_blocking(move || seed_text(&root))
        .await
        .map_err(|err| format!("the prompt history seed failed: {err}"))??;
    if text.is_empty() {
        return Ok(None);
    }
    // Re-checked after the scan: a second window may have sent a sentence while
    // this one was reading, and its single line is newer than a backfill.
    if fs::metadata(&path).map(|meta| meta.len() > 0).unwrap_or(false) {
        return Ok(None);
    }
    write_atomic(&path, &text)?;
    Ok(Some(text))
}

/// Collect the sentences worth offering from one workspace's session files.
///
/// Newest sessions first, because that is where the current habits are, and the
/// budget stops a workspace with years of history from turning a first keystroke
/// into a batch job. The filters are the difference between "history" and "every
/// user-role message": the runtime writes its own user-role notes (`<goal_round>`
/// and friends), a picture-only message is a path, and a pasted document is not
/// a sentence. All three would be noise in the suggestion line.
fn seed_text(workspace: &Path) -> Result<String, String> {
    let sessions = workspace.join(RUNTIME_DIR).join(SESSIONS_DIR);
    let entries = match fs::read_dir(&sessions) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(err) => return Err(format!("{} could not be read: {err}", sessions.display())),
    };

    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(id) = name.strip_suffix(SUFFIX) else {
            continue;
        };
        // A child session's prompts belong to a task the person already ran;
        // they are not what they would type again.
        if id.starts_with(CHILD_PREFIX) || !valid_session_id(id) {
            continue;
        }
        let at = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|delta| delta.as_secs())
            .unwrap_or(0);
        files.push((at, path));
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.truncate(MAX_SEED_FILES);

    let started = Instant::now();
    let mut merged: HashMap<String, (u64, u64)> = HashMap::new();
    for (at, path) in files {
        if started.elapsed() >= SEED_BUDGET || merged.len() >= MAX_SEED_UNIQUE {
            break;
        }
        for_each_message(&path, |message| {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            if role != "user" {
                return true;
            }
            let text = message_text(message);
            let Some(prompt) = seedable(&text) else {
                return true;
            };
            let slot = merged.entry(prompt).or_insert((0, 0));
            slot.0 += 1;
            slot.1 = slot.1.max(at);
            merged.len() < MAX_SEED_UNIQUE
        });
    }

    if merged.is_empty() {
        return Ok(String::new());
    }
    let mut rows: Vec<(String, u64, u64)> = merged
        .into_iter()
        .map(|(text, (count, at))| (text, count, at))
        .collect();
    rows.sort_by(|a, b| a.2.cmp(&b.2));
    let mut out = String::new();
    for (text, count, at) in rows {
        let record = serde_json::json!({
            "v": RECORD_VERSION,
            "text": text,
            "at": at,
            "count": count,
        });
        out.push_str(&record.to_string());
        out.push('\n');
    }
    Ok(out)
}

/// Whether one stored user-role message is a sentence to offer back.
fn seedable(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let chars = trimmed.chars().count();
    if chars == 0 || chars > MAX_TEXT_CHARS {
        return None;
    }
    // The runtime's own user-role notes: `<goal_round>`, and anything else it
    // inserts as a marker.
    if trimmed.starts_with('<') {
        return None;
    }
    // A picture-only message's text is the picture's name in brackets.
    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        return None;
    }
    // A path on its own is an attachment, not a sentence.
    if !trimmed.contains(char::is_whitespace) && (trimmed.contains('/') || trimmed.contains('\\')) {
        return None;
    }
    Some(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "tudouni-prompt-{}-{unique}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("a temp directory");
        dir
    }

    #[test]
    fn an_append_keeps_the_lines_before_it() {
        let dir = temp_dir();
        let path = dir.join("prompts.jsonl");
        append_line(&path, "请 pull 一下", 10).unwrap();
        append_line(&path, "please run the tests", 20).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("请 pull 一下"));
        assert!(lines[1].contains("please run the tests"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sentence_with_a_newline_stays_one_record() {
        let dir = temp_dir();
        let path = dir.join("prompts.jsonl");
        append_line(&path, "first line\nsecond line", 10).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().count(), 1);
        let parsed: Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(parsed["text"], "first line\nsecond line");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn seedable_drops_markers_attachments_and_documents() {
        assert_eq!(seedable("请 pull 一下").as_deref(), Some("请 pull 一下"));
        assert_eq!(seedable("<goal_round>\nkeep going\n</goal_round>"), None);
        assert_eq!(seedable("[Image: shot.png]"), None);
        assert_eq!(seedable("/tmp/tudouni/shot.png"), None);
        assert_eq!(seedable(&"x".repeat(MAX_TEXT_CHARS + 1)), None);
    }

    #[test]
    fn the_seed_reads_user_messages_and_skips_the_rest() {
        let workspace = temp_dir();
        let sessions = workspace.join(RUNTIME_DIR).join(SESSIONS_DIR);
        fs::create_dir_all(&sessions).unwrap();
        let write = |id: &str, lines: &[&str]| {
            let mut body = String::new();
            for line in lines {
                body.push_str(line);
                body.push('\n');
            }
            fs::write(sessions.join(format!("{id}.jsonl")), body).unwrap();
        };
        write(
            "one",
            &[
                r#"{"v":1,"type":"ctx","context":{}}"#,
                r#"{"v":1,"type":"msg","message":{"role":"user","content":"请 pull 代码"}}"#,
                r#"{"v":1,"type":"msg","message":{"role":"assistant","content":"好的，我先看看"}}"#,
                r#"{"v":1,"type":"msg","message":{"role":"user","content":"<goal_round>继续</goal_round>"}}"#,
                r#"{"v":1,"type":"msg","message":{"role":"user","content":"请 pull 代码"}}"#,
                r#"{"v":1,"type":"msg","message":{"role":"user","content":[{"type":"text","text":"看下这张图"},{"type":"image","name":"shot.png"}]}}"#,
                "not json",
            ],
        );
        write(
            "sub-child",
            &[r#"{"v":1,"type":"msg","message":{"role":"user","content":"child prompt"}}"#],
        );
        let text = seed_text(&workspace).unwrap();
        assert!(text.contains("请 pull 代码"));
        assert!(text.contains("看下这张图"));
        assert!(!text.contains("好的"));
        assert!(!text.contains("goal_round"));
        assert!(!text.contains("child prompt"));
        let count = text
            .lines()
            .find(|line| line.contains("请 pull 代码"))
            .and_then(|line| serde_json::from_str::<Value>(line).ok())
            .and_then(|record| record["count"].as_u64())
            .unwrap();
        assert_eq!(count, 2);
        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn a_missing_sessions_directory_is_an_empty_seed() {
        let workspace = temp_dir();
        assert_eq!(seed_text(&workspace).unwrap(), "");
        let _ = fs::remove_dir_all(&workspace);
    }
}
