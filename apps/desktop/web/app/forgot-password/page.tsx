'use client';

import { useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { AuthCard, SessionGate } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, PasswordInput } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/misc';
import { api, DesktopClientError, errorMessage } from '@/lib/desktop';
import { keys } from '@/lib/queries';
import { useUi } from '@/lib/store';

type Step = 'email' | 'code' | 'password';

function ForgotPassword() {
  const router = useRouter();
  const client = useQueryClient();
  const setRecoveryKey = useUi((s) => s.setRecoveryKey);
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryKey, setKey] = useState('');
  const [noKey, setNoKey] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function run(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      await action();
    } catch (err) {
      if (err instanceof DesktopClientError && err.code === 'VALIDATION_ERROR') {
        setFieldErrors(err.fieldErrors);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setPending(false);
    }
  }

  const sendCode = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.auth.requestPasswordReset(email);
      setStep('code');
    });
  };

  const verify = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.auth.verifyResetCode(email, code);
      setStep('password');
    });
  };

  const reset = (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      setFieldErrors({ newPassword: 'Use at least 8 characters' });
      return;
    }
    void run(async () => {
      const result = await api.auth.completePasswordReset({
        newPassword: password,
        recoveryKey: noKey ? null : recoveryKey,
      });
      if (result.newRecoveryKey) setRecoveryKey(result.newRecoveryKey);
      client.setQueryData(keys.session, { user: result.user });
      toast.success('Password changed');
      router.replace(result.newRecoveryKey ? '/recovery-key' : '/deck');
    });
  };

  if (step === 'email') {
    return (
      <AuthCard title="Reset your password" subtitle="We'll email you a 6-digit code.">
        <form onSubmit={sendCode} className="flex flex-col gap-4" noValidate>
          <FormError message={error} />
          <Field label="Email" error={fieldErrors.email}>
            {(p) => (
              <Input {...p} type="email" autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            )}
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={pending} disabled={!email}>
            Send code
          </Button>
        </form>
        <p className="mt-5 text-center text-body text-muted">
          <Link href="/login" className="hover:text-fg">
            Back to log in
          </Link>
        </p>
      </AuthCard>
    );
  }

  if (step === 'code') {
    return (
      <AuthCard
        title="Check your email"
        subtitle={
          <>
            If <span className="text-fg">{email}</span> has an account, a code is on its way. It
            expires in 15 minutes.
          </>
        }
      >
        <form onSubmit={verify} className="flex flex-col gap-4" noValidate>
          <FormError message={error} />
          <Field label="6-digit code" error={fieldErrors.code}>
            {(p) => (
              <Input
                {...p}
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className="font-mono tracking-[0.4em]"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={pending} disabled={code.length !== 6}>
            Continue
          </Button>
          <Button type="button" variant="ghost" onClick={() => setStep('email')}>
            Use a different email
          </Button>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password">
      <form onSubmit={reset} className="flex flex-col gap-4" noValidate>
        <FormError message={error} />
        <Field label="New password" error={fieldErrors.newPassword} hint="At least 8 characters.">
          {(p) => (
            <PasswordInput {...p} autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          )}
        </Field>

        {!noKey ? (
          <>
            <Field
              label="Recovery key"
              error={fieldErrors.recoveryKey}
              hint="The key you saved when you created your account. It keeps your saved passwords and SSH keys."
            >
              {(p) => (
                <Input
                  {...p}
                  className="font-mono uppercase"
                  placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                  value={recoveryKey}
                  onChange={(e) => setKey(e.target.value)}
                />
              )}
            </Field>
            <button
              type="button"
              className="-mt-2 self-start text-caption text-muted hover:text-fg"
              onClick={() => setNoKey(true)}
            >
              I don&apos;t have my recovery key
            </button>
          </>
        ) : (
          <div className="flex flex-col gap-3 rounded-card border border-warning/40 bg-warning-soft p-3">
            <div className="flex gap-2 text-body">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <p>
                Without the recovery key, <strong>all saved server passwords and SSH keys will be
                erased</strong>. Your servers (names, hosts, usernames) stay, and you&apos;ll need to
                re-enter their passwords or keys.
              </p>
            </div>
            <Checkbox id="understood" checked={understood} onChange={setUnderstood}>
              I understand my saved secrets will be erased
            </Checkbox>
            <button
              type="button"
              className="self-start text-caption text-muted hover:text-fg"
              onClick={() => {
                setNoKey(false);
                setUnderstood(false);
              }}
            >
              I found my recovery key
            </button>
          </div>
        )}

        <Button
          type="submit"
          variant={noKey ? 'danger' : 'primary'}
          size="lg"
          loading={pending}
          disabled={!password || (noKey ? !understood : !recoveryKey.trim())}
        >
          {noKey ? 'Erase secrets and reset password' : 'Reset password'}
        </Button>
      </form>
    </AuthCard>
  );
}

export default function ForgotPasswordPage() {
  return (
    <SessionGate require="signed-out">
      <ForgotPassword />
    </SessionGate>
  );
}
