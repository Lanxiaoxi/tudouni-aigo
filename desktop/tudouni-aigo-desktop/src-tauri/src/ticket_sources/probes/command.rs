//! `command`: the extension point. Any program that prints
//! `[{"key", "version", "fields"?}]` on stdout can be a Source, in any
//! language, without changing the application.

use super::process;
use super::{opt_str, timeout_of, Item, ProbeCtx, ProbeOutput};
use serde_json::{Map, Value};
use std::path::Path;

/// How much of a bad stdout to quote in an error: enough to recognise a
/// stack trace or an HTML page, not enough to flood the Source's status line.
const STDOUT_HEAD_CHARS: usize = 200;

pub(super) fn run(_kind: &str, probe: &Map<String, Value>, _ctx: &ProbeCtx) -> Result<ProbeOutput, String> {
    let argv = argv_of(probe)?;
    let timeout = timeout_of(probe)?;
    let cwd = match opt_str(probe, "cwd")? {
        Some(dir) => {
            // Checked here rather than left to the OS: a missing directory
            // otherwise surfaces as "program not found" on some platforms.
            if !Path::new(dir).is_dir() {
                return Err(format!("command: cwd {dir} is not an existing directory"));
            }
            Some(Path::new(dir))
        }
        None => None,
    };
    // run_ok turns a non-zero exit into an error carrying the end of stderr.
    let stdout = process::run_ok(&argv[0], &argv[1..], cwd, timeout)?;
    parse_command_output(&stdout)
}

pub(super) fn validate(_kind: &str, probe: &Map<String, Value>) -> Result<(), String> {
    argv_of(probe)?;
    opt_str(probe, "cwd")?;
    Ok(())
}

/// `run` as an argv array. It is never a shell string: no quoting rules to get
/// wrong, and nothing in a template or a path can inject a second command.
fn argv_of(probe: &Map<String, Value>) -> Result<Vec<String>, String> {
    let list = match probe.get("run") {
        None | Some(Value::Null) => return Err("probe parameter \"run\" is required".to_string()),
        Some(Value::Array(list)) => list,
        Some(_) => return Err("probe parameter \"run\" must be an array of strings (program, then arguments)".to_string()),
    };
    let mut argv = Vec::with_capacity(list.len());
    for (index, part) in list.iter().enumerate() {
        match part {
            Value::String(s) => argv.push(s.clone()),
            _ => return Err(format!("probe parameter \"run\" must contain only strings; element {index} is not")),
        }
    }
    match argv.first() {
        None => Err("probe parameter \"run\" must not be empty".to_string()),
        Some(program) if program.trim().is_empty() => Err("probe parameter \"run\": the program name is empty".to_string()),
        Some(_) => Ok(argv),
    }
}

/// Turn a program's stdout into items.
///
/// Bad elements are skipped with a warning so one malformed row does not hide
/// the rest; but if *nothing* usable came back from a non-empty array the
/// program is almost certainly speaking another dialect, and reporting an
/// empty success would make every previous item look removed.
pub(super) fn parse_command_output(text: &str) -> Result<ProbeOutput, String> {
    // PowerShell and some Windows tools put a BOM in front of the output.
    let trimmed = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let value: Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("command stdout is not JSON ({e}); it starts with: {}", head(trimmed)))?;
    let entries = match value {
        Value::Array(entries) => entries,
        _ => {
            return Err(format!(
                "command stdout must be a JSON array of {{key, version, fields?}} objects; it starts with: {}",
                head(trimmed)
            ))
        }
    };

    let mut items = Vec::new();
    let mut warnings = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        match parse_entry(entry) {
            Ok(item) => items.push(item),
            Err(why) => warnings.push(format!("item {index} skipped: {why}")),
        }
    }
    if items.is_empty() && !entries.is_empty() {
        return Err(format!(
            "none of the {} items from the command is usable; first problem: {}",
            entries.len(),
            warnings.first().map_or("unknown", String::as_str)
        ));
    }
    Ok(ProbeOutput { items, warnings })
}

fn parse_entry(entry: &Value) -> Result<Item, String> {
    let object = entry.as_object().ok_or("it is not an object")?;
    let key = scalar_text(object.get("key"), "key")?;
    if key.is_empty() {
        return Err("\"key\" is empty".to_string());
    }
    let version = scalar_text(object.get("version"), "version")?;
    let fields = match object.get("fields") {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(fields @ Value::Object(_)) => fields.clone(),
        Some(_) => return Err("\"fields\" must be an object".to_string()),
    };
    Ok(Item { key, version, fields })
}

/// A string, or a number written out as text: programs that count things
/// naturally emit numeric ids and should not have to quote them.
fn scalar_text(value: Option<&Value>, name: &str) -> Result<String, String> {
    match value {
        Some(Value::String(s)) => Ok(s.clone()),
        Some(Value::Number(n)) => Ok(n.to_string()),
        None | Some(Value::Null) => Err(format!("\"{name}\" is missing")),
        Some(_) => Err(format!("\"{name}\" must be a string or a number")),
    }
}

fn head(text: &str) -> String {
    text.chars().take(STDOUT_HEAD_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    const CTX: ProbeCtx = ProbeCtx { now_ms: 0, tz_offset_minutes: 0 };

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn numbers_become_text() {
        let out = parse_command_output(r#"[{"key": 42, "version": 2.5, "fields": {"n": 1}}]"#).unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.items[0].key, "42");
        assert_eq!(out.items[0].version, "2.5");
        assert_eq!(out.items[0].fields, json!({"n": 1}));
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn a_bom_and_surrounding_whitespace_are_ignored() {
        let out = parse_command_output("\u{feff}\r\n [{\"key\":\"a\",\"version\":\"1\"}] \r\n").unwrap();
        assert_eq!(out.items.len(), 1);
        // fields may be left out; templates then see an empty object.
        assert_eq!(out.items[0].fields, json!({}));
        let out = parse_command_output(r#"[{"key":"a","version":"1","fields":null}]"#).unwrap();
        assert_eq!(out.items[0].fields, json!({}));
    }

    #[test]
    fn bad_elements_are_skipped_with_a_warning() {
        let text = r#"[
            {"key": "good", "version": "1"},
            {"key": true, "version": "1"},
            {"version": "1"},
            "just a string",
            {"key": "b", "version": "2", "fields": [1]},
            {"key": "", "version": "1"}
        ]"#;
        let out = parse_command_output(text).unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.items[0].key, "good");
        assert_eq!(out.warnings.len(), 5);
        assert!(out.warnings[0].contains("item 1"), "{:?}", out.warnings);
    }

    #[test]
    fn nothing_usable_in_a_non_empty_array_is_an_error() {
        let err = parse_command_output(r#"[{"id": 1}, {"id": 2}]"#).unwrap_err();
        assert!(err.contains("none of the 2 items"), "{err}");
        assert!(err.contains("key"), "{err}");
    }

    #[test]
    fn an_empty_array_is_a_valid_empty_answer() {
        let out = parse_command_output("[]").unwrap();
        assert!(out.items.is_empty() && out.warnings.is_empty());
    }

    #[test]
    fn something_other_than_an_array_is_an_error() {
        let err = parse_command_output(r#"{"key": "a", "version": "1"}"#).unwrap_err();
        assert!(err.contains("JSON array"), "{err}");
        assert!(parse_command_output("42").is_err());
    }

    #[test]
    fn non_json_quotes_only_the_start_of_stdout() {
        let err = parse_command_output("hello there").unwrap_err();
        assert!(err.contains("not JSON") && err.contains("hello there"), "{err}");
        let err = parse_command_output(&"q".repeat(500)).unwrap_err();
        assert!(err.contains(&"q".repeat(200)), "{err}");
        assert!(!err.contains(&"q".repeat(201)), "{err}");
        assert!(parse_command_output("").is_err());
    }

    #[test]
    fn validate_checks_the_argv() {
        let check = |v: Value| validate("command", &obj(v));
        assert!(check(json!({"run": ["node", "x.js"]})).is_ok());
        assert!(check(json!({"run": ["node"], "cwd": "C:/anywhere"})).is_ok());
        assert!(check(json!({})).is_err());
        assert!(check(json!({"run": "node x.js"})).is_err());
        assert!(check(json!({"run": []})).is_err());
        assert!(check(json!({"run": [" "]})).is_err());
        assert!(check(json!({"run": ["node", 3]})).is_err());
        assert!(check(json!({"run": ["node"], "cwd": 3})).is_err());
    }

    #[test]
    fn a_missing_program_is_reported() {
        let probe = obj(json!({"run": ["definitely-not-a-program-xyz"]}));
        let err = run("command", &probe, &CTX).unwrap_err();
        assert!(err.contains("not found"), "{err}");
    }

    #[test]
    fn a_missing_cwd_names_the_directory() {
        let probe = obj(json!({"run": ["whatever"], "cwd": "Z:/definitely/not/here"}));
        let err = run("command", &probe, &CTX).unwrap_err();
        assert!(err.contains("Z:/definitely/not/here"), "{err}");
    }

    /// A scratch directory named after the pid, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!("tudouni-command-probe-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            TempDir(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // The end-to-end tests drive `cmd`, which every Windows machine has, and
    // read the JSON from a file so no shell quoting is involved.
    #[cfg(windows)]
    #[test]
    fn a_program_printing_json_succeeds_in_its_cwd() {
        let tmp = TempDir::new("ok");
        std::fs::write(tmp.0.join("out.json"), "\u{feff}[{\"key\":\"a\",\"version\":\"1\"},{\"key\":7,\"version\":8}]").unwrap();
        let probe = obj(json!({
            "run": ["cmd", "/C", "type", "out.json"],
            "cwd": tmp.0.to_string_lossy(),
        }));
        let out = run("command", &probe, &CTX).unwrap();
        let keys: Vec<&str> = out.items.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(keys, vec!["a", "7"]);
        assert_eq!(out.items[1].version, "8");
    }

    #[cfg(windows)]
    #[test]
    fn a_non_zero_exit_is_an_error_with_the_end_of_stderr() {
        let probe = obj(json!({"run": ["cmd", "/C", "echo oops 1>&2& exit 3"]}));
        let err = run("command", &probe, &CTX).unwrap_err();
        assert!(err.contains("exited with 3") && err.contains("oops"), "{err}");
    }

    #[cfg(windows)]
    #[test]
    fn output_that_is_not_json_is_an_error() {
        let probe = obj(json!({"run": ["cmd", "/C", "echo hello there"]}));
        let err = run("command", &probe, &CTX).unwrap_err();
        assert!(err.contains("not JSON") && err.contains("hello there"), "{err}");
    }

    #[cfg(windows)]
    #[test]
    fn a_slow_program_times_out() {
        let probe = obj(json!({
            "run": ["powershell", "-NoProfile", "-Command", "Start-Sleep -Seconds 20"],
            "timeoutSec": 1,
        }));
        let err = run("command", &probe, &CTX).unwrap_err();
        assert!(err.contains("did not finish"), "{err}");
    }
}
