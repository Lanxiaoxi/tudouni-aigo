# Workbench panels — light v2

`design/workbench-light-v2/` is one foundations sheet plus eleven panel sheets.
This file is the contract those sheets became: which class does what, and which
per-panel decisions the sheets make that a stylesheet cannot.

Read `src/styles/components/workbench.css` beside this. It is loaded last among
the component styles on purpose — it retunes the vocabularies the panels already
had (`.cfg-*`, `.tk-*`, `.pc-*`, `.sp-*`, `.wm-*`, `.hk-*`, `.ci-*`) rather than
adding a sixth one.

## The shell

| region | rule |
| --- | --- |
| width | **two rungs**: `800` for the family (`wb-panel`), `1180` for Configuration and Settings (`wb-wide`). Both are `min(rung, 100vw - 48px)` |
| padding | 28 on all four sides (`--wb-pad`); the head is `24px 28px 4px` |
| head | title 15/600, one-line description 12/400, then at most one secondary action and the close (28×28 ghost) |
| body | the main column, optionally split: `.wb-split` = `minmax(0,1fr) <rail>`, gap `<gap>` |
| rail | `.wb-rail`: facts the runtime computed. Never mixed into the fields. 340 at the wide rung, 232 at the default one |
| footer | `.dialog-foot`: hint at the leading edge, `[Ghost][Primary]` at the trailing one, primary 30 high |

**Why 800 rather than the sheet's 1180.** The sheets draw all eleven panels at
92% of a 1280 window. That is right for the two whose job is a long form beside a
read-out, and too wide for a six-row list or a five-field editor: those read as a
dialog that was stretched rather than as a page. So the family's default is 800
and `wb-wide` is the opt-in. The rail scales with the rung (340 → 232) rather
than staying fixed, because 340 of a 800px panel is a different proportion and
would leave the main column 480.

**The narrowing is verified, not assumed.** Three scripts measure it, because a
resize fails in ways a screenshot does not show:

```
node scripts/probe-width.mjs 9333 http://127.0.0.1:5178/ 1280 800   # rung + columns + overflow
node scripts/probe-pages.mjs 9333 http://127.0.0.1:5178/ 1280 800   # the second surfaces
node scripts/probe-rail.mjs  9333 http://127.0.0.1:5178/ 1280 800   # clipped rail labels
```

`probe-pages.mjs` is what caught the one real regression in the narrowing: the
task editor's name/description row is 1:2, which at the narrow rung is 155px for
a name field. It is a **container query** on the main column now, so the pair
stacks at any width where the ratio stops being legible — a media query would be
right at one window size and wrong at every other.

`PanelShell` takes `rail` (the right column), `footHint` (the leading sentence)
and `footer` (the actions). A panel's **second surface** passes `onBack` — the
shell then draws the design's `← Routes` row above the title with the close at
the far end of that row.

## Type

Five rungs, one writing each. Nothing else may be added.

| rung | where | class |
| --- | --- | --- |
| panel title 15/600 | the head | `.dialog-title` |
| section label 11/600 · uppercase · +0.02em | above a card, above a group | `.wb-label` (also `.tk-section-label`, `.pc-section-label`, `.sp-section-label`, `.pc-side-label`, `.sp-side-label`) |
| field label 12/500 | above its control | `.cfg-label` |
| help text 12/400, one shade down | under a control, under a row's title | `.cfg-hint`, `.wb-row-hint` |
| value 12.5 mono | every path, number and yes/no in a read-out | `.wb-value` |

A section label is the **only** uppercase thing in a panel. A count beside it is
`.wb-label-count` (mono 10 on the muted fill), not a sentence.

## Cards and rows

- One card per group: `.wb-card` (border 1px `--border`, radius 10, surface
  `--bg-elevated`). A card whose rows own their padding is `.wb-card-flush`.
- One row of a card: `.wb-row` → `.wb-row-main` (title + hint) and
  `.wb-row-control`. 14px of vertical air, hairline **between** rows only.
- A list is `.tk-list` / `.wb-list`: one card, hairlines between rows, a 56px
  minimum row, and the row's action slot at a fixed width.

## Fields

- `label above, control full width`; the three fixed label widths (96/130/240)
  are gone. `.wb-fields` spaces a column at 20; `.wb-grid` puts them side by side.
- Control: `.cfg-input` / `.cfg-textarea` / the shared `Select` — 28 high, radius
  6, border `--border-strong`, fill `--bg-card` (the well sits *under* the card).
- Errors live in exactly one of two places: `.wb-alert.is-error` above the form,
  or `.cfg-input.is-error` plus one 11px sentence (`.tk-field-error`) under the
  field. Never both.

## Buttons

- Primary is a **flat** `--accent-solid` with a white label — no gradient, no
  glow. One per screen.
- Disabled is a muted fill (`--bg-muted` + `--fg-faint`), **not** half
  transparent.
- Secondary is the bordered one (`btn-outline`, border `--border-strong`).
- Ghost is the footer's secondary action ("Discard changes").
- Destructive is **text only** (`btn-destructive`), at the footer's leading edge.

## Selection

Four shapes, each its own: checkbox, radio, toggle (`.tk-switch`, 32×18), and the
segmented strip the panel tabs use (`.panel-tabs`, `.tk-chips`). A row is tinted
only when the row *is* the choice.

**The tick boxes and radios are `check.css`'s, and they must stay there.** That
file draws them (`appearance: none` plus a `::after` mark) and names the rows they
may live in; `tests/check-style.test.ts` fails if an input appears outside one of
those rows, or if any stylesheet reaches for `accent-color` (which tints the fill
but not the shape). The panels add no selection chrome of their own — the
workspace-learning scope options got a row class of their own
(`learn-scope-row`, added to `check.css` and to that test) rather than a
second look.

## Feedback

`.wb-alert` — a 2px rule at the leading edge and a wash, not a bordered box.
`.is-error` switches it to the destructive pair.

## Empty states

`.list-empty` / `.tk-blank`: one 32px icon (stroke 1.6, `--fg-faint`), one title
13/600, one sentence ≤320px. **No action button** — the primary action lives in
the head, and a second copy here would be two doors to one room.

## Path bar

`.wb-path` (also `.cfg-path-row`): a sunken bar, mono 12.5 path, an icon at the
trailing edge. One way to draw a path, everywhere.

## Panel-by-panel deltas

The sheets disagree with the implementation in a few places. These are the
decisions; everything else in a panel keeps its behaviour.

### 02 Tasks — done

- Toolbar band under the head: filters left, `search · History · New task` right.
- Row meta is `workspace · model` with interpuncts, no icons.
- A disabled template says so in the meta line and keeps a **disabled Run** at
  rest; an enabled one reveals Run on hover.

### 03 New task — done

- Name and description share one row (1:2). Prompt below, full width.
- Rail is `ENVIRONMENT` label, a card of the two pickers, then Autopilot and
  Enabled as rows with the switch at the right.

### 04 Workspace memory

- The rail is **labels outside cards**: `WAITING FOR REVIEW` + count, then a
  bordered card; `ON RECORD` + count, then the tall card. The rail is not one
  tinted column.
- The stepper is one bordered group: `−` / value / `+` inside a single 28px box
  with hairlines, not three separate controls.
- `Relevance floor`'s slider is short (about 120px) beside the row, not the width
  of the card.

### 05 Configuration (routes)

- Segmented tabs at the top: `Routes n · Web search · MCP servers n`.
- Path bar under the tabs.
- Row meta: `url · n models · protocol` with interpuncts, mono for the URL.
- **A right rail**: `PREVIEW` (dot + name + state tag + one line) and
  `READ-OUT · not editable` (base URL, protocol, models, certificate as KV
  rows). The rail describes the row under the cursor / the selected one.
- The "saved now…" sentence moves from the body to the footer's hint.

### 07 Route detail

- `← Routes` row, then the route name in mono with its `default` tag.
- `ROUTE` label; Name and Protocol side by side; Base URL full width; API key
  full width with `Reveal` inside the field; the hint under it.
- `Verify certificate` is a row with the toggle at the right, hint under the
  title. The Base-URL warning is a `.wb-alert`.
- `REASONING` label with the six level chips.
- Rail: `LIVE CHECKS` (KV card), `MODELS · n` (a card of names + `+ n more`).
- Footer: `Delete route` as text at the leading edge; `Cancel` + `Save changes`.

### 10 MCP server detail

- `← MCP servers`, name + `connected` tag.
- `LAUNCH`: name, command, arguments; `ADVANCED`: environment, timeout beside
  the `Session start` switch.
- Rail: `TRANSPORT` (radio card, hint under it), `MEASURED` (KV card),
  `TOOLS · n` (names + `+ n more`).
- Footer: `Remove server` text at the leading edge.

### 11 Web search

- Same shell as the routes list, second tab active. Two fields only, each with a
  hint; the API key has the eye inside the field.
- Rail: `PREVIEW` card, one explanatory paragraph, `READ-OUT · not editable`.

### 06 Settings

- Section label, then a **card** of rows. Two sections are a card each; the
  Stepper is the one-in-a-box shape.
- A footer with the hint and a single `Close` (secondary). No Save: the panel is
  a read-out of what the runtime was started with, plus window preferences that
  apply on change.

### 08 Hook editor

- `← Hooks`, then the hook name.
- A blocking problem is a `.wb-alert.is-error` **above** the fields.
- `WHEN IT RUNS` (name / event / tool), `WHAT IT RUNS` (command, shell
  checkbox, timeout).
- Rail: `AT A GLANCE`, `RECENT` — KV cards.
- Footer hint is the count of problems that must be fixed, in the destructive
  text colour.

### 09 Subagent preset

- `← Subagent presets`, then the preset name. **No rail.**
- `Default preset` select + hint, a rule, `PRESET · n` with the trash at the
  right, then Name / Route / Model / Effort across one row, then `Purpose`.
- Footer hint: `Unsaved changes` in the warning colour.

### 12 Learn this workspace

- `SESSION SCOPE` (three radio rows, the chosen one tinted, its own count at the
  right), `DELIVERABLE TYPES` (one row of checkboxes), `FOCUS (OPTIONAL)`.
- Rail: `THIS RUN` — the workspace path row and two KV rows, then one paragraph.
- Footer: the hint on the left (a blocked Start says why), `Start learning` on
  the right.

### 13 Code intelligence

- `Sync` in the head beside the close. The workspace path is a plain mono line
  under the title, not a path bar.
- `THE INDEX` card, `REPOSITORIES` card of checkboxes, a full-width primary
  `Confirm and lock selection`, then the two secondary buttons and a hint.
- Rail: `PERMISSION` + an `off`/`on` tag, the permission card, `LAST RUN` card.
- No footer.

## What was not followed, and why

The sheets are drawn against a product that knows more than this one does in
three places, and against a data model that is smaller than this one's in others.
The rule applied throughout: **the sheet wins on style, layout and hierarchy; the
real data wins on what exists.** So these are the deliberate gaps.

| sheet says | this app | reason |
| --- | --- | --- |
| Settings' step cap is a `− / +` stepper | one boxed mono field | the field's empty state means "no `--max-steps`", which a stepper has no way to express, and two buttons would be behaviour nobody asked for |
| Route page: `LIVE CHECKS` (reachable / latency) | `READ-OUT` (selectable / base URL / protocol / models / certificate) | nothing in the runtime reports reachability or latency |
| Route page: warning that changing Base URL does not refresh the model list | omitted | there is no model cache; the sentence would state something untrue |
| MCP page: `MEASURED` (status / tools / last start) and `TOOLS · n` | `READ-OUT` | the runtime sends no per-server tool catalogue or start time |
| MCP page: a `connected` tag | the tag slot carries "starts with session" when it does | there is no connection state to report |
| Hooks editor: five fields | the real set (matcher, script picker, fail-closed, output limit, status) | the sheet's field list is a sample; the panel's fields are the ones the file has |
| Configuration: the path bar spans the panel | spans the main column | `PanelShell`'s `rail` makes the whole body the split, and a full-width bar would need a second body above it |
| Code intelligence: locked checkboxes drawn as editable | drawn disabled | the lock is real |
| Subagent presets page: `PRESET · n` | present | the label is `panel.sp.section` with the preset's position |

Copy is the existing catalogue's throughout, even where the sheet's wording
differs (`CONNECTION` for `ROUTE`, `Revert` for `Cancel`, `Save changes` for
`Save`): the sheets are drawings, and re-wording eleven panels' strings was not
what they asked for. The four labels that had no key — `When it runs`, `What it
runs`, `At a glance`, `Recent`, plus `Runs` / `Last` and `Preset` — were added to
`src/i18n/index.ts` rather than left as literals.

## Verifying

The panels can be driven two ways, both with CDP:

```
# against the dev server, with a fixture session (any panel, no runtime needed)
node scripts/panel-shots.mjs .tmp/shots/mine 9333 http://127.0.0.1:5178/ config

# against the running desktop app, with the real runtime and config files
node scripts/app-shots.mjs .tmp/shots/app 9334
```

The design's canvas is **1280×800**, the same window the Tauri config opens at.
The panel inside it is 1180 in the sheets and 800 here for everything but
Configuration and Settings, so a screenshot at that window size is the closest
comparison the sheets allow — see "Why 800" above for the difference.
