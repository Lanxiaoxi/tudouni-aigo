package content

import (
	"path/filepath"
	"strings"
	"unicode"
)

// Finding pictures in what a person typed.
//
// This is the whole of the "attach a picture" interface: a user writes
//
//	帮我看看这个页面截图 /tmp/shot.png
//
// and the picture is attached. There is no separate upload command and no new
// syntax to learn, which is deliberate — a runtime that needs a special marker to
// notice a file the user already named is a runtime that shows the model a path
// and hopes for the best.
//
// What this file does **not** do is decide whether a file may be read. It answers
// "which words in this sentence could be the name of a picture"; the layer that
// owns the workspace resolves them (and refuses anything outside it), and the
// layer that owns the artifact store reads them. Keeping the three apart stops a
// scanner from becoming a second path-validation implementation — the class of bug
// where one door is guarded and the other is not.
//
// ## Why it returns candidates rather than one path
//
// The token in a sentence is wrapped in punctuation and, in this project's input,
// glued to the words in front of it: Chinese has no spaces, so `看这个/tmp/a.png`
// is one field. There is no rule that separates prose from a path in that string
// without also breaking a legitimately Chinese **directory** name
// (`截图/首页.png`), so the scanner does not choose. It offers the readings, in the
// order most likely to be right, and the resolver — which can ask the filesystem —
// takes the first that exists. A guess made here would be a guess made without the
// one piece of evidence that settles it.

// MaxImagesPerMessage caps how many pictures one message may attach.
//
// It is a cost ceiling, not a policy about pictures: every image is billed at
// roughly a thousand tokens and is base64-encoded into the request body, so a
// command like `ls *.png` pasted into the input — or a script that printed a
// hundred file names — would otherwise build a request that cannot be sent. Past
// the cap the **first** ones are attached and the rest are named in the payload
// note, so the model is told they exist rather than silently not seeing them.
//
// The number is the one a **person** can reach deliberately, which is why it is
// ten and not the four it used to be: a desktop front end that accepts a paste
// puts every screenshot the user made in one message, and a ceiling they hit
// while doing exactly what the feature invites is a ceiling that reads as a bug.
// The reason the cap exists has not changed — the hundred-file glob is still
// refused at ten — so what moved is only where the line sits between "one
// person's message" and "a script's output".
const MaxImagesPerMessage = 10

// imageExtensions is the set a path is recognised by.
//
// It is the same three formats `internal/context` can measure and that all three
// wire protocols accept. A fourth entry that could not be measured would be a
// path that gets attached and then refused, which is worse than not looking like
// a path at all.
//
// The test is the extension rather than the file's content because the scan sees a
// sentence: opening every word to see what it is means forty `os.Stat` calls per
// message and reads files the user never meant to attach. The expensive question —
// "is it really a PNG" — is asked once, after the file has been read.
var imageExtensions = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true,
}

// IsImagePath reports whether a path's extension names a picture this program
// handles.
func IsImagePath(path string) bool {
	return imageExtensions[strings.ToLower(filepath.Ext(strings.TrimSpace(path)))]
}

// isTokenSeparator is what splits a body into candidate tokens: whitespace, and
// every control character.
//
// Whitespace alone is `strings.Fields`, and it is not enough — see FindImagePaths
// for what a NUL inside a sentence does to the extension test. A control character
// is never part of a file name a person meant to type, so treating one as a
// separator cannot split a real path in two; the only thing it can do is separate
// prose from the path that follows it, which is exactly what went wrong.
func isTokenSeparator(character rune) bool {
	return unicode.IsSpace(character) || unicode.IsControl(character)
}

// FindImagePaths returns the path-looking candidates of a body, grouped by the
// token they came from and ordered most-likely-first within each group.
//
// The grouping is the whole point. One token can be read several ways and only the
// filesystem can say which reading is real, so the caller — which is allowed to
// stat things — tries the readings in order and takes the first that exists. A
// scanner that chose here would be choosing without the one piece of evidence that
// settles it, and the two ways to be wrong are not symmetric: a path that is
// missed is a sentence the model still reads, while a path that is invented sends
// the resolver looking for a file nobody named.
//
// It does not check that anything exists, and it does not resolve anything.
//
// ## Control characters separate tokens
//
// The split is on control characters as well as whitespace, and that is a real
// input this program receives rather than a defensive flourish: a NUL from the
// Windows key path reached a real session's history (see `tui.insertText` for how it
// gets there, and for what the front end now does about it), so a message arrives as
// `看这张图\x00docs/a.png` — one field to `strings.Fields`, because a NUL is not
// whitespace.
//
// The consequence is not cosmetic. `filepath.Ext` runs to the end of the string, so
// a token carrying `\x00` and more prose after it reports an extension of
// `.png这张是首页` and **the picture is silently not attached** — the one outcome
// this whole layer exists to avoid, since the model then answers about the words
// with nothing on screen to say a picture was meant to be there.
//
// Splitting on them fixes that wherever the text came from: a session file written
// before the front end stopped emitting them, the line REPL reading a pasted
// control byte, or any front end added later. The front end still drops them (that
// is the cure); this is what makes the reader robust to the cases the cure cannot
// reach.
func FindImagePaths(text string) [][]string {
	if text == "" || !strings.Contains(text, ".") {
		return nil
	}
	var found [][]string
	seen := map[string]bool{}
	count := 0
	for _, token := range strings.FieldsFunc(text, isTokenSeparator) {
		candidates := pathCandidates(token)
		if len(candidates) == 0 {
			continue
		}
		// A token whose every reading was already seen is the same attachment
		// written twice (`shot.png and shot.png`), and attaching it twice would
		// bill the picture twice inside one request.
		fresh := make([]string, 0, len(candidates))
		for _, candidate := range candidates {
			if seen[candidate] {
				continue
			}
			fresh = append(fresh, candidate)
		}
		if len(fresh) == 0 {
			continue
		}
		for _, candidate := range fresh {
			seen[candidate] = true
		}
		found = append(found, fresh)
		count++
		if count >= MaxImagesPerMessage*2 {
			// Generous rather than exact: a token whose first reading is prose
			// contributes nothing, so counting groups here and capping later is
			// what keeps the cap about **attachments** rather than about mentions.
			break
		}
	}
	return found
}

// pathCandidates lists the ways one token could be read as a picture's path,
// most likely first. No candidates means "this token is not a path at all".
//
// The readings, and why each one is needed:
//
//  1. **the token with its wrapping punctuation removed** — `/tmp/a.png`,
//     “ `/tmp/a.png` “, `(/tmp/a.png)`, `看这个 /tmp/a.png`. This is the common
//     case and it is tried first;
//  2. **from the first separator on** — the reading for `看这个/tmp/a.png`, where a
//     Chinese sentence is glued to an absolute path. Chinese has no word
//     separator, so that whole thing is one field;
//  3. **the longest suffix that is entirely ASCII path characters** — the same
//     problem one step harder: `看这个shot.png` has no separator at all. The rule
//     is safe because a Han character is *allowed* in a file name, so this reading
//     is offered as a candidate rather than applied; a name like `截图/首页.png`
//     simply produces no ASCII-only suffix worth having and falls through to
//     reading 4;
//  4. **the last segment** — the reading for `截图/首页.png` written inside prose,
//     where the leading Chinese is part of the enclosing sentence.
//
// Nothing is decided here. The resolver tries these in order against the
// filesystem and takes the first that is really a file, which is the only piece of
// evidence that settles which reading was meant — see the file header.
func pathCandidates(token string) []string {
	trimmed := trimToken(token)
	if !looksLikePicture(trimmed) {
		return nil
	}
	candidates := []string{trimmed}

	if index := strings.IndexAny(trimmed, `/\`); index > 0 {
		candidates = append(candidates, trimmed[index:])
	}
	if suffix := asciiSuffix(trimmed); suffix != "" && suffix != trimmed {
		candidates = append(candidates, suffix)
	}
	if index := strings.LastIndexAny(trimmed, `/\`); index >= 0 && index+1 < len(trimmed) {
		candidates = append(candidates, trimmed[index+1:])
	}
	return dedupe(candidates)
}

// looksLikePicture is the gate every candidate passes: the right extension **and**
// a name in front of it.
//
// The name matters. `the .png format is lossless` is a sentence about a file
// extension, and a scanner that reported `.png` would send the resolver looking for
// a file literally called `.png` in the workspace — a hidden file, on Unix, that
// somebody could plausibly have. Requiring a basename is what makes prose about an
// extension stay prose.
func looksLikePicture(value string) bool {
	if !IsImagePath(value) {
		return false
	}
	name := strings.TrimSuffix(value, filepath.Ext(value))
	if name == "" || name == "." || name == ".." {
		return false
	}
	return true
}

// asciiSuffix is the longest tail of a token made only of characters a path can be
// built from, or "" when there is none.
//
// It is the reading for a picture glued to a Chinese word with no separator. Han
// characters are deliberately **not** in the allowed set here and are deliberately
// allowed in file names elsewhere: this function's job is only to offer a short
// ASCII tail as a *guess*, and a Chinese directory name is preserved by reading 4
// instead. Rejecting a guess costs nothing — the next reading still gets its turn.
func asciiSuffix(value string) string {
	start := len(value)
	for index := len(value) - 1; index >= 0; index-- {
		if !isPathByte(value[index]) {
			break
		}
		start = index
	}
	if start >= len(value) {
		return ""
	}
	suffix := value[start:]
	if !looksLikePicture(suffix) {
		return ""
	}
	return suffix
}

func isPathByte(character byte) bool {
	switch {
	case character >= 'a' && character <= 'z', character >= 'A' && character <= 'Z':
		return true
	case character >= '0' && character <= '9':
		return true
	case character == '/' || character == '\\' || character == '.' || character == '_' ||
		character == '-' || character == '~':
		return true
	default:
		return false
	}
}

func dedupe(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

// trimToken strips the punctuation a path is routinely wrapped in.
//
// A file name in a sentence arrives as `(/tmp/a.png)`, “ `/tmp/a.png` “,
// `"/tmp/a.png",` or `看/tmp/a.png。` — the trailing comma belongs to the sentence,
// not to the name, and a path that keeps it does not exist.
func trimToken(token string) string {
	trimmed := strings.TrimSpace(token)
	// Paired brackets first, then quotes, then trailing sentence punctuation, and
	// then brackets again: `("/tmp/a.png"),` needs both rounds, and each round only
	// removes what is genuinely outside the name.
	for round := 0; round < 2; round++ {
		trimmed = strings.Trim(trimmed, "\"'`")
		trimmed = strings.Trim(trimmed, "()[]{}<>（）【】《》「」")
		trimmed = strings.TrimRight(trimmed, ".,;:!?，。、；：！？…")
	}
	// An attachment marker, if somebody writes one anyway: `@/tmp/a.png` names the
	// same file, and the `@` is not part of it.
	trimmed = strings.TrimPrefix(trimmed, "@")
	return strings.TrimSpace(trimmed)
}

// firstPathishIndex is where a path can begin inside a token: the first character
// that is neither whitespace nor a bracket/quote/bullet.
//
// Note what is **not** trimmed: a Han character, because a file name may be
// Chinese; and an ASCII letter or digit, because `docs/a.png` starts with a word.
// What is dropped is the class that appears in prose and never at the start of a
// path — an opening bracket, a quotation mark, a list bullet, a hash.
func firstPathishIndex(token string) int {
	for index, character := range token {
		if character == '/' || character == '\\' {
			return index
		}
		switch character {
		case ' ', '\t', '(', ')', '[', ']', '{', '}', '<', '>', '（', '）', '【', '】',
			'《', '》', '「', '」', '"', '\'', '`', '*', '-', '#', '·', '、', '。', '，', ':', '：':
			continue
		}
		return index
	}
	return 0
}
