import { PanelLeft, PanelLeftClose, PanelRight, PanelRightClose } from 'lucide-react';
import { useApp, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Fact, Tip } from '@/components/ui/kit';

/**
 * §1·2 Session bar: session id, resumed or new, model, thinking, effort and
 * step cap. It is **the conversation column's header**, not the window's: every
 * fact on it names the conversation on screen, so it is drawn inside
 * `.app-conversation` and the two sidebars reach the top of this row.
 *
 * Where each fact comes from:
 *   - id / resumed / step cap / stream: the handshake (`init`).
 *   - model / provider / thinking / effort: the handshake, then `ui(state)` —
 *     the runtime is the authority, and the display follows it rather than the
 *     request that asked for the change.
 *
 * The permission statement ("which risks will ask") is **not** here: stripped
 * when the bar became the conversation column's header, because it is a
 * sidebar-level fact — the collapsed summary already renders it, and a second
 * reading of the runtime's judgement was one copy too many. The panels
 * (`SettingsPanel`) and the collapsed row remain its homes.
 *
 * ## Both rails are folded from here
 *
 * The two toggles flank this row — the left rail's at the leading edge, the
 * right rail's at the trailing one — and both are **outside the facts' scroller**
 * (`.sb-scroll`), so neither can be scrolled out of reach by a long session id.
 *
 * The rule behind that is the one this bar was built for: *a control that lives
 * inside the thing it hides cannot bring that thing back*. The left rail used to
 * carry its own collapse button inside its head, which left `Ctrl+L` as the only
 * way home for a mouse user; the right rail then repeated the same mistake with
 * `Ctrl+B` and a `Show` button that only existed once the rail was already gone.
 * Both of those in-rail buttons are gone, and these two are the whole of the
 * mechanism: always on screen, in the row that names the conversation, one above
 * the rail it folds.
 */
export function SessionBar() {
  const t = useT();
  // Everything on this row is a statement about **one** conversation, so it all
  // comes from the session being shown.
  const session = useSessionField((rt) => rt.session, null);
  const openPanel = useApp((s) => s.openPanel);

  const leftbarVisible = useApp((s) => s.leftbarVisible);
  const toggleLeftbar = useApp((s) => s.toggleLeftbar);
  const sidebarVisible = useApp((s) => s.sidebarVisible);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  // `Ctrl+B` refuses to toggle under the session board, because `showSidebar` is
  // *derived* (`sidebarVisible && !hiddenByCss && !boardOpen`): writing the
  // preference there would change nothing on screen and then bring the rail back
  // in the opposite state once the board closed. The button asks the same
  // question so the two agree, rather than one of them silently doing nothing.
  const boardOpen = useApp((s) => s.boardOpen);

  const leftToggle = (
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

  // The mirror of the left one, at the trailing edge — the same shape, the same
  // shortcut discipline, and the same label vocabulary, so the two read as a
  // pair rather than as two controls that happen to be square.
  const rightToggle = (
    <Tip label={sidebarVisible ? t('rail.collapse') : t('rail.show')}>
      <button
        type="button"
        className="rail-toggle rail-toggle-end"
        aria-label={sidebarVisible ? t('rail.collapse') : t('rail.show')}
        aria-expanded={sidebarVisible}
        aria-keyshortcuts="Control+B"
        disabled={boardOpen}
        onClick={toggleSidebar}
      >
        {sidebarVisible ? <PanelRightClose size={14} /> : <PanelRight size={14} />}
      </button>
    </Tip>
  );

  if (!session) {
    // The toggles are rendered in this state too. Before the handshake lands
    // there are no facts to show, and leaving them out of the placeholder would
    // make them appear only once a runtime answered — which is exactly when
    // somebody who hid a rail is least likely to look here for it.
    return (
      <div className="sessionbar">
        {leftToggle}
        <div className="sb-scroll">
          <span className="sb-label">{t('session.label')}</span>
          <span className="muted">—</span>
        </div>
        {rightToggle}
      </div>
    );
  }

  return (
    <div className="sessionbar">
      {leftToggle}

      {/* The facts, in their own scroller so the two toggles stay put. The
          `<span className="sep" />` rules that used to sit between the four
          groups are gone with the change to cards: a 1px line separates flat
          text, and between two cards it is a second edge drawn where the cards
          already have one. */}
      <div className="sb-scroll">
        <div className="sb-group">
          <span className="sb-label">{t('session.label')}</span>
          <Fact mono title="session id">
            {session.id || '—'}
          </Fact>
          <Fact>{session.resumed ? t('session.resumed') : t('session.fresh')}</Fact>
        </div>

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

        <div className="sb-group">
          <span className="sb-label">{t('session.maxSteps')}</span>
          <Fact mono>{session.maxSteps}</Fact>
        </div>
      </div>

      {rightToggle}
    </div>
  );
}
