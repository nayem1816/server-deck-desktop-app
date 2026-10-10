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

function LoginForm() {
  const router = useRouter();
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const session = await api.auth.login({ email, password });
      client.setQueryData(keys.session, session);
      router.replace('/deck');
    } catch (err) {
      if (err instanceof DesktopClientError && err.code === 'VALIDATION_ERROR') {
        setFieldErrors(err.fieldErrors);
      } else {
        setError(errorMessage(err));
      }
      setPending(false);
    }
  }

  return (
    <AuthCard title="Log in" subtitle="Your servers sync across every device you log in on.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormError message={error} />
        <Field label="Email" error={fieldErrors.email}>
          {(p) => (
            <Input
              {...p}
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          )}
        </Field>
        <Field label="Password" error={fieldErrors.password}>
          {(p) => (
            <PasswordInput
              {...p}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          )}
        </Field>
        <div className="-mt-1 flex justify-end">
          <Link href="/forgot-password" className="text-caption text-muted hover:text-fg">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" variant="primary" size="lg" loading={pending} disabled={!email || !password}>
          {pending ? 'Unlocking your vault…' : 'Log in'}
        </Button>
      </form>
      <p className="mt-5 text-center text-body text-muted">
        No account?{' '}
        <Link href="/signup" className="font-medium text-accent hover:underline">
          Sign up
        </Link>
      </p>
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <SessionGate require="signed-out">
      <LoginForm />
    </SessionGate>
  );
}
