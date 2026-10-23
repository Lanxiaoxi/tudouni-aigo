//! The system tray icon and its menu.
//!
//! It exists for one promise: "minimize" hides the window while every session
//! keeps running, and without this icon a hidden window would be unreachable.

use std::thread;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::runtime_commands::shutdown_blocking;

/// The event the front end listens for when somebody acts on the tray menu.
///
/// Paired with `onTrayCommand` in `src/runtime/tauri.ts`, which is where the
/// listener lives. A `tray://` name rather than `window://` because the window
/// is only half of it: showing the window happens here, and what the front end
/// is told is *which act* was asked for — one the store, not this layer, is
/// positioned to perform (the board's gate and the modal guard are its
/// selectors, and "a new session" is its `openSession`).
const TRAY_COMMAND: &str = "tray://command";

/// The one field the front end needs: which tray item was clicked.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayCommandPayload {
    /// `"new-session"` or `"open-board"`, matching the `TrayAction` union the
    /// front end narrows on.
    action: &'static str,
}

/// Create the system tray icon and its menu.
///
/// It exists for one promise: "minimize" in the close prompt hides the window
/// while every session keeps running, and without this icon a hidden window
/// would be unreachable — the person would have to end the process from Task
/// Manager to get back to work. It is created **at startup**, not lazily on
/// the first hide, because the prompt can be answered through a remembered
/// policy with no dialog at all (`useWindowClose`), and a lazily-created icon
/// would then first appear exactly one click too late.
///
/// The menu is what the icon has to offer: show, a separator, the two session
/// acts the window can be summoned for, another separator, and quit. Quit goes
/// through `runtime_shutdown` on a thread and then `destroy` — the same path as
/// the `/exit` command — because the tray must not raise a close request (the
/// prompt handler would refuse it and leave the application "quitting"
/// forever), and must not kill running turns without the graceful wait
/// `runtime_shutdown` provides.
///
/// The two session acts do their window half here and their session half in the
/// front end: `tray_show_inner` runs synchronously, because a menu click that
/// leaves the window hidden has visibly done nothing, and the act itself is
/// then handed over as `tray://command`. The front end keeps the guards (a
/// pending approval must not be abandoned by a session switch; the board needs
/// a workspace with a child), which this layer deliberately does not restate —
/// it has no read on either condition, and a second copy would drift.
///
/// Left click shows the window (the near-universal Windows convention);
/// double click is deliberately left to bubble through as its own event and
/// also shows it, via the same `TrayIconEvent::Click` match. The menu still
/// opens on **right** click, because `show_menu_on_left_click` stays off.
pub(crate) fn make_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "tray-show", "Show tudouni-aigo", true, None::<&str>)?;
    let new_session_item =
        MenuItem::with_id(app, "tray-new-session", "New session", true, None::<&str>)?;
    let board_item = MenuItem::with_id(app, "tray-board", "Session board", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &PredefinedMenuItem::separator(app)?,
            &new_session_item,
            &board_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let mut tray = TrayIconBuilder::with_id("main")
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => {
                if let Ok(()) = tray_show_inner(app) {}
            }
            "tray-new-session" => {
                if let Ok(()) = tray_show_inner(app) {}
                let _ = app.emit(TRAY_COMMAND, TrayCommandPayload { action: "new-session" });
            }
            "tray-board" => {
                if let Ok(()) = tray_show_inner(app) {}
                let _ = app.emit(TRAY_COMMAND, TrayCommandPayload { action: "open-board" });
            }
            "tray-quit" => {
                let app = app.clone();
                let shutdown_handle = app.clone();
                thread::spawn(move || {
                    let _ = shutdown_blocking(shutdown_handle, None);
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.destroy();
                    }
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left click = show, the Windows convention. The menu opens on
            // right click only (`show_menu_on_left_click(false)` above).
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = tray_show_inner(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Restore the main window from the tray, shared with the tray's own event
/// handlers.
pub(crate) fn tray_show_inner(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("the main window does not exist")?;
    window
        .show()
        .and_then(|_| window.unminimize())
        .and_then(|_| window.set_focus())
        .map_err(|e| format!("could not show the window: {e}"))
}
