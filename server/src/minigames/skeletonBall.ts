import {
  PLACE_POINTS, SKELETON_BALL as SB, arenaBoxes, dist, graveExit, pushOut, skeletonCount, skeletonSpeed, steer,
  type Box, type Circle, type MinigameResult, type MinigameTick, type Point, type SkeletonArena,
} from '@oddone/shared';

/**
 * Simulation serveur du « Bal des Squelettes » : squelettes, bots et contacts.
 * Logique pure (pas de minuteur ni de réseau) : `step(dtMs)` avance le temps.
 *
 * Les joueurs humains se déplacent chez eux et envoient leur position (`setHumanPosition`) ;
 * le serveur décide seul qui est touché, et quand.
 */

import type { SimEntrant } from './types.ts';
export type { SimEntrant };

interface SimPlayer extends Point {
  id: string;
  bot: boolean;
  imposter: boolean;
  yaw: number;
  anim: string;
  /** ms de jeu où il a été touché, null s'il court encore. */
  caughtAt: number | null;
  by: string | null;
  /** Bots : point d'errance quand aucune menace n'est proche. */
  wander: Point;
  wanderUntil: number;
}

interface Skeleton extends Point { yaw: number; spawnedAt: number }

export interface StepResult {
  /** Joueurs touchés pendant ce pas. */
  caught: { id: string; by: string | null }[];
  /** Le mini-jeu est terminé. */
  done: boolean;
}

/** Les bots courent un peu moins vite qu'un humain : il faut pouvoir les battre. */
const BOT_SPEED_MUL = 0.9;
const SKELETON_RADIUS = 0.45;

export class SkeletonBallSim {
  elapsed = 0;
  readonly players = new Map<string, SimPlayer>();
  readonly skeletons: Skeleton[] = [];
  private boxes: Box[];
  private finished = false;

  constructor(readonly arena: SkeletonArena, entrants: SimEntrant[], private random: () => number = Math.random) {
    this.boxes = arenaBoxes(arena);
    for (const e of entrants) {
      this.players.set(e.id, {
        id: e.id, bot: e.bot, imposter: e.imposter, x: e.start[0], z: e.start[1], yaw: Math.PI, anim: 'Idle',
        caughtAt: null, by: null, wander: { x: e.start[0], z: e.start[1] }, wanderUntil: 0,
      });
    }
  }

  /** Position reçue d'un joueur humain (bornée à l'arène). */
  setHumanPosition(id: string, x: number, z: number): void {
    const p = this.players.get(id);
    if (!p || p.bot || this.finished) return;
    if (this.stunned(p)) return; // sonné : il ne bouge pas, même si le client insiste
    p.x = x; p.z = z;
    pushOut(p, SB.bounds, [], [], SB.radius);
  }

  remove(id: string): void { this.players.delete(id); }

  step(dtMs: number): StepResult {
    const res: StepResult = { caught: [], done: false };
    if (this.finished) { res.done = true; return res; }
    this.elapsed += dtMs;
    const dt = dtMs / 1000;
    this.spawnSkeletons();
    this.moveSkeletons(dt);
    for (const p of this.players.values()) if (p.bot) this.moveBot(p, dt);
    this.checkContacts(res);
    const all = [...this.players.values()], alive = all.filter((p) => p.caughtAt === null).length;
    const over = all.length >= 2 ? alive <= 1 : alive === 0;
    if (over || this.elapsed >= SB.maxDurationMs) { this.finished = true; this.finalPoses(); }
    res.done = this.finished;
    return res;
  }

  get isFinished(): boolean { return this.finished; }

  /** Classement : le plus longtemps libre gagne ; les survivants partagent la 1re place. */
  results(): MinigameResult[] {
    // clé de classement : un joueur encore libre passe devant tous ceux qui ont été touchés
    const all = [...this.players.values()].map((p) => ({ id: p.id, key: p.caughtAt ?? Infinity, survivedMs: Math.round(p.caughtAt ?? this.elapsed) }));
    return all
      .map(({ id, key, survivedMs }) => {
        const rank = 1 + all.filter((o) => o.key > key).length;
        return { id, rank, points: PLACE_POINTS[rank - 1] ?? 0, survivedMs };
      })
      .sort((a, b) => a.rank - b.rank || b.survivedMs - a.survivedMs);
  }

  tick(): MinigameTick {
    const r = (n: number) => Math.round(n * 100) / 100;
    return {
      t: Math.round(this.elapsed),
      sk: this.skeletons.map((s) => [r(s.x), r(s.z), r(s.yaw), this.rising(s) ? 1 : 0]),
      bots: [...this.players.values()].filter((p) => p.bot).map((p) => [p.id, r(p.x), r(p.z), r(p.yaw), p.anim]),
    };
  }

  /* ================= Détails ================= */

  private rising(s: Skeleton): boolean { return this.elapsed - s.spawnedAt < SB.riseMs; }
  private stunned(p: SimPlayer): boolean { return p.caughtAt !== null && this.elapsed - p.caughtAt < SB.curseStunMs; }
  private alive(): SimPlayer[] { return [...this.players.values()].filter((p) => p.caughtAt === null); }

  private nearest<T extends Point>(from: Point, list: T[]): T | null {
    let best: T | null = null, bestD = Infinity;
    for (const o of list) { const d = dist(from, o); if (d < bestD) { bestD = d; best = o; } }
    return best;
  }

  /** Nouveaux squelettes : ils sortent des tombes les plus éloignées des joueurs encore libres. */
  private spawnSkeletons(): void {
    const targets = this.alive();
    while (this.skeletons.length < skeletonCount(this.elapsed)) {
      const spots = this.arena.graves.map(graveExit).map((p) => {
        pushOut(p, SB.bounds, this.boxes, [], SKELETON_RADIUS);
        const near = targets.length ? Math.min(...targets.map((t) => dist(p, t))) : 99;
        const crowd = this.skeletons.some((s) => dist(s, p) < 1.5) ? 10 : 0; // pas deux squelettes au même endroit
        return { p, score: near - crowd };
      }).sort((a, b) => b.score - a.score);
      const pick = spots[Math.floor(this.random() * Math.min(4, spots.length))]?.p ?? { x: 0, z: -SB.bounds.halfZ + 1 };
      const aim = this.nearest(pick, targets);
      this.skeletons.push({ x: pick.x, z: pick.z, yaw: aim ? Math.atan2(aim.x - pick.x, aim.z - pick.z) : 0, spawnedAt: this.elapsed });
    }
  }

  /**
   * Proie d'un squelette : le joueur libre le plus proche, l'imposteur étant vu
   * `imposterDistanceMul` fois plus loin (son avantage : on le délaisse).
   */
  private prey(s: Point, targets: SimPlayer[]): SimPlayer | null {
    let best: SimPlayer | null = null, bestD = Infinity;
    for (const t of targets) {
      const d = dist(s, t) * (t.imposter ? SB.imposterDistanceMul : 1);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  private moveSkeletons(dt: number): void {
    const targets = this.alive();
    const speed = skeletonSpeed(this.elapsed);
    for (const s of this.skeletons) {
      if (this.rising(s)) continue;
      const aim = this.prey(s, targets);
      if (!aim) continue;
      const others: Circle[] = this.skeletons.filter((o) => o !== s).map((o) => ({ x: o.x, z: o.z, r: SKELETON_RADIUS }));
      s.yaw = steer(s, Math.atan2(aim.x - s.x, aim.z - s.z), speed * dt, SB.bounds, this.boxes, others, SKELETON_RADIUS);
    }
  }

  private moveBot(p: SimPlayer, dt: number): void {
    if (this.stunned(p)) { p.anim = 'Hit_B'; return; }
    let speed = SB.playerSpeed * BOT_SPEED_MUL;
    let dir: number | null;
    if (p.caughtAt !== null) {
      // maudit : il chasse le joueur libre le plus proche
      speed *= SB.cursedSpeedMul;
      const aim = this.nearest(p, this.alive());
      dir = aim ? Math.atan2(aim.x - p.x, aim.z - p.z) : null;
    } else dir = this.fleeDirection(p);
    if (dir === null) { p.anim = 'Idle'; return; }
    const before = { x: p.x, z: p.z };
    p.yaw = steer(p, dir, speed * dt, SB.bounds, this.boxes, [], SB.radius);
    p.anim = dist(before, p) > speed * dt * 0.2 ? (p.caughtAt !== null ? 'Walking_A' : 'Running_A') : 'Idle';
  }

  /**
   * Fuite : le bot regarde 16 directions autour de lui et choisit celle qui l'éloigne le plus
   * des menaces (squelettes, maudits), sans foncer dans un mur ni coller les autres joueurs.
   * Sans menace proche, il erre tranquillement.
   */
  private fleeDirection(p: SimPlayer): number {
    const threats: Point[] = [
      ...this.skeletons, // même en train de sortir de terre : on le voit venir
      ...[...this.players.values()].filter((o) => o.caughtAt !== null),
    ];
    const closest = threats.length ? Math.min(...threats.map((t) => dist(p, t))) : Infinity;
    if (closest > 7) {
      if (this.elapsed > p.wanderUntil || dist(p, p.wander) < 1) {
        p.wander = { x: (this.random() * 2 - 1) * (SB.bounds.halfX - 2), z: (this.random() * 2 - 1) * (SB.bounds.halfZ - 2) };
        p.wanderUntil = this.elapsed + 2500 + this.random() * 2500;
      }
      return Math.atan2(p.wander.x - p.x, p.wander.z - p.z);
    }
    const mates = [...this.players.values()].filter((o) => o !== p && o.caughtAt === null);
    const { halfX, halfZ } = SB.bounds;
    let best = p.yaw, bestScore = -Infinity;
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2;
      // on « essaie » la direction sur quelques pas, en contournant les tombes comme pour de vrai
      const probe = { x: p.x, z: p.z };
      for (let i = 0; i < 4; i++) steer(probe, ang, 0.55, SB.bounds, this.boxes, [], SB.radius);
      let score = Math.min(9, ...threats.map((t) => dist(probe, t))) * 1.4;
      score += dist(p, probe) * 0.5; // une direction bouchée ne fait pas avancer
      const margin = Math.min(halfX - Math.abs(probe.x), halfZ - Math.abs(probe.z));
      score -= 2.5 / Math.max(0.4, margin); // les coins sont des pièges
      for (const m of mates) score -= 1.2 / Math.max(0.6, dist(probe, m)); // ne pas se regrouper
      score += Math.cos(ang - p.yaw) * 0.6; // garder son cap évite de trembler
      score += this.random() * 0.4; // un peu d'hésitation : les bots ne sont pas parfaits
      if (score > bestScore) { bestScore = score; best = ang; }
    }
    return best;
  }

  private checkContacts(res: StepResult): void {
    const hunters = [
      ...this.skeletons.filter((s) => !this.rising(s)).map((s) => ({ pos: s as Point, id: null as string | null })),
      ...[...this.players.values()].filter((o) => o.caughtAt !== null && !this.stunned(o)).map((o) => ({ pos: o as Point, id: o.id as string | null })),
    ];
    for (const p of this.alive()) {
      const hit = hunters.find((h) => dist(h.pos, p) < SB.tagRadius);
      if (!hit) continue;
      p.caughtAt = this.elapsed; p.by = hit.id;
      res.caught.push({ id: p.id, by: hit.id });
    }
  }

  /** Fin de partie : les bots gagnants dansent, les autres soufflent. */
  private finalPoses(): void {
    const winners = new Set(this.results().filter((r) => r.rank === 1).map((r) => r.id));
    for (const p of this.players.values()) if (p.bot) p.anim = winners.has(p.id) ? 'Cheer' : 'Idle';
  }
}
