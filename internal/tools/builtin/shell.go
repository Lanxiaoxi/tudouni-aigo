package builtin

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// Shell limits. The default is overridable by the model (a slow command has no
// other way out), but the upper bound pins the worst case: without it, "let the
// model pick the timeout" is "let the session hang forever".
const (
	TIMEOUT_SECONDS     = 30
	MIN_TIMEOUT_SECONDS = 1
	MAX_TIMEOUT_SECONDS = 300
	MAX_OUTPUT_CHARS    = 8000
	// reapAfterKillSeconds bounds the wait **after** the kill, not the command. A
	// command that will not die must not take the turn with it: the alternative is an
	// interface that never comes back, on a machine where the user could otherwise
	// see the problem and kill the process by hand.
	reapAfterKillSeconds = 5
)

// NewShell builds the shell tool.
//
// hasJobs / hasFetch / hasSearch decide which cross-tool notes appear in the
// description. The note only names a tool that is actually registered, so a
// session without fetch_web never sees a description pointing at a tool its
// schema does not contain.
func NewShell(workspace *tools.Workspace, hasJobs, hasFetch, hasSearch bool) tools.Tool {
	desc := "在工作区目录下执行一条 shell 命令（" + shellName() + " 语法），返回输出和退出码。" +
		"命令是非交互的：需要输入时会立刻读到 EOF。" +
		"输出超过 " + strconv.Itoa(MAX_OUTPUT_CHARS) + " 字符会掐掉中间，头和尾都留着。" +
		"它不受文件工具那条路径限制 —— 命令能碰到工作区之外的路径。"
	if hasJobs {
		desc += "要起一个不会自己结束的东西（服务、watch），或者想让它跑着的时候同时干别的，" +
			"用 shell_background —— 那种命令在这里只会到点被掐掉。"
	}
	if hasFetch {
		desc += "网页不要用 curl / wget 这类命令去抓：读网页正文要用 fetch_web" +
			"（它的结果会标明「不可信内容」，curl 抓回来的不会）"
		if hasSearch {
			desc += "，搜关键词用 web_search。"
		} else {
			desc += "。"
		}
	}

	return tools.Tool{
		Name:        "shell",
		Description: desc,
		Risk:        security.RiskHigh,
		Schema: tools.ObjectSchema(map[string]any{
			"command": tools.StringSchema("要执行的命令", tools.MinLength(1)),
			"timeout_seconds": tools.IntSchema(
				"最多等这条命令多少秒。默认值只够 ls / git status 这种秒回的命令，装依赖、跑测试这类慢命令要显式调大",
				tools.Default(TIMEOUT_SECONDS),
				tools.Minimum(MIN_TIMEOUT_SECONDS),
				tools.Maximum(MAX_TIMEOUT_SECONDS),
			),
		}, "command"),
		Handler: func(ctx context.Context, args map[string]any) (tools.Result, error) {
			command, _ := args["command"].(string)
			timeout := TIMEOUT_SECONDS
			if v, ok := args["timeout_seconds"].(int); ok {
				timeout = v
			}
			return runShell(ctx, workspace, command, timeout), nil
		},
		ParallelSafe: false,
		Interactive:  false,
		CommandParam: "command",
	}
}

// runShell executes one command and never throws. A non-zero exit code is an
// ordinary result the model must read and reason about, not a tool fault.
//
// `ctx` is the turn's cancellation, and it is the whole reason this tool is
// usable for anything slow. Before it, "stop" was only noticed at the next step
// boundary, so a command with a 300-second ceiling had to be waited out — the
// interface looked hung while it was in fact listening. The stop now reaches the
// command itself.
func runShell(ctx context.Context, workspace *tools.Workspace, command string, timeoutSeconds int) tools.Result {
	argv := shellArgv(command)
	// CommandContext rather than Command, so a stop reaches the command at all.
	// Its default cancel is `Process.Kill` — the **direct child only** — which is
	// why Cancel is replaced below: `powershell -Command "npm test"` is a tree, and
	// killing the shell leaves node holding the port and the file locks while this
	// tool reports a termination that did not happen.
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = workspace.Root()

	// stdin from /dev/null so a command that reads input meets EOF at once
	// instead of blocking the session.
	if devNull, err := os.OpenFile(os.DevNull, os.O_RDONLY, 0); err == nil {
		cmd.Stdin = devNull
		defer devNull.Close()
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	// Put the child in its own process group (unix) so the kill can take the whole
	// tree rather than just the direct child. On Windows this is a no-op and
	// taskkill /T does the work. Either way killProcessTree is the only killer.
	setProcessGroup(cmd)

	// The kill, with its error kept under a lock rather than returned. `Cancel` runs
	// on the goroutine os/exec starts to watch the context, and the error it
	// produces is the fact the report needs — "did it actually stop" — so it is
	// stored where the reporting goroutine can read it without racing that watcher.
	var killMu sync.Mutex
	var killErr error
	kill := func() error {
		err := killProcessTree(cmd)
		killMu.Lock()
		killErr = err
		killMu.Unlock()
		return err
	}
	cmd.Cancel = kill

	// WaitDelay bounds the other half of the same problem, and it is not optional.
	// The child's descendants inherit the stdout pipe, so a command that has already
	// exited can still leave `Wait` blocked for ever on the copier goroutines that
	// never see EOF. The timer starts when Wait observes the exit, so this covers a
	// command that finished on its own as much as one that was killed.
	cmd.WaitDelay = reapAfterKillSeconds * time.Second

	if err := cmd.Start(); err != nil {
		return tools.TextResult(fmt.Sprintf("无法执行命令（环境问题，不是命令本身）：%s", err))
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	// reportStopped is the ending where the person stopped the turn.
	//
	// It is reached only from the branch where `Wait` has **already returned**, and
	// that is what lets it say the command stopped: a returned `Wait` means the
	// process was reaped, which is an observation rather than an intention. It also
	// means the output buffers have no writer left, so reading them here is safe.
	reportStopped := func(waitErr error) tools.Result {
		// The group, not just the child. On unix this reaches descendants that
		// outlived the direct child; on Windows it is a no-op against a pid that is
		// already gone, which is why the message below does not depend on it.
		kill()

		text := "命令被中断了（这一轮被停止），它没有跑完。\n命令：" + command + "\n"
		text += "已经确认它停下来了：这次没有留下东西在跑。\n"
		// `WaitDelay` expiring means os/exec gave up on the output pipes rather than
		// the command exiting on its own. The process is gone either way, but the
		// capture below may be short, and a reader who took a truncated capture for
		// the whole thing would draw a conclusion the command never produced.
		if errors.Is(waitErr, exec.ErrWaitDelay) {
			text += fmt.Sprintf("（它留下的某个子进程一直占着输出管道，等了 %d 秒后强制收尾"+
				" —— 下面的输出可能不完整。）\n", reapAfterKillSeconds)
		}
		text += "这次调用的结果不能当结论用：它没有跑完。\n"
		if body := combineShellOutput(stdout.String(), stderr.String()); body != "" {
			text += "它已经产出的输出：\n" + body
		}
		return tools.Result{
			Text: text,
			Audit: map[string]any{
				"exit_code":               -1,
				"reaped":                  true,
				tools.InterruptedAuditKey: true,
			},
		}
	}

	// reportTimeout is the ending where the command ran past its ceiling. The kill
	// has to be waited out here, and whether it worked is the fact that decides what
	// the message may claim.
	//
	// **What is reported is what was observed, not what was attempted.** These
	// statements used to be unconditional: the message said "terminated (the whole
	// process tree with it)" whether or not anything died, and the reap waited
	// forever. On a machine where the kill is denied — a restricted token, an ACL,
	// a sandbox — that combination told the model the command had stopped, left the
	// process holding its port and its files, and hung the turn on `<-done` with no
	// way out.
	//
	// So there are two checks and they answer different questions, in this order:
	//
	//  1. **was it already finished?** A command that ended in the moment between
	//     the timeout firing and the kill arriving is the outcome this wanted, and
	//     that is a fact this goroutine can see for itself.
	//  2. **did it actually die?** The reap tells us, and it is bounded. "The kill
	//     command failed" would be the wrong question: `taskkill` exits non-zero for
	//     a process that is already gone, and a process that died of the signal may
	//     not have been reaped yet. Whether it stopped is the fact that decides
	//     whether the message may claim it.
	reportTimeout := func() tools.Result {
		kill()
		finished, reaped := false, true
		select {
		case waitErr := <-done:
			// The result is not read: what matters is that `Wait` returned, because
			// that is the observation that nothing is left running.
			finished = true
			_ = waitErr
		case <-time.After(reapAfterKillSeconds * time.Second):
			reaped = false
		}

		killMu.Lock()
		killed := killErr
		killMu.Unlock()

		text := fmt.Sprintf("命令超过了 %d 秒。\n命令：%s\n", timeoutSeconds, command)
		switch {
		case finished:
			text += "发出停止信号时它已经结束了，所以这次超时没有留下任何东西在跑。\n"
		case !reaped:
			text += fmt.Sprintf("**没有能确认它停下来了**：停止信号发了 %d 秒后它还没退出"+
				"（%v）—— 它可能还在跑，也可能还占着端口或文件。\n"+
				"不要重复这条命令；先确认那个进程还在不在，必要时手动结束它"+
				"（清掉这个会话也可以，进程是它的子进程）。\n", reapAfterKillSeconds, killed)
		default:
			text += "已终止（整棵进程树一起收）。确实慢的命令可以把 timeout_seconds 调大" +
				fmt.Sprintf("（上限 %d 秒）再试一次；", MAX_TIMEOUT_SECONDS) +
				"但它本来就不结束的话，调大只是让人多等一会儿，先确认一下。\n"
		}
		audit := map[string]any{"exit_code": -1, "reaped": reaped, "kill_failed": killed != nil}
		if !reaped {
			audit["kill_failed"] = true
		}
		// The output is read **only once the process was reaped**. Until then the
		// goroutines copying the child's stdout and stderr are still writing into
		// these buffers, and reading them here would be a data race — with the reader
		// racing the writer for whatever partial bytes happened to be there, which is
		// worth nothing and is not what a timeout is for.
		if reaped {
			if body := combineShellOutput(stdout.String(), stderr.String()); body != "" {
				text += "它已经产出的输出：\n" + body
			}
		}
		return tools.Result{Text: text, Audit: audit}
	}

	select {
	case waitErr := <-done:
		if ctx.Err() != nil {
			return reportStopped(waitErr)
		}
		// The command exited but something it spawned kept the stdout pipe open, so
		// WaitDelay force-closed the pipes to let Wait return. The exit status is the
		// command's own and is reported as usual; the only thing that has to be said
		// is that the output may be short, because a reader that assumed the pipe
		// closed naturally would take a truncated capture for the whole thing.
		truncated := errors.Is(waitErr, exec.ErrWaitDelay)

		code := 0
		if waitErr != nil {
			var exitErr *exec.ExitError
			if asExit(waitErr, &exitErr) {
				code = exitErr.ExitCode()
			} else if !truncated {
				return tools.TextResult(fmt.Sprintf("无法执行命令（环境问题，不是命令本身）：%s", waitErr))
			}
		}
		body := combineShellOutput(stdout.String(), stderr.String())
		text := formatShellOutput(code, body)
		if truncated {
			text += fmt.Sprintf("\n（命令本身已经结束，但它留下的某个子进程还占着输出管道，"+
				"等了 %d 秒后强制收尾 —— 上面的输出可能不完整。）", reapAfterKillSeconds)
		}
		return tools.Result{
			Text:  text,
			Audit: map[string]any{"exit_code": code},
		}
	case <-time.After(time.Duration(timeoutSeconds) * time.Second):
		return reportTimeout()
	}
}

// asExit reports whether err is an *exec.ExitError, filling exitErr when so. A
// non-exit error (e.g. the binary failed to start) is treated as an environment
// problem above, not as a command result.
func asExit(err error, exitErr **exec.ExitError) bool {
	if e, ok := err.(*exec.ExitError); ok {
		*exitErr = e
		return true
	}
	return false
}

// combineShellOutput merges the two streams the way a terminal would: interleaved,
// not labelled. The exit code already carries the success signal.
func combineShellOutput(out, err string) string {
	if out != "" && err != "" && !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	return out + err
}

// formatShellOutput renders "exit code {n}" plus the body, or "(无输出)" when the
// command printed nothing — an empty string leaves the model unable to tell
// "succeeded" from "broke".
func formatShellOutput(code int, body string) string {
	if strings.TrimSpace(body) == "" {
		return fmt.Sprintf("退出码 %d\n(无输出)", code)
	}
	trimmed := strings.TrimRight(body, " \t\n\r\v\f")
	return fmt.Sprintf("退出码 %d\n%s", code, tools.Truncate(trimmed, MAX_OUTPUT_CHARS))
}
