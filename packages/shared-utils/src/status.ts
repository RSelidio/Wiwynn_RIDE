/**
 * Request lifecycle rules (spec §18).
 *
 * The transition table lives in @shuttle/shared-types; these helpers are the
 * only thing that should ever be consulted before changing a status. The
 * backend enforces them, and the clients use them to decide which buttons to
 * show — so a driver never sees "Arrived" on a request they have not accepted.
 */

import {
  OPEN_REQUEST_STATUSES,
  REQUEST_TRANSITIONS,
  type RequestStatus,
  type Role,
} from '@shuttle/shared-types';

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return REQUEST_TRANSITIONS[from].includes(to);
}

export function isOpenRequest(status: RequestStatus): boolean {
  return OPEN_REQUEST_STATUSES.includes(status);
}

export function isTerminalRequest(status: RequestStatus): boolean {
  return REQUEST_TRANSITIONS[status].length === 0;
}

/** Which role is allowed to drive a given transition. */
const TRANSITION_ROLES: Record<RequestStatus, Partial<Record<RequestStatus, readonly Role[]>>> = {
  pending: {
    accepted: ['driver', 'admin'],
    rejected: ['driver', 'admin'],
    cancelled: ['employee', 'admin'],
    expired: [],
  },
  accepted: {
    arrived: ['driver', 'admin'],
    cancelled: ['employee', 'driver', 'admin'],
  },
  arrived: {
    boarding: ['driver', 'admin'],
    cancelled: ['driver', 'admin'],
  },
  boarding: {
    completed: ['driver', 'admin'],
  },
  completed: {},
  cancelled: {},
  rejected: {},
  expired: {},
};

/**
 * True when `role` may move a request from `from` to `to`.
 *
 * An empty role list means system-only — request expiry, for instance, is not
 * something any human triggers.
 */
export function roleCanTransition(role: Role, from: RequestStatus, to: RequestStatus): boolean {
  if (!canTransition(from, to)) return false;
  const allowed = TRANSITION_ROLES[from][to];
  return allowed != null && allowed.includes(role);
}

/** The next step a driver would take on this request, if any. */
export function nextDriverAction(
  status: RequestStatus,
): { to: RequestStatus; label: string } | null {
  switch (status) {
    case 'pending':
      return { to: 'accepted', label: 'Accept' };
    case 'accepted':
      return { to: 'arrived', label: 'Arrived' };
    case 'arrived':
      return { to: 'boarding', label: 'Passenger picked up' };
    case 'boarding':
      return { to: 'completed', label: 'Complete trip' };
    default:
      return null;
  }
}

/** The next step an admin would take from the request drawer, if any. */
export function nextAdminAction(
  status: RequestStatus,
): { to: RequestStatus; label: string } | null {
  switch (status) {
    case 'accepted':
      return { to: 'arrived', label: 'Mark arrived' };
    case 'arrived':
      return { to: 'boarding', label: 'Mark boarding' };
    case 'boarding':
      return { to: 'completed', label: 'Complete trip' };
    default:
      return null;
  }
}

/** Whether an employee may still call this request off. */
export function employeeCanCancel(status: RequestStatus): boolean {
  return status === 'pending' || status === 'accepted';
}
