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

## 七、一句话结论

设计里最核心的那句判断是对的，而且比 DSH 现在的实现更完整：

> 把任务完成定义成一个需要证据证明的状态，而不是 LLM 自己宣布的状态；验证失败时，验证结果重新进入 Agent Loop。

但要同时接受它带来的责任：**门一旦有权威，它就必须可判定、可执行完、可退出**。DSH 选择把这三件事都交给提示词，所以它简单、不会卡住人，代价是「完成」的质量完全取决于模型当天的自觉。设计想要的那一层更强，但它需要在「可判定性」上做真正的工程，而不是多写一段 prompt。

Goal 和 Verification 不是同一个功能，是同一句话的两半。**先做 goal（它是骨架），门后做（它是肌肉）。**
