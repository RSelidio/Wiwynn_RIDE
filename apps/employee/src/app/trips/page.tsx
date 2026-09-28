'use client';

import React from 'react';
import { api } from '@shuttle/client';
import type { TripView } from '@shuttle/shared-types';
import { formatDistance, formatDuration, formatRelativeDay, tripStatusLabel } from '@shuttle/shared-utils';
import { Card, EmptyState, Mono, StatusPill, fontSize, useTheme, weight } from '@shuttle/ui';
import { AppShell } from '@/components/AppShell';

/** Trip history (spec §1 — "View previous trips"). */
export default function TripsPage() {
  return (
    <AppShell>
      <TripsScreen />
    </AppShell>
  );
}

function TripsScreen() {
  const { theme } = useTheme();
  const [trips, setTrips] = React.useState<TripView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.me.trips(50);
        if (!cancelled) setTrips(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load your trips.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className="sh-scroll"
      style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <h1 style={{ margin: 0, fontSize: fontSize.xl, fontWeight: weight.semibold }}>My trips</h1>

      {error != null && <p style={{ color: '#8b1f1a', fontSize: fontSize.base }}>{error}</p>}

      {trips == null && error == null && (
        <p style={{ color: theme.fg3, fontSize: fontSize.base }}>Loading…</p>
      )}

      {trips != null && trips.length === 0 && (
        <EmptyState message="No trips yet. Request a pickup and it will appear here." />
      )}

      {trips?.map((trip) => {
        const durationSec =
          trip.arrivedAt == null
            ? null
            : (new Date(trip.arrivedAt).getTime() - new Date(trip.departedAt).getTime()) / 1000;

        return (
          <Card key={trip.id} padding={16}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: fontSize.md, fontWeight: weight.semibold }}>
                  {trip.originStopName} → {trip.destinationStopName}
                </div>
                <div style={{ fontSize: fontSize.sm, color: theme.fg3, marginTop: 2 }}>
                  {formatRelativeDay(trip.departedAt)} · {trip.shuttleName} · {trip.driverName}
                </div>
              </div>
              <StatusPill
                label={tripStatusLabel(trip.status)}
                tone={trip.status === 'completed' ? 'neutral' : trip.status === 'cancelled' ? 'danger' : 'info'}
              />
            </div>

            <div
              style={{
                marginTop: 12,
                paddingTop: 12,
                borderTop: `1px solid ${theme.border}`,
                display: 'flex',
                gap: 18,
                fontSize: fontSize.sm,
                color: theme.fg2,
              }}
            >
              <span>
                Trip <Mono size={fontSize.sm}>{trip.code}</Mono>
              </span>
              {durationSec != null && <span>{formatDuration(durationSec)}</span>}
              {trip.distanceM != null && <span>{formatDistance(trip.distanceM)}</span>}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
