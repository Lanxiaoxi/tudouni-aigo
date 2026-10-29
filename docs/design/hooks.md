# Hooks：用户可配置的确定性扩展点

**状态**：阶段 1 与阶段 2 已实施（`internal/hooks/`、`internal/agent`、`internal/runtime`、
`internal/subagent`、`internal/security` 均为落地代码）。阶段 3 未做（见 §15）。
本文正文保持方案原貌，实施时与正文有出入的地方列在 §18，读的时候以那一节为准。
**范围**：给 `tudouni-aigo` 增加一层**外部命令 hooks**：用户在 `~/.tudouni/hooks.json` 里声明脚本，
运行时在会话、提示词、工具调用、轮次结束等固定位置执行它们，脚本用 JSON 读、用 JSON 写，
可以拒绝、追问、改写参数、注入上下文。
**不在范围**：进程内 Go 插件 ABI、LLM 裁判型 hook（prompt hook）、hook 自己调用工具、
把 hook 当沙箱、hook 的热重载、桌面端 hooks 面板（最后一项单列在阶段 3）。

---

## 0. 结论先行

一句话：**hooks 是"我的工作流要求什么"，权限系统是"这个人允许什么"；两者都必须能拒绝，但只有权限系统能记住"允许"。**

三条不可协商的规则，后面每一节都是它们的展开：

1. **不能破坏会话不变量。** 工具结果必须成对、只在整步之间落盘、`updated_input` 必须重新过 schema
   和工作区边界；hook 注入的上下文**只进请求尾部，不进历史**。观察者永远不能改变被观察的对象。
2. **默认 fail-closed，但只对"闸门"事件。** `pre_tool_use` 超时/崩溃/输出坏掉 = 拒绝这次调用；
   `post_tool_use` / `stop` / `session_*` 出错只记录，绝不让一轮对话卡死。
3. **仓库里的 hooks 是不受信代码。** 默认只读 `~/.tudouni/hooks.json`；工作区的
   `.tudouni/hooks.json` 和 `.tudouni/mcp.json` 一样被忽略并说明。将来要支持，必须显式信任，
   且工作区 hooks **只能收紧**（deny/ask），不能 `allow`、不能改参数、不能注入上下文。

最小可用事件集（阶段 1）：`session_start`、`user_prompt_submit`、`pre_tool_use`、
`post_tool_use`、`stop`、`session_end`。

---

## 1. 现状：这个项目已经有 "hooks"，只是还不是用户的

`internal/agent` 和 `internal/runtime` 里已经有一批**编译期的回调**，它们解决的是"程序内部谁该在什么时候
被叫一下"：

| 现有钩子 | 位置 | 今天做什么 |
| --- | --- | --- |
| `agent.Config.BeforeEach` | `internal/agent/agent.go` | 每次模型请求前刷新凭证、丢弃半截流 |
| `agent.Config.OnFatal` | 同上 | 致命错误（凭证失效）的一次恢复机会 |
| `agent.Config.OnEvent` | 同上 → `runtime.onEvent` | 审计记录的唯一出口，协议层在这里订阅 |
| `agent.Config.OnToolResult` | 同上 | 把**完整**工具结果交给工作区记忆召回（审计只留 200 字预览） |
| `agent.Config.Notes` | `internal/runtime/session_io.go` | 每轮拼 payload 尾部（技能、记忆、目标、任务、后台任务、子代理） |
| `security.AskFunc` | `internal/security/gate.go` | 中高风险调用停下来问人 |
| `protocol.RuntimeHooks` | `cmd/tudouni/main.go` | 前端 ↔ runtime 的连接、终端事件、代码索引事件 |

这些**不是**本文说的 hooks：它们只能在 Go 源码里接，改一次要重新编译；没有配置文件、没有信任边界、
没有超时和输出上限；而且它们大多是"内部实现细节"，不是给用户扩展工作流用的。

本文要加的是**另一层**：用户写一个脚本，运行时在固定位置 exec 它。两者关系是"地基与插座"——
`internal/hooks` 建在现有回调之上（审计复用 `OnEvent`，上下文复用 `Notes`，审批复用 `Ask`），
而不是再造一条事件总线。

---

## 2. 主流实现（截至 2026-10 的公开文档）

### 2.1 六个代表

**Claude Code** —— 事实标准，后来者大多在兼容它的形状。

- 配置在 `settings.json`：用户级 `~/.claude/settings.json`、项目级 `.claude/settings.json`、
  本地覆盖 `.claude/settings.local.json`；企业策略可以再压一层。
- 事件：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、
  `PermissionRequest`、`PermissionDenied`、`Notification`、`Stop`、`SubagentStop`、`PreCompact`、
  `SessionEnd`、`FileChanged` 等。
- 传输：脚本 stdin 收一个 JSON（`session_id`、`transcript_path`、`cwd`、`hook_event_name`、
  `tool_name`、`tool_input`…），stdout 回 JSON；`exit 2` 表示阻断，stderr 作为原因。
- 输出：`hookSpecificOutput.permissionDecision`（`allow` / `deny` / `ask`）、
  `permissionDecisionReason`、`updatedInput`、`additionalContext`；`Stop` / `SubagentStop`
  还支持 `decision: "block"` 让模型继续。
- 项目级 hooks 是仓库里的代码，第一次运行需要信任确认；`PreToolUse` 可以顺带保护 hooks 文件本身。

**OpenAI Codex CLI** —— 形状几乎一样，但把"信任"做成了显式产品能力。

- 十来个生命周期事件，`PreToolUse` / `PostToolUse` / `PermissionRequest` / `UserPromptSubmit` /
  `Stop` / `SessionStart` / `SessionEnd`。
- 每个 hook 定义（不只是文件）在第一次运行前要 review 并 trust；定义变了要重新确认。
- 有 `statusMessage`（运行中给人看的一句话）和 `additionalContextLimit`（注入上下文的上限）。
- 这证明了"项目级 hooks 必须过信任关"不是可选项，而是这个功能能不能进仓库的前提。

**Gemini CLI** —— 事件划分最细，把模型调用本身也纳入了 hook。

- `BeforeModel` / `AfterModel` / `BeforeToolSelection` / `BeforeTool` / `AfterTool`；配置在
  `~/.gemini/settings.json`、项目 `.gemini/settings.json`、系统级和扩展里。
- 能力最强的一组：`BeforeTool` 可以合并/覆盖 `tool_input`；`AfterTool` 可以替换工具结果、
  追加 `additionalContext`、甚至发起一个"尾调用"工具；`continue: false` 可以直接终止整个 agent 循环。
- 项目级 hooks 明确标为 **untrusted by default**。
- 反过来说，它的能力面也是风险面：替换结果、尾调用、终止循环，每一条都会让"这一轮到底发生了什么"
  更难回答。

**Cursor** —— 事件按"编辑器动作"而不是"agent 抽象"划分。

- `.cursor/hooks.json`（项目）/ `~/.cursor/hooks.json`（用户）/ 企业路径；`version: 1`。
- `beforeShellExecution`、`afterShellExecution`、`beforeMCPExecution`、`afterMCPExecution`、
  `beforeReadFile`、`afterFileEdit`、`beforeSubmitPrompt`、`stop`。
- `before*` 返回 `allow` / `deny` / `ask`；`failClosed` 可以按 hook 配；还有 `type: "prompt"` 的
  LLM 裁判型 hook。
- 它保留了一层 Claude Code 事件名兼容（`PreToolUse` → 自己的小写事件），说明生态已经形成路径依赖。

**OpenCode** —— 进程内 TypeScript 插件，不走"外部命令"。

- 插件导出 `tool.execute.before` / `tool.execute.after`，通过事件总线订阅会话生命周期，
  还能注册新工具。
- 优点：零进程开销、类型安全、能拿到完整运行时对象。
- 代价：插件是**运行在同一进程里的代码**，语言被锁死，崩溃/阻塞会直接影响 agent；没有"脚本"那种
  天然的隔离边界。

**LangChain / LangGraph** —— 进程内 middleware，把 hook 当作图上的节点/包装器。

- `before_agent` / `before_model` / `after_model` / `after_agent`，以及
  `wrap_model_call` / `wrap_tool_call`（洋葱式包装）。
- 可以改 state、跳转节点、用 `interrupt` 做 human-in-the-loop；异步版本成对提供。
- 它面向的是"写框架的人"，不是"写脚本的人"：能力最强，但没有配置文件、没有信任模型，
  也不适合一个静态二进制产品。

### 2.2 对照表

| 框架 | 传输 | 配置位置 | 阻断/改写 | 信任模型 | 上下文注入 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | 外部命令，stdin/stdout JSON + exit code | 用户 / 项目 / 本地 / 企业 settings | 阻断、改参数、`Stop` 续轮 | 项目级需信任 | `additionalContext` |
| Codex CLI | 同 | 用户 / 工作区 | 同 | **每个 hook 定义**显式 review | `additionalContext` + 上限 |
| Gemini CLI | 同 | 用户 / 项目 / 系统 / 扩展 | 阻断、改参数、换结果、`continue:false` | 项目级默认不受信 | `additionalContext` / 尾调用 |
| Cursor | 同 | 项目 / 用户 / 企业 `hooks.json` | allow/deny/ask、`failClosed` | 项目级需信任 | 有，另有 prompt hook |
| OpenCode | 进程内 TS 插件 | 插件目录 | 抛错阻断、改 args、加工具 | 安装即信任 | 直接改 state |
| LangChain | 进程内 middleware | 代码 | 中断、改 state、HITL | 代码即信任 | 直接改 state |

### 2.3 共同骨架与真正的分歧

六家放在一起，**骨架几乎一致**：

1. 事件围绕同一个循环：会话开始/结束、用户提交、模型调用前后、工具调用前后、权限询问、轮次结束、
   子代理开始/结束、压缩前。
2. 决策词汇收敛到三个：`allow` / `deny` / `ask`，外加一句给模型或给人的 `reason`。
3. 上下文注入是核心能力，不是附属品——没有它，hooks 就只剩"拦截"。
4. 超时、输出上限、fail-closed 是生产环境的标配，不是高级选项。
5. 项目级 hooks 一律被当作不受信代码：要么默认不加载，要么第一次运行前显式信任。
6. 顺序必须写死：多个 hook 命中同一事件时，谁先、`deny` 是否短路、`allow` 能否覆盖 `deny`，
   不写清楚就一定会在某次组合里出现"看起来允许了其实没有"。

真正的分歧只有四个，本文的选择都写在括号里：

| 分歧 | 选项 | 本文选择 |
| --- | --- | --- |
| 传输 | 进程外命令 vs 进程内插件 | **进程外**：语言无关、崩溃隔离、静态二进制不需要嵌入运行时 |
| 项目级 hooks | 直接加载 vs 信任 vs 永不 | **阶段 1 永不**；阶段 2 显式信任，且只能收紧 |
| 上下文注入位置 | 历史 / 工具结果 / 请求尾部 | **请求尾部**：历史必须可复现，见 §6.6 |
| 阻断力度 | deny/ask/allow vs 还能终止整个循环 | **不做 `continue:false`**：停止只有一条路（`ShouldStop`/interrupt），见 §5.3 |

### 2.4 对本项目的启示

- `internal/security` 已经是 fail-closed 的权限闸门，hooks 必须**接在它旁边**，而不是绕过它。
  否则"策略拒绝"和"hook 放行"谁赢会变成一个只有读源码才能回答的问题。
- 这个项目最值钱的不变量是"会话可复现、审计即协议"。因此 Claude/Gemini 那种"hook 可以替换工具结果、
  可以终止循环"的能力，不能照单全收——它们会让审计日志不再能回答"模型实际看到了什么"。
- 这个项目的工具结果可以很大（`read_file` 不分页），hooks 的输入必须有上限，否则一个 hook 会把
  几百 MB 读进内存。
- Windows + Linux 都要跑：命令形式必须同时支持 argv 数组和平台 shell 字符串，且默认推荐 argv。

---

## 3. 设计目标与非目标

**目标**

1. 语言无关：Python / Node / shell / 一个编译好的二进制都能当 hook。
2. 确定性：同一个请求、同一份配置、同一份输入，得到同一个决定；顺序和短路规则写死。
3. 可审计：每次 hook 调用都有一条 `hook_result`，决策、耗时、退出码、注入长度都能查。
4. 不破坏不变量：历史字节不变、工具结果成对、只在整步之间落盘、上下文只进尾部。
5. 失败可控：闸门事件 fail-closed，观察事件 fail-open；全部有超时和输出上限。
6. 默认安全：用户级才默认加载；工作区 hooks 默认忽略；模型不能改自己的 guardrail。

**非目标**

- 不做进程内插件 ABI（Go plugin 的平台/版本约束会把"一个二进制"毁掉）。
- 不做 LLM 裁判型 hook（多一次模型调用、多一条计费路径；需要的话脚本自己去调模型）。
- 不让 hook 调用工具（hook 不是工具；`ask_user` 从 hook 里问会和审批通道打架）。
- 不做沙箱（hook 是用户自己的代码，和 shell 工具同级信任；只做最小环境变量和边界说明）。
- 不做热重载（一次 runtime 打开读一次；改完开新会话生效，见 §9.4）。
- 阶段 1 不允许替换工具结果（redaction 单列阶段 3，见 §15）。

---

## 4. 总体形状

```
本机 / 用户
  ~/.tudouni/hooks.json ──► internal/hooks（解析、匹配、执行、聚合）
                                      │
前端 ──► runtime.RunTurn               │
          ├─ session_start（打开会话时）│
          ├─ user_prompt_submit ───────┤
          ├─ agent.RunMessages         │
          │    ├─ pre_tool_use ────────┤──► exec hook（stdin JSON）
          │    ├─ security.Check       │      stdout JSON / exit code
          │    ├─ tool.Execute         │
          │    ├─ post_tool_use ───────┤
          │    ├─ pre_compact          │
          │    └─ run_finished         │
          ├─ stop ─────────────────────┤── block → 再跑一轮（有上限）
          └─ session_end（关会话时）   │
                                      ▼
                              审计：hook_result
                              上下文：请求尾部
```

一个 hook = 一个进程。运行时**不**把 hook 的 stdout 直接当模型输出，也**不**把它的 stderr 直接当模型输入：
只有 JSON 里明确写的 `reason` / `additional_context` 才会进入模型可见的文本。

---

## 5. 事件模型

### 5.1 公共信封（stdin）

每个 hook 的 stdin 都是一个 JSON 对象，公共字段：

```json
{
  "hook_event_name": "pre_tool_use",
  "session_id": "ses_...",
  "run_id": "run-...",
  "step": 3,
  "cwd": "C:/work/my-project",
  "workspace": "C:/work/my-project",
  "mode": "interactive",
  "autopilot": false,
  "hook_name": "no-secrets",
  "subagent": null
}
```

- `mode`：`interactive` / `autopilot`。`autopilot` 时"问人"这条路不存在，hook 返回 `ask` 会被当作拒绝。
- `subagent`：父会话为 `null`；子代理里是 `{"id": "...", "depth": 2, "label": "..."}`。
- 信封里**不放 API key、不放配置路径、不放完整环境变量**。hook 要读文件自己去读。

### 5.2 事件表

| 事件 | 时机 | 能否阻断 | 额外字段 | 阶段 |
| --- | --- | --- | --- | --- |
| `session_start` | runtime 组装完成、第一次请求之前 | 否（失败只记录） | `source`: `startup` / `resume` / `switch`、`model`、`provider` | 1 |
| `user_prompt_submit` | 用户消息进入 runtime、追加到会话之前 | **是**（拒绝则这一轮不开始） | `prompt` | 1 |
| `pre_tool_use` | 参数解析成功、权限判定之前 | **是** | `tool_name`、`tool_input`、`tool_risk`、`tool_call_id` | 1 |
| `post_tool_use` | 一批工具全部结算、写入历史之前 | 否（只能加上下文/提醒） | 同上 + `tool_status`、`tool_result`、`duration_ms`、`truncated` | 1 |
| `stop` | 一轮以 `answered` 结束、返回前端之前 | **是**（`block` = 再来一轮） | `stop_reason`、`last_assistant_message`、`autonomous` | 1 |
| `session_end` | `Runtime.Close()`，审计 sink 关闭之前 | 否 | `reason`: `switch` / `shutdown` | 1 |
| `permission_request` | 权限闸门**即将问人**时 | **是**（可以替人回答） | 同 `pre_tool_use` + `policy_decision` | 2 |
| `subagent_start` | 子代理解析完模型、真正运行之前 | **是**（拒绝则父代理拿到拒绝文本） | `subagent`、`model`、`provider`、`background`、`task_chars` | 2 |
| `subagent_stop` | 子代理结算时 | 否 | `subagent`、`stop_reason`、`usage` | 2 |
| `pre_compact` | 压缩生成摘要之前 | 否（只加提示，不改边界） | `fold_point`、`messages`、`before`（预算估算） | 2 |

**`stop` 的边界**：只在 `StopAnswered` 时触发。`max_steps`、`cancelled`、`model_error`、
`empty_response` 都表示"这一轮没有正常答完"，让 hook 在这里"续轮"会把一个失败的回合伪装成可继续的回合。
`autonomous: true`（goal 自动轮）时也触发，但 `block` 被忽略并记 `skipped`——续轮权属于 goal driver，
一个 hook 不能和它抢同一个决定。

**输入也要有上限**：`tool_result` 默认最多 1 MiB、`last_assistant_message` 最多 16 KiB、
`prompt` 最多 64 KiB；超出时截断对应字段并置 `truncated: true`，**不**截断整个 JSON。
理由和输出上限相反：输入截断只是让 hook 少看一点，输出截断会让它"看起来回了半个决定"，
而半个决定比没有决定更危险。

### 5.3 明确不做的事件/能力

- **`Notification`**：这个项目没有"桌面通知"层，通知是前端的事。
- **`BeforeModel` / `AfterModel`**：模型调用前后已经有 `BeforeEach` / `OnEvent`；把整个请求交给 hook
  等于让 hook 改 prompt，和"历史可复现"直接冲突。需要审计请读 `model_call`。
- **`continue: false` / 终止整个循环**：停止只有一条路（`ShouldStop` / interrupt）。多一条路就会多一个
  "为什么停了"的答案，而这两个答案迟早会不一致。
- **`tail_tool_call`（Gemini 的尾调用）**：它让 hook 间接执行工具，绕开权限闸门和审计的"一次调用一条记录"。
- **`prompt` 型 hook（LLM 裁判）**：阶段 3 再议；脚本可以自己调模型，运行时不为它多开一条计费/路由。

---

## 6. 决策协议

### 6.1 stdin / stdout / exit code

- stdin：§5.1 的 JSON，**一次写完并关闭**。hook 不许读 TTY。
- stdout：**最多一个 JSON 对象**；空输出 + exit 0 = "没有意见"。
- stderr：诊断信息，默认不进模型；`exit 2` 时前 2 KiB 作为拒绝原因（和 Claude Code 的约定一致）。

退出码：

| 退出码 | 含义 | 闸门事件（pre / permission_request） | 观察事件 |
| --- | --- | --- | --- |
| `0` | 成功，解析 stdout | 按 JSON 决策 | 按 JSON 决策，`block` 无效 |
| `2` | 阻断 | `deny`，stderr 作原因 | 记录 `denied`，但**不**改变结果 |
| 其他非 0 | hook 失败 | `fail_closed` 决定：拒绝或忽略 | 只记录 |
| 超时 | 失败 | `fail_closed` 决定 | 只记录 |
| 输出坏 JSON / 超上限 | 失败 | `fail_closed` 决定 | 只记录 |

**`fail_closed` 的默认值**：`pre_tool_use` 和 `permission_request` 为 `true`，其余为 `false`。
这不是"安全默认"四个字那么简单：闸门事件失败时放行，等于让一个坏掉的 guardrail 变成透明；
而观察事件失败时拒绝，等于让一个坏掉的 formatter 卡住整轮对话。

### 6.2 输出 JSON

```json
{
  "decision": "allow",
  "reason": "read-only command",
  "updated_input": { "command": "git status --short" },
  "additional_context": "The repository uses pnpm; do not run npm install.",
  "system_message": "formatted 3 files"
}
```

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `decision` | `"allow"` / `"ask"` / `"deny"` / `"block"` / `"none"` | `block` 是 `deny` 的别名（兼容 Claude/Gemini 词汇）；`stop` 事件里 `block` 表示"继续这一轮" |
| `reason` | string | 给模型/给人的原因；`deny` 时必填，其他可空 |
| `updated_input` | object | 只对 `pre_tool_use` 有效；按 §6.5 合并 |
| `additional_context` | string | 只对 `session_start` / `user_prompt_submit` / `post_tool_use` / `pre_compact` 有效 |
| `system_message` | string | 给人看的一句话，进 stderr/通知，不进模型上下文 |

未知字段忽略（前向兼容），但**未知 `decision` 值是错误**：一个拼错的 `deny` 变成"没有意见"是
最难查的那类失败。

### 6.3 多个 hook 的聚合

同一事件、多个 hook 命中时：

1. 按配置文件里的顺序**串行**执行；后一个能看见前一个 `updated_input` 之后的结果（只对 `pre_tool_use`）。
2. 第一个 `deny` **短路**：后面的 hook 不再执行，记 `skipped`（否则一个被拒绝的调用还会跑完剩下的脚本，
   既浪费又让"为什么拒绝"取决于最后一个 hook）。
3. `ask` 是"粘性"的：只要有一个 `ask`，最终就不会自动放行。
4. 全部是 `allow` / `none` 时，最终是 `allow`（`none` 不投票）。
5. 任一 hook 失败且 `fail_closed=true`：按 `deny` 处理，原因写明是哪个 hook、什么失败。

### 6.4 与权限系统的优先级

这是整个设计里最需要写死的一张表。**从上到下，先命中先赢**：

| 顺序 | 判定 | 结果 | 审计 `outcome` |
| --- | --- | --- | --- |
| 1 | `policy.Decide == deny`（`deny_tools`） | 拒绝 | `policy_denied` |
| 2 | `pre_tool_use` 返回 `deny` | 拒绝 | `hook_denied` |
| 3 | `pre_tool_use` 返回 `ask` | 强制问人；`autopilot` 或无人可问时拒绝 | `hook_forced_ask` / `hook_no_asker` |
| 4 | `autopilot` 开 | 放行 | `autopilot` |
| 5 | `policy.Decide == allow`（`auto_approve`） | 放行 | `auto_allowed` |
| 6 | `permissions.json` 的整工具规则 | 放行 | `rule_allowed` |
| 7 | `permissions.json` 的命令前缀规则 | 放行 | `command_allowed` |
| 8 | `pre_tool_use` 返回 `allow` | 跳过问人 | `hook_allowed` |
| 9 | `permission_request` 返回 `allow` / `deny` | 替人回答 | `hook_allowed` / `hook_denied` |
| 10 | 问人 | 允许 / 拒绝 | `approved` / `user_denied` |
| 11 | 无人可问 | 拒绝 | `no_asker` |

读法：

- **`policy.Decide == deny` 永远第一。** hook 的 `allow` 不能覆盖"这个工具被明确禁止"——那是"不可以"，
  不是"不必问"。
- **`pre_tool_use` 的 `deny` 在 `autopilot` 之前。** 自动模式只关掉"问人"，不关掉"guardrail"。
- **`ask` 在 `autopilot` 里变成拒绝**，不是忽略：`autopilot` 的定义就是"没有人可以回答"，
  这和现有 `OutcomeNoAsker` 的 fail-closed 是同一句话。
- **`allow` 排在 `permissions.json` 规则之后**：已经记住的"允许"是更长期、更具体的理由，
  审计应该记它；hook 的 `allow` 只负责补上"还没记住、但这次可以"。
- 顺序 1/2 都是"拒绝"，但 `outcome` 不同：审计必须能回答"是策略拒绝的，还是 hook 拒绝的"。

`permission_request`（阶段 2）只在顺序 9 触发：也就是说，它**不能**把一次已经自动放行的调用
改成"必须问人"——那是 `pre_tool_use` 的 `ask` 的职责。这样两条路各有明确用途：

- 想"每次都查一遍" → `pre_tool_use`（每条调用都跑）；
- 想"只在本来要问人的时候替人回答" → `permission_request`（省进程、语义清楚）。

### 6.5 `updated_input` 的合并

只允许**用户级**的 `pre_tool_use` 返回 `updated_input`。合并规则：

- 对象递归合并；数组和标量整体替换；`null` 删除该键。
- 合并后的对象必须重新过 `tools.Validate`；不合法 → 这次调用以 `invalid_args` 回给模型，
  原因写明"hook 改写后不合法"，**不**回退到原参数（回退会让模型以为改写生效了）。
- 改写后的参数仍然走同一个 `tools.Workspace` 边界和 `security.Check`，不会因为"是 hook 改的"而豁免。
- 审计：`tool_call` 记录模型原始参数（已有），`permission` 记录生效参数（现有 `reportPermission`
  读的是 `item.arguments`，改写后自然生效），`hook_result` 记录 `updated_input=true` 和改写前后的
  200 字预览。**不记录完整参数体**（`write_file` 的参数可能是几 MB）。

### 6.6 `additional_context` 的位置与生命周期

**只进请求尾部，不进会话历史。** 理由是这个项目已经有的那条规则：会话文件必须能复现
"模型当时看到了什么"，而 hook 的上下文是"这一次请求的临时提醒"，不是任何一方说过的话。
把它写进历史会带来三个问题：会话文件被观察者污染、每次重放都要重新判断它是否仍然有效、
压缩会把它当成对话的一部分折叠。

实现上它是一个小的 `hooks.Context`：

- `Turn`：本轮有效（`session_start` 只注入第一次 `RunTurn`；`user_prompt_submit` 每轮注入），
  `RunTurn` 结束时清空。
- `Batch`：下一批工具结果之前有效（`post_tool_use` 注入），下一批 `runBatch` 开始时清空。
- `Text()` 把两部分按"Turn → Batch"拼起来，附一行来源标记：
  ```
  <hook_context source="post_tool_use" hook="pnpm-guard">
  The repository uses pnpm; do not run npm install.
  </hook_context>
  ```
- 注入位置：`agent.noteText()` 的最后，排在技能、记忆、目标、任务、后台任务、子代理之后。
  理由是它最"当下"——它描述的是这一次请求，应该离生成位置最近；而且尾部本来就不在缓存前缀里，
  放最后不额外破坏前缀缓存。
- 上限：单条 8 KiB、总计 32 KiB，超出截断并写 `truncated: true`；只审计长度和摘要，不审计正文
  （和 `memory_recall`、`context_compacted` 的口径一致）。
- 重试幂等：`Notes()` 在重试时会被再次调用，`Context.Text()` 是纯读，不清空；清空只发生在
  "下一批"或"下一轮"，所以一次失败的请求重发时上下文不变。

### 6.7 模型看到的拒绝文本

hook 的 `reason` 是用户自己的话，原样保留，但外面加一句"不要重试"：

```
hook 拒绝：<reason>（hook: no-secrets）。不要重试同样的调用；换一种方式，或先向用户说明原因。
```

超时/坏输出的文本要说出**是哪一种失败**，因为补救方式不同：

```
hook no-secrets 超时（>2000ms），按 fail_closed 拒绝。不要重试；先修 hook，或用 --no-hooks 启动。
```

模型看到 `--no-hooks` 这种话没有用（它不能重启进程），但人会在同一份审计里看到；这句话是给读日志的人
留的线索。模型侧真正要传达的只有一句：**这次不要重试**。

---

## 7. 信任模型

### 7.1 阶段 1：只认用户级

- 唯一路径：`~/.tudouni/hooks.json`（`paths.UserConfigDir()`）。
- 工作区的 `.tudouni/hooks.json` **不读**，并在启动时给一条 `warn` 通知，说明"工作区 hooks
  不加载；见 docs/design/hooks.md"。这和 `mcp.json` 的规则是同一个理由：`command` 是代码，
  clone 一个仓库不等于同意运行它。
- 这和 `permissions.json` 形成对称：
  - 工作区能声明"允许什么"（`permissions.json`，声明式、可 review、只能记允许）；
  - 用户能声明"我的工作流要跑什么代码"（`hooks.json`，代码、跟着人走）。

### 7.2 阶段 2：工作区 hooks 要显式信任，且只能收紧

如果团队确实需要把 guardrail 放进仓库：

- `~/.tudouni/trust.json` 记录 `{workspace: {hooks_sha256, approved_at}}`。
- 启动时：文件存在且哈希匹配 → 加载；不匹配或没有记录 → 忽略 + 通知。
- 信任动作只能是显式的：`--trust-workspace-hooks`（打印将要加载的 hook 定义，写哈希，退出）
  或前端的一次确认。不做"第一次自动信任"。
- **即使信任了，工作区 hooks 也只能 `deny` / `ask`**：
  - 不能 `allow`（要允许请写 `permissions.json`，那是可 review 的声明式文件）；
  - 不能 `updated_input`（改写参数等于悄悄换掉模型要做的事）；
  - 不能 `additional_context`（自动注入是 prompt injection 的放大器）；
  - 只允许 `pre_tool_use` / `post_tool_use` 两个事件（仓库不能影响提示词、轮次结束和会话生命周期）。
- 局限要写明：哈希只覆盖 `hooks.json` 本身，不覆盖它引用的脚本内容；脚本改了不会触发重新信任。
  这是 Codex 也有的限制（它 review 的是 hook 定义，不是脚本字节）。文档里不装作它不存在。

### 7.3 自保护

模型有 `write_file` / `edit_file` / `shell`，所以"hooks 文件不能被模型改"不能只靠口头约定：

- 内置一条**不可配置**的 guard：`write_file` / `edit_file` 的目标是当前 `hooks.json`
  或配置里声明的脚本路径时，直接拒绝（`status=denied`，原因是"这是 guardrail 文件"）。
- `shell` 仍然可以绕过（`echo > ~/.tudouni/hooks.json`）。这条要写进文档：shell 是用户授予的
  完全执行权，任何"模型不能改 X"的保证在 shell 面前都只能是尽力而为。这条 guard 的目标是
  **提高门槛并留下痕迹**，不是保证；真正的边界是"hooks 只从用户级加载"，以及审计能回答
  "这一轮有没有人动过 guardrail"。

---

## 8. 执行模型

| 项目 | 规则 | 理由 |
| --- | --- | --- |
| 进程 | 一个 hook 一次 `exec`；`argv` 数组或平台 shell 字符串 | 语言无关；崩溃不影响 runtime |
| 工作目录 | 工作区根 | 脚本里的相对路径和模型的相对路径是同一个 |
| 环境变量 | 只传 `PATH`、`HOME`/`USERPROFILE`、`TMP`/`TEMP`、`SystemRoot`（Windows）、`LANG`，加上 `TUDOUNI_HOOK_EVENT` / `TUDOUNI_WORKSPACE` / `TUDOUNI_SESSION_ID` / `TUDOUNI_HOOK_NAME` | 配置里的 key 不在环境里，但最小化仍然是对的；hook 要什么自己声明 |
| 超时 | 默认 5000ms；`pre_tool_use` 默认 3000ms；上限 60000ms | 闸门在热路径上，超过 100ms 就该重新设计 |
| 输出上限 | 默认 256 KiB，上限 1 MiB；超过按失败处理，不截断后解析 | 半个 JSON 解析出来的决定比失败更危险 |
| stderr | 最多留 8 KiB；审计只放 200 字预览 | 和 `AuditPreviewLimit` 同一口径 |
| 杀进程 | `exec.CommandContext` + `internal/process.TerminateTree`（Windows 走 job object / `taskkill /T`）；启动时必须复用 `process` 包的进程组/job object 设置（Unix `Setsid`、Windows `assignToJob`），否则 Linux 上 `TerminateTree` 会拒绝杀掉与 agent 同组的进程 | hook 可能起子进程；只杀父进程会留下孤儿 |

| 并发 | 同一事件链串行；不同子代理之间可以并发；`Set` 加载后只读 | 串行保证顺序确定；只读保证子代理并发安全 |
| 排序 | `pre_tool_use` 在批处理**准备阶段**按模型顺序串行；`post_tool_use` 在整批结算后按模型顺序串行 | 准备阶段本来就在任何执行之前；post 按模型顺序才能让注入上下文可复现 |
| 开关 | `--no-hooks` 完全跳过加载，并留一条 `info` 通知 | 静默禁用 guardrail 是最坏的情况 |

**为什么 `post_tool_use` 不在 `runOne` 里立即执行**：并行批次的结果完成顺序不确定，如果在各自的
goroutine 里跑 hook，`additional_context` 的顺序会随调度变化，同一份会话重放两次得到不同的 payload。
放到 `runBatch` 结算之后按 `batch` 顺序跑，代价是一点串行延迟，换来的是可复现。

**为什么 `pre_tool_use` 不并行**：一个批次的权限判定现在就是"全部准备完再执行"，hook 跟着这个顺序走，
人看到的仍是"调用 → 询问 → 结果"一条线；并行跑 hook 会让两个 guardrail 同时改同一份 `updated_input`
的合并顺序变得不可解释。

---

## 9. 配置

### 9.1 文件

`~/.tudouni/hooks.json`（`runtime.HooksFile()`，和 `mcp.json` 同级）。没有工作区版本（阶段 1）。

### 9.2 形状

```jsonc
{
  "version": 1,
  "defaults": {
    "timeout_ms": 5000,
    "max_output_bytes": 262144
  },
  "hooks": {
    "pre_tool_use": [
      {
        "name": "no-secrets",
        "matcher": "read_file|grep|shell",
        "command": ["python3", "/home/me/.tudouni/hooks/no_secrets.py"],
        "timeout_ms": 2000,
        "fail_closed": true,
        "status_message": "checking for secrets"
      }
    ],
    "post_tool_use": [
      {
        "name": "fmt",
        "matcher": "write_file|edit_file",
        "command": "node \"C:/tools/hooks/fmt.mjs\""
      }
    ],
    "stop": [
      {
        "name": "verify",
        "command": ["python3", "/home/me/.tudouni/hooks/verify.py"],
        "timeout_ms": 30000
      }
    ]
  }
}
```

### 9.3 字段

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `version` | 是 | — | 必须是 `1`；将来不兼容变更 +1 |
| `hooks` | 是 | — | 事件名 → hook 数组；未知事件名是配置错误 |
| `name` | 是 | — | 同一事件内唯一；审计和 `--hooks` 用它标识 |
| `matcher` | 否 | `""`（全匹配） | RE2 正则，匹配工具名；只对工具事件有意义；编译失败是配置错误 |
| `command` | 是 | — | 字符串（平台 shell）或 argv 数组（推荐） |
| `timeout_ms` | 否 | 5000 / 闸门 3000 | 1..60000 |
| `fail_closed` | 否 | 闸门 true，其余 false | 失败时是否按拒绝处理 |
| `enabled` | 否 | true | 临时关掉一个 hook，不用删 |
| `status_message` | 否 | `""` | 给人看的一句话；阶段 1 只进审计/`--debug` |

**未知键 = 配置错误。** 这和 `permissions.json` 的 `unknownKeys` 检查是同一套规则：一个拼错的
`fail_close` 静默变成默认值，比启动失败更难查。

### 9.4 加载与校验

- 在 `OpenRuntime` 早期加载，和 `LoadPermissions` / `LoadMcpServers` 并列；**文件存在但坏了 → 启动失败**
  （`runtime.Error`，exit 2），文件不存在 → 没有 hooks，正常。
- 启动时校验：`version`、事件名、`name` 唯一、`matcher` 能编译、`timeout_ms` 范围、
  `command` 非空；argv 形式的第一个元素找不到时给 `warn`（PATH 可能在运行时不同，不能直接判死）。
- 一次 runtime 打开只读一次。改配置后需要新开会话（`/new`、`/resume`、桌面端重开）生效；
  阶段 2 可以加 `/hooks reload`，但它必须在一个 turn 之间做，不能改正在跑的 turn 的规则。
- `--hooks`：列出每条 hook（事件、名字、matcher、超时、fail_closed、命令），以及被忽略/有问题的行。
  形状照 `--skills`（它已经证明"列出被跳过的"比只列"成功的"有用）。
- `--no-hooks`：跳过加载，`notices` 里留一条 `info`。

### 9.5 示例脚本（给文档用，不是运行时代码）

`pre_tool_use` 的最小 Python：

```python
import json, sys

event = json.load(sys.stdin)
command = (event.get("tool_input") or {}).get("command", "")
if "rm -rf /" in command:
    print(json.dumps({"decision": "deny", "reason": "refusing a filesystem-wide delete"}))
    sys.exit(0)
print(json.dumps({"decision": "none"}))
```

要点：**stdout 只能有一个 JSON 对象**；诊断写 stderr；不要从 stdin 读第二次。

---

## 10. 代码落点

### 10.1 新包 `internal/hooks`

| 文件 | 内容 |
| --- | --- |
| `event.go` | `Event` 常量、`Envelope`、`ToolPayload`、`Scope`、`Envelope.Marshal` |
| `config.go` | `Load(path) (*Set, error)`、默认值、未知键/正则/重复名校验 |
| `matcher.go` | `Matcher.Match(tool string) bool`；空 matcher = 全匹配 |
| `runner.go` | `Set.Fire(ctx, Envelope) Result`；逐条 exec、超时、输出上限、进程树清理 |
| `decision.go` | `Decision`、`Outcome`、聚合规则（deny 短路、ask 粘性、fail_closed） |
| `context.go` | `Context`：Turn/Batch 两段、`AddTurn` / `AddBatch` / `ClearTurn` / `ClearBatch` / `Text`、上限 |
| `trust.go` | 阶段 2：`TrustStore`、`HashFile`、`WorkspaceHooks` |

接口草图：

```go
package hooks

type Event string

const (
    EventSessionStart     Event = "session_start"
    EventUserPromptSubmit Event = "user_prompt_submit"
    EventPreToolUse       Event = "pre_tool_use"
    EventPostToolUse      Event = "post_tool_use"
    EventPermissionRequest Event = "permission_request"
    EventStop             Event = "stop"
    EventSessionEnd       Event = "session_end"
    // 阶段 2: subagent_start / subagent_stop / pre_compact
)

type Envelope struct {
    Event     Event          `json:"hook_event_name"`
    SessionID string         `json:"session_id"`
    RunID     string         `json:"run_id,omitempty"`
    Step      int            `json:"step,omitempty"`
    CWD       string         `json:"cwd"`
    Mode      string         `json:"mode"`      // interactive | autopilot
    Autopilot bool           `json:"autopilot"`
    HookName  string         `json:"hook_name"`
    Subagent  *Scope         `json:"subagent,omitempty"`
    Tool      *ToolPayload   `json:"-"`
    Prompt    string         `json:"prompt,omitempty"`
    // ... session_start / stop / pre_compact 的字段
}

type Result struct {
    Decision  Decision  // none | allow | ask | deny | block
    Reason    string
    Updated   map[string]any
    Context   string
    System    string
    Outcomes  []Outcome // 每条 hook 一条，供审计
    DeniedBy  string    // 短路时是哪个 hook
}

type Runner interface {
    Fire(ctx context.Context, event Envelope) Result
}
```

`Set` 实现 `Runner`。`nil` 的 `Runner` 是合法的"没有 hooks"，所有调用点都 nil-safe。
`Set` 在加载时接一个 `Emit func(map[string]any)`（组装时指向 `runtime.onEvent`），所以无论 hook 是从
agent 还是从 runtime 触发，`hook_result` 都从**同一个**审计出口走；`Fire` 的返回值只负责决策和上下文，
不负责写日志。

`Envelope` 的 JSON 形状是**扁平**的（`tool_name` / `tool_input` / `tool_status` 和公共字段同级，
不是嵌在 `tool` 对象里），所以它有一个自定义的 `MarshalJSON`；结构体里的 `Tool` 只是为了在 Go 侧
把一组字段放在一起，带 `json:"-"`。

### 10.2 `internal/agent`

- `Config` 增加 `Hooks hooks.Runner` 和 `HookContext *hooks.Context`。
- `noteText()` 末尾追加 `HookContext.Text()`（`internal/agent/context.go`）。
- `approve` 改为 `approve(ctx, item)`：
  1. 解析参数成功后，`Fire(pre_tool_use)`；
  2. `deny` → `failPrepared(item, "denied", 文本)`，写 `hook_result`，返回；
  3. 有 `updated_input` → 合并、重新 `tools.Validate`；失败 → `invalid_args`；
  4. `security.Check(..., advisor)`；`pre_tool_use.allow` 通过新的 `PreApproval` 参数传入。
- `runBatch` 在结算 pass 之后、`Session.Append` 之前调用 `runPostHooks(batch)`：
  按 `batch` 顺序串行，把 `additional_context` 写入 `HookContext.AddBatch`。
- `compact` 在 `generateSummary` 之前 `Fire(pre_compact)`，把 `additional_context` 拼进压缩提示词，
  **不**改 `FoldPoint`、**不**改边界。
- `stop` 不在 agent 里做：agent 只负责把"这一轮答完了"返回给 runtime；续轮是 runtime 的决定
  （它拥有 turn 计数和前端可见的答案）。

### 10.3 `internal/security`

`Check` 增加一个 advisor（阶段 2 的 `permission_request`），只在"即将问人"时调用：

```go
type Advisor interface {
    Advise(question Question) Advice // 由 agent 的闭包实现，内部 exec hook
}

type Question struct {
    ToolName  string
    Risk      RiskLevel
    Arguments map[string]any
    Decision  Decision // 到这里一定是 DecisionAsk
}

type Advice struct {
    Kind   string // allow | ask | deny
    Reason string
}
```

新增 `OutcomeHookAllowed` / `OutcomeHookDenied` / `OutcomeHookForcedAsk` / `OutcomeHookNoAsker`。
`Check` 的签名多两个参数（`PreApproval`、`Advisor`），调用点只有 `agent.approve` 和测试。

### 10.4 `internal/runtime`

| 位置 | 改动 |
| --- | --- |
| `runtime/config.go` | `HooksFile()`：`filepath.Join(paths.UserConfigDir(), "hooks.json")` |
| `runtime/composition.go` | 早期 `hooks.Load`；构造 `hooks.Context`；把 `Runner`/`Context` 传给 `agent.New` 和 `subagent.Config`；启动时 `Fire(session_start)` 并把上下文塞进 turn 队列；`notices` 加加载/忽略/错误行 |
| `runtime/session_io.go` | `RunTurn`：先 `Fire(user_prompt_submit)`（拒绝则返回 `hooks.PromptBlocked`，不追加消息），再 `recallForTurn`；`defer HookContext.ClearTurn()`；`Close`：在关审计 sink 之前 `Fire(session_end)` |
| `runtime/goal_driver.go` | 不改；`stop` 的 `autonomous` 标记由 `RunTurn` 的调用来源决定，goal 轮本来就走 `RunMessages` |

`RunTurn` 的失败形状：

```go
type PromptBlocked struct {
    Hook   string
    Reason string
}
func (e *PromptBlocked) Error() string { ... }
```

前端把 `PromptBlocked` 当作一条 `notice`（或 TUI 的 system line）显示，**不**把它写进会话；
这一轮没有发生，不能留下"用户说了但没跑"的半截。

### 10.5 `internal/subagent`

- `subagent.Config` 增加 `Hooks hooks.Runner`；`spawn` 创建子 `hooks.Context` 并传给子 `agent.New`。
- `childNotes` 末尾追加子 `HookContext.Text()`。
- `spawn` 在解析模型之后、`Board.Start` 之前 `Fire(subagent_start)`；`deny` 直接返回
  `tools.TextResult("delegation refused: ...")`，不创建子会话。
- `settle` 里 `Fire(subagent_stop)`，只观察。
- 子代理的 `pre_tool_use` / `post_tool_use` 照常触发，信封带 `subagent` 作用域；
  `user_prompt_submit` / `session_*` / `stop` **不**在子代理里触发（子代理不是一个"人的回合"）。
- 子代理本来就是 `autopilot=true`，所以 hook 返回 `allow` 没有意义；`deny` 仍然有效，
  这是子代理唯一能被 guardrail 收紧的地方。

### 10.6 `internal/audit` 与 CLI

- `KindHookResult = "hook_result"`。
- `cmd/tudouni/main.go`：`--hooks`（列出）、`--no-hooks`（跳过）；`options` 里加对应字段。
- `internal/i18n`：新增错误/通知文案（界面英文，模型侧中文保持现有约定）。
- `--audit` 的 `summary` 增加 hooks 计数（可选，阶段 2）。

---

## 11. 审计与可观测性

每次 hook 执行一条 `hook_result`，字段：

```json
{
  "kind": "hook_result",
  "event": "pre_tool_use",
  "hook": "no-secrets",
  "status": "denied",
  "decision": "deny",
  "reason": "refusing a filesystem-wide delete",
  "duration_ms": 42,
  "exit_code": 0,
  "stdout_bytes": 83,
  "context_chars": 0,
  "updated_input": false,
  "tool": "shell",
  "call_id": "call_...",
  "subagent_id": null
}
```

- `status`：`ok` / `denied` / `timeout` / `spawn_error` / `exit_error` / `bad_output` / `truncated` / `skipped`。
- `reason` 只放 200 字预览；正文不进日志（和工具结果、记忆正文的口径一致）。
- `context_chars` 是注入长度；`additional_context` 的正文不进日志，只留长度和 `hook` 名。
- 不新增协议消息：`hook_result` 走现有 `event`，旧前端按"未知 kind 忽略"处理（协议已经是这个规则）。
- `--audit` 的汇总加一行"hooks: invoked / denied / failed / skipped"；这是阶段 2 的便利，不是阶段 1 的阻塞项。
- `status_message` 阶段 1 只进 `--debug` 的 stderr；阶段 3 再做 `ui(hooks)` 面板/状态行。

---

## 12. 与现有机制的关系

| 机制 | 关系 |
| --- | --- |
| `permissions.json` | 声明式"允许什么"，可以记住；hooks 是可执行"我的工作流"，不记任何决定。工作区允许规则写前者，不写后者 |
| `internal/security` | hooks 接在闸门旁边，不替换闸门；`policy deny` 永远第一 |
| 技能（skills） | 技能是给模型的说明，hooks 是给运行时的确定性动作；技能不能拦调用，hook 不能改技能 |
| MCP | MCP 增加工具（模型可见），hooks 观察/约束已有调用（模型不可见）；MCP 工具同样过 hooks |
| 工作区记忆 | 记忆是"这个工作区知道什么"，上下文进尾部；hooks 的上下文也只进尾部，但生命周期更短（一轮/一批） |
| Goal / 自动轮 | `stop` 的 `block` 在 `autonomous` 轮里被忽略；续轮权归 goal driver，避免两个"继续"来源打架 |
| 子代理 | 子代理继承工具 hooks（guardrail），不继承提示词/轮次/会话 hooks；`subagent_start` 可以拒绝派生 |
| Context / 压缩 | `pre_compact` 只观察和补充提示，不改 `FoldPoint`；压缩后的断言仍然由 `context_compacted` 负责 |

---

## 13. 失败模式与答案

| 失败 | 后果 | 答案 |
| --- | --- | --- |
| hook 挂死 | 一次工具调用卡住 | 超时 + 杀进程树；闸门事件 fail-closed |
| hook 输出坏 JSON | 决定不确定 | 按失败处理，不"猜一个 allow" |
| hook 输出超上限 | 内存/解析风险 | 按失败处理，不截断后解析 |
| hook 崩溃（非 0） | 同上 | `fail_closed` 决定；记录 `exit_code` |
| hook 改写参数后不合法 | 模型拿到 `invalid_args` | 不回退原参数；原因写清"hook 改写后不合法" |
| hook 无限续轮 | 一轮永远不结束 | `max_stop_blocks`（默认 3，硬上限 10），每次 `hook_result` 记 `action=continue_turn` |
| hook 注入超长上下文 | 请求爆预算 | 单条 8 KiB / 总计 32 KiB，截断并审计长度 |
| hook 泄露工具结果 | 数据外泄 | hook 是用户代码，和 shell 同级信任；工作区 hooks 默认不加载 |
| 仓库自带 hooks | clone 即执行 | 默认忽略 + 通知；阶段 2 显式信任 + 只能收紧 |
| 模型改 hooks 文件 | guardrail 被绕过 | 内置写保护（`write_file`/`edit_file`）；shell 绕过要写进文档，不假装能防 |
| 并行批次顺序漂移 | 重放 payload 不同 | 准备阶段串行、post 结算后按模型顺序串行 |
| 会话文件被注入污染 | 审计不可复现 | 上下文只进尾部，不进历史；`turn`/`batch` 两段生命周期 |
| Windows 引号/路径 | hook 起不来 | 推荐 argv 数组；字符串形式走 `cmd /c`，单测覆盖空格/中文路径 |
| 子代理并发写审计 | 日志交错 | 审计 sink 本来就有 mutex；`hook_result` 带 `subagent_id` |
| 用户想临时关掉 | 只能删配置 | `enabled: false` + `--no-hooks`（并留通知） |
| 配置写错静默失效 | "我明明配了" | 未知键/未知事件/坏正则是启动错误；文件不存在才是"没有 hooks" |

---

## 14. 测试计划

**`internal/hooks` 单测**

- 配置：缺 `version`、未知键、未知事件、重复 `name`、坏正则、超时越界 → 错误；
  文件不存在 → 空 `Set`。
- matcher：空、精确、`a|b`、子串语义、大小写（按 RE2 默认，大小写敏感）。
- 聚合：两个 allow、allow+deny、deny 短路、ask 粘性、fail_closed 超时、坏 JSON。
- 执行：stdin JSON 形状、stdout 上限、stderr 截断、exit 2、非 0、超时杀进程树（Windows 用
  `TestHelperProcess` 模式，不依赖外部脚本）。
- 环境：只出现允许列表；`TUDOUNI_*` 正确；cwd 是工作区。
- Windows：argv 带空格路径、字符串形式 `cmd /c`、中文路径。

**`internal/agent`**

- `pre_tool_use` deny：handler 没被调用，模型拿到带 hook 名的拒绝文本。
- `updated_input`：handler 收到改写后的参数；改写不合法 → `invalid_args`；原参数不回退。
- `post_tool_use`：上下文出现在**下一次** `Payload()` 的尾部，`Session.MessagesSnapshot()`
  前后字节相同；下一批后旧上下文消失。
- `stop`：block 触发第二次 `RunMessages`；超过上限后停止；`autonomous` 时忽略。
- 审计：每次 hook 一条 `hook_result`，字段齐全；被短路的不执行。

**`internal/runtime`**

- `session_start` 的上下文只进第一次请求；`session_end` 在 `Close` 里触发一次。
- `user_prompt_submit` 拒绝：会话消息数不变，返回 `PromptBlocked`。
- 工作区 `hooks.json` 被忽略且有通知；坏配置 exit 2；`--no-hooks` 有通知。
- `--hooks` 列出正确、被跳过的也在。

**`internal/subagent`**

- 子代理拿到 `subagent` 作用域；`subagent_start` 拒绝时没有子会话、父代理拿到拒绝文本。
- 子代理的 `pre_tool_use` deny 生效；`stop` 不在子代理里触发。

**确定性与并发**

- 同一会话重放两次，`Session` 字节一致（hook 只观察、不改参数时）。
- `runParallel` + `post_tool_use` 在 `-race` 下无数据竞争；注入顺序等于模型顺序。
- 审计 `--audit` 汇总的 hooks 计数与 `hook_result` 行数一致。

**发布前**

- 按 `AGENT.md`：动了 `internal/agent`、`internal/security`、`internal/runtime`、`internal/subagent`，
  跑全量 `make test`；发版走 `make release` 的真实二进制校验。
- 版本号：新功能 → 次版本 +1（当前 `VERSION` 是 `6.28.0`，落地时应为 `6.29.0`，除非同期还有更大的改动）。

---

## 15. 分阶段

### 阶段 1：闸门与上下文（MVP）

- `internal/hooks` 的 config / matcher / runner / decision / context。
- 事件：`session_start`、`user_prompt_submit`、`pre_tool_use`、`post_tool_use`、`stop`、`session_end`。
- 决策：`allow` / `ask` / `deny`、`updated_input`、`additional_context`、`system_message`。
- 信任：只读 `~/.tudouni/hooks.json`；工作区文件忽略 + 通知。
- `--hooks`、`--no-hooks`；`hook_result` 审计；启动通知。
- 子代理继承工具 hooks（作用域字段），`stop` 不继承。
- 验收：一个仓库可以在不写 Go 的情况下拦住 `rm -rf`、给 `git` 命令加只读前缀、
  在工具结果后提醒"本项目用 pnpm"、在轮末跑一次验证并让模型再修一轮。

### 阶段 2：权限替答、子代理、压缩、工作区信任

- `permission_request` advisor（`security.Check` 的 `Advisor`）。
- `subagent_start` / `subagent_stop`、`pre_compact`。
- `~/.tudouni/trust.json` + `--trust-workspace-hooks`；工作区 hooks 只能 deny/ask，
  只允许 `pre_tool_use` / `post_tool_use`。
- `--audit` 的 hooks 汇总；`/hooks reload`（turn 之间）。
- 验收：团队仓库能带一套"只收紧"的 guardrail；用户能在不信任任何项目代码的前提下运行别人的仓库。

### 阶段 3：可选能力（先别做）

- `post_tool_use` 的 `replace_output` / 脱敏：要接受"历史不再是模型实际看到的东西"，必须单独写决策文档。
- `prompt` 型 hook（LLM 裁判）：多一次模型调用和计费路径。
- `ui(hooks)` 面板 / 状态行（协议 16）：`status_message` 实时可见。
- 异步 observe hooks（`post_tool_use` 不阻塞下一轮）：会牺牲"下一轮一定看到结果"的确定性。

---

## 16. 需要确认的开放问题

1. **工作区 hooks 要不要做？** 建议阶段 2 做，且只能收紧；如果团队没有这个需求，永远不做也成立，
   因为 `permissions.json` 已经覆盖"工作区声明允许"。
2. **`post_tool_use` 要不要允许改结果？** 建议阶段 3 再议。它和"会话可复现"直接冲突，不能顺手加。
3. **`stop` 续轮的前端表现**：第一轮的答案已经画在屏幕上了，第二轮是"同一条用户消息的续答"还是
   "一条新的 runtime 消息"？建议阶段 1 先按新的 `run_started` 处理，阶段 2 再用 `hook_result`
   的 `action=continue_turn` 让前端画成续答。
4. **`updated_input` 的深合并**：本文选"对象递归、数组替换、null 删除"。如果实现成本高于预期，
   退回到"整体替换"也可以，但要把规则写进 `--hooks` 的输出，别让用户猜。
5. **是否需要 `max_hooks` 上限**（比如单事件 16 条）？建议有，防止一份配置把每次工具调用变成几十个进程。

---

## 17. 参考

- Claude Code hooks reference — <https://code.claude.com/docs/en/hooks>
- Claude Code hooks 完整指南（事件、退出码、`hookSpecificOutput`）—
  <https://hidekazu-konishi.com/entry/claude_code_hooks_complete_guide.html>
- OpenAI Codex hooks（配置形状、`statusMessage`、信任）—
  <https://learn.chatgpt.com/docs/hooks>
- Gemini CLI hooks（`BeforeTool` / `AfterTool` / `BeforeModel` / `continue:false`）—
  <https://geminicli.com/docs/hooks/>、<https://geminicli.com/docs/hooks/reference/>
- Cursor hooks（`hooks.json`、`beforeShellExecution`、`failClosed`）—
  <https://cursor.com/docs/hooks>
- OpenCode plugins（`tool.execute.before/after`）— <https://opencode.ai/docs/plugins/>
- LangChain agent middleware（`before_model` / `after_model` / `wrap_tool_call`）—
  <https://docs.langchain.com/oss/python/langchain/middleware/custom>
- 本仓库相关代码：`internal/agent/agent.go`、`internal/security/gate.go`、
  `internal/runtime/composition.go`、`internal/runtime/session_io.go`、`internal/subagent/spawn.go`、
  `internal/audit/jsonl.go`

---

## 18. 实施记录（与上面正文的差异）

上面是方案原稿，落地时在若干处必须做选择或发现正文不足以回答，全部记在这里。**正文与本节冲突时以本节为准。**

### 18.1 代码落点

`internal/hooks/` 的七个文件与 §10.1 的草图一一对应，多了两个：

| 文件 | 内容 | 与 §10.1 的差异 |
| --- | --- | --- |
| `event.go` | `Event`、`Envelope`（自定义 `MarshalJSON` 扁平化）、`Base`、输入截断 | 多了一个 `Base`：信封的公共字段由运行时"盖章"，否则每个调用点各拼一遍，总有一处 mode 会是错的 |
| `config.go` | `Load` / `Parse`、默认值、未知键/正则/重名/上限校验、`Describe`、`ProtectedPaths` | `ProtectedPaths` 是 §7.3 需要的，正文没给落点 |
| `decision.go` | `Decision`、`Output`、`Outcome`、`Result`、聚合规则、`MergeArguments`、四种给模型的文案 | `MergeArguments` 导出，避免 `agent` 再实现一遍深合并 |
| `runner.go` | `Set.Fire`、逐条 exec、超时、输出上限、进程树清理、`Runner`/`Filter`/`Configurable` 三个接口 | 接口拆成三个：`Filter`（`Has`）是可选的"有没有人听"，`Configurable` 是运行时持有的那个 |
| `context.go` | `Context`（Turn/Batch 两段）、`Part`、`RenderContext`、上限、`PromptBlocked` | `Part` 列表 + 一次性渲染，避免多事件拼出来的块**套娃** |
| `trust.go` | `TrustStore`、`HashFile`、`Restrict`、`RestrictSet`、`TrustCommand` | 阶段 2 提前实现（见 18.4） |
| `shell_unix.go` / `shell_windows.go` | 字符串命令 → argv（`/bin/sh -c` / `cmd /c`） | 正文只说"平台 shell 字符串"，两个文件是它的实现 |
| `config_test.go` / `runner_test.go` / `testhelpers_test.go` | 单测；runner 用 `TestHelperProcess` 起真进程 | 与 §14 一致 |

### 18.2 正文没写死、实现必须定的几件事

1. **`block` 在 `stop` 上怎么表达。** §6.2 说 `block` 是 `deny` 的别名，于是 runner 把 `{"decision":"block"}` 解析成 `DecisionDeny`；`stop` 的续轮判定因此写成 `result.Decision == hooks.DecisionDeny`。**没有**单独的 `action: continue_turn` 字段——§16 问题 3 提到的那个字段没有实现，前端按"新的 `run_started`"处理。
2. **续轮上限是 3，写死在 `agent.maxStopBlocks`。** 正文说"默认 3，硬上限 10"，实现只做了默认值那一半：10 这个硬上限没有单独的可配置入口，改动它要改常量。
3. **续轮的提示走 payload 尾部，不进历史。** `agent.continueNote`（`stopContinueNote`）与 empty nudge 同一套机制，`Session` 里只多一条 assistant 消息。
4. **`updated_input` 的合并顺序是"链上累积"。** 第二个 hook 通过 `hook_input` 看到的是第一个 hook 改完之后的结果；`Result.Updated` 是最终值。正文§6.3 第 1 条的意思，实现照做。
5. **`hook_result` 的 status 里 `denied` 与 `ok` 是两种"成功"。** 一个干净地说了 `deny` 的 hook 记 `denied`，说了 `allow`/`none` 的记 `ok`；`exit 2` 也记 `denied`。`failed` 只留给超时/崩溃/坏输出/超上限/启动失败。
6. **`--hooks` 与启动通知共用一套文案，但 `--hooks` 会跳过 `hooks.loaded` 那一条**（否则计数打印两遍）。它用的是 `code == "hooks.loaded"` 判断，所以 `i18n` 里那条通知的 code 不能随便改。
7. **环境变量比 §8 多两个**：`TUDOUNI_MODE` 与 `TUDOUNI_HOOK_NAME`（后者正文有）。`TUDOUNI_MODE` 是 `interactive` / `autopilot`，因为 hook 分支"要不要问人"时只看 `autopilot` 布尔值不如看 mode 直白。
8. **工作区 hooks 的 `Restrict` 是事后裁剪**，不是提前过滤：hook 照跑、审计照记，然后 `allow` / `updated_input` / `additional_context` 被丢掉并写进 `refused` 列表。`RestrictSet` 在加载期就把不允许的事件摘掉（`stop` 之类根本不跑）。
9. **`pre_compact` 的上下文只进摘要提示词**，不进请求尾部，也不动 `FoldPoint`。见 `agent.Config.HookPreCompact`。
10. **`subagent_start` 的上下文注入到子代理的尾部**，不是父的。父代理没问那个问题。
11. **`session_end` 只触发一次**，用 `sync.Once` 保护：`CloseForSwitch` 标了原因后调用 `Close`，两次都触发的话，写报告的 hook 会写两遍。
12. **`--no-hooks` 会跳过读取文件本身**，所以坏文件 + `--no-hooks` 也能起来。这一条比"只跳过执行"强，是有意的：坏掉的 guardrail 拒绝的正是修复它要用的工具调用。
13. **合并两个文件时按 `Source` 而不是按集合打标。** 工作区 hooks 与用户 hooks 在同一个 `Set` 里，`Set.Restricted bool` 无法表达"哪些 hook 受限"，所以限制写在每个 `Hook.Source` 上（`user` / `workspace`），由 runner 在每次调用时判定。
14. **工作区 hooks 的收紧发生在 `runner.tighten`，在聚合之前、审计行之前。** 顺序是有意的：hook 照跑、审计照记，然后 `allow` / `updated_input` / `additional_context` 被摘掉并写进 `Outcome.Restricted`（审计字段 `restricted`）。所以日志能回答"这个仓库的 guardrail 试过放行，被拦下了"，而不是看起来根本没跑。
15. **`Merge(user, workspace)` 的顺序就是信任顺序。** 用户 hook 先跑，仓库的在后；同名不覆盖、两个都跑，所以任何一方的 `deny` 都还生效。
16. **`Runtime.Hooks` 用 `configuredHooks()` 转换，避免 typed-nil。** 直接把 `*hooks.Set(nil)` 赋给 `hooks.Configurable` 会得到一个非 nil 接口，于是 `if r.Hooks != nil` 全部判错、每次工具调用白跑一次 nil-safe 的 `Fire`。`--no-hooks` 与"没有文件"都必须真的让 `Hooks == nil`。
17. **`status_message` 走 `--debug`**（§11 的原意）：每次调用一行 `[hook] <event> <status_message|name> → <status> (<n>ms) · <tool>`。`--debug` 关时连字符串都不拼。

### 18.3 已知未做 / 已知限制

- **桌面端没有 hooks 面板**（阶段 3）。`--hooks` 是命令行开关，TUI 与桌面端都没有对应面板。启动通知会到桌面的 NoticeCenter（`notice.hooks.*` 走 `stream: "err"`）。
- **`hook_result` 只在桌面端有可见行**：`denied` → 一条 info 行，五种失败状态 → 一条 warn 行（`status` 不翻译，便于搜日志）；`ok` / `skipped` 不画。**TUI 侧未做对应行**——它按决定只做运行时与协议，界面行是阶段 3 的事，这是留下的不对称。
- **`stop` 续轮的前端表现**按 §16 问题 3 的建议途径 A：第二轮是新的 `run_started`，不是同一轮的续答。桌面端的回合头会因此多一个 turn；`notice.hooks.continue_turn` 是在轮次结束之后 drain 的（`protocol.Server.finishTurn`），提示会落在答案之后。
- **`replace_output`（脱敏）没有做**，`post_tool_use` 只能加 `additional_context`。
- **`prompt` 型 hook（LLM 裁判）没有做**。
- **`/hooks reload` 没有做**：改配置要新开会话。
- **`--audit` 的 hooks 汇总已做**（`audit.summary.hooks`：invoked / denied / failed / skipped），比正文说的"阶段 2 便利"提前了。
- **哈希的是 `hooks.json`，不是它引用的脚本**（§7.2 已声明）。`ProtectedPaths` 会把脚本也列进"不许模型写"的名单，但信任判定只看 `hooks.json`。

### 18.4 阶段划分的实际结果

| 阶段 | 正文 | 实际 |
| --- | --- | --- |
| 1 | config/matcher/runner/decision/context + 六个事件 + `--hooks`/`--no-hooks` + 审计 + 子代理继承 | 全部做完 |
| 2 | `permission_request`、`subagent_start`/`subagent_stop`、`pre_compact`、`trust.json` + `--trust-workspace-hooks`、`--audit` 汇总、`/hooks reload` | 除 `/hooks reload` 外做完，另加桌面端 `hook_result` 的两种可见行 |
| 3 | `replace_output`、`prompt` hook、`ui(hooks)` 面板、异步 observe | 一项都没做 |

### 18.5 测试落点

| 文件 | 覆盖 |
| --- | --- |
| `internal/hooks/config_test.go` | 缺 version、未知键/事件、重名、坏正则、超时越界、上限；matcher 语义；输出解析（未知 decision、deny 无 reason、尾部垃圾、事件能力边界）；深合并；信封扁平化与截断；`Restrict`；信任哈希；`Context` 生命周期与预算 |
| `internal/hooks/runner_test.go` | 真进程（`TestHelperProcess`）：三种决策、exit 2、静默、gate fail-closed / observer fail-open、超时、超上限、启动失败、deny 短路、ask 粘性、matcher 跳过、改写、上下文、环境白名单、stdin 形状、审计行数 |
| `internal/hooks/trust_test.go` | 工作区 hook 的 `allow`/改写被摘、`deny`/`ask` 保留、用户 hook 三种能力都在、`restricted` 进审计；`Merge` 的先后与不共享切片；`RestrictSet` 打 `workspace` 来源；`status_message` 进 `--debug`（含 skipped 的那一行） |
| `internal/agent/hooks_test.go` | pre deny 不进 handler、ask 强制问人、autopilot 里 ask 变拒绝、allow 只跳过提问、policy deny 压过 hook allow、改写到达 handler、改写不合法→invalid_args、post 上下文只进下一次请求、批次上下文被下一批替换、stop 续轮与上限、autonomous 忽略 block、尾部位置、守护文件 |
| `internal/runtime/hooks_test.go` | session_start 只进第一轮、session_end 只触发一次、prompt 拒绝不动会话、stop 通知 drain、坏配置 exit 2、`--no-hooks` 跳过、工作区文件被忽略且有通知、工作区信任（loader 层） |
| `internal/runtime/hooks_assembly_test.go` | 走真实 `OpenRuntime`：工作区 hooks 被折叠进来、顺序与 `Source`、`stop` 被摘、`guardrailPaths` 含两个文件、`--no-hooks` 两个文件都不读；外加一条"测试夹具确实把 HOME 搬走了"的护栏（首版测试污染过真实 `~/.tudouni`） |
| `desktop/tudouni-aigo-desktop/tests/hook-result.test.ts` | `denied` 画一行 info、五种失败状态画一行 warn、`ok`/`skipped` 不画、会话级不被当"迟到"丢弃、句子保留 hook 名字与原文且 status 不翻译 |

### 18.6 实施后修掉的三个缺口

首轮实现通过了全部测试，但仍然有三个洞，都是"测试盖住了错误的层"这一类：

| 缺口 | 症状 | 修法 | 现在的回归测试 |
| --- | --- | --- | --- |
| `LoadWorkspaceHooks` 从未被组装期调用 | `--trust-workspace-hooks` 写了 hash，仓库的 guardrail 仍然不跑。单测盖的是 loader 本身，所以一直是绿的 | `assembleHooks` 在 `OpenRuntime` 里调用，先用户后工作区，走 `hooks.Merge` | `hooks_assembly_test.go` 走真实 `OpenRuntime`；把调用换回 `LoadHooks` 会失败（已做 mutation 验证） |
| `hooks.Restrict` 从未被生产代码调用 | 即使加载了工作区 hooks，"只能收紧"也不生效：`allow` / 改参数 / 注入上下文全部照做 | 限制改成按 `Hook.Source` 判定，在 `runner.tighten` 里执行，审计行带 `restricted` | `trust_test.go`：工作区的 allow/rewrite 被摘、deny/ask 保留、用户 hook 三种能力都在 |
| `status_message` 解析后无人消费 | 配了 `status_message` 的人和没配的人看到的东西完全一样 | 接进 `--debug`（`Set.SetDebug`），每次调用一行 | `trust_test.go`：`TestStatusMessageReachesTheDebugLine` 等三条 |

顺带修掉一个只在 `--no-hooks` 下出现的 typed-nil：`*hooks.Set(nil)` 赋给 `hooks.Configurable` 得到非 nil 接口，于是所有 `Hooks != nil` 判断都错、每次工具调用白跑一次 `Fire`。见 18.2 第 16 条。
