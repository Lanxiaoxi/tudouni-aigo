# Workspace Host 协议（HOST_PROTOCOL 1）

`--workspace-host` 进程在 stdin/stdout 上说的 JSONL 协议。设计成因见 `docs/design/workspace-dock.md` 第三、八节。
这是 Go（`internal/workspace/host`）与桌面端（`src/workspaceHost/`）之间的权威约定；两侧各自定义，由跨语言比对测试保证一致。

## 启动

```
tudouni-aigo --workspace-host --workspace-id <id> [--root <dir>]
```

- `--workspace-id` 必填，由桌面端生成（工作区记录的稳定 id）；host 只认 `workspace_id + root`。
- `--root` 省略时取进程 cwd。root 不存在或不是目录：stderr 写原因，退出码 2。
- 不加载模型、不读会话、不跑 Agent。stderr 只用于诊断。

## 信封

每行一个 JSON 对象，`"v": 1`，`"t"` 是消息名。`v` 不是 1 的行：host 回 `error`（code `bad_version`）并忽略。
两端遇到不认识的 `t` 或字段一律忽略并继续（host 对未知 `t` 但带 `req` 的请求回 `unsupported` 错误结果）。

### 请求与结果

前端发出的请求带 `req`（字符串，前端自己保证唯一）。host 对每个带 `req` 的请求回且只回一条：

```json
{"v":1,"t":"result","req":"r12","ok":true,"data":{...}}
{"v":1,"t":"result","req":"r12","ok":false,"error":{"code":"not_found","message":"..."}}
```

错误码：`bad_request`、`not_found`、`path_escape`、`too_large`、`not_git`、`unsupported`、`internal`、`bad_version`。

### 推送

host 主动发出、不带 `req`：`host_init`、`workspace_event`、`term_output`、`term_exit`、`term_gap`（保留）。

## 握手

host 启动后立刻发：

```json
{"v":1,"t":"host_init","workspace_id":"ws-1","root":"/abs/root","host_protocol":1,
 "version":"7.8.0","pid":1234,
 "workspace_capabilities":{"files":true,"file_watch":true,"file_range_read":true,"git":true,
   "terminal":true,"terminal_output_replay":true,"system_open":false}}
```

- `file_watch`：watcher 成功启动才为 true。
- `git`：PATH 里能找到 `git` 才为 true（不要求是仓库）。
- `system_open`：host 永远报 false；本地打开由桌面端自己判断（远程不得调用）。

`{"v":1,"t":"shutdown"}`：结束全部终端、停止 watcher、退出码 0。stdin EOF 等同 shutdown。

## 文件（`fs_*`）

所有 `path` 都是工作区相对路径，`/` 分隔；`""` 或 `"."` 表示根。越界、经过链接/junction：`path_escape`。

| t | 参数 | data |
|---|---|---|
| `fs_list` | `path` | `{path, entries:[Entry], truncated}`，目录在前、按名字排序，上限 5000 条 |
| `fs_stat` | `path` | `Entry` |
| `fs_read` | `path, offset?=0, limit?=262144` | 见下 |
| `fs_read_bytes` | `path, max?=8388608` | `{path, size, mime, data}`（base64）；`size > max` → `too_large` |
| `fs_search` | `query, limit?=200` | `{results:[Entry], truncated}`，名字子串匹配（不区分大小写），跳过 `.git`、`node_modules` |

`Entry`：`{name, path, kind:"file"|"dir"|"link", size, mtime_ms, hidden}`。`hidden` = 名字以 `.` 开头。

`fs_read`（`limit` 上限 1048576）：

```json
{"path":"a.go","size":12000,"offset":0,"bytes_read":4096,"content":"...",
 "next_offset":4096,"truncated":true,"total_lines":null,"encoding":"utf-8","status":"ok","mime":"text/x-go"}
```

- 读取前先 stat；只读 `[offset, offset+limit)`，不整读入内存。
- 片段末尾若切在 UTF-8 字符中间，回退到字符边界；`next_offset` 指向下一个未读字节，读到文件尾时为 `null`。
- `truncated` = 还有未读内容。`total_lines` 只在一次读完整个文件时给出，其余为 `null`（不得把已读行数报成总行数）。
- `status`：`ok` | `binary`（前 8KB 含 NUL）| `non_utf8`（不是合法 UTF-8）。后两种 `content` 为 `""`，不是错误。
- 目录：`bad_request`。

## Git（`git_*`）

| t | 参数 | data |
|---|---|---|
| `git_status` | – | `GitStatus` |
| `git_diff` | `path, source:"worktree"\|"index"\|"untracked"` | `{path, source, old_path, diff, binary, truncated}` |

`GitStatus`：

```json
{"repo":true,"branch":"main","head":"51f7876","upstream":"origin/main","ahead":0,"behind":0,
 "detached":false,"unborn":false,"operation":"" ,
 "entries":[{"path":"src/a.go","orig_path":"","index":"M","worktree":".","conflict":false,"untracked":false}],
 "truncated":false}
```

- 不是仓库：`{"repo":false, ...其余为零值}`，不是错误。没有 git：`not_git`。
- `operation`：`""` | `merge` | `rebase` | `cherry-pick` | `revert` | `bisect`。
- `index`/`worktree` 用 porcelain v2 的单字母（`.` 表示无变化）；未跟踪文件 `untracked:true` 且两者为 `?`；冲突 `conflict:true` 且为 `U` 等原字母。
- 路径都是**工作区**相对路径；仓库根在工作区上级时，工作区外的条目被丢弃。条目上限 2000，超出 `truncated:true`。
- `diff` 单次上限 524288 字节，超出截断并 `truncated:true`；二进制 `binary:true`、`diff:""`。

## 工作区事件

```json
{"v":1,"t":"workspace_event","workspace_id":"ws-1","revision":108,
 "changes":[{"path":"src/main.go","type":"modified"}],
 "invalidates":["files","git"],"reset_required":false}
```

- `type`：`created` | `modified` | `deleted` | `renamed`。
- 300ms 合并窗口、同路径去重；`revision` 工作区级单调递增，从 1 开始。
- `.git` 内部：只有 `HEAD`、`index`、`refs/**`、`MERGE_HEAD`、`REBASE_*` 等变化产生事件，`changes` 为空、`invalidates:["git"]`。
- 一个窗口内变化超过 500 条、watcher 报错或溢出：`changes:[]`、`invalidates:["files","git"]`、`reset_required:true`。
- 不监听：`.git` 普通对象、`node_modules`、`.tudouni/index`、`dist`、`target`。

## 终端（`term_*`）

| t | 参数 | data |
|---|---|---|
| `term_list` | – | `{terminals:[Term]}` |
| `term_create` | `cwd?="", cols?=80, rows?=24, title?` | `{terminal:Term}`；创建后**不自动 attach** |
| `term_attach` | `id, from_seq?=0` | `{terminal:Term, from_seq, data, gap}` |
| `term_detach` | `id` | `{}` |
| `term_input` | `id, data` | `{}` |
| `term_resize` | `id, cols, rows` | `{}` |
| `term_kill` | `id` | `{}`；结束进程，保留条目与退出码 |
| `term_close` | `id` | `{}`；仍在运行则先结束，然后移除条目 |

`Term`：`{id, workspace_id, cwd, shell, title, created_at, state:"running"|"exited", exit_code, cols, rows, output_seq}`。
`created_at` 为 Unix 毫秒；`exit_code` 运行中为 `null`；`cwd` 是工作区相对路径。

输出序列号：`seq` 是该终端累计输出的**字节偏移**。

- 推送 `{"v":1,"t":"term_output","id":"t1","seq":4096,"data":"..."}`：`data` 覆盖字节 `[seq, seq+len(data 的 UTF-8 字节))`。只推送给已 attach 的终端。
- 每终端 1MB 环形缓冲。`term_attach` 的 `data` 是 `[max(from_seq, 缓冲起点), output_seq)`；`from_seq` 早于缓冲起点时 `gap:true`、返回的 `from_seq` 是实际起点。attach 之后的输出按 `term_output` 推送，不重不漏。
- 字节切分不保证落在 UTF-8 边界，因此 `data` 以 **base64** 传输。
- 进程退出：推送 `{"v":1,"t":"term_exit","id":"t1","exit_code":0}`（无论是否 attach）。
- `cwd` 必须在工作区内（走 `SafePath`），越界 `path_escape`。

## 实现补充（Go 侧已落地的细节）

以下是规范正文没有写死、Go 实现已经固定下来的行为；桌面端按此对齐。

- **启动**：`--root` 还要通过与 runtime 相同的「不是家目录 / 文件系统根 / 家目录的祖先」检查，否则 stderr + 退出码 2。缺 `--workspace-id` 同样退出码 2。
- **`bad_version`**：除了 `{"t":"error","code":"bad_version","message":...}`（带 `req` 时回显 `req`），若该行带 `req`，另回一条 `ok:false` 的 `result`，使请求方不会悬挂。
- **`term_gap`（push，原为保留）**：`{"t":"term_gap","id","from_seq","to_seq"}`。host 向已 attach 的终端推送输出时，若前端消费太慢、字节已被环形缓冲覆盖，则跳到最早仍保留的字节并发出此消息；`[from_seq,to_seq)` 是丢失区间。之后的 `term_output.seq` 从 `to_seq` 继续。
- **term 实现**：id 形如 `t1`、`t2`；`term_input` 写已退出的终端 → `bad_request`；`term_kill` 在进程确实退出（最多等 3s）后才回结果，因此结果里查询到的状态已是 `exited`；被 kill 的进程 `exit_code` 在平台无退出码时为 `null`。终端上限 32。`term_attach` 的 result 一定先于该终端之后的任何 `term_output`。
- **`fs_read`**：`bytes_read` 为实际返回的字节数；`offset` 回显的是**实际**起点（`offset` 落在多字节字符中间时向后跳到下一个字符边界）；`status` 为 `binary`/`non_utf8` 时 `encoding:""`、`bytes_read:0`。二进制判定始终看文件头 8KB，与 `offset` 无关。`total_lines` 仅在 `offset==0` 且一次读完整个文件时给出（空文件为 0）。
- **`fs_read_bytes`**：`max` 实际被钳制在 32MB（`bytesHardCap`）。`fs_search` 的 `limit` 上限 1000，且最多访问 30 万个目录项，超出则 `truncated:true`。
- **`fs_stat`/`fs_list`**：链接（symlink / junction）的 `kind` 为 `link`；经过链接的路径按 `path_escape` 拒绝（`SafePath` 行为）。
- **`git_status`**：`head` 是 7 位短哈希；`--untracked-files=all`，未跟踪文件逐个列出；条目按路径排序后再截断到 2000。`git_diff` 的 `source` 缺省为 `worktree`；`path` 为空或为根 → `bad_request`。暂存区的重命名 diff 会带 `old_path`。
- **`workspace_event`**：窗口内同一路径合并为净变化（created+deleted 抵消不上报；deleted+created 视为 modified）。只要有具体路径变化，`invalidates` 就是 `["files","git"]`；只有 `.git` 元数据变化时是 `["git"]`。`.git` 中的 `*.lock`、对象库、日志不产生事件。
- **`MessageNames`**：Go 常量 `host.HostProtocol`、`host.RequestNames`、`host.PushNames`、`host.MessageNames`（`internal/workspace/host/protocol.go`），供跨语言比对测试使用。
