# 桌面端 Review 清单

对 `desktop/tudouni-aigo-desktop` 初版的审查结果，可直接当改修清单用。

| 项 | 值 |
|---|---|
| 审查对象 | `desktop/tudouni-aigo-desktop`（Tauri 2 + React 19 + zustand 5） |
| 判定依据 | `desktop/tudouni-aigo-desktop-design/desktop-app.md`、`.../tudouni-aigo/design-system/tudouni-aigo/MASTER.md`、`.../docs/tauri-native-spec.md`、`.../docs/component-states.md`；以及 Go 侧权威实现 `internal/protocol/`、`internal/runtime/`、`internal/agent/` |
| 方法 | 逐文件静态阅读 + 用仓库内真实 `src-tauri/runtime/tudouni-aigo.exe --runtime-stdio` 抓了一次开场报文（隔离临时工作区）。标 **[实测]** 的是抓到的原文，不是推断 |
| 既有检查结果 | `npm run typecheck` 干净、`npm test` 40/40 通过、`npm run audit:css` PASS。**这三项全绿并不构成通过结论**，理由见下文各处「为什么测试没发现」 |

**路径约定**：桌面端文件相对 `desktop/tudouni-aigo-desktop/`；Go 文件相对仓库根目录。

**严重度**：P0 = 破坏硬性契约或造成数据/事实错误，必须修；P1 = 应有能力缺失或产生误导；P2 = 可见的小问题或潜在隐患。

---

## 状态总览

| 级别 | 数量 | 已修 |
|---|---|---|
| P0 | 10 | 0 |
| P1 | 17 | 2 |
| P2 | 23 | 0 |

> P1-16 / P1-17 是第二轮用户反馈新增的两条（底栏 `step n / N`、右栏 `(+N more)`），
> 都带着"用户已拍板"的结论，不是待议项。
> **两条都已落地（文档侧 + 代码侧）**：`StatusBar.tsx` 只报累计 steps、`Sidebar.tsx`
> 不再截断区块内容，`BLOCK_CAP` / `block.more` / `.list-more` / `More` 全部删除。
> 其余各条仍指代码未改。

**一句话结论**：工程纪律很好（纯函数投影、无兜底值、fail-closed 模态、无乐观更新、CSS 走 token、注释解释"为什么"），但**协议层是"照记忆写的"而不是照着权威抄的**，且测试夹具由前端自己手写、与实现犯了同一个错，于是互证通过。README 里"已修复"的三个缺陷中有两个在真实时序下依然存在。

**协议层的分项判定**（逐字段对过 Go 生产者与 `protocol/schema/outbound.schema.json`）：出站消息 18/18 全对（键名、枚举、`always_group`、goal action 字符串）、CLI 参数拼装全对、`init` 16 个键全对、`ui(state)` 20 个键 + `skill_catalog` 全对且没有读不存在的键、8 种 `ui` kind 全部有分支、`delta`/`delta_reset`/`run_finished` 的配对规则正确、派生值（百分比/命中率/`outstanding`）只是复算运行时的公式而没有自创。**也就是说问题不散，集中在下面 10 条里。**

> 参考实现 `internal/frontends/report.go:31-44` 与 Rust 桥一样，是同时读同一根线的第三方前端——本次审查把它作为"正确读法"的对照物，`ui(context)` 的嵌套在那里是显式解包的。

---

## P0 · 必须修

### [ ] P0-1 `init` 的通知被紧随其后的 `session_load` 整段抹掉 —— README 声称已修的缺陷 #2 仍然活着 **[实测]**

- **现象**：启动时的所有诊断（缺 ripgrep、没配模型、MCP 没挂上、权限文件写错）永远到不了屏幕；`Welcome` 收到的 `notices` 恒为空数组。
- **证据**：
  - 前端：`init` 把通知追加进 `entries`（`src/state/store.ts:413-422`），下一条消息整段替换 `entries`（`src/state/store.ts:436-441`）。
  - 运行时：开场固定三元组且**无条件**发 `session_load`——实测顺序为 `init -> session_load -> ui/state`；源码 `internal/protocol/server.go:707-713`。
- **为什么测试没发现**：`scripts/render-check.mjs:200-202` 只喂 `init` 就断言通知渲染成功，从不喂 `session_load`——测的是一个现实中不存在的时序。
- **修法**：`init` 的通知不要放进 `entries`。加一个独立字段（如 `handshakeNotices`），在 `session_load` 重建流时把它并回流头（或单独渲染在 Welcome 上方）。`App.tsx` 的 `hasConversation` 与 `Welcome` 的 notices 一并改为读该字段。
- **验收**：在一个会产出通知的 workspace 启动（实测最容易复现的是把 `~/.tudouni/mcp.json` 指向一个不存在的 server），首屏能看到那条通知。

### [ ] P0-2 `/context` 的每个数字都读错了一层，全部显示 unknown **[实测]**

- **现象**：`/context` 面板与 `/compact` 附带的 context 行显示 `used: unknown`、`window: unknown`、没有 messages 行、没有百分比——**数字明明就在报文里**。没有 context 管理层时也不显示「这里没有上下文管理」，而是显示一排 unknown。
- **证据**：运行时真实报文（抓到的原文）：

  ```json
  {"v":1,"t":"ui","kind":"context","context":{"active":false,
    "context":{"artifacts":0,"compact":0,"compact_threshold":846028,"degraded":0,
      "dynamic":0,"estimated_tokens":3791,"items":0,"limit_tokens":940032,
      "open":0,"pinned":0,"removed":0,"stable":0,"version":0},
    "folded":0,"messages":1,"window":1048576}}
  ```

  Go 侧明文说明这是**故意的**嵌套：`internal/runtime/composition.go:1673-1688`——"the outer object is 'the context feature', the inner one is 'the ledger'"；外层为空对象时前端必须显示"这里没有上下文管理"，而不能显示一排 0。
  前端把 `msg.context` 当 ledger 用（`src/runtime/adapt.ts:508-524`，其中 `:509` `projectLedger(msg.context)`），而 ledger 在 `msg.context.context` 里（`src/runtime/adapt.ts:467-480` 读的 `estimated_tokens`/`limit_tokens`/`artifacts`/`items` 全在内层）。
- **同一个错的第二处**：类型声明本身就把形状写错了——`src/protocol/types.ts:552-565` 把 `context?: ContextLedger` 声明成扁平。**测试夹具照着这个错类型写**，于是 `tests/projection.test.ts:388` 用了扁平负载，实现与测试互证通过。
- **修法**（三处一起改，缺一处测试仍会骗人）：

  ```ts
  // src/protocol/types.ts:557
  /** 外层是"context 这个功能"，内层才是 ledger。外层为空对象表示没有上下文管理。 */
  context?: { context?: ContextLedger; generation?: number; summary_id?: string };
  // window / messages / active / folded 留在外层，保持不变
  ```

  ```ts
  // src/runtime/adapt.ts:509 / :515
  const ledger = projectLedger(msg.context?.context);
  ...
  present: msg.context?.context !== undefined,
  ```

  同时把 `tests/projection.test.ts:388` 的夹具换成上面的真实报文形状。
- **验收**：`ui(context)` 后 `/context` 显示 `3.8k / 940k`、window、messages 与百分比；没有 context 层时显示"无上下文管理"而不是 unknown。

### [ ] P0-3 `ui(run_finished).answer` 为空时，用户正在读的流式正文被删掉

- **现象**：按 Esc 打断、撞到步数上限、模型报错、空回复——**已经流出来的那半篇回答从屏幕上消失**，只留一个空 body 挂在 turn head 下。
- **证据**：`applyFinalAnswer` 无条件删除该 run 的所有 `stream` 行再追加一条 answer（`src/state/entries.ts:676-688`）。运行时在所有非正常结束路径都返回空串并原样转发：`internal/agent/agent.go:322`、`:409`、`:450`、`:524`（`return "", RunCancelled{}`）、`:501`（`return "", &EmptyResponse{}`）、`:537`（`return "", &StepLimitExceeded{}`）、`:457`、`:526`（`return "", err`），转发点 `internal/protocol/server.go:534-537`。
- **为什么测试没发现**：`tests/projection.test.ts` 只用非空 answer 调过 `applyFinalAnswer`。
- **修法**：`answer === ''` 时不要把已流出的 `stream` 行删掉——把它们转成终态（停止 `streaming` 标记）并保留；只把 answer 行写成非空时才追加。注意与 `phaseFromStopReason`（已区分 interrupted / step_limit / failed）保持一致：正文留下，结尾原因由事件侧说明。
- **验收**：发一条会写很长回答的消息，中途按 Esc——正文仍在屏幕上，相位显示"已打断"。

### [ ] P0-4 `switchSession` 先清屏再发请求 —— Go 源码明文禁止这件事

- **现象**：切换/恢复会话失败时（会话文件读不出来、runtime 没有 Factory），屏幕已经空了，运行时却仍持有旧会话，且没有任何消息会把旧会话推回来（只有成功切换才 `emitOpening`）——用户看到的是"我的会话没了"。
- **证据**：`src/state/store.ts:791-792` 先 `set({ entries: [], ... })` 再 `busSend`。运行时注释：`internal/protocol/server.go:979-984`——"The old session survives untouched. A front end is **not allowed** to clear its screen when it sends this request, precisely so that a failure here does not look like 'my session is gone'."
- **设计思想层面**：这是"运行时是权威、前端不替它下结论"的直接违规，不是普通 bug。
- **修法**：发请求前不要清 `entries`；等成功后由 `session_load` 重建流时自然替换。清空的时机 = 收到新的 `session_load`。若想立刻给反馈，把面板关掉 + 显示一条"正在切换"的本地状态即可（本地状态不是运行时事实，允许）。
- **验收**：构造一次失败的切换（例如恢复一个被删掉文件的会话 id），屏幕保留旧会话内容并出现 warn 通知。

### [ ] P0-5 `init.tools[]` 被投影出来后丢掉 → 工具行的风险标签永远不出现

- **现象**：正常会话里 `shell`（`init.tools` 里 risk=high）的工具行**没有风险徽章**，详情里 risk / parallel / interactive / external 全是 unknown；事后开 `/tools` 也补不回来。
- **证据**：`projectInit` 认真解析了 tools（`src/runtime/adapt.ts:596-627`），但 `init` 的 store 分支**只写 session/models/modelAliases/entries**（`src/state/store.ts:388-424`），`tools` 只由 `ui(tools)` 写（`src/state/store.ts:493-497`），`toolFacts` 只从那里查（`src/state/store.ts:866-875`）。而 `entries.ts` 在归约时就把 `facts?.risk ?? null` 烙进行里，所以行一旦生成就是永久的 null。
- **为什么测试没发现**：测试给 `reduceEvent` 传的是 `lookup: () => ({risk:'high',...})` 的 stub，真实 store 的 lookup 源为空这件事测不出来；另有一处断言了 `init.tools.length === 2` 但从没检查 store 存没存。
- **修法**：`init` 分支里把 `projected.tools` 映射进 store 的 `tools` 字段（形状与 `ui(tools)` 的行一致即可，`granted`/`disposition` 缺失时保持 null）。更彻底一点：`toolFacts` 改为优先查 `init` 带来的 registry，`ui(tools)` 只覆盖它。
- **验收**：新会话里发一条会调 `shell` 的消息，工具行带 HIGH 徽章，不需要先开 `/tools`。

### [ ] P0-6 启动失败是静默的，而且没有恢复出口

- **现象**：运行时二进制没就位、workspace 被拒（home 目录等）、监听注册失败、协议版本不匹配——四种情况都表现为**"正在启动…"永远停在那里**，一句话都不说，且无法恢复。
- **证据**（三条路径同时哑掉）：
  1. `attachRuntime({})` 的 rejection 没人 catch：`src/runtime/useRuntime.ts:47-58`。Rust 侧明明返回了很好的句子：`src-tauri/src/lib.rs:165-168`（找不到二进制）、`:190-196`（workspace 不能用）。
  2. `attachRuntimeListener` 失败被 `catch { return 0 }` 吞掉（`src/runtime/tauri.ts:225-229`）→ Rust 的 `listening` 停在 false → `forward_line` 把**每一行都塞进队列永不出队**（`src-tauri/src/lib.rs:376-389`）。
  3. 唯一的"硬失败"——信封版本不匹配——被当成半行残缺计数：`src/runtime/useRuntime.ts:31-35` 丢弃了 `reason`（内容形如 `envelope-version-mismatch:2`）。设计 §4.1 说 `v` 不匹配要断流并说出来；现在只是让 `dropped` 加一。
- **恢复出口也没有**：换工作区的入口只在 `runtimeExit` 非空时渲染（`src/components/chrome/TopBar.tsx:40-44`），而 attach 直接抛错根本不会有 exit 事件 → 死局。
- **修法**：
  - `attachRuntime` 全部调用点加 catch，把 Rust 返回的字符串显示成首屏错误块；
  - `runtime_attach_listener` 失败要显式报错，不能变成静默队列；
  - 解码器返回 `reason` 时区分类型：畸形行 → 计数；`envelope-version-mismatch` → 硬失败，停流并显示"运行时协议 v=N，本端只支持 v=1"；
  - 启动失败状态也渲染换工作区/重试按钮。
- **验收**：临时把 runtime 二进制改名 → 首屏显示"找不到运行时二进制"并能点重试；把 workspace 设成 home → 显示运行时给的那句拒绝理由。

### [ ] P0-7 命令面板里输入数字会直接执行命令

- **现象**：Ctrl+K 打开面板后按 `1` 立刻执行 `/new`（清空流），按 `4` 执行 `/exit`（关掉 runtime）。数字根本进不了搜索框，打错一个键就是一次不可撤销的动作。
- **证据**：`useListKeys` 在 window 上监听且没有任何 target 判断，任何 `1-9` 都走 `onPick`（`src/hooks/useListKeys.ts:55-62`）；使用方是命令面板，而它自己的输入框是 `autoFocus`（`src/components/panels/CommandPalette.tsx:39-48, 61`）；刚打开时查询串为空 → 17 行全在列表里 → 索引 0 是活的。
- **修法**：在 `useListKeys` 里忽略 `e.target` 属于 `input`/`textarea`/`contentEditable` 的按键事件（最小改动），或把监听绑到面板容器而不是 `window`。顺便把 P2 的问题模态数字冲突一并解决。
- **验收**：面板打开时输入 `1234`，搜索框显示 `1234`，没有任何命令被执行。

### [ ] P0-8 拖入文件插入路径：注释和 README 都写了，代码里没有

- **现象**：把截图/文件拖到窗口上，**webview 会导航到那个文件**，界面直接消失（重载后 runtime 会被重启，见 P0-9）。
- **证据**：`src/components/chrome/Composer.tsx:20-24` 的注释与 `README.md` 都描述了"drop 插入路径、工作区外拒绝"，但 `src/` 里 `onDrop`/`onDragOver`/`dataTransfer`/`dragenter` **零命中**，且没有任何地方监听 Tauri 的拖放事件；`src-tauri/tauri.conf.json:26` 设了 `dragDropEnabled: false`；`tauri-native-spec.md` 第 1 节同样预期前端接管。
- **注意 `dragDropEnabled` 的语义**（这个选项名字很有误导性）：设为 `true`（默认）时**由 Tauri 接管 OS 拖放**，webview 不会导航，前端用 `getCurrentWebview().onDragDropEvent()` 拿到 `{type:'drop', paths: string[]}`；设为 `false` 时改用 HTML5 拖放事件，但**拿不到完整路径**。本项目已装 `@tauri-apps/api@^2.2.0`，其 `webview.d.ts` 里 `DragDropEvent` 就是 `enter/over/drop/leave` + `paths: string[]`。
- **结论**：现在这个配置（`false`）下，设计想要的"插入**路径**字符串"根本实现不了——**配置和未实现的代码互为因果**。
- **修法**：把 `dragDropEnabled` 改为 `true`，在 `Composer`（或 App 层）`getCurrentWebview().onDragDropEvent()`：`drop` 时把 `payload.paths` 追加进草稿并用 `session.workspace` 做前缀比较，工作区外的路径拒绝并给出可见理由；`enter`/`over` 给一个视觉提示。
  若决定不做这个功能，则必须**同时**改掉注释、README 和 `dragDropEnabled` 的语义说明，不能让文档描述一个不存在的功能。
- **验收**：拖一个工作区内的文件到窗口 → 草稿里出现路径，界面不跳转；拖工作区外的文件 → 明确拒绝并说明原因。
- **验收**：拖一个工作区内的文件进去 → 草稿里出现路径；拖一个工作区外的文件 → 明确拒绝，界面不跳转。

### [ ] P0-9 F5 / Ctrl+R 刷新没有被拦，注释却把责任推给了"原生层会做"

- **现象**：误按 F5 或 Ctrl+R → webview 重载 → `attachRuntime({})` 重跑 → Rust 的重启路径**杀掉当前子进程并开一个不带 `--session` 的新会话** → 整个会话记录没了，正在跑的一轮也没了。
- **证据**：`src/hooks/useGlobalKeys.ts:10-13` 的注释说"belongs to the native layer (it is done in Rust)"；但 `src-tauri/src/lib.rs:625-665` 里没有菜单、没有 `initialization_script`、没有任何按键拦截，`tauri.conf.json` 里也没有 `menu`。设计 §8.2 明确要求禁用刷新（刷新走菜单项）。
- **修法**：window keydown 里对 `F5`/`Ctrl+R`（顺带 `Ctrl+P`/`Ctrl+F`）`preventDefault()`——这与 Ctrl+S 已经在用的机制相同；同时按 §8.2 补一个原生菜单项。
- **验收**：按 F5 与 Ctrl+R 界面无变化、会话不重启；开发时仍可用 devtools 手动重载。

### [ ] P0-10 晚到判定把所有"`run_id` 为空 / 属于子代理"的运行时行全部丢掉

- **现象**：从会话第二回合起，下面这些行**一行都不显示**，而且被计入审计面板的"Late messages dropped"——它们根本不晚：
  - **图片附件行**（`image_attached`，包括最要紧的"被拒绝"那一行）；
  - **自动压缩行**（`context_compacted`——`ui(compacted)` 只在用户主动 `/compact` 时才发，所以中途自动压缩完全没有痕迹）；
  - `goal_round`、`subagent_started`/`subagent_problem`、`delegation_started`/`delegation_finished`。
- **证据**：晚到判定在分发之前就执行（`src/state/entries.ts:269-274`）：`activeRunId !== null && ev.run_id !== activeRunId`，或 `activeRunId === null && lastRunId !== null && ev.run_id !== lastRunId` → 判为 stale。而运行时这些事件的第三个参数（即 `run_id`）**按设计就是别的值**：
  - `image_attached`：四个发射点全是 `""`（`internal/runtime/images.go:289`、`:305`、`:321`、`:343`）——实测确认，不是推断；
  - `context_compacted`：`""`（`internal/agent/context.go:684`）；
  - `goal_round`：`""`（`internal/runtime/goal_driver.go:357`、`internal/runtime/goal_round.go:190`）；
  - `delegation_started`/`delegation_finished`：**子代理 id**（`internal/subagent/spawn.go:141`、`:161`；第三个参数就是 `runID`，见 `internal/audit/jsonl.go:69-76`）。
  回合结束时 store 留下 `activeRunId=null, lastRunId=<刚结束的 run>`（`src/state/store.ts:452-465`），于是从第二回合起 `"" !== lastRunId` 恒成立；图片行还会先于 `run_started` 到达（`internal/runtime/images.go:107-108`，TUI 在 `internal/frontends/tui/model.go:827-839` 特意注明），所以第一回合能显示、第二回合起消失。
- **图片这条路是可达的**：图片不靠拖放附上，而是靠**消息文本里写出的路径**（`internal/runtime/images.go:97-117`，`turnMessages(text)` → `attachPictures(text)`）。所以即使拖放（P0-8）是坏的，粘贴或手写一个图片路径就会走到这条分支；而 `refused` 恰恰是最常见的一种——模型没有 vision 时（`internal/runtime/images.go:335-349`）。
- **这条行的分量由参考前端写明**：`internal/frontends/tui/model.go:834-838`——被拒的图片那行 "is the only evidence the model never saw the screenshot"（这是"模型从没看过你的截图"的唯一证据）。
- **顺带是一个静默的谎**：`dropped` 同时被审计面板当作"晚到消息"展示（`src/components/panels/panels.tsx:664-669`、`src/i18n/index.ts:227-229`），委派期间它会一直上涨，而没有任何消息是晚到的。
- **根因之一是你的 Go 侧注释写错了**：`internal/protocol/server.go:1096` 说委派记录的 "run_id is the parent's turn"，实际发射点传的是子代理 id（`internal/subagent/spawn.go:141`、`:161`）。前端照着这条注释设计了判定规则。**建议同时修这条注释**，否则改完前端还会有人再踩一次。
- **修法**：区分"会话级事件"与"回合级事件"。`run_id === ""` 的（图片、压缩、goal、委派、子代理）一律接受；只有真正属于某回合的（`model_call`/`tool_call`/`tool_result`/`permission`/`tool_batch`/`run_started`/`delta_reset`）才用 `run_id` + `step` 判定。顺便把 `dropped` 拆成"协议层丢弃"和"真正晚到"两个计数（见 P2）。
- **验收**：第二回合时在消息里写一张图片的路径（用一个没有 vision 的模型）→ 流里出现"未被接受"的行并说明原因；一次中途自动压缩也留下行；连续做几次委派而 `dropped` 不再上涨。

---

## P1 · 应该修

### [ ] P1-1 侧栏"已加载技能"永远是空的 + `skillCatalog` 被写丢

- `src/state/store.ts:913-931`（`applyStateSnapshot`）从不把 `projectState` 算出来的 `skillCatalog` 写进 store（初值 `src/state/store.ts:349`），侧栏只读 `uiState.skills`。
- 运行时侧 `ui(state).skills` 与 `skill_catalog` 实测都是 `[]`（`internal/runtime/composition.go:1514`、`:1551`）。桌面端设计文档写明 runtime 改动不在本项目范围内，所以**前端能补偿的部分要先补**：`ui(skills)` 返回的 `skills` + `active` 才是真实来源。
- 修法：把 `skillCatalog` 落进 store；侧栏与技能面板都改为读 `ui(skills)` 的真实结果（`active` ∪ 目录）。

### [ ] P1-2 技能面板把"能加载的目录"当成"已加载"

- `ui(skills).skills` 是 this session **can load** 的全量目录（`internal/runtime/composition.go:1743-1796`），`active` 才是已加载的名字（Go 侧 `internal/skills/render.go:73-74`："ActiveNames is the loaded skills in load order"）。前端**从不读 `active`**（`src/runtime/adapt.ts:596-606` 声明了字段，没有消费点），却把整个目录挂在 "Loaded" 徽章下（`src/components/panels/panels.tsx:342-372`）；更糟的是 `loadedNames` 就是从同一个数组推出来的，所以"目录减去已加载"那段**永远是空的**。
- 同一族的另外三处：store 顶层 `skillCatalog`（`src/state/store.ts:176`、`:349`）初始化为 `[]` 之后**从未被赋值**（只有 `uiState.skillCatalog` 拿到了值，`src/runtime/adapt.ts:550`）→ 面板页眉永远显示 `N / 0`，`known.get(name)` 永远查不到描述；`digest` 在投影里被硬编码成 `''`（`src/runtime/adapt.ts:666-671`）→ 每个 digest 格子都是空的。
- 修法：已加载 = `active`（名字）+ `ui(state).skills`（digest，注意它在运行时侧目前是空的，见下条）；未加载 = `ui(skills).skills` 减去 `active`——面板里那段"目录"的意图本来就是"差集"。`digest` 从真实来源取，不要填 `''`。顺带修 P2 里两个用错的 i18n key。

### [ ] P1-3 "非默认权限"面板报的是假数据

- `autoApprove`/`autoApproveTools`/`shellAllow` 在投影里被硬编码成 `[]`（`src/runtime/adapt.ts:536-541`），而真正的来源 `init.permissions` 存进了 `session.permissions` 却**从没被任何组件读取**。
- 后果：`~/.tudouni` 配置里写好的 `auto_approve` / `shell_allow` 被审计面板显示成"无"。设计里 `ui(state)` 承载的是"运行时的实时授权"，配置级 scope 只走 `init` 与 `ui(status).meta`——投影注释本身就写对了（`src/runtime/adapt.ts:526-534`），只是调用方读错了源。
- 修法：审计面板读 `session.permissions`（`init` 来源）；若同时要显示实时授权，再取 `ui(state)` 的 granted 列表，两者分开呈现。

### [ ] P1-4 运行时意外退出不结束回合

- `runtime_exited` 只记 code/requested（`src/state/store.ts:640-643`），`hasRunningTurn` 保持 true → 相位永远 Running，输入框锁死在"打断"按钮上，Enter/Esc 都无效；而"打断"发出的消息被 `runtime_send` 的 `.catch(() => {})` 静默吞掉。
- 修法：`runtime_exited` 时结束当前回合（给 turn head 一个"运行时已退出"的终态）、清 `activeRunId`，并让 composer 回到可重试/换工作区的状态。
- 验收：turn 进行中杀掉子进程 → 状态栏红色提示，但输入区不再锁在"打断"，相位不是 Running。

### [ ] P1-5 `session_list` 没人请求 → 首屏"最近会话"永远是 4 个空槽，`Ctrl+1..9` 是死键

- `requestSessionList` 零调用者（`src/state/store.ts:795-798`），只有打开 `/resume` 面板才发该消息。首屏按设计应显示按 `modified_at` 最近的 4 个会话。
- 修法：收到 `init`（以及 `session_load`）后各发一次 `{"v":1,"t":"session_list"}`。

### [ ] P1-6 没有 IME 保护：Enter 会把半成品中文发出去

- `isComposing` / `compositionstart` 全仓 0 命中，裸 Enter 直接发送（`src/components/chrome/Composer.tsx:64-68`）。中文/日文用户按 Enter 上屏候选词的瞬间，半句被当成一轮发出去——对主要用户群是高频问题。
- 修法：在 Enter 分支（以及 Ctrl+J / 历史导航分支）之前加 `if (e.nativeEvent.isComposing || e.keyCode === 229) return;`。
- 验收：用中文输入法打字，Enter 上屏不发送；再按一次 Enter 才发送。

### [ ] P1-7 第二条阻塞请求覆盖第一条，前一个 id 不可恢复

- `modal` 是单槽，两类请求都直接 `set({ modal })`（`src/state/store.ts:628-638`），`answerPermission` 只读当前 modal → 前一个请求的 id 永久丢失，运行时永久等待。发生概率低（agent 单线程提问），但代价是挂死。
- 修法：请求入队，渲染队首，绝不丢弃未回答的 id。

### [ ] P1-8 模态打开时全局快捷键没关

- 只有 Escape 检查了 `modal`（`src/hooks/useGlobalKeys.ts:27`），Ctrl+K/B/S/T/`\` 照常执行，`openPanel` 也没有 guard（`src/state/store.ts:700-715`）→ 在 fail-closed 的审批提示背后能开出面板，提示答完后面板突然出现。"阻塞"没有真的阻塞。
- 修法：全局处理函数在模态分支后立即 `if (s.modal !== null) return;`，`openPanel` 同样加 guard。

### [ ] P1-9 Ctrl+C / `/exit` 不退出应用，还被报成"意外死亡"

- 只往协议发 `shutdown`（`src/hooks/useGlobalKeys.ts:67-74`、`src/commands.ts:102-104`）；`requested=true` 只在 Rust 的 `runtime_shutdown`/`runtime_kill`/重启路径设置，所以用户主动退出会得到红色"运行时意外退出 (code 0)"（`src/components/chrome/StatusBar.tsx:98-101`），窗口也不关。`shutdownRuntime()` 已实现但零调用者（`src/runtime/tauri.ts:233`）。
- 修法：Ctrl+C 与 `/exit` 走 `shutdownRuntime()`，收到 `runtime_exited` 后关窗；或至少在主动退出时把 `requested` 标为真。

### [ ] P1-10 没有焦点归还，也没有 composer 自动聚焦

- 全仓没有 `DialogPrimitive.Trigger`（Radix 无处可还），`Composer` 也没有 `autoFocus`（唯一的 `autoFocus` 是命令面板的输入框）。关掉任何面板/模态或冷启动后光标落在 body 上，打字没反应，必须先点一下。
- 修法：`ready && modal === null && panel === null` 时自动聚焦 composer；面板/模态的 `onCloseAutoFocus` 里显式 focus 回 composer。

### [ ] P1-11 窄窗 960–1024px 侧栏和摘要行同时消失

- CSS 在 1024px 以下隐藏 `.app-sidebar`（`src/styles/global.css:272-276`），而 `CollapsedSummary` 由 JS 状态 `sidebarVisible` 决定（`src/App.tsx:57`），它此时仍是 true → 两者都不显示。窗口最小宽度恰好是 960（`src-tauri/tauri.conf.json` 的 `minWidth`）。
- 修法：交接用 `matchMedia('(max-width:1024px)')` 订阅驱动；或只要侧栏被 CSS 隐藏就渲染摘要行。

### [ ] P1-12 关窗会把 Tauri 事件循环卡住最多 30 秒；启动失败诊断面板不存在

- `WindowEvent::CloseRequested` 里同步调用 `runtime_shutdown`（`src-tauri/src/lib.rs:655-662`），而它是 `loop { sleep(100ms) }` 直到 `SHUTDOWN_TIMEOUT`（30s）的**同步**命令（`src-tauri/src/lib.rs:516-536`）→ 跑着回合关窗，窗口 30 秒不响应且没有任何提示。
- 同时 `readRuntimeStderr` 零调用者（`src/runtime/tauri.ts:246`），README 描述的"运行时起不来"诊断面板不存在——而 Rust 侧已经把 stderr 收进 ring buffer 并发了 `runtime://stderr` 事件（`src-tauri/src/lib.rs:284-317`），只差前端消费。
- 修法：关窗改成先 `prevent_close`，在后台线程里 shutdown，完成后关闭窗口；补一个消费 `runtime://stderr` 的诊断面板，与 P0-6 的错误显示合用。

### [ ] P1-13 `image_attached` 的 `refused` / `over_limit` 两个分支读的键不存在

- **现象**：被拒的图片那一行只显示 `" was not attached"`——没有文件名、没有原因、没有模型名；over-limit 那行丢掉了运行时特意命名的 `paths[]`。
- **证据**：`src/state/entries.ts:563-583`——`skipped|refused` 读 `ev.path` 与 `ev.reason`，`over_limit` 只读 `rest`/`limit`。对照 Go 侧的三个形状：
  - `skipped` 确实发 `path`/`status`/`reason`（`internal/runtime/images.go:304-310`）✔ 对得上；
  - `refused` 发的是 `{status:"refused", names:[…], model:…}`——**没有 `path`、也没有 `reason`**（`internal/runtime/images.go:336-349`）；那句给人看的话由 `reportImagesRefused` 写去 stderr，而 stderr 按设计不会变成协议内容（`src/runtime/tauri.ts:153-157`）；
  - `over_limit` 发 `{status, limit, rest, paths:[…]}`（`internal/runtime/images.go:316-327`）。
- **修法**：`refused` 分支改用 `names[]` + `model` 组句（例："模型 X 不支持图片，N 张未随消息发出"）；`over_limit` 分支列出 `paths[]`。**不要**继续保留"取不到就拼接空串"的写法——那正好产出一句看似正常、实则无信息量的话。
- **与 P0-10 的关系**：这条是"读错键"，P0-10 是"根本读不到"。两条都要修，否则守卫修好之后你看到的仍然是一句没有信息量的话。
- **验收**：用一个没有 vision 的模型，在消息里写一条图片路径 → 行里出现文件名与原因。

### [ ] P1-14 `degraded` 线上是整数个数，前端当成 boolean → 永远不显示

- `src/protocol/types.ts:547` 声明 `degraded?: boolean`，`src/runtime/adapt.ts:478` 用 `typeof ledger.degraded === 'boolean'` 判断 → 恒为 `null`。
- Go：`internal/context/manager.go:313` 发的是 `"degraded": len(m.LastDegraded)`（个数）；参考前端按数字渲染（`internal/frontends/report.go:70-76`）。
- 修法：类型改 `number | null`，把个数显示出来（"N 项被降级"）。**依赖关系**：这条在 P0-2 修好之前本来就取不到值，属于"修 P0-2 时要一起改"的一项。

### [ ] P1-15 `useUsage` 把"provider 的计数"和"本地估算"塞进同一个格子

- `src/state/store.ts:1022`：`status?.lastPromptTokens ?? context?.used`。这两个数的含义不同——`last_prompt_tokens` 是**上一次成功请求的实际输入**（`internal/state/status.go:100-108`），`context.used` 是本地估算的 `estimated_tokens`（`internal/context/manager.go:287-319`）。
- 参考前端的做法正好相反：TUI 在 `internal/frontends/tui/status.go:112-127` 用 provider 的数算百分比，`hasUsed` 为假时**直接显示 unknown**（"a wrong one is worse than none"），并在 `:129-130` 注明"context 系统自己的 ledger 是另一个事实——本地估算对比 provider 实际收到的"。**不许互相顶替。**
- **后果**：现在被 P0-2 掩盖（fallback 永远取不到值）；**修好 P0-2 的那一刻它会立刻变成真的**——状态栏会把一个本地估算标成"上次请求的输入"。
- 修法：不要用 `??` 顶替。缺 provider 数就显示 unknown；要显示估算就单独一格并标明是估算。
- **验收**：一个回合都还没跑完时状态栏不显示百分比；跑完后显示的是 provider 的数。

### [ ] P1-16 底栏 `step n / N` 把"会话累计"和"单回合预算"拼在一格 —— 出现 `step 497 / 120` **[用户反馈，已定结论]**

- **现象**：状态栏左段显示 `step 497 / 120`。分子超过分母，读起来像计数溢出或算错。
- **证据**（两个数根本不是同一件事）：
  - **分子**：`src/components/chrome/StatusBar.tsx:121` 的 `session?.steps ?? 0` ← `ui(state).steps` ← `internal/runtime/composition.go:1527` 的 `r.SessionValue.StepCount()`；而 `internal/state/session.go:56-67` 写明它**统计会话里所有 `assistant` 消息**，即"这个会话一共跑了多少次模型往返"。它随会话单调递增，`/resume` 恢复的长会话天然很大——497 就是这么来的。前端落点：`src/state/store.ts:2276`（每次 `ui(state)` 覆盖）、字段注释 `src/state/store.ts:212-214`（"Cumulative steps for this session"）。
  - **分母**：`StatusBar.tsx:122` 的 `session?.maxSteps ?? 0` ← `init.max_steps`（`internal/runtime/composition.go:1502`、`src/state/store.ts:1382`），语义是 `--max-steps`，即**一个回合**最多允许几次模型调用（`internal/agent/agent.go:23` `DefaultMaxSteps = 120`，在 `agent.go:400` 的 `for a.step = 0; a.step < a.MaxSteps` 里**按回合重置**）。
  - 因此 `497 / 120` 不是溢出，是把"会话累计"和"单回合预算"当成了同一维度的两个数。
- **与两个参照前端都不一致**：
  - TUI 底栏读的是 `m.current.steps`（`internal/frontends/tui/view.go:848-851`），每收到一次 `model_call` 自增、`finishTurn` 后 `m.current = nil`（`model.go:711`、`model.go:932-935`），且 `current == nil || steps == 0` 时**整个不画**；
  - 桌面端自己的回合头 `src/components/stream/EntryView.tsx:111-113` 用的是 `entry.step / entry.maxSteps`（由 `bumpStep`，`src/state/entries.ts:681-692` 逐事件推进），**那才是每回合的正确数**。
  - 也就是说底栏这一格既与 TUI 不一致，又与自家回合头不是同一个数——而且两者陈述的是同一件事，属于重复展示。
- **附带**：`maxSteps > 0` 就无条件渲染（`StatusBar.tsx:155`），所以空会话会显示 `step 0 / 120`；TUI 在这种情况下什么都不画。
- **文档就是错的来源**：`desktop/tudouni-aigo-desktop-design/multi-session-parallel.md:564` 的表格把这一格标成 `session.steps / session.maxSteps`。**改代码时必须连这一行一起改**，否则下一个人会照它改回去。
- **决策（用户已定）**：左下角**去掉上限**，只显示这段对话的累计 steps。即去掉分母 `maxSteps`，保留累计值。
- **修法**：
  1. `StatusBar.tsx`：删掉 `maxSteps` 的读取与 `status.step` 的两参数调用，只渲染累计数。
  2. `i18n`：`'status.step': 'step {n} / {max}'`（`src/i18n/index.ts:79`）需要一个单参数的兄弟 key。**注意 `status.step` 目前是共用的**——`EntryView.tsx:112` 的回合头也在用它，所以**不要就地改这条 key**（会连带改掉回合头），新增一条 key 给底栏，或让回合头继续用原 key。
  3. 文案措辞要能读出不带上限的语义（例如 `N steps`），否则一个孤零零的 `step 497` 仍然像"第 497 / 未知"。
  4. `maxSteps` 在别处仍有正当用途（会话栏 `SessionBar.tsx:132-133` 的 `step cap` 事实、设置面板的 `--max-steps`），**只动状态栏这一处**。
- **不要顺手改成"当前回合的 step"**：那是回合头的职责，底栏放累计值是本次的决定；两处都画同一个数才是真正的冗余。
- **验收**：在恢复的长会话（累计 400+）里打开窗口，底栏不出现大于分母的分式；跑完一个回合后数字继续累计。

### [ ] P1-17 右栏 `(+N more)`：cap 是 TUI 的约束，桌面端是滚动容器，不该继承 **[用户反馈，已定结论]**

- **现象**：右侧栏五个区块各自只画前 5 行，其余折成 `(+N more)`。桌面端本该有的滚动条下方，这个标记既没必要又和 TUI 看起来是一回事。
- **证据**（cap 的来源与 TUI 的必要性）：
  - 前端四处：`src/components/sidebar/Sidebar.tsx:80-83`（todos）、`:99-108`（skills）、`:123-126`（jobs）、`:138-141`（mcp），都是 `slice(0, BLOCK_CAP)` + `<More count={len - BLOCK_CAP} />`；`More` 在 `:220-223` 渲染 `t('block.more')`；常量 `src/state/store.ts:113` `export const BLOCK_CAP = 5;`；文案 `src/i18n/index.ts:199` `'block.more': '(+{n} more)'`；样式 `src/styles/components.css:367`。
  - TUI 侧同样的东西是 `internal/frontends/tui/rail.go:71` 的 `railMaxRows = 6` 与 `:222-250` 的 `clipBlock`，它存在的理由写在注释里：`renderRail` 画的是**固定高度的列、不是滚动容器**，装不下就只能砍，否则某个区块永远够不着。**这是终端的能力约束，不是设计偏好。**
  - 桌面端没有这个约束：`.sidebar-inner` 是 `overflow-y: auto`（`src/styles/stream.css:628-638`），列表再长也只是滚动，砍掉反而让用户看不到本可以滚到的东西。
  - 注意 TUI 侧还有一层"终端没高度"的兜底：`rail.go:203-215` 在整列装不下时逐行截断并标 `rail.more`。桌面端没有对应的场景，所以两处都无需要保留。
- **文档就是错的来源**：`desktop/tudouni-aigo-desktop-design/desktop-app.md:439`（§7.3 正文）与 `:556`（§10 决策 6）把"各区块 5 行 + `(+N more)`"写成了设计系统的一部分，`:581`（§11 实施顺序第 5 条）又要求"上限常量按决策 6 落进设计系统"。**三处都要改**，否则文档与实现互相打架。
- **决策（用户已定）**：右侧栏**去掉 cap**，有多少列多少——桌面端的设计思想就是"能滚就不砍"。
- **修法**：
  1. `Sidebar.tsx`：四处 `slice(0, BLOCK_CAP)` 改为直接 map 全量；删掉四处 `<More>` 与 `More` 组件本身；删掉 `BLOCK_CAP` 的 import。
  2. `src/state/store.ts:113`：删掉 `BLOCK_CAP`（及 `:107-115` 那段"决策 6"的注释）。
  3. `src/i18n/index.ts:199`：删掉 `'block.more'`，并核对 `TKey` 联合类型不会因此报错（它是从 catalog 推出来的）。
  4. `src/styles/components.css:367`：删掉 `.list-more`（`class-audit.mjs` 查的是"有 className 没样式"，反向的孤儿样式它不报，但要顺手清掉）。
  5. **`Block` 的折叠与 `inert` 不动**——那套是对的（保留 DOM + 高度归零，见 `Sidebar.tsx:185-206` 的注释），只是不再截断内容行。
- **已核实的无风险点**：`scripts/render-check.mjs`、`tests/`、`src/` 全仓搜过，**没有任何断言或测试依赖 `BLOCK_CAP` / `block.more` / `.list-more`**（`render-check.mjs` 对右栏只断言 5 个区块的标题顺序、`3/60` 目标轮次、`uncollected` 徽章、`pdf-tools` 技能名与 MCP 行宽，见 `:816-830`），所以去掉 cap 不会碰坏现有校验。
- **验收**：喂一个 8 项的 `todos`（`render-check.mjs:754-760` 现在只喂 2 项），五条以上的任务全部出现在 DOM 里，没有任何 `(+N more)` 文本，右栏可以滚到底。

---

## P2 · 小问题

- [ ] **`goal_round` 没有对应行**：运行时会发这个 audit kind（`internal/runtime/goal_driver.go:345-357`、`internal/runtime/goal_round.go:190`，带 goal_id/phase/rounds/round），reducer 没有分支；而且它 `run_id=""`，所以即使补了分支也会先被 P0-10 的守卫丢掉。目标被排队或被跳过时，用户看不出目标循环在不在推进。补条目类型（或在 turn head 上带标记），并先修 P0-10。
- [ ] **schema 与设计文档已落后于运行时，需要同步**（否则下一个人还会照错的写）：设计文档说 `ui` 有 7 种 kind，运行时实际 8 种（漏了 `skills`，见 `internal/protocol/messages.go:100-109`）；文档与 `protocol/schema/outbound.schema.json:106-107` 说 `event` 有 11 种，运行时能发 14 种（多 `goal_round`、`subagent_started`/`subagent_problem`、`delegation_started`/`delegation_finished`）；schema 的 context 容器里列了 `updated_at` 而 `contextPayload()` 从不发送（`internal/runtime/composition.go:1703-1735`）；schema 的 MCP 段（`:226-236`）描述了 `failed`/`error` 两种实现里不存在的状态。
- [ ] **`context_degraded` 丢掉了半个负载，且文案是前端自己写的**：`src/state/entries.ts:481-499` 只读 `items`/`limit`；Go 发的是 `{items, estimated, limit, changes}`（`internal/agent/context.go:177-186`）→ `estimated` 与 `changes` 丢失。规则是"运行时写给人看的话原样显示"，这里却是前端拼句子。
- [ ] **MCP 失败态：前端建模了 `failed`/`error`，运行时从不发**（`src/protocol/types.ts:54`、`src/runtime/adapt.ts:383-390`）→ 一个**加载失败**的 server 和一个**只是没加载**的 server 显示得一模一样，原因只藏在面板上方的一句 note 里。Go 侧只发 `{name, where, state: loaded|unload, tools}`（`internal/runtime/mcp.go:194-211`），失败以句子形式走 `mcp_notes`。属于运行时侧缺口，但前端可以至少在 note 出现时把对应行标红。
- [ ] **`model_catalog.aliases` 运行时恒为空**（`internal/runtime/composition.go:2062-2079`，`aliases` 声明后从未 append）→ `/model` 面板的"legacy names"组永远不会出现。桌面端读法正确，属运行时侧缺口。
- [ ] **`projectUi` 是死代码（更正上一版判断）**：`src/runtime/adapt.ts:700-720` 定义了它，但 `store.ts` 有自己的 switch，全仓**没有任何调用点**（本次已核对）。所以它 default 分支里 `projectState(unknownMsg)` 那处"把未知消息当空快照"的行为**当前不可达**——不是 P1，但值得删掉或补上调用点，因为一旦有人接线它就会清空整个侧栏。
- [ ] **两处小偏差**：`src/runtime/adapt.ts:777` 的注释把 `HitRate` 指到 `internal/state/status.go:116`，实际在 `:117`；`phaseFromStopReason`（`src/runtime/adapt.ts:71-83`）把 `empty_response` 映射成 `done`，而参考前端给它单独一条警告（`internal/frontends/tui/model.go:956`）。
- [ ] **`ui(run_finished)` 缺 `answer` 会白屏**：store 绕过投影的 `str()` 守卫直接传 `msg.answer`（`src/state/store.ts:555`），`Markdown` 直接 `text.replace`（`src/components/ui/Markdown.tsx:54-55`），全仓没有 error boundary。用 `str()` 收口，并加一个 error boundary。
- [ ] **问题模态里数字键被吞**：`1-9` 处理挂在 `DialogPrimitive.Content` 上（`src/components/modals/QuestionModal.tsx:79-88`），从自由作答的 textarea 冒泡上来 → 想回答"要 3 个副本"会选中第 3 个选项。与 P0-7 一起修。
- [ ] **`delta_reset` 两条路径清的范围不一致**：作为 event 只清 `text`（`src/state/entries.ts:477-479`），作为顶层消息清两个通道（`src/state/store.ts:596-602`）。规格说该消息不带 channel、使该 step 已画的内容失效 → 统一为两个通道。
- [ ] **PgUp/PgDn 完全没实现，但帮助面板里写着**（`src/components/panels/panels.tsx:436`）；流区域没有 `tabIndex`，纯键盘读不了历史。要么实现（`useListKeys` 加 PgUp/PgDn + 给 `.stream-scroll` 可聚焦），要么从帮助里删掉。
- [ ] **Esc 打断发两次 `interrupt`**：`src/components/chrome/Composer.tsx:79-85` 不 `stopPropagation`，`src/hooks/useGlobalKeys.ts:33-36` 不检查 `defaultPrevented`。同一个键一个动作。
- [ ] **面板 Esc 被两处同时处理**（`useGlobalKeys.ts:26-32` 与 `useListKeys.ts:33-36`），效果相同但重复。
- [ ] **未收集的后台任务会让前端每 2 秒轮询到会话结束**：`uncollected` 也计入 `outstanding`（`src/runtime/adapt.ts:363-364`），而它只能靠 `job_output` 收走（`src/state/store.ts:935-937`）。设计说 status 读取审计日志、不能变心跳；这条走的是轻量 `refresh_state`，但仍应加封顶/退避（例如连续 N 次无变化后停）。
- [ ] **`dropped` 混了三种事实**：半行残缺 + 版本不匹配 + 晚到消息，只显示一个数字（`src/state/store.ts:163-164`）。建议至少把版本不匹配单独拉出来（见 P0-6）。
- [ ] **`blockCollapsed` 的自动展开规则是死代码**：默认全展开（`src/state/store.ts:244-250`），而自动展开只在"首次出现内容且该块当前折叠"时触发；另一半语义（用户手动折叠后不被后续快照弹回）是对的，保留。
- [ ] **`applyStateSnapshot` 改了持久化偏好却不 `persistPrefs`**（`src/state/store.ts:897-931`）→ 刷新后可能与上次屏幕不一致。
- [ ] **`entries` 无上限**，每个 delta 整表拷贝，Markdown 无缓存 → 长会话随历史线性变差（TUI 侧为同类问题做过渲染缓存，可参考）。
- [ ] **dev 下 StrictMode 双挂载**：`dispose()` 无法取消进行中的监听注册，泄漏 3 个 listener + 一个没人 drain 的队列，并让 `runtime_attach` 发两次（`src/runtime/tauri.ts:119-189`）。仅影响开发，但会在每个 dev 启动时多起一次子进程。
- [ ] **`StatusBar` 的结算文案从未实现**：`selectAction` 最后一行是 `s.session?.model ? null : null`（`src/components/chrome/StatusBar.tsx:45-56`），设计 §7.4 要求"当前动作**或结算**文案"。
- [ ] **技能面板两处 i18n key 用错**：`panel.help.commands` 用在了技能目录标题上（`src/components/panels/panels.tsx:379`），刷新按钮用了 `cmd.skills.desc`（`:421`）。
- [ ] **无 `aria-live`**：相位切换、新通知、流式回答对读屏器全部静默。
- [ ] **其他小项**：Welcome 的 `⏎/⇧` 与帮助面板的 `Enter/Shift` 写法不一致；`TitleBar` 算了 `isMaximized()` 却忽略结果；`PermissionModal` 在渲染 Description 的同时设 `aria-describedby={undefined}`；`applyStateSnapshot` 里 `provider: snap.modelProvider || session.provider` 用了 `||`（空串会回退，语义上应显式判 null）；66 个 CSS 类未被引用；8 处硬编码颜色（终端区可辩护，但缺少 `--terminal-fg`/ANSI token 可用）。
- [ ] **P1-17 落地后的遗留**：`.list-more`（`src/styles/components.css:367`）与 `'block.more'`（`src/i18n/index.ts:199`）会变成无引用；`scripts/class-audit.mjs` 只查"有 className 没样式"这一个方向，孤儿样式与孤儿 key 都得手动清。
- [ ] **P1-16 落地后的遗留**：`status.step` 仍是共用 key（回合头 `EntryView.tsx:112` 与底栏 `StatusBar.tsx:156`）。若底栏改用新 key，记得确认 `entry.turnStepLimit` 那条链路没被连带改动。

---

## 第二轮用户反馈（已定结论，不是待议项）

这两条来自实际使用，**用户已给出结论**，实现时按结论做，不必再论证是否该做：

1. **底栏去掉单回合上限，只保留对话累计 steps**（P1-16）。
2. **右栏去掉区块内容上限，有多少列多少**（P1-17）。理由就是桌面端与 TUI 的差别：TUI 的栏是固定高度、不可滚（`internal/frontends/tui/rail.go` 的 `railMaxRows` 与 `clipBlock` 的注释写明这是终端能力约束），桌面端的 `.sidebar-inner` 本来就是滚动容器，砍掉的内容用户本可以滚到。

两条都牵动设计文档，一起改（见下节）。

---

## 四个维度的结论

**功能正确性 —— 不通过，但问题高度集中。**
错的地方只有三类：**读错层级**（P0-2 把 container 当 ledger）、**读错键**（P1-13 的 `path`/`reason`）、**把运行时的事实丢掉**（P0-1 通知、P0-5 工具风险、P0-10 的 `run_id` 过滤、P1-3 权限）。其余逐字段对过 Go 生产者与 schema 都是对的：出站 18 个 `t` 值与枚举、CLI 参数拼装、`init` 16 个键、`ui(state)` 20 个键 + `skill_catalog`（且没有读不存在的键）、8 种 `ui` kind 全有分支、`delta`/`delta_reset`/`run_finished` 配对、派生值只复算不自创、`permission_request` 的 hint 字段、`question_request`、`sessions.items`。**所以这不是"协议层不会写"，是"没有拿真实报文校验过"。**
其中 P0-10 是最隐蔽的一条：它不读错任何字段，判定规则本身写得很整齐（注释还解释了为什么按 `run_id` 配对），错的是"所有事件都有回合"这个前提——而运行时的注释（`internal/protocol/server.go:1096`）恰好把这个前提写错了，两边一起错，于是测试也测不出来。

**是否符合 tudouni-aigo 的设计思想 —— 大体符合，四处越界。**
符合的部分很硬：纯函数投影、无兜底值、无乐观更新、阻塞模态 fail-closed、运行时权威、主题单一来源、不认识的类型忽略。
越界的四处方向一致——**前端替运行时下结论**：清屏后再发 `session_switch`（P0-4）、空 answer 覆盖流式正文（P0-3）、把"能加载的目录"当"已加载"（P1-2）、把本地估算当 provider 计数（P1-15，修完 P0-2 就会显形）。
反向的一类更长——**把运行时已经给的事实丢掉**：P0-1、P0-5、P0-10、P1-3、P1-13、P1-14。两类都是"事实来源唯一"这条原则的破口，而**丢掉**那一类比**替它下结论**那一类多得多：前端整体是保守的，问题出在"以为某些事实不存在"。

**代码缺陷（含测试有效性）**
40 个测试全绿、`tsc -b` 干净、CSS 审计 PASS，但：
- context 的测试夹具与实现犯了同一个协议错误（`src/protocol/types.ts:552-565` 的类型声明就是错的），**互证通过**；
- `render-check.mjs` 只喂 `init`，`session_load` 从未进入任何自动化路径 → "通知不丢"与"首屏正确"两条断言测的是不存在的时序；
- `reduceEvent` 的 `lookup` 在测试里是 stub → 真实 store 的 lookup 源为空测不出来；
- `useRuntime.ts` / `attachRuntime` / `pickWorkspace` / 关窗路径**完全没有测试覆盖**。

**UI 交互合理性 —— 布局与视觉是最扎实的部分，键盘与焦点是短板。**
做到位的：高度总账闭合（`100dvh` flex + 唯一弹性行 + 一路 `min-height:0`）、面板 fixed + 内部滚动 + `flex:none` 页脚、无 emoji 图标、无 `devicePixelRatio` 手算、hover/focus/disabled 齐全、流式滚动不抢用户位置（`pinned` 由滚动间隙决定，用户上滚即释放并有"跳到最新"）、`prefers-reduced-motion` 有兜底、tooltip 400ms 且键盘可达。
短板集中在：模块关闭后焦点不回位（P1-10）、模态不真的封锁全局键（P1-8）、中文输入法（P1-6）、数字键语义冲突（P0-7 + 问题模态）、以及键位表里"写了但没实现"的项（PgUp/PgDn）。

---

## 建议的修复批次（按顺序勾选）

- [ ] **批次 1（收益最大，先做）**：P0-2 + P1-14 + P1-15 + 附 B 的契约快照测试。context 层级要连类型、投影、夹具三处一起改；而修好 P0-2 的**同一刻** P1-14（`degraded` 类型）会变成可见、P1-15（`??` 顶替）会变成真的——三条必须同批，否则修完立刻多两个新错误。
- [ ] **批次 2（同一组事件行、同一处守卫）**：P0-10 + P1-13。先让会话级事件不再被当成晚到，再修 `refused`/`over_limit` 的键——只修一半的话，守卫放行了但那一行仍然没有信息量。**顺带把 Go 侧 `internal/protocol/server.go:1096` 的注释改对**，否则下一个人还会照它写。
- [ ] **批次 3（"运行时给了、前端丢了"三连）**：P0-1、P0-5、P1-3。都是 store 里少写/多写一处。
- [ ] **批次 4（启动与关闭边界）**：P0-6、P0-9、P1-12。catch 并显示 + 拦 F5/Ctrl+R + 关窗异步化 + 消费 stderr 做诊断面板。
- [ ] **批次 5（回合与切换的收尾语义）**：P0-3、P0-4、P1-4。
- [ ] **批次 6（两处一行改动、交互收益最大）**：P0-7（target guard）、P1-6（isComposing）。
- [ ] **批次 7（文档与现实对齐）**：P0-8。`dragDropEnabled` 改回 `true` 并用 `onDragDropEvent()` 实现插入路径；或者同时改掉注释、README 与配置。**不能让文档描述一个不存在的功能。**
- [ ] **批次 8（用户已拍板的两条呈现改动）**：P1-16 + P1-17。两条都是一处渲染逻辑 + 一处常量 + 一处文案，且**必须同批改设计文档**（见下）。P1-17 顺带清掉 `.list-more` / `block.more` 两个孤儿。
- [ ] **批次 9（剩余 + 土壤）**：其余 P1 与 P2；并**同步设计文档与 `protocol/schema/outbound.schema.json`**（ui kind 7→8、event kind 11→14、context 容器的 `updated_at`、MCP 的 `failed`/`error`）。这一条排在最后，但它是前面一半问题的成因——文档落后于运行时时，前端只能靠记忆写。

---

## 需要同步修改的设计文档（P1-16 / P1-17）

这两条的成因**有一半在文档里**：文档把 TUI 的终端约束当成了桌面端的设计，前端照着抄。所以改代码时同步改文档，否则下一个人会照着改回去。

**文档与代码都已改完**（见"状态"列）——这两条随多会话那次改动一起落地了，因为它们正落在同一批文件里（`StatusBar.tsx` / `Sidebar.tsx` / `store.ts` / `i18n` / `styles`）。

| 文件 | 位置 | 原本写的 | 现在写的 | 状态 |
| --- | --- | --- | --- | --- |
| `desktop/tudouni-aigo-desktop-design/desktop-app.md` | §7.3 正文 | "内容有上限，装不下时**从底部丢弃并标 `(+N more)`**，不许静默截断" | 右栏**不设内容上限**，超出由滚动承接；并说明这与 TUI 的差别是"终端固定列 vs 桌面滚动容器"，不是审美。"不许静默截断"**保留**，约束对象变成"不许用 CSS 藏行" | ✅ 已改 |
| 同上 | §7.3 引用块 | "**决策 6：写死在前端常量（各区块 5 行）**" | 指明 `caps` 在协议里仍不存在，但结论是**"前端不造这个上限"**；原决策 6 作废，指向 §10 | ✅ 已改 |
| 同上 | §7.4 状态栏左段 | "阶段 + 当前动作或结算文案 + `step n / N`" | "……+ **对话累计 steps**"，加三条说明：只报累计不报上限、回合进度归回合头、上限事实在会话栏与设置面板 | ✅ 已改 |
| 同上 | §10 决策 6 | 原整行 | 整行标注**已作废**并写明新结论与新理由 | ✅ 已改 |
| 同上 | §10 开头 | "以下 12 条在评审中已拍板" | 补一句"**#6 已被后续的实际使用推翻**" | ✅ 已改 |
| 同上 | §5.3 对照表（`caps` 行） | "没有 `caps`（上限是前端呈现层的事，可由设计系统定）" | 追加提醒：没有 `caps` 的结论是"协议不管列表长度"，**不是**"前端自己定一个长度" | ✅ 已改 |
| 同上 | §11 第 5 条 | "上限常量按决策 6 落进设计系统" | "右栏不设内容上限（决策 6 已作废），因此**没有上限常量要落进设计系统**" | ✅ 已改 |
| `desktop/tudouni-aigo-desktop-design/multi-session-parallel.md` | 状态栏来源表 | `step n / N` ← `session.steps` / `session.maxSteps` | `steps`（累计，**不配上限**）← `session.steps`（全会话 `assistant` 消息数） | ✅ 已改 |
| 同上 | 表后说明段 | 只讲"两个函数必须一起加参数" | 追加一段解释为什么这一格不配上限（两个维度、`StepCount()` vs 每回合循环） | ✅ 已改 |
| `desktop/tudouni-aigo-desktop/README.md` | 决策表第 6 行 | "Block caps are a front-end constant (5 rows) \| `BLOCK_CAP` in `store.ts`" | "The right rail's blocks are **not capped**: every row is listed and the rail scrolls. The `(+N more)` footnote is gone"，Where 列换成 `Sidebar.tsx` + `.sidebar-inner` | ✅ 已改 |
| 同上 | 决策 15 之前 | （无） | 新增 `### 6 · Why the rail is not capped, and why step n / N is not a fraction`，把两条的成因（TUI 的固定列、`StepCount()` vs 每回合 `MaxSteps`）写在代码旁 | ✅ 已改 |
| 同上 | Verification 段 | 描述 `render-check.mjs` 覆盖的右栏断言 | ⚠️ **未做**：`render-check.mjs` 仍只喂 2 项 `todos`，没有"超过 5 项全部列出"的断言。这一条是**遗留项**（见下） | ⏳ 未做 |

另外两处**不是文档而是代码注释**，同样是"照错的前提写的"，已经随代码一起改掉：

- `src/state/store.ts`：`BLOCK_CAP` 常量连同它上方那段"Decision 6 / the protocol has no `caps`"的说明一起删除了。
- `src/components/sidebar/Sidebar.tsx`：文件头注释改成"**There is no content cap.**"，并写明这与 TUI 的差别（固定高列 vs 滚动容器）。

### 落地后仍遗留的一件小事

**`render-check.mjs` 没有为"不截断"补断言。** 现在右栏的行为靠的是"没有代码去截断"，而不是一条断言守着它——将来有人把 `slice(0, N)` 加回来，没有任何检查会红。补法：喂 8 项 `todos`，断言 8 行都在 DOM 里、且没有 `(+N more)` 文本。`/model` 那类面板的行数断言已有先例可抄。

另外 `'status.step'` 现在是**回合头专用**（`EntryView.tsx` 的 `entry.step / entry.maxSteps`），状态栏改用新加的 `'status.steps'`（不带分母）。两者不要再合并：合并回去就是把两个维度重新拼成一个分式。

---

## 附 A · 真实抓包（可直接做 fixture）

`<binary> --runtime-stdio --stream`，隔离空工作区，实测开场 9 行，顺序固定为：

```
init -> session_load -> ui/state -> ui/context
```

`init` 的键（实测）：

```
audit_path  context_tokens  effort  effort_levels  max_steps  model  model_catalog
notices  permissions  protocol  provider  resumed  session_id  stream  t  thinking
tools  v  workspace
```

两点值得注意：`init.notices` 的每一项带一个额外的 `stream` 字段（`"err"`/`"out"`，来自子进程 stderr），且实测其中一条是 21 行的 "Registered tools: …" 转储——首屏直接铺开会淹掉界面，建议按 code 折叠或只显示首行。`ui(tools)` 行字段：`command / disposition / external / granted / interactive / name / parallel_safe / risk`。

建议把这段抓包存成 `tests/fixtures/opening.jsonl`，作为附 B 的输入。

## 附 B · 建议新增的契约测试

目的：让"前端对协议的假设"必须由运行时原件背书，而不是由前端自己的类型背书。

- [ ] 新增 `tests/contract.test.ts`：逐行读 `tests/fixtures/opening.jsonl`，喂 `applyRuntimeMessage`，断言：
  - `context.used === 3791`、`context.limitTokens === 940032`、`context.window === 1048576`、`context.messages === 1`；
  - `init` 的 notices 在 `session_load` 之后仍然可见（P0-1 的回归测试）；
  - `tools` 在 `init` 之后即非空（P0-5 的回归测试）。

  fixture 一旦提交就冻结（上面这些数字来自那次抓包），所以测试不会随工作区变化而抖。协议升级时用附 A 的脚本重抓并人工 review diff，而不是让测试自动跟随。
- [ ] 补一组**"第二回合"用例**（P0-10 的回归测试，手写负载即可，因为它测的是判定规则而不是字段）：先喂一个完整的 `run_started → run_finished` 回合，再喂 `run_id: ""` 的 `event image_attached`（三种 status 各一条）、`event context_compacted`、`event goal_round` → 断言它们**都产生了行**，且 `dropped` 没有变化。
- [ ] 补 `refused` / `over_limit` 两种负载的断言（P1-13）：`refused` 用 `{status:'refused', names:['a.png'], model:'x'}` → 行文案里必须出现文件与模型；`over_limit` 用 `{status:'over_limit', limit:8, rest:3, paths:['b.png']}` → 行里必须出现 `b.png`。
- [ ] 补 `degraded` 断言（P1-14）：喂 `ui(context)` 后 `context.degraded === <个数>` 而不是 `null`。
- [ ] 抓包脚本落库：把这次用的探针（spawn 二进制 + dump 行）整理成 `scripts/capture-protocol.mjs`，升级运行时后重抓一次，与 fixture 做 diff——协议漂移会变成测试失败而不是线上白屏。
- [ ] `render-check.mjs` 改为按真实三元组喂 `init -> session_load -> ui(state)`，而不是只喂 `init`。
- [ ] 给 `useRuntime.ts` / `attachRuntime` / `pickWorkspace` 补失败路径测试（mock invoke 抛错，断言首屏显示错误而不是停在 Booting）。
