import { PanelLeft, PanelLeftClose } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useApp, useSessionField, selectAskOn } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Fact, Tip } from '@/components/ui/kit';
import type { TKey } from '@/i18n';

/**
 * §1·2 Session bar: session id, resumed or new, model, thinking, effort, step
 * cap — and the **permission state**.
 *
 * The permission segment is a **read-only statement of fact**, not a control
 * (§1·2, §9.5). It is drawn with a dashed edge and `cursor: default` so it does
 * not read as a switch.
 *
 * Where each fact comes from:
 *   - id / resumed / step cap / stream: the handshake (`init`).
 *   - model / provider / thinking / effort: the handshake, then `ui(state)` —
 *     the runtime is the authority, and the display follows it rather than the
 *     request that asked for the change.
 *   - which risks will be asked about: `ui(state).risk_scope`, computed by the
 *     runtime. This view does not know that "low" is the default.
 */
export function SessionBar() {
  const t = useT();
  // Everything on this row is a statement about **one** conversation, so it all
  // comes from the session being shown.
  const key = useApp((s) => s.activeKey);
  const session = useSessionField((rt) => rt.session, null);
  const autopilot = useSessionField((rt) => rt.uiState?.autopilot ?? false, false);
  // `useShallow`: the selector builds a new array, and identity comparison would
  // otherwise re-render forever without ever committing.
  const askOn = useApp(useShallow((s) => selectAskOn(s, key)));
  const openPanel = useApp((s) => s.openPanel);

  // The left rail's toggle. It sits **outside** the rail on purpose: a control
  // that lives inside the thing it hides cannot bring that thing back, so the
  // rail's own collapse button left `Ctrl+L` as the only way home — not
  // something a mouse user can discover. Here it is always on screen, in the row
  // that names the session, immediately above the rail it folds.
  const leftbarVisible = useApp((s) => s.leftbarVisible);
  const toggleLeftbar = useApp((s) => s.toggleLeftbar);
  const railToggle = (
    <Tip label={leftbarVisible ? t('lb.collapse') : t('lb.show')}>
      <button
        type="button"
        className="rail-toggle"
        aria-label={leftbarVisible ? t('lb.collapse') : t('lb.show')}
        aria-expanded={leftbarVisible}
        aria-keyshortcuts="Control+L"
        onClick={toggleLeftbar}
      >
        {leftbarVisible ? <PanelLeftClose size={14} /> : <PanelLeft size={14} />}
      </button>
    </Tip>
  );

  if (!session) {
    // The toggle is rendered in this state too. Before the handshake lands there
    // are no facts to show, and leaving the button out of the placeholder would
    // make it appear only once a runtime answered — which is exactly when
    // somebody who hid the rail is least likely to look here for it.
    return (
      <div className="sessionbar">
        {railToggle}
        <span className="sb-label">{t('session.label')}</span>
        <span className="muted">—</span>
      </div>
    );
  }

  const askLabel = autopilot
    ? t('session.permAuto')
    : askOn.length === 0
      ? t('session.permNone')
      : askOn.map((risk) => t(`risk.${risk}` as TKey)).join(' + ');

  return (
    <div className="sessionbar">
      {railToggle}

      <div className="sb-group">
        <span className="sb-label">{t('session.label')}</span>
        <Fact mono title="session id">
          {session.id || '—'}
        </Fact>
        <Fact>{session.resumed ? t('session.resumed') : t('session.fresh')}</Fact>
      </div>

      <span className="sep" />

      <div className="sb-group">
        <span className="sb-label">{t('session.model')}</span>
        <button
          type="button"
          className="btn btn-ghost btn-compact"
          onClick={() => openPanel('model')}
          title={t('panel.model.title')}
        >
          <span className="mono">{session.model || '—'}</span>
          {/* The provider is shown separately on purpose: two routes can carry
              the same model name, and "where the request went" is a different
              fact from "which model". */}
          <span className="faint">@{session.provider || '—'}</span>
        </button>
      </div>

      <span className="sep" />

      <div className="sb-group">
        <span className="sb-label">{t('session.thinking')}</span>
        <Fact mono>
          {session.thinking ? t('session.thinkingOn') : t('session.thinkingOff')}
        </Fact>
        <Tip label={t('panel.effort.note')}>
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            onClick={() => openPanel('effort')}
          >
            <span className="faint">{t('session.effort')}</span>
            {/* Shown as set, never converted: thinking can be off while an
                effort is still recorded, and that is the user's intent. */}
            <span className="mono">{session.effort || '—'}</span>
          </button>
        </Tip>
      </div>

      <span className="sep" />

      <div className="sb-group">
        <span className="sb-label">{t('session.maxSteps')}</span>
        <Fact mono>{session.maxSteps}</Fact>
      </div>

      <div className="sb-right">
        <Tip label={t('session.permScope')}>
          <span className="perm-scope">
            <span>{t('session.permScope')}</span>
            <span className="mono">{askLabel}</span>
          </span>
        </Tip>
      </div>
    </div>
  );
}
