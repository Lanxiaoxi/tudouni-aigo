package audit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// benchmarkRecord is a representative audit event: the fields every record
// carries plus a tool result's own payload, which is where a real record's bulk
// sits.
func benchmarkRecord() map[string]any {
	return Event(KindToolResult, "20260101-120000", "run-1", 3, map[string]any{
		"name":     "shell",
		"status":   "ok",
		"duration": 412,
		"output":   strings.Repeat("build output line ", 12),
	})
}

// BenchmarkWriteResident is the shape this change ships: one write syscall per
// record against a handle that is already open.
func BenchmarkWriteResident(b *testing.B) {
	sink, err := NewJsonlSink(b.TempDir())
	if err != nil {
		b.Fatal(err)
	}
	defer sink.Close()
	rec := benchmarkRecord()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := sink.Write(rec); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkWriteOpenClosePerRecord is the shape it replaces, measured the same
// way so the two are comparable. It deliberately re-implements the old write
// path inline rather than being a copy of the old method, so this file stays a
// benchmark of two syscall patterns and not a second copy of the logic.
func BenchmarkWriteOpenClosePerRecord(b *testing.B) {
	dir := b.TempDir()
	path := filepath.Join(dir, "20260101-120000.jsonl")
	rec := benchmarkRecord()

	var builder strings.Builder
	encoder := json.NewEncoder(&builder)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(rec); err != nil {
		b.Fatal(err)
	}
	line := builder.String()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			b.Fatal(err)
		}
		if _, err := file.WriteString(line); err != nil {
			file.Close()
			b.Fatal(err)
		}
		if err := file.Close(); err != nil {
			b.Fatal(err)
		}
	}
}
