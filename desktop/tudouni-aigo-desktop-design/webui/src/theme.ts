/**
 * 主题。
 *
 * 设计系统给的是「跟随系统」双模（tauri-native-spec.md §4）；
 * desktop-ui-spec.md §5 又要求 /theme 面板能选主题名。
 * 折中：默认 follow system，/theme 允许显式覆盖，覆盖值持久化。
 * CSS 只认 [data-theme="dark"] / [data-theme="light"] 两个值，没有第三种。
 */

import type { ThemePref } from '@/state/store';

const STORAGE_KEY = 'aigo.theme';

export function systemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveTheme(pref: ThemePref): 'dark' | 'light' {
  return pref === 'system' ? systemTheme() : pref;
}

/** 同步到 DOM 与 localStorage（index.html 的内联脚本读同一个 key 防首帧闪） */
export function applyTheme(pref: ThemePref): void {
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  try {
    localStorage.setItem(STORAGE_KEY, pref === 'system' ? 'system' : pref);
  } catch {
    /* 忽略 */
  }
}

/** 订阅系统主题变化。返回取消函数 */
export function watchSystemTheme(onChange: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => onChange();
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

export function readStoredPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    /* 忽略 */
  }
  return 'system';
}
