'use client';

import React from 'react';
import { AuthProvider, SocketProvider, useAuth } from '@shuttle/client';
import { ThemeProvider } from '@shuttle/ui';
import { AdminAuthBoundary } from '@/components/AdminAuthBoundary';

/**
 * Admins and guards both sign in here.
 *
 * They see entirely different things: an admin gets the dashboard, a guard gets
 * only the gate tablet. Sharing one deployment avoids a fourth Next app for a
 * single screen, and the role split is enforced in the shell and again by the
 * backend on every endpoint.
 */
const ALLOWED_ROLES = ['admin', 'guard'] as const;

function SocketGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  return <SocketProvider enabled={status === 'authenticated'}>{children}</SocketProvider>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider initial="light">
      <AuthProvider allowedRoles={ALLOWED_ROLES}>
        <SocketGate>
          <AdminAuthBoundary>{children}</AdminAuthBoundary>
        </SocketGate>
      </AuthProvider>
    </ThemeProvider>
  );
}
