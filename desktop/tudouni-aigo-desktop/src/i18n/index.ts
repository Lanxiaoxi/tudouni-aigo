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
  'welcome.keys': 'Keybindings',
  'welcome.slotEmpty': 'empty',

  /* ---------------- stream entries ---------------- */
  'entry.turn': 'Turn {n}',
  'entry.turnRunning': 'in progress',
  'entry.turnDone': 'ended · completed',
  'entry.turnFailed': 'ended · failed',
  'entry.turnInterrupted': 'ended · interrupted',
  'entry.turnStepLimit': 'ended · step limit',
  'entry.turnEmpty': 'ended · empty response',
  'entry.you': 'you',
  'entry.assistant': 'model',
  'entry.model': 'model call',
  'entry.modelRetry': 'retry · waiting {ms}ms',
  'entry.modelMetrics': '{ms} · in {input} · cached {cached}',
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

  /* ---------------- left sidebar: workspaces and sessions ---------------- */
  'lb.workspaces': 'Workspaces',
  'lb.sessions': 'Sessions',
  'lb.newSession': 'New session',
  'lb.newSessionHint': 'Start from a clean context',
  'lb.addWorkspace': 'Add a workspace…',
  'lb.refreshSessions': 'Re-read the session list',
  'lb.collapse': 'Hide this sidebar',
  'lb.settings': 'Settings',
  'lb.show': 'Show the workspace sidebar',
  'rail.drag': 'Drag to resize the sidebar. Double-click to reset it.',
  'lb.foldSessions': 'Fold the session list',
  'lb.unfoldSessions': 'Unfold the session list',
  'lb.deleteSession': 'Delete this session',
  'lb.deleteConfirm': 'Delete? Click again to confirm',
  'lb.current': 'current',
  'lb.currentHint': 'The runtime is working in this directory',
  'lb.forget': 'Forget',
  'lb.forgetHint': 'Remove from this list. The directory itself is not touched.',
  'lb.emptyWorkspaces.title': 'No workspace listed',
  'lb.emptyWorkspaces.hint': 'Add the directory the runtime should work in.',
  'lb.emptySessions.title': 'No past session',
  'lb.emptySessions.hint': 'Sessions are written under .tudouni/ in this workspace.',
  'lb.sessionsUnread': 'Could not read the session list',
  'lb.workspaceBad': 'Cannot be used',
  'lb.openWorkspace': 'Open this workspace',

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

  /* Which conversation a blocking request belongs to, and how many are behind
     it. Both exist because a prompt with several sessions open is otherwise
     anonymous — see `selectModalOrigin`. */
  'modal.from': 'from',
  'modal.queued': '{n} more waiting',

  /* ---------------- sidebar blocks ---------------- */
  'block.goal': 'Goal',
  'block.tasks': 'Tasks',
  'block.skills': 'Loaded skills',
  'block.jobs': 'Background jobs',
  'block.mcp': 'MCP',
  'block.collapse': 'Collapse',
  'block.expand': 'Expand',

  'empty.goal.title': 'No goal',
  'empty.goal.hint': 'A long-term goal shows its phase and round count here.',
  'empty.tasks.title': 'No tasks yet',
  'empty.tasks.hint': 'Steps the model breaks out appear here with their status.',
  'empty.skills.title': 'No skill loaded',
  'empty.skills.hint': 'Matched skills load automatically and show up here.',
  'empty.jobs.title': 'No background jobs',
  'empty.jobs.hint': 'Long commands sent to the background show uncollected results here.',
  'empty.mcp.title': 'Nothing attached',
  'empty.mcp.hint': 'Open /mcp to load an external tool server.',

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
  'panel.files.parent': 'Up one level',
  /* `panel.files.dir` ('directory') was never read: the panel marks a directory
     with a trailing `/` and an icon, which is the runtime's own `type` shown as
     itself rather than a word repeating it. */
  'panel.files.lines': '{n} lines',
  'panel.files.truncated':
    'Showing the first {chars} characters. The whole body is stored as {id}.',
  'panel.files.failed': 'Could not read it',
  'panel.files.reading': 'reading…',
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
  'close.title': 'Minimize or close?',
  'close.subtitle': 'Closing ends every session; minimizing keeps them running.',
  'close.minimize': 'Minimize',
  'close.minimizeHint': 'Hide the window. Every session keeps running.',
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
  'close.policy.minimize': 'Minimize',
  'close.policy.close': 'Close',
  /* What the window will do next time, under the setting. A remembered choice is
     reported as a sentence rather than left to be inferred from which radio is
     filled: with three options the selection is a fact about the future, not
     just about the control. */
  'close.policy.summaryAsk': 'The X button asks, the same as now.',
  'close.policy.summaryMinimize': 'The X button hides the window; sessions keep running.',
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
  'composer.placeholder': 'Say something…  Enter sends, Shift+Enter newlines',
  'composer.blocked': 'Resolve the prompt above first',
  'composer.send': 'Send',
  /** The `+` at the left of the control row: it opens the command palette, the
   *  same panel `Ctrl+K` does. Named for what it offers rather than for the
   *  glyph, since a bare "+" says nothing about where it leads. */
  'composer.tools': 'Commands and panels',
  'composer.hint.send': 'Enter send · Shift+Enter newline · Esc interrupt',
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

  /* ---------------- misc ---------------- */
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.none': 'none',
  'common.unknown': 'unknown',
  'common.count': '{n} items',
  'common.working': 'working',
  'common.loading': 'loading…',
  'common.sidebarHidden': 'Sidebar hidden',
  'common.show': 'Show',
  'common.jumpLatest': 'Jump to latest',
  'common.andMore': 'and {n} more',

  /* ---------------- stream ---------------- */
  /** The scroll region's accessible name. It is also the `aria-live` region, so
   *  new answers and notices are announced rather than silently appearing. */
  'stream.label': 'Session transcript',
  /** The turn rail down the transcript's right edge (`TurnRail.tsx`). */
  'rail.label': 'Turn navigation',
  /** One mark's accessible name. It has to say what the press does **and** which
   *  turn, or a screen reader user hears "button" some hundreds of times. */
  'rail.jump': 'Jump to turn {n}',
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
