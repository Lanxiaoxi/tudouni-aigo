package host

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// Limits of the filesystem service, from the spec unless noted.
const (
	listLimit       = 5000
	readDefault     = 256 * 1024
	readMax         = 1 << 20
	bytesDefault    = 8 << 20
	searchDefault   = 200
	searchMax       = 1000
	binaryProbeSize = 8192
	// bytesHardCap bounds `fs_read_bytes` whatever `max` asks for: the answer is a
	// single base64 line, and a front end that asked for 4GB would otherwise get
	// the host to build it. Not in the spec's defaults; documented there.
	bytesHardCap = 32 << 20
	// searchVisitCap bounds how many directory entries one search may look at, so
	// a search on a huge tree answers (truncated) instead of running for minutes.
	searchVisitCap = 300000
)

// entry is the wire shape shared by fs_list, fs_stat and fs_search.
type entry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Kind    string `json:"kind"`
	Size    int64  `json:"size"`
	MtimeMs int64  `json:"mtime_ms"`
	Hidden  bool   `json:"hidden"`
}

// filesystemService answers the `fs_*` requests.
//
// Every path goes through `tools.Workspace.SafePath`, which is the program's one
// definition of "inside the workspace" (resolved symlinks, junction walk, `..`).
// This service never builds a filesystem path from client input any other way.
type filesystemService struct {
	ws   *tools.Workspace
	root string
}

func newFilesystemService(ws *tools.Workspace) *filesystemService {
	return &filesystemService{ws: ws, root: ws.Root()}
}

// resolved is a client path after the boundary check.
type resolved struct {
	// abs is what to open: SafePath's answer, with links already resolved.
	abs string
	// lexical is the same path without resolving the last link, for Lstat: a
	// link inside the workspace should be reported as a link, not as its target.
	lexical string
	// rel is the workspace-relative `/` form, "" for the root.
	rel string
}

func (s *filesystemService) resolve(p string) (resolved, *wireError) {
	if strings.ContainsRune(p, 0) {
		return resolved{}, errf(CodeBadRequest, "path contains a NUL byte")
	}
	native := filepath.FromSlash(p)
	if native == "" {
		native = "."
	}
	abs, err := s.ws.SafePath(native)
	if err != nil {
		return resolved{}, errf(CodePathEscape, "%s", err.Error())
	}
	lexical := abs
	if !filepath.IsAbs(native) {
		lexical = filepath.Join(s.root, native)
	}
	rel, err := filepath.Rel(s.root, lexical)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return resolved{}, errf(CodePathEscape, "path escapes the workspace")
	}
	rel = filepath.ToSlash(rel)
	if rel == "." {
		rel = ""
	}
	return resolved{abs: abs, lexical: lexical, rel: rel}, nil
}

func (s *filesystemService) handle(ctx context.Context, t string, msg map[string]any) (any, *wireError) {
	switch t {
	case MsgFsList:
		return s.list(msg)
	case MsgFsStat:
		return s.stat(msg)
	case MsgFsRead:
		return s.read(msg)
	case MsgFsReadBytes:
		return s.readBytes(msg)
	case MsgFsSearch:
		return s.search(ctx, msg)
	}
	return nil, errf(CodeUnsupported, "unknown message %q", t)
}

// ioError maps an OS error to the wire error codes.
func ioError(err error, what string) *wireError {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return errf(CodeNotFound, "%s: not found", what)
	case errors.Is(err, fs.ErrPermission):
		return errf(CodeInternal, "%s: permission denied", what)
	}
	return errf(CodeInternal, "%s: %v", what, err)
}

func kindOf(mode fs.FileMode) string {
	// ModeIrregular is how Go reports a Windows junction (and other reparse
	// points); treating it as a link is what keeps the tree from walking through
	// one.
	switch {
	case mode&(fs.ModeSymlink|fs.ModeIrregular) != 0:
		return "link"
	case mode.IsDir():
		return "dir"
	}
	return "file"
}

func makeEntry(name, rel string, info fs.FileInfo) entry {
	return entry{
		Name:    name,
		Path:    rel,
		Kind:    kindOf(info.Mode()),
		Size:    info.Size(),
		MtimeMs: info.ModTime().UnixMilli(),
		Hidden:  strings.HasPrefix(name, "."),
	}
}

func joinRel(dir, name string) string {
	if dir == "" {
		return name
	}
	return dir + "/" + name
}

// --- fs_list / fs_stat -----------------------------------------------------

func (s *filesystemService) list(msg map[string]any) (any, *wireError) {
	target, werr := s.resolve(argString(msg, "path"))
	if werr != nil {
		return nil, werr
	}
	info, err := os.Stat(target.abs)
	if err != nil {
		return nil, ioError(err, "fs_list")
	}
	if !info.IsDir() {
		return nil, errf(CodeBadRequest, "not a directory")
	}
	items, err := os.ReadDir(target.abs)
	if err != nil {
		return nil, ioError(err, "fs_list")
	}
	entries := make([]entry, 0, len(items))
	for _, item := range items {
		fi, err := item.Info()
		if err != nil {
			// Vanished between the listing and the stat: not worth failing for.
			continue
		}
		entries = append(entries, makeEntry(item.Name(), joinRel(target.rel, item.Name()), fi))
	}
	sort.SliceStable(entries, func(i, j int) bool {
		di, dj := entries[i].Kind == "dir", entries[j].Kind == "dir"
		if di != dj {
			return di
		}
		li, lj := strings.ToLower(entries[i].Name), strings.ToLower(entries[j].Name)
		if li != lj {
			return li < lj
		}
		return entries[i].Name < entries[j].Name
	})
	truncated := false
	if len(entries) > listLimit {
		entries = entries[:listLimit]
		truncated = true
	}
	return map[string]any{"path": target.rel, "entries": entries, "truncated": truncated}, nil
}

func (s *filesystemService) stat(msg map[string]any) (any, *wireError) {
	target, werr := s.resolve(argString(msg, "path"))
	if werr != nil {
		return nil, werr
	}
	info, err := os.Lstat(target.lexical)
	if err != nil {
		return nil, ioError(err, "fs_stat")
	}
	name := filepath.Base(target.lexical)
	return makeEntry(name, target.rel, info), nil
}

// --- fs_read -----------------------------------------------------------------

func (s *filesystemService) read(msg map[string]any) (any, *wireError) {
	target, werr := s.resolve(argString(msg, "path"))
	if werr != nil {
		return nil, werr
	}
	offset64, werr := argInt64(msg, "offset", 0)
	if werr != nil {
		return nil, werr
	}
	limit64, werr := argInt64(msg, "limit", readDefault)
	if werr != nil {
		return nil, werr
	}
	if offset64 < 0 || limit64 <= 0 {
		return nil, errf(CodeBadRequest, "offset must be >= 0 and limit > 0")
	}
	if limit64 > readMax {
		limit64 = readMax
	}

	// Stat first: the size is what decides whether this read is the whole file,
	// and a directory is refused before anything is opened.
	info, err := os.Stat(target.abs)
	if err != nil {
		return nil, ioError(err, "fs_read")
	}
	if info.IsDir() {
		return nil, errf(CodeBadRequest, "is a directory")
	}
	if !info.Mode().IsRegular() {
		return nil, errf(CodeBadRequest, "not a regular file")
	}
	size := info.Size()
	file, err := os.Open(target.abs)
	if err != nil {
		return nil, ioError(err, "fs_read")
	}
	defer file.Close()

	response := map[string]any{
		"path": target.rel, "size": size, "offset": offset64, "bytes_read": 0,
		"content": "", "next_offset": nil, "truncated": false, "total_lines": nil,
		"encoding": "utf-8", "status": "ok", "mime": mimeFor(target.rel, ""),
	}

	// Binary is judged on the head of the file whatever the offset: a PNG read
	// from the middle looks like text often enough to be worth not guessing.
	probe := make([]byte, min64(size, binaryProbeSize))
	n, _ := file.ReadAt(probe, 0)
	if bytes.IndexByte(probe[:n], 0) >= 0 {
		response["status"] = "binary"
		response["encoding"] = ""
		response["mime"] = mimeFor(target.rel, string(probe[:n]))
		return response, nil
	}

	if offset64 > size {
		offset64 = size
	}
	end := min64(offset64+limit64, size)
	buf := make([]byte, end-offset64)
	got, err := file.ReadAt(buf, offset64)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, ioError(err, "fs_read")
	}
	buf = buf[:got]
	start := offset64

	// A caller that resumes from `next_offset` is always on a boundary; one that
	// picked an arbitrary offset may land inside a character. Skipping the
	// continuation bytes reports the real start instead of failing the read.
	if start > 0 {
		skip := 0
		for skip < utf8.UTFMax-1 && skip < len(buf) && buf[skip]&0xC0 == 0x80 {
			skip++
		}
		buf, start = buf[skip:], start+int64(skip)
	}
	// The range ends where the byte limit says, which may be inside a character.
	// Back off to the previous boundary and let `next_offset` point at the
	// remainder, so the pieces concatenate to the file.
	if start+int64(len(buf)) < size {
		if cut := incompleteTail(buf); cut > 0 && cut < len(buf) {
			buf = buf[:len(buf)-cut]
		}
	}
	if !utf8.Valid(buf) {
		response["status"] = "non_utf8"
		response["encoding"] = ""
		response["offset"] = start
		return response, nil
	}

	nextOffset := start + int64(len(buf))
	response["offset"] = start
	response["bytes_read"] = len(buf)
	response["content"] = string(buf)
	if nextOffset < size {
		response["next_offset"] = nextOffset
		response["truncated"] = true
	} else if start == 0 {
		// Only a read that saw the whole file may claim a line count; reporting the
		// lines of a fragment as the file's total is the mistake this field exists
		// to avoid.
		response["total_lines"] = countLines(buf)
	}
	return response, nil
}

// incompleteTail returns how many trailing bytes of b are the start of a
// multi-byte character whose remaining bytes are not there.
func incompleteTail(b []byte) int {
	for back := 1; back <= utf8.UTFMax-1 && back <= len(b); back++ {
		c := b[len(b)-back]
		if c&0xC0 == 0x80 {
			continue // a continuation byte: keep walking back to the lead byte
		}
		var need int
		switch {
		case c&0xE0 == 0xC0:
			need = 2
		case c&0xF0 == 0xE0:
			need = 3
		case c&0xF8 == 0xF0:
			need = 4
		default:
			return 0 // ASCII, or not a lead byte at all
		}
		if back < need {
			return back
		}
		return 0
	}
	return 0
}

func countLines(b []byte) int {
	if len(b) == 0 {
		return 0
	}
	lines := bytes.Count(b, []byte{'\n'})
	if b[len(b)-1] != '\n' {
		lines++
	}
	return lines
}

// --- fs_read_bytes --------------------------------------------------------------

func (s *filesystemService) readBytes(msg map[string]any) (any, *wireError) {
	target, werr := s.resolve(argString(msg, "path"))
	if werr != nil {
		return nil, werr
	}
	max, werr := argInt64(msg, "max", bytesDefault)
	if werr != nil {
		return nil, werr
	}
	if max <= 0 {
		return nil, errf(CodeBadRequest, "max must be > 0")
	}
	if max > bytesHardCap {
		max = bytesHardCap
	}
	info, err := os.Stat(target.abs)
	if err != nil {
		return nil, ioError(err, "fs_read_bytes")
	}
	if info.IsDir() || !info.Mode().IsRegular() {
		return nil, errf(CodeBadRequest, "not a regular file")
	}
	if info.Size() > max {
		return nil, errf(CodeTooLarge, "file is %d bytes, limit is %d", info.Size(), max)
	}
	file, err := os.Open(target.abs)
	if err != nil {
		return nil, ioError(err, "fs_read_bytes")
	}
	defer file.Close()
	// One byte more than allowed: the file may have grown since the stat.
	data, err := io.ReadAll(io.LimitReader(file, max+1))
	if err != nil {
		return nil, ioError(err, "fs_read_bytes")
	}
	if int64(len(data)) > max {
		return nil, errf(CodeTooLarge, "file grew past the limit of %d bytes", max)
	}
	head := data
	if len(head) > 512 {
		head = head[:512]
	}
	return map[string]any{
		"path": target.rel, "size": len(data),
		"mime": mimeFor(target.rel, string(head)),
		"data": base64.StdEncoding.EncodeToString(data),
	}, nil
}

// --- fs_search --------------------------------------------------------------------

func (s *filesystemService) search(ctx context.Context, msg map[string]any) (any, *wireError) {
	query := strings.ToLower(argString(msg, "query"))
	if query == "" {
		return nil, errf(CodeBadRequest, "query must not be empty")
	}
	limit, werr := argInt64(msg, "limit", searchDefault)
	if werr != nil {
		return nil, werr
	}
	if limit <= 0 {
		return nil, errf(CodeBadRequest, "limit must be > 0")
	}
	if limit > searchMax {
		limit = searchMax
	}

	results := make([]entry, 0, 16)
	truncated := false
	visited := 0
	stop := errors.New("stop")
	// WalkDir does not follow links, so a link cannot lead the search out of the
	// workspace; links themselves are listed as links.
	err := filepath.WalkDir(s.root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if path == s.root {
			return nil
		}
		name := d.Name()
		if d.IsDir() && (name == ".git" || name == "node_modules") {
			return fs.SkipDir
		}
		visited++
		if visited > searchVisitCap {
			truncated = true
			return stop
		}
		if !strings.Contains(strings.ToLower(name), query) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(s.root, path)
		if err != nil {
			return nil
		}
		if int64(len(results)) >= limit {
			truncated = true
			return stop
		}
		results = append(results, makeEntry(name, filepath.ToSlash(rel), info))
		return nil
	})
	if err != nil && !errors.Is(err, stop) {
		if ctx.Err() != nil {
			return nil, errf(CodeInternal, "search cancelled")
		}
		return nil, errf(CodeInternal, "search failed: %v", err)
	}
	return map[string]any{"results": results, "truncated": truncated}, nil
}

// --- helpers ------------------------------------------------------------------------

func argInt64(msg map[string]any, key string, fallback int64) (int64, *wireError) {
	raw, present := msg[key]
	if !present || raw == nil {
		return fallback, nil
	}
	number, ok := raw.(float64)
	if !ok || number != float64(int64(number)) {
		return 0, errf(CodeBadRequest, "%s must be an integer", key)
	}
	return int64(number), nil
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

// mimeTable is deliberately explicit: the OS mime database differs per machine
// (on Windows it is the registry), and the front end chooses a viewer from this
// string, so it has to be the same everywhere.
var mimeTable = map[string]string{
	".go": "text/x-go", ".rs": "text/x-rust", ".py": "text/x-python", ".js": "text/javascript",
	".mjs": "text/javascript", ".ts": "text/typescript", ".tsx": "text/typescript",
	".jsx": "text/javascript", ".json": "application/json", ".md": "text/markdown",
	".html": "text/html", ".htm": "text/html", ".css": "text/css", ".txt": "text/plain",
	".toml": "text/x-toml", ".yaml": "text/yaml", ".yml": "text/yaml", ".xml": "text/xml",
	".sh": "text/x-shellscript", ".ps1": "text/x-powershell", ".c": "text/x-c", ".h": "text/x-c",
	".cpp": "text/x-c++", ".hpp": "text/x-c++", ".java": "text/x-java", ".sql": "text/x-sql",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".bmp": "image/bmp",
	".pdf": "application/pdf", ".zip": "application/zip",
}

// mimeFor guesses a content type from the extension, then (when given) the head
// of the file, then a neutral default.
func mimeFor(rel, head string) string {
	ext := strings.ToLower(filepath.Ext(rel))
	if m, ok := mimeTable[ext]; ok {
		return m
	}
	if head != "" {
		sniffed := http.DetectContentType([]byte(head))
		if i := strings.IndexByte(sniffed, ';'); i >= 0 {
			sniffed = sniffed[:i]
		}
		if sniffed != "application/octet-stream" {
			return sniffed
		}
	}
	if ext != "" {
		if m := mime.TypeByExtension(ext); m != "" {
			if i := strings.IndexByte(m, ';'); i >= 0 {
				m = m[:i]
			}
			return m
		}
	}
	if head == "" {
		return "text/plain"
	}
	return "application/octet-stream"
}
