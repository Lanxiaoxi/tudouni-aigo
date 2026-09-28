import { useMemo, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { MessageCircleQuestion, SkipForward } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Badge } from '@/components/ui/kit';
import { Checkbox } from '@/components/ui/controls';

/**
 * §6.2 提问模态 —— 两个阻塞模态之二。
 *
 * 硬约束：
 *  - 必显：问题、可选标签、选项列表（可多选）、自由文本输入。
 *  - 空选项 = 自由作答（此时必须能只填文本就提交）。
 *  - 自由文本优先：有文本时以文本为准，哪怕也勾了选项。
 *  - **跳过是独立动作** —— 不许用「空提交」代表没决定，所以跳过是一个独立按钮，
 *    并且 Esc 明确落成跳过，而不是「什么都没发生」。
 *  - 数字直选 1-9 直接选对应选项。
 */
export function QuestionModal() {
  const t = useT();
  const modal = useApp((s) => s.modal);
  const answer = useApp((s) => s.answerQuestion);

  const open = modal?.kind === 'question';
  const req = open ? modal.req : null;

  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState('');

  // 每个提问都是新的一次决策，切题时清空草稿
  const reqId = req?.id ?? null;
  const [lastId, setLastId] = useState<string | null>(null);
  if (reqId !== lastId) {
    setLastId(reqId);
    setSelected([]);
    setText('');
  }

  const hasOptions = (req?.options.length ?? 0) > 0;
  const canSubmit = text.trim() !== '' || selected.length > 0;

  const primaryHint = useMemo(() => {
    if (text.trim() !== '') return t('q.freeTextPriority');
    if (selected.length > 0) return t('q.submit');
    return hasOptions ? t('q.pickAtLeastOne') : t('q.freeTextPriority');
  }, [hasOptions, selected.length, t, text]);

  function toggle(id: string) {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  function submit() {
    // 自由文本优先：有文本就按文本走
    if (text.trim() !== '') {
      answer('free_text', undefined, text.trim());
      return;
    }
    if (selected.length > 0) {
      answer('choose', selected);
      return;
    }
  }

  return (
    <DialogPrimitive.Root open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-mask" />
        <DialogPrimitive.Content
          className="dialog"
          aria-describedby={undefined}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            answer('skip'); // 跳过是独立动作，不是「关掉了」
          }}
          onKeyDown={(e) => {
            if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && req) {
              const opt = req.options[Number(e.key) - 1];
              if (opt) {
                e.preventDefault();
                if (req.multi) toggle(opt.id);
                else setSelected([opt.id]);
              }
            }
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
                    background: 'var(--info-subtle)',
                    color: 'var(--info)',
                  }}
                >
                  <MessageCircleQuestion size={15} />
                </span>

                <div className="grow">
                  <DialogPrimitive.Title className="dialog-title">
                    {t('q.title')}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description className="dialog-desc">
                    {t('q.subtitle')}
                  </DialogPrimitive.Description>
                </div>

                <Badge tone={req.multi ? 'info' : 'neutral'} dot={false}>
                  {req.multi ? t('q.multi') : t('q.single')}
                </Badge>
              </div>

              <div className="dialog-body scroll">
                {/* 问题本体 */}
                <p style={{ fontSize: 'var(--text-body)', marginBottom: 'var(--space-3)' }}>
                  {req.question}
                </p>

                {/* 可选标签：只是事实，不可点 */}
                {req.tags.length > 0 ? (
                  <div
                    className="row"
                    style={{ gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-4)' }}
                  >
                    {req.tags.map((tag) => (
                      <Badge key={tag} tone="neutral" dot={false}>
                        {tag}
                      </Badge>
                    ))}
                  </div>
                ) : null}

                {/* 选项 */}
                {hasOptions ? (
                  <>
                    <div className="etb-label">{t('q.options')}</div>
                    {req.multi ? (
                      <div className="col" style={{ gap: 2, marginTop: 4 }}>
                        {req.options.map((o, i) => (
                          <label
                            key={o.id}
                            className="radio-item"
                            data-state={selected.includes(o.id) ? 'checked' : 'unchecked'}
                          >
                            <Checkbox
                              checked={selected.includes(o.id)}
                              onCheckedChange={() => toggle(o.id)}
                              label={o.label}
                            />
                            <span className="seq">{i + 1}</span>
                            <span className="grow">
                              <span className="strong">{o.label}</span>
                              {o.description ? (
                                <span className="caption muted"> — {o.description}</span>
                              ) : null}
                            </span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <RadioGroupPrimitive.Root
                        className="radio-root"
                        value={selected[0] ?? ''}
                        onValueChange={(v) => setSelected([v])}
                      >
                        {req.options.map((o, i) => (
                          <RadioGroupPrimitive.Item
                            key={o.id}
                            value={o.id}
                            className="radio-item"
                          >
                            <span className="radio-outer">
                              <RadioGroupPrimitive.Indicator className="radio-inner" />
                            </span>
                            <span className="seq">{i + 1}</span>
                            <span className="grow">
                              <span className="strong">{o.label}</span>
                              {o.description ? (
                                <span className="caption muted"> — {o.description}</span>
                              ) : null}
                            </span>
                          </RadioGroupPrimitive.Item>
                        ))}
                      </RadioGroupPrimitive.Root>
                    )}
                  </>
                ) : (
                  <div className="caption muted">{t('q.noOptions')}</div>
                )}

                {/* 自由文本 */}
                {req.allow_free_text ? (
                  <>
                    <div className="etb-label" style={{ marginTop: 'var(--space-4)' }}>
                      {t('q.freeText')}
                    </div>
                    <textarea
                      className="input"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder={t('q.freeTextPlaceholder')}
                      style={{
                        display: 'block',
                        width: '100%',
                        height: 'auto',
                        minHeight: 72,
                        marginTop: 4,
                        padding: 'var(--space-2) var(--space-3)',
                        resize: 'vertical',
                        lineHeight: 'var(--leading-body)',
                      }}
                    />
                  </>
                ) : null}
              </div>

              <div className="dialog-foot">
                <span className="caption faint">{primaryHint}</span>
                <span className="grow" />

                {/* 跳过：独立动作，永远可用 */}
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => answer('skip')}
                >
                  <SkipForward size={12} />
                  {t('q.skip')}
                  <kbd className="kbd" style={{ marginLeft: 4 }}>
                    Esc
                  </kbd>
                </button>

                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={submit}
                  disabled={!canSubmit}
                >
                  {t('q.submit')}
                </button>
              </div>
            </>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
