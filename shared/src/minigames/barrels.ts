/**
 * « Les Tonneaux Fous » : une rampe en zigzag, des tonneaux qui la dévalent, partagé client/serveur.
 *
 * La rampe est un ruban de largeur constante : des montées en ligne droite qui vont alternativement
 * vers +x et vers −x, reliées par des virages en épingle (demi-cercles plats). Tout objet y est
 * repéré par (s, u) : s = distance le long de l'axe depuis le bas, u = écart latéral (entre les
 * deux parois, |u| ≤ largeur / 2). La physique des tonneaux se fait entièrement en (s, u), ce qui
 * rend les rebonds sur les parois et les virages très simples ; `rampPoint` donne la position 3D.
 *
 * Repère du monde : on monte vers −z (vers le haut de l'écran). Départ en bas à gauche, arrivée
 * en haut ; les tonneaux partent du haut et sortent par le bas (ils tombent du bord du départ).
 */

export const BARRELS = {
  id: 'tonneaux-fous',
  /** Largeur de la rampe (entre les deux parois). */
  width: 5,
  /** Épaisseur d'une paroi. */
  wall: 0.4,
  /** Longueur d'une montée. */
  run: 18,
  /** Dénivelé d'une montée. */
  rise: 2.4,
  runs: 5,
  /** Longueur du palier de départ et de celui d'arrivée. */
  startPad: 4,
  finishPad: 8,
  /** Rayon d'un tonneau. */
  radius: 0.55,
  /** Accélération des tonneaux dans les pentes, vitesse maximale. */
  accel: 3.6,
  maxSpeed: 7.2,
  /** Rebond sur les parois (part de la vitesse gardée). */
  bounce: 0.75,
  /** Écart entre deux tonneaux : du plus lent au début au plus rapide en fin de partie. */
  spawnMs: [1500, 750] as [number, number],
  /** Temps pour passer de l'un à l'autre. */
  rampUpMs: 70_000,
  maxBarrels: 28,
  /** Tonneaux déjà en route au départ (répartis sur les montées du haut). */
  primed: 6,
  /** Un joueur écrasé reste aplati, puis repart du début du tronçon où il était. */
  crushMs: 1200,
  /** Ensuite, il clignote un moment : les tonneaux le traversent. */
  graceMs: 1600,
  playerSpeed: 5,
  botSpeed: 4.1,
  push: { cooldownMs: 1400, reach: 1.7 },
  finishers: 3,
  maxDurationMs: 180_000,
} as const;

export type Vec2 = [number, number];

/** Un tronçon de la rampe : droit (palier ou montée) ou virage en épingle. */
export type RampSeg =
  | { kind: 'pad' | 'run'; index: number; s0: number; len: number; h0: number; h1: number; start: Vec2; d: Vec2; n: Vec2 }
  | { kind: 'turn'; index: number; s0: number; len: number; h0: number; h1: number; c: Vec2; a: Vec2; b: Vec2; sigma: 1 | -1; radius: number };

const HALF = BARRELS.width / 2;
/** Rayon de l'axe des virages : deux montées voisines sont séparées par une paroi. */
export const TURN_RADIUS = (BARRELS.width + BARRELS.wall) / 2;
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** z de l'axe de la montée k. */
export const runZ = (k: number) => -k * 2 * TURN_RADIUS;

function buildRamp(): RampSeg[] {
  const { run, rise, runs, startPad, finishPad } = BARRELS;
  const segs: RampSeg[] = [];
  let s = 0;
  const straight = (kind: 'pad' | 'run', index: number, start: Vec2, d: Vec2, len: number, h0: number, h1: number) => {
    segs.push({ kind, index, s0: s, len, h0, h1, start, d, n: [-d[1], d[0]] });
    s += len;
  };
  straight('pad', 0, [-run / 2 - startPad, 0], [1, 0], startPad, 0, 0);
  for (let k = 0; k < runs; k++) {
    const d: Vec2 = k % 2 === 0 ? [1, 0] : [-1, 0];
    const x0 = k % 2 === 0 ? -run / 2 : run / 2, z = runZ(k);
    straight('run', k, [x0, z], d, run, k * rise, (k + 1) * rise);
    if (k < runs - 1) {
      const xEnd = x0 + d[0] * run, a: Vec2 = [0, 1];
      const n: Vec2 = [-d[1], d[0]];
      const len = Math.PI * TURN_RADIUS, h = (k + 1) * rise;
      segs.push({ kind: 'turn', index: k, s0: s, len, h0: h, h1: h, c: [xEnd, z - TURN_RADIUS], a, b: d, sigma: dot(n, a) > 0 ? 1 : -1, radius: TURN_RADIUS });
      s += len;
    }
  }
  const last = segs[segs.length - 1] as { start: Vec2; d: Vec2 };
  straight('pad', 1, [last.start[0] + last.d[0] * run, last.start[1]], last.d, finishPad, runs * rise, runs * rise);
  return segs;
}

export const RAMP: readonly RampSeg[] = buildRamp();
const LAST = RAMP[RAMP.length - 1];
/** Longueur totale de l'axe. */
export const RAMP_LENGTH = LAST.s0 + LAST.len;
/** On a fini en atteignant ce point (un peu après le début du palier d'arrivée). */
export const FINISH_S = LAST.s0 + 1;
/** Les tonneaux apparaissent en haut de la dernière montée. */
export const SPAWN_S = LAST.s0 - 0.6;
/** Centre du palier d'arrivée. */
export const FINISH_CENTER: Vec2 = (() => { const p = rampPoint(LAST.s0 + LAST.len / 2, 0); return [p.x, p.z]; })();

/** Départs : sur le palier du bas, deux de front. */
export const BARREL_STARTS: readonly Vec2[] = [[-12.1, -1.2], [-12.1, 1.2], [-10.7, -1.2], [-10.7, 1.2]];
/** Le podium tombe dans le pré, devant la rampe. */
export const BARREL_PODIUM: Vec2 = [0, 9];

/** Tronçon qui contient s (les extrémités prolongent le premier et le dernier). */
export function segAt(s: number): RampSeg {
  let lo = 0, hi = RAMP.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (RAMP[mid].s0 <= s) lo = mid; else hi = mid - 1; }
  return RAMP[lo];
}
const segIndex = (s: number) => RAMP.indexOf(segAt(s));

/** Hauteur du sol au point s (sous 0 : le tonneau tombe du bord du départ). */
export function rampHeight(s: number): number {
  if (s < 0) return -0.6 * s * s - 0.3 * -s;
  const g = segAt(s), t = clamp((s - g.s0) / g.len, 0, 1);
  return g.h0 + (g.h1 - g.h0) * t;
}

export interface RampPoint { x: number; y: number; z: number; /** direction de la montée */ t: Vec2; /** direction des u croissants */ n: Vec2 }

/** Position 3D d'un point (s, u) de la rampe. */
export function rampPoint(s: number, u: number): RampPoint {
  const g = segAt(s), y = rampHeight(s);
  if (g.kind !== 'turn') {
    const l = s - g.s0;
    return { x: g.start[0] + g.d[0] * l + g.n[0] * u, z: g.start[1] + g.d[1] * l + g.n[1] * u, y, t: g.d, n: g.n };
  }
  const phi = (s - g.s0) / g.radius, c = Math.cos(phi), sn = Math.sin(phi);
  const e: Vec2 = [c * g.a[0] + sn * g.b[0], c * g.a[1] + sn * g.b[1]];
  const rho = g.radius + g.sigma * u;
  return {
    x: g.c[0] + rho * e[0], z: g.c[1] + rho * e[1], y,
    t: [-sn * g.a[0] + c * g.b[0], -sn * g.a[1] + c * g.b[1]], n: [g.sigma * e[0], g.sigma * e[1]],
  };
}

/** Projette (x, z) sur un tronçon : s borné au tronçon, u libre. */
function project(g: RampSeg, x: number, z: number): { s: number; u: number } {
  if (g.kind !== 'turn') {
    const rel: Vec2 = [x - g.start[0], z - g.start[1]];
    // les extrémités de la rampe sont ouvertes (on tombe du départ, on finit au bout de l'arrivée)
    const first = g === RAMP[0], last = g === LAST;
    const l = clamp(dot(rel, g.d), first ? -3 : 0, last ? g.len + 3 : g.len);
    return { s: g.s0 + l, u: dot(rel, g.n) };
  }
  const rel: Vec2 = [x - g.c[0], z - g.c[1]];
  let phi = Math.atan2(dot(rel, g.b), dot(rel, g.a));
  if (phi < 0) phi = phi < -Math.PI / 2 ? Math.PI : 0;
  return { s: g.s0 + phi * g.radius, u: g.sigma * (Math.hypot(rel[0], rel[1]) - g.radius) };
}

/**
 * Retrouve (s, u) d'un point du monde, en partant de la dernière position connue `hintS` :
 * on ne cherche que dans son tronçon et ses voisins, si bien qu'on ne « saute » jamais d'une
 * montée à celle d'au-dessus à travers la paroi (u sort simplement des bornes).
 */
export function locate(x: number, z: number, hintS: number): { s: number; u: number } {
  const i = segIndex(hintS);
  let best = { s: hintS, u: 0 }, bestD = Infinity;
  for (let k = Math.max(0, i - 1); k <= Math.min(RAMP.length - 1, i + 1); k++) {
    const p = project(RAMP[k], x, z);
    const q = rampPoint(p.s, clamp(p.u, -HALF, HALF));
    const d = Math.hypot(q.x - x, q.z - z);
    if (d < bestD - 1e-6) { bestD = d; best = p; }
  }
  return best;
}

/** Numéro de la montée (1..runs) où se trouve s ; 0 au départ, runs + 1 à l'arrivée. */
export function rampFloor(s: number): number {
  const g = segAt(s);
  if (g.kind === 'pad') return g.index === 0 ? 0 : BARRELS.runs + 1;
  return g.index + 1;
}

/** Où repart un joueur écrasé en s : au début du tronçon (palier, montée ou virage). */
export function respawnS(s: number): number {
  const g = segAt(Math.max(0, s));
  return g === RAMP[0] ? 1.5 : g.s0 + 0.5;
}

/* ================= Tonneaux ================= */

export interface Barrel { id: number; s: number; u: number; vs: number; vu: number }

const R = BARRELS.radius;
const U_MAX = HALF - R;

/** Fait avancer un tonneau seul (pente, virages, parois), sans les autres tonneaux. */
export function moveBarrel(b: Barrel, dt: number): void {
  const g = segAt(Math.max(0, b.s));
  if (g.kind === 'run') b.vs -= BARRELS.accel * dt; // la pente l'accélère vers le bas
  else if (g.kind === 'turn' && b.s >= 0) {
    // dans le virage, il est plaqué vers l'extérieur
    b.vu += g.sigma * (b.vs * b.vs / g.radius) * 0.55 * dt;
    b.vs *= 1 - 0.12 * dt;
  } else b.vs = Math.min(b.vs, -2.5) * (1 - 0.05 * dt); // paliers : il continue de rouler
  b.vs = clamp(b.vs, -BARRELS.maxSpeed, BARRELS.maxSpeed);
  b.vu *= 1 - 0.25 * dt;
  b.s += b.vs * dt;
  b.u += b.vu * dt;
  if (b.s >= 0 && Math.abs(b.u) > U_MAX) {
    b.u = Math.sign(b.u) * U_MAX;
    b.vu = -b.vu * BARRELS.bounce;
  }
}

/** Chocs entre tonneaux (élastiques, de même masse). */
export function collideBarrels(barrels: Barrel[]): void {
  for (let i = 0; i < barrels.length; i++) {
    const a = barrels[i];
    for (let j = i + 1; j < barrels.length; j++) {
      const b = barrels[j];
      const ds = b.s - a.s, du = b.u - a.u;
      if (Math.abs(ds) > 2 * R || a.s < 0 || b.s < 0) continue;
      const d = Math.hypot(ds, du);
      if (d >= 2 * R || d < 1e-6) continue;
      const ns = ds / d, nu = du / d, overlap = 2 * R - d;
      a.s -= ns * overlap / 2; a.u = clamp(a.u - nu * overlap / 2, -U_MAX, U_MAX);
      b.s += ns * overlap / 2; b.u = clamp(b.u + nu * overlap / 2, -U_MAX, U_MAX);
      const rel = (a.vs - b.vs) * ns + (a.vu - b.vu) * nu;
      if (rel <= 0) continue;
      const k = rel * 0.92;
      a.vs = clamp(a.vs - k * ns, -BARRELS.maxSpeed, BARRELS.maxSpeed); a.vu -= k * nu;
      b.vs = clamp(b.vs + k * ns, -BARRELS.maxSpeed, BARRELS.maxSpeed); b.vu += k * nu;
    }
  }
}

/**
 * Trajectoire probable d'un tonneau pendant `seconds` (sans tenir compte des autres tonneaux) :
 * c'est ce que voit l'imposteur. Un point (s, u) tous les `every` secondes.
 */
export function predictBarrel(b: Barrel, seconds: number, every = 0.15): [number, number][] {
  const c: Barrel = { ...b }, out: [number, number][] = [];
  const dt = 0.05;
  for (let t = 0, next = every; t < seconds; t += dt) {
    moveBarrel(c, dt);
    if (c.s < 0) break;
    if (t + dt >= next) { out.push([c.s, c.u]); next += every; }
  }
  return out;
}

/**
 * Le distributeur de tonneaux : en haut de la rampe, de plus en plus souvent.
 * Même code pour le serveur (la vraie partie) et le client (l'entraînement).
 */
export class BarrelField {
  barrels: Barrel[] = [];
  private nextId = 1;
  private untilNext = 300;
  private throws = 0;
  private primed = false;

  step(dtMs: number, elapsedMs: number, random: () => number): void {
    const dt = dtMs / 1000;
    // dès le départ, des tonneaux dévalent déjà la rampe : les premiers arrivent en quelques secondes
    if (!this.primed) {
      this.primed = true;
      for (let k = 0; k < BARRELS.primed; k++) {
        const s = 34 + (k / BARRELS.primed) * (SPAWN_S - 40) + random() * 4;
        this.barrels.push({ id: this.nextId++, s, u: (random() * 2 - 1) * (U_MAX - 0.3), vs: -2.5 - random() * 2, vu: (random() * 2 - 1) * 1.6 });
      }
    }
    this.untilNext -= dtMs;
    if (this.untilNext <= 0 && this.barrels.length < BARRELS.maxBarrels) {
      const k = clamp(elapsedMs / BARRELS.rampUpMs, 0, 1);
      const [slow, fast] = BARRELS.spawnMs;
      this.untilNext = (slow + (fast - slow) * k) * (0.75 + random() * 0.5);
      this.throws++;
      if (this.throws % 3 === 0 && this.barrels.length + 2 <= BARRELS.maxBarrels) {
        // une fois sur trois, deux d'un coup, lancés en V vers les parois : ils rebondissent et se croisent
        const spread = 1.8 + random() * 1.2;
        for (const side of [-1, 1]) {
          this.barrels.push({ id: this.nextId++, s: SPAWN_S - (side > 0 ? 0 : 0.3), u: side * 0.65, vs: -1.6 - random() * 0.6, vu: side * spread });
        }
        this.untilNext *= 1.3; // un peu de répit après un double lancer
      } else {
        this.barrels.push({ id: this.nextId++, s: SPAWN_S, u: (random() * 2 - 1) * (U_MAX - 0.3), vs: -1.5 - random(), vu: (random() * 2 - 1) * 1.6 });
      }
    }
    // deux demi-pas : les chocs restent fiables même à pleine vitesse
    for (let k = 0; k < 2; k++) {
      for (const b of this.barrels) moveBarrel(b, dt / 2);
      collideBarrels(this.barrels);
    }
    this.barrels = this.barrels.filter((b) => b.s > -3); // tombés du bord du départ
  }
}

/** Distance (au sol) et hauteur au-dessus du sol en dessous de laquelle un tonneau écrase. */
export const CRUSH_DIST = R + 0.4;
export const CRUSH_HEIGHT = 2 * R * 0.85;

/** Le tonneau b écrase-t-il quelqu'un en (x, z), à `above` au-dessus du sol ? */
export function barrelHits(b: Barrel, x: number, z: number, above: number): boolean {
  if (b.s < 0 || above > CRUSH_HEIGHT) return false;
  const p = rampPoint(b.s, b.u);
  return Math.hypot(p.x - x, p.z - z) < CRUSH_DIST;
}

/** État public d'un grimpeur. */
export interface RampStatus {
  /** Point le plus haut atteint (s). */
  best: number;
  /** Dernier écrasement (ms de jeu), null si aucun. */
  crushedAt: number | null;
  crushes: number;
  /** Où il repart après le dernier écrasement. */
  respawnS: number;
  /** Arrivée en haut (ms de jeu), null tant qu'il grimpe. */
  finishedAt: number | null;
}
