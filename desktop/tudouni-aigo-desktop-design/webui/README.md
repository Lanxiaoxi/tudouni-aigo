# tudouni-aigo · Web UI

桌面端「协议驱动 UI」的 React 落地。依据仓内两份既有文档实现，不另立规则：

| 上游文档 | 作用 |
| --- | --- |
| `../desktop-ui-spec.md` | 功能面、消息全集、7 大分区、12 类流条目、5 类侧栏区块、2 个阻塞模态、键位 |
| `../tudouni-aigo/` | 设计系统（`MASTER.md`）、token（`tokens/`）、组件状态（`docs/component-states.md`）、Tauri 原生层（`docs/tauri-native-spec.md`） |

---

## 跑起来

```bash
npm install
npm run dev        # 开发，http://127.0.0.1:5178
npm run build      # tsc -b + vite build，产物在 dist/
npm run preview    # 预览构建产物
```

Node ≥ 20。首次 `npm install` 在 Windows 上若报 esbuild / rollup 的 EBUSY，直接再跑一次即可（已把 `@esbuild/win32-x64`、`@rollup/rollup-win32-x64-msvc` 写进 `dependencies` 规避 optional deps 丢失问题）。

---

## 目录结构

```
src/
  protocol/types.ts       消息全集类型，唯一依据 §0；改动只能对着 spec 改
  runtime/
    bus.ts                运行时接线盒（send / subscribe / dispose）
    mockRuntime.ts        按协议说话的演示运行时（脚本化整条链路）
    useRuntime.ts         ★ 接真运行时的唯一改动点
  state/
    entries.ts            会话流条目模型与归约（归属、去重、清理）
    store.ts              zustand：运行时事实 + 前端本地偏好（两组严格分开）
  components/
    chrome/               标题栏 / 顶栏 / 会话栏 / 折叠摘要 / 状态栏 / 输入框
    stream/               12 类流条目、/status 等流内块、quiet 分组
    sidebar/              5 区块
    panels/               命令面板 + 8 个面板
    modals/               审批、提问（两个阻塞模态）
    ui/                   无样式原语包装、控件、极简 Markdown 渲染器
  styles/
    tokens.css            ★ 上游 tokens.css 的原样副本，唯一真源在 ../tudouni-aigo/tokens/
    fonts.css             @fontsource 本地字体（规范要求禁 CDN）
    global.css / components.css / app.css / stream.css
  i18n/                   中英双语，文案全走 key
scripts/shot.mjs          CDP 截图 + 状态探针，用于逐界面视觉核对
```

---

## 技术选型

| 选择 | 理由 |
| --- | --- |
| React 19 + Vite 6 + TS strict | 基线。`verbatimModuleSyntax` 开，类型导入必须显式 |
| **Radix UI 无样式原语** | 只买行为和 a11y（焦点管理、Esc、`aria-*`），不买视觉。设计系统要求「Code Dark + Run Green」高度定制，Ant Design / MUI 这类自带观感的库会和 token 打架 |
| lucide-react | 纯 SVG，符合「图标不用 emoji、不引图标字体」 |
| zustand | 状态面窄，够用；避免把协议事实和本地偏好混在一起 |
| `@fontsource/*` | 等价于规范要求的「本地打包字体」，且不依赖第三方 CDN |
| 自写 Markdown 渲染器 | 只渲染规范列出的几种语法，不引第三方 md 库 |

**刻意没用的**：AntD、MUI、Tailwind、styled-components、任何 CSS-in-JS、任何 md 库、任何图表库。

---

## 接真运行时

只改 `src/runtime/useRuntime.ts` 一行：

```ts
const rt = createMockRuntime();   // ← 换成你的 Tauri command / WebSocket / stdio 桥实现
```

新实现只需满足 `src/runtime/bus.ts` 里的 `Runtime` 接口（`send` / `subscribe` / `dispose`）并遵守 `protocol/types.ts` 的消息全集。UI 层不做任何适配。

**两条硬约束**（来自 §0，实现时不要绕开）：

1. 界面上每个数字都必须来自协议消息；前端不许自己推导、不许估算。
2. 禁止乐观更新 —— 状态变更以运行时回的 `ui` / `event` 为准。

---

## 演示开关

仅供评审，不参与业务逻辑：

| 参数 | 作用 |
| --- | --- |
| `?demo=1` | 启动后自动发一条消息，把整条链路跑起来（思考流式 → 工具批次 → 审批 → 提问 → 压缩 → 回答） |
| `?auto=1` | 配合 `demo`，自动应答两个阻塞模态，一次看到全部条目形态 |

```
http://127.0.0.1:5178/?demo=1&auto=1
```

`mockRuntime.ts` 里两条约定：`/new` 用 `session_switch` 携带哨兵 id `"__new__"`；档位清单不在前端写死，走 `ui(state).efforts`。

---

## 自检

```bash
npm run typecheck
node scripts/shot.mjs <url> <out.png> <waitMs> <w> <h> <light|dark> [cdpPort] [actionJs] [postWaitMs]
```

`shot.mjs` 用 CDP 真实时序截图（**不用** virtual time，避免时序假象），并在截图前后 dump 关键状态（theme / booting / welcome / streamRows / answer / modal / sidebar / statusbar / toast），便于和图像交叉核对。

---

## 已知边界

- 无测试用例。验证手段是 `tsc -b` 零错误 + `vite build` 通过 + CDP 逐界面截图核对。
- mock 运行时是演示用的脚本化实现，不是真实执行器。
- 自绘标题栏（`data-tauri-drag-region`）只在 Tauri 宿主内生效；浏览器里点击不拖窗。
