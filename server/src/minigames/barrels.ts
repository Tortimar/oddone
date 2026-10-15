import {
  BARRELS, BarrelField, FINISH_S, PLACE_POINTS, RAMP_LENGTH, barrelHits, locate, predictBarrel, rampHeight, rampPoint, respawnS,
  type Hit, type MinigameResult, type MinigameTick, type Point, type RampStatus,
} from '@oddone/shared';
import type { MinigameSim, SimEntrant, SimStep } from './types.ts';

/**
 * Simulation serveur des « Tonneaux Fous ».
 * Le serveur fait rouler les tonneaux (BarrelField, partagé avec l'entraînement du client),
 * juge les écrasements, suit la progression de chacun et fait grimper les bots. Les humains se
 * déplacent chez eux : le serveur ne voit que leurs positions (et leur hauteur, pour les sauts).
 */

const HALF = BARRELS.width / 2 - 0.45;
const GRAVITY = 26, JUMP = 9;

interface Climber {
  id: string;
  bot: boolean;
  imposter: boolean;
  /** Position sur la rampe. */
  s: number;
  u: number;
  /** Position dans le monde (humains : reçue ; bots : calculée). */
  x: number;
  z: number;
  /** Hauteur au-dessus du sol de la rampe (saut). */
  above: number;
  vy: number;
  yaw: number;
  anim: string;
  crushedUntil: number;
  graceUntil: number;
  /** Bots : écart latéral visé, et prochain moment où il réfléchit. */
  targetU: number;
  thinkAt: number;
  knockUntil: number;
  ks: number;
  ku: number;
  pushReadyAt: number;
}

export class BarrelSim implements MinigameSim {
  elapsed = 0;
  readonly field = new BarrelField();
  readonly climbers = new Map<string, Climber>();
  /** État public (référencé tel quel par `mg.ramp`). */
  readonly ramp: Record<string, RampStatus> = {};
  private finished = false;
  private changed = false;
  private hits: Hit[] = [];
  readonly maxMs = BARRELS.maxDurationMs;

  constructor(entrants: SimEntrant[], private random: () => number = Math.random) {
    for (const e of entrants) {
      const { s, u } = locate(e.start[0], e.start[1], 2);
      this.climbers.set(e.id, {
        id: e.id, bot: e.bot, imposter: e.imposter, s, u, x: e.start[0], z: e.start[1], above: 0, vy: 0, yaw: Math.PI / 2, anim: 'Idle',
        crushedUntil: 0, graceUntil: 0, targetU: u, thinkAt: 0, knockUntil: 0, ks: 0, ku: 0, pushReadyAt: 2500 + random() * 2500,
      });
      this.ramp[e.id] = { best: s, crushedAt: null, crushes: 0, respawnS: s, finishedAt: null };
    }
  }

  get isFinished(): boolean { return this.finished; }

  setHumanPosition(id: string, x: number, z: number, y = 0): void {
    const c = this.climbers.get(id);
    if (!c || c.bot || this.finished) return;
    // après un écrasement, le joueur réapparaît plus bas : on cherche aussi de ce côté-là
    const here = locate(x, z, c.s), back = locate(x, z, this.ramp[id].respawnS);
    const err = (p: { s: number; u: number }) => { const q = rampPoint(p.s, p.u); return Math.hypot(q.x - x, q.z - z); };
    const p = err(back) < err(here) - 0.01 ? back : here;
    c.s = p.s; c.u = p.u; c.x = x; c.z = z;
    c.above = Math.max(0, y - rampHeight(p.s));
    this.progress(c);
  }

  remove(id: string): void { this.climbers.delete(id); delete this.ramp[id]; }

  position(id: string): Point | undefined { return this.climbers.get(id); }

  /** Un humain a poussé un bot : il glisse dans la direction de la poussée. */
  knock(id: string, dir: [number, number]): void {
    const c = this.climbers.get(id);
    if (!c?.bot || this.elapsed < c.crushedUntil) return;
    const p = rampPoint(c.s, c.u);
    c.ks = (dir[0] * p.t[0] + dir[1] * p.t[1]) * 6.5;
    c.ku = (dir[0] * p.n[0] + dir[1] * p.n[1]) * 6.5;
    c.knockUntil = this.elapsed + 320;
    c.anim = 'Hit_A';
  }

  step(dtMs: number): SimStep {
    if (this.finished) return { done: true, changed: false, hits: [] };
    this.elapsed += dtMs;
    this.changed = false; this.hits = [];
    const dt = dtMs / 1000;
    this.field.step(dtMs, this.elapsed, this.random);
    for (const c of this.climbers.values()) if (c.bot) this.moveBot(c, dt);
    for (const c of this.climbers.values()) this.checkCrush(c);

    const statuses = Object.values(this.ramp);
    const arrived = statuses.filter((s) => s.finishedAt !== null).length;
    const enough = statuses.length > 0 && arrived >= Math.min(BARRELS.finishers, statuses.length);
    if (enough || this.elapsed >= BARRELS.maxDurationMs) {
      this.finished = true;
      for (const c of this.climbers.values()) if (c.bot) c.anim = this.ramp[c.id].finishedAt !== null ? 'Cheer' : 'Idle';
    }
    return { done: this.finished, changed: this.changed, hits: this.hits };
  }

  /** Arrivée et point le plus haut atteint. */
  private progress(c: Climber): void {
    const st = this.ramp[c.id];
    if (!st || st.finishedAt !== null) return;
    if (c.s > st.best + 0.5) { st.best = Math.round(c.s * 10) / 10; this.changed = true; }
    if (c.s >= FINISH_S) { st.finishedAt = Math.round(this.elapsed); this.changed = true; }
  }

  private checkCrush(c: Climber): void {
    const st = this.ramp[c.id];
    if (!st || st.finishedAt !== null || this.elapsed < c.graceUntil) return;
    for (const b of this.field.barrels) {
      if (!barrelHits(b, c.x, c.z, c.above)) continue;
      st.crushedAt = Math.round(this.elapsed);
      st.crushes++;
      st.respawnS = respawnS(c.s);
      c.crushedUntil = this.elapsed + BARRELS.crushMs;
      c.graceUntil = c.crushedUntil + BARRELS.graceMs;
      c.knockUntil = 0; c.above = 0; c.vy = 0;
      if (c.bot) c.anim = 'Death_A';
      this.changed = true;
      return;
    }
  }

  private moveBot(c: Climber, dt: number): void {
    const st = this.ramp[c.id];
    if (this.elapsed < c.crushedUntil) return; // aplati
    if (st.crushedAt !== null && c.anim === 'Death_A') {
      // il se relève au début du tronçon
      c.s = st.respawnS; c.u = 0; c.targetU = 0; c.anim = 'Idle';
    }
    // saut
    if (c.above > 0 || c.vy > 0) {
      c.vy -= GRAVITY * dt; c.above += c.vy * dt;
      if (c.above <= 0) { c.above = 0; c.vy = 0; }
    }
    if (this.elapsed < c.knockUntil) {
      c.s += c.ks * dt; c.u = Math.max(-HALF, Math.min(HALF, c.u + c.ku * dt));
      this.place(c, 0, 0);
      return;
    }
    if (st.finishedAt !== null) {
      // arrivé : il avance au bout du palier et fête ça
      const lane = Number.isFinite(c.targetU) ? c.targetU : c.u;
      const goal = RAMP_LENGTH - 1.5 - (lane + HALF) * 0.6;
      const ds = Math.max(-1, Math.min(1, goal - c.s)) * BARRELS.botSpeed * 0.5 * dt;
      c.s += ds;
      c.anim = Math.abs(goal - c.s) > 0.2 ? 'Walking_A' : 'Cheer';
      this.place(c, ds, 0);
      return;
    }
    if (this.elapsed >= c.thinkAt) this.think(c);
    // avancer, et glisser vers l'écart choisi
    let speed: number = BARRELS.botSpeed;
    if (c.targetU === Infinity) speed = 0; // coincé : il attend que ça passe
    const du = c.targetU === Infinity ? 0 : Math.max(-1, Math.min(1, (c.targetU - c.u) / 0.3)) * 3.6 * dt;
    c.u = Math.max(-HALF, Math.min(HALF, c.u + du));
    c.s += speed * dt;
    c.anim = c.above > 0 ? 'Jump_Idle' : speed > 0 ? 'Running_A' : 'Idle';
    this.place(c, speed * dt, du);
    this.tryPush(c);
    this.progress(c);
  }

  /** Choisit où passer : l'écart le moins menacé par les tonneaux qui arrivent ; saute au besoin. */
  private think(c: Climber): void {
    c.thinkAt = this.elapsed + 140 + this.random() * 80;
    const options = [-1.6, 0, 1.6, c.u];
    const danger = options.map(() => 0);
    let soon = false;
    for (const b of this.field.barrels) {
      const gap = b.s - c.s;
      if (gap < -0.6 || gap > 14 || b.vs > 1) continue;
      const t = Math.max(0, gap) / Math.max(0.5, BARRELS.botSpeed - b.vs);
      if (t > 1.7) continue;
      // l'imposteur voit les trajectoires exactes (rebonds compris) ; les autres devinent
      let bu: number;
      if (c.imposter) {
        const path = predictBarrel(b, t + 0.05, 0.05);
        bu = path.length ? path[path.length - 1][1] : b.u;
      } else bu = b.u + b.vu * t + (this.random() - 0.5) * 1.6;
      options.forEach((o, k) => { danger[k] += Math.max(0, 1.35 - Math.abs(bu - o)) * (1.8 - t); });
      if (t < 0.38 && Math.abs(b.u - c.u) < 1.2) soon = true;
    }
    let best = 0;
    options.forEach((o, k) => { if (danger[k] < danger[best] - 1e-6 || (Math.abs(danger[k] - danger[best]) < 1e-6 && Math.abs(o - c.u) < Math.abs(options[best] - c.u))) best = k; });
    c.targetU = options[best];
    // rien de sûr et un tonneau tout près : on saute (les bots ratent parfois leur saut)
    if (soon && danger[best] > 0.3 && c.above === 0 && (c.imposter || this.random() < 0.65)) { c.vy = JUMP; c.above = 0.01; }
    // trop dangereux partout : on attend un peu au lieu de foncer dedans
    else if (danger[best] > 1.6 && !soon) c.targetU = Infinity;
  }

  /** De temps en temps, il pousse celui qui est juste devant ou à côté. */
  private tryPush(c: Climber): void {
    if (this.elapsed < c.pushReadyAt) return;
    for (const o of this.climbers.values()) {
      if (o === c || this.elapsed < o.crushedUntil || this.ramp[o.id]?.finishedAt !== null) continue;
      const dx = o.x - c.x, dz = o.z - c.z, d = Math.hypot(dx, dz);
      if (d > 1.3 || d < 1e-3) continue;
      c.pushReadyAt = this.elapsed + BARRELS.push.cooldownMs + 1500 + this.random() * 3000;
      if (this.random() < 0.45) return; // pas cette fois
      const dir: [number, number] = [dx / d, dz / d];
      c.anim = 'Unarmed_Melee_Attack_Punch_A';
      c.yaw = Math.atan2(dir[0], dir[1]);
      if (o.bot) this.knock(o.id, dir);
      this.hits.push({ from: c.id, to: o.id, kick: false, dir });
      return;
    }
  }

  /** Position dans le monde d'après (s, u), orientation selon le mouvement. */
  private place(c: Climber, ds: number, du: number): void {
    const p = rampPoint(c.s, c.u);
    c.x = p.x; c.z = p.z;
    const mx = p.t[0] * ds + p.n[0] * du, mz = p.t[1] * ds + p.n[1] * du;
    if (Math.hypot(mx, mz) > 1e-4) c.yaw = Math.atan2(mx, mz);
  }

  results(): MinigameResult[] {
    const order = [...this.climbers.values()].map((c) => {
      const st = this.ramp[c.id];
      // arrivés d'abord (par temps), puis les autres par hauteur atteinte
      const score = st.finishedAt !== null ? [0, st.finishedAt] : [1, -st.best];
      return { id: c.id, score, survivedMs: Math.round(st.finishedAt ?? this.elapsed) };
    }).sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1]);
    let rank = 0;
    return order.map((o, idx) => {
      if (idx === 0 || o.score[0] !== order[idx - 1].score[0] || o.score[1] !== order[idx - 1].score[1]) rank = idx + 1;
      return { id: o.id, rank, points: PLACE_POINTS[rank - 1] ?? 0, survivedMs: o.survivedMs };
    });
  }

  tick(): MinigameTick {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      t: Math.round(this.elapsed),
      sk: [],
      bots: [...this.climbers.values()].filter((c) => c.bot).map((c) => [c.id, r2(c.x), r2(c.z), r2(c.yaw), c.anim, r2(rampHeight(c.s) + c.above)]),
      br: this.field.barrels.map((b) => [b.id, r2(b.s), r2(b.u), r2(b.vs), r2(b.vu)]),
    };
  }
}
