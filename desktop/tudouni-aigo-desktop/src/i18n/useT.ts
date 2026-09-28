import { useMemo } from 'react';
import { makeT, type Translate } from './index';

/** There is one language, so this is a constant rather than a subscription. It
 *  stays a hook so a second language could be added without touching callers. */
export function useT(): Translate {
  return useMemo(() => makeT(), []);
}
