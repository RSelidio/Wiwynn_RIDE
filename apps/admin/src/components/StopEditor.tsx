'use client';

import React from 'react';
import type { Stop, UpsertStopBody } from '@shuttle/shared-types';
import { Card, fontSize, useTheme, weight } from '@shuttle/ui';

export function StopEditor({
  stop,
  draft,
  pinMode,
  saving,
  onChange,
  onPinToggle,
  onCancel,
  onSave,
}: {
  stop: Stop | null;
  draft: UpsertStopBody;
  pinMode: boolean;
  saving: boolean;
  onChange: (draft: UpsertStopBody) => void;
  onPinToggle: () => void;
  onCancel: () => void;
  onSave: () => Promise<void>;
}) {
  const { theme } = useTheme();
  const [error, setError] = React.useState<string | null>(null);
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '9px 10px', boxSizing: 'border-box',
    border: `1px solid ${theme.borderStrong}`, borderRadius: 6,
    background: theme.surface, color: theme.fg, font: 'inherit',
  };
  const buttonStyle: React.CSSProperties = {
    padding: '8px 11px', border: `1px solid ${theme.border}`, borderRadius: 6,
    background: theme.surface, color: theme.fg, cursor: 'pointer',
  };
  const update = (patch: Partial<UpsertStopBody>) => onChange({ ...draft, ...patch });

  return (
    <Card padding={18} style={{ flex: 'none' }}>
      <form onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        void onSave().catch((saveError: unknown) => setError(saveError instanceof Error ? saveError.message : 'Could not save stop.'));
      }} style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: fontSize.lg, fontWeight: weight.semibold }}>{stop == null ? 'Add stop' : `Edit stop · ${stop.name}`}</h2>
          <button type="button" style={buttonStyle} onClick={onCancel}>Close</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: 8 }}>
          <label style={{ display: 'grid', gap: 4, color: theme.fg2, fontSize: fontSize.sm }}>Code
            <input required maxLength={32} value={draft.code} onChange={(event) => update({ code: event.target.value })} style={inputStyle} />
          </label>
          <label style={{ display: 'grid', gap: 4, color: theme.fg2, fontSize: fontSize.sm }}>Name
            <input required maxLength={120} value={draft.name} onChange={(event) => update({ name: event.target.value })} style={inputStyle} />
          </label>
        </div>
        <label style={{ display: 'grid', gap: 4, color: theme.fg2, fontSize: fontSize.sm }}>Description
          <input maxLength={400} value={draft.description ?? ''} onChange={(event) => update({ description: event.target.value || null })} style={inputStyle} />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          <label style={{ display: 'grid', gap: 4, color: theme.fg2, fontSize: fontSize.sm }}>Latitude
            <input type="number" required min={-90} max={90} step="any" value={draft.latitude} onChange={(event) => update({ latitude: Number(event.target.value) })} style={inputStyle} />
          </label>
          <label style={{ display: 'grid', gap: 4, color: theme.fg2, fontSize: fontSize.sm }}>Longitude
            <input type="number" required min={-180} max={180} step="any" value={draft.longitude} onChange={(event) => update({ longitude: Number(event.target.value) })} style={inputStyle} />
          </label>
          <label style={{ display: 'grid', gap: 4, color: theme.fg2, fontSize: fontSize.sm }}>Stop type
            <select value={draft.kind} onChange={(event) => update({ kind: event.target.value as UpsertStopBody['kind'] })} style={inputStyle}>
              <option value="pickup">Pickup</option><option value="dropoff">Drop-off</option><option value="both">Both</option>
            </select>
          </label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <button type="button" style={{ ...buttonStyle, borderColor: pinMode ? theme.accentBtn : theme.border, color: pinMode ? theme.accentBtn : theme.fg }} onClick={onPinToggle}>
            {pinMode ? 'Tap the map to place this stop…' : 'Pin location on map'}
          </button>
          <span style={{ color: theme.fg3, fontSize: fontSize.xs }}>Coordinates: {Number(draft.latitude).toFixed(6)}, {Number(draft.longitude).toFixed(6)}</span>
        </div>
        <label style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 8, color: theme.fg2, fontSize: fontSize.sm }}>
          Geofence radius (metres; blank = system default)
          <input type="number" min={5} max={1000} step={1} value={draft.geofenceM ?? ''} onChange={(event) => update({ geofenceM: event.target.value === '' ? null : Number(event.target.value) })} style={{ ...inputStyle, width: 120 }} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: theme.fg2, fontSize: fontSize.sm }}>
          <input type="checkbox" checked={draft.isActive ?? true} onChange={(event) => update({ isActive: event.target.checked })} /> Stop is active
        </label>
        {error && <p role="alert" style={{ margin: 0, color: '#a61b1b', fontSize: fontSize.sm }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" style={buttonStyle} onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={saving} style={{ ...buttonStyle, background: theme.accentBtn, color: '#fff', borderColor: theme.accentBtn, fontWeight: 600 }}>{saving ? 'Saving…' : stop == null ? 'Add stop' : 'Save stop'}</button>
        </div>
      </form>
    </Card>
  );
}
