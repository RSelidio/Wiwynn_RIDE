'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth, useSocket } from '@shuttle/client';
import { Avatar, LiveDot, Logo, ThemeToggle, brand, fontSize, useTheme, weight } from '@shuttle/ui';
import { SignIn } from './SignIn';

const TABS = [
  { href: '/', label: 'Pickup' },
  { href: '/shuttles', label: 'Shuttles' },
  { href: '/trips', label: 'Trips' },
] as const;

/**
 * Phone chrome: a fixed header, a scrolling body and a bottom tab bar.
 *
 * Also the authentication gate — an unauthenticated visitor gets the sign-in
 * screen instead of the shell, so no page has to check for a session itself.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { status, session } = useAuth();
  const { connected } = useSocket();
  const { theme } = useTheme();
  const pathname = usePathname();

  if (status === 'loading') {
    return (
      <div
        style={{
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: theme.fg3,
          fontSize: fontSize.base,
        }}
      >
        Loading…
      </div>
    );
  }

  if (status === 'anonymous') return <SignIn />;

  const name = session?.employee?.displayName ?? session?.user.displayName ?? '';

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        background: theme.page,
      }}
    >
      <header
        className="pwa-safe-top"
        style={{
          background: theme.surface,
          borderBottom: `1px solid ${theme.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 16px',
          position: 'sticky',
          top: 0,
          zIndex: 20,
        }}
      >
        <Logo height={22} />
        <div style={{ fontSize: fontSize.lg, fontWeight: weight.semibold, color: brand.blueText }}>
          Company Shuttle
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* The dot reflects the socket, not a decoration — if realtime is
              down the user should know the ETA has stopped updating. */}
          {connected ? (
            <LiveDot />
          ) : (
            <span style={{ fontSize: fontSize.xs, color: brand.amberText }}>Reconnecting…</span>
          )}
          <ThemeToggle compact />
          <Link href="/profile" aria-label="Profile" style={{ display: 'flex' }}>
            <Avatar name={name} size={30} />
          </Link>
        </div>
      </header>

      <main style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {children}
      </main>

      <nav
        className="pwa-safe-bottom"
        style={{
          background: theme.surface,
          borderTop: `1px solid ${theme.border}`,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          padding: '8px 16px',
          position: 'sticky',
          bottom: 0,
          zIndex: 20,
        }}
      >
        {TABS.map((tab) => {
          const active = pathname === tab.href;
          const colour = active ? brand.blue : '#8a96a3';

          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 3,
                padding: '4px 0',
                fontSize: 10.5,
                fontWeight: weight.semibold,
                color: colour,
                textDecoration: 'none',
              }}
            >
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 5,
                  border: `1.5px solid ${colour}`,
                  background: active ? brand.blue : 'transparent',
                }}
              />
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
