package memory

import (
	"encoding/json"
	"fmt"
	"os"
)

// ConfigVersion is the shape of config.json this build writes.
const ConfigVersion = 1

// Config is the per-workspace tuning of the memory subsystem.
//
// It lives in the workspace rather than in `~/.tudouni` because the thing it
// configures is per workspace: "recall past solutions in this project" and "keep
// this project's preferences in front of the model" are statements about a
// repository, not about a person. A global file would make the same corpus behave
// differently depending on which directory happened to be open.
//
// The defaults are the interesting part — a workspace with no config.json has to
// behave sensibly, because the file is written the first time somebody changes
// something and most workspaces will never have one.
type Config struct {
	// Version is the shape of the file. It is recorded so a future build can migrate
	// rather than guess, and it is why a config written by a newer build can be
	// spotted instead of half-read.
	Version int `json:"version"`
	// Enabled is the master switch. Off means no recall, no injection and the
	// memory tools answer "memory is off"; the files stay on disk untouched, so
	// turning it back on loses nothing.
	Enabled bool `json:"enabled"`
	// AutoInject is whether retrieved memories go into the request at all.
	//
	// It is separate from the two recall triggers because the two questions are
	// different: "should this be looked up" and "should the model see it". Off
	// leaves the explicit `memory_search` tool working, which is the setting
	// somebody who wants to choose for themselves actually wants.
	AutoInject bool `json:"auto_inject"`
	// RecallOnTurnStart retrieves against the user's own words when a turn begins.
	// This is where preferences are found, because a preference is triggered by
	// *what the person is doing* rather than by an error message.
	RecallOnTurnStart bool `json:"recall_on_turn_start"`
	// RecallOnToolFailure retrieves against the error text when a tool fails. This
	// is the trigger the design calls the most valuable one: it is the moment a
	// remembered fix is worth more than anything else on the screen.
	RecallOnToolFailure bool `json:"recall_on_tool_failure"`
	// MaxRecall bounds how many memories one automatic retrieval may inject.
	//
	// Three, not ten. The tail of the payload is read on every step of every turn,
	// and a block of ten memories costs more than it saves: the model starts
	// treating the block as the task. Anyone who wants a specific one can ask for
	// it with the tool.
	MaxRecall int `json:"max_recall"`
	// MaxResults bounds what `memory_search` returns when the caller does not say.
	MaxResults int `json:"max_results"`
	// MinScore is the relevance floor. It is in the same units as the scores in
	// retrieve.go — a title-word hit is worth 3, a trigger hit 8 — so the number is
	// readable rather than magic: 2 means "at least one real cue, not just a body
	// word in common".
	MinScore float64 `json:"min_score"`
	// EntryChars bounds how much of one memory's body is injected.
	EntryChars int `json:"entry_chars"`
	// NoteChars bounds the whole injected block. The per-entry cap times MaxRecall
	// is the worst case, and this is the ceiling that keeps a verbose corpus from
	// quietly becoming the prompt.
	NoteChars int `json:"note_chars"`
}

// DefaultConfig is what a workspace with no config.json gets.
func DefaultConfig() Config {
	return Config{
		Version:             ConfigVersion,
		Enabled:             true,
		AutoInject:          true,
		RecallOnTurnStart:   true,
		RecallOnToolFailure: true,
		MaxRecall:           3,
		MaxResults:          5,
		MinScore:            2,
		EntryChars:          600,
		NoteChars:           2400,
	}
}

// Bounds for the numeric knobs. They are wide on purpose: the point is to stop a
// typo (a `max_recall` of 500, a negative budget) from turning into a prompt made
// entirely of memories, not to second-guess somebody who wants more than the
// default.
const (
	maxRecallCeiling   = 10
	maxResultsCeiling  = 20
	entryCharsCeiling  = 4000
	noteCharsCeiling   = 12000
	minScoreFloorValue = 0.5
	minScoreCeiling    = 20.0
)

// Normalise clamps a config into the range this build can honour, and reports what
// it changed.
//
// Reporting matters more than clamping: a config file that says 500 and silently
// behaves as 10 is a person wondering why their setting did nothing. The notes come
// back to the panel, which is the only place they can be read.
func (c Config) Normalise() (Config, []string) {
	out := c
	var notes []string
	clamp := func(name string, value, low, high int, target *int) {
		if value < low {
			notes = append(notes, fmt.Sprintf("%s was %d, raised to %d", name, value, low))
			*target = low
			return
		}
		if value > high {
			notes = append(notes, fmt.Sprintf("%s was %d, lowered to %d", name, value, high))
			*target = high
		}
	}
	clamp("max_recall", out.MaxRecall, 1, maxRecallCeiling, &out.MaxRecall)
	clamp("max_results", out.MaxResults, 1, maxResultsCeiling, &out.MaxResults)
	clamp("entry_chars", out.EntryChars, 120, entryCharsCeiling, &out.EntryChars)
	clamp("note_chars", out.NoteChars, 200, noteCharsCeiling, &out.NoteChars)
	if out.MinScore < minScoreFloorValue {
		notes = append(notes, fmt.Sprintf("min_score was %.2f, raised to %.2f", out.MinScore, minScoreFloorValue))
		out.MinScore = minScoreFloorValue
	}
	if out.MinScore > minScoreCeiling {
		notes = append(notes, fmt.Sprintf("min_score was %.2f, lowered to %.2f", out.MinScore, minScoreCeiling))
		out.MinScore = minScoreCeiling
	}
	// A note budget smaller than one entry's budget would make every entry be cut
	// to the note budget and the per-entry setting meaningless.
	if out.NoteChars < out.EntryChars {
		out.EntryChars = out.NoteChars
	}
	return out, notes
}

// loadConfig reads config.json, returning the defaults when it is absent.
//
// A malformed file is a **reported** problem with the defaults in force, not a
// refusal: the memory system failing closed because of a stray comma is exactly the
// "an exception here must not block the task" rule the design states, and the person
// can see and fix the file from the panel.
func loadConfig(repo *repository) (Config, string) {
	raw, err := os.ReadFile(repo.configPath())
	if err != nil {
		if os.IsNotExist(err) {
			return DefaultConfig(), ""
		}
		return DefaultConfig(), fmt.Sprintf("cannot read %s: %v", repo.configPath(), err)
	}
	config := DefaultConfig()
	if err := json.Unmarshal(raw, &config); err != nil {
		return DefaultConfig(), fmt.Sprintf("%s is not valid JSON (%v) — using the defaults", repo.configPath(), err)
	}
	normalised, notes := config.Normalise()
	problem := ""
	if len(notes) > 0 {
		problem = fmt.Sprintf("%s: %v", repo.configPath(), notes)
	}
	return normalised, problem
}

// saveConfig writes config.json atomically.
func saveConfig(repo *repository, config Config) error {
	payload, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	return writeAtomic(repo.configPath(), payload)
}
