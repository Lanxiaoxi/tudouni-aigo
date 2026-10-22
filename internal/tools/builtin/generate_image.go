package builtin

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/content"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/imagegen"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// `generate_image`: turn a description into a picture **on disk**.
//
// ## The one decision
//
//	**A generated picture is a file, not a message content.**
//
// It is `out/poster.png` in the workspace: it can be shown with `![](…)`,
// declared with `present`, opened with the system viewer, and found again in a
// later session. It is not a binary pushed into an assistant message, and the
// difference is not cosmetic — that path changes the session schema, opens a
// hole in the "the model produced nothing" check, and loses the picture the
// moment the session is reopened.
//
// That is also why `path` is **required**: this tool writes a file, exactly
// like `write_file` does, and two tools that write files should not have two
// different contracts. The model knows what the picture is and therefore what
// it should be called and where it belongs; inventing a naming policy here
// would be taking a decision away from the one that knows the answer.
//
// ## What it hands back to the model
//
// Two things, and only two:
//
//   - **the path**, so the model can point the user at it;
//   - **the bytes**, in `Result.Images`, so the model can look at what it drew
//     and decide whether to draw it again.
//
// The bytes are the second half of the design's bargain with the context layer:
// `Result.Images` becomes an artifact, becomes an `ImagePart`, and reaches the
// model on the next request — the same chain a picture the *user* names goes
// down. Without a vision model the bytes are **not** returned: storing an
// artifact nobody can look at costs money and buys the renderer a sentence
// saying "this model cannot see pictures". The gate is `Assembly.Vision`, the
// same fact `agent.imagePolicy()` reads — one switch, two readers.
//
// ## Why the text does not describe the picture
//
// "This picture shows a bar chart of revenue by month…" is a paragraph that
// costs tokens, duplicates what is in the picture, and is read by nobody. The
// tool description says so explicitly, because correcting it afterwards in the
// prompt is far more expensive than asking for it once.

// GenerateImageToolName is the tool's name.
//
// It is a constant rather than a literal in the description because the
// registry's `Missing` list, the notice, and the tool itself all have to agree
// on it — and three literals are three chances to disagree.
const GenerateImageToolName = "generate_image"

// MaxGeneratedImageBytes is how large a generated picture may be before it is
// refused.
//
// It lives in the **tool** package and not in `content`, and the two numbers
// are deliberately different:
//
//	MaxGeneratedImageBytes  20MB   may this file be written into the workspace?
//	content.MaxImageBytes    5MB   may this picture go into a request?
//
// Two different questions, and a picture between the two sizes is perfectly
// legal: it is written to disk, it opens in the system viewer, and it simply
// cannot be shown inline or handed to the model. One shared constant would
// make one of those two answers wrong.
const MaxGeneratedImageBytes = 20 * 1024 * 1024

// MaxImagesPerTurn is how many pictures one turn may generate.
//
// The step ceiling is 120, and for a tool where every call costs money that is
// not a ceiling at all — it is a budget with no limit. Four is the point where
// "let me try another one" stops being iteration and becomes drawing by
// lottery.
//
// Past it the answer is **text**, not an error: the model is not malfunctioning,
// it is drawing too many pictures, and the sentence below is the only thing
// that pulls it out of that.
const MaxImagesPerTurn = 4

// generateImageDescription is what the model reads.
//
// It is Chinese on purpose: it is content, not interface text. The three
// "什么时候不要用" entries are the load-bearing part — they are the only place
// that stops the most common waste there is, which is asking a diffusion model
// to draw a bar chart with the wrong numbers on it.
const generateImageDescription = `根据文字描述生成一张图片，保存到工作区。

什么时候用：用户要一张**不存在**的图 —— 插画、海报、封面、装饰性背景、氛围图。
什么时候不要用：
- 数据图表（柱状图、折线图）、架构图、流程图、时序图 —— 用代码画（matplotlib / graphviz / mermaid）
  或找现成的截图。生成模型会写错数字、坐标和文字，这是它的固有缺陷，不是 prompt 的问题；
- 用户已经有图，只是要改一改 —— 这一版没有图生图能力，说清楚；
- 用 shell 能生成的（二维码、占位图、简单几何图形）—— 更便宜也更准。

prompt 描述**画面本身**：主体、风格、构图、光线、色调。不要写"请生成"/"画一张"，
也不要写数据或精确文字（它画不准）。英文 prompt 通常更稳。

path 必填，相对工作区，扩展名只能是 .png / .jpg / .jpeg。

一次一张。**调用成功后只用一句话说明写到哪、要不要展示，不要复述画面内容** ——
图里的东西用户自己看得见。

如果你看得到图片（当前模型支持 vision），生成后可以自己判断是否要改 prompt 重画；
看不到时只有一次机会，prompt 一次写准。`

// NewGenerateImage builds the tool.
//
// The client is nil when no image route is configured, and the tool is then
// **not registered at all** — the rule this program holds everywhere: a tool
// the model can see but that can only ever answer "not configured" costs a
// round trip every time it is tried, and teaches it that tools lie.
//
// The vision gate and the run id are injected rather than read from a
// catalogue: the model can be switched mid-session, so "can this model see
// pictures" is a question with a changing answer, and "which turn is this" is
// a question the tool cannot answer for itself.
func NewGenerateImage(workspace *tools.Workspace, client *imagegen.Client, vision func() bool, runID func() string) tools.Tool {
	counter := &turnCounter{}
	return tools.Tool{
		Name:        GenerateImageToolName,
		Description: generateImageDescription,
		// Medium, like `write_file` and `fetch_web`: it goes out to the network,
		// it costs money, and it writes a file — but it does not run arbitrary
		// code, which is what makes `shell` high.
		Risk: security.RiskMedium,
		// Not parallel-safe, for three reasons stacked on top of each other:
		// every call costs money; the previous picture usually changes the next
		// prompt; and two concurrent calls writing the same path would overwrite
		// each other.
		ParallelSafe: false,
		Schema: tools.ObjectSchema(map[string]any{
			"prompt": tools.StringSchema(
				"画面本身的描述：主体、风格、构图、光线、色调。英文通常更稳",
				tools.MinLength(1)),
			"path": tools.StringSchema(
				"保存路径（相对于工作区），扩展名只能是 .png / .jpg / .jpeg",
				tools.MinLength(1)),
			"orientation": tools.StringSchema(
				"画面朝向：square（默认）/ landscape / portrait",
				tools.Enum("square", "landscape", "portrait"),
				tools.Default(string(imagegen.OrientationSquare))),
		}, "prompt", "path"),
		Handler: func(ctx context.Context, args map[string]any) (tools.Result, error) {
			return generateImage(ctx, workspace, client, vision, runID, counter, args)
		},
	}
}

// generateImage is the tool's body.
//
// The order of the steps is the design, and each step earns its place:
//
//  1. **the extension, before anything costs money.** A `.gif` path is refused
//     before the request goes out, because this is the only error that can be
//     caught for free.
//  2. **the per-turn count.** Also before the request: the fifth picture of a
//     turn is refused whether or not it would have been paid for.
//  3. **the boundary.** A path outside the workspace is an **error**, not a
//     sentence — the model cannot fix "outside the workspace" by choosing
//     differently, and an error says so where a sentence invites a retry.
//  4. **the request**, with the turn's context attached so a stop abandons it.
//  5. **the format**, decided by the bytes and never by the extension.
//  6. **the write**, atomic.
func generateImage(
	ctx context.Context,
	workspace *tools.Workspace,
	client *imagegen.Client,
	vision func() bool,
	runID func() string,
	counter *turnCounter,
	args map[string]any,
) (tools.Result, error) {
	prompt, _ := args["prompt"].(string)
	path, _ := args["path"].(string)
	orientation, _ := args["orientation"].(string)

	// 1. The extension. Before the money, and before anything else.
	extension, ok := imageExtension(path)
	if !ok {
		return tools.TextResult(fmt.Sprintf(
			"扩展名只能是 .png / .jpg / .jpeg —— %s 这个路径不符合，没有发起请求。"+
				"改成 .png 就行（PNG 是无损的；写成 .jpg 会把无损图有损压缩，这个决定不该由工具替你做）。",
			path)), nil
	}

	// 2. The boundary. A path outside the workspace is not something the model
	// can argue its way past, so it is an error rather than a sentence.
	//
	// It is checked **before** the count, because it is refused before the
	// request goes out — and a call that never reached the provider must not
	// spend a turn's picture budget. The same is true of the extension above.
	target, err := workspace.WritablePath(path)
	if err != nil {
		if isBoundaryRefusal(err.Error()) {
			return tools.Result{}, fmt.Errorf("refusing to generate an image at %s: %s", path, err.Error())
		}
		return tools.TextResult("无法写入：" + path + "（" + err.Error() + "）"), nil
	}

	// 3. The per-turn count. Also before the request: the fifth picture of a
	// turn is refused whether or not it would have been paid for.
	//
	// The claim is taken **before** the request rather than after it, because
	// a request that went out and failed still cost the user money. Counting
	// only the successes would let a turn that failed ten times keep trying.
	currentRun := ""
	if runID != nil {
		currentRun = runID()
	}
	if !counter.claim(currentRun) {
		return tools.TextResult(fmt.Sprintf(
			"这一轮已经生成了 %d 张图，不再继续了。\n"+
				"先说清楚哪一张不对、要怎么改，再决定要不要重画 —— 一次一张、看着结果改 prompt，比一次抽几张挑一张更省。",
			MaxImagesPerTurn)), nil
	}

	// 4. The request.
	started := time.Now()
	picture, err := client.Generate(ctx, imagegen.Request{
		Prompt:      prompt,
		Orientation: imagegen.Orientation(orientation),
	})
	if err != nil {
		return imageFailure(path, err, client)
	}
	durationMs := int(time.Since(started).Milliseconds())

	// 5. The format, decided by the bytes.
	//
	// **The extension is never trusted.** A `.png` that is really a JPEG is
	// common enough, and a file whose name and content disagree is refused by
	// the display path with a message about the format rather than about the
	// file. The rule below is asymmetric on purpose:
	//
	//   - JPEG/GIF into a `.png`: re-encoded as PNG. Pure size cost, no quality
	//     lost, so the tool may do it.
	//   - PNG into a `.jpg`: **refused**. Turning a lossless picture into a lossy
	//     one is a decision with a quality cost, and a decision with a cost is
	//     not the tool's to make.
	//
	// The order is: the size first (a ceiling is checked before the bytes are
	// decoded, or the check would defeat itself), then the format.
	//
	// The write ceiling, checked on the bytes **as they arrived** — before any
	// re-encoding, because a re-encode can only make the picture bigger.
	if len(picture.Body) > MaxGeneratedImageBytes {
		return tools.TextResult(fmt.Sprintf(
			"这一张超过 %s，没有写入 %s。", content.HumanSize(MaxGeneratedImageBytes), path)), nil
	}

	// The format is sniffed **before** the full inspection, because the two
	// failures have different remedies and one message cannot carry both:
	// "this is not a picture at all" and "this is a picture in a format this
	// chain does not handle" are different answers.
	sniffed := sniffedMIME(picture.Body)
	if sniffed == "" {
		return tools.TextResult(fmt.Sprintf(
			"provider 返回的不是图片（探测到 %s），没有写入 %s。",
			content.HumanSize(len(picture.Body)), path)), nil
	}
	if !supportedImageMIME(sniffed) {
		// Two different answers, and the message has to say which one it is:
		// "this is not a picture at all" and "this is a picture in a format
		// this chain does not handle" have different remedies — one of them is
		// the provider's, and the other is this program's.
		if !isPictureMIME(sniffed) {
			return tools.TextResult(fmt.Sprintf(
				"provider 返回的不是图片（探测到 %s，%s），没有写入 %s。",
				sniffed, content.HumanSize(len(picture.Body)), path)), nil
		}
		return tools.TextResult(fmt.Sprintf(
			"返回的格式是 %s，这条链路只处理 PNG/JPEG/GIF，没有写入 %s。", sniffed, path)), nil
	}

	inspected, err := content.InspectImage(picture.Body)
	if err != nil {
		return tools.TextResult(fmt.Sprintf(
			"provider 返回的不是图片（%s），没有写入 %s。", err.Error(), path)), nil
	}
	body := picture.Body
	note := ""
	if extension == ".png" && inspected.MIME != "image/png" {
		reencoded, err := encodePNG(picture.Body)
		if err != nil {
			return tools.TextResult(fmt.Sprintf(
				"provider 返回的是 %s，无法转成 PNG 写入 %s（%s）。",
				inspected.MIME, path, err.Error())), nil
		}
		body = reencoded
		note = fmt.Sprintf("provider 返回 %s，已转成 PNG 写入 %s。", inspected.MIME, path)
	}
	if extension != ".png" && inspected.MIME == "image/png" {
		return tools.TextResult(fmt.Sprintf(
			"这张是无损 PNG，不能写成 %s —— 转 JPEG 是有损重编码，这个决定不该由我做。"+
				"把 path 改成 .png 再调一次。", path)), nil
	}
	// A re-encode grew the picture past the ceiling. The write is refused
	// rather than the file written and the ceiling broken after the fact.
	if len(body) > MaxGeneratedImageBytes {
		return tools.TextResult(fmt.Sprintf(
			"这一张超过 %s，没有写入 %s。", content.HumanSize(MaxGeneratedImageBytes), path)), nil
	}

	// 6. The write, atomically.
	if err := writeAtomicFile(target, body); err != nil {
		return tools.TextResult("无法写入：" + path + "（" + err.Error() + "）"), nil
	}

	// The measured size, not the one asked for: the provider may have returned
	// something other than what was requested, and the audit should say what
	// arrived.
	measured, _ := content.InspectImage(body)
	width, height := 0, 0
	if measured.MIME != "" {
		width, height = measured.Width, measured.Height
	}

	// The text says where it went and what to do next. It does **not** describe
	// the picture: that text is in the picture, and it costs tokens to repeat.
	text := fmt.Sprintf("已生成 %d×%d 的图片，写入 %s。", width, height, path)
	if note != "" {
		text = note
	}

	// The bytes go back to the model **only when the model can look at them**.
	//
	// Two conditions, and both of them are facts rather than policies:
	//
	//   - the model has to be able to see pictures. Without a vision model the
	//     bytes would be stored as an artifact and then refused by the
	//     renderer, which costs money and produces a sentence the model reads
	//     about a picture it never saw.
	//   - the picture has to fit in a request. The context ceiling is
	//     `content.MaxImageBytes` — five megabytes — and the write ceiling is
	//     twenty. A picture between the two is perfectly legal: it is on disk,
	//     it opens in the system viewer, it can be declared as a deliverable.
	//     It just cannot be inlined, and saying so is better than a failure
	//     nobody can act on.
	var images []tools.ImageContent
	inline := true
	switch {
	case vision == nil || !vision():
		inline = false
		text += "\n（当前模型看不到图片，所以这张图没有回传给你 —— 你只能靠路径指给人看。）"
	case len(body) > content.MaxImageBytes:
		inline = false
		text += fmt.Sprintf(
			"\n这一张有 %s，超过能内联显示的 %s 上限，所以没有回传给你 ——"+
				"它已经写到工作区里了，人可以打开它，但你看不见。"+
				"要缩小请换 orientation，或者请用户自己压一下。",
			content.HumanSize(len(body)), content.HumanSize(content.MaxImageBytes))
	default:
		images = []tools.ImageContent{{
			Body: body,
			Name: filepath.Base(target),
			Path: path,
		}}
	}
	text += "\n要让人直接看到，就在回复里写 ![说明](" + path + ")；" +
		"这是这次要交付的文件，再用 present 声明它。"

	audit := map[string]any{
		"style":       imagegen.StyleOpenAIImages,
		"model":       client.Route().Model,
		"request_url": client.Endpoint(),
		"orientation": orientation,
		"size":        fmt.Sprintf("%dx%d", width, height),
		"bytes":       len(body),
		"path":        path,
		"duration_ms": durationMs,
		// Whether the picture came back to the model. It is a fact about what
		// happened, and it is the one that explains a model that says "I can't
		// see the picture" about a file that is sitting right there.
		"inline": inline,
	}
	if picture.RevisedPrompt != "" {
		audit["revised_prompt"] = picture.RevisedPrompt
	}
	if picture.RequestID != "" {
		audit["request_id"] = picture.RequestID
	}
	// The usage is reported **only when the provider reported it**. A made-up
	// token count would be believed by every report that reads it, and a zero
	// would be read as "this call was free".
	if picture.Usage != nil {
		audit["usage"] = map[string]any{
			"input_tokens":  picture.Usage.InputTokens,
			"output_tokens": picture.Usage.OutputTokens,
		}
	}

	return tools.Result{Text: text, Images: images, Audit: audit}, nil
}

// imageFailure turns a generation failure into the sentence the model reads.
//
// The classification is the whole point, and it is copied from `present`: a
// failure the model can fix by changing an argument is **text**, and a failure
// only a person can fix is an **error**. A policy refusal is the sharpest
// case — "do not send this again" has to be said out loud, because a request
// that repeats itself is observable behaviour on the provider's side and the
// cost lands on the user's account.
func imageFailure(path string, err error, client *imagegen.Client) (tools.Result, error) {
	endpoint := client.Endpoint()
	model := client.Route().Model
	switch {
	case imagegen.IsCancelled(err):
		return tools.TextResult("生成被中断，这一轮不再等它了。"), nil

	case imagegen.IsPolicy(err):
		return tools.TextResult(fmt.Sprintf(
			"生成被拒绝：%s\n"+
				"**不要原样重试** —— 改掉可能触发的部分，或改用代码画（matplotlib / graphviz / mermaid）。",
			err.Error())), nil

	case imagegen.IsRateLimit(err):
		return tools.TextResult(fmt.Sprintf(
			"被限流了：%s\n稍后再试，或换个生成路由。", err.Error())), nil

	case imagegen.IsServer(err):
		return tools.TextResult(fmt.Sprintf(
			"生成端点出错：%s\n可以稍后再试。", err.Error())), nil

	case imagegen.IsCredential(err):
		// A refused credential is not something the model can fix, and it is
		// not something a retry will change. It is an **error**, and the message
		// names the URL that was used — an inherited base URL that does not
		// offer `/images/generations` produces a 404, and without the URL that
		// is a mystery rather than a report.
		return tools.Result{}, fmt.Errorf(
			"`image_generation` 的凭据被拒绝（实际请求 %s，model=%s）：%s",
			endpoint, model, err.Error())

	case imagegen.IsTimeout(err):
		return tools.TextResult(fmt.Sprintf(
			"生成超时了：%s\n可以重试一次；连续超时就换个生成路由。", err.Error())), nil

	case imagegen.IsTooLarge(err):
		return tools.TextResult(fmt.Sprintf(
			"这一张超过 %s，没有写入 %s。", content.HumanSize(MaxGeneratedImageBytes), path)), nil

	case imagegen.IsNotAnImage(err):
		return tools.TextResult(fmt.Sprintf(
			"provider 返回的不是图片（%s）。", err.Error())), nil

	case imagegen.IsRequest(err):
		return tools.TextResult(fmt.Sprintf(
			"生成请求被拒绝：%s\n实际请求的地址是 %s（model=%s）—— 如果这是 404，说明这个端点不提供 /images/generations，"+
				"请让用户在配置里给 `image_generation` 单独写一个 base_url。", err.Error(), endpoint, model)), nil

	default:
		return tools.TextResult(fmt.Sprintf(
			"生成没有成功：%s\n实际请求的地址是 %s（model=%s）。", err.Error(), endpoint, model)), nil
	}
}

// imageExtension reads the extension a path asks for, and says whether it is
// one this tool writes.
//
// The check is here rather than in the schema because the schema's job is to
// describe the arguments, and a refusal that costs money to discover must be
// caught on the **program's** side of the wire.
func imageExtension(path string) (string, bool) {
	extension := strings.ToLower(filepath.Ext(path))
	switch extension {
	case ".png", ".jpg", ".jpeg":
		return extension, true
	default:
		return "", false
	}
}

// supportedImageMIME reports whether this tool writes this format.
func supportedImageMIME(mime string) bool {
	switch mime {
	case "image/png", "image/jpeg", "image/gif":
		return true
	default:
		return false
	}
}

// isPictureMIME reports whether the bytes are a picture at all.
//
// It is the difference between "the provider sent a webp" and "the provider
// sent an HTML error page", and the two are different answers: one is a
// format this chain does not handle, the other is not a picture.
func isPictureMIME(mime string) bool {
	return strings.HasPrefix(mime, "image/")
}

// sniffedMIME says what the bytes look like, without decoding them.
//
// It is the cheap half of `content.InspectImage`: the sniff reads the header
// only, so it can answer "is this a picture at all, and of what format"
// without paying for a full decode — and the answer is enough to refuse a
// format this chain does not handle.
//
// An empty string means "not a picture this program recognises". It is not the
// same as "the bytes are empty": a zero-byte body is reported by the size.
func sniffedMIME(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	sniffed := http.DetectContentType(body)
	return strings.TrimSpace(strings.SplitN(sniffed, ";", 2)[0])
}

// encodePNG re-encodes a picture as PNG.
//
// It is used for the one direction that is free of quality loss: JPEG into a
// `.png` path costs disk space and nothing else, so the tool may do it — while
// the other direction is refused, because there the cost is pixels.
func encodePNG(body []byte) ([]byte, error) {
	decoded, _, err := image.Decode(bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("cannot decode the picture: %w", err)
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, decoded); err != nil {
		return nil, fmt.Errorf("cannot encode it as PNG: %w", err)
	}
	return buffer.Bytes(), nil
}

// turnCounter is the per-turn picture counter.
//
// ## Why it counts by run id rather than being reset
//
// A tool that had to be told when a turn ended would need the runtime to call
// a reset — and a runtime that forgets produces a counter that never resets,
// which is a failure nobody can see: the fifth picture of the second turn is
// refused exactly as the fifth of the first was.
//
// So the counter **compares the run id** instead. A new turn has a new id, the
// count resets by the comparison, and nothing has to be reset at all. There is
// no path by which a turn can end without the counter noticing.
//
// The counter belongs to one tool instance, so it is guarded: two calls in one
// batch would otherwise race on the count and one of them would slip past the
// ceiling.
type turnCounter struct {
	mu    sync.Mutex
	runID string
	count int
}

// claim reserves one picture of this turn's budget.
//
// It reports false when the turn has already spent its budget.
//
// The count is taken **before** the request goes out rather than after it
// answers: a refused call still cost a request, and a picture that failed to
// generate is still a picture the turn asked for. The flip side is that a call
// refused **before** the request — a bad extension, a path outside the
// workspace — must not claim anything, which is why those checks come first.
func (c *turnCounter) claim(runID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.runID != runID {
		c.runID = runID
		c.count = 0
	}
	if c.count >= MaxImagesPerTurn {
		return false
	}
	c.count++
	return true
}

// writeAtomicFile replaces a file in one step.
//
// A temporary file in the same directory, then a rename. The rename is what
// makes the transition atomic from a reader's point of view, and it keeps
// Windows working: Go's `os.Rename` replaces an existing destination there.
//
// A half-written picture is worse than no picture: the display path reads the
// file and shows it as a broken image, and the user has no way to tell that
// from "the model produced a corrupt picture".
func writeAtomicFile(path string, body []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".imagegen-*")
	if err != nil {
		return err
	}
	temporary := file.Name()
	cleanup := func() {
		file.Close()
		os.Remove(temporary)
	}
	if _, err := file.Write(body); err != nil {
		cleanup()
		return err
	}
	if err := file.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := file.Close(); err != nil {
		os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		os.Remove(temporary)
		return err
	}
	return nil
}
