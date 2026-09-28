import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Badge, RiskTag } from '@/components/ui/kit';
import { ToolBody } from './EntryView';
import type { Entry } from '@/state/entries';
import { formatDuration } from '@/utils/format';

/**
 * 安静模式的第二种表现形式（§2）。
 *
 * quiet 打开后，工具调用与结果压成「一行一次调用」的简报，不展示逐条明细：
 *  - 外层 rollup 行：整批折叠成一行
 *  - 内层 quiet-line：一次调用一行，点开才看明细
 * 两种形态都要有，所以这里既有组级折叠也有行级展开。
 * 拒绝行在 quiet 下仍然单独着色 —— 「没跑」和「跑失败了」永远不能混。
 */
export function QuietGroup({ entries }: { entries: Entry[] }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const toggleTool = useApp((s) => s.toggleTool);
  const toolOpen = useApp((s) => s.toolOpen);

  return (
    <div className="entry">
      <button
        type="button"
        className="quiet-rollup"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronRight size={12} className={`caret${open ? ' caret-open' : ''}`} />
        {t('entry.quietRollup', { n: entries.length })}
        <span className="faint">· {open ? t('block.collapse') : t('entry.quietHint')}</span>
      </button>

      {open ? (
        <div className="col" style={{ gap: 2, paddingLeft: 'var(--space-2)' }}>
          {entries.map((e) => (
            <QuietLine
              key={e.id}
              entry={e}
              expanded={toolOpen[e.id] === true}
              onToggle={() => toggleTool(e.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function QuietLine({
  entry,
  expanded,
  onToggle,
}: {
  entry: Entry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useT();

  if (entry.kind === 'batch') {
    return (
      <div className="quiet-line is-static">
        <span className="ql-tail" style={{ marginLeft: 0 }}>
          {t('entry.batch', { count: entry.count, ms: entry.wallMs })}
        </span>
      </div>
    );
  }

  if (entry.kind === 'denied') {
    return (
      <div className="quiet-line" onClick={onToggle} role="button" tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' ? onToggle() : undefined)}>
        <Badge tone="warning" dot={false}>
          {t('entry.toolResultDenied')}
        </Badge>
        <span className="mono">{entry.tool}</span>
        <span className="ql-tail">
          {entry.reason || t('entry.deniedNoReason')}
        </span>
      </div>
    );
  }

  // quiet 只吞 tool / batch / denied 三类，这里兜住类型
  if (entry.kind !== 'tool') return null;

  const r = entry.result;
  const tone = r?.status === 'ok' ? 'success' : r?.status === 'error' ? 'destructive' : 'neutral';

  return (
    <>
      <div
        className="quiet-line"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <ChevronRight size={11} className={`caret${expanded ? ' caret-open' : ''}`} />
        <span className="seq">{entry.index}</span>
        <span className="mono">{entry.tool}</span>
        {entry.risk === 'MEDIUM' || entry.risk === 'HIGH' ? <RiskTag level={entry.risk} /> : null}
        <span className="ql-tail">
          {r ? (
            <>
              <Badge tone={tone} dot={false}>
                {r.status === 'ok'
                  ? t('entry.toolResultOk')
                  : r.status === 'error'
                    ? t('entry.toolResultError')
                    : t('entry.toolResultDenied')}
              </Badge>{' '}
              {formatDuration(r.durationMs)}
              {r.exitCode !== null ? ` · ${t('entry.toolExit', { n: r.exitCode })}` : ''}
            </>
          ) : (
            <span className="faint">{t('entry.modelNoMetrics')}</span>
          )}
        </span>
      </div>

      {expanded ? (
        <div className="e-tool" style={{ marginLeft: 'var(--space-3)' }}>
          <ToolBody entry={entry} />
        </div>
      ) : null}
    </>
  );
}
