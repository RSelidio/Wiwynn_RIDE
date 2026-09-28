/**
 * Background jobs.
 *
 * Plain intervals, not a job queue — every task here is idempotent, cheap and
 * safe to miss a tick, so Redis or a cron service would be infrastructure
 * without a purpose (spec §19).
 *
 * Note for a future scale-out: these run in-process, so two backend instances
 * would each run them. Everything is written to tolerate that (transitions are
 * guarded by an expected-status check, notices are keyed), but if a second
 * instance is ever added, move this behind a single-runner lock.
 */

import { config } from '../config';
import { logger } from '../logger';
import { pruneRefreshTokens } from '../services/auth.service';
import { broadcastSnapshot, runAutoAssign } from '../services/dispatch.service';
import { getAllBoards } from '../services/eta.service';
import { pruneHistory } from '../services/gps.service';
import { notifyEmployee, pruneRead } from '../services/notifications.service';
import { escalateLongWaits, expireStalePending, listOpen } from '../services/requests.service';
import { getSettings, primeSettings } from '../services/settings.service';
import { realtime } from '../realtime/bus';

const timers: NodeJS.Timeout[] = [];

/** Employees already told their shuttle is close, so we say it once. */
const approachNotified = new Set<string>();

/**
 * Run a task, logging rather than throwing.
 *
 * An unhandled rejection inside setInterval would take the process down and
 * PM2 would restart it — a failed prune must not do that.
 */
function safely(name: string, fn: () => Promise<unknown>): () => void {
  return () => {
    fn().catch((err) => logger.error({ err, job: name }, 'scheduled job failed'));
  };
}

function every(ms: number, name: string, fn: () => Promise<unknown>): void {
  const timer = setInterval(safely(name, fn), ms);
  // Do not hold the event loop open on shutdown.
  timer.unref();
  timers.push(timer);
}

/**
 * Notify employees whose shuttle is within the "approaching" window
 * (spec §8 — shuttle approaching).
 */
async function pushApproachingNotices(): Promise<void> {
  const settings = await getSettings();
  if (!settings.pushEtaEnabled) return;

  const thresholdSec = settings.approachingNoticeMin * 60;
  const open = await listOpen();

  const liveIds = new Set<string>();

  for (const request of open) {
    if (request.status !== 'accepted' || request.etaSec == null) continue;
    liveIds.add(request.id);

    if (request.etaSec > thresholdSec || approachNotified.has(request.id)) continue;

    approachNotified.add(request.id);
    await notifyEmployee(request.employeeId, {
      kind: 'shuttle_approaching',
      title: `${request.shuttleName ?? 'Your shuttle'} is arriving soon`,
      body: `Arriving at ${request.pickupStopName} in about ${settings.approachingNoticeMin} min`,
    });
  }

  // Forget requests that are no longer live, so the set cannot grow unbounded
  // and a repeat request is notified again.
  for (const id of approachNotified) {
    if (!liveIds.has(id)) approachNotified.delete(id);
  }
}

/** Recompute ETA boards and push them, so a stationary fleet still refreshes. */
async function refreshEtas(): Promise<void> {
  for (const board of await getAllBoards(true)) {
    realtime.shuttleEta({
      shuttleId: board.shuttleId,
      estimates: board.estimates,
      computedAt: board.computedAt,
    });
  }
}

export async function startScheduler(): Promise<void> {
  await primeSettings();

  // Dispatch overview — the dashboard's own socket updates cover most changes;
  // this is the backstop that keeps counts honest.
  every(10_000, 'dispatch.snapshot', broadcastSnapshot);

  // ETA refresh, independent of GPS arrival.
  every(15_000, 'eta.refresh', refreshEtas);

  // Approaching notices.
  every(20_000, 'notify.approaching', pushApproachingNotices);

  // Auto-assignment, when enabled in settings.
  every(15_000, 'dispatch.auto_assign', runAutoAssign);

  // Expire and escalate stale pending requests.
  every(60_000, 'requests.expire', async () => {
    const settings = await getSettings();
    const expired = await expireStalePending(settings.requestExpiryMin);
    const escalated = await escalateLongWaits(settings.longWaitAlertMin);
    if (expired > 0 || escalated > 0) {
      logger.info({ expired, escalated }, 'request housekeeping');
    }
  });

  // Daily housekeeping. Runs hourly and is cheap when there is nothing to do.
  every(3_600_000, 'prune', async () => {
    const [locations, notifications, tokens] = await Promise.all([
      pruneHistory(90),
      pruneRead(60),
      pruneRefreshTokens(),
    ]);
    if (locations + notifications + tokens > 0) {
      logger.info({ locations, notifications, tokens }, 'pruned old rows');
    }
  });

  logger.info(
    {
      jobs: timers.length,
      gpsPersistSec: config.gps.historyPersistSec,
    },
    'scheduler started',
  );
}

export function stopScheduler(): void {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
  approachNotified.clear();
}
