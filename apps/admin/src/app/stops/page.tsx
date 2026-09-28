'use client';

import React from 'react';
import { api } from '@shuttle/client';
import type { RouteWithStops, Shuttle, Stop, StopWaitingSummary, UpsertRouteBody, UpsertStopBody } from '@shuttle/shared-types';
import { formatDistance, formatDuration } from '@shuttle/shared-utils';
import { Card, CampusMap, Mono, brand, fontSize, useTheme, weight } from '@shuttle/ui';
import { AdminShell } from '@/components/AdminShell';
import { DataTable, cell, type Column } from '@/components/DataTable';
import { RouteEditor } from '@/components/RouteEditor';
import { StopEditor } from '@/components/StopEditor';

const STOP_COLUMNS: Column[] = [
  { header: 'Stop', width: '1.4fr' },
  { header: 'Code', width: '100px' },
  { header: 'Type', width: '150px' },
  { header: 'Coordinates', width: '180px' },
  { header: 'Geofence', width: '100px' },
  { header: 'Waiting now', width: '120px', align: 'right' },
  { header: 'Status', width: '110px' },
  { header: 'Action', width: '150px' },
];

const KIND_LABELS: Record<Stop['kind'], string> = {
  pickup: 'Pickup',
  dropoff: 'Drop-off',
  both: 'Pickup · drop-off',
};

export default function StopsPage() {
  const { theme } = useTheme();
  const [stops, setStops] = React.useState<Stop[]>([]);
  const [routes, setRoutes] = React.useState<RouteWithStops[]>([]);
  const [waiting, setWaiting] = React.useState<StopWaitingSummary[]>([]);
  const [shuttles, setShuttles] = React.useState<Shuttle[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [editingRoute, setEditingRoute] = React.useState<RouteWithStops | null>(null);
  const [creatingRoute, setCreatingRoute] = React.useState(false);
  const [editingStop, setEditingStop] = React.useState<Stop | null>(null);
  const [creatingStop, setCreatingStop] = React.useState(false);
  const [stopDraft, setStopDraft] = React.useState<UpsertStopBody | null>(null);
  const [pinMode, setPinMode] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [pageError, setPageError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setPageError(null);
    const results = await Promise.allSettled([
      api.fleet.stops(true),
      api.fleet.routes(true),
      api.admin.stopWaiting(),
      api.fleet.shuttles(true),
    ]);
    const errors: string[] = [];
    if (results[0].status === 'fulfilled') setStops(results[0].value);
    else errors.push(results[0].reason instanceof Error ? results[0].reason.message : 'Could not load stops.');
    if (results[1].status === 'fulfilled') setRoutes(results[1].value);
    else errors.push(results[1].reason instanceof Error ? results[1].reason.message : 'Could not load routes.');
    if (results[2].status === 'fulfilled') setWaiting(results[2].value);
    else {
      setWaiting([]);
      errors.push(results[2].reason instanceof Error ? results[2].reason.message : 'Could not load stop waiting counts.');
    }
    if (results[3].status === 'fulfilled') setShuttles(results[3].value);
    else errors.push(results[3].reason instanceof Error ? results[3].reason.message : 'Could not load shuttles.');
    setPageError(errors.length > 0 ? errors.join(' · ') : null);
    setLoading(false);
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const beginEditStop = (stop: Stop) => {
    setCreatingStop(false);
    setEditingStop(stop);
    setPinMode(false);
    setStopDraft({
      code: stop.code,
      name: stop.name,
      description: stop.description,
      latitude: stop.latitude,
      longitude: stop.longitude,
      kind: stop.kind,
      geofenceM: stop.geofenceM,
      isActive: stop.isActive,
      displayOrder: stop.displayOrder,
    });
  };

  const beginCreateStop = () => {
    setEditingStop(null);
    setCreatingStop(true);
    setPinMode(false);
    setStopDraft({
      code: '', name: '', description: null,
      latitude: 31.86995, longitude: -106.408,
      kind: 'both', geofenceM: null, isActive: true, displayOrder: stops.length,
    });
  };

  const saveStop = async () => {
    if (stopDraft == null) return;
    setSaving(true);
    try {
      if (editingStop == null) await api.fleet.createStop(stopDraft);
      else await api.fleet.updateStop(editingStop.id, stopDraft);
      setEditingStop(null);
      setCreatingStop(false);
      setStopDraft(null);
      setPinMode(false);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const retireStop = async (stop: Stop) => {
    if (!window.confirm(`Retire “${stop.name}”? It will no longer be available for new requests; historical records will be kept.`)) return;
    setSaving(true);
    try {
      await api.fleet.deactivateStop(stop.id);
      await load();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Could not retire stop.');
    } finally {
      setSaving(false);
    }
  };

  const saveRoute = async (body: UpsertRouteBody, assignedShuttleIds: string[]) => {
    setSaving(true);
    setPageError(null);
    try {
      const saved = await api.fleet.saveRoute(body, editingRoute?.id);
      const selected = new Set(assignedShuttleIds);
      const affected = shuttles.filter((shuttle) =>
        selected.has(shuttle.id) || shuttle.defaultRouteId === saved.id,
      );
      await Promise.all(affected.map((shuttle) => {
        const defaultRouteId = selected.has(shuttle.id) ? saved.id : null;
        return shuttle.defaultRouteId === defaultRouteId
          ? Promise.resolve(shuttle)
          : api.fleet.updateShuttle(shuttle.id, { defaultRouteId });
      }));
      setEditingRoute(null);
      setCreatingRoute(false);
      await load();
    } catch (error) {
      await load();
      throw error;
    } finally {
      setSaving(false);
    }
  };

  const setRouteActive = async (route: RouteWithStops, isActive: boolean) => {
    setSaving(true);
    setPageError(null);
    try {
      const saved = await api.fleet.saveRoute({
        code: route.code,
        name: route.name,
        description: route.description,
        isLoop: route.isLoop,
        isActive,
        stops: [...route.stops].sort((a, b) => a.stopOrder - b.stopOrder).map((leg) => ({
          stopId: leg.stopId,
          stopOrder: leg.stopOrder,
          distanceFromPrevM: leg.distanceFromPrevM,
          typicalTravelSec: leg.typicalTravelSec,
        })),
      }, route.id);
      if (!isActive) {
        await Promise.all(shuttles.filter((shuttle) => shuttle.defaultRouteId === saved.id)
          .map((shuttle) => api.fleet.updateShuttle(shuttle.id, { defaultRouteId: null })));
      }
      await load();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : `Could not ${isActive ? 'restore' : 'retire'} route.`);
    } finally {
      setSaving(false);
    }
  };

  const pinStopOnMap = React.useCallback((latitude: number, longitude: number) => {
    setStopDraft((current) => current == null ? current : { ...current, latitude, longitude });
  }, []);

  const waitingFor = (stopId: string) =>
    waiting.find((w) => w.stopId === stopId)?.waitingPassengers ?? 0;

  return (
    <AdminShell section="Manage" title="Stops & routes">
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 380px', gap: 16, flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
          {pageError && <div role="alert" style={{ padding: 12, color: '#a61b1b', background: '#fff0f0', borderRadius: 8 }}>{pageError}</div>}
          {(editingStop != null || creatingStop) && stopDraft != null && (
            <StopEditor
              stop={editingStop}
              draft={stopDraft}
              pinMode={pinMode}
              saving={saving}
              onChange={setStopDraft}
              onPinToggle={() => setPinMode((active) => !active)}
              onCancel={() => { setEditingStop(null); setCreatingStop(false); setStopDraft(null); setPinMode(false); }}
              onSave={saveStop}
            />
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: fontSize.lg, fontWeight: weight.semibold }}>Stops</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ color: theme.fg3, fontSize: fontSize.sm }}>Use Edit → Pin location on map to place a stop.</span>
              {!creatingStop && editingStop == null && <button type="button" onClick={beginCreateStop} style={{ border: 0, borderRadius: 6, padding: '9px 13px', background: theme.accentBtn, color: '#fff', cursor: 'pointer', fontWeight: 600 }}>+ Add stop</button>}
            </div>
          </div>
          <DataTable
            columns={STOP_COLUMNS}
            emptyMessage={loading ? 'Loading…' : 'No stops configured.'}
            footer={`${stops.length} stops · ${routes.length} route${routes.length === 1 ? '' : 's'}`}
            rows={stops.map((stop) => ({
              id: stop.id,
              cells: [
                cell.text(stop.name, { bold: true }),
                cell.text(stop.code, { mono: true }),
                cell.text(KIND_LABELS[stop.kind], { color: theme.fg2 }),
                cell.text(`${stop.latitude.toFixed(5)}, ${stop.longitude.toFixed(5)}`, {
                  mono: true,
                  color: theme.fg2,
                }),
                cell.text(stop.geofenceM == null ? 'default' : `${stop.geofenceM} m`, { mono: true }),
                cell.text(waitingFor(stop.id), { mono: true }),
                cell.pill(stop.isActive ? 'Active' : 'Retired', stop.isActive ? 'ok' : 'neutral'),
                cell.node(<div style={{ display: 'flex', gap: 5 }}>
                  <button type="button" onClick={() => beginEditStop(stop)} style={{ border: `1px solid ${theme.border}`, borderRadius: 5, padding: '5px 8px', background: theme.surface, color: theme.accent, cursor: 'pointer' }}>Edit</button>
                  {stop.isActive
                    ? <button type="button" disabled={saving} onClick={() => void retireStop(stop)} style={{ border: `1px solid ${theme.border}`, borderRadius: 5, padding: '5px 8px', background: theme.surface, color: '#a61b1b', cursor: 'pointer' }}>Retire</button>
                    : <button type="button" disabled={saving} onClick={() => void api.fleet.updateStop(stop.id, { isActive: true }).then(load).catch((error: unknown) => setPageError(error instanceof Error ? error.message : 'Could not restore stop.'))} style={{ border: `1px solid ${theme.border}`, borderRadius: 5, padding: '5px 8px', background: theme.surface, color: theme.accent, cursor: 'pointer' }}>Restore</button>}
                </div>),
              ],
            }))}
          />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: fontSize.lg, fontWeight: weight.semibold }}>Routes</h2>
            {!creatingRoute && editingRoute == null && (
              <button type="button" onClick={() => setCreatingRoute(true)} style={{ border: 0, borderRadius: 6, padding: '9px 13px', background: theme.accentBtn, color: '#fff', cursor: 'pointer', fontWeight: 600 }}>+ Create route</button>
            )}
          </div>
          {(creatingRoute || editingRoute != null) && (
            <RouteEditor
              key={editingRoute?.id ?? 'new-route'}
              route={editingRoute}
              stops={stops}
              shuttles={shuttles}
              saving={saving}
              onCancel={() => { setEditingRoute(null); setCreatingRoute(false); }}
              onSave={saveRoute}
            />
          )}

          {routes.map((route) => (
            <Card key={route.id} padding={20} style={{ flex: 'none' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
                <h2 style={{ margin: 0, fontSize: fontSize.lg, fontWeight: weight.semibold, color: route.isActive ? theme.fg : theme.fg3 }}>
                  Route · {route.name}{!route.isActive ? ' · Retired' : ''}
                </h2>
                <Mono size={fontSize.xs} color={theme.fg3}>
                  {route.isLoop ? 'Loop · returns to first stop' : 'One-way'} · {route.stops.length} stops ·{' '}
                  {formatDistance(
                    route.stops.reduce((sum, leg) => sum + (leg.distanceFromPrevM ?? 0), 0),
                  )}{' '}
                  ·{' '}
                  {formatDuration(
                    route.stops.reduce((sum, leg) => sum + (leg.typicalTravelSec ?? 0), 0),
                  )}
                </Mono>
                <button type="button" onClick={() => { setCreatingRoute(false); setEditingRoute(route); }} style={{ marginLeft: 'auto', border: `1px solid ${theme.border}`, borderRadius: 6, padding: '6px 10px', background: theme.surface, color: theme.accent, cursor: 'pointer' }}>Edit route</button>
                <button type="button" disabled={saving} onClick={() => void setRouteActive(route, !route.isActive)} style={{ border: `1px solid ${theme.border}`, borderRadius: 6, padding: '6px 10px', background: theme.surface, color: route.isActive ? '#a61b1b' : theme.accent, cursor: 'pointer' }}>{route.isActive ? 'Retire route' : 'Restore route'}</button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[...route.stops]
                  .sort((a, b) => a.stopOrder - b.stopOrder)
                  .map((leg, index) => (
                    <div
                      key={leg.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 12,
                        fontSize: fontSize.base,
                        padding: '6px 0',
                        borderTop: index === 0 ? 'none' : `1px solid ${theme.sunken}`,
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: '50%',
                            background: brand.bluePale,
                            color: brand.avatarFg,
                            fontFamily: "'IBM Plex Mono', monospace",
                            fontSize: 11,
                            fontWeight: weight.semibold,
                            display: 'grid',
                            placeItems: 'center',
                            flex: 'none',
                          }}
                        >
                          {leg.stopOrder + 1}
                        </span>
                        <span style={{ fontWeight: weight.medium }}>{leg.stop.name}</span>
                      </span>

                      <Mono size={fontSize.sm} color={theme.fg2}>
                        {leg.distanceFromPrevM == null
                          ? 'start'
                          : `${formatDistance(leg.distanceFromPrevM)} · ${formatDuration(leg.typicalTravelSec)}`}
                      </Mono>
                    </div>
                  ))}
              </div>

              <p style={{ margin: '12px 0 0', fontSize: fontSize.sm, color: theme.fg3, lineHeight: 1.5 }}>
                {route.isLoop
                  ? 'After the final stop, the shuttle follows the road route back to the first stop. The ETA engine includes this return leg.'
                  : 'The route ends at the final stop. Enable “Return to the first stop” in Edit route to make this a loop.'}
              </p>
            </Card>
          ))}
        </div>

        <Card padding={0} style={{ overflow: 'hidden', alignSelf: 'start', height: 520 }}>
          <CampusMap
            stops={stops.filter((s) => s.isActive)}
            route={routes.find((route) => route.isActive) ?? null}
            shuttles={[]}
            height={520}
            onMapClick={(editingStop != null || creatingStop) && pinMode ? pinStopOnMap : undefined}
          />
        </Card>
      </div>
    </AdminShell>
  );
}
