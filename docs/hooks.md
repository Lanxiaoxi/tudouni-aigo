# Hooks：用一个脚本拦截、改写或补充每一次工具调用

hooks 是你自己的脚本，runtime 在固定的几个时机执行它们：会话开始、你的消息进入会话之前、
每次工具调用之前和之后、有人要审批的时候、一轮答完的时候、会话结束。脚本用 stdin 读一个
JSON、往 stdout 写最多一个 JSON，就能**拒绝**一次调用、**追问**一次、**改写**它的参数、
或者给模型补一句上下文。

写在 `~/.tudouni/hooks.json`（Windows 是 `C:\Users\<你>\.tudouni\hooks.json`）。
改完这个文件**要新开会话**才生效——runtime 打开时读一次，不会热重载。

> 本文面向写 hook 的人。想知道这个功能为什么长这样、每条规则背后的取舍，读
> [design/hooks.md](design/hooks.md)（实现记录，长）。

---

## 五分钟：拦截 `rm -rf`

`~/.tudouni/hooks.json`：

```jsonc
{
  "version": 1,
  "hooks": {
    "pre_tool_use": [
      {
        "name": "no-rm-rf",
        "matcher": "shell",
        "command": ["python", "C:/tools/hooks/guard.py"]
      }
    ]
  }
}
```

`guard.py`：

```python
import json, sys

# stdin 是一个 JSON 对象，一次写完并关闭。读完就退出，不要读第二次。
event = json.load(sys.stdin)

if event["hook_event_name"] != "pre_tool_use":
    sys.exit(0)

command = (event.get("tool_input") or {}).get("command", "")

if "rm -rf" in command:
    # stdout 写一个 JSON。deny 必须带 reason —— 它是模型读到的句子。
    print(json.dumps({
        "decision": "deny",
        "reason": "refusing a filesystem-wide delete",
    }))
    sys.exit(0)

# 空输出 + exit 0 = "没有意见"。这是最常见的一种 hook：只看看，顺便干点别的。
print(json.dumps({"decision": "none"}))
```

`command` 推荐写 **argv 数组**（上面这样）。写成一个字符串也行，Windows 上走
`cmd /c <字符串>`、Linux 上走 `/bin/sh -c <字符串>`——但引号规则是两套，argv 没这个问题。

`--hooks` 可以随时确认现在装了什么：

```
tudouni-aigo --hooks
```

---

## 事件：什么时候会执行你的脚本

一个 hook 挂在某个**事件**上。同一个事件配多个 hook 时，按文件里的顺序串行执行。

| 事件 | 触发时机 | 能否阻断 | stdin 里的额外字段 |
| --- | --- | --- | --- |
| `session_start` | runtime 组装完、第一次请求之前 | 否 | `source`（`startup`/`resume`）、`model`、`provider` |
| `user_prompt_submit` | 你的消息进入会话**之前** | **能**（拒绝则这一轮根本不开始） | `prompt` |
| `pre_tool_use` | 工具参数解析成功之后、权限判定之前 | **能** | `tool_name`、`tool_input`、`tool_risk`、`tool_call_id` |
| `post_tool_use` | 一批工具调用全部结算完 | 否 | 同上 + `tool_status`、`tool_result`、`duration_ms`、`truncated` |
| `permission_request` | 权限系统**正要问人**的时候 | **能**（替人回答） | 同 pre_tool_use + `policy_decision` |
| `stop` | 一轮正常答完、返回之前 | **能**（`block` = 再来一轮） | `stop_reason`、`last_assistant_message`、`autonomous` |
| `session_end` | 会话关闭、审计日志关掉之前 | 否 | `reason`（`shutdown`/`switch`） |
| `subagent_start` | 子代理真正运行之前 | **能**（拒绝这次委派） | `model`、`provider`、`background`、`task_chars` |
| `subagent_stop` | 子代理结算完 | 否 | `stop_reason`、`usage` |
| `pre_compact` | 历史压缩、生成摘要之前 | 否 | `fold_point`、`messages`、`before` |

公共字段每个事件都有：

```jsonc
{
  "hook_event_name": "pre_tool_use",
  "session_id": "ses_...",
  "run_id": "run-...",
  "step": 3,
  "cwd": "C:/work/my-project",
  "workspace": "C:/work/my-project",
  "mode": "interactive",          // 或 "autopilot"
  "autopilot": false,
  "hook_name": "no-rm-rf",        // 你配的 name
  "subagent": null                // 在子代理里是 {"id": ..., "depth": ..., "label": ...}
}
```

信封里**没有** API key、没有环境变量、没有配置路径。要读文件自己去读。

环境变量只给这些：`PATH`、`HOME`/`USERPROFILE`、`TMP`/`TEMP`、`SystemRoot`、`LANG`，
加上 `TUDOUNI_HOOK_EVENT`、`TUDOUNI_HOOK_NAME`、`TUDOUNI_WORKSPACE`、`TUDOUNI_SESSION_ID`、
`TUDOUNI_MODE`。这是有意的：配置文件里有 API key，环境变量是唯一会无声泄漏它的通道。

---

## stdout 契约：怎么回答

**stdin**：一个 JSON 对象，写完就关。hook 不许读 TTY。

**stdout**：最多一个 JSON 对象。**空输出 + exit 0 = "没有意见"**——很多 hook 就是这样：
看看，不投票。

```jsonc
{
  "decision": "allow",
  "reason": "read-only command",
  "updated_input": { "command": "git status --short" },
  "additional_context": "This repository uses pnpm; do not run npm install.",
  "system_message": "formatted 3 files"
}
```

| 字段 | 哪些事件接受 | 说明 |
| --- | --- | --- |
| `decision` | `pre_tool_use`、`user_prompt_submit`、`permission_request`、`stop`、`subagent_start` | `allow` / `ask` / `deny` / `block` / `none`。`block` 是 `deny` 的别名；在 `stop` 上它表示"再来一轮"。**拼错是错误**，不会被当成"没意见" |
| `reason` | 有 `decision` 的事件 | 给模型/人看的句子。**`deny` 必须带**，否则整个输出按坏输出处理 |
| `updated_input` | 只有 `pre_tool_use` | 改写参数。对象递归合并、数组整体替换、`null` 删除该键 |
| `additional_context` | `session_start`、`user_prompt_submit`、`post_tool_use`、`pre_compact` | 追加到请求尾部的文字。**不进会话历史** |
| `system_message` | 任意 | 给人看的一句话，进 `--debug`/通知，模型看不到 |

未知字段**忽略**（向前兼容），未知 `decision` **报错**。

**`stop` 的边界**：`block` 会被接受，但一个自动轮（goal round，`autonomous: true`）里它被
忽略——续轮权属于 goal driver，一个 hook 不能和它抢。续轮有上限（一轮最多 3 次）。

**`autopilot`（`--autopilot` 或子代理）里没有"问人"这条路**：你返回 `ask` 会被当作拒绝。

**退出码**：

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功，解析 stdout |
| `2` | 阻断。stderr 的前 2 KiB 作为拒绝原因（和其它 CLI 的约定一致） |
| 其它非 0 / 超时 / 坏 JSON / 输出超上限 / 起不来 | 失败 |

**失败时怎么办**由 `fail_closed` 决定：`pre_tool_use` 和 `permission_request` 默认
**true**（拒绝这次调用），其余默认 **false**（只记录，一轮对话照常走）。可以逐 hook 覆盖。

---

## 多个 hook 怎么聚合

同一个事件配了多个 hook 时，规则是写死的：

1. 按配置顺序**串行**。后一个 hook（`pre_tool_use`）看到的是前一个 `updated_input`
   改完之后的结果——两个改写器会叠加，而不是互相覆盖。
2. 第一个 `deny` **短路**：后面的不再执行（审计里记 `skipped`）。
3. `ask` 是**粘性**的：只要有一个 `ask`，最终就不会自动放行。后面的 `allow` 翻不掉它。
4. 都是 `allow`/`none` 时，最终是 `allow`。`none` 不投票——**只观察的 hook 永远不会
   因为"它也在场"而放行什么**。
5. 失败且 `fail_closed: true` → 按 `deny` 处理，原因写明哪个 hook、怎么败的。

---

## 和权限系统的先后

hooks 接在权限系统**旁边**，不替代它。从上到下，先命中先赢：

1. `permissions.json` 的 `deny_tools` → 拒绝（`policy_denied`）
2. `pre_tool_use` 返回 `deny` → 拒绝（`hook_denied`）
3. `pre_tool_use` 返回 `ask` → 强制问人；autopilot 或无人可问 → 拒绝
4. autopilot 开 → 放行
5. `permissions.json` 的 `auto_approve`（风险等级）→ 放行
6. 记住的整工具规则 / 命令前缀规则 → 放行
7. `pre_tool_use` 返回 `allow` → **跳过问人**（`hook_allowed`）
8. `permission_request` 返回 `allow`/`deny` → 替人回答
9. 问人

读法：**hook 的 `allow` 不能覆盖"这个工具被明确禁止"**——那是"不可以"，不是"不必问"。
hook 的 `allow` 只补上"还没记住、但这次可以"。它排在记住的规则之后，因为审计应该记更
长期、更具体的那个理由。

改写过的参数**不会豁免**：仍然走同一个工作区边界和同一次权限判定。改写后不合法的参数
以 `invalid_args` 回给模型，且**不回退**到原参数——回退会让模型以为改写生效了。

---

## 配置文件

```jsonc
{
  "version": 1,                          // 必填，必须是 1
  "defaults": {
    "timeout_ms": 5000,                  // 可省。闸门事件默认 3000
    "max_output_bytes": 262144           // 可省。stdout 上限，超了按失败处理
  },
  "hooks": {
    "pre_tool_use": [
      {
        "name": "no-secrets",            // 必填，同一事件内唯一
        "matcher": "read_file|grep|shell", // 可省。RE2 正则，匹配工具名，大小写敏感
        "command": ["python", "C:/tools/hooks/no_secrets.py"], // 必填，数组或字符串
        "timeout_ms": 2000,              // 可省。1..60000
        "fail_closed": true,             // 可省。闸门事件默认 true，其余 false
        "enabled": true,                 // 可省。临时关掉一个，不用删
        "status_message": "checking for secrets" // 可省。--debug 里显示
      }
    ],
    "post_tool_use": [ { "name": "fmt", "matcher": "write_file|edit_file", "command": "node \"C:/tools/hooks/fmt.mjs\"" } ]
  }
}
```

**未知键是启动错误，不是静默默认。** 一个拼错的 `fail_close` 会被拒绝并指出名字——
静默变成默认值比启动失败难查得多。单个事件最多 16 条 hook。

`matcher` 只对工具事件（`pre_tool_use` / `post_tool_use` / `permission_request`）有意义；
空字符串匹配所有工具。RE2 语义：`read_file` 是精确子串匹配，`read_file_old` 也命中；
要精确就写 `^read_file$`。

**超时与输出上限**：超时默认 5000ms（闸门 3000ms），上限 60000ms。超时会杀掉整个进程树
（hook 起的子进程也一起）。stdout 超过上限按**失败**处理，不会截断后解析——半个 JSON
解析出来的决定比失败危险得多。

---

## 三个完整例子

### 1. 把危险命令改成安全命令（`updated_input`）

```python
import json, sys

event = json.load(sys.stdin)
command = (event.get("tool_input") or {}).get("command", "")

# 只改写真正想拦的那一种；其它命令不动，返回空输出表示"没有意见"。
if command.strip() == "npm install":
    print(json.dumps({
        "updated_input": {"command": "pnpm install --frozen-lockfile"},
        # reason 在没有 decision 时不会展示给模型；要解释改写，
        # 用 additional_context（这个事件接受）。
        "additional_context": "The command was rewritten to pnpm by the no-npm hook.",
    }))
    sys.exit(0)
sys.exit(0)
```

改写后的参数会重新过一遍工具的参数校验；不合法就回 `invalid_args`，**不回退**。
工作区边界和权限判定照常走——改写不会豁免任何检查。

### 2. 工具结果之后提醒一句（`additional_context`）

```python
import json, sys

event = json.load(sys.stdin)
print(json.dumps({
    "additional_context": "This repository uses pnpm; do not run npm install."
}))
```

挂在 `post_tool_use` 上、matcher 设为 `write_file|edit_file`：每次写完文件，下一次请求
的尾部就会带上这句。它**不进会话历史**——本批有效，下一批自动消失，重放会话时字节不变。

### 3. 轮末验证，不合格就再来一轮（`stop` + `block`）

```python
import json, sys, subprocess

event = json.load(sys.stdin)
if event["hook_event_name"] != "stop":
    sys.exit(0)

# 已经在跑测试的 hook 不要再起一个终端；这里用 subprocess 拿退出码。
result = subprocess.run(["go", "test", "./..."], capture_output=True, cwd=event["workspace"])
if result.returncode != 0:
    tail = result.stderr.decode(errors="replace")[-400:]
    print(json.dumps({
        "decision": "block",
        "reason": "tests fail: " + tail,
    }))
    sys.exit(0)
sys.exit(0)
```

`block` 让 runtime 再跑一轮，模型会收到"hook 要求继续"的提示。每轮最多 3 次，防止
hook 把一轮对话变成死循环。**goal 自动轮里 block 被忽略**。

---

## 工作区 hooks：仓库里带的 guardrail

`.tudouni/hooks.json`（工作区里的那份）**默认不读**。原因：`command` 是代码，clone 一个
仓库不等于同意运行它。runtime 会在启动时告诉你它忽略了这份文件。

要用它，显式信任一次：

```
tudouni-aigo --trust-workspace-hooks
```

它会**先打印**将要加载的每条 hook（事件、名字、matcher、命令），确认无误才把文件的
SHA-256 记进 `~/.tudouni/trust.json`。文件之后哪怕改一个字节，信任即失效，要重新审。

**即使信任了，工作区 hooks 也只能收紧**：

- 不能 `allow`（要放行请写 `permissions.json`，那是可 review 的声明式文件）；
- 不能 `updated_input`（改写参数等于悄悄换掉模型要做的事）；
- 不能 `additional_context`（自动注入是 prompt injection 的放大器）；
- 只能挂 `pre_tool_use` / `post_tool_use` 两个事件。

被摘掉的能力会在审计里记下来（`hook_result` 的 `restricted` 字段），不会无声无息。
局限要说明白：**哈希只覆盖 `hooks.json` 本身，不覆盖它引用的脚本**——脚本改了不会触发
重新信任。

另外有一条内置保护：`write_file` / `edit_file` 的目标是 hooks 文件或它引用的脚本时，
直接拒绝。但 **shell 仍然可以绕过**（`echo > ~/.tudouni/hooks.json`）——shell 是你授予的
完全执行权，任何"模型不能改 X"的保证在它面前都只能是尽力而为。这条保护的目标是提高
门槛并留下痕迹，不是边界。

---

## 常见错误

| 症状 | 原因 |
| --- | --- |
| 启动失败，报 `unknown key "fail_close"` | 拼错键名。未知键一律启动失败，不静默取默认 |
| 启动失败，报 `unknown event "preToolUse"` | 事件名是蛇形小写：`pre_tool_use`，不是 `PreToolUse` |
| `deny` 被当成坏输出 | `deny` 必须带 `reason` |
| `post_tool_use` 报"does not accept a decision" | 这个事件**不能**做决定，只能 `additional_context`。要拦调用请挂 `pre_tool_use` |
| `stop` 上写了 `additional_context` | `stop` 不接受注入。要给模型的话用 `reason`（配合 `block`） |
| `updated_input` 被丢掉 | hook 来自工作区（信任过的仓库），只能收紧。写到用户级文件里才行 |
| hook 挂死，一次调用卡住 | 超时会杀整个进程树；闸门事件按 `fail_closed` 拒绝。`--debug` 里能看到是哪个 hook |
| 输出被当作失败 | stdout 超过上限（默认 256 KiB）按失败处理，**不会**截断后解析。诊断写 stderr，别写 stdout |
| 我配了 hook 但什么都没发生 | 先 `tudouni-aigo --hooks` 看它列出了什么、跳过了什么。再确认没带 `--no-hooks`（启动通知里有一行）。改了文件要**新开会话** |
| 工作区的 hooks.json 被忽略 | 这是默认行为。用 `--trust-workspace-hooks` 审查并信任它 |
| 模型把 `deny` 当成临时失败又试了一次 | 不会——拒绝文本里带了"不要重试同样的调用"。如果你自己写的 `reason` 没说清，模型会换一种方式而不是停手 |

调试时用 `--debug`：每次 hook 调用会有一行
`[hook] <事件> <status_message 或名字> → <status> (<耗时>ms) · <工具>`。
每次调用在审计日志里也有一行 `hook_result`（含耗时、退出码、注入长度、改写标记），
`tudouni-aigo --audit --session <id>` 的汇总里会给出 `hooks: N invoked N denied N failed N skipped`。

---

## 设计文档

这份指南只讲"怎么用"。每条规则**为什么**是这样——为什么闸门事件 fail-closed 而观察者
fail-open、为什么 `deny` 要短路、为什么上下文只进请求尾部不进历史、与 Claude Code /
Codex / Gemini CLI 的对照——都在
[design/hooks.md](design/hooks.md)。
