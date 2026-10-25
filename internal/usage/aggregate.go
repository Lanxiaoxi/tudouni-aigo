package usage

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"sort"
	"time"
)

// dayLayout is a calendar day as the records' timestamps spell it.
const dayLayout = "2006-01-02"

// windowDays is how far back the per-day series reaches. The totals and the
// streaks are computed over the **whole** file — a three-month-old peak day is
// still the peak, and a streak must not evaporate because it started last
// year — while `by_day` exists to draw a one-year heatmap, and carrying every
// day since the first use would make the panel ship years of empty cells.
const windowDays = 365

// Day is one calendar day's activity, as `by_day` and `peak` carry it.
type Day struct {
	Day    string
	Tokens int
	Turns  int
	// Models splits the day's tokens by the model each turn's row names — the
	// turn's last successful call, the same approximation the row itself
	// carries (see the ledger's fold). A row without a model lands in the
	// day's totals but in no bucket here, so the split can sum to less than
	// `Tokens`: guessing a model for a row that did not record one would
	// invent spend. A day whose rows all lack a model carries a nil map, and
	// the payload omits the key — the front end hides its per-model charts
	// rather than drawing an invented one.
	Models map[string]int
}

// Report is the ledger folded into the panel's numbers.
//
// The zero value is a valid answer: an empty ledger means "nothing spent yet",
// which is the normal state of a first run rather than an error.
type Report struct {
	GeneratedAt string
	// Prompt/Cached/Miss/Completion are the totals over every record, using the
	// same four fields `state.Counter` reports. `Tokens` is prompt+completion —
	// the number a person means by "how many tokens", with cached input counted
	// because it was really sent and really billed.
	Prompt, Cached, Miss, Completion, Tokens int
	Turns                                    int
	Calls                                    int
	// Days is how many distinct calendar days have at least one record.
	Days int
	// LongestRunMs is the wall time of the longest finished turn. `Has` is
	// separate because "no turn has ever finished" and "the longest turn took
	// 0ms" are different claims, and only the first may be reported as absence.
	LongestRunMs  int64
	HasLongestRun bool
	// Peak is the busiest day over the whole history. Nil until a record exists.
	Peak *Day
	// StreakCurrent counts back from today — or from yesterday when today has
	// no record yet, because a day is not over until it is. A streak ends the
	// moment two active days have a silent day between them.
	StreakCurrent int
	StreakLongest int
	// ByDay is the per-day series inside the window, ascending, carrying only
	// days that have records. The panel builds the empty cells itself.
	ByDay []Day
}

// dayFold is one day's accumulated activity, kept for every day the file
// mentions — the peak and the streaks reach past the window, so the fold
// cannot stop at its edge.
type dayFold struct {
	tokens, turns int
	models        map[string]int
}

// Aggregate folds the ledger file into a Report.
//
// Lines that do not parse are skipped: a killed process leaves half a line
// behind, and one half line must not make a year of history unreadable. The
// file need not exist — that is the empty ledger, and it answers with a zero
// report rather than an error.
func Aggregate(path string, now time.Time) (Report, error) {
	report := Report{GeneratedAt: now.Format(timeLayout)}

	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return report, nil
		}
		return report, err
	}
	defer file.Close()

	today := now.Format(dayLayout)
	windowStart := now.AddDate(0, 0, -(windowDays - 1)).Format(dayLayout)

	days := make(map[string]*dayFold)
	scanner := bufio.NewScanner(file)
	// A row is a few hundred bytes, but the default 64 KiB cap is on whole
	// lines, and a file this format does not produce is not this reader's to
	// die on — one oversized line is skipped like any other bad line.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var row map[string]any
		if err := json.Unmarshal(line, &row); err != nil {
			continue
		}
		report.Prompt += intOf(row["prompt"])
		report.Cached += intOf(row["cached"])
		report.Miss += intOf(row["miss"])
		report.Completion += intOf(row["completion"])
		report.Turns++
		report.Calls += intOf(row["calls"])
		if duration := int64Of(row["duration_ms"]); duration > report.LongestRunMs {
			report.LongestRunMs = duration
			report.HasLongestRun = true
		}
		if day := dayOf(stringOf(row["ts"])); day != "" {
			agg := days[day]
			if agg == nil {
				agg = &dayFold{}
				days[day] = agg
			}
			spent := intOf(row["prompt"]) + intOf(row["completion"])
			agg.tokens += spent
			agg.turns++
			if model := stringOf(row["model"]); model != "" {
				if agg.models == nil {
					agg.models = make(map[string]int)
				}
				agg.models[model] += spent
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return report, err
	}

	report.Tokens = report.Prompt + report.Completion
	report.Days = len(days)

	sorted := make([]string, 0, len(days))
	for day := range days {
		sorted = append(sorted, day)
	}
	sort.Strings(sorted)

	for _, day := range sorted {
		agg := days[day]
		if report.Peak == nil || agg.tokens > report.Peak.Tokens {
			report.Peak = &Day{Day: day, Tokens: agg.tokens, Turns: agg.turns}
		}
		if day >= windowStart && day <= today {
			report.ByDay = append(report.ByDay, Day{Day: day, Tokens: agg.tokens, Turns: agg.turns, Models: agg.models})
		}
	}
	report.StreakCurrent, report.StreakLongest = streaks(sorted, now)
	return report, nil
}

// dayOf validates a timestamp's day part. A record whose `ts` does not spell a
// local calendar day has no day to land on; dropping it from the per-day views
// while keeping it in the totals is the honest split — the spend happened, but
// "when" is not something this reader will guess.
func dayOf(ts string) string {
	if len(ts) < len(dayLayout) {
		return ""
	}
	day := ts[:len(dayLayout)]
	if _, err := time.Parse(dayLayout, day); err != nil {
		return ""
	}
	return day
}

// streaks computes the current and longest runs of consecutive active days.
//
// The current streak is anchored on today, falling back to yesterday when
// today is silent: the person opening the panel in the morning has not done
// anything yet, and "0" would read as a broken counter rather than as "the day
// is young". The fallback cannot manufacture a streak — yesterday silent ends
// it like any other silent day.
func streaks(sorted []string, now time.Time) (current, longest int) {
	if len(sorted) == 0 {
		return 0, 0
	}
	longest = 1
	run := 1
	for i := 1; i < len(sorted); i++ {
		if nextDay(sorted[i-1]) == sorted[i] {
			run++
		} else {
			run = 1
		}
		if run > longest {
			longest = run
		}
	}

	anchor := now.Format(dayLayout)
	at := sort.SearchStrings(sorted, anchor)
	if at >= len(sorted) || sorted[at] != anchor {
		anchor = nextDayReverse(anchor)
		at = sort.SearchStrings(sorted, anchor)
		if at >= len(sorted) || sorted[at] != anchor {
			return 0, longest
		}
	}
	current = 1
	for i := at; i > 0; i-- {
		if nextDay(sorted[i-1]) != sorted[i] {
			break
		}
		current++
	}
	return current, longest
}

// nextDay spells the day after `day`.
func nextDay(day string) string {
	parsed, err := time.Parse(dayLayout, day)
	if err != nil {
		return ""
	}
	return parsed.AddDate(0, 0, 1).Format(dayLayout)
}

// nextDayReverse spells the day before `day`.
func nextDayReverse(day string) string {
	parsed, err := time.Parse(dayLayout, day)
	if err != nil {
		return ""
	}
	return parsed.AddDate(0, 0, -1).Format(dayLayout)
}

// Payload renders the report as the `ui(usage)` map.
//
// Only numbers travel — the ledger holds ids and figures, and this payload
// adds no text to them. The optional facts are omitted rather than zeroed: a
// day that never happened is absent, not "the busiest day had 0 tokens", and
// a day with no modeled rows carries no `models` key, not an empty one.
func (r Report) Payload() map[string]any {
	payload := map[string]any{
		"generated_at": r.GeneratedAt,
		"totals": map[string]any{
			"prompt":     r.Prompt,
			"cached":     r.Cached,
			"miss":       r.Miss,
			"completion": r.Completion,
			"tokens":     r.Tokens,
			"turns":      r.Turns,
			"calls":      r.Calls,
			"days":       r.Days,
		},
		"streak": map[string]any{
			"current": r.StreakCurrent,
			"longest": r.StreakLongest,
		},
		"by_day": []map[string]any{},
	}
	if r.Peak != nil {
		payload["peak"] = map[string]any{
			"day":    r.Peak.Day,
			"tokens": r.Peak.Tokens,
			"turns":  r.Peak.Turns,
		}
	}
	if r.HasLongestRun {
		payload["longest_run_ms"] = r.LongestRunMs
	}
	byDay := make([]map[string]any, 0, len(r.ByDay))
	for _, day := range r.ByDay {
		entry := map[string]any{
			"day":    day.Day,
			"tokens": day.Tokens,
			"turns":  day.Turns,
		}
		// Absent, not empty, when nothing in the day recorded a model: the
		// front end decides "no per-model charts" from the key's absence, and
		// an empty map would read as "charts with nothing in them".
		if len(day.Models) > 0 {
			entry["models"] = day.Models
		}
		byDay = append(byDay, entry)
	}
	payload["by_day"] = byDay
	return payload
}
