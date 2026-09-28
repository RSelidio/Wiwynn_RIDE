/**
 * Schematic campus map.
 *
 * Draws real stop coordinates and live shuttle positions projected into an SVG
 * viewBox — no tile server, no MapLibre, no OpenStreetMap request. Spec §7 says
 * a map is not required for the MVP and that free public tile servers must not
 * be leaned on as production infrastructure, so the default view is this
 * schematic: geographically faithful in layout without fetching anything.
 *
 * When the company later stands up self-hosted tiles, this component is the
 * seam to replace; everything around it passes stops, routes and positions and
 * would not change.
 */

'use client';

import React from 'react';
import type { LivePosition, RouteWithStops, Stop } from '@shuttle/shared-types';
import { brand, font } from './tokens';

export interface MapShuttle {
  shuttleId: string;
  name: string;
  /** Short label drawn inside the marker — usually the shuttle number. */
  badge: string;
  position: LivePosition;
  /** Highlight this shuttle (the one assigned to the viewer). */
  focused?: boolean;
  etaLabel?: string;
  subLabel?: string;
}

interface Bounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

const VIEW_W = 400;
const VIEW_H = 620;
const PAD = 52;

function boundsOf(points: Array<{ latitude: number; longitude: number }>): Bounds {
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  return {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLng: Math.min(...lngs),
    maxLng: Math.max(...lngs),
  };
}

/**
 * Build a lat/lng → SVG projector.
 *
 * Longitude is scaled by cos(latitude) so the campus is not stretched
 * east-west, and one scale factor is used for both axes so the shape stays
 * true rather than being fitted to the box.
 */
function makeProjector(bounds: Bounds, width: number, height: number) {
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const lngScale = Math.cos((midLat * Math.PI) / 180);

  const spanLat = Math.max(1e-6, bounds.maxLat - bounds.minLat);
  const spanLng = Math.max(1e-6, (bounds.maxLng - bounds.minLng) * lngScale);

  const usableW = width - PAD * 2;
  const usableH = height - PAD * 2;
  const scale = Math.min(usableW / spanLng, usableH / spanLat);

  // Centre whatever slack the aspect-ratio difference leaves over.
  const offsetX = PAD + (usableW - spanLng * scale) / 2;
  const offsetY = PAD + (usableH - spanLat * scale) / 2;

  return (p: { latitude: number; longitude: number }) => ({
    x: offsetX + (p.longitude - bounds.minLng) * lngScale * scale,
    // SVG y grows downward, latitude grows north — so invert.
    y: offsetY + (bounds.maxLat - p.latitude) * scale,
  });
}

export function CampusMap({
  stops,
  route,
  shuttles,
  pickupStopId,
  destinationStopId,
  onShuttleClick,
  onStopClick,
  height = '100%',
}: {
  stops: Stop[];
  route?: RouteWithStops | null;
  shuttles: MapShuttle[];
  pickupStopId?: string | null;
  destinationStopId?: string | null;
  onShuttleClick?: (shuttleId: string) => void;
  onStopClick?: (stopId: string) => void;
  height?: number | string;
}) {
  const plotted = stops.filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude));

  // Nothing to project: say so rather than rendering an empty grey box.
  if (plotted.length === 0) {
    return (
      <div
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#eef2f5',
          color: '#677482',
          fontFamily: font.sans,
          fontSize: 13,
        }}
      >
        No stop coordinates configured yet.
      </div>
    );
  }

  const allPoints = [
    ...plotted.map((s) => ({ latitude: s.latitude, longitude: s.longitude })),
    ...shuttles.map((s) => ({ latitude: s.position.latitude, longitude: s.position.longitude })),
  ];

  const project = makeProjector(boundsOf(allPoints), VIEW_W, VIEW_H);

  const routeStops = route?.stops != null ? [...route.stops].sort((a, b) => a.stopOrder - b.stopOrder) : [];
  const routePoints = routeStops.map((leg) => project(leg.stop));

  // A loop route closes back to its first stop.
  const isLoop = routeStops.length > 2 && routeStops[0]?.distanceFromPrevM != null;
  const routePath =
    routePoints.length > 1
      ? routePoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') +
        (isLoop ? ' Z' : '')
      : '';

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid slice"
      style={{ width: '100%', height, display: 'block', background: '#eef2f5' }}
      role="img"
      aria-label="Campus map showing shuttle stops and live shuttle positions"
    >
      <rect width={VIEW_W} height={VIEW_H} fill="#eef2f5" />

      {/* A faint grid gives the eye something to judge movement against. */}
      <g stroke="#e2e8ee" strokeWidth={1}>
        {Array.from({ length: 7 }, (_, i) => (
          <line key={`h${i}`} x1={0} y1={(i + 1) * 80} x2={VIEW_W} y2={(i + 1) * 80} />
        ))}
        {Array.from({ length: 4 }, (_, i) => (
          <line key={`v${i}`} x1={(i + 1) * 90} y1={0} x2={(i + 1) * 90} y2={VIEW_H} />
        ))}
      </g>

      {/* Configured route */}
      {routePath !== '' && (
        <path
          d={routePath}
          fill="none"
          stroke={brand.blueFaint}
          strokeWidth={6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}

      {/* Stops */}
      {plotted.map((stop) => {
        const p = project(stop);
        const isPickup = stop.id === pickupStopId;
        const isDestination = stop.id === destinationStopId;
        const emphasised = isPickup || isDestination;

        return (
          <g
            key={stop.id}
            transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`}
            onClick={onStopClick == null ? undefined : () => onStopClick(stop.id)}
            style={onStopClick == null ? undefined : { cursor: 'pointer' }}
          >
            {/* Pickup is a circle, destination a square — matches the route rail. */}
            {isDestination ? (
              <rect
                x={-7}
                y={-7}
                width={14}
                height={14}
                rx={2}
                fill={brand.blue}
                stroke="#fff"
                strokeWidth={2.5}
              />
            ) : (
              <circle
                r={emphasised ? 8 : 5.5}
                fill={emphasised ? brand.blue : '#fff'}
                stroke={emphasised ? '#fff' : '#9fb0bf'}
                strokeWidth={emphasised ? 2.5 : 2}
              />
            )}
            <text
              x={11}
              y={4}
              fontFamily="IBM Plex Sans"
              fontSize={emphasised ? 11.5 : 10.5}
              fontWeight={emphasised ? 600 : 500}
              fill={emphasised ? '#141a23' : '#5a6774'}
            >
              {stop.name}
            </text>
          </g>
        );
      })}

      {/* Shuttles, drawn last so they sit above the stops */}
      {shuttles.map((shuttle) => {
        const p = project(shuttle.position);
        const stale = shuttle.position.isStale;
        const colour = stale ? '#8a96a3' : shuttle.focused ? brand.blue : brand.info;

        // Label flips to the left near the right edge so it never runs off.
        const labelLeft = p.x > VIEW_W - 170;
        const labelX = labelLeft ? p.x - 158 : p.x + 18;
        const labelY = p.y < 60 ? p.y + 14 : p.y - 34;

        return (
          <g key={shuttle.shuttleId}>
            {shuttle.focused && !stale && (
              <circle cx={p.x} cy={p.y} r={22} fill="rgba(0,96,144,.14)" />
            )}
            <g
              transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`}
              onClick={onShuttleClick == null ? undefined : () => onShuttleClick(shuttle.shuttleId)}
              style={onShuttleClick == null ? undefined : { cursor: 'pointer' }}
            >
              <circle r={12} fill={colour} stroke="#fff" strokeWidth={3} />
              <text
                y={4}
                textAnchor="middle"
                fontFamily="IBM Plex Mono"
                fontSize={11}
                fontWeight={600}
                fill="#fff"
              >
                {shuttle.badge}
              </text>
              {/* Heading arrow, only when the fix is fresh and moving. */}
              {!stale && shuttle.position.headingDeg != null && (shuttle.position.speedKmh ?? 0) > 3 && (
                <path
                  d="M0 -19 L5 -9 L0 -12 L-5 -9 Z"
                  fill={colour}
                  transform={`rotate(${shuttle.position.headingDeg})`}
                />
              )}
            </g>

            {shuttle.focused && (
              <g transform={`translate(${labelX.toFixed(1)} ${labelY.toFixed(1)})`}>
                <rect width={156} height={34} rx={4} fill="#00344f" />
                <text x={9} y={14} fontFamily="IBM Plex Sans" fontSize={11} fontWeight={600} fill="#fff">
                  {shuttle.name}
                  {shuttle.etaLabel ? ` · ${shuttle.etaLabel}` : ''}
                </text>
                <text x={9} y={27} fontFamily="IBM Plex Mono" fontSize={9.5} fill="#8fb5cd">
                  {stale ? 'No recent GPS fix' : (shuttle.subLabel ?? '')}
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* Honest about what this is: a schematic, not surveyed cartography. */}
      <text
        x={VIEW_W - 8}
        y={VIEW_H - 8}
        textAnchor="end"
        fontFamily="IBM Plex Mono"
        fontSize={8.5}
        fill="#8a96a3"
      >
        Schematic · campus coordinates · no external tiles
      </text>
    </svg>
  );
}
