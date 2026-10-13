# Goal 与 Verification：可行性评估与设计取舍

这份文档回答两个问题：**以现在的代码，长任务用的 goal 能不能做**；以及**「goal」和「Verification Loop」是不是同一件事**。

结论先写在这里：

1. **能做**，而且不需要动现有架构，只在旁边加一层。缺的是 goal 状态机、跨轮驱动器、goal 工具三样东西，接入点已经全部存在。
2. **两者不是同一件事，但必须成对存在。** Goal 回答「还要不要继续」，Verification 回答「现在有没有资格结束」。它们各自单独都不完整：只有 goal，就是「多跑几轮然后仍然由模型自己宣布完成」；只有 verification，就是「每次都被要求拿证据，但没人规定这轮凭什么算完」。
3. **如果要抄 DSH，要清楚它抄不到什么**：DSH 的 goal 里**没有验证器**，它的「完成」仍然是模型自报，靠的是轮次预算、resume 后 disarm、blocker 连续轮阈值、revision 栅栏这些**机械的**约束，而不是证据门。它的系统提示词写了「gather evidence」，但那句话没有运行时权威。

---

## 一、现有代码已经提供了什么

| 需要的能力 | 已经在哪 | 为什么够用 |
| --- | --- | --- |
| 跨轮持久状态 | `internal/state/store.go` 的 `metadata` 记录 | 会话文件 append-only，`meta` 记录「读最后一条」。goal 放这里，重启、`/resume`、换进程都在 |
| 结构化成功标准能活过压缩 | `internal/context/compaction.go` 只改 `session.Metadata` 的 `context_compaction`，**一个字节都不动 `session.Messages`**，`goal` 与 `context_compaction` 平级 | 压缩折掉的是历史，不是状态。这与设计第九条「Evidence 必须是 State 的一部分」天然一致 |
| 状态变更的持久化时机 | `agent.Config.OnCheckpoint` → `Runtime.checkpoint`（`composition.go`），只在整步之间调用 | 与「一步写完再落盘」的不变量同一条约束，goal 变更挂在这里不会破坏它 |
| 每轮把状态送到模型眼前 | `Runtime.notes()`（`composition.go`）→ `agent.Payload()` 把 note 挂在 payload 尾部，**从不进 `session.Messages`** | goal 摘要、证据账本、契约都可以挂这里：每轮新鲜、不污染历史、不进压缩 |
| 已有的任务列表抽象 | `internal/tools/builtin/todo.go`（`TodoBoard` + `todo_write` + `Note()` + `ProgressLine()`） | 这是 goal 工具的现成模板：状态在 metadata、渲染走 payload 尾、人看的行与模型看的块分开 |
| 证据的原始素材 | `audit.JsonlSink` 与 `shell` 的 `Audit: {"exit_code": …}`（`internal/tools/builtin/shell.go`） | 命令、退出码、耗时、字符数**已经在记账**。verification 不必新造证据源，它只是给这些记录加上「属于哪个契约」的身份 |
| 异步证据采集 | `job_background` / `job_output`（`internal/tools/builtin/jobs.go`） | 长测试、build 这类慢证据本来就是后台任务，采集器复用它们，不用另写执行器 |
| 会话标识 | `Runtime.SessionIDValue`，已通过 `InitFields` 暴露给前端 | 工件目录、证据目录按 session 分家 |

**缺口只有四处**，而且都是加法：

- **goal 状态机**：`phase`（active/paused/blocked/complete）、`revision`、`rounds_started`、`max_goal_rounds`、`activation`（armed/disarmed）。现在完全没有。
- **跨轮驱动器**：`internal/protocol/server.go` 的 `startTurn` 只在收到 `InUserMessage` 时被调用。没有「agent 空闲 + goal active + 还有轮次 → 自己起一轮」的入口。
- **goal 工具**：`get_goal` / `create_goal` / `update_goal`。`builtin.Assembly.Extra` 和 `todo_write` 的写法已经把注册模式铺好了。
- **resume 语义**：`state.Session.Resumed` 已经有了，但「恢复后 active goal 一律 disarm，必须由人显式 resume」这条规则要我方实现。

工程量不小但**风险低**：约 700–1200 行，分三批落地（状态+工具 → 驱动器 → 前端命令与面板）。测试面按 AGENT.md 属于「新功能」，要跑全量。

---

## 二、DSH 是怎么做的（可直接对照的实现）

DSH 的 goal 是三个包拼起来的，职责切得很干净：

| 包 | 职责 |
| --- | --- |
| `dsh-goal` | 状态与生命周期：`phase ∈ {active, paused, blocked, complete}`、`revision`、`roundsStarted`、`maxGoalRounds`，纯函数 replay fold 从持久事件重建 |
| `dsh-tool-goal` | 模型侧的三个工具；`create/edit/pause/resume` **要求当前顶层轮次里存在人类直接消息**；`complete/blocked` 允许在自主轮里执行；`blocked` 有连续轮阈值（默认 3） |
| `dsh-goal-round-driver` | 调度：agent idle 时「先预留、后准入」下一个 round，排入一条保留的 `<goal_round>` 用户消息；进入步骤才消耗轮次；陈旧/竞争/取消的预留不消耗编号 |

几条关键语义，值得抄：

- **先预留，后准入。** 预留失败不消耗轮次编号，所以「因为人类插话而作废的一轮」不会计入预算。
- **agent/pre-step 竞态栅栏**：预留之后、该步真正进入之前重新核对整个已领取记录与当前 goal，陈旧或竞争的提示词在**进入步骤前**被拒。
- **resume / fork 后 disarm**：挂载驱动器不会自动复活任何 goal；人明确说「继续」才 `resume` 重新 armed。取消也永远不会自动重启轮次。
- **终止轮**：成功的自主 `complete` / `blocked` 会额外推一条结束指令，让模型在轮次结束前跟用户交代一句。
- **只有轮次预算**：`maxGoalRounds` 不计量 token、时间、钱。这是它的已知限制，明确写在文档里。

而 `<goal_round>` 提示词的内容就是这个功能对模型的全部权威：

```
Objective: "..."
Round: n/max
Continue working toward the objective in this same session. Treat the current workspace,
tool results, and durable session state as authoritative; inspect them instead of assuming
earlier narration is still current. Make concrete progress and verify the result. Before
claiming completion, gather evidence that the whole objective is achieved, read the current
goal, and mark it complete. ...
```

**注意最后一句。** 「gather evidence」是指令，不是门。DSH 的 goal driver 文档自己也承认：**没有独立评估器；面向模型的 goal 策略会判断证据是否足以完成**，评估器支持的认证仍在延期列表里。

所以：设计里那个「Runtime 决定是否有证据允许完成」的 Completion Gate，**DSH 没有**。这是设计想法比 DSH 更强的部分，也是更容易翻车的部分。

---

## 三、两件事的思想是否一致

**核心思想一致，层次不同，而且缺一不可。**

一致的那一句是共同的：

> 一个长期任务的「完成」，是运行时状态，不是模型的一句话。

不同在它落在哪一层：

| | Goal 层 | Verification 层 |
| --- | --- | --- |
| 问题 | 还要不要继续 | 现在有没有资格结束 |
| 状态 | `phase / revision / rounds / activation` | `contract / evidence / verified_revision` |
| 权威 | 运行时（预算、栅栏、disarm） | 运行时（门）或模型（自报） |
| 失败模式 | 早早收工，或永远不停 | 假完成，或永远不满足 |

**接口是同一个动作：`complete`。** Goal 层里 `complete` 是一个 phase 转换（停止续行）；Verification 层里它是一次门的判定（允许不允许）。设计把这两件事都指向了同一个动词，但它们可以被放在两个不同的地方：

- **Gate 在工具里**（DSH 风格 + 一道机械检查）：`update_goal(complete)` 先问门。门不过 → 工具返回「当前目标未被证明完成，缺：X、Y」→ 这句话作为工具结果回到 agent 循环。这就是设计第六条「验证结果必须回流到 Agent」的最小实现，**不需要新循环**。
- **Gate 在驱动器的终结轮**：轮次结束时由驱动器判定，不过就不 disarm。这个更重，也更容易把人锁在外面。

我建议前者。它符合现有代码的形状：工具是唯一能把结构化事实塞回上下文的地方，而 `tool_result` 已经是 agent 循环的一等公民。

---

## 四、验证层必须落成「可机械检查」的东西

设计里最有价值的三条：Evidence 而不是 Test Loop、证据绑定 revision、验证结果回流 Agent。这三条我都同意，而且都与现有代码相容：evidence 就是 audit 记录加上它们的退出码，绑定 revision 就是记下工作区指纹，回流就是工具结果。

但有一条必须说清楚，否则这东西会变成负资产：

**门的每一条要求，都必须能被机械判定，否则门就不是门，只是把模型的话抄了一遍。**

- 可判定：`command` + `exit_code` + 时间 + 工作区指纹吻合。这就是证据。
- 不可判定：「changed_behavior_verified」「no_known_unresolved_issue」。这两个只能由模型填布尔值。如果门接受模型的布尔值，它拦不住任何东西；如果门不认，它就永远不满足。

所以契约的形状应该是**混合的、并且把两半分开记账**：

```
verification_contract:
  required_evidence:
    - kind: command          # 机械判定
      command: "go test ./internal/agent/"
      expect_exit: 0
    - kind: command
      command: "go vet ./..."
      expect_exit: 0
    - kind: attestation      # 模型声明，带出处
      claim: "changed behavior verified by reading the diff of X"
      refs: ["internal/agent/agent.go:314"]
```

门对 `command` 类硬性判定；对 `attestation` 类只要求**存在且引用真实存在的证据**（文件存在、引用的 artifact 存在、引用的 revision 是当前的），然后**在结束报告里如实标为 unverified-by-runtime**。这是诚实的做法：机器能证明的说「证明」，机器不能证明的说「模型声明」。

### 五个必须一起做的取舍

否则这个门会以最难看的方式失败——「明明做完了，就是不让结束」。

1. **门要有尝试上限。** 连续 N 次（3 比较合理）判不通过就强制放行，并把这一轮标记为 `unverified`，在最终答复里明说。理由和「门」本身是一样的：门是判决，判决必须可执行完。
2. **逃生口必须显式。** 契约允许 `waive(reason)`，人可以在前端一键 waive，模型也可以（但会被记为 waive 而不是 pass）。
3. **blocker 用机械计数，不用模型自报。** DSH 用「同一条件连续 3 轮」这个规则，但判定权在模型手里。更好的做法是运行时记「连续 K 轮工作区指纹没变、且没有新的 evidence」——这才是「同一条件持续」的可判定版本。
4. **revision 不能是整树哈希。** 每轮扫全树对大仓库是灾难。用 `git rev-parse HEAD` + `git status --porcelain` 的哈希；非 git 工作区退化为「evidence 覆盖到的路径集合」的 mtime+size 指纹。够用，而且便宜。
5. **没有 goal 的时候门不许开。** 普通单轮对话不能被要求先建契约，否则日常使用立刻变难受。门只在存在 active goal 时生效。

---

## 五、和现有代码的对应关系

按设计的第十二节那张表，落到这个仓库上是：

```
internal/state/goal.go          新增  goal 状态机 + metadata 读写（照 model.go / compaction.go 的写法）
internal/tools/builtin/goal.go  新增  get_goal / create_goal / update_goal；登记进 builtin.Assembly.Extra
internal/runtime/composition.go 改动  NewGoalBoard(metadata)；Notes() 里追加 goal 段（接在 todo 之后、jobs 之前）
internal/runtime/goal_driver.go 新增  「空闲 → 预留 → 排一轮 goal_round」的状态机
internal/protocol/server.go     改动  startTurn 的来源标注；轮次结束后查驱动器；新增 InGoal* 消息与 UIGoal 状态
internal/audit/jsonl.go         改动  新增 KindGoalChanged / KindEvidenceCollected / KindCompletionGate
prompts/system.zh.md            改动  补一段「有 goal 时怎么读契约、怎么报完成」
internal/frontends/*            改动  /goal 命令与面板（可选，后置）
```

后端到前端的路径也现成：`Runtime.OnEventHook` 已经在把每条 audit 记录转给协议服务器，goal 变更天然可观测、可回放。`session.metadata` 的 append 语义还白送一条「何时改过 goal」的审计轨迹。

---

## 六、分三批落地的建议

**第一批（先做，价值最高、风险最低）：状态 + 工具，先不做门。**

- goal 状态机 + metadata 持久化 + `get_goal` / `create_goal` / `update_goal`。
- `create/edit/pause/resume` 要求人类直接消息（这一点 DSH 做对了，抄它）；resume 后 disarm。
- payload 尾部的 goal 块。
- 验收标准：一次会话里模型能建 goal、能跨轮记住它、能主动标 complete；`/resume` 之后不会自己跑起来。

这一批做完，「LLM + Tools」就已经变成有状态的长任务运行时了。**而且它不引入任何新的失败模式。**

**第二批：驱动器。**

- 空闲判定、预留/准入、轮次预算、取消即 disarm、blocker 连续轮计数。
- 这一批的风险全在竞态（人类插话 vs 预留）与「用户以为自己按了 Ctrl+C 结果又跑了一轮」。DSH 的 `agent/pre-step` 栅栏就是为这个存在的，要做等价物。
- 验收标准：预留在人类插话后作废且不消耗轮次；`interrupt` 之后不再自动起轮。

**第三批：证据与门。**

- `verification_contract` + `requirement` 的机械判定 + revision 绑定 + 尝试上限 + 逃生口。
- 这一批**必须在第一、二批跑一段时间之后再上**，因为它的参数（什么算够、上限几次、waive 怎么记）只能从真实使用里来。
- 上之前先立一个可证伪的指标：同一批长任务在「门前/门后」的**假完成率**和**产出一致性**。没有这个数字，这个门加进去只是在增加摩擦——而增加摩擦的系统会被关掉，然后什么也没留下。

---

## 八、第一批的落地记录（3.14.0）

已实现，与上面的设计一致：

| 文件 | 内容 |
| --- | --- |
| `internal/state/goal.go` | goal 块（`phase`/`revision`/`rounds`/`max_rounds`/blocker）、`LoadGoal`/`SaveGoal`/`FoldGoal`、`CreateGoal`/`ApplyGoalChange`/`AdmitGoalRound`、`AuthorizedBy`、`GoalText`/`GoalRoundPrompt`、`GoalError` 稳定错误码 |
| `internal/tools/builtin/goal.go` | `get_goal` / `create_goal` / `update_goal`，各自的 schema、拒绝文本与 audit 字段 |
| `internal/state/session.go` | `IsHumanTurn()` —— 区分「用户发起的轮次」与「自动续行」 |
| `internal/runtime/composition.go` | 注册三个工具；goal 段进入 payload 尾部（在任务列表之前）；`activation()` 里写死「resume 后一律 disarmed」 |

### 这批实际定下来的四条不变量

1. **`rounds` 只能由 `AdmitGoalRound` 推进**，任何工具参数都碰不到它；`rounds > max_rounds` 的块在读取时被拒绝（宁可退化成「没有 goal」，也不接受自相矛盾的状态）。
2. **准入会推进 `revision`。** 这是预留能被安全持有的原因：在「驱动器决定排队」和「提示词进入历史」之间发生的任何变更，都会让预留失效而不是被它覆盖。
3. **`activation` 不进 goal 块。** 它是进程内授权，`Resumed` 恒为 disarmed。测试 `TestActivationIsNotInTheStoredBlock` 与 `TestAResumedSessionIsNeverArmed` 把这条钉住。
4. **自动续行不能自我授权。** goal round 提示词同时带 `RuntimeNoteKey` 与 `GoalRoundKey`：前者让 `UserInputs()` 不把它当人话，后者让 `IsHumanTurn()` 判定为非人类轮次，于是 `create/edit/pause/resume` 在续行里一律被拒。

### 与本文档正文的一处偏差

正文第五节说「Lint 与激活状态分离，`activation` 是活的观察值」——这一点实现了；但**没有任何东西会 arm**。`Runtime.goalActivated` 是一个没有写入者的字段，`activation()` 因此恒为 `disarmed`，payload 尾部每轮都会告诉模型「续行未启用」。这是诚实的：这批构建确实不能自己继续，模型不该以为它会。

### 第二批要改动的确切位置

- `protocol/server.go` 的 `runTurn`：在 `Send(UIRunFinished)` 与最后一次 `Send(stateMessage)` 之后、`close(done)` 之前，是唯一「上一轮已落盘、下一轮未开始」的点，驱动器挂这里。
- `startTurn` 需要能标注「这一轮是自动续行」，并让 `agent.Run` 走一个会追加 `state.GoalRoundPrompt(...)` 的分支（而不是把文本当用户输入追加）。
- `Runtime.goalActivated` 与 `activation()` 已经准备好：`/goal resume` 与驱动器的 arm 路径只需要写入它。
- 轮次提示词的形状已经定死（`state.GoalRoundPrompt`），所以第二批不用回头改历史解析。

---

## 九、第二批的落地记录（3.15.0）

驱动器接通了。范围按上一节收敛为三件事：**空闲判定、预留/准入、取消即 disarm**；blocker 连续轮计数与 UI 命令留到下一批。

| 文件 | 内容 |
| --- | --- |
| `internal/runtime/goal_driver.go` | `Driver`：`Observe` / `reserve` / `Admit` / `advance`，`Decision` 与稳定的 `Reason*` 码，`Runtime.ObserveTurn` 适配器 |
| `internal/runtime/goal_round.go` | `GoalArmed` / `SetGoalArmed` / `StartGoalRound` / `Checkpoint`，以及 `ErrGoalNotArmed` |
| `internal/protocol/server.go` | `GoalRound` / `GoalRoundRunner` / `GoalRoundScheduler` 三个可选接口；`startGoalTurn`；`finishTurn` 与 `reservedGoalRound` |
| `internal/agent/agent.go` | `RunMessages`：`Run` 与自动续行共用同一条装配路径 |
| `internal/audit/jsonl.go` | `KindGoalRound`：排队、开始、拒绝/解除武装各一条 |

### 这批定下来的五条不变量

1. **只有一个瞬时点可以决定续行。** 就是 `finishTurn` 里那一次调用：答案已发出、会话已落盘、消息列表一致、没有别的轮次在跑。没有 ticker，没有第二个 goroutine。
2. **预留不消费，准入才消费。** `reserve()` 只在内存里占号；`AdmitGoalRound` 是唯一推进 `rounds` 的地方，且它会同时推进 `revision` —— 因此在「决定排队」与「提示词进入历史」之间发生的任何变更都会让预留失效。拒绝的预留不消耗编号。
3. **`StepLimitExceeded` 是「继续」，其余错误是「停手」。** 步数用尽表示这一轮的步数预算花完了、会话完整；把续行建立在「轮次预算」上的长任务，第一轮撞上步数上限就会死。这个判断必须**在 disarm 之前**做（第一版写反了，被测试抓住）。
4. **取消即解除武装。** 用服务器自己的 stop 标志判断「这一轮期间有没有人要求停」——它在每轮开始被清空，正好能回答这个问题。停轮次但保留武装，等于 Ctrl+C 不起作用。
5. **resume 后无法武装。** `SetGoalArmed(true)` 在 `Resumed` 上直接失败（不报错，就是不生效），所以每个读者——工具、payload 尾、驱动器——看到的是同一个 false。

### 一个必须绕开的死锁

排队回调运行在**已结束那一轮自己的 goroutine** 里，而那一轮的完成信号是 `close(turnDone)`，它发生在 `runTurn` 返回之后。所以从回调里直接调回 `startTurn` 会等待一个自己负责关闭的 channel：会话挂在那里，目标续了一轮但没有任何东西跑起来。实现改为：决定同步做，排队交给一个先 `<-turnDone` 再启动的 goroutine。`TestAnAutomaticRoundRunsAfterTheTurnSettles` 就是为这个写的，它会在顺序写错时挂住。

### 这批仍然没有的东西

- **没有 UI 命令。** `/goal` 与 `/goal resume` 未实现，所以目前武装一个 goal 的唯一路径是测试。第三批之前要先补上，否则这个功能对人不可用。
- **blocker 连续轮计数未做。** 现在 `blocked` 完全由模型调用 `update_goal` 决定。
- **CLI 路径不续行。** `internal/frontends/cli/cli.go` 自己循环调 `RunTurn`，不经过协议服务器，所以那个入口不会自动续行；它也不因此变坏，只是不续。

---

## 十、第三批的落地记录（4.0.0）：让 agent 自己设置 goal

这一批的起点是一个观察：**在 DSH 里 goal 是 agent 自己建的**，用户从没打过任何命令。去实现里确证，DSH 的系统提示词写的是：

> "create_goal **may infer goal intent from a direct human request in any language**; do not create a goal for routine single-turn work. … After session resume or fork, an active goal is disarmed: **when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it**."

「人直接发起」是**权限闸门**，不是**触发器**。对照下来，第二版实现有两处偏差让它实际上做不到：

1. **工具描述写保守了**：我写的是「只在用户**明确要求**长期任务时才用」，DSH 是「**可以推断**」。措辞把「推断」降级成了「等指令」。
2. **武装路径被堵死**：`goalActivated` 恒为 false、没有写入者，我原计划等 `/goal resume`。于是就算模型建了 goal，它也永远不会续行 —— 机制允许，下游关着。

### 这一批改了什么

| 文件 | 内容 |
| --- | --- |
| `internal/runtime/goal_round.go` | `ArmFromTurn`（人发起的轮次结束时武装）、`GoalCommand`（人的 pause/resume/clear）、`GoalPanel` |
| `internal/state/goal.go` | `GoalAction`、`GoalSnapshot`、`NoGoalSnapshot`、`GoalAction*` 常量 |
| `internal/protocol/server.go` | `InGoal` 的处理、`GoalArmer` / `GoalCommander` 两个可选接口、`finishTurn` 里**先武装后问驱动器** |
| `internal/protocol/{messages,client}.go` | `InGoal`、`GoalPause/Resume/Clear`、`Client.Goal` |
| `internal/tools/builtin/goal.go` | `create_goal` 的描述改成 DSH 的语义：可推断、不要为单步琐事建 |
| `prompts/system.zh.md` | 新增「长期目标（goal）」一节（DSH 是把这段注册进系统提示词的，我照做） |
| `internal/runtime/composition.go` | `GoalLine`、goal 进 `StateMessage`、CLI 每轮回显 |
| `internal/frontends/tui/` | `/goal` 命令、rail 的 Goal 块、`panelstate.goal` |

### 定下来的三条

1. **创建与武装是两件事，而且分在两个包。** 工具层负责把 goal 写下来；「这个会话要不要继续」是本进程的决定，只在 `finishTurn` 里做一次，条件是**整个轮次已结束 + goal 是 active + 这一轮是人发起的**。模型不能在自己的轮次里武装自己 —— 否则它在决定自己跑多久，轮次预算就不再约束任何东西。
2. **一次授权产生一轮。** 刚跑完的如果是一轮自动续行，驱动器就 disarm 而不是再排一轮；再要继续需要用户再说一句话，或者模型在人的轮次里 `update_goal(resume)`。没有这条，一次武装会连着把预算跑完而没人在场。

   这一条是我第一版写反的：我原来判的是「如果是人发起的轮次就停」，正好把方向搞反了——那会让**人在场时反而不许继续**，功能等于不存在。测试 `TestADriverContinuesAfterAHumanTurn` 与 `TestADriverDoesNotChainAutomaticRounds` 现在把两个方向都钉住。

3. **`armed` 与 `phase` 必须在两个地方分开出现**：payload 尾（`GoalText`）与面板（`GoalSnapshot`）。一个 active 的 goal 可以是不续行的（resume 之后、预算用尽之后），只报 phase 会让人等一个永远不会开始的工作。

### 仍然没有的东西

- **blocker 连续轮计数**：`blocked` 仍完全由模型决定。
- **CLI 路径不续行**：`cli.go` 自己循环，不经过协议服务器；它现在会每轮回显 goal 一行，但不会自动续。
- **没有验证层**：第三批之后，「完成」仍然是模型自报加提示词约束，和 DSH 一样。证据门（本文档第三、四节）还没做，而且按正文建议，应该在真实使用一段时间、有了可证伪的指标之后再上。

---

## 七、一句话结论

设计里最核心的那句判断是对的，而且比 DSH 现在的实现更完整：

> 把任务完成定义成一个需要证据证明的状态，而不是 LLM 自己宣布的状态；验证失败时，验证结果重新进入 Agent Loop。

但要同时接受它带来的责任：**门一旦有权威，它就必须可判定、可执行完、可退出**。DSH 选择把这三件事都交给提示词，所以它简单、不会卡住人，代价是「完成」的质量完全取决于模型当天的自觉。设计想要的那一层更强，但它需要在「可判定性」上做真正的工程，而不是多写一段 prompt。

Goal 和 Verification 不是同一个功能，是同一句话的两半。**先做 goal（它是骨架），门后做（它是肌肉）。**
