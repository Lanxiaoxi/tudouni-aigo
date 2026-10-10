import { useMemo, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Search, SquareSlash, X } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { useListKeys } from '@/hooks/useListKeys';
import { filterCommands, lookup, runCommand, type CommandDef } from '@/commands';

/**
 * §5 The command palette (Ctrl+K): title, count, empty state, and a **prefix**
 * filter — not fuzzy, which is what the palette's contract says.
 *
 * An argument can be supplied in the same place: typing `/model deepseek-chat`
 * puts a "run with this argument" row at the top.
 */
type Row =
  | { type: 'arg'; cmd: CommandDef; arg: string }
  | { type: 'cmd'; cmd: CommandDef };

export function CommandPalette() {
  const t = useT();
  const [q, setQ] = useState('');

  const close = () => useApp.getState().closePanel();

  const rows = useMemo<Row[]>(() => {
    const parsed = lookup(q);
    const argRow: Row | null =
      parsed && parsed.arg !== '' && parsed.cmd.takesArg
        ? { type: 'arg', cmd: parsed.cmd, arg: parsed.arg }
        : null;

    const commands: Row[] = filterCommands(q).map((cmd) => ({ type: 'cmd', cmd }));
    return argRow ? [argRow, ...commands] : commands;
  }, [q]);

  const argRow = rows.length > 0 && rows[0].type === 'arg' ? rows[0] : null;

  const { active, setActive } = useListKeys({
    count: rows.length,
    onClose: close,
    onPick: (i) => {
      const row = rows[i];
      if (!row) return;
      if (row.type === 'arg') runCommand(row.cmd.id, row.arg);
      else runCommand(row.cmd.id);
    },
  });

  return (
    <>
      <div className="cmdk-head">
        <Search size={14} className="muted" />
        <DialogPrimitive.Title className="sr-only">
          {t('panel.commands.title')}
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="sr-only">
          {t('panel.commands.placeholder')}
        </DialogPrimitive.Description>
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          placeholder={t('panel.commands.placeholder')}
          aria-label={t('panel.commands.title')}
          spellCheck={false}
        />
        <span className="count">{rows.length}</span>
        <DialogPrimitive.Close asChild>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={t('panel.close')}>
            <X size={14} />
          </button>
        </DialogPrimitive.Close>
      </div>

      <div className="cmdk-list scroll">
        {rows.length === 0 ? (
          <div className="cmdk-empty">{t('panel.commands.empty')}</div>
        ) : (
          <>
            {argRow ? (
              <>
                <div className="cmdk-group">{t('panel.commands.argGroup')}</div>
                <CommandRow
                  cmd={argRow.cmd}
                  arg={argRow.arg}
                  index={1}
                  active={active === 0}
                  onHover={() => setActive(0)}
                  onPick={() => runCommand(argRow.cmd.id, argRow.arg)}
                />
              </>
            ) : null}

            <div className="cmdk-group">{t('panel.help.commands')}</div>

            {rows.map((row, i) => {
              if (row.type === 'arg') return null; // Already drawn above.
              return (
                <CommandRow
                  key={`${row.cmd.id}-${i}`}
                  cmd={row.cmd}
                  index={i + 1}
                  active={active === i}
                  onHover={() => setActive(i)}
                  onPick={() => runCommand(row.cmd.id)}
                />
              );
            })}
          </>
        )}
      </div>
    </>
  );
}

function CommandRow({
  cmd,
  arg,
  index,
  active,
  onHover,
  onPick,
}: {
  cmd: CommandDef;
  arg?: string;
  index: number;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const t = useT();
  const isArg = arg !== undefined && arg !== '';

  return (
    <div
      className="cmdk-item"
      data-active={active}
      role="button"
      tabIndex={0}
      onClick={onPick}
      onMouseEnter={onHover}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick();
        }
      }}
    >
      <span className="seq">{index}</span>
      <SquareSlash size={13} className="muted" />
      <span className="cmd-name">{cmd.name}</span>

      {isArg ? (
        <span className="cmd-desc mono">
          {arg}
          <span className="faint"> ← {t('panel.commands.runWith')}</span>
        </span>
      ) : (
        <span className="cmd-desc">{t(cmd.descKey)}</span>
      )}

      {!isArg && cmd.argHint ? <span className="cmd-hint">{cmd.argHint}</span> : null}
    </div>
  );
}
