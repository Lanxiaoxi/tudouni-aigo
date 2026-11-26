import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Plus, Square, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { useT } from '@/i18n/useT';
import { useApp } from '@/state/store';
import { useWorkspaceUi } from '@/state/workspaceDock/selectors';
import { EmptyState, Tip } from '@/components/ui/kit';
import {
  activeHostTarget,
  useWorkspaceConnection,
  type TerminalInfo,
} from '@/workspaceHost';
import type { DockModuleProps } from '../modules';
import { onTerminalRequest } from '../dockActions';
import { terminalHosts } from './hostManager';
import { pickAfterClose, tabName } from './tabs';

/**
 * The body of the Terminal Dock (docs/design/workspace-dock.md §2.4, §7).
 *
 * This component is **only a view** of `terminalHosts`: it lists the manager's
 * terminals for the workspace, shows one of them in a slot, and forwards the
 * person's acts. Folding the area, switching workspace or closing the Dock
 * unmounts it, and nothing is disposed or detached by that — the emulators and
 * the PTY attaches live in the manager.
 */

type Pending = { kind: 'close' | 'kill'; id: string; name: string };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function TerminalDock({ workspace }: DockModuleProps) {
  const t = useT();
  const { workspaceId } = workspace;
  const ui = useWorkspaceUi(workspaceId);
  const connection = useWorkspaceConnection(workspaceId);
  const terminals = useSyncExternalStore(
    terminalHosts.subscribe,
    () => terminalHosts.terminals(workspaceId),
    () => terminalHosts.terminals(workspaceId),
  );

  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set by an act of the person (new, pick a tab): the next surface takes the keyboard. */
  const focusNext = useRef(false);

  const activeId =
    terminals.find((x) => x.id === ui.activeTerminalId)?.id ?? terminals[terminals.length - 1]?.id ?? null;

  const setActive = useCallback(
    (id: string | null) => useApp.getState().setWorkspaceActiveTerminal(workspaceId, id),
    [workspaceId],
  );

  /* Follow the workspace's terminals: list, attach, and (after a reconnect)
     re-attach from the last offset. The manager does the work; this only
     says "this workspace is being looked at". */
  useEffect(() => {
    const target = activeHostTarget(useApp.getState());
    if (target === null || target.workspaceId !== workspaceId) return;
    let live = true;
    terminalHosts
      .open(target)
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoadedFor(workspaceId);
      });
    return () => {
      live = false;
    };
  }, [workspaceId, connection.connectedAt]);

  const create = useCallback(
    async (cwd?: string) => {
      const target = activeHostTarget(useApp.getState());
      if (target === null || target.workspaceId !== workspaceId) return;
      setCreating(true);
      setError(null);
      try {
        await terminalHosts.open(target);
        const id = await terminalHosts.create(workspaceId, cwd ? { cwd } : {});
        focusNext.current = true;
        setActive(id);
      } catch (err) {
        setError(t('dock.term.error.create', { message: messageOf(err) }));
      } finally {
        setCreating(false);
      }
    },
    [workspaceId, setActive, t],
  );

  /* "Open terminal here" from the Explorer. The request is kept by the emitter
     until something listens, so a click made while this area was folded is
     delivered the moment it mounts. */
  const createRef = useRef(create);
  createRef.current = create;
  useEffect(
    () =>
      onTerminalRequest((cwd) => {
        const s = useApp.getState();
        s.setDockOpen(true);
        s.setDockTermVisible(true);
        void createRef.current(cwd);
      }),
    [],
  );

  const act = useCallback(
    async (fn: () => Promise<void>) => {
      setError(null);
      try {
        await fn();
      } catch (err) {
        setError(t('dock.term.error.act', { message: messageOf(err) }));
      }
    },
    [t],
  );

  const doClose = useCallback(
    (id: string) => {
      const next = pickAfterClose(terminals, id, activeId);
      focusNext.current = true;
      void act(async () => {
        await terminalHosts.close(workspaceId, id);
        if (next !== activeId) setActive(next);
      });
    },
    [terminals, activeId, act, workspaceId, setActive],
  );

  const requestClose = (info: TerminalInfo) => {
    // An ended terminal holds nothing that is lost by forgetting it.
    if (info.state === 'exited') doClose(info.id);
    else setPending({ kind: 'close', id: info.id, name: tabName(info) });
  };

  const confirmPending = () => {
    const p = pending;
    setPending(null);
    if (!p) return;
    focusNext.current = true;
    if (p.kind === 'close') doClose(p.id);
    else void act(() => terminalHosts.kill(workspaceId, p.id));
  };

  if (loadedFor !== workspaceId && terminals.length === 0) {
    return <div className="dterm" aria-busy="true" />;
  }

  const active = terminals.find((x) => x.id === activeId) ?? null;

  return (
    <div className="dterm">
      {terminals.length === 0 ? (
        <div className="dterm-empty">
          <EmptyState title={t('dock.term.empty.title')} hint={t('dock.term.empty.hint')} />
          <button type="button" className="btn btn-outline btn-compact" disabled={creating} onClick={() => void create()}>
            <Plus size={13} />
            {t('dock.term.new')}
          </button>
        </div>
      ) : (
        <>
          <TabStrip
            terminals={terminals}
            activeId={activeId}
            renaming={renaming}
            creating={creating}
            onPick={(id) => {
              focusNext.current = true;
              setActive(id);
            }}
            onNew={() => void create()}
            onClose={requestClose}
            onKill={(info) => setPending({ kind: 'kill', id: info.id, name: tabName(info) })}
            onRenameStart={setRenaming}
            onRenameDone={(id, name) => {
              if (name !== null) terminalHosts.rename(workspaceId, id, name);
              setRenaming(null);
              focusNext.current = true;
              terminalHosts.focus(workspaceId, id);
            }}
          />
          {error !== null ? (
            <div className="dterm-error" role="alert">
              <span>{error}</span>
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-compact"
                aria-label={t('common.close')}
                onClick={() => setError(null)}
              >
                <X size={12} />
              </button>
            </div>
          ) : null}
          {active !== null ? (
            <Surface
              key={`${workspaceId}/${active.id}`}
              workspaceId={workspaceId}
              info={active}
              focusNext={focusNext}
            />
          ) : null}
        </>
      )}
      <ConfirmDialog pending={pending} onCancel={() => setPending(null)} onConfirm={confirmPending} />
    </div>
  );
}

/* ============================================================
   Tab strip
   ============================================================ */

function TabStrip({
  terminals,
  activeId,
  renaming,
  creating,
  onPick,
  onNew,
  onClose,
  onKill,
  onRenameStart,
  onRenameDone,
}: {
  terminals: readonly TerminalInfo[];
  activeId: string | null;
  renaming: string | null;
  creating: boolean;
  onPick: (id: string) => void;
  onNew: () => void;
  onClose: (info: TerminalInfo) => void;
  onKill: (info: TerminalInfo) => void;
  onRenameStart: (id: string) => void;
  onRenameDone: (id: string, name: string | null) => void;
}) {
  const t = useT();
  const stripRef = useRef<HTMLDivElement>(null);

  const focusTab = (id: string) => {
    requestAnimationFrame(() => stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`)?.focus());
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, info: TerminalInfo, index: number) => {
    const go = (to: number) => {
      const target = terminals[(to + terminals.length) % terminals.length];
      if (!target) return;
      event.preventDefault();
      onPick(target.id);
      focusTab(target.id);
    };
    switch (event.key) {
      case 'ArrowRight':
        go(index + 1);
        break;
      case 'ArrowLeft':
        go(index - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(terminals.length - 1);
        break;
      case 'F2':
        event.preventDefault();
        onRenameStart(info.id);
        break;
      default:
    }
  };

  const active = terminals.find((x) => x.id === activeId) ?? null;

  return (
    <div className="dterm-bar">
      <div className="dterm-tabs" role="tablist" aria-label={t('dock.term.tabs')} ref={stripRef}>
        {terminals.map((info, index) => {
          const selected = info.id === activeId;
          const exited = info.state === 'exited';
          const stateText = exited
            ? info.hostLost
              ? t('dock.term.tab.hostLost')
              : info.exitCode === null
                ? t('dock.term.tab.exitedNoCode')
                : t('dock.term.tab.exited', { code: info.exitCode })
            : t('dock.term.tab.running');
          const name = tabName(info);
          return (
            <div key={info.id} className={`dterm-tab${selected ? ' is-active' : ''}`} data-state={info.state}>
              {renaming === info.id ? (
                <RenameField
                  initial={info.customName ?? ''}
                  placeholder={name}
                  label={t('dock.term.tab.renameField')}
                  onDone={(value) => onRenameDone(info.id, value)}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  id={`dterm-tab-${info.id}`}
                  data-tab-id={info.id}
                  className="dterm-tab-main"
                  aria-selected={selected}
                  aria-controls="dterm-panel"
                  tabIndex={selected ? 0 : -1}
                  title={`${t('dock.term.tab.rename')}${info.cwd !== '' ? ` · ${info.cwd}` : ''}`}
                  onClick={() => onPick(info.id)}
                  onDoubleClick={() => onRenameStart(info.id)}
                  onKeyDown={(e) => onTabKey(e, info, index)}
                >
                  <span className="dterm-dot" aria-hidden="true" />
                  <span className="dterm-tab-name">{name}</span>
                  {/* The state is words as well as a dot: colour alone is not a
                      reading for someone who cannot tell the two greens apart. */}
                  <span className="dterm-tab-state">{stateText}</span>
                </button>
              )}
              <Tip label={exited ? t('dock.term.close') : t('dock.term.closeRunning')}>
                <button
                  type="button"
                  className="dterm-tab-close"
                  aria-label={`${exited ? t('dock.term.close') : t('dock.term.closeRunning')}: ${name}`}
                  onClick={() => onClose(info)}
                >
                  <X size={11} />
                </button>
              </Tip>
            </div>
          );
        })}
        <Tip label={t('dock.term.new')}>
          <button
            type="button"
            className="dterm-add"
            aria-label={t('dock.term.new')}
            disabled={creating}
            onClick={onNew}
          >
            <Plus size={13} />
          </button>
        </Tip>
      </div>
      {active !== null && active.state === 'running' ? (
        <Tip label={t('dock.term.kill')}>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-compact"
            aria-label={t('dock.term.kill')}
            onClick={() => onKill(active)}
          >
            <Square size={12} />
          </button>
        </Tip>
      ) : null}
    </div>
  );
}

function RenameField({
  initial,
  placeholder,
  label,
  onDone,
}: {
  initial: string;
  placeholder: string;
  label: string;
  /** `null` cancels; a string (possibly empty = back to the default) commits. */
  onDone: (value: string | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const finished = useRef(false);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (next: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(next);
  };
  return (
    <input
      ref={ref}
      className="dterm-rename"
      value={value}
      placeholder={placeholder}
      aria-label={label}
      maxLength={60}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        // An IME's Enter picks a candidate; it is not a commit.
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={() => finish(value)}
    />
  );
}

/* ============================================================
   The terminal surface
   ============================================================ */

function Surface({
  workspaceId,
  info,
  focusNext,
}: {
  workspaceId: string;
  info: TerminalInfo;
  focusNext: { current: boolean };
}) {
  const t = useT();
  const slotRef = useRef<HTMLDivElement>(null);
  const id = info.id;

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (slot === null) return;
    const active = document.activeElement;
    // Focus follows the person's act; and it comes back when the area was
    // folded away with the keyboard in it (focus fell to the page).
    const focus = focusNext.current || active === null || active === document.body;
    focusNext.current = false;
    const unmount = terminalHosts.mount(workspaceId, id, slot, { focus });

    let frame = 0;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => terminalHosts.refit(workspaceId, id));
          });
    observer?.observe(slot);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      // Unmount only: the emulator and its PTY attach stay with the manager.
      unmount();
    };
  }, [workspaceId, id, focusNext]);

  return (
    <div
      className="dterm-surface"
      id="dterm-panel"
      role="tabpanel"
      aria-labelledby={`dterm-tab-${id}`}
      aria-label={t('dock.term.surface', { name: tabName(info) })}
    >
      <div className="dterm-slot" ref={slotRef} />
    </div>
  );
}

/* ============================================================
   Confirmation
   ============================================================ */

function ConfirmDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: Pending | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const kill = pending?.kind === 'kill';
  return (
    <DialogPrimitive.Root
      open={pending !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-mask" />
        <DialogPrimitive.Content className="dialog">
          <div className="dialog-head">
            <div className="grow">
              <DialogPrimitive.Title className="dialog-title">
                {kill ? t('dock.term.confirm.killTitle') : t('dock.term.confirm.closeTitle')}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="dialog-desc">
                {pending === null
                  ? ''
                  : t(kill ? 'dock.term.confirm.killBody' : 'dock.term.confirm.closeBody', { name: pending.name })}
              </DialogPrimitive.Description>
            </div>
          </div>
          <div className="dialog-foot">
            <span className="grow" />
            <button type="button" className="btn btn-outline" onClick={onCancel}>
              {t('common.cancel')}
              <kbd className="kbd" style={{ marginLeft: 4 }}>
                Esc
              </kbd>
            </button>
            <button type="button" className="btn btn-destructive" onClick={onConfirm}>
              {kill ? t('dock.term.confirm.killAction') : t('dock.term.confirm.closeAction')}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
