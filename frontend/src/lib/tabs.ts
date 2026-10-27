// 열린 탭·최근 문서·AI 패널 상태.
// 화면 상태는 브라우저(localStorage)에 두고, 문서 내용은 서버 문서(id)와 디스크 파일(path)에 있다.
import { useSyncExternalStore } from "react";
import type { DocFormat } from "./api";

export type Tab = { id: string; title: string; filename: string; format: DocFormat; path?: string; dirty: boolean };
export type RecentEntry = { id: string; title: string; filename: string; format: DocFormat; path?: string; at: number };
export type WorkspaceState = { tabs: Tab[]; activeId: string | null; recent: RecentEntry[]; aiOpen: boolean };

export const EMPTY: WorkspaceState = { tabs: [], activeId: null, recent: [], aiOpen: true };
const KEY = "coredotdocs.workspace";
export const RECENT_MAX = 20;

// 순수 전이 함수 (테스트 대상) -------------------------------------------------

export function reduceOpen(state: WorkspaceState, tab: Omit<Tab, "dirty"> & { dirty?: boolean }): WorkspaceState {
  const existing = state.tabs.find((t) => t.id === tab.id);
  const tabs = existing ? state.tabs.map((t) => (t.id === tab.id ? { ...t, ...tab, dirty: t.dirty } : t)) : [...state.tabs, { dirty: false, ...tab }];
  return { ...state, tabs, activeId: tab.id, recent: pushRecent(state.recent, { ...tab, at: Date.now() }) };
}

export function reduceClose(state: WorkspaceState, id: string): WorkspaceState {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  let activeId = state.activeId;
  if (activeId === id) activeId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
  return { ...state, tabs, activeId };
}

export function reduceUpdate(state: WorkspaceState, id: string, patch: Partial<Tab>): WorkspaceState {
  const tabs = state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t));
  const changed = tabs.find((t) => t.id === id);
  const recent = changed && (patch.path || patch.title || patch.filename) ? state.recent.map((r) => (r.id === id ? { ...r, title: changed.title, filename: changed.filename, path: changed.path } : r)) : state.recent;
  return { ...state, tabs, recent };
}

export function pushRecent(list: RecentEntry[], entry: Omit<RecentEntry, "at"> & { at?: number }): RecentEntry[] {
  const at = entry.at ?? Date.now();
  const rest = list.filter((r) => r.id !== entry.id && !(entry.path && r.path === entry.path));
  return [{ id: entry.id, title: entry.title, filename: entry.filename, format: entry.format, path: entry.path, at }, ...rest].slice(0, RECENT_MAX);
}

/** 퍼센트 인코딩된 채 들어온 파일 이름(예: Core.Inspect_%EC%9A%B8…)을 화면에 보일 때만 풀어 쓴다 */
export function readableTitle(title: string): string {
  if (!/%[0-9a-f]{2}/i.test(title)) return title;
  try {
    return decodeURIComponent(title);
  } catch {
    return title;
  }
}

// 저장소 ----------------------------------------------------------------------

let state: WorkspaceState = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

function load(): WorkspaceState {
  if (loaded) return state;
  loaded = true;
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WorkspaceState>;
      state = {
        tabs: (parsed.tabs ?? []).map((t) => ({ ...t, dirty: t.dirty === true })), // 서버 리비전 복구는 디스크 저장이 아니다. 다시 열어도 저장 안 됨을 유지한다.
        activeId: parsed.activeId ?? null,
        recent: parsed.recent ?? [],
        aiOpen: parsed.aiOpen ?? true,
      };
      if (state.activeId && !state.tabs.some((t) => t.id === state.activeId)) state.activeId = state.tabs[0]?.id ?? null;
    }
  } catch {
    state = EMPTY;
  }
  return state;
}

function set(next: WorkspaceState) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify({ tabs: next.tabs, activeId: next.activeId, recent: next.recent, aiOpen: next.aiOpen }));
  } catch {}
  listeners.forEach((l) => l());
}

export const workspace = {
  get: (): WorkspaceState => load(),
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  open: (tab: Omit<Tab, "dirty"> & { dirty?: boolean }) => set(reduceOpen(load(), tab)),
  close: (id: string) => set(reduceClose(load(), id)),
  activate: (id: string) => set({ ...load(), activeId: id }),
  update: (id: string, patch: Partial<Tab>) => set(reduceUpdate(load(), id, patch)),
  setAiOpen: (aiOpen: boolean) => set({ ...load(), aiOpen }),
  removeRecent: (id: string) => set({ ...load(), recent: load().recent.filter((r) => r.id !== id) }),
  clearRecent: () => set({ ...load(), recent: [] }),
  /** 테스트용 초기화 */
  reset: () => {
    loaded = false;
    state = EMPTY;
    try {
      localStorage.removeItem(KEY);
    } catch {}
    listeners.forEach((l) => l());
  },
};

export function useWorkspace(): WorkspaceState {
  return useSyncExternalStore(workspace.subscribe, workspace.get, () => EMPTY);
}
