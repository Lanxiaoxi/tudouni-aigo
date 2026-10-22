package builtin

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// toolsWorkspace builds a workspace over a directory.
func toolsWorkspace(dir string) (*tools.Workspace, error) {
	return tools.NewWorkspace(dir)
}

// decodeJSON reads a request body into a map.
func decodeJSON(t *testing.T, r *http.Request, into map[string]any) {
	t.Helper()
	if err := json.NewDecoder(r.Body).Decode(&into); err != nil {
		t.Errorf("decoding the request: %v", err)
	}
}

// The end-to-end shape of the tool, against a fake provider.
//
// The point of this test is not any one rule — the other tests here pin the
// rules one by one — but the **shape** of a successful call: a request goes
// out, a file appears in the workspace, the model is handed the bytes, and
// the audit carries the facts.
//
// It is the one test that would notice if the pieces stopped fitting
// together, which is exactly what a change that touches all of them does.

func TestTheWholeThingEndToEnd(t *testing.T) {
	// A fake provider that answers with one picture.
	//
	// The request is handed over a channel rather than written into a shared
	// map: the handler runs on the server's goroutine, and the assertions run
	// after the call returns — so a plain variable would be read before the
	// write that filled it, which is a race rather than a test.
	requests := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		decoded := map[string]any{}
		decodeJSON(t, r, decoded)
		requests <- decoded
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":[{"b64_json":%q,"revised_prompt":"a poster of a mountain"}],`+
			`"usage":{"input_tokens":12,"output_tokens":1500},"id":"req-42"}`,
			base64.StdEncoding.EncodeToString(pngBytes(t, 8, 6)))
	}))
	defer server.Close()

	dir := t.TempDir()
	workspace, err := toolsWorkspace(dir)
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	tool := NewGenerateImage(workspace, newImageClient(t, server.URL),
		func() bool { return true }, func() string { return "run-1" })

	result, err := tool.Execute(context.Background(), map[string]any{
		"prompt":      "a mountain poster",
		"path":        "docs/images/mountain.png",
		"orientation": "landscape",
	})
	if err != nil {
		t.Fatalf("calling: %v", err)
	}

	// 1. The request carried what it should.
	request := <-requests
	if request["model"] != "gpt-image-1" {
		t.Errorf("the request model is %v", request["model"])
	}
	if request["size"] != "1536x1024" {
		t.Errorf("the request size is %v, want 1536x1024", request["size"])
	}
	if request["n"] != float64(1) {
		t.Errorf("the request n is %v, want 1", request["n"])
	}
	if _, present := request["response_format"]; present {
		t.Error("the request carries response_format")
	}

	// 2. The picture is a file in the workspace.
	written := filepath.Join(dir, "docs", "images", "mountain.png")
	if _, statErr := os.Stat(written); statErr != nil {
		t.Fatalf("the picture is not on disk: %v", statErr)
	}

	// 3. The model is handed the bytes.
	if len(result.Images) != 1 {
		t.Fatalf("%d images came back, want 1", len(result.Images))
	}
	if result.Images[0].Path != "docs/images/mountain.png" {
		t.Errorf("the image path is %q", result.Images[0].Path)
	}

	// 4. The text says where it went and what to do next, and does **not**
	// describe the picture.
	if !strings.Contains(result.Text, "docs/images/mountain.png") {
		t.Errorf("the text does not name the path: %q", result.Text)
	}
	if !strings.Contains(result.Text, "present") {
		t.Errorf("the text does not say what to do next: %q", result.Text)
	}
	if strings.Contains(result.Text, "mountain poster") {
		t.Errorf("the text describes the picture, and it must not: %q", result.Text)
	}

	// 5. The audit carries the facts, and only the facts.
	audit := result.Audit
	if audit["size"] != "8x6" {
		t.Errorf("the audit size is %v, want 8x6 (measured)", audit["size"])
	}
	if audit["path"] != "docs/images/mountain.png" {
		t.Errorf("the audit path is %v", audit["path"])
	}
	if audit["orientation"] != "landscape" {
		t.Errorf("the audit orientation is %v", audit["orientation"])
	}
	if audit["revised_prompt"] != "a poster of a mountain" {
		t.Errorf("the audit revised_prompt is %v", audit["revised_prompt"])
	}
	if audit["request_id"] != "req-42" {
		t.Errorf("the audit request_id is %v", audit["request_id"])
	}
	usage, present := audit["usage"].(map[string]any)
	if !present {
		t.Fatal("the audit has no usage")
	}
	if usage["input_tokens"] != 12 || usage["output_tokens"] != 1500 {
		t.Errorf("the usage is %v", usage)
	}
	if audit["inline"] != true {
		t.Errorf("the audit inline is %v, want true", audit["inline"])
	}
}
