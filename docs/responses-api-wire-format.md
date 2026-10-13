# OpenAI Responses API (`POST /v1/responses`) 线格式速查表 — Go 手写 JSON 版

> **证据分级（全文遵守）**
> - **[A]** = OpenAI 官方 SDK 类型定义，由 OpenAI 的 OpenAPI spec 自动生成（`openai-python` `main` 分支，文件头写着 "File generated from our OpenAPI spec by Castiron"）。字段名/类型/字面量以它为准。
> - **[B]** = OpenAI 自己官方仓库 `openai/codex`（Rust 客户端）的 SSE 解析源码 + 其测试里构造的原始 SSE 报文。用于证明**线格式（event:/data: 分帧）**与「实际会出现哪些事件」。
> - **[C]** = Microsoft/Azure 官方 REST 参考（同一协议）。用于交叉验证请求/响应字段。
> - **[D]** = 第三方兼容实现文档里的原始 SSE 样例。只用来对比分帧差异，**不作为 OpenAI 行为依据**。
> - **未确认** = 我没有在一手来源里查到确切字面量，不猜。
>
> `platform.openai.com` 与 `developers.openai.com` 对我这条抓取链路全部返回 **HTTP 403 / Cloudflare 拦截**，所以官方参考页（`/api/reference/resources/responses/methods/create`、`/api/reference/resources/responses/streaming-events`、`/api/docs/guides/streaming-responses`）我只能给 URL，**不能声称我读过正文**。下面所有确切字面量都来自 [A]/[B]/[C]。

---

## 一、非流式请求体

### 1. system prompt 放哪

| 项 | 结论 | 来源 |
|---|---|---|
| 字段名 | `instructions` | [A] `response_create_params.py` |
| 类型 | `Optional[str]` —— **请求侧只能是 string，不是数组** | [A] 同上 |
| 也可放 `input` 里吗 | 可以。`input` 里放 `{"role":"system"}` 或 `{"role":"developer"}` 的 message 也生效（`developer`/`system` 优先于 `user`，见 [A] 注释） | [A] `easy_input_message_param.py` |
| 响应回显 | **响应**里的 `Response.instructions` 类型是 `Union[str, List[ResponseInputItem], None]`（请求侧 string，响应侧可能是数组） | [A] `response.py` |
| `previous_response_id` + `instructions` | 上一轮的 instructions **不会**被继承；每轮都要重新传 | [A] `response_create_params.py` 原文注释 |

> Go 建议：结构体用 `Instructions *string \`json:"instructions,omitempty"\``。

### 2. `input` 数组里一条普通用户消息的确切形状

`input` 顶层类型是 `Union[str, List[ResponseInputItem]]` —— **可以直接传一个裸字符串**（[A] `response_create_params.py`: `input: Union[str, ResponseInputParam]`）。

两种合法形状（都在 `ResponseInputItemParam` union 里）：

**(a) "easy message"（`EasyInputMessageParam`）—— content 允许纯字符串**

```json
{"role": "user", "content": "hello"}
```
```json
{"role": "user", "content": [{"type": "input_text", "text": "hello"}]}
```
- `role`: `"user" | "assistant" | "system" | "developer"` （**必需**）
- `content`: `Union[str, List[ResponseInputContentParam]]` （**必需**）
- `type`: `"message"`（可选，字面量写死为 `"message"`）
- `phase`: `Optional["commentary" | "final_answer"]` —— 仅用于 assistant 消息；gpt-5.3-codex 及以后模型建议原样回传

**(b) 强类型 `Message`（`ResponseInputItemParam.Message`）**
- `role`: `"user" | "system" | "developer"` —— **注意：这里没有 `assistant`**
- `content`: **必需且必须是数组**
- `type`: `"message"`

**content 数组元素的 `type` 确切取值（`ResponseInputContentParam`）：**

| type 字面量 | 结构 | 备注 |
|---|---|---|
| `"input_text"` | `{"type":"input_text","text":"..."}` | 输入文本。字段名是 `text` |
| `"input_image"` | `{"type":"input_image", ...}` | 未逐字展开 |
| `"input_file"` | `{"type":"input_file", ...}` | 未逐字展开 |
| `"output_text"` | `{"type":"output_text","text":"...","annotations":[...]}` | **只出现在响应/assistant 输出 item 里**，不在 `ResponseInputMessageContentListParam` 里 |
| `"text"` | **不存在** —— Responses API 没有 `"text"` 这个 content type（那是 Chat Completions 的 `content` 语义） | [A] `response_input_message_content_list_param.py` / `response_output_text.py` |

> 结论：**纯文本用户消息两种写法都合法**，`{"role":"user","content":"..."}` 最省事；要带图片/文件时用 (b) + `input_text`/`input_image`/`input_file`。`input_text` 里还可以带 `prompt_cache_breakpoint`（`{"mode":"explicit"}`），非必需。

### 3. assistant 角色 & input 里的 tool call

**assistant 的 role 值就是 `"assistant"`**（[A] `easy_input_message_param.py`）。

把 assistant 文本历史带回的两种写法：
```json
{"role": "assistant", "content": "previous answer"}
```
```json
{"type":"message","role":"assistant","status":"completed","id":"msg_...",
 "content":[{"type":"output_text","text":"previous answer","annotations":[]}]}
```
> 第二种在 SDK 里对应 `ResponseOutputMessageParam`，`id`/`content`/`role`/`status`/`type` 都标了 `Required`（[A] `response_output_message_param.py`）。实务上大家常省略 `id`/`status`，**服务端容忍度我未确认**。
> 最省事的做法：把上一轮响应 `output` 数组里的 item **原样 append 回 `input`**（Azure 官方文档的 "Chaining responses manually" 就是这个模式 [C]）。

**模型发起的 tool call 在 `input` 里就是 output item 的原样回传**（`ResponseFunctionToolCallParam`，type 名 `"function_call"`）：

```json
{
  "type": "function_call",
  "call_id": "call_abc123",
  "name": "get_weather",
  "arguments": "{\"location\":\"San Francisco\"}",
  "id": "fc_abc123",
  "status": "completed"
}
```

| 字段 | 必需性 | 含义 |
|---|---|---|
| `type` | 必需 | 字面量 `"function_call"` |
| `call_id` | 必需 | 模型生成的调用 ID；**回传 tool 结果时用它对应** |
| `name` | 必需 | 函数名 |
| `arguments` | 必需 | **JSON 字符串**（不是对象！） |
| `id` | 可选 | OpenAI 平台侧 item ID（`fc_...`） |
| `status` | 可选 | `"in_progress" \| "completed" \| "incomplete"` |

来源：[A] `response_function_tool_call_param.py`、`response_function_tool_call.py`。注意 `arguments` 官方描述原文是 "A JSON string of the arguments to pass to the function"。

### 4. 工具执行结果回传

`type` 确认是 `"function_call_output"`，字段确认是 `call_id` + `output`（[A] `response_input_item_param.py` 里的 `FunctionCallOutput`）：

```json
{
  "type": "function_call_output",
  "call_id": "call_abc123",
  "output": "{\"temperature\":\"70 F\"}"
}
```

| 字段 | 必需性（按 SDK 声明） | 说明 |
|---|---|---|
| `output` | **Required** | `Union[str, ResponseFunctionCallOutputItemListParam]`。**纯字符串**最常用；要回图/文件时用 `[{"type":"input_text","text":...}]` 这类数组（元素 type 仍是 `input_text`/`input_image`/`input_file`，见 [A] `response_function_call_output_item_param.py`） |
| `type` | **Required** | `"function_call_output"` |
| `call_id` | `Optional[str]`（SDK 标可选，但**实际是关键关联键，必须给**） | 模型生成的 call ID |
| `id` | 可选 | 仅当该 item 由 API 返回时才有 |
| `name` / `namespace` / `caller` / `status` | 可选 | 一般回传不用给 |

> 注意：`output` 是**字符串**，不是对象。你把工具结果序列化成 JSON 字符串塞进去。

### 5. 工具定义（tools）—— 扁平，不是 chat completions 的嵌套

**扁平结构**（[A] `function_tool_param.py`，`type: "function"` + 顶层 `name`/`parameters`/`strict`）：

```json
{
  "type": "function",
  "name": "get_weather",
  "description": "Get weather for a location",
  "parameters": {
    "type": "object",
    "properties": {"location": {"type": "string"}},
    "required": ["location"],
    "additionalProperties": false
  },
  "strict": true
}
```

| 字段 | 层次 | 必需性（SDK 声明） |
|---|---|---|
| `type` | 顶层 | `Required[Literal["function"]]` |
| `name` | 顶层 | `Required[str]` |
| `parameters` | 顶层 | `Required[Optional[dict]]` —— 标了 Required 但可为 null |
| `strict` | **顶层**（和 `name` 同级，**不在 `function` 里**） | `Required[Optional[bool]]` |
| `description` | 顶层 | `Optional[str]` |
| `output_schema` | 顶层 | `Optional[dict]` |
| `defer_loading` / `allowed_callers` | 顶层 | 可选 |

> **对比**：Chat Completions 是 `{"type":"function","function":{"name":...}}`；Responses API **没有 `function` 这一层包装**。这是个常见的踩坑点。
> `parameters` 与 `strict` 在 SDK 里是 Required-but-nullable，稳妥做法是两者都显式给（`strict: false` 或 `true`）。
> 另有非函数类工具：`{"type":"web_search"}`、`{"type":"file_search"}`、`{"type":"mcp",...}`、`{"type":"code_interpreter",...}`、`{"type":"image_generation"}`、`{"type":"local_shell"}`、`{"type":"shell"}`、`{"type":"custom"}`、`{"type":"computer_use_preview"}` 等（[A] `tool_param.py` 的 union）。

### 6. `max_output_tokens` / `stream` / usage 开关

| 项 | 结论 | 来源 |
|---|---|---|
| `max_output_tokens` | **可选**，`Optional[int]`。语义含可见输出 tokens **+ reasoning tokens** | [A] `response_create_params.py` |
| 流式字段名 | `stream`，`Optional[bool]`；流式变体里是 `Required[Literal[True]]` | [A] 同上（`ResponseCreateParamsStreaming`） |
| 是否有 `stream_options.include_usage` | **没有**。`stream_options` 只有一个子字段：`include_obfuscation: bool`（给 delta 事件加随机 `obfuscation` 字段以抗侧信道）。**不存在 `include_usage`** | [A] 同上（`class StreamOptions`） |
| usage 是否一定返回 | `response.completed` 事件的 `response.usage` 字段。在**非流式**响应里 usage 也是 `Optional`（SDK 里 `usage: Optional[ResponseUsage] = None`）。**"一定会在 completed 里返回" 我未确认**；稳妥做法：拿不到就当 0，并额外留意 `response.incomplete` 也带完整 `response`（可能含 usage） | [A] `response_completed_event.py` / `response.py` |
| 其它请求字段（供参考） | `model`（必需）、`previous_response_id`、`store`、`metadata`、`parallel_tool_calls`、`tool_choice`、`temperature`、`top_p`、`text`、`truncation`、`service_tier`、`include`、`prompt_cache_key`、`safety_identifier`、`max_tool_calls`、`background` | [A] |

### 7. 推理强度参数

形状是 `reasoning: { effort: ... }`（[A] `shared_params/reasoning.py`）：

```json
{"reasoning": {"effort": "medium"}}
{"reasoning": {"effort": "low", "summary": "auto"}}
```

| 字段 | 取值（确切字面量） |
|---|---|
| `effort` | `"none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"`（整个类型是 `Optional[...]`）[A] `shared/reasoning_effort.py` |
| `summary` | `"auto" \| "concise" \| "detailed"` —— 想拿 reasoning 摘要流必须设，否则可能没有 summary 事件 |
| `generate_summary` | 同上取值，但已 **deprecated**，用 `summary` |
| `context` | `"auto" \| "current_turn" \| "all_turns"` |
| `mode` | `str \| "standard" \| "pro"` |

> ⚠️ **哪些模型支持哪些 effort 值，我未确认**（官方 reasoning guide 403）。SDK 注释只说 "Not all reasoning models support every value"。Go 侧建议：枚举照抄，别在校验层硬拒。

---

## 二、非流式响应

### 1. 顶层结构

`Response` 对象（[A] `response.py`）顶层字段：`id`、`object`（**字面量 `"response"`**）、`created_at`（float, 秒）、`status`（`"completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete"`）、`model`、`output`（数组）、`usage`、`error`、`incomplete_details`、`instructions`、`metadata`、`parallel_tool_calls`、`tool_choice`、`tools`、`temperature`、`top_p`、`max_output_tokens`、`max_tool_calls`、`previous_response_id`、`reasoning`、`text`、`truncation`、`background`、`completed_at`、`conversation`、`service_tier`、`prompt_cache_key`、`prompt_cache_retention`、`safety_identifier`、`user`、`top_logprobs`。

（Azure 版还多一个非 OpenAI 标准的 `content_filters` 数组 [C]，那是 Azure 扩展，不要依赖。）

**`output[]` 里 item 的 `type` 字面量**（[A] `response_output_item.py` union，逐个核对过源文件）：

| `type` | 说明 |
|---|---|
| `"message"` | assistant 文本消息（正文在这里） |
| `"reasoning"` | 思维链 item |
| `"function_call"` | 函数调用 |
| `"function_call_output"` | 函数结果（当它作为 output 出现时） |
| `"web_search_call"` | |
| `"file_search_call"` | 未逐字核实（源文件未读），按命名推断 |
| `"computer_call"` / `"computer_call_output"` | 未逐字核实 |
| `"code_interpreter_call"` | |
| `"image_generation_call"` | |
| `"local_shell_call"` / `"local_shell_call_output"` | |
| `"shell_call"` / `"shell_call_output"` | |
| `"apply_patch_call"` / `"apply_patch_call_output"` | |
| `"custom_tool_call"` / `"custom_tool_call_output"` | `custom_tool_call` 已核实；output 侧未逐字核实 |
| `"mcp_call"` / `"mcp_list_tools"` / `"mcp_approval_request"` / `"mcp_approval_response"` | |
| `"tool_search_call"` / `"tool_search_output"` | |
| `"program"` / `"program_output"` | 程序化工具调用 |
| `"additional_tools"` | |
| `"compaction"` | 压缩 item |

### 2. 纯文本 / reasoning / function call 从哪取

**❌ 不要写死 `output[0].content[0].text`。** SDK 自己的 `Response.output_text` 便捷属性就是遍历全部 output，把所有 `type == "message"` 里的 `type == "output_text"` 的 `text` 拼起来（[A] `response.py` 末尾）。官方注释也明说 "The length and order of items in the `output` array is dependent on the model's response"。

**纯文本**：遍历 `output[i]`，取 `type == "message"` 且 `role == "assistant"`，再遍历 `content[j]`，取 `type == "output_text"`，读 **`.text`**：

```
output[i].content[j].text        // content[j].type == "output_text"
```

`content[j]` 的 type 取值：`"output_text"`（`{"annotations":[...], "text":"...", "type":"output_text", "logprobs":[...]}`）或 `"output_refusal"`（拒绝，[A] `response_output_message.py` 的 discriminator union）。

**reasoning**：`type == "reasoning"` 的 item（`ResponseReasoningItem`）：

```json
{
  "id": "rs_abc",
  "type": "reasoning",
  "summary": [{"type": "summary_text", "text": "..."}],
  "content": [{"type": "reasoning_text", "text": "..."}],
  "encrypted_content": "gAAAA...",
  "status": "completed"
}
```
- 摘要读 `output[i].summary[k].text`（`summary[k].type == "summary_text"`）
- 原始推理文本在 `output[i].content[k].text`（`content[k].type == "reasoning_text"`，**通常为 null**，只有特定场景返回）
- `encrypted_content` 是密文，`store:false` 的无状态多轮必须把它原样回传

**function call**：`type == "function_call"` 的 item，字段就是 `name` / `arguments`（**JSON 字符串**）/ `call_id`（+ 可选 `id` / `status`）。

### 3. usage 的确切字段名

[A] `response_usage.py`：

```json
"usage": {
  "input_tokens": 328,
  "input_tokens_details": {
    "cached_tokens": 256,
    "cache_write_tokens": 0
  },
  "output_tokens": 52,
  "output_tokens_details": {
    "reasoning_tokens": 12
  },
  "total_tokens": 380
}
```

| 你要的 | 确切路径 |
|---|---|
| 缓存命中 tokens | **`usage.input_tokens_details.cached_tokens`** ✅ 确认 |
| 缓存写入 tokens | `usage.input_tokens_details.cache_write_tokens`（同一对象里还有这个字段，[A]） |
| reasoning tokens | `usage.output_tokens_details.reasoning_tokens` |
| 总 tokens | `usage.total_tokens` |

> 注意名字是 `input_tokens_details`（复数 details），缓存字段叫 `cached_tokens`——和 Chat Completions 的 `prompt_tokens_details.cached_tokens` 不同。数值类型是 `int`。
> [B] `openai/codex` 里解析同一结构：`cached_input_tokens: input_tokens_details.cached_tokens`，字段名完全一致，交叉验证通过。

---

## 三、流式响应（SSE）

### 1. 事件分帧：有没有 `event:` 行

| 问题 | 结论 |
|---|---|
| JSON 里有没有 `type` 字段 | **有，且必有。** 所有事件的 discriminator 就是 `type`（[A] `response_stream_event.py` 用 `PropertyInfo(discriminator="type")`；[B] codex 直接 `#[serde(rename = "type")] kind: String`，只用 JSON 里的 type 做分发） |
| 每条是否带 `event:` 行 | **强烈证据表明有。** [B] `openai/codex` 的测试报文一律构造成 `format!("event: response.completed\ndata: {json}\n\n")` / `format!("event: response.failed\ndata: {raw_error}\n\n")`，即 `event: <type>` 行 + `data: <json>` 行 + 空行。第三方兼容实现（FriendliAI [D]）的原始样例同样是 `event: response.created` + `data: {...}` |
| 但能不能只靠 `data:` | **能，而且应当这么做。** [B] codex 只读 `sse.data` 里的 JSON `type`，完全不看 `sse.event`。**建议 Go 实现：解析 `data:` 行的 JSON，用其中的 `type` 做 switch；`event:` 行存在则忽略，不存在也不影响。** 这样对 OpenAI 与所有兼容厂商都稳 |

> 我**没能在官方文档正文里逐字确认**"每条都带 event: 行"（官方页 403）。所以：**以 JSON `type` 为准**是唯一无风险的实现方式。

### 2. 文本增量

```
type:  "response.output_text.delta"
路径:  delta
```
payload（[A] `response_text_delta_event.py`）：
```json
{
  "type": "response.output_text.delta",
  "delta": "Hello",
  "item_id": "msg_abc",
  "output_index": 0,
  "content_index": 0,
  "sequence_number": 4,
  "logprobs": [],
  "obfuscation": "..."   // 未确认是否总在（受 stream_options.include_obfuscation 控制）
}
```
- 取文本：**`.delta`**（string）
- 同一 item 的多条 delta 需要按 `output_index` / `item_id` 拼接
- 收尾有 `"response.output_text.done"`，取整段用 **`.text`**（[A] `response_text_done_event.py`）

### 3. reasoning 增量（**注意有两个不同的 type，别搞混**）

| 用途 | type 字面量 | 取文本字段 |
|---|---|---|
| 推理**摘要**增量（最常用，对应 `reasoning.summary`） | `"response.reasoning_summary_text.delta"` | **`delta`** |
| 推理摘要完成 | `"response.reasoning_summary_text.done"` | `text` |
| 摘要分段新增 | `"response.reasoning_summary_part.added"` | `part.text`（`part.type == "summary_text"`） |
| 原始推理**正文**增量（通常不返回） | `"response.reasoning_text.delta"` | **`delta`** |
| 原始推理正文完成 | `"response.reasoning_text.done"` | `text` |

`response.reasoning_summary_text.delta` payload（[A]）：
```json
{
  "type": "response.reasoning_summary_text.delta",
  "delta": "We need to ",
  "item_id": "rs_abc",
  "output_index": 0,
  "summary_index": 0,
  "sequence_number": 2
}
```
`response.reasoning_text.delta` payload 用 `content_index` 而不是 `summary_index`。

> 要有 reasoning 事件，请求里得给 `reasoning: {"summary": "auto"|"concise"|"detailed"}`（[B] codex 会读 `x-reasoning-included` 响应头判断服务端是否返回 reasoning）。

### 4. function call 参数增量 —— 你问的三个事件**全部真实存在**

| 你问的事件名 | 是否存在 | payload 形状 |
|---|---|---|
| `response.output_item.added` | ✅ **存在** | `{"type":"response.output_item.added","output_index":0,"item":{...完整 output item...},"sequence_number":3}` —— function call 开始时 `item.type == "function_call"`，**此时 `arguments` 通常是空串 `""`**，`name`/`call_id` 已可用 |
| `response.function_call_arguments.delta` | ✅ **存在** | `{"type":"response.function_call_arguments.delta","delta":"{\"loc","item_id":"fc_abc","output_index":0,"sequence_number":5}` —— 取 **`.delta`**，是一个**字符串片段**，需要按 `output_index` 累加拼接 |
| `response.function_call_arguments.done` | ✅ **存在** | `{"type":"response.function_call_arguments.done","arguments":"{\"location\":\"SF\"}","item_id":"fc_abc","output_index":0,"sequence_number":9}` —— 取 **`.arguments`**（完整 JSON 字符串） |
| `response.output_item.done` | ✅ 存在 | `{"type":"response.output_item.done","output_index":0,"item":{...},"sequence_number":10}` —— **推荐用这里的 `item` 拿最终 function call**（`name`/`arguments`/`call_id` 都是终态，codex 就是从 `output_item.done` 里 parse `ResponseItem` 的）[B] |

来源：[A] `response_output_item_added_event.py` / `response_function_call_arguments_delta_event.py` / `response_function_call_arguments_done_event.py` / `response_output_item_done_event.py`；[B] codex 把 `response.function_call_arguments.delta|done` 列在"收到但不处理"清单里，证明线路上确实会来。

> Go 实现建议：delta 累加字符串 → 到 `response.function_call_arguments.done`（或 `response.output_item.done`）时 `json.Unmarshal` 成 map，交给工具执行。**不要在 delta 阶段尝试解析 JSON。**

### 5. 结束事件

| type | 说明 |
|---|---|
| **`"response.completed"`** | 正常结束。usage 在 **`response.usage`** —— 即 `event.response.usage.input_tokens_details.cached_tokens` 等 |
| `"response.incomplete"` | 非错误但提前结束（命中 `max_output_tokens` / `content_filter` / `max_messages` / `steered`）。原因在 `response.incomplete_details.reason`；**也是终止事件** |
| `"response.failed"` | 失败。错误在 `response.error`；**也是终止事件** |
| `"error"` | 流中途错误。**注意：它的 type 就是 `"error"`**，没有 `response.` 前缀。payload：`{"type":"error","code":"...","message":"...","param":null,"sequence_number":N}` [A] `response_error_event.py` |

`response.completed` payload：
```json
{
  "type": "response.completed",
  "sequence_number": 12,
  "response": { "id": "resp_...", "object": "response", "status": "completed", "output": [...], "usage": {...} }
}
```
usage 路径：**`event.response.usage`**。

> **`data: [DONE]` 哨兵：未确认 OpenAI `/v1/responses` 是否发送。**
> - 支持"不发"的证据：Auriko（兼容厂商）文档明确写 "The stream ends with a terminal event (`response.completed`, `response.incomplete`, or `response.failed`) instead of a `data: [DONE]` sentinel" [D]；[B] codex 的收流逻辑只认 `response.completed`，没有 `[DONE]` 分支。
> - 支持"可能发"的证据：`openai-python` 的通用 `Stream.__stream__` 里统一有 `if sse.data.startswith("[DONE]"): break`（对所有 SSE 端点生效），有第三方代理专门打补丁 "skip trailing `[DONE]` sentinel in Responses stream"。
> - **Go 实现：以 `response.completed|incomplete|failed|error` 为终止条件；额外把 payload 恰为 `[DONE]` 的行当空行忽略掉。** 两种情况都正确。

### 6. 必须忽略 / 只需跳过的事件

确认存在于线上但**对文本+函数调用适配器无意义，直接 `default:` 跳过**：

| type | 建议 |
|---|---|
| `"response.created"` | 跳过（想拿 response id / model 可以读 `response.id`、`response.model`） |
| `"response.in_progress"` | 跳过（每条都带完整 response 快照，体积大） |
| `"response.queued"` | 跳过（background 模式） |
| `"response.content_part.added"` / `"response.content_part.done"` | 跳过（[B] 明确列为 unhandled） |
| `"response.output_item.added"` | 建议**不要**整条忽略：用它拿 `item.name` / `item.call_id` 起 tool call 状态机；纯文本场景可忽略 |
| `"response.output_item.done"` | 建议**处理**（拿终态 item） |
| `"response.output_text.done"` | 可忽略（或用作"该 item 文本完整"的信号） |
| `"response.reasoning_summary_part.added"` / `.done` | 可忽略（除非要分段渲染） |
| `"response.custom_tool_call_input.delta"` / `.done` | 你若不用 custom tool 就忽略 |
| `"response.mcp_*"`、`"response.web_search_call.*"`、`"response.file_search_call.*"`、`"response.code_interpreter_call.*"`、`"response.image_gen_call.*"`、`"response.shell_call_*"`、`"response.apply_patch_call_*"`、`"response.output_text.annotation.added"`、`"response.refusal.delta"` / `.done` | 不用对应工具就忽略 |
| `"codex.response.metadata"` / `"response.metadata"` / `"responsesapi.websocket_timing"` | 非标准/Codex 专用，忽略（[B] 里就是忽略的） |
| keep-alive / 注释行 | SSE 里以 `:` 开头的行是注释，按 SSE 规范忽略（[A] `_streaming.py` 的 decoder：`if line.startswith(":"): return None`） |

### 7. `store: false` 是否必要

| 问题 | 结论 |
|---|---|
| 默认值 | **默认 `true`** —— "Defaults to true when omitted. If set to true, response data will be stored for at least 30 days" [A] `response_create_params.py` 原文注释 |
| 要不要带 | **看你走有状态还是无状态**：<br>• **有状态**（用 `previous_response_id` 串多轮）：可以不带（默认存）。<br>• **无状态**（自己把历史 item 全量塞回 `input`）：**应当每轮都显式带 `store: false`**，否则数据被服务端留存 30 天。 |
| 每轮都要带吗 | **是**，它是 per-request 参数，不会继承 |
| 无状态下的坑 | `store:false` 时 reasoning item 的 `encrypted_content` 需要在下一轮原样回传才能保留推理上下文；官方建议同时请求 `include: ["reasoning.encrypted_content"]`（[A] `include` 字段注释原文提到 "This enables reasoning items to be used in multi-turn conversations when using the Responses API statelessly (like when the `store` parameter is set to `false`, or when an organization is enrolled in the zero data retention program)"）；[B] codex / Vercel AI SDK 在 `store === false` 且是 reasoning 模型时都会自动加这个 include |
| 其它 | `store:false` 与 `stream:true` 可以同时用；`background:true` 的响应才有 `cancel` 语义 |

---

## 四、curl 样例

> ⚠️ 说明：下面的**字段名、type 字面量、层次结构都是上面 [A] 源文件里逐字核对过的**；具体数值/文本内容是我按 schema 构造的示意值（我无法用真实 API key 抓包）。凡是我没核实过的部分都在旁边标注。

### 4.1 请求（非流式，带一个工具 + 推理强度）

```bash
curl https://api.openai.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-5.1",
    "instructions": "You are a terse assistant. Always call get_weather when asked about weather.",
    "input": [
      {"role": "user", "content": "What is the weather in San Francisco?"}
    ],
    "tools": [
      {
        "type": "function",
        "name": "get_weather",
        "description": "Get the current weather for a location",
        "parameters": {
          "type": "object",
          "properties": {"location": {"type": "string"}},
          "required": ["location"],
          "additionalProperties": false
        },
        "strict": true
      }
    ],
    "tool_choice": "auto",
    "reasoning": {"effort": "low", "summary": "auto"},
    "max_output_tokens": 512,
    "store": false,
    "stream": false
  }'
```

### 4.2 非流式响应（function_call）

```json
{
  "id": "resp_68a1f2c3d4e5f6a7b8c9d0e1f2a3b4c5",
  "object": "response",
  "created_at": 1767225600.0,
  "status": "completed",
  "model": "gpt-5.1-2025-11-13",
  "output": [
    {
      "id": "rs_68a1f2c3d4e5f6a7b8c9d0e1f2a3b4c6",
      "type": "reasoning",
      "summary": [
        {"type": "summary_text", "text": "The user asks for weather; call get_weather with location."}
      ],
      "content": null,
      "encrypted_content": null,
      "status": "completed"
    },
    {
      "id": "fc_68a1f2c3d4e5f6a7b8c9d0e1f2a3b4c7",
      "type": "function_call",
      "call_id": "call_9xY8zW7vU6tS5rQ4pO3nM2lK",
      "name": "get_weather",
      "arguments": "{\"location\":\"San Francisco\"}",
      "status": "completed"
    }
  ],
  "usage": {
    "input_tokens": 132,
    "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0},
    "output_tokens": 48,
    "output_tokens_details": {"reasoning_tokens": 24},
    "total_tokens": 180
  },
  "parallel_tool_calls": true,
  "tool_choice": "auto",
  "tools": [{"type": "function", "name": "get_weather", "parameters": {"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]}, "strict": true}],
  "temperature": 1.0,
  "top_p": 1.0,
  "truncation": "disabled",
  "max_output_tokens": 512,
  "previous_response_id": null,
  "incomplete_details": null,
  "error": null,
  "instructions": "You are a terse assistant. Always call get_weather when asked about weather.",
  "metadata": {}
}
```

### 4.3 第二轮：回传工具结果（无状态，全量历史）

```bash
curl https://api.openai.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-5.1",
    "instructions": "You are a terse assistant.",
    "store": false,
    "include": ["reasoning.encrypted_content"],
    "input": [
      {"role": "user", "content": "What is the weather in San Francisco?"},
      {"type": "function_call",
       "call_id": "call_9xY8zW7vU6tS5rQ4pO3nM2lK",
       "name": "get_weather",
       "arguments": "{\"location\":\"San Francisco\"}"},
      {"type": "function_call_output",
       "call_id": "call_9xY8zW7vU6tS5rQ4pO3nM2lK",
       "output": "{\"location\":\"San Francisco\",\"temperature\":\"70 F\",\"conditions\":\"foggy\"}"}
    ]
  }'
```
纯文本回答：

```json
{
  "id": "resp_5f4e3d2c1b0a99887766554433221100",
  "object": "response",
  "created_at": 1767225605.0,
  "status": "completed",
  "model": "gpt-5.1-2025-11-13",
  "output": [
    {
      "id": "msg_0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      "type": "message",
      "status": "completed",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "It is 70 F and foggy in San Francisco.",
          "annotations": [],
          "logprobs": []
        }
      ]
    }
  ],
  "usage": {
    "input_tokens": 210,
    "input_tokens_details": {"cached_tokens": 128, "cache_write_tokens": 0},
    "output_tokens": 16,
    "output_tokens_details": {"reasoning_tokens": 0},
    "total_tokens": 226
  },
  "parallel_tool_calls": true,
  "tool_choice": "auto",
  "tools": [],
  "temperature": 1.0,
  "top_p": 1.0,
  "truncation": "disabled",
  "incomplete_details": null,
  "error": null,
  "instructions": "You are a terse assistant.",
  "metadata": {}
}
```

> 取纯文本的健壮写法（等同 SDK 的 `output_text`）：遍历 `output`，对每个 `type=="message"` 的 item，遍历 `content`，拼接所有 `type=="output_text"` 的 `.text`。

### 4.4 一段流式事件序列（含文本增量 + 函数调用参数增量）

```
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_68a1f2c3d4e5f6a7b8c9d0e1f2a3b4c5","object":"response","created_at":1767225600.0,"status":"in_progress","model":"gpt-5.1-2025-11-13","output":[],"usage":null}}

event: response.in_progress
data: {"type":"response.in_progress","sequence_number":1,"response":{"id":"resp_68a1f2c3d4e5f6a7b8c9d0e1f2a3b4c5","object":"response","status":"in_progress","output":[],"usage":null}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"id":"msg_0a1b2c3d4e5f60718293a4b5c6d7e8f9","type":"message","status":"in_progress","role":"assistant","content":[]}}

event: response.content_part.added
data: {"type":"response.content_part.added","sequence_number":3,"item_id":"msg_0a1b2c3d4e5f60718293a4b5c6d7e8f9","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_0a1b2c3d4e5f60718293a4b5c6d7e8f9","output_index":0,"content_index":0,"delta":"It is ","logprobs":[]}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":5,"item_id":"msg_0a1b2c3d4e5f60718293a4b5c6d7e8f9","output_index":0,"content_index":0,"delta":"70 F.","logprobs":[]}

event: response.output_text.done
data: {"type":"response.output_text.done","sequence_number":6,"item_id":"msg_0a1b2c3d4e5f60718293a4b5c6d7e8f9","output_index":0,"content_index":0,"text":"It is 70 F.","logprobs":[]}

event: response.content_part.done
data: {"type":"response.content_part.done","sequence_number":7,"item_id":"msg_0a1b2c3d4e5f60718293a4b5c6d7e8f9","output_index":0,"content_index":0,"part":{"type":"output_text","text":"It is 70 F.","annotations":[]}}

event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":8,"output_index":0,"item":{"id":"msg_0a1b2c3d4e5f60718293a4b5c6d7e8f9","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"It is 70 F.","annotations":[],"logprobs":[]}]}}

event: response.completed
data: {"type":"response.completed","sequence_number":9,"response":{"id":"resp_68a1f2c3d4e5f6a7b8c9d0e1f2a3b4c5","object":"response","created_at":1767225600.0,"status":"completed","model":"gpt-5.1-2025-11-13","output":[{"id":"msg_0a1b2c3d4e5f60718293a4b5c6d7e8f9","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"It is 70 F.","annotations":[]}]}],"usage":{"input_tokens":132,"input_tokens_details":{"cached_tokens":0,"cache_write_tokens":0},"output_tokens":24,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":156}}}
```

函数调用场景的增量序列（同一套骨架，把文本事件换成参数事件）：

```
event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"id":"fc_68a1...","type":"function_call","status":"in_progress","call_id":"call_9xY8zW7vU6tS5rQ4pO3nM2lK","name":"get_weather","arguments":""}}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":3,"item_id":"fc_68a1...","output_index":0,"delta":"{\"loc"}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":4,"item_id":"fc_68a1...","output_index":0,"delta":"ation\":\"San Francisco\"}"}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","sequence_number":5,"item_id":"fc_68a1...","output_index":0,"arguments":"{\"location\":\"San Francisco\"}"}

event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":6,"output_index":0,"item":{"id":"fc_68a1...","type":"function_call","status":"completed","call_id":"call_9xY8zW7vU6tS5rQ4pO3nM2lK","name":"get_weather","arguments":"{\"location\":\"San Francisco\"}"}}

event: response.completed
data: {"type":"response.completed","sequence_number":7,"response":{"id":"resp_...","object":"response","status":"completed","output":[{"id":"fc_68a1...","type":"function_call","status":"completed","call_id":"call_9xY8zW7vU6tS5rQ4pO3nM2lK","name":"get_weather","arguments":"{\"location\":\"San Francisco\"}"}],"usage":{"input_tokens":132,"input_tokens_details":{"cached_tokens":0,"cache_write_tokens":0},"output_tokens":18,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":150}}}
```

推理摘要场景：

```
event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"id":"rs_68a1...","type":"reasoning","summary":[],"status":"in_progress"}}

event: response.reasoning_summary_part.added
data: {"type":"response.reasoning_summary_part.added","sequence_number":3,"item_id":"rs_68a1...","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":""}}

event: response.reasoning_summary_text.delta
data: {"type":"response.reasoning_summary_text.delta","sequence_number":4,"item_id":"rs_68a1...","output_index":0,"summary_index":0,"delta":"The user asks for weather. "}

event: response.reasoning_summary_text.done
data: {"type":"response.reasoning_summary_text.done","sequence_number":5,"item_id":"rs_68a1...","output_index":0,"summary_index":0,"text":"The user asks for weather. "}
```

---

## 五、Go 适配器实现要点（从上面推导的硬结论）

1. **请求体**：`instructions` 用 `*string`；`input` 用 `json.RawMessage` 或 `any`（既可能是 string 也可能是数组）。
2. **工具定义扁平**：写 `{"type":"function","name":...,"parameters":...,"strict":...}`，**不要**包 `function` 层。
3. **`arguments` 全程是字符串**（请求回传、响应、delta、done 都是），只在执行前 `json.Unmarshal`。
4. **关联键是 `call_id`**（`function_call` ↔ `function_call_output` 靠它）。
5. **响应取文本别取 `output[0]`**：遍历全部 `output`，挑 `type=="message"` 的 `content[].type=="output_text"`。
6. **流式分发 key 是 JSON 里的 `type`**，不是 `event:` 行；`event:` 行忽略即可。
7. **终止条件**：`response.completed` / `response.incomplete` / `response.failed` / `type=="error"`；额外把 `[DONE]` 当作空行忽略。
8. **usage 只在 `response.completed`** 的 `response.usage` 里拿（缓存命中：`usage.input_tokens_details.cached_tokens`）。没有 `stream_options.include_usage` 这种东西。
9. **默认会存 30 天**：无状态用法每轮显式 `"store": false`，reasoning 模型再带 `"include": ["reasoning.encrypted_content"]`。
10. **未知 type 一律跳过**，不要报错——事件类型集在持续扩张（custom tool / shell / apply_patch / program 等），且兼容厂商会发自己私有事件。

---

## 六、来源

**一手（OpenAI 官方 SDK 类型，由 OpenAI OpenAPI spec 生成）— [A]**
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_create_params.py>（`instructions`/`input`/`max_output_tokens`/`stream`/`stream_options`/`reasoning`/`tools`/`store`/`include`）
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/easy_input_message_param.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_input_message_content_list_param.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_input_text_param.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_input_item_param.py>（`function_call_output`）
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_function_tool_call_param.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_function_tool_call.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/function_tool_param.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_output_item.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_output_message.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_output_text.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_reasoning_item.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_usage.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_stream_event.py>（全部流式事件 union）
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_text_delta_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_text_done_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_reasoning_summary_text_delta_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_reasoning_text_delta_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_function_call_arguments_delta_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_function_call_arguments_done_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_output_item_added_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_output_item_done_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_content_part_added_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_completed_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_incomplete_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_failed_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_error_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_in_progress_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_created_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_queued_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_reasoning_summary_part_added_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_reasoning_summary_text_done_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_refusal_delta_event.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/shared/reasoning_effort.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/types/shared_params/reasoning.py>
- <https://github.com/openai/openai-python/blob/main/src/openai/_streaming.py>（SSE decoder：`event:`/`data:`/注释行/`[DONE]` 处理）

**一手（OpenAI 官方 `openai/codex` 客户端，线格式证据）— [B]**
- <https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs>（`event: <type>\ndata: <json>\n\n` 测试报文；`type` 字段分发；"收到但不处理"的事件清单；`response.completed` 后立即收流；`input_tokens_details.cached_tokens` 解析）

**官方文档（我的抓取链路被 403 拦截，仅作 URL 索引，未读正文）**
- <https://developers.openai.com/api/reference/resources/responses/methods/create>
- <https://developers.openai.com/api/reference/resources/responses/streaming-events>
- <https://developers.openai.com/api/docs/guides/streaming-responses>
- <https://platform.openai.com/docs/api-reference/responses/create>

**官方（Microsoft/Azure，同协议交叉验证）— [C]**
- <https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/responses>（请求/响应字段表、`text/event-stream` 响应、`store`/`stream`/`stream_options`）
- <https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/responses>（function calling 示例：`{"type":"function_call_output","call_id":...,"output":...}`、手动串联 output items、流式错误事件样例）

**第三方兼容实现（仅用于对比分帧，不代表 OpenAI 行为）— [D]**
- <https://docs.auriko.ai/response-api/streaming>（明确称 Responses 流**不用** `[DONE]`，以终止事件结束）
- <https://friendli.ai/docs/openapi/container/responses-chunk-object>（原始样例含 `event:` 行）
- <https://docs.aleph-alpha.com/phariaai-dev-guide/latest/responses-api/streaming.html>（反例：只有 `data:` 行且**有** `[DONE]`）
- <https://github.com/osaurus-ai/osaurus/blob/ef180dd898b3698175d70edc81ba301db75ed0d0/docs/OpenAI_API_GUIDE.md>（Open Responses spec 实现，`event:` + `[DONE]`）

---

## 七、明确标注「未确认」的项（汇总）

1. OpenAI `/v1/responses` 流是否发送 `data: [DONE]` 哨兵 —— **未确认**（见 §三.5，两种证据冲突；实现上按"两者都正确处理"写）。
2. 官方文档正文里是否逐字说明"每条事件都带 `event:` 行" —— **未确认**（403）。已有一手客户端 [B] 的报文格式作强证据。
3. `response.completed` 是否**保证**带非空 `usage` —— **未确认**（SDK 里是 `Optional`）。`response.incomplete` / `response.failed` 是否带 usage —— **未确认**。
4. `obfuscation` 字段是否默认出现在每个 delta 事件里 —— **未确认**（只确认 `stream_options.include_obfuscation` 这个开关及其语义描述）。
5. 各 reasoning 模型分别支持 `effort` 的哪些取值 —— **未确认**（官方 reasoning guide 403；SDK 只说 "not all models support every value"）。
6. `output[].type` 里 `file_search_call` / `computer_call` / `computer_call_output` / `custom_tool_call_output` 的确切字面量 —— **未逐字核实**（源文件在 union 里 import 但未逐文件读取），按 OpenAI 命名约定推断。`web_search_call` / `code_interpreter_call` / `compaction` / `tool_search_output` / `shell_call` / `apply_patch_call` 等已逐字核实。
7. 省略 `ResponseOutputMessageParam` 的 `id`/`status` 时服务端是否容忍 —— **未确认**（SDK 标 Required）。
8. `Instruction` 请求侧是否也接受数组 —— **未确认**（SDK 请求侧是 `Optional[str]`；只有响应侧 `Response.instructions` 是 `Union[str, List[ResponseInputItem], None]`）。
