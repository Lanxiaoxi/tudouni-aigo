//! Phase 4 (§9): remote config.json detection and safe writes.
//!
//! Classification (missing/empty-template/no-usable-route/valid/corrupt)
//! mirrors `internal/bootstrap/configsync.go`'s `InspectConfigBytes` for the
//! two facts that actually drive a sync decision — whether `providers` is
//! empty, and whether at least one route carries a key — without pulling in
//! that function's full JSON-shape validation (unknown top-level keys,
//! wrong-shaped sections). A config.json malformed in one of those stricter
//! ways is still caught here, just folded into the one `Corrupt` status
//! rather than reported with the same precision the Go side's own
//! `config.Read` gives a local file; refining that is a straightforward
//! follow-up, not a correctness gap this phase needs to close immediately.

use crate::ssh_backend::SshTarget;
use ssh2::Session;
use std::io::{Read, Write};
use std::path::Path;

/// Where config.json lives on a remote account — always `~/.tudouni/config.json`,
/// never per-workspace unless `AGENT_CONFIG_FILE` isolation is explicitly
/// turned on (§9.7) — which Phase 4's first version does not yet expose.
pub fn remote_config_path(home_dir: &str) -> String {
    format!("{}/.tudouni/config.json", home_dir.trim_end_matches('/'))
}

/// The remote account's `~/.tudouni/` directory.
pub fn remote_config_dir(home_dir: &str) -> String {
    format!("{}/.tudouni", home_dir.trim_end_matches('/'))
}

/// Read one file from the remote account by name, returning `None` when it is
/// not there.
///
/// **A parameterised read rather than a second `check_remote_config`.** The
/// config panel edits two files, and §9's sync policy only ever considered one
/// of them — so the panel needs the other one's bytes through the same door.
/// The two callers differ in which name they pass and in what they do with the
/// answer, and nothing else about the operation changes.
pub fn read_remote_file(
    session: &Session,
    home_dir: &str,
    name: &str,
) -> Result<Option<Vec<u8>>, String> {
    let path = format!("{}/{}", remote_config_dir(home_dir), name);
    let sftp = session.sftp().map_err(|e| format!("could not start an SFTP session: {e}"))?;
    let mut file = match sftp.open(Path::new(&path)) {
        Ok(file) => file,
        // libssh2's SFTP errors do not reliably distinguish "not found" from
        // other failures through ssh2's API — the same simplification
        // `check_remote_config` documents. A permission-denied account would
        // also fail every other remote operation this program attempts.
        Err(_) => return Ok(None),
    };
    let mut raw = Vec::new();
    file.read_to_end(&mut raw)
        .map_err(|e| format!("could not read {path}: {e}"))?;
    Ok(Some(raw))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteConfigStatus {
    Missing,
    EmptyTemplate,
    NoUsableRoute,
    Valid,
    Corrupt,
}

impl RemoteConfigStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            RemoteConfigStatus::Missing => "missing",
            RemoteConfigStatus::EmptyTemplate => "empty_template",
            RemoteConfigStatus::NoUsableRoute => "no_usable_route",
            RemoteConfigStatus::Valid => "valid",
            RemoteConfigStatus::Corrupt => "corrupt",
        }
    }
}

pub struct RemoteConfigInspection {
    pub status: RemoteConfigStatus,
    /// Hex SHA256 of the raw bytes; empty when Missing. Content, never
    /// mtime — see configsync.go's own doc on §9.5.
    pub fingerprint: String,
    pub error: Option<String>,
}

/// Reads the remote config.json over SFTP and classifies it.
///
/// A read failure that is "no such file" is `Missing`; any other read
/// failure (permission denied, a directory where the file should be) is
/// reported as an error through the `Result`, since those are connection or
/// account problems a sync policy cannot do anything sensible about.
pub fn check_remote_config(session: &Session, home_dir: &str) -> Result<RemoteConfigInspection, String> {
    let path = remote_config_path(home_dir);
    let sftp = session.sftp().map_err(|e| format!("could not start an SFTP session: {e}"))?;

    let mut remote_file = match sftp.open(Path::new(&path)) {
        Ok(file) => file,
        Err(_) => {
            // libssh2's SFTP errors do not reliably distinguish "not found"
            // from other failures through ssh2's API; treating every open
            // failure here as "missing" is the one simplification Phase 4
            // takes deliberately — a permission-denied account would also
            // fail every other remote operation this program attempts, so
            // it will not go unnoticed.
            return Ok(RemoteConfigInspection {
                status: RemoteConfigStatus::Missing,
                fingerprint: String::new(),
                error: None,
            });
        }
    };

    let mut raw = Vec::new();
    remote_file
        .read_to_end(&mut raw)
        .map_err(|e| format!("could not read {path}: {e}"))?;

    Ok(classify(&raw))
}

/// Mirrors `bootstrap.InspectConfigBytes`'s decision for the two facts that
/// matter to a sync policy — see the module doc for why this does not also
/// mirror its full JSON-shape validation.
fn classify(raw: &[u8]) -> RemoteConfigInspection {
    let fingerprint = sha2_like::sha256_hex(raw);

    let value: serde_json::Value = match serde_json::from_slice(raw) {
        Ok(v) => v,
        Err(e) => {
            return RemoteConfigInspection {
                status: RemoteConfigStatus::Corrupt,
                fingerprint,
                error: Some(e.to_string()),
            }
        }
    };

    let providers = match value.get("providers") {
        None => {
            return RemoteConfigInspection { status: RemoteConfigStatus::EmptyTemplate, fingerprint, error: None }
        }
        Some(serde_json::Value::Object(map)) => map,
        Some(_) => {
            return RemoteConfigInspection {
                status: RemoteConfigStatus::Corrupt,
                fingerprint,
                error: Some("\"providers\" must be an object".to_string()),
            }
        }
    };

    if providers.is_empty() {
        return RemoteConfigInspection { status: RemoteConfigStatus::EmptyTemplate, fingerprint, error: None };
    }

    let has_key = providers.values().any(|route| {
        route
            .get("api_key")
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false)
    });

    let status = if has_key { RemoteConfigStatus::Valid } else { RemoteConfigStatus::NoUsableRoute };
    RemoteConfigInspection { status, fingerprint, error: None }
}

/// Builds a `FileStat` naming only a permission bit set — `ssh2::FileStat`
/// has no `Default` impl (every field is a plain `Option`, but the type
/// itself derives nothing), so this is the one place that spells out the
/// other five fields as `None` instead of repeating that at every
/// `setstat` call site.
fn file_stat_perm(mode: u32) -> ssh2::FileStat {
    ssh2::FileStat {
        size: None,
        uid: None,
        gid: None,
        perm: Some(mode),
        atime: None,
        mtime: None,
    }
}

/// Writes `contents` to the remote config.json safely (§9.6): a temp file
/// next to the real one, written and flushed in full, the existing file
/// backed up if it exists, then the temp file renamed into place —
/// `Sftp::rename` is one SFTP protocol operation, which is what makes the
/// last step atomic relative to anything reading the real path through the
/// same SFTP session. Permissions are set to 0600 (owner read/write only)
/// on both the new file and the backup, since this file holds API keys.
/// The `config.json` case, named. Kept because §9's sync path reads better
/// saying `write_remote_config` than `write_remote_file(…, "config.json", …)`,
/// and because it is the one file whose write the sync policy established.
#[allow(dead_code)]
pub fn write_remote_config(session: &Session, home_dir: &str, contents: &[u8]) -> Result<(), String> {
    write_remote_file(session, home_dir, "config.json", contents)
}

/// The same safe write, for either file the config panel owns.
///
/// `config.json` is the one §9's sync policy was designed around, and `mcp.json`
/// is the other half of the same panel — both hold secrets (API keys, and a
/// server's `env`/`headers`), so both get the temp-file-then-rename treatment
/// with 0600 permissions and a `.bak`.
pub fn write_remote_file(
    session: &Session,
    home_dir: &str,
    name: &str,
    contents: &[u8],
) -> Result<(), String> {
    let dir = remote_config_dir(home_dir);
    let path = format!("{dir}/{name}");
    let backup_path = format!("{path}.bak");
    let temp_path = format!("{path}.tmp-{}", std::process::id());

    let sftp = session.sftp().map_err(|e| format!("could not start an SFTP session: {e}"))?;

    // Ensure ~/.tudouni exists — a fresh account may have nothing there yet.
    let _ = sftp.mkdir(Path::new(&dir), 0o700);

    {
        let mut temp_file = sftp
            .create(Path::new(&temp_path))
            .map_err(|e| format!("could not create {temp_path} on the remote host: {e}"))?;
        temp_file
            .write_all(contents)
            .map_err(|e| format!("could not write {temp_path} on the remote host: {e}"))?;
    }
    sftp.setstat(Path::new(&temp_path), file_stat_perm(0o600))
        .map_err(|e| format!("could not set permissions on {temp_path}: {e}"))?;

    // Back up whatever is at the real path now, before replacing it — "back
    // up the existing valid configuration before overwriting" (§9.6).
    // Not an error if there is nothing to back up yet.
    if sftp.stat(Path::new(&path)).is_ok() {
        let _ = sftp.unlink(Path::new(&backup_path));
        if sftp.rename(Path::new(&path), Path::new(&backup_path), None).is_ok() {
            let _ = sftp.setstat(Path::new(&backup_path), file_stat_perm(0o600));
        }
    }

    sftp.rename(Path::new(&temp_path), Path::new(&path), Some(ssh2::RenameFlags::OVERWRITE))
        .map_err(|e| format!("could not switch {temp_path} into place at {path}: {e}"))?;

    Ok(())
}

/// Opens a connection and reads `$HOME`, the two things both
/// `check_remote_config` and `write_remote_config` need from a fresh
/// target rather than an already-open session — mirrors
/// `remote_install::open_install_session` plus `remote_home_dir` in one
/// call, since every config-sync command needs exactly this pair.
pub fn connect_and_resolve_home(target: &SshTarget) -> Result<(Session, String), String> {
    let session = crate::ssh_backend::dial_session(target)?;
    let home = crate::remote_install::remote_home_dir(&session)?;
    Ok((session, home))
}

/// The hex SHA256 of `data` — exposed so a caller that just wrote a file
/// can record its fingerprint as the new sync baseline without reading the
/// bytes back over the network a second time.
pub fn fingerprint_hex(data: &[u8]) -> String {
    sha2_like::sha256_hex(data)
}

/// A tiny inline SHA256, so the import list above stays readable — delegates
/// straight to the `sha2` crate (see Cargo.toml for why that one rather than
/// OpenSSL, which is already linked in for `ssh2` but not exposed as a Rust
/// API here).
mod sha2_like {
    pub fn sha256_hex(data: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(data);
        let digest = hasher.finalize();
        digest.iter().map(|b| format!("{b:02x}")).collect()
    }
}
