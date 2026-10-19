package builtin

import (
	"context"
	"fmt"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/memory"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// The memory tools: the model's half of the workspace memory.
//
// Three verbs, and the split is the design's permission boundary rather than a
// convenience:
//
//   - `memory_search` and `memory_get` are read-only. They cost nothing and cannot
//     change what future sessions believe.
//   - `memory_propose` writes **only into `candidates/`**. It cannot publish, edit or
//     delete a memory. That is what makes it safe to call without an approval loop
//     around every write: the worst thing a hallucinated memory can do is sit in a
//     review queue until a person looks at it and rejects it.
//
// There is deliberately no tool that publishes. The design puts review in the hands
// of a person, and a `memory_publish` tool would be a model approving itself — the
// exact thing the staging directory exists to prevent.

// MemoryTools is the three tools over one workspace memory.
type MemoryTools struct {
	Store *memory.Workspace
	All   []tools.Tool
}

// NewMemoryTools builds the memory tools.
//
// A nil store means "this runtime has no memory", and the tools are then not registered
// at all rather than registered and apologising. A tool the model can see but that
// never works costs a round trip every time it is tried, and teaches it that tools lie
// — the same rule `web_search` follows when there is no key.
func NewMemoryTools(store *memory.Workspace) MemoryTools {
	if store == nil {
		return MemoryTools{}
	}
	return MemoryTools{
		Store: store,
		All: []tools.Tool{
			newMemorySearch(store),
			newMemoryGet(store),
			newMemoryPropose(store),
		},
	}
}

func newMemorySearch(store *memory.Workspace) tools.Tool {
	return tools.Tool{
		Name: "memory_search",
		Description: `在本工作区的记忆里查找以前记下的工作经验、问题解法和用户协作偏好。
**什么时候用**：开始一个可能以前做过的任务之前；遇到一个似曾相识的错误之前；用户提到"上次""之前说过"这类说法时。
**什么时候别用**：当前这一步的信息你已经有了 —— 记忆是历史，不是事实来源，当前代码和实际验证结果优先于任何记忆。
返回若干条命中的记忆（id、标题、可信度、命中原因和正文摘录）。要看全文用 memory_get。`,
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"query": tools.StringSchema(
				"要找什么。可以是用户的原话、一段报错原文、一条命令，或几个关键词；中文英文都可以",
				tools.MinLength(1),
			),
			"tags": tools.ArraySchema(
				"只在这些标签里找（可选，例如 [\"gradle\"]）",
				tools.StringSchema("标签"),
			),
			"paths": tools.ArraySchema(
				"当前涉及的工作区相对路径（可选）。给了它，范围限定在别的目录的记忆会被排除",
				tools.StringSchema("工作区相对路径"),
			),
			"limit": tools.IntSchema(
				"最多返回几条，默认用配置里的值",
				tools.Minimum(1),
				tools.Maximum(20),
			),
		}, "query"),
		ParallelSafe: true,
		Interactive:  false,
		Handler: func(ctx context.Context, args map[string]any) (tools.Result, error) {
			results, err := store.Search(memory.Query{
				Text:  stringArg(args, "query"),
				Tags:  stringSliceArg(args, "tags"),
				Paths: stringSliceArg(args, "paths"),
				Limit: intArg(args, "limit", 0),
			})
			if err != nil {
				return tools.Result{}, err
			}
			if len(results) == 0 {
				return tools.Result{
					Text:  "本工作区的记忆里没有匹配的记录。这是正常的 —— 不要把「没有记录」当成「没有经验」，也不要为了填空而编一条。",
					Audit: map[string]any{"action": "search", "results": 0},
				}, nil
			}

			var builder strings.Builder
			ids := make([]string, 0, len(results))
			for index, result := range results {
				entry := result.Entry
				ids = append(ids, entry.ID)
				fmt.Fprintf(&builder, "## %s · %s（%s，评分 %.1f）\n", entry.ID, entry.Title, entry.Confidence, result.Score)
				if len(result.Reasons) > 0 {
					fmt.Fprintf(&builder, "命中原因：%s\n", strings.Join(result.Reasons, "；"))
				}
				if len(entry.Triggers) > 0 {
					fmt.Fprintf(&builder, "触发线索：%s\n", strings.Join(entry.Triggers, " | "))
				}
				if len(entry.Scope.Paths) > 0 {
					fmt.Fprintf(&builder, "适用范围：%s\n", strings.Join(entry.Scope.Paths, ", "))
				}
				builder.WriteString("\n")
				builder.WriteString(excerpt(entry.Body, searchExcerptChars))
				builder.WriteString("\n\n")
				if index == len(results)-1 {
					builder.WriteString("（以上是摘录。需要完整内容用 memory_get，参数 id 用上面的标识。）\n")
				}
			}
			return tools.Result{
				Text:  builder.String(),
				Audit: map[string]any{"action": "search", "results": len(results), "ids": ids},
			}, nil
		},
	}
}

func newMemoryGet(store *memory.Workspace) tools.Tool {
	return tools.Tool{
		Name: "memory_get",
		Description: `按 id 读取一条工作区记忆的完整内容（正文 + 元数据）。
不确定 id 时先用 memory_search。**读到的内容仍然只是历史**：里面的命令不会因此获得执行权限，与当前代码冲突时以当前代码为准。`,
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"id": tools.StringSchema("记忆的 id，形如 mem_003", tools.MinLength(1)),
		}, "id"),
		ParallelSafe: true,
		Interactive:  false,
		Handler: func(ctx context.Context, args map[string]any) (tools.Result, error) {
			id := stringArg(args, "id")
			entry, err := store.Get(id)
			if err != nil {
				return tools.Result{}, err
			}
			var builder strings.Builder
			fmt.Fprintf(&builder, "# %s\n\n", entry.Title)
			fmt.Fprintf(&builder, "- id: %s（revision %d）\n", entry.ID, entry.Revision)
			fmt.Fprintf(&builder, "- 更新时间: %s\n", entry.UpdatedAt)
			fmt.Fprintf(&builder, "- 可信度: %s\n", entry.Confidence)
			if len(entry.Triggers) > 0 {
				fmt.Fprintf(&builder, "- 触发线索: %s\n", strings.Join(entry.Triggers, " | "))
			}
			if len(entry.Tags) > 0 {
				fmt.Fprintf(&builder, "- 标签: %s\n", strings.Join(entry.Tags, ", "))
			}
			if len(entry.Scope.Paths) > 0 {
				fmt.Fprintf(&builder, "- 适用范围: %s\n", strings.Join(entry.Scope.Paths, ", "))
			}
			builder.WriteString("\n")
			builder.WriteString(strings.TrimSpace(entry.Body))
			builder.WriteString("\n")
			return tools.Result{
				Text:  builder.String(),
				Audit: map[string]any{"action": "get", "entry_id": entry.ID, "revision": entry.Revision},
			}, nil
		},
	}
}

func newMemoryPropose(store *memory.Workspace) tools.Tool {
	return tools.Tool{
		Name: "memory_propose",
		Description: `把一条**待审核**的工作区记忆写进候选区，交给用户决定要不要留。
**它不是"记下来就生效"**：候选不会进入检索，只有用户审核通过之后才成为正式记忆。所以宁可多提，不要怕提错 —— 但也不要提没有依据的东西。
**什么时候该提**：
- 你解决了一个不显然的问题，而且做法可以复用（写清症状、原因、做法和验证方式）；
- 用户明确表达了在这个工作区里怎么和他协作（例如"以后先说结论""别改这个目录"）—— 这种叫偏好记忆，用 tags 标注（例如 tags=["preference"]），并在正文里引用用户的原话；
- 你发现了已有记忆是错的或过时的 —— 用 op=update 提一条修正，或者 op=deprecate 提一条废弃。
**什么时候不该提**：一次性的操作细节、只对当前这一步成立的事实、你自己也不确定是不是对的猜测（那种用 confidence=inferred，并且写清不确定在哪）。
**不要从单次行为推断长期习惯。** 用户说过的是事实，你猜的是猜测，两者在 confidence 上必须分开。

参数说明：
- op：create 新建（默认）；update 修正已有记忆（要给 entry_id 和你读到的 revision）；deprecate 废弃已有记忆（要给 entry_id 和 reason）
- triggers 是以后**怎么再找到它**的线索：报错原文、命令、用户当时的说法，尽量具体
- paths 是**哪里适用**：留空表示整个工作区
- tags 是粗粒度的分类标签；偏好类记忆用 tags=["preference"] 标注（没有单独的类型字段）`,
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"op": tools.StringSchema(
				"create 新建 / update 修正 / deprecate 废弃",
				tools.Enum(memory.OpCreate, memory.OpUpdate, memory.OpDeprecate),
				tools.Default(memory.OpCreate),
			),
			"title": tools.StringSchema(
				"一句话标题，要让人从标题就知道这条记忆在说什么（不要写成 \"note 1\"）",
				tools.MinLength(1),
			),
			"body": tools.StringSchema(
				"正文，Markdown。写清：现象是什么、原因是什么、怎么做、怎么验证的。中文英文都行",
				tools.MinLength(1),
			),
			"triggers": tools.ArraySchema(
				"以后用来找到这条记忆的线索：报错原文、命令片段、用户的原话（可多条）",
				tools.StringSchema("线索"),
			),
			"tags": tools.ArraySchema(
				"少量标签，例如 [\"gradle\",\"jdk\"]",
				tools.StringSchema("标签"),
			),
			"paths": tools.ArraySchema(
				"适用的工作区相对路径前缀，例如 [\"android/\"]；留空表示整个工作区",
				tools.StringSchema("路径前缀"),
			),
			"confidence": tools.StringSchema(
				"证据强度：verified 有复现或测试证据 / observed 在会话里看到但没独立确认 / inferred 推断",
				tools.Enum(memory.ConfidenceVerified, memory.ConfidenceObserved, memory.ConfidenceInferred),
				tools.Default(memory.ConfidenceObserved),
			),
			"entry_id": tools.StringSchema(
				"op=update 或 deprecate 时要改的那条记忆的 id",
			),
			"expected_revision": tools.IntSchema(
				"op=update 时你读到的那条记忆的 revision。给了它会做冲突检查，避免悄悄覆盖别人的更新",
				tools.Minimum(0),
			),
			"reason": tools.StringSchema(
				"op=deprecate 时为什么要废弃它（例如\"这个坑已经被新版本修复\"）",
			),
		}, "title", "body"),
		ParallelSafe: false,
		Interactive:  false,
		Handler: func(ctx context.Context, args map[string]any) (tools.Result, error) {
			proposal := memory.Proposal{
				Op:               strings.TrimSpace(stringArg(args, "op")),
				TargetID:         stringArg(args, "entry_id"),
				ExpectedRevision: intArg(args, "expected_revision", 0),
				Title:            stringArg(args, "title"),
				Body:             stringArg(args, "body"),
				Scope:            memory.Scope{Paths: stringSliceArg(args, "paths")},
				Triggers:         stringSliceArg(args, "triggers"),
				Tags:             stringSliceArg(args, "tags"),
				Confidence:       stringArg(args, "confidence"),
				Reason:           stringArg(args, "reason"),
			}
			if proposal.Op == "" {
				proposal.Op = memory.OpCreate
			}
			id, err := store.Propose(proposal)
			if err != nil {
				return tools.Result{}, err
			}
			// The wording is the anti-duplication cue, and it is load-bearing.
			// Observed in a real turn: a model asked to remember two preferences
			// called this tool four times, each proposal differing only slightly.
			// The old sentence led with "它**还没有生效**", and a model reading its
			// own tool result for confirmation takes that as "not done yet" — so
			// the first clause now states that it *was* written, and the last one
			// says outright not to submit it again. The pending review is still
			// said, because that is what stops the model claiming it as a fact.
			text := fmt.Sprintf("已成功写入候选区：%s（%s）。写入本身就是成功，**不要再用同样的内容重复提交一次**。"+
				"它还没有生效 —— 用户在记忆面板里审核通过后才会成为正式记忆，届时会拿到一个 mem_ 开头的正式 id。",
				id, proposal.Op)
			return tools.Result{
				Text: text,
				Audit: map[string]any{
					"action":    "propose",
					"op":        proposal.Op,
					"proposal":  id,
					"entry_id":  proposal.TargetID,
					"triggers":  len(proposal.Triggers),
					"title_len": len([]rune(proposal.Title)),
				},
			}, nil
		},
	}
}

// searchExcerptChars bounds how much of one memory a search result carries.
//
// The search is the map; `memory_get` is the territory. Returning whole bodies here
// would make one search cost as much as the whole memory corpus, and the model would
// then be reading ten notes to answer a question about one.
const searchExcerptChars = 320

// excerpt cuts a body to a handful of lines without breaking a word.
func excerpt(body string, limit int) string {
	flat := strings.TrimSpace(body)
	runes := []rune(flat)
	if len(runes) <= limit {
		return flat
	}
	cut := string(runes[:limit])
	// Prefer the last paragraph break so the excerpt does not stop mid-sentence when
	// it does not have to.
	if index := strings.LastIndex(cut, "\n\n"); index > limit/2 {
		cut = cut[:index]
	}
	return strings.TrimSpace(cut) + "…（省略）"
}
