/**
 * 展示格式化。
 * 注意：这里只做「显示形态」转换，不做任何语义推导 ——
 * 界面上的事实必须来自协议，格式化函数不允许算出新的数字。
 */

/** 耗时：<10s 用 ms，往上一律带单位，避免出现 1234567ms */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return `${m}m${rest.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, '0')}m`;
}

/** token 数：千分位，与终端风格一致 */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-US');
}

/** 缓存命中率 0..1 → 百分比 */
export function formatPercent(r: number | null | undefined, digits = 0): string {
  if (r === null || r === undefined) return '—';
  return `${(r * 100).toFixed(digits)}%`;
}

/** 相对时间。一眼能看出新旧即可，不做「刚刚/一会儿前」的花活 */
export function formatRelative(atMs: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - atMs);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const mon = Math.floor(day / 30);
  return `${mon} 个月前`;
}

export function formatClock(atMs: number): string {
  const d = new Date(atMs);
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 单行截断，用于参数预览与首条消息预览。不改变语义，只加省略号 */
export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

/** 按行截断，高风险命令的参数区用来保底（但审批模态里禁止截断） */
export function clampLines(text: string, max: number): { text: string; hidden: number } {
  const lines = text.split('\n');
  if (lines.length <= max) return { text, hidden: 0 };
  return { text: lines.slice(0, max).join('\n'), hidden: lines.length - max };
}

export function formatPath(p: string, max = 42): string {
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]/);
  if (parts.length <= 2) return `…${p.slice(-max)}`;
  return `${parts[0]}/…/${parts.slice(-2).join('/')}`;
}
