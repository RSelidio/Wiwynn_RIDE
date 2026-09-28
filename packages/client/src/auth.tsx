/**
 * Authentication context.
 *
 * On mount it tries a silent refresh, so a returning user with a valid refresh
 * cookie lands signed in without seeing the login screen. The access token
 * lives in memory only and is re-acquired on every page load.
 */

'use client';

import React from 'react';
import type { AuthSession, Role } from '@shuttle/shared-types';
import { api, ApiRequestError, setAccessToken, setUnauthenticatedHandler } from './api';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: AuthStatus;
  session: AuthSession | null;
  role: Role | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-read the session, e.g. after a profile change. */
  reload: () => Promise<void>;
  error: string | null;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  /** Roles allowed in this app. A signed-in user with another role is rejected. */
  allowedRoles,
}: {
  children: React.ReactNode;
  allowedRoles?: readonly Role[];
}) {
  const [status, setStatus] = React.useState<AuthStatus>('loading');
  const [session, setSession] = React.useState<AuthSession | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const applySession = React.useCallback(
    (next: AuthSession | null) => {
      if (next == null) {
        setAccessToken(null);
        setSession(null);
        setStatus('anonymous');
        return;
      }

      if (allowedRoles != null && !allowedRoles.includes(next.user.role)) {
        // Signed in, but to the wrong app. Say so rather than showing an empty
        // dashboard the user has no permission to populate.
        setAccessToken(null);
        setSession(null);
        setStatus('anonymous');
        setError(`This application is not available to the ${next.user.role} role.`);
        return;
      }

      setAccessToken(next.accessToken);
      setSession(next);
      setStatus('authenticated');
      setError(null);
    },
    [allowedRoles],
  );

  // Silent restore on first paint.
  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const restored = await api.auth.refresh();
        if (!cancelled) applySession(restored);
      } catch {
        if (!cancelled) applySession(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applySession]);

  // A failed refresh mid-session drops us to anonymous rather than leaving the
  // UI showing stale data it can no longer update.
  React.useEffect(() => {
    setUnauthenticatedHandler(() => applySession(null));
    return () => setUnauthenticatedHandler(null);
  }, [applySession]);

  const signIn = React.useCallback(
    async (email: string, password: string) => {
      setError(null);
      try {
        applySession(await api.auth.login(email, password));
      } catch (err) {
        const message =
          err instanceof ApiRequestError ? err.message : 'Could not reach the server.';
        setError(message);
        setStatus('anonymous');
        throw err;
      }
    },
    [applySession],
  );

  const signOut = React.useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      // Even if the server call fails, drop the local session.
    }
    applySession(null);
  }, [applySession]);

  const reload = React.useCallback(async () => {
    try {
      applySession(await api.auth.me());
    } catch {
      applySession(null);
    }
  }, [applySession]);

  const value = React.useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      role: session?.user.role ?? null,
      signIn,
      signOut,
      reload,
      error,
    }),
    [status, session, signIn, signOut, reload, error],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = React.useContext(AuthContext);
  if (context == null) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}

/** The signed-in employee profile, or null when the user is not an employee. */
export function useEmployee() {
  return useAuth().session?.employee ?? null;
}

/** The signed-in driver profile, or null when the user is not a driver. */
export function useDriver() {
  return useAuth().session?.driver ?? null;
}
