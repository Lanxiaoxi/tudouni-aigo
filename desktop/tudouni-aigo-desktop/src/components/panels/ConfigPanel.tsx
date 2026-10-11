import { useEffect, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronRight, Eye, EyeOff, FolderOpen, Plus, Trash2 } from 'lucide-react';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { Badge, Count, Info, Tip } from '@/components/ui/kit';
import { readUserConfig, revealConfigFile, writeUserConfig } from '@/runtime/tauri';
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
 * **Saving applies the reply, not the draft.** `config_write` answers with the
 * files as they are afterwards, and this stores *that*: what the form shows next
 * is the file's own content, so a value the merge declined to keep cannot sit on
 * screen looking saved. The same rule governs the settings panel's argv display.
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
  const [tab, setTab] = useState<'routes' | 'web' | 'mcp'>('routes');
  // The index the last press of "Add a route" gave a card. That one is drawn
  // unfolded, so the form somebody just asked for is the one they can type into;
  // every other card stays folded, which is the point of folding them at all.
  const [addedRoute, setAddedRoute] = useState(-1);

  // Read once, on open. There is nothing to poll: the file changes when somebody
  // changes it, and the panel is the only writer acting on behalf of this window
  // while it is up.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const loaded = await readUserConfig();
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
  }, [t]);

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

  async function save() {
    if (doc === null || draft === null) return;
    setSaving(true);
    setSaveProblem(null);
    try {
      const written = await writeUserConfig(buildPatch(doc, draft));
      setDoc(written);
      setDraft(draftFrom(written));
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

  const routeCount = draft.providers.length;
  const serverCount = draft.mcp.length;
  // The config file is the one that reads as "the" configuration, so it names
  // the note; `mcp.json` has its own row inside.
  const note = doc.path;

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

  return (
    <PanelShell title={t('panel.config.title')} note={note} footer={footer}>
      <div className="panel-tabs" role="tablist">
        {CONFIG_TABS.map((which) => (
          <button
            key={which}
            type="button"
            role="tab"
            aria-selected={tab === which}
            className={`panel-tab${tab === which ? ' is-on' : ''}`}
            onClick={() => setTab(which)}
          >
            {t(TAB_LABEL[which])}
            <span className="count">
              {which === 'routes' ? routeCount : which === 'mcp' ? serverCount : '·'}
            </span>
          </button>
        ))}
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
            — that is precisely the case this panel cannot fix for them. */}
        <div className="cfg-path-row">
          <span className="cfg-path mono" title={doc.path}>
            {doc.path}
          </span>
          <Tip label={t('panel.config.reveal')}>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-compact"
              aria-label={t('panel.config.reveal')}
              onClick={() => void revealConfigFile(doc.path)}
            >
              <FolderOpen size={13} />
            </button>
          </Tip>
        </div>
        {!doc.exists ? <p className="set-hint">{t('panel.config.missing')}</p> : null}
        {doc.problem !== null ? <p className="cfg-file-problem">{doc.problem}</p> : null}

        {tab === 'routes' ? (
          <>
            <div className="etb-label">{t('panel.config.routes')}</div>
            <p className="set-hint">{t('panel.config.routesHint')}</p>

            {draft.providers.map((route, index) => (
              <RouteCard
                key={index}
                route={route}
                index={index}
                total={draft.providers.length}
                showKeys={showKeys}
                defaultOpen={index === addedRoute}
                onChange={(patch) => updateRoute(index, patch)}
                onModel={(modelIndex, patch) => updateModel(index, modelIndex, patch)}
                onMove={(to) => editDraft((current) => ({ ...current, providers: moved(current.providers, index, to) }))}
                onRemove={() =>
                  editDraft((current) => ({
                    ...current,
                    providers: current.providers.filter((_, i) => i !== index),
                  }))
                }
              />
            ))}

            <button
              type="button"
              className="btn btn-outline btn-compact cfg-add"
              onClick={() => {
                // The new card is the one that opens: it is the form the person
                // just asked for, and it is empty. Every other card keeps the
                // fold the reader left it in.
                setAddedRoute(draft.providers.length);
                editDraft((current) => ({ ...current, providers: [...current.providers, emptyRoute()] }));
              }}
            >
              <Plus size={13} />
              {t('panel.config.addRoute')}
            </button>
          </>
        ) : null}

        {tab === 'web' ? (
          <>
            <div className="etb-label">{t('panel.config.web')}</div>
            <p className="set-hint">{t('panel.config.webHint')}</p>
            <p className="set-hint">{t('panel.config.webAbsent')}</p>

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
            <ShowKeysToggle showKeys={showKeys} onToggle={() => setShowKeys(!showKeys)} />
          </>
        ) : null}

        {tab === 'mcp' ? (
          <>
            <div className="etb-label">{t('panel.config.mcp')}</div>
            <p className="set-hint">{t('panel.config.mcpHint')}</p>
            <div className="cfg-path-row">
              <span className="cfg-path mono" title={doc.mcp.path}>
                {doc.mcp.path}
              </span>
            </div>
            {doc.mcp.problem !== null ? <p className="cfg-file-problem">{doc.mcp.problem}</p> : null}

            {draft.mcp.map((server, index) => (
              <ServerCard
                key={index}
                server={server}
                index={index}
                total={draft.mcp.length}
                onChange={(patch) => updateServer(index, patch)}
                onMove={(to) => editDraft((current) => ({ ...current, mcp: moved(current.mcp, index, to) }))}
                onRemove={() =>
                  editDraft((current) => ({ ...current, mcp: current.mcp.filter((_, i) => i !== index) }))
                }
              />
            ))}

            <button
              type="button"
              className="btn btn-outline btn-compact cfg-add"
              onClick={() => editDraft((current) => ({ ...current, mcp: [...current.mcp, emptyServer()] }))}
            >
              <Plus size={13} />
              {t('panel.config.addServer')}
            </button>
          </>
        ) : null}

        {/* The one sentence that has to be said somewhere. It is at the foot of
            every tab rather than in the head, because it only matters *after*
            somebody has understood what they are looking at. */}
        <p className="set-hint cfg-takes-effect">{t('panel.config.effect')}</p>
      </PanelBody>
    </PanelShell>
  );
}

/* ---------------- the tabs ---------------- */

const CONFIG_TABS = ['routes', 'web', 'mcp'] as const;

const TAB_LABEL: Record<(typeof CONFIG_TABS)[number], TKey> = {
  routes: 'panel.config.routes',
  web: 'panel.config.web',
  mcp: 'panel.config.mcp',
};

/* ---------------- one route ---------------- */

/**
 * One route, as a card.
 *
 * The reorder controls are the point of the card's head, not decoration: the
 * first route with a key is the default route, so dragging a name up is how a
 * person says "use this account by default" — and the panel says so in its hint,
 * because an up-arrow that silently changes where every request is billed is a
 * control nobody would guess.
 */
function RouteCard({
  route,
  index,
  total,
  showKeys,
  defaultOpen = false,
  onChange,
  onModel,
  onMove,
  onRemove,
}: {
  route: RouteView;
  index: number;
  total: number;
  showKeys: boolean;
  /** Drawn unfolded on the one render that follows "Add a route". */
  defaultOpen?: boolean;
  onChange: (patch: Partial<RouteView>) => void;
  onModel: (modelIndex: number, patch: Partial<ModelView>) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const t = useT();
  /* Folded by default. Six rows of fields plus a list of models is a screenful
     per route, and what the panel is opened for most of the time is one route's
     credentials — with every card open, the list of routes is not a list. */
  const [open, setOpen] = useState(defaultOpen);
  /* The models block folds on its own, inside an open card, and starts folded
     too: it is the longest part of a card and the part reached least often. */
  const [modelsOpen, setModelsOpen] = useState(false);
  return (
    <section className="cfg-card">
      <div className="cfg-card-head">
        {/* The fold control wraps the name rather than the whole head: the head
            also carries three icon buttons, and a wrapper that took the click
            would fire on their presses too — a button inside a button is not
            markup a browser accepts, either. */}
        <button type="button" className="cfg-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight size={13} className={`caret${open ? ' caret-open' : ''}`} />
          <span className="cfg-card-title mono">
            {route.name.trim() === '' ? t('panel.config.untitled') : route.name}
          </span>
          {/* No key means the route is in the catalogue but cannot be selected
              (`Provider.Usable()`), which is a state worth showing rather than a
              validation error: a route somebody is about to paste a key into is
              exactly this — and it is the reason a folded card says what it does
              below. */}
          {route.apiKey.trim() === '' ? (
            <Badge tone="warning" dot={false}>
              {t('panel.config.noKey')}
            </Badge>
          ) : null}
          {/* What a folded card still has to say. The model count is the one
              fact the name does not carry, and a route with none of them cannot
              be selected. */}
          <span className="cfg-card-meta">{t('panel.config.modelCount', { n: route.models.length })}</span>
        </button>
        <Tip label={t('panel.config.moveUp')}>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-compact"
            aria-label={t('panel.config.moveUp')}
            disabled={index === 0}
            onClick={() => onMove(index - 1)}
          >
            <ArrowUp size={12} />
          </button>
        </Tip>
        <Tip label={t('panel.config.moveDown')}>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-compact"
            aria-label={t('panel.config.moveDown')}
            disabled={index === total - 1}
            onClick={() => onMove(index + 1)}
          >
            <ArrowDown size={12} />
          </button>
        </Tip>
        <Tip label={t('panel.config.removeRoute')}>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-compact cfg-danger"
            aria-label={t('panel.config.removeRoute')}
            onClick={onRemove}
          >
            <Trash2 size={12} />
          </button>
        </Tip>
      </div>

      {/* Folded, not unmounted: an element that appears and disappears has
          nothing to transition, so the class is what changes. `inert` while
          folded rather than `aria-hidden`, because the body is full of form
          controls — `aria-hidden` over focusable content leaves the Tab key
          reaching things a screen reader has been told to ignore.

          The plain `<div>` in between is load-bearing, and is the same level the
          sidebar's blocks use. A folded track is 0px tall and `.collapse > *`
          gives the child `min-height: 0` so it can be squeezed there — but a
          child carrying vertical padding of its own cannot shrink past it, and
          `.cfg-card-body` has 12px of it. Padding is not what `overflow: hidden`
          clips, so with the body as the direct child a "folded" card still stood
          26px tall with the first row of labels peeking out. The extra level has
          no padding, so the box really does reach zero. */}
      <div className={`collapse${open ? '' : ' is-collapsed'}`} inert={!open}>
        <div>
          <div className="cfg-card-body">
            <div className="cfg-grid">
              <Field label={t('panel.config.name')} hint={t('panel.config.nameHint')}>
                <input
                  type="text"
                  className="cfg-input mono"
                  value={route.name}
                  spellCheck={false}
                  onChange={(e) => onChange({ name: e.target.value })}
                />
              </Field>
              <Field label={t('panel.config.baseUrl')}>
                <input
                  type="text"
                  className="cfg-input mono"
                  value={route.baseUrl}
                  spellCheck={false}
                  placeholder="https://api.example.com"
                  onChange={(e) => onChange({ baseUrl: e.target.value })}
                />
              </Field>
            </div>

            <div className="cfg-grid">
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

            <div className="cfg-grid">
              <Field label={t('panel.config.displayName')} hint={t('panel.config.displayNameHint')}>
                <input
                  type="text"
                  className="cfg-input"
                  value={route.displayName}
                  onChange={(e) => onChange({ displayName: e.target.value })}
                />
              </Field>
              <div className="cfg-field">
                <span className="cfg-label">{t('panel.config.verify')}</span>
                <label className="cfg-check">
                  <input
                    type="checkbox"
                    checked={!route.verify}
                    onChange={(e) => onChange({ verify: !e.target.checked })}
                  />
                  <span>{t('panel.config.skipVerify')}</span>
                </label>
                <span className="cfg-hint">{t('panel.config.verifyHint')}</span>
              </div>
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

            <div className="cfg-models">
              <div className="cfg-models-head">
                {/* The second fold, inside an open card. Folding it is what keeps
                    a route readable when it carries several models: the list is
                    the longest part of the card and the part opened least. */}
                <button
                  type="button"
                  className="cfg-fold"
                  aria-expanded={modelsOpen}
                  onClick={() => setModelsOpen(!modelsOpen)}
                >
                  <ChevronRight size={13} className={`caret${modelsOpen ? ' caret-open' : ''}`} />
                  <span className="cfg-label">{t('panel.config.models')}</span>
                  {/* A route with no models cannot be selected, so the count is
                      the one number a folded row has to carry. */}
                  <Count value={route.models.length} />
                </button>
                <Info label={t('panel.config.modelsHint')} />
              </div>

              <div className={`collapse${modelsOpen ? '' : ' is-collapsed'}`} inert={!modelsOpen}>
                <div className="cfg-models-body">
                  {route.models.map((model, at) => (
                    <div key={at} className="cfg-model">
                      <div className="cfg-model-head">
                        <span className="mono">
                          {model.id.trim() === '' ? t('panel.config.untitled') : model.id}
                        </span>
                        <span className="grow" />
                        <Tip label={t('panel.config.removeModel')}>
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon btn-compact cfg-danger"
                            aria-label={t('panel.config.removeModel')}
                            onClick={() => onChange({ models: route.models.filter((_, i) => i !== at) })}
                          >
                            <Trash2 size={12} />
                          </button>
                        </Tip>
                      </div>
                      <div className="cfg-grid">
                        <Field label={t('panel.config.modelId')}>
                          <input
                            type="text"
                            className="cfg-input mono"
                            value={model.id}
                            spellCheck={false}
                            onChange={(e) => onModel(at, { id: e.target.value })}
                          />
                        </Field>
                        <Field label={t('panel.config.modelLabel')}>
                          <input
                            type="text"
                            className="cfg-input"
                            value={model.label}
                            onChange={(e) => onModel(at, { label: e.target.value })}
                          />
                        </Field>
                      </div>
                      <div className="cfg-grid">
                        <Field label={t('panel.config.contextWindow')} hint={t('panel.config.contextWindowHint')}>
                          {/* Empty is a real answer and not zero: it means "the
                              catalogue does not know", and the interface then
                              reports usage without a percentage. A wrong
                              percentage is worse than none. */}
                          <input
                            type="text"
                            inputMode="numeric"
                            className="cfg-input"
                            value={model.contextWindow === null ? '' : String(model.contextWindow)}
                            placeholder={t('panel.config.contextWindowAbsent')}
                            spellCheck={false}
                            onChange={(e) => onModel(at, { contextWindow: readNumber(e.target.value) })}
                          />
                        </Field>
                        <Field
                          label={t('panel.config.reasoningEffort')}
                          hint={t('panel.config.reasoningEffortHint')}
                        >
                          <input
                            type="text"
                            className="cfg-input mono"
                            value={model.reasoningEffort}
                            spellCheck={false}
                            onChange={(e) => onModel(at, { reasoningEffort: e.target.value })}
                          />
                        </Field>
                      </div>
                      <div className="cfg-grid">
                        <Field
                          label={t('panel.config.modelEffortLevels')}
                          hint={t('panel.config.modelEffortLevelsHint')}
                        >
                          <textarea
                            className="cfg-textarea mono"
                            rows={2}
                            value={textOfLines(model.effortLevels)}
                            spellCheck={false}
                            onChange={(e) => onModel(at, { effortLevels: linesOf(e.target.value) })}
                          />
                        </Field>
                        <div className="cfg-field">
                          <span className="cfg-label">{t('panel.config.vision')}</span>
                          <label className="cfg-check">
                            <input
                              type="checkbox"
                              checked={model.vision}
                              onChange={(e) => onModel(at, { vision: e.target.checked })}
                            />
                            <span>{t('panel.config.visionOn')}</span>
                          </label>
                          <span className="cfg-hint">{t('panel.config.visionHint')}</span>
                        </div>
                      </div>
                    </div>
                  ))}

                  <button
                    type="button"
                    className="btn btn-outline btn-compact cfg-add"
                    onClick={() => onChange({ models: [...route.models, emptyModel()] })}
                  >
                    <Plus size={13} />
                    {t('panel.config.addModel')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------- one MCP server ---------------- */

function ServerCard({
  server,
  index,
  total,
  onChange,
  onMove,
  onRemove,
}: {
  server: McpServerView;
  index: number;
  total: number;
  onChange: (patch: Partial<McpServerView>) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const t = useT();
  // Which transport this row is on. It is decided by which of the two fields has
  // a value, and the form shows only that one — because the runtime accepts
  // exactly one and refuses the both-and-neither cases, so offering both at once
  // would be inviting a refusal.
  const remote = server.url.trim() !== '';
  // Folded like a route, for the same reason and to the same end: both tabs
  // hold cards of one kind, and a head that opens in one tab and not the other
  // is a control nobody can predict.
  const [open, setOpen] = useState(false);

  return (
    <section className="cfg-card">
      <div className="cfg-card-head">
        <button type="button" className="cfg-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight size={13} className={`caret${open ? ' caret-open' : ''}`} />
          <span className="cfg-card-title mono">
            {server.name.trim() === '' ? t('panel.config.untitled') : server.name}
          </span>
          <Badge tone="neutral" dot={false}>
            {remote ? t('panel.config.mcpRemote') : t('panel.config.mcpStdio')}
          </Badge>
        </button>
        <Tip label={t('panel.config.moveUp')}>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-compact"
            aria-label={t('panel.config.moveUp')}
            disabled={index === 0}
            onClick={() => onMove(index - 1)}
          >
            <ArrowUp size={12} />
          </button>
        </Tip>
        <Tip label={t('panel.config.moveDown')}>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-compact"
            aria-label={t('panel.config.moveDown')}
            disabled={index === total - 1}
            onClick={() => onMove(index + 1)}
          >
            <ArrowDown size={12} />
          </button>
        </Tip>
        <Tip label={t('panel.config.removeServer')}>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-compact cfg-danger"
            aria-label={t('panel.config.removeServer')}
            onClick={onRemove}
          >
            <Trash2 size={12} />
          </button>
        </Tip>
      </div>

      {/* The same extra level as a route's card, for the same reason: the body
          carries vertical padding, and a padded child cannot be squeezed to the
          0px a folded track gives it. See the note on `RouteCard`. */}
      <div className={`collapse${open ? '' : ' is-collapsed'}`} inert={!open}>
        <div>
          <div className="cfg-card-body">
            <div className="cfg-grid">
              <Field label={t('panel.config.name')} hint={t('panel.config.nameHint')}>
                <input
                  type="text"
                  className="cfg-input mono"
                  value={server.name}
                  spellCheck={false}
                  onChange={(e) => onChange({ name: e.target.value })}
                />
              </Field>
              <div className="cfg-field">
                <span className="cfg-label">{t('panel.config.mcpTransport')}</span>
                <div className="cfg-choice">
                  <label className="cfg-check">
                    <input
                      type="radio"
                      name={`transport-${index}`}
                      checked={!remote}
                      onChange={() => onChange({ url: '' })}
                    />
                    <span>{t('panel.config.mcpStdio')}</span>
                  </label>
                  <label className="cfg-check">
                    <input
                      type="radio"
                      name={`transport-${index}`}
                      checked={remote}
                      // Switching to remote **clears the command**, because the
                      // runtime refuses a server that names both. Leaving it
                      // behind would produce exactly that refusal on the next
                      // save, and the field it complains about would not even be
                      // on screen.
                      onChange={() => onChange({ command: '' })}
                    />
                    <span>{t('panel.config.mcpRemote')}</span>
                  </label>
                </div>
              </div>
            </div>

            {remote ? (
              <div className="cfg-grid">
                <Field label={t('panel.config.mcpUrl')}>
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
                <Field label={t('panel.config.mcpCommand')}>
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
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------- the small pieces ---------------- */

/** One labelled control. `label` wraps the control, so the two are associated. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="cfg-field">
      <span className="cfg-label">{label}</span>
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
 */
function ShowKeysToggle({ showKeys, onToggle }: { showKeys: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <button type="button" className={`set-toggle cfg-show-keys${showKeys ? ' is-on' : ''}`} aria-pressed={showKeys} onClick={onToggle}>
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
