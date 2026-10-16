package builtin

import (
	"context"
	"fmt"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// MaxDeclaredFiles bounds one `present` call.
//
// **The two numbers are different on purpose**, and both are needed. Four is what
// the description recommends: a card row that lists a dozen files has stopped
// being a short list of results and become a directory listing, which the
// workspace browser already is. Eight is what is enforced, and it sits higher so
// that a genuine six-file delivery is accepted rather than argued with — the
// ceiling exists to stop a runaway call, not to second-guess the count.
//
// Raising the ceiling does **not** move the recommendation: the description is a
// literal, so the two are edited together or not at all.
const (
	recommendedDeclaredFiles = 4
	MaxDeclaredFiles         = 8
)

// deliverable is one declared file, in the shape that travels in the audit record
// and then out to the interface.
//
// It is a struct rather than a map so that the two field names are written down
// once: the interface reads `path` and `description` off this, and a map literal
// per call is how a key gets a typo that only shows up as a card with no name.
//
// **No size, no media type, no line count.** All three are facts about the bytes,
// and this tool deliberately does not read the bytes — a declaration that stat'ed
// for a byte count would still not have the media type, and one that read the file
// to derive it would be copying the content the whole capability exists to leave
// where it is. The interface fills those in when somebody opens the file, from the
// read it makes at that moment.
type deliverable struct {
	Path string `json:"path"`
	// Description is optional and stays absent rather than becoming an empty
	// string: "no description" and "the model wrote an empty one" read the same on
	// screen but only the first may fall back to the file type.
	Description string `json:"description,omitempty"`
}

// NewPresent declares finished files to the person.
//
// This is the one file tool that **reads nothing and writes nothing**. What it
// produces is a fact for the interface — "these files are the result, offer them"
// — and the fact travels out through the audit record the tool result already
// carries (`Result.Audit`), not through the model's text.
//
// That split is the design, not an implementation detail:
//
//   - the **model** gets one line per file saying what was declared, because what
//     it needs is confirmation that the call landed;
//   - the **interface** gets `path` and `description` as data, because a card
//     parsed back out of prose is a second description of the same fact, and it
//     breaks the first time the prose is reworded.
//
// A declaration is a statement about a file, so the risk is low — it cannot change
// anything on disk. It is **not** parallel-safe, and that is deliberate: it claims
// "this turn's output is these files", which is a statement about a whole turn
// rather than about one call, and running it inside a batch would mean two
// declarations racing to describe the same turn.
//
// The workspace is the *only* source of truth about what may be declared. Paths
// are resolved through `SafePath`, so `..`, a junction, a symlink pointing out and
// an absolute path elsewhere all fail the same way `write_file` fails them — this
// tool must not become the one door in the boundary, because a card is an
// invitation to open a file and pointing it outside the workspace would be a way
// to get a person to open something the agent is not allowed to touch.
func NewPresent(workspace *tools.Workspace) tools.Tool {
	return tools.Tool{
		Name: "present",
		Description: `把一个已经存在的文件声明为**这次交付给用户的成果**。` +
			`界面上会在回复下方为每个文件显示一张卡片，用户可以从卡片里预览或用自己的默认程序打开它。` +
			`**文件内容不会被复制或上传** —— 卡片指的就是工作区里那个文件本身，改它、删它都会反映在卡片上。

什么时候用：有**独立的交付文件**值得用户单独打开时（导出的文档、表格、幻灯片、图表、图片、生成好的脚本）。1~4 个就够，只挑最重要的。
什么时候不要用：
- 只在回复里提一下某个文件 —— 用行内代码写出路径就够了，界面会把它变成可点的引用；
- 为了罗列你改过的源码文件 —— 那是「改动了什么」，不是「交付了什么」；
- 文件还没写好 —— 先写文件，再声明。文件不存在、是目录、或不在工作区内都会被拒绝。

路径相对于工作区，必须是**已经存在**的普通文件。说明（description）是可选的，写在卡片上的那一行。`,
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"files": tools.ArraySchema(
				fmt.Sprintf("要声明的文件，%d~%d 个。通常 1~2 个最重要的；一次最多 %d 个",
					1, recommendedDeclaredFiles, MaxDeclaredFiles),
				tools.ObjectSchema(map[string]any{
					"path": tools.StringSchema(
						"已存在的文件的路径（相对于工作区）",
						tools.MinLength(1),
					),
					"description": tools.StringSchema(
						"给用户看的一行说明，例如「性能分析报告」；不传就显示文件类型",
					),
				}, "path"),
			),
		}, "files"),
		ParallelSafe: false,
		Interactive:  false,
		Handler: func(_ context.Context, args map[string]any) (tools.Result, error) {
			return present(workspace, args)
		},
	}
}

// present resolves and validates every path before declaring any of them.
//
// **All or nothing, and the order matters.** A call that declared its first three
// files and then refused the fourth would leave the interface showing a partial
// delivery while the model reads an error and concludes nothing was declared —
// two answers to one question, and the one on screen is the wrong one. So the
// whole list is validated first and only then handed back as one result.
func present(workspace *tools.Workspace, args map[string]any) (tools.Result, error) {
	requested, err := declaredFiles(args)
	if err != nil {
		return tools.TextResult(err.Error()), nil
	}

	files := make([]deliverable, 0, len(requested))
	for _, item := range requested {
		path := strings.TrimSpace(item.Path)
		_, err := workspace.InspectFile(path)
		if err != nil {
			message := err.Error()
			// **The boundary is an error and everything else is text**, which is
			// the same split `edit_file` makes and for the same reason: the model
			// can fix a wrong path, a missing file or a directory by choosing
			// differently, and cannot fix "outside the workspace" — retrying that
			// one only burns a step.
			if isBoundaryRefusal(message) {
				return tools.Result{}, fmt.Errorf("refusing to present %s: %s", path, message)
			}
			return tools.TextResult(presentRefusal(path, message)), nil
		}
		files = append(files, deliverable{Path: path, Description: strings.TrimSpace(item.Description)})
	}

	lines := make([]string, 0, len(files))
	for _, file := range files {
		lines = append(lines, "Presented "+file.Path)
	}
	// The tail sentence is not decoration: without it the model reasonably reads
	// "Presented" as "uploaded", and then either re-declares the same file on the
	// next turn or explains to the user that a copy now exists somewhere.
	return tools.Result{
		Text: strings.Join(lines, "\n") +
			"\nThe files stay where they are — the user opens them from the card, and no copy was made.",
		Audit: map[string]any{
			// The key the interface folds on. One field, not one entry per file:
			// the card is a row for the turn, and emitting a separate audit record
			// per file would make "how many declarations were there" a count of
			// records rather than of calls.
			"deliverables": files,
		},
	}, nil
}

// declaredFiles pulls the argument array into a shape the rest of this file can
// read, and enforces the count.
//
// The count is checked here rather than in the schema because the schema describes
// one item, not the length of the list: `minItems` / `maxItems` are not in the
// validator, and a limit that is declared but unenforced is worse than a documented
// recommendation — the model reads "at most 8", sends 9, and the call succeeds.
func declaredFiles(args map[string]any) ([]deliverable, error) {
	raw, _ := args["files"].([]any)
	if len(raw) == 0 {
		return nil, fmt.Errorf("present needs at least one file (files: [{path, description?}])")
	}
	if len(raw) > MaxDeclaredFiles {
		return nil, fmt.Errorf("present accepts 1 to %d files, got %d", MaxDeclaredFiles, len(raw))
	}
	out := make([]deliverable, 0, len(raw))
	for _, entry := range raw {
		item, _ := entry.(map[string]any)
		path, _ := item["path"].(string)
		description, _ := item["description"].(string)
		out = append(out, deliverable{Path: path, Description: description})
	}
	return out, nil
}

// isBoundaryRefusal reports whether a `SafePath` failure is the workspace
// boundary rather than a fact about the file.
//
// Two spellings reach here — the escape itself and the link walk — and both mean
// the same thing to the caller: this path is not one this program will talk about,
// whatever it does or does not contain.
func isBoundaryRefusal(message string) bool {
	return strings.Contains(message, "escapes workspace") ||
		strings.Contains(message, "goes through a link")
}

// presentRefusal names an ordinary failure in the model's terms, and names
// **which** one it is.
//
// The three call for three different next moves — pick another path, create the
// file first, stop pointing at a directory — and a single "cannot present" would
// be retried unchanged. The path is echoed back because the model may have built
// it from a variable, and "not found" without the path is a message it cannot act
// on.
func presentRefusal(path, message string) string {
	switch {
	case strings.Contains(message, "File not found"):
		return "文件不存在：" + path + "（先写文件，再声明它）"
	case strings.Contains(message, "Not a regular file"):
		return "不是普通文件：" + path + "（目录不能作为交付物；要列目录里的东西用 list_files）"
	case strings.Contains(message, "Permission denied"):
		return "没有权限读取：" + path
	default:
		return "无法声明：" + path + "（" + message + "）"
	}
}
