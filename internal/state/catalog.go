package state

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/config"
)

// CatalogError means the *shape* of the `providers` section is broken.
//
// It is a different class from "this route cannot be used": this one is "this
// section cannot be read at all" (an unknown key, a wrong type) and it stops
// immediately, because guessing further has no meaning. A route that merely
// lacks a key is a semantic problem: it is reported and the session still
// starts, because losing one choice should not keep a session from opening.
type CatalogError struct {
	Msg string
}

func (e *CatalogError) Error() string { return e.Msg }

func catalogErrorf(format string, args ...any) *CatalogError {
	return &CatalogError{Msg: sprintf(format, args...)}
}

// Allowed keys per level. An unknown key is an error rather than a shrug:
// misspelling a key so that it silently does nothing is the worst kind of
// failure there is.
//
// Note the absence of `api_key_env`. It asked for the *name* of an environment
// variable, i.e. it put the secret somewhere else and pointed at it — and there
// is only one place configuration comes from. Keeping it out of the set means
// anyone who writes it is told so at once, which is what a real incident taught:
// someone put the key itself in that field (the two names look almost alike,
// one holds a name and one holds a value) and all they got back was "no key".
var providerKeys = []string{"display_name", "base_url", "api_key", "models", "verify", "api_style", "headers"}

// The wire protocols a route may speak. The names are the values a person writes
// in `"api_style"`.
//
// They are deliberately spelled out rather than derived from the model package,
// which imports this one: a constant here that has to agree with a constant there
// would be a second description of the same fact. `model` accepts these three
// strings and refuses anything else, and this list is what the config error names.
const (
	StyleOpenAI    = "openai"
	StyleAnthropic = "anthropic"
	StyleResponses = "responses"
)

// styles are the accepted `api_style` values.
var styles = []string{StyleOpenAI, StyleAnthropic, StyleResponses}

var modelKeys = []string{"id", "label", "context_window", "summary", "note", "vision", "reasoning_effort"}

// ModelRef is one entry in the catalogue: a model and the route it lives on.
type ModelRef struct {
	Provider string
	ID       string
	// Window is the context window. Nil means "not known", and the interface
	// then reports usage without a percentage — a wrong percentage is worse
	// than none, because it gets believed.
	Window        *int
	Label         string
	Summary       string
	Note          string
	Vision        bool
	DefaultEffort string
}

// Title is the short name shown in lists.
func (m ModelRef) Title() string {
	if m.Label != "" {
		return m.Label
	}
	return m.ID
}

// Qualified is the `provider/model` form.
//
// Two routes can carry a model with the same name (a self-hosted gateway also
// offering `deepseek-flash`). The bare name then cannot say where the request
// goes, and those two answers differ in billing and in compliance.
func (m ModelRef) Qualified() string { return m.Provider + "/" + m.ID }

// AsRow renders one line of the model catalogue sent to the interface.
func (m ModelRef) AsRow(current bool) map[string]any {
	return map[string]any{
		"provider": m.Provider,
		"id":       m.ID,
		"label":    m.Title(),
		"window":   m.Window,
		"summary":  m.Summary,
		"note":     m.Note,
		"vision":   m.Vision,
		"current":  current,
	}
}

// Provider is one route: where requests go, which key they carry, what is on it.
type Provider struct {
	Name        string
	BaseURL     string
	APIKey      string
	Models      []ModelRef
	DisplayName string
	Verify      bool
	// APIStyle is which wire protocol this endpoint speaks: `openai`,
	// `anthropic` or `responses`. Empty means "work it out from base_url", and
	// the model package makes that decision — it is the only place that knows
	// what the three shapes look like.
	APIStyle string
	// Headers are extra request headers this route requires, verbatim. A vendor
	// that asks for a custom User-Agent or a session header has no other way to
	// be told, and the alternative was a code change per vendor.
	Headers map[string]string
}

// Title is the name shown to the user.
func (p Provider) Title() string {
	if p.DisplayName != "" {
		return p.DisplayName
	}
	return p.Name
}

// Usable reports whether this route has a key. A route without one stays in the
// catalogue but cannot be selected.
func (p Provider) Usable() bool { return p.APIKey != "" }

// Find looks up a model on this route. Names are compared literally.
func (p Provider) Find(id string) (ModelRef, bool) {
	wanted := strings.TrimSpace(id)
	for _, model := range p.Models {
		if model.ID == wanted {
			return model, true
		}
	}
	return ModelRef{}, false
}

// Registry is every model this machine knows about, plus its routes.
type Registry struct {
	Providers []Provider
	// Problems are "this route cannot be used" lines. They are kept separate
	// from Notes because mixing them buries the real problems among the
	// ordinary facts.
	Problems []string
	Notes    []string
	// Source is which file this catalogue came from. It is a fact, not
	// decoration: it is the answer to "why did my edit not take effect".
	Source string
}

// Provider looks up a route by name.
func (r Registry) ProviderByName(name string) (Provider, bool) {
	for _, provider := range r.Providers {
		if provider.Name == name {
			return provider, true
		}
	}
	return Provider{}, false
}

// Usable reports whether at least one route can be used. This — not "is there a
// key somewhere" — is the test for "is a model configured".
func (r Registry) Usable() bool {
	for _, provider := range r.Providers {
		if provider.Usable() {
			return true
		}
	}
	return false
}

// Models returns every model, in route order.
func (r Registry) Models() []ModelRef {
	var out []ModelRef
	for _, provider := range r.Providers {
		out = append(out, provider.Models...)
	}
	return out
}

// Find looks up a model by name.
//
// With a `provider` argument it only searches that route. Without one it
// searches everything — but when the name appears on more than one route it
// refuses rather than guessing. Picking one arbitrarily is the mistake that
// looks completely normal and bills another account.
func (r Registry) Find(name string, provider string) (ModelRef, bool) {
	wanted := strings.TrimSpace(name)
	if wanted == "" {
		return ModelRef{}, false
	}
	// Only interpret as "provider/model" if the first part is actually a known provider.
	// This avoids confusing model IDs that contain "/" (like "Qwen/Qwen3.8-27B-FP8")
	// with the provider/model syntax.
	if head, tail, found := strings.Cut(wanted, "/"); found {
		if _, ok := r.ProviderByName(strings.TrimSpace(head)); ok {
			return r.Find(tail, head)
		}
	}
	if provider != "" {
		if route, ok := r.ProviderByName(provider); ok {
			return route.Find(wanted)
		}
		return ModelRef{}, false
	}
	hits := r.Ambiguous(wanted)
	if len(hits) == 1 {
		return hits[0], true
	}
	return ModelRef{}, false
}

// Ambiguous returns every model carrying this name.
func (r Registry) Ambiguous(name string) []ModelRef {
	wanted := strings.TrimSpace(name)
	var out []ModelRef
	for _, model := range r.Models() {
		if model.ID == wanted {
			out = append(out, model)
		}
	}
	return out
}

// DefaultProvider is the first usable route.
//
// The order is the order in the file, so which route is the default is something
// a person arranged. Deriving it from a name instead would let adding a route
// quietly change the default with nothing printed.
func (r Registry) DefaultProvider() (Provider, bool) {
	for _, provider := range r.Providers {
		if provider.Usable() {
			return provider, true
		}
	}
	if len(r.Providers) > 0 {
		return r.Providers[0], true
	}
	return Provider{}, false
}

// DefaultModel is the first model on the default route.
func (r Registry) DefaultModel() (ModelRef, bool) {
	provider, ok := r.DefaultProvider()
	if !ok || len(provider.Models) == 0 {
		return ModelRef{}, false
	}
	return provider.Models[0], true
}

// Windows returns {model id: context window} for the models whose window is known.
func (r Registry) Windows() map[string]int {
	out := map[string]int{}
	for _, model := range r.Models() {
		if model.Window != nil {
			out[model.ID] = *model.Window
		}
	}
	return out
}

// Load reads the `providers` section of the configuration.
//
// It always returns a Registry; bad news goes into Problems. A missing file, or
// a file with no `providers`, means no routes at all — and the caller reports
// that in a sentence the user can act on. No fallback route is invented here: the
// old "works without configuration" route read an environment variable, and that
// arrangement is gone with the rest of them.
func Load(path string) (Registry, error) {
	cfg, err := config.Read(path)
	if err != nil {
		return Registry{}, err
	}

	var problems []string
	var providers []Provider
	source := cfg.Path

	for _, name := range providerNames(cfg) {
		item := cfg.Providers[name]
		where := i18nText("catalog.where.provider", "file", baseName(source), "name", name)

		object, ok := item.(map[string]any)
		if !ok {
			return Registry{}, catalogErrorf("%s", i18nText("catalog.error.not_object", "spot", where))
		}
		if unknown := unknownKeys(object, providerKeys); len(unknown) > 0 {
			return Registry{}, catalogErrorf("%s", i18nText("catalog.error.unknown_keys",
				"spot", where, "names", strings.Join(unknown, ", "), "known", strings.Join(sortedCopy(providerKeys), ", ")))
		}

		baseURL, err := textField(object, "base_url", where)
		if err != nil {
			return Registry{}, err
		}
		if baseURL == "" {
			return Registry{}, catalogErrorf("%s", i18nText("catalog.error.missing_base_url", "where", where))
		}

		models, err := modelsFrom(object["models"], name, where)
		if err != nil {
			return Registry{}, err
		}

		displayName, err := textField(object, "display_name", where)
		if err != nil {
			return Registry{}, err
		}
		verify, err := flagField(object, "verify", where, true)
		if err != nil {
			return Registry{}, err
		}
		key, err := textField(object, "api_key", where)
		if err != nil {
			return Registry{}, err
		}
		style, err := styleField(object, "api_style", where)
		if err != nil {
			return Registry{}, err
		}
		headers, err := headersField(object, "headers", where)
		if err != nil {
			return Registry{}, err
		}

		providers = append(providers, Provider{
			Name:        name,
			BaseURL:     baseURL,
			APIKey:      key,
			Models:      models,
			DisplayName: displayName,
			Verify:      verify,
			APIStyle:    style,
			Headers:     headers,
		})
		if len(models) == 0 {
			problems = append(problems, i18nText("catalog.problem.no_models", "route", name))
		}
		if key == "" {
			problems = append(problems, i18nText("catalog.problem.no_key", "route", name, "where", where))
		}
	}

	if len(providers) > 0 && !(Registry{Providers: providers}).Usable() {
		problems = append(problems, i18nText("catalog.problem.no_usable_route"))
	}

	registry := Registry{Providers: providers, Problems: problems, Source: source}
	if cfg.LegacyEnvPath != "" {
		registry.Notes = append(registry.Notes, i18nText("notice.config.legacy_env",
			"path", cfg.LegacyEnvPath, "config", source))
	}
	return registry, nil
}

// modelsFrom reads one route's `models` array.
//
// An empty array means "no choices", not "anything goes".
func modelsFrom(raw any, provider, where string) ([]ModelRef, error) {
	if raw == nil {
		return nil, nil
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, catalogErrorf("%s", i18nText("catalog.error.models_not_list", "where", where))
	}
	var out []ModelRef
	seen := map[string]bool{}
	for index, item := range items {
		spot := i18nText("catalog.where.model", "where", where, "index", index)
		object, ok := item.(map[string]any)
		if !ok {
			return nil, catalogErrorf("%s", i18nText("catalog.error.not_object", "spot", spot))
		}
		if unknown := unknownKeys(object, modelKeys); len(unknown) > 0 {
			return nil, catalogErrorf("%s", i18nText("catalog.error.unknown_keys",
				"spot", spot, "names", strings.Join(unknown, ", "), "known", strings.Join(sortedCopy(modelKeys), ", ")))
		}
		id, err := textField(object, "id", spot)
		if err != nil {
			return nil, err
		}
		if id == "" {
			return nil, catalogErrorf("%s", i18nText("catalog.error.missing_id", "spot", spot))
		}
		if seen[id] {
			return nil, catalogErrorf("%s", i18nText("catalog.error.duplicate_id", "spot", spot, "id", repr(id)))
		}
		seen[id] = true

		effort, err := textField(object, "reasoning_effort", spot)
		if err != nil {
			return nil, err
		}
		if effort == "" {
			effort = DefaultEffort
		}
		resolved, ok := ResolveEffort(effort)
		if !ok {
			return nil, catalogErrorf("%s", i18nText("catalog.error.bad_effort",
				"spot", spot, "effort", repr(effort),
				"levels", strings.Join(EffortLevels, ", "),
				"aliases", strings.Join(sortedCopy(mapKeys(EffortAliases)), ", ")))
		}

		window, err := windowField(object, "context_window", spot)
		if err != nil {
			return nil, err
		}
		label, err := textField(object, "label", spot)
		if err != nil {
			return nil, err
		}
		summary, err := textField(object, "summary", spot)
		if err != nil {
			return nil, err
		}
		note, err := textField(object, "note", spot)
		if err != nil {
			return nil, err
		}
		vision, err := flagField(object, "vision", spot, false)
		if err != nil {
			return nil, err
		}
		out = append(out, ModelRef{
			Provider:      provider,
			ID:            id,
			Label:         label,
			Window:        window,
			Summary:       summary,
			Note:          note,
			Vision:        vision,
			DefaultEffort: resolved,
		})
	}
	return out, nil
}

// providerNames lists the route names to build the catalogue from, in the order
// the document declares them.
//
// That order is load-bearing rather than cosmetic: the first usable route is the
// default route, and the same order is what the `/model` list shows, so it is how
// a person states which route they mean to be on. Inferring it by sorting would
// make the alphabet the decision-maker.
//
// A name the ordered pass did not report still gets visited — the catalogue
// omitting a configured route would be a worse failure than showing it in the
// wrong place, and a route that reaches the list is one the user can at least
// select or complain about.
func providerNames(cfg config.UserConfig) []string {
	names := make([]string, 0, len(cfg.Providers))
	seen := map[string]bool{}
	for _, name := range cfg.ProviderOrder {
		if _, known := cfg.Providers[name]; !known || seen[name] {
			continue
		}
		names = append(names, name)
		seen[name] = true
	}
	for _, name := range sortedKeys(cfg.Providers) {
		if !seen[name] {
			names = append(names, name)
		}
	}
	return names
}

func textField(raw map[string]any, key, where string) (string, error) {
	value, present := raw[key]
	if !present || value == nil {
		return "", nil
	}
	text, ok := value.(string)
	if !ok {
		return "", catalogErrorf("%s", i18nText("catalog.error.not_string",
			"where", where, "key", key, "kind", goKindName(value)))
	}
	return strings.TrimSpace(text), nil
}

func flagField(raw map[string]any, key, where string, fallback bool) (bool, error) {
	value, present := raw[key]
	if !present {
		return fallback, nil
	}
	flag, ok := value.(bool)
	if !ok {
		return false, catalogErrorf("%s", i18nText("catalog.error.not_bool", "where", where, "key", key))
	}
	return flag, nil
}

// styleField reads `api_style`.
//
// An unknown value is an error rather than a fallback to `openai`: silently
// treating a typo as the default is exactly the failure this catalogue refuses
// everywhere else. A route that ends up speaking the wrong protocol produces
// errors from the endpoint, not from here, and those errors name the endpoint
// rather than the line that is wrong.
func styleField(raw map[string]any, key, where string) (string, error) {
	text, err := textField(raw, key, where)
	if err != nil {
		return "", err
	}
	if text == "" {
		return "", nil
	}
	normalized := strings.ToLower(text)
	for _, style := range styles {
		if normalized == style {
			return normalized, nil
		}
	}
	return "", catalogErrorf("%s", i18nText("catalog.error.bad_style",
		"where", where, "style", repr(text), "styles", strings.Join(styles, ", ")))
}

// headersField reads the `headers` object: extra request headers this route
// needs, verbatim.
//
// Both halves are checked to be strings. A number would be a plausible typo for
// a version header (`"x-api-version": 2`) and JSON would happily carry it, but the
// header would go out as `2` only if we formatted it ourselves — and then the
// question "is this a number or a string" has to be answered somewhere. Refusing
// at read time answers it once, here.
func headersField(raw map[string]any, key, where string) (map[string]string, error) {
	value, present := raw[key]
	if !present || value == nil {
		return nil, nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, catalogErrorf("%s", i18nText("catalog.error.headers_not_object",
			"where", where, "key", key))
	}
	out := make(map[string]string, len(object))
	for name, entry := range object {
		header := strings.TrimSpace(name)
		if header == "" {
			return nil, catalogErrorf("%s", i18nText("catalog.error.header_empty_name", "where", where))
		}
		text, ok := entry.(string)
		if !ok {
			return nil, catalogErrorf("%s", i18nText("catalog.error.header_not_string",
				"where", where, "name", header))
		}
		out[header] = text
	}
	return out, nil
}

func windowField(raw map[string]any, key, where string) (*int, error) {
	value, present := raw[key]
	if !present || value == nil {
		return nil, nil
	}
	number, ok := jsonInt(value)
	if !ok {
		return nil, catalogErrorf("%s", i18nText("catalog.error.not_positive_int",
			"where", where, "key", key, "value", repr(value)))
	}
	if number <= 0 {
		return nil, catalogErrorf("%s", i18nText("catalog.error.not_positive_int",
			"where", where, "key", key, "value", repr(value)))
	}
	return &number, nil
}

func jsonInt(value any) (int, bool) {
	switch number := value.(type) {
	case json.Number:
		parsed, err := number.Int64()
		if err != nil {
			return 0, false
		}
		return int(parsed), true
	case float64:
		if number != float64(int64(number)) {
			return 0, false
		}
		return int(number), true
	case int:
		return number, true
	case int64:
		return int(number), true
	default:
		return 0, false
	}
}

// unknownKeys lists the keys a section does not understand.
//
// A key beginning with `$` is a **comment**, not a key: JSON has none and this file
// is written by hand, which is why the configuration reader already skips them
// everywhere it reads a section. This function has to apply the same rule, or a
// note placed beside the route it explains — which is the only place it is useful,
// and the very reason the convention exists — would be reported as a misspelled
// key and stop the session from starting.
func unknownKeys(raw map[string]any, allowed []string) []string {
	known := map[string]bool{}
	for _, key := range allowed {
		known[key] = true
	}
	var out []string
	for key := range raw {
		if strings.HasPrefix(key, "$") {
			continue
		}
		if !known[key] {
			out = append(out, key)
		}
	}
	sort.Strings(out)
	return out
}

func sortedKeys(raw map[string]any) []string {
	out := make([]string, 0, len(raw))
	for key := range raw {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

func sortedCopy(values []string) []string {
	out := append([]string(nil), values...)
	sort.Strings(out)
	return out
}

func mapKeys(raw map[string]string) []string {
	out := make([]string, 0, len(raw))
	for key := range raw {
		out = append(out, key)
	}
	return out
}

func repr(value any) string {
	if text, ok := value.(string); ok {
		return "'" + text + "'"
	}
	return sprintf("%v", value)
}

func baseName(path string) string {
	if index := strings.LastIndexAny(path, `/\`); index >= 0 {
		return path[index+1:]
	}
	return path
}

func goKindName(value any) string {
	switch value.(type) {
	case string:
		return "string"
	case bool:
		return "bool"
	case json.Number, float64, int, int64:
		return "number"
	case []any:
		return "list"
	case map[string]any:
		return "dict"
	default:
		return "unknown"
	}
}
