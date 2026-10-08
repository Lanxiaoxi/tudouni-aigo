# EricAI 在桌面端的落地情况

对「桌面端能否和 TUI 一样地管理 EricAI token」的审查结果，以及**已落地的修复**。

> **状态：已实现。** 下面一~七节保留的是**修复前**的审查结论（那是判断的依据，也是
> 「为什么是这么改的」的记录），第八节写出实际改了什么、在哪儿。阅读时请把一~七当作
> 历史，把第八节当作现状。

| 项 | 值 |
|---|---|
| 审查对象 | `desktop/tudouni-aigo-desktop`（Tauri 2 + React 19）、`src-tauri/src/lib.rs`、以及 Go 侧权威实现 `internal/runtime/`、`internal/protocol/`、`cmd/tudouni/main.go` |
| 判定依据 | 源码逐文件阅读 + `go test`（`internal/runtime`、`internal/protocol` 的认证相关用例）|
| 本机环境 | **没有** EricAI 的运行环境（无 Entra 租户、无 `providers.ericai` 路由）。所有结论均为静态阅读 + 仓库内自带的 hermetic 测试，**没有**做过一次真实的设备码登录 |
| 路径约定 | 桌面端文件相对 `desktop/tudouni-aigo-desktop/`；Go 文件相对仓库根目录 |
| 严重度 | P0 = 功能在桌面端根本不可达；P1 = 可达但会误导 / 无法完成；P2 = 注释或文档与实现不符 |

**修复前的结论**：桌面端**完全没有接** EricAI 这个模块（不是行为不同，是整条链路在桌面端是断的）；
并且运行时侧还有一处**所有非终端前端共有**的缺口 —— 交互式登录的引导写进了一个被丢弃的 stderr，
所以即便给桌面端补上 `--ericai`，第一次登录仍然无法完成。

---

## 一、运行时那一半：实现完整，且有测试

`--ericai` 的链路在 Go 侧是完整的：

| 环节 | 位置 |
| --- | --- |
| 命令行开关 | `cmd/tudouni/main.go:62`（字段）、`:276`（flag 注册）、`:317`（`--help` 文案）|
| 传给谁 | TUI：`main.go:165` → `tui.Options.EricAI`（`internal/frontends/tui/tui.go:40-47`）→ `tui.go:73-74` 追加 `--ericai`；非 TUI：`main.go:378` → `runtime.Options.EricAI` |
| 会话状态 | `internal/runtime/composition.go:211-226`（`Options.EricAI` 的语义）、`:493-495`（`initAuth` + `StartupAuth`）|
| 开门检查 | `internal/runtime/auth_session.go:118` `StartupAuth()`，结果进 `init.notices`（`composition.go:1500`）|
| 每请求前检查 | `composition.go:780` `BeforeEach: runtimeValue.authCheck`（`auth_session.go:141`）|
| 401 恢复 | `composition.go:781` `OnFatal: runtimeValue.RecoverAuth`（`auth_session.go:160`），只重试一次（`recovered` 闩）|
| 装到活客户端上 | `auth_session.go:273` `installAuth` → `Chat.Install(...)`；走 `state.Load` + `routeOf` 重读路由，不是手打一个 key |
| 回合结束后的通知 | `auth_session.go:190` `DrainAuthNotices` → `internal/protocol/server.go:557-563` 发成 `notice{code:"auth"}` |
| token 流程本体 | `internal/runtime/ericai.go`：JWT `exp` 解码（`:128`）、600s 阈值（`:95`）、设备码流程（`:271`）、refresh token 存储（`:306-324`，0600）、写回只改 `providers.ericai.api_key`（`:329-362`，temp + rename）|

本机验证（网络调用被 stub，不需要真环境）：

```
go test ./internal/runtime/ ./internal/protocol/ -run "Auth|Eric|Login|Refresh|Token|Notice" -count=1
ok  github.com/Lanxiaoxi/tudouni-aigo/internal/runtime   3.177s
ok  github.com/Lanxiaoxi/tudouni-aigo/internal/protocol  0.127s
```

覆盖到的行为（`internal/runtime/auth_session_test.go`、`ericai_test.go`、`internal/protocol/auth_notice_test.go`）：
刷新后 key 落到客户端与磁盘、刷新 token 被复用（第二次运行不再开浏览器）、失败时旧 token 留在原处且
报 `warn`、不带 `--ericai` 时什么都不做、401 只恢复一次。

**这一半没有问题。**

---

## 二、P0-1 桌面端没有任何把 `--ericai` 传下去的路

子进程的命令行由 Rust 桥拼装，而它的参数集合里没有这一项：

- `src-tauri/src/lib.rs:108-118` `AttachOptions`：只有 `binary` / `workspace` / `session_id` /
  `max_steps` / `stream` / `autopilot`；
- `src-tauri/src/lib.rs:200-219` `spawn()`：据此拼 `--runtime-stdio`、`--session`、`--max-steps`、
  `--stream`、`--autopilot`，**没有 `--ericai`**；
- `src/runtime/tauri.ts:59-73` `BridgeOptions` 同样没有该字段，`:237-252` `attachRuntime` 的
  invoke 载荷也就无从带上它。

搜索确认（在 `desktop/tudouni-aigo-desktop/` 下，排除 `node_modules` / `dist` / `target`）：

- `src/**` 与 `src-tauri/src/**` 里 `ericai` **零命中**；
- `--ericai` 在 `desktop/` 全树**零命中**；
- 设计文档 `desktop/tudouni-aigo-desktop-design/desktop-app.md` 里也没有它
  （§3.2 的可选参数只列了 `--session` / `--autopilot` / `--max-steps` / `--stream`）。

**后果**：桌面端启动的运行时永远处于「不管 token」的保守分支 —— `initAuth(false)` 什么都不建，
`authCheck` 立即返回，401 按普通致命错误报。这不是「行为不同」，是**功能不存在**。

对照 TUI：`main.go:165` → `tui.go:73-74`。桌面端缺的就是这一环。

---

## 三、P1-1 交互式登录的引导在 `--runtime-stdio` 下到不了人眼（TUI 与桌面端共有）

这一条**不是桌面端独有**，是补完 P0-1 之后会立刻撞上的下一个坑。

**事实链**：

1. `internal/runtime/auth_session.go:240` 把 `Reporter` 写死成
   `func(line string) { fmt.Fprintln(os.Stderr, line) }`；
2. 在 `--runtime-stdio` 模式下，子进程的 stderr 被父进程**读走然后丢弃**：
   Go 侧 `internal/protocol/client.go:92-106`（`os.Pipe()` + `go drain(diagnostics)`）与
   `:148-153`（`io.Copy(io.Discard, reader)`）；Rust 侧 `src-tauri/src/lib.rs:294-324`
   （只在 `STDERR_RING = 200` 行的环形缓冲里留一份，供「启动失败」诊断用）；
3. 而 `internal/runtime/ericai.go:29-32` 与 `:409` 的注释声称
   「协议服务器传一个把它变成 notice 的 reporter」——**这个注入点不存在**：
   `protocol.RuntimeHooks`（`internal/protocol/serve.go:14-30`）没有 reporter 字段，
   `runtime.Options`（`composition.go:202-243`）也没有。全仓 `Reporter:` 只有那一处赋值
   （`auth_session.go:240`），唯一的使用方是 `ericai_test.go` 自己传的测试 reporter。

**具体的失败场景**（第一次登录，机器上还没有 `~/.tudouni/ericai_refreshtoken`）：

`ericDeviceCode` 会 `report.Report(...)` 四行 —— `ericai.go:277-280`：登录提示、`open: <URL>`、
`code: <USERCODE>`、有效期。这四行写进被丢弃的 stderr；
而紧接着的轮询循环（`ericai.go:282-298`）照常在 `ericTimeout`（`:122`，默认 **300s**）里等待。
屏幕上什么都不会出现，300 秒后以「the device code expired before the login finished」告终。

也就是说：**需要浏览器的第一次登录，在 TUI 和桌面端都完不成**。
`auth_session_test.go:357` 的注释其实自己承认了这一点（"a reporter this file cannot observe"）。

**唯一能看见这几行的前端是 CLI**：`main.go:378` 在同进程里装配 runtime，`os.Stderr` 就是终端，
`internal/frontends/cli/cli.go:134-160` 把 `init.notices` 按各自的 `stream` 字段打到 stderr。
TUI 补了 `--ericai` 也照样看不见 —— 它的 stderr 同样被 drain。

**桌面上还有一处「差一点就能用」**：那几行确实进了 `stderrTail`（`src/state/store.ts:103,647-652`，
`runtime://stderr` 事件 → `useRuntime.ts:47-51`），但 `StartupProblem.tsx:26` 的
`if (!problem) return null;` 决定了它只在「启动失败」时渲染。正常会话里，一个正在等你去浏览器
输入设备码的运行时，界面上没有任何东西指向它们。

---

## 四、P2 两条与实现不符的注释 / 说法

- `internal/runtime/ericai.go:46` 写「`--ericai` **和会话内的 `/ericai`**」：会话内的 `/ericai` 不存在。
  三个前端各自列出自己的命令，都没有它 —— `internal/frontends/tui/keys.go`（`/exit`…`/audit`）、
  `internal/frontends/cli/cli.go:369-454`、桌面端 `src/commands.ts`（17 项）。
  `--ericai` 是**纯启动开关**。
- `internal/runtime/ericai.go:29-32` / `:409` 关于「协议服务器传 reporter」的那段描述，
  与当前代码不符（见 P1-1）。这段注释是照着「本该有」写的，改的时候别照着它改。

---

## 五、桌面端已经具备的部分（不用改）

补 `--ericai` 之后，接收侧是现成的：

- `init.notices` 有独立字段，不会被紧随其后的 `session_load` 抹掉
  （`src/state/store.ts:673-711` 的 `handshakeNotices`，`:734` 把它重新并回流头，
  `App.tsx:137` `<Welcome notices={handshakeNotices} />`）—— 开局那条
  `[ericai] token refreshed (valid for about N min)` 能显示；
- 运行期的 `notice` 一律逐字渲染（`store.ts:927-938`），`code` 也留在条目上，
  所以 `[ericai] …` 的刷新成功（`info`）/ 失败（`warn`，`authLevel` 见 `auth_session.go:309-315`）
  在 `NoteRow` 里能区分出来；
- 文案由运行时写死（`internal/i18n/en.go:681` 的 `auth.installed` 等），桌面端只显示原文 ——
  符合「运行时写给人看的话原样显示」的既定规则，不需要 i18n 词条。

---

## 六、修复前：要补齐需要动的地方

（这一节记录的是**当时**的施工顺序，实际落地见第八节。）

按依赖顺序：

1. **（先决条件，Go 侧）把 `Reporter` 接出来**，否则交互式登录在任何分前端下都完不成：
   `protocol.RuntimeHooks` 或 `runtime.Options` 加一个报告函数，`--runtime-stdio` 下把它转成
   `notice`（`server.go:557-563` 那条既有通路就是现成的落点）。没有它，P0-1 修完只是从
   「功能不存在」变成「第一次登录卡 300 秒」。
2. **（桌面端）传参**：
   - `src-tauri/src/lib.rs`：`AttachOptions` 加字段，`spawn()` 里 `command.arg("--ericai")`；
   - `src/runtime/tauri.ts`：`BridgeOptions` 加字段，`attachRuntime` 的载荷带上它。
   **注意不要默认 `true`**：这是个要人显式决定的开关（会改用户的配置文件）。
3. **（可选）给桌面端一个可见的入口**：目前协议里没有「本会话是否纳管 token」这个字段，
   `init` 的 16 个键里没有它（`composition.go:1468-1502`）。要显示状态就得先加协议字段，
   属于更大的改动；在此之前「带上开关就生效」是唯一诚实的做法。
4. **（顺手）修 `ericai.go:46` 那条过期注释**。

版本号（按根 `AGENT.md`）：第 1 条是用户能感知的行为变化 → `VERSION` **次版本 +1**；
只改 `desktop/` 下的第 2、3 条不动 `VERSION`。本文档本身是文档，不改任何 Go 源码，
因此不动 `VERSION`。

---

## 七、已知的语义边界（不是缺陷）

- `--ericai` 是**开门时的决定**：路由在 client 建好时就固定了，中途 `/model` 切到 `ericai`
  路由**不会**把那条路由纳管（`composition.go:211-226` 的注释写明这是有意为之，理由是
  「不能靠一个配置里的名字就断定这个进程有权替换它的 token」）。
- 不复用 MSAL 的加密 token 缓存、自己实现设备码流程 —— `ericai.go:73-90` 写明是有意取舍，
  `docs/parity/parity-agent.md:229-231` 也把它记为「不算缺陷」。

---

## 八、已落地的修复

### 8.1 Go 侧：登录引导有了正经的通路

`Reporter` 从「写死 stderr」变成可注入，并且**拆成两个时机**，因为这两个时机要投递到的地方
根本不同：

| 时机 | 投递方式 | 为什么 |
|---|---|---|
| **求值**（刷新 / 安装 / 失败）| 开局无 front end → 进 `init.notices`；有 front end → 立即发 `notice` | `init.notices` 是各前端都已在渲染的现成通路 |
| **登录引导**（`open:` / `code:` / 有效期）| 同一条 `notice`（`code = auth`，`level = info`）| 它是**有时限的指令**，等回合结束再送等于送一张过期的码 |

实现点：

- `protocol.RuntimeHooks.Report func(level, text string)` —— 新增的可选钩子；
- `protocol.AuthStartup` + `protocol.StartAuth(runtime)` —— 可选接口，和 goal 那几个钩子同一种
  做法，协议层仍然不知道 token 是什么；
- `Server.reporter` —— 把一行变成 `notice{code:"auth"}`；
- `Runtime.reporter()` —— `report != nil` 就走它，否则回落 stderr（in-process 前端的正解）；
- `cmd/tudouni/main.go` 传 `Report: hooks.Report`；`cli.Run` 在 `open` 之后调 `protocol.StartAuth`。

**改掉了一处顺序错误**：`StartupAuth` 原先在 `OpenRuntime` 装配期跑，也就是 `init` 之前 ——
一次设备码登录会把整个开场三元组挡住最长 300 秒，于是前端连能显示那条码的界面都还没画出来，
码就已经过期了。现在由**知道开场是否已发出**的一方调用：`Server.emitOpening` 在发完
`init` / `session_load` / `ui(state)` 之后调 `StartAuth`（会话切换也走这里，这是对的 ——
切换会新建一个 client，它拿着当时的 key）。

**测试**（`internal/protocol/auth_notice_test.go`）：
- `TestTheCredentialCheckRunsAfterTheOpeningIsOnTheWire` —— 断言检查发生在 `init` 之后；
- `TestAMidSessionInstructionTravelsAsACredentialNotice` —— 断言引导以 `notice{code:"auth"}`
  出去，且文字没丢。

### 8.2 桌面端：开关、入口、重启

- **传参**：`AttachOptions.ericai`（Rust）→ `command.arg("--ericai")`；`BridgeOptions.ericai`
  （TS）→ invoke 载荷。默认**不**打开。
- **入口**：左侧栏底部固定行的一个按钮（`.lb-foot`，在 `.lb-scroll` 之外，所以不会被长列表
  挤掉），点开 `PanelHost` 里那个 `settings` 面板。**没有**加进命令面板 ——
  `commands.ts` 的 17 条是固定的学习顺序，测试也断言这个数字。
- **状态从哪来**：`launch: LaunchArgs`，由 `startRuntime` 在桥**接受之后**写入，记的是
  「这个子进程实际收到的 argv」。`init` 里没有这个字段，但这是前端自己动作的记录，是它真的
  有的事实 —— 也正因如此可以画。**偏好（`ericaiDefault` / `maxStepsDefault`）只作为下次开窗的
  默认值，不参与本次显示**，避免「显示了但谁都没在用」。
- **应用即重启**：`applyLaunch` → 先落偏好，再 `attachSession({workspace, ericai, maxSteps})`。
  这是被迫的：`--ericai` 决定开门时纳管哪条路由（`Options.EricAI`），`--max-steps` 在装配时
  读进 agent，两者都不是一条消息能改的。
- **什么时候禁用**：回合进行中、有阻塞模态、以及 `booting`（attach 可能正在跑，再叠一次就是
  两个子进程抢同一个 workspace）。理由是 Rust 的重启路径是**直接 kill**（`lib.rs` 的注释自己
  写着 "a restart, not a shutdown"），而中途被杀可能留下「有 tool_calls 没有 tool_result」的
  助手消息 —— 那个会话从此不可再发送。
- **确认是内联的，不是模态**：`component-states.md` 的危险操作规则要 popover；那两个协议模态
  代表「运行时卡着等人」，借用它们会连带锁死全局快捷键和侧栏。
- **不承诺 token 好坏**：面板只说「这次的 argv 带没带 `--ericai`」。token 的实际状态只有
  `notice{code:"auth"}` 这一条通路能说，面板不去替代它。

### 8.3 版本号

两侧都动了，所以两个轴各升一档（按根 `AGENT.md`）：

- `VERSION`：5.7.0 → **5.8.0**（改了 `internal/`、`cmd/`，用户可感知的行为变化 = 次版本）；
- 桌面端：0.5.0 → **0.6.0**（`package.json`、`package-lock.json` ×2、`tauri.conf.json`、
  `Cargo.toml`、`Cargo.lock`）。

### 8.4 验证

| 检查 | 结果 |
|---|---|
| `go build ./...` | 通过 |
| `go test ./internal/runtime/ ./internal/protocol/ ./internal/frontends/tui/` | 通过 |
| `go test ./...` | 除 `internal/frontends/cli`、`internal/mcp` 外全通过；这两个是 `exit status 0xffffffff`，**单独 `go test -c` 编译后直接运行都是 PASS**（AGENT.md 记载的沙箱现象，与本次改动无关）|
| `npx tsc -b` | 干净 |
| `npm test` | 92/92 |
| `npm run audit:css` | PASS |
| `cargo check` | 通过（`Finished dev profile`；PowerShell 把 cargo 的进度 stderr 误报成退出码 1）|

**没有验到的**：一次真实的设备码登录（本机没有 Entra 租户与 `providers.ericai` 路由）。所以
8.1 那条通路是靠单元测试钉住的（顺序 + 通道形状），而不是靠一次端到端的登录。这一点在真机上
第一次用之前仍然悬着。

---

## 九、补修：开关没有到达命令行（桌面端 1.1.1）

第八节把「传参」记成已修，而**它只修了一半**，症状与本次报告完全一致：设置里开着 EricAI、
重启之后能用，直到 token 过期，然后**每一条消息都是 401**。

### 9.1 事实

`attachSession`（`src/state/store.ts`）会为**没写参数的调用方**解析出记住的默认值：

```ts
const ericai = options.ericai ?? get().ericaiDefault;
const launch: LaunchArgs = { ericai, maxSteps: options.maxSteps ?? null };
```

`launch` 是「这个子进程实际收到的 argv」的记录，也就是设置面板画的那份。但紧接着递给桥的载荷是
`{ ...options, workspace }` —— **从调用方的 `options` 展开的**。于是：

| 开窗路径 | 有没有写 `ericai` | 实际命令行的结果 |
|---|---|---|
| `applyLaunch`（设置面板点「应用并重启」）| 写了 | ✅ 有 `--ericai` |
| `retrySession` | 写了（回放 `launch`）| ✅ |
| `openFirstSession`（**应用启动时**）| 没写 | ❌ 没有 |
| `openSession`（从列表打开一个会话）| 没写 | ❌ |
| `enterWorkspace`（从侧栏打开一个 workspace）| 没写 | ❌ |
| `retryStartup` | 没写 | ❌ |

**后果**：这些会话的 `auth` 是 nil（`composition.go` 的 `initAuth(false)`），`authCheck` 立即返回、
401 按普通致命错误报 —— 也就是「token 过期后一直 401，不会自己刷新」的完整解释。
**而面板照旧显示 `--ericai` 在生效**，因为 `launch` 是从默认值算出来的、不是从命令行读回来的。
这正是「记录了但没人用」的第二次出现，和 `workspace` 那次（见 `store.ts` 的注释）是同一个写法错误。

`--max-steps` 是同一形状的第二个实例，而且更彻底：`maxStepsDefault` 从来没有任何读取方，
连记录都没进 `launch`（写的是 `options.maxSteps ?? null`）。

### 9.2 为什么第八节的审查没抓到

第八节验的是「Tauri 侧有没有把 `ericai` 变成 `command.arg("--ericai")`」—— 那条映射是对的
（`lib.rs` 的 `spawn`）。丢的是**它前面一层**：前端有没有把值交给桥。审查止步于「参数集合里有
这一项」，而真正决定行为的是「每一条开窗路径都会给出这一项」。

### 9.3 修法

载荷改成从**解析后的值**构造，而不是从 `options` 展开；记录与命令行的来源因此合一。

```ts
const attach: Partial<BridgeOptions> = {
  ...options, workspace, ericai,
  ...(maxSteps === null ? {} : { maxSteps }),
};
```

注意 `ericai` 现在**总是**给出一个布尔值，所以「没人说过」这个状态在存储层不再出现。桥侧不受
影响：`AttachOptions.ericai` 是 `Option<bool>`，`None` 与 `Some(false)` 都表示「不加这个 flag」。

### 9.4 模拟验证（本机没有 EricAI 网络环境，两侧都是 hermetic）

| 套件 | 钉住的事实 |
|---|---|
| `tests/ericai-launch.test.ts`（新增，7 例）| 应用启动 / 从列表打开 / 从侧栏打开三条路径的 `runtime_attach` 载荷都带 `ericai: true`；没开时不带；`--max-steps` 同理，且显式值仍压过默认值 |
| `internal/runtime/ericai_turn_test.go`（新增，3 例）| 跑**真的模型调用**（`httptest` 端点对不认的 token 回 401）过 `agent.CallWithRetry`，用 `OpenRuntime` 装的那两个钩子：**不带 flag** 时三连turn 全部 401、零次刷新；**带 flag** 时请求在发出前就换成新 token，端点一次都没拒绝 |

`npx tsc -b` 干净，`npm test` 239/239，`go test ./internal/runtime/ ./internal/protocol/` 通过，
`cargo check` 通过。`VERSION` 不动（Go 侧只动了测试文件，按 `94930f6 Create skill_panel_test.go`
的先例）；桌面端 1.1.0 → **1.1.1**（五个文件同步）。

### 9.5 顺带发现、**未改**的一处：401 恢复的闩是 per-process，不是 per-turn

`ericAuth.recovered`（`internal/runtime/auth_session.go`）用 `CompareAndSwap(false, true)` 闩住
「这次拒绝已经用一次刷新回答过了」，**进程活多久就闩多久**。于是**一个进程一生只恢复一次 401**：
第二次真实的凭证拒绝（几小时后 token 真的失效、或又被吊销）根本不会被送去刷新。

真正兜住重试循环的是 agent 的 `recoveredFatal`，而它是**每回合清零**的，它自己的注释还写着
「跨回合存活的闩会悄悄拒绝在 token 真的过期时恢复」。两个闩的范围不一致，而这个更宽的那个既
冗余（循环本来就有界）又过宽 —— 它偏偏在「进程一开就是几天」的桌面端最咬人。

`TestARefusalIsRecoveredOnceForTheLifeOfTheProcess` 钉住了当前行为，注释里写明这是**缺陷**而不是
规则，并说明修掉之后该断言要反过来。要不要改、改成什么范围（每回合？每 N 分钟？）是设计决定，
这次没有替它决定。

