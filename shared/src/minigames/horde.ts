/**
 * « La Horde de Gobelins » : une clairière en forêt, des gobelins qui en sortent de partout et
 * foncent sur les joueurs. Un coup d'épée en tue un : 1 point, 3 pour un gobelin doré.
 * On peut aussi frapper les autres joueurs : ils sont étourdis une seconde, comme par un gobelin.
 * Avantage de l'imposteur : les gobelins dorés sortent surtout du côté de la clairière où il se trouve.
 * Partagé client/serveur.
 */

export const HORDE = {
  id: 'horde-gobelins',
  /** Durée de la partie. */
  durationMs: 60_000,
  /** On ne sort pas de la clairière (rayon autour du centre). */
  walkRadius: 13,
  /** Les gobelins sortent des arbres, à ce rayon. */
  spawnRadius: 14.5,
  /** Écart entre deux apparitions : du plus lent au début au plus rapide à la fin. */
  spawnMs: [850, 300] as [number, number],
  maxGoblins: 26,
  goblinSpeed: 3.2,
  goldSpeed: 3.9,
  /** Chance qu'un gobelin soit doré (loin de l'imposteur / de son côté). */
  goldChance: 0.07,
  goldChanceImposter: 0.42,
  /** Part des apparitions du côté de l'imposteur. */
  imposterSideShare: 0.35,
  /** Largeur (radians, de part et d'autre) de « son côté ». */
  imposterSideSpread: 0.75,
  points: { normal: 1, gold: 3 },
  /** Coup d'épée : portée, ouverture (cosinus du demi-angle), rayon « collé » (touché quel que soit l'angle), recharge. */
  slash: { reach: 2.7, cosCone: 0.1, close: 1.1, cooldownMs: 380 },
  /** Touché (par un gobelin ou l'épée d'un joueur) : étourdi, sans bouger ni frapper. */
  stunMs: 1000,
  /** Après un étourdissement, un court répit avant de pouvoir l'être à nouveau. */
  stunGraceMs: 500,
  /** Un gobelin au contact frappe (recul), puis attend un peu. */
  goblinReach: 0.95,
  goblinHitCooldownMs: 1500,
  playerSpeed: 6.2,
  botSpeed: 4.4,
  /** Le podium tombe au milieu de la clairière. */
  podium: [0, 4] as [number, number],
} as const;

/** Places de départ, au centre. */
export const HORDE_STARTS: readonly [number, number][] = [[-1.8, 1.8], [1.8, 1.8], [-1.8, -1.8], [1.8, -1.8]];

/** Un gobelin tué : pour les effets (« +3 », éclats) chez tout le monde. */
export interface HordeKill { at: number; by: string; goblin: number; gold: boolean; x: number; z: number }

/** État public de la partie. */
export interface HordeState {
  points: Record<string, number>;
  /** Gobelins tués par chacun (normaux, dorés). */
  kills: Record<string, [number, number]>;
  /** Derniers gobelins tués (les plus récents à la fin). */
  events: HordeKill[];
}

/** Le gobelin (x, z) est-il touché par un coup d'épée donné depuis (px, pz), tourné vers yaw ? */
export function slashHits(px: number, pz: number, yaw: number, x: number, z: number): boolean {
  const dx = x - px, dz = z - pz, d = Math.hypot(dx, dz);
  if (d > HORDE.slash.reach) return false;
  if (d < HORDE.slash.close) return true; // collé : touché quel que soit l'angle
  return (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / d >= HORDE.slash.cosCone;
}
