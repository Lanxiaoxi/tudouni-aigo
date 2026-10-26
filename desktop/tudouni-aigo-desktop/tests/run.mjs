/**
 * Test runner.
 *
 * The sources use the `@/` alias, which plain `node --test` cannot resolve, so
 * the tests are bundled with esbuild first (the alias is remapped to a relative
 * path) and then run. No extra dependency beyond esbuild, which Vite already
 * brings in.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, '.test-build');

/**
 * Every suite, named **once**.
 *
 * There used to be two lists 鈥?the esbuild entry points, and the files handed to
 * `node --test` 鈥?and only the first was kept up to date. `workspace.test.ts` was
 * therefore bundled and never executed, which is the worst possible failure for a
 * test: the suite reported a green total that silently excluded it, and the
 * assertions were never run at all. Deriving both from one list is what makes
 * that impossible rather than merely unlikely.
 */
const SUITES = [
  'projection.test.ts',
  // The notice center: the unread ledger behind the capsule badge, the store
  // action that moves it, and the fact that the transcript floor no longer
  // draws notes — three rules that are only honest together, and each
  // invisible when wrong on its own.
  'notice-center.test.tsx',
  // The usage heatmap's date math: the 365-day window, the seven-row columns,
  // the quartile ramp and the week buckets. All pure, which is why a midnight
  // or a leap day can be asserted instead of stared at.
  'usage-heatmap.test.ts',
  // The per-model charts' math: the trend's zero-filled window, the
  // largest-single-point scale, the fold past six models, and the donut's
  // shares. Pure like the heatmap's, for the same reason.
  'usage-charts.test.ts',
  // The heatmap's cell geometry, where it is declared: a custom property
  // declared on the grids does not reach the month-label row between them,
  // which is what bunched the month labels at the card's left edge. The
  // stylesheet is read as text, the way stream-layout does.
  'usage-panel-css.test.ts',
  // The factory seam: `createAppStore()` is what makes a second, independent
  // store possible in a test. Two stores, two states — a singleton cannot say
  // that about itself.
  'store-factory.test.ts',
  // The poll loop that keeps a running job's or delegation's `seconds` moving.
  // It used to check the throttle floor where the snapshot lands — a check that
  // can never pass, because the answer lands a few dozen milliseconds after the
  // send — so the loop died after one iteration and a quiet session's rows sat
  // frozen for the work's whole life. The clock is mocked here, because the
  // property being asserted (a landing books, a timer sends, the cadence is the
  // floor, a static situation stops, a change restarts) has no meaning without
  // one.
  'polling.test.ts',
  'contract.test.ts',
  'paste.test.ts',
  'workspace.test.ts',
  // The attach race: a child's opening handshake can be on the wire before the
  // store has built the handle for it, and the layers that hold it only mean
  // something if the bucket is installed before anything is subscribed. It is
  // the "I opened a new session and it never came up" report.
  'attach-race.test.ts',
  // The workspace's capabilities: the keystroke encoder, the terminal output
  // buffer, and the file browser's path arithmetic. All three are pure, which is
  // why they can be asserted without a window or a shell.
  'terminal.test.ts',
  // The stylesheet rule that keeps a long conversation's stream flat. It reads
  // `app.css` as text, because the declaration has no behaviour to observe in
  // Node and what is being protected is its presence 鈥?see the file for why a
  // performance fix is worth a test at all.
  'stream-layout.test.ts',
  // What the conversation column shows, and in what order. A priority order
  // written as a chain of ternaries is exactly the kind of thing that reads as
  // ordinary code while being wrong 鈥?this one hid an attached terminal behind
  // the first screen, which took the composer away with it.
  'conversation-view.test.ts',
  // The welcome motto, which exists twice on purpose (the desktop's catalogue
  // and the runtime's) and therefore has to be compared: a line edited in only
  // one of the two still renders, and the two front ends quietly stop agreeing.
  // The day arithmetic is pinned there too, since a local-midnight or zero-based
  // rotation shows a different maxim on one side for part of every day.
  'motto.test.ts',
  // The left rail's two groups, and what makes its actions inert. This is the
  // "I press New session and nothing happens" report: a session with no file yet
  // was in no list at all, and a panel made the rail unclickable while it still
  // looked available. Both are pure functions, so both are assertable here.
  'rail-groups.test.ts',
  // The two rails' dragged widths: the drag geometry (outward must widen, and
  // the left rail is the right rail's mirror image rather than the same
  // expression), the clamp the store applies, and the stylesheet wiring that
  // carries a dragged value. The sign is the one thing here that is invisible
  // when wrong 鈥?it shipped backwards on the right rail once 鈥?so both
  // directions are asserted rather than checked by eye in a window.
  'rail-drag.test.ts',
  // The turn rail down the transcript's right edge: which marks exist, what they
  // are called, and where each turn begins and ends. Its two rules 鈥?a live turn's
  // prompt sits *above* its head, and a restored transcript has no heads at all 鈥?
  // are both invisible in a rendered string, which is why they are asserted here
  // rather than by looking at the window.
  'turn-rail.test.ts',
  // The stream's step blocks: one panel per model call, prose and thinking kept
  // outside. The partition's rules ride on the wire's own ordering (a step's
  // tool events follow its `model_call` record; a retry is a backoff row, not
  // new work), so a partition that assumed otherwise would look correct on a
  // session that never exercises the case 鈥?which is why the pure function is
  // asserted here, over events shaped like the real audit stream.
  'stream-blocks.test.ts',
  // Folding a turn away. Which rows a turn owns (from its head to the next one,
  // and the prompt above it is *not* one of them), what the folded head says its
  // body is doing, and the fact that a finished turn's duration has to be kept on
  // its own head. All three are rules that a screenshot cannot check: a section
  // that swallowed the next turn's rows, or a head stuck on "thinking" while text
  // streams, looks like a working fold.
  'turn-fold.test.ts',
  // The output rate: the average over one call (completion tokens divided by
  // its duration), and the rule that no measurement is never zero 鈥?a
  // tool-only call reports no completion tokens, and printing `0.0 tok/s`
  // would claim a measurement the ledger does not have. The figure is
  // computed in one place and drawn in three (the model row, the step card's
  // head, the status bar), so the shared half is asserted here.
  'output-rate.test.ts',
  // Whether the start-up arguments the settings panel owns actually reach the
  // child. `--ericai` is the one that matters most: the runtime decides at open
  // whether it manages the session's token, so a flag that never arrives is a
  // session that 401s forever once its token expires 鈥?while the panel says it is
  // in force. This is the "the desktop never refreshes my EricAI token" report.
  'ericai-launch.test.ts',
  // When a session is worth a system notification, and what the window's X button
  // does. Both are rules rather than behaviours: a notification that should not
  // have been sent looks identical on screen to one that should have, and a close
  // policy that forgot a choice simply asks again 鈥?so neither failure is visible
  // in a rendered string, and both have to be asserted here.
  'notify.test.ts',
  // The config panel's two invisible rules: the order of `providers` decides the
  // default route, so a save that re-orders them silently moves every request to
  // another account; and a section that did not change must not be sent, or
  // opening the panel to fix a key would create `mcp.json`. Neither is visible
  // in a rendered string 鈥?the screen looks identical either way.
  'user-config.test.ts',
  // Which config fields wear the required marker, against which ones actually
  // refuse the save. The two are the same list by construction and two lists in
  // two files by accident, which is the drift this pins: a field with the wrong
  // marker still works and still refuses correctly, and only its label is a lie.
  'config-required.test.ts',
  // The workspace-learning task prompt: the scope arithmetic the
  // configuration form previews and the template it splices into the
  // learning session's first message. Both are pure, and both sit on the
  // claim the form shows the person before anything starts.
  'learn.test.ts',
  // Opening a saved remote workspace: a blank binary path means "install it
  // first, then connect", and a failed install must report the install's own
  // reason 鈥?搂8.4's "an install failure must not look like a connection
  // failure", wired into `enterRemoteWorkspace`.
  'remote-workspace.test.ts',
  // Which config-sync question is worth asking (§9.4/§9.5), and which is not.
  // The prompt looks identical whether it was necessary or not, so the report
  // "I rewrote the server five minutes ago and it is asking again" cannot be
  // settled by looking at the dialog — it is settled by these rules: a missing
  // local file is not a change, each side is compared against the value it was
  // last *seen* at (so an answer cannot re-ask the same pair of fingerprints),
  // and two absent files are not a question with two disabled buttons.
  'config-sync.test.ts',
  // "New session" while the conversation on screen is remote: the remote
  // workspace's directory is not a local one, so the button must dial another
  // remote child rather than hand the remote path to the local spawn 鈥?which
  // is what refused it with "the workspace 鈥?is not a directory".
  'remote-new-session.test.ts',
  // Applying the start-up arguments (`--ericai` / `--max-steps`) while a remote
  // session is on screen. The settings panel's "Apply" was the last entry point
  // still handing the remote workspace's path to the **local** spawn — refused
  // on Windows ("the workspace … is not a directory"), and silently a *local*
  // session on a client where that path exists, with the rail and the top bar
  // still reading as the remote workspace.
  'remote-apply-launch.test.ts',
  // Session search on a remote screen. The guard used to test the workspace for
  // `''`, and a remote workspace's path is never empty — so the scan ran against
  // this machine: a false "No session matches" on Windows/macOS, and another
  // project's conversations on a client where the path does exist. The rule is
  // pinned as a property of the bucket (`remoteWorkspaceId`), because the path
  // string cannot tell the two apart.
  'remote-session-search.test.ts',
  // Which **machine** a saved session id belongs to. `openSession` decided
  // remote-vs-local from the screen and then passed the id through, so a
  // notification clicked (or a task run opened) while another conversation was
  // on display sent the id — and, for the notification, the remote path — to the
  // local spawn: a refusal, or a local child "resuming" an id it cannot have,
  // which the runtime reads as a new conversation with that name.
  'remote-session-home.test.ts',
  // Refining a task on a remote screen. The panel used to grey Refine out for
  // every remote workspace, on the theory that the run transcripts were "not on
  // this machine" — true, but beside the point: the refine *child* lives on that
  // host too and reads its own `.tudouni/sessions/`. What was actually broken
  // was the open path, which always called the local spawn with a remote
  // workspace path.
  'remote-refine.test.ts',
  // Which machine the config panel edits. The panel is the last place the two
  // machines' files were indistinguishable: both are `~/.tudouni/config.json`,
  // so a remote screen used to show this machine's routes and write this
  // machine's file while the host's runtime kept reading its own. The store
  // answers "whose file is this" here, because it is the layer that holds the
  // credentials — and the baseline it records afterwards is what stops the next
  // open reporting the person's own edit as somebody else's change.
  'remote-config-target.test.ts',
  // Dropping a file onto a remote session. The path the OS hands over is on
  // **this** machine, so inserting it produced a sentence the far runtime could
  // not resolve — and the notice explaining it ("the model would go through
  // shell") was false, because the far shell cannot see this machine either.
  // The file is uploaded into the workspace instead and the sentence carries the
  // relative path, which is what a pasted picture already did.
  'remote-attach.test.ts',
  // A recorded `remoteBinary` that no longer runs: a host that was reinstalled,
  // or had `~/.tudouni` cleaned, keeps resolving its symlink to a version name,
  // so the install path said "already installed" and the dial failed for ever.
  // The repair is "clear the path and install once" on the front end plus a
  // `test -x` probe on the Rust side — either half alone leaves the row stuck.
  'remote-binary-repair.test.ts',
  // Which place the next launch offers. The start-up reopens a *local*
  // directory by itself, and a remote workspace's directory is on another host —
  // so "last used" needed a second field that holds an entry id rather than a
  // path. The first screen offers it; it does not dial, because a connection on
  // every launch costs a round trip, may fail before the network is up, and can
  // raise the config-sync question before anybody asked for anything.
  'remote-last-workspace.test.ts',
  // Which build is answering this conversation. Audit read the **window**'s
  // runtime version, which comes from the binary next to this application — the
  // wrong build on a remote screen, shown beside a `protocol` that came from the
  // host. `init` carries no product version, so the host is asked once, on
  // demand, and the answer is kept on the bucket.
  'remote-runtime-version.test.ts',
  // The saved hosts. `removeSshHost` was implemented with a whole refusal rule
  // and called by nothing; `configPolicy` could only ever be written, never
  // shown or changed back. Both now have a surface, and these assert the rules
  // it stands on: a referenced host is not removable, a host with no stored
  // policy reads as `ask`, and re-adding a saved workspace updates its name
  // rather than silently keeping the one from the first visit.
  'remote-hosts.test.ts',
  // The connecting toast: what it names (the workspace being opened, not the
  // focus) and when it is gone (the handshake landing, or a failure that has
  // its own surface). The selector is pure, so the two halves 鈥?the pre-bucket
  // `openingRemote` mark and the post-bucket `connection.phase` 鈥?are both
  // asserted against store states rather than looked at in a window.
  'connecting-toast.test.ts',
  // Task templates: the pure rules (what makes one runnable, how a workspace
  // ref resolves) and the Run path (which open path each ref takes, and the
  // design's "no fake success" rule 鈥?a link only when a new bucket landed,
  // history surviving a deleted template, ids back-filled from `init`).
  'task.test.ts',
  // Task refine: the scope over a task's own runs (settled only, newest
  // first, the failed-only variant keeping one ok reference), the gate that
  // keeps remote tasks and other workspaces out, and the prompt's reader —
  // the marked candidate blocks read back, and the question's answer read
  // back to candidate numbers. All pure: no window, no child.
  'refine.test.ts',
  // The markdown answer's language bar. The tag is not an attribute anywhere in
  // the tree `react-markdown` builds 鈥?it is a class on the inner `<code>` 鈥?so
  // the reading is a claim about a third-party renderer's output. It is asserted
  // against the **real** renderer, because the day that output changes the bar
  // silently loses its label and every fence renders untagged. The stylesheet
  // half is read as text, like `stream-layout.test.ts` does: a rule that went
  // back to a hard-coded colour has no behaviour to observe in Node.
  'markdown-fence.test.tsx',
  // Pictures in an answer. A model that generates one hands back a **path**, and
  // a WebView cannot load a path as an `<img>` — so this suite pins the mapping
  // that turns one into pixels, the destinations that are refused instead (a
  // `file:` URL is an absolute path on this machine), and that a refusal stays
  // visible as the path rather than going blank.
  'markdown-image.test.tsx',
  // A declared deliverable under quiet mode. The card vanished there while the
  // model's prose said "已经放到下面了", so the person was sent looking for a card
  // the renderer had decided was detail. Both halves are pinned: that a card is
  // drawn, and that it is drawn even when the rollup line is collapsed.
  'quiet-deliverables.test.tsx',
  // The plus menu's second page. The menu is a `max-height: 320px` flex column
  // and the skills page used to be a bare `<div>`: as a flex item it sized itself
  // to its content, so the list never overflowed, never scrolled, and the rows
  // past the fold were unreachable — no scrollbar was the visible half of it.
  // Both halves are read as text (the rule, and the markup that applies it),
  // because a shrink container has no behaviour to observe in Node.
  'plus-menu-scroll.test.ts',
  // Find in the conversation: where a match lands (a `Range` offset that is one
  // out puts the mark on the wrong word, and a match allowed to span a paragraph
  // break draws one mark across two paragraphs), case folding that keeps its
  // offsets, and the two links that fail invisibly 鈥?a searchable row that
  // carries no `data-entry` is counted and never drawn, and a highlight registry
  // name the stylesheet does not style paints nothing at all.
  'find.test.tsx',
  // The one shortcut whose miss is invisible: a reload. The screen comes back
  // looking normal, and the transcript, draft and history that were there are
  // gone — while the child keeps running unseen. The rule is a pure predicate
  // precisely so the modifier combinations (including WebView2's hard reload,
  // `Ctrl+Shift+R`) can be asserted rather than trusted.
  'global-keys.test.ts',
  // The words this window puts on the runtime's records: context pressure,
  // compaction, goal rounds and pictures. The store keeps facts only, and the
  // sentences are asserted here — including the one a formatter gets wrong for
  // free, printing a missing figure as zero.
  'front-message.test.ts',
  // When the launch splash may be retired, and the two ends of it that have no
  // type between them. Both wrong rules produce a plausible-looking launch — an
  // empty greeting with "starting" behind it, or a booting shell where the icon
  // was — so the rule is a pure function and the document and the Rust module
  // are read as text.
  'splash.test.ts',
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: SUITES.map((name) => resolve(here, name)),
  outdir: outDir,
  // `.mjs`, because package.json declares `"type": "module"` and the sources are
  // ESM 鈥?esbuild would otherwise emit `.js` and the runner's paths would miss.
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'inline',
  // Everything else is bundled: the test drives the real modules, not stubs.
  external: ['node:*'],
  alias: {
    '@': resolve(root, 'src'),
  },
  define: {
    // Injected by Vite in the real build; the store reads it once at module load.
    __DESKTOP_VERSION__: JSON.stringify('0.1.0'),
  },
  logLevel: 'warning',
});

const result = spawnSync(
  process.execPath,
  [
    '--test',
    // `--test-force-exit`, because a suite that renders a component pulls in
    // modules that touch the Tauri bridge, and those leave a handle open — the
    // assertions have all run by then, and without this the process sits on an
    // idle timer instead of reporting.
    '--test-force-exit',
    ...SUITES.map((name) => resolve(outDir, name.replace(/\.tsx?$/, '.mjs'))),
  ],
  {
    stdio: 'inherit',
    cwd: root,
  },
);

process.exit(result.status ?? 1);
