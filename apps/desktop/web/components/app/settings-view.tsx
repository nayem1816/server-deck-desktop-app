'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Download, History, LogOut, Minus, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Field, FormError, Input, PasswordInput } from '@/components/ui/input';
import { Segmented, Skeleton } from '@/components/ui/misc';
import { api, DesktopClientError, errorMessage } from '@/lib/desktop';
import { keys, useHistory, useServerAction, useSession, useTrash } from '@/lib/queries';
import { usePrefs, useUi, type ThemePref } from '@/lib/store';
import { timeAgo } from '@/lib/utils';

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-surface p-5">
      <h2 className="text-title font-semibold">{title}</h2>
      {description ? <p className="mt-0.5 text-body text-muted">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Shared submit/error handling for the small forms on this page. */
function useFormAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      await action();
      return true;
    } catch (err) {
      if (err instanceof DesktopClientError && Object.keys(err.fieldErrors).length > 0) {
        setFieldErrors(err.fieldErrors);
      } else {
        setError(errorMessage(err));
      }
      return false;
    } finally {
      setPending(false);
    }
  };
  return { pending, error, fieldErrors, run };
}

function ProfileSection() {
  const client = useQueryClient();
  const user = useSession().data?.user;
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const nameForm = useFormAction();
  const emailForm = useFormAction();
  if (!user) return null;

  const saveName = (e: FormEvent) => {
    e.preventDefault();
    void nameForm.run(async () => {
      const updated = await api.auth.updateName(name.trim());
      client.setQueryData(keys.session, { user: updated });
      toast.success('Name saved');
    });
  };
  const saveEmail = (e: FormEvent) => {
    e.preventDefault();
    void emailForm.run(async () => {
      const updated = await api.auth.changeEmail({ email, password });
      client.setQueryData(keys.session, { user: updated });
      setPassword('');
      toast.success('Email changed');
    });
  };

  return (
    <Section title="Profile">
      <div className="grid gap-6 md:grid-cols-2">
        <form onSubmit={saveName} className="flex flex-col gap-3">
          <FormError message={nameForm.error} />
          <Field label="Name" error={nameForm.fieldErrors.name}>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Button type="submit" className="self-start" loading={nameForm.pending} disabled={!name.trim() || name.trim() === user.name}>
            Save name
          </Button>
        </form>
        <form onSubmit={saveEmail} className="flex flex-col gap-3">
          <FormError message={emailForm.error} />
          <Field label="Email" error={emailForm.fieldErrors.email}>
            {(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          {email.trim().toLowerCase() !== user.email ? (
            <Field label="Current password" error={emailForm.fieldErrors.password}>
              {(p) => <PasswordInput {...p} value={password} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
          ) : null}
          <Button
            type="submit"
            className="self-start"
            loading={emailForm.pending}
            disabled={email.trim().toLowerCase() === user.email || !password}
          >
            Change email
          </Button>
        </form>
      </div>
    </Section>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const form = useFormAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void form.run(async () => {
      await api.auth.changePassword({ currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      toast.success('Password changed. Other devices were logged out.');
    });
  };

  return (
    <Section title="Password" description="Changing it logs out your other devices. Your saved servers and secrets stay.">
      <form onSubmit={submit} className="grid gap-3 md:grid-cols-2">
        <div className="md:col-span-2">
          <FormError message={form.error} />
        </div>
        <Field label="Current password" error={form.fieldErrors.currentPassword}>
          {(p) => <PasswordInput {...p} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
        </Field>
        <Field label="New password" error={form.fieldErrors.newPassword} hint="At least 8 characters.">
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
        </Field>
        <Button type="submit" className="justify-self-start" loading={form.pending} disabled={!current || !next}>
          Change password
        </Button>
      </form>
    </Section>
  );
}

function AppearanceSection() {
  const { theme, setTheme, terminalFontSize, setTerminalFontSize } = usePrefs();
  return (
    <Section title="Appearance">
      <div className="flex flex-wrap items-end gap-8">
        <div className="flex w-72 flex-col gap-1.5">
          <span className="text-caption font-medium text-muted">Theme</span>
          <Segmented<ThemePref>
            label="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'system', label: 'System' },
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-muted">Terminal font size</span>
          <div className="flex items-center gap-2">
            <Button size="icon" aria-label="Smaller" onClick={() => setTerminalFontSize(terminalFontSize - 1)} disabled={terminalFontSize <= 10}>
              <Minus />
            </Button>
            <span className="w-12 text-center font-mono text-body" aria-live="polite">
              {terminalFontSize}px
            </span>
            <Button size="icon" aria-label="Larger" onClick={() => setTerminalFontSize(terminalFontSize + 1)} disabled={terminalFontSize >= 24}>
              <Plus />
            </Button>
          </div>
        </div>
      </div>
    </Section>
  );
}

function PassphraseDialog({
  mode,
  onClose,
}: {
  mode: 'export' | 'import' | null;
  onClose: () => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const form = useFormAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void form
      .run(async () => {
        if (mode === 'export') {
          const result = await api.data.exportToFile(passphrase);
          if (result) toast.success(`Exported to ${result.path}`);
        } else {
          const result = await api.data.importFromFile(passphrase);
          if (result) toast.success(`Imported ${result.imported} server${result.imported === 1 ? '' : 's'}`);
        }
      })
      .then((ok) => {
        if (ok) {
          setPassphrase('');
          onClose();
        }
      });
  };

  return (
    <Dialog open={mode !== null} onOpenChange={(open) => !open && onClose()}>
      {mode ? (
        <DialogContent
          title={mode === 'export' ? 'Export your servers' : 'Import servers'}
          description={
            mode === 'export'
              ? 'The file contains your server passwords and keys, encrypted with this passphrase. You need it to import the file.'
              : 'Enter the passphrase used when the file was exported. Imported servers are added as new entries.'
          }
        >
          <form onSubmit={submit} className="flex flex-col gap-4">
            <FormError message={form.error} />
            <Field
              label="Passphrase"
              error={form.fieldErrors.passphrase}
              hint={mode === 'export' ? 'At least 8 characters. It is not your account password.' : undefined}
            >
              {(p) => <PasswordInput {...p} autoFocus value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />}
            </Field>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button">Cancel</Button>
              </DialogClose>
              <Button type="submit" variant="primary" loading={form.pending} disabled={!passphrase}>
                {mode === 'export' ? 'Choose file and export' : 'Choose file and import'}
              </Button>
            </div>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function DataSection() {
  const [mode, setMode] = useState<'export' | 'import' | null>(null);
  return (
    <Section title="Backup" description="Export an encrypted copy of all servers, or import one. Your servers are also kept safe in the cloud.">
      <div className="flex gap-2">
        <Button onClick={() => setMode('export')}>
          <Download /> Export my data
        </Button>
        <Button onClick={() => setMode('import')}>
          <Upload /> Import
        </Button>
      </div>
      <PassphraseDialog mode={mode} onClose={() => setMode(null)} />
    </Section>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy>
      <Skeleton className="h-9" />
      <Skeleton className="h-9" />
    </div>
  );
}

function Row({ title, subtitle, action }: { title: string; subtitle: string; action: ReactNode }) {
  return (
    <li className="flex items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-body font-medium">{title}</p>
        <p className="truncate text-caption text-muted">{subtitle}</p>
      </div>
      {action}
    </li>
  );
}

function TrashSection() {
  const trash = useTrash();
  const action = useServerAction();
  let body: ReactNode;
  if (trash.isPending) body = <ListSkeleton />;
  else if (trash.isError) body = <FormError message={`Couldn't load the trash. ${errorMessage(trash.error)}`} />;
  else if (trash.data.length === 0) body = <p className="text-body text-muted">The trash is empty.</p>;
  else
    body = (
      <ul className="divide-y divide-line">
        {trash.data.map((s) => (
          <Row
            key={s.id}
            title={s.name}
            subtitle={`${s.username}@${s.host} · deleted ${timeAgo(s.deletedAt)}`}
            action={
              <Button size="sm" onClick={() => action.mutate({ action: 'restore', id: s.id }, { onSuccess: () => toast.success(`Restored ${s.name}`) })}>
                <RotateCcw /> Restore
              </Button>
            }
          />
        ))}
      </ul>
    );
  return (
    <Section title="Trash" description="Deleted servers stay here for 30 days on all your devices.">
      {body}
    </Section>
  );
}

function HistorySection() {
  const [open, setOpen] = useState(false);
  const history = useHistory(open);
  const client = useQueryClient();
  const [restoring, setRestoring] = useState<string | null>(null);

  async function restore(id: string, name: string) {
    setRestoring(id);
    try {
      await api.servers.restoreHistory(id);
      void client.invalidateQueries({ queryKey: keys.history });
      toast.success(`Restored the earlier version of ${name}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRestoring(null);
    }
  }

  let body: ReactNode;
  if (!open) {
    body = (
      <Button onClick={() => setOpen(true)}>
        <History /> Show recently changed
      </Button>
    );
  } else if (history.isPending) {
    body = <ListSkeleton />;
  } else if (history.isError) {
    body = (
      <div className="flex flex-col items-start gap-2">
        <FormError message={`${errorMessage(history.error)} This list needs an internet connection.`} />
        <Button size="sm" onClick={() => void history.refetch()}>
          Try again
        </Button>
      </div>
    );
  } else if (history.data.length === 0) {
    body = <p className="text-body text-muted">No overwritten versions in the last 30 days.</p>;
  } else {
    body = (
      <ul className="divide-y divide-line">
        {history.data.map((h) => (
          <Row
            key={h.id}
            title={h.name || 'Unnamed server'}
            subtitle={`${h.host} · ${h.reason === 'conflict' ? 'replaced by an edit on another device' : 'replaced by a restore'} ${timeAgo(h.createdAt)}`}
            action={
              <Button size="sm" loading={restoring === h.id} onClick={() => void restore(h.id, h.name)}>
                <RotateCcw /> Restore
              </Button>
            }
          />
        ))}
      </ul>
    );
  }
  return (
    <Section
      title="Recently changed"
      description="When the same server is edited on two devices, the older edit is kept here for 30 days."
    >
      {body}
    </Section>
  );
}

function SessionsSection() {
  const router = useRouter();
  const client = useQueryClient();
  const reset = useUi((s) => s.reset);
  const [pending, setPending] = useState(false);

  async function logoutAll() {
    setPending(true);
    try {
      await api.auth.logoutAll();
      reset();
      client.clear();
      router.replace('/login');
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Section title="Sessions" description="Log out on every device, including this one.">
      <Button onClick={() => void logoutAll()} loading={pending}>
        <LogOut /> Log out everywhere
      </Button>
    </Section>
  );
}

function DeleteAccountSection() {
  const router = useRouter();
  const client = useQueryClient();
  const reset = useUi((s) => s.reset);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const form = useFormAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void form.run(async () => {
      await api.auth.deleteAccount(password);
      reset();
      client.clear();
      router.replace('/signup');
      toast.success('Your account and all its data were deleted.');
    });
  };

  return (
    <section className="rounded-card border border-danger/40 bg-surface p-5">
      <h2 className="text-title font-semibold text-danger">Delete account</h2>
      <p className="mt-0.5 text-body text-muted">
        Permanently deletes your account, all servers and saved secrets on every device. This can&apos;t be undone.
      </p>
      <Button variant="danger" className="mt-4" onClick={() => setOpen(true)}>
        <Trash2 /> Delete account
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Delete your account?"
          description="Everything is deleted right away. Export your data first if you might need it."
        >
          <form onSubmit={submit} className="flex flex-col gap-4">
            <FormError message={form.error} />
            <Field label="Password" error={form.fieldErrors.password}>
              {(p) => <PasswordInput {...p} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button">Cancel</Button>
              </DialogClose>
              <Button type="submit" variant="danger" loading={form.pending} disabled={!password}>
                Delete everything
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function SettingsView() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
        <h1 className="text-title font-semibold">Settings</h1>
        <ProfileSection />
        <PasswordSection />
        <AppearanceSection />
        <DataSection />
        <TrashSection />
        <HistorySection />
        <SessionsSection />
        <DeleteAccountSection />
      </div>
    </div>
  );
}
