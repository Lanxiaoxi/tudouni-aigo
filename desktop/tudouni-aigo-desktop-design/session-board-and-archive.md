# 桌面端：会话状态板 · 归档 · 库搜索

**范围**：三件相关的改动，落在"桌面端怎么看会话、怎么管会话"这一个主题上。
**本文的性质**：方案，不是现状描述。现状在 `desktop-app.md`。

**路径约定**：桌面端文件相对 `desktop/tudouni-aigo-desktop/`；Go 文件相对仓库根。

---

## 1. 一句话

- **会话状态板**是一个**主区视图**（会话列的第 7 个占用者），不是浮层面板：它取代转录、收起输入框、右栏随之收起；点一张卡 = 聚焦那个会话的 chat。
- **归档**是**会话的一个事实**（会话文件的 `meta` 记录里一个键），不是窗口偏好：运行时在 `session_list` **截断之前**过滤，归档的会话因此真正让开那 50 个名额。
- **库搜索**扩展 `/resume` 面板，只搜 `sessions.items` 已有的行字段，**不改协议**。

三者各回答一个问题，不互相重叠：

| 表面 | 回答 | 形态 |
| --- | --- | --- |
| **会话状态板**（新） | 现在在发生什么 | 主区视图，窗口级 |
| **左栏**（不动） | 我在哪、怎么回到某个对话 | 保持现状，只多一个入口 |
| **库 = `/resume` + 搜索** | 翻旧账 | 既有面板，加两样东西 |

---

## 2. 已定决策

| # | 决策 | 依据 |
| --- | --- | --- |
| 1 | **板子不接收人工改状态**（无拖拽） | 状态是从 `entries` / `pendingModals` / `runtimeExit` / `unseen` 投影出来的，协议里**没有任何一条消息能改变它**。能拖而拖了没反应，比不能拖更糟 |
| 2 | **板子做成主区视图**，不是浮层面板 | 面板是 Radix 模态：开面板时 `body` 的 `pointer-events: none` 会锁死左栏（`railBlocked`），审批到达时 `enqueueModal` 会把面板顶掉，点卡片时 `focusSession` 会 `panel: null`。三条都恰好打在"看板找人"这个用途上。视图形态三条全避开 |
| 3 | **板子打开时右栏收起——以派生实现，不写偏好** | `sidebarVisible` 是持久化的用户偏好。写它就是改用户的设置，关板后栏不回来、且跨重启留存 |
| 4 | **板子不管切换工作区**；工作区只在左栏 | 换工作区是换子进程，而板子讲的是"当前工作区里的会话"。跨工作区的"有事"由左栏工作区行的角标回答（`selectWorkspaceAttention`） |
| 5 | **归档是会话事实**（`meta` 记录里的键） | 它得跟着会话走、且 TUI/CLI 与桌面端看法一致；放 localStorage 会让"归档的不占名额"拿不到（见 §4.2） |
| 6 | **正在跑的会话不能归档**；门禁在桌面端 | 见 §4.4 |
| 7 | **归档只受桌面端管理**；TUI/CLI 不获得归档能力，因此 `session_list` **默认不过滤** | 见 §4.3 |
| 8 | **库搜索扩展 `/resume`**，字段级 | `/resume` 就是"找一段旧对话"这个问题的现成家；板子才是真正的新入口 |

---

## 3. 会话状态板

### 3.1 它是会话列的第 7 个占用者

`conversationView.ts` 里写着：会话列有六个**互斥**占用者，谁赢是一个**优先级顺序**，不是一组独立条件。板子是第 7 个：

```
1. startup-problem      窗口没有运行时
2. session-problem      这一个会话的子进程起不来
3. terminal             挂着的终端（唯一出路在它自己身上）
4. board                ← 新增，位置见下
5. welcome              没有会话，或会话还没说过话
6. booting              会话就绪中
7. stream               转录
```

**放在 `terminal` 之下、`welcome` 之上**，理由与 terminal 那一段完全同构：

- **必须在 `welcome` 之上**：板子的用途就是"三四个会话在跑，打开看一眼"，而那正是"当前会话刚说完一句话"或"当前会话尚未说话"的状态。放在 welcome 之下，板子会在最常见的情况下被首屏盖住。
- **必须在 `terminal` 之下**：`TerminalView` 是离开一个终端**唯一**的出路。一个能盖住它的占用者，就是一条进得去出不来的路——这正是 `conversationView.ts` 头注释里记的那个缺陷（终端被首屏盖住，输入框没了、终端也没显示）。
- **因此板子必须自带退出，而且退出要看得见。** 见 §3.3。

`showsComposer(view)` 跟着改：板子不画输入框。理由和终端那一条一样——输入框是"往这段对话里说话"，而板子上没有"这段对话"：`showsComposer(view)` 返回 `view !== 'terminal' && view !== 'board'`。

### 3.2 状态与派生

**一个窗口级布尔，不进会话桶：**

```ts
boardOpen: boolean;   // AppStore，默认 false，不持久化
```

它是**窗口事实**（板子讲的是这个工作区，不归属于某一个会话），所以不进 `SessionRuntime`。也不持久化：板子是一个"主动去看"的瞬间状态，跨重启记住它没有意义，还会让下次启动落在没有转录的屏幕上。

**右栏收起是派生，不是写偏好。** `App.tsx` 现在写的是：

```ts
const showSidebar = sidebarVisible && !hiddenByCss;
```

改成三段：

```ts
const showSidebar = sidebarVisible && !hiddenByCss && !boardOpen;
```

**这是它和"存一个值再还原"的本质区别**：没有任何状态需要恢复——用户从来没被改写偏好，关板后栏回到他原本的设置。左栏的 `showLeftbar` 保持不动（板子开着时左栏仍然可用，见 §3.4）。

**`CollapsedSummary` 一并抑制。** 摘要行陈述的是"当前会话的 phase / autopilot / 用量"，而板子开着时**屏幕上没有会话**——它会指着一个没人看的会话说话。所以 `showSummary = !showSidebar && !boardOpen`：右栏一收起（板子开着时它必然收起）摘要行就**不**顶上来，板子关回去、栏恢复后摘要行也不会自己冒出来——两条"两样东西同时消失/出现"的路都被同一个合取条件堵掉。

### 3.3 入口与出口

**入口**（一条路，和 Files / Terminal 同构）：左栏 footer 现在有三行 `lb-foot-btn`（Files / Terminal / Settings），板子加为**第四行**。可用条件**不能照抄 Files/Terminal 的 `hasSession`**——那两个 gate 在"当前会话就绪"（`rt.ready`），而板子讲的是全工作区：当前会话启动失败时，板子更该能开。gate 改成"**这个工作区有活着的子进程**"。

**出口有两条，语义不同，两条都要有：**

| 动作 | 结果 |
| --- | --- |
| **Esc / 关闭按钮** | 回到板子底下原本的东西（原来的 chat，或原来挂着的终端） |
| **点一张卡** | 聚焦那个会话的 chat，板子关闭（`focusSession(key)` + `boardOpen: false`） |

第二条顺带清掉那张卡的 `unseen`——这正是"跑完了，还没看"的自然结局。

### 3.4 惰性规则：看得见的禁用，不是按了没反应

板子开着时，有一条键会**静默失效**：`Ctrl+B`。`toggleSidebar` 会把 `sidebarVisible` 翻成 true，而派生条件里 `!boardOpen` 仍然赢——**界面毫无变化，但用户的偏好已经被改了**，关板后栏的状态和他按之前不一致。这就是"按了不会有任何事发生的控件"，而这份代码对它的态度写在 `railBlocked` 的注释里。

所以板子开着时：

| 动作 | 板子开着时 | 理由 |
| --- | --- | --- |
| 切工作区 / 切会话（左栏） | ✅ 允许 | 不发消息，不影响任何 pending |
| 别的会话的审批 / 提问 | ✅ 停在卡上（`selectModalVisible`） | 板子不是模态，**审批不盖上来**：请求在队列里保活但**不渲染**，Needs you 列的卡片带着"等你回答——点我回复"的提示。它曾经直接盖到板子上，把"三四个会话谁在等我"的整屏盖掉——正是板子存在的那个时刻。点卡片（或 Esc 关板）即浮出提示，答完板子状态不受影响。压住的判据是**视图**（`conversationView`）而不是 `boardOpen` 这个旗子：终端或启动失败盖过板子时，板子不在屏幕上、nudge 无处安放，此时压住提醒就是死锁，所以照常渲染 |
| **`Ctrl+B` / 右栏的收起控件** | ❌ inert **且可见地 inert** | 见上。复用左栏那套 `disabled` + 视觉弱化 |
| 新建 / 关闭会话 | ❌ 禁止 | 与阻塞模态期间同一条规矩 |

`Ctrl+B` 的处理落在 `useGlobalKeys` 里，模式与 `s.panel !== null` 的那些分支一致：板子开着时 `return`，但**不 preventDefault 之外还改状态**——并且按钮要 disabled。

### 3.5 Esc 链

`useGlobalKeys` 现在链是：**模态 > 面板 > 中断回合**。板子插在**面板之后、中断之前**：

```
if (selectModalVisible(s)) return;         // 可见的模态自己处理
if (s.panel !== null) { close; return; }   // 面板
if (s.boardOpen) { close board; return; }  // ← 新增
if (phase === 'running') interrupt;        // 回合
```

不能排在模态之前（会抢掉模态的 Esc），也不能排在中断之后（`Esc` 在回合运行时会被吃成中断，板子关不掉）。

判据是 **`selectModalVisible` 而不是 `s.modal !== null`**，配合 §3.4 的"审批停在卡上"：请求被板子压住（不渲染）时，屏幕上没有一个可以按 Esc 面对的提示，把它当模态会让板子自己的出口被一个看不见的提示吃掉——Esc 关板，关板即浮出提示，fail-closed 的回答路径一条不少。`Ctrl+K/B/S/T/`…` 与 `Ctrl+1..9` 的阻塞段同样是这个判据：板开时左栏可用（§3.4），这些键就也要可用——它们没有一个会替压住的请求作答。

### 3.6 列与卡片

**列**：不要把 5 个 `RowStatus` 铺成 5 列。板上真正有内容的通常只有 2～4 张卡（见 §3.7），5 列会有 3 列空着。按"谁在等"归并成 3～4 列，与角标的语义对齐（`selectWorkspaceAttention` 已经认定 `asking` / `broken` / `unseen` 才是"要你看一眼"）：

| 列 | 含 | 点 |
| --- | --- | --- |
| **Needs you** | `asking` + `broken` | 🟡 / 🔴 |
| **Working** | `running` | 🟢 |
| **Finished** | `unseen` | 🔵 |
| **Idle** | 其余 | ⚪（或不画这一列） |

**列内按创建时间排，不按状态二次排序。** 左栏的决策 13（不重排）在这里的对应物是：板子列与列之间允许"动"（那正是它的价值），但**列内一张卡不再因为状态微变而换位**——否则它会在一列内部继续跳。

**卡片内容**（全部来自运行时，前端一个都不自己数）：

- 状态点 `SessionDot` + phase 文案（`adapt.ts` 的 `Phase`）
- `preview`（运行时算好的首条用户消息）
- `messages` / `steps` / `todos`（活会话用桶里的；已保存的用 `sessions.items`）
- 模型 / provider（活会话）
- `init` 到达前**没有 id**，如实写 `lb.sessionPending`（"starting…"），不发明一个

### 3.7 板子上真正有什么：只有活会话

这是板子最容易被误解的一点：**没有进程就没有状态。**

左栏的已保存列表来自 `sessions.items`（运行时读会话文件，上限 50），而 `SessionRuntime` 桶只有 attach 过的才有。一个只有文件、没有子进程的会话连 `entries` 都读不出来，`selectRowStatus` 对它是 `idle`。所以：

> 板上"有内容"的，只有**已打开、有子进程**的会话——通常 2～4 张。其余几十个已保存会话，要么不画，要么全挤在 Idle 列里。

这不是缺陷，是事实（`SessionDot` 的规矩 4）。但它决定了板子**不能**当成"工作区全貌"来设计——那是库（`/resume`）的事。

### 3.8 复用，不新造

板子**零新增状态判定**：直接用 `selectRowStatus(s, key)`、`SessionDot`，连同后者写下的 4 条规矩——颜色从不单独承担含义（每个点带 `aria-label` / `title`）、只对持续状态呼吸（`running` / `asking`）、空闲不画点、没有进程就没有状态。

---

## 4. 归档

### 4.1 它住在哪：会话文件的 `meta` 记录

`archived` 是 `session.Metadata` 里的一个布尔键，与 `goal` / `model_selection` / `todos` 并列。理由：

- `SessionStore.Save` 已经会为变化过的 metadata **追加一条新的 `meta` 记录**（`RecordMeta`），读的时候取最后一条。加一个键不需要新机制。
- `LoadSummary` 已经解析 metadata，所以 `SessionSummaries` **不用为归档多读一遍文件**。
- 事实跟着会话走：换一台机器、换一个前端，归档状态一致。

### 4.2 过滤必须在截断之前

`SessionSummaries`（`internal/runtime/composition.go`）现在做的事是：**读完所有文件 → 排序 → 按 `SessionListLimit = 50` 截断**。

所以过滤归档**必须发生在截断之前**。放前端做的话，你拿到的永远是"最新的 50 条里去掉归档的那些"——比截断点更旧的非归档会话直接消失。归档越多，错得越明显。**这正是"归档不占 50 个名额"这个诉求的落点**，也是决策 5 选"事实"而不是"偏好"的原因：运行时不知道归档，就做不到。

改动：`SessionSummaries(store, limit, includeArchived)` —— 先按 `archived` 过滤，再排序、截断；每行**追加**一个 `archived` 布尔。

### 4.3 协议增量（**默认不过滤**，这是决策 7 的落点）

`session_list` 加一个**可选** `filter`，缺省 = **含归档**：

```
"filter": "active" | "all"      // 缺省 = "all"
```

**缺省必须是 `all`。** 归档只受桌面端管理（决策 7），TUI / CLI 没有解除归档的手段——如果默认过滤，它们会看到一份少了会话、却无从找回的列表。所以：

- 现有客户端（TUI / CLI）发裸 `session_list`，**行为一字不变**；
- 桌面端**显式**发 `filter: "active"`，拿过滤后的列表。

新增一条入站消息：

```
session_archive { session_id, archived: bool }
```

**绝对状态**（不是动作），与 `set_autopilot` / `set_thinking` 同一条规矩：重发幂等，前端不必先知道现在是什么。运行时处理完**重发一份 `sessions`**，两端就此收敛。

**谁携带这条消息**：需要一个活着的子进程来发（和 `session_delete` 同构）。桌面端发给**那个工作区里活着的子进程**——因为要看一个工作区的列表，本来就有子进程在那儿回答了 `session_list`。目标会话自己**不能**是持有者（那正是 §4.4 的门禁）。

`outbound.schema.json` 的 `sessions.items[]` 追加 `archived: bool`——**追加字段**，旧前端忽略即可，不是不兼容变更。

### 4.4 门禁：正在跑的不能归档（决策 6）

**"谁持有这个会话"是桌面端知道的事实**（`sessionId → key` 索引），运行时看不到别的 child。所以门禁落在**桌面端**：

- 一张卡 / 一行，只要它在 `sessionId → key` 索引里（即有一个活着的子进程持有它），归档动作就 **inert 且可见地 inert**；
- 理由有两条，各自独立成立：① 写入方还在往那个文件追加，归档 = 从它脚下改状态；② 就算写得进去，一个"已归档但有活进程"的会话会从左栏的已保存列表掉出去、落进"open now"分组——那正是归档要消除的东西。**归档一个会话，前提是它已经关了。**

运行时不额外做门禁：它拿到的就是"给某个 id 写一个 metadata 键"，而桌面端保证此刻没有别人持有那个 id。这与 `session_delete` 那条"别的持有者先收掉"是同一个不变量（§4.1 的不变量 2）的两个方向。

### 4.5 它不省磁盘工作（如实说）

过滤归档**只让返回的列表变短，不减少运行时的磁盘工作**——`SessionSummaries` 本来就读所有会话文件，只是输出被截断了。要连扫描一起省，得上旁路索引或物理目录，那是另一件独立的事，**本轮不做**。

### 4.6 与删除的分寸

**归档可逆，删除不可逆**，两者不该同等重量：

| 动作 | 确认 |
| --- | --- |
| 删除 | 两press 确认（现状） |
| 归档 | **一次**即可——它随时能翻回来 |

---

## 5. 库搜索：扩展 `/resume`（决策 8）

`ResumePanel` 已经在列已保存会话，且和左栏读**同一个源**（`selectSavedSessions` / `activeWorkspaceOf`，见其注释"one source, so the two can never disagree"）。加两样：

1. **搜索框**：字段级，**只搜 `preview`（主题）与 `session_id`**——`preview` 是运行时算好的首条用户消息，`id` 是 `/resume` 自己用的名字，这两个是人真正可能打出来的字符串。`todos` / `messages` / `steps` 这类不搜：搜消息数或步骤数是搜元数据，不是搜对话。**不改协议**，纯前端过滤。
2. **归档过滤**：Active / Archived 两个标签（不是三档），每行一个归档 / 解除归档动作。打开库时连接向运行时请求 `all`，关闭时恢复 `active`（`AppStore.sessionFilter` 跟着面板走，不是跟着标签走）——**过滤的唯一拥有者是运行时**，标签只是对同一份 `items` 的本地透镜（`archived` 布尔）。左栏与 `Ctrl+1..9` 读的是写入时就算好的 `SavedSessions.active`，所以归档的会话**永远不会**在库开着的那段时间里冒回左栏。

**一个必须说清的限制**：`PreviewChars = 40`。按 `preview` 搜索**只能命中开头那几个词**——这是这一档的固有限制，不是实现问题。要做真正的全文检索，得让运行时扫 `sessions/<id>.jsonl`（仓库随包带了 ripgrep），那是一条新入站请求，是**独立的一轮工作**，本轮明确不做。

**顺带一个行为变化**：`Ctrl+1..9` 读的是同一份 `SavedSessions` 列表。归档一个会话后，编号会跟着移——这是可接受的（归档是一个显式动作），但要在实现时知道它会发生，别当成 bug。

---

## 6. 明确不做的事

- **不改板子的状态机**：没有拖拽、没有"手动置为完成"、没有列间移动。
- **板子不做全局（跨工作区）视图**：没打开的工作区拿不到状态，做出来会是一板永远 `idle` 的卡。
- **不给板子加系统通知**（托盘 / toast）：会话行的点和板子的列解决的是"在这个窗口里看得见"，那是另一件事。
- **不同时改左栏结构**：决策 3 命中"保持现状"。左栏唯一的行为变化是**已归档会话不再出现在已保存列表里**。
- **不做全文检索**（§5）。
- **不动 TUI / CLI 的归档能力**（决策 7）。
- **不做旁路索引 / 物理归档目录**（§4.5）。

---

## 7. 版本与实施顺序

### 7.1 版本落点

本轮**碰 Go 源码**（`internal/state`、`internal/runtime`、`internal/protocol`、`internal/i18n`）且是**用户可感知的新功能**（新命令 / 新协议字段 / 新能力）→ 按 AGENT.md 取**次版本**：

- 仓库根 `VERSION`：`5.14.2 → 5.15.0`
- 桌面端：`npm run version:bump 1.5.0`（五处一起）

### 7.2 顺序

| 步 | 内容 | 验证 |
| --- | --- | --- |
| 1 | **Go：归档事实**。`internal/state` 一个 `archived` 键的读写；`SessionSummaries(store, limit, includeArchived)` 过滤在截断前；`sessions.items[]` 追加 `archived` | `go test ./internal/state/ ./internal/runtime/`（含"过滤在截断前"的用例：造 > limit 条、把最新的几条归档，断言更旧的非归档仍在） |
| 2 | **协议**：入站 `session_archive` + `session_list.filter`，两份 schema | schema 与实现互证；`make test`（动了 `internal/protocol`，属大改动） |
| 3 | **板子：视图骨架**。`boardOpen` + `conversationView` 第 7 占用者 + 派生 `showSidebar` / `showSummary` + 左栏入口 + Esc 链 | `tests/projection.test.ts` 加 `conversationView` 优先级用例；`scripts/render-check.mjs` 断言板子打开时 right rail 收起、摘要行不出现 |
| 4 | **板子：列与卡**。3～4 列、`SessionDot`、卡片字段、点卡切会话、惰性规则 | `render-check.mjs`：两个会话（一个 running、一个 unseen）→ 列正确；点卡 → `activeKey` 变、板子关、`unseen` 清 |
| 5 | **库：搜索 + 归档过滤**。`ResumePanel` 搜索框 + 三档过滤 + 每行归档动作（活会话 inert） | 前端单测 + `render-check.mjs` |
| 6 | **文档同步**：`desktop-app.md`（§7.1 七分区里加板子这个占用者、§7.3b 左栏 footer、§4.3 入站表加 `session_archive`、§10 决策）、`README.md`、`docs/REVIEW.md` | 读一遍 |

**全量验证**（动了 `internal/protocol`）：`make test` + `npm run build` + `npm test` + `npm run audit:css` + `node scripts/render-check.mjs` + `node tests/e2e-runtime.mjs <真实二进制>`。

---

## 8. 参考：为什么不是浮层面板（留给下一次想改回去的人）

板子最自然的实现看起来是"再挂一个浮层面板，和 files / terminal 并列"。这条路被三个**已经存在的机制**堵死，而且堵得恰好都是板子的用途：

1. **面板是 Radix 模态**，打开时给 `body` 加 `pointer-events: none`——**继承**属性，所以左栏整体不可点（`railBlocked` 的注释记着这条造成过的 bug）。
2. **`focusSession` 会 `panel: null`**——点一张卡，板子自己关掉。
3. **`enqueueModal` 在请求成为队首时 `panel: null`**——正需要"还有谁在等我"的总览时，板子被自己的内容顶掉。

视图形态把三条全部避开：左栏全程可用、点卡是"聚焦并关板"、审批盖上来而板子留在底下。代价是它进了 `conversationView` 的优先级链——而那也正是一条被写下、被断言、有先例（terminal）的路。
