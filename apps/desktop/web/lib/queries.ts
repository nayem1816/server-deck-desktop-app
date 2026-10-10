'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ServerForm, ServerView, SyncState } from '@serverdeck/shared';
import { api } from './desktop';

export const keys = {
  session: ['session'] as const,
  servers: ['servers'] as const,
  trash: ['trash'] as const,
  history: ['history'] as const,
  sync: ['sync'] as const,
};

export function useSession() {
  return useQuery({ queryKey: keys.session, queryFn: () => api.auth.getSession() });
}

export function useServers() {
  return useQuery({ queryKey: keys.servers, queryFn: () => api.servers.list() });
}

export function useTrash() {
  return useQuery({ queryKey: keys.trash, queryFn: () => api.servers.listTrash() });
}

export function useHistory(enabled: boolean) {
  return useQuery({
    queryKey: keys.history,
    queryFn: () => api.servers.listHistory(),
    enabled,
    retry: false,
  });
}

export function useSyncState() {
  return useQuery<SyncState>({ queryKey: keys.sync, queryFn: () => api.sync.getState() });
}

export function useServer(id: string | null): ServerView | undefined {
  const { data } = useServers();
  return id ? data?.find((s) => s.id === id) : undefined;
}

function useInvalidateServers() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: keys.servers });
    void client.invalidateQueries({ queryKey: keys.trash });
  };
}

export function useSaveServer() {
  const invalidate = useInvalidateServers();
  return useMutation({
    mutationFn: ({ id, form }: { id: string | null; form: ServerForm }) =>
      id ? api.servers.update(id, form) : api.servers.create(form),
    onSuccess: invalidate,
  });
}

export function useServerAction() {
  const invalidate = useInvalidateServers();
  return useMutation({
    mutationFn: async ({ action, id }: { action: 'remove' | 'restore' | 'duplicate'; id: string }) => {
      if (action === 'duplicate') await api.servers.duplicate(id);
      else if (action === 'remove') await api.servers.remove(id);
      else await api.servers.restore(id);
    },
    onSuccess: invalidate,
  });
}
