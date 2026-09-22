# agent 循环 / 模型适配 / 流式 / 重试 / 运行时装配 对照审查（Go ↔ Python）

审查范围：`tudouni-ai/agent_runtime/{agents,models,runtime}/**` ↔
`internal/{agent,model,runtime}/**` + `internal/protocol/channels.go`。
只读审查，未修改任何文件。

## BLOCKER

### B1 思考开关与强度：`extra_body` 没有被摊平，`/thinking off` 到不了端点

- 原版 `state/reasoning.py:129-131` 造出 `{"reasoning_effort": effort, "extra_body": {"thinking": {...}}}`
  并交给 OpenAI SDK 的 `**request_fields(...)`（`models/openai_compatible.py:481`、`:578`）——
  `extra_body` 是 SDK 的**逃生口参数**，SDK 会把它**摊平进顶层请求体**。原版测试直接断言线上报文：
  `tests/test_providers.py:202` `assert request["thinking"] == {"type": "enabled"}`。
- Go `internal/state/reasoning.go:103-113` 返回同样的 map，而 `internal/model/openai.go:220-222`
  `for key, value := range state.RequestFields(...) { body[key] = value }` 把它**原样**写进手写的 JSON body。
- 后果：请求里出现一个字面的 `"extra_body"` 对象，顶层**没有** `thinking` 字段。`/thinking off`
  在端点上是空操作（思考照旧打开、照旧计费），而这个未知参数恰恰是严格 OpenAI 兼容网关会用 400
  拒掉的东西。`reasoning_effort` 走顶层是对的，所以 `/effort` 不受影响。

### B2 跨路由 `/model` 只改了名字，请求仍打旧端点旧密钥

- 原版 `agents/agent.py:588-601`：
  `same_route = (not provider or provider == self.model_provider) and (api_key == "" or api_key == getattr(self.model, "_api_key", None))`
  … `else: self.model.install(api_key=api_key, base_url=base_url, model=name, provider=provider)`；
  适配层 `models/base.py:68-81`、`models/openai_compatible.py:390-411`；调用方 `runtime/composition.py:1052-1058`。
- Go `internal/runtime/composition.go:962-975`：`if !r.Chat.SwitchModel(ref.ID) { return false, ... }`
  然后 `r.ModelState.SelectRoute(ref.Provider, ref.ID, 0)`；`SwitchModel` 只做
  `m.model = strings.TrimSpace(name)`（`internal/model/openai.go:119-125`）。**Go 的 `ChatModel`
  接口里根本没有 `Install`**（`internal/model/types.go:125-140`），`SetModel` 也从不把
  `ref.Provider` 的 base_url/api_key 传下去。
- 后果：`/model two/m-two` 报成功，`/status` 与 `ui(state)` 显示 `provider=two`，会话文件里也记
  `two/m-two` —— 而之后每一次请求仍然发往路由一的端点、用路由一的密钥。这正是原版那条测试的名字
  （「界面说换了、请求没动」，`tests/test_model_switch.py:453-475`、`tests/test_providers.py:311-355`）。
  只有会话中途切换是坏的：恢复会话时会按存储的 provider 重建适配器，那条路是对的。

### B3 `--no-stream` 在协议路径上被忽略；`--stream` 在行式 REPL 上无效

- 原版两头都门控：`runtime/composition.py:2158` `on_delta=on_delta if stream else None`，
  `agents/agent.py:831`，README `:1685-1687`，测试 `tests/test_streaming.py:526-543`。
- Go 无条件把 server 的 delta sink 交给 agent：`internal/protocol/serve.go:50-54`
  （`OnDelta: server.OnDelta`，没有引用 `stream`），`internal/runtime/composition.go:405`
  （`OnDelta: options.OnDelta`，没有引用 `options.Stream`），而 `InitFields` 照旧报 `"stream": r.Stream`
  （`composition.go:673`）。`server.OnDelta`（`internal/protocol/server.go:711-748`）无条件发
  `delta` / `delta_reset`。
- 后果：`tudouni --tui --no-stream` 请求体里带 `stream: true`、界面照旧边收边画，而 `init.stream`
  与状态栏说没在流式。反向：进程内的行式 REPL 从不设 `OnDelta`（`internal/frontends/cli/cli.go:138-142`
  只传 `ShouldStop`），所以 `--stream` 在那里也什么都不做，而 README 说 `--stream` 会为老 CLI 打开流式。

### B4 任务列表不再贴到载荷尾部，模型看不到当前 todos

- 原版 `runtime/composition.py:2296-2304`：`notes(metadata)` 返回
  `"\n\n".join(filter(None, (catalog_part(...), skill_note(...), todo_note(metadata), job_note(jobs))))`；
  `todo_note` 在 `tools/builtin/todo.py:110-128`，渲染 `## 当前任务（你自己维护的列表）` + 每项一行。
- Go `internal/runtime/composition.go:579-601`：只拼 `r.Jobs.Note()`、`skills.CatalogPart(...)`、
  `r.Skills.Note()`；`internal/tools/builtin/todo.go` 里**没有 `Note` 方法**（只有 `ProgressLine`，`todo.go:50`），
  全 `internal/` 里 grep 不到 `todoNote`，`TodosKey` 在 `todo.go` 之外也没有消费者。
- 后果：`todo_write` 照旧把列表写进 metadata（rail 与 `/status` 看得见），但模型在"决定下一步做什么"
  的那一刻不再被告知"还剩什么 / 正在做什么"，需要从历史里的旧副本里翻回来 —— 正是原版
  README「任务列表」一节说这个功能要防的失败。附带：四段的顺序也变了（原版把后台任务警告放在
  **最后**，理由是它离模型要生成的那个 token 最近，"不看就会出错"），Go 放到了最前。

## MAJOR

### M1 流式中途不能取消：Esc 不再能停下正在生成的答案

- 原版 `agents/agent.py:361-373`、`:421-423`：`_DeltaRelay.text/reasoning` → `_check_cancelled()`
  抛 `RunCancelled`；README `:1646-1649`；测试 `tests/test_streaming.py:588-623`。
- Go：唯一的 `ShouldStop` 检查在循环开头（`internal/agent/agent.go:228`）；delta 转发
  （`agent.go:338-344`、`:379-384`）完全不看它。
- 后果：`interrupt`（Esc）只是置了个标志，要等下一个 step 边界才被看到 —— 用户得把剩下的整段答案
  等完（数秒到数十秒），而流式本来就是为了把这个代价赚回来。

### M2 串行批次改成"整批先审批再执行"

- 原版 `agents/agent.py:1852-1867` `_run_serial`：`for index, call in enumerate(batch):`
  「报调用 → `_prepare` → `_run` → 报结果」逐条相邻；README `:1635-1637` 把它写成规则。
- Go `internal/agent/agent.go:501-524` `runBatch`：先把**整批** `a.prepare(index, call)`
  （含审批）做完，再决定并行还是串行；Go 的注释（`:496-500`）把"审批全部先做完"写成了有意选择。
- 后果：在会问人的策略下（例如 `auto_approve: []`），人在看到第 n 条结果之前先被问第 n+1 条 ——
  而原版规则第 3 条明确说"上一条的结果"是人判断下一条的依据之一。审计事件的交错形状也跟着变
  （原版串行路径是逐条交错的 `tool_call`+`permission`+`tool_result`，Go 是整批 call/permission
  再整批 result）。并行路径的策略被套到了串行路径上。

### M3 撞步数上限时 `Tools` 装的是整轮的工具名

- 原版 `agents/agent.py:1702` 每一步重新赋值 `last_tools = [call["name"] for call in response.tool_calls]`，
  `:1727` 放进异常；测试 `tests/test_step_limit.py:39` 断言 `exc.value.tools == ["list_files"]`。
- Go `internal/agent/agent.go:164` 一轮只 `a.toolsUsed = a.toolsUsed[:0]` 一次，`:508` 在批次循环里
  `append`，`:327` 把整个切片塞进 `&StepLimitExceeded{Step: a.step, Tools: a.toolsUsed}`。
- 后果：第 120 步时报错信息是「撞在：」后面跟整轮上百个工具名，而不是"这一轮卡在哪几个工具上"——
  这条信息唯一的线索被毁掉了。

### M4 启动通知只剩约 4/20（详见 `docs/parity/parity-cli.md` 的 B4）

- 原版 `runtime/composition.py:1311-1550` + `main.py:283`，协议侧同样在
  `protocol/channels.py:1221-1224` 发出。
- Go `internal/runtime/composition.go:339`、`:365`、`:369`、`:388` 一共四处 `notice(...)`；
  `InitFields` 的 `"notices"`（`:656-658`）只被 TUI 读；行式 CLI 一条都不打。
- 这一段与 CLI 侧同源，此处不重复展开。

### M5 `/model` 的名字形式：裸路由名被拒，且没有"已经是它了"的幂等回答

- 原版 `runtime/composition.py:1017-1028`：`elif not provider_name and self.model_registry.provider(wanted) is not None:`
  → 取该路由的第一个模型；`:1048-1049`：`if self.current_model == ref.id and self.current_provider == ref.provider:
  return True, i18n.t("model.select.already", ...)`；测试 `tests/test_model_switch.py:428-434`、`:478-489`。
- Go `internal/runtime/composition.go:943-961`：`ref, ok := catalog.Find(name, "")`，而
  `Find`（`internal/state/catalog.go:168-190`）只认 `provider/model` 或唯一的模型 id，
  裸路由名直接落到 `i18n.T("model.select.unknown", ...)`；也没有同名检查。
- 后果：`/model acme` 报"未知模型"而不是切到那条路由的第一个模型；`/model <当前模型>` 报
  "switched to X from X" 而原版报"已经是 X 了"。

### M6 MCP 的信任组（`a` 键）是死代码，没有任何地方提供 lookup

- 原版 `runtime/composition.py:2103-2129`：`mcp_trust_group(tool_name)` → `mcp.group(tool_name)`
  → `TrustGroup`，交给 `channels.asker_factory(memory, mcp_trust_group)`。
- Go `internal/runtime/composition.go:373-376`：`asker = options.Channels.AskerFactory(memory, nil)`
  —— `security.TrustGroupLookup` 恒为 `nil`，于是 `internal/security/asker.go:163-170` 的
  `if memory != nil && options.TrustGroup != nil` 永不成立、`:177-179` 的 `a =` 提示行永不出现、
  `:207-212` 的 `case "a"` 永不生效；TUI 的 `internal/frontends/tui/keys.go:928-931`
  `case "a": if hasTrustAll { return decide("always_group") }` 因此不可达。
  Go 的 `internal/mcp` 包也没有"按 server 分组"的函数（`Names` 只是给通知用的 server 名列表）。
- 后果：一个 MCP server 有 ≥2 个工具时，原版提供的「一次放行这个 server 的全部 N 个工具」
  永远不会出现，用户只能一个个批。协议、security、TUI 三处脚手架都在，缺的只是接线。

## MINOR

- **m1** `tool_result` 不再带 `parallel: true`：原版 `agents/agent.py:1844`
  （`**({"parallel": True} if parallel else {})`，调用点 `:1901-1905`，README `:1644`，
  `tests/test_parallel.py:199`）；Go `internal/agent/agent.go:624-643` 的 `reportToolResult`
  没有这个字段，`:621` 传的第三个参数 `ok bool` 根本没被用。`tool_batch` 本身是正确发出的。
  后果：日志无法逐条区分并发批次与串行批次，而消费这个键的"并行省"统计在 Go 里整块不存在
  （grep 不到 `saved_ms` / `unattributed` / `Timing`）。`tool_batch.wall_ms` 有发，所以这是接线遗漏。
- **m2** `run_started` 不再记录用户说了什么：原版 `agents/agent.py:1594-1595`
  `user_input=self._preview(user_input, AUDIT_PREVIEW_LIMIT)`；Go `agent.go:205` + `:210-221`
  只记 model/provider/thinking/effort/effort_levels。后果：审计里开一轮的那条行不再说明这一轮
  是关于什么的。
- **m3** `context_degraded` 的 step 语义不同：原版 `agent.py:1051-1063` 硬编码 `0`，
  Go `internal/agent/context.go:124` 用 `a.step`。后果：同一类事件在两边落在不同的
  `(run_id, step)` 分区里（Go 的值看起来更有用，记下来是为了让这是决定而不是漂移）。
- **m4** 只有 tool_calls 的流式回合丢摘要字段：原版 `models/openai_compatible.py:309`
  `streamed=bool(content or reasoning or self._tools)` + `agent.py:895-898` 只要 `response.streamed`
  就写；Go `internal/model/stream.go:154-159` 无条件 `Streamed: true`，但
  `internal/agent/agent.go:445-449` 以 `StreamChunks > 0` 为条件。后果：原版写
  `streamed=true, stream_chunks=0, streamed_chars=0`，Go 什么都不写（"完全没有文本"那种情况两边一致，
  `tests/test_streaming.py:566-585` 钉的是那一种）。
- **m5** 未知工具 / 参数不是合法 JSON 被归类成 `invalid_args` 而不是 `error`：
  原版 `agents/agent.py:1930-1953`（`except Exception` → `_Outcome(f"工具执行失败：{type(exc).__name__}: {exc}", "error", ...)`），
  Go `internal/agent/agent.go:556-569`（`fail(statusInvalidArgs, "没有这个工具：…")`、
  `"参数不是合法 JSON：…"`）。后果：`tool_result.status` 的语义两边不同，任何"有多少工具调用失败"
  的统计口径都会变。Go 的文案对模型更友好，看起来是有意的，这里只是标出来请你确认。
- **m6** `__runtime_note` 被写进了发给 API 的消息：原版 `state/model.py:176`
  `return {"role": "user", "content": text}`；Go `internal/state/model.go:158-162`
  带 `RuntimeNoteKey: true`（常量在 `internal/state/session.go:88`），`internal/agent/context.go:81-92`
  原样透传。后果：模型换路由那条通知以一个"多带一个布尔键的 user 消息"发出去，宽容的网关忽略它，
  严格的可能 400。修法应该是**在组载荷时剥掉**这个标记（`Session.UserInputs` 还要靠它），而不是删掉。
- **m7** `--tui` 没有配置预检（详见 `docs/parity/parity-cli.md` 的 M12）。
- **m8** `stream_options` 降级时会丢掉已经流出去的那半段：原版 `models/openai_compatible.py:536-555`
  在 while 循环**之前**建累加器、循环**之后** `as_response()`（注释「攒着的东西不丢」），
  测试 `tests/test_streaming.py:337-376`；Go `internal/model/openai.go:143-160` 重新调
  `completeOnce`，而 `internal/model/stream.go:25-26` 每次调用建新累加器。后果：原版返回
  「前半段后半段」，Go 只返回「后半段」，历史丢了用户已经看见的文本（实际触发条件很窄：
  网关先发 body delta、再拒 `stream_options`）。
- **m9** 流式累加器可能被重发的 name 片段覆盖：原版 `models/openai_compatible.py:249-250`
  `slot["name"] = slot["name"] or name`（取第一个），Go `internal/model/stream.go:142-147`
  `if name != "" && !strings.Contains(call.Name, name) { call.Name = name }`（取最后一个片段）。
  另外 Go 在缺 `index` 时用 delta 位置（`stream.go:125-128`），原版用 `0`。
  后果：对把函数名拆成多块的网关，两边最终都会报"未知工具"，但文案不同。
- **m10** 工具抛异常时不再打 traceback，审计写入的 panic 被静默 recover：
  原版 `agents/agent.py:96-102`（`_TOOL_LEVEL_ERRORS`）、`:2010-2032`（`_bug_report` /
  `_report_tool_bug` 把完整 traceback 打到 stderr）、`:658-663`（sink 抛错时大声警告）；
  Go `internal/agent/agent.go:603-610` 只打一行 `tool %s failed: %v`，
  `:468-478` 的 `emit` 用 `defer func() { _ = recover() }()` 静默吞掉。
  后果：工具真出 bug 时运维拿到的是一句概述而不是 traceback（给模型的文本两边都对）；
  Go 的静默 recover 与 README「吞掉，但要在 stderr 大声说出来」那条规则冲突
  （`Runtime.onEvent` 对写错误确实会警告，所以实际暴露面是"自定义 sink 里的 panic"）。
- **m11** 审计里的参数预览不再压平换行：原版 `agents/agent.py:750-756` 先
  `flat = text.replace("\n", "\\n")` 再截断；Go `internal/agent/agent.go:717-727` 的 `firstN`
  只按 rune 截断。后果：多行的 `write_file` / `shell` 参数会把换行原样留在
  `tool_call.arguments` 与 `permission.arguments` 里，`--audit` 那种按行看的视图和定宽日志渲染
  形状变了（JSONL 本身仍合法，两边的「…(共 N 字符)」都在）。

## 已验证等价

- **重试策略**：`agents/retry.py:29-166` ↔ `internal/agent/retry.go:24-137` —— 3 次尝试、
  退避 0.5s/1.0s、上限 8s、致命错误立即抛出并记一条 attempt、每次尝试都记录
  （`number`/`status`/`duration_ms`/`error`/`backoff_ms`）、同一个 clock、重发同样的消息与工具、
  错误逃出去之前先记 `run_finished` 的 `model_error` vs `model_fatal`；
  `delta_reset` 只在真的流出过东西时才进审计；重复的 UI reset 无害。
- **消息不变量**：每条会追加带 `tool_calls` 的 assistant 消息的路径，都在任何检查点之前追加了
  每个 id 恰好一条 tool 结果 —— `runBatch` 无论被拒绝、未知工具、JSON 非法、schema 不合法还是
  handler panic（`internal/tools/tool.go:102-107` 把 panic 收成正常错误结果），
  都 `agent.go:539-541` 发一条 `toolMessage`；检查点只落在整步边界
  （`agent.go:193-195,302-304,318-320,324-326` ↔ `agent.py:1589,1699,1714`）；
  模型失败发生在 assistant 消息被追加之前（`agent.go:267-282`），所以失败的一轮只留 `["system","user"]`。
- **并发批次**：全有或全无、≥2 个调用才并行、`MAX_PARALLEL = 8`、未知/非法调用强制串行、
  结果按模型给的顺序追加（`agent.go:501-543` ↔ `agent.py:1783-1801`）；
  注册期校验一致（`parallel_safe` 必须 LOW、`interactive` 与 `parallel_safe` 互斥）。
- **流式**：`on_delta == nil` ⇒ 走非流式、请求体里没有 `stream`（`openai.go:138-141` ↔
  `openai_compatible.py:467-469`）；增量按字段路由而不是按位置；只对非空片段回包；
  tool call 按 `index` 合并；`id` 取第一个非空；usage 是替换而不是累加（缺省是 `None` 而不是 0）；
  占位槽被丢弃；只有工具调用的回合 `content = nil`；`stream_options: {include_usage: true}`
  带 `(base_url, model)` 维度的拒绝记忆与 stderr 警告；审计拿到
  `streamed`/`stream_chunks`/`streamed_chars` 与**未截断**的 `reasoning`；任何 delta 都不进审计。
- **错误映射 / 请求构造**：408/409/429/≥500 与网络失败 ⇒ 瞬时，其余（含无法识别的）⇒ 致命
  （`openai.go:340-359` ↔ `openai_compatible.py:83-112`）；usage 取
  `prompt_tokens_details.cached_tokens`；reasoning 取 `reasoning_content` 或 `reasoning`；
  `base_url` 去掉尾部 `/`；`tools` 为空时不发（Python 发 `[]`）；两边都没有
  `temperature` / `max_tokens`。
- **思考/强度的定义域**：强度档位**不再折算也不再是全局三档**（2026-10 改）：档位清单按
  模型/路由声明（`effort_levels`），没声明时给一整套 `minimal/low/medium/high/xhigh/max`，
  打了不收的档就报错、什么都不改（原来 `xhigh→high`、`ultra→max` 的折叠表已删）。
  关闭词仍是 `none/off/disabled/false/no`、`/effort none` 被拒并指向 `/thinking off`、
  关思考时保留 effort、改动在下一次请求生效、适配器与 `session.metadata` 一次调用同时更新、
  会话立刻落盘。**只有线上编码是错的**（B1）。
- **步数上限语义**：抛异常而不是返回、`run_finished(max_steps)` + 检查点在抛出之前、
  会话一致且可恢复、刻意不是 `ModelError`（`agent.go:323-327` ↔ `agent.py:1716-1727`），
  默认 120 两边相同。
- **中断/关闭**：`interrupt` 置每轮标志，`shutdown` 让当前轮跑完再退出读循环，标志在每轮开始
  与切会话时清掉，取消被报成 `stop_reason=cancelled` + 检查点 + 一条 warn 通知。
  一处外观差异：Go 在取消时还会发一条空答案的 `ui(run_finished)`，Python 跳过。
- **压缩**：摘要先于边界、artifact 先于 metadata、检查点最后；折叠守卫、摘要提示词
  （把上一份摘要带下去）、前后测量、`/compact` 的三种状态都一致。
- **载荷装配**：折叠视图与摘要位置、固定开销记账（系统提示词不计、无 artifact 的工具消息按全长计、
  `tool_calls` 参数计入）、`fit` + `context_degraded`、notes 从不进 `session.messages`、
  `mark_context_messages` 只钉 artifact、用实测 `prompt_tokens` 校准。
- **会话的模型状态**：`notice_needed()` = "`last_used` 非空且不同"、通知在用户消息之前、
  `record_use()`、`provider/model` 的路由命名、thinking/effort 不算模型变更。
- **EricAI**：JWT `exp` 解码、600s 刷新阈值、写回时保留其它键、失败不拦启动。
  Go 刻意自己实现登录流程（自己的 refresh token 放在 `~/.tudouni/ericai_refreshtoken`，
  不共用 MSAL 缓存）——它在文件头注释里写明了，不算缺陷。
- **同样是有意为之、不要"修"**：Go 多出一条 Python 从不打印的 `notice.context.missing_body`
  （Python 把 `missing_artifacts` 存在 Runtime 上从未消费）；Go 丢掉"有参数但没名字"的流式
  tool call 占位（Python 保留一个空名字的）；Go 用自己的措辞在注册期拒绝
  `interactive` + `parallel_safe`。
