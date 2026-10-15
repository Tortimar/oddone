import {
  FLOCK_Z, PLACE_POINTS, SHEEP, pushOut,
  type Circle, type MinigameResult, type MinigameTick, type Point, type SheepRaceState,
} from '@oddone/shared';
import type { MinigameSim, SimEntrant, SimStep } from './types.ts';

/**
 * Simulation serveur de « La Course des Moutons ».
 * Le troupeau erre au hasard (chaque mouton change d'idée de temps en temps : il marche dans une
 * direction, ou broute sur place), se cogne aux murets et aux autres moutons, et ignore les joueurs :
 * on ne peut pas le pousser, ce sont les coureurs qui le contournent (chez eux pour les humains,
 * ici pour les bots). Les moutons s'écartent de l'imposteur.
 */

interface Sheep extends Point { id: number; yaw: number; speed: number; changeAt: number }

interface Runner extends Point {
  id: string;
  bot: boolean;
  imposter: boolean;
  yaw: number;
  anim: string;
  done: boolean;
  /** Bots : côté choisi pour doubler un mouton (−1 / 1), et jusqu'à quand. */
  dodge: number;
  dodgeUntil: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

export class SheepSim implements MinigameSim {
  elapsed = 0;
  /** État public (référencé tel quel par `mg.sheep`). */
  readonly state: SheepRaceState = { finished: [], times: {} };
  readonly maxMs = SHEEP.maxMs;
  readonly flock: Sheep[] = [];
  readonly runners = new Map<string, Runner>();
  private bounds = { halfX: SHEEP.halfX, halfZ: SHEEP.endZ };
  private finished = false;
  private changed = false;

  constructor(entrants: SimEntrant[], private random: () => number = Math.random) {
    for (const e of entrants) {
      this.runners.set(e.id, { id: e.id, bot: e.bot, imposter: e.imposter, x: e.start[0], z: e.start[1], yaw: 0, anim: 'Idle', done: false, dodge: 1, dodgeUntil: 0 });
    }
    // le troupeau, réparti sur tout le chemin
    for (let i = 0; i < SHEEP.count; i++) {
      const z = FLOCK_Z[0] + ((i + this.random()) / SHEEP.count) * (FLOCK_Z[1] - FLOCK_Z[0]);
      const x = (this.random() * 2 - 1) * (SHEEP.halfX - SHEEP.radius);
      this.flock.push({ id: i, x, z, yaw: this.random() * Math.PI * 2, speed: 0, changeAt: this.random() * 1500 });
    }
  }

  get isFinished(): boolean { return this.finished; }

  setHumanPosition(id: string, x: number, z: number, _y = 0, yaw?: number): void {
    const r = this.runners.get(id);
    if (!r || r.bot || r.done) return;
    r.x = x; r.z = z;
    if (typeof yaw === 'number' && Number.isFinite(yaw)) r.yaw = yaw;
  }

  remove(id: string): void { this.runners.delete(id); this.changed = true; }

  position(id: string): Point | undefined { return this.runners.get(id); }

  step(dtMs: number): SimStep {
    if (this.finished) return { done: true, changed: false, hits: [] };
    this.elapsed += dtMs;
    this.changed = false;
    const dt = dtMs / 1000;
    this.moveFlock(dt);
    for (const r of this.runners.values()) if (r.bot && !r.done) this.moveBot(r, dt);
    for (const r of this.runners.values()) {
      if (r.done || r.z < SHEEP.finishZ) continue;
      r.done = true; r.anim = 'Cheer';
      this.state.finished.push(r.id);
      this.state.times[r.id] = Math.round(this.elapsed);
      this.changed = true;
    }
    if (![...this.runners.values()].some((r) => !r.done) || this.elapsed >= SHEEP.maxMs) this.finished = true;
    return { done: this.finished, changed: this.changed, hits: [] };
  }

  /** Le troupeau : marche au hasard, broute, s'écarte de l'imposteur, se cogne aux murets et aux autres. */
  private moveFlock(dt: number): void {
    const imposters = [...this.runners.values()].filter((r) => r.imposter && !r.done);
    for (const s of this.flock) {
      if (this.elapsed >= s.changeAt) {
        s.changeAt = this.elapsed + SHEEP.changeMs[0] + this.random() * (SHEEP.changeMs[1] - SHEEP.changeMs[0]);
        if (this.random() < SHEEP.grazeChance) s.speed = 0;
        else {
          s.speed = 0.6 + this.random() * (SHEEP.walkMax - 0.6);
          s.yaw = this.random() * Math.PI * 2;
          // près d'un muret, il repart plutôt vers le milieu ; il ne quitte pas sa partie du chemin
          if (Math.abs(s.x) > SHEEP.halfX - 1.4) s.yaw = Math.atan2(-Math.sign(s.x), (this.random() - 0.5) * 1.5);
          if (s.z < FLOCK_Z[0] + 1 || s.z > FLOCK_Z[1] - 1) s.yaw = Math.atan2((this.random() - 0.5), s.z < 0 ? 1 : -1);
        }
      }
      let vx = Math.sin(s.yaw) * s.speed, vz = Math.cos(s.yaw) * s.speed;
      // l'imposteur leur fait peur
      for (const imp of imposters) {
        const dx = s.x - imp.x, dz = s.z - imp.z, d = Math.hypot(dx, dz);
        if (d >= SHEEP.shyRadius || d < 1e-3) continue;
        const k = SHEEP.shySpeed * (1 - d / SHEEP.shyRadius);
        vx += (dx / d) * k; vz += (dz / d) * k;
      }
      const ox = s.x, oz = s.z;
      s.x += vx * dt; s.z += vz * dt;
      // il ne marche pas sur un coureur : il s'arrête net (et change bientôt d'idée)
      if (this.closerToRunner(s, ox, oz)) { s.x = ox; s.z = oz; s.speed = 0; s.changeAt = Math.min(s.changeAt, this.elapsed + 400); continue; }
      if (Math.hypot(vx, vz) > 0.3) s.yaw = Math.atan2(vx, vz);
      s.x = Math.max(-SHEEP.halfX + SHEEP.radius, Math.min(SHEEP.halfX - SHEEP.radius, s.x));
      s.z = Math.max(FLOCK_Z[0] - 3, Math.min(FLOCK_Z[1] + 2, s.z));
    }
    // les moutons ne se chevauchent pas (sans pour autant se pousser sur un coureur)
    for (let i = 0; i < this.flock.length; i++) for (let j = i + 1; j < this.flock.length; j++) {
      const a = this.flock[i], b = this.flock[j], dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), min = SHEEP.radius * 2;
      if (d >= min || d < 1e-4) continue;
      const push = (min - d) / 2, ax = a.x, az = a.z, bx = b.x, bz = b.z;
      a.x -= (dx / d) * push; a.z -= (dz / d) * push; b.x += (dx / d) * push; b.z += (dz / d) * push;
      if (this.closerToRunner(a, ax, az)) { a.x = ax; a.z = az; }
      if (this.closerToRunner(b, bx, bz)) { b.x = bx; b.z = bz; }
    }
  }

  /** Le mouton, venu de (ox, oz), marche-t-il sur un coureur encore en course ? (s'en éloigner reste permis) */
  private closerToRunner(s: Point, ox: number, oz: number): boolean {
    const min = SHEEP.radius + SHEEP.runnerR;
    for (const r of this.runners.values()) {
      if (r.done) continue;
      const d = Math.hypot(r.x - s.x, r.z - s.z);
      if (d < min && d < Math.hypot(r.x - ox, r.z - oz)) return true;
    }
    return false;
  }

  private sheepCircles(): Circle[] { return this.flock.map((s) => ({ x: s.x, z: s.z, r: SHEEP.radius })); }

  /** Bots : tout droit vers l'arrivée, en doublant les moutons qui barrent le chemin. */
  private moveBot(b: Runner, dt: number): void {
    // un mouton droit devant : on passe du côté où il y a de la place
    const ahead = this.flock.filter((s) => s.z > b.z && s.z - b.z < 3.2 && Math.abs(s.x - b.x) < 1.4);
    if (ahead.length && this.elapsed >= b.dodgeUntil) {
      const left = ahead.reduce((m, s) => Math.min(m, s.x), Infinity) - 1.4, right = ahead.reduce((m, s) => Math.max(m, s.x), -Infinity) + 1.4;
      const room = SHEEP.halfX - 0.6;
      b.dodge = Math.abs(left - b.x) < Math.abs(right - b.x) && left > -room ? -1 : right < room ? 1 : -1;
      b.dodgeUntil = this.elapsed + 600;
    }
    const side = ahead.length || this.elapsed < b.dodgeUntil ? b.dodge * 0.9 : 0;
    const len = Math.hypot(side, 1), sp = SHEEP.botSpeed * dt;
    const fromX = b.x, fromZ = b.z;
    b.x += (side / len) * sp; b.z += sp / len;
    const around = [...this.sheepCircles(), ...this.otherRunners(b)];
    pushOut(b, this.bounds, [], around, SHEEP.runnerR);
    // coincé entre deux moutons : il attend plutôt que d'entrer dans l'un d'eux
    if (this.flock.some((s) => Math.hypot(s.x - b.x, s.z - b.z) < SHEEP.radius + SHEEP.runnerR * 0.6)) { b.x = fromX; b.z = fromZ; }
    const moved = Math.hypot(b.x - fromX, b.z - fromZ);
    b.yaw = Math.atan2(b.x - fromX, b.z - fromZ);
    b.anim = moved > sp * 0.3 ? 'Running_A' : 'Idle';
  }

  private otherRunners(me: Runner): Circle[] {
    return [...this.runners.values()].filter((o) => o !== me && !o.done).map((o) => ({ x: o.x, z: o.z, r: SHEEP.runnerR }));
  }

  /* ================= Fin ================= */

  /** Arrivés dans l'ordre, puis les autres du plus avancé au moins avancé. */
  results(): MinigameResult[] {
    const order = [...this.state.finished, ...[...this.runners.values()].filter((r) => !r.done).sort((a, b) => b.z - a.z).map((r) => r.id)];
    return order.filter((id) => this.runners.has(id)).map((id, i) => ({ id, rank: i + 1, points: PLACE_POINTS[i] ?? 0, survivedMs: this.state.times[id] ?? Math.round(this.elapsed) }));
  }

  tick(): MinigameTick {
    return {
      t: Math.round(this.elapsed),
      sk: [],
      bots: [...this.runners.values()].filter((r) => r.bot).map((r) => [r.id, round(r.x), round(r.z), round(r.yaw), r.anim]),
      sh: this.flock.map((s) => [s.id, round(s.x), round(s.z), round(s.yaw), s.speed > 0.1 ? 1 : 0]),
    };
  }
}
