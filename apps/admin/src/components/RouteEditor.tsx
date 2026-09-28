'use client';

import React from 'react';
import type { RouteWithStops, Shuttle, Stop, UpsertRouteBody } from '@shuttle/shared-types';
import { Card, fontSize, useTheme, weight } from '@shuttle/ui';

type LegDraft = { stopId: string; distance: string; seconds: string };

export function RouteEditor({
  route,
  stops,
  shuttles,
  saving,
  onCancel,
  onSave,
}: {
  route: RouteWithStops | null;
  stops: Stop[];
  shuttles: Shuttle[];
  saving: boolean;
  onCancel: () => void;
  onSave: (body: UpsertRouteBody, shuttleIds: string[]) => Promise<void>;
}) {
  const { theme } = useTheme();
  const [code, setCode] = React.useState(route?.code ?? '');
  const [name, setName] = React.useState(route?.name ?? '');
  const [description, setDescription] = React.useState(route?.description ?? '');
  const [isLoop, setIsLoop] = React.useState(route?.isLoop ?? false);
  const [isActive, setIsActive] = React.useState(route?.isActive ?? true);
  const [legs, setLegs] = React.useState<LegDraft[]>(
    route?.stops.slice().sort((a, b) => a.stopOrder - b.stopOrder).map((leg) => ({
      stopId: leg.stopId,
      distance: leg.distanceFromPrevM?.toString() ?? '',
      seconds: leg.typicalTravelSec?.toString() ?? '',
    })) ?? [],
  );
  const [assignedShuttleIds, setAssignedShuttleIds] = React.useState(
    shuttles.filter((shuttle) => shuttle.defaultRouteId === route?.id).map((shuttle) => shuttle.id),
  );
  const [availableStopId, setAvailableStopId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const usedStopIds = new Set(legs.map((leg) => leg.stopId));
  const availableStops = stops.filter((stop) => stop.isActive && !usedStopIds.has(stop.id));

  const patchLeg = (index: number, patch: Partial<LegDraft>) => {
    setLegs((current) => current.map((leg, i) => (i === index ? { ...leg, ...patch } : leg)));
  };

  const moveLeg = (index: number, offset: -1 | 1) => {
    setLegs((current) => {
      const next = [...current];
      const target = index + offset;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (legs.length < 2) {
      setError('Add at least two stops to the route.');
      return;
    }
    const body: UpsertRouteBody = {
      code: code.trim(),
      name: name.trim(),
      description: description.trim() || null,
      isLoop,
      isActive,
      stops: legs.map((leg, stopOrder) => ({
        stopId: leg.stopId,
        stopOrder,
        distanceFromPrevM: leg.distance.trim() ? Number(leg.distance) : null,
        typicalTravelSec: leg.seconds.trim() ? Number(leg.seconds) : null,
      })),
    };
    try {
      await onSave(body, assignedShuttleIds);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save route.');
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    minWidth: 0,
    padding: '9px 10px',
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: 6,
    background: theme.surface,
    color: theme.fg,
    font: 'inherit',
    boxSizing: 'border-box',
  };
  const smallButton: React.CSSProperties = {
    padding: '6px 9px',
    border: `1px solid ${theme.border}`,
    borderRadius: 6,
    background: theme.surface,
    color: theme.fg,
    cursor: 'pointer',
  };

  return (
    <Card padding={20} style={{ flex: 'none' }}>
      <form onSubmit={(event) => void submit(event)} style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: fontSize.lg, fontWeight: weight.semibold }}>
              {route == null ? 'Create route' : `Edit route · ${route.name}`}
            </h2>
            <div style={{ marginTop: 4, color: theme.fg3, fontSize: fontSize.sm }}>
              Choose stop order, optional leg estimates, and which shuttles should default to this route.
            </div>
          </div>
          <button type="button" style={smallButton} onClick={onCancel}>Close</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: 10 }}>
          <label style={{ display: 'grid', gap: 5, color: theme.fg2, fontSize: fontSize.sm }}>
            Route code
            <input required maxLength={32} value={code} onChange={(event) => setCode(event.target.value)} style={inputStyle} placeholder="CAMPUS-LOOP" />
          </label>
          <label style={{ display: 'grid', gap: 5, color: theme.fg2, fontSize: fontSize.sm }}>
            Route name
            <input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} style={inputStyle} placeholder="Campus Loop" />
          </label>
        </div>
        <label style={{ display: 'grid', gap: 5, color: theme.fg2, fontSize: fontSize.sm }}>
          Description
          <input maxLength={400} value={description} onChange={(event) => setDescription(event.target.value)} style={inputStyle} />
        </label>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: 12, border: `1px solid ${theme.border}`, borderRadius: 8, background: theme.sunken, color: theme.fg2, fontSize: fontSize.sm }}>
          <input type="checkbox" checked={isLoop} onChange={(event) => setIsLoop(event.target.checked)} style={{ marginTop: 2 }} />
          <span>
            <strong style={{ display: 'block', color: theme.fg }}>Return to the first stop (loop route)</strong>
            <span style={{ display: 'block', marginTop: 3, color: theme.fg3 }}>
              After the final stop, continue by road back to the first stop in the ordered list. Put the main stop first if that is where the shuttle should return.
            </span>
          </span>
        </label>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <strong style={{ color: theme.fg, fontSize: fontSize.base }}>Ordered stops · {legs.length}</strong>
          <div style={{ display: 'flex', gap: 8 }}>
            <select aria-label="Add a stop" value={availableStopId} onChange={(event) => setAvailableStopId(event.target.value)} style={{ ...inputStyle, width: 210 }}>
              <option value="">Select stop to add…</option>
              {availableStops.map((stop) => <option key={stop.id} value={stop.id}>{stop.name}</option>)}
            </select>
            <button
              type="button"
              style={smallButton}
              disabled={!availableStopId}
              onClick={() => {
                if (!availableStopId) return;
                setLegs((current) => [...current, { stopId: availableStopId, distance: '', seconds: '' }]);
                setAvailableStopId('');
              }}
            >Add stop</button>
          </div>
        </div>

        {legs.map((leg, index) => {
          const stop = stops.find((item) => item.id === leg.stopId);
          return (
            <div key={leg.stopId} style={{ display: 'grid', gridTemplateColumns: '34px minmax(120px, 1fr) 130px 130px auto', alignItems: 'center', gap: 8, padding: '9px 0', borderTop: `1px solid ${theme.sunken}` }}>
              <strong style={{ color: theme.fg3, fontFamily: 'monospace' }}>{index + 1}</strong>
              <span style={{ color: theme.fg }}>{stop?.name ?? 'Unknown stop'}{index === 0 && isLoop ? ' · return leg from final stop' : ''}</span>
              <label style={{ color: theme.fg3, fontSize: 11 }}>
                Metres
                <input type="number" min="0" max="200000" value={leg.distance} onChange={(event) => patchLeg(index, { distance: event.target.value })} style={inputStyle} placeholder="optional" />
              </label>
              <label style={{ color: theme.fg3, fontSize: 11 }}>
                Seconds
                <input type="number" min="0" max="7200" value={leg.seconds} onChange={(event) => patchLeg(index, { seconds: event.target.value })} style={inputStyle} placeholder="optional" />
              </label>
              <div style={{ display: 'flex', gap: 4 }}>
                <button type="button" aria-label="Move stop up" disabled={index === 0} style={smallButton} onClick={() => moveLeg(index, -1)}>↑</button>
                <button type="button" aria-label="Move stop down" disabled={index === legs.length - 1} style={smallButton} onClick={() => moveLeg(index, 1)}>↓</button>
                <button type="button" style={smallButton} onClick={() => setLegs((current) => current.filter((_, i) => i !== index))}>Remove</button>
              </div>
            </div>
          );
        })}
        <p style={{ margin: 0, color: theme.fg3, fontSize: fontSize.xs, lineHeight: 1.5 }}>
          When loop-back is enabled, OSRM uses the road route from the final stop back to the first stop and supplies its distance and travel time when available. Without OSRM, leave stop 1's optional values blank and ETA falls back to the configured speed and stop coordinates. Later blank leg values are also estimated.
        </p>

        <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 12 }}>
          <strong style={{ fontSize: fontSize.base, color: theme.fg }}>Default shuttle assignments</strong>
          <p style={{ margin: '4px 0 8px', color: theme.fg3, fontSize: fontSize.xs }}>
            Drivers see this route preselected when they start the chosen shuttle’s shift; they can still select another route.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px' }}>
            {shuttles.map((shuttle) => (
              <label key={shuttle.id} style={{ display: 'flex', alignItems: 'center', gap: 6, color: theme.fg2, fontSize: fontSize.sm }}>
                <input
                  type="checkbox"
                  checked={assignedShuttleIds.includes(shuttle.id)}
                  onChange={(event) => setAssignedShuttleIds((current) => event.target.checked ? [...current, shuttle.id] : current.filter((id) => id !== shuttle.id))}
                />
                {shuttle.name} · {shuttle.code}
              </label>
            ))}
          </div>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: theme.fg2, fontSize: fontSize.sm }}>
          <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} /> Route is active
        </label>
        {error && <p role="alert" style={{ margin: 0, color: '#a61b1b', fontSize: fontSize.sm }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" style={smallButton} onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={saving} style={{ ...smallButton, background: theme.accentBtn, color: '#fff', borderColor: theme.accentBtn, fontWeight: 600 }}>
            {saving ? 'Saving…' : route == null ? 'Create route' : 'Save route'}
          </button>
        </div>
      </form>
    </Card>
  );
}
