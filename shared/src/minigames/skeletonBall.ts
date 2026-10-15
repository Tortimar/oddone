import { pushOut, type Box, type Bounds, type Circle, type Point } from '../geometry.ts';

/**
 * « Le Bal des Squelettes » : règles et terrain, partagés client/serveur.
 *
 * Les joueurs sont lâchés au milieu d'un cimetière. Des squelettes sortent des tombes
 * (1, puis 2, puis 3…) et chassent les joueurs ; ils sont plus lents qu'eux. Un joueur touché
 * devient « maudit » et chasse à son tour (plus lentement). Le dernier encore libre gagne.
 * Imposteur : les squelettes le délaissent. Ils choisissent toujours une autre proie,
 * sauf si l'imposteur est beaucoup plus près qu'elle (ou seul encore libre).
 * Un contact reste un contact : s'il fonce dans un squelette, il est touché.
 */

export const SKELETON_BALL = {
  id: 'bal-squelettes',
  /** Zone jouable (clôture du cimetière). */
  bounds: { halfX: 12, halfZ: 9 } as Bounds,
  /** Rayon d'un personnage (collisions). */
  radius: 0.5,
  playerSpeed: 6.2,
  /** Vitesse d'un joueur maudit, relative à un joueur libre. */
  cursedSpeedMul: 0.6,
  /**
   * Vitesse des squelettes : de min à max en `speedRampMs`. Bien plus lents que les joueurs :
   * une démarche de zombie (les maudits aussi traînent la patte).
   */
  skeletonSpeed: { min: 3, max: 4.2 },
  speedRampMs: 75_000,
  /** Distance de contact (pieds à pieds) qui compte comme « touché ». */
  tagRadius: 0.95,
  firstSpawnMs: 1500,
  /** Un squelette de plus toutes les `spawnEveryMs` : 1, puis 2, puis 3… */
  spawnEveryMs: 6000,
  /** Temps pour sortir de terre (immobile et inoffensif pendant ce temps). */
  riseMs: 1500,
  maxSkeletons: 10,
  /** Un joueur qui vient d'être touché reste sonné (ne bouge ni ne touche personne). */
  curseStunMs: 1200,
  maxDurationMs: 120_000,
  /**
   * Avantage de l'imposteur : pour choisir leur proie, les squelettes voient l'imposteur
   * `imposterDistanceMul` fois plus loin qu'il n'est vraiment.
   */
  imposterDistanceMul: 2.6,
} as const;

export type GraveKind = 'grave_A' | 'grave_B' | 'grave_A_destroyed' | 'gravestone' | 'gravemarker_A' | 'gravemarker_B' | 'coffin';

/** Une tombe : modèle du kit halloween, position, rotation (multiple de 90°), demi-emprise au sol. */
export interface Grave { kind: GraveKind; x: number; z: number; rot: number; hx: number; hz: number }
export interface SkeletonArena { graves: Grave[] }

/** Demi-emprise au sol de chaque modèle, avant rotation (d'après les dimensions du kit). */
const FOOTPRINT: Record<GraveKind, [number, number]> = {
  grave_A: [1, 0.5], grave_B: [1, 0.5], grave_A_destroyed: [1.04, 0.57],
  gravestone: [0.7, 0.2], gravemarker_A: [0.42, 0.15], gravemarker_B: [0.42, 0.2], coffin: [1, 1.5],
};
const KINDS: GraveKind[] = ['grave_A', 'grave_B', 'grave_A', 'grave_B', 'grave_A_destroyed', 'gravestone', 'gravestone', 'gravemarker_A', 'gravemarker_B', 'coffin'];

/** Places de départ (par place J1..J4), autour du centre du cimetière, laissé libre. */
export const SB_STARTS: readonly [number, number][] = [[-1.8, -1.2], [1.8, -1.2], [-1.8, 1.6], [1.8, 1.6]];

/** Génère un cimetière : tombes sur une grille irrégulière, centre dégagé pour le départ. */
export function makeSkeletonArena(random: () => number): SkeletonArena {
  const graves: Grave[] = [];
  const cols = 6, rows = 4, spanX = 10.4, spanZ = 7.4;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = -spanX + ((i + 0.5) * 2 * spanX) / cols + (random() - 0.5) * 1.1;
      const z = -spanZ + ((j + 0.5) * 2 * spanZ) / rows + (random() - 0.5) * 1.0;
      if (Math.hypot(x, z - 0.2) < 4.2) continue; // centre libre (départ, puis podium)
      if (random() < 0.12) continue; // quelques trous pour varier
      const kind = KINDS[Math.floor(random() * KINDS.length)];
      const quarter = Math.floor(random() * 4);
      const [fx, fz] = FOOTPRINT[kind];
      const turned = quarter % 2 === 1;
      graves.push({ kind, x: round(x), z: round(z), rot: (quarter * Math.PI) / 2, hx: turned ? fz : fx, hz: turned ? fx : fz });
    }
  }
  return { graves };
}

export const graveBox = (g: Grave): Box => ({ x0: g.x - g.hx, x1: g.x + g.hx, z0: g.z - g.hz, z1: g.z + g.hz });
export const arenaBoxes = (a: SkeletonArena): Box[] => a.graves.map(graveBox);

/** Point de sortie d'un squelette : devant la tombe (côté +z local du modèle). */
export function graveExit(g: Grave): Point {
  const d = Math.max(g.hx, g.hz) + 0.9;
  return { x: g.x + Math.sin(g.rot) * d, z: g.z + Math.cos(g.rot) * d };
}

/** Vitesse des squelettes après `elapsedMs` de partie. */
export function skeletonSpeed(elapsedMs: number): number {
  const k = Math.min(1, Math.max(0, elapsedMs / SKELETON_BALL.speedRampMs));
  return SKELETON_BALL.skeletonSpeed.min + (SKELETON_BALL.skeletonSpeed.max - SKELETON_BALL.skeletonSpeed.min) * k;
}

/** Nombre de squelettes sortis (ou en train de sortir) après `elapsedMs`. */
export function skeletonCount(elapsedMs: number): number {
  if (elapsedMs < SKELETON_BALL.firstSpawnMs) return 0;
  return Math.min(SKELETON_BALL.maxSkeletons, 1 + Math.floor((elapsedMs - SKELETON_BALL.firstSpawnMs) / SKELETON_BALL.spawnEveryMs));
}

const ANGLES = [0, 0.6, -0.6, 1.2, -1.2, 1.75, -1.75];
const probe = { x: 0, z: 0 };

/**
 * Avance `p` vers `dir` (angle, radians, 0 = +z) d'au plus `step`, en contournant les tombes :
 * si le chemin direct est bouché, on essaie des directions de plus en plus écartées.
 * Renvoie l'angle réellement pris.
 */
export function steer(p: Point, dir: number, step: number, bounds: Bounds, boxes: readonly Box[], circles: readonly Circle[], r: number): number {
  let best = dir, bestGain = -Infinity, bestX = p.x, bestZ = p.z;
  const wantX = Math.sin(dir), wantZ = Math.cos(dir);
  for (const a of ANGLES) {
    const ang = dir + a;
    probe.x = p.x + Math.sin(ang) * step; probe.z = p.z + Math.cos(ang) * step;
    pushOut(probe, bounds, boxes, circles, r);
    const gain = (probe.x - p.x) * wantX + (probe.z - p.z) * wantZ; // progrès dans la direction voulue
    if (gain > bestGain + 1e-6) { bestGain = gain; best = ang; bestX = probe.x; bestZ = probe.z; }
    if (gain > step * 0.7) break; // assez bon : inutile de chercher plus loin
  }
  p.x = bestX; p.z = bestZ;
  return best;
}

/** Temps de survie affiché « 0:42,10 ». */
export function formatSurvival(ms: number): string {
  const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, '0').replace('.', ',')}`;
}

const round = (n: number) => Math.round(n * 100) / 100;
