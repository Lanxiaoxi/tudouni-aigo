# tudouni-aigo 桌面端总体设计

**范围**：用 Tauri 2 + React 实现桌面客户端，驱动现有的 Go 运行时。
**不在范围内**：运行时本身的改动（除本文末尾列出的、必须由运行时配合的少数几处）。

---

## 1. 一句话架构

桌面端**不是把内核搬进 App**，而是：

```
┌─ Tauri 2 应用 ────────────────────────────────────────────┐
│  WebView (React 19 + Vite)   ←→   Rust 壳（Tauri core）    │
│        界面、状态、i18n              进程管理、IPC、窗口     │
└──────────────────────────────────┬───────────────────────┘
                                   │ stdin/stdout：JSONL，一行一条
                          tudouni-aigo --runtime-stdio
                                   │
                            智能体循环 / 工具 / 权限 / 模型
```

运行时是**独立子进程**，与 TUI 走的是同一套协议。桌面端只是**换一个前端**：协议上能表达的东西必须全部覆盖，协议上不存在的数字一个都不许自己算。

这条边界的价值在于：`internal/frontends/tui/` 里已经有一个把这套协议用满的前端，桌面端的功能面以它为参照物即可，不需要重新设计交互语义。

---

## 2. 事实基础（本设计的依据）

| 来源 | 作用 | 权威性 |
| --- | --- | --- |
| `internal/protocol/`（codec.go / messages.go / server.go / client.go / serve.go / channels.go） | 协议的真实形状与实现 | **权威** |
| `protocol/schema/inbound.schema.json`、`outbound.schema.json` | 逐字段的形状与语义说明 | **权威**（与代码互证） |
| `docs/spec/protocol.md` | 语义（什么时候发、收到怎么办） | 语义**可用**，但**文档本身是上一代（Python）写的**：正文里的启动示例是 `sys.executable -u .../main.py`。形状看 schema，启动方式看 §3.2（照抄 `internal/protocol/client.go`） |
| `desktop/tudouni-aigo-desktop-design/desktop-ui-spec.md` | 功能面清单：7 分区、12 类流条目、5 侧栏区块、2 模态、键位 | 需求 |
| `desktop/.../tudouni-aigo/`（MASTER.md、tokens/、docs/） | 设计系统、token、组件状态、Tauri 原生层规范 | 需求 |
| `desktop/.../webui/` | React 原型：分层、状态模型、面板划分 | **参考实现**（协议层已过期，见 §5） |

> ⚠️ 原型 `webui/src/protocol/types.ts` 是按一份较早的设计文档写的，**与真实协议不一致**。它作为「界面怎么组织」的参考是好的，作为「协议长什么样」的依据是错的。§5 给出逐项差异，这是本文最重要的一节。

---

## 3. 进程模型

### 3.1 三方职责

| 层 | 职责 | 不该做的事 |
| --- | --- | --- |
| **React（WebView）** | 画界面、归约流条目、持有本地偏好（主题/折叠/草稿）、i18n | 不推导任何运行时事实；不做乐观更新 |
| **Rust（Tauri）** | 启动/守护子进程、JSONL 收发、窗口与菜单、文件对话框、退出码 | 不解析业务语义（不知道 `tool_call` 是什么） |
| **Go 运行时** | 智能体循环、工具、权限判定、压缩、审计、会话持久化 | —— |

Rust 层刻意**只做字节搬运**：它把一行 JSON 原样交给 WebView，把 WebView 发来的一行原样写进 stdin。任何在 Rust 里解析 `kind` 的冲动都会造出第二份协议定义，而它一定会漂。

### 3.2 启动契约（照抄 `internal/protocol/client.go` 的四条细节）

1. **用绝对路径的同一个可执行文件**，不是从 PATH 找 `tudouni-aigo`。PATH 上的另一个构建是另一个程序，症状是「子进程立刻退出，我只读到 EOF」。
2. 参数：`--runtime-stdio`。可选追加 `--session <id>`、`--autopilot`、`--max-steps <n>`、`--stream`。
3. **工作目录 = 工作区**。运行时把 cwd 当作工作区（`paths.WorkspaceDir()`），文件工具的边界就是它。桌面端必须显式设 `current_dir`，不能沿用 App 自己的启动目录。
4. **stderr 必须被读走并丢弃**（不是 `null`、不是关闭）。给它一个管道持续 drain：关闭的描述符会让子进程在写诊断时以莫名其妙的方式失败；而把 stderr 接到 App 自己的 stderr 上，在 GUI 里根本看不见。真正要给人看的东西运行时会走 `notice` 消息。

> 关于第 4 点的落地建议：drain 的同时**保留最近 N 行环形缓冲**，仅用于「运行时启动失败」的本地诊断面板。这不是协议的一部分，不要把它当业务数据。

### 3.3 握手时序

运行时在进入读循环前就 `emitOpening()`，**第一条永远是 `init`**，紧跟 0 或 1 条 `session_load`。

因此存在一个经典竞态：进程已起、`init` 已到，而 WebView 的监听器还没注册。原型在 `useRuntime.ts` 里用 `useLayoutEffect` 规避（Go 的 `Client` 则是在 `Start` 之前就装好 hooks）。

**Tauri 下的建议做法**：Rust 启动子进程后**先把收到的行推进一个队列**，直到 WebView 调用 `runtime_attach` 才开始转发，然后**按序 flush 队列**。这比「让前端尽量早注册」可靠——WebView 的加载时机不受我们控制。

### 3.4 退出语义

| 动作 | 含义 | 注意 |
| --- | --- | --- |
| `shutdown` | 收摊，**当前这一轮会跑完** | 不是打断。打断会留下「有 tool_calls 没有 tool_result」的助手消息，那个会话**永久不可再发送** |
| 关闭窗口 | 先 `shutdown`，超时（Go 那边是 30s）再 `kill` | 超时兜底必须有，否则关不掉 |
| `interrupt` | 中断当前这一轮 | 切在回合边界上，不是随时可停 |
| 子进程意外退出 | 前端必须**说出来** | 见下 |

子进程死亡时，Go 的 `Client` 会合成一条 `{"v":1,"t":"runtime_exited"}`（**无负载**），退出码通过 `RuntimeExited()` 读回。桌面端的等价物：Rust 在 `child.wait()` 返回后 `emit("runtime_exited", {code, requested})`。

`requested` 这个布尔不能省：**「会话结束了」和「运行时死了」必须分开**——自己请求的关闭和 stdin 关闭导致的退出，退出码都是 0。

### 3.5 单实例（决策 12）

用 `tauri-plugin-single-instance`：第二个实例**只把已有窗口拉回前台**并退出，**不启动新的运行时**。

理由是工作区状态：`<workspace>/.tudouni/` 下有 `permissions.json`、`mcp.json`、会话文件、审计日志和 artifacts。两个实例对同一工作区各跑一个运行时，会同时写这些文件。

**附带要做的一件事**：单实例的「二次启动」参数要能传递（用户可能想用第二个实例打开**另一个工作区**）。建议二次启动只聚焦已有窗口；「换工作区」走应用内入口，另行处理。

---

## 4. 协议契约（实现必须逐条遵守）

### 4.1 信封

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `v` | 整数，当前 `1` | 信封版本。**这是唯一的硬失败点**：不匹配就断流 |
| `t` | 字符串 | 消息类型 |
| `kind` | 字符串 | 某些类型的子类型，**与 `t` 平级**，不是嵌套 |

另有 `init.protocol` = 会话的语义版本，当前 **3**。它与 `v` 是两件事：`v` 不匹配是硬失败，`protocol` 不匹配是可存活的——不认识 `delta` 的前端忽略它即可，完整答案仍会从 `ui(run_finished).answer` 到达。

**消息是 map 不是 struct，这是有意的**：两端各自升级，规则是「不认识的就忽略，继续走」。

### 4.2 容错行为

- 单行 JSON 解析失败 → **跳过并计数**，不断流。半行数据（写方被杀）是现实存在的。
- 空行 → 忽略。
- 未知 `t`、未知 `kind`、多余字段 → 忽略。
- 单行上限 **256MB**（`maxLineBytes`）。这不是理论值：`session_load` 把整个会话的消息一次性发过来，其中可能有 `read_file` 读到的 8MB 文件。**Rust 侧的读取器必须能处理超长行**（`BufReader::read_line` 可以，但不要设小缓冲上限；用 `read_until(b'\n')` 更稳妥）。

### 4.3 入站消息全集（前端 → 运行时）

| `t` | 必填键 | 语义要点 |
| --- | --- | --- |
| `user_message` | `text` | 跑一个回合 |
| `session_switch` | （`session_id` 可选） | **原地换会话，进程不动**。`session_id` 缺失/`null` = **新会话**（id 由运行时分配）；给了 id 但文件不存在**也算新会话** |
| `session_list` | —— | 回答是 `sessions` |
| `interrupt` | —— | 中断当前轮 |
| `set_autopilot` | `on`(bool) | **绝对状态，不是开关动作**，幂等 |
| `set_model` | `model` | 必须在 `init.model_catalog` 里，**精确匹配，不做模糊** |
| `set_thinking` | `on`(bool) | 绝对状态 |
| `set_effort` | `effort` | 只认当前模型声明的档位；认不出来的回 `notice`，什么都**不改**（不做折算） |
| `status` / `tools` / `context` / `compact` | —— | 按需取大屏数据，分别回 `ui(status/tools/context/compacted)` |
| `mcp` | `action` | `list` / `load` / `unload`；**要动的 server 在 `servers` 数组里**（不是单个 `name`） |
| `skills` | —— | 回技能目录 |
| `goal` | `action` 可选 | `pause` / `resume` / `clear`；**空 action = 只查状态** |
| `refresh_state` | —— | 空消息。**只在知道自己有东西悬着时发**（如 `jobs` 有未收结果），且要节流——它不是心跳 |
| `permission_response` | `id`, `decision` | `decision ∈ {allow, deny, always, always_group}` |
| `question_response` | `id`, `status`(+`text`) | `status ∈ {answered, skipped}`。**`unavailable` 由运行时自己产生，前端永远不回它** |
| `shutdown` | —— | 收摊 |

**两条纪律**（来自 `protocol.md`）：

- `mcp` **只由人按键触发**。前端不许在启动、回合结束、收到别的消息时自己发一条——那会让「配置自己变宽」成为可能。
- `set_*` 的界面显示**以运行时回的 `ui(state)` 为准**，不在发出请求时就改显示。

### 4.4 出站消息全集（运行时 → 前端）

| `t` | 负载 | 关键点 |
| --- | --- | --- |
| `init` | 见下 | 永远是第一条 |
| `session_load` | `messages`（原样数组） | 0 或 1 条，紧跟 init；可能是几 MB |
| `event` | **审计记录原样转发**，`kind` 与 `t` 平级 | 16 种 kind，见下 |
| `ui` | `kind` 与 `t` 平级 | 8 种 kind，见下 |
| `delta` | `session_id, run_id, step, channel, text, reset` | 流式增量 |
| `delta_reset` | `session_id, run_id, step` | 作废某一步已画出的增量 |
| `notice` | `level, code, text` | **`code` 是机器认的类别**（info/warn） |
| `sessions` | `items` | 会话清单 |
| `permission_request` | 见 §4.6 | **阻塞** |
| `question_request` | 见 §4.7 | **阻塞** |
| `runtime_exited` | 无 | **由客户端自己合成**，见 §3.4 |

#### 4.4.1 `init` 的字段

```
v, t, protocol, session_id, resumed,
model, provider, thinking, effort, effort_levels, model_catalog,
workspace, max_steps, stream, context_tokens,
tools[], permissions{}, audit_path, notices[]
```

要点：

- `model` 与 `provider` **分开是有意的**：两条路由可以有同名模型，而「请求发到哪儿」在账单和合规上是另一件事。
- `thinking` 默认开；`effort` **思考关着时仍然有值**——那是用户的意图，不是错误状态。界面**照实显示，不折算**。
- `effort_levels` **随协议下发，前端绝不许写死**。模型没声明时是一整套 `minimal/low/medium/high/xhigh/max`。
- `model_catalog` = `{models: [...], aliases: [...]}`，是 `/model` 面板的数据源。`aliases` 是**认下但不在清单里**的旧模型名。
- `context_tokens` **可能为 `null`**。为 null 时界面**只报用量，不报百分比**——错的百分比比没有百分比更坏。
- `permissions` **只含非默认项**，默认时是空对象。「什么算非默认」是 config 的知识，由运行时决定，前端不硬编码默认值。
- `tools[]` 每条：`{name, risk: low|medium|high, parallel_safe, interactive}`。
- `notices[]` 每条：`{level: info|warn, code, text}`。

#### 4.4.2 `event` 的 16 种 kind

`run_started` · `model_call` · `tool_call` · `tool_result` · `permission` · `tool_batch` · `run_finished` · `delta_reset` · `context_degraded` · `context_compacted` · `image_attached` · `goal_round` · `subagent_started` · `subagent_problem` · `delegation_started` · `delegation_finished`

信封公共字段：`v, t, kind, session_id, run_id, step, ts`。其余字段随 kind 不同。`model` 字段**只有 `model_call` 有**。

**`run_finished` 有两处**：`event(run_finished)` 和 `ui(run_finished)`。它们是**两条消息，顺序不保证**，只能靠 `run_id` 配对。前端必须两边都处理，且不能假设谁先到。

##### 只有一部分 kind 的 `run_id` 指向一个回合

**这条是整个 `event` 契约里最容易写错的地方**，写错的后果是「行一行都不显示，而没有任何报错」：

| kind | `run_id` 是什么 | 能否按 `run_id` + `step` 归到当前回合 |
| --- | --- | --- |
| `run_started` `model_call` `tool_call` `tool_result` `permission` `tool_batch` `run_finished` `delta_reset` `context_degraded` | **本回合的 run id** | ✅ |
| `image_attached` `context_compacted` `goal_round` `subagent_started` `subagent_problem` | **空串**（会话级事件） | ❌ |
| `delegation_started` `delegation_finished` | **子代理的 id**（父代理对自己委派的记账） | ❌ |

于是「用 `run_id` 配对当前回合」这条规则**只能用在第一组**。对第二、三组用它，从第二回合起 `"" !== lastRunId` 恒成立，图片行、自动压缩、目标轮次、委派记录会被**全部判成晚到消息丢掉**并计入 dropped。

正确做法：**按白名单**决定哪些 kind 走回合配对，其余（包括本版本不认识的 kind）一律接受 + 忽略未知字段——对未知 kind 来说「接受并忽略」不会丢东西，而「丢弃」会让未来协议版本的行直接消失。

#### 4.4.3 `ui` 的 8 种 kind

| kind | 负载要点 |
| --- | --- |
| `run_finished` | `answer`（**本轮的最终正文**）、`run_id`。非流式下这是拿到答案的**唯一**途径 |
| `state` | 面板快照，见下 |
| `status` | 分组快照：`session` / `model` / `counters` / `usage` / `meta` |
| `tools` | 每工具一条：`{name, risk, disposition: auto|ask|deny, parallel_safe, interactive, external, granted, command}` |
| `mcp` | `mcp_servers[]` + `mcp_notes[]` |
| `skills` | `skills[]`（**这个会话能加载的全量目录**）+ `active[]`（**已加载**的名字，按加载顺序）+ `roots[]` / `problems[]` / `shadowed[]`（后两者已经是渲染好的整句） |
| `compacted` | `compaction{status, folded, total_folded, summary_id, summary_chars, generation, before, after, duration_ms}` + 一份 `context` |
| `context` | 上下文那一屏。**注意它是个容器**：账本在里面（见下） |

**`skills` 与 `active` 是两个不同的事实，不能混。** `ui(skills).skills` 是「能加载哪些」，没有 digest；`ui(state).skills` 是「已加载哪些」的指针，带 digest；`ui(skills).active` 才是「已加载哪些」的名字。把目录当成已加载，会让「目录减去已加载」永远是空集——面板里那段差集就永远不出现。

**`ui(context)` / `ui(compacted).context` 的层级**（实测自 `internal/runtime/composition.go: contextPayload`）：

```json
{"v":1,"t":"ui","kind":"context","context":{
   "context":{"artifacts":0,"compact":0,"compact_threshold":806681,"degraded":0,
     "estimated_tokens":3791,"items":0,"limit_tokens":896313,"open":0,"pinned":0,
     "removed":0,"stable":0,"version":0},
   "window":1000000,"messages":1,"active":false,"folded":0}}
```

- 外层对象是「context 这个功能」，内层 `context` 才是账本（`ContextManager.stats()` 的原样）。**`window` / `messages` / `active` / `folded` / `generation` / `summary_id` / `summary_chars` 也在外层**，不在消息顶层——本文件早先写成「扁平」是错的，照着写会得到一排 `unknown`。
- `degraded` 是**个数**（`len(LastDegraded)`），不是布尔。当成布尔判断会恒为 null，永远显示不出来。
- **没有上下文管理层时外层是空对象**——此时要显示「这里没有上下文管理」，**不能**画一排 0：一排 0 读起来是「开着但什么也没做」，那是另一个、并且是假的陈述。

**`ui(state)` 的实际字段**（以 `internal/runtime/composition.go: StateMessage` 为准）：

```
todos, skills, jobs, subagents, messages, steps,
model, model_provider, model_window, thinking, effort, effort_levels,
autopilot, granted_tools, granted_prefixes, denied_tools,
risk_scope, agents_md, mcp, goal
（首条快照另带 skill_catalog）
```

- `jobs[]`：`{id, command, state: running|uncollected|done|killed, seconds, exit_code}`。**未收结果的是 `uncollected`**，「什么样的组合算还没收」由运行时算好，界面照着渲染。
- `mcp[]`：`{name, state: loaded|unload, tools, where}`。**运行时只发得出这两个 state**（`mcpInventory` 没有别的分支）；「我们试过没成」是 `mcp_notes` 里的一句整话（`server \`x\` did not connect (…)`），不是 row 上的状态。所以前端**不能**把「配置里有但没跑」和「试过没成」画成一样——句子在的时候，要贴在那一行旁边。`where` 远程**只到 `scheme://host`**（URL 里可能有令牌）。
- `risk_scope[]`：`[{risk, disposition: auto|ask}]`。**处置由运行时算**，界面不该知道「默认只有 low」。
- `goal`：**两种情况都有形状**（无目标时是空形状，不是缺字段）。
- **空列表一律发 `[]`，绝不发 `null`**。前端不需要区分「没有」和「没说」。

### 4.5 `delta` / `delta_reset`

- 必须按 `channel` 分流：`text` = 正文，`reasoning` = 思考链。**两个通道都是字符串**，猜错会把一段自言自语混进答案。
- `text` 是**新增的那一段**，不是累计正文。累计是客户端的事。
- `reset` 字段**保留、恒为 false**，清空走独立的 `delta_reset`。
- 按 `run_id` + `step` 归属。**迟到的消息要能丢掉**——不能靠「先来后到」。
- `delta_reset` 只清**那一步**，不清整个回合（前几步已定下的内容不该被抹掉）。

### 4.6 `permission_request`（阻塞模态一）

```
id, call_id, tool, risk,
arguments,            ← 对象，全文不截断
remember,             ← {tool: "shell"} 或 {prefix: ["git","add"]}，可为 null
remember_hint,        ← 一句话，原样显示，一字不许改
allow_trust_all,      ← bool，false 时必须隐藏那个按钮
trust_all_hint        ← 一句话，原样显示（它多担一件事：说清这是快照）
```

- `arguments` **全文，一个字符都不许截断**：高风险命令的关键常在后半句。它不是事件的伴随字段，而是**给人做判断的那份材料**本身。
- 两句 hint **原样显示，一字不许改**（决策 2 的全英文决定也涵盖此处的英文原文——它们是运行时拼好的英文，前端**不翻译**）。
- `remember` 为 null ⇒ **不显示「总是允许」**。给一个没东西可记的「总是允许」，就是一个看起来生效、实际什么都没改的键。
- `allow_trust_all` 为 `false` ⇒ **必须隐藏「全部允许」**。两个字段都缺 ⇒ 只剩「允许 / 拒绝」。
- `always_group` 的含义是「我同意放行这一组」，**具体覆盖哪些工具由运行时按 id 查它手里的快照**。前端不许自己带名单——那等于让客户端改写策略。

> **决策 10** 已确认上述显隐规则。拒绝与关闭同义（`deny`）。

### 4.7 `question_request`（阻塞模态二）

```
id, question, header, options[], multi_select
```

- `options` 是 **`string[]`**（不是对象数组），**空数组 = 让用户自由作答**。
- `header` 不超过 12 字，空串表示没有。
- 回答只有两种：`answered`（带 `text`）/ `skipped`（`text` 为空串）。
- **跳过是独立动作**，不许用「空提交」代表没决定。
- 这两个模态**不许自动跳过、不许超时兜底、不许猜一个**——fail-closed。

---

## 5. ⚠️ 原型与真实协议的差异（必须逐条修正）

这是把 `webui/` 接到真运行时时**唯一**需要改的东西（原型的接线点设计得很好：只改 `src/runtime/useRuntime.ts` 一行）。但 `protocol/types.ts` 必须按本节重写。

### 5.1 信封层（影响每一行）

| 项 | 原型 | 真实 |
| --- | --- | --- |
| 版本字段 | 无 | **`v` 必填，整数 `1`** |
| 类型字段 | `type` | **`t`** |
| `event` 的子类型 | 嵌套 `{type:'event', event:{kind}}` | **平级** `{v, t:'event', kind, session_id, run_id, step, ts, ...}` |
| `ui` 的子类型 | 嵌套 `{type:'ui', ui:{kind}}` | **平级** `{v, t:'ui', kind, ...}` |
| 消息缺失 | —— | 无 `runtime_exited` 处理 |
| 行长度 | —— | 未考虑 256MB 上限（`session_load` 可达数 MB） |

### 5.2 入站消息

| 原型 | 真实 | 影响 |
| --- | --- | --- |
| `session_switch{id}` | `session_switch{session_id}` | **新建会话的表示法**：原型用哨兵 `"__new__"`，真实是**缺省/`null`** |
| 无 | `skills`、`goal` | 技能面板与 `/goal` 指令**发不出去** |
| `set_autopilot{enabled}` | `{on}` | 开关发不出去 |
| `set_thinking{enabled}` | `{on}` | 同上 |
| `mcp{action, name}` | `mcp{action, servers: []}` | 单个 vs 数组 |
| `permission_response{action}` | `{decision}` | 取值也不同：原型 `allow\|deny\|always\|allow_all`，真实 `allow\|deny\|always\|always_group` |
| `question_response{action, selected[], text}` | `{status, text}` | **`options` 是字符串数组**，没有 `selected` 这种带 id 的选项；`allow_skip`/`allow_free_text` 是原型的假设 |

### 5.3 出站消息

| 原型假设 | 真实 | 影响 |
| --- | --- | --- |
| `init{version, locale, user_name, session{...}, permission_scope, models, skills_catalog, themes, max_steps, audit_path, context}` | **没有** `version`(有 `v`)、**没有** `locale`、**没有** `user_name`、**没有** `themes` | 首屏问候语的用户名、语言、主题清单**都拿不到**（见 §10 已定决策 1～4） |
| `init.session{id, model, model_route, thinking, effort, max_steps, resumed}` | **扁平**：`session_id, model, provider, thinking, effort, effort_levels, max_steps, resumed` | 重新映射即可 |
| `init.permission_scope{autopilot, ask_on[], remembered_rules}` | **没有这个对象**。有 `permissions{auto_approve[], auto_approve_tools[], deny_tools[], shell_allow[]}`（**只含非默认项**），运行期看 `ui(state)` 的 `risk_scope[]` / `granted_tools` / `granted_prefixes` / `denied_tools` / `autopilot` | 侧栏「权限范围」那一块要**重写来源** |
| `ui(state)` 里 `goal{text, truncated, turn, phase, armed, blocked_reason}` | `goal` 是 `state.GoalSnapshot` 的形状：`{id, objective, phase, rounds_text, armed, limit_reached}` 等（`internal/runtime/goal_round.go`） | 字段名要对齐 |
| `ui(state)` 里 `tasks` | 叫 **`todos`**，`[{content, status: pending\|in_progress\|completed}]` | 状态取值也不同（原型有 `blocked`） |
| `ui(state)` 里 `skills[{name, description}]` | `skills[{name, digest}]`（只是指针，**没有正文**）+ 首条快照的 `skill_catalog[{name, description}]` | 技能列表要**合并两处** |
| `ui(state)` 里 `background_jobs[{id, status, command, duration_ms, exit_code, collected}]` | `jobs[{id, command, state, seconds, exit_code}]` | 字段名与状态机都不同（`uncollected`） |
| `ui(state)` 里 `mcp[{name, state: running\|configured\|failed, tool_count, launch, error}]` | `mcp[{name, state: loaded\|unload\|failed, tools, error, where}]` | 三态改名 |
| `ui(state)` 里 `subagents[{id, label, model, depth, started_ms, calls, activity}]` | **已核实**（`internal/subagent/board.go` 的 `Panel()`）：`{id, label, model, provider, depth, seconds, steps, tool_calls, activity}`。没有 `started_ms`，是 **`seconds`**（相对时长）；也没有 `calls`，是 **`tool_calls`** 与 **`steps`** 两个字段 | 字段名要对齐；`provider` 是新增的（同名模型跨路由时用它区分） |
| `ui(state)` 里 `context{used, window, percent}`、`cache_hit_rate`、`elapsed_ms`、`session_span_ms` | **`ui(state)` 里没有这些**。有 `messages`、`steps`、`model_window`。用量/缓存命中在 **`ui(status).usage`** 和 `ui(context)` 里 | 状态栏右半的取数**要改走 `/status`** |
| `ui(state)` 里 `caps{...}`、`efforts[{id,label,description}]` | **没有 `caps`**（上限是前端呈现层的事，可由设计系统定）；`effort_levels` 是 **`string[]`**，不是对象数组 | 档位面板要自己配 label/description |
| `notice{level, key, text, params}` | `notice{level, code, text}` | 原型的「优先走 key」不成立：**文案已由运行时拼好**，前端直接用 `text` |
| `sessions[{id, message_count, step_count, task_done, task_total, preview, modified_at}]` | `sessions[{session_id, messages, steps, todos, preview, modified_at}]`。`todos` 是**现成的进度文字**（空串 = 没有任务）；`modified_at` 是 **epoch 秒** | 排序键是 `created_at`（不在负载里），要展示的「最后一次聊」是 `modified_at` |
| `ui(compacted){before, after, saved, summary, note}` | `compaction{status, folded, total_folded, summary_id, summary_chars, generation, before, after, duration_ms}` | **没有 `saved`**（自己减？不——那就成了自己推导，改为显示 before/after） |
| `ui(context){sections[], used, window}` | `context` = `session.metadata` 的压缩状态 + `window` + `ContextManager.stats()` 的原样合并（`artifacts/items/open/removed/pinned/estimated_tokens/limit_tokens/compact_threshold/degraded/version`） | 需对齐 |
| `ui(status){phase, action, last_result, step, max_steps}` | `status` 是**分组**的：`session/model/counters/usage/meta` | 状态栏字段映射要重做 |
| `permission_request{builtin, params, hints[2], remember_rule, allow_all}` | `{call_id, arguments, remember, remember_hint, allow_trust_all, trust_all_hint}`。**没有 `builtin`**，**没有 `parallel_safe`/`occupies_input`** | 审批模态的按钮显隐条件要改按 `remember` / `allow_trust_all` |
| `question_request{tags[], options[{id,label,description}], multi, allow_free_text, allow_skip}` | `{header, options: string[], multi_select}` | 选项**不带 id**，回传的是**文本**；没有 tags / allow_free_text / allow_skip |
| 无 | `ui(tools)` 每行的 `disposition`、`granted`、`external`、`command` | `/tools` 面板要重做 |

### 5.4 结论

原型**界面组织**（7 分区、12 条目、5 区块、2 模态、面板划分、状态分层的两组分离）可以整套保留；**协议映射层**必须重写。建议：

1. 重写 `protocol/types.ts`，让它**一比一**对应真实协议（字段名、嵌套层级、枚举取值都不改）。
2. 在 `state/` 与 `protocol/` 之间加一层**纯函数投影**（`runtime/adapt.ts`），把真实协议映射成界面需要的形状。这样界面的入口不变，而「哪来的数字」始终可追溯。
3. 投影层里**不许有默认值兜底**：拿不到就显示「未知」，不要发明一个数字。

---

## 6. 前端架构

沿用原型的分层（这是它最有价值的部分）：

```
src/
  protocol/      真实协议的类型定义（v/t/kind，平级）    ← 唯一真源，照 §4 写
  runtime/
    bridge.ts    Runtime 接口（send / subscribe / dispose）
    tauri.ts     ★ 唯一接真运行时的地方：invoke + listen
    adapt.ts     真实协议 → 界面投影（纯函数）
  state/
    store.ts     zustand：运行时事实 / 前端偏好 严格分两组
    entries.ts   会话流条目模型与归约（归属、去重、清理）
  components/
    chrome/      TitleBar / TopBar / SessionBar / CollapsedSummary / StatusBar / Composer
    stream/      12 类条目 + 流内大屏块 + quiet 分组
    sidebar/     5 区块
    panels/      命令面板 + 8 面板
    modals/      审批、提问
    ui/          原语包装 / 控件 / Markdown
  i18n/          桌面端自己的界面文案（**全英文**，见 §10 决策 2）
  styles/        tokens → 组件 → 应用 → 流
```

### 6.1 状态分层的硬规则

| 组 | 例子 | 规则 |
| --- | --- | --- |
| **运行时事实** | 模型、思考、强度、autopilot、权限范围、任务、技能、后台任务、MCP、上下文、成本 | **只由 `applyRuntimeMessage` 写**，前端只存不造 |
| **前端偏好** | 主题、安静模式、侧栏/思考块折叠、输入草稿、历史 | 前端自己的，不进协议 |

**禁止乐观更新**：点「总是允许」只发出站消息，等 `ui(state)` 回执才改显示。

### 6.2 流归约

- 条目按 `run_id` + `step` 归属，**迟到/乱序的丢掉并计数**（不要在界面里显示成新条目）。
- 本轮正文有**两次出口** (`delta` 流式 / `ui(run_finished).answer`)，**不能都当最终答案渲染**。流式期间用 `delta` 累积展示，收到 `answer` 后以 `answer` 为准替换。
- `run_finished` 的 event 与 ui 两条消息顺序不保证，配对只靠 `run_id`。

### 6.3 与 Rust 的接口（建议）

| Tauri command / event | 方向 | 说明 |
| --- | --- | --- |
| `runtime_attach(opts)` | JS → Rust | 指定二进制路径、工作区、启动参数；开始转发 |
| `runtime_send(line)` | JS → Rust | 写一行 JSON（含 `v`） |
| `runtime_shutdown()` | JS → Rust | 优雅收摊并等待 |
| `runtime_kill()` | JS → Rust | 超时兜底 |
| `runtime_pick_workspace()` | JS → Rust | 目录选择（plugin-dialog） |
| `runtime://line` | Rust → JS | 一行协议消息（原样字符串或已解析对象） |
| `runtime://exited` | Rust → JS | `{code, requested}` |
| `runtime://stderr` | Rust → JS | 仅诊断用，不是业务数据 |

转发**原样字符串**比在 Rust 里解析更保守：JS 端解析失败时按 §4.2 跳过并计数即可，不会因为 Rust 的严格反序列化而丢消息。

---

## 7. 界面结构（按 `desktop-ui-spec.md`）

### 7.1 七个分区

顶部栏 · 会话栏 · 正文区 · 侧栏 · 折叠摘要行 · 状态栏 · 输入框。

**高度总账要闭合**：整屏 = 顶栏 + 会话栏 +（摘要行）+ 正文 + 状态栏 + 输入框。面板按内容设高，**超出可用高度时裁尾部**，不许把状态栏和输入框挤出可视区。

### 7.2 十二类流条目

回合头 · 用户输入 · 模型步 · 工具调用 · 工具结果 · 拒绝行 · 并发批次 · 权限记录 · 思考块 · 回答块 · 流式正文 · 附加/系统行。

三处容易合并错的：

- **拒绝行**（`tool_result.status=denied`）必须单独一条：「没跑」与「跑失败了」处置完全不同。
- **思考块**默认折叠，显示字符数。
- **安静模式**是流的第二种形态（工具调用压成一行一次），要有开关和两种表现形式。

### 7.3 侧栏五区块

Goal · Tasks · Loaded skills · Background jobs · MCP。顺序固定，各有计数角标、空状态说明与引导。

- 内容有上限，装不下时**从底部丢弃并标 `(+N more)`**，不许静默截断。
- 「首次出现有任务/有目标/有后台任务」自动展开一次，之后**以用户操作为准**——手动收起后不许被下一次状态刷新弹回来。
- 窗口过窄时整体隐藏，由折叠摘要行接管。

> `caps`（各区块上限）在真实协议里**不存在**，属于呈现层。**决策 6：写死在前端常量（各区块 5 行），并写进设计系统文档**——不要试图从运行时取。

### 7.3b 左侧栏：工作区与会话

§7.3 的五区块是**右侧**栏。左侧另有一条窄栏，只负责两件事，顺序固定：**工作区 → 会话**（先决定在哪儿干活，再决定哪一次对话）。

它的两半来源不同，这个差别是承重的：

- **工作区列表是前端偏好**。协议里没有工作区清单，也不该有：工作区**就是**子进程的 cwd，换工作区是**换进程**而不是发消息（§3.2）。运行时只声明**当前**在哪儿（`init.workspace`），列表拿它来标记当前项——所以「在列表里」和「是当前的」是两件事，永不合并；增删一条不发任何协议消息。当前工作区**即使没被收藏也一定是一行**：这一栏回答的第一个问题是「我在哪儿」，一份漏掉脚下这处的清单答的是另一个问题。
- **会话列表完全是运行时的**：`session_list` 问，`sessions` 答，`session_switch` 原地切换、进程不动。`messages` / `steps` / `todos` / `preview` 全由运行时算好，前端一个都不自己数，也从不读会话文件。

**不画登录，不画插件市场**：这个窗口后面没有账号，运行时也没有插件注册表——它的扩展面是 MCP 与技能，那是右侧栏的事。画出来就是一个「按了不会有任何事发生」的控件。

**阻塞模态期间，这一栏的所有动作都是惰性的**，这不是装饰：`server.go: switchSession` 会调 `pending.abandonAll()`，切走就等于丢掉运行时正卡着等回答的那个请求 id，而它会**永远等下去**。弹审批时重启子进程同理。

### 7.4 状态栏

- **左**：阶段（启动中/空闲/进行中/已完成/到步数上限/失败/被打断）+ 当前动作或结算文案 + `step n / N`。「从没说过话」与「空闲」是**两个文案**。
- **右**（窗口变窄时从右往左砍）：autopilot → 安静模式 → 后台任务角标（有未收结果时加重）→ 子代理角标 → 上下文用量（**窗口未知时只报用量**）→ 缓存命中率 → 耗时 → 审计日志路径。

> ⚠️ 用量、缓存命中、耗时**不在 `ui(state)` 里**，要走 `ui(status).usage` / `ui(status).counters`。**决策 5：回合结束时拉一次 `status`，加上「有东西悬着」时拉一次**（沿用 `refresh_state` 的节流思路，下限约 2 秒）。`status` 会读一遍审计日志，**不能当心跳**。

### 7.5 弹层面板

命令面板 · 模型选择 · 思考强度 · 会话选择 · MCP · 技能 · 帮助 · 大屏文本（`/status` `/tools` `/context` `/compact`，**作为流内块出现，不遮挡会话流**）。

> **决策 4：没有「主题」面板**——主题只跟随系统（见 §8.1）。

- 模型面板要能区分**同名模型跨路由**（`provider/model`）。
- 思考强度清单**随模型变**，来源是 `init.effort_levels` / `ui(state).effort_levels`（是 `string[]`，label/description 由前端配）。
- 会话选择的预览与进度**由运行时算好**（`preview` / `todos`），前端**不读会话文件**。

### 7.6 命令与键位

命令 **17 条**（顺序即学习顺序）：`/new` `/resume` `/audit` `/exit` `/help` `/skills` `/autopilot` `/quiet` `/status` `/tools` `/context` `/compact` `/model` `/thinking` `/effort` `/mcp` `/goal`。

> **决策 4 移除了 `/theme`**（原为 18 条）。上游 spec §8 列了它，但 `docs/tauri-native-spec.md` §4 要求「无应用内主题切换」，两者冲突，取后者。

键位可按设计系统重排，但**每一项能力都要有入口**：发送 `Enter`、换行 `Shift+Enter`/`Ctrl+J`、关闭模态/中断/拒绝 `Esc`、退出 `Ctrl+C`、列表移动与滚动 `↑↓PgUp/PgDn`、折叠思考块 `Ctrl+T`、折叠侧栏 `Ctrl+B`、命令面板 `Ctrl+K`、技能面板 `Ctrl+S`、输入框编辑（`Ctrl+A/E`、`Home/End`、`Ctrl+W`、`Ctrl+U`、`Delete`、`Ctrl+←/→`）、面板内确认/关闭/数字直选（`Enter`·`Space`/`Esc`/`1-9`）。

### 7.7 首屏

三块（**不是三个页面**）：标识块（Logo、问候、**版本**、模型 + 工作区、一句「从哪儿开始」）· 最近会话块（按 `modified_at` 倒序，最多 4 条）· 快捷键卡。

- **决策 1**：标识块同时显示**桌面端版本**与**运行时版本**（后者启动时调一次 `--version` 读回）。全英文（决策 2）。
- **决策 3**：问候语**带 OS 用户名**。取不到时省略名字，不要显示 `unknown`。

窗口变矮时**从下往上丢**；首屏下方的运行时通知**属于会话内容，不能被挤掉**。

---

## 8. 设计系统与 Tauri 原生层

### 8.1 Token

`desktop/.../tudouni-aigo/tokens/tokens.css` 是唯一真源，复制到 `src/styles/`。要点：

- 双模跟随系统（`[data-theme="dark|light"]`），**首帧防闪烁**：`index.html` 内联脚本在 React 挂载前设好 `data-theme`。
- **无应用内手动主题切换**——`docs/tauri-native-spec.md` §4 明确「唯一主题来源，没有应用内手动切换」。原型里的 `themePref: 'system'|'dark'|'light'` **要删掉手动项**（决策 4），`/theme` 命令与主题面板一并移除。

  > 已澄清的张力：运行时的 `--theme`（deep clear / amber / pink violet）是 **TUI 自己的配色**，与桌面端 WebView 主题无关，**不要接进来**。终端/代码块在两种模式下都保持深色（`--terminal-bg`），这是 token 里已定的，不需要额外开关。

- 动效只允许微交互（`--motion-fast/base/slow`），**禁滚动驱动动画**。
- 字体本地打包（`@fontsource/*`），禁 CDN。
- 图标一律 SVG（lucide-react），**不用 emoji 当图标**。

### 8.2 窗口与原生层

按 `docs/tauri-native-spec.md`：

- `decorations: false` + 自绘标题栏（36px，`data-tauri-drag-region`），内容区 `calc(100vh - 36px)`。
- `minWidth: 960` / `minHeight: 600`——低于此宽度三栏布局必崩，是硬约束。
- `transparent: false`（Windows 下 DWM 瑕疵）。
- `dragDropEnabled: false`，文件拖入由 webview 的 drop 事件接管。
- 单窗口；弹层一律 DOM，不注册第二个 webview。
- **禁用刷新**：`F5`/`Ctrl+R` preventDefault，走菜单「视图 → 重新加载」。
- DPI：一律逻辑像素，**禁止手写 `devicePixelRatio` 换算**。

### 8.3 排版约束（会实际导致 bug 的两条）

- 面板是一行一行画的，交给边框的行不能超宽。`Width()` 只补不截，**唯一能截断的是 `MaxWidth()`**；过宽的行会被边框**重排**，而折行不把 ANSI 转义当零宽。
- 主题里「不画」的颜色是哨兵值。任何要垫在别的颜色之上的地方（如 accent 背景上的文字）**必须换成真实颜色**，否则会静默丢掉哨兵，得到「默认前景 + accent 背景」这种在深色终端上最难读的组合。

> 这两条源自 TUI 的教训，但在 WebView 里对应的问题是：CSS 不能依赖 `overflow-wrap` 去救固定宽度容器（会重排），以及 `currentColor`/`transparent` 不能当占位色用。

---

## 9. 打包与发布

| 项 | 现状 | 桌面端的含义 |
| --- | --- | --- |
| 版本号 | 唯一来源是仓库根 `VERSION`（当前 `5.5.0`），发布时 `-ldflags -X` 编进二进制 | 桌面端自己的版本要**独立**，但**必须显示运行时版本**（`init` 里没有 `version` 字段——见 §5.3，需要运行时配合，或桌面端调用 `--version` 读一次） |
| 命令名 | `internal/version/version.go` 的 `Name = "tudouni-aigo"` | 子进程名与 packaged 产物名都从它取 |
| 平台 | **只有 windows/amd64 与 linux/amd64** | Tauri 支持更多目标，但**随包没有别平台的 ripgrep**，缺了会让 `grep` 工具静默消失 |
| 资源目录 | 安装包内必须有 `prompts/` 与 `tools/`（`prompts` 存在是「这是安装包根」的判据） | 桌面端**随包分发运行时**时必须照抄这个布局，并设 `TUDOUNI_HOME` 指向它 |
| 配置 | `~/.tudouni/config.json`；`AGENT_CONFIG_FILE` 可覆盖路径；**无其他环境变量** | 首次运行的「填密钥」引导要指向同一个文件 |
| 工作区 | cwd；`paths.UnsafeWorkspace` 拒绝 home / 盘根 / home 的祖先目录 | 选工作区时**必须做同样的校验**，并把拒绝理由说清楚 |

> 强烈建议：**桌面端不重新实现密钥引导**，而是复用运行时的错误通道（`no_model` → 一条 `notice` + 指向 `config.json` 的提示），必要时用 `plugin-dialog` 打开那个文件。

---

## 10. 已定决策

以下 12 条在评审中已拍板。**#7、#8 不再需要用户决策**——我在写文档时标记为「实现前需确认」，随后已在源码中找到确定答案，一并列在这里。

| # | 决策 | 依据 / 落地方式 |
| --- | --- | --- |
| 1 | **版本显示**：桌面端版本自己管；启动子进程后调一次 `--version` 读回运行时版本，**两者一起显示在首屏标识块** | `init` 不含版本字段（`v`=信封 1、`protocol`=语义 3，都不是产品版本号）。`--version` 输出 `tudouni-aigo <版本>`（`internal/version/version.go: Describe()`），解析时按空格取第二段；`go build` 无 ldflags 时是 `dev`，要如实显示 |
| 2 | **界面语言：全英文**。桌面端界面也只用英文，与运行时保持一致 | `internal/i18n/i18n.go` 包注释：**"This build speaks English only"**，语言切换机制已被刻意移除；`en.go` 是唯一 catalog；`config` 的 `ui` 段被 `UiLanguageIgnored` 显式标记为 ignored。**上游 spec §0 第 6 条「文案支持运行时切换语言」已不成立。** 运行时送来的文本（`notice.text`、审批的 `remember_hint`/`trust_all_hint`）**必须原样显示，不许翻译**——翻译它们既造第二份事实，又直接违反「hint 一字不许改」 |
| 3 | **首屏问候带用户名**，从 OS 用户名取（Rust 侧读取） | 协议里没有 `user_name`。Windows 走 `%USERNAME%`，POSIX 走 `$USER`/`getpwuid`；取不到时**省略名字**而不是显示 `unknown` |
| 4 | **删掉 `/theme` 面板**，主题只跟随系统 | 严格按 `docs/tauri-native-spec.md` §4「唯一主题来源，没有应用内手动切换」。`init` 也没有 `themes` 清单。**`--theme` 与 WebView 主题无关，不要接进来**（那是 TUI 配色）。命令表因此从 18 条变为 **17 条** |
| 5 | **状态栏取数**：回合结束时拉一次 `status`，加上「有东西悬着」时拉一次（沿用 `refresh_state` 的节流思路） | 用量/缓存/耗时在 `ui(status)` 的 `usage`/`counters`，不在 `ui(state)`。`status` 会读一遍审计日志，**不能当心跳**；节流下限建议 2 秒（与 TUI 同一量级，见 `docs/spec/protocol.md`） |
| 6 | **面板内容上限写死在前端常量**（各区块 5 行），并**写进设计系统文档** | 协议没有 `caps`。仍需遵守上游 spec 的规则：超限时**从底部丢弃并标 `(+N more)`**，不许静默截断 |
| 7 | **子代理行字段已核实**：`{id, label, model, provider, depth, seconds, steps, tool_calls, activity}` | `internal/subagent/board.go` 的 `Board.Panel()`。原型的 `started_ms` 应为 **`seconds`**（已运行时长），`calls` 应为 **`tool_calls`**，另有 `steps` 与 `provider` |
| 8 | **`subagent` 确认是一个工具**（风险 **HIGH**，`parallel_safe=false`、`interactive=true`），会出现在 `/tools` 清单里 | `internal/subagent/subagent.go`：`const DefaultToolName = "subagent"`、`Risk: security.RiskHigh`。它不在 `internal/tools/builtin/` 下注册（在 `internal/subagent` 包内构建后注册进注册表），所以当初按目录搜索没找到。它也**可能被 compose 改名**——界面要按 `init.tools[].name` 显示，不要硬编码 `"subagent"`。HIGH 意味着它会**弹审批**，审批模态里显示的是子任务的 prompt |
| 9 | **拖入图片**：插入路径 + 缩略图，并额外做工作区外拦截与提示 | `internal/runtime/images.go` 的注释明确了机制：**用户只是在句子里写出路径**（`帮我看看这个截图 docs/shot.png`），运行时自己识别并附加；**没有上传命令、没有标记语言**。三条硬约束：路径走 `Workspace.SafePath`（**工作区外不附加**，有专门测试）、上限 **5MB**、**不问审批**。所以拖拽唯一正确的实现是**把路径插进输入框文本**，不能让前端「上传字节」——那是一条不存在的通道 |
| 10 | **审批模态按字段显隐**：`remember` 有才显示「总是允许」；`allow_trust_all=true` 才显示「全部允许」；两者都无则只有允许/拒绝 | 详见 §4.6。`always_group` 覆盖哪些工具由运行时按 id 查它手里的快照，**前端不许自己带名单** |
| 11 | **`/new` 发不带 `session_id` 的 `session_switch`**，丢弃原型的 `"__new__"` 哨兵 | `session_id` 缺失/`null` = 新会话；给的 id 不存在也算新会话。原型的哨兵虽然碰巧也能work，但语义是错的、且依赖巧合 |
| 12 | **加 single-instance 插件**：第二个实例只把窗口拉回前台，不启新的运行时 | 工作区状态写在 `<workspace>/.tudouni/`（`permissions.json`、`mcp.json`、会话文件、审计日志、artifacts），两个实例写同一目录会冲突。`docs/tauri-native-spec.md` 只说了「单窗口」，未覆盖多实例，这条是对它的补充 |

### 10.1 附带核实（原计划列为「未确认」，已查清）

写文档时我把下面两点标为「实现前需确认」，随后在源码里找到了确定答案，**不再属于待决项**：

1. **`subagent` 工具的风险等级是 `HIGH`**（`internal/subagent/subagent.go:242`），且 `ParallelSafe: false`、`Interactive: true`（注释写明「this handler blocks for as long as the child runs」）。界面仍应**按 `ui(tools)` 下发的 `risk` 渲染**，不要在前端硬编码——工具集是可扩展的。
2. **`--version` 的输出格式已确认**：`version.Describe()` 返回 `Name + " " + Current()`，即 `tudouni-aigo 5.5.0`（`Name = "tudouni-aigo"`，版本来自仓库根 `VERSION`，发布时 `-ldflags -X` 编入）。解析取第二段；未走发布构建时该段是 `dev`，**如实显示，不要美化**。

唯一仍需产品决定的是 **`init.model_catalog.aliases` 要不要在 `/model` 面板里列出**（认下但不在清单里的旧模型名，仍可调用）。它是数据不是答案，建议列出并标注「旧名称」。

---

## 11. 实施顺序（建议）

1. **协议层**：按 §4 重写 `protocol/types.ts`；写 `adapt.ts` 投影层；用真实 `protocol/schema/*.json` 做类型级校验。
2. **桥**：Rust 侧启动/守护子进程 + JSONL 收发 + 队列 flush（§3.3）+ 退出码上报 + single-instance（决策 12）。
3. **打通最小闭环**：`init` → `user_message` → `event` → `ui(run_finished)`，界面只要能显示流和答案。
4. **两个阻塞模态**：审批、提问——fail-closed，先做对再做全（决策 10）。
5. **面板与侧栏**：按 §7，先状态快照（`ui(state)`），再按需拉取（`/status` `/tools` `/context`）。上限常量按决策 6 落进设计系统。
6. **设计系统**：token → 组件 → 排版约束（§8.3）。**不含主题切换面板**（决策 4）。
7. **打包**：随包分发运行时（prompts/tools/vendored rg + 平台限制），版本一致性与真实二进制校验；首屏标识块接版本显示（决策 1）。

**验证手段**：原型没有测试用例（`README.md` 明说），验证靠 `tsc -b` + `vite build` + 截图核对。桌面端建议补上：协议投影层的单元测试（用 `protocol/schema` 的样例，加上真实 `event`/`ui` 负载的回归样例）——因为**协议差异是这类项目最容易出错、最难在界面上看出来**的地方（显示成空白或 0，而不会报错）。
