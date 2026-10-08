package builtin

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/content"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// read_image lets the model look at a picture instead of being told about one.
//
// It exists because of a gap that was measurable rather than theoretical: the
// model could `list_files` and see `architecture.png`, could not `read_file` it
// (that tool refuses anything that is not UTF-8), and had **no** way to get at the
// pixels. So it did what a capable agent does when the obvious door is shut — it
// went around: four PowerShell `System.Drawing` pixel scans in one turn, 35k prompt
// tokens, to re-derive what a vision model reads in one look.
//
// ## What it returns, and what it deliberately does not
//
// It does **not** return text describing the picture, and it does not return
// base64. It hands back the file's own bytes in `Result.Images`, which the agent
// turns into an artifact — the same chain a picture the *user* names in their
// message goes down:
//
//	user names a path ──┐
//	                    ├→ ImageArtifact → ImagePart → Context → LLM
//	read_image(path) ───┘
//
// That sameness is the whole design. Everything downstream already works for the
// user's pictures: the budget prices them by area, the degradation ladder shrinks
// them to a thumbnail before it drops them, the renderer re-points them at whatever
// level the ledger says, and all three protocols encode them. A second path into
// the model would need a second copy of every one of those, and the copy is where
// they would drift.
//
// Base64 in `Text` would be the wrong answer for three separate reasons, and they
// are worth stating because it is the obvious thing to do: the estimator would
// count it as characters (a megabyte of "text" that is not text), the session file
// would store it and re-send it on every later turn, and the model would receive an
// undecodable wall of letters rather than a picture.
func NewReadImage(workspace *tools.Workspace) tools.Tool {
	return tools.Tool{
		Name: "read_image",
		Description: "读取一张图片，让你真正看到它的内容（png / jpg / gif）。" +
			"图片会进入上下文，之后按预算自动降级（原图 → 缩略图 → 只剩一句说明），所以同一张不用反复读。\n" +
			"read_file 读不了图片（它只处理 UTF-8 文本），要看图就用这个；" +
			"先用 list_files 或 grep 找到路径再读，不要靠猜。\n" +
			"文件不存在、不是图片、超出工作区、或超过单张上限都会说明原因。",
		// Low and parallel-safe, the same pair read_file declares: two integers do
		// not widen what this can reach, it only reads, and holding it out of the
		// parallel band would make every batch containing one image run serially.
		Risk:         security.RiskLow,
		ParallelSafe: true,
		Schema: tools.ObjectSchema(map[string]any{
			"path": tools.StringSchema("图片路径（工作区内，相对或绝对都行）", tools.MinLength(1)),
		}, "path"),
		Handler: func(ctx context.Context, args map[string]any) (tools.Result, error) {
			return readImage(workspace, args)
		},
	}
}

// readImage resolves the path, checks the three ceilings, and hands the bytes back.
//
// The order matters and each step earns its place:
//
//  1. **the workspace boundary first** — `SafePath`, the same door `read_file`
//     uses. Nothing about a picture makes an outside path readable.
//  2. **the size ceiling from `Stat`, before the read.** The ceiling exists to keep
//     a large file out of memory; reading it in order to measure it defeats that.
//  3. **identify it from its bytes**, not from the extension. A `.png` that is
//     really a JPEG is common, and a media type that disagrees with the payload is
//     refused by the endpoint with a message about the media type rather than the
//     file.
//  4. **measure it**, refusing a decompression bomb rather than decoding one.
//
// Every failure is a sentence the model can act on rather than an error: a missing
// file, a directory, a text file named `.png` and an oversized picture all have a
// different remedy, and "the tool failed" tells the model none of them.
func readImage(workspace *tools.Workspace, args map[string]any) (tools.Result, error) {
	path, _ := args["path"].(string)
	target, err := workspace.SafePath(path)
	if err != nil {
		// The structured shape read_file uses, so a model that has learned to read
		// one of these recognises the other.
		msg := fmt.Sprintf(`{"ok": false, "error_type": "PermissionError", "message": %q}`, err.Error())
		return tools.TextResult(msg), nil
	}

	info, statErr := os.Stat(target)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			return tools.TextResult("文件不存在：" + path + "（先用 list_files 或 grep 找到真实路径）"), nil
		}
		return tools.TextResult("无法读取：" + path + "（" + statErr.Error() + "）"), nil
	}
	if info.IsDir() {
		return tools.TextResult("这是目录，不是图片：" + path + "（列目录里的东西用 list_files）"), nil
	}
	if err := content.TooLargeForOneImage(int(info.Size())); err != nil {
		return tools.TextResult("图片太大：" + path + "，" + err.Error() +
			"。如果只是想知道它是什么，可以看文件名或让用户描述；需要细节的话请用户压缩后再发。"), nil
	}

	raw, readErr := os.ReadFile(target)
	if readErr != nil {
		return tools.TextResult("无法读取：" + path + "（" + readErr.Error() + "）"), nil
	}

	// The sniff is what decides, and it is why a text file named `diagram.png` gets
	// a useful sentence instead of being sent and refused by the endpoint.
	picture, inspectErr := content.InspectImage(raw)
	if inspectErr != nil {
		return tools.TextResult("这不是一张能读的图片：" + path + "，" + inspectErr.Error() +
			"。read_image 只处理 " + joinNames(content.ImageMIMENames()) + "。"), nil
	}

	name := filepath.Base(target)
	return tools.Result{
		// The text is what history keeps as the tool result's reference, so it says
		// what happened and how big the picture is — the facts a later turn can
		// still act on after the picture itself has degraded to a thumbnail.
		Text: fmt.Sprintf("已读取图片 %s（%s，%d×%d，%s）。",
			path, picture.MIME, picture.Width, picture.Height, content.HumanSize(len(raw))),
		// The bytes travel here, and they are the **only** place a picture enters
		// the model's context from a tool. Turning them into an artifact is the
		// agent's job, not this handler's: the artifact store has one writer, and a
		// tool that minted ids would be a second one.
		Images: []tools.ImageContent{{
			Body: raw,
			Name: name,
			Path: path,
		}},
	}, nil
}

// joinNames renders a short list for a sentence.
func joinNames(names []string) string {
	out := ""
	for index, name := range names {
		if index > 0 {
			out += " / "
		}
		out += name
	}
	return out
}
