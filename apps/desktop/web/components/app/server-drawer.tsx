'use client';

import type { AuthType, ServerForm, TestConnectionResult } from '@serverdeck/shared';
import { CircleCheck, CircleX, FileKey, KeyRound, Lock, PlugZap } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, SheetContent } from '@/components/ui/dialog';
import { Field, FormError, Input, PasswordInput, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/misc';
import { api, DesktopClientError, errorMessage } from '@/lib/desktop';
import { useSaveServer, useServer } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';

interface FormState {
  name: string;
  host: string;
  port: string;
  username: string;
  authType: AuthType;
  password: string;
  privateKey: string;
  passphrase: string;
  tags: string;
  notes: string;
}

const EMPTY: FormState = {
  name: '',
  host: '',
  port: '22',
  username: '',
  authType: 'password',
  password: '',
  privateKey: '',
  passphrase: '',
  tags: '',
  notes: '',
};

function toForm(state: FormState): ServerForm {
  return {
    name: state.name,
    host: state.host,
    port: Number(state.port) || 0,
    username: state.username,
    authType: state.authType,
    password: state.authType === 'password' ? state.password || undefined : undefined,
    privateKey: state.authType === 'key' ? state.privateKey || undefined : undefined,
    passphrase: state.authType === 'key' ? state.passphrase || undefined : undefined,
    tags: state.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    notes: state.notes || undefined,
  };
}

/** Right drawer for adding or editing a server (spec 4.2). */
export function ServerDrawer() {
  const drawer = useUi((s) => s.drawer);
  const openDrawer = useUi((s) => s.openDrawer);
  const editingId = drawer && drawer !== 'new' ? drawer.serverId : null;
  const existing = useServer(editingId);
  const save = useSaveServer();

  const [state, setState] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [test, setTest] = useState<TestConnectionResult | null>(null);
  const [testing, setTesting] = useState(false);

  // Reset the form each time the drawer opens.
  useEffect(() => {
    if (!drawer) return;
    setErrors({});
    setFormError(null);
    setTest(null);
    setState(
      existing
        ? {
            ...EMPTY,
            name: existing.name,
            host: existing.host,
            port: String(existing.port),
            username: existing.username,
            authType: existing.authType,
            tags: existing.tags.join(', '),
            notes: existing.notes ?? '',
          }
        : EMPTY,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on open / target change
  }, [drawer, existing?.id]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setState((s) => ({ ...s, [key]: value }));
    setErrors((e) => ({ ...e, [key]: '' }));
    setTest(null);
  };

  const keepsSecret = existing?.authType === state.authType && existing.hasSecret;
  const keepsPassphrase = existing?.authType === 'key' && state.authType === 'key' && existing.hasPassphrase;

  function handleError(err: unknown) {
    if (err instanceof DesktopClientError && err.code === 'VALIDATION_ERROR') {
      setErrors(err.fieldErrors);
      if (Object.keys(err.fieldErrors).length === 0) setFormError(err.message);
    } else {
      setFormError(errorMessage(err));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      const saved = await save.mutateAsync({ id: editingId, form: toForm(state) });
      toast.success(editingId ? `Saved ${saved.name}` : `Added ${saved.name}`);
      openDrawer(null);
    } catch (err) {
      handleError(err);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTest(null);
    setFormError(null);
    try {
      setTest(await api.ssh.test({ form: toForm(state), serverId: editingId ?? undefined }));
    } catch (err) {
      handleError(err);
    } finally {
      setTesting(false);
    }
  }

  async function pickFile() {
    try {
      const text = await api.servers.pickKeyFile();
      if (text !== null) set('privateKey', text);
    } catch (err) {
      setErrors((e) => ({ ...e, privateKey: errorMessage(err) }));
    }
  }

  const secretPlaceholder = keepsSecret ? 'Saved — leave empty to keep' : undefined;

  return (
    <Dialog open={drawer !== null} onOpenChange={(open) => !open && openDrawer(null)}>
      {drawer ? (
        <SheetContent
          title={editingId ? 'Edit server' : 'Add server'}
          footer={
            <>
              <Button type="button" onClick={() => void testConnection()} loading={testing}>
                {!testing ? <PlugZap /> : null}
                Test connection
              </Button>
              <div className="ml-auto flex gap-2">
                <Button type="button" variant="ghost" onClick={() => openDrawer(null)}>
                  Cancel
                </Button>
                <Button type="submit" form="server-form" variant="primary" loading={save.isPending}>
                  Save
                </Button>
              </div>
            </>
          }
        >
          <form id="server-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <FormError message={formError} />
            {test ? (
              <div
                role="status"
                className={cn(
                  'flex gap-2 rounded-control px-3 py-2 text-body',
                  test.ok ? 'bg-accent-soft' : 'bg-danger-soft',
                )}
              >
                {test.ok ? (
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-accent" />
                ) : (
                  <CircleX className="mt-0.5 size-4 shrink-0 text-danger" />
                )}
                <div className="min-w-0">
                  <p>{test.message}</p>
                  {test.fingerprint ? (
                    <p className="selectable mt-0.5 break-all font-mono text-caption text-muted">{test.fingerprint}</p>
                  ) : null}
                </div>
              </div>
            ) : null}

            <Field label="Name" error={errors.name}>
              {(p) => <Input {...p} autoFocus value={state.name} onChange={(e) => set('name', e.target.value)} placeholder="web-1" />}
            </Field>
            <div className="flex gap-3">
              <Field label="Host" error={errors.host} className="flex-1">
                {(p) => (
                  <Input
                    {...p}
                    className="font-mono"
                    value={state.host}
                    onChange={(e) => set('host', e.target.value.trim())}
                    placeholder="203.0.113.10 or example.com"
                    spellCheck={false}
                  />
                )}
              </Field>
              <Field label="Port" error={errors.port} className="w-20">
                {(p) => (
                  <Input
                    {...p}
                    className="font-mono"
                    inputMode="numeric"
                    value={state.port}
                    onChange={(e) => set('port', e.target.value.replace(/\D/g, '').slice(0, 5))}
                  />
                )}
              </Field>
            </div>
            <Field label="Username" error={errors.username}>
              {(p) => (
                <Input {...p} className="font-mono" value={state.username} onChange={(e) => set('username', e.target.value)} placeholder="root" spellCheck={false} />
              )}
            </Field>

            <div className="flex flex-col gap-1.5">
              <span className="text-caption font-medium text-muted">Authentication</span>
              <Segmented<AuthType>
                label="Authentication method"
                value={state.authType}
                onChange={(v) => set('authType', v)}
                options={[
                  { value: 'password', label: 'Password', icon: <Lock /> },
                  { value: 'key', label: 'SSH key', icon: <KeyRound /> },
                ]}
              />
            </div>

            {state.authType === 'password' ? (
              <Field label="Password" error={errors.password}>
                {(p) => (
                  <PasswordInput
                    {...p}
                    autoComplete="off"
                    value={state.password}
                    onChange={(e) => set('password', e.target.value)}
                    placeholder={secretPlaceholder}
                  />
                )}
              </Field>
            ) : (
              <>
                <Field
                  label="Private key"
                  error={errors.privateKey}
                  hint={keepsSecret && !state.privateKey ? 'A key is saved. Paste or choose a new one to replace it.' : 'OpenSSH or PEM format.'}
                >
                  {(p) => (
                    <div className="flex flex-col gap-2">
                      <Textarea
                        {...p}
                        className="h-28 font-mono text-caption"
                        value={state.privateKey}
                        onChange={(e) => set('privateKey', e.target.value)}
                        placeholder={keepsSecret ? 'Saved — leave empty to keep' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
                        spellCheck={false}
                      />
                      <Button type="button" size="sm" className="self-start" onClick={() => void pickFile()}>
                        <FileKey /> Choose file…
                      </Button>
                    </div>
                  )}
                </Field>
                <Field label="Passphrase (optional)" error={errors.passphrase}>
                  {(p) => (
                    <PasswordInput
                      {...p}
                      autoComplete="off"
                      value={state.passphrase}
                      onChange={(e) => set('passphrase', e.target.value)}
                      placeholder={keepsPassphrase ? 'Saved — leave empty to keep' : undefined}
                    />
                  )}
                </Field>
              </>
            )}

            <Field label="Tags (optional)" error={errors.tags} hint="Separate with commas, e.g. prod, web">
              {(p) => <Input {...p} value={state.tags} onChange={(e) => set('tags', e.target.value)} />}
            </Field>
            <Field label="Notes (optional)" error={errors.notes}>
              {(p) => <Textarea {...p} value={state.notes} onChange={(e) => set('notes', e.target.value)} />}
            </Field>
          </form>
        </SheetContent>
      ) : null}
    </Dialog>
  );
}
