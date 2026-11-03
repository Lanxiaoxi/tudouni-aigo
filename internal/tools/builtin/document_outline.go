package builtin

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/content"
)

// outlineNode is one entry of `anymd outline --format json`.
//
// `Start`/`End` are byte offsets into the document's Markdown rendering, which is why a
// node's size can be stated without converting the document: it is the number the
// extractor itself budgets against.
type outlineNode struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Level    int    `json:"level"`
	From     int    `json:"from"`
	To       int    `json:"to"`
	Start    int    `json:"start"`
	End      int    `json:"end"`
	Children int    `json:"children"`
}

type outlineDocument struct {
	Format string        `json:"format"`
	Unit   string        `json:"unit"`
	Nodes  []outlineNode `json:"nodes"`
}

// parseOutline decodes the extractor's JSON. Anything before the first brace is ignored
// (a warning that leaked onto stdout must not make a good outline unreadable).
func parseOutline(raw string) (outlineDocument, error) {
	var document outlineDocument
	if index := strings.Index(raw, "{"); index > 0 {
		raw = raw[index:]
	}
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		return outlineDocument{}, err
	}
	if len(document.Nodes) == 0 {
		return outlineDocument{}, fmt.Errorf("the outline has no nodes")
	}
	return document, nil
}

// totalBytes is the size of the whole document's Markdown, from the root node.
func (d outlineDocument) totalBytes() int {
	root := d.Nodes[0]
	return root.End - root.Start
}

// maxOutlineEntries bounds the listing. A 600-slide deck should not cost 600 lines of
// context before the model has chosen anything.
const maxOutlineEntries = 200

// unitNames gives each unit a noun for the sentence about how big the document is.
var unitNames = map[string]string{
	"slide":   "张幻灯片",
	"page":    "页",
	"sheet":   "个 sheet",
	"section": "个章节",
}

// renderOutline is what the model gets for a document too big to read in one go: how big
// it is, how to read a part of it, and a listing with ids and sizes to choose from.
func renderOutline(display string, document outlineDocument) string {
	root := document.Nodes[0]
	var b strings.Builder

	size := content.HumanSize(document.totalBytes())
	count := ""
	switch document.Unit {
	case "section":
		count = fmt.Sprintf("，%d 个章节", len(document.Nodes)-1)
	default:
		if unit, ok := unitNames[document.Unit]; ok && root.To > 0 {
			count = fmt.Sprintf("，共 %d %s", root.To-root.From+1, unit)
		}
	}
	fmt.Fprintf(&b, "[read_document] %s · %s · 转成文本约 %s%s\n\n", display, document.Format, size, count)
	b.WriteString("文档较大，没有整份返回。先从下面的目录里挑要看的部分，带参数再调用一次 read_document：\n")
	switch document.Unit {
	case "slide":
		b.WriteString("- pages=\"3-5,8\"：按幻灯片序号读；或 node=\"n1.2\"：按目录 id 读\n")
	case "page":
		b.WriteString("- pages=\"3-5,8\"：按页码读；或 node=\"n1.2\"：按目录 id 读\n")
	case "sheet":
		b.WriteString("- pages=\"2\"：按 sheet 序号读（不是页码）\n")
	default:
		b.WriteString("- node=\"n1.5\"：按目录 id 读某一节（docx 没有页，靠它分段）\n")
	}
	b.WriteString("- 每次最多返回约 8000 token；读到一半被截断时，末尾有 cursor，连同原来的 pages / node 一起传回来继续读\n")
	if document.Format == "xlsx" {
		b.WriteString("- 表格数据：单个 sheet 超过 2000 行会被截断且不能续读。要统计、筛选、汇总，请用 shell + pandas，不要靠读文本\n")
	}

	emptyPages := 0
	b.WriteString("\n目录：\n")
	shown := 0
	for _, node := range document.Nodes[1:] {
		if shown >= maxOutlineEntries {
			break
		}
		shown++
		indent := strings.Repeat("  ", max(node.Level-1, 0))
		line := fmt.Sprintf("%s%s  %s", indent, node.ID, clipTitle(node.Title, 80))
		detail := nodeDetail(document.Unit, node)
		if document.Unit == "page" && node.End == node.Start {
			detail = joinDetail(detail, "无文字")
			emptyPages++
		}
		if detail != "" {
			line += "  [" + detail + "]"
		}
		b.WriteString(line + "\n")
	}
	if rest := len(document.Nodes) - 1 - shown; rest > 0 {
		fmt.Fprintf(&b, "…… 还有 %d 项没有列出；用 pages 直接指定范围。\n", rest)
	}
	if len(document.Nodes) == 1 {
		b.WriteString("（文档里没有章节标题，没有可挑的节点。用 node=\"n1\" 从头读，被截断时按 cursor 续读。）\n")
	}
	if document.Unit == "page" && emptyPages > 0 && emptyPages == len(document.Nodes)-1 {
		b.WriteString("\n注意：每一页都没有可抽取的文字，这份 PDF 是扫描件或截图。本工具不做 OCR，读不到内容；请如实告诉用户。\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// nodeDetail is the bracketed part of a listing line: which pages it covers, how big it is.
func nodeDetail(unit string, node outlineNode) string {
	parts := []string{}
	if unit != "section" && node.From > 0 {
		label := unit
		if node.From == node.To {
			parts = append(parts, fmt.Sprintf("%s %d", label, node.From))
		} else {
			parts = append(parts, fmt.Sprintf("%s %d-%d", label, node.From, node.To))
		}
	}
	if size := node.End - node.Start; size > 0 {
		parts = append(parts, content.HumanSize(size))
	}
	return strings.Join(parts, "; ")
}

func joinDetail(detail, extra string) string {
	if detail == "" {
		return extra
	}
	return detail + "; " + extra
}

func clipTitle(title string, limit int) string {
	title = strings.Join(strings.Fields(title), " ")
	if utf8.RuneCountInString(title) <= limit {
		return title
	}
	return string([]rune(title)[:limit]) + "…"
}
