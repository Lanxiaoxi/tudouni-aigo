import { useT } from '@/i18n/useT';
import { BusyDots } from '@/components/ui/kit';

/**
 * 启动中（§4 阶段表）。
 * 「慢启动要给第二句提示」—— 所以这里永远有两行，第二行说明为什么在等。
 */
export function Booting() {
  const t = useT();
  return (
    <div className="booting">
      <span className="bt-mark" aria-hidden />
      <div className="row">
        <span>{t('app.booting')}</span>
        <BusyDots />
      </div>
      <div className="bt-2nd">{t('app.bootingSlow')}</div>
    </div>
  );
}
