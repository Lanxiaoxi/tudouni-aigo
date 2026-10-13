package protocol

import (
	"io"
	"os"
	"os/exec"
)

// LocalBackend starts the runtime as a child process on this machine, using
// stdio to carry the protocol.
//
// This is exactly the launch Client.Start always performed, moved behind the
// Backend seam without changing one of its details — see the three points in the
// type doc of Backend and the original comment this carried on Client.Start:
//
//  1. the **absolute path to this same executable**, not "tudouni" off PATH;
//  2. `--runtime-stdio`, the mode that speaks this protocol;
//  3. the working directory is inherited, which is what makes the workspace the
//     directory the user started in.
//
// Nothing about local, in-process front ends (the TUI, the CLI) changes: this
// type is reached through Client.Start, which builds one and discards it after
// use, exactly as the inline exec.Cmd used to be built and discarded.
type LocalBackend struct {
	Arguments []string

	command *exec.Cmd
}

// NewLocalBackend builds a backend that launches this executable with the given
// extra arguments, ahead of the mandatory `--runtime-stdio`.
func NewLocalBackend(arguments []string) *LocalBackend {
	return &LocalBackend{Arguments: arguments}
}

// Start launches the child and returns its stdio.
func (b *LocalBackend) Start() (io.WriteCloser, io.Reader, io.Reader, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, nil, nil, err
	}
	argv := append([]string{executable, "--runtime-stdio"}, b.Arguments...)
	command := exec.Command(argv[0], argv[1:]...)
	command.Env = os.Environ()

	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, nil, nil, err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, nil, nil, err
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		return nil, nil, nil, err
	}
	if err := command.Start(); err != nil {
		return nil, nil, nil, err
	}

	b.command = command
	return stdin, stdout, stderr, nil
}

// Wait blocks until the child exits and reports its exit code.
func (b *LocalBackend) Wait() (int, bool, error) {
	if b.command == nil {
		return 0, false, nil
	}
	err := b.command.Wait()
	if b.command.ProcessState == nil {
		return 0, false, err
	}
	// A process killed by a signal reports no exit code through ExitCode (it
	// returns -1); the caller still gets ok=true with -1 rather than a
	// fabricated 0, which is the same convention the original inline Wait used.
	return b.command.ProcessState.ExitCode(), true, nil
}

// Kill ends the child process without waiting for it.
func (b *LocalBackend) Kill() error {
	if b.command == nil || b.command.Process == nil {
		return nil
	}
	return b.command.Process.Kill()
}

// Close is a no-op for a local child: nothing is held beyond the process
// itself, which Wait or Kill already account for.
func (b *LocalBackend) Close() error { return nil }
