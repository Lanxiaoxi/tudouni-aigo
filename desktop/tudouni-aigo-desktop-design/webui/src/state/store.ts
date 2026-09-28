/**
 * 全局状态。
 *
 * 分工（对应 desktop-ui-spec.md §0）：
 *  - 「运行时事实」全部来自 applyRuntimeMessage，前端只存不造。
 *  - 「前端本地偏好」（主题、安静模式、侧栏/思考块折叠、输入草稿）留在这里，
 *    因为它们是呈现层选择，不是运行时状态。
 *  - 禁止乐观更新：点了「总是允许」只发出站消息，等 ui(state) 回执才改显示。
 */

import { create } from 'zustand';
import type {
  EffortOption,
  FrontendMsg,
  Locale,
  ModelInfo,
  PermissionRequestMsg,
  PermissionResponseAction,
  PermissionScope,
  QuestionRequestMsg,
  QuestionResponseAction,
  RuntimeMsg,
  SessionListItem,
  SessionMeta,
  SkillRow,
  UiStatePayload,
  UiStatusPayload,
} from '@/protocol/types';
import {
  applyDelta,
  applyUi,
  clearStream,
  nextId,
  reduceEvent,
  type Entry,
} from '@/state/entries';
import { send as busSend } from '@/runtime/bus';

export type ThemePref = 'system' | 'dark' | 'light';

export type PanelKind =
  | 'commands'
  | 'model'
  | 'effort'
  | 'theme'
  | 'resume'
  | 'mcp'
  | 'skills'
  | 'help'
  | 'subagents'
  | 'audit';

export type SidebarBlockKey = 'goal' | 'tasks' | 'skills' | 'jobs' | 'mcp';

export const SIDEBAR_BLOCKS: SidebarBlockKey[] = ['goal', 'tasks', 'skills', 'jobs', 'mcp'];

export type ModalState =
  | { kind: 'permission'; req: PermissionRequestMsg }
  | { kind: 'question'; req: QuestionRequestMsg }
  | null;

export interface AppStore {
  /* ---------------- 运行时接线 ---------------- */
  ready: boolean;
  version: string;
  workspace: string;
  locale: Locale;
  userName: string;

  /* ---------------- 会话 ---------------- */
  session: SessionMeta | null;
  permissionScope: PermissionScope | null;
  sessionList: SessionListItem[];
  sessionTotal: number;
  listedSessions: boolean;
  /** 本地事实：本会话是否已说过话。「从没说过话」与「空闲」是两个文案（§4） */
  hasSpoken: boolean;

  /* ---------------- 流 ---------------- */
  entries: Entry[];
  activeRunId: string | null;
  /** 被丢弃的迟到/乱序消息数，只在审计面板里可见 */
  dropped: number;

  /* ---------------- 状态快照 ---------------- */
  uiState: UiStatePayload | null;
  status: UiStatusPayload | null;

  /* ---------------- 目录 ---------------- */
  models: ModelInfo[];
  skillsCatalog: SkillRow[];
  themes: string[];

  /* ---------------- 模态 / 面板 ---------------- */
  modal: ModalState;
  panel: PanelKind | null;

  /* ---------------- 前端本地偏好 ---------------- */
  themePref: ThemePref;
  quiet: boolean;
  sidebarVisible: boolean;
  blockCollapsed: Record<SidebarBlockKey, boolean>;
  blockTouched: Partial<Record<SidebarBlockKey, boolean>>;
  blockAutoExpanded: Partial<Record<SidebarBlockKey, boolean>>;
  reasoningOpen: Record<string, boolean>;
  toolOpen: Record<string, boolean>;
  dismissedHints: Record<string, boolean>;

  /* ---------------- 输入框 ---------------- */
  draft: string;
  history: string[];
  historyCursor: number | null;

  /* ---------------- 动作 ---------------- */
  send(msg: FrontendMsg): void;
  applyRuntimeMessage(msg: RuntimeMsg): void;

  setLocale(l: Locale): void;
  setDraft(v: string): void;
  historyNav(dir: -1 | 1): void;
  submitDraft(): void;
  interrupt(): void;

  openPanel(p: PanelKind | null): void;
  setThemePref(t: ThemePref): void;
  setQuiet(q: boolean): void;
  toggleQuiet(): void;
  toggleSidebar(): void;
  setSidebarVisible(v: boolean): void;
  toggleBlock(k: SidebarBlockKey): void;
  toggleReasoning(id: string): void;
  toggleTool(id: string): void;
  /** 关掉流内大屏文本块：只从流里移除这一条，不动任何数据 */
  removeBlock(id: string): void;

  answerPermission(action: PermissionResponseAction): void;
  answerQuestion(
    action: QuestionResponseAction,
    selected?: string[],
    text?: string,
  ): void;

  switchSession(id: string): void;
  requestSessionList(): void;
  setAutopilot(enabled: boolean): void;
  chooseModel(model: string): void;
  chooseEffort(effort: string): void;
  setThinking(enabled: boolean): void;
  requestStreamBlock(which: 'status' | 'tools' | 'context' | 'compact'): void;
  refreshState(): void;
}

const EMPTY_BLOCKS: Record<SidebarBlockKey, boolean> = {
  goal: false,
  tasks: false,
  skills: false,
  jobs: false,
  mcp: false,
};

/** 本地偏好：读一次 localStorage，读不到就用默认 */
function loadPrefs(): {
  themePref: ThemePref;
  quiet: boolean;
  sidebarVisible: boolean;
  blockCollapsed: Record<SidebarBlockKey, boolean>;
  blockTouched: Partial<Record<SidebarBlockKey, boolean>>;
} {
  const fallback = {
    themePref: 'system' as ThemePref,
    quiet: false,
    sidebarVisible: true,
    blockCollapsed: { ...EMPTY_BLOCKS },
    blockTouched: {},
  };
  try {
    const raw = localStorage.getItem('aigo.prefs');
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<typeof fallback>;
    return {
      themePref: p.themePref ?? fallback.themePref,
      quiet: p.quiet ?? fallback.quiet,
      sidebarVisible: p.sidebarVisible ?? fallback.sidebarVisible,
      blockCollapsed: { ...EMPTY_BLOCKS, ...(p.blockCollapsed ?? {}) },
      blockTouched: p.blockTouched ?? {},
    };
  } catch {
    return fallback;
  }
}

function persistPrefs(s: AppStore): void {
  try {
    localStorage.setItem(
      'aigo.prefs',
      JSON.stringify({
        themePref: s.themePref,
        quiet: s.quiet,
        sidebarVisible: s.sidebarVisible,
        blockCollapsed: s.blockCollapsed,
        blockTouched: s.blockTouched,
      }),
    );
  } catch {
    /* 隐私模式下忽略 */
  }
}

const prefs = loadPrefs();

export const useApp = create<AppStore>((set, get) => ({
  ready: false,
  version: '—',
  workspace: '',
  locale: 'zh',
  userName: '',

  session: null,
  permissionScope: null,
  sessionList: [],
  sessionTotal: 0,
  listedSessions: false,
  hasSpoken: false,

  entries: [],
  activeRunId: null,
  dropped: 0,

  uiState: null,
  status: null,

  models: [],
  skillsCatalog: [],
  themes: [],

  modal: null,
  panel: null,

  themePref: prefs.themePref,
  quiet: prefs.quiet,
  sidebarVisible: prefs.sidebarVisible,
  blockCollapsed: prefs.blockCollapsed,
  blockTouched: prefs.blockTouched,
  blockAutoExpanded: {},
  reasoningOpen: {},
  toolOpen: {},
  dismissedHints: {},

  draft: '',
  history: [],
  historyCursor: null,

  /* ============================================================
     出站
     ============================================================ */
  send(msg) {
    busSend(msg);
  },

  /* ============================================================
     入站：唯一的运行时事实入口
     ============================================================ */
  applyRuntimeMessage(msg) {
    const s = get();

    switch (msg.type) {
      case 'init': {
        set({
          ready: true,
          version: msg.version,
          workspace: msg.workspace,
          locale: msg.locale,
          userName: msg.user_name,
          session: msg.session,
          permissionScope: msg.permission_scope,
          models: msg.models,
          skillsCatalog: msg.skills_catalog,
          themes: msg.themes,
          uiState: s.uiState
            ? { ...s.uiState, context: msg.context, session: msg.session }
            : s.uiState,
        });
        break;
      }

      case 'session_load': {
        // 续接：把历史消息重建为会话流条目（用户输入 + 回答）
        const rebuilt: Entry[] = msg.messages.map((m) =>
          m.role === 'user'
            ? { kind: 'user', id: nextId('user'), text: m.text, atMs: m.at_ms }
            : { kind: 'answer', id: nextId('answer'), runId: 'history', text: m.text },
        );
        set({
          session: msg.session,
          entries: rebuilt,
          activeRunId: null,
          hasSpoken: msg.messages.length > 0,
        });
        break;
      }

      case 'event': {
        const ev = msg.event;
        const res = reduceEvent(s.entries, ev, s.activeRunId);
        if (res.stale) {
          set({ dropped: s.dropped + 1 });
          break;
        }
        set({
          entries: res.entries,
          activeRunId:
            ev.kind === 'run_started'
              ? ev.run_id
              : res.runEnded
                ? null
                : s.activeRunId,
        });
        break;
      }

      case 'ui': {
        const ui = msg.ui;

        if (ui.kind === 'state') {
          applyStateSnapshot(set, get, ui.state);
          break;
        }

        if (ui.kind === 'status') {
          set({ status: ui.status });
          break;
        }

        if (ui.kind === 'mcp') {
          // MCP 三态由 ui(mcp) 单独下发时，合并进快照
          const cur = get().uiState;
          if (cur) set({ uiState: { ...cur, mcp: ui.servers } });
          break;
        }

        // 其余（run_finished / tools / context / compacted）落成流内条目
        const res = applyUi(
          get().entries,
          ui,
          get().activeRunId,
          (runId) => runId === get().activeRunId,
        );
        if (res.stale) {
          set({ dropped: get().dropped + 1 });
          break;
        }
        set({ entries: res.entries, activeRunId: res.runEnded ? null : get().activeRunId });
        break;
      }

      case 'delta': {
        const res = applyDelta(
          get().entries,
          msg.run_id,
          msg.step,
          msg.channel,
          msg.text,
          get().activeRunId,
        );
        if (res.stale) {
          set({ dropped: get().dropped + 1 });
          break;
        }
        set({ entries: res.entries });
        break;
      }

      case 'delta_reset': {
        if (get().activeRunId !== null && msg.run_id !== get().activeRunId) {
          set({ dropped: get().dropped + 1 });
          break;
        }
        set({ entries: clearStream(get().entries, msg.run_id, msg.step, msg.channel) });
        break;
      }

      case 'notice': {
        set({
          entries: [
            ...get().entries,
            {
              kind: 'note',
              id: nextId('note'),
              tone:
                msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'info',
              key: msg.key,
              text: msg.text,
              params: msg.params,
            },
          ],
        });
        break;
      }

      case 'sessions': {
        set({ sessionList: msg.sessions, sessionTotal: msg.total, listedSessions: true });
        break;
      }

      case 'permission_request': {
        // 阻塞模态，优先级高于一切（§1·3）
        set({
          modal: { kind: 'permission', req: msg },
          panel: null,
        });
        break;
      }

      case 'question_request': {
        set({
          modal: { kind: 'question', req: msg },
          panel: null,
        });
        break;
      }

      default:
        break;
    }
  },

  /* ============================================================
     输入框
     ============================================================ */
  setLocale(l) {
    set({ locale: l });
  },

  setDraft(v) {
    set({ draft: v, historyCursor: null });
  },

  historyNav(dir) {
    const { history, historyCursor } = get();
    if (history.length === 0) return;
    let cursor: number | null;
    if (historyCursor === null) {
      if (dir === 1) return; // 已经在最新处，没有更「新」的历史
      cursor = history.length - 1;
    } else {
      cursor = historyCursor + dir;
    }
    if (cursor < 0) {
      set({ historyCursor: 0, draft: history[0] });
      return;
    }
    if (cursor >= history.length) {
      set({ historyCursor: null, draft: '' });
      return;
    }
    set({ historyCursor: cursor, draft: history[cursor] });
  },

  submitDraft() {
    const text = get().draft.trim();
    if (!text) return;
    if (get().modal !== null) return; // 模态存在时不抢占
    set({
      entries: [
        ...get().entries,
        { kind: 'user', id: nextId('user'), text, atMs: Date.now() },
      ],
      draft: '',
      history: [...get().history, text].slice(-100),
      historyCursor: null,
      hasSpoken: true,
    });
    busSend({ type: 'user_message', text });
  },

  interrupt() {
    busSend({ type: 'interrupt' });
  },

  /* ============================================================
     面板与偏好
     ============================================================ */
  openPanel(p) {
    set({ panel: p });
    if (p === 'resume') {
      set({ listedSessions: false });
      busSend({ type: 'session_list' });
    }
  },

  setThemePref(t) {
    set({ themePref: t });
    persistPrefs(get());
  },

  setQuiet(q) {
    set({ quiet: q });
    persistPrefs(get());
  },

  toggleQuiet() {
    get().setQuiet(!get().quiet);
  },

  toggleSidebar() {
    const v = !get().sidebarVisible;
    set({ sidebarVisible: v });
    persistPrefs(get());
  },

  setSidebarVisible(v) {
    set({ sidebarVisible: v });
    persistPrefs(get());
  },

  toggleBlock(k) {
    // 一旦用户手动拨过，就不再被自动展开逻辑弹回来（§3 行为规则）
    const collapsed = { ...get().blockCollapsed, [k]: !get().blockCollapsed[k] };
    const touched = { ...get().blockTouched, [k]: true };
    set({ blockCollapsed: collapsed, blockTouched: touched });
    persistPrefs(get());
  },

  toggleReasoning(id) {
    const cur = get().reasoningOpen;
    set({ reasoningOpen: { ...cur, [id]: !cur[id] } });
  },

  toggleTool(id) {
    const cur = get().toolOpen;
    set({ toolOpen: { ...cur, [id]: !cur[id] } });
  },

  removeBlock(id) {
    set({ entries: get().entries.filter((e) => !(e.kind === 'block' && e.id === id)) });
  },

  /* ============================================================
     两个阻塞模态的应答
     ============================================================ */
  answerPermission(action) {
    const m = get().modal;
    if (!m || m.kind !== 'permission') return;
    // 关闭模态即视觉上完成；显示层的权限记录等运行时回执（permission event）
    set({ modal: null });
    busSend({ type: 'permission_response', id: m.req.id, action });
  },

  answerQuestion(action, selected, text) {
    const m = get().modal;
    if (!m || m.kind !== 'question') return;
    set({ modal: null });
    busSend({
      type: 'question_response',
      id: m.req.id,
      action,
      selected,
      text,
    });
  },

  /* ============================================================
     会话与设置
     ============================================================ */
  switchSession(id) {
    set({ panel: null, entries: [], activeRunId: null });
    busSend({ type: 'session_switch', id });
  },

  requestSessionList() {
    set({ listedSessions: false });
    busSend({ type: 'session_list' });
  },

  setAutopilot(enabled) {
    busSend({ type: 'set_autopilot', enabled });
  },

  chooseModel(model) {
    set({ panel: null });
    busSend({ type: 'set_model', model });
  },

  chooseEffort(effort) {
    set({ panel: null });
    busSend({ type: 'set_effort', effort });
  },

  setThinking(enabled) {
    busSend({ type: 'set_thinking', enabled });
  },

  requestStreamBlock(which) {
    set({ panel: null });
    if (which === 'status') busSend({ type: 'status' });
    if (which === 'tools') busSend({ type: 'tools' });
    if (which === 'context') busSend({ type: 'context' });
    if (which === 'compact') busSend({ type: 'compact' });
  },

  refreshState() {
    busSend({ type: 'refresh_state' });
  },
}));

/* ============================================================
   ui(state) 快照落地
   侧栏自动展开规则也在这里，因为它依赖「内容从无到有」这件事
   ============================================================ */
function applyStateSnapshot(
  set: (partial: Partial<AppStore>) => void,
  get: () => AppStore,
  snap: UiStatePayload,
): void {
  const s = get();

  const hasContent: Record<SidebarBlockKey, boolean> = {
    goal: snap.goal !== null,
    tasks: snap.tasks.length > 0,
    skills: snap.skills.length > 0,
    jobs: snap.background_jobs.length > 0,
    mcp: snap.mcp.some((m) => m.state === 'running'),
  };

  const collapsed = { ...s.blockCollapsed };
  const autoExpanded = { ...s.blockAutoExpanded };
  let changed = false;

  for (const key of SIDEBAR_BLOCKS) {
    const touched = s.blockTouched[key] === true;
    if (!touched && hasContent[key] && !autoExpanded[key]) {
      collapsed[key] = false;
      autoExpanded[key] = true;
      changed = true;
    }
  }

  set({
    uiState: snap,
    status: snap.status,
    session: snap.session,
    permissionScope: snap.permission_scope,
    ...(changed ? { blockCollapsed: collapsed, blockAutoExpanded: autoExpanded } : {}),
  });
}

/* ============================================================
   选择器辅助
   ============================================================ */

export function selectEfforts(s: AppStore): EffortOption[] {
  return s.uiState?.efforts ?? [];
}

/** 状态栏左半用的阶段。运行时未就绪时强制「启动中」（§4） */
export function selectPhase(s: AppStore) {
  if (!s.ready) return 'booting' as const;
  return s.status?.phase ?? 'idle';
}
