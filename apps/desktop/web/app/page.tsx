'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { hasBridge } from '@/lib/desktop';
import { useSession } from '@/lib/queries';
import { SessionGate } from '@/components/auth/auth-shell';

/** Entry point: send the user to the workspace or the login screen. */
export default function Home() {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!hasBridge() || session.isPending) return;
    router.replace(session.data ? '/deck' : '/login');
  }, [session.isPending, session.data, router]);

  // Shows the "open the desktop app" card when there's no bridge.
  return <SessionGate require="signed-in">{null}</SessionGate>;
}
