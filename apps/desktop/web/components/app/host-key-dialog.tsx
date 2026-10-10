'use client';

import type { HostKeyPrompt } from '@serverdeck/shared';
import { ShieldAlert, ShieldQuestion } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { api } from '@/lib/desktop';

/** Accept / Cancel for unknown or changed host keys (spec 4.3). Prompts queue up. */
export function HostKeyDialog() {
  const [queue, setQueue] = useState<HostKeyPrompt[]>([]);
  const prompt = queue[0];

  useEffect(
    () => api.on('ssh:host-key', (p) => setQueue((q) => [...q, p])),
    [],
  );

  const answer = (accept: boolean) => {
    if (!prompt) return;
    api.ssh.answerHostKey(prompt.tabId, accept);
    setQueue((q) => q.slice(1));
  };

  const changed = prompt?.previousFingerprint !== null && prompt?.previousFingerprint !== undefined;

  return (
    <Dialog open={prompt !== undefined} onOpenChange={(open) => !open && answer(false)}>
      {prompt ? (
        <DialogContent
          title={changed ? 'Warning: host key changed' : 'Trust this server?'}
          description={
            changed
              ? `The key of ${prompt.host} is different from the one saved earlier. This happens when a server is reinstalled — or when someone is intercepting the connection. Only accept if you know why it changed.`
              : `This is the first connection to ${prompt.host}. Check that the fingerprint matches the server's before you accept.`
          }
          footer={
            <>
              <Button onClick={() => answer(false)} autoFocus>
                Cancel
              </Button>
              <Button variant={changed ? 'danger' : 'primary'} onClick={() => answer(true)}>
                {changed ? 'Accept new key' : 'Accept'}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            {changed ? (
              <div className="flex gap-2 rounded-control border border-danger/40 bg-danger-soft p-3">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-danger" />
                <div className="min-w-0 text-caption">
                  <p className="text-muted">Saved key</p>
                  <p className="selectable break-all font-mono text-fg line-through decoration-danger/60">
                    {prompt.previousFingerprint}
                  </p>
                </div>
              </div>
            ) : null}
            <div className="flex gap-2 rounded-control border border-line bg-app p-3">
              <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-muted" />
              <div className="min-w-0 text-caption">
                <p className="text-muted">{changed ? 'New key' : 'Fingerprint'}</p>
                <p className="selectable break-all font-mono text-fg">{prompt.fingerprint}</p>
              </div>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
