//! Running an outside program for a probe: a hard timeout, no console window,
//! and errors that say which program failed and how.
//!
//! Shared by every probe that shells out (`curl`, `git`, `gh`, `command`), so
//! the timeout and the Windows window flag are decided once.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// What a finished program left behind.
#[derive(Debug)]
pub(crate) struct Finished {
    /// `None` when the program was killed by a signal.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Finished {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
}

/// The last `limit` characters of a program's stderr, for an error message:
/// the end is where tools put the reason.
pub(crate) fn tail(text: &str, limit: usize) -> String {
    let text = text.trim();
    let count = text.chars().count();
    if count <= limit {
        return text.to_string();
    }
    let skip = count - limit;
    format!("…{}", text.chars().skip(skip).collect::<String>())
}

/// Run `program args…` and wait at most `timeout`.
///
/// stdout and stderr are drained on their own threads: a program that fills a
/// pipe buffer while we only poll `try_wait` would otherwise block forever and
/// turn every large API response into a timeout.
pub(crate) fn run(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<Finished, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW, as in launch.rs: a scan must not flash a console.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("{program} was not found on PATH")
        } else {
            format!("{program} could not be started: {e}")
        }
    })?;

    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let out_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = out.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = err.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{program} did not finish within {}s", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("{program} could not be waited for: {e}")),
        }
    };

    let stdout = String::from_utf8_lossy(&out_thread.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err_thread.join().unwrap_or_default()).into_owned();
    Ok(Finished { code: status.code(), stdout, stderr })
}

/// `run`, but a non-zero exit is an error carrying the end of stderr.
pub(crate) fn run_ok(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<String, String> {
    let done = run(program, args, cwd, timeout)?;
    if done.success() {
        return Ok(done.stdout);
    }
    let code = done.code.map_or_else(|| "a signal".to_string(), |c| c.to_string());
    let why = tail(&done.stderr, 500);
    Err(if why.is_empty() {
        format!("{program} exited with {code}")
    } else {
        format!("{program} exited with {code}: {why}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_the_end() {
        assert_eq!(tail("  short  ", 10), "short");
        assert_eq!(tail("abcdef", 3), "…def");
    }

    #[test]
    fn a_missing_program_says_so() {
        let err = run("definitely-not-a-program-xyz", &[], None, Duration::from_secs(5)).unwrap_err();
        assert!(err.contains("not found"), "{err}");
    }

    #[cfg(windows)]
    #[test]
    fn output_and_exit_code_are_captured() {
        let args: Vec<String> = ["/C", "echo hello& echo oops 1>&2& exit 3"].iter().map(|s| s.to_string()).collect();
        let done = run("cmd", &args, None, Duration::from_secs(10)).unwrap();
        assert_eq!(done.code, Some(3));
        assert!(done.stdout.contains("hello"));
        assert!(done.stderr.contains("oops"));
        let err = run_ok("cmd", &args, None, Duration::from_secs(10)).unwrap_err();
        assert!(err.contains("exited with 3") && err.contains("oops"), "{err}");
    }

    #[cfg(windows)]
    #[test]
    fn a_slow_program_is_killed_at_the_timeout() {
        let args: Vec<String> = ["-NoProfile", "-Command", "Start-Sleep -Seconds 20"].iter().map(|s| s.to_string()).collect();
        let started = Instant::now();
        let err = run("powershell", &args, None, Duration::from_secs(1)).unwrap_err();
        assert!(err.contains("did not finish"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
