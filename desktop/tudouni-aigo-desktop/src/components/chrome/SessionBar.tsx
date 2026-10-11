import { LayoutGrid, PanelLeft, PanelLeftClose, PanelRight, PanelRightClose } from 'lucide-react';
import { railBlocked, selectBoardAvailable, useApp, useSessionField } from '@/state/store';
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
 *
 * ## And so is the session board, for the same reason
 *
 * The board's own button sits in the left rail's foot, which is exactly the
 * situation the two toggles were moved here to escape: fold the rail and the
 * control goes with it (`inert`, since a folded rail must leave the tab order).
 * The board is not a rail, so it does not get a toggle — it gets a **second
 * door**, next to the leading toggle and outside the scroller, reading the same
 * gate (`selectBoardAvailable`), the same action and the same labels as the
 * foot's row. One control with two entrances rather than two controls that can
 * disagree.
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
  const setBoardOpen = useApp((s) => s.setBoardOpen);
  // The board's gate is the **workspace's**, not the conversation on screen's:
  // it reports on every session at once, so it must open in the one case Files
  // and Terminal cannot — the session on screen is the one whose child failed
  // to start. `selectBoardAvailable` is the left rail's foot's own question, and
  // reading it from one place is what keeps the bar's copy of this control from
  // ever disagreeing with the rail's about whether it can be pressed.
  const boardAvailable = useApp(selectBoardAvailable);
  // And a panel is a Radix dialog, whose `pointer-events: none` the whole body
  // inherits — so the button has to *say* it is inert, exactly as the rail's
  // foot does. See `railBlocked`.
  const blocked = useApp(railBlocked);
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

  /**
   * The session board's second door, one step in from the leading edge.
   *
   * **The same control as the left rail's foot, not a second one.** The act, the
   * gate and the labels are the same: `selectBoardAvailable` is the question
   * both ask (it is about the *workspace*, so a session whose child failed can
   * still see the board), `setBoardOpen` is the action, and `board.openHint` /
   * `board.title` are the words. Placed here because this bar is where a person
   * looks when the question is "what is everything else doing" — and because it
   * is the one door that survives the rail being folded, which the rail's own
   * foot demonstrably does not: that button is inside the thing it would have to
   * cross, and `inert` while the rail is away.
   *
   * It is drawn as an icon-sized sibling of the two rail toggles rather than as
   * the foot's labelled row: this row is 34px of compact facts, and a labelled
   * button in it would read as one more fact. The tooltip and `aria-label`
   * carry the name, so nothing is lost but pixels.
   *
   * Like them it sits **outside `.sb-scroll`**, so a long session id cannot
   * carry it off the edge — which matters more here than for a toggle: with the
   * left rail folded, this is the only way back to the board.
   */
  const boardButton = (
    <Tip label={t('board.openHint')}>
      <button
        type="button"
        className={`sb-board${boardOpen ? ' is-active' : ''}`}
        aria-label={t('board.title')}
        aria-pressed={boardOpen}
        // The same condition the rail's foot draws, from the same selector:
        // inert while a panel or a drawn prompt owns the screen, and otherwise
        // available whenever the workspace has a child to answer for it —
        // **except** while the board is up, where the button is the way back.
        disabled={blocked || (!boardAvailable && !boardOpen)}
        onClick={() => setBoardOpen(!boardOpen)}
      >
        <LayoutGrid size={14} />
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
        {boardButton}
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
      {boardButton}

      {/* The facts, in their own scroller so the two toggles stay put. The
          `<span className="sep" />` rules that used to sit between the four
          groups are gone with the change to cards: a 1px line separates flat
          text, and between two cards it is a second edge drawn where the cards
          already have one. */}
      <div className="sb-scroll">
        <div className="sb-group">
          <span className="sb-label">{t('session.label')}</span>
          <Fact mono title="session id" className="sb-id">
            {session.id || '—'}
          </Fact>
          {/* Every group keeps its value on the row at any width; what the two
              container tiers in `app.css` remove are the qualifiers around it —
              this fact is one of them. */}
          <Fact className="sb-extra">{session.resumed ? t('session.resumed') : t('session.fresh')}</Fact>
        </div>

        <div className="sb-group">
          <span className="sb-label">{t('session.model')}</span>
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            onClick={() => openPanel('model')}
            title={t('panel.model.title')}
          >
            <span className="mono sb-model">{session.model || '—'}</span>
            {/* The provider is shown separately on purpose: two routes can carry
                the same model name, and "where the request went" is a different
                fact from "which model". A qualifier, so the first tier folds it. */}
            <span className="faint sb-extra">@{session.provider || '—'}</span>
          </button>
        </div>

        <div className="sb-group">
          <span className="sb-label">{t('session.thinking')}</span>
          {/* Degraded, this group's value is the **effort level**, not on/off:
              the level is the decision a reader acts on, and the effort button
              stays as the row's control while this fact folds first. */}
          <Fact mono className="sb-extra">
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
