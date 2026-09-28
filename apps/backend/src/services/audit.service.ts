/**
 * Audit logging.
 *
 * Every state change that a person could later be asked to account for writes a
 * row here. Failures are logged but never propagated — an audit write must not
 * be the reason a driver cannot complete a trip.
 */

import type { Request } from 'express';
import { query } from '../db/pool';
import { logger } from '../logger';

export interface AuditEntry {
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  changes?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function record(entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs
         (actor_user_id, action, entity_type, entity_id, changes, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.actorUserId,
        entry.action,
        entry.entityType,
        entry.entityId,
        entry.changes == null ? null : JSON.stringify(entry.changes),
        entry.ipAddress ?? null,
        entry.userAgent ?? null,
      ],
    );
  } catch (err) {
    logger.error({ err, action: entry.action }, 'audit write failed');
  }
}

/** Record an entry, taking actor and client details from the request. */
export async function recordFrom(
  req: Request,
  action: string,
  entityType: string,
  entityId: string | null,
  changes?: Record<string, unknown>,
): Promise<void> {
  await record({
    actorUserId: req.auth?.userId ?? null,
    action,
    entityType,
    entityId,
    changes: changes ?? null,
    // Behind IIS the direct socket is the proxy, so prefer the forwarded header
    // when `trust proxy` has populated req.ip from it.
    ipAddress: req.ip ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  });
}

/** A shallow before/after diff, limited to the keys that actually changed. */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) out[key] = { from: before[key], to: after[key] };
  }
  return out;
}
