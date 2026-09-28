import { useT } from '@/i18n/useT';
import { BusyDots } from '@/components/ui/kit';

/**
 * The "starting" phase (§4).
 *
 * A slow start gets a second sentence — so there are always two lines here, and
 * the second one says why we are waiting.
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
