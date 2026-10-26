//! Asking before the window closes, and every way that question can end.
//!
//! The prompt is the front end's (every overlay here is DOM), so this module
//! owns the round trip and its deadline: a window that cannot be closed is
//! worse than a prompt that is skipped.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use tauri::{Emitter, Manager};

use crate::runtime_commands::shutdown_blocking;

/// How long the front end is given to **acknowledge** a close prompt before the
/// window closes anyway.
///
/// This is a deadline on the *round trip*, not on the person's decision — see
/// `CLOSE_PROMPT_ACK`. The prompt is the front end's to draw, because every
/// overlay in this application is DOM (`PanelHost`, the two blocking modals), and
/// that round trip can fail: the renderer can be wedged, or the tree can have
/// thrown before the dialog mounted. **A window that cannot be closed is worse
/// than a prompt that is skipped**, which is the same reasoning as
/// `SHUTDOWN_TIMEOUT` and is why this budget exists rather than being left to the
/// front end's good behaviour.
///
/// It has to be short, because it is only covering "the front end never drew the
/// dialog at all" — a live front end answers it in milliseconds.
pub(crate) const CLOSE_PROMPT_TIMEOUT: Duration = Duration::from_secs(5);

/// Whether a close prompt is on screen and unanswered.
///
/// **Not on `Bridge`.** This has nothing to do with the children — minimizing
/// keeps them all running — and the window event handler is handed a `Window`,
/// not the bridge state. It is also deliberately *not* a remembered decision:
/// what the person chose last time is a **preference**, and preferences in this
/// application live in the front end (`aigo.prefs`), read there and enforced
/// there. Rust holds only "a question is outstanding", which is a fact about
/// this moment and nothing else.
pub(crate) static CLOSE_PROMPT_PENDING: AtomicBool = AtomicBool::new(false);

/// Whether the front end has **drawn** the prompt it was asked for.
///
/// This is the difference between a deadline on the round trip and a deadline on
/// the person, and getting it wrong is not a small thing: a fixed timeout alone
/// would close the window a few seconds after the dialog appeared, while somebody
/// was still reading it and deciding. The prompt offers to *remember* a choice, so
/// pausing over it is the expected behaviour rather than an edge case.
///
/// So the watchdog disarms itself the moment the front end says it has the
/// dialog up, and from then on the window waits for an answer for as long as the
/// person takes. What the deadline still covers is the case it was written for:
/// a WebView that is wedged or broken, which never acknowledges anything, and
/// which must not be able to trap the window on screen.
pub(crate) static CLOSE_PROMPT_ACK: AtomicBool = AtomicBool::new(false);

/// Which prompt the watchdog below is watching.
///
/// Bumped when a prompt is asked, and again when it is answered. A watchdog that
/// wakes to find the number moved is looking at a prompt that is over — either
/// answered or superseded — and must not close a window on the strength of a
/// question nobody is asking any more. Without this, answering a prompt and then
/// closing the window again a second later would let the *first* watchdog fire
/// during the second prompt.
pub(crate) static CLOSE_PROMPT_GENERATION: AtomicU64 = AtomicU64::new(0);

/// The prompt is over, however it ended.
///
/// One function because the three fields have to move together: a caller that
/// cleared `PENDING` but left `ACK` set would leave the next prompt looking
/// already-answered, and its watchdog would disarm itself instantly and never
/// close a window whose front end had died.
fn end_close_prompt() {
    CLOSE_PROMPT_PENDING.store(false, Ordering::SeqCst);
    CLOSE_PROMPT_ACK.store(false, Ordering::SeqCst);
    CLOSE_PROMPT_GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// What the person chose in the close prompt.
///
/// Three answers, and the third is not padding. **`Cancel` exists because the
/// prompt is the front end's, and every dialog in this application can be
/// dismissed** — Esc, or a click on the mask outside it. A prompt with two
/// buttons and no way to change your mind turns "I clicked X by accident" into a
/// forced choice between two real actions, and both of them do something the
/// person did not ask for: one hides the window, the other ends every session.
///
/// It is also what keeps the *state* correct. This handler refuses the close and
/// leaves `CLOSE_PROMPT_PENDING` set; a dismissal that did not clear it would
/// leave the flag true forever, and the next press of X would be read as "a
/// prompt is already up" and ignored — a window that can only be closed once.
/// So every way out of the prompt goes through `end_close_prompt`, and `Cancel`
/// is the one that does nothing else.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseChoice {
    Minimize,
    Close,
    Cancel,
}

/// Close the window for real: finish every session, then destroy it.
///
/// **`destroy` and not `close`.** `close` re-emits a close request, which lands
/// straight back in the handler below and is refused again — the window would
/// never go away. This is the same second-pass reasoning the handler has always
/// used.
///
/// The shutdown goes off the event loop, as it must: `runtime_shutdown` blocks
/// for up to `SHUTDOWN_TIMEOUT` (30s) polling for the children to exit, and
/// running it on the thread that pumps window events freezes the window for that
/// whole time with no repaint and no explanation.
pub(crate) fn finish_close(window: tauri::Window) {
    // A close that is already under way must not be started twice: the watchdog
    // and the person's own answer can arrive within the same instant, and two
    // shutdown passes would both write `shutdown` to the children's stdin.
    end_close_prompt();

    let app = window.app_handle().clone();
    thread::spawn(move || {
        let _ = shutdown_blocking(app, None);
        let _ = window.destroy();
    });
}

/// Tell Rust the prompt is **on screen**, so the deadline stops running.
///
/// This is the half that makes the prompt usable. Without it the watchdog would
/// fire a few seconds after the dialog appeared, whatever the person was doing:
/// the choice includes "remember this", so reading it before answering is the
/// expected behaviour, and a window that closes itself while somebody is
/// deciding is worse than no prompt at all.
///
/// It has to be acked rather than assumed, because the deadline has to still
/// cover the case it was written for — a WebView that never drew anything. A
/// front end that is running answers this within the same frame it receives the
/// event, so in practice the deadline only ever expires when the dialog really
/// is not coming.
///
/// A late ack is harmless and is not checked against the generation: the only
/// thing it does is disarm a watchdog, and a watchdog that has already fired has
/// taken the window down regardless. Refusing a late one would cost nothing and
/// buy nothing.
#[tauri::command]
pub(crate) fn close_prompt_ack() -> Result<(), String> {
    CLOSE_PROMPT_ACK.store(true, Ordering::SeqCst);
    Ok(())
}

/// Answer the close prompt.
///
/// The front end calls this once for each `window://close-requested` it drew a
/// dialog for, and **it is the only way the window closes from that dialog**.
/// Going through a command rather than letting the front end call
/// `getCurrentWindow().close()` is not ceremony: `close()` would raise
/// `CloseRequested` again, the handler would refuse it and ask again, and the
/// person would be looking at a prompt that reopened every time they answered it.
#[tauri::command]
pub(crate) fn close_prompt_answer(window: tauri::Window, choice: CloseChoice) -> Result<(), String> {
    match choice {
        // `hide`, not `minimize`. The choice's promise has always been "the
        // window leaves the screen and every session keeps running", and the
        // tray icon is what makes that promise honest: a minimized window is
        // still a taskbar button asking to be clicked again, while a hidden one
        // is reachable exactly one way — through the tray, which is created
        // before this command can ever be answered (see `make_tray`).
        // `hide` keeps the children untouched, as before.
        CloseChoice::Minimize => {
            end_close_prompt();
            window
                .hide()
                .map_err(|e| format!("could not hide the window: {e}"))
        }
        CloseChoice::Close => {
            finish_close(window);
            Ok(())
        }
        // Nothing happens to the window, and the close request is over. See the
        // enum: this is what a dismissal resolves to, and clearing the state is
        // the whole of its job.
        CloseChoice::Cancel => {
            end_close_prompt();
            Ok(())
        }
    }
}

/// Destroy the window without running the close prompt.
///
/// **For `/exit` and nothing else.** That command is already an explicit "quit
/// the application" — the person typed it and pressed Enter — so asking
/// "minimize or close?" afterwards would be the interface asking a question it
/// has been given the answer to.
///
/// The caller shuts the sessions down first (`quitApp` in `runtime/tauri.ts`
/// calls `runtime_shutdown` and then this), which is why no shutdown happens
/// here.
#[tauri::command]
pub(crate) fn window_destroy(window: tauri::Window) -> Result<(), String> {
    end_close_prompt();
    window
        .destroy()
        .map_err(|e| format!("could not close the window: {e}"))
}

/// The window event handler, kept out of `run()` so the entry point stays
/// wiring and the close prompt's four ways out stay in one file.
///
/// The prompt is the front end's and is answered through
/// `close_prompt_answer`; this function only asks, arms the deadline, and
/// refuses the platform's own close until an answer arrives.
pub(crate) fn on_close_requested(window: &tauri::Window, event: &tauri::WindowEvent) {
    // Closing the window **asks first**, because the X button now means
    // two different things and only the person knows which one they
    // meant: minimize (every session keeps running, hidden) or close
    // (every session finishes, and the application exits).
    //
    // The prompt is drawn by the front end and answered through
    // `close_prompt_answer`, which is the only path back here. That is a
    // deliberate round trip: every overlay in this application is DOM,
    // and a native dialog would be a second visual language for one
    // question.
    //
    // **Three ways this ends, and all three have to exist:**
    //   1. the person answers "minimize" → `minimize()`, children untouched;
    //   2. the person answers "close" → `finish_close` below;
    //   3. nobody answers → the watchdog closes the window anyway, after
    //      `CLOSE_PROMPT_TIMEOUT`.
    //
    // (3) is the one that is easy to leave out and must not be. This
    // handler calls `prevent_close()`, so without a deadline a front end
    // that failed to draw the dialog — a wedged renderer, a tree that
    // threw before `CloseConfirm` mounted — would produce a window that
    // cannot be closed at all. Same reasoning as `SHUTDOWN_TIMEOUT`: the
    // wait has to end.
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        // **Only the main window's close is a question for a person.** This
        // handler is registered on the builder, so it sees every window's
        // events — including the launch splash's, which is never supposed to
        // close this way (it is retired with `destroy`, which raises no request
        // at all). Refusing here rather than there is what makes the guard hold
        // even if some future caller closes the splash by mistake: the splash
        // would simply go away instead of raising a minimize-or-close prompt
        // over the whole application.
        if window.label() != "main" {
            return;
        }
        api.prevent_close();

        // A close request while the prompt is already up is the person
        // pressing X again. It must not stack a second prompt, and it
        // must not be read as an answer: doing nothing leaves the first
        // one up, which is what they are looking at.
        if CLOSE_PROMPT_PENDING.swap(true, Ordering::SeqCst) {
            return;
        }
        let generation = CLOSE_PROMPT_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

        // Ask the front end. It draws the dialog, and its answer comes
        // back as a command call.
        let _ = window.emit("window://close-requested", ());

        // The deadline, on its own thread so the event loop keeps
        // painting the dialog it is waiting for.
        let window = window.clone();
        thread::spawn(move || {
            thread::sleep(CLOSE_PROMPT_TIMEOUT);
            // Still the same question, and still unanswered: fall
            // through to a real close. `CLOSE_PROMPT_GENERATION` is what
            // makes this safe — an answered prompt, or a second one
            // asked afterwards, has moved the number on, and this
            // thread's whole purpose is then void.
            if CLOSE_PROMPT_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            // The front end confirmed it drew the dialog, so the wait is
            // now the person's and has no deadline.
            if CLOSE_PROMPT_ACK.load(Ordering::SeqCst) {
                return;
            }
            if !CLOSE_PROMPT_PENDING.swap(false, Ordering::SeqCst) {
                return;
            }
            finish_close(window);
        });
    }
}

