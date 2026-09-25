可以。结合你这份现状调查，我建议你**不要把它当成“给 Runtime 增加图片支持”来做，而是把它作为一次“Context 从 Text-only → Multimodal Content”的升级**。

下面这份可以直接作为你的执行方案。

## 总体目标

最终把现在：

```text
Message
   ↓
string
   ↓
Context
   ↓
string
   ↓
LLM
```

升级成：

```text
Message
   ↓
Content[]
   ├── Text
   ├── Image
   └── Future: Audio / File / Video ...
   ↓
Context
   ↓
Content[]
   ↓
Provider Adapter
   ├── OpenAI
   ├── Anthropic
   └── Responses
```

核心原则只有一句：

> **Runtime 内部不应该理解“OpenAI 图片格式”，Runtime 只理解 `ImagePart`；具体怎么发给模型，由 Provider Adapter 决定。**

你现在的 Context 全链路是 `string`，这正是第一优先级需要解决的问题。

---

# 第一阶段：先重构 Content 抽象

### 目标

不要急着实现图片。

先让 Runtime 从：

```go
content string
```

变成：

```text
Content
 ├── TextPart
 └── ImagePart
```

例如概念上：

```go
type ContentPart struct {
    Type string

    Text  *TextPart
    Image *ImagePart
}
```

或者你更喜欢 Go 的方式，也可以：

```go
type Content interface {
    Kind() ContentKind
}

type TextContent struct {}
type ImageContent struct {}
```

**重点不是具体 Go struct 怎么写，而是建立一个稳定的 Content 抽象。**

第一阶段完成后，即使暂时没有图片，你原来的文本消息也应该走：

```text
Text
 ↓
TextPart
 ↓
Context
 ↓
Provider
```

而不是：

```text
string
```

### 这一阶段不要做

* 不做图片读取
* 不做 Base64
* 不改 OpenAI Adapter
* 不改 TUI
* 不做图片 token 估算

先把核心数据模型稳定下来。

---

# 第二阶段：Artifact 正式支持 Image

你的现有 Artifact Store 可以继续使用，不需要重新设计一套图片存储系统。

你现在已经验证过，Artifact 底层可以保存二进制内容；真正需要调整的是 representation 语义。

把 Artifact 类型扩展成：

```text
Artifact
 ├── text
 ├── image
 └── ...
```

图片 Artifact 至少应该拥有：

```text
id
type = image
mime_type
size
digest
path
```

以后可以继续增加：

```text
width
height
thumbnail
```

### 非常重要

**Artifact 保存原始图片。**

不要：

```text
图片
 ↓
Base64
 ↓
Artifact
```

而应该：

```text
图片文件
 ↓
binary artifact
```

Base64 只在 Provider Adapter 最后一步需要的时候生成。

这样可以避免你调查里指出的 JSONL 膨胀、重复发送和 token 估算问题。

---

# 第三阶段：实现“路径 → Image Artifact”

这是用户真正看到的功能。

用户输入：

```text
帮我分析这个页面 /tmp/screenshot.png
```

Runtime 需要识别：

```text
/tmp/screenshot.png
```

然后：

```text
路径
 ↓
SafePath
 ↓
读取文件
 ↓
MIME sniff
 ↓
大小检查
 ↓
Image Artifact
```

你调查里已经确定了几个约束：

* 使用 `http.DetectContentType`
* 有明确尺寸上限
* 使用现有 `SafePath`
* 不走审批
* `vision=false` 必须明确拒绝

这些可以直接作为实现约束。

---

# 第四阶段：让 Image 进入 Context

这是**整个改造最核心的一步**。

以前：

```text
ContextItem
   ↓
Renderer
   ↓
string
```

改成：

```text
ContextItem
   ↓
Renderer
   ↓
RenderedContent
   ├── Text
   └── Parts
         ├── TextPart
         └── ImagePart
```

于是：

```text
用户消息：

“帮我分析这张图”
+ 
ImageArtifact
```

进入 Context 后变成：

```text
User Message
 ├── TextPart("帮我分析这张图")
 └── ImagePart(artifact_id)
```

**注意：这里不要马上 Base64。**

Context 只知道：

```text
这是一个 ImagePart
它对应哪个 Artifact
它当前应该以什么 level 参与上下文
```

---

# 第五阶段：把 Context Budget 改成 Content-aware

你现在有一个非常危险的问题：

```go
content, _ := message["content"].(string)
```

当 `content` 变成数组之后，就会得到空字符串，从而把图片错误计算成很小的 token 数。你的调查已经明确指出了这个问题。

所以这一阶段要建立：

```text
Content
   ↓
EstimateCost()
```

而不是：

```text
string
   ↓
EstimateTokens()
```

例如：

```text
TextPart
    → text token estimate

ImagePart
    → image token estimate

Future AudioPart
    → audio cost estimate
```

这里暂时**不要追求精确模拟所有 Provider 的视觉 token 算法**。

第一版只需要建立正确的架构：

```text
ContentCost
 ├── text
 ├── image
 └── ...
```

以后再针对 Provider 优化。

---

# 第六阶段：实现 Context 降级

这是你现有 Context 架构非常值得利用的地方。

图片不能简单按照：

```text
full → 截断字符串
```

处理。

应该变成：

```text
Image Artifact

Level 1
↓
原图

Level 2
↓
缩略图

Level 3
↓
图片 metadata

Level 4
↓
图片移出 context
```

也就是说：

```text
Text
→ truncate

Image
→ resize / thumbnail / metadata / remove
```

这样你的：

```text
Fit
Compact
Eviction
Budget
```

仍然可以继续工作。

你的调查也已经明确把这一点作为方案 B 的核心价值。

---

# 第七阶段：Provider Adapter

到这里 Runtime 内部已经完全不关心具体 API 了。

现在才开始处理：

```text
ImagePart
      ↓
Provider Adapter
```

### OpenAI

```text
ImagePart
 ↓
image_url
```

你当前 openai dialect 的 `content` 已经能够原样透传，因此这条路线改动相对少。

### Anthropic

```text
ImagePart
 ↓
type=image
source=base64
media_type=...
data=...
```

必须避免当前的：

```text
stringifyContent()
```

否则会被变成 JSON 字符串。

### Responses

同样：

```text
ImagePart
 ↓
input_image
```

不要走当前的纯文本转换路径。

---

# 第八阶段：`vision` 成为能力闸门

你现在已经有：

```text
ModelRef.Vision
```

所以不要再创建：

```text
supports_image
enable_multimodal
allow_vision
```

之类的新开关。

直接：

```text
model.vision
```

作为唯一事实来源。

流程：

```text
发现 ImagePart
       ↓
model.Vision ?
   ┌───┴───┐
 false    true
   ↓        ↓
明确报错   继续
```

尤其不要：

```text
vision=false
 ↓
悄悄丢掉图片
 ↓
继续请求
```

因为这样模型会得到错误的上下文。

你现有文档也明确要求 `vision=false` 时显式拒绝。

---

# 第九阶段：TUI 最后再做

TUI 不应该成为第一阶段的阻塞点。

第一版只需要能够显示：

```text
User:
帮我分析这个页面

[Image: screenshot.png]
```

或者：

```text
[Image: image/png, 1280×720]
```

**不需要第一版就在 TUI 里真正渲染图片。**

重点是：

```text
用户知道这条消息包含图片
```

以及：

```text
/resume
```

以后不会变成一片空白。

你现在 TUI 会丢掉 `content[]` 中的 image block，这个问题可以放在核心 Runtime 跑通之后处理。

---

# 最终架构

你最终应该得到这样的结构：

```text
                         ┌──────────────────┐
                         │      User        │
                         │  text + image    │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │ Input / Runtime  │
                         │ path → artifact  │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │     Message      │
                         │                  │
                         │ Content[]        │
                         │  ├─ Text         │
                         │  └─ Image        │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │     Context      │
                         │                  │
                         │ Render           │
                         │ Budget           │
                         │ Fit              │
                         │ Compact          │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │ Provider Adapter │
                         │                  │
                         │ OpenAI           │
                         │ Anthropic        │
                         │ Responses        │
                         └────────┬─────────┘
                                  │
                                  ▼
                                LLM
```

---

# 建议你的实际执行顺序

我建议你严格按照这个顺序：

```text
① Content 抽象
      ↓
② Artifact Image
      ↓
③ Path → Image Artifact
      ↓
④ Renderer 支持 Content
      ↓
⑤ Budget 支持 Image
      ↓
⑥ Context Level / Image 降级
      ↓
⑦ Provider Adapter
      ↓
⑧ vision gate
      ↓
⑨ TUI
      ↓
⑩ MCP Image Block 接入
```

其中真正的**第一里程碑**不要定义成：

> “模型已经能看图片。”

而应该定义成：

> **“Runtime 内部已经从 Text-centric 正式变成 Content-centric。”**

完成这个之后，图片只是第一个 `ContentPart`。

---

## 最后给你一个实现时应该一直遵守的原则

以后你的 Runtime 里面，尽量不要再出现这种设计：

```go
func xxx(...) string
```

如果这个 `string` 的语义实际上是：

> “模型上下文中的内容”

那么就应该开始警惕。

逐步变成：

```text
string
 ↓
Content
 ↓
ContentPart[]
```

这样你这次不是单纯给 Agent 加一个 Vision 功能，而是**把 Agent Runtime 的上下文模型升级成真正支持多模态的基础设施**。

而你已经完成的 Context Compaction、Budget、Artifact、Fit、Eviction 等机制都可以继续复用，不需要推倒重来。
