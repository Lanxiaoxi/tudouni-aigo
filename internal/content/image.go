package content

import (
	"bytes"
	"fmt"
	"image"
	"net/http"
	"sort"
	"strings"

	// The decoders are registered for their side effect: `image.DecodeConfig` only
	// knows a format whose package has been linked in, and a missing registration
	// shows up as "unknown image format" on a file that is perfectly readable by
	// every other program on the machine.
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
)

// What a picture is, in the one place both sides can ask.
//
// **Two layers need this answer and neither may own it alone.** A tool that reads
// a picture has to refuse a non-picture, an oversized file and a decompression
// bomb *before* handing bytes on — that is the whole point of it validating. The
// artifact layer has to make the same three decisions again on the way in, because
// bytes can reach it from a place with no tool (a path in the user's message).
//
// A check declared in either one would leave the other free to disagree, and the
// symptom of two answers is a file that passes one door and is refused by the
// next — which reads as a bug in whichever door the person happened to look at.
// So the knowledge lives here, beside the part types, and both doors call it.
//
// What is deliberately **not** here: storing, thumbnailing, and anything that
// knows about artifacts. This package is vocabulary — what a thing is called and
// whether it is allowed — and it has no dependencies of its own.

// ImageMIMEs are the formats this program accepts, and the only names it will put
// on a wire as a media type.
//
// The list is the intersection of "the three protocols accept it" and "this build
// can measure it". WebP is deliberately absent: no stdlib decoder means no
// dimensions and no thumbnail, and accepting a format that can only ever be sent at
// full size and estimated from its byte count is a worse deal than saying so.
var ImageMIMEs = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/gif":  true,
}

// ImageMIMENames lists the accepted media types, sorted, for a message that has to
// name them. Sorted rather than in map order so the same sentence comes out the
// same way every time it is printed.
func ImageMIMENames() []string {
	names := make([]string, 0, len(ImageMIMEs))
	for name := range ImageMIMEs {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ImageInfo is what was learned by looking at a picture's bytes.
type ImageInfo struct {
	// MIME comes from the **bytes**, never from the file name. A `.png` that is
	// really a JPEG is common enough (a screenshot tool renaming its output, a file
	// downloaded twice), and a media type that disagrees with the data is refused
	// by the endpoint with a message about the media type rather than the file.
	MIME string
	// Width and Height are zero when the header could not be read. Zero means
	// **unknown**, never "no size" — a made-up dimension is a made-up token
	// estimate on top of it.
	Width  int
	Height int
}

// InspectImage identifies a byte stream as a picture, or refuses it.
//
// Dimensions are read with `DecodeConfig`, which parses headers only. That is
// deliberate: the full decode happens once, for a thumbnail, and only when a
// thumbnail is actually wanted.
//
// The errors are sentences for whoever is going to read them, and that differs by
// caller — a tool turns them into a line for the model, the artifact layer into a
// notice for the user. Both want the same facts, so the facts are stated and the
// caller wraps them.
func InspectImage(body []byte) (ImageInfo, error) {
	if len(body) == 0 {
		return ImageInfo{}, fmt.Errorf("the file is empty")
	}
	// `DetectContentType` answers `image/png`, `image/jpeg` and `image/gif`
	// exactly; a subtype it reports (`image/bmp`) is not one of the three this
	// program speaks, and neither is the `application/octet-stream` it gives for
	// anything it does not know.
	sniffed := http.DetectContentType(body)
	mime := strings.TrimSpace(strings.SplitN(sniffed, ";", 2)[0])
	if !ImageMIMEs[mime] {
		return ImageInfo{}, fmt.Errorf("its content is %s, which is not one of the picture formats this program handles (%s)",
			mime, strings.Join(ImageMIMENames(), ", "))
	}

	info := ImageInfo{MIME: mime}
	config, _, err := image.DecodeConfig(bytes.NewReader(body))
	if err != nil {
		// A header it cannot parse means the file is truncated or corrupt. Saying
		// so is better than sending it: the endpoint would refuse it anyway, and
		// the refusal that arrives from there names the media type.
		return info, fmt.Errorf("its %s header could not be read: %v", mime, err)
	}
	info.Width, info.Height = config.Width, config.Height
	if info.Width <= 0 || info.Height <= 0 {
		return info, fmt.Errorf("it claims a %dx%d size", info.Width, info.Height)
	}
	// A decompression-bomb guard, not a quality judgement: a 20000×20000 PNG is a
	// few hundred kilobytes on disk and 1.6GB in memory once decoded, and every
	// picture this program accepts is decoded in order to be measured. Refusing the
	// file costs a message; decoding it costs the process.
	if info.Width*info.Height > MaxImagePixels {
		return info, fmt.Errorf("it decodes to %dx%d, which is over the %d-pixel ceiling (a picture this large is a few hundred kilobytes on disk and gigabytes in memory)",
			info.Width, info.Height, MaxImagePixels)
	}
	return info, nil
}

// TooLargeForOneImage reports whether a body is over the per-picture ceiling, and
// says so in a sentence.
//
// It is separate from InspectImage because the check has to happen **before the
// bytes are read**: the ceiling exists to keep a large file out of memory, and
// holding it in memory to measure it defeats that. A caller that already has the
// bytes can still use this, but the caller that matters is the one holding a
// `Stat` result.
func TooLargeForOneImage(size int) error {
	if size <= MaxImageBytes {
		return nil
	}
	return fmt.Errorf("it is %s, over the %s ceiling for one picture",
		HumanSize(size), HumanSize(MaxImageBytes))
}

// HumanSize renders a byte count the way a person reads it.
//
// It is here rather than in a front end because the sentences that carry it are
// produced by this layer and by the artifact layer, and two renderings of one
// number is how "1.5MB" and "1536KB" end up describing the same file in two places
// a person is comparing.
func HumanSize(bytes int) string {
	switch {
	case bytes <= 0:
		return "0B"
	case bytes >= 1024*1024:
		return fmt.Sprintf("%.1fMB", float64(bytes)/(1024*1024))
	case bytes >= 1024:
		return fmt.Sprintf("%dKB", bytes/1024)
	default:
		return fmt.Sprintf("%dB", bytes)
	}
}
