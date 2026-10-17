# 工作区记忆（Workspace Memory）：实现记录

这份文档记录的是**已经落地的实现**，以及实现过程中对原设计做的取舍。原设计（`Workspace Memory 最终设计方案`）
的核心主张一条都没有改：统一记忆模型、Markdown 为事实、Runtime 统一管理、按需检索、受控更新、可靠优先、
工作区范围明确。下面写的是"这份设计落在现有代码里长什么样"。

---

## 一、代码落点

| 位置 | 内容 |
| --- | --- |
| `internal/memory/` | 记忆子系统本体：数据模型、仓库、索引、检索、生命周期、配置 |
| `internal/tools/builtin/memory.go` | 模型侧的三个工具：`memory_search` / `memory_get` / `memory_propose` |
| `internal/runtime/memory.go` | Runtime 集成：三个检索触发点、注入块的拼装、面板的两条协议方法 |
| `internal/protocol/memory_handlers.go` | `memory_list` / `memory_action` 两个入站消息 |
| `desktop/.../panels/MemoryPanel.tsx` | 桌面端面板（左下角工作台抽屉里的「Workspace memory」） |

`internal/memory` 不依赖 agent / tools / protocol，只有 `internal/paths` 一个常量依赖。它是"一个带检索的存储"，
谁在什么时候调它，是别人的决定。

### 目录结构（和设计一致）

```
<workspace>/.tudouni/memory/
├── config.json         设置（第一次保存时才写）
├── index.json          派生索引，可随时重建
├── entries/mem_00N.md  正式记忆 —— 事实
├── candidates/         待审核提案
├── archive/entries/    被替代的版本 / 已废弃的记忆
└── write.lock          跨进程写锁（瞬时文件）
```

## 二、数据模型

一条记忆 = 一段 Markdown + 一层 frontmatter，字段：`id` / `revision` / `created_at` / `updated_at`（必需），
`scope.paths` / `triggers` / `tags` / `evidence.confidence`（可选），以及**任何本版本不认识的键**——
它们会被原样保留并在重写时写回（`Entry.Extra`）。手工改过的文件经过一次提案更新不会丢字段。

没有 `type` 字段。用户偏好和踩坑经验是同一种形状，靠 `triggers`（怎么再找到它）和 `scope`（哪里适用）区分。

frontmatter 用的是**YAML 子集**的自研解析器（`entry.go`），没有引入 YAML 依赖：
块状 map、块状字符串列表、内联 `[a, b]`、引号字符串。解析宽松（缺标题也能读），渲染严格（固定键序、必要时加引号），
因此**同一条记忆重复渲染得到同样的字节**——`git diff` 在这个目录上才有意义。

`evidence.confidence`：`verified` / `observed` / `inferred`。它是证据状态，不是内容分类。

## 三、检索

`Retrieval` 第一版是确定性的关键词 + 路径匹配，没有向量。理由写在 `retrieve.go` 顶部：这个规模下
向量检索只会多一个服务、一种故障模式和一个无法解释的答案，而它换不来最重要的东西——**"为什么召回了它"可复核**。

打分（`retrieve.go`，全部权重集中在一处）：

| 线索 | 权重 |
| --- | --- |
| trigger 命中（完整子串） | 8 |
| trigger 部分命中（词覆盖 ≥ 50%） | 8 × 覆盖率 |
| 标题词 | 3（最多 3 个） |
| 标签 | 2（最多 2 个） |
| 只在正文出现的词 | 1（最多 6 个） |
| `scope.paths` 与查询路径对得上 | 2 |
| `verified` / `observed` | +1.2 / +0.4（**只加分，不参与门槛**） |

**门槛（`min_score`，默认 2）只作用于"线索分"**，不含可信度加分。否则一条 `verified` 的记忆靠一个共同正文字
就能过线——"可信"说的是"如果适用就相信它"，不是"它适用"。

分词：拉丁词按非字母切分（单字母丢弃），CJK 走 **bigram**（`方案设计` → `方案/案设/设计`，再加整体）。
单字会被丢弃，因为单字中文几乎匹配一切。这样"帮我把这个功能的方案整理一下"能命中触发词是 `方案设计` 的记忆。

`scope` 过滤：查询给了路径，而记忆声明的 `scope.paths` 与它无关时**排除**；查询没给路径时**不过滤**——
"不知道"不能读成"不适用"。

## 四、生命周期

```
Propose → candidates/proposal_00N.md → 人审核 → Publish → entries/mem_00N.md
                                            └→ Reject（删除候选）
```

* **模型只能 propose**。它的写工具叫 `memory_propose`，只能落到 `candidates/`。没有任何工具能发布、修改或删除正式记忆。
* **发布时才分配 `mem_` 编号**（不是提案时）。两个提案同时存在时不会抢同一个号。
* **更新带版本检查**：提案记录 `expected_revision`；发布时目标 `revision` 不符 → `ConflictError`，
  两个版本号都报出来，提案保留（可以按当前版本重提）。**绝不静默覆盖**。
* **更新前先归档**旧版本到 `archive/entries/<id>-r<rev>.md`。
* **废弃也是提案**（`op=deprecate`），发布后原文件移到 `archive/entries/<id>-deprecated.md`，
  并在 frontmatter 里写 `deprecated_at` / `deprecated_reason`；索引重建，检索不再命中。
* 候选被发布/拒绝后**删除**。第一版不做事件日志——被批准的正式记忆本身就是记录。

## 五、可靠性与一致性

* **原子写**：同目录临时文件 → `fsync` → `rename`（Windows 上 `os.Rename` 也是替换语义）。断电不会留下半条记忆。
* **跨进程写锁**：`.tudouni/memory/write.lock` 用 `O_CREATE|O_EXCL` 创建，30s 未释放视为遗弃并抢占，最多等 3s。
  一个工作区同时开多个会话就是多个 runtime，只在进程内加锁等于没锁。`Propose` 和 `Publish` 都在锁内分配编号。
* **索引是派生数据**：`index.json` 里的每一格都能从 Markdown 重建。缺文件、JSON 坏、id 集合对不上、
  或者**文件 mtime 变过**（有人用编辑器改了记忆）——任何一种都会触发重建。重建后写回；写回失败只报问题，
  内存里的索引照常可用。
* **坏文件不连坐**：某一条记忆的 frontmatter 读不出来时，它被跳过并**点名报告**（路径写进问题里），
  其余记忆照常检索。这同时是 `Snapshot.Unreadable` 的来源。
* **记忆系统故障不影响任务**：`Open` 失败 → 一条 warning，会话继续（没有记忆工具、没有召回）；
  检索 panic 被 recover；所有问题都以句子形式回报，不阻断回合。
* **外部编辑**：检索路径上带一个 2 秒节流的时间戳探测（`StaleCheckInterval`），所以"在编辑器里改完回来看面板"
  不需要重启 runtime。

## 六、Runtime 集成（三个触发点）

设计里的三个位置，落在代码里是两个半：

1. **回合开始** —— `Runtime.RunTurn` 在跑 agent 之前调 `recallForTurn(text)`，用**用户自己的话**检索。
   用户偏好主要在这里被找到：偏好由"你在做什么"触发，而不是由报错触发。
2. **工具失败** —— `agent.Config.OnToolResult`（新增钩子）把**完整**结果文本给 runtime；`status == error` 时检索。
   用完整文本而不是审计里那份 200 字预览，因为报错的区分点常常在末尾（嵌套的 caused by、最后一行的版本号）。
   `denied` / `interrupted` 不触发：一个是人的决定，一个不是结论。
3. **模型主动查** —— `memory_search` / `memory_get`，走同一个 `Workspace.Search`。

三条路**共用一个注入点**：`Runtime.notes()`（每个请求的 payload 尾）里追加 `r.memoryNote()`。因此
"为什么这段记忆出现在模型面前"只有一个答案，关掉也只有一个开关。注入块按 `entry_chars`（每条）和
`note_chars`（整块）双重封顶，块位置在技能目录之后、goal/todo 之前——那两样描述的是**这一回合在干什么**，
必须更靠近生成位置。

注入块开头那句话是有作用的：明确说这是**历史、不是当前事实**，冲突时以当前代码和验证结果为准，
过时了可以用 `memory_propose` 提修正。

每次自动召回写一条审计事件 `memory_recall`（trigger / query 摘要 / 命中的 id），不写正文——
正文还在磁盘上，抄进日志就等于把日志变成第二份语料。

## 七、协议（PROTOCOL 5 → 6）

新增两条入站消息和一种 `ui` kind：

* `memory_list` → `ui(memory)`：面板要的**全量**快照（`root` / `config` / `entries` / `candidates` / `index` / `problem` / `unreadable`）。
* `memory_action`（`publish` / `reject` / `deprecate` / `rebuild` / `config`）→ 同样回一份新快照，外加一条 notice。

**失败时也是这个 kind，带 `problem` 字段**。面板是盖在会话流上的一层，notice 会写在它背后——文件面板踩过这个坑，
这里从第一天就把错误塞进面板自己的通道。`config` 是**补丁**语义（只带想改的键），老版本面板照样能存。
schema（`protocol/schema/*.json`）同步更新，conformance 测试通过。

`ui(memory)` 里的空数组是 `[]` 而非 `null`：`null` 和 `[]` 是两句话，前者表示"runtime 没说"。

## 八、桌面端

左下角工作台抽屉（`.lb-foot` 里的 `lb-workbench`）**「Workspace」组新增一项 `Workspace memory`**
（排在 Files / Terminal / Learn 之后、Board 之前——它是工作区自己的一个面，不是设置项；
它里面的设置是**面板里的一半**，不是它存在的理由）。面板入口受"有会话"限制，和其它工作区面板一样。

**界面形状取自这次改版的设计稿：两列，不再是一串堆叠的卡片。**
左列是行为与数值（设置），右列是一张卡片，装着待审核的队列和已记录的清单。两列同屏的理由不是
好看：右列是左列的**效果**，改"relevance floor"时看不见语料，就得靠记忆想象自己在调什么。
面板因此占一个自己的宽度档（`dialog-memory`，1000px）——它比其它面板都宽，因为右列那张卡片
要在一行里放下一个句子长的标题和两个按钮。

1. **Behavior**：四个 `role="switch"` 开关（总开关、是否注入、两个召回触发），每行一句说明。
   "关闭"写的是它真正停止的东西："Off stops recall and ignores proposals. Files stay on disk."
2. **Recall tuning**：五个数值。前四个是 stepper（`−` / 可输入的值 / `+`），第五个是滑杆。
   **值是输入框而不是纯数字**：`note_chars` 的 200–12000 按 100 一档，靠 `+` 按到 3000 要 28 次，
   而人早就知道那个数。旁边的范围标签写的是 runtime 真正接受的边界
   （`internal/memory/config.go` 的 ceiling：1–10 / 1–20 / 0.5–20 / 120–4000 / 200–12000），
   不是设计稿上的取整值。越界由 runtime 收敛，收敛说明随快照回来。
3. **保存行**：左边一句"这次改动什么时候生效"，右边 `Reset to defaults` / `Save changes`。
   没有未保存改动时两个按钮都是禁用的，左边那句换成 `Unsaved changes`——一个禁用的
   Save 不解释就是坏掉的按钮。
   `Reset to defaults` 的默认值**只能在前端复制一份**：`ui(memory)` 报的是**当前**配置，
   从不报默认值。这份拷贝和 `LIMITS` 一起注明以 `memory.DefaultConfig()` / `Normalise` 为准。
4. **待审核（Waiting for review）**：标题是卡片里最大的字（队列是按标题扫的），元信息一行
   "proposed 2h ago · 这条提案会做什么"，然后是 `Approve` / `Discard`。
   **正文在 `Read` 后面**，不在卡片上：一屏要放下队列，而"批准前必须能读到正文"这条规则没变——
   `Read` 就地展开正文，连同可信度和触发词，因为那两样是判断这段正文该不该信的根据。
   正文可滚动且有高度上限（`.wm-body` 220px）。
5. **已记录（On record）**：紧凑行——标题、可信度（`verified` / `observed` / `inferred`，带颜色、
   悬停给定义）、`mem_x rN · updated … · N chars`、scope 路径与标签、触发词；
   每行可发起"废弃"（两段式 + 可选理由输入，和删除会话、结束终端同一个交互规则）。
6. **索引一行**：条数、构建时间、是否刚重建、问题。它钉在卡片的脚上——它是**整个语料**的事实，
   读起来是页脚，不是上面列表的一行。

**头部只剩一个按钮（Rebuild index）。** 原来是"重新读盘"和"重建索引"两个，但重建本来就要重读
Markdown，"重新读盘"永远只重画同样的行——留下那个**能修好什么**的。

**面板不做乐观更新**：每个动作都等 runtime 的全量快照回来再重画。这样"批准"不会在本地先删掉一行——
删除是**废弃**的语义，不是批准的。

两个纯视觉决定，值得写下来：

* 卡片用 `--bg-muted`（"嵌套面"）而不是 `--bg-secondary`。深色主题里从 dialog 的表面上**升一档**
  才是变亮，而 `--bg-secondary` 是往下降一档——那张卡片会在夜间整个消失（只有一条边框在）。
  卡片不画边框：填充本身就是边。
* 开关行的分隔线从**文字起点**开始（用伪元素定位到 toggle 列之后），不是从面板左边开始：
  这样一列开关读起来是一列，线读起来是文字的。

## 九、偏离设计的地方（以及为什么）

1. **面板入口受"有会话"限制**（`blocked || !hasSession`），和文件 / 终端面板一样。
   记忆目录是工作区的，但读写它的是 runtime，而 runtime 是每会话一个。没有会话时没有可问的对象；
   配置面板不受这个限制，因为它直接读写文件。
2. **面板文案是英文**。桌面端是 English-only（`src/i18n/index.ts` 顶部写明了理由：runtime 只说英文，
   一半界面翻译、另一半 notice 原文照搬会更糟）。所以菜单项叫 `Workspace memory` 而不是「工作区记忆」。
3. **`deprecate` 在面板里是"提案"而不是立即生效**：点一次产生一条 `op=deprecate` 的候选，
   批准它才真正废弃。这是设计的审核规则，不是多一次点击。
4. **子代理不注入记忆**。`subagent` 的 payload 尾仍然只有技能正文。给子代理看父级的记忆会让它把
   "父级遇到的坑"当成自己任务的结论；需要时可以显式调 `memory_search`（工具在它的工具集里）。
5. **自动续行的 goal 回合不重新检索**，沿用上一回合已召回的集合（`RunTurn` 才重置）。目标没变，记忆也不该跳变。
6. **第一版没有事件日志 / 变更历史**，按设计执行：`archive/` 里留的是内容，不是操作流水。
7. **没有做"记忆 aging / 自动遗忘"**：设计明确说第一版不做，`updated_at` 不参与打分。
8. **没有往工作区的 `AGENTS.md` 里写记忆使用说明**。设计第三节提到 AGENTS.md 只留简短说明，
   但那是**用户的文件**：程序在启动时往里追加一段文字，等于未经同意改别人的仓库。
   同样的说明放到了模型实际会读的地方——见下一节「系统提示词」。

## 十、系统提示词（`prompts/system.zh.md`）

**加了，一节 `## 工作区记忆（memory）`，放在「长期目标（goal）」和「后台任务」之间。**
理由不是"补文档"，是三条具体的失效模式：

1. **不写，记忆库会一直是空的。** 工具描述只在模型准备调用时才读，而"我刚刚解决了一个值得记下来的问题"
   这个念头必须由提示词级别的习惯触发；现成的反例就在同一个文件里——`create_goal` 的描述写得很细，
   但目标功能仍然有一节提示词讲"什么时候建"。记忆是同一类东西，所以给它同一类位置。
2. **`[工作区记忆]` 块需要一个预告。** 注入块自己解释了它是什么，但模型没有任何先验；先告诉它
   "你会看到这么一块、那是历史不是指令"，比让它每次自己从格式推断可靠。
3. **优先级必须说成一条通则。** "记忆不能覆盖用户的当前要求"是跨功能的规则（和 goal、skills 的规则同级），
   写在注入块的头部只覆盖"召回命中了"这一种情况，写在提示词里才覆盖全部。

同时刻意**没有**写进提示词的：字段名、`min_score` 之类的机制细节（属于工具 schema 和面板），
以及"每轮都先 search 一下"——runtime 已经自动检索了，再让模型每轮自查会变成重复调用。
提示词只补一句"想换个说法再查时才用 `memory_search`"。

长度约 250 字（≈200 token），是系统消息（进前缀缓存，每会话基本只付一次）。
`prompts/` 属于 `VERSION` 覆盖范围，这次的改动算在同一个 6.12.0 里，没有单独升版本号。

## 十一、验收对照（设计第十一节）

| 场景 | 落在哪 | 测在哪 |
| --- | --- | --- |
| 新会话能找到以前的经验 | `entries/` + `index.json` 重建 | `TestIndexIsRebuiltFromMarkdown` |
| 错误表述变化后仍能召回 | trigger 词覆盖 ≥50% 计分 | `TestSearchRanksTriggersAboveBodyText`、`TestSearchFindsChineseTriggersFromADifferentSentence` |
| 不相关任务不加载无用记忆 | 门槛只算线索分 + `scope` 过滤 | `TestSearchRequiresARealCue`、`TestRecallSkipsAnUnrelatedTurn`、`TestScopeFilterDropsOtherSubtrees` |
| 已确认的偏好能被复用 | 回合开始触发 + trigger 分词 | `TestMemoryRecallInjectsATriggerMatch` |
| 不因单次操作认定习惯 | `confidence` 三态 + 只能提案，人审核 | `TestMemoryProposeToolOnlyQueues`、`TestProposalIsNotAMemoryUntilPublished` |
| 废弃的记忆不参与检索 | 归档移出 + 索引重建 | `TestDeprecateRemovesFromSearchAndKeepsTheArchive` |
| 并发更新不静默覆盖 | `expected_revision` + `ConflictError` | `TestUpdateConflictsAreRefused` |
| 索引坏了能重建 | 缺/坏/不一致/mtime 变化都重建 | `TestIndexIsRebuiltFromMarkdown`、`TestExternalEditIsNoticed` |
| 未审核候选不进正式集合 | `candidates/` 与检索隔离 | `TestProposalIsNotAMemoryUntilPublished` |
| 故障不阻断任务、不绕过权限 | open 失败只告警；记忆内容不提升权限 | `TestBrokenFileIsSkippedNotFatal`、`TestMalformedConfigFallsBackToDefaults`、`TestDisabledMemoryAnswersNothing` |

端到端（真二进制）另手验过：`memory_list` → 手写 `entries/mem_001.md` 被解析并进索引 → 手写候选被列出 →
`publish` 生成 `mem_002` 并从候选区消失 → `deprecate` + `publish` 把 `mem_002` 移到
`archive/entries/mem_002-deprecated.md`（带 `deprecated_reason`）→ 索引变回 1 条。

## 十二、后续值得做的（按设计已明确排除的除外）

* 索引行里存 `usage_count` / `last_hit_at`，让面板能显示"这条从没被召回"，但**不**用它自动淘汰。
* `memory_search` 支持按 `scope.paths` 显式过滤（现在只能靠查询里的路径词）。
* 面板支持直接编辑一条正式记忆（现在只能通过模型提案或手工改文件）。
* 候选的 diff 视图（`op=update` 现在只显示新正文，不显示旧正文）。
