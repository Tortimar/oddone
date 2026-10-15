import {
  MINE, PLACE_POINTS, makeMineTracks, raceTime,
  type MineSecret, type MineState, type MinigameAction, type MinigameResult, type MinigameTick, type Point,
} from '@oddone/shared';
import type { MinigameSim, SimEntrant, SimStep } from './types.ts';

/**
 * Simulation serveur des « Wagonnets de la Mine ».
 * Le serveur tire les voies de chaque manche, enchaîne les étapes (arrivée des wagons, survol,
 * malédiction, choix, course, classement), garde la malédiction secrète jusqu'au départ (seul
 * l'imposteur la connaît, par `secrets`) et calcule les arrivées. Personne ne se déplace : les
 * positions des wagons se déduisent du temps de course, chez chacun.
 */

interface Seat { id: string; bot: boolean; imposter: boolean; home: [number, number] }

export class MineSim implements MinigameSim {
  elapsed = 0;
  readonly maxMs = 6 * 60_000;
  readonly seats = new Map<string, Seat>();
  readonly state: MineState;
  /** Le wagon maudit de la manche (-1 : pas encore choisi). Public seulement au départ. */
  private cursed = -1;
  private finished = false;
  private changed = false;
  private outbox: { to: string; data: MineSecret }[] = [];
  /** Moment où chaque bot monte dans un wagon (et quand le bot imposteur maudit). */
  private botAt = new Map<string, number>();
  private botCurseAt = Infinity;
  /** Ce que chaque bot a retenu des longueurs (avec ses erreurs de mémoire). */
  private botMemory = new Map<string, number[]>();

  constructor(entrants: SimEntrant[], private random: () => number = Math.random) {
    for (const e of entrants) this.seats.set(e.id, { id: e.id, bot: e.bot, imposter: e.imposter, home: [e.start[0], e.start[1]] });
    this.state = {
      round: 0, stage: 'intro', stageAt: 0, stageEndsAt: 0, tracks: [], picks: {}, cursed: null, arrivals: {},
      points: Object.fromEntries(entrants.map((e) => [e.id, 0])), history: [],
    };
    this.startRound();
  }

  get isFinished(): boolean { return this.finished; }

  private setStage(stage: MineState['stage'], ms: number): void {
    const s = this.state;
    s.stage = stage; s.stageAt = Math.round(this.elapsed); s.stageEndsAt = Math.round(this.elapsed + ms);
    this.changed = true;
  }

  private startRound(): void {
    const s = this.state;
    s.tracks = makeMineTracks(this.random);
    s.picks = {}; s.cursed = null; s.arrivals = {};
    this.cursed = -1;
    this.botAt.clear(); this.botCurseAt = Infinity; this.botMemory.clear();
    this.setStage('intro', MINE.introMs);
  }

  private get imposter(): Seat | undefined { return [...this.seats.values()].find((p) => p.imposter); }

  /** Le maudit : connu de l'imposteur seul (s'il est humain, on lui confirme). */
  private curse(w: number): void {
    this.cursed = w;
    const imp = this.imposter;
    if (imp && !imp.bot) this.outbox.push({ to: imp.id, data: { round: this.state.round, cursed: w } });
  }

  secrets(): { to: string; data: MineSecret }[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  setHumanPosition(): void { /* personne ne marche : on est sur le quai ou dans un wagon */ }

  position(id: string): Point | undefined {
    const p = this.seats.get(id);
    return p ? { x: p.home[0], z: p.home[1] } : undefined;
  }

  remove(id: string): void {
    this.seats.delete(id);
    delete this.state.picks[id];
    delete this.state.arrivals[id];
    this.changed = true;
    if (!this.seats.size) this.finish();
  }

  /** `curse` (imposteur, pendant la malédiction) ou `board` (monter dans le wagon `arg`). */
  action(id: string, kind: MinigameAction, arg?: number): boolean {
    const p = this.seats.get(id), s = this.state;
    if (!p || p.bot || this.finished || arg === undefined || arg < 0 || arg >= MINE.wagons) return false;
    if (kind === 'curse') {
      // (rien de public ne change : personne ne doit voir passer un état à ce moment-là)
      if (s.stage === 'curse' && p.imposter) this.curse(arg);
      return false;
    }
    if (kind === 'board') return this.board(p, arg);
    return false;
  }

  private board(p: Seat, w: number): boolean {
    const s = this.state;
    if (s.stage !== 'pick' || p.id in s.picks || Object.values(s.picks).includes(w)) return false;
    s.picks[p.id] = w;
    // tout le monde est monté : on part un peu plus tôt
    if ([...this.seats.keys()].every((id) => id in s.picks)) s.stageEndsAt = Math.min(s.stageEndsAt, Math.round(this.elapsed + MINE.pickEarlyCloseMs));
    this.changed = true;
    return true;
  }

  step(dtMs: number): SimStep {
    if (this.finished) return { done: true, changed: false, hits: [] };
    this.elapsed += dtMs;
    this.changed = false;
    const s = this.state, now = this.elapsed;
    switch (s.stage) {
      case 'intro':
        if (now >= s.stageEndsAt) this.setStage('preview', MINE.previewMs);
        break;
      case 'preview':
        if (now >= s.stageEndsAt) {
          this.setStage('curse', MINE.curseMs);
          if (this.imposter?.bot) this.botCurseAt = now + 1200 + this.random() * 3000;
        }
        break;
      case 'curse':
        if (now >= this.botCurseAt) { this.botCurseAt = Infinity; this.curse(this.botCursePick()); }
        if (now >= s.stageEndsAt) {
          // l'imposteur n'a rien choisi (ou il est parti) : la mine choisit pour lui
          if (this.cursed < 0) this.curse(Math.floor(this.random() * MINE.wagons));
          this.setStage('pick', MINE.pickMs);
          for (const p of this.seats.values()) if (p.bot) this.botAt.set(p.id, now + 1200 + this.random() * 4500);
        }
        break;
      case 'pick':
        for (const [id, at] of this.botAt) {
          const p = this.seats.get(id);
          if (now < at || !p) continue;
          this.botAt.delete(id);
          const w = this.botPick(p);
          if (w >= 0) this.board(p, w);
        }
        if (now >= s.stageEndsAt) this.startRace();
        break;
      case 'race':
        if (now >= s.stageEndsAt) this.scoreRound();
        break;
      case 'score':
        if (now >= s.stageEndsAt) {
          if (s.round + 1 < MINE.rounds) { s.round += 1; this.startRound(); }
          else this.finish();
        }
        break;
      case 'done':
        break;
    }
    return { done: this.finished, changed: this.changed, hits: [] };
  }

  private freeWagons(): number[] {
    const taken = new Set(Object.values(this.state.picks));
    return [...Array(MINE.wagons).keys()].filter((w) => !taken.has(w));
  }

  /** Départ : chacun dans un wagon (au hasard pour les retardataires), la malédiction révélée. */
  private startRace(): void {
    const s = this.state;
    for (const id of this.seats.keys()) {
      if (id in s.picks) continue;
      const free = this.freeWagons();
      if (free.length) s.picks[id] = free[Math.floor(this.random() * free.length)];
    }
    s.cursed = this.cursed;
    s.arrivals = {};
    let last = 0;
    for (const [id, w] of Object.entries(s.picks)) {
      const t = Math.round(raceTime(s.tracks[w], w === this.cursed));
      s.arrivals[id] = t;
      last = Math.max(last, t);
    }
    this.setStage('race', MINE.raceLeadMs + last + MINE.raceTailMs);
  }

  /** Places de la manche (ex aequo à la milliseconde près) et points. */
  private scoreRound(): void {
    const s = this.state;
    const order = Object.entries(s.arrivals).sort((a, b) => a[1] - b[1]);
    const places: Record<string, number> = {};
    order.forEach(([id, t], i) => {
      const prev = order[i - 1];
      places[id] = prev && Math.abs(prev[1] - t) <= 1 ? places[prev[0]] : i + 1;
      s.points[id] = (s.points[id] ?? 0) + (MINE.roundPoints[places[id] - 1] ?? 0);
    });
    s.history.push(places);
    this.setStage('score', MINE.scoreMs);
  }

  private finish(): void {
    this.finished = true;
    this.setStage('done', 0);
  }

  /* ================= Bots ================= */

  /** Les longueurs telles qu'un bot s'en souvient (plus ou moins bien). */
  private memory(id: string): number[] {
    let m = this.botMemory.get(id);
    if (!m) {
      m = this.state.tracks.map((t) => t.length * (1 + (this.random() - 0.5) * 0.7));
      this.botMemory.set(id, m);
    }
    return m;
  }

  /** L'imposteur bot maudit souvent la voie la plus courte (celle que les autres vont viser). */
  private botCursePick(): number {
    const lens = this.state.tracks.map((t) => t.length);
    const shortest = lens.indexOf(Math.min(...lens));
    return this.random() < 0.7 ? shortest : Math.floor(this.random() * MINE.wagons);
  }

  private botPick(p: Seat): number {
    let free = this.freeWagons();
    if (!free.length) return -1;
    if (p.imposter && this.cursed >= 0 && free.length > 1) free = free.filter((w) => w !== this.cursed);
    // l'imposteur se souvient parfaitement ; les autres, à peu près (et parfois au hasard)
    if (!p.imposter && this.random() < 0.3) return free[Math.floor(this.random() * free.length)];
    const mem = p.imposter ? this.state.tracks.map((t) => t.length) : this.memory(p.id);
    return free.reduce((best, w) => (mem[w] < mem[best] ? w : best), free[0]);
  }

  results(): MinigameResult[] {
    const s = this.state;
    const ids = [...this.seats.keys()].sort((a, b) => (s.points[b] ?? 0) - (s.points[a] ?? 0));
    return ids.map((id) => {
      const rank = 1 + ids.filter((o) => (s.points[o] ?? 0) > (s.points[id] ?? 0)).length;
      return { id, rank, points: PLACE_POINTS[rank - 1] ?? 0, survivedMs: 0 };
    });
  }

  tick(): MinigameTick {
    return { t: Math.round(this.elapsed), sk: [], bots: [] };
  }
}
