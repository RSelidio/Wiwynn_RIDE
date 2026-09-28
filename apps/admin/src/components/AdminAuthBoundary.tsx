'use client';

import React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@shuttle/client';
import { SignIn } from './SignIn';

/** Prevent protected page effects from running until a valid role is restored. */
export function AdminAuthBoundary({ children }: { children: React.ReactNode }) {
  const { status, role } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  React.useEffect(() => {
    if (status === 'authenticated' && role === 'guard' && pathname !== '/gate') {
      router.replace('/gate');
    }
  }, [pathname, role, router, status]);

  if (status === 'loading') {
    return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>Restoring session…</main>;
  }
  if (status === 'anonymous') return <SignIn />;
  if (role === 'guard' && pathname !== '/gate') {
    return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>Opening gate tablet…</main>;
  }
  return <>{children}</>;
}
