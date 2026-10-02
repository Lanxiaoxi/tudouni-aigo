# 桌面端 Review · Files / Terminal

对 `desktop/tudouni-aigo-desktop` 前端实现的一次代码分析与 debug，重点覆盖 `69b73b7`
（Add the workspace's files and terminals to the runtime）带进来的 **Files** 与 **Terminal**
两块，以及它们与既有交互层的接缝。

| 项 | 值 |
|---|---|
| 审查对象 | `desktop/tudouni-aigo-desktop`（Tauri 2 + React 19 + zustand 5），HEAD = `712653a` |
| 判定依据 | Go 侧权威实现 `internal/terminal/`、`internal/files/`、`internal/protocol/workspace_handlers.go`、`internal/runtime/terminal.go`；设计侧 `desktop/tudouni-aigo-desktop-design/desktop-app.md` |
| 方法 | 逐文件静态阅读 + **跑真实二进制取证**：`npm test`（137 通过）、`npm run typecheck`（干净）、`npm run audit:css`（**FAIL**）、用 `src-tauri/runtime/tudouni-aigo.exe --runtime-stdio` 在隔离工作区跑了一次 file/terminal 全流程探针、开了一个真 PTY 并回读字节、用 headless Chrome 复现并量了两个渲染问题 |
| 第二轮 | 用户报「会话进行中点最小化/最大化没反应」。这一条查出来的是**窗口外壳**的问题（P0-4 / P1-9），不是 Files/Terminal 本身的，但它由**面板与弹窗**触发，落在这份文档管的那块地界上，所以并进来。取证方式是一次 CDP 探针：往页面里塞一个假的 `__TAURI_INTERNALS__` 记录全部 IPC 调用，把 Tauri 真正注入的 `drag.js` 原样装上，然后用 **CDP 的真实鼠标事件**（不是合成 `.click()`——合成点击绕过命中测试，会报出人拿不到的成功）逐场景点 |
| 标 [实测] 的 | 是我抓到的原文或量到的数字，不是推断 |

**路径约定**：桌面端文件相对 `desktop/tudouni-aigo-desktop/`；Go 文件相对仓库根目录。
**严重度**：P0 = 让功能不可用或把人困住；P1 = 语义/能力缺失或误导；P2 = 可见的小问题或隐患。

---

## 状态总览

| 级别 | 数量 |
|---|---|
| P0 | 4 |
| P1 | 9 |
| P2 | 11 |

> P0-4 / P1-9 / P2-11 是第二轮加入的：用户报「会话进行中点最小化最大化没反应」。
> 根因落在**窗口外壳**（标题栏与遮罩的层叠、Radix 的指针锁）而不是 Files/Terminal 自身，
> 但它由**面板与弹窗**触发，正是这份文档管的那块地界，所以并进来。

**一句话结论**：终端那半边，**协议、PTY、输入编码这三层是全仓最扎实的部分**（`terminalKeys.ts`
的字节表和它的测试比我在别处见过的都硬；PTY 真的能跑起 PowerShell 并回读字节），但**从字节到
屏幕的最后一段没有做**——输出原样当文本画，于是屏幕上是转义序列的乱码，同时没有任何办法离开
终端视图。Files 那半边，运行时几乎无懈可击（拒绝、边界、artifact 都是对的），**问题全在把
`file_read` 的答案渲染到被面板盖住的正文里**：按了回车，屏幕上什么都没变。

换句话说：**这一次不是"协议照记忆写"的问题（上一份 REVIEW 的 10 条 P0 我已逐条复核，全部已修），
而是"功能接上了，但人用起来的那条路没走完"。**

---

## P0

### [ ] P0-1 终端输出把 ANSI 转义序列和裸 CR 原样当文本画 —— 屏幕上是乱码 [实测]

- **现象**：打开终端，第一屏就不是 shell 的提示符，而是一堆 `□[?9001h□[?1004h□[2J□[H`。
  `ls` 一类的彩色输出、`npm` 的进度条、`git` 的分页提示都会带出更多。
- **证据**（三层，缺一层都不足以定这条）：
  1. **运行时发的是原始 PTY 字节，不清洗**。真 PTY 探针抓到：
     ```json
     {"kind":"terminal_output","terminal_id":"term-01","data":"\u001b[?9001h\u001b[?1004h"}
     {"kind":"terminal_output","data":"\u001b[?25l\u001b[2J\u001b[m\u001b[HPS C:\\...> \u001b[1C\u001b]0;...\u0007\u001b[?25h"}
     {"kind":"terminal_output","data":"\u001b[93mecho \u001b[37mRED plain\r\n\u001b[?25h"}
     ```
     这是设计使然（`69b73b7`：输出流"不进任何别的东西"），清洗是**客户端**的活。
  2. **TUI 清，桌面端不清**。`internal/frontends/tui/terminal_attach.go:249` 的
     `terminalOutputLine` 是 `ansi.Strip` + "取最后一个 CR 之后"；桌面端对应的只有
     `src/state/store.ts:1323-1337` 的 `appendTerminalOutput`，它只做 `\r\n → \n`，
     **既不 strip 转义，也不处理裸 CR**。全仓 grep 确认：`src/` 里没有任何 ANSI 剥离代码。
  3. **浏览器把它画成可见字符**。我用 headless Chrome 按 `.term-pane` 的规则渲染了上面这串
     字节（`.tmp/ansi-probe.png`）：第 1 块是"照现在的代码"，屏幕上是
     `□[?9001h□[?1004h□[?25l□[2J□[m□[HPS C:\work> □[93mecho □[37mRED plain`；
     第 2 块是同一个字符串剥掉 ESC 之后，只剩下 `PS C:\work> echo RED plain` —— 那才是终端该有的样子。
- **裸 CR 的第二个后果**：`white-space: pre` 下 `\r` 不换行也不回行首，同一个程序反复重写一行
  （`step 1/5\rstep 2/5\r…`）会串成一行 `step 1/5step 2/5step 3/5…`（同一张探针图第 3 块）。
- **为什么测试没发现**：`tests/terminal.test.ts` 只测 `appendTerminalOutput` 的 CRLF 归一和
  分批拼接。它断言的是"字节被正确地拼起来"，不是"字节被画成了什么"——**剥离是渲染层的事，
  而渲染层在这个仓库里没有测试手段**（无 jsdom / testing-library）。这也正是 `.term-line`
  那个 CSS bug 能一起活下来的原因。
- **修法**：在 `appendTerminalOutput` 之前（或之内）加一个和 TUI 同义的纯函数：
  ```ts
  // src/runtime/ansi.ts
  /** 剥掉 CSI/OSC/SGR 与其它 ESC 序列。与 TUI 的 `ansi.Strip` 同义。 */
  export function stripAnsi(s: string): string;
  /** 一个 CR 只保留它之后的那段（终端里 CR 是"回到行首重写"）。 */
  export function collapseCarriageReturns(s: string): string;
  ```
  两个都是纯函数，正好落在 `terminal.test.ts` 能测的范围内——**这次要把测试补上**，
  输入就用我上面抓到的真实报文，断言 `stripAnsi(batch)` 里不含 `\u001b` 且以 `PS C:\` 开头。
- **验收**：在 Windows 上开一个终端，首屏是干净的 `PS C:\...>`；`grep --color` 的输出不带
  `□[[0m` 之类的残渣；跑一个带进度条的命令，屏幕上是最终的一行而不是被串起来的多行。

### [ ] P0-2 附加到终端是单向门：没有任何离开的入口，键盘还要先点一下 [实测]

- **现象**：在终端面板上按回车进入终端后，`TerminalView` 顶掉整个正文区、Composer 消失
  （`App.tsx:190`、`App.tsx:202`）。**然后没有任何按键、按钮或菜单能把人送回对话。**
- **证据**：
  - `attachTerminal(id: string | null)` 的签名允许 `null`（`store.ts:914`），但**全仓没有任何
    调用点传 null**（grep `attachTerminal` 只有两处调用，`panels.tsx:753`/`:786`，都传 `row.id`）。
    `activeTerminalId` 的唯一写入点就是 `store.ts:2696`。**出口这个东西没有实现。**
  - i18n 里躺着两条为此准备的句子却零引用：`panel.term.detach`（'Leave the terminal (it keeps
    running)'）、`panel.term.detached`。TUI 侧是有的：`internal/frontends/tui/terminal_attach.go:38`
    的 `detachKey = tea.KeyCtrlBackslash`。
  - **而"点 X 结束它"也不是出口**：终端自己退出后，`row.status !== 'running'`，标签上的关闭按钮
    `disabled`（`TerminalView.tsx:125`）。此时视图仍然挂在它上面（`App.tsx` 只看
    `attachedTerminalId !== null`），于是屏幕上是它的最后一段输出、关闭按钮是灰的、
    **没有任何按钮能按**。这不是"不便"，是死锁。
- **第二个问题，同一处**：键盘其实要先点一下才有用。
  `useGlobalKeys.ts:40` 的守卫是
  ```ts
  if (activeRuntime(s)?.activeTerminalId != null && encodeKey(e) !== '') return;
  ```
  `encodeKey({key:'a'})` 就是 `'a'`（我单独跑过 `encodeKey`），所以**附加状态下连普通字母都会命中
  这个守卫**。守卫 `return` 时**不 preventDefault**（注释说"pane 可能正要处理"），而 pane 的
  `onKeyDown` 只有拿到焦点才触发——**没有任何地方给 pane 自动加焦点**（`autoFocus` 全仓只有
  `CommandPalette.tsx:61` 一处）。结果：进入终端后敲键盘**什么都不发生**，直到你想到用鼠标点一下
  那块黑区域（`.term-pane` 有 `tabIndex={0}`，点得中才行）。
- **为什么测试没发现**：它是一条"缺少某个调用"的空洞，除非有人问"怎么出去"，静态阅读不会报错；
  `terminal.test.ts` 测的是编码表，`useGlobalKeys` 的守卫没有测试。
- **修法**（三处，缺一不可）：
  1. 给 `TerminalView` 一个显式的离开入口：标签条右侧加一个「返回对话」按钮，或让 `Tab`/`Esc`
     在**没有控制字符歧义的组合**下离开。注意 `Esc` 本身是终端字节（`\x1b`），不能抢——TUI 选
     `Ctrl+\` 正是因为"shell 不想要这个组合"。桌面端建议用 **`Ctrl+Shift+\`**（或一个明确按钮），
     并在 pane 的页脚把这句话写出来（现在页脚只说"按键逐字节发给 shell"）。
  2. **不要用 `encodeKey(e) !== ''` 当"pane 会处理"的判据**，要判 `document.activeElement` 是不是
     pane（或其子节点）。守卫的本意是"焦点在终端里时窗口别抢键"，那就按焦点判，而不是按"这个键有
     终端含义"判。
  3. `AttachedPane` 挂载时 `ref.current?.focus()`（同一个 `useEffect` 里做 size 测量），
     否则"点进来才能打字"这条隐形规则没人知道。
- **验收**：`/terminal` → 回车 → **直接就能打字**；有一处明确的"返回对话"；`vim` 里按 `Esc`
  仍然是发给 vim 的 `\x1b`；一个已经退出的终端也一定能回去。

### [ ] P0-3 Files 面板里按文件，正文落在被面板盖住的流里 —— 按了回车屏幕上什么都没变 [实测]

- **现象**：`/files` → 选中一个文件 → 回车。面板纹丝不动，没有 loading、没有错误、没有内容。
  人会以为功能坏了，然后反复按。
- **证据**：
  - `panels.tsx:629-636` 的 `open()`：目录 → `listFiles`（面板里就地刷新，对）；
    文件 → `useApp.getState().readFile(entry.path)`，**然后什么都不做**。
  - `readFile` 的答案进的是**正文**：`store.ts:2016-2024` 的 `case 'file_read'` 走
    `entries: pushBlock(current.entries, 'file', msg)`，而 `InBlock.tsx:64` 把它画在流里。
  - 而 Files 是一个 modal 覆盖层（`PanelHost` → `.dialog` + `.overlay-mask`，`z-index: var(--z-dialog)`），
    正好压在流上面。
  - 对照组就在同一个文件里：`TerminalPanel` 的 `onPick` 明确写了
    `attachTerminal(row.id); closePanel();`，注释还解释了"关掉面板才让 attach 看得见"。
    Files 的这一支漏了同一件事。
- **同一个 `pushBlock` 决定的第二个后果**：`pushBlock` 对同 kind 是**替换**语义
  （`entries.ts:909` 先 filter 掉旧的 `block === 'file'` 再追加）。所以打开第二个文件会
  **删掉第一个文件那一块**，而且位置永远跳到流尾。对 `/status` 这类"最新一份"是合理的，
  对"我刚看过 A 现在想看 B"就是静默丢数据。
- **为什么测试没发现**：`render-check.mjs` 从不喂 `file_read`；`terminal.test.ts` 测的是
  `parentPath`，不是 `open()`。而 `open()` 的分支判断是组件内部的闭包函数，没有测试入口。
- **修法**（二选一，建议都要）：
  - 最小改动：文件分支改成和 TerminalPanel 同款——`readFile(entry.path); closePanel();`，
    让"打开一个文件"和"进入一个终端"是同一个手势。
  - 更对的做法：给 Files 面板一个自己的 viewer 区域（面板下半部分），读到的内容就地显示。
    这样"浏览目录"和"读文件"是同一个面板里的两件事，不必让用户猜内容去了哪里。
    无论选哪个，`pushBlock` 对 `file` 的替换语义要改成**保留**（新的 `openFile`/追加），
    否则看第二个文件就会丢第一个。
- **验收**：在 Files 里对一个文件按回车，**当前屏幕上**出现它的内容与行数；连看两个文件，
  两个都在。

### [ ] P0-4 只要有面板或弹窗打开，窗口的最小化/最大化/关闭就全部点不动 —— 两个独立原因叠加 [实测]

- **现象**：用户原话「在一个会话的进行中点击最小化最大化居然没反应」。标题栏上那三个按钮
  看上去是好的（有 hover），点下去没有任何反应，也不报错。
- **先纠正一个直觉**：**它和"回合在跑"没有因果关系**。我单独试过"一个回合正在跑、没有任何
  覆盖层"这一格——三个按钮全部正常。真正的触发条件是**有覆盖层压在窗口上**：权限审批弹窗
  （工具要授权时弹出来，而这一步通常正发生在回合进行中），以及 `/files`、`/terminal` 这些面板。
  用户是在"会话进行中"注意到它的，于是把它归给了那次会话；但复现它只需要打开一个面板。
- **证据**（CDP 真实鼠标事件，不是合成 `.click()`）：往页面里注入一个假的 `__TAURI_INTERNALS__`
  记录全部 IPC，再逐场景点。`[]` 表示**一个窗口命令都没发出去**：

  | 场景 | `.titlebar` computed | `elementFromPoint` 命中 | 真实点击"最小化" |
  |---|---|---|---|
  | 什么都不开（基线） | `static / z=100 / pe=auto` | `path`（按钮自己） | ✅ `plugin:window\|minimize` |
  | **回合正在跑，无覆盖层** | `static / z=100 / pe=auto` | `path` | ✅ `plugin:window\|minimize` |
  | `/files` 面板打开 | `static / z=100 / pe=auto` | **`DIV.overlay-mask`** | ❌ `[]` |
  | **审批弹窗打开** | `static / z=100 / pe=none` | **`DIV.overlay-mask`** | ❌ `[]` |

- **两个互相独立的原因，缺一个都修不好**：
  1. **Radix 给 `body` 设了 `pointer-events: none`**（模态的指针锁），而 `.titlebar` 是
     `body` 的后代，**继承**了这个值 → 浏览器根本不会把点击派发给它。
    实测 `body: none` 时 `.titlebar` 也是 `none`。
  2. **`.titlebar` 是 `position: static`**，所以 `app.css:17` 那句
     `z-index: var(--z-titlebar)` **完全不生效**（`z-index` 对 static 元素无效，实测 computed
     仍报 `100`，但那是拿不到效果的值）。遮罩是 `position: fixed; z-index: var(--z-dialog)`
     （`components.css:783-786`，`--z-dialog: 500`）——画在标题栏上面。
- **逐条试出来的配方**（每个变体一个独立标签页，互不污染；都在"审批弹窗打开"这个最难的场景下）：

  | 变体 | `elementFromPoint` | 真实点击 |
  |---|---|---|
  | 原样 | `DIV.overlay-mask` | ❌ `[]` |
  | 只加 `z-index`（无 `position`） | `DIV.overlay-mask` | ❌ `[]` |
  | `position: relative` + `z-index` | `DIV.overlay-mask` | ❌ `[]`（`body` 那个 `none` 还在） |
  | 只加 `pointer-events: auto` | `DIV.overlay-mask` | ❌ `[]`（仍被遮罩盖住） |
  | **三条一起** | `path` | ✅ `plugin:window\|minimize` |

- **修法**（`app.css` 的 `.titlebar`）：
  ```css
  .titlebar {
    position: relative;          /* 没有它，下面那行的 z-index 是死值 */
    z-index: 550;                /* 必须 > --z-dialog(500)；但别到 600，那是 --z-tooltip */
    pointer-events: auto;        /* 覆盖 Radix 给 body 的 pointer-events:none */
  }
  ```
- **一个必须一起想清楚的设计判断**：让标题栏在弹窗期间可点，是**故意对"fail-closed 全屏挡住"
  开一个口子**。这是对的——窗口按钮是 OS 级的外壳动作，人必须**永远**能移动、最小化、关掉窗口；
  尤其当 runtime 卡在某个授权上时，否则连关闭按钮都按不动。而它**不削弱 fail-closed**：
  实测（修复后、弹窗仍在）点击标题栏不会把弹窗点掉——`PermissionModal` 有
  `onPointerDownOutside` / `onInteractOutside` 的 `preventDefault`（`PermissionModal.tsx:59-60`），
  "modal still open: true"。面板那一侧则是**两件事都发生**：面板关闭，同时命令发出（实测
  `["plugin:window|minimize"]` 且 `panel: null`）。
- **验收**：打开 `/files`（或让审批弹窗弹出），三个按钮**一次点击**就生效；弹窗不会因此被关掉。

---

## P1

### [ ] P1-1 `.term-line { min-height: var(--leading-code) }` 等于 `1.5px` —— 空行高度是 0 [实测]

- **证据**：`tokens.css:26` 是 `--leading-code: 1.5;`（**无单位**，是 `line-height` 的倍数），
  而 `stream.css:1427` 把它当长度用：`min-height: 1.5` → 1.5px。我在 headless Chrome 里按同样
  的 token 值量了一组 `['first','','third','']`：
  ```
  line0 h=18.8px minH=0px
  line1 h=0.0px  minH=0px     ← 空行
  line2 h=18.8px
  line3 h=0.0px                ← 空行
  ```
  （`min-height` 在 `1.5` 这种无单位值上被当作无效声明丢弃，所以显示 `0px`。）
- **后果**：终端输出里的空行**完全不可见**，而且所有后续行上移 18.8px——一张用空行排版过的表
  （`git status`、`ls` 分栏输出）会与真实终端显示的完全不是一回事。这也解释了为什么"屏幕像是
  把行挤在了一起"。
- **修法**：`min-height: calc(var(--text-code) * var(--leading-code));` 或者干脆
  `min-height: 1em`（`em` 会跟着 `font-size` 走，`.term-line` 的 font-size 继承自
  `.term-pane`）。**同时**给这一条加一个断言型测试（见附 B）。
- **验收**：`printf 'a\n\nb\n'` 的输出在面板里是 3 行、中间一行是空行。

### [ ] P1-2 上报给 shell 的 `cols`/`rows` 都算大了 —— 换行位置跑到面板右边界之外 [实测]

- **证据**：`TerminalView.tsx:189-190`
  ```ts
  const cols = Math.max(1, Math.floor(target.clientWidth / cell.width));
  const rows = Math.max(1, Math.floor(target.clientHeight / cell.height));
  ```
  `clientWidth` **包含 padding**，而 `.term-pane` 的 padding 是 `var(--space-2) var(--space-3)`
  （`stream.css:1409` → 上下 8px、左右 12px）。实测（同一个 headless 页面）：
  ```
  pane.clientWidth = 424   paddingL = 12px   paddingR = 12px
  contentBoxWidth  = 400
  cell(Consolas 12.5px) = 6.873px
  ```
  424 / 6.873 = 61.7 → 报 **61** 列；真实可用宽度 400 / 6.873 = 58.2 → 应该是 **58** 列。
  **多报 3 列**，shell 就会把换行点放在面板右边界之外；`rows` 同理多报约 1 行（16px 竖向 padding）。
  再叠加一条：面板是 `overflow: auto`（`stream.css:1408`），出现横向滚动条时 `clientHeight`
  又缩水约 15px，`rows` 再偏一行。
- **为什么这条特别刺眼**：代码注释（`TerminalView.tsx:176-186`）把这件事说得非常清楚——
  "an 8px monospace cell is a guess, and a guess that is wrong by 20% gives the shell a width that
  does not match what is on screen, which is the same failure as not resizing at all"。
  它量了 cell，**却在另一头用了包含 padding 的盒子**：错的方向不同，结果是一样的失败。
- **修法**：
  ```ts
  const cs = getComputedStyle(target);
  const innerW = target.clientWidth  - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
               - (target.offsetWidth - target.clientWidth);   // 滚动条
  const innerH = target.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const cols = Math.max(1, Math.floor(innerW / cell.width));
  const rows = Math.max(1, Math.floor(innerH / cell.height));
  ```
- **验收**：面板宽度固定时，让 shell 打印 `$Host.UI.RawUI.WindowSize`（或 `tput cols`），
  它与页脚显示的 `cols×rows` 一致；`vim` 在窗口最右侧不会出现"文字被切掉/换行错位"。

### [ ] P1-3 附加终端期间 F5 / Ctrl+R 的抑制失效 —— 误触一下整个会话就没了 [实测]

- **证据**：`useGlobalKeys.ts` 的判定顺序是
  1. **第 40 行**：终端守卫（`activeTerminalId != null && encodeKey(e) !== ''`）→ `return`
  2. **第 58 行**：刷新抑制（`e.key === 'F5' || (mod && ['r','p','f'].includes(...))`）→ `preventDefault`
  我单独跑了编码函数：`encodeKey({key:'F5'})` = `'\u001b[15~'`，`Ctrl+R` = `'\u0012'`，
  **两者都不为空**，所以第 40 行先命中、直接返回，第 58 行永远到不了。
  `F5` 一按，WebView 重载 → `attachRuntime({})` 重跑 → 桥的 restart 路径杀掉当前 child 并开一个
  **不带 `--session`** 的新会话。第 50 行那段注释把这个后果写得很清楚："One stray F5 therefore
  loses the whole transcript and any turn in flight."——**这个已被修好的坑，被终端守卫重新打开了。**
- **修法**：把刷新抑制提到终端守卫**之前**（刷新键对 shell 没有意义，不需要让给它），
  或者让守卫显式排除 `F5` / `Ctrl+R/P/F`。
- **验收**：附加终端时按 F5，界面无变化、会话不重启。（这条在 P0-2 的"焦点判断"改法下会自然
  消失，但顺序修正仍然该做——它是独立的语义错误。）

### [ ] P1-4 「新建终端」没有在途状态，连点两下就多开一个 shell；`'new'` 哨兵是死代码 [实测]

- **证据**：
  - `store.ts:2033-2044` 的 `terminal_created` 里有一行
    `terminalPending: current.terminalPending.filter((id) => id !== 'new')`——
    **`'new'` 这个哨兵从来没被写进去过**。`createTerminal`（`store.ts:2625-2640`）只构造并发送
    消息，**不写 `terminalPending`**；唯一写入者是 `killTerminal`（`store.ts:2681-2683`）。
    于是这个 filter 永远是空操作，读起来像是"创建已经有在途标记了"，实际上没有。
  - 后果：`TerminalPanel` 的「New terminal」（`panels.tsx:769`）和 `TerminalView` 的 `+`
    （`TerminalView.tsx:66`）**都没有 disabled、没有在途反馈**。连点两下 = 两条 `terminal_create`
    = **两个真实的 shell**（运行时每次 `fmt.Sprintf("term-%02d", m.next)`，`manager.go:291`）。
    而 `terminal_created` 会把视图**自动 attach 到最新那个**（`store.ts:2041`），
    所以第一个 shell 从此只在标签条里留一个 tab，人根本不知道自己开了两个。
- **修法**：`createTerminal` 里按这个模式写 `terminalPending: [...pending, 'new']`（哨兵留着是对的，
  它本来就是这个用途），`terminal_created` **失败**那条路径（`ui(terminals)` + notice，
  见 `workspace_handlers.go:114-131`）也要清掉哨兵——现在 `case 'terminals'`（`store.ts:2027`）
  只替换列表，不清 pending，所以一旦创建失败，按钮会**永久**停在"新建中"（如果按上面加了 disabled 的话）。
  同时给两个 `+` 按钮加上 `disabled={pending.includes('new')}`。
- **验收**：连点两下「New terminal」只产生一个终端；创建被拒时按钮恢复可点，并且能看到原因。

### [ ] P1-5 结束终端：标签上的 X 一键即杀，面板里要按两次 [实测]

- **证据**：同一个破坏性动作（`killTerminal`，会连整棵进程树一起收）在两处有**两种确认策略**：
  - 标签条：`TerminalView.tsx:120-128`，`onClick={() => onKill(row.id)}`，**一次点击即杀**。
  - 面板：`panels.tsx:812-830`，先 `setArmed(row.id)`，第二次才 `killTerminal`，注释写着
    "Two presses, like deleting a session: a kill takes down a whole process tree and cannot be undone."
  - 标签上那个 X 只有 20×20px（`stream.css:1371-1384`），**紧贴着 tab 主按钮**——想切 tab
    结果点到 X，正在跑的东西就没了。
- **修法**：两处用同一套。建议标签 X 也走 arming（或至少要求 `status === 'running'` 时二次确认——
  已退出的终端本来就不需要杀）。顺手把 X 的命中区做大一点。
- **验收**：在两处点 X 都需要第二次确认；误点 X 不会杀掉正在跑的命令。

### [ ] P1-6 `ui(state).terminals` 前端根本不读 —— 快照兜底这条契约在桌面端是空的 [实测]

- **证据**：运行时的设计意图写在 `internal/runtime/composition.go:1602-1608` 和
  `protocol/schema/outbound.schema.json:335` 的 doc 里："**只从 kind=terminals 的**…每个 workspace
  的 Terminal **全部**清单"，并且明确说这一路是为了"一个在 shell 创建之后才启动的前端、或者丢了
  消息的前端，从下一个快照里知道，而不是永远不知道"。TUI 确实读了
  （`internal/frontends/tui/model.go:1325`）；桌面端：
  - `src/protocol/types.ts:447` / `:615` **声明了** `terminals: TerminalRow[]`；
  - `src/runtime/adapt.ts:289-309` 的 `VmState` **没有这个字段**，
    `projectState`（`adapt.ts:592-624`）**也没有读 `msg.terminals`**；
  - `store.ts` 里 `terminals` 的写入点只有 `ui(terminals)`、`terminal_created`、`terminal_exit`
    三处（`2029`/`2040`/`2065`）。
- **实际影响比听起来小**（所以我放在 P1 而不是 P0）：`openPanel('terminal')` 会补发
  `terminal_list`（`store.ts:2382`），所以打开面板这条常规路径是自愈的。**但契约是空的**，
  而且是被声明成"存在"的那种空——这正是上一份 REVIEW 反复点出的模式（前端按理解写一层，
  测试按同一层写，于是互证通过而真实时序无人覆盖）。
- **修法**：`VmState` 加 `terminals`，`projectState` 读它，`applyStateSnapshot` 在快照到达时把
  `bucket.terminals` 更新为快照值（注意：这是**全量替换**语义，与 `terminal_created` 的追加要
  协调——建议统一成"以快照为准，事件只做即时补充"）。
- **验收**：喂一条 `ui(state)`（带 `terminals: [term-01]`）而不喂 `terminal_list`，
  断言 `bucket.terminals` 里有它。这条断言可以直接进 `tests/projection.test.ts`。

### [ ] P1-7 `filesLoading` 在拒绝路径上永不复位 —— 面板永远停在「正在读取目录…」 [实测]

- **证据**：
  - `listFiles` 先把 `filesLoading: true` 写进 bucket（`store.ts:2614`）；
  - 清它的只有 `case 'files'`（`2012`）和 `case 'file_read'`（`2022`）两个**成功**回包；
  - 运行时**拒绝**时回的是 `notice`，不是 `ui(files)`。我用探针实测：
    ```json
    {"t":"notice","level":"warn","code":"files",
     "text":"[files] could not list that directory: Path escapes workspace"}
    ```
  - 而 `case 'notice'`（`store.ts:2166`）只往 `entries` 追加一条 note，**不碰 `filesLoading`**。
  - 于是 `panels.tsx:673` 的 `{loading ? <EmptyState title={t('panel.files.loading')} />}`
    会**永远**显示「Reading the directory…」。
- **一条具体的复现路径**：打开 Files（列的是工作区根，成功）→ 在资源管理器里删掉某个目录 →
  回到面板点它 → **永久转圈**。而那句真正的解释（notice）被写进了正文流，正好被这个面板盖住。
  第 670-672 行的注释说"'正在加载'和'空的'是两句不同的话，画错会让人去找不存在的文件"——
  这条修法要补的是**第三种状态**："读失败了"，而且它现在连"失败"都没当成一个状态。
- **修法**：给 bucket 加一个 `filesProblem: string | null`（notice 的 text，verbatim），
  `case 'notice'` 里若 `msg.code === 'files'` 就置上并清 `filesLoading`；
  `listFiles` 里清掉它；面板画三态（loading / problem / entries）。
- **验收**：点一个刚被删掉的目录，面板显示运行时的原句而不是转圈。

### [ ] P1-8 端到端脚本断言 `init.protocol === 3`，实际是 4 —— 而且它没接进任何自动化 [实测]

- **证据**：我直接跑了一遍 `node tests/e2e-runtime.mjs <二进制> <工作区>`：
  ```
  opening triple: init -> session_load -> ui(state)
  FAIL: the conversation protocol is 3
  4 !== 3
  ```
  而同一个仓库里 `src/protocol/types.ts:31` 是 `export const PROTOCOL_VERSION = 4;`，
  `tests/projection.test.ts:168` 断言 `assert.equal(PROTOCOL_VERSION, 4)`。
  **两个"同一个事实"的声明，一个 3 一个 4，各自都有测试替它背书。**
  这个脚本也**没有任何自动化调用它**：`Makefile` 里没有（配方只有 `go test ./...`），
  `README.md:439` 只把它写成"手动跑一条命令"。`npm test` 也不含它。
- **为什么这条要提**：`69b73b7` 的提交信息里说这一批改动有 `tools/check-workspace-protocol.py`
  驱动**发行二进制**验 35 条事实"including a real PowerShell round trip, a resize and a kill"，
  理由写得很对——"every other test here proves a package compiles and behaves in isolation;
  this one proves the pieces are wired to each other"。**桌面端唯一等价的那个脚本，现在既过时又没人跑。**
  （我这次是用自己的临时探针补齐了这块：file_list / file_read / 拒绝 / terminal_create /
  input / resize / kill 的报文字段我全部对过，**形状是对的**——坏的是看门狗，不是产品。）
- **修法**：断言改成 `PROTOCOL_VERSION`（从 `src/protocol/types.ts` 导入，别再写字面量）；
  在 `package.json` 里加一个 `test:e2e` 脚本，并把它写进 `README` 里"发版前要跑的三件事"那一节。
  顺带给它加上 file/terminal 两个新能力的最小断言（list → read → create → resize → kill）。
- **验收**：`node tests/e2e-runtime.mjs <exe> <ws>` 退出码 0，并且它出现在某个"必需"的清单里
  而不是"可选"的一段话里。

### [ ] P1-9 双击标题栏等于两个 toggle，净零 —— 注释里那句"Tauri 不会自己最大化"对钉住的版本是错的 [实测]

- **现象**：双击标题栏"也没反应"。它和 P0-4 是**两个不同的 bug**，修好 P0-4 之后这个还在
  （我的修复变体实验里，双击那格的输出始终是净零）。
- **证据**：`TitleBar.tsx:10` 的注释写着 "Double-clicking the drag region does not maximize by
  itself in Tauri, so it is handled here"，`TitleBar.tsx:70-78` 于是自己实现了 `onDoubleClick`。
  **但锁定的 Tauri 2.12.0 自己就会做这件事**：`tauri-2.12.0/src/window/plugin.rs:243` 用
  `js_init_script` 注入 `scripts/drag.js`，而它里面是
  ```js
  const cmd = e.detail === 2 ? 'internal_toggle_maximize' : 'start_dragging'
  ```
  于是**两边同时响应**。实测真实双击标题文字：
  ```
  ["start_dragging", "internal_toggle_maximize", "toggle_maximize"]   →  maximized: false
  ```
  一次开、一次关，**净零**。对照：单击最大化按钮只有一次 `toggle_maximize`，`maximized: true`，正常。
  （双击最大化**按钮**则是三次 `toggle_maximize`——按钮不是 drag region，但 `onDoubleClick`
  挂在容器上会收到冒泡，所以是"两次点击 + 一次容器 dblclick"。这条我实测过，但按钮上的双击
  本来就不是常规手势，列出来只为说明这个 handler 的作用域是整条标题栏。）
- **修法**：删掉 `TitleBar.tsx:70-78` 的 `onDoubleClick` 和 `TitleBar.tsx:10` 那段已经过时的注释，
  把双击交给 Tauri 自己的脚本。
- **验收**：双击标题栏，`maximized` 真的翻转（只发一个 `internal_toggle_maximize`）。

---

## P2

| # | 位置 | 问题 | 备注 |
|---|---|---|---|
| 1 | `store.ts:1375-1382` `terminalExitText` | 在 store 里拼英文字符串，绕开 i18n 表 | 同一个文件的口径（`ComposerNotice`、`StartupNotice`）是"store 只存 code，句子在 i18n"。这里破了例，而且句型还带 `Terminal ${id}` 这种拼装 |
| 2 | `store.ts:2071-2079` | 终端退出只写进正文流，而附加状态下正文流被替换掉了 | 也就是说：**杀掉你正在看的那个终端，唯一那条通报你看不见**。要么同时给面板/页脚一个就地提示，要么让通知走一个常驻槽位（像 composer 的 notice 那样） |
| 3 | `store.ts:1332-1336` | 超过 `TERMINAL_SCROLLBACK = 4000` 行时静默丢弃最老的部分 | `panel.term.dropped`（'Earlier output scrolled out of this buffer.'）这条句子**零引用**——它本来就是为这一刻写的。日志被截断而没有任何提示，人会以为自己看的是完整输出 |
| 4 | `i18n/index.ts:355-371`、`344-354` | 6 个死 key：`panel.term.attach`、`panel.term.detach`、`panel.term.detached`、`panel.term.dropped`、`panel.files.dir`、`panel.files.failed` | 其中 `detach`/`detached` 对应 P0-2 缺的那个功能，`dropped` 对应上一条。剩下 `files.dir`/`files.failed` 是没接线 |
| 5 | `panels.tsx:724` vs `runtime/paste.ts:404` | `formatBytes` **两份实现、两套输出** | panels 版 `1.5 KB`（带空格、toFixed）；paste 版 `1.5MB`（无空格、KB 用 floor）。paste 版自己的注释写着"同一个文件不该在一句话里是 1.5MB、另一句里是 1536KB"——它防的是跨句不一致，而现在是**跨文件不一致**：Files 面板和粘贴提示会同时出现在一个屏幕上 |
| 6 | `TerminalView.tsx:238-244` | 最多 4000 个 `.term-line`，每次输出都全量 reconcile，没有窗口化/`content-visibility` | 同一个仓库已经为正文流量过这件事：`app.css:295-346` 记录 "14.0ms → 1.2ms，93% 的开销是 322 行的布局"，并用 `content-visibility: auto` 解决。终端面板没有做同样的处理，所以**同一个类别的性能问题在新界面上原样重生**。另外 `key={i}` 在数组从头部截断时会让**每一行**的 key 错位，触发整片文本重写 |
| 7 | `store.ts:2030`、`createSessionBucket:527` | `terminalOutput` 只增不减，终端结束后 4000 行的缓冲仍留在 map 里 | 一长会话开十几个终端就是十几份 4000 行常驻。终端的**行**故意保留（"它回答'我刚才在跑什么'"），但**输出**没必要为已结束的终端一直留着 |
| 8 | `WorkspaceSidebar.tsx:242` + `scripts/class-audit.mjs` | `npm run audit:css` **FAIL**：`.lb-empty-add` 没有对应规则 | 这个脚本的存在理由就是"窗口按钮没有任何规则在管"那一次的教训（README 里记着）。现在它是红的，而 `npm run build`（`scripts/build.mjs`）只跑 `tsc -b` + `vite build`，**不含它**。要么修好让它绿，要么把它接进 build，别让它停在"存在但没人看"的状态 |
| 9 | `PanelShell.tsx:87-93` + `useListKeys.ts:88-118` | 一次 `Enter` 会同时触发 `PanelRow` 的 `onKeyDown` 和 window 上的 `useListKeys`，**同一次按键派发两次** | 对 Files/Terminal 是重复请求（`file_list` 发两遍、`attachTerminal` 调两遍，都幂等，所以没人发现）；对 `ResumePanel`（`panels.tsx:228` `openSession`）是两次 `session_switch`。建议 `PanelRow` 里 `stopPropagation`，或者干脆去掉 `PanelRow` 的键盘处理、只留 `useListKeys` 一条路 |
| 10 | `TerminalView.tsx:172-200` | 字号测量只在挂载时做一次；`ResizeObserver` 只在**尺寸**变化时回调 | 终端面板在 JetBrains Mono 的 webfont 到位之前挂载的话，量到的 cell 是回退字体（Consolas 6.873px）的宽度，此后字体换成 JetBrains Mono（更宽）也不会重测——`cols` 就一直偏大。**机制成立，实际是否触发取决于字体加载时序，我没有实测**，所以列在这里而不是上面。修法是加 `document.fonts.ready.then(measure)`，一行的事 |
| 11 | `components.css:783-786` + `tokens.css:72-76` | 遮罩 `.overlay-mask` 用 `--z-dialog`(500)，而标题栏声明的是 `--z-titlebar`(100) | 这两个 token 的**语义重复**：`--z-titlebar` 就是"标题栏该在的位置"，但它躺在每条弹层规则下面，且因为 `position: static` 从来没生效过（见 P0-4）。修 P0-4 时要么把标题栏提到 500 以上并把这个 token 的用途写清楚，要么在 token 表里给"永远最外层的窗口外壳"单开一档（600 已被 `--z-tooltip` 占了，需要重排）。**别只改一处数字**——那样下一个人还会照着 `--z-titlebar` 的语义把它改回 100 |

---

## 附 A · 这次跑过的东西

```powershell
# 1) 前端自己的三道闸
npm run typecheck     # 干净
npm test              # 137/137 通过（含 terminal.test.ts 24 条）
npm run audit:css     # FAIL: .lb-empty-add used with no CSS rule   ← P2-8

# 2) 端到端（唯一一次拿真二进制跑前端解码器）
node tests/e2e-runtime.mjs <repo>/desktop/tudouni-aigo-desktop/src-tauri/runtime/tudouni-aigo.exe <tmp-ws>
# → FAIL: the conversation protocol is 3 / 4 !== 3                    ← P1-8

# 3) 我自己的临时探针（.tmp/，未提交）：串起 file_list/file_read/terminal_* 并把报文原样打出来
node .tmp/probe-workspace-probe.mjs <exe> <tmp-ws>
# 抓到：init.protocol=4；ui(state).terminals=[];
#       file_list → {"path":"","entries":[{".tudouni"...},{"sub"..."},{"hello.txt",33}]}
#       file_read → {chars:31,bytes:33,total_lines:3,truncated:false,artifact_id:"art_4df7b0544bd6"}
#       拒绝 → {"t":"notice","code":"files","text":"[files] could not read that file: not a file: .tudouni (use file_list for a directory)"}
#       拒绝 → {"t":"notice","code":"files","text":"[files] could not list that directory: Path escapes workspace"}
#       terminal_create → {"id":"term-01","shell":"powershell","status":"running","cols":80,"rows":24,"exit_code":null}
#       terminal_output 带 ESC/CR（见 P0-1）
#       terminal_resize 100x30 → 列表里 cols/rows 确实变成 100/30
#       terminal_kill → {"reason":"killed","exit_code":null,"terminal":{...status:"killed"}}

# 4) headless Chrome 复现渲染问题
.tmp/ansi-probe.html   → 截图：ANSI 未剥离时屏幕上是 □[?9001h□[?1004h□[2J…（P0-1）
.tmp/measure.html      → term-line 空行 h=0.0px / 非空 18.8px（P1-1）；
                         clientWidth=424 含 padding 24px，cell=6.873px（P1-2）

# 5) 窗口按钮那一条（P0-4 / P1-9）：CDP 探针，塞一个假的 __TAURI_INTERNALS__ 记录全部 IPC，
#    把 Tauri 真正注入的 drag.js 原样装上（从钉住的 tauri crate 里读出来、替换 os_name），
#    然后用 **CDP 的真实鼠标事件** 逐场景点。合成 .click() 会绕过命中测试、报出人拿不到的成功，
#    所以这个方法本身是结论的一部分——第一版探针用合成点击，把"面板开着时按钮已死"测成了通过。
$drag = "$env:USERPROFILE\.cargo\registry\src\index.crates.io-1949cf8c6b5b557f\tauri-2.12.0\src\window\scripts\drag.js"
node .tmp/probe-titlebar-*.mjs "http://127.0.0.1:5178/" 9333 "$drag"
# 抓到：什么都不开 → ["plugin:window|minimize"] ✅
#       回合在跑、无覆盖层 → ["plugin:window|minimize"] ✅   ← 和"会话进行中"无关
#       /files 面板打开 → [] ❌   elementFromPoint = DIV.overlay-mask
#       审批弹窗打开 → [] ❌     elementFromPoint = DIV.overlay-mask，body/titlebar pe=none
#       双击标题文字 → ["start_dragging","internal_toggle_maximize","toggle_maximize"] → maximized:false（净零）
# 修复配方逐条试（每变体一个独立标签页，防样式泄漏）：
#       z-index 单加 ❌ / position+z-index ❌ / pointer-events 单加 ❌
#       position:relative + z-index:550 + pointer-events:auto ✅（弹窗仍开着，点标题栏不会关掉它）
```

**结论**：运行时的 file/terminal 能力、协议的字段形状、`terminalKeys.ts` 的字节表——
**这三块经实测是对的**，可以放心。上面 24 条里，没有一条是"协议写错了"。
第二轮的窗口那三条也不是——它是**前端层叠与命中测试**的问题，和协议无关。

---

## 附 B · 建议补的断言（按性价比排序）

1. **ANSI 与 CR 的剥离**（P0-1）：纯函数，输入直接用附 A 抓到的真实 batch，
   断言 `stripAnsi(batch)` 不含 `\u001b`，且 `collapseCarriageReturns('a\rb') === 'b'`。
   进 `tests/terminal.test.ts`——它已经有一半的机器在那里了。
2. **空行高度**（P1-1）：`stream-layout.test.ts` 已经开了"读 `app.css` 当文本断言"的先例
   （那里的理由正是"这个声明在 Node 里没有行为可观察，而被保护的是它的存在"）。
   `.term-line` 的 `min-height` 可以照同一模式钉住：断言它**不是**裸的 `var(--leading-code)`。
3. **`ui(state).terminals` 进 bucket**（P1-6）：喂一条快照，断言 `bucket.terminals` 非空。
   进 `projection.test.ts`。
4. **拒绝路径复位 `filesLoading`**（P1-7）：喂 `notice{code:'files'}`，断言 `filesLoading === false`
   且 `filesProblem` 非空。进 `projection.test.ts`。
5. **`init.protocol` 与前端常量同源**（P1-8）：e2e 脚本里改成导入 `PROTOCOL_VERSION`，
   或者反过来断言 `assert.equal(init.protocol, PROTOCOL_VERSION)`——**任何一处再写字面量
   都会重现今天这个 3 vs 4**。
6. **窗口按钮在有覆盖层时仍然可点**（P0-4）：这一条**只能靠 CDP 真实鼠标事件测**，
   因为纯 DOM 断言看不到它——`document.elementFromPoint` 能给出信号
   （打开一个面板后断言它落在 `.wc` 上、而不是 `.overlay-mask`），但"点击真的发出 IPC"
   需要一个假的 `__TAURI_INTERNALS__` 来记录。探针我这次写过了（附 A 第 5 段），值得落库成
   `scripts/window-controls-check.mjs`：**它是这份文档里最容易悄悄回归的一条**——
   动任何一处弹层的 `z-index` 都会把它打回去，而页面上看不出任何异常，只是按钮又没反应了。
7. **双击标题栏只发一个 toggle**（P1-9）：同上一并测，断言真实双击后 `maximized` 真的翻转，
   而不是"发了两个命令、回到了原点"。

> 最后一句给下一次改这里的人：**这一批的两个新面板都没有组件级测试，而它们的所有缺陷都在
> 从字节到屏幕那一段。** 仓库已经为"看不见的失败"付过两次学费（正文流的 CSS、窗口按钮的类名），
> 解决办法都不是"更仔细地读代码"，而是把这些事实变成能自动跑出来的断言——上面 7 条是这条路的第一段。
>
> 第二轮又添了一个同类教训：**窗口按钮那一条，用合成 `.click()` 会被测成"通过"**。
> 我的第一版探针就是这么写的，输出看起来一切正常；换成 CDP 的真实鼠标事件之后才看见
> `elementFromPoint` 命中 `overlay-mask`、命令一个都没发出去。**凡是要验证"人能不能点到"，
> 就不能用绕过命中测试的办法去测。**
