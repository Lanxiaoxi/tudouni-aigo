package builtin

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// The rewrites applied to the extractor's Markdown before the model reads it.
//
// Every one of them exists because of something the proof-of-concept measured
// (docs/design/read-document.md, section 4.5), and every one is a pure function of the
// text: no process, no file. That is what makes them testable without the 28 MB binary,
// and it is the reason this file does not import anything that starts one.
//
// The governing rule is **say less, never say something false**. A rewrite may remove
// noise (a repeated install hint, a table of contents) or replace a sentence with a more
// useful one, but it never invents content and it never hides that something was cut.

var (
	// ocrAdvice matches the extractor's "run `anymd setup ocr`" comment, in every variant
	// it is known to print. These lines are removed outright: the advice is to download a
	// 2 GB model, and a model that reads it will cheerfully offer to do so.
	ocrAdvice = regexp.MustCompile("(?i)anymd setup ocr|--ocr auto|ocr: true")
	// scannedPageNote is the per-page form: `<!-- page 3: scanned image, no text layer; … -->`.
	scannedPageNote = regexp.MustCompile(`^<!--\s*page\s+(\d+):\s*scanned image`)
	pageAnchor      = regexp.MustCompile(`^<!--\s*page\s+(\d+)\s*-->$`)
	slideAnchor     = regexp.MustCompile(`^<!--\s*slide\s+(\d+)\s*-->$`)
	sheetAnchor     = regexp.MustCompile(`^<!--\s*sheet\s+(.*?)(?:\s+\(continued\))?\s*-->$`)
	// moreRows is how the extractor says a sheet was cut at its row ceiling. It is plain
	// text with no cursor, which is the whole problem: nothing can resume from it.
	moreRows = regexp.MustCompile(`^(?:…|\.\.\.)\s*(\d+)\s+more rows$`)
	// stoppedFooter carries the cursor of a budget stop. The comment itself is kept
	// verbatim; this only reads the cursor out of it for the audit record.
	stoppedFooter = regexp.MustCompile(`Continue with cursor:\s*"([^"]+)"`)

	tocHeading = regexp.MustCompile(`(?i)^\**\s*(table of contents?|contents|目\s*录)\s*\**$`)
	// tocEntry is one line of a printed table of contents: a number, a tab, a title, a
	// tab, a page number — bold or not, as the sample showed both.
	tocEntry = regexp.MustCompile(`^\**\s*\d+(?:\.\d+)*\.?\t.+\t\d+\**$`)
)

// sheetRowCeiling is how many rows the extractor returns for one sheet before it cuts.
// The message it prints names only the rows that were left out, so the figure that was
// kept is stated here, and a test pins it against the real binary.
const sheetRowCeiling = 2000

// truncatedSheet is one sheet the extractor cut short.
type truncatedSheet struct {
	Name    string
	Dropped int
}

// rewriteOutcome is the rewritten text plus the facts the rewrites learned on the way.
type rewriteOutcome struct {
	Text string
	// ScannedPages lists the pages that had no text layer, sorted.
	ScannedPages []int
	// Truncated lists the sheets that were cut at the row ceiling.
	Truncated []truncatedSheet
	// NextCursor is the cursor the extractor offered at a budget stop, or "".
	NextCursor string
	// TOCLines counts printed table-of-contents lines that were dropped.
	TOCLines int
	// EmptySlides counts slides that carried no text at all.
	EmptySlides int
}

// rewriteDocument applies every rewrite for one extractor output. `format` is one of
// docx / pptx / xlsx / pdf; the two format-specific rewrites (table of contents, empty
// slides) only fire for their own format, so a stray "Contents" heading in a spreadsheet
// is not eaten.
func rewriteDocument(raw, format string) rewriteOutcome {
	text := strings.ReplaceAll(raw, "\r\n", "\n")
	lines := strings.Split(text, "\n")

	// First pass: which pages were scanned. The note for a page comes *after* that page's
	// anchor, so deciding whether to drop the anchor needs to have seen the note.
	scanned := map[int]bool{}
	for _, line := range lines {
		if match := scannedPageNote.FindStringSubmatch(strings.TrimSpace(line)); match != nil {
			if page, err := strconv.Atoi(match[1]); err == nil {
				scanned[page] = true
			}
		}
	}

	var outcome rewriteOutcome
	kept := make([]string, 0, len(lines))
	sheet := ""
	for index := 0; index < len(lines); index++ {
		line := lines[index]
		trimmed := strings.TrimSpace(line)

		if strings.HasPrefix(trimmed, "<!--") && strings.HasSuffix(trimmed, "-->") && ocrAdvice.MatchString(trimmed) {
			continue
		}
		if match := pageAnchor.FindStringSubmatch(trimmed); match != nil {
			if page, err := strconv.Atoi(match[1]); err == nil && scanned[page] {
				continue
			}
		}
		if match := sheetAnchor.FindStringSubmatch(trimmed); match != nil {
			sheet = strings.TrimSpace(match[1])
		}
		if match := moreRows.FindStringSubmatch(trimmed); match != nil {
			dropped, _ := strconv.Atoi(match[1])
			outcome.Truncated = append(outcome.Truncated, truncatedSheet{Name: sheet, Dropped: dropped})
			kept = append(kept, truncationNote(sheet, dropped))
			continue
		}
		if match := stoppedFooter.FindStringSubmatch(trimmed); match != nil {
			// The cursor is kept, the sentence is not: it ends "or raise max_tokens", a knob
			// this tool deliberately does not give the model. The caller writes its own
			// continuation line, with the exact arguments to pass back.
			outcome.NextCursor = match[1]
			continue
		}
		if format == "docx" && tocHeading.MatchString(trimmed) {
			entries, next := consumeTOC(lines, index+1)
			// Three is the floor: a document that merely has a section called "Contents"
			// followed by a numbered list is not a table of contents.
			if entries >= 3 {
				outcome.TOCLines += entries
				kept = append(kept, fmt.Sprintf("（文档自带的目录页共 %d 行，已省略）", entries))
				index = next - 1
				continue
			}
		}
		kept = append(kept, line)
	}

	if format == "pptx" {
		kept, outcome.EmptySlides = annotateEmptySlides(kept)
	}
	if format == "pdf" {
		// The extractor flags a page as scanned only when it saw an image there; a page
		// that is blank, or whose content it could not classify, comes back as a bare
		// anchor (the 13th page of the proof-of-concept sample). To the reader that is the
		// same fact — there is no text to read — so it is folded into the same sentence.
		var empty []int
		kept, empty = dropEmptyPageAnchors(kept, outcome.NextCursor != "")
		for _, page := range empty {
			scanned[page] = true
		}
	}

	for page := range scanned {
		outcome.ScannedPages = append(outcome.ScannedPages, page)
	}
	sort.Ints(outcome.ScannedPages)
	outcome.Text = collapseBlankLines(kept)
	return outcome
}

// consumeTOC walks the lines after a "Table of contents" heading and counts the entries,
// returning how many there were and the index of the first line that is not one.
// Blank lines between entries are part of the block; anything else ends it.
func consumeTOC(lines []string, from int) (entries, next int) {
	next = from
	for index := from; index < len(lines); index++ {
		trimmed := strings.TrimRight(lines[index], " \t\r")
		if strings.TrimSpace(trimmed) == "" {
			continue
		}
		if tocEntry.MatchString(trimmed) {
			entries++
			next = index + 1
			continue
		}
		break
	}
	return entries, next
}

// annotateEmptySlides adds a sentence under a slide anchor that has nothing under it.
//
// "Nothing" means the next non-blank line is another slide anchor or the end of the text.
// A slide followed by a budget footer is deliberately **not** empty: the footer means the
// slide may have been cut off by the budget, and calling it picture-only would be false.
func annotateEmptySlides(lines []string) ([]string, int) {
	out := make([]string, 0, len(lines))
	empty := 0
	for index, line := range lines {
		out = append(out, line)
		if !slideAnchor.MatchString(strings.TrimSpace(line)) {
			continue
		}
		next := index + 1
		for next < len(lines) && strings.TrimSpace(lines[next]) == "" {
			next++
		}
		if next >= len(lines) || slideAnchor.MatchString(strings.TrimSpace(lines[next])) {
			out = append(out, "（此页为纯图形内容，没有可抽取的文字）")
			empty++
		}
	}
	return out, empty
}

// dropEmptyPageAnchors removes page anchors that have nothing under them and returns their
// page numbers. An anchor at the very end is left alone when the read stopped at a budget
// (`stopped`): the page's text may simply not have been reached, and calling it empty
// would be false.
func dropEmptyPageAnchors(lines []string, stopped bool) ([]string, []int) {
	out := make([]string, 0, len(lines))
	var empty []int
	for index, line := range lines {
		match := pageAnchor.FindStringSubmatch(strings.TrimSpace(line))
		if match == nil {
			out = append(out, line)
			continue
		}
		next := index + 1
		for next < len(lines) && strings.TrimSpace(lines[next]) == "" {
			next++
		}
		atEnd := next >= len(lines)
		if (atEnd && !stopped) || (!atEnd && pageAnchor.MatchString(strings.TrimSpace(lines[next]))) {
			if page, err := strconv.Atoi(match[1]); err == nil {
				empty = append(empty, page)
				continue
			}
		}
		out = append(out, line)
	}
	return out, empty
}

// truncationNote replaces "… 1876 more rows" with what it means for the reader: how many
// rows they have, how many they do not, and that there is no way to ask for the rest.
func truncationNote(sheet string, dropped int) string {
	name := "这个 sheet"
	if sheet != "" {
		name = fmt.Sprintf("sheet「%s」", sheet)
	}
	return fmt.Sprintf("> [已截断] %s 到这里为止：已返回前 %d 行，另有 %d 行没有返回，而且读取器不支持续读被截掉的行。"+
		"需要精确数据请用 shell + pandas 读原文件，或让用户先筛选出要看的部分。", name, sheetRowCeiling, dropped)
}

// scannedNote is the single sentence that stands in for N repeated install hints.
// It names the pages, says the text is not there, and says this tool does not OCR. It
// does **not** pass on the extractor's advice to install an OCR engine. What happens to the
// pages next (shown as pictures, or not readable) is appended by the caller, which is the
// one that knows whether the model can see.
func scannedNote(pages []int) string {
	if len(pages) == 0 {
		return ""
	}
	return fmt.Sprintf("[无文字层] 第 %s 页是扫描件、截图或空白页，文字抽取读不到内容（本工具不做 OCR）。",
		pageRanges(pages))
}

// pageRanges renders a sorted page list compactly: 1-13, or 1-3,5,7-8.
func pageRanges(pages []int) string {
	if len(pages) == 0 {
		return ""
	}
	var parts []string
	start, previous := pages[0], pages[0]
	flush := func() {
		if start == previous {
			parts = append(parts, strconv.Itoa(start))
		} else {
			parts = append(parts, fmt.Sprintf("%d-%d", start, previous))
		}
	}
	for _, page := range pages[1:] {
		if page == previous+1 {
			previous = page
			continue
		}
		flush()
		start, previous = page, page
	}
	flush()
	return strings.Join(parts, ",")
}

// collapseBlankLines squeezes runs of blank lines to one and trims the ends, except inside
// a fenced code block, where the blank lines are content (a document that embeds an ASCII
// diagram or a register map is exactly where they matter).
func collapseBlankLines(lines []string) string {
	out := make([]string, 0, len(lines))
	inFence := false
	blank := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			inFence = !inFence
		}
		if !inFence && trimmed == "" {
			if blank {
				continue
			}
			blank = true
			out = append(out, "")
			continue
		}
		blank = false
		out = append(out, strings.TrimRight(line, " \t"))
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

// estimateTokens is a deliberately rough count of what text costs in the model's window.
//
// The extractor budgets in *its* tokens, and the proof of concept measured how far that is
// from ours: 8000 of its tokens came back as ~18,000 Chinese characters, which the window
// charges at close to one token each. Latin text is charged at about four characters a
// token. The estimate only has to be right to within the factor that decides whether to ask
// the extractor for less, so two buckets are enough.
func estimateTokens(text string) int {
	wide, narrow := 0, 0
	for _, r := range text {
		if r >= 0x2E80 {
			wide++
		} else {
			narrow++
		}
	}
	return wide + narrow/4
}

// capText cuts text to at most `limit` characters on a line boundary.
//
// It exists because the extractor's own budget is in *its* tokens, and that is an estimate
// the model's context does not share: a Chinese page costs far more of the real window than
// the same count of English. The cut is stated, and because the extractor's cursor points
// past everything it emitted — including what this cut removes — a cut text must not be
// resumed from that cursor; the caller drops it and says to narrow the range instead.
func capText(text string, limit int) (string, bool) {
	if utf8.RuneCountInString(text) <= limit {
		return text, false
	}
	runes := []rune(text)[:limit]
	cut := string(runes)
	if index := strings.LastIndex(cut, "\n"); index > limit/2 {
		cut = cut[:index]
	}
	return strings.TrimRight(cut, " \t\n"), true
}
