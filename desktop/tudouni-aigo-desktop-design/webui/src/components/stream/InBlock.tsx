import { X } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Badge, RiskTag } from '@/components/ui/kit';
import { formatPercent, formatTokens } from '@/utils/format';
import type { Entry } from '@/state/entries';
import type {
  UiCompactedPayload,
  UiContextPayload,
  UiStatusPayload,
  UiToolsPayload,
} from '@/protocol/types';

/**
 * §5 大屏文本：/status /tools /context /compact 的输出。
 *
 * 关键：作为**流内块**出现，不遮挡会话流 —— 所以它不是模态也不是浮层，
 * 就是流里的一个条目。关掉它只从流里移除这一条，不影响任何数据。
 */
export function InBlock({ entry }: { entry: Extract<Entry, { kind: 'block' }> }) {
  const t = useT();
  const removeBlock = useApp((s) => s.removeBlock);

  const title =
    entry.block === 'status'
      ? t('inblock.status.title')
      : entry.block === 'tools'
        ? t('inblock.tools.title')
        : entry.block === 'context'
          ? t('inblock.context.title')
          : t('inblock.compact.title');

  return (
    <section className="inblock">
      <header className="inblock-head">
        <span className="ibh-title">{title}</span>
        <span className="mono faint">/{entry.block}</span>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-compact ibh-close"
          onClick={() => removeBlock(entry.id)}
          aria-label={t('panel.close')}
        >
          <X size={13} />
        </button>
      </header>

      <div className="inblock-body">
        {entry.block === 'status' ? <StatusBlock p={entry.payload as UiStatusPayload} /> : null}
        {entry.block === 'tools' ? <ToolsBlock p={entry.payload as UiToolsPayload} /> : null}
        {entry.block === 'context' ? <ContextBlock p={entry.payload as UiContextPayload} /> : null}
        {entry.block === 'compact' ? (
          <CompactBlock p={entry.payload as UiCompactedPayload} />
        ) : null}
      </div>
    </section>
  );
}

function StatusBlock({ p }: { p: UiStatusPayload }) {
  const t = useT();
  return (
    <dl className="kv">
      <dt>phase</dt>
      <dd className="mono">{p.phase}</dd>
      <dt>action</dt>
      <dd className="mono">{p.action ?? '—'}</dd>
      <dt>last result</dt>
      <dd className="mono">{p.last_result ?? '—'}</dd>
      <dt>step</dt>
      <dd className="mono">
        {p.step} / {p.max_steps}
        <span className="faint"> ({t('status.step', { n: p.step, max: p.max_steps })})</span>
      </dd>
    </dl>
  );
}

function ToolsBlock({ p }: { p: UiToolsPayload }) {
  const t = useT();
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{t('perm.tool')}</th>
          <th>{t('perm.origin')}</th>
          <th>{t('perm.risk')}</th>
          <th>{t('inblock.note')}</th>
        </tr>
      </thead>
      <tbody>
        {p.rows.map((r) => (
          <tr key={`${r.name}-${r.builtin}`}>
            <td className="mono">{r.name}</td>
            <td>
              <Badge tone="neutral" dot={false}>
                {r.builtin ? t('entry.builtin') : t('entry.external')}
              </Badge>
            </td>
            <td>
              <RiskTag level={r.risk} />
            </td>
            <td>
              <span className="muted">{r.description}</span>{' '}
              <span className="faint">
                · {r.remembered ? t('inblock.remembered') : t('inblock.notRemembered')}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ContextBlock({ p }: { p: UiContextPayload }) {
  const t = useT();
  const total = p.sections.reduce((a, b) => a + b.tokens, 0);
  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>{t('inblock.section')}</th>
            <th className="num">{t('inblock.tokens')}</th>
            <th className="num">%</th>
            <th>{t('inblock.note')}</th>
          </tr>
        </thead>
        <tbody>
          {p.sections.map((s) => (
            <tr key={s.name}>
              <td className="mono">{s.name}</td>
              <td className="num">{formatTokens(s.tokens)}</td>
              <td className="num">
                {total === 0 ? '—' : formatPercent(s.tokens / total, 1)}
              </td>
              <td className="muted">{s.note}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="kv">
        <dt>{t('inblock.used')}</dt>
        <dd className="mono">{formatTokens(p.used)}</dd>
        <dt>{t('inblock.window')}</dt>
        {/* 窗口未知时只报用量，不报百分比（§4） */}
        <dd className="mono">
          {p.window === null ? t('common.unknown') : formatTokens(p.window)}
          {p.window === null ? '' : ` · ${formatPercent(p.used / p.window)}`}
        </dd>
      </dl>
    </>
  );
}

function CompactBlock({ p }: { p: UiCompactedPayload }) {
  const t = useT();
  return (
    <>
      <dl className="kv">
        <dt>{t('inblock.before')}</dt>
        <dd className="mono">{formatTokens(p.before)}</dd>
        <dt>{t('inblock.after')}</dt>
        <dd className="mono">{formatTokens(p.after)}</dd>
        <dt>{t('inblock.saved')}</dt>
        <dd className="mono">{formatTokens(p.saved)}</dd>
      </dl>
      <div>
        <div className="etb-label caption muted">{t('inblock.note')}</div>
        <p style={{ marginTop: 4 }}>{p.summary}</p>
        <p className="caption" style={{ marginTop: 4 }}>
          {p.note}
        </p>
      </div>
    </>
  );
}
