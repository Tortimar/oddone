import {
  GORGON, PLACE_POINTS, coverBox, gorgonSees, pushOut,
  type Box, type GorgonField, type GorgonSecret, type GorgonState, type MinigameResult, type MinigameTick, type Point,
} from '@oddone/shared';
import type { MinigameSim, SimEntrant, SimStep } from './types.ts';

/**
 * Simulation serveur du « Regard de la Gorgone ».
 * Le serveur tient le cycle du regard (de dos, elle se retourne, elle regarde), note où est chacun
 * quand elle a fini de se retourner (plus un court délai), et pétrifie qui s'en éloigne pendant
 * qu'elle regarde… s'il est en vue (tombes, statues et autres joueurs cachent). Les humains se
 * déplacent chez eux ; les bots courent quand elle est de dos et s'arrêtent avec un temps de
 * réaction (trop lent : pétrifié). Le bot imposteur s'arrête juste avant qu'elle se retourne.
 */

interface Runner extends Point {
  id: string;
  bot: boolean;
  imposter: boolean;
  yaw: number;
  anim: string;
  state: 'run' | 'done' | 'stone';
  /** Position quand le regard a commencé à compter (null : pas de regard en cours). */
  anchor: Point | null;
  /** Bots : s'arrêtent à partir de… (ms de jeu) ; couloir visé (x). */
  stopAt: number;
  laneX: number;
  /** Poussé : glisse (bots). */
  kx: number;
  kz: number;
  /** Bots : bloqués depuis… (ms), et où on en était. */
  stuckMs: number;
  lastZ: number;
}

const round = (n: number) => Math.round(n * 100) / 100;
const R = GORGON.playerR;

export class GorgonSim implements MinigameSim {
  elapsed = 0;
  /** État public (référencé tel quel par `mg.gorgon`). */
  readonly state: GorgonState = { stage: 'back', stageAt: 0, finished: [], petrified: [], stone: {} };
  readonly maxMs = GORGON.maxMs;
  readonly runners = new Map<string, Runner>();
  private boxes: Box[];
  private bounds = { halfX: GORGON.bounds.halfX, halfZ: GORGON.bounds.halfZ };
  private stageEnd = 0;
  /** Le regard compte à partir de… (fin du demi-tour + délai de grâce). */
  private judgeAt = Infinity;
  private pending: { to: string; data: GorgonSecret }[] = [];
  private finished = false;
  private endAt = Infinity;
  private changed = false;

  constructor(private field: GorgonField, entrants: SimEntrant[], private random: () => number = Math.random) {
    this.boxes = field.covers.map(coverBox);
    for (const e of entrants) {
      this.runners.set(e.id, {
        id: e.id, bot: e.bot, imposter: e.imposter, x: e.start[0], z: e.start[1], yaw: Math.PI, anim: 'Idle',
        state: 'run', anchor: null, stopAt: Infinity, laneX: e.start[0], kx: 0, kz: 0, stuckMs: 0, lastZ: e.start[1],
      });
    }
    this.enterBack();
  }

  get isFinished(): boolean { return this.finished; }

  private rand([a, b]: readonly [number, number]): number { return a + this.random() * (b - a); }

  /** De dos : on peut avancer. Les bots repartent ; l'imposteur apprend quand elle se retournera. */
  private enterBack(): void {
    const s = this.state;
    s.stage = 'back'; s.stageAt = Math.round(this.elapsed);
    this.stageEnd = this.elapsed + this.rand(GORGON.backMs);
    this.judgeAt = Infinity;
    for (const r of this.runners.values()) {
      r.anchor = null;
      if (!r.bot) continue;
      // un bot réagit avec un temps de réaction ; l'imposteur s'arrête juste avant
      r.stopAt = r.imposter ? this.stageEnd - 120
        : this.stageEnd + this.rand(this.random() < GORGON.botLateChance ? GORGON.botLateMs : GORGON.botReactMs);
    }
    for (const r of this.runners.values()) if (r.imposter && r.state === 'run') this.pending.push({ to: r.id, data: { turnAt: Math.round(this.stageEnd) } });
  }

  setHumanPosition(id: string, x: number, z: number, _y = 0, yaw?: number): void {
    const r = this.runners.get(id);
    if (!r || r.bot || r.state === 'stone') return;
    r.x = x; r.z = z;
    if (typeof yaw === 'number' && Number.isFinite(yaw)) r.yaw = yaw;
  }

  remove(id: string): void { this.runners.delete(id); this.changed = true; }

  position(id: string): Point | undefined { return this.runners.get(id); }

  /** Un humain a poussé un bot : il glisse (et s'il glisse pendant qu'elle regarde…). */
  knock(id: string, dir: [number, number]): void {
    const r = this.runners.get(id);
    if (!r?.bot || r.state !== 'run') return;
    r.kx = dir[0] * 7; r.kz = dir[1] * 7; r.anim = 'Hit_A';
  }

  secrets(): { to: string; data: GorgonSecret }[] { const p = this.pending; this.pending = []; return p; }

  step(dtMs: number): SimStep {
    if (this.finished) return { done: true, changed: false, hits: [] };
    this.elapsed += dtMs;
    this.changed = false;
    const s = this.state, dt = dtMs / 1000;

    // le cycle du regard
    if (this.elapsed >= this.stageEnd) {
      if (s.stage === 'back') {
        s.stage = 'turning'; s.stageAt = Math.round(this.elapsed);
        this.stageEnd = this.elapsed + GORGON.turnMs;
      } else if (s.stage === 'turning') {
        s.stage = 'watch'; s.stageAt = Math.round(this.elapsed);
        this.stageEnd = this.elapsed + this.rand(GORGON.watchMs);
        this.judgeAt = this.elapsed + GORGON.graceMs;
      } else this.enterBack();
      this.changed = true;
    }
    for (const r of this.runners.values()) if (r.bot && r.state === 'run') this.moveBot(r, dt);

    // qui bouge pendant qu'elle regarde (et qu'elle voit) est pétrifié
    if (s.stage === 'watch' && this.elapsed >= this.judgeAt) {
      for (const r of this.runners.values()) {
        if (r.state !== 'run') continue;
        if (!r.anchor) { r.anchor = { x: r.x, z: r.z }; continue; }
        if (Math.hypot(r.x - r.anchor.x, r.z - r.anchor.z) <= GORGON.moveTolerance) continue;
        if (!gorgonSees(r, this.field.covers, this.others(r))) { r.anchor = { x: r.x, z: r.z }; continue; } // caché : il peut bouger
        this.petrify(r);
      }
    }
    // l'arrivée
    for (const r of this.runners.values()) {
      if (r.state !== 'run' || r.z > GORGON.finishZ) continue;
      r.state = 'done'; r.anim = 'Cheer';
      s.finished.push(r.id);
      this.changed = true;
    }
    // plus personne en course : on laisse deux secondes pour voir la dernière statue (ou la dernière arrivée)
    if (![...this.runners.values()].some((r) => r.state === 'run') && this.endAt === Infinity) this.endAt = this.elapsed + 2000;
    if (this.elapsed >= this.endAt || this.elapsed >= GORGON.maxMs) this.finished = true;
    return { done: this.finished, changed: this.changed, hits: [] };
  }

  /** Ce qui peut cacher un joueur : les autres encore sur le terrain (en course ou statues), pas les arrivés. */
  private others(me: Runner): Point[] {
    return [...this.runners.values()].filter((o) => o !== me && o.state !== 'done');
  }

  private petrify(r: Runner): void {
    r.state = 'stone'; r.anim = 'Idle';
    r.kx = r.kz = 0;
    this.state.petrified.push(r.id);
    this.state.stone[r.id] = [round(r.x), round(r.z), round(r.yaw)];
    this.changed = true;
  }

  /** Bots : vers l'arrivée en contournant les tombes, arrêt avec un temps de réaction. */
  private moveBot(b: Runner, dt: number): void {
    // poussé : il glisse
    if (Math.abs(b.kx) + Math.abs(b.kz) > 0.05) {
      b.x += b.kx * dt; b.z += b.kz * dt;
      const k = Math.exp(-5 * dt); b.kx *= k; b.kz *= k;
      this.collide(b);
      return;
    }
    // (il court jusqu'à son arrêt : un peu après qu'elle s'est retournée, ou juste avant pour l'imposteur)
    const moving = this.elapsed < b.stopAt;
    if (!moving) { b.anim = 'Idle'; return; }
    // une tombe droit devant : on change de couloir pour la contourner
    const ahead = this.boxes.find((bx) => b.z - bx.z1 > -0.2 && b.z - bx.z1 < 2.4 && b.laneX > bx.x0 - 0.7 && b.laneX < bx.x1 + 0.7);
    if (ahead) {
      const left = ahead.x0 - 0.9, right = ahead.x1 + 0.9;
      b.laneX = Math.abs(b.x - left) < Math.abs(b.x - right) && left > -this.bounds.halfX + 0.6 ? left : right < this.bounds.halfX - 0.6 ? right : left;
    }
    // n'avance plus (coincé contre une tombe) : on tente un autre couloir
    if (b.lastZ - b.z < 0.02) b.stuckMs += dt * 1000; else b.stuckMs = 0;
    b.lastZ = b.z;
    if (b.stuckMs > 500) {
      const hx = this.bounds.halfX - 0.8;
      b.laneX = Math.max(-hx, Math.min(hx, b.x + (this.random() < 0.5 ? -1 : 1) * (2 + this.random() * 2)));
      b.stuckMs = 0;
    }
    const tx = b.laneX - b.x, tz = -2.5, d = Math.hypot(tx, tz);
    b.x += (tx / d) * GORGON.botSpeed * dt; b.z += (tz / d) * GORGON.botSpeed * dt;
    b.yaw = Math.atan2(tx, tz);
    b.anim = 'Running_A';
    this.collide(b);
  }

  private collide(b: Runner): void {
    const statues = [...this.runners.values()].filter((o) => o !== b && o.state === 'stone').map((o) => ({ x: o.x, z: o.z, r: R }));
    pushOut(b, this.bounds, this.boxes, statues, R);
  }

  /* ================= Fin ================= */

  /** Arrivés dans l'ordre, puis ceux qui couraient encore (du plus proche de l'arrivée), puis les pétrifiés du dernier au premier. */
  results(): MinigameResult[] {
    const s = this.state, order: string[] = [...s.finished];
    const running = [...this.runners.values()].filter((r) => r.state === 'run').sort((a, b) => a.z - b.z).map((r) => r.id);
    order.push(...running, ...[...s.petrified].reverse());
    return order.filter((id) => this.runners.has(id)).map((id, i) => ({ id, rank: i + 1, points: PLACE_POINTS[i] ?? 0, survivedMs: Math.round(this.elapsed) }));
  }

  tick(): MinigameTick {
    return {
      t: Math.round(this.elapsed),
      sk: [],
      bots: [...this.runners.values()].filter((r) => r.bot).map((r) => [r.id, round(r.x), round(r.z), round(r.yaw), r.anim]),
    };
  }
}
