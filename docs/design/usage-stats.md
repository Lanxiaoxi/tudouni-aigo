# 用量与信息统计（`/stats`）设计

**状态**：草案，未实现。
**范围**：桌面端新增「用量与信息统计」面板；运行时新增一条按需的汇总消息。
**不在范围**：跨机器/跨工作区总账、计费对账、把统计写回 session 文件。

---

## 1. 一句话

统计不是新造一套计量，而是**把审计日志的只读汇总换一种呈现**：运行时已经在
`internal/state/status.go` 的 `Summarize` 里做了单会话汇总，`/status`、`--audit`
和状态栏读的是同一份账。本模块把这份账从「一个会话」扩到「一个工作区 + 按天 + 按模型 +
按工具」，并明确**哪些数字是测量、哪些是估算、哪些有口径缺口**。

---

## 2. 事实基础

| 来源 | 位置 | 能回答什么 | 坑 |
| --- | --- | --- | --- |
| 审计日志 | `<配置目录>/logs/<session_id>.jsonl` | 每个 `model_call` 的 prompt/cached/miss/completion/duration_ms；每个 `tool_result` 的 tool/status/chars/duration_ms/exit_code；`run_started`/`run_finished`；`permission.waited_ms`；`context_compacted`；`delegation_finished.usage` | `ts` 是 `2006-01-02T15:04:05.000`，**本地时间、没有时区**；半行是设计内的情况；`model_call` **没有 provider** |
| `state.Summarize` | `internal/state/status.go` | usage / counters / last_prompt_tokens；失败重试不计 token | 只做单会话；不按天、不按模型、不按工具 |
| `ui(status)` | `internal/runtime/composition.go` | 同一份 `Summarize` 的结果 + `timing` + `context` + `meta` | 读审计日志，**不能变成心跳** |
| `model_call` 事件 | 协议流 | 上一次成功调用的四个 token 字段 + duration | 只覆盖本窗口看见的调用 |
| `sessions` 列表 | 协议 | messages / steps / todos / preview / modified_at / archived | **不含 token** |
| 子代理 | `internal/subagent/spawn.go` | 子代理是**独立 session、独立日志**；父日志的 `delegation_finished.usage` 带 prompt/cached/completion/model_calls/tool_calls | 直接扫 `logs/*.jsonl` 会把子代理算两遍；且 `usage` 里**没有 miss / model_ms** |

**结论**：跨历史会话、按天、按工具的完整统计，只有运行时能答；前端自己按 `model_call`
累加只能覆盖本窗口活着且被看见的调用。

---

## 3. 口径（先定，再写代码）

### 3.1 会话、子代理、工作区

- **会话自身（self）**：该会话日志里 `status == "ok"` 的 `model_call` 之和。
- **会话委派（delegated）**：该会话日志里 `delegation_finished.usage` 之和。
- **会话合计（total）**：`self + delegated`。
- **工作区合计**：所有**顶层会话**的 `total` 之和。

**禁止直接扫 `logs/*.jsonl` 求和**：子代理的 token 已经通过 `delegation_finished.usage`
进了父会话的日志，子代理自己的日志也在同一个目录里。实现必须先建立「子会话 id 集合」
（父日志里的 `delegation_finished.subagent_id` / `subagent_started.subagent_id`），再把子日志
从顶层列表里排除；父日志缺失、只剩子日志的孤儿，单独归入 `orphan` 组并显示出来——
**不静默丢弃，也不并进任何会话**。

### 3.2 token 的分类

沿用 `internal/model.TokenUsage` 的定义，不在前端重算：

- `prompt` = 输入总量（含缓存命中的部分）
- `cached` = prompt 中被缓存服务的部分
- `miss` = `prompt - cached`（运行时已算，日志里也有）
- `completion` = 输出

`prompt == 0` 时命中率是 **`—` 而不是 `0%`**：没有发生过缓存查询，和缓存坏了是两件事。
失败重试、只有工具调用的步骤、没上报 usage 的调用，都**不贡献 token**，也不贡献速率。

### 3.3 按模型

`model_call` 只有 `model`，没有 `provider`。归属规则：

1. 取该记录之前**最近一条** `run_started` 的 `provider`；
2. 一条都没有时，provider 记为 `unknown`（显示为「未知路由」），**不猜**。

同一 `provider/model` 在计费上可能不同价，所以这个字段是成本估算的前提，不能合并成
单纯的 model 名。

### 3.4 按天

按记录自己的 `ts` 前 10 个字符（`YYYY-MM-DD`）分桶。它是本地时间，所以这就是用户
日历上的那一天；不要用 `modified_at` 或 `Date.now()` 去反推。

### 3.5 成本（可选，P3）

运行时**永远不报钱**，只报 token。桌面端按本地价表估算：

```
cost = miss/1e6 * input + cached/1e6 * cache_read + completion/1e6 * output
```

- 价表按 `provider/model` 键，放在桌面端偏好（`aigo.prefs`）或一个可编辑的 JSON 文件里；
- 缺价 → **不显示金额**，不是显示 0；
- 金额旁必须标 `est.` / 「估算」；
- 当前计数器分不出「缓存写入」和「缓存读取」，如果某家 provider 单独计写入费，
  这个估算是**下界**，必须在提示里说清楚。

### 3.6 零、缺失、不可测

沿用仓库既有规则：**没有测量就不画 0**。

| 情况 | 显示 |
| --- | --- |
| 没有成功调用 | `—`，不是 `0 tok/s` |
| 窗口未知 | 只报用量，不报百分比 |
| 日志读不到 / 半行 | 跳过该条；整份读不到时该会话标「无记录」，不参与合计 |
| 价表缺该模型 | 只显示 token，不显示金额 |

---

## 4. 协议

沿用「按需请求、绝不轮询」的既有约束（`status` 就是这么做的）。

### 4.1 入站

```json
{"v":1,"t":"stats","scope":"session"}
{"v":1,"t":"stats","scope":"workspace","days":30}
```

- `scope` 缺省 `session`，只读当前连接对应的会话；
- `workspace` 由当前子进程代答（日志目录是共享的，任何一个子进程都能读）；
- `days` 只影响 `by_day` 的截断，缺省 30，上限由运行时定（建议 365）。

### 4.2 出站

```json
{"v":1,"t":"ui","kind":"stats","stats":{
  "scope":"workspace",
  "generated_at":"2026-10-21T10:00:00.000",
  "days":30,
  "totals":{
    "prompt":1240000,"cached":1100000,"miss":140000,"completion":86400,"model_ms":2050000,
    "runs":18,"model_calls":42,"model_ok":40,"tool_calls":137,
    "permission_waits":3,"asks":1,
    "subagent":{"prompt":210000,"cached":180000,"completion":12000,"model_calls":9,"tool_calls":31}
  },
  "sessions":[
    {"id":"20261021-101500","preview":"…","modified_at":1790000000,"archived":false,
     "self":{"prompt":900000,"cached":800000,"completion":60000,"model_ms":1500000,
             "runs":10,"model_calls":28,"tool_calls":90},
     "delegated":{"prompt":210000,"cached":180000,"completion":12000,"model_calls":9,"tool_calls":31}}
  ],
  "by_day":[{"day":"2026-10-21","prompt":124000,"cached":110000,"completion":8640,
             "runs":2,"tool_calls":14}],
  "by_model":[{"provider":"…","model":"…","prompt":900000,"cached":800000,
               "completion":60000,"calls":28,"model_ms":1500000}],
  "by_tool":[{"tool":"shell","calls":62,"failed":2,"denied":1,
              "duration_ms":252000,"chars":12345}],
  "orphan":{"sessions":0,"prompt":0,"cached":0,"completion":0}
}}
```

规则：

- **只发数字，不发内容。** 审计日志里有 `reasoning` 和工具参数字符串，汇总层只挑数值字段，
  绝不把文本带进 `stats`。
- 所有字段都可能是缺省（旧日志、被复制的日志），前端按「缺失 = 没测到」处理。
- `generated_at` 用于面板显示「截至」；它不是缓存失效的依据——面板打开时请求一次即可。

### 4.3 兼容性

- `PROTOCOL`（`internal/protocol/messages.go`，当前 `9`）→ `10`；
- `protocol/schema/inbound.schema.json` / `outbound.schema.json` 增加 `stats`；
- 未知 `kind` 的旧前端必须能忽略这条消息（既有约定）。

---

## 5. 运行时实现

### 5.1 新增 `internal/state/stats.go`

一个纯函数层，输入是若干会话的 `[]map[string]any`，输出第 4 节的数字：

- `Summarize` 继续负责单会话 totals（不复制它的算法）；
- `ByDay` / `ByModel` / `ByTool` / `Sessions` 各自一遍扫描，全部跳过缺失字段；
- `Merge(sub, parent)` 负责把 `delegation_finished.usage` 加进会话，**不**重复读子日志；
- 所有函数不返回错误，读不到的记录就是没测到（与 `Summarize` 同一条哲学）。

### 5.2 审计目录的只读枚举

`internal/audit` 目前只有 `Read(sessionID)`。新增一个只读方法（名字待定，建议
`List() ([]string, error)` + 复用 `Read`），要求：

- 只返回通过 `state.IsValidSessionID` 的文件名；
- 忽略半行、空行、非 `.jsonl`；
- **不加锁、不碰写入句柄**：写入和读取是两个独立 `os.File`；
- 顶层会话与子会话的区分不在这里做，由 `internal/state/stats.go` 用记录判断。

### 5.3 `internal/runtime`

- 新增一个 `StatsMessage()`（与 `StatusMessage()` 并列），只读不写；
- 协议层收到 `{"t":"stats"}` 时调用一次，不注册定时器；
- 日志很多时按 `modified_at` 倒序取最近的 N 个（建议 500），响应里带 `truncated: true`，
  面板显示「仅统计最近 N 个会话」——**宁可说少，不要假装全量**；
- 单次读取放 goroutine 里跑，别阻塞事件循环；同一连接的并发 `stats` 请求合并成一次。

### 5.4 TUI / CLI

本期不改。`--audit` 和 `/status` 继续用现有汇总；等 `stats` 稳定后再决定要不要给
TUI 加一个 `/stats` 视图（同一份数字，不另写一套）。

---

## 6. 桌面端实现

### 6.1 接线（四处，缺一不可）

| 位置 | 改动 |
| --- | --- |
| `src/state/store.ts` | `PanelKind` 加 `'stats'`；`SessionRuntime`/store 加 `stats: StatsReport \| null` |
| `src/commands.ts` | `COMMANDS` 加 `/stats`，`runCommand` 打开面板 |
| `src/components/panels/PanelHost.tsx` | 挂 `<StatsPanel />`，用 `dialog-wide` |
| `src/i18n/index.ts` | 所有文案 key（`panel.stats.*`） |

打开面板时发一次 `{"v":1,"t":"stats"}`；关闭不清数据——同一会话再次打开先显示上次的
`generated_at`，同时发新请求，避免白屏闪烁。**不轮询**。

### 6.2 数据落点

- `scope: session` 的响应写进当前会话的 bucket；
- `scope: workspace` 的响应写进窗口级字段（不属于任何会话，切换会话不重置）；
- 收到 `ui(stats)` 前保留 `null`，面板画「正在统计…」而不是零值表格；
- 请求失败/超时：保留旧数据并标「上次统计于 …」，不把面板变成错误页。

### 6.3 组件

```
src/components/panels/StatsPanel.tsx   // 页签、分组、表格
src/components/ui/Sparkline.tsx        // 手写 SVG，无新依赖
src/stats/cost.ts                      // 价表 + 估算（纯函数，可单测）
src/stats/format.ts                    // 复用 utils/format 的 formatTokens/formatDuration
```

页签三个：**本会话 / 工作区 / 按天**。布局：

```
┌ /stats ─────────────────────────────────────────────────────────┐
│ [本会话] [工作区] [按天]                        刷新   导出     │
├─────────────────────────────────────────────────────────────────┤
│ 输入 1.24M   缓存 1.10M (88%)   输出 86.4k   平均 42 tok/s      │
│ 轮次 18     模型调用 40/42      工具 137     权限等待 3 次/12s  │
├─────────────────────────────────────────────────────────────────┤
│ Token 构成   ███████████████████░░░░   cached / miss            │
│ 近 14 天     ▁▂▃▅▆▇█▆▅▃▂▁▂▃                                     │
├─────────────────────────────────────────────────────────────────┤
│ 工具 Top 5        次数    耗时      失败    拒绝                │
│ shell              62     4m12s      2       1                  │
│ read_file          41     0.8s       0       0                  │
├─────────────────────────────────────────────────────────────────┤
│ 模型              输入     输出     调用    估算成本            │
│ route/model       1.2M     80k       40      $1.23 (est.)       │
└─────────────────────────────────────────────────────────────────┘
```

细节：

- 「按天」的条形用 SVG，高度按窗口内最大值归一；**全零的一周画基线，不画 0 高度的柱子**；
- 表格里的 `—` 表示没有测量，和 `0` 区分；
- 子代理用量单独一行（`其中委派`），不混进主行——否则「这个会话花了多少」会有两个答案；
- 金额列在价表为空时整列隐藏，不显示空列。

### 6.4 入口

- 主入口：`/stats` 命令面板；
- 轻入口：状态栏 `Gauge` chip 的 popover 底部加「更多统计」；
- 跨会话：`SessionBoard` 的汇总行加 token 合计（只有 `workspace` 响应到达时才有，
  没有就不画）。

---

## 7. 版本与测试

### 7.1 版本

本功能同时动 `internal/` 和 `desktop/`，所以两边都要升：

- `VERSION`：`6.18.0` → **`6.19.0`**（新功能/新协议字段，次版本 +1）；
- `PROTOCOL`：`9` → **`10`**；
- 桌面端：`npm run version:bump`（当前 `4.5.0` → 建议 `4.6.0`）。

### 7.2 测试

- `internal/state/stats_test.go`（表驱动）：
  - 空日志、半行、字段缺失；
  - 失败重试不计 token；
  - 父 + 子日志只算一次；
  - 孤儿子日志进 `orphan`；
  - 跨天边界的本地时间分桶；
  - 没有 `run_started` 时 provider 为 `unknown`。
- `internal/audit` 的只读枚举：非法 session id 被跳过、半行被跳过。
- `internal/protocol/schema_conformance_test.go` + 两份 schema。
- 桌面端：`cost.ts` 的纯函数测试（缺价、零 token、三种价位），Sparkline 的归一化测试
  （全零、单点、负值）。
- 大改动，按仓库约定跑全量 `make test`；桌面端 `npm run typecheck && npm test`。

---

## 8. 分阶段

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| **P1** | 面板骨架 + `scope:session`：消费现有 `ui(status)`，先不新增协议；四组里除按天/成本外的内容 | 无 |
| **P2** | `stats` 协议 + `internal/state/stats.go` + 工作区/按天/按模型/按工具 | P1 |
| **P3** | 价表 + 成本估算 + CSV/JSON 导出 | P2 |

P1 可以先合入，作为「没有 runtime 改动也能看单会话统计」的兜底；P2 再把面板切到新消息。
切换时保留 `ui(status)` 作为回退：旧 runtime 不认 `stats` 时，面板仍能画出单会话那一页。

---

## 9. 风险与未决

1. **日志规模**：一个工作区可能有上千个会话。必须设上限并在界面上说出来；
   不要为了「全量」把打开面板变成一次磁盘扫描风暴。
2. **隐私**：汇总层绝不转发 `reasoning` / 工具参数 / 消息正文；审计日志本身已经落盘，
   但 `stats` 消息不应让内容多走一遍 IPC。
3. **子代理口径**：`delegation_finished.usage` 没有 `miss` 和 `model_ms`，所以委派部分的
   命中率可以算（cached/prompt），速率不能算。面板必须把这一格留空，而不是用父会话的
   速率冒充。
4. **归档会话**：默认计入工作区总量（历史花费是历史花费），但 `sessions` 行要带
   `archived`，列表可过滤。
5. **`PROTOCOL` 升级**：旧桌面端遇到 `ui(stats)` 必须忽略而不是报错；这需要在
   `adapt.ts` 的默认分支里确认。
6. **成本是不是产品需求**：如果只想要 token，P3 可以不做；本设计刻意把它隔离在
   `src/stats/cost.ts`，删掉不影响其余部分。
