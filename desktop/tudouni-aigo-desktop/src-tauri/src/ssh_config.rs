//! Reading the user's own `~/.ssh/config` so the Add Remote Workspace form
//! can **prefill** its fields from what OpenSSH is already configured with.
//!
//! # Why this module exists
//!
//! The form used to ask a person to type down, one field at a time, exactly
//! what they have already written in `~/.ssh/config`. That is asking for the
//! same fact twice. So the form offers a picker of the hosts the file names,
//! and picking one fills in the host, the port, the user and the identity
//! files the file already declares — nothing connects, nothing is saved until
//! the person presses Save.
//!
//! # Why the parser mirrors the Go side instead of sharing it
//!
//! `internal/ssh/config.go` is the authority: it is what actually dials. This
//! module is a **second, deliberately weaker implementation**, and the only
//! reason it exists at all is that `src-tauri` cannot link `internal/` —
//! the Tauri crate is a separate build with no path to the Go source tree.
//! The cost of a second copy is drift, and it is held down by an explicit
//! choice: **the Go side's `rejectedFields` are applied here too.** A `Host`
//! block that names a `ProxyJump` is flagged `refused` rather than offered as
//! selectable, for exactly the reason `config.go` gives: a jump host changes
//! the route the connection takes, and a prefill that pretended the block was
//! ordinary would hand the form a destination this application cannot reach.
//! If the Go side can reach a host through its parser, this one can prefill
//! it; if it cannot, neither can this one.
//!
//! What this module deliberately does **not** do:
//!
//!   - dial anything — it reads one file and resolves the blocks in it;
//!   - evaluate `Match` conditions — like the Go side, a file that carries
//!     one is reported as unusable rather than offered as a partial list
//!     whose membership is unknowable;
//!   - follow `Include` — a file that pulls in settings from elsewhere is
//!     one this program cannot read completely, so the blocks it names are
//!     listed as-is and the picker's own caption says the file was read
//!     without its includes;
//!   - return a `Password` value — the block is flagged `has_password` so
//!     the form can say "the config sets a password", and the field is the
//!     form's own to fill. The value stays in the file.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Where OpenSSH keeps its client configuration.
pub fn default_config_path() -> PathBuf {
    home_dir().join(".ssh").join("config")
}

/// The user's home directory, asked of the operating system rather than
/// trusted from a single variable: a session started from a desktop icon can
/// be missing `USERPROFILE` on Windows while still having a home, and a
/// relative result would send the lookup to a `.ssh` beside the working
/// directory.
fn home_dir() -> PathBuf {
    for key in ["USERPROFILE", "HOME"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed);
            }
        }
    }
    // Windows without USERPROFILE: HOMEDRIVE + HOMEPATH is the documented
    // fallback pair.
    if let (Ok(drive), Ok(path)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
        let drive = drive.trim();
        let path = path.trim();
        if !drive.is_empty() {
            let path = if path.is_empty() || path.starts_with('\\') || path.starts_with('/') {
                path.to_string()
            } else {
                format!("/{}", path)
            };
            return PathBuf::from(format!("{}{}", drive, path));
        }
    }
    // Last resort, mirroring `homeDirFor` in `config.go`: the current
    // directory. It will usually have no `.ssh/config`, which answers as
    // "no file" rather than as an error.
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// The user this machine would connect as when the file says nothing.
///
/// The operating system is asked rather than one variable, for the same
/// reason as `home_dir`; Windows answers `DOMAIN\user`, and the domain half
/// is an Active Directory artifact that means nothing to a server on the
/// other end, so it is dropped — the same rule `localUsername` in
/// `config.go` applies.
fn local_username() -> String {
    for key in ["USER", "USERNAME", "LOGNAME"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                let name = match trimmed.find(['\\', '/']) {
                    Some(index) => &trimmed[index + 1..],
                    None => trimmed,
                };
                if !name.is_empty() {
                    return name.to_string();
                }
            }
        }
    }
    String::new()
}

/// The keys OpenSSH offers when a `Host` block names none, in OpenSSH's own
/// order — kept in step with `ssh.DefaultIdentityNames` in `config.go`.
const DEFAULT_IDENTITY_NAMES: &[&str] = &["id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"];

/// What `read_ssh_config` hands to the front end: the file's own location
/// plus every concrete `Host` block it names.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigDocument {
    /// The file this was read from, so the UI can name it in its caption.
    pub path: String,
    /// `false` when there was no file at all — an ordinary state ("no
    /// aliases"), not an error.
    pub exists: bool,
    /// The selectable hosts, in file order. Empty when there is no file,
    /// when the file names no concrete host, or when `problem` is set.
    pub hosts: Vec<SshConfigHost>,
    /// Why the file was read but its hosts cannot be trusted — a `Match`
    /// block, a file that will not parse. `None` in every other case.
    pub problem: Option<String>,
}

/// One host the file names, as the form draws it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    /// The pattern the `Host` block wrote, verbatim — what the person would
    /// type into a terminal. Wildcards and negations are not offered (see
    /// `list_hosts_from`).
    pub alias: String,
    /// The resolved destination, or the alias itself when no `HostName`
    /// applies. It is this value the form's Host field is filled with, not
    /// the alias: the alias is a label, the destination is where a dial goes.
    pub hostname: String,
    pub port: u16,
    /// The resolved user, or the local login when nothing names one. Empty
    /// only when neither could be determined.
    pub user: String,
    /// The identity files an explicit `IdentityFile` names, expanded — or,
    /// when none is named, the default keys that **exist** in the config's
    /// home, the way `ssh.Lookup` offers them.
    pub identity_files: Vec<String>,
    /// True when the block sets the custom `Password` directive. The value
    /// itself is not returned — see the module doc.
    pub has_password: bool,
    /// Why this block is shown rather than selectable: a `ProxyJump` or a
    /// similar field this program refuses to ignore. The Go side gives the
    /// same refusal when dialing, so offering the block would hand the form
    /// a destination that cannot be reached through this application.
    pub refused: Option<String>,
}

/// The `~/.ssh/config` as the Add Remote Workspace form's picker needs it.
///
/// A missing file is not an error and produces an empty list — a machine
/// with no aliases is an ordinary state, and the form then simply shows
/// nothing to pick while its manual fields work as before.
pub fn read_config() -> SshConfigDocument {
    let path = default_config_path();
    let exists = path.is_file();
    match list_hosts_from(&path) {
        Ok(hosts) => SshConfigDocument {
            path: path.display().to_string(),
            exists,
            hosts,
            problem: None,
        },
        Err(problem) => SshConfigDocument {
            path: path.display().to_string(),
            exists,
            hosts: Vec::new(),
            problem: Some(problem),
        },
    }
}

/// Adds one `Host` block to the user's own `~/.ssh/config`.
///
/// # Why this writes the user's file rather than a private one
///
/// This program reads `~/.ssh/config` and nothing else — there is no second
/// place a host can be configured (`internal/ssh`'s package doc says so, and
/// `ssh_backend` resolves aliases through the same file). So a host the person
/// adds through this wizard has to land **there** to be usable, and the
/// alternative — a private list only this application can see — would be a host
/// they cannot reach with `ssh` either, which is the opposite of the point.
///
/// # What it refuses to write
///
/// **No `Password` line.** `Password` is not an OpenSSH keyword: it is this
/// project's own extension, which the Go parser understands. Writing it into
/// `~/.ssh/config` would make the person's own `ssh` fail with
/// `Bad configuration option: password` on **every** connection, not just this
/// one — so a password can never be stored here, and the wizard keeps it in
/// `aigo.prefs` for hosts that need one. A block that would otherwise be
/// written with a password is written without it, and the caller is told.
///
/// # The append is checked, not blind
///
/// The file is someone's own configuration, often hand-edited and often
/// decades old. It is appended to rather than rewritten (nothing above the new
/// block is touched, and no key is re-serialised), a newline is inserted first
/// if the file does not end in one (otherwise the new `Host` line would be
/// joined to the last directive of the previous block and silently change it),
/// and re-adding an alias that already exists is refused rather than
/// duplicated — two blocks with one name is a file whose meaning depends on
/// OpenSSH's "first obtained wins" rule, which is not a thing to create by
/// accident.
pub fn append_host(alias: &str, host: &SshConfigHost) -> Result<String, String> {
    let name = alias.trim();
    if name.is_empty() {
        return Err("the host needs a name".to_string());
    }
    if name.contains(char::is_whitespace) || name.contains(['*', '?', '!', '#']) {
        return Err(
            "the name may not contain whitespace, or any of * ? ! # — a pattern like * would \
             apply the block to every host in the file"
                .to_string(),
        );
    }
    if host.hostname.trim().is_empty() {
        return Err("the host needs a HostName".to_string());
    }

    let path = default_config_path();
    let existing = std::fs::read_to_string(&path).unwrap_or_default();

    // Refuse a duplicate rather than appending a second block with one name.
    let parsed = parse(&existing);
    if let Some(reason) = parsed.match_refused {
        return Err(format!(
            "{}: {reason}, so adding a host here could not be done safely — edit the file by hand",
            path.display()
        ));
    }
    for block in &parsed.blocks {
        if block.patterns.iter().any(|pattern| pattern == name) {
            return Err(format!("{name} is already a Host block in {}", path.display()));
        }
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }

    // The block is built by `host_block_lines`, the same function the preview
    // command returns — so what the wizard shows the person and what lands in
    // their file cannot be two different things.
    let block: String = host_block_lines(name, host)
        .into_iter()
        .map(|line| format!("{line}\n"))
        .collect();

    let mut next = existing.clone();
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    if !next.is_empty() {
        next.push('\n');
    }
    next.push_str(&block);

    // Written through a temporary file and renamed, so an interrupted write
    // cannot leave somebody's own ssh configuration truncated. The permission
    // bits are set to 0600 for the same reason the file usually already is:
    // it names private keys.
    let temp = path.with_extension("aigo-tmp");
    std::fs::write(&temp, &next)
        .map_err(|e| format!("could not write {}: {e}", temp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&temp, &path)
        .map_err(|e| format!("could not put the new config in place at {}: {e}", path.display()))?;

    Ok(path.display().to_string())
}

/// The lines of one `Host` block, **without** trailing newlines.
///
/// The one definition of the block's format on this side: `append_host` writes
/// these lines, and the wizard's live preview (`buildHostBlock` in
/// `src/components/modals/remoteWorkspace.ts`) mirrors them so the block a
/// person is shown before saving is the block that is written.
///
/// That mirror is a deliberate duplication, on the same terms
/// `internal/bootstrap/commands.go` states for `quoteShellArgument`: a TS file
/// cannot call a Rust function, so the alternative is a round trip to Rust on
/// every keystroke in the preview. **This side is the authority** — the preview
/// is a display, and `append_host` below is what actually writes — and the
/// format is pinned on this side by its own unit test.
///
/// Four rules, each of which is a way their `ssh` configuration could be made
/// worse:
///
///   1. **No `Password` line, ever.** `Password` is this project's own
///      extension, not an OpenSSH keyword: writing it makes `ssh` refuse to
///      start at all — on every connection to every host in the file, not only
///      this one — with `Bad configuration option: password`.
///   2. **`Port` only when it is not 22.** The default is what OpenSSH already
///      assumes, and a line that restates a default is a line somebody has to
///      read in order to discover it says nothing.
///   3. **One `IdentityFile` per line.** OpenSSH accumulates them across lines;
///      several values on one line is not a form it reads the same way.
///   4. **Nothing for an empty field.** A blank `User` that emitted `User `
///      would be a block whose meaning depends on a parser's whitespace rules.
pub fn host_block_lines(name: &str, host: &SshConfigHost) -> Vec<String> {
    let mut lines = vec![
        format!("Host {}", name.trim()),
        format!("    HostName {}", host.hostname.trim()),
    ];
    if host.port != 22 {
        lines.push(format!("    Port {}", host.port));
    }
    let user = host.user.trim();
    if !user.is_empty() {
        lines.push(format!("    User {user}"));
    }
    for key in &host.identity_files {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            lines.push(format!("    IdentityFile {trimmed}"));
        }
    }
    lines
}

/// The hosts of a specific file — the seam the unit tests point at fixtures.
pub fn list_hosts_from(path: &Path) -> Result<Vec<SshConfigHost>, String> {    let raw = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };

    let config = parse(&raw);
    if let Some(reason) = config.match_refused {
        // The one case where the whole file is unusable: a `Match`'s
        // conditions are not evaluated, so which block a field lands in is
        // unknowable. Saying so rather than returning a partial list is the
        // same honesty rule the Go side applies to a single alias.
        return Err(format!(
            "{}: {reason}, which this program cannot evaluate — the blocks below a Match may or may not apply, and guessing would mean connecting as somebody else or to somewhere else",
            path.display()
        ));
    }

    let home = home_of_config(path);
    let mut hosts = Vec::new();
    for block in &config.blocks {
        // A concrete name only: `*` and `prod*` are not destinations a
        // person can dial, and a `!prod` pattern alone *excludes* rather
        // than names anything.
        if block.patterns.len() != 1 || block.patterns[0].contains(['*', '?', '!']) {
            continue;
        }
        hosts.push(resolve_block(&block.patterns[0], &config, &home));
    }
    Ok(hosts)
}

/// The `~` and `%token` substitutions OpenSSH applies, in a path.
///
/// `%h` is the name the person typed, not a name it resolved to — the same
/// rule `expandTokens` in `config.go` documents, and the one that makes
/// `IdentityFile ~/.ssh/%h_key` mean "a key named after the alias".
fn expand_tokens(value: &str, alias: &str, remote_user: &str, home: &str) -> String {
    let text = value.trim();
    let mut out: String = if text == "~" {
        home.to_string()
    } else if let Some(rest) = text.strip_prefix("~/") {
        Path::new(home).join(rest).display().to_string()
    } else {
        text.to_string()
    };
    out = out.replace("%h", alias);
    out = out.replace("%n", alias);
    out = out.replace("%r", remote_user);
    out = out.replace("%d", home);
    out = out.replace("%u", &local_username());
    // `%%` last, so a literal percent is not re-expanded.
    out = out.replace("%%", "%");
    out
}

/// Whose home directory this configuration belongs to.
///
/// Derived from the file's own location — `<home>/.ssh/config` — rather than
/// from the process environment, for exactly the reason `homeDirFor` in
/// `config.go` states it: a test that points the parser at a directory it
/// made must not have the real user's `~/.ssh/id_rsa` offered as a candidate.
fn home_of_config(path: &Path) -> String {
    if let Some(ssh_dir) = path.parent() {
        if ssh_dir.file_name().map(|name| name == ".ssh").unwrap_or(false) {
            if let Some(home) = ssh_dir.parent() {
                return home.display().to_string();
            }
        }
    }
    home_dir().display().to_string()
}

/// Resolves one `Host` block into everything the form would fill in.
///
/// Values are collected **per field, first obtained wins**, across the global
/// block and every matching `Host` block in order — not "the first matching
/// block wins". That is OpenSSH's rule and the `Host *` idiom depends on it:
/// a later, more specific block that re-sets a field the earlier one already
/// named does **not** take effect, and a prefill that behaved differently
/// would fill the form with something `ssh <alias>` would not dial.
fn resolve_block(alias: &str, config: &ParsedConfig, home: &str) -> SshConfigHost {
    let mut hostname = alias.to_string();
    let mut hostname_obtained = false;
    let mut port: u16 = 22;
    let mut port_obtained = false;
    let mut user = local_username();
    let mut user_obtained = false;
    let mut identity_files: Vec<String> = Vec::new();
    let mut identity_obtained = false;
    let mut has_password = false;
    let mut refused: Option<String> = None;

    for scope in scopes_for(alias, config) {
        for field in scope {
            match field.key.as_str() {
                key if REJECTED_FIELDS.contains(&key) => {
                    if refused.is_none() {
                        refused = Some(format!(
                            "line {}: {} is not supported by this program and cannot be ignored",
                            field.line,
                            field.key.to_uppercase()
                        ));
                    }
                    continue;
                }
                "hostname" if !hostname_obtained => {
                    let value = field.value.trim();
                    if value.is_empty() {
                        continue;
                    }
                    // `<name>` asks OpenSSH to resolve the name again, which
                    // this program does not do; the name inside is what the
                    // person meant, and it is what a dial would go to.
                    let unbracketed = value
                        .strip_prefix('<')
                        .and_then(|rest| rest.strip_suffix('>'))
                        .unwrap_or(value);
                    hostname = expand_tokens(unbracketed, alias, &user, home);
                    hostname_obtained = true;
                }
                "port" if !port_obtained => {
                    if let Ok(value) = field.value.trim().parse::<u16>() {
                        port = value;
                        port_obtained = true;
                    }
                }
                "user" if !user_obtained => {
                    if !field.value.trim().is_empty() {
                        user = expand_tokens(&field.value, alias, &user, home);
                        user_obtained = true;
                    }
                }
                "identityfile" if !identity_obtained => {
                    for candidate in field.value.split_whitespace() {
                        identity_files.push(expand_tokens(candidate, alias, &user, home));
                    }
                    identity_obtained = true;
                }
                "password" => has_password = true,
                _ => {}
            }
        }
    }

    // No explicit key: offer the usual files that exist, the way
    // `ssh.Lookup` does — a missing file would be an authentication failure
    // naming a file the person never mentioned.
    if identity_files.is_empty() {
        for name in DEFAULT_IDENTITY_NAMES {
            let candidate = Path::new(home).join(".ssh").join(name);
            if candidate.is_file() {
                identity_files.push(candidate.display().to_string());
            }
        }
    }

    SshConfigHost {
        alias: alias.to_string(),
        hostname,
        port,
        user,
        identity_files,
        has_password,
        refused,
    }
}

/// Every scope consulted for an alias, in OpenSSH's own order: the global
/// fields first, then each matching `Host` block in file order.
fn scopes_for<'a>(alias: &str, config: &'a ParsedConfig) -> Vec<&'a [Directive]> {
    let mut scopes = vec![config.global.as_slice()];
    for block in &config.blocks {
        if host_matches(&block.patterns, alias) {
            scopes.push(block.fields.as_slice());
        }
    }
    scopes
}

/// A refused field, wherever it appears in a scope that applies.
///
/// The mirror of `rejectedFields` in `config.go`, field for field: every one
/// of them changes **where the connection goes, who it authenticates as, or
/// how the peer is verified**, and a prefill that ignored it would hand the
/// form a destination this application cannot actually reach.
const REJECTED_FIELDS: &[&str] = &[
    "proxyjump",
    "proxycommand",
    "canonicalizehostname",
    "canonicaldomains",
    "stricthostkeychecking",
    "userknownhostsfile",
    "hostkeyalgorithms",
    "certificatefile",
    "identityagent",
    "pkcs11provider",
    "securitykeyprovider",
];

/// OpenSSH's pattern match: `*` and `?`, case-insensitive, with a leading
/// `!` negating. A negation that matches disqualifies the block outright —
/// the same rule `hostMatches` in `config.go` applies.
fn host_matches(patterns: &[String], name: &str) -> bool {
    let lowered = name.to_lowercase();
    let mut matched = false;
    for pattern in patterns {
        if let Some(negated) = pattern.strip_prefix('!') {
            if glob_fold(&negated.to_lowercase(), &lowered) {
                return false;
            }
            continue;
        }
        if glob_fold(&pattern.to_lowercase(), &lowered) {
            matched = true;
        }
    }
    matched
}

/// The `*`/`?` match, two-pointer with a remembered star.
fn glob_fold(pattern: &str, name: &str) -> bool {
    let pattern = pattern.as_bytes();
    let name = name.as_bytes();
    let mut p = 0usize;
    let mut n = 0usize;
    let mut star: Option<usize> = None;
    let mut mark = 0usize;

    while n < name.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == name[n]) {
            p += 1;
            n += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            mark = n;
            p += 1;
        } else if let Some(s) = star {
            p = s + 1;
            mark += 1;
            n = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

/// Splits a `Key value` line, accepting `Key value` and `Key=value`, leaving
/// a `#` inside quotes alone, and reporting `None` for blank and comment-only
/// lines — the same rules `parseLine` in `config.go` uses.
///
/// **The key is lower-cased here, and that is load-bearing rather than tidy.**
/// OpenSSH keywords are case-insensitive, so `Host`, `host` and `HOST` are one
/// directive and every real-world file uses the conventional capitalised
/// spelling. Every comparison downstream — `parse` looking for `"host"` and
/// `"match"`, `resolve_block` matching `"hostname"`/`"user"`/`"identityfile"`,
/// `REJECTED_FIELDS` — is written against the lower-case form, so returning the
/// key verbatim meant a file written the way OpenSSH documents it parsed as
/// **having no hosts at all**: the picker showed nothing, `Match` was never
/// noticed, and `ProxyJump` was never refused. Folded once, here, at the single
/// point every line passes through — which is why the rest of this file may
/// compare against literals.
///
/// The **value** is never folded: a `HostName`, a path and a user name are all
/// case-sensitive, and `user` in particular must survive exactly as written.
fn parse_line(line: &str) -> Option<(String, String)> {
    let text = strip_comment(line).trim();
    if text.is_empty() {
        return None;
    }
    let index = text.find(|ch: char| ch.is_whitespace() || ch == '=')?;
    let key = text[..index].to_lowercase();
    if key.is_empty() {
        return None;
    }
    let rest = text[index..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest).trim_start();
    Some((key, unquote(rest).to_string()))
}

fn strip_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut quote: u8 = 0;
    for (index, &char) in bytes.iter().enumerate() {
        if quote != 0 {
            if char == quote {
                quote = 0;
            }
            continue;
        }
        match char {
            b'\'' | b'"' => quote = char,
            b'#' => return &line[..index],
            _ => {}
        }
    }
    line
}

fn unquote(value: &str) -> &str {
    let trimmed = value.trim();
    if trimmed.len() >= 2 {
        let first = trimmed.as_bytes()[0];
        let last = trimmed.as_bytes()[trimmed.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return &trimmed[1..trimmed.len() - 1];
        }
    }
    trimmed
}

/// A parsed `~/.ssh/config`: the global fields, the `Host` blocks, and
/// whether a `Match` makes the whole file untrustworthy.
struct ParsedConfig {
    global: Vec<Directive>,
    blocks: Vec<Block>,
    /// `Some` when the file carries a `Match` and therefore nothing here can
    /// be trusted to apply the way the person thinks it does.
    match_refused: Option<String>,
}

struct Block {
    patterns: Vec<String>,
    fields: Vec<Directive>,
}

struct Directive {
    key: String,
    value: String,
    line: usize,
}

/// Flattens the file into a global field list and `Host` blocks.
///
/// `Include` lines are read past rather than followed, and a `Match` marks
/// the whole file unusable: both are the same honesty rule. A file that
/// pulls in settings from elsewhere, or from conditions this program does
/// not evaluate, is one this program cannot read completely — and a prefill
/// that showed half of a block would be worse than no prefill at all.
fn parse(raw: &str) -> ParsedConfig {
    let mut global: Vec<Directive> = Vec::new();
    let mut blocks: Vec<Block> = Vec::new();
    // Fields under a `Match` land here and nowhere else: they must not leak
    // into the `Host` block that preceded the Match line. The whole parse is
    // refused when a Match exists, but the split is what makes that refusal
    // honest rather than lucky.
    let mut match_sink: Vec<Directive> = Vec::new();
    let mut current: &mut Vec<Directive> = &mut global;
    let mut match_refused: Option<String> = None;

    for (number, line) in raw.lines().enumerate() {
        let Some((key, value)) = parse_line(line) else {
            continue;
        };
        let line_no = number + 1;
        if key == "host" {
            let patterns: Vec<String> = value.split_whitespace().map(str::to_string).collect();
            blocks.push(Block { patterns, fields: Vec::new() });
            current = &mut blocks.last_mut().unwrap().fields;
        } else if key == "match" {
            if match_refused.is_none() {
                match_refused = Some(format!("line {line_no} uses a Match block"));
            }
            current = &mut match_sink;
        } else if key != "include" {
            current.push(Directive { key, value, line: line_no });
        }
    }

    ParsedConfig { global, blocks, match_refused }
}

/* ============================================================
   Unit tests
   ============================================================ */

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A throwaway directory under the OS temp area.
    ///
    /// Not a new dependency (no `tempfile` in the lockfile, and a fresh
    /// download for one test is a proxy question nobody asked for). `std::test`
    /// runs every test in this file in one process, so the name needs a
    /// counter, not just a timestamp: two fixtures made in the same
    /// nanosecond would share a directory and trample each other's config.
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("tudouni-sshcfg-test-{stamp}-{n}-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// Writes `text` to `<temp>/.ssh/config` and returns the directory and
    /// the path; the directory is the handle the caller removes afterwards.
    ///
    /// The `.ssh` directory in the name is load-bearing: `home_of_config`
    /// derives the home from the file's grandparent, so a test fixture must
    /// live where a real one does, or the default-key lookups would search
    /// the wrong directory.
    fn fixture(text: &str) -> (PathBuf, PathBuf) {
        let dir = temp_dir();
        let ssh = dir.join(".ssh");
        fs::create_dir_all(&ssh).expect("mkdir .ssh");
        let path = ssh.join("config");
        fs::write(&path, text).expect("write config");
        (dir, path)
    }

    /// Removes its directory on drop — including on a test panic, so an
    /// assertion failure does not leave a fixture under the OS temp area.
    struct DirGuard(PathBuf);

    impl Drop for DirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// One fixture, with the cleanup owned for the life of the test.
    struct Tmp {
        _guard: DirGuard,
        dir: PathBuf,
        path: PathBuf,
    }

    /// A fixture with no config file written — the "no aliases" state.
    fn tmp_empty() -> Tmp {
        let dir = temp_dir();
        let path = dir.join(".ssh").join("config");
        Tmp {
            _guard: DirGuard(dir.clone()),
            dir,
            path,
        }
    }

    /// A fixture with `text` written as the config.
    fn tmp_config(text: &str) -> Tmp {
        let dir = temp_dir();
        let ssh = dir.join(".ssh");
        fs::create_dir_all(&ssh).expect("mkdir .ssh");
        let path = ssh.join("config");
        fs::write(&path, text).expect("write config");
        Tmp {
            _guard: DirGuard(dir.clone()),
            dir,
            path,
        }
    }

    #[test]
    fn a_missing_file_is_an_empty_list_not_an_error() {
        let tmp = tmp_empty();
        let hosts = list_hosts_from(&tmp.path).expect("no file is not an error");
        assert!(hosts.is_empty());
    }

    /// OpenSSH keywords are case-insensitive, and every real `~/.ssh/config` uses
    /// the conventional capitalised spelling. Every comparison in this module is
    /// written against the lower-case form, so a parser that returned the key
    /// verbatim read a perfectly ordinary file as **having no hosts at all** —
    /// the picker was empty, `Match` was never noticed, and `ProxyJump` was
    /// never refused. Nothing threw; the list was just silently blank.
    ///
    /// This asserts the three spellings of one directive resolve identically, so
    /// the case-folding cannot regress without a failure naming it.
    #[test]
    fn ssh_keywords_are_case_insensitive() {
        let tmp = tmp_config(
            "HOST prod\n    HOSTNAME 10.0.1.5\n    USER deploy\n    PORT 2222\n",
        );
        let hosts = list_hosts_from(&tmp.path).expect("parse");
        assert_eq!(hosts.len(), 1, "an upper-case Host block is still a Host block");
        assert_eq!(hosts[0].alias, "prod");
        assert_eq!(hosts[0].hostname, "10.0.1.5");
        assert_eq!(hosts[0].user, "deploy");
        assert_eq!(hosts[0].port, 2222);

        // Mixed case, which is what a hand-edited file often holds.
        let mixed = tmp_config("hOsT other\n    HostName 10.0.2.6\n");
        let hosts = list_hosts_from(&mixed.path).expect("parse");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].hostname, "10.0.2.6");
    }

    /// The refusal rules are keyed on the same lower-case form, so they have to
    /// survive the same spelling. `ProxyJump` written the way OpenSSH documents
    /// it must still make a block unselectable — otherwise the prefill would
    /// offer a destination this program cannot reach.
    #[test]
    fn an_uppercase_rejected_field_is_still_refused() {
        let tmp = tmp_config("Host jump\n    HostName 10.0.0.1\n    ProxyJump bastion\n");
        let hosts = list_hosts_from(&tmp.path).expect("parse");
        assert!(
            hosts[0].refused.is_some(),
            "a capitalised ProxyJump is the same directive and must still be refused"
        );
    }

    /// And `Match`, whose refusal is about the whole file rather than one block.
    #[test]
    fn an_uppercase_match_still_refuses_the_file() {
        let tmp = tmp_config("Host prod\n    HostName 10.0.1.5\nMatch host internal\n    User x\n");
        assert!(
            list_hosts_from(&tmp.path).is_err(),
            "a capitalised Match is the same directive and must still refuse the file"
        );
    }

    /// The value is **not** folded: a hostname, a path and a user name are all
    /// case-sensitive, and a `User` that came back lower-cased would be a
    /// different account on the far end.
    #[test]
    fn a_value_keeps_its_case() {
        let tmp = tmp_config("Host prod\n    HostName Example.COM\n    User DeployUser\n");
        let hosts = list_hosts_from(&tmp.path).expect("parse");
        assert_eq!(hosts[0].hostname, "Example.COM");
        assert_eq!(hosts[0].user, "DeployUser");
    }

    #[test]
    fn one_concrete_host_resolves_its_own_fields() {
        let tmp = tmp_config("Host prod\n    HostName 10.0.1.5\n    Port 2222\n    User deploy\n");
        let hosts = list_hosts_from(&tmp.path).expect("parse");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "prod");
        assert_eq!(hosts[0].hostname, "10.0.1.5");
        assert_eq!(hosts[0].port, 2222);
        assert_eq!(hosts[0].user, "deploy");
        assert!(hosts[0].refused.is_none());
    }

    #[test]
    fn the_global_block_applies_to_every_host() {
        let tmp = tmp_config(
            "User admin\nHost a\n    HostName a.example.com\nHost b\n    HostName b.example.com\n",
        );
        let hosts = list_hosts_from(&tmp.path).expect("parse");
        assert_eq!(hosts.len(), 2);
        for host in &hosts {
            assert_eq!(host.user, "admin", "global fields apply to every host");
        }
    }

    #[test]
    fn first_obtained_wins_across_blocks() {
        let tmp = tmp_config(
            "Host *\n    Port 2200\nHost prod\n    HostName 10.0.1.5\n    Port 22\n",
        );
        let hosts = list_hosts_from(&tmp.path).expect("parse");
        assert_eq!(hosts.len(), 1, "the wildcard block is not itself a host");
        assert_eq!(hosts[0].hostname, "10.0.1.5");
        // The wildcard block's port is obtained first, so it wins — the same
        // per-field rule the Go side documents as "the Host * idiom".
        assert_eq!(hosts[0].port, 2200);
    }

    #[test]
    fn a_negated_pattern_disqualifies_the_block() {
        let tmp = tmp_config(
            "Host !prod\n    User nobody\nHost prod\n    HostName 10.0.1.5\n",
        );
        let hosts = list_hosts_from(&tmp.path).expect("parse");
        assert_eq!(hosts.len(), 1);
        // `nobody` must not leak into `prod`: the negation disqualifies its
        // block, and `prod`'s own block names no user.
        assert_ne!(hosts[0].user, "nobody");
    }

    #[test]
    fn wildcard_patterns_are_scopes_not_hosts() {
        let tmp = tmp_config(
            "Host *\n    User admin\nHost prod*\n    Port 2222\nHost prod-app\nHost real\n",
        );
        let hosts = list_hosts_from(&tmp.path).expect("parse");
        // Only the two concrete patterns are offered; the wildcard and the
        // open-ended pattern are scopes, not destinations.
        let aliases: Vec<&str> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(aliases, vec!["prod-app", "real"]);
        // prod* matched prod-app and gave it the port; real did not.
        assert_eq!(hosts[0].port, 2222);
        assert_eq!(hosts[1].port, 22);
        // The wildcard's user reached both.
        assert_eq!(hosts[0].user, "admin");
        assert_eq!(hosts[1].user, "admin");
    }

    #[test]
    fn a_rejected_field_makes_the_block_unselectable() {
        let tmp = tmp_config(
            "Host jump\n    HostName 10.0.0.1\n    User root\n    ProxyJump bastion\n",
        );
        let hosts = list_hosts_from(&tmp.path).expect("parse");
        assert_eq!(hosts.len(), 1);
        let reason = hosts[0].refused.as_deref().expect("a ProxyJump block must be refused");
        assert!(
            reason.to_lowercase().contains("proxyjump"),
            "the reason names the field: {reason}"
        );
    }

    #[test]
    fn a_match_block_refuses_the_whole_file() {
        let tmp = tmp_config(
            "Host prod\n    HostName 10.0.1.5\nMatch host internal\n    User internal\n",
        );
        let result = list_hosts_from(&tmp.path);
        assert!(result.is_err(), "a file with a Match cannot be half-trusted");
        assert!(result.unwrap_err().to_lowercase().contains("match"));
    }

    #[test]
    fn fields_under_a_match_do_not_leak_into_the_preceding_block() {
        // The refusal above makes the parse unusable, but the split must hold
        // on its own: if the leak ever regressed, the test that asserts on a
        // Match-free file would not catch it, so this one names it directly
        // by checking the parse structure through the refused message's line.
        let tmp = tmp_config(
            "Host prod\n    User prod-user\nMatch host internal\n    User internal\n",
        );
        let err = list_hosts_from(&tmp.path).unwrap_err();
        // The refusal names the Match's line (the third), not a field under
        // it — evidence the field was not attributed to the block above.
        assert!(err.contains("line 3"), "{err}");
    }

    #[test]
    fn include_is_read_past_not_followed() {
        let tmp = tmp_config(
            "Include ~/.ssh/conf.d/*\nHost prod\n    HostName 10.0.1.5\n",
        );
        // The file is read, and the included content is not. The Include line
        // must not crash the parse, duplicate a host, or count as a field.
        let hosts = list_hosts_from(&tmp.path).expect("an Include line must not break the parse");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "prod");
        assert_eq!(hosts[0].hostname, "10.0.1.5");
    }

    #[test]
    fn the_password_directive_is_reported_not_returned() {
        let tmp = tmp_config("Host vault\n    HostName 10.0.2.9\n    Password s3cret\n");
        let hosts = list_hosts_from(&tmp.path).expect("parse");
        assert!(hosts[0].has_password);
        // The value itself must not leave the parser.
        let serialized = format!("{:?}", hosts);
        assert!(
            !serialized.contains("s3cret"),
            "the password value must not be returned: {serialized}"
        );
    }

    #[test]
    fn comments_and_quotes_are_handled_like_openssh() {
        let tmp = tmp_config(
            "# a comment\nHost prod\n    User \"ops team\" # trailing comment\n    HostName = 10.0.1.5\n",
        );
        let hosts = list_hosts_from(&tmp.path).expect("parse");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].user, "ops team");
        assert_eq!(hosts[0].hostname, "10.0.1.5", "Key=value is accepted, like the Go parser");
    }

    /// The `~` in an `IdentityFile` expands against the config's own home
    /// directory — and the assertion is about **which file is named**, not about
    /// the exact bytes of the string.
    ///
    /// It used to compare `display()` output for equality, which is wrong in a
    /// way that made this test fail on Windows while the behaviour was fine:
    /// `Path::new(home).join(".ssh/id_ed25519")` keeps the forward slash the
    /// config file wrote, so the result is `home\.ssh/id_ed25519` while the
    /// fixture's own path displays with a backslash. Windows accepts either
    /// separator in every file API, so both name the same key — and comparing
    /// strings asserted the separator rather than the file.
    #[test]
    fn identity_files_are_expanded_against_the_config_home() {
        let tmp = tmp_config("Host prod\n    IdentityFile ~/.ssh/id_ed25519\n");
        // A key the file points at, in the fixture's own home.
        fs::write(tmp.dir.join(".ssh").join("id_ed25519"), "key").expect("write key");
        let hosts = list_hosts_from(&tmp.path).expect("parse");
        assert_eq!(hosts[0].identity_files.len(), 1);

        let named = Path::new(&hosts[0].identity_files[0]);
        let expected = tmp.dir.join(".ssh").join("id_ed25519");
        // The real claim: the expansion names the key that is actually there, in
        // the config's own home rather than in this process's.
        assert!(
            named.is_file(),
            "the expanded IdentityFile must be a file that exists: {}",
            named.display()
        );
        assert_eq!(
            named.file_name(),
            expected.file_name(),
            "the expansion names a different file"
        );
        assert_eq!(
            fs::canonicalize(named).ok(),
            fs::canonicalize(&expected).ok(),
            "the expansion names a file outside the config's home: {} vs {}",
            named.display(),
            expected.display()
        );
    }

    #[test]
    fn without_an_explicit_key_the_existing_defaults_are_offered() {
        let mut tmp = tmp_config("Host prod\n    HostName 10.0.1.5\n");
        fs::write(tmp.dir.join(".ssh").join("id_ed25519"), "key").expect("write key");
        fs::write(tmp.dir.join(".ssh").join("id_rsa"), "key").expect("write key");
        // id_ecdsa is deliberately not created: a missing default key must
        // not be offered, or the form would name a file that does not exist.
        let hosts = list_hosts_from(&tmp.path).expect("parse");
        let expected = tmp.dir.join(".ssh");
        assert_eq!(
            hosts[0].identity_files,
            vec![
                expected.join("id_ed25519").display().to_string(),
                expected.join("id_rsa").display().to_string(),
            ],
        );
    }

    #[test]
    fn the_local_login_is_the_fallback_user() {
        // No `User` anywhere: the user resolves to whatever this machine's
        // login is — the same fallback the Go side takes.
        let tmp = tmp_config("Host bare\n    HostName 10.0.9.9\n");
        let hosts = list_hosts_from(&tmp.path).expect("parse");
        let expected = local_username();
        assert_eq!(hosts[0].user, expected);
        assert!(!expected.is_empty(), "the test host has a login name");
    }

    /* ============================================================
       The block written into the user's own ~/.ssh/config
       ============================================================ */

    fn sample_host() -> SshConfigHost {
        SshConfigHost {
            alias: "bg-prod".to_string(),
            hostname: "10.0.1.5".to_string(),
            port: 2222,
            user: "deploy".to_string(),
            identity_files: vec!["/home/me/.ssh/id_ed25519".to_string()],
            has_password: false,
            refused: None,
        }
    }

    /// The rule this whole path exists for: `Password` is this project's own
    /// extension, not an OpenSSH keyword. A block carrying one makes the
    /// person's own `ssh` refuse to start **for the entire file** — every host,
    /// not merely this one — with `Bad configuration option: password`.
    ///
    /// Asserted on the written text rather than on the struct, because the
    /// struct is not what lands in their file.
    #[test]
    fn the_written_block_never_carries_a_password() {
        let host = sample_host();
        let text = host_block_lines("bg-prod", &host).join("\n");
        assert!(
            !text.to_lowercase().contains("password"),
            "a Password directive reached the user's ssh config: {text}"
        );
    }

    #[test]
    fn the_block_is_the_expected_directives_in_order() {
        let host = sample_host();
        assert_eq!(
            host_block_lines("bg-prod", &host),
            vec![
                "Host bg-prod",
                "    HostName 10.0.1.5",
                "    Port 2222",
                "    User deploy",
                "    IdentityFile /home/me/.ssh/id_ed25519",
            ]
        );
    }

    #[test]
    fn the_default_port_is_not_restated() {
        let host = SshConfigHost { port: 22, ..sample_host() };
        let lines = host_block_lines("p", &host);
        assert!(
            !lines.iter().any(|line| line.trim_start().starts_with("Port")),
            "a line restating OpenSSH's own default is a line nobody needed: {lines:?}"
        );
    }

    #[test]
    fn each_identity_file_gets_its_own_line() {
        let host = SshConfigHost {
            identity_files: vec![
                "/k/one".to_string(),
                "/k/two".to_string(),
                // A blank entry, and one that is only whitespace, must both be
                // dropped rather than emitted as a dangling `IdentityFile`.
                String::new(),
                "   ".to_string(),
            ],
            ..sample_host()
        };
        let lines = host_block_lines("p", &host);
        let keys: Vec<&String> = lines
            .iter()
            .filter(|line| line.trim_start().starts_with("IdentityFile"))
            .collect();
        assert_eq!(keys.len(), 2, "one line per key, blanks dropped: {keys:?}");
    }

    #[test]
    fn an_empty_user_emits_no_user_line() {
        let host = SshConfigHost { user: "   ".to_string(), ..sample_host() };
        let lines = host_block_lines("p", &host);
        assert!(
            !lines.iter().any(|line| line.trim_start().starts_with("User")),
            "a blank User would be a directive whose meaning depends on whitespace: {lines:?}"
        );
    }

    /// The block this module writes must be one this module can read back — the
    /// two halves of the same file format, asserted together so a change to one
    /// that breaks the other cannot pass.
    #[test]
    fn a_written_block_round_trips_through_the_parser() {
        let host = sample_host();
        let text: String = host_block_lines("bg-prod", &host)
            .into_iter()
            .map(|line| format!("{line}\n"))
            .collect();

        let tmp = tmp_config(&text);
        let parsed = list_hosts_from(&tmp.path).expect("the block we write must parse");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].alias, "bg-prod");
        assert_eq!(parsed[0].hostname, "10.0.1.5");
        assert_eq!(parsed[0].port, 2222);
        assert_eq!(parsed[0].user, "deploy");
        assert_eq!(parsed[0].identity_files, vec!["/home/me/.ssh/id_ed25519"]);
        assert!(!parsed[0].has_password, "we never write one, so it must not read one");
    }
}
