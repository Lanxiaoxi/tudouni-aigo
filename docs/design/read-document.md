# 文档读取方案：`read_document` 内置工具

> 状态：**第一期与第二期均已实现（6.31.0）**。
>
> ## 第二期（扫描 PDF → 视觉通道）实现要点
>
> 代码：`internal/tools/builtin/document_render.go`。
>
> - **渲染器只用 `Windows.Data.Pdf`**（系统自带，经 Windows PowerShell 5.1 的 WinRT 投影调用，
>   `-EncodedCommand` + 环境变量传参，不落脚本文件、不拼命令行）。原方案里 Linux 的
>   pdfium / mutool 选型问题随“Linux 不支持”一并消失：mutool 是 AGPL，pdfium 要 cgo，都不引入。
> - **只在模型能看图时渲染**：`Assembly.Vision` 每次调用都读（会话中途可换模型）。看不了图时只回
>   “第 N–M 页无文字层 + 当前模型看不到图片”，不产生任何渲染开销。
> - **图片走 `Result.Images`**，与 `read_image` 同一条通道：预算按面积计价、降级梯子先缩略图再丢弃，
>   下游不需要知道它来自 PDF。每页 artifact 的 path 形如 `scan.pdf#p2`，保证同一文件的多页不会
>   同名。
> - **上限**：每次调用最多 3 页（`maxRenderedPagesPerCall`），每轮最多 12 页
>   （`maxRenderedPagesPerTurn`，按 run id 比较自动清零，同 `generate_image`）。没渲染的页在结果里
>   点名，并提示带 `pages` 分批读。渲染失败 / 某页编码失败会把额度退回。
> - **体积**：宽 1400px、JPEG q80、先铺白底（透明页转 JPEG 会变黑）；渲染结果先查像素与字节上限，
>   超限变成这条结果里的一句话，不是下一轮丢失的图片。
> - **“空白锚点页”与扫描页合并**：anymd 对部分页（PoC 样本第 13 页）不给扫描提示，只留空锚点，
>   同样按“无文字层”处理并一并渲染。
> PoC 已验证（2026-07，anymd 8.5.7，Windows 本机）
>
> ## 实现与原方案的差异（以代码为准）
>
> - **只支持 Windows。** `tools/vendor/anymd/` 只有 `x86_64-pc-windows-msvc`；Linux 包不带它。
>   远程工作区在远端跑 Linux runtime，所以那边没有 `read_document`，**也不报警**（从没承诺过）。
>   唯一判据是 `release.Target.HasAnymd()`；注册门控 `builtin.AnymdPlatformSupported()` 与
>   `AnymdBinary()`、暂存、布局校验、桌面端 `stage-runtime.mjs` 都跟着它走。受支持平台上二进制
>   丢了才算安装损坏，走 `notice.document.missing_binary`（warn）。
> - **`read_file` 的联动提示是条件式的**：只在 `read_document` 真的注册时才点名它（见 `nonTextHint`），
>   否则 Linux/远程上会指向一个模型调不了的工具。
> - **扩展名不作数，内容作数**：anymd 按扩展名判类型，`.dat` / 无扩展名的 docx 会被它拒绝。
>   包装层嗅探字节后，必要时拷一份正确扩展名的临时副本再读。
> - **上下文管理**（方案里没展开，实现时补的）：
>   1. 续读配方（`[续读] read_document(path=…, cursor=…)`）放在**结果最前面**——上下文降级的
>      preview 层只留开头，放结尾会最先被切掉。
>   2. 不暴露 `max_tokens`；另有“按模型窗口折算”的二次读取：anymd 的 token 估算对中文偏松
>      （实测 8000 → 约 1.8 万汉字），超过 `documentSoftTokens` 就用更小的预算重读一次，
>      而不是硬截断（截断后的文本没有可信 cursor）。最后还有 `documentMaxChars` 兜底，截断时
>      明确撤销 cursor。
>   3. 结果在 context 层是独立的 `document` 类型 artifact（`DocumentStrategy`），记录 `pages` /
>      `node`，降级到 metadata 行后仍能看出“读的是哪一段”，避免模型重复读同一段。
>   4. 子进程不在工作区里跑（cwd 为系统临时目录），同时最多 2 个抽取进程并发。
>   5. 前置 `--front-matter` 取总规模；PDF 里“空白锚点页”与扫描页合并成同一句“无文字层”。
> - 发布自检：`tools/release` 对暂存的 anymd 跑 `version` 并转换一份程序生成的 docx
>   （`release.SampleDocx`），对标 `grep.missing_binary` 那条。
> - 版本 pin 的单一来源是 `release.AnymdVersion`（文档里的“两处”已收敛为这一处 + README）。
> 关联：`vision-input.md`（多模态 Context 的基础，本方案依赖其图片通道）、`internal/tools/builtin/`

## 1. 问题

用户给工作区里的 Word / PPT / PDF / Excel 文件时，运行时没有任何读取手段：

- `read_file` 遇到二进制直接返回「不是 UTF-8 文本，读不了」；
- 模型只能退而用 `shell` 自己想办法（解压 docx、调 `pdftotext`、Python 库），
  每一步要审批，成败取决于机器上碰巧装了什么，结果不稳定；
- 桌面端拖入 / 粘贴文件时插入的只是路径文本，`images.go` 的图片通道只认
  `.png/.jpg/.jpeg/.gif`。

## 2. 路线选择

调研过三个方向：

1. **在 `read_file` 里加类型路由** —— 否决。`read_file` 的契约是「原样返回 UTF-8
   文本 + 行号」，`edit_file` 依赖逐字一致的原文。让同一工具对 docx 返回抽取文本
   会误导模型以为读到了原文，且行号 / outline 参数对文档语义（页、幻灯片、章节）
   不成立。
2. **把 anymd 当 MCP server 挂上** —— 否决。`internal/mcp` 规定所有 MCP 工具一律
   高风险、每次审批；依赖 Node/npx 联网下载且不锁版本；暴露一组冗余 schema；
   其 URL 抓取绕过 `fetch_web` 的「不可信内容」标记；远程工作区要求远端有 Node。
3. **vendor anymd 二进制 + 自研 `read_document` 包装工具** —— **采用**。
   与 `tools/vendor/rg/`、`cg-parse` 同一模式；工具在 Go 侧，本地和远程工作区
   通用；可定成 `RiskLow`，不逐次审批。

引擎选 [anymd](https://github.com/SylphxAI/anymd)（Rust，MIT，1.1k star）：
PDF / DOCX / PPTX / XLSX / EPUB / HTML 一个二进制全包，CLI 支持 `--pages`、
`--max-tokens` + `--cursor`、`outline` + `--node` 分页分段，输出带
`<!-- page N -->` / `<!-- slide N -->` / `<!-- sheet 名 -->` 锚点的 Markdown。

## 3. PoC 结论（.poc-anymd/，可复现）

样本：2 份 pptx、2 份截图导出的 pdf（jsPDF，无文字层）、1 份 docx、1 份 12MB xlsx。

| 格式 | 效果 | 实测问题 |
| --- | --- | --- |
| docx | 好 | 图片全丢（含 emf/wmf）；等宽 ASCII 图被压空格打乱；TOC 原样输出成噪音（约 1KB） |
| pptx | 好（333–386ms） | 图形内容只剩散落文字；纯图页输出空 slide；表格、链接保留 |
| xlsx | 可用 | **大 sheet 超 2000 行静默截断**：输出 `… 1876 more rows` 普通文本，无 cursor 可续；多块布局的 sheet 糊成 60+ 列大表；表头识别偶发错位（生成 `Column1…`）；17 张图表全丢 |
| pdf（有文字层） | 未测（按上游基准数据：布局还原、双栏阅读序、表格均优） | 默认按可信处理 |
| pdf（无文字层） | 文本抽取拿不到，anymd 正确判定并提示 OCR | 每页重复一句「扫描件 + 请跑 `anymd setup ocr`」的提示（13 页 ≈ 4KB 噪音） |

关键测量：

- 冷启动（`anymd version`）平均 190ms；转换 330–1100ms（12MB xlsx 也只要 1.1s，
  峰值内存 217MB）→ **每次调用起一次进程，不做常驻服务**。
- `--max-tokens` 下限 500；cursor 格式为 `"<sheet|page>:<offset>"`。
- 截图 PDF 整页渲染（Windows.Data.Pdf，1600px 宽）：每页约 90ms，PNG 194–922KB，
  视觉模型读取清晰（中英混排、表格、代码块均可读）→ **无文字层页走视觉通道可行**。
- 从 PDF 提取嵌入图片（PoC 中验证过 15/15 页）只适用于「整页就是一张 JPEG」的
  病态文件，**不采用**；整页渲染不依赖 PDF 内部结构，是正式路线。

## 4. 工具设计

### 4.1 形态

`internal/tools/builtin/document.go`，注册在 `CreateRegistry` 中 `read_image`
旁边（同一个「返回内容而非纯文本」家族，但独立注册，注释说明理由）。

- 名称：`read_document`
- 风险：`RiskLow`，`ParallelSafe: true`（只读、工作区内、带大小上限）
- 注册门控：`RgBinary()` 同款模式 —— `AnymdBinary()` 找不到 vendored 二进制时
  不注册，进 `result.Missing`，面板说明原因。

### 4.2 参数

```
path    string  必填，工作区相对或绝对路径（过 SafePath）
pages   string  可选，页码/幻灯片/章节范围，如 "1-5,8"（xlsx 为 sheet 序号）
node    string  可选，outline 返回的节点 id（docx 无页，靠章节读）
cursor  string  可选，上次返回的续读游标
```

没有 `max_tokens` 参数：**工具自己默认 8000**，模型不可调。PoC 证明无预算时
xlsx 能一次吐出 4300 万字符，这个闸门不能交给模型。

### 4.3 调用协议（包装层逻辑）

1. `SafePath` → `stat` → 大小上限（建议 50MB，超限给一句话）。
2. 嗅探文件头定类型（zip 再看 `word/`/`ppt/`/`xl/` 目录，`%PDF` 认 PDF），
   扩展名只作提示。不支持的类型（.doc/.ppt/rtf/音频/视频）返回明确句子，
   .doc/.ppt 提示用户另存为新格式。
3. 无 `pages`/`node`/`cursor` 的**首次读取**：跑 `anymd outline -- <file>`，
   返回目录 + 规模信息（页数/幻灯片数/sheet 数、最大节段），提示模型带参数再读。
   小文档（outline 字节范围 < 约 8000 token 当量）则直接全文返回，省一次往返。
4. 带参数：`anymd --no-ocr --images none [--pages|--node|--cursor] -- <file>`，
   输出过包装层改写（§4.5）后返回，末尾保留 anymd 的 cursor 提示。
5. 每次调用都是新进程；`exec.Command` 参数数组（不经过 shell），超时
   （建议 120s），结束时清理整棵进程树（Windows 上必须 `taskkill /T` 等价物，
   见 mem: proc.kill 只杀一层）。
6. 环境变量：`ANYMD_NO_STAR_HINT=1`（它第 5 次交互运行往 stderr 打求 star 提示）；
   不设 `ANYMD_CACHE_DIR` 默认值，但 `--images none` 下无写盘副作用。

### 4.4 返回

- 文本：改写后的 Markdown，头部一行说明「来源、格式、总规模、本次范围」。
- 图片（第二期）：无文字层 PDF 页渲染成 PNG 放入 `tools.Result.Images`，
  走 `read_image` 同一条 `Images` 通道；每次最多 3 页，超限提示带 `pages` 分批。
  仅当 `model.Vision` 为真时注册此行为（见 `vision-input.md` 第八阶段）；
  不支持视觉的模型收到「第 N–M 页是扫描件，本模型无法读取」的句子。

### 4.5 包装层改写（必须做，全部由 PoC 实证驱动）

| 上游输出 | 改写 |
| --- | --- |
| 每页重复的「scanned image, no text layer; run `anymd setup ocr`…」 | 合并为一句「第 N–M 页无文字层」，**不转述**安装 OCR 的建议（模型不该替用户装 2GB 模型） |
| `… 1876 more rows` | 改为「本 sheet 共 3877 行，已返回前 2000 行，剩余行 anymd 不支持续读；如需精确数据请用 shell+pandas 或让用户筛选」 |
| docx TOC 段落（编号加粗的目录行） | 删除 |
| 空 slide（纯图页只剩 `<!-- slide N -->`） | 保留锚点 + 注「此页为纯图形内容」 |
| `<!-- max-tokens -->` 截断提示 | 原样保留（cursor 语义模型必须看见） |

### 4.6 `read_file` 的联动

`fs.go` 的 `utf8.Valid` 失败分支（整读 + outline 两处）改为：
「不是 UTF-8 文本。若是文档（docx/pptx/xlsx/pdf）请用 `read_document`；
其他二进制请让用户说明用途。」

## 5. 随包分发（对齐 ripgrep 模式）

- 位置：`tools/vendor/anymd/<triple>/anymd(.exe)`，triple 复用
  `internal/release` 的 target 定义（`windows_amd64` / `linux_amd64`）。
- 来源：npm 平台包 `@sylphx/anymd-win32-x64-msvc@8.5.7` /
  `@sylphx/anymd-linux-x64-gnu@8.5.7`，取 `package/anymd.exe`；
  记录 npm 公布的 tarball shasum + exe 的 SHA-256（win32 已验：
  `23660C8E…5036`，与包内 `identity.json` 一致）。
- 校验：
  - `internal/release/release_test.go` 仿 `TestTargetsHaveAVendoredRipgrep`
    加存在性 + 体积检查（防静默消失）；
  - `make release` 的运行时自验加一条：隔离环境下 `read_document` 对一个
    内置样例 docx 转换成功（对标 `grep.missing_binary` 那条）。
- 体积：每平台 +28MB（实测 `anymd.exe` 28,422,144 B）。
- 升级纪律：主版本迭代快（已 8.x），升级 = 换二进制 + 重跑本方案的验收样本
  + 全量 `make test`；版本 pin 写在本文件与 `internal/tools/builtin/document.go`
  各一处，不引入配置项。

## 6. 分期

### 第一期（核心，无新依赖、无许可证风险）

1. vendor 8.5.7 两个平台二进制 + 校验测试；
2. `read_document`：docx / pptx / xlsx 文本抽取，outline 首读、
   `pages`/`node`/`cursor` 分段、8000 token 默认预算、§4.5 全部改写、超时与进程清理；
3. `read_file` 的提示联动；
4. 工具描述写明定位：「看懂结构、读片段」；xlsx 大表分析引导走 shell+pandas；
5. `VERSION` 次版本 +1，`make test` 全量。

**验收样本**（PoC 已备于 `.poc-anymd/samples/`）：两份 pptx、一份 docx、
一份 12MB 多 sheet xlsx、一份截图 pdf（期望返回「无文字层」说明句）。

### 第二期（无文字层 PDF → 视觉通道，依赖 `vision-input.md` 落地）

1. anymd 判定扫描页后，整页渲染成图放入 `Result.Images`（每调用 ≤3 页）；
2. 渲染器选型（唯一待决点）：
   - Windows：`Windows.Data.Pdf`（系统自带，PoC 已验证，90ms/页）；
   - Linux（远程工作区）：pdfium（BSD-3）vs mutool（AGPL，**不可商用发布**）。
     倾向 pdfium，需评估 cgo 打包成本；定不下来则第二期 Linux 上不注册视觉
     行为，只回「无法读取」句子，与 grep 缺二进制的降级方式一致；
3. PNG 压到 JPEG 或调低宽度控 token（PoC 单页 400–900KB 偏大）。

### 明确不做

- 不自动把文档当附件注入（`images.go` 那条路）：几百页的文档自动进上下文
  太贵，路径提示 + 模型主动调用即可；
- 不装 OCR / 不下 2GB 模型；扫描件 = 视觉通道（第二期，仅 Windows）或明确告知读不了；
- 老格式 .doc / .ppt 不支持，提示另存；
- 音频/视频不碰。

## 7. 风险与未验证项

| 项 | 状态 | 处置 |
| --- | --- | --- |
| 有文字层 PDF 的抽取质量 | 未实测（用户确认按默认可信） | 第一期验收补一份真实文字层 PDF 抽查 |
| `linux-x64-gnu` 的 glibc 基线 | 未验证 | vendor 时在一台老 glibc 机器上跑 `anymd version` |
| 上游 8.x 的 cursor / 截断行为变动 | 中 | pin 版本 + 升级走验收样本 |
| 28MB×2 的安装包体积 | 可接受但需向用户交代 | release notes 说明 |
| 供应商风险（单仓库、迭代快） | 低 | 二进制是黑盒依赖但 MIT；抽取失败有 shell 回退路 |

## 8. 与现有架构的边界（不变量）

- 路径检查只走 `Workspace.SafePath`，第二道门不设（`images.go` 的同款原则）；
- 工具不 mint artifact id，图片字节交 agent 层处理（`image.go` 同款原则）；
- 失败一律返回给模型看的句子，fail-closed，不猜；
- 界面文案走 `internal/i18n`，动态 key 用 `LookupOr`。
