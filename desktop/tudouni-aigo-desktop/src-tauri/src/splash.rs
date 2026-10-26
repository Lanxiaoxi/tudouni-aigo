//! The launch splash window's one job: hand the screen over to the main window.
//!
//! The splash is a window of its own (`label: "splash"` in `tauri.conf.json`),
//! created visible over the desktop so the first second of a launch is the
//! application's icon breathing rather than an empty screen. The main window is
//! configured hidden, and this module is the only thing that shows it.
//!
//! **Why the handover is an event and not a timer.** "Ready" means the front end
//! has actually drawn something — the handshake landed and the first screen or
//! the transcript is on screen (`src/splash.ts` owns that judgement). No delay
//! Rust could pick would be right for both a warm local launch and a remote
//! workspace crossing SSH, so the front end says when, and this listens once.
//!
//! **Why there is still a deadline.** The event can never arrive: a webview that
//! crashed, a front end that threw before its first commit, an SSH start that is
//! slower than anybody will wait. A splash that stays up forever would be a
//! window with no exit and no explanation — so after `HANDOVER_TIMEOUT` the
//! handover runs regardless, and the main window's own "Starting the runtime…"
//! (and its slow-start wording) takes over. Same reasoning as
//! `CLOSE_PROMPT_TIMEOUT` and `SHUTDOWN_TIMEOUT`: the wait has to end.

use std::time::Duration;

use tauri::{AppHandle, Listener, Manager};

/// The event the front end emits once the first screen is really drawn.
///
/// Paired with `SPLASH_READY_EVENT` in `src/splash.ts`, which is where the emit
/// lives. A `splash://` name, following `notify://` and `tray://`: the window
/// this is about is the splash, and the main window is what takes over.
const SPLASH_READY: &str = "splash://ready";

/// The longest the splash may hold the screen on its own, in milliseconds.
///
/// Twenty seconds, because that is comfortably past a cold launch on a slow
/// machine and inside the stretch where somebody is still waiting rather than
/// having decided it is broken. Past it the application is on screen either way;
/// the booting screen explains the rest.
const HANDOVER_TIMEOUT: Duration = Duration::from_secs(20);

/// How long the main window is shown *before* the splash is retired, in
/// milliseconds.
///
/// The order alone — main first, splash second — is what keeps a frame with
/// neither window on screen from ever existing. The delay covers the stretch
/// where the main window has been asked to show but WebView2 has not composited
/// it yet: the splash (always-on-top, and exactly over the main window's centre)
/// keeps covering it until the application is painted.
const SPLASH_LINGER: Duration = Duration::from_millis(150);

/// Wait for `splash://ready`, then hand the screen over.
///
/// Called once from `setup`, before the event loop runs, so the listener is
/// always in place before any document can emit. `once_any` rather than
/// `listen_any`: the handover happens exactly once, and a second emit — a
/// reloaded document, a retry — must not try to retire a window that is already
/// gone.
///
/// The deadline thread is spawned here beside it for the same reason: both are
/// about the same single moment, and splitting them into two callers would make
/// it possible to arm one without the other.
pub(crate) fn arm(app: &AppHandle) {
    let handle = app.clone();
    app.once_any(SPLASH_READY, move |_event| {
        hand_over(&handle);
    });

    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(HANDOVER_TIMEOUT);
        // The splash being gone is the ordinary case by now: the event won and
        // `hand_over` retired it. Only a splash that is *still* there means the
        // front end never said ready.
        if handle.get_webview_window("splash").is_some() {
            hand_over(&handle);
        }
    });
}

/// Show the main window, then retire the splash shortly afterwards.
///
/// **Idempotent on purpose.** Three callers can reach it — the ready event, the
/// deadline thread, and the single-instance callback (a second launch while the
/// first is still booting) — and any two of them can land within the same
/// instant. Showing a visible window is harmless, and a splash that has already
/// been retired simply is not found.
/// `show`, `unminimize` and `set_focus` are the same full restore the tray uses:
/// a launch is a request to see the application, so it comes forward.
pub(crate) fn hand_over(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // A window that cannot be shown is not a reason to fail the launch —
        // the splash still has to go, or the application would be a floating
        // icon forever.
        let _ = crate::window_theme::show_main_window(&window);
        let _ = window.unminimize();
        let _ = window.set_focus();
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SPLASH_LINGER);
        if let Some(splash) = handle.get_webview_window("splash") {
            // **`destroy`, not `close`.** `close` raises `CloseRequested`, which
            // the window-close module intercepts to ask the person whether to
            // minimize or close — a question about the *main* window, and one
            // the splash must never raise: answering it would end every session.
            // `destroy` bypasses the request entirely, which is also why the
            // close handler refuses to treat this window as a question.
            let _ = splash.destroy();
        }
    });
}
