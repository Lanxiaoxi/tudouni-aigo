package i18n

import (
	"strings"
	"testing"
	"unicode"
)

func TestEveryKeyRendersWithoutAMarker(t *testing.T) {
	// A missing key used to be a silent blank. Here it renders a marker nobody can
	// mistake for text — a blank label is a bug that ships, a marker is a bug that
	// gets fixed before the release.
	for _, key := range Keys() {
		if Has(key) {
			continue
		}
		t.Fatalf("key %q is in the table but Has disagrees", key)
	}
	for key, value := range catalog {
		if strings.TrimSpace(value) == "" {
			t.Fatalf("key %q has no text", key)
		}
		if strings.Contains(value, "⟪") {
			t.Fatalf("key %q contains the missing-translation marker", key)
		}
	}
}

func TestPluralFormsComeInPairs(t *testing.T) {
	// A lone base key means English would say "1 items". Both forms have to exist.
	for key := range catalog {
		if !strings.HasSuffix(key, ".one") {
			continue
		}
		other := strings.TrimSuffix(key, ".one") + ".other"
		if !Has(other) {
			t.Fatalf("%q has a singular form but no plural", key)
		}
	}
}

func TestTheInterfaceIsEnglishOnly(t *testing.T) {
	// The UI speaks English; Chinese belongs to the content the model is given, and
	// that text lives with the thing that owns it. A Chinese string here would mean
	// the two got mixed up.
	for key, value := range catalog {
		for _, char := range value {
			if unicode.Is(unicode.Han, char) {
				t.Fatalf("key %q contains Chinese text: %q", key, value)
			}
		}
	}
}

func TestPlaceholdersAreFilled(t *testing.T) {
	rendered := T("activity.tool_call", "tool", "shell", "index", " (call 2)")
	if rendered != "Calling shell (call 2)" {
		t.Fatalf("rendered = %q", rendered)
	}
}

func TestMissingPlaceholderIsVisibleNotSilent(t *testing.T) {
	// A placeholder with no binding stays literal: an interface that shows `{n}`
	// reports its own bug, while an interface that shows nothing hides it.
	rendered := T("activity.tool_call", "tool", "shell")
	if !strings.Contains(rendered, "{index}") {
		t.Fatalf("rendered = %q, want the unbound placeholder left visible", rendered)
	}
}

func TestPluralSelection(t *testing.T) {
	if got := Tn("activity.tool_batch", 1, "n", 1); got != "1 read-only tool running in parallel" {
		t.Fatalf("singular = %q", got)
	}
	if got := Tn("activity.tool_batch", 3, "n", 3); got != "3 read-only tools running in parallel" {
		t.Fatalf("plural = %q", got)
	}
}

func TestUnknownKeyReportsItselfOnce(t *testing.T) {
	ResetMissingKeys()
	var seen []string
	ReportMissing(func(text string) { seen = append(seen, text) })
	defer ReportMissing(func(string) {})

	T("no.such.key")
	T("no.such.key")
	if len(seen) != 1 {
		t.Fatalf("the same missing key was reported %d times; it should be once", len(seen))
	}
	if missing := MissingKeys(); len(missing) != 1 || missing[0] != "no.such.key" {
		t.Fatalf("MissingKeys = %v", missing)
	}
}
