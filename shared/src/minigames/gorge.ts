/**
 * « Le Pont Branlant » : course au-dessus d'un gouffre, partagée client/serveur.
 *
 * Le parcours est une grille de cases (CELL unités de côté). Les chemins font une case de large
 * et zigzaguent à angle droit ; on ne se déplace que dans 4 directions. Entre deux tronçons,
 * un pont étroit sert de point de passage (checkpoint) : en y arrivant, une tornade fait
 * tourner le héros et mélange ses commandes (haut, droite, bas, gauche : une de chaque).
 * Les commandes de l'imposteur, elles, ne changent jamais.
 * On peut pousser les autres (recharge) : qui tombe repart du dernier pont atteint.
 *
 * Repère : x = i × CELL, z = −j × CELL (on avance vers −z, c'est-à-dire vers le haut de l'écran).
 */

export const GORGE = {
  id: 'pont-branlant',
  cell: 1.3,
  /** Demi-largeur des tronçons, en cases (colonnes −W … W). */
  halfWidth: 4,
  sections: 4,
  /** Vitesse d'un joueur ici (plus posée que d'habitude : il faut viser les virages). */
  playerSpeed: 5,
  botSpeed: 4.3,
  push: { cooldownMs: 1500, reach: 1.6 },
  /** Durée de la tornade (le héros tourne, ses commandes sont bloquées). */
  tornadoMs: 1300,
  /** Temps entre la chute et la réapparition sur le dernier pont. */
  respawnMs: 1400,
  /** La course s'arrête quand les `finishers` premiers sont arrivés (ou tout le monde s'ils sont moins). */
  finishers: 3,
  /** Filet de sécurité seulement (joueur bloqué, absent…) : la course se termine d'ordinaire bien avant. */
  maxDurationMs: 300_000,
} as const;

export type Dir = 'up' | 'right' | 'down' | 'left';
export const DIRS: readonly Dir[] = ['up', 'right', 'down', 'left'];
/** Commandes : pour chaque touche (haut, droite, bas, gauche), la direction réellement prise. */
export type ControlMap = [Dir, Dir, Dir, Dir];
export const NORMAL_CONTROLS: ControlMap = ['up', 'right', 'down', 'left'];
/** Vecteur (x, z) d'une direction à l'écran. */
export const DIR_VEC: Record<Dir, [number, number]> = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };

export type CellKind = 'start' | 'path' | 'landing' | 'bridge' | 'finish';
export interface GorgeCourse {
  /** Cases praticables : [i, j, type]. */
  cells: [number, number, CellKind][];
  /** Ponts dans l'ordre : colonne et rangées [j0, j1]. Arriver sur le pont k = checkpoint k + 1. */
  bridges: { i: number; j0: number; j1: number }[];
  /** Première rangée de la plateforme d'arrivée. */
  finishRow: number;
  /** Centre de la plateforme d'arrivée [x, z] (le podium y tombe). */
  finishCenter: [number, number];
}

/** État public d'un coureur. */
export interface RaceStatus {
  /** Dernier checkpoint atteint : 0 = départ, k = k-ième pont. */
  cp: number;
  controls: ControlMap;
  /** Début de la dernière tornade (ms de jeu), null si aucune. */
  tornadoAt: number | null;
  /** Temps d'arrivée (ms de jeu), null tant qu'il court. */
  finishedAt: number | null;
}

const key = (i: number, j: number) => `${i},${j}`;

/** Génère un parcours : départ, 4 tronçons à deux chemins en zigzag, 3 ponts, arrivée. */
export function makeGorgeCourse(random: () => number): GorgeCourse {
  const W = GORGE.halfWidth;
  const cells = new Map<string, [number, number, CellKind]>();
  const put = (i: number, j: number, kind: CellKind) => {
    const k = key(i, j), old = cells.get(k);
    if (!old || old[2] === 'path') cells.set(k, [i, j, kind]);
  };
  const rect = (i0: number, i1: number, j0: number, j1: number, kind: CellKind) => {
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) put(i, j, kind);
  };
  const int = (a: number, b: number) => a + Math.floor(random() * (b - a + 1));

  rect(-3, 3, 0, 2, 'start');
  const bridges: GorgeCourse['bridges'] = [];
  let j = 3, entries = [-2, 2];
  for (let s = 0; s < GORGE.sections; s++) {
    const length = 9 + int(0, 2);
    const jEnd = j + length - 1;
    // deux chemins : l'un côté gauche, l'autre côté droit (ils peuvent se croiser)
    entries.forEach((i0, side) => {
      let i = i0, jj = j;
      put(i, jj, 'path');
      while (jj < jEnd) {
        const run = int(1, 3);
        for (let r = 0; r < run && jj < jEnd; r++) put(i, ++jj, 'path');
        if (jj >= jEnd) break;
        // chacun reste de son côté : deux couloirs distincts, qui ne se rejoignent qu'aux paliers
        let target = side === 0 ? int(-W, -1) : int(1, W);
        if (target === i) target = side === 0 ? (i === -1 ? -W + 1 : -1) : (i === 1 ? W - 1 : 1);
        while (i !== target) { i += Math.sign(target - i); put(i, jj, 'path'); }
      }
      while (i !== 0) { i -= Math.sign(i); put(i, jEnd, 'path'); }
    });
    rect(-1, 1, jEnd + 1, jEnd + 2, 'landing');
    if (s < GORGE.sections - 1) {
      const b = { i: 0, j0: jEnd + 3, j1: jEnd + 6 };
      for (let r = b.j0; r <= b.j1; r++) put(0, r, 'bridge');
      bridges.push(b);
      rect(-1, 1, b.j1 + 1, b.j1 + 2, 'landing');
      j = b.j1 + 3;
      entries = [-1, 1];
    } else {
      const finishRow = jEnd + 3;
      rect(-5, 5, finishRow, finishRow + 6, 'finish');
      return { cells: [...cells.values()], bridges, finishRow, finishCenter: [0, -(finishRow + 3.5) * GORGE.cell] };
    }
  }
  throw new Error('parcours incomplet');
}

/** Index rapide d'un parcours (cases praticables, distances jusqu'à l'arrivée). */
export class CourseMap {
  readonly kinds = new Map<string, CellKind>();
  /** Distance (en cases) jusqu'à l'arrivée, par la marche. */
  readonly dist = new Map<string, number>();

  constructor(readonly course: GorgeCourse) {
    for (const [i, j, k] of course.cells) this.kinds.set(key(i, j), k);
    const queue: [number, number][] = [];
    for (const [i, j, k] of course.cells) if (k === 'finish') { this.dist.set(key(i, j), 0); queue.push([i, j]); }
    for (let q = 0; q < queue.length; q++) {
      const [i, j] = queue[q], d = this.dist.get(key(i, j))!;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = key(i + di, j + dj);
        if (this.kinds.has(n) && !this.dist.has(n)) { this.dist.set(n, d + 1); queue.push([i + di, j + dj]); }
      }
    }
  }

  static cellOf(x: number, z: number): [number, number] { return [Math.round(x / GORGE.cell), Math.round(-z / GORGE.cell)]; }
  static center(i: number, j: number): [number, number] { return [i * GORGE.cell, -j * GORGE.cell]; }

  kindAt(x: number, z: number): CellKind | undefined {
    const [i, j] = CourseMap.cellOf(x, z);
    return this.kinds.get(key(i, j));
  }

  has(i: number, j: number): boolean { return this.kinds.has(key(i, j)); }
  distAt(i: number, j: number): number { return this.dist.get(key(i, j)) ?? Infinity; }

  /** Les pieds tiennent-ils sur quelque chose ? (petite tolérance au bord des cases) */
  walkable(x: number, z: number, margin = 0.22): boolean {
    for (const [dx, dz] of [[0, 0], [margin, 0], [-margin, 0], [0, margin], [0, -margin]]) {
      if (this.kindAt(x + dx, z + dz)) return true;
    }
    return false;
  }

  /** Pont sur lequel se trouve le point (index), ou −1. */
  bridgeAt(x: number, z: number): number {
    const [i, j] = CourseMap.cellOf(x, z);
    return this.course.bridges.findIndex((b) => b.i === i && j >= b.j0 && j <= b.j1);
  }

  finished(x: number, z: number): boolean { return this.kindAt(x, z) === 'finish'; }

  /** Point de réapparition du checkpoint cp (0 = place de départ du joueur). */
  spawn(cp: number, start: [number, number]): [number, number] {
    if (cp <= 0) return start;
    const b = this.course.bridges[Math.min(cp, this.course.bridges.length) - 1];
    return CourseMap.center(b.i, b.j0 + 1);
  }
}

/** Places de départ (par place J1..J4) sur la plateforme de départ. */
export const GORGE_STARTS: readonly [number, number][] = [-3, -1, 1, 3].map((i) => CourseMap.center(i, 1));

/** Nouvelles commandes mélangées : chaque direction une fois, jamais les commandes normales. */
export function scrambledControls(random: () => number): ControlMap {
  for (;;) {
    const d = [...DIRS];
    for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
    if (d.some((x, i) => x !== DIRS[i])) return d as ControlMap;
  }
}
