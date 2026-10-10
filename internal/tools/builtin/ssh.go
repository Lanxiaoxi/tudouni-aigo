package builtin

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	sshlib "github.com/Lanxiaoxi/tudouni-aigo/internal/ssh"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// MaxReadOutputChars bounds what one `ssh_read` puts in front of the model.
//
// It is the same ceiling `shell` uses and it exists for the same reason: a tool
// result is replayed on every later turn, so a command that printed a build log
// would be paid for again and again. The difference from `shell` is that nothing
// is thrown away — the bytes stay in the session's buffer, and the text says how
// to get the rest — which is why the number can be a display limit here rather
// than a lossy one.
const MaxReadOutputChars = 8000

// NewSSHTools builds the five tools that drive remote sessions.
//
// **They are one function rather than five** because they share the manager, and a
// caller that assembled them separately could mount `ssh_write` without
// `ssh_sessions` — leaving a model that has lost track of its session ids with no
// way to find them, which is the failure `ssh_sessions` exists to prevent.
//
// A nil manager returns no tools at all. That is the same rule
// `builtin.CreateRegistry` follows for every other optional capability: a tool the
// model can see but that can never work costs a round trip every time it is tried,
// and teaches it that tools lie.
func NewSSHTools(manager *sshlib.Manager) []tools.Tool {
	if manager == nil {
		return nil
	}
	return []tools.Tool{
		newSSHConnect(manager),
		newSSHWrite(manager),
		newSSHRead(manager),
		newSSHClose(manager),
		newSSHSessions(manager),
	}
}

// newSSHConnect builds `ssh_connect`.
//
// Risk is **high** and it is not parallel-safe, and both are the point rather than
// caution: this call is the one that decides which machine the agent may run
// commands on for the rest of the session, and the approval a person gives here
// covers every command that follows. Letting it run beside other calls in one
// batch would mean the batch's other tools could write to a session created in the
// same breath — before anybody had seen the host it points at.
func newSSHConnect(manager *sshlib.Manager) tools.Tool {
	return tools.Tool{
		Name: "ssh_connect",
		Description: "登录一台远程主机，启一个**持续存在**的交互式 shell，返回 session_id。" +
			"此后用 ssh_write / ssh_read 在这个会话里连续操作 —— 工作目录、环境变量、shell 状态都保留，" +
			"这和 shell 工具跑一条本地命令是两回事。\n" +
			"`host` 写你在 `~/.ssh/config` 里的 Host 名字（alias），也可以写 `user@host` 或直接写主机名；" +
			"主机名、端口、用户、私钥都从那份配置里读，这里不重复配置。\n" +
			"**这是一次授权**：批准之后，这个会话上后续的命令不再逐条审批。" +
			"所以审批面板上显示的是解析出来的 `user@host:port` —— 看清楚连的是哪一台。\n" +
			"连不上时常见原因：主机不在 known_hosts 里（先用 `ssh` 连一次记下来）、" +
			"私钥有 passphrase（一期不支持）、配置里写了 ProxyJump（一期不支持，会明确报错）。",
		Risk: security.RiskHigh,
		Schema: tools.ObjectSchema(map[string]any{
			"host": tools.StringSchema("`~/.ssh/config` 里的 Host 名字，或 `user@host`，或一个主机名", tools.MinLength(1)),
			"cols": tools.IntSchema("远程 PTY 的列数，默认 80", tools.Default(sshlib.DefaultCols), tools.Minimum(1), tools.Maximum(1000)),
			"rows": tools.IntSchema("远程 PTY 的行数，默认 24", tools.Default(sshlib.DefaultRows), tools.Minimum(1), tools.Maximum(1000)),
			"timeout_seconds": tools.IntSchema(
				fmt.Sprintf("连接（含握手与认证）最多等多少秒，默认 %d，上限 %d",
					sshlib.DefaultConnectTimeoutSeconds, sshlib.MaxConnectTimeoutSeconds),
				tools.Default(sshlib.DefaultConnectTimeoutSeconds),
				tools.Minimum(1), tools.Maximum(sshlib.MaxConnectTimeoutSeconds)),
		}, "host"),
		Handler: func(ctx context.Context, args map[string]any) (tools.Result, error) {
			alias := strings.TrimSpace(stringArg(args, "host"))
			cols, rows := intArg(args, "cols", sshlib.DefaultCols), intArg(args, "rows", sshlib.DefaultRows)
			timeout := time.Duration(intArg(args, "timeout_seconds", sshlib.DefaultConnectTimeoutSeconds)) * time.Second

			info, err := manager.Connect(alias, cols, rows, timeout)
			if err != nil {
				// A failure is a **result**, not a thrown error: the model has to
				// read it and decide what else to try, and the audit still needs to
				// record that an attempt happened and why it stopped.
				return tools.Result{
					Text: "连接失败，没有建立会话。\n" + err.Error(),
					Audit: map[string]any{
						"session_action": "connect",
						"alias":          alias,
						"connected":      false,
						"status":         "error",
					},
				}, nil
			}

			text := fmt.Sprintf("已连接：%s（会话 %s）。\n", info.Destination(), info.ID)
			if info.Alias != "" && info.Alias != info.HostName {
				text += fmt.Sprintf("（你写的是 %q，配置把它指向了 %s。）\n", info.Alias, info.HostName)
			}
			text += fmt.Sprintf("终端大小 %dx%d。用 ssh_write(%s, ...) 发命令，用 ssh_read(%s) 读输出。\n",
				info.Cols, info.Rows, info.ID, info.ID)
			text += "命令跑完的信号：在命令后面接 `; echo __DONE_$?__`，读到这一行就说明跑完了，同时能拿到退出码 —— " +
				"runtime 不做提示符识别，读到的字节流不会自己告诉你「命令结束了」。\n"
			text += fmt.Sprintf("同一时间最多 %d 个会话，硬存活上限 %s；用完请 ssh_close。",
				sshlib.MaxSessions, sshlib.SessionLifetime)

			warnings := manager.ConfigWarnings(alias)
			if len(warnings) > 0 {
				text += "\n\n这份 ssh 配置里有些东西这个程序没有应用（连接本身不受影响）：\n  - " +
					strings.Join(warnings, "\n  - ")
			}

			return tools.Result{
				Text: text,
				Audit: map[string]any{
					"session_action": "connect",
					"session_id":     info.ID,
					"alias":          info.Alias,
					"user":           info.User,
					"host":           info.HostName,
					"port":           info.Port,
					"destination":    info.Destination(),
					"connected":      true,
					"warnings":       warnings,
				},
			}, nil
		},
		ParallelSafe: false,
	}
}

// newSSHWrite builds `ssh_write`.
//
// **Risk is low, and that is a decision rather than an oversight.** The approval
// this call would otherwise raise was already given for the whole session at
// `ssh_connect`, where the host was named and the person was told that commands
// after it would not be asked about again. Making each write ask a second time
// would not add a decision anybody wants to make — the useful moment to say no is
// before the session exists — and it would make an interactive prompt impossible
// to answer, since replying to a password prompt is itself a write.
//
// What replaces the per-call prompt is the audit record: every write's bytes go
// into `Result.Audit`, so "what was actually typed on that host" has an answer
// afterwards even though nobody was asked at the time. The tool is deliberately
// **not** registered as a command-carrying tool: prefix rules match on the first
// tokens of a command, and `ssh_write` sends raw bytes to an already-open shell,
// which is not a command line this program ever sees.
func newSSHWrite(manager *sshlib.Manager) tools.Tool {
	return tools.Tool{
		Name: "ssh_write",
		Description: "往一个 SSH 会话里写入原始字节：命令、换行、控制字符都直接发过去，**不做任何解析**。" +
			"换行自己带（命令末尾写 `\\n`）；`\\u0003` 是 Ctrl+C，`\\u0004` 是 Ctrl+D。\n" +
			"它返回「已写入」，**不是「命令成功了」** —— 结果要靠 ssh_read 读出来判断。\n" +
			"写完立刻读：`ssh_read` 会等到有输出或超时，所以标准写法是 write 一条命令、read 到 `__DONE_$?__`、" +
			"再决定下一步。交互式提示（密码、确认 y/n）也能这样回答。",
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"session_id": tools.StringSchema("ssh_connect 返回的会话 id", tools.MinLength(1)),
			"data":       tools.StringSchema("要写入的原始字节。命令记得以 \\n 结尾；Ctrl+C 写 \\u0003"),
		}, "session_id", "data"),
		Handler: func(ctx context.Context, args map[string]any) (tools.Result, error) {
			id := stringArg(args, "session_id")
			data := stringArg(args, "data")
			if err := manager.Write(id, data); err != nil {
				return tools.Result{
					Text: "写入失败：" + err.Error(),
					Audit: map[string]any{
						"session_action": "write",
						"session_id":     id,
						"status":         "error",
					},
				}, nil
			}
			return tools.Result{
				Text: fmt.Sprintf("已写入会话 %s %d 字节。这**不代表命令执行成功** —— 用 ssh_read(%s) 读输出再判断。",
					id, len([]rune(data)), id),
				Audit: map[string]any{
					"session_action": "write",
					"session_id":     id,
					// The bytes themselves, so "what was typed on that host" is
					// answerable afterwards. See this tool's constructor for why
					// nothing else asks about a write.
					"data":   data,
					"bytes":  len(data),
					"status": "ok",
				},
			}, nil
		},
		ParallelSafe: true,
	}
}

// newSSHRead builds `ssh_read`.
//
// Risk is low and it is parallel-safe, which is a statement about this call alone:
// reading drains a buffer the session owns, and two reads of **one** session would
// split the output between them. That hazard is handled where it belongs — the
// tool is withheld from delegated subagents, which is the only way two agents can
// reach one session — rather than by making every read serial against every other
// tool in the batch.
func newSSHRead(manager *sshlib.Manager) tools.Tool {
	return tools.Tool{
		Name: "ssh_read",
		Description: "从一个 SSH 会话里读输出，**没有输出就等**，直到有输出、超时、或会话结束。\n" +
			"返回里有几个必须看清的字段：`truncated` 说明这次没读完、还要再读一次；" +
			"`exited` / `exit_code` 说明会话结束了以及远端命令的退出码（没有退出码是可报告的事实，" +
			"和 0 不是一回事）；`eof` 才是「真的没东西了」。`timed_out` 表示这段时间它一个字都没打印 —— " +
			"这对一条跑很久的命令是正常答案，不是失败。\n" +
			"它一次最多返回 16KB，超出会截断并标 `truncated: true`，接着读就能拿剩下的。\n" +
			"**它不判断命令是否跑完**：请让命令自己发出信号，例如 `cmd; echo __DONE_$?__`，读到标记即完成。",
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"session_id": tools.StringSchema("ssh_connect 返回的会话 id", tools.MinLength(1)),
			"timeout_seconds": tools.IntSchema(
				fmt.Sprintf("最多等多少秒（默认 %d，上限 %d）。它在等的过程中可以被「停止」打断，打断不会丢输出",
					sshlib.DefaultReadTimeoutSeconds, sshlib.MaxReadTimeoutSeconds),
				tools.Default(sshlib.DefaultReadTimeoutSeconds),
				tools.Minimum(1), tools.Maximum(sshlib.MaxReadTimeoutSeconds)),
		}, "session_id"),
		Handler: func(ctx context.Context, args map[string]any) (tools.Result, error) {
			id := stringArg(args, "session_id")
			seconds := intArg(args, "timeout_seconds", sshlib.DefaultReadTimeoutSeconds)
			result, err := manager.Read(ctx, id, sshlib.DefaultReadLimit, time.Duration(seconds)*time.Second)
			if err != nil {
				return tools.Result{
					Text: "读取中断：" + err.Error() + "\n（输出没有丢，还在会话缓冲里，再调一次 ssh_read 就能拿到。）",
					Audit: map[string]any{
						"session_action": "read",
						"session_id":     id,
						"status":         "interrupted",
					},
				}, nil
			}
			return tools.Result{
				Text:  renderSSHRead(id, result),
				Audit: sshReadAudit(id, result),
			}, nil
		},
		ParallelSafe: true,
	}
}

// newSSHClose builds `ssh_close`.
func newSSHClose(manager *sshlib.Manager) tools.Tool {
	return tools.Tool{
		Name: "ssh_close",
		Description: "关闭一个 SSH 会话，释放远端连接。对已经结束的会话是幂等的（不报错）。\n" +
			"**用完就关**：一次最多同时开 " + strconv.Itoa(sshlib.MaxSessions) + " 个会话，" +
			"不关的话下一次 ssh_connect 会被拒。关掉之后它的输出和退出码也没了 —— 那之前先确认你已经读到了需要的东西。",
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"session_id": tools.StringSchema("要关闭的会话 id", tools.MinLength(1)),
		}, "session_id"),
		Handler: func(ctx context.Context, args map[string]any) (tools.Result, error) {
			id := stringArg(args, "session_id")
			before, _ := findSession(manager, id)
			if err := manager.Close(id); err != nil {
				return tools.Result{
					Text: "关闭失败：" + err.Error(),
					Audit: map[string]any{
						"session_action": "close",
						"session_id":     id,
						"status":         "error",
					},
				}, nil
			}
			text := "已请求关闭会话 " + id + "。"
			if before != nil && before.Status != sshlib.StatusRunning {
				text = "会话 " + id + " 本来就已结束，这次调用没有额外动作。"
			}
			return tools.Result{
				Text: text,
				Audit: map[string]any{
					"session_action": "close",
					"session_id":     id,
					"status":         "ok",
				},
			}, nil
		},
		ParallelSafe: true,
	}
}

// newSSHSessions builds `ssh_sessions`.
//
// It is not a convenience. Without it a model that has lost a session id has no
// way to recover it — and the session limit means it cannot simply open another,
// so the two facts together would leave it stuck with a tool it can no longer use.
func newSSHSessions(manager *sshlib.Manager) tools.Tool {
	return tools.Tool{
		Name: "ssh_sessions",
		Description: "列出这个工作区里所有的 SSH 会话：id、`user@host:port`、状态（running / exited / killed / timed_out）、" +
			"活跃了多久、以及结束的话退出码是多少。**已经结束的会话也在这儿** —— 它们回答「我刚才在跑什么」，" +
			"清理掉要用 ssh_close。\n" +
			"忘了 session_id、或者不确定哪个还活着的时候先看这个。" +
			"同一时间最多 " + strconv.Itoa(sshlib.MaxSessions) + " 个在跑。",
		Risk:   security.RiskLow,
		Schema: tools.EmptySchema(),
		Handler: func(ctx context.Context, args map[string]any) (tools.Result, error) {
			infos := manager.List()
			return tools.Result{
				Text:  renderSSHSessionList(infos),
				Audit: map[string]any{"session_action": "list", "count": len(infos), "status": "ok"},
			}, nil
		},
		ParallelSafe: true,
	}
}

// findSession looks one session up in the list without failing when it is absent.
func findSession(manager *sshlib.Manager, id string) (*sshlib.Info, bool) {
	for _, info := range manager.List() {
		if info.ID == id {
			found := info
			return &found, true
		}
	}
	return nil, false
}

// sshReadAudit records the facts the model cannot derive from the text.
//
// `exit_code` is written as a pointer or nil rather than as a number, because
// "there was no code" and "the code was 0" are different observations and a log
// that flattened them would make a killed session look like a clean exit. The
// design says the same thing about the row's own field; this is the same decision
// one layer up.
func sshReadAudit(id string, result sshlib.ReadResult) map[string]any {
	audit := map[string]any{
		"session_action": "read",
		"session_id":     id,
		"chars":          len([]rune(result.Output)),
		"truncated":      result.Truncated,
		"exited":         result.Exited,
		"eof":            result.EOF,
		"timed_out":      result.TimedOut,
		"dropped":        result.Dropped,
		"status":         "ok",
	}
	if result.ExitCode == nil {
		audit["exit_code"] = nil
	} else {
		audit["exit_code"] = *result.ExitCode
	}
	if result.Reason != "" {
		audit["reason"] = result.Reason
	}
	return audit
}

// renderSSHRead turns one read into the text the model acts on.
//
// The ordering is deliberate: the facts that decide **what to do next** come
// first, and the output last. A wall of build log at the top is how a `timed_out`
// flag goes unread and the model concludes a command failed when it was merely
// quiet.
func renderSSHRead(id string, result sshlib.ReadResult) string {
	var lines []string

	switch {
	case result.TimedOut:
		lines = append(lines, fmt.Sprintf("会话 %s：这段时间没有输出（会话仍在运行）。", id))
	case result.EOF:
		lines = append(lines, fmt.Sprintf("会话 %s 已结束，输出已经读完。", id))
	case result.Exited:
		lines = append(lines, fmt.Sprintf("会话 %s 已结束，但还有输出没读完 —— 继续 ssh_read 取剩下的。", id))
	}

	if result.Exited {
		if result.ExitCode != nil {
			lines = append(lines, fmt.Sprintf("结束原因：%s，远端退出码 %d。", result.Reason, *result.ExitCode))
		} else {
			lines = append(lines, fmt.Sprintf(
				"结束原因：%s，**没有退出码** —— 连接断了、或者被信号杀掉时不会有，这和「退出码 0」不是一回事。", result.Reason))
		}
	}
	if result.Dropped > 0 {
		lines = append(lines, fmt.Sprintf(
			"**注意：输出被丢弃过 %d 次**（读得太慢，缓冲满了丢的是旧内容，`[output dropped]` 标记就是缺口）。"+
				"你看到的内容可能有中断，不要假设它是连续的。", result.Dropped))
	}
	if result.Truncated {
		lines = append(lines, "这次没读完（`truncated`），立刻再调一次 ssh_read 拿剩下的。")
	}

	body := result.Output
	if strings.TrimSpace(body) == "" {
		lines = append(lines, "(没有输出)")
	} else {
		runeCount := len([]rune(body))
		if runeCount > MaxReadOutputChars {
			lines = append(lines, fmt.Sprintf("输出 %d 字符，这里掐掉中间只留头尾；完整内容还在会话缓冲里，按需再读。",
				runeCount))
			body = tools.Truncate(body, MaxReadOutputChars)
		}
		lines = append(lines, "输出：", body)
	}
	return strings.Join(lines, "\n")
}

// renderSSHSessionList renders every session for `ssh_sessions`.
func renderSSHSessionList(infos []sshlib.Info) string {
	if len(infos) == 0 {
		return "这个工作区里没有 SSH 会话。用 ssh_connect 建一个。"
	}
	var lines []string
	alive := 0
	for _, info := range infos {
		if info.Status == sshlib.StatusRunning {
			alive++
		}
		line := fmt.Sprintf("- %s  %s  %s", info.ID, info.Destination(), info.Status)
		switch {
		case info.Status == sshlib.StatusRunning:
			line += "  （在用）"
		case info.ExitCode != nil:
			line += fmt.Sprintf("  退出码 %d", *info.ExitCode)
		default:
			line += "  没有退出码"
		}
		if info.Alias != "" && info.Alias != info.HostName {
			line += fmt.Sprintf("   [别名 %s]", info.Alias)
		}
		lines = append(lines, line)
	}
	header := fmt.Sprintf("%d 个会话，其中 %d 个还在跑（上限 %d 个在跑）。结束的会话用 ssh_close 清掉。",
		len(infos), alive, sshlib.MaxSessions)
	return header + "\n" + strings.Join(lines, "\n")
}
