import { useMemo } from 'react';
import { Clock, Sparkles, Terminal } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Kbd } from '@/components/ui/kit';
import { formatPath, formatRelative } from '@/utils/format';

/**
 * §7 首屏。三块（不是三个页面）：
 *   1. 标识块：Logo、问候（含用户名）、版本、当前模型 + 工作区、一句从哪儿开始
 *   2. 最近会话块：按最后修改时间倒序，最多 4 条，空槽占位
 *   3. 快捷键块：键位卡
 *
 * 内容优先级（窗口变矮时从下往上丢）：
 *   快捷键卡 → 各块的空余行 → 只留标识块头几行。
 *   下方若还有运行时通知，它属于会话内容，由 App 决定不再走首屏。
 */

const MAX_RECENT = 4;

export function Welcome() {
  const t = useT();
  const userName = useApp((s) => s.userName);
  const version = useApp((s) => s.version);
  const workspace = useApp((s) => s.workspace);
  const session = useApp((s) => s.session);
  const sessionList = useApp((s) => s.sessionList);
  const switchSession = useApp((s) => s.switchSession);
  const openPanel = useApp((s) => s.openPanel);

  const recent = useMemo(
    () => [...sessionList].sort((a, b) => b.modified_at - a.modified_at).slice(0, MAX_RECENT),
    [sessionList],
  );

  const slots: ((typeof recent)[number] | null)[] = [...recent];
  while (slots.length < MAX_RECENT) slots.push(null);

  return (
    <div className="welcome scroll">
      <div className="welcome-inner">
        {/* 1 · 标识块 */}
        <section className="welcome-id">
          <div className="wi-logo">
            <span className="wi-mark" aria-hidden>
              <Sparkles size={17} />
            </span>
            <h1>{t('welcome.greeting', { name: userName || '—' })}</h1>
          </div>

          <div className="wi-meta">
            <span className="mono">
              {t('welcome.meta', {
                version,
                model: session?.model ?? '—',
                workspace: formatPath(workspace, 40),
              })}
            </span>
          </div>

          <div className="wi-start">{t('welcome.start')}</div>
        </section>

        {/* 2 · 最近会话块 */}
        <section className="welcome-block welcome-recent-block">
          <div className="wb-head">
            <Clock size={13} className="muted" />
            <h2>{t('welcome.recent')}</h2>
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              style={{ marginLeft: 'auto' }}
              onClick={() => openPanel('resume')}
            >
              /resume
            </button>
          </div>

          <div className="welcome-recent">
            {slots.map((s, i) =>
              s ? (
                <button
                  key={s.id}
                  type="button"
                  className="recent-slot"
                  onClick={() => switchSession(s.id)}
                >
                  <span className="rs-top">
                    <span className="rs-id">{s.id}</span>
                    <span className="rs-time">{formatRelative(s.modified_at)}</span>
                  </span>
                  <span className="rs-preview clamp-2">{s.preview}</span>
                </button>
              ) : (
                <div key={`empty-${i}`} className="recent-slot is-empty">
                  <span className="faint caption">{t('welcome.slotEmpty')}</span>
                </div>
              ),
            )}
          </div>
        </section>

        {/* 3 · 快捷键块 */}
        <section className="welcome-block welcome-keys-block">
          <div className="wb-head">
            <Terminal size={13} className="muted" />
            <h2>{t('welcome.keys')}</h2>
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              style={{ marginLeft: 'auto' }}
              onClick={() => openPanel('help')}
            >
              /help
            </button>
          </div>

          <div className="keycaps">
            <div className="keycap">
              <span className="kc-keys">
                <Kbd>Ctrl K</Kbd>
              </span>
              <span>{t('key.palette')}</span>
            </div>
            <div className="keycap">
              <span className="kc-keys">
                <Kbd>⏎</Kbd>
              </span>
              <span>{t('key.send')}</span>
            </div>
            <div className="keycap">
              <span className="kc-keys">
                <Kbd>⇧ ⏎</Kbd>
              </span>
              <span>{t('key.newline')}</span>
            </div>
            <div className="keycap">
              <span className="kc-keys">
                <Kbd>Ctrl B</Kbd>
              </span>
              <span>{t('key.sidebar')}</span>
            </div>
            <div className="keycap">
              <span className="kc-keys">
                <Kbd>Ctrl T</Kbd>
              </span>
              <span>{t('key.thinking')}</span>
            </div>
            <div className="keycap">
              <span className="kc-keys">
                <Kbd>Ctrl S</Kbd>
              </span>
              <span>{t('key.skills')}</span>
            </div>
            <div className="keycap">
              <span className="kc-keys">
                <Kbd>Esc</Kbd>
              </span>
              <span>{t('key.esc')}</span>
            </div>
            <div className="keycap">
              <span className="kc-keys">
                <Kbd>1</Kbd>
                <Kbd>9</Kbd>
              </span>
              <span>{t('key.pick')}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
