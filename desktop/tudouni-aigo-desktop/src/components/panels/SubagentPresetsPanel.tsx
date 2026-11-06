import { useEffect, useState, type ReactNode } from 'react';
import { Bot, Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '@/i18n/useT';
import type { Translate } from '@/i18n';
import { Badge, PanelInfo, Tip } from '@/components/ui/kit';
import { Select } from '@/components/ui/Select';
import { readRemoteUserConfig, readUserConfig, writeRemoteUserConfig, writeUserConfig } from '@/runtime/tauri';
import { remoteConnectionOf, useApp } from '@/state/store';
import {
  MAX_SUBAGENT_PRESETS,
  type ConfigDocument,
  type RouteView,
  type SubagentPresetView,
  type SubagentsView,
} from '@/runtime/userConfig';
import { PanelBody, PanelShell } from './PanelShell';

/**
 * The delegation presets: the `subagents` section of `~/.tudouni/config.json`.
 *
 * **Which model a delegated agent runs on is the person's decision**, so it is
 * made here and not in a tool argument: the subagent tool offers the model the
 * preset *names* (an enum) and their purposes, never a model it could invent.
 *
 * It is the Config panel's shape on purpose — read the file once on open, edit a
 * draft, save a patch that carries **only** the `subagents` section, and apply
 * the reply rather than the draft. The Rust merge (`apply_subagents`) moves each
 * preset's existing object into place, so a `$comment` on a preset survives.
 *
 * **The list of presets is a list; one preset opens as a page.** That is the
 * sheet's shape and the Config panel's: a row per preset — a mark, the name, its
 * `default` tag, the route and model it names — and one row opens the page where
 * the six fields are. The panel used to draw every preset as a section of one long
 * form, which made three presets a screenful and no two of them comparable.
 *
 * **`Default preset` lives on the page, not on the list.** The sheet puts it
 * above the page's fields, and it reads well there: "this preset is the one a
 * delegation gets when it names none" is a statement about the preset you are
 * looking at. The list still shows which one that is, as the `default` tag on its
 * row, so the collection's state is visible without opening anything.
 *
 * Like Config, nothing here reaches a running session: the runtime reads the
 * presets when a session opens. That is the decision recorded for this feature
 * ("new sessions only"), and it is why the panel opens with no session at all.
 */
export function SubagentPresetsPanel() {
  const t = useT();
  const [doc, setDoc] = useState<ConfigDocument | null>(null);
  const [draft, setDraft] = useState<SubagentsView | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  /** Which preset's page is up. `index` addresses the draft array. */
  const [editing, setEditing] = useState<number | null>(null);

  // The same "which machine" answer the Config panel uses: on a remote screen the
  // file the runtime reads is the host's, not this machine's.
  const configTarget = useApp((s) => s.configTarget);
  const noteRemoteConfigWritten = useApp((s) => s.noteRemoteConfigWritten);
  const remote = useApp(useShallow((s) => remoteConnectionOf(s, s.activeKey)));

  useEffect(() => {
    let alive = true;
    void (async () => {
      const where = configTarget();
      const loaded = where === null ? await readUserConfig() : await readRemoteUserConfig(where.target);
      if (!alive) return;
      if (loaded === null) {
        setLoadProblem(t('panel.config.unreadable'));
        return;
      }
      setDoc(loaded);
      setDraft(copyOf(loaded.subagents));
    })();
    return () => {
      alive = false;
    };
  }, [t, configTarget]);

  if (loadProblem !== null || doc === null || draft === null) {
    const text = loadProblem ?? t('common.loading');
    return (
      <PanelShell title={t('panel.sp.title')} note={text}>
        <PanelBody>
          {loadProblem !== null ? (
            <div className="cfg-problems">
              <div className="cfg-problem is-blocking">{loadProblem}</div>
            </div>
          ) : (
            <div className="list-empty">
              <div className="le-title">{text}</div>
            </div>
          )}
        </PanelBody>
      </PanelShell>
    );
  }

  const routes = doc.providers;
  const problems = validate(draft, routes);
  const dirty = JSON.stringify(draft) !== JSON.stringify(doc.subagents);
  const canSave = doc.problem === null && dirty && problems.length === 0 && !saving;
  const atCap = draft.presets.length >= MAX_SUBAGENT_PRESETS;

  /* The footer's leading sentence, the same slot the Config panel uses: what
     just happened to the draft, or — when nothing has — nothing at all. The
     sheet's `Unsaved changes` in the warning colour is the dirty branch. */
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
    ) : problems.length > 0 ? (
      <span className="cfg-status-error">{t('panel.config.blocked', { n: problems.length })}</span>
    ) : dirty ? (
      <span className="cfg-status-pending">{t('panel.config.unsaved')}</span>
    ) : null;

  function edit(change: (current: SubagentsView) => SubagentsView) {
    setDraft((current) => (current === null ? current : change(current)));
    setSaved(false);
  }

  function updatePreset(index: number, patch: Partial<SubagentPresetView>) {
    edit((current) => {
      const before = current.presets[index];
      const presets = current.presets.map((p, i) => (i === index ? { ...p, ...patch } : p));
      // A renamed preset that was the default stays the default: the default is
      // a pointer to a preset, and losing it on a rename would silently move
      // every delegation back to the session's model.
      const renamed = patch.name !== undefined && before !== undefined && current.default === before.name;
      return { ...current, presets, default: renamed ? (patch.name ?? '') : current.default };
    });
  }

  function addPreset() {
    if (draft === null || draft.presets.length >= MAX_SUBAGENT_PRESETS) return;
    // The row is written first and then opened, which is what makes the page's
    // fields bind to something the draft already holds — the rule `ConfigPanel`
    // follows for a new route.
    const taken = new Set(draft.presets.map((p) => p.name));
    let n = draft.presets.length + 1;
    while (taken.has(`preset-${n}`)) n += 1;
    const route = routes[0];
    const at = draft.presets.length;
    edit((current) => ({
      ...current,
      presets: [
        ...current.presets,
        {
          name: `preset-${n}`,
          provider: route?.name ?? '',
          model: route?.models[0]?.id ?? '',
          effort: '',
          purpose: '',
        },
      ],
    }));
    setEditing(at);
  }

  function removePreset(index: number) {
    edit((current) => {
      const gone = current.presets[index];
      return {
        presets: current.presets.filter((_, i) => i !== index),
        // Removing the default falls back to "follow the session", which is the
        // one state that needs no preset to exist.
        default: gone !== undefined && current.default === gone.name ? '' : current.default,
      };
    });
    // The page was about a preset that no longer exists; the list is the only
    // surface that can still be true.
    setEditing(null);
  }

  async function save() {
    if (doc === null || draft === null) return;
    setSaving(true);
    setSaveProblem(null);
    try {
      const where = configTarget();
      const patch = { subagents: draft };
      let written: ConfigDocument;
      if (where === null) {
        written = await writeUserConfig(patch);
      } else {
        const result = await writeRemoteUserConfig(where.target, patch);
        written = result.document;
        if (result.configFingerprint !== null) {
          noteRemoteConfigWritten(where.hostId, result.configFingerprint);
        }
      }
      setDoc(written);
      setDraft(copyOf(written.subagents));
      setSaved(true);
    } catch (err) {
      // Every refusal from Rust means nothing was written; shown as-is.
      setSaveProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const footer = (
    <>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={!dirty || saving}
        onClick={() => {
          setDraft(copyOf(doc.subagents));
          setSaveProblem(null);
          setSaved(false);
        }}
      >
        {t('panel.config.revert')}
      </button>
      <button type="button" className="btn btn-primary" disabled={!canSave} onClick={() => void save()}>
        {saving ? t('panel.config.saving') : t('panel.config.save')}
      </button>
    </>
  );

  const alerts =
    problems.length === 0 ? null : (
      <div className="cfg-problems">
        {problems.map((text, i) => (
          <div key={i} className="cfg-problem is-blocking">
            {text}
          </div>
        ))}
      </div>
    );

  /* ---- the preset page (a second surface) ---- */

  const openPreset = editing === null ? undefined : draft.presets[editing];
  if (openPreset !== undefined && editing !== null) {
    return (
      <PanelShell
        onBack={() => setEditing(null)}
        backLabel={t('panel.sp.title')}
        title={openPreset.name.trim() === '' ? t('panel.config.untitled') : openPreset.name}
        // A preset's name is a key — the model passes it as `preset` — so the
        // title wears the same mono shape the route page's name does.
        titleClass="pc-title"
        footHint={status}
        footer={footer}
      >
        <PanelBody>
          <div className="sp-page">
            {alerts}

            <div className="wb-field">
              <span className="cfg-label">{t('panel.sp.default')}</span>
              <Select
                value={draft.default}
                options={defaultOptions(draft, t)}
                onChange={(next) => edit((current) => ({ ...current, default: next }))}
              />
              <span className="cfg-hint">{t('panel.sp.defaultHint')}</span>
            </div>

            {/* The rule the sheet draws between the panel-wide default and this
                preset's own fields, headed by the sheet's `PRESET · 1`. The
                number is the preset's position in the list, which is what the
                label is counting — not a total, which is what the list surface
                already says. The trash rides at the rule's trailing end: the
                destructive verb belongs to the group, not to any one field. */}
            <div className="sp-preset-head">
              <span className="wb-label">{t('panel.sp.section')}</span>
              <span className="wb-label-count">{editing + 1}</span>
              <span className="sp-rule" />
              <Tip label={t('panel.sp.remove')}>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon cfg-danger"
                  aria-label={t('panel.sp.remove')}
                  onClick={() => removePreset(editing)}
                >
                  <Trash2 size={14} />
                </button>
              </Tip>
            </div>

            <div className="wb-grid">
              <Field label={t('panel.sp.name')} hint={t('panel.sp.nameHint')}>
                <input
                  type="text"
                  className="cfg-input mono"
                  value={openPreset.name}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => updatePreset(editing, { name: e.target.value })}
                />
              </Field>

              <Field label={t('panel.sp.route')}>
                <Select
                  value={openPreset.provider}
                  placeholder={t('panel.sp.pick')}
                  options={[
                    // A saved route that is no longer configured stays visible, so
                    // the field shows what the file says instead of silently going
                    // blank.
                    ...(routes.find((r) => r.name === openPreset.provider) === undefined &&
                    openPreset.provider !== ''
                      ? [{ value: openPreset.provider, label: openPreset.provider }]
                      : []),
                    ...routes.map((r) => ({
                      value: r.name,
                      label: r.displayName.trim() !== '' ? `${r.displayName} (${r.name})` : r.name,
                    })),
                  ]}
                  onChange={(provider) => {
                    // A route change resets the model to that route's first one: a
                    // model id from the old route is almost never on the new one,
                    // and the runtime refuses a preset whose model is not on its
                    // route.
                    const next = routes.find((r) => r.name === provider);
                    updatePreset(editing, { provider, model: next?.models[0]?.id ?? '', effort: '' });
                  }}
                />
              </Field>

              <Field label={t('panel.sp.model')}>
                <Select
                  mono
                  value={openPreset.model}
                  placeholder={t('panel.sp.pick')}
                  options={[
                    ...(modelOf(openPreset, routes) === undefined && openPreset.model !== ''
                      ? [{ value: openPreset.model, label: openPreset.model }]
                      : []),
                    ...(routes.find((r) => r.name === openPreset.provider)?.models ?? []).map((m) => ({
                      value: m.id,
                      label: m.label.trim() !== '' ? `${m.label} (${m.id})` : m.id,
                    })),
                  ]}
                  onChange={(next) => updatePreset(editing, { model: next, effort: '' })}
                />
              </Field>

              <Field label={t('panel.sp.effort')}>
                <Select
                  value={openPreset.effort}
                  options={[
                    { value: '', label: t('panel.sp.effortDefault') },
                    ...effortLevelsOf(
                      routes.find((r) => r.name === openPreset.provider),
                      openPreset.model,
                    ).map((level) => ({ value: level, label: level })),
                  ]}
                  onChange={(effort) => updatePreset(editing, { effort })}
                />
              </Field>
            </div>

            {/* The purpose is a sentence, not a key, so it takes the whole width
                under the four short fields rather than a fifth narrow column. */}
            <Field label={t('panel.sp.purpose')} hint={t('panel.sp.purposeHint')}>
              <input
                type="text"
                className="cfg-input"
                value={openPreset.purpose}
                autoComplete="off"
                onChange={(e) => updatePreset(editing, { purpose: e.target.value })}
              />
            </Field>
          </div>
        </PanelBody>
      </PanelShell>
    );
  }

  /* ---- the list surface ---- */

  return (
    <PanelShell
      title={t('panel.sp.title')}
      info={<PanelInfo label={t('panel.sp.about')} />}
      note={t('panel.sp.note')}
      actions={
        <button
          type="button"
          className="btn btn-primary"
          disabled={atCap || routes.length === 0 || doc.problem !== null}
          title={atCap ? t('panel.sp.cap', { n: MAX_SUBAGENT_PRESETS }) : undefined}
          onClick={addPreset}
        >
          <Plus size={13} />
          {t('panel.sp.add')}
        </button>
      }
      footHint={status}
      footer={footer}
    >
      <PanelBody>
        <div className="cfg-surface">
          {alerts}

          <div className="cfg-path-row">
            {remote !== null ? (
              <Badge tone="neutral">
                {remote.user}@{remote.host}
              </Badge>
            ) : null}
            <span className="cfg-path mono" title={doc.path}>
              {doc.path}
            </span>
          </div>
          {doc.problem !== null ? <p className="cfg-file-problem">{doc.problem}</p> : null}
          {routes.length === 0 ? <p className="set-hint">{t('panel.sp.noRoutes')}</p> : null}

          {/* The document default normally lives on a preset's page (see the
              comment at the top of this file). With no presets there is no page
              to open — and a file whose `default` names a preset that is gone
              would then have no way to be cleared, while its own validation
              refuses every save. So on an empty list the field comes here. */}
          {draft.presets.length === 0 ? (
            <div className="wb-field">
              <span className="cfg-label">{t('panel.sp.default')}</span>
              <Select
                value={draft.default}
                options={defaultOptions(draft, t)}
                onChange={(next) => edit((current) => ({ ...current, default: next }))}
              />
              <span className="cfg-hint">{t('panel.sp.defaultHint')}</span>
            </div>
          ) : null}

          {draft.presets.length === 0 ? (
            /* No action button in the empty state: the primary lives in the head,
               and a second copy here would be two doors to one room. */
            <div className="tk-blank">
              <span className="tk-blank-icon">
                <Bot size={20} />
              </span>
              <div className="tk-blank-title">{t('panel.sp.empty')}</div>
              <div className="tk-blank-hint">{t('panel.sp.emptyHint')}</div>
            </div>
          ) : (
            <div className="tk-list">
              {draft.presets.map((preset, index) => (
                <PresetRow
                  key={index}
                  preset={preset}
                  isDefault={draft.default !== '' && draft.default === preset.name}
                  onOpen={() => setEditing(index)}
                />
              ))}
            </div>
          )}
        </div>
      </PanelBody>
    </PanelShell>
  );
}

/**
 * One preset in the list: the same row the routes list draws — a mark, the name
 * with its `default` tag, what the preset names, and a fixed action slot whose
 * button only appears on hover, so the text never reflows under the cursor.
 *
 * There is no overflow menu here: a preset has no order and nothing to duplicate,
 * and the one destructive verb it does have is on its own page, where the
 * decision is made rather than in passing.
 */
function PresetRow({
  preset,
  isDefault,
  onOpen,
}: {
  preset: SubagentPresetView;
  isDefault: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const effort = preset.effort.trim() === '' ? t('panel.sp.effortDefault') : preset.effort;

  return (
    <div className="tk-row">
      <span className="tk-mark" aria-hidden>
        <Bot size={15} />
      </span>

      <div className="tk-row-main">
        <div className="tk-row-title">
          <button type="button" className="tk-row-name" onClick={onOpen}>
            {preset.name.trim() === '' ? t('panel.config.untitled') : preset.name}
          </button>
          {isDefault ? (
            <Badge tone="success" dot={false}>
              {t('panel.config.defaultRoute')}
            </Badge>
          ) : null}
        </div>

        {preset.purpose.trim() !== '' ? <div className="tk-row-desc">{preset.purpose}</div> : null}

        {/* `route · model · effort`, with the interpuncts the routes list uses:
            the three facts a delegation is decided by, on one line. An unset one
            is a dash rather than a call to action — this line is a read-out, and
            the page behind the row is where a value gets chosen. */}
        <div className="tk-row-meta">
          <span className="tk-meta-item mono">{preset.provider.trim() === '' ? '—' : preset.provider}</span>
          <span className="tk-meta-dot" aria-hidden>
            ·
          </span>
          <span className="tk-meta-item mono">{preset.model.trim() === '' ? '—' : preset.model}</span>
          <span className="tk-meta-dot" aria-hidden>
            ·
          </span>
          <span className="tk-meta-item">{effort}</span>
        </div>
      </div>

      <div className="tk-row-actions">
        <button type="button" className="btn btn-outline tk-row-cta" onClick={onOpen}>
          <Pencil size={12} />
          {t('panel.config.edit')}
        </button>
      </div>
    </div>
  );
}

/** One field on the preset page: the label above, the control full width, the
 *  hint under it — the Config page's shape (`.wb-field`). Local because
 *  `PcField` is not exported from `ConfigPanel`, and the two must look the
 *  same. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="wb-field">
      <span className="cfg-label">{label}</span>
      {children}
      {hint ? <span className="cfg-hint">{hint}</span> : null}
    </label>
  );
}

/** The options of the document default: "follow the session", then one per named
 *  preset. A preset whose name is blank cannot be chosen — the runtime would
 *  refuse the pointer — so it is not offered. */
function defaultOptions(draft: SubagentsView, t: Translate) {
  return [
    { value: '', label: t('panel.sp.followSession') },
    ...draft.presets
      .filter((p) => p.name.trim() !== '')
      .map((p) => ({ value: p.name, label: p.name })),
  ];
}

/** The model a preset names, when the route it names still exists. */
function modelOf(
  preset: SubagentPresetView,
  routes: RouteView[],
): RouteView['models'][number] | undefined {
  return routes.find((r) => r.name === preset.provider)?.models.find((m) => m.id === preset.model);
}

/** `state.BroadEffortLevels`: offered when neither the model nor its route
 *  declares a narrower list. */
const BROAD_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function effortLevelsOf(route: RouteView | undefined, modelId: string): string[] {
  const model = route?.models.find((m) => m.id === modelId);
  if (model !== undefined && model.effortLevels.length > 0) return model.effortLevels;
  if (route !== undefined && route.effortLevels.length > 0) return route.effortLevels;
  return BROAD_EFFORT_LEVELS;
}

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * The runtime's checks (`state.ParseSubagentPresets`), mirrored so a file it
 * would refuse at the next open is never written. Every problem blocks: a bad
 * preset stops the session from starting, which is worse than any other
 * outcome of this panel.
 */
function validate(draft: SubagentsView, routes: RouteView[]): string[] {
  const out: string[] = [];
  const names = new Set<string>();
  if (draft.presets.length > MAX_SUBAGENT_PRESETS) {
    out.push(`At most ${MAX_SUBAGENT_PRESETS} presets are allowed.`);
  }
  for (const [index, preset] of draft.presets.entries()) {
    const name = preset.name.trim();
    const label = name === '' ? `Preset ${index + 1}` : `Preset "${name}"`;
    if (!NAME_PATTERN.test(name)) {
      out.push(`${label}: the name must be 1–32 letters, digits, - or _.`);
    } else if (names.has(name)) {
      out.push(`Two presets are both named "${name}".`);
    } else {
      names.add(name);
    }
    const route = routes.find((r) => r.name === preset.provider);
    if (route === undefined) {
      out.push(`${label}: choose a configured route.`);
      continue;
    }
    if (!route.models.some((m) => m.id === preset.model)) {
      out.push(`${label}: choose a model on route "${route.name}".`);
      continue;
    }
    if (preset.effort !== '' && !effortLevelsOf(route, preset.model).includes(preset.effort)) {
      out.push(`${label}: "${preset.effort}" is not an effort level this model takes.`);
    }
  }
  if (draft.default !== '' && !names.has(draft.default)) {
    out.push(`The default preset "${draft.default}" does not exist.`);
  }
  return out;
}

function copyOf(view: SubagentsView): SubagentsView {
  return { default: view.default, presets: view.presets.map((p) => ({ ...p })) };
}
