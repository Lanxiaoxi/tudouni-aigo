package state

import (
	"strings"
	"testing"
)

// TestEffortIsNotRewritten is the rule this file exists for.
//
// There used to be a folding table: `xhigh` was sent as `high`, `ultra` as `max`.
// It changed the request while leaving the typed word on screen, so the interface
// said one level and the bill described another, and "which level did I actually
// set" had no answer anywhere. A level is either on the list — and then it goes
// out verbatim — or it is refused.
func TestEffortIsNotRewritten(t *testing.T) {
	for _, level := range BroadEffortLevels {
		resolved, ok := ResolveEffort(level, BroadEffortLevels)
		if !ok {
			t.Fatalf("%q is in the vocabulary but does not resolve", level)
		}
		if resolved != level {
			t.Errorf("ResolveEffort(%q) = %q; a level must survive resolution unchanged", level, resolved)
		}
	}

	// The two that used to be folded are the ones worth naming.
	if level, ok := ResolveEffort("xhigh", BroadEffortLevels); !ok || level != "xhigh" {
		t.Errorf("xhigh resolved to %q (ok=%v), want xhigh — folding it to high is the bug", level, ok)
	}
	if level, ok := ResolveEffort("max", BroadEffortLevels); !ok || level != "max" {
		t.Errorf("max resolved to %q (ok=%v), want max", level, ok)
	}
}

// TestAnUnknownLevelIsRefused pins that nothing is guessed. `/effort hgih` must not
// silently become something: the two directions of a wrong guess are not symmetric,
// and one of them costs money at a level nobody asked for.
func TestAnUnknownLevelIsRefused(t *testing.T) {
	for _, text := range []string{"hgih", "ultra", "very-high", "none", ""} {
		if level, ok := ResolveEffort(text, BroadEffortLevels); ok {
			t.Errorf("ResolveEffort(%q) = %q, want a refusal", text, level)
		}
	}
}

// TestTheVocabularyIsTheEndpointsOwn is the anti-shortlist test: the levels the
// endpoint documents must all be resolvable, because a shortlist of our own is how
// a level that works becomes unselectable.
func TestTheVocabularyIsTheEndpointsOwn(t *testing.T) {
	for _, level := range []string{"minimal", "low", "medium", "high", "xhigh", "max"} {
		if !EffortAllowed(level, BroadEffortLevels) {
			t.Errorf("%q is missing from the broad vocabulary", level)
		}
	}
	if EffortAllowed("none", BroadEffortLevels) {
		t.Error("`none` is in the vocabulary; it is the thinking switch, not a level")
	}
}

// TestANarrowerListIsHonoured is the point of taking the list as an argument: the
// same word is a level on one model and a 400 on the next, and only the list knows
// which.
func TestANarrowerListIsHonoured(t *testing.T) {
	glm := []string{"high", "max"}
	if !EffortAllowed("max", glm) {
		t.Error("max is on the declared list but was refused")
	}
	if EffortAllowed("xhigh", glm) {
		t.Error("xhigh is not on the declared list but was accepted")
	}
}

// TestNormalizeEffortLevels cleans a declared list and reports an unusable one as
// undeclared.
//
// The distinction matters more than the cleaning does: an empty list means "this
// model takes no level", and an empty menu is a claim nobody made.
func TestNormalizeEffortLevels(t *testing.T) {
	levels, ok := NormalizeEffortLevels([]string{" High ", "high", "MAX", "", "none"})
	if !ok {
		t.Fatal("a list with two real levels was reported as empty")
	}
	if strings.Join(levels, ",") != "high,max" {
		t.Errorf("levels = %v, want [high max] — trimmed, lower-cased, without duplicates or `none`", levels)
	}

	for _, raw := range [][]string{nil, {}, {""}, {"none"}, {"  "}} {
		if _, ok := NormalizeEffortLevels(raw); ok {
			t.Errorf("%#v was accepted as a list of levels", raw)
		}
	}
}

// TestNearestEffortNeverReturnsAnUnsupportedLevel describes the clamping helper
// that deliberately has no callers.
//
// It is tested because the next person to hit "the session's level is not on this
// model's list" will reach for exactly this, and what they find has to be correct
// even though using it is the wrong answer — see the comment on the function.
func TestNearestEffortNeverReturnsAnUnsupportedLevel(t *testing.T) {
	lm := []string{"low", "medium"}
	level, ok := NearestEffort("xhigh", lm)
	if !ok {
		t.Fatal("NearestEffort refused to answer")
	}
	if !EffortAllowed(level, lm) {
		t.Errorf("NearestEffort returned %q, which is not on the list", level)
	}
	if level != "medium" {
		t.Errorf("NearestEffort(xhigh, [low medium]) = %q, want medium", level)
	}

	// Already supported: returned untouched, not moved to a neighbour.
	if level, _ := NearestEffort("low", lm); level != "low" {
		t.Errorf("NearestEffort(low, [low medium]) = %q, want low unchanged", level)
	}

	if _, ok := NearestEffort("high", nil); ok {
		t.Error("NearestEffort answered for an empty list; there is nothing to clamp to")
	}
}

// TestNearestEffortTiesGoToTheCheaperLevel pins the tie-break of that helper: when
// two levels are equally close, the surprise that costs less is the smaller one.
func TestNearestEffortTiesGoToTheCheaperLevel(t *testing.T) {
	// `high` sits between `medium` and `xhigh`; both are one step away.
	level, ok := NearestEffort("high", []string{"medium", "xhigh"})
	if !ok {
		t.Fatal("NearestEffort refused to answer")
	}
	if level != "medium" {
		t.Errorf("NearestEffort(high, [medium xhigh]) = %q, want the weaker one", level)
	}
}
