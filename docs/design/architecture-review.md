# Go Runtime 核心架构评审与处置记录

> 记录时间：2026-10-23 · 范围：`cmd/`、`internal/`（Go 运行时）
> 评审对象 HEAD：`82a8cf2`
> 处置后版本：6.21.1

这份文件记录一次对 Go 运行时核心架构的评审，以及**哪些结论被采纳、哪些没有**。
它不是待办清单：下面的表格说明了每一项今天是"已做"、"部分已做"还是"有意不做"。

评审的整体判断是：**分层方向对，边界是半成品**。值得保留的部分（追加写 + watermark
的审计与状态存储、工具产物的单一写入者 `context.ToolResultProcessor`、显式的权限闸门
`security.Check` + `Channels.AskerFactory`、与主循环解耦的重试分类、`sync.RWMutex`
正确的工具注册表、贯穿到 HTTP 和工具执行的取消上下文）没有动。

---

## 一、处置总表

| 编号 | 结论 | 处置 |
| --- | --- | --- |
| 2.1 | 读循环与 turn goroutine 并发改同一份会话状态 | **部分已做**：`Session`/`SessionModel`/`Meta` 三处加锁与快照化，见 §二 |
| 2.2 | 后台 goroutine 跨会话使用已 `Close()` 的 runtime | **未做**，见 §五 |
| 2.3 | 停止打不断审批等待 | **已做**，见 §三 |
| 2.4 | `err.(interface{ Error() string })` 死断言 | **已做**，见 §三 |
| 3.1 | `Runtime` 是 god object | **部分已做**：加了编译期契约断言，字段未拆 |
| 3.2 | `OpenRuntime` 补偿清理散落 | **已做**：改成 defer 回滚，见 §四 |
| 3.3 | `protocol.Server` 是 1860 行的五个东西 | **已做**：按职责拆成四个文件，见 §四 |
| 3.4 | `ClearStop` / `MarkStop` 死抽象 | **已做**，见 §三 |
| 3.5 | `preview` / 上下文估算 O(n²) | **已做**：三处热点全部改增量，见 §六 |
| 4 | 进程级全局可变状态 / 错误被静默吞掉 | **未做**，见 §五 |
| 4 | 没有编译期契约断言 | **已做**：`internal/runtime/contract.go` |
| 5 | 性能清单第 4、5 项 | **部分已做**：ASCII 快路径做了，`agent.go` 未拆文件 |

**没有做的那一部分不是被否掉了**，而是这一轮的范围只到"不改外部行为"的那几项。
§五把剩下的工作写清楚了，包括为什么它们各自需要单独一轮。

---

## 二、P0 并发的实际处置

### 2.1 命令与 turn 之间没有统一的串行化边界

评审的原话是根因不在漏了几个 `joinTurn`，而在缺少"命令串行化"这一层，并建议引入
`SessionExecutor`。**这一轮没有引入它**，而是做了边界内的收口：

- `state.Session` 的 `Messages` / `Metadata` / `Context` 三个字段加 `sync.RWMutex`，
  读侧走 `MessagesSnapshot` / `MessageCount` / `Meta().Read` / `ContextHandle`，
  写侧走 `Append` / `SetContext` / `Meta().Write`。
- `state.SessionModel` 的 `selection` / `effortChosen` 加锁，并且**通过 session 自己的
  那把锁**读写 metadata（`NewSessionModelFor(meta, ...)`），而不是另起一把 —— 两把锁保护
  同一张 map 就是两个真相。
- `model.OpenAICompatible` 的 `route` / `thinking` / `effort` 加锁，`Complete` 每次尝试
  **成对**读取（`snapshot()`），所以一次 `/model` 落在两次尝试之间会得到一个完整的新路由，
  而不是半个。
- `Runtime.McpCfg` 加 `cfgMu`，`/mcp load` 与 `ui(state)` 不再抢同一张切片。

`Meta` 这个手柄值得单独说一句：它持的是**指针**而不是 map 引用，因为一次 session load
会整张换掉 map，存下来的引用就是一个守着已经被扔掉的那张 map 的锁。

**这一层是"让并发不崩"，不是"让并发可推理"。** 评审说的那句"现在每个 handler 自己决定
要不要等 turn，等于把并发正确性交给 30 个分散的调用点去维护"仍然成立。

### 2.1 遗留的一处

`Runtime` 仍然有 35+ 个导出字段，`internal/runtime` 内部任何文件都能随手改任意状态。
加锁把"改"变成了安全的，但没有把"能不能改"变成可检查的。

---

## 三、阶段 1（低风险、修真实 bug）

### 3.1 Ctrl+C 卡在审批面板

`pendingTable.wait` 现在接收 `ctx` 并 `select` 在 `entry.done` 与 `ctx.Done()` 上；取消路径
用 `drop` 把 waiter 从表里摘掉，这样前端迟到的回答会被忽略而不是唤醒一个已经走开的 turn。

`requestStop` 在 cancel 之后**主动** `abandonAll()`：一个停在审批上的 turn 等的不是上下文，
它等的是 `pending`。

### 3.2 死抽象

`Runtime.ClearStop()` / `Runtime.MarkStop()` 两个空函数删除，连同 `requestStop` 里那个
`runtime.(interface{ MarkStop() })` 断言——它恒命中且什么都不做。原来那句"the runtime owns
the flag the agent actually reads"是错的，flag 一直在 `Server.stop`。

### 3.3 死代码

`finishTurn` 里 `err.(interface{ Error() string })` 恒为 true（所有 error 都实现 `Error()`），
断言无作用，简化为 `isCancel(err)`。

### 3.4 三个只写不读的字段

`s.answer`、`s.serving`、`s.sessionFilterSet` 删除。

---

## 四、阶段 5（纯搬移）

### 4.1 `protocol.Server` 拆文件

`internal/protocol/server.go` 从 1846 行降到 906 行，按职责切出三个同包文件：

| 文件 | 内容 |
| --- | --- |
| `server.go` | 传输循环、`Dispatch`、`Runtime` 接口与能力接口、`Send`、`emitOpening`、事件转发 |
| `server_turn.go` | `startTurn` / `joinTurn` / `runTurn` / `finishTurn` / `requestStop` / `ShouldStop` |
| `server_session.go` | `sessionList` / `sendSessions` / `archiveSession` |
| `server_features.go` | 模型开关 / compact / goal / MCP / 会话切换、删除、fork / `resetTurnState` |

切分是逐字搬移，行为零改动；每个文件头写了这一块**为什么**在一起（例如 turn 文件的两条
不变量：turn 从不重叠、停止有两半）。

### 4.2 `OpenRuntime` 的补偿清理

原来 5 处 `jobs.Close()` 散落在错误分支里。改成：

```go
assembled := false
defer func() {
    if assembled {
        return
    }
    if err := jobs.Close(); err != nil { warn(...) }
}()
```

`assembled` 是必需的：deferred 函数分不清"返回了一个 runtime"和"返回了一个 error"，
关掉一个正在用的 board 会破坏刚建好的 session。

**没做到评审建议的完整 builder。** 剩下的资源（`chat`、`registry`、`ctxManager`）在失败时
本来就不持有需要显式释放的东西 —— `chat` 是内存对象，`registry` 里的 jobs 是唯一带目录的，
`ctxManager` 的 store 是懒打开的。所以这一轮只把**唯一真的需要补偿**的那一个收进了 defer。
真要拆成 builder，得先有第二个带生命周期的资源，否则只是把一个函数拆成六个函数。

### 4.3 编译期契约

新增 `internal/runtime/contract.go`，`var _ protocol.X = (*Runtime)(nil)` 覆盖 11 个能力
接口加一个匿名断言。

**这是普通源文件而不是 `_test.go`**：断言要在发出去的二进制里成立。放在测试文件里只有
跑这个包的测试时才检查，而那恰恰不是协议改动会破坏 runtime 的时刻。

---

## 五、明确没做的

### 5.1 `SessionExecutor`（评审 6.1 / 阶段 3）

评审说这是唯一**必须做**的结构性改动。这一轮没做，理由是它同时改外部行为（命令的到达时机）
和内部结构，和"阶段 1、2、6、5 不改外部行为"的前提冲突，需要单独一轮。做完之后应该能删掉
现在散在 9 个调用点的 `joinTurn`。

### 5.2 后台任务的 session token（阶段 4）

`startCompact` 和 `handleMCP` 仍然捕获 `runtime` 变量后起 goroutine，`joinTurn` 只保证
"捕获那一刻的 turn"结束了，不保证这个 runtime 还是 current。`runCodeIntelBuild` 仍然用
`context.Background()`，不可取消。

### 5.3 进程级全局可变状态（评审 §四）

`agent.reportToStderrHook` + `SetStderrSink`、`protocol.openFailureNotice`、
`model.unsupportedOpts` / `unsupportedThink` / `replayReasoning`、`security` 的命令参数
注册表、`paths.WorkspaceDir()` 直接 `os.Getwd()`。这些应该注入。`paths` 尤其明显：一个
"路径解析"包读进程 cwd，等于把可测试性交给调用顺序。

### 5.4 错误被静默吞掉

`Agent.emit` 和 `reportToObserver` 用 `recover()` 兜住 panic 后什么也不做。审计读写失败的
错误在 `StatsLine` / `StatusMessage` 里仍然丢弃 —— **但这一轮改了丢弃的位置**：现在由
`JsonlSink.Summary` 统一处理，将来要报错只需要改一个地方。

### 5.5 `Runtime` / `Agent` 的拆分（评审 6.2 / 6.4 / 6.6）

`Turn` 结构没提出来，`agent.go` 仍然 1500 行，wire 载荷仍然在 `runtime/protocol_ui.go` 里
拼装，所以 `internal/runtime` 仍然 import `internal/protocol`。

**6.4（把 wire 载荷移出 runtime）值得优先做**：它是唯一一条能把依赖方向恢复成单向的改动，
而且做完之后 `runtime` 就不再需要 import `protocol` —— 现在这个 import 是评审开头说的
"适配层不是叶子"的直接证据。

---

## 六、阶段 6（性能，按性价比）

### 6.1 `FixedPayloadTokens` 的 O(n²)

原来每步遍历完整历史。现在每一条消息的成本在**第一次渲染时**算一次，和渲染结果一起缓存在
`agent.cache` 里（`internal/agent/cache.go`）：

- key 是 `(消息数, fold 边界, summary 标识, ledger fingerprint, vision 闸门, 有没有 renderer)`；
- 追加消息只渲染新尾，不重算前缀；
- **标定系数在最后应用**，不进缓存 —— 它每步都在变（每次响应回来都重新学），折进缓存的
  数字里会让每步都变成 miss。

`ledger fingerprint` 而不是 ledger version：version 对不进入 payload 的改动也会跳，用它做 key
会白扔缓存。

### 6.2 渲染整个 payload 的历史

和 6.1 同源，同一个缓存解决：`cachedRender` 返回已经渲染好的消息，`Payload` 只拷贝一次
slice 头。**`capacity == length`** 是刻意的，这样追加尾注时 Go 会复制而不是写进缓存下一次
要复用的那个槽位。

### 6.3 审计日志整文件重读

`JsonlSink.Read` 改成增量（上一轮已经落地），这一轮把**派生视图**也做成增量：

- `readCache.add` 是记录进入缓存的唯一入口，同时喂 `state.Counter`（`/status` 的账本）、
  `timingCounts`（最近一轮的墙钟分解）、以及 `run_id` / `run_ms` 的配对；
- `JsonlSink.Summary` / `LastTurnMs` 直接读折叠结果，不再回放整个会话；
- `state.Summarize` / `audit.SummarizeTime` 改成对 `Counter` / `timingCounts` 的薄封装 ——
  **一份实现两个入口**，这才是"状态栏和 `--audit` 不会不一致"的真正保证，而不是两次独立的
  求和碰巧相等。

`hasFinish` 是单独一位而不是"`runMs == 0`"：一轮跑完用了 0ms 和一轮根本没跑完是两件事，
只有前者可以报成一个时长。这一条有测试（`TestATruncatedLogDropsTheDerivedState` 与
`TestTheIncrementalLastTurnPairsByRunID`）。

### 6.4 `preview` / `firstN` 无条件转 `[]rune`

`clipRunes` 加 ASCII 快路径：前 `limit` 个字节都是 ASCII 时，rune 数就是字节数，切片即可。
非 ASCII 仍然走 rune 遍历 —— 那本来就是必须的。

### 6.5 `agent.go` 拆文件

**没做。** 工具批处理、权限、审计格式化、image 消息构造仍然在一个文件里。

---

## 七、这一轮的验证

- `go build ./...` PASS
- `go vet ./...` PASS
- `go test ./...` 除 `internal/mcp` 外全 PASS。`internal/mcp` 的
  `exit status 0xffffffff` 是**已知的沙箱 runner 现象**（`go test -c` 编译后直接运行是
  PASS），在本次改动之前的基线上同样复现，与本次改动无关。
- `-race` **未运行**：本机没有 64 位 gcc，`CGO_ENABLED=1` 下无法构建 race 版本的测试二进制。
  要补这一项需要有 cgo 工具链的机器。

### 新增的测试

| 测试 | 钉住什么 |
| --- | --- |
| `agent/cache_test.go`（5 条） | 缓存命中的结果等于冷渲染；降级/驱逐会让缓存失效；每条消息只算一次成本；标定系数作用于缓存成本 |
| `audit/jsonl_summary_test.go`（3 条） | 增量摘要等于单次遍历；未完成的轮不报上一轮的时长；日志被截断时派生状态归零 |

`agent/vision_test.go` 里那条原地改历史的测试补了 `dropCache()` 调用，并在注释里说明：
生产代码从不原地改写历史（消息是 append 之前写一次），这个调用是给"确实改写了"的调用方
准备的。

---

## 八、如果继续做，建议的顺序

| 顺序 | 内容 | 为什么排在这里 |
| --- | --- | --- |
| 1 | 6.4：wire 载荷移出 `runtime` | 唯一能把依赖方向恢复成单向的改动，做完 `runtime` 就不再 import `protocol` |
| 2 | 2.2 / 阶段 4：后台任务持 session token | 跨会话泄漏是真实缺陷，改动面比 SessionExecutor 小 |
| 3 | 阶段 3：`SessionExecutor` | 根治 P0，但改外部行为，要单独一轮 |
| 4 | 6.2 / 6.6：`Turn` 提出、`Agent` 拆文件、`Runtime` 收窄 | 纯结构，收益是"并发正确性可以在局部推理" |
| 5 | §五的全局状态注入 | 阻碍测试与多 runtime 隔离，但没有已知的用户可见缺陷 |
