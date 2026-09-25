package runtime

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/content"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/context"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// Pictures in a user's message.
//
// The whole interface is this: the user names a file the way they would in a
// sentence —
//
//	帮我看看这个页面截图 docs/shot.png
//
// — and the picture is attached. There is no upload command and no marker to learn.
//
// Three layers are involved and each owns one question, which is why this file is
// thin:
//
//	content.FindImagePaths   "which words could be a picture's name?"
//	this file                "which of them is a file, and may I read it?"
//	context.AttachImage      "store these bytes as an artifact"
//
// The middle question goes through `Workspace.SafePath`, the same boundary the file
// tools use. That is the point of routing it here rather than letting each layer
// check for itself: a second path check is how one door ends up guarded and the
// other does not, and the door that gets forgotten is always the new one.
//
// **No approval is asked for.** Reading a picture the user just named is the same
// act as `read_file` on a path they typed — except that the model is the one who
// would otherwise have had to call it, and a turn that stopped to ask "may I open
// the file you just told me to look at" is a turn that does not work. The boundary
// (inside the workspace) and the ceiling (five megabytes) are what the design
// settles for instead, and both are enforced here.

// imagePriority is where a user's picture sits in the degradation order.
//
// Stable band, below the session's task (which is priority 50 and pinned): the
// picture belongs to the task rather than to the tool output that churns, so it
// must not be the first thing squeezed — but it is **not** pinned, because pinned
// means "never degrade", and a picture that can be sent as a thumbnail for a tenth
// of the tokens is exactly the case the image ladder exists for.
const imagePriority = 40

// artifactImages is the image loader handed to the wire layer.
//
// It is a pointer with a settable field rather than a plain closure because of the
// order assembly has to happen in: the chat adapter is built **before** the context
// layer exists (the context needs the model's window, which needs the model), while
// the loader needs the context's store. The loader is therefore created empty, given
// to the adapter, and filled in once the store is up.
//
// Requests are built long after assembly finishes, so the field is only ever read
// after it has been written. It is not a lock's job: nothing here is concurrent.
type artifactImages struct {
	manager *context.Manager
}

// Load resolves a picture part to bytes, for the dialect that has to put it on the
// wire.
//
// A false answer means the bytes cannot be fetched, and the dialects turn that into
// a sentence naming the picture rather than an empty image block — see
// internal/model/media.go.
func (l *artifactImages) Load(artifactID string) ([]byte, bool) {
	if l == nil || l.manager == nil || l.manager.Store == nil {
		return nil, false
	}
	return l.manager.Store.Bytes(artifactID)
}

// modelVision reports whether the model in use may be sent pictures.
//
// It reads the catalogue rather than a session flag, and that is the design's
// requirement: `vision` is already the one source of truth for this, so no second
// switch (`supports_image`, `enable_multimodal`, `allow_vision`) is introduced. The
// lookup is by the model and provider **currently in use**, not by what the session
// selected, so a mid-session switch takes effect on the next request.
//
// An unknown model answers false, which is the safe direction: a model that has not
// declared vision is a model nobody promised could see, and sending it a picture
// produces a confident answer about something it never looked at.
func (r *Runtime) modelVision() bool {
	if r.Chat == nil {
		return false
	}
	ref, ok := r.Catalog.Find(r.Chat.ModelName(), r.Chat.ProviderName())
	return ok && ref.Vision
}

// turnMessages composes the opening message of a turn started by a person.
//
// **The text-only case returns exactly what it always returned**: one message whose
// content is a plain string. That is not tidiness — a session that never attaches a
// picture has to send byte-for-byte what it sent before this feature existed, or
// every request in it changes shape and the provider's prefix cache goes cold.
//
// The text comes first and the pictures follow, which is the order the user wrote
// them in. The words are the question; the pictures are what it is about.
func (r *Runtime) turnMessages(text string) []map[string]any {
	pictures := r.attachPictures(text)
	if len(pictures) == 0 {
		return []map[string]any{{"role": "user", "content": text}}
	}
	body := content.Content{}
	if text != "" {
		body = body.WithText(text)
	}
	body = append(body, pictures...)
	return []map[string]any{{"role": "user", "content": body.ToParts()}}
}

// attachPictures resolves the pictures named in a message and stores them.
//
// The order of the four steps is the whole of it, and each exists because the
// alternative is a failure that cannot be seen afterwards:
//
//  1. **resolve before reading.** A token that is not a file — `详见 docs/x.png`,
//     or a name the user mistyped — is left alone, and the sentence goes to the
//     model unchanged. Turning a miss into an error would refuse a turn over a word
//     the model can read perfectly well.
//  2. **the gate before the store.** When the model cannot be shown pictures, the
//     bytes are not collected and the user is **told** — the turn still runs, with
//     the file's path in the text. Silently attaching and letting the renderer drop
//     it would leave the user with no idea why the model ignored their screenshot;
//     refusing the whole turn would make the feature unusable on every model that
//     has not declared vision, which is most of them.
//  3. **one at a time, capped.** Past the cap the rest are named, not silently
//     dropped. A hundred-file glob pasted into the input must not become a request
//     that cannot be sent, and it must not become one where ninety-six of them
//     vanished without a word either.
//  4. **a failed picture does not fail the turn.** An oversized file, a `.png` that
//     is really a ZIP, an unreadable directory: each is reported and skipped. The
//     turn's job is to answer the user, not to validate an attachment.
func (r *Runtime) attachPictures(text string) content.Content {
	if r.ContextValue == nil || r.ContextValue.Store == nil || r.Workspace == nil {
		return nil
	}
	groups := content.FindImagePaths(text)
	if len(groups) == 0 {
		return nil
	}

	// A token that resolves to no file is prose that happens to end in `.png`
	// (someone explaining the format, a path in another machine's transcript), and
	// the only correct reading is "leave the sentence alone".
	var files []string
	for _, candidates := range groups {
		if target, ok := r.resolvePicture(candidates); ok {
			files = append(files, target)
		}
	}
	if len(files) == 0 {
		return nil
	}

	if !r.modelVision() {
		r.reportImagesRefused(files)
		return nil
	}

	body := content.Content{}
	attached := 0
	seen := map[string]bool{}
	var extra []string
	for _, file := range files {
		if attached >= content.MaxImagesPerMessage {
			extra = append(extra, file)
			continue
		}
		artifact, err := r.storePicture(file)
		if err != nil {
			r.reportImageSkipped(file, err.Error())
			continue
		}
		// The same picture twice, through two spellings of its path (`./a.png` and
		// `a.png`): the store is content-addressed, so both resolve to **one**
		// artifact, and appending it twice would put two identical image blocks in the
		// request while the ledger holds one item — the model pays for the picture
		// twice and the budget counts it once. Under-counting is the dangerous
		// direction, so the second naming is dropped here rather than measured later.
		if seen[artifact.ID] {
			continue
		}
		seen[artifact.ID] = true
		// The ledger entry is what lets the picture be degraded and evicted like
		// anything else, and what the renderer reads to decide whether this round
		// sends the original, the thumbnail, or a sentence saying it was here.
		r.ContextValue.Add(artifact.ID, context.AddOptions{
			Zone:     context.ZoneStable,
			Priority: imagePriority,
			Quiet:    true,
		})
		body = body.WithImage(context.ImageRefFor(artifact, content.VariantOriginal))
		attached++
		r.reportImageAttached(artifact)
	}
	if len(extra) > 0 {
		r.reportImagesOverLimit(len(extra), extra)
	}
	return body
}

// resolvePicture takes the first reading of a token that is really a readable file.
//
// The readings come from the scanner in order, because only the filesystem can
// settle which one was meant — see content/pathCandidates. A candidate that escapes
// the workspace is skipped rather than reported: it is a word in a sentence until it
// resolves, and the boundary's answer for it is the same answer `read_file` gives.
func (r *Runtime) resolvePicture(candidates []string) (string, bool) {
	for _, candidate := range candidates {
		target, err := r.Workspace.SafePath(candidate)
		if err != nil {
			continue
		}
		info, err := os.Stat(target)
		if err != nil || info.IsDir() {
			continue
		}
		return target, true
	}
	return "", false
}

// storePicture reads one file and turns it into an artifact.
//
// The size is checked **before** the read, from `Stat`: the ceiling exists to keep a
// large file out of memory, and holding it in memory to measure it defeats that.
func (r *Runtime) storePicture(path string) (context.Artifact, error) {
	info, err := os.Stat(path)
	if err != nil {
		return context.Artifact{}, err
	}
	if info.Size() > int64(context.MaxImageBytes) {
		return context.Artifact{}, fmt.Errorf("它是 %s，超过单张图片 %s 的上限",
			content.HumanSize(int(info.Size())), content.HumanSize(context.MaxImageBytes))
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return context.Artifact{}, err
	}
	return context.AttachImage(r.ContextValue.Store, body, context.ArtifactSource{
		Tool: "attach_image",
		Path: r.displayPath(path),
	})
}

// displayPath is the path as the user wrote it, for the metadata a person reads.
//
// The absolute path is what was read; a workspace-relative one is what the user
// recognises. The relative form is used when it exists, because every notice and
// every rendered label shows this string, and an absolute path in a prompt is both
// long and about this machine rather than about the file.
func (r *Runtime) displayPath(path string) string {
	if r.Workspace == nil {
		return path
	}
	relative, err := filepath.Rel(r.Workspace.Root(), path)
	if err != nil || relative == "" || strings.HasPrefix(relative, "..") {
		return path
	}
	// Forward slashes, always: the relative form ends up in a prompt and in a
	// notice, and on Windows a backslash there reads as an escape character to
	// anybody who copies it into code.
	return filepath.ToSlash(relative)
}

// joinList renders a short list for a sentence.
func joinList(values []string) string {
	if len(values) == 1 {
		return values[0]
	}
	return strings.Join(values, ", ")
}

// reportImageAttached records one picture entering the context.
//
// An audit event rather than a startup notice, because it happens mid-turn: the
// notices travel with the handshake, and this is what the front end draws so the
// user can see that their screenshot was picked up.
func (r *Runtime) reportImageAttached(artifact context.Artifact) {
	r.onEvent(audit.Event(audit.KindImageAttached, r.SessionIDValue, "", 0, map[string]any{
		"artifact_id": artifact.ID,
		"name":        artifact.MetadataString(context.MetaName),
		"path":        artifact.Source.Path,
		"mime":        artifact.MetadataString(context.MetaMIME),
		"bytes":       artifact.Bytes,
		"width":       artifact.MetadataInt(context.MetaWidth),
		"height":      artifact.MetadataInt(context.MetaHeight),
	}))
}

// reportImageSkipped says why one named picture was not attached.
//
// It is a warning rather than a silent skip: the user asked for this picture, and
// a file that is too big or is not really an image is something only they can fix.
func (r *Runtime) reportImageSkipped(path, reason string) {
	r.onEvent(audit.Event(audit.KindImageAttached, r.SessionIDValue, "", 0, map[string]any{
		"path":   r.displayPath(path),
		"status": "skipped",
		"reason": reason,
	}))
}

// reportImagesOverLimit names the pictures that did not fit.
//
// Named rather than counted, because "4 of 9 attached" leaves the reader to work
// out which four — and the answer they need is usually in the list.
func (r *Runtime) reportImagesOverLimit(rest int, paths []string) {
	shown := make([]string, 0, len(paths))
	for _, path := range paths {
		shown = append(shown, r.displayPath(path))
	}
	r.onEvent(audit.Event(audit.KindImageAttached, r.SessionIDValue, "", 0, map[string]any{
		"status": "over_limit",
		"limit":  content.MaxImagesPerMessage,
		"rest":   rest,
		"paths":  shown,
	}))
}

// reportImagesRefused explains why the pictures were not attached at all.
//
// This is the `vision=false` case, and it is said **as a fact about the model**
// rather than about the files: nothing is wrong with the picture, and the fix is a
// different model rather than a different file. It also goes to stderr, because the
// turn still runs and the answer that comes back is about the words only — a person
// who attached a screenshot and got an answer deserves to know it was never seen.
func (r *Runtime) reportImagesRefused(paths []string) {
	names := make([]string, 0, len(paths))
	for _, path := range paths {
		names = append(names, r.displayPath(path))
	}
	text := i18n.T("notice.image.rejected",
		"count", len(names), "names", joinList(names), "model", r.Chat.ModelName())
	r.onEvent(audit.Event(audit.KindImageAttached, r.SessionIDValue, "", 0, map[string]any{
		"status": "refused",
		"names":  names,
		"model":  r.Chat.ModelName(),
	}))
	warn("%s", text)
}
