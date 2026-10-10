'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { hasBridge } from '@/lib/desktop';
import { useSession } from '@/lib/queries';
import { useUi } from '@/lib/store';

export function Logo() {
  return (
    <div className="flex items-center gap-2">
      <img src="/icon.png" alt="" width={28} height={28} className="size-7" draggable={false} />
      <span className="text-title font-semibold tracking-tight">ServerDeck</span>
    </div>
  );
}

/** Centered 400 px card (spec section 8). */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-[400px] animate-fade-in">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-card border border-line bg-surface p-6">
          <h1 className="text-title font-semibold">{title}</h1>
          {subtitle ? <p className="mt-1 text-body text-muted">{subtitle}</p> : null}
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </main>
  );
}

/** Shown until the app has loaded, so the window is never just blank. Part of the static HTML. */
function Splash() {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-4" aria-busy>
      <Logo />
      <span className="size-5 animate-spin rounded-full border-2 border-line border-t-accent" aria-label="Loading" />
    </main>
  );
}

function NoBridge() {
  return (
    <AuthCard title="Open the desktop app" subtitle="ServerDeck runs inside its desktop app, which makes the SSH connections from your computer.">
      <p className="text-body text-muted">
        Start it with <code className="font-mono text-fg">pnpm dev</code> in <code className="font-mono text-fg">apps/desktop</code>.
      </p>
    </AuthCard>
  );
}

/**
 * Renders children only when the session matches `require`; otherwise redirects.
 * Static export renders without window, so everything waits for the client.
 */
export function SessionGate({
  require,
  children,
}: {
  require: 'signed-in' | 'signed-out';
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const bridge = mounted && hasBridge();
  const session = useSession();
  const router = useRouter();
  const signedIn = Boolean(session.data);
  // Right after sign-up or a reset, the new recovery key must be shown before anything else.
  const pendingRecoveryKey = useUi((s) => s.recoveryKey !== null);

  useEffect(() => {
    if (!bridge || session.isPending) return;
    if (require === 'signed-in' && !signedIn) router.replace('/login');
    if (require === 'signed-out' && signedIn) {
      router.replace(pendingRecoveryKey ? '/recovery-key' : '/deck');
    }
  }, [bridge, session.isPending, signedIn, require, router, pendingRecoveryKey]);

  if (!mounted) return <Splash />;
  if (!bridge) return <NoBridge />;
  if (session.isPending) return <Splash />;
  if ((require === 'signed-in') !== signedIn) return null;
  return <>{children}</>;
}
