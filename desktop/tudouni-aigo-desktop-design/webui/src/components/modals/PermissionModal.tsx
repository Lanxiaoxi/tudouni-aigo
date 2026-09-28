import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AlertOctagon, AlertTriangle, ShieldCheck } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Fact, RiskTag } from '@/components/ui/kit';

/**
 * §6.1 审批模态 —— 两个阻塞模态之一。
 *
 * 硬约束：
 *  - 必显工具名、内置/外部、风险等级、参数**全文不截断**（高风险命令的关键常在后半句）。
 *  - 运行时给的两句提示**一字不许改** —— 那是唯一知道「记住意味着什么」的一方写的。
 *  - 阻塞直到人回答：不许自动跳过、超时兜底或「猜一个」。
 *  - 「总是允许」只在运行时给了记住规则时出现；「全部允许」只在运行时置位时出现。
 *  - 拒绝与关闭同义，所以 Esc 直接落成拒绝，不弹二次确认。
 */
export function PermissionModal() {
  const t = useT();
  const modal = useApp((s) => s.modal);
  const answer = useApp((s) => s.answerPermission);

  const open = modal?.kind === 'permission';
  const req = open ? modal.req : null;

  return (
    <DialogPrimitive.Root open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-mask" />
        <DialogPrimitive.Content
          className="dialog"
          aria-describedby={undefined}
          // 拖动外的误触不算决定；关闭只能显式发生
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            answer('deny'); // 拒绝与关闭同义
          }}
        >
          {req ? (
            <>
              <div className="dialog-head">
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 28,
                    height: 28,
                    flex: 'none',
                    borderRadius: 'var(--radius-md)',
                    background:
                      req.risk === 'HIGH' ? 'var(--destructive-subtle)' : 'var(--warning-subtle)',
                    color: req.risk === 'HIGH' ? 'var(--destructive)' : 'var(--warning)',
                  }}
                >
                  {req.risk === 'HIGH' ? <AlertOctagon size={15} /> : <ShieldCheck size={15} />}
                </span>

                <div className="grow">
                  <DialogPrimitive.Title className="dialog-title">
                    {t('perm.title')}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description className="dialog-desc">
                    {t('perm.subtitle')}
                  </DialogPrimitive.Description>
                </div>

                <RiskTag level={req.risk} />
              </div>

              <div className="dialog-body scroll">
                {/* 工具 / 来源 / 安全属性 —— 只读事实，不画成控件 */}
                <div
                  className="row"
                  style={{ gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}
                >
                  <Fact mono title={t('perm.tool')}>
                    {req.tool}
                  </Fact>
                  <Fact>{req.builtin ? t('entry.builtin') : t('entry.external')}</Fact>
                  <Fact>
                    {req.parallel_safe ? '✓ ' : '✗ '}
                    {t('entry.parallelSafe')}
                  </Fact>
                  <Fact>
                    {req.occupies_input ? '✓ ' : '✗ '}
                    {t('entry.occupiesInput')}
                  </Fact>
                  <Fact mono>
                    step {req.step}
                  </Fact>
                </div>

                {req.risk === 'HIGH' ? (
                  <div
                    className="e-denied"
                    style={{ marginBottom: 'var(--space-3)', borderLeftColor: 'var(--destructive)' }}
                  >
                    <AlertOctagon size={12} />
                    <span className="ed-text">{t('perm.escalate')}</span>
                  </div>
                ) : null}

                {/* 运行时原文：两句话，一字不改 */}
                <div className="etb-label">{t('perm.hintLabel')}</div>
                <div
                  className="col"
                  style={{
                    gap: 'var(--space-2)',
                    padding: 'var(--space-3)',
                    marginTop: 4,
                    marginBottom: 'var(--space-4)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--bg-secondary)',
                  }}
                >
                  {req.hints.map((h, i) => (
                    <p key={i} style={{ color: 'var(--fg-secondary)' }}>
                      {h}
                    </p>
                  ))}
                </div>

                {/* 参数全文，不截断、不折叠、可横向滚 */}
                <div className="etb-label">{t('perm.params')}</div>
                <div className="terminal" style={{ marginTop: 4 }}>
                  {req.params}
                </div>

                {req.remember_rule ? (
                  <div className="caption muted" style={{ marginTop: 'var(--space-2)' }}>
                    {t('perm.rememberHint', { rule: req.remember_rule })}
                  </div>
                ) : null}

                {req.allow_all ? (
                  <div className="caption muted" style={{ marginTop: 2 }}>
                    {t('perm.snapshotHint')}
                  </div>
                ) : null}
              </div>

              <div className="dialog-foot">
                <span className="caption faint">{t('perm.denySameAsClose')}</span>
                <span className="grow" />

                {/* 拒绝是危险方向上的安全操作，用 destructive 明确表达 */}
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => answer('deny')}
                >
                  {t('perm.action.deny')}
                  <kbd className="kbd" style={{ marginLeft: 4 }}>
                    Esc
                  </kbd>
                </button>

                {/* 总是允许：仅当运行时给了记住规则 */}
                {req.remember_rule ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => answer('always')}
                  >
                    {t('perm.action.always')}
                  </button>
                ) : null}

                {/* 全部允许：仅当运行时置位 */}
                {req.allow_all ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => answer('allow_all')}
                  >
                    <AlertTriangle size={11} />
                    {t('perm.action.allowAll')}
                  </button>
                ) : null}

                {/* 一屏最多一个 Primary：这里是本轮唯一的主操作 */}
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => answer('allow')}
                >
                  {t('perm.action.allow')}
                </button>
              </div>
            </>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
