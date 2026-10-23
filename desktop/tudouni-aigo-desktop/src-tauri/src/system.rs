//! The OS facts the shell reports: the user name, whether the display may
//! sleep, and what this application is using right now — the shell, its
//! runtimes, and (on Windows) the WebView2 processes descended from it.
//!
//! `SYSTEM` is one handle for the life of the process because `cpu_usage()` is
//! a delta; minting one per call would report 0.0% forever.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use sysinfo::{Pid, System};
use tauri::{AppHandle, Manager, State};
#[cfg(windows)]
use std::ffi::c_void;

use crate::bridge::Bridge;

/// Keep the screen awake, or let it sleep.
///
/// This talks to the OS directly rather than through a Tauri API, for a
/// concrete reason: the locked tauri 2.12 exposes no prevent-sleep method
/// (checked against the crate source), and the `tauri-plugin-prevent-sleep`
/// that provides one is published as a crate with no JavaScript bindings — so
/// the windowing layer would be reached through a dependency that the front
/// end cannot address. The native calls are one function each:
///
///   - **Windows**: `SetThreadExecutionState` from kernel32, loaded at runtime
///     with `LoadLibrary`/`GetProcAddress` so no link dependency is added.
///   - **macOS**: the IOKit display-sleep assertion pair.
///
/// The state is process-wide rather than per-window, which is the right
/// scope: the question the OS must answer is "is work running in this
/// program", and there is one process. Calling it twice with the same value
/// is a no-op, so the front end may re-assert on every state change without
/// tracking what it sent last.
///
/// `ES_DISPLAY_REQUIRED` and not only `ES_SYSTEM_REQUIRED`: the reported bug
/// is the **screen lock**, and the system-required flag alone would still let
/// the display go dark.
///
/// **The value is the front end's call, and this command only carries it.**
/// The rule "wake only while a session is actually running, never while the app
/// merely sits open" is a policy about sessions, and the sessions live in the
/// front end's store — which is where it is enforced (see `keepAwake`).
#[tauri::command]
pub(crate) fn set_prevent_sleep(_app: AppHandle, on: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        const ES_CONTINUOUS: u32 = 0x8000_0000;
        const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
        const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;

        type SetThreadExecutionStateFn =
            unsafe extern "system" fn(flags: u32) -> u32;

        // The function has been in kernel32 since Windows 2000, so loading it
        // at runtime is a portability formality rather than a compatibility
        // gate — but the gate is kept anyway: a platform without it is a
        // refusal with a sentence, not a crash inside a FFI call.
        unsafe {
            // Both lookups report failure as NULL, not as an Option.
            let k32 = LoadLibraryA(b"kernel32.dll\0".as_ptr() as *const i16);
            if k32.is_null() {
                return Err("could not load kernel32.dll".to_string());
            }
            let f = GetProcAddress(k32, b"SetThreadExecutionState\0".as_ptr() as *const i8);
            if f.is_null() {
                return Err("SetThreadExecutionState was not found in kernel32.dll".to_string());
            }
            let set_state = std::mem::transmute::<*mut c_void, SetThreadExecutionStateFn>(f);
            // Off means "no flags other than ES_CONTINUOUS": that is how the
            // API spells "return to the default" rather than "nothing".
            let flags = if on {
                // Both flags are needed and the pair is deliberate:
                // `ES_DISPLAY_REQUIRED` keeps the screen from going dark while
                // somebody is watching a long turn, and `ES_SYSTEM_REQUIRED`
                // keeps the machine itself from suspending, which would pause
                // the runtime with the display still lit. The previous value had
                // only the display flag despite the comment above claiming
                // otherwise.
                ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED
            } else {
                ES_CONTINUOUS
            };
            let applied = set_state(flags);
            if applied == 0 {
                return Err("SetThreadExecutionState refused the change".to_string());
            }
        }
    }

    #[cfg(not(windows))]
    {
        let _ = on;
        Err("keeping the screen awake is not implemented on this platform yet")
    }

    Ok(())
}

// `LoadLibraryA` from kernel32. The calling process always has kernel32
// mapped, and `LoadLibrary` itself lives in it, so this lookup never needs a
// second library.
#[cfg(windows)]
unsafe extern "system" {
    fn LoadLibraryA(name: *const i16) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const i8) -> *mut c_void;
}

/// The OS user name, for the greeting. The protocol has no such field, and the
/// greeting omits the name when this returns nothing rather than saying
/// "unknown".
#[tauri::command]
pub(crate) fn os_user_name() -> Option<String> {
    for key in ["USERNAME", "USER", "LOGNAME"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// The one `System` handle the whole process shares for resource sampling.
///
/// `cpu_usage()` is a **delta**: it is the difference between two samples of
/// the process's CPU time, and the first sample for a pid has no predecessor,
/// which sysinfo reports as 0.0. A `System` minted per call would therefore
/// report 0.0% CPU **forever** for every process — the numbers would look
/// plausible and be wrong. Keeping one handle for the life of the app is what
/// gives every sample a predecessor, and the first poll after start simply
/// reads 0.0, which is true: no interval has elapsed yet.
///
/// The first sample is taken here, at start-up, and takes roughly a second on
/// Windows: it scans every process on the machine. The app is still in its
/// boot phase at that moment, so the cost lands where it is least visible.
static SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();

/// What the whole application — this shell and every runtime it has started —
/// is using right now.
///
/// **Process-scoped, not session-scoped.** The question the chip answers is
/// "is this application heavy", and the answer has nothing per session to do
/// with it: one number, with a per-piece breakdown for the tooltip.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceUsage {
    /// This shell process's CPU as a percentage of **the machine**, 0..100.
    shell_cpu: f64,
    /// Its memory, in bytes.
    shell_mem: u64,
    /// All running runtimes' CPU summed, same scale as `shell_cpu`.
    runtimes_cpu: f64,
    /// Their memory summed.
    runtimes_mem: u64,
    /// The WebView2 processes that render this window (manager, GPU, network,
    /// storage, the render process) summed. They are **not** shell children —
    /// WVR creates them out-of-process — so the pid scan above never saw them,
    /// and a figure that omitted them understated the application by the size
    /// of the whole UI.
    webview_mem: u64,
    /// Memory in use by the whole system, in bytes.
    system_mem_used: u64,
    /// Total physical memory, in bytes.
    system_mem_total: u64,
}

/// Sample the shell and every running runtime in one refresh.
///
/// **The sum is divided by the core count.** sysinfo's per-process `cpu_usage`
/// is relative to one core, so a process saturating two cores reads 200.0 —
/// the same convention the task manager's per-process column uses, but the
/// chip here is one small number in a status bar, and a figure that can read
/// "240%" over the whole application is noise. On the machine's scale the
/// answer is the one a person means when they ask "how busy is it".
#[tauri::command]
pub(crate) async fn resource_usage(app: AppHandle) -> Result<ResourceUsage, String> {
    // `refresh_all` scans every process on the machine (about a second on the
    // first call, and tens of milliseconds after), so a synchronous command
    // would freeze the window on every poll. Off the main thread.
    tauri::async_runtime::spawn_blocking(move || resource_usage_blocking(app))
        .await
        .map_err(|error| format!("the resource sampling task failed: {error}"))?
}

fn resource_usage_blocking(app: AppHandle) -> Result<ResourceUsage, String> {
    let mut system = SYSTEM
        .get_or_init(|| {
            let mut system = System::new();
            // The first sample is taken here, at the first poll, and takes
            // roughly a second on Windows: it scans every process on the
            // machine. The app is still in its boot phase at that moment, so
            // the cost lands where it is least visible.
            system.refresh_all();
            Mutex::new(system)
        })
        .lock()
        .map_err(|_| "the resource lock is poisoned")?;
    system.refresh_all();

    let cores = system.cpus().len().max(1) as f64;

    // `std::process::id` is `u32` on Windows and `usize` elsewhere, and sysinfo
    // asks for a `usize`; the widening is lossless on every platform that is
    // built for.
    let own = system
        .process(Pid::from(std::process::id() as usize))
        .map(|current| (current.cpu_usage() as f64 / cores, current.memory()))
        .unwrap_or((0.0, 0));

    // Clone the handles under the bridge lock and take the process locks after
    // releasing it: a remote session's write may be holding that lock for up to
    // `WRITE_TIMEOUT`, and the bridge lock must not be waiting behind it.
    let processes: Vec<crate::bridge::SharedProcess> = {
        let state: State<Bridge> = app.state();
        let guard = state.inner.lock().map_err(|_| "the bridge lock is poisoned")?;
        guard
            .children
            .values()
            .map(|current| current.process.clone())
            .collect()
    };

    let mut runtimes_cpu = 0.0;
    let mut runtimes_mem: u64 = 0;
    for process in processes {
        let pid = match process.lock() {
            Ok(process) => process.pid(),
            Err(_) => continue,
        };
        if let Some(pid) = pid {
            if let Some(found) = system.process(Pid::from(pid as usize)) {
                runtimes_cpu += found.cpu_usage() as f64 / cores;
                runtimes_mem += found.memory();
            }
        }
    }

    Ok(ResourceUsage {
        shell_cpu: own.0,
        shell_mem: own.1,
        runtimes_cpu,
        runtimes_mem,
        webview_mem: webview_processes(&system),
        system_mem_used: system.used_memory(),
        system_mem_total: system.total_memory(),
    })
}

/// The memory held by the WebView2 processes that render this window.
///
/// Those processes are **not in the bridge's child list**: the WebView2
/// runtime spawns its manager itself (as a child of this process), and its
/// GPU, network, storage and render processes descend from the manager — so a
/// sum that stopped at the shell and its runtimes understates the application
/// by the whole UI, the very processes the task manager's WebView2 group
/// shows.
///
/// Identification is by **process tree**, not by name alone: every WebView2
/// app on the machine runs processes named `msedgewebview2.exe`, and only the
/// ones descended from this shell are ours. Walking down from our pid rather
/// than matching a command-line marker is also what sysinfo 0.33 allows —
/// it dropped `cmdline()`, and the tree is the fact it still reports.
///
/// CPU is deliberately left out: the render process's CPU *is* the UI's, and
/// "how busy is this application" already reads from the shell.
#[cfg(windows)]
fn webview_processes(system: &System) -> u64 {
    let own = std::process::id();
    // Every process in this shell's subtree, at any depth: the manager is
    // level one, the utility and render processes level two.
    let mut subtree: HashSet<u32> = HashSet::new();
    let mut frontier: Vec<u32> = vec![own];
    while let Some(parent) = frontier.pop() {
        for (pid, process) in system.processes() {
            let cur = pid.as_u32();
            if cur == own {
                continue;
            }
            let is_child = process
                .parent()
                .is_some_and(|par| par.as_u32() == parent);
            if !is_child {
                continue;
            }
            if subtree.insert(cur) {
                frontier.push(cur);
            }
        }
    }

    let mut mem: u64 = 0;
    for (pid, process) in system.processes() {
        if !subtree.contains(&pid.as_u32()) {
            continue;
        }
        if process.name().to_string_lossy().to_lowercase().contains("webview2") {
            mem += process.memory();
        }
    }
    mem
}

// No WebView2 off Windows: the webview is the platform's own toolkit and the
// shell process already accounts for it.
#[cfg(not(windows))]
fn webview_processes(_system: &System) -> u64 {
    0
}
