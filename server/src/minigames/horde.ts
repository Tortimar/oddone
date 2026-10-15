import {
  HORDE, PLACE_POINTS, slashHits,
  type Hit, type HordeState, type MinigameAction, type MinigameResult, type MinigameTick, type Point,
} from '@oddone/shared';
import type { MinigameSim, SimEntrant, SimStep } from './types.ts';

/**
 * Simulation serveur de « La Horde de Gobelins ».
 * Le serveur fait apparaître les gobelins (les dorés surtout du côté de l'imposteur), les fait
 * foncer sur le joueur le plus proche et frapper au contact, juge les coups d'épée (portée,
 * angle, recharge) et compte les points. Les bots chassent les gobelins (de préférence dorés).
 */

interface Goblin extends Point {
  id: number;
  gold: boolean;
  yaw: number;
  anim: string;
  hitReadyAt: number;
  /** Il vient de frapper : il reste planté un instant. */
  busyUntil: number;
}

interface Fighter extends Point {
  id: string;
  bot: boolean;
  imposter: boolean;
  yaw: number;
  anim: string;
  slashReadyAt: number;
  /** Étourdi (coup de gobelin ou d'épée) jusqu'à… : ni pas ni coup (les bots glissent sous le recul). */
  stunUntil: number;
  kx: number;
  kz: number;
}

const R = HORDE.walkRadius;
const clampToClearing = (p: Point, r = R) => { const d = Math.hypot(p.x, p.z); if (d > r) { p.x *= r / d; p.z *= r / d; } };

export class HordeSim implements MinigameSim {
  elapsed = 0;
  readonly goblins: Goblin[] = [];
  readonly fighters = new Map<string, Fighter>();
  /** État public (référencé tel quel par `mg.horde`). */
  readonly state: HordeState = { points: {}, kills: {}, events: [] };
  readonly maxMs = HORDE.durationMs;
  private nextId = 1;
  private untilSpawn = 200;
  private finished = false;
  private changed = false;
  private hits: Hit[] = [];

  constructor(entrants: SimEntrant[], private random: () => number = Math.random) {
    for (const e of entrants) {
      this.fighters.set(e.id, {
        id: e.id, bot: e.bot, imposter: e.imposter, x: e.start[0], z: e.start[1], yaw: Math.atan2(e.start[0], e.start[1]), anim: 'Idle',
        slashReadyAt: 0, stunUntil: -1e9, kx: 0, kz: 0,
      });
      this.state.points[e.id] = 0;
      this.state.kills[e.id] = [0, 0];
    }
  }

  get isFinished(): boolean { return this.finished; }

  setHumanPosition(id: string, x: number, z: number, _y = 0, yaw?: number): void {
    const f = this.fighters.get(id);
    if (!f || f.bot) return;
    f.x = x; f.z = z;
    if (typeof yaw === 'number' && Number.isFinite(yaw)) f.yaw = yaw;
  }

  remove(id: string): void { this.fighters.delete(id); }

  position(id: string): Point | undefined { return this.fighters.get(id); }

  /** Un humain a poussé un bot (sur le podium seulement : pendant la partie on frappe les gobelins). */
  knock(id: string, dir: [number, number]): void {
    const f = this.fighters.get(id);
    if (!f?.bot) return;
    f.kx = dir[0] * 6; f.kz = dir[1] * 6; f.stunUntil = this.elapsed + 400; f.anim = 'Hit_A';
  }

  /** Coup d'épée d'un joueur : le serveur vérifie la recharge et qui est touché. */
  action(id: string, kind: MinigameAction): boolean {
    if (kind !== 'slash' || this.finished) return false;
    const f = this.fighters.get(id);
    if (!f || f.bot || this.elapsed < f.stunUntil) return false;
    return this.slash(f);
  }

  private slash(f: Fighter): boolean {
    if (this.elapsed < f.slashReadyAt) return false;
    f.slashReadyAt = this.elapsed + HORDE.slash.cooldownMs;
    let killed = false;
    for (let i = this.goblins.length - 1; i >= 0; i--) {
      const g = this.goblins[i];
      if (!slashHits(f.x, f.z, f.yaw, g.x, g.z)) continue;
      this.goblins.splice(i, 1);
      const pts = g.gold ? HORDE.points.gold : HORDE.points.normal;
      this.state.points[f.id] = (this.state.points[f.id] ?? 0) + pts;
      const k = this.state.kills[f.id] ?? [0, 0];
      k[g.gold ? 1 : 0]++;
      this.state.kills[f.id] = k;
      this.state.events.push({ at: Math.round(this.elapsed), by: f.id, goblin: g.id, gold: g.gold, x: round(g.x), z: round(g.z) });
      killed = true;
    }
    // les autres joueurs aussi : pas de point, mais étourdis
    for (const o of this.fighters.values()) {
      if (o === f || !this.stunnable(o) || !slashHits(f.x, f.z, f.yaw, o.x, o.z)) continue;
      const dx = o.x - f.x, dz = o.z - f.z, d = Math.hypot(dx, dz) || 1;
      this.stun(o, [dx / d, dz / d], f.id);
    }
    if (this.state.events.length > 24) this.state.events.splice(0, this.state.events.length - 24);
    if (killed) this.changed = true;
    return killed;
  }

  step(dtMs: number): SimStep {
    if (this.finished) return { done: true, changed: false, hits: [] };
    this.elapsed += dtMs;
    this.changed = false; // (les coups reçus depuis le dernier pas, même via `action`, partent avec ce pas)
    const dt = dtMs / 1000;
    this.spawn(dtMs);
    for (const f of this.fighters.values()) if (f.bot) this.moveBot(f, dt);
    this.moveGoblins(dt);
    if (this.elapsed >= HORDE.durationMs) {
      this.finished = true;
      for (const f of this.fighters.values()) if (f.bot) f.anim = 'Idle';
      for (const g of this.goblins) g.anim = 'Idle';
    }
    const hits = this.hits; this.hits = [];
    return { done: this.finished, changed: this.changed, hits };
  }

  /** Apparitions : de plus en plus souvent ; une partie du côté de l'imposteur, riche en dorés. */
  private spawn(dtMs: number): void {
    this.untilSpawn -= dtMs;
    if (this.untilSpawn > 0 || this.goblins.length >= HORDE.maxGoblins) return;
    const k = Math.min(1, this.elapsed / HORDE.durationMs);
    const [slow, fast] = HORDE.spawnMs;
    this.untilSpawn = (slow + (fast - slow) * k) * (0.7 + this.random() * 0.6);
    const imp = [...this.fighters.values()].find((f) => f.imposter);
    let angle = this.random() * Math.PI * 2, gold: boolean;
    if (imp && Math.hypot(imp.x, imp.z) > 1.5 && this.random() < HORDE.imposterSideShare) {
      // du côté de l'imposteur : beaucoup de dorés
      angle = Math.atan2(imp.x, imp.z) + (this.random() * 2 - 1) * HORDE.imposterSideSpread;
      gold = this.random() < HORDE.goldChanceImposter;
    } else gold = this.random() < HORDE.goldChance;
    const r = HORDE.spawnRadius;
    this.goblins.push({ id: this.nextId++, gold, x: Math.sin(angle) * r, z: Math.cos(angle) * r, yaw: angle + Math.PI, anim: 'Running_A', hitReadyAt: 0, busyUntil: 0 });
  }

  /** Chaque gobelin fonce sur le joueur le plus proche et frappe au contact. */
  private moveGoblins(dt: number): void {
    const targets = [...this.fighters.values()];
    for (const g of this.goblins) {
      if (this.elapsed < g.busyUntil) continue;
      let best: Fighter | null = null, bestD = Infinity;
      for (const f of targets) { const d = Math.hypot(f.x - g.x, f.z - g.z); if (d < bestD) { bestD = d; best = f; } }
      if (!best) { g.anim = 'Idle'; continue; }
      const dx = best.x - g.x, dz = best.z - g.z;
      g.yaw = Math.atan2(dx, dz);
      if (bestD <= HORDE.goblinReach) {
        g.anim = 'Idle';
        if (this.elapsed >= g.hitReadyAt && this.stunnable(best)) {
          g.hitReadyAt = this.elapsed + HORDE.goblinHitCooldownMs;
          g.busyUntil = this.elapsed + 450;
          g.anim = '1H_Melee_Attack_Chop';
          this.stun(best, [dx / (bestD || 1), dz / (bestD || 1)], `gob-${g.id}`);
        }
        continue;
      }
      const speed = g.gold ? HORDE.goldSpeed : HORDE.goblinSpeed;
      g.x += (dx / bestD) * speed * dt; g.z += (dz / bestD) * speed * dt;
      g.anim = 'Running_A';
    }
    // ils ne se marchent pas dessus
    for (let i = 0; i < this.goblins.length; i++) {
      for (let j = i + 1; j < this.goblins.length; j++) {
        const a = this.goblins[i], b = this.goblins[j];
        const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
        if (d >= 0.8 || d < 1e-4) continue;
        const push = (0.8 - d) / 2;
        a.x -= (dx / d) * push; a.z -= (dz / d) * push;
        b.x += (dx / d) * push; b.z += (dz / d) * push;
      }
    }
  }

  /** Peut-on l'étourdir ? (pas pendant un étourdissement ni juste après) */
  private stunnable(f: Fighter): boolean { return this.elapsed >= f.stunUntil + HORDE.stunGraceMs; }

  /** Étourdi : une seconde sans bouger ni frapper (les bots reculent un peu, les humains gèrent le recul chez eux). */
  private stun(f: Fighter, dir: [number, number], from: string): void {
    f.stunUntil = this.elapsed + HORDE.stunMs;
    if (f.bot) { f.kx = dir[0] * 6; f.kz = dir[1] * 6; f.anim = 'Hit_A'; }
    this.hits.push({ from, to: f.id, kick: false, dir });
  }

  /** Bot : va vers le gobelin le plus intéressant (les dorés comptent double… de distance en moins) et frappe. */
  private moveBot(f: Fighter, dt: number): void {
    if (this.elapsed < f.stunUntil) {
      f.x += f.kx * dt; f.z += f.kz * dt; f.kx *= 0.9; f.kz *= 0.9;
      clampToClearing(f);
      if (this.elapsed > f.stunUntil - HORDE.stunMs + 600) f.anim = 'Idle'; // la tête qui tourne
      return;
    }
    // de temps en temps, un bot étourdit un joueur trop près de lui (pas d'amis dans la Horde)
    for (const o of this.fighters.values()) {
      if (o === f || !this.stunnable(o) || this.elapsed < f.slashReadyAt) continue;
      if (Math.hypot(o.x - f.x, o.z - f.z) < HORDE.slash.reach * 0.6 && this.random() < 0.01) {
        f.yaw = Math.atan2(o.x - f.x, o.z - f.z);
        f.anim = '1H_Melee_Attack_Slice_Horizontal';
        this.slash(f);
        f.slashReadyAt = Math.max(f.slashReadyAt, this.elapsed + 550);
        return;
      }
    }
    let best: Goblin | null = null, bestScore = Infinity;
    for (const g of this.goblins) {
      const d = Math.hypot(g.x - f.x, g.z - f.z);
      // les gobelins encore dans les arbres comptent moins (ils vont venir)
      const score = d / (g.gold ? 2.2 : 1) + (Math.hypot(g.x, g.z) > R ? 3 : 0);
      if (score < bestScore) { bestScore = score; best = g; }
    }
    if (!best) {
      // personne : il revient vers le milieu
      const d = Math.hypot(f.x, f.z);
      if (d > 2) { f.x -= (f.x / d) * HORDE.botSpeed * 0.5 * dt; f.z -= (f.z / d) * HORDE.botSpeed * 0.5 * dt; f.anim = 'Running_A'; f.yaw = Math.atan2(-f.x, -f.z); }
      else f.anim = 'Idle';
      return;
    }
    const dx = best.x - f.x, dz = best.z - f.z, d = Math.hypot(dx, dz);
    f.yaw = Math.atan2(dx, dz);
    if (d < HORDE.slash.reach * 0.75) {
      // il frappe (avec un temps de réaction : les bots ne sont pas des machines)
      if (this.elapsed >= f.slashReadyAt && this.random() < 0.2) {
        f.anim = this.random() < 0.5 ? '1H_Melee_Attack_Slice_Horizontal' : '1H_Melee_Attack_Chop';
        this.slash(f);
        f.slashReadyAt = Math.max(f.slashReadyAt, this.elapsed + 550);
      }
      return;
    }
    const step = Math.min(d - 1, HORDE.botSpeed * dt);
    f.x += (dx / d) * step; f.z += (dz / d) * step;
    clampToClearing(f);
    if (f.anim.startsWith('1H_') && this.elapsed < f.slashReadyAt - 150) return; // finir le geste
    f.anim = 'Running_A';
  }

  results(): MinigameResult[] {
    const order = [...this.fighters.values()].map((f) => ({ id: f.id, pts: this.state.points[f.id] ?? 0 })).sort((a, b) => b.pts - a.pts);
    let rank = 0;
    return order.map((o, i) => {
      if (i === 0 || o.pts !== order[i - 1].pts) rank = i + 1;
      // survivedMs porte les points de la partie (affichés sur le classement)
      return { id: o.id, rank, points: PLACE_POINTS[rank - 1] ?? 0, survivedMs: o.pts };
    });
  }

  tick(): MinigameTick {
    return {
      t: Math.round(this.elapsed),
      sk: [],
      bots: [...this.fighters.values()].filter((f) => f.bot).map((f) => [f.id, round(f.x), round(f.z), round(f.yaw), f.anim]),
      gb: this.goblins.map((g) => [g.id, round(g.x), round(g.z), round(g.yaw), g.anim, g.gold ? 1 : 0]),
    };
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
