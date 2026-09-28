'use client';

import React from 'react';
import { humanizeEtaSec, shuttleStatusLabel } from '@shuttle/shared-utils';
import {
  Card,
  EmptyState,
  Mono,
  SeatBar,
  StatusPill,
  brand,
  fontSize,
  shuttleTone,
  useTheme,
  weight,
} from '@shuttle/ui';
import { AppShell } from '@/components/AppShell';
import { etaSecFor, useShuttleData } from '@/hooks/useShuttleData';

/**
 * Every shuttle with its live ETA to the employee's pickup stop (design 3a,
 * "Shuttles" tab).
 */
export default function ShuttlesPage() {
  return (
    <AppShell>
      <ShuttlesScreen />
    </AppShell>
  );
}

function ShuttlesScreen() {
  const { theme } = useTheme();
  const { loading, home, shuttles, positions, etas, activeRequest } = useShuttleData();

  // ETAs are shown to the stop the employee actually cares about: their live
  // request's pickup, or their usual stop when nothing is requested.
  const targetStopId =
    activeRequest?.pickupStopId ?? home?.stops.find((s) => s.kind !== 'dropoff')?.id ?? null;
  const targetStopName = home?.stops.find((s) => s.id === targetStopId)?.name;

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: theme.fg3, fontSize: fontSize.base }}>
        Loading…
      </div>
    );
  }

  const sorted = [...shuttles].sort((a, b) => {
    // On-shift first, then by ETA — the useful one should be at the top.
    const aOff = a.status === 'off_shift' || a.status === 'offline';
    const bOff = b.status === 'off_shift' || b.status === 'offline';
    if (aOff !== bOff) return aOff ? 1 : -1;

    const aEta = etaSecFor(etas, a.shuttle.id, targetStopId, a.nextStopEtaSec) ?? Number.POSITIVE_INFINITY;
    const bEta = etaSecFor(etas, b.shuttle.id, targetStopId, b.nextStopEtaSec) ?? Number.POSITIVE_INFINITY;
    return aEta - bEta;
  });

  return (
    <div
      className="sh-scroll"
      style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ margin: 0, fontSize: fontSize.xl, fontWeight: weight.semibold }}>All shuttles</h1>
        {targetStopName != null && (
          <Mono size={fontSize.xs} color={theme.fg3}>
            ETA to {targetStopName}
          </Mono>
        )}
      </div>

      {sorted.length === 0 && <EmptyState message="No shuttles are configured yet." />}

      {sorted.map((entry) => {
        const position = positions.get(entry.shuttle.id) ?? entry.position;
        const etaSec = etaSecFor(etas, entry.shuttle.id, targetStopId, entry.nextStopEtaSec);
        const offShift = entry.status === 'off_shift' || entry.status === 'offline';
        const assigned = entry.shuttle.id === activeRequest?.shuttleId;

        return (
          <Card key={entry.shuttle.id} padding={16} accentBorder={assigned}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    background: offShift ? '#8a96a3' : brand.blue,
                    color: '#fff',
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: fontSize.sm,
                    fontWeight: weight.semibold,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flex: 'none',
                  }}
                >
                  {entry.shuttle.code.replace(/\D/g, '') || '•'}
                </span>
                <div>
                  <div style={{ fontSize: fontSize.lg, fontWeight: weight.semibold }}>
                    {entry.shuttle.name}
                  </div>
                  <div style={{ fontSize: fontSize.sm, color: theme.fg3 }}>
                    {entry.driverName ?? 'No driver on shift'}
                    {entry.routeName != null && ` · ${entry.routeName}`}
                  </div>
                </div>
              </div>
              <StatusPill label={shuttleStatusLabel(entry.status)} tone={shuttleTone(entry.status)} />
            </div>

            <div
              style={{
                marginTop: 14,
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr',
                gap: 8,
              }}
            >
              <Figure
                label="Location"
                value={entry.atStopName ?? entry.nextStopName ?? (offShift ? 'Off shift' : 'En route')}
              />
              <Figure label="ETA to you" value={humanizeEtaSec(etaSec)} mono />
              <Figure
                label="Seats free"
                value={`${entry.seatsAvailable} / ${entry.shuttle.capacity}`}
                mono
              />
            </div>

            <div style={{ marginTop: 10 }}>
              <SeatBar occupied={entry.seatsOccupied} capacity={entry.shuttle.capacity} />
            </div>

            <div style={{ marginTop: 12, fontSize: fontSize.sm, color: theme.fg3 }}>
              {position == null
                ? 'No GPS signal yet'
                : position.isStale
                  ? `Last fix ${position.ageSec} s ago — position may be out of date`
                  : `GPS ${position.ageSec} s ago${
                      position.speedKmh != null ? ` · ${Math.round(position.speedKmh)} km/h` : ''
                    }`}
              {assigned && (
                <span style={{ color: brand.blue, fontWeight: weight.semibold }}> · assigned to your pickup</span>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function Figure({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const { theme } = useTheme();
  return (
    <div>
      <div style={{ fontSize: fontSize.xs, color: theme.fg3 }}>{label}</div>
      {mono === true ? (
        <Mono size={fontSize.base} bold color={brand.blueDeep}>
          {value}
        </Mono>
      ) : (
        <div style={{ fontSize: fontSize.base, fontWeight: weight.medium }}>{value}</div>
      )}
    </div>
  );
}
