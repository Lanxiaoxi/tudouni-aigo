# Workspace Dock（工作区坞）最终设计方案

## 一、项目定位

### 1.1 背景与目标

当前桌面端已经具备文件浏览、终端和 Git 相关的部分 Runtime 能力，但这些能力分散在不同入口和界面中：

- 文件通过独立的 FilesPanel 浏览。
- 终端通过 TerminalView 进入，并会占用整个对话区域。
- Git 目前主要以 `git_snapshot` 工具的形式服务于 Agent，尚未提供面向用户的 Git 界面。
- 文件、Git 和终端之间缺乏统一的工作区状态同步机制。
- 文件、终端等资源与现有 Session 生命周期存在一定耦合。

本次改造的目标不是简单地增加一个侧栏，而是建立统一的工作区操作界面和 Runtime 工作区基础设施。

将文件浏览、Git 状态查看、Diff 和交互式终端集中到一个独立的工作区区域，让用户在与 Agent 对话的同时，能够查看、观察和操作当前工作区。

### 1.2 产品定位

将右侧外栏定义为 **Workspace Dock（工作区坞）**。

Workspace Dock 是与对话并列的工作区域，不属于任何具体 Session。它围绕当前 Workspace 提供统一的资源浏览、状态观察和交互操作能力。

核心设计原则：

1. **Workspace 优先**：文件、Git 和终端全部属于 Workspace，不属于 Session。
2. **统一上下文**：三个模块共享同一个工作区身份、文件路径体系和变化感知机制。
3. **前后端职责分离**：Runtime 管理工作区资源、文件系统、Git 和 PTY；桌面端负责 UI、缓存、布局和交互。
4. **远程透明**：本地和远程工作区使用同一套协议和 UI，前端不直接操作工作区文件系统。
5. **独立生命周期**：隐藏外侧栏、切换 Session 或切换 Workspace，不应意外结束原有终端进程。
6. **渐进扩展**：未来增加代码编辑、进程管理、服务监控等能力时，不需要重新设计 Workspace 的基本架构。

### 1.3 最终界面结构

桌面从左到右：

工作区栏 | Agent 对话 | 会话信息栏 | Workspace Dock

Workspace Dock 内部采用三个区域：

- **Workspace Navigator**：上层导航区，提供文件和 Git 两种模式。
- **Workspace Viewer**：上层内容区，统一展示文件预览和 Git Diff。
- **Terminal Dock**：下层终端坞，管理多个长期运行的交互式终端。

文件和 Git 共用上层的导航、内容展示结构，终端始终是独立的下层区域。

整体结构：

```text
Workspace Dock
│
├── Workspace Navigator / Viewer
│   │
│   ├── Explorer
│   │     ├── 文件树
│   │     └── 文件预览
│   │
│   └── Git
│         ├── 变更文件列表
│         └── Git Diff
│
└── Terminal Dock
      ├── Terminal 1
      ├── Terminal 2
      └── Terminal N
```

---

## 二、整体布局与交互

### 2.1 Workspace Dock 的布局

Workspace Dock 是一个独立的第四栏，支持整体展开和收起。

不采用固定的 340px、780px 两档宽度，而采用用户偏好宽度与窗口空间预算结合的响应式布局。

建议宽度规则：

| 外侧栏宽度 | 布局方式 |
|---|---|
| 320–519px | 单栏模式，导航和内容前后切换 |
| 520–759px | 双栏模式，导航区 + 内容区 |
| 760px 以上 | 双栏模式，允许更宽的内容区 |

双栏模式下，导航区默认约 220–260px，内容区占用剩余空间。两个区域都可以拖动调整宽度。

单栏模式下，选择文件或 Git 变更后进入内容页面，顶部提供返回导航区的操作。

终端坞始终位于外侧栏下方，不受 Explorer 和 Git 模式切换影响。

### 2.2 桌面整体空间预算

必须保证对话区域具有合理的最小宽度，不能为了保留所有栏而不断压缩对话。

空间调整优先级：

1. 优先收起会话信息右栏。
2. 工作区栏可以从完整宽度退化为窄图标栏。
3. Workspace Dock 根据剩余空间压缩到最小宽度。
4. 当无法同时满足布局最小宽度时，将 Workspace Dock 切换为临时覆盖视图，而不是让对话无限压缩。

对话区目标最小宽度为 560px，Workspace Dock 的最小常驻宽度为 320px。

实际外侧栏宽度：

```text
available_width =
    window_width
    - visible_left_rail_width
    - conversation_min_width
    - other_visible_panels
    - layout_gaps

actual_dock_width =
    min(preferred_dock_width, available_width)
```

例如，窗口宽度为 1280px 时，保留 56px 工作区栏和 560px 对话区，外侧栏可用宽度大约为 664px，而不是强行要求 780px。

用户偏好宽度与系统自动压缩后的实际宽度必须分开保存。窗口变小不应该覆盖用户原来的宽度设置。

**展开方向：外侧栏向外展开。** 会话信息右栏从窗口右边界向内展开（占用对话区的宽度）；外侧栏相反，打开时窗口从右边界向外加宽一个外侧栏的宽度，对话区和两条侧栏保持原宽度不变；关闭时窗口恢复原位置和宽度（若用户期间移动或缩放过窗口，只扣回加宽的那部分）。贴近屏幕右边缘时窗口只向左平移不够的那部分。窗口已最大化、全屏，或屏幕放不下「窗口 + 外侧栏」时不调整窗口，退回上面的空间预算（向内挤压或覆盖视图）。实现见 `src/state/workspaceDock/windowGrowth.ts` 与 `src/components/dock/useDockWindowGrowth.ts`。

### 2.3 顶部入口与操作

Workspace Dock 的开关放在外侧栏之外，避免外侧栏关闭后无法重新打开。

建议提供：

- Workspace Dock 总开关。
- Explorer / Git 模式切换。
- Terminal Dock 显示和隐藏。

Explorer 和 Git 属于上层导航模式；终端属于独立区域。

因此：

- 切换 Git 不影响终端状态。
- 切换 Explorer 不影响 Git 的选择状态。
- 隐藏终端不影响 PTY 进程。
- 收起整个 Workspace Dock 不影响任何工作区资源。

快捷键建议：

- `Ctrl+Shift+E`：切换 Explorer。
- `Ctrl+Shift+G`：切换 Git。
- `Ctrl+\``：切换 Terminal Dock。
- `Ctrl+Shift+B`：切换 Workspace Dock。

最终快捷键在实现前检查全局冲突，并统一接入现有快捷键系统（`hooks/useGlobalKeys.ts`）。已知：现有 `Ctrl+B` 切换右栏，与 `Ctrl+Shift+B` 语义过近，应改选其他组合；`Ctrl+\`` 当前未绑定，但有一条提到它的过时注释需清理。

终端聚焦时，需要单独处理快捷键路由。只有外侧栏总开关、终端区域最大化或折叠等必要操作继续生效，其他快捷键不应抢占终端输入。

### 2.4 终端坞布局

Terminal Dock 默认高度约 260px。

支持：

- 拖动分隔条调整高度。
- 折叠，只保留标题栏。
- 在 Workspace Dock 内最大化。
- 多个终端 Tab 切换。
- 新建、关闭和重命名终端。
- 显示终端运行状态。

第一版只实现终端在 Workspace Dock 内最大化，不实现将终端移动到对话主区域。

终端坞的最大化与折叠属于 UI 展示状态，不影响终端资源生命周期。

---

## 三、Runtime 核心架构

这是整个项目最重要的设计部分。

不能把文件、Git、终端简单实现成三个互相独立的协议 Handler。应该在 Runtime 中建立统一的 Workspace 管理层。

### 3.1 RuntimeHost 与 Session 解耦

Runtime 必须引入明确的宿主级资源管理边界。

建议结构：

```text
RuntimeHost
│
├── WorkspaceManager
│   │
│   ├── WorkspaceContext A
│   │   ├── FilesystemService
│   │   ├── GitService
│   │   ├── TerminalManager
│   │   └── WorkspaceEventHub
│   │
│   └── WorkspaceContext B
│       ├── FilesystemService
│       ├── GitService
│       ├── TerminalManager
│       └── WorkspaceEventHub
│
└── SessionManager
    │
    ├── Session A → Workspace A
    ├── Session B → Workspace A
    └── Session C → Workspace B
```

`RuntimeHost` 是工作区资源管理的宿主。

`SessionManager` 管理具体对话及 Agent 执行状态。

`WorkspaceManager` 管理工作区资源和工作区服务。

一个 Workspace 可以被多个 Session 引用，但 Session 不拥有 Workspace。

**生命周期约束：RuntimeHost 的生命周期长于单个 Session 的生命周期。**

因此，切换 Session 时，只需要切换或重建 Session 执行上下文，不应该销毁 WorkspaceContext。

如果当前实现采用每个 Session 对应一个独立 Runtime 进程的方式，需要调整进程和对象管理边界：将 WorkspaceManager 放在更长生命周期的 RuntimeHost 中，不能只在 Session 内增加一个 WorkspaceManager 实例。

### 3.1.1 落地方式：独立的 Workspace Host 进程

现状核实：

- 桌面端每个会话起一个 `--runtime-stdio` 子进程（`src-tauri` 的 `launch.rs`），关闭会话即 `shutdownRuntime` 结束该进程（`sessions.ts` 的 `detachSession`）。
- Go 侧终端已是进程级资源（`runtime.Boot()` 的 `Booted.Terminals`），但进程与会话同生共死，因此终端事实上仍随会话结束。
- 一个 runtime 进程同一时刻只挂一个 session，工作区根就是进程 cwd，没有 `workspace_id`。

因此本功能**作为增量实现**，不改造现有会话 runtime：

1. Go 新增 `--workspace-host` 入口模式和独立的新包（建议 `internal/workspace/host`），承载 WorkspaceContext（Filesystem / Git / Terminal / EventHub）。它不加载模型、不跑 Agent，与 `internal/runtime` 的会话逻辑互不依赖。
2. Rust 侧新增「工作区 → host 进程」注册表 `WorkspaceHostRegistry`，它就是本文中的 **WorkspaceManager / RuntimeHost** 的实际落点。会话进程的启动与关闭逻辑保持不变。
3. 远程工作区用同一个二进制：复用现有 ssh2 连接，另开一条 exec channel 在远端启动 `--workspace-host`，与远程起 runtime 的方式一致，「远程透明」自然成立。
4. 不由 Rust 直接管理 PTY：那样本地可行，远程却需要另写一套，违背「远程透明」原则。

复用边界：

- 路径安全复用 `tools.Workspace.SafePath`（安全原语，不重写）。
- PTY 启动与进程组清理复用 `internal/terminal` 的底层（ConPTY / creack/pty），manager、输出缓冲、协议全部新写。
- 现有 FilesPanel、TerminalView 及会话协议里的 `file_*`、`terminal_*` 在迁移完成前保持可用。

Host 生命周期：

| 事件 | 行为 |
|---|---|
| 首次打开该工作区的 Dock | 懒启动 host |
| 会话打开 / 切换 / 关闭 | 不影响 host |
| 明确关闭工作区 | 结束 host；存在运行中的终端时先向用户确认 |
| 退出应用 | 结束全部 host |
| host 意外退出 | 前端显示断开状态，可重新启动；不承诺恢复 PTY |

### 3.2 WorkspaceContext

`WorkspaceContext` 是整个架构的核心对象。

它代表 Runtime 中一个实际的工作区运行环境，负责统一管理该工作区的服务。

建议包含：

```text
WorkspaceContext
    workspace_id
    name
    root
    environment_type
    capabilities
    lifecycle_state

    FilesystemService
    GitService
    TerminalManager
    WorkspaceEventHub
```

字段含义：

| 字段 | 含义 |
|---|---|
| workspace_id | Workspace 稳定身份 |
| name | 工作区显示名称 |
| root | 工作区根目录 |
| environment_type | local / remote / container |
| capabilities | 当前工作区支持的功能 |
| lifecycle_state | 当前工作区运行状态 |

`workspace_id` 不应该直接等于文件系统路径。

同一路径可能存在于不同 Runtime 环境中；远程工作区也不能用桌面端本地路径来识别。

`workspace_id` 由桌面端生成，沿用桌面端工作区记录的稳定 id（实施前核实现有记录是否具备稳定 id，不具备则补上），在启动 host 时传入。host 内部只认 `workspace_id + root`；`root` 仅用于 host 自身解释路径，不作为前端的身份依据。

WorkspaceManager 负责工作区的创建、获取、引用、资源管理和关闭。

Session 只保存 `workspace_id` 引用，通过该引用使用对应 Workspace 的服务。

Agent 使用文件、Git 或工作区相关工具时，也必须解析当前 Session 绑定的 WorkspaceContext，不能自行猜测当前路径。

### 3.3 四个基础服务

#### FilesystemService

负责：

- 目录读取。
- 文件元数据读取。
- 文件内容读取。
- 文件范围读取。
- 文件搜索。
- 文件变化监听。

第一版运行在 host 进程内，新写实现，只复用 `tools.Workspace.SafePath` 这个安全原语；现有会话侧的文件工具是否改为复用它，不在第一版范围内。

#### GitService

负责：

- Git 仓库探测。
- Git 状态查询。
- 暂存区和工作区状态解析。
- Diff 生成。
- 文件变更统计。

新建独立的 `internal/gitinfo` 包，参考 `git_snapshot.go` 的 porcelain v2 和 numstat 解析逻辑实现（现有逻辑没有内容 Diff 能力，需新写）。

第一版只有 Workspace Git UI 使用它；`git_snapshot` 是否改为复用 `gitinfo` 不在本次范围内，后续单独决定。

#### TerminalManager

负责：

- PTY 创建。
- PTY 输入输出。
- 终端尺寸调整。
- 终端列表和元数据。
- 终端进程生命周期。
- 有限长度输出缓冲。
- 输出序列号与重连恢复。

TerminalManager 必须属于 WorkspaceContext，不属于 Session。

#### WorkspaceEventHub

负责：

- 收集工作区变化。
- 统一事件格式。
- 事件合并与去重。
- 递增 Workspace revision。
- 事件订阅与分发。
- 通知前端缓存失效。
- 在事件丢失时触发重新同步。

四个服务共享 WorkspaceContext，但各自负责自己的业务数据。

---

## 四、工作区变化感知机制

### 4.1 设计目标

文件、Git 和终端必须对同一个工作区的变化保持一致。

例如：

Agent 修改一个文件后：

- Explorer 文件树能够及时刷新。
- 文件预览能够显示最新内容。
- Git 能够发现文件变化。
- Git Diff 能够反映最新修改。

用户在终端中修改文件，也应该得到同样的效果。

不能只在 Agent 的 `write_file` 或 `edit_file` 工具执行完成后刷新，因为变化还可能来自终端、用户和外部进程。

因此，统一建立 Workspace Change Event 机制。

### 4.2 事件来源

采用双来源策略：

**第一来源：文件系统 Watcher**

负责感知工作区文件系统的变化，覆盖：

- Agent 工具修改。
- 用户终端操作。
- 外部程序修改。
- 文件创建、删除和重命名。

**第二来源：Runtime 内部变更通知**

Runtime 自己执行文件创建、写入、编辑、删除等操作时，可以主动通知 EventHub。

它主要用于降低延迟和补充文件系统监听可能遗漏的事件，不替代 Watcher。

第一版只实现第一来源。在 3.1.1 的进程模型下，Agent 的文件工具运行在会话进程里，host 收不到其内部通知；Watcher 加 300ms 合并窗口的延迟可以接受。以后若需要更低延迟，再由桌面端把会话侧工具结果转发给 host。

Watcher 需新引入 `fsnotify`（pin 版本；当前 `go.mod` 中没有任何 watcher 依赖）。实施时先做技术验证：Windows（含 OneDrive 路径）与 Linux 的递归监听方式、inotify watch 上限、`node_modules` 等大目录的忽略策略；溢出或失效时一律走 `reset_required`。

对于 Watcher 不可用或事件队列溢出的环境，提供重新校准机制，不能假设事件永远完整送达。

### 4.3 事件结构

建议采用：

```json
{
  "workspace_id": "workspace-123",
  "revision": 108,
  "changes": [
    {
      "path": "src/main.go",
      "type": "modified"
    },
    {
      "path": "src/new.go",
      "type": "created"
    }
  ],
  "invalidates": [
    "files",
    "git"
  ],
  "reset_required": false
}
```

变化类型：

- created
- modified
- deleted
- renamed

事件中的路径全部是工作区相对路径。

`revision` 是工作区级单调递增版本，用于前端检测事件缺口。

`invalidates` 用于告诉前端哪些缓存需要失效。

对于无法明确识别具体路径、监听事件溢出等情况，使用 `reset_required`，要求前端重新同步，而不是继续使用不完整缓存。

### 4.4 事件刷新流程

以 Agent 修改文件为例：

```text
Agent 修改 src/main.go
        ↓
FilesystemService 写入
        ↓
Runtime 发布变化通知
        ↓
WorkspaceEventHub 合并事件
        ↓
推送 workspace_event
        ↓
桌面端更新缓存失效状态
        ↓
刷新对应文件预览
        ↓
Git 状态重新查询
```

对于终端或外部程序修改文件，由 Watcher 触发相同的后续流程。

Git 元数据变化也需要能够触发 Git 状态失效。Watcher 不应把 `.git` 的内部文件当成普通 Explorer 文件显示，但应关注必要的 Git 元数据变化；Git 页面可见期间保留周期性校准作为兜底。

### 4.5 事件合并和缓存策略

相同路径的连续修改应该在短时间内合并，减少协议消息和重复查询。

建议初始合并窗口约 300ms，之后根据实际负载调整。

前端缓存按 `workspace_id` 隔离，不按 Session 隔离。

收到事件后：

- 目录树：刷新受影响目录。
- 当前文件预览：如果文件被修改，重新读取并保持合理的浏览位置。
- Git 状态：标记缓存失效，按需查询最新状态。
- Git Diff：当前选中文件发生变化时重新查询。
- 未展示的缓存：标记为 stale，不必全部立即加载。

Git 页面可见期间可以每 10 秒进行一次状态校准。窗口重新获得焦点、Git 页面打开和手动刷新也触发查询。

---

## 五、文件模块：Workspace Explorer

### 5.1 模块定位

文件模块负责工作区资源浏览和文件预览。

第一版只提供只读预览，不实现代码编辑器，不把文件编辑与 Agent 的文件修改权限混在一起。

### 5.2 文件树

导航区采用懒加载：

- 展开目录才调用 `file_list`。
- 按 `workspace_id + relative_path` 缓存。
- 切换 Session 不重新加载。
- 收到目录变化事件时，仅刷新受影响目录。

支持：

- 文件和目录展示。
- 隐藏文件开关。
- 文件名搜索。
- Git 状态标记。
- 目录展开与折叠。
- 当前文件选中状态。

默认隐藏 `.git` 等内部目录，但不能永久排除所有被忽略的文件。

后续提供显示被忽略文件的开关，由 Runtime 的 Git 能力计算对应忽略状态。文件树展示与 Git 状态使用同一套状态缓存。

### 5.3 文件预览

统一内容区负责展示文件内容。

| 文件类型 | 展示方式 |
|---|---|
| 源代码 | 语法高亮、行号 |
| Markdown | 渲染 / 源码切换 |
| JSON、YAML | 文本高亮 |
| 普通文本、日志 | 文本预览 |
| 图片 | 图片预览 |
| 二进制或不支持格式 | 文件信息与打开入口 |

使用现有的 Markdown、highlight.js 和图片预览能力。

大文件必须采用分段读取，不应该强制把整个文件返回前端。

`file_read` 需要逐步支持范围读取及明确的截断信息。返回数据至少应能表达：

- 文件大小。
- 文件内容或读取片段。
- 起始位置。
- 是否截断。
- 后续读取位置。
- 可获得时的总行数。
- 编码及 MIME 信息。

对于非 UTF-8 文件，给出明确空状态，不直接尝试将其当作普通文本渲染。

超过单次读取上限时，明确显示截断信息，不能把已读取行数误报为文件总行数。

图片预览也必须通过 Runtime 能力支持远程文件内容传输，不能依赖桌面端本地文件路径。

### 5.4 文件操作

文件上下文菜单支持：

- 复制相对路径。
- 插入路径到对话输入框。
- 将文件作为上下文附件。
- 在所在目录创建终端。
- 查看 Git Diff。
- 系统打开（仅 Runtime 能力支持本地打开时）。

允许将文件拖入对话输入框，转化为文件上下文附件。

原有「附加文件」入口改为打开 Explorer 的文件选择状态，并在导航区显示选择提示。

系统打开由客户端能力决定，远程工作区不得调用本机系统打开。

---

## 六、Git 模块：Workspace Git

### 6.1 模块定位

Git 模块是工作区状态观察工具。

第一版提供只读能力，不提供暂存、提交、回滚、切换分支等写操作，避免增加不必要的安全和状态复杂度。

### 6.2 Git 状态

头部显示：

- 当前分支。
- HEAD 短哈希。
- Upstream。
- Ahead / Behind。
- Detached HEAD 状态。
- Unborn 分支状态。
- Merge、Rebase 等进行中状态。

导航区分组：

```text
Changes

  Staged
    M  src/main.go
    A  src/new.go

  Unstaged
    M  README.md
    D  src/old.go
    ?  temp.txt

  Conflicts
    U  src/config.go
```

必须分别表达 Index 和 Worktree 状态。

同一文件同时存在暂存区修改和工作区修改时，不能简单地按照路径去重。

还应处理重命名、未跟踪文件、冲突、二进制文件和状态列表截断。

### 6.3 Git Diff

右侧内容区显示当前选择文件的 Diff。

支持：

- Unified Diff。
- Split Diff。
- 新增和删除行高亮。
- 行号。
- 重命名信息。
- 二进制文件提示。
- 截断提示。

窄屏优先 Unified Diff，空间足够时允许 Split Diff。

Diff 查询需要区分：

- worktree：工作区相对 Index 的差异。
- index：Index 相对 HEAD 的差异。
- untracked：未跟踪文件的新增内容。

建议单次 Diff 返回上限为 512KB，超过后明确返回截断状态。必要时支持按块或范围读取。

### 6.4 与 Explorer 联动

Explorer 文件树中的 M、A、U、D 等状态来自 GitService 的统一状态缓存。

在 Git 模式下选择文件展示 Diff。

可以从 Diff 页面跳转到 Explorer 的同一文件，查看完整文件内容。

切换模式时分别保留文件浏览状态和 Git 选择状态，不应丢失用户的导航位置。

### 6.5 Runtime 实现

参考 `git_snapshot.go` 的解析逻辑，新写到：

```text
internal/gitinfo
    ├── repository.go
    ├── status.go
    ├── diff.go
    └── parser.go
```

执行 Git 命令必须使用安全参数，不拼接未经校验的路径命令字符串。

Git 仓库根目录即使位于 Workspace 上级，也只能展示 Workspace 范围内的变更。

---

## 七、终端模块：Workspace Terminal

### 7.1 终端的资源定位

终端是 Workspace 级资源，而不是 Session 级资源。

同一个 Workspace 下的多个 Session 使用同一组工作区终端。

```text
Workspace A
    ├── Terminal 1
    ├── Terminal 2
    └── Terminal 3

Session A ──┐
Session B ──┼── Workspace A
Session C ──┘
```

切换 Session 不会关闭终端。

切换 Workspace 只是切换前端连接和展示上下文，原工作区终端可以继续运行。

隐藏 Workspace Dock、折叠 Terminal Dock 或切换 Explorer/Git，也不能影响终端进程。

### 7.2 终端资源模型

建议终端元数据：

```text
Terminal
    terminal_id
    workspace_id
    cwd
    shell
    title
    created_at
    process_state
    exit_code
    cols
    rows
    output_sequence
```

TerminalManager 统一管理对应 PTY 和进程生命周期。

终端资源由 RuntimeHost 维护，不能由 React 组件或 Session Runtime 持有。

### 7.3 前端终端内核

使用 xterm.js 作为前端渲染内核。

采用：

- `@xterm/xterm`
- `@xterm/addon-fit`

实际依赖版本在实施时选择兼容版本并锁定，不在架构设计中依赖未经验证的最新版声明。

自研的 `terminalOutput.ts` 和 `terminalKeys.ts` 不再承担终端渲染和按键编码工作。

终端输入通过 xterm 的 `onData` 发送 `terminal_input`。

终端尺寸通过 ResizeObserver 和 FitAddon 计算，再发送 `terminal_resize`。

### 7.4 TerminalHostManager

前端建立独立的 `TerminalHostManager`，与 React 组件生命周期解耦。

结构：

```text
TerminalHostManager
    ├── terminal_id_1 → xterm instance
    ├── terminal_id_2 → xterm instance
    └── terminal_id_3 → xterm instance
```

职责：

- 创建与销毁 xterm 实例。
- 将 Runtime 输出写入正确的 xterm。
- 管理实例和 DOM 容器的挂载关系。
- 处理终端切换、尺寸和焦点。
- 维护终端 UI 与 Runtime 终端 ID 的映射。

切换 Tab 或折叠终端时，不销毁 xterm 实例。

容器重新挂载后重新执行尺寸适配，并正确恢复焦点。

### 7.5 输出恢复与重连

不能只依赖前端保留输出。

Runtime 应为每个终端维护有限长度的输出缓冲，以及单调递增的输出序列号。

终端输出事件包含对应的序列信息。

前端重新连接时：

1. 提交最后接收的输出序列号。
2. Runtime 检查缓冲区是否仍覆盖缺失区间。
3. 能覆盖时返回增量输出。
4. 不能覆盖时明确返回输出缺口。
5. 前端显示恢复不完整提示，继续接收最新输出。

需要限制输出缓冲和待发送队列大小，避免长时间运行的程序造成无限内存增长。

### 7.6 进程退出

PTY 进程退出后：

- xterm 写入进程退出提示。
- 显示退出码。
- 当前 Tab 保留。
- 用户可以关闭该 Tab。

终端进程存活与终端 UI 是否展示是两个独立概念。

第一版保证在 Workspace Dock 隐藏、Session 切换、Workspace 切换和普通前端连接重新建立时，PTY 由 RuntimeHost 继续管理。

不承诺 RuntimeHost 进程本身崩溃或退出后 PTY 仍然存活。跨 Runtime 重启的终端持久化需要独立进程托管机制，暂不纳入第一版。

### 7.7 与 Agent Shell 工具的边界

必须区分：

- Shell Tool：Agent 一次性执行命令并获得结果。
- Workspace Terminal：用户可见、长期存在的交互式 PTY。

两者可以共享 Workspace 环境定位和安全边界，但默认不共享同一个终端实例。

未来如果需要 Agent 接入用户终端，应设计显式授权和终端接管机制，不应无意中耦合。

---

## 八、协议设计

协议应反映 Workspace 的资源和能力，不应该围绕前端组件设计。

### 8.0 独立的 Host 协议通道

按 3.1.1，Workspace Dock 的协议跑在 `--workspace-host` 进程的独立 JSONL 通道上，不进入会话协议：

- 信封沿用 `v: 1`。
- 语义版本使用独立常量 `HOST_PROTOCOL`，与会话协议的 `PROTOCOL`（当前 22）互不牵连。
- 握手消息 `host_init` 携带 `workspace_id`、`root`、`HOST_PROTOCOL` 和 `workspace_capabilities`；支持 `shutdown`。
- 消息统一使用 `fs_*`、`git_*`、`term_*` 前缀，避免与会话协议中语义不同的 `file_*`、`terminal_*` 混淆（例如会话协议里 `terminal_kill` 是结束进程、`terminal_close` 是移除已退出终端）。
- 沿用现有惯例：两端遇到不认识的消息或字段一律忽略并继续。

下文 8.1–8.5 均指 host 通道上的消息。

### 8.1 能力协商

`host_init` 中提供 Workspace 能力描述。

示意：

```json
{
  "workspace_capabilities": {
    "files": true,
    "file_watch": true,
    "file_range_read": true,
    "git": true,
    "terminal": true,
    "terminal_output_replay": true,
    "system_open": false
  }
}
```

协议版本和能力协商各自承担不同职责：

- 协议版本：消息结构和协议兼容性。
- 能力协商：当前 Runtime 是否支持某项具体功能。

不应只通过 `protocol_version >= N` 推断全部能力。

### 8.2 文件协议

会话协议里现有的 `file_list`/`file_read`/`file_search` 保持不变（迁移完成前供旧 FilesPanel 使用）。现状：`file_read` 读取前没有大小上限（整读后再截断预览），且拒绝非 UTF-8 文件；host 侧新写，不继承这两点。

host 新增：

- `fs_list`：一层目录清单。
- `fs_stat`：文件元数据。
- `fs_read`：带 `offset`/`limit` 的范围读取，有单次上限；返回 `size`、`truncated`、`next_offset`、`total_lines`（可获得时）、`encoding`。读取前先检查大小，不整读入内存。非 UTF-8 返回明确的状态码而不是报错。
- `fs_read_bytes`：base64 加大小上限，供图片预览等二进制内容使用。
- `fs_search`：按名字搜索。

工作区事件通过：

- `workspace_event`

推送。

### 8.3 Git 协议

新增：

- `git_status`
- `git_diff`

`git_status` 返回仓库状态、分支信息、文件状态和统计数据。

`git_diff` 按文件和差异来源返回 Diff。

所有路径使用工作区相对路径，Runtime 负责校验及 Git 仓库边界控制。

### 8.4 工作区事件协议

新增推送消息：

- `workspace_event`

要求携带：

- workspace_id
- revision
- changes
- invalidates
- reset_required

支持订阅、重新连接和状态重新同步。

### 8.5 终端协议

会话协议里现有的 `terminal_*` 保持不变（迁移完成前供旧 TerminalView 使用）。现有实现没有输出序列号和回放缓冲（flush 后即丢弃），sink 也只有一个；host 侧全部新写。

host 消息：

- `term_list`
- `term_create`
- `term_attach`（带 `from_seq`）
- `term_detach`
- `term_input`
- `term_resize`
- `term_output`（推送，带 `seq`）
- `term_kill`
- `term_close`

其中：

`term_create` 创建 PTY。

`term_attach` 连接已有终端，并可以从指定输出序列号开始恢复：缓冲能覆盖时返回增量输出，不能覆盖时明确返回 gap。

`term_detach` 解除前端连接，不结束 PTY。

`term_kill` 结束进程，保留终端条目和退出状态（对应「进程退出后 Tab 保留」）。

`term_close` 结束进程（如仍在运行）并移除终端条目。

每个终端一个环形输出缓冲（初定 1MB），发送队列有上限。

终端创建和连接不能混为一个操作，否则前端重连可能重复创建进程。

### 8.6 协议维护

当前会话协议的版本常量两侧不一致：TS 侧 `src/protocol/types.ts` 的 `PROTOCOL_VERSION = 16`，Go 侧 `internal/protocol/messages.go` 的 `PROTOCOL = 22`。前端实际已按更高版本号做门控，常量只是没跟上。它不阻塞本功能（host 通道版本独立），可顺手同步到 22 并修正 `tests/projection.test.ts` 的断言。

Host 协议第一版不做代码生成，Go 与 TS 两侧各自定义，但必须有跨语言比对测试（版本常量、消息名、字段名）保证一致。单一权威定义加代码生成另行立项。

能力兼容由初始化能力描述处理，协议版本负责必要的结构兼容。

新协议操作必须有对应的序列化、反序列化和兼容性测试。

---

## 九、状态管理与持久化

必须区分窗口状态、工作区 UI 状态、Runtime 工作区资源和 Session 状态。

| 状态类别 | 内容 | 管理方 |
|---|---|---|
| Window | Dock 开关、宽度、面板高度、上层模式 | 桌面端 |
| Workspace UI | 目录展开状态、文件选择、Git 选择、活动终端 | 桌面端 |
| Workspace Runtime | PTY、终端元数据、输出缓冲、事件 revision | Runtime |
| Session | 消息、模型状态、输入框和 Agent 执行状态 | 现有 Session 体系 |

### 9.1 Window 状态

持久化：

- Workspace Dock 是否打开。
- 当前 Explorer / Git 模式。
- 外侧栏宽度。
- 导航区宽度。
- Terminal Dock 高度。
- Terminal Dock 是否显示。
- 终端区域是否最大化。

继续使用现有 `prefs.ts` 和拖动调整组件。

### 9.2 Workspace UI 状态

按 Workspace 隔离，不按 Session 隔离。

持久化：

- 文件树目录展开状态。
- 最后选择的文件。
- 当前 Git 选择文件和 Diff 来源。
- 文件浏览和搜索状态。
- 活动终端选择。

如果支持多个桌面窗口，导航位置应允许按 `window_id + workspace_id` 独立保存，避免窗口之间互相覆盖 UI 选择状态。

前端缓存也必须使用 workspace_id 隔离。

### 9.3 Workspace Runtime 状态

Runtime 管理：

- WorkspaceContext。
- TerminalManager。
- PTY 资源。
- 输出缓冲。
- Workspace revision。
- 文件监听器。

这些状态不应写入 Session 的状态对象，也不能因 Session dispose 而被清理。

### 9.4 生命周期规则

| 操作 | 预期行为 |
|---|---|
| 收起 Workspace Dock | 仅隐藏 UI |
| 切换 Explorer / Git | 不影响终端 |
| 折叠 Terminal Dock | 终端继续运行 |
| 切换 Session | Workspace 资源保持 |
| 切换 Workspace | 前端解除旧工作区绑定，切换新工作区 |
| 关闭单个终端 | 结束对应 PTY |
| 关闭 Workspace | 明确处理关联终端和其他引用 |
| RuntimeHost 退出 | 第一版不保证 PTY 跨进程继续存活 |

关闭一个工作区的界面，不应在没有明确用户操作的情况下，意外关闭该工作区仍在运行的终端。

WorkspaceManager 应当基于明确的引用关系和关闭策略管理资源。

---

## 十、远程工作区

远程能力必须是 Workspace Runtime 架构的自然延伸，而不是文件、Git、终端分别实现一套远程逻辑。

统一结构：

```text
Desktop Workspace Dock
        │
        │ Runtime Protocol
        │
        ├── Local Runtime
        │     ├── Local Filesystem
        │     ├── Local Git
        │     └── Local PTY
        │
        └── Remote Runtime
              ├── Remote Filesystem
              ├── Remote Git
              └── Remote PTY
```

桌面端只需要知道当前连接的 Workspace 和它提供的能力。

必须坚持：

- 前端不直接读取远程文件系统。
- 前端不通过本地 SSH 自行执行 Git。
- 前端不依赖远程绝对路径。
- 文件内容通过 Runtime 协议获取。
- Git 查询由实际工作区所在的 Runtime 执行。
- 终端 PTY 创建在工作区所在环境。
- 本地系统打开等能力通过能力协商判断。

工作区路径统一由 Runtime 解释，前端传递相对路径即可。

本地和远程工作区使用相同的 Workspace Dock UI。

---

## 十一、安全边界

Workspace Services 应具有统一的安全边界。

### 11.1 文件系统

- 文件路径必须经过规范化和校验。
- 禁止通过 `..` 路径穿越。
- 必须防范符号链接指向工作区之外。
- 文件读取和目录展示不能暴露工作区之外的内容。
- 不可信的文件名不能直接拼接为系统命令。

### 11.2 Git

- Git 命令参数必须安全传递。
- 路径参数使用 `--` 和适当的 literal pathspec 处理。
- 不得将工作区之外的仓库文件暴露给 UI。
- Git 第一版只读，不引入暂存和提交权限。

### 11.3 Terminal

- 终端 cwd 必须属于允许访问的工作区范围。
- 创建终端时使用 Runtime 现有的权限、安全策略和环境约束。
- 前端不能通过伪造 workspace_id 或路径绕过工作区校验。

### 11.4 权限策略

文件列表、文件读取和 Git 查询属于只读能力，按现有低危工具策略处理。

终端执行继续使用 Runtime 现有执行权限体系，不因 Workspace Dock 的出现绕过原有的安全控制。

---

## 十二、实施计划

实施顺序按照架构依赖安排，而不是单纯按 UI 模块排列。整个功能作为增量实现（见 3.1.1）：现有会话 runtime、FilesPanel、TerminalView 在阶段 7 之前保持不动、照常可用。

依赖关系：

```text
0 ─┬─ 1 ─ 2 ─┐
   ├─ 3 ─────┤
   ├─ 4 ─────┤
   └─ 5 ─────┴─ 6a / 6b / 6c ─ 7
```

阶段 0 完成后，1、3、4、5 可并行；2 依赖 1；6a 依赖 1、2、5；6b 依赖 4、5；6c 依赖 3、5。

### 阶段 0：Workspace Host 骨架

目标：让独立于会话的工作区宿主进程跑起来，后续所有阶段都叠加在它上面。

工作内容：

1. 核实前提：桌面端工作区记录是否有稳定 id；现有 ssh2 连接能否再开一条 exec channel。
2. Go：新增 `--workspace-host` 入口和 `internal/workspace/host` 包，提供 WorkspaceContext 骨架、EventHub 空实现。
3. Go：握手 `host_init`（`workspace_id`、`root`、`HOST_PROTOCOL`、`workspace_capabilities`）和 `shutdown`。
4. Rust：新增 `WorkspaceHostRegistry`，本地 spawn、远程走 ssh2 exec channel；新增 `host_attach` / `host_send` / `host_shutdown` 命令和按 `workspace_id` 分发的事件通道。
5. 前端：`src/workspaceHost/` 下的协议类型、客户端和按 `workspace_id` 隔离的连接状态。
6. 发布：`make release` 增加 `--workspace-host` 冒烟校验（握手成功、正常退出）。

验收：

- 打开 Dock 时 host 启动并完成握手。
- 关闭会话后 host 仍在运行。
- 远程工作区的 host 运行在远端。
- 两个工作区各自一个 host，互不影响。

### 阶段 1：Filesystem Service

工作内容：

1. 实现 `fs_list`、`fs_stat`、`fs_read`（范围读取）、`fs_read_bytes`、`fs_search`（见 8.2）。
2. 路径安全复用 `tools.Workspace.SafePath`。
3. 读取前检查大小；非 UTF-8 返回明确状态码。

验收：

- 路径穿越、符号链接、Windows junction 用例全部被拒绝。
- 大文件可以分段读取，截断信息准确，不把已读行数误报为总行数。
- 二进制和图片可以按字节读取，受大小上限约束。

### 阶段 2：Watcher 与 EventHub

工作内容：

1. 技术验证：引入 `fsnotify`（pin 版本），验证 Windows（含 OneDrive 路径）与 Linux 的递归监听、inotify 上限和大目录忽略策略。
2. EventHub：300ms 合并窗口、同路径去重、工作区级单调 revision。
3. 队列溢出或 watcher 失效时推送 `reset_required`。
4. 推送 `workspace_event`；单独关注 `.git` 的 HEAD、index、refs，只让 git 缓存失效。

验收：

- 终端修改、外部程序修改、Agent 修改文件都能产生事件。
- 人为制造溢出时推送 reset，前端可以重新同步。

### 阶段 3：Terminal Manager（host 内）

工作内容：

1. 实现 `term_*` 消息（见 8.5），create 与 attach 分离。
2. 每终端环形输出缓冲（初定 1MB）、输出序列号、发送队列上限。
3. attach 按 `from_seq` 补增量，补不齐返回 gap。
4. PTY 启动与进程组清理复用 `internal/terminal` 底层；cwd 必须在工作区内，走现有执行安全策略。

验收：

- 多个终端独立运行。
- 重连不会重复创建进程。
- 缓冲范围内的输出可以完整恢复，超出范围明确返回 gap。
- 进程退出后保留退出码。

### 阶段 4：Git Service

工作内容：

1. 新写 `internal/gitinfo`（repository、status、diff、parser）。
2. `git_status`：分支、HEAD、upstream、ahead/behind、detached/unborn、merge/rebase；index 与 worktree 状态分开；处理 rename、untracked、冲突、列表截断。
3. `git_diff`：worktree / index / untracked 三种来源，单次上限 512KB，超出返回截断状态，二进制文件给提示。
4. 参数安全传递（`--` 加 literal pathspec）；仓库根在工作区上级时只返回工作区范围内的变更。

验收（真实 git 测试）：

- 同一文件同时有 staged 和 unstaged 修改时，两种状态都正确。
- 仓库位于上级目录时，工作区之外的文件不会出现。
- 冲突、rename、untracked、二进制都有对应用例。

### 阶段 5：桌面端 Dock 框架

工作内容：

1. 第四栏布局、宽度预算（对话区最小 560、Dock 最小 320、不足时改为覆盖视图）、单栏与双栏切换；偏好宽度与实际宽度分开保存。
2. 通用 splitter，用于导航区宽度和终端高度（现有 `RailDragHandle` 只支持左右两条栏）。
3. 按 `workspace_id` 隔离的 store slice，不挂在会话 bucket 上。
4. 快捷键接入 `useGlobalKeys`，处理终端聚焦时的路由，Dock 总开关改选不与 `Ctrl+B` 混淆的组合。
5. 按能力表渲染空状态。

验收：

- 窄窗口下布局按 2.2 的优先级退化。
- 切换会话不影响 Dock 状态。
- 能力缺失时显示空状态而不是报错。

### 阶段 6：三个模块 UI（可并行）

6a Explorer（依赖 1、2、5）：

- 懒加载文件树、隐藏文件开关、文件名搜索。
- 文件预览：代码高亮、Markdown、图片、二进制文件信息。
- 右键菜单、拖拽到输入框；收到事件时局部刷新。

6b Git（依赖 4、5）：

- 分组变更列表、Unified / Split Diff。
- 与 Explorer 共享状态标记，可跳转到同一文件。
- Git 页可见时每 10 秒校准，窗口聚焦和手动刷新也触发查询。

6c Terminal Dock（依赖 3、5）：

- 引入 `@xterm/xterm`、`@xterm/addon-fit`（实施时选定兼容版本并锁定）。
- TerminalHostManager，切换 Tab 或折叠时不销毁 xterm 实例。
- Tab 的新建、关闭、重命名，折叠和 Dock 内最大化。
- 重连时走 attach 和 seq 恢复，有缺口时提示。

验收：见第十三节对应场景。

### 阶段 7：迁移与清理

工作内容：

1. 「附加文件」入口（`PlusMenu`）和交付文件预览入口（`DeliverableCards`）改为使用 Explorer。
2. 删除 FilesPanel、TerminalView、`terminalOutput.ts`、`terminalKeys.ts`，以及会话 bucket 上旧的文件和终端状态。
3. 会话协议里的 `file_*`、`terminal_*` 处理器先标记为 deprecated 并保留；真正删除属于不兼容变更，需升主版本，单独决定。
4. 清理工作区栏旧入口和 `/files`、`/terminal` 命令。
5. 完成第十三节的跨模块测试和远程工作区测试。

### 版本与测试

- Go：每个交付新能力的阶段，`VERSION` 升一次次版本号；新入口、发布校验涉及 `tools/release`，所以每个阶段跑全量 `make test` 和 `make release`。
- 桌面端：版本用 `npm run version:bump` 单独升；每个阶段跑 `npm run typecheck`、`npm test`、`npm run build`。

每个阶段保留旧功能的可用性，避免新架构未完成时提前删除旧入口。

---

## 十三、跨模块验收测试

本项目的测试重点不仅是模块自身，还包括工作区资源的协同。

| 测试场景 | 预期结果 |
|---|---|
| Agent 修改文件 | Explorer、预览、Git 状态自动更新 |
| 终端修改文件 | Explorer、Git 状态自动更新 |
| 用户外部修改文件 | Watcher 感知并刷新 |
| 切换 Session | Workspace 状态和终端保持 |
| 切换 Workspace | 文件缓存、终端和选择状态严格隔离 |
| 收起 Workspace Dock | PTY 继续运行 |
| 切换 Explorer / Git | Terminal Dock 不受影响 |
| Runtime 断线重连 | 工作区状态重新校准，终端输出尽可能恢复 |
| 输出缓冲不足 | 明确提示输出缺口 |
| Git 仓库位于上级目录 | 只展示工作区范围内文件 |
| Git 暂存与未暂存同时变化 | 两种状态正确显示 |
| 远程工作区 | 文件、Git、终端均在远端执行 |
| 大文件预览 | 分段读取，不阻塞整个 UI |
| 关闭窗口或 Runtime | 按资源生命周期策略处理，不错误声称终端可跨进程恢复 |

必须增加完整端到端测试：

```text
打开 Workspace A
    ↓
创建 Terminal 1
    ↓
通过 Terminal 1 修改 src/main.go
    ↓
Explorer 感知文件变化
    ↓
Git 检测到修改
    ↓
查看 Git Diff
    ↓
切换到 Session B
    ↓
Terminal 1 继续运行
    ↓
切换回 Session A
    ↓
文件、Git、终端状态仍然正确
```

Go 侧涉及 `internal/protocol`、`internal/runtime`、WorkspaceManager、FilesystemService 和 GitService 的修改后，按项目要求执行全量 `go test ./...`。

桌面端还需要运行类型检查、构建、组件测试和协议集成测试。终端要单独增加 PTY 生命周期和前端输出恢复测试。

---

## 十四、第一版范围与暂不实现的能力

为了避免项目扩张，第一版明确限定范围。

**第一版实现：**

- Workspace Dock。
- Explorer 文件树与只读预览。
- Git 只读状态与 Diff。
- 多终端 Tab。
- xterm.js。
- Workspace 级 TerminalManager。
- Workspace Change Event。
- Runtime 能力协商。
- Workspace / Session 生命周期解耦。
- 本地和远程工作区统一使用一套架构。
- 终端连接恢复和有限输出重放。

**第一版暂不实现：**

- 文件编辑器。
- Git 暂存、提交、回滚和分支管理。
- Agent 与用户终端实例的自动共享。
- 终端在对话主区域与 Dock 之间自由移动。
- Runtime 重启后 PTY 继续运行的独立进程托管。
- 通用 Workspace 插件系统。
- 复杂的多窗口终端抢占与协作功能。

这些功能都可以建立在当前基础设施上扩展，不应该成为第一版的前置依赖。

---

## 十五、最终架构决策

本项目最终采用以下架构：

```text
RuntimeHost
│
├── WorkspaceManager
│     └── WorkspaceContext
│           ├── FilesystemService
│           ├── GitService
│           ├── TerminalManager
│           └── WorkspaceEventHub
│
└── SessionManager
      └── Session → WorkspaceContext
```

桌面端：

```text
Workspace Dock
│
├── Workspace Navigator
│     ├── Explorer
│     └── Git
│
├── Workspace Viewer
│     ├── File Preview
│     └── Git Diff
│
└── Terminal Dock
      └── TerminalHostManager
```

核心决策总结：

1. Workspace 是工作区资源的唯一归属主体。
2. WorkspaceContext 由 RuntimeHost 管理，不由 Session 管理。
3. Session 只是引用 Workspace，不拥有 Workspace。
4. 文件、Git、终端使用同一个 Workspace 身份和相对路径体系。
5. WorkspaceEventHub 统一管理变化事件与前端缓存失效。
6. Explorer 和 Git 共用 Navigator / Viewer，终端保持独立的下层区域。
7. TerminalManager 管理长期 PTY，TerminalHostManager 管理前端 xterm 实例。
8. 文件和 Git 第一版以只读为主，终端使用现有 Runtime 安全体系。
9. 本地和远程工作区通过统一 Runtime 协议提供能力。
10. 所有模块按照明确的资源生命周期和状态所有权进行设计。

**最终目标不是把文件、Git 和终端放进同一个侧栏，而是建立一套独立于 Session 的 Workspace 基础设施，并通过 Workspace Dock 将它呈现给用户。**

Workspace Services 是底层能力，Workspace Dock 是面向用户的操作界面。两者职责独立、通过稳定协议连接，未来可以在不改变核心资源模型的情况下继续扩展工作区能力。