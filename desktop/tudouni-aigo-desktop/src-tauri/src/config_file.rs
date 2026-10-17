//! `~/.tudouni/config.json` and `~/.tudouni/mcp.json`, for the config panel.
//!
//! **The desktop is the writer here, and that is a deliberate choice rather than
//! an accident.** The alternative was a pair of protocol messages the runtime
//! answers, and it cost a version bump on the Go side plus a full test run for
//! what is, in the end, a form. What is actually load-bearing is not *who* writes
//! but *how*: read the object that is on disk, set only the keys the form owns,
//! write it back atomically. Anyone doing that cannot lose what they did not look
//! at.
//!
//! Three rules carry the weight:
//!
//! 1. **The merge is field-wise, never a rebuild.** The form holds a list of
//!    routes, and the obvious implementation — serialise that list over the file —
//!    deletes `$comment` (which is this file's only documentation, since JSON has
//!    no comments), deletes any key the form has no field for, and would delete
//!    `providers.ericai.api_key` if a route happened to be missing from the form's
//!    state. So the existing route objects are *moved* into the new order and
//!    mutated in place; everything not named below survives untouched.
//! 2. **A file that will not parse is read-only.** The panel refuses to offer a
//!    save when the document could not be understood, because the merge would have
//!    nothing to preserve and the write would be a wholesale replacement — of the
//!    one file whose contents are somebody's keys.
//! 3. **Order is data.** `providers` is read in file order and the first route
//!    with a key is the default route (`internal/state/catalog.go`,
//!    `Registry.DefaultProvider`). A JSON object has no order, so this module
//!    reads and writes through `serde_json`'s `preserve_order` (see `Cargo.toml`);
//!    without it a save would silently re-sort the routes and hand the default to
//!    whichever name sorts first.
//!
//! The write shape mirrors `ericWriteBack` in the runtime
//! (`internal/runtime/ericai.go`) — a temp file in the same directory, then a
//! rename — because that file is the only other writer of `config.json` and two
//! writers that disagree about atomicity is how a half-written key file happens.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/// File names, matching `internal/config` and `internal/runtime/config.go`.
const CONFIG_FILE_NAME: &str = "config.json";
const MCP_FILE_NAME: &str = "mcp.json";
/// The per-user directory both files live in (`paths.UserConfigDir`).
const RUNTIME_DIR: &str = ".tudouni";
/// `AGENT_CONFIG_FILE`, which the runtime honours (`config.FileEnv`).
const ENV_CONFIG_FILE: &str = "AGENT_CONFIG_FILE";

/* ============================================================
   What the panel reads
   ============================================================ */

/// One `key → value` pair, in the order the file lists it.
///
/// A list rather than an object because the panel draws rows: an object with no
/// order would re-arrange itself between renders.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pair {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelView {
    pub id: String,
    pub label: String,
    /// Null means the catalogue does not know the window, which is a real
    /// answer: the interface then reports usage without a percentage, and a
    /// wrong percentage is worse than none.
    pub context_window: Option<i64>,
    pub summary: String,
    pub note: String,
    pub vision: bool,
    /// Empty means "the model's own default", which the runtime resolves to
    /// `high` (`state.DefaultEffort`).
    pub reasoning_effort: String,
    pub effort_levels: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteView {
    pub name: String,
    pub display_name: String,
    pub base_url: String,
    pub api_key: String,
    /// Empty means "work it out from `base_url`", which is right for almost
    /// every route.
    pub api_style: String,
    pub verify: bool,
    pub headers: Vec<Pair>,
    pub effort_levels: Vec<String>,
    pub models: Vec<ModelView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebView {
    pub tavily_api_key: String,
    pub tavily_base_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerView {
    pub name: String,
    pub command: String,
    pub url: String,
    pub args: Vec<String>,
    pub env: Vec<Pair>,
    pub headers: Vec<Pair>,
    pub timeout_seconds: Option<f64>,
    /// Whether the runtime mounts this server when a session opens.
    ///
    /// Read straight from the file's `auto_load` (`parseMcpServers` defaults it to
    /// false). Absent and false are one fact to the runtime, so the panel draws one
    /// unticked box rather than inventing a third state for the two spellings.
    pub auto_load: bool,
}

/// `mcp.json` and the trouble it is in, kept **separate** from the rest.
///
/// A broken `mcp.json` must not lock the routes editor: they are two files, they
/// fail independently, and one of them holds the keys somebody came here to fix.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDocumentView {
    pub path: String,
    pub exists: bool,
    /// Non-null means "the panel will not write this file".
    pub problem: Option<String>,
    pub servers: Vec<McpServerView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDocument {
    pub path: String,
    pub exists: bool,
    /// Non-null means "the panel will not write this file": either it could not
    /// be parsed, or it is shaped in a way the merge cannot reason about. See
    /// rule 2 in the module comment.
    pub problem: Option<String>,
    pub providers: Vec<RouteView>,
    pub web: WebView,
    pub mcp: McpDocumentView,
}

/* ============================================================
   What the panel sends back
   ============================================================ */

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelPatch {
    pub id: String,
    pub label: String,
    pub context_window: Option<i64>,
    pub summary: String,
    pub note: String,
    pub vision: bool,
    pub reasoning_effort: String,
    pub effort_levels: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RoutePatch {
    pub name: String,
    pub display_name: String,
    pub base_url: String,
    pub api_key: String,
    pub api_style: String,
    pub verify: bool,
    pub headers: Vec<Pair>,
    pub effort_levels: Vec<String>,
    pub models: Vec<ModelPatch>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WebPatch {
    pub tavily_api_key: String,
    pub tavily_base_url: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct McpPatch {
    pub name: String,
    pub command: String,
    pub url: String,
    pub args: Vec<String>,
    pub env: Vec<Pair>,
    pub headers: Vec<Pair>,
    pub timeout_seconds: Option<f64>,
    /// `true` mounts this server at session start.
    ///
    /// A missing field deserialises to false and the save then **removes** the key
    /// from the file. That direction is the deliberate one: forgetting the field can
    /// only make a server less automatic, never more, so a writer that does not know
    /// about `auto_load` cannot turn a manually mounted server into one that runs on
    /// its own at start-up.
    pub auto_load: bool,
}

/// One save. **An absent section is not written at all.**
///
/// That is not a convenience: `mcp.json` is a list of programs the runtime
/// executes at startup, and an empty one is a different statement from a missing
/// one. Saving an edited route must not create it as a side effect.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConfigPatch {
    pub providers: Option<Vec<RoutePatch>>,
    pub web: Option<WebPatch>,
    pub mcp: Option<Vec<McpPatch>>,
}

/* ============================================================
   Paths
   ============================================================ */

fn home_dir() -> Option<PathBuf> {
    // `USERPROFILE` then `HOME`, the same order `unsafe_workspace` uses and the
    // same set Go's `os.UserHomeDir` consults.
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// Which `config.json` is in force.
///
/// `AGENT_CONFIG_FILE` is honoured, and that is **not** a detail: the runtime
/// reads it (`config.ConfigFile`), so a panel that ignored it would edit a file
/// nothing was reading — "I changed my key and nothing happened", which is the
/// exact complaint this panel exists to prevent.
fn config_path() -> Result<PathBuf, String> {
    if let Some(forced) = std::env::var_os(ENV_CONFIG_FILE) {
        let text = forced.to_string_lossy().trim().to_string();
        if !text.is_empty() {
            return Ok(PathBuf::from(text));
        }
    }
    let home = home_dir().ok_or("the home directory could not be read")?;
    Ok(home.join(RUNTIME_DIR).join(CONFIG_FILE_NAME))
}

/// Reads the local `config.json` as plain text, for Phase 4's config sync
/// (§9) — the structured `read_document`/`ConfigDocument` the rest of this
/// module uses is the right shape for the settings panel, but a sync
/// comparison needs the exact bytes a fingerprint is taken over and the
/// exact bytes a `'sync-local'` policy uploads, not a re-serialised copy
/// that could legally differ in key order or whitespace from what is
/// actually on disk. `None` means the file does not exist, which is a
/// normal, expected state (not yet configured) rather than an error.
pub fn read_local_config_text() -> Result<Option<String>, String> {
    let path = config_path()?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}


/// `mcp.json` is always the user-level file; there is no variable for it.
fn mcp_path() -> Result<PathBuf, String> {
    let home = home_dir().ok_or("the home directory could not be read")?;
    Ok(home.join(RUNTIME_DIR).join(MCP_FILE_NAME))
}

/* ============================================================
   Reading
   ============================================================ */

/// The file's top-level object, or `None` when there is no file.
///
/// A byte-order mark is stripped for the same reason `config.readJSONDocument`
/// strips it: this file is edited by hand on Windows, where Notepad has been
/// known to leave one, and `serde_json` refuses it.
fn read_object(path: &Path) -> Result<Option<Map<String, Value>>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("{} could not be read: {err}", path.display())),
    };
    if bytes.is_empty() {
        return Ok(Some(Map::new()));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| format!("{} is not valid UTF-8", path.display()))?;
    let text = text.trim_start_matches('\u{feff}');
    let value: Value = serde_json::from_str(text)
        .map_err(|err| format!("{} is not valid JSON: {err}", path.display()))?;
    match value {
        Value::Object(object) => Ok(Some(object)),
        _ => Err(format!("{} must hold a JSON object", path.display())),
    }
}

fn text_of(object: &Map<String, Value>, key: &str) -> String {
    match object.get(key) {
        Some(Value::String(text)) => text.trim().to_string(),
        _ => String::new(),
    }
}

fn flag_of(object: &Map<String, Value>, key: &str, fallback: bool) -> bool {
    match object.get(key) {
        Some(Value::Bool(flag)) => *flag,
        _ => fallback,
    }
}

fn strings_of(object: &Map<String, Value>, key: &str) -> Vec<String> {
    match object.get(key) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

fn pairs_of(object: &Map<String, Value>, key: &str) -> Vec<Pair> {
    match object.get(key) {
        // Insertion order, thanks to `preserve_order` — the same reason the
        // routes keep theirs.
        Some(Value::Object(map)) => map
            .iter()
            .map(|(name, value)| Pair {
                key: name.clone(),
                value: value.as_str().unwrap_or_default().to_string(),
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// An integer, accepting `200000.0` as well as `200000`.
///
/// Go's `jsonInt` takes an integral float, so a hand-written window may legally
/// be spelled either way. Refusing the second would show "no window" over a file
/// the runtime reads fine.
fn int_of(object: &Map<String, Value>, key: &str) -> Option<i64> {
    let value = object.get(key)?;
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    let float = value.as_f64()?;
    if float.fract() == 0.0 {
        Some(float as i64)
    } else {
        None
    }
}

fn float_of(object: &Map<String, Value>, key: &str) -> Option<f64> {
    object.get(key).and_then(Value::as_f64)
}

fn model_view(entry: &Map<String, Value>) -> ModelView {
    ModelView {
        id: text_of(entry, "id"),
        label: text_of(entry, "label"),
        context_window: int_of(entry, "context_window"),
        summary: text_of(entry, "summary"),
        note: text_of(entry, "note"),
        vision: flag_of(entry, "vision", false),
        reasoning_effort: text_of(entry, "reasoning_effort"),
        effort_levels: strings_of(entry, "effort_levels"),
    }
}

fn route_view(name: &str, entry: &Map<String, Value>) -> RouteView {
    let models = match entry.get("models") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_object)
            .map(model_view)
            .collect(),
        _ => Vec::new(),
    };
    RouteView {
        name: name.to_string(),
        display_name: text_of(entry, "display_name"),
        base_url: text_of(entry, "base_url"),
        api_key: text_of(entry, "api_key"),
        api_style: text_of(entry, "api_style"),
        // `catalog.flagField` defaults this to true, so an absent key means
        // "verify" and the panel must not draw it as "off".
        verify: flag_of(entry, "verify", true),
        headers: pairs_of(entry, "headers"),
        effort_levels: strings_of(entry, "effort_levels"),
        models,
    }
}

fn server_view(name: &str, entry: &Map<String, Value>) -> McpServerView {
    McpServerView {
        name: name.to_string(),
        command: text_of(entry, "command"),
        url: text_of(entry, "url"),
        args: strings_of(entry, "args"),
        env: pairs_of(entry, "env"),
        headers: pairs_of(entry, "headers"),
        timeout_seconds: float_of(entry, "timeout_seconds"),
        auto_load: flag_of(entry, "auto_load", false),
    }
}

/// Whether the document is shaped the way the merge assumes.
///
/// **This exists so a save cannot be a silent rewrite.** The merge moves whole
/// route objects around; if a route were, say, a string, the merge would have no
/// object to move and would write a fresh one in its place — destroying
/// whatever the person actually wrote. Every case checked here is one the Go
/// catalogue rejects anyway, so refusing to edit costs nothing and the runtime's
/// own message remains the authority on *why*.
fn structural_problem(object: &Map<String, Value>) -> Option<String> {
    match object.get("providers") {
        None | Some(Value::Null) => {}
        Some(Value::Object(routes)) => {
            for (name, value) in routes {
                let Some(entry) = value.as_object() else {
                    return Some(format!("the route \"{name}\" is not an object"));
                };
                if matches!(entry.get("headers"), Some(item) if !item.is_null() && !item.is_object()) {
                    return Some(format!("\"headers\" on route \"{name}\" is not an object"));
                }
                for key in ["effort_levels", "models"] {
                    if matches!(entry.get(key), Some(item) if !item.is_null() && !item.is_array()) {
                        return Some(format!("\"{key}\" on route \"{name}\" is not a list"));
                    }
                }
                if let Some(Value::Array(models)) = entry.get("models") {
                    for (index, item) in models.iter().enumerate() {
                        let Some(model) = item.as_object() else {
                            return Some(format!(
                                "model {} on route \"{name}\" is not an object",
                                index + 1
                            ));
                        };
                        if matches!(model.get("effort_levels"), Some(level) if !level.is_null() && !level.is_array())
                        {
                            return Some(format!(
                                "\"effort_levels\" on model {} of route \"{name}\" is not a list",
                                index + 1
                            ));
                        }
                    }
                }
            }
        }
        Some(_) => return Some("\"providers\" is not an object".to_string()),
    }

    match object.get("web") {
        None | Some(Value::Null) | Some(Value::Object(_)) => {}
        Some(_) => return Some("\"web\" is not an object".to_string()),
    }

    None
}

fn mcp_structural_problem(object: &Map<String, Value>) -> Option<String> {
    // `parseMcpServers` accepts `servers` and nothing else at the top level, and
    // it does so as an error rather than a shrug — which is right, because
    // `command` in this file is a program the runtime runs at startup. A file
    // the runtime would refuse is a file this panel must not edit.
    for key in object.keys() {
        if key != "servers" {
            return Some(format!(
                "mcp.json has a key the runtime does not accept: \"{key}\" (only \"servers\" is read)"
            ));
        }
    }
    match object.get("servers") {
        None | Some(Value::Null) => None,
        Some(Value::Object(servers)) => {
            for (name, value) in servers {
                let Some(entry) = value.as_object() else {
                    return Some(format!("the MCP server \"{name}\" is not an object"));
                };
                for key in ["env", "headers"] {
                    if matches!(entry.get(key), Some(item) if !item.is_null() && !item.is_object()) {
                        return Some(format!("\"{key}\" on MCP server \"{name}\" is not an object"));
                    }
                }
                if matches!(entry.get("args"), Some(item) if !item.is_null() && !item.is_array()) {
                    return Some(format!("\"args\" on MCP server \"{name}\" is not a list"));
                }
            }
            None
        }
        Some(_) => Some("\"servers\" is not an object".to_string()),
    }
}

/// Read both files. Never fails for a *missing* file — only for a broken one,
/// and even then the trouble is reported inside the document rather than as an
/// error, so the paths stay visible.
pub fn read_document() -> Result<ConfigDocument, String> {
    let path = config_path()?;
    let (object, exists, mut problem) = match read_object(&path) {
        Ok(Some(object)) => (object, true, None),
        Ok(None) => (Map::new(), false, None),
        Err(problem) => (Map::new(), true, Some(problem)),
    };
    if problem.is_none() {
        problem = structural_problem(&object);
    }

    let mut providers = Vec::new();
    if problem.is_none() {
        if let Some(Value::Object(routes)) = object.get("providers") {
            for (name, value) in routes {
                if let Some(entry) = value.as_object() {
                    providers.push(route_view(name, entry));
                }
            }
        }
    }

    let web_entry = match object.get("web") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };

    let mcp_path = mcp_path()?;
    let mcp = match read_object(&mcp_path) {
        Ok(Some(object)) => {
            let problem = mcp_structural_problem(&object);
            // Only read the servers when the shape was accepted: a file that
            // failed the check above may hold entries of any shape at all, and
            // drawing a half-built one would invite an edit to a file this
            // module has already decided not to write.
            let servers = match (problem.as_ref(), object.get("servers")) {
                (None, Some(Value::Object(map))) => map
                    .iter()
                    .filter_map(|(name, value)| {
                        value.as_object().map(|entry| server_view(name, entry))
                    })
                    .collect(),
                _ => Vec::new(),
            };
            McpDocumentView {
                path: mcp_path.display().to_string(),
                exists: true,
                problem,
                servers,
            }
        }
        Ok(None) => McpDocumentView {
            path: mcp_path.display().to_string(),
            exists: false,
            problem: None,
            servers: Vec::new(),
        },
        Err(problem) => McpDocumentView {
            path: mcp_path.display().to_string(),
            exists: true,
            problem: Some(problem),
            servers: Vec::new(),
        },
    };

    Ok(ConfigDocument {
        path: path.display().to_string(),
        exists,
        problem,
        providers,
        web: WebView {
            tavily_api_key: text_of(&web_entry, "tavily_api_key"),
            tavily_base_url: text_of(&web_entry, "tavily_base_url"),
        },
        mcp,
    })
}

/* ============================================================
   Writing
   ============================================================ */

/// The sub-object a section lives in, created if it is absent and left **in
/// place** if it is not.
///
/// A key that moves to the end of the file on every save would make a one-field
/// edit look like a rewrite in `git diff` — and this file is one people keep in
/// a repository.
fn child_object<'a>(
    object: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    if matches!(object.get(key), None | Some(Value::Null)) {
        object.insert(key.to_string(), Value::Object(Map::new()));
    }
    match object.get_mut(key) {
        Some(Value::Object(map)) => Ok(map),
        _ => Err(format!(
            "\"{key}\" in the configuration file is not an object, so nothing was written"
        )),
    }
}

/// Write the value, or drop the key when there is nothing to say.
///
/// Optional descriptive keys are **removed** rather than written empty: the Go
/// reader cannot tell an absent key from an empty one (`catalog.textField`), so
/// writing `""` would only add a line that says nothing.
fn set_optional_text(entry: &mut Map<String, Value>, key: &str, value: &str) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        entry.remove(key);
    } else {
        entry.insert(key.to_string(), Value::String(trimmed.to_string()));
    }
}

fn set_pairs(entry: &mut Map<String, Value>, key: &str, pairs: &[Pair]) {
    let mut map = Map::new();
    for pair in pairs {
        let name = pair.key.trim();
        if name.is_empty() {
            continue;
        }
        // The value is **not** trimmed: `headersField` keeps header values
        // verbatim, and a header value is not prose.
        map.insert(name.to_string(), Value::String(pair.value.clone()));
    }
    if map.is_empty() {
        entry.remove(key);
    } else {
        entry.insert(key.to_string(), Value::Object(map));
    }
}

fn set_string_list(entry: &mut Map<String, Value>, key: &str, values: &[String]) {
    let list: Vec<Value> = values
        .iter()
        .filter(|value| !value.trim().is_empty())
        .map(|value| Value::String(value.clone()))
        .collect();
    if list.is_empty() {
        entry.remove(key);
    } else {
        entry.insert(key.to_string(), Value::Array(list));
    }
}

/// `effort_levels`: lower-cased, trimmed, de-duplicated.
///
/// This mirrors `state.NormalizeEffortLevels`, which the runtime runs on read.
/// The normalisation is done here as well so that what the file says is what
/// takes effect — a declared list that the runtime silently rewrites is a list
/// whose text lies about the levels `--effort` will accept.
fn set_effort_levels(entry: &mut Map<String, Value>, key: &str, values: &[String]) {
    let mut seen = HashSet::new();
    let mut list = Vec::new();
    for value in values {
        let level = value.trim().to_lowercase();
        if level.is_empty() || !seen.insert(level.clone()) {
            continue;
        }
        list.push(Value::String(level));
    }
    if list.is_empty() {
        entry.remove(key);
    } else {
        entry.insert(key.to_string(), Value::Array(list));
    }
}

fn apply_models(
    entry: &mut Map<String, Value>,
    models: &[ModelPatch],
    route: &str,
) -> Result<(), String> {
    if models.is_empty() {
        // Absent `models` means "this route cannot be selected"
        // (`catalog.problem.no_models`), which is the honest reading of an
        // empty list rather than an empty array that means the same thing less
        // clearly.
        entry.remove("models");
        return Ok(());
    }

    // The `$comment`s already in the file, by model id. A model entry is the one
    // place this module rebuilds rather than mutates — every key of it has a
    // field in the form — so the note beside it is the one thing that would be
    // lost, and it is the only documentation an entry has.
    let mut comments: Map<String, Value> = Map::new();
    if let Some(Value::Array(old)) = entry.get("models") {
        for item in old {
            if let Some(object) = item.as_object() {
                if let (Some(Value::String(id)), Some(comment)) =
                    (object.get("id"), object.get("$comment"))
                {
                    comments.insert(id.clone(), comment.clone());
                }
            }
        }
    }

    let mut seen = HashSet::new();
    let mut list = Vec::new();
    for model in models {
        let id = model.id.trim();
        if id.is_empty() {
            return Err(format!("a model on route \"{route}\" has no id"));
        }
        if !seen.insert(id.to_string()) {
            return Err(format!("route \"{route}\" lists the model \"{id}\" twice"));
        }
        if let Some(window) = model.context_window {
            if window <= 0 {
                return Err(format!(
                    "the context window for \"{id}\" has to be a whole number above zero, or empty"
                ));
            }
        }

        let mut object = Map::new();
        if let Some(comment) = comments.get(id) {
            object.insert("$comment".to_string(), comment.clone());
        }
        object.insert("id".to_string(), Value::String(id.to_string()));
        set_optional_text(&mut object, "label", &model.label);
        if let Some(window) = model.context_window {
            object.insert("context_window".to_string(), Value::from(window));
        }
        set_optional_text(&mut object, "summary", &model.summary);
        set_optional_text(&mut object, "note", &model.note);
        // Only the exception is written: `vision` defaults to false
        // (`catalog.flagField`), so `false` is what an absent key already means.
        if model.vision {
            object.insert("vision".to_string(), Value::Bool(true));
        }
        set_optional_text(&mut object, "reasoning_effort", &model.reasoning_effort);
        set_effort_levels(&mut object, "effort_levels", &model.effort_levels);
        list.push(Value::Object(object));
    }

    entry.insert("models".to_string(), Value::Array(list));
    Ok(())
}

fn apply_route(entry: &mut Map<String, Value>, route: &RoutePatch) -> Result<(), String> {
    let name = route.name.trim();
    let base_url = route.base_url.trim();
    if base_url.is_empty() {
        return Err(format!("route \"{name}\" needs a base_url"));
    }

    entry.insert("base_url".to_string(), Value::String(base_url.to_string()));
    // Written even when empty, matching the template (`"api_key": ""`): an empty
    // key is how the file says "this route is not usable yet", and it is the
    // line somebody comes back to paste into.
    entry.insert(
        "api_key".to_string(),
        Value::String(route.api_key.trim().to_string()),
    );
    set_optional_text(entry, "display_name", &route.display_name);
    set_optional_text(entry, "api_style", &route.api_style);
    // `verify` defaults to true, so the file only ever records the exception.
    if route.verify {
        entry.remove("verify");
    } else {
        entry.insert("verify".to_string(), Value::Bool(false));
    }
    set_pairs(entry, "headers", &route.headers);
    set_effort_levels(entry, "effort_levels", &route.effort_levels);
    apply_models(entry, &route.models, name)
}

fn apply_providers(
    object: &mut Map<String, Value>,
    routes: &[RoutePatch],
) -> Result<(), String> {
    let section = child_object(object, "providers")?;
    // Taken out and put back in the same slot, so the section keeps its place in
    // the file while its **entries** are laid out in the order the form shows —
    // which is the order that decides the default route.
    let mut kept = std::mem::take(section);

    let mut providers = Map::new();
    for route in routes {
        let name = route.name.trim();
        if name.is_empty() {
            return Err("a route needs a name".to_string());
        }
        if providers.contains_key(name) {
            return Err(format!("two routes are both named \"{name}\""));
        }
        // Moving the existing object rather than building a new one is what
        // keeps `$comment` and every key the form does not draw. A route that is
        // not in the file yet has nothing to keep, so it starts empty.
        let mut entry = match kept.remove(name) {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        apply_route(&mut entry, route)?;
        providers.insert(name.to_string(), Value::Object(entry));
    }

    *section = providers;
    Ok(())
}

fn apply_web(object: &mut Map<String, Value>, web: &WebPatch) -> Result<(), String> {
    // Propagated rather than swallowed: a `web` section that is not an object is
    // a file the Go reader refuses outright (`stringMap`), so failing here is
    // the same judgement — and a save that quietly skipped the section would
    // leave the panel showing edits that are not on disk.
    let section = child_object(object, "web")?;
    section.insert(
        "tavily_api_key".to_string(),
        Value::String(web.tavily_api_key.trim().to_string()),
    );
    set_optional_text(section, "tavily_base_url", &web.tavily_base_url);
    Ok(())
}

fn apply_mcp(object: &mut Map<String, Value>, servers: &[McpPatch]) -> Result<(), String> {
    let section = child_object(object, "servers")?;
    let mut kept = std::mem::take(section);

    let mut out = Map::new();
    for server in servers {
        let name = server.name.trim();
        if name.is_empty() {
            return Err("an MCP server needs a name".to_string());
        }
        if out.contains_key(name) {
            return Err(format!("two MCP servers are both named \"{name}\""));
        }
        let command = server.command.trim();
        let url = server.url.trim();
        // `parseMcpServers` refuses both-given and neither-given, and it is
        // right to: the two are different transports, and a file that names both
        // has no answer to "which one runs".
        if command.is_empty() == url.is_empty() {
            return Err(format!(
                "the MCP server \"{name}\" needs exactly one of a command (stdio) or a URL (remote)"
            ));
        }

        let mut entry = match kept.remove(name) {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        if command.is_empty() {
            entry.remove("command");
        } else {
            entry.insert("command".to_string(), Value::String(command.to_string()));
        }
        if url.is_empty() {
            entry.remove("url");
        } else {
            entry.insert("url".to_string(), Value::String(url.to_string()));
        }
        set_string_list(&mut entry, "args", &server.args);
        set_pairs(&mut entry, "env", &server.env);
        set_pairs(&mut entry, "headers", &server.headers);
        match server.timeout_seconds {
            Some(seconds) if seconds > 0.0 => {
                // Whole seconds are written as whole numbers: `30.0` in a file
                // somebody reads is noise, and Go takes either.
                let number = if seconds.fract() == 0.0 && seconds <= i64::MAX as f64 {
                    Value::from(seconds as i64)
                } else {
                    Value::from(seconds)
                };
                entry.insert("timeout_seconds".to_string(), number);
            }
            _ => {
                entry.remove("timeout_seconds");
            }
        }
        // `true` is written; `false` removes the key. The runtime reads absent and
        // false as the same fact, and a file where every server carries
        // "auto_load": false is noise in something people read by hand — the same
        // rule `timeout_seconds` follows one block up.
        if server.auto_load {
            entry.insert("auto_load".to_string(), Value::Bool(true));
        } else {
            entry.remove("auto_load");
        }
        out.insert(name.to_string(), Value::Object(entry));
    }

    *section = out;
    Ok(())
}

/// Replace the file with `object`, atomically.
///
/// Temp file in the same directory, then a rename: the rename is atomic within
/// one filesystem, so a reader sees either the old file or the new one. A
/// half-written configuration is data loss, because this file holds keys.
/// `--ericai` writes it the same way (`ericWriteBack`), and the two agreeing
/// matters more than either being clever.
fn write_object(path: &Path, object: &Map<String, Value>) -> Result<(), String> {
    // `Map` serialises in its own order, which `preserve_order` keeps, so the
    // section order in the file is the order it was read in.
    let mut text = serde_json::to_string_pretty(object)
        .map_err(|err| format!("the configuration could not be encoded: {err}"))?;
    // Trailing newline, like the template and like `ericWriteBack`: a file
    // without one shows up as "\ No newline at end of file" in every diff.
    text.push('\n');

    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(dir)
        .map_err(|err| format!("{} could not be created: {err}", dir.display()))?;

    // The name is unique to this process, for the reason `ericWriteBack` gives:
    // two writers sharing one temp name is a write into another process's
    // rename — one of them fails, or a half file lands.
    let stem = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| CONFIG_FILE_NAME.to_string());
    let tmp = dir.join(format!(".{stem}.{}.tmp", std::process::id()));

    fs::write(&tmp, text.as_bytes())
        .map_err(|err| format!("{} could not be written: {err}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // The file is about to hold keys. Windows has no notion of group or
        // other permissions, so this is POSIX-only by construction — the same
        // choice `config.tighten` makes.
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        format!("{} could not be replaced: {err}", path.display())
    })
}

/// Apply a patch and read the result back.
///
/// **The return value is a re-read, not the patch echoed.** What the panel draws
/// afterwards is therefore the file's own content — the same rule the settings
/// panel follows when it shows the argv the child was actually given rather than
/// what somebody typed.
pub fn write_document(patch: ConfigPatch) -> Result<ConfigDocument, String> {
    if patch.providers.is_some() || patch.web.is_some() {
        let path = config_path()?;
        // Re-read rather than trusting anything held in the front end: the merge
        // needs the file's own object, and this is the only copy of it.
        let mut object = match read_object(&path)? {
            Some(object) => {
                if let Some(problem) = structural_problem(&object) {
                    return Err(format!("{} was not written: {problem}", path.display()));
                }
                object
            }
            None => Map::new(),
        };
        if let Some(routes) = &patch.providers {
            apply_providers(&mut object, routes)?;
        }
        if let Some(web) = &patch.web {
            apply_web(&mut object, web)?;
        }
        write_object(&path, &object)?;
    }

    if let Some(servers) = &patch.mcp {
        let path = mcp_path()?;
        let mut object = match read_object(&path)? {
            Some(object) => {
                if let Some(problem) = mcp_structural_problem(&object) {
                    return Err(format!("{} was not written: {problem}", path.display()));
                }
                object
            }
            None => Map::new(),
        };
        apply_mcp(&mut object, servers)?;
        write_object(&path, &object)?;
    }

    read_document()
}
