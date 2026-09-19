package builtin

import (
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// The two commands below are platform-dependent on purpose: a command whose
// termination is *refused* cannot be written with Go's own primitives, so each
// platform spells its own. What is under test is the tool's behaviour around a
// command that will not stop, not the operating system.

// stubbornCommand prints one line and then refuses to finish. The line is there so
// the same command serves both tests: the output it produced before the timeout has
// to survive, and the process has to still be alive when the kill arrives.
func stubbornCommand() string {
	if runtime.GOOS == "windows" {
		return "Write-Output 'partial output before the timeout'; Start-Sleep -Seconds 600"
	}
	return `echo partial output before the timeout; trap "" TERM; while :; do sleep 1; done`
}

func exitsAtOnceCommand() []string {
	if runtime.GOOS == "windows" {
		return []string{"powershell", "-NoProfile", "-Command", "exit 0"}
	}
	return []string{"/bin/sh", "-c", "exit 0"}
}

// TestAShellTimeoutDoesNotHangTheTurn is the regression for the half of this that
// could take the whole session down.
//
// The timeout path used to kill and then wait on `<-done` with no bound. On a machine
// where the kill is refused — a restricted token, an ACL, a sandbox, or simply a
// process that will not die — `cmd.Wait` need never return, so a command that ignores
// its timeout froze the turn with no way out: no error, no answer, and an interface
// still claiming to be working. The wait is bounded now, and the assertion that
// catches a regression is the **deadline on this test**: an unbounded reap does not
// finish within any of them.
func TestAShellTimeoutDoesNotHangTheTurn(t *testing.T) {
	workspace, err := tools.NewWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan tools.Result, 1)
	go func() { done <- runShell(workspace, stubbornCommand(), 1) }()

	select {
	case result := <-done:
		// Whatever the kill managed to achieve, the tool answered **and said which of
		// the three outcomes happened**. Claiming a termination that did not occur is
		// the other half of the old bug, so the outcomes have to stay distinguishable.
		//
		// All three are accepted rather than one, because which one happens depends on
		// the machine: the point of the test is that the message is one of the honest
		// ones and that the tool returned at all.
		outcomes := []string{
			"发出停止信号时它已经结束了", // ended on its own as the timeout fired
			"没有能确认它停下来了",    // the kill did not take, and it is still running
			"已终止（整棵进程树一起收）", // the kill worked
		}
		matched := false
		for _, outcome := range outcomes {
			if strings.Contains(result.Text, outcome) {
				matched = true
			}
		}
		if !matched {
			t.Errorf("the timeout reported none of the three honest outcomes:\n%s", result.Text)
		}
		if !strings.Contains(result.Text, "命令超过了") {
			t.Errorf("the result does not say the command timed out:\n%s", result.Text)
		}
		if _, ok := result.Audit["reaped"]; !ok {
			t.Errorf("the audit record does not say whether the process was reaped: %v", result.Audit)
		}
		if _, ok := result.Audit["kill_failed"]; !ok {
			t.Errorf("the audit record does not say whether the kill failed: %v", result.Audit)
		}
	case <-time.After(reapAfterKillSeconds*time.Second + 10*time.Second):
		// Ten seconds of slack over the bound itself, so a slow machine does not fail
		// this test — an unbounded wait does not finish within any of them.
		t.Fatal("the shell timeout never returned: the reap after the kill is unbounded again")
	}
}

// TestACommandThatEndedAtTheTimeoutIsNotReportedAsRefused covers the other
// observable outcome, deterministically.
//
// `sleep 2` with a one-second timeout is a command that has **finished on its own**
// by the time the timeout fires — not the same thing as a kill that worked, and the
// message says so. Without this branch the tool would have to guess from the kill's
// exit status, which is exactly what it cannot do: `taskkill` exits non-zero for a
// process that is already gone.
func TestACommandThatEndedAtTheTimeoutIsNotReportedAsRefused(t *testing.T) {
	workspace, err := tools.NewWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	command := "sleep 2"
	if runtime.GOOS == "windows" {
		command = "Start-Sleep -Seconds 2"
	}

	result := runShell(workspace, command, 1)

	if strings.Contains(result.Text, "没有能确认它停下来了") {
		t.Errorf("a command that ended by itself was reported as unstoppable:\n%s", result.Text)
	}
	if !strings.Contains(result.Text, "命令超过了") {
		t.Errorf("the result does not mention the timeout:\n%s", result.Text)
	}
}

// TestKillingNothingAtAllIsNotAFailure: the unstarted-process guard. An `exec.Cmd`
// with no process is a legal value on the paths that walk a list of jobs, and a panic
// there would land during shutdown, which is the worst moment for one.
func TestKillingNothingAtAllIsNotAFailure(t *testing.T) {
	if err := killProcessTree(&exec.Cmd{}); err != nil {
		t.Errorf("a command that never started reported %v", err)
	}
}

// TestTheTimeoutResultKeepsWhatTheCommandPrinted pins the part of the timeout path
// that is easy to lose while fixing the rest: the bytes the command managed to print
// before it was stopped are still handed to the model. A timeout is not a reason to
// throw away the diagnosis a failing command already wrote.
func TestTheTimeoutResultKeepsWhatTheCommandPrinted(t *testing.T) {
	workspace, err := tools.NewWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	result := runShell(workspace, stubbornCommand(), 1)
	if !strings.Contains(result.Text, "partial output before the timeout") {
		t.Errorf("the output printed before the timeout was dropped:\n%s", result.Text)
	}
}
