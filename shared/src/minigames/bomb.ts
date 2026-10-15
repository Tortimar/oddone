import type { Box } from '../geometry.ts';

/**
 * « La Bombe du Labyrinthe » : la patate chaude, dans un labyrinthe de donjon tiré au hasard.
 * Un joueur part avec la bombe ; en touchant quelqu'un, il la lui passe (celui-ci est étourdi un
 * instant). La mèche a sa propre durée, secrète : quand elle arrive au bout, celui qui tient la
 * bombe est éliminé. Autant de manches qu'il faut pour qu'il ne reste qu'un survivant (3 au plus).
 * L'imposteur voit les autres joueurs à travers les murs.
 * Partagé client/serveur : le labyrinthe (cases, murs, distances), les constantes, l'état public.
 */

export const BOMB = {
  id: 'bombe-labyrinthe',
  /** Labyrinthe de cols × rows cases de `cell` de côté (un mur du kit dungeon fait 4 × 4). */
  cols: 8,
  rows: 8,
  cell: 4,
  /** Murs ×1,5 : 6 de haut, le plafond pose dessus (de quoi placer la caméra au-dessus des épaules). */
  wallScale: 1.5,
  /** Part des murs intérieurs restants qu'on abat pour faire des boucles (on peut fuir en rond). */
  loops: 0.2,
  /** Manches au plus (il en faut une de moins que de joueurs). */
  maxRounds: 3,
  /** Début de manche : chacun dans son coin, on découvre qui a la bombe. */
  introMs: 3000,
  /** Durée de la mèche, tirée à chaque manche (secrète). */
  fuseMs: [18_000, 30_000] as const,
  /** La bombe clignote (et le dit à tout le monde) dans ses dernières secondes. */
  criticalMs: 5000,
  /** Après l'explosion, avant la manche suivante. */
  boomMs: 3500,
  /** Distance (centre à centre) à laquelle on passe la bombe. */
  passRadius: 1.15,
  /** Celui qui reçoit la bombe est étourdi… */
  stunMs: 1000,
  /** …et ne peut pas la repasser tout de suite. */
  passCooldownMs: 1600,
  /** Vitesse des bots (un humain court à 6,2). */
  botSpeed: { holder: 5.5, runner: 5.1 },
  /** Un bot qui n'est pas l'imposteur ne fuit la bombe que s'il l'« entend » (en cases de chemin). */
  hearCells: 4,
  /** Le podium tombe dans la salle du centre. */
  podium: [0, 0] as [number, number],
} as const;

export const BOMB_MAX_MS = BOMB.maxRounds * (BOMB.introMs + BOMB.fuseMs[1] + BOMB.boomMs) + 5000;

/**
 * Le labyrinthe. `h[r * cols + c]` : mur horizontal au nord de la case (c, r), pour r de 0 à rows
 * (r = rows : le bord sud). `v[r * (cols + 1) + c]` : mur vertical à l'ouest de (c, r), pour c de
 * 0 à cols (c = cols : le bord est). 1 = mur, 0 = passage. Les cases vont de −x à +x, de −z à +z.
 */
export interface Maze { cols: number; rows: number; h: number[]; v: number[] }

export type MazeCell = [number, number];

/** Les 4 coins, où l'on apparaît (un par joueur, selon la place J1..J4). */
export const BOMB_CORNERS: readonly MazeCell[] = [[0, 0], [BOMB.cols - 1, BOMB.rows - 1], [BOMB.cols - 1, 0], [0, BOMB.rows - 1]];

export function mazeCellCenter(c: number, r: number): [number, number] {
  return [(c - BOMB.cols / 2 + 0.5) * BOMB.cell, (r - BOMB.rows / 2 + 0.5) * BOMB.cell];
}

/** Case qui contient (x, z), bornée au labyrinthe. */
export function mazeCellAt(x: number, z: number): MazeCell {
  const c = Math.floor(x / BOMB.cell + BOMB.cols / 2), r = Math.floor(z / BOMB.cell + BOMB.rows / 2);
  return [Math.max(0, Math.min(BOMB.cols - 1, c)), Math.max(0, Math.min(BOMB.rows - 1, r))];
}

/** Places de départ de la 1re manche (un coin par place J1..J4). */
export const BOMB_STARTS: readonly [number, number][] = BOMB_CORNERS.map(([c, r]) => mazeCellCenter(c, r));

const DIRS: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Peut-on aller de (c, r) à la case voisine (c + dc, r + dr) ? */
export function mazeCanGo(m: Maze, c: number, r: number, dc: number, dr: number): boolean {
  const nc = c + dc, nr = r + dr;
  if (nc < 0 || nr < 0 || nc >= m.cols || nr >= m.rows) return false;
  if (dc === 1) return !m.v[r * (m.cols + 1) + c + 1];
  if (dc === -1) return !m.v[r * (m.cols + 1) + c];
  if (dr === 1) return !m.h[(r + 1) * m.cols + c];
  return !m.h[r * m.cols + c];
}

/** Cases voisines accessibles. */
export function mazeNeighbors(m: Maze, c: number, r: number): MazeCell[] {
  return DIRS.filter(([dc, dr]) => mazeCanGo(m, c, r, dc, dr)).map(([dc, dr]) => [c + dc, r + dr]);
}

/** Distance (en cases de chemin) de `from` à toutes les cases ; −1 si inaccessible. */
export function mazeDistances(m: Maze, from: MazeCell): number[] {
  const d = new Array<number>(m.cols * m.rows).fill(-1);
  d[from[1] * m.cols + from[0]] = 0;
  const queue: MazeCell[] = [from];
  for (let q = 0; q < queue.length; q++) {
    const [c, r] = queue[q];
    for (const [nc, nr] of mazeNeighbors(m, c, r)) {
      const k = nr * m.cols + nc;
      if (d[k] >= 0) continue;
      d[k] = d[r * m.cols + c] + 1;
      queue.push([nc, nr]);
    }
  }
  return d;
}

/**
 * Tire un labyrinthe : parcours en profondeur (tout est relié), salle de 2 × 2 cases au centre,
 * puis on abat une partie des murs restants pour faire des boucles.
 */
export function makeMaze(random: () => number): Maze {
  const { cols, rows } = BOMB;
  const m: Maze = { cols, rows, h: new Array<number>(cols * (rows + 1)).fill(1), v: new Array<number>(rows * (cols + 1)).fill(1) };
  const open = (c: number, r: number, dc: number, dr: number) => {
    if (dc === 1) m.v[r * (cols + 1) + c + 1] = 0;
    else if (dc === -1) m.v[r * (cols + 1) + c] = 0;
    else if (dr === 1) m.h[(r + 1) * cols + c] = 0;
    else m.h[r * cols + c] = 0;
  };
  const seen = new Set<number>();
  const stack: MazeCell[] = [[Math.floor(random() * cols), Math.floor(random() * rows)]];
  seen.add(stack[0][1] * cols + stack[0][0]);
  while (stack.length) {
    const [c, r] = stack[stack.length - 1];
    const next = DIRS.filter(([dc, dr]) => {
      const nc = c + dc, nr = r + dr;
      return nc >= 0 && nr >= 0 && nc < cols && nr < rows && !seen.has(nr * cols + nc);
    });
    if (!next.length) { stack.pop(); continue; }
    const [dc, dr] = next[Math.floor(random() * next.length)];
    open(c, r, dc, dr);
    seen.add((r + dr) * cols + c + dc);
    stack.push([c + dc, r + dr]);
  }
  // la salle du centre (le podium y tombe)
  const c0 = cols / 2 - 1, r0 = rows / 2 - 1;
  open(c0, r0, 1, 0); open(c0, r0 + 1, 1, 0); open(c0, r0, 0, 1); open(c0 + 1, r0, 0, 1);
  // des boucles : on abat une partie des murs intérieurs restants
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (c < cols - 1 && m.v[r * (cols + 1) + c + 1] && random() < BOMB.loops) open(c, r, 1, 0);
    if (r < rows - 1 && m.h[(r + 1) * cols + c] && random() < BOMB.loops) open(c, r, 0, 1);
  }
  return m;
}

/** Les murs (segments) du labyrinthe : centre, longueur le long de x (`along`) ou de z. */
export interface MazeWall { x: number; z: number; alongX: boolean }

export function mazeWalls(m: Maze): MazeWall[] {
  const out: MazeWall[] = [];
  for (let r = 0; r <= m.rows; r++) for (let c = 0; c < m.cols; c++) {
    if (!m.h[r * m.cols + c]) continue;
    const [x] = mazeCellCenter(c, 0);
    out.push({ x, z: (r - m.rows / 2) * BOMB.cell, alongX: true });
  }
  for (let r = 0; r < m.rows; r++) for (let c = 0; c <= m.cols; c++) {
    if (!m.v[r * (m.cols + 1) + c]) continue;
    const [, z] = mazeCellCenter(0, r);
    out.push({ x: (c - m.cols / 2) * BOMB.cell, z, alongX: false });
  }
  return out;
}

/** Boîtes de collision des murs (épaisseur 1 : un mur du kit). */
export function mazeBoxes(m: Maze): Box[] {
  const half = BOMB.cell / 2 + 0.5, t = 0.5;
  return mazeWalls(m).map((w) => w.alongX
    ? { x0: w.x - half, x1: w.x + half, z0: w.z - t, z1: w.z + t }
    : { x0: w.x - t, x1: w.x + t, z0: w.z - half, z1: w.z + half });
}

/** Demi-côté du labyrinthe (jusqu'à l'intérieur des murs du bord). */
export const BOMB_HALF = (BOMB.cols * BOMB.cell) / 2;

export type BombStage = 'intro' | 'play' | 'boom' | 'done';

/** État public de « La Bombe du Labyrinthe » (la durée de la mèche reste secrète). */
export interface BombState {
  round: number;
  rounds: number;
  stage: BombStage;
  /** Début de l'étape (ms depuis le début de la partie). */
  stageAt: number;
  /** Qui tient la bombe. */
  holder: string | null;
  /** Dernier passage de la bombe (ms de jeu). */
  pass: { from: string; to: string; at: number } | null;
  /** Étourdi jusqu'à… (ms de jeu). */
  stunned: Record<string, number>;
  /** La bombe va sauter (dernières secondes) : elle clignote chez tout le monde. */
  critical: boolean;
  alive: string[];
  /** Éliminés, dans l'ordre. */
  out: string[];
  /** Manche où chacun a sauté. */
  outRound: Record<string, number>;
  /** Où chacun apparaît au début de la manche en cours. */
  spawns: Record<string, [number, number]>;
  /** Dernière explosion. */
  boom: { id: string; at: number; x: number; z: number } | null;
}
