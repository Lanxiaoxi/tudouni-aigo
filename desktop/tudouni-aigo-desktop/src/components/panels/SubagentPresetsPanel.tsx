import { useEffect, useState, type ReactNode } from 'react';
import { Bot, Check, Plus, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '@/i18n/useT';
import { Badge, PanelInfo } from '@/components/ui/kit';
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
    edit((current) => {
      if (current.presets.length >= MAX_SUBAGENT_PRESETS) return current;
      const taken = new Set(current.presets.map((p) => p.name));
      let n = current.presets.length + 1;
      while (taken.has(`preset-${n}`)) n += 1;
      const route = routes[0];
      return {
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
      };
    });
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
        ) : problems.length > 0 ? (
          <span className="cfg-status-error">{t('panel.config.blocked', { n: problems.length })}</span>
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
          setDraft(copyOf(doc.subagents));
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
    <PanelShell
      title={t('panel.sp.title')}
      info={<PanelInfo label={t('panel.sp.about')} />}
      note={t('panel.sp.note')}
      count={draft.presets.length}
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
      footer={footer}
    >
      <PanelBody>
        {problems.length > 0 ? (
          <div className="cfg-problems">
            {problems.map((text, i) => (
              <div key={i} className="cfg-problem is-blocking">
                {text}
              </div>
            ))}
          </div>
        ) : null}

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

        <section className="pc-section">
          <Field label={t('panel.sp.default')} hint={t('panel.sp.defaultHint')}>
            <select
              className="cfg-input"
              value={draft.default}
              onChange={(e) => edit((current) => ({ ...current, default: e.target.value }))}
            >
              <option value="">{t('panel.sp.followSession')}</option>
              {draft.presets
                .filter((p) => p.name.trim() !== '')
                .map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
        </section>

        {draft.presets.length === 0 ? (
          <div className="tk-blank">
            <span className="tk-blank-icon">
              <Bot size={20} />
            </span>
            <div className="tk-blank-title">{t('panel.sp.empty')}</div>
            <div className="tk-blank-hint">{t('panel.sp.emptyHint')}</div>
          </div>
        ) : (
          draft.presets.map((preset, index) => (
            <PresetCard
              key={index}
              preset={preset}
              routes={routes}
              isDefault={draft.default !== '' && draft.default === preset.name}
              onChange={(patch) => updatePreset(index, patch)}
              onRemove={() => removePreset(index)}
            />
          ))
        )}

        <p className="set-hint cfg-takes-effect">{t('panel.config.effect')}</p>
      </PanelBody>
    </PanelShell>
  );
}

/** One preset, all of its fields on one card: five fields are a form, not a
 *  collection worth a second surface (the web-search tab's reasoning). */
function PresetCard({
  preset,
  routes,
  isDefault,
  onChange,
  onRemove,
}: {
  preset: SubagentPresetView;
  routes: RouteView[];
  isDefault: boolean;
  onChange: (patch: Partial<SubagentPresetView>) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const route = routes.find((r) => r.name === preset.provider);
  const model = route?.models.find((m) => m.id === preset.model);
  const levels = effortLevelsOf(route, preset.model);

  return (
    <section className="pc-section">
      <div className="pc-section-head">
        <span className="pc-section-label mono">{preset.name.trim() === '' ? t('panel.config.untitled') : preset.name}</span>
        {isDefault ? (
          <Badge tone="info" dot={false}>
            {t('panel.config.defaultRoute')}
          </Badge>
        ) : null}
        <span className="pc-rule" />
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-compact cfg-danger"
          aria-label={t('panel.sp.remove')}
          title={t('panel.sp.remove')}
          onClick={onRemove}
        >
          <Trash2 size={13} />
        </button>
      </div>

      <Field label={t('panel.sp.name')} hint={t('panel.sp.nameHint')}>
        <input
          type="text"
          className="cfg-input mono is-short"
          value={preset.name}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </Field>

      <Field label={t('panel.sp.route')}>
        <select
          className="cfg-input"
          value={preset.provider}
          onChange={(e) => {
            // A route change resets the model to that route's first one: a model
            // id from the old route is almost never on the new one, and the
            // runtime refuses a preset whose model is not on its route.
            const next = routes.find((r) => r.name === e.target.value);
            onChange({ provider: e.target.value, model: next?.models[0]?.id ?? '', effort: '' });
          }}
        >
          {route === undefined ? <option value={preset.provider}>{preset.provider || t('panel.sp.pick')}</option> : null}
          {routes.map((r) => (
            <option key={r.name} value={r.name}>
              {r.displayName.trim() !== '' ? `${r.displayName} (${r.name})` : r.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('panel.sp.model')}>
        <select
          className="cfg-input mono"
          value={preset.model}
          onChange={(e) => onChange({ model: e.target.value, effort: '' })}
        >
          {model === undefined ? <option value={preset.model}>{preset.model || t('panel.sp.pick')}</option> : null}
          {(route?.models ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.label.trim() !== '' ? `${m.label} (${m.id})` : m.id}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('panel.sp.effort')}>
        <select className="cfg-input is-tiny" value={preset.effort} onChange={(e) => onChange({ effort: e.target.value })}>
          <option value="">{t('panel.sp.effortDefault')}</option>
          {levels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('panel.sp.purpose')} hint={t('panel.sp.purposeHint')}>
        <input
          type="text"
          className="cfg-input"
          value={preset.purpose}
          autoComplete="off"
          onChange={(e) => onChange({ purpose: e.target.value })}
        />
      </Field>
    </section>
  );
}

/** The Config editor's row shape (`.pc-row`), local because `PcField` is not
 *  exported and the two must look the same. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="pc-row">
      <span className="pc-label">{label}</span>
      <span className="pc-control">
        {children}
        {hint ? <span className="cfg-hint">{hint}</span> : null}
      </span>
    </label>
  );
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
