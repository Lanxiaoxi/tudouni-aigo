//! The remote-workspace commands: install or upgrade the runtime over SFTP,
//! check and write the far host's `config.json`, probe a host before the form
//! asks anything, browse directories, and read or append the user's own
//! `~/.ssh/config`.
//!
//! Each of these is a thin door — the rules live in `remote_install`,
//! `remote_config`, `remote_probe`, and `ssh_config` respectively.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::launch_remote::resolve_remote_package;
use crate::remote_config;
use crate::remote_install;
use crate::remote_probe;
use crate::ssh_backend;
use crate::ssh_config;

/// Options for `install_remote_runtime`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRemoteOptions {
    host: String,
    port: u16,
    user: String,
    #[serde(default)]
    identity_files: Vec<String>,
    password: Option<String>,
    connect_timeout_ms: Option<u64>,
    /// The version string this install should be recorded under
    /// (`~/.tudouni/runtime/<version>/`) — the desktop app's own build
    /// version, read from `app.package_info()` by the caller in the
    /// WebView, not resolved here: this module has no reason to know its
    /// own version string any more directly than that.
    version: String,
}

impl std::fmt::Debug for InstallRemoteOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InstallRemoteOptions")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("identity_files", &self.identity_files)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("connect_timeout_ms", &self.connect_timeout_ms)
            .field("version", &self.version)
            .finish()
    }
}

/// One progress event the install flow emits as it runs each step, carried
/// to the WebView as `remote-install://progress` — what
/// `connection.phase = 'installing'` (§5.1 of the design) is drawn from.
#[derive(Clone, Serialize)]
struct InstallProgressPayload {
    /// A caller-supplied id correlating a sequence of progress events with
    /// the one `install_remote_runtime` call that produced them — a plain
    /// counter rather than a `ChildKey`, since an install can happen before
    /// any runtime process exists for the workspace it is about to make
    /// usable.
    request_id: String,
    stage: String,
    /// Set only during the `uploading` stage; `(0, 0)` otherwise.
    uploaded_entries: usize,
    total_entries: usize,
}

/// Installs or upgrades the Runtime on a remote host over SSH — the Remote
/// Bootstrapper's one entry point from the front end (§3.5, §8).
///
/// This single command performs the whole sequence: detect the remote
/// platform, pick the matching bundled archive, check whether this exact
/// version is already current (skip entirely if so), upload into a fresh
/// staging directory, then verify and atomically switch. Every step is
/// reported through `remote-install://progress` as it starts, keyed by
/// `request_id` so a front end tracking more than one install (unlikely,
/// but not prevented) can tell them apart.
///
/// Returns the absolute path to the installed binary — through
/// `CurrentLink`, exactly what a subsequent `runtime_attach_remote` should
/// pass as `remote_binary` once this call succeeds. This command does not
/// start the runtime itself: installing and connecting are two separate
/// acts here, the same way `runtime_attach`/`resolve_binary` never install
/// anything locally either.
#[tauri::command]
pub(crate) async fn install_remote_runtime(
    app: AppHandle,
    request_id: String,
    options: InstallRemoteOptions,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install_blocking(app, request_id, options))
        .await
        .map_err(|error| format!("the remote install task failed: {error}"))?
}

fn install_blocking(
    app: AppHandle,
    request_id: String,
    options: InstallRemoteOptions,
) -> Result<String, String> {
    let target = ssh_backend::SshTarget {
        host: options.host,
        port: options.port,
        user: options.user,
        identity_files: options.identity_files,
        password: options.password,
        connect_timeout: Duration::from_millis(options.connect_timeout_ms.filter(|&ms| ms > 0).unwrap_or(15_000)),
    };

    let session = remote_install::open_install_session(&target)
        .map_err(|e| format!("could not connect to install the remote runtime: {e}"))?;

    // Platform is detected once here (rather than inside install_or_upgrade
    // alone) so the archive to upload can be chosen before staging begins —
    // install_or_upgrade still re-detects internally for its own layout, but
    // that second exec is cheap (two `uname` calls) next to a wrong binary
    // discovered only after an upload.
    let remote_target = remote_install::detect_remote_target(&session)
        .map_err(|e| format!("could not identify the remote platform: {e}"))?;
    let archive_path = resolve_remote_package(remote_target.triple)
        .map_err(|e| format!("could not find the install package for this platform: {e}"))?;

    let emit_stage = {
        let app = app.clone();
        let request_id = request_id.clone();
        move |stage: remote_install::InstallStage| {
            let stage_name = match stage {
                remote_install::InstallStage::DetectingPlatform => "detecting_platform",
                remote_install::InstallStage::CheckingExistingInstall => "checking_existing_install",
                remote_install::InstallStage::PreparingStaging => "preparing_staging",
                remote_install::InstallStage::Uploading => "uploading",
                remote_install::InstallStage::VerifyingAndSwitching => "verifying_and_switching",
                remote_install::InstallStage::Done => "done",
            };
            let _ = app.emit(
                "remote-install://progress",
                InstallProgressPayload {
                    request_id: request_id.clone(),
                    stage: stage_name.to_string(),
                    uploaded_entries: 0,
                    total_entries: 0,
                },
            );
        }
    };

    let emit_progress = {
        let app = app.clone();
        let request_id = request_id.clone();
        move |done: usize, total: usize| {
            let _ = app.emit(
                "remote-install://progress",
                InstallProgressPayload {
                    request_id: request_id.clone(),
                    stage: "uploading".to_string(),
                    uploaded_entries: done,
                    total_entries: total,
                },
            );
        }
    };

    remote_install::install_or_upgrade(&session, &archive_path, &options.version, emit_stage, emit_progress)
        .map_err(|e| format!("could not install the remote runtime: {e}"))
}

/// Options shared by `check_remote_config` and `write_remote_config` — the
/// SSH destination, nothing else. A separate, smaller struct from
/// `InstallRemoteOptions` because a config-sync call carries no version and
/// no runtime-specific fields.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfigTarget {
    host: String,
    port: u16,
    user: String,
    #[serde(default)]
    identity_files: Vec<String>,
    password: Option<String>,
    connect_timeout_ms: Option<u64>,
}

impl std::fmt::Debug for RemoteConfigTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteConfigTarget")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("identity_files", &self.identity_files)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("connect_timeout_ms", &self.connect_timeout_ms)
            .finish()
    }
}

impl RemoteConfigTarget {
    fn into_ssh_target(self) -> ssh_backend::SshTarget {
        ssh_backend::SshTarget {
            host: self.host,
            port: self.port,
            user: self.user,
            identity_files: self.identity_files,
            password: self.password,
            connect_timeout: Duration::from_millis(self.connect_timeout_ms.filter(|&ms| ms > 0).unwrap_or(15_000)),
        }
    }
}

/// What `check_remote_config` reports — the camelCase wire shape of
/// `remote_config::RemoteConfigInspection`.
#[derive(Serialize)]
pub(crate) struct RemoteConfigStatusPayload {
    status: String,
    fingerprint: String,
    error: Option<String>,
}

/// Reads and classifies the remote account's `~/.tudouni/config.json`
/// (§9.3 of the design) — the Workspace Manager's one entry point for
/// deciding what a `configPolicy` of `ask` should actually ask about.
///
/// Never writes anything. The returned fingerprint is what the front end
/// compares against a stored baseline (§9.5) to decide whether this is a
/// first sync, an ordinary continuation, or a conflict.
#[tauri::command]
pub(crate) async fn check_remote_config(
    target: RemoteConfigTarget,
) -> Result<RemoteConfigStatusPayload, String> {
    tauri::async_runtime::spawn_blocking(move || check_remote_config_blocking(target))
        .await
        .map_err(|error| format!("the remote config check task failed: {error}"))?
}

fn check_remote_config_blocking(target: RemoteConfigTarget) -> Result<RemoteConfigStatusPayload, String> {
    let ssh_target = target.into_ssh_target();
    let (session, home) = remote_config::connect_and_resolve_home(&ssh_target)
        .map_err(|e| format!("could not connect to check the remote configuration: {e}"))?;
    let inspection = remote_config::check_remote_config(&session, &home)
        .map_err(|e| format!("could not read the remote configuration: {e}"))?;
    Ok(RemoteConfigStatusPayload {
        status: inspection.status.as_str().to_string(),
        fingerprint: inspection.fingerprint,
        error: inspection.error,
    })
}

/// Writes `contents` to the remote account's `~/.tudouni/config.json`
/// safely (§9.6): a temp file, the existing file backed up, then an atomic
/// SFTP rename into place. `contents` must already be the complete file —
/// this command does not merge or validate it beyond what
/// `remote_config::write_remote_config` itself does.
///
/// Returns the fingerprint of what was just written, so the caller can
/// record it as the new sync baseline without a second round trip to read
/// it back.
#[tauri::command]
pub(crate) async fn write_remote_config(
    target: RemoteConfigTarget,
    contents: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || write_remote_config_blocking(target, contents))
        .await
        .map_err(|error| format!("the remote config write task failed: {error}"))?
}

fn write_remote_config_blocking(target: RemoteConfigTarget, contents: String) -> Result<String, String> {
    let ssh_target = target.into_ssh_target();
    let (session, home) = remote_config::connect_and_resolve_home(&ssh_target)
        .map_err(|e| format!("could not connect to write the remote configuration: {e}"))?;
    let bytes = contents.into_bytes();
    remote_config::write_remote_file(&session, &home, "config.json", &bytes)
        .map_err(|e| format!("could not write the remote configuration: {e}"))?;
    Ok(remote_config::fingerprint_hex(&bytes))
}

/* ============================================================
   The config panel's two files, on the far host
   ============================================================ */

/// Read the remote account's `config.json` + `mcp.json` in the panel's own
/// shape.
///
/// **This is the remote twin of `config_read`, and it exists because the two
/// files' paths look identical on both machines.** `~/.tudouni/config.json` is
/// the same string here and there, so a panel that edited "the config file"
/// without asking *whose* wrote this machine's — while the session on screen ran
/// against the other one, and the edit appeared to do nothing.
///
/// The document is built by `config_file::document_from`, the same function the
/// local door uses: the classification (missing / broken / structural) and the
/// `mcp.json` shape are one implementation, so the two panels cannot disagree
/// about what a file means.
#[tauri::command]
pub(crate) async fn read_remote_user_config(
    target: RemoteConfigTarget,
) -> Result<crate::config_file::ConfigDocument, String> {
    tauri::async_runtime::spawn_blocking(move || read_remote_user_config_blocking(target))
        .await
        .map_err(|error| format!("the remote config read task failed: {error}"))?
}

fn read_remote_user_config_blocking(
    target: RemoteConfigTarget,
) -> Result<crate::config_file::ConfigDocument, String> {
    let ssh_target = target.into_ssh_target();
    // `connect_and_resolve_home` asks the far account for `$HOME`, which is the
    // only honest source for where its files are — a path assembled from the
    // client's own home would be a different account's directory.
    let (session, home) = remote_config::connect_and_resolve_home(&ssh_target)
        .map_err(|e| format!("could not connect to read the remote configuration: {e}"))?;
    let paths = crate::config_file::ConfigPaths::under_home(&home);
    let config = remote_config::read_remote_file(&session, &home, "config.json")
        .map_err(|e| format!("could not read the remote config.json: {e}"))?;
    let mcp = remote_config::read_remote_file(&session, &home, "mcp.json")
        .map_err(|e| format!("could not read the remote mcp.json: {e}"))?;
    crate::config_file::document_from(config, mcp, &paths)
}

/// Apply one save to the remote account's `config.json` / `mcp.json`, and
/// answer with the result as it stands afterwards.
///
/// The merge runs against **bytes read over the same SFTP session, immediately
/// before the write** — the local `config_write` rule, and it matters more here:
/// a panel can be open for minutes, and merging into its stale copy would
/// overwrite everything changed in between on a machine this end cannot see.
#[tauri::command]
pub(crate) async fn write_remote_user_config(
    target: RemoteConfigTarget,
    patch: crate::config_file::ConfigPatch,
) -> Result<RemoteConfigWriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || write_remote_user_config_blocking(target, patch))
        .await
        .map_err(|error| format!("the remote config write task failed: {error}"))?
}

/// What one remote save produced: the document as it now reads, and the
/// fingerprints of what was written.
///
/// **Both fingerprints are carried because the sync baseline is a pair.** §9.5
/// compares each side against the value it was last *seen* at, so a save that
/// changed the host's file has to update the recorded remote fingerprint — the
/// false conflict it prevented was "I just edited the server's config and it asks
/// me to sync on every open". Doing it here is what makes that automatic.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteConfigWriteResult {
    document: crate::config_file::ConfigDocument,
    /// Hex SHA256 of what was written to `config.json`, or `None` when the
    /// patch did not touch that file.
    config_fingerprint: Option<String>,
    /// The same for `mcp.json`. Not part of §9's baseline, which predates the
    /// panel editing this file — returned so a caller can tell "it was written"
    /// from "it was not".
    mcp_fingerprint: Option<String>,
}

fn write_remote_user_config_blocking(
    target: RemoteConfigTarget,
    patch: crate::config_file::ConfigPatch,
) -> Result<RemoteConfigWriteResult, String> {
    let ssh_target = target.into_ssh_target();
    let (session, home) = remote_config::connect_and_resolve_home(&ssh_target)
        .map_err(|e| format!("could not connect to write the remote configuration: {e}"))?;
    let paths = crate::config_file::ConfigPaths::under_home(&home);

    // Read the current bytes on the same connection the write will use.
    let current = crate::config_file::MergeInput {
        config: remote_config::read_remote_file(&session, &home, "config.json")
            .map_err(|e| format!("could not read the remote config.json: {e}"))?,
        mcp: remote_config::read_remote_file(&session, &home, "mcp.json")
            .map_err(|e| format!("could not read the remote mcp.json: {e}"))?,
    };
    let merged = crate::config_file::merge(current, &patch, &paths)?;

    let config_fingerprint = match &merged.config {
        Some(bytes) => {
            remote_config::write_remote_file(&session, &home, "config.json", bytes)
                .map_err(|e| format!("could not write the remote config.json: {e}"))?;
            Some(remote_config::fingerprint_hex(bytes))
        }
        None => None,
    };
    let mcp_fingerprint = match &merged.mcp {
        Some(bytes) => {
            remote_config::write_remote_file(&session, &home, "mcp.json", bytes)
                .map_err(|e| format!("could not write the remote mcp.json: {e}"))?;
            Some(remote_config::fingerprint_hex(bytes))
        }
        None => None,
    };

    // The answer is a re-read, not the patch echoed — the same contract as
    // `config_write`, so the panel draws the file's own content after a save.
    let document = crate::config_file::document_from(
        remote_config::read_remote_file(&session, &home, "config.json")
            .map_err(|e| format!("could not re-read the remote config.json: {e}"))?,
        remote_config::read_remote_file(&session, &home, "mcp.json")
            .map_err(|e| format!("could not re-read the remote mcp.json: {e}"))?,
        &paths,
    )?;

    Ok(RemoteConfigWriteResult {
        document,
        config_fingerprint,
        mcp_fingerprint,
    })
}

/// Read `~/.ssh/config` and hand back its concrete `Host` blocks, for the
/// Add Remote Workspace form's host picker.
///
/// A local read of one file the user already maintains: no connection is
/// attempted, and nothing here is a request the runtime is waiting on. The
/// front end treats the answer as **prefill suggestions only** — every field
/// the form fills from it is still editable and still validated at Save.
///
/// The refusal rules the Go side applies when it dials (`ProxyJump` and
/// friends in `internal/ssh/config.go`'s `rejectedFields`) are applied here
/// too, as a per-host `refused` flag: a block that names one of them is
/// listed but marked unselectable, because the dial would fail the same way
/// the Go side's own refusal describes. See `ssh_config`'s module doc for
/// why that second copy of the rules exists at all.
#[tauri::command]
pub(crate) fn read_ssh_config() -> ssh_config::SshConfigDocument {
    ssh_config::read_config()
}

/// What `append_ssh_host` is given: the alias to write and the block's fields.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendSshHostOptions {
    alias: String,
    hostname: String,
    port: u16,
    user: String,
    #[serde(default)]
    identity_files: Vec<String>,
}

/// Add one `Host` block to the user's own `~/.ssh/config` and return the file's
/// path.
///
/// This is what "configure a host here, since there is none" means in this
/// application: `~/.ssh/config` is the one place a host is configured (the Go
/// side reads the same file), so a host added through the wizard is written
/// **there** rather than into a private list only this program can see — a
/// private list would be a host the person cannot reach with `ssh` either.
///
/// **A password is never written.** `Password` is this project's own extension,
/// not an OpenSSH keyword; writing it would break the person's own `ssh` with
/// `Bad configuration option: password` on every connection. See
/// `ssh_config::append_host`.
#[tauri::command]
pub(crate) fn append_ssh_host(options: AppendSshHostOptions) -> Result<String, String> {
    ssh_config::append_host(
        &options.alias,
        &ssh_config::SshConfigHost {
            alias: options.alias.clone(),
            hostname: options.hostname,
            port: options.port,
            user: options.user,
            identity_files: options.identity_files,
            has_password: false,
            refused: None,
        },
    )
}

/// Options for the three `remote_probe`-backed commands: the SSH destination
/// and nothing else.
///
/// The same shape as [`RemoteConfigTarget`] and deliberately a distinct type
/// rather than a reuse of it: the two are different questions asked of the same
/// server, and one gaining a field the other has no business carrying is
/// exactly the kind of drift a shared struct invites.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProbeTarget {
    host: String,
    port: u16,
    user: String,
    #[serde(default)]
    identity_files: Vec<String>,
    password: Option<String>,
    connect_timeout_ms: Option<u64>,
}

impl std::fmt::Debug for RemoteProbeTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteProbeTarget")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("identity_files", &self.identity_files)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("connect_timeout_ms", &self.connect_timeout_ms)
            .finish()
    }
}

impl RemoteProbeTarget {
    fn into_ssh_target(self) -> ssh_backend::SshTarget {
        ssh_backend::SshTarget {
            host: self.host,
            port: self.port,
            user: self.user,
            identity_files: self.identity_files,
            password: self.password,
            connect_timeout: Duration::from_millis(
                self.connect_timeout_ms.filter(|&ms| ms > 0).unwrap_or(15_000),
            ),
        }
    }
}

/// Connect to a host and report what is on the other end: the account's home,
/// its platform, whether the Runtime is installed (and at which version),
/// whether it has a usable `config.json`, and the directories inside `path`.
///
/// This is the **first** step of adding a remote workspace — see
/// `remote_probe`'s module doc for why the flow connects before asking the
/// person anything. It writes nothing, installs nothing, and starts no session:
/// the workspace it is asked about is read, never entered.
///
/// `path` omitted or empty means the account's home directory.
#[tauri::command]
pub(crate) async fn probe_remote_host(
    target: RemoteProbeTarget,
    path: Option<String>,
) -> Result<remote_probe::RemoteProbe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        remote_probe::probe(&target.into_ssh_target(), path.as_deref())
    })
    .await
    .map_err(|error| format!("the remote probe task failed: {error}"))?
}

/// List one directory on a host the wizard has already probed — the browser's
/// "open a folder" and "up" clicks.
///
/// Unlike `probe_remote_host` it does not re-ask the host what it is: the
/// platform, the runtime's state and the config's state were reported by the
/// first probe and do not change while the person is choosing a directory.
/// It makes only the calls a listing needs (over the cached connection when
/// one exists), which is what makes a click in the browser feel like a listing
/// rather than a reconnect. See `remote_probe`'s module doc.
///
/// `path` omitted or empty means the account's home directory.
#[tauri::command]
pub(crate) async fn browse_remote_dir(
    target: RemoteProbeTarget,
    path: Option<String>,
) -> Result<remote_probe::RemoteBrowse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        remote_probe::browse(&target.into_ssh_target(), path.as_deref())
    })
    .await
    .map_err(|error| format!("the remote browse task failed: {error}"))?
}

/// Create one directory on a remote host, for the wizard's "new folder".
///
/// A separate command from `probe_remote_host` on purpose: browsing a host must
/// not be able to create anything on it, and the only way to guarantee that is
/// for the two to be different calls.
///
/// Returns the directory's absolute path, which is what the caller then lists.
#[tauri::command]
pub(crate) async fn create_remote_directory(
    target: RemoteProbeTarget,
    path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        remote_probe::create_directory(&target.into_ssh_target(), &path)
    })
    .await
    .map_err(|error| format!("the remote directory task failed: {error}"))?
}
