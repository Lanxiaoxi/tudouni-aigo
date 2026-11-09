# Ticket Sources：把外界的变化投进 inbox

状态：**已实现**（桌面端 7.6.0）。与本文的出入（都是收紧）：`repo` 限 `owner/name` 字符集，`branch` / `ref` 不允许 `.`、`..` 段；`http.json` 的 `url` 必须是 http(s)，`body` 不能以 `@` 开头且只配 POST，`items` 路径不存在是失败而不是空列表（空列表会让所有条目被判为 removed），配了 `version` 路径但取不到的条目回退到内容 hash 并给 warning；`git.remote` 的 `url` 不能以 `-` 开头；`file` 的 glob 没有通配符时按单个文件处理；错误信息里的 token、请求头值、代理凭据一律遮蔽。Rust 侧 `desktop/tudouni-aigo-desktop/src-tauri/src/ticket_sources/`；桌面端 `src/ticket/sources.ts`（类型与表单规格）、`src/components/board/SourcesPanel.tsx`（设置面板）、`src/runtime/tauri.ts`（命令封装）。它是 `ticket.md` 6.7 inbox 的上游，**不改 inbox 之后的任何规则**。

## 一、它是什么

Source 层是 inbox 前面的一排适配器：每个 Source 看一处外界（GitHub、git 远端、文件、HTTP 接口、时钟、任意命令），把"变化"翻译成 inbox 文件。之后的事——建 OPEN 单、`(source, thread)` 去重、人按 Start——全部由现有 inbox 完成。

```
probe（怎么看） → detect（什么算变化） → emit（投成什么样） → inbox/*.md → 现有 inbox 扫描 → OPEN
```

借鉴 superagent 的 Source 思想中**不依赖模型**的一半：Source 负责把外部事件翻译成事件、记读取位置、保证幂等。去掉的是 Eval / Policy / Channel：没有 router，判断"要不要做"的是看板前的人。

三条规则：

1. **Source 只写 `inbox/`。** 它从不碰 `tickets.json`，"唯一写者"不变；投进去的单子仍是 `open`，"投递永远不会开始工作"不变。
2. **只有 probe 和来源相关。** detect 和 emit 对所有来源是同一套规则，加一种来源只是加一个 probe。
3. **不判断。** 不调用模型。需要条件、跨条目计算、随时间成立的条件，写进 `command` probe。

安全：本层**不做**内容过滤或注入防护。理由是 inbox 到执行之间有人在把关（OPEN → 人按 Start）。如果以后出现绕过人的路径（自动 Start），要先回来补这一层。

## 二、核心模型：快照差分

每个 probe 只做一件事：返回**当前**的一组条目。

```
Item { key: string, version: string, fields: JSON object }
```

detect 把这次的快照（`key → version`）和上次存下的比，产生事件：

| 事件 | 条件 | `fields` |
| --- | --- | --- |
| `added` | 这次有、上次没有 | 本次条目的 |
| `changed` | 两次都有、version 不同 | 本次条目的 |
| `removed` | 上次有、这次没有 | 空对象（快照只存 version） |

- `on` 决定投哪几种，默认 `["added", "changed"]`；`removed` 支持但默认不投（inbox 是单向的，removed 只能再建一张单，关不掉原来那张）。
- `filter` 在差分**之前**作用于条目：不匹配的条目当作不存在。
- 同一次扫描里同一个 key 重复出现，取第一个。

**基线。** 一个 Source 第一次扫描，或它的**指纹**变了（`probe` + `filter` 的规范化 JSON 的 sha256），只记下快照、不投递。`initial: "emit"` 覆盖这条：把当前全部条目当作 `added`（仍受 `on` / `limit` 约束）。指纹不含 `emit` / `on` / `limit`：改模板不应该把一个仓库的现状重新投一遍。

**上限。** 每个 Source 每次最多投 `limit` 条（默认 20，范围 1–200），按 probe 给出的顺序取。超出的事件**不进快照**——`added` 的 key 不写入、`changed` 保留旧 version、`removed` 保留旧条目——所以下次扫描它们会被重新算作事件。结果里报 `deferred` 条数。

**顺序与失败。** 先写完这个 Source 的全部 inbox 文件，再写它的快照。中途崩溃，下次重写同名文件，靠 inbox 的 `(source, thread)` 去重，没有副作用。probe 失败：快照不动、不投递、报错，**不影响其他 Source**。快照丢了最多导致重新建一次基线，不会产生重复的单。

两次扫描之间变了多次，变化型 Source（如 `github.branch`）只看到最新的一次。这是有意的：对"发布最新提交"正是要的。

## 三、文件

都在 `~/.tudouni/tickets/` 下（一个系统，一个目录）：

```
~/.tudouni/tickets/
  tickets.json          工单（不变）
  inbox/  processed/    投递口（不变）
  sources.json          Source 配置：人写（面板或手改）
  sources-state.json    快照与上次扫描结果：只有扫描写
```

配置和状态分两个文件，理由和 tickets 从 `desktop.json` 拆出来一样：写者不同、频率不同。两个都是原子写（同目录临时文件 + rename）。

### 3.1 `sources.json`

```json
{
  "schema": 1,
  "sources": [
    {
      "id": "repo-a-release",
      "name": "repo-a 发布",
      "enabled": true,
      "probe": { "kind": "github.branch", "repo": "org/repo-a", "branch": "main" },
      "on": ["changed"],
      "filter": {},
      "initial": "baseline",
      "limit": 20,
      "emit": {
        "thread": "push#{version}",
        "title": "发布 {version|short}",
        "brief": "main 有新提交 {version}，执行 scripts/release.ps1 构建并发布。",
        "url": "{fields.url}",
        "workspace": { "kind": "local", "path": "D:/repo-a" },
        "model": ""
      }
    }
  ]
}
```

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | 是 | | `^[a-z0-9][a-z0-9_-]{0,63}$`，唯一。写进 inbox 的 `source`，所以是幂等键的一半；改 id 等于换一个 Source |
| `name` | | `id` | 给人看 |
| `enabled` | | `true` | 关掉的 Source 不扫描，快照保留 |
| `probe` | 是 | | `{kind, ...参数}`，见第四节 |
| `on` | | `["added","changed"]` | 事件子集，不能为空 |
| `filter` | | `{}` | `{ "<路径>": "<glob>" }`，全部匹配才算；路径同模板（`key` / `version` / `fields.a.b`）；值按字符串比较，数组取"任一元素匹配"；glob 支持 `*` `?`，大小写不敏感 |
| `initial` | | `"baseline"` | `"baseline"` 或 `"emit"` |
| `limit` | | `20` | 1–200 |
| `emit.thread` | | `"{event}:{key}@{version}"` | **幂等语义本身**：`pr#{key}` = 一个 PR 一张单；`pr#{key}@{version}` = 每次新提交一张 |
| `emit.title` | | 空（取 brief 第一行） | |
| `emit.brief` | 是 | | 渲染后不能为空 |
| `emit.url` | | 空 | 卡片上的外链 |
| `emit.workspace` | | `{kind:'active'}` | `TaskWorkspaceRef`：`active` / `{kind:'local',path}` / `{kind:'remote',id}` |
| `emit.model` | | 空 | 空 = 工作区当前模型 |

整个文件不是合法 JSON 或 `schema` 不是 1：不扫描任何 Source，报 `configError`。单个 Source 不合法（缺字段、未知 kind、id 重复的第二个）：只跳过它并报原因，其余照常。未知的顶层或 Source 字段忽略，不拒绝。`sources_write` 写盘前用同一个校验器检查，校验失败拒写并返回原因——面板不会写出一个扫描时才发现坏掉的文件。

### 3.2 模板

`{路径}` 或 `{路径|过滤器}`。路径：`key`、`version`、`event`（`added`/`changed`/`removed`）、`source`（Source id）、`fields.a.b`（点号逐级取；数组用下标 `fields.labels.0`）。取不到渲染为空串。值是数组或对象时渲染成紧凑 JSON；数字、布尔按字面。过滤器：`short`（前 7 个字符）、`lower`、`upper`、`trim`。`{{` 和 `}}` 输出字面的花括号。

`thread` / `title` / `url` 渲染后把换行换成空格并去首尾空白（它们进 front matter，必须是一行）。`thread` 渲染为空时该事件报错跳过（不投递、不进快照，下次重试）。

### 3.3 `sources-state.json`

```json
{
  "schema": 1,
  "sources": {
    "repo-a-release": {
      "fingerprint": "<sha256 hex>",
      "items": { "main": "3f2a…" },
      "lastScan": { "atMs": 0, "ok": true, "error": null, "emitted": 1, "deferred": 0, "baseline": false, "total": 1 }
    }
  }
}
```

配置里已删除的 Source，其状态在下一次扫描时一并清掉。probe 失败时只更新 `lastScan`，不动 `fingerprint` / `items`。

### 3.4 inbox 文件

文件名 `src-<id>-<sha256(thread) 前 16 位>.md`，原子写：先写 `.src-….tmp` 再 rename（inbox 读取跳过 `.` 开头的名字）。同一个 thread 永远是同一个文件名，重复投递是覆盖。

```markdown
---
source: repo-a-release
thread: push#3f2a…
title: 发布 3f2a1b9
workspace: local:D:/repo-a
model:
url: https://github.com/org/repo-a/commit/3f2a…
---
main 有新提交 3f2a…，执行 scripts/release.ps1 构建并发布。
```

inbox 解析（`src/ticket/inbox.ts`）因此多认三个字段：

| 字段 | 取值 | 进入 |
| --- | --- | --- |
| `workspace` | `active` / `local:<路径>` / `remote:<id>`；认不出按 `active` | `Ticket.workspace` |
| `model` | 字符串 | `Ticket.model` |
| `url` | `http(s)://…`；别的协议忽略 | `Ticket.origin.url`（可选），卡片的来源标注变成可点的外链 |

这三个字段对手写的 inbox 文件同样生效。

## 四、probe kind

所有 probe 共有的可选参数：`timeoutSec`（默认 60，1–600），作用于这个 probe 拉起的每个外部进程。外部进程在 Windows 上带 `CREATE_NO_WINDOW`。

**GitHub 系列**通过系统 `curl` 调 REST API（Windows 10+ 自带；不引入 HTTP crate）。鉴权：`tokenEnv` 指定的环境变量（默认 `GITHUB_TOKEN`）；没有就尝试 `gh auth token`；都没有就匿名（只能读公开仓库，60 次/小时）。可选 `apiBase`（默认 `https://api.github.com`，GHE 填 `https://<host>/api/v3`）、`proxy`（交给 curl `-x`；不填时 curl 自己读 `HTTPS_PROXY`）。列表类只读第一页，`perPage` 默认 50（1–100）。

| kind | 参数 | 条目 | key | version | fields |
| --- | --- | --- | --- | --- | --- |
| `github.pulls` | `repo`*、`state`（open/closed/all，默认 open）、`base` | PR | 号 | head sha | `number title url author base head draft labels[]` |
| `github.issues` | `repo`*、`state`、`labels`（逗号分隔） | Issue（排除 PR） | 号 | `updated_at` | `number title url author state labels[]` |
| `github.branch` | `repo`*、`branch`*（默认 main） | 一个 | 分支名 | HEAD sha | `sha url message author` |
| `github.releases` | `repo`*、`includePrerelease`（默认 false） | release | tag | `published_at`（草稿为空则用 id） | `tag name url prerelease draft` |
| `github.checks` | `repo`*、`ref`*（分支名或 sha） | 一个 | ref | 聚合结论 `success`/`failure`/`pending`/`neutral` | `state sha url failed[]` |
| `git.remote` | `url`*、`refs`（默认 `refs/heads/*`） | `git ls-remote` 的每个 ref | ref | sha | `ref sha` |
| `git.local` | `path`*、`branches`（glob，默认 `*`） | 本地分支 | 分支名 | sha | `branch sha subject` |
| `file` | `glob`* | 匹配的文件（`*` 不跨目录，`**` 跨） | 绝对路径 | 内容 sha256 | `path name size mtimeMs` |
| `dir` | `path`*、`pattern`（默认 `*`） | 目录下一层的文件 | 文件名 | `<size>-<mtimeMs>` | `path name size mtimeMs` |
| `http.json` | `url`*、`method`（GET/POST）、`headers{}`、`body`、`proxy`、`items`、`key`*、`version` | 响应里 `items` 路径下的数组 | `key` 路径 | `version` 路径；缺省为条目紧凑 JSON 的 sha256 | 条目本身 |
| `schedule` | `every`*（hourly/daily/weekly/monthly）、`at`（`HH:MM`，默认 `00:00`）、`weekday`（1=周一…7，默认 1） | 一个 | `schedule` | 当前时段 id | `period` |
| `command` | `run`*（argv 数组）、`cwd` | stdout 的 JSON 数组 | 命令给 | 命令给 | 命令给（可省） |

\* 必填。

几点说明：

- `github.checks` 的 version 是结论而不是 sha：要的是"main 的 CI 变红了 / 恢复了"，连续两次都红不是新事件。想要"每个提交的结论"，`thread` 写成 `ci#{fields.sha}`、`on` 设 `["added","changed"]` 并接受同结论不投递，或用 `command`。聚合规则：有任何 `failure`/`timed_out`/`cancelled`/`action_required` → `failure`；否则有未完成的 → `pending`；否则全部 `success`/`skipped`/`neutral` 且至少一个 success → `success`；没有 check run → `neutral`。
- `http.json` 的 `items` 是点号路径，空串表示根；落点是数组就逐个当条目，是对象就当作单个条目。`key` 取不到的条目跳过并计入错误说明，不让整次失败。
- `schedule` 用本地时间：扫描请求带上前端的 `tzOffsetMinutes`（`Date#getTimezoneOffset()`），Rust 侧不需要时区库。时段 id：hourly `2026-11-08T14`、daily `2026-11-08`、weekly `2026-W45`（ISO 周）、monthly `2026-11`；`at` / `weekday` 把时段起点挪到那个时刻（例如 daily `at: "09:00"` 在 9 点前仍算前一天）。默认 `on` 含 `changed`，所以每进入一个新时段投一次；首次扫描是基线。
- `command` 的合同：退出码 0 且 stdout 是 `[{key, version, fields?}]` 的 JSON 数组；`key` / `version` 必须是字符串（数字会被转成字符串）。非 0 退出码、超时、非 JSON 都是这个 Source 的失败，stderr 末尾 500 字进错误说明。这是扩展点：任何语言都能写，加新来源不用改应用。
- `file` / `git.local` / `dir` 只认本机路径。远程工作区的文件用 `command` 包一条 `ssh … ` 顶上。

## 五、命令（Rust ↔ 前端）

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `sources_read` | — | `sources.json` 原文，不存在为 `null` |
| `sources_write` | `text` | 校验通过才原子写；否则 `Err(原因)` |
| `sources_path` | — | `sources.json` 的绝对路径（"打开文件"用） |
| `sources_status` | — | `{ [id]: lastScan }` |
| `sources_scan` | `nowMs`、`tzOffsetMinutes`、`only?: string[]` | `ScanReport`，见下 |
| `sources_probe` | `source`（一个 Source 的 JSON 文本）、`nowMs`、`tzOffsetMinutes` | `{ ok, error, total, items: Item[≤20] }`；只跑 probe，不写任何文件（面板的"试运行"） |

```ts
interface ScanReport {
  configError: string | null;
  sources: Array<{
    id: string;
    ok: boolean;
    error: string | null;   // 失败原因，或 ok 时的部分问题（例如跳过的条目）
    skipped: 'disabled' | 'invalid' | null;
    baseline: boolean;      // 这次是建基线
    total: number;          // probe 返回的条目数（过滤后）
    emitted: number;
    deferred: number;
  }>;
}
```

扫描在 `spawn_blocking` 里跑，Source 之间串行。同一时刻只允许一个扫描：第二个请求直接返回 `Err("a scan is already running")`，不排队。

## 六、界面

- **两个按钮分开**：看板头部现有的「Check inbox」不变，旁边加「Scan sources」。Scan 只投递，不扫 inbox；结束后在看板上说一句结果（投了几条、建了几个基线、哪个失败、为什么），并提示去 Check inbox。
- **设置入口**：看板头部一个齿轮图标，打开 Sources 面板（对话框，风格同 Config 面板）：
  - 左侧 Source 列表：名字、kind、启用开关、上次扫描结果（时间、投了几条、错误）。
  - 右侧编辑器：按 kind 生成的参数表单（`src/ticket/sources.ts` 的 `PROBE_SPECS` 一张表），加上 on / filter / initial / limit 和 emit 各字段（workspace、model 复用 Ticket 对话框的选择器）。
  - 「试运行」调 `sources_probe`，列出前 20 个条目的 key / version，让人在保存前看到模板会拿到什么。
  - 「打开文件」直接打开 `sources.json`，给需要手改的人。
  - 保存走 `sources_write`；被拒时原因显示在面板里，不关闭面板。
- 文案全部走 `src/i18n`，key 前缀 `ticket.sources.*`。

## 七、不做的

- 定时扫描、文件系统 watcher、webhook：将来它们都只是"触发一次扫描"，规则不变；届时要给"同一 Source 同时只跑一次"之外再考虑节流。
- 回写外部（在 PR 上回复）：那是 Channel，和 Source 是两件事。
- 跨 Source 关联（"PR 合并后触发发布"）：用两个独立 Source 各自投递。
- 内容过滤、注入防护：见第一节。

## 八、版本

只改 `desktop/`，不碰 Go，不升 `VERSION`。新功能，桌面端次版本 +1（`npm run version:bump`）。
