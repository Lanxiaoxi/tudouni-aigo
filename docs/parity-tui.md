# TUI front-end parity audit — Python `agent_runtime/frontends/tui` vs Go `internal/frontends/tui`

Read-only reconnaissance. Every finding names the Python symbol/constant (source of truth) and
what Go has instead. Paths are relative to the workspace root `C:\Users\XPS\WorkBuddy\tudouni-aigo`.

## 0. Scope notes (things checked and found **absent from both** sides)

`/session`, `/export`, `/jobs`, `/lang`, `/list` are **not** implemented in the Python TUI either
(`view_state.py:2225-2267` is the whole command table; `test_tui.py:1734` asserts `/list` must stay
gone). They are therefore **not** gaps. Go's `commands.go:26-62` carries exactly the same 17 entries
in the same order. There is one extra accepted spelling: `/exit` **and** `/quit`
(`app.py:1566` ↔ `keys.go:244`).

The Go port is English-only with a single `internal/i18n/en.go` catalogue and no language selection;
per the audit brief this is **not** reported as a gap, though it does mean every `i18n.T(key)` on the
Go side has exactly one value and the Python side's two catalogues (`i18n/zh.py`, `i18n/en.py`) have
no counterexample for the label-trimming rules the Python code computes per language
(`view_state.py:2298-2321`).

---

# BLOCKERS

### B1. `/theme` — 10 of the 13 palettes are gone, and the start-up default changed

* Python: `tudouni-ai/agent_runtime/frontends/tui/theme.py:324-458`
  (`_PALETTES` = 13 entries, `ORDER = ("P3","P5","P6","P7","P9","A","B","C","D","E","P3-T","A-T","A-T2")`,
  `DEFAULT_THEME = "A"` at `theme.py:100`)
* Go: `internal/frontends/tui/theme.go:34-44` and `theme.go:204-210`
  (`themeAmber`/`themeDeepClear`/`themePinkViolet` only,
  `themeOrder = []themeKey{themeAmber, themeDeepClear, themePinkViolet}`,
  `const defaultTheme = themeDeepClear`)
* Evidence: Python has `Palette("P5", "夜紫柔彩", …)`, `Palette("P7", "靛夜", …)`,
  `Palette("B", "极地冷", …)`, `_transparent(_PALETTES[0])` → `P3-T`, `_transparent(_PALETTES[5])` → `A-T`;
  Go's own file comment says it outright: *"The original had thirteen; the ones kept here are the three
  that were actually named"* (`theme.go:13-17`). `docs/TUI-design.md:1937-1942` — the Go-side spec —
  still says **"13 套，默认 ⑥ 石墨琥珀 … 落地的是 13 套"**, so this is a regression against the shipped
  spec, not a documented re-scoping.
* Consequence, all user-visible:
  * `/theme p7`, `/theme 靛`, `/theme 7`, `/theme 墨绿`, `/theme b`, `/theme 9`, `/theme 12`,
    `/theme 透明`, `/theme clear` all answer "unknown theme" + a 3-entry listing
    (`theme.go:247-297`) where Python switched. `test_tui.py:861-912` pins every one of those strings.
  * `/theme` with no argument offers 3 rows instead of 13 (`panels.go:929-940`).
  * `P3-T` / `A-T` (the two shallow clear variants) do not exist, so "only the transcript is
    transparent, the bars stay solid" is unreachable — only the deep variant exists.
  * A session starts on **A-T2** instead of **A** (`model.go:176`, `theme.go:44`), so a user who never
    runs `/theme` is on a different palette than the original's default, and `--theme amber` must be
    typed to get the old one back.

### B2. `A-T2` is hand-written instead of derived, so the "clear variant" invariant is not enforced

* Python: `theme.py:380-452` (`_transparent(base, *, …, clear_roles=…)` copies all ten tokens from
  `base` and only substitutes `ansi_default` for the declared roles; `A-T2` is built as
  `_transparent(_transparent(_PALETTES[5]), key="A-T2", clear_roles=("chrome","surface"))`),
  with the invariant pinned by `test_tui.py:727-814`
* Go: `theme.go:186-194` (a literal `deepClearPalette` with `bg/chrome/surface = ansiDefault`) plus
  `theme.go:149-151` + `theme.go:171-176` (`originalBgOf` special-cases the deep variant and returns
  the literal `"#131210"` with the comment *"A 的 bg，见 ambersPalette"*)
* Evidence: Go's `structure_test.go:62-67` only asserts that `rail`/`sunk` happen to equal the amber
  palette's — there is no base object to compare against, so the "differs only in the cleared roles"
  property is maintained by hand.
* Consequence: no visible defect today (the literals agree), but the documented derivation rule is not
  what Go implements, and B1 means there is no source palette left to derive from.

---

# MAJOR

### M1. A turn's answer is no longer part of its turn

* Python: `app.py:1271-1273` (`streamed_answer` → `_say_answer`), `widgets.py:662-672`
  (`TurnBlock.add_answer`), `view_state.py:1536-1549` (`answer_body`: *"按 run_id 记下来 ——
  它和 `event` 那条 `run_finished` 是两条消息，**顺序不保证**，所以不许靠到达顺序配对"*)
* Go: `model.go:825-845` (`case protocol.UIRunFinished: … m.appendAnswer(answer)`),
  `model.go:1002-1004` (`appendAnswer` inserts a standalone `entry{kind:"assistant"}`),
  `view.go:357-367` (that entry renders with its own `│ ` bar, outside any turn)
* Evidence: the protocol states the two messages may arrive in either order
  (`tudouni-ai/agent_runtime/protocol/schema/outbound.schema.json:139`,
  `protocol/state.py:173-179`). Python attaches the answer to the turn **by `run_id`**; Go appends a
  transcript entry in arrival order.
* Consequence: an answer is drawn after every turn that started later if the `ui` message is delayed,
  and even in the normal order it is a sibling of the turn block rather than inside it, so the turn
  header ("… · Answered") no longer owns the answer it summarises.

### M2. The rail's auto-open is suppressed by `railPinned` (decision 26 is not implemented)

* Python: `view_state.py:2121-2159` (`should_auto_open`: *"从无到有 → 顶开一次。**不管之前手动收起过没有**"*)
  driven from `app.py:840`; pinned by `test_tui.py:639-670`
  (`state.rail_pinned = True; state.todos = [...]` → `True`)
* Go: `model.go:669-684` (`if !m.railTodosSeen { m.railTodosSeen = true; if !m.railPinned { m.railHidden = false } }`)
* Evidence: Go's comment restates the original's rationale but inverts the outcome; `keys.go:62-69`
  sets `railPinned = true` on the first `Ctrl+B`, and `resetForSession` (`model.go:504-505`) is the only
  thing that clears it.
* Consequence: a user who folds the rail once never sees the agent's task list open itself again —
  exactly the "a new task list is a new event" behaviour decision 26 exists to provide.

### M3. `/thinking` accepts eleven word forms where the original accepts two

* Python: `app.py:1662-1683` (`word = rest.strip().lower(); if word not in ("on", "off"): say unknown`;
  docstring: *"带参数时**只认字面的 `on` / `off`**（不认 `开` / `关` / `true`）… 界面只发协议认的两个字面量"*);
  pinned by `test_tui_commands.py:704-712`
* Go: `keys.go:311-326` → `state.ResolveThinking` (`internal/state/reasoning.go:38-47`):
  `thinkingOnWords = {"on","开","true","yes","1","enabled"}`,
  `OffAliases = {"none","off","disabled","false","no"}`
* Consequence: `/thinking 开`, `/thinking yes`, `/thinking 1`, `/thinking false` now send a
  `set_thinking` request from the TUI. The original refused them there on purpose, so that the TUI and
  the CLI could not drift about which spellings count; that guarantee is gone.

### M4. `/quiet` is case-sensitive where the original is not

* Python: `app.py:1929-1934` (`word = rest.strip().lower()` then `on`/`off`)
* Go: `keys.go:402-414` (`switch arguments[0] { case "on": … case "off": … default: warn }` on the raw argument)
* Consequence: `/quiet OFF` prints the "unrecognised" warning and does not toggle, while `/quiet Off`
  in Python turns quiet off. The two front ends disagree about the same input.

### M5. `/mcp <bad syntax>` no longer opens the panel

* Python: `app.py:1977-1982` (`self._say(i18n.t("cmd.mcp.unknown", rest=rest)); self.push_screen(widgets.McpPanel(...))`
  — *"认不出来就说认不出来，然后**打开面板** —— 那是'下一步该干什么'最省事的回答"*)
* Go: `keys.go:368-389` — the wrong-action branch only appends the warning line: no
  `m.overlay = overlay{kind: overlayMCP…}`, no `m.client.MCP("list", nil)`. The
  `len(arguments) == 1` case (`/mcp load`, name missing) falls into the same branch (`>= 2` is false)
  and likewise opens nothing.
* Consequence: after a typo the user gets one line of text and no way forward, where the original left
  them standing in the panel.

### M6. The `/model` picker lost the label, the summary, the window placement and the alias list

* Python: `view_state.py:2798-2841` (`model_option`: `mark = "●" if item.get("current")`,
  `name = f"{provider}/{id}"`, then `item["summary"]` and `label` + `i18n.t("model.window", …)` in the
  detail tail), `view_state.py:2853-2897` (`render_models` also prints `model.aliases` rows)
* Go: `keys.go:840-864` (`modelOptions`: `row: name` only; `note = windowText(window) + "  " + picker.current`)
  and `keys.go:586-596` / `panels.go:666-700` for the rendering
* Evidence: the `●` still appears (through `note == i18n.T("picker.current")`, `panels.go:673`), but the
  row text carries no `label` and no `summary`; `test_tui_commands.py:235-278` pins the full row shape,
  including two routes serving the **same** model id being distinguishable and the separate
  "recognised old names" list. Grep for `model_aliases` in Go: only the field (`model.go:99`-adjacent,
  `keys.go:855` compares the current name) — nothing renders it.
* Consequence: the picker no longer says what a model is for; two routes offering the same id are
  distinguished only by the prefix; aliased/retired names are invisible.

### M7. `/effort` and `/model` text fallbacks are reduced to one line

* Python: `view_state.py:2900-2945` (`render_thinking` / `render_effort`: current value **plus** the
  available list, the per-level rows, the "how to use" line, `effort.no_catalog`, and `effort.off_note`
  when thinking is off), `view_state.py:2853-2897` (`render_models`: current, `list.available`, one row
  per model, the aliases, `model.howto`)
* Go: `keys.go:294-309` (`/model` fallback: one `model.current` line + `model.howto`) and
  `keys.go:328-339` (`/effort` fallback: one `effort.current` line). `model.no_catalog`,
  `model.aliases`, `list.available`, `effort.no_catalog`, `effort.off_note` all exist in
  `internal/i18n/en.go` (lines 385-387 and neighbours) and nothing reads them.
* Consequence: on a runtime that does not send `model_catalog` / `effort_levels` — the only case the
  fallback exists for — `/model` and `/effort` no longer tell the user what can be chosen.

### M8. The status bar's booting spinner does not spin

* Python: `app.py:309-310` (`spinner_on = (state.quiet or state.booting) and now is not None and not waiting`)
  + `view_state.py:707-712` (`return f"{spin} {i18n.t(key)}".strip()`); pinned by
  `test_tui_boot.py:85-101` (`assert any(frame in line for frame in view_state.SPINNER_FRAMES)`)
* Go: `view.go:609-622` (`renderStatusLeft` boot branch: `mark := m.spinnerFrame(); if mark == "" { mark = "·" }`)
  and `model.go:1072-1079` (`spinnerFrame` returns `""` unless `m.busy && m.quiet`)
* Consequence: during the ~2 s before `init` — the window the boot state exists for, per
  `test_tui_boot.py:1-23` ("那 1.9 秒里屏幕上如果没有东西在动，这块画布看起来就是卡死的") — Go draws a
  static `·` where the original animated.

### M9. The quiet-mode spinner keeps running while an approval/question panel waits for a human

* Python: `app.py:1014` (`spin = "" if self._waiting_for_human() else view_state.spinner_frame(time.monotonic())`)
  + `app.py:304-310` (`waiting = rest[0]`) + `app.py:880-888` (`_waiting_for_human`); pinned by
  `test_tui_quiet.py:382-415`
* Go: `model.go:1072-1079` (`spinnerFrame` depends only on `m.busy && m.quiet`); `view.go:624-626` uses
  it for the status mark and `view.go:430` for the folded thinking line. `handlePermissionKey`
  (`keys.go:898-935`) and `handleQuestionKey` (`keys.go:946-1006`) never touch `spinning`, and no
  `waitingForHuman`-equivalent exists (the only reads of `pendingPermission` outside the dialogs are
  `keys.go:28` and `view.go:228`).
* Consequence: while the approval dialog is up — i.e. while the agent is stopped — the status mark and
  the thinking line keep animating, saying "it is still working".

### M10. The collapsed-rail summary cannot report the autopilot state

* Python: `view_state.py:2088-2118` builds the summary from `rail.summary.expand`, jobs /
  jobs_collected, mounted MCP, todos, skills and the permission half; the autopilot cell is the status
  bar's (`status.autopilot.*`, pinned by `test_tui.py:158-171`)
* Go: `view.go:171-200` (`renderRailSummary`) — the expand / jobs / jobs_collected / mcp / tasks /
  skills / asking / all_auto segments are all present (`internal/i18n/en.go:282-292`,
  `en.go:205`), but **no `status.autopilot.*` segment is in the summary path**; `view.go:659-674`
  (`autopilotBadge`) is called only from `renderStatusBar` (`view.go:484`), and no
  `rail.summary.autopilot*` key exists in the catalogue.
* Consequence: the summary line is defined as "say what collapsing hid". One of the things it hides in
  Python — "will it ask me next" — is not said. (The jobs half is at parity: both print the
  all-collected wording, `view.go:175-181` ↔ `view_state.py:2098-2099`.)

---

# MINOR

### m1. `1.0M` instead of `1M`

* Python: `view_state.py:248-265` (`_trim`: *"整数不写小数点 … `1.0M` 和 `1M` 说的是同一件事"*),
  pinned by `test_tui.py:235` (`assert "14.1k / 1M" in right`)
* Go: `internal/state/status.go:108-121` (`TokensText` → `strconv.FormatFloat(…, 'f', 1, 64) + "M"`,
  no integer trimming); the same function feeds the status bar (`view.go:699-709`), the rail
  (`rail.go:194-200`) and the model picker (`keys.go:859`).
* Consequence: every 1M-window reading is one character wider than the original's.

### m2. `Ctrl+B` (rail) is dead while an overlay is open

* Python: `BINDINGS` binds `ctrl+b` at `App` level (`app.py:494`), so it fires regardless of the screen
  pushed on top.
* Go: `keys.go:34-36` routes every key to `handleOverlayKey` when `m.overlay.kind != overlayNone`, and
  `handleOverlayKey` (`keys.go:606-677`) has no `tea.KeyCtrlB` case.
* Consequence: Ctrl+B with the palette/option picker up does nothing; Esc first is required.

### m3. The command palette's row cap is a literal, not derived from the command count

* Python: `app.py:78-87` (`_PALETTE_MAX_ROWS = len(view_state.COMMANDS) + 3 + 1`, substituted into the
  CSS at `app.py:484-486`) with the regression test `test_tui_palette.py:31-78` (the bug this constant
  exists to prevent).
* Go: `panels.go:72` (`const maxOverlayRows = 18`) + `windowRows` (`panels.go:564-576`) +
  `view.go:234-236` (`lipgloss.Place(m.width, available, …)`, `available` =
  `height - bars - input`, floored at 3).
* Consequence: 18 is enough for today's 17 commands, but the panel is placed inside the body height;
  on a terminal short enough that `available < 26` the "↑ N more / ↓ N more" markers appear and some
  commands are no longer on screen — the silent-drop failure the Python constant was derived to make
  impossible.

### m4. `Esc` semantics — checked, parity

* Python: `app.py:2176-2198`; Go: `keys.go:47-60`, `keys.go:609-615`, `keys.go:916-917`.
  No divergence found.

### m5. `/help` layout; the `↑ ↓` key hint is gone

* Python: `app.py:2109-2134` — the command column is `view_state.COMMAND_NAME_WIDTH` (longest name + 3,
  shared with the palette), the `detail` is printed on its **own indented line**, and the key section
  is `[*widgets.hint_keys(), *widgets.extra_hint_keys()]` = 7 keys + `Shift+Enter` + `↑ ↓`
  (`widgets.py:357-372`), pinned by `test_tui.py:1737-1749`.
* Go: `keys.go:460-497` — detail appended to the same row as `"  —  "`, two independent column widths
  (`%-*s` from the longest name at `keys.go:464-472`; `%-11s` for keys at `keys.go:485`), and the key
  list is `append(hintPairs(false), hintPairs(true)[:2]...)` — i.e. the **narrow** pairs' first two.
  `hint.arrows` (`internal/i18n/en.go:437`) is rendered nowhere in the binary, and
  `hint.shift_enter` is not shown either (Go substitutes a `Ctrl+J` row at `keys.go:489-491`).

### m6. `Shift+Enter` for a newline is replaced by `Ctrl+J` / `Alt+Enter`

* Python: `widgets.py:357-372` (`HINT_KEYS_EXTRA_KEYS` carries `("Shift+Enter", "hint.shift_enter")`)
  and `test_tui.py:1536-1561` (`await pilot.press("shift+enter")`).
* Go: `keys.go:147-160` (`tea.KeyCtrlJ` inserts `"\n"`; `KeyEnter` with `Alt` inserts `"\n"`) with an
  explicit justification comment about Bubble Tea v1 not requesting the kitty keyboard protocol; the
  hint copy is changed accordingly (`internal/i18n/en.go:436`, `en.go:519`).
* Consequence: justified by a library limitation, but a documented, tested key is gone.

### m7. `/new` prints the session switch twice

* Python: `app.py:2021-2033` (`switch_session` says `switch.to_session` / `switch.new_session` once).
* Go: `keys.go:250-255` emits `i18n.T("switch.new_session")` immediately, and `model.go:344-346`
  emits `i18n.T("init.session_id", … state, stateSuffix(payload))` when the new `init` arrives
  (`stateSuffix` at `model.go:435-440`).
* Consequence: two near-identical `rule`-role lines where the original prints one.

### m8. `/model <unknown>` sends without a local list — parity with Python

* Python: `app.py:1744-1746`; Go: `keys.go:306-309`. `test_tui_commands.py:341-376` asserts the name is
  sent and the runtime's notice answers. Recorded because `/theme <unknown>` behaves the other way in
  both (`keys.go:350-353` prints the listing beside the error; `app.py:2065-2068` prints the message).
  **Not a gap.**

### m9. `Ctrl+K` on an empty input does not insert the `/`

* Python: `app.py:1496-1498` (`if not field.text: field.insert("/")`); pinned by
  `test_tui.py:1565-1601` (`assert field.text == "/"` and `field.cursor_location == (0, 1)`).
* Go: `keys.go:71-75` → `openCommandPalette()` (`keys.go:534-537`) sets the overlay only; `m.input`
  stays empty and `paletteQuery` (`panels.go:639-649`) returns `""`, so the same full list is shown.
* Consequence: the list matches, but the input line stays blank instead of showing where the command
  goes. The moment a letter is typed the two behave identically.

### m10. The session list is re-requested on every non-resumed `init`

* Python: `app.py:1384-1394` (`_ask_for_recent_sessions`: `if self._client is None or self._sessions_requested: return`)
* Go: `model.go:371-373` (`if !m.resumed && m.client != nil { m.client.ListSessions() }` — no once-only guard)
* Consequence: after `/new` in a workspace with hundreds of session files, the runtime re-reads the
  directory on every switch.

### m11. The thinking body is not newline-flattened on the final render

* Python: `view_state.py:1105-1114` (`thinking_body`: `flat = stream_chunk_text("think", text)`; the
  docstring records the "one word per line" symptom that made this necessary) and
  `test_tui.py:1275-1303` (`thinking_body("The\n user\n says\n") == ["  │ The user says"]`).
* Go: `transcript.go:487-505` (`thinkingBody` iterates `strings.Split(strings.TrimRight(text,"\n"), "\n")`
  and draws one quoted row per source line). Flattening happens only on the *live* path, and only in the
  sense of appending raw delta text (`model.go:808-812`), which is then drawn through the same
  `thinkingBody` (`view.go:422`, `view.go:436`).
* Consequence: when a provider emits reasoning containing newlines, both the Ctrl+T expanded block and
  the live streaming block print one word per line — the exact symptom the Python function exists to
  prevent.

### m12. `(*model).renderStatus` is dead code with a divergent string

* Go: `model.go:963-986` defines it with a hard-coded
  `"%v runs · %v model calls · %v tool calls"` that bypasses i18n. Nothing calls it: the `/status`
  reply goes `model.go:862-863` → `status.go:43`.
* Consequence: none at runtime; it is a second, older definition of the `/status` block one call away
  from being used by mistake.

### m13. An unmatched palette filter swallows Enter

* Python: `app.py:1529-1538` — when the palette is visible but `selected` is `None`, the text falls
  through to `_handle_slash`, which runs `/zz` and prints "unknown command".
* Go: `keys.go:714-720` (`if m.overlay.cursor >= len(rows) { return m, nil }` in `commitOverlay`) —
  with zero filtered rows the input is neither cleared nor executed, and `keys.go:719` also guards the
  index.
* Consequence: after `/zzz` + Enter nothing happens at all (the line stays on screen); the original
  answers "unrecognised command" and lists them.

### m14. The `/resume` picker never shows the todo suffix

* Python: `view_state.py:2948-2974` (`session_row`: `todos = str(item.get("todos") or "")`, then
  `i18n.t("session.row.todos", todos=todos) if todos else ""` — the field is the pre-rendered string
  the runtime sends; `test_session_list.py:154` and `test_session_list.py:146` assert exactly that).
* Go: `keys.go:590-592` — `if todos := intOf(row["todos"]); todos > 0 { line += i18n.T("session.row.todos", "todos", todos) }`.
  `intOf` → `asInt` (`model.go:1224-1227`, `transcript.go:643-654`) accepts only `int/int64/float64`,
  so a string field yields `0,false` and the branch is never taken.
* Consequence: "which session still has work in it" — the stated reason that field exists — is
  unanswerable in the Go `/resume` panel.

### m15. `/help` and the palette compute the command column independently

* Python: `view_state.py:2278` (`COMMAND_NAME_WIDTH = max(len(name)) + 3`) consumed by both
  `app.py:2114-2118` (help) and the palette.
* Go: `panels.go:595-600` (`nameWidth = max(len(name))`, then `"  %-*s  "` — two extra spaces) and
  `keys.go:464-472` (`%-*s`, no gap). Two separate computations.
* Consequence: cosmetic today; a shared constant is what keeps the two columns from drifting.

### m16. A missing duration renders `0ms` instead of `—`

* Python: `view_state.py:268-271` (`if ms is None: return "—"`), used by `_tool_result_line`
  (`view_state.py:1393`) and the model line.
* Go: `transcript.go:664-673` (`if !ok || ms <= 0 { return "0ms" }`), used by `toolResultLine`
  (`transcript.go:202`) and `toolBriefDoneLine` (`transcript.go:242`).
* Consequence: a result event that carried no `duration_ms` prints "0ms" — a measurement that was never
  taken — where the original prints the em dash.

### m17. `/thinking` with no argument reports one line instead of three

* Python: `view_state.py:2900-2920` (`render_thinking`: the current state, then `thinking.effort`
  — *"关着时**顺便说清强度还在**"* — then `thinking.howto`), called from `app.py:1675`.
* Go: `keys.go:312-317` prints only the `thinking.mode` line. `thinking.effort` and `thinking.howto`
  exist in `internal/i18n/en.go` and are read nowhere.
* Consequence: after `/thinking off`, the answer to "did I lose the effort level I set?" is no longer
  on screen.

### m18. `init.provider` is never read

* Python: `app.py:1109-1110` (`state.model = …; state.provider = message.get("provider", "")`), and the
  runtime always sends it (`tudouni-ai/agent_runtime/protocol/channels.py:1182`)
* Go: the `OutInit` branch (`model.go:300-331`) reads `model`, `context_tokens`, `thinking`, `effort`,
  `audit_path`, `autopilot`, `max_steps`, `tools`, `model_catalog`, `effort_levels`, `resumed`,
  `session_id` — no `provider`; `panelstate` (`model.go:32-63`) has no provider field.
* Consequence: nothing in the Go TUI can name the route a request goes to (only `/status` can, from its
  own payload at `status.go:85-93`). The session bar and the model picker cannot distinguish two routes
  serving the same model id.

### m19. The session picker's rows were reformatted

* Python: `view_state.py:2948-2974` — one `i18n.t("session.row", mark=…, name=f"{name:<22}", messages=…, steps=…, preview=…, todos=…)`
  template owns the whole row, so the column widths and the `● ` current-session mark come from the
  catalogue.
* Go: `keys.go:586-593` builds `fmt.Sprintf("%-22s %s · %s   %s", …)` inline and then prefixes the
  mark through `currentRow` (`panels.go:825`). The separators (`·`) and the gap are Go literals rather
  than the template.
* Consequence: cosmetic; the row still carries id / messages / steps / preview.

---

# Verified equivalent (checked, found at parity)

* **Command catalogue**: same 17 names, same order, plus `/exit` + `/quit`
  (`view_state.py:2225-2267` ↔ `commands.go:26-48`); unknown command appends the same
  "unknown + list" composition (`app.py:1602` ↔ `keys.go:447-450`).
* **Prefix-only palette filtering, case-insensitive** (`view_state.py:2977-2986` ↔ `commands.go:69-78`;
  `structure_test.go:238-253`).
* **Palette-as-input-line**: the filter reads the live input, Enter carries the argument, `/re` narrows
  (`app.py:1529-1538` ↔ `panels.go:628-658`, `keys.go:714-731`).
* **Option-picker semantics**: `/theme` picks and closes; `/model` picks and closes too (Go 4.1.1 — a
  deliberate departure, listed below); `/effort` stays open until the runtime's notice arrives and
  prints that sentence verbatim (`app.py:1822-1877` ↔ `keys.go:733-757`, `keys.go:822-833`); `/model`
  starts on current + 1, `/effort` and `/theme` on current (`app.py:1838-1844` ↔ `keys.go:539-568`); a
  live snapshot re-derives the rows of the panel that is still waiting
  (`app.py:1802-1820` ↔ `keys.go:800-812`).
* **Approval dialog**: conditional `t`/`a` buttons and hint lines, arguments printed whole and sorted,
  `Esc` denies, only the runtime's own `remember_hint` / `trust_all_hint` text is shown
  (`app.py:1398-1413`, `widgets.py:2009-2154` ↔ `view.go:823-945`, `keys.go:898-935`);
  the log line is written before the modal in both.
* **ask_user dialog**: `↑↓` + digits + Enter takes the highlight, `Esc` skips, a typed line wins over
  the highlight (`widgets.py:2154-2304` ↔ `view.go:978-1035`, `keys.go:946-1006`).
* **`/resume` panel**: opens empty and fills from the `sessions` reply, Enter switches, Esc does
  nothing, the current session is marked (`app.py:2001-2044` ↔ `keys.go:257-273`, `keys.go:570-597`,
  `panels.go:815-838`) — except m14.
* **`/mcp` panel**: `↑↓`, Enter *and* Space toggle, Esc only closes, the action comes from
  `state == "loaded"` (so `failed` retries as load), the panel survives the reply and clears its
  "waiting" line, the rail lists only `loaded` with an `n / m` badge
  (`app.py:1958-1999`, `widgets.py:2712-2886` ↔ `keys.go:368-389`, `keys.go:760-773`,
  `panels.go:714-748`, `rail.go:404-451`).
* **`/skills` panel** opens on `Ctrl+S` and `/skills`; any key closes it
  (`app.py:2172-2174` ↔ `keys.go:77-83`, `keys.go:391-394`, `panels.go:846-922`).
* **Tool lines**: `→ [n] tool(args)` with a colour-only risk suffix, `← [n] ✓ 8,412 chars 41ms`,
  `denied`/`invalid_args` distinguished from errors, a refusal gets its own extra row
  (`view_state.py:1170-1220`, `1379-1394` ↔ `transcript.go:165-210`, `model.go:624-629`).
* **Quiet mode**: one line per call (`→ [tool] brief`) anchored by `call_id`, the result tail appended
  prefix-free, replays guarded against double-append, the four silent permission outcomes dropped while
  the four real outcomes stay, automatic permissions judged on `outcome` only
  (`view_state.py:1331-1376`, `1397-1440` ↔ `transcript.go:212-276`, `model.go:606-641`).
* **Brief extraction**: per-tool key table, fallback key order, literal `"key": "value"` scan for
  truncated payloads, list → "N tasks", bool → yes/no, 60-cell clip
  (`view_state.py:1193-1313` ↔ `brief.go` + `transcript.go:713-821`).
* **Turn block**: header rewritten from "running" to "N steps · 4.2s · Answered", duration frozen from
  the event, every stop reason distinguishable, `max_steps`/`cancelled` extra warning lines
  (`view_state.py:997-1024`, `1443-1466` ↔ `transcript.go:341-359`, `model.go:695-720`).
* **The user line is drawn once**, inside the turn block, when `run_started` arrives — `submit` appends
  no flat-log echo (`view_state.py:919-923`, `app.py:1517-1543` ↔ `view.go:418-426`, `keys.go:222-247`);
  restored history draws the content with no `> ` marker (`app.py:1195-1198` ↔ `model.go:1005-1013`).
* **Thinking**: folded by default with a frontend-computed character count, `Ctrl+T` toggles, the
  expanded head quotes the block (`view_state.py:1044-1114` ↔ `transcript.go:400-436`, `view.go:418-438`).
* **Streaming**: plain text while streaming, markdown once finished, the live copy removed before the
  final answer is drawn, `delta_reset` drops the half-written block
  (`view_state.py:1610-1723` ↔ `model.go:792-813`, `model.go:825-845`, `view.go:368-379`).
* **Welcome screen**: two equal-height titled boxes plus a full-width key box, the `▄▀█` logo, the
  version, `model · workspace`, recent sessions by `modified_at` with "how long ago" and the preview
  title, a placeholder row when empty, the banner pinned to the top
  (`widgets.py:1059-1257` ↔ `panels.go:74-373`).
* **Rail contents**: six blocks in the fixed order, a colour bar per block, the task progress bar (one
  cell per task, `+N` past 20), loaded-skills-only counting with a literal `0`, three risk rows with
  only medium/high coloured, granted/prefix/denied rows, session id + model + window + thinking-off row
  + size + context + audit dir + AGENT.md rows with `!`/`…`
  (`view_state.py:1780-2085` ↔ `rail.go`, `view.go:157-255`).
* **Narrow degradation**: the session bar drops model/steps/permission chip below 120 columns, the rail
  summary is one clipped line, the rail is dropped below 100 columns, the top bar's right half is
  dropped below 120 (`view_state.py:70-71`, `widgets.py:204-269` ↔ `view.go:24`, `view.go:92-200`).
* **Status bar fields and semantics**: phase mark and colour, activity from the runtime, settled
  wording, idle vs "nothing said yet", `step n / N`, autopilot badge in both states (short form when
  narrow), quiet chip only when on, jobs badge (absent / collected / running / +uncollected in warn),
  context used/window/percent with no denominator when the window is unknown, cache hit, frozen turn
  duration, session span, short audit path, and the ordering of the right-hand segments
  (`view_state.py:683-863` ↔ `view.go:479-788`).
* **Startup notices**: `permissions`/`skills`/`todos`/`model` suppressed as redundant with the rail,
  everything else printed verbatim with the runtime's own wording and the `warn` role
  (`view_state.py:1468-1491` ↔ `model.go:344-361`, `model.go:457-463`).
* **`/status` rows and units**: same rows, same order, same "no state yet" escape, `@provider`,
  endpoint only when non-default, thinking-off does not print effort, the artifacts/budget ledger, the
  totals with the cache rate, runs / model calls / tool calls with waits and asks, run flags, tool
  count, audit path (`view_state.py:2345-2513` ↔ `status.go:43-198`).
* **`/tools`**: every tool listed, disposition column painted by the policy, `granted`/`external`/
  `interactive`/`parallel` marks, the prefix-rule paragraph, the footer, the "nothing registered"
  warning (`view_state.py:2521-2584` ↔ `status.go:206-270`).
* **`/context` and `/compact`**: both render through the shared `internal/frontends` package with the
  same fields, the same "not compacted says so" branch and the same five compaction outcomes, and
  `/compact` prints the ledger immediately after the sentence
  (`view_state.py:2663-2776`, `app.py:1299-1312` ↔ `frontends/report.go:31-135`, `model.go:868-887`).
* **`/mcp` trace lines**: the running/total summary plus the runtime's own sentences verbatim, the
  "not connected" text promoted to warn, nothing drawn for an empty snapshot
  (`view_state.py:2624-2658` ↔ `model.go:1092-1121`).
* **`/audit`, `/autopilot`, `/theme <name>` echo**: same messages, and `/autopilot` is never optimistic
  (`autopilotWanted` compared against the snapshot: `app.py:1879-1904`, `1336-1354` ↔ `keys.go:360-366`,
  `model.go:890-910`).
* **Session switching**: the screen is cleared only on the new `init`, the model catalogue survives the
  switch, `/resume <id>` is not validated locally (`app.py:2021-2033`, `1094-1107` ↔ `keys.go:250-273`,
  `model.go:332-341`, `model.go:485-512`, `structure_test.go:209-232`).
* **Theme derivation rules**: the same three blend rules and the same rounding (half-to-even), with
  goldens (`theme.py:227-245` ↔ `theme.go:147-168`, `structure_test.go:25-68`).
* **Theme resolution semantics**: key / ordinal / name fragment, hyphen-insensitive keys,
  "starts-with wins, then shorter, then display order", longer-than-name fragments rejected
  (`theme.py:470-529` ↔ `theme.go:247-297`, `transcript_test.go:56-79`) — modulo the missing palettes.
* **Transparent variants**: the `ansi_default` sentinel is honoured all the way to the renderer; ink on
  an accent background is always set (`theme.go:50`, `view.go:76-81`, `view.go:248-259`,
  `panels.go:554-559`, `panel_layout_test.go:212-225`).
* **Input editor**: caret, wrapping to two rows, Up/Down caret-then-transcript, Ctrl+Left/Right word
  movement, Home/End/Ctrl+A/Ctrl+E, Ctrl+W, Ctrl+U, Delete, paste as one chunk
  (`input.go` ↔ `app.py`/`widgets.py` PromptArea, `test_tui.py:1604-1646`).
* **Wrapping**: cell-accurate with CJK double width, breaks on spaces, ANSI-aware, multi-line reports
  counted per row (`view.go:1099-1215` ↔ `view_state.py` `cell_len`).

---

## Deliberate departures (decided, not gaps)

* **The rail is docked right.** The original puts the context column on the left
  (`app.py` CSS `#rail` with its `border-right`, and the `Horizontal` at
  `app.py:639-641` yields rail-then-log); Go joins transcript-then-rail
  (`view.go:305-328`). Requested by the user: the conversation owns the left margin.
  Everything else about the rail — 32 cells, the six blocks in order, the
  `width < 100` drop rule, the collapsed one-line summary — is unchanged.
* **The `/model` picker closes on pick (4.1.1).** The original keeps the panel up until the runtime's
  notice arrives, and draws that sentence under the list (`app.py:1822-1877`;
  `docs/TUI-design.md` §18.2, "选完之后：不关"). The notice is appended to the log in **both** versions,
  so the panel was covering the one line that answers "did it switch" with a copy of itself on top of
  it, and the next keystroke had to be `Esc`. Requested by the user. Changing the model is also the
  one pick whose rows come from the runtime, and `/model <name>` — the typed form of the same
  command — never had a panel to hold the answer in the first place.
  `/effort` and the MCP panel keep the waiting behaviour
  (`keys.go` `commitOverlay` / `settleOverlay`, pinned by
  `picker_test.go:TestEnterOnAModelRowClosesThePicker`).

---

## Quick severity index

| # | Severity | One line |
|---|---|---|
| B1 | BLOCKER | 10 of 13 palettes missing; default palette changed A → A-T2 |
| B2 | BLOCKER | `A-T2` hand-written instead of derived; `P3-T`/`A-T` absent |
| M1 | MAJOR | Turn answers no longer attached to their turn |
| M2 | MAJOR | Rail auto-open suppressed by `railPinned` (decision 26 broken) |
| M3 | MAJOR | `/thinking` accepts 11 spellings instead of `on`/`off` |
| M4 | MAJOR | `/quiet` is case-sensitive |
| M5 | MAJOR | `/mcp <bad syntax>` no longer opens the panel |
| M6 | MAJOR | `/model` picker lost label / summary / alias detail |
| M7 | MAJOR | `/model` + `/effort` text fallbacks reduced to one line |
| M8 | MAJOR | No spinner during the boot window |
| M9 | MAJOR | Spinner keeps running while waiting for a human |
| M10 | MAJOR | No autopilot segment in the collapsed-rail summary |
| m1 | MINOR | `1.0M` instead of `1M` |
| m2 | MINOR | `Ctrl+B` dead while an overlay is open |
| m3 | MINOR | Palette row cap is a literal, not derived |
| m5 | MINOR | `/help` layout; the `↑ ↓` key hint is gone |
| m6 | MINOR | `Shift+Enter` replaced by `Ctrl+J` / `Alt+Enter` |
| m7 | MINOR | `/new` prints the session switch twice |
| m9 | MINOR | `Ctrl+K` does not insert `/` into an empty input |
| m10 | MINOR | Session list re-requested after every `/new` |
| m11 | MINOR | Thinking body not newline-flattened on the final render |
| m12 | MINOR | Dead `renderStatus` with a divergent string |
| m13 | MINOR | Unmatched palette filter swallows Enter |
| m14 | MINOR | `/resume` rows never show the todo suffix (string read as int) |
| m15 | MINOR | `/help` and the palette compute the command column independently |
| m16 | MINOR | A missing duration renders `0ms` instead of `—` |
| m17 | MINOR | `/thinking` with no argument lost the effort / how-to lines |
| m18 | MINOR | `init.provider` never read (no route name anywhere) |
| m19 | MINOR | `/resume` row built from Go format literals instead of the template |

## Appendix — interaction inventories

See `tui-parity-inventory.md` for the per-command table, the full key-binding table, the rail's
block-by-block row list, the overlay navigation matrix, and the status-bar field list.
