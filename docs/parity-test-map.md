# 原版测试 → Go 测试的搬迁清单

这份清单回答一个问题：**原版哪些测试是上面那些缺陷的直接反例来源，重写时没跟着搬。**
修一条缺陷时，应当把对应测试同时搬成 Go 测试 —— 否则下一轮重写还会漏。

## 一、现状

| | 文件数 | 行数 |
|---|---|---|
| Python（`tudouni-ai/tests/`） | 62 | 18,809 |
| Go（`*_test.go`，不含 `tudouni-ai/`） | 19 | 3,984 |

**一个测试都没有的 Go 包**（也是缺陷最集中的地方）：
`cmd/tudouni`、`internal/frontends/cli`、`internal/frontends`（report）、`internal/config`、
`internal/state`、`internal/audit`、`internal/model`、`internal/version`、`internal/process`。

## 二、按缺陷对应的原版测试（优先级从高到低）

| 缺陷 | 原版测试 | 它钉住的东西 | Go 侧现状 |
|---|---|---|---|
| B1 思考开关的请求体 | `tests/test_providers.py:187-260`（`test_thinking_is_on_by_default_in_the_request`、`test_turning_thinking_off_changes_the_next_request`） | 线上报文里 `reasoning_effort` 在顶层、`thinking` 在**顶层**（不是 `extra_body`）；关掉时**不发** `reasoning_effort` | 无（`internal/model` 无测试文件） |
| B2 跨路由换模型 | `tests/test_model_switch.py:453-475`、`tests/test_providers.py:311-355` | 「界面说换了、请求也换了」：切到另一条路由后请求发往新 base_url / 新密钥 | 无（`internal/runtime` 只有 `ericai_test.go`） |
| B3 `--no-stream` 语义 | `tests/test_streaming.py:526-543` | `init.stream=false` ⇒ 请求体里没有 `stream`、也不发 delta | 无（`internal/protocol` 只有一个 83 行的 `protocol_test.go`） |
| B4 任务列表进载荷尾部 | `tests/test_prompt.py`（全量，27KB）、`tests/test_todo.py:110-128` 附近 | `_session_notes` 的四段与顺序；`todo_note` 的逐行渲染 | 无（`internal/runtime` 无对应测试） |
| B5 CLI stdout 契约 | `tests/test_banner.py:78-120` | `已注册工具:` 在 stdout、`审计日志写到` 在 stderr；`新会话 'x'` 在 stdout | 无（`internal/frontends/cli` 无测试文件） |
| B6 `--audit` 汇总 | `tests/test_audit_view.py:96-108`、`tests/test_timing_report.py:37-95`、`tests/test_cli_usage.py:43-207`、`tests/test_debug_cost.py` | 汇总行、计时明细、结束原因、成本提示 | 无（`internal/audit` 无测试文件） |
| B7 退出词 | `tests/test_cli_usage.py`（REPL 交互部分）、`tests/test_main_entry.py` | 空行 / `exit` / `quit` 退出 | 无 |
| B8 启动通知 | `tests/test_packaging.py`（四类文件）、`tests/test_providers.py:401-403`（model 通知）、`tests/test_permission_config.py`（权限各条）、`tests/test_agent_md.py`、`tests/test_skills.py` | 每条通知必须出现，且必须**不静默** | 无 |
| B9 部分输出不算收过 | `tests/test_jobs.py:163-171` | `job_output(wait=false)` 之后提醒仍然挂着 | 无（`internal/tools/builtin` 只有 `registry_test.go`/`webtools_test.go`） |
| B10 任务目录按会话隔离 | `tests/test_jobs.py`（目录相关）、`tests/test_packaging.py` | `.tudouni/jobs/<session_id>/` | 无 |
| M1 串行批次相邻性 | `tests/test_parallel.py:199,304-320` | 串行批次逐条交错；`tool_result.parallel` 的存在与"并行省"统计 | 无 |
| M2 流式取消 | `tests/test_streaming.py:588-623` | 中途取消立刻抛 `RunCancelled` | 无 |
| M3 步数上限的工具列表 | `tests/test_step_limit.py:39` | `exc.value.tools == ["list_files"]`（只含最后一步） | 无 |
| M4 `/model` 名字形式 | `tests/test_model_switch.py:428-434,478-489`、`tests/test_providers.py:478` | 裸路由名 → 该路由首个模型；已是当前模型 → `already` | 无 |
| M5 MCP 信任组 | `tests/test_mcp.py`、`tests/test_permissions.py`（`a` 键） | `a` 放行的是**当下这批工具名**的快照 | 无 |
| M6 CLI `/status` 行 | `tests/test_status_summary.py`（全量 4.6KB） | 14 行的字段与文案 | 无 |
| M7 `/thinking` `/effort` 文本 | `tests/test_tui_commands.py`（相关的无参数分支） | 真实状态 + 强度 + howto | 无 |
| M8 `--debug` | `tests/test_debug_cost.py:66-74` | `[debug]` 行的内容 | 无 |
| M9 未知 `/` 行 | `tests/test_cli_usage.py` | 认不出的 `/xxx` 原样发给模型 | 无 |
| M10 子命令的工作区/id 检查 | `tests/test_main_entry.py:111-120,209-227` | `--session a/b --list` 退出 2；`--tui` 配置坏时 stdout 为空 + 退出 2 | 无 |
| M11 输出内容缩水 | `tests/test_session_list.py:71-103,146-154`、`tests/test_cli_usage.py` | `--list` 的排序与任务列、`--history` 的 artifact 行、`--skills` 的三行 | 无 |
| M12 每轮用量 | `tests/test_status_summary.py`、`tests/test_timing_report.py`、`tests/test_context_system.py` | 每轮 stderr 那行的字段 | 无 |
| M13 退出收摊 | `tests/test_jobs.py`（close 路径）、`tests/test_mcp.py` | 退出时收掉子进程 | 无 |
| M14 grep 引擎错误 | `tests/test_grep.py`（错误分支） | 非 regex 的引擎错误仍然渲染命中 + 脚注 | 无 |
| M15 ask_user 多选 | `tests/test_ask_user.py` | `1,3` / `1，3` / `1、3` / `1, 换个别的` 四种输入 | 无 |
| M16 fetch_web 编码 | `tests/test_webfetch.py`（编码相关） | 声明什么就按什么解 | 无 |
| M17 会话列表 | `tests/test_session_list.py`（全量 9.8KB） | 排序（含 mtime 回退与 id tiebreak）、行内容 | 无 |
| TUI 各条 | `tests/test_tui.py`（156KB）、`test_tui_commands.py`（51KB）、`test_tui_boot.py`、`test_tui_quiet.py`、`test_tui_palette.py` | 见 `docs/parity-tui.md` | TUI 是 Go 侧测试最多的包（约 1.4k 行 / 6 个文件），但上面 10 条 MAJOR 都没有对应断言 |

## 三、建议的搬迁顺序

1. **第一批（跟着 B1–B3 走）**：新建 `internal/state/reasoning_test.go`、
   `internal/model/openai_test.go`（用一个本地 httptest 服务器断言**线上报文**）、
   `internal/runtime/composition_test.go`（路由切换 + `--no-stream` 的请求体与 delta）。
   这三个包目前**完全没有测试**，而三个 BLOCKER 全在里面。
2. **第二批（跟着 B5–B8、M12 走）**：新建 `cmd/tudouni/main_test.go` 或
   `internal/frontends/cli/cli_test.go`，把 `test_banner.py` 的 stdout/stderr 契约、
   `test_cli_usage.py` 的退出词与 `/status` 行、`test_timing_report.py` 的审计汇总搬过来。
3. **第三批（跟着 B9、B10、M1、M3 走）**：`internal/tools/builtin/jobs_test.go`
   （部分输出不算收过 / 记录腾位 / 两个上限分开 / 2 MiB 上限 / 按会话隔离目录）、
   `internal/agent/agent_test.go` 补串行批次的交错与步数上限的工具列表。
4. **第四批（跟着 TUI 的 10 条 MAJOR 走）**：在现有 `internal/frontends/tui/*_test.go` 里
   补答案按 `run_id` 归位、rail 自动顶开、`/thinking` 只认 `on`/`off`、`/quiet` 大小写、
   `/mcp` 错参数开面板、启动转圈、等人时停转。

## 四、一条元规则

`internal/i18n/en.go` 里有一批**定义了但全仓库没人读**的 key。它们的存在本身就是
「某个功能只搬了一半」的指纹。建议加一条测试：**目录里每个 key 都必须被至少一处引用**
（`i18n.Keys()` 加上对源码的 grep）。这条测试会一次性把下面这些暴露出来：

`notice.jobs.leftovers`、`notice.jobs.no_job_object`、`notice.grep.unsupported_platform`、
`notice.tools.header`、`notice.tools.row`、`notice.permissions.*`、`notice.model.session`、
`notice.reasoning.session`、`notice.todos`、`notice.skills.*`、`notice.autopilot`、
`notice.mcp.loaded`、`notice.mcp.ignored_workspace_file`、`notice.context.missing_window`、
`model.aliases`、`model.no_catalog`、`list.available`、`effort.no_catalog`、`effort.off_note`、
`thinking.effort`、`hint.arrows`、`tools.mark.*`（只有 TUI 用）……
