'use client';

import React from 'react';
import { api, ApiRequestError } from '@shuttle/client';
import type { RouteWithStops, Stop } from '@shuttle/shared-types';
import { employeeCanCancel, employeeStatusLabel, etaParts, humanizeEtaSec } from '@shuttle/shared-utils';
import {
  Button,
  CampusMap,
  Label,
  Mono,
  ProgressSteps,
  StatusPill,
  Stepper,
  Toast,
  brand,
  fontSize,
  radius,
  requestTone,
  shadow,
  useTheme,
  weight,
  type MapShuttle,
} from '@shuttle/ui';
import { AppShell } from '@/components/AppShell';
import { etaSecFor, useShuttleData } from '@/hooks/useShuttleData';

const STEPS = ['Requested', 'Accepted', 'Arrived', 'Picked up'] as const;

/** Which progress step a status sits on. */
function stepIndexFor(status: string): number {
  switch (status) {
    case 'pending':
      return 0;
    case 'accepted':
      return 1;
    case 'arrived':
      return 2;
    case 'boarding':
    case 'completed':
      return 3;
    default:
      return 0;
  }
}

export default function PickupPage() {
  return (
    <AppShell>
      <PickupScreen />
    </AppShell>
  );
}

function PickupScreen() {
  const { theme } = useTheme();
  const data = useShuttleData();
  const { home, activeRequest, shuttles, positions, etas } = data;

  const [pickupStopId, setPickupStopId] = React.useState<string | null>(null);
  const [destinationStopId, setDestinationStopId] = React.useState<string | null>(null);
  const [passengers, setPassengers] = React.useState(1);
  const [busy, setBusy] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);
  const [routes, setRoutes] = React.useState<RouteWithStops[]>([]);
  const [navigationPaths, setNavigationPaths] = React.useState<Map<string, Array<{ latitude: number; longitude: number }> | null>>(new Map());

  const flash = React.useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2_600);
  }, []);

  const stops = home?.stops ?? [];
  React.useEffect(() => {
    if (home == null) return;
    void api.fleet.routes().then(setRoutes).catch(() => setRoutes([]));
  }, [home]);
  const pickupOptions = stops.filter((s) => s.kind === 'pickup' || s.kind === 'both');
  const destinationOptions = stops.filter((s) => s.kind === 'dropoff' || s.kind === 'both');

  // Default the pickup to the employee's usual stop, and the destination to the
  // first stop that is not the pickup.
  React.useEffect(() => {
    if (home == null || pickupStopId != null) return;
    const preferred = pickupOptions[0]?.id ?? null;
    setPickupStopId(preferred);
    setDestinationStopId(destinationOptions.find((s) => s.id !== preferred)?.id ?? null);
  }, [home, pickupStopId, pickupOptions, destinationOptions]);

  const request = activeRequest;

  // ── Live figures ─────────────────────────────────────────────────────────
  const liveEtaSec = etaSecFor(
    etas,
    request?.shuttleId,
    request?.pickupStopId,
    request?.etaSec ?? null,
  );

  const assignedShuttle = shuttles.find((s) => s.shuttle.id === request?.shuttleId);
  const mapRouteId = assignedShuttle?.routeId
    ?? shuttles.find((shuttle) => shuttle.position != null && shuttle.routeId != null)?.routeId
    ?? null;
  const mapRoute = routes.find((route) => route.id === mapRouteId) ?? null;

  /** The soonest shuttle to the chosen pickup stop, when nothing is requested yet. */
  const nextShuttle = React.useMemo(() => {
    if (pickupStopId == null) return null;

    let best: { name: string; etaSec: number | null; seats: number } | null = null;
    for (const shuttle of shuttles) {
      if (shuttle.status === 'off_shift' || shuttle.status === 'offline') continue;

      const etaSec = etaSecFor(etas, shuttle.shuttle.id, pickupStopId, shuttle.nextStopEtaSec);
      if (etaSec == null) continue;

      if (best == null || etaSec < (best.etaSec ?? Number.POSITIVE_INFINITY)) {
        best = { name: shuttle.shuttle.name, etaSec, seats: shuttle.seatsAvailable };
      }
    }
    return best;
  }, [shuttles, etas, pickupStopId]);

  // flatMap rather than map+filter: a shuttle with no GPS fix yet contributes
  // no entry, and the result is MapShuttle[] without a type predicate.
  const mapShuttles: MapShuttle[] = shuttles.flatMap((shuttle, colorIndex) => {
    const position = positions.get(shuttle.shuttle.id) ?? shuttle.position;
    if (position == null) return [];

    const etaSec = etaSecFor(etas, shuttle.shuttle.id, pickupStopId, shuttle.nextStopEtaSec);

    return [
      {
        shuttleId: shuttle.shuttle.id,
        colorIndex,
        routeId: shuttle.routeId,
        nextStopId: shuttle.nextStopId,
        remainingPath: navigationPaths.get(shuttle.shuttle.id) ?? null,
        name: shuttle.shuttle.name,
        badge: shuttle.shuttle.code.replace(/\D/g, '') || '•',
        position,
        focused: shuttle.shuttle.id === request?.shuttleId,
        etaLabel: humanizeEtaSec(etaSec),
        subLabel: `${shuttle.seatsAvailable} seats free · ${position.ageSec}s ago`,
      },
    ];
  });

  React.useEffect(() => {
    const candidates = shuttles.filter((shuttle) => {
      const position = positions.get(shuttle.shuttle.id) ?? shuttle.position;
      return shuttle.nextStopId != null && position != null && !position.isStale;
    });
    let cancelled = false;
    for (const shuttle of candidates) {
      const position = positions.get(shuttle.shuttle.id) ?? shuttle.position;
      if (shuttle.nextStopId == null || position == null || position.isStale) continue;
      const shuttleId = shuttle.shuttle.id;
      const targetStopId = request?.shuttleId === shuttleId
        ? request.destinationStopId
        : shuttle.nextStopId;
      if (targetStopId == null) continue;
      void api.fleet.navigationPath(shuttleId, targetStopId).then((remainingPath) => {
        if (cancelled) return;
        setNavigationPaths((previous) => {
          const next = new Map(previous);
          next.set(shuttleId, remainingPath);
          return next;
        });
      }).catch(() => {
        if (!cancelled) {
          setNavigationPaths((previous) => {
            const next = new Map(previous);
            next.set(shuttleId, null);
            return next;
          });
        }
      });
    }
    return () => { cancelled = true; };
  }, [mapRouteId, request?.shuttleId, request?.destinationStopId, shuttles, positions]);

  // For each stop, show the lowest live ETA from a shuttle that is on shift,
  // has a fresh GPS fix and has a valid route estimate for that stop.
  const stopEtaLabels = React.useMemo(() => {
    const labels: Record<string, string> = {};
    for (const stop of stops) {
      let best: { etaSec: number; badge: string } | null = null;
      for (const shuttle of shuttles) {
        if (shuttle.status === 'off_shift' || shuttle.status === 'offline') continue;
        const position = positions.get(shuttle.shuttle.id) ?? shuttle.position;
        if (position == null || position.isStale) continue;
        const fallback = shuttle.nextStopId === stop.id ? shuttle.nextStopEtaSec : null;
        const etaSec = etaSecFor(etas, shuttle.shuttle.id, stop.id, fallback);
        if (etaSec == null) continue;
        if (best == null || etaSec < best.etaSec) {
          best = {
            etaSec,
            badge: shuttle.shuttle.code.replace(/\\D/g, '') || shuttle.shuttle.name,
          };
        }
      }
      if (best != null) labels[stop.id] = `${humanizeEtaSec(best.etaSec)} · ${best.badge}`;
    }
    return labels;
  }, [stops, shuttles, positions, etas]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const submitRequest = async () => {
    if (pickupStopId == null || destinationStopId == null || busy) return;

    setBusy(true);
    try {
      const created = await api.requests.create({
        pickupStopId,
        destinationStopId,
        passengerCount: passengers,
      });
      data.setActiveRequest(created);
      flash(`Request sent · ${created.code}`);
    } catch (err) {
      flash(err instanceof ApiRequestError ? err.message : 'Could not send the request.');
    } finally {
      setBusy(false);
    }
  };

  const cancelRequest = async () => {
    if (request == null || busy) return;

    setBusy(true);
    try {
      await api.requests.cancel(request.id);
      data.setActiveRequest(null);
      flash('Pickup cancelled');
    } catch (err) {
      flash(err instanceof ApiRequestError ? err.message : 'Could not cancel.');
    } finally {
      setBusy(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  if (data.loading) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: theme.fg3, fontSize: fontSize.base }}>
        Loading…
      </div>
    );
  }

  if (data.error != null) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
        <div>
          <p style={{ color: brand.redText, fontSize: fontSize.md, marginBottom: 16 }}>{data.error}</p>
          <Button variant="secondary" onClick={() => void data.reload()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
        {/* The map fills this positioned viewport; the shared component uses
          absolute inset sizing so Leaflet gets a non-zero flex-child height. */}
      <div style={{ flex: 1, minHeight: 220, position: 'relative', overflow: 'hidden' }}>
        <CampusMap
          stops={stops}
          route={mapRoute}
          shuttles={mapShuttles}
          stopEtaLabels={stopEtaLabels}
          pickupStopId={request?.pickupStopId ?? pickupStopId}
          destinationStopId={request?.destinationStopId ?? destinationStopId}
        />
        <GpsBadge ageSec={freshestAge(positions)} />
      </div>

      {/* Bottom sheet */}
      <section
        style={{
          background: theme.surface,
          borderTop: `1px solid ${theme.border}`,
          borderRadius: `${radius['2xl']}px ${radius['2xl']}px 0 0`,
          marginTop: -14,
          position: 'relative',
          zIndex: 2,
          padding: '10px 20px 18px',
          boxShadow: shadow.sheet,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ width: 36, height: 4, borderRadius: 2, background: theme.borderStrong, margin: '0 auto' }} />

        {request == null ? (
          <IdleSheet
            pickupOptions={pickupOptions}
            destinationOptions={destinationOptions}
            pickupStopId={pickupStopId}
            destinationStopId={destinationStopId}
            onPickup={setPickupStopId}
            onDestination={setDestinationStopId}
            passengers={passengers}
            onPassengers={setPassengers}
            nextShuttle={nextShuttle}
            onSubmit={() => void submitRequest()}
            busy={busy}
          />
        ) : (
          <ActiveSheet
            code={request.code}
            status={request.status}
            pickupName={request.pickupStopName}
            destinationName={request.destinationStopName}
            shuttleName={request.shuttleName}
            driverName={request.driverName}
            seatsAvailable={assignedShuttle?.seatsAvailable ?? request.seatsAvailable}
            capacity={assignedShuttle?.shuttle.capacity ?? null}
            etaSec={liveEtaSec}
            passengers={request.passengerCount}
            onCancel={() => void cancelRequest()}
            busy={busy}
          />
        )}
      </section>

      <Toast message={toast ?? ''} visible={toast != null} position="top" />
    </div>
  );
}

/** Freshest fix age across the fleet, for the "GPS updated" chip. */
function freshestAge(positions: Map<string, { ageSec: number }>): number | null {
  let best: number | null = null;
  for (const position of positions.values()) {
    if (best == null || position.ageSec < best) best = position.ageSec;
  }
  return best;
}

function GpsBadge({ ageSec }: { ageSec: number | null }) {
  const stale = ageSec == null || ageSec > 30;

  return (
    <div
      style={{
        position: 'absolute',
        left: 12,
        top: 12,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: fontSize.xs,
        fontWeight: weight.medium,
        padding: '4px 9px',
        borderRadius: radius.pill,
        background: '#fff',
        border: '1px solid #d2dae2',
        color: '#38424e',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: stale ? brand.amber : brand.green,
        }}
      />
      {ageSec == null ? 'Waiting for GPS' : `GPS updated ${ageSec} s ago`}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet: nothing requested yet
// ─────────────────────────────────────────────────────────────────────────────

function IdleSheet({
  pickupOptions,
  destinationOptions,
  pickupStopId,
  destinationStopId,
  onPickup,
  onDestination,
  passengers,
  onPassengers,
  nextShuttle,
  onSubmit,
  busy,
}: {
  pickupOptions: Stop[];
  destinationOptions: Stop[];
  pickupStopId: string | null;
  destinationStopId: string | null;
  onPickup: (id: string) => void;
  onDestination: (id: string) => void;
  passengers: number;
  onPassengers: (n: number) => void;
  nextShuttle: { name: string; etaSec: number | null; seats: number } | null;
  onSubmit: () => void;
  busy: boolean;
}) {
  const { theme } = useTheme();

  // A pickup and destination that are the same place is rejected by the server,
  // so keep the two lists mutually exclusive in the UI.
  const destinations = destinationOptions.filter((s) => s.id !== pickupStopId);

  const canSubmit = pickupStopId != null && destinationStopId != null && !busy;

  return (
    <>
      <Label>Pickup stop</Label>
      <StopPicker options={pickupOptions} value={pickupStopId} onChange={onPickup} />

      <Label>Destination</Label>
      <StopPicker options={destinations} value={destinationStopId} onChange={onDestination} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Label>Passengers</Label>
          <Stepper value={passengers} onChange={onPassengers} min={1} max={12} size={40} />
        </div>

        {nextShuttle != null && (
          <div
            style={{
              flex: 1,
              padding: '10px 14px',
              border: `1px solid ${theme.border}`,
              borderRadius: radius.md,
              background: theme.page,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <div>
              <div style={{ fontSize: fontSize.xs, color: theme.fg3 }}>Next shuttle</div>
              <Mono size={fontSize.md} bold color={brand.blueDeep}>
                {nextShuttle.name}
              </Mono>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: fontSize.xs, color: theme.fg3 }}>ETA · seats</div>
              <Mono size={fontSize.md} bold color={brand.blueDeep}>
                {humanizeEtaSec(nextShuttle.etaSec)} · {nextShuttle.seats}
              </Mono>
            </div>
          </div>
        )}
      </div>

      <Button full height={52} onClick={onSubmit} disabled={!canSubmit}>
        {busy ? 'Sending…' : 'Request pickup'}
      </Button>

      {nextShuttle == null && (
        <p style={{ margin: 0, fontSize: fontSize.sm, color: theme.fg3, textAlign: 'center' }}>
          No shuttle is on shift right now. You can still send a request — it will be offered to the
          next driver who signs on.
        </p>
      )}
    </>
  );
}

function StopPicker({
  options,
  value,
  onChange,
}: {
  options: Stop[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  const { theme } = useTheme();

  return (
    <div
      // Horizontal scroll rather than a wrapping grid: with eight stops a grid
      // pushes the primary action below the fold on a small phone.
      className="sh-scroll"
      style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2, margin: '0 -20px', padding: '0 20px 2px' }}
    >
      {options.map((stop) => {
        const active = stop.id === value;
        return (
          <button
            key={stop.id}
            type="button"
            onClick={() => onChange(stop.id)}
            style={{
              flex: 'none',
              height: 44,
              padding: '0 16px',
              borderRadius: radius.md,
              border: `1px solid ${active ? brand.blue : theme.borderStrong}`,
              background: active ? brand.bluePale : theme.surface,
              color: active ? brand.avatarFg : theme.fg2,
              fontFamily: 'inherit',
              fontSize: fontSize.md,
              fontWeight: weight.semibold,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {stop.name}
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet: a request is live
// ─────────────────────────────────────────────────────────────────────────────

function ActiveSheet({
  code,
  status,
  pickupName,
  destinationName,
  shuttleName,
  driverName,
  seatsAvailable,
  capacity,
  etaSec,
  passengers,
  onCancel,
  busy,
}: {
  code: string;
  status: string;
  pickupName: string;
  destinationName: string;
  shuttleName: string | null;
  driverName: string | null;
  seatsAvailable: number | null;
  capacity: number | null;
  etaSec: number | null;
  passengers: number;
  onCancel: () => void;
  busy: boolean;
}) {
  const { theme } = useTheme();
  const eta = etaParts(etaSec);
  const showEta = status === 'accepted';
  const arrived = status === 'arrived';
  const onBoard = status === 'boarding';

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <StatusPill label={employeeStatusLabel(status as never)} tone={requestTone(status)} />
        <Mono size={fontSize.xs} color={theme.fg3}>
          {code}
        </Mono>
      </div>

      {showEta && (
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div>
            <Label>{shuttleName ?? 'Your shuttle'} arrives in</Label>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span
                style={{
                  fontSize: fontSize.hero,
                  fontWeight: weight.semibold,
                  lineHeight: 1,
                  letterSpacing: '-.02em',
                  color: brand.blueDeep,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {eta.value}
              </span>
              {eta.unit !== '' && (
                <span style={{ fontSize: 16, color: theme.fg3, fontWeight: weight.medium }}>{eta.unit}</span>
              )}
            </div>
          </div>
          <div style={{ textAlign: 'right', fontSize: fontSize.sm, color: theme.fg2 }}>
            {driverName != null && <div>{driverName}</div>}
            {seatsAvailable != null && (
              <Mono size={fontSize.sm} bold color={brand.blueDeep}>
                {seatsAvailable}
                {capacity != null && (
                  <span style={{ color: '#8a96a3', fontWeight: weight.regular }}> / {capacity} seats</span>
                )}
              </Mono>
            )}
          </div>
        </div>
      )}

      {arrived && (
        <div style={{ fontSize: 24, fontWeight: weight.semibold, letterSpacing: '-.01em', color: brand.blueDeep }}>
          Board {shuttleName ?? 'your shuttle'} at {pickupName}
        </div>
      )}

      {onBoard && (
        <div>
          <Label>On board · heading to</Label>
          <div style={{ fontSize: 22, fontWeight: weight.semibold, color: brand.blueDeep }}>
            {destinationName}
          </div>
        </div>
      )}

      {status === 'pending' && (
        <div style={{ fontSize: fontSize.xl, fontWeight: weight.semibold, letterSpacing: '-.01em' }}>
          Looking for a shuttle
        </div>
      )}

      <div style={{ fontSize: fontSize.base, color: theme.fg2 }}>
        {pickupName} → {destinationName} ·{' '}
        {passengers === 1 ? '1 passenger' : `${passengers} passengers`}
      </div>

      <ProgressSteps steps={STEPS} currentIndex={stepIndexFor(status)} />

      {employeeCanCancel(status as never) && (
        <Button variant="danger" full height={48} onClick={onCancel} disabled={busy}>
          {busy ? 'Cancelling…' : 'Cancel pickup'}
        </Button>
      )}
    </>
  );
}
