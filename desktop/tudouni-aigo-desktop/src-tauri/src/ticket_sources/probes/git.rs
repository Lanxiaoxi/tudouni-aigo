//! `git.remote` and `git.local`: branches and refs as items, read by the
//! system `git` (no libgit2: the user's own git already knows their
//! credentials, proxies and `safe.directory` rules).

use super::process;
use super::{opt_str, req_str, timeout_of, Item, ProbeCtx, ProbeOutput};
use crate::ticket_sources::filter::glob_match;
use serde_json::{json, Map, Value};
use std::path::Path;

const DEFAULT_REFS: &str = "refs/heads/*";
const DEFAULT_BRANCHES: &str = "*";

pub(super) fn run(kind: &str, probe: &Map<String, Value>, _ctx: &ProbeCtx) -> Result<ProbeOutput, String> {
    match kind {
        "git.remote" => remote(probe),
        "git.local" => local(probe),
        _ => Err(format!("{kind} is not a git probe")),
    }
}

pub(super) fn validate(kind: &str, probe: &Map<String, Value>) -> Result<(), String> {
    match kind {
        "git.remote" => {
            let url = req_str(probe, "url")?;
            // The url is passed as a bare argument to `git ls-remote`; a leading
            // dash would be read as an option instead of a repository.
            if url.trim_start().starts_with('-') {
                return Err("probe parameter \"url\" must not start with '-'".to_string());
            }
            opt_str(probe, "refs")?;
            Ok(())
        }
        "git.local" => {
            req_str(probe, "path")?;
            opt_str(probe, "branches")?;
            Ok(())
        }
        _ => Ok(()),
    }
}

fn remote(probe: &Map<String, Value>) -> Result<ProbeOutput, String> {
    let url = req_str(probe, "url")?;
    let refs = opt_str(probe, "refs")?.unwrap_or(DEFAULT_REFS);
    let timeout = timeout_of(probe)?;
    let args = vec!["ls-remote".to_string(), url.to_string(), refs.to_string()];
    let stdout = process::run_ok("git", &args, None, timeout).map_err(|e| format!("git ls-remote failed: {e}"))?;
    Ok(ProbeOutput { items: parse_ls_remote(&stdout), warnings: Vec::new() })
}

fn local(probe: &Map<String, Value>) -> Result<ProbeOutput, String> {
    let path = req_str(probe, "path")?;
    let pattern = opt_str(probe, "branches")?.unwrap_or(DEFAULT_BRANCHES);
    let timeout = timeout_of(probe)?;
    // Checked up front so the error names the path instead of git's "cannot
    // change to ..." which does not say which probe parameter was wrong.
    if !Path::new(path).is_dir() {
        return Err(format!("git.local: {path} is not an existing directory"));
    }
    let args: Vec<String> = [
        "-C",
        path,
        "for-each-ref",
        // %09 is a tab: branch names and shas cannot contain one, so it is a
        // safe separator (the subject comes last and may contain anything).
        "--format=%(refname:short)%09%(objectname)%09%(contents:subject)",
        "refs/heads",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let stdout = process::run_ok("git", &args, None, timeout).map_err(|e| format!("git for-each-ref failed in {path}: {e}"))?;
    let items = parse_for_each_ref(&stdout)
        .into_iter()
        .filter(|item| glob_match(pattern, &item.key))
        .collect();
    Ok(ProbeOutput { items, warnings: Vec::new() })
}

/// `git ls-remote` output: one `<sha>\t<ref>` per line.
///
/// Peeled tag lines (`refs/tags/v1^{}`) are dropped: they repeat the tag under
/// the commit's sha, and keeping both would make one tag look like two items.
pub(super) fn parse_ls_remote(text: &str) -> Vec<Item> {
    let mut items = Vec::new();
    for line in text.lines() {
        let (sha, name) = match line.trim_end_matches('\r').split_once('\t') {
            Some(pair) => pair,
            None => continue,
        };
        let (sha, name) = (sha.trim(), name.trim());
        if sha.is_empty() || name.is_empty() || name.ends_with("^{}") {
            continue;
        }
        items.push(Item {
            key: name.to_string(),
            version: sha.to_string(),
            fields: json!({ "ref": name, "sha": sha }),
        });
    }
    items
}

/// `git for-each-ref` output in the `branch\tsha\tsubject` format above.
pub(super) fn parse_for_each_ref(text: &str) -> Vec<Item> {
    let mut items = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        let mut parts = line.splitn(3, '\t');
        let branch = parts.next().unwrap_or("").trim();
        let sha = parts.next().unwrap_or("").trim();
        let subject = parts.next().unwrap_or("").trim();
        if branch.is_empty() || sha.is_empty() {
            continue;
        }
        items.push(Item {
            key: branch.to_string(),
            version: sha.to_string(),
            fields: json!({ "branch": branch, "sha": sha, "subject": subject }),
        });
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;

    const CTX: ProbeCtx = ProbeCtx { now_ms: 0, tz_offset_minutes: 0 };

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    /// A scratch directory named after the pid, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!("tudouni-git-probe-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            TempDir(path)
        }
        fn path_str(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        process::run_ok("git", &args, Some(dir), Duration::from_secs(60)).unwrap()
    }

    /// A repository with `main` and `feature/x` on one commit; returns the sha.
    fn sample_repo(tag: &str) -> (TempDir, String) {
        let tmp = TempDir::new(tag);
        git(&tmp.0, &["init", "-q"]);
        // The default branch name depends on the user's git config.
        git(&tmp.0, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(&tmp.0, &["config", "user.name", "Probe Test"]);
        git(&tmp.0, &["config", "user.email", "probe@example.invalid"]);
        git(&tmp.0, &["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "first commit"]);
        git(&tmp.0, &["branch", "feature/x"]);
        let sha = git(&tmp.0, &["rev-parse", "HEAD"]).trim().to_string();
        (tmp, sha)
    }

    #[test]
    fn ls_remote_lines_become_items_and_peeled_lines_are_dropped() {
        let sha_a = "a".repeat(40);
        let sha_b = "b".repeat(40);
        let sha_c = "c".repeat(40);
        let text = format!(
            "{sha_a}\trefs/heads/main\r\n{sha_b}\trefs/tags/v1\n{sha_c}\trefs/tags/v1^{{}}\n\nnot a ref line\n"
        );
        let items = parse_ls_remote(&text);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].key, "refs/heads/main");
        assert_eq!(items[0].version, sha_a);
        assert_eq!(items[0].fields, json!({"ref": "refs/heads/main", "sha": sha_a}));
        assert_eq!(items[1].key, "refs/tags/v1");
        assert_eq!(items[1].version, sha_b);
    }

    #[test]
    fn ls_remote_with_no_output_is_no_items() {
        assert!(parse_ls_remote("").is_empty());
        assert!(parse_ls_remote("\n\n").is_empty());
    }

    #[test]
    fn for_each_ref_lines_become_items() {
        let text = "main\t1111\tFix a thing\nfeature/x\t2222\t\nodd\t3333\tsubject\twith a tab\n\n";
        let items = parse_for_each_ref(text);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].key, "main");
        assert_eq!(items[0].fields, json!({"branch": "main", "sha": "1111", "subject": "Fix a thing"}));
        assert_eq!(items[1].fields["subject"], "");
        assert_eq!(items[2].fields["subject"], "subject\twith a tab");
        assert!(parse_for_each_ref("").is_empty());
    }

    #[test]
    fn validate_checks_required_parameters() {
        assert!(validate("git.remote", &obj(json!({"kind": "git.remote"}))).is_err());
        assert!(validate("git.remote", &obj(json!({"url": "--upload-pack=x"}))).is_err());
        assert!(validate("git.remote", &obj(json!({"url": "https://example.invalid/r.git"}))).is_ok());
        assert!(validate("git.local", &obj(json!({"kind": "git.local"}))).is_err());
        assert!(validate("git.local", &obj(json!({"path": "C:/repo", "branches": 3}))).is_err());
        assert!(validate("git.local", &obj(json!({"path": "C:/repo"}))).is_ok());
    }

    #[test]
    fn git_local_lists_branches_with_their_shas() {
        let (tmp, sha) = sample_repo("local");
        let probe = obj(json!({"kind": "git.local", "path": tmp.path_str()}));
        let out = run("git.local", &probe, &CTX).unwrap();
        let keys: Vec<&str> = out.items.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(keys, vec!["feature/x", "main"]);
        for item in &out.items {
            assert_eq!(item.version, sha);
            assert_eq!(item.fields["sha"], sha.as_str());
            assert_eq!(item.fields["subject"], "first commit");
        }
        assert_eq!(out.items[0].fields["branch"], "feature/x");

        let probe = obj(json!({"kind": "git.local", "path": tmp.path_str(), "branches": "FEAT*"}));
        let out = run("git.local", &probe, &CTX).unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.items[0].key, "feature/x");
    }

    #[test]
    fn git_local_reports_a_missing_directory() {
        let probe = obj(json!({"kind": "git.local", "path": "Z:/definitely/not/here"}));
        let err = run("git.local", &probe, &CTX).unwrap_err();
        assert!(err.contains("Z:/definitely/not/here"), "{err}");
    }

    #[test]
    fn git_remote_reads_refs_from_a_local_repository() {
        let (tmp, sha) = sample_repo("remote");
        let probe = obj(json!({"kind": "git.remote", "url": tmp.path_str()}));
        let out = run("git.remote", &probe, &CTX).unwrap();
        let keys: Vec<&str> = out.items.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(keys, vec!["refs/heads/feature/x", "refs/heads/main"]);
        assert!(out.items.iter().all(|i| i.version == sha));
        assert_eq!(out.items[1].fields, json!({"ref": "refs/heads/main", "sha": sha}));
    }
}
