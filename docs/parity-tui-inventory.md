# TUI — interaction inventory (appendices to the gap report)

## A. Slash commands

Python table: `tudouni-ai/agent_runtime/frontends/tui/view_state.py:2225-2267` (17 entries, this order).
Dispatch: `tudouni-ai/agent_runtime/frontends/tui/app.py:1566-1602`.
Go table: `internal/frontends/tui/commands.go:26-48`; dispatch `internal/frontends/tui/keys.go:238-452`.

| command | args accepted (Python) | Go | output shape | error handling |
|---|---|---|---|---|
| `/new` | — | yes (`keys.go:250`) | Python: one `switch.to_session`-style line, then `init` reopens the welcome screen; Go: `switch.new_session` + `init.session_id` (two lines) | Python does not clear the screen optimistically; Go matches |
| `/resume [id]` | id | yes (`keys.go:257`) | no arg → session picker; with id → `session_switch` + echo | Python does not validate the id; Go matches |
| `/audit` | — | yes (`keys.go:440`) | one line with `state.audit_path` | Python's `i18n.t("cmd.audit.line")`; Go same key |
| `/exit`, `/quit` | — | yes (`keys.go:244`) | quits | parity |
| `/help` | — | yes (`keys.go:460`) | command table + key table | **diverges**: detail on the same row, `↑ ↓` hint missing (m5) |
| `/theme [name]` | name/ordinal/fragment | yes (`keys.go:341`) | no arg → picker of 13 (Python) / 3 (Go); with name → switch + echo | **diverges**: B1; unknown name prints `theme.unknown` + listing on both (`keys.go:350-353`) |
| `/skills` | — | yes (`keys.go:391`) | panel | parity (Go panel shows name + description only) |
| `/autopilot` | — | yes (`keys.go:360`) | request only; echo after the snapshot | parity (no optimistic update) |
| `/quiet [on\|off]` | on/off, case-insensitive | yes (`keys.go:396`) | local toggle + echo, two lines when turning on | **diverges**: case-sensitive (M4) |
| `/status` | — | yes (`keys.go:275`) | sends `status`, reply rendered into the transcript | parity (row-for-row, `status.go:43-198`) |
| `/tools` | — | yes (`keys.go:279`) | sends `tools`, reply rendered into the transcript | parity (`status.go:206-270`) |
| `/context` | — | yes (`keys.go:283`) | sends `context`, reply rendered into the transcript | parity via `frontends/report.go:31-100` |
| `/compact` | — | yes (`keys.go:287`) | echo first, async result later + ledger | parity (`model.go:876-887`) |
| `/model [name]` | name | yes (`keys.go:294`) | no arg → picker (needs `model_catalog`); with name → `set_model` | **diverges**: picker row content (M6); fallback text (M7) |
| `/thinking [on\|off]` | literally `on`/`off` | yes (`keys.go:311`) | no arg → current value; with arg → `set_thinking` | **diverges**: alias table (M3); no arg in Go prints one line, Python prints three (`render_thinking`) |
| `/effort [level]` | level | yes (`keys.go:328`) | no arg → picker (needs `effort_levels`) | **diverges**: fallback text (M7) |
| `/mcp [load\|unload <name>]` | exactly `load`/`unload` + one name | yes (`keys.go:368`) | no arg → panel; with args → `mcp` request + echo | **diverges**: bad syntax does not open the panel (M5); Go accepts `/mcp load a b` |
| `/list`, `/session`, `/export`, `/jobs`, `/lang` | absent from Python as well | absent | — | not a gap |

## B. Key bindings

Python `BINDINGS`: `app.py:491-500`. PromptArea-level keys: `widgets.py:1827-1926`.
TextArea built-ins (Ctrl+A/E/W/U, Home/End, Delete, Ctrl+Left/Right): inherited.

| key | Python | Go | note |
|---|---|---|---|
| `Ctrl+C` | quit app (`app.py:492`) | `keys.go:44` | parity |
| `Ctrl+T` | toggle the thinking block of the turn under the viewport (`app.py:2149-2170`) | `keys.go:85-86`, `keys.go:881-890` — walks back to the newest turn that has thinking | same user-visible effect while the newest turn is the one on screen |
| `Ctrl+B` | toggle the rail + pin (`app.py:2138-2147`) | `keys.go:62-69` | **divergence**: dead while an overlay is open (m2) |
| `Ctrl+K` | open the palette, insert `/` when empty (`app.py:1481-1501`) | `keys.go:71-75` | m9 (no `/` inserted) |
| `Ctrl+S` | skills panel (`app.py:2172-2174`) | `keys.go:77-83` | parity |
| `Esc` | close overlay / interrupt / idle notice / deny in the approval (`app.py:2176-2198`) | `keys.go:47-60`, `keys.go:916-917` | parity |
| `↑` / `↓` | palette move else log scroll (`app.py:1454-1472`) | `keys.go:88-109` | parity (Go also moves the caret inside the box first) |
| `Enter` | send (`widgets.py:1887`) | `keys.go:156-161` | parity |
| `Shift+Enter` | newline (`widgets.py:357-372`, `test_tui.py:1536`) | **not present**; `Ctrl+J` / `Alt+Enter` instead (`keys.go:147-160`) | m6 |
| `Ctrl+A`/`Ctrl+E`/`Home`/`End` | TextArea line start/end | `keys.go:127-133` | parity |
| `Ctrl+W`, `Ctrl+U`, `Delete`, `Ctrl+←/→` | TextArea | `keys.go:119-145`, `input.go:156-240` | parity |
| `Space`, digits, `q` in a panel | Python panels accept `↑↓`/`Enter` (Space only in the MCP panel); `Esc` closes | Go accepts Space=Enter in every list, digits pick a row, `q` closes (`keys.go:653-675`) | additive, not a loss |

## C. Left rail — every row

Python `rail_blocks` / `_*_block`: `view_state.py:1780-2085`. Go `railBlocks`: `rail.go:37-530`.

Block order: Goal · Tasks · Loaded skills · Session · Background jobs · MCP.
Python had **Permissions** between Loaded skills and Session; Go no longer draws that block
at all — see the row below.

| block | rows (Python) | Go |
|---|---|---|
| Goal | — (Python has no goal block) | `rail.go:52-55` — objective, phase/rounds line, armed/disarmed, blocked message |
| Tasks | progress bar (one cell per task, `+N` past 20) + one row per todo with `✓/◐/○/·`; badge `done / total`; two-line empty state | `rail.go:261-313` — same, badge omitted when empty (matches Python's `""`) |
| Loaded skills | one row per name (`ROLE_SKILL`); badge is a literal `"0"` | `rail.go:389-402` — same |
| Permissions | one row per risk level, disposition word from the runtime, colour only on medium/high; granted-tools row, granted-prefixes row, denied-tools row, else "reported by level" | **removed.** The risk table duplicated the status bar's permission chip (it is the same `risk_scope` payload, and those two single-line places are where the fact is read); the granted / command-rule / denied rows went with it and `/tools` is where that policy is read. The i18n keys and `panelstate.granted/prefixes/denied` went too. |
| Session | id; model + window; thinking-off row (with effort); size; context figure; audit dir; one row per AGENT.md with `!`/`…` | `rail.go:160-256` — same; **no provider line anywhere** (Go never reads `init.provider`) |
| Background jobs | four state marks, `n / m` badge counts outstanding, only `uncollected` in the waiting colour | `rail.go:350-387`, `rail.go:455-471` — same |
| MCP | only `loaded` rows with the tool count, badge `running / configured`; empty state says nothing is mounted | `rail.go:404-451` — same |

Collapse behaviour: `Ctrl+B` toggles + pins; auto-open on the todos edge
(Python `view_state.py:2121-2159` ↔ Go `noteTaskList`, `model.go` — called from **both**
`beginTurn` and the state snapshot, because the list only ever appears mid-turn).

Narrow degradation: rail hidden below 100 columns and the one-line summary shows only below
120 columns on both (`view.go:24`, `view.go:50-52` ↔ `app.py:848-856`).
Summary contents: Python includes the autopilot cell; Go does not (M10).

## D. Overlays

| overlay | open | keys | close | notes |
|---|---|---|---|---|
| command palette | `/` (both), `Ctrl+K` (both) | `↑↓`, `Enter` runs the row carrying the typed argument, typing filters | `Esc` (clears the line) | Go's palette is an overlay; Python's is an inline row. Parity of interaction. |
| `/model` picker | no argument | `↑↓`, `Enter` | `Esc` = nothing; **closes immediately** on pick (Go 4.1.1, a deliberate departure — `parity-tui.md` → "Deliberate departures") | Python keeps the panel up until the runtime's notice arrives |
| `/effort` picker | no argument | `↑↓`, `Enter` | `Esc` = nothing; **closes immediately** on pick (Go 4.1.1, a deliberate departure — `parity-tui.md` → "Deliberate departures") | Python keeps the panel up until the runtime's notice arrives |
| `/theme` picker | no argument | `↑↓`, `Enter` | `Esc` = nothing; **closes immediately** on pick | parity |
| `/resume` picker | no argument | `↑↓`, `Enter` switches | `Esc` = nothing | parity; Go does not show the todo suffix (m14) |
| `/mcp` panel | no argument | `↑↓`, `Enter`/`Space` toggle | `Esc` only closes | parity; **not opened on a bad argument** (M5); the "waiting for runtime" line replaces the hint line in both |
| `/skills` panel | `Ctrl+S`, `/skills` | any close key | `Esc`/`Enter` | parity |
| approval prompt | on `permission_request` | `y` allow, `n`/`Esc` deny, `t` always (only with `remember_hint`), `a` allow-all (only with `allow_trust_all`) | on answer | parity, including the log line written *before* the modal (`model.go:278-285` ↔ `app.py:1398-1401`) |
| ask_user prompt | on `question_request` | `↑↓`, digits, `Enter` takes the highlight, free text wins, `Esc` skips | on answer | parity |
| welcome banner | first non-resumed `init`, as a log block | n/a | comes down at the first turn | parity |

## E. Status bar fields

Python `status_left` / `status_right` / `autopilot_badge` / `quiet_badge` / `jobs_badge`:
`view_state.py:683-863`. Go: `view.go:479-788`.

Left: phase mark (`○ ● ✓ ! ✗ —`), phase colour, activity or settled wording, `step n / N`;
booting branch overrides everything with `status.boot.starting` / `status.boot.slow`.
Right (in order): autopilot badge (short form on narrow), quiet chip (only when on), jobs badge
(absent / collected / running / +uncollected in warn), then `status_right` =
context used/window/percent or used/(no window)/"no reading" · cache hit · turn duration or session
span · short audit path; narrow keeps only the first two.

Divergences: no spinner during boot (M8); the frame keeps animating while a dialog waits for a human
(M9); `1.0M` instead of `1M` (m1).

## F. What Python's `view_state.py` computes that Go does not

* `should_auto_open` — present in Go as `noteTaskList`, called from the state snapshot (the
  todos edge is only observable there) as well as `beginTurn`. The `railPinned` gate M2
  described is gone.
* `rail_summary` — present, minus the autopilot segment (M10).
* `tokens_text`'s integer trimming (m1) and `ms_text`'s `—` for a missing duration
  (`view_state.py:268-271` → Go's `msText` returns `"0ms"` for a nil/zero duration,
  `transcript.go:664-673`).
* `model_aliases`, `model_option`'s `label`/`summary`/`window`, `provider` — not rendered anywhere in Go.
* `render_thinking` / `render_effort` / `render_models` fallback bodies (M7).
* `clip` / `indent` / `quote_line` helpers used by the tool/thinking paths — Go re-implements the
  equivalents inline (`clipText`, `clipBrief`, `thinkingBody`).
