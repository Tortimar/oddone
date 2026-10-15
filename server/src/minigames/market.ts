import {
  INGREDIENTS, MARKET, MARKET_CIRCLES, PLACE_POINTS, STALLS, nearCauldron, stallFront, stallInReach, steer,
  type MarketEvent, type MarketState, type MinigameAction, type MinigameResult, type MinigameTick, type Point,
} from '@oddone/shared';
import type { MinigameSim, SimEntrant, SimStep } from './types.ts';

/**
 * Simulation serveur du « Festin du Roi ».
 * Le serveur tire la recette et la répartition des échoppes à chaque manche, vérifie les actions
 * (à portée d'une échoppe, de la marmite), compte les points et fait jouer les bots.
 * La recette n'est publique que pendant l'étape `show` ; ensuite seul le serveur la connaît.
 */

interface Shopper extends Point {
  id: string;
  bot: boolean;
  imposter: boolean;
  start: [number, number];
  yaw: number;
  anim: string;
  /** Imposteur : transformation déjà utilisée cette manche. */
  transformed: boolean;
  // ----- bots -----
  /** La recette telle que le bot s'en souvient (il peut se tromper). */
  memory: string[];
  /** Échoppes déjà regardées cette manche (index → ingrédient). */
  seen: Map<number, string>;
  /** Pause (ms de jeu) avant la prochaine action : le temps de choisir, de se servir. */
  busyUntil: number;
}

export class MarketSim implements MinigameSim {
  elapsed = 0;
  readonly maxMs = MARKET.rounds * (MARKET.showMs + MARKET.huntMs + MARKET.pauseMs) + 2000;
  readonly shoppers = new Map<string, Shopper>();
  readonly state: MarketState;
  private recipe: string[] = [];
  private finished = false;
  private changed = false;

  constructor(entrants: SimEntrant[], private random: () => number = Math.random) {
    this.state = { round: 0, stage: 'pause', stageEndsAt: 0, recipe: null, stalls: [], carry: {}, delivered: [], points: {}, events: [] };
    for (const e of entrants) {
      this.shoppers.set(e.id, {
        id: e.id, bot: e.bot, imposter: e.imposter, start: e.start, x: e.start[0], z: e.start[1], yaw: Math.PI, anim: 'Idle',
        transformed: false, memory: [], seen: new Map(), busyUntil: 0,
      });
      this.state.points[e.id] = 0;
      this.state.carry[e.id] = [];
    }
    this.newRound();
  }

  get isFinished(): boolean { return this.finished; }
  /** Recette de la manche en cours (secrète pendant la chasse). */
  get currentRecipe(): readonly string[] { return this.recipe; }

  private shuffle<T>(list: readonly T[]): T[] {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  private newRound(): void {
    const s = this.state;
    s.round += 1;
    s.stalls = this.shuffle(INGREDIENTS.map((i) => i.id));
    this.recipe = this.shuffle(INGREDIENTS.map((i) => i.id)).slice(0, MARKET.recipeSize);
    s.recipe = [...this.recipe];
    s.stage = 'show';
    s.stageEndsAt = Math.round(this.elapsed + MARKET.showMs);
    s.delivered = [];
    for (const p of this.shoppers.values()) {
      s.carry[p.id] = [];
      p.transformed = false;
      p.seen = new Map();
      p.busyUntil = this.elapsed + MARKET.showMs + 300 + this.random() * 900;
      // les bots retiennent la recette… à peu près
      p.memory = [...this.recipe];
      if (p.bot && this.random() < 0.18) {
        const wrong = INGREDIENTS.map((i) => i.id).filter((id) => !this.recipe.includes(id));
        p.memory[Math.floor(this.random() * p.memory.length)] = wrong[Math.floor(this.random() * wrong.length)];
      }
    }
    this.changed = true;
  }

  setHumanPosition(id: string, x: number, z: number): void {
    const p = this.shoppers.get(id);
    if (!p || p.bot) return;
    p.x = x; p.z = z;
  }

  remove(id: string): void {
    this.shoppers.delete(id);
    delete this.state.carry[id];
    delete this.state.points[id];
  }

  position(id: string): Point | undefined { return this.shoppers.get(id); }

  private event(e: Omit<MarketEvent, 'at'>): void {
    this.state.events.push({ ...e, at: Math.round(this.elapsed) });
    if (this.state.events.length > 12) this.state.events.shift();
  }

  /** Ajoute au panier (sans doublon) ; panier plein : le plus ancien tombe. */
  private give(id: string, item: string): void {
    const carry = this.state.carry[id];
    if (!carry || carry.includes(item)) return;
    carry.push(item);
    if (carry.length > MARKET.carry) carry.shift();
  }

  action(id: string, kind: MinigameAction): boolean {
    const p = this.shoppers.get(id), s = this.state;
    if (!p || this.finished || s.stage !== 'hunt' || s.delivered.includes(id)) return false;
    if (kind === 'deliver') {
      if (!nearCauldron(p.x, p.z)) return false;
      const carry = s.carry[id];
      if (this.recipe.every((r) => carry.includes(r))) {
        const pts = MARKET.roundPoints[s.delivered.length] ?? 0;
        s.delivered.push(id);
        s.points[id] = (s.points[id] ?? 0) + pts;
        s.carry[id] = [];
        this.event({ id, kind: 'ok', points: pts });
      } else {
        s.carry[id] = []; // mauvaise recette : la soupe est gâchée, on recommence
        this.event({ id, kind: 'fail' });
      }
      this.changed = true;
      return true;
    }
    const stall = stallInReach(p.x, p.z);
    if (stall < 0) return false;
    if (kind === 'transform') {
      // l'imposteur prend n'importe quoi… et c'est exactement ce qu'il fallait (une fois par manche)
      if (!p.imposter || p.transformed) return false;
      const missing = this.recipe.find((r) => !s.carry[id].includes(r));
      if (!missing) return false;
      p.transformed = true;
      const carry = s.carry[id];
      if (carry.length >= MARKET.carry) carry.splice(carry.findIndex((c) => !this.recipe.includes(c)), 1);
      this.give(id, missing);
      this.event({ id, kind: 'magic', item: missing });
    } else {
      this.give(id, s.stalls[stall]);
      this.event({ id, kind: 'pick', item: s.stalls[stall] });
    }
    this.changed = true;
    return true;
  }

  step(dtMs: number): SimStep {
    if (this.finished) return { done: true, changed: false, hits: [] };
    this.elapsed += dtMs;
    this.changed = false;
    const s = this.state;
    if (s.stage === 'show' && this.elapsed >= s.stageEndsAt) {
      s.stage = 'hunt'; s.recipe = null; // à vous de vous en souvenir !
      s.stageEndsAt = Math.round(this.elapsed + MARKET.huntMs);
      this.changed = true;
    } else if (s.stage === 'hunt') {
      for (const p of this.shoppers.values()) if (p.bot) this.botStep(p, dtMs / 1000);
      const everyone = [...this.shoppers.keys()].every((id) => s.delivered.includes(id));
      if (everyone || this.elapsed >= s.stageEndsAt) {
        s.stage = 'pause'; s.recipe = [...this.recipe]; // on montre la bonne recette pendant la pause
        s.stageEndsAt = Math.round(this.elapsed + MARKET.pauseMs);
        this.changed = true;
      }
    } else if (s.stage === 'pause' && this.elapsed >= s.stageEndsAt) {
      if (s.round >= MARKET.rounds) {
        this.finished = true;
        const best = Math.max(...Object.values(s.points));
        for (const p of this.shoppers.values()) if (p.bot) p.anim = s.points[p.id] === best ? 'Cheer' : 'Idle';
        this.changed = true;
      } else this.newRound();
    }
    if (s.stage !== 'hunt') for (const p of this.shoppers.values()) if (p.bot && p.anim === 'Running_A') p.anim = 'Idle';
    return { done: this.finished, changed: this.changed, hits: [] };
  }

  /* ================= Bots ================= */

  private botStep(p: Shopper, dt: number): void {
    const s = this.state;
    if (s.delivered.includes(p.id) || this.elapsed < p.busyUntil) {
      if (p.anim === 'Running_A') p.anim = 'Idle';
      return;
    }
    const carry = s.carry[p.id];
    const need = p.memory.filter((m) => !carry.includes(m));
    let goal: [number, number] | null = null, goalStall = -1;
    if (!need.length) goal = [0, 0];
    else {
      // un ingrédient déjà repéré ? sinon, l'échoppe la plus proche pas encore regardée
      for (const [idx, item] of p.seen) if (need.includes(item)) { goalStall = idx; break; }
      if (goalStall < 0) {
        let best = Infinity;
        STALLS.forEach((_, i) => {
          if (p.seen.has(i)) return;
          const [fx, fz] = stallFront(i), d = Math.hypot(fx - p.x, fz - p.z);
          if (d < best) { best = d; goalStall = i; }
        });
      }
      if (goalStall < 0) { p.seen.clear(); return; } // tout vu sans trouver : il cherche encore
      goal = stallFront(goalStall);
    }
    const [gx, gz] = goal, d = Math.hypot(gx - p.x, gz - p.z);
    const arrive = need.length ? 0.6 : MARKET.deliverRadius - 0.6;
    if (d > arrive) {
      p.yaw = steer(p, Math.atan2(gx - p.x, gz - p.z), MARKET.botSpeed * dt, MARKET.bounds, [], MARKET_CIRCLES, 0.5);
      p.anim = 'Running_A';
      return;
    }
    p.anim = 'Interact';
    p.busyUntil = this.elapsed + 450 + this.random() * 500;
    if (!need.length) {
      const ok = this.action(p.id, 'deliver');
      // raté : cette fois il se souvient mieux de la recette
      if (ok && !s.delivered.includes(p.id)) { p.memory = this.random() < 0.75 ? [...this.recipe] : p.memory; p.seen.clear(); }
      return;
    }
    p.seen.set(goalStall, s.stalls[goalStall]);
    if (p.imposter && !p.transformed) { this.action(p.id, 'transform'); return; }
    if (need.includes(s.stalls[goalStall])) this.action(p.id, 'pick');
  }

  /* ================= Résultats ================= */

  results(): MinigameResult[] {
    const pts = this.state.points;
    const order = [...this.shoppers.keys()].sort((a, b) => (pts[b] ?? 0) - (pts[a] ?? 0));
    return order.map((id) => {
      const rank = 1 + order.filter((o) => (pts[o] ?? 0) > (pts[id] ?? 0)).length;
      return { id, rank, points: PLACE_POINTS[rank - 1] ?? 0, survivedMs: pts[id] ?? 0 };
    });
  }

  tick(): MinigameTick {
    const r = (n: number) => Math.round(n * 100) / 100;
    return { t: Math.round(this.elapsed), sk: [], bots: [...this.shoppers.values()].filter((p) => p.bot).map((p) => [p.id, r(p.x), r(p.z), r(p.yaw), p.anim]) };
  }
}
