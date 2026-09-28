import { useMemo } from 'react';
import { useApp } from '@/state/store';
import { makeT, type Translate } from './index';

/** 从 store 读 locale，返回绑定好的 t。语言切换时整个界面重新取文案 */
export function useT(): Translate {
  const locale = useApp((s) => s.locale);
  return useMemo(() => makeT(locale), [locale]);
}
