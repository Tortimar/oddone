import {
  CHESTS, PLACE_POINTS, chestFront, chestSpot, nearestChest,
  type ChestSecret, type ChestsState, type MinigameAction, type MinigameResult, type MinigameTick, type Point,
} from '@oddone/shared';
import type { MinigameSim, SimEntrant, SimStep } from './types.ts';

/**
 * Simulation serveur des « Coffres Piégés ».
 * Le serveur tient les manches et les tours, cache la mimique, juge les ouvertures et les
 * inspections (à portée, à son tour), et n'envoie le résultat d'une inspection qu'à l'imposteur,
 * une seule fois dans la partie (`secrets`). Les bots jouent leur tour eux-mêmes.
 */

interface Seat extends Point {
  id: string;
  bot: boolean;
  imposter: boolean;
  home: [number, number];
  yaw: number;
  anim: string;
}

/** Ce qu'un bot a prévu de faire pendant son tour. */
interface BotPlan {
  stage: 'think' | 'walk' | 'inspect' | 'wait' | 'done';
  until: number;
  chest: number;
  /** Va-t-il inspecter (pour de vrai s'il est l'imposteur, sinon pour faire semblant) ? */
  inspect: boolean;
}

export class ChestsSim implements MinigameSim {
  elapsed = 0;
  readonly maxMs = 20 * 60_000;
  readonly seats = new Map<string, Seat>();
  readonly state: ChestsState;
  private mimic = 0;
  private finished = false;
  private changed = false;
  /** L'imposteur a déjà utilisé sa vraie inspection. */
  private inspectUsed = false;
  private inspectedThisTurn = false;
  private plan: BotPlan | null = null;
  /** Ce que l'imposteur (bot) sait de la manche en cours. */
  private botKnows: ChestSecret | null = null;
  private outbox: { to: string; data: ChestSecret }[] = [];

  constructor(entrants: SimEntrant[], private random: () => number = Math.random) {
    for (const e of entrants) {
      this.seats.set(e.id, { id: e.id, bot: e.bot, imposter: e.imposter, home: [e.start[0], e.start[1]], x: e.start[0], z: e.start[1], yaw: Math.atan2(-e.start[0], -e.start[1]), anim: 'Idle' });
    }
    // ordre de jeu tiré au sort
    const order = entrants.map((e) => e.id);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    this.state = {
      round: 0, count: 0, alive: order, out: [], outRound: {}, turn: null, stage: 'intro',
      stageAt: 0, stageEndsAt: 0, opened: [], opening: null, inspecting: null,
    };
    this.startRound(0);
  }

  get isFinished(): boolean { return this.finished; }

  /** Nouvelle manche : un coffre de plus que de joueurs en lice, la mimique tirée au sort. */
  private startRound(first: number): void {
    const s = this.state;
    s.count = s.alive.length + 1;
    this.mimic = Math.floor(this.random() * s.count);
    s.opened = []; s.opening = null; s.inspecting = null;
    s.turn = s.alive[first % s.alive.length] ?? null;
    this.setStage('intro', CHESTS.introMs);
    for (const p of this.seats.values()) if (p.bot) this.goHome(p);
    this.plan = null;
    this.changed = true;
  }

  private setStage(stage: ChestsState['stage'], ms: number): void {
    const s = this.state;
    s.stage = stage; s.stageAt = Math.round(this.elapsed); s.stageEndsAt = Math.round(this.elapsed + ms);
    this.changed = true;
  }

  private goHome(p: Seat): void {
    p.x = p.home[0]; p.z = p.home[1];
    p.yaw = Math.atan2(-p.x, -p.z);
    p.anim = this.state.out.includes(p.id) ? 'Sit_Floor_Idle' : 'Idle'; // éliminé : assis par terre, il regarde
  }

  setHumanPosition(id: string, x: number, z: number, _y = 0, yaw?: number): void {
    const p = this.seats.get(id);
    if (!p || p.bot) return;
    p.x = x; p.z = z;
    if (typeof yaw === 'number' && Number.isFinite(yaw)) p.yaw = yaw;
  }

  position(id: string): Point | undefined { return this.seats.get(id); }

  remove(id: string): void {
    const s = this.state;
    this.seats.delete(id);
    const i = s.alive.indexOf(id);
    if (i < 0) return;
    const wasTurn = s.turn === id;
    s.alive.splice(i, 1);
    this.changed = true;
    if (s.alive.length <= 1) { this.finish(); return; }
    if (!wasTurn) return;
    if (s.stage === 'turn' || s.stage === 'intro') {
      s.inspecting = null;
      s.turn = s.alive[i % s.alive.length];
      this.beginTurn();
    }
  }

  /** E (ouvrir) ou R (inspecter) d'un humain : à son tour, devant un coffre fermé. */
  action(id: string, kind: MinigameAction): boolean {
    const p = this.seats.get(id);
    if (!p || p.bot || this.finished) return false;
    if (kind === 'open') return this.open(p);
    if (kind === 'inspect') return this.inspect(p);
    return false;
  }

  private canAct(p: Seat): boolean {
    const s = this.state;
    return s.stage === 'turn' && s.turn === p.id && !s.inspecting;
  }

  private open(p: Seat, chest = nearestChest(p.x, p.z, this.state.count, this.state.opened)): boolean {
    const s = this.state;
    if (!this.canAct(p) || chest < 0 || s.opened.includes(chest)) return false;
    const mimic = chest === this.mimic;
    s.opening = { by: p.id, chest, mimic };
    this.setStage('opening', CHESTS.openMs + (mimic ? 0 : CHESTS.safeMs));
    if (p.bot) { const [cx, cz] = chestSpot(chest, s.count); p.yaw = Math.atan2(cx - p.x, cz - p.z); p.anim = 'Interact'; }
    return true;
  }

  private inspect(p: Seat, chest = nearestChest(p.x, p.z, this.state.count, this.state.opened)): boolean {
    const s = this.state;
    if (!this.canAct(p) || this.inspectedThisTurn || chest < 0) return false;
    this.inspectedThisTurn = true;
    s.inspecting = { by: p.id, chest, at: Math.round(this.elapsed) };
    // le tour ne file pas pendant qu'on est penché sur le coffre
    s.stageEndsAt += CHESTS.inspectMs;
    if (p.bot) { const [cx, cz] = chestSpot(chest, s.count); p.yaw = Math.atan2(cx - p.x, cz - p.z); p.anim = 'PickUp'; }
    this.changed = true;
    return true;
  }

  /** Fin d'une inspection : l'imposteur seul apprend ce qu'il y a dedans (une fois dans la partie). */
  private finishInspect(): void {
    const s = this.state, insp = s.inspecting!;
    s.inspecting = null;
    this.changed = true;
    const p = this.seats.get(insp.by);
    if (!p) return;
    if (p.bot) p.anim = 'Idle';
    if (!p.imposter || this.inspectUsed) return;
    this.inspectUsed = true;
    const secret: ChestSecret = { round: s.round, chest: insp.chest, mimic: insp.chest === this.mimic };
    if (p.bot) this.botKnows = secret;
    else this.outbox.push({ to: p.id, data: secret });
  }

  /** Les secrets à envoyer (vidés à chaque appel). */
  secrets(): { to: string; data: ChestSecret }[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  private beginTurn(): void {
    this.inspectedThisTurn = false;
    this.plan = null;
    this.setStage('turn', CHESTS.turnMs);
  }

  private nextTurn(): void {
    const s = this.state;
    const prev = s.turn ? this.seats.get(s.turn) : undefined;
    if (prev?.bot) this.goHome(prev);
    const i = s.turn ? s.alive.indexOf(s.turn) : -1;
    s.turn = s.alive[(i + 1) % s.alive.length];
    this.beginTurn();
  }

  step(dtMs: number): SimStep {
    if (this.finished) return { done: true, changed: false, hits: [] };
    this.elapsed += dtMs;
    this.changed = false;
    const s = this.state;
    switch (s.stage) {
      case 'intro':
        if (this.elapsed >= s.stageEndsAt) this.beginTurn();
        break;
      case 'turn': {
        if (s.inspecting && this.elapsed >= s.inspecting.at + CHESTS.inspectMs) this.finishInspect();
        const p = s.turn ? this.seats.get(s.turn) : undefined;
        if (p?.bot) this.botTurn(p, dtMs / 1000);
        if (s.stage === 'turn' && !s.inspecting && this.elapsed >= s.stageEndsAt && p) {
          // trop long : le donjon s'impatiente et ouvre un coffre au hasard
          const closed = [...Array(s.count).keys()].filter((k) => !s.opened.includes(k));
          this.open(p, closed[Math.floor(this.random() * closed.length)]);
        }
        break;
      }
      case 'opening': {
        // le couvercle s'ouvre : le bot réagit (il tombe sous la morsure, ou il se réjouit)
        const o = s.opening, p = o ? this.seats.get(o.by) : undefined;
        if (o && p?.bot && this.elapsed >= s.stageAt + CHESTS.revealMs && p.anim === 'Interact') p.anim = o.mimic ? 'Death_A' : 'Cheer';
        if (this.elapsed >= s.stageEndsAt) this.resolveOpening();
        break;
      }
      case 'out':
        if (this.elapsed >= s.stageEndsAt) {
          if (s.alive.length <= 1) this.finish();
          else { s.round += 1; this.botKnows = null; this.startRound(this.nextFirst); }
        }
        break;
      case 'done':
        break;
    }
    return { done: this.finished, changed: this.changed, hits: [] };
  }

  /** Qui commence la manche suivante : celui qui jouait après l'éliminé. */
  private nextFirst = 0;

  private resolveOpening(): void {
    const s = this.state, o = s.opening!;
    s.opening = null;
    if (!o.mimic) {
      s.opened.push(o.chest);
      const p = this.seats.get(o.by);
      if (p?.bot) p.anim = 'Idle';
      if (s.alive.length <= 1) { this.finish(); return; }
      this.nextTurn();
      return;
    }
    // la mimique a mordu : éliminé
    const i = s.alive.indexOf(o.by);
    if (i >= 0) {
      s.alive.splice(i, 1);
      s.out.push(o.by);
      s.outRound[o.by] = s.round;
      this.nextFirst = i; // le suivant prend sa place dans l'ordre
    }
    const p = this.seats.get(o.by);
    if (p?.bot) p.anim = 'Death_A';
    s.opened.push(o.chest);
    s.turn = null;
    this.setStage('out', CHESTS.outMs);
  }

  private finish(): void {
    this.finished = true;
    const s = this.state;
    s.turn = null; s.opening = null; s.inspecting = null;
    this.setStage('done', 0);
    for (const p of this.seats.values()) if (p.bot) { this.goHome(p); p.anim = s.alive.includes(p.id) ? 'Cheer' : 'Sit_Floor_Idle'; }
  }

  /* ================= Bots ================= */

  private botTurn(p: Seat, dt: number): void {
    const s = this.state;
    const closed = [...Array(s.count).keys()].filter((k) => !s.opened.includes(k));
    if (!closed.length) return;
    const knows = this.botKnows?.round === s.round ? this.botKnows : null;
    const pick = (): number => {
      let options = closed;
      if (knows) {
        if (!knows.mimic && closed.includes(knows.chest)) return knows.chest; // il sait qu'il est sans danger
        if (knows.mimic && closed.length > 1) options = closed.filter((k) => k !== knows.chest);
      }
      return options[Math.floor(this.random() * options.length)];
    };
    if (!this.plan) {
      const real = p.imposter && !this.inspectUsed && closed.length >= 3 && this.random() < 0.7;
      this.plan = { stage: 'think', until: this.elapsed + 600 + this.random() * 900, chest: pick(), inspect: real || this.random() < 0.3 };
      p.anim = 'Idle';
      return;
    }
    const plan = this.plan;
    switch (plan.stage) {
      case 'think':
        if (this.elapsed >= plan.until) plan.stage = 'walk';
        break;
      case 'walk': {
        const [tx, tz] = chestFront(plan.chest, s.count);
        const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
        if (d > 0.08) {
          const stepLen = Math.min(d, CHESTS.botSpeed * dt);
          p.x += (dx / d) * stepLen; p.z += (dz / d) * stepLen;
          p.yaw = Math.atan2(dx, dz); p.anim = 'Walking_A';
          break;
        }
        if (plan.inspect) {
          plan.inspect = false;
          if (this.inspect(p, plan.chest)) { plan.stage = 'inspect'; break; }
        }
        plan.stage = 'wait'; plan.until = this.elapsed + 300 + this.random() * 700;
        p.anim = 'Idle';
        break;
      }
      case 'inspect':
        if (s.inspecting) break;
        // ce qu'il vient d'apprendre (imposteur) ou un petit doute pour faire comme les autres
        {
          const now = this.botKnows?.round === s.round ? this.botKnows : null;
          const other = now?.mimic && now.chest === plan.chest ? pick() : plan.chest;
          plan.stage = other !== plan.chest ? 'walk' : 'wait';
          plan.chest = other;
          plan.until = this.elapsed + 400 + this.random() * 600;
        }
        break;
      case 'wait':
        if (this.elapsed >= plan.until) { plan.stage = 'done'; this.open(p, plan.chest); }
        break;
      case 'done':
        break;
    }
  }

  results(): MinigameResult[] {
    const s = this.state;
    // les survivants d'abord (ex aequo si la partie a été coupée), puis du dernier au premier éliminé
    const res: MinigameResult[] = s.alive.map((id) => ({ id, rank: 1, points: PLACE_POINTS[0], survivedMs: 0 }));
    let rank = s.alive.length;
    for (const id of [...s.out].reverse()) {
      rank += 1;
      res.push({ id, rank, points: PLACE_POINTS[rank - 1] ?? 0, survivedMs: 0 });
    }
    return res.filter((r) => this.seats.has(r.id));
  }

  tick(): MinigameTick {
    return {
      t: Math.round(this.elapsed),
      sk: [],
      bots: [...this.seats.values()].filter((p) => p.bot).map((p) => [p.id, round(p.x), round(p.z), round(p.yaw), p.anim]),
    };
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
