import { BRAWL, PODIUM_SPOTS, pushOut, type Bounds, type Hit, type MinigameResult, type Point } from '@oddone/shared';

/**
 * Le podium après un mini-jeu, côté serveur : seuls les bots y sont simulés.
 * Les humains bougent chez eux ; quand ils frappent un bot, le serveur le fait reculer.
 * Les bots rendent parfois les coups aux humains trop proches.
 */

interface PodiumBot extends Point { id: string; vx: number; vz: number; yaw: number; anim: string; busyUntil: number; punchReadyAt: number; winner: boolean }

const FRICTION = 4.5;

export class PodiumBrawl {
  elapsed = 0;
  readonly bots = new Map<string, PodiumBot>();

  /**
   * `origin` : centre du podium dans l'arène ; `bounds` : zone où les bots restent (autour de origin).
   */
  constructor(results: MinigameResult[], botIds: Set<string>, private random: () => number = Math.random,
    private origin: [number, number] = [0, 0], private bounds: Bounds = { halfX: 12, halfZ: 9 }) {
    results.forEach((r, i) => {
      if (!botIds.has(r.id)) return;
      const [sx, sz] = PODIUM_SPOTS[i] ?? PODIUM_SPOTS[PODIUM_SPOTS.length - 1];
      this.bots.set(r.id, {
        id: r.id, x: origin[0] + sx, z: origin[1] + sz, vx: 0, vz: 0, yaw: 0, anim: r.rank === 1 ? 'Cheer' : 'Idle', busyUntil: 0,
        punchReadyAt: 1500 + random() * 2000, winner: r.rank === 1,
      });
    });
  }

  /** Un humain a frappé un bot : il recule. */
  knock(id: string, kick: boolean, dir: [number, number]): void {
    const b = this.bots.get(id);
    if (!b) return;
    const f = kick ? BRAWL.kick : BRAWL.punch;
    b.vx = dir[0] * f.push; b.vz = dir[1] * f.push;
    b.yaw = Math.atan2(-dir[0], -dir[1]); // il se tourne vers son agresseur
    b.anim = 'Hit_A'; b.busyUntil = this.elapsed + 600;
  }

  /** Avance de dtMs ; renvoie les coups portés par les bots aux humains proches. */
  step(dtMs: number, humans: Map<string, Point>): Hit[] {
    this.elapsed += dtMs;
    const dt = dtMs / 1000, hits: Hit[] = [];
    for (const b of this.bots.values()) {
      b.x += b.vx * dt; b.z += b.vz * dt;
      const k = Math.exp(-FRICTION * dt);
      b.vx *= k; b.vz *= k;
      const local = { x: b.x - this.origin[0], z: b.z - this.origin[1] };
      pushOut(local, this.bounds, [], [], 0.5);
      b.x = local.x + this.origin[0]; b.z = local.z + this.origin[1];
      if (this.elapsed < b.busyUntil) continue;
      b.anim = b.winner ? 'Cheer' : 'Idle';
      // un humain à portée ? de temps en temps, le bot lui rend la pareille
      let target: [string, Point] | null = null, best: number = BRAWL.reach * 0.8;
      for (const [id, p] of humans) { const d = Math.hypot(p.x - b.x, p.z - b.z); if (d < best) { best = d; target = [id, p]; } }
      if (!target || this.elapsed < b.punchReadyAt) continue;
      const dx = target[1].x - b.x, dz = target[1].z - b.z, len = Math.hypot(dx, dz) || 1;
      b.yaw = Math.atan2(dx, dz);
      b.anim = 'Unarmed_Melee_Attack_Punch_A'; b.busyUntil = this.elapsed + 650;
      b.punchReadyAt = this.elapsed + 1400 + this.random() * 1600;
      hits.push({ from: b.id, to: target[0], kick: false, dir: [dx / len, dz / len] });
    }
    return hits;
  }

  position(id: string): Point | undefined { return this.bots.get(id); }

  tick(): [string, number, number, number, string][] {
    const r = (n: number) => Math.round(n * 100) / 100;
    return [...this.bots.values()].map((b) => [b.id, r(b.x), r(b.z), r(b.yaw), b.anim]);
  }
}
