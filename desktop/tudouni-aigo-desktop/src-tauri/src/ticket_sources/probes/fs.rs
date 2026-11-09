//! `file` and `dir`: files on this machine as items.
//!
//! `file` takes an absolute glob and walks only the part of the tree the glob
//! can reach, starting from its fixed prefix directory. `dir` looks at the
//! files directly inside one directory. Neither uses a glob crate: the
//! language is `*`, `?` and a whole-segment `**`, and the name matching is the
//! same `glob_match` the rest of the Source layer uses.

use super::{opt_str, req_str, sha256_hex, Item, ProbeCtx, ProbeOutput};
use crate::ticket_sources::filter::glob_match;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Bounds that keep one badly written glob (`C:/**`) from hanging a scan.
#[derive(Debug, Clone, Copy)]
struct Limits {
    /// Directory entries examined across the whole walk.
    entries: usize,
    /// Files above this many bytes are versioned by `size-mtimeMs` instead of
    /// being read and hashed on every scan.
    hash_bytes: u64,
}

const LIMITS: Limits = Limits { entries: 10_000, hash_bytes: 64 * 1024 * 1024 };

/// Warnings are for the person reading the Source's status; a directory full
/// of unreadable files should not turn that into a wall of text.
const MAX_WARNINGS: usize = 10;

pub(super) fn run(kind: &str, probe: &Map<String, Value>, _ctx: &ProbeCtx) -> Result<ProbeOutput, String> {
    match kind {
        "file" => scan_glob(req_str(probe, "glob")?, LIMITS),
        "dir" => scan_dir(req_str(probe, "path")?, opt_str(probe, "pattern")?.unwrap_or("*")),
        _ => Err(format!("{kind} is not a file probe")),
    }
}

pub(super) fn validate(kind: &str, probe: &Map<String, Value>) -> Result<(), String> {
    match kind {
        "file" => plan_glob(req_str(probe, "glob")?).map(|_| ()),
        "dir" => {
            req_str(probe, "path")?;
            opt_str(probe, "pattern")?;
            Ok(())
        }
        _ => Ok(()),
    }
}

/* ============================================================
   Shared helpers
   ============================================================ */

/// A path as the user typed it, with separators the platform understands.
/// Items keep one spelling per platform so a key does not flip between
/// `C:/x\a.log` and `C:\x\a.log` from one scan to the next.
fn native(text: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(text.replace('/', "\\"))
    } else {
        PathBuf::from(text)
    }
}

fn mtime_ms(meta: &Metadata) -> i64 {
    match meta.modified().map(|t| t.duration_since(UNIX_EPOCH)) {
        Ok(Ok(since)) => since.as_millis() as i64,
        // Before 1970: report it as negative rather than pretending it is 0.
        Ok(Err(before)) => -(before.duration().as_millis() as i64),
        Err(_) => 0,
    }
}

fn file_name_of(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn file_fields(path: &str, name: &str, size: u64, mtime: i64) -> Value {
    json!({ "path": path, "name": name, "size": size, "mtimeMs": mtime })
}

fn warn(warnings: &mut Vec<String>, message: String) {
    if warnings.len() < MAX_WARNINGS {
        warnings.push(message);
    } else if warnings.len() == MAX_WARNINGS {
        warnings.push("further warnings omitted".to_string());
    }
}

/* ============================================================
   dir
   ============================================================ */

fn scan_dir(path: &str, pattern: &str) -> Result<ProbeOutput, String> {
    let dir = native(path);
    let meta = std::fs::metadata(&dir).map_err(|e| format!("dir: {path} does not exist or cannot be read ({e})"))?;
    if !meta.is_dir() {
        return Err(format!("dir: {path} is not a directory"));
    }
    let reader = std::fs::read_dir(&dir).map_err(|e| format!("dir: {path} cannot be listed ({e})"))?;

    let mut items = Vec::new();
    let mut warnings = Vec::new();
    for entry in reader {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                warn(&mut warnings, format!("an entry of {path} could not be read: {e}"));
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if !glob_match(pattern, &name) {
            continue;
        }
        let full = entry.path();
        // `metadata` follows a symlink, so a link to a file counts as a file
        // and a link to a directory does not.
        let meta = match std::fs::metadata(&full) {
            Ok(meta) => meta,
            Err(e) => {
                warn(&mut warnings, format!("{} could not be inspected: {e}", full.display()));
                continue;
            }
        };
        if !meta.is_file() {
            continue;
        }
        let (size, mtime) = (meta.len(), mtime_ms(&meta));
        items.push(Item {
            key: name.clone(),
            version: format!("{size}-{mtime}"),
            fields: file_fields(&full.to_string_lossy(), &name, size, mtime),
        });
    }
    items.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(ProbeOutput { items, warnings })
}

/* ============================================================
   file
   ============================================================ */

/// A glob split into the directory it starts from and the segments to match
/// below it.
#[derive(Debug, PartialEq)]
struct GlobPlan {
    /// The longest leading run of segments with no wildcard, as a path.
    base: String,
    /// Segments below `base`. Empty means the glob had no wildcard at all.
    rest: Vec<String>,
}

fn has_wildcard(segment: &str) -> bool {
    segment.contains('*') || segment.contains('?')
}

/// Split a glob into base and segments. Purely textual: it is also what
/// `validate` runs, and validation must not touch the disk.
fn plan_glob(glob: &str) -> Result<GlobPlan, String> {
    // Both separators are accepted because people paste paths from Explorer
    // and from config files alike. A `\` never escapes anything here.
    let normalized = glob.trim().replace('\\', "/");
    let segments: Vec<&str> = normalized.split('/').collect();
    let first_wild = segments.iter().position(|s| has_wildcard(s));
    let fixed_end = first_wild.unwrap_or(segments.len());

    let mut prefix: Vec<&str> = segments[..fixed_end].to_vec();
    if first_wild.is_none() {
        // A trailing slash on a plain path says nothing about what to match.
        while prefix.len() > 1 && prefix.last() == Some(&"") {
            prefix.pop();
        }
    }
    let not_absolute = || format!("probe parameter \"glob\" must be an absolute path, got {glob:?}");
    if prefix.is_empty() {
        return Err(not_absolute());
    }
    let mut base = prefix.join("/");
    if base.is_empty() {
        // The glob began with a bare "/".
        base.push('/');
    } else if prefix.len() == 1 && base.ends_with(':') {
        // "C:" alone means "the current directory on C:"; "C:/" is the root.
        base.push('/');
    }
    if !native(&base).is_absolute() {
        return Err(not_absolute());
    }

    let rest = segments[fixed_end..].iter().filter(|s| !s.is_empty()).map(|s| s.to_string()).collect();
    Ok(GlobPlan { base, rest })
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    File,
    /// A real directory, safe to descend into.
    Dir,
    /// A symlink to a directory, a socket, a broken link…: never matched and
    /// never entered, so a link back up the tree cannot make the walk cyclic.
    Other,
}

struct Entry {
    name: String,
    path: PathBuf,
    kind: Kind,
}

struct Walk {
    limits: Limits,
    root: String,
    visited: usize,
    /// Keyed by path so a file reachable twice (two `**`) is listed once, and
    /// so the output order is the path order.
    found: BTreeMap<String, PathBuf>,
    warnings: Vec<String>,
}

impl Walk {
    /// The entries of `dir`, counted against the budget. An unreadable
    /// directory is a warning, not a failure: one locked folder should not
    /// blind a Source to every other match.
    fn list(&mut self, dir: &Path) -> Result<Vec<Entry>, String> {
        let reader = match std::fs::read_dir(dir) {
            Ok(reader) => reader,
            Err(e) => {
                warn(&mut self.warnings, format!("{} could not be read: {e}", dir.display()));
                return Ok(Vec::new());
            }
        };
        let mut out = Vec::new();
        for entry in reader {
            self.visited += 1;
            if self.visited > self.limits.entries {
                return Err(format!(
                    "file: more than {} directory entries examined under {}; narrow the glob",
                    self.limits.entries, self.root
                ));
            }
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            let kind = match entry.file_type() {
                Ok(t) if t.is_symlink() => match std::fs::metadata(&path) {
                    // A link to a file is still a file worth watching.
                    Ok(m) if m.is_file() => Kind::File,
                    _ => Kind::Other,
                },
                Ok(t) if t.is_dir() => Kind::Dir,
                Ok(t) if t.is_file() => Kind::File,
                _ => Kind::Other,
            };
            out.push(Entry { name: entry.file_name().to_string_lossy().into_owned(), path, kind });
        }
        Ok(out)
    }

    fn add(&mut self, path: PathBuf) {
        self.found.insert(path.to_string_lossy().into_owned(), path);
    }
}

/// Match `segments` below `dir`.
///
/// A single segment never contains a separator, so `glob_match` is exactly
/// right for it and `*` cannot cross a directory. `**` is the only thing that
/// descends on its own: it first tries the rest of the pattern right here
/// (zero levels), then repeats itself in every real subdirectory.
fn walk(dir: &Path, segments: &[String], state: &mut Walk) -> Result<(), String> {
    let Some((segment, rest)) = segments.split_first() else { return Ok(()) };

    if segment == "**" {
        if rest.is_empty() {
            // A trailing `**` is every file at any depth.
            for entry in state.list(dir)? {
                match entry.kind {
                    Kind::File => state.add(entry.path),
                    Kind::Dir => walk(&entry.path, segments, state)?,
                    Kind::Other => {}
                }
            }
        } else {
            walk(dir, rest, state)?;
            for entry in state.list(dir)? {
                if entry.kind == Kind::Dir {
                    walk(&entry.path, segments, state)?;
                }
            }
        }
        return Ok(());
    }

    for entry in state.list(dir)? {
        if !glob_match(segment, &entry.name) {
            continue;
        }
        match entry.kind {
            Kind::File if rest.is_empty() => state.add(entry.path),
            Kind::Dir if !rest.is_empty() => walk(&entry.path, rest, state)?,
            _ => {}
        }
    }
    Ok(())
}

fn scan_glob(glob: &str, limits: Limits) -> Result<ProbeOutput, String> {
    let plan = plan_glob(glob)?;
    let base = native(&plan.base);
    let mut state = Walk {
        limits,
        root: base.display().to_string(),
        visited: 0,
        found: BTreeMap::new(),
        warnings: Vec::new(),
    };

    if plan.rest.is_empty() {
        // No wildcard: the glob names one file.
        match std::fs::metadata(&base) {
            Ok(meta) if meta.is_file() => state.add(base.clone()),
            Ok(_) => {}
            Err(e) => return Err(format!("file: {} does not exist or cannot be read ({e})", base.display())),
        }
    } else {
        if !base.is_dir() {
            return Err(format!("file: directory {} does not exist", base.display()));
        }
        // Unlike a subdirectory, an unreadable start is the whole answer.
        std::fs::read_dir(&base).map_err(|e| format!("file: {} cannot be listed ({e})", base.display()))?;
        walk(&base, &plan.rest, &mut state)?;
    }

    let mut items = Vec::new();
    let found = std::mem::take(&mut state.found);
    for path in found.values() {
        match file_item(path, limits) {
            Ok(item) => items.push(item),
            // Skipped, not fatal: a file another program holds open should not
            // fail the scan for every other file.
            Err(why) => warn(&mut state.warnings, why),
        }
    }
    Ok(ProbeOutput { items, warnings: state.warnings })
}

fn file_item(path: &Path, limits: Limits) -> Result<Item, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{} could not be inspected: {e}", path.display()))?;
    let (size, mtime) = (meta.len(), mtime_ms(&meta));
    let version = if size > limits.hash_bytes {
        format!("{size}-{mtime}")
    } else {
        let bytes = std::fs::read(path).map_err(|e| format!("{} could not be read: {e}", path.display()))?;
        sha256_hex(&bytes)
    };
    let key = path.to_string_lossy().into_owned();
    let fields = file_fields(&key, &file_name_of(path), size, mtime);
    Ok(Item { key, version, fields })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CTX: ProbeCtx = ProbeCtx { now_ms: 0, tz_offset_minutes: 0 };

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    /// A scratch directory named after the pid, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!("tudouni-fs-probe-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            TempDir(path)
        }
        fn root(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
        fn put(&self, relative: &str, content: &str) {
            let path = self.0.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Keys relative to the scratch root, always with `/`.
    fn relative_keys(tmp: &TempDir, out: &ProbeOutput) -> Vec<String> {
        let root = tmp.root();
        out.items
            .iter()
            .map(|i| i.key.strip_prefix(&root).unwrap_or(&i.key).trim_start_matches(['\\', '/']).replace('\\', "/"))
            .collect()
    }

    fn glob_run(glob: &str) -> Result<ProbeOutput, String> {
        run("file", &obj(json!({"kind": "file", "glob": glob})), &CTX)
    }

    fn sample_tree(tag: &str) -> TempDir {
        let tmp = TempDir::new(tag);
        tmp.put("a.log", "a");
        tmp.put("ab.log", "ab");
        tmp.put("note.txt", "n");
        tmp.put("sub/b.log", "b");
        tmp.put("sub/deep/c.log", "c");
        tmp
    }

    #[test]
    fn star_does_not_cross_a_directory() {
        let tmp = sample_tree("star");
        let out = glob_run(&format!("{}/*.log", tmp.root())).unwrap();
        assert_eq!(relative_keys(&tmp, &out), vec!["a.log", "ab.log"]);
        let out = glob_run(&format!("{}/*/*.log", tmp.root())).unwrap();
        assert_eq!(relative_keys(&tmp, &out), vec!["sub/b.log"]);
    }

    #[test]
    fn double_star_crosses_directories_including_zero_levels() {
        let tmp = sample_tree("dstar");
        let out = glob_run(&format!("{}/**/*.log", tmp.root())).unwrap();
        assert_eq!(relative_keys(&tmp, &out), vec!["a.log", "ab.log", "sub/b.log", "sub/deep/c.log"]);
        let out = glob_run(&format!("{}/sub/**", tmp.root())).unwrap();
        assert_eq!(relative_keys(&tmp, &out), vec!["sub/b.log", "sub/deep/c.log"]);
        // A `**` in the middle: any depth of directories, then a fixed one.
        tmp.put("x/y/sub/z.log", "z");
        let out = glob_run(&format!("{}/**/sub/*.log", tmp.root())).unwrap();
        assert_eq!(relative_keys(&tmp, &out), vec!["sub/b.log", "x/y/sub/z.log"]);
    }

    #[test]
    fn question_mark_is_exactly_one_character() {
        let tmp = sample_tree("qmark");
        let out = glob_run(&format!("{}/?.log", tmp.root())).unwrap();
        assert_eq!(relative_keys(&tmp, &out), vec!["a.log"]);
        let out = glob_run(&format!("{}/??.log", tmp.root())).unwrap();
        assert_eq!(relative_keys(&tmp, &out), vec!["ab.log"]);
    }

    #[test]
    fn matching_ignores_case_and_both_separators_work() {
        let tmp = sample_tree("case");
        let out = glob_run(&format!("{}/*.LOG", tmp.root())).unwrap();
        assert_eq!(relative_keys(&tmp, &out), vec!["a.log", "ab.log"]);
        // A fixed path segment keeps the user's spelling in the key, so case is
        // exercised with a wildcard segment, which reports the name on disk.
        let out = glob_run(&format!("{}/S?B\\*.log", tmp.root())).unwrap();
        assert_eq!(relative_keys(&tmp, &out), vec!["sub/b.log"]);
        let out = glob_run(&format!("{}\\sub/**/C.log", tmp.root())).unwrap();
        assert_eq!(relative_keys(&tmp, &out), vec!["sub/deep/c.log"]);
    }

    #[test]
    fn directories_are_never_items() {
        let tmp = sample_tree("dirs");
        std::fs::create_dir_all(tmp.0.join("folder.log")).unwrap();
        let out = glob_run(&format!("{}/*.log", tmp.root())).unwrap();
        assert_eq!(relative_keys(&tmp, &out), vec!["a.log", "ab.log"]);
    }

    #[test]
    fn items_carry_fields_and_a_content_hash() {
        let tmp = sample_tree("fields");
        let out = glob_run(&format!("{}/a.log", tmp.root())).unwrap();
        assert_eq!(out.items.len(), 1);
        let item = &out.items[0];
        assert_eq!(item.version, sha256_hex(b"a"));
        assert_eq!(item.fields["path"], item.key.as_str());
        assert_eq!(item.fields["name"], "a.log");
        assert_eq!(item.fields["size"], 1);
        assert!(item.fields["mtimeMs"].as_i64().unwrap() > 0);
    }

    #[test]
    fn changing_the_content_changes_the_version_even_at_the_same_size() {
        let tmp = sample_tree("version");
        let glob = format!("{}/a.log", tmp.root());
        let before = glob_run(&glob).unwrap().items[0].version.clone();
        assert_eq!(glob_run(&glob).unwrap().items[0].version, before);
        tmp.put("a.log", "z");
        let after = glob_run(&glob).unwrap().items[0].version.clone();
        assert_ne!(before, after);
    }

    #[test]
    fn a_big_file_is_versioned_by_size_and_mtime() {
        let tmp = sample_tree("big");
        let glob = format!("{}/ab.log", tmp.root());
        let limits = Limits { entries: 100, hash_bytes: 1 };
        let out = scan_glob(&glob, limits).unwrap();
        let item = &out.items[0];
        assert_eq!(item.version, format!("2-{}", item.fields["mtimeMs"]));
    }

    #[test]
    fn a_missing_path_names_itself() {
        let tmp = sample_tree("missing");
        let err = glob_run(&format!("{}/nope/*.log", tmp.root())).unwrap_err();
        assert!(err.contains("nope"), "{err}");
        let err = glob_run(&format!("{}/nope.log", tmp.root())).unwrap_err();
        assert!(err.contains("nope.log"), "{err}");
        // A real directory with no match is an empty answer, not an error.
        let out = glob_run(&format!("{}/*.zzz", tmp.root())).unwrap();
        assert!(out.items.is_empty());
    }

    #[test]
    fn the_walk_is_bounded() {
        let tmp = TempDir::new("cap");
        for i in 0..5 {
            tmp.put(&format!("f{i}.log"), "x");
        }
        let limits = Limits { entries: 3, hash_bytes: LIMITS.hash_bytes };
        let err = scan_glob(&format!("{}/**/*.log", tmp.root()), limits).unwrap_err();
        assert!(err.contains("narrow the glob"), "{err}");
    }

    #[test]
    fn globs_must_be_absolute() {
        assert!(plan_glob("*.log").is_err());
        assert!(plan_glob("logs/*.log").is_err());
        assert!(plan_glob("").is_err());
        assert!(validate("file", &obj(json!({}))).is_err());
        let abs = if cfg!(windows) { "C:/logs/**/*.log" } else { "/logs/**/*.log" };
        assert!(validate("file", &obj(json!({"glob": abs}))).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn the_glob_plan_splits_at_the_first_wildcard() {
        let plan = plan_glob("C:\\Users\\me/logs\\**\\*.log").unwrap();
        assert_eq!(plan, GlobPlan { base: "C:/Users/me/logs".into(), rest: vec!["**".into(), "*.log".into()] });
        let plan = plan_glob("C:/*.txt").unwrap();
        assert_eq!(plan.base, "C:/");
        let plan = plan_glob("C:/a/b.txt").unwrap();
        assert_eq!(plan, GlobPlan { base: "C:/a/b.txt".into(), rest: vec![] });
        assert!(plan_glob("/no/drive/*.txt").is_err());
    }

    #[test]
    fn dir_lists_only_the_first_level_filtered_by_pattern() {
        let tmp = sample_tree("dir");
        tmp.put("UP.LOG", "up");
        let probe = obj(json!({"kind": "dir", "path": tmp.root(), "pattern": "*.log"}));
        let out = run("dir", &probe, &CTX).unwrap();
        let keys: Vec<&str> = out.items.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(keys, vec!["UP.LOG", "a.log", "ab.log"]);
        let item = &out.items[1];
        let size = item.fields["size"].as_u64().unwrap();
        let mtime = item.fields["mtimeMs"].as_i64().unwrap();
        assert_eq!(item.version, format!("{size}-{mtime}"));
        assert_eq!(item.fields["name"], "a.log");
        assert!(item.fields["path"].as_str().unwrap().ends_with("a.log"));

        // No pattern: every file, still not the folder or what is inside it.
        let out = run("dir", &obj(json!({"kind": "dir", "path": tmp.root()})), &CTX).unwrap();
        let keys: Vec<&str> = out.items.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(keys, vec!["UP.LOG", "a.log", "ab.log", "note.txt"]);
    }

    #[test]
    fn dir_version_follows_the_file() {
        let tmp = sample_tree("dirversion");
        let probe = obj(json!({"kind": "dir", "path": tmp.root(), "pattern": "note.txt"}));
        let before = run("dir", &probe, &CTX).unwrap().items[0].version.clone();
        tmp.put("note.txt", "now longer");
        let after = run("dir", &probe, &CTX).unwrap().items[0].version.clone();
        assert_ne!(before, after);
    }

    #[test]
    fn dir_reports_a_missing_path_or_a_file() {
        let tmp = sample_tree("dirmissing");
        let missing = format!("{}/nope", tmp.root());
        let err = run("dir", &obj(json!({"kind": "dir", "path": missing})), &CTX).unwrap_err();
        assert!(err.contains("nope"), "{err}");
        let file = format!("{}/a.log", tmp.root());
        let err = run("dir", &obj(json!({"kind": "dir", "path": file})), &CTX).unwrap_err();
        assert!(err.contains("not a directory"), "{err}");
    }

    #[test]
    fn dir_validate_checks_parameters() {
        assert!(validate("dir", &obj(json!({}))).is_err());
        assert!(validate("dir", &obj(json!({"path": "C:/x", "pattern": 3}))).is_err());
        assert!(validate("dir", &obj(json!({"path": "C:/x"}))).is_ok());
    }
}
