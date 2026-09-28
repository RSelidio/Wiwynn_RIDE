'use client';

import React from 'react';
import { AuthProvider, SocketProvider, useAuth } from '@shuttle/client';
import { ThemeProvider } from '@shuttle/ui';

/** Only employees sign in here; other roles have their own surface. */
const ALLOWED_ROLES = ['employee'] as const;

/**
 * Registers the service worker.
 *
 * Done from a client component rather than an inline script so it runs once
 * after hydration and stays out of the critical path.
 */
function useServiceWorker(): void {
  React.useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    // A service worker in development shadows hot reloads and serves stale
    // chunks, which looks like a build bug. Register in production only.
    if (process.env.NODE_ENV !== 'production') return;

    const timer = setTimeout(() => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Registration failing is not fatal — the app works without it.
      });
    }, 1_000);

    return () => clearTimeout(timer);
  }, []);
}

/** The socket only connects once there is a session to authenticate it with. */
function SocketGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  return <SocketProvider enabled={status === 'authenticated'}>{children}</SocketProvider>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  useServiceWorker();

  return (
    <ThemeProvider initial="light">
      <AuthProvider allowedRoles={ALLOWED_ROLES}>
        <SocketGate>{children}</SocketGate>
      </AuthProvider>
    </ThemeProvider>
  );
}
