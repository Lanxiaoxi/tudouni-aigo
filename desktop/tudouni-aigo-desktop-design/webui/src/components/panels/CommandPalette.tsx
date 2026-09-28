import { useMemo, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Search, SquareSlash, X } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { useListKeys } from '@/hooks/useListKeys';
import { filterCommands, lookup, runCommand, type CommandDef } from '@/commands';

/**
 * §5 命令面板（Ctrl+K）：标识 + 条数 + 空状态，前缀过滤（非模糊）。
 * 带参命令在同一处补参数：输入 `/model deepseek-reasoner` 时，
 * 列表顶部会出现一条「直接用这个参数执行」。
 */
type Row =
  | { type: 'arg'; cmd: CommandDef; arg: string }
  | { type: 'cmd'; cmd: CommandDef };

export function CommandPalette() {
  const t = useT();
  const [q, setQ] = useState('');

  const close = () => useApp.setState({ panel: null });

  const rows = useMemo<Row[]>(() => {
    const parsed = lookup(q);
    const argRow: Row | null =
      parsed && parsed.arg !== '' && parsed.cmd.takesArg
        ? { type: 'arg', cmd: parsed.cmd, arg: parsed.arg }
        : null;

    const cmds: Row[] = filterCommands(q).map((c) => ({ type: 'cmd', cmd: c }));
    return argRow ? [argRow, ...cmds] : cmds;
  }, [q]);

  const argRow = rows[0]?.type === 'arg' ? rows[0] : null;

  const { active, setActive } = useListKeys({
    count: rows.length,
    onClose: close,
    onPick: (i) => {
      const r = rows[i];
      if (!r) return;
      if (r.type === 'arg') runCommand(r.cmd.id, r.arg);
      else runCommand(r.cmd.id);
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
                  row={argRow}
                  index={1}
                  active={active === 0}
                  onHover={() => setActive(0)}
                  onPick={() => runCommand(argRow.cmd.id, argRow.arg)}
                />
              </>
            ) : null}

            <div className="cmdk-group">{t('panel.help.commands')}</div>

            {rows.map((r, i) => {
              if (r.type === 'arg') return null; // 已在上面单独渲染
              return (
                <CommandRow
                  key={`${r.cmd.id}-${i}`}
                  row={r}
                  index={i + 1}
                  active={active === i}
                  onHover={() => setActive(i)}
                  onPick={() => runCommand(r.cmd.id)}
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
  row,
  index,
  active,
  onHover,
  onPick,
}: {
  row: Row;
  index: number;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const t = useT();
  const isArg = row.type === 'arg';

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
      <span className="cmd-name">{row.cmd.name}</span>

      {isArg ? (
        <span className="cmd-desc mono">
          {row.arg}
          <span className="faint"> ← 直接用这个参数执行</span>
        </span>
      ) : (
        <span className="cmd-desc">{t(row.cmd.descKey)}</span>
      )}

      {!isArg && row.cmd.argHint ? (
        <span className="cmd-hint">{row.cmd.argHint}</span>
      ) : null}
    </div>
  );
}
