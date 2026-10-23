# AGENT.md

本项目是一个 Go 重写的 Python + Textual 智能体运行时
这个文件写给在这个工作区里干活的 AI 助手

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `cmd/tudouni/` | 唯一入口：命令行参数、`--help`/`--version` 文案、子命令分发 |
| `internal/frontends/tui/` | Bubble Tea TUI（界面、主题、面板、输入行、快捷键、命令面板）——**裸跑时的默认界面** |
| `internal/frontends/cli/` | 行式 REPL：`--cli` 要它，stdin/stdout 不是终端时也回落给它 |
| `internal/frontends/ansi/` | 纯文本前端（无 TTY 时的输出） |
| `internal/runtime/` | 运行时主体：`--runtime-stdio` 起的子进程，把 TUI 和智能体循环隔开 |
| `internal/protocol/` | TUI ↔ runtime 的 JSONL 协议 |
| `internal/agent/`、`internal/model/` | 智能体循环与各家模型客户端 |
| `internal/tools/` | 工具实现（shell、读写文件、grep 等）；`tools.Workspace` 是工作区边界，文件和终端共用它 |
| `internal/files/` | 前端侧的 Workspace 文件能力：一层目录清单 + 读一个 UTF-8 文件（`file_list`/`file_read`） |
| `internal/terminal/` | Workspace 的终端：真 PTY（unix `creack/pty` / Windows ConPTY）、输出聚合、生命周期、进程组清理 |
| `internal/security/`、`internal/process/` | 权限判定、风险分级、子进程策略 |
| `internal/state/`、`internal/audit/`、`internal/context/` | 会话、工作区说明 `AGENT.md`/`AGENTS.md`、审计日志、上下文压缩与工件 |
| `internal/memory/` | 工作区记忆：Markdown 存事实（`entries/`）、候选区审核（`candidates/`）、可重建索引、确定性检索。运行时把它注入 payload 尾，模型侧只有 `memory_search`/`memory_get`/`memory_propose` 三个工具；桌面端面板见 `docs/design/workspace-memory.md` |
| `internal/config/`、`internal/paths/` | 配置文件、安装包内路径解析 |
| `internal/skills/`、`internal/mcp/` | 技能与 MCP 连接 |
| `internal/i18n/` | 界面文案 |
| `internal/codeintel/` | 代码智能索引。`cgparse/` 解码 `cg-parse` 的缓冲区契约并批量调度；`cggraph/` SQLite schema、解析器（7 种语言 tier、`implements` 合成、`ambiguous` 标记）、查询与 C/C++ 降级提取；`cgwasm/` WASM 兜底（**未接线**，卡在 emscripten 动态链接，卡点写在包文档里）；`refresh.go` 决定**何时**重建（`EnsureFresh`：stat 比对 → 小分歧内联重建 / 大分歧只报告，**从不等待**锁；`Warmup` 是会话启动时的后台预热，`Runtime.WarmupIndex` 门控「开关开 + 索引存在」后 fire-and-forget 跑一次，由 protocol 层在 `init` 上线路径触发，不在组装期，不写面板的 last-run）；`build.go` 是面板那两个按钮的路径（`Build` / `Refresher.Rebuild`，带进度、等锁、**不可取消**）；`lock.go` 是**跨进程**独占锁（桌面端一个会话一个子进程，同一 workspace 会有多个写者）；`config.go` 是工作区开关（`.tudouni/codeintel/config.json`，默认关）。索引库在 `<workspace>/.tudouni/index/graph.db`。模型侧只有 **`code_explore` 一个工具**（`internal/tools/builtin/code_explore.go`），查询在本进程内完成，只有重建索引才 exec `tools/vendor/cg/<triple>/cg-parse`。**开关（人的许可）和「库里有没有索引」（文件系统的事实）是两件事**，四个组合都可达：只有两者同时成立工具才注册，且开关一改就当场注册/注销。协议侧是 `codeintel_action` + `ui(codeintel)`（protocol 9）。独立 CLI 入口 `cmd/cg/`，与官方基线对比的工具 `tools/cgcompare/` |
| `internal/version/` | 版本号的读取与展示；**命令名也在这里**（`version.Name`，`--help`、flag set 名、打包产物名都从它取，改名字只改这一处 + `packaging/`） |
| `internal/release/`、`tools/release/` | 打包、暂存目录、校验、压缩 |
| `desktop/tudouni-aigo-desktop/` | 独立的桌面客户端（Tauri 2 + React）；出安装包见下文「桌面端安装包」一节 |
| `prompts/` | 系统提示词（运行时按目录是否存在来判定「这是不是安装包根目录」） |
| `tools/vendor/rg/` | 随包分发的 ripgrep，按平台各一份 |
| `packaging/` | `install.ps1`、`install.sh`、`README.txt` |
| `docs/` | 为什么这样写：`spec/` 是权威规格，`design/` 是决策与成因，`parity/` 是 Go↔Python 的对照审查（已完成），`history/` 是已归档的调查和账本。**入口是 `docs/README.md`** —— 每份文档今天还有没有权威都写在那里，别拿已实现或已推翻的当依据 |

## 构建、测试、发布

```
make build      # 编译本机平台，产物 ${PWD}/dist/tudouni-aigo-<版本>-<平台>/
make test       # go test ./...
make vet
make release    # 两个平台全量构建 + 校验 + 打包成 zip
make clean
```

### 桌面端安装包（Windows NSIS）

桌面端出安装包只需一条命令（在 `desktop/tudouni-aigo-desktop/` 下）：

```
npm run installer       # = scripts/build-installer.ps1
```

脚本依次做三件事，顺序不能乱：

1. **检查工具链**（Node、cargo 在 PATH 里；`-SkipToolcheck` 跳过）；
2. **确保 runtime 已暂存**：`src-tauri/runtime/` 缺二进制、`--version` 与仓库根
   `VERSION` 不一致、或 `dist/` 里有更新的构建时，自动跑 `npm run runtime:stage`；
   都满足就跳过（`-Force` 强制重跑）；
3. **跑 `npm run tauri build`**（日志落在 `.tauri-build.log`），结束时报告产物路径。

它**不会**替你跑 `make release`：那是 Go 运行时自己的发布门（会真启动二进制做校验）。
如果 Go 源码有改动，先在仓库根 `make release`，再跑 `npm run installer`。

产物：`desktop/tudouni-aigo-desktop/src-tauri/target/release/bundle/nsis/tudouni-aigo_<桌面端版本>_x64-setup.exe`。
发布目标只有 NSIS（Windows）；`tauri.conf.json` 里的 `deb`/`appimage` 只在 Linux 上构建时生效。

已知坑（脚本里已经处理，改脚本时别丢）：Windows PowerShell 5.1 下 `$ErrorActionPreference='Stop'`
会把 native 命令写到 stderr 的普通进度行当成终止错误，所以 npm 调用都包在 `cmd /c` 里；
同样 5.1 没有 `$IsWindows` 变量和 `Join-Path` 多子路径形式，判定要用 `$env:OS`

还有，Strawberry Perl portable 解包在 %LOCALAPPDATA%\Strawberry\perl\bin（OpenSSL 源码编译需要）
CARGO_TARGET_DIR=C:\t（绕开 OneDrive 深层路径超 MAX_PATH 260 字符）
跑 installer 前记得 export 这两个环境变量

Makefile 的每条 recipe 都走 `go run ./tools/release`，因为本仓库在 Windows 上开发，
`mkdir -p`／`$(shell cat ...)` 这类 POSIX 写法在 cmd 里会挂。别把 recipe 改回 shell 工具。

`make release` 会**真的运行**刚构建出来的二进制：检查 `--help`、检查 `--version` 里带没带
本次版本号、用隔离的 `AGENT_CONFIG_FILE` 起一次 `--runtime-stdio`，并确认日志里没有
`grep.missing_binary`。所以版本相关的改动必须走 `make build`／`make release`，不能只 `go build`。

发布平台只有 **windows/amd64 与 linux/amd64**：`tools/vendor/rg/` 只放了这两个平台的 ripgrep。
要加平台，得连 vendored 二进制一起加，否则 `grep` 在目标机上会静默消失。

## 版本号约定

版本号只有一个来源：仓库根的 `VERSION` 文件，发布时用 `-ldflags -X` 编进二进制。
**改 Go 源码就要按改动大小同步更新 `VERSION`**，否则 `--version` 报的是旧号：

| 改动性质 | 版本变化 | 例子 |
| --- | --- | --- |
| 不兼容变更 | 主版本 +1 | 协议字段改名、命令行参数语义变化、配置文件或目录布局不兼容 |
| 新功能、用户能感知的行为变化 | 次版本 +1 | 新命令、新面板、新工具、新协议字段 |
| 修复、微调、文案、主题、注释、文档、重构 | 修订号 +1 | 修一个渲染 bug、改一句提示语、整理代码 |

一次提交里混了几种改动，取最大的那一档。版本号改动本身不单独提交，跟代码放在一起。

### `VERSION` 只管 Go 运行时，`desktop/` 有自己的版本

**只改 `desktop/` 下的东西，就不要动 `VERSION`。**

`desktop/tudouni-aigo-desktop/` 是一个独立项目（Tauri 2 + React 前端），它自己的版本号
与运行时的版本号是**两个独立的轴**，这不是重复而是设计：桌面端是「换一个前端」，它和
运行时的发布节奏本来就不同步，`init` 里也没有运行时版本字段，两者是分别显示的
（见 `desktop/tudouni-aigo-desktop-design/desktop-app.md` 决策 1）。

所以：

- **`VERSION`（仓库根）** 覆盖 Go 运行时：`cmd/`、`internal/`、`tools/`、`packaging/`、
  `prompts/`。只有改了这些才按上表升它。
- **桌面端自己的版本** 在 `desktop/tudouni-aigo-desktop/` 里，改的时候**不要手工编辑**，
  在 `desktop/tudouni-aigo-desktop/` 下跑：

  ```
  npm run version:bump 1.2.3    # = node scripts/bump-version.mjs 1.2.3，一次改齐五处并自验
  npm run version:check         # 只检查五处是否一致，不改文件（CI / 提交前可用）
  ```

  它覆盖的五处：`package.json`（1）、`package-lock.json`（2：根 `version` +
  `packages.""`）、`src-tauri/tauri.conf.json`（1）、`src-tauri/Cargo.toml`（1）、
  `src-tauri/Cargo.lock`（1，只改 `name = "tudouni-aigo-desktop"` 那个 `[[package]]`；
  同名号的第三方 crate 不要碰）。脚本会校验每个文件的格式假设（JSON 是否还是
  标准两空格序列化、行尾风格），不满足就拒绝写盘。

- 两边都改了（例如动了 `internal/protocol/` 的协议形状、桌面端跟着适配）才两边都升。

判断标准很简单：**改完之后 `git diff --stat -- '*.go'` 是不是空的**。是空的，就没碰 Go，
`VERSION` 也不该动。桌面端的改动无论多大，都不构成升 `VERSION` 的理由——那会让
`--version` 报出一个没有任何 Go 代码变化支撑的号，而真正发 Go 版的时候又得再升一次。

## 测试约定

**不是大功能修改，不必跑全量测试**：

- 小改动（某个包内部、行为明确、没碰协议／权限／工具／发布流程）：只跑受影响的包，
  例如 `go test ./internal/frontends/tui/`，够了。
- 大改动（新功能，或动了 `internal/protocol`、`internal/runtime`、`internal/security`、
  `internal/tools`、`internal/release`、`tools/release`、`packaging/`）：跑全量 `make test`。
- 发版前跑全量，并且用 `make build`／`make release` 走一遍真实二进制校验。

两条补充：

- 涉及排版、宽度、颜色的改动，测试里要调 `withColour(t)` 强制色彩配置。没有色彩配置时
  lipgloss 会把样式整段剥掉，宽度算错也看不出来——之前那个「选中行高亮占三行」的 bug
  在无色渲染里完全不可见。
- 没有 TTY 的环境看不到真实观感。要判断外观，宁可写断言（宽度、行数、转义序列），
  不要凭猜。

## 代码约定

- 注释用英文，写「为什么」而不是「做了什么」；提交信息用英文祈使句作标题，正文说清取舍。
- 界面文案一律走 `internal/i18n`。动态 key 用 `Lookup`／`LookupOr`：`T` 遇到未知 key
  返回 `⟪key⟫` 且不会回退，别指望它兜底。
- 面板是一行一行画出来的：交给 lipgloss 边框的行不能超过 `overlayInner`。
  `Width()` 包含 padding 且只补齐、不截断，唯一能截断的是 `MaxWidth()`；过宽的行会被
  边框**重排**，而它的折行不把 ANSI 转义当零宽，于是选中行的高亮会变成两三行。
- 主题里 `clearRoles` 列出的颜色表示「不画」，用哨兵值 `ansiDefault` 表达。任何需要垫在
  别的颜色之上／之下的地方（比如 accent 背景上的文字）必须换成真实颜色：`lipgloss.Color`
  会静默丢掉这个哨兵，结果就是默认前景色配 accent 背景——在深色终端上最难读的组合。
- 权限与提问一律 fail-closed：TUI 永远不替 runtime 回答，也不要有「猜一个」的兜底。
- 只改 Go 源码请用编辑工具，不要用 PowerShell 的 `Set-Content`／`Out-File`：它会把
  UTF-8 写成乱码，而且不可逆。
- `packaging/install.ps1` 必须保留 UTF-8 BOM（Windows PowerShell 5.1 否则读成乱码），
  `*.sh` 必须是 LF——`.gitattributes` 已经固定，别绕过它。
