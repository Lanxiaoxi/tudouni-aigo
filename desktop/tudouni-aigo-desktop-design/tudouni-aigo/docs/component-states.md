# tudouni-aigo · 组件状态规范

> 通用规则先读，分组件表只看差异。所有时长/缓动取自 `tokens/tokens.css` 的 `--motion-*`。

## 0. 通用规则（所有组件适用）

| 状态 | 规则 |
|---|---|
| 过渡 | 只允许 `background-color / border-color / color / opacity / transform`，时长 `--motion-fast`(120ms) 或 `--motion-base`(180ms)，缓动 `--ease-out`。入场可放宽到 `--motion-slow`(280ms)。 |
| 禁滚动动画 | 严禁 scroll-driven animation、stagger 入场编排、视差。列表加载新行直接插入，无位移动画。 |
| Hover | 底色用 `--bg-muted` 或其半透明；**禁止**阴影加深来表达 hover（阴影只用于浮层）。 |
| Active/Pressed | 背景再压深一档（dark：`brightness(0.9)`；light：`brightness(0.95)`）+ 时间缩到 `--motion-fast`。 |
| Focus-visible | 统一 `--focus-ring`（2px 间隙 + accent 环）。`:focus` 不设样式，只对 `:focus-visible` 生效，鼠标点击不出环。 |
| Disabled | `opacity: 0.4` + `cursor: not-allowed` + 不吃 hover；不置灰文字色（保持 token，靠透明度）。 |
| Loading | **不用 spinner**。处理态=原地禁用 + 按钮内文字换「操作中…」或 3 点呼吸点（`opacity` 0.4↔1，`--motion-slow` 交替）；耗时任务在状态栏显示进度文本。 |
| Tooltip | hover 延迟 400ms 出现，`--motion-fast` 淡入；键盘 focus 同样触发。 |

## 1. 按钮

高 `--control-h`(28px) / 紧凑 `--control-h-compact`(24px)，圆角 `--radius-sm`，水平内边距 `--control-pad-x`。

| 变体 | 底色 | 文字 | Hover | Active |
|---|---|---|---|---|
| Primary | `--accent` | `--fg-on-accent` | `--accent-hover` | `--accent-active` |
| Secondary | `--bg-muted` | `--fg` | 背景提深（dark 下 `--border` 15% 叠加） | brightness 下压 |
| Ghost | 透明 | `--fg-secondary` | `--bg-muted` | brightness 下压 |
| Destructive | `--destructive` | `#fff` | 亮度 -10% | 亮度 -20% |

规则：Primary 一屏最多 1 个；危险操作必须二次确认（popover 确认，不用 modal）。

## 2. 输入框 / Textarea

- 默认：1px `--border-strong` 边框、`--radius-md`、背景透明（dark）/ `--bg-secondary`（light）。
- Focus：边框换 `--accent-border`，外圈 `--focus-ring`，**禁止**边框颜色闪烁两段式动画。
- 错误：`--destructive` 边框 + 下方 `--text-caption` 错误文本（不只用颜色，带 `⚠` SVG 图标）。
- Placeholder：`--fg-faint`。

## 3. 标签页（Tab）

- 选中：底部 2px `--accent` 指示条，文字 `--fg`；未选中：`--fg-muted`。
- 切换：指示条 `transform` 位移，`--motion-base`，`--ease-standard`；内容区直接换，无淡入。
- 关闭按钮 hover 才显示（`:hover` 于 tab 本身时），`--radius-xs` 背景 `--bg-muted`。

## 4. 列表行 / 树节点（会话列表、文件树）

- 行高 `--row-h`（紧凑 `--row-h-compact`），圆角 `--radius-sm`，内边距 `6px 8px`。
- Hover：`--bg-muted`。
- Selected：`--accent-subtle` 背景 + 可选左缘 2px `--accent` 竖条；选中态 hover 背景不变。
- 行内操作按钮（重命名/删除）默认 `opacity: 0`，行 hover/focus 时 `opacity: 1`，过渡 `--motion-fast`。键盘 focus 行同样显示（绑定 `:focus-within`）。
- 拖拽排序：拖动中 `opacity: 0.6`，落点显示 1px `--accent-border` 横线，无缩放动画。

## 5. 表格（任务 / 模型 / 日志视图）

- 表头：`--text-compact` + `--fg-muted`，下边框 `--border`，`position: sticky`（`--z-sticky`）。
- 行： zebra 用 `--bg-secondary`（仅 light 模式开，dark 靠 `--border-subtle` 行线）；行 hover `--bg-muted`。
- 数值列一律 `--font-mono` 右对齐；状态列用 badge，不用裸色文字。
- 整表高度固定，内部滚动；**表头不随滚动内容动效**（天然 sticky，无动画）。

## 6. 开关 / 复选 / 单选

| 控件 | 规则 |
|---|---|
| Switch | 28×16，圆角 999；关=`--border-strong` 底 + `--bg` 滑块，开=`--accent` 底 + `#fff` 滑块；滑块只动 `transform: translateX`，`--motion-base`。 |
| Checkbox | 14×14，`--radius-xs`；选中填充 `--accent` + 白色对勾 SVG（`--motion-fast` 淡入，禁止 path 描边生长动画）。 |
| Radio | 14px 圆；选中为 6px 内圆 `scale` 0→1，`--motion-fast`。 |

## 7. Badge / 状态点

- 高 18px，`--text-caption`，圆角 `--radius-xs`，背景 `*-subtle` + 前景对应色 + 前置 6px 圆点。
- 语义映射：运行中/成功 `--success`、等待/警告 `--warning`、错误 `--destructive`、信息 `--info`、默认 `--fg-muted`。
- 状态翻转（运行中→完成）只改色，**禁止**脉冲呼吸灯动画。

## 8. 浮层（Dropdown / Popover / Context menu）

- `--bg-card` + `1px --border` + `--radius-lg` + `--shadow-overlay`。
- 打开：`opacity` + `transform: translateY(-2px)`，`--motion-base` `ease-out`；关闭：`--motion-fast` `ease-in`。
- 菜单项选中：`--accent-subtle` 背景 + `--fg`；快捷键提示右对齐 `--fg-faint`，`--font-mono`。

## 9. 对话框 / 命令面板（Ctrl+K）

- 容器 `--radius-xl` + `--shadow-modal`；遮罩 `rgba(2,6,23,0.5)`（light 0.35）。
- 打开自下而上 8px + 淡入，`--motion-base`；关闭反向 `--motion-fast`。Esc / 遮罩点击关闭。
- 命令面板输入框顶置，结果列表行规则同 §4；无结果态 `--fg-faint` 提示文案。

## 10. 终端 / Diff / 日志

- 背景固定 `--terminal-bg`（两模式一致），文字 `--font-mono` `--text-code`。
- 新行追加：直接 append，无动画；流式输出按帧 flush，不逐 token 动效。
- Diff：新增行背景 `--success-subtle` + 左侧 2px `--success` 竖条；删除行 `--destructive-subtle` + `--destructive` 竖条；行号 `--fg-faint`。
