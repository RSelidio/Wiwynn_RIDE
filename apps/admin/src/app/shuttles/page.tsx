'use client';

import React from 'react';
import { api, ApiRequestError, useSocketEvent } from '@shuttle/client';
import type { RouteWithStops, ShuttleStatusView, UpsertShuttleBody } from '@shuttle/shared-types';
import { formatAge, humanizeEtaSec, shuttleStatusLabel } from '@shuttle/shared-utils';
import { Button, Card, Label, SeatBar, TextInput, brand, fontSize, shuttleTone, useTheme } from '@shuttle/ui';
import { AdminShell } from '@/components/AdminShell';
import { DataTable, cell, type Column } from '@/components/DataTable';

const COLUMNS: Column[] = [
  { header: 'Shuttle', width: '110px' },
  { header: 'Plate', width: '110px' },
  { header: 'Vehicle', width: '1.2fr' },
  { header: 'Driver', width: '1fr' },
  { header: 'Route', width: '1fr' },
  { header: 'Next stop', width: '1fr' },
  { header: 'ETA', width: '80px' },
  { header: 'Seats', width: '140px' },
  { header: 'GPS', width: '100px' },
  { header: 'Status', width: '120px' },
  { header: 'Actions', width: '90px' },
];

export default function ShuttlesPage() {
  const { theme } = useTheme();
  const [items, setItems] = React.useState<ShuttleStatusView[]>([]);
  const [routes, setRoutes] = React.useState<RouteWithStops[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [showForm, setShowForm] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<UpsertShuttleBody>({
    code: '', name: '', plateNo: '', model: '', capacity: 12, defaultRouteId: null,
  });

  const load = React.useCallback(async () => {
    try {
      setItems(await api.fleet.statuses(true));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load shuttles.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    void api.fleet.routes(true).then(setRoutes).catch(() => setRoutes([]));
  }, [load]);

  const saveShuttle = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const body: UpsertShuttleBody = {
        ...form,
        code: form.code.trim(),
        name: form.name.trim(),
        plateNo: form.plateNo.trim(),
        model: form.model?.trim() || null,
        capacity: Number(form.capacity),
      };
      if (editingId) await api.fleet.updateShuttle(editingId, body);
      else await api.fleet.createShuttle(body);
      setForm({ code: '', name: '', plateNo: '', model: '', capacity: 12, defaultRouteId: null });
      setShowForm(false);
      setEditingId(null);
      await load();
    } catch (saveError) {
      setError(saveError instanceof ApiRequestError ? saveError.message : 'Could not save shuttle.');
    } finally {
      setSaving(false);
    }
  };

  // Positions and statuses arrive live, so the table does not need polling.
  useSocketEvent(
    'shuttle:status',
    React.useCallback(({ status }) => {
      setItems((previous) => {
        const index = previous.findIndex((s) => s.shuttle.id === status.shuttle.id);
        if (index === -1) return [...previous, status];
        const copy = [...previous];
        copy[index] = status;
        return copy;
      });
    }, []),
  );

  useSocketEvent(
    'shuttle:position',
    React.useCallback(({ shuttleId, position }) => {
      setItems((previous) =>
        previous.map((entry) => (entry.shuttle.id === shuttleId ? { ...entry, position } : entry)),
      );
    }, []),
  );

  const active = items.filter((s) => s.shuttle.isActive).length;

  return (
    <AdminShell
      section="Manage"
      title="Shuttles"
      actions={<Button height={36} onClick={() => { setShowForm((shown) => !shown); setEditingId(null); setForm({ code: '', name: '', plateNo: '', model: '', capacity: 12, defaultRouteId: null }); }}>{showForm ? 'Cancel' : '+ Add shuttle'}</Button>}
    >
      {showForm && (
        <Card padding={18} style={{ marginBottom: 18 }}>
          <form onSubmit={saveShuttle} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, alignItems: 'end' }}>
            <div><Label>Fleet code</Label><TextInput value={form.code} onChange={(code) => setForm((current) => ({ ...current, code }))} placeholder="Company fleet ID" maxLength={32} /></div>
            <div><Label>Display name</Label><TextInput value={form.name} onChange={(name) => setForm((current) => ({ ...current, name }))} placeholder="Shuttle name" maxLength={120} /></div>
            <div><Label>License plate</Label><TextInput value={form.plateNo} onChange={(plateNo) => setForm((current) => ({ ...current, plateNo }))} placeholder="Vehicle plate" maxLength={32} /></div>
            <div><Label>Model (optional)</Label><TextInput value={form.model ?? ''} onChange={(model) => setForm((current) => ({ ...current, model }))} placeholder="Vehicle model" maxLength={120} /></div>
            <div><Label>Seat capacity</Label><TextInput type="number" min={1} max={200} value={form.capacity ?? 12} onChange={(capacity) => setForm((current) => ({ ...current, capacity: Number(capacity) }))} /></div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5, color: theme.fg3, fontSize: fontSize.xs }}>
              Default route
              <select value={form.defaultRouteId ?? ''} onChange={(event) => setForm((current) => ({ ...current, defaultRouteId: event.target.value || null }))} style={{ height: 46, border: `1px solid ${theme.borderStrong}`, borderRadius: 6, padding: '0 10px', background: theme.surface, color: theme.fg }}>
                <option value="">No default route</option>
                {routes.map((route) => <option key={route.id} value={route.id}>{route.name}</option>)}
              </select>
            </label>
            {editingId && <label style={{ display: 'flex', flexDirection: 'column', gap: 5, color: theme.fg3, fontSize: fontSize.xs }}>Service status<select value={form.isActive === false ? 'false' : 'true'} onChange={(event) => setForm((current) => ({ ...current, isActive: event.target.value === 'true' }))} style={{ height: 46, border: `1px solid ${theme.borderStrong}`, borderRadius: 6, padding: '0 10px', background: theme.surface, color: theme.fg }}><option value="true">Active</option><option value="false">Out of service</option></select></label>}
            <Button type="submit" height={46} disabled={saving || !form.code.trim() || !form.name.trim() || !form.plateNo.trim()}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Save shuttle'}</Button>
          </form>
          {error && <p role="alert" style={{ color: theme.fg, marginBottom: 0 }}>{error}</p>}
        </Card>
      )}
      {!showForm && error && <p role="alert" style={{ color: theme.fg }}>{error}</p>}
      <DataTable
        columns={COLUMNS}
        emptyMessage={loading ? 'Loading…' : 'No shuttles configured.'}
        footer={`${items.length} shuttles · ${active} in service`}
        rows={items.map((entry) => ({
          id: entry.shuttle.id,
          cells: [
            cell.text(entry.shuttle.name, { mono: true, bold: true, color: brand.blueDeep }),
            cell.text(entry.shuttle.plateNo, { mono: true }),
            cell.text(
              `${entry.shuttle.model ?? 'Unspecified'} · ${entry.shuttle.capacity} seats`,
              { color: theme.fg2 },
            ),
            cell.text(entry.driverName ?? '—', {
              color: entry.driverName == null ? theme.fg3 : theme.fg,
            }),
            cell.text(entry.routeName ?? '—', { color: theme.fg2 }),
            cell.text(entry.atStopName ?? entry.nextStopName ?? '—'),
            cell.text(humanizeEtaSec(entry.nextStopEtaSec), { mono: true }),
            cell.node(
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, minWidth: 40 }}>
                  <SeatBar occupied={entry.seatsOccupied} capacity={entry.shuttle.capacity} />
                </span>
                <span
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: fontSize.sm,
                    color: theme.fg2,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {entry.seatsOccupied}/{entry.shuttle.capacity}
                </span>
              </span>,
            ),
            cell.text(
              entry.position == null ? 'no fix' : formatAge(entry.position.ageSec),
              {
                mono: true,
                color:
                  entry.position == null
                    ? theme.fg3
                    : entry.position.isStale
                      ? brand.amberText
                      : brand.greenText,
              },
            ),
            cell.pill(
              entry.shuttle.isActive ? shuttleStatusLabel(entry.status) : 'Out of service',
              entry.shuttle.isActive ? shuttleTone(entry.status) : 'neutral',
            ),
            cell.node(<Button height={32} variant="secondary" onClick={() => { setForm({ code: entry.shuttle.code, name: entry.shuttle.name, plateNo: entry.shuttle.plateNo, model: entry.shuttle.model, capacity: entry.shuttle.capacity, defaultRouteId: entry.shuttle.defaultRouteId, isActive: entry.shuttle.isActive }); setEditingId(entry.shuttle.id); setShowForm(true); setError(null); }}>Edit</Button>),
          ],
        }))}
      />
    </AdminShell>
  );
}
