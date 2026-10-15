import type { Box, Point } from '../geometry.ts';

/**
 * « Le Regard de la Gorgone » : un « 1, 2, 3, soleil » dans un cimetière.
 * Les joueurs partent au sud d'une longue allée ; la Gorgone géante trône au nord, de dos. Elle se
 * retourne au hasard (après 1 à 5 secondes de dos) : qui bouge pendant qu'elle regarde est pétrifié
 * (sauf s'il est caché derrière une tombe, une statue ou un autre joueur). On peut pousser les autres.
 * Les premiers à franchir la ligne d'arrivée gagnent ; le premier pétrifié est dernier, et ainsi de suite.
 * L'imposteur sait, lui, quand elle va se retourner.
 * Partagé client/serveur : terrain, couverts, ligne de vue, constantes, état public.
 */

export const GORGON = {
  id: 'regard-gorgone',
  /** Zone jouable (clôture du cimetière). */
  bounds: { halfX: 9, halfZ: 32 },
  /** Ligne de départ (sud) et ligne d'arrivée (aux pieds de la Gorgone). */
  startZ: 29,
  finishZ: -12,
  /** La Gorgone : position (au fond, sur son estrade) et hauteur de ses yeux. */
  gorgonZ: -18,
  eyeY: 7.5,
  /** De dos (on peut avancer) : durée tirée entre ces bornes. */
  backMs: [1000, 5000] as const,
  /** Elle se retourne… */
  turnMs: 300,
  /** …puis, une fois tournée, un court délai (réaction, réseau) avant de juger qui bouge. */
  graceMs: 250,
  /** Elle regarde : durée tirée entre ces bornes. */
  watchMs: [1800, 3200] as const,
  /** Distance qu'on peut parcourir sans être vu bouger (pendant le regard). */
  moveTolerance: 0.3,
  /** On n'est caché que par un couvert à moins de ça, devant soi (sur la ligne de son regard). */
  hideDist: 2.5,
  /** Rayon d'un joueur (couverture, ligne de vue). */
  playerR: 0.45,
  /** Pousser les autres (E). */
  push: { cooldownMs: 2500, reach: 1.6 },
  /** On avance moins vite qu'ailleurs (vitesse ×0,7 : 4,3) : la Gorgone a le temps de se retourner. */
  playerSpeedMul: 0.7,
  /** Bots : vitesse (un humain avance à 4,3), temps de réaction quand elle se retourne (à temps)… */
  botSpeed: 3.6,
  botReactMs: [150, 650] as const,
  /** …ou, de temps en temps, trop tard (pétrifié s'il est en vue). */
  botLateChance: 0.07,
  botLateMs: [850, 1300] as const,
  /** Durée maximale de la partie. */
  maxMs: 90_000,
  /** Les tombes occupent cette bande (le départ et l'arrivée restent dégagés). */
  graveZ: [-5.5, 25] as const,
  /** Le podium tombe entre les tombes et la ligne d'arrivée. */
  podium: [0, -8.6] as [number, number],
} as const;

/** Places de départ, sur la ligne (par place J1..J4). */
export const GORGON_STARTS: readonly [number, number][] = [-4.5, -1.5, 1.5, 4.5].map((x) => [x, GORGON.startZ] as [number, number]);

export type GorgonGraveKind = 'grave_A' | 'grave_B' | 'grave_A_destroyed' | 'gravestone';
/** Un couvert : tombe (modèle du kit halloween, ×`GRAVE_SCALE`) ou statue de héros. Emprise au sol en demi-côtés. */
export interface GorgonCover { kind: GorgonGraveKind | 'statue'; x: number; z: number; rot: number; hx: number; hz: number; seed: number }
export interface GorgonField { covers: GorgonCover[] }

/** Les tombes sont agrandies : à peu près la taille d'un héros (on peut se cacher derrière). */
export const GRAVE_SCALE = 1.25;
const FOOT: Record<GorgonGraveKind, [number, number]> = {
  grave_A: [1, 0.5], grave_B: [1, 0.5], grave_A_destroyed: [1.04, 0.57], gravestone: [0.7, 0.2],
};
const KINDS: GorgonGraveKind[] = ['grave_A', 'grave_B', 'grave_A', 'grave_B', 'grave_A_destroyed', 'gravestone'];
const round = (n: number) => Math.round(n * 100) / 100;
/** Passage minimal entre deux couverts voisins. */
const MIN_GAP = 1.5;

/**
 * Tire le terrain : des rangées de tombes en quinconce (larges côté Gorgone : on se cache derrière),
 * avec des trous pour passer, et quelques statues de héros pétrifiés plus tôt.
 */
export function makeGorgonField(random: () => number): GorgonField {
  const covers: GorgonCover[] = [];
  const [z0, z1] = GORGON.graveZ, rows = 6, cols = 3, half = GORGON.bounds.halfX - 1.4;
  for (let j = 0; j < rows; j++) {
    const z = z1 - ((j + 0.5) * (z1 - z0)) / rows;
    for (let i = 0; i < cols; i++) {
      if (random() < 0.3) continue; // des trous pour passer
      const x = -half + ((i + 0.5 + (j % 2 ? 0.5 : 0)) * 2 * half) / (cols + 0.5) + (random() - 0.5) * 1.2;
      const zz = z + (random() - 0.5) * 1.1;
      const seed = Math.floor(random() * 1e6);
      const statue = random() < 0.18, kind = KINDS[Math.floor(random() * KINDS.length)];
      const [fx, fz] = statue ? [0.5, 0.5] : FOOT[kind].map((v) => v * GRAVE_SCALE);
      // jamais de passage trop étroit entre deux couverts (on resterait coincé)
      if (covers.some((c) => Math.abs(c.z - zz) < c.hz + fz + 1.5 && Math.abs(c.x - x) < c.hx + fx + MIN_GAP)) continue;
      if (statue) { covers.push({ kind: 'statue', x: round(x), z: round(zz), rot: round((random() - 0.5) * 0.8), hx: 0.5, hz: 0.5, seed }); continue; }
      // (côté large vers la Gorgone : rotation 0 ou demi-tour)
      covers.push({ kind, x: round(x), z: round(zz), rot: random() < 0.5 ? 0 : Math.PI, hx: fx, hz: fz, seed });
    }
  }
  return { covers };
}

export const coverBox = (c: GorgonCover): Box => ({ x0: c.x - c.hx, x1: c.x + c.hx, z0: c.z - c.hz, z1: c.z + c.hz });

/** Le segment (ax, az) → (bx, bz) traverse-t-il la boîte (agrandie de `pad`) ? (test des « dalles ») */
function segmentHitsBox(ax: number, az: number, bx: number, bz: number, b: Box, pad: number): boolean {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  for (const [p, d, lo, hi] of [[ax, dx, b.x0 - pad, b.x1 + pad], [az, dz, b.z0 - pad, b.z1 + pad]] as const) {
    if (Math.abs(d) < 1e-9) { if (p < lo || p > hi) return false; continue; }
    let u0 = (lo - p) / d, u1 = (hi - p) / d;
    if (u0 > u1) [u0, u1] = [u1, u0];
    t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * La Gorgone voit-elle ce joueur ? Non s'il y a, juste devant lui (à moins de « hideDist », sur la ligne
 * qui le relie à ses yeux, à plat), une tombe, une statue ou un autre joueur (pétrifié ou non).
 */
export function gorgonSees(target: Point, covers: readonly GorgonCover[], others: readonly Point[]): boolean {
  const gx = 0, gz = GORGON.gorgonZ;
  const dx = target.x - gx, dz = target.z - gz, len = Math.hypot(dx, dz) || 1, len2 = len * len;
  // seul ce qui est tout près, devant soi, cache : il faut se coller derrière (une tombe au loin ne suffit pas)
  const k = Math.min(1, GORGON.hideDist / len), ax = target.x - dx * k, az = target.z - dz * k;
  for (const c of covers) if (segmentHitsBox(ax, az, target.x, target.z, coverBox(c), -0.05)) return false;
  for (const o of others) {
    // projection de l'autre sur le segment : il doit être devant (entre elle et nous), et tout près
    const t = ((o.x - gx) * dx + (o.z - gz) * dz) / len2;
    if (t <= 1 - k || t >= 1) continue;
    const px = gx + dx * t, pz = gz + dz * t;
    if (Math.hypot(o.x - px, o.z - pz) < GORGON.playerR * 1.6) return false;
  }
  return true;
}

export type GorgonStage = 'back' | 'turning' | 'watch';

/** État public du « Regard de la Gorgone ». */
export interface GorgonState {
  stage: GorgonStage;
  /** Début de l'étape (ms depuis le début de la partie). */
  stageAt: number;
  /** Arrivés, dans l'ordre. */
  finished: string[];
  /** Pétrifiés, dans l'ordre. */
  petrified: string[];
  /** Où et comment chacun a été pétrifié : [x, z, angle]. */
  stone: Record<string, [number, number, number]>;
}

/** Ce que sait l'imposteur : quand elle commencera à se retourner (ms de jeu). */
export interface GorgonSecret { turnAt: number }
