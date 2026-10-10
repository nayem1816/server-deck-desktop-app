'use client';

import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { api } from '@/lib/desktop';
import { keys } from '@/lib/queries';
import { usePrefs } from '@/lib/store';

/** Pushes main-process events into the query cache. */
function EventBridge() {
  const client = useQueryClient();
  useEffect(() => {
    const offs = [
      api.on('servers:changed', () => {
        void client.invalidateQueries({ queryKey: keys.servers });
        void client.invalidateQueries({ queryKey: keys.trash });
      }),
      api.on('sync:state', (state) => client.setQueryData(keys.sync, state)),
      api.on('auth:signed-out', () => client.setQueryData(keys.session, null)),
    ];
    return () => offs.forEach((off) => off());
  }, [client]);
  return null;
}

function ThemeSync() {
  const theme = usePrefs((s) => s.theme);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const resolved = theme === 'system' ? (media.matches ? 'light' : 'dark') : theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // Data comes from the local database over IPC: cheap, and pushed via events.
          queries: { staleTime: Infinity, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );
  const theme = usePrefs((s) => s.theme);

  return (
    <QueryClientProvider client={client}>
      <EventBridge />
      <ThemeSync />
      {children}
      <Toaster
        position="bottom-right"
        theme={theme === 'light' ? 'light' : theme === 'dark' ? 'dark' : 'system'}
        toastOptions={{
          style: {
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            fontSize: '13px',
          },
        }}
      />
    </QueryClientProvider>
  );
}
