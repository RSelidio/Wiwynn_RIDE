/**
 * Geodesy helpers. Plain spherical maths — no PostGIS, no paid geocoding
 * service (spec §19). Accurate to well under a metre at campus distances,
 * which is finer than the GPS accuracy we receive anyway.
 */

export interface LatLng {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/** Great-circle distance in metres between two points. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const lat1 = a.latitude * DEG;
  const lat2 = b.latitude * DEG;
  const dLat = lat2 - lat1;
  const dLng = (b.longitude - a.longitude) * DEG;

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from `a` to `b`, in degrees clockwise from true north. */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const lat1 = a.latitude * DEG;
  const lat2 = b.latitude * DEG;
  const dLng = (b.longitude - a.longitude) * DEG;

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** True when `point` is inside `radiusM` of `center`. */
export function isWithin(point: LatLng, center: LatLng, radiusM: number): boolean {
  return distanceMeters(point, center) <= radiusM;
}

/** Total length in metres of an ordered polyline. */
export function pathLengthMeters(points: readonly LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distanceMeters(points[i - 1]!, points[i]!);
  }
  return total;
}

/**
 * Which leg of a polyline a point sits on, and how far along the whole line it
 * is. Used to place a shuttle on its route so remaining-distance is measured
 * along the road rather than as a straight line through buildings.
 */
export interface PathProjection {
  /** Index of the leg the point projects onto (leg i spans points[i]→points[i+1]). */
  segmentIndex: number;
  /** Metres from the start of the polyline to the projected point. */
  alongM: number;
  /** Perpendicular distance from the point to the line, in metres. */
  offsetM: number;
  /** The projected point itself. */
  projected: LatLng;
}

/**
 * Project a point onto a polyline.
 *
 * Works in a local equirectangular frame centred on the point — at campus
 * scale the distortion is negligible and it keeps the maths to plain algebra.
 */
export function projectOntoPath(point: LatLng, path: readonly LatLng[]): PathProjection | null {
  if (path.length === 0) return null;
  if (path.length === 1) {
    return {
      segmentIndex: 0,
      alongM: 0,
      offsetM: distanceMeters(point, path[0]!),
      projected: path[0]!,
    };
  }

  // Metres-per-degree at this latitude, used to flatten lat/lng into x/y.
  const mPerDegLat = 111_132.92;
  const mPerDegLng = 111_319.49 * Math.cos(point.latitude * DEG);
  const toXY = (p: LatLng) => ({
    x: (p.longitude - point.longitude) * mPerDegLng,
    y: (p.latitude - point.latitude) * mPerDegLat,
  });
  const toLatLng = (xy: { x: number; y: number }): LatLng => ({
    latitude: point.latitude + xy.y / mPerDegLat,
    longitude: point.longitude + xy.x / mPerDegLng,
  });

  const target = { x: 0, y: 0 };
  let best: PathProjection | null = null;
  let traversed = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const a = toXY(path[i]!);
    const b = toXY(path[i + 1]!);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const legLen = Math.hypot(dx, dy);

    // Clamp to the segment so the projection never runs past a corner.
    const t = legLen === 0 ? 0 : Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / (legLen * legLen)));
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const offsetM = Math.hypot(target.x - px, target.y - py);

    if (best === null || offsetM < best.offsetM) {
      best = {
        segmentIndex: i,
        alongM: traversed + legLen * t,
        offsetM,
        projected: toLatLng({ x: px, y: py }),
      };
    }
    traversed += legLen;
  }

  return best;
}

/** Metres remaining from a projected position to the end of the polyline. */
export function remainingAlongPath(
  projection: PathProjection,
  path: readonly LatLng[],
): number {
  return Math.max(0, pathLengthMeters(path) - projection.alongM);
}

/** Convert km/h to m/s. */
export function kmhToMs(kmh: number): number {
  return (kmh * 1000) / 3600;
}

/** Convert m/s to km/h. */
export function msToKmh(ms: number): number {
  return (ms * 3600) / 1000;
}
