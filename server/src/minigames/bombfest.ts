import {
  FEST, FEST_BOARDS, FEST_STARTS, PLACE_POINTS,
  type BombFestState, type MinigameAction, type MinigameResult, type MinigameTick, type Point,
} from '@oddone/shared';
import type { MinigameSim, SimEntrant, SimStep } from './types.ts';

/**
 * Simulation serveur du « Festival des Bombes ».
 * La machine envoie des bombes à chaque plateau encore en jeu, de plus en plus vite ; le serveur
 * vérifie chaque tri (`sort` : la bonne boîte, ou n'importe laquelle pour l'imposteur avec une bombe
 * de sa couleur), remplit les boîtes et envoie les boîtes pleines (5 bombes, qui arrivent une à une).
 * Une bombe pas triée 3 s après son arrivée explose : le joueur est éliminé. Le dernier debout gagne.
 * Les bots trient la bombe la plus pressée, avec un temps de réaction et quelques erreurs.
 */

interface Player {
  id: string;
  slot: number;
  bot: boolean;
  imposter: boolean;
  nextSpawn: number;
  /** Bots : prochain tri (ms de jeu). */
  nextSort: number;
  anim: string;
}

const round = (n: number) => Math.round(n * 100) / 100;

export class FestSim implements MinigameSim {
  elapsed = 0;
  /** État public (référencé tel quel par `mg.fest`). */
  readonly state: BombFestState;
  readonly maxMs = FEST.maxMs;
  readonly players = new Map<string, Player>();
  private nextBomb = 1;
  private endAt = Infinity;
  private finished = false;
  private changed = false;

  constructor(entrants: SimEntrant[], private random: () => number = Math.random) {
    const slots = entrants.map((e) => FEST_STARTS.findIndex(([x, z]) => Math.hypot(x - e.start[0], z - e.start[1]) < 0.01));
    this.state = { boards: {}, colors: [...new Set(slots.map((s) => Math.max(0, s)))].sort(), out: [], booms: [], sends: [] };
    entrants.forEach((e, i) => {
      const slot = Math.max(0, slots[i]);
      this.players.set(e.id, { id: e.id, slot, bot: e.bot, imposter: e.imposter, nextSpawn: 400 + i * 150, nextSort: 0, anim: 'Idle' });
      this.state.boards[e.id] = { bombs: [], boxes: [0, 0, 0, 0], sorted: 0 };
    });
  }

  get isFinished(): boolean { return this.finished; }

  private alive(p: Player): boolean { return !this.state.out.includes(p.id); }

  /** Intervalle entre deux bombes de la machine, à l'instant t. */
  private interval(): number {
    const k = Math.min(1, this.elapsed / FEST.spawn.rampMs);
    return FEST.spawn.startMs + (FEST.spawn.endMs - FEST.spawn.startMs) * k;
  }

  /** Une bombe atterrit sur le plateau de p à l'instant `at` (pas trop près des autres). */
  private drop(p: Player, color: number, at: number, from: number): void {
    const board = this.state.boards[p.id];
    const [cx, cz] = FEST_BOARDS[p.slot];
    let x = cx, z = cz;
    for (let k = 0; k < 8; k++) {
      x = cx + (this.random() * 2 - 1) * FEST.landHX; z = cz + (this.random() * 2 - 1) * FEST.landHZ;
      if (board.bombs.every((b) => Math.hypot(b.x - x, b.z - z) > 1.1)) break;
    }
    board.bombs.push({ id: this.nextBomb++, color, at: Math.round(at), x: round(x), z: round(z), from });
  }

  setHumanPosition(): void { /* les héros restent au bord de leur plateau */ }

  remove(id: string): void {
    this.players.delete(id);
    delete this.state.boards[id];
    this.changed = true;
  }

  position(id: string): Point | undefined {
    const p = this.players.get(id);
    return p ? { x: FEST_STARTS[p.slot][0], z: FEST_STARTS[p.slot][1] } : undefined;
  }

  /** Trier une bombe : `arg` = numéro de bombe × 4 + boîte (couleur). */
  action(id: string, kind: MinigameAction, arg?: number): boolean {
    const p = this.players.get(id);
    if (kind !== 'sort' || !p || !this.alive(p) || this.finished || typeof arg !== 'number' || arg < 0) return false;
    return this.sort(p, Math.floor(arg / 4), arg % 4);
  }

  private sort(p: Player, bombId: number, box: number): boolean {
    const board = this.state.boards[p.id], s = this.state;
    const i = board.bombs.findIndex((b) => b.id === bombId);
    if (i < 0 || !s.colors.includes(box)) return false;
    const bomb = board.bombs[i];
    if (this.elapsed < bomb.at - 150) return false; // encore en vol
    // la bonne boîte… ou n'importe laquelle pour l'imposteur, avec une bombe de sa couleur
    if (bomb.color !== box && !(p.imposter && bomb.color === p.slot)) return false;
    board.bombs.splice(i, 1);
    board.sorted += 1;
    board.boxes[box] += 1;
    if (board.boxes[box] >= FEST.capacity) { board.boxes[box] = 0; this.send(p, box); }
    this.changed = true;
    return true;
  }

  /** Une boîte pleine : ses bombes partent chez le joueur de cette couleur (les siennes : chez les autres). */
  private send(from: Player, color: number): void {
    const targets = [...this.players.values()].filter((o) => o !== from && this.alive(o));
    const owner = targets.find((o) => o.slot === color);
    const pool = owner ? [owner] : targets;
    if (!pool.length) return;
    for (let k = 0; k < FEST.capacity; k++) {
      const to = pool[owner ? 0 : Math.floor(this.random() * pool.length)];
      this.drop(to, color, this.elapsed + FEST.flightMs + k * FEST.sendGapMs, from.slot);
      if (k === 0 || !owner) this.state.sends.push({ from: from.id, to: to.id, color, at: Math.round(this.elapsed) });
    }
    if (this.state.sends.length > 30) this.state.sends.splice(0, this.state.sends.length - 30);
  }

  step(dtMs: number): SimStep {
    if (this.finished) return { done: true, changed: false, hits: [] };
    this.elapsed += dtMs;
    this.changed = false;
    const s = this.state;
    for (const p of this.players.values()) {
      if (!this.alive(p)) continue;
      const board = s.boards[p.id];
      // la machine envoie une bombe
      if (this.elapsed >= p.nextSpawn && this.endAt === Infinity) {
        p.nextSpawn += this.interval() * (0.8 + this.random() * 0.4);
        this.drop(p, s.colors[Math.floor(this.random() * s.colors.length)], this.elapsed + FEST.flightMs, -1);
        this.changed = true;
      }
      if (p.bot) this.botSort(p);
      // une mèche au bout : le plateau saute
      if (board.bombs.some((b) => this.elapsed >= b.at + FEST.fuseMs)) {
        s.out.push(p.id);
        s.booms.push({ id: p.id, at: Math.round(this.elapsed) });
        board.bombs = [];
        p.anim = 'Death_A';
        this.changed = true;
      }
    }
    // plus qu'un en jeu (ou plus personne) : deux secondes pour voir la dernière explosion
    const alive = [...this.players.values()].filter((p) => this.alive(p));
    if (this.endAt === Infinity && (alive.length === 0 || (alive.length === 1 && this.players.size > 1))) {
      this.endAt = this.elapsed + 2000;
      for (const p of alive) { p.anim = 'Cheer'; s.boards[p.id].bombs = []; }
    }
    if (this.elapsed >= this.endAt || this.elapsed >= FEST.maxMs) this.finished = true;
    return { done: this.finished, changed: this.changed, hits: [] };
  }

  /** Un bot trie la bombe la plus pressée (parfois dans la mauvaise boîte : refusée, du temps perdu). */
  private botSort(p: Player): void {
    if (this.elapsed < p.nextSort) return;
    const board = this.state.boards[p.id];
    const landed = board.bombs.filter((b) => this.elapsed >= b.at).sort((a, b) => a.at - b.at);
    if (!landed.length) { p.nextSort = this.elapsed + 120; return; }
    const bomb = landed[0], colors = this.state.colors;
    const wrong = this.random() < FEST.botMistake ? colors.filter((c) => c !== bomb.color) : [];
    const box = wrong.length ? wrong[Math.floor(this.random() * wrong.length)] : bomb.color;
    this.sort(p, bomb.id, box);
    p.nextSort = this.elapsed + FEST.botSortMs[0] + this.random() * (FEST.botSortMs[1] - FEST.botSortMs[0]);
  }

  /* ================= Fin ================= */

  /** Les survivants (du plus grand trieur au plus petit), puis les explosés du dernier au premier. */
  results(): MinigameResult[] {
    const s = this.state;
    const alive = [...this.players.values()].filter((p) => this.alive(p)).sort((a, b) => s.boards[b.id].sorted - s.boards[a.id].sorted).map((p) => p.id);
    const order = [...alive, ...[...s.out].reverse()].filter((id) => this.players.has(id));
    return order.map((id, i) => ({ id, rank: i + 1, points: PLACE_POINTS[i] ?? 0, survivedMs: s.booms.find((b) => b.id === id)?.at ?? Math.round(this.elapsed) }));
  }

  tick(): MinigameTick {
    return {
      t: Math.round(this.elapsed),
      sk: [],
      bots: [...this.players.values()].filter((p) => p.bot).map((p) => {
        const [x, z] = FEST_STARTS[p.slot];
        return [p.id, x, z, Math.atan2(-Math.sign(x), 0), p.anim] as [string, number, number, number, string];
      }),
    };
  }
}

