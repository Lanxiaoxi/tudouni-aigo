# 图片生成（`generate_image`）：设计方案

**状态**：**已实现**（`internal/imagegen/`、`internal/tools/builtin/generate_image.go`，
提交 `d2b1875`）。本文留作设计与取舍的记录，实现细节以代码注释为准。
**范围**：给模型一个"产出一张图"的工具 —— 独立生成路由 + 一个工具 + 写进工作区的文件 + 复用现有的两种展示通道。
**不在范围**：图生图 / 局部重绘、批量与并行出图、流式预览、chat 端点直接返回 image part 的输出模态、`/stats` 的图片计数面板、桌面端配置面板的新字段。

---

## 一、一句话

`vision` 是**输入端**（图进、text+tool_calls 出）；这份设计加的是**输出端**（text 进、图出）。两者正交，接在同一个智能体循环里的方式也不同：输入端改的是请求的形状，输出端只是**多了一个工具**，而这个工具的产物恰好是字节。

由此得到本文的第一条原则，后面所有决策都是它的推论：

> **生成的图片是一个文件，不是一条消息内容。**

它是工作区里的 `out/poster.png`，可以被 `![](…)` 显示、被 `present` 声明成交付物、被下一次对话重新打开。它不是一段塞进 assistant 消息里的二进制 —— 那条路要改会话 schema、要在"空回答"的判定里开一个口子，而且重开会话图就没了。

---

## 二、现状：缺的到底是什么

| 层 | 现状 | 结论 |
| --- | --- | --- |
| 请求侧收图 | `internal/model/media.go` 把 `ImagePart` 编码成三套方言 | 已完成 |
| 响应侧收图 | `anthropic.go:414` 只处理 `text_delta` / `thinking_delta` / `input_json_delta`；`responses.go:314` 只处理 text / reasoning / function_call；`image_generation_call` 落到 ignore | **不存在，也不打算在 v1 做** |
| 工具表 | `read_file` / `write_file` / `grep` / `shell` / `read_image` / `present` / `web_search` / `subagent` / … | 没有生图工具 |
| 产图后的展示 | `MarkdownImage` 渲染工作区路径（≤5MB，png/jpg/jpeg/gif）；`DeliverableCards` 认 `deliverable.kind.image`；`present` 声明交付物 | **已完成，无需改动** |
| 产物存储 | artifact 在会话数据目录，不在工作区 | 给人看的必须另落一个工作区文件 |

最后两行是这份设计便宜的原因：**展示通道一行都不用写**，因为 `inline_image` 的注释里早就写了这个场景 —— "a model that generates an image hands back a path"。

---

## 三、三条路线，为什么选 A

| | 路线 | 结果形态 | 要改什么 | 判断 |
| --- | --- | --- | --- | --- |
| **A** | 工具 + 独立生成端点 | 工具写文件，模型随后写正文 → **文本 + 图** | 一个新包、一个工具、一段配置 | **选它** |
| B | 工具 + Responses 托管 `image_generation` | 同上 | 还要先有 Responses 输出侧的 item 解析（我们恰好没有），且产物由 OpenAI 端托管，落盘要再下一步 | v1.1 再说 |
| C | chat 端点直接返回 image part | 模型自己决定文本/图片 | 改 `agent.go:512` 的空回答判定、改 assistant 消息的存储形状（`content` 是 string）、改 usage 口径 | 不做，见下 |

C 的具体代价，写清楚免得以后有人再提一遍：

1. `agent.go:507-520`：没有 tool call 且正文为空 → 先注入 nudge「上一轮你只产出了思考过程，没有给出正文」，还空就 `StopEmptyResponse` **报错**。只吐图的响应会被当成故障。
2. `assistantMessage()` 写进 session 的 `content` 是字符串，图片不落库 → 重开会话图消失，而且下一轮模型会读到一条"说过话但没内容"的历史。
3. `Usage` 只有 token 四个数，图片输出折算不进去，成本会安静地少算。

A 把这三点全部绕开：图在磁盘上，会话里只留路径，和 `write_file` 写一个文件没有任何区别。

---

## 四、决策

### D1 配置放在顶层 `image_generation`，不进 `providers[].models[]`

`providers[].models[]` 是**可被选为对话模型的清单**，每个字段（`context_window`、`reasoning_effort`、`vision`）对生图模型都没有意义。把 `gpt-image-1` 放进去的后果很具体：`/model` 会列出它、允许选中，选中之后每次 chat 都失败。

```json
"image_generation": {
  "provider": "openai",
  "model": "gpt-image-1"
}
```

最小形状就这两行（`provider` 的继承见 D2）；要单独配一个只做生图的端点，就把 `base_url` / `api_key` 也写进来，覆盖继承来的值。

### D2 `provider` 用来继承 key，避免同一个密钥写两遍

不给它就自己写全；给了它，`base_url` / `api_key` / `headers` 从那条 chat 路由继承，本节出现的键**覆盖**继承来的值：

| 键 | 来源 | 说明 |
| --- | --- | --- |
| `provider` | 本节 | 必须是 `providers` 里存在的名字，否则报错并列出可用的路由 |
| `model` | 本节，**必填** | 生图模型 id；不继承，chat 路由的模型不是这个 |
| `api_style` | 本节，缺省 `openai-images` | 见 D3 |
| `base_url` | 本节 → `provider` | 生成端点常常和 chat 端点不同（有的网关只做其中一个） |
| `api_key` | 本节 → `provider` | **这条是 `provider` 存在的主要理由**：一份 key 写在两个地方，迟早有一处是旧的 |
| `headers` | 本节 → `provider` | 同名同义，本节优先 |

风险也写在这里：继承来的 `base_url` 可能不提供 `/images/generations`，报错会是一个 404。所以工具的错误文案里必须打印**实际请求的 URL 和 model**，否则这个设计省下的那行配置会以"神秘的 404"的形式还回来。

### D3 v1 只做一种方言：`openai-images`

`api_style` 目前只有一个合法值，另一个参数（`gemini`）留给下一个方言。这不是过度抽象 —— `internal/model` 已经把"一个能力、多种线上拼法"这件事做过一遍，结构照抄即可：请求体、鉴权、返回形状、错误分类都在方言文件里，`Client` 只认 `Request` / `Picture`。

`responses` 不在 v1：它要求先把 Responses 的输出 item 解析出来（第二节那行"不存在"），否则工具调用了、图也生成了、我们看不见。

`POST {base_url}/images/generations`：

```json
{"model": "…", "prompt": "…", "size": "1024x1024", "n": 1}
```

**不发 `response_format`。** 它是 DALL·E 时代的参数，`gpt-image-1` 会因为不认识的字段报错；不发的代价是返回形状可能有两种（`b64_json` 或 `url`），两种都处理，见 D10。

### D4 工具签名：`generate_image{prompt, path, orientation?}`，一次一张

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` | string，必填 | 画面本身。工具描述要求写"主体 + 风格 + 构图 + 光线"，不要写"请帮我生成" |
| `path` | string，必填 | 工作区相对路径，**扩展名只能是 `.png` / `.jpg` / `.jpeg`**，见 D9 |
| `orientation` | enum，可选 | `square`（默认）/ `landscape` / `portrait` |

三条理由，都不是随手定的：

- **`path` 必填而不是自动命名。** 自动命名意味着我们替模型决定"这张图叫什么、放哪"，而它比我们更清楚这张图是什么；而且 `write_file` 的契约就是"你说路径，我写字节"，两个写文件的工具用两种契约是纯粹的意外。副作用是模型可以把它放进 `docs/images/`、`assets/` 或者用户指定的地方，不需要我们发明一个命名策略。
- **`orientation` 而不是 `aspect_ratio`。** 精确比例是 provider 自己的事：`gpt-image-1` 只有 1024×1024 / 1536×1024 / 1024×1536 三档，接受 `"4:3"` 就是在许诺一个它渲染不出来的东西。三档语义（方/横/竖）映射到各家的具体参数，映射表在方言文件里 —— 这正是 `media.go` 那条"runtime 不懂 provider 的图片格式"的同一条原则。
- **`n=1`。** 一次多张会让人对同一句话付 N 倍的钱，而且模型看不到之前的候选就无法取舍。要两张就是两次调用，第二次的 prompt 会因为看了第一张而变好 —— 这是工具路线独有的能力（见 D6）。

### D5 返回值：文本只说到"路径和下一步"，不复述画面

```go
tools.Result{
    Text: "已生成 1536×1024 的图片，写入 out/revenue.png。\n" +
          "要让人直接看到，就在回复里写 ![说明](out/revenue.png)；这是这次要交付的文件，再用 present 声明它。",
    Images: []tools.ImageContent{{Body: body, Name: "revenue.png", Path: "out/revenue.png"}},
    Audit: map[string]any{"image_generation": …},
}
```

`Text` 里**不写画面内容**，并且工具描述里明确要求模型也别写。理由是那重描述既花 token 又没人读："这张图画的是一个柱状图，横轴是月份……" 是一段图里已经有的信息。这条约束必须写在工具描述里，事后在提示词里纠正会贵得多。

### D6 `Images` 是给模型看的，不是给人看的；没有 vision 就不返回

`Result.Images` 走现有的 `agent.imageMessage`：字节 → artifact → 一条 runtime note 里的 `ImagePart` → **下一轮模型能看见自己刚画的图**。桌面端不渲染这条 note（它是 runtime note，不是消息），所以它唯一的观众是模型。

由此推出两条：

1. **人有自己的通道**：模型写的 `![](path)`（`MarkdownImage` 读工作区、带点击放大）或 `present` 卡片。文件必须真的在工作区，这是 D4 强制 `path` 的第二个理由。
2. **当前对话模型没有 vision 时，工具不返回 `Images`。** 否则会白存一个 artifact，再让 renderer 生成一句"这个模型看不了图片"塞回上下文 —— 花了钱买了一句废话。工具通过 `Assembly.Vision func() bool` 读这个门，和 `agent.imagePolicy()` 读的是同一个事实，不新增第二个开关。

无 vision 的会话里生图仍然允许（人可能只是想要那个文件），只是模型看不见自己的产物，也就没法迭代。这一点在工具描述里说清："你看不到自己生成的图，所以 prompt 要一次写准。"

### D7 风险 `medium`，不并行，默认每次都要一次批准

- `Risk: security.RiskMedium`，和 `write_file` / `fetch_web` 同级：联网 + 花钱 + 写文件，但不执行任意代码（那是 `shell` 的 high）。
- **`ParallelSafe: false`**：三个理由叠在一起 —— 每张都花钱；前一张的结果通常改变后一张的 prompt；同一个 `path` 的两张并发写会互相覆盖。
- **默认策略下 medium 是 ASK**（`security.NewPolicy()` 只自动放行 low）。所以"画一张图"会先弹一次确认。这是有意的：每次调用都在用户的账号上花钱，而且内容策略的责任也在那个账号上。想免确认的人把 `medium` 加进 `auto_approve`，这个决定属于权限系统，不属于这个工具。

### D8 每轮上限 4 张、单次超时 120s、原子写

- **每轮 4 张**。120 步的上限对一个每步都花钱的工具等于没有上限。超限返回**文本**而不是错误：「这一轮已经生成了 4 张。先说清楚哪一张不对、要怎么改，再决定要不要重画。」这句话同时是把模型从"再抽一张试试"的抽卡行为里拉出来的唯一办法。
- 计数器的实现：工具实例持有一个 `{runID string; count int}`，每次调用比对 `Assembly.RunID()`，变了就归零。**不需要 runtime 在每个轮次开始时通知谁**，也就不会出现"忘了调用 Reset"这种沉默的 bug。`Assembly.RunID` 的填充方式和 `artifactImages` 一样（先建 registry、后填字段），因为 agent 是在 registry 之后才构造出来的。
- **超时 120s**，常量而不是配置键：生成比 chat 慢一个数量级，但"这一个数字"没有第二个地方需要它。`ctx` 必须被尊重 —— 按停止键之后，一个 60 秒的生成不该继续占着连接。
- **原子写**：临时文件 → `os.Rename`，和 `internal/memory` 的写法一致。半张图（网络断了、进程被杀了）比没有图更坏：`MarkdownImage` 会把它读出来当一张坏图显示。

### D9 格式由字节决定，扩展名由模型决定，冲突时按这个表处理

字节的实际格式由 `content.InspectImage` 判定（`http.DetectContentType` + 解码尺寸），**永远不信扩展名**。但扩展名是给人看的，也是 `inline_image` 的第一道检查（它只认 `png/jpg/jpeg/gif`），所以两者必须一致：

| `path` 要的 | provider 给的 | 处理 | 模型看到 |
| --- | --- | --- | --- |
| `.png` | PNG | 原样写 | 成功 |
| `.png` | JPEG / GIF | 解码后**重编码成 PNG** 写入（无损，体积变大） | 「provider 返回 JPEG，已转成 PNG 写到 …」 |
| `.jpg` / `.jpeg` | PNG | **拒绝写入** | 「这张是无损 PNG，不能写成 .jpg —— 转 JPEG 是有损重编码，这个决定不该由我做。把 path 改成 .png 再调一次。」 |
| 任意 | WebP / 其它 | **拒绝写入** | 「返回的格式是 image/webp，这条链路只处理 PNG/JPEG/GIF。」 |
| 其它扩展名 | — | **调用 API 之前**就拒绝 | 「扩展名只能是 .png/.jpg/.jpeg」 |

最后一行是唯一在花钱之前就能拦住的错误，所以它必须在最前面。第三行是"不做不可逆的决定"：JPEG→PNG 是纯体积代价，PNG→JPEG 是质量代价，后者只能由人决定。

### D10 两套上限：能写盘的是 20MB，能进上下文/能显示的是 5MB

一个数字不够，因为这是两件不同的事：

| 上限 | 值 | 谁定的 |
| --- | --- | --- |
| 写进工作区 | 20MB | 本工具的 `MaxGeneratedImageBytes`（放在工具包里，**不放 `content`**：`content` 管的是"发给模型的上限"，两件事不能共用一个常量） |
| 进上下文（`attachToolPictures`） | 5MB | `content.MaxImageBytes`，`AttachImage` 会拒绝 |
| 桌面端内联显示 | 5MB | `MAX_INLINE_IMAGE_BYTES`（Rust 侧，画在窗口里：`MarkdownImage` 与图片预览都走它） |
| 桌面端打开（不经过窗口） | 无此上限 | `deliverable_open` 交给系统程序，所以 >5MB 的交付物仍然打得开 |

所以 >5MB 的图是可能的、也是合法的：**文件写下去，`Images` 不返回**，`Text` 说清楚"图已保存，但超过 5MB，不能内联显示，也不能给我看；要缩小请换 `orientation` 或让用户自己压"。声明它成交付物仍然有效（卡片会用系统程序打开）。

响应里的 url 形状（D3 不发 `response_format` 的代价）在这里处理：有 `b64_json` 就用；只有 `url` 就用**同一个 client** 下载，`io.LimitReader(body, 20MB+1)` 边下边限，不信 `Content-Length`。URL 来自 provider 的响应而不是模型，不引入新的 SSRF 面；但仍然只接受 `http`/`https`，并且走 `proxy.Transport`（用户的系统代理在生图上同样要生效）。

### D11 失败矩阵

区分原则照抄 `present`：**模型换一个参数就能修好的，是文本结果；模型改不了的（配置、边界、程序错误），是 error。**

| 条件 | 模型看到 | 人看到 | 能否重试 |
| --- | --- | --- | --- |
| 没配置 `image_generation` | 工具**不在 schema 里**（不是"存在但永远失败"） | 启动时一行 info notice，点名配置键 | — |
| 内容策略拒绝（400/422） | 「生成被拒绝：…（provider 原话）。**不要原样重试** —— 改掉可能触发的部分，或改用代码画（matplotlib/graphviz/mermaid）。」 | 工具结果 | 换 prompt |
| 429 限流 | 「被限流了（`Retry-After` 若有就带上）。稍后再试，或换个生成路由。」 | 工具结果 | 可以 |
| 5xx | 「生成端点出错（状态码 + 一句原因）。」 | 工具结果 | 可以 |
| 401/403 | **error**：「`image_generation` 的凭据被拒绝（实际请求 …/images/generations，model=…）」 | 错误 + 指路 | 改配置 |
| 超时 / 用户停止 | 「生成被中断，这一轮不再等它了。」 | 中断 | 可以重来 |
| 返回 0 字节 / 不是图片 | 「provider 返回的不是图片（探测到 text/html，123 字节）。」 | 工具结果 | 可以 |
| 超过写盘上限 | 「这一张超过 20MB，没有写入。」 | 工具结果 | 换档位 |
| 路径越界 / 是目录 | **error**（`SafePath` 的边界拒绝，与 `write_file` 同一条） | 错误 | 不重试 |
| 扩展名冲突 | 见 D9 的文本 | 工具结果 | 换路径 |
| 每轮超过 4 张 | 见 D8 | 工具结果 | 下一轮 |

「不要原样重试」这句话是这张表里最要紧的一行：政策拒绝之后原样重试，在 provider 侧是可观测的行为，代价落在用户的账号上。

### D12 审计与计费：记 provider 报了的事实，不推算

`Audit["image_generation"]`：

```json
{"tool": "generate_image", "style": "openai-images", "model": "gpt-image-1",
 "request_url": "https://…/images/generations",
 "orientation": "landscape", "size": "1536x1024", "bytes": 1834021,
 "path": "out/revenue.png", "duration_ms": 18422,
 "revised_prompt": "…", "request_id": "…", "usage": {"input_tokens": 42, "output_tokens": 4160}}
```

- `size` 是**量出来的**（解码后的宽高），不是请求里那个。
- `usage` 只在 provider 真的报了的时候出现（`gpt-image-1` 会报 token，`dall-e-3` 不会）。**不推算、不补零** —— 一个编出来的 token 数会被 `/stats` 当真，和"命中的缓存比例"那里同一条规矩：没有测量就说 `—`。
- 不写 `cost`。价格表不在这个仓库里，把单价写进代码是那种"三个月后没人敢改"的常量。
- 图片**不进 session 文件**：里面只有路径和 artifact 引用。重开会话时，`![](out/revenue.png)` 仍然能渲染，因为文件在工作区 —— 这是 D4 的第三个理由，也是"artifact 在会话目录、文件在工作区"这套分工的意义。

### D13 不做的事情，以及为什么

| 不做 | 理由 |
| --- | --- |
| 图生图 / 局部重绘 | 要 mask、要传原图当输入；是另一个工具（`edit_image`），和"画一张没有的图"共用不到一半的代码 |
| 一次多张（`n>1`） | 见 D4 |
| 流式预览 | 多数 provider 只在最后给完整图；部分支持 partial images 的那家留到 v2 |
| 版本历史 / 重生成树 | artifact 已经是内容寻址去重，别再造一层历史 |
| Responses 托管 `image_generation` | 见 D3 |
| chat 输出 image part | 见第三节 C |
| `/stats` 的图片计数 | 审计里已经有事实，聚合是 `usage-stats.md` 那一摊的工作，不在这份设计里 |
| 生成结果的自动压缩 | 压图是有损决定，属于人；工具只报告大小 |

---

## 五、数据流

```
用户：画一张上季度营收的横版示意图，放到 docs/images/
  │
  ├─ 权限：medium → 问一次
  │
  ├─ generate_image{prompt, path, orientation}
  │     ├─ 扩展名/边界检查（花钱之前）
  │     ├─ 每轮计数（>4 → 文本，结束）
  │     ├─ POST /images/generations ── 超时 120s ──┬─ 策略拒绝 → 文本（换 prompt）
  │     │                                          ├─ 429/5xx  → 文本（稍后）
  │     │                                          └─ 401/403  → error（改配置）
  │     ├─ b64 → bytes ／ url → 限流下载
  │     ├─ InspectImage（判格式、量尺寸、查两个上限）
  │     ├─ 临时文件 → rename 到 docs/images/revenue.png
  │     └─ Result{Text, Images?, Audit}
  │
  ├─ Images → artifact → runtime note（模型下一轮能看见；无 vision 时无此步）
  │
  └─ 模型写正文：![](docs/images/revenue.png) +「已放到 docs/images/」
        │
        └─ MarkdownImage → inline_image → 显示（≤5MB）
           或 present → 交付卡片（deliverable.kind.image）
```

---

## 六、工具描述（模型唯一的行为指南）

按仓库现有描述的写法（中文、分「什么时候用 / 什么时候不要用」）：

```
根据文字描述生成一张图片，保存到工作区。

什么时候用：用户要一张**不存在**的图 —— 插画、海报、封面、装饰性背景、氛围图。
什么时候不要用：
- 数据图表（柱状图、折线图）、架构图、流程图、时序图 —— 用代码画（matplotlib / graphviz / mermaid）
  或找现成的截图。生成模型会写错数字、坐标和文字，这是它的固有缺陷，不是 prompt 的问题；
- 用户已经有图，只是要改一改 —— 这一版没有图生图能力，说清楚；
- 用 shell 能生成的（二维码、占位图、简单几何图形）—— 更便宜也更准。

prompt 描述**画面本身**：主体、风格、构图、光线、色调。不要写"请生成"/"画一张"，
也不要写数据或精确文字（它画不准）。英文 prompt 通常更稳。

path 必填，相对工作区，扩展名只能是 .png / .jpg / .jpeg。

一次一张。**调用成功后只用一句话说明写到哪、要不要展示，不要复述画面内容** ——
图里的东西用户自己看得见。

如果你看得到图片（当前模型支持 vision），生成后可以自己判断是否要改 prompt 重画；
看不到时只有一次机会，prompt 一次写准。
```

「什么时候不要用」那三条不是客套：这是这个工具唯一能避免"用扩散模型画柱状图"的地方，而那是最常见的浪费。

---

## 七、代码落点

| 位置 | 内容 |
| --- | --- |
| `internal/imagegen/` | 新包。`client.go`（`Route` / `Request` / `Picture` / 错误类型 / 下载与上限）、`openai_images.go`（方言）、`client_test.go` |
| `internal/config/userconfig.go` | **顶层键是白名单**（`topKeys`，`userconfig.go:55`）。不加进去，任何写了 `image_generation` 的配置都会在加载时直接失败，报"unknown top-level keys"。同时 `UserConfig` 要加一个 `ImageGeneration map[string]any` 的原始字段（和 `Providers` 一样，本包不解释它） |
| `internal/state/imagegen.go` | `ImageRoute` 的解析与校验（允许键、继承 `provider`、错误文案），`Catalog` 持有它但**不参与 `Find()`** |
| `internal/tools/builtin/generate_image.go` | 工具本体：校验、计数、写盘、D9 的格式规则、D11 的文案 |
| `internal/tools/builtin/registry.go` | `Assembly` 加 `ImageGen` / `Vision` / `RunID` 三个字段；配置缺失时 `Missing = append(..., GenerateImageToolName)` |
| `internal/runtime/composition.go` | 构造 client（`proxy.Transport`，自己的 `http.Client`）、填 `RunID`、新 notice 分支 |
| `internal/agent/agent.go` | **顺带修一个既存硬编码**，见下；另外暴露一个 `RunID()` getter（`a.runID` 目前是私有字段，D8 的计数器要用） |
| `internal/i18n/` | `notice.imagegen.unconfigured`、工具文案若走 i18n 的部分 |
| `config.example.json` + `internal/config/config.example.json` | 两份同步（`example_test.go` 会较真字节相等） |
| `AGENT.md` / `README.md` | 目录表加 `internal/imagegen/`，配置说明加一节 |

### 两个必须一起改的既存问题

1. **`agent.go:995` 把 artifact 的来源写死成 `Tool: "read_image"`**。第二个能产图的工具一接进来，audit 里的 source 就会说谎（一张生成的图被记成"读出来的"）。修法是把 `prepared.call.Name` 传下去；`prepared` 里已经有 `call` 字段，不需要新结构。
2. **`composition.go:841` 的 `switch missing` 有一个 `default` 分支，会打印 grep 缺二进制的警告。** 新工具的 `Missing` 条目如果不加 case，用户会看到"你的 ripgrep 缺失"，而 ripgrep 好得很 —— 上一轮 `code_explore` 接进来时就踩过这个坑，注释里写着。加 `case builtin.GenerateImageToolName`，notice 用 **info** 级（web_search 用 warn 是因为有人以为它能用；生图从来没被许诺过，配置缺失只是"这个能力不在这里"）。

---

## 八、测试

| 层 | 用例 |
| --- | --- |
| `imagegen` | `httptest` 造：b64 正常、只有 url（下载走限流）、url 超过 20MB、400 带 policy、429 带 `Retry-After`、401、5xx、0 字节、`text/html`、WebP |
| 工具 | 扩展名在花钱之前被拒；`.jpg` 收到 PNG 被拒；`.png` 收到 JPEG 被重编码；路径越界走 error；>20MB 不写盘；6MB 写盘但不给 `Images`；`Vision()==false` 时 `Images` 为空；第 5 张被计数拒绝；`ctx` 取消后没有残留文件 |
| agent | **回归**：`imageMessage` 产生的 artifact source 是 `generate_image` 而不是 `read_image` |
| 配置 | 未知键报错；`provider` 指向不存在的路由时列出可用路由；缺 `model`；`api_style` 未知；只有 `image_generation` 存在时才构造 client |
| 启动 | 未配置时 Schema 里没有该工具、notice 一行、其它工具不受影响（含 grep 不误报） |

---

## 九、分阶段

| 阶段 | 内容 | 验收（人能感知的） |
| --- | --- | --- |
| **v1** | `openai-images` + 工具 + 配置 + notice + 完整失败文案 | 说"画一张…"→ 一次批准 → 图出现在回复里 → 点开放大；说"这是海报"→ 交付卡片；说"太乱了"→ 模型自己改 prompt 重画；断网 → 一句人话 |
| **v1.1** | `gemini` 方言（同端点既吃图又吐图）；`responses` 托管工具（前提是输出 item 解析先落地） | 换一家 provider 只改配置 |
| **v2** | 桌面端配置面板里的生成路由（含"从这个 chat 路由继承 key"的勾选）；`/stats` 的图片计数；partial images 流式预览 | 不手写 JSON 也能配 |

v1 的版本号按仓库约定**次版本 +1**（新工具 + 新配置项，用户可感知）。桌面端源码不动 → 桌面端版本不动。

---

## 十、验收口径

做完之后，下面每一句都应该成立，而且是不看代码就能验的：

1. 没配置 → 启动一行 info，模型看不到这个工具，其它一切不变。
2. 配置了 → "画一张…" 会花一次钱、问一次、得到一张能在回复里看到的图。
3. 图是真的文件（在工作区里、能用系统程序打开），不是聊天窗口里的一段二进制。
4. 重开这个会话，那张图还在、还能显示。
5. 说"数字不对/太乱了" → 模型改 prompt 再来一张，而不是换 URL 抽卡。
6. 拒绝、限流、超时、超大、格式不符，各有各的一句话，没有一句是 `unexpected status code: 400`。
7. 一个轮次里它最多花 4 次钱。
