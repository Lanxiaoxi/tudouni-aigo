# 全 Go 重写：事项与约束

## 一、事项

**TUI 与 runtime 全部用 Go 重写，不再保留 Python。**

| 项 | 内容 |
|---|---|
| 作废 | 61,459 行 / 213 个文件 |
| ── 源码 | 35,118 行（`agent_runtime/`，其中 TUI 占 7,958） |
| ── 测试 | 23,988 行（`tests/`，124 个文件） |
| ── 脚本 | 2,353 行（`scripts/`） |
| 不再出现 | PyInstaller、CPython 运行时、`_internal/`、`.pyd` |
| 产物 | 单个静态二进制，8–15 MB，零运行时依赖 |
| 构建 | `go build`；`GOOS` / `GOARCH` 交叉编译出全平台 |

---

## 二、约束

### 本次定的

| # | 约束 |
|---|---|
| 1 | **协议边界保留。** `protocol/` 不删，改为 Go interface（`Channels`：Emit / Ask / Question），不许融进进程内直调 |
| 2 | **边界必须可替换。** 进程内实现只是其中一种；将来能换 WebSocket / stdio，`Runtime` 不知道对面是谁 |
| 3 | **不设中间态。** 不存在「先 TUI 换 Go、runtime 留 Python」这个阶段 —— 那一段的基建在全 Go 之后全部作废 |

### 继承的（重写后仍须成立）

| # | 约束 | 出处 |
|---|---|---|
| 4 | 前端不许 import runtime 内部 | 决策 18 |
| 5 | 协议形状的权威在 `protocol/schema/*.json`，客户端类型由它生成 | 决策 21 |
| 6 | `Runtime` 只接受 channels、不创建 —— attach 之前不可能收到请求 | 决策 22 |
| 7 | 三层结构 frontends / runtime / tools，前端层只依赖 protocol | 架构宪法 |
| 8 | 四类文件随代码走：`prompts/`、`config.example.json`、`protocol/schema/`、`tools/vendor/rg/`。缺一个就是「能启动、少一个功能」 | `tests/test_packaging.py` |
| 9 | 权限层 fail-closed；路径隔离用 `resolve()` + `parents` 比对 | `security/` |
| 10 | 会话与审计是 JSONL **追加式**落盘，写放大恒为 1.0×，不许退回整份重写 | `state/store.py` · `audit/jsonl.py` |

---

## 三、已定

| 项 | 决定 |
|---|---|
| 仓库形态 | **新仓库**，与 Python 版（`Lanxiaoxi/tudouni-ai`）互不相干 |
| Python 版 | 不再维护，不设并行期 |
| 数据兼容 | **不做**。Go 版不读旧的 `.tudouni/sessions/*.jsonl` 与 `logs/*.jsonl` |
| TUI 框架 | **Bubble Tea** + Lip Gloss（配 `glamour` 渲染 markdown、`chroma` 做高亮） |
| UI 文案 | **只做英文**，不做语言切换机制 —— `i18n/` 那 1,886 行的机制部分作废 |
| CJK 渲染 | **仍须处理**，见下方说明 |
| Go 版本 | **1.27**（2026-08-19 发布，当前稳定版） |
| 模块路径 | `github.com/Lanxiaoxi/<新仓库名>` —— **仓库名待定** |

**「只做英文」的边界**：砍掉的是**界面文案的多语言**，不是**中文内容的渲染**。
用户输入、模型回复、工具输出（grep 结果、命令 stdout）、工作区路径都可能是中文，
终端宽度计算、换行、截断必须按东亚字符宽度走 —— 否则模型用中文回一段话，界面就错位。
Bubble Tea + Lip Gloss 内部按 `runewidth` 算宽度，这部分是现成的，不用自己写。

工具链（本机尚无 Go）：

```
安装        https://golang.google.cn/dl/          # 官方中国站
模块代理    GOPROXY=https://goproxy.cn,direct     # 或 mirrors.cloud.tencent.com/goproxy/
```

---

## 四、重写顺序：按模块纵切

不采用「runtime 先行」或「TUI 先行」。前者前两三个月没有可见产出，架构判断错了发现太晚；后者没有 runtime 只能对着假数据。每一刀都端到端打通，依赖单向，不回改。

| # | 纵切 | 打通的东西 | 验收 |
|---|---|---|---|
| 1 | 最小对话链路 | `Channels` interface + 一个模型 provider + 最小 agent loop + 会话追加落盘 + Bubble Tea 骨架 | 发一条消息、拿到流式回复、退出后会话能读回 |
| 2 | 工具系统 | tool registry + args schema 生成 + shell / read_file / write_file / edit_file / grep + `tool_call` / `tool_result` 事件 | 模型能调用工具并看到结果 |
| 3 | 权限闸 | policy → gate → asker + 审批界面 + 记忆规则 | 危险命令被拦、审批后放行并记住 |
| 4 | 上下文系统 | artifact store + 预算账本 + 降级档位 + 引用行渲染 | 长会话不超窗，账本与实际载荷一致 |
| 5 | 审计与后台任务 | audit JSONL + jobs | `/status` 汇总正确 |
| 6 | 扩展能力 | MCP / skills / websearch / webfetch / todo | 按各自现有测试 |
| 7 | 文案与分发 | 英文 UI 文案 + 四个子命令 + 交叉编译打包 | `GOOS=linux go build` 出一条能跑的产物 |

**纵切 1 是唯一一次架构押注。** 它定的 `Channels` 形状和 Bubble Tea 的 Model 结构，后面六刀全挂在这上面。所以它要窄（不求功能完整），但接口要一次定对。