# TUI 长会话卡顿（每帧全量重绘随历史线性变贵）

> 状态：**已修复（`c774533`，2026-09-22）**。本文的"尚未修复"是写下当时的状态，
> 保留原文以记录证据与判断过程；落地的是 `internal/frontends/tui/transcript.go` 里的
> `markdownResults` 缓存 —— 它把已完成的回答按 (正文, 宽度, 渲染器标识) 记住，
> 于是同一帧不再重新 typeset 历史。下面第 5 节列的方向因此只作参考，不要照它再改一遍。
> 现象来源：用户报告「某个聊了很多轮的会话，输入和模型输出都卡；新开一个终端就不卡」。
>
> 一句话结论：**不是会话被"标记"了，而是该会话的 transcript 变长了，TUI 每帧
> 都全量重绘整段历史，成本随历史量线性~超线性上涨；流式输出时每来一个 delta
> 就触发一帧，于是长会话在生成时逐帧几百毫秒，输入自然跟着卡。** 新终端历史短，
> 所以不卡。

---

## 1. 机制（为什么长会话卡）

Bubble Tea 是**无状态渲染**：每次 `Update` 之后，`model.View()` 把整屏重新画一遍。
本仓库 TUI 的 `View()`（`internal/frontends/tui/view.go`）做的事：

1. `renderTranscript` 遍历**整个** `m.transcript`——每一条历史都在渲染范围里，没有"只画新增"的增量路径；
2. 每个**已完成的 turn** 走 `renderTurn` → `renderAnswerBlock` → `renderMarkdown`：
   用 **glamour 重新渲染那一段 markdown**。`markdownCache` 只缓存了 renderer 本身
   （theme + 宽度），**不缓存渲染结果**，所以每条历史回答每一帧都要重新现渲染一遍；
3. 每条 tool line、thinking 块、状态栏全部重算；每行还要 `stripANSI`、
   `runewidth` 算宽、`wrapCells` 逐格折行——都是逐字符开销；
4. 流式输出时（`--stream`），**每个 delta 消息触发一帧**（`bridge` → `handleDelta` →
   重绘），帧率跟着 delta 到达频率走（`tui.go` 里 channel 缓冲 256、"每秒可达几百个增量"），
   于是流式期间等于在"每帧几百毫秒"的重绘上反复踩。

这正是"那个会话卡、新终端不卡"的原因：渲染成本与**该会话自己的历史量**成正比，
与终端进程无关；`resetForSession()`（`model.go`）把 transcript 清空，新会话归零。

## 2. 实测数据（本机：Win11 / i5-1245U，120×40 终端，中等内容量会话）

对 `m.View()` 的一次全量重绘做 benchmark（`benchtime=200x`，每帧含全部 alloc）：

| 轮数 | 1 | 5 | 10 | 20 | 40 | 80 |
|---|---:|---:|---:|---:|---:|---:|
| 每帧耗时 | 12ms | 37ms | 82ms | **151ms** | **271ms** | **712ms** |
| 每帧分配 | 2.1MB | 9.9MB | 19.5MB | 38.8MB | 77.2MB | 153.9MB |
| 每帧分配次数 | 38k | 190k | 380k | 759k | 1.52M | 3.04M |

- **约 20 轮起每帧已 ≥150ms**，且是"静止画面"的帧——没有流式也这么贵。
- 80 轮每帧 **712ms**，分配 154MB/帧；150MB 级的分配还会把 GC 拉进来，耗时曲线
  比线性更陡（40→80 轮 ×2.6）。
- 配 `--stream` 后，每个 delta 都付一次这个价：模型输出的"卡顿感"就是逐帧 0.2~0.7s。
- 输入光标跟手度同样被拖累：按键也走同一趟 `View()`。

> 附：100+ 轮的档位（160 轮）benchmark 因单档总时长超 300s 被截断未跑完——
> 连"测一次"都这么慢，正好印证量级。

## 3. 放大因素

- **流式开/关**：开流式时重绘频率由 delta 决定（每增量一帧），比静止时的 120ms
  spinner 节拍（`spinnerInterval`，仅 quiet 模式）密集得多；
- **历史里回答的 markdown 复杂度**：代码块、表格、长列表 → glamour 渲染更贵；
- **终端宽度**：格宽越窄，`wrapCells` 折出的行越多，历史总行数越多。

## 4. 与已有分析的关系（修订一处旧结论）

`docs/history/perf-analysis.md` 第 9 节曾写：TUI 前端渲染"量级（十几毫秒）决定了不值得为它
做一次专门的分析"。**该结论只在短会话成立**——它基于的是 Agent 层基准和单轮/少轮
样本。本文测量表明：会话一长（20 轮+），TUI 渲染从"可忽略"变成**主导瓶颈**
（每帧 0.15~0.7s），且当前架构没有增量路径，属于结构性开销，不是调参能压掉的。

## 5. 修复方向（仅记录，未实施，按性价比排序）

1. **缓存已渲染的历史行**：按 entry + 宽度 + theme 缓存 `renderTurn` /
   `renderAnswerBlock` / `renderMarkdown` 的结果，内容/宽度不变就不重算。预期能
   去掉长会话每帧里历史部分的大头（80 轮 712ms 中的绝大部分），改动中等。
2. **流式期间只重画 streaming 块**：正文 streaming 时折叠历史部分的重复渲染
   （代码注释里已提及"每 delta 重排 markdown 会让流式卡顿"，方向一致）。
3. **增量/脏区渲染**：只重绘变化的条目区域——根治，改动最大。
4. **节流**：delta 合并、帧率上限——治标，但便宜。
5. 产品层提示：长会话可用 `/compact` 控制上下文；**但 compact 是否清空 transcript
   未验证**（见下），不要当作已确认的解法写出去。

## 6. 复现

临时在 `internal/frontends/tui/` 下放一个 benchmark 测试（构造 N 个已完成 turn 的
transcript，`b.ReportAllocs()` 下循环调 `m.View()`），跑：

```powershell
go test ./internal/frontends/tui/ -run xxx -bench BenchmarkView -benchtime=200x -count=1
```

（复现用的临时文件已删除，不在仓库里。）

## 7. 未验证项

- `/compact` 后 transcript 是否被清空（涉及 runtime 侧行为，未查证）；
- 真实最坏情况（大量超长 markdown 回答）下的单帧上限；
- glamour 单条渲染的绝对成本占比（未单独拆）。