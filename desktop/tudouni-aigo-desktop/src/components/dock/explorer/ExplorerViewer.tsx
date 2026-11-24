import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FileQuestion, FileText, RefreshCw } from 'lucide-react';
import { useT } from '@/i18n/useT';
import { EmptyState, Tip } from '@/components/ui/kit';
import { Markdown } from '@/components/ui/Markdown';
import { formatBytes } from '@/utils/format';
import { useWorkspaceUi } from '@/state/workspaceDock/selectors';
import { shouldReloadPreview } from '@/state/workspaceDock/dataCache';
import {
  IMAGE_MAX_BYTES,
  PREVIEW_CHUNK,
  appendRead,
  countShownLines,
  isTruncated,
  languageOfPath,
  lineSummary,
  nextLimit,
  previewFromRead,
  previewKindOf,
  type PreviewState,
} from '@/state/workspaceDock/previewModel';
import type { HostEntry } from '@/workspaceHost';
import type { DockModuleProps } from '../modules';
import { useHostClient, useWorkspaceCache } from '../data';
import { isBool, usePersistedPref } from '../dockPrefs';
import { HIGHLIGHT_MAX_CHARS, highlightToReact } from './highlight';

/** The most a reload re-reads: the spec's per-call ceiling. */
const RELOAD_MAX = 1_048_576;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ImageView {
  url: string;
  size: number;
  mime: string;
}

/**
 * The Explorer's right half: a read-only preview of the selected file
 * (docs/design/workspace-dock.md 5.3).
 *
 * Text is read in ranges (`fs_read`, first 256KB, "load more" continues at
 * `next_offset`), never whole; a picture comes through `fs_read_bytes` and a blob
 * URL, so it works for a remote workspace, which has no local path to point an
 * `<img>` at. When the file changes on disk the content is replaced **in place**
 * (the old text stays up until the new arrives), which is what keeps the scroll
 * position.
 */
export function ExplorerViewer({ workspace }: DockModuleProps) {
  const t = useT();
  const id = workspace.workspaceId;
  const path = useWorkspaceUi(id).selectedFile;
  const client = useHostClient(id);
  const cache = useWorkspaceCache(id);

  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [image, setImage] = useState<ImageView | null>(null);
  const [info, setInfo] = useState<HostEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [rendered, setRendered] = usePersistedPref('explorer.mdRendered', true, isBool);
  const [highlighted, setHighlighted] = useState<{ key: string; nodes: ReactNode[] } | null>(null);

  const token = useRef(0);
  const imageUrl = useRef<string | null>(null);
  const pathRef = useRef<string | null>(path);
  const readRef = useRef(0);
  pathRef.current = path;
  readRef.current = preview?.bytesRead ?? 0;

  const swapImage = useCallback((next: ImageView | null) => {
    if (imageUrl.current !== null) URL.revokeObjectURL(imageUrl.current);
    imageUrl.current = next?.url ?? null;
    setImage(next);
  }, []);

  useEffect(
    () => () => {
      if (imageUrl.current !== null) URL.revokeObjectURL(imageUrl.current);
      imageUrl.current = null;
    },
    [],
  );

  const loadImage = useCallback(
    async (file: string, my: number) => {
      if (!client) return;
      const r = await client.fsReadBytes(file, { max: IMAGE_MAX_BYTES });
      if (my !== token.current) return;
      const url = URL.createObjectURL(new Blob([r.data as BlobPart], { type: r.mime || 'image/png' }));
      swapImage({ url, size: r.size, mime: r.mime });
      setPreview(null);
      setInfo(null);
      setError(null);
    },
    [client, swapImage],
  );

  const load = useCallback(
    async (file: string, limit: number = PREVIEW_CHUNK) => {
      if (!client) return;
      const my = ++token.current;
      setLoading(true);
      try {
        if (previewKindOf(file, '') === 'image') {
          await loadImage(file, my);
          return;
        }
        const data = await client.fsRead(file, { offset: 0, limit });
        if (my !== token.current) return;
        if (data.status === 'ok') {
          setPreview(previewFromRead(data));
          swapImage(null);
          setInfo(null);
          setError(null);
          return;
        }
        // A picture the name did not give away.
        if (data.mime.startsWith('image/') && data.mime !== 'image/svg+xml') {
          await loadImage(file, my);
          return;
        }
        // Binary / not UTF-8 is a state, not an error: say what the file is.
        let entry: HostEntry | null = null;
        try {
          entry = await client.fsStat(file);
        } catch {
          entry = null;
        }
        if (my !== token.current) return;
        setPreview(previewFromRead(data));
        swapImage(null);
        setInfo(entry);
        setError(null);
      } catch (err) {
        if (my !== token.current) return;
        setPreview(null);
        swapImage(null);
        setInfo(null);
        setError(messageOf(err));
      } finally {
        if (my === token.current) setLoading(false);
      }
    },
    [client, loadImage, swapImage],
  );

  // A different file starts from nothing; the same file is only reloaded.
  useEffect(() => {
    token.current += 1;
    setPreview(null);
    swapImage(null);
    setInfo(null);
    setError(null);
    setHighlighted(null);
    setMore(false);
    if (path === null) {
      setLoading(false);
      return;
    }
    void load(path);
  }, [path, load, swapImage]);

  // The file changed on disk: re-read what was showing, in place.
  useEffect(() => {
    if (cache === null) return;
    return cache.onInvalidate((notice) => {
      const current = pathRef.current;
      if (current === null || !shouldReloadPreview(notice, current)) return;
      void load(current, Math.min(RELOAD_MAX, Math.max(PREVIEW_CHUNK, readRef.current)));
    });
  }, [cache, load]);

  const loadMore = useCallback(async () => {
    if (!client || path === null || preview === null || preview.nextOffset === null) return;
    const my = ++token.current;
    setMore(true);
    try {
      const data = await client.fsRead(path, { offset: preview.nextOffset, limit: nextLimit(preview) });
      if (my !== token.current) return;
      const merged = appendRead(preview, data);
      if (merged === null) {
        // The file changed between the two reads: gluing them would show a
        // text that never existed, so start over.
        void load(path);
        return;
      }
      setPreview(merged);
    } catch (err) {
      if (my === token.current) setError(messageOf(err));
    } finally {
      if (my === token.current) setMore(false);
    }
  }, [client, path, preview, load]);

  /* ---------------- highlighting ---------------- */
  const kind = path === null ? 'text' : previewKindOf(path, preview?.mime ?? '');
  const language = path === null ? null : (kind === 'markdown' ? 'markdown' : languageOfPath(path));
  const content = preview?.status === 'ok' ? preview.content : '';
  const showRendered = kind === 'markdown' && rendered;
  const highlightKey = `${language ?? ''}\0${content.length}\0${content.slice(-64)}`;

  useEffect(() => {
    if (language === null || showRendered || content === '' || content.length > HIGHLIGHT_MAX_CHARS) {
      setHighlighted(null);
      return;
    }
    let live = true;
    void highlightToReact(content, language).then((nodes) => {
      if (live && nodes !== null) setHighlighted({ key: highlightKey, nodes });
    });
    return () => {
      live = false;
    };
  }, [content, language, showRendered, highlightKey]);

  const lineNumbers = useMemo(() => {
    const n = countShownLines(content);
    let out = '1';
    for (let i = 2; i <= n; i += 1) out += `\n${i}`;
    return out;
  }, [content]);

  /* ---------------- drawing ---------------- */
  if (path === null) {
    return (
      <div className="dock-placeholder">
        <EmptyState icon={<FileText size={18} />} title={t('dock.placeholder.viewer.explorer')} />
      </div>
    );
  }

  const name = path.slice(path.lastIndexOf('/') + 1);
  const header = (extra?: ReactNode) => (
    <div className="dock-view-head">
      <span className="dock-view-title" title={path}>
        {name}
        <span className="dock-view-path">{path}</span>
      </span>
      <span className="dock-view-actions">
        {extra}
        <Tip label={t('dock.explorer.view.reload')}>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-compact"
            aria-label={t('dock.explorer.view.reload')}
            onClick={() => void load(path, Math.min(RELOAD_MAX, Math.max(PREVIEW_CHUNK, readRef.current)))}
          >
            <RefreshCw size={13} />
          </button>
        </Tip>
      </span>
    </div>
  );

  if (error !== null && preview === null && image === null) {
    return (
      <div className="dock-view">
        {header()}
        <div className="dock-view-body">
          <EmptyState
            icon={<FileQuestion size={18} />}
            title={t('dock.explorer.view.failed')}
            hint={error}
          />
        </div>
      </div>
    );
  }

  if (image !== null) {
    return (
      <div className="dock-view">
        {header()}
        <div className="dock-view-meta">
          {image.mime} · {formatBytes(image.size)}
        </div>
        <div className="dock-view-body dock-image">
          <img src={image.url} alt={t('dock.explorer.view.imageAlt', { name })} decoding="async" />
        </div>
      </div>
    );
  }

  if (preview === null) {
    return (
      <div className="dock-view">
        {header()}
        <div className="dock-view-body">
          <div className="dock-view-note" aria-live="polite">
            {loading ? t('dock.explorer.view.loading') : null}
          </div>
        </div>
      </div>
    );
  }

  if (preview.status !== 'ok') {
    const rows: Array<[string, string]> = [
      [t('dock.explorer.view.size'), formatBytes(info?.size ?? preview.size)],
      [t('dock.explorer.view.type'), preview.mime || '—'],
    ];
    if (info !== null && info.mtime_ms > 0) {
      rows.push([t('dock.explorer.view.modified'), new Date(info.mtime_ms).toLocaleString()]);
    }
    return (
      <div className="dock-view">
        {header()}
        <div className="dock-view-body">
          <EmptyState
            icon={<FileQuestion size={18} />}
            title={t('dock.explorer.view.noText')}
            hint={preview.status === 'binary' ? t('dock.explorer.view.binary') : t('dock.explorer.view.nonUtf8')}
          />
          <dl className="dock-fileinfo">
            {rows.map(([k, v]) => (
              <div key={k} className="dock-fileinfo-row">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    );
  }

  const lines = lineSummary(preview);
  const truncated = isTruncated(preview);
  const toggle =
    kind === 'markdown' ? (
      <span className="dock-seg" role="group" aria-label={t('dock.explorer.view.mdMode')}>
        <button
          type="button"
          className={`dock-seg-btn${rendered ? ' is-active' : ''}`}
          aria-pressed={rendered}
          onClick={() => setRendered(true)}
        >
          {t('dock.explorer.view.rendered')}
        </button>
        <button
          type="button"
          className={`dock-seg-btn${rendered ? '' : ' is-active'}`}
          aria-pressed={!rendered}
          onClick={() => setRendered(false)}
        >
          {t('dock.explorer.view.source')}
        </button>
      </span>
    ) : null;

  return (
    <div className="dock-view">
      {header(toggle)}
      <div className="dock-view-meta">
        {formatBytes(preview.size)}
        {' · '}
        {content === ''
          ? t('dock.explorer.view.empty')
          : lines.total !== null
            ? t('dock.explorer.view.lines', { n: lines.total })
            : lines.atLeast
              ? t('dock.explorer.view.linesFirst', { n: lines.shown })
              : t('dock.explorer.view.lines', { n: lines.shown })}
        {preview.encoding !== '' ? ` · ${preview.encoding}` : ''}
      </div>
      {error !== null ? (
        <div className="dock-view-banner is-error" role="alert">
          {t('dock.explorer.view.failed')}: {error}
        </div>
      ) : null}
      <div className="dock-view-body" data-scroll-keep="">
        {content === '' ? (
          <div className="dock-view-note">{t('dock.explorer.view.empty')}</div>
        ) : showRendered ? (
          <div className="dock-markdown">
            <Markdown text={content} />
          </div>
        ) : (
          <div className="dock-code">
            <pre className="dock-code-gutter" aria-hidden="true">
              {lineNumbers}
            </pre>
            <pre className="dock-code-body" tabIndex={0} aria-label={t('dock.explorer.view.codeLabel', { name })}>
              <code className="hljs">
                {highlighted !== null && highlighted.key === highlightKey ? highlighted.nodes : content}
              </code>
            </pre>
          </div>
        )}
        {truncated ? (
          <div className="dock-view-banner" role="status">
            <span>
              {t('dock.explorer.view.truncated', {
                read: formatBytes(preview.bytesRead),
                size: formatBytes(preview.size),
              })}
            </span>
            <button type="button" className="btn btn-compact" disabled={more} onClick={() => void loadMore()}>
              {more ? t('dock.explorer.view.loading') : t('dock.explorer.view.more')}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
