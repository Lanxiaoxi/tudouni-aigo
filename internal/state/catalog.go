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
var providerKeys = []string{"display_name", "base_url", "api_key", "models", "verify"}

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
	if head, tail, found := strings.Cut(wanted, "/"); found {
		if route, ok := r.ProviderByName(strings.TrimSpace(head)); ok {
			return route.Find(tail)
		}
		return ModelRef{}, false
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

	for _, name := range sortedKeys(cfg.Providers) {
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

		providers = append(providers, Provider{
			Name:        name,
			BaseURL:     baseURL,
			APIKey:      key,
			Models:      models,
			DisplayName: displayName,
			Verify:      verify,
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

func unknownKeys(raw map[string]any, allowed []string) []string {
	known := map[string]bool{}
	for _, key := range allowed {
		known[key] = true
	}
	var out []string
	for key := range raw {
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
