/**
 * « Les Coffres Piégés » : une salle de donjon, des coffres au milieu, un de plus que de joueurs
 * encore en lice. Chacun son tour, on en ouvre un : un seul est une mimique, qui élimine celui
 * qui l'ouvre et relance une manche avec un coffre de moins. Le dernier debout gagne.
 * À son tour, on peut aussi « inspecter » un coffre : tout le monde le fait pour faire semblant,
 * mais seul l'imposteur apprend ce qu'il contient, et une seule fois dans la partie.
 * Partagé client/serveur.
 */

export const CHESTS = {
  id: 'coffres-pieges',
  /** Temps pour jouer son tour (après : le donjon ouvre un coffre au hasard pour toi). */
  turnMs: 15_000,
  /** Inspecter un coffre (le joueur est penché dessus, tout le monde le voit). */
  inspectMs: 1_600,
  /** Ouverture : le couvercle grince (suspense), puis le contenu. */
  openMs: 2_600,
  /** …dont le suspense : le contenu apparaît à ce moment-là. */
  revealMs: 1_300,
  /** Après une ouverture sans danger, avant le tour suivant. */
  safeMs: 1_100,
  /** La mimique a mordu : le temps de la voir faire. */
  outMs: 3_000,
  /** Début de manche : les coffres sortent du sol. */
  introMs: 2_400,
  /** Distance (au centre du coffre) pour l'ouvrir ou l'inspecter. */
  reach: 2.3,
  /** Les coffres sont en cercle autour du centre de la salle. */
  ringRadius: 3.4,
  /** Rayon de collision d'un coffre. */
  chestRadius: 0.85,
  /** Les joueurs attendent leur tour dans les coins (rayon). */
  homeRadius: 7,
  /** Demi-largeur de la salle (intérieur des murs). */
  roomHalf: 11.3,
  botSpeed: 3.6,
  /** Le podium tombe au milieu de la salle (les coffres ont disparu). */
  podium: [0, 0] as [number, number],
} as const;

/** Places d'attente (et de départ), dans les quatre coins de la salle. */
export const CHEST_HOMES: readonly [number, number][] = [45, 135, 225, 315].map((deg) => {
  const a = (deg * Math.PI) / 180;
  return [Math.round(Math.sin(a) * CHESTS.homeRadius * 100) / 100, Math.round(Math.cos(a) * CHESTS.homeRadius * 100) / 100] as [number, number];
});

/** Position et orientation (face vers l'extérieur) du coffre i sur `count`. */
export function chestSpot(i: number, count: number): [number, number, number] {
  const a = (i / count) * Math.PI * 2 + Math.PI / count;
  return [Math.sin(a) * CHESTS.ringRadius, Math.cos(a) * CHESTS.ringRadius, a];
}

/** Où se tenir pour ouvrir le coffre i (devant lui, côté extérieur). */
export function chestFront(i: number, count: number, dist = 1.45): [number, number] {
  const [x, z, a] = chestSpot(i, count);
  return [x + Math.sin(a) * dist, z + Math.cos(a) * dist];
}

/** Coffre fermé le plus proche de (x, z), à portée ; -1 sinon. */
export function nearestChest(x: number, z: number, count: number, opened: readonly number[], reach: number = CHESTS.reach): number {
  let best = -1, bestD = reach;
  for (let i = 0; i < count; i++) {
    if (opened.includes(i)) continue;
    const [cx, cz] = chestSpot(i, count), d = Math.hypot(cx - x, cz - z);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export type ChestStage = 'intro' | 'turn' | 'opening' | 'out' | 'done';

/** État public de la partie (la mimique reste secrète jusqu'à ce qu'on l'ouvre). */
export interface ChestsState {
  /** Manche (0, 1, 2…). */
  round: number;
  /** Nombre de coffres de la manche (joueurs en lice + 1). */
  count: number;
  /** Joueurs en lice, dans l'ordre de jeu. */
  alive: string[];
  /** Éliminés, dans l'ordre. */
  out: string[];
  /** Manche où chacun a été éliminé. */
  outRound: Record<string, number>;
  /** À qui de jouer. */
  turn: string | null;
  stage: ChestStage;
  /** Début et fin de l'étape en cours (ms depuis le début de la partie). */
  stageAt: number;
  stageEndsAt: number;
  /** Coffres ouverts sans danger cette manche. */
  opened: number[];
  /** Coffre en train d'être ouvert (et ce qu'il contient : on l'apprend tous ensemble). */
  opening: { by: string; chest: number; mimic: boolean } | null;
  /** Quelqu'un inspecte un coffre (vrai ou faux : personne ne le sait). */
  inspecting: { by: string; chest: number; at: number } | null;
}

/** Résultat d'une inspection, envoyé au seul imposteur. */
export interface ChestSecret { round: number; chest: number; mimic: boolean }
