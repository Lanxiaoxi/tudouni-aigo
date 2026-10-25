# docs/ — 这是什么，以及哪一份说了算

五类文档，按**它今天还有没有权威**分。想改代码前先看一眼对应那一份，别拿
已经被推翻或已经实现的文档当依据。

| 目录 | 一句话 | 什么时候读 |
| --- | --- | --- |
| [`spec/`](spec/) | **权威规格。** 代码与它冲突时，这里是"应该是什么" | 动协议、动 TUI 外观之前 |
| [`design/`](design/) | 设计决策与成因。有的是已落地的实现记录，有的是还没做的方案 | 想知道某个东西**为什么**长这样 |
| [`parity/`](parity/) | Go 重写版与原版 Python 的逐项对照审查 | 怀疑某个行为丢了、或想找当初的修复理由 |
| [`history/`](history/) | 已经结束的调查与账本。**结论仍然有效，但不要再往里加内容** | 想复现某次测量、或看看老结论今天还成不成立 |
| [`tech-debt/`](tech-debt/) | 桌面端的技术债基线 | 动 desktop 的 store.ts / CSS 之前 |

## spec/ — 三份，权威

- [protocol.md](spec/protocol.md) — TUI ↔ runtime 的 JSONL 协议 v1。**语义**参考（什么时候发、
  收到怎么办、客户端不许自己决定什么）。形状看 `protocol/schema/*.schema.json`；两者打架时
  以 schema 和一致性测试为准，因为这份文档写的是原版（Python）的线上语义。
- [TUI-design.md](spec/TUI-design.md) — TUI 的完整设计规格：布局、面板、配色、键位、每一条
  决策的理由。
- [responses-api-wire-format.md](spec/responses-api-wire-format.md) — OpenAI Responses API 的
  线格式速查表，解释 `internal/model/` 里那些手写 JSON 为什么是那个形状。

## design/ — 设计决策

**已落地、仍可查的：**

- [workspace-memory.md](design/workspace-memory.md) — 工作区记忆的实现记录（`internal/memory/`）。
- [goal-and-verification.md](design/goal-and-verification.md) — Goal 与 Verification 的可行性
  评估与取舍（已实现：`internal/runtime/goal_driver.go`、`internal/tools/builtin/goal.go`）。
- [image-generation.md](design/image-generation.md) — `generate_image` 的设计方案（输出侧的图片，
  已实现：`internal/imagegen/`）。
- [vision-input.md](design/vision-input.md) — 图片作为**输入**进入 Context 的九阶段方案
  （`read_image`、`ImagePart`、多模态 Content 抽象，已实现）。
- [startup-baseline.md](design/startup-baseline.md) — 桌面端启动耗时基线与白屏修复的实测对比。
- [ericai-proxy.md](design/ericai-proxy.md) — EricAI 认证要代理、本地模型要直连的冲突调查与
  解法（`internal/proxy` 的 `NO_PROXY` 支持就是照方案 A 补上的）。
- [architecture-review.md](design/architecture-review.md) — Go 运行时核心架构评审的**处置
  记录**：哪些结论已落地、哪些有意没做、以及继续做时的顺序。动 `internal/runtime` /
  `internal/protocol` / `internal/agent` 的并发或分层之前先读它。
- [system-prompt-review.md](design/system-prompt-review.md) — `prompts/system.zh.md` 与
  `compact.zh.md` 的评审：12 个与实现不一致的点、证据和建议改法。**状态：评审完成；
  #1 已修复，其余待处理。** 改提示词或工具描述之前先读它。
- [usage-panel.md](design/usage-panel.md) — 桌面端「使用统计」面板 + home 目录跨工作区
  总账（`internal/usage/`，协议 11）。卡片口径、总账格式、窗口级快照的决定都在这里。

**还没做的方案，别当成现状读：**

- [benchmark-harbor.md](design/benchmark-harbor.md) — 用 Harbor + Terminal-Bench 2.0 评估 runtime 的方案：只写一个 adapter，Harbor 负责容器、题库、判分与成本/耗时记录，结论只从「同模型换 harness」的配对实验里读。**状态：方案，未实施。**
- [usage-stats.md](design/usage-stats.md) — `/stats` 统计面板的设计草案。**状态：草案，未实现。**
  它打算复用 `internal/state/status.go` 的 `Summarize` 做只读汇总。

**早期路线图，已经被实现取代，只在想追溯"当初怎么想的"时读：**

- [guide.md](design/guide.md) — 分十个阶段从零实现 runtime 的路线。**MCP 后来做了，其余按它
  走完了。**
- [context-plan.md](design/context-plan.md) — Context/Artifact 分层架构的原始方案，
  `internal/context/` 是它的落地版。
- [TUI.md](design/TUI.md) — 选型阶段的讨论（当时倾向 React + Ink，实际用了 Bubble Tea）。

## parity/ — Go 与原版 Python 的对照审查

从 [parity-review.md](parity/) 进。它是总报告和最终结论；逐条修复记录在
[parity-fixes.md](parity/parity-fixes.md)。**这套审查已经做完，全部缺陷已修**，
所以它现在的作用是"解释为什么某段代码是现在这样"，不是待办清单。

| 文件 | 覆盖 |
| --- | --- |
| [parity-review.md](parity/parity-review.md) | 总报告：方法、范围、问题清单与结论 |
| [parity-fixes.md](parity/parity-fixes.md) | 修复日志：每条改动、原版出处、新增测试 |
| [parity-tui.md](parity/parity-tui.md) + [parity-tui-inventory.md](parity/parity-tui-inventory.md) | TUI 明细（31 条 + 命令/按键/rail/覆盖层/状态栏清单） |
| [parity-cli.md](parity/parity-cli.md) | 行式 CLI 与整个命令行接口 |
| [parity-agent.md](parity/parity-agent.md) | agent 循环、模型适配、流式、重试、装配 |
| [parity-tools.md](parity/parity-tools.md) | 工具系统与 16 个内置工具（含逐工具 parity 表） |
| [parity-test-map.md](parity/parity-test-map.md) | 原版测试 → Go 测试的搬迁清单 |

## history/ — 已归档，结论有效但不再更新

- [go-rewrite.md](history/go-rewrite.md) — 从 Python 重写到 Go 的事项与约束。
- [perf-analysis.md](history/perf-analysis.md) — 「若干轮 × 每轮若干步」的执行耗时分析。
  注意它对 TUI 渲染的那条结论已被 [tui-long-session-lag.md](history/tui-long-session-lag.md)
  修订。
- [tui-long-session-lag.md](history/tui-long-session-lag.md) — 长会话每帧全量重绘的实测与
  修复方向。**已修复**：`transcript.go` 的 `markdownResults` 缓存（`c774533`）就是照它落地的，
  文中"尚未修复"是记录当时的状态。
- [exploration-cost.md](history/exploration-cost.md) — 结构化索引层到底能省多少（116 会话 /
  22,230 次工具调用）。结论是受益面只有 5.7%，**不建议**为它做 AST/LSP 层。
  配套脚本 `scripts/exploration_cost.py`。
- [release.md](history/release.md) — 出发布包的流程记录。**当前流程以
  [`../AGENT.md`](../AGENT.md) 和 `Makefile` 为准**。

## 不在 docs/ 里的

- [../README.md](../README.md) — 面向使用者的说明：配置、模型接入、工具规则、构建。
- [../AGENT.md](../AGENT.md) — 面向改代码的人（和 AI）：目录表、构建测试发布、版本号约定。
- `../desktop/` — 桌面端是独立项目，设计文档在 `desktop/tudouni-aigo-desktop-design/`，
  实现评审在 `desktop/tudouni-aigo-desktop/docs/`。
