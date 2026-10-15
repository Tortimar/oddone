import * as THREE from 'three';
import {
  DEFAULT_CONFIG, HORDE, slashHits,
  type CharacterConfig, type Hit, type HordeKill, type MinigameTick,
} from '@oddone/shared';
import { canvasTexture, gradientMap } from '../engine/render.ts';
import { composeCharacter, playAnimation, updateActor, type Actor, type CharacterModel } from '../characters/character.ts';
import { angleDamp } from '../engine/render.ts';
import { pointer } from '../game/input.ts';
import { loadKit, type Kit } from '../world/kits.ts';
import { glow } from '../world/outside.ts';
import { FLOAT_GAIN } from '../world/floatText.ts';
import type { World } from '../world/tavern.ts';
import { Particles, PodiumView } from './effects.ts';
import type { Frame, GameView, HudInfo } from './view.ts';

/**
 * L'arène de « La Horde de Gobelins » : une clairière ensoleillée cernée par la forêt.
 * Les gobelins (des héros KayKit tout petits, peau verte, capuche et dague) sortent des arbres
 * et foncent sur les joueurs ; les dorés brillent et valent 3 points.
 * Côté joueur local : 3e personne à la souris, coup d'épée (E ou clic) avec un peu d'aide à la
 * visée. Touché (par un gobelin ou l'épée d'un autre joueur) : étourdi une seconde, la tête qui
 * tourne et des étoiles au-dessus. L'entraînement se joue avec des gobelins locaux.
 */

const SWORD = 'knight:1H_Sword';
const WALK = HORDE.walkRadius;

const GOBLIN: CharacterConfig = {
  ...DEFAULT_CONFIG, body: 'rogue', head: 'hood', hat: 'none', cape: 'none', hue: 95, skin: '#7cc46a',
  right: 'rogue:Knife', left: 'none', face: 'none', top: 'none', neck: 'none', back: 'none', size: '1',
};
const GOLDEN: CharacterConfig = { ...GOBLIN, hue: 48, skin: '#ffd23f', right: 'knight:1H_Sword' };
const GOBLIN_SCALE = 0.72;

const meadow = canvasTexture(256, 256, (g, w, h) => {
  g.fillStyle = '#86b65a'; g.fillRect(0, 0, w, h);
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let k = 0; k < 900; k++) {
    const x = rnd() * w, y = rnd() * h, l = 0.8 + rnd() * 0.4;
    g.fillStyle = `rgba(${Math.round(90 * l)},${Math.round(150 * l)},${Math.round(60 * l)},0.55)`;
    g.fillRect(x, y, 2, 5 + rnd() * 4);
  }
});
meadow.wrapS = meadow.wrapT = THREE.RepeatWrapping;
meadow.repeat.set(10, 10);

/** Petite étoile jaune (étourdi). */
const STAR = canvasTexture(64, 64, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  g.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2 - Math.PI / 2, r = k % 2 ? 12 : 28;
    g.lineTo(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r);
  }
  g.closePath();
  g.lineWidth = 5; g.strokeStyle = '#1d120c'; g.stroke();
  g.fillStyle = '#ffd23f'; g.fill();
});

/** Un joueur étourdi : la couronne d'étoiles qui tourne au-dessus de sa tête. */
interface Dizzy { until: number; ring: THREE.Group; holder: THREE.Object3D | null }

interface GoblinView extends Actor {
  model: CharacterModel;
  gold: boolean;
  id: number;
  active: boolean;
  target: THREE.Vector3;
  yaw: number;
  anim: string;
  /** Tué : il tombe, puis s'enfonce (secondes restantes). */
  dying: number;
  halo: THREE.Sprite | null;
  /** Absent du dernier tick : tué (l'annonce arrive juste après) ou fin de partie. */
  lostAt: number | null;
}

/** Gobelins de l'entraînement (rien que pour soi). */
interface TrainGoblin { view: GoblinView; x: number; z: number; hitReadyAt: number }

export class HordeArena implements GameView {
  readonly scene = new THREE.Scene();
  readonly world: World;
  readonly particles: Particles;
  readonly podium: PodiumView;
  readonly cameras = { training: 'thirdPerson', play: 'thirdPerson' } as const;
  readonly thirdPerson = true;
  readonly cameraRadius = WALK + 2.4;
  readonly solidPlayers = true;
  readonly weapon = SWORD;
  private pool: GoblinView[] = [];
  private byId = new Map<number, GoblinView>();
  private lastKill = -1;
  private slashReadyAt = 0;
  private training: TrainGoblin[] = [];
  private trainSpawnAt = 0;
  private trainPoints = 0;
  private trainId = 1_000_000;
  private flash: { text: string; until: number } | null = null;
  /** Moi étourdi jusqu'à (horloge murale, ms). */
  private myStunUntil = 0;
  private dizzy = new Map<string, Dizzy>();

  private constructor(private kits: { medieval: Kit; halloween: Kit }) {
    this.world = { colliders: [], circles: [], bounds: { halfX: 40, halfZ: 40 } };
    this.build();
    this.particles = new Particles(this.scene);
    this.podium = new PodiumView(this.scene, [...HORDE.podium], this.world, this.particles);
    // quelques gobelins prêts d'avance (les autres sont créés à la demande)
    for (let k = 0; k < 8; k++) this.newGoblin(k % 4 === 3);
  }

  static async create(): Promise<HordeArena> {
    const [medieval, halloween] = await Promise.all([loadKit('medieval'), loadKit('halloween')]);
    return new HordeArena({ medieval, halloween });
  }

  /** Au départ, tourné vers l'extérieur : c'est de là qu'ils viennent. */
  startYaw(x: number, z: number): number { return Math.atan2(x, z); }

  /* ================= Décor ================= */

  private build(): void {
    const s = this.scene, { medieval, halloween } = this.kits;
    s.background = canvasTexture(4, 256, (g, w, h) => {
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#79b9e2'); grad.addColorStop(0.55, '#c4e0cf'); grad.addColorStop(1, '#a9c9ac');
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
    });
    s.fog = new THREE.Fog('#a9c9ac', 22, 62); // (brume des sous-bois : la forêt se perd au loin)
    s.add(new THREE.HemisphereLight('#fff6e0', '#4f6e35', 1.9));
    const sun = new THREE.DirectionalLight('#fff0d0', 2.2);
    sun.position.set(-12, 26, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 70 });
    sun.shadow.bias = -0.0008;
    s.add(sun);

    // le sol de la forêt, plus sombre, et la clairière au milieu
    const forest = new THREE.Mesh(new THREE.CircleGeometry(90, 48), new THREE.MeshToonMaterial({ color: '#4f7a34', gradientMap }));
    forest.rotation.x = -Math.PI / 2; forest.receiveShadow = true;
    s.add(forest);
    const clearing = new THREE.Mesh(new THREE.CircleGeometry(WALK + 1.6, 64), new THREE.MeshToonMaterial({ map: meadow, gradientMap }));
    clearing.rotation.x = -Math.PI / 2; clearing.position.y = 0.01; clearing.receiveShadow = true;
    s.add(clearing);

    // champignons au bord de la clairière
    const capMat = new THREE.MeshToonMaterial({ color: '#d8432f', gradientMap }), dotMat = new THREE.MeshToonMaterial({ color: '#fbf1dc', gradientMap });
    for (let k = 0; k < 9; k++) {
      const a = k * 0.71 + 0.3, r = WALK + 0.6 + (k % 3) * 0.5;
      const m = new THREE.Group();
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.3, 6), dotMat); foot.position.y = 0.15; m.add(foot);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), capMat); cap.position.y = 0.28; m.add(cap);
      m.position.set(Math.sin(a) * r, 0, Math.cos(a) * r); m.scale.setScalar(0.8 + (k % 3) * 0.3);
      s.add(m);
    }

    // la forêt : de grands arbres (cinq à sept fois un héros) sur plusieurs rangs de plus en plus
    // serrés, des fourrés entre les troncs du premier rang : on ne voit que des bois tout autour
    const big: [Kit, string, number][] = [
      [medieval, 'tree_single_A', 12], [halloween, 'tree_pine_yellow_large', 2.1], [medieval, 'tree_single_B', 12],
      [halloween, 'tree_pine_orange_large', 2.1], [medieval, 'tree_single_A', 13.5], [halloween, 'tree_pine_yellow_medium', 2.6],
    ];
    const camps: [number, number][] = [[-10, -13.5], [12, -11], [-6.5, -15.2], [9.5, -14]];
    const clear = (x: number, z: number) => camps.every(([cx, cz]) => Math.hypot(x - cx, z - cz) > 4.2);
    let n = 0;
    for (const [r0, count] of [[17, 16], [22, 20], [28, 24], [35, 28], [43, 32], [52, 36]] as const) {
      for (let k = 0; k < count; k++) {
        const a = (k / count) * Math.PI * 2 + (r0 % 3) * 0.11 + ((k * 7) % 5) * 0.025;
        const r = r0 + ((k * 13) % 7) * 0.5, x = Math.sin(a) * r, z = Math.cos(a) * r;
        const [kit, name, scale] = big[n++ % big.length];
        if (!kit.has(name) || !clear(x, z)) continue;
        // (au-delà du premier rang, pas d'ombres : la carte d'ombres du soleil ne va pas si loin)
        kit.spawn(name, { x, z, ry: k * 1.3, scale: scale * (0.85 + ((k * 31) % 10) / 25), parent: s, shadows: r0 < 25 });
      }
    }
    // fourrés entre les troncs du premier rang (à hauteur d'homme, ils ferment les trouées)
    for (let k = 0; k < 18; k++) {
      const a = ((k + 0.5) / 18) * Math.PI * 2, r = 18.5 + (k % 3) * 0.8, x = Math.sin(a) * r, z = Math.cos(a) * r;
      if (!clear(x, z)) continue;
      medieval.spawn(k % 2 ? 'trees_A_large' : 'trees_B_medium', { x, z, ry: k * 2.1, scale: 5.5 + (k % 3) * 0.6, parent: s });
    }
    // souches, rochers et le camp des gobelins dans les sous-bois
    for (let k = 0; k < 7; k++) {
      const a = k * 0.9 + 0.5, r = WALK + 1.3;
      medieval.spawn(k % 2 ? 'trees_A_cut' : 'rock_single_C', { x: Math.sin(a) * r, z: Math.cos(a) * r, ry: k, scale: k % 2 ? 3.6 : 2.6, parent: s });
    }
    medieval.spawn('tent', { x: -10, z: -13.5, ry: 0.6, scale: 3.4, parent: s });
    medieval.spawn('tent', { x: 12, z: -11, ry: -0.8, scale: 3.4, parent: s });
    for (const [x, z] of [[-6.5, -15.2], [9.5, -14]] as const) {
      const fire = glow('#ffae42', 1.6, 0.85); fire.position.set(x, 0.5, z); s.add(fire);
    }
  }

  /* ================= Gobelins ================= */

  private newGoblin(gold: boolean): GoblinView {
    const model = composeCharacter(gold ? GOLDEN : GOBLIN);
    model.holder.scale.multiplyScalar(GOBLIN_SCALE);
    const root = new THREE.Group();
    root.add(model.holder);
    root.visible = false;
    let halo: THREE.Sprite | null = null;
    if (gold) { halo = glow('#ffd23f', 2.2, 0.5); halo.position.y = 1; root.add(halo); }
    this.scene.add(root);
    const v: GoblinView = { root, model, gold, id: -1, active: false, target: new THREE.Vector3(), yaw: 0, anim: '', dying: 0, halo, lostAt: null };
    this.pool.push(v);
    return v;
  }

  private takeGoblin(id: number, gold: boolean, x: number, z: number): GoblinView {
    const v = this.pool.find((g) => !g.active && g.dying <= 0 && g.gold === gold) ?? this.newGoblin(gold);
    v.active = true; v.id = id; v.dying = 0; v.root.visible = true; v.lostAt = null;
    v.root.position.set(x, 0, z); v.target.set(x, 0, z);
    v.model.holder.position.y = 0;
    v.anim = '';
    this.byId.set(id, v);
    return v;
  }

  private releaseGoblin(v: GoblinView): void {
    v.active = false; v.root.visible = false; v.dying = 0;
    if (this.byId.get(v.id) === v) this.byId.delete(v.id);
  }

  private setAnim(v: GoblinView, anim: string): void {
    if (anim === v.anim) return;
    v.anim = anim;
    const once = anim.startsWith('1H_') || anim.startsWith('Death');
    playAnimation(v, anim, { once, fade: 0.15, restart: once, speed: anim === 'Running_A' ? 1.25 : 1 });
  }

  /** Un gobelin est tué : il tombe, des éclats (le « +1 » ou « +3 » jaillit au-dessus du joueur : announcer.ts). */
  private kill(v: GoblinView | undefined, k: { x: number; z: number; gold: boolean }): void {
    this.particles.burst(k.x, 0.9, k.z, k.gold ? '#ffd23f' : '#8fd45e', k.gold ? 14 : 7, 1.2, 0.45);
    if (!v) return;
    this.byId.delete(v.id);
    v.active = false; v.dying = 1.1;
    this.setAnim(v, 'Death_A');
  }

  /* ================= Joueur local ================= */

  startTraining(f: Frame): void {
    this.clearTraining();
    this.trainSpawnAt = f.simTime + 1; this.trainPoints = 0;
  }
  stopTraining(): void { this.clearTraining(); }
  private clearTraining(): void { for (const t of this.training) this.releaseGoblin(t.view); this.training = []; }

  onPhase(f: Frame): void {
    this.slashReadyAt = 0; this.myStunUntil = 0;
    this.clearDizzy();
    if (f.phase === 'mgResults') {
      for (const v of this.pool) this.releaseGoblin(v);
      this.byId.clear();
    }
  }

  beforeMove(f: Frame): void {
    f.me.speedMul = 1;
    if (performance.now() < this.myStunUntil) f.me.frozen = true; // étourdi : ni pas ni coup
    // clic gauche (souris capturée) = coup d'épée, comme E
    if (pointer.clicked && (f.phase === 'mgPlay' || f.phase === 'rules') && !f.me.frozen) this.onAct(f, false);
  }

  /** On ne sort pas de la clairière. */
  afterMove(f: Frame, dt: number): string | null {
    const P = f.me.root.position, r = Math.hypot(P.x, P.z);
    if (r > WALK) { P.x *= WALK / r; P.z *= WALK / r; }
    return f.phase === 'rules' ? this.updateTraining(f, dt) : null;
  }

  /** E (ou clic) : coup d'épée. Un peu d'aide à la visée : on se tourne vers le gobelin à portée. */
  onAct(f: Frame, special: boolean): boolean {
    // recharge à l'horloge murale : la même pour tout le monde, même si l'image rame
    const wall = performance.now();
    if (special || wall < this.slashReadyAt) return !special;
    if (f.phase !== 'mgPlay' && f.phase !== 'rules') return false;
    this.slashReadyAt = wall + HORDE.slash.cooldownMs;
    const me = f.me, P = me.root.position;
    let best: { x: number; z: number } | null = null, bestD = HORDE.slash.reach + 0.3;
    const targets = f.phase === 'rules' ? this.training.map((t) => ({ x: t.x, z: t.z })) : [...this.byId.values()].map((v) => ({ x: v.target.x, z: v.target.z }));
    for (const g of targets) { const d = Math.hypot(g.x - P.x, g.z - P.z); if (d < bestD) { bestD = d; best = g; } }
    // pas de gobelin à portée : on vise le joueur le plus proche (on peut les étourdir aussi)
    if (!best && f.phase === 'mgPlay') {
      bestD = HORDE.slash.reach + 0.3;
      for (const r of f.remotes.values()) { const q = r.root.position, d = Math.hypot(q.x - P.x, q.z - P.z); if (d < bestD) { bestD = d; best = q; } }
    }
    if (best) { me.yaw = Math.atan2(best.x - P.x, best.z - P.z); me.root.rotation.y = me.yaw; }
    me.slash();
    if (f.phase === 'mgPlay') {
      f.net.sendMove(me.transform()); // le serveur juge avec notre orientation du moment
      f.net.action('slash');
    } else {
      // entraînement : on juge ici
      for (const t of [...this.training]) {
        if (!slashHits(P.x, P.z, me.yaw, t.x, t.z)) continue;
        this.training.splice(this.training.indexOf(t), 1);
        this.trainPoints += t.view.gold ? 3 : 1;
        this.kill(t.view, { x: t.x, z: t.z, gold: t.view.gold });
        f.float(f.myId, t.view.gold ? '+3' : '+1', FLOAT_GAIN);
      }
    }
    return true;
  }

  /** Entraînement : un gobelin de temps en temps (parfois doré), qui vient vers soi. */
  private updateTraining(f: Frame, dt: number): string | null {
    const P = f.me.root.position;
    if (f.simTime >= this.trainSpawnAt && this.training.length < 3) {
      this.trainSpawnAt = f.simTime + 2.6;
      const a = Math.random() * Math.PI * 2, gold = Math.random() < 0.25;
      const x = Math.sin(a) * (WALK - 1), z = Math.cos(a) * (WALK - 1);
      this.training.push({ view: this.takeGoblin(this.trainId++, gold, x, z), x, z, hitReadyAt: 0 });
    }
    let msg: string | null = null;
    for (const t of this.training) {
      const dx = P.x - t.x, dz = P.z - t.z, d = Math.hypot(dx, dz);
      t.view.yaw = Math.atan2(dx, dz);
      if (d > HORDE.goblinReach) {
        const sp = HORDE.goblinSpeed * 0.8 * dt;
        t.x += (dx / d) * sp; t.z += (dz / d) * sp;
        this.setAnim(t.view, 'Running_A');
      } else if (f.simTime >= t.hitReadyAt) {
        t.hitReadyAt = f.simTime + HORDE.goblinHitCooldownMs / 1000;
        this.setAnim(t.view, '1H_Melee_Attack_Chop');
        if (performance.now() >= this.myStunUntil + HORDE.stunGraceMs) {
          f.me.knock([dx / (d || 1), dz / (d || 1)], false);
          this.stunned(f.myId, f);
          msg = 'Aïe ! Étourdi… frappe-le avant qu’il ne frappe';
        }
      }
      t.view.target.set(t.x, 0, t.z);
    }
    return msg;
  }

  /** Un coup reçu (gobelin ou épée d'un joueur) : la cible est étourdie, chez tout le monde. */
  onHit(h: Hit, f: Frame): void {
    if (f.phase === 'mgPlay') this.stunned(h.to, f);
  }

  private stunned(id: string, f: Frame): void {
    const until = performance.now() + HORDE.stunMs;
    if (id === f.myId) { this.myStunUntil = until; f.me.frozen = true; }
    const actor = id === f.myId ? f.me : f.remotes.get(id);
    if (!actor) return;
    let d = this.dizzy.get(id);
    if (!d) {
      const ring = new THREE.Group();
      for (let k = 0; k < 4; k++) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: STAR, transparent: true, depthWrite: false }));
        const a = (k / 4) * Math.PI * 2;
        s.position.set(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5);
        s.scale.setScalar(0.42);
        ring.add(s);
      }
      d = { until, ring, holder: null };
      this.dizzy.set(id, d);
    }
    d.until = until;
    d.holder = actor.model?.holder ?? null;
    d.ring.position.y = 2.6 * (actor.model?.size ?? 1);
    actor.root.add(d.ring);
  }

  /** Étoiles qui tournent, et le corps qui titube. */
  private updateDizzy(t: number): void {
    const now = performance.now();
    for (const [id, d] of this.dizzy) {
      if (now >= d.until) {
        d.ring.removeFromParent();
        if (d.holder) d.holder.rotation.set(0, d.holder.rotation.y, 0);
        this.dizzy.delete(id);
        continue;
      }
      d.ring.rotation.y = t * 5;
      if (d.holder) { d.holder.rotation.z = Math.sin(t * 7) * 0.13; d.holder.rotation.x = Math.cos(t * 7) * 0.09; }
    }
  }

  private clearDizzy(): void {
    for (const d of this.dizzy.values()) { d.ring.removeFromParent(); if (d.holder) d.holder.rotation.set(0, d.holder.rotation.y, 0); }
    this.dizzy.clear();
  }

  applyTick(tick: MinigameTick, f: Frame): void {
    for (const [id, x, z, yaw, anim] of tick.bots) f.remotes.get(id)?.setTransform({ p: [x, 0, z], r: yaw, a: anim });
    if (!tick.gb || f.phase !== 'mgPlay') return;
    const seen = new Set<number>();
    for (const [id, x, z, yaw, anim, gold] of tick.gb) {
      seen.add(id);
      const v = this.byId.get(id) ?? this.takeGoblin(id, gold === 1, x, z);
      v.target.set(x, 0, z); v.yaw = yaw; v.lostAt = null;
      this.setAnim(v, anim);
    }
    // disparus : sans doute tués (l'annonce suit de près) ; sinon on les rangera bientôt
    for (const [id, v] of this.byId) if (!seen.has(id) && id < 1_000_000 && v.lostAt === null) v.lostAt = f.simTime;
  }

  /** Gobelins tués annoncés par le serveur (une seule fois chacun). */
  private onKills(events: HordeKill[], f: Frame): void {
    for (const e of events) {
      if (e.at < this.lastKill || (e.at === this.lastKill && !this.byId.has(e.goblin))) continue;
      this.lastKill = e.at;
      this.kill(this.byId.get(e.goblin), e);
      if (e.by === f.myId) this.flash = { text: e.gold ? 'Gobelin doré ! +3' : '+1', until: f.simTime + 0.9 };
    }
  }

  update(t: number, dt: number, f: Frame): void {
    this.particles.update(dt);
    this.podium.update(dt);
    this.updateDizzy(t);
    if (f.phase === 'mgPlay' && f.mg.horde) this.onKills(f.mg.horde.events, f);
    for (const v of this.pool) {
      if (!v.root.visible) continue;
      if (v.dying > 0) {
        v.dying -= dt;
        if (v.dying < 0.4) v.model.holder.position.y -= dt * 1.5; // il s'enfonce dans l'herbe
        if (v.dying <= 0) this.releaseGoblin(v);
      } else if (v.lostAt !== null && f.simTime - v.lostAt > 0.4) {
        this.releaseGoblin(v);
        continue;
      } else {
        v.root.position.lerp(v.target, 1 - Math.exp(-12 * dt));
        v.root.rotation.y = angleDamp(v.root.rotation.y, v.yaw, 10, dt);
      }
      if (v.halo) (v.halo.material as THREE.SpriteMaterial).opacity = 0.35 + Math.sin(t * 6 + v.id) * 0.15;
      if (v.gold && v.dying <= 0 && Math.random() < dt * 3) this.particles.burst(v.root.position.x, 1.2, v.root.position.z, '#ffe98a', 1, 0.3, 0.35);
      updateActor(v, t, dt, false);
    }
  }

  /* ================= HUD ================= */

  hud(f: Frame): HudInfo {
    const h = f.mg.horde, mine = h?.points[f.myId] ?? 0;
    const left = Math.max(0, HORDE.durationMs - f.playMs);
    let status: HudInfo['status'] = null;
    if (f.phase === 'mgPlay' && performance.now() < this.myStunUntil) status = { text: 'Étourdi !' };
    else if (this.flash && f.simTime < this.flash.until) status = { text: this.flash.text };
    else if (f.phase === 'mgPlay' && f.playMs < 4500) status = { text: 'E ou clic : coup d’épée · dorés = 3 points · frappe les autres pour les étourdir' };
    return {
      boxes: [
        { label: 'Temps', value: `${Math.ceil(left / 1000)} s`, cls: left < 10_000 ? 'caught' : '' },
        { label: 'Tes points', value: String(f.phase === 'rules' ? this.trainPoints : mine), cls: 'sk' },
      ],
      chip: (id) => ({ text: `${h?.points[id] ?? 0} pts` }),
      status,
    };
  }

  exit(): void {
    this.clearTraining();
    this.clearDizzy();
    for (const v of this.pool) this.releaseGoblin(v);
    this.byId.clear();
  }
}
