//! The launch splash window's one job: hand the screen over to the main window.
//!
//! The splash is a window of its own (`label: "splash"` in `tauri.conf.json`),
//! created visible over the desktop so the first second of a launch is the
//! application's icon breathing rather than an empty screen. The main window is
//! configured hidden, and this module is the only thing that shows it.
//!
//! **Why the trigger is a command and not an event.** "Ready" means the front
//! end has actually drawn something — the handshake landed and the first screen
//! or the transcript is on screen (`src/splash.ts` owns that judgement). No delay
//! Rust could pick would be right for both a warm local launch and a remote
//! workspace crossing SSH, so the front end says when.
//!
//! It says it by **calling `splash_ready`**, and that is a correction rather than
//! a preference. The first version listened with `once_any("splash://ready")`,
//! and a launch where the emit happened to be delivered while no listener was
//! armed — the event is a one-shot with no queue behind it — lost it entirely:
//! the front end logged that it had emitted, Rust never ran its handler, and the
//! window only appeared when the deadline below fired twenty seconds later. A
//! command has no such window: an invoke is a request with an answer, it is
//! ordered against everything else the window sends, and the front end can tell
//! whether it arrived. The hand-over is idempotent, so repeated calls are free.
//!
//! **Why there is still a deadline.** The call can never arrive: a webview that
//! crashed, a front end that threw before its first commit, an SSH start that is
//! slower than anybody will wait. A splash that stays up forever would be a
//! window with no exit and no explanation — so after `HANDOVER_TIMEOUT` the
//! handover runs regardless, and the main window's own "Starting the runtime…"
//! (and its slow-start wording) takes over. Same reasoning as
//! `CLOSE_PROMPT_TIMEOUT` and `SHUTDOWN_TIMEOUT`: the wait has to end.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// The longest the splash may hold the screen on its own.
///
/// Twenty seconds, because that is comfortably past a cold launch on a slow
/// machine and inside the stretch where somebody is still waiting rather than
/// having decided it is broken. Past it the application is on screen either way;
/// the booting screen explains the rest.
const HANDOVER_TIMEOUT: Duration = Duration::from_secs(20);

/// How long the main window is shown *before* the splash is retired.
///
/// The order alone — main first, splash second — is what keeps a frame with
/// neither window on screen from ever existing. The delay covers the stretch
/// where the main window has been asked to show but WebView2 has not composited
/// it yet: the splash (always-on-top, and exactly over the main window's centre)
/// keeps covering it until the application is painted.
const SPLASH_LINGER: Duration = Duration::from_millis(150);

/// The shortest stretch the splash stays up, however fast the launch is.
///
/// **Without this the warm launch has no splash at all.** A launch whose
/// pre-spawned child is already handshaken reaches "ready" in a few hundred
/// milliseconds, and the hand-over would show the main window while the splash
/// window's own webview is still loading `splash.html` — so the person sees a
/// flash of nothing, then the application, and never the icon. Measured on the
/// second launch after a quit, which is exactly the launch that made this
/// visible.
///
/// A floor rather than a chosen duration because the interesting number is the
/// *slow* launch, which must not be held back: this only ever delays a hand-over
/// that would otherwise have happened sooner. 900 ms is about two and a half
/// breaths of the icon — long enough to be read as an intentional splash, short
/// enough not to sit in front of a window that is already drawn.
const SPLASH_MIN: Duration = Duration::from_millis(900);

/// Whether the hand-over has already started.
///
/// The three callers — the command, the deadline, and the single-instance
/// callback — can land within the same instant, and two hand-overs would spawn
/// two closers for one window. The windows themselves tolerate it; this flag is
/// what keeps the act single, which is what lets the deadline be a plain
/// "if it is still there" check.
static HANDED_OVER: AtomicBool = AtomicBool::new(false);

/// Arm the deadline, and nothing else.
///
/// Called once from `setup`. There is no listener to register any more: the
/// front end reaches `hand_over` through the `splash_ready` command below, which
/// is an invoke and therefore cannot arrive before the app can answer it.
pub(crate) fn arm(app: &AppHandle) {
    let handle = app.clone();
    let armed_at = std::time::Instant::now();
    std::thread::spawn(move || {
        std::thread::sleep(HANDOVER_TIMEOUT);
        if !HANDED_OVER.load(Ordering::SeqCst) {
            // The one case worth a line: the front end never said ready, so the
            // deadline did the hand-over instead. Silent otherwise — a normal
            // launch has nothing to report.
            eprintln!("[splash] deadline fired: the front end never said ready");
            hand_over(&handle, armed_at);
        }
    });
}

/// The front end's "my first screen is drawn" call.
///
/// Returns whether this call did the hand-over, which the front end does not
/// need but which makes the ordering visible to anybody reading a log. A second
/// call is a no-op rather than an error: a reloaded document runs the same
/// check, and asking for a hand-over that already happened is not a failure.
///
/// **`async`, and that is load-bearing.** The hand-over may wait out
/// `SPLASH_MIN`, and a synchronous `#[tauri::command]` runs on the main thread —
/// the thread that also composites the splash window. Sleeping there froze the
/// very animation the minimum exists to show: the launch took the same
/// nine hundred milliseconds either way, and the icon never breathed once. As an
/// `async` command the body runs off the event loop, so the wait costs the
/// splash nothing.
#[tauri::command]
pub(crate) async fn splash_ready(app: AppHandle) -> bool {
    let first = !HANDED_OVER.swap(true, Ordering::SeqCst);
    if first {
        hand_over(&app, std::time::Instant::now());
    }
    first
}

/// Show the main window, then retire the splash shortly afterwards.
///
/// **Idempotent on purpose.** Three callers can reach it — the command, the
/// deadline thread, and the single-instance callback (a second launch while the
/// first is still booting) — and any two of them can land within the same
/// instant. Showing a visible window is harmless, and a splash that has already
/// been retired simply is not found.
/// `show`, `unminimize` and `set_focus` are the same full restore the tray uses:
/// a launch is a request to see the application, so it comes forward.
///
/// `since` is when this launch's splash appeared. The window is shown once
/// `SPLASH_MIN` has passed, so a launch that becomes ready almost immediately —
/// the warm second launch — still gives the icon the breaths that make it read
/// as a splash rather than as a flicker of nothing.
///
/// **The wait never happens on a caller's thread, and that is not politeness.**
/// The callers are a Tauri command and the deadline thread; the command runs on
/// the event loop, and the event loop is what composites the splash window.
/// Sleeping there for the minimum froze the animation the minimum exists to
/// show — measured as "both launches behave identically and no icon ever
/// appears", which is exactly what a 900 ms freeze at the one moment the icon
/// was supposed to breathe looks like. So this function only *decides* and then
/// hands the work to a thread: the wait and the show happen together, off the
/// loop, and the splash keeps painting the whole time.
pub(crate) fn hand_over(app: &AppHandle, since: std::time::Instant) {
    HANDED_OVER.store(true, Ordering::SeqCst);

    let handle = app.clone();
    std::thread::spawn(move || {
        // The remainder of the minimum, so the icon is on screen for a readable
        // stretch even when "ready" arrived on the first frame.
        let waited = since.elapsed();
        if waited < SPLASH_MIN {
            std::thread::sleep(SPLASH_MIN - waited);
        }

        if let Some(window) = handle.get_webview_window("main") {
            // A window that cannot be shown is not a reason to fail the launch —
            // the splash still has to go, or the application would be a floating
            // icon forever.
            let _ = crate::window_theme::show_main_window(&window);
            let _ = window.unminimize();
            let _ = window.set_focus();
        }

        // The linger, so the splash covers the stretch where the main window has
        // been asked to show but WebView2 has not composited it yet — the splash
        // is always-on-top and sits exactly over the main window's centre.
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
