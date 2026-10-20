package cgparse

// Running `cg-parse` and reading its batch output.
//
// Batch, not one process per file: spawning the binary was measured at ~36 ms on
// this machine while extracting a Go file costs effectively nothing next to it. A
// 322-file tree at one exec per file would spend about 11 seconds in process
// creation alone. The chunk size below is what turns that cost into noise.
//
// The protocol is deliberately dumb — `path<TAB>language` per stdin line, one JSON
// object per stdout line — so a stuck batch is diagnosable with a text editor
// rather than a debugger.

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os/exec"
	"strings"
	"sync"
)

// Reference is one file to parse.
type Reference struct {
	// Path is the file to read, passed to cg-parse verbatim, so it must be
	// meaningful to that process's working directory.
	Path string
	// Language is the kernel's language name (`go`, `typescript`, `tsx`, …).
	// Empty means "let cg-parse infer it from the extension".
	Language string
}

// Result is one file's parse outcome.
type Result struct {
	Reference
	// File is the decoded tables, nil when OK is false.
	File *File
	// OK reports whether extraction succeeded.
	OK bool
	// Error is the reason when OK is false.
	Error string
	// DurationMS is the kernel-side extraction time for this file, excluding
	// process and transport cost.
	DurationMS float64
}

// batchRecord mirrors the JSON object cg-parse writes in --batch mode. Unexported
// because it is a wire detail, not an API: callers get Result.
type batchRecord struct {
	Path       string  `json:"path"`
	Language   string  `json:"language"`
	OK         bool    `json:"ok"`
	Error      string  `json:"error,omitempty"`
	ABI        uint8   `json:"abi,omitempty"`
	Nodes      string  `json:"nodes,omitempty"`
	Edges      string  `json:"edges,omitempty"`
	Refs       string  `json:"refs,omitempty"`
	Arena      string  `json:"arena,omitempty"`
	NodeCount  uint32  `json:"node_count,omitempty"`
	EdgeCount  uint32  `json:"edge_count,omitempty"`
	RefCount   uint32  `json:"ref_count,omitempty"`
	DurationMS float64 `json:"duration_ms,omitempty"`
}

// Parser drives one cg-parse binary.
type Parser struct {
	// Binary is the absolute path to cg-parse. Required.
	Binary string
	// Concurrency is how many batch processes run at once. Zero picks
	// DefaultConcurrency.
	Concurrency int
	// ChunkSize is how many files one process handles. Zero picks
	// DefaultChunkSize.
	//
	// The tradeoff is isolation versus startup: a bigger chunk amortizes the
	// ~36 ms spawn further, a smaller one loses less work when a process dies.
	// 32 keeps per-file overhead under ~1.2 ms while bounding the blast radius of
	// a crash to thirty-two files.
	ChunkSize int
}

// DefaultConcurrency is what Concurrency == 0 means.
//
// Four rather than NumCPU: the win from batching is process amortization, and each
// process already runs several threads inside tree-sitter. Oversubscribing makes
// the run slower on a laptop that is also serving the editor and the agent.
const DefaultConcurrency = 4

// DefaultChunkSize is what ChunkSize == 0 means.
const DefaultChunkSize = 32

// ParseAll parses every reference and returns results in input order.
//
// A failure on one file is a Result with OK false, never a returned error: one
// unparseable file must not abandon the other four hundred. The error return is
// reserved for conditions that make the whole run meaningless — the binary
// missing, a pipe broken, the context cancelled.
func (p *Parser) ParseAll(ctx context.Context, refs []Reference) ([]Result, error) {
	if p.Binary == "" {
		return nil, errors.New("cgparse: Binary is empty")
	}
	if len(refs) == 0 {
		return nil, nil
	}

	workers := p.Concurrency
	if workers <= 0 {
		workers = DefaultConcurrency
	}
	chunk := p.ChunkSize
	if chunk <= 0 {
		chunk = DefaultChunkSize
	}

	results := make([]Result, len(refs))

	// Chunk boundaries are computed up front so workers never contend on a shared
	// cursor, and so results land in input order without a sort afterwards.
	jobs := make(chan [2]int) // [start, end)
	go func() {
		defer close(jobs)
		for start := 0; start < len(refs); start += chunk {
			end := start + chunk
			if end > len(refs) {
				end = len(refs)
			}
			select {
			case <-ctx.Done():
				return
			case jobs <- [2]int{start, end}:
			}
		}
	}()

	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error
	noteErr := func(err error) {
		mu.Lock()
		if firstErr == nil {
			firstErr = err
		}
		mu.Unlock()
	}

	if workers > (len(refs)+chunk-1)/chunk {
		workers = (len(refs) + chunk - 1) / chunk
	}
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range jobs {
				if ctx.Err() != nil {
					return
				}
				runChunk(ctx, p.Binary, refs[job[0]:job[1]], results[job[0]:job[1]], noteErr)
			}
		}()
	}
	wg.Wait()

	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if firstErr != nil {
		return nil, firstErr
	}
	return results, nil
}

// runChunk runs one process for `refs`, writing outcomes into `out`.
//
// `out` is results[start:end], so index i there corresponds to refs[i].
func runChunk(
	ctx context.Context,
	binary string,
	refs []Reference,
	out []Result,
	noteErr func(error),
) {
	for i := range refs {
		out[i] = Result{Reference: refs[i]}
	}
	if len(refs) == 0 {
		return
	}

	var input strings.Builder
	for _, ref := range refs {
		if ref.Language == "" {
			input.WriteString(ref.Path)
		} else {
			input.WriteString(ref.Path)
			input.WriteByte('\t')
			input.WriteString(ref.Language)
		}
		input.WriteByte('\n')
	}

	cmd := exec.CommandContext(ctx, binary, "--batch")
	cmd.Stdin = strings.NewReader(input.String())

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		failAll(out, "stdout pipe: "+err.Error())
		noteErr(fmt.Errorf("cgparse: stdout pipe: %w", err))
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		failAll(out, "stderr pipe: "+err.Error())
		noteErr(fmt.Errorf("cgparse: stderr pipe: %w", err))
		return
	}
	if err := cmd.Start(); err != nil {
		failAll(out, "start "+binary+": "+err.Error())
		noteErr(fmt.Errorf("cgparse: start %s: %w", binary, err))
		return
	}

	// Drain stderr concurrently: a child that fills its stderr buffer while the
	// parent is blocked reading stdout would deadlock both sides.
	stderrDone := make(chan string, 1)
	go func() {
		raw, _ := io.ReadAll(io.LimitReader(stderr, 64*1024))
		stderrDone <- strings.TrimSpace(string(raw))
	}()

	// Records are matched back by path, not by order: cg-parse writes in completion
	// order when it ever parallelizes internally, and a path is the only stable key
	// the two sides share.
	byPath := make(map[string]int, len(refs))
	for i, ref := range refs {
		byPath[ref.Path] = i
	}
	seen := make(map[int]bool, len(refs))

	scanner := bufio.NewScanner(stdout)
	// One file with thousands of refs produces a line in the megabytes; bufio's
	// 64 KiB default would fail with ErrTooLong on exactly the interesting files.
	scanner.Buffer(make([]byte, 0, 256*1024), 256*1024*1024)

	var scanErr error
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var record batchRecord
		if err := json.Unmarshal(line, &record); err != nil {
			// One malformed line must not discard the rest of the chunk.
			continue
		}
		slot, ok := byPath[record.Path]
		if !ok || seen[slot] {
			continue
		}
		seen[slot] = true
		out[slot] = decodeRecord(record)
	}
	scanErr = scanner.Err()
	waitErr := cmd.Wait()
	stderrText := <-stderrDone

	if scanErr != nil {
		noteErr(fmt.Errorf("cgparse: read batch output: %w", scanErr))
	}
	// Anything cg-parse never answered is reported as such rather than left as a
	// zero-value Result, which would read as "parsed to nothing".
	for i := range out {
		if seen[i] {
			continue
		}
		msg := "cg-parse returned no record"
		switch {
		case waitErr != nil:
			msg = "cg-parse exited: " + waitErr.Error()
		case scanErr != nil:
			msg = "batch output unreadable: " + scanErr.Error()
		}
		if stderrText != "" {
			msg += ": " + stderrText
		}
		out[i].OK = false
		out[i].Error = msg
	}
}

// decodeRecord turns one wire record into a Result, including buffer decoding.
func decodeRecord(record batchRecord) Result {
	result := Result{
		Reference:  Reference{Path: record.Path, Language: record.Language},
		DurationMS: record.DurationMS,
	}
	if !record.OK {
		result.Error = record.Error
		if result.Error == "" {
			result.Error = "extraction failed"
		}
		return result
	}

	nodes, err := b64decode(record.Nodes)
	if err != nil {
		result.Error = "nodes: " + err.Error()
		return result
	}
	edges, err := b64decode(record.Edges)
	if err != nil {
		result.Error = "edges: " + err.Error()
		return result
	}
	refs, err := b64decode(record.Refs)
	if err != nil {
		result.Error = "refs: " + err.Error()
		return result
	}
	arena, err := b64decode(record.Arena)
	if err != nil {
		result.Error = "arena: " + err.Error()
		return result
	}

	meta := buildMeta(record, len(arena))
	file, err := Decode(record.Path, record.Language, meta, nodes, edges, refs, arena)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.File = file
	result.OK = true
	return result
}

// buildMeta reconstructs the 36-byte header Decode validates.
//
// cg-parse sends the counts as JSON fields and leaves the meta buffer out of the
// wire, so this puts the header back together rather than making every caller
// carry a redundant 36 bytes. `arenaLen` must be the real slice length because
// Decode cross-checks it — a zero here would report a false layout mismatch.
func buildMeta(record batchRecord, arenaLen int) []byte {
	meta := make([]byte, MetaSize)
	meta[0] = record.ABI
	binary.LittleEndian.PutUint32(meta[4:], record.NodeCount)
	binary.LittleEndian.PutUint32(meta[8:], record.EdgeCount)
	binary.LittleEndian.PutUint32(meta[12:], record.RefCount)
	binary.LittleEndian.PutUint32(meta[16:], uint32(arenaLen))
	// ErrorsOffset stays None: cg-parse reports extraction failure through the
	// record's `ok`/`error` fields, not through an arena blob.
	binary.LittleEndian.PutUint32(meta[20:], None)
	binary.LittleEndian.PutUint32(meta[24:], 0)
	binary.LittleEndian.PutUint64(meta[28:], math.Float64bits(record.DurationMS))
	return meta
}

func failAll(out []Result, reason string) {
	for i := range out {
		out[i].OK = false
		out[i].Error = reason
	}
}

func b64decode(s string) ([]byte, error) {
	if s == "" {
		return nil, nil
	}
	return base64.StdEncoding.DecodeString(s)
}
