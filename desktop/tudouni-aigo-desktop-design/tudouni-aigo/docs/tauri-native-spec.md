# tudouni-aigo · Tauri 原生层规范

> 只列「做什么 + 约束」。token 语义见 `tokens/tokens.css`，色彩/字体依据见 `design-system/tudouni-aigo/MASTER.md`。

## 1. 窗口（tauri.conf.json）

```jsonc
{
  "app": {
    "windows": [{
      "label": "main",
      "title": "tudouni-aigo",
      "width": 1280,
      "height": 800,
      "minWidth": 960,          // 低于此宽度三栏布局必崩，硬约束
      "minHeight": 600,
      "resizable": true,
      "maximizable": true,
      "decorations": false,     // 自绘标题栏（§3）
      "transparent": false,     // Windows 下透明窗口有 DWM 瑕疵，先关
      "center": true,
      "dragDropEnabled": true   // 必须为 true，名字有误导性，见下
    }]
  }
}
```

约束：
- `minWidth/minHeight` 写配置即可，不要再用 plugin-window-state 或 Rust builder 兜底。
- 初始 1280×800；不记上次位置（需要时再加 window-state 插件）。

**`dragDropEnabled` 的语义要反着读**（这一格很容易写反，写反了「插入路径」就实现不了）：

| 取值 | 谁接管 OS 拖放 | 拿得到什么 |
| --- | --- | --- |
| `true`（**默认值，本项目用这个**） | Tauri | `getCurrentWebview().onDragDropEvent()` → `{type:'drop', paths: string[]}`，**完整绝对路径**；webview 不会导航到文件 |
| `false` | 前端 HTML5 drop 事件 | 只有 `DataTransfer.files`：一个 `File` 对象，**有名字没有路径** |

所以 `false` 下「把路径插入输入框」这件事**根本做不到**：拿不到路径就没法和工作区比较，也没法交给 runtime 去解析。写成 `false` 并且没写 `onDragDropEvent` 的版本里，配置和缺失的代码互为因果——文档描述了功能、代码里没有、配置还让功能不可能实现。

`enter` / `over` 给视觉提示，`drop` 时把 `paths` 追加进草稿（用 `session.workspace` 做前缀比较），工作区外的路径**拒绝并说明理由**——一条 runtime 解析不了的路径留在句子里，看起来和成功一模一样。

## 2. DPI 缩放

- CSS 一律逻辑像素（`px`），**禁止**手写 `devicePixelRatio` 换算；Tauri/WebView2 自动处理。
- Canvas（终端渲染若用 xterm.js Canvas renderer）交给库处理，不自绘位图。
- 图标全部 SVG / 字体图标，禁止位图按钮图标。
- 验收：Windows 显示缩放 100% / 125% / 150% / 200% 各跑一遍，检查：无横向滚动条、无文字截断、终端行列不错位。

## 3. 无边框窗口 + 拖拽区

自绘标题栏（高 36px，对应 `--z-titlebar`）：

```tsx
// TitleBar.tsx
<div
  data-tauri-drag-region            // 整栏可拖拽（原生层识别，不吃事件）
  className="titlebar"
  onDoubleClick={async (e) => {
    // 双击标题栏 = 最大化/还原；data-tauri-drag-region 区域双击 Tauri 不自动处理，需手动
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    (await win.isMaximized()) ? win.unmaximize() : win.maximize();
  }}
>
  <span className="title">tudouni-aigo</span>
  <WindowControls />                // 自绘 最小化/最大化/关闭，绝对定位右侧
</div>
```

约束：
- `data-tauri-drag-region` 只加在标题栏容器；**内部所有控件单独可点**（按钮上不加该属性）。
- 窗口控制按钮：`-webkit-app-region: no-drag` 无需写（那是 Electron），Tauri 用属性边界即可；但按钮 `cursor: default` 保持系统一致。
- 关闭键 hover 用 `--destructive`；最大化/最小化 hover 用 `--bg-muted`。全部无动效或 `--motion-fast` 色变。
- 拖拽区高度计入布局：内容区 `height: calc(100vh - 36px)`，别让 webview 内容跑到标题栏底下。

## 4. 深色 / 浅色跟随系统

```ts
// useSystemTheme.ts —— 唯一主题来源，没有应用内手动切换
const mq = window.matchMedia('(prefers-color-scheme: dark)');
const apply = () =>
  document.documentElement.dataset.theme = mq.matches ? 'dark' : 'light';
mq.addEventListener('change', apply);   // 系统切换即时生效
apply();
```

约束：
- `prefers-color-scheme` 在 Tauri 下由系统驱动，无需原生 API 轮询。
- 首帧防闪烁：`index.html` 内联 `<script>` 在 React 挂载前执行上面的 `apply()`。
- CSS 只用 `[data-theme="dark|light"]` 两个值，不支持第三种状态。
- 终端 / 代码块两个模式都保持深色（`--terminal-bg`），不跟随。

## 5. 键鼠交互（键盘优先）

| 键位 | 行为 |
|---|---|
| `Ctrl/Cmd + K` | 命令面板（唯一全局入口，等价 Claude Code 的 `/`） |
| `Ctrl + \`` | 终端面板显隐 |
| `Ctrl/Cmd + B` | 侧栏显隐 |
| `Ctrl/Cmd + 1..9` | 会话/标签切换 |
| `Ctrl + W` | 关闭当前标签（最后一条需确认，不设全局退出） |
| `F5` / `Ctrl+R` | **禁用刷新**（preventDefault），刷新走菜单 `视图 → 重新加载` |

约束：
- 所有可点元素 `cursor: pointer`；可 focus 元素必须有可见 focus ring（`--focus-ring`）。
- 不用 hover-only 才出现的操作按钮；行操作至少给右键菜单兜底。

## 6. 其他原生约束

- WebView2 运行时：Tauri 2 默认引导安装，CI 打包用 `tauri build` 内置下载器（国内构建慢属正常，别改 HTTP 源）。
- 单窗口应用：不注册第二个 webview 窗口；弹层一律 DOM（--z-dialog）。
- 文件对话框、系统通知等走 `@tauri-apps/plugin-dialog` / `plugin-notification`，不手撸 Rust。
