package bootstrap

import "testing"

func TestInspectConfigBytesReportsMissing(t *testing.T) {
	got := InspectConfigBytes(false, nil)
	if got.Status != ConfigMissing {
		t.Errorf("Status = %q, want %q", got.Status, ConfigMissing)
	}
	if got.Fingerprint != "" {
		t.Errorf("Fingerprint = %q, want empty for a missing file", got.Fingerprint)
	}
}

func TestInspectConfigBytesReportsEmptyTemplate(t *testing.T) {
	got := InspectConfigBytes(true, []byte(`{"providers": {}}`))
	if got.Status != ConfigEmptyTemplate {
		t.Errorf("Status = %q, want %q", got.Status, ConfigEmptyTemplate)
	}
	if got.Fingerprint == "" {
		t.Error("Fingerprint is empty for a present file")
	}
}

func TestInspectConfigBytesReportsNoUsableRoute(t *testing.T) {
	raw := []byte(`{"providers": {"openai": {"base_url": "https://api.openai.com/v1", "api_key": ""}}}`)
	got := InspectConfigBytes(true, raw)
	if got.Status != ConfigNoUsableRoute {
		t.Errorf("Status = %q, want %q", got.Status, ConfigNoUsableRoute)
	}
}

func TestInspectConfigBytesReportsValid(t *testing.T) {
	raw := []byte(`{"providers": {"openai": {"base_url": "https://api.openai.com/v1", "api_key": "sk-test"}}}`)
	got := InspectConfigBytes(true, raw)
	if got.Status != ConfigValid {
		t.Errorf("Status = %q, want %q", got.Status, ConfigValid)
	}
}

// TestInspectConfigBytesReportsCorruptNeverAsEmptyTemplate is §9.3's own
// requirement: unparseable config must never be treated as (and silently
// overwritten like) an empty template.
func TestInspectConfigBytesReportsCorruptNeverAsEmptyTemplate(t *testing.T) {
	cases := [][]byte{
		[]byte(`{not valid json`),
		[]byte(`{"providers": "not an object"}`),
		[]byte(`{"unknown_top_level_key": {}}`),
	}
	for _, raw := range cases {
		got := InspectConfigBytes(true, raw)
		if got.Status != ConfigCorrupt {
			t.Errorf("InspectConfigBytes(%q) = %q, want %q", raw, got.Status, ConfigCorrupt)
		}
		if got.Error == "" {
			t.Errorf("InspectConfigBytes(%q) has no error message to act on", raw)
		}
	}
}

func TestFingerprintIsStableAndContentSensitive(t *testing.T) {
	a := Fingerprint([]byte("hello"))
	b := Fingerprint([]byte("hello"))
	c := Fingerprint([]byte("hello!"))
	if a != b {
		t.Error("Fingerprint is not stable for identical content")
	}
	if a == c {
		t.Error("Fingerprint did not change for different content")
	}
}

func TestDetectConflictNoBaselineIsAlwaysAConflict(t *testing.T) {
	// §9.5: "when an accurate comparison is not possible, treat it as a
	// conflict; never default to overwriting."
	if got := DetectConflict("", "same", "same"); got != ConflictBoth {
		t.Errorf("DetectConflict with no baseline = %q, want %q", got, ConflictBoth)
	}
}

func TestDetectConflictNeitherChanged(t *testing.T) {
	if got := DetectConflict("base", "base", "base"); got != ConflictNone {
		t.Errorf("got %q, want %q", got, ConflictNone)
	}
}

func TestDetectConflictOnlyRemoteChanged(t *testing.T) {
	if got := DetectConflict("base", "base", "new"); got != ConflictRemoteChanged {
		t.Errorf("got %q, want %q", got, ConflictRemoteChanged)
	}
}

func TestDetectConflictOnlyLocalChanged(t *testing.T) {
	if got := DetectConflict("base", "new", "base"); got != ConflictLocalChanged {
		t.Errorf("got %q, want %q", got, ConflictLocalChanged)
	}
}

func TestDetectConflictBothChanged(t *testing.T) {
	if got := DetectConflict("base", "local-new", "remote-new"); got != ConflictBoth {
		t.Errorf("got %q, want %q", got, ConflictBoth)
	}
}
