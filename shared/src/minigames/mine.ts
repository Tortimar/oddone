/**
 * « Les Wagonnets de la Mine » : 3 manches. À chaque manche, quatre voies ferrées partent du quai
 * (en haut) et serpentent jusqu'à la sortie (en bas) : elles tournent, reviennent en arrière et se
 * croisent, et elles n'ont pas la même longueur. La caméra les survole une seule fois (5 s) ;
 * l'imposteur maudit alors en secret un wagon (il roulera moins vite), puis chacun saute dans un
 * wagon libre et c'est la course, à la même vitesse pour tous… sauf le maudit.
 *
 * Le terrain est une grille de `cols` × `rows` cases (ligne 0 en haut, côté quai, vers −z).
 * Chaque case traversée porte un morceau de voie qui relie deux de ses côtés (N, E, S, O) : tout
 * droit ou en quart de cercle. Deux voies ne se croisent qu'à angle droit, en ligne droite.
 * Partagé client/serveur.
 */

export const MINE = {
  id: 'wagonnets-mine',
  rounds: 3,
  wagons: 4,
  cols: 10,
  rows: 10,
  /** Taille d'une case (un wagon fait un peu plus d'une demi-case). */
  cell: 2.4,
  /** Écartement des rails (de part et d'autre de l'axe). */
  gauge: 0.42,
  /** Début de manche : les wagons arrivent au quai. */
  introMs: 2600,
  /** Survol des voies par la caméra (une seule fois). */
  previewMs: 5600,
  /** …dont le trajet de la caméra, du quai à la sortie. */
  previewMoveMs: 5000,
  /** L'imposteur maudit un wagon (durée fixe : son choix ne se voit pas). */
  curseMs: 6000,
  /** Chacun choisit un wagon (fin anticipée quand tout le monde est monté). */
  pickMs: 9000,
  pickEarlyCloseMs: 900,
  /** Avant le départ, une fois tout le monde à bord. */
  raceLeadMs: 1200,
  /** Après l'arrivée du dernier wagon. */
  raceTailMs: 1800,
  /** Classement de la manche. */
  scoreMs: 3800,
  /** Vitesse des wagons (unités par seconde) ; le maudit roule à `curseMul` de cette vitesse. */
  speed: 6.5,
  curseMul: 0.6,
  /** Largeur du quai (au nord de la grille), en cases. */
  quayDepth: 1.6,
  /** Points de manche selon l'arrivée. */
  roundPoints: [4, 3, 2, 1] as readonly number[],
  botSpeed: 4,
  /** Le podium tombe au milieu de la mine. */
  podium: [0, 1.2] as [number, number],
} as const;

/** Côtés d'une case : 0 nord (−z), 1 est (+x), 2 sud (+z), 3 ouest (−x). */
export type Side = 0 | 1 | 2 | 3;
const DC: readonly number[] = [0, 1, 0, -1];
const DR: readonly number[] = [-1, 0, 1, 0];
const opposite = (s: number) => ((s + 2) % 4) as Side;

/** Centre de la case (col, row) dans la scène. */
export function cellCenter(col: number, row: number): [number, number] {
  return [(col - (MINE.cols - 1) / 2) * MINE.cell, (row - (MINE.rows - 1) / 2) * MINE.cell];
}

/** Une voie : la suite des cases, de la case du quai (ligne −1) à celle de la sortie (ligne `rows`). */
export interface MineTrack {
  cells: [number, number][];
  /** Longueur totale du rail (unités de la scène), du bord nord de la case du quai au bord sud de la sortie. */
  length: number;
}

/** Un morceau de voie dans une case : on y entre par `a` et on en sort par `b`. */
export interface TrackPiece { col: number; row: number; a: Side; b: Side; straight: boolean; len: number; start: number }

/** Les morceaux d'une voie, avec leur longueur et leur position le long du rail. */
export function trackPieces(cells: readonly [number, number][]): TrackPiece[] {
  const out: TrackPiece[] = [];
  let at = 0;
  for (let i = 0; i < cells.length; i++) {
    const [c, r] = cells[i];
    const prev = cells[i - 1], next = cells[i + 1];
    // on arrive par le nord dans la case du quai, et on repart par le sud de celle de la sortie
    const a: Side = prev ? sideTowards(c, r, prev[0], prev[1]) : 0;
    const b: Side = next ? sideTowards(c, r, next[0], next[1]) : 2;
    const straight = a === opposite(b);
    const len = straight ? MINE.cell : (Math.PI / 2) * (MINE.cell / 2);
    out.push({ col: c, row: r, a, b, straight, len, start: at });
    at += len;
  }
  return out;
}

function sideTowards(c: number, r: number, c2: number, r2: number): Side {
  if (r2 < r) return 0;
  if (c2 > c) return 1;
  if (r2 > r) return 2;
  return 3;
}

/** Milieu du côté `s` de la case centrée en (cx, cz). */
function edgeMid(cx: number, cz: number, s: Side): [number, number] {
  const h = MINE.cell / 2;
  return [cx + DC[s] * h, cz + DR[s] * h];
}

/** Point du morceau `p` à la fraction u (0 = entrée, 1 = sortie) : [x, z, cap]. */
export function piecePoint(p: TrackPiece, u: number): [number, number, number] {
  const [cx, cz] = cellCenter(p.col, p.row);
  const [ax, az] = edgeMid(cx, cz, p.a), [bx, bz] = edgeMid(cx, cz, p.b);
  if (p.straight) return [ax + (bx - ax) * u, az + (bz - az) * u, Math.atan2(bx - ax, bz - az)];
  // quart de cercle autour du coin commun aux deux côtés
  const ox = ax + bx - cx, oz = az + bz - cz;
  const a0 = Math.atan2(ax - ox, az - oz);
  let d = Math.atan2(bx - ox, bz - oz) - a0;
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  const ang = a0 + d * u, R = MINE.cell / 2;
  const x = ox + Math.sin(ang) * R, z = oz + Math.cos(ang) * R;
  // la tangente : perpendiculaire au rayon, dans le sens du parcours
  const s = Math.sign(d);
  return [x, z, Math.atan2(Math.cos(ang) * s, -Math.sin(ang) * s)];
}

/** Position le long d'une voie (d en unités depuis le bord nord de la case du quai) : [x, z, cap]. */
export function trackPoint(pieces: readonly TrackPiece[], d: number): [number, number, number] {
  if (!pieces.length) return [0, 0, 0];
  let lo = 0, hi = pieces.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pieces[m].start <= d) lo = m; else hi = m - 1; }
  const p = pieces[lo];
  return piecePoint(p, Math.min(1, Math.max(0, (d - p.start) / p.len)));
}

/** Départ (centre de la case du quai) et arrivée (centre de la case de sortie) le long du rail. */
export function raceSpan(track: MineTrack): [number, number] {
  return [MINE.cell / 2, track.length - MINE.cell / 2];
}

/** Temps de course d'un wagon (ms). */
export function raceTime(track: MineTrack, cursed: boolean): number {
  const [a, b] = raceSpan(track);
  return ((b - a) / (MINE.speed * (cursed ? MINE.curseMul : 1))) * 1000;
}

/** Distance parcourue le long du rail après `ms` de course. */
export function raceDistance(track: MineTrack, ms: number, cursed: boolean): number {
  const [a, b] = raceSpan(track);
  return Math.min(b, a + (Math.max(0, ms) / 1000) * MINE.speed * (cursed ? MINE.curseMul : 1));
}

/* ================= Génération des voies ================= */

/** Ce qu'il y a déjà dans une case : 0 rien, 1 tout droit N-S, 2 tout droit E-O, 3 croisement, 4 occupée (virage). */
type Cell = 0 | 1 | 2 | 3 | 4;

/**
 * Quatre voies aléatoires, de longueurs bien différentes, qui se croisent plusieurs fois.
 * Les départs sont sur des colonnes distinctes, rangés de gauche à droite (wagon 1 à gauche).
 */
export function makeMineTracks(random: () => number): MineTrack[] {
  for (let attempt = 0; attempt < 400; attempt++) {
    const tracks = tryTracks(random);
    if (tracks) return tracks;
  }
  // (n'arrive pas en pratique) : des voies simples, de longueurs différentes
  return [1, 3, 6, 8].map((c) => {
    const cells: [number, number][] = [[c, -1]];
    for (let r = 0; r < MINE.rows; r++) cells.push([c, r]);
    cells.push([c, MINE.rows]);
    return { cells, length: trackLength(cells) };
  });
}

function trackLength(cells: readonly [number, number][]): number {
  return trackPieces(cells).reduce((s, p) => s + p.len, 0);
}

function shuffle<T>(a: T[], random: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function tryTracks(random: () => number): MineTrack[] | null {
  const { cols, rows, wagons } = MINE;
  const grid: Cell[] = new Array(cols * rows).fill(0);
  // colonnes de départ distinctes, et des longueurs (en cases) bien séparées
  const starts = shuffle([...Array(cols).keys()], random).slice(0, wagons).sort((a, b) => a - b);
  const bins: [number, number][] = [[13, 16], [18, 21], [23, 26], [28, 31]];
  const targets = shuffle(bins.map(([lo, hi]) => lo + Math.floor(random() * (hi - lo + 1))), random);
  const exits = new Set<number>();
  const paths: [number, number][][] = [];
  // les plus longues d'abord : elles ont besoin de place
  const order = [...Array(wagons).keys()].sort((a, b) => targets[b] - targets[a]);
  for (const w of order) {
    const path = walk(grid, starts[w], targets[w], exits, random);
    if (!path) return null;
    paths[w] = path;
    exits.add(path[path.length - 1][0]);
  }
  const tracks = paths.map((p, w) => {
    const cells: [number, number][] = [[starts[w], -1], ...p, [p[p.length - 1][0], rows]];
    return { cells, length: trackLength(cells) };
  });
  // longueurs bien distinctes (sinon la course se joue au hasard)
  const lens = tracks.map((t) => t.length).sort((a, b) => a - b);
  for (let i = 1; i < lens.length; i++) if (lens[i] - lens[i - 1] < MINE.cell * 1.5) return null;
  // il faut des croisements entre voies différentes pour brouiller les pistes
  if (grid.filter((c) => c === 3).length < 3) return null;
  return tracks;
}

/**
 * Une voie de `target` cases (±1) depuis (col, 0) jusqu'à la sortie sous la dernière ligne :
 * recherche en profondeur au hasard, avec un budget (on recommence tout si elle échoue).
 */
function walk(grid: Cell[], col: number, target: number, exits: Set<number>, random: () => number): [number, number][] | null {
  const { cols, rows } = MINE;
  const path: [number, number][] = [];
  const placed: { i: number; before: Cell }[] = [];
  let budget = 6000;

  /** Peut-on poser un morceau a→b dans la case i ? Et ce que deviendra la case. */
  const fit = (i: number, a: number, b: number): Cell | -1 => {
    const cur = grid[i];
    const straight = a === (b + 2) % 4;
    const kind: Cell = straight ? (a % 2 === 0 ? 1 : 2) : 4;
    if (cur === 0) return kind;
    // seul croisement permis : deux lignes droites perpendiculaires
    if ((cur === 1 && kind === 2) || (cur === 2 && kind === 1)) return 3;
    return -1;
  };

  const step = (c: number, r: number, inSide: number): boolean => {
    if (--budget < 0) return false;
    const n = path.length + 1; // cases visitées, celle-ci comprise
    if (n + (rows - 1 - r) > target + 1) return false; // trop loin de la sortie
    // côtés de sortie possibles, au hasard (on préfère tourner : plus difficile à suivre)
    const outs = shuffle([0, 1, 2, 3].filter((s) => s !== inSide), random);
    for (const o of outs) {
      const i = r * cols + c;
      const v = fit(i, inSide, o);
      if (v === -1) continue;
      if (o === 2 && r === rows - 1) {
        // sortie : bonne longueur, et pas deux voies par la même sortie
        if (Math.abs(n - target) > 1 || exits.has(c)) continue;
        placed.push({ i, before: grid[i] }); grid[i] = v; path.push([c, r]);
        return true;
      }
      const nc = c + DC[o], nr = r + DR[o];
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      placed.push({ i, before: grid[i] }); grid[i] = v; path.push([c, r]);
      if (step(nc, nr, (o + 2) % 4)) return true;
      path.pop();
      const back = placed.pop()!;
      grid[back.i] = back.before;
      if (budget < 0) return false;
    }
    return false;
  };

  if (!step(col, 0, 0)) {
    for (const p of placed.reverse()) grid[p.i] = p.before;
    return null;
  }
  return path;
}

/* ================= État public ================= */

export type MineStage = 'intro' | 'preview' | 'curse' | 'pick' | 'race' | 'score' | 'done';

export interface MineState {
  /** Manche (0, 1, 2). */
  round: number;
  stage: MineStage;
  /** Début et fin de l'étape (ms depuis le début de la partie). */
  stageAt: number;
  stageEndsAt: number;
  /** Les quatre voies de la manche (wagon i = voie i). */
  tracks: MineTrack[];
  /** Wagon choisi par chaque joueur. */
  picks: Record<string, number>;
  /** Wagon maudit : révélé au départ de la course seulement (null avant). */
  cursed: number | null;
  /** Course : temps d'arrivée de chaque joueur (ms depuis le départ), connu au départ. */
  arrivals: Record<string, number>;
  /** Points de manche cumulés. */
  points: Record<string, number>;
  /** Place de chacun à chaque manche (pour le classement final). */
  history: Record<string, number>[];
}

/** Ce que l'imposteur apprend : le wagon qu'il a maudit (même si le donjon l'a choisi pour lui). */
export interface MineSecret { round: number; cursed: number }

/** Places de départ (sur le quai, au nord de la grille). */
export const MINE_STARTS: readonly [number, number][] = [-6, -2, 2, 6].map((x) => [x, cellCenter(0, -1)[1] - MINE.cell * 1.15] as [number, number]);
