package builtin

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/content"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/process"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/release"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// `read_document`: Word / PowerPoint / Excel / PDF as Markdown, in pieces.
//
// Design, measurements and the reason for every rewrite: docs/design/read-document.md.
// The extractor is a vendored binary (anymd, MIT) pinned at release.AnymdVersion — the one
// place the version is written, so the binary, the release self-check and this file cannot
// disagree.
//
// ## Windows only, on purpose
//
// The tool is registered only where the extractor ships (release.Target.HasAnymd). A remote
// workspace runs the **Linux** runtime on the far host, so the tool is absent there as well:
// it is never offered, and never reported missing — an absent capability that was never
// promised is not a warning. See AnymdBinary.
//
// ## What keeps it out of the context window
//
// A document is the biggest thing a tool can put in front of the model (the proof of concept
// saw a 12MB spreadsheet become 43 million characters), so every limit is held here and none
// is left to the model:
//
//   - the first call on a big document returns a **directory**, not the text;
//   - every read carries a token budget the model cannot raise, and a safety cap on
//     characters behind it, because the extractor's budget is an estimate the real window
//     does not share;
//   - a stop mid-document hands back the cursor and the exact arguments to continue, at the
//     **top** of the result — the bottom is what the preview level of the context ladder
//     cuts first, and a continuation recipe that degrades away is no recipe;
//   - at most documentConcurrency extractions run at once, however many calls a parallel
//     batch holds (each one is hundreds of MB at peak).

// DocumentToolName is the tool's name; the registry, the start-up notice and the context
// layer all refer to it, and three literals are three chances to disagree.
const DocumentToolName = "read_document"

const (
	// documentMaxFileBytes is the largest file the tool will open. It bounds the memory the
	// extractor can be asked to use, and the answer past it is a sentence, not a crash.
	documentMaxFileBytes = 50 * 1024 * 1024
	// documentTimeout is wall-clock per extractor process.
	documentTimeout = 120 * time.Second
	// documentTokenBudget is the extractor's per-call budget. It is not a parameter: the
	// model would raise it, and the proof of concept showed what no budget costs.
	documentTokenBudget = 8000
	// documentSmallBytes is the "read it straight away" line: a document whose whole
	// Markdown is below it costs less than the round trip a directory would.
	documentSmallBytes = 16000
	// documentSoftTokens is what one result may cost the *model's* window (see
	// estimateTokens). When the extractor's own budget overshoots it — Chinese does, by 2x —
	// the read is repeated once with a smaller budget rather than cut, because a cut text has
	// no cursor to continue from and a smaller budget has.
	documentSoftTokens = 12000
	// documentMinBudget is the smallest budget the extractor accepts.
	documentMinBudget = 500
	// documentMaxChars is the last safety net behind both (see capText).
	documentMaxChars = 48000
	// documentMaxOutput bounds what is read from the process at all.
	documentMaxOutput = 4 * 1024 * 1024
	// documentConcurrency is how many extractor processes may run at once.
	documentConcurrency = 2
)

// extractSlots is the semaphore behind documentConcurrency. Package-level because the limit
// is about the machine, not about one registry: a subagent has its own registry and the same
// RAM.
var extractSlots = make(chan struct{}, documentConcurrency)

// AnymdBinary returns the vendored extractor for this machine, or ("", false).
//
// The platform answer comes from release.Target.HasAnymd rather than from a second list
// here: which targets ship the binary is decided once, and the staging step, the layout check
// and this gate all read it.
func AnymdBinary() (string, bool) {
	target, ok := release.HostTarget()
	if !ok || !target.HasAnymd() {
		return "", false
	}
	candidate := filepath.Join(paths.VendorAnymd(), target.Triple, target.AnymdName())
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		return candidate, true
	}
	return "", false
}

// AnymdPlatformSupported reports whether this machine is a platform that ships the
// extractor. The registry uses it to tell "not offered here, by design" (silent) from "should
// be here and is not" (a start-up warning).
func AnymdPlatformSupported() bool {
	target, ok := release.HostTarget()
	return ok && target.HasAnymd()
}

const documentDescription = `读取 Word / PowerPoint / Excel / PDF 文档（docx / pptx / xlsx / pdf）的文字，输出带 <!-- page N --> / <!-- slide N --> / <!-- sheet 名 --> 锚点的 Markdown。read_file 读不了这些二进制文件，要看它们的内容用这个。
定位是「看懂结构、读片段」，不是把整份文档倒进上下文：
- 第一次只传 path：小文档直接返回全文；大文档返回**目录**（章节 / 页 / 幻灯片 / sheet 及各自大小），你再用 pages 或 node 挑要看的部分，不要整份读。
- 每次最多返回约 8000 token，这个上限不可调。被截断时开头会给出 cursor 和续读写法，把它连同原来的 pages / node 一起传回来。
- pages：页码或幻灯片序号范围，如 "1-5,8"；xlsx 里是 sheet 序号，不是页码。docx 没有页，用 node（目录里的 id，如 "n1.5"）。
限制：
- 只读本机工作区里的文件；
- 不做 OCR。PDF 里没有文字层的页（扫描件 / 截图）：当前模型能看图时，这些页会被渲染成图片附在结果后面（每次最多 3 页，一轮最多 12 页，其余的带 pages 分批读），请直接看图；看不了图时只会写明是哪几页，如实转告用户，不要编内容；
- 图片、图表、公式、批注框里的图形不会出现在文本里；
- xlsx 单个 sheet 超过 2000 行会被截断且无法续读。要统计 / 筛选 / 汇总请用 shell + pandas 读原文件，不要靠读文本；
- 不支持旧格式 .doc / .ppt / .xls（请用户另存为 docx / pptx / xlsx）。`

// NewReadDocument builds the tool. It returns (zero, false) when this machine has no
// extractor, signalling the caller not to register it — a model cannot fix a missing binary,
// so it should never see the tool at all.
//
// `vision` and `runID` are the same two facts generate_image reads (Assembly.Vision and
// Assembly.RunID): whether the model in use can be shown pictures, and which turn this is.
// Both may be nil — then scanned pages are only reported, never rendered.
func NewReadDocument(workspace *tools.Workspace, vision func() bool, runID func() string) (tools.Tool, bool) {
	binary, ok := AnymdBinary()
	if !ok {
		return tools.Tool{}, false
	}
	visuals := newDocumentVisuals(vision, runID)
	return tools.Tool{
		Name:        DocumentToolName,
		Description: documentDescription,
		// Low and parallel-safe like read_file: it only reads, inside the workspace, with a
		// size ceiling, and a high-risk label would put an approval in front of every
		// document. Parallelism is bounded separately, by extractSlots.
		Risk:         security.RiskLow,
		ParallelSafe: true,
		Schema: tools.ObjectSchema(map[string]any{
			"path": tools.StringSchema("文档路径（工作区内，相对或绝对都行）", tools.MinLength(1)),
			"pages": tools.StringSchema(
				"页码 / 幻灯片序号范围，如 \"1-5,8\"；xlsx 是 sheet 序号。和 node 二选一"),
			"node": tools.StringSchema(
				"目录里的节点 id，如 \"n1.5\"（docx 没有页，靠它分段）。和 pages 二选一"),
			"cursor": tools.StringSchema(
				"上一次返回里给出的续读游标，如 \"2:16772\"；连同原来的 pages / node 一起传"),
		}, "path"),
		Handler: func(ctx context.Context, args map[string]any) (tools.Result, error) {
			return readDocument(ctx, workspace, binary, visuals, args)
		},
	}, true
}

var (
	pagesPattern  = regexp.MustCompile(`^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$`)
	nodePattern   = regexp.MustCompile(`^n\d+(?:\.\d+)*$`)
	cursorPattern = regexp.MustCompile(`^\d+:\d+$`)
)

// documentRequest is one validated call.
type documentRequest struct {
	display string // the path as the model wrote it
	target  string // the resolved path (or a correctly named copy of it)
	format  string // docx / pptx / xlsx / pdf
	pages   string
	node    string
	cursor  string
	// budget is the extractor's token budget for this run; zero means the default.
	budget int
}

func (r documentRequest) isFirstLook() bool { return r.pages == "" && r.node == "" && r.cursor == "" }

// readDocument is the whole call: resolve, sniff, then either list the directory or read.
func readDocument(turn context.Context, workspace *tools.Workspace, binary string, visuals *documentVisuals, args map[string]any) (tools.Result, error) {
	path, _ := args["path"].(string)
	target, err := workspace.SafePath(path)
	if err != nil {
		// The structured shape read_file and read_image use, so a model that has learned
		// to read one of these recognises the others.
		msg := fmt.Sprintf(`{"ok": false, "error_type": "PermissionError", "message": %q}`, err.Error())
		return tools.TextResult(msg), nil
	}

	pages := compactArg(args["pages"])
	node := compactArg(args["node"])
	cursor := compactArg(args["cursor"])
	if problem := validateDocumentArgs(pages, node, cursor); problem != "" {
		return tools.TextResult(problem), nil
	}

	info, statErr := os.Stat(target)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			return tools.TextResult("文件不存在：" + path + "（先用 list_files 或 grep 找到真实路径）"), nil
		}
		return tools.TextResult("无法读取：" + path + "（" + statErr.Error() + "）"), nil
	}
	if info.IsDir() {
		return tools.TextResult("这是目录，不是文档：" + path + "（列目录里的东西用 list_files）"), nil
	}
	if info.Size() > documentMaxFileBytes {
		return tools.TextResult(fmt.Sprintf(
			"文档太大：%s（%s），超过上限 %s。请用户先拆分或导出需要的部分。",
			path, content.HumanSize(int(info.Size())), content.HumanSize(documentMaxFileBytes))), nil
	}

	format, problem := sniffDocument(target)
	if problem != "" {
		return tools.TextResult(path + "：" + problem), nil
	}

	// The extractor decides by **extension**, and the bytes decide here: a pptx named
	// `.dat`, or a docx with no extension at all, is refused by it. A correctly named copy
	// in the temp directory costs one file copy and turns that into a read.
	readable, cleanup, copyErr := withCanonicalExtension(target, format)
	if copyErr != nil {
		return tools.TextResult("无法读取：" + path + "（" + copyErr.Error() + "）"), nil
	}
	defer cleanup()

	request := documentRequest{display: path, target: readable, format: format, pages: pages, node: node, cursor: cursor}

	if request.isFirstLook() {
		outcome := runExtractor(turn, outlineArgv(binary, readable))
		if text := extractionFailure(request, outcome); text != "" && !outcome.ok() {
			return tools.TextResult(text), nil
		}
		// A directory that cannot be parsed is not a reason to refuse the read: fall
		// through to a budgeted read, which is bounded either way.
		if document, parseErr := parseOutline(outcome.stdout); parseErr == nil && document.totalBytes() > documentSmallBytes {
			return tools.Result{
				Text: renderOutline(path, document),
				Audit: map[string]any{
					"document_format": format, "document_mode": "outline",
					"document_bytes": document.totalBytes(),
				},
			}, nil
		}
	}

	outcome := runExtractor(turn, readArgv(binary, request))
	if !outcome.ok() {
		return tools.TextResult(extractionFailure(request, outcome)), nil
	}
	// The extractor's budget is in its own tokens. If this answer would cost the model's
	// window more than documentSoftTokens, ask again for proportionally less — once. The
	// retry starts from the same cursor, so it is the same stretch, only shorter, and the
	// cursor it ends on is a true one.
	if cost := estimateTokens(outcome.stdout); cost > documentSoftTokens {
		retry := request
		retry.budget = max(documentMinBudget, documentTokenBudget*documentSoftTokens/cost*9/10)
		if second := runExtractor(turn, readArgv(binary, retry)); second.ok() {
			outcome = second
			request = retry
		}
	}
	return assembleDocument(turn, request, outcome.stdout, visuals), nil
}

// compactArg reads an optional string argument, trimmed, with inner spaces removed: "1-5, 8"
// and "1-5,8" are the same request.
func compactArg(value any) string {
	text, _ := value.(string)
	return strings.Join(strings.Fields(text), "")
}

// validateDocumentArgs refuses what the extractor's command line would misread. The values
// reach it as separate arguments (no shell is involved), so this is not about injection; a
// leading dash is a flag, and a flag the model invented is not a read.
func validateDocumentArgs(pages, node, cursor string) string {
	if pages != "" && node != "" {
		return "pages 和 node 不能同时用：按页 / 幻灯片 / sheet 读就只传 pages，按目录节点读就只传 node。这次没有返回内容。"
	}
	if pages != "" && !pagesPattern.MatchString(pages) {
		return "pages 的写法不对：" + pages + "。只能是页码或范围，用逗号分隔，例如 \"3\"、\"1-5,8\"。"
	}
	if node != "" && !nodePattern.MatchString(node) {
		return "node 的写法不对：" + node + "。它必须是目录里给出的 id，例如 \"n1.5\"；不带参数调用一次可以拿到目录。"
	}
	if cursor != "" && !cursorPattern.MatchString(cursor) {
		return "cursor 的写法不对：" + cursor + "。原样使用上一次结果里给出的游标，例如 \"2:16772\"。"
	}
	return ""
}

// sniffDocument identifies a file from its bytes. The extension is deliberately not an
// input: a `.docx` that is really a PDF is common enough, and the wrong answer here is a
// confusing error from the extractor rather than a read.
//
// It returns the format, or a sentence for the model when the file is not one this tool
// reads.
func sniffDocument(target string) (format, problem string) {
	file, err := os.Open(target)
	if err != nil {
		return "", "无法读取（" + err.Error() + "）"
	}
	defer file.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(file, head)
	head = head[:n]
	if n == 0 {
		return "", "文件是空的。"
	}

	switch {
	case bytes.HasPrefix(head, []byte("%PDF")):
		return "pdf", ""
	case bytes.HasPrefix(head, []byte{0xD0, 0xCF, 0x11, 0xE0}):
		return "", "这是旧版二进制 Office 格式（.doc / .ppt / .xls），读不了。请用户在 Word / PowerPoint / Excel 里另存为 docx / pptx / xlsx 再给你。"
	case bytes.HasPrefix(head, []byte("PK\x03\x04")):
		return sniffOOXML(target)
	}
	if utf8.Valid(head) {
		return "", "这看起来是文本文件，不是文档；用 read_file 读。"
	}
	return "", "不是 read_document 支持的文档（支持 docx / pptx / xlsx / pdf）。其他二进制请让用户说明用途。"
}

// sniffOOXML looks inside a zip for the part that names an Office format.
func sniffOOXML(target string) (format, problem string) {
	reader, err := zip.OpenReader(target)
	if err != nil {
		return "", "看起来是 zip 容器，但打不开（文件损坏、被截断，或有密码保护）：" + err.Error()
	}
	defer reader.Close()
	for _, entry := range reader.File {
		switch {
		case entry.Name == "word/document.xml":
			return "docx", ""
		case entry.Name == "ppt/presentation.xml":
			return "pptx", ""
		case entry.Name == "xl/workbook.xml":
			return "xlsx", ""
		}
	}
	return "", "这是 zip 容器，但不是 docx / pptx / xlsx（可能是别的 Office 格式、压缩包或有密码保护的文件）。"
}

// withCanonicalExtension returns a path the extractor will accept. When the file already has
// the extension its content calls for, that is the file itself; otherwise it is a copy under
// the right name in a private temp directory, removed by the returned function.
func withCanonicalExtension(target, format string) (string, func(), error) {
	if strings.EqualFold(filepath.Ext(target), "."+format) {
		return target, func() {}, nil
	}
	dir, err := os.MkdirTemp("", "read-document-")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	source, err := os.Open(target)
	if err != nil {
		cleanup()
		return "", func() {}, err
	}
	defer source.Close()
	copyPath := filepath.Join(dir, "document."+format)
	destination, err := os.Create(copyPath)
	if err != nil {
		cleanup()
		return "", func() {}, err
	}
	if _, err := io.Copy(destination, source); err != nil {
		destination.Close()
		cleanup()
		return "", func() {}, err
	}
	if err := destination.Close(); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return copyPath, cleanup, nil
}

// outlineArgv is the directory request. OCR and image export are off here too: they are the
// two flags that would make an "outline" do work with side effects.
func outlineArgv(binary, file string) []string {
	return []string{binary, "outline", "--format", "json", "--no-ocr", "--images", "none", "--", file}
}

// readArgv is the budgeted read. The fixed flags are the point of the wrapper:
//
//	--no-ocr / --images none   no model downloads, nothing written to the cache
//	--front-matter             the document's total size, which a ranged read would not say
//	--max-tokens               the budget the model cannot change
//
// The model's three values land on three positions only, each already validated, and the
// path after `--` can never be a flag.
func readArgv(binary string, request documentRequest) []string {
	budget := request.budget
	if budget <= 0 {
		budget = documentTokenBudget
	}
	argv := []string{binary, "--no-ocr", "--images", "none", "--front-matter",
		"--max-tokens", fmt.Sprint(budget)}
	if request.pages != "" {
		argv = append(argv, "--pages", request.pages)
	}
	if request.node != "" {
		argv = append(argv, "--node", request.node)
	}
	if request.cursor != "" {
		argv = append(argv, "--cursor", request.cursor)
	}
	return append(argv, "--", request.target)
}

// extraction is how one extractor process ended.
type extraction struct {
	stdout, stderr string
	code           int
	startErr       error
	timedOut       bool
	cancelled      bool
	overflow       bool
	killErr        error
}

func (e extraction) ok() bool {
	return e.startErr == nil && !e.timedOut && !e.cancelled && !e.overflow && e.code == 0
}

// cappedWriter keeps at most `limit` bytes and calls onOver once when more arrives. It
// always reports the write as accepted: failing the write would make the extractor exit with
// a broken-pipe error that reads as a fault of its own.
type cappedWriter struct {
	mu     sync.Mutex
	buf    bytes.Buffer
	limit  int
	over   bool
	onOver func()
}

func (w *cappedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.over {
		return len(p), nil
	}
	if room := w.limit - w.buf.Len(); len(p) > room {
		w.buf.Write(p[:room])
		w.over = true
		if w.onOver != nil {
			go w.onOver()
		}
		return len(p), nil
	}
	w.buf.Write(p)
	return len(p), nil
}

func (w *cappedWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

func (w *cappedWriter) Overflowed() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.over
}

// runExtractor runs one extractor process to the end, a timeout, or the turn being stopped.
//
// Every process is a new one — a cold start measured at about 190ms, against conversions of
// 330–1100ms, so a resident server would save little and keep 200MB of an old document
// around. The tree is killed on every abnormal end: the proof of concept's lesson (and the
// codebase's) is that killing the leader alone leaves its children holding files.
func runExtractor(turn context.Context, argv []string, extraEnv ...string) extraction {
	select {
	case extractSlots <- struct{}{}:
		defer func() { <-extractSlots }()
	case <-turn.Done():
		return extraction{cancelled: true}
	}

	ctx, cancel := context.WithTimeout(turn, documentTimeout)
	defer cancel()

	cmd := exec.Command(argv[0], argv[1:]...)
	// A neutral working directory, not the workspace: the extractor looks around its cwd for
	// configuration, and a file that arrived with a cloned repository must not be able to
	// turn OCR (or anything else) back on.
	cmd.Dir = os.TempDir()
	// The upstream asks for a star on its fifth interactive run; this is not interactive, but
	// a tool must not depend on that guess.
	cmd.Env = append(append(os.Environ(), "ANYMD_NO_STAR_HINT=1"), extraEnv...)

	var killOnce sync.Once
	kill := func() { killOnce.Do(func() { _ = process.TerminateTree(cmd) }) }
	stdout := &cappedWriter{limit: documentMaxOutput, onOver: kill}
	stderr := &cappedWriter{limit: 64 * 1024}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	process.Isolate(cmd)
	if err := cmd.Start(); err != nil {
		return extraction{startErr: err}
	}
	process.Attach(cmd)

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	result := extraction{}
	select {
	case <-done:
	case <-ctx.Done():
		result.killErr = process.TerminateTree(cmd)
		<-done
		if errors.Is(ctx.Err(), context.Canceled) {
			result.cancelled = true
		} else {
			result.timedOut = true
		}
	}
	result.stdout = stdout.String()
	result.stderr = stderr.String()
	result.overflow = stdout.Overflowed()
	if cmd.ProcessState != nil {
		result.code = cmd.ProcessState.ExitCode()
	}
	return result
}

// extractionFailure is the sentence for an extractor run that did not succeed.
func extractionFailure(request documentRequest, outcome extraction) string {
	switch {
	case outcome.startErr != nil:
		return "内置的文档读取器起不来：" + outcome.startErr.Error()
	case outcome.cancelled:
		if outcome.killErr != nil {
			return "这次读取被中断了，而且**没能把读取进程停掉**（" + outcome.killErr.Error() + "）—— 它可能还在跑。这次没有任何结果。"
		}
		return "这次读取被中断了，没有结果。"
	case outcome.timedOut:
		text := fmt.Sprintf("读取超过 %d 秒，已终止，这次没有任何结果。文档可能很大或结构很复杂：先不带参数拿目录，再用 pages / node 只读一小段。",
			int(documentTimeout/time.Second))
		if outcome.killErr != nil {
			text += "（而且没能把进程停掉：" + outcome.killErr.Error() + "）"
		}
		return text
	case outcome.overflow:
		return "读取器的输出异常地大，已终止，这次没有结果。请缩小 pages / node 的范围再试。"
	case outcome.code == 0:
		return ""
	}

	message := cleanExtractorError(request, outcome.stderr)
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "no requested"):
		return "这个范围不存在：" + message + "。先不带参数调用一次拿目录，按目录里的范围读。"
	case strings.Contains(lower, "unknown node"):
		return "没有这个目录节点：" + request.node + "。先不带参数调用一次拿目录，用目录里的 id。"
	case strings.Contains(lower, "not a valid") || strings.Contains(lower, "invalid zip") || strings.Contains(lower, "password") || strings.Contains(lower, "encrypt"):
		return "文档打不开：" + message + "（文件损坏、被截断，或有密码保护）。如实告诉用户。"
	}
	return "读取失败：" + message
}

// cleanExtractorError reduces stderr to its useful line: the first one, with the path the
// extractor was given swapped for the one the model knows (a temp copy's name would only be
// confusing) and its habit of printing the path twice collapsed.
func cleanExtractorError(request documentRequest, stderr string) string {
	line := ""
	for _, candidate := range strings.Split(strings.ReplaceAll(stderr, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(candidate) != "" {
			line = strings.TrimSpace(candidate)
			break
		}
	}
	if line == "" {
		return "（读取器没有给出原因）"
	}
	line = strings.TrimPrefix(line, "anymd: ")
	for _, form := range []string{strings.ReplaceAll(request.target, `\`, `\\`), request.target} {
		line = strings.ReplaceAll(line, form, request.display)
	}
	doubled := request.display + ": " + request.display
	for strings.Contains(line, doubled) {
		line = strings.ReplaceAll(line, doubled, request.display)
	}
	return clipTitle(line, 300)
}

// frontMatter is what the extractor says about the whole document in its header block.
type frontMatter struct {
	// Total is the size of the document in its own unit, e.g. "共 13 页". Empty for formats
	// that have no such count (docx).
	Total string
	// Showing is the part this call covers, as the extractor words it ("pages 1-2").
	Showing string
}

// splitFrontMatter removes the `---` block from the top of the output and keeps the two
// facts worth having. The block also carries the source path (a temp copy's, possibly) and
// the author, neither of which the model needs.
func splitFrontMatter(raw string) (body string, meta frontMatter) {
	text := strings.ReplaceAll(raw, "\r\n", "\n")
	trimmed := strings.TrimLeft(text, "\n")
	if !strings.HasPrefix(trimmed, "---\n") {
		return text, meta
	}
	rest := trimmed[len("---\n"):]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return text, meta
	}
	block := rest[:end]
	body = strings.TrimLeft(rest[end+len("\n---"):], "\n")
	for _, line := range strings.Split(block, "\n") {
		key, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		value = strings.TrimSpace(value)
		switch strings.TrimSpace(key) {
		case "pages":
			meta.Total = "共 " + value + " 页"
		case "slides":
			meta.Total = "共 " + value + " 张幻灯片"
		case "sheets":
			meta.Total = "共 " + value + " 个 sheet"
		case "showing":
			meta.Showing = value
		}
	}
	return body, meta
}

// assembleDocument turns one extractor output into what the model reads.
//
// The order is deliberate. Everything the model **must** act on — what this is, what was
// not readable, how to continue — comes before the body, because the context ladder
// previews the top of an artifact first and a continuation recipe at the bottom would be the
// first thing to go.
func assembleDocument(turn context.Context, request documentRequest, raw string, visuals *documentVisuals) tools.Result {
	body, meta := splitFrontMatter(raw)
	outcome := rewriteDocument(body, request.format)
	text, capped := capText(outcome.Text, documentMaxChars)

	// Scanned pages: say so, and — when the model can see — show them. Only a PDF has such
	// pages; the rewrite never reports them for another format.
	var pictures pageVisuals
	if len(outcome.ScannedPages) > 0 {
		pictures = visuals.resolve(turn, request, outcome.ScannedPages)
	}

	cursor := outcome.NextCursor
	if capped {
		// The extractor's cursor points past everything it emitted, including what the cut
		// just removed. Resuming from it would silently skip text, so it is withheld.
		cursor = ""
	}

	var b strings.Builder
	head := fmt.Sprintf("[read_document] %s · %s", request.display, request.format)
	if meta.Total != "" {
		head += " · " + meta.Total
	}
	head += " · 本次：" + describeScope(request, meta)
	b.WriteString(head + "\n")

	if pictures.Note != "" {
		b.WriteString(pictures.Note + "\n")
	}
	if len(outcome.Truncated) > 0 {
		fmt.Fprintf(&b, "[已截断] 有 %d 个 sheet 超过 %d 行，被截掉的行读不回来（详见正文里的标注）。\n",
			len(outcome.Truncated), sheetRowCeiling)
	}
	if cursor != "" {
		b.WriteString("[续读] 还没读完。再调用 " + continuation(request, cursor) + "\n")
	}
	if capped {
		fmt.Fprintf(&b, "[已截断] 这一段超过 %d 字符，后面的没有返回，也无法用 cursor 续读。请缩小 pages / node 的范围，分几次读。\n",
			documentMaxChars)
	}

	switch {
	case text != "":
		b.WriteString("\n" + text)
	case len(outcome.ScannedPages) == 0:
		b.WriteString("\n（这个范围里没有可抽取的内容。）")
	}
	if cursor != "" {
		b.WriteString("\n\n（以上不是全部：续读写法见开头的 [续读]。）")
	}

	audit := map[string]any{
		"document_format": request.format,
		"document_mode":   "read",
	}
	if request.pages != "" {
		audit["document_pages"] = request.pages
	}
	if request.node != "" {
		audit["document_node"] = request.node
	}
	if len(outcome.ScannedPages) > 0 {
		audit["document_scanned_pages"] = len(outcome.ScannedPages)
		// Whether the pages reached the model. It is the fact that explains a model that says
		// "I could not read the scan" in one session and describes it in another.
		audit["document_pages_rendered"] = len(pictures.Shown)
	}
	if len(outcome.Truncated) > 0 {
		audit["document_truncated_sheets"] = len(outcome.Truncated)
	}
	if cursor != "" {
		audit["document_has_cursor"] = true
	}
	if capped {
		audit["document_capped"] = true
	}
	return tools.Result{Text: b.String(), Audit: audit, Images: pictures.Images}
}

// describeScope says which part of the document this call covered.
func describeScope(request documentRequest, meta frontMatter) string {
	switch {
	case request.cursor != "" && request.pages != "":
		return "pages " + request.pages + " 续读"
	case request.cursor != "" && request.node != "":
		return "node " + request.node + " 续读"
	case request.cursor != "":
		return "续读"
	case request.pages != "":
		return "pages " + request.pages
	case request.node != "":
		return "node " + request.node
	case meta.Showing != "":
		return meta.Showing
	}
	return "从头开始"
}

// continuation spells out the next call, with the arguments that must travel with the cursor.
func continuation(request documentRequest, cursor string) string {
	call := fmt.Sprintf("read_document(path=%q", request.display)
	if request.pages != "" {
		call += fmt.Sprintf(", pages=%q", request.pages)
	}
	if request.node != "" {
		call += fmt.Sprintf(", node=%q", request.node)
	}
	return call + fmt.Sprintf(", cursor=%q)", cursor)
}

// nonTextHint is the sentence read_file appends when a file is not UTF-8 text.
//
// It names read_document **only when the tool is actually registered**: a pointer to a tool
// that is not in the schema sends the model after something it cannot call, and the failure
// looks like the model being stupid (the rule the registry states at the top of Assembly).
// So on Linux, and on a remote workspace, the hint is the plain refusal it always was.
func nonTextHint(path string) string {
	if _, ok := AnymdBinary(); !ok {
		return ""
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".docx", ".pptx", ".xlsx", ".pdf":
		return "。这是文档，请改用 read_document"
	case ".doc", ".ppt", ".xls":
		return "。这是旧版 Office 格式，read_document 也读不了；请用户另存为 docx / pptx / xlsx"
	}
	return ""
}
