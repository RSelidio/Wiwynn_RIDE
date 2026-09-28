/**
 * Socket.IO client (spec §8).
 *
 * One connection per signed-in session, shared by every component through
 * `useSocket`. The employee app never needs to refresh to see a status change,
 * and the admin dashboard receives the dispatch snapshot without polling.
 */

'use client';

import React from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@shuttle/shared-types';
import { getAccessToken } from './api';

export type ShuttleSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

function socketUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SOCKET_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    'http://localhost:4000'
  ).replace(/\/$/, '');
}

interface SocketContextValue {
  socket: ShuttleSocket | null;
  connected: boolean;
}

const SocketContext = React.createContext<SocketContextValue>({ socket: null, connected: false });

export function SocketProvider({
  children,
  /** Connect only once the session is ready — the handshake needs the token. */
  enabled,
}: {
  children: React.ReactNode;
  enabled: boolean;
}) {
  const [socket, setSocket] = React.useState<ShuttleSocket | null>(null);
  const [connected, setConnected] = React.useState(false);

  React.useEffect(() => {
    if (!enabled) {
      setSocket(null);
      setConnected(false);
      return;
    }

    const instance: ShuttleSocket = io(socketUrl(), {
      // The token is read lazily, so a reconnect after a refresh picks up the
      // new access token rather than replaying the expired one.
      auth: (cb) => cb({ token: getAccessToken() ?? '' }),
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 10_000,
      timeout: 20_000,
    });

    instance.on('connect', () => setConnected(true));
    instance.on('disconnect', () => setConnected(false));
    instance.on('connect_error', () => setConnected(false));

    setSocket(instance);

    return () => {
      instance.removeAllListeners();
      instance.disconnect();
    };
  }, [enabled]);

  const value = React.useMemo(() => ({ socket, connected }), [socket, connected]);
  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketContextValue {
  return React.useContext(SocketContext);
}

/**
 * Subscribe to one server event for the lifetime of a component.
 *
 * The handler is kept in a ref so a component can use fresh state inside it
 * without re-subscribing on every render — which would otherwise detach and
 * reattach the listener several times a second.
 */
export function useSocketEvent<E extends keyof ServerToClientEvents>(
  event: E,
  handler: ServerToClientEvents[E],
): void {
  const { socket } = useSocket();
  const ref = React.useRef(handler);

  React.useEffect(() => {
    ref.current = handler;
  }, [handler]);

  React.useEffect(() => {
    if (socket == null) return;

    const listener = (...args: unknown[]) => {
      (ref.current as unknown as (...a: unknown[]) => void)(...args);
    };

    // socket.io-client types `on` with a conditional listener type that a
    // generic key cannot satisfy. The hook's own signature keeps callers
    // type-checked, so the registration itself is narrowed here instead.
    const emitter = socket as unknown as {
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      off: (event: string, listener: (...args: unknown[]) => void) => void;
    };

    emitter.on(event as string, listener);
    return () => {
      emitter.off(event as string, listener);
    };
  }, [socket, event]);
}

/** Watch one shuttle or a set of shuttles while a component is mounted. */
export function useShuttleSubscription(shuttleId: string | null | undefined | readonly string[]): void {
  const { socket, connected } = useSocket();
  const shuttleIds = React.useMemo(() => {
    const ids = Array.isArray(shuttleId) ? shuttleId : [shuttleId];
    return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))].sort();
  }, [shuttleId]);
  const subscriptionKey = shuttleIds.join(',');

  React.useEffect(() => {
    if (socket == null || !connected || shuttleIds.length === 0) return;

    for (const id of shuttleIds) socket.emit('shuttle:subscribe', { shuttleId: id });
    return () => {
      for (const id of shuttleIds) socket.emit('shuttle:unsubscribe', { shuttleId: id });
    };
  }, [socket, connected, subscriptionKey]);
}

/** Watch inbound ETAs for the stop the employee is waiting at. */
export function useStopSubscription(stopId: string | null | undefined): void {
  const { socket, connected } = useSocket();

  React.useEffect(() => {
    if (socket == null || !connected || stopId == null) return;

    socket.emit('stop:subscribe', { stopId });
    return () => {
      socket.emit('stop:unsubscribe', { stopId });
    };
  }, [socket, connected, stopId]);
}
