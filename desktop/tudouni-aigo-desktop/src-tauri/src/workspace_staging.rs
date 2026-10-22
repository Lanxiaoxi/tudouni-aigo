//! Where a pasted picture lives, and which directories a runtime may be
//! started in.
//!
//! The staging area has to be **inside the workspace** (the runtime's
//! `SafePath` refuses anything else), so both the rule and the sweep that
//! empties a finished session's slice belong together. `unsafe_workspace` is
//! shared with `workspace_check` so the pre-check and the actual start cannot
//! drift apart.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::bridge::report_stderr;

/// Where a pasted picture is stashed, under the workspace.
///
/// It has to be **inside the workspace**, and that is not a preference: the
/// runtime resolves a picture named in the user's sentence through
/// `tools.Workspace.SafePath`, which refuses anything outside the working
/// directory. A file written to `%TEMP%` would produce a path that looks
/// perfectly ordinary in the sentence and can never be attached.
///
/// `.tudouni/` specifically, because that is already this program's per-workspace
/// state directory (sessions, the audit log, artifacts, job output) and it is in
/// the repository's `.gitignore`. Writing screenshots into the user's project tree
/// would leave them in `git status` for a feature whose whole point is being
/// cheap to use.
pub(crate) const PASTE_DIR: &str = ".tudouni";

pub(crate) const PASTE_SUBDIR: &str = "paste";

/// Remove staging directories that belong to no live child.
///
/// Leftovers are swept when a session starts, which used to be "when the runtime
/// starts" and was safe because there was only one. With several sessions that
/// moment is no longer quiescent: another session may be mid-paste, and its file
/// has to survive this one's start. So the sweep is by **membership** — anything
/// not owned by a live child is a leftover — rather than by "everything except
/// mine".
///
/// A failure is reported on the diagnostics channel and nothing more: refusing to
/// start a session because an old screenshot could not be deleted would trade a
/// real capability for a tidy directory.
pub(crate) fn sweep_staging(app: &AppHandle, workspace: &Path, live: &HashSet<PathBuf>) {
    let root = workspace.join(PASTE_DIR).join(PASTE_SUBDIR);
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        // The ordinary case on a first run.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            report_stderr(app, 0, format!("could not read {}: {error}", root.display()));
            return;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if live.contains(&path) {
            continue;
        }
        if let Err(error) = fs::remove_dir_all(&path) {
            report_stderr(app, 0, format!("could not clear {}: {error}", path.display()));
        }
    }
}

/// The names of the directories the runtime refuses as a workspace, mirroring
/// `paths.UnsafeWorkspace`. Checked here so the refusal is a message rather than
/// a silent exit.
pub(crate) fn unsafe_workspace(dir: &Path) -> Option<&'static str> {
    let absolute = dir.canonicalize().ok()?;
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);

    if let Some(home) = home {
        if let Ok(home) = home.canonicalize() {
            if absolute == home {
                return Some("it is the home directory");
            }
            if home.starts_with(&absolute) {
                return Some("it is an ancestor of the home directory");
            }
        }
    }

    // A volume root: no parent, or a parent equal to itself.
    if absolute.parent().is_none() {
        return Some("it is a volume root");
    }

    None
}

/// Can the runtime be started in this directory? `None` means yes; otherwise the
/// reason, already written for a person.
///
/// This is the same rule `spawn` applies, exposed so a workspace can be checked
/// **before** it is offered as somewhere to go. Without it, bookmarking the home
/// directory produced a row that looked exactly like a usable one, and pressing
/// it replaced the whole screen with a start-up failure — a refusal the person
/// could have been told about at the moment they chose the directory, when they
/// still had the choice in front of them.
///
/// The rule itself is not duplicated: `unsafe_workspace` is shared, so the
/// pre-check and the actual start cannot drift apart.
#[tauri::command]
pub(crate) fn workspace_check(path: String) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Some("no directory was given".to_string());
    }
    let dir = PathBuf::from(trimmed);
    if !dir.is_dir() {
        return Some(format!("{} is not a directory", dir.display()));
    }
    unsafe_workspace(&dir).map(|kind| {
        format!(
            "{} cannot be used ({kind}): the runtime refuses it, because the file \
             tools' boundary would be the whole machine",
            dir.display()
        )
    })
}
