/**
 * Socket.IO event contract (spec §8).
 *
 * Both sides import these interfaces, so `io.emit` and `socket.on` are checked
 * against the same definition — a renamed payload field breaks the build rather
 * than silently going missing at runtime.
 *
 *   Backend:  new Server<ClientToServerEvents, ServerToClientEvents, …>(http)
 *   Client:   io<ServerToClientEvents, ClientToServerEvents>(url)
 */

import type {
  DashboardKpis,
  EtaEstimate,
  GateLogView,
  LivePosition,
  Notification,
  PickupRequestView,
  Role,
  ShuttleStatusView,
  StopWaitingSummary,
  SystemSettings,
  TripView,
} from './domain';

// ─────────────────────────────────────────────────────────────────────────────
// Rooms
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every socket joins exactly the rooms its role entitles it to. An employee
 * never joins `dispatch`, so fleet-wide traffic is not merely hidden in the UI —
 * it is never sent to that socket.
 */
export const ROOMS = {
  /** All admins. Receives fleet-wide traffic. */
  dispatch: 'dispatch',
  /** One room per employee, for their own requests and notifications. */
  employee: (employeeId: string) => `employee:${employeeId}`,
  /** One room per driver, for requests offered to them. */
  driver: (driverId: string) => `driver:${driverId}`,
  /** One room per shuttle, for position/ETA subscribers. */
  shuttle: (shuttleId: string) => `shuttle:${shuttleId}`,
  /** One room per stop, so a waiting employee gets inbound ETAs. */
  stop: (stopId: string) => `stop:${stopId}`,
  /** Guards on the gate tablet. */
  gate: (gateId: string) => `gate:${gateId}`,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Payloads
// ─────────────────────────────────────────────────────────────────────────────

/** A GPS fix pushed up by a driver device every GPS_PUSH_INTERVAL_SEC. */
export interface GpsPushPayload {
  shuttleId: string;
  shiftId: string;
  latitude: number;
  longitude: number;
  speedKmh?: number | null;
  headingDeg?: number | null;
  accuracyM?: number | null;
  /** Device clock, ISO-8601. The backend keeps it but trusts its own clock for staleness. */
  recordedAt: string;
}

export interface ShuttlePositionPayload {
  shuttleId: string;
  position: LivePosition;
}

export interface EtaUpdatePayload {
  shuttleId: string;
  estimates: EtaEstimate[];
  computedAt: string;
}

export interface RequestChangedPayload {
  request: PickupRequestView;
  /** What moved it, so clients can pick the right toast without diffing. */
  reason:
    | 'created'
    | 'accepted'
    | 'rejected'
    | 'arrived'
    | 'boarding'
    | 'completed'
    | 'cancelled'
    | 'expired'
    | 'reassigned';
  /** Who caused it. Null for system actions such as expiry or auto-assign. */
  actorUserId: string | null;
}

export interface ShuttleStatusPayload {
  status: ShuttleStatusView;
}

export interface TripChangedPayload {
  trip: TripView;
  reason: 'started' | 'completed' | 'cancelled';
}

export interface GateLogChangedPayload {
  entry: GateLogView;
  reason: 'checked_in' | 'checked_out' | 'edited' | 'removed';
}

export interface DispatchSnapshotPayload {
  kpis: DashboardKpis;
  shuttles: ShuttleStatusView[];
  openRequests: PickupRequestView[];
  stops: StopWaitingSummary[];
}

/** Server-side problem a client should surface rather than swallow. */
export interface SocketErrorPayload {
  code: string;
  message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event maps
// ─────────────────────────────────────────────────────────────────────────────

export interface ServerToClientEvents {
  'connection:ready': (payload: { userId: string; role: Role; rooms: string[] }) => void;
  'error:raised': (payload: SocketErrorPayload) => void;

  'shuttle:position': (payload: ShuttlePositionPayload) => void;
  'shuttle:status': (payload: ShuttleStatusPayload) => void;
  'shuttle:eta': (payload: EtaUpdatePayload) => void;

  'request:changed': (payload: RequestChangedPayload) => void;
  /** Sent only into a driver's own room — a pickup being offered to them. */
  'request:offered': (payload: RequestChangedPayload) => void;

  'trip:changed': (payload: TripChangedPayload) => void;
  'gate:changed': (payload: GateLogChangedPayload) => void;

  'notification:new': (payload: { notification: Notification }) => void;

  /** Dispatch-room only: the whole overview, sent on join and then on a timer. */
  'dispatch:snapshot': (payload: DispatchSnapshotPayload) => void;
  'settings:changed': (payload: { settings: SystemSettings }) => void;
}

export interface ClientToServerEvents {
  /** Driver device pushes a fix. Ack reports whether it was accepted. */
  'gps:push': (
    payload: GpsPushPayload,
    ack?: (result: { ok: boolean; error?: string }) => void,
  ) => void;

  /** Watch a shuttle's position/ETA (employee tracking, admin map). */
  'shuttle:subscribe': (payload: { shuttleId: string }) => void;
  'shuttle:unsubscribe': (payload: { shuttleId: string }) => void;

  /** Watch inbound ETAs for a stop the employee is waiting at. */
  'stop:subscribe': (payload: { stopId: string }) => void;
  'stop:unsubscribe': (payload: { stopId: string }) => void;

  /** Admin-only: ask for a fresh snapshot instead of waiting for the timer. */
  'dispatch:refresh': () => void;
}

/** Events emitted between backend instances. Single-instance today; Redis adapter later. */
export interface InterServerEvents {
  ping: () => void;
}

/** Attached to every authenticated socket by the handshake middleware. */
export interface SocketData {
  userId: string;
  role: Role;
  employeeId: string | null;
  driverId: string | null;
  displayName: string;
}
