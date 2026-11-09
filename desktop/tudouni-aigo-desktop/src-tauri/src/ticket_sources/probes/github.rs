//! The `github.*` probes: GitHub's REST API read through the system `curl`.
//!
//! The HTTP itself (curl arguments, the `--fail-with-body` fallback, masking
//! credentials in errors) lives in `http_json.rs`, so there is one place that
//! decides how a request is made. This file knows GitHub's URLs, its auth
//! chain, and how to turn each response into items. The response-to-item
//! functions are pure so they are tested without a network.

use super::http_json::{fetch, is_http_url, Request};
use super::{opt_bool, opt_int, opt_str, process, req_str, timeout_of, Item, ProbeCtx, ProbeOutput};
use serde_json::{json, Map, Value};
use std::time::Duration;

const DEFAULT_API_BASE: &str = "https://api.github.com";
const DEFAULT_TOKEN_ENV: &str = "GITHUB_TOKEN";
/// `gh auth token` reads a local file; if it takes longer than this it is stuck
/// (a credential-helper prompt), and anonymous access is better than a hang.
const GH_TIMEOUT: Duration = Duration::from_secs(10);

/* ============================================================
   Parameters
   ============================================================ */

/// What every `github.*` kind takes.
#[derive(Debug)]
struct Common {
    repo: String,
    api_base: String,
    per_page: i64,
    proxy: Option<String>,
    token_env: String,
    timeout: Duration,
}

/// What differs per kind, checked once so `validate` and `run` cannot disagree.
#[derive(Debug, PartialEq)]
enum Plan {
    Pulls { state: String, base: Option<String> },
    Issues { state: String, labels: Option<String> },
    Branch { branch: String },
    Releases { include_prerelease: bool },
    Checks { git_ref: String },
}

/// `owner/name`, with the characters GitHub allows. Strict on purpose: the
/// value goes into a URL path next to the user's token.
fn valid_repo(repo: &str) -> bool {
    let Some((owner, name)) = repo.split_once('/') else { return false };
    let part_ok = |p: &str| {
        !p.is_empty() && p != "." && p != ".." && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    };
    part_ok(owner) && part_ok(name)
}

/// A branch name, tag or sha that is safe to put in a URL path. `.` and `..`
/// segments are refused because curl collapses them, which would let a ref
/// walk out of `/repos/{repo}/commits/` to another endpoint with our token.
fn valid_ref(name: &str) -> bool {
    !name.is_empty() && !name.chars().any(|c| c.is_control()) && name.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
}

fn state_of(probe: &Map<String, Value>) -> Result<String, String> {
    match opt_str(probe, "state")?.map(str::trim) {
        None => Ok("open".to_string()),
        Some(s @ ("open" | "closed" | "all")) => Ok(s.to_string()),
        Some(other) => Err(format!("probe parameter \"state\" must be open, closed or all, not {other:?}")),
    }
}

fn plan_of(kind: &str, probe: &Map<String, Value>) -> Result<(Common, Plan), String> {
    let repo = req_str(probe, "repo")?.trim().to_string();
    if !valid_repo(&repo) {
        return Err(format!("probe parameter \"repo\" must look like owner/name, not {repo:?}"));
    }
    let api_base = opt_str(probe, "apiBase")?.unwrap_or(DEFAULT_API_BASE).trim().trim_end_matches('/').to_string();
    if !is_http_url(&api_base) {
        return Err("probe parameter \"apiBase\" must start with http:// or https://".to_string());
    }
    let token_env = opt_str(probe, "tokenEnv")?.unwrap_or(DEFAULT_TOKEN_ENV).trim().to_string();
    if token_env.contains(['=', '\0']) || token_env.chars().any(char::is_whitespace) {
        return Err("probe parameter \"tokenEnv\" must be an environment variable name".to_string());
    }
    let common = Common {
        repo,
        api_base,
        per_page: opt_int(probe, "perPage", 1, 100)?.unwrap_or(50),
        proxy: opt_str(probe, "proxy")?.map(|p| p.trim().to_string()),
        token_env,
        timeout: timeout_of(probe)?,
    };

    let plan = match kind {
        "github.pulls" => Plan::Pulls {
            state: state_of(probe)?,
            base: opt_str(probe, "base")?.map(|b| b.trim().to_string()),
        },
        "github.issues" => Plan::Issues {
            state: state_of(probe)?,
            labels: opt_str(probe, "labels")?.map(|l| l.trim().to_string()),
        },
        "github.branch" => {
            let branch = opt_str(probe, "branch")?.unwrap_or("main").trim().to_string();
            if !valid_ref(&branch) {
                return Err(format!("probe parameter \"branch\" is not a usable branch name: {branch:?}"));
            }
            Plan::Branch { branch }
        }
        "github.releases" => Plan::Releases { include_prerelease: opt_bool(probe, "includePrerelease")?.unwrap_or(false) },
        "github.checks" => {
            let git_ref = req_str(probe, "ref")?.trim().to_string();
            if !valid_ref(&git_ref) {
                return Err(format!("probe parameter \"ref\" is not a usable branch name or sha: {git_ref:?}"));
            }
            Plan::Checks { git_ref }
        }
        other => return Err(format!("{other} is not a GitHub probe kind")),
    };
    Ok((common, plan))
}

/* ============================================================
   URLs
   ============================================================ */

/// Percent-encode everything outside RFC 3986's unreserved set. `keep_slash`
/// is for a branch name used as a path: GitHub reads `commits/feature/x` as the
/// ref `feature/x`, and `%2F` is not reliably accepted by GitHub Enterprise.
fn percent_encode(text: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b'/' if keep_slash => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn repo_url(common: &Common, tail: &str) -> String {
    format!("{}/repos/{}/{}", common.api_base, common.repo, tail)
}

/// The URL of the one request a kind starts with. `checks` makes a second
/// request afterwards, so this is its first.
fn first_url(common: &Common, plan: &Plan) -> String {
    let q = |s: &str| percent_encode(s, false);
    match plan {
        Plan::Pulls { state, base } => {
            let mut url = repo_url(common, &format!("pulls?state={}&per_page={}", q(state), common.per_page));
            if let Some(base) = base {
                url.push_str(&format!("&base={}", q(base)));
            }
            url
        }
        Plan::Issues { state, labels } => {
            let mut url = repo_url(common, &format!("issues?state={}&per_page={}", q(state), common.per_page));
            if let Some(labels) = labels {
                url.push_str(&format!("&labels={}", q(labels)));
            }
            url
        }
        Plan::Branch { branch } => repo_url(common, &format!("commits/{}", percent_encode(branch, true))),
        Plan::Releases { .. } => repo_url(common, &format!("releases?per_page={}", common.per_page)),
        Plan::Checks { git_ref } => repo_url(common, &format!("commits/{}", percent_encode(git_ref, true))),
    }
}

fn check_runs_url(common: &Common, sha: &str) -> String {
    repo_url(common, &format!("commits/{}/check-runs?per_page=100", percent_encode(sha, false)))
}

/* ============================================================
   Auth and requests
   ============================================================ */

/// A token goes into a header: anything with whitespace or control characters
/// is a broken paste (or an injection attempt), not a token.
fn clean_token(raw: &str) -> Option<String> {
    let token = raw.trim();
    if token.is_empty() || token.chars().any(|c| c.is_whitespace() || c.is_control()) {
        None
    } else {
        Some(token.to_string())
    }
}

/// Environment variable first, then the GitHub CLI, then nothing. A failing
/// `gh` is silent: most machines that scan public repos do not have it.
fn resolve_token(common: &Common) -> Option<String> {
    if let Some(token) = std::env::var(&common.token_env).ok().as_deref().and_then(clean_token) {
        return Some(token);
    }
    let args: Vec<String> = vec!["auth".to_string(), "token".to_string()];
    match process::run("gh", &args, None, GH_TIMEOUT) {
        Ok(done) if done.success() => clean_token(&done.stdout),
        _ => None,
    }
}

fn build_request(url: String, token: Option<&str>, common: &Common) -> Request {
    let mut headers = vec![
        ("Accept".to_string(), "application/vnd.github+json".to_string()),
        ("User-Agent".to_string(), "tudouni-aigo".to_string()),
    ];
    if let Some(token) = token {
        headers.push(("Authorization".to_string(), format!("Bearer {token}")));
    }
    Request { url, post: false, headers, body: None, proxy: common.proxy.clone(), timeout: common.timeout }
}

fn get_json(url: String, token: Option<&str>, common: &Common) -> Result<Value, String> {
    let text = fetch(&build_request(url, token, common))?;
    serde_json::from_str(&text).map_err(|e| format!("the GitHub response is not JSON: {e}"))
}

/* ============================================================
   Response → items
   ============================================================ */

/// A string at a JSON pointer; missing, null or another type is `""`, so a
/// template never has to cope with a field that is sometimes absent.
fn text_at(value: &Value, pointer: &str) -> String {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn flag_at(value: &Value, pointer: &str) -> bool {
    value.pointer(pointer).and_then(Value::as_bool).unwrap_or(false)
}

/// Label names. Issues carry objects, but an older GHE may give plain strings.
fn label_names(value: &Value) -> Vec<String> {
    value
        .get("labels")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|l| l.as_str().or_else(|| l.get("name").and_then(Value::as_str)))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn number_key(value: &Value) -> Option<String> {
    value.get("number").and_then(Value::as_u64).map(|n| n.to_string())
}

fn as_list<'a>(response: &'a Value, what: &str) -> Result<&'a Vec<Value>, String> {
    response.as_array().ok_or_else(|| format!("the GitHub {what} response is not a list"))
}

fn skipped(count: usize, what: &str) -> Vec<String> {
    if count == 0 {
        Vec::new()
    } else {
        vec![format!("{count} {what} had no number")]
    }
}

pub(super) fn parse_pulls(response: &Value) -> Result<ProbeOutput, String> {
    let mut out = ProbeOutput::default();
    let mut missing = 0;
    for pr in as_list(response, "pulls")? {
        let Some(key) = number_key(pr) else {
            missing += 1;
            continue;
        };
        out.items.push(Item {
            key,
            version: text_at(pr, "/head/sha"),
            fields: json!({
                "number": pr["number"],
                "title": text_at(pr, "/title"),
                "url": text_at(pr, "/html_url"),
                "author": text_at(pr, "/user/login"),
                "base": text_at(pr, "/base/ref"),
                "head": text_at(pr, "/head/ref"),
                "draft": flag_at(pr, "/draft"),
                "labels": label_names(pr),
            }),
        });
    }
    out.warnings = skipped(missing, "pull requests");
    Ok(out)
}

/// The issues endpoint lists pull requests too; they are told apart by the
/// `pull_request` field and belong to `github.pulls`.
pub(super) fn parse_issues(response: &Value) -> Result<ProbeOutput, String> {
    let mut out = ProbeOutput::default();
    let mut missing = 0;
    for issue in as_list(response, "issues")? {
        if issue.get("pull_request").is_some() {
            continue;
        }
        let Some(key) = number_key(issue) else {
            missing += 1;
            continue;
        };
        out.items.push(Item {
            key,
            version: text_at(issue, "/updated_at"),
            fields: json!({
                "number": issue["number"],
                "title": text_at(issue, "/title"),
                "url": text_at(issue, "/html_url"),
                "author": text_at(issue, "/user/login"),
                "state": text_at(issue, "/state"),
                "labels": label_names(issue),
            }),
        });
    }
    out.warnings = skipped(missing, "issues");
    Ok(out)
}

/// The key is the branch asked for, not anything in the response: it is what
/// the person wrote in `sources.json`, and it stays put when the commit moves.
pub(super) fn parse_branch(branch: &str, response: &Value) -> Result<ProbeOutput, String> {
    let sha = text_at(response, "/sha");
    if sha.is_empty() {
        return Err("the GitHub commit response has no sha".to_string());
    }
    let message = text_at(response, "/commit/message");
    Ok(ProbeOutput {
        items: vec![Item {
            key: branch.to_string(),
            version: sha.clone(),
            fields: json!({
                "sha": sha,
                "url": text_at(response, "/html_url"),
                "message": message.lines().next().unwrap_or_default(),
                "author": text_at(response, "/commit/author/name"),
            }),
        }],
        warnings: Vec::new(),
    })
}

/// Drafts are never published, so there is nothing to announce; they also have
/// no `published_at`, which would make an unstable version.
pub(super) fn parse_releases(response: &Value, include_prerelease: bool) -> Result<ProbeOutput, String> {
    let mut out = ProbeOutput::default();
    let mut missing = 0;
    for release in as_list(response, "releases")? {
        if flag_at(release, "/draft") || (!include_prerelease && flag_at(release, "/prerelease")) {
            continue;
        }
        let tag = text_at(release, "/tag_name");
        if tag.is_empty() {
            missing += 1;
            continue;
        }
        let published = text_at(release, "/published_at");
        let version = if !published.is_empty() {
            published
        } else {
            release.get("id").and_then(Value::as_u64).map(|id| id.to_string()).unwrap_or_default()
        };
        out.items.push(Item {
            key: tag.clone(),
            version,
            fields: json!({
                "tag": tag,
                "name": text_at(release, "/name"),
                "url": text_at(release, "/html_url"),
                "prerelease": flag_at(release, "/prerelease"),
                "draft": false,
            }),
        });
    }
    if missing > 0 {
        out.warnings.push(format!("{missing} releases had no tag"));
    }
    Ok(out)
}

/// Conclusions that make a run a failure, per the design's aggregation rule.
const FAILING: &[&str] = &["failure", "timed_out", "cancelled", "action_required"];

/// Collapse a `check-runs` response into one state plus the names of the
/// failed runs. Failure beats pending: a red run is news even if others still
/// run. Neutral covers "nothing ran" and "everything was skipped".
pub(super) fn aggregate_checks(response: &Value) -> Result<(&'static str, Vec<String>), String> {
    let runs = response
        .get("check_runs")
        .and_then(Value::as_array)
        .ok_or_else(|| "the GitHub check-runs response has no check_runs list".to_string())?;
    let mut failed = Vec::new();
    let (mut pending, mut success) = (false, false);
    for run in runs {
        let conclusion = run.get("conclusion").and_then(Value::as_str).unwrap_or_default();
        if FAILING.contains(&conclusion) {
            let name = text_at(run, "/name");
            failed.push(if name.is_empty() { "(unnamed)".to_string() } else { name });
        }
        if run.get("status").and_then(Value::as_str).is_some_and(|s| s != "completed") {
            pending = true;
        }
        if conclusion == "success" {
            success = true;
        }
    }
    let state = if !failed.is_empty() {
        "failure"
    } else if pending {
        "pending"
    } else if success {
        "success"
    } else {
        "neutral"
    };
    Ok((state, failed))
}

/// The key is the ref asked for and the version is the state, so a new commit
/// with the same result is not an event (see the design, section 4).
pub(super) fn checks_item(git_ref: &str, sha: &str, url: &str, check_runs: &Value) -> Result<Item, String> {
    let (state, failed) = aggregate_checks(check_runs)?;
    Ok(Item {
        key: git_ref.to_string(),
        version: state.to_string(),
        fields: json!({ "state": state, "sha": sha, "url": url, "failed": failed }),
    })
}

/// The checks page of a commit. The commit's own `html_url` is preferred since
/// it is right for GitHub Enterprise too; the github.com form is the fallback
/// only when the API is github.com's.
fn checks_page(common: &Common, commit: &Value, sha: &str) -> String {
    let html = text_at(commit, "/html_url");
    if !html.is_empty() {
        return format!("{html}/checks");
    }
    if common.api_base == DEFAULT_API_BASE {
        return format!("https://github.com/{}/commit/{sha}/checks", common.repo);
    }
    String::new()
}

/* ============================================================
   Entry points
   ============================================================ */

pub(super) fn validate(kind: &str, probe: &Map<String, Value>) -> Result<(), String> {
    plan_of(kind, probe).map(|_| ())
}

pub(super) fn run(kind: &str, probe: &Map<String, Value>, _ctx: &ProbeCtx) -> Result<ProbeOutput, String> {
    let (common, plan) = plan_of(kind, probe)?;
    let token = resolve_token(&common);
    let token = token.as_deref();
    let first = get_json(first_url(&common, &plan), token, &common)?;
    match &plan {
        Plan::Pulls { .. } => parse_pulls(&first),
        Plan::Issues { .. } => parse_issues(&first),
        Plan::Branch { branch } => parse_branch(branch, &first),
        Plan::Releases { include_prerelease } => parse_releases(&first, *include_prerelease),
        Plan::Checks { git_ref } => {
            let sha = text_at(&first, "/sha");
            if sha.is_empty() {
                return Err(format!("the GitHub commit response for {git_ref:?} has no sha"));
            }
            let runs = get_json(check_runs_url(&common, &sha), token, &common)?;
            let item = checks_item(git_ref, &sha, &checks_page(&common, &first, &sha), &runs)?;
            Ok(ProbeOutput { items: vec![item], warnings: Vec::new() })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::http_json::{redact_secrets, secrets_of};
    use super::*;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn plan(kind: &str, extra: Value) -> Result<(Common, Plan), String> {
        let mut probe = obj(json!({"kind": kind, "repo": "org/repo-a", "ref": "main"}));
        probe.extend(obj(extra));
        plan_of(kind, &probe)
    }

    fn common() -> Common {
        plan("github.pulls", json!({})).unwrap().0
    }

    /* ---- parsing ---- */

    #[test]
    fn pulls_are_parsed() {
        let response = json!([
            {
                "number": 12, "title": "Add x", "html_url": "https://github.com/o/r/pull/12",
                "user": {"login": "alice"}, "base": {"ref": "main"},
                "head": {"ref": "feat", "sha": "abc123"}, "draft": true,
                "labels": [{"name": "bug"}, {"name": "ui"}]
            },
            {"title": "no number"},
            {"number": 13, "title": "Ghost", "user": null, "base": {"ref": "main"}, "head": {"ref": "g", "sha": "def"}}
        ]);
        let out = parse_pulls(&response).unwrap();
        assert_eq!(out.items.len(), 2);
        assert_eq!(out.items[0].key, "12");
        assert_eq!(out.items[0].version, "abc123");
        assert_eq!(
            out.items[0].fields,
            json!({
                "number": 12, "title": "Add x", "url": "https://github.com/o/r/pull/12", "author": "alice",
                "base": "main", "head": "feat", "draft": true, "labels": ["bug", "ui"]
            })
        );
        assert_eq!(out.items[1].fields["author"], "");
        assert_eq!(out.items[1].fields["draft"], false);
        assert_eq!(out.warnings, vec!["1 pull requests had no number".to_string()]);
    }

    #[test]
    fn issues_exclude_pull_requests() {
        let response = json!([
            {
                "number": 5, "title": "Crash", "html_url": "https://github.com/o/r/issues/5", "state": "open",
                "user": {"login": "bob"}, "updated_at": "2026-01-02T03:04:05Z", "labels": [{"name": "bug"}, "plain"]
            },
            {"number": 6, "title": "A PR in disguise", "pull_request": {"url": "x"}, "updated_at": "2026-01-03T00:00:00Z"}
        ]);
        let out = parse_issues(&response).unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.items[0].key, "5");
        assert_eq!(out.items[0].version, "2026-01-02T03:04:05Z");
        assert_eq!(
            out.items[0].fields,
            json!({
                "number": 5, "title": "Crash", "url": "https://github.com/o/r/issues/5", "author": "bob",
                "state": "open", "labels": ["bug", "plain"]
            })
        );
    }

    #[test]
    fn a_branch_is_one_item_keyed_by_its_name() {
        let response = json!({
            "sha": "3f2a9c", "html_url": "https://github.com/o/r/commit/3f2a9c",
            "commit": {"message": "Fix the thing\n\nLonger body", "author": {"name": "Carol"}}
        });
        let out = parse_branch("release/1.0", &response).unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!((out.items[0].key.as_str(), out.items[0].version.as_str()), ("release/1.0", "3f2a9c"));
        assert_eq!(
            out.items[0].fields,
            json!({"sha": "3f2a9c", "url": "https://github.com/o/r/commit/3f2a9c", "message": "Fix the thing", "author": "Carol"})
        );
        assert!(parse_branch("main", &json!({"message": "Not Found"})).is_err());
    }

    #[test]
    fn releases_skip_drafts_and_prereleases() {
        let response = json!([
            {"id": 1, "tag_name": "v1.0", "name": "One", "html_url": "u1", "published_at": "2026-01-01T00:00:00Z", "prerelease": false, "draft": false},
            {"id": 2, "tag_name": "v2.0-rc1", "name": "RC", "html_url": "u2", "published_at": "2026-02-01T00:00:00Z", "prerelease": true, "draft": false},
            {"id": 3, "tag_name": "v3.0", "name": "Draft", "html_url": "u3", "published_at": null, "prerelease": false, "draft": true},
            {"id": 4, "tag_name": "v0.9", "name": null, "html_url": "u4", "published_at": null, "prerelease": false, "draft": false}
        ]);
        let stable = parse_releases(&response, false).unwrap();
        let keys: Vec<_> = stable.items.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(keys, ["v1.0", "v0.9"]);
        assert_eq!(stable.items[0].version, "2026-01-01T00:00:00Z");
        // No published_at: the id keeps the version stable and non-empty.
        assert_eq!(stable.items[1].version, "4");
        assert_eq!(
            stable.items[0].fields,
            json!({"tag": "v1.0", "name": "One", "url": "u1", "prerelease": false, "draft": false})
        );

        let all = parse_releases(&response, true).unwrap();
        let keys: Vec<_> = all.items.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(keys, ["v1.0", "v2.0-rc1", "v0.9"]);
        assert_eq!(all.items[1].fields["prerelease"], true);
    }

    #[test]
    fn list_responses_must_be_lists() {
        let error = json!({"message": "Not Found"});
        assert!(parse_pulls(&error).is_err());
        assert!(parse_issues(&error).is_err());
        assert!(parse_releases(&error, false).is_err());
    }

    /* ---- checks ---- */

    fn runs(list: Value) -> Value {
        json!({"total_count": list.as_array().unwrap().len(), "check_runs": list})
    }

    #[test]
    fn checks_aggregate_to_failure() {
        for bad in ["failure", "timed_out", "cancelled", "action_required"] {
            let response = runs(json!([
                {"name": "build", "status": "completed", "conclusion": "success"},
                {"name": "lint", "status": "completed", "conclusion": bad},
                {"name": "deploy", "status": "in_progress", "conclusion": null}
            ]));
            let (state, failed) = aggregate_checks(&response).unwrap();
            assert_eq!(state, "failure", "{bad}");
            assert_eq!(failed, ["lint"]);
        }
    }

    #[test]
    fn checks_aggregate_to_pending() {
        let response = runs(json!([
            {"name": "build", "status": "completed", "conclusion": "success"},
            {"name": "test", "status": "queued", "conclusion": null}
        ]));
        assert_eq!(aggregate_checks(&response).unwrap(), ("pending", vec![]));
    }

    #[test]
    fn checks_aggregate_to_success() {
        let response = runs(json!([
            {"name": "build", "status": "completed", "conclusion": "success"},
            {"name": "docs", "status": "completed", "conclusion": "skipped"},
            {"name": "lint", "status": "completed", "conclusion": "neutral"}
        ]));
        assert_eq!(aggregate_checks(&response).unwrap(), ("success", vec![]));
    }

    #[test]
    fn checks_aggregate_to_neutral() {
        assert_eq!(aggregate_checks(&runs(json!([]))).unwrap(), ("neutral", vec![]));
        let skipped_only = runs(json!([{"name": "docs", "status": "completed", "conclusion": "skipped"}]));
        assert_eq!(aggregate_checks(&skipped_only).unwrap().0, "neutral");
        assert!(aggregate_checks(&json!({"message": "Not Found"})).is_err());
    }

    #[test]
    fn a_checks_item_is_keyed_by_ref_and_versioned_by_state() {
        let response = runs(json!([{"name": "build", "status": "completed", "conclusion": "failure"}]));
        let item = checks_item("main", "abc", "https://github.com/o/r/commit/abc/checks", &response).unwrap();
        assert_eq!((item.key.as_str(), item.version.as_str()), ("main", "failure"));
        assert_eq!(
            item.fields,
            json!({"state": "failure", "sha": "abc", "url": "https://github.com/o/r/commit/abc/checks", "failed": ["build"]})
        );
    }

    #[test]
    fn the_checks_page_follows_the_commit_url() {
        let common = common();
        let commit = json!({"sha": "abc", "html_url": "https://ghe.example/o/r/commit/abc"});
        assert_eq!(checks_page(&common, &commit, "abc"), "https://ghe.example/o/r/commit/abc/checks");
        assert_eq!(checks_page(&common, &json!({}), "abc"), "https://github.com/org/repo-a/commit/abc/checks");
        let (ghe, _) = plan("github.checks", json!({"apiBase": "https://ghe.example/api/v3/"})).unwrap();
        assert_eq!(checks_page(&ghe, &json!({}), "abc"), "");
    }

    /* ---- urls ---- */

    #[test]
    fn urls_are_built_from_the_parameters() {
        let (c, p) = plan("github.pulls", json!({"state": "all", "base": "release/1.0", "perPage": 20})).unwrap();
        assert_eq!(
            first_url(&c, &p),
            "https://api.github.com/repos/org/repo-a/pulls?state=all&per_page=20&base=release%2F1.0"
        );
        let (c, p) = plan("github.issues", json!({"labels": "bug,help wanted"})).unwrap();
        assert_eq!(
            first_url(&c, &p),
            "https://api.github.com/repos/org/repo-a/issues?state=open&per_page=50&labels=bug%2Chelp%20wanted"
        );
        let (c, p) = plan("github.releases", json!({"apiBase": "https://ghe.example/api/v3//"})).unwrap();
        assert_eq!(first_url(&c, &p), "https://ghe.example/api/v3/repos/org/repo-a/releases?per_page=50");
        assert_eq!(
            check_runs_url(&c, "abc123"),
            "https://ghe.example/api/v3/repos/org/repo-a/commits/abc123/check-runs?per_page=100"
        );
    }

    #[test]
    fn branch_names_are_encoded_but_keep_their_slashes() {
        let (c, p) = plan("github.branch", json!({})).unwrap();
        assert_eq!(first_url(&c, &p), "https://api.github.com/repos/org/repo-a/commits/main");
        let (c, p) = plan("github.branch", json!({"branch": "feature/a b#1"})).unwrap();
        assert_eq!(first_url(&c, &p), "https://api.github.com/repos/org/repo-a/commits/feature/a%20b%231");
        let (c, p) = plan("github.checks", json!({"ref": "fix/é"})).unwrap();
        assert_eq!(first_url(&c, &p), "https://api.github.com/repos/org/repo-a/commits/fix/%C3%A9");
    }

    /* ---- validate ---- */

    #[test]
    fn validate_accepts_typical_probes() {
        for kind in ["github.pulls", "github.issues", "github.branch", "github.releases", "github.checks"] {
            let probe = obj(json!({"kind": kind, "repo": "org/repo-a", "ref": "main"}));
            assert!(validate(kind, &probe).is_ok(), "{kind}");
        }
        let full = obj(json!({
            "kind": "github.releases", "repo": "o/r.js", "apiBase": "https://ghe.example/api/v3", "perPage": 100,
            "proxy": "http://p:8080", "tokenEnv": "MY_TOKEN", "includePrerelease": true, "timeoutSec": 30
        }));
        assert!(validate("github.releases", &full).is_ok());
    }

    #[test]
    fn validate_refuses_bad_parameters() {
        let check = |extra: Value| {
            let mut probe = obj(json!({"kind": "github.pulls", "repo": "org/repo-a"}));
            probe.extend(obj(extra));
            validate("github.pulls", &probe)
        };
        assert!(check(json!({})).is_ok());
        for repo in ["repo", "a/b/c", "/b", "a/", "a/..", "a b/c", "a/b?x=1"] {
            assert!(check(json!({"repo": repo})).unwrap_err().contains("owner/name"), "{repo}");
        }
        assert!(check(json!({"repo": null})).unwrap_err().contains("required"));
        assert!(check(json!({"state": "merged"})).unwrap_err().contains("open, closed or all"));
        assert!(check(json!({"perPage": 0})).is_err());
        assert!(check(json!({"perPage": 101})).is_err());
        assert!(check(json!({"perPage": "5"})).is_err());
        assert!(check(json!({"apiBase": "ftp://x"})).is_err());
        assert!(check(json!({"tokenEnv": "A=B"})).is_err());
        assert!(check(json!({"tokenEnv": "A B"})).is_err());
        assert!(check(json!({"proxy": 3})).is_err());
        assert!(check(json!({"timeoutSec": 0})).is_err());

        let checks = |extra: Value| {
            let mut probe = obj(json!({"kind": "github.checks", "repo": "o/r"}));
            probe.extend(obj(extra));
            validate("github.checks", &probe)
        };
        assert!(checks(json!({})).unwrap_err().contains("\"ref\""));
        assert!(checks(json!({"ref": "../../user"})).is_err());
        assert!(checks(json!({"ref": "a//b"})).is_err());
        assert!(checks(json!({"ref": "main"})).is_ok());

        let branch = |extra: Value| {
            let mut probe = obj(json!({"kind": "github.branch", "repo": "o/r"}));
            probe.extend(obj(extra));
            validate("github.branch", &probe)
        };
        assert!(branch(json!({})).is_ok(), "branch defaults to main");
        assert!(branch(json!({"branch": "a/../b"})).is_err());
        assert!(branch(json!({"includePrerelease": true})).is_ok());
        let mut releases = obj(json!({"kind": "github.releases", "repo": "o/r", "includePrerelease": "yes"}));
        assert!(validate("github.releases", &releases).is_err());
        releases.insert("includePrerelease".to_string(), json!(false));
        assert!(validate("github.releases", &releases).is_ok());
    }

    #[test]
    fn defaults_are_applied() {
        let (c, p) = plan("github.pulls", json!({})).unwrap();
        assert_eq!((c.api_base.as_str(), c.per_page, c.token_env.as_str()), (DEFAULT_API_BASE, 50, DEFAULT_TOKEN_ENV));
        assert_eq!(p, Plan::Pulls { state: "open".to_string(), base: None });
        let (_, p) = plan("github.branch", json!({})).unwrap();
        assert_eq!(p, Plan::Branch { branch: "main".to_string() });
    }

    /* ---- tokens ---- */

    #[test]
    fn tokens_with_odd_characters_are_not_used() {
        assert_eq!(clean_token("  ghp_abc\n").as_deref(), Some("ghp_abc"));
        assert_eq!(clean_token("   "), None);
        assert_eq!(clean_token("ghp abc"), None);
        assert_eq!(clean_token("abc\r\nX-Evil: 1"), None);
    }

    #[test]
    fn the_token_is_masked_in_error_text() {
        let c = common();
        let request = build_request("https://api.github.com/x".to_string(), Some("ghp_secret123"), &c);
        assert!(request.headers.iter().any(|(n, v)| n == "Authorization" && v == "Bearer ghp_secret123"));
        let masked = redact_secrets(
            "curl exited with 22: denied (Bearer ghp_secret123) token=ghp_secret123",
            &secrets_of(&request),
        );
        assert!(!masked.contains("ghp_secret123"), "{masked}");
        assert!(masked.contains("***"));
        // The GitHub media type is not a secret and stays readable.
        let plain = redact_secrets("sent application/vnd.github+json", &secrets_of(&request));
        assert_eq!(plain, "sent application/vnd.github+json");
    }

    #[test]
    fn anonymous_requests_carry_no_authorization() {
        let request = build_request("https://api.github.com/x".to_string(), None, &common());
        assert!(request.headers.iter().all(|(n, _)| n != "Authorization"));
        assert!(request.headers.iter().any(|(n, v)| n == "Accept" && v == "application/vnd.github+json"));
        assert!(request.headers.iter().any(|(n, v)| n == "User-Agent" && v == "tudouni-aigo"));
        assert!(secrets_of(&request).is_empty());
    }
}
