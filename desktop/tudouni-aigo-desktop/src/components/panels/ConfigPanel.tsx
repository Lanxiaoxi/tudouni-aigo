import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  Server,
  Trash2,
  X,
} from 'lucide-react';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { Badge, PanelInfo, Tip } from '@/components/ui/kit';
import { Select } from '@/components/ui/Select';
import { readRemoteUserConfig, readUserConfig, revealConfigFile, writeRemoteUserConfig, writeUserConfig } from '@/runtime/tauri';
import { useShallow } from 'zustand/react/shallow';
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
  type Pair,
  type Problem,
  type RouteView,
  type WebView,
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
 * order, in one column of sections.
 *
 * **The read-only column is the shell's rail.** Every surface here splits into
 * the fields and a 340px column of facts — a preview of the row, the read-out the
 * runtime computes, the model catalogue — and the split belongs to `PanelShell`
 * (`rail`), not to a grid of this file's. That is what keeps a route's page, a
 * server's page and all three tabs at one geometry, and it is why the rail's
 * cards are the shared `.wb-*` / `.pc-readout` vocabulary: a fact is drawn one
 * way in this panel, whichever surface is read.
 *
 * **The web-search tab has no second surface**, and that is not an omission: two
 * fields are a form, not a collection, and a list of one row that opens an editor
 * for two fields would be two clicks to type two values. It takes the list
 * surface's shape — the same tabs, path bar and rail — because "the key is empty"
 * is a consequence worth seeing while it is typed, not only in a sentence under
 * the fields.
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
  /** The row the list's rail describes. `null` means "nobody is pointing at
   *  one", and the rail falls back to the route the runtime would use — which
   *  is why the preview and the `default` badge can never disagree. */
  const [hovered, setHovered] = useState<number | null>(null);
  /** The models section, so the route page's rail can reach it. It is declared
   *  here rather than in `RouteEditor` because the rail and the section are
   *  drawn by two different components — see `RoutePageRail`. */
  const modelsRef = useRef<HTMLDivElement>(null);

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
  const remote = useApp(useShallow((s) => remoteConnectionOf(s, s.activeKey)));
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

  /** Put the form back to the file's own content. One function for the list's
   *  footer and the route page's head: the two Reverts are the same act. */
  function revert() {
    if (doc === null) return;
    setDraft(draftFrom(doc));
    setSaveProblem(null);
    setSaved(false);
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

  /* The footer's leading sentence: what just happened to the draft, or — when
     nothing has — when the file is read.
     **One slot, and it is the footer's.** The sentence used to sit at the foot
     of the body, after the list; the sheet moves it into the footer's leading
     edge, where it is read beside the Save it is about. It is the same slot the
     route page uses to say "Unsaved changes", so a person moving between the
     two surfaces keeps looking in one place. */
  const status: ReactNode =
    saveProblem !== null ? (
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
    ) : null;

  const footHint = status ?? <>{t('panel.config.effect')}</>;

  /* `[Ghost][Primary]` at the trailing edge, and nothing else: the hint is the
     shell's `footHint`, and the destructive verb — when a surface has one — is
     passed beside this in the footer's own slot. */
  const footer = (
    <>
      <button type="button" className="btn btn-ghost" disabled={!dirty || saving} onClick={revert}>
        {t('panel.config.revert')}
      </button>
      <button type="button" className="btn btn-primary" disabled={!canSave} onClick={() => void save()}>
        {saving ? t('panel.config.saving') : t('panel.config.save')}
      </button>
    </>
  );

  const routeCount = draft.providers.length;
  const serverCount = draft.mcp.length;
  const firstWithKey = defaultRouteIndex(draft);

  /* A refused save is a `.wb-alert` **above the fields, and only there**: the
     contract lets an error stand in one position, and repeating the sentence in
     the footer would be the second. Validation problems and the refusal are the
     same kind of thing to a reader — reasons the file cannot be written — so
     they share one list, in the order they would be fixed. */
  const alerts: Problem[] =
    saveProblem === null ? problems : [...problems, { text: saveProblem, blocking: true }];

  /* ---- the editor surface ---- */

  const open = editing;
  if (open !== null) {
    const isDefault = open.kind === 'route' && firstWithKey === open.index;
    if (open.kind === 'route') {
      const route = draft.providers[open.index];
      if (route !== undefined) {
        return (
          <PanelShell
            onBack={closeEditor}
            // The way back names the collection it returns to, which is what the
            // sheet's `← Routes` says: "back" is already in the arrow, and the
            // noun is the half worth the room.
            backLabel={t('panel.config.routes')}
            title={route.name.trim() === '' ? t('panel.config.untitled') : route.name}
            titleClass="pc-title"
            titleAside={
              // The title's own mark is a state of the thing being edited, and
              // `default` is the one this route has. The DRAFT chip that used to
              // sit here said something true of every page in this panel, and so
              // distinguished none of them.
              isDefault ? (
                <Badge tone="success" dot={false}>
                  {t('panel.config.defaultRoute')}
                </Badge>
              ) : undefined
            }
            note={t('panel.config.routeNote')}
            rail={<RoutePageRail route={route} modelsRef={modelsRef} />}
            footer={
              <>
                <DeleteAction
                  label={t('panel.config.deleteRoute')}
                  onDelete={() => {
                    editDraft((current) => ({
                      ...current,
                      providers: current.providers.filter((_, i) => i !== open.index),
                    }));
                    setEditing(null);
                  }}
                />
                <span className="grow" />
                <span className="cfg-status">{status}</span>
                <EditorActions
                  canSave={canSave}
                  dirty={dirty}
                  saving={saving}
                  onRevert={revert}
                  onSave={() => void save()}
                />
              </>
            }
          >
            <div className="pc-page">
              <Problems problems={alerts} />
              <RouteEditor
                // A different route is a different page: the open model card and
                // the scroll position all belong to it.
                key={open.index}
                route={route}
                modelsRef={modelsRef}
                showKeys={showKeys}
                onToggleKeys={() => setShowKeys(!showKeys)}
                onChange={(patch) => updateRoute(open.index, patch)}
                onModel={(modelIndex, patch) => updateModel(open.index, modelIndex, patch)}
              />
            </div>
          </PanelShell>
        );
      }
    } else {
      const server = draft.mcp[open.index];
      if (server !== undefined) {
        return (
          <PanelShell
            onBack={closeEditor}
            backLabel={t('panel.config.mcp')}
            title={
              server.name.trim() !== ''
                ? server.name
                : open.isNew
                  ? t('panel.config.newServer')
                  : t('panel.config.editServer')
            }
            titleClass="pc-title"
            titleAside={
              // The sheet's tag is a live connection state, which nothing in
              // this app reports. What the server does have is a start rule, and
              // that is what the slot says — the same way the route page's slot
              // says `default`.
              server.autoLoad ? (
                <Badge tone="success" dot={false}>
                  {t('panel.config.autoLoadMeta')}
                </Badge>
              ) : undefined
            }
            note={t('panel.config.serverNote')}
            rail={<ServerPageRail server={server} onChange={(patch) => updateServer(open.index, patch)} />}
            footer={
              <>
                <DeleteAction
                  label={t('panel.config.deleteServer')}
                  onDelete={() => {
                    editDraft((current) => ({
                      ...current,
                      mcp: current.mcp.filter((_, i) => i !== open.index),
                    }));
                    setEditing(null);
                  }}
                />
                <span className="grow" />
                <span className="cfg-status">{status}</span>
                <EditorActions
                  canSave={canSave}
                  dirty={dirty}
                  saving={saving}
                  onRevert={revert}
                  onSave={() => void save()}
                />
              </>
            }
          >
            <div className="pc-page">
              <Problems problems={alerts} />
              <ServerEditor
                // A different server is a different page: the scroll position
                // belongs to it, not to the next one.
                key={open.index}
                server={server}
                onChange={(patch) => updateServer(open.index, patch)}
              />
            </div>
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

  // Which row the rail describes: the one under the cursor, else the route the
  // runtime would use, else the first. `defaultRouteIndex` is the same answer the
  // list's `default` badge wears, so the preview and the badge cannot disagree
  // about which route is the subject — and a list nobody is pointing at still has
  // something to say about where saving would take effect. Clamped, so a hovered
  // index from a longer list (a tab that was just switched) cannot describe a row
  // that is not there.
  const routeSubject = Math.min(hovered ?? (firstWithKey >= 0 ? firstWithKey : 0), routeCount - 1);
  const serverSubject = Math.min(hovered ?? 0, serverCount - 1);
  const railRoute = tab === 'routes' ? draft.providers[routeSubject] : undefined;
  const railServer = tab === 'mcp' ? draft.mcp[serverSubject] : undefined;
  const rail =
    tab === 'web' ? (
      <WebRail web={draft.web} />
    ) : tab === 'routes' ? (
      railRoute === undefined ? undefined : (
        <RouteRail route={railRoute} isDefault={routeSubject === firstWithKey} />
      )
    ) : railServer === undefined ? undefined : (
      <ServerRail server={railServer} />
    );

  const body = (
    <div className="cfg-surface">
      {/* The tabs are the panel's first working row, at the panel's own padding:
          they used to sit outside the body, on the narrower gutter the tasks
          shelf gives its filter strip, and read as chrome above a different
          panel. */}
      <div className="tk-filters cfg-tabs">
        <div className="tk-chips" role="tablist" aria-label={t('panel.config.title')}>
          {CONFIG_TABS.map((which) => (
            <button
              key={which}
              type="button"
              role="tab"
              aria-selected={tab === which}
              className={`tk-chip${tab === which ? ' is-on' : ''}`}
              onClick={() => {
                setTab(which);
                // A hovered row is a row of the tab that was up: carrying its
                // index into another collection would describe the wrong one.
                setHovered(null);
              }}
            >
              {t(TAB_LABEL[which])}
              {which === 'web' ? null : (
                <span className="tk-chip-count">{which === 'routes' ? routeCount : serverCount}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* What is wrong, **above the fields** rather than under them: the list can
          be long enough that nobody scrolls to the bottom of it, and the first
          question after a refused save is "what do I fix". */}
      <Problems problems={alerts} />

      {/* Where the file is, and the one way to it that is not this form. The
          folder button is what a person needs when the file cannot be parsed —
          that is precisely the case this panel cannot fix for them. It follows
          the tab, because the two tabs are two files.

          **On a remote screen the two halves split.** The path is still the
          host's own (`/home/deploy/.tudouni/config.json`), and it is shown with
          the `user@host` beside it so "whose file is this" is answered on
          screen. The reveal button goes: `revealItemInDir` opens **this**
          machine's file manager, and pointing it at a remote path either fails
          or — where the path also exists here — shows a different file with the
          same name, which is the worst of the two. The honest alternative is to
          say why it is not offered, which the tooltip does.

          It is in the main column rather than across the panel because
          `PanelShell` makes the whole body the two-column split as soon as a
          rail is set: a bar spanning both columns would need a second body
          above the split, which the shell does not have. */}
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
          <div className="tk-list" onMouseLeave={() => setHovered(null)}>
            {draft.providers.map((route, index) => (
              <RouteRow
                key={index}
                route={route}
                index={index}
                total={routeCount}
                isDefault={index === firstWithKey}
                onHover={() => setHovered(index)}
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
        <WebSearchFields
          web={draft.web}
          showKeys={showKeys}
          onToggleKeys={() => setShowKeys(!showKeys)}
          onChange={(patch) => editDraft((current) => ({ ...current, web: { ...current.web, ...patch } }))}
        />
      ) : null}

      {tab === 'mcp' ? (
        serverCount === 0 ? (
          <Blank icon={<Plug size={20} />} title={t('panel.config.mcpEmpty')} hint={t('panel.config.mcpEmptyHint')} />
        ) : (
          <div className="tk-list" onMouseLeave={() => setHovered(null)}>
            {draft.mcp.map((server, index) => (
              <ServerRow
                key={index}
                server={server}
                index={index}
                total={serverCount}
                onHover={() => setHovered(index)}
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
    </div>
  );

  return (
    <PanelShell
      title={t('panel.config.title')}
      info={<PanelInfo label={t('panel.config.about')} />}
      note={note}
      actions={
        <>
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
      // With a rail the shell draws the body's two columns around `children`;
      // without one (an empty collection) the children are the whole panel, so
      // they bring their own body. Hence the two wrappings.
      rail={rail}
      footHint={footHint}
      footer={footer}
    >
      {rail === undefined ? <PanelBody>{body}</PanelBody> : body}
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
  onHover,
  onOpen,
  onMove,
  onDuplicate,
  onRemove,
}: {
  route: RouteView;
  index: number;
  total: number;
  isDefault: boolean;
  onHover: () => void;
  onOpen: () => void;
  onMove: (to: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const noKey = route.apiKey.trim() === '';
  const baseUrl = route.baseUrl.trim();

  return (
    <div className="tk-row" onMouseEnter={onHover}>
      <span className="tk-mark" aria-hidden>
        <Server size={15} />
      </span>

      <div className="tk-row-main">
        <div className="tk-row-title">
          <button type="button" className="tk-row-name" onClick={onOpen}>
            {route.name.trim() === '' ? t('panel.config.untitled') : route.name}
          </button>
          {isDefault ? (
            <Badge tone="success" dot={false}>
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

        {/* `url · n models · protocol`, the way the sheet writes a row's meta:
            interpuncts instead of an icon per fact, because four small glyphs
            are four things to decode and a dot is none. The URL is the only
            value on the line, so it is the only one in the mono face. */}
        <div className="tk-row-meta">
          <span className="tk-meta-item mono" title={baseUrl}>
            {baseUrl === '' ? t('panel.config.noBaseUrl') : baseUrl}
          </span>
          <span className="tk-meta-dot" aria-hidden>
            ·
          </span>
          <span className="tk-meta-item">{t('panel.config.modelCount', { n: route.models.length })}</span>
          {route.apiStyle !== '' ? (
            <>
              <span className="tk-meta-dot" aria-hidden>
                ·
              </span>
              <span className="tk-meta-item">{route.apiStyle}</span>
            </>
          ) : null}
          {!route.verify ? (
            <>
              <span className="tk-meta-dot" aria-hidden>
                ·
              </span>
              {/* The one security-relevant value in the file, so it keeps the
                  warning colour rather than becoming one more grey fact. */}
              <span className="tk-meta-item tk-meta-warn">{t('panel.config.tlsOff')}</span>
            </>
          ) : null}
        </div>
      </div>

      <div className="tk-row-actions">
        {/* Secondary, not primary: the head already has the screen's one Primary
            (Add a route), and a list whose every row wore a filled button has no
            primary left to point at. It still reveals on hover, so ten routes
            are not ten framed buttons either. */}
        <button type="button" className="btn btn-outline tk-row-cta" onClick={onOpen}>
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
  onHover,
  onOpen,
  onMove,
  onDuplicate,
  onRemove,
}: {
  server: McpServerView;
  index: number;
  total: number;
  onHover: () => void;
  onOpen: () => void;
  onMove: (to: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const remote = server.url.trim() !== '';
  const invocation = invocationOf(server);

  return (
    <div className="tk-row" onMouseEnter={onHover}>
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

        {/* The route row's meta line, about a server: interpuncts, no icons. The
            transport is not repeated here — it is the line above, as the badge. */}
        <div className="tk-row-meta">
          {server.autoLoad ? (
            <span className="tk-meta-item">{t('panel.config.autoLoadMeta')}</span>
          ) : null}
          {server.autoLoad && server.env.length > 0 ? (
            <span className="tk-meta-dot" aria-hidden>
              ·
            </span>
          ) : null}
          {server.env.length > 0 ? (
            <span className="tk-meta-item">{t('panel.config.envCount', { n: server.env.length })}</span>
          ) : null}
          {(server.autoLoad || server.env.length > 0) && server.timeoutSeconds !== null ? (
            <span className="tk-meta-dot" aria-hidden>
              ·
            </span>
          ) : null}
          {server.timeoutSeconds !== null ? (
            <span className="tk-meta-item">{t('panel.config.timeoutValue', { n: server.timeoutSeconds })}</span>
          ) : null}
        </div>
      </div>

      <div className="tk-row-actions">
        <button type="button" className="btn btn-outline tk-row-cta" onClick={onOpen}>
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

/** The six levels the runtime offers when a route declares none. See
 *  `protocol.md`'s effort section — `none` is not one of them (it is thinking
 *  off, a different control), and a value the file already holds is appended by
 *  `RouteEditor` rather than dropped here. */
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * A route's fields, on the page the routes list opens into.
 *
 * **The page is grouped by what the fields answer, not by the file's sections.**
 * Connection is who the route is and how it is reached; Reasoning is the
 * vocabulary it accepts; Request is what rides along with each call. The rail —
 * drawn by the shell from `RoutePageRail` — is the *consequence* of those
 * fields: the read-out the runtime computes from them, and the model catalogue
 * at a glance. The form and the list therefore cannot disagree about what saving
 * will produce.
 *
 * **One column of fields.** The fields used to be a two-column grid with a fixed
 * 160px label column, so every control started at the same x and every label sat
 * beside the value it named. The sheet sets the label *above* its control and
 * lets the control take the column, which is what makes a route's page read as a
 * form rather than as a table — and what gives a base URL the width it needs.
 *
 * **The models are cards again, and that is not the old stacked-card layout.**
 * A model has four settings and a summary line that is worth reading when it is
 * folded; one card is open, the rest are one-line rows in the same list, so a
 * nine-model route is still a list. The first one starts open because a route
 * with models is nearly always being edited here for one of them.
 */
function RouteEditor({
  route,
  modelsRef,
  showKeys,
  onToggleKeys,
  onChange,
  onModel,
}: {
  route: RouteView;
  modelsRef: RefObject<HTMLDivElement | null>;
  showKeys: boolean;
  onToggleKeys: () => void;
  onChange: (patch: Partial<RouteView>) => void;
  onModel: (modelIndex: number, patch: Partial<ModelView>) => void;
}) {
  const t = useT();
  const [openModel, setOpenModel] = useState<number | null>(route.models.length > 0 ? 0 : null);

  // The six levels the runtime offers when a route declares none, plus any
  // custom level this file already carries. The second half matters: a value
  // the ui cannot draw is a value somebody can no longer remove.
  const levels = [
    ...THINKING_LEVELS,
    ...route.effortLevels.filter((level) => !(THINKING_LEVELS as readonly string[]).includes(level)),
  ];

  function toggleLevel(level: string) {
    const on = route.effortLevels.includes(level);
    onChange({
      effortLevels: on
        ? route.effortLevels.filter((current) => current !== level)
        : [...route.effortLevels, level],
    });
  }

  function patchHeader(at: number, patch: Partial<Pair>) {
    onChange({
      headers: route.headers.map((pair, i) => (i === at ? { ...pair, ...patch } : pair)),
    });
  }

  function addModel() {
    const at = route.models.length;
    onChange({ models: [...route.models, emptyModel()] });
    setOpenModel(at);
    // The new card is appended below the fold when the route already has a
    // catalogue. Two frames: one for React's commit, one for the browser to
    // lay the new card out before it is measured.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        modelsRef.current
          ?.querySelector('.pc-model:last-child')
          ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
  }

  function removeModel(at: number) {
    const models = route.models.filter((_, i) => i !== at);
    onChange({ models });
    // Keep the open card pointing at the same model where possible. Without
    // this, removing the second of three would leave the third's index pointing
    // past the end, and the next click on it would open nothing.
    setOpenModel((current) => {
      if (current === null) return null;
      if (current === at) return models.length === 0 ? null : Math.min(at, models.length - 1);
      return current > at ? current - 1 : current;
    });
  }

  return (
    <>
      <section className="pc-section">
        <SectionLabel>{t('panel.config.sectionConnection')}</SectionLabel>

        {/* Name and protocol share a row: both are short keys rather than prose,
            and the sheet draws them side by side above the URL they belong to. */}
        <div className="wb-grid">
          <PcField label={t('panel.config.name')} required hint={t('panel.config.nameHint')}>
            <input
              type="text"
              className="cfg-input mono"
              value={route.name}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => onChange({ name: e.target.value })}
            />
          </PcField>

          <PcField label={t('panel.config.apiStyle')} hint={t('panel.config.apiStyleHint')}>
            {/* A select, not a text field: `styleField` refuses a value it does
                not recognise rather than defaulting, so a fourth one typed here
                would only ever produce a file the runtime will not open. */}
            <Select
              size="tiny"
              value={route.apiStyle}
              options={API_STYLES.map((style) => ({
                value: style,
                label: style === '' ? t('panel.config.apiStyleAuto') : style,
              }))}
              onChange={(apiStyle) => onChange({ apiStyle })}
            />
          </PcField>
        </div>

        <PcField label={t('panel.config.baseUrl')} required hint={t('panel.config.baseUrlHint')}>
          <input
            type="text"
            className="cfg-input mono"
            value={route.baseUrl}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://api.example.com"
            onChange={(e) => onChange({ baseUrl: e.target.value })}
          />
        </PcField>

        <PcField label={t('panel.config.apiKey')} hint={t('panel.config.apiKeyHint')}>
          <span className="pc-key">
            <input
              type={showKeys ? 'text' : 'password'}
              className="cfg-input mono"
              value={route.apiKey}
              spellCheck={false}
              autoComplete="off"
              aria-label={t('panel.config.apiKey')}
              onChange={(e) => onChange({ apiKey: e.target.value })}
            />
            <Tip label={showKeys ? t('panel.config.hideKeys') : t('panel.config.showKeys')}>
              <button
                type="button"
                className="pc-key-eye"
                aria-label={showKeys ? t('panel.config.hideKeys') : t('panel.config.showKeys')}
                aria-pressed={showKeys}
                onClick={onToggleKeys}
              >
                {showKeys ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </Tip>
          </span>
        </PcField>

        {/* The switch is "verify", not "skip verifying". The file stores the
            second, and the field used to be labelled with it — a switch whose
            *on* state means "do not do the safe thing" is a control people
            misread exactly once each. The sentence is under the title rather
            than under the switch, because it is about what the switch means. */}
        <div className="wb-row pc-switch">
          <span className="wb-row-main">
            <span className="wb-row-title">{t('panel.config.verifyCert')}</span>
            <span className="wb-row-hint">{t('panel.config.verifyHint')}</span>
          </span>
          <span className="wb-row-control">
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
          </span>
        </div>
      </section>

      <section className="pc-section">
        <SectionLabel>{t('panel.config.sectionReasoning')}</SectionLabel>

        {/* No field label over the chips: the section is already labelled
            `REASONING`, and a second label for the same group would be two names
            for one thing. The group keeps its accessible name. */}
        <div className="wb-field">
          <div className="pc-levels" role="group" aria-label={t('panel.config.effortLevels')}>
            {levels.map((level) => {
              const on = route.effortLevels.includes(level);
              return (
                <button
                  key={level}
                  type="button"
                  className={`pc-level${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggleLevel(level)}
                >
                  {level}
                </button>
              );
            })}
          </div>
          <span className="cfg-hint">{t('panel.config.effortLevelsHint')}</span>
        </div>
      </section>

      <section className="pc-section">
        <SectionLabel>{t('panel.config.sectionRequest')}</SectionLabel>

        <div className="wb-field">
          <span className="cfg-label">{t('panel.config.headers')}</span>
          {route.headers.map((pair, at) => (
            <div className="pc-pair" key={at}>
              <input
                type="text"
                className="cfg-input mono"
                value={pair.key}
                spellCheck={false}
                autoComplete="off"
                aria-label={t('panel.config.headerName')}
                placeholder="User-Agent"
                onChange={(e) => patchHeader(at, { key: e.target.value })}
              />
              <input
                type="text"
                className="cfg-input mono"
                value={pair.value}
                spellCheck={false}
                autoComplete="off"
                aria-label={t('panel.config.headerValue')}
                placeholder="tudouni/0.2"
                onChange={(e) => patchHeader(at, { value: e.target.value })}
              />
              <Tip label={t('panel.config.removeHeader')}>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-compact cfg-danger"
                  aria-label={t('panel.config.removeHeader')}
                  onClick={() => onChange({ headers: route.headers.filter((_, i) => i !== at) })}
                >
                  <X size={14} />
                </button>
              </Tip>
            </div>
          ))}
          <button
            type="button"
            className="pc-add"
            onClick={() => onChange({ headers: [...route.headers, { key: '', value: '' }] })}
          >
            <Plus size={13} />
            {t('panel.config.addHeader')}
          </button>
        </div>
      </section>

      {/* The catalogue is the page's own section rather than the rail's: a
          read-out names what is there, an editor changes it, and the same
          subject in two places would be two answers about one list. */}
      <section className="pc-section pc-models" ref={modelsRef}>
        <div className="wb-label-row">
          <span className="wb-label">{t('panel.config.models')}</span>
          <span className="wb-label-count">{route.models.length}</span>
          <span className="grow" />
          <button type="button" className="btn btn-outline btn-compact" onClick={addModel}>
            <Plus size={12} />
            {t('panel.config.addModel')}
          </button>
        </div>

        {route.models.length === 0 ? (
          <div className="pc-models-empty">
            <span>{t('panel.config.modelsHint')}</span>
            <button type="button" className="pc-add" onClick={addModel}>
              <Plus size={13} />
              {t('panel.config.addModel')}
            </button>
          </div>
        ) : (
          <div className="pc-model-list">
            {route.models.map((model, at) => (
              <ModelCard
                key={at}
                model={model}
                open={openModel === at}
                onToggle={() => setOpenModel((current) => (current === at ? null : at))}
                onChange={(patch) => onModel(at, patch)}
                onRemove={() => removeModel(at)}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

/**
 * The read-out both route rails show: the facts the runtime computes from a
 * route, never the fields that produce them. One component rather than two,
 * because the list's preview and the route's own page are the same statement
 * about the same route — and two copies of it would eventually disagree.
 *
 * `default` is deliberately absent: it is a property of the *list* (whichever
 * route comes first with a key), and both surfaces already say it in the one
 * place where it is about this route — the `default` tag beside its name.
 */
function RouteReadout({ route }: { route: RouteView }) {
  const t = useT();
  // `Provider.Usable()`: a key and at least one model, or the route is in the
  // catalogue and cannot be picked. Shown as the fact it is rather than as a
  // verdict, so the read-out says *why* it is not selectable.
  const selectable = route.apiKey.trim() !== '' && route.models.length > 0;
  const host = hostOf(route.baseUrl) || t('panel.config.noBaseUrl');
  const style = route.apiStyle.trim() === '' ? t('panel.config.inferStyle') : route.apiStyle;

  return (
    <div className="pc-readout">
      <ReadoutRow
        label={t('panel.config.factSelectable')}
        value={selectable ? t('common.yes') : t('common.no')}
        tone={selectable ? undefined : 'negative'}
      />
      <ReadoutRow label={t('panel.config.factBaseUrl')} value={host} />
      <ReadoutRow label={t('panel.config.apiStyle')} value={style} />
      <ReadoutRow label={t('panel.config.factModels')} value={route.models.length} />
      <ReadoutRow
        label={t('panel.config.factCertificate')}
        value={route.verify ? t('panel.config.certVerified') : t('panel.config.certUnverified')}
        tone={route.verify ? undefined : 'negative'}
      />
    </div>
  );
}

/**
 * The list's rail: what the row under the cursor will look like once saved.
 *
 * It is the *hovered* row, not a fixed one, because the question a list of
 * routes raises is "which of these is the one that…" — and the answer is longer
 * than a row's meta line. With nothing hovered it describes the route the
 * runtime would use, so an untouched panel still answers "where does a session
 * go" without a click.
 */
function RouteRail({ route, isDefault }: { route: RouteView; isDefault: boolean }) {
  const t = useT();
  const noKey = route.apiKey.trim() === '';
  const selectable = !noKey && route.models.length > 0;
  const host = hostOf(route.baseUrl) || t('panel.config.noBaseUrl');
  const style = route.apiStyle.trim() === '' ? t('panel.config.inferStyle') : route.apiStyle;
  const modelCount =
    route.models.length === 1
      ? t('panel.config.oneModel')
      : t('panel.config.modelCountPlain', { n: route.models.length });

  return (
    <>
      <div className="wb-card-above">
        <div className="wb-label-row">
          <span className="wb-label">{t('panel.config.preview')}</span>
        </div>
        <div className={`pc-preview${selectable ? '' : ' is-off'}`}>
          <div className="pc-preview-head">
            <span className="pc-preview-dot" aria-hidden />
            <span className="pc-preview-name mono">
              {route.name.trim() === '' ? t('panel.config.untitled') : route.name}
            </span>
            <span className="grow" />
            {isDefault ? (
              <Badge tone="success" dot={false}>
                {t('panel.config.defaultRoute')}
              </Badge>
            ) : noKey ? (
              <Badge tone="warning" dot={false}>
                {t('panel.config.noKey')}
              </Badge>
            ) : null}
          </div>
          <div className="pc-preview-sub">
            <span>{modelCount}</span>
            <span aria-hidden>·</span>
            <span>{style}</span>
            <span aria-hidden>·</span>
            <span>{host}</span>
          </div>
        </div>
      </div>

      <div className="wb-card-above">
        <div className="wb-label-row">
          <span className="wb-label">{t('panel.config.readOut')}</span>
          <span className="grow" />
          <span className="pc-side-note">{t('panel.config.notEditable')}</span>
        </div>
        <RouteReadout route={route} />
      </div>
    </>
  );
}

/**
 * The route page's rail: the facts the runtime computes, then the catalogue the
 * page edits below.
 *
 * There is no preview card here, and that is the difference between the two
 * rails: on this surface the title *is* the route's name and its `default` tag,
 * so a card repeating them would be a second title. The models card stays,
 * because it is a way *into* the section below — `All n models` scrolls to it.
 */
function RoutePageRail({
  route,
  modelsRef,
}: {
  route: RouteView;
  modelsRef: RefObject<HTMLDivElement | null>;
}) {
  const t = useT();

  return (
    <>
      <div className="wb-card-above">
        <div className="wb-label-row">
          <span className="wb-label">{t('panel.config.readOut')}</span>
          <span className="grow" />
          <span className="pc-side-note">{t('panel.config.notEditable')}</span>
        </div>
        <RouteReadout route={route} />
        <p className="pc-side-caption">{t('panel.config.sideStatusHint')}</p>
      </div>

      <div className="wb-card-above">
        <div className="wb-label-row">
          <span className="wb-label">{t('panel.config.models')}</span>
          <span className="wb-label-count">{route.models.length}</span>
        </div>
        <div className="pc-mini-list">
          {route.models.length === 0 ? (
            <span className="pc-mini-empty">{t('panel.config.noModelsYet')}</span>
          ) : (
            route.models.slice(0, 3).map((model, at) => (
              <span className="pc-mini-row" key={at}>
                <span className="pc-mini-name mono">
                  {model.id.trim() === '' ? t('panel.config.untitled') : model.id}
                </span>
              </span>
            ))
          )}
        </div>
        {route.models.length > 3 ? (
          <button
            type="button"
            className="pc-allmodels"
            onClick={() => modelsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            {t('panel.config.allModels', { n: route.models.length })}
          </button>
        ) : null}
      </div>
    </>
  );
}

/** The host of a base URL, for the preview's one-line summary. A URL that has
 *  not been finished yet is shown verbatim: an empty preview would say less
 *  than the half-typed value does. */
function hostOf(baseUrl: string): string {
  const raw = baseUrl.trim();
  if (raw === '') return '';
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}

/** `1,048,576` — the same number in full, where there is room to read it. */
function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * One model: id, label, the window it will be measured against, and whether it
 * takes pictures. All of it is the runtime's catalogue, none of it starts a
 * session.
 *
 * Collapsed, the head says everything a reader scanning a nine-model route
 * needs: the id, its context window and whether it sees. The open card repeats
 * the window in full because that is the field being typed into.
 */
function ModelCard({
  model,
  open,
  onToggle,
  onChange,
  onRemove,
}: {
  model: ModelView;
  open: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<ModelView>) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const [removeArmed, setRemoveArmed] = useState(false);
  const meta = [
    model.contextWindow === null
      ? null
      : t('panel.config.contextMeta', { n: grouped(model.contextWindow) }),
    model.vision ? t('panel.config.visionMeta') : t('panel.config.noVisionMeta'),
  ]
    .filter((part) => part !== null)
    .join(' · ');

  // A fold hides the button, so an armed press must not survive it: the card is
  // the same component when it opens again, and a red mark left waiting would
  // remove a model on what looks like the first press.
  useEffect(() => {
    if (!open) setRemoveArmed(false);
  }, [open]);

  return (
    <div className={`pc-model${open ? ' is-open' : ''}`}>
      <div className="pc-model-head">
        <button type="button" className="pc-model-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="pc-model-name mono">
            {model.id.trim() === '' ? t('panel.config.untitled') : model.id}
          </span>
          <span className="pc-model-meta">{meta}</span>
          <span className="grow" />
          <ChevronRight size={15} className={`pc-caret${open ? ' is-open' : ''}`} />
        </button>
        {open ? (
          <Tip label={removeArmed ? t('panel.config.removeConfirm') : t('panel.config.removeModel')}>
            <button
              type="button"
              className={`btn btn-ghost btn-icon btn-compact cfg-danger${removeArmed ? ' is-armed' : ''}`}
              aria-label={removeArmed ? t('panel.config.removeConfirm') : t('panel.config.removeModel')}
              onMouseLeave={() => setRemoveArmed(false)}
              onClick={() => {
                if (removeArmed) onRemove();
                else setRemoveArmed(true);
              }}
            >
              {removeArmed ? <Check size={14} /> : <Trash2 size={14} />}
            </button>
          </Tip>
        ) : null}
      </div>

      {open ? (
        <div className="pc-model-body">
          <div className="wb-grid">
            <PcField label={t('panel.config.modelId')} required>
              <input
                type="text"
                className="cfg-input mono"
                value={model.id}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => onChange({ id: e.target.value })}
              />
            </PcField>

            <PcField label={t('panel.config.modelLabel')}>
              <input
                type="text"
                className="cfg-input"
                value={model.label}
                placeholder={t('panel.config.modelLabelPlaceholder')}
                autoComplete="off"
                onChange={(e) => onChange({ label: e.target.value })}
              />
            </PcField>
          </div>

          <PcField label={t('panel.config.contextWindow')} hint={t('panel.config.contextWindowHint')}>
            {/* Empty is a real answer and not zero: it means "the catalogue does
                not know", and the interface then reports usage without a
                percentage. A wrong percentage is worse than none. */}
            <span className="pc-window">
              <input
                type="text"
                inputMode="numeric"
                className="cfg-input pc-window-input"
                value={model.contextWindow === null ? '' : grouped(model.contextWindow)}
                placeholder={t('panel.config.contextWindowAbsent')}
                spellCheck={false}
                aria-label={t('panel.config.contextWindow')}
                onChange={(e) => onChange({ contextWindow: readTokenCount(e.target.value) })}
              />
              <span className="pc-window-suffix">{t('panel.config.contextWindowTokens')}</span>
            </span>
          </PcField>

          <div className="wb-row pc-switch">
            <span className="wb-row-main">
              <span className="wb-row-title">{t('panel.config.acceptsImages')}</span>
              <span className="wb-row-hint">{t('panel.config.acceptsImagesHint')}</span>
            </span>
            <span className="wb-row-control">
              <button
                type="button"
                role="switch"
                aria-checked={model.vision}
                aria-label={t('panel.config.acceptsImages')}
                className={`tk-switch${model.vision ? ' is-on' : ''}`}
                onClick={() => onChange({ vision: !model.vision })}
              >
                <span className="tk-switch-knob" />
              </button>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** One field: the label **above** the control, the control the column's full
 *  width, the hint under it. The label wraps the control, so pressing the word
 *  focuses the field without a second `for`/`id` to keep in sync.
 *
 *  It used to be a row with a fixed 160px label column, which is the shape the
 *  sheet retires: a label beside a control is a table's cell, and a route's
 *  fields are not a table. */
function PcField({
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
    <label className="wb-field">
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

/** A section label. It is the only uppercase writing in the panel, and it names
 *  the group under it — the hairline rule the older page ran to the column's
 *  edge is gone, because the sheet separates subjects with space. */
function SectionLabel({ children, count }: { children: ReactNode; count?: ReactNode }) {
  return (
    <div className="wb-label-row">
      <span className="wb-label">{children}</span>
      {count !== undefined ? <span className="wb-label-count">{count}</span> : null}
    </div>
  );
}

/** A whole number of tokens, or null. Commas are stripped rather than refused:
 *  the field draws a grouped number, so the reader who edits it keeps the
 *  commas they can see. */
function readTokenCount(text: string): number | null {
  const trimmed = text.replace(/[,\s]/g, '');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * The web-search tab's fields.
 *
 * Two fields are a form, not a collection, so there is no second surface — and
 * the sheet draws it as the routes list with a different body: the same tabs,
 * the same path bar, the same `SEARCH` label, and a rail that says what the
 * runtime registers. That is why this component is only the fields: the rail is
 * `WebRail`, drawn by the panel's own body.
 */
function WebSearchFields({
  web,
  showKeys,
  onToggleKeys,
  onChange,
}: {
  web: WebView;
  showKeys: boolean;
  onToggleKeys: () => void;
  onChange: (patch: Partial<WebView>) => void;
}) {
  const t = useT();

  return (
    <section className="pc-section">
      <SectionLabel>{t('panel.config.sectionSearch')}</SectionLabel>

      <PcField label={t('panel.config.tavilyKey')} hint={t('panel.config.webKeyHint')}>
        <span className="pc-key">
          <input
            type={showKeys ? 'text' : 'password'}
            className="cfg-input mono"
            value={web.tavilyApiKey}
            spellCheck={false}
            autoComplete="off"
            aria-label={t('panel.config.tavilyKey')}
            onChange={(e) => onChange({ tavilyApiKey: e.target.value })}
          />
          <Tip label={showKeys ? t('panel.config.hideKeys') : t('panel.config.showKeys')}>
            <button
              type="button"
              className="pc-key-eye"
              aria-label={showKeys ? t('panel.config.hideKeys') : t('panel.config.showKeys')}
              aria-pressed={showKeys}
              onClick={onToggleKeys}
            >
              {showKeys ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </Tip>
        </span>
      </PcField>

      <PcField label={t('panel.config.tavilyBaseUrl')} hint={t('panel.config.tavilyBaseUrlHint')}>
        <input
          type="text"
          className="cfg-input mono"
          value={web.tavilyBaseUrl}
          spellCheck={false}
          autoComplete="off"
          placeholder="https://api.tavily.com"
          onChange={(e) => onChange({ tavilyBaseUrl: e.target.value })}
        />
      </PcField>
    </section>
  );
}

/**
 * The web-search tab's rail: the two facts the fields produce, and what the
 * runtime does with them.
 *
 * The paragraph between the two cards is the sheet's: "leave them empty and
 * `web_search` is not registered" is the consequence of the key field, and it is
 * read beside that field rather than under the form — which is the whole reason
 * this tab has a rail although it has only two fields.
 */
function WebRail({ web }: { web: WebView }) {
  const t = useT();
  const configured = web.tavilyApiKey.trim() !== '';
  const base = web.tavilyBaseUrl.trim();
  const baseLabel = base === '' ? t('panel.config.webDefaultBase') : hostOf(base) || base;

  return (
    <>
      <div className="wb-card-above">
        <div className="wb-label-row">
          <span className="wb-label">{t('panel.config.preview')}</span>
        </div>
        <div className={`pc-preview${configured ? '' : ' is-off'}`}>
          <div className="pc-preview-head">
            <span className="pc-preview-dot" aria-hidden />
            <span className="pc-preview-name">{t('panel.config.webProvider')}</span>
            <span className="grow" />
            <Badge tone={configured ? 'success' : 'neutral'} dot={false}>
              {configured ? t('panel.config.webConfigured') : t('panel.config.webNotConfigured')}
            </Badge>
          </div>
          <div className="pc-preview-sub">
            <span>web_search</span>
            <span aria-hidden>·</span>
            <span>{baseLabel}</span>
          </div>
        </div>
        <p className="pc-side-caption">{t('panel.config.webAbsent')}</p>
      </div>

      <div className="wb-card-above">
        <div className="wb-label-row">
          <span className="wb-label">{t('panel.config.readOut')}</span>
          <span className="grow" />
          <span className="pc-side-note">{t('panel.config.notEditable')}</span>
        </div>
        <div className="pc-readout">
          <ReadoutRow
            label={t('panel.config.factWebSearch')}
            value={configured ? t('panel.config.registered') : t('panel.config.notRegistered')}
            tone={configured ? undefined : 'muted'}
          />
          <ReadoutRow
            label={t('panel.config.factKey')}
            value={configured ? t('panel.config.keySet') : t('panel.config.keyUnset')}
            tone={configured ? undefined : 'muted'}
          />
          <ReadoutRow label={t('panel.config.factBaseUrl')} value={baseLabel} />
          <ReadoutRow label={t('panel.config.factFetchWeb')} value={t('panel.config.unaffected')} />
        </div>
        <p className="pc-side-caption">{t('panel.config.webReadoutHint')}</p>
      </div>
    </>
  );
}

/**
 * One MCP server's fields, on the page its list row opens into.
 *
 * The transport is the rail's business — it decides *where the server runs*,
 * which is a fact about the server rather than a field of the launch — and the
 * main column holds what the server is and what it is given. Switching
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
    <>
      <section className="pc-section">
        <SectionLabel>{t('panel.config.sectionServer')}</SectionLabel>

        <PcField label={t('panel.config.name')} required hint={t('panel.config.nameHint')}>
          <input
            type="text"
            className="cfg-input mono"
            value={server.name}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </PcField>

        {remote ? (
          <>
            <PcField label={t('panel.config.mcpUrl')} required>
              <input
                type="text"
                className="cfg-input mono"
                value={server.url}
                spellCheck={false}
                autoComplete="off"
                placeholder="https://mcp.example.com/mcp"
                onChange={(e) => onChange({ url: e.target.value })}
              />
            </PcField>
            <PcField label={t('panel.config.mcpHeaders')} hint={t('panel.config.mcpHeadersHint')}>
              <textarea
                className="cfg-textarea mono"
                rows={2}
                value={textOfPairs(server.headers)}
                spellCheck={false}
                onChange={(e) => onChange({ headers: pairsOfText(e.target.value) })}
              />
            </PcField>
          </>
        ) : (
          <>
            <PcField label={t('panel.config.mcpCommand')} required>
              <input
                type="text"
                className="cfg-input mono"
                value={server.command}
                spellCheck={false}
                autoComplete="off"
                placeholder="npx"
                onChange={(e) => onChange({ command: e.target.value })}
              />
            </PcField>
            <PcField label={t('panel.config.mcpArgs')} hint={t('panel.config.mcpArgsHint')}>
              <textarea
                className="cfg-textarea mono"
                rows={2}
                value={textOfLines(server.args)}
                spellCheck={false}
                onChange={(e) => onChange({ args: linesOf(e.target.value) })}
              />
            </PcField>
          </>
        )}
      </section>

      <section className="pc-section">
        <SectionLabel>{t('panel.config.sectionAdvanced')}</SectionLabel>

        <PcField label={t('panel.config.mcpEnv')} hint={t('panel.config.pairsHint')}>
          <textarea
            className="cfg-textarea mono"
            rows={2}
            value={textOfPairs(server.env)}
            spellCheck={false}
            onChange={(e) => onChange({ env: pairsOfText(e.target.value) })}
          />
        </PcField>

        {/* Timeout and the start rule share one row, the way the sheet draws
            them: both answer "when does this server run", and neither is a
            consequence of the other. The switch is *not* in the rail with the
            transport — that card answers "where", and folding the two together
            would suggest ticking it changes the transport. */}
        <div className="wb-grid">
          <PcField label={t('panel.config.mcpTimeout')} hint={t('panel.config.mcpTimeoutHint')}>
            <input
              type="text"
              inputMode="decimal"
              className="cfg-input"
              value={server.timeoutSeconds === null ? '' : String(server.timeoutSeconds)}
              placeholder={t('panel.config.timeoutDefault')}
              spellCheck={false}
              onChange={(e) => onChange({ timeoutSeconds: readNumber(e.target.value) })}
            />
          </PcField>

          <div className="wb-row pc-switch">
            <span className="wb-row-main">
              <span className="wb-row-title">{t('panel.config.mcpAutoLoad')}</span>
              <span className="wb-row-hint">{t('panel.config.mcpAutoLoadHint')}</span>
            </span>
            <span className="wb-row-control">
              <button
                type="button"
                role="switch"
                aria-checked={server.autoLoad}
                aria-label={t('panel.config.mcpAutoLoad')}
                className={`tk-switch${server.autoLoad ? ' is-on' : ''}`}
                onClick={() => onChange({ autoLoad: !server.autoLoad })}
              >
                <span className="tk-switch-knob" />
              </button>
            </span>
          </div>
        </div>
      </section>
    </>
  );
}

/** The read-out both server rails show: the facts the runtime computes from a
 *  server, which are the same four on the list and on its page. */
function ServerReadout({ server }: { server: McpServerView }) {
  const t = useT();
  const remote = server.url.trim() !== '';

  return (
    <div className="pc-readout">
      <ReadoutRow
        label={t('panel.config.factTransport')}
        value={remote ? t('panel.config.mcpRemote') : t('panel.config.mcpStdio')}
      />
      <ReadoutRow
        label={t('panel.config.factAutoLoad')}
        value={server.autoLoad ? t('panel.config.autoLoadOn') : t('panel.config.autoLoadOff')}
        tone={server.autoLoad ? undefined : 'muted'}
      />
      <ReadoutRow
        label={t('panel.config.factTimeout')}
        value={
          server.timeoutSeconds === null
            ? t('panel.config.timeoutDefault')
            : t('panel.config.timeoutSeconds', { n: server.timeoutSeconds })
        }
        tone={server.timeoutSeconds === null ? 'muted' : undefined}
      />
      <ReadoutRow
        label={t('panel.config.factEnv')}
        value={
          server.env.length === 0 ? t('panel.config.envNone') : t('panel.config.envCount', { n: server.env.length })
        }
        tone={server.env.length === 0 ? 'muted' : undefined}
      />
    </div>
  );
}

/** The MCP list's rail. The sheet does not draw this list, so it borrows the
 *  routes list's rail exactly: a preview of the row under the cursor, then the
 *  facts. Keeping the two tabs on one geometry is worth more than inventing a
 *  third shape for a list the design never drew. */
function ServerRail({ server }: { server: McpServerView }) {
  const t = useT();
  const remote = server.url.trim() !== '';
  const invocation = invocationOf(server);

  return (
    <>
      <div className="wb-card-above">
        <div className="wb-label-row">
          <span className="wb-label">{t('panel.config.preview')}</span>
        </div>
        <div className="pc-preview">
          <div className="pc-preview-head">
            <span className="pc-preview-dot" aria-hidden />
            <span className="pc-preview-name mono">
              {server.name.trim() === '' ? t('panel.config.untitled') : server.name}
            </span>
            <span className="grow" />
            <Badge tone="neutral" dot={false}>
              {remote ? t('panel.config.mcpRemote') : t('panel.config.mcpStdio')}
            </Badge>
          </div>
          <div className="pc-preview-invocation mono">
            {invocation === '' ? t('panel.config.noInvocation') : invocation}
          </div>
        </div>
      </div>

      <div className="wb-card-above">
        <div className="wb-label-row">
          <span className="wb-label">{t('panel.config.readOut')}</span>
          <span className="grow" />
          <span className="pc-side-note">{t('panel.config.notEditable')}</span>
        </div>
        <ServerReadout server={server} />
      </div>
    </>
  );
}

/**
 * The server page's rail: **the transport first**, because it decides which
 * fields the page's main column even has, then the facts the runtime computes.
 *
 * There is no preview card here — the title already says the name, and the
 * launch fields below say what the server runs — so a card repeating either
 * would be a second answer. The transport card stays on the rail because
 * changing it rewrites a field in the column beside it, and a control that
 * changes other controls belongs where the consequences are read.
 */
function ServerPageRail({
  server,
  onChange,
}: {
  server: McpServerView;
  onChange: (patch: Partial<McpServerView>) => void;
}) {
  const t = useT();
  const remote = server.url.trim() !== '';

  return (
    <>
      <div className="wb-card-above">
        <div className="wb-label-row">
          <span className="wb-label">{t('panel.config.mcpTransport')}</span>
        </div>
        <div className="tk-choice">
          <label className="tk-choice-row">
            <input
              type="radio"
              name="mcp-transport"
              checked={!remote}
              // The runtime refuses a server that names both, so choosing one
              // clears the other — the consequence the hint under this card
              // explains, performed in the one place it is decided.
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
        <p className="pc-side-caption">{t('panel.config.transportHint')}</p>
      </div>

      <div className="wb-card-above">
        <div className="wb-label-row">
          <span className="wb-label">{t('panel.config.readOut')}</span>
          <span className="grow" />
          <span className="pc-side-note">{t('panel.config.notEditable')}</span>
        </div>
        <ServerReadout server={server} />
        <p className="pc-side-caption">{t('panel.config.serverReadoutHint')}</p>
      </div>
    </>
  );
}

/** The invocation a server row and its page both show: the URL for a remote
 *  server, `command args…` for a local one. One function for both readers, so
 *  the preview and the row cannot disagree about what the server runs. */
function invocationOf(server: McpServerView): string {
  const url = server.url.trim();
  if (url !== '') return url;
  return [server.command.trim(), ...server.args].filter((part) => part !== '').join(' ');
}

/** One read-out row: the label on the left, the fact on the right. A fact that
 *  is merely absent is `muted`; one that is wrong is `negative`. */
function ReadoutRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: 'negative' | 'muted';
}) {
  return (
    <span className="pc-readout-row">
      <span>{label}</span>
      <span className={`pc-readout-value${tone === undefined ? '' : ` is-${tone}`}`}>{value}</span>
    </span>
  );
}

/* ---------------- the small pieces ---------------- */

/**
 * Everything the draft would be refused for, above the fields.
 *
 * A component rather than three copies because the list and both pages show the
 * same list: a page can be open while a name is blank, and the sentence that
 * explains the disabled Save has to be on the surface the person is looking at.
 * A refused save is folded into the same list — one error, one position.
 */
function Problems({ problems }: { problems: Problem[] }) {
  if (problems.length === 0) return null;
  return (
    <div className="cfg-problems">
      {problems.map((problem, i) => (
        <div key={i} className={`cfg-problem${problem.blocking ? ' is-blocking' : ''}`}>
          {problem.text}
        </div>
      ))}
    </div>
  );
}

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
 * The two verbs every editor page carries, in the panel's foot.
 *
 * A component because the route and server pages are the same page with
 * different fields: their Save is the panel's Save, and two copies of the
 * disabled rules would eventually disagree about which draft can be written.
 * The list surface keeps the same two verbs in the same band — with its own
 * labels for them — and both read the same `dirty`/`canSave`.
 *
 * The sheet's `[Ghost][Primary]`: a bordered Revert beside the primary was two
 * frames in one corner, and the outline weight belongs to something a reader has
 * to find rather than to the way out of a form.
 */
function EditorActions({
  canSave,
  dirty,
  saving,
  onRevert,
  onSave,
}: {
  canSave: boolean;
  dirty: boolean;
  saving: boolean;
  onRevert: () => void;
  onSave: () => void;
}) {
  const t = useT();
  return (
    <>
      <button type="button" className="btn btn-ghost" disabled={!dirty || saving} onClick={onRevert}>
        {t('panel.config.revertToFile')}
      </button>
      <button type="button" className="btn btn-primary" disabled={!canSave} onClick={onSave}>
        {saving ? t('panel.config.saving') : t('panel.config.saveChanges')}
      </button>
    </>
  );
}

/**
 * The destructive verb, at the footer's leading edge and as **text**, never a
 * filled red button: "危险 · 永远不用实心红". It keeps the app's two-press rule —
 * the first press only arms it, and moving away disarms — which is what makes a
 * one-press-looking control safe to reach for.
 *
 * It moved here from the side column. The sheet puts the way out of a page at
 * the page's foot, as far from Save as one band allows, rather than at the end
 * of a column of facts.
 */
function DeleteAction({ label, onDelete }: { label: string; onDelete: () => void }) {
  const t = useT();
  const [armed, setArmed] = useState(false);

  return (
    <button
      type="button"
      className={`btn btn-destructive cfg-foot-delete${armed ? ' is-armed' : ''}`}
      onMouseLeave={() => setArmed(false)}
      onClick={() => {
        if (armed) onDelete();
        else setArmed(true);
      }}
    >
      {armed ? t('panel.config.removeConfirm') : label}
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
