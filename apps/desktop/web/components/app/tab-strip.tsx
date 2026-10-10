'use client';

import { LayoutGrid, X } from 'lucide-react';
import { StatusDot } from '@/components/ui/misc';
import { useUi, type TerminalTab } from '@/lib/store';
import { cn } from '@/lib/utils';

const TONE = {
  connected: 'ok',
  connecting: 'busy',
  disconnected: 'bad',
  error: 'bad',
} as const;

/** Servers tab + one tab per connection, with status dots (spec 4.3). */
export function TabStrip({ onClose }: { onClose: (tab: TerminalTab) => void }) {
  const { view, tabs, activeTabId, showServers, focusTab } = useUi();

  return (
    <div role="tablist" aria-label="Open sessions" className="flex h-10 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-line bg-surface px-2">
      <button
        role="tab"
        aria-selected={view === 'servers'}
        onClick={showServers}
        className={cn(
          'flex h-8 items-center gap-2 rounded-t-control px-3 text-body transition-colors duration-150',
          view === 'servers' ? 'bg-app font-medium text-fg' : 'text-muted hover:text-fg',
        )}
      >
        <LayoutGrid className="size-4" />
        Servers
      </button>
      {tabs.map((tab) => {
        const active = view === 'terminal' && tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={cn(
              'group flex h-8 max-w-[220px] items-center gap-2 rounded-t-control pl-3 pr-1 text-body transition-colors duration-150',
              active ? 'bg-terminal text-fg' : 'text-muted hover:text-fg',
            )}
          >
            <button
              role="tab"
              aria-selected={active}
              onClick={() => focusTab(tab.id)}
              onAuxClick={(e) => e.button === 1 && onClose(tab)}
              className="flex min-w-0 items-center gap-2"
              title={tab.message ?? tab.title}
            >
              <StatusDot tone={TONE[tab.status]} className={tab.status === 'connecting' ? 'animate-pulse' : undefined} />
              <span className="truncate">{tab.title}</span>
              <span className="sr-only">({tab.status})</span>
            </button>
            <button
              onClick={() => onClose(tab)}
              className="flex size-6 items-center justify-center rounded-control text-muted opacity-60 hover:bg-hover hover:text-fg group-hover:opacity-100"
              aria-label={`Close ${tab.title}`}
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
