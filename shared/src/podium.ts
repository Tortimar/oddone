/**
 * Podium des résultats d'un mini-jeu : il tombe au milieu de l'arène, les joueurs y sont
 * téléportés selon leur place, puis peuvent bouger et se donner des coups quelques secondes.
 * Partagé : le client le dessine et marche dessus, le serveur y place les bots.
 */

export interface PodiumStep { x: number; z: number; w: number; d: number; h: number; rank: number }

/** Marches : 1re au centre (la plus haute), 2e à gauche, 3e à droite. */
export const PODIUM_STEPS: readonly PodiumStep[] = [
  { rank: 1, x: 0, z: 0, w: 2, d: 2, h: 1.4 },
  { rank: 2, x: -2, z: 0, w: 2, d: 2, h: 1 },
  { rank: 3, x: 2, z: 0, w: 2, d: 2, h: 0.6 },
];

/** Emplacement [x, z, hauteur] du joueur classé à l'indice i du classement (le 4e reste au pied du podium). */
export const PODIUM_SPOTS: readonly [number, number, number][] = [[0, 0, 1.4], [-2, 0, 1], [2, 0, 0.6], [4.1, 0.6, 0]];

/** Hauteur du sol en (x, z) : dessus d'une marche ou 0. */
export function podiumGround(x: number, z: number): number {
  let h = 0;
  for (const s of PODIUM_STEPS) if (Math.abs(x - s.x) <= s.w / 2 && Math.abs(z - s.z) <= s.d / 2) h = Math.max(h, s.h);
  return h;
}

/** Coups sur le podium. */
export const BRAWL = {
  /** Portée d'un coup (du centre au centre) et tolérance en hauteur. */
  reach: 1.8,
  reachY: 1.3,
  /** Temps minimum entre deux coups d'un même joueur (ms). */
  cooldownMs: 420,
  /** Vitesse de recul donnée au joueur frappé (le coup de pied pousse plus fort et plus haut). */
  punch: { push: 7, lift: 4.5 },
  kick: { push: 10, lift: 6.5 },
} as const;
