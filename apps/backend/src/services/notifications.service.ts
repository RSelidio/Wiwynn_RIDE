/**
 * In-app notifications.
 *
 * Persisted so the bell icon survives a refresh, and pushed over the socket so
 * it appears without one. Web Push is deliberately not wired up yet (spec §20
 * lists it as a later addition) — the delivery seam is `notify`, so adding a
 * push transport later touches this file only.
 */

import type { Notification, NotificationKind } from '@shuttle/shared-types';
import { query, queryOne } from '../db/pool';
import { rowToNotification } from '../db/rows';
import { logger } from '../logger';
import { realtime } from '../realtime/bus';

export interface NotifyInput {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  link?: string | null;
}

/**
 * Create and deliver a notification.
 *
 * Never throws: a failed notification must not roll back the state change that
 * prompted it. A driver's "trip completed" has to stick even if the employee's
 * bell badge does not update.
 */
export async function notify(input: NotifyInput): Promise<Notification | null> {
  try {
    const row = await queryOne(
      `INSERT INTO notifications (user_id, kind, title, body, link)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [input.userId, input.kind, input.title, input.body ?? null, input.link ?? null],
    );

    const notification = rowToNotification.one(row);
    if (notification != null) realtime.notification(input.userId, notification);
    return notification;
  } catch (err) {
    logger.error({ err, userId: input.userId, kind: input.kind }, 'notification failed');
    return null;
  }
}

/** Notify the user behind an employee record. */
export async function notifyEmployee(
  employeeId: string,
  input: Omit<NotifyInput, 'userId'>,
): Promise<void> {
  const row = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM employees WHERE id = $1`,
    [employeeId],
  );
  if (row != null) await notify({ ...input, userId: row.user_id });
}

/** Notify the user behind a driver record. */
export async function notifyDriver(
  driverId: string,
  input: Omit<NotifyInput, 'userId'>,
): Promise<void> {
  const row = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM drivers WHERE id = $1`,
    [driverId],
  );
  if (row != null) await notify({ ...input, userId: row.user_id });
}

/** Notify every admin — used for escalations such as a long-waiting request. */
export async function notifyAdmins(input: Omit<NotifyInput, 'userId'>): Promise<void> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM users WHERE role = 'admin' AND is_active`,
  );
  await Promise.all(rows.map((r) => notify({ ...input, userId: r.id })));
}

export async function listForUser(
  userId: string,
  limit = 30,
  offset = 0,
): Promise<{ items: Notification[]; total: number; unread: number }> {
  const items = rowToNotification.many(
    await query(
      `SELECT * FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    ),
  );

  const counts = await queryOne<{ total: number; unread: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE read_at IS NULL)::int AS unread
     FROM notifications WHERE user_id = $1`,
    [userId],
  );

  return { items, total: counts?.total ?? 0, unread: counts?.unread ?? 0 };
}

export async function markRead(userId: string, notificationId: string): Promise<void> {
  // Scoped by user_id so one user cannot mark another's notification read.
  await query(
    `UPDATE notifications SET read_at = now()
     WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
    [notificationId, userId],
  );
}

export async function markAllRead(userId: string): Promise<number> {
  const rows = await query<{ count: number }>(
    `WITH updated AS (
       UPDATE notifications SET read_at = now()
       WHERE user_id = $1 AND read_at IS NULL
       RETURNING 1
     )
     SELECT count(*)::int AS count FROM updated`,
    [userId],
  );
  return rows[0]?.count ?? 0;
}

/** Drop read notifications older than `days`, so the table stays small. */
export async function pruneRead(days = 60): Promise<number> {
  const rows = await query<{ count: number }>(
    `WITH deleted AS (
       DELETE FROM notifications
       WHERE read_at IS NOT NULL AND read_at < now() - ($1 || ' days')::interval
       RETURNING 1
     )
     SELECT count(*)::int AS count FROM deleted`,
    [String(days)],
  );
  return rows[0]?.count ?? 0;
}
