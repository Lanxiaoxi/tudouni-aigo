// Package process knows only the operating-system layer: how to start a child
// process we must later reap ourselves, and how to kill its whole tree.
//
// The two callers (background jobs and the MCP server) ask the same question:
// once I stop caring about this thing, how do I guarantee it is actually dead?
// A single kill is not enough — a shell command spawns layers of children, and
// leaving them is how orphan processes that hold ports and output files are born.
//
// On POSIX the child is placed in its own session/group so the group can be
// signalled at once; on Windows it is put into a job object that the OS tears
// down when this process dies, plus taskkill /T for the explicit kill.
package process

import (
	"os"
	"os/exec"
	"path/filepath"
)

// Start launches a long-lived child process and redirects its stdout and stderr
// to outputPath, returning it for later reaping. It is meant for processes the
// caller owns for the whole session, so the child is isolated in its own
// session/group (POSIX) or job object (Windows) and can be killed as a tree.
//
// Both streams go to the same file, the way a terminal would interleave them,
// and stdin is /dev/null so a command that reads input meets EOF instead of
// hanging the session.
func Start(argv []string, cwd, outputPath string) (*exec.Cmd, error) {
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return nil, err
	}
	// Open the sink before starting; the child duplicates the handle into its own
	// process, so the parent copy can be closed once it is running with no effect
	// on the child's output.
	sink, err := os.OpenFile(outputPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = cwd
	// A nil stdin is /dev/null: a command that reads input meets EOF instead of
	// hanging the session waiting for a terminal that is not there.
	cmd.Stdin = nil
	cmd.Stdout = sink
	cmd.Stderr = sink
	cmd.SysProcAttr = startSysProcAttr()
	if err := cmd.Start(); err != nil {
		sink.Close()
		return nil, err
	}
	sink.Close()
	assignToJob(cmd)
	return cmd, nil
}
