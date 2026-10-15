import {
  CourseMap, DIR_VEC, GORGE, NORMAL_CONTROLS, PLACE_POINTS, scrambledControls,
  type GorgeCourse, type Hit, type MinigameResult, type MinigameTick, type Point, type RaceStatus,
} from '@oddone/shared';
import type { MinigameSim, SimEntrant, SimStep } from './types.ts';

/**
 * Simulation serveur du « Pont Branlant ».
 * Le serveur suit la progression de tous (ponts atteints, arrivée), mélange les commandes à
 * chaque pont (sauf pour l'imposteur) et fait courir les bots. Les humains se déplacent et
 * tombent chez eux ; le serveur ne voit que leurs positions.
 */

interface Racer extends Point {
  id: string;
  bot: boolean;
  imposter: boolean;
  start: [number, number];
  y: number;
  yaw: number;
  anim: string;
  /** Bots : case visée. */
  target: [number, number] | null;
  fallUntil: number | null;
  vy: number;
  knockUntil: number;
  kx: number;
  kz: number;
  pushReadyAt: number;
}

export class GorgeRaceSim implements MinigameSim {
  elapsed = 0;
  readonly map: CourseMap;
  readonly racers = new Map<string, Racer>();
  /** État public (référencé tel quel par `mg.race`). */
  readonly race: Record<string, RaceStatus> = {};
  private finished = false;
  private changed = false;
  private hits: Hit[] = [];

  constructor(course: GorgeCourse, entrants: SimEntrant[], private random: () => number = Math.random) {
    this.map = new CourseMap(course);
    for (const e of entrants) {
      this.racers.set(e.id, {
        id: e.id, bot: e.bot, imposter: e.imposter, start: e.start, x: e.start[0], z: e.start[1], y: 0, yaw: Math.PI, anim: 'Idle',
        target: null, fallUntil: null, vy: 0, knockUntil: 0, kx: 0, kz: 0, pushReadyAt: 2000 + random() * 2000,
      });
      this.race[e.id] = { cp: 0, controls: [...NORMAL_CONTROLS], tornadoAt: null, finishedAt: null };
    }
  }

  get isFinished(): boolean { return this.finished; }
  readonly maxMs = GORGE.maxDurationMs;

  setHumanPosition(id: string, x: number, z: number): void {
    const r = this.racers.get(id);
    if (!r || r.bot || this.finished) return;
    // positions reçues ~20 fois par seconde : si une ou deux se perdent, on vérifie aussi les cases
    // entre la précédente et celle-ci (sinon un pont franchi pourrait passer inaperçu)
    const dx = x - r.x, dz = z - r.z, d = Math.hypot(dx, dz);
    const steps = d > 0.4 && d < 8 ? Math.ceil(d / 0.4) : 0;
    for (let k = 1; k < steps; k++) {
      r.x += dx / steps; r.z += dz / steps;
      this.progress(r);
    }
    r.x = x; r.z = z;
    this.progress(r);
  }

  remove(id: string): void { this.racers.delete(id); delete this.race[id]; }

  position(id: string): Point | undefined { return this.racers.get(id); }

  /** Un humain a poussé un bot. */
  knock(id: string, dir: [number, number]): void {
    const r = this.racers.get(id);
    if (!r?.bot || r.fallUntil !== null) return;
    r.kx = dir[0] * 7; r.kz = dir[1] * 7; r.knockUntil = this.elapsed + 350;
    r.anim = 'Hit_A';
  }

  step(dtMs: number): SimStep {
    if (this.finished) return { done: true, changed: false, hits: [] };
    this.elapsed += dtMs;
    this.changed = false; this.hits = [];
    const dt = dtMs / 1000;
    for (const r of this.racers.values()) if (r.bot) this.moveBot(r, dt);
    // fin : dès que les 3 premiers sont arrivés (tout le monde s'il y a moins de 3 coureurs)
    const statuses = Object.values(this.race);
    const arrived = statuses.filter((s) => s.finishedAt !== null).length;
    const enough = statuses.length > 0 && arrived >= Math.min(GORGE.finishers, statuses.length);
    if (enough || this.elapsed >= GORGE.maxDurationMs) {
      this.finished = true;
      for (const r of this.racers.values()) if (r.bot) r.anim = this.race[r.id].finishedAt !== null ? 'Cheer' : 'Idle';
    }
    return { done: this.finished, changed: this.changed, hits: this.hits };
  }

  /** Ponts et arrivée : le serveur les constate d'après la position. */
  private progress(r: Racer): void {
    const st = this.race[r.id];
    if (!st || st.finishedAt !== null) return;
    const b = this.map.bridgeAt(r.x, r.z);
    if (b >= 0 && b + 1 > st.cp) {
      st.cp = b + 1;
      st.tornadoAt = Math.round(this.elapsed);
      // l'imposteur garde ses commandes : c'est son avantage
      st.controls = r.imposter ? [...NORMAL_CONTROLS] : scrambledControls(this.random);
      this.changed = true;
    } else if (st.cp === this.map.course.bridges.length && this.map.finished(r.x, r.z)) {
      st.finishedAt = Math.round(this.elapsed);
      this.changed = true;
    }
  }

  private moveBot(r: Racer, dt: number): void {
    const st = this.race[r.id];
    // chute dans le gouffre, puis retour au dernier pont
    if (r.fallUntil !== null) {
      r.vy -= 26 * dt; r.y += r.vy * dt;
      if (this.elapsed >= r.fallUntil) {
        [r.x, r.z] = this.map.spawn(st.cp, r.start);
        r.y = 0; r.vy = 0; r.fallUntil = null; r.target = null; r.anim = 'Idle';
      }
      return;
    }
    if (this.elapsed < r.knockUntil) {
      r.x += r.kx * dt; r.z += r.kz * dt;
      if (!this.map.walkable(r.x, r.z)) this.fall(r);
      return;
    }
    if (st.finishedAt !== null) {
      // arrivé : il s'écarte de la ligne pour laisser passer
      this.walkTo(r, this.map.course.finishCenter[0] + (r.start[0] * 1.2), this.map.course.finishCenter[1] + 1.5, GORGE.botSpeed * 0.6, dt);
      if (r.anim === 'Idle') r.anim = 'Cheer';
      return;
    }
    // tornade : il tourne sur lui-même
    if (st.tornadoAt !== null && this.elapsed - st.tornadoAt < GORGE.tornadoMs) { r.anim = 'Idle'; r.yaw += dt * 14; return; }

    const [ci, cj] = CourseMap.cellOf(r.x, r.z);
    if (!r.target || (Math.abs(r.x - r.target[0] * GORGE.cell) < 0.08 && Math.abs(r.z + r.target[1] * GORGE.cell) < 0.08)) {
      r.target = this.nextCell(r, ci, cj);
    }
    const [tx, tz] = CourseMap.center(r.target[0], r.target[1]);
    // quelqu'un bloque le passage ? on attend… ou on le pousse
    const dx = Math.sign(Math.round((tx - r.x) * 10)), dz = Math.sign(Math.round((tz - r.z) * 10));
    for (const o of this.racers.values()) {
      if (o === r || o.fallUntil !== null) continue;
      const ox = o.x - r.x, oz = o.z - r.z, d = Math.hypot(ox, oz);
      if (d > 1 || ox * dx + oz * dz < 0.3) continue;
      if (this.elapsed >= r.pushReadyAt) {
        r.pushReadyAt = this.elapsed + GORGE.push.cooldownMs + 800 + this.random() * 2000;
        const dir: [number, number] = [ox / (d || 1), oz / (d || 1)];
        r.anim = 'Unarmed_Melee_Attack_Punch_A';
        r.yaw = Math.atan2(dir[0], dir[1]);
        if (o.bot) this.knock(o.id, dir);
        this.hits.push({ from: r.id, to: o.id, kick: false, dir });
      } else r.anim = 'Idle';
      return;
    }
    this.walkTo(r, tx, tz, GORGE.botSpeed, dt);
    if (!this.map.walkable(r.x, r.z)) this.fall(r);
    this.progress(r);
  }

  /** Avance en ligne droite (axe par axe : on ne bouge que dans 4 directions). */
  private walkTo(r: Racer, tx: number, tz: number, speed: number, dt: number): void {
    let step = speed * dt;
    const ex = tx - r.x, ez = tz - r.z;
    if (Math.abs(ex) < 0.02 && Math.abs(ez) < 0.02) { r.anim = r.anim === 'Running_A' ? 'Idle' : r.anim; return; }
    // d'abord l'axe sur lequel on est déjà presque aligné
    if (Math.abs(ex) > 0.02 && (Math.abs(ez) < 0.02 || Math.abs(ex) < Math.abs(ez))) {
      const m = Math.min(step, Math.abs(ex)); r.x += Math.sign(ex) * m; step -= m; r.yaw = Math.atan2(Math.sign(ex), 0);
    } else {
      const m = Math.min(step, Math.abs(ez)); r.z += Math.sign(ez) * m; step -= m; r.yaw = Math.atan2(0, Math.sign(ez));
    }
    r.anim = 'Running_A';
  }

  /** Case suivante : celle qui rapproche de l'arrivée. Commandes mélangées : parfois un faux pas. */
  private nextCell(r: Racer, i: number, j: number): [number, number] {
    const st = this.race[r.id];
    const confused = !r.imposter && st.controls.some((d, k) => d !== NORMAL_CONTROLS[k]);
    if (confused && this.random() < 0.05) {
      const [vx, vz] = DIR_VEC[NORMAL_CONTROLS[Math.floor(this.random() * 4)]];
      return [i + vx, j - vz];
    }
    const here = this.map.distAt(i, j);
    const options = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const)
      .map(([di, dj]) => [i + di, j + dj, this.map.distAt(i + di, j + dj)] as const)
      .filter(([, , d]) => d < here);
    if (!options.length) return [i, j + 1];
    const best = Math.min(...options.map((o) => o[2]));
    const pick = options.filter((o) => o[2] === best);
    const [ni, nj] = pick[Math.floor(this.random() * pick.length)];
    return [ni, nj];
  }

  private fall(r: Racer): void {
    r.fallUntil = this.elapsed + GORGE.respawnMs; r.vy = 0; r.anim = 'Jump_Idle';
  }

  results(): MinigameResult[] {
    const order = [...this.racers.values()].map((r) => {
      const st = this.race[r.id];
      const [i, j] = CourseMap.cellOf(r.x, r.z);
      // arrivés d'abord (par temps), puis par pont atteint, puis par distance restante
      const score = st.finishedAt !== null ? [0, st.finishedAt, 0] : [1, -st.cp, this.map.distAt(i, j)];
      return { id: r.id, score, survivedMs: Math.round(st.finishedAt ?? this.elapsed) };
    }).sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1] || a.score[2] - b.score[2]);
    const same = (a: number[], b: number[]) => a.every((v, k) => v === b[k]);
    let rank = 0;
    return order.map((o, idx) => {
      if (idx === 0 || !same(o.score, order[idx - 1].score)) rank = idx + 1;
      return { id: o.id, rank, points: PLACE_POINTS[rank - 1] ?? 0, survivedMs: o.survivedMs };
    });
  }

  tick(): MinigameTick {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      t: Math.round(this.elapsed),
      sk: [],
      bots: [...this.racers.values()].filter((r) => r.bot).map((r) => [r.id, r2(r.x), r2(r.z), r2(r.yaw), r.anim, r2(r.y)]),
    };
  }
}
