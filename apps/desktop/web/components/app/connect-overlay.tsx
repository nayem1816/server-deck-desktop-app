'use client';

import type { SshStage } from '@serverdeck/shared';
import { Check, Laptop, Loader2, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useServer } from '@/lib/queries';
import type { TerminalTab } from '@/lib/store';
import { cn } from '@/lib/utils';

const STAGES: SshStage[] = ['network', 'verify', 'auth', 'shell'];
/** Each step stays on screen at least this long, so a fast connect still reads step by step. */
const STEP_MS = 450;
/** How long the finished state stays up before fading into the terminal. */
const DONE_HOLD_MS = 650;
/** Matches the opacity transition below. */
const FADE_MS = 240;

type Phase = 'active' | 'done' | 'leaving' | 'hidden';

function stageLabel(stage: SshStage, server: { username: string; host: string; port: number } | undefined) {
  switch (stage) {
    case 'network':
      return server ? `Reaching ${server.host}:${server.port}` : 'Reaching the server';
    case 'verify':
      return 'Verifying host key';
    case 'auth':
      return server ? `Logging in as ${server.username}` : 'Logging in';
    case 'shell':
      return 'Opening shell';
  }
}

/**
 * Full-pane animation shown while a tab connects. Steps follow real progress from the main
 * process (ssh:status stages), then it holds a "connected" state briefly and fades into the terminal.
 */
export function ConnectOverlay({ tab, onCancel }: { tab: TerminalTab; onCancel: () => void }) {
  const server = useServer(tab.serverId);
  const [phase, setPhase] = useState<Phase>(tab.status === 'connecting' ? 'active' : 'hidden');
  /** Step shown on screen. Trails the real stage by at most one step every STEP_MS. */
  const [shown, setShown] = useState(0);

  // Where the real connection is: 0–3 while connecting, 4 once the shell is open.
  const target = tab.status === 'connected' ? STAGES.length : Math.max(0, STAGES.indexOf(tab.stage));

  useEffect(() => {
    if (tab.status === 'connecting') {
      setPhase((p) => {
        // A fresh attempt (reconnect) starts the steps over.
        if (p !== 'active') setShown(0);
        return 'active';
      });
    } else if (tab.status !== 'connected') {
      // Failed: the error banner takes over.
      setPhase('hidden');
    }
  }, [tab.status]);

  // Advance one step at a time towards the real stage.
  useEffect(() => {
    if (phase !== 'active' || shown >= target) return;
    const id = setTimeout(() => setShown((n) => n + 1), STEP_MS);
    return () => clearTimeout(id);
  }, [phase, shown, target]);

  // All steps shown and the shell is open: show "Connected", then fade out.
  useEffect(() => {
    if (phase === 'active' && tab.status === 'connected' && shown >= STAGES.length) setPhase('done');
  }, [phase, shown, tab.status]);

  useEffect(() => {
    if (phase === 'done') {
      const id = setTimeout(() => setPhase('leaving'), DONE_HOLD_MS);
      return () => clearTimeout(id);
    }
    if (phase === 'leaving') {
      const id = setTimeout(() => setPhase('hidden'), FADE_MS);
      return () => clearTimeout(id);
    }
  }, [phase]);

  if (phase === 'hidden') return null;

  const done = phase !== 'active';
  const current = done ? STAGES.length : Math.min(shown, STAGES.length - 1);
  const progress = done ? 100 : ((current + 0.5) / STAGES.length) * 100;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={done ? `Connected to ${tab.title}` : `Connecting to ${tab.title}`}
      className={cn(
        'absolute inset-0 z-10 flex items-center justify-center bg-terminal transition-opacity duration-[240ms] ease-out',
        phase === 'leaving' ? 'opacity-0' : 'animate-fade-in opacity-100',
      )}
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-6 px-6">
        {/* This PC → server, with packets on the line. */}
        <div className="flex w-full items-center gap-3" aria-hidden>
          <div className="flex size-12 shrink-0 items-center justify-center rounded-card border border-line bg-surface text-muted">
            <Laptop className="size-5" />
          </div>

          <div className="relative h-0.5 flex-1 rounded-full bg-line">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-[450ms] ease-in-out"
              style={{ width: `${progress}%` }}
            />
            {!done
              ? [0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="absolute top-1/2 size-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]"
                    style={{ animation: `packet 1.4s ${i * 0.45}s ease-in-out infinite` }}
                  />
                ))
              : null}
          </div>

          <div className="relative flex size-12 shrink-0 items-center justify-center">
            {!done && current >= 2 ? (
              <span
                className="absolute inset-0 rounded-card border border-accent"
                style={{ animation: 'ring 1.2s ease-out infinite' }}
              />
            ) : null}
            <div
              className={cn(
                'relative flex size-12 items-center justify-center rounded-card border transition-colors duration-[240ms]',
                done ? 'border-accent bg-accent text-accent-contrast' : 'border-line bg-surface text-fg',
              )}
            >
              {done ? (
                <Check className="size-6" strokeWidth={3} style={{ animation: 'pop 320ms ease-out both' }} />
              ) : (
                <Server className="size-5" />
              )}
            </div>
          </div>
        </div>

        <div className="text-center">
          <p className="text-title font-semibold">{done ? 'Connected' : `Connecting to ${tab.title}`}</p>
          {server ? (
            <p className="mt-0.5 font-mono text-caption text-muted">
              {server.username}@{server.host}:{server.port}
            </p>
          ) : null}
        </div>

        <ol className="flex w-full flex-col gap-2 rounded-card border border-line bg-surface p-3">
          {STAGES.map((stage, i) => {
            const state = i < current ? 'done' : i === current ? 'active' : 'pending';
            return (
              <li key={stage} className="flex items-center gap-2.5 text-body">
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {state === 'done' ? (
                    <Check className="size-4 text-accent" style={{ animation: 'pop 240ms ease-out both' }} />
                  ) : state === 'active' ? (
                    <Loader2 className="size-4 animate-spin text-accent" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-line" />
                  )}
                </span>
                <span
                  className={cn(
                    'truncate transition-colors duration-150',
                    state === 'pending' ? 'text-muted' : 'text-fg',
                    state === 'active' && 'font-medium',
                  )}
                >
                  {stageLabel(stage, server)}
                </span>
              </li>
            );
          })}
        </ol>

        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          className={cn('transition-opacity duration-150', done && 'pointer-events-none opacity-0')}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
