/**
 * Interface copy.
 *
 * **English only**, and that is a deliberate decision, not an omission.
 *
 * The runtime is English-only by construction — `internal/i18n` says so in its
 * package comment ("This build speaks English only"), the language-switching
 * machinery has been removed on purpose, and `en.go` is the only catalogue. A
 * desktop front end that offered a second language would be promising something
 * the thing behind it cannot deliver: half the screen would switch and the other
 * half (every `notice.text`, every approval hint) would not.
 *
 * That last point is the load-bearing one: text the runtime wrote — a notice, a
 * `remember_hint`, a `trust_all_hint` — is displayed **verbatim**. Translating it
 * would both invent a second source for the same fact and break the rule that
 * those hints are not altered by one character.
 *
 * Keys are grouped by the region that reads them.
 */

export const en = {
  /* ---------------- application ---------------- */
  'app.name': 'tudouni-aigo',
  'app.booting': 'Starting the runtime…',
  'app.bootingSlow': 'First launch takes a moment — waiting for the runtime handshake.',
  'app.name.you': 'you',

  /* ---------------- start-up failure ---------------- */
  'startup.title': 'The runtime could not be started',
  'startup.retry': 'Try again',
  'startup.stderr': "What the runtime printed (stderr, last lines)",

  /* ---------------- one session's own failure ----------------
   *
   * The same two buttons as the window-level panel above, because the two are
   * answered the same way; only the heading differs, and it has to: this one is
   * about a session that was being opened while another was already running, so
   * saying "the runtime could not be started" would be a sentence about the
   * wrong process. See `SessionProblem`. */
  'problem.title': 'This session could not be started',

  /* ---------------- start-up notice ----------------
   *
   * Not a failure: the application runs, nothing is open yet, and this says why.
   * `{path}` is the workspace last worked in; `{reason}` is the runtime's own
   * sentence, passed through verbatim — it is the authority on why it refuses a
   * directory, and paraphrasing it here would be a second copy of that rule. */
  'notice.lastWorkspaceGone':
    'Nothing was opened: the workspace last used is no longer available — {path}. {reason}',
  'notice.pickWorkspace': 'Pick a workspace in the list to start, or add one.',
  /** No session to inherit a workspace from and nothing remembered, so a child
   *  was not started. A refusal rather than a failure: the app is fine, it just
   *  has nowhere to work.
   *
   *  **It names no direction on purpose.** This sentence is read in two places —
   *  the first screen, where the workspace list really is below it, and the
   *  conversation column, where that list may be folded away or hidden by the
   *  window being narrow. "Choose one below" would be false in the second, so
   *  the line states the fact and the button beside it is the way forward. */
  'notice.noWorkspace':
    'No workspace is open, so nothing was started. The runtime needs a directory to work in.',
  /** The button that goes with the two notices above. */
  'notice.chooseWorkspace': 'Choose a workspace…',

  /* ---------------- title bar ---------------- */
  'titlebar.minimize': 'Minimize',
  'titlebar.maximize': 'Maximize',
  'titlebar.restore': 'Restore',
  'titlebar.close': 'Close',

  /* ---------------- top bar ---------------- */
  'topbar.workspaceTip': 'Workspace path',
  'topbar.palettePlaceholder': 'Type a command or search…',
  'topbar.commands': 'Command palette',
  /** The `?` button left of the palette box. The label is the panel's own title
   *  ("Help"), not "Keybindings": the panel holds the command table too, and now
   *  that it is the only place either list is reachable from, naming it after
   *  half its contents would understate what the click opens. */
  'topbar.help': 'Help',
  'topbar.pickWorkspace': 'Choose workspace…',
  'topbar.menu': 'Menu',

  /* ---------------- session bar ---------------- */
  'session.label': 'Session',
  'session.resumed': 'resumed',
  'session.fresh': 'new',
  'session.model': 'model',
  'session.route': 'route',
  'session.thinking': 'thinking',
  'session.thinkingOn': 'on',
  'session.thinkingOff': 'off',
  'session.effort': 'effort',
  'session.maxSteps': 'step cap',
  'session.permScope': 'asks on',
  'session.permAuto': 'all auto',
  'session.permNone': 'nothing',

  /* ---------------- phases ---------------- */
  'phase.booting': 'Starting',
  'phase.idle': 'Idle',
  'phase.idleNever': 'Idle · nothing said yet',
  'phase.running': 'Running',
  'phase.done': 'Done',
  'phase.stepLimit': 'Step limit reached',
  'phase.failed': 'Failed',
  'phase.interrupted': 'Interrupted',
  /** The turn finished with no text at all. Not a failure, and not "done"
   *  either: "Done" over a blank body reads as "your answer was lost". */
  'phase.empty': 'Ended with an empty response',
  /** The turn was cut off because the runtime process went away. Its own word:
   *  "Done" would claim the answer finished and "Failed" would blame the model. */
  'phase.runtimeGone': 'Runtime exited',
  /** The composer's stop button. Distinct from `phase.interrupted`, which names
   *  the *result* of an interrupt; this is the action that causes one. */
  'composer.interrupt': 'Stop',
  /** The turn head's per-turn progress: "step 3 of this turn's 120". Both
   *  numbers come from the entry (`entry.step` / `entry.maxSteps`), so the
   *  fraction is meaningful — the denominator is the budget *this* turn is
   *  spending. */
  'status.step': 'step {n} / {max}',
  /** The status bar's cumulative count, and it deliberately has **no
   *  denominator**.
   *
   *  It used to reuse `status.step` with `session.steps` over
   *  `session.maxSteps`, which are two different quantities: the numerator is
   *  every assistant message in the conversation (cumulative, and large on a
   *  resumed session), the denominator is `--max-steps` — how many model calls
   *  **one turn** may take, reset each turn. Written as a fraction it reads
   *  `step 497 / 120`, which is not an overflow but two units wearing one
   *  shape. The word "steps" carries the absence of a limit; a bare `step 497`
   *  would still read as "497 of something unknown".
   *
   *  The cap is not a secret — it lives in the session bar's `step cap` and in
   *  the settings panel's `--max-steps`. The status bar does not need a third
   *  place to restate it. */
  'status.steps': '{n} steps',
  'status.autopilot': 'autopilot',
  'status.quiet': 'quiet',
  /** The status bar's terminals badge: the count of the workspace's shells, and
   *  the way into the terminal view.
   *
   *  **"terminals", not "shells", and the count is every row.** A row whose
   *  process has ended stays in the runtime's list on purpose — it is what
   *  answers "what was I running" — and the tab strip and the panel both count
   *  it, so counting only the live ones here would make one number disagree with
   *  the two screens it sits between. */
  'status.terminals': 'terminals',
  /** The tooltip with nothing to attach to. The button is disabled in this
   *  state, and a disabled control with no explanation is the kind of dead end
   *  the terminal panel's empty state exists to avoid — this says the same thing
   *  in the place the pointer already is. */
  'status.terminalsNone': 'no terminal in this workspace',
  'status.jobs': 'jobs',
  'status.jobsUncollected': 'uncollected',
  'status.subagents': 'subagents',
  'status.context': 'context',
  'status.contextUnknown': '{used} tok · window unknown',
  /** Shown when the provider has not reported a count for a successful call
   *  yet. The context layer's local estimate is never substituted here. */
  'status.contextNoPrompt': 'context · no request measured yet',
  'status.contextEstimate': 'context estimate · {used} tok · {percent} of the window',
  /** The cache figure is a ratio, and **of what** differs by source: the last
   *  successful call's own prompt (the live path), or the totals summed over the
   *  session (`ui(status).usage`, the fallback for a `/resume`d conversation
   *  whose calls this window never saw). The two are labelled apart so a figure
   *  that changes meaning between two sessions is never mistaken for one that
   *  changed value. The `/status` screen always reports the session totals. */
  'status.cache': 'cache',
  'status.cacheCall': 'cache · last call',
  'status.cacheSession': 'cache · session total',
  'status.elapsed': 'turn',
  'status.span': 'span',
  /** The status bar's resource chip: the whole application's CPU and memory,
   *  sampled by the host. `{cpu}` is a share of the whole machine (all cores),
   *  `{mem}` the bytes the shell and its runtimes hold. The chip shows the sum;
   *  the three lines below are the tooltip, one fact per line. */
  'status.resources': 'CPU {cpu} · {mem}',
  'status.resourcesCpu': 'CPU: shell {shellCpu} · runtimes {runtimesCpu} of the machine',
  'status.resourcesMem': 'Memory: shell {shellMem} · runtimes {runtimesMem}',
  'status.resourcesSystem': 'System memory in use: {systemUsed} of {systemTotal}',
  'status.audit': 'audit log',
  'status.runtimeGone': 'Runtime exited (code {code})',
  'status.runtimeEnded': 'Runtime ended',

  /* ---------------- first screen ---------------- */
  'welcome.greeting': 'Hi, {name}',
  'welcome.greetingAnon': 'Hi',
  'welcome.meta': 'desktop v{desktop} · runtime {runtime}',
  'welcome.where': '{model} · {workspace}',
  'welcome.start': 'Start here: describe what you want, or reopen the last session.',
  'welcome.recent': 'Recent sessions',
  'welcome.recentEmpty': 'No past sessions',
  'welcome.recentEmptyHint': 'Sessions are written under .tudouni/ in this workspace.',
  'welcome.slotEmpty': 'empty',

  /* ---------------- stream entries ---------------- */
  'entry.turn': 'Turn {n}',
  'entry.turnRunning': 'in progress',
  'entry.turnDone': 'ended · completed',
  'entry.turnFailed': 'ended · failed',
  'entry.turnInterrupted': 'ended · interrupted',
  'entry.turnStepLimit': 'ended · step limit',
  'entry.turnEmpty': 'ended · empty response',
  /** The turn head's fold. It is the only way in and out of a folded turn, so
   *  the label says *which* turn's body — "Collapse" alone would be the same
   *  words for every turn on screen. */
  'entry.turnFold': 'Collapse this turn',
  'entry.turnUnfold': 'Expand this turn',
  /** What a folded **running** turn is doing, in the head's badge — the one line
   *  the fold leaves behind. The words are the loop's own stages, and they are
   *  the four a person can actually watch happen (`TurnPhase`): thinking, the
   *  call itself, a tool it asked for, and the answer being written. */
  'entry.turnPhaseThinking': 'thinking',
  'entry.turnPhaseModel': 'model call',
  'entry.turnPhaseTool': 'tool call',
  'entry.turnPhaseReply': 'reply',
  'entry.you': 'you',
  /** Copy button on the user's own bubble (`EntryView.tsx`, `UserEntry`). */
  'entry.userCopy': 'Copy message',
  'entry.userCopied': 'Copied',
  'entry.assistant': 'model',
  'entry.model': 'model call',
  'entry.modelRetry': 'retry · waiting {ms}ms',
  'entry.modelMetrics': '{ms} · in {input} · cached {cached}',
  /** The call's own output rate, appended where a measurement exists. It is
   *  the average over the whole call (prompt processing included), the same
   *  figure the reference front end draws — labelled "out" next to "in" so the
   *  pair reads as one ledger, and "out" rather than a bare number because an
   *  unexplained rate next to token counts does not survive the glance. */
  'entry.modelOut': 'out {n} tok/s',
  /** The step card's head metrics, as two labelled figures: what the call sent
   *  and what a cache served of it. Same numbers as `modelMetrics` drew as one
   *  line before; the labels move onto the head bar because a card's head is
   *  where a reader glances, and an unlabelled number pair there does not
   *  survive the glance. */
  'entry.modelIn': 'in {n}',
  'entry.modelCached': 'cached {n}',
  'entry.modelNoMetrics': 'in progress',
  'entry.toolResultOk': 'done',
  'entry.toolResultError': 'error',
  'entry.toolResultInvalid': 'bad arguments',
  'entry.toolResultDenied': 'not run',
  // Its own label rather than reusing `not run`. "Not run" is a decision the
  // runtime made about the call; this is the person's own stop, and the two read
  // very differently when you are scanning a transcript for what your stop did.
  'entry.toolResultInterrupted': 'stopped',
  'entry.toolChars': '{n} chars',
  'entry.toolExit': 'exit {n}',
  'entry.toolDuration': '{ms}',
  'entry.denied': 'not run — the runtime refused this call',
  'entry.batch': 'concurrent batch · {count} calls · wall {ms}ms',
  'entry.perm': 'permission',
  'entry.output': 'output',
  'entry.permAuto': 'autopilot',
  'entry.permRule': 'rule remembered: {rule}',
  'entry.permRemembered': 'remembered: {rules}',
  'entry.permWaited': 'waited {ms}',
  'entry.permNoWait': 'no wait',
  'entry.reasonCollapsed': 'reasoning · {n} chars',
  'entry.reasonLive': 'reasoning · {n} chars · live',
  'entry.quietRollup': '{n} tool calls collapsed',
  'entry.quietHint': 'switch to detail with /quiet',
  'entry.showDetail': 'detail',
  'entry.params': 'params',
  'entry.builtin': 'built-in',
  'entry.external': 'external',
  'entry.parallelSafe': 'parallel-safe',
  'entry.occupiesInput': 'holds input',
  'entry.unknown': 'unknown',

  /* ---------------- declared deliverables ----------------
   *
   * A `present` call's cards. The note under each file name is the **model's own
   * sentence** when it wrote one, shown verbatim — it is not interface copy, and
   * nothing here may reword it. These keys are the other half: the fallback for a
   * declaration with no note, the two actions, and the label on the group.
   */
  'deliverable.label': 'Delivered files',
  'deliverable.preview': 'Preview {name}',
  'deliverable.open': 'Open {name} in its default application',
  'deliverable.dismiss': 'Dismiss this message',
  /** Shown when the page is not hosted by the desktop shell, so there is nothing
   *  to hand a path to. It names the alternative rather than only the failure —
   *  the preview still works, and that is what this reader should do next. */
  'deliverable.noHost': 'Opening in another app needs the desktop window — use Preview here.',
  // The fallback notes, by kind. A word a person would use, not the extension in
  // capitals: `MD` is an identifier, "Markdown" is a thing someone asked for.
  'deliverable.kind.markdown': 'Markdown document',
  'deliverable.kind.pdf': 'PDF document',
  'deliverable.kind.sheet': 'Spreadsheet',
  'deliverable.kind.document': 'Document',
  'deliverable.kind.slides': 'Slides',
  'deliverable.kind.image': 'Image',
  'deliverable.kind.file': 'File',

  /* ---------------- left sidebar: workspaces and sessions ---------------- */
  'lb.workspaces': 'Workspaces',
  'lb.sessions': 'Sessions',
  'lb.newSession': 'New session',
  'lb.newSessionHint': 'Start from a clean context',
  'lb.addWorkspace': 'Add a workspace…',
  'lb.refreshSessions': 'Re-read the session list',
  'lb.collapse': 'Hide this sidebar',
  'lb.settings': 'Settings',
  /* The configuration files, above Settings in the rail's foot. The tooltip
     says what the two are *apart* from each other, because the difference is the
     one thing a person needs to know before opening it: Settings is this
     session's start-up arguments, this is the file every session reads at open. */
  'lb.config': 'Config',
  'lb.configHint':
    'The configuration files: routes, keys, and MCP servers. Read when a session starts.',
  /* Workspace learning: the rail's entry, the configuration panel, and its
     fields. The panel's text is the person's half of what becomes the
     learning session's first message, so it says what will happen — a new
     session is created and the agent studies the workspace's history. */
  'lb.learn': 'Learn workspace',
  'lb.learnHint':
    'Study this workspace\u2019s past sessions and draft candidate knowledge assets for review.',
  'panel.learn.title': 'Learn this workspace',
  'panel.learn.about':
    'Studies this workspace\u2019s own history and drafts candidate knowledge assets for you to review.',
  'panel.learn.note':
    'Starts a new session that studies the workspace\u2019s history. Its answer is a set of candidates you review and apply in a normal conversation.',
  /* The side card. Its title names the whole card — every line under it is a fact
     about the run that is about to start, not a field — and the two fact labels
     are the same nouns the rows on the left use, so the summary and the thing it
     summarises cannot drift apart. */
  'panel.learn.sideTitle': 'This run',
  'panel.learn.factScope': 'Sessions in scope',
  'panel.learn.factDeliverables': 'Deliverable types',
  'panel.learn.factDeliverablesValue': '{n} of {total}',
  'panel.learn.scope': 'Session scope',
  'panel.learn.scope.all': 'All sessions',
  /* The two parameterised options are labelled by their **dimension**, with
     the number living in the field beside them. `Last {n} days` was the
     obvious phrasing and it is wrong for `n = 1` ("Last 1 days") — this
     catalogue has no plural machinery to fall back on, so the label is
     worded so that no value can make it ungrammatical. */
  'panel.learn.scope.days': 'Days to look back',
  'panel.learn.scope.last': 'Most recent sessions to use',
  'panel.learn.scope.hint':
    'The run reads only the sessions this range selects. Archived sessions are never included.',
  'panel.learn.scope.daysPlaceholder': 'Days',
  'panel.learn.scope.countPlaceholder': 'Sessions',
  'panel.learn.scope.none': 'The workspace has no saved sessions yet — nothing to learn from.',
  /* The empty *range* case, which is not the same fact as an empty workspace:
     the workspace has sessions, and the chosen window misses all of them. */
  'panel.learn.scope.empty': 'No session falls in this range — widen it, or pick another one.',
  'panel.learn.deliverables': 'Deliverable types',
  'panel.learn.deliverables.hint': 'Only these types may be produced as candidates.',
  'panel.learn.objectives': 'Focus (optional)',
  'panel.learn.objectives.placeholder':
    'e.g. recurring build errors, repeated user corrections, operations worth scripting…',
  'panel.learn.start': 'Start learning',
  /* The footer's calm state is now empty, and that is the change the side card
     made: "sessions in scope" is a *fact about the run*, so it sits with the
     other facts instead of in the slot reserved for whatever is stopping Start.
     What is left there is only ever the blocker, beside the button it disables. */
  'panel.learn.noneSelected': 'Pick at least one deliverable type',
  'panel.learn.invalidRange': 'Give a number of 1 or more',
  'panel.learn.noWorkspace': 'Open a workspace to start learning.',
  'panel.learn.modelNote': 'The run uses this workspace\u2019s current model and settings.',
  'lb.sessionLearning': 'learning run',
  'lb.sessionLearningHint': 'This session was started from Learn workspace: it is studying the workspace\u2019s history.',
  /* Task templates: the rail's entry and the panel's copy. A task is the
     desktop's own repeatable session launcher — configure a prompt, a
     workspace and an optional model once, then Run opens a new session and
     speaks the prompt as its first message.

     The panel is one dialog with three surfaces — the shelf, the history and
     the editor — so the keys below are grouped that way: the shelf's header
     and rows, the history's own header and rows, then the editor's fields. */
  'lb.task': 'Tasks',
  'lb.taskHint': 'Reusable session launchers: a saved prompt, workspace and model, one click to run.',
  'panel.task.title': 'Tasks',
  'panel.task.note': 'Reusable prompts that open a new session.',
  'panel.task.about':
    'A task is a saved prompt, a workspace and an optional model. Run opens a new session and sends the prompt as its first message; nothing else about the session changes.',
  'panel.task.new': 'New task',
  /* The search is a filter over the shelf, not a query language: it matches the
     task's name and its description, and the list says so when nothing does. */
  'panel.task.search': 'Search tasks',
  'panel.task.filter.all': 'All',
  'panel.task.filter.enabled': 'Enabled',
  'panel.task.filter.disabled': 'Disabled',
  'panel.task.noMatch': 'No task matches that search',
  'panel.task.noMatchHint': 'Try a shorter word, or clear the search.',
  'panel.task.history': 'History',
  'panel.task.empty': 'No task yet',
  'panel.task.emptyHint': 'Save a prompt you run often — with its workspace and model — and start it from here.',
  'panel.task.unnamed': 'Untitled task',
  'panel.task.run': 'Run',
  'panel.task.runHint': 'Run: start a new session with this task\u2019s prompt',
  'panel.task.edit': 'Edit this task',
  'panel.task.copy': 'Duplicate this task',
  'panel.task.delete': 'Delete this task. Its past runs stay listed.',
  'panel.task.deleteConfirm': 'Delete? Click again to confirm',
  'panel.task.copyName': '{name} (copy)',
  'panel.task.disable': 'Disable this task',
  'panel.task.enable': 'Enable this task',
  'panel.task.disabled': 'Disabled',
  'panel.task.workspaceMissing': 'workspace unavailable',
  'panel.task.modelDefault': 'Inherit model',
  'panel.task.running': 'Running',
  'panel.task.more': 'More actions',
  /* History — the runs a task produced, newest first, grouped by day. */
  'panel.task.historyTitle': 'History',
  'panel.task.historyNote': 'Runs started by your tasks, newest first.',
  'panel.task.historyBack': 'Back to the task list',
  'panel.task.historySearch': 'Search runs',
  'panel.task.historyAll': 'All',
  'panel.task.historySucceeded': 'Succeeded',
  'panel.task.historyFailed': 'Failed',
  'panel.task.historyEmpty': 'No run yet',
  'panel.task.historyEmptyHint': 'Press Run on a task and the session it starts is listed here.',
  'panel.task.historyNoMatch': 'No run matches that filter',
  'panel.task.day.today': 'Today',
  'panel.task.day.yesterday': 'Yesterday',
  'panel.task.day.earlier': 'Earlier',
  'panel.task.day.count': '{n} runs',
  'panel.task.day.countOne': '1 run',
  'panel.task.succeeded': 'Succeeded',
  'panel.task.failed': 'Failed',
  'panel.task.lastRunFailed': 'Last run failed',
  'panel.task.open': 'Open',
  'panel.task.retry': 'Retry',
  'panel.task.retryHint': 'Run this task again in the same workspace',
  'panel.task.openHint': 'Open this session',
  'panel.task.openGone': 'This session is not open and no longer on disk',
  'panel.task.historyLive': 'Running now',
  'panel.task.historySaved': 'Saved session',
  'panel.task.historyPending': 'Starting…',
  'panel.task.starting': 'starting…',
  'panel.task.onScreen': 'on screen',
  'panel.task.clearHistory': 'Clear run history',
  'panel.task.clearHistoryConfirm': 'Clear it? Click again to confirm',
  'panel.task.clearHistoryHint': 'Forgets the run list. The sessions themselves stay on disk.',
  'panel.task.problem.name': 'Give the task a name',
  'panel.task.problem.prompt': 'Write the prompt the run should send',
  /* The editor — two columns: what the run says, and where it says it. */
  'panel.task.editTitle': 'Edit task',
  'panel.task.newTitle': 'New task',
  'panel.task.editNote': 'Only the prompt, workspace and model are handed to the new session.',
  'panel.task.field.name': 'Name',
  'panel.task.field.desc': 'Description',
  'panel.task.optional': 'Optional',
  'panel.task.field.descPlaceholder': 'Short summary shown in the task list',
  'panel.task.field.prompt': 'Prompt',
  'panel.task.field.promptPlaceholder': 'What the new session should be asked to do…',
  'panel.task.promptHint': 'Sent verbatim as the first message of the new session.',
  'panel.task.field.environment': 'Environment',
  'panel.task.field.workspace': 'Workspace',
  'panel.task.field.model': 'Model',
  'panel.task.field.modelHint': 'Uses the workspace\u2019s current model.',
  'panel.task.field.modelPlaceholder': 'provider/model',
  'panel.task.modelInherit': 'Inherit from workspace',
  'panel.task.modelCustom': 'Type a model name…',
  'panel.task.modelAvailable': 'Available here',
  'panel.task.modelNoCatalogue': 'No catalogue yet — open a session, or type a name.',
  'panel.task.field.enabled': 'Enabled',
  'panel.task.field.enabledHint': 'Show Run in the task list.',
  'panel.task.wsActive': 'The workspace on screen',
  'panel.task.wsLocal': 'A saved local folder',
  'panel.task.wsRemote': 'A saved remote workspace',
  'panel.task.discard': 'Esc to discard changes',
  'panel.task.save': 'Save task',
  'panel.task.error.name': 'A task needs a name.',
  'panel.task.error.prompt': 'A task needs a prompt.',
  'lb.show': 'Show the workspace sidebar',
  'rail.drag': 'Drag to resize the sidebar. Double-click to reset it.',
  'lb.foldSessions': 'Fold the session list',
  'lb.unfoldSessions': 'Unfold the session list',
  'lb.foldWorkspaces': 'Fold the workspace list',
  'lb.unfoldWorkspaces': 'Unfold the workspace list',
  /* The rail's foot, folded on its own. The seven rows under it — files,
     terminal, learning, board, tasks, config, settings — are the workbench:
     the things the runtime works *with*, beside the workspaces it works *in*. */
  'lb.workbench': 'Workbench',
  'lb.foldFoot': 'Fold the workbench',
  'lb.unfoldFoot': 'Unfold the workbench',
  /* The drawer's two group names. They are the same nouns the rail already
     uses — a workspace's own surfaces, then the process's settings — so the
     groups read as parts of this rail rather than as a second menu. */
  'lb.workbench.groupWorkspace': 'Workspace',
  'lb.workbench.groupTasks': 'Tasks & settings',
  'lb.workbench.search': 'Jump to or search',
  'lb.workbench.clear': 'Clear the workbench filter',
  'lb.workbench.none': 'Nothing matches',
  'lb.deleteSession': 'Delete this session',
  'lb.deleteConfirm': 'Delete? Click again to confirm',
  'lb.current': 'current',
  'lb.currentHint': 'The runtime is working in this directory',
  'lb.forget': 'Forget',
  'lb.forgetHint': 'Remove from this list. The directory itself is not touched.',
  /* The fallback for a saved session whose runtime preview is empty: it never
     spoke, so there is no topic. The name says exactly that and nothing more —
     the id is still on the row (in `title`, and to the screen reader), so the
     word does not have to stand in for a fact the row already carries. */
  'lb.untitled': 'Untitled',
  'lb.emptyWorkspaces.title': 'No workspace listed',
  'lb.emptyWorkspaces.hint': 'Add the directory the runtime should work in.',
  /* The two flavours the add-workspace menu offers, and the tag a remote row
     carries in the merged list. Same two words in both places, so the tag on a
     row reads as the menu entry that created it. */
  'lb.workspaceKind.local': 'Local',
  'lb.workspaceKind.remote': 'Remote',
  'lb.emptySessions.title': 'No sessions yet',
  'lb.emptySessions.hint': 'Sessions are written under .tudouni/ in this workspace.',
  'lb.sessionsUnread': 'Could not read the session list',
  'lb.workspaceBad': 'Cannot be used',
  'lb.openWorkspace': 'Open this workspace',

  /* ---------------- remote workspaces (Workspace Manager, Phase 2) ---------------- */
  'lb.remoteWorkspaces': 'Remote',
  'lb.addRemoteWorkspace': 'Add a remote workspace…',
  'lb.addRemoteWorkspaceHint':
    'Connect over SSH to an already-installed runtime. The host and this workspace are saved together.',
  'lb.emptyRemoteWorkspaces.hint': 'Add a host and a directory on it.',
  'lb.remote.save': 'Save',

  /* ---------------- the add-remote-workspace wizard ----------------
   * Three steps, one question each: which host, connect, which directory.
   * The copy states what each step actually knows — a host list is the
   * *file's* contents (never a claim that a host is reachable), a failed
   * connection is its own sentence, and a directory is chosen from what the
   * far end reported rather than typed from memory. */
  'rw.title': 'Add a remote workspace',
  'rw.steps': 'Steps',
  'rw.step.host.name': 'Host',
  'rw.step.connect.name': 'Connect',
  'rw.step.workspace.name': 'Workspace',
  'rw.step.host.desc': 'Choose a host from your SSH configuration, or add a new one.',
  'rw.step.connect.desc': 'Connect and see what is on the other end before choosing anything.',
  'rw.step.workspace.desc': 'Pick the directory the agent should work in.',
  'rw.host.reading': 'Reading ~/.ssh/config…',
  'rw.host.list': 'Hosts from your SSH configuration',
  'rw.host.file': 'Read from {path}',
  'rw.host.noHosts': 'No named Host block in {path} — add one below.',
  'rw.host.noFile': 'No {path} yet — add your first host below.',
  'rw.host.unsupported': 'not usable',
  'rw.host.addNew': 'Add a new host',
  'rw.host.addNewHint':
    'Saved into your own ~/.ssh/config, so ssh and this application both see it. A password is never written there.',
  'rw.host.saveToConfig': 'Save and continue',
  /* The preview of the block about to be appended. This is the person's own
     ~/.ssh/config, so the exact lines are shown before the write rather than
     described — a summary of a config change is not the change. */
  'rw.host.preview': 'This block will be added:',
  'rw.host.previewWhere': 'Appended to {path} — nothing above it is changed.',
  'rw.newHost.incomplete': 'A name, an address and a user are all required.',
  'rw.newHost.badPort': 'The port must be a number between 1 and 65535.',
  'rw.newHost.badName':
    'That name cannot be used: it may not contain spaces, or any of * ? ! #.',
  'rw.field.alias': 'Name',
  'rw.field.hostname': 'Address',
  'rw.field.port': 'Port',
  'rw.field.user': 'User',
  'rw.field.identity': 'Private key paths (one per line, optional)',
  'rw.field.identityHint':
    'Leave blank to use the usual keys (~/.ssh/id_ed25519 and friends) if they exist.',
  'rw.password': 'Password (only if this host needs one)',
  'rw.passwordPlaceholder': 'leave blank for key authentication',
  'rw.passwordHint':
    'Kept in this application’s own preferences, never written to ~/.ssh/config — OpenSSH does not know that keyword and would refuse to start.',
  'rw.connect': 'Connect',
  'rw.connecting': 'Connecting…',
  'rw.up': 'Parent directory',
  'rw.noSubdirs': 'No subdirectories here.',
  'rw.newFolder': 'New folder',
  'rw.newFolderPlaceholder': 'folder name',
  'rw.pathLabel': 'Or type a directory path',
  'rw.pathHint': 'Absolute, or starting with ~ for the account’s home directory.',
  'rw.notAWorkspace': 'This directory cannot be the workspace:',
  'rw.willUse': 'The agent will work in',
  'rw.fact.home': 'home',
  'rw.fact.runtime': 'Runtime',
  'rw.fact.runtimeUnknown': 'installed (version unknown)',
  'rw.fact.noRuntime': 'no Runtime installed yet',
  'rw.fact.noConfig': 'no model configured yet',
  'rw.open': 'Open workspace',
  'rw.installAndOpen': 'Install Runtime and open',

  /* The host picker in the Add Remote Workspace form: it lists the
     `~/.ssh/config`'s concrete Host blocks so the form can prefill from
     what OpenSSH is already configured with. Each caption states the
     *state of the file* — it never claims a host is reachable, and a
     refused block's marker names the file's own field rather than
     rewording the parser's refusal. */
  'lb.remote.picker.title': 'From your ~/.ssh/config',
  'lb.remote.picker.manual': 'Enter manually…',
  'lb.remote.picker.caption':
    'Picking one fills in the fields below; you can still edit them before saving.',
  'lb.remote.picker.noHosts': 'The file names no concrete Host block — enter the details below.',
  'lb.remote.picker.unsupported': 'not supported',
  'lb.remote.hostLabel': 'Host name (for your own reference)',
  'lb.remote.hostLabelPlaceholder': 'e.g. prod-server',
  'lb.remote.host': 'Host or address',
  'lb.remote.port': 'Port',
  'lb.remote.user': 'User',
  'lb.remote.identityFiles': 'Private key paths (one per line)',
  'lb.remote.password': 'Password (optional)',
  'lb.remote.passwordWarning':
    'Stored on this machine in plain preferences, not an OS keychain. Prefer a key file when possible.',
  /** The binary field is optional on purpose: a host without the Runtime
   *  yet is a valid bookmark, and the install (the row's download button,
   *  or the automatic one on connect) fills this in for the person. */
  'lb.remote.remoteBinary': 'Runtime binary path on the remote host (optional)',
  'lb.remote.remoteBinaryPlaceholder': 'e.g. /opt/tudouni-aigo/bin/tudouni-aigo',
  'lb.remote.remoteBinaryHint':
    'Leave it blank if the Runtime is not installed on this host yet. You can install it later from the row\'s download button, or it is installed automatically when you open the workspace.',
  'lb.remote.remotePath': 'Workspace directory on the remote host',
  /** The row's own marker for "no binary path saved yet". It is a state, not
   *  a failure — the install that removes it may already be running (which
   *  the install badge then takes over the slot from). */
  'lb.remote.notInstalled': 'not installed',
  'lb.remote.notInstalledHint':
    'No Runtime on this host yet. Press the download button to install it, or open the workspace to install and connect in one go.',
  'lb.remote.workspaceLabel': 'Workspace name (for your own reference)',
  'lb.remote.forgetHostInUse':
    'This host is used by at least one saved remote workspace. Remove those first.',
  /* Connection state badges — §5.1 of the design. Each is a short word for the
     sidebar row; the sentence (when there is one) lives in the badge's own
     tooltip, built from `ConnectionState.problem` rather than translated here,
     since that text already comes from the Rust/Go side as a sentence. */
  'conn.local': 'Local',
  'conn.disconnected': 'Disconnected',
  'conn.connecting': 'Connecting…',
  'conn.installing': 'Installing…',
  'conn.starting': 'Starting…',
  'conn.handshaking': 'Handshaking…',
  'conn.ready': 'Connected',
  'conn.interrupted': 'Interrupted',
  'conn.closing': 'Closing…',
  'conn.closed': 'Closed',
  'conn.failed': 'Failed',
  /** The window-level toast for a remote workspace being opened (§5.1).
   *  `{name}` is the row's label, or its path when the label is blank. It
   *  stays on screen until the handshake lands — the phases it covers
   *  (config check, install, dial, handshake) all read as "connecting" to a
   *  person, and the distinction is the sidebar row's badges' to make. */
  'conn.toast.connecting': 'Connecting to {name}…',

  /* ---------------- remote install (Phase 3, §8 of the design) ---------------- */
  'lb.remote.install': 'Install or upgrade the Runtime on this host',
  'lb.remote.installFailed': 'Install failed',
  'lb.remote.installDone': 'Installed',
  'lb.remote.installUploading': 'Uploading {done}/{total}',
  'install.detecting_platform': 'Detecting platform…',
  'install.checking_existing_install': 'Checking…',
  'install.preparing_staging': 'Preparing…',
  'install.uploading': 'Uploading…',
  'install.verifying_and_switching': 'Verifying…',
  'install.done': 'Installed',

  /* ---------------- config sync (Phase 4, §9 of the design) ---------------- */
  'cfgsync.title': 'Configuration conflict',
  'cfgsync.subtitle':
    'The local and the remote model configuration disagree. Choose which one this workspace should use.',
  'cfgsync.noLocal': 'No local configuration file yet.',
  'cfgsync.hasLocal': 'A local configuration file exists.',
  'cfgsync.remoteMissing': 'The remote host has no configuration file yet.',
  'cfgsync.remoteValid': 'The remote host has a usable configuration.',
  'cfgsync.remoteOther': 'The remote host has a configuration file.',
  /* Why this was asked. The comparison is over content fingerprints (§9.5), so
     "it asked me again five minutes after I rewrote it" is answered by naming
     the side whose bytes actually moved — never a timestamp. */
  'cfgsync.reason.firstSync':
    'This host has never been synced, so there is no baseline to compare against yet.',
  'cfgsync.reason.remoteChanged':
    'The remote file changed since the last sync. The local file did not.',
  'cfgsync.reason.bothChanged':
    'Both files changed since the last sync, so neither side can be taken as the one the other is measured against.',
  'cfgsync.reason.localChanged':
    'The local file changed since the last sync. The remote file did not.',
  /* Answering is a fresh SSH connection plus an SFTP round trip, so it is not
     instant — the dialog has to say what it is waiting for. */
  'cfgsync.writing': 'Uploading the local configuration over SSH…',
  'cfgsync.reading': 'Recording the remote configuration over SSH…',
  'cfgsync.remember': 'Remember this answer for this host',
  'cfgsync.rememberHint':
    'Becomes this host’s config policy, so later opens follow it without asking — “use local” keeps overwriting the remote file.',
  'cfgsync.useLocal': 'Use local (overwrite remote)',
  'cfgsync.useRemote': 'Use remote (keep as is)',

  /* The sessions that are open but have no file yet.
     They need their own words because they are a different fact from a saved
     row: there is nothing on disk, so there is no message count, no preview and
     no time to show — and before this group existed a new session appeared in no
     list at all, which is why "New session" read as a button that did nothing. */
  'lb.unsaved': 'open now',
  'lb.sessionOpen': 'Nothing has run in it yet',
  'lb.sessionPending': 'starting…',

  /* The session status dots. Each one has to read as a sentence, because the
     colour alone is not a signal anybody should be asked to interpret — see
     `SessionDot`. */
  'lb.dot.asking': 'Waiting for you: an approval or a question',
  'lb.dot.broken': 'Stopped with an error',
  'lb.dot.running': 'Working now',
  'lb.dot.unseen': 'Finished — you have not looked at it yet',
  'lb.attention': '{n} need your attention',

  /* ---------------- session board ---------------- */
  /* The board is a view of the **whole workspace**, so its words are about
     "the sessions", never "this session" — the distinction the view's own
     comment is about. */
  'board.title': 'Session board',
  'board.subtitle': 'Every session open in this workspace, right now.',
  'board.openHint': 'See what every session is doing',
  'board.close': 'Close the board',
  'board.closeHint': 'Back to the conversation (Esc)',
  'board.col.needs': 'Needs you',
  'board.col.working': 'Working',
  'board.col.finished': 'Finished',
  'board.col.idle': 'Idle',
  'board.empty.title': 'No session open',
  'board.empty.hint': 'The board shows the sessions that are running in this workspace.',
  'board.noPreview': 'Nothing said yet',
  /* A live session whose file does not exist yet has no counts to show — the
     runtime has not written it down. Saying so beats a row of zeroes, which
     would read as "this conversation is empty" rather than "not saved yet". */
  'board.noCounts': 'not saved yet',
  /* The card-level call to action for a session waiting on a blocking request.
     The board is where a person watching several sessions learns that one of
     them needs them (the card has moved into Needs you); this line is what
     tells them the click on the card is also the way to answer it — the prompt
     itself surfaces only after the click, so without it the card would look
     like any other. */
  'board.card.asking': 'Waiting on your answer — click to reply',
  /* The card's compact flags, next to the id. Two of them, one per card:
     "asking" is the card that moved into Needs you, "new" is the conversation
     this end started fresh. One word each on purpose — a pill is a label, not
     a sentence, and the nudge line below an asking card carries the full call
     to action. */
  'board.card.askingTag': 'asking',
  'board.card.newTag': 'new',
  /* The empty column's honest placeholder. Dashed, centred, one line: "eight
     ended sessions" reads as a state, bare emptiness does not. */
  'board.col.empty': 'Nothing here right now',

  /* The card context menu: three words and the one sentence the menu owes — the
     reconcile step closes the session before it acts, so the archive row's
     label says that cost instead of a disabled button pretending it away. */
  'board.menu.title': 'Session actions',
  'board.menu.delete': 'Delete…',
  'board.menu.deleteArm': 'Delete the file. Click again to confirm.',

  /* Which conversation a blocking request belongs to, and how many are behind
     it. Both exist because a prompt with several sessions open is otherwise
     anonymous — see `selectModalOrigin`. */
  'modal.from': 'from',
  'modal.queued': '{n} more waiting',

  /* ---------------- sidebar blocks ---------------- */
  /* The right rail's own head. It says what the rail is, because its five blocks
     below say what is *in it* and none of them names the rail itself. The word
     is the running runtime's, not the transcript's: everything below is a fact
     about the session in flight. */
  'rail.head': 'Session runtime',
  /* The right rail's toggle, at the trailing edge of the session bar (`SessionBar`
     draws both rail toggles). It names the rail the way the left one's does, so
     the two read as a pair: "this sidebar" is the one the shortcut beside it
     belongs to (`Ctrl+B` here, `Ctrl+L` there). */
  'rail.collapse': 'Hide this sidebar',
  'rail.show': 'Show the session runtime sidebar',
  'block.goal': 'Goal',
  'block.tasks': 'Tasks',
  'block.skills': 'Loaded skills',
  'block.jobs': 'Background jobs',
  'block.mcp': 'MCP',
  'block.ssh': 'SSH sessions',
  'block.collapse': 'Collapse',
  'block.expand': 'Expand',

  'empty.goal.title': 'No goal',
  'empty.goal.hint': 'A long-term goal shows its phase and round count here.',
  'empty.tasks.title': 'No tasks yet',
  'empty.tasks.hint': 'Steps the model breaks out appear here with their status.',
  'empty.skills.title': 'No skill loaded',
  'empty.skills.hint': 'Matched skills load automatically and show up here.',
  'empty.jobs.title': 'No background jobs',
  'empty.jobs.hint': 'Background commands and delegations show their uncollected results here.',
  'empty.mcp.title': 'Nothing attached',
  'empty.mcp.hint': 'Open /mcp to load an external tool server.',
  'empty.ssh.title': 'No SSH sessions',
  'empty.ssh.hint': 'Sessions opened by ssh_connect show their host here.',
  'ssh.live': 'connected',
  'ssh.ended': 'ended ({why})',
  'ssh.noCode': 'ended, no exit code',

  'goal.armed': 'armed',
  'goal.disarmed': 'disarmed',
  'goal.rounds': 'rounds {text}',
  'goal.limitReached': 'round limit reached',
  'goal.blocked': 'blocked: {reason}',
  'goal.pause': 'Pause',
  'goal.resume': 'Resume',
  'goal.clear': 'Clear',

  'jobs.uncollected': 'uncollected',
  'jobs.running': 'running',
  'jobs.done': 'done',
  'jobs.killed': 'killed',
  'jobs.exit': 'exit {n}',
  'jobs.seconds': '{n}s',

  'mcp.loaded': 'running',
  /** The panel's wording: it has room to spell out that configuration exists. */
  'mcp.unload': 'configured, not running',
  /** The rail's wording for the same state. The rail is 233px wide and this row
   *  also carries an action button, so the long form above does not fit — it
   *  measured 131px of a 233px row on its own, and the row already overflowed at
   *  the narrow-window width before anything was added. The short form is the
   *  runtime's own (`mcp.not_loaded`, "not loaded"), so it is the same fact in
   *  the same words, not a second vocabulary. */
  'mcp.notLoaded': 'not loaded',
  'mcp.failed': 'connection failed',
  'mcp.tools': '{n} tools',
  'mcp.load': 'Load',
  'mcp.unloadAction': 'Unload',
  /** The rail's button: the visible word is the action, and the accessible name
   *  has to say *which* server — a column of bare "Load"s reads as nothing at
   *  all to a screen reader. */
  'mcp.loadServer': 'Load {name}',
  'mcp.unloadServer': 'Unload {name}',
  /** While a load/unload is out. The button shows dots; this is its accessible
   *  name, because "…" announced on its own says nothing. */
  'mcp.pending': 'Waiting for the runtime — {name}',
  'mcp.where': 'launch',

  'tasks.progress': '{done} / {total}',
  'tasks.pending': 'pending',
  'tasks.inProgress': 'in progress',
  'tasks.done': 'done',

  /* ---------------- panels ---------------- */
  'panel.commands.title': 'Command palette',
  'panel.commands.placeholder': 'Type a command name or keyword (prefix filter)',
  'panel.commands.empty': 'No matching command',
  'panel.commands.argGroup': 'Run with this argument',
  'panel.commands.runWith': 'run with this argument',
  'panel.model.title': 'Model',
  'panel.model.current': 'current',
  'panel.model.route': 'route',
  'panel.model.window': 'window',
  'panel.model.alias': 'legacy name',
  'panel.model.aliases': 'Legacy names',
  'panel.model.vision': 'vision',
  'panel.effort.title': 'Reasoning effort',
  'panel.effort.note':
    'The list is sent by the runtime per model — never hardcoded here.',
  'panel.resume.title': 'Sessions',
  'panel.resume.empty': 'The runtime reported no sessions',
  'panel.resume.messages': '{n} messages',
  'panel.resume.steps': '{n} steps',
  /** The two views of the library. "Active" is what the rail shows; "Archived"
   *  is what it deliberately does not. */
  'panel.resume.tab.active': 'Active',
  'panel.resume.tab.archived': 'Archived',
  'panel.resume.search': 'Search sessions',
  /** Field-level search: the topic and the session id. */
  'panel.resume.searchHint': 'Matches the topic and the session id',
  'panel.resume.noMatch': 'No session matches',
  'panel.resume.archivedEmpty': 'No archived session',
  'panel.resume.archive': 'Archive',
  /** The row action's tooltip when a live child holds the id — archiving would
   *  edit a session file something else is still writing. */
  'panel.resume.archiveLive': 'Running — cannot archive',
  'panel.resume.unarchive': 'Unarchive',
  'panel.resume.archivedTag': 'archived',
  'panel.mcp.title': 'MCP servers',
  'panel.mcp.empty': 'No server configured',
  'panel.mcp.notes': 'This batch',
  'panel.skills.title': 'Skills',
  'panel.skills.empty': 'No skill available',
  'panel.skills.skipped': 'skipped',
  'panel.skills.loaded': 'loaded',
  /** The catalogue minus the loaded set: what could still be loaded. */
  'panel.skills.available': 'Available to load',
  /** The sentence behind the `?` on the "loaded" group: what the two lists
   *  mean, in one breath. */
  'panel.skills.hint':
    'Loaded skills are active in this session. Available ones load on demand when a task matches one of them.',
  'panel.skills.refresh': 'Re-read the skill directories',
  'panel.skills.problems': 'Problems',
  'panel.skills.shadowed': 'Shadowed',

  /* ---- workspace: files ---- */
  'panel.files.title': 'Files',
  'panel.files.empty': 'This directory is empty',
  'panel.files.loading': 'Reading the directory…',
  'panel.files.root': 'workspace root',
  /** Picker mode (the plus menu's "workspace file"): the note that says what
   *  picking a row does, in place of the path note the browser shows. */
  'panel.files.pick': 'pick a file to attach it to the message',
  'panel.files.parent': 'Up one level',
  /* `panel.files.dir` ('directory') was never read: the panel marks a directory
     with a trailing `/` and an icon, which is the runtime's own `type` shown as
     itself rather than a word repeating it. */
  'panel.files.lines': '{n} lines',
  'panel.files.truncated':
    'Showing the first {chars} characters. The whole body is stored as {id}.',
  'panel.files.failed': 'Could not read it',
  'panel.files.reading': 'reading…',
  /** Focus mode with no view: the panel was opened for a file but no session is
   *  live, so there is no workspace to resolve the path against. */
  'panel.files.noSession': 'No session is running, so there is no workspace to read it from.',
  /* ---- workspace: terminals ---- */
  'panel.term.title': 'Terminals',
  'panel.term.empty': 'No terminal open in this workspace',
  'panel.term.new': 'New terminal',
  'panel.term.kill': 'End this terminal',
  'panel.term.killConfirm': 'Press again to end it',
  /* Closing a tab: two different acts behind one button, and the label says
     which will happen. An ended shell is only forgotten — nothing is lost but
     the record — while a running one has to be **ended first**, because the
     runtime will not forget a terminal whose process is alive. */
  'panel.term.close': 'Close this tab',
  'panel.term.closeRunning': 'End this terminal and close its tab',
  'panel.term.closeRunningConfirm': 'Press again to end it and close the tab',
  'panel.term.detach': 'Back to the conversation (the shell keeps running)',
  'panel.term.leave': 'Back to the conversation',
  /* `panel.term.attach` ('Type into it') and `panel.term.detached` were here with
     no reference anywhere: the first described a state the pane does not draw,
     and the second duplicated the sentence that now lives at `note.term.detached`
     — where the store's own note actually reads it. A key nobody reads is a
     sentence somebody believes is on screen. */
  'panel.term.leaveHint': 'Ctrl+Shift+\\ also goes back; the shell keeps running.',
  'panel.term.running': 'running',
  'panel.term.exited': 'exited ({code})',
  'panel.term.exitedNoCode': 'exited',
  'panel.term.killed': 'killed',
  'panel.term.cwdRoot': 'workspace root',
  'panel.term.hint':
    'Keys go to the shell byte for byte: Ctrl+C interrupts its command, arrows move in it. Nothing is interpreted by this window.',
  'panel.term.dropped': 'Earlier output scrolled out of this buffer.',
  'panel.term.outline': 'The runtime keeps no output — this buffer is this window’s own.',

  /* ---- what this window itself says about a terminal ----
   *
   * Distinct from a runtime `notice`, whose text is displayed verbatim. These
   * are this front end's own sentences, so they are built from a code plus
   * parameters (`FrontMessage`) rather than assembled in the store. The three
   * endings stay three sentences: a killed shell did not choose an exit status,
   * so printing a number for it would invent one. */
  'note.term.endedKilled': 'Terminal {id} was killed.',
  'note.term.ended': 'Terminal {id} exited.',
  'note.term.endedCode': 'Terminal {id} exited with code {code}.',
  'note.term.detached': 'Terminal {id} is still running.',
  'panel.help.title': 'Help',
  'panel.help.commands': 'Commands',
  'panel.help.keys': 'Keybindings',
  'panel.subagents.title': 'Subagents & jobs',
  'panel.subagents.empty': 'No subagent in flight',
  'panel.subagents.background': 'bg',
  'panel.subagents.done': 'Finished, waiting to be collected',
  'panel.subagents.uncollected': 'The answer is waiting for the parent to collect it (subagent_output).',
  'panel.subagents.stop': 'Stop this background subagent',
  'panel.timing.title': 'Turn time',
  'panel.timing.desc': 'Where this turn\'s wall time went',
  'panel.timing.empty': 'No turn has run yet',
  'panel.timing.run': 'turn total',
  'panel.timing.model': 'model',
  'panel.timing.tool': 'tools',
  'panel.timing.waited': 'approval wait',
  'panel.timing.human': 'answer wait',
  'panel.timing.backoff': 'retry backoff',
  'panel.timing.saved': 'parallel saved',
  'panel.timing.unattributed': 'other',
  'panel.audit.title': 'Audit & wiring',
  'panel.audit.path': 'Log path',
  'panel.audit.workspace': 'Workspace',
  'panel.audit.desktopVersion': 'Desktop version',
  'panel.audit.runtimeVersion': 'Runtime version',
  'panel.audit.protocol': 'Protocol',
  'panel.audit.dropped': 'Lines rejected by the decoder',
  'panel.audit.droppedNote':
    'Malformed or unknown: half a line, usage prose on stdout, a type this build does not know.',
  'panel.audit.late': 'Late messages dropped',
  'panel.audit.lateNote':
    'A turn-scoped message from another turn. Session-level records (pictures, compaction, goal rounds, delegations) are never counted here — their run_id does not name a turn.',
  'panel.audit.provider': 'Provider',
  'panel.audit.contextWindow': 'Context window',
  'panel.audit.permissions': 'Non-default permissions',
  'panel.audit.granted': 'Granted this session',
  'panel.audit.none': 'none',
  'panel.audit.agentsMd': 'AGENT.md / AGENTS.md',

  /* ---------------- settings ---------------- */
  'panel.settings.title': 'Settings',
  'panel.settings.note':
    "Start-up arguments for this session's runtime — applying one restarts it.",
  'panel.settings.launch': 'Start-up arguments',
  'panel.settings.launchHint':
    'These are the arguments the running runtime was started with. Changing one restarts it.',
  'panel.settings.inForce': 'in force',
  'panel.settings.notInForce': 'restart to apply',
  'panel.settings.running': 'Running now',
  'panel.settings.ericai': 'EricAI token',
  'panel.settings.ericaiDesc':
    'Keep this session’s EricAI token fresh: checked at start-up, refreshed before a stale one would be used.',
  /* The long side-effect sentence, behind the `?` rather than in the row: the
     row says what the switch does, the icon says what it is allowed to do to
     the person's machine. */
  'panel.settings.ericaiDetail':
    'Turning this on lets the runtime rewrite providers.ericai.api_key in your configuration file and keep a refresh token under ~/.tudouni/. It takes effect on the session on screen after the restart, and it is remembered: every session started from then on — new ones, other workspaces, the next launch — comes up with the token managed. Sessions already running are unaffected.',
  'panel.settings.maxSteps': 'Step cap',
  'panel.settings.maxStepsDesc':
    'How many model calls one turn may take. Empty means the runtime’s own default.',
  'panel.settings.maxStepsDefault': 'runtime default',
  'panel.settings.maxStepsInvalid': 'A whole number above zero, or empty.',
  'panel.settings.apply': 'Apply and restart',
  'panel.settings.restart': 'Restart the runtime?',
  'panel.settings.restartWhy':
    'The runtime is reading these at open, so it has to be started again. The turn on screen is finished; the session is kept.',
  'panel.settings.restartYes': 'Restart',
  'panel.settings.restartNo': 'Cancel',
  'panel.settings.blockedTurn': 'A turn is in flight — finish or stop it first.',
  'panel.settings.blockedModal': 'Answer the prompt first.',
  'panel.settings.blockedBooting': 'The runtime is still starting.',
  /* ---- the second group: this window's own behaviour ----
   *
   * No confirmation and no restart, because none of it reaches the runtime. The
   * heading says so plainly rather than leaving it to be inferred from the
   * absence of an Apply button. */
  'panel.settings.window': 'This window',
  'panel.settings.windowHint':
    'These are kept for this application as a whole and take effect at once — no restart, and nothing is sent to the runtime.',
  'panel.settings.notify': 'Session notifications',
  'panel.settings.notifyDesc':
    'A system notification when a session asks for an answer, fails, or finishes while you are looking at something else.',
  'panel.settings.close': 'Closing the window',
  'panel.settings.closeDesc': 'What the X button does.',
  'panel.close': 'Close',
  /* The second surface's way back to the first — the head's leading arrow on
     Configuration's editors and on the tasks history. One key, because it means
     one thing; the label names where it goes, not the gesture. */
  'panel.back': 'Back to the list',

  /* ---------------- the configuration files ----------------
   *
   * A panel of its own rather than a third group inside Settings, and the copy
   * is where that has to be legible: nothing here restarts anything, and nothing
   * here reaches a running session. What it edits is the file a session reads
   * *when it opens*, which is why the effect sentence is a statement about next
   * time rather than a badge about now. */
  'panel.config.title': 'Configuration',
  /* The `?` beside the title. A definition of the panel, not of a field — it is
     the sentence somebody wants before they start reading the rest. */
  'panel.config.about':
    'Provider routes, the web-search keys and the MCP servers a session is built from. Both files are read when a session opens.',
  'panel.config.unreadable': 'The configuration files could not be read.',
  /* The list rows' copy. "No key" and "default" are the two facts a route row
     carries beyond its name: the first is `Provider.Usable()`, the second is
     `Registry.DefaultProvider`'s rule (the first route with a key) said where the
     order is decided rather than only in the hint above the list. */
  'panel.config.defaultRoute': 'default',
  'panel.config.tlsOff': 'TLS not verified',
  'panel.config.noBaseUrl': 'no base URL',
  'panel.config.noInvocation': 'nothing configured yet',
  'panel.config.envCount': '{n} env var(s)',
  'panel.config.timeoutValue': '{n}s timeout',
  'panel.config.routeEmpty': 'No route yet',
  'panel.config.routeEmptyHint':
    'A route is one provider endpoint: a name, a base URL and an API key. The first route with a key is the one used by default.',
  'panel.config.mcpEmpty': 'No MCP server yet',
  'panel.config.mcpEmptyHint':
    'Add a command the runtime runs on this machine, or a URL it connects to when a session starts.',
  /* The rows' menus. Each sentence names its own noun, the way the tasks menu
     does ("Delete this task"): a row's overflow is read out of context by anyone
     using a screen reader, and "Remove" alone would leave them guessing what. */
  'panel.config.edit': 'Edit',
  'panel.config.duplicateRoute': 'Duplicate this route',
  'panel.config.duplicateServer': 'Duplicate this server',
  'panel.config.removeConfirm': 'Remove? Click again to confirm',
  'panel.config.moreRoute': 'More actions for this route',
  'panel.config.moreServer': 'More actions for this server',
  /* The editors. The note is the same on both because it is a fact about the
     dialog rather than about a route: what is on screen is a draft, and the file
     is written by the Save at the foot. */
  'panel.config.editRoute': 'Edit route',
  'panel.config.newRoute': 'New route',
  'panel.config.editServer': 'Edit server',
  'panel.config.newServer': 'New server',
  'panel.config.editorNote': 'Edits stay in this draft until you press Save.',
  'panel.config.sectionIdentity': 'Identity',
  'panel.config.sectionEndpoint': 'Endpoint',
  'panel.config.sectionAdvanced': 'Advanced',
  'panel.config.sectionServer': 'Server',
  'panel.config.sideStatus': 'Availability',
  'panel.config.sideStatusHint':
    'A route with no key, or with no models, is in the file and cannot be selected.',
  'panel.config.factSelectable': 'Selectable',
  'panel.config.factModels': 'Models',
  'panel.config.factDefault': 'Default',
  'panel.config.routes': 'Routes',
  'panel.config.routesHint':
    'One entry per provider route. The key is the route name; the order is the order the /model list shows, and the first route with a key is the default.',
  'panel.config.web': 'Web search',
  'panel.config.webHint': 'The keys the web_search tool uses.',
  'panel.config.webAbsent':
    'Leave them empty and web_search is not registered. fetch_web is unaffected — a missing key is not an error there.',
  'panel.config.tavilyKey': 'Tavily API key',
  'panel.config.tavilyBaseUrl': 'Tavily base URL',
  'panel.config.tavilyBaseUrlHint': 'Empty uses the runtime’s own default.',
  'panel.config.mcp': 'MCP servers',
  'panel.config.mcpHint':
    'Servers the runtime connects at start-up. A command runs locally; a URL is a remote server.',
  'panel.config.name': 'Name',
  'panel.config.nameHint': 'The key in the file, and what /model and the panels show.',
  /** What the asterisk on a field means, said in words for the readers the
   *  asterisk itself does not reach: `sr-only` for a screen reader, and the same
   *  sentence as the mouse's tooltip. Which fields carry the marker is decided
   *  by `validateDraft`'s `blocking` list, not here — see `Field`. */
  'panel.config.required': 'Required',
  'panel.config.requiredHint': 'The save is refused while this is empty.',
  'panel.config.untitled': 'untitled',
  'panel.config.baseUrl': 'Base URL',
  'panel.config.apiKey': 'API key',
  'panel.config.apiStyle': 'Protocol',
  'panel.config.apiStyleHint': 'Leave it on “infer” unless this endpoint needs otherwise.',
  'panel.config.apiStyleAuto': 'infer from the URL',
  'panel.config.displayName': 'Display name',
  'panel.config.displayNameHint': 'Optional. Shown instead of the route name.',
  /* The switch is worded as **verify**, not as "skip verifying". The file stores
     the second (`verify: false`), and the field used to be labelled with it — a
     switch whose *on* state means "do not do the safe thing" is a control people
     misread exactly once each. The hint below still reads correctly against the
     new label, because it says what turning it off means. */
  'panel.config.verifyCert': 'Verify the certificate',
  'panel.config.verifyHint':
    'On by default. Only turn this off for an endpoint whose certificate does not check out.',
  'panel.config.transportHint':
    'The runtime refuses a server that names both a command and a URL, so switching transports clears the other one.',
  'panel.config.headers': 'Extra headers',
  'panel.config.headersHint': 'One per line, name = value. Sent with every request to this route.',
  'panel.config.pairsHint': 'One per line, name = value.',
  'panel.config.effortLevels': 'Thinking levels',
  'panel.config.effortLevelsHint':
    'One per line; applies to every model on this route. Empty offers the whole vocabulary.',
  'panel.config.models': 'Models',
  /** The count a folded route card still shows. `(s)` rather than a plural
   *  rule, matching `panel.config.blocked` — the catalogue is English-only and
   *  interpolation deliberately stops at `{name}`. */
  'panel.config.modelCount': '{n} model(s)',
  'panel.config.modelsHint':
    'A route with no models cannot be selected. Leave the context window empty rather than guessing — a wrong percentage is worse than none.',
  'panel.config.modelId': 'Model id',
  'panel.config.modelLabel': 'Label',
  'panel.config.contextWindow': 'Context window',
  'panel.config.contextWindowHint':
    'In tokens. Empty means the interface reports usage without a percentage.',
  'panel.config.contextWindowAbsent': 'not set',
  'panel.config.reasoningEffort': 'Starts at',
  'panel.config.reasoningEffortHint':
    'The thinking level this model starts on. Empty means the default.',
  'panel.config.modelEffortLevels': 'Thinking levels',
  'panel.config.modelEffortLevelsHint': 'One per line. Overrides the route’s list for this model.',
  'panel.config.vision': 'Pictures',
  'panel.config.visionOn': 'This model accepts images',
  'panel.config.visionHint': 'Off unless the model takes them.',
  'panel.config.noKey': 'no key',
  'panel.config.mcpTransport': 'Transport',
  'panel.config.mcpStdio': 'Command',
  'panel.config.mcpRemote': 'URL',
  'panel.config.mcpCommand': 'Command',
  'panel.config.mcpArgs': 'Arguments',
  'panel.config.mcpArgsHint': 'One per line, verbatim — each line is one argument.',
  'panel.config.mcpUrl': 'URL',
  'panel.config.mcpHeaders': 'Headers',
  'panel.config.mcpEnv': 'Environment',
  'panel.config.mcpTimeout': 'Timeout',
  'panel.config.mcpTimeoutHint': 'Seconds. Empty means the runtime’s own default.',
  'panel.config.mcpAutoLoad': 'Session start',
  'panel.config.mcpAutoLoadOn': 'Mount this server when a session opens',
  'panel.config.mcpAutoLoadHint':
    'Off means it waits for /mcp. Mounting only starts the server — every tool it offers is still high risk and every call still needs your approval.',
  'panel.config.addRoute': 'Add a route',
  'panel.config.addModel': 'Add a model',
  'panel.config.addServer': 'Add a server',
  'panel.config.removeRoute': 'Remove this route',
  'panel.config.removeModel': 'Remove this model',
  'panel.config.removeServer': 'Remove this server',
  'panel.config.moveUp': 'Move up',
  'panel.config.moveDown': 'Move down',
  'panel.config.showKeys': 'Show keys',
  'panel.config.hideKeys': 'Hide keys',
  'panel.config.save': 'Save',
  'panel.config.saving': 'Saving…',
  'panel.config.revert': 'Discard changes',
  'panel.config.saved': 'Saved',
  'panel.config.unsaved': 'Unsaved changes',
  'panel.config.readOnly': 'This file cannot be written — see above.',
  'panel.config.blocked': '{n} problem(s) have to be fixed first.',
  'panel.config.missing':
    'The file does not exist yet. Saving creates it with only what is on this screen.',
  'panel.config.reveal': 'Show the file in the file manager',
  'panel.config.effect':
    'Saved now, read the next time a session starts. A session that is already running keeps the configuration it opened with.',

  /* ---------------- in-stream blocks ---------------- */
  'inblock.status.title': 'Current status',
  'inblock.tools.title': 'Tools & permissions',
  'inblock.context.title': 'Context ledger',
  'inblock.compact.title': 'Compaction result',
  'inblock.section': 'Group',
  'inblock.key': 'Key',
  'inblock.value': 'Value',
  'inblock.tokens': 'token',
  'inblock.noContext': 'no context management in this runtime',
  'inblock.noContextLayer': 'no context layer in this runtime',
  'inblock.degraded': '{n} items degraded',
  'inblock.note': 'Note',
  'inblock.used': 'Used',
  'inblock.window': 'Window',
  'inblock.before': 'Before',
  'inblock.after': 'After',
  'inblock.folded': 'Folded',
  'inblock.totalFolded': 'Total folded',
  'inblock.summaryChars': 'Summary chars',
  'inblock.duration': 'Duration',
  'inblock.status': 'Status',
  'inblock.remembered': 'rule remembered',
  'inblock.notRemembered': 'asked every time',
  'inblock.denied': 'denied',
  'inblock.auto': 'auto',
  'inblock.ask': 'ask',

  /* ---------------- approval modal ---------------- */
  'perm.title': 'Waiting for your approval',
  'perm.subtitle': 'The runtime is blocked here until you decide.',
  'perm.tool': 'Tool',
  'perm.origin': 'Origin',
  'perm.risk': 'Risk',
  'perm.params': 'Arguments (full, never truncated)',
  'perm.safety': 'Safety',
  'perm.hintLabel': 'From the runtime',
  'perm.action.allow': 'Allow',
  'perm.action.deny': 'Deny',
  'perm.action.always': 'Always allow',
  'perm.action.allowAll': 'Allow all',
  'perm.denySameAsClose': 'Deny is the same as closing',
  'perm.escalate': 'High-risk call — read the arguments character by character.',
  'perm.callId': 'call',

  'risk.low': 'LOW',
  'risk.medium': 'MED',
  'risk.high': 'HIGH',

  /* ---------------- question modal ---------------- */
  'q.title': 'Waiting for your answer',
  'q.subtitle': 'The runtime is blocked here until you answer.',
  'q.multi': 'multi-select',
  'q.single': 'single choice',
  'q.options': 'Options',
  'q.freeText': 'Free text',
  'q.freeTextPlaceholder': 'Type your answer…',
  'q.skip': 'Skip',
  'q.submit': 'Submit',
  'q.freeTextPriority': 'Free text wins over the selection',
  'q.noOptions': 'No preset options — answer in free text.',
  'q.pickAtLeastOne': 'Pick an option, type an answer, or use “Skip”.',

  /* ---------------- closing the window ----------------
   *
   * The prompt the title bar's X raises, now that the button means two things.
   * `{count}` is how many sessions are open, so the sentence can say what
   * "close" would actually end — with several running, that is the fact that
   * decides the answer. */
  'close.title': 'Minimize to tray or close?',
  'close.subtitle': 'Closing ends every session; minimizing to the tray keeps them running.',
  'close.minimize': 'Minimize to tray',
  'close.minimizeHint': 'Hide the window to the system tray. Every session keeps running.',
  'close.close': 'Close',
  'close.closeHint': 'Finish every session, then exit.',
  'close.remember': 'Remember this choice',
  'close.rememberHint': 'Change it later under Settings.',
  /** How many conversations "close" would end. Plural-blind like the rest of
   *  this table (`{n} items`), and the count is this front end's own (`order`). */
  'close.sessions': '{n} sessions open',
  /* The same three values the prompt offers, named for the settings row, which
     has room to spell out what "ask" means. */
  'close.policy.ask': 'Ask every time',
  'close.policy.minimize': 'Minimize to tray',
  'close.policy.close': 'Close',
  /* What the window will do next time, under the setting. A remembered choice is
     reported as a sentence rather than left to be inferred from which radio is
     filled: with three options the selection is a fact about the future, not
     just about the control. */
  'close.policy.summaryAsk': 'The X button asks, the same as now.',
  'close.policy.summaryMinimize': 'The X button hides the window to the system tray; sessions keep running.',
  'close.policy.summaryClose': 'The X button finishes every session and exits.',

  /* ---------------- system notifications ----------------
   *
   * The four transitions worth a toast. Each title is a sentence a person can
   * act on, and they are deliberately not "the session changed state": the
   * reason to interrupt somebody is that something wants them. */
  'notify.title.needsYou': 'Waiting for your answer',
  'notify.title.failed': 'Stopped with an error',
  'notify.title.finished': 'Finished',

  /* ---------------- composer ---------------- */
  'composer.placeholder': 'Say something…',
  'composer.blocked': 'Resolve the prompt above first',
  'composer.send': 'Send',
  /** The `+` at the left of the control row: it opens the plus menu — files,
   *  skills, commands. Named for what it offers rather than for the glyph,
   *  since a bare "+" says nothing about where it leads. */
  'composer.tools': 'Add files, skills and commands',
  /** The plus menu's entries (`PlusMenu.tsx`). */
  'plus.file': 'Add file',
  'plus.workspaceFile': 'Workspace file',
  'plus.browse': 'Browse…',
  'plus.skills': 'Skills',
  'plus.commands': 'Commands',
  /** The workspace-file entry, disabled: there is no tree to walk yet. */
  'plus.noWorkspace': 'no workspace',
  /** The row of attached files beside the pasted pictures. Its accessible
   *  name, not a visible heading: the chips are self-explanatory. */
  'composer.files': 'Attached files',
  'composer.removeFile': 'Remove this file',
  'composer.hint.send': 'Enter sends · Shift+Enter newlines',
  /* The running turn's toolbar sentence: what is happening, then how to stop it.
     The stop button beside it says the same thing by shape; this is the readable
     half, and the reason the hint area is not blank while a turn runs. */
  'composer.hint.streaming': 'Streaming… Esc to stop',
  'composer.hint.modal': 'The runtime is blocked by a modal — answer it to continue',
  'composer.dropHint': 'Drop a file to insert its path, or drop it in the workspace — pictures are attached by naming their path',
  'composer.dropOutside': 'not in this workspace, so the runtime could not read it: {names}',
  'composer.dropNoWorkspace': 'no workspace yet, so nothing can be checked: {names}',
  /** The row of pasted pictures above the input. Its accessible name, not a
   *  visible heading: the chips are self-explanatory beside the box. */
  'composer.images': 'Pasted pictures',
  'composer.removeImage': 'Remove this picture',
  'composer.pasteNoWorkspace': 'no workspace yet, so there is nowhere to put the picture',
  'composer.pasteAtCapacity':
    'this message already carries {limit} pictures, which is the limit for one message',
  'composer.pasteTooLarge': 'that picture is {size}, over the {limit} ceiling for one picture',
  'composer.pasteNotAnImage':
    'the clipboard’s image data is not a PNG, JPEG or GIF — those are the three formats this program can measure',
  /** Not a refusal: the turn still runs, with the path in the sentence. Said
   *  because the alternative is a person attaching a screenshot, getting an
   *  answer about the words, and having to work out why. */
  'composer.pasteNoVision':
    'the model in use ({model}) cannot be shown pictures — this one is named in the sentence but will not be sent',
  'composer.pasteFailed': 'the picture could not be written: {reason}',

  /* ---------------- commands ---------------- */
  'cmd.new.desc': 'Start from a clean context',
  'cmd.resume.desc': 'List past sessions, newest first',
  'cmd.audit.desc': 'Where session and audit files land on disk',
  'cmd.exit.desc': 'Ask the runtime to shut down',
  'cmd.help.desc': 'The full version of this table',
  'cmd.skills.desc': 'Includes skipped skills and why',
  'cmd.autopilot.desc': 'Run without asking for approval',
  'cmd.quiet.desc': 'Collapse tool calls into a one-line brief',
  'cmd.status.desc': 'Insert a status snapshot into the stream',
  'cmd.tools.desc': 'List tools, risk level, remembered rules',
  'cmd.context.desc': 'Token usage and the compaction ledger',
  'cmd.compact.desc': 'Compact history; deletes nothing',
  'cmd.model.desc': 'Same-name models on different routes listed separately',
  'cmd.thinking.desc': 'Whether the model reasons before answering',
  'cmd.effort.desc': 'Options change with the current model',
  'cmd.mcp.desc': 'Three states, and load / unload a server',
  'cmd.goal.desc': 'Inspect and control the long-term goal',
  'cmd.files.desc': 'Browse the workspace files',
  'cmd.terminal.desc': 'Terminals in this workspace',

  /* ---------------- keys ---------------- */
  'key.send': 'Send',
  'key.newline': 'Newline in the input',
  'key.esc': 'Close modal / interrupt turn / deny',
  'key.move': 'Move in a list / scroll the stream',
  'key.thinking': 'Collapse or expand reasoning',
  'key.sidebar': 'Collapse or expand the sidebar',
  'key.leftbar': 'Collapse or expand the workspace sidebar',
  'key.palette': 'Open the command palette',
  'key.skills': 'Open the skills panel',
  'key.edit': 'Line start/end, delete word/line, word move',
  'key.pick': 'Confirm / close / numeric pick in a panel',
  'key.history': 'Browse input history',
  'key.quiet': 'Toggle quiet mode',
  'key.find': 'Find in this conversation',

  /* ---------------- misc ---------------- */
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.back': 'Back',
  'common.confirm': 'Confirm',
  'common.none': 'none',
  'common.unknown': 'unknown',
  /* The two answers a fact line can carry (Configuration's availability card).
     Lower-case on purpose: they are values in a `label: value` row, not sentences. */
  'common.yes': 'yes',
  'common.no': 'no',
  'common.count': '{n} items',
  'common.working': 'working',
  'common.loading': 'loading…',
  /* `common.sidebarHidden` ("Sidebar hidden") and `common.show` ("Show") lived
     here and are gone with the rest of the row they belonged to: the summary row
     no longer announces the fold or offers to undo it. Both jobs are now done by
     the two toggles at the ends of the session bar, which are on screen in *both*
     states — see `CollapsedSummary`. */
  /** The status bar's rate chip. The average over the last successful call,
   *  the same figure the model row draws — the bar is where "how fast is this
   *  endpoint right now" gets read without hunting through the transcript. */
  'status.outputRate': 'avg {rate} tok/s',
  'common.jumpLatest': 'Jump to latest',
  'common.andMore': 'and {n} more',

  /* ---------------- stream ---------------- */
  /** The scroll region's accessible name. It is also the `aria-live` region, so
   *  new answers and notices are announced rather than silently appearing. */
  'stream.label': 'Session transcript',
  /** Copy button on a fenced code block (`Markdown.tsx`). */
  'md.codeCopy': 'Copy code',
  'md.codeCopied': 'Copied',
  /** A picture the model named but this window will not draw: an unsupported
   *  scheme or media type (`MarkdownImage.tsx`). Shown as the picture's tooltip,
   *  so it has to read as the reason, not as a label. */
  'md.imageUnsupported': 'This is not a picture this window can draw',
  /** Same row, when the destination is a relative path but no workspace is known
   *  yet — the handshake has not landed, so the path has no root to resolve
   *  against. Transient, but it has to say something. */
  'md.imageNoWorkspace': 'This picture is relative to a workspace that is not open yet',
  /** The renderer accepted the address but decoding it failed, or the bridge
   *  returned bytes the WebView could not display. */
  'md.imageFailed': 'This picture could not be drawn',
  /** The transcript caps a picture at 60vh; this is the way past it, so the
   *  title has to say what pressing does rather than name the feature. */
  'md.imageOpen': 'Open at full size',
  'md.imageClose': 'Close the picture',
  /** The turn rail down the transcript's right edge (`TurnRail.tsx`). */
  'rail.label': 'Turn navigation',
  /** One mark's accessible name. It has to say what the press does **and** which
   *  turn, or a screen reader user hears "button" some hundreds of times. */
  'rail.jump': 'Jump to turn {n}',

  /* ---------------- find in the conversation (`Ctrl+F`) ---------------- */
  /** The bar's own name, and the search box's: one region, one label, and the
   *  box is the only control in it. */
  'find.label': 'Find in this conversation',
  'find.placeholder': 'Find…',
  /** How many hits, and which one the reader is on. `{n}` is 0 in one real case:
   *  the hit they were on was in a streamed body the final answer replaced, so
   *  there is a set of matches but none of them is current. */
  'find.count': '{n} of {total}',
  'find.none': 'no matches',
  'find.next': 'Next match',
  'find.prev': 'Previous match',
  'find.close': 'Close find',

  /* ---------------- workspace memory ----------------
   *
   * One panel, two columns: how recall behaves on the left, what the workspace
   * knows on the right. The labels are the runtime's vocabulary rather than new
   * words for the same things — `config.json`, the candidate queue and `mem_` ids
   * all appear in the files a person may open, and a screen that renamed them
   * would send somebody looking for a file that does not exist.
   */
  'lb.memory': 'Workspace memory',
  'lb.memoryHint': 'What this workspace has learned, and what is waiting to be reviewed',
  'panel.memory.title': 'Workspace memory',
  'panel.memory.note': 'Markdown is the record; the index is rebuilt from it.',
  'panel.memory.loading': 'Reading this workspace’s memory…',
  'panel.memory.noSession': 'No conversation is open, so there is no runtime to ask.',
  'panel.memory.failed': 'This workspace’s memory could not be read',
  'panel.memory.empty': 'Nothing recorded yet',
  'panel.memory.emptyHint': 'Approved memories land here and get indexed for recall.',
  /** The review queue. Its head has to say what "waiting" means — a proposal is
   *  inert by design, and a row that looked like a memory would make approving
   *  look like a formality. */
  'panel.memory.review': 'Waiting for review',
  'panel.memory.reviewEmpty': 'Nothing waiting',
  'panel.memory.recorded': 'On record',
  'panel.memory.behavior': 'Behavior',
  'panel.memory.tuning': 'Recall tuning',
  'panel.memory.enabled': 'Workspace memory',
  'panel.memory.enabledHint': 'Off stops recall and ignores proposals. Files stay on disk.',
  'panel.memory.autoInject': 'Inject recalled memories',
  'panel.memory.autoInjectHint': 'Off still lets you search memory by hand.',
  'panel.memory.turnStart': 'Look up when a turn starts',
  'panel.memory.turnStartHint': 'Matches your own words at the start of each turn.',
  'panel.memory.toolFailure': 'Look up when a tool fails',
  'panel.memory.toolFailureHint': 'Matches the error text — where a remembered fix helps most.',
  'panel.memory.maxRecall': 'Memories per recall',
  'panel.memory.maxResults': 'Results per search',
  'panel.memory.minScore': 'Relevance floor',
  'panel.memory.entryChars': 'Characters per memory',
  'panel.memory.noteChars': 'Characters per block',
  'panel.memory.decrease': 'Decrease {label}',
  'panel.memory.increase': 'Increase {label}',
  'panel.memory.save': 'Save changes',
  /** Where a saved config takes effect. **This session now, not "new sessions"**:
   *  saving replaces the config of the runtime this panel is talking to, and the
   *  next turn in this session already uses it. A session already open in another
   *  window is a different runtime with its own loaded copy, so it keeps the old
   *  numbers until it is reopened — which is the second half of the sentence. */
  'panel.memory.saveNote': 'Applies to this session now, and to sessions opened later.',
  'panel.memory.dirty': 'Unsaved changes',
  'panel.memory.reset': 'Reset to defaults',
  'panel.memory.approve': 'Approve',
  'panel.memory.discard': 'Discard',
  'panel.memory.proposed': 'proposed {when}',
  'panel.memory.read': 'Read',
  'panel.memory.hide': 'Hide',
  'panel.memory.updated': 'updated {when}',
  'panel.memory.chars': '{n} chars',
  'panel.memory.deprecate': 'Deprecate',
  'panel.memory.deprecateConfirm': 'Confirm',
  'panel.memory.deprecateCancel': 'Cancel',
  'panel.memory.deprecateReason': 'Why is it no longer true? (optional)',
  'panel.memory.rebuild': 'Rebuild index',
  'panel.memory.indexLine': '{n} memories indexed · built {when}',
  'panel.memory.rebuilt': 'rebuilt this session',
  'panel.memory.unreadable': 'Files that could not be read',
  'panel.memory.confidence.verified': 'verified',
  'panel.memory.confidence.observed': 'observed',
  'panel.memory.confidence.inferred': 'inferred',
  'panel.memory.confidenceHint':
    'Evidence, not content type: verified was reproduced, observed was seen once, inferred was deduced.',
  'panel.memory.op.create': 'adds a memory',
  'panel.memory.op.update': 'changes {id}',
  'panel.memory.op.deprecate': 'retires {id}',
  'panel.memory.noTriggers': 'no triggers',
  'panel.memory.problem': 'The last change did not take effect',
} as const;

export type TKey = keyof typeof en;

export type Translate = (key: TKey, params?: Record<string, string | number>) => string;

/** Minimal interpolation: `{name}` only. No plurals, no genders — predictable
 *  and enough. */
export function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

export function makeT(): Translate {
  return (key, params) => interpolate(en[key] ?? key, params);
}
