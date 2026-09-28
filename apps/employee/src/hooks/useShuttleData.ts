'use client';

import React from 'react';
import { api, useSocketEvent, useAuth, useShuttleSubscription, useStopSubscription, type EmployeeHome } from '@shuttle/client';
import type { EtaEstimate, LivePosition, PickupRequestView, ShuttleStatusView } from '@shuttle/shared-types';

/**
 * The employee app's live state.
 *
 * Loads the home bootstrap once, then keeps it current from socket events
 * (spec §8) rather than polling. Everything the three tabs render comes from
 * here, so a status change updates every screen at once.
 */
export interface ShuttleData {
  loading: boolean;
  error: string | null;
  home: EmployeeHome | null;
  /** The viewer's live request, or null when they have none. */
  activeRequest: PickupRequestView | null;
  shuttles: ShuttleStatusView[];
  /** Latest position per shuttle, overlaid on the loaded snapshot. */
  positions: Map<string, LivePosition>;
  /** Latest ETA estimates per shuttle. */
  etas: Map<string, EtaEstimate[]>;
  unreadCount: number;
  reload: () => Promise<void>;
  /** Optimistically replace the active request after an action. */
  setActiveRequest: (request: PickupRequestView | null) => void;
}

export function useShuttleData(): ShuttleData {
  const { status } = useAuth();

  const [home, setHome] = React.useState<EmployeeHome | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [activeRequest, setActiveRequest] = React.useState<PickupRequestView | null>(null);
  const [shuttles, setShuttles] = React.useState<ShuttleStatusView[]>([]);
  const [positions, setPositions] = React.useState<Map<string, LivePosition>>(new Map());
  const [etas, setEtas] = React.useState<Map<string, EtaEstimate[]>>(new Map());
  const [unreadCount, setUnreadCount] = React.useState(0);

  const load = React.useCallback(async () => {
    try {
      setError(null);
      const data = await api.me.home();
      setHome(data);
      setActiveRequest(data.activeRequest);
      setShuttles(data.shuttles);
      setUnreadCount(data.unreadCount);

      // Seed the position map from the snapshot so the map is populated on the
      // first paint, before any socket event arrives.
      const seeded = new Map<string, LivePosition>();
      for (const shuttle of data.shuttles) {
        if (shuttle.position != null) seeded.set(shuttle.shuttle.id, shuttle.position);
      }
      setPositions(seeded);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load shuttle information.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (status !== 'authenticated') return;
    void load();
  }, [status, load]);

  // The employee map displays the fleet, not only an assigned shuttle. Join
  // each shuttle room so fresh GPS fixes arrive without reloading the page.
  // Include an assigned shuttle even if it is absent from the initial snapshot.
  const visibleShuttleIds = React.useMemo(
    () => [...shuttles.map((shuttle) => shuttle.shuttle.id), activeRequest?.shuttleId ?? ''],
    [shuttles, activeRequest?.shuttleId],
  );
  useShuttleSubscription(visibleShuttleIds);
  useStopSubscription(activeRequest?.pickupStopId ?? home?.activeRequest?.pickupStopId ?? null);

  useSocketEvent(
    'shuttle:position',
    React.useCallback(({ shuttleId, position }) => {
      setPositions((previous) => new Map(previous).set(shuttleId, position));
    }, []),
  );

  useSocketEvent(
    'shuttle:eta',
    React.useCallback(({ shuttleId, estimates }) => {
      setEtas((previous) => new Map(previous).set(shuttleId, estimates));
    }, []),
  );

  useSocketEvent(
    'shuttle:status',
    React.useCallback(({ status: next }) => {
      setShuttles((previous) => {
        const index = previous.findIndex((s) => s.shuttle.id === next.shuttle.id);
        if (index === -1) return [...previous, next];
        const copy = [...previous];
        copy[index] = next;
        return copy;
      });
    }, []),
  );

  useSocketEvent(
    'request:changed',
    React.useCallback(({ request }) => {
      // Only the viewer's own request reaches this room, but guard anyway so a
      // future room change cannot make someone else's request appear.
      setActiveRequest((previous) => {
        if (previous != null && previous.id !== request.id) return previous;
        const terminal = ['completed', 'cancelled', 'rejected', 'expired'].includes(request.status);
        return terminal ? null : request;
      });

      // A finished trip belongs in the history list.
      if (request.status === 'completed') void load();
    }, [load]),
  );

  useSocketEvent(
    'notification:new',
    React.useCallback(() => {
      setUnreadCount((n) => n + 1);
    }, []),
  );

  return {
    loading,
    error,
    home,
    activeRequest,
    shuttles,
    positions,
    etas,
    unreadCount,
    reload: load,
    setActiveRequest,
  };
}

/**
 * The ETA in seconds for a shuttle to a stop, preferring the live socket value
 * over the one baked into the loaded request.
 */
export function etaSecFor(
  etas: Map<string, EtaEstimate[]>,
  shuttleId: string | null | undefined,
  stopId: string | null | undefined,
  fallback: number | null,
): number | null {
  if (shuttleId == null || stopId == null) return fallback;
  const estimate = etas.get(shuttleId)?.find((e) => e.stopId === stopId);
  return estimate?.etaSec ?? fallback;
}
