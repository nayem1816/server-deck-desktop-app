'use client';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import { RotateCw, Unplug } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { ConnectOverlay } from '@/components/app/connect-overlay';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/desktop';
import { usePrefs, useUi, type TerminalTab } from '@/lib/store';
import { cn } from '@/lib/utils';

function terminalTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v('--terminal-bg'),
    foreground: v('--terminal-fg'),
    cursor: v('--terminal-cursor'),
    cursorAccent: v('--terminal-bg'),
    selectionBackground: v('--terminal-selection'),
    black: v('--ansi-black'),
    red: v('--ansi-red'),
    green: v('--ansi-green'),
    yellow: v('--ansi-yellow'),
    blue: v('--ansi-blue'),
    magenta: v('--ansi-magenta'),
    cyan: v('--ansi-cyan'),
    white: v('--ansi-white'),
    brightBlack: v('--ansi-bright-black'),
    brightRed: v('--ansi-bright-red'),
    brightGreen: v('--ansi-bright-green'),
    brightYellow: v('--ansi-bright-yellow'),
    brightBlue: v('--ansi-bright-blue'),
    brightMagenta: v('--ansi-bright-magenta'),
    brightCyan: v('--ansi-bright-cyan'),
    brightWhite: v('--ansi-bright-white'),
  };
}

/** One SSH session in xterm.js. Stays mounted while hidden so the session survives (D-018). */
export function TerminalPane({ tab, visible }: { tab: TerminalTab; visible: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const updateTab = useUi((s) => s.updateTab);
  const closeTab = useUi((s) => s.closeTab);
  const fontSize = usePrefs((s) => s.terminalFontSize);
  const theme = usePrefs((s) => s.theme);

  const connect = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    updateTab(tab.id, { status: 'connecting', stage: 'network', message: null });
    api.ssh
      .connect(tab.id, tab.serverId, { cols: term.cols, rows: term.rows })
      .catch((err: unknown) => updateTab(tab.id, { status: 'error', message: errorMessage(err) }));
  }, [tab.id, tab.serverId, updateTab]);

  // Create the terminal once per tab.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
      fontSize: usePrefs.getState().terminalFontSize,
      fontWeight: '400',
      fontWeightBold: '600',
      lineHeight: 1.25,
      // A steady thin bar reads calmer than a blinking block; outlined when the pane loses focus.
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorBlink: false,
      cursorInactiveStyle: 'outline',
      scrollback: 10_000,
      theme: terminalTheme(),
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;
    fit.fit();

    const copySelection = () => {
      const text = term.getSelection();
      if (text) void api.clipboard.writeText(text);
      return Boolean(text);
    };
    const paste = () => void api.clipboard.readText().then((text) => text && term.paste(text));

    // Ctrl+Shift+C / V everywhere; Ctrl+C copies only when text is selected (otherwise ^C).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'c' && (e.shiftKey || (term.hasSelection() && !e.altKey))) {
        copySelection();
        term.clearSelection();
        return false;
      }
      if (mod && key === 'v' && (e.shiftKey || e.metaKey)) {
        paste();
        return false;
      }
      return true;
    });
    // Right-click: copy the selection, or paste when nothing is selected.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (!copySelection()) paste();
      term.clearSelection();
    };
    container.addEventListener('contextmenu', onContextMenu);

    const offData = api.on('ssh:data', (e) => {
      if (e.tabId === tab.id) term.write(e.data);
    });
    const offStatus = api.on('ssh:status', (e) => {
      if (e.tabId !== tab.id) return;
      updateTab(tab.id, { status: e.status, message: e.message, ...(e.stage ? { stage: e.stage } : {}) });
      if (e.status === 'connected') term.focus();
      if (e.status === 'disconnected' || e.status === 'error') {
        term.write(`\r\n\x1b[2m[${e.message ?? 'Disconnected'}]\x1b[0m\r\n`);
      }
    });
    const inputSub = term.onData((data) => api.ssh.write(tab.id, data));
    const resizeSub = term.onResize(({ cols, rows }) => api.ssh.resize(tab.id, { cols, rows }));

    const observer = new ResizeObserver(() => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) fit.fit();
    });
    observer.observe(container);

    connect();

    return () => {
      observer.disconnect();
      container.removeEventListener('contextmenu', onContextMenu);
      offData();
      offStatus();
      inputSub.dispose();
      resizeSub.dispose();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one terminal per tab
  }, [tab.id]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    fitRef.current?.fit();
  }, [fontSize]);

  useEffect(() => {
    // Wait a frame for ThemeSync to switch the CSS variables.
    const id = requestAnimationFrame(() => {
      if (termRef.current) termRef.current.options.theme = terminalTheme();
    });
    return () => cancelAnimationFrame(id);
  }, [theme]);

  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible]);

  const lost = tab.status === 'disconnected' || tab.status === 'error';

  return (
    <div className={cn('absolute inset-0 flex flex-col bg-terminal', !visible && 'invisible')} aria-hidden={!visible}>
      {lost ? (
        <div role="alert" className="flex shrink-0 items-center gap-3 border-b border-line bg-danger-soft px-4 py-2 text-body">
          <Unplug className="size-4 shrink-0 text-danger" />
          <span className="min-w-0 flex-1 truncate">
            <strong className="font-medium">{tab.status === 'error' ? "Couldn't connect" : "Connection lost"}</strong>
            {tab.message ? <span className="text-muted"> — {tab.message}</span> : null}
          </span>
          <Button size="sm" variant="primary" onClick={connect}>
            <RotateCw /> Reconnect
          </Button>
        </div>
      ) : null}
      {/* Padding lives on the wrapper: FitAddon measures the terminal's parent including its
          padding, so padding there makes the terminal overflow, toggle scrollbars and resize in a
          loop (the prompt and cursor then jump on every resize). */}
      <div className="terminal-host min-h-0 flex-1 overflow-hidden py-3 pl-4 pr-1">
        <div ref={containerRef} className="h-full w-full" />
      </div>
      <ConnectOverlay
        tab={tab}
        onCancel={() => {
          void api.ssh.disconnect(tab.id);
          closeTab(tab.id);
        }}
      />
    </div>
  );
}
