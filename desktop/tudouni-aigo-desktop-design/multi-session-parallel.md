# 桌面端：多工作区 · 多会话并行

**目标场景**（用户原话）：

1. 在一个工作区里，会话 A 正在干活，此时新建会话 B 给出一个新任务，**两者并行**；
2. 工作区 A 有会话在干活时，切到工作区 B，B 里也有会话在干活，**两者并行**。

**本文的性质**：方案，不是现状描述。现状（`desktop-app.md`）是"一个进程、一个会话、一个工作区"，本文说明要改成什么、为什么这么改、改哪些文件、哪些事实已经核实。

**路径约定**：桌面端文件相对 `desktop/tudouni-aigo-desktop/`；Go 文件相对仓库根；`desktop-app.md` 指本文同目录的设计文档。

> **上游 spec 缺失**：`desktop-app.md` §2 与 §7 引用的 `desktop/tudouni-aigo-desktop-design/desktop-ui-spec.md` **在仓库里不存在**（该目录只有 `desktop-app.md`、`icon`、`tudouni-aigo/`）。所以本文的界面依据只能取自 `desktop-app.md` §7 与 `tudouni-aigo/docs/*`，不能引用那份 spec。这一条本身值得修（要么补文件，要么改引用）。

> **修订记录**。
>
> **第一轮**（补"哪些显示要跟着 `activeKey` 切"）：查过 `StatusBar.tsx`（13 格）、`SessionBar.tsx`、右栏与各面板后补入 §4.5 的总表，并改了两条原方案：
>
> 1. **状态栏右段不加全局角标**（原方案写了，是错的——那一行全是当前会话的事实）；全局"还有几个在跑"放左栏工作区行。
> 2. **`quiet` 从全局偏好改成每会话**（原方案列在"保持全局"里）。
>
> 另外点名了三个入口函数必须加 `key`：`selectPhase`、`selectAction`、`useUsage`。只改第一个的话，状态栏会**左段跟着切、右段不动**——界面看起来完全正常。
>
> **第二轮**（会话行的状态点）：这是原方案**最大的一个缺口**——第一版只说"加个运行状态"，等于开了并行却看不见并行。补入 §4.5「会话行的状态点」整节，并定了 5 态、不呼吸、不重排、颜色不单独承担含义（决策表 10–13）。**关键的一点是加了第四个状态（蓝）**：按最朴素的三色（绿/黄/红），一个后台会话跑完长任务时**一个点都没有**，而那正是最需要告诉用户的时刻。同时收窄了红色——`interrupted` / `step_limit` / `empty` 全归蓝，因为红点只该给"你没让它停、它自己坏了"，按三次 Esc 攒出三个红点会让红点失去意义。

---

## 1. 一句话结论

**协议不用改，运行时不用改；要改的是 Rust 桥和前端 store——它们目前各有一个单例槽位。**

协议本来就是"一条 stdio 连接 = 一个运行时 = 一个会话"（`internal/protocol/client.go` 就是这么用的，`--session <id>` 是文档化的启动参数）。并行不需要新通道，需要的是**允许同时存在多条这样的连接**，并且让每一条在两端都有身份。

---

## 2. 现状：为什么现在做不到（逐条核实）

### 2.1 桥只有一个 child 槽位

`src-tauri/src/lib.rs:153-166`：

```rust
struct BridgeState {
    child: Option<Child_>,        // ← 单槽位
    listening: bool,
    workspace: Option<PathBuf>,   // ← 单工作区
}
```

- `spawn` 起新子进程之前**直接 kill 旧的**（`lib.rs:347-357`），注释写明 "this path is a restart, not a shutdown"。所以换工作区不是并存，是用 B 换掉 A。
- `runtime_send(line)` 无目标标识，只写那唯一的 stdin（`lib.rs:586`）。
- 三条事件通道都不带 child 身份：`runtime://line`（`{line}`）、`runtime://exited`（`{code, requested}`）、`runtime://stderr`（`{line}`）。前端连"这行是谁说的"都分不出来。
- `runtime_shutdown` / `runtime_kill` 作用于那一个 child（`lib.rs:636`、`lib.rs:686`）；前者是串行 poll 到 30s 超时。
- `image_stash` 从 `guard.workspace` 取目录（`lib.rs:858`、`lib.rs:898`），所以粘贴只认一个工作区。
- `resolve_binary`（`lib.rs:224`）与 `unsafe_workspace`（`lib.rs:545`）是**进程级**的，多会话不需要改。
- `tauri.conf.json` 只声明一个 `main` 窗口；`capabilities/default.json` 的 `windows: ["main"]`。

### 2.2 前端是一个会话的状态机

- `src/runtime/bus.ts:18`：模块级单例 `let current: Runtime | null = null`。
- `src/state/store.ts` 里这些字段全是**单例**：`session`（`:234`）、`entries`、`handshakeNotices`、`activeRunId`（`:257`）、`lastRunId`、`uiState`、`status`、`context`、`tools`、`mcp`、`skills`、`modal`（`:316`）、`pendingModals`（`:327`）、`draft`（`:391`）、`history`（`:392`）、`composerNotice`（`:408`）、`pastedImages`（`:418`）。
- `applyRuntimeMessage(msg)`（`:849`）**不按 `session_id` 分派**——它直接把整条消息写进单例字段。
- `enterWorkspace(path)`（`:1503`）先清空全部状态再 `startRuntime({workspace})`，"已经在那儿就返回"的判断在 `:1509`；`applyLaunch(next)`（`:1564`）同理。
- 轮询节流也是单例：`lastPollAt`（`:689`）、`POLL_GIVE_UP_AFTER`（`:706`）、`throttled`（`:711`）、`noteOutstanding`（`:727`）、`wakePolling`（`:735`）。并行时一个会话的轮询会把另一个饿死。

### 2.3 协议里"哪些消息能自报家门"是不对称的

这是**决定性的**一条。已核实（`protocol/schema/outbound.schema.json`）：

| 消息 | required 里有 `session_id` 吗 |
| --- | --- |
| `init` | ✅ `session_id` |
| `event` | ✅ `session_id` |
| `delta` / `delta_reset` | ✅ `session_id` |
| `session_load` | ❌（只有 `v/t/messages`） |
| `ui`（8 种 kind） | ❌（只有 `v/t/kind`） |
| `notice` | ❌（`v/t/level/code/text`） |
| `sessions` | ❌（`v/t/items`） |
| `permission_request` | ❌（`v/t/id/call_id/tool/risk/arguments/remember/…`） |
| `question_request` | ❌（`v/t/id/question/header/options/multi_select`） |

也就是说：**阻塞模态、面板快照、通知这四类都认不出自己属于哪个会话。** 这正是"一条连接一个会话"的遗留——一条连接里根本不需要标。

所以多会话的归属**只能靠连接身份**，不能靠消息内容。这一条同时判定了下节的两条路线。

### 2.4 运行时的 workspace 是进程级全局

`paths.WorkspaceDir()` 就是 `os.Getwd()`（`internal/paths/paths.go:109`），而它被直接调用在：

- `internal/runtime/composition.go:429` `tools.NewWorkspace(paths.WorkspaceDir())`
- `internal/runtime/composition.go:514` `builtin.NewJobs(workspace, session.SessionID)`
- `internal/runtime/composition.go:1502` / `:1605` `init.workspace` / `status.session.workspace`
- `internal/runtime/config.go:48` `PermissionFile()` = `<ws>/.tudouni/permissions.json`
- `internal/state/store.go` / `internal/audit/jsonl.go` / `internal/tools/builtin/jobs.go:298`（子进程 cwd）/ `jobs.go:683`（显示用相对路径）
- `internal/skills/loader.go:152`、`internal/subagent/spawn.go:211`、`cmd/tudouni/main.go:428`（安全检查）

`SessionStore` / `JsonlSink` 的**目录**也是从它派生的（`composition.go:59-64`）。

所以"一个进程带多个工作区"在 Go 侧做不到——**除非把这一整套全局函数改成显式的每-runtime workspace 参数**。这是本方案选路线 A 的硬理由（下节）。

### 2.5 一个进程内的两个会话也跑不起来

`internal/protocol/server.go` 的 `Server` 只挂载一个 runtime（`Attach`，`server.go:210`），并且：

- `session_switch`（`server.go:995`）先 `s.joinTurn()`（`:1015`，等当前回合跑完），再关旧、装新、`pending.abandonAll()`（`:1037`）、重发开场三连。
- `RunTurn` 由 `turnMu`/`turnDone` 串行化（`:409`、`:447`），`stop` / `answer` / `lastRunID` / `lastStep` 都是 Server 级单例（`:114-136`）。

结论：一个进程内两个会话并行跑回合，等于重写 `Server`。

---

## 3. 两条路线，以及为什么选 A

### 路线 A：一个会话一个子进程（**推荐**）

前端为每个会话起一个 `tudouni-aigo --runtime-stdio [--session <id>]`，cwd = 那个工作区。

- ✅ **协议零改动**：一个连接一个会话，正是协议现有的用法。`permission_request` 没有 `session_id` 也不成问题，因为归属由**连接**给出。
- ✅ **运行时零改动**（§5 的三处共享写都不是新引入的：粘贴暂存由桥处理、`permissions.json` 是可选加固、`--ericai` 是文案提醒）。
- ✅ **今天的行为是 N=1 的特例**，可以分阶段落地，每阶段都能跑。
- ❌ 进程数 = 并行会话数。每个子进程各自持有模型客户端、工具注册表、MCP 连接与它自己的会话历史，这是真实成本，要写进文档并给用户可见的计数（§4.5 工作区行的角标）。**本文没有测过实际占用**，如果这个数字要在文档里出现，得真起 N 个会话量一次，不要估。
- ❌ 同一工作区的多个进程会同时写 `<ws>/.tudouni/`（§5 逐路径处理）。
- ⚠️ **前端要真的按会话分桶**，这条不是自动的。"多起一个进程"很容易做完，但**每一条显示出来的运行时事实都必须跟着 `activeKey` 走**——状态栏那一行 13 格、会话栏的模型/思考/强度、右栏的 goal/tasks/jobs/MCP、输入框的草稿，全是"当前会话"的陈述。§4.4 给了分桶的形状，§4.5 逐处点明了哪些要切、哪些不该切。

### 路线 B：一个进程挂多个会话

- ❌ **必须先改协议**：`ui` / `notice` / `sessions` / `permission_request` / `question_request` 都要加 `session_id`（或在信封加一层）。这是**不兼容变更**（主版本 +1），并且要同步 TUI、CLI、`protocol/schema/*.json`、`internal/frontends/report.go`。
- ❌ **必须先解决多工作区**：`paths.WorkspaceDir()` 是进程 cwd（§2.4），要改成每 runtime 一个 workspace 上下文，波及至少 10 个调用点。
- ❌ `Server` 的 `runtime` / `stop` / `answer` / `lastRunID` / `turnDone` 全部要下移成 per-session。
- ✅ 进程数少。

**选 A。** 理由不是"省事"，而是 **A 是唯一不动协议、不动运行时的路线**；B 的工作量主要在 Go 侧，而收益（少几个进程）与代价（协议不兼容 + 全局 workspace 重构）不成比例。

> **对照 DSH**：DeepSeek Harness 走的是**单进程多会话**（`ctx.sessions` 是一个 store，`AgentRegistry.create()` 为每个会话建一个 `Agent`，每个 agent 的 `meta.cwd` 各自独立）。它能这么做的前提是它的会话与 workspace 从第一天起就是**一等公民**：session 是 append-only 的 `SessionEvent` 日志、`deriveMessages()` 从日志投影模型历史、agent 通过 `agent.ctx` 拥有自己的作用域注册。
>
> tudouni 的结构不同——workspace 是进程 cwd，`Server` 持一个 runtime 槽位。要走到 DSH 那个形态，等于重做 §2.4 + §2.5 那两层。所以这里取"用多进程换多会话"，这是两种架构之间最短的桥。
>
> 顺带一条佐证：DSH 生态里有一个社区插件 `dsh-file-claim`，专门做"同一工作区并行多会话的文件认领与写入保护"。说明**同一工作区多写者这件事，DSH 自己也不拦**，而是留给上层。本方案对文件冲突采取同样立场（§5.4）。

---

## 4. 方案（路线 A）详细设计

### 4.1 四条不变量

整个设计建立在这四条上，实现时任何一条被破坏都会产生静默的错误行为：

1. **一个子进程 = 一个会话。** 前端不再发 `session_switch`（它会 `abandonAll()` 并原地丢弃并行性）。`session_switch` 仍是协议的一部分，TUI 的 `/resume` 继续用它。
2. **一个 session id 至多被一个存活子进程持有。** 前端用 `sessionId → key` 索引保证。这是文件层的安全前提：`SessionStore.Save` 的 watermark 与 `closeHalfLine`（`store.go:91-92`、`:269`、`:380`）是**按 id** 维护的，两个写者会打架。
3. **归属靠连接，不靠消息。** 每条出站消息的会话归属由"是哪个 child 发来的"决定——因为 §2.3 的表。
4. **每个运行时事实都有归属。** 没有一个"当前会话"的隐式全局量参与运行时事实的存储；`activeKey` 只决定**显示哪个**，不决定**收到什么**。

### 4.2 Rust 桥（`src-tauri/src/lib.rs`）

#### 状态

```rust
struct BridgeState {
    /// 一个会话一个 child。key 由桥分配，前端持有。
    children: HashMap<ChildKey, Child_>,
    /// 前端的监听器是**进程级**的（只注册一次），所以这个标志保持全局。
    listening: bool,
}

struct Child_ {
    child: Child,
    stdin: Option<ChildStdin>,
    requested: bool,
    queue: VecDeque<String>,
    stderr: VecDeque<String>,
    /// 这个 child 的工作区。`image_stash` 靠它决定往哪儿写。
    workspace: PathBuf,
    /// 停下时用：这个 child 名下的粘贴暂存目录。
    staging: PathBuf,
}

type ChildKey = u64;  // 单调递增，从 1 开始
```

`ChildKey` **不能**用 session id：`--session` 省略时 id 由运行时分配，要等 `init` 回来前端才知道（`ResolvedSession` 的 `store.NewSessionID()`，`composition.go:78`）。key 是桥自己 mint 的，前端把它当成那个会话的句柄。

#### 命令签名（全部加 `key`）

| 命令 | 变化 |
| --- | --- |
| `runtime_attach(options) -> ChildKey` | **返回值变了**：起完子进程返回它的 key（现在是 `Result<(), String>`，`lib.rs:577`） |
| `runtime_send(key, line)` | 加 key（`lib.rs:586`） |
| `runtime_attach_listener() -> usize` | 语义不变：置 `listening = true`，flush **所有** child 的队列（`lib.rs:609`） |
| `runtime_shutdown(key: Option<ChildKey>)` | `None` = 全部（窗口关闭走这个）。带 key = 只关一个会话。实现要并行等待（`lib.rs:636-680` 现在是串行 poll 到 30s） |
| `runtime_kill(key: Option<ChildKey>)` | 同上（`lib.rs:686`） |
| `runtime_stderr(key) -> Vec<String>` | 加 key（`lib.rs:939`） |
| `image_stash(key, request)` | 加 key，走 header，见下（`lib.rs:858`） |
| `runtime_version` / `os_user_name` / `workspace_check` | **不变**（进程级/无状态） |

#### 事件都带 key

```rust
struct LinePayload   { key: ChildKey, line: String }
struct ExitPayload   { key: ChildKey, code: i32, requested: bool }
struct StderrPayload { key: ChildKey, line: String }
```

`forward_line(app, key, line)` 与 `spawn` 里那两个 reader 线程、以及 wait 线程都要带上自己那个 key（移进闭包即可）。`forward_line` 的 queue 逻辑不变，只是从 `guard.child` 换成 `guard.children.get_mut(&key)`。

#### `image_stash` 的 key 走 header，不走参数

`image_stash` 的 payload 就是图片字节本身（`InvokeBody::Raw`，现有注释已说明"`invoke` 带 raw body 时没有第二个命名参数可放"）。多会话后这个"约束"就必须绕开，办法是 Tauri 的 **invoke headers**：

```ts
await invoke('image_stash', bytes, { headers: { 'x-tudouni-key': String(key) } });
```

Rust 侧从 `Request::headers()` 读（`use tauri::ipc::Request` 已经在用了）。头缺失 = 拒绝，不猜——猜错就会把图写进另一个工作区。

> 现有注释把"没有第二个参数"当成"恰好是对的形态"。多会话之后它不再是。这条要一并改掉注释，否则下一个读代码的人会照着它继续假设单工作区。

#### 粘贴暂存的清理时机（**这个必须改，否则是数据丢失**）

现在 `spawn` 一启动就 `fs::remove_dir_all(<ws>/.tudouni/paste)`（`lib.rs:387-395`）。多会话下，**在 B 里起会话会删掉 A 刚粘贴、运行时还没读走的图**。

新规则：

- 暂存目录按 key 分：`<ws>/.tudouni/paste/<key>/`；
- 起新 child 时，删 `<ws>/.tudouni/paste/` 下**所有不属于当前存活 child 集合**的子目录；
- 最后一个 child 退出 / App 退出时全部清掉。

这样 A 的粘贴不会被动，上次运行留下的目录仍会被回收，而"没有任何 draft 引用它"这个前提（现有注释里的理由）依然成立。

#### 单实例（决策 12）

**本方案不需要改它。** 它拦的是"第二个 App 进程"，而多会话是同一个 App 内的多个子进程。要改的是它写在 `desktop-app.md` §3.5（`:90-98`）与决策表第 12 行（`:562`）、以及 `src-tauri/src/lib.rs:961-967` 注释里的**论据**：

> 原文说"两个实例对同一工作区各跑一个运行时，会同时写 `permissions.json`、`mcp.json`、会话文件、审计日志和 artifacts"。

多会话方案之后，**同一个实例内就已经有多个写者了**——会话文件、审计日志、artifacts 都按 id 分（§5.1），真正会打架的只有 `permissions.json`（§5.2）。所以这条论据要改成：

- 会话文件 / 审计日志 / artifacts / jobs **不是**冲突源（按 id 分文件或目录）；
- `mcp.json` **不是**冲突源（运行时只读；`mcp load/unload` 不改文件，inbound schema 明说）；
- **`permissions.json` 是**，而且这个冲突与实例数无关——它只是被"多实例"顺带遮住了。

建议**保留** single-instance，同时把 `desktop-app.md` §3.5 里那句"附带要做的一件事"落实：第二个实例的 argv 要传进来（现在 `lib.rs:971` 的闭包把 `_argv` / `_cwd` 丢掉了），把"打开哪个工作区"交给第一个实例。「换工作区」目前走应用内入口，这是产品决定，见 §6。

**与现有脚本的关系**：`scripts/single-instance-check.mjs` 断言的正是"第二个实例自己退出、第一个还活着"。多会话不改变它的结论（它测的是 App 进程数，不是 runtime 进程数），所以它不用改；反过来，多会话之后 `Known boundaries` 里那句"two runtimes on one workspace would write the same files"要按上面的论据重写。

### 4.3 前端 runtime 层

#### `src/runtime/bus.ts`

接口不变（`send` / `subscribe` / `dispose`），把单例换成注册表：

```ts
export interface Runtime {
  readonly key: string;
  send(msg: FrontendMsg): void;
  subscribe(cb: (msg: RuntimeMsg) => void): () => void;
  dispose(): void;
}

const registry = new Map<string, Runtime>();
export function registerRuntime(rt: Runtime): void;
export function unregisterRuntime(key: string): void;
export function sendTo(key: string, msg: FrontendMsg): void;
export function getRuntime(key: string): Runtime | null;
```

**每个会话一个 `Runtime` 实例**，而不是 `send(key, msg)` 一把梭。这样"往哪个会话说话"由句柄决定，store 里不会到处传 key；`bus.ts` "两个动作、没有运行时状态"的契约也保住了。

#### `src/runtime/tauri.ts`

- `attachRuntime(options) -> Promise<string>`（返回 key）。
- `createTauriRuntime(key, …)`：订阅时按 key 过滤三条事件。
- `stashImage(key, bytes)`：走 header（§4.2）。
- `readRuntimeStderr(key)`、`shutdownRuntime(key?)`、`killRuntime(key?)` 加参数。
- `readRuntimeVersion` / `readUserName` / `chooseWorkspaceDirectory` / `checkWorkspace` **不变**。

判定与计数（`dropped` / `lateDropped`）要按 key 落——否则并行时两个会话的丢弃会混进一个计数器，而 `docs/REVIEW.md` 已经记了一次"两类不同的东西被加到一起"的教训（P1：`dropped` 被当作"晚到消息"显示）。

#### `src/runtime/useRuntime.ts`

从"建一个 runtime"变成"建一个管理器"：

```
useLayoutEffect:
  listening 注册（一次，全局）
  attachRuntimeListener()（一次，全局；flush 所有已排队的 child）

动作（导出给 store 用）:
  attachSession(options) -> key     起一个会话子进程
  detachSession(key)                收掉一个
  shutdownAll()                     窗口关闭/退出
```

`setRuntimeInfo`（版本 + 用户名）仍是全局一次。

### 4.4 store 分桶

`src/state/store.ts` 是最大的一块。形状建议：

```ts
interface SessionRuntime {
  key: string;
  /** 运行时自己报的 id；`init` 到达前是 null（新会话由运行时分配 id）。 */
  sessionId: string | null;
  workspace: string;
  session: SessionInfo | null;
  ready: boolean;
  /** 这个会话自己的启动失败原因（见下）。 */
  problem: string | null;
  stderrTail: string[];
  runtimeExit: { code: number; requested: boolean } | null;

  entries: Entry[];
  handshakeNotices: NoteEntry[];
  activeRunId: string | null;
  lastRunId: string | null;
  hasSpoken: boolean;
  lastTurnMs: number | null;
  dropped: number;
  lateDropped: number;

  uiState: VmState | null;
  status: VmStatus | null;
  context: VmContext | null;
  compaction: VmCompaction | null;
  tools: VmTool[];
  toolRegistry: VmInitTool[];
  grantedPrefixes: string[];
  mcp: VmMcp[];
  mcpNotes: string[];
  mcpPending: string[];
  skills: VmSkill[];
  skillAvailable: VmSkill[];
  skillActive: string[];
  skillCatalog: SkillCatalogRow[];
  skillProblems: string[];
  skillShadowed: string[];
  models: VmModel[];
  modelAliases: ModelAlias[];

  /* 左栏那个点要说的事——见 §4.5「会话行的状态点」 */
  /** 回合在这个会话**不在屏幕上**的时候结束了。它成为 activeKey 的那一刻清掉；
   *  **绝不持久化** —— "你还没看过这条"不是一个能活过重启的事实。 */
  unseen: boolean;

  /* 每个会话自己的输入状态——见 §4.5 */
  draft: string;
  history: string[];
  historyCursor: number | null;
  pastedImages: PastedImage[];
  composerNotice: ComposerNotice | null;

  /* 每个会话自己的显示偏好——见 §4.5「quiet 归属」 */
  quiet: boolean;
}

interface AppStore {
  sessions: Record<string, SessionRuntime>;   // key -> 事实
  order: string[];                            // 左栏顺序
  activeKey: string | null;                   // 只决定显示哪个
  /* **按工作区键控**（`normPath(workspace)`）。会话列表是**工作区**的事实：
     `session_list` 是读一个目录下的会话文件得到的，同一工作区的每个子进程
     答案都一样。**不能放进桶里** —— 放进去之后左栏读的是"当前聚焦那个子进程
     的副本"，于是切换会话（`focusSession` 不发任何协议消息）看起来像列表本身
     变了，同一行还会在「open now」组和已保存组之间跳。 */
  savedSessions: Record<string, SavedSessions>;
  /* 全局：*/
  runtimeVersion, userName, desktopVersion;
  startupProblem: string | null;               // 全局启动失败，见下
  workspaces: string[];
  /* 前端偏好（侧栏折叠 / block 折叠 / sessionsCollapsed）保持全局。
     **quiet 不在这里** —— 见 §4.5「quiet 归属」。 */
  /* 模态队列保持全局，但每条带 key —— §4.5 */
}
```

要点：

- `applyRuntimeMessage(key, msg)`：`init` 到达时按 key 写 `sessionId` 并建立 `sessionId → key` 索引；其余分支与今天逐行一致，只是目标从 `set({...})` 变成 `patchSession(key, {...})`。
- **`applyStateSnapshot` 里的三处副作用要跟着 key**：`persistPrefs(get())`（`:1729`，block 自动展开时写 localStorage）、两处 `throttled(() => busSend(...))`（`:957` 拉 `status`、`:1741` 发 `refresh_state`）。
  - `persistPrefs` 写的是**全局偏好**（`blockCollapsed` 等），而现在它是"读整个 store 再整个写回"。多会话下两个会话同时触发自动展开会互相覆盖（后写的基于它读到的旧值）。要改成**只写它真正改动的键**，而不是整份快照。
  - 注意 `persistPrefs` 现在也序列化 `quiet`（`Prefs` 类型里有）。`quiet` 进桶之后要么从 `Prefs` 里去掉、要么按会话存——见 §4.5「quiet 归属」。
  - 两处 `throttled` 必须 per-key：现在 `throttled` / `noteOutstanding` / `wakePolling` 是模块级单例（`:689` / `:706` / `:711` / `:727` / `:735`），并行时一个会话的轮询会把另一个饿死。改成 `Map<key, PollState>`，并把 `busSend` 换成 `sendTo(key, …)`。
- **`pastedImages` 的 `blob:` URL 释放**：`forgetPastedImage`（`:1237`）/ `clearPastedImages`（`:1242`）/ `submitDraft`（`:1277`）都要按会话。改成按会话后，**关掉一个会话也必须释放它的 URL**，否则 blob 会跟着窗口活到进程结束。
- **`startupProblem` 要分两层**：
  - **全局**（全屏 `StartupProblem`）：二进制找不到、listener 注册失败、`envelope-version-mismatch`。理由：`resolve_binary`（`lib.rs:224-267`）对所有子进程返回同一个路径，所以协议版本不匹配要么全错要么全对，全屏是诚实的。
  - **每会话**（在该会话行/该会话的会话列里显示）：`workspace_check` 拒绝、`--session` 非法、打开失败。今天这些都往全局 `setStartupProblem` 里塞，多会话后会把整屏顶掉，而其它会话还好好的。
- **三个选择器函数都要加 key**：`selectPhase(s)`（`store.ts:1750`）、**`selectAction(s)`（`StatusBar.tsx:59`）**、**`useUsage()`（`store.ts:1832`）**。最后一个尤其容易漏——它不在 `AppStore` 的定义旁边，而是文件末尾一个独立的 hook。
  - `selectAction` 读 `s.entries` / `s.ready` / `s.runtimeExit`；
  - `useUsage` 读 `s.status` / `s.uiState` / `s.context`，是状态栏右段**所有**数字（用量、占比、上下文估算、缓存命中率）的唯一入口。
  - 只改 `selectPhase` 的后果是**左段跟着切、右段不动**——界面看起来完全正常，数字却是另一个会话的。见 §4.5「状态栏」。
- **再加一个派生选择器**：`selectRowStatus(s, key): 'asking' | 'broken' | 'running' | 'unseen' | 'none'`，供左栏的状态点用（§4.5「会话行的状态点」）。它是纯函数，**输入只有桶里的字段**，不依赖 `activeKey`——除了 `unseen` 的清除那一步由别处负责。

### 4.5 UI

**先看一张总表**：多会话落地时，"哪些东西跟着 `activeKey` 走"是唯一容易做漏的地方——漏了不会报错，只会显示别的会话的数字。下面按组件列一遍（来源都已核对到源码）。

| 组件 | 读的单例字段 | 多会话后 |
| --- | --- | --- |
| `chrome/StatusBar.tsx` | `entries` / `ready` / `runtimeExit` / `session` / `uiState` / `status` / `context` / `lastTurnMs` / **`quiet`** | **整条每会话**（13 格逐条见下） |
| `chrome/SessionBar.tsx` | `session`（id/model/provider/thinking/effort/maxSteps/workspace）、`uiState.autopilot`、`riskScope` | 每会话 |
| `chrome/TopBar.tsx` | `session.workspace`、`runtimeExit` | 每会话（工作区名是当前会话所在的那个） |
| `chrome/CollapsedSummary.tsx` | `uiState`（含 autopilot） | 每会话 |
| `chrome/Composer.tsx` | `draft` / `history` / `composerNotice` / `pastedImages` / `phase` | 每会话 |
| `stream/StreamView.tsx` + `EntryView` + `QuietGroup` | `entries` / `toolRegistry` / `tools` / `reasoningOpen` / `toolOpen` / `quiet` | 每会话，**但折叠状态 `reasoningOpen` / `toolOpen` 保持全局**——它们按 entry id 索引，而 `nextId`（`entries.ts:211`）是模块级单调计数，跨会话不重号，所以不需要跟着分桶 |
| `sidebar/Sidebar.tsx`（右栏 5 区块） | `uiState`（goal/todos/skills/jobs/subagents/mcp）、`skills`、`mcpPending` | 每会话 |
| `sidebar/WorkspaceSidebar.tsx`（左栏） | `workspaces`（全局）、`session.workspace`（当前）、`savedSessions`（按工作区，**不是**当前子进程的）、`modal` | **这一栏是导航**，见下。它还要新增一样东西：**会话行的状态点**（跨所有会话读，不只是当前这个——这正是它存在的理由） |
| `panels/*`（9 面板） | 多数读 `uiState` / `session` / `tools` / `status` / `models` | 每会话，除了 `settings`（启动参数，见 §4.2）和 `audit`（路径来自 `session.auditPath`，本身是每会话） |
| `modals/*` | `modal` / `pendingModals` | **队列全局，每条带 key**（§4.5「阻塞模态队列」） |
| 全局偏好 | `sidebarVisible` / `leftbarVisible` / `blockCollapsed` / `blockTouched` / `sessionsCollapsed` / `workspaces` / `reasoningOpen` / `toolOpen` | **保持全局**——它们说的是窗口怎么摆，或者按 entry id 索引。`blockTouched` / `blockAutoExpanded`（右栏 5 区块的自动展开一次）语义上是"每个会话第一次出现该区块时展开一次"，多会话下**共用一份也不会出错**（最坏是第二个会话不自动展开），所以不动它 |

**判断标准**（和设计文档 §7.1 判"输入框属于会话列还是窗口外壳"是同一条）：**它陈述的是谁的状况。** 说"这段对话现在怎么样"的进桶；说"这个窗口怎么摆"的留全局。

#### 左栏（`src/components/sidebar/WorkspaceSidebar.tsx`）

布局**不变**（工作区在上、会话在下），只加两个事实：

- **工作区行**：角标 = 该工作区下"需要你看一眼"的会话数（见下"会话行的状态点"）；当前工作区 = `activeKey` 所属的那个（不再比较 `session.workspace` 单例）。
- **会话行**：左侧的状态点（见下）+ 运行状态文字。这是用户切走之后唯一能知道"那边怎么样了"的地方。
- 「新建会话」按钮：`attachSession({ workspace: 当前工作区 })` —— 起**新**子进程，不碰任何已有会话。这正是场景 1。
- 点会话行：
  - 该会话已有存活子进程 → `activeKey = key`，**不发任何协议消息**；
  - 没有 → `attachSession({ workspace, sessionId })`。

**阻塞模态期间的禁用范围要重新划**（今天所有动作一律 inert，理由是 `server.go: switchSession` 会 `abandonAll()`）：

| 动作 | 有阻塞模态时 | 理由 |
| --- | --- | --- |
| 切换显示（`activeKey`） | ✅ 允许 | 不发消息，不影响任何 pending id |
| 新建会话 / 打开另一个会话（起子进程） | ❌ 禁止 | `spawn` 的 restart 路径会 kill；即使改成"只 kill 自己"，新的 `attach` 也不该在有人被卡住时发生 |
| 关掉某个会话 | ❌ 禁止 | 会丢弃它自己的 pending |
| **其它会话的**审批/提问 | ✅ 允许 | 见下 |

最后一行是新能力，也是必需的：A 在等审批、B 也在等审批时，用户必须能两个都答。

#### 会话行的状态点（**多会话的必要件，不是装饰**）

并行之后，"某个会话现在是什么状况"必须能**在最左边一栏扫一眼看出来**。没有它，用户在 A 里工作时无从知道 B 跑完了还是卡在审批上——那就等于开了并行却看不见并行。

**五个状态**，颜色全是现成的 token（`tokens.css:113-116` 深色 / `:155-158` 浅色），不新造：

| 点 | 含义 | 颜色 | 同时成立时的先后 |
| --- | --- | --- | --- |
| 🟡 | **等你操作**：有待答的审批 / 提问 | `--warning` | 1（最高） |
| 🔴 | **坏了**：模型错误、或子进程死了 | `--destructive` | 2 |
| 🟢 | **正在跑** | `--success` | 3 |
| 🔵 | **停下来了，等你看** | `--info` | 4 |
| ⚪ 无点 | 空闲；或从没说过话 | — | — |

"先后"只用于**同时满足多个条件时显示哪一个**（每行只有一个点）。例如一个会话既在跑、又有一个上一轮留下的未答请求——显示 🟡 而不是 🟢，因为"有人在等你"比"它在忙"更需要你知道。**它不用来排序列表**（§4.5「排序：不重排」）。

**为什么需要第四个（蓝）**：按最朴素的三色（绿=跑、黄=等审批、红=错），B 跑完一个长任务时**一个点都没有**——它不在跑、不需要审批、也没出错。而这恰恰是并行最需要告诉你的那件事。蓝点就是这个状态：**回合结束了，而那个会话不在屏幕上。**

**红色只给"你没让它停、它自己坏了"。** `adapt.ts:53-77` 的 `Phase` 有 9 个值，其中：

| phase | 点 | 理由 |
| --- | --- | --- |
| `failed` | 🔴 | `model_error` / `model_fatal`——真故障 |
| `runtime_gone` | 🔴 | 子进程死了；`runtime_exit.requested` 为 true 时除外（那是你自己关的） |
| `interrupted` | 🔵 | **用户自己按的 Esc**。给红点等于把用户的动作报成故障 |
| `step_limit` | 🔵 | 到步数上限。不是错误，是"停下来等你决定" |
| `empty` | 🔵 | 模型返回空。`adapt.ts:82` 的注释写明这不是失败 |
| `done` | 🔵 | 跑完了，等你看 |
| `booting` / `idle` | ⚪ | |
| `running` | 🟢 | |

红点是最强的信号。**如果按 Esc 三次就攒出三个红点，红点就不再值钱了**——所以 `interrupted` / `step_limit` / `empty` 全部算蓝。

#### 每个点的来源（全部是已有数据，不用改协议）

| 点 | 判据 | 出处 |
| --- | --- | --- |
| 🟡 | `pendingModals.some(m => m.key === key)` | 本方案 §4.5 已给队列加 key |
| 🔴 | `lastStopReason(entries)` ∈ {`model_error`, `model_fatal`}，或 `runtimeExit !== null && !runtimeExit.requested` | `entries.ts` 的 `lastStopReason`；`runtimeExit` 已在桶里 |
| 🟢 | `hasRunningTurn(entries)` | `entries.ts:926` |
| 🔵 | `!running && !asking && !broken && entries 里有过一次 run_finished && unseen` | `unseen` 是本方案新增的字段 |
| ⚪ | 其余 | |

**`unseen` 的置位与清除**：收到 `ui(run_finished)` 或 `event(run_finished)` 时，若 `key !== activeKey` 则 `unseen = true`；`activeKey` 切到该 key 时清掉。**不持久化**——"你还没看过这条"不是一个能活过重启的事实。

**点只对"有活的子进程"的会话显示。** 左栏列表来自 `sessions.items`（磁盘上的文件，最多 50 条），而 `SessionRuntime` 桶只有 attach 过的才有。一个没有子进程的行**没有 `entries`**，所以它连 `lastStopReason` 都读不出来——这不是限制，是事实：**没有进程就没有状态**。这类行不画点（等价于 ⚪）。

#### 画在哪儿：最左，不是在右

会话行的结构是 `lb-session-wrap` = 会话按钮 + 删除按钮（flex row），**右手边已经被删除按钮占了**（`.lb-session-wrap .lb-session { flex: 1 1 auto }` 就是给它让位）。所以点放最左：

```
[●] 20260101-120000        2m
    12 messages · 4 steps
    上次说到…
```

即 `lb-session-top` 行内、`lb-session-id` 之前。会话行本来就没有图标（不像工作区行有 `Folder`），最左是空的，不需要动布局。

#### 三条硬规矩

1. **颜色不是唯一信号。** `styles/stream.css:959` 工作区行那儿已经定了这条：
   > "Marked by colour **and** by the word 'current', never by colour alone."

   每个点要有 `title` / `aria-label` 说明它是什么意思（"等你在 ${workspace} 里批准 ${tool}" / "跑完了，还没看"）。**色盲用户和深色/浅色两种模式下都要能分辨**——`--success` 与 `--destructive` 在浅色下是 `#16A34A` / `#DC2626`，都不算高对比，所以文字说明是必需的。

2. **左栏的点不呼吸。** `component-states.md` §7 明确禁止用脉冲动画表达状态翻转；`global.css:409` 的 `.is-working` 给了状态栏那个呼吸点一个专门理由（"running 是持续状态，不是状态变化"）。**左栏里同时有三四个点在呼吸，那个理由就不成立了**，而且它会把注意力从会话内容上拉走。状态翻转只改色（`--motion-fast`）。

3. **灰点不要。** 一个"空闲"的点在 50 行列表里就是 50 个灰点，读起来像"全都没事"，而它其实什么都没说。**空闲 = 不画。**

#### 排序：不重排

需求很自然："要我操作的排最上面。"**但不要做。**

- 左栏现有顺序是 `sessions.items` 给的、按创建时间倒序（`composition.go:110-118` 的注释解释了为什么按创建时间而不是 id）；
- 按状态重排会让行**在手底下跳**——你正要点第三行，B 弹了个审批把它推到第一行，你就点到了别的会话上。列表跳动比多看一眼更糟。
- 要解决"找得到"，用**角标**（工作区行显示该工作区有几个需要处理）+ 状态点的颜色，不用重排。

这条与 `component-states.md` §0 "列表加载新行直接插入，无位移动画"是同一取向。

#### 工作区行的角标

`lb-row` 已经有一个 `lb-current` 文字标记。再加一个数字角标 = 该工作区下**状态点为 🟡 / 🔴 / 🔵 的会话数**（即"需要你看一眼"的数量，不含正跑着的）。0 时不显示。

这样窗口折叠左栏、或者你在 B 工作区工作时，**A 工作区那一行会告诉你 A 里有事**。它是"点"在更大粒度上的同一个答案。

#### 阻塞模态队列（`pendingModals`）

`permission_request` / `question_request` 不带 `session_id`，归属靠 key（§2.3）。队列结构加一个字段：

```ts
export type ModalEntry =
  | { kind: 'permission'; key: string; req: PermissionRequestMsg }
  | { kind: 'question';   key: string; req: QuestionRequestMsg };
```

界面上一律标出来自哪个**工作区 + 会话**——两个会话同时弹审批时，"这是谁在问"是决定性的信息。

`answerPermission` / `answerQuestion` 必须**回到 `entry.key` 那个运行时**：

```ts
answerPermission(decision) {
  const m = get().modal;
  if (!m || m.kind !== 'permission') return;
  set(drainModal(get()));
  sendTo(m.key, { v: 1, t: 'permission_response', id: m.req.id, decision });
}
```

**这一条写错就是两个会话同时卡死**：运行时会永远等它问过的那个 id（`internal/protocol/channels.go:113` 的 `abandonAll` 注释写明"the child process never exits — 看起来像挂住，不像 bug"；`wait` 在 `:130`，语义是"No answer means 'could not ask'"），而另一个会话收到了不属于自己的回答。

队列本身（head 显示、其余按到达顺序等待、一个都不丢）的语义保持——现有注释已经写明理由，多会话只是让队列更容易变长。

**队列与状态点的分工，要说清楚**（否则会以为两者重复）：

- 队列里 **head** 那一条会**立刻变成模态弹在你脸上**，不管它来自哪个会话。所以"有事要你操作"这件事，在宿主的模态里是主动打断的；
- 🟡 点的价值在**另外两种情况**：① 已有模态占着屏幕、第二个会话的请求在**排队**（这时只有左栏告诉你有第二个）；② 模态被答掉之后，你还没切过去看那个会话的上下文。
- 所以：**黄点不是"发现要审批"的唯一途径，它是"还有别的会话在等你"的唯一途径。**

#### 输入框

`draft` / `history` / `historyCursor` / `composerNotice` / `pastedImages` 全部**按会话**。

理由不是"整洁"，是"草稿是'这段对话里我正要说什么'"。并行时用户会在两个会话间来回敲，共用一个 draft 等于互相打断。`ImageTray` 的 `referencedImages` 已经是"从 draft 文本推导"（README 决策 16），所以这一条自然成立：切会话 = 换 draft = 换 chip。

#### 状态栏（`src/components/chrome/StatusBar.tsx`）

**这一整条都是"当前会话"的陈述，所以切换 `activeKey` 时它必须整条跟着换。** 现在它有 13 个元素，来源分四类，其中 11 个是每会话事实：

| 元素 | 现在的来源 | 多会话后 |
| --- | --- | --- |
| phase + 呼吸点 | `selectPhase(s)` ← `entries` / `ready` | 每会话（`selectPhase(s, key)`） |
| action（动作或结算文案） | `selectAction(s)` ← `entries` / `ready` / `runtimeExit` | 每会话（`selectAction(s, key)`） |
| runtimeExit 红字 | `s.runtimeExit` | 每会话（已在桶里） |
| `steps`（累计，**不配上限**） | `session.steps`（= `ui(state).steps`，全会话的 `assistant` 消息数） | 每会话 |
| autopilot 按钮 | `uiState.autopilot` | 每会话（**以运行时回的 `ui(state)` 为准，不是点击**——这条不变） |
| jobs 角标（`outstanding / total`、未收时加重） | `uiState.jobs` | 每会话 |
| subagents 角标 | `uiState.subagents` | 每会话 |
| 用量 `percent · used` | `selectUsage()` ← `liveCall`（本次会话最后一次成功调用，来自 `model_call` 事件）；未见过调用时回落到 `status` + `uiState.modelWindow` | 每会话（`selectUsage(s, key)`） |
| 上下文估算 `~N` | `selectUsage()` ← `context.used` | 每会话 |
| 缓存命中率 | `selectUsage()` ← `liveCall`（**单次调用**的 `cached/prompt`）；回落时是 `status.usage` 的会话总量 | 每会话 |
| 耗时 | `selectTurnMs()` ← 运行中的回合用本地时钟（`turn.startedAt`），结束的用 `lastTurnMs` | 每会话 |
| 审计日志文件名 | `session.auditPath` | 每会话 |
| **quiet 按钮** | `s.quiet` | **每会话**——见下 |

两个函数是这条链的全部入口，**必须一起加参数**：`selectAction`（`:44`）与 `useUsage`（文件末尾）。只改 `selectPhase` 的话，左段会跟着切而右段不动——一排数字停在第一个会话上，界面看起来完全正常。

**`steps` 那一格只报累计，不配上限**（`session.steps`，即 `ui(state).steps`）。上限 `session.maxSteps`（`init.max_steps`）是**每回合**的预算，和会话累计不是一个维度：拼成 `step n / N` 就会出现分子大于分母的读数（`internal/state/session.go` 的 `StepCount()` 数的是全会话的 `assistant` 消息，`internal/agent/agent.go` 的循环每回合从 0 重来）。回合内进度去回合头看，那里已经是 `entry.step / entry.maxSteps`。上限事实留在会话栏的 `step cap` 与设置面板的 `--max-steps`。

**右段不要加"全局角标"。** 我先前写的"右段加一个 `运行中 N`"是错的：这一行的每一格都是当前会话的事实，塞进一个全局计数会让"这一格说的是谁"变得含糊。全局的"还有几个会话在跑"属于**左栏工作区行**（见上），那里它天然是"某个工作区下有几个会话活跃"，语义自洽。

#### `quiet` 归属：从全局偏好改成每会话

今天 `quiet` 是全局前端偏好（`store.ts` 的 `quiet` + `persistPrefs`）。多会话后它应该跟 `draft` 一样进桶。

理由是它的语义：`quiet` 是"**这段对话的流**怎么渲染"（工具调用压成一行），所以它陈述的是会话，不是窗口。更要紧的是它和隔壁的 autopilot 按钮**长得一模一样**（都是 `.st-toggle`）——一个切会话变、一个不变，并排放在同一行里会让人误判。

落地：

- `quiet` 进 `SessionRuntime`，`toggleQuiet` / `setQuiet` 作用于 `activeKey`；
- `persistPrefs` 里的 `quiet` 字段改为按会话持久化（localStorage 里记 `key → quiet`，或者干脆**不持久化**——新的子进程本来就是新的会话，"安静模式跟着上次那个会话"未必是想要的）；
- `commands.ts` 的 `/quiet` 与 `useGlobalKeys` 的 `` Ctrl+` `` 作用于当前会话；
- `QuietGroup` / `StreamView` 读的就是当前会话的 `quiet`。

**这条是对原方案的修改**，不是补充：原文把 quiet 列在"保持全局的前端偏好"里。

#### 键位

- `Ctrl+1..9`：切当前工作区内的第 N 个会话（保持）。
- `Ctrl+L`：左栏显隐（保持）。
- `Ctrl+B`：右栏显隐——**全局**（右栏陈述的是当前会话的 goal/tasks/jobs/MCP，但它是窗口布局，不是会话状态）。与 `quiet` 不同，这个真的该保持全局。

### 4.6 生命周期

```
进入工作区 W（该工作区还没有任何会话）
  └─ attachSession({ workspace: W })        -> key0（一个全新会话，等价于今天的启动）

在工作区 W 里新建会话（场景 1 的第一步）
  └─ attachSession({ workspace: W })        -> key1
     key0 照常跑，一个字节都不动

在工作区 W 里打开已有会话 S
  ├─ 已有 key 持有 S  -> activeKey = key
  └─ 没有             -> attachSession({ workspace: W, sessionId: S })

工作区 A 的会话在跑，切到工作区 B（场景 2）
  ├─ B 有会话 -> activeKey = B 的 key      （A 的进程继续跑）
  └─ B 没有   -> attachSession({ workspace: B })

关掉一个会话     -> runtime_shutdown(key)（优雅，30s 超时后 kill）→ 摘掉桶 + 索引
关窗口 / 退出    -> runtime_shutdown(None) 并行收摊 → destroy 窗口
```

`enterWorkspace(path)` 的"已经在那儿就返回"（`store.ts:1508`）改成"`activeKey` 的会话已经在这个工作区就只切显示"。

**不做并行度上限。** 桥不做业务配额；进程数在左栏可见（工作区行角标），用户自己决定。真要防跑飞，那应该是产品决定，见 §6。

---

## 5. 共享状态：逐路径核实

**所有路径都已在本仓库源码中核实。** 结论先说：`permissions.json`、粘贴暂存、`--ericai` 的凭据三处是**真冲突**，其余按 id 分，天然安全。

| 路径 | 写者（源码位置） | 冲突？ |
| --- | --- | --- |
| `<ws>/.tudouni/sessions/<id>.jsonl` | `SessionStore.Save`，`O_APPEND`（`internal/state/store.go:236`、`:264`） | ❌ **按 id 分文件**，不同会话不冲突。前提是 §4.1 的不变量 2 |
| `<ws>/.tudouni/logs/<id>.jsonl` | `JsonlSink.Write`，`O_APPEND`（`internal/audit/jsonl.go:121`、`:138`） | ❌ 同上 |
| `<ws>/.tudouni/artifacts/<id>/` | `SessionArtifactsDir(id)`（`internal/paths/paths.go:134`） | ❌ 按 id 分目录 |
| `<ws>/.tudouni/jobs/<id>/` | `NewJobBoardForSession`（`internal/tools/builtin/jobs.go:162-168`） | ❌ 按 id 分目录。注意它的 `prune()`（`:184`）只删自己目录下的 `.out` |
| `~/.tudouni/mcp.json` | **只读**（`internal/runtime/config.go:247`）；`mcp load/unload` 不改文件（`protocol/schema/inbound.schema.json`） | ❌ 无写者 |
| 工作区级 `<ws>/.tudouni/mcp.json` | **故意不读**，只 `os.Stat` 一下然后发一条 notice（`internal/runtime/composition.go:645-655`） | ❌ 只读 |
| **`<ws>/.tudouni/permissions.json`** | `SaveApprovals`（`internal/runtime/config.go:162-215`）：读 → 改 → 临时文件 → rename | ⚠️ **真冲突**。见 §5.2 |
| **`<ws>/.tudouni/paste/`** | 桥的 `spawn` 启动时 `remove_dir_all`（`src-tauri/src/lib.rs:387-395`） | ⚠️ **真冲突**。§4.2 已给方案 |
| **`~/.tudouni/config.json`** 的 `providers.ericai.api_key` | `ericWriteBack`（`internal/runtime/ericai.go:336`、`:360`） | ⚠️ 只在 `--ericai` 时 |
| **`~/.tudouni/<eric-refresh>`** | `ericSaveRefreshToken`（`ericai.go:309`、`:325`） | ⚠️ 只在 `--ericai` 时 |

### 5.1 为什么会话文件天然安全

`SessionStore` 的 watermark 是**按 session id 的内存 map**（`store.go:91-92`），`Save` 先读文件尾部补半行（`closeHalfLine`，`:269`、`:380`）再 append。两个进程各持一份 watermark 写**同一个 id** 会打架——但那正是 §4.1 不变量 2 禁止的情形。不同 id 之间没有任何共享状态。

`SessionStore.mu`（`:91`）只在**进程内**有效，这一点要写进文档，别让人误以为它跨进程保护了什么。

### 5.2 `permissions.json`：如实说明 + 两个选项

**影响**：用户在会话 A 按「总是允许 shell」、在会话 B 按「总是允许 read_file」，两次 read-modify-write 并发 → 后写的基于它读到的旧内容，丢掉另一方的一条。概率低、代价小（再按一次即可），但它是**真的会丢**。

**选项 1（不加锁，缩小窗口）**：`SaveApprovals` 写之前重新读盘并把"我持有的集合"与"盘上的集合"取并集。窗口从"整个 turn"缩到"读与写之间的几十微秒"。改动小、无新依赖、不是零风险。

**选项 2（文件锁，真解决）**：跨平台文件锁在 Go 里没有标准库方案（Windows 要 `LockFileEx`，Linux 要 `flock`）。引入 `golang.org/x/sys` 或用 `O_CREATE|O_EXCL` 的锁文件 + 重试。

**建议**：做选项 1，把选项 2 记为可选加固。理由：这个文件的语义是"用户点过的同意"，丢一条的后果是**多问一次**（fail-closed 方向），而不是少问一次。选项 1 的成本与收益相称。

> 注意这条与决策 12 的关系：决策 12 禁掉第二个 App 实例，**恰恰是因为**它以为会话文件/审计/artifacts 也是冲突源。核实之后它们不是（§5.1）。所以真正该修的是这个文件，而不是禁实例——但这是一个独立的加固项，不阻塞多会话。

### 5.3 `--ericai`：跨进程会互相打架，需要收窄

`ericWriteBack` 是 temp + rename（原子但**不合并**），两个进程同时刷新会互相覆盖。更麻烦的是 `refresh_token`：如果 Entra 用的是 rotating refresh token，第二个进程拿同一个 token 去换会失败。

**建议**：UI 上把 `--ericai` 标为"建议同一时刻只在一个会话上开启"，并在 `SettingsPanel` 的确认文案里说明。运行时不改。

### 5.4 文件冲突（同一工作区两个会话改同一个文件）：**不拦**

明确写下来，免得被当成遗漏：

- 运行时侧没有文件锁的概念，加一个就是新功能，不是本方案的一部分；
- 两个会话是**用户自己**开的，他知道它们在同一棵树上；
- DSH 也不拦，交给 `dsh-file-claim` 这类插件（§3 末）。

**但要在文档和 UI 上说清**：同一工作区的两个会话共享 cwd，它们的文件工具边界完全相同。左栏把同一工作区的会话排在一起，本身就是这个事实的呈现。

---

## 6. 要拍板的决策

| # | 决策 | 建议 |
| --- | --- | --- |
| 1 | **single-instance 去留** | **保留**。它拦的是第二个 App 进程，与进程内多会话无关。同时把"二次启动"的 argv 用起来（打开指定工作区）——`desktop-app.md` §3.5 的"附带要做的一件事"，现在 `lib.rs:971` 把 `_argv`/`_cwd` 丢掉了 |
| 2 | **决策 12 的论据** | **改**。从"会话文件/审计/artifacts 会被两个实例同时写"改成"`permissions.json` 是唯一真冲突，且与实例数无关"（§5 已核实） |
| 3 | **是否给并行度上限** | **不设**。进程数在左栏可见。要设就是产品决定，不是本方案的一部分 |
| 4 | **`permissions.json` 加固到哪一档** | **选项 1**（并集重写），选项 2 记为可选（§5.2） |
| 5 | **`session_switch` 是否彻底不再用** | **是**（§4.1 不变量 1）。桌面端改走"一个会话一个子进程"；协议保留给 TUI/CLI |
| 6 | **粘贴暂存目录布局** | `.tudouni/paste/<key>/` + "清理不属于存活 child 的目录"（§4.2）。不这样改就是数据丢失 |
| 7 | **`permission_request` 等消息要不要顺手补 `session_id`** | **不补**。归属靠连接。补字段是不兼容变更，而它带不来任何本方案需要的能力 |
| 8 | **`quiet` 归属：全局偏好还是每会话** | **改成每会话**（§4.5「quiet 归属」）。这是对原方案的修改，也是本轮补入的三处之一 |
| 9 | **状态栏右段要不要加"运行中 N"全局角标** | **不要**。那一行 13 格全是当前会话的事实，塞全局计数会让"这格说的是谁"变含糊。全局计数放左栏工作区行（§4.5） |
| 10 | **会话行的状态点：要几个状态** | **五个**（🟡等操作 / 🔴坏了 / 🟢在跑 / 🔵停下来了等你 / ⚪无点）。**已定**：蓝点要，`interrupted` / `step_limit` / `empty` 都算蓝（§4.5「会话行的状态点」） |
| 11 | **状态点的颜色能不能单独承担含义** | **不能**。必须配 `title` / `aria-label`；`stream.css:959` 已定"never by colour alone"（§4.5「三条硬规矩」） |
| 12 | **左栏的点呼吸不呼吸** | **不呼吸**。`component-states.md` §7 禁止脉冲表达状态翻转；且左栏会有多个点，状态栏那个 `.is-working` 的理由不成立（§4.5） |
| 13 | **"需要操作的会话"要不要重排到顶部** | **不重排**。行会在手底下跳（你点第三行、B 弹审批把它推到第一行）；用角标 + 颜色解决"找得到"（§4.5「排序：不重排」） |

---

## 7. 实施顺序

每一步都能单独跑通、单独验证，不需要"全做完才能启动"。

| 步 | 内容 | 验证 |
| --- | --- | --- |
| 1 | **桥**：`children` 池 + key + 三条事件带 key + 命令签名 + 粘贴暂存 + `image_stash` 走 header | Rust 侧无测试框架（`src-tauri` 里没有 `#[test]`），所以这一层靠脚本：扩 `scripts/single-instance-check.mjs` 那一类（起两个 child，断言两条独立的事件流和各自的退出） |
| 2 | **前端 runtime 层**：`bus.ts` 注册表 + `tauri.ts` 按 key + `useRuntime.ts` 管理器 | `npm run typecheck`；`tests/e2e-runtime.mjs` 扩成**两个**真实子进程 |
| 3 | **store 分桶**：`SessionRuntime` + `applyRuntimeMessage(key, …)` + 按会话节流 + 每会话 problem | `tests/projection.test.ts` 加"两条流互不干扰"的用例；`tests/contract.test.ts` 保持 |
| 4 | **显示层随会话切换**：左栏（工作区角标 + **会话行状态点** + 点行切/起）+ **状态栏整条**（13 格、两个选择器加 key，`selectAction` / `useUsage` 是入口）+ **会话栏**（模型/provider/思考/强度/`maxSteps`/权限范围）+ 右栏（goal / tasks / skills / jobs / MCP）+ `quiet` 进桶 | `scripts/render-check.mjs`（它已经在跑真实 store 实例）：喂两路消息，切 `activeKey`，断言状态栏的 phase、用量、jobs 角标、audit 文件名**四项都跟着变**，而 quiet 之外的前端偏好不变 |
| 5 | **状态点**：`unseen` 字段 + 五态判定（`unseen` 置位/清除、`interrupted`/`step_limit`/`empty` 归蓝）+ 点画在 `lb-session-top` 最左 + `title`/`aria-label` + 不呼吸 | `render-check.mjs` 加断言：跑完一个**非当前**会话的回合 → 蓝点出现；切过去 → 蓝点消失；第二个会话弹审批 → 黄点出现，且**第一个会话的模态仍在**；`interrupted` 之后是**蓝**不是红 |
| 6 | **模态与输入框按会话**：`ModalEntry.key` + 回答回对 key + draft/history/paste 按会话 | `render-check.mjs`：两个会话各弹一个审批，先答第二个，断言第一个仍在 |
| 7 | **加固**：`permissions.json` 并集重写（Go 侧）+ `--ericai` 文案 | `go test ./internal/runtime/`（小改动，按 AGENT.md 的"只跑受影响的包"） |
| 8 | **文档同步**：`desktop/tudouni-aigo-desktop-design/desktop-app.md` 里所有"一个进程一个会话"的陈述——§3.3 握手时序（队列 flush 的对象从"那一个 child"变成"每个 child"）、§3.4 退出语义（`runtime_exited` 现在带 key）、§3.5 单实例（论据改写，`desktop-app.md:90-98`）、§4.3（`session_switch` 桌面端不再用）、§4.6/§4.7（两个阻塞模态要标出会话、回答要回对 key）、§5.2/§5.3（入站/出站的坑表）、§6.1 状态分层的硬规则（事实要带归属）、§6.3 与 Rust 的接口表（全部加 key）、§7.3b 左栏（工作区角标 + 状态点）、§10 决策表第 12 行（`:562`）；以及 `desktop/tudouni-aigo-desktop/README.md`（"stable boundaries"一节里左栏与规则那两段）、`desktop/tudouni-aigo-desktop-design/tudouni-aigo/docs/component-states.md`（§7 补一句"会话行状态点五态与不呼吸"，因为它是设计系统的规矩）和 `docs/REVIEW.md` | 读一遍，确认没有留下"一个进程一个会话 / 一个 child 槽位"的陈述 |

**第 7 步会碰 Go 源码**（`internal/runtime/config.go`）→ 按 AGENT.md，`VERSION` 要动。按改动性质它是**修复/加固**，取修订号：`5.8.2 → 5.8.3`（实际落地值）。若第 7 步不做，Go 侧一行不改，`VERSION` **不动**。

**桌面端版本**：新功能、用户可感知 → `0.6.1 → 0.7.0`（实际落地值）。按 AGENT.md，五处一起改，都已改：

| 文件 | 处数 |
| --- | --- |
| `package.json` | 1 |
| `package-lock.json` | 2（根 + `packages.""`） |
| `src-tauri/tauri.conf.json` | 1 |
| `src-tauri/Cargo.toml` | 1 |
| `src-tauri/Cargo.lock` | 1（`name = "tudouni-aigo-desktop"` 那个 `[[package]]`，当时在 `:3978`） |

**全量验证**（动了 `internal/protocol` 之外的三层，属于大改动）：`make test` + `npm run build` + `npm test` + `npm run audit:css` + `node scripts/render-check.mjs` + 真实二进制的 `tests/e2e-runtime.mjs`。

### 7.1 实施结果（已落地）

第 1–8 步全部实施完成，验证如下：

| 手段 | 结果 |
| --- | --- |
| `npx tsc -b` | 0 错误 |
| `npm test` | **94/94 通过**（迁移到分桶形状后从 92 增至 94，新增两条：回答回到发起会话的 key、审批标出所属会话） |
| `node scripts/class-audit.mjs` | PASS（`.lb-dot` / `.lb-attention` 已补） |
| `npm run build` | 通过 |
| `make vet` / `make build` | 通过；二进制报告 **5.8.3** |
| `node tests/e2e-runtime.mjs <真实二进制>` | **PASS**（开场三连、14 行全部解码、未知类型与坏行都被跳过、shutdown 退出码 0） |
| `go test ./internal/runtime/` | 通过，含新增的 `config_test.go`（并集重写 5 条：并集、保留不属己的键、规则去重、坏文件不覆盖、路径前提） |

**两处与原方案的偏离**，都是查证后改的：

1. **单实例插件的论据改了**。原文说两个实例会同时写 `permissions.json`、`mcp.json`、会话文件、审计日志和 artifacts。逐路径核实后只有 `permissions.json` 成立（会话/审计/artifacts/jobs 都按 id 分，`mcp.json` 只读），而那条与实例数无关——一个应用本来就有多个运行时了。插件保留（桌面上不该开两个窗口是正常的），但理由不再是我先前写的那条。
2. **Rust 侧的验证手段受限**。`src-tauri` 里没有 `#[test]`，所以这一层靠 `cargo check`（干净通过）+ 真实二进制的 e2e 脚本覆盖协议面。桥内部的多 child 行为（两个 child 的事件流互不串台）**没有自动化断言**——这是一个已知缺口，不是已完成的验证。

**一个超出本方案的附带修复**：`REVIEW.md` 的 P1-16 / P1-17 是用户在评审里定下的两条（底栏 `step n / N` 去掉分母、右栏去掉 `(+N more)`），文档侧早已改完而代码侧未动。它们落在本次改动的文件里（`StatusBar.tsx` / `Sidebar.tsx` / `store.ts` / `i18n` / `styles`），所以一并落地：`BLOCK_CAP`、`More`、`block.more`、`.list-more` 全部删除，`status.step` 保留给回合头、状态栏改用新的 `status.steps`（不带分母）。

---

## 8. 明确不做的事

- **不改协议**。`v` 仍是 1，`protocol` 仍是 3。没有一个字段增减。
- **不改运行时**（第 7 步的 `permissions.json` 加固除外，且它是独立项）。
- **不引入多窗口**。`tauri-native-spec.md` §6 要求单窗口 + DOM 弹层；多会话在单窗口内靠左栏切换。
- **不拦同工作区的文件冲突**（§5.4）。
- **不发明 workspace 级配额、优先级、调度**。并行 = N 个子进程各跑各的。
- **不把 `session_switch` 用成"切换显示"**。切换显示不发消息（§4.6）。
- **不做系统级通知**（托盘 / 桌面 toast）。会话行的状态点解决的是"我在这个窗口里看得见"，而"窗口在后台时也能知道"是另一件事，需要 `plugin-notification` + 权限请求 + 免打扰判断，是独立的一轮工作。这一点要在文档里说清，免得被当成状态点的遗漏。
- **不按状态重排会话列表**（§4.5「排序：不重排」）。
- **不给左栏的点加脉冲动画**（`component-states.md` §7，§4.5「三条硬规矩」）。
- **不持久化 `unseen`**。"你还没看过这条"不是一个能活过重启的事实。

---

## 9. 参考：DSH 的做法与差异

来源分两类，可信度不同：

- **官方**：`deepseek-ai/deepseek-harness` 的 `docs/architecture.zh.md`、`docs/subsystems/{core,session}.zh.md`、`apps/desktop/README.zh.md`。下面表里的机制描述都出自这几份。
- **第三方**：插件导航站 `plugin.dshx.dev` 的条目摘要、以及若干博客。只用于"生态里确实有这类插件"，不作为架构依据。

| 维度 | DSH | 本项目 |
| --- | --- | --- |
| 会话与进程 | **单进程多会话**：`ctx.sessions` 是 store，`ctx.agents.create()` 在一个调用方给的 `SessionId` 下建全新会话与 agent，`resume()` 先加载持久会话 | **多进程单会话**（本方案） |
| 工作区 | **每 agent 一个**：`CreateAgentOptions.meta` 带"已校验的 `cwd`" | **每进程一个**：`paths.WorkspaceDir()` = cwd（§2.4） |
| 会话持久化 | append-only `SessionEvent` 日志，模型历史由 `deriveMessages()` 从日志投影（"模型可见即已记录"） | append-only JSONL，但 watermark 是每进程内存（§5.1） |
| 一次运行的边界 | 一个 **turn** 含零或多个 **step**（step = 一次模型请求 + 它调用的工具），turn 在认领首条输入前打开、在不再欠工作时关闭 | 一个 turn = `RunTurn`，step 是模型调用；由 `turnDone` 串行化 |
| 跨会话消息 / 同工作区文件认领 | 第三方插件（`dsh-crosstalk`、`dsh-agent-message`、`dsh-file-claim`） | 本方案不做（§8） |
| 退出前的未完成任务 | 桌面端退出前向 Host 查询"会中断什么"（运行中的 agent、排队消息、后台任务），有则弹确认 | 收摊 = 对每个 child `shutdown`（§4.6） |

**值得抄的一条**：DSH 的 `AgentHandle.dispose()` 被明确设计成**能力**——"among consumers, only the holder can tear this agent down"，而 provider 卸载时会 drain 它造出的所有句柄。本方案的 `ChildKey` 是同一个思路：**key 就是那个"我能拆掉它"的能力**，桥按 key 收摊，前端不持有 key 就动不了别人的会话。

**不值得抄的一条**：DSH 的插件层（Cordis / profile / bundle / patch、HMR、插件事务）。有第三方博客称它的论文证明了"不管以什么顺序装卸插件，最终状态等价于从头加载一次配置"的 confluence 定理——即便属实，那也是一个面向**第三方插件生态**的元框架设计。本项目的扩展面是 MCP + skills，没有"任何人可以替换 agent loop 本身"这个需求。

**架构差异的根因**（这是第 3 节选 A 的依据）：DSH 能让一个进程装多个会话，是因为会话与 workspace 从第一天起就是一等公民（session 是事件日志、agent 有 `meta.cwd`、注册走 `agent.ctx` 作用域）。tudouni 的 workspace 是进程 cwd、`Server` 持一个 runtime 槽位。要走到 DSH 那个形态，等于重做 §2.4 + §2.5 两层。
