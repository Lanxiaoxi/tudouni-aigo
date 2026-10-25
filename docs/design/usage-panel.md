# 「使用统计」面板（桌面端 + home 总账）

**状态**：已实现（本文档与实现同批落地）。
**范围**：桌面端左下角 workbench 菜单新增「使用统计」面板；运行时新增一份跨工作区
的用量总账（`~/.tudouni/usage.jsonl`）和一条按需的汇总消息（协议 10 → 11）。
**不在范围**：成本估算（价表）、按模型/按工具的**表格**（那是 [usage-stats.md](usage-stats.md)
的范畴，仍是未实施的草案；按模型的**图**后来补上了，见 §7）、CLI /stats、跨机器汇总、导出。

---

## 1. 一句话

面板回答的问题不是"这个会话/这个工作区花了多少"——那是 `/status` 和
usage-stats.md 的事——而是**"这个人这台机器，累计花了多少、哪天最多、连续活跃了
多少天"**。所以账本跟着人走（home 目录，和 `config.json` 同一处），不跟工作区；
热力图和连续天数需要**持久**的按天记录，现读工作区日志重算是既贵又不跨工作区的。

## 2. 口径（沿 usage-stats.md §3 的既定规则）

- 只计 `status == "ok"` 的 `model_call`——和 `state.Counter` 同一道闸门，失败重试
  不计 token，两边对不上才算 bug。
- 按天分桶用记录自己的 `ts` 前 10 个字符（本地时间），不用 `modified_at` 或
  `Date.now()` 反推。
- **只发数字，不发内容**：总账行只有 id 和数值，协议快照只有数字，不携带任何正文。
- 没有测量就不画 0：`peak` / `longest_run_ms` 在没有任何记录时**缺省**；账本一行
  都没有时面板画空态句子而不是一排 0。连续天数为 0 是真实测量（今天和昨天都没
  动过），照实画。
- 卡片定义：
  | 卡片 | 口径 |
  | --- | --- |
  | 累计 Token | Σ(prompt + completion)，缓存命中算在内（真的发了、真的计费） |
  | 峰值 Token | 单日最高 tokens（**全量历史**，不受热力图窗口限制） |
  | 最长单轮时长 | max(`run_finished.duration_ms`)。截图类产品叫"聊天时长"；我们按可测的单轮 wall time 定义 |
  | 当前连续天数 | 有总账记录的连续日历天，从今天往回数；今天还没动过则退到昨天（一天没过完不算断），再往前断掉就是 0 |
  | 最长连续天数 | 全历史里最长的一段连续活跃天 |

## 3. 总账（`internal/usage`）

文件：`~/.tudouni/usage.jsonl`（`paths.UserConfigDir()`，可被 `TUDOUNI_HOME` 迁移）。
一行 = 一次**结束的、至少含一次成功 model_call 的 turn**：

```json
{"v":1,"kind":"run","ts":"2026-10-25T12:00:00.000","session_id":"…","run_id":"…",
 "prompt":123,"cached":100,"miss":23,"completion":456,"model_ms":4200,
 "duration_ms":61000,"calls":3,"model":"…"}
```

- **写入点**：`runtime.onEvent`（每条审计记录的唯一出口）。Ledger 按 `run_id`
  在内存折叠 `model_call`（仅 ok），`run_finished` 到达时追加一行并清掉折叠态；
  折叠表有上限（64），被杀 turn 的残留会被最旧的挤掉。纯工具 turn 不写行——
  "这一轮跑过"是审计日志的事实，"这一轮花了"才是总账的。
- **子代理**：特殊规则为零。子的 model_call 是真实调用，走同一个 `onEvent`
  （见 `subagent.Tool.childSink`），每个 API 调用恰好计一次；父日志的
  `delegation_finished.usage` 是给"不读子日志"的读者用的摘要，这里**不用**，
  所以 usage-stats.md 里那个孤儿/去重问题在这个口径下不存在。
- **并发**：进程内 mutex + 常驻句柄 + `O_APPEND` 单次 Write（照抄
  `audit.JsonlSink` 的写法）；跨进程（多个 runtime 子进程、CLI 并存）靠
  append 原子性。写失败一律吞掉：观察不得影响被观察者。
- **读取**：`Aggregate` 整份扫描（一行一个 turn，一年重度使用约几 MB，只在面板
  打开时读一次，不轮询）；半行、坏行跳过；文件不存在 = 空账本 = 零报告，不是错误。
- `by_day` 只带最近 365 天（热力图窗口）；totals / peak / streak 算**全量**。

## 4. 协议（10 → 11）

- 入站 `{"v":1,"t":"usage_stats"}`，无参数、无动作——唯一一个没有 action 字段的
  面板消息，因为面板上没有可操作的东西。
- 出站 `ui(kind:"usage", usage:{generated_at, totals{…}, peak?, longest_run_ms?,
  streak{current,longest}, by_day[]})`；拒绝带 `problem`、无 `usage`（面板盖在
  会话流上，notice 会被遮住——memory/codeintel 踩过的坑）。
- 快照存桌面端**窗口级**字段，不进 session bucket：账本数的是这个用户，切会话
  不许把它清掉；新连接握手（`init`）时清空——账本在**那台**机器上，远程工作区
  换连接后旧快照描述的是别人的账本。
- `protocol/schema/*.json` 两份同步；旧前端遇到未知 `kind` 照既有约定忽略。

## 5. 桌面端

- 入口：workbench 菜单 settings 组（Tasks/Board 与 Config/Settings 之间），gate
  `blocked || hasSession`——账本经 runtime 读，没有会话就没人可问，同
  Memory/CodeIntel。
- 面板：`UsagePanel.tsx`，`dialog-wide`（53 周的列数挤在窄容器里就是一个月都
  指不出来）；统计卡片沿用 `.ci-fact` 的形状；热力图手写 CSS grid（7 行 × 周
  列，色阶 5 档，档位取非零日的四分位数而不是最大值——一天 1 万 token 会把其他
  天全压成 1 档）；每日/每周切换；月标注按列号落在同一套栅格节奏上；色阶是
  `tokens.css` 里的正式 token（`--usage-l0..l4`，两套主题各一份）。
- 日期数学在 `usageHeatmap.ts`（纯函数，`tests/usage-heatmap.test.ts` 覆盖窗口
  边界、补位、四分位档位、周桶）。

## 6. 风险与已决

1. **崩溃丢一轮**：折叠态在内存，进程被杀时当前 turn 的行丢失（审计日志仍有）。
   可接受——总账是展示账，不是计费账。
2. **删账本 = 清零**：文件就是事实源，删掉从头记。不做备份/合并。
3. **远程工作区**：账本在 runtime 所在机器的 home 里，面板显示的是**当前连接**
   那台的账；跨机器合并不在范围内。
4. **`~/.tudouni` 打不开**：Boot 告警后继续（`Booted.Usage == nil`），面板答
   "no usage ledger"，不会拖垮会话。

## 7. 按模型的两张图（协议 11 → 12）

时间范围切换（近 7 日 / 近 30 日）+ 每日按模型的 token 趋势折线 + 模型占比环形图，
参照同类产品的账户用量页。落地的决策：

- **总账不加一行、不加一个字段**。每行本来就带 `model`（该轮**最后一次成功调用**
  的模型，fold 的既定近似——子代理是独立 session、独立 run，绝大多数行单一模型）。
  `Aggregate` 用它把 `by_day` 的每日分桶再按模型拆一份，快照条目多带一个
  `models`（`{model: tokens}`，protocol 12）。一整天没有可归的模型时整个键缺省，
  前端据此**隐藏两张卡片**——「账本没说」和「每个模型都花了 0」不是一句话。
- **拆分之和可以小于当日合计**：没有模型归属的 token 只进当日合计，不进任何桶。
  这是诚实答案不是漏账（`aggregate.go`、`UsageDay` 两处注释都写明）；前端两张图
  只认拆分，不回退到日合计去凑一个看似完整的数。
- **范围切换是前端的事**：`by_day` 本来就带 365 天，7/30 日切片在桌面端做
  （`usageCharts.ts`，纯函数、有测试），协议不加参数、不发第二次请求。
- **多于 6 个模型折成一个「其他」**：色板只有 6 槽（两套主题各一份，
  `--usage-m1..m6`）；复用颜色会让两条线冒充一个模型。「其他」永远用中性色
  （`--fg-faint`），不占用任何模型的槽位。
- **零的规矩**：范围内一天都没花 → 趋势图画平线（真实测量，同连续天数为 0 的
  待遇），环形图整卡不画——零没有占比可分；快照没有拆分 → 两张卡都不出现。
- **纯手写 SVG**：折线是 `<polyline>` 加点上的原生 `<title>`，环形是 `<circle>`
  加 dash 偏移，不引图表库——与热力图同一决定。y 轴不标数值（同参照页）：精确
  数字在图例、环形旁的列表和悬停里，画布只留形状；环形圆心用紧凑格式
  （`formatTokensCompact`），完整位数放不进 168px。
