import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Fact, Tip } from '@/components/ui/kit';

/**
 * §1·2 会话栏：会话 id、是否续接、模型、思考强度、步数上限、权限状态。
 *
 * 权限那一段是**只读状态展示**，不是可操作控件（§1·2、§9.5）：
 * 用虚线边 + cursor:default 表达「这是个事实」，不能画成开关。
 */
export function SessionBar() {
  const t = useT();
  const session = useApp((s) => s.session);
  const scope = useApp((s) => s.permissionScope);
  const openPanel = useApp((s) => s.openPanel);

  if (!session) {
    return (
      <div className="sessionbar">
        <span className="sb-label">{t('session.label')}</span>
        <span className="muted">—</span>
      </div>
    );
  }

  const askLabel = !scope
    ? '—'
    : scope.autopilot
      ? t('session.permAuto')
      : scope.ask_on.length === 0
        ? t('session.permNone')
        : scope.ask_on.map((r) => t(`risk.${r}`)).join(' + ');

  return (
    <div className="sessionbar">
      <div className="sb-group">
        <span className="sb-label">{t('session.label')}</span>
        <Fact mono title="session id">
          {session.id}
        </Fact>
        <Fact>{session.resumed ? t('session.resumed') : t('session.fresh')}</Fact>
      </div>

      <span className="sep" />

      <div className="sb-group">
        <span className="sb-label">{t('session.model')}</span>
        <button
          type="button"
          className="btn btn-ghost btn-compact"
          onClick={() => openPanel('model')}
        >
          <span className="mono">{session.model}</span>
          <span className="faint">@{session.model_route}</span>
        </button>
      </div>

      <span className="sep" />

      <div className="sb-group">
        <span className="sb-label">{t('session.thinking')}</span>
        <Fact mono>
          {session.thinking ? t('session.thinkingOn') : t('session.thinkingOff')}
        </Fact>
        <button
          type="button"
          className="btn btn-ghost btn-compact"
          onClick={() => openPanel('effort')}
          title={t('panel.effort.title')}
        >
          <span className="faint">{t('session.effort')}</span>
          <span className="mono">{session.effort ?? '—'}</span>
        </button>
      </div>

      <span className="sep" />

      <div className="sb-group">
        <span className="sb-label">{t('session.maxSteps')}</span>
        <Fact mono>{session.max_steps}</Fact>
      </div>

      <div className="sb-right">
        <Tip
          label={
            scope
              ? `${t('session.permScope')} · 已在运行时侧记住 ${scope.remembered_rules} 条规则`
              : undefined
          }
        >
          <span className="perm-scope">
            <span>{t('session.permScope')}</span>
            <span className="mono">{askLabel}</span>
          </span>
        </Tip>
      </div>
    </div>
  );
}
