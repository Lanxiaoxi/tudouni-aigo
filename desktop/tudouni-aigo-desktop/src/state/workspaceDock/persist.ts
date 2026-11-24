/**
 * Where the per-workspace UI state is kept between launches.
 *
 * Its own `localStorage` record rather than a field of `aigo.prefs`: that one
 * is the *window's* presentation and is rewritten on every rail drag, while
 * this one is rewritten on every folder the person opens. Keeping them apart
 * means neither write amplifies the other, and a corrupted record here costs a
 * forgotten file tree, never a lost layout.
 */
import { sanitizeWorkspaceUiMap, type WorkspaceUiState } from './uiState';

export const WORKSPACE_UI_STORAGE_KEY = 'aigo.workspaceDock.ui';

export function loadWorkspaceUi(): Record<string, WorkspaceUiState> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(WORKSPACE_UI_STORAGE_KEY);
    return raw ? sanitizeWorkspaceUiMap(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function saveWorkspaceUi(map: Record<string, WorkspaceUiState>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(WORKSPACE_UI_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* Private mode or a full quota: the state simply does not persist. */
  }
}
