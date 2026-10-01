import { X } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Badge, RiskTag } from '@/components/ui/kit';
import { formatDuration, formatPercent, formatTokens } from '@/utils/format';
import type { Entry } from '@/state/entries';
import type {
  ContextLedger,
  StatusGroup,
  ToolRow,
  UiCompactedMsg,
  UiContextMsg,
  UiFileReadMsg,
  UiStatusMsg,
  UiToolsMsg,
} from '@/protocol/types';
import { projectCompaction, projectTools } from '@/runtime/adapt';

/**
 * §5 large-text output: /status /tools /context /compact.
 *
 * The point is that these appear **as an in-stream block**, not as a modal or an
 * overlay: the conversation stays visible behind them. Closing one removes that
 * row from the stream and touches nothing else.
 *
 * Every value here is read straight off the message. Where a number is absent,
 * the row says "unknown" — it does not compute a substitute.
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
          : entry.block === 'file'
            ? t('panel.files.title')
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
        {entry.block === 'status' ? <StatusBlock p={entry.payload as UiStatusMsg} /> : null}
        {entry.block === 'tools' ? <ToolsBlock p={entry.payload as UiToolsMsg} /> : null}
        {entry.block === 'context' ? <ContextBlock p={entry.payload as UiContextMsg} /> : null}
        {entry.block === 'compact' ? <CompactBlock p={entry.payload as UiCompactedMsg} /> : null}
        {entry.block === 'file' ? <FileBlock p={entry.payload as UiFileReadMsg} /> : null}
      </div>
    </section>
  );
}

/**
 * One file opened from the workspace browser.
 *
 * Two facts are stated rather than implied, and both are the difference between
 * a viewer and a liar:
 *
 *   - **the head is not the whole file.** `content` is the runtime's preview
 *     (`runtime.FileReadPreviewChars`); when `truncated` is set, the row says so
 *     *and* names the artifact holding the rest. Presenting 200 KB of a 2 MB file
 *     as the file is the one silent failure this layer can produce.
 *   - **the line count is the file's, not the preview's.** `total_lines` counts
 *     the whole body, so it stays useful even when the text below is cut.
 *
 * The text is drawn as plain monospace, not through the markdown renderer: this
 * is a file, and reformatting a `.go` file through the answer pipeline would
 * reflow code somebody is trying to read.
 */
function FileBlock({ p }: { p: UiFileReadMsg }) {
  const t = useT();
  const content = typeof p.content === 'string' ? p.content : '';
  const path = typeof p.path === 'string' ? p.path : '';

  return (
    <>
      <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'baseline' }}>
        <span className="mono strong">{path === '' ? t('panel.files.root') : path}</span>
        <span className="caption faint">
          {t('panel.files.lines', { n: p.total_lines ?? 0 })}
        </span>
        {/* Bytes and characters are two numbers on purpose: a UTF-8 file of CJK
            text is three times the bytes of its characters, and "how long is
            this" asks the first while "how big is this" asks the second. */}
        <span className="caption faint mono">{p.bytes ?? 0} B</span>
      </div>

      {p.truncated ? (
        <div className="caption" style={{ color: 'var(--warning)' }}>
          {t('panel.files.truncated', { chars: p.chars ?? 0, id: p.artifact_id ?? '' })}
        </div>
      ) : null}

      <pre className="file-view mono">{content}</pre>
    </>
  );
}

/** `/status` is grouped — the screen spans four layers, and flattening it would
 *  eventually collide field names. Each group is rendered as its own table. */
function StatusBlock({ p }: { p: UiStatusMsg }) {
  const t = useT();
  const groups = p.status as StatusGroup | undefined;

  if (!groups) {
    return <div className="caption faint">{t('common.unknown')}</div>;
  }

  return (
    <>
      <GroupTable title="session" rows={flatten(groups.session)} />
      <GroupTable title="model" rows={flatten(groups.model)} />
      <GroupTable title="counters" rows={flatten(groups.counters)} />
      <GroupTable title="usage" rows={flatten(groups.usage)} />
      <GroupTable title="meta" rows={flatten(groups.meta)} />

      <dl className="kv">
        <dt>{t('inblock.tokens')}</dt>
        <dd className="mono">
          {p.last_prompt_tokens === null ? t('common.unknown') : formatTokens(p.last_prompt_tokens)}
        </dd>
        <dt>{t('inblock.window')}</dt>
        {/* Null means the catalogue does not name a window: report the amount,
            never a percentage. */}
        <dd className="mono">
          {p.context_tokens === null ? t('common.unknown') : formatTokens(p.context_tokens)}
        </dd>
      </dl>

      {groups.context === null ? (
        <div className="caption faint">{t('inblock.noContextLayer')}</div>
      ) : (
        <GroupTable title="context" rows={flatten(groups.context)} />
      )}
    </>
  );
}

function flatten(value: unknown, prefix = ''): Array<[string, string]> {
  if (value === null || value === undefined) return [[prefix || '—', '—']];
  if (typeof value !== 'object') return [[prefix || '—', String(value)]];
  const out: Array<[string, string]> = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const name = prefix === '' ? key : `${prefix}.${key}`;
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      out.push(...flatten(item, name));
      continue;
    }
    if (Array.isArray(item)) {
      out.push([name, item.length === 0 ? '[]' : item.map((x) => String(x)).join(', ')]);
      continue;
    }
    out.push([name, item === null || item === undefined ? '—' : String(item)]);
  }
  return out;
}

function GroupTable({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  if (rows.length === 0) return null;
  return (
    <>
      <div className="etb-label">{title}</div>
      <table className="table">
        <tbody>
          {rows.map(([key, value]) => (
            <tr key={key}>
              <td className="mono faint" style={{ width: 220 }}>
                {key}
              </td>
              <td className="mono">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** `/tools`: the runtime decides each row's `disposition`; this view does not
 *  know that "low is auto" by default. */
function ToolsBlock({ p }: { p: UiToolsMsg }) {
  const t = useT();
  const rows: ToolRow[] = p.tools ?? [];

  if (rows.length === 0) {
    return <div className="caption faint">{t('common.none')}</div>;
  }

  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>{t('perm.tool')}</th>
            <th>{t('perm.origin')}</th>
            <th>{t('perm.risk')}</th>
            <th>{t('inblock.status')}</th>
            <th>{t('inblock.note')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td className="mono">{row.name}</td>
              <td>
                <Badge tone="neutral" dot={false}>
                  {row.external ? t('entry.external') : t('entry.builtin')}
                </Badge>
              </td>
              <td>
                <RiskTag level={row.risk} />
              </td>
              <td>
                <Badge tone={row.disposition === 'auto' ? 'success' : row.disposition === 'deny' ? 'destructive' : 'warning'} dot={false}>
                  {row.disposition === 'auto'
                    ? t('inblock.auto')
                    : row.disposition === 'deny'
                      ? t('inblock.denied')
                      : t('inblock.ask')}
                </Badge>
              </td>
              <td className="caption muted">
                {row.granted ? t('inblock.remembered') : t('inblock.notRemembered')}
                {row.command ? <span className="mono"> · {row.command}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {p.granted_prefixes?.length > 0 ? (
        <>
          <div className="etb-label">{t('inblock.remembered')}</div>
          <div className="terminal mono">{p.granted_prefixes.join('\n')}</div>
        </>
      ) : null}
    </>
  );
}

/** `/context`: three numbers travel together — used, limit, and the compaction
 *  line. Reported alone, a token count is neither big nor small. */
function ContextBlock({ p }: { p: UiContextMsg }) {
  const t = useT();
  // Everything the message carries is inside the "context feature" container:
  // the ledger is `context.context`, and `window` / `messages` / `folded` sit
  // beside it on the same container. Verified against real runtime bytes — see
  // `tests/fixtures/opening.jsonl`.
  //
  // An absent inner object says "there is no context management here", which is
  // a different and true statement from a row of zeroes.
  const feature = p.context;
  const ledger: ContextLedger | undefined = feature?.context;

  if (!ledger) {
    return <div className="caption faint">{t('inblock.noContext')}</div>;
  }

  const used = ledger.estimated_tokens ?? null;
  const window = feature?.window ?? null;

  return (
    <>
      <GroupTable title="ledger" rows={flatten(ledger)} />

      <dl className="kv">
        <dt>{t('inblock.used')}</dt>
        <dd className="mono">{used === null ? t('common.unknown') : formatTokens(used)}</dd>
        <dt>{t('inblock.window')}</dt>
        <dd className="mono">
          {window === null ? t('common.unknown') : formatTokens(window)}
          {window === null || used === null ? '' : ` · ${formatPercent(used / window)}`}
        </dd>
        {feature?.messages !== undefined ? (
          <>
            <dt>messages</dt>
            <dd className="mono">{feature.messages}</dd>
          </>
        ) : null}
        {feature?.folded !== undefined ? (
          <>
            <dt>{t('inblock.folded')}</dt>
            <dd className="mono">{feature.folded}</dd>
          </>
        ) : null}
      </dl>
    </>
  );
}

/** `/compact`. There is no `saved` field — subtracting one here would be
 *  deriving a number the runtime did not send, so before/after are shown. */
function CompactBlock({ p }: { p: UiCompactedMsg }) {
  const t = useT();
  const c = projectCompaction(p.compaction);

  if (!c) {
    return <div className="caption faint">{t('common.unknown')}</div>;
  }

  return (
    <>
      <dl className="kv">
        <dt>{t('inblock.status')}</dt>
        <dd className="mono">{c.status}</dd>
        <dt>{t('inblock.before')}</dt>
        <dd className="mono">{c.before === null ? '—' : formatTokens(c.before)}</dd>
        <dt>{t('inblock.after')}</dt>
        <dd className="mono">{c.after === null ? '—' : formatTokens(c.after)}</dd>
        <dt>{t('inblock.folded')}</dt>
        <dd className="mono">{c.folded}</dd>
        <dt>{t('inblock.totalFolded')}</dt>
        <dd className="mono">{c.totalFolded}</dd>
        <dt>{t('inblock.summaryChars')}</dt>
        <dd className="mono">{formatTokens(c.summaryChars)}</dd>
        <dt>{t('inblock.duration')}</dt>
        <dd className="mono">{formatDuration(c.durationMs)}</dd>
      </dl>

      {p.context?.context ? (
        <ContextBlock p={{ ...p.context, v: p.v, t: 'ui', kind: 'context' } as UiContextMsg} />
      ) : null}
    </>
  );
}

/** Kept for the tools projection's own test surface. */
export const projectToolsForBlock = projectTools;
