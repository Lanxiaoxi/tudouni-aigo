package builtin

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/process"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// itoa is the local int→string used throughout the builtin tools.
func itoa(n int) string { return strconv.Itoa(n) }

// grep limits. Each one has its own reason; together they keep a search bounded
// in time, in files, in lines per file, in line length, and in total output.
const (
	// Most files to list. 50 is enough to see the distribution of a hit, not just
	// the first five the model would then assume were the only ones.
	GREP_MAX_FILES = 50
	// Lines per file. Deliberately tighter than MAX_FILES: a file name is worth
	// more than a line — the model can read_file the rest.
	GREP_MAX_MATCHES_PER_FILE = 20
	// One line at most. A minified JS line can be hundreds of thousands of chars;
	// the line number is the locator the model needs, not the whole line.
	GREP_MAX_LINE_CHARS = 200
	// Total output budget; the head/tail truncation kicks in past this.
	GREP_MAX_OUTPUT_CHARS = 16000
	// The widest the model may set max_files. Bounds the worst case the same way
	// shell's timeout does.
	GREP_MAX_MAX_FILES = 200
	// Wall-clock cap. It replaces the old byte budget: with ripgrep the cost is
	// time, not bytes. A timeout returns nothing at all, by design.
	GREP_TIMEOUT_SECONDS = 10
)

// hostTriple returns the ripgrep release target for this machine, or false when
// this platform ships no bundled binary. Only x86_64 Windows and Linux are
// supported — each binary is a few MB into git, so adding a platform is a
// deliberate choice, not "why not".
func hostTriple() (string, bool) {
	switch runtime.GOOS {
	case "windows":
		if runtime.GOARCH == "amd64" {
			return "x86_64-pc-windows-msvc", true
		}
	case "linux":
		if runtime.GOARCH == "amd64" {
			return "x86_64-unknown-linux-musl", true
		}
	}
	return "", false
}

// RgBinary returns the path to the bundled ripgrep, or ("", false) when this
// platform has no binary. The false case is "this environment is incomplete", not
// "this search found nothing" — the caller decides not to register the tool.
func RgBinary() (string, bool) {
	triple, ok := hostTriple()
	if !ok {
		return "", false
	}
	name := "rg"
	if runtime.GOOS == "windows" {
		name = "rg.exe"
	}
	candidate := filepath.Join(paths.VendorRG(), triple, name)
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		return candidate, true
	}
	return "", false
}

// NewGrep builds the grep tool. It returns (zero, false) when no ripgrep binary
// exists for this platform, signalling the caller not to register the tool — a
// model cannot fix a missing binary, so it should never see the tool at all.
func NewGrep(workspace *tools.Workspace) (tools.Tool, bool) {
	binary, ok := RgBinary()
	if !ok {
		return tools.Tool{}, false
	}
	return tools.Tool{
		Name: "grep",
		Description: "在工作区里按正则递归搜文本，返回**命中的文件、行号和那一行**。" +
			"它只回答「哪儿有」，不替你读正文：想知道「那儿是什么」要 read_file。\n" +
			"默认最多列 " + itoa(GREP_MAX_FILES) + " 个有命中的文件、每个文件 " +
			itoa(GREP_MAX_MATCHES_PER_FILE) + " 条命中；" +
			"有命中的文件更多时只列最前面的那些，但会告诉你一共有几个路径命中。" +
			"隐藏路径排在后面，不跳过任何文件（.gitignore 和 .venv 里的也照样搜）。\n" +
			"搜文本用这个工具，不要拿 shell 去起 Select-String / findstr / rg —— " +
			"那条路每次都要人工审批。",
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"pattern": tools.StringSchema(
				"正则表达式（Rust regex 方言：不支持反向引用 \\1 和环视 (?=...)，支持 \\p{...} 和内联 (?i)）",
				tools.MinLength(1)),
			"path": tools.StringSchema(
				"从哪个目录开始搜（相对于工作区），默认为工作区根目录",
				tools.Default("."), tools.MinLength(1)),
			"include": tools.StringSchema(
				"只搜文件名匹配这个 glob 的文件，例如 *.py；按文件名匹配、任意深度都算。留空表示不限",
				tools.Default("")),
			"ignore_case": tools.BoolSchema(
				"是否忽略大小写", tools.Default(false)),
			"max_files": tools.IntSchema(
				"最多列出多少个有命中的文件（默认 "+itoa(GREP_MAX_FILES)+"）。"+
					"命中文件更多时只列最前面的，但总数会告诉你有几个",
				tools.Default(GREP_MAX_FILES), tools.Minimum(1), tools.Maximum(GREP_MAX_MAX_FILES)),
		}, "pattern"),
		Handler: func(args map[string]any) (tools.Result, error) {
			pattern, _ := args["pattern"].(string)
			searchPath, _ := args["path"].(string)
			if searchPath == "" {
				searchPath = "."
			}
			include, _ := args["include"].(string)
			ignoreCase, _ := args["ignore_case"].(bool)
			maxFiles := GREP_MAX_FILES
			if v, ok := args["max_files"].(int); ok && v >= 1 {
				maxFiles = v
			}
			return tools.TextResult(grep(workspace, binary, pattern, searchPath, include, ignoreCase, maxFiles)), nil
		},
		ParallelSafe: true,
	}, true
}

// lineMatch is one hit: a line number and the (already clipped) line text.
type lineMatch struct {
	lineno int
	line   string
}

// fileMatch accumulates hits for one file, kept in arrival order.
type fileMatch struct {
	orderKey [2]any // (hidden bool, rel string) so eviction can compare cheaply
	hidden   bool
	rel      string
	hits     []lineMatch
}

// grep runs ripgrep and renders the result. It never throws: "no matches" is a
// normal outcome, not a fault, and the model must see it to avoid assuming
// absence equals non-existence.
func grep(workspace *tools.Workspace, binary, pattern, searchPath, include string, ignoreCase bool, maxFiles int) string {
	root, err := workspace.SafePath(searchPath)
	if err != nil {
		// Escaping the workspace is a hard refusal, not a search result.
		return "路径越界，搜不了：" + searchPath
	}
	if info, statErr := os.Stat(root); statErr != nil || !info.IsDir() {
		if statErr != nil {
			return "路径不存在：" + searchPath
		}
		return "不是目录：" + searchPath + "（这个工具只搜目录；要读单个文件用 read_file）"
	}

	argv := buildGrepArgv(binary, root, pattern, include, ignoreCase)
	ctx, cancel := context.WithTimeout(context.Background(), GREP_TIMEOUT_SECONDS*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = workspace.Root()
	// A nil stdin is /dev/null: ripgrep never reads input, and a stray read would
	// otherwise block the search until the timeout.

	var stdoutBuf, stderrBuf strings.Builder
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf

	runErr := cmd.Start()
	if runErr == nil {
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case <-ctx.Done():
			// A timeout returns nothing at all, so the model cannot mistake a partial
			// search for "this is everything".
			killErr := process.TerminateTree(cmd)
			<-done
			text := "搜索超过了 " + itoa(GREP_TIMEOUT_SECONDS) + " 秒，已终止，这次没有任何结果。\n" +
				"缩小范围再试：把 path 指到子目录，或者用 include 限定文件名（例如 *.py）。"
			if killErr != nil {
				// The search produced nothing either way, but "already terminated" and
				// "could not be stopped" are different things to leave behind.
				text = "搜索超过了 " + itoa(GREP_TIMEOUT_SECONDS) + " 秒，而且**没能把它停掉**（" +
					killErr.Error() + "）—— 它可能还在跑。这次没有任何结果。\n" +
					"先确认那个进程还在不在，再缩小范围重试。"
			}
			return text
		case <-done:
		}
	}
	stderr := stderrBuf.String()
	if runErr != nil {
		return "内置的 ripgrep 起不来：" + runErr.Error()
	}
	exitCode := cmd.ProcessState.ExitCode()
	if exitCode != 0 && exitCode != 1 {
		if strings.Contains(stderr, "regex parse error") {
			return "正则表达式无效：" + pattern + "\n" + strings.TrimSpace(stderr)
		}
		return "内置的 ripgrep 起不来：" + strings.TrimSpace(stderr)
	}
	// rg exit code 1 means "no matches" — a normal result, not an error.
	return renderGrep(stdoutBuf.String(), root, workspace.Root(), pattern, searchPath, maxFiles, stderr)
}

// buildGrepArgv assembles the exact argv. The only place flags may appear: the
// model's input lands on four positions only — -e (pattern), -g (include), -i
// (flag), and the path after --. The pattern can never become a flag.
func buildGrepArgv(binary, root, pattern, include string, ignoreCase bool) []string {
	argv := []string{
		binary,
		"--no-config",
		"--hidden",
		"--no-ignore",
		"--no-ignore-vcs",
		"--no-ignore-parent",
		"--no-ignore-global",
		"--json",
		"--max-count",
		itoa(GREP_MAX_MATCHES_PER_FILE + 1),
		"-e",
		pattern,
	}
	if include != "" {
		argv = append(argv, "-g", include)
	}
	if ignoreCase {
		argv = append(argv, "-i")
	}
	argv = append(argv, "--", root)
	return argv
}

// grepMessage is one JSON Lines record from ripgrep.
type grepMessage struct {
	Type string `json:"type"`
	Data struct {
		Path struct {
			Text string `json:"text"`
		} `json:"path"`
		Lines struct {
			Text string `json:"text"`
		} `json:"lines"`
		LineNumber int `json:"line_number"`
	} `json:"data"`
	Stats struct {
		Searches          int `json:"searches"`
		SearchesWithMatch int `json:"searches_with_match"`
	} `json:"stats"`
}

// renderGrep parses the JSON stream and formats the model-facing text. The
// summary line fills searched/withMatch; the caller has already handled timeouts.
func renderGrep(stdout, root, workspace, pattern, searchPath string, maxFiles int, stderr string) string {
	buffered := map[string]*fileMatch{}
	var searched, withMatch int
	lines := strings.Split(stdout, "\n")
	for _, raw := range lines {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		var msg grepMessage
		if jErr := json.Unmarshal([]byte(raw), &msg); jErr != nil {
			continue
		}
		switch msg.Type {
		case "match":
			pathText := msg.Data.Path.Text
			line := msg.Data.Lines.Text
			lineno := msg.Data.LineNumber
			if pathText == "" || line == "" || lineno == 0 {
				continue
			}
			rel, ok := relPath(workspace, root, pathText)
			if !ok {
				continue
			}
			hidden, orderRel := orderKey(root, pathText)
			if _, exists := buffered[rel]; !exists {
				if len(buffered) >= maxFiles {
					// Evict the worst (most-hidden, then lexicographically last) so the
					// result is reproducible regardless of ripgrep's arrival order.
					dropWorst(buffered)
				}
				buffered[rel] = &fileMatch{hidden: hidden, rel: orderRel}
			}
			fm := buffered[rel]
			fm.hits = append(fm.hits, lineMatch{lineno: lineno, line: strings.TrimRight(line, "\r\n")})
		case "summary":
			searched = msg.Stats.Searches
			withMatch = msg.Stats.SearchesWithMatch
		}
	}

	// Sort by order key: non-hidden first, then lexicographic.
	rels := make([]string, 0, len(buffered))
	for rel := range buffered {
		rels = append(rels, rel)
	}
	sort.Slice(rels, func(i, j int) bool {
		a, b := buffered[rels[i]], buffered[rels[j]]
		if a.hidden != b.hidden {
			return !a.hidden
		}
		return a.rel < b.rel
	})

	var body string
	if len(rels) == 0 {
		body = "没有匹配：在 " + searchPath + " 下找不到符合 " + pattern + " 的内容（搜了 " + itoa(searched) + " 个文件）"
	} else {
		blocks := make([]string, 0, len(rels))
		for _, rel := range rels {
			fm := buffered[rel]
			shown := fm.hits
			if len(shown) > GREP_MAX_MATCHES_PER_FILE {
				shown = shown[:GREP_MAX_MATCHES_PER_FILE]
			}
			header := rel + " (" + itoa(len(shown)) + " 处命中)"
			rendered := make([]string, 0, len(shown)+1)
			rendered = append(rendered, header)
			for _, h := range shown {
				rendered = append(rendered, formatGrepLine(h.lineno, h.line))
			}
			if len(fm.hits) > GREP_MAX_MATCHES_PER_FILE {
				rendered = append(rendered, "…（此文件命中已到 "+itoa(GREP_MAX_MATCHES_PER_FILE)+" 条上限）")
			}
			blocks = append(blocks, strings.Join(rendered, "\n"))
		}
		body = strings.Join(blocks, "\n")
	}

	notes := make([]string, 0, 2)
	if withMatch > len(rels) {
		notes = append(notes,
			"共 "+itoa(withMatch)+" 个路径有命中，只挑列了最前面的 "+itoa(len(rels))+" 个",
			"非隐藏路径排在前面，没列出来的更可能在隐藏目录或第三方目录里")
	}
	if engineNote := engineErrorNote(stderr); engineNote != "" {
		notes = append(notes, engineNote)
	}
	if len(notes) > 0 {
		body += "\n\n（" + strings.Join(notes, "；") + "）"
	}
	return tools.Truncate(body, GREP_MAX_OUTPUT_CHARS)
}

// relPath returns the workspace-relative, slash-separated path, robust to rg
// printing either absolute or cwd-relative paths. The second return is false when
// the path cannot be relativized (should not happen for in-workspace hits).
func relPath(workspace, root, pathText string) (string, bool) {
	p := pathText
	if !filepath.IsAbs(p) {
		p = filepath.Join(workspace, p)
	}
	rel, err := filepath.Rel(workspace, p)
	if err != nil {
		return filepath.ToSlash(p), false
	}
	return filepath.ToSlash(rel), true
}

// orderKey returns (hidden, relToRoot) for sorting. "Hidden" is judged relative to
// root, so an explicit `path=".venv"` search treats its contents as ordinary.
func orderKey(root, pathText string) (bool, string) {
	p := pathText
	if !filepath.IsAbs(p) {
		p = filepath.Join(root, p)
	}
	rel, err := filepath.Rel(root, p)
	if err != nil {
		rel = p
	}
	rel = filepath.ToSlash(rel)
	hidden := false
	for _, part := range strings.Split(rel, "/") {
		if part != "." && part != ".." && strings.HasPrefix(part, ".") {
			hidden = true
			break
		}
	}
	return hidden, rel
}

// dropWorst removes the entry with the worst order key (most hidden, then
// lexicographically last) so the buffer stays within max_files while keeping the
// best files.
func dropWorst(buffered map[string]*fileMatch) {
	worst := ""
	var worstHidden bool
	worstRel := ""
	for rel, fm := range buffered {
		if worst == "" || fm.hidden && !worstHidden || (fm.hidden == worstHidden && fm.rel > worstRel) {
			worst = rel
			worstHidden = fm.hidden
			worstRel = fm.rel
		}
	}
	delete(buffered, worst)
}

// formatGrepLine clips a long line and marks the clip.
func formatGrepLine(lineno int, line string) string {
	clipped := line
	if len([]rune(line)) > GREP_MAX_LINE_CHARS {
		clipped = string([]rune(line)[:GREP_MAX_LINE_CHARS]) + "…"
	}
	return itoa(lineno) + ":" + clipped
}

// engineErrorNote compresses stderr lines the engine reported into one footnote.
// A half-failed search must be said, or the model reads "couldn't read these
// files" as "they're genuinely empty".
func engineErrorNote(stderr string) string {
	lines := make([]string, 0)
	for _, l := range strings.Split(stderr, "\n") {
		l = strings.TrimSpace(l)
		if l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) == 0 {
		return ""
	}
	if len(lines) == 1 {
		return "引擎报了 1 条错误：" + lines[0]
	}
	return "引擎报了 " + itoa(len(lines)) + " 条错误，第一条：" + lines[0]
}
