/**
 * Late-bound realtime bus.
 *
 * Services need to broadcast, and the socket layer needs services to answer
 * subscriptions — importing each other directly would be a cycle. Instead
 * services publish through this module and `realtime/io.ts` installs the real
 * emitter at startup. Before installation (and in unit tests) publishing is a
 * silent no-op, so a service can be exercised without a socket server.
 */

import type {
  DispatchSnapshotPayload,
  EtaUpdatePayload,
  GateLogChangedPayload,
  Notification,
  RequestChangedPayload,
  ShuttlePositionPayload,
  ShuttleStatusPayload,
  SystemSettings,
  TripChangedPayload,
} from '@shuttle/shared-types';

export interface RealtimeEmitter {
  shuttlePosition(payload: ShuttlePositionPayload): void;
  shuttleStatus(payload: ShuttleStatusPayload): void;
  shuttleEta(payload: EtaUpdatePayload): void;
  /** Fan out to dispatch, the employee, the assigned driver and the stop room. */
  requestChanged(payload: RequestChangedPayload): void;
  /** Offer a pending request to one driver. */
  requestOffered(driverId: string, payload: RequestChangedPayload): void;
  tripChanged(payload: TripChangedPayload): void;
  gateChanged(payload: GateLogChangedPayload): void;
  notification(userId: string, notification: Notification): void;
  dispatchSnapshot(payload: DispatchSnapshotPayload): void;
  settingsChanged(settings: SystemSettings): void;
}

const noop: RealtimeEmitter = {
  shuttlePosition: () => {},
  shuttleStatus: () => {},
  shuttleEta: () => {},
  requestChanged: () => {},
  requestOffered: () => {},
  tripChanged: () => {},
  gateChanged: () => {},
  notification: () => {},
  dispatchSnapshot: () => {},
  settingsChanged: () => {},
};

let emitter: RealtimeEmitter = noop;

export function installEmitter(next: RealtimeEmitter): void {
  emitter = next;
}

export function resetEmitter(): void {
  emitter = noop;
}

/** The live emitter. Read through a getter so callers always see the current one. */
export const realtime: RealtimeEmitter = {
  shuttlePosition: (p) => emitter.shuttlePosition(p),
  shuttleStatus: (p) => emitter.shuttleStatus(p),
  shuttleEta: (p) => emitter.shuttleEta(p),
  requestChanged: (p) => emitter.requestChanged(p),
  requestOffered: (d, p) => emitter.requestOffered(d, p),
  tripChanged: (p) => emitter.tripChanged(p),
  gateChanged: (p) => emitter.gateChanged(p),
  notification: (u, n) => emitter.notification(u, n),
  dispatchSnapshot: (p) => emitter.dispatchSnapshot(p),
  settingsChanged: (s) => emitter.settingsChanged(s),
};
