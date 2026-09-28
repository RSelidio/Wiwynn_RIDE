'use client';

import React from 'react';
import { useAuth } from '@shuttle/client';
import { Button, Label, Logo, TextInput, ThemeToggle, brand, font, fontSize, radius, shadow, useTheme, weight } from '@shuttle/ui';

/**
 * Company sign-in (spec §1, §12).
 *
 * Local credentials today. When Entra ID is approved the backend advertises it
 * at /api/auth/providers and an SSO button appears here without a redesign.
 */
export function SignIn() {
  const { signIn, error } = useAuth();
  const { theme } = useTheme();

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [ssoAvailable, setSsoAvailable] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `${(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '')}/api/auth/providers`,
        );
        const body = (await response.json()) as { ok: boolean; data?: { entra: boolean } };
        if (!cancelled && body.ok) setSsoAvailable(body.data?.entra === true);
      } catch {
        // Offline or the API is down — the local form still renders.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    try {
      await signIn(email.trim(), password);
    } catch {
      // The message is surfaced through `error` from the auth context.
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      className="pwa-safe-top pwa-safe-bottom"
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '24px 20px',
        background: theme.page,
      }}
    >
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
          <Logo height={28} />
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
            <span style={{ fontSize: 19, fontWeight: weight.bold, color: brand.blueText }}>
              Company Shuttle
            </span>
            <span style={{ fontSize: fontSize.sm, color: theme.fg3 }}>Sign in with your company account</span>
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
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Label>Email</Label>
            <TextInput
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="you@wiwynn.com"
              height={48}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Label>Password</Label>
            <TextInput type="password" value={password} onChange={setPassword} height={48} />
          </div>

          {error != null && (
            <div
              role="alert"
              style={{
                background: brand.redPale,
                color: brand.redText,
                border: `1px solid ${brand.red}33`,
                borderRadius: radius.md,
                padding: '10px 12px',
                fontSize: fontSize.base,
              }}
            >
              {error}
            </div>
          )}

          <Button type="submit" full height={50} disabled={busy || email === '' || password === ''}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>

          {ssoAvailable && (
            <Button
              variant="secondary"
              full
              height={48}
              onClick={() => {
                window.location.href = `${(process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '')}/api/auth/sso`;
              }}
            >
              Sign in with company account
            </Button>
          )}
        </form>

        <p
          style={{
            marginTop: 20,
            fontSize: fontSize.sm,
            lineHeight: 1.5,
            color: theme.fg3,
            fontFamily: font.sans,
            textAlign: 'center',
          }}
        >
          Add this page to your Home Screen to use it like an app — no install needed.
        </p>
      </div>
    </main>
  );
}
