import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Badge, RiskTag } from '@/components/ui/kit';
import { ToolBody } from './EntryView';
import type { Entry } from '@/state/entries';
import { formatDuration } from '@/utils/format';

/**
 * Quiet mode's second shape (§2).
 *
 * With quiet on, tool calls and results compress into a one-line brief per call
 * instead of the full detail: the group folds as a whole, and each line expands
 * on its own. Both forms exist, which is why this has group-level folding *and*
 * row-level expansion.
 *
 * A denial keeps its own colouring under quiet too — "did not run" and "ran and
 * failed" must never be merged, in either mode.
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
          {entries.map((entry) => (
            <QuietLine
              key={entry.id}
              entry={entry}
              expanded={toolOpen[entry.id] === true}
              onToggle={() => toggleTool(entry.id)}
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
          {t('entry.batch', { count: entry.calls, ms: entry.wallMs })}
        </span>
      </div>
    );
  }

  if (entry.kind === 'denied') {
    return (
      <div
        className="quiet-line"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <Badge tone="warning" dot={false}>
          {t('entry.toolResultDenied')}
        </Badge>
        <span className="mono">{entry.tool}</span>
        <span className="ql-tail">{t('entry.denied')}</span>
      </div>
    );
  }

  // Quiet only swallows tool / batch / denied; anything else keeps its shape.
  if (entry.kind !== 'tool') return null;

  const result = entry.result;
  const tone =
    result?.status === 'ok' ? 'success' : result?.status === 'error' ? 'destructive' : 'neutral';

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
        {entry.risk === 'medium' || entry.risk === 'high' ? (
          <RiskTag level={entry.risk} />
        ) : null}
        <span className="ql-tail">
          {result ? (
            <>
              <Badge tone={tone} dot={false}>
                {result.status === 'ok'
                  ? t('entry.toolResultOk')
                  : result.status === 'error'
                    ? t('entry.toolResultError')
                    : result.status === 'invalid_args'
                      ? t('entry.toolResultInvalid')
                      : result.status === 'interrupted'
                        ? t('entry.toolResultInterrupted')
                        : t('entry.toolResultDenied')}
              </Badge>{' '}
              {formatDuration(result.durationMs)}
              {result.exitCode !== null ? ` · ${t('entry.toolExit', { n: result.exitCode })}` : ''}
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
