package state

import (
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/config"
)

// The delegation presets.
//
// Which model a delegated agent runs on is the person's decision, not the
// model's: it is their bill and their keys. So the choice is made here, in the
// configuration, as a short list of named presets, and the delegating model only
// picks a *name* off that list by what the task is. It never sees a model name
// it could invent.
//
// ## The shape
//
//	"subagents": {
//	  "default": "fast",
//	  "presets": [
//	    {"name": "fast", "provider": "openai", "model": "gpt-mini",
//	     "effort": "low", "purpose": "search, locate, read large files"}
//	  ]
//	}
//
// `presets` is an array rather than an object because the order is shown to the
// model and on the panel, and a JSON object has none. An absent or empty
// `default` means "the parent's own route", which is also what a machine with no
// section at all gets — the behaviour before presets existed.

// MaxSubagentPresets bounds the list. Each preset is a line in the tool's
// description that every request pays for, and a menu of twenty is a menu the
// model reads badly.
const MaxSubagentPresets = 8

var subagentSectionKeys = []string{"default", "presets"}
var subagentPresetKeys = []string{"name", "provider", "model", "effort", "purpose"}

// SubagentPreset is one named route a delegation may run on.
type SubagentPreset struct {
	Name     string
	Provider string
	Model    string
	// Effort is the reasoning level. Empty means the model's declared default,
	// or the session's own level when the model declares none.
	Effort string
	// Purpose is what the preset is for, in the person's words. It is what the
	// delegating model reads to choose, so it is the one field that is about
	// the task rather than the route.
	Purpose string
}

// SubagentPresets is the parsed `subagents` section.
type SubagentPresets struct {
	Presets []SubagentPreset
	// Default names the preset used when a delegation names none. Empty means
	// "follow the parent session".
	Default string
}

// Find returns the preset with this name.
func (s SubagentPresets) Find(name string) (SubagentPreset, bool) {
	wanted := strings.TrimSpace(name)
	for _, preset := range s.Presets {
		if preset.Name == wanted {
			return preset, true
		}
	}
	return SubagentPreset{}, false
}

// Names lists the preset names in file order.
func (s SubagentPresets) Names() []string {
	out := make([]string, 0, len(s.Presets))
	for _, preset := range s.Presets {
		out = append(out, preset.Name)
	}
	return out
}

// ParseSubagentPresets reads the section out of a loaded configuration.
//
// A shape problem is an error that stops the session, the same rule as the
// providers and the image route: a preset that silently did nothing would send
// delegations to the parent's model while the panel said otherwise. A preset
// whose route has **no key** is not an error here — the route may get one
// later, and the delegation that tries it is refused with a sentence that names
// the route (see the runtime's ResolveChild).
func ParseSubagentPresets(cfg config.UserConfig, catalog Registry) (SubagentPresets, error) {
	if len(cfg.Subagents) == 0 {
		return SubagentPresets{}, nil
	}
	where := i18nText("catalog.where.subagents", "file", baseName(cfg.Path))
	object := cfg.Subagents
	if unknown := unknownKeys(object, subagentSectionKeys); len(unknown) > 0 {
		return SubagentPresets{}, catalogErrorf("%s", i18nText("catalog.error.unknown_keys",
			"spot", where, "names", strings.Join(unknown, ", "), "known", strings.Join(sortedCopy(subagentSectionKeys), ", ")))
	}

	out := SubagentPresets{}
	if raw, present := object["presets"]; present && raw != nil {
		items, ok := raw.([]any)
		if !ok {
			return SubagentPresets{}, catalogErrorf("%s", i18nText("catalog.error.subagents_not_list", "where", where))
		}
		if len(items) > MaxSubagentPresets {
			return SubagentPresets{}, catalogErrorf("%s", i18nText("catalog.error.subagents_too_many",
				"where", where, "count", len(items), "max", MaxSubagentPresets))
		}
		seen := map[string]bool{}
		for index, item := range items {
			spot := i18nText("catalog.where.subagent_preset", "index", index, "where", where)
			preset, err := parseSubagentPreset(item, spot, catalog)
			if err != nil {
				return SubagentPresets{}, err
			}
			if seen[preset.Name] {
				return SubagentPresets{}, catalogErrorf("%s", i18nText("catalog.error.subagent_duplicate",
					"spot", spot, "name", repr(preset.Name)))
			}
			seen[preset.Name] = true
			out.Presets = append(out.Presets, preset)
		}
	}

	defaultName, err := textField(object, "default", where)
	if err != nil {
		return SubagentPresets{}, err
	}
	if defaultName != "" {
		if _, found := out.Find(defaultName); !found {
			names := out.Names()
			if len(names) == 0 {
				names = []string{"(none configured)"}
			}
			return SubagentPresets{}, catalogErrorf("%s", i18nText("catalog.error.subagent_bad_default",
				"where", where, "name", repr(defaultName), "names", strings.Join(names, ", ")))
		}
	}
	out.Default = defaultName
	return out, nil
}

func parseSubagentPreset(item any, spot string, catalog Registry) (SubagentPreset, error) {
	object, ok := item.(map[string]any)
	if !ok {
		return SubagentPreset{}, catalogErrorf("%s", i18nText("catalog.error.not_object", "spot", spot))
	}
	if unknown := unknownKeys(object, subagentPresetKeys); len(unknown) > 0 {
		return SubagentPreset{}, catalogErrorf("%s", i18nText("catalog.error.unknown_keys",
			"spot", spot, "names", strings.Join(unknown, ", "), "known", strings.Join(sortedCopy(subagentPresetKeys), ", ")))
	}
	preset := SubagentPreset{}
	fields := []struct {
		key    string
		target *string
	}{
		{"name", &preset.Name},
		{"provider", &preset.Provider},
		{"model", &preset.Model},
		{"effort", &preset.Effort},
		{"purpose", &preset.Purpose},
	}
	for _, field := range fields {
		text, err := textField(object, field.key, spot)
		if err != nil {
			return SubagentPreset{}, err
		}
		*field.target = text
	}
	if !validPresetName(preset.Name) {
		return SubagentPreset{}, catalogErrorf("%s", i18nText("catalog.error.subagent_bad_name",
			"spot", spot, "name", repr(preset.Name)))
	}
	// Both halves of the route are required. A bare model name would be looked
	// up across every route, and a name two routes share is the one case where
	// that lookup refuses — better to say so here than at the first delegation.
	if preset.Provider == "" || preset.Model == "" {
		return SubagentPreset{}, catalogErrorf("%s", i18nText("catalog.error.subagent_no_route", "spot", spot))
	}
	route, found := catalog.ProviderByName(preset.Provider)
	if !found {
		return SubagentPreset{}, catalogErrorf("%s", i18nText("catalog.error.imagegen_no_provider",
			"where", spot, "provider", repr(preset.Provider), "routes", strings.Join(catalogRouteNames(catalog), ", ")))
	}
	if _, found := route.Find(preset.Model); !found {
		return SubagentPreset{}, catalogErrorf("%s", i18nText("catalog.error.subagent_no_model",
			"spot", spot, "model", repr(preset.Model), "provider", preset.Provider))
	}
	if preset.Effort != "" {
		levels := catalog.EffortLevelsFor(preset.Model, preset.Provider)
		level, ok := ResolveEffort(preset.Effort, levels)
		if !ok {
			return SubagentPreset{}, catalogErrorf("%s", i18nText("catalog.error.bad_effort",
				"spot", spot, "effort", repr(preset.Effort), "levels", strings.Join(levels, ", ")))
		}
		preset.Effort = level
	}
	return preset, nil
}

// validPresetName keeps names to what fits in a JSON-schema enum and reads as
// one word in a tool description.
func validPresetName(name string) bool {
	if name == "" || len(name) > 32 {
		return false
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}
