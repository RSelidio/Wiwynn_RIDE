'use client';

import React from 'react';
import { useAuth } from '@shuttle/client';
import { Button, Label, Logo, TextInput, ThemeToggle, brand, fontSize, radius, shadow, useTheme, weight } from '@shuttle/ui';

/** Sign-in for administrators and gate guards. */
export function SignIn() {
  const { signIn, error } = useAuth();
  const { theme } = useTheme();

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    try {
      await signIn(email.trim(), password);
    } catch {
      // Message comes back through the auth context.
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: theme.page,
      }}
    >
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
          <Logo height={32} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 20, fontWeight: weight.bold, color: brand.blueText }}>Shuttle</span>
            <span
              style={{
                fontSize: 10,
                fontWeight: weight.semibold,
                color: theme.fg3,
                border: `1px solid ${theme.borderStrong}`,
                padding: '1px 6px',
                borderRadius: 3,
                letterSpacing: '.06em',
              }}
            >
              ADMIN
            </span>
          </div>
          <div style={{ marginLeft: 'auto' }}><ThemeToggle compact /></div>
        </div>

        <form
          onSubmit={submit}
          style={{
            background: theme.surface,
            border: `1px solid ${theme.border}`,
            borderRadius: radius.xl,
            boxShadow: shadow.card,
            padding: 24,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Label>Email</Label>
            <TextInput type="email" value={email} onChange={setEmail} placeholder="you@wiwynn.com" />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Label>Password</Label>
            <TextInput type="password" value={password} onChange={setPassword} />
          </div>

          {error != null && (
            <div
              role="alert"
              style={{
                background: brand.redPale,
                color: brand.redText,
                borderRadius: radius.md,
                padding: '10px 12px',
                fontSize: fontSize.base,
              }}
            >
              {error}
            </div>
          )}

          <Button type="submit" full height={48} disabled={busy || email === '' || password === ''}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </main>
  );
}
