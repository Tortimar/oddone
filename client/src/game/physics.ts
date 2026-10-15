import type * as THREE from 'three';
import { pushOut, type Box, type Bounds, type Circle } from '@oddone/shared';

export const PLAYER_RADIUS = 0.5;

/** Repousse un point (pieds du joueur) hors des bords, des meubles et des autres personnages. */
export function resolveCollisions(p: THREE.Vector3, bounds: Bounds, boxes: Box[], circles: Circle[], r = PLAYER_RADIUS): void {
  pushOut(p, bounds, boxes, circles, r); // même code que le serveur (shared/src/geometry.ts)
}
