#!/usr/bin/env python3
"""End-to-end check: drive the real binary over the protocol.

This is the evidence the unit tests cannot give. Everything else in this
repository tests a package in isolation; this starts the shipped executable in
`--runtime-stdio` mode, speaks the JSONL protocol to it, and reads what comes
back — so the pieces (protocol dispatch, the terminal manager, the real ConPTY,
the artifact store, the workspace boundary) are proven to be wired to each other
and not merely to compile.

It needs a configured model, because the runtime refuses to open without one —
so it uses an isolated `AGENT_CONFIG_FILE` and a key that is never used (no turn
is ever run; this exercises the workspace capabilities, not the model).

Run:  python tools/check-workspace-protocol.py
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import time

EXE = os.path.join("dist", "tudouni-aigo.exe")
if not os.path.exists(EXE):
    EXE = os.path.join("dist", "tudouni-aigo")
if not os.path.exists(EXE):
    sys.exit("build the binary first: make build")


def config_file(root):
    """A catalogue with one usable route. The key is a placeholder: no request is
    ever made, and the runtime only needs *a* usable route to open.

    `providers` is an **object keyed by route name**, not a list — the route name
    is the key, and its order is the order of the `/model` list. Writing a list
    here is refused with "must be an object (route name -> route config)"."""
    path = os.path.join(root, "config.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "providers": {
                    "probe": {
                        "base_url": "http://127.0.0.1:9",
                        "api_key": "probe-key-never-used",
                        "models": [{"id": "probe-model", "context_window": 1000}],
                    }
                }
            },
            handle,
        )
    return path


def main():
    workspace = tempfile.mkdtemp(prefix="wsprobe-")
    # A directory and a file for the browser, and a subdirectory to walk into.
    os.makedirs(os.path.join(workspace, "backend"), exist_ok=True)
    # **Written as bytes, with `newline=""`.** Python's text mode translates
    # `\n` to `\r\n` on Windows, so the fixture would be a CRLF file on one
    # platform and an LF file on another — and the check below asserts the body
    # comes back **verbatim**, which is exactly the property that would then
    # differ per machine. (The first version of this probe did translate, and
    # the one failure it reported was the fixture's fault rather than the
    # runtime's.)
    body = "# probe\nline two\n"
    with open(os.path.join(workspace, "README.md"), "w", encoding="utf-8", newline="") as handle:
        handle.write(body)

    env = dict(os.environ)
    env["AGENT_CONFIG_FILE"] = config_file(workspace)

    process = subprocess.Popen(
        [os.path.abspath(EXE), "--runtime-stdio"],
        cwd=workspace,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )

    seen = []
    # A reader **thread** rather than `readline()` inside the pump, and that is
    # not a style choice: `readline()` on a pipe blocks until the child writes or
    # exits, so a pump calling it directly hangs for ever on the first quiet
    # moment — and every terminal interaction has one, because a terminal's
    # output is asynchronous by design (that is the whole point of §13). The
    # thread owns the blocking read; the pump only ever waits on a clock.
    incoming = []
    lock = threading.Lock()

    def reader():
        for line in process.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            with lock:
                incoming.append(message)

    threading.Thread(target=reader, daemon=True).start()

    def send(message):
        process.stdin.write(json.dumps(message) + "\n")
        process.stdin.flush()

    def pump(seconds):
        """Read whatever arrives for a while, returning the parsed messages.

        The runtime is asynchronous — terminal output has no reply — so this
        waits on a clock rather than on a specific message. That is the point
        being tested: an implementation that answered synchronously would pass a
        reply-driven check and still be wrong."""
        deadline = time.time() + seconds
        out = []
        while time.time() < deadline:
            with lock:
                taken, incoming[:] = list(incoming), []
            out.extend(taken)
            seen.extend(taken)
            time.sleep(0.02)
        # One last drain, so a message landing as the clock ran out is not lost
        # to a race the test would report as a missing feature.
        with lock:
            taken, incoming[:] = list(incoming), []
        out.extend(taken)
        seen.extend(taken)
        return out

    failures = []

    def check(condition, description):
        if condition:
            print(f"  ok    {description}")
        else:
            print(f"  FAIL  {description}")
            failures.append(description)

    try:
        opening = pump(6)
        init = next((m for m in opening if m.get("t") == "init"), None)
        check(init is not None, "the handshake arrives")
        if init is None:
            sys.exit("no handshake; stderr was:\n" + process.stderr.read())
        check(init.get("protocol") == 4, f"protocol is 4 (got {init.get('protocol')})")
        check(
            init.get("workspace") == os.path.realpath(workspace)
            or os.path.normcase(init.get("workspace", "")) == os.path.normcase(os.path.realpath(workspace)),
            f"the workspace is the directory we started in ({init.get('workspace')})",
        )

        print("\nfiles")
        send({"v": 1, "t": "file_list", "path": ""})
        listing = pump(3)
        files = next((m for m in listing if m.get("kind") == "files"), None)
        check(files is not None, "file_list answers with ui(files)")
        if files:
            names = sorted(row["name"] for row in files["entries"])
            check("README.md" in names, f"the file is listed ({names})")
            check("backend" in names, "the directory is listed")
            check(files["path"] == "", "the root answers with the empty path")
            backend = next(r for r in files["entries"] if r["name"] == "backend")
            check(backend["type"] == "directory", "a directory row says directory")
            readme = next(r for r in files["entries"] if r["name"] == "README.md")
            check(readme["type"] == "file", "a file row says file")
            check(readme["path"] == "README.md", "the row's path is workspace-relative")

        send({"v": 1, "t": "file_list", "path": "backend"})
        nested = pump(3)
        sub = next((m for m in nested if m.get("kind") == "files"), None)
        check(sub is not None and sub["path"] == "backend", "a subdirectory normalises to `backend`")

        send({"v": 1, "t": "file_list", "path": "../../etc"})
        refused = pump(3)
        check(
            any(m.get("t") == "notice" and m.get("level") == "warn" for m in refused),
            "a path that escapes the workspace is refused with a notice",
        )

        print("\nfiles: reading")
        send({"v": 1, "t": "file_read", "path": "README.md"})
        read = pump(3)
        body = next((m for m in read if m.get("kind") == "file_read"), None)
        check(body is not None, "file_read answers with ui(file_read)")
        if body:
            check(body["content"] == "# probe\nline two\n", "the body comes back verbatim")
            check(body["total_lines"] == 2, f"the line count is the file's ({body['total_lines']})")
            check(body["artifact_id"].startswith("art_"), "the body is stored as an artifact")
            check(body["truncated"] is False, "a small file is not truncated")

        print("\nterminals")
        send({"v": 1, "t": "terminal_list"})
        empty = pump(3)
        termlist = next((m for m in empty if m.get("kind") == "terminals"), None)
        check(termlist is not None and termlist["terminals"] == [], "an empty workspace has no terminals")

        send({"v": 1, "t": "terminal_create"})
        created = pump(5)
        term = next((m for m in created if m.get("kind") == "terminal_created"), None)
        check(term is not None, "terminal_create answers with ui(terminal_created)")
        if term is None:
            for message in created:
                if message.get("t") == "notice":
                    print("      notice:", message.get("text"))
            sys.exit(1)

        row = term["terminal"]
        check(row["status"] == "running", f"the new terminal is running ({row['status']})")
        check(row["pid"] > 0, f"it has a real process id ({row['pid']})")
        check(row["cwd"] == "", "its cwd is the workspace root")
        check(bool(row["shell"]), f"it names its shell ({row['shell']})")
        check(row["cols"] == 80 and row["rows"] == 24, "the conventional default size applies")
        term_id = row["id"]

        send({"v": 1, "t": "terminal_list"})
        listed = pump(3)
        after = next((m for m in listed if m.get("kind") == "terminals"), None)
        check(after is not None and len(after["terminals"]) == 1, "the terminal is on the list")

        print("\nterminals: a real shell answers")
        marker = "PROTOCOL_PROBE_OK"
        command = f"echo {marker}\r\n" if os.name == "nt" else f"echo {marker}\n"
        send({"v": 1, "t": "terminal_input", "terminal_id": term_id, "data": command})
        output = ""
        deadline = time.time() + 25
        while time.time() < deadline and marker not in output:
            for message in pump(1):
                if message.get("kind") == "terminal_output":
                    output += message["data"]
        check(marker in output, "the shell's output comes back asynchronously")
        check(
            any(m.get("kind") == "terminal_output" for m in seen),
            "terminal_output is its own ui kind",
        )

        print("\nterminals: resize and kill")
        send({"v": 1, "t": "terminal_resize", "terminal_id": term_id, "cols": 120, "rows": 40})
        resize_notices = [m for m in pump(2) if m.get("t") == "notice" and m.get("code") == "terminal"]
        check(not resize_notices, f"a valid resize is accepted silently ({resize_notices})")

        send({"v": 1, "t": "terminal_kill", "terminal_id": term_id})
        killed = pump(6)
        exit_event = next((m for m in killed if m.get("kind") == "terminal_exit"), None)
        check(exit_event is not None, "terminal_kill produces a terminal_exit event")
        if exit_event:
            check(exit_event["reason"] == "killed", f"the reason says killed ({exit_event['reason']})")
            check(
                exit_event["terminal"]["status"] == "killed",
                "the row in the event says killed",
            )
            check(
                exit_event["exit_code"] is None,
                f"a killed shell reports no exit code ({exit_event['exit_code']})",
            )

        send({"v": 1, "t": "terminal_list"})
        final = pump(3)
        remaining = next((m for m in final if m.get("kind") == "terminals"), None)
        check(
            remaining is not None
            and len(remaining["terminals"]) == 1
            and remaining["terminals"][0]["status"] == "killed",
            "a ended terminal stays on the list, marked killed",
        )

        print("\nshutdown")
        send({"v": 1, "t": "shutdown"})
        try:
            process.wait(timeout=15)
            check(process.returncode == 0, f"the runtime exits cleanly ({process.returncode})")
        except subprocess.TimeoutExpired:
            process.kill()
            check(False, "the runtime exits when asked")

    finally:
        if process.poll() is None:
            process.kill()

    stderr = process.stderr.read()
    check("grep.missing_binary" not in stderr, "no `grep.missing_binary` in the log")

    print()
    if failures:
        print(f"{len(failures)} check(s) failed:")
        for item in failures:
            print(f"  - {item}")
        if stderr.strip():
            print("\nstderr:\n" + stderr)
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
