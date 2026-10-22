package state

import (
	"sort"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/config"
)

// The image-generation route.
//
// It is read out of the top-level `image_generation` section and it is
// **not** part of the model catalogue: `providers[].models[]` is a list of
// models that may be *chosen as the conversation model*, and every field in it
// (`context_window`, `reasoning_effort`, `vision`) is meaningless for a
// picture model. Putting `gpt-image-1` there would make it show up in
// `/model`, let it be picked, and then fail every chat request.
//
// ## The shape
//
//	"image_generation": {
//	  "provider": "openai",
//	  "model": "gpt-image-1"
//	}
//
// Two lines is the minimum, and `provider` is the reason the section exists at
// all: it says **inherit the key from that chat route**, so one key is written
// once. A section that had to repeat the key would have two copies of it, and
// the second one would be the stale one.

// imageGenKeys is everything one `image_generation` object may contain.
//
// A key beginning with `$` is a comment, and the same rule the rest of the
// configuration reader applies. An unknown key is an error rather than a
// shrug: a misspelled key that silently does nothing is the worst kind of
// failure there is.
var imageGenKeys = []string{"provider", "model", "api_style", "base_url", "api_key", "headers"}

// ImageGenStyles are the accepted `api_style` values.
//
// There is one in this build. The list exists so the error message can name
// it, and so the next dialect has a place to be added without changing the
// shape of the section.
var ImageGenStyles = []string{"openai-images"}

// ImageRoute is the configured image-generation route.
type ImageRoute struct {
	// Provider is the chat route the key and endpoint are inherited from.
	// Empty means the section carried everything itself.
	Provider string
	// Model is the image model. It is never inherited: the chat route's model
	// is a different model.
	Model string
	// APIStyle is which wire protocol the endpoint speaks. Empty means the
	// default, which is the only dialect this build speaks.
	APIStyle string
	// BaseURL is where requests go. Empty means "the inherited route's".
	BaseURL string
	// APIKey is the credential. Empty means "the inherited route's".
	APIKey string
	// Headers are extra request headers. Empty means "the inherited route's";
	// a non-empty one **replaces** it rather than adding to it, because two
	// answers to "which headers go on this request" would have to be reconciled
	// somewhere, and the section's own value is the more specific one.
	Headers map[string]string
}

// Configured reports whether the section says anything at all.
//
// An absent section is not an error and not a warning: image generation was
// never promised, so a machine without it is simply a machine without it.
func (r ImageRoute) Configured() bool {
	return r.Model != ""
}

// ImageGenError means the `image_generation` section cannot be used.
//
// It is a different class from "this route cannot be used": this one is "this
// section cannot be read" (an unknown key, a wrong type, a `provider` that
// names nothing) and it stops immediately, because guessing further has no
// meaning.
type ImageGenError struct{ Msg string }

func (e *ImageGenError) Error() string { return e.Msg }

func imageGenErrorf(format string, args ...any) *ImageGenError {
	return &ImageGenError{Msg: sprintf(format, args...)}
}

// LoadImageRoute reads the `image_generation` section.
//
// It always returns a route; a missing section yields the zero value, and the
// caller reports "image generation is not configured" in a sentence the user
// can act on.
//
// The `provider` inheritance is resolved here, because this is the only place
// that knows what a chat route carries. A `provider` that names a route which
// does not exist is an error **that lists the routes that do** — the alternative
// is a message naming something the reader cannot look up.
func LoadImageRoute(path string) (ImageRoute, error) {
	cfg, err := config.Read(path)
	if err != nil {
		return ImageRoute{}, err
	}
	// The catalogue is read here rather than passed in, because this function is
	// the standalone entry point: the caller that has a catalogue already uses
	// `ParseImageRoute`. The catalogue's own problems are **not** this
	// function's to report — a broken chat route is the catalogue's business,
	// and the runtime reports it in its own notice.
	catalog, _ := Load(path)
	return ParseImageRoute(cfg, catalog)
}

// ParseImageRoute reads the section out of an already-loaded configuration.
//
// The catalogue is a parameter rather than something this reads for itself
// because the caller has one: the catalogue is loaded once at start-up, and
// reading the configuration file twice would be a second chance to read a
// different file than the one that was validated.
func ParseImageRoute(cfg config.UserConfig, catalog Registry) (ImageRoute, error) {
	if len(cfg.ImageGeneration) == 0 {
		return ImageRoute{}, nil
	}
	where := i18nText("catalog.where.imagegen", "file", baseName(cfg.Path))

	object := cfg.ImageGeneration
	if unknown := unknownKeys(object, imageGenKeys); len(unknown) > 0 {
		return ImageRoute{}, imageGenErrorf("%s", i18nText("catalog.error.unknown_keys",
			"spot", where, "names", strings.Join(unknown, ", "), "known", strings.Join(sortedCopy(imageGenKeys), ", ")))
	}

	route := ImageRoute{}
	provider, err := imageGenText(object, "provider", where)
	if err != nil {
		return ImageRoute{}, err
	}
	route.Provider = provider

	model, err := imageGenText(object, "model", where)
	if err != nil {
		return ImageRoute{}, err
	}
	route.Model = model

	style, err := imageGenText(object, "api_style", where)
	if err != nil {
		return ImageRoute{}, err
	}
	if style != "" {
		normalized := strings.ToLower(style)
		known := false
		for _, candidate := range ImageGenStyles {
			if normalized == candidate {
				known = true
				break
			}
		}
		if !known {
			return ImageRoute{}, imageGenErrorf("%s", i18nText("catalog.error.bad_image_style",
				"where", where, "style", repr(style), "styles", strings.Join(ImageGenStyles, ", ")))
		}
		route.APIStyle = normalized
	}

	baseURL, err := imageGenText(object, "base_url", where)
	if err != nil {
		return ImageRoute{}, err
	}
	route.BaseURL = baseURL

	apiKey, err := imageGenText(object, "api_key", where)
	if err != nil {
		return ImageRoute{}, err
	}
	route.APIKey = apiKey

	headers, err := imageGenHeaders(object, where)
	if err != nil {
		return ImageRoute{}, err
	}
	route.Headers = headers

	// The model is **required** and is never inherited. The chat route's model
	// is a different model: sending a picture request to a chat model produces
	// a 404 or, worse, a chat completion where a picture was expected.
	if route.Model == "" {
		return ImageRoute{}, imageGenErrorf("%s", i18nText("catalog.error.imagegen_no_model", "where", where))
	}

	if route.Provider == "" {
		// Nothing to inherit from, and the section has to carry everything
		// itself. A missing endpoint is a configuration problem, and the message
		// says which key is missing rather than "the route is broken".
		if route.BaseURL == "" {
			return ImageRoute{}, imageGenErrorf("%s", i18nText("catalog.error.imagegen_no_base_url", "where", where))
		}
		return route, nil
	}

	// The inheritance. A `provider` that names a route which does not exist is
	// an error that **lists the routes that do** — "no such route" without the
	// list sends the reader hunting through the file for a name that is not
	// there.
	inherited, found := catalog.ProviderByName(route.Provider)
	if !found {
		return ImageRoute{}, imageGenErrorf("%s", i18nText("catalog.error.imagegen_no_provider",
			"where", where, "provider", repr(route.Provider), "routes", strings.Join(catalogRouteNames(catalog), ", ")))
	}
	if route.BaseURL == "" {
		route.BaseURL = inherited.BaseURL
	}
	if route.APIKey == "" {
		route.APIKey = inherited.APIKey
	}
	if len(route.Headers) == 0 {
		route.Headers = inherited.Headers
	}
	if route.BaseURL == "" {
		return ImageRoute{}, imageGenErrorf("%s", i18nText("catalog.error.imagegen_no_base_url", "where", where))
	}
	return route, nil
}

// catalogRouteNames lists the route names in the catalogue, for an error
// message that has to say what *is* available.
func catalogRouteNames(catalog Registry) []string {
	out := make([]string, 0, len(catalog.Providers))
	for _, provider := range catalog.Providers {
		out = append(out, provider.Name)
	}
	sort.Strings(out)
	if len(out) == 0 {
		return []string{"(none configured)"}
	}
	return out
}

// imageGenText reads one string field.
func imageGenText(raw map[string]any, key, where string) (string, error) {
	value, present := raw[key]
	if !present || value == nil {
		return "", nil
	}
	text, ok := value.(string)
	if !ok {
		return "", imageGenErrorf("%s", i18nText("catalog.error.not_string",
			"where", where, "key", key, "kind", goKindName(value)))
	}
	return strings.TrimSpace(text), nil
}

// imageGenHeaders reads the `headers` object.
//
// Both halves are checked to be strings, for the same reason the catalogue's
// own header reader checks them: a number would be a plausible typo for a
// version header (`"x-api-version": 2`), and refusing it at read time answers
// the question once.
func imageGenHeaders(raw map[string]any, where string) (map[string]string, error) {
	value, present := raw["headers"]
	if !present || value == nil {
		return nil, nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, imageGenErrorf("%s", i18nText("catalog.error.headers_not_object", "where", where))
	}
	out := make(map[string]string, len(object))
	for name, entry := range object {
		header := strings.TrimSpace(name)
		if header == "" {
			return nil, imageGenErrorf("%s", i18nText("catalog.error.header_empty_name", "where", where))
		}
		text, ok := entry.(string)
		if !ok {
			return nil, imageGenErrorf("%s", i18nText("catalog.error.header_not_string",
				"where", where, "name", header))
		}
		out[header] = text
	}
	return out, nil
}
