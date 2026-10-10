'use client';

import type { SshStage, SshStatus } from '@serverdeck/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface TerminalTab {
  id: string;
  serverId: string;
  title: string;
  status: SshStatus;
  /** Progress while connecting; drives the connect animation. */
  stage: SshStage;
  message: string | null;
}

export type MainView = 'servers' | 'settings' | 'terminal';

interface UiState {
  view: MainView;
  tabs: TerminalTab[];
  activeTabId: string | null;
  /** Drawer: null = closed, 'new' = add, otherwise the server id being edited. */
  drawer: null | 'new' | { serverId: string };
  /** Shown once on the recovery-key screen, then dropped. Never persisted. */
  recoveryKey: string | null;

  showServers(): void;
  showSettings(): void;
  openTab(serverId: string, title: string): string;
  focusTab(tabId: string): void;
  closeTab(tabId: string): void;
  updateTab(tabId: string, patch: Partial<Pick<TerminalTab, 'status' | 'stage' | 'message' | 'title'>>): void;
  openDrawer(drawer: UiState['drawer']): void;
  setRecoveryKey(key: string | null): void;
  reset(): void;
}

export const useUi = create<UiState>()((set, get) => ({
  view: 'servers',
  tabs: [],
  activeTabId: null,
  drawer: null,
  recoveryKey: null,

  showServers: () => set({ view: 'servers' }),
  showSettings: () => set({ view: 'settings' }),
  openTab: (serverId, title) => {
    const id = crypto.randomUUID();
    set((s) => ({
      tabs: [...s.tabs, { id, serverId, title, status: 'connecting', stage: 'network', message: null }],
      activeTabId: id,
      view: 'terminal',
    }));
    return id;
  },
  focusTab: (tabId) => set({ activeTabId: tabId, view: 'terminal' }),
  closeTab: (tabId) => {
    const { tabs, activeTabId, view } = get();
    const index = tabs.findIndex((t) => t.id === tabId);
    const rest = tabs.filter((t) => t.id !== tabId);
    if (activeTabId !== tabId) return set({ tabs: rest });
    // Focus the neighbour, or go back to the server list.
    const next = rest[Math.min(index, rest.length - 1)];
    set({
      tabs: rest,
      activeTabId: next?.id ?? null,
      view: next ? view : 'servers',
    });
  },
  updateTab: (tabId, patch) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)) })),
  openDrawer: (drawer) => set({ drawer }),
  setRecoveryKey: (recoveryKey) => set({ recoveryKey }),
  reset: () =>
    set({ view: 'servers', tabs: [], activeTabId: null, drawer: null, recoveryKey: null }),
}));

export type ThemePref = 'system' | 'dark' | 'light';
export type SortOrder = 'name' | 'recent';

interface PrefsState {
  theme: ThemePref;
  terminalFontSize: number;
  sort: SortOrder;
  setTheme(theme: ThemePref): void;
  setTerminalFontSize(size: number): void;
  setSort(sort: SortOrder): void;
}

/** Per-device preferences (localStorage is fine: losing them is harmless). */
export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      theme: 'dark',
      terminalFontSize: 13,
      sort: 'name',
      setTheme: (theme) => set({ theme }),
      setTerminalFontSize: (terminalFontSize) =>
        set({ terminalFontSize: Math.min(24, Math.max(10, terminalFontSize)) }),
      setSort: (sort) => set({ sort }),
    }),
    { name: 'serverdeck-prefs' },
  ),
);
