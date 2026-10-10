'use client';

import type { ServerView } from '@serverdeck/shared';
import { useEffect } from 'react';
import { SessionGate } from '@/components/auth/auth-shell';
import { ServerDrawer } from '@/components/app/server-drawer';
import { HostKeyDialog } from '@/components/app/host-key-dialog';
import { FOCUS_SEARCH_EVENT, ServerList } from '@/components/app/server-list';
import { SettingsView } from '@/components/app/settings-view';
import { Sidebar } from '@/components/app/sidebar';
import { TabStrip } from '@/components/app/tab-strip';
import { TerminalPane } from '@/components/app/terminal-pane';
import { api, isMac } from '@/lib/desktop';
import { useUi, type TerminalTab } from '@/lib/store';

function Workspace() {
  const { view, tabs, activeTabId, openTab, closeTab, openDrawer, showServers } = useUi();

  const connect = (server: ServerView) => {
    if (!server.hasSecret) {
      openDrawer({ serverId: server.id });
      return;
    }
    openTab(server.id, server.name);
  };

  const close = (tab: TerminalTab) => {
    void api.ssh.disconnect(tab.id).catch(() => undefined);
    closeTab(tab.id);
  };

  // Keyboard shortcuts (spec section 8).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      // In a terminal on Windows/Linux, Ctrl+K/N/W belong to the shell (kill line, next
      // history, delete word); Ctrl+Shift+K/N/W does the app action there (D-027).
      const inTerminal = Boolean(document.activeElement?.closest('.xterm'));
      if (inTerminal && !isMac() && !e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        e.stopPropagation();
        showServers();
        requestAnimationFrame(() => window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT)));
      } else if (key === 'n') {
        e.preventDefault();
        e.stopPropagation();
        openDrawer('new');
      } else if (key === 'w') {
        e.preventDefault();
        e.stopPropagation();
        const { view: v, activeTabId: id, tabs: open } = useUi.getState();
        const tab = v === 'terminal' ? open.find((t) => t.id === id) : undefined;
        if (tab) close(tab);
      }
    };
    // Capture phase, so shortcuts work while the terminal has focus.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store actions are stable
  }, []);

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TabStrip onClose={close} />
        <main className="relative min-h-0 flex-1 overflow-hidden">
          {view === 'servers' ? <ServerList onConnect={connect} /> : null}
          {view === 'settings' ? <SettingsView /> : null}
          {/* Terminals stay mounted while hidden so sessions survive tab switches (D-018). */}
          {tabs.map((tab) => (
            <TerminalPane key={tab.id} tab={tab} visible={view === 'terminal' && tab.id === activeTabId} />
          ))}
        </main>
      </div>
      <ServerDrawer />
      <HostKeyDialog />
    </div>
  );
}

export default function DeckPage() {
  return (
    <SessionGate require="signed-in">
      <Workspace />
    </SessionGate>
  );
}
