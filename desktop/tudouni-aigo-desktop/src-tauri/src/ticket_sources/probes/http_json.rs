//! `http.json`: fetch a JSON document with the system `curl` and read items
//! out of it by dotted path.
//!
//! This file also owns the one place that talks HTTP (`fetch`), because the
//! GitHub probes are the same thing with fixed headers. Keeping a single curl
//! runner means the token-redaction and `--fail-with-body` fallback rules are
//! written once.

use super::process;
use super::{opt_str, req_str, sha256_hex, timeout_of, Item, ProbeCtx, ProbeOutput};
use serde_json::{json, Map, Value};
use std::time::Duration;

/* ============================================================
   curl
   ============================================================ */

/// Everything `curl` needs for one request.
pub(super) struct Request {
    pub url: String,
    pub post: bool,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub proxy: Option<String>,
    pub timeout: Duration,
}

/// Headers whose values are never credentials, so an error message may show
/// them. Every other header value is treated as a secret and masked.
const PLAIN_HEADERS: &[&str] = &[
    "accept",
    "accept-language",
    "cache-control",
    "content-type",
    "user-agent",
    "x-github-api-version",
];

pub(super) fn is_http_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// The pieces of a proxy URL's `user:password@` part, which curl may echo back
/// in a connection error.
fn proxy_secrets(proxy: &str) -> Vec<String> {
    let rest = proxy.split_once("://").map_or(proxy, |(_, rest)| rest);
    let Some(at) = rest.rfind('@') else { return Vec::new() };
    let userinfo = &rest[..at];
    let mut out = vec![userinfo.to_string()];
    if let Some((_, password)) = userinfo.split_once(':') {
        out.push(password.to_string());
    }
    out
}

/// Every string in `req` that must not appear in an error message.
///
/// For `Authorization: Bearer <token>` both the whole value and the bare token
/// are listed, so an error that quotes only the token is masked too.
pub(super) fn secrets_of(req: &Request) -> Vec<String> {
    let mut out = Vec::new();
    for (name, value) in &req.headers {
        if PLAIN_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
            continue;
        }
        out.push(value.clone());
        if let Some((_, last)) = value.rsplit_once(' ') {
            out.push(last.to_string());
        }
    }
    if let Some(proxy) = &req.proxy {
        out.extend(proxy_secrets(proxy));
    }
    out
}

/// Replace every secret in `text` with `***`.
///
/// Longest first, so a secret that contains another one is masked whole.
/// Values under four characters are skipped: they cannot be real credentials,
/// and masking them would turn `1` into `***` all over an error message.
pub(super) fn redact_secrets(text: &str, secrets: &[String]) -> String {
    let mut sorted: Vec<&str> = secrets.iter().map(String::as_str).filter(|s| s.chars().count() >= 4).collect();
    sorted.sort_by_key(|s| std::cmp::Reverse(s.len()));
    let mut out = text.to_string();
    for secret in sorted {
        out = out.replace(secret, "***");
    }
    out
}

/// The argument list for one attempt. `fail_flag` is `--fail-with-body` or,
/// for a curl older than 7.76, `-f`.
fn curl_args(req: &Request, fail_flag: &str) -> Result<Vec<String>, String> {
    if !is_http_url(&req.url) {
        // Also keeps a url starting with "-" from being read as an option.
        return Err("the url must start with http:// or https://".to_string());
    }
    // -g: a url with [] or {} is taken literally instead of being a curl glob.
    let mut args: Vec<String> = ["-sS", "-L", "-g", fail_flag].iter().map(|s| s.to_string()).collect();
    if let Some(proxy) = &req.proxy {
        args.push("-x".to_string());
        args.push(proxy.clone());
    }
    for (name, value) in &req.headers {
        args.push("-H".to_string());
        args.push(format!("{name}: {value}"));
    }
    if req.post {
        match &req.body {
            Some(body) => {
                // curl reads `--data-binary @file` from disk; a probe must not
                // be able to upload a local file by accident.
                if body.starts_with('@') {
                    return Err("the body must not start with '@' (curl would read a file); put a space first".to_string());
                }
                args.push("--data-binary".to_string());
                args.push(body.clone());
            }
            None => {
                args.push("-X".to_string());
                args.push("POST".to_string());
            }
        }
    }
    args.push(req.url.clone());
    Ok(args)
}

/// `--fail-with-body` arrived in curl 7.76; an older one exits 2 and names the
/// option it did not understand.
fn lacks_fail_with_body(done: &process::Finished) -> bool {
    done.code == Some(2) && done.stderr.to_ascii_lowercase().contains("fail-with-body")
}

/// The message GitHub-style APIs put in an error body, which says far more than
/// curl's "returned error: 403".
fn api_message(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let message = value.get("message")?.as_str()?;
    Some(process::tail(message, 200))
}

fn curl_failure(done: &process::Finished) -> String {
    let code = done.code.map_or_else(|| "a signal".to_string(), |c| c.to_string());
    let why = process::tail(&done.stderr, 500);
    let mut msg = if why.is_empty() {
        format!("curl exited with {code}")
    } else {
        format!("curl exited with {code}: {why}")
    };
    if let Some(message) = api_message(&done.stdout) {
        msg.push_str(&format!(" ({message})"));
    }
    msg
}

/// Run the request and return the response body. Any error text has the
/// request's credentials masked.
pub(super) fn fetch(req: &Request) -> Result<String, String> {
    let secrets = secrets_of(req);
    fetch_unmasked(req).map_err(|e| redact_secrets(&e, &secrets))
}

fn fetch_unmasked(req: &Request) -> Result<String, String> {
    let mut done = process::run("curl", &curl_args(req, "--fail-with-body")?, None, req.timeout)?;
    if !done.success() && lacks_fail_with_body(&done) {
        done = process::run("curl", &curl_args(req, "-f")?, None, req.timeout)?;
    }
    if done.success() {
        Ok(done.stdout)
    } else {
        Err(curl_failure(&done))
    }
}

/* ============================================================
   Reading items out of the response
   ============================================================ */

/// Follow a dotted path. A segment indexes an array when it is a number, and
/// an object otherwise; an empty path is the root. A key that itself contains a
/// dot cannot be addressed: the path language stays this small on purpose.
pub(super) fn lookup<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    if path.is_empty() {
        return Some(root);
    }
    let mut current = root;
    for segment in path.split('.') {
        current = match current {
            Value::Array(list) => list.get(segment.parse::<usize>().ok()?)?,
            Value::Object(map) => map.get(segment)?,
            _ => return None,
        };
    }
    Some(current)
}

/// A key or version must be a non-empty string or a number.
fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

/// Response JSON to items. Pure, so it is tested without a network.
///
/// A missing `items` path is an error rather than an empty list: an empty
/// result would make the engine report every known item as removed.
pub(super) fn extract_items(root: &Value, items: &str, key: &str, version: Option<&str>) -> Result<ProbeOutput, String> {
    let target = lookup(root, items).ok_or_else(|| format!("items path {items:?} was not found in the response"))?;
    let entries: Vec<&Value> = match target {
        Value::Array(list) => list.iter().collect(),
        Value::Object(_) => vec![target],
        other => {
            return Err(format!("items path {items:?} points at {}, not an array or an object", type_name(other)));
        }
    };

    let mut out = ProbeOutput::default();
    let (mut no_key, mut no_version) = (0usize, 0usize);
    for entry in entries {
        // Paths are read from the wrapped form, so a list of plain strings can
        // still be keyed (`key: "value"`); for an object it is the entry itself.
        let fields = if entry.is_object() { entry.clone() } else { json!({ "value": entry }) };
        let Some(item_key) = lookup(&fields, key).and_then(scalar_text) else {
            no_key += 1;
            continue;
        };
        let item_version = match version {
            Some(path) => match lookup(&fields, path).and_then(scalar_text) {
                Some(v) => v,
                None => {
                    no_version += 1;
                    content_hash(entry)
                }
            },
            None => content_hash(entry),
        };
        out.items.push(Item { key: item_key, version: item_version, fields });
    }
    if no_key > 0 {
        out.warnings.push(format!("{no_key} items had no key"));
    }
    if no_version > 0 {
        out.warnings.push(format!("{no_version} items had no version; their content hash was used instead"));
    }
    Ok(out)
}

/// Compact JSON, hashed. serde_json writes object keys in a stable order, so
/// the same entry gives the same version on every scan.
fn content_hash(entry: &Value) -> String {
    sha256_hex(serde_json::to_string(entry).unwrap_or_default().as_bytes())
}

/* ============================================================
   Parameters
   ============================================================ */

struct Spec {
    request: Request,
    items: String,
    key: String,
    version: Option<String>,
}

fn valid_header_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c))
}

fn has_header(headers: &[(String, String)], name: &str) -> bool {
    headers.iter().any(|(n, _)| n.eq_ignore_ascii_case(name))
}

fn spec_of(probe: &Map<String, Value>) -> Result<Spec, String> {
    let url = req_str(probe, "url")?.trim().to_string();
    if !is_http_url(&url) {
        return Err("probe parameter \"url\" must start with http:// or https://".to_string());
    }
    let post = match opt_str(probe, "method")? {
        None => false,
        Some(m) if m.trim().eq_ignore_ascii_case("GET") => false,
        Some(m) if m.trim().eq_ignore_ascii_case("POST") => true,
        Some(m) => return Err(format!("probe parameter \"method\" must be GET or POST, not {m:?}")),
    };
    let body = opt_str(probe, "body")?.map(str::to_string);
    if body.is_some() && !post {
        return Err("probe parameter \"body\" needs \"method\": \"POST\"".to_string());
    }
    if body.as_deref().is_some_and(|b| b.starts_with('@')) {
        return Err("probe parameter \"body\" must not start with '@' (curl would read a file); put a space first".to_string());
    }

    let mut headers = Vec::new();
    match probe.get("headers") {
        None | Some(Value::Null) => {}
        Some(Value::Object(map)) => {
            for (name, value) in map {
                let Value::String(value) = value else {
                    return Err(format!("header {name:?} must have a string value"));
                };
                if !valid_header_name(name) {
                    return Err(format!("{name:?} is not a valid header name"));
                }
                if value.contains(['\r', '\n']) {
                    return Err(format!("header {name:?} must not contain a line break"));
                }
                headers.push((name.clone(), value.clone()));
            }
        }
        Some(_) => return Err("probe parameter \"headers\" must be an object of strings".to_string()),
    }
    if !has_header(&headers, "accept") {
        headers.push(("Accept".to_string(), "application/json".to_string()));
    }
    if !has_header(&headers, "user-agent") {
        headers.push(("User-Agent".to_string(), "tudouni-aigo".to_string()));
    }
    if body.is_some() && !has_header(&headers, "content-type") {
        headers.push(("Content-Type".to_string(), "application/json".to_string()));
    }

    Ok(Spec {
        request: Request {
            url,
            post,
            headers,
            body,
            proxy: opt_str(probe, "proxy")?.map(|p| p.trim().to_string()),
            timeout: timeout_of(probe)?,
        },
        items: opt_str(probe, "items")?.unwrap_or("").trim().to_string(),
        key: req_str(probe, "key")?.trim().to_string(),
        version: opt_str(probe, "version")?.map(|v| v.trim().to_string()),
    })
}

pub(super) fn validate(_kind: &str, probe: &Map<String, Value>) -> Result<(), String> {
    spec_of(probe).map(|_| ())
}

pub(super) fn run(_kind: &str, probe: &Map<String, Value>, _ctx: &ProbeCtx) -> Result<ProbeOutput, String> {
    let spec = spec_of(probe)?;
    let text = fetch(&spec.request)?;
    let root: Value = serde_json::from_str(&text).map_err(|e| format!("the response is not JSON: {e}"))?;
    extract_items(&root, &spec.items, &spec.key, spec.version.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn request(headers: &[(&str, &str)], proxy: Option<&str>) -> Request {
        Request {
            url: "https://example.com/x".to_string(),
            post: false,
            headers: headers.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect(),
            body: None,
            proxy: proxy.map(str::to_string),
            timeout: Duration::from_secs(5),
        }
    }

    #[test]
    fn empty_items_path_reads_the_root_array() {
        let root = json!([{"id": "a"}, {"id": "b"}]);
        let out = extract_items(&root, "", "id", None).unwrap();
        assert_eq!(out.items.iter().map(|i| i.key.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn a_dotted_items_path_finds_the_array() {
        let root = json!({"data": {"list": [{"id": "x"}]}});
        let out = extract_items(&root, "data.list", "id", None).unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.items[0].fields, json!({"id": "x"}));
    }

    #[test]
    fn an_object_target_is_one_item() {
        let root = json!({"build": {"id": "b1", "state": "ok"}});
        let out = extract_items(&root, "build", "id", Some("state")).unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!((out.items[0].key.as_str(), out.items[0].version.as_str()), ("b1", "ok"));
    }

    #[test]
    fn paths_can_index_arrays() {
        let root = json!({"a": [{"b": "first"}, {"b": "second"}]});
        assert_eq!(lookup(&root, "a.1.b"), Some(&json!("second")));
        assert_eq!(lookup(&root, "a.2.b"), None);
        assert_eq!(lookup(&root, "a.x"), None);
        let out = extract_items(&json!({"rows": [{"ids": ["k1", "k2"]}]}), "rows", "ids.1", None).unwrap();
        assert_eq!(out.items[0].key, "k2");
    }

    #[test]
    fn other_targets_and_missing_paths_fail() {
        let root = json!({"n": 3, "s": "text", "z": null});
        for path in ["n", "s", "z"] {
            let err = extract_items(&root, path, "id", None).unwrap_err();
            assert!(err.contains("not an array or an object"), "{err}");
        }
        assert!(extract_items(&root, "nope", "id", None).unwrap_err().contains("not found"));
    }

    #[test]
    fn numeric_keys_and_versions_become_strings() {
        let root = json!([{"id": 42, "rev": 7}]);
        let out = extract_items(&root, "", "id", Some("rev")).unwrap();
        assert_eq!((out.items[0].key.as_str(), out.items[0].version.as_str()), ("42", "7"));
    }

    #[test]
    fn items_without_a_key_are_skipped_and_counted() {
        let root = json!([{"id": "a"}, {"other": 1}, {"id": ""}, {"id": true}, "plain"]);
        let out = extract_items(&root, "", "id", None).unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.warnings, vec!["4 items had no key".to_string()]);
    }

    #[test]
    fn the_default_version_is_a_content_hash() {
        let a = json!({"id": "a", "n": 1});
        let first = extract_items(&json!([a.clone()]), "", "id", None).unwrap();
        let again = extract_items(&json!([a.clone()]), "", "id", None).unwrap();
        let changed = extract_items(&json!([{"id": "a", "n": 2}]), "", "id", None).unwrap();
        assert_eq!(first.items[0].version, sha256_hex(serde_json::to_string(&a).unwrap().as_bytes()));
        assert_eq!(first.items[0].version, again.items[0].version);
        assert_ne!(first.items[0].version, changed.items[0].version);
    }

    #[test]
    fn a_missing_version_falls_back_to_the_hash_with_a_warning() {
        let root = json!([{"id": "a", "rev": "r1"}, {"id": "b"}]);
        let out = extract_items(&root, "", "id", Some("rev")).unwrap();
        assert_eq!(out.items[0].version, "r1");
        assert_eq!(out.items[1].version.len(), 64);
        assert_eq!(out.warnings.len(), 1);
        assert!(out.warnings[0].starts_with("1 items had no version"));
    }

    #[test]
    fn scalar_entries_are_wrapped() {
        let out = extract_items(&json!(["a", "b"]), "", "value", None).unwrap();
        assert_eq!(out.items[0].fields, json!({"value": "a"}));
        assert_eq!(out.items[1].key, "b");
    }

    #[test]
    fn validate_accepts_a_minimal_probe() {
        let ok = obj(json!({"kind": "http.json", "url": "https://example.com/a", "key": "id"}));
        assert!(validate("http.json", &ok).is_ok());
        let full = obj(json!({
            "kind": "http.json", "url": "https://example.com/a", "method": "post", "body": "{}",
            "headers": {"X-Token": "abc"}, "items": "data", "key": "id", "version": "rev", "proxy": "http://p:8080"
        }));
        assert!(validate("http.json", &full).is_ok());
    }

    #[test]
    fn validate_refuses_bad_parameters() {
        let base = json!({"kind": "http.json", "url": "https://example.com/a", "key": "id"});
        let with = |k: &str, v: Value| {
            let mut m = obj(base.clone());
            m.insert(k.to_string(), v);
            m
        };
        let mut no_url = obj(base.clone());
        no_url.remove("url");
        assert!(validate("http.json", &no_url).unwrap_err().contains("url"));
        let mut no_key = obj(base.clone());
        no_key.remove("key");
        assert!(validate("http.json", &no_key).unwrap_err().contains("key"));
        assert!(validate("http.json", &with("url", json!("ftp://x"))).is_err());
        assert!(validate("http.json", &with("url", json!("-o /tmp/x"))).is_err());
        assert!(validate("http.json", &with("method", json!("PUT"))).unwrap_err().contains("GET or POST"));
        assert!(validate("http.json", &with("headers", json!(["a"]))).is_err());
        assert!(validate("http.json", &with("headers", json!({"A": 1}))).is_err());
        assert!(validate("http.json", &with("headers", json!({"A": "x\r\nB: y"}))).is_err());
        assert!(validate("http.json", &with("headers", json!({"bad name": "x"}))).is_err());
        assert!(validate("http.json", &with("body", json!("{}"))).unwrap_err().contains("POST"));
        assert!(validate("http.json", &with("items", json!(5))).is_err());
        let mut at_body = with("body", json!("@C:/secret.txt"));
        at_body.insert("method".to_string(), json!("POST"));
        assert!(validate("http.json", &at_body).unwrap_err().contains("'@'"));
    }

    #[test]
    fn curl_gets_the_expected_arguments() {
        let spec = spec_of(&obj(json!({
            "url": "https://example.com/a?x=[1]", "key": "id", "proxy": "http://p:8080", "headers": {"X-Token": "abc"}
        })))
        .unwrap();
        let args = curl_args(&spec.request, "--fail-with-body").unwrap();
        assert_eq!(&args[..4], ["-sS", "-L", "-g", "--fail-with-body"]);
        assert!(args.windows(2).any(|w| w == ["-x", "http://p:8080"]));
        assert!(args.windows(2).any(|w| w == ["-H", "X-Token: abc"]));
        assert!(args.windows(2).any(|w| w == ["-H", "Accept: application/json"]));
        assert_eq!(args.last().unwrap(), "https://example.com/a?x=[1]");
        assert!(!args.contains(&"--data-binary".to_string()));
        assert_eq!(curl_args(&spec.request, "-f").unwrap()[3], "-f");
    }

    #[test]
    fn post_sends_the_body_verbatim() {
        let spec = spec_of(&obj(json!({"url": "https://e.com", "key": "id", "method": "POST", "body": "{\"q\":1}"}))).unwrap();
        let args = curl_args(&spec.request, "-f").unwrap();
        assert!(args.windows(2).any(|w| w == ["--data-binary", "{\"q\":1}"]));
        assert!(args.windows(2).any(|w| w == ["-H", "Content-Type: application/json"]));
        let bare = spec_of(&obj(json!({"url": "https://e.com", "key": "id", "method": "POST"}))).unwrap();
        assert!(curl_args(&bare.request, "-f").unwrap().windows(2).any(|w| w == ["-X", "POST"]));
    }

    #[test]
    fn a_user_content_type_is_kept() {
        let spec = spec_of(&obj(json!({
            "url": "https://e.com", "key": "id", "method": "POST", "body": "a=1", "headers": {"content-type": "text/plain"}
        })))
        .unwrap();
        let count = spec.request.headers.iter().filter(|(n, _)| n.eq_ignore_ascii_case("content-type")).count();
        assert_eq!(count, 1);
    }

    #[test]
    fn a_bad_url_never_reaches_curl() {
        let mut req = request(&[], None);
        req.url = "-K /etc/passwd".to_string();
        assert!(curl_args(&req, "-f").is_err());
    }

    #[test]
    fn secrets_are_masked_in_error_text() {
        let req = request(&[("Authorization", "Bearer ghp_secret123"), ("Accept", "application/json")], None);
        let secrets = secrets_of(&req);
        let masked = redact_secrets("curl: (22) denied for Bearer ghp_secret123; token ghp_secret123 rejected", &secrets);
        assert!(!masked.contains("ghp_secret123"), "{masked}");
        assert!(masked.contains("***"));
        // A plain header's value is left readable.
        assert_eq!(redact_secrets("accepts application/json", &secrets), "accepts application/json");
    }

    #[test]
    fn proxy_credentials_are_masked() {
        let req = request(&[], Some("http://bob:hunter22@proxy.local:8080"));
        let masked = redact_secrets("could not connect to http://bob:hunter22@proxy.local:8080", &secrets_of(&req));
        assert!(!masked.contains("hunter22") && !masked.contains("bob:"), "{masked}");
        assert!(secrets_of(&request(&[], Some("http://proxy.local:8080"))).is_empty());
    }

    #[test]
    fn short_values_are_not_masked() {
        assert_eq!(redact_secrets("exit 1 of 1", &["1".to_string(), String::new()]), "exit 1 of 1");
    }

    #[test]
    fn curl_failure_carries_the_api_message_without_the_token() {
        let done = process::Finished {
            code: Some(22),
            stdout: r#"{"message":"Bad credentials for ghp_secret123"}"#.to_string(),
            stderr: "curl: (22) The requested URL returned error: 401\n".to_string(),
        };
        let text = curl_failure(&done);
        assert!(text.contains("exited with 22") && text.contains("401") && text.contains("Bad credentials"), "{text}");
        let req = request(&[("Authorization", "Bearer ghp_secret123")], None);
        assert!(!redact_secrets(&text, &secrets_of(&req)).contains("ghp_secret123"));
    }

    #[test]
    fn an_old_curl_is_detected_by_its_complaint() {
        let old = process::Finished {
            code: Some(2),
            stdout: String::new(),
            stderr: "curl: option --fail-with-body: is unknown\ncurl: try 'curl --help'".to_string(),
        };
        assert!(lacks_fail_with_body(&old));
        let other = process::Finished { code: Some(22), stdout: String::new(), stderr: "returned error: 404".to_string() };
        assert!(!lacks_fail_with_body(&other));
    }
}
