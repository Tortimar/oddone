/**
 * « Le Festival des Bombes » : chaque joueur a son plateau (les quatre en 2 × 2, reliés par la
 * machine au centre, tout le monde voit tout). La machine lui envoie des bombes des couleurs des
 * joueurs, de plus en plus vite ; il faut les trier à la souris (cliquer, glisser, lâcher) dans la
 * boîte de leur couleur. Une bombe pas triée 3 secondes après son arrivée explose : le joueur a perdu.
 * Une boîte pleine (5 bombes) les envoie au joueur de cette couleur (les siennes : un peu partout).
 * Imposteur : les bombes de sa couleur vont dans n'importe quelle boîte (elles en prennent la couleur).
 * Partagé client/serveur : plateaux, boîtes, cadence, état public.
 */

export const FEST = {
  id: 'festival-bombes',
  /** Un plateau : largeur (x) et profondeur (z). */
  boardW: 16,
  boardD: 10.4,
  /** Côté d'une boîte (dans les coins du plateau) et nombre de bombes pour la remplir. */
  box: 3.6,
  capacity: 5,
  /** La mèche : une bombe pas triée ce temps-là après son arrivée explose. */
  fuseMs: 3000,
  /** Vol d'une bombe (de la machine, ou d'une boîte pleine) jusqu'au plateau. */
  flightMs: 650,
  /** Les bombes d'une boîte pleine arrivent une à une. */
  sendGapMs: 380,
  /** Cadence de la machine : une bombe toutes les… (ms), de plus en plus vite. */
  spawn: { startMs: 1700, endMs: 480, rampMs: 90_000 },
  /** Zone où tombent les bombes (demi-côtés, autour du centre du plateau, entre les boîtes). */
  landHX: 3.6,
  landHZ: 3.8,
  /** Bots : temps pour trier une bombe, et part d'erreurs (mauvaise boîte : refusée). */
  botSortMs: [520, 1000] as const,
  botMistake: 0.06,
  maxMs: 120_000,
  /** Le podium tombe sur la machine. */
  podium: [0, 0] as [number, number],
} as const;

/** Centre du plateau de chaque place (J1 en haut à gauche, J2 en haut à droite, J3 et J4 en bas). */
export const FEST_BOARDS: readonly [number, number][] = [[-9.6, -6.3], [9.6, -6.3], [-9.6, 6.3], [9.6, 6.3]];

/** Coin de la boîte de chaque couleur (place 0..3) : en haut à gauche, en haut à droite, en bas… */
const BOX_CORNERS: readonly [number, number][] = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

/** Centre de la boîte de couleur `color` sur le plateau de la place `slot`. */
export function festBox(slot: number, color: number): [number, number] {
  const [cx, cz] = FEST_BOARDS[slot], [sx, sz] = BOX_CORNERS[color];
  return [cx + sx * (FEST.boardW / 2 - FEST.box / 2 - 0.4), cz + sz * (FEST.boardD / 2 - FEST.box / 2 - 0.3)];
}

/** La boîte (couleur) sous le point (x, z) du plateau `slot`, ou −1. */
export function festBoxAt(slot: number, colors: readonly number[], x: number, z: number): number {
  for (const c of colors) {
    const [bx, bz] = festBox(slot, c);
    if (Math.abs(x - bx) <= FEST.box / 2 + 0.2 && Math.abs(z - bz) <= FEST.box / 2 + 0.2) return c;
  }
  return -1;
}

/** Où se tient le héros de chaque place : sur le bord extérieur de son plateau. */
export const FEST_STARTS: readonly [number, number][] = FEST_BOARDS.map(([x, z]) => [x + Math.sign(x) * (FEST.boardW / 2 + 1.4), z] as [number, number]);

/** Une bombe : couleur (place 0..3), arrivée sur le plateau (ms de jeu), où, et d'où elle vient (−1 : la machine). */
export interface FestBomb { id: number; color: number; at: number; x: number; z: number; from: number }
export interface FestBoard {
  bombs: FestBomb[];
  /** Remplissage de chaque boîte (par couleur 0..3). */
  boxes: number[];
  sorted: number;
}

/** État public du Festival des Bombes. */
export interface BombFestState {
  /** Plateau de chaque joueur. */
  boards: Record<string, FestBoard>;
  /** Couleurs en jeu (places des joueurs). */
  colors: number[];
  /** Explosés, dans l'ordre (le dernier debout gagne). */
  out: string[];
  /** Explosions (ms de jeu). */
  booms: { id: string; at: number }[];
  /** Boîtes pleines envoyées : de qui, à qui, quelle couleur, quand. */
  sends: { from: string; to: string; color: number; at: number }[];
}

/** Bombe codée dans l'argument de l'action `sort` : numéro de bombe × 4 + boîte. */
export const festSortArg = (bomb: number, box: number) => bomb * 4 + box;
