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
| `internal/state/`、`internal/audit/`、`internal/context/` | 会话、工作区 `AGENT.md`、审计日志、上下文压缩与工件 |
| `internal/config/`、`internal/paths/` | 配置文件、安装包内路径解析 |
| `internal/skills/`、`internal/mcp/` | 技能与 MCP 连接 |
| `internal/i18n/` | 界面文案 |
| `internal/version/` | 版本号的读取与展示；**命令名也在这里**（`version.Name`，`--help`、flag set 名、打包产物名都从它取，改名字只改这一处 + `packaging/`） |
| `internal/release/`、`tools/release/` | 打包、暂存目录、校验、压缩 |
| `prompts/` | 系统提示词（运行时按目录是否存在来判定「这是不是安装包根目录」） |
| `tools/vendor/rg/` | 随包分发的 ripgrep，按平台各一份 |
| `packaging/` | `install.ps1`、`install.sh`、`README.txt` |

## 构建、测试、发布

```
make build      # 编译本机平台，产物 ${PWD}/dist/tudouni-aigo-<版本>-<平台>/
make test       # go test ./...
make vet
make release    # 两个平台全量构建 + 校验 + 打包成 zip
make clean
```

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
- **桌面端自己的版本** 在 `desktop/tudouni-aigo-desktop/` 里，改的时候这几处必须一起改、
  且保持一致：

  | 文件 | 处数 |
  | --- | --- |
  | `package.json` | 1 |
  | `package-lock.json` | 2（根 `version` + `packages.""` 里的那个） |
  | `src-tauri/tauri.conf.json` | 1 |
  | `src-tauri/Cargo.toml` | 1 |
  | `src-tauri/Cargo.lock` | 1（只改 `name = "tudouni-aigo-desktop"` 那个 `[[package]]`；同名号的第三方 crate 不要碰） |

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
- 某些沙箱里 `go test ./...` 的 runner 会静默不输出（例如 `internal/mcp`）。这时改用
  `bash test.sh`：它把每个测试二进制编译出来直接跑，结论一样。
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
