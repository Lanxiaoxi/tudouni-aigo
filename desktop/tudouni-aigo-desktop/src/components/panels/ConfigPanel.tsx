import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Clock,
  Copy,
  Eye,
  EyeOff,
  FolderOpen,
  KeyRound,
  Link2,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  Server,
  ShieldOff,
  Sparkles,
  Trash2,
  Waypoints,
} from 'lucide-react';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { Badge, Count, Info, PanelInfo, Tip } from '@/components/ui/kit';
import { readRemoteUserConfig, readUserConfig, revealConfigFile, writeRemoteUserConfig, writeUserConfig } from '@/runtime/tauri';
import { remoteConnectionOf, useApp } from '@/state/store';
import {
  API_STYLES,
  blockingProblems,
  buildPatch,
  draftFrom,
  emptyModel,
  emptyRoute,
  emptyServer,
  isDirty,
  linesOf,
  moved,
  pairsOfText,
  textOfLines,
  textOfPairs,
  validateDraft,
  type ConfigDocument,
  type Draft,
  type McpServerView,
  type ModelView,
  type Problem,
  type RouteView,
} from '@/runtime/userConfig';
import { PanelBody, PanelShell } from './PanelShell';

/**
 * The configuration files, as a form.
 *
 * **What this edits is the file, not the session.** `~/.tudouni/config.json` is
 * read once, when a child starts (`internal/runtime/composition.go` builds the
 * catalogue at open), so nothing here takes effect on a session that is already
 * running. That is why there is no restart confirmation and no "in force" badge:
 * the panel borrows neither, because neither is true. What it says instead is the
 * one fact that matters — a saved file is read the next time a session starts.
 *
 * **Two surfaces, one dialog — the task panel's shape.** Routes and MCP servers
 * are *collections*: several of them, each editable, each with an order that
 * means something. The task panel's answer to exactly that shape is the one taken
 * here: the list is a list of rows (a mark, a name, the facts, a fixed action
 * slot at the right edge), and one row opens one editor that fills the panel.
 * The panel used to draw every route as a card that unfolded in place, and its
 * own comment admitted the result: "with every card open, the list of routes is
 * not a list". The editor is where the fields went — the same fields, in the same
 * order, grouped into sections, with a tinted side card for the facts and the one
 * switch that is not a field.
 *
 * **The web-search tab has no second surface**, and that is not an omission: two
 * fields are a form, not a collection, and a list of one row that opens an editor
 * for two fields would be two clicks to type two values.
 *
 * **Saving applies the reply, not the draft.** `config_write` answers with the
 * files as they are afterwards, and this stores *that*: what the form shows next
 * is the file's own content, so a value the merge declined to keep cannot sit on
 * screen looking saved. The same rule governs the settings panel's argv display.
 * The footer is therefore the panel's, not the editor's: the draft is one
 * document, and a Save offered from the route editor that wrote only that route
 * would be a second, false statement about what the button does.
 *
 * **A file that could not be read is shown, not hidden.** Both files get a row
 * with their path and the sentence explaining what is wrong, and the save is
 * refused for the broken one while the other stays editable — they are two
 * files, they fail independently, and `config.json` is the one holding the keys
 * somebody came here to fix. The way out of a broken file is the folder button,
 * which is also the only affordance here that is not a form field.
 *
 * **`$comment` and unknown keys survive, because the merge is field-wise.** See
 * `src-tauri/src/config_file.rs`: existing route objects are *moved* into the new
 * order and mutated in place. This end's job is to send every route it read —
 * a route left out of the patch is a route removed from the file, and the order
 * is what decides the default route.
 *
 * **The row's marks and badges are facts, never controls.** "default" is
 * `Registry.DefaultProvider`'s rule (the first route with a key) shown where the
 * order is decided, instead of only in a hint sentence; "no key" is a state the
 * runtime reports as `Provider.Usable()` rather than a validation error; TLS not
 * verified is the one security-relevant value in the file, so it is on the row
 * that carries it.
 */
export function ConfigPanel() {
  const t = useT();

  const [doc, setDoc] = useState<ConfigDocument | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [tab, setTab] = useState<ConfigTab>('routes');
  /** Which row's editor is up, and whether it is one this panel just created —
   *  an untouched new row is discarded on the way back, the rule
   *  `TaskPanel`'s editor established for its own "New". */
  const [editing, setEditing] = useState<Editor | null>(null);

  // Read once, on open. There is nothing to poll: the file changes when somebody
  // changes it, and the panel is the only writer acting on behalf of this window
  // while it is up.
  //
  // **Which machine, though, is the question the old version never asked.** On a
  // remote screen the file the runtime reads is `~/.tudouni/config.json` *there*,
  // and this machine has a file with the same name at the same-looking path. The
  // panel used to edit this one, so a route added "on the server" went into the
  // local file and nothing changed — while the reveal button opened this
  // machine's folder, which is the clearest possible "you are on the wrong
  // machine" signal that said nothing at all.
  //
  // `configTarget()` answers from the screen's own bucket. `null` is a local
  // screen (or no session), and that keeps the original door exactly as it was.
  const configTarget = useApp((s) => s.configTarget);
  const noteRemoteConfigWritten = useApp((s) => s.noteRemoteConfigWritten);
  // The destination, for the badge and the tooltip — `remoteConnectionOf` is the
  // same "which host is this session on" answer the rail and the top bar use, and
  // it carries no credentials (the store's `configTarget` is where those are).
  const remote = useApp((s) => remoteConnectionOf(s, s.activeKey));
  useEffect(() => {
    let alive = true;
    void (async () => {
      const where = configTarget();
      const loaded =
        where === null ? await readUserConfig() : await readRemoteUserConfig(where.target);
      if (!alive) return;
      if (loaded === null) {
        setLoadProblem(t('panel.config.unreadable'));
        return;
      }
      setDoc(loaded);
      setDraft(draftFrom(loaded));
    })();
    return () => {
      alive = false;
    };
  }, [t, configTarget]);

  const problems: Problem[] = draft === null ? [] : validateDraft(draft);
  const blocking = blockingProblems(problems);
  const dirty = doc !== null && draft !== null && isDirty(doc, draft);
  const canSave = doc !== null && draft !== null && dirty && blocking.length === 0 && !saving;

  function editDraft(change: (draft: Draft) => Draft) {
    setDraft((current) => (current === null ? current : change(current)));
    // Any edit is a statement about a file that has not been written yet, so the
    // "saved" line stops being true the moment one is made.
    setSaved(false);
  }

  function updateRoute(index: number, patch: Partial<RouteView>) {
    editDraft((current) => ({
      ...current,
      providers: current.providers.map((route, i) => (i === index ? { ...route, ...patch } : route)),
    }));
  }

  function updateModel(routeIndex: number, modelIndex: number, patch: Partial<ModelView>) {
    editDraft((current) => ({
      ...current,
      providers: current.providers.map((route, i) =>
        i === routeIndex
          ? { ...route, models: route.models.map((model, j) => (j === modelIndex ? { ...model, ...patch } : model)) }
          : route,
      ),
    }));
  }

  function updateServer(index: number, patch: Partial<McpServerView>) {
    editDraft((current) => ({
      ...current,
      mcp: current.mcp.map((server, i) => (i === index ? { ...server, ...patch } : server)),
    }));
  }

  function addRoute() {
    // The row is written first and then opened, which is what makes the editor's
    // fields bind to something the draft already holds — and what makes "back"
    // able to take it away again. See `closeEditor`.
    const at = draft === null ? 0 : draft.providers.length;
    editDraft((current) => ({ ...current, providers: [...current.providers, emptyRoute()] }));
    setEditing({ kind: 'route', index: at, isNew: true });
  }

  function addServer() {
    const at = draft === null ? 0 : draft.mcp.length;
    editDraft((current) => ({ ...current, mcp: [...current.mcp, emptyServer()] }));
    setEditing({ kind: 'server', index: at, isNew: true });
  }

  /**
   * Duplicate a row, with a name the file will accept.
   *
   * **The name has to change.** Two routes with one name is a blocking problem
   * (`validateDraft`) — and it is blocking for a reason: the name is the key in
   * the file's `providers` object, so the second one would simply replace the
   * first. A copy that arrives already refusing the save would be a worse
   * duplicate than none, so the next free `(copy)`, `(copy 2)` … is used.
   */
  function duplicateRoute(index: number) {
    if (draft === null) return;
    const row = draft.providers[index];
    if (row === undefined) return;
    const taken = new Set(draft.providers.map((route) => route.name.trim()));
    const copy: RouteView = {
      ...row,
      name: copyName(row.name.trim(), taken),
      headers: row.headers.map((pair) => ({ ...pair })),
      effortLevels: [...row.effortLevels],
      models: row.models.map((model) => ({ ...model, effortLevels: [...model.effortLevels] })),
    };
    editDraft((current) => {
      const providers = [...current.providers];
      providers.splice(index + 1, 0, copy);
      return { ...current, providers };
    });
    // And it opens, so the name that was just invented is the thing under the
    // cursor rather than something to discover later.
    setEditing({ kind: 'route', index: index + 1, isNew: false });
  }

  function duplicateServer(index: number) {
    if (draft === null) return;
    const row = draft.mcp[index];
    if (row === undefined) return;
    const taken = new Set(draft.mcp.map((server) => server.name.trim()));
    const copy: McpServerView = {
      ...row,
      name: copyName(row.name.trim(), taken),
      args: [...row.args],
      env: row.env.map((pair) => ({ ...pair })),
      headers: row.headers.map((pair) => ({ ...pair })),
    };
    editDraft((current) => {
      const mcp = [...current.mcp];
      mcp.splice(index + 1, 0, copy);
      return { ...current, mcp };
    });
    setEditing({ kind: 'server', index: index + 1, isNew: false });
  }

  /**
   * Leave the editor. **A new row nobody typed into does not survive the trip**:
   * "Add a route" writes the row before the editor opens, so cancelling out of
   * one that was never filled in would leave blank litter on the list. Anything
   * typed keeps it — which is what makes the back button safe to press.
   */
  function closeEditor() {
    const open = editing;
    setEditing(null);
    if (open === null || !open.isNew || draft === null) return;
    const untouched =
      open.kind === 'route'
        ? JSON.stringify(draft.providers[open.index]) === JSON.stringify(emptyRoute())
        : JSON.stringify(draft.mcp[open.index]) === JSON.stringify(emptyServer());
    if (!untouched) return;
    editDraft((current) =>
      open.kind === 'route'
        ? { ...current, providers: current.providers.filter((_, i) => i !== open.index) }
        : { ...current, mcp: current.mcp.filter((_, i) => i !== open.index) },
    );
  }

  async function save() {
    if (doc === null || draft === null) return;
    setSaving(true);
    setSaveProblem(null);
    try {
      const where = configTarget();
      if (where === null) {
        const written = await writeUserConfig(buildPatch(doc, draft));
        setDoc(written);
        setDraft(draftFrom(written));
      } else {
        // The merge runs on the far host against the bytes it has **now**, and
        // the reply is that file re-read — the same contract as the local door,
        // so the two branches below stay one shape.
        const written = await writeRemoteUserConfig(where.target, buildPatch(doc, draft));
        setDoc(written.document);
        setDraft(draftFrom(written.document));
        // §9.5's baseline, moved to what was just written. Without this the next
        // open compares the host's file against the old baseline, concludes "the
        // remote file changed", and asks which side should win — about an edit
        // the person made in this very panel.
        if (written.configFingerprint !== null) {
          noteRemoteConfigWritten(where.hostId, written.configFingerprint);
        }
      }
      // The reply is the file as it now is, so a row this draft invented may not
      // exist in it any more — and an editor pointing at a row that is gone
      // would render nothing. Back to the list is the honest place to be.
      setEditing(null);
      setSaved(true);
    } catch (err) {
      // Propagated from Rust, where every refusal is a reason **nothing** was
      // written. Shown as-is rather than rephrased: it is the authority on why.
      setSaveProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loadProblem !== null) {
    return (
      <PanelShell title={t('panel.config.title')} note={loadProblem}>
        <PanelBody>
          <div className="cfg-problems">
            <div className="cfg-problem is-blocking">{loadProblem}</div>
          </div>
        </PanelBody>
      </PanelShell>
    );
  }

  if (doc === null || draft === null) {
    return (
      <PanelShell title={t('panel.config.title')} note={t('common.loading')}>
        <PanelBody>
          <div className="list-empty">
            <div className="le-title">{t('common.loading')}</div>
          </div>
        </PanelBody>
      </PanelShell>
    );
  }

  const footer = (
    <>
      <span className="cfg-status">
        {saveProblem !== null ? (
          <span className="cfg-status-error" role="alert">
            {saveProblem}
          </span>
        ) : saved ? (
          <span className="cfg-status-ok">
            <Check size={12} /> {t('panel.config.saved')}
          </span>
        ) : doc.problem !== null ? (
          <span className="cfg-status-error">{t('panel.config.readOnly')}</span>
        ) : blocking.length > 0 ? (
          <span className="cfg-status-error">{t('panel.config.blocked', { n: blocking.length })}</span>
        ) : dirty ? (
          <span className="cfg-status-pending">{t('panel.config.unsaved')}</span>
        ) : null}
      </span>
      <span className="grow" />
      <button
        type="button"
        className="btn btn-ghost btn-compact"
        disabled={!dirty || saving}
        onClick={() => {
          setDraft(draftFrom(doc));
          setSaveProblem(null);
          setSaved(false);
        }}
      >
        {t('panel.config.revert')}
      </button>
      <button type="button" className="btn btn-primary btn-compact" disabled={!canSave} onClick={() => void save()}>
        {saving ? t('panel.config.saving') : t('panel.config.save')}
      </button>
    </>
  );

  const routeCount = draft.providers.length;
  const serverCount = draft.mcp.length;
  const showKeysToggle = (
    <ShowKeysToggle showKeys={showKeys} onToggle={() => setShowKeys(!showKeys)} />
  );

  /* ---- the editor surface ---- */

  const open = editing;
  if (open !== null) {
    const back = { onBack: closeEditor, backLabel: t('panel.back') };
    if (open.kind === 'route') {
      const route = draft.providers[open.index];
      if (route !== undefined) {
        return (
          <PanelShell
            {...back}
            title={open.isNew ? t('panel.config.newRoute') : t('panel.config.editRoute')}
            note={t('panel.config.editorNote')}
            actions={showKeysToggle}
            footer={footer}
          >
            <PanelBody>
              <RouteEditor
                route={route}
                // The default is a property of the **list**, not of a route: it is
                // whichever route comes first with a key. Computed once here and
                // handed down so the editor's fact and the row's badge cannot
                // disagree.
                isDefault={defaultRouteIndex(draft) === open.index}
                showKeys={showKeys}
                onChange={(patch) => updateRoute(open.index, patch)}
                onModel={(modelIndex, patch) => updateModel(open.index, modelIndex, patch)}
              />
            </PanelBody>
          </PanelShell>
        );
      }
    } else {
      const server = draft.mcp[open.index];
      if (server !== undefined) {
        return (
          <PanelShell
            {...back}
            title={open.isNew ? t('panel.config.newServer') : t('panel.config.editServer')}
            note={t('panel.config.editorNote')}
            footer={footer}
          >
            <PanelBody>
              <ServerEditor
                server={server}
                onChange={(patch) => updateServer(open.index, patch)}
              />
            </PanelBody>
          </PanelShell>
        );
      }
    }
    // The row is gone — a Discard rewound the draft under the editor. Falling
    // through draws the list, which is the only surface that can still be true.
  }

  /* ---- the list surface ---- */

  const file =
    tab === 'mcp'
      ? { path: doc.mcp.path, exists: doc.mcp.exists, problem: doc.mcp.problem }
      : { path: doc.path, exists: doc.exists, problem: doc.problem };
  const note =
    tab === 'routes'
      ? t('panel.config.routesHint')
      : tab === 'web'
        ? t('panel.config.webHint')
        : t('panel.config.mcpHint');
  const firstWithKey = defaultRouteIndex(draft);

  return (
    <PanelShell
      title={t('panel.config.title')}
      info={<PanelInfo label={t('panel.config.about')} />}
      note={note}
      actions={
        <>
          {tab === 'web' ? showKeysToggle : null}
          {tab === 'routes' ? (
            <button type="button" className="btn btn-primary" onClick={addRoute}>
              <Plus size={13} />
              {t('panel.config.addRoute')}
            </button>
          ) : null}
          {tab === 'mcp' ? (
            <button type="button" className="btn btn-primary" onClick={addServer}>
              <Plus size={13} />
              {t('panel.config.addServer')}
            </button>
          ) : null}
        </>
      }
      footer={footer}
    >
      <div className="tk-filters">
        <div className="tk-chips" role="tablist" aria-label={t('panel.config.title')}>
          {CONFIG_TABS.map((which) => (
            <button
              key={which}
              type="button"
              role="tab"
              aria-selected={tab === which}
              className={`tk-chip${tab === which ? ' is-on' : ''}`}
              onClick={() => setTab(which)}
            >
              {t(TAB_LABEL[which])}
              <span className="tk-chip-count">
                {which === 'routes' ? routeCount : which === 'mcp' ? serverCount : '·'}
              </span>
            </button>
          ))}
        </div>
      </div>

      <PanelBody>
        {/* What is wrong, **above** the fields rather than under them: the list
            can be long enough that nobody scrolls to the bottom of it, and the
            first question after a refused save is "what do I fix". */}
        {problems.length > 0 ? (
          <div className="cfg-problems">
            {problems.map((problem, i) => (
              <div key={i} className={`cfg-problem${problem.blocking ? ' is-blocking' : ''}`}>
                {problem.text}
              </div>
            ))}
          </div>
        ) : null}

        {/* Where the file is, and the one way to it that is not this form. The
            folder button is what a person needs when the file cannot be parsed
            — that is precisely the case this panel cannot fix for them. It
            follows the tab, because the two tabs are two files.

            **On a remote screen the two halves split.** The path is still the
            host's own (`/home/deploy/.tudouni/config.json`), and it is shown
            with the `user@host` beside it so "whose file is this" is answered
            on screen. The reveal button goes: `revealItemInDir` opens **this**
            machine's file manager, and pointing it at a remote path either
            fails or — where the path also exists here — shows a different file
            with the same name, which is the worst of the two. The honest
            alternative is to say why it is not offered, which the tooltip does. */}
        <div className="cfg-path-row">
          {remote !== null ? (
            <Badge tone="neutral">
              {remote.user}@{remote.host}
            </Badge>
          ) : null}
          <span className="cfg-path mono" title={file.path}>
            {file.path}
          </span>
          {remote === null ? (
            <Tip label={t('panel.config.reveal')}>
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-compact"
                aria-label={t('panel.config.reveal')}
                onClick={() => void revealConfigFile(file.path)}
              >
                <FolderOpen size={13} />
              </button>
            </Tip>
          ) : (
            <Tip label={t('panel.config.revealRemote', { where: `${remote.user}@${remote.host}` })}>
              {/* Rendered rather than omitted: a control that is simply missing
                  from a panel that always had one reads as a bug. Disabled with
                  the reason in the tooltip is the sentence. */}
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-compact"
                aria-label={t('panel.config.revealRemote', { where: `${remote.user}@${remote.host}` })}
                disabled
              >
                <FolderOpen size={13} />
              </button>
            </Tip>
          )}
        </div>
        {!file.exists ? <p className="set-hint">{t('panel.config.missing')}</p> : null}
        {file.problem !== null ? <p className="cfg-file-problem">{file.problem}</p> : null}

        {tab === 'routes' ? (
          routeCount === 0 ? (
            <Blank icon={<Server size={20} />} title={t('panel.config.routeEmpty')} hint={t('panel.config.routeEmptyHint')} />
          ) : (
            <div className="tk-list">
              {draft.providers.map((route, index) => (
                <RouteRow
                  key={index}
                  route={route}
                  index={index}
                  total={routeCount}
                  isDefault={index === firstWithKey}
                  onOpen={() => setEditing({ kind: 'route', index, isNew: false })}
                  onMove={(to) =>
                    editDraft((current) => ({ ...current, providers: moved(current.providers, index, to) }))
                  }
                  onDuplicate={() => duplicateRoute(index)}
                  onRemove={() =>
                    editDraft((current) => ({
                      ...current,
                      providers: current.providers.filter((_, i) => i !== index),
                    }))
                  }
                />
              ))}
            </div>
          )
        ) : null}

        {tab === 'web' ? (
          <>
            <div className="cfg-grid">
              <Field label={t('panel.config.tavilyKey')}>
                <input
                  type={showKeys ? 'text' : 'password'}
                  className="cfg-input"
                  value={draft.web.tavilyApiKey}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => editDraft((current) => ({ ...current, web: { ...current.web, tavilyApiKey: e.target.value } }))}
                />
              </Field>
              <Field label={t('panel.config.tavilyBaseUrl')} hint={t('panel.config.tavilyBaseUrlHint')}>
                <input
                  type="text"
                  className="cfg-input"
                  value={draft.web.tavilyBaseUrl}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => editDraft((current) => ({ ...current, web: { ...current.web, tavilyBaseUrl: e.target.value } }))}
                />
              </Field>
            </div>
            <p className="set-hint">{t('panel.config.webAbsent')}</p>
          </>
        ) : null}

        {tab === 'mcp' ? (
          serverCount === 0 ? (
            <Blank icon={<Plug size={20} />} title={t('panel.config.mcpEmpty')} hint={t('panel.config.mcpEmptyHint')} />
          ) : (
            <div className="tk-list">
              {draft.mcp.map((server, index) => (
                <ServerRow
                  key={index}
                  server={server}
                  index={index}
                  total={serverCount}
                  onOpen={() => setEditing({ kind: 'server', index, isNew: false })}
                  onMove={(to) => editDraft((current) => ({ ...current, mcp: moved(current.mcp, index, to) }))}
                  onDuplicate={() => duplicateServer(index)}
                  onRemove={() =>
                    editDraft((current) => ({ ...current, mcp: current.mcp.filter((_, i) => i !== index) }))
                  }
                />
              ))}
            </div>
          )
        ) : null}

        {/* The one sentence that has to be said somewhere. It is at the foot of
            every surface rather than in the head, because it only matters *after*
            somebody has understood what they are looking at. */}
        <p className="set-hint cfg-takes-effect">{t('panel.config.effect')}</p>
      </PanelBody>
    </PanelShell>
  );
}

/* ---------------- the tabs ---------------- */

type ConfigTab = 'routes' | 'web' | 'mcp';

const CONFIG_TABS = ['routes', 'web', 'mcp'] as const;

const TAB_LABEL: Record<ConfigTab, TKey> = {
  routes: 'panel.config.routes',
  web: 'panel.config.web',
  mcp: 'panel.config.mcp',
};

/** Which row's editor is up. `index` addresses the draft array. */
interface Editor {
  kind: 'route' | 'server';
  index: number;
  /** Created by "Add" in this visit, so an untouched one is discarded on the way
   *  back rather than left on the list. */
  isNew: boolean;
}

/**
 * The index of the route the runtime will use by default: **the first one with a
 * key** (`Registry.DefaultProvider`). `-1` when no route has one.
 *
 * One function for both readers — the list's `default` badge and the editor's
 * fact — because two answers to "is this the default" is exactly the kind of
 * drift that makes a panel contradict itself.
 */
function defaultRouteIndex(draft: Draft): number {
  return draft.providers.findIndex((route) => route.apiKey.trim() !== '');
}

/** `name (copy)`, `name (copy 2)` … — the first that is not already taken. */
function copyName(name: string, taken: Set<string>): string {
  if (name === '') return '';
  const first = `${name} (copy)`;
  if (!taken.has(first)) return first;
  for (let n = 2; ; n += 1) {
    const next = `${name} (copy ${n})`;
    if (!taken.has(next)) return next;
  }
}

/* ============================================================
   The list rows: one route, one MCP server.
   ============================================================ */

/**
 * One route, in the task row's shape: a mark, the name with its badges, the
 * endpoint and what depends on it, and the fixed action slot at the right edge.
 *
 * The slot holds **Edit**, revealed on hover the way the task row reveals Run,
 * and the overflow menu that is always there — so the row's text never reflows
 * under the cursor. The name is the second way in, because a row whose title is
 * the thing you want to change should not need a button found first.
 */
function RouteRow({
  route,
  index,
  total,
  isDefault,
  onOpen,
  onMove,
  onDuplicate,
  onRemove,
}: {
  route: RouteView;
  index: number;
  total: number;
  isDefault: boolean;
  onOpen: () => void;
  onMove: (to: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const noKey = route.apiKey.trim() === '';
  const baseUrl = route.baseUrl.trim();

  return (
    <div className="tk-row">
      <span className="tk-mark" aria-hidden>
        <Server size={15} />
      </span>

      <div className="tk-row-main">
        <div className="tk-row-title">
          <button type="button" className="tk-row-name" onClick={onOpen}>
            {route.name.trim() === '' ? t('panel.config.untitled') : route.name}
          </button>
          {isDefault ? (
            <Badge tone="info" dot={false}>
              {t('panel.config.defaultRoute')}
            </Badge>
          ) : null}
          {noKey ? (
            <Badge tone="warning" dot={false}>
              {t('panel.config.noKey')}
            </Badge>
          ) : null}
        </div>

        {route.displayName.trim() !== '' ? (
          <div className="tk-row-desc">{route.displayName}</div>
        ) : null}

        <div className="tk-row-meta">
          <span className="tk-meta-item" title={baseUrl}>
            <Link2 size={12} />
            {baseUrl === '' ? t('panel.config.noBaseUrl') : baseUrl}
          </span>
          <span className="tk-meta-item">
            <Sparkles size={12} />
            {t('panel.config.modelCount', { n: route.models.length })}
          </span>
          {route.apiStyle !== '' ? (
            <span className="tk-meta-item">
              <Waypoints size={12} />
              {route.apiStyle}
            </span>
          ) : null}
          {!route.verify ? (
            <span className="tk-meta-item tk-meta-warn">
              <ShieldOff size={12} />
              {t('panel.config.tlsOff')}
            </span>
          ) : null}
        </div>
      </div>

      <div className="tk-row-actions">
        <button type="button" className="btn btn-primary tk-row-cta" onClick={onOpen}>
          <Pencil size={12} />
          {t('panel.config.edit')}
        </button>
        <RowMenu
          kind="route"
          canUp={index > 0}
          canDown={index < total - 1}
          onEdit={onOpen}
          onDuplicate={onDuplicate}
          onMoveUp={() => onMove(index - 1)}
          onMoveDown={() => onMove(index + 1)}
          onRemove={onRemove}
        />
      </div>
    </div>
  );
}

/**
 * One MCP server. Same row, different facts: the line under the name is the
 * invocation itself (`command args…`, or the URL), because that is what a person
 * recognises a server by, and the badge says which of the two transports it is —
 * the distinction the runtime refuses to guess.
 */
function ServerRow({
  server,
  index,
  total,
  onOpen,
  onMove,
  onDuplicate,
  onRemove,
}: {
  server: McpServerView;
  index: number;
  total: number;
  onOpen: () => void;
  onMove: (to: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const remote = server.url.trim() !== '';
  const invocation = remote
    ? server.url.trim()
    : [server.command.trim(), ...server.args].filter((part) => part !== '').join(' ');

  return (
    <div className="tk-row">
      <span className="tk-mark" aria-hidden>
        <Plug size={15} />
      </span>

      <div className="tk-row-main">
        <div className="tk-row-title">
          <button type="button" className="tk-row-name" onClick={onOpen}>
            {server.name.trim() === '' ? t('panel.config.untitled') : server.name}
          </button>
          <Badge tone="neutral" dot={false}>
            {remote ? t('panel.config.mcpRemote') : t('panel.config.mcpStdio')}
          </Badge>
        </div>

        <div className="tk-row-desc mono" title={invocation}>
          {invocation === '' ? t('panel.config.noInvocation') : invocation}
        </div>

        <div className="tk-row-meta">
          {server.env.length > 0 ? (
            <span className="tk-meta-item">
              <KeyRound size={12} />
              {t('panel.config.envCount', { n: server.env.length })}
            </span>
          ) : null}
          {server.timeoutSeconds !== null ? (
            <span className="tk-meta-item">
              <Clock size={12} />
              {t('panel.config.timeoutValue', { n: server.timeoutSeconds })}
            </span>
          ) : null}
        </div>
      </div>

      <div className="tk-row-actions">
        <button type="button" className="btn btn-primary tk-row-cta" onClick={onOpen}>
          <Pencil size={12} />
          {t('panel.config.edit')}
        </button>
        <RowMenu
          kind="server"
          canUp={index > 0}
          canDown={index < total - 1}
          onEdit={onOpen}
          onDuplicate={onDuplicate}
          onMoveUp={() => onMove(index - 1)}
          onMoveDown={() => onMove(index + 1)}
          onRemove={onRemove}
        />
      </div>
    </div>
  );
}

/**
 * The row's overflow: edit, duplicate, the two moves, and a two-press remove.
 *
 * The **order** is why these live in a menu rather than as three icon buttons on
 * the head, as they used to: moving a route up is how a person says "bill this
 * account by default", so the control that changes it sits beside the words that
 * describe it, and the row keeps the design's single fixed slot.
 *
 * Remove keeps the two-press arm every other destructive control in this app
 * uses: the first press only arms, and the menu stays up to say so. Anything else
 * — the scrim, Escape, another row — closes the menu and disarms with it, so a
 * stray first press costs nothing.
 */
function RowMenu({
  kind,
  canUp,
  canDown,
  onEdit,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  /** Which noun the menu's sentences are about. The two menus are the same
   *  control, and the words are the only thing that differs — the same reason
   *  the tasks menu says "Delete this task" rather than "Delete". */
  kind: 'route' | 'server';
  canUp: boolean;
  canDown: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = t(kind === 'route' ? 'panel.config.moreRoute' : 'panel.config.moreServer');

  useEffect(() => {
    if (!open) setArmed(false);
  }, [open]);

  function close(): void {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  /** One entry. `pick` closes first for the plain ones; the destructive one is
   *  the only item that stays up between its two presses. */
  function item(icon: ReactNode, text: string, onPick: () => void, disabled = false) {
    return (
      <button
        type="button"
        role="menuitem"
        className="tk-menu-item"
        disabled={disabled}
        onClick={() => {
          onPick();
          close();
        }}
      >
        {icon}
        {text}
      </button>
    );
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className="btn btn-ghost btn-icon tk-more"
          aria-label={label}
          aria-haspopup="menu"
        >
          <MoreHorizontal size={15} />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className="tk-menu"
          align="end"
          sideOffset={6}
          aria-label={label}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {item(<Pencil size={13} />, t('panel.config.edit'), onEdit)}
          {item(
            <Copy size={13} />,
            t(kind === 'route' ? 'panel.config.duplicateRoute' : 'panel.config.duplicateServer'),
            onDuplicate,
          )}
          {item(<ArrowUp size={13} />, t('panel.config.moveUp'), onMoveUp, !canUp)}
          {item(<ArrowDown size={13} />, t('panel.config.moveDown'), onMoveDown, !canDown)}
          <button
            type="button"
            role="menuitem"
            className={`tk-menu-item is-destructive${armed ? ' is-armed' : ''}`}
            onClick={() => {
              if (armed) {
                onRemove();
                close();
              } else {
                setArmed(true);
              }
            }}
          >
            <Trash2 size={13} />
            {armed
              ? t('panel.config.removeConfirm')
              : t(kind === 'route' ? 'panel.config.removeRoute' : 'panel.config.removeServer')}
          </button>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/* ============================================================
   The editors: one route, one MCP server.
   ============================================================ */

/**
 * A route's fields, in the task editor's two-column shape.
 *
 * The main column is what the route *is* — its identity, its endpoint and the
 * settings that change how it is spoken to; the side card is what is *true of*
 * it: whether it can be selected at all, how many models it carries, whether it
 * is the default, and the one switch (certificate verification) that is a
 * decision rather than a value.
 *
 * **Models start unfolded here**, unlike the folded block they used to be. That
 * fold existed because every route was a card in a stack and the list was the
 * point; in an editor opened for one route, the model list is half of what the
 * person came to change, and making them open it would be a click for nothing.
 * The fold is still there for a route with a long catalogue.
 */
function RouteEditor({
  route,
  isDefault,
  showKeys,
  onChange,
  onModel,
}: {
  route: RouteView;
  isDefault: boolean;
  showKeys: boolean;
  onChange: (patch: Partial<RouteView>) => void;
  onModel: (modelIndex: number, patch: Partial<ModelView>) => void;
}) {
  const t = useT();
  const [modelsOpen, setModelsOpen] = useState(true);

  // `Provider.Usable()`: a key and at least one model, or the route is in the
  // catalogue and cannot be picked. Shown as the two facts it is rather than as
  // a verdict, so the side card says *why* it is not selectable.
  const hasKey = route.apiKey.trim() !== '';
  const selectable = hasKey && route.models.length > 0;

  return (
    <div className="tk-editor">
      <div className="tk-editor-main">
        <section className="tk-section">
          <div className="tk-section-head">
            <span className="tk-section-label">{t('panel.config.sectionIdentity')}</span>
          </div>
          <div className="cfg-grid">
            <Field label={t('panel.config.name')} required hint={t('panel.config.nameHint')}>
              <input
                type="text"
                className="cfg-input mono"
                value={route.name}
                spellCheck={false}
                onChange={(e) => onChange({ name: e.target.value })}
              />
            </Field>
            <Field label={t('panel.config.displayName')} hint={t('panel.config.displayNameHint')}>
              <input
                type="text"
                className="cfg-input"
                value={route.displayName}
                onChange={(e) => onChange({ displayName: e.target.value })}
              />
            </Field>
          </div>
        </section>

        <section className="tk-section">
          <div className="tk-section-head">
            <span className="tk-section-label">{t('panel.config.sectionEndpoint')}</span>
          </div>
          <div className="cfg-grid">
            <Field label={t('panel.config.baseUrl')} required>
              <input
                type="text"
                className="cfg-input mono"
                value={route.baseUrl}
                spellCheck={false}
                placeholder="https://api.example.com"
                onChange={(e) => onChange({ baseUrl: e.target.value })}
              />
            </Field>
            <Field label={t('panel.config.apiStyle')} hint={t('panel.config.apiStyleHint')}>
              {/* A select, not a text field: `styleField` refuses a value it
                  does not recognise rather than defaulting, so a fourth one
                  typed here would only ever produce a file the runtime will
                  not open. */}
              <select
                className="cfg-input"
                value={route.apiStyle}
                onChange={(e) => onChange({ apiStyle: e.target.value })}
              >
                {API_STYLES.map((style) => (
                  <option key={style} value={style}>
                    {style === '' ? t('panel.config.apiStyleAuto') : style}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label={t('panel.config.apiKey')}>
            <input
              type={showKeys ? 'text' : 'password'}
              className="cfg-input mono"
              value={route.apiKey}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => onChange({ apiKey: e.target.value })}
            />
          </Field>
        </section>

        <section className="tk-section">
          <div className="tk-section-head">
            <span className="tk-section-label">{t('panel.config.sectionAdvanced')}</span>
          </div>
          <div className="cfg-grid">
            <Field label={t('panel.config.headers')} hint={t('panel.config.headersHint')}>
              <textarea
                className="cfg-textarea mono"
                rows={3}
                value={textOfPairs(route.headers)}
                spellCheck={false}
                onChange={(e) => onChange({ headers: pairsOfText(e.target.value) })}
              />
            </Field>
            <Field label={t('panel.config.effortLevels')} hint={t('panel.config.effortLevelsHint')}>
              <textarea
                className="cfg-textarea mono"
                rows={3}
                value={textOfLines(route.effortLevels)}
                spellCheck={false}
                onChange={(e) => onChange({ effortLevels: linesOf(e.target.value) })}
              />
            </Field>
          </div>
        </section>

        <section className="tk-section">
          <div className="tk-section-head">
            {/* The fold control wraps the label rather than the whole head: the
                head also carries the add button, and a wrapper that took the
                click would fire on its press too. */}
            <button
              type="button"
              className="cfg-fold"
              aria-expanded={modelsOpen}
              onClick={() => setModelsOpen(!modelsOpen)}
            >
              <ChevronRight size={13} className={`caret${modelsOpen ? ' caret-open' : ''}`} />
              <span className="tk-section-label">{t('panel.config.models')}</span>
              <Count value={route.models.length} />
            </button>
            <span className="grow" />
            <Info label={t('panel.config.modelsHint')} />
            <button
              type="button"
              className="btn btn-outline btn-compact"
              onClick={() => onChange({ models: [...route.models, emptyModel()] })}
            >
              <Plus size={12} />
              {t('panel.config.addModel')}
            </button>
          </div>

          <div className={`collapse${modelsOpen ? '' : ' is-collapsed'}`} inert={!modelsOpen}>
            <div className="tk-subcards">
              {route.models.map((model, at) => (
                <ModelCard
                  key={at}
                  model={model}
                  onChange={(patch) => onModel(at, patch)}
                  onRemove={() => onChange({ models: route.models.filter((_, i) => i !== at) })}
                />
              ))}
            </div>
          </div>
        </section>
      </div>

      <aside className="tk-editor-side">
        <div className="tk-side-title">{t('panel.config.sideStatus')}</div>
        <div className="tk-side-facts">
          <span className="tk-fact">
            <span className="tk-fact-label">{t('panel.config.factSelectable')}</span>
            <span className={`tk-fact-value${selectable ? '' : ' is-negative'}`}>
              {selectable ? t('common.yes') : t('common.no')}
            </span>
          </span>
          <span className="tk-fact">
            <span className="tk-fact-label">{t('panel.config.factModels')}</span>
            <span className="tk-fact-value">{route.models.length}</span>
          </span>
          <span className="tk-fact">
            <span className="tk-fact-label">{t('panel.config.factDefault')}</span>
            <span className={`tk-fact-value${isDefault ? '' : ' is-muted'}`}>
              {isDefault ? t('common.yes') : t('common.no')}
            </span>
          </span>
        </div>
        <p className="tk-field-hint">{t('panel.config.sideStatusHint')}</p>

        {/* The switch is "verify", not "skip verifying". The file stores the
            second, and the field used to be labelled with it — a switch whose
            *on* state means "do not do the safe thing" is a control people
            misread exactly once each. */}
        <div className="tk-toggle-row">
          <button
            type="button"
            role="switch"
            aria-checked={route.verify}
            aria-label={t('panel.config.verifyCert')}
            className={`tk-switch${route.verify ? ' is-on' : ''}`}
            onClick={() => onChange({ verify: !route.verify })}
          >
            <span className="tk-switch-knob" />
          </button>
          <span className="tk-toggle-text">
            <span className="tk-toggle-label">{t('panel.config.verifyCert')}</span>
            <span className="tk-field-hint">{t('panel.config.verifyHint')}</span>
          </span>
        </div>
      </aside>
    </div>
  );
}

/**
 * One model: id, label, the window it will be measured against, and how it
 * thinks. All of it is the runtime's catalogue, none of it starts a session.
 */
function ModelCard({
  model,
  onChange,
  onRemove,
}: {
  model: ModelView;
  onChange: (patch: Partial<ModelView>) => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <div className="tk-subcard">
      <div className="tk-subcard-head">
        <span className="mono">{model.id.trim() === '' ? t('panel.config.untitled') : model.id}</span>
        <span className="grow" />
        <Tip label={t('panel.config.removeModel')}>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-compact cfg-danger"
            aria-label={t('panel.config.removeModel')}
            onClick={onRemove}
          >
            <Trash2 size={12} />
          </button>
        </Tip>
      </div>

      <div className="cfg-grid">
        <Field label={t('panel.config.modelId')} required>
          <input
            type="text"
            className="cfg-input mono"
            value={model.id}
            spellCheck={false}
            onChange={(e) => onChange({ id: e.target.value })}
          />
        </Field>
        <Field label={t('panel.config.modelLabel')}>
          <input
            type="text"
            className="cfg-input"
            value={model.label}
            onChange={(e) => onChange({ label: e.target.value })}
          />
        </Field>
      </div>

      <div className="cfg-grid">
        <Field label={t('panel.config.contextWindow')} hint={t('panel.config.contextWindowHint')}>
          {/* Empty is a real answer and not zero: it means "the catalogue does
              not know", and the interface then reports usage without a
              percentage. A wrong percentage is worse than none. */}
          <input
            type="text"
            inputMode="numeric"
            className="cfg-input"
            value={model.contextWindow === null ? '' : String(model.contextWindow)}
            placeholder={t('panel.config.contextWindowAbsent')}
            spellCheck={false}
            onChange={(e) => onChange({ contextWindow: readNumber(e.target.value) })}
          />
        </Field>
        <Field label={t('panel.config.reasoningEffort')} hint={t('panel.config.reasoningEffortHint')}>
          <input
            type="text"
            className="cfg-input mono"
            value={model.reasoningEffort}
            spellCheck={false}
            onChange={(e) => onChange({ reasoningEffort: e.target.value })}
          />
        </Field>
      </div>

      <div className="cfg-grid">
        <Field label={t('panel.config.modelEffortLevels')} hint={t('panel.config.modelEffortLevelsHint')}>
          <textarea
            className="cfg-textarea mono"
            rows={2}
            value={textOfLines(model.effortLevels)}
            spellCheck={false}
            onChange={(e) => onChange({ effortLevels: linesOf(e.target.value) })}
          />
        </Field>
        <div className="cfg-field">
          <span className="cfg-label">{t('panel.config.vision')}</span>
          <label className="cfg-check">
            <input
              type="checkbox"
              checked={model.vision}
              onChange={(e) => onChange({ vision: e.target.checked })}
            />
            <span>{t('panel.config.visionOn')}</span>
          </label>
          <span className="cfg-hint">{t('panel.config.visionHint')}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * One MCP server's fields.
 *
 * The transport is the side card's business — it decides *where the server runs*,
 * which is the same kind of fact the task editor puts in its own side card — and
 * the main column holds what the server is and what it is given. Switching
 * transports **clears the other field**, because the runtime refuses a server
 * that names both: leaving the old one behind would produce exactly that refusal
 * on the next save, about a field that would not even be on screen.
 */
function ServerEditor({
  server,
  onChange,
}: {
  server: McpServerView;
  onChange: (patch: Partial<McpServerView>) => void;
}) {
  const t = useT();
  const remote = server.url.trim() !== '';

  return (
    <div className="tk-editor">
      <div className="tk-editor-main">
        <section className="tk-section">
          <div className="tk-section-head">
            <span className="tk-section-label">{t('panel.config.sectionServer')}</span>
          </div>
          <Field label={t('panel.config.name')} required hint={t('panel.config.nameHint')}>
            <input
              type="text"
              className="cfg-input mono"
              value={server.name}
              spellCheck={false}
              onChange={(e) => onChange({ name: e.target.value })}
            />
          </Field>

          {remote ? (
            <div className="cfg-grid">
              <Field label={t('panel.config.mcpUrl')} required>
                <input
                  type="text"
                  className="cfg-input mono"
                  value={server.url}
                  spellCheck={false}
                  placeholder="https://mcp.example.com/mcp"
                  onChange={(e) => onChange({ url: e.target.value })}
                />
              </Field>
              <Field label={t('panel.config.mcpHeaders')} hint={t('panel.config.headersHint')}>
                <textarea
                  className="cfg-textarea mono"
                  rows={2}
                  value={textOfPairs(server.headers)}
                  spellCheck={false}
                  onChange={(e) => onChange({ headers: pairsOfText(e.target.value) })}
                />
              </Field>
            </div>
          ) : (
            <div className="cfg-grid">
              <Field label={t('panel.config.mcpCommand')} required>
                <input
                  type="text"
                  className="cfg-input mono"
                  value={server.command}
                  spellCheck={false}
                  placeholder="npx"
                  onChange={(e) => onChange({ command: e.target.value })}
                />
              </Field>
              <Field label={t('panel.config.mcpArgs')} hint={t('panel.config.mcpArgsHint')}>
                <textarea
                  className="cfg-textarea mono"
                  rows={2}
                  value={textOfLines(server.args)}
                  spellCheck={false}
                  onChange={(e) => onChange({ args: linesOf(e.target.value) })}
                />
              </Field>
            </div>
          )}
        </section>

        <section className="tk-section">
          <div className="tk-section-head">
            <span className="tk-section-label">{t('panel.config.sectionAdvanced')}</span>
          </div>
          <div className="cfg-grid">
            <Field label={t('panel.config.mcpEnv')} hint={t('panel.config.pairsHint')}>
              <textarea
                className="cfg-textarea mono"
                rows={2}
                value={textOfPairs(server.env)}
                spellCheck={false}
                onChange={(e) => onChange({ env: pairsOfText(e.target.value) })}
              />
            </Field>
            <Field label={t('panel.config.mcpTimeout')} hint={t('panel.config.mcpTimeoutHint')}>
              <input
                type="text"
                inputMode="decimal"
                className="cfg-input"
                value={server.timeoutSeconds === null ? '' : String(server.timeoutSeconds)}
                placeholder={t('panel.config.contextWindowAbsent')}
                spellCheck={false}
                onChange={(e) => onChange({ timeoutSeconds: readNumber(e.target.value) })}
              />
            </Field>
          </div>
          {/*
            Not in the side card with the transport. The side card answers "where
            does this server run"; this answers "when", and folding the two together
            would suggest ticking it changes the transport.
          */}
          <div className="cfg-field">
            <span className="cfg-label">{t('panel.config.mcpAutoLoad')}</span>
            <label className="cfg-check">
              <input
                type="checkbox"
                checked={server.autoLoad}
                onChange={(e) => onChange({ autoLoad: e.target.checked })}
              />
              <span>{t('panel.config.mcpAutoLoadOn')}</span>
            </label>
            <span className="cfg-hint">{t('panel.config.mcpAutoLoadHint')}</span>
          </div>
        </section>
      </div>

      <aside className="tk-editor-side">
        <div className="tk-side-title">{t('panel.config.mcpTransport')}</div>
        <div className="tk-choice">
          <label className="tk-choice-row">
            <input
              type="radio"
              name="mcp-transport"
              checked={!remote}
              onChange={() => onChange({ url: '' })}
            />
            <span className="tk-choice-text">{t('panel.config.mcpStdio')}</span>
          </label>
          <label className="tk-choice-row">
            <input
              type="radio"
              name="mcp-transport"
              checked={remote}
              onChange={() => onChange({ command: '' })}
            />
            <span className="tk-choice-text">{t('panel.config.mcpRemote')}</span>
          </label>
        </div>
        <p className="tk-field-hint">{t('panel.config.transportHint')}</p>
      </aside>
    </div>
  );
}

/* ---------------- the small pieces ---------------- */

/** The empty state, in the shelf's own shape — a mark, a title, and what to do
 *  about it. `.tk-blank` is the tasks shelf's, so an empty list looks the same
 *  wherever a list is empty. */
function Blank({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  return (
    <div className="tk-blank">
      <span className="tk-blank-icon">{icon}</span>
      <div className="tk-blank-title">{title}</div>
      <div className="tk-blank-hint">{hint}</div>
    </div>
  );
}

/**
 * One labelled control. `label` wraps the control, so the two are associated.
 *
 * `required` draws the asterisk, and **which fields carry it is not decided
 * here**: they are exactly the ones whose emptiness comes back from
 * `validateDraft` as a `blocking` problem, i.e. the ones that grey out Save. A
 * marker keeping a list of its own would be wrong the first time the two
 * drifted, and it is the kind of wrong nobody reports — the field still works,
 * it just promises something else than the save button does.
 *
 * The word is written for the readers an asterisk never reaches: `sr-only` for a
 * screen reader, and the same sentence as the tooltip. `title` rides on the
 * asterisk rather than on the wrapper, so the control's accessible name stays
 * "Model id Required" instead of picking up the whole sentence.
 */
function Field({
  label,
  hint,
  required = false,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <label className="cfg-field">
      <span className="cfg-label">
        {label}
        {required ? (
          <>
            <span className="cfg-required" aria-hidden title={t('panel.config.requiredHint')}>
              *
            </span>
            <span className="sr-only">{t('panel.config.required')}</span>
          </>
        ) : null}
      </span>
      {children}
      {hint ? <span className="cfg-hint">{hint}</span> : null}
    </label>
  );
}

/**
 * Whether secrets are drawn in the clear.
 *
 * Off by default, and it is **one** switch for the panel rather than one per
 * field: a password input per key would hide the mistake people actually make
 * here (a key pasted with a trailing space, or two keys swapped between routes),
 * and a per-field toggle multiplied that by the number of routes. The panel
 * holds keys, so the default is "not on screen".
 *
 * It sits in the **head**, on the surfaces that hold a secret. It used to live
 * at the foot of the Web-search tab, which meant the only way to read a route's
 * key was to leave the routes tab and go and find it there.
 */
function ShowKeysToggle({ showKeys, onToggle }: { showKeys: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <button type="button" className={`set-toggle${showKeys ? ' is-on' : ''}`} aria-pressed={showKeys} onClick={onToggle}>
      {showKeys ? <EyeOff size={11} /> : <Eye size={11} />}
      <span>{showKeys ? t('panel.config.hideKeys') : t('panel.config.showKeys')}</span>
    </button>
  );
}

/**
 * A whole number from a text field, or null.
 *
 * Null is "nothing was typed" — a real answer for both numeric fields here, and
 * a different one from zero: `context_window: 0` is refused by the catalogue
 * (`not_positive_int`) while an absent window is fine, and a timeout of zero
 * would be a timeout that fires instantly.
 */
function readNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
