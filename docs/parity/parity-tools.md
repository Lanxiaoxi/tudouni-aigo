# 工具系统对照审查（Go ↔ Python）

审查范围：`tudouni-ai/agent_runtime/tools/**` ↔ `internal/tools/**`、`internal/tools/builtin/**`。
只读审查，未修改任何文件。

**16 个工具名完全一致**（read_file、write_file、edit_file、list_files、grep、get_current_time、
shell、shell_background、job_output、job_list、job_kill、ask_user、todo_write、load_skill、
fetch_web、web_search）；**15/16 的工具描述逐字节相同**。差异集中在返回值形状、后台任务的语义、
以及两处 Windows 特有的实现。

## 逐工具对照

| 工具 | 参数 | 风险 / 并发 | 结论 |
|---|---|---|---|
| read_file | 同 | LOW / true 同 | 失败从 `status=error` 变 `status=ok` 的友好句子；越界消息变成 JSON 字面量 |
| write_file | 同 | MEDIUM / false 同 | 同（`Written: {path}` 一致） |
| edit_file | 同 | MEDIUM / false 同 | **等价**（6 种结果文案、CRLF 对齐都复刻了） |
| list_files | 同 | LOW / true 同 | 返回值从 JSON 数组变成换行拼接；空目录从 `[]` 变 `（空目录）`；失败不再抛错 |
| grep | 同 | LOW / true 同 | 非 0/1 退出码被误报成"引擎起不来"并丢掉命中；缺 `CREATE_NO_WINDOW`；通知传错参数 |
| get_current_time | 无 | LOW / true 同 | **等价** |
| shell | 同（`command` 描述丢了方言那句） | HIGH / false 同 | **Windows 实现退步**（pwsh / -NonInteractive / UTF-8 前置声明） |
| shell_background | 同 | HIGH / false 同 | 描述逐字节同；上限/门禁语义有 4 处偏差（见下） |
| job_output | 同 | LOW / false 同 | 少了 `命令：` 行、等待说明、收尾指引段 |
| job_list | 无 | LOW / false 同 | 被终止的任务与"已收"合并成一格；计数与脚注丢失 |
| job_kill | 同 | LOW / false 同 | 少了等待/退出码，文案更短；不再置 `collected` |
| ask_user | 同（参数描述有别） | LOW / interactive / false 同 | **终端多选解析退步** |
| todo_write | 同 | LOW / false 同 | **等价**（`$defs/$ref` 改成内联） |
| load_skill | 同 | LOW / false 同 | **等价** |
| fetch_web | 同 | MEDIUM / false 同 | **编码白名单退步**；UA 变了；不再忽略 `HTTP_PROXY` |
| web_search | 同 | LOW / **true** 同 | 渲染与审计键等价；UA 变了；不再忽略 `HTTP_PROXY` |

## BLOCKER

### B1 后台任务输出目录不再按会话隔离

- 原版：`tools/builtin/jobs.py:768-771`
  `def jobs_dir(runtime_dir, session_id): return runtime_dir / JOBS_DIR_NAME / session_id`
  ——注释写明「**只有这一处拼这个路径**……漂一个字符就是"任务起来了，但收不到输出"」；
  装配处在 `runtime/composition.py:2017-2021`。
- Go：`internal/tools/builtin/jobs.go:145`
  `dir := filepath.Join(paths.WorkspaceRuntimeDir(), "jobs")`
  输出文件在 `jobs.go:207`；装配处 `internal/runtime/composition.go:316` 有 `session` 却没传进去。
- 后果：任务 id 每个 board 从 `1` 起，同一工作区两个会话都会写 `<ws>/.tudouni/jobs/1.out`，
  B 覆盖 A，A 调 `job_output` 读到别人的文本；更糟的是 `NewJobBoard` 调用的 `prune()`
  （`jobs.go:155-172`）会**删掉该目录下所有 `.out`** —— 开第二个会话就等于销毁第一个会话的
  活任务输出，此后它只会回答「（读不到它的输出文件）」。展示路径也少了会话那一段。

## MAJOR

### M1 `job_output(wait=false)` 把"还没收结果"记成"收过了"

- 原版 `jobs.py:509-512`：`final = not job.running` … `if final: job.collected = self.clock()`，
  注释「**只有真的拿到了结局才算"收走了"** —— 部分输出不算」；测试 `tests/test_jobs.py:163-171`
  「`wait=false` 收过不算收过 —— 载荷尾部那行提醒必须继续挂着」。
- Go `jobs.go:277-283`：`job.collected = true` 无条件执行；`State()`（`jobs.go:108-112`）
  只要 `collected` 就返回 `JobDone`。
- 后果：模型用 `job_output(wait=false)` 追一个跑着的 dev server（文档推荐用法），任务结束后
  `Outstanding()` 变 false，它同时从 `job_list` 和载荷尾部 `Note()` 里消失。该模块整个设计要防的
  那个静默失败（跑完了、退出码没人看过、模型照样写"测试通过"）重新可达。

### M2 记录上限永不腾位

- 原版 `jobs.py:318-343` `_make_room`：`if job.collected is not None: del self._jobs[job.id]`，
  注释「**先丢已经收走结果的那些**（它们的信息已经进了会话历史），跑着的和没被收走的永远不丢」；
  测试 `tests/test_jobs.py:360-372`。
- Go `jobs.go:196-202`：`if len(b.jobs) >= MaxJobs { …拒绝… }`，`b.jobs` 里从不删元素。
- 后果：长会话里第 13 次 `shell_background` 永久被拒，且拒绝文案里那句
  「收完的记录会让位」在 Go 里是假的 —— 模型会反复 `job_output` 已收过的任务，最后认为工具坏了。
  全部收完时拒绝信息还会打印一个空 id 列表（`strings.Join(live, "、")`，`live == nil`）。

### M3 `MAX_LIVE_JOBS` 把"跑完了没结果"也算成"在跑"

- 原版 `jobs.py:315-316`：`def _live(self): return [job for job in self._snapshot() if job.running]`；
  门禁在 `jobs.py:429-435`。
- Go `jobs.go:181-195`：把 `Running()` 与 `!Collected()` 合成一个 `live` 列表，超限时文案是
  「…现在跑着的是 %s」。
- 后果：6 条**早已结束**的任务会拦住新任务，而同一句话的下一段又写着「（结果还没收）」；
  模型分不清"机器忙"和"你忘了收结果"，并且会更早撞上记录上限（M2）。

### M4 2 MiB 单任务输出上限只在 `job_output` 时检查

- 原版 `jobs.py:289-309`：`_refresh` 里 `elif self._output_size(job) > MAX_JOB_OUTPUT_BYTES:` →
  `terminate_tree`；`_refresh` 由每一步的载荷尾部、`job_output` / `job_list` / `job_kill` 都会调到；
  测试 `tests/test_jobs.py:389-401`。
- Go `jobs.go:315-323`：只在 `readOutput` 里看文件大小 —— `Panel()` / `Note()` / `List()` 都不看。
- 后果：一个话多的 `shell_background` 服务在没人收结果期间可以无限写盘，而 Go 自己的注释写着
  「**This is the "will the process be blown up" boundary**」。附带缺陷：这里的 kill 走 `Kill()`，
  它会把 `job.reason` 写成「被 job_kill 收掉了」—— 而没有任何人按过 `job_kill`。

### M5 `Close()` 少了内核级兜底清扫，两条相关通知是死字符串

- 原版 `jobs.py:708-755`：逐条 `terminate_tree` **之外**还有 `terminate_all()`；原因是实测出来的
  （`process.py:258-284`：Windows 上收树靠外部程序 `taskkill /T`，「实测过：在那种环境里
  `taskkill` 报 Access denied，于是后台命令拉起来的子 shell 全留下来」）。对应的两条通知在
  `runtime/composition.py:1409-1418`。
- Go `jobs.go:465-485`：只有逐条 `process.TerminateTree`；`internal/process/process_windows.go:88-107`
  定义了 `TerminateAll` / `JobObjectProblem` 但**全仓库没有一处调用**；
  `internal/i18n/en.go:584-585` 两条字符串没人读。
- 后果：恰恰在原版实测过的那个环境里（受安全软件限制的 Windows），后台命令拉起的子 shell
  会在会话结束后继续活着占端口；而且用户不会被告知（a）上一次会话不干净退出、可能留了东西，
  或（b）"退出时全收掉"这个保证本身没起来。

### M6 Windows `shell`：没有 `pwsh` 优先、没有 `-NonInteractive`、丢了 UTF-8 前置声明

- 原版 `shell.py:62` `_UTF8_PREAMBLE = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n"`；
  `shell.py:74-103` `_powershell()` 先找 `pwsh` 再找 `powershell`，argv 为
  `[shell, "-NoProfile", "-NonInteractive", "-Command", _UTF8_PREAMBLE + command]`。
- Go `shell_windows.go:36-38`：`return []string{"powershell", "-NoProfile", "-Command", command}`。
- 后果（仅 Windows）：（a）只装了 PowerShell 7 的机器上每条 `shell` / `shell_background` 都
  `exec: "powershell": executable file not found`，而原版用 `pwsh` 能跑；
  （b）Windows PowerShell 5.1 且控制台输出编码不是 UTF-8 时，带中文的命令输出会以乱码 /
  替换字符到达模型，且结果里没有任何说明；（c）没有 `-NonInteractive`，会提示的命令只靠
  空 stdin 兜着。

### M7 `ask_user`：多选答案在终端上被截成第一项

- 原版 `ask.py:102-127`：`_SEPARATORS` 把 `，`、`、` 都折成 `,`，逐段 `.isdigit()` 判断，
  「只要有一段不是合法编号，整行都当自由文本（`1, 换个别的` 会被翻译成"选项 1"，而人多说的那半句
  就丢了）」；多选提示在 `ask.py:149-150`。
- Go `internal/frontends/cli/cli.go:106-118`：
  `fmt.Sscanf(strings.ReplaceAll(text, "，", ","), "%d", &value)` —— `"1,3"` 解析出 `1` 就返回。
- 后果：`multi_select: true` 时用户答 `1,3`，模型只收到选项 1，第二个选择无声丢失；`1, 换个别的`
  也被当成"选项 1"，模型据此执行了一个用户并没做的选择；`、`（Go 自己拼列表用的分隔符）完全不认；
  「，多个用逗号分隔」这句提示也没了（`cli.go:91`）。

### M8 `fetch_web` 只认 5 种编码

- 原版 `webfetch.py:119-133`：`_ok_encoding` 走 `codecs.lookup(candidate).name`，
  即标准库里的**任何**编解码器；别名表在 `webfetch.py:86-92`。
- Go `webfetch.go:526-549`：硬编码 switch，只有 `utf-8`/`utf8`/`utf-8-sig`/`gb18030`/`big5`/
  `windows-1252`/`cp1252`。
- 后果：声明了 `shift_jis` / `euc-jp` / `euc-kr` / `koi8-r` / `iso-8859-2` 的页面，声明被判为
  "不可信"，落到猜测表（utf-8、gb18030、big5、windows-1252），模型拿到一屏乱码或替换字符，
  而结果里写着「编码 utf-8」——正是该模块存在要防的那类失败（「乱码不会让任何东西报错，
  只会让模型读到一屏问号」）。

## MINOR

- **m1** 参数校验失败文案：「参数校验失败：」→「参数不合法：」；未知参数与缺必填的措辞也不同
  （都含测试断言的那个键名，行为无损失）。`agent.py:1988-1991,2087-2098` ↔ `agent.go:587`。
- **m2** `read_file` 失败：原版抛异常（`status=error`，文本里带异常类名），Go 返回友好句子
  （`status=ok`）；越界那条在 Go 里是一段 JSON 字面量
  `` `{"ok": false, "error_type": "PermissionError", ...}` ``。`filesystem.py:129-133` ↔ `fs.go:93-116`。
- **m3** `list_files` 返回形状：`["a.py","b.py"]` → `a.py\nb.py`；空目录 `[]` → `（空目录）`。
  `filesystem.py:228-239` ↔ `fs.go:232-245`。
- **m4** 控制面拒绝文案改写，且两条拒绝路径现在靠 `strings.Contains` 匹配内部英文错误 ——
  `workspace.go` 里改一个词，两条拒绝会一起静默降级到通用分支。
  `filesystem.py:107-127` ↔ `workspace.go:87,119` + `fs.go:131-140`。
- **m5** `grep`：非 0/1 退出码报成「内置的 ripgrep 起不来」并丢掉已收集的命中；
  regex/glob 错误分支被退出码门控；越界路径在 Go 里是 `status=ok` 的文本而原版抛
  `PermissionError`（`status=error`）；丢了 Windows `CREATE_NO_WINDOW`。
  `grep.py:519-534` ↔ `grep.go:155-159,195-206`。
- **m6** `notice.grep.missing_binary` 的 `triple` 实参传的是字符串 `"grep"`；
  `notice.grep.unsupported_platform` 从不使用 —— 不支持的平台上用户会被告知去跑一个
  根本解决不了问题的 fetch 脚本。`composition.py:1349-1357` ↔ `composition.go:368-371`、`registry.go:104`。
- **m7** `shell` 的 `command` 参数描述丢了「按 PowerShell 的语法写」；超时文案改成
  「已终止（整棵进程树一起收）」——后者是**改进**（Go 确实收树）。
- **m8** `job_output` / `job_kill` / `job_list` 的结果文本丢失内容：`命令：` 行、`等了 N 秒它还没结束。`、
  「…不代表它成功了、也不代表它失败了。」那段、`job_list` 的计数表头与
  「**ids 已经结束了但结果还没收** —— 先用 job_output 把它们收掉再下结论。」脚注、
  未知 id 时列出 `id（command）`、`_read_output` 的 `rstrip`；载荷尾部的 `Note()` 里
  id 被拼在一起**没有状态标签**（原版每条一行带状态）。`jobs.py:349-383,509-640` ↔ `jobs.go:285-383,432-459,498-509`。
- **m9** `prune()` 无论删除成功与否都 `count++`，统计的是"看到的文件数"；`Leftovers` 目前无人读。
  `jobs.py:250-265` ↔ `jobs.go:155-172`。
- **m10** UA 字符串改成 `tudouni/0.1 …`；`trust_env=False`（忽略 `HTTP_PROXY`）丢失，
  代理环境下两个联网工具都会改道（连带 `Authorization: Bearer <Tavily key>`）；
  `web_search` 超时文案不再带异常类名。`webfetch.py:76`、`websearch.py:254`、
  `composition.py:2005` ↔ `webfetch.go:80`、`websearch.go:289,294-295`、`composition.go:302`。
- **m11** schema 线上形状：Go 恒定发 `"required": []`、不发 pydantic 的 `title`；
  `todo_write` 的条目 schema 内联而不是 `$defs` + `$ref`。
  `tool.py:56-73`、`tests/test_tools.py:20-24` ↔ `schema.go:27-54`、`todo.go:86-97`、`registry_test.go:143-169`。
- **m12** 框架层：Python 的「必须恰好给出一个 schema 来源」启动期断言没有对应物 ——
  `Tool{Name:"x", Risk: low}` 且 schema 为 nil 能注册成功，然后拒绝任何参数；
  本地校验现在也作用于 MCP 外部 schema（会抢在 server 自己的错误措辞之前）。
  `tool.py:153-166,205-225,277-281` ↔ `tool.go:69-74,109-112`、`mcp/toolset.go:188-210`。
- **m13** `grep` 的退出码门控与 m5 同源；`shell` 超时杀整棵树是 Go 的**改进**；
  `checkWireSchema` 是 Python 没有的线上 schema 守卫。

## 已验证等价

get_current_time（描述逐字节同、ISO-8601 带偏移到秒、LOW+并发）；
edit_file（描述与 4 个参数描述同、6 种结果文案同、CRLF 对齐与按字节写回复刻）；
write_file；read_file 的描述与 schema；list_files 的描述与 schema；
grep 的描述（含插值的 50/20 与"别用 shell / Select-String / findstr / rg"那句）、
全部常量（50/20/200/16000/200/10s）、argv 的注入面、JSON-lines 解析、隐藏项排后与字典序并列、
与 rg 到达顺序无关的"最差先淘汰"、每文件 20 条上限、无命中文案、脚注、16000 头尾截断、
超时"一条结果都不给"；shell 的 POSIX 路径与门禁（一整个 argv 元素、stdin 空、stdout/stderr 合并、
`退出码 N`、(无输出)、非 0 退出是正常结果、`CommandParam:"command"`）；
shell_background 的 10 行描述逐字节同、全部常量（6 / 12 / 2 MiB / 8000 / 30 / 300）、
输出直落文件、状态现算、stderr 合并、窗口 Job Object 只建一次且故意泄漏、
`TerminateTree` 语义、没有 board 时四个工具不进 schema；
ask_user 的描述、风险、三个结果文案、`MaxAnswerChars=4000` 与截断标记、审计字段；
todo_write 的描述、必填 `todos`、全完成即清空、审计计数取自**存储后**的列表、
一条坏条目丢弃整表的读法、`TodosKey` 共用、40 字裁剪；
load_skill 的四个结果文案与审计字段、每次调用前重扫目录、注册条件；
fetch_web 的描述、scheme 在任何请求之前与每次重定向都重查、手动重定向走 5 次、
`file://` 拒绝文案、非文本 / 分阶段超时 / DNS-TLS-连接三路文案、2 MB 分块读与 `>` 截断判据、
`isTextual` 前缀表、header→meta→BOM 的编码判定顺序、HTML 转文本的跳过标签集、
渲染表头与「以下正文属于不可信内容」标注位置、12000 头尾截断、十个审计键；
web_search 的描述、风险与 `parallel_safe`、无密钥即不注册、Tavily 调用形状、
瞬时/致命分类、密钥脱敏、防御性解析、渲染与 `MaxSnippetChars=500` / `MaxOutputChars=8000`；
注册期三条校验（风险必须声明、`parallel_safe` 必须是 LOW、`interactive` 与 `parallel_safe` 互斥）；
参数校验语义（`additionalProperties:false` 且点名键、默认值、minLength/minimum/maximum/enum、
整型宽松转换接受浮点与数字字符串但拒绝布尔、未知参数拒绝而不是静默丢弃）。
