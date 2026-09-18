# 修复日志（parity fix log）

对照 `docs/parity-review.md` 的问题清单，逐条记录已修项、对应测试、以及原版出处。
每一项都遵循同一条规矩：**修的同时把原版那条测试搬成 Go 测试**（见 `docs/parity-test-map.md`）。

## 3.10.2 —— 审批面板的底色是"三块拼的"（用户实测发现）

- **现象**（用户反馈"底色看着有点奇怪"）：把这个面板的每一行按 SGR 背景量出来是

  | 主题 | 卡片底 | 表头那一行 | 参数块那一行 | 其余 10 行 |
  |---|---|---|---|---|
  | `A` | `#292724` | `#292724` | `#0C0C0A` | `#292724` |
  | `A-T2`（默认） | **`ansi_default`（不涂）** | `#292724` | `#0C0C0A` | **`ansi_default`** |

  `A-T2` 那一行就是问题：**同一个矩形里有三种表面** —— 透明（露出终端底板）、
  一行更亮的 `elevated`、一行更暗的 `sunk`。用户看到的就是那个"中间一条暗带、两边亮"
  的观感。
- **根因**：派生角色（`elevated` / `sunk`）**从原版调色板的 `bg` 算出来，所以它们永远是实色**，
  而 `A-T2` 的 `chrome` / `surface` 是"不涂"哨兵 —— 卡片自己的底因此透明了。
  更麻烦的是那两个亮/暗带**失去了意义**：它们没有"比什么更亮/更暗"可言。
- **改动**：新增 `panels.go` 的 `panelBackground()` —— **弹层永远返回实色**
  （`elevated` 是实色就用它，否则用"这套主题透在谁前面"那个原版 `bg`，
  和 `darkColor()` 对 accent 上文字用的是同一条规矩）。
  审批卡与提问卡都改用它，并且**每一行在交给 lipgloss 之前先按卡片底色铺满**
  （背景只覆盖存在的单元格，所以行长不够时右侧会漏出下面的颜色）。
- **取舍写清楚**：深透明那套的"透"只覆盖**横栏与开场三个框**（它们本身就是一块板、
  上面没有别的东西）；**弹层保留实色卡片** —— 一个内部还有层次的矩形不能透明，
  否则那层次没有意义。这是该变体的第二条例外，第一条是它本来就不透的那些派生角色。
- **测试**：`internal/frontends/tui/panel_surface_test.go`（新文件，量的是**转义序列**而不是截图）：
  `TestTheApprovalPanelIsPaintedOnOneSurface`（同一底色至少 8 行、除风险芯片外不得出现第三种表面）、
  `TestThePermissionCardIsNotTransparent`（`panelBackground()` 不许是哨兵）、
  `TestTheArgumentBlockIsWiderThanItsText`（参数块要铺满卡片内宽）。
  已核对：改动前这条测试失败，改动后通过。
- **用户可直接复测**：`make build` 后 `dist\tudouni.exe --tui`，让它跑一条命令触发审批。

## 3.10.1 —— TUI 的审批跑到终端上了（用户实测发现）

- **现象**（用户截图）：TUI 里模型调 `write_file` 时，审批**没有**弹面板，而是以
  `[审批] 工具 write_file  风险 medium` / `[审批] 是否执行？[y/N/t]` 的形式打在了终端上，
  打在被备用屏覆盖的底层终端里；而界面自己的状态栏还写着 `running · step 1`。
- **根因**：`Server.Channels()` —— 那个负责把审批/提问发成协议消息的东西 —— **全仓库没有任何
  调用者**。`protocol.Main` 传给 opener 的 `RuntimeHooks` 只有 `ShouldStop` / `OnDelta` /
  `OnEvent` 三项，于是 `openRuntime` 无从知道"我的前端是管道另一头"，一律走
  `cli.Channels(opts.autopilot)` —— 即在**它自己所在的那个终端**上打印提示并读 stdin。
  而那个 stdin 是前端持有的管道：**没人能回答它**，所以那一轮永远走不完。
  `cmd/tudouni/main.go` 那行注释原本就写着"在 `--runtime-stdio` 模式下协议服务器会替换它们"
  —— 注释说的是设计意图，代码没有实现它。
- **改动**：
  - `RuntimeHooks` 新增 `Channels`，注释写明"没有它，opener 无从知道前端是谁，会退回它碰巧
    所在的终端"；
  - `protocol/serve.go` 的 opener 传入 `server.Channels()`；
  - `cmd/tudouni/main.go` 的 `openRuntime` 改为**优先用 hooks 给的 channels**，只在没有时
    才退回 `cli.Channels`。回退仍然保留，因为行式 REPL 与测试确实是在进程内问人。
- **测试**：`internal/protocol/channels_test.go`（新文件）：
  `TestTheServersChannelsAskOverTheProtocol` 与 `TestTheServersChannelsAskQuestionsOverTheProtocol`
  —— 在内存管道上起一个 server，用它的 channels 发一次审批/一次提问，断言
  **线上真的出现 `permission_request` / `question_request`**，回一个答案之后 asker 返回。
  这正是"这条路的证据在线上，而不在终端上"。
- **验证**：`go vet` 干净；全量测试通过；构建出的二进制跑 `--tui` 时 **stderr 为 0 字节**
  （修复前那一层会打印审批提示）。
- **用户可直接复测**：`make build` 后 `dist\tudouni.exe --tui`，让它写一个文件，
  应当弹出面板而不是终端提示。

## 3.10.0 —— 把配置模板放进发布产物

上一轮（3.8.0）修 B11 时走的是"把模板编进二进制"这条路，并保留磁盘优先作为兜底。
把发布流程再跑一遍之后发现那条路**只走了一半**：

- 归档里仍然没有 `config.example.json`。`README.md` 的「四类随代码走」表里**写着它**，
  而 Python 原版的 `REQUIRED` 也**点名要求产物里带它**（PyInstaller 要把
  `agent_runtime/config.example.json` copy 进 `_internal/`）。编进二进制让程序**能工作**，
  但没有让用户**拿到那份模板** —— 而"打开它填上你的密钥"这句话的意思就是去开一个文件。
- **改动**：`release.Layout` 新增 `ExampleConfig`，`RequiredFiles()` 把它列进去
  （`CheckArchive` 因此会检查归档里有没有它），`tools/release` 的 `stageTarget` 从仓库根
  copy 一份到产物根。`ExampleBytes()` 的磁盘优先逻辑保持不变 —— 它现在是"用户会打开的那一份"
  与"程序永远有得用"之间的连接点。
- **验证**：归档内容现在是 8 项，`config.example.json` 在其中；`internal/release` 的两条测试
  相应更新（缺件清单 6 → 7 项、归档必须包含它）。
- 顺带把 `README.md` 那段说明改准（原文写"`config.example.json` 编译进二进制"，没说它同时也
  随包落盘）。

## 3.9.0 —— protocol 与 skills/AGENT.md/state 两节审计

### protocol：契约一致，但缺一条守它的测试（已补）

两个 schema 文件与 Python 原版**逐字节相同**（这一点在审计一开始就核对过），所以"线上形状"的
权威是这个文件。逐条对照的结果：

- **入站 18 种 `t` 全部有处理**（`user_message` / `interrupt` / `shutdown` / `permission_response` /
  `question_response` / `session_switch` / `session_list` / `set_autopilot` / `set_model` /
  `set_thinking` / `set_effort` / `status` / `tools` / `context` / `compact` / `mcp` /
  `refresh_state` / `skills`），与原版 `channels.py` 的分支一一对应；
- **出站 10 种消息类型**（`init` / `session_load` / `event` / `ui` / `sessions` / `notice` /
  `delta` / `delta_reset` / `permission_request` / `question_request`）全部由 `internal/protocol`
  发出；
- 信封行为一致：`v` 不认就硬失败、未知 `t` 忽略并继续、一行一个 JSON、逐行 flush；
- `init` 的 14 个 required 键全部由 `InitFields()` 提供（`protocol` 由 server 自己补）；
- `permission_request` / `question_request` 的 required 键与可空字段（`remember` /
  `remember_hint` / `trust_all_hint`，schema 里标了 `nullable`）都对得上。

**但缺的是一条守住它的测试**，而这正是"两个 schema 与原版逐字节相同"带来的具体风险：
这个程序自己既是发送方也是接收方，**少发一个键两边都不会有任何反应** —— 而那个键是原版发过的，
所以发现它的会是将来写第三个前端的人。已补
`internal/protocol/schema_conformance_test.go`（新文件，读**磁盘上的 schema 文件**逐字段核对）：

- `TestEverySchemaMessageTypeHasAGoSender` —— schema 声明的每种消息都必须有发送方（双向核对：
  也不能发出 schema 没声明的类型）；
- `TestTheOpeningMessageSatisfiesItsSchema` —— `init` 是"合并运行时字段进一个两键 map"拼出来的，
  漏键正好藏在这个过程中；用真实字段核对 required 与类型；
- `TestTheBlockingRequestsSatisfyTheirSchemas` —— 审批与提问是前端**必须回应**的两条，漏键或类型
  不对等于前端无法回话，而运行时会在那里一直阻塞；
- `TestTheOtherMessagesSatisfyTheirSchemas` —— 其余七种一次过；
- `TestTheSchemaAgreesWithTheEnvelopeConstants` —— schema 里每种消息 `v` 的 `const` 必须等于
  `VERSION`（这是唯一一处两端都会硬失败的地方）。

### skills / AGENT.md / state：逐项一致，无需改动

- **六类技能目录与优先级**完全一致：低优先级在前，个人级压项目级，同层内 `.tudouni/skills` 压
  `.agents/skills` 压通用 `.skills`（Go `defaultRoots` = 先 workspace 组后 home 组，组内按
  通用 → `.agents` → `.tudouni`；Python `default_roots` 同构）。
- **常量全部对齐**：`MaxSkillBytes` 64000、`MaxActiveSkills` 3、`MaxNoteChars` 40000；
  AGENT.md 的 400 行 / 16384 字符 / 1 MiB 字节三道闸也一致。
- **三级渐进披露**在两侧形状相同：清单（名字 + description）→ 已加载技能的正文 →
  模型自己 `read_file`。`CatalogPart` 会把**已加载的**从清单里剔除（同一份载荷里说两遍会让模型
  以为它们是两个东西），与 Python 一致。
- **载荷尾部的四段顺序**已在 B4 那轮修正（技能清单 → 已加载技能 → 任务 → 后台任务）。
- **技能运行时读不到时**不是静默消失也不是编一个：`SkillNote` 打出"现在读不到了"并给出下一步，
  与 Python `_render_body(stale=True)` 同义。
- **`--skills` 的存在标记**上一轮已修（`Catalog.Root` 的注释说"实际扫过的"，赋值给的却是全部候选）。
- **坏文件一律降级且出声**：`loader.Problems` 每条带 code + 参数，由消费方渲染；`--skills` 与 TUI
  都打印。
- **state**：会话 JSONL 追加式、审计追加式、目录布局、`AGENT.md` 的 `agent_md` 会话键与
  `## 项目说明（AGENT.md）` 段落注入 —— 逐项一致。

### 顺带清理

`dist/` 下 3.0.1 时代的四个旧产物（暂存目录 + zip）已删除，只留 3.7.0 那一份。

## 3.8.0 —— packaging 一节审计（实跑发布流程）

### 先跑通，再读代码

这一节没有只读代码，而是把**真实发布流程跑了一遍**：

```
go run ./tools/release --target windows/amd64
  tudouni 3.7.0
    building x86_64-pc-windows-msvc ...
        · x86_64-pc-windows-msvc: --help, --version and --runtime-stdio all ran; ripgrep registered
        · tudouni-3.7.0-x86_64-pc-windows-msvc.zip (8.1 MB)
```

发布流程本身是健康的：它会**打开刚写出的压缩包看里面有什么、真的运行二进制**（`--help`、
`--version`、用隔离配置起一次 `--runtime-stdio`），并确认随包的 ripgrep 被认出来了 —— 这与
README 和原版 `scripts/build_release.py` 的承诺一致。产物内容（7 项）也与原版设计的
「四类随代码走」对得上，只是分工不同：`prompts/` 与 `tools/vendor/rg/` 必须在磁盘上，
`config.example.json` 与 `protocol/schema/` 编译进二进制。

### B11 安装包里没有 `config.example.json`，于是首次运行的引导句指向一个不存在的文件（已修）

- **现象**：`Release` 归档里没有 `config.example.json`（它是编译进二进制的），而
  `config.Scaffold()` 走的是 `os.ReadFile(paths.ExampleConfigPath())` ——
  在**安装出来的副本**上，`PackageDir()` 解析到二进制旁边那个目录（因为 `prompts/` 在那儿），
  于是那个路径下的 `config.example.json` 根本不存在。后果是：一个没有密钥的新用户看到的
  唯一一句可操作的话——"我在这儿给你建好了一份配置，打开它填上你的模型和密钥"——**不会出现**，
  因为 Scaffold 静默返回空串。这恰好发生在它被写出来要服务的那种场景里。
- **改动**：新增 `internal/config/example.go`：模板用 `//go:embed` 编进二进制
  （`internal/config/config.example.json`，与仓库根那份**字节相同**，由测试盯着不许漂），
  `Scaffold()` 改用嵌入的字节；`ExampleFile()` 改成"磁盘上有就报磁盘上那个，没有就报默认配置位置"
  —— 把人指向一个不存在的文件比指向他正要创建的那个更坏。
- **原版对照**：Python 版的 `REQUIRED` 明确要求产物里带
  `agent_runtime/config.example.json`（PyInstaller 要把它 copy 进 `_internal/`）；Go 版编译进二进制，
  这条路本身没问题，漏掉的是**读取端**没有跟着改。
- **测试**：`internal/config/example_test.go`（新文件）：
  `TestTheEmbeddedTemplateMatchesTheRepositoryCopy`（两份拷贝不许漂）、
  `TestTheTemplateIsAlwaysAvailable`（磁盘上什么都没有时仍有模板可用，且报出的路径是存在的那个）、
  `TestAScaffoldedFileMatchesTheTemplate`（落盘内容 = 模板；重复调用不覆盖已有配置）。
- **真二进制验证**：把 `dist/tudouni.exe` 在一个干净目录里跑，`USERPROFILE` 指向临时家目录 ——
  它建出了 `.tudouni/config.json`，并打印了那句引导（含真实路径）。

### 顺带记录：`dist/` 里的旧产物

`dist/` 下还留着 3.0.1 时代的暂存目录与 zip（未清理的旧构建）。`tools/release --local` 只写
`dist/tudouni.exe`，`--target <t>` 才写归档；`make clean` 会清掉整个 `dist/`。

## 3.7.0 —— TUI 剩余的 MINOR

- **`Ctrl+B` 在覆盖层打开时失效**（m2）：原版绑在 **App 一层**，所以任何面板在上面时它照样生效。
  抽成 `toggleRail()`，在调色板与其余覆盖层两条键盘路径里都接上。要求先按 Esc 才管用的键，
  看起来就是坏的。
- **调色板行数上限写死 18**（m3）：改成 `maxOverlayRows() = len(commands()) + 3`，从命令数**算出来**。
  写死的字面量在这里坏的方式是固定的：清单长过它之后，多出来的命令**存在、能跑、但不在屏幕上**
  —— 而调色板的全部职责就是"这里有你所有能敲的命令"。
- **`/help` 丢了两样东西**（m5）：命令的 `detail` 改成**独占一行并缩进**（并排会让那一行超出面板内宽，
  边框重排之后就变成一个条目占三行、高亮糊下来），以及补回 `↑ ↓` 那一行提示。
- **调色板无匹配时 Enter 什么都不做**（m13）：现在把输入行原样走一遍命令分发，于是会
  打出"认不出这条命令"并列出全部 —— 吞掉按键会让那一行停在那里、毫无反馈。
- **`/new` 与 `/resume` 各打两行**（m7）：去掉本地那两行，只留 `init` 回来的那一行。
  它既是身份说明，也是"切换真的发生了"的确认；本地那行只是"我请求过"。
- **思考正文不做换行压平**（m11）：`thinkingBody` 现在**先压平再折行**。原来的测试
  `TestThinkingBodyQuotesEveryLine` 断言"每一源行占一行"—— 那条断言本身就是这个 bug 写下来的样子：
  reasoning 通道是一词一行发的，一段 400 字的思考于是画成 100 行引文，把答案顶出屏幕。
  测试改成 `TestThinkingBodyFlattensBeforeWrapping` + `TestThinkingBodyStillWrapsALongParagraph`。
- **缺 `duration_ms` 时显示 `0ms`**（m16）：改成 `—`。没测过的时长不是"零时长"，
  而工具行上的 `0ms` 读起来像"这次是瞬时的"—— 那是界面给不出的结论。
- **`Ctrl+K` 在空输入行时不插入 `/`**（m9）：插上，并把光标放到 `/` 之后。
- **死代码 `renderStatus`**（m12）：删掉。它和真正在用的 `statusScreen` 是同一块内容的两个版本，
  差别只在字符串，留着就是"下一次有人顺手调到它"。

### 已经不用改的两条

- **m14 `/resume` 行的任务后缀**：上一轮已修（`todos` 是预渲染字符串，不是数字）。
- **m19 会话行的版式**：Go 侧的 `fmt.Sprintf` 版式与原版模板一致，属于实现差异而非行为差异，
  不再单独处理。

## 3.6.0 —— TUI 的 10 条 MAJOR

### M1 答案不再属于它自己的回合（已修）

- **改动**：`turnData` 新增 `answer`；`ui(run_finished)` 到达时按 **`run_id`** 找回合
  （`attachAnswer` / `turnFor`），渲染时画在**回合块内部**（`renderTurn` → `renderAnswerBlock`）。
  找不到 run_id 时退回当前打开的回合，再退回独立条目 —— 丢掉答案比丢掉它的位置更坏。
- **原版出处**：`view_state.py:1536-1549`（`answer_body` 的 docstring 明说"它和 `event` 那条
  `run_finished` 是两条消息，**顺序不保证**，所以不许靠到达顺序配对"）、`widgets.py:662-672`；
  协议侧 `protocol/schema/outbound.schema.json:139`。
- **测试**：`internal/frontends/tui/parity_test.go`（新文件）里四条。

### M2 左栏自动顶开被 `railPinned` 挡住（已修）

- **改动**：`beginTurn` 里去掉 `!m.railPinned` 判断。
- **理由（原版决策 26 原文）**：手动操作仍然被尊重（收起之后不会因为别的状态更新自己弹开），
  但**任务列表出现是一个新的、明确的事件** —— 用户当初收起它时，前提是"那时候没有任务"。
  加一个 `railPinned` 判断会**静默地**把这条功能从所有按过 Ctrl+B 的人身上拿掉。
- **测试**：`TestTheRailAutoOpensOnTheFirstTaskList`（先 pin 再收起，仍然顶开）、
  `TestTheRailDoesNotReopenOnAContentUpdate`、`TestAnEmptyListReArmsTheEdge`。

### M3 `/thinking` 接受 11 种写法（已修）

- **改动**：TUI 只认字面的 `on` / `off`（`strings.ToLower` 后比较），不再调用
  `state.ResolveThinking`。那个函数是**运行时的**词汇表（它还认 `开` / `true` / `enabled` / …），
  用在界面上会让 TUI 接受十一种拼法而只发两种。
- **原版出处**：`app.py:1662-1683`（docstring：「带参数时**只认字面的 `on` / `off`**…界面只发
  协议认的两个字面量」）；测试 `test_tui_commands.py:704-712`。

### M4 `/quiet` 区分大小写（已修）

- **改动**：`strings.ToLower(arguments[0])`。`/quiet OFF` 和 `/quiet Off` 对人来说是同一件事，
  一条命令在一种拼法下生效、另一种下报错，读起来就是界面的 bug。
- **原版出处**：`app.py:1929-1934`。

### M5 `/mcp <写错>` 不再打开面板（已修）

- **改动**：写错动作、以及只写了一个词（最常见的是 `load` 忘了带名字）时，先说清认不出什么，
  然后**照样打开面板**并拉一次清单。
- **原版出处**：`app.py:1977-1982`（「认不出来就说认不出来，然后**打开面板** —— 那是
  '下一步该干什么'最省事的回答」）。

### M7 `/model` 与 `/effort` 的文本回退缩成一行（已修）

- **改动**：新增 `appendModelList`（当前模型 + `model.no_catalog` + howto）与
  `appendEffortList`（当前强度 + 关思考时的说明 + `effort.no_catalog` / `effort.howto`）；
  `/thinking` 不带参数时补齐三行（状态 / 强度 + "关着时记着但不用" / howto）。
- **原版出处**：`view_state.py:2853-2897`（`render_models`）、`:2900-2945`
  （`render_thinking` / `render_effort`）。

### M6 `/model` 选择器丢了 label / summary / 窗口 / 别名（已修）

- **改动**：行文本补上 `summary`，note 补上 `label` 与窗口；新增 `modelAliases` 字段，
  `init` 的 `model_catalog` 现在同时接受 `{models, aliases}` 与裸列表两种形状；
  旧名字作为**不可选**的行列在主清单之后（它们是认下的名字，不是选项）。
- **原版出处**：`view_state.py:2798-2841`（`model_option`）、`:2853-2897`（别名行）；
  测试 `test_tui_commands.py:235-278`。

### M8 启动窗口没有转圈（已修）

- **改动**：`spinnerNeeded()` 新增"`booting` 时也要"，`Init()` 直接起帧链
  （原来只有收到服务端消息才起，于是**唯一需要动效的那段时间恰好没有动效**）。
- **原版出处**：`app.py:309-310`；测试 `test_tui_boot.py:85-101`（「那 1.9 秒里屏幕上如果没有
  东西在动，这块画布看起来就是卡死的」）。
- **测试**：`TestTheSpinnerRunsWhileBooting`。

### M9 等人在审批/提问时转圈还在转（已修）

- **改动**：`spinnerNeeded()` 在 `pendingPermission` / `pendingQuestion` 非空时返回 false。
- **理由**：那一刻 agent 是**停住的**，屏幕上只有那个模态框该动；旁边的转圈在说"还在干活"，
  而它其实在等你 —— 这是唯一一个动画标记会主动误导人的时刻。
- **原版出处**：`app.py:1014,880-888`；测试 `test_tui_quiet.py:382-415`。
- **测试**：`TestTheSpinnerStopsWhileAPersonIsBeingAsked`。

### M10 收起左栏后的摘要不说 autopilot（已修）

- **改动**：`renderRailSummary` 补上 `rail.summary.autopilot` 段。
- **理由**：那行摘要的定义就是"把收起藏起来的东西说出来"，而它藏起来的其中一件事是
  "下一次危险调用会不会问你"。不说，等于对这一问静默地答"会"。
- **测试**：`TestTheFoldedRailSummarySaysWhetherItWillAsk`。

### 顺带修掉的三条 MINOR

- **`/resume` 行的任务后缀永远不显示**（`tui-parity` m14）：运行时发的 `todos` 是
  **已经渲染好的进度字符串**，TUI 却用 `intOf` 当数字读，于是每个会话都读到 0，
  分支永远不进 —— 而"哪个会话还剩着活"正是这个字段存在的理由。
- **`1.0M` 应为 `1M`**（m1）：`state.TokensText` 对整百万去掉小数点。
  `1.5M` 保留，那一位是有信息的。
- **`init.provider` 从不读取**（m18）：`modelAliases` 与 `model_catalog` 两种形状一起处理，
  顺带把选择器的路由信息补齐（见 M6）。

## 3.5.0

### M1 串行批次改成"整批先审批再执行"（已修）

- **改动**：`runBatch` 把原来的 `prepare` 拆成 `inspect`（查工具、解析并校验参数形状、报
  `tool_call`）与 `approve`（权限裁决 + schema 校验），然后**两条路分开走**：
  - **并行**：整批先 `approve`，全部问完才开始跑 —— 这是并发批次真正需要那个顺序的理由：
    对人问第三条时前两条不能已经在写文件，否则他批准的东西前提已经在动了；
  - **串行**：`approve → runOne → 报结果` 逐条相邻。被问第 n+1 条的人必须先看到第 n 条的结果，
    那个结果正是他判断的依据；审计事件也因此恢复成原版的交错形状
    （call、permission、result、call、permission、result）。
- **原版出处**：`agents/agent.py:1852-1867`（`_run_serial`）、`README.md:1635-1637`（规则第 3 条）。

### M2 流式中途不能取消（已修）

- **改动**：
  - `model.CompleteOptions` 新增 `ShouldStop func() bool`，并在 SSE 读取循环里**每个 chunk**
    检查一次（`parseStreamWithStop`）—— 这是不打断底层读的前提下能做到的最细粒度，chunk 每秒来很多次，
    所以按下停止后的等待被限制在一个包而不是"剩下的整段答案"。
  - 新增 `model.CancelledError` / `model.IsCancelled`：**"用户改主意了"不能被重试**，
    不能记成模型失败，也不能在审计里变成一条 error。
  - `RetryHooks` 新增 `ShouldStop`，在**每次尝试之前**也查一次 —— 在退避期间按下停止的人，
    否则要等完那段延迟然后看着请求再发一次。
  - `agent.completeWithRetry` 把 `a.ShouldStop` 同时交给适配器与重试钩子。
- **原版出处**：`agents/agent.py:361-373,421-423`（`_DeltaRelay` 里查取消）、
  `README.md:1646-1649`、`tests/test_streaming.py:588-623`。
- **测试**：`internal/agent/retry_test.go`（新文件）：
  `TestAStopBetweenAttemptsAbandonsTheCall`（退避期间按下停止 → 只调了一次模型、只记了一次尝试）、
  `TestACancelledStreamIsNotRetried`（取消不算失败、不重试、不进审计）、
  `TestAStopBeforeTheFirstAttempt`。

### M3 撞步数上限时 `Tools` 装的是整轮工具名（已修）

- **改动**：`a.toolsUsed` 的清零从**每轮一次**改成**每步一次**（循环里、`runBatch` 之前）。
  这个列表唯一的去处是 `StepLimitExceeded` 的文案，而那条文案只有一个职责：说清"这一轮卡在哪几个
  工具上"。攒满 120 步之后它是一百个名字和零条信息。
- **原版出处**：`agents/agent.py:1702,1727`（每步重新赋值）；测试 `tests/test_step_limit.py:39`
  断言 `exc.value.tools == ["list_files"]`。
- **测试**：`TestStepLimitNamesOnlyTheLastStepTools`（三步脚本、上限设 3、
  断言 `Tools == [read_file]`）。

### M5 MCP 的信任组（`a` 键）是死代码（已修）

- **改动**：新增 `Runtime.McpTrustGroup(toolName)`，遍历当前**挂载中**的 server，
  返回 `security.TrustGroup{Label: server 名, Tools: 该 server 此刻注册成功的工具名快照}`；
  装配处把它交给 `AskerFactory`（原来是恒传 `nil`，于是 `a` 键在整条链路上不可达）。
- **两处刻意的语义**（都有测试）：
  - 读的是**此刻在跑的挂载**，所以刚卸载的 server 不再提供"这一组"
    —— 否则提示会写"以后 MCP server github 的 12 个工具都直接执行"，而其中三个已经不存在了；
  - 放出的是**名字快照**，不是"这个 server 以后的一切"。server 明天新增一个
    `delete_everything` 时必须继续问 —— 一个会自己变宽的放行正是"信任整个 server"不能有的意思。
- **原版出处**：`runtime/composition.py:631-641,2103-2129`、`tools/mcp.py:1103-1112`、
  `README.md`「审批里的 t 和 a」。
- **测试**：`internal/runtime/mcp_trust_test.go`（新文件）：
  `TestMcpTrustGroupReleasesTheMountsSnapshot`、
  `TestTheTrustGroupIsASnapshotNotAStandingPermission`（放行之后新增的工具不被纳入旧快照、
  但重新查一次能看到它）、`TestAnUnloadedServerOffersNoGroup`，
  外加一条编译期断言 `var _ security.TrustGroupLookup = (&Runtime{}).McpTrustGroup`。

## 3.4.0

### M11 CLI 各子命令/命令的输出内容缩水（已修）

- **`--list`**（`cmd/tudouni/main.go` 的 `listSessions`）：补上表头
  （`Saved sessions: N (目录):`）与**任务列**（`；tasks 2/5 done, current: …`）。
  任务列表存在会话文件里，所以"哪个会话还剩着活"是读一个文件就有的事实 —— 这正是选会话时
  真正想知道的事之一。列宽从内容量出来，不写死：写死的宽度会在有人用更长的会话名那天
  静默错位。文件读不动的会话仍然留在清单上（只列名字），丢掉它等于把一个真问题藏起来。
- **`--skills`**（`showSkills`）：改成原版的三行式 ——
  目录区带 `✓`（存在）/ 空格的**存在标记**；每个技能
  `名字  body N chars  declared tools: …` + 描述行 + 来源路径行；
  跳过的技能走 `[skipped] …` 并**留在 stdout**（原来走 stderr：一条清单被拆到两个流上，
  一旦重定向就没法看了）。正文长度值得显示是因为它直接决定此后每一轮请求的成本。
- **`--history`**（新增 `printHistory`）：补上表头与 72 短横线、`{序号} {角色} {预览}`
  三列、assistant 的 `→ call name(args)` 行、76 字预览截断，以及**artifact 注释行** ——
  工具结果的正文现在只剩一句引用（`[artifact art_xxx · 12480 字符 · read_file]`），
  不说明它指向什么，`--history` 就只剩一串没人看得懂的行。那一行读**盘上的索引**，
  不读正文（那正是这个重构的目的）。索引读不动时降级成一句话而不是整个失败。
- **`/tools`**（`internal/frontends/report.go`）：补上 `Available tools` 表头、
  从行宽量出来的名字列，以及**标记列** `· you pressed t、external、asks you、parallel-safe`
  —— 它们说的是风险与处置两列说不出来的事，而且 `interactive` 与 `parallel_safe`
  按构造互斥，所以共用一个位置。
- **`/model`**（`printModels`）：名字写成 `provider/model`（同名模型可以在两条路由上，
  只写模型名那两行长得一模一样，而"选了哪一个"决定请求发到哪个账号）；每行补上
  `summary`、`label`、`上下文 N`、以及 `note` 行；旧名字单列成
  `legacy names: X → Y`（它们是**认下的**名字，不是能选的选项）。

### 新发现：`--skills` 的 `✓` 标记恒为真（已修）

- **现象**：`Catalog.Roots` 的注释写的是"实际扫过的目录"，但 `Reload()` 一开始就把
  `l.Roots`（**候选**目录，六个全都在）赋给了它。于是"✓ = 存在"这个标记对六个目录全部成立，
  包括根本不存在的那些 —— 一个不报错、只是说反了话的缺陷。
- **改动**：`Catalog` 新增 `Existing`（真的读到了的目录，扫完翻转成与 `Roots` 同序）；
  `--skills` 与 `skills.SourceLines` 都改用它。
- **验证**：真二进制冒烟 —— 只有一个技能目录存在时，输出里正好只有它带 `✓`。

### 顺带修掉一个自己引入的错误

写 `--skills` 时我先用了 `{name:20}` / `{chars:>6}` 这种对齐占位符。**`i18n.T` 不认识它**，
会把占位符原样留在屏幕上（冒烟测试里就是
`{name:20} body {chars:>6} chars  declared tools: …`）。已改成在 Go 里量宽度、
用 `fmt.Sprintf` 对齐，并在 `en.go` 那条注释里写明了为什么这些 key 里不许出现宽度语法。

## 3.3.0

### M12 行式 CLI 每轮的用量 / 任务 / 后台提示（已修）

- **改动**：
  - `protocol.Runtime` 接口新增三个查询：`StatsLine()`（会话累计用量 + 本轮耗时 + 上下文用量）、
    `ProgressLine()`（任务列表的人读版）、`JobsProgressLine()`（后台任务的人读版）。
  - `internal/runtime/composition.go` 实现三者。`StatsLine` 的每个数字都从**审计日志**数出来 ——
    和 `--audit` 是同一份事实，两个地方各记一份计数早晚会不一致。本轮耗时**按 `run_id` 配对**
    而不是取最后一条 `run_finished`：一轮在收尾前挂掉时（Ctrl+C、被强杀），日志里最后那条
    `run_finished` 属于**上一轮**，把它当"本轮"报出来是一个完全无关、但看起来完全合理的数字。
  - `internal/tools/builtin/jobs.go` 新增 `JobBoard.ProgressLine()`（`2 running, 1 result not
    collected (1, 2)`），与给模型看的 `Note()` 分开 —— 同一个理由和任务列表一样：模型要
    "哪几条、什么命令、该收哪条"，人只要一眼看出"机器上还挂着东西吗"。
  - `internal/frontends/cli/cli.go` 每轮结束打这三行，**全部走 stderr**。
- **原版出处**：`frontends/cli/__init__.py:514-593`（三个 note）、`:596-626`（`_report_jobs` /
  `_report_todos`）、`:1110-1114`（每轮那句话）、`:314-336`（`last_turn_ms` 按 run_id 配对）；
  `tools/builtin/jobs.py:642-665`（`progress_line`）。

### M13 退出时不收摊（已修）

- **改动**：`cli.Run` 把 `Close()` 放进 `defer`（**每一条**出口都收，不只是 `/exit`），
  并装 `signal.Notify(os.Interrupt)` —— Ctrl+C 是行式终端里文档写着的退出方式，默认处置
  会直接杀掉进程，上面那个 defer 一次都跑不到。
- **原版出处**：`main.py:264-265`（`with runtime:` → `Runtime.close()`）、
  `runtime/composition.py:1714-1746`（先收后台任务，"一个没被收掉的 dev server 还占着端口"）；
  `frontends/cli/__init__.py:1059-1061`（EOF 只是 break，让 `with` 展开）。
- **后果对照**：MCP 子进程与后台命令会在会话结束后继续活着占端口，而"端口被占用"这句报错里
  没有任何线索指向"是上一次会话留下的"。

### M14 `--tui` 没有进备用屏之前的配置预检（已修）

- **改动**：新增 `runtime.PreflightCheck()`（读目录、`permissions.json`、`web`、`mcp.json`，
  返回第一条要用户处理的问题），`--tui` 分支在 `tui.Run` **之前**调用它并把错误打到 stderr、
  返回 2。
- **原版出处**：`main.py:139-147`、`runtime/composition.py:235-285`
  （docstring 写明备用屏没有回滚缓冲，子进程那句报错会变成一屏截断、滚不动的乱码）；
  测试 `tests/test_main_entry.py:209-227`（断言退出码 2 且 **stdout 为空**）。
- **验证**：用**真二进制**在配置为空的目录下跑 `--tui` —— 退出码 2、stdout 0 字节、
  stderr 是 `no usable model route`。

## 3.2.0

### B4 任务列表不进载荷尾部（已修）

- **改动**：
  - `internal/tools/builtin/todo.go` 新增 `TodoBoard.Note()`：渲染
    `## 当前任务（你自己维护的列表）` + 每项 `- [状态] 正文`，无列表时返回空串。
  - `internal/runtime/composition.go` 的 `notes()` 改成原版的**四段顺序**
    （技能清单 → 已加载技能 → 任务列表 → 后台任务），并把后台任务放回**最后**
    （原版理由：它是四段里唯一"不看就会出错"的一段，而载荷末尾离模型要生成的那个 token 最近）。
- **原版出处**：`tools/builtin/todo.py:110-128`、`runtime/composition.py:2296-2304`。

### 新发现：任务列表写进去之后读不回来（已修）

- **现象**：`todo_write` 把列表存成 `[]map[string]any`，而 `loadTodos` 只接受 `[]any`
  ——后者是**从会话文件 JSON 读回来**的形状。于是刚写完的列表在同一个进程里立刻读不到：
  载荷尾部、rail 的进度、`--list` 的"任务 x/y"、`/resume` 行全部拿不到数据。
  `todo_write` 的 ack 文案是另一条路（直接用手里的 `items`），所以**它照样报成功** ——
  这就是它一直没被发现的原因。
- **改动**：`loadTodos` 走新的 `todoEntriesOf`，两种形状都接受。
- **测试**：`internal/tools/builtin/todo_test.go`（新文件，`internal/tools/builtin` 此前
  只有 registry/webtools 两个测试文件）：
  `TestTheTaskListReachesThePayloadTail`、`TestAnEmptyListProducesNoBlock`、
  `TestTheNoteNeverTouchesTheSessionMessages`。

### B6 `--audit` 的汇总块（已修）

- **改动**：
  - 新增 `internal/audit/summary.go`：`Timing` / `SummarizeTime` / `Summarize`，
    以及 `msText`。计时口径逐条对齐原版：并行批次用 `tool_batch.wall_ms` 而不是逐条相加、
    等人回答的时间**从工具耗时里减出来**单列 `human_ms`（否则"我看 30 秒才回答"会被报成
    "这个工具花 30 秒"）、`unattributed_ms` 有下界 0、`explained` 把 human 加回去。
  - `internal/audit/view.go` 的 `FormatLine` 改成原版版式：
    `{时间} {kind:<13} step={n:<3} {正文截断到 100}`，**一条一行**、只取时间不取日期、
    缺字段打 `?`（原来打完整时间戳 + 缩进的第二行 + 不截断）。
  - `cmd/tudouni/main.go` 的 `--audit` 补上表头、78 短横线、`audit.Summarize(records)`。
- **原版出处**：`frontends/cli/__init__.py:459-509`（`print_audit` + `_print_audit_summary`）、
  `:195-294`（`summarize_time` + `_print_timing`）；测试 `tests/test_audit_view.py:96-108`、
  `tests/test_timing_report.py:37-95`、`tests/test_cli_usage.py:43-207`。
- **测试**：`internal/audit/summary_test.go`（新文件，`internal/audit` 此前**零测试**）：
  计时各项与恒等式、`unattributed` 非负、旧日志不出计时行、
  汇总必须含"花费/工具状态分布/耗时/结束原因"且**只报 token 不报钱**、
  一条记录一行且被截断、损坏记录照样打得出来。

### B8 启动通知只剩 4 条且只有 TUI 看得见（部分已修）

- **改动**：
  - 新增的 notice：`[context]` 模型不在目录里（或没配 `context_window`）、
    `[catalog]` 每条路由的问题、`[config]` 遗留 `.env`（数据之前就算好了放在
    `Registry.Notes` 里，只是没人读）、`[MCP]` 工作区里那份被忽略的 `mcp.json`、
    `[background]` 上一轮遗留的后台任务、`[background]` 收树保证没建起来。
  - `[search]` 的**两个分支拆开了**：支持但缺二进制 → 给出目标三元组；
    不支持的平台 → 说清是平台问题。原来只有前者且把 `triple` 传成了字符串 `"grep"`，
    渲染出"缺少 grep 的 ripgrep 构建"；不支持的平台上会让人去跑一个根本解决不了问题的脚本。
  - notice 现在带 `stream` 字段（`err` / `out`），行式 CLI 新增 `emitNotices` 按它分派 ——
    **注册工具清单走 stdout**（原版的契约），其余走 stderr。
  - 顺带把 `Registry.Problems` 也接上了（原来只在"一条路由都没有"的错误里打）。
- **原版出处**：`runtime/composition.py:1311-1550`、`main.py:69-85,283`；
  测试 `tests/test_banner.py:78-120`、`tests/test_providers.py:401-403`。
- **测试**：`internal/runtime/notice_test.go`（新文件）：
  `TestEveryNoticeNamesItsStream`、`TestTheRegisteredToolsTableIsStableAndComplete`。
- **真二进制冒烟**：起一次会话，确认 stderr 上有 `[web]` 与工具清单后的审计行、stdout 干净。

## 3.1.0

### B2 跨路由 \(\`/model\`\) 只改名字、不改端点与密钥（已修）

- **改动**：
  - `internal/model/types.go` 的 `ChatModel` 接口新增 `Install(apiKey, baseURL, model, provider) bool`，
    注释写明它与 `SwitchModel` 是两种不同代价的能力（一个只改请求字段，一个换凭据与端点）。
  - `internal/model/openai.go` 实现 `Install`（换 key / base_url / model / provider）与
    `apiKeyOf()`（供运行时判断"是不是同一条路由"）。
  - `internal/runtime/composition.go` 的 `SetModel` 重写：按原版的三步解析名字
    （`provider/model` 切分 → 裸名先当**路由名**解析成该路由第一个模型 → 否则当模型 id），
    新增幂等的 "already on X"，`switchChat` 按 `sameRoute` 选便宜路径或 `Install`，
    `sameRoute` 用「provider 名相同 + 适配器实际在发的 key 就是这条路由声明的 key」判断。
  - `i18n`：`model.select.no_route` 带上路由清单；`switched` / `already` 用 `provider/model` 全名
    （原名只报 `id`，两条路由同名模型时分不出来）。
- **原版出处**：`agents/agent.py:588-601`、`models/base.py:68-81`、`runtime/composition.py:1005-1063`；
  测试 `tests/test_model_switch.py:428-434,453-475,478-489`、`tests/test_providers.py:311-355,478`。
- **测试**：`internal/model/openai_test.go` 新增
  `TestInstallingAnotherRouteMovesTheEndpointAndTheKey`（**两个假网关**，断言切换之后请求
  真的打到新端点、带新密钥、带新模型名 —— 这正是"界面说换了、请求没动"的反例）、
  `TestInstallingRefusesAnEmptyEndpointOrModel`（半途改一半比拒绝更坏）、
  `TestSwitchingWithinARouteIsTheCheapPath`。
  `internal/agent/agent_test.go` 的 `fakeModel` 补上 `Install` 并把 `installed` 与 `switched`
  分开记录。

### B3 `--no-stream` 在协议路径被忽略；`--stream` 在行式 REPL 无效（已修）

- **改动**：
  - `internal/runtime/composition.go` 新增 `deltaSink(options)`：`options.Stream` 为 false 时
    返回 **nil**，于是 agent 既不转发增量、也不会在请求体里带 `stream: true`
    （`OnDelta == nil` 就是"没有人听"的诚实信号）。
  - `cmd/tudouni/main.go`：`--stream` 的默认值从 `true` 改成 **`false`**（行式 REPL 默认不流式，
    与原版 CLI 一致），`--tui` 分支自己默认成开、且 `--no-stream` 优先；显式传了
    `--stream` / `--quiet` 而现在这一支用不上时**明说一句**（`notice.cli.no_stream` /
    `notice.cli.quiet_tui_only`），而不是静默吃掉参数。
- **原版出处**：`runtime/composition.py:2158`（`on_delta=on_delta if stream else None`）、
  `main.py:224-234`（两句显式说明）、`args.py:102-109`（两个前端默认值不同）、
  `README.md:1685-1687`；测试 `tests/test_streaming.py:526-543`。
- **测试**：由 `internal/runtime/status_test.go` 与既有 TUI/协议测试覆盖；
  另外用真二进制做了冒烟（`--stream --quiet` 两句说明出现在 stderr，stdout 仍只有对话与审计行）。

### M6 `/status` 的 `reasoning` 形状与缺失的 `context`（已修）

- **改动**：`internal/runtime/composition.go` 的 `StatusMessage`：
  `model.reasoning` 从**字符串**改成对象 `{thinking, effort}`（原版就是对象），
  新增 `status.context`（无上下文层时为 `nil`，不是空对象 —— 空对象会让前端打一行 0，
  读起来像"开着但什么都没做"），`meta.catalog` 补上目录来源文件；
  顺带把 `messages` / `steps` / `autopilot` / `tool_count` 改成 nil-safe 读取，
  这样"还没跑过任何一轮时看一眼状态"不会崩。
- **原版出处**：`runtime/composition.py:1184-1207`；前端读取处 `frontends/tui/status.go:99-104`
  （按 map 读 `reasoning["thinking"]`，读到字符串就回落成 `true`）。
- **测试**：`internal/runtime/status_test.go::TestTheStatusPayloadKeepsTheThinkingKnobsAsAnObject`
  （关掉思考 → `thinking: false`、`effort` 仍在、`context` 键存在、`meta.catalog` 是目录路径）。

### B5 行式 CLI 的 stdout 契约（已修）

- **改动**：`internal/frontends/cli/cli.go` 的 `Options` 新增 `Err io.Writer`（默认 `os.Stderr`）；
  提示符、`/` 命令的每一条答复、错误、诊断全部走它，**stdout 只留对话正文**（版本行与审计行
  仍按原版放 stdout）。
- **原版出处**：`frontends/cli/__init__.py:629-638,1057,1112`；测试 `tests/test_banner.py:78-120`。
- **测试**：`internal/frontends/cli/cli_test.go`（新文件，`internal/frontends/cli` 此前**零测试**）。

### B7 退出词与空行（已修）

- **改动**：`Run` 里空行 / `exit` / `quit`（大小写不敏感）退出。
- **原版出处**：`frontends/cli/__init__.py:1047,1063-1064`。
- **测试**：`TestTheEmptyLineAndTheExitWordsLeave`。

### M9 未知 `/` 行不再被吞掉（已修）

- **改动**：`handleCommand` 的返回从 `(leave, nextID)` 变成 `(handled, leave, nextID)`；
  `default` 分支返回 `handled=false`，`Run` 于是把这一行**发给模型**。
- **原版出处**：`frontends/cli/__init__.py:942-957,1012-1013,1069-1070`。
- **测试**：`TestAnUnknownSlashLineReachesTheModel`、`TestKnownCommandsAreClaimed`
  （后者防住"`/status` 被当成消息发给模型"这个反向错误）。

### M4 / M7 `/thinking` 与 `/effort` 报假状态（已修）

- **改动**：新增 `reasoningOf(current)`（从运行时自己的 init 字段读两个旋钮）与 `effortLevels`；
  `/thinking` 无参数时报**真实**开关 + 强度 + howto，值写错时也**重印状态**；
  `/effort` 无参数时报**当前强度**（原来把可选值列表打在"当前强度"的位置上）+ 可选值 + howto，
  失败时重印。
- **原版出处**：`frontends/cli/__init__.py:923-939,1000-1029`。
- **测试**：`TestThinkingWithNoArgumentReportsTheRealState`、
  `TestEffortWithNoArgumentReportsTheCurrentLevelNotTheMenu`、`TestABadThinkingValueStillReportsTheState`。

### M10 CLI 的 `/mcp` 参数错误静默（已修）

- **改动**：动作不是 `list`/`load`/`unload`、或 `load`/`unload` 少了名字时，打
  `cmd.mcp.unknown` 再列清单；`/model a b` 改成把整段 remainder 传下去（原来只取第一个词）。
- **原版出处**：`frontends/cli/__init__.py:830-872,961-962,985-987`；测试 `tests/test_cli_mcp.py:143-157`。
- **测试**：`TestMCPWithABadArgumentSaysSoAndStillLists`。

### M8 `--debug` 是静默空操作（已修）

- **改动**：`internal/agent/agent.go` 新增 `debug` / `debugLazy` / `preview` /
  `debugOutcomePrefix` 与 `DebugPreviewLimit`，并在四处补上原版有、Go 没有的调试输出：
  工具调用、工具结果、模型返回（含 `content` 预览）、权限裁决逐条来路、重试。
  `debugLazy` 收闭包而不是字符串，因为 `preview` 会把整段正文扫一遍 —— 原版注释实测过
  「一个 8MB 的 read_file 结果白扫约 10ms，一批五个就是 50ms」，而这条路径对**默认不开 debug**
  的每一次工具调用都成立。`reportToStderr` 也补上了原版的 `[warn] ` 前缀。
- **原版出处**：`agents/agent.py:720-756`（`_debug` / `_debug_lazy` / `_preview`），
  调用点 `:914,1656-1671,1814,1848-1850,2066`；测试 `tests/test_debug_cost.py:66-74`。
- **验证**：真二进制冒烟（`--debug` 起一次会话，诊断行出现在 stderr、stdout 干净）。

## 3.0.2

### B1 思考开关的请求体：`extra_body` 没有摊平（已修）

- **改动**：`internal/model/openai.go` 新增 `applyRequestFields`，在组请求体时按 OpenAI SDK
  的语义把 `extra_body` 里的键**合并到顶层**；`requestBody` 改用它。
  `internal/state/reasoning.go` 的 `RequestFields` 保持原样（它与原版
  `reasoning.request_fields` 逐字对应，原版 `tests/test_catalog.py:247-252` 断言的正是这个形状），
  但注释改成说清"`extra_body` 是通道，不是字段名"。
- **原版出处**：`state/reasoning.py:129-131`、`models/openai_compatible.py:481,578`；
  线上报文的断言在 `tests/test_providers.py:202,225-226`。
- **测试**：`internal/model/openai_test.go`（新文件，`internal/model` 此前**没有任何测试**）：
  - `TestThinkingIsOnByDefaultInTheRequest` —— 顶层 `reasoning_effort == "high"`、
    顶层 `thinking.type == "enabled"`、**且线上没有 `extra_body`**；
  - `TestTurningThinkingOffChangesTheNextRequest` —— `thinking.type == "disabled"`
    且**不发** `reasoning_effort`；
  - `TestTheEffortSurvivesADisabledThinking` —— 关掉再打开，强度还在；
  - `TestApplyRequestFieldsFlattensTheEscapeHatch` —— 直接钉住合并本身。
  用 `httptest` 起假网关，断言的是**线上报文**，与原版同一口径。

### B9 部分输出不算"收过了"（已修）

- **改动**：`internal/tools/builtin/jobs.go` 的 `Output` 只在 `!stillRunning` 时置
  `collected = true`；审计的 `job_status` 也跟着改成 `collected` / `running`（原来用的是
  四态 `State()`，与原版的 `"collected" if final else "running"` 不同）。
- **原版出处**：`tools/builtin/jobs.py:509-512,534`，测试 `tests/test_jobs.py:163-171`。
- **测试**：`internal/tools/builtin/jobs_test.go::TestAPartialReadIsNotACollectedResult`
  —— `wait=false` 读一次之后 `Collected()` 仍为 false、`Outstanding()` 仍为 true；
  真的结束之后再读才算收走。

### B10 后台任务目录按会话隔离（已修）

- **改动**：`jobs.go` 新增 `NewJobBoardForSession(sessionID, clock)`，目录变成
  `<workspace>/.tudouni/jobs/<session_id>/`；`NewJobs(workspace, sessionID)` 多收一个参数，
  装配处 `internal/runtime/composition.go:316` 传 `session.SessionID`。
- **原版出处**：`tools/builtin/jobs.py:768-771`（`jobs_dir` 的注释写明"只有这一处拼这个路径"），
  装配处 `runtime/composition.py:2017-2021`。
- **测试**：`TestTheSessionOwnsItsJobDirectory`（两个会话的目录不同且都带会话段）。
- **顺带**：`prune()` 的计数改成只在真的删掉时 `++`（原来两个分支都 `++`，
  统计的是"看到的文件数"），并有 `TestPruneCountsOnlyWhatItRemoved` 钉住
  （非 `.out` 的文件不许动）。

### M15 记录上限会腾位（已修）

- **改动**：新增 `JobBoard.makeRoom()`，在 `Start` 里于记录上限检查**之前**调用，
  只丢掉 `Collected()` 的记录；拒绝文案改成列出"结果是还没收的是 …"，
  并修掉了原来 `strings.Join(live, "、")` 在 `live == nil` 时打印空列表的问题。
- **原版出处**：`tools/builtin/jobs.py:318-343`（`_make_room`），测试 `tests/test_jobs.py:360-372`。
- **测试**：`TestCollectedRecordsMakeRoom`、`TestUncollectedRecordsAreNeverDropped`。

### M16 两个上限分开（已修）

- **改动**：新增 `JobBoard.liveJobs()`（只算 `Running()`）与 `outstandingJobs()`；
  `Start` 的在跑上限改用 `liveJobs()`，不再把"跑完了没结果"算成"在跑"。
- **原版出处**：`tools/builtin/jobs.py:315-316,429-435`。
- **测试**：`TestTheLiveCapCountsOnlyRunningJobs` —— 六条已结束未收的任务，
  `liveJobs()` 为 0、`outstandingJobs()` 为 6。

### 新发现：`Close()` 在"没有进程句柄"的任务上会 panic（已修）

- **现象**：`internal/process/process_windows.go` 的 `TerminateTree` 只判了
  `cmd.Process == nil`，没有判 `cmd == nil`；`JobBoard.Close()` 遍历任务时对
  `job.cmd` 为 nil 的项会解引用空指针。在 Windows 上这是**进程退出路径上的崩溃**。
- **改动**：`TerminateTree` 改成 `if cmd == nil || cmd.Process == nil { return }`。
- **发现方式**：新写的 jobs 测试构造了不带进程句柄的任务，`t.Cleanup(board.Close)` 直接把它
  炸了出来 —— 一个只在"退出"这种最坏时刻发生的崩溃，靠读代码不容易注意到。
- **测试**：`internal/tools/builtin/jobs_test.go` 的所有用例都会走到这条路径。

## 未修（继续）

B2（跨路由 `/model` 不换 base_url/密钥）、B3（`--no-stream` 在协议路径被忽略）、
B4（任务列表不进载荷尾部）、B5–B8（行式 CLI 的 stdout 契约 / `--audit` 汇总 / 退出词 /
启动通知）、M1–M14、以及 TUI 的 10 条 MAJOR 与 19 条 MINOR。
