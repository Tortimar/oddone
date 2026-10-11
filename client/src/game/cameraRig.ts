import * as THREE from 'three';
import { camera, damp } from '../engine/render.ts';
import { ROOM, type Tavern } from '../world/tavern.ts';
import { look } from './input.ts';

/**
 * Caméra selon le moment :
 * - menu : lent travelling dans la taverne derrière l'écran d'accueil
 * - follow : 3e personne derrière le joueur (le mur entre la caméra et lui est masqué)
 * - bar : point de vue du tavernier, face aux 4 tabourets
 * - tailor : face au joueur pendant la personnalisation
 */
export type CameraMode = 'menu' | 'follow' | 'bar' | 'tailor';

const pos = new THREE.Vector3(0, 6, 14), target = new THREE.Vector3(0, 1.5, 0);
const wantPos = new THREE.Vector3(), wantTarget = new THREE.Vector3();

export function updateCamera(mode: CameraMode, t: number, dt: number, player: { position: THREE.Vector3; yaw: number }, tavern: Tavern): void {
  const P = player.position, aspect = camera.aspect;
  let fov = 50;
  if (mode === 'menu') {
    const a = t * 0.08;
    wantPos.set(Math.sin(a) * 9, 5.5, Math.cos(a) * 6 + 1); wantTarget.set(0, 1.6, -1);
  } else if (mode === 'bar') {
    wantPos.set(0.4, 4.3, -7.7); wantTarget.set(0, 1.3, -2.6);
    fov = aspect < 1 ? Math.min(100, (52 / aspect) * 0.8) : 52;
  } else if (mode === 'tailor') {
    const y = player.yaw, side = aspect < 1 ? 0 : 1.1;
    wantPos.set(P.x + Math.sin(y) * 4.4 + Math.cos(y) * side, P.y + 2.4, P.z + Math.cos(y) * 4.4 - Math.sin(y) * side);
    wantTarget.set(P.x + Math.cos(y) * side, P.y + (aspect < 1 ? 0.4 : 1.5), P.z - Math.sin(y) * side);
  } else {
    const d = 7.5, h = Math.sin(look.pitch) * d, hd = Math.cos(look.pitch) * d;
    wantPos.set(P.x + Math.sin(look.yaw) * hd, P.y + 1.6 + h, P.z + Math.cos(look.yaw) * hd);
    wantTarget.set(P.x, P.y + 1.9, P.z);
    fov = aspect < 1 ? 62 : 50;
  }
  const k = 1 - Math.exp(-(mode === 'follow' ? 10 : 4) * dt);
  pos.lerp(wantPos, k); target.lerp(wantTarget, k);
  camera.position.copy(pos);
  camera.lookAt(target);
  if (Math.abs(camera.fov - fov) > 0.1) { camera.fov = damp(camera.fov, fov, 4, dt); camera.updateProjectionMatrix(); }

  // masque le mur qui se trouve entre la caméra et la salle
  const inside = mode !== 'menu';
  const { halfX: RX, halfZ: RZ } = ROOM, c = camera.position;
  const hide = { front: inside && c.z > RZ - 0.2, back: inside && c.z < -RZ + 0.2, left: inside && c.x < -RX + 0.2, right: inside && c.x > RX - 0.2 };
  for (const side of Object.keys(hide) as (keyof typeof hide)[]) for (const o of tavern.wallsBySide[side]) o.visible = !hide[side];
}
