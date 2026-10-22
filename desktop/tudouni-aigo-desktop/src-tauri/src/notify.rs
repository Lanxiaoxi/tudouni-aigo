//! A toast for a session that needs attention, and — on Windows — the click.
//!
//! The rule for *when* a notification is sent is the front end's
//! (`runtime/notify.ts`); this module only delivers it and reports activation.


use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
#[cfg(windows)]
use tauri_winrt_notification::Toast;

use crate::tray::tray_show_inner;

/// The event the front end listens for when somebody clicks a notification.
///
/// Paired with `NOTIFY_ACTIVATED` in `src/runtime/tauri.ts`, which is where the
/// listener lives. A `notify://` name rather than `window://` because this is not
/// about the window: the window is restored here, and what the front end is told
/// is *which session* the click was about.
///
/// Windows-only, because that is the only platform whose delivery path can report
/// a click — see `deliver_notification`.
#[cfg(windows)]
const NOTIFY_ACTIVATED: &str = "notify://activated";

/// One notification, as the front end asks for it.
///
/// The three identity fields exist for the **click** and are echoed back when it
/// happens. They come from the front end because they are facts only the store
/// has: `key` is the bridge's own child handle (the thing the front end addresses
/// a session by), and the runtime's session id and the workspace arrive with
/// `init` — this layer deliberately does not parse the protocol, so it could not
/// produce either of them.
///
/// `session_id` and `workspace` are what `openSession` needs when the child is
/// **gone** by the time somebody clicks: a notification is at least as old as the
/// transition that raised it, and a person who reads it a minute later may have
/// closed that conversation in between. Without them the click could only ever
/// focus a session that is still open, which is the case that needs it least.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyRequest {
    key: String,
    session_id: String,
    workspace: String,
    title: String,
    body: String,
}

/// The click, as the front end receives it.
#[cfg(windows)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotifyActivatedPayload {
    key: String,
    session_id: String,
    workspace: String,
}

/// The AppUserModelID a toast is attributed to.
///
/// The identifier from `tauri.conf.json` when the application is **installed**,
/// and PowerShell's when it is not. **This is not a cosmetic choice.** A toast is
/// shown by the shell on behalf of an AUMID Windows already knows, and a build
/// running out of `target/debug` has no registration for `dev.tudouni.aigo` — the
/// call fails with "element not found" and *nothing appears at all*. The plugin
/// makes the same test for the same reason
/// (`tauri-plugin-notification/src/desktop.rs`), which is why a development
/// build's notifications say `powershell` and wear its icon: that is a registered
/// AUMID and this one is not.
///
/// "Installed" is decided by the executable's own directory, which is what
/// separates the two cases here: NSIS puts the exe under Program Files, while
/// every development build stays under `target/{debug,release}`.
#[cfg(windows)]
fn toast_app_id(app: &AppHandle) -> String {
    let development = tauri::utils::platform::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
        .map(|dir| {
            let path = dir.display().to_string();
            path.ends_with(r"target\debug") || path.ends_with(r"target\release")
        })
        .unwrap_or(false);

    if development {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    }
}

/// Show one system notification.
///
/// ## Why this command exists instead of the plugin's
///
/// `tauri-plugin-notification` shows a toast on every desktop platform, and on
/// Windows it is built on the very same crate this uses. What it does **not** do
/// is report the click: its `notify` command calls `show()` and drops the
/// notification handle, and its JS documents `onAction` and
/// `onNotificationReceived` as "only emitted on mobile". A toast that knows which
/// session it is about has to own its own activation callback, so Windows gets a
/// toast built here.
///
/// The plugin is still the delivery path **everywhere else**
/// (`deliver_notification`'s other half), so this is not a second
/// implementation of delivery — it is one platform's delivery plus the click.
///
/// ## What the click does
///
/// Two things, in this order:
///
///   1. **Restores the window**, through the same `tray_show_inner` the tray icon
///      uses — show, unminimize, focus. A toast is only ever sent for a session
///      nobody is looking at (`isWatched`), so the window is minimized, hidden, or
///      behind something; a notification that focuses a session inside a window
///      still in the tray would look like nothing happened.
///   2. **Tells the front end which session it was**, as `notify://activated`.
///      Focusing it is the front end's act (`focusSession` / `openSession`), not
///      this layer's: the store is the only thing that knows whether that key is
///      still live, and it is also what clears the session's `unseen` mark.
///
/// A failure is returned as a sentence because the caller is a `void`-ed promise
/// in a hook: a notification that did not arrive costs the old behaviour —
/// everything is still on the screen — and there is nothing to retry.
#[tauri::command]
pub(crate) fn notify_send(app: AppHandle, content: NotifyRequest) -> Result<(), String> {
    if content.title.trim().is_empty() {
        // A toast with no title is a body the shell attributes to nothing.
        return Err("a notification needs a title".to_string());
    }
    deliver_notification(&app, &content)
}

/// The Windows half: a toast whose activation comes back to this process.
///
/// `on_activated` is the whole point — it is attached to the `ToastNotification`
/// object, which the shell keeps alive once it has been shown, and it fires when
/// the toast body is clicked (there are no buttons here, so the action argument
/// is always `None`, which is deliberate: the toast has exactly one meaning).
#[cfg(windows)]
fn deliver_notification(app: &AppHandle, content: &NotifyRequest) -> Result<(), String> {
    let payload = NotifyActivatedPayload {
        key: content.key.clone(),
        session_id: content.session_id.clone(),
        workspace: content.workspace.clone(),
    };

    let target = app.clone();
    let mut toast = Toast::new(&toast_app_id(app))
        .title(&content.title)
        .on_activated(move |_action| {
            // The window first, so the session the event names is on screen by
            // the time the front end focuses it. `run_on_main_thread` because
            // this callback arrives on a COM thread that has nothing to do with
            // the event loop the window belongs to.
            let restore = target.clone();
            let _ = target.run_on_main_thread(move || {
                let _ = tray_show_inner(&restore);
            });
            let _ = target.emit(NOTIFY_ACTIVATED, payload.clone());
            Ok(())
        });

    // Skipped rather than sent empty: `notifyContent` produces no body when a
    // session has neither a workspace nor an id yet, and a `text1` element with
    // nothing in it is a blank second line the shell still reserves.
    if !content.body.is_empty() {
        toast = toast.text1(&content.body);
    }

    toast
        .show()
        .map_err(|e| format!("could not show the notification: {e}"))
}

/// Everywhere else: the plugin, exactly as before.
///
/// Linux and macOS keep the delivery they had — including its limitations, which
/// are the plugin's own permission handshake and toast, not ours. The click is
/// **not** wired up there: on macOS it needs an application delegate and on Linux
/// the notification's default action comes back over D-Bus, and neither is a
/// mechanism this file can borrow. The desktop release target is Windows NSIS, so
/// the honest thing is to keep delivery working and say nothing about a click
/// that will not arrive.
#[cfg(not(windows))]
fn deliver_notification(app: &AppHandle, content: &NotifyRequest) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    let mut builder = app.notification().builder().title(&content.title);
    if !content.body.is_empty() {
        builder = builder.body(&content.body);
    }
    builder
        .show()
        .map_err(|e| format!("could not show the notification: {e}"))
}
