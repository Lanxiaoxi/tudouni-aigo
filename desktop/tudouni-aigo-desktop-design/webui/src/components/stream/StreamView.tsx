import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { EntryView } from './EntryView';
import { QuietGroup } from './QuietGroup';
import type { Entry } from '@/state/entries';

/**
 * §1·3 正文区 / §2 会话流。
 *
 * 高度总账由外层 flex 承担：这里永远是 min-height:0 的可滚区域，
 * 面板按内容设高也挤不掉状态栏与输入框（§9.1）。
 *
 * 滚动策略：贴底时自动跟随新条目；用户往上滚走之后就不抢滚动位置，
 * 改用一枚「跳到最新」按钮，避免读历史时被流式输出拽走。
 */

type Row =
  | { kind: 'entry'; key: string; entry: Entry }
  | { kind: 'quiet'; key: string; entries: Entry[] };

const QUIETABLE = new Set(['tool', 'batch', 'denied']);

function buildRows(entries: Entry[], quiet: boolean): Row[] {
  if (!quiet) {
    return entries.map((e) => ({ kind: 'entry', key: e.id, entry: e }));
  }

  const rows: Row[] = [];
  let buf: Entry[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    rows.push({ kind: 'quiet', key: `quiet-${buf[0].id}`, entries: buf });
    buf = [];
  };

  for (const e of entries) {
    if (QUIETABLE.has(e.kind)) {
      buf.push(e);
    } else {
      flush();
      rows.push({ kind: 'entry', key: e.id, entry: e });
    }
  }
  flush();
  return rows;
}

export function StreamView() {
  const t = useT();
  const entries = useApp((s) => s.entries);
  const quiet = useApp((s) => s.quiet);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  const rows = useMemo(() => buildRows(entries, quiet), [entries, quiet]);

  // 贴底时才跟随；用 scrollHeight 直接落位，不做位移动画
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinned) return;
    el.scrollTop = el.scrollHeight;
  }, [rows, pinned]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(gap < 48);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPinned(true);
  }, []);

  return (
    <div className="stream-scroll scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="stream-inner">
        {rows.map((r) =>
          r.kind === 'quiet' ? (
            <QuietGroup key={r.key} entries={r.entries} />
          ) : (
            <EntryView key={r.key} entry={r.entry} />
          ),
        )}
      </div>

      {!pinned ? (
        <button
          type="button"
          className="btn btn-secondary btn-compact jump-latest"
          onClick={jumpToLatest}
        >
          <ArrowDown size={12} />
          {t('common.jumpLatest')}
        </button>
      ) : null}
    </div>
  );
}
