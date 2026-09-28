/**
 * Display formatting. Shared so the employee PWA, driver app and admin
 * dashboard render the same value identically — a request that reads
 * "14:09" in one surface must not read "2:09 PM" in another.
 */

import type { RequestStatus, ShuttleOperationalStatus, TripStatus } from '@shuttle/shared-types';

/** Company operating timezone (El Paso, Texas; observes Mountain Daylight Time). */
export const APP_TIME_ZONE = 'America/Denver';

type DateTimePart = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second';

function zonedParts(value: Date, fields: readonly DateTimePart[]): Partial<Record<DateTimePart, number>> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(fields.includes('hour') ? { hour: '2-digit' as const, hourCycle: 'h23' as const } : {}),
    ...(fields.includes('minute') ? { minute: '2-digit' as const } : {}),
    ...(fields.includes('second') ? { second: '2-digit' as const } : {}),
  }).formatToParts(value);

  return Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as Partial<Record<DateTimePart, number>>;
}

function dateKey(parts: Partial<Record<DateTimePart, number>>): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(
    parts.day,
  ).padStart(2, '0')}`;
}

/** A calendar date in the company timezone, for date inputs and report filters. */
export function appDateKey(value: Date = new Date()): string {
  return dateKey(zonedParts(value, ['year', 'month', 'day']));
}

/** Move a YYYY-MM-DD calendar date by whole days (independent of DST). */
export function shiftDateKey(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
    date.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** Convert an instant to a datetime-local control value in the company timezone. */
export function appDateTimeInput(value: string | Date | null): string {
  if (value == null) return '';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  const parts = zonedParts(date, ['year', 'month', 'day', 'hour', 'minute', 'second']);
  return `${dateKey(parts)}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(
    2,
    '0',
  )}:${String(parts.second).padStart(2, '0')}`;
}

/** Convert a datetime-local wall time in El Paso to an ISO instant. */
export function appDateTimeInputToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (match == null) return null;

  const desired = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  const normalizedValue = `${dateKey(desired)}T${String(desired.hour).padStart(2, '0')}:${String(
    desired.minute,
  ).padStart(2, '0')}:${String(desired.second).padStart(2, '0')}`;
  const wallAsUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
    desired.second,
  );
  let instant = wallAsUtc;

  // Resolve the timezone offset iteratively; the offset can change at DST boundaries.
  for (let i = 0; i < 3; i++) {
    const actual = zonedParts(new Date(instant), ['year', 'month', 'day', 'hour', 'minute', 'second']);
    const actualAsUtc = Date.UTC(
      actual.year!,
      actual.month! - 1,
      actual.day!,
      actual.hour,
      actual.minute,
      actual.second,
    );
    instant += wallAsUtc - actualAsUtc;
  }

  const resolved = new Date(instant);
  // Reject nonexistent wall times during the spring-forward DST gap.
  return appDateTimeInput(resolved) === normalizedValue ? resolved.toISOString() : null;
}

/** 24-hour clock, e.g. "14:09". The company operates on a 24-hour schedule. */
export function formatTime(iso: string | Date | null): string {
  if (iso == null) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '—';
  const parts = zonedParts(d, ['hour', 'minute']);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

/** 24-hour clock with seconds, e.g. "14:09:32" — used on the gate log. */
export function formatTimeWithSeconds(iso: string | Date | null): string {
  if (iso == null) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '—';
  const parts = zonedParts(d, ['hour', 'minute', 'second']);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(
    parts.second,
  ).padStart(2, '0')}`;
}

/** "2026-09-25" — stable across locales, safe as a query parameter. */
export function formatDateIso(iso: string | Date | null): string {
  if (iso == null) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  return dateKey(zonedParts(d, ['year', 'month', 'day']));
}

/** "Today · 14:09", "Yesterday · 18:12", "Mon · 08:37", "23 Sep · 08:37". */
export function formatRelativeDay(iso: string | Date | null, now: Date = new Date()): string {
  if (iso == null) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '—';

  const nowParts = zonedParts(now, ['year', 'month', 'day']);
  const dateParts = zonedParts(d, ['year', 'month', 'day']);
  const dayDiff = Math.round(
    (Date.parse(`${dateKey(nowParts)}T00:00:00Z`) - Date.parse(`${dateKey(dateParts)}T00:00:00Z`)) /
      86_400_000,
  );
  const time = formatTime(d);

  if (dayDiff === 0) return `Today · ${time}`;
  if (dayDiff === 1) return `Yesterday · ${time}`;
  if (dayDiff > 1 && dayDiff < 7) {
    const weekday = new Date(`${dateKey(dateParts)}T00:00:00Z`).getUTCDay();
    return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday]} · ${time}`;
  }
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIME_ZONE,
    day: 'numeric',
    month: 'short',
  }).format(d);
  return `${dateLabel} · ${time}`;
}

/** "4 s ago", "42 s ago", "3 min ago" — for GPS fix age. */
export function formatAge(seconds: number | null): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/** "12 min", "1 h 04 min" — for dwell and wait durations. */
export function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** "1.8 km" above a kilometre, "640 m" below it. */
export function formatDistance(meters: number | null): string {
  if (meters == null) return '—';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** "7 / 12" */
export function formatSeats(available: number, capacity: number): string {
  return `${available} / ${capacity}`;
}

/** "2 passengers" / "1 passenger" */
export function formatPassengers(count: number): string {
  return `${count} ${count === 1 ? 'passenger' : 'passengers'}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status labels
// ─────────────────────────────────────────────────────────────────────────────

const REQUEST_LABELS: Record<RequestStatus, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  arrived: 'Arrived',
  boarding: 'Boarding',
  completed: 'Completed',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
  expired: 'Expired',
};

export function requestStatusLabel(status: RequestStatus): string {
  return REQUEST_LABELS[status];
}

/** What the *employee* should read — phrased from their point of view. */
const EMPLOYEE_LABELS: Record<RequestStatus, string> = {
  pending: 'Waiting for driver',
  accepted: 'Driver accepted',
  arrived: 'Shuttle has arrived',
  boarding: 'Trip in progress',
  completed: 'Trip completed',
  cancelled: 'Pickup cancelled',
  rejected: 'No shuttle available',
  expired: 'Request expired',
};

export function employeeStatusLabel(status: RequestStatus): string {
  return EMPLOYEE_LABELS[status];
}

const SHUTTLE_LABELS: Record<ShuttleOperationalStatus, string> = {
  off_shift: 'Off shift',
  offline: 'Offline',
  en_route: 'En route',
  at_stop: 'At stop',
  full: 'Full',
};

export function shuttleStatusLabel(status: ShuttleOperationalStatus): string {
  return SHUTTLE_LABELS[status];
}

const TRIP_LABELS: Record<TripStatus, string> = {
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export function tripStatusLabel(status: TripStatus): string {
  return TRIP_LABELS[status];
}

/** Initials for an avatar chip: "Marcus Lin" → "ML". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Escape one CSV field, quoting always so embedded commas cannot split a row. */
export function csvField(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

/** Build a CSV document from a header row and body rows. */
export function toCsv(header: readonly string[], rows: readonly unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n');
}
