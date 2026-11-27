import { useEffect, useState } from 'react';
import { Check, Eye, EyeOff, FolderOpen, PartyPopper, Send } from 'lucide-react';
import { activeRuntime, NO_ENTRIES, useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { Logo } from '@/components/ui/Logo';
import { checkWorkspace, chooseWorkspaceDirectory, readUserConfig, writeUserConfig } from '@/runtime/tauri';
import { blockingProblems, buildPatch, draftFrom, validateDraft, type ConfigDocument } from '@/runtime/userConfig';
import {
  PRESETS,
  formFor,
  formProblems,
  presetById,
  routeFromForm,
  withRouteFirst,
  type PresetId,
  type ProviderForm,
} from '@/onboarding/presets';
import { helloAnswered } from '@/onboarding/hello';
import { formatPath } from '@/utils/format';

/**
 * The first-run guide: configure one provider, choose a workspace, say hi.
 *
 * The first two steps take the conversation column (`conversationView` returns
 * `onboarding`), because before both exist there is nothing else that works.
 * The third does not: it is a real session, so the reply is read in the real
 * transcript and sent from the real composer — `OnboardingHello` is only the
 * banner above it. Nothing here is a second implementation: the config write is
 * the config panel's door (`writeUserConfig` + `buildPatch`), and the session is
 * opened by `attachSession` like any other.
 *
 * Failures are not handled beyond showing what the call said: a model that does
 * not answer leaves the guide on its last step, which the person can skip.
 */
export function Onboarding() {
  const step = useApp((s) => s.onboarding);
  return (
    <div className="welcome scroll-fade">
      <div className="welcome-inner onb">
        {step === 'workspace' ? <WorkspaceStep /> : <ProviderStep />}
      </div>
    </div>
  );
}

function StepHead({ n, title, lead }: { n: number; title: TKey; lead: TKey }) {
  const t = useT();
  return (
    <header className="onb-head">
      <div className="wi-logo">
        <Logo size={26} />
        <span className="onb-step mono">{t('onboarding.stepOf', { n })}</span>
      </div>
      <h1>{t(title)}</h1>
      <p className="onb-lead">{t(lead)}</p>
    </header>
  );
}

const PROBLEM_KEY: Record<string, TKey> = {
  key: 'onboarding.problem.key',
  baseUrl: 'onboarding.problem.baseUrl',
  model: 'onboarding.problem.model',
};

function ProviderStep() {
  const t = useT();
  const setStep = useApp((s) => s.setOnboardingStep);
  const finish = useApp((s) => s.finishOnboarding);
  const openPanel = useApp((s) => s.openPanel);

  const [doc, setDoc] = useState<ConfigDocument | null | 'loading'>('loading');
  const [form, setForm] = useState<ProviderForm>(() => formFor(PRESETS[0].id));
  const [showKey, setShowKey] = useState(false);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void readUserConfig().then((read) => {
      if (live) setDoc(read);
    });
    return () => {
      live = false;
    };
  }, []);

  const preset = presetById(form.preset);
  const problems = formProblems(form);

  function choose(id: PresetId) {
    // Switching cards keeps a pasted key: the person may simply have picked the
    // wrong card first, and retyping a 60-character secret is the cost of that.
    setForm((current) => ({ ...formFor(id), apiKey: current.apiKey }));
    setSaveProblem(null);
  }

  async function save() {
    setTouched(true);
    if (problems.length > 0 || doc === 'loading' || doc === null || doc.problem !== null) return;
    const draft = withRouteFirst(draftFrom(doc), routeFromForm(form));
    const blocking = blockingProblems(validateDraft(draft));
    if (blocking.length > 0) {
      setSaveProblem(blocking.map((p) => p.text).join(' '));
      return;
    }
    setSaving(true);
    setSaveProblem(null);
    try {
      await writeUserConfig(buildPatch(doc, draft));
      setStep('workspace');
    } catch (err) {
      // Rust's refusal is the authority on why nothing was written.
      setSaveProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (doc === 'loading') {
    return <p className="muted">{t('onboarding.loading')}</p>;
  }

  // A file that cannot be read is not overwritten from here: the config panel
  // is the place that shows what is wrong with it.
  const broken = doc === null ? t('onboarding.unreadable') : doc.problem;

  return (
    <>
      <StepHead n={1} title="onboarding.title.provider" lead="onboarding.lead.provider" />

      {broken !== null ? (
        <div className="onb-problem" role="alert">
          <span>{t('onboarding.configBroken', { problem: broken })}</span>
          <button type="button" className="btn btn-secondary btn-compact" onClick={() => openPanel('config')}>
            {t('onboarding.openConfig')}
          </button>
        </div>
      ) : (
        <form
          className="onb-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="onb-presets" role="radiogroup" aria-label={t('onboarding.field.provider')}>
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={form.preset === p.id}
                className={`onb-preset${form.preset === p.id ? ' is-selected' : ''}`}
                onClick={() => choose(p.id)}
              >
                <span className="onb-preset-name">{p.id === 'custom' ? t('onboarding.preset.custom') : p.label}</span>
                <span className="onb-preset-meta mono">{p.baseUrl === '' ? '—' : formatPath(p.baseUrl, 32)}</span>
              </button>
            ))}
          </div>

          <label className="onb-field">
            <span className="onb-label">
              {preset.needsKey ? t('onboarding.field.key') : t('onboarding.field.keyOptional')}
            </span>
            <span className="input">
              <input
                type={showKey ? 'text' : 'password'}
                value={form.apiKey}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                aria-invalid={touched && problems.includes('key')}
              />
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? t('onboarding.hideKey') : t('onboarding.showKey')}
                aria-pressed={showKey}
              >
                {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </span>
            {!preset.needsKey ? <span className="onb-note">{t('onboarding.ollamaNote')}</span> : null}
          </label>

          <div className="onb-row">
            <label className="onb-field">
              <span className="onb-label">{t('onboarding.field.baseUrl')}</span>
              <span className="input">
                <input
                  type="url"
                  value={form.baseUrl}
                  spellCheck={false}
                  placeholder="https://…/v1"
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                  aria-invalid={touched && problems.includes('baseUrl')}
                />
              </span>
            </label>
            <label className="onb-field">
              <span className="onb-label">{t('onboarding.field.model')}</span>
              <span className="input">
                <input
                  type="text"
                  value={form.model}
                  spellCheck={false}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                  aria-invalid={touched && problems.includes('model')}
                />
              </span>
            </label>
          </div>

          <p className="onb-note">{t('onboarding.savedTo', { path: doc?.path ?? '' })}</p>

          {touched && problems.length > 0 ? (
            <ul className="onb-problems" role="alert">
              {problems.map((p) => (
                <li key={p}>{t(PROBLEM_KEY[p])}</li>
              ))}
            </ul>
          ) : null}
          {saveProblem !== null ? (
            <div className="onb-problem" role="alert">
              {saveProblem}
            </div>
          ) : null}

          <div className="onb-actions">
            <button type="button" className="btn btn-ghost" onClick={finish}>
              {t('onboarding.skip')}
            </button>
            <button type="submit" className={`btn btn-primary${saving ? ' btn-busy' : ''}`} disabled={saving}>
              {saving ? t('onboarding.saving') : t('onboarding.next')}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

function WorkspaceStep() {
  const t = useT();
  const lastWorkspace = useApp((s) => s.lastWorkspace);
  const setStep = useApp((s) => s.setOnboardingStep);
  const finish = useApp((s) => s.finishOnboarding);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  async function open(path: string | null) {
    if (path === null) return;
    setRefusal(null);
    setOpening(true);
    try {
      // The same rule the spawn applies, asked while the choice is on screen
      // rather than after a child has exited with code 2.
      const refused = await checkWorkspace(path);
      if (refused !== null) {
        setRefusal(refused);
        return;
      }
      const store = useApp.getState();
      store.addWorkspace(path);
      // The step moves first: the column hands back to the ordinary views, so
      // the session's own "starting…" (or its refusal) is what is drawn.
      setStep('hello');
      const key = await store.attachSession({ workspace: path });
      if (key !== null && useApp.getState().activeKey === key) {
        const current = activeRuntime(useApp.getState());
        // Only into an empty box: a draft is the person's.
        if (current && current.draft === '') useApp.getState().setDraft(t('onboarding.hello.prompt'));
      }
    } finally {
      setOpening(false);
    }
  }

  return (
    <>
      <StepHead n={2} title="onboarding.title.workspace" lead="onboarding.lead.workspace" />
      <div className="onb-choices">
        <button
          type="button"
          className="btn btn-primary"
          disabled={opening}
          onClick={() => void chooseWorkspaceDirectory().then(open)}
        >
          <FolderOpen size={13} />
          <span>{t('onboarding.chooseFolder')}</span>
        </button>
        {lastWorkspace !== null ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={opening}
            onClick={() => void open(lastWorkspace)}
          >
            <span>{t('onboarding.useLast', { path: formatPath(lastWorkspace, 40) })}</span>
          </button>
        ) : null}
      </div>
      {refusal !== null ? (
        <div className="onb-problem" role="alert">
          {t('onboarding.refused', { reason: refusal })}
        </div>
      ) : null}
      <div className="onb-actions">
        <button type="button" className="btn btn-ghost" onClick={() => setStep('provider')}>
          {t('onboarding.back')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={finish}>
          {t('onboarding.skip')}
        </button>
      </div>
    </>
  );
}

/**
 * Step 3, drawn above the composer of the session the guide opened.
 *
 * It watches the transcript on screen and moves to `done` the moment a reply
 * to a message typed in this window lands (`helloAnswered`). The guide is only
 * recorded as finished when the person closes the banner.
 */
export function OnboardingHello() {
  const t = useT();
  const step = useApp((s) => s.onboarding);
  const setStep = useApp((s) => s.setOnboardingStep);
  const finish = useApp((s) => s.finishOnboarding);
  const entries = useApp((s) => activeRuntime(s)?.entries ?? NO_ENTRIES);
  const answered = helloAnswered(entries);

  useEffect(() => {
    if (step === 'hello' && answered) setStep('done');
  }, [step, answered, setStep]);

  if (step !== 'hello' && step !== 'done') return null;
  const done = step === 'done';

  return (
    <div className={`onb-banner${done ? ' is-done' : ''}`} role="status">
      <span className="onb-banner-icon">{done ? <PartyPopper size={14} /> : <Send size={14} />}</span>
      <span className="onb-banner-text">
        <span className="onb-step mono">{t('onboarding.stepOf', { n: 3 })}</span>{' '}
        {done ? t('onboarding.hello.done') : t('onboarding.hello.hint')}
      </span>
      <button type="button" className={`btn btn-compact ${done ? 'btn-primary' : 'btn-ghost'}`} onClick={finish}>
        {done ? (
          <>
            <Check size={12} />
            <span>{t('onboarding.finish')}</span>
          </>
        ) : (
          t('onboarding.skip')
        )}
      </button>
    </div>
  );
}
