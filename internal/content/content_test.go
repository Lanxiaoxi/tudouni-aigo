package content

import (
	"encoding/json"
	"strings"
	"testing"
)

// The body model, and the one property that keeps it from costing money.
//
// The rule worth a test of its own: **a body that is only text has to render as a
// plain string**, byte for byte. Every request in a session is priced on the longest
// common prefix with the previous one, so a body that gained an array wrapper
// invalidates the provider's cache for every token after the first changed byte —
// measured at roughly fifty times the cost of a hit.

func TestATextOnlyBodyRendersAsAPlainString(t *testing.T) {
	body := Text("hello")
	wire := body.ToWire()
	text, ok := wire.(string)
	if !ok {
		t.Fatalf("ToWire returned %T, want a plain string", wire)
	}
	if text != "hello" {
		t.Fatalf("wire = %q", text)
	}
}

func TestABodyWithAPictureRendersAsParts(t *testing.T) {
	body := Content{}.WithText("[Image: a.png 2×1]").WithImage(ImageRef{
		ArtifactID: "art_x", MIME: "image/png", Bytes: 64, Width: 2, Height: 1,
		Name: "a.png",
	})
	parts, ok := body.ToWire().([]any)
	if !ok {
		t.Fatalf("ToWire returned %T, want a parts array", body.ToWire())
	}
	if len(parts) != 2 {
		t.Fatalf("parts = %d, want 2", len(parts))
	}
	block, _ := parts[1].(map[string]any)
	if block["type"] != "image" || block["artifact_id"] != "art_x" {
		t.Errorf("the picture part = %#v", block)
	}
	// The bytes are **never** in the session file: base64 would be carried by every
	// later turn of the session, which is the bloat this design exists to avoid.
	if _, present := block["data"]; present {
		t.Error("the picture part carries bytes; the id is the only thing that belongs here")
	}
}

// TestParseAcceptsBothShapes: a session file outlives the program that wrote it, so
// the string form has to keep parsing. Every message written before pictures existed
// is a string.
func TestParseAcceptsBothShapes(t *testing.T) {
	if got := Parse("just text").TextOf(); got != "just text" {
		t.Errorf("a string body parsed as %q", got)
	}
	parts := []any{
		map[string]any{"type": "text", "text": "look"},
		map[string]any{"type": "image", "artifact_id": "art_1", "mime": "image/png"},
	}
	body := Parse(parts)
	if !body.HasImage() {
		t.Error("the picture part was not recognised")
	}
	if body.TextOf() != "look" {
		t.Errorf("the text of the body = %q", body.TextOf())
	}
	if images := body.Images(); len(images) != 1 || images[0].ArtifactID != "art_1" {
		t.Fatalf("images = %#v", images)
	}
}

// TestParseNeverFails: this runs on the path of every request, so a malformed block
// must not make a session unopenable — it is skipped, and the rest of the body still
// arrives.
func TestParseNeverFails(t *testing.T) {
	parts := []any{
		"a bare string in the array",
		map[string]any{"type": "image"}, // no artifact id
		map[string]any{"type": "audio", "text": "ignored type, has text"},
		map[string]any{"type": "text", "text": "kept"},
		42,
	}
	text := Parse(parts).TextOf()
	if !strings.Contains(text, "kept") {
		t.Fatalf("the readable part was lost: %q", text)
	}
	if Parse(nil).HasImage() {
		t.Error("an empty body reported a picture")
	}
	if !Parse(nil).IsEmpty() {
		t.Error("nil is not empty")
	}
}

// TestATextOnlyBodySurvivesTheSessionFile: the parts form has to round-trip through
// JSON, because that is how it is restored.
func TestTheBodyRoundTripsThroughJSON(t *testing.T) {
	original := Content{}.
		WithText("what is wrong here?").
		WithImage(ImageRef{ArtifactID: "art_p", MIME: "image/png", Name: "s.png", Width: 8, Height: 6, Bytes: 100})

	encoded, err := json.Marshal(map[string]any{"content": original.ToParts()})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	restored := Parse(decoded["content"])
	if restored.TextOf() != "what is wrong here?" {
		t.Errorf("text = %q", restored.TextOf())
	}
	images := restored.Images()
	if len(images) != 1 {
		t.Fatalf("images = %#v", images)
	}
	if images[0].ArtifactID != "art_p" || images[0].Width != 8 || images[0].Height != 6 {
		t.Errorf("the picture lost its facts: %#v", images[0])
	}
}

// TestDescribeNamesThePicture: the places that show a body to somebody who cannot
// see pictures (a session preview, the compaction skeleton) must not silently lose
// one — a body that quietly drops its image reads as a message that never had one.
func TestDescribeNamesThePicture(t *testing.T) {
	body := Content{}.
		WithText("看一下").
		WithImage(ImageRef{ArtifactID: "art_1", MIME: "image/png", Name: "shot.png", Width: 1280, Height: 720})

	described := Describe(body.ToParts())
	if !strings.Contains(described, "看一下") {
		t.Errorf("the text was dropped: %q", described)
	}
	if !strings.Contains(described, "shot.png") {
		t.Errorf("the picture was not named: %q", described)
	}
	if !strings.Contains(described, "1280×720") {
		t.Errorf("the dimensions were not stated: %q", described)
	}
}

// TestImageLabelFallsBackSensibly: a picture with no name still has to be nameable,
// or the refusal and the metadata line both read as "there was a thing".
func TestImageLabelFallsBackSensibly(t *testing.T) {
	if got := ImageLabel(ImageRef{ArtifactID: "a", MIME: "image/png"}); !strings.Contains(got, "image/png") {
		t.Errorf("label = %q, want the media type", got)
	}
	if got := ImageLabel(ImageRef{ArtifactID: "a"}); got != "[Image: image]" {
		t.Errorf("label = %q", got)
	}
	if got := ImageLabel(ImageRef{ArtifactID: "a", Bytes: 2 * 1024 * 1024}); !strings.Contains(got, "2.0MB") {
		t.Errorf("label = %q, want the size when no dimensions are known", got)
	}
}

// --- the scanner -----------------------------------------------------------

// TestTheScannerReadsASentenceTheWayPeopleWriteIt is the whole user interface of
// this feature, so it is tested against the shapes people actually type rather than
// against tidy file names.
func TestTheScannerReadsASentenceTheWayPeopleWriteIt(t *testing.T) {
	cases := []struct {
		name string
		text string
		want string
	}{
		{"bare path", "看看 /tmp/shot.png", "/tmp/shot.png"},
		{"relative path", "look at docs/img/a.png please", "docs/img/a.png"},
		{"wrapped in parentheses", "这个呢 (/tmp/a.png)", "/tmp/a.png"},
		{"trailing comma", "见 /tmp/a.png, 和刚才那个", "/tmp/a.png"},
		{"quoted", `读 "/tmp/a.png"`, "/tmp/a.png"},
		{"chinese full stop", "这是 /tmp/a.png。", "/tmp/a.png"},
		{"attachment marker", "@/tmp/a.png", "/tmp/a.png"},
		// Chinese has no spaces, so the path is glued to the words in front of it.
		// This is the case the feature is unusable without, and it is why the
		// scanner offers several readings instead of choosing one.
		{"glued to chinese", "看这个/tmp/a.png", "/tmp/a.png"},
		{"jpeg", "photo.JPG", "photo.JPG"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			groups := FindImagePaths(testCase.text)
			if len(groups) == 0 {
				t.Fatalf("nothing was found in %q", testCase.text)
			}
			// The wanted reading has to be **among** the candidates for that token:
			// only the filesystem can settle which reading is the file, so the
			// scanner's job is to offer it, not to pick it.
			found := false
			for _, candidates := range groups {
				for _, candidate := range candidates {
					if candidate == testCase.want {
						found = true
					}
				}
			}
			if !found {
				t.Fatalf("candidates %#v do not include %q", groups, testCase.want)
			}
		})
	}
}

// TestAControlCharacterSeparatesThePathFromTheProse is the regression for a NUL
// that reached a real session.
//
// A key the IME is processing arrives at the front end as a NUL on Windows (see
// `tui.insertText` for the mechanism), so a message arrives as
// `这个图片里面是什么\x00docs/a.png`. A NUL is not whitespace, so `strings.Fields`
// returns **one** token — and `filepath.Ext` runs to the end of the string, so that
// token's extension is `.png这张是首页` and the picture is not recognised at all.
//
// The failure is the one this whole layer exists to avoid: the model answers about
// the words and nothing on screen says a picture was meant to be there. So the
// split has to treat a control character as a separator, wherever the text came
// from — a session file written before the front end stopped emitting them, the
// line REPL reading a pasted control byte, or a front end added later.
func TestAControlCharacterSeparatesThePathFromTheProse(t *testing.T) {
	cases := []struct {
		name string
		text string
		want int
	}{
		// The exact shape a real session carried, and the one that used to work only
		// by luck: it has a backslash, so reading 2 happened to recover the path.
		{"NUL between the words and the path", "这个图片里面是什么\x00docs\\design\\vision-test.png", 1},
		// These two are what the NUL actually broke. Neither has a separator in front
		// of the path, so no later reading could rescue them.
		{"path, then NUL, then more prose", "看 docs/a.png\x00这张是首页", 1},
		{"NUL, path, NUL, prose, another path", "看\x00docs/a.png\x00再来一张 b.png", 2},
		{"a bare name after a NUL", "看看\x00shot.png", 1},
		{"an absolute path after a NUL", "看看\x00/tmp/shot.png", 1},
		{"NULs on both sides of one path", "看\x00docs/a.png\x00", 1},
		// And the separators that were already working must keep working.
		{"a plain space", "看 docs/a.png 这张", 1},
		{"a tab", "看\tdocs/a.png", 1},
		{"a newline", "看 docs/a.png\n下一段", 1},
		// Nothing to find is still nothing to find: a control character in the middle
		// of prose must not invent a token that looks like a path.
		{"a NUL inside prose only", "前半\x00后半", 0},
		{"an ordinary sentence", "就是一句普通的话", 0},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			groups := FindImagePaths(testCase.text)
			if len(groups) != testCase.want {
				t.Fatalf("FindImagePaths(%q) = %#v, want %d group(s)",
					testCase.text, groups, testCase.want)
			}
		})
	}
}

// TestTheScannerIgnoresProseThatMentionsAnExtension.
//
// A sentence explaining the PNG format must not become an attachment attempt. The
// scanner cannot prove a token is a path, so what it must not do is treat ordinary
// words as one — every token it reports becomes a filesystem lookup.
func TestTheScannerIgnoresProseThatMentionsAnExtension(t *testing.T) {
	for _, text := range []string{
		"no extensions here at all",
		"the .png format is lossless",
		"",
	} {
		if groups := FindImagePaths(text); len(groups) != 0 {
			t.Errorf("FindImagePaths(%q) = %#v, want nothing", text, groups)
		}
	}
}

// TestTheScannerDeduplicates: the same file named twice in one message is one
// attachment. Two would bill the picture twice inside the same request.
func TestTheScannerDeduplicates(t *testing.T) {
	groups := FindImagePaths("compare /tmp/a.png with /tmp/a.png")
	total := 0
	for _, candidates := range groups {
		total += len(candidates)
	}
	// One group, whose candidates are the readings of that one token.
	if len(groups) != 1 {
		t.Fatalf("groups = %#v, want one token's readings", groups)
	}
	if total == 0 {
		t.Fatal("the path was not found")
	}
}

// TestImagePathIsDecidedByTheExtension pins the formats, and pins that the test is
// case-insensitive: `PHOTO.PNG` is a picture on every platform this ships on.
func TestImagePathIsDecidedByTheExtension(t *testing.T) {
	for _, path := range []string{"a.png", "a.PNG", "b.jpg", "c.jpeg", "d.gif", "/x/y/z.PnG"} {
		if !IsImagePath(path) {
			t.Errorf("%q was not recognised", path)
		}
	}
	for _, path := range []string{"a.go", "b.txt", "c.webp", "d", "e.pngx"} {
		if IsImagePath(path) {
			t.Errorf("%q was recognised", path)
		}
	}
}
