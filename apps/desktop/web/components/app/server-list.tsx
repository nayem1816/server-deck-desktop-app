'use client';

import type { ServerView } from '@serverdeck/shared';
import {
  CircleAlert,
  Copy,
  KeyRound,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  ServerOff,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/menu';
import { Kbd, Segmented, Skeleton } from '@/components/ui/misc';
import { errorMessage, isMac } from '@/lib/desktop';
import { useServerAction, useServers } from '@/lib/queries';
import { usePrefs, useUi, type SortOrder } from '@/lib/store';
import { address, cn, timeAgo } from '@/lib/utils';

export const FOCUS_SEARCH_EVENT = 'serverdeck:focus-search';

function matches(server: ServerView, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    server.name.toLowerCase().includes(q) ||
    server.host.toLowerCase().includes(q) ||
    server.tags.some((t) => t.toLowerCase().includes(q))
  );
}

function sortServers(servers: ServerView[], order: SortOrder): ServerView[] {
  const byName = (a: ServerView, b: ServerView) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  return [...servers].sort((a, b) => {
    if (order === 'name') return byName(a, b);
    const at = a.lastConnectedAt ? Date.parse(a.lastConnectedAt) : 0;
    const bt = b.lastConnectedAt ? Date.parse(b.lastConnectedAt) : 0;
    return bt - at || byName(a, b);
  });
}

function ServerCard({
  server,
  onConnect,
  onDelete,
}: {
  server: ServerView;
  onConnect: () => void;
  onDelete: () => void;
}) {
  const openDrawer = useUi((s) => s.openDrawer);
  const action = useServerAction();

  async function duplicate() {
    try {
      await action.mutateAsync({ action: 'duplicate', id: server.id });
      toast.success(`Duplicated ${server.name}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <article
      className="group relative flex flex-col gap-3 rounded-card border border-line bg-surface p-4 transition-colors duration-150 hover:border-muted/40"
      onDoubleClick={onConnect}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-body font-semibold" title={server.name}>
            {server.name}
          </h3>
          <p className="selectable truncate font-mono text-caption text-muted" title={address(server)}>
            {address(server)}
          </p>
        </div>
        <span
          className="mt-0.5 text-muted"
          title={server.authType === 'key' ? 'SSH key' : 'Password'}
          aria-label={server.authType === 'key' ? 'SSH key' : 'Password'}
        >
          {server.authType === 'key' ? <KeyRound className="size-4" /> : <Lock className="size-4" />}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="-mr-1.5 -mt-1" aria-label={`Actions for ${server.name}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={onConnect}>
              <Terminal /> Connect
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openDrawer({ serverId: server.id })}>
              <Pencil /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void duplicate()}>
              <Copy /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem danger onSelect={onDelete}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {server.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {server.tags.map((tag) => (
            <span key={tag} className="rounded-control bg-hover px-1.5 py-0.5 text-caption text-muted">
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-auto flex h-7 items-center justify-between gap-2">
        {server.hasSecret ? (
          <span className="text-caption text-muted">
            {server.lastConnectedAt ? `Connected ${timeAgo(server.lastConnectedAt)}` : 'Never connected'}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => openDrawer({ serverId: server.id })}
            className="flex items-center gap-1 text-caption text-warning hover:underline"
          >
            <CircleAlert className="size-3.5" />
            {server.authType === 'key' ? 'Add the private key' : 'Add the password'}
          </button>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={onConnect}
          className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
        >
          <Terminal />
          Connect
        </Button>
      </div>
    </article>
  );
}

function LoadingGrid() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3" aria-busy aria-label="Loading servers">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="mt-3 h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-line px-6 py-16 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-hover text-muted [&_svg]:size-5">
        {icon}
      </span>
      <div>
        <h2 className="text-title font-semibold">{title}</h2>
        <p className="mt-1 max-w-sm text-body text-muted">{body}</p>
      </div>
      {action}
    </div>
  );
}

export function ServerList({ onConnect }: { onConnect: (server: ServerView) => void }) {
  const servers = useServers();
  const openDrawer = useUi((s) => s.openDrawer);
  const { sort, setSort } = usePrefs();
  const action = useServerAction();
  const [query, setQuery] = useState('');
  const [toDelete, setToDelete] = useState<ServerView | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const mod = isMac() ? '⌘' : 'Ctrl';

  useEffect(() => {
    const focus = () => searchRef.current?.focus();
    window.addEventListener(FOCUS_SEARCH_EVENT, focus);
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, focus);
  }, []);

  const visible = useMemo(
    () => sortServers((servers.data ?? []).filter((s) => matches(s, query.trim())), sort),
    [servers.data, query, sort],
  );

  async function confirmDelete() {
    const server = toDelete;
    if (!server) return;
    setToDelete(null);
    try {
      await action.mutateAsync({ action: 'remove', id: server.id });
      toast(`Deleted ${server.name}`, {
        duration: 5000,
        action: {
          label: 'Undo',
          onClick: () => {
            action.mutate({ action: 'restore', id: server.id });
          },
        },
      });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  let body: React.ReactNode;
  if (servers.isPending) {
    body = <LoadingGrid />;
  } else if (servers.isError) {
    body = (
      <EmptyState
        icon={<CircleAlert />}
        title="Couldn't load your servers"
        body={`${errorMessage(servers.error)} If this keeps happening, restart ServerDeck.`}
        action={<Button onClick={() => void servers.refetch()}>Try again</Button>}
      />
    );
  } else if ((servers.data ?? []).length === 0) {
    body = (
      <EmptyState
        icon={<ServerOff />}
        title="No servers yet"
        body="Add a server with its address and a password or SSH key. It will be on every device you log in on."
        action={
          <Button variant="primary" onClick={() => openDrawer('new')}>
            <Plus /> Add server
          </Button>
        }
      />
    );
  } else if (visible.length === 0) {
    body = (
      <EmptyState
        icon={<Search />}
        title="No matches"
        body={`No server name, host or tag contains “${query.trim()}”.`}
        action={<Button onClick={() => setQuery('')}>Clear search</Button>}
      />
    );
  } else {
    body = (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {visible.map((server) => (
          <ServerCard
            key={server.id}
            server={server}
            onConnect={() => onConnect(server)}
            onDelete={() => setToDelete(server)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 px-6 pb-4 pt-5">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder="Search name, host or tag"
            aria-label="Search servers"
            className="pl-8 pr-14"
          />
          {query ? (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-fg"
              aria-label="Clear search"
            >
              <X className="size-4" />
            </button>
          ) : (
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
              <Kbd>{mod} K</Kbd>
            </span>
          )}
        </div>
        <div className="w-52">
          <Segmented<SortOrder>
            label="Sort servers"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'name', label: 'Name' },
              { value: 'recent', label: 'Last connected' },
            ]}
          />
        </div>
        <Button variant="primary" className="ml-auto" onClick={() => openDrawer('new')} title={`${mod}+N`}>
          <Plus /> Add server
        </Button>
      </div>
      <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 pb-6')}>{body}</div>

      <Dialog open={toDelete !== null} onOpenChange={(open) => !open && setToDelete(null)}>
        <DialogContent
          title={`Delete ${toDelete?.name ?? 'server'}?`}
          description="It moves to the trash on all your devices. You can restore it from Settings for 30 days."
          footer={
            <>
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button variant="danger" onClick={() => void confirmDelete()}>
                Delete
              </Button>
            </>
          }
        />
      </Dialog>
    </div>
  );
}
