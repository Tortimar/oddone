/**
 * Collisions au sol (plan x/z), partagées par le client (joueur local) et le serveur
 * (squelettes et bots des mini-jeux) : tout le monde se cogne aux mêmes obstacles.
 */

/** Boîte alignée sur les axes. */
export interface Box { x0: number; x1: number; z0: number; z1: number }
export interface Circle { x: number; z: number; r: number }
/** Demi-dimensions de la zone jouable, centrée sur l'origine. */
export interface Bounds { halfX: number; halfZ: number }
export interface Point { x: number; z: number }

/** Repousse un point (pieds d'un personnage de rayon r) hors des bords, des boîtes et des cercles. */
export function pushOut(p: Point, bounds: Bounds, boxes: readonly Box[], circles: readonly Circle[], r: number): void {
  p.x = Math.max(-bounds.halfX + r, Math.min(bounds.halfX - r, p.x));
  p.z = Math.max(-bounds.halfZ + r, Math.min(bounds.halfZ - r, p.z));
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

export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);
