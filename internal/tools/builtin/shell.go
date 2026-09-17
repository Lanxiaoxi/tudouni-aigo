package builtin

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
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
		Handler: func(args map[string]any) (tools.Result, error) {
			command, _ := args["command"].(string)
			timeout := TIMEOUT_SECONDS
			if v, ok := args["timeout_seconds"].(int); ok {
				timeout = v
			}
			return runShell(workspace, command, timeout), nil
		},
		ParallelSafe: false,
		Interactive:  false,
		CommandParam: "command",
	}
}

// runShell executes one command and never throws. A non-zero exit code is an
// ordinary result the model must read and reason about, not a tool fault.
func runShell(workspace *tools.Workspace, command string, timeoutSeconds int) tools.Result {
	argv := shellArgv(command)
	cmd := exec.Command(argv[0], argv[1:]...)
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

	// Put the child in its own process group (unix) so a timeout can kill the
	// whole tree, not just the direct child.
	setProcessGroup(cmd)

	if err := cmd.Start(); err != nil {
		return tools.TextResult(fmt.Sprintf("无法执行命令（环境问题，不是命令本身）：%s", err))
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	select {
	case waitErr := <-done:
		code := 0
		if waitErr != nil {
			var exitErr *exec.ExitError
			if asExit(waitErr, &exitErr) {
				code = exitErr.ExitCode()
			} else {
				return tools.TextResult(fmt.Sprintf("无法执行命令（环境问题，不是命令本身）：%s", waitErr))
			}
		}
		body := combineShellOutput(stdout.String(), stderr.String())
		return tools.Result{
			Text:  formatShellOutput(code, body),
			Audit: map[string]any{"exit_code": code},
		}
	case <-time.After(time.Duration(timeoutSeconds) * time.Second):
		// Kill the process tree, then reap so the child does not become a zombie.
		killProcessTree(cmd)
		<-done
		text := fmt.Sprintf("命令超过了 %d 秒，已终止（整棵进程树一起收）。\n命令：%s\n"+
			"确实慢的命令可以把 timeout_seconds 调大（上限 %d 秒）再试一次；"+
			"但它本来就不结束的话，调大只是让人多等一会儿，先确认一下。",
			timeoutSeconds, command, MAX_TIMEOUT_SECONDS)
		return tools.Result{
			Text:  text,
			Audit: map[string]any{"exit_code": -1},
		}
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
