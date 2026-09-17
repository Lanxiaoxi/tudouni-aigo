package tools

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// JSON Schema, the small subset this program uses.
//
// Arguments are validated rather than trusted. The model's output is a
// suggestion, not a fact: a missing path, a string where a number belongs, an
// extra key somebody imagined — all of it has to be caught before a handler reads
// the map.
//
// Unknown keys are rejected (`additionalProperties: false` everywhere). An
// argument the schema does not mention is almost always the model naming a field
// that does not exist, and silently ignoring it means the handler runs with
// different inputs than the model intended while believing otherwise.

// ObjectSchema builds an object schema.
//
// Properties are given as name → schema, in the order they should be documented.
// Required names are listed separately so the two never have to be kept in sync by
// hand.
func ObjectSchema(properties map[string]any, required ...string) map[string]any {
	return map[string]any{
		"type":                 "object",
		"properties":           properties,
		"required":             required,
		"additionalProperties": false,
	}
}

// EmptySchema is an object schema that accepts no arguments.
func EmptySchema() map[string]any {
	return map[string]any{
		"type":                 "object",
		"properties":           map[string]any{},
		"additionalProperties": false,
	}
}

// StringSchema builds a string property.
func StringSchema(description string, options ...func(map[string]any)) map[string]any {
	schema := map[string]any{"type": "string", "description": description}
	for _, option := range options {
		option(schema)
	}
	return schema
}

// IntSchema builds an integer property.
func IntSchema(description string, options ...func(map[string]any)) map[string]any {
	schema := map[string]any{"type": "integer", "description": description}
	for _, option := range options {
		option(schema)
	}
	return schema
}

// BoolSchema builds a boolean property.
func BoolSchema(description string, options ...func(map[string]any)) map[string]any {
	schema := map[string]any{"type": "boolean", "description": description}
	for _, option := range options {
		option(schema)
	}
	return schema
}

// ArraySchema builds an array property.
func ArraySchema(description string, items map[string]any, options ...func(map[string]any)) map[string]any {
	schema := map[string]any{"type": "array", "description": description, "items": items}
	for _, option := range options {
		option(schema)
	}
	return schema
}

// Default declares a default. It is applied when the key is absent.
func Default(value any) func(map[string]any) {
	return func(schema map[string]any) { schema["default"] = value }
}

// MinLength bounds a string.
func MinLength(value int) func(map[string]any) {
	return func(schema map[string]any) { schema["minLength"] = value }
}

// Minimum bounds a number.
func Minimum(value int) func(map[string]any) {
	return func(schema map[string]any) { schema["minimum"] = value }
}

// Maximum bounds a number.
func Maximum(value int) func(map[string]any) {
	return func(schema map[string]any) { schema["maximum"] = value }
}

// Enum limits a value to a fixed set.
func Enum(values ...string) func(map[string]any) {
	list := make([]any, 0, len(values))
	for _, value := range values {
		list = append(list, value)
	}
	return func(schema map[string]any) { schema["enum"] = list }
}

// Validate checks arguments against a schema and returns a normalised copy.
//
// The copy has defaults filled in and numbers coerced to int where the schema
// asks for integers, so handlers can read values without repeating the checks.
func Validate(schema map[string]any, arguments map[string]any) (map[string]any, error) {
	if schema == nil {
		schema = EmptySchema()
	}
	if arguments == nil {
		arguments = map[string]any{}
	}
	validated, err := validateObject(schema, arguments, "")
	if err != nil {
		return nil, err
	}
	return validated, nil
}

func validateObject(schema, arguments map[string]any, prefix string) (map[string]any, error) {
	properties, _ := schema["properties"].(map[string]any)
	required := stringList(schema["required"])
	allowExtra, hasAllowExtra := schema["additionalProperties"].(bool)

	// Unknown keys first: naming the offending key is the whole value of this
	// check, and a missing-argument message would bury it.
	if hasAllowExtra && !allowExtra {
		var unknown []string
		for key := range arguments {
			if _, known := properties[key]; !known {
				unknown = append(unknown, key)
			}
		}
		if len(unknown) > 0 {
			sort.Strings(unknown)
			return nil, fmt.Errorf("unexpected argument %s%s (this tool takes %s)",
				pathOf(prefix, unknown[0]), plural(len(unknown)), knownNames(properties))
		}
	}

	out := map[string]any{}
	for name, raw := range arguments {
		propertySchema, known := properties[name]
		if !known {
			out[name] = raw
			continue
		}
		property, _ := propertySchema.(map[string]any)
		value, err := validateValue(property, raw, pathOf(prefix, name))
		if err != nil {
			return nil, err
		}
		out[name] = value
	}

	for _, name := range required {
		if _, present := out[name]; present {
			continue
		}
		property, _ := properties[name].(map[string]any)
		if fallback, ok := property["default"]; ok {
			out[name] = fallback
			continue
		}
		return nil, fmt.Errorf("field required: %s", pathOf(prefix, name))
	}

	// Defaults for optional properties that were simply left out.
	for name, propertySchema := range properties {
		if _, present := out[name]; present {
			continue
		}
		property, _ := propertySchema.(map[string]any)
		if fallback, ok := property["default"]; ok {
			out[name] = fallback
		}
	}
	return out, nil
}

func validateValue(schema map[string]any, value any, path string) (any, error) {
	kind, _ := schema["type"].(string)
	if allowed := stringList(schema["enum"]); len(allowed) > 0 {
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("%s: expected one of %s", path, strings.Join(allowed, ", "))
		}
		for _, candidate := range allowed {
			if candidate == text {
				return text, nil
			}
		}
		return nil, fmt.Errorf("%s: %q is not one of %s", path, text, strings.Join(allowed, ", "))
	}

	switch kind {
	case "string":
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("%s: expected a string, got %s", path, typeNameOf(value))
		}
		if minimum, ok := intOption(schema["minLength"]); ok && len([]rune(text)) < minimum {
			return nil, fmt.Errorf("%s: the string should have at least %d character%s (it has %d)",
				path, minimum, pluralSuffix(minimum), len([]rune(text)))
		}
		return text, nil

	case "integer":
		number, ok := coerceInt(value)
		if !ok {
			return nil, fmt.Errorf("%s: expected an integer, got %s", path, typeNameOf(value))
		}
		if minimum, ok := intOption(schema["minimum"]); ok && number < minimum {
			return nil, fmt.Errorf("%s: must be >= %d (it is %d)", path, minimum, number)
		}
		if maximum, ok := intOption(schema["maximum"]); ok && number > maximum {
			return nil, fmt.Errorf("%s: must be <= %d (it is %d)", path, maximum, number)
		}
		return number, nil

	case "boolean":
		flag, ok := value.(bool)
		if !ok {
			return nil, fmt.Errorf("%s: expected true or false, got %s", path, typeNameOf(value))
		}
		return flag, nil

	case "array":
		items, ok := value.([]any)
		if !ok {
			return nil, fmt.Errorf("%s: expected an array, got %s", path, typeNameOf(value))
		}
		itemSchema, _ := schema["items"].(map[string]any)
		out := make([]any, 0, len(items))
		for index, item := range items {
			validated, err := validateValue(itemSchema, item, path+"["+strconv.Itoa(index)+"]")
			if err != nil {
				return nil, err
			}
			out = append(out, validated)
		}
		return out, nil

	case "object":
		object, ok := value.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s: expected an object, got %s", path, typeNameOf(value))
		}
		return validateObject(schema, object, path)

	default:
		return value, nil
	}
}

func coerceInt(value any) (int, bool) {
	switch number := value.(type) {
	case int:
		return number, true
	case int64:
		return int(number), true
	case float64:
		if number != float64(int64(number)) {
			return 0, false
		}
		return int(number), true
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(number))
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func intOption(value any) (int, bool) {
	if value == nil {
		return 0, false
	}
	return coerceInt(value)
}

func stringList(value any) []string {
	items, ok := value.([]any)
	if !ok {
		if direct, ok := value.([]string); ok {
			return direct
		}
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func knownNames(properties map[string]any) string {
	if len(properties) == 0 {
		return "no arguments"
	}
	names := make([]string, 0, len(properties))
	for name := range properties {
		names = append(names, name)
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

func pathOf(prefix, name string) string {
	if prefix == "" {
		return name
	}
	return prefix + "." + name
}

func plural(count int) string {
	if count == 1 {
		return ""
	}
	return "s"
}

func pluralSuffix(count int) string {
	if count == 1 {
		return ""
	}
	return "s"
}

func typeNameOf(value any) string {
	switch value.(type) {
	case nil:
		return "nothing"
	case bool:
		return "a boolean"
	case string:
		return "a string"
	case int, int64, float64:
		return "a number"
	case []any:
		return "an array"
	case map[string]any:
		return "an object"
	default:
		return "an unexpected type"
	}
}
