/**
 * The window's presentation preferences: read once at module load, persisted
 * on change.
 *
 * This was the first block of `store.ts` that never needed the store: it reads
 * `localStorage`, validates what it finds against the shapes this build knows,
 * and writes the whole record back. The one store-shaped function here is
 * `persistPrefs`, which reads the fields off the state — and it takes that
 * state as an argument, so this file imports the store's **type** only.
 *
 * **The record shrank to the window's presentation.** The user data (task
 * templates, run history, saved hosts, remote workspaces, the remembered
 * workspace, the launch defaults) used to live in this same record, in the
 * opaque leveldb behind localStorage; it now follows the person —
 * `~/.tudouni/desktop.json`, handled by `desktopData.ts`. `persistPrefs`
 * still takes the whole state because the split is this module's concern, not
 * the callers': the call sites are unchanged, and the user-data half is
 * synced by the same call.
 *
 * The validators are deliberately defensive: localStorage outlives every
 * build, and a record from an older version must not take the sidebar down
 * with it.
 */
import { syncFromStore } from './desktopData';
import type { AppStore, QuietMode, SidebarBlockKey } from './store';

/**
 * The rail opens **folded**: five headings are a table of contents, and a list
 * that springs open on every start spends its pixels on blocks that usually
 * have nothing to say about this conversation yet. The first snapshot that
 * gives a block content unfolds it — once (`blockAutoExpanded`), and never
 * again after a person has folded it themselves (`blockTouched`).
 */
const EMPTY_BLOCKS: Record<SidebarBlockKey, boolean> = {
  goal: true,
  tasks: true,
  skills: true,
  jobs: true,
  mcp: true,
  ssh: true,
};

/**
 * The range a dragged rail width is allowed to land in — **one range for both
 * rails**, so the two cannot disagree about what "reset" and "as wide as it
 * goes" mean, and so a future change has one place to land.
 *
 * The floor keeps every row's own minimum readable (the right rail's MCP row
 * was measured to overflow below 201px — see `McpRow`; the left rail's own
 * narrow-window fallback is 216px, just above it), and the ceiling keeps a
 * maximally wide rail from eating the transcript: the composer's comfortable
 * floor is around 700px, and even both rails dragged to the ceiling together
 * still leave it on a window of the size this app is meant to run in. Both ends
 * are read back through this function on load, so a range change re-clamps what
 * an older build persisted rather than trusting it.
 */
export const RAIL_MIN = 208;
export const RAIL_MAX = 420;

export function clampRailWidth(px: number): number {
  if (!Number.isFinite(px)) return RAIL_MIN;
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(px)));
}

/* ============================================================
   Preferences: read once, persisted on change
   ============================================================ */

/**
 * What the window remembers about itself — and only that. The user data moved
 * to `desktopData.ts` (`~/.tudouni/desktop.json`); the fields below are the
 * ones a *different window* would legitimately hold differently, and they
 * stay in the window's own storage.
 */
type Prefs = {
  /** Quiet mode as remembered. Reads a legacy `true`/`false` record from the
   *  boolean era: `true` meant the mode was on, which is `normal`. */
  quiet: QuietMode;
  sidebarVisible: boolean;
  leftbarVisible: boolean;
  /** The right rail's dragged width; `null` = the stylesheet's own default. */
  sidebarWidth: number | null;
  /** The left rail's dragged width; `null` = the stylesheet's own default. */
  leftbarWidth: number | null;
  blockCollapsed: Record<SidebarBlockKey, boolean>;
  blockTouched: Partial<Record<SidebarBlockKey, boolean>>;
  /** The left rail's session list, folded on its own. */
  sessionsCollapsed: boolean;
  /** The left rail's workspace list (local + remote), folded on its own. */
  workspacesCollapsed: boolean;
  /** The left rail's foot (the seven workbench buttons), folded on its own. */
  footCollapsed: boolean;
};

function loadPrefs(): Prefs {
  const fallback: Prefs = {
    quiet: 'off',
    sidebarVisible: true,
    leftbarVisible: true,
    sidebarWidth: null,
    leftbarWidth: null,
    blockCollapsed: { ...EMPTY_BLOCKS },
    blockTouched: {},
    sessionsCollapsed: false,
    workspacesCollapsed: false,
    footCollapsed: true,
  };
  try {
    const raw = localStorage.getItem('aigo.prefs');
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    // Read off the raw record: a legacy build persisted a **boolean** from
    // when the mode was a toggle, and `Partial<Prefs>` would type the field
    // as `QuietMode` and hide that the old value is not one of the three.
    const quietRaw: unknown = (parsed as Record<string, unknown>).quiet;
    return {
      // `true` means the mode was on, which is `normal`. Anything else is `off`.
      quiet:
        quietRaw === 'normal' || quietRaw === 'simple' ? quietRaw : quietRaw === true ? 'normal' : 'off',
      sidebarVisible: parsed.sidebarVisible ?? fallback.sidebarVisible,
      leftbarVisible: parsed.leftbarVisible ?? fallback.leftbarVisible,
      // A number, or nothing. A non-number is not `NaN`-coerced and hoped for:
      // `clampRailWidth` would turn it into a real width and a corrupted record
      // would silently win over a stylesheet default, so the boundary is kept
      // at the parse.
      sidebarWidth:
        typeof parsed.sidebarWidth === 'number' && Number.isFinite(parsed.sidebarWidth)
          ? clampRailWidth(parsed.sidebarWidth)
          : fallback.sidebarWidth,
      // The left rail's, read back under exactly the same boundary — an older
      // build has no `leftbarWidth` at all, which is the `fallback` branch and
      // therefore the stylesheet's own default.
      leftbarWidth:
        typeof parsed.leftbarWidth === 'number' && Number.isFinite(parsed.leftbarWidth)
          ? clampRailWidth(parsed.leftbarWidth)
          : fallback.leftbarWidth,
      blockCollapsed: { ...EMPTY_BLOCKS, ...(parsed.blockCollapsed ?? {}) },
      blockTouched: parsed.blockTouched ?? {},
      // The same boundary as the two around it. A stored `false` is an answer
      // and must survive the launch; anything that is not a boolean is a
      // corrupted record, and `"false"` (truthy) would fold the side rail over
      // a preference the person never set.
      sessionsCollapsed:
        typeof parsed.sessionsCollapsed === 'boolean'
          ? parsed.sessionsCollapsed
          : fallback.sessionsCollapsed,
      workspacesCollapsed:
        parsed.workspacesCollapsed === true || parsed.workspacesCollapsed === false
          ? parsed.workspacesCollapsed
          : fallback.workspacesCollapsed,
      // A stored `false` is an answer ("leave it open") and must survive the
      // launch; the fallback is what a profile that never chose gets, and it is
      // now `true` (the drawer starts folded — see `footCollapsed`'s doc).
      footCollapsed:
        typeof parsed.footCollapsed === 'boolean' ? parsed.footCollapsed : fallback.footCollapsed,
    };
  } catch {
    return fallback;
  }
}

/**
 * Persist the window's presentation, and sync the user data.
 *
 * The record written here is the window's own half of the old `aigo.prefs`;
 * the user-data half goes to `~/.tudouni/desktop.json` through
 * `syncFromStore`, which is a no-op when nothing the file holds has moved.
 */
export function persistPrefs(s: AppStore, quiet?: { key: string; value: QuietMode }): void {
  syncFromStore(s);
  try {
    localStorage.setItem(
      'aigo.prefs',
      JSON.stringify({
        // Quiet is per session now, so the remembered value is the active
        // session's — it is the one a person just changed, and it is what a
        // fresh session should start from.
        quiet: quiet ? quiet.value : s.sessions[s.activeKey ?? '']?.quiet ?? 'off',
        sidebarVisible: s.sidebarVisible,
        leftbarVisible: s.leftbarVisible,
        sidebarWidth: s.sidebarWidth,
        leftbarWidth: s.leftbarWidth,
        blockCollapsed: s.blockCollapsed,
        blockTouched: s.blockTouched,
        sessionsCollapsed: s.sessionsCollapsed,
        workspacesCollapsed: s.workspacesCollapsed,
        footCollapsed: s.footCollapsed,
      }),
    );
  } catch {
    /* Private mode: preferences simply do not persist. */
  }
}

export const prefs = loadPrefs();
