/**
 * Socket.IO server (spec §8).
 *
 * Runs on the company's own backend — no third-party realtime service. Every
 * connection is authenticated during the handshake and joined only to the rooms
 * its role entitles it to, so fleet-wide traffic is never delivered to an
 * employee's phone in the first place.
 */

import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  DispatchSnapshotPayload,
  EtaUpdatePayload,
  GateLogChangedPayload,
  InterServerEvents,
  Notification,
  RequestChangedPayload,
  ServerToClientEvents,
  ShuttlePositionPayload,
  ShuttleStatusPayload,
  SocketData,
  SystemSettings,
  TripChangedPayload,
} from '@shuttle/shared-types';
import { ROOMS } from '@shuttle/shared-types';
import { config } from '../config';
import { logger } from '../logger';
import { verifyAccessToken } from '../services/auth.service';
import { getBoard } from '../services/eta.service';
import { ingestFix } from '../services/gps.service';
import { assertOwnedOpenShift } from '../services/shifts.service';
import { getStatus } from '../services/shuttles.service';
import { buildSnapshot } from '../services/dispatch.service';
import { autoArriveAtPickupStops } from '../services/requests.service';
import { installEmitter, type RealtimeEmitter } from './bus';

type ShuttleSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

type ShuttleServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

let io: ShuttleServer | null = null;

/** Per-user room, so a notification reaches every device that person is on. */
function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** Rooms a socket joins, decided entirely by its role. */
function roomsFor(data: SocketData): string[] {
  const rooms: string[] = [userRoom(data.userId)];

  switch (data.role) {
    case 'admin':
      rooms.push(ROOMS.dispatch);
      break;
    case 'driver':
      if (data.driverId != null) rooms.push(ROOMS.driver(data.driverId));
      break;
    case 'employee':
      if (data.employeeId != null) rooms.push(ROOMS.employee(data.employeeId));
      break;
    case 'guard':
      // Guards see gate traffic only. The gate id is joined on demand.
      break;
  }

  return rooms;
}

export function createSocketServer(httpServer: HttpServer): ShuttleServer {
  io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
    httpServer,
    {
      cors: { origin: config.http.corsOrigins, credentials: true },
      // Long-lived mobile connections on flaky campus wifi: be patient before
      // declaring a client gone, or a driver's socket churns all day.
      pingInterval: 25_000,
      pingTimeout: 60_000,
      // The driver app sends small JSON fixes; cap the payload well below
      // anything that could be used to exhaust memory.
      maxHttpBufferSize: 64 * 1024,
    },
  );

  // ── Handshake authentication ───────────────────────────────────────────
  io.use((socket, next) => {
    const token =
      (socket.handshake.auth as { token?: string } | undefined)?.token ??
      (typeof socket.handshake.query.token === 'string' ? socket.handshake.query.token : null);

    if (token == null) return next(new Error('UNAUTHORIZED'));

    try {
      const claims = verifyAccessToken(token);
      socket.data.userId = claims.sub;
      socket.data.role = claims.role;
      socket.data.employeeId = claims.employeeId;
      socket.data.driverId = claims.driverId;
      socket.data.displayName = '';
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const rooms = roomsFor(socket.data);
    for (const room of rooms) void socket.join(room);

    logger.debug({ userId: socket.data.userId, role: socket.data.role, rooms }, 'socket connected');

    socket.emit('connection:ready', {
      userId: socket.data.userId,
      role: socket.data.role,
      rooms,
    });

    // An admin gets the full picture straight away rather than waiting for the
    // next timer tick.
    if (socket.data.role === 'admin') {
      void buildSnapshot()
        .then((snapshot) => socket.emit('dispatch:snapshot', snapshot))
        .catch((err) => logger.error({ err }, 'initial snapshot failed'));
    }

    registerHandlers(socket);

    socket.on('disconnect', (reason) => {
      logger.debug({ userId: socket.data.userId, reason }, 'socket disconnected');
    });
  });

  installEmitter(buildEmitter(io));
  return io;
}

function registerHandlers(socket: ShuttleSocket): void {
  // ── GPS ingest (spec §3) ───────────────────────────────────────────────
  socket.on('gps:push', (payload, ack) => {
    void (async () => {
      if (socket.data.role !== 'driver' || socket.data.driverId == null) {
        ack?.({ ok: false, error: 'Only a driver device may push GPS' });
        return;
      }

      try {
        // The shift must belong to this driver and still be open, otherwise a
        // stale device could keep reporting a shuttle someone else now drives.
        const shift = await assertOwnedOpenShift(payload.shiftId, socket.data.driverId);
        if (shift.shuttleId !== payload.shuttleId) {
          ack?.({ ok: false, error: 'That shuttle is not on your shift' });
          return;
        }

        const { position } = await ingestFix(payload, socket.data.driverId);

        await autoArriveAtPickupStops(
          payload.shuttleId,
          socket.data.driverId,
          socket.data.userId,
        );

        // Position goes to whoever is watching this shuttle, plus dispatch.
        const positionPayload: ShuttlePositionPayload = {
          shuttleId: payload.shuttleId,
          position,
        };
        socket.nsp.to(ROOMS.shuttle(payload.shuttleId)).emit('shuttle:position', positionPayload);
        socket.nsp.to(ROOMS.dispatch).emit('shuttle:position', positionPayload);

        // Recomputing the board is throttled inside the ETA service, so this
        // is cheap even at a 5-second push cadence.
        const board = await getBoard(payload.shuttleId);
        if (board != null) {
          const etaPayload: EtaUpdatePayload = {
            shuttleId: board.shuttleId,
            estimates: board.estimates,
            computedAt: board.computedAt,
          };
          socket.nsp.to(ROOMS.shuttle(payload.shuttleId)).emit('shuttle:eta', etaPayload);
          socket.nsp.to(ROOMS.dispatch).emit('shuttle:eta', etaPayload);

          // Anyone waiting at a stop this shuttle is inbound to.
          for (const estimate of board.estimates) {
            socket.nsp.to(ROOMS.stop(estimate.stopId)).emit('shuttle:eta', etaPayload);
          }
        }

        ack?.({ ok: true });
      } catch (err) {
        logger.warn({ err, driverId: socket.data.driverId }, 'gps push rejected');
        ack?.({ ok: false, error: err instanceof Error ? err.message : 'Rejected' });
      }
    })();
  });

  // ── Subscriptions ──────────────────────────────────────────────────────
  socket.on('shuttle:subscribe', ({ shuttleId }) => {
    void (async () => {
      if (typeof shuttleId !== 'string') return;
      await socket.join(ROOMS.shuttle(shuttleId));

      // Send the current state immediately so the UI is not blank until the
      // next fix arrives.
      try {
        const status = await getStatus(shuttleId);
        const payload: ShuttleStatusPayload = { status };
        socket.emit('shuttle:status', payload);
        if (status.position != null) {
          socket.emit('shuttle:position', { shuttleId, position: status.position });
        }
        const board = await getBoard(shuttleId);
        if (board != null) {
          socket.emit('shuttle:eta', {
            shuttleId,
            estimates: board.estimates,
            computedAt: board.computedAt,
          });
        }
      } catch (err) {
        logger.debug({ err, shuttleId }, 'shuttle subscribe snapshot failed');
      }
    })();
  });

  socket.on('shuttle:unsubscribe', ({ shuttleId }) => {
    if (typeof shuttleId === 'string') void socket.leave(ROOMS.shuttle(shuttleId));
  });

  socket.on('stop:subscribe', ({ stopId }) => {
    if (typeof stopId === 'string') void socket.join(ROOMS.stop(stopId));
  });

  socket.on('stop:unsubscribe', ({ stopId }) => {
    if (typeof stopId === 'string') void socket.leave(ROOMS.stop(stopId));
  });

  socket.on('dispatch:refresh', () => {
    void (async () => {
      if (socket.data.role !== 'admin') {
        socket.emit('error:raised', {
          code: 'FORBIDDEN',
          message: 'Only an administrator may request a dispatch snapshot',
        });
        return;
      }
      try {
        socket.emit('dispatch:snapshot', await buildSnapshot());
      } catch (err) {
        logger.error({ err }, 'dispatch refresh failed');
      }
    })();
  });
}

/**
 * The emitter installed on the bus.
 *
 * Fan-out is decided here rather than at each call site, so a service says
 * "this request changed" once and every interested party is reached.
 */
function buildEmitter(server: ShuttleServer): RealtimeEmitter {
  return {
    shuttlePosition(payload: ShuttlePositionPayload) {
      server.to(ROOMS.shuttle(payload.shuttleId)).emit('shuttle:position', payload);
      server.to(ROOMS.dispatch).emit('shuttle:position', payload);
    },

    shuttleStatus(payload: ShuttleStatusPayload) {
      server.to(ROOMS.shuttle(payload.status.shuttle.id)).emit('shuttle:status', payload);
      server.to(ROOMS.dispatch).emit('shuttle:status', payload);
    },

    shuttleEta(payload: EtaUpdatePayload) {
      server.to(ROOMS.shuttle(payload.shuttleId)).emit('shuttle:eta', payload);
      server.to(ROOMS.dispatch).emit('shuttle:eta', payload);
    },

    requestChanged(payload: RequestChangedPayload) {
      const { request } = payload;

      server.to(ROOMS.dispatch).emit('request:changed', payload);
      server.to(ROOMS.employee(request.employeeId)).emit('request:changed', payload);
      server.to(ROOMS.stop(request.pickupStopId)).emit('request:changed', payload);

      if (request.driverId != null) {
        server.to(ROOMS.driver(request.driverId)).emit('request:changed', payload);
      }
      if (request.shuttleId != null) {
        server.to(ROOMS.shuttle(request.shuttleId)).emit('request:changed', payload);
      }
    },

    requestOffered(driverId: string, payload: RequestChangedPayload) {
      server.to(ROOMS.driver(driverId)).emit('request:offered', payload);
    },

    tripChanged(payload: TripChangedPayload) {
      server.to(ROOMS.dispatch).emit('trip:changed', payload);
      server.to(ROOMS.driver(payload.trip.driverId)).emit('trip:changed', payload);
      server.to(ROOMS.shuttle(payload.trip.shuttleId)).emit('trip:changed', payload);
    },

    gateChanged(payload: GateLogChangedPayload) {
      server.to(ROOMS.gate(payload.entry.gateId)).emit('gate:changed', payload);
      server.to(ROOMS.dispatch).emit('gate:changed', payload);
    },

    notification(userId: string, notification: Notification) {
      // Every socket joins its own user room on connect, so this reaches all of
      // that person's devices without scanning the connection list.
      server.to(userRoom(userId)).emit('notification:new', { notification });
    },

    dispatchSnapshot(payload: DispatchSnapshotPayload) {
      server.to(ROOMS.dispatch).emit('dispatch:snapshot', payload);
    },

    settingsChanged(settings: SystemSettings) {
      server.to(ROOMS.dispatch).emit('settings:changed', { settings });
    },
  };
}

/** Join a guard's socket to a gate room — called after they pick a gate. */
export async function joinGateRoom(userId: string, gateId: string): Promise<void> {
  if (io == null) return;
  for (const socket of await io.fetchSockets()) {
    if (socket.data.userId === userId) await socket.join(ROOMS.gate(gateId));
  }
}

export function getIo(): ShuttleServer | null {
  return io;
}

export async function closeSocketServer(): Promise<void> {
  if (io == null) return;
  await io.close();
  io = null;
}
