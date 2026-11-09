//! The `emit` templates: `{path}` and `{path|filter}`.
//!
//! Paths read one event: `key`, `version`, `event`, `source`, and
//! `fields.a.b` (array indices as segments, `fields.labels.0`). A path that
//! reads nothing renders as the empty string rather than failing: a field a
//! source does not always carry (a PR without labels) must not stop the drop.
//! Filters are a short fixed list on purpose; anything cleverer belongs in a
//! `command` probe (`docs/design/ticket-sources.md` 3.2).

use serde_json::Value;

/// What one event offers a template.
pub(crate) struct Scope<'a> {
    pub key: &'a str,
    pub version: &'a str,
    pub event: &'a str,
    pub source: &'a str,
    pub fields: &'a Value,
}

const FILTERS: &[&str] = &["short", "lower", "upper", "trim"];

/// Check a template's syntax without rendering it: unbalanced braces and
/// unknown filters are reported when the config is saved, not at a scan.
pub(crate) fn validate(template: &str) -> Result<(), String> {
    for piece in pieces(template)? {
        if let Piece::Expr(expr) = piece {
            let (path, filters) = split_expr(&expr);
            if path.is_empty() {
                return Err(format!("empty placeholder in {template:?}"));
            }
            for f in filters {
                if !FILTERS.contains(&f.as_str()) {
                    return Err(format!("unknown template filter {f:?} (known: {})", FILTERS.join(", ")));
                }
            }
        }
    }
    Ok(())
}

/// Render `template` for one event. Assumes `validate` passed; an invalid
/// template renders its broken part literally rather than panicking.
pub(crate) fn render(template: &str, scope: &Scope) -> String {
    let Ok(parts) = pieces(template) else {
        return template.to_string();
    };
    let mut out = String::new();
    for piece in parts {
        match piece {
            Piece::Text(text) => out.push_str(&text),
            Piece::Expr(expr) => {
                let (path, filters) = split_expr(&expr);
                let mut value = lookup(&path, scope);
                for f in filters {
                    value = apply(&f, value);
                }
                out.push_str(&value);
            }
        }
    }
    out
}

/// One line for a front-matter field: newlines become spaces, ends trimmed.
pub(crate) fn one_line(text: &str) -> String {
    text.replace("\r\n", " ").replace(['\r', '\n'], " ").trim().to_string()
}

enum Piece {
    Text(String),
    Expr(String),
}

/// Split into literal text and `{…}` expressions; `{{` / `}}` are literal braces.
fn pieces(template: &str) -> Result<Vec<Piece>, String> {
    let chars: Vec<char> = template.chars().collect();
    let mut parts = Vec::new();
    let mut text = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '{' && chars.get(i + 1) == Some(&'{') {
            text.push('{');
            i += 2;
        } else if c == '}' && chars.get(i + 1) == Some(&'}') {
            text.push('}');
            i += 2;
        } else if c == '{' {
            let close = chars[i + 1..]
                .iter()
                .position(|&ch| ch == '}')
                .ok_or_else(|| format!("unclosed {{ in {template:?}"))?;
            let expr: String = chars[i + 1..i + 1 + close].iter().collect();
            if expr.contains('{') {
                return Err(format!("nested {{ in {template:?}"));
            }
            if !text.is_empty() {
                parts.push(Piece::Text(std::mem::take(&mut text)));
            }
            parts.push(Piece::Expr(expr));
            i += close + 2;
        } else if c == '}' {
            return Err(format!("unmatched }} in {template:?} (write }}}} for a literal brace)"));
        } else {
            text.push(c);
            i += 1;
        }
    }
    if !text.is_empty() {
        parts.push(Piece::Text(text));
    }
    Ok(parts)
}

fn split_expr(expr: &str) -> (String, Vec<String>) {
    let mut parts = expr.split('|').map(|s| s.trim().to_string());
    let path = parts.next().unwrap_or_default();
    (path, parts.collect())
}

/// Read a dotted path from an event, as text.
pub(crate) fn lookup(path: &str, scope: &Scope) -> String {
    match path {
        "key" => return scope.key.to_string(),
        "version" => return scope.version.to_string(),
        "event" => return scope.event.to_string(),
        "source" => return scope.source.to_string(),
        _ => {}
    }
    let Some(rest) = path.strip_prefix("fields") else {
        return String::new();
    };
    let value = if rest.is_empty() {
        Some(scope.fields)
    } else if let Some(rest) = rest.strip_prefix('.') {
        walk(scope.fields, rest)
    } else {
        None
    };
    value.map(as_text).unwrap_or_default()
}

/// Walk `a.b.0` through objects and arrays. Shared with the scan's `filter`.
pub(crate) fn walk<'v>(value: &'v Value, path: &str) -> Option<&'v Value> {
    let mut cur = value;
    for seg in path.split('.') {
        cur = match cur {
            Value::Object(map) => map.get(seg)?,
            Value::Array(list) => list.get(seg.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur)
}

/// How a JSON value reads in a template: strings as-is, scalars literally,
/// arrays and objects as compact JSON, null as nothing.
pub(crate) fn as_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

fn apply(filter: &str, value: String) -> String {
    match filter {
        "short" => value.chars().take(7).collect(),
        "lower" => value.to_lowercase(),
        "upper" => value.to_uppercase(),
        "trim" => value.trim().to_string(),
        _ => value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scope(fields: &Value) -> Scope<'_> {
        Scope { key: "12", version: "3f2a1b9c0d", event: "added", source: "repo-a", fields }
    }

    #[test]
    fn paths_render() {
        let f = json!({"title": "Fix", "n": 3, "draft": false, "labels": ["bug", "ui"], "user": {"login": "amy"}, "none": null});
        let s = scope(&f);
        assert_eq!(render("PR #{key}: {fields.title}", &s), "PR #12: Fix");
        assert_eq!(render("{event}/{source}/{version}", &s), "added/repo-a/3f2a1b9c0d");
        assert_eq!(render("{fields.n} {fields.draft}", &s), "3 false");
        assert_eq!(render("{fields.labels.1}", &s), "ui");
        assert_eq!(render("{fields.user.login}", &s), "amy");
        assert_eq!(render("{fields.labels}", &s), r#"["bug","ui"]"#);
        assert_eq!(render("{fields.user}", &s), r#"{"login":"amy"}"#);
    }

    #[test]
    fn missing_paths_are_empty() {
        let f = json!({});
        let s = scope(&f);
        assert_eq!(render("[{fields.nope}][{fields.a.b}][{whatever}][{fields.none}]", &s), "[][][][]");
    }

    #[test]
    fn filters() {
        let f = json!({"t": "  Hi  "});
        let s = scope(&f);
        assert_eq!(render("{version|short}", &s), "3f2a1b9");
        assert_eq!(render("{fields.t|trim|upper}", &s), "HI");
        assert_eq!(render("{fields.t|lower}", &s), "  hi  ");
    }

    #[test]
    fn braces_escape() {
        let f = json!({});
        assert_eq!(render("{{literal}} {key}", &scope(&f)), "{literal} 12");
    }

    #[test]
    fn validation() {
        assert!(validate("ok {key|short}").is_ok());
        assert!(validate("{{fine}}").is_ok());
        assert!(validate("{key").unwrap_err().contains("unclosed"));
        assert!(validate("key}").unwrap_err().contains("unmatched"));
        assert!(validate("{}").unwrap_err().contains("empty"));
        assert!(validate("{key|bold}").unwrap_err().contains("unknown template filter"));
    }

    #[test]
    fn one_line_flattens() {
        assert_eq!(one_line(" a\r\nb\nc "), "a b c");
    }
}
