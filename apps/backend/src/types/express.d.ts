/**
 * Express request augmentation.
 *
 * `req.auth` is set by the requireAuth middleware and is therefore only
 * non-null on routes that ran it. It is typed optional so a route that forgets
 * the middleware cannot read it without a null check.
 */

import type { Role } from '@shuttle/shared-types';

declare global {
  namespace Express {
    interface AuthContext {
      userId: string;
      role: Role;
      employeeId: string | null;
      driverId: string | null;
      displayName: string;
    }

    interface Request {
      auth?: AuthContext;
    }
  }
}

export {};
