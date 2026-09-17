// Package builtin holds the agent's standard tools: the ones that ship with the
// runtime rather than coming from an MCP server. Each file is one tool (group); a
// tool that needs a workspace gets it injected, mirroring how FileSystem(workspace)
// works in the Python original.
package builtin

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// NewFileTools builds the four file-system tools, all bound to the same workspace.
//
// read_file / list_files are parallel-safe (read-only, no shared state); write_file
// and edit_file are not, because two concurrent writes can silently overwrite each
// other (the classic lost-update), and both would report success.
func NewFileTools(workspace *tools.Workspace) []tools.Tool {
	return []tools.Tool{
		{
			Name:        "read_file",
			Description: "读取指定文件的全部内容（按 UTF-8 解码，不分页）。文件不存在、路径指向目录、或超出工作区都会报错。",
			Risk:        security.RiskLow,
			Schema: tools.ObjectSchema(map[string]any{
				"path": tools.StringSchema("文件路径", tools.MinLength(1)),
			}, "path"),
			Handler: func(args map[string]any) (tools.Result, error) {
				return readFile(workspace, args)
			},
			ParallelSafe: true,
		},
		{
			Name:        "write_file",
			Description: "把内容写入指定文件。整个文件会被替换 —— 不是追加，也不是局部修改；缺失的父目录会自动创建。所以要改动一个已存在的文件，必须先 read_file 读出原文，再基于真实内容写出完整的新文本：凭记忆或凭猜测写会丢数据。只改其中一小段（尤其是文件很长时）应该用 edit_file，不必把整篇正文背出来写回去。",
			Risk:        security.RiskMedium,
			Schema: tools.ObjectSchema(map[string]any{
				"path":    tools.StringSchema("文件路径", tools.MinLength(1)),
				"content": tools.StringSchema("文件内容"),
			}, "path", "content"),
			Handler: func(args map[string]any) (tools.Result, error) {
				return writeFile(workspace, args)
			},
		},
		{
			Name: "edit_file",
			// The description is the model's only guide to choosing edit_file over
			// write_file, so it carries the "why edit, not overwrite" explanation.
			Description: `把文件里的一段原文替换成新内容，是修改已有文件的首选方式 —— 文件其余部分不经你的手，所以不会因为把没动过的内容背错而丢数据。
old_string 必须和文件里的原文**逐字符一致**（含缩进和换行），因此通常要先 read_file 看清原文；凭记忆拼出来的片段会在匹配失败时被打回。
old_string 在文件里出现多次时，默认拒绝执行并要你把它改得唯一，除非显式设 replace_all=true。文件不存在、或不是 UTF-8 文本，都改不了（新建文件用 write_file）。`,
			Risk: security.RiskMedium,
			Schema: tools.ObjectSchema(map[string]any{
				"path": tools.StringSchema("要修改的文件路径", tools.MinLength(1)),
				"old_string": tools.StringSchema(
					"要被替换掉的原文片段，必须和文件里的内容逐字符一致（含缩进和换行）",
					tools.MinLength(1),
				),
				"new_string": tools.StringSchema("替换成的新内容；传空串表示删除这段"),
				"replace_all": tools.BoolSchema(
					"old_string 在文件里出现多次时：true 表示全部替换，false（默认）会拒绝执行并要求把 old_string 改得更长、更唯一",
					tools.Default(false),
				),
			}, "path", "old_string"),
			Handler: func(args map[string]any) (tools.Result, error) {
				return editFile(workspace, args)
			},
		},
		{
			Name:        "list_files",
			Description: "列出目录下的条目名字。只列一层、不递归，也不返回大小、类型或修改时间。要摸清目录结构就逐层调用；目录不存在或路径不是目录会报错。",
			Risk:        security.RiskLow,
			Schema: tools.ObjectSchema(map[string]any{
				"path": tools.StringSchema("目录路径（相对于工作区），默认为工作区根目录", tools.MinLength(1), tools.Default(".")),
			}),
			Handler: func(args map[string]any) (tools.Result, error) {
				return listFiles(workspace, args)
			},
			ParallelSafe: true,
		},
	}
}

// readFile resolves inside the workspace and reports failures as text the model
// can read, never as a panic. An escape is surfaced as a structured message so the
// model can see "this is a permission error", not just a failure.
func readFile(workspace *tools.Workspace, args map[string]any) (tools.Result, error) {
	path, _ := args["path"].(string)
	target, err := workspace.SafePath(path)
	if err != nil {
		msg := fmt.Sprintf(`{"ok": false, "error_type": "PermissionError", "message": %q}`, err.Error())
		return tools.TextResult(msg), nil
	}
	info, statErr := os.Stat(target)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			return tools.TextResult("文件不存在：" + path), nil
		}
		return tools.TextResult("无法读取：" + path + "（" + statErr.Error() + "）"), nil
	}
	if info.IsDir() {
		return tools.TextResult("不是文件：" + path + "（要列目录里的东西用 list_files）"), nil
	}
	raw, readErr := os.ReadFile(target)
	if readErr != nil {
		return tools.TextResult("无法读取：" + path + "（" + readErr.Error() + "）"), nil
	}
	if !utf8.Valid(raw) {
		return tools.TextResult("不是 UTF-8 文本，读不了：" + path), nil
	}
	return tools.TextResult(string(raw)), nil
}

// writeFile delegates to the workspace, which enforces both the boundary and the
// control plane. A refused write is reported as text, not as a thrown error, so the
// model sees why and can pick another path.
func writeFile(workspace *tools.Workspace, args map[string]any) (tools.Result, error) {
	path, _ := args["path"].(string)
	content, _ := args["content"].(string)
	result, err := workspace.WriteFile(path, content)
	if err != nil {
		return tools.TextResult(writeFileError(path, err.Error())), nil
	}
	return tools.TextResult(result), nil
}

func writeFileError(path, msg string) string {
	switch {
	case strings.Contains(msg, "control plane"):
		return "控制面路径不可写：被拒绝（" + path + " 这块只有人和程序自己能写）"
	case strings.Contains(msg, "Path escapes workspace"):
		return "路径越界：被拒绝（" + path + " 超出工作区）"
	default:
		return "无法写入：" + path + "（" + msg + "）"
	}
}

// editFile is the file modifier. Expected failures (not found, is a dir, not UTF-8,
// no match, ambiguous match) are text results the model can act on. Only the boundary
// and the control plane are returned as real errors, because those are not something
// the model can route around with better arguments.
func editFile(workspace *tools.Workspace, args map[string]any) (tools.Result, error) {
	path, _ := args["path"].(string)
	oldString, _ := args["old_string"].(string)
	newString, _ := args["new_string"].(string)
	replaceAll, _ := args["replace_all"].(bool)

	target, err := workspace.WritablePath(path)
	if err != nil {
		// The model cannot fix an out-of-bounds or control-plane path by editing
		// the arguments, so this is a genuine error rather than a friendly refusal.
		return tools.Result{}, err
	}
	info, statErr := os.Stat(target)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			return tools.TextResult("文件不存在：" + path + "（edit_file 只改已存在的文件；新建用 write_file）"), nil
		}
		return tools.TextResult("无法读取：" + path + "（" + statErr.Error() + "）"), nil
	}
	if info.IsDir() {
		return tools.TextResult("不是文件：" + path + "（要列目录里的东西用 list_files）"), nil
	}
	raw, readErr := os.ReadFile(target)
	if readErr != nil {
		return tools.TextResult("无法读取：" + path + "（" + readErr.Error() + "）"), nil
	}
	if !utf8.Valid(raw) {
		return tools.TextResult("不是 UTF-8 文本，改不了：" + path), nil
	}

	// Read bytes verbatim so line endings are untouched. The model's old_string
	// comes from read_file, which normalised to "\n"; align both fragments to the
	// file's own convention before comparing. This way an LF fragment edits a CRLF
	// file and the rest of the bytes stay exactly as they were.
	original := string(raw)
	newline := "\n"
	if strings.Contains(original, "\r\n") {
		newline = "\r\n"
	}
	old := alignNewline(oldString, newline)
	new := alignNewline(newString, newline)

	if old == new {
		return tools.TextResult(path + " 没有变化：old_string 和 new_string 是同一段内容"), nil
	}

	occurrences := strings.Count(original, old)
	if occurrences == 0 {
		return tools.TextResult("在 " + path + " 里找不到 old_string，文件没有被改动。\n" +
			"先 read_file 读一遍原文 —— 缩进和换行必须逐字符一致，凭记忆拼出来的片段通常就差在这里。"), nil
	}
	if occurrences > 1 && !replaceAll {
		return tools.TextResult("old_string 在 " + path + " 里出现了 " + strconv.Itoa(occurrences) +
			" 次，无法确定改哪一处，文件没有被改动。\n" +
			"想只改一处：把 old_string 前后多带几行，让它唯一。想全部改：设 replace_all=true。"), nil
	}

	var replaced string
	if replaceAll {
		replaced = strings.ReplaceAll(original, old, new)
	} else {
		// Go's string -> []byte write does no newline translation, so the remaining
		// bytes are written back exactly as read.
		replaced = strings.Replace(original, old, new, 1)
	}
	if writeErr := os.WriteFile(target, []byte(replaced), 0o644); writeErr != nil {
		return tools.TextResult("无法写入：" + path + "（" + writeErr.Error() + "）"), nil
	}

	if replaceAll {
		return tools.TextResult("已替换全部 " + strconv.Itoa(occurrences) + " 处"), nil
	}
	return tools.TextResult("已替换 " + path + " 里 1 处"), nil
}

// alignNewline folds "\r\n" to "\n" and then expands "\n" to the file's own ending.
// This is what lets an LF fragment match inside a CRLF file.
func alignNewline(fragment, newline string) string {
	fragment = strings.ReplaceAll(fragment, "\r\n", "\n")
	if newline == "\n" {
		return fragment
	}
	return strings.ReplaceAll(fragment, "\n", newline)
}

// listFiles lists one directory level, one name per line.
func listFiles(workspace *tools.Workspace, args map[string]any) (tools.Result, error) {
	path, _ := args["path"].(string)
	if path == "" {
		path = "."
	}
	names, err := workspace.ListDir(path)
	if err != nil {
		return tools.TextResult(listFilesError(path, err.Error())), nil
	}
	if len(names) == 0 {
		return tools.TextResult("（空目录）"), nil
	}
	return tools.TextResult(strings.Join(names, "\n")), nil
}

func listFilesError(path, msg string) string {
	if strings.Contains(msg, "Directory not found") {
		return "目录不存在：" + path
	}
	return "不是目录：" + path + "（列目录要传目录路径）"
}
