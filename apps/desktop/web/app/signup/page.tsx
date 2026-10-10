'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AuthCard, SessionGate } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, PasswordInput } from '@/components/ui/input';
import { api, DesktopClientError, errorMessage } from '@/lib/desktop';
import { keys } from '@/lib/queries';
import { useUi } from '@/lib/store';

function SignupForm() {
  const router = useRouter();
  const client = useQueryClient();
  const setRecoveryKey = useUi((s) => s.setRecoveryKey);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setFieldErrors({ password: 'Use at least 8 characters' });
      return;
    }
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await api.auth.signup({ name, email, password });
      setRecoveryKey(result.recoveryKey);
      router.replace('/recovery-key');
      client.setQueryData(keys.session, { user: result.user });
    } catch (err) {
      if (err instanceof DesktopClientError && err.code === 'VALIDATION_ERROR') {
        setFieldErrors(err.fieldErrors);
      } else if (err instanceof DesktopClientError && err.code === 'EMAIL_TAKEN') {
        setFieldErrors({ email: 'An account with this email already exists. Log in instead.' });
      } else {
        setError(errorMessage(err));
      }
      setPending(false);
    }
  }

  return (
    <AuthCard title="Create your account" subtitle="Passwords and keys are encrypted on this computer before they sync.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormError message={error} />
        <Field label="Name" error={fieldErrors.name}>
          {(p) => <Input {...p} autoComplete="name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Email" error={fieldErrors.email}>
          {(p) => (
            <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          )}
        </Field>
        <Field
          label="Password"
          error={fieldErrors.password}
          hint="At least 8 characters. This password also unlocks your saved server passwords."
        >
          {(p) => (
            <PasswordInput
              {...p}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={pending}
          disabled={!name.trim() || !email || !password}
        >
          {pending ? 'Creating your vault…' : 'Create account'}
        </Button>
      </form>
      <p className="mt-5 text-center text-body text-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Log in
        </Link>
      </p>
    </AuthCard>
  );
}

export default function SignupPage() {
  return (
    <SessionGate require="signed-out">
      <SignupForm />
    </SessionGate>
  );
}
