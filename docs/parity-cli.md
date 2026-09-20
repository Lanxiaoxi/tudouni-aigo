# 行式 CLI / 命令行接口对照审查（Go ↔ Python）

审查范围：`tudouni-ai/agent_runtime/main.py`、`frontends/cli/{args,__init__}.py`、
`frontends/ansi/**`、`protocol/serve.py` ↔ `cmd/tudouni/main.go`、`internal/frontends/cli/cli.go`、
`internal/frontends/report.go`、`internal/runtime/{composition,config,mcp}.go`。
只读审查，未修改任何文件。

**结构性事实（三条）**
1. Go **没有 `internal/frontends/ansi/` 包**，也没有第二个入口 —— 原版那个「非 TTY 的纯文本前端」
   （`ansi/__main__.py`，273 行）在 Go 里没有对应物，而 Go 的行式 CLI 也接不了这个位置
   （它一个 delta 钩子都不传，`cli.go:138-142` 只设了 `ShouldStop`）。
2. `cmd/tudouni` 与 `internal/frontends/cli` **一个测试都没有**。
3. 两侧各 16 个 flag，对称差只有：Python 独有 `--lang`，Go 独有 `--max-steps`。

## BLOCKER

### B1 提示符与所有命令答复写到了 stdout，原版全在 stderr

- 原版 `frontends/cli/__init__.py:1057` `print("> ", end="", file=sys.stderr, flush=True)`；
  整块 `/status` `/tools` `/context` `/mcp` `/model` `/thinking` `/effort` `/compact` 的答复都是
  `file=sys.stderr`（`:647,:652,:683,:718,:722`），契约写在 `:629-638`
  （「答案直接打到 stderr …… stdout 只留对话正文，README 承诺 `> 对话.txt` 拿到的是干净的答案」）；
  每轮用量行也在 stderr（`:1112-1114`）。由 `tests/test_banner.py:78-120` 盯着。
- Go `internal/frontends/cli/cli.go:121-129` 把 `out` 设为 `os.Stdout`，随后 `:156` 提示符、
  `:215/:218/:221/:230/:242/:256/:270/:283` 各命令答复、`:131-132` 版本行与审计行全走它。
- 后果：`tudouni > chat.txt` 拿到的文件里混进了提示符、版本行和每一屏命令输出 —— README 写明的
  契约失效。

### B2 `--audit` 的汇总块整块没了

- 原版 `frontends/cli/__init__.py:459-509`：`print_audit` 末尾调 `_print_audit_summary`，打印
  「模型调用 N 次（M 次成功）输入 … token（命中缓存 … / 未命中 …，命中率 …）输出 … token」、
  「工具调用 N 次 status=…」、`_print_timing(...)`（`:268-294`：模型 / 工具 /（并行省）/
  等人审批 / 等人回答 / 重试退避 / 未归因 / 回合总）、「回合结束原因 …」，外加一句成本提示。
- Go `cmd/tudouni/main.go:362-374`：`booted.Logs.Read(sessionID)` 之后只逐条
  `audit.FormatLine(record)`；没有表头、没有分隔线、没有汇总、没有计时。
  `state.HitRate`（`internal/state/status.go:96`）与 `state.ContextText`（`:131`）**定义了但从未被调用**；
  没有任何 Go 代码聚合 `waited_ms` / `backoff_ms` / `human_wait_ms` / `duration_ms`。
- 对应测试：`tests/test_audit_view.py:96-108`、`tests/test_timing_report.py:37-95`、
  `tests/test_cli_usage.py:43-207` —— Go 侧无对应物。
- 后果：`--audit` 再也回答不了"这个会话花了多少 / 时间花在哪 / 这一轮为什么结束"。

### B3 REPL 的退出词失效

- 原版 `frontends/cli/__init__.py:1063-1064`
  `if not line or line.lower() in {"exit", "quit"}: break`，在 `:1047` 的提示里写明。
- Go `internal/frontends/cli/cli.go:163-165` 空行 `continue`；`:166-177` 只有以 `/` 开头的行特殊；
  `exit` / `quit` 落到 `:179` 的 `current.RunTurn(text)`。只有 `/exit` `/quit`（`:198-199`）能退。
- 后果：照文档敲 `exit` **会把这句话当成用户消息发给模型**（一次真实计费往返）；
  空行也不再退出。

### B4 启动通知：Go 版只有 4 类，且只有 TUI 看得见

- 原版 `main.py:283` `_emit(runtime.notices(), audit_line=…)`，`_emit` 按 `notice.stream` 分派
  （`main.py:69-85`）；`composition.py:1311-1550` 产出约 20 类。
- Go `internal/runtime/composition.go:339-341`（web）、`:364-366`（mcp 已配置）、`:368-371`（grep 缺二进制）、
  `:387-390`（context 缺正文）——一共四处；它们只经 `InitFields()["notices"]`（`:656-659`）给前端，
  而**只有 TUI 读**（`internal/frontends/tui/model.go:347`）；`internal/frontends/cli/cli.go` 从不碰 notices。
- 原版有、Go 完全没有的（其中若干在 `internal/i18n/en.go` 里**字符串还在、只是没人用**）：
  上下文窗口未知；**工作区 `mcp.json` 被忽略**；**旧 `.env` 被忽略**（Go 甚至在
  `internal/state/catalog.go:319` 算好了 `Registry.Notes`，无人读）；**上一轮遗留的后台进程**；
  进程树回收能力不可用；**注册工具清单**（原版刻意走 **stdout**，是契约）；权限层各条
  （未知工具名 / 等级 / 拒绝表 / 命令规则）；本会话的 model 行；本会话的 thinking/effort 行；
  模型目录的 notes/problems；任务列表；技能各条；AGENT.md 各条；autopilot 警告。
- 后果：Go 的 REPL 启动是静默的，而原版认为"绝不该静默"的那几条警告（autopilot 已开、
  permissions.json 里写了不存在的工具名、`.env` 里有密钥但被忽略、工作区 `mcp.json` 被忽略、
  **上一次被杀的会话留下的后台命令可能还在跑**、收树保证没起来）在任何前端都看不到。

### B5 REPL 里的成本 / 用量报告整层没了

- 原版 `frontends/cli/__init__.py:1110-1114`：每轮往 stderr 打印
  「（会话 {id}：{n} 条消息、{m} 步；累计输入 … token（命中缓存 …、命中率 …）；本轮 …；
  上下文 …/…（…%）。）」，走 `_stats_note` / `_usage_note` / `_turn_note` / `_context_note`
  （`:514-593`），另外 `_report_todos` / `_report_jobs`（`:596-626`）给出 `[任务]` / `[后台]` 两行。
- Go `internal/frontends/cli/cli.go:179-186`：跑一轮、打答案、空一行，没了。
- 后果：运行中的成本、缓存命中率、上下文压力、还剩哪些任务，在 Go 的 REPL 里全看不见。

## MAJOR

- **M1 没有 ANSI / 非 TTY 前端**：原版 `frontends/ansi/__main__.py`（协议客户端、权限提示
  `:94-112`、提问 `:114-122`、流式增量 `:191-209`、事件版式 `:164-189`）。Go 无此包、无第二个入口、
  无等价 flag。原版文档允许它被扔掉（"第二期之后它的位置可以由 CLI 顶上"），所以定 MAJOR ——
  但顶替的路径在 Go 里也不存在。
- **M2 认不出的 `/` 开头的行被吞掉**：原版 `cli/__init__.py:1012-1013` `return False`
  （理由在 `:942-957`：「丢弃一句用户真的想说的话，比把一次打错字送给模型贵得多」），
  然后 `:1069-1070` 落到 `agent.run`；Go `cli.go:166-177` 无条件 `continue`，
  `:286-288` 打 `cmd.unknown`。后果：一条以 `/` 开头的正经消息（路径、正则、打错的命令）被丢弃。
- **M3 `/status` 从 14 行变 7 行**：原版 `:640-722`（会话含"这次启动：继续/新建"、工作区、规模、
  模型含 `（换成 X 的…）` + `@provider` + base_url、**思考**、**上下文**、**资料**、
  **预算**、**累计输入/累计输出**含缓存与命中率、**轮次**含审批/提问计数、**工具 N 个**、
  **这次运行**含 max_steps/流式/自动放行、**审计**路径）；Go `cli.go:338-368` 只有
  Session / Workspace / Size / Model / Endpoint / Turns。
  载荷层还有两处：Go 的 `StatusMessage` **没有 `context` 键**（原版 `composition.py:1196` 有
  `self.context.stats()`），且 `model.reasoning` 是**字符串**而不是 `{thinking, effort}` 对象
  （`composition.go:758` ↔ `composition.py:1184-1187`），导致 `tui/status.go:99-104` 永远回落到
  `thinking = true`。
- **M4 `/thinking` 恒报"开"、`/effort` 把可选值列表打在"当前强度"位置**：
  Go `cli.go:240-244` 无参数时直接 `i18n.T("thinking.mode", "state", i18n.T("thinking.on"))`；
  `:254-257` 打印 `i18n.T("effort.current", "effort", strings.Join(state.EffortLevels, " / "))`
  →「Thinking effort: low / high / max」。原版 `:923-939` 报真实状态 + effort，并且参数写错后会
  **重新打印状态**（`:1000-1010`、`:1017-1029`），Go 出错就 `return`。
- **M5 `--debug` 是静默空操作**（`--help` 里还写着它）：`internal/agent/agent.go:83`、
  `internal/protocol/server.go:66-67`、`internal/frontends/cli/cli.go:39` 三处只有字段与注释，
  全仓库没有一处读它。原版 `agents/agent.py:720-756` 的 `_debug` / `_debug_lazy` / `_preview`
  在 `:914,:1656-1671,:1814,:1848,:2066` 使用，`tests/test_debug_cost.py:66-74` 断言其输出。
- **M6 `--list` 丢了任务进度列，排序丢了两条已被测过的规则**：原版 `:341-350`
  （表头「已保存 N 个会话（目录）：」+ 每行 `  {id:22} {n:3} 条消息、{m} 步` + `；任务 {todo}`），
  README `:912` 专门说这一列是"哪个会话还剩着活"。Go `main.go:330-333` 打
  `messages=… steps=… <preview>`，用了 TUI 才需要的 preview，`runtime.SessionSummaries` 明明
  算好了 `todos`（`composition.go:133-135`），`en.go:354-360` 也有现成的 `session.row` 模板没人用。
  排序：原版按 `(metadata["created_at"] or 文件 mtime, session_id)` 降序
  （`composition.py:348-373`，由 `tests/test_session_list.py:71-103` 钉住 mtime 回退与 id tiebreak）；
  Go `composition.go:94-101` 只比较 `created`（缺失即 `0.0`），**把刚收集到的 `modified` 丢在一边**，
  也没有 id tiebreak —— 老会话（无 `created_at`）会沉到所有新会话下面。
- **M7 `--skills` 丢了每个技能的描述、正文大小、声明的工具与 `✓` 存在标记**：
  原版 `:353-392`（目录行带 `'✓' if path in catalog.roots`；每个技能三行
  `  {name:20} 正文 {body_chars:>6} 字符  声明的工具：{tools}` / `  {desc}` / `  ` 来自 {path}`；
  最后 `[遮蔽]` 与 `[跳过]`），docstring 说描述是"模型判断什么时候该用的唯一依据"。
  Go `main.go:294-317` 只打 `name（path）`，`SourceLines` 打目录（没有 `✓`），
  问题行走 **stderr** 而清单走 stdout；`Skill.Description` / `AllowedTools` / `BodyChars()`
  （`internal/skills/loader.go:70-93`）都在，只是没印。
- **M8 四个不需要模型的子命令绕过了工作区检查与会话 id 校验**：原版 `main.py:122-125`（工作区，
  退出 2）与 `:185-188`（会话 id，退出 2）都在 `boot()` 与 `:192-209` 那四个子命令**之前**，
  并有专门的测试 `tests/test_main_entry.py:111-120`；Go `main.go:77-85` 先 `return` 了
  `showSkills()` / `listSessions()` / `showAudit()`，`checkWorkspace()` 在 `:97-100`、
  id 校验在 `:101-105`。后果：在 `$HOME` 下 `tudouni --list` 在 Go 里成功（原版退出 2 并解释原因）；
  `tudouni --session a/b --list` 退出 0 而不是 2（路径穿越本身仍被 store 挡住，但报错来源与文案变了）。
- **M9 `--history` 丢了 artifact 注释并直接倾倒完整正文**：原版 `:395-456`（表头
  「会话 {id!r}：{n} 条消息，{m} 步」、72 个短横线、`{i:3} {role:9} {preview}(76 字)`、
  assistant 的 `→ 调用 {name}({args[:64]})`、tool 行的 `_artifact_note` →「（Artifact {id}：{chars} 字符，
  {path}，{lines} 行，正文在 {content_ref}）」；README `:1805` 记着这一行）。
  Go `main.go:348-359` 只打 `--- role ---` 加完整正文；`internal/context/ref.go` 完全没被查。
- **M10 CLI 的 `/mcp` 藏起了失败原因**：原版 `:830-872`（`MCP_MARK = {"loaded":"●","unload":"○","failed":"✗"}`，
  failed 行是 `没连上：{row['error']}`，加 `where` 行与页脚
  `挂一个：/mcp load <名字> · 卸一个：/mcp unload <名字>`；docstring 说"为什么没连上只在 failed
  那一档里，跟着 error 一起打出来"；`tests/test_cli_mcp.py:92-114` 断言 `✗ bad` + `没连上` + 错误文本）。
  Go `internal/frontends/report.go:224-259` 把所有非 loaded 状态都渲染成 `mcp.not_loaded`；
  `mcp.not_connected` / `mcp.no_reason`（`en.go:348-349`）只有 TUI 面板在用；没有状态标记、没有页脚、
  没有 local/remote 写法指引；`/mcp load` 少名字或写错动作时**静默变成列表**，
  原版会打「认不出这个写法：{rest}（用 /mcp load <名字> 或 /mcp unload <名字>）」（`:985-987`，
  `tests/test_cli_mcp.py:143-157`）。
- **M11 EOF 时不收摊，MCP 子进程与后台任务不会回收**：原版 `main.py:265` `with runtime:` →
  `Runtime.close()`（`composition.py:1714-1746`，先收任务，"一个没被收掉的 dev server 还占着端口"），
  `run_repl` 的 EOF 分支只是 `break`（`:1059-1061`）所以 `with` 会展开。Go `cli.go:157-161`
  在 EOF 时直接 `return 0`，`Close()` 只在 `/exit`（`:169`）与切会话（`:173`）时调用；
  全仓库没有任何 `signal.Notify`，所以 Ctrl-C 也走默认处理，同样不收摊。
- **M12 `--tui` 丢了进备用屏之前的配置预检**：原版 `main.py:139-147` 在 `run_tui` 之前跑
  `check_config()`（理由见 `composition.py:241-268`：备用屏没有回滚缓冲，子进程那句配置报错
  会变成一屏截断、滚不动的乱码），`tests/test_main_entry.py:209-227` 断言退出码 2 且 **stdout 为空**。
  Go `main.go:117-127` 直接 `tui.Run`，`tui/tui.go:69-75` 先起子进程再 `tea.WithAltScreen()`。

## MINOR

- 没有启动横幅（原版 `cli/__init__.py:59-80` 的纯 ASCII 画，走 stderr；`main.py:216`）。
- 没有会话身份两行（原版 `main.py:277-281` 走 stdout；`tests/test_banner.py:107` 断言
  `新会话 'stream-check'`）。
- 审计行给的是 **logs 目录**而不是 `<id>.jsonl`，而且走 stdout（原版 `composition.py:1701-1710`
  合成 `directory/<id>.jsonl`，由 `main.py:283` 最后打到 stderr）。**这一条已决定保持不变**：
  审计路径是读 `> 对话.txt` 的人唯一会回头复制的一行，改流会移动每份保存下来的对话的开头两行。
  口径以 `internal/frontends/cli/cli.go` 里 `Run` 的注释为准（该注释此前写成"版本行与审计行
  走 stderr"，与代码相反，已修正）。
- 不回声 `--- 用户输入: {line} ---`（原版 `:1072`，stdout）；Go 改成多打一个空行。
- `/tools` 丢了 `可用工具` 表头与 `按过 t`/`外部`/`会问你`/`可并发` 标记（原版 `:799-827`；
  `tools.mark.*` 在 `en.go:375-378` 只有 TUI 用）。
- `/model` 无参数时丢了 `当前模型：{route}`、每行的 `{provider}/{id}  {summary}   （{label} · 上下文 {window}）`
  与"认下的旧名字"几行（原版 `:896-920`；Go `cli.go:318-336`），且 `/model x` 失败后不再重印清单。
- `/model a b` 参数处理不同：原版把整段 remainder 传下去（`:961-962`），Go 只取 `arguments[0]`（`cli.go:237`）。
- 非 TUI 路径缺 `--stream` / `--quiet` 的"已忽略"说明（原版 `main.py:225-227`、`:232-234`）；
  而且 Go 的 CLI 分支把 `--stream` 默认成了 `true`（`main.go:150,164`）—— 原版 CLI 默认是**关**
  （`args.py:102-109`）。Go 传了 `Stream: opts.stream` 却没有 `OnDelta`，所以两种取值输出都一样。
- 缺 `[ericai] 正在检查 EricAI token（需要时会自动登录/刷新）…` 进度行；且 `--ericai` 在 Go 里
  排在 `checkWorkspace` **之前**（`main.go:90` vs `:97`），原版在工作区检查（`--tui` 还要在
  `check_config`）之后。
- `--history` 遇上不存在的会话：原版 `main.py:209` 未包住 → traceback、退出 1；Go `main.go:349-353`
  打 `store.missing_file`、退出 2（更干净，但退出码不同）。
- `--audit` 无记录时丢了目录（原版 `:466-468`）；缺「会话 {id!r} 的审计轨迹：{n} 条」表头与 78 短横线（`:470-471,497`）。
- `--audit` 行版式不同：原版 `:483-484` `{ts[11:]} {kind:<13} step={step:<3} {body[:100]}`
  （只有时间、按插入顺序、100 字截断、缺键打 `?`）；Go `audit/view.go:16-53` 打完整时间戳、
  `step`、`kind[session=…]`，第二行缩进按**字母序**排列 `k=v` 且不截断（防御性行为两边都保留了）。
- flag 优先级不同：原版 `--tui`(`:140`) → `--runtime-stdio`(`:177`) → `--list`(`:193`) →
  `--skills`(`:197`) → `--audit`/`--history`(`:201`)；Go 是 `--skills` → `--list` →
  `--audit`/`--history` → `--tui` → `--runtime-stdio`。于是 `--tui --list` 在 Go 里只是列个清单就退出。
  会话 id 的校验位置也因此不同（原版在 `--tui`/`--runtime-stdio` 之后 `:186`，Go 在之前 `:101`）。
- 未知位置参数被静默忽略：Go 的 `parse`（`main.go:173-181`）从不看 `flags.Args()`，而 Go 的 `flag`
  遇到第一个非 flag 就停止解析，于是 `tudouni foo --list` 会直接进 REPL 并忽略 `--list`；
  原版 argparse 报 `unrecognized arguments: foo` 并退出 2。
- 坏 flag 会打两遍错误，且 usage 走到 **stdout**（`main.go:64-68` 与 `:153-154`）。
- `--help` 缺 `-h/--help` 自身的说明，`--stream/--no-stream` 挤成一行且没写默认值，
  `--theme` 写成 3 套配色（与 Python 的 13 套不同，但这条属于已排除范围）。
- 原版 REPL 不打 `tudouni {版本}` 行，Go 打了（`cli.go:131`）——这是新增，不是缺失。

## 已验证等价

- `/context`、`/compact`、`/tools`（内容）、`/mcp`（load/unload 机制）在 Go 里都有，走共享的
  `internal/frontends/report.go`（`RenderContext` / `RenderCompaction` / `RenderTools` / `RenderMCP`）
  与 `Runtime.*Message`；五种 compaction 结果、"没有上下文管理"的措辞、"窗口未知就不报百分比"、
  "错的百分比比没有更坏"、"什么都没有删掉"的页脚都在。差异只是行拆分/标签与上面列的缺标记。
- 15 个共有 flag 两侧都接受；`--session` 语义一致（缺 id = 新会话；文件不存在 = 用这个名字新建）。
- 退出码 2 的场景两侧一致：没有可用路由、`permissions.json`/`mcp.json`/`web` 写坏、工作区不安全、
  `--session` 非法、参数错误、`--audit`/`--history` 缺 `--session`、`--runtime-stdio` 配置失败；
  `--help`/`--version` 都是 0。分歧只在上面 M8（只读子命令）、M12（`--tui`）、以及
  `--history` 缺会话（退出码）。
- 四个只读子命令确实都不需要密钥（两侧都在 `open_runtime` 之前）。
- EOF 处理一致（换行 + 退出 0，最后一行无换行也照样处理）。
- 两侧都没有 readline 历史与多行编辑（原版用裸 `input()`，Go 用 `bufio.Reader`）——这条不是差异；
  提示符处的 Ctrl-C 是例外（见 M11）。
- 审计读取的容错（跳过错行、缺 `kind`/`ts`/`step` 打占位符）在 Go 里保留。

## 假前提更正

`/quiet`、`/export`、`/jobs`、`/theme`、`/new`、`/resume`、`/help`、`/autopilot` **不是** Python
行式 CLI 的命令（在 `frontends/cli/__init__.py` 里 grep 这些字面量没有命中）；`/new`、`/resume`、
`/theme`、`/quiet` 只存在于 TUI（`frontends/tui/view_state.py:2226-2241`），
`/export` 与 `/jobs` 在整个项目里都不存在。Go 的 CLI **多**实现了 `/exit` `/quit` `/help` `/new`
`/resume` `/skills` `/autopilot` —— 这些是新增，不是缺失。

## 本轮之后的主动偏离

上面记的是"Go 版比原 Python 版少了/多了什么"，下面这几条**不是**移植没做到，是有意改掉的
——以后再对账时别把它们当成 bug：

- **默认界面反过来了。** 原版与此前的 Go 版都是"裸跑 = 行式 REPL，`--tui` 才是全屏"。现在
  裸跑就是全屏界面，`--cli` 要回行式 REPL；`--tui` 仍然接受，并作为强制开关保留。显式 flag
  之间的优先级没变（`--tui` 先于 `--runtime-stdio`），所以上面那条 flag 优先级记录依然成立；
  变的只是"没给 flag 时给哪一个"。
- **非终端自动回落。** stdin 或 stdout 不是终端时（`> chat.txt`、管道、CI），裸跑走行式
  REPL，以保住 `cli.go` 里那条 stdout 契约。显式给了 `--tui` 就不再回落 —— 它是有意要的。
- **命令改名 `tudouni` → `tudouni-aigo`。** `internal/version.Name` 是唯一来源（`--help`、
  flag set 的名字、打包出来的可执行文件名都从它取）。安装脚本另外留一个 `tudouni` 的别名，
  并顺手收走旧名字装的那一份。数据目录（`~/.tudouni`、工作区的 `.tudouni/`）**没有动**。

