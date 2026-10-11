import type * as THREE from 'three';
import { ROOM, type Box, type Circle } from '../world/tavern.ts';

export const PLAYER_RADIUS = 0.5;

/** Repousse un point (pieds du joueur) hors des murs, meubles et autres personnages. */
export function resolveCollisions(p: THREE.Vector3, boxes: Box[], circles: Circle[], r = PLAYER_RADIUS): void {
  p.x = Math.max(-ROOM.halfX + r, Math.min(ROOM.halfX - r, p.x));
  p.z = Math.max(-ROOM.halfZ + r, Math.min(ROOM.halfZ - r, p.z));
  for (const b of boxes) {
    const cx = Math.max(b.x0, Math.min(b.x1, p.x)), cz = Math.max(b.z0, Math.min(b.z1, p.z));
    const dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz);
    if (d >= r) continue;
    if (d > 1e-4) { p.x = cx + (dx / d) * r; p.z = cz + (dz / d) * r; continue; }
    // centre à l'intérieur de la boîte : sortie par le bord le plus proche
    const l = p.x - b.x0, rr = b.x1 - p.x, t = p.z - b.z0, bb = b.z1 - p.z, m = Math.min(l, rr, t, bb);
    if (m === l) p.x = b.x0 - r; else if (m === rr) p.x = b.x1 + r; else if (m === t) p.z = b.z0 - r; else p.z = b.z1 + r;
  }
  for (const c of circles) {
    const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz), min = c.r + r * 0.8;
    if (d < min && d > 1e-4) { p.x = c.x + (dx / d) * min; p.z = c.z + (dz / d) * min; }
  }
}
