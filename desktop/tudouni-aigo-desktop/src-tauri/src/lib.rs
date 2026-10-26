//! The desktop shell's Rust side.
//!
//! Every module here is one boundary, and the crate root is only the wiring
//! that puts them together:
//!
//! - [`bridge`] owns the running children and the bytes they emit;
//! - [`launch`] and [`launch_remote`] start one, locally or over SSH;
//! - [`runtime_commands`], [`remote_commands`], [`config_commands`],
//!   [`image`], [`image_stash`], [`deliverable`] and [`system`] are the
//!   commands the front end calls;
//! - [`window_close`], [`window_theme`], [`tray`] and [`notify`] are the
//!   window's own concerns.
//!
//! The rules that used to be stated here in full are still the rules: an
//! absolute path to the same executable, never a `PATH` lookup; the workspace
//! as the child's working directory; stderr drained rather than discarded;
//! and lines queued until the front end attaches. They are implemented in
//! [`launch`], and the Go reference client (`internal/protocol/client.go`)
//! remains the authority for all four.
//!
//! This layer deliberately does **not** parse the protocol: it hands whole
//! lines to the WebView and writes whole lines back. Any urge to read `kind`
//! here would create a second definition of the protocol, and it would drift.

mod bridge;
mod config_commands;

/// Attaching a **file** to a remote session's sentence: the drop and the plus
/// menu both hand over a path on this machine, which the far host has never
/// heard of. See its own module doc for why the upload is keyed by the child.
mod attach;

/// The configuration files the desktop reads and writes directly.
///
/// A module rather than a pair of commands, because it is the one thing here
/// that touches a file the runtime also owns and it carries rules of its own.
/// See its comment for why the desktop is the writer, and for the three rules
/// that keep a save from destroying what the form does not draw.
mod config_file;

mod deliverable;
mod image;
mod image_stash;
mod launch;
mod launch_remote;
mod notify;
mod remote_commands;

/// Phase 4: remote config.json detection and safe writes (§9). See its own
/// module doc for the division of labour with
/// `internal/bootstrap/configsync.go`.
mod remote_config;

/// Remote file access for the doors that used to be local-only: downloading
/// a declared deliverable, reading a remote picture back as a `data:` URL,
/// and uploading a pasted picture into the remote workspace's own paste
/// staging area. See its own module doc for why every act dials a fresh
/// connection and for the boundary it applies.
mod remote_files;

/// The Remote Bootstrapper's transport half: platform detection, SFTP
/// upload, and the verify-and-switch sequence for installing or upgrading
/// the Runtime on a remote host. See its own module doc for the division of
/// labour with `internal/bootstrap` (Go), which specifies every rule this
/// module only mirrors.
mod remote_install;

/// The connect step of the "add a remote workspace" flow: one dial, then the
/// facts only the far end can answer — its home, its platform, whether the
/// Runtime is installed, and what directories it has. See its own module doc
/// for why the flow connects *before* it asks a person anything.
mod remote_probe;

mod runtime_commands;

/// Cross-session keyword search over one workspace's session files. The host
/// process scans the files rather than a runtime child — see its module doc
/// for the division of labour with `internal/state` and the rules it mirrors.
mod session_search;

/// The launch splash's own window, and the one act it exists for: handing the
/// screen over to the main window. See its module doc for why the trigger is an
/// event with a deadline rather than a timer.
mod splash;

/// The Remote Backend: starting the runtime over SSH instead of as a local
/// child process. See its own module doc for why this is a trait
/// ([`ssh_backend::RuntimeProcess`]) rather than a parallel copy of `spawn`.
mod ssh_backend;

/// Reads the user's `~/.ssh/config` so the Add Remote Workspace form can
/// prefill from hosts OpenSSH is already configured with. See its own module
/// doc for why this is a deliberately weaker second copy of the Go parser
/// rather than a link to it.
mod ssh_config;

mod system;
mod tray;
mod window_close;
mod window_theme;
mod workspace_staging;

use tauri::Manager;

use crate::bridge::Bridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single instance (decision 12): a second launch focuses the existing
        // window instead of starting a second copy of the application.
        //
        // **The reason is narrower than it used to say, and the correction
        // matters for reading the rest of this file.** It claimed that two
        // instances would "fight over" everything under `<workspace>/.tudouni/`
        // — sessions, the audit log, artifacts, `mcp.json`. Checked against the
        // runtime, that is not true: session files and audit logs are per
        // session id, artifacts and job output are per session id, and
        // `mcp.json` is only ever read. What *is* shared is
        // `permissions.json`, which every runtime rewrites whole (read → modify
        // → rename) whenever somebody presses "always allow" — and one
        // application already runs several runtimes, so that is a property of
        // separate processes rather than of separate applications.
        //
        // What this plugin still buys is the thing a desktop app should have
        // anyway: launching it twice focuses the window you already have instead
        // of opening a second one over it.
        //
        // It is registered **before** every other plugin, which the plugin's own
        // documentation requires: its setup creates the hidden window that
        // receives the "a second copy started" message, and a plugin registered
        // earlier would already have run its setup by then.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second launch = "I want the app back". That has to work from the
            // tray too: a window hidden into the tray has no taskbar button,
            // so launching the exe again is a natural way to look for it —
            // `unminimize` alone would do nothing for it, so the full restore
            // (show, unminimize, focus) is the same one the tray applies.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            // **A second launch can also arrive while the first is still
            // booting.** The splash is up and the main window has not been
            // shown yet; focusing "the window you have" without retiring the
            // splash would leave the person looking at a floating icon over a
            // window they cannot see. The handover is idempotent, so the
            // ordinary case — splash already gone — costs one failed lookup.
            //
            // **Not held back by the splash's minimum time.** That minimum
            // exists so a very fast launch still shows the icon; a person
            // launching the exe again is asking for their window, and delaying
            // it would be the opposite of what they asked for. `now` as the
            // start makes the elapsed time already past the minimum.
            crate::splash::hand_over(app, std::time::Instant::now());
        }))
        .plugin(tauri_plugin_dialog::init())
        // System notifications. The rule for *when* one is sent is the front
        // end's (`runtime/notify.ts`), and this registration is the whole of
        // Rust's part: the plugin owns the permission handshake with the OS and
        // the platform's own delivery, and doing that by hand would be a second
        // implementation of something that already exists.
        //
        // Worth knowing before wiring anything to it: on **Windows, a
        // notification is attributed to the installed application**, so it shows
        // the `powershell` name and icon when running from a development build.
        // That is the plugin's documented behaviour, not a misconfiguration.
        .plugin(tauri_plugin_notification::init())
        // Markdown links open in the OS browser rather than in a new webview:
        // Tauri 2 refuses `window.open`/`target=_blank` by default, and a new
        // webview window would be the wrong container for arbitrary external
        // URLs anyway (CSP is `default-src 'self'`).
        .plugin(tauri_plugin_opener::init())
        .manage(Bridge::default())
        .invoke_handler(tauri::generate_handler![
            crate::runtime_commands::runtime_attach,
            crate::runtime_commands::runtime_pref_mirror,
            crate::runtime_commands::runtime_attach_remote,
            crate::remote_commands::install_remote_runtime,
            crate::remote_commands::check_remote_config,
            crate::remote_commands::write_remote_config,
            // The config panel's own pair, for a remote screen. Separate from
            // the sync commands above because they answer a different question:
            // those decide *whether* to copy a file between machines, these
            // edit the far machine's file in place, in the panel's shape.
            crate::remote_commands::read_remote_user_config,
            crate::remote_commands::write_remote_user_config,
            crate::config_commands::read_local_config_text,
            crate::runtime_commands::runtime_attach_listener,
            crate::runtime_commands::runtime_send,
            crate::runtime_commands::runtime_shutdown,
            crate::runtime_commands::runtime_kill,
            crate::runtime_commands::runtime_version,
            crate::runtime_commands::remote_runtime_version,
            crate::runtime_commands::runtime_stderr,
            crate::system::resource_usage,
            crate::system::set_prevent_sleep,
            crate::system::os_user_name,
            crate::workspace_staging::workspace_check,
            crate::deliverable::deliverable_open,
            crate::deliverable::deliverable_open_local,
            crate::deliverable::deliverable_download,
            crate::image::inline_image_remote,
            crate::remote_commands::read_ssh_config,
            crate::remote_commands::append_ssh_host,
            crate::remote_commands::probe_remote_host,
            crate::remote_commands::browse_remote_dir,
            crate::remote_commands::create_remote_directory,
            crate::config_commands::config_read,
            crate::config_commands::config_write,
            crate::runtime_commands::sessions_search,
            crate::image_stash::image_stash,
            crate::attach::attach_file_remote,
            crate::image::inline_image,
            crate::window_close::close_prompt_answer,
            crate::window_close::close_prompt_ack,
            crate::window_close::window_destroy,
            crate::notify::notify_send,
            // The launch splash's hand-over. A **command** rather than an
            // event: an invoke is ordered and answered, so the "ready" the
            // front end sends cannot be delivered to nobody. See `splash`'s
            // module doc for the launch that lost it.
            crate::splash::splash_ready,
        ])
        // The tray is built in `setup` rather than in a builder callback so it
        // can use the app handle the same way the commands do; it must exist
        // before the first hide, because the remembered "minimize" policy can
        // hide the window with no dialog ever drawn (see `make_tray`).
        //
        // **The main window is no longer shown here.** It is configured hidden
        // (`"visible": false`) and two things happen to it: the colour is
        // corrected below, and it is shown by `splash::arm`'s handover once the
        // front end reports that the first screen is drawn. Between creating the
        // window and that moment the splash window is the only thing on screen,
        // which is the point — the old version showed the window at ~560 ms and
        // left it empty (WebView2's white) until ~1.9 s.
        .setup(|app| {
            tray::make_tray(app.handle())?;
            if let Some(window) = app.get_webview_window("main") {
                // Only the colour: a window that cannot be painted is not a
                // reason to fail the launch, and nothing below depends on it.
                let _ = window_theme::correct_window_colour(&window);
            }
            // The splash's half of the launch: listen for "the first screen is
            // drawn" and hold a 20-second deadline in case it never is.
            splash::arm(app.handle());
            // The speculative runtime, started from the launch pref the
            // previous run mirrored. On its own thread because set-up owns the
            // window's first show: the whole point is that the WebView's boot
            // and the child's start overlap, and neither waits for the other.
            // `pre_spawn` is best effort by construction — every failure path
            // inside it returns without touching anything else.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                crate::launch::pre_spawn(&handle);
            });
            Ok(())
        })
        .on_window_event(window_close::on_close_requested)
        .run(tauri::generate_context!())
        .expect("the Tauri application failed to start");
}
