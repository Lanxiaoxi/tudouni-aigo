package runtime

import (
	"fmt"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/context"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/files"
)

// FileReadPreviewChars bounds the text one `file_read` answer carries.
//
// 200,000 characters is not a page size — it is the whole of essentially every
// source file a person would open in a viewer, with a ceiling that keeps a
// pathological file (a minified bundle, a generated data file) from putting
// hundreds of megabytes on one protocol line. Above it the answer is truncated
// and says so, and the **whole** body is in the Artifact Store under the id that
// travels with it — which is where the full text belongs, for the same reason a
// tool result's does: a session file is appended to, so a body written into it
// costs its own size again on every round.
//
// Paging a file (`start_line` / `end_line`, the way the agent's own `read_file`
// already works) is the obvious next phase and is deliberately not in this one:
// the design's phase 1 is the minimum that makes a viewer work, and a viewer that
// can only be scrolled by re-asking would need an `artifact_get` message that does
// not exist yet either.
const FileReadPreviewChars = 200_000

// fileArtifactType is the artifact type a `file_read` stores under. The Artifact
// Store treats the type as a coarse class that decides how a body may be rendered
// and degraded, so naming it `file` rather than reusing `text` is what lets a later
// renderer treat a source file differently from a command's output.
const fileArtifactType = "file"

// ListFiles answers `file_list`: one directory level of the workspace.
//
// The path that comes back is the **normalised** one, and the caller is expected
// to use it rather than the string it sent. Answering a request for `./src` with
// rows under `src` while the reply says `./src` gives a front end two spellings of
// one directory, and which one it keeps decides what its next request looks like.
//
// A runtime with no file service refuses rather than answering an empty list: an
// empty directory and "this build cannot read files" look identical on screen, and
// the second one is a bug report nobody files.
func (r *Runtime) ListFiles(path string) (map[string]any, error) {
	if r.Files == nil {
		return nil, fmt.Errorf("this runtime has no workspace file service")
	}
	normalised, entries, err := r.Files.List(path)
	if err != nil {
		return nil, err
	}
	rows := make([]any, 0, len(entries))
	for _, entry := range entries {
		rows = append(rows, entry.Row())
	}
	return map[string]any{"path": normalised, "entries": rows}, nil
}

// ReadFile answers `file_read`: one text file, plus a reference to its body.
//
// It stores the body as an Artifact and sends back the reference **and** a
// preview. Two facts about that choice:
//
//   - the preview is what the caller draws immediately, so one click on a file in
//     a tree does not require a second round trip before anything appears;
//   - the reference is what keeps the protocol from becoming a file-transfer
//     mechanism. `artifact_id` names a body that is already on disk, exactly the
//     way a tool result's reference does, and a front end that wants the whole of
//     a very large file is asking a question this phase does not answer (see
//     FileReadPreviewChars).
//
// **It does not enter the Context.** The artifact is stored; it is not added to
// the model's payload. Somebody browsing their workspace in a sidebar is not
// asking to pay for those files on the next turn, and the agent has its own
// `read_file` for the case where it wants one. That is the same rule the design
// states for terminal output, for the same reason.
func (r *Runtime) ReadFile(path string) (map[string]any, error) {
	if r.Files == nil {
		return nil, fmt.Errorf("this runtime has no workspace file service")
	}
	content, err := r.Files.Read(path)
	if err != nil {
		return nil, err
	}

	artifactID := r.storeFileArtifact(content)

	text := content.Text
	truncated := false
	if runes := []rune(text); len(runes) > FileReadPreviewChars {
		text = string(runes[:FileReadPreviewChars])
		truncated = true
	}

	return map[string]any{
		"path":        content.Path,
		"artifact_id": artifactID,
		"content":     text,
		"chars":       content.Chars,
		"bytes":       content.Bytes,
		"truncated":   truncated,
		"total_lines": content.TotalLines,
	}, nil
}

// storeFileArtifact writes the body down and returns its id, or "" when there is
// no store to write to.
//
// A missing store is not an error. The preview still answers the question that
// was asked, and refusing the whole read because the body could not be filed
// would turn "this build has no context layer" into "this build cannot show you
// your own files" — a much larger failure than the one that actually happened.
func (r *Runtime) storeFileArtifact(content files.Content) string {
	if r.ContextValue == nil || r.ContextValue.Store == nil {
		return ""
	}
	artifact, err := r.ContextValue.Store.Create(
		content.Text,
		fileArtifactType,
		context.ArtifactSource{Path: content.Path},
		map[string]any{
			"path":        content.Path,
			"lines":       content.TotalLines,
			"chars":       content.Chars,
			"bytes":       content.Bytes,
			"source_kind": "file_list",
		},
	)
	if err != nil {
		warn("could not store the body of %s: %v", content.Path, err)
		return ""
	}
	return artifact.ID
}

// fileContent is the shape this file needs from `files.Content`, named locally so
// storeFileArtifact cannot accidentally take some other struct.
type fileContent = struct {
	Path       string
	Text       string
	Chars      int
	Bytes      int
	TotalLines int
}
