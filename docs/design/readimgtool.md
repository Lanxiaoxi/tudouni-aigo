可以，`read_image` 我建议就按下面这个思路实现：

### `read_image` 核心设计

```text
read_image(path)
      ↓
SafePath 校验
      ↓
读取图片 + MIME / 大小 / 尺寸校验
      ↓
保存/复用 Image Artifact
      ↓
返回 ImagePart
      ↓
进入 Context
      ↓
LLM
```

### 关键原则

1. **独立于 `read_file`**

   * `read_file` → 文本 → `TextPart`
   * `read_image` → 图片 → `ImagePart`

2. **不要返回 Base64 字符串**

   ```text
   ❌ ToolResult.Text = base64
   ✅ ToolResult.Content = ImagePart
   ```

3. **复用你已经建立的 ContentPart 抽象**

   ```text
   ToolResult
   ├── TextPart
   └── ImagePart
   ```

4. **图片本身放 Artifact**

   ```text
   read_image
      ↓
   ImageArtifact
      ↓
   ImagePart(artifact_id)
   ```

5. **和用户主动提供图片走同一条后端链路**

   ```text
   用户给图片 ─────┐
                   ├→ ImageArtifact → ImagePart → Context → LLM
   read_image ─────┘
   ```

6. **最终解决的场景**

   ```text
   list_files
      ↓
   发现 architecture.png
      ↓
   read_image("architecture.png")
      ↓
   模型真正看到图片
   ```

**一句话：**

> `read_image` 不是“把图片读成字符串”，而是“把图片转换成 Runtime 可以进入 Context 的 `ImagePart`”。
