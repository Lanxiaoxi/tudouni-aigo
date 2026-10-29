import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import {
  NO_ENTRIES,
  useApp,
  useSessionField,
  type SidebarBlockKey,
} from '@/state/store';
import { presentedFiles } from '@/state/entries';
import { useT } from '@/i18n/useT';
import { PanelBody, PanelShell, PopoverSurface } from '@/components/panels/PanelShell';
import { SidebarBlockContent } from '@/components/sidebar/Sidebar';

/**
 * §1·5 The collapsed summary row.
 *
 * One line standing in for the right rail while it is folded: goal, presented
 * files, background jobs, MCP, tasks, skills, SSH — every cell names a block the
 * rail leads with. Rendered only when that rail is folded, so the two never say
 * the same thing twice.
 *
 * **It is the conversation column's second header, not a window-level strip.**
 * It sits inside `.app-conversation`, directly under `.sessionbar`, so it is
 * exactly as wide as the row above it — everything on it is a fact about the
 * conversation beside it, and a bar spanning under both rails read as a third
 * piece of window chrome belonging to no column.
 *
 * **The permission scope is no longer on this row.** "asks on MED+HIGH" used
 * to lead it, and it was the one cell that was a bare fact among doors: every
 * other cell opens the block it counts, and a cell that opened nothing read as
 * a chip with the click stripped off. It keeps its real homes — the settings
 * panel and the collapsed rail row — and loses the third copy.
 *
 * ## Each cell previews on hover, opens on press
 *
 * Resting the pointer on a cell lifts the **block's own content** in the
 * status bar popover's surface (`.st-popover` + `PanelShell`, see
 * `StatusPopover`): the same rows the rail draws, anchored under the cell, so
 * "what is actually in there" no longer costs the rail's width. The grammar is
 * deliberately the *reverse* of the status bar's chips: those are pressed open
 * and pressed shut because the popover is their whole act, while this row's
 * cells exist to open the rail — so here the press keeps its old meaning
 * (`openSidebarBlock`, rail back and block unfolded) and the hover is the
 * preview. `Anchor`, not `Trigger`, is what enforces that split: a press can
 * never toggle the popover, only the rail.
 *
 * **There is no "Sidebar hidden" text and no `Show` button here.** Both existed
 * to announce the fold and to undo it, and both were the second half of the
 * mistake the two in-rail collapse buttons made: the row that replaces a rail
 * is the *worst* place to put the control that brings it back, because it is
 * only on screen once the rail is gone. The way back is the right-hand toggle
 * at the trailing edge of `SessionBar`, which is on screen in both states.
 */

/** The pointer must *rest* before a preview lifts: sweeping across the row on
    the way to somewhere else must not flash six panels. */
const HOVER_OPEN_MS = 120;
/** The grace between cell and panel — crossing that gap must not flicker the
    preview shut, while leaving both for good must close it promptly. */
const HOVER_CLOSE_MS = 150;

export function CollapsedSummary() {
  const t = useT();
  const snap = useSessionField((rt) => rt.uiState, null);
  const entries = useSessionField((rt) => rt.entries, NO_ENTRIES);
  const presented = useMemo(() => presentedFiles(entries), [entries]);
  const openSidebarBlock = useApp((s) => s.openSidebarBlock);

  // Before the handshake there is nothing to report. The row is still drawn —
  // it is the fold the session bar's toggle animates — but it carries no
  // placeholder text: an empty strip is honest, and "Sidebar hidden" was a
  // sentence about the chrome rather than about the session.
  if (!snap) return <div className="collapsed-summary" />;

  const jobTotal = snap.jobs.length;
  const jobUncollected = snap.jobs.filter((job) => job.uncollected).length;
  const mcpLoaded = snap.mcp.filter((server) => server.state === 'loaded').length;
  const taskDone = snap.todos.filter((todo) => todo.status === 'completed').length;
  // The same figure the rail's Goal block badges: the round count once the
  // runtime sends one, the set-but-unnumbered mark before it, and "0" only for
  // a goal that was never set.
  const goalCount = snap.goal.roundsText || (snap.goal.present ? '—' : '0');

  return (
    <div className="collapsed-summary">
      <CsItem blockKey="goal" label={t('block.goal')} onOpen={openSidebarBlock}>
        {goalCount}
      </CsItem>

      {/* The conversation's outputs, counted the same way the rail's block
          badges them: every file presented at least once, not every card. */}
      <CsItem blockKey="files" label={t('block.files')} onOpen={openSidebarBlock}>
        {presented.length}
      </CsItem>

      <CsItem
        blockKey="jobs"
        label={t('block.jobs')}
        onOpen={openSidebarBlock}
        attention={jobUncollected > 0}
      >
        {jobTotal === 0
          ? '0'
          : `${jobUncollected > 0 ? `${jobUncollected} / ` : ''}${jobTotal}`}
      </CsItem>

      <CsItem blockKey="mcp" label={t('block.mcp')} onOpen={openSidebarBlock}>
        {mcpLoaded} / {snap.mcp.length}
      </CsItem>

      <CsItem blockKey="tasks" label={t('block.tasks')} onOpen={openSidebarBlock}>
        {taskDone} / {snap.todos.length}
      </CsItem>

      <CsItem blockKey="skills" label={t('block.skills')} onOpen={openSidebarBlock}>
        {snap.skills.length}
      </CsItem>

      {/* The collapsed line answers the same question the SSH block's badge
          answers: how many connections are actually live. Ended sessions the
          list still keeps are history, and counting them here would read
          "2 SSH" over shells that are already gone — the same rule the TUI's
          summary segment follows (`internal/frontends/tui/rail.go`). */}
      <CsItem blockKey="ssh" label={t('block.ssh')} onOpen={openSidebarBlock}>
        {snap.ssh.filter((row) => row.status === 'running').length}
      </CsItem>
    </div>
  );
}

/**
 * One summary chip: a label and a figure, with **two ways in**.
 *
 * The press is the old act — it brings the right rail back **and** unfolds the
 * block the chip counts (`openSidebarBlock`). The hover is the new one: the
 * block's own content lifts in a `.st-popover` under the cell, the same
 * surface the status bar's panels wear, so the preview cannot be mistaken for
 * a different kind of window. The figure rides along in the panel's head —
 * the chip says "Tasks 1 / 4" and the preview's head says it again, so the
 * two never feel like unrelated numbers.
 *
 * `attention` marks the same uncollected-result state the rail's badge and the
 * status bar's jobs button emphasise: colour, never a new word.
 */
function CsItem({
  blockKey,
  label,
  onOpen,
  attention,
  children,
}: {
  blockKey: SidebarBlockKey;
  label: string;
  onOpen: (k: SidebarBlockKey) => void;
  attention?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A dialog opening drops this popover, exactly as it drops the status bar's:
  // a modal takes `pointer-events` off the body, so a hover that opened before
  // the dialog would hang there over it with no way to be left.
  const storePanel = useApp((s) => s.panel);
  useEffect(() => {
    if (storePanel !== null) setOpen(false);
  }, [storePanel]);

  // The press folds this row away (the rail comes back, `inert` lands on the
  // strip), so any timer still pending fires on a popover that must not
  // reopen; clearing both is also what keeps unmount from updating dead state.
  useEffect(
    () => () => {
      if (openTimer.current !== null) clearTimeout(openTimer.current);
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );

  const clearOpen = () => {
    if (openTimer.current !== null) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };
  const clearClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  // Shared by the cell and the panel: entering either (re)arms the open timer,
  // which is a no-op while the panel is already up, and leaving either arms
  // the close — so the two edges of the gap cancel each other out.
  const armOpen = () => {
    clearClose();
    clearOpen();
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setOpen(true);
    }, HOVER_OPEN_MS);
  };
  const armClose = () => {
    clearOpen();
    clearClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, HOVER_CLOSE_MS);
  };
  // The X in the panel's head, and the press: both are *decisions* to leave,
  // not a hover edge, so no grace period — the preview goes at once and the
  // press goes on to do its own act.
  const dismiss = () => {
    clearOpen();
    clearClose();
    setOpen(false);
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      {/* `Anchor`, not `Trigger`: the anchor positions the panel and touches
          nothing else, so the cell's press stays this row's own act instead of
          becoming the popover's toggle. */}
      <PopoverPrimitive.Anchor asChild>
        <button
          type="button"
          className={`cs-item${attention ? ' is-attention' : ''}`}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onMouseEnter={armOpen}
          onMouseLeave={armClose}
          onClick={() => {
            dismiss();
            onOpen(blockKey);
          }}
        >
          <span>{label}</span>
          <b>{children}</b>
        </button>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        {/* Side `bottom`: the row hangs under the window's top edge, so the
            panel has nowhere to go but down — the status bar's go up for the
            same reason from the other edge. Esc and an outside click reach
            `onOpenChange` and close through the same state the hover does. */}
        <PopoverPrimitive.Content
          className="st-popover cs-popover"
          side="bottom"
          align="start"
          sideOffset={6}
          aria-label={label}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onMouseEnter={armOpen}
          onMouseLeave={armClose}
        >
          <PopoverSurface close={dismiss}>
            <PanelShell title={label} count={children}>
              <PanelBody>
                <SidebarBlockContent blockKey={blockKey} />
              </PanelBody>
            </PanelShell>
          </PopoverSurface>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
