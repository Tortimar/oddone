import * as THREE from 'three';
import { camera, damp } from '../engine/render.ts';
import { CAMERA_BOUNDS } from '../world/tavern.ts';
import { look } from './input.ts';

/**
 * Caméra selon le moment :
 * - menu : lent travelling dans la taverne derrière l'écran d'accueil
 * - follow : 3e personne derrière le joueur
 * - bar : point de vue du tavernier, face aux 4 tabourets
 * - tailor : face au joueur pendant la personnalisation
 * - barman : soirée de quêtes, derrière les joueurs assis, face au tavernier
 * - suspects : derrière le comptoir, face aux joueurs assis (vote de l'imposteur)
 * - training : écran des règles d'un mini-jeu, au-dessus du joueur qui s'entraîne
 * - arena : mini-jeu, vue plongeante fixe sur toute l'arène
 * - podium : résultats, podium décalé à gauche pour laisser la place au classement (en bas sur mobile)
 * - chase : course vue de derrière et d'en haut, qui suit le joueur (Pont Branlant)
 * - market : place du marché vue d'en haut (ancienne vue du Festin du Roi)
 * - ramp : Tonneaux Fous, de face et d'en haut : la montée où l'on est et celle du dessus
 * - thirdPerson : comme `follow` (3e personne, souris), mais dehors : la caméra reste dans le
 *   cercle donné par `setCameraRadius` (devant les façades) au lieu des murs de la taverne
 *
 * La caméra ne sort jamais de la salle : si la position voulue traverse un mur ou le plafond,
 * elle est ramenée vers le joueur le long du même axe (comme un bras de caméra qui se replie).
 */
export type CameraMode = 'menu' | 'follow' | 'bar' | 'tailor' | 'barman' | 'suspects' | 'training' | 'arena' | 'podium' | 'chase' | 'market' | 'thirdPerson' | 'ramp' | 'custom';

const pos = new THREE.Vector3(0, 5, 10), target = new THREE.Vector3(0, 1.5, 0);
const wantPos = new THREE.Vector3(), wantTarget = new THREE.Vector3();
const FOLLOW_DISTANCE = 7.5;

/**
 * Ramène `p` à l'intérieur de la boîte CAMERA_BOUNDS en glissant le long du segment origin → p.
 * `origin` (la tête du joueur) est supposé être dans la boîte.
 */
function keepInside(origin: THREE.Vector3, p: THREE.Vector3): void {
  const b = CAMERA_BOUNDS;
  let t = 1;
  const limit = (o: number, v: number, lo: number, hi: number) => {
    const d = v - o;
    if (v > hi && d > 1e-6) t = Math.min(t, (hi - o) / d);
    if (v < lo && d < -1e-6) t = Math.min(t, (lo - o) / d);
  };
  limit(origin.x, p.x, b.minX, b.maxX);
  limit(origin.y, p.y, b.minY, b.maxY);
  limit(origin.z, p.z, b.minZ, b.maxZ);
  t = Math.max(0, t);
  p.set(origin.x + (p.x - origin.x) * t, origin.y + (p.y - origin.y) * t, origin.z + (p.z - origin.z) * t);
}

/** Rayon (autour de 0, 0) que la caméra `thirdPerson` ne dépasse pas ; null : aucune limite. */
let radius: number | null = null;
export function setCameraRadius(r: number | null): void { radius = r; }

/** Comme keepInside, pour un cercle horizontal de rayon R centré en (0, 0). */
function keepInRadius(origin: THREE.Vector3, p: THREE.Vector3, R: number): void {
  if (Math.hypot(p.x, p.z) <= R) return;
  // origin + t (p − origin) sur le cercle : t solution de |o + t d|² = R²
  const dx = p.x - origin.x, dz = p.z - origin.z;
  const a = dx * dx + dz * dz, b = 2 * (origin.x * dx + origin.z * dz), c = origin.x ** 2 + origin.z ** 2 - R * R;
  const disc = b * b - 4 * a * c;
  if (a < 1e-9 || disc < 0) return;
  const t = Math.max(0, Math.min(1, (-b + Math.sqrt(disc)) / (2 * a)));
  p.set(origin.x + (p.x - origin.x) * t, origin.y + (p.y - origin.y) * t, origin.z + dz * t);
}

/** Plafond (salle fermée) que la caméra `thirdPerson` ne traverse pas ; null : ciel ouvert. */
let ceiling: number | null = null;
export function setCameraCeiling(y: number | null): void { ceiling = y; }

/** Ramène `p` sous le plafond en glissant le long du segment origin → p (bras de caméra qui se replie). */
function keepUnderCeiling(origin: THREE.Vector3, p: THREE.Vector3, top: number): void {
  if (p.y <= top || p.y - origin.y < 1e-6) return;
  const t = Math.max(0, (top - origin.y) / (p.y - origin.y));
  p.set(origin.x + (p.x - origin.x) * t, top, origin.z + (p.z - origin.z) * t);
}

/** Centre du podium dans l'arène en cours (il ne tombe pas toujours au même endroit). */
const origin = { x: 0, z: 0 };
export function setCameraOrigin(x: number, z: number): void { origin.x = x; origin.z = z; }

/**
 * Caméra `custom` : un mini-jeu la dirige lui-même (survol, plans fixes), en donnant à chaque image
 * où elle doit être. `stiffness` : vitesse à laquelle elle y va (Infinity : exactement, sans lissage).
 */
const custom = { pos: new THREE.Vector3(0, 20, 10), target: new THREE.Vector3(), fov: 50, stiffness: 4 };
export function setCustomCamera(p: THREE.Vector3, t: THREE.Vector3, fov: number, stiffness = 4): void {
  custom.pos.copy(p); custom.target.copy(t); custom.fov = fov; custom.stiffness = stiffness;
}

/** Place la caméra d'un coup (changement de lieu : pas de travelling à travers les murs). */
export function snapCamera(): void { pos.copy(wantPos); target.copy(wantTarget); }

export function updateCamera(mode: CameraMode, t: number, dt: number, player: { position: THREE.Vector3; yaw: number }): void {
  const P = player.position, aspect = camera.aspect;
  let fov = 50;
  const outdoor = mode === 'custom' || mode === 'arena' || mode === 'training' || mode === 'podium' || mode === 'chase' || mode === 'market' || mode === 'thirdPerson' || mode === 'ramp';
  if (mode === 'custom') {
    wantPos.copy(custom.pos); wantTarget.copy(custom.target); fov = custom.fov;
  } else if (mode === 'podium') {
    if (aspect >= 1.1) { wantTarget.set(3, 1.5, 0); wantPos.set(3, 4.2, 9); }
    else { wantTarget.set(1, 0.4, 0); wantPos.set(1, 6.5, 15.5); fov = Math.min(90, 50 / aspect ** 0.5); }
    wantTarget.x += origin.x; wantTarget.z += origin.z; wantPos.x += origin.x; wantPos.z += origin.z;
  } else if (mode === 'market') {
    // toute la place du marché, vue d'en haut, en suivant un peu le joueur
    wantTarget.set(P.x * 0.25, 0, P.z * 0.25 + 1);
    wantPos.set(P.x * 0.25, 22, P.z * 0.25 + 14.5);
    fov = aspect < 1.5 ? Math.min(100, 52 * (1.5 / aspect) ** 0.75) : 52;
  } else if (mode === 'ramp') {
    // face à la rampe, un peu au-dessus : les tonneaux arrivent d'en haut de l'écran
    const y = Math.max(0, P.y);
    wantTarget.set(P.x * 0.72, y + 1.6, P.z - 2.6);
    wantPos.set(P.x * 0.72, y + 8.6, P.z + 10.2);
    fov = aspect < 1.2 ? Math.min(98, 56 * (1.2 / aspect) ** 0.7) : 56;
  } else if (mode === 'chase') {
    // derrière et au-dessus, en regardant loin devant : on voit les virages arriver
    const y = Math.max(-3, P.y);
    wantTarget.set(P.x * 0.55, y, P.z - 3.2);
    wantPos.set(P.x * 0.55, y + 10.5, P.z + 6.2);
    fov = aspect < 1 ? Math.min(95, 55 / aspect ** 0.6) : 55;
  } else if (mode === 'arena') {
    // tout le cimetière doit tenir à l'écran, même en portrait
    wantPos.set(0, 21.5, 13.5); wantTarget.set(0, 0, 1.3);
    fov = aspect < 1.5 ? Math.min(100, 50 * (1.5 / aspect) ** 0.75) : 50;
  } else if (mode === 'training') {
    wantTarget.set(P.x * 0.7, 0.6, P.z * 0.7 + 0.4);
    wantPos.set(P.x * 0.7, 10.5, P.z * 0.7 + 7.8);
    fov = 52;
  } else if (mode === 'menu') {
    const a = t * 0.08;
    wantPos.set(Math.sin(a) * 8, 5.2, Math.cos(a) * 5.5 + 1); wantTarget.set(0, 1.8, -1);
  } else if (mode === 'bar') {
    wantPos.set(0.4, 4.3, -7.5); wantTarget.set(0, 1.3, -2.6);
    fov = aspect < 1 ? Math.min(100, (52 / aspect) * 0.8) : 52;
  } else if (mode === 'suspects') {
    wantPos.set(0, 4.5, -7); wantTarget.set(0, 1.2, -2.9);
    fov = aspect < 1 ? Math.min(105, (66 / aspect) * 0.8) : 66;
  } else if (mode === 'barman') {
    wantPos.set(0, 5.9, 0.6); wantTarget.set(0, 2.2, -5.85);
    fov = aspect < 1 ? Math.min(95, (50 / aspect) * 0.85) : 50;
  } else if (mode === 'tailor') {
    const y = player.yaw, side = aspect < 1 ? 0 : 1.1;
    wantTarget.set(P.x + Math.cos(y) * side, P.y + (aspect < 1 ? 0.4 : 1.5), P.z - Math.sin(y) * side);
    wantPos.set(P.x + Math.sin(y) * 4.4 + Math.cos(y) * side, P.y + 2.4, P.z + Math.cos(y) * 4.4 - Math.sin(y) * side);
    keepInside(wantTarget, wantPos);
  } else if (mode === 'thirdPerson') {
    const h = Math.sin(look.pitch) * FOLLOW_DISTANCE, hd = Math.cos(look.pitch) * FOLLOW_DISTANCE;
    wantTarget.set(P.x, P.y + 1.9, P.z);
    wantPos.set(P.x + Math.sin(look.yaw) * hd, P.y + 1.6 + h, P.z + Math.cos(look.yaw) * hd);
    if (radius !== null) keepInRadius(wantTarget, wantPos, radius);
    if (ceiling !== null) keepUnderCeiling(wantTarget, wantPos, ceiling);
    fov = aspect < 1 ? 62 : 50;
  } else {
    const h = Math.sin(look.pitch) * FOLLOW_DISTANCE, hd = Math.cos(look.pitch) * FOLLOW_DISTANCE;
    wantTarget.set(P.x, P.y + 1.9, P.z);
    wantPos.set(P.x + Math.sin(look.yaw) * hd, P.y + 1.6 + h, P.z + Math.cos(look.yaw) * hd);
    keepInside(wantTarget, wantPos);
    fov = aspect < 1 ? 62 : 50;
  }
  const k = mode === 'custom' ? (custom.stiffness === Infinity ? 1 : 1 - Math.exp(-custom.stiffness * dt))
    : 1 - Math.exp(-(mode === 'follow' || mode === 'thirdPerson' ? 10 : 4) * dt);
  pos.lerp(wantPos, k); target.lerp(wantTarget, k);
  if (!outdoor) keepInside(target, pos); // le lissage ne doit pas non plus faire sortir la caméra
  else if (mode === 'thirdPerson') {
    if (radius !== null) keepInRadius(target, pos, radius);
    if (ceiling !== null) keepUnderCeiling(target, pos, ceiling);
  }
  camera.position.copy(pos);
  camera.lookAt(target);
  if (Math.abs(camera.fov - fov) > 0.1) { camera.fov = mode === 'custom' && k === 1 ? fov : damp(camera.fov, fov, 4, dt); camera.updateProjectionMatrix(); }
}
