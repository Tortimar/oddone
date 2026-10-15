import {
  BOMB, BOMB_CORNERS, BOMB_HALF, BOMB_MAX_MS, PLACE_POINTS, mazeBoxes, mazeCellAt, mazeCellCenter, mazeDistances, mazeNeighbors, pushOut,
  type BombState, type Box, type Maze, type MazeCell, type MinigameResult, type MinigameTick, type Point,
} from '@oddone/shared';
import type { MinigameSim, SimEntrant, SimStep } from './types.ts';

/**
 * Simulation serveur de « La Bombe du Labyrinthe ».
 * Le serveur tient la mèche (secrète), juge les passages de bombe d'après les positions (les
 * humains se déplacent chez eux), étourdit celui qui la reçoit, fait sauter la bombe et enchaîne
 * les manches. Les bots courent de case en case : celui qui a la bombe poursuit le plus proche
 * (en chemin, pas à vol d'oiseau), les autres fuient quand ils l'entendent (l'imposteur, lui, sait
 * toujours où elle est).
 */

interface Runner extends Point {
  id: string;
  bot: boolean;
  imposter: boolean;
  yaw: number;
  anim: string;
  /** Peut passer la bombe à partir de… (ms de jeu). */
  passReadyAt: number;
  /** Case visée (bots), null : droit sur la cible. */
  goal: MazeCell | null;
  thinkAt: number;
  /** D'où il vient (un bot qui se promène évite de faire demi-tour). */
  from: MazeCell | null;
}

const round = (n: number) => Math.round(n * 100) / 100;
const BOT_R = 0.45;

export class BombSim implements MinigameSim {
  elapsed = 0;
  /** État public (référencé tel quel par `mg.bomb`). */
  readonly state: BombState;
  readonly maxMs = BOMB_MAX_MS;
  readonly players = new Map<string, Runner>();
  private boxes: Box[];
  private bounds = { halfX: BOMB_HALF, halfZ: BOMB_HALF };
  private fuseEnd = 0;
  private outAt = new Map<string, number>();
  private finished = false;
  private changed = false;

  constructor(private maze: Maze, entrants: SimEntrant[], private random: () => number = Math.random) {
    this.boxes = mazeBoxes(maze);
    for (const e of entrants) {
      this.players.set(e.id, {
        id: e.id, bot: e.bot, imposter: e.imposter, x: e.start[0], z: e.start[1], yaw: 0, anim: 'Idle',
        passReadyAt: 0, goal: null, thinkAt: 0, from: null,
      });
    }
    const ids = entrants.map((e) => e.id);
    this.state = {
      round: 1, rounds: Math.max(1, Math.min(BOMB.maxRounds, ids.length - 1)), stage: 'intro', stageAt: 0,
      holder: null, pass: null, stunned: {}, critical: false, alive: ids, out: [], outRound: {}, spawns: {}, boom: null,
    };
    this.startRound(entrants.map((e) => [e.id, e.start]));
  }

  get isFinished(): boolean { return this.finished; }

  /** Nouvelle manche : chacun dans un coin, la bombe à quelqu'un au hasard. */
  private startRound(spawns?: [string, [number, number]][]): void {
    const s = this.state;
    if (!spawns) {
      const corners = this.shuffle(BOMB_CORNERS.map(([c, r]) => mazeCellCenter(c, r)));
      spawns = s.alive.map((id, i) => [id, corners[i % corners.length]]);
    }
    s.spawns = {};
    for (const [id, [x, z]] of spawns) {
      const p = this.players.get(id);
      if (!p) continue;
      p.x = x; p.z = z; p.goal = null; p.from = null; p.anim = 'Idle'; p.yaw = Math.atan2(-x, -z);
      s.spawns[id] = [x, z];
    }
    s.holder = s.alive[Math.floor(this.random() * s.alive.length)] ?? null;
    const h = s.holder ? this.players.get(s.holder) : undefined;
    if (h) h.passReadyAt = this.elapsed + BOMB.introMs;
    s.stage = 'intro'; s.stageAt = Math.round(this.elapsed);
    s.pass = null; s.stunned = {}; s.critical = false;
  }

  setHumanPosition(id: string, x: number, z: number, _y = 0, yaw?: number): void {
    const p = this.players.get(id);
    if (!p || p.bot) return;
    p.x = x; p.z = z;
    if (typeof yaw === 'number' && Number.isFinite(yaw)) p.yaw = yaw;
  }

  remove(id: string): void {
    const s = this.state;
    this.players.delete(id);
    s.alive = s.alive.filter((a) => a !== id);
    if (s.holder === id) s.holder = s.alive[Math.floor(this.random() * s.alive.length)] ?? null;
    if (s.alive.length <= 1 && s.stage !== 'done') { s.stage = 'done'; this.finished = true; }
    this.changed = true;
  }

  position(id: string): Point | undefined { return this.players.get(id); }

  private stunned(id: string): boolean { return this.elapsed < (this.state.stunned[id] ?? 0); }

  step(dtMs: number): SimStep {
    if (this.finished) return { done: true, changed: false, hits: [] };
    this.elapsed += dtMs;
    this.changed = false;
    const s = this.state, since = this.elapsed - s.stageAt;
    if (s.stage === 'intro') {
      if (since >= BOMB.introMs) {
        s.stage = 'play'; s.stageAt = Math.round(this.elapsed);
        this.fuseEnd = this.elapsed + BOMB.fuseMs[0] + this.random() * (BOMB.fuseMs[1] - BOMB.fuseMs[0]);
        this.changed = true;
      }
    } else if (s.stage === 'play') {
      for (const id of s.alive) { const p = this.players.get(id); if (p?.bot) this.moveBot(p, dtMs / 1000); }
      this.checkPass();
      if (!s.critical && this.fuseEnd - this.elapsed <= BOMB.criticalMs) { s.critical = true; this.changed = true; }
      if (this.elapsed >= this.fuseEnd) this.explode();
    } else if (s.stage === 'boom' && since >= BOMB.boomMs) {
      if (s.round < s.rounds && s.alive.length > 1) { s.round += 1; this.startRound(); }
      else {
        s.stage = 'done'; this.finished = true;
        for (const id of s.alive) { const p = this.players.get(id); if (p?.bot) p.anim = 'Cheer'; }
      }
      this.changed = true;
    }
    return { done: this.finished, changed: this.changed, hits: [] };
  }

  /** Celui qui tient la bombe touche quelqu'un : elle change de main, le nouveau porteur est étourdi. */
  private checkPass(): void {
    const s = this.state, h = s.holder ? this.players.get(s.holder) : undefined;
    if (!h || this.elapsed < h.passReadyAt || this.stunned(h.id)) return;
    let best: Runner | null = null, bestD: number = BOMB.passRadius;
    for (const id of s.alive) {
      const o = this.players.get(id);
      if (!o || o === h) continue;
      const d = Math.hypot(o.x - h.x, o.z - h.z);
      if (d < bestD) { bestD = d; best = o; }
    }
    if (!best) return;
    s.holder = best.id;
    s.stunned[best.id] = Math.round(this.elapsed + BOMB.stunMs);
    best.passReadyAt = this.elapsed + BOMB.passCooldownMs;
    best.goal = null; best.thinkAt = this.elapsed + BOMB.stunMs;
    if (best.bot) best.anim = 'Hit_A';
    s.pass = { from: h.id, to: best.id, at: Math.round(this.elapsed) };
    this.changed = true;
  }

  private explode(): void {
    const s = this.state, id = s.holder;
    if (!id) { s.stage = 'boom'; s.stageAt = Math.round(this.elapsed); return; }
    const p = this.players.get(id);
    s.alive = s.alive.filter((a) => a !== id);
    s.out.push(id);
    s.outRound[id] = s.round;
    this.outAt.set(id, this.elapsed);
    s.boom = { id, at: Math.round(this.elapsed), x: round(p?.x ?? 0), z: round(p?.z ?? 0) };
    s.holder = null; s.critical = false;
    s.stage = 'boom'; s.stageAt = Math.round(this.elapsed);
    if (p?.bot) p.anim = 'Death_A';
    for (const a of s.alive) { const o = this.players.get(a); if (o?.bot) o.anim = 'Idle'; }
    this.changed = true;
  }

  /* ================= Bots ================= */

  private moveBot(b: Runner, dt: number): void {
    if (this.stunned(b.id)) { b.anim = 'Hit_A'; return; }
    const s = this.state, holding = s.holder === b.id;
    const here = mazeCellAt(b.x, b.z);
    if (b.goal) {
      const [gx, gz] = mazeCellCenter(b.goal[0], b.goal[1]);
      if (Math.hypot(gx - b.x, gz - b.z) < 0.35) { b.from = here; b.goal = null; b.thinkAt = this.elapsed; }
    }
    if (this.elapsed >= b.thinkAt) { this.think(b, here); b.thinkAt = this.elapsed + 220 + this.random() * 200; }
    // cible : le centre de la case visée, ou droit sur la proie quand on est dans la même case
    let tx: number, tz: number;
    if (b.goal) [tx, tz] = mazeCellCenter(b.goal[0], b.goal[1]);
    else if (holding) { const prey = this.nearestPrey(b); if (!prey) { b.anim = 'Idle'; return; } tx = prey.x; tz = prey.z; }
    else { b.anim = 'Idle'; return; }
    const dx = tx - b.x, dz = tz - b.z, d = Math.hypot(dx, dz);
    if (d < 0.05) { b.anim = 'Idle'; return; }
    const speed = holding ? BOMB.botSpeed.holder : BOMB.botSpeed.runner, step = Math.min(d, speed * dt);
    b.x += (dx / d) * step; b.z += (dz / d) * step;
    pushOut(b, this.bounds, this.boxes, [], BOT_R);
    b.yaw = Math.atan2(dx, dz);
    b.anim = 'Running_A';
  }

  /** La proie la plus proche en chemin (pour celui qui tient la bombe). */
  private nearestPrey(b: Runner): Runner | null {
    const d = mazeDistances(this.maze, mazeCellAt(b.x, b.z));
    let best: Runner | null = null, bestK = Infinity;
    for (const id of this.state.alive) {
      const o = this.players.get(id);
      if (!o || o === b) continue;
      const [c, r] = mazeCellAt(o.x, o.z);
      const k = d[r * this.maze.cols + c] + Math.hypot(o.x - b.x, o.z - b.z) * 0.01 + this.random() * 0.4;
      if (k < bestK) { bestK = k; best = o; }
    }
    return best;
  }

  /** Choisit la prochaine case : poursuivre (bombe), fuir (on l'entend), ou se promener. */
  private think(b: Runner, here: MazeCell): void {
    const s = this.state, m = this.maze, key = (c: MazeCell) => c[1] * m.cols + c[0];
    const around = mazeNeighbors(m, here[0], here[1]);
    if (s.holder === b.id) {
      const prey = this.nearestPrey(b);
      if (!prey) { b.goal = null; return; }
      const target = mazeCellAt(prey.x, prey.z);
      if (key(target) === key(here)) { b.goal = null; return; }
      const d = mazeDistances(m, target), closer = around.filter((n) => d[key(n)] === d[key(here)] - 1);
      b.goal = closer[Math.floor(this.random() * closer.length)] ?? null;
      return;
    }
    const h = s.holder ? this.players.get(s.holder) : undefined;
    const dh = h ? mazeDistances(m, mazeCellAt(h.x, h.z)) : null;
    const hears = !!dh && (b.imposter || dh[key(here)] <= BOMB.hearCells);
    if (!hears || !dh) {
      // promenade : on continue tout droit autant que possible, sans faire demi-tour
      if (b.goal) return;
      const ahead = around.filter((n) => !b.from || key(n) !== key(b.from));
      const pool = ahead.length ? ahead : around;
      b.goal = pool[Math.floor(this.random() * pool.length)] ?? null;
      return;
    }
    // fuite : la case qui éloigne le plus de la bombe (en évitant les culs-de-sac), parfois une erreur
    if (this.random() < (b.imposter ? 0.05 : 0.14)) { b.goal = around[Math.floor(this.random() * around.length)] ?? null; return; }
    let best: MazeCell | null = null, bestScore = -Infinity;
    for (const n of around) {
      const exits = mazeNeighbors(m, n[0], n[1]).length;
      const score = dh[key(n)] + (exits > 1 ? 0.6 : -0.8) + this.random() * 0.7;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    // rester sur place vaut mieux qu'aller vers la bombe
    b.goal = best && dh[key(best)] >= dh[key(here)] ? best : b.goal;
  }

  /* ================= Fin ================= */

  results(): MinigameResult[] {
    const s = this.state;
    // les survivants d'abord, puis du dernier au premier éliminé
    const res: MinigameResult[] = s.alive.map((id) => ({ id, rank: 1, points: PLACE_POINTS[0], survivedMs: Math.round(this.elapsed) }));
    let rank = s.alive.length;
    for (const id of [...s.out].reverse()) {
      rank += 1;
      res.push({ id, rank, points: PLACE_POINTS[rank - 1] ?? 0, survivedMs: Math.round(this.outAt.get(id) ?? 0) });
    }
    return res.filter((r) => this.players.has(r.id));
  }

  tick(): MinigameTick {
    return {
      t: Math.round(this.elapsed),
      sk: [],
      bots: [...this.players.values()].filter((p) => p.bot).map((p) => [p.id, round(p.x), round(p.z), round(p.yaw), p.anim]),
    };
  }

  private shuffle<T>(list: readonly T[]): T[] {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
}
