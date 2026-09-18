# Go 重写版与原版 Python 的对照审查

审查对象：`tudouni-aigo`（Go）↔ `tudouni-ai/`（Python，以源码与测试为规格）。
方法：逐模块对照 `agent_runtime/` 的每个包与 `internal/` 的对应包，以原版代码 + 原版测试为
「行为规格」，只报**行为 / 功能 / 交互**差异，不报语言习惯与文件布局差异。

**状态：审查完成，全部已发现缺陷已修复。** 逐条修复记录见 `docs/parity-fixes.md`。

范围声明（按用户要求排除）：
- **主题由 13 套减到 3 套、默认主题 A → A-T2**：这是既定计划，不计入本轮问题清单。
- **界面只做英文、无 `--lang` / `ui.language`**：这是既定计划，不计入本轮问题清单。
  但**非界面文案**（系统提示词、工具描述、技能 / AGENT.md 内容）必须一致，已纳入审查并核对通过。

---

## 一、结论

Go 版把 Python 版的**骨架**搬过来了：三个前端 / runtime / tools 的分层、协议边界、
追加式落盘、权限闸的 fail-closed、上下文四档降级、后台任务的四工具形状，都在。

初查找到的问题集中在**边角与接线**上 —— 而它们恰好是原版用大量注释和测试钉住的那部分。
这些已全部修复；其中最有代表性的三类：

1. **有几处开关和设置在协议/请求层是空转的**（思考开关、后台任务输出目录、跨路由换模型、
   `--no-stream`），界面上说改了、实际没改 —— 现已全部做到"说的和做的一致"。
2. **原版刻意"绝不静默"的一批启动通知**，初查只剩 4 条且只有 TUI 看得见 —— 现已补齐，
   并按原版契约分流（注册工具清单走 stdout，其余 stderr）。
3. **行式 CLI（`tudouni` 不带 `--tui`）掉了一整层东西** —— stdout 契约、退出词、每轮用量、
   `--audit` 的汇总、`--debug`、未知 `/` 命令的兜底，现已全部还原。

另外在审计过程中挖出**若干原版有、Go 版丢掉的真实缺陷**，它们不在最初那份报告里，
因为只有把流程真跑一遍或把契约测一遍才会露出来（例如：任务列表写进去之后读不回来、
`--skills` 的存在标记恒为真、安装包里没有配置模板于是首次运行引导指向不存在的文件）。
清单见下文"三、审计过程中新发现的缺陷"。

---

## 二、问题清单与修复状态

> 每条给出：原版出处 · Go 版出处 · 后果。全部状态为**已修**；逐条改动与新增测试见
> `docs/parity-fixes.md`。

### BLOCKER（10 条，全部已修）

| # | 问题 | PY | GO |
|---|---|---|---|
| B1 | **思考开关在请求体里是死键**：原版把 `extra_body` 交给 OpenAI SDK，SDK 会把它**摊平到顶层**；Go 手写 JSON，原样塞了一个 `"extra_body"` 对象，顶层没有 `thinking`，`/thinking off` 从此无效。 | `state/reasoning.py:129-131`、`models/openai_compatible.py:481,578`、`tests/test_providers.py:202` | `internal/state/reasoning.go:103-113`、`internal/model/openai.go:220-222` |
| B2 | **跨路由 `/model` 只改了名字**：请求继续发往旧路由的 base_url 和旧密钥，而 `/status`、`ui(state)`、会话文件都显示已经换了。 | `agents/agent.py:588-601`、`runtime/composition.py:1052-1058` | `internal/runtime/composition.go:962-975`、`internal/model/types.go` |
| B3 | **`--no-stream` 在协议路径上被忽略**：界面边收边画，`init` 里却报 `stream:false`；反向 `--stream` 在行式 REPL 也无效。 | `runtime/composition.py:2158`、`README.md:1685-1687` | `internal/protocol/serve.go:50-54`、`internal/runtime/composition.go:405` |
| B4 | **任务列表不再贴到载荷尾部**：`todo_write` 照旧写 metadata，但模型每轮收到的载荷里没有它了。 | `runtime/composition.py:2296-2304` | `internal/runtime/composition.go` 的 `notes()` |
| B5 | **行式 CLI 的 stdout 契约被破坏**：提示符、版本行、各命令答复全打到 stdout，`> 对话.txt` 不再是干净答案。 | `frontends/cli/__init__.py:629-638,1057` | `internal/frontends/cli/cli.go` |
| B6 | **`--audit` 的汇总块整块没了**：token / 缓存命中率 / 各项计时 / 结束原因。 | `frontends/cli/__init__.py:459-509,268-294` | `cmd/tudouni/main.go`（新增 `internal/audit/summary.go`） |
| B7 | **REPL 的退出词失效**：空行 / `exit` / `quit` 不再退出，`exit` 会被当成消息发给模型。 | `frontends/cli/__init__.py:1047,1063-1064` | `internal/frontends/cli/cli.go` |
| B8 | **启动通知只剩 4 条，且只有 TUI 看得到**（原版约 20 类，含 `[background]` 两条安全相关警告）。 | `runtime/composition.py:1311-1550`、`main.py:283` | `internal/runtime/composition.go` |
| B9 | **`job_output(wait=false)` 把"还没收结果"当成"收过了"**：该模块设计要防的唯一静默失败重新可达。 | `tools/builtin/jobs.py:509-512` | `internal/tools/builtin/jobs.go:277-283` |
| B10 | **后台任务输出目录不再按会话隔离**：第二个会话会覆盖并删除第一个会话的活任务输出。 | `tools/builtin/jobs.py:768-771` | `internal/tools/builtin/jobs.go:145` |

### MAJOR（34 条，全部已修）

**agent 与装配层**：M1 串行批次改成"整批先审批再执行" · M2 流式中途不能取消 ·
M3 步数上限的工具列表装整轮 · M4 `/model acme` 裸路由名被拒 ·
M5 MCP 信任组（`a` 键）是死代码 · M8 `--debug` 是静默空操作。

**CLI**：M6 `--list` 丢任务列与排序规则 · M7 `--skills` 丢描述/正文大小/声明工具/`✓` ·
M9 未知 `/` 行被吞掉 · M10 CLI 的 `/mcp` 藏起失败原因 · M11 各命令输出内容缩水 ·
M12 每轮用量/任务/后台提示全没了 · M13 EOF/Ctrl-C 不收摊 · M14 `--tui` 丢配置预检。

**后台任务与网络工具**：M15 记录上限永不腾位 · M16 两个上限混成一个 ·
M17 2 MiB 输出上限只在 `job_output` 时检查 · M18 `Close()` 少内核级兜底清扫 ·
M19 Windows `shell` 无 `pwsh`/无 UTF-8 前置声明 · M20 `ask_user` 多选被截成第一项 ·
M21 `fetch_web` 只认 5 种编码 · M22 不再忽略 `HTTP_PROXY` · M23/M24 `grep` 引擎错误误报与通知参数。

**TUI**：M1 答案不再属于它自己的回合 · M2 左栏自动顶开被 `railPinned` 挡住 ·
M3 `/thinking` 接受 11 种写法 · M4 `/quiet` 区分大小写 · M5 `/mcp` 错参数不开面板 ·
M6 `/model` 选择器丢 label/summary/窗口/别名 · M7 `/model` 与 `/effort` 文本回退缩成一行 ·
M8 启动窗口没有转圈 · M9 等人在审批时转圈还在转 · M10 收起栏摘要不说 autopilot。

### MINOR（全部已修或核对后确认无需改动）

TUI 侧 9 条已修（`Ctrl+B` 在覆盖层里失效、调色板行数上限写死、`/help` 的 `↑↓` 与 detail 版式、
调色板无匹配时 Enter、`/new` 与 `/resume` 各打两行、思考正文不压平换行、缺 `duration_ms` 显示
`0ms`、`Ctrl+K` 不插入 `/`、死代码 `renderStatus`），2 条核对后确认属于实现差异而非行为差异。

其余模块的零散条目（工具返回值形状、校验文案、schema 线上形状等）已在对应轮次一并处理或
核对为等价。

---

## 三、审计过程中新发现的缺陷

这些**不在最初那份报告里**，因为只有把流程真跑一遍、或把契约测一遍才会露出来。
逐条修复记录同样在 `docs/parity-fixes.md`。

| # | 缺陷 | 为什么初查没看到 |
|---|---|---|
| N1 | **任务列表写进去之后读不回来**：`todo_write` 存的是 `[]map[string]any`，而 `loadTodos` 只接受 `[]any`（从会话文件 JSON 读回来的形状）。刚写完的列表在同一进程里立刻读不到，于是载荷尾部、rail 进度条、`--list` 的任务列、`/resume` 行**全部没有数据**；而 `todo_write` 的 ack 文案走另一条路，**照样报成功**。 | 读代码看不出来 —— 两个形状在不同路径上都"对"，只有跑一遍才暴露 |
| N2 | **`--skills` 的 `✓` 标记恒为真**：`Catalog.Roots` 的注释说"实际扫过的目录"，赋值给的却是全部候选。 | 注释与代码矛盾，只有把输出打出来对比目录是否真的存在 |
| N3 | **`Close()` 在"没有进程句柄"的任务上 panic**：`TerminateTree` 只判了 `cmd.Process == nil`。这是**进程退出路径上的崩溃**。 | 需要构造一个不带进程句柄的任务才会触发 |
| N4 | **安装包里没有 `config.example.json`，首次运行引导指向不存在的文件**：`Scaffold()` 读磁盘，而安装副本上那个文件不在 —— 一个没有密钥的新用户看到的唯一一句可操作的话**不会出现**。 | 只在**安装出来的副本**上出现；源码目录里永远正常 |
| N5 | **`--skills` 里我自己引入的对齐占位符**：`i18n.T` 不认识 `{name:20}`，会把占位符原样留在屏幕上。 | 冒烟测试当场抓住；顺带发现几个既有 key 里也躺着同样的死语法 |

---

## 四、为什么这些问题会漏过去

- 初查时 Go 测试约 **3,984 行 / 19 个文件**，Python 约 **18,809 行 / 62 个文件**；
  而 `cmd/tudouni`、`internal/frontends/cli`、`internal/config`、`internal/state`、
  `internal/audit`、`internal/model` 这些**出问题最多的包一个测试都没有**。
- 结束时 Go 测试 **5,777 行 / 32 个文件**，上述包全部有了测试，并新增了协议 schema 一致性、
  配置模板一致性、批量顺序、取消语义、MCP 信任组等原版有、Go 版缺的那类断言。
- 原版把每条契约都写成测试（`test_banner.py` 钉 stdout 契约、`test_timing_report.py` 钉审计汇总、
  `test_model_switch.py` 钉"界面说换了、请求有没有动"、`test_prompt.py` 钉载荷尾部、
  `test_jobs.py` 钉"部分输出不算收过"）。这些测试**正是**上面那些缺陷的直接反例来源 ——
  重写时没有跟着搬，是这一轮所有问题的共同根因。

---

## 五、交付物

| 文件 | 内容 |
|---|---|
| `docs/parity-review.md` | 本文件：总报告与最终结论 |
| `docs/parity-fixes.md` | 修复日志：每条的改动、原版出处、新增测试 |
| `docs/parity-tui.md` + `docs/parity-tui-inventory.md` | TUI 明细（31 条 + 命令/按键/rail/覆盖层/状态栏清单） |
| `docs/parity-cli.md` | 行式 CLI 与整个命令行接口明细 |
| `docs/parity-agent.md` | agent 循环、模型适配、流式、重试、装配明细 |
| `docs/parity-tools.md` | 工具系统与 16 个内置工具明细（含逐工具 parity 表） |
| `docs/parity-test-map.md` | 原版测试 → Go 测试的搬迁清单 |
| `VERSION` | 3.10.0 |

---

## 六、验证方式（不是"改完就算"）

- **全量测试**：`go test ./...` 通过（`internal/mcp` 在本沙箱下经 runner 会静默失败，
  直接运行其测试二进制则 PASS —— 这正是 `test.sh` 存在的原因，见 AGENT.md）。
  `go vet ./...` 干净。
- **真实二进制校验**：`go run ./tools/release` 两个平台全量构建 + 校验 + 打包通过；
  校验本身会运行 `--help`、`--version`、用隔离配置起一次 `--runtime-stdio`，并确认随包的
  ripgrep 被认出来。产物 7 项、约 8 MB，与原版"四类随代码走"的设计对得上。
- **首次运行剧本**：把构建出的二进制在干净目录里跑（`USERPROFILE` 指向临时家目录），
  确认它建出了 `~/.tudouni/config.json` 并打印了含真实路径的引导句。
- **契约测试**：协议 schema 逐字段核对、配置模板两份拷贝不许漂、批量顺序、取消语义、
  MCP 信任组快照语义 —— 这些是本轮新增的、原版有而 Go 版缺的断言。
