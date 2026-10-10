'use client';

import { Check, Copy, Download, ShieldAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AuthCard, SessionGate } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/misc';
import { api } from '@/lib/desktop';
import { useSession } from '@/lib/queries';
import { useUi } from '@/lib/store';

function RecoveryKey() {
  const router = useRouter();
  const recoveryKey = useUi((s) => s.recoveryKey);
  const setRecoveryKey = useUi((s) => s.setRecoveryKey);
  const email = useSession().data?.user.email ?? '';
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!recoveryKey) router.replace('/deck');
  }, [recoveryKey, router]);
  if (!recoveryKey) return null;

  async function copy() {
    await api.clipboard.writeText(recoveryKey!);
    setCopied(true);
    toast.success('Recovery key copied');
    setTimeout(() => setCopied(false), 2000);
  }

  function download() {
    const text =
      `ServerDeck recovery key\n\nAccount: ${email}\nRecovery key: ${recoveryKey}\n\n` +
      `Keep this somewhere safe. If you forget your password, this key is the only way\n` +
      `to keep your saved server passwords and SSH keys.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'serverdeck-recovery-key.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  function finish() {
    setRecoveryKey(null);
    router.replace('/deck');
  }

  return (
    <AuthCard
      title="Save your recovery key"
      subtitle="If you forget your password, this key is the only way to keep your saved server passwords and SSH keys. We can't show it again."
    >
      <div className="flex flex-col gap-4">
        <div className="selectable rounded-card border border-line bg-app px-4 py-3 text-center font-mono text-[15px] leading-7 tracking-wide">
          {/* Two lines of four groups, so it never wraps mid-group. */}
          <span className="block">{recoveryKey.split('-').slice(0, 4).join('-')}-</span>
          <span className="block">{recoveryKey.split('-').slice(4).join('-')}</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={copy}>
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button onClick={download}>
            <Download />
            Download
          </Button>
        </div>
        <div className="flex gap-2 rounded-control bg-warning-soft px-3 py-2 text-body">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>Store it outside this computer, e.g. in a password manager or on paper.</span>
        </div>
        <Checkbox id="saved" checked={saved} onChange={setSaved}>
          I saved my recovery key
        </Checkbox>
        <Button variant="primary" size="lg" disabled={!saved} onClick={finish}>
          Continue
        </Button>
      </div>
    </AuthCard>
  );
}

export default function RecoveryKeyPage() {
  return (
    <SessionGate require="signed-in">
      <RecoveryKey />
    </SessionGate>
  );
}
