import type { Coord, Polygon } from "../types";

export function pointInPolygon(point: Coord, polygon: Polygon): boolean {
  const [x, y] = point; // lon, lat
  let inside = false;
  // consider only outer ring polygon[0]
  const ring = polygon[0] || [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
