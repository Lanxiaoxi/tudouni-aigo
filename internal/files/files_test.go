package files

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newService builds a service over a fresh temporary workspace.
func newService(t *testing.T) (*Service, string) {
	t.Helper()
	root := t.TempDir()
	// The workspace boundary resolves symlinks, and on macOS a temp directory is
	// itself behind one. Comparing the resolved root against the paths this test
	// builds is what keeps the assertion about what List returned meaningful.
	service, err := NewService(root)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	return service, service.Root()
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestListPutsDirectoriesFirstAndUsesWorkspaceRelativePaths(t *testing.T) {
	service, root := newService(t)
	write(t, filepath.Join(root, "README.md"), "# hi\n")
	write(t, filepath.Join(root, "src", "main.go"), "package main\n")
	write(t, filepath.Join(root, "src", "components", "button.go"), "package components\n")

	path, entries, err := service.List("")
	if err != nil {
		t.Fatalf("List(root): %v", err)
	}
	// The root answers with the empty string, which is the protocol's own
	// spelling for "the workspace itself" — not `"."` and not the absolute path.
	if path != "" {
		t.Errorf("path = %q, want the empty string for the workspace root", path)
	}
	if len(entries) != 2 {
		t.Fatalf("root has %d entries, want 2: %+v", len(entries), entries)
	}
	if entries[0].Name != "src" || entries[0].Type != TypeDirectory {
		t.Errorf("first entry = %+v, want the directory `src` first", entries[0])
	}
	if entries[0].Path != "src" {
		t.Errorf("directory path = %q, want %q", entries[0].Path, "src")
	}
	if entries[1].Name != "README.md" || entries[1].Type != TypeFile {
		t.Errorf("second entry = %+v, want the file README.md", entries[1])
	}

	// The nesting is the thing the row's `path` exists for: it is sent back
	// verbatim as the next request, so it has to be the **whole** relative path
	// and not just the name.
	_, nested, err := service.List("src")
	if err != nil {
		t.Fatalf("List(src): %v", err)
	}
	if len(nested) != 2 {
		t.Fatalf("src has %d entries, want 2: %+v", len(nested), nested)
	}
	if nested[0].Path != "src/components" {
		t.Errorf("nested path = %q, want %q", nested[0].Path, "src/components")
	}
	// One level, no recursion: `button.go` is a level below and must not appear.
	for _, entry := range nested {
		if entry.Name == "button.go" {
			t.Errorf("List recursed into a subdirectory: %+v", entry)
		}
	}
}

func TestListRefusesPathsOutsideTheWorkspace(t *testing.T) {
	service, _ := newService(t)
	for _, escape := range []string{"..", "../..", "../../etc", "src/../../outside"} {
		if _, _, err := service.List(escape); err == nil {
			t.Errorf("List(%q) was allowed; it escapes the workspace", escape)
		}
	}
}

func TestReadReportsCharsBytesAndLinesSeparately(t *testing.T) {
	service, root := newService(t)
	// Three Chinese characters is 9 bytes, and the whole point of the test: a
	// front end showing "how long is this" and "how big is this" needs both, and
	// a single number would be wrong for one of them.
	write(t, filepath.Join(root, "zh.txt"), "中文\n第二行\n")

	content, err := service.Read("zh.txt")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if content.Chars != 7 {
		t.Errorf("chars = %d, want 7", content.Chars)
	}
	// 2 characters of 3 bytes each, a newline, 3 more, a newline: 6+1+9+1.
	if content.Bytes != 17 {
		t.Errorf("bytes = %d, want 17", content.Bytes)
	}
	if content.TotalLines != 2 {
		t.Errorf("total lines = %d, want 2 (the trailing newline terminates the second line)", content.TotalLines)
	}
	if content.Path != "zh.txt" {
		t.Errorf("path = %q, want %q", content.Path, "zh.txt")
	}
}

func TestReadAcceptsNormalisedSpellingsAndNormalisesThem(t *testing.T) {
	service, root := newService(t)
	write(t, filepath.Join(root, "src", "main.go"), "package main\n")

	content, err := service.Read("./src/../src/main.go")
	if err != nil {
		t.Fatalf("Read with a redundant path: %v", err)
	}
	// Answering the spelling it was given would give a front end two names for
	// one file, and which it keeps decides what its next request looks like.
	if content.Path != "src/main.go" {
		t.Errorf("path = %q, want the normalised %q", content.Path, "src/main.go")
	}
}

func TestReadRefusesADirectoryAndBinaryContent(t *testing.T) {
	service, root := newService(t)
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if _, err := service.Read("src"); err == nil {
		t.Error("reading a directory was allowed")
	}

	// A byte sequence that is not valid UTF-8. It has to be refused rather than
	// returned: Go would happily hand back a string with replacement characters,
	// and that mojibake would then be written into an Artifact, so the corruption
	// would outlive the session.
	if err := os.WriteFile(filepath.Join(root, "blob.bin"), []byte{0xff, 0xfe, 0x00, 0x01}, 0o644); err != nil {
		t.Fatalf("write blob: %v", err)
	}
	if _, err := service.Read("blob.bin"); err == nil {
		t.Error("a non-UTF-8 file was read as text")
	}
}

func TestListReportsASymlinkToADirectoryAsADirectory(t *testing.T) {
	service, root := newService(t)
	write(t, filepath.Join(root, "real", "file.go"), "package real\n")
	link := filepath.Join(root, "link")
	if err := os.Symlink(filepath.Join(root, "real"), link); err != nil {
		// Windows refuses symlink creation without developer mode or a privilege.
		// The behaviour under test is "a link inside the workspace resolves to
		// what it points at"; when the environment cannot make one, there is
		// nothing to assert and skipping is the honest answer.
		t.Skipf("cannot create a symlink here: %v", err)
	}

	_, entries, err := service.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var found *Entry
	for index := range entries {
		if entries[index].Name == "link" {
			found = &entries[index]
		}
	}
	if found == nil {
		t.Fatalf("the link was dropped from the listing: %+v", entries)
	}
	// A front end draws a directory as something it can open. Reporting the link
	// as a file would make it un-openable, and its target unreachable from the
	// tree.
	if found.Type != TypeDirectory {
		t.Errorf("link type = %q, want %q", found.Type, TypeDirectory)
	}
}

func TestCountLinesMatchesAnEditor(t *testing.T) {
	cases := map[string]int{
		"":            0,
		"\n":          1,
		"a":           1,
		"a\n":         1,
		"a\nb":        2,
		"a\nb\n":      2,
		"a\nb\nc\n\n": 4,
	}
	for text, want := range cases {
		if got := countLines(text); got != want {
			t.Errorf("countLines(%q) = %d, want %d", text, got, want)
		}
	}
}

func TestEntriesAreSortedCaseInsensitively(t *testing.T) {
	service, root := newService(t)
	for _, name := range []string{"Zebra.txt", "apple.txt", "Banana.txt"} {
		write(t, filepath.Join(root, name), "x")
	}
	_, entries, err := service.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name)
	}
	got := strings.Join(names, ",")
	if got != "apple.txt,Banana.txt,Zebra.txt" {
		t.Errorf("order = %s, want apple.txt,Banana.txt,Zebra.txt", got)
	}
}
