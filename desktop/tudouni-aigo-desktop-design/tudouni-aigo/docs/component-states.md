# tudouni-aigo · 组件状态规范

> 通用规则先读，分组件表只看差异。所有时长/缓动取自 `tokens/tokens.css` 的 `--motion-*`。

## 0. 通用规则（所有组件适用）

| 状态 | 规则 |
|---|---|
| 过渡 | 只允许 `background-color / border-color / color / opacity / transform`，时长 `--motion-fast`(120ms) 或 `--motion-base`(180ms)，缓动 `--ease-out`。入场可放宽到 `--motion-slow`(280ms)。 |
| 禁滚动动画 | 严禁 scroll-driven animation、stagger 入场编排、视差。列表加载新行直接插入，无位移动画。 |
| 尺寸过渡 | **默认禁止** `width/height` 等布局属性——见下方「§0.1 唯一的例外」。 |

### 0.1 唯一的例外：收起 / 展开

「只允许那五个属性」这条规则有个绕不过去的缺口：**侧栏收起、区块展开这类交互，其本身就是一次尺寸变化**。用 `transform: scaleX(0)` 去伪装会让里面的文字被压扁，而 `clip-path` 又无法让邻居补位——那正是这个交互要表达的东西。所以这一类允许动 `width` / `grid-template-rows`，条件是同时满足下面全部四条：

1. **由一次点击触发，不是由滚动触发。** 禁令的本意是「动画不得与用户自己的滚动位置争抢」（滚动驱动动画、位移动画、视差破坏的都是这个）。点击式收起没有这个冲突——是用户要求它动的。
2. **只动这一个属性，`--motion-base` 一次到位。** 不是循环、不是随内容长度变化。列表新增行仍然**禁止**位移动画（§0 第二行照旧生效）。
3. **被折叠的容器不卸载，只把尺寸压到零。** 条件渲染（`{open ? <Body/> : null}`）的元素在帧与帧之间凭空出现，**没有任何东西可插值**——动画会变成静默的空操作，而两端状态看起来完全一样，所以没人会发现。因此折叠一律用一直挂载 + `.collapse` / `.app-rail` 包装层。
4. **折叠中的内容必须 `inert`。** 它还在 DOM 里，所以不加 `inert` 的话 Tab 键会走进一个看不见的区域；用 `aria-hidden` 则会踩「aria-hidden 里含可聚焦元素」这条无障碍违规。`inert` 同时移出无障碍树和 tab 序列，这才是「已折叠」的实际含义。

实测数值（`render-check.mjs` 断言）：侧栏 `244px → 0`、区块 `61px → 0`，折叠后内部行数**不变**（证明是压缩而非卸载），`inert` 由 `false → true`。

> 上面两条实现细节都不是可选的：把侧栏宽度写成 `max-content` 再过渡到 `0`，因为**内在关键字与长度之间不可插值**，收起会直接跳变；这是本仓库实际踩过的坑，所以宽度两侧都是 `px`（`var(--rail-w)`）。
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

### 7.1 会话行的状态点（`lb-dot`）

左栏每个会话行最左那个 6px 圆点。它回答的是"**这个会话现在要不要我**"——多个会话并行时，这是你在看别处唯一能知道有没有东西在等你的地方。

| 状态 | 颜色 | 含义 |
|---|---|---|
| `asking` | `--warning` | 等你操作：有待答的审批或提问 |
| `broken` | `--destructive` | 坏了：模型错误，或子进程死了且不是你关的 |
| `running` | `--success` | 正在跑 |
| `unseen` | `--info` | 停下来了，而你还没看过 |
| `idle` | **不画点** | 空闲，或从没说过话 |

四条规矩，每条都对应一种"看起来正常但已经错了"的失败：

1. **颜色不是唯一信号。** 每个点必须带 `aria-label` / `title` 说明它是什么。`--success` 与 `--destructive` 在浅色下是 `#16A34A` / `#DC2626`，不是一个该让人靠眼睛分开的组合。
2. **不呼吸。** 本节上面那条禁令在这里比在状态栏更要紧：状态栏那个 `is-working` 呼吸点有专门理由（"有回合在飞"是持续状态，不是状态翻转），而左栏同时三四个点在闪既推翻那个理由、又把注意力从对话上拉走。
3. **空闲不画。** 五十个灰点读起来像"全都没事"，其实什么都没说。
4. **没有进程就不画。** 只在磁盘上存在、没有子进程的会话读不出状态——这不是限制，是事实。

**`unseen` 不是"未读消息"**，它只有一个来源：回合结束时该会话**不在屏幕上**。切过去就清掉，且**不持久化**——"你还没看过这条"不是一个能活过重启的事实。

**工作区行上的数字角标**（`lb-attention`）是同一个答案在更粗粒度上的说法：那个工作区里有几个会话处于 `asking` / `broken` / `unseen`。它存在的理由是点做不到的事——**你看不见的工作区里的点是看不见的**。跑着的会话不计入：它们不需要任何东西。

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
