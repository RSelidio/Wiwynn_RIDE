'use client';

import React from 'react';
import { api, useAuth, useSocket, useSocketEvent } from '@shuttle/client';
import { formatTime } from '@shuttle/shared-utils';
import type {
  DashboardKpis,
  DispatchSnapshotPayload,
  EtaEstimate,
  LivePosition,
  PickupRequestView,
  ShuttleStatusView,
  StopWaitingSummary,
} from '@shuttle/shared-types';

export interface DispatchEvent {
  time: string;
  text: string;
  tone: 'normal' | 'warn' | 'danger';
}

export interface DispatchState {
  loading: boolean;
  error: string | null;
  kpis: DashboardKpis | null;
  shuttles: ShuttleStatusView[];
  openRequests: PickupRequestView[];
  stops: StopWaitingSummary[];
  positions: Map<string, LivePosition>;
  etas: Map<string, EtaEstimate[]>;
  /** Locally accumulated activity feed, newest first. */
  events: DispatchEvent[];
  connected: boolean;
  refresh: () => void;
}

const MAX_EVENTS = 60;

function clockNow(): string {
  return formatTime(new Date());
}

/**
 * The dispatcher's live state.
 *
 * The backend pushes a whole snapshot on join and then every ten seconds, and
 * individual changes arrive in between. Applying both means the counts stay
 * exact even if a single event is missed, without polling.
 */
export function useDispatch(): DispatchState {
  const { status } = useAuth();
  const { socket, connected } = useSocket();

  const [snapshot, setSnapshot] = React.useState<DispatchSnapshotPayload | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [positions, setPositions] = React.useState<Map<string, LivePosition>>(new Map());
  const [etas, setEtas] = React.useState<Map<string, EtaEstimate[]>>(new Map());
  const [events, setEvents] = React.useState<DispatchEvent[]>([]);

  const pushEvent = React.useCallback((text: string, tone: DispatchEvent['tone'] = 'normal') => {
    setEvents((previous) => [{ time: clockNow(), text, tone }, ...previous].slice(0, MAX_EVENTS));
  }, []);

  const load = React.useCallback(async () => {
    try {
      setError(null);
      const data = await api.admin.snapshot();
      setSnapshot(data);

      const seeded = new Map<string, LivePosition>();
      for (const shuttle of data.shuttles) {
        if (shuttle.position != null) seeded.set(shuttle.shuttle.id, shuttle.position);
      }
      setPositions(seeded);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the dashboard.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (status !== 'authenticated') return;
    void load();
  }, [status, load]);

  useSocketEvent(
    'dispatch:snapshot',
    React.useCallback((payload: DispatchSnapshotPayload) => {
      setSnapshot(payload);
      setLoading(false);
    }, []),
  );

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
      setSnapshot((previous) => {
        if (previous == null) return previous;
        const index = previous.shuttles.findIndex((s) => s.shuttle.id === next.shuttle.id);
        const shuttles = [...previous.shuttles];
        if (index === -1) shuttles.push(next);
        else shuttles[index] = next;
        return { ...previous, shuttles };
      });
    }, []),
  );

  useSocketEvent(
    'request:changed',
    React.useCallback(
      ({ request, reason }) => {
        setSnapshot((previous) => {
          if (previous == null) return previous;

          const stillOpen = ['pending', 'accepted', 'arrived', 'boarding'].includes(request.status);
          const others = previous.openRequests.filter((r) => r.id !== request.id);

          return {
            ...previous,
            openRequests: stillOpen
              ? [...others, request].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
              : others,
          };
        });

        const label =
          reason === 'created'
            ? `${request.code} created · ${request.pickupStopName} · ${request.passengerCount} pax`
            : reason === 'accepted'
              ? `${request.shuttleName ?? 'A shuttle'} accepted ${request.code}`
              : `${request.code} → ${request.status}`;

        pushEvent(
          label,
          reason === 'cancelled' || reason === 'rejected'
            ? 'danger'
            : reason === 'expired'
              ? 'warn'
              : 'normal',
        );
      },
      [pushEvent],
    ),
  );

  useSocketEvent(
    'trip:changed',
    React.useCallback(
      ({ trip, reason }) => {
        pushEvent(
          `Trip ${trip.code} ${reason} · ${trip.passengerCount} pax`,
          reason === 'cancelled' ? 'warn' : 'normal',
        );
      },
      [pushEvent],
    ),
  );

  useSocketEvent(
    'gate:changed',
    React.useCallback(
      ({ entry, reason }) => {
        pushEvent(`Gate: ${entry.shuttleName} ${reason.replace('_', ' ')} · ${entry.code}`);
      },
      [pushEvent],
    ),
  );

  const refresh = React.useCallback(() => {
    if (socket != null && connected) socket.emit('dispatch:refresh');
    else void load();
  }, [socket, connected, load]);

  return {
    loading,
    error,
    kpis: snapshot?.kpis ?? null,
    shuttles: snapshot?.shuttles ?? [],
    openRequests: snapshot?.openRequests ?? [],
    stops: snapshot?.stops ?? [],
    positions,
    etas,
    events,
    connected,
    refresh,
  };
}
