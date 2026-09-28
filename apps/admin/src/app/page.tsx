'use client';

import React from 'react';
import { api, ApiRequestError } from '@shuttle/client';
import type { PickupRequestView, Stop } from '@shuttle/shared-types';
import { formatTime, humanizeEtaSec, requestStatusLabel, shuttleStatusLabel } from '@shuttle/shared-utils';
import {
  Button,
  CampusMap,
  Card,
  Mono,
  SeatBar,
  StatTile,
  StatusPill,
  Timeline,
  Toast,
  brand,
  fontSize,
  requestTone,
  shuttleTone,
  useTheme,
  weight,
  type MapShuttle,
} from '@shuttle/ui';
import { AdminShell } from '@/components/AdminShell';
import { DataTable, cell, type Column } from '@/components/DataTable';
import { RequestDrawer } from '@/components/RequestDrawer';
import { useDispatch } from '@/hooks/useDispatch';

const LIVE_COLUMNS: Column[] = [
  { header: 'ID', width: '100px' },
  { header: 'Employee', width: '1.2fr' },
  { header: 'Pickup', width: '1fr' },
  { header: 'Destination', width: '1fr' },
  { header: 'Pax', width: '60px' },
  { header: 'Shuttle', width: '110px' },
  { header: 'ETA', width: '90px' },
  { header: 'Status', width: '120px' },
];

export default function OverviewPage() {
  const { theme } = useTheme();
  const dispatch = useDispatch();
  const [selected, setSelected] = React.useState<PickupRequestView | null>(null);
  const [navigationPaths, setNavigationPaths] = React.useState<Map<string, Array<{ latitude: number; longitude: number }> | null>>(new Map());
  const [toast, setToast] = React.useState<string | null>(null);
  const [showAllEvents, setShowAllEvents] = React.useState(false);

  // The snapshot's stop summaries carry waiting counts but no coordinates, and
  // the map needs real ones to project against — so load the stop list itself.
  const [mapStops, setMapStops] = React.useState<Stop[]>([]);
  React.useEffect(() => {
    void api.fleet
      .stops()
      .then(setMapStops)
      .catch(() => setMapStops([]));
  }, []);

  const flash = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2_600);
  };

  const { kpis, shuttles, openRequests, stops, positions, etas, events } = dispatch;

  // Keep the drawer's copy of the request in step with incoming socket updates.
  React.useEffect(() => {
    if (selected == null) return;
    const fresh = openRequests.find((r) => r.id === selected.id);
    if (fresh != null && fresh.updatedAt !== selected.updatedAt) setSelected(fresh);
  }, [openRequests, selected]);

  const pending = openRequests.filter((r) => r.status === 'pending');

  const mapShuttles: MapShuttle[] = shuttles.flatMap((entry, colorIndex) => {
    const position = positions.get(entry.shuttle.id) ?? entry.position;
    if (position == null) return [];

    return [
      {
        shuttleId: entry.shuttle.id,
        colorIndex,
        routeId: entry.routeId,
        nextStopId: entry.nextStopId,
        remainingPath: navigationPaths.get(entry.shuttle.id) ?? null,
        name: entry.shuttle.name,
        badge: entry.shuttle.code.replace(/\D/g, '') || '•',
        position,
        focused: true,
        etaLabel: entry.nextStopName == null ? undefined : `${entry.nextStopName} ${humanizeEtaSec(entry.nextStopEtaSec)}`,
        subLabel: `${entry.seatsOccupied}/${entry.shuttle.capacity} · ${
          position.speedKmh != null ? `${Math.round(position.speedKmh)} km/h · ` : ''
        }${position.ageSec}s ago`,
      },
    ];
  });

  React.useEffect(() => {
    let cancelled = false;
    for (const shuttle of shuttles) {
      const position = positions.get(shuttle.shuttle.id) ?? shuttle.position;
      if (shuttle.routeId == null || shuttle.nextStopId == null || position == null || position.isStale) continue;
      const targetStopId = selected?.shuttleId === shuttle.shuttle.id
        ? selected.destinationStopId
        : shuttle.nextStopId;
      void api.fleet.navigationPath(shuttle.shuttle.id, targetStopId).then((remainingPath) => {
        if (cancelled) return;
        setNavigationPaths((previous) => {
          const next = new Map(previous);
          next.set(shuttle.shuttle.id, remainingPath);
          return next;
        });
      }).catch(() => {
        if (!cancelled) {
          setNavigationPaths((previous) => {
            const next = new Map(previous);
            next.set(shuttle.shuttle.id, null);
            return next;
          });
        }
      });
    }
    return () => { cancelled = true; };
  }, [selected?.shuttleId, selected?.destinationStopId, shuttles, positions]);

  const assignNext = async () => {
    if (pending.length === 0) {
      flash('No pending requests to assign');
      return;
    }
    setSelected(pending[0]!);
  };

  const runAutoAssign = async () => {
    try {
      const { assigned } = await api.admin.autoAssign();
      flash(assigned === 0 ? 'Nothing could be auto-assigned' : `Auto-assigned ${assigned} request(s)`);
    } catch (err) {
      flash(err instanceof ApiRequestError ? err.message : 'Auto-assign failed');
    }
  };

  const etaFor = (request: PickupRequestView): string => {
    if (request.shuttleId == null) return '—';
    const live = etas.get(request.shuttleId)?.find((e) => e.stopId === request.pickupStopId);
    return humanizeEtaSec(live?.etaSec ?? request.etaSec);
  };

  return (
    <AdminShell
      section={`Monitor · ${kpis?.computedAt != null ? formatTime(kpis.computedAt) : '—'}`}
      title="Live overview"
      badges={{ '/requests': openRequests.length }}
      actions={
        <>
          <Button variant="secondary" height={34} onClick={() => void runAutoAssign()}>
            Auto-assign
          </Button>
          <Button height={34} onClick={() => void assignNext()}>
            Assign shuttle
          </Button>
        </>
      }
    >
      {dispatch.error != null && (
        <Card padding={16}>
          <p style={{ margin: 0, color: brand.redText, fontSize: fontSize.md }}>{dispatch.error}</p>
        </Card>
      )}

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14 }}>
        <StatTile
          label="Active shuttles"
          value={kpis?.activeShuttles ?? '—'}
          unit={kpis != null ? `/ ${kpis.totalShuttles}` : undefined}
          sub={kpis != null ? `${kpis.onlineDrivers} drivers online` : undefined}
          subColor={brand.greenText}
        />
        <StatTile
          label="Waiting employees"
          value={kpis?.waitingEmployees ?? '—'}
          sub={kpis != null ? `${kpis.pendingRequests} unassigned` : undefined}
          subColor={(kpis?.pendingRequests ?? 0) > 0 ? brand.amber : brand.greenText}
        />
        <StatTile
          label="Avg wait"
          value={kpis?.avgWaitMin ?? '—'}
          unit="min"
          sub={
            kpis?.avgWaitDeltaMin == null
              ? 'no comparison yet'
              : `${kpis.avgWaitDeltaMin >= 0 ? '+' : '−'} ${Math.abs(kpis.avgWaitDeltaMin)} vs 7d`
          }
          subColor={(kpis?.avgWaitDeltaMin ?? 0) <= 0 ? brand.greenText : brand.amber}
        />
        <StatTile
          label="Trips today"
          value={kpis?.tripsToday ?? '—'}
          sub={kpis != null ? `${kpis.passengersToday} passengers` : undefined}
        />
        <StatTile
          label="Seat utilization"
          value={kpis?.seatUtilizationPct ?? '—'}
          unit="%"
          sub="committed seats now"
        />
      </div>

      {/* Main grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 400px',
          gap: 16,
          flex: 1,
          minHeight: 0,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
          {/* Fleet cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
            {shuttles.map((entry) => {
              const position = positions.get(entry.shuttle.id) ?? entry.position;
              return (
                <Card key={entry.shuttle.id} padding="16px 18px">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <Mono size={fontSize.md} bold color={brand.blueDeep}>
                        {entry.shuttle.name}
                      </Mono>
                      <div style={{ fontSize: fontSize.sm, color: theme.fg3, marginTop: 1 }}>
                        {entry.driverName ?? 'No driver'} · {entry.routeName ?? 'no route'}
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
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: fontSize.sm,
                    }}
                  >
                    <Figure label={entry.atStopName != null ? 'At stop' : 'Next stop'} value={entry.atStopName ?? entry.nextStopName ?? '—'} />
                    <Figure label="ETA" value={humanizeEtaSec(entry.nextStopEtaSec)} />
                    <Figure label="Seats" value={`${entry.seatsOccupied} / ${entry.shuttle.capacity}`} />
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <SeatBar occupied={entry.seatsOccupied} capacity={entry.shuttle.capacity} height={14} />
                  </div>

                  <Mono size={10.5} color={theme.fg4} style={{ display: 'block', marginTop: 8 }}>
                    {position == null
                      ? 'no GPS fix'
                      : `${position.latitude.toFixed(4)}, ${position.longitude.toFixed(4)} · fix ${position.ageSec}s ago${
                          position.accuracyM != null ? ` · ±${Math.round(position.accuracyM)}m` : ''
                        }${position.isStale ? ' · STALE' : ''}`}
                  </Mono>
                </Card>
              );
            })}
          </div>

          {/* Live requests */}
          <div style={{ flex: 1, minHeight: 200, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: fontSize.lg, fontWeight: weight.semibold }}>
                Pickup requests · live
              </h2>
              <Mono size={fontSize.xs} color={theme.fg3}>
                {openRequests.length} open{dispatch.connected ? '' : ' · reconnecting'}
              </Mono>
            </div>

            <DataTable
              columns={LIVE_COLUMNS}
              emptyMessage="No open requests. Everyone has a ride."
              rows={openRequests.map((request) => ({
                id: request.id,
                selected: selected?.id === request.id,
                onClick: () => setSelected(request),
                cells: [
                  cell.text(request.code, { mono: true, color: brand.blue, bold: true }),
                  cell.text(request.employeeName),
                  cell.text(request.pickupStopName),
                  cell.text(request.destinationStopName),
                  cell.text(request.passengerCount, { mono: true }),
                  cell.text(request.shuttleName ?? '—', {
                    mono: true,
                    color: request.shuttleName == null ? theme.fg3 : theme.fg,
                  }),
                  cell.text(etaFor(request), { mono: true }),
                  cell.pill(requestStatusLabel(request.status), requestTone(request.status)),
                ],
              }))}
            />
          </div>
        </div>

        {/* Right rail */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
          <Card padding={0} style={{ overflow: 'hidden', height: 260, flex: 'none' }}>
            <CampusMap stops={mapStops} shuttles={mapShuttles} height={260} />
          </Card>

          <Card padding={20} style={{ flex: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <h2 style={{ margin: 0, fontSize: fontSize.lg, fontWeight: weight.semibold }}>Waiting by stop</h2>
              <Mono size={fontSize.xs} color={theme.fg3}>
                now
              </Mono>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {stops.length === 0 && (
                <p style={{ margin: 0, fontSize: fontSize.base, color: theme.fg3 }}>No stops configured.</p>
              )}
              {stops.map((stop) => (
                <div key={stop.stopId}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: fontSize.base, marginBottom: 6 }}>
                    <span style={{ fontWeight: weight.medium }}>{stop.stopName}</span>
                    <Mono size={fontSize.sm} color={theme.fg2}>
                      {stop.waitingPassengers} waiting
                      {stop.nextEtaSec != null && ` · ${humanizeEtaSec(stop.nextEtaSec)}`}
                    </Mono>
                  </div>
                  <div style={{ height: 8, background: theme.sunken, borderRadius: 2, overflow: 'hidden' }}>
                    <div
                      style={{
                        // Scaled against a 12-seat shuttle, so a full bar means
                        // "one shuttle's worth of people are waiting".
                        width: `${Math.min(100, stop.waitingPassengers * (100 / 12))}%`,
                        height: '100%',
                        background: brand.blue,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card padding={20} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <h2 style={{ margin: 0, fontSize: fontSize.lg, fontWeight: weight.semibold }}>Event log</h2>
              {events.length > 6 && (
                <Button variant="ghost" height={24} style={{ padding: 0 }} onClick={() => setShowAllEvents((v) => !v)}>
                  {showAllEvents ? 'Show recent' : `View all (${events.length})`}
                </Button>
              )}
            </div>

            <div className="sh-scroll" style={{ overflowY: 'auto', minHeight: 0 }}>
              <Timeline
                entries={(showAllEvents ? events : events.slice(0, 6)).map((event) => ({
                  time: event.time,
                  text: event.text,
                  color:
                    event.tone === 'danger'
                      ? brand.redText
                      : event.tone === 'warn'
                        ? brand.amberText
                        : undefined,
                }))}
              />
            </div>
          </Card>
        </div>
      </div>

      {selected != null && (
        <RequestDrawer
          request={selected}
          shuttles={shuttles}
          onClose={() => setSelected(null)}
          onChanged={(next) => {
            setSelected(next);
            flash(`${next.code} → ${requestStatusLabel(next.status)}`);
            dispatch.refresh();
          }}
        />
      )}

      <Toast message={toast ?? ''} visible={toast != null} />
    </AdminShell>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  const { theme } = useTheme();
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ color: theme.fg3 }}>{label}</div>
      <div style={{ color: theme.fg, fontWeight: weight.medium, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {value}
      </div>
    </div>
  );
}
