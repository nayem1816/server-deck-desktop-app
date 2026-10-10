'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown, LogOut, Server, Settings } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { Logo } from '@/components/auth/auth-shell';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/menu';
import { StatusDot } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/desktop';
import { useServers, useSession, useSyncState } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { cn, timeAgo } from '@/lib/utils';

function NavItem({
  active,
  icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-8 items-center gap-2 rounded-control px-2 text-body transition-colors duration-150 [&_svg]:size-4',
        active ? 'bg-hover font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg',
      )}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {count !== undefined ? <span className="text-caption text-muted">{count}</span> : null}
    </button>
  );
}

function SyncStatus() {
  const { data: state } = useSyncState();
  if (!state || state.status === 'signed-out') return null;

  const pending = state.pendingChanges;
  const view = {
    synced: {
      tone: 'ok' as const,
      label: pending > 0 ? `${pending} change${pending === 1 ? '' : 's'} to sync` : 'Synced',
    },
    syncing: { tone: 'busy' as const, label: 'Syncing…' },
    offline: { tone: 'busy' as const, label: 'Offline — changes saved, will sync' },
    error: { tone: 'bad' as const, label: 'Sync problem — click to retry' },
  }[state.status];

  const title =
    state.status === 'error' && state.message
      ? state.message
      : state.lastSyncedAt
        ? `Last synced ${timeAgo(state.lastSyncedAt)}. Click to sync now.`
        : 'Click to sync now.';

  return (
    <button
      type="button"
      title={title}
      onClick={() => void api.sync.syncNow()}
      className="flex items-start gap-2 rounded-control px-2 py-1.5 text-left text-caption text-muted hover:bg-hover hover:text-fg"
      aria-live="polite"
    >
      <StatusDot tone={view.tone} className={cn('mt-1', state.status === 'syncing' && 'animate-pulse')} />
      <span>{view.label}</span>
    </button>
  );
}

function UserMenu() {
  const { data: session } = useSession();
  const client = useQueryClient();
  const router = useRouter();
  const showSettings = useUi((s) => s.showSettings);
  const resetUi = useUi((s) => s.reset);
  const user = session?.user;
  if (!user) return null;

  async function logout() {
    try {
      await api.auth.logout();
      resetUi();
      client.clear();
      router.replace('/login');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left hover:bg-hover">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-caption font-semibold text-accent">
          {user.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium">{user.name}</span>
          <span className="block truncate text-caption text-muted">{user.email}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-52">
        <DropdownMenuLabel>{user.email}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={showSettings}>
          <Settings /> Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void logout()}>
          <LogOut /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 220 px sidebar: navigation, sync status, user menu (spec section 8). */
export function Sidebar() {
  const view = useUi((s) => s.view);
  const showServers = useUi((s) => s.showServers);
  const showSettings = useUi((s) => s.showSettings);
  const { data: servers } = useServers();

  return (
    <aside className="flex w-[220px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-12 items-center px-4">
        <Logo />
      </div>
      <nav className="flex flex-col gap-0.5 px-2 pt-2" aria-label="Main">
        <NavItem
          active={view === 'servers'}
          icon={<Server />}
          label="Servers"
          count={servers?.length}
          onClick={showServers}
        />
        <NavItem active={view === 'settings'} icon={<Settings />} label="Settings" onClick={showSettings} />
      </nav>
      <div className="mt-auto flex flex-col gap-1 border-t border-line p-2">
        <SyncStatus />
        <UserMenu />
      </div>
    </aside>
  );
}

