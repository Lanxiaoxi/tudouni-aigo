# Ticket：任务级的工作单元

状态：**已实现**。runtime 侧在 `internal/runtime/ticket.go`、`internal/state/ticket.go`、`internal/tools/builtin/ticket.go`（`PROTOCOL = 18`，见 `docs/spec/protocol.md` 3.16）；桌面端在 `desktop/tudouni-aigo-desktop/src/ticket/`（model / machine / store / view）、`src/state/slices/tickets.ts`、`src/state/slices/ticketRuns.ts`、`src/state/ticketLanding.ts`、`src/components/board/TicketBoard.tsx`，Rust 侧 `src-tauri/src/tickets_data.rs`。与本文的出入：`start` 命令自带执行者并直接建 Assignment（`assignmentStarted` 只回填 sessionId / 恢复后的新 sessionKey）；新增事实 `assignmentRestoreFailed`；新增退出原因 `unreachable`（见 6.4）；`Assignment.executor` 多一个可选 `workspace`；`sendBack` 先确保会话可用再迁移；"直接开跑"是独立按钮；`ticket_bind` 的字段上限在桌面端被镜像了一份并在建/改时就拦截（见 5.5）。

这份文档回答三件事：Ticket 是什么、它的状态由谁来写、为了将来扩展到团队能力，现在要在哪些地方留口子。

参考对象是 `deepseek-ai/dsh-superagent-prototype`（下文简称 superagent），它是一个团队级、无人值守的编码 agent。本设计借鉴它的**任务级模型**，但不照搬它的 Source / Eval / Policy 这一整套：那些是为"别人来派活"准备的，现在的使用者只有一个人。

---

## 一、为什么要有 Ticket

桌面端现在是**会话级**设计：一个会话就是一个 runtime 子进程，session board 按会话来展示状态。这在"自己同时开两到四个会话、自己盯着"的用法下够用，但有一个结构性缺口：

**"这件事做完没有"没有地方回答。**

- session board 的 Finished 列来自 `RowStatus` 的 `unseen`，它的意思是"一个 turn 停了，而你还没看"。一个 turn 停下来，可能是做完了，也可能是模型在文字里问了一个问题，还可能是半途放弃了。这三种情况都画在 Finished 里。
- Task 面板里的 todo（`TaskKind = 'todo'`）已经是 Ticket 的雏形：它比会话活得久，有 `todo → doing → done` 三态，也能挂多次运行（`TaskRunLink`）。但它有三个问题：
  - 它和 template 共用 `Task` 这一个实体。template 是"会产出工作的规则"，todo 是"工作本身"，两者被硬放在一起。
  - 它的状态只有人能推进，agent 没办法回报"做完了"或"卡住了"。
  - 会话不知道自己在做哪个 todo。关联只记在桌面端，方向是 todo 指向会话。

Ticket 要补的是会话**上面**那一层：一个比会话活得更久、终态明确、由 agent 回报事实来驱动的工作单元。会话就是它的 worker。对应 superagent 的结构是：

```
superagent:  Source → Eval → Ticket（持久） → Assignment → worker session
tudouni:     人     → 人   → Ticket（持久） → Assignment → 会话（runtime 子进程）
```

## 二、范围

**要做的：**

- 新实体 Ticket，带状态机，从 Task 里完全拆出来。
- runtime 侧加一条窄的回报通道：`ticket_bind` 入站、`ticket_report` 工具、`ui(ticket_report)` 出站。
- 新增 Ticket board 视图，有两个入口：顶栏图标和 workbench 里的一行。
- 删除 todo：去掉 `TaskKind`、`TodoStatus`、`TodoRow`、`emptyTodo`、`withKind`，以及 Task 面板里所有 todo 分支。

**明确不做的：**

- 不碰 goal。goal 是"一个会话内的长期目标与自动续行"，Ticket 是"跨会话的工作单元"，两者概念独立。以后如果要联动，在 Ticket 侧加一个读取 goal 状态的展示即可，不改 goal 本身。
- 不改 session board 的语义和列定义。只有一处结构性改动，见第七节。
- 不做 Source、Eval、自动接单、多用户、外部通知渠道。第九节会写清楚这些将来接在哪里。
- 不迁移旧数据。已存的 `kind: 'todo'` 记录在加载时直接丢弃（产品决定：旧 todo 数据不重要）。

## 三、概念

| 概念 | 定义 | 规则 |
| --- | --- | --- |
| Ticket | 一件要做完的工作 | 比任何会话都活得久；一个 Ticket 同时最多只有一个进行中的 Assignment |
| Assignment | Ticket 交给一个执行者的那一段：从交出去到收回或转交，现在执行者就是一个会话 | 只增不删；会话没了，记录还在。**只有执行者换了才新建**：开始、重来（开新会话）、原会话恢复失败。打回、断线后继续、app 重启后继续都沿用原来的 Assignment。所以 Assignment 只在执行者真正被收回或换掉时结束，原因只有四种：`superseded` / `accepted` / `dropped` / `restore_failed`（见 6.1） |
| Report | agent 通过 `ticket_report` 回报的一条事实 | 只能是 `done` 或 `blocked`；带 `report_id`，按 id 幂等 |
| Event | Ticket 上发生过的一件事（命令或事实） | 只追加不修改，有上限（见 6.3）。Ticket 的当前状态是**快照**：状态机处理事件时一并算出，和事件在同一次写入里落盘。事件是历史，不用来回放推导状态 |

命名约定借自 superagent，用来区分谁在说话：

- **命令**用祈使句，由人发出，可能被拒绝，例如 `start`、`accept`、`sendBack`、`drop`、`reopen`。
- **事实**用过去式，由适配器（runtime 回报、会话生命周期）发出，不会被拒，只会被记录或忽略，例如 `assignmentStarted`、`reported`、`assignmentExited`、`personReplied`。

## 四、状态机

```
            start                agent: done             person: accept
  open ──────────────▶ running ──────────────▶ review ──────────────▶ done
   ▲                    │  ▲                    │                      │
   │                    │  └── person: sendBack ┘                      │
   │                    │  ▲                                           │
   │   agent: blocked / │  │ personReplied / start                     │
   │   assignmentExited    ▼  │                                           │
   │   (unrequested)  needs_you                                        │
   │                                                                   │
   └──────────── reopen ◀──── dropped ◀── person: drop（任意非终态）    │
   └──────────── reopen ◀──────────────────────────────────────────────┘
```

| 从 | 事件 | 到 | 说明 |
| --- | --- | --- | --- |
| `open` | `start`（人） | `running` | 开一个新会话，记一个 Assignment |
| `running` | `reported(done)` | `review` | agent 声称做完，**不等于**完成 |
| `running` | `reported(blocked)` | `needs_you` | 必须带一个具体问题 |
| `running` | `assignmentExited(requested=false)` | `needs_you` | 子进程不是被人关掉、而是自己挂了，或远程连接断了（见 6.5）。事件带 `reason`（`crashed` / `disconnected`），Assignment **不结束** |
| `running` | `assignmentExited(requested=true)` | `running`（不变） | 人关掉了会话或关掉了窗口。工作没有结束，只是没人在执行；卡片显示"未连接"，按"继续"会恢复**原会话**（见 6.5） |
| `needs_you` | `personReplied` | `running` | 人在这个 Assignment 的会话里发了消息。按"继续"恢复会话本身不算，见不变量 7 |
| `needs_you` | `start`（人） | `running` | 换一个新会话重来：旧 Assignment 记为 `superseded`，生成新的 Assignment |
| `review` | `accept`（人） | `done` | **只有人能把 Ticket 设成 done**。进行中的 Assignment 记为 `accepted` 并解绑（见 5.1） |
| `review` | `sendBack`（人，带意见） | `running` | 意见作为一条用户消息发给原会话。原会话已关闭就先恢复它（`openSession(sessionId)`）再发；恢复失败才把旧 Assignment 记为 `restore_failed`，开新 Assignment，意见连同 brief 一起预填（第十一节） |
| 非终态 | `drop`（人） | `dropped` | 有进行中的 Assignment 时记为 `dropped` 并解绑（见 5.1） |
| `done` / `dropped` | `reopen`（人） | `open` | 刻意的一步，不会自动发生 |

几条不变量：

1. **Ticket 的状态不从 turn 推断。** turn 结束了但没有 report，Ticket 仍然是 `running`。卡片上会画出这个 Assignment 会话的状态点（直接读 `selectRowStatus`），所以"会话已空闲、但没有回报"人是看得到的。它是从会话读来的展示，不是 Ticket 的状态。这正是 session board 的 Finished 语义不清的原因，Ticket 不能重蹈覆辙。
2. **权限弹窗不触发状态迁移。** 审批是一闪而过的东西，由会话状态点（`asking`）表达。`needs_you` 只留给持久的卡点。
3. **被人 Esc 中断不算卡点**，和 `selectRowStatus` 的红点规则一致。
4. **`done` 只能由人设置。** agent 的 `done` 只是一份声明，进入 `review`。这一点和现有 todo 的 "`done` is only ever set by the person" 一致。
5. **不在 `running` 的 Ticket 收到 report 时，记录事件但不迁移状态。** 例如 Ticket 已被 drop，绑定的会话还没来得及收到解绑。这对应 superagent 的"Ticket 结束后，工具调用一律拒绝"。runtime 侧也会拒绝（见 5.3），这里是兜底。
6. **只有 `running` 收到 `assignmentExited` 才迁移。** `needs_you` / `review` 下会话退出（不管是不是人关的）只记事件，状态不变：卡点和待验收都还在，只是会话不在了。
7. **恢复会话本身不迁移状态。** `needs_you` 的 Ticket 按"继续"恢复了原会话之后仍是 `needs_you`，要等人在会话里发了消息（`personReplied`）才回到 `running`。断线导致的 `needs_you` 也一样，不按原因区别对待。

状态迁移全部集中在一个纯函数里：

```ts
// src/ticket/machine.ts
type Apply = (ticket: Ticket, event: TicketEvent) =>
  | { ok: true; ticket: Ticket }
  | { ok: false; reason: TicketRefusal };   // 只有命令会被拒；事实总是 ok（可能 no-op）
```

UI、reducer、回报处理都只调用它，不在别处写 `status`。

## 五、runtime 侧：一条窄的回报通道

runtime **不知道 Ticket 存在哪里，也不知道它的状态机**。它只做三件事：记住"我在为哪个 Ticket 工作"，给模型一个回报工具，把回报原样转发出去。这样以后 Ticket 存储搬到别处，比如团队服务端，runtime 一行都不用改。

### 5.1 入站：`ticket_bind`

```json
{"v":1,"t":"ticket_bind","ticket":{"id":"tk-…","title":"…","brief":"…"}}
{"v":1,"t":"ticket_bind","ticket":null}
```

- 桌面端在 `waitForReady` 之后、预填 prompt 之前发送，时机和 `set_autopilot` / `set_model` 相同。
- runtime 把绑定写进会话 metadata（`ticket` 记录，与 `goal` 平级），所以 `/resume` 或重新打开这个会话，绑定仍然有效。
- `ticket: null` 表示解绑。Ticket 被 accept、drop，或 Assignment 被 superseded 时，如果会话还活着，当场发送。
- **会话不在线时，靠打开时比对来解绑。** 会话没打开时没人收这条消息，旧绑定会留在 metadata 里，`/resume` 后工具又会被注册。所以桌面端每次打开会话，都拿 `init` 带回的 `ticket` 绑定和本地记录比对：如果绑定指向的 Ticket 已经不在 `running` / `needs_you` / `review`，或者它当前的 Assignment 不是这个会话，就立刻发 `ticket_bind null`。顺序是先对账（6.3）补齐漏掉的 report，再解绑。

### 5.2 工具：`ticket_report`

只有绑定了 Ticket 的会话才注册这个工具，解绑时注销（`tools.Registry.Unregister` 已经存在，`code_explore` 的开关是同样的先例）。理由沿用 `registry.go` 里的规则：一个只会回答"没配置"的工具，每次都浪费一次往返，还会让模型以为工具会撒谎。

```
ticket_report(
  status:   "done" | "blocked",
  summary:  string,            // 做了什么 / 卡在哪；给人看的，短
  question: string?,           // status=blocked 时必填：一个具体问题
  evidence: string[]?          // 可选：验证命令、PR 链接、文件路径
)
```

- 校验在工具里做：`blocked` 不带 `question` 直接被拒并提示原因。这对应 superagent 哲学里"一次只问一个具体问题"。
- 工具不结束 turn。模型报完 `done` 之后通常会自己停下；用 prompt 引导，不做强制。
- 每次调用生成一个 `report_id`，追加到会话 metadata 的 `ticket.reports`。
- 绑定时，payload 尾部加一条 note（走 `Runtime.notes()`，不进 `session.Messages`，和 goal 摘要同一机制），内容是 Ticket 标题、brief，以及"做完或卡住时调用 `ticket_report`"。
- **尾部引用的是 brief 的开头，不是全文。** 这条 note 每一轮请求都发一次，按 bind 上限（20000 字）引用全文就是每轮多付约 5k token，比这条说明本身的价值高一个数量级；完整 brief 本来就在会话第一条消息里，读一次、之后随最老的历史一起被压缩掉。`TicketText` 因此只引用 `TicketTailBriefRunes`（2000 字），并**明说截断了多少**——静默截断比多花 token 更糟，模型会把半截 brief 当成全部工作。这正是 goal 的做法：`GoalText` 引用 objective 而不是整份计划。
- **重发同一个 bind 不写盘。** 桌面端每次打开会话都会发一次 `ticket_bind`，而绝大多数时候 id / title / brief 都没变。`state.BindTicket` 因此返回第二个值"记录是否真的变了"，runtime 只在这个值为真时 `Checkpoint()`；工具注册表两种情况都对账（`applyTicketTool` 幂等且便宜），因为恢复的会话可能带着一个注册表还没跟上的绑定。

### 5.3 出站：`ui(ticket_report)`，以及对账

```json
{"v":1,"t":"ui","kind":"ticket_report","ticket_id":"tk-…","report_id":"…","session_id":"…",
 "status":"done","summary":"…","question":null,"evidence":[],"at_ms":0}
```

- 桌面端收到后，把它当作 `reported` 事实交给 `machine.ts`，按 `report_id` 去重。
- **对账**：桌面端可能错过实时消息，比如窗口在 report 那一刻正在重载。所以 `init`（或 `session_load`）要带上 metadata 里的 `ticket` 绑定和 `reports` 列表，桌面端打开会话时按 `report_id` 补齐漏掉的部分。这和 superagent 的 `AgentDelivery`（按 request id 只投一次、跨 session 恢复）是同一个思路。
- 解绑之后再调用 `ticket_report`，因为工具已被注销，模型拿不到它。如果解绑和调用恰好同时发生，runtime 以"已解绑"为准并拒绝。

### 5.4 协议与版本

- `PROTOCOL` 从 17 升到 18，属于纯加法：一个入站 kind、一个 `ui` kind、`init` 里多一个可选字段。旧前端不认识新 kind，按协议规则忽略即可。
- **旧 runtime 的处理**：远程工作区可能装着旧 runtime（远端 `~/.tudouni/runtime/current` 落后于桌面端的情况出现过）。桌面端在 `init` 看到 protocol < 18 时，Ticket 照样可以启动，但卡片上要标出"runtime 过旧，agent 无法回报"，不能假装有回报通道。
- 要同步更新 `docs/spec/protocol.md` 和 `protocol/schema/*.schema.json`。

## 六、桌面端：实体、存储、写者

### 6.1 实体

```ts
// src/ticket/model.ts
interface Ticket {
  schema: 1;
  id: string;                         // "tk-<time36>-<rand>"；不嵌入任何本机信息
  title: string;                      // 可空，空时取 brief 第一行（沿用 taskTitle 规则）
  brief: string;                      // 工作描述，即发给会话的首条消息
  workspace: TaskWorkspaceRef;        // 复用：active / local / remote
  model: string;                      // 空 = 工作区当前模型
  status: TicketStatus;               // 'open'|'running'|'needs_you'|'review'|'done'|'dropped'
  assignments: Assignment[];          // 只增；最后一个可能是进行中的
  events: TicketEvent[];              // 只增，有上限（见 6.3）
  lastReport: Report | null;          // 冗余字段，给卡片直接用
  createdAtMs: number;
  updatedAtMs: number;

  // —— 扩展口（第九节），现在都只有一个取值 ——
  origin: { kind: 'manual' };
  requester: Actor;                   // 现在恒为 { kind: 'person', id: 'local' }
  mandate: { basis: 'manual' };
  delivery: { kind: 'local' };
}

interface Assignment {
  id: string;
  executor: {                         // 现在只有 'session'
    kind: 'session';
    sessionKey: string;
    sessionId: string;                // init 后回填
    remoteWorkspaceId: string | null;
  };
  startedAtMs: number;
  endedAtMs: number | null;
  // null = 仍归属于 Ticket（会话可能活着，也可能没打开、断了线或报过 blocked）。
  // 只在执行者真正被收回或换掉时设置；report 和退出都是事件，因为同一个
  // Assignment 在它们之后还会继续。
  end: 'superseded' | 'accepted' | 'dropped' | 'restore_failed' | null;
}

type Actor =
  | { kind: 'person'; id: string }
  | { kind: 'agent'; sessionId: string }
  | { kind: 'system' };

interface TicketEvent {
  at: number;
  actor: Actor;
  type: 'created' | 'start' | 'assignmentStarted' | 'reported' | 'personReplied'
      | 'assignmentExited' | 'accept' | 'sendBack' | 'drop' | 'reopen' | 'edited';
  data?: Record<string, unknown>;     // 例如 report 内容、sendBack 的意见
}
```

### 6.2 唯一写者

- **Ticket 唯一的写者是桌面端的 `machine.ts`。** runtime 只报事实；UI 只发命令；会话生命周期钩子（`attachSession` / `runtimeExit` / 发送用户消息）只翻译成事实。
- 会话状态（`RowStatus`）**只读**，用于在卡片上画状态点，永远不回写 Ticket。
- 所有对 Ticket 的读写都经过 `src/ticket/` 这一个模块，`slices/tickets.ts` 只是把它接进 zustand。以后存储从本地文件换到 runtime 或服务端，只需要替换这一层。

### 6.3 存储

**两份数据，一主一从。**

| 数据 | 位置 | 地位 |
| --- | --- | --- |
| Ticket 本身（状态、Assignment、事件） | 本机 `~/.tudouni/tickets.json` | **权威**。唯一写者是 `machine.ts` |
| 会话的绑定和它报过的 report | 执行它的那台机器上，会话 metadata 的 `ticket` 记录（`<workspace>/.tudouni/sessions/<id>.jsonl`） | **事实的副本**，只用于对账，从不反向覆盖 Ticket 状态 |

**单独一个文件，不放进 `desktop.json`。** `desktop.json` 现在放的是模板、SSH 主机、远程工作区这些很少变动的配置。Ticket 每发生一个事件就要写一次，两者的写入频率差了几个数量级。分开存放有三个好处：

- 每次写入只重写 Ticket 文件，不碰主机配置；
- 一个文件坏了，影响不到另一个；
- 第九节说的"存储搬走"只涉及这一个文件。

代价是 Rust 侧要加一对命令 `tickets_read` / `tickets_write`。做法照抄 `desktop_data.rs`："只搬字节、不解析"，写入用同目录临时文件 + rename 保证原子性。文件格式是 `{ "schema": 1, "tickets": [...] }`，`schema` 只增不减；读到比当前更新的 schema 就拒绝写回，防止旧版桌面端把新数据写坏。

其余规则：

- 加载时用 `isValidTicket` 守卫，不合法的记录整条丢弃，和 `isValidTask` 的规矩一样。
- 写 `tickets.json` 的进程只有一个：桌面端用了 `tauri-plugin-single-instance`，不会有两个实例同时写。如果以后放开单实例，这里要加修订号检查，否则后写的会覆盖先写的。
- **事件和状态在同一条记录里，一次原子写入。** 所以不会出现"事件写进去了，状态还是旧的"这种半截状态。
- `events` 每个 Ticket 最多保留 200 条，超出时丢最旧的，但 `created` 那一条永远保留。`assignments` 不设上限，因为一个 Ticket 换执行者的次数本来就很少。
- `done` / `dropped` 状态的 Ticket 不自动清理。board 上默认折叠，并提供"清除已完成"。
- 加载 `tasks` 时过滤掉 `kind === 'todo'` 的记录，`taskRuns` 中指向它们的 link 一并丢弃。之后不再写 `kind` 和 `status` 字段。

**丢消息的窗口与对账。** 本地子进程在窗口关闭时会被一起结束（`runtime_commands.rs` 的"窗口关闭，全部会话一起收"），远程 runtime 是 SSH exec 出来的进程，连接一断就结束（`launch_remote.rs` 的 `exec`），所以**不存在桌面端不在、会话还在跑的情况**。漏收 report 只可能发生在一个很窄的时间窗里：runtime 已经把 report 写进 metadata 并发出 `ui(ticket_report)`，桌面端还没来得及落盘就崩了。补救办法有两条：

1. runtime 侧**先 checkpoint 再发消息**。report 先进 metadata，再出 `ui`，这样"发出过"就一定意味着"已经记下"。
2. 桌面端每次打开一个绑定了 Ticket 的会话时，从 `init` 带回的 `reports` 里按 `report_id` 补上漏掉的条目，然后交给 `machine.ts` 处理。已经处理过的 id 直接跳过，所以重复对账没有副作用。

对账**只在打开会话时发生**。启动 app 时不会为了对账去拉起子进程或连接远程主机：那样做的代价是每个 `running` 的 Ticket 都要起一个 runtime，远程的还要建 SSH 连接，换来的只是那个很窄的窗口。

### 6.4 启动与执行

`startTicket(id)` 复用 `runTask` 的开会话逻辑（`active` / `local` / `remote` 三条路，以及"只认这次 open 新建的 bucket"这道防线）。差别在于：

1. 新会话起来后，依次发 `ticket_bind`、`set_model`。
2. 默认只把 brief **预填**到 composer，不自动发送。这和现在 todo 的行为一致，Ticket 默认是"有人在场"的工作。"开始"按钮另带一个"直接开跑"选项：在第 1 步之后再发 `set_autopilot`（开启），然后把 brief 作为首条用户消息自动发出（第十一节）。
3. 写入 `assignmentStarted` 事实。如果 Ticket 已有一个进行中的 Assignment，先把它标成 `superseded`，并给旧会话发 `ticket_bind null`。

"打开会话"按钮：会话还活着就 `focusSession`，否则 `openSession(sessionId)`，与 `TodoRow.open` 相同。

**"未连接"不是一个状态。** `running` 的 Ticket，如果它的 Assignment 会话当前不是活着的子进程，卡片上就显示"未连接"，按钮从"打开会话"变成"继续"。最常见的情况是 app 重启之后，所有 `running` 的 Ticket 都会这样。"未连接"是从会话存活情况推导出来的展示，不写进 Ticket，原因和不变量 1 一样：Ticket 的状态只由事件写入。按"继续"会恢复原会话（`openSession(sessionId)`），绑定从会话 metadata 里自动带回来，不需要重新发 `ticket_bind`，同时触发一次对账（6.3）和绑定比对（5.1）。恢复本身不迁移状态（不变量 7）。

**握手没到，等于执行者没了。** 上面那条推论有个前提：Assignment 记着 `sessionId`，所以"继续"有东西可恢复。一个 start 如果卡在握手（`waitForReady` 超时，或 bucket 在等待期间被替换/关闭），这个前提不成立——`start` 早已把状态写成 `running`，而 `running` 卡片只提供"继续"，它解析不出 id，于是在卡片上表现为**一个永远按不动的按钮**。

所以 `deliverStart` 在握手不是 `ready` 时发一条 `assignmentExited(requested: false, reason: 'unreachable')`（`ticketLanding.landTicketUnreachable`）。这走的是既有的"未经请求的退出 → `needs_you`"迁移，不引入新的状态转换，也不给 `ticketActions` 加 `running` 的例外——状态机仍然是唯一决定状态的地方。理由是它说的就是实情：**执行者没了，而且不是人让它走的**。卡片因此显示"会话没起来，请重开一个"（`ticket.cause.unreachable`），并把"重来"交给 `needs_you` 那一列本来就有的按钮。

`reason` 用一个独立取值而不是复用 `crashed`：什么都没跑起来，也就没有东西崩溃，说成崩溃是关于一个从未启动的进程的假话。这条事实**不结束 Assignment**（和不变量 6 一致：退出只是事件），所以 `assignments.length` 不变。

### 6.6 `ticket_bind` 的字段上限

runtime 对 bind 的三个字段有硬上限（`internal/state/ticket.go`：id 200、title 500、brief 20000），超了直接拒绝，桌面端只会收到一条 `notice`。这构成了 §5.4 那条规则的另一种破法：**Ticket 的状态在 bind 之前就已经写成 `running` 了**，于是超长 brief 会得到一个说 Running、却没有任何回报工具的卡片，而且协议号是 18，卡片连"runtime 过旧"的徽标都不会显示。

桌面端因此把上限镜像了一份（`ticket/model.ts` 的 `TICKET_TITLE_CEILING` / `TICKET_BRIEF_CEILING`），在三个位置挡：表单输入时给出提示并禁用提交、`createTicket` 拒绝建、`updateTicketDraft` 拒绝改。`view.canBindBrief` 再兜一层，让这样的记录（比如手改过文件）显示"过长"徽标并禁用开始。

三个数字必须和 runtime 一致，而这件事构建期检查不了——`tests/ticket-board.test.ts` 直接读 `internal/state/ticket.go` 比对，这是唯一能防止两边漂掉的办法。

### 6.5 远程工作区

Ticket 永远存在本机，执行它的会话可以在远程。两者靠三样东西连起来：

- `Ticket.workspace`：复用 `TaskWorkspaceRef`，远程的写法是 `{kind:'remote', id}`；
- `Assignment.executor.remoteWorkspaceId`：从**实际打开的 bucket** 上读，不从 Ticket 的 ref 上读。理由和 `runTask` 写 `TaskRunLink.remoteWorkspaceId` 时相同：ref 可以是 `active`，而以后要恢复会话时，要知道的是它当时**在哪台机器上**跑的；
- `sessionId`：会话文件和绑定都在那台机器的 `<workspace>/.tudouni/sessions/` 下。

几种情况分别这样处理：

| 情况 | 处理 |
| --- | --- |
| SSH 断线 | runtime 随连接一起结束，会收到一个未被请求的退出。按会话的处理方式，Ticket 进入 `needs_you`，事件记为 `assignmentExited(reason: disconnected)`，Assignment 不结束。`reason` 来自 Rust 侧：远程 bridge 在 `runtime://exited` 的载荷（`ExitPayload`）里加一个 `reason` 字段（如 `ssh_closed`），本地子进程不带。桌面端据此区分 `crashed` 和 `disconnected`，不按工作区类型去猜。卡片上写"连接已断开"而不是"出错"。"继续"会重新连接并恢复原会话，report 靠对账补齐。断线确实需要人去处理（重连），所以算作卡点，但措辞上不能让人以为是 agent 出了问题 |
| 远程 runtime 版本过旧（protocol < 18） | 桌面端在 `init` 里读到协议号后，**不发** `ticket_bind`。发给旧 runtime 也只会被静默忽略，那样人就会误以为有回报通道。Ticket 照样可以启动，卡片上标出"runtime 过旧，agent 无法回报，请手动推进"，状态只能由人来改。远程 runtime 装成旧版本，最常见的原因是安装包里打进了旧的 `remote-packages`，排查从那里开始 |
| 远程工作区或主机被删除 | `workspaceRefLabel` 返回 `null`。卡片标出"工作区不存在"，"开始"和"继续"按钮禁用；已有的 Assignment 记录保留，`drop` 和编辑不受影响。可以把 Ticket 改指向另一个工作区，但只对新的 Assignment 生效，旧 Assignment 的 `remoteWorkspaceId` 不会被改写 |
| `active` 工作区的 Ticket | 第一次开始时"在哪"由当时所在的屏幕决定，之后"继续"按 Assignment 上记录的 `remoteWorkspaceId` 和 `sessionId` 恢复，不按当前屏幕。否则在另一个工作区按"继续"，就会把会话恢复到错的机器上 |
| 换一台电脑 | `tickets.json` 跟着用户目录走，可以直接复制过去。远程 Ticket 在新电脑上仍然能用，前提是 `desktop.json` 里的远程工作区 id 也一起复制了；`local` 路径的 Ticket 在新电脑上会显示"工作区不存在"。不做跨机器同步，那属于第九节说的"存储搬走" |

runtime 侧对远程**没有任何特殊处理**：绑定、工具、report、metadata 在本地和远程都是同一套代码。远程问题全部由桌面端处理，因为"Ticket 在哪"和"会话在哪"这两个事实都只有桌面端知道。

## 七、UI

### 7.1 入口：一个控件，两个入口

照搬 session board 的做法："One control with two entrances rather than two controls that can disagree"。两个入口读同一个 gate、执行同一个 action、使用同一组 i18n key。

| 入口 | 位置 | 图标 | 备注 |
| --- | --- | --- | --- |
| 顶栏 | `SessionBar` 里，紧挨 session board 的 `LayoutGrid` 按钮，同样放在 `.sb-scroll` 之外 | lucide `Ticket` | tooltip 写明"工单看板"，与"会话看板"区分 |
| workbench | `WorkspaceSidebar` 的 `navItems`，`settings` 组，放在 Session board 旁边 | lucide `Ticket` | 带徽标，见下 |

需要改动、不能照搬的地方：

- **gate 不同。** session board 用 `selectBoardAvailable`（要求有活着的子进程）。Ticket 是持久的，没有任何会话时也必须能打开，所以 gate 只看 `railBlocked`，和 Tasks 一样。
- **workbench 那一行带徽标。** 数字是 `needs_you + review` 的个数，用 `attention` 色调，为 0 时不画，规则和 Memory 的待审候选一样。这是 Ticket 最该占用注意力的地方。顶栏图标不画数字，因为那一行是 34px 的紧凑信息区。
- **托盘菜单**暂不加入口。托盘的两个动作是围绕会话设计的，等 Ticket 用顺了再看需不需要。

### 7.2 两个 board 互斥：`boardOpen` 改为联合类型

现在直接读 `boardOpen` 的地方有：`App.tsx` 的 `showSidebar` / `showSummary`；`SessionBar.tsx` 的 board 按钮（`aria-pressed`、`disabled`），以及旁边那个 `disabled={boardOpen}` 的按钮；`conversationView.ts` 的 `'board'` 分支；`useGlobalKeys` 的 Esc 顺序与 `Ctrl+B`；`WorkspaceSidebar` 的 `blockedByBoard` 和 navItem 的 `active` / `disabled`；`useTrayCommands`（连带 `selectBoardAvailable`）；`slices/composer.ts` 的 `setBoardOpen`；`store.ts` 的初值。`selectors/session.ts`、`modalQueue.ts`、`SessionBoard.tsx`、`storeShape.ts` 和 `turn-rail.css` 里有讲到它的注释，要一起改。

如果再加一个 `ticketBoardOpen: boolean`，每一处都得记着两个都判断，漏一处就会出现两个 board 叠在一起。所以改成：

```ts
board: null | 'sessions' | 'tickets';
```

- 互斥由类型保证。`setBoard(next)` 是唯一的入口，打开一个 board 就意味着另一个被关闭。
- 现有读 `boardOpen` 的地方，凡是表达"有 board 在屏幕上"的，改读 `board !== null`；只和 session board 相关的，改读 `board === 'sessions'`。
- `blockedByBoard`（禁止新建和删除会话）只在 `board === 'sessions'` 时成立。Ticket board 上恰恰需要能启动会话。
- Esc 的顺序保持 modal → panel → board → 中断不变，"board"这一级同时覆盖两个 board。
- 这是对 session board 唯一的改动，属于重构，行为不变，要有测试锁住。

### 7.3 Ticket board 本身

- 做成 view，不做成 dialog，理由和 session board 完全相同：rail 要能用，点卡片不能把 board 关掉，审批来了不能把它冲掉。
- 列：**Open · Running · Needs you · Review · Done**。`dropped` 不单独成列，并入 Done 列底部的折叠区，或者通过过滤器查看。
- 列顺序就是 Ticket 正常走过的顺序。要人动手的 Needs you 和 Review 挨着放在中间，扫一眼就能看到。
- 卡片显示：标题、工作区（Ticket 跨工作区，和 session board 卡片一样逐张标出）、`lastReport.summary`（blocked 时显示 `question`）、Assignment 次数（界面文案写"第 N 次执行"，不出现"指派"这个词），以及进行中 Assignment 的会话状态点（读 `selectRowStatus`）。
- 卡片按钮随状态变化：

  | 状态 | 按钮 |
  | --- | --- |
  | open | 开始（带"直接开跑"选项，见 6.4） |
  | running | 打开会话 |
  | needs_you | 打开会话、重来（新 Assignment） |
  | review | 打开会话、验收、打回（输入意见） |
  | done / dropped | 重新打开 |

  非终态都可以放弃。删除沿用 app 的"两次按下"确认。
- 新建 Ticket：**board 头部一个「New Ticket」按钮，点开是一个对话框**，字段有 brief（必填）、标题（可选）、工作区、模型，四个一次全显示。现在 composer 里"存为 todo"（`openTodoDraft` / `todoSeed`）改为"存为 Ticket"，打开的是同一个对话框并带入 brief。

  最初实现成 board 顶部常驻的 composer 式输入框，改掉了，理由三条：

  1. **它每次进来都要占用 board 的高度**。四列工作被一个没人要用的输入框往下压。
  2. **它把最要紧的字段藏起来了**。工作区和模型——决定*活儿在哪跑*的两个答案——放在默认收起的「Details」后面，于是默认值（跟着当前屏幕）成了绝大多数 Ticket 唯一拿到过的值。对话框有地方一次显示全部四个字段，没有任何东西在第二次点击后面。
  3. **它的形状像 composer**，读起来像"往里打一条消息"，而新建 Ticket 是一个有始有终的动作。

  保留的：brief 仍是唯一必填，`Ctrl+Enter` 仍然提交，运行时会在 `ticket_bind` 拒绝的超限仍**在输入框旁边**提示（`unbindableField`），而不是等一次注定失败的 Start 之后。Esc / 点遮罩 / Cancel 都关闭对话框；拒绝创建**不**关闭它——拒绝的对象正是那行输入。
- 通知：Ticket 进入 `needs_you` 或 `review` 时，经由现有的 `useNotifications` 发一条系统通知。当前就在看这个 Ticket 的 Assignment 会话时，不发。

### 7.4 Task 面板的清理

删除 `TodoRow`、`ShelfFilter` 中的 `'todo'` 选项、编辑器里的 kind 分段控件、`emptyTodo`、`withKind`、`isTodo`、`todoStatus`、`TaskKind`、`TodoStatus`，以及 `runTask` 里的 todo 分支。之后 `taskTitle` 只服务于 template，可以简化。Task 面板从此只放 template。

文案全部走 `internal/i18n`（桌面端是 `src/i18n`），新 key 统一用 `ticket.*` / `board.tickets.*` 前缀。旧的 `panel.todo.*` 要一并删除。

## 八、和 superagent 的对照

| superagent | 本设计 | 取舍 |
| --- | --- | --- |
| Ticket + Mandate | Ticket，`mandate: {basis:'manual'}` | 授权来源只有一种：人自己点了开始 |
| Assignment | Assignment | 同名、同一概念：只有换执行者才新建 |
| `orchestrator_report` | `ticket_report` | 取值收窄为 done / blocked；ready 与 draft 的区别由人在 review 时判断 |
| 主 session（router） | 人 | 不自动化调度 |
| Source / Trigger / Eval | 无 | 工作来源只有人 |
| Subscription（跟进消息直达 worker） | `personReplied` 事实 | 跟进就是人在 Assignment 会话里说话 |
| effects / Outbox | `report_id` 幂等 + init 对账 | 单进程、单用户，用不着持久化的副作用队列 |
| 一种状态一个写者 | `machine.ts` 是唯一写者 | 照搬 |
| 命令祈使句 / 事实过去式 | 同 | 照搬 |
| 结束后工具一律拒绝 | 解绑即注销工具 + 状态机兜底 | 照搬 |
| 面板只显示要人处理的事 | 徽标 = needs_you + review；Done 折叠 | 照搬 |

## 九、为团队能力留的口子

现在只有一个人用，但下面这些位置**现在就定好形状**，将来扩展时只是"多一个取值"，而不是"改一个形状"。判断原则是：凡是将来一定会变成多值的维度，现在就做成带 `kind` 的联合类型，哪怕眼下只有一个成员。

| 维度 | 现在 | 将来（团队） | 现在为此付出的代价 |
| --- | --- | --- | --- |
| 工作从哪来 | `origin: {kind:'manual'}` | `{kind:'source', source, thread, triggerId}`：GitHub issue、飞书话题、template 定时巡检产生的发现 | 一个字段 |
| 谁提的 | `requester: {kind:'person', id:'local'}` | 真实的用户 id；`{kind:'bot', …}` | 一个字段 |
| 凭什么做 | `mandate: {basis:'manual'}` | `addressed` / `followup` / `rule`，以及恢复执行时的重新校验（revalidation） | 一个字段 |
| 结果交到哪 | `delivery: {kind:'local'}` | `{kind:'channel', address}`，经 Outbox 回复到原对话 | 一个字段 |
| 谁在执行 | `executor: {kind:'session', …}` | 远端 worker、无人值守的 autopilot 会话 | 一层包装 |
| 谁做了什么 | `events[].actor` | 审计、多人协作的时间线 | 每个事件多一个字段 |
| 存在哪里 | `src/ticket/` 模块后面的 `~/.tudouni/tickets.json` | runtime 侧的 SQLite，或服务端 | 所有读写都经过一个模块 |
| 状态由谁推进 | `machine.ts` 纯函数 | 搬到服务端照样能用：纯函数，不依赖 UI | 不在别处写 `status` |
| 回报通道 | `ticket_bind` / `ticket_report`，runtime 不知道存储在哪 | 不变：服务端代替桌面端发 bind、收 report | 无 |
| ID | `tk-<time36>-<rand>`，不嵌入本机信息 | 全局唯一即可，不必迁移 | 无 |

**刻意不预留的**：权限、角色、多租户、准入表。这些东西的形状要等到真有团队场景才知道，现在定下来大概率是错的。上面这张表只覆盖"一定会存在、只是现在只有一个值"的维度。

和 template 的关系也在这里定方向：template 是"会产出工作的规则"，将来它的某次运行如果发现了问题，可以建一个 `origin: {kind:'task', taskId, runId}` 的 Ticket。这就是 superagent 里"Source 产生 Trigger，Trigger 变成 Ticket"的同构，而且不需要引入 Source 这个概念。

## 十、落地顺序与验证

| 批次 | 内容 | 验证 |
| --- | --- | --- |
| 1. runtime | `ticket_bind` 入站、metadata `ticket` 记录、`ticket_report` 工具的注册与注销、payload note、`ui(ticket_report)`、`init` 带绑定与 reports、`PROTOCOL = 18`、协议 spec 与 schema | 动了 `internal/protocol` 和 `internal/tools`，按 AGENT.md 跑全量 `make test`，再 `make build` 走真实二进制 |
| 2. 桌面端模型 | `src/ticket/`（model、machine、守卫）、`slices/tickets.ts`、Rust 侧 `tickets_read` / `tickets_write`、`ExitPayload.reason`、丢弃 todo 数据 | vitest：每条迁移和每条拒绝、事实在终态下 no-op、`needs_you` / `review` 下退出不迁移、恢复不迁移、按 `report_id` 去重、对账幂等、失效绑定被解绑、加载时丢弃 todo；`cargo test` 覆盖原子写入、schema 拒写、远程断线带 `reason` |
| 3. 桌面端 UI | `board` 联合类型重构、Ticket board、两个入口、徽标、删除 Task 里的 todo、"存为 Ticket" | `board` 互斥与 Esc 顺序的测试；session board 原有测试全部通过；`npm run version:check` |
| 4. 收尾 | 通知、旧 runtime 提示、断线提示、"未连接 → 继续" | 远程工作区手动验证：旧 runtime 不发 bind 并显示提示；断开 SSH 后进入 `needs_you`，继续后恢复原会话并补齐 report |

版本：

- `VERSION` 7.1.2 → **7.2.0**：新工具、新协议字段，属于次版本。
- 桌面端 6.3.0 → **7.0.0**：todo 被移除，旧数据升级后被丢弃，按不兼容处理（第十一节）。用 `npm run version:bump 7.0.0`。

## 十一、已定的取舍

1. **默认只预填 brief，同时提供"直接开跑"。** Ticket 默认有人在场；"直接开跑"是开始按钮的可选项，开 autopilot 并自动发出 brief（6.4）。它是走向无人值守的第一步，和 template 的定位有重叠，这一点接受。
2. **桌面端升 7.0.0。** 移除 todo，旧数据升级后丢弃、不迁移，按不兼容变更处理。
3. **`sendBack` 时原会话已关闭，恢复原会话**（`openSession(sessionId)`），并把打回意见作为一条用户消息发进去。原会话的上下文最完整；如果恢复失败（会话文件丢了、工作区不存在），才退回到开一个新 Assignment，把意见连同 brief 一起预填。会话太长的问题交给 runtime 现有的压缩机制处理。
4. **Assignment 只在执行者被收回或换掉时结束。** `end` 只有 `superseded` / `accepted` / `dropped` / `restore_failed`；回报、崩溃、断线只进 events，因为同一个 Assignment 之后还会继续。
5. **会话不在线时的解绑，靠打开时比对 `init` 带回的绑定。** 不一致就当场发 `ticket_bind null`（5.1），不只靠状态机兜底。
6. **崩溃和断线靠 Rust 侧的 `ExitPayload.reason` 区分**，不按工作区类型推断（6.5）。
7. **恢复会话不迁移状态。** `needs_you` 要等 `personReplied` 才回 `running`，断线导致的也一样（不变量 7）。
