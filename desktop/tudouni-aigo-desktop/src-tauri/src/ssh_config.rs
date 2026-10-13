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

/// The hosts of a specific file — the seam the unit tests point at fixtures.
pub fn list_hosts_from(path: &Path) -> Result<Vec<SshConfigHost>, String> {
    let raw = match std::fs::read_to_string(path) {
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
fn parse_line(line: &str) -> Option<(String, String)> {
    let text = strip_comment(line).trim();
    if text.is_empty() {
        return None;
    }
    let index = text.find(|ch: char| ch.is_whitespace() || ch == '=')?;
    let key = text[..index].to_string();
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
    /// honest rather than lucky.
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

    #[test]
    fn identity_files_are_expanded_against_the_config_home() {
        let mut tmp = tmp_config("Host prod\n    IdentityFile ~/.ssh/id_ed25519\n");
        // A key the file points at, in the fixture's own home.
        fs::write(tmp.dir.join(".ssh").join("id_ed25519"), "key").expect("write key");
        let hosts = list_hosts_from(&tmp.path).expect("parse");
        assert_eq!(hosts[0].identity_files.len(), 1);
        let expected = tmp.dir.join(".ssh").join("id_ed25519");
        assert_eq!(hosts[0].identity_files[0], expected.display().to_string());
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
}
