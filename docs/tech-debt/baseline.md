# store.ts / CSS 技术债治理 · 基线

> 记录时间：2026-10-21 · 项目：`desktop/tudouni-aigo-desktop`
> 方案：[store.ts / CSS 技术债治理方案]

## 0. 基线指标（阶段 0 实测）

| 指标 | 实测 | 方案中的数 |
|---|---:|---:|
| `src/state/store.ts` 行数 | **8,064** | 7,654 |
| `src/state/entries.ts` 行数 | **1,306** | — |
| `src/styles/components.css` 块数 | 591（578 条样式规则 + 13 at-rule） | 614 |
| `src/styles/stream.css` 块数 | 478（468 + 10） | 496 |
| `src/styles/app.css` 行数 | 1,833 | 1,646 |
| `src/styles/global.css` 行数 | 603 | 532 |
| `src/styles/tokens.css` 行数 | 359 | 326 |
| CSS 类名（defined） | **843** | 843 |
| CSS 类名（TSX 引用） | 689（旧审计脚本，见 §3） | — |
| 未被引用的类 | **95** | 95 |
| `tokens.css` 外颜色字面量 | **39** | 51 |
| `!important` | **13** | 13 |
| 单元测试 | **582 pass / 0 fail** | — |
| state 相关测试文件 | 6 | 6 |

方案里的行数/规则数是快照，仓库此后有提交（store.ts +410 行、CSS 规则 +38 条、
颜色字面量减少 12 处），以本表为准。**结论不变**：`store.ts` 仍然是单文件巨石，
CSS 仍然是两个 4,500+ 行的文件。

## 1. 命令基线

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | PASS |
| `npm run test` | 582 pass, 0 fail |
| `npm run test:e2e` | 需要 `<binary> <workspace>` 参数，本机无可用的 staged runtime；**未执行**（阶段 0 未能建立基线） |
| `npm run audit:css` | PASS（689 used / 843 defined / 95 unreferenced） |
| `node scripts/render-check.mjs http://127.0.0.1:5178/ 9333` | PASS，截图存于 `screenshots/baseline/{dark,light}.png` |

复现 render-check：先 `npm run dev`，再以
`chrome --headless=new --remote-debugging-port=9333` 启动一次浏览器，然后运行上述命令。

## 2. 新守卫

| 守卫 | 命令 | 当前模式 |
|---|---|---|
| 文件体积 | `npm run check:size` | fail（阈值 = 当前值，只降不升） |
| 颜色字面量 | `npm run check:tokens` | **fail**（阶段 1 已清零，直接上线） |
| 死类 | `npm run audit:css` | 现为 PASS；未引用类 40 |

阈值表在 `scripts/check-size.mjs` 的 `FILES` / `DEFAULTS`。每阶段结束把对应文件
的预算下调到新行数。

## 3. 阶段 1 记录（CSS 拆分与清理）

### 3.1 拆分方式：连续切片，而非按前缀重排

方案原文要求“按首个类名前缀分组”。实测两个 CSS 文件已经**按组件连续分段**
（components.css 58 个连续 run，stream.css 46 个），但同名前缀会重复出现
（`dialog`、`set`、`e`、`lb`……）。按前缀把规则搬进同一文件会改变规则之间的
全局顺序，而方案自己写明“顺序不变是唯一安全条件”。

因此实际做法是：**按行号切成连续切片**，每个切片是原文件的逐字节子串，
`index.css` 按原顺序 `@import`。规则总数、类名集合、层叠顺序三者都不变。

拆分结果（最大 760 行）：

```
styles/
├── index.css                    仅 @import，顺序 == 旧 main.tsx 顺序
├── tokens.css  fonts.css  global.css  app.css
├── components/  controls 717  overlays 427  palette 252  settings 408
│               tk 690  tk-workbench 385  terminal 214  config 248
│               rewind 422  workspace 760  codeintel 257
└── stream/      turn 149  e 361  blocks 467  markdown 569  inline 163
                sidebar 218  lb 682  lb-sessions 526  terminal 426
                stream 143  turn-rail 252  board 610
```

校验：拼接后与旧文件逐字符相等（忽略空白），`audit:css` 的 defined 数不变。

### 3.2 死类清理

删除 46 个未引用类、66 个声明块。删除前用三种方式交叉确认（旧审计、className
表达式扫描、模板字符串/三元分支扫描），`hljs-*`、`list`、`class_`、`function_`
保留。

**同时修正了审计脚本**：旧 `class-audit.mjs` 只认 `className="..."` 与不含
`${}` 的模板字面量，因此 `cmdk`、`e-step`、`fact-mono`、`has-deliverables`、
`progress-fill`、`st-attention` 等 11 个真实使用的类会被误判为死类——这正是
“删错类”风险的来源。新脚本解析完整 `className` 表达式（嵌套花括号、模板、
三元分支）以及 `classList.*` / `querySelector`。

修复后暴露出两个**本来就存在**的缺口，已记为基线缺口而不是悄悄删掉类名：

- `.checkbox-box`（QuestionModal 多选）没有规则；
- `.btn-danger`（CodeIntelPanel 二次确认）没有规则。

### 3.3 颜色字面量

39 → **0**。新增的固定深色层 token 集中在 `tokens.css` 的“固定深色层”段；
`--overlay-scrim` 按主题两套值（深 0.5 / 浅 0.35），并删掉了原来那条
`[data-theme='light'] .overlay-mask` 覆盖规则（token 已经承担同一件事）。
hljs 主题复用 `--term-ansi-*`，只新增 `--code-comment` / `--code-number`。
turn-rail 的遮罩用 `transparent` / `black` 关键字，不再是十六进制。

### 3.4 `!important`：13 → 13（有意保留）

- 9 条 `display: none !important` 是 `hide-b*` 响应式工具类：它们的用途就是在
  任意组件自己的 `display` 之上强制隐藏，去掉后断点行为会随组件选择器特异性变化。
- 4 条 `prefers-reduced-motion` 全局归零：`*` 的特异性低于任何类选择器，
  只有 `!important` 能保证“减弱动效”真的减弱。

方案给的 ≤3 在这里没有安全的实现方式。**不为了指标制造回归**；若将来把这 13 条
重构掉，需要同时补断点与 reduced-motion 的渲染测试。

### 3.5 阶段 1 结果

| 指标 | 前 | 后 |
|---|---:|---:|
| 最大 CSS 文件 | 4,770 | **760** |
| CSS 规则（声明块） | 1,314 | 1,248 |
| CSS 类名 | 843 | **797** |
| 未引用类 | 95 | **40** |
| 颜色字面量（tokens 外） | 39 | **0** |
| `!important` | 13 | 13（见 §3.4） |
| 测试 | 582 | **582** |
| typecheck | PASS | PASS |
| render-check | PASS | PASS |
| 截图像素差 | — | 1,296,000 中 22 px（同一处 11×2 抗锯齿区，max Δ17） |

### 3.6 需要说明的测试改动

4 个测试文件（`find`、`markdown-fence`、`markdown-image`、`stream-layout`）原本
直接 `readFileSync('src/styles/stream.css')`。拆文件后该路径不存在。新增
`tests/stream-css.ts`：从 `src/styles/index.css` 的 `@import` 列表按真实加载顺序
拼回同一个字符串。**测试断言一行未改**，只改读取来源。

## 4. 下一阶段

阶段 2：`store.ts` 只搬不改（选择器 / prefs / modalQueue / polling）。


## 4. 阶段 2–4：store.ts 拆解（8,064 → 222 行）

### 4.1 做法：先拆无状态的部分，再拆动作

每一步都是**纯搬运**，`store.ts` 用 `export *` / 显式 re-export 保持调用点不变。
顺序按“依赖从少到多”：

| 文件 | 行数 | 内容 |
|---|---:|---|
| `state/types.ts` | 949 | 全部类型与展示常量 |
| `state/storeShape.ts` | 1,246 | `AppStore` 接口（只有形状，无行为） |
| `state/prefs.ts` | 354 | 偏好读写、校验、`persistPrefs` |
| `state/modalQueue.ts` | 103 | 阻塞请求队列（纯函数） |
| `state/polling.ts` | 90 | 每会话轮询节流 |
| `state/appView.ts` | 139 | `activeRuntime` / `runtimeOf` 等读取器 |
| `state/selectors/session.ts` | 797 | 全部选择器 |
| `state/empty.ts` | 96 | 共享空值常量 |
| `state/sessionBucket.ts` | 99 | 新会话桶工厂 |
| `state/terminal.ts` | 298 | 终端尾部缓冲（纯函数） |
| `state/runtimeLanding.ts` | 235 | `ui(state)` 落地、自动展开、轮询触发 |
| `state/storeContext.ts` | 107 | `set` / `get` 与 7 个共享 helper |
| `state/slices/sessions.ts` | 802 | 会话生命周期、任务、学习 |
| `state/slices/runtime.ts` | 951 | 发送、重试、`applyRuntimeMessage` |
| `state/slices/composer.ts` | 496 | 输入框、面板、折叠、查找 |
| `state/slices/modals.ts` | 436 | 审批/提问、会话列表、刷新、文件 |
| `state/slices/terminals.ts` | 214 | 终端动作 |
| `state/slices/workspaces.ts` | 693 | 工作区、SSH、远端、配置同步 |
| `state/store.ts` | **222** | 初始状态 + 组合 + 两个 hook + 兼容导出 |

### 4.2 切片机制

原来的动作是一个 3,500 行的对象字面量，闭包里有 7 个 helper。切片不能闭包，
所以 helper 只在 `createStoreContext(set, get)` 里构造一次，作为 `ctx` 传给每个
切片；切片顶部按需解构，函数体一字未改。

```ts
export function createAppStore() {
  return create<AppStore>()((set, get) => {
    const ctx = createStoreContext(set, get);
    return { ...initialState, ...sessionsSlice(ctx), /* … */ };
  });
}
export const useApp = createAppStore();   // 仍是同一个 hook，调用点不变
```

`createAppStore()` 是测试接缝：`tests/store-factory.test.ts` 用它建两个独立
store，断言互不可见。此前只能快照/还原单例。

### 4.3 唯一的行为相关改动

`attachSession` 的占位 key 原来直接自增模块级 `startingSeq`：

```ts
startingSeq += 1;
const placeholderKey = `starting-${startingSeq}`;
```

搬出闭包后改为 `const placeholderKey = nextStartingKey()`（`state/startingSeq.ts`），
语义完全相同（单调计数器，避免同毫秒冲突），但计数器不再是 `store.ts` 的模块状态。

### 4.4 指标

| 指标 | 基线 | 现在 |
|---|---:|---:|
| `store.ts` | 8,064 | **222** |
| 最大 state 文件（非接口） | 8,064 | **951** |
| `AppStore` 接口 | 在 store.ts 内 | 1,246（独立类型文件） |
| 测试 | 582 | **584**（+2 工厂接缝） |
| typecheck / test / audit:css / check:size / check:tokens | PASS | PASS |
| render-check | PASS | PASS |
| 截图像素差 | — | 深色 22 px / 浅色 53 px（同一处抗锯齿区，max Δ8） |

### 4.5 已知取舍

- **没有把 `modalQueue` / `polling` 改成可注入实例**。它们是模块级单例，
  与之前一样；测试直接调用纯函数，不依赖顺序。
- **`prefs` 仍然在模块加载时读一次 `localStorage`**。这是原有语义（“读一次，
  变更时写回”），改成每次读会改变首屏行为。
- **`!important` 保留 13 条**（见 §3.4）。
- **`projection.test.ts`（2,892 行）未拆**：它是按行为分组的单文件测试，
  拆分只会改变 `node --test` 的报告粒度，不改善可维护性；如果要拆，应按
  “投影 / 会话 / 审批”三个主题拆，并保留同一套 fixture。

## 5. 复现

```bash
cd desktop/tudouni-aigo-desktop
npm run typecheck
npm run test
npm run audit:css
npm run check:size
node scripts/check-css-tokens.mjs --fail

# 视觉回归（需要 dev server 与 headless Chrome，见 §1）
node scripts/render-check.mjs http://127.0.0.1:5178/ 9333
```
