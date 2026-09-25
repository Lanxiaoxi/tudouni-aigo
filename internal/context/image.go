package context

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	// The decoders are registered for their side effect: `image.DecodeConfig` and
	// `image.Decode` only know a format whose package has been linked in, and a
	// missing registration shows up as "unknown image format" on a file that is
	// perfectly readable by every other program on the machine.
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/content"
)

// Pictures, as the context layer stores them.
//
// This file is the **only** place that knows what an image is: how to tell one
// from a text file, how big it is allowed to be, and how to make a smaller copy of
// it. Everything above it works with `content.ImageRef`, which is a pointer plus
// facts, and everything below it is "bytes on disk".
//
// The rule it exists to hold:
//
//	**the artifact stores the file's own bytes.**
//
// Not base64. Base64 in the store would cost a third more disk, would be counted
// by every estimate as text (a megabyte of "characters" that are not characters),
// and — the reason that matters — would be re-sent with the session on every later
// turn instead of being fetched once per request by the one layer that needs it.
// The encoding happens in the provider adapter, at the last possible moment, and
// this package never sees it.
const (
	// MaxImageBytes is how large an image file may be before it is refused.
	//
	// Five megabytes is the smallest published request-side limit of the three
	// protocols this program speaks (the Messages shape's per-image cap, in its
	// base64 form, which is a third larger than the file). Refusing here rather
	// than letting the endpoint refuse is the difference between a sentence the
	// user can act on and a 400 from a gateway.
	MaxImageBytes = 5 * 1024 * 1024

	// MaxImagePixels caps the decoded area.
	//
	// It is a **decompression-bomb guard**, not a quality judgement: a 20000×20000
	// PNG is a few hundred kilobytes on disk and 1.6GB in memory once decoded, and
	// this program decodes every image it accepts in order to measure it. Refusing
	// the file costs a message; decoding it costs the process.
	MaxImagePixels = 40_000_000

	// ThumbnailMaxDimension is the long edge of a thumbnail.
	//
	// 1024 is chosen against the providers rather than against the screen: the two
	// host APIs bill (and internally tile) around 768–1024px, so a picture larger
	// than this is mostly paid for and not seen. It is what makes the thumbnail
	// rung of an image's degradation ladder worth having at all.
	ThumbnailMaxDimension = 1024

	// ThumbnailJPEGQuality is the quality a photographic thumbnail is encoded at.
	// It is a size decision: the thumbnail exists to be cheaper, and quality 80 is
	// where JPEG stops being visibly worse for a picture that is already a quarter
	// of the original's width.
	ThumbnailJPEGQuality = 80
)

// MetaThumbnailID is the metadata key naming a picture's thumbnail artifact.
//
// The thumbnail is a **separate artifact**, content-addressed like any other
// body, rather than a second file beside the original. That is what makes the
// degradation step cheap and reversible to reason about: the item's level names
// which artifact id to send, and "which bytes are these" is answered by the id
// itself.
const MetaThumbnailID = "thumbnail_id"

// MetaThumbnailMIME is the thumbnail's own mime type, which is not always the
// original's: a transparent PNG becomes a smaller PNG, an opaque one becomes a
// JPEG.
const MetaThumbnailMIME = "thumbnail_mime"

// imageMIMEs are the formats this program accepts, and the only names it will put
// on a wire as a media type.
//
// The list is the intersection of "the three protocols accept it" and "this build
// can measure it". WebP is deliberately absent: no stdlib decoder means no
// dimensions and no thumbnail, and accepting a format that can only ever be sent
// at full size and estimated from its byte count is a worse deal than saying so.
var imageMIMEs = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/gif":  true,
}

// imageExtensions is what "this token is a picture" is decided on when scanning a
// message for paths.
//
// It is an extension test rather than a content test on purpose: the scan sees a
// sentence, and the only cheap question it can ask about a word in it is "does
// this look like a file name". The expensive question — "is it really a PNG" — is
// asked once, after the file has been read.
var imageExtensions = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true,
}

// IsImagePath reports whether a path's extension names a picture this program
// handles.
func IsImagePath(path string) bool {
	return imageExtensions[strings.ToLower(filepath.Ext(strings.TrimSpace(path)))]
}

// imageInfo is what was learned by looking at a file's bytes.
type imageInfo struct {
	MIME      string
	Width     int
	Height    int
	Decodable bool
}

// inspectImage identifies a byte stream as a picture, or refuses it.
//
// The mime type comes from the **bytes**, never from the file name: a `.png` that
// is really a JPEG is common enough (a screenshot tool renaming its output, a file
// downloaded twice), and a media type that disagrees with the data is refused by
// the endpoint with a message about the media type rather than about the file.
//
// Dimensions are read with `DecodeConfig`, which parses headers only. That is
// deliberate: the full decode happens once, for the thumbnail, and only when a
// thumbnail is actually wanted.
func inspectImage(body []byte) (imageInfo, error) {
	if len(body) == 0 {
		return imageInfo{}, fmt.Errorf("the file is empty")
	}
	sniffed := http.DetectContentType(body)
	// `DetectContentType` answers `image/png`, `image/jpeg` and `image/gif`
	// exactly; a subtype it reports (`image/bmp`) is not one of the three this
	// program speaks, and neither is the `application/octet-stream` it gives for
	// anything it does not know.
	mime := strings.TrimSpace(strings.SplitN(sniffed, ";", 2)[0])
	if !imageMIMEs[mime] {
		return imageInfo{}, fmt.Errorf("its content is %s, which is not one of the picture formats this program handles (%s)",
			mime, strings.Join(imageMIMENames(), ", "))
	}

	info := imageInfo{MIME: mime}
	config, _, err := image.DecodeConfig(bytes.NewReader(body))
	if err != nil {
		// A header it cannot parse means the file is truncated or corrupt. Saying
		// so is better than sending it: the endpoint would refuse it anyway, and
		// the refusal that arrives from there names the media type.
		return info, fmt.Errorf("its %s header could not be read: %v", mime, err)
	}
	info.Width, info.Height = config.Width, config.Height
	info.Decodable = true
	if info.Width <= 0 || info.Height <= 0 {
		return info, fmt.Errorf("it claims a %dx%d size", info.Width, info.Height)
	}
	if info.Width*info.Height > MaxImagePixels {
		return info, fmt.Errorf("it decodes to %dx%d, which is over the %d-pixel ceiling (a picture this large is a few hundred kilobytes on disk and gigabytes in memory)",
			info.Width, info.Height, MaxImagePixels)
	}
	return info, nil
}

func imageMIMENames() []string {
	names := make([]string, 0, len(imageMIMEs))
	for name := range imageMIMEs {
		names = append(names, name)
	}
	// A fixed order so the sentence is the same every time it is printed.
	for left := 0; left < len(names); left++ {
		for right := left + 1; right < len(names); right++ {
			if names[right] < names[left] {
				names[left], names[right] = names[right], names[left]
			}
		}
	}
	return names
}

// makeThumbnail produces a smaller copy of a picture.
//
// It returns the encoded bytes, their mime type, their dimensions and their **byte
// size**, or `ok=false` for "no thumbnail is possible" — which the caller reads as
// "this picture has nowhere to go except metadata". That is the honest answer for a
// format this build cannot decode and for a picture that is already small enough.
//
// **It never upscales.** A picture smaller than the limit is not made bigger to fit
// it: the thumbnail exists to make the request cheaper, and upscaling makes both the
// request and the picture worse.
//
// ## Why the decision is *not* made on bytes
//
// The obvious gate — "keep it if it is fewer bytes" — was tried and it is wrong, and
// measurably so: a 2000×1400 gradient PNG of 55KB encodes to a 68KB JPEG thumbnail.
// The byte count went **up** while the picture went from 2000×1400 to 1024×716.
//
// That is not an edge case, it is the common one. Screenshots and photographs
// compress well as PNG, so a re-encode to JPEG is often larger on disk while being a
// quarter of the pixels — and a byte gate would reject the thumbnail for exactly the
// files this feature exists to handle, leaving the ladder with no rung between "the
// whole picture" and "a sentence about the picture".
//
// What the window is spent on is pixels: every protocol bills an image by its area
// (see ImageCost), which is what the budget measures and what the ladder has to
// reduce. So the gate is the one that matches the accounting, and the caller decides
// it — this function only reports what it made.
func makeThumbnail(body []byte, info imageInfo) (thumbnail, bool) {
	if !info.Decodable {
		return thumbnail{}, false
	}
	if info.Width <= ThumbnailMaxDimension && info.Height <= ThumbnailMaxDimension {
		return thumbnail{}, false
	}
	decoded, _, err := image.Decode(bytes.NewReader(body))
	if err != nil {
		return thumbnail{}, false
	}
	width, height := fitWithin(info.Width, info.Height, ThumbnailMaxDimension)
	small := scaleBox(decoded, width, height)
	if small == nil {
		return thumbnail{}, false
	}

	var buffer bytes.Buffer
	mime := "image/jpeg"
	if hasAlpha(small) {
		// Transparency has to survive: flattening a logo's alpha channel onto
		// black is a picture the user did not send.
		mime = "image/png"
		if err := png.Encode(&buffer, small); err != nil {
			return thumbnail{}, false
		}
	} else if err := jpeg.Encode(&buffer, small, &jpeg.Options{Quality: ThumbnailJPEGQuality}); err != nil {
		return thumbnail{}, false
	}
	return thumbnail{
		Body:   buffer.Bytes(),
		MIME:   mime,
		Width:  width,
		Height: height,
	}, true
}

// thumbnail is one smaller copy, before it is stored.
type thumbnail struct {
	Body   []byte
	MIME   string
	Width  int
	Height int
}

// worthStoring reports whether a thumbnail is a real degradation of one picture.
//
// The test is the cost the budget actually pays — tiles and area — not the file
// size, for the reason makeThumbnail documents at length. A thumbnail that does not
// reduce that is a rung that moves the level without shrinking the request, which is
// invisible in both the level and the token bill.
func (t thumbnail) worthStoring(original imageInfo, originalBytes int) bool {
	before := ImageCost(artifactImage{
		Width: original.Width, Height: original.Height, Bytes: originalBytes,
	})
	after := ImageCost(artifactImage{Width: t.Width, Height: t.Height, Bytes: len(t.Body)})
	return after < before
}

// fitWithin scales a size down so its long edge is at most limit, keeping the
// aspect ratio and never going below one pixel.
func fitWithin(width, height, limit int) (int, int) {
	if width <= limit && height <= limit {
		return width, height
	}
	if width >= height {
		scaled := height * limit / width
		if scaled < 1 {
			scaled = 1
		}
		return limit, scaled
	}
	scaled := width * limit / height
	if scaled < 1 {
		scaled = 1
	}
	return scaled, limit
}

// scaleBox resizes by averaging each source block.
//
// A box filter rather than nearest-neighbour, and the difference is visible on
// exactly the pictures this program sees: a screenshot's text and a photo's fine
// detail alias into noise under nearest-neighbour, and the thumbnail is then
// something the model cannot read — which defeats the point of sending a smaller
// copy instead of no copy.
func scaleBox(source image.Image, width, height int) image.Image {
	if width <= 0 || height <= 0 {
		return nil
	}
	bounds := source.Bounds()
	sourceWidth, sourceHeight := bounds.Dx(), bounds.Dy()
	if sourceWidth <= 0 || sourceHeight <= 0 {
		return nil
	}
	target := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		y0 := bounds.Min.Y + y*sourceHeight/height
		y1 := bounds.Min.Y + (y+1)*sourceHeight/height
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for x := 0; x < width; x++ {
			x0 := bounds.Min.X + x*sourceWidth/width
			x1 := bounds.Min.X + (x+1)*sourceWidth/width
			if x1 <= x0 {
				x1 = x0 + 1
			}
			target.Set(x, y, averageBlock(source, x0, y0, x1, y1))
		}
	}
	return target
}

// averageBlock averages one source block. Alpha is averaged in premultiplied
// space, which is the only space where averaging colours is meaningful — doing it
// on straight alpha is what makes a transparent edge go black.
func averageBlock(source image.Image, x0, y0, x1, y1 int) color.RGBA {
	var sumRed, sumGreen, sumBlue, sumAlpha, count uint64
	for y := y0; y < y1; y++ {
		for x := x0; x < x1; x++ {
			red, green, blue, alpha := source.At(x, y).RGBA()
			// The 16-bit channels become 8-bit numbers weighted by their own
			// opacity, so that fully transparent pixels cannot darken the average.
			weight := alpha >> 8
			sumRed += uint64(red>>8) * uint64(weight)
			sumGreen += uint64(green>>8) * uint64(weight)
			sumBlue += uint64(blue>>8) * uint64(weight)
			sumAlpha += uint64(weight)
			count++
		}
	}
	if count == 0 {
		return color.RGBA{}
	}
	if sumAlpha == 0 {
		return color.RGBA{}
	}
	mean := sumAlpha / count
	if mean == 0 {
		mean = 1
	}
	return color.RGBA{
		R: uint8(clampByte(sumRed / sumAlpha)),
		G: uint8(clampByte(sumGreen / sumAlpha)),
		B: uint8(clampByte(sumBlue / sumAlpha)),
		A: uint8(clampByte(mean)),
	}
}

func clampByte(value uint64) uint64 {
	if value > 255 {
		return 255
	}
	return value
}

// hasAlpha reports whether any pixel is not fully opaque.
//
// It decides the thumbnail's encoding — PNG for transparency, JPEG otherwise —
// and it is worth the scan: a photograph re-encoded as PNG is several times the
// size of the JPEG it came from, which is the opposite of what a thumbnail is for.
// The scan stops at the first transparent pixel.
func hasAlpha(source image.Image) bool {
	switch source.(type) {
	case *image.NRGBA, *image.NRGBA64, *image.RGBA, *image.RGBA64, *image.Alpha, *image.Paletted:
		// Opaque-capable: it has to be checked.
	default:
		return false
	}
	bounds := source.Bounds()
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			if _, _, _, alpha := source.At(x, y).RGBA(); alpha != 0xffff {
				return true
			}
		}
	}
	return false
}

// ImageCost is what one picture costs inside a request, in tokens.
//
// ## Why a picture cannot be counted as characters
//
// The text estimator turns characters into tokens, and a picture has no
// characters. A body of 1.5MB is roughly 400,000 tokens by that count — four times
// the whole window of the models this program talks to — while what the provider
// actually bills is closer to a thousand. Counting it as text would make the
// budget degrade every artifact in the session for a picture that fits, and
// counting it as zero (which is what `content.(string)` does to an array) would
// let the request go out over the window.
//
// ## The estimate
//
// The two published rules agree to within about a third on the sizes that matter,
// so this takes the **larger** of them, which is the safe direction: too high
// degrades a picture a little early, too low fails the request outright.
//
//	tiles:  ceil(w/512) * ceil(h/512) * 170 + 85      (host API, high detail)
//	area:   w * h / 750                               (Messages shape)
//
// A picture whose dimensions could not be measured falls back to its byte count,
// because a file that can only be sent whole still has to be paid for.
func ImageCost(image artifactImage) int {
	const (
		tilePixels  = 512
		tileTokens  = 170
		baseTokens  = 85
		areaDivisor = 750
	)
	if image.Width > 0 && image.Height > 0 {
		columns := (image.Width + tilePixels - 1) / tilePixels
		rows := (image.Height + tilePixels - 1) / tilePixels
		tiles := columns*rows*tileTokens + baseTokens
		area := (image.Width*image.Height + areaDivisor - 1) / areaDivisor
		if area > tiles {
			return area
		}
		return tiles
	}
	if image.Bytes > 0 {
		// A base64 body is four thirds of the file, and a token is about four
		// characters of it.
		return image.Bytes/3 + baseTokens
	}
	return baseTokens
}

// artifactImage is the minimal fact set the cost function needs.
//
// It is a small struct rather than the Artifact because the same function is used
// for the original and for the thumbnail, and passing whole artifacts around would
// invite a caller to reach for a field that is not the one it meant.
type artifactImage struct {
	Width  int
	Height int
	Bytes  int
}

// ImageRefCost is the cost of one picture as the context knows it.
//
// It exists so the budget can price what the renderer produced without knowing
// what an artifact is: the renderer hands over a `content.ImageRef`, and this is
// the one conversion.
func ImageRefCost(image content.ImageRef) int {
	return ImageCost(artifactImage{Width: image.Width, Height: image.Height, Bytes: image.Bytes})
}

// imageOf builds the cost input from an artifact.
func imageOf(artifact Artifact) artifactImage {
	width, height := artifactDimensions(artifact)
	bytes := artifact.Bytes
	if bytes == 0 {
		bytes = artifact.Chars
	}
	return artifactImage{Width: width, Height: height, Bytes: bytes}
}

// artifactDimensions reads a picture's size out of its metadata. Zero means
// unknown, never "no size".
func artifactDimensions(artifact Artifact) (int, int) {
	width := artifact.MetadataInt(MetaWidth)
	height := artifact.MetadataInt(MetaHeight)
	if width < 0 {
		width = 0
	}
	if height < 0 {
		height = 0
	}
	return width, height
}

// imageReference turns an artifact into the fact set context needs.
//
// `variant` is decided by the caller, because it is the caller that knows whether
// it is pointing at the original or at the smaller copy.
func imageReference(artifact Artifact, variant content.Variant) content.ImageRef {
	width, height := artifactDimensions(artifact)
	mime := artifact.MetadataString(MetaMIME)
	if variant == content.VariantThumbnail {
		if thumbnailMIME := artifact.MetadataString(MetaThumbnailMIME); thumbnailMIME != "" {
			mime = thumbnailMIME
		}
	}
	return content.ImageRef{
		ArtifactID: artifact.ID,
		Name:       artifact.MetadataString(MetaName),
		MIME:       mime,
		Bytes:      artifact.Bytes,
		Width:      width,
		Height:     height,
		Variant:    variant,
	}
}

// ImageRefFor turns an artifact into the fact set the context layer works with.
//
// It is exported for the runtime, which has to put a picture **into** a message
// when it attaches one — the same conversion the renderer makes when it reads one
// back out.
func ImageRefFor(artifact Artifact, variant content.Variant) content.ImageRef {
	return imageReference(artifact, variant)
}

// ImageLabelFor is how one artifact is named in text: used by the metadata level,
// by the non-vision refusal, and by the transcript a person reads.
func ImageLabelFor(artifact Artifact) string {
	return content.ImageLabel(imageReference(artifact, content.VariantOriginal))
}

// sizeText renders a byte count the way a person reads it.
func sizeText(bytes int) string {
	switch {
	case bytes <= 0:
		return ""
	case bytes >= 1024*1024:
		return strconv.FormatFloat(float64(bytes)/(1024*1024), 'f', 1, 64) + "MB"
	case bytes >= 1024:
		return strconv.Itoa(bytes/1024) + "KB"
	default:
		return strconv.Itoa(bytes) + "B"
	}
}

// AttachImage stores a picture's bytes and returns its artifact.
//
// This is the door a file comes through: bytes in, a reference out. Everything
// that decides *whether* a file may be read has already happened by this point
// (the workspace resolved the path and refused anything outside it, and the caller
// checked the size) — this function is about turning bytes into an artifact, and
// nothing else, so it cannot become a second place where the boundary is enforced.
//
// ## What it does, in order
//
//  1. **refuses anything over MaxImageBytes**, before reading it into memory;
//  2. **identifies the picture from its bytes** (`http.DetectContentType`), never
//     from the file name;
//  3. **measures it**, refusing a decompression bomb rather than decoding one;
//  4. **stores the original bytes** — not base64;
//  5. **makes a thumbnail** when it is worth making, stored as an artifact of its
//     own and named in the original's metadata.
//
// ## Why the thumbnail is made eagerly
//
// It could be made lazily, on the first degradation step. Building it here costs
// one decode at attach time and buys two things: the degradation path stays pure
// (it picks an id, it does not encode an image while a request is being measured),
// and the cost of the picture is known before the first request goes out — which
// is the moment the budget has to decide whether it fits at all.
//
// A failed thumbnail is not an error. Only some pictures can be shrunk (one that
// is already small, one whose format this build cannot decode), and in both cases
// the honest outcome is a picture with a shorter ladder, not a picture that failed
// to attach.
func AttachImage(store *ArtifactStore, body []byte, source ArtifactSource) (Artifact, error) {
	if len(body) > MaxImageBytes {
		return Artifact{}, fmt.Errorf("the picture is %s, over the %s ceiling for one image",
			sizeText(len(body)), sizeText(MaxImageBytes))
	}
	info, err := inspectImage(body)
	if err != nil {
		return Artifact{}, err
	}

	metadata := map[string]any{
		"status": "ok",
		MetaMIME: info.MIME,
	}
	if info.Width > 0 && info.Height > 0 {
		metadata[MetaWidth] = info.Width
		metadata[MetaHeight] = info.Height
	}
	if name := imageName(source.Path); name != "" {
		metadata[MetaName] = name
	}

	artifact, err := store.CreateBytes(body, TypeImage, source, metadata)
	if err != nil {
		return Artifact{}, err
	}
	// The dedupe path can hand back an artifact that was attached a moment ago
	// (the same file named twice in one message). It already carries a thumbnail
	// when one was possible, so there is nothing to build again — and rebuilding
	// it would write the same bytes a second time under a second id.
	if artifact.MetadataString(MetaThumbnailID) != "" {
		return artifact, nil
	}

	small, ok := makeThumbnail(body, info)
	// A thumbnail that does not reduce what the request costs is a rung that moves
	// the level without shrinking the payload — invisible in the level and in the
	// token bill both. See worthStoring for why the test is the cost and not the
	// file size.
	if !ok || !small.worthStoring(info, len(body)) {
		return artifact, nil
	}
	thumbnailArtifact, err := store.CreateBytes(small.Body, TypeImage, ArtifactSource{
		Tool: source.Tool,
		Path: source.Path,
	}, map[string]any{
		"status":   "ok",
		"variant":  string(content.VariantThumbnail),
		MetaMIME:   small.MIME,
		MetaWidth:  small.Width,
		MetaHeight: small.Height,
		"origin":   artifact.ID,
	})
	if err != nil {
		// The original is stored and usable; only the cheaper rung is missing.
		return artifact, nil
	}

	// The link is written onto the **original**, and it is written after the
	// thumbnail exists: the other order leaves a manifest entry naming a body that
	// is not there yet, and the degradation path reads that link as "a smaller copy
	// exists".
	artifact.Metadata[MetaThumbnailID] = thumbnailArtifact.ID
	artifact.Metadata[MetaThumbnailMIME] = small.MIME
	if err := store.UpdateMetadata(artifact); err != nil {
		return artifact, nil
	}
	return artifact, nil
}

// imageName is the file's base name, for a person to recognise the picture by.
//
// It is stored as metadata rather than kept in the path because the path may not
// survive: an artifact is content-addressed, so the same bytes attached from two
// places are two references to one body, and the label the model is shown has to
// be a fact about the picture rather than about one of the ways it arrived.
func imageName(path string) string {
	if path == "" {
		return ""
	}
	trimmed := strings.TrimRight(path, `/\`)
	if trimmed == "" {
		return ""
	}
	if index := strings.LastIndexAny(trimmed, `/\`); index >= 0 {
		return trimmed[index+1:]
	}
	return trimmed
}
