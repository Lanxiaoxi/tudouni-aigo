# Ticket Worker 与 Notes：一张工单，多个会话，一份共识

状态：**已实现**（runtime protocol 22，`VERSION` 7.7.0；桌面端 8.0.0）。建立在 [ticket.md](ticket.md) 之上，只写增量和改动；术语（命令 / 事实、唯一写者、对账）沿用那份文档。ticket.md 第三节、第四节状态机表、6.1 实体中关于"执行者 = 一个会话"的描述已被本文取代，冲突时以本文为准。

与本文的出入：`start` 只接受 `open`，"重来"是独立命令 `restart`；`WorkerSession.title` 字段已有但桌面端暂未填写，会话行显示"会话 N"；会话退出的 `midTurn` 在 `slices/runtime.ts` 的 `runtime_exited` 处理里于转录被收尾前读取；`ticket_attachments_stage` 多一个可选 `brief` 参数用于暂存 `brief.md`；旧版守卫在记录级补了一道（`parseTicketFile` 遇到比本构建新的记录即只读）；笔记重发 bind 时重放该会话上次发送的 spec、只替换 notes，避免把编辑后的 brief 推进正在工作的会话。

## 一、问题

一个真实的用法：一张工单做四天，每天一个会话。

| 天 | 会话 | 产出 |
| --- | --- | --- |
| 1 | 调研代码 | 报告、数据、人对需求的判断（insight） |
| 2 | 讨论结构、出设计文档 | 设计决策 |
| 3 | 开发 | 进度、遇到的问题、换的思路 |
| 4 | 继续开发 | — |

现在的实现撑不住它：

1. **第 2～4 天的会话不在工单上。** `start` 只接受 `open` / `needs_you`，`running` / `review` 下没有"在这张单上再开一个会话"的命令，只能开普通会话。这些会话没有绑定，拿不到 brief、附件，没有 `ticket_report`，工单也不知道它们存在。
2. **会话之间有主从。** 一张工单同时只有一个执行者，而执行者就是一个会话（`executor: {kind:'session'}`）。换会话等于换执行者：旧的被记成 `superseded`，打开时被 `bindingIsStale` 解绑，它报的 report 被当成外来的忽略。可在这个用法里，四个会话是同一件事的四个阶段，没有谁替换谁。
3. **上下文不跨会话。** 能跨会话的只有 brief、附件、report 和 turn_ends。brief 是开工前写的，report 只说结果。第 1 天的 insight、第 2 天的决策、第 3 天的新思路都没有地方放，人只能每天重复一遍。`AGENTS.md`、工作区记忆、单独的进度文档都不合适：前两者跨任务，后者的生命周期不跟着工单走。

## 二、三层结构

这套设计来自 superagent。它的结构是 `Ticket → Assignment → worker session`，派活和干活都由 agent 做。tudouni 把这两个角色都交给了人，于是被压成了"Ticket → 会话"两层，问题 1、2 都出在这里。

```
superagent:  Source → Eval → [router] → Ticket → Assignment(worker) → session × N
tudouni:     人     → 人   → [人]     → Ticket → Assignment(worker) → session × N
                    ╰──── ticket 之上 ────╯          ╰──── ticket 之下 ────╯
```

人顶替的是两个角色，处理方式不同：

- **ticket 之上：派活**（做哪张、何时开始）。不建层，扩展口已经在字段里：`origin` / `requester` / `mandate`，以及 inbox 和 Ticket Sources。
- **ticket 之下：干活**（分几个阶段、开几个会话、记下什么、打回给谁）。**这是 worker 层，要还原出来。** Assignment 本来就是它，只是实现时把执行者等同于一个会话。现在把它改成：一个 Assignment 是一个 worker，一个 worker 下面挂多个会话。

| 层 | 是什么 | 生命周期 | 放什么 |
| --- | --- | --- | --- |
| Ticket | 一件要做完的工作 | 比任何执行者都长 | 状态机、brief、附件、**notes**、events |
| Assignment（worker） | 谁在做这件事 | 从 start 到 accept / drop；**只有执行者换了才新建**（不变） | `executor.kind`、会话列表 |
| Session | worker 的一段对话 | 加入到移出 | 会话 id、在哪跑、标题 |

**一样东西放哪层，看换一个执行者之后它还要不要留着。** 要留的放 Ticket，不要的放 worker。notes 是人对这件工作的判断和决策，换人也要跟过去，所以在 Ticket；会话列表是这个执行者自己的干法，所以在 worker。

**worker 层现在只有形状，没有逻辑。** 只有一种 worker：`kind: 'person'`，人在驱动这些会话。它的命令（新开会话、移出会话、选择打回到哪个会话）现在由人在卡片上发出；将来 `kind: 'agent'` 的 worker（编排会话、autopilot）要能发出**同一组命令**，这是这一层不是虚设的检验标准。把多个会话的事实汇总成一个信号的规则（见 3.4）现在写在桌面端的事实翻译里，注释标明它属于 worker 层，出现第二种 worker 时再搬。

## 三、Worker 与会话

### 3.1 实体

```ts
// src/ticket/model.ts（schema 2）
interface Assignment {
  id: string;
  executor: {
    kind: 'person';                   // 谁在驱动；将来 'agent' | 'member'
    sessions: WorkerSession[];        // 只增；按加入时间排序
  };
  startedAtMs: number;
  endedAtMs: number | null;
  end: 'accepted' | 'dropped' | 'superseded' | null;
}

interface WorkerSession {
  sessionKey: string;                 // 同 schema 1：只在一次 app 运行内有意义
  sessionId: string;                  // init 后回填，之前为 ''
  remoteWorkspaceId: string | null;   // 同 schema 1：从实际打开的 bucket 上读
  workspace?: string;
  title?: string;                     // 会话标题，桌面端拿得到时填，用于列表显示
  joinedAtMs: number;
  lastActiveAtMs: number;             // 见 3.3"最近活动"
  removedAtMs: number | null;         // null = 在场
  removed?: 'restart' | 'person' | 'restore_failed' | 'unreachable';
}
```

- **在场的会话**（`removedAtMs === null`）都是平等的：都绑定这张工单，都看得到 brief、附件和 notes，都有 `ticket_report` 和 `ticket_note`。
- **移出的会话**留在列表里，可以打开回看，但已经解绑，它发来的事实不再作数。
- `Assignment.end` 从四种变成三种。`superseded` 和 `restore_failed` 原来表示"换了一个会话"，现在换会话是 worker 内部的事，变成会话层面的 `removed`。`superseded` 保留给"换了一个 worker"，现在没有命令会产生它（迁移出来的旧记录除外），留给将来的转交。
- 不变量"一张 Ticket 同时最多一个进行中的 Assignment"不变。

### 3.2 命令

| 命令 | 从 | 到 | 做什么 |
| --- | --- | --- | --- |
| `start` | `open` | `running` | 新建 Assignment，带第一个会话；预填 brief，或"直接开跑"。**和现在一样** |
| `newSession` | `running` / `needs_you` / `review` | `running` | 往当前 worker 加一个会话并绑定。默认不预填，可选"带上 brief" |
| `restart` | `needs_you` | `running` | `newSession` 加预填 brief，同时把其他在场会话全部移出（`removed: 'restart'`）。这就是现在的"重来"，保留"跑偏的旧会话不再作数"这层保护 |
| `removeSession` | 非终态 | 不变 | 把一个在场会话移出（`removed: 'person'`）并解绑。**移出最后一个在场会话被拒**（`last_session`）：`running` 下没人在场就是一张假的 Running，要么 `restart`，要么 `drop` |
| `sendBack` | `review` | `running` | 意见作为用户消息发给**一个**在场会话：默认最近活动的那个，打回框里可以改选 |
| `accept` / `drop` | 同现在 | 同现在 | 结束 Assignment，**所有**在场会话解绑 |
| `reopen` | 同现在 | `open` | 同现在。下一次 `start` 新建一个 Assignment；notes 留在 Ticket 上，新 worker 照样看得到 |

`newSession` 从 `review` 回到 `running` 是刻意的：第 2 天报了 done 进 `review`，人看过设计文档，第 3 天在这张单上开会话开发。这时工单不该一直停在"待验收"。人开了新会话，本身就是在说"接着干"。

### 3.3 事实

| 事实（原名） | 规则 |
| --- | --- |
| `sessionStarted`（`assignmentStarted`） | 给 worker 里对应的会话回填 `sessionId` / 新的 `sessionKey` |
| `reported` | **任何在场会话**报的都采纳，`running` 下 done → `review`、blocked → `needs_you`，`lastReport` 更新。移出的会话报的记事件、不迁移、不更新 `lastReport` |
| `turnEnded` | 任何在场会话，只在 `running` 时 → `review`。**并行时的误伤接受**：一个会话还在开发，人回到另一个会话问了一句、它答完没汇报，工单会进 `review`，代价是多看一眼卡片 |
| `sessionExited`（`assignmentExited`） | 见 3.4 |
| `sessionRestoreFailed`（`assignmentRestoreFailed`） | 打回时目标会话恢复不了：它被移出（`removed: 'restore_failed'`），worker 里加一个新会话，意见连同 brief 预填。状态不变 |
| `personReplied` | 人在任何在场会话里发消息，`needs_you` → `running` |

"**最近活动**"（`lastActiveAtMs`）在会话加入、`sessionStarted`、人发消息、`reported`、`turnEnded` 时更新。它决定卡片上"打开"默认指向哪个会话，以及打回默认发给谁。

身份规则沿用 `owns`：有 `sessionId` 就只认它，没有时才认 `sessionKey`。新事件用新名字；旧事件只是历史、不回放，类型联合里保留旧名字以便读取。

### 3.4 worker 层的汇总：会话退出

多个会话时，"一个会话挂了"不再等于"执行者没了"。规则：

- 人请求的退出（关窗口、关会话）：只记事件。
- 未经请求的退出（`crashed` / `disconnected`）：**只有这个会话退出时正在跑一轮**，且工单是 `running`，才 → `needs_you`。闲着的旧会话断线只记事件。"正在跑一轮"由桌面端在退出那一刻读会话状态得出，作为字段 `midTurn` 写进事实。
- 握手没到（`unreachable`）：这个会话被移出（`removed: 'unreachable'`）。如果 worker 里已经没有一个拿到过 `sessionId` 的在场会话（典型是 `start` 的第一个会话就没起来），工单 → `needs_you`，否则状态不变。

这三条是 worker 层的规则，现在写在 `ticketLanding.ts` 的事实翻译里，`machine.ts` 只看翻译后的事实。`midTurn` 读了会话状态，和 ticket.md 不变量 1"状态不从会话展示推断"有张力；接受它的理由是：它只**收窄**了一条已有的迁移，不制造新迁移。

### 3.5 绑定与对账

- `bindingIsStale(ticket, sessionId)` 改为：工单不存在、不在 `running` / `needs_you` / `review`、或者这个会话不是当前 Assignment 的**在场**会话，才算失效。旧会话打开时不再被踢出工单。
- 对账（`init.ticket.reports` / `turn_ends` / `note_ops`）对每个在场会话照旧做，按 id 去重，跨会话的事实按 `at_ms` 合并后交给 `machine.ts`。
- runtime **一行都不用改**：多个会话同时绑定同一张工单，在 runtime 看来就是各自的 metadata 里各有一个 `ticket` 记录。它不需要知道自己属于哪个 worker。

### 3.6 brief 不在新会话的历史里

`newSession` 默认不预填，可 `TicketText` 截断 brief 时写的是"完整内容在会话的第一条消息里"，对这些会话不成立。处理：brief 超过 `TicketTailBriefRunes` 时，桌面端在**每次**开会话都把完整 brief 暂存成附件 `brief.md`，和其他附件同一目录、同一份清单。截断提示改成"完整内容在会话第一条消息里；不在的话读附件 `brief.md`"。`brief.md` 是保留名，人挂的附件不能叫这个（添加附件时拦截）。不涉及协议。

### 3.7 UI

- 卡片新增"会话"区：按加入时间列出 worker 的所有会话，每行是标题（没有时用"会话 N"）、加入时间、在场 / 已移出（及原因），点击打开。会话文件已经不存在（`canResumeAssignment` 的会话级版本判断不了）时标为"会话已不存在"，不可点。
- 在场会话每行有"移出"（两次按下确认）；只剩一个时不显示。
- 卡片主按钮："打开 / 继续"指向最近活动的在场会话；`running` / `needs_you` / `review` 多一个"新开会话"（带"带上 brief"选项）；`needs_you` 的"重来"保留，文案写明会移出现有会话。
- 打回框多一个目标会话选择，默认最近活动的那个。只有一个在场会话时不显示。
- 移出的会话打开后，会话顶部提示"这个会话已不在工单上：在这里继续不会推进工单，也看不到笔记"。
- 拖拽不加新落点：`review → Running` 仍然是 `sendBack`。
- "第 N 次执行"改成"N 个会话"，数在场的。

## 四、Ticket Notes

### 4.1 条目

```ts
interface TicketNote {
  id: string;            // "nt-<time36>-<rand>"
  text: string;          // 自由文本，Markdown；不分类
  author: 'person' | 'agent';
  sessionId?: string;    // author=agent 时：哪个会话写的
  createdAtMs: number;
  updatedAtMs: number;
}

interface Ticket {
  // ……
  notes: TicketNote[];   // 新字段；迁移时补 []
}
```

就这么多。notes 对工单就像 `AGENTS.md` 对工作区：没有标题、类别、优先级、状态，要分段就在 text 里写 Markdown 标题。

**明确不做的：** 不分类；不审核（直接生效、标明作者，人随时可改可删，影响范围只有这一张单）；agent 不主动写，只在人要求时写；没有交接时的自动总结；不和工作区记忆联动。

### 4.2 写者

**正本在 Ticket 上，唯一写者仍是 `machine.ts`。** runtime 只持副本，替模型转发写操作。

| 来源 | 入口 | 进 `machine.ts` 的形式 |
| --- | --- | --- |
| 人 | 卡片上的 Notes 区：新增、编辑、删除 | 命令 `note { op, noteId?, text? }`，actor 是 person |
| agent | 工具 `ticket_note` | 事实 `noted { opId, op, noteId, text?, sessionId }` |

- 人可以改、删任何一条。
- **agent 只能改、删 agent 写的条目。** 人写的 insight 是最不该被悄悄改写的东西；agent 想改，应该在回复里提出来。
- 任何状态都能编辑（含 `done` / `dropped`）。
- `noted` 接受当前 Assignment 的**任何在场会话**，移出的会话发来的记事件、不落 notes。
- 改 / 删一个已经不存在的 id：记事件，notes 不变。
- 事件只记 `{ noteId, op }`，不记正文：events 按条数封顶，不按大小。

### 4.3 runtime 侧（protocol 22）

**入站：`ticket_bind.ticket.notes`。** 可选数组，缺省或 `null` 表示没有，每条 `{id, text, author, updated_at_ms}`。任何一条不合格，整条绑定被拒（`notice` code `ticket`），和附件同一个规矩。

- notes 整体**替换** metadata 里的副本，正本说了算。`state.BindTicket` 把"notes 变了"算作记录变更，会 checkpoint；没变就不写盘。
- 正本的 notes 一变，桌面端给**所有活着的在场会话**重发 bind。其中包括 agent 自己的写操作被收下之后：多数时候副本已经一样、不会写盘，但并行写入时这一步保证最终一致。

**工具：`ticket_note`。** 绑定时注册、解绑时注销，和 `ticket_report` 一起由 `applyTicketTool` 对账。子 agent 不给（`internal/subagent/spawn.go` 的排除列表）。

```
ticket_note(
  op:   "add" | "update" | "remove",
  id:   string?,   // update / remove 必填；只能是 author=agent 的条目
  text: string?    // add / update 必填
)
```

- 工具描述和尾部说明都写明：**只在用户要求记录时调用**。
- runtime 先改自己的副本（本轮尾部马上可见），生成 `op_id`，追加到 metadata 的 `ticket.note_ops`，checkpoint，再发 `ui(ticket_note)`：先落盘再发，和 report 一样。`add` 的 note id 由 runtime 生成，格式同桌面端。
- 拒绝时的错误要能指导下一步：改了人写的条目（"这条是用户写的，你不能改，在回复里向用户提出"）、超出上限（"notes 已满，先合并或删掉你写过的旧条目"）、id 不存在。

**出站：`ui(ticket_note)`。**

```json
{"v":1,"t":"ui","kind":"ticket_note","ticket_id":"tk-…","op_id":"…","session_id":"…",
 "op":"add","note_id":"nt-…","text":"…","at_ms":0}
```

桌面端转成 `noted` 交给 `machine.ts`，按 `op_id` 去重。

**对账。** `init.ticket` 多两个键，都永远是数组：`notes`（副本）和 `note_ops`（最近 50 条，字段同 `ui(ticket_note)`，去掉 `ticket_id` / `session_id` / `kind`）。打开会话时，`note_ops` 和 `reports`、`turn_ends` 按 `at_ms` 合并后交给 `machine.ts`，然后用正本重发 bind。`notes` 只用于调试，**不用来**反向覆盖正本。

### 4.4 进 payload 尾部

`TicketText` 在 brief、附件之后加一段，按 `createdAtMs` 排序，每条带 id 和作者：

```
## 工单笔记（跨会话共享；这张工单上的每个会话都能看到）

- [nt-lx2k9a · 用户 · 05-12] 鉴权这块不要动中间件，老系统有隐式依赖……
- [nt-lx4b1c · agent · 05-13] 设计文档：docs/design/foo.md；决定用方案 B，原因是……

用户写的条目代表用户的判断，优先级高于你自己的推断。用户要求你记录什么时，调用 ticket_note；
其余时候不要写。
```

**全部放进去，不截断。** 被截掉的那条可能正是关键的那条。成本靠写入上限控制：

| 上限 | 值 | 理由 |
| --- | --- | --- |
| 单条 | 4000 字 | 一段 insight 或一节决策的量 |
| 条数 | 100 | 尾部每条有固定开销 |
| 总字数 | 12000 字 | 每轮约 3～4k token，和一份中等的 `AGENTS.md` 相当 |

超限的写操作被拒（人：输入框旁提示；agent：工具报错并说明怎么腾地方）。三个数放在 `internal/state/ticket.go`，桌面端镜像，照 ticket.md 6.6 加一条直接读 Go 源码比对的测试。数值用一段时间再调。

### 4.5 UI

- 卡片展开区的 Notes 区：按时间列出，agent 写的标出来源会话（可点开），每条可编辑、可删除（两次按下确认），底部"添加笔记"输入框，`Ctrl+Enter` 提交，字数上限在输入时提示。
- 卡片折叠时只显示条目数。
- 文案走 `src/i18n`，前缀 `ticket.notes.*` / `ticket.sessions.*`；runtime 的工具报错走 `internal/i18n` 的 `ticket.note.*`。

## 五、迁移：schema 1 → 2

- 一张工单的旧 Assignment 按 `accepted` / `dropped` 切段：每一段合并成一个 worker（新 Assignment），段内每个旧 Assignment 变成一个 `WorkerSession`。`superseded` / `restore_failed` 结束的变成已移出的会话（`removed` 分别记 `restart` / `restore_failed`），段内最后一个、`end === null` 的变成在场会话。`lastActiveAtMs` 取旧 `startedAtMs`。
- `assignmentStarted` / `assignmentExited` / `assignmentRestoreFailed` 这些旧事件原样保留。
- 补 `notes: []`。
- 迁移前把原文件备份成 `tickets.json.v1.bak`，迁移在内存里完成，写回走现有的原子写。
- **旧版桌面端读不了 schema 2。** 按 ticket.md 6.3，旧版读到更新的 schema 会拒绝写回，所以磁盘上的数据不会被写坏，但装回旧版后这批工单看不到。实现时要在 `tickets_data.rs` / `store.ts` 里核实这条守卫确实覆盖文件级和记录级（`isValidTicket` 现在对 `schema !== 1` 返回 false，旧版会在内存里滤掉这些记录，要确认之后不会把"滤掉后的列表"写回去）。
- 桌面端因此升**主版本**。

## 六、和现有行为的对照

**照原样保留：** 开始 / 直接开跑、验收、放弃、重新打开、编辑、附件、inbox、Sources、拖拽、徽标、通知；report 推动状态；一轮答完没汇报进 `review`；结束时解绑（活着的当场解，不在线的打开时比对后解）；远程工作区；旧 runtime 提示。runtime 的绑定、回报、对账代码不变。

**语义变化（已确认）：**

1. 普通的"新开会话"后，旧会话仍然作数；只有"重来"会移出旧会话，保留"跑偏的旧会话不再作数"的保护。
2. 打回和"打开 / 继续"要选一个会话，默认最近活动的在场会话。
3. 会话崩溃只在它正在跑一轮时把 `running` 推到 `needs_you`；闲着的会话断线只记事件。

## 七、协议与版本

- `PROTOCOL` 21 → **22**，纯加法：`ticket_bind.ticket.notes`、`ui(ticket_note)`、`init.ticket.notes` / `note_ops`。同步 `docs/spec/protocol.md` 3.16 与 `protocol/schema/*.schema.json`。
- protocol < 22 的 runtime 会忽略 `notes`，没有 `ticket_note`。桌面端据 `init.protocol >= 22` 才发 notes；低于 22 时 Notes 区照常可编辑，会话行上标"runtime 过旧，看不到笔记"。
- 多会话、worker、`brief.md` 都是桌面端的事，不涉及协议。
- `VERSION` 次版本 +1（新工具、新协议字段）；桌面端主版本 +1（schema 2 不兼容），用 `npm run version:bump`。

## 八、落地顺序与验证

| 批次 | 内容 | 验证 |
| --- | --- | --- |
| 0. 基线 | 在改模型之前，为第六节"照原样保留"的每一条补测试 | vitest 全绿；这批测试在之后各批**不改一行**仍须通过 |
| 1. worker 模型与迁移 | schema 2 实体、`machine.ts` 命令与事实、3.4 的汇总规则、`bindingIsStale`、迁移与备份、旧版守卫核实 | vitest：在场会话的 report / turnEnded / personReplied 都作数；移出的不作数；`restart` 移出其他会话；移出最后一个被拒；只有 `midTurn` 的崩溃迁移；`unreachable` 两种情况；迁移覆盖切段、已移出、在场、备份；`cargo test` 覆盖 schema 拒写 |
| 2. 会话 UI | 会话区、新开会话、移出、打回选目标、移出会话的提示、`brief.md` 与保留名 | vitest + 组件测试；`npm run version:check` |
| 3. runtime notes | metadata `notes` / `note_ops`、bind 校验与替换、`ticket_note` 与作者限制、上限、`TicketText`、`ui(ticket_note)`、`init` 字段、`PROTOCOL = 22`、spec 与 schema | Go：先 checkpoint 再发；改人写条目被拒；超限被拒且不落盘；相同 notes 重复 bind 不写盘；`/resume` 后副本和工具都在；子 agent 没有该工具。全量 `make test`，再 `make build` |
| 4. 桌面端 notes | `note` 命令 / `noted` 事实、`op_id` 去重、混合对账、正本变化后向所有在场会话重发 bind、Notes UI、上限镜像测试 | vitest：只接受在场会话的 `noted`；对已删 id 的操作不改 notes；两个会话并行写后各自副本与正本一致 |
| 5. 端到端 | 按第一节四天流程手动走一遍，含一次远程工作区和一次 app 重启 | 第 4 天的会话不重复说明就能接上前三天的 insight 和进度；四个会话都在卡片上，都能打开 |

## 九、已定的取舍

1. **三层：Ticket → worker（Assignment）→ 会话。** 人顶替的"干活"角色还原成 worker 层；"派活"角色只靠字段预留，不建层。
2. **worker 层现在只有形状。** 只有 `kind: 'person'`；它的命令将来要能由 agent worker 原样发出。汇总规则暂放在桌面端事实翻译里。
3. **在场会话平等，并行误伤接受。** 不为并行加保护；将来要修，worker 层知道自己有没有别的会话在跑，是天然的位置。
4. **"重来"保留，语义是新开会话并移出其余会话。**
5. **notes 在 Ticket 上，不在 worker 上。** 换执行者也要跟过去。
6. **notes 不分类、不审核、agent 只在人要求时写；agent 不能改人写的条目。**
7. **notes 全部进尾部，靠写入上限控制成本。**
8. **正本在桌面端，runtime 持副本，最终一致。** 沿用"runtime 永远不懂 Ticket"。
9. **brief 超长时暂存成附件 `brief.md`**，让不预填的会话也能读到完整 brief。
10. **schema 2 是不兼容迁移，桌面端升主版本，迁移前自动备份。**
