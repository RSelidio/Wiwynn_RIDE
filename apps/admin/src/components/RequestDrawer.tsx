'use client';

import React from 'react';
import { api, ApiRequestError } from '@shuttle/client';
import type { PickupRequestView, ShuttleStatusView } from '@shuttle/shared-types';
import { formatTime, humanizeEtaSec, nextAdminAction, requestStatusLabel } from '@shuttle/shared-utils';
import {
  Button,
  Label,
  Mono,
  StatusPill,
  Timeline,
  brand,
  fontSize,
  radius,
  requestTone,
  shadow,
  useTheme,
  weight,
} from '@shuttle/ui';

/**
 * Request detail drawer (design 1c).
 *
 * The one place a dispatcher acts on a request: assign a shuttle, advance it
 * through the lifecycle, or cancel it. Which controls appear is decided by the
 * status, using the same rules the backend enforces.
 */
export function RequestDrawer({
  request,
  shuttles,
  onClose,
  onChanged,
}: {
  request: PickupRequestView;
  shuttles: ShuttleStatusView[];
  onClose: () => void;
  onChanged: (next: PickupRequestView) => void;
}) {
  const { theme } = useTheme();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Escape closes, as in every other drawer the company's tools use.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (action: () => Promise<PickupRequestView>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onChanged(await action());
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'That action failed.');
    } finally {
      setBusy(false);
    }
  };

  const next = nextAdminAction(request.status);
  const canAssign = request.status === 'pending';
  const canCancel = request.status === 'pending' || request.status === 'accepted';
  const isFinal = ['completed', 'cancelled', 'rejected', 'expired'].includes(request.status);

  // Only shuttles that are actually available and have room are offerable.
  const assignable = shuttles.filter(
    (s) =>
      (s.status === 'en_route' || s.status === 'at_stop') &&
      s.seatsAvailable >= request.passengerCount,
  );

  // Newest first, built by pushing so each entry's presence is a plain
  // condition rather than a filtered union of literal types.
  const timeline: Array<{ time: string; text: string; color?: string }> = [];

  if (request.completedAt != null) {
    timeline.push({ time: formatTime(request.completedAt), text: 'Trip completed' });
  }
  if (request.boardedAt != null) {
    timeline.push({ time: formatTime(request.boardedAt), text: 'Passenger picked up' });
  }
  if (request.arrivedAt != null) {
    timeline.push({
      time: formatTime(request.arrivedAt),
      text: `${request.shuttleName ?? 'Shuttle'} arrived at ${request.pickupStopName}`,
    });
  }
  if (request.cancelledAt != null) {
    timeline.push({
      time: formatTime(request.cancelledAt),
      text: request.cancelReason ?? `Request ${request.status}`,
      color: brand.redText,
    });
  }
  if (request.acceptedAt != null) {
    timeline.push({
      time: formatTime(request.acceptedAt),
      text: `${request.shuttleName ?? 'Shuttle'} accepted the request`,
    });
  }
  timeline.push({
    time: formatTime(request.requestedAt),
    text: `Request created from the ${request.source} app`,
  });

  return (
    <>
      {/* Scrim. Sits below the drawer and above the page. */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(20,26,35,.25)', zIndex: 40 }}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Request ${request.code}`}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 420,
          maxWidth: '100vw',
          background: theme.surface,
          borderLeft: `1px solid ${theme.borderStrong}`,
          boxShadow: shadow.drawer,
          display: 'flex',
          flexDirection: 'column',
          zIndex: 41,
        }}
      >
        <header
          style={{
            padding: '20px 24px 16px',
            borderBottom: `1px solid ${theme.border}`,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <Mono size={fontSize.sm} bold color={brand.blue}>
              {request.code}
            </Mono>
            <div style={{ fontSize: 20, fontWeight: weight.semibold, marginTop: 2 }}>
              {request.employeeName}
            </div>
            <div style={{ fontSize: 12.5, color: theme.fg3, marginTop: 2 }}>
              {request.employeeDepartment ?? 'No department'} · requested{' '}
              {formatTime(request.requestedAt)}
            </div>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <StatusPill label={requestStatusLabel(request.status)} tone={requestTone(request.status)} />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 20,
                lineHeight: 1,
                color: theme.fg3,
              }}
            >
              ×
            </button>
          </div>
        </header>

        <div
          className="sh-scroll"
          style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16, flex: 1, overflowY: 'auto' }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Tile label="Pickup" value={request.pickupStopName} />
            <Tile label="Destination" value={request.destinationStopName} />
            <Tile label="Passengers" value={String(request.passengerCount)} mono />
            <Tile label="Shuttle" value={request.shuttleName ?? '—'} mono />
          </div>

          {request.etaSec != null && request.status === 'accepted' && (
            <div
              style={{
                background: brand.bluePale,
                border: `1px solid ${brand.bluePaleBorder}`,
                borderRadius: radius.lg,
                padding: '12px 14px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span style={{ fontSize: fontSize.base, color: brand.avatarFg }}>
                Arriving at {request.pickupStopName}
              </span>
              <Mono size={fontSize.md} bold color={brand.blueDeep}>
                {humanizeEtaSec(request.etaSec)}
              </Mono>
            </div>
          )}

          {canAssign && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Label>Assign to</Label>
              {assignable.length === 0 ? (
                <p style={{ margin: 0, fontSize: fontSize.base, color: theme.fg3 }}>
                  No shuttle is online with {request.passengerCount}{' '}
                  {request.passengerCount === 1 ? 'seat' : 'seats'} free.
                </p>
              ) : (
                assignable.map((shuttle) => (
                  <button
                    key={shuttle.shuttle.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => api.requests.assign(request.id, shuttle.shuttle.id))}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '12px 14px',
                      borderRadius: radius.lg,
                      border: `1px solid ${theme.borderStrong}`,
                      background: theme.surface,
                      textAlign: 'left',
                      fontFamily: 'inherit',
                      cursor: busy ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <span
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: '50%',
                        background: brand.blue,
                        color: '#fff',
                        fontFamily: "'IBM Plex Mono', monospace",
                        fontSize: fontSize.sm,
                        fontWeight: weight.semibold,
                        display: 'grid',
                        placeItems: 'center',
                        flex: 'none',
                      }}
                    >
                      {shuttle.shuttle.code.replace(/\D/g, '') || '•'}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 13.5, fontWeight: weight.semibold }}>
                        {shuttle.shuttle.name}
                      </span>
                      <span style={{ display: 'block', fontSize: fontSize.sm, color: theme.fg3 }}>
                        {shuttle.driverName ?? 'No driver'} ·{' '}
                        {shuttle.nextStopName ?? 'en route'}
                        {shuttle.nextStopEtaSec != null && ` · ${humanizeEtaSec(shuttle.nextStopEtaSec)}`}
                      </span>
                    </span>
                    <Mono size={fontSize.sm} color={theme.fg2}>
                      {shuttle.seatsAvailable} / {shuttle.shuttle.capacity}
                    </Mono>
                  </button>
                ))
              )}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Label>Timeline</Label>
            <Timeline entries={timeline} />
          </div>

          {error != null && (
            <div
              role="alert"
              style={{
                background: brand.redPale,
                color: brand.redText,
                borderRadius: radius.md,
                padding: '10px 12px',
                fontSize: fontSize.base,
              }}
            >
              {error}
            </div>
          )}
        </div>

        <footer
          style={{
            padding: '16px 24px',
            borderTop: `1px solid ${theme.border}`,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
          }}
        >
          {canCancel && (
            <Button
              variant="danger"
              height={40}
              disabled={busy}
              onClick={() => void run(() => api.requests.cancel(request.id, 'Cancelled by dispatcher'))}
            >
              Cancel request
            </Button>
          )}

          {next != null && (
            <Button
              height={40}
              style={{ marginLeft: 'auto' }}
              disabled={busy}
              onClick={() =>
                void run(() =>
                  next.to === 'arrived'
                    ? api.requests.arrived(request.id)
                    : next.to === 'boarding'
                      ? api.requests.board(request.id)
                      : api.requests.complete(request.id),
                )
              }
            >
              {busy ? 'Working…' : next.label}
            </Button>
          )}

          {isFinal && (
            <Button variant="secondary" height={40} style={{ marginLeft: 'auto' }} onClick={onClose}>
              Close
            </Button>
          )}
        </footer>
      </aside>
    </>
  );
}

function Tile({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const { theme } = useTheme();
  return (
    <div
      style={{
        background: theme.page,
        border: `1px solid ${theme.border}`,
        borderRadius: radius.lg,
        padding: '12px 14px',
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: fontSize.xs, color: theme.fg3 }}>{label}</div>
      {mono === true ? (
        <Mono size={fontSize.md} bold style={{ marginTop: 3, display: 'block' }}>
          {value}
        </Mono>
      ) : (
        <div
          style={{
            fontSize: fontSize.md,
            fontWeight: weight.semibold,
            marginTop: 3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {value}
        </div>
      )}
    </div>
  );
}
