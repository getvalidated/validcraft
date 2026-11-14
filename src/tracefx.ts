import type Phaser from 'phaser';
import type { Show } from './app';
import { COLORS, hex, shadeColor } from './palette';
import type { Layout, SimState } from './seam';
import { resourcePath } from './shapes';
import type { TraceFocus } from './traces';

const TRACE = hex(COLORS.trace);

export function drawTrace(g: Phaser.GameObjects.Graphics, state: SimState, focus: TraceFocus, layout: Layout, show: Show, ux: Float64Array, uy: Float64Array, ua: Float32Array, r: number, thin: number) {
  for (const b of layout.buildings) {
    if (!focus.buildings.has(b.id)) continue;
    g.lineStyle(2 * thin, TRACE, 0.85);
    if (b.features.length) g.strokeRoundedRect(b.rect.x - 3, b.rect.y - 3, b.rect.w + 6, b.rect.h + 6, 9);
    else g.strokeCircle(b.x, b.y - 2, b.size * 0.7);
  }
  for (const id of focus.hands) {
    const i = layout.index.get(id)!;
    if (!(ua[i] > 0) || state.units[i]?.hidden) continue;
    g.lineStyle(1.8 * thin, TRACE, 0.9);
    g.strokeCircle(ux[i], uy[i], r + 7);
  }
  for (const ring of state.rings) {
    if (ring.trace !== focus.id || (ring.resource && !show.types[ring.resource])) continue;
    g.lineStyle(2.2 * thin, TRACE, ring.alpha);
    g.strokeCircle(ring.x, ring.y, ring.radius);
  }
  for (const flight of state.flights) {
    if (flight.trace !== focus.id || !show.types[flight.resource] || flight.kind === 'spawn') continue;
    const size = (flight.kind === 'send' ? 4.6 : 3) * thin * 1.25;
    g.lineStyle(1.2 * thin, TRACE, 0.45 * (1 - flight.progress));
    g.lineBetween(flight.from.x, flight.from.y, flight.x, flight.y);
    g.fillStyle(TRACE, 0.3);
    g.fillCircle(flight.x, flight.y, size + 5 * thin);
    g.fillStyle(shadeColor(flight.resource, flight.shade), 1);
    resourcePath(g, flight.resource, flight.x, flight.y, size);
    g.fillPath();
    g.lineStyle(1.6 * thin, TRACE, 1);
    g.strokePath();
  }
}
