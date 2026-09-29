/** Interactive, browser-only OSM street map shared by employee/admin web apps. */
'use client';

import React from 'react';
import type { LayerGroup, Map as LeafletMap, Marker } from 'leaflet';
import type { RouteWithStops, Stop } from '@shuttle/shared-types';
import { brand, font } from './tokens';

export interface MapShuttle {
  shuttleId: string;
  colorIndex?: number;
  routeId?: string | null;
  nextStopId?: string | null;
  /** Live road route from the latest fix to `nextStopId`; null means unavailable. */
  remainingPath?: Array<{ latitude: number; longitude: number }> | null;
  name: string;
  badge: string;
  position: { latitude: number; longitude: number; isStale: boolean; headingDeg?: number | null; speedKmh?: number | null };
  focused?: boolean;
  etaLabel?: string;
  subLabel?: string;
}

// Initial El Paso map focus. Stop markers are always sourced from the
// admin-maintained records, never hardcoded in this component.
const SITE_CENTER = { latitude: 31.680689, longitude: -106.278986 };
const MAX_SITE_DISTANCE_M = 30_000;
const SHUTTLE_COLORS = ['#1769aa', '#d45b18', '#743db3', '#00846b', '#c23d5a', '#8b6d00', '#087e9b', '#a63d8d'] as const;

function shuttleColor(index: number): string {
  if (index < SHUTTLE_COLORS.length) return SHUTTLE_COLORS[index]!;
  const hue = Math.round(((index - SHUTTLE_COLORS.length) * 137.508 + 24) % 360);
  return `hsl(${hue} 72% 38%)`;
}

function metersBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const radians = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * radians;
  const dLng = (b.longitude - a.longitude) * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function CampusMap({
  stops,
  route,
  shuttles,
  pickupStopId,
  destinationStopId,
  stopEtaLabels,
  onShuttleClick,
  onStopClick,
  onMapClick,
  height = '100%',
}: {
  stops: Stop[];
  route?: RouteWithStops | null;
  shuttles: MapShuttle[];
  pickupStopId?: string | null;
  destinationStopId?: string | null;
  /** Best live ETA label per stop, typically from the nearest active shuttle. */
  stopEtaLabels?: Record<string, string>;
  onShuttleClick?: (shuttleId: string) => void;
  onStopClick?: (stopId: string) => void;
  onMapClick?: (latitude: number, longitude: number) => void;
  height?: number | string;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<LeafletMap | null>(null);
  const layersRef = React.useRef<LayerGroup | null>(null);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    let map: LeafletMap | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let initFrame = 0;
    void import('leaflet').then((L) => {
      if (cancelled || !hostRef.current) return;
      const host = hostRef.current;
      // Let flex/absolute layout settle before Leaflet reads the map viewport.
      initFrame = requestAnimationFrame(() => {
        if (cancelled || !host.isConnected) return;
        map = L.map(host, { scrollWheelZoom: true }).setView([SITE_CENTER.latitude, SITE_CENTER.longitude], 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(map);
        mapRef.current = map;
        resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => map?.invalidateSize({ pan: false })));
        resizeObserver.observe(host);
        requestAnimationFrame(() => map?.invalidateSize({ pan: false }));
        setReady(true);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(initFrame);
      resizeObserver?.disconnect();
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!ready || map == null || onMapClick == null) return;
    const handleClick = (event: { latlng: { lat: number; lng: number } }) => {
      onMapClick(event.latlng.lat, event.latlng.lng);
    };
    map.on('click', handleClick);
    return () => { map.off('click', handleClick); };
  }, [ready, onMapClick]);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    let disposed = false;
    void import('leaflet').then((L) => {
      if (disposed || mapRef.current !== map) return;
      layersRef.current?.remove();
      const layers = L.layerGroup().addTo(map);
      layersRef.current = layers;
      const addStopMarker = (stop: { name: string; latitude: number; longitude: number; id?: string }, highlighted: boolean, destination: boolean) => {
        const etaLabel = stop.id == null ? undefined : stopEtaLabels?.[stop.id];
        const iconColor = highlighted ? brand.blue : '#526575';
        const labelWidth = Math.min(172, Math.max(86, stop.name.length * 7 + 22));
        const labelHeight = etaLabel ? 38 : 25;
        const iconHeight = 14;
        const iconWidth = 14;
        const iconSize: [number, number] = [iconWidth + 7 + labelWidth, Math.max(iconHeight, labelHeight)];
        const marker = L.marker([stop.latitude, stop.longitude], {
          title: stop.name,
          icon: L.divIcon({
            className: '',
            html: `<span style="display:flex;align-items:center;gap:7px;white-space:nowrap;pointer-events:auto"><span aria-hidden="true" style="flex:none;width:${iconWidth}px;height:${iconHeight}px;box-sizing:border-box;border:2px solid #fff;border-radius:${destination ? 2 : 5}px;background:${iconColor};box-shadow:0 1px 4px #0008"></span><span style="box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;max-width:172px;min-height:${labelHeight}px;padding:${etaLabel ? '4px 8px' : '3px 8px'};overflow:hidden;border:1px solid ${highlighted ? brand.blue : '#d5dee5'};border-radius:5px;background:${highlighted ? '#fff' : 'rgba(255,255,255,.94)'};color:#183247;box-shadow:0 1px 5px #0004;font:600 11px 'IBM Plex Sans',sans-serif;line-height:14px"><span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(stop.name)}</span>${etaLabel ? `<span style="color:#526575;font:500 10px 'IBM Plex Sans',sans-serif">${escapeHtml(etaLabel)}</span>` : ''}</span></span>`,
            iconSize,
            iconAnchor: [7, iconSize[1] / 2],
          }),
        }).addTo(layers);
        marker.bindPopup(`<strong>${escapeHtml(stop.name)}</strong>${etaLabel ? `<br>Shuttle ETA: ${escapeHtml(etaLabel)}` : '<br>ETA unavailable'}`);
        if (stop.id && onStopClick) marker.on('click', () => onStopClick(stop.id!));
      };

      // Render only router-provided road geometry; never connect stop points
      // with misleading straight-line segments when road routing is absent.
      const roadPath = route?.roadPath?.filter((point) =>
        Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && metersBetween(SITE_CENTER, point) <= MAX_SITE_DISTANCE_M,
      );
      if (roadPath != null && roadPath.length > 1 && roadPath.length === route?.roadPath?.length) {
        L.polyline(roadPath.map((point) => [point.latitude, point.longitude] as [number, number]), {
          color: '#66869b',
          weight: 4,
          opacity: 0.58,
          lineCap: 'round',
          lineJoin: 'round',
        }).addTo(layers);
      }

      shuttles.forEach((routeShuttle, shuttleIndex) => {
        const remaining = routeShuttle.remainingPath;
        const color = shuttleColor(routeShuttle.colorIndex ?? shuttleIndex);
        if (remaining != null && remaining.length > 1 && remaining.every((point) => metersBetween(SITE_CENTER, point) <= MAX_SITE_DISTANCE_M)) {
            L.polyline(remaining.map((point) => [point.latitude, point.longitude] as [number, number]), {
              color: '#fff',
              weight: 13,
              opacity: 0.98,
              lineCap: 'round',
              lineJoin: 'round',
            }).addTo(layers);
            L.polyline(remaining.map((point) => [point.latitude, point.longitude] as [number, number]), {
              color,
              weight: 8,
              opacity: 1,
              lineCap: 'round',
              lineJoin: 'round',
            }).addTo(layers);

        }
      });

      const localStops = stops.filter((stop) => Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude) && metersBetween(SITE_CENTER, stop) <= MAX_SITE_DISTANCE_M);
      for (const stop of localStops) {
        addStopMarker(stop, stop.id === pickupStopId || stop.id === destinationStopId, stop.id === destinationStopId);
      }

      shuttles.forEach((shuttle, shuttleIndex) => {
        if (metersBetween(SITE_CENTER, shuttle.position) > MAX_SITE_DISTANCE_M) return;
        const color = shuttle.position.isStale ? '#8a96a3' : shuttleColor(shuttle.colorIndex ?? shuttleIndex);
        const rotation = !shuttle.position.isStale && shuttle.position.headingDeg != null
          ? `transform:rotate(${shuttle.position.headingDeg}deg);`
          : '';
        const marker: Marker = L.marker([shuttle.position.latitude, shuttle.position.longitude], {
          title: shuttle.name,
          icon: L.divIcon({
            className: '',
            html: `<span style="display:grid;place-items:center;width:38px;height:38px;border:2px solid white;border-radius:13px;background:${color};box-shadow:0 2px 7px #0007"><svg aria-hidden="true" viewBox="0 0 40 40" width="30" height="30" style="${rotation}"><path d="M12 5.5C13 4 14.5 3 17 3h6c2.5 0 4 1 5 2.5l3 7.5 2.5 3.5v14c0 2-1.5 3.5-3.5 3.5h-20C8 34 6.5 32.5 6.5 30.5v-14L9 13z" fill="#fff" stroke="#183247" stroke-width="1.5"/><path d="M13 7.5c.6-1.4 1.6-2 3.5-2h7c1.9 0 2.9.6 3.5 2l2 6h-18z" fill="#8ec5df" stroke="#183247" stroke-width="1.2"/><path d="M10 17h20v10H10z" fill="#f1f5f8" stroke="#183247" stroke-width="1.2"/><path d="M11 29h18v3H11z" fill="#d5e0e7"/><path d="M4 18h3v7H4zm29 0h3v7h-3z" fill="#183247"/><path d="M9 15h4v2H9zm18 0h4v2h-4z" fill="#f5c84b"/></svg></span>`,
            iconSize: [38, 38],
            iconAnchor: [19, 19],
          }),
        }).addTo(layers);
        marker.bindPopup(`<strong>${escapeHtml(shuttle.name)}</strong>${shuttle.etaLabel ? `<br>${escapeHtml(shuttle.etaLabel)}` : ''}${shuttle.subLabel ? `<br>${escapeHtml(shuttle.subLabel)}` : ''}`);
        if (onShuttleClick) marker.on('click', () => onShuttleClick(shuttle.shuttleId));
      });

      map.invalidateSize();
    });
    return () => {
      disposed = true;
      layersRef.current?.remove();
      layersRef.current = null;
    };
  }, [ready, stops, route, shuttles, pickupStopId, destinationStopId, stopEtaLabels, onShuttleClick, onStopClick]);

  const fillsParent = height === '100%';
  return (
    <div
      ref={hostRef}
      role="application"
      aria-label="Interactive El Paso street map showing shuttle stops and live shuttle positions"
      style={{
        position: fillsParent ? 'absolute' : 'relative',
        ...(fillsParent ? { inset: 0 } : { height }),
        width: '100%',
        background: '#e9eff3',
        fontFamily: font.sans,
      }}
    />
  );
}
