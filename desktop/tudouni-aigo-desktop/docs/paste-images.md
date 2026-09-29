# 桌面端输入框：粘贴图片方案

| 项 | 值 |
|---|---|
| 目标 | 用户在别处截图/复制了一张图，回到输入框 `Ctrl+V` 就能把它发给模型 |
| 范围 | `desktop/tudouni-aigo-desktop/`（Tauri 2 + React）＋ **`internal/content/paths.go` 一个常量**（见 §2.6，已拍板） |
| 判定依据 | 源码逐文件阅读：`internal/runtime/images.go`、`internal/content/{paths,image,content}.go`、`internal/tools/workspace.go`、`internal/protocol/{messages,server}.go`、`protocol/schema/inbound.schema.json`、`src-tauri/src/lib.rs`、`src-tauri/tauri.conf.json`、`src/components/chrome/Composer.tsx`、`src/hooks/useFileDrop.ts`、`src/runtime/{dragdrop,tauri}.ts` |
| 状态 | **已实施**。§5.1 与 §5.3 已拍板：条数上限两边都改 10；拖放保持绝对路径不动 |

---

## 0. 一句话结论

**不是「加一条图片输入通道」，而是「给已有的那条通道做一个更省事的入口」。**

运行时能收图片的方式只有一种：**用户在句子里写出一条工作区内的图片路径**（`internal/runtime/images.go` 的
文件头把这件事写死了 —— "There is no upload command and no marker to learn"）。协议里
`user_message` 的必填键只有 `v / t / text`（`protocol/schema/inbound.schema.json`，
`internal/protocol/messages.go:158`），服务端是 `text, _ := String(message, "text"); s.startTurn(text)`
（`server.go:397`）→ `r.Agent.RunMessages(r.turnMessages(text))`（`composition.go:1446`）→
`attachPictures(text)`。**没有字节通道，也不该有。**

所以粘贴要做的只有一件事：**把剪贴板里的图片数据落成一个工作区内的文件，再把它的路径插进输入框文本**。
这和拖放（`useFileDrop.ts` → `appendPaths`）是同一个机制，只是拖放已经有绝对路径、粘贴没有。

另有一处 Go 改动：单条消息的图片上限 `MaxImagesPerMessage` **4 → 10**（§2.6、§5.1 已拍板）。

---

## 1. 现状（已核实）

### 1.1 图片这条链路是通的，缺的只是入口

| 环节 | 位置 | 事实 |
|---|---|---|
| 扫描 | `internal/content/paths.go` `FindImagePaths` | 按 token 扫 `.png/.jpg/.jpeg/.gif`，一个 token 给多个读法，由文件系统裁决 |
| 解析 | `internal/runtime/images.go` `resolvePicture` → `Workspace.SafePath`（`tools/workspace.go:83`） | **工作区外一律不附加**；不存在的词当作普通文本，不报错 |
| 上限（单张） | `internal/content/content.go:109` `MaxImageBytes = 5 * 1024 * 1024` | 读之前先 `Stat` 判断，超了发 `skipped` |
| 上限（条数） | `internal/content/paths.go:46` `MaxImagesPerMessage`（现状 4，**本次改成 10**） | 超出部分**点名**发 `over_limit`，不静默丢 |
| 能力闸门 | `internal/runtime/images.go` `modelVision` | 模型没声明 `vision` → 一张都不进，发 `refused`，**这一轮照跑** |
| 类型 | `internal/content/image.go` `ImageMIMEs` | 只认 png/jpeg/gif，且**按字节嗅探**（`http.DetectContentType`），不看扩展名 |
| 反馈 | `src/state/entries.ts` `imageNote` | 四种 status 的行**已经会渲染**（`attached`/`skipped`/`over_limit`/`refused`） |

**也就是说：输出侧（提示、四类结果行）已经建好了，本方案只做输入侧。**

### 1.2 输入框现在完全没有粘贴处理

- `src/` 下 `onPaste` / `clipboardData` / `'paste'` **零命中**。
- `Composer.tsx` 只有两个控件：`+`（开命令面板）和发送/停止；注释里写着 "this build has no
  attachment channel to offer"。这句话在本方案之后要改。
- 拖放是有的（`useFileDrop.ts`，窗口级），它插的是 **Tauri 给的绝对路径**。

### 1.3 剪贴板里的图片是「数据」，不是路径 —— 这是本方案唯一真正新增的东西

从 `Win+Shift+S`、微信、浏览器复制出来的图，剪贴板里是 image 数据；DOM 的 `paste` 事件能拿到它
（`event.clipboardData.items` / `.files` → 一个 `Blob`，WebView2 即 Chromium，这条是稳的）。
但 **WebView 没有文件系统**，而运行时只认文件路径 —— 中间必须有一步落盘，这一步只能由 Rust 做。

**已核实的能力**（不是猜测）：

- Tauri 2 支持把 `ArrayBuffer` / `Uint8Array` 直接当 `invoke` 的请求体，Rust 侧用
  `tauri::ipc::Request` + `InvokeBody::Raw(Vec<u8>)` 取到字节（官方 "Calling Rust from the Frontend"
  文档 + `tauri::ipc::InvokeBody` 的 `Raw(Vec<u8>)` 变体）。**不必走 base64 / JSON 数字数组**
  ——5MB 走 JSON 数字数组是 20MB+ 的字符串。
- CSP 已经是 `img-src 'self' asset: data: blob:`（`tauri.conf.json`），**缩略图用 `blob:`/`data:`
  不需要改 CSP**。（`asset:` 协议本项目没开，所以不要用 `convertFileSrc` 显示缩略图。）
- `dragDropEnabled: true` 与本方案无关，**不要动**。

---

## 2. 方案

### 2.1 数据流

```
剪贴板（image 数据）
  ↓  paste 事件，只在剪贴板确实是图片时拦截
Blob（png / jpeg / gif 字节）
  ↓  前端先过三道闸门（工作区在不在 / 类型 / 大小）
  ↓  invoke('image_stash', <Uint8Array>, { headers: {...} })   ← 原始字节，不是 base64
<workspace>/.tudouni/paste/<session>/paste-<stamp>-<n>.<ext>
  ↓  把「工作区相对路径」插到光标处
草稿文本：看看这个 .tudouni/paste/s-1/paste-...-1.png
  ↓  用户按 Enter（现有路径，一个字都不改）
{v:1,t:"user_message",text}
  ↓  运行时扫描 → SafePath → 5MB/类型/vision 三道闸门 → 附加
event(image_attached, status=attached|skipped|over_limit|refused)   ← 已有渲染
```

**协议零改动**（`user_message` 仍然只带 `text`）；Go 侧只动一个常量（`MaxImagesPerMessage` 4 → 10，§2.6）。

### 2.2 什么时候拦截、什么时候放行（这条最容易做坏）

粘贴处理必须**只在剪贴板里真的有一张图时**才 `preventDefault`：

| 剪贴板内容 | 行为 |
|---|---|
| 有 `image/*` 的 item/file | **拦截**，走落盘 → 插路径 |
| 只有文本 | **完全不碰**，让浏览器默认粘贴照常发生 |
| 从资源管理器复制的文件 | Windows 会同时给 CF_HDROP 和文本，默认粘贴会插出路径 —— **不碰**。若那个文件在工作区内，它本来就能被附加（现状已可用）；在工作区外，运行时按「一个词」处理 |

反过来说：**粘贴处理绝不能让「粘贴一段文字」变差**。这是回归风险最高的一处，验收必须包含它。

`Ctrl+V` 是唯一的入口。**不做按钮**：DOM 层读不到「按需读剪贴板」的图片（`navigator.clipboard.read()`
在 WebKitGTK 上不可靠，且要权限），要做按钮就得引入 clipboard 插件（见 §4.2）。一个按了不一定有反应的
按钮比没有按钮更坏。

### 2.3 落盘：新增一个 Rust 命令 `image_stash`

```rust
#[tauri::command]
fn image_stash(app: AppHandle, request: tauri::ipc::Request) -> Result<StashedImage, String>
```

- 请求体：`InvokeBody::Raw(Vec<u8>)` —— 原始字节。
- 请求头带**扩展名提示**（`x-image-ext`），但 **Rust 不信任它**：自己按魔数判一次
  （PNG `89 50 4E 47` / JPEG `FF D8 FF` / GIF `47 49 46 38`，**不需要新依赖**），判不出来就拒绝。
- 文件名**由 Rust 生成**，绝不用剪贴板/前端给的任何名字：`paste-<yyyyMMdd-HHmmss>-<n>.<ext>`。
  （剪贴板里的名字可以含 `..` 或分隔符 —— 这是本方案唯一的安全面。）
- 目录：`<workspace>/.tudouni/paste/<sessionId>/`，**工作区从桥自己记的 workspace 取**，
  不从参数传（前端传来的路径不该被信任）。
- 返回：`{ path: ".tudouni/paste/<session>/paste-...-1.png", bytes }`（**工作区相对路径** + 字节数）。
  **`width`/`height` 不做**：量尺寸要在 Rust 里解 PNG/JPEG/GIF 头，那是第二个图片实现；尺寸由运行时的
  `image_attached` 行给出（它已经发 `width`/`height`）。

需要同步改的地方：`AttachOptions`/`spawn` 把 workspace 存进桥（现在没存）、`generate_handler!` 加一项。

**为什么写进 `.tudouni/`**：它必须在工作区内（`SafePath` 是硬边界，写外面等于永远附加不上）；而写进
用户的项目树会在 `git status` 里留下一堆截图。`.tudouni/` 已被 `.gitignore` 忽略，运行时自己也把
`jobs/`、`artifacts/` 放在这里。注意 `ControlPlane`（`tools/workspace.go:45`）约束的是**agent 的写**，
不是本程序的写 —— 而且它只挡写、不挡读，所以运行时照样能读回这些图片。

**清理**：镜像 `JobBoard` 的做法，**启动时按 session 清空自己的 `paste/<session>/`**。代价说清楚：
上次会话里那条消息的路径可能已经不存在了，此时运行时按「一个词」处理（不附加、不报错）。**这不丢图片** ——
图片在附加时已经被运行时存进内容寻址的 artifact store（`.tudouni/artifacts/<session>/`），
粘贴目录只是一个暂存区。

### 2.4 输入框里的表现

**文本是唯一事实来源**（因为只有它会被发出去）：

- 图片落盘后，把**工作区相对路径插到光标处**（不是像拖放那样追加到末尾 —— 粘贴有光标）。
  插入后补一个空格，保证它和前后文字不是一个 token。
- 草稿里出现路径 → 输入框上方（`cp-box` 内、textarea 之上）出现一行**缩略图条**：
  每张一个 chip，`blob:` URL 缩略图 + 文件名 + 大小 + 一个移除按钮。
- **chip 的存在与否由草稿文本决定**：chip 的路径还在草稿里就显示，被用户手删了就不显示。
  这样「文本是唯一事实来源」不会退化成两处状态互相打架。移除按钮 = 从草稿里删掉那一个路径。
- 缩略图条是**纯前端偏好**，不进协议、不进 `store` 的运行时事实那一组（`store.ts` 的分组规则）。

### 2.5 三道闸门 + 一条预告

| 闸门 | 前端行为 | 与运行时的一致性 |
|---|---|---|
| 工作区未知（握手前） | 拒绝，说明理由（沿用拖放的 `no-workspace` 说法） | 一致 |
| 类型不是 png/jpeg/gif | 拒绝，句子说清「它是什么类型」（按魔数） | 与 `InspectImage` 同一套判据 |
| 单张 > 5MB | 拒绝，**在写盘之前** | 与 `content.MaxImageBytes` 同一个数 |
| 模型没有 `vision` | **不拦**，给一句预告（"当前模型不能收图片，这一轮只发文字"） | 与 `refused` 的语义一致：一轮照跑、说清楚 |

前端要硬编码 5MB 这一个数。这不是「自己发明一个数」，而是**镜像**运行时的常量 —— 本仓库已有先例：
`lib.rs` 的 `unsafe_workspace` 就是镜像 `paths.UnsafeWorkspace`，并且注释写明了两者不能漂。
两处（TS 与 Rust）都写，都注明来源 `internal/content/content.go:109`。

`vision` 从 `init.model_catalog[].vision`（当前模型那行）+ `ui(state).model` 读，是运行时事实，
**不猜**；`/model` 切换后 `ui(state)` 会更新它。

### 2.6 条数上限：**10**（已拍板）

运行时单条消息最多附加的图片数从 **4 改成 10**，前端暂存上限也是 **10**。两边同一个数，
界面上不再出现「暂存 10 张、实际只发 4 张」这种两套账。

改的是 `internal/content/paths.go:46` 的 `MaxImagesPerMessage`（4 → 10）。**它不是一个纯常量替换**，
连带的东西下面列全了 —— 都是「改一个数之后会静默变错」的地方，而不是顺手做的清理：

| 连带项 | 为什么 |
|---|---|
| `FindImagePaths` 的扫描上限 | `paths.go:144` 是 `count >= MaxImagesPerMessage*2` —— 它跟着常量走，**不用改**，但正因为是乘法而不是字面量，改常量时不会漏掉它 |
| `internal/runtime/images_test.go` | `TestOnlyTheFirstFewPicturesAreAttached` 用 `MaxImagesPerMessage+3` 造 13 张图，断言 `== MaxImagesPerMessage`。常量改了它**自动跟着走**，这是它写对了的地方；要确认的是「13 张 40×40 的 PNG 会不会把测试拖慢」——不会，每个几十字节 |
| `internal/frontends/tui/structure_test.go:815` | **会漂**：那里硬编码 `{"over_limit", []string{"4", "shot-d.png"}}`，同一条用例里 `"limit": 4`。它断言的是「`limit` 被念出来了」，不是「上限是 4」，但字面量会与真实常量脱节。**最干净的修法不是对齐到 10，而是换成一个与真实常量不同的数**（例如 `"limit": 7` 配期望串 `"7"`）——那样它才真的在证明「payload 里的 limit 被原样念出来」，而不是碰巧和常量一致。顺带说明：该文件目前**没有** import `internal/content`（已核实 import 块），所以「从常量取」会给一个 TUI 测试包引入新依赖，不是更好的选择 |
| `internal/i18n/en.go:249` | `event.image.over_limit` 是 `"only the first {limit} images were attached"`，`{limit}` 由运行时填 —— **不用改** |
| `src/state/entries.ts:726` 的文案 | `"N more picture(s) did not fit (limit ${limit} per message)"`，`limit` 来自事件 —— **不用改** |
| `internal/runtime/images_test.go` 之外的计数 | 全仓再没有第二个地方硬编码 4（已 grep 确认：只有 `paths.go`、`images.go`、`images_test.go`、`structure_test.go`、`entries.ts`，以及 `internal/i18n/en.go` 的 `{limit}` 词条 —— 后两者都是模板，不写死数） |

**成本这件事要说清楚**：这个常量原本的注释写明它是**成本上限** —— 每张图约一千 token 且要 base64 进
请求体。10 张意味着一条消息最多约 1 万 token 的图片预算 + 约 6.7MB 的 base64（按 5MB 单张算，
实际截图远小于此）。这是**有意的取舍**：用户自己粘的 10 张图，比一个 `ls *.png` 粘进来的 100 个文件名
可预期得多，而后者本来就被 10 这个数继续挡着。注释里那段「为什么有上限」的理由仍然成立，
只是数变了，**注释要一起改**（把「4」写死进注释的地方都改成 10，或改成不写具体数字）。

---

## 3. 改动清单

### 新增

| 文件 | 内容 |
|---|---|
| `src/runtime/paste.ts` | **纯函数**：魔数嗅探、闸门判定、文件名/路径拼装、光标处插入、chip 与草稿文本的对账。与 `dragdrop.ts` 同级同风格，**可单测** |
| `src/hooks/useClipboardPaste.ts` | textarea 的 `onPaste` 接线；只在剪贴板有图时拦截 |
| `src/components/chrome/ImageTray.tsx` | 缩略图条（chip 行） |
| `tests/paste.test.ts` | 上面那些纯函数的用例（接进 `tests/run.mjs` 的入口列表） |
| 本文档 | —— |

### 修改

| 文件 | 改动 |
|---|---|
| `src-tauri/src/lib.rs` | 桥里记住 workspace；新增 `image_stash`（原始字节 + 魔数校验 + 自己生成文件名 + 启动时清理）；注册进 `generate_handler!` |
| `src/runtime/tauri.ts` | `stashImage(bytes, extHint)` 封装（原始体 invoke），失败返回可读句子 |
| `src/components/chrome/Composer.tsx` | textarea 挂 `onPaste`；把 `dropNotice` 泛化成**一个**提示槽（`{code, params}`），容纳粘贴的几种理由；渲染 `<ImageTray />` |
| `src/state/store.ts` | 草稿旁增加 `pastedImages`（前端偏好组）；`submitDraft` **一个字都不改**（文本仍是唯一出口） |
| `src/styles/app.css` | chip 行与 chip 的样式（`class-audit.mjs` 要求每个 className 都有规则） |
| `src/i18n/index.ts` | 新增词条（全英文，与既有约定一致） |
| `README.md` | 把 "no attachment channel" 那段改成两条入口：拖入路径 + 粘贴落盘 |
| `internal/content/paths.go` | `MaxImagesPerMessage` 4 → 10，注释里写死「4」的地方一起改（§2.6） |
| `internal/frontends/tui/structure_test.go` | `:815` 那个硬编码的 `4` 换成一个**与常量无关**的数（§2.6），让那条用例真的在证明「payload 里的 `limit` 被原样念出来」 |
| 版本号 | 根 `VERSION` + 桌面端 5 处，见 §7 |

### 明确不改

- `internal/**` 除 `paths.go` 的常量与 `structure_test.go` 那一个字面量之外，全部不改
- `protocol/schema/*.json`、`internal/protocol/**`
- `tauri.conf.json` 的 `dragDropEnabled`、CSP（`blob:`/`data:` 已经在里面）
- `src-tauri/capabilities/default.json`（DOM 粘贴路线不新增插件，不需要新权限）
- `useFileDrop.ts`、`appendPaths` 与拖放的既有测试（§5.3 已拍板保持不动）

---

## 4. 取舍与风险

### 4.1 Linux 上「图片数据」的粘贴可能拿不到（唯一的功能性风险）

WebKitGTK 长期无法从剪贴板粘贴 **image 数据**（`clipboardData.items.length === 0`）：
WebKit bug 218519，2020 年报告，**2025-10-21 才随 commit 301877@main 修复**。
也就是说：在发行版自带的旧 WebKitGTK 上，DOM 路线在 Linux 上可能一张都粘不进来（Windows/WebView2 不受影响）。

本方案的处理：**先做 DOM 路线**（零新依赖、Windows 上稳），把这条限制写进 README，
真到需要 Linux 时再走 §4.2 的备选。不做「猜一个」的兜底。

### 4.2 备选：`tauri-plugin-clipboard-manager`

官方插件（2.4.0，底层 `arboard ^3`），有 `read_image`，Windows/Linux/macOS 都支持，能绕开 4.1。
代价是实打实的：

- 新插件 + 新平台依赖（Linux 上会拉 X11/Wayland 的剪贴板库），`crates.io` 索引本机没缓存，需要联网；
- 它返回的是 **RGBA 像素 + 宽高**，不是 PNG 字节 —— 落盘还得再引一个编码器
  （`png` crate 已在 `Cargo.lock` 里，但是通过 tauri 的图标链路传递进来的，不该依赖这个巧合）；
- 能力文件要加 `clipboard-manager:allow-read-image`。

**结论：不作为第一版。** 如果 §4.1 在实际使用中真的咬人，再单独做一次。

### 4.3 其他已知限制（先说清楚，不藏）

- **`/resume` 后用户消息行看不到那张图**：`projectHistory`/`textOf`（`adapt.ts`）只取文本 part，
  图片 part 被跳过 —— 拖放早就有这个现象。图片本身没丢（artifact 里还在），只是行里看不见。
  修它要在历史行里渲染 `[Image: name]`，**属于相邻问题，本方案不含**（要做就单独一条）。
- **不做缩放**：粘贴 4K 截图不做 canvas 重编码。运行时的降级阶梯（原图 → 缩略图 → 一句话）
  已经承担了「太贵」这件事；在前端再做一份就是第二个图片管线，正是仓库注释反复警告的那类东西。
- **不做内容寻址去重**：同一张图粘两次会落两个文件。运行时在 artifact 层按内容去重
  （`attachPictures` 的 `seen[artifact.ID]`），所以不会重复计费。想省磁盘可以以后改成
  `<sha256[:12]>.<ext>`，与 `art_<sha256[:12]>` 同一风格。
- **不做自动发送**：粘贴只改草稿，发送仍然是用户按 Enter。

---

## 5. 已拍板

### 5.1 条数上限：**两边都改 10**

- 运行时 `internal/content/paths.go:46`：`MaxImagesPerMessage` 4 → 10（连带项见 §2.6）。
- 桌面端暂存上限：10。
- 界面上不再有「暂存 10 / 实际发 4」两套账 —— 只有一个数，就是 10。

### 5.2 暂存目录的位置：**`<workspace>/.tudouni/paste/<session>/`**

（gitignore 已覆盖、启动时清理、与 `jobs/`、`artifacts/` 同风格。）
另一条路是放系统临时目录 —— **但那一定会失败**，因为 `SafePath` 只认工作区内。所以其实没得选，
列在这里只是让你知道为什么不是 `%TEMP%`。

### 5.3 拖放的绝对路径：**保持不动**

粘贴插相对路径（`.tudouni/paste/...`），拖放继续插 Tauri 给的绝对路径（`C:\Users\...\a.png`）。
两者在会话文件里会以两种写法出现，**这是已知且接受的代价** —— 拖放是既有行为，不为统一写法去动它。
`useFileDrop.ts`、`appendPaths` 与它的既有测试都不在本方案的改动范围内。

---

## 6. 执行顺序与验证

### 顺序

1. `internal/content/paths.go` 的常量与注释改 10；`structure_test.go` 那个硬编码的 `4` 换成一个无关的数；
   `go test ./internal/content/ ./internal/runtime/ ./internal/frontends/tui/`
2. `src/runtime/paste.ts` 纯函数 + `tests/paste.test.ts`（先让判据可测，再接线）
3. `lib.rs` 的 `image_stash`（字节 → 魔数 → 写盘 → 返回相对路径；启动清理）
4. `tauri.ts` 的封装 + `useClipboardPaste.ts` 接线（含「文本粘贴不受影响」的放行分支）
5. `ImageTray.tsx` + `Composer.tsx` 的提示槽泛化 + CSS + i18n
6. README 与本文档的状态更新

第 1 步放最前面，是因为它动了 `internal/`，按根 `AGENT.md` 属于「大改动」：**跑全量 `make test`**，
并且要走一次 `make build`（版本号变了，`--version` 的输出必须从真实二进制里读回来验）。

### 验证（已执行，结果如下）

| 手段 | 结果 |
|---|---|
| `go test ./internal/content/ ./internal/runtime/ ./internal/frontends/tui/` | **通过**（定向，第 1 步） |
| `make test`（全量） | `internal/frontends/cli`、`internal/mcp` 失败，退出码 `0xffffffff` 且无输出 —— 已在**基线**（stash 掉本次全部改动）复现，是根 `AGENT.md` 记录的沙箱 runner 问题 |
| `bash test.sh`（沙箱兜底） | 这两个包 **ok**。另有 `internal/config`、`internal/protocol`、`internal/state` 失败，原因是 `test.sh` 直接从仓库根跑二进制、`..\..\config.example.json` 这类相对路径解析不到 —— 它们在 `go test ./...` 下 ok。两边合起来全绿 |
| `make build` + 真实二进制 `--version` | **通过**，输出 `tudouni-aigo 5.7.0` |
| `npm run typecheck`（`tsc -b`） | **通过**，0 错误 |
| `npm test` | **92/92 通过**（原 88 + 本次新增 4 组；`paste.test.ts` 已接进 `tests/run.mjs`） |
| `npm run build` | **通过**（`tsc -b` + `vite build`） |
| `npm run audit:css` | **PASS** —— 新增的 6 个 class 都有规则（那 71 个「定义了但未引用」是既有的） |
| `cargo check` | **通过**（`Finished dev profile`） |
| **人工验收** | **未做** —— 见下 |

自动化做不到「真的读系统剪贴板」这一步（CDP 注入不了系统剪贴板内容），所以下面这些必须人工点一遍，
其中第 ⑥ 项是最重要的回归项：

① `Win+Shift+S` 截图后 `Ctrl+V` → 出现 chip + 路径；② 模型有 `vision` → 回答里能看到图；
③ 模型无 `vision` → 出现 `refused` 行且**这一轮照跑**；④ 粘 12 张 → `over_limit` 行点名后两张；
⑤ 粘一个 >5MB 的图 → 明确拒绝；⑥ 复制一段**文字**粘贴 → 与改动前完全一样；
⑦ 关掉再开、恢复会话 → 不崩、不重复落盘。

### 实施中改掉的两处设计（与本文档原方案不同）

两处都是**测试先失败、再定位到实现有缺陷**，而不是为了让测试变绿而改期望：

1. **`referencedImages` 从「严格 token 相等」改成移植运行时的扫描器。** 原方案说「按
   `content.trimToken` 比较」，但运行时是**逐 token 给出多个读法、由文件系统裁决**
   （`content.pathCandidates`）。严格相等会**双向出错**：漏报运行时能解析的写法
   （`看这个（a.png）。`），以及把 `xa.png` 误判成 `a.png`。现在四个读法与顺序都与 Go 侧一致。
2. **`removePathFromDraft` 只删路径，不删整个 token。** 原实现按 token 删，而中文句子里的路径
   是**同一个 token**（`看这个（a.png）。`），于是「移除一张图」会把用户自己写的字一起删掉。
   现在只做子串删除，留下的括号与句号是用户写的标点，不该由这个动作替他们删。空白折叠也收窄成
   「只压连续空格/制表符」，不再把多行草稿拍成一行。

另外，`image_stash` 最终**没有 session 参数**：原始字节体是唯一载荷，没有地方放第二个命名参数
（`invoke` 带原始体时没有并列的 JSON 对象）。这正好也是对的形状 —— 会话子目录只会分开一批
「同一时刻一起清理」的文件，而工作区取自桥自己记的值，所以没有任何调用方提供的字符串进入这条路径。

---

## 7. 版本号

按仓库根 `AGENT.md` 的判据（`git diff --stat -- '*.go'` 是否为空）：本次**改了 Go**
（`internal/content/paths.go` 的常量），所以**两边都升**。

| 版本 | 变化 | 依据 |
|---|---|---|
| 仓库根 `VERSION` | `5.6.1 → 5.7.0` | 单条消息能带的图片数从 4 变 10，是**用户能感知的行为变化** → 次版本 +1。它不是修复、不是文案，别按修订号走 |
| 桌面端 | `0.4.1 → 0.5.0` | 新增用户可感知的能力（粘贴图片） |

**桌面端 5 处已一致为 `0.5.0`**（`package.json`、`package-lock.json` 的根与 `packages.""`、
`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 的
`name = "tudouni-aigo-desktop"` 那一项）—— 这一项由仓库里另一处改动一并完成，本次未再改动它们。

两个轴互不约束（根 `AGENT.md` 的「两边都改了才两边都升」正是指这种情形），所以它们各自升各自的。
