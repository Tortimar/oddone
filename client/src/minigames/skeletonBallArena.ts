import * as THREE from 'three';
import {
  SKELETON_BALL as SB, arenaBoxes, dist, formatSurvival, graveExit, pushOut, skeletonSpeed, steer,
  type MinigameTick, type SkeletonArena,
} from '@oddone/shared';
import { angleDamp, canvasTexture, gradientMap } from '../engine/render.ts';
import { Particles, PodiumView } from './effects.ts';
import type { Frame, GameView, HudInfo } from './view.ts';
import { CLIPS } from '../characters/library.ts';
import { playAnimation, updateActor, type Actor } from '../characters/character.ts';
import { createSkeleton, type SkeletonKind } from '../characters/skeletons.ts';
import { loadKit, type Kit } from '../world/kits.ts';
import { glow } from '../world/outside.ts';
import type { World } from '../world/tavern.ts';

/**
 * L'arène du « Bal des Squelettes » : un cimetière de nuit (kit halloween), les squelettes
 * (positions envoyées par le serveur), les effets (maudits, sorties de terre, coups, téléportations),
 * le squelette d'entraînement de l'écran des règles (simulé ici, sans enjeu) et le podium
 * des résultats qui tombe du ciel.
 */

/** Un seul modèle de squelette : on les reconnaît d'un coup d'œil. */
const KINDS: SkeletonKind[] = ['minion'];

interface SkeletonView extends Actor {
  target: THREE.Vector3;
  yaw: number;
  active: boolean;
  rising: boolean;
  dust: THREE.Sprite;
  dustLife: number;
}

interface CurseMark { ring: THREE.Mesh; skull: THREE.Object3D; light: THREE.Sprite }

/** Joueur tel que l'arène a besoin de le voir. */
interface ArenaPlayer { id: string; root: THREE.Object3D; cursed: boolean }

const ringTexture = canvasTexture(128, 128, (g, w) => {
  const grad = g.createRadialGradient(w / 2, w / 2, w * 0.18, w / 2, w / 2, w / 2);
  grad.addColorStop(0, 'rgba(120,255,140,0)');
  grad.addColorStop(0.55, 'rgba(120,255,140,.9)');
  grad.addColorStop(0.7, 'rgba(60,200,90,.5)');
  grad.addColorStop(1, 'rgba(40,160,60,0)');
  g.fillStyle = grad; g.fillRect(0, 0, w, w);
});
/** Sol peint à la main : taches de terre et touffes d'herbe (répété en mosaïque). */
function groundTexture(base: string, dark: string, light: string, grass: number): THREE.CanvasTexture {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const tex = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) {
      g.fillStyle = rnd() < 0.5 ? dark : light;
      g.globalAlpha = 0.35 + rnd() * 0.3;
      const x = rnd() * w, y = rnd() * h, r = 6 + rnd() * 22;
      for (const [dx, dy] of [[0, 0], [w, 0], [-w, 0], [0, h], [0, -h]]) { g.beginPath(); g.ellipse(x + dx, y + dy, r, r * 0.7, rnd() * 3, 0, 7); g.fill(); }
    }
    g.globalAlpha = 1;
    g.strokeStyle = '#4f6a3a'; g.lineWidth = 2;
    for (let i = 0; i < 140 * grass; i++) {
      const x = rnd() * w, y = rnd() * h;
      for (let k = -1; k <= 1; k++) { g.beginPath(); g.moveTo(x, y); g.lineTo(x + k * 3, y - 5 - rnd() * 4); g.stroke(); }
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export class SkeletonBallArena implements GameView {
  readonly scene = new THREE.Scene();
  readonly world: World;
  readonly particles: Particles;
  readonly podium: PodiumView;
  readonly cameras = { training: 'training', play: 'arena' } as const;
  // joueur local : touché → sonné un instant, puis maudit (plus lent)
  private wasCaught = false;
  private stunUntil = 0;
  private skeletons: SkeletonView[] = [];
  private marks = new Map<string, CurseMark>();
  private flickers: { light: THREE.PointLight; base: number; f: number }[] = [];
  private trainer: SkeletonView | null = null;
  private trainerState: 'rising' | 'chasing' | 'falling' = 'rising';
  private trainerTimer = 0;
  private trainerPos = { x: 0, z: 0 };

  private constructor(readonly arena: SkeletonArena, private kit: Kit) {
    this.world = { colliders: arenaBoxes(arena), circles: [], bounds: SB.bounds };
    this.buildDecor();
    this.particles = new Particles(this.scene);
    // les squelettes effondrés disparaissent dans la poussière quand le podium se pose
    this.podium = new PodiumView(this.scene, [0, 0], this.world, this.particles, () => this.clearSkeletons());
  }

  static async create(arena: SkeletonArena): Promise<SkeletonBallArena> {
    const a = new SkeletonBallArena(arena, await loadKit('halloween'));
    // tous les squelettes sont préparés d'avance : pas d'à-coup quand ils sortent de terre
    const views = await Promise.all(Array.from({ length: SB.maxSkeletons + 1 }, (_, i) => createSkeleton(KINDS[i % KINDS.length])));
    for (const v of views) {
      const view: SkeletonView = { ...v, target: new THREE.Vector3(), yaw: 0, active: false, rising: false, dust: glow('#9cff9c', 3.2, 0), dustLife: 0 };
      view.root.visible = false;
      view.dust.visible = false;
      a.scene.add(view.root, view.dust);
      a.skeletons.push(view);
    }
    a.trainer = a.skeletons.pop()!;
    return a;
  }

  /* ================= Décor ================= */

  private buildDecor(): void {
    const s = this.scene, kit = this.kit, { halfX: HX, halfZ: HZ } = SB.bounds;
    const put = (name: string, x: number, z: number, ry = 0, scale = 1) => kit.spawn(name, { x, z, ry, scale, parent: s });

    s.background = new THREE.Color('#171433');
    s.fog = new THREE.Fog('#171433', 34, 75);
    s.add(new THREE.HemisphereLight('#aab6ff', '#4a3426', 1.9));
    const moon = new THREE.DirectionalLight('#d6deff', 1.7);
    moon.position.set(-8, 22, 10);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    Object.assign(moon.shadow.camera, { left: -17, right: 17, top: 15, bottom: -15, near: 1, far: 60 });
    moon.shadow.bias = -0.0008;
    s.add(moon);
    const moonDisc = glow('#e8ecff', 9, 0.9);
    moonDisc.position.set(-22, 26, -40);
    s.add(moonDisc);

    // sol : terre battue du cimetière, puis une plaine d'herbe sombre jusqu'à l'horizon
    const dirt = new THREE.Mesh(new THREE.PlaneGeometry(HX * 2 + 3, HZ * 2 + 3), new THREE.MeshToonMaterial({ map: groundTexture('#6d5e4c', '#5b4d3d', '#7a6a55', 0.25), gradientMap }));
    dirt.material.map!.repeat.set(5, 4);
    dirt.rotation.x = -Math.PI / 2; dirt.position.y = 0.01; dirt.receiveShadow = true;
    s.add(dirt);
    const plain = new THREE.Mesh(new THREE.CircleGeometry(80, 48), new THREE.MeshToonMaterial({ map: groundTexture('#39462f', '#2f3b27', '#45543a', 0.6), gradientMap }));
    plain.material.map!.repeat.set(24, 24);
    plain.rotation.x = -Math.PI / 2; plain.receiveShadow = true;
    s.add(plain);
    // allée de dalles au départ
    for (const [x, z, n] of [[0, -1.6, 'path_A'], [-1.9, 0.4, 'path_B'], [1.9, 0.4, 'path_C'], [0, 2.3, 'path_D']] as const) put(n, x, z, x * 0.7);

    // clôture : haute au fond et sur les côtés, basse devant pour ne pas cacher les joueurs
    for (const x of [-10, -6, 6, 10]) put(x === -6 ? 'fence_broken' : 'fence', x, -HZ - 0.3);
    put('arch_gate', 0, -HZ - 0.3, 0, 1.9);
    for (const x of [-10, -6, -2, 2, 6, 10]) put(x === 2 ? 'fence_broken' : 'fence', x, HZ + 0.3).scale.y = 0.55;
    for (const side of [-1, 1]) {
      for (const z of [-6.75, -2.25, 2.25, 6.75]) put(z === 2.25 && side > 0 ? 'fence_broken' : 'fence', side * (HX + 0.3), z, Math.PI / 2).scale.x = 1.125;
      for (const z of [-HZ - 0.3, -4.5, 0, 4.5]) put('fence_pillar', side * (HX + 0.3), z);
      put('fence_pillar', side * (HX + 0.3), HZ + 0.3).scale.y = 0.6;
    }
    for (const x of [-8, -4, 4, 8]) put('fence_pillar', x, -HZ - 0.3);
    for (const x of [-8, -4, 0, 4, 8]) put('fence_pillar_broken', x, HZ + 0.3).scale.y = 0.75;

    // fond : crypte, arbres morts, sapins d'automne
    put('crypt', 0, -HZ - 6.5);
    const trees: [string, number, number, number][] = [
      ['tree_pine_orange_large', -10, -14, 0.3], ['tree_pine_yellow_large', 9, -15, 1.2], ['tree_pine_orange_medium', -16, -9, 2],
      ['tree_pine_yellow_medium', 16, -8, 0.6], ['tree_dead_large', -6, -13, 0.4], ['tree_dead_large_decorated', 6, -12.5, 2.4],
      ['tree_dead_medium', -15.5, -2, 1], ['tree_dead_medium', 15.5, 1, 2.2], ['tree_pine_orange_small', -15, 5, 0.2],
      ['tree_pine_yellow_small', 15, 6.5, 1.4], ['tree_pine_orange_large', -21, -16, 1], ['tree_pine_yellow_large', 21, -17, 0.2],
      ['tree_dead_small', -14, 11, 0.8], ['tree_dead_small', 14.5, 11.5, 2],
    ];
    for (const [n, x, z, r] of trees) put(n, x, z, r);
    for (const [x, z, r] of [[-HX - 1.4, -HZ - 1.4, 0.6], [HX + 1.4, -HZ - 1.4, -0.6], [-HX - 1.4, HZ + 1.2, 2.4], [HX + 1.4, HZ + 1.2, -2.4]] as const) {
      put('post_lantern', x, z, r);
      this.lamp('#ffb35c', 7, 14, x, 2.9, z, 0.15);
    }
    put('shrine_candles', -3.4, -HZ - 1.2);
    put('shrine_candles', 3.4, -HZ - 1.2);
    this.lamp('#ff9a3c', 4, 9, 0, 2, -HZ - 1);
    for (const [n, x, z, r] of [['pumpkin_orange_jackolantern', -HX - 1.2, 3, 1.2], ['pumpkin_yellow_jackolantern', HX + 1.3, -3.5, -1.4], ['pumpkin_orange', -HX - 1.5, -5, 0], ['pumpkin_yellow_small', HX + 1.1, 4.5, 0.5], ['skull_candle', -HX - 1.3, -1, 0.9], ['ribcage', HX + 1.4, 1.5, 1]] as const) put(n, x, z, r);

    // les tombes du terrain (identiques pour tous, envoyées par le serveur)
    this.arena.graves.forEach((g, i) => {
      put(g.kind, g.x, g.z, g.rot);
      // de petites bougies et des os autour de certaines tombes (sans collision : trop petits)
      const ex = graveExit(g), side = i % 2 ? 1 : -1;
      if (i % 3 === 0) put('candle_triple', g.x + Math.cos(g.rot) * (g.hx + 0.25) * side, g.z - Math.sin(g.rot) * (g.hz + 0.25) * side, i);
      if (i % 4 === 1) put(i % 8 === 1 ? 'bone_A' : 'bone_C', ex.x + side * 0.6, ex.z, i * 0.7).position.y = 0.1;
    });
  }

  private lamp(color: string, intensity: number, distance: number, x: number, y: number, z: number, f = 0): void {
    const l = new THREE.PointLight(color, intensity, distance, 1.4);
    l.position.set(x, y, z);
    this.scene.add(l);
    const halo = glow(color, 2.4, 0.55);
    halo.position.set(x, y, z);
    this.scene.add(halo);
    if (f) this.flickers.push({ light: l, base: intensity, f });
  }

  /* ================= Squelettes de la partie ================= */

  /** Nouvelles positions reçues du serveur. */
  private applySkeletons(tick: MinigameTick): void {
    tick.sk.forEach(([x, z, yaw, rising], i) => {
      const v = this.skeletons[i];
      if (!v) return;
      v.target.set(x, 0, z); v.yaw = yaw;
      if (!v.active) {
        v.active = true; v.root.visible = true;
        v.root.position.set(x, 0, z); v.root.rotation.y = yaw;
        this.rise(v);
      }
      if (v.rising && !rising) { v.rising = false; this.run(v); }
    });
  }

  /** Fin de partie : les squelettes s'effondrent. */
  collapse(): void {
    for (const v of this.skeletons) if (v.active) playAnimation(v, 'Death_C_Skeletons', { once: true, fade: 0.2, restart: true });
  }

  get activeSkeletons(): number { return this.skeletons.filter((v) => v.active).length; }

  /** Retire tous les squelettes (nouvelle partie, entraînement). */
  clearSkeletons(): void {
    for (const v of this.skeletons) { v.active = false; v.root.visible = false; v.dust.visible = false; v.rising = false; }
  }

  private rise(v: SkeletonView): void {
    v.rising = true;
    const clip = CLIPS.Spawn_Ground_Skeletons;
    playAnimation(v, 'Spawn_Ground_Skeletons', { once: true, restart: true, fade: 0, speed: clip ? clip.duration / (SB.riseMs / 1000) : 1 });
    v.dust.position.set(v.root.position.x, 0.4, v.root.position.z);
    v.dust.visible = true; v.dustLife = 1;
  }

  /** Démarche de zombie : ils marchent, en traînant les pieds. */
  private run(v: SkeletonView): void {
    playAnimation(v, 'Walking_A', { fade: 0.25 });
    v.current?.setEffectiveTimeScale(1.25);
  }

  private updateView(v: SkeletonView, t: number, dt: number, follow: boolean): void {
    if (!v.root.visible) return;
    if (follow) {
      v.root.position.lerp(v.target, 1 - Math.exp(-12 * dt));
      v.root.rotation.y = angleDamp(v.root.rotation.y, v.yaw, 10, dt);
    }
    if (v.dustLife > 0) {
      v.dustLife -= dt / 1.6;
      v.dust.material.opacity = Math.max(0, Math.sin(Math.min(1, v.dustLife) * Math.PI)) * 0.8;
      v.dust.scale.setScalar(2 + (1 - v.dustLife) * 2);
      if (v.dustLife <= 0) v.dust.visible = false;
    }
    updateActor(v, t, dt, false);
  }

  /* ================= Entraînement (écran des règles) ================= */

  /** Un squelette d'entraînement sort de la tombe la plus éloignée du joueur. */
  startTraining(f: Frame): void { this.spawnTrainer({ x: f.me.root.position.x, z: f.me.root.position.z }); }

  private spawnTrainer(from: { x: number; z: number }): void {
    const t = this.trainer!;
    const exits = this.arena.graves.map(graveExit).sort((a, b) => dist(b, from) - dist(a, from));
    const pick = exits[Math.floor(Math.random() * Math.min(3, exits.length))] ?? { x: 0, z: -6 };
    pushOut(pick, SB.bounds, this.world.colliders, [], 0.45);
    this.trainerPos = { x: pick.x, z: pick.z };
    t.root.position.set(pick.x, 0, pick.z);
    t.root.rotation.y = Math.atan2(from.x - pick.x, from.z - pick.z);
    t.root.visible = true; t.active = true;
    this.rise(t);
    this.trainerState = 'rising'; this.trainerTimer = SB.riseMs / 1000;
  }

  stopTraining(): void { if (this.trainer) { this.trainer.root.visible = false; this.trainer.active = false; this.trainer.dust.visible = false; } }

  /** Avance l'entraînement ; renvoie true quand le squelette touche le joueur (rien de grave ici). */
  private updateTraining(dt: number, me: { x: number; z: number }): boolean {
    const t = this.trainer;
    if (!t?.active) return false;
    this.trainerTimer -= dt;
    if (this.trainerState === 'rising') {
      if (this.trainerTimer <= 0) { this.trainerState = 'chasing'; t.rising = false; this.run(t); }
      return false;
    }
    if (this.trainerState === 'falling') {
      if (this.trainerTimer <= 0) this.spawnTrainer(me);
      return false;
    }
    const p = this.trainerPos;
    const yaw = steer(p, Math.atan2(me.x - p.x, me.z - p.z), skeletonSpeed(0) * dt, SB.bounds, this.world.colliders, [], 0.45);
    t.root.position.set(p.x, 0, p.z);
    t.root.rotation.y = angleDamp(t.root.rotation.y, yaw, 10, dt);
    if (dist(p, me) < SB.tagRadius) {
      this.trainerState = 'falling';
      this.trainerTimer = playAnimation(t, 'Death_C_Skeletons', { once: true, fade: 0.1, restart: true }) + 0.4;
      return true;
    }
    return false;
  }

  /* ================= Effets sur les joueurs ================= */

  private mark(p: ArenaPlayer): CurseMark {
    let m = this.marks.get(p.id);
    if (!m) {
      const ring = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 2.2), new THREE.MeshBasicMaterial({ map: ringTexture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.06;
      const skull = this.kit.create('skull');
      skull.scale.setScalar(0.5);
      skull.position.y = 3.65;
      const light = glow('#7dff8a', 1.6, 0.7);
      light.position.y = 3.85;
      m = { ring, skull, light };
      this.marks.set(p.id, m);
    }
    if (m.ring.parent !== p.root) p.root.add(m.ring, m.skull, m.light);
    return m;
  }

  /** Retire les marques ajoutées aux personnages (retour à la taverne). */
  clearMarks(): void {
    for (const m of this.marks.values()) { m.ring.removeFromParent(); m.skull.removeFromParent(); m.light.removeFromParent(); }
  }

  update(t: number, dt: number, f: Frame): void {
    for (const v of this.skeletons) this.updateView(v, t, dt, true);
    if (this.trainer) this.updateView(this.trainer, t, dt, false);
    for (const fl of this.flickers) fl.light.intensity = fl.base * (0.85 + 0.15 * Math.sin(t * 9 + fl.f * 40) * Math.sin(t * 5.3));
    this.particles.update(dt);
    this.podium.update(dt);
    const show = f.phase === 'mgPlay' || f.phase === 'mgCountdown';
    const players: ArenaPlayer[] = [{ id: f.myId, root: f.me.root, cursed: show && !!f.mg.caught[f.myId] }];
    for (const [id, r] of f.remotes) players.push({ id, root: r.root, cursed: show && !!f.mg.caught[id] });
    for (const p of players) {
      if (p.cursed) {
        const m = this.mark(p);
        m.ring.visible = m.skull.visible = m.light.visible = true;
        const k = 0.85 + 0.15 * Math.sin(t * 6);
        m.ring.scale.setScalar(k);
        m.skull.rotation.y = t * 2.2;
        m.skull.position.y = 3.65 + Math.sin(t * 3) * 0.1;
      } else {
        const m = this.marks.get(p.id);
        if (m) m.ring.visible = m.skull.visible = m.light.visible = false;
      }
    }
  }

  /* ================= Règles propres au Bal des Squelettes ================= */

  onPhase(f: Frame): void {
    if (f.phase === 'roleReveal' || f.phase === 'mgCountdown') { this.stopTraining(); this.clearSkeletons(); this.wasCaught = false; this.stunUntil = 0; }
    if (f.phase === 'mgResults') { this.collapse(); this.clearMarks(); }
  }

  beforeMove(f: Frame): void {
    const caught = !!f.mg.caught[f.myId];
    if (caught && !this.wasCaught && f.phase === 'mgPlay') {
      this.stunUntil = f.simTime + SB.curseStunMs / 1000;
      f.me.playPose('Hit_B');
    }
    this.wasCaught = caught;
    if (f.simTime < this.stunUntil) f.me.frozen = true;
    f.me.speedMul = caught && f.phase === 'mgPlay' ? SB.cursedSpeedMul : 1;
    f.me.walkAnim = caught && f.phase === 'mgPlay'; // maudit : il marche comme un zombie
  }

  afterMove(f: Frame, dt: number): string | null {
    if (f.phase !== 'rules') return null;
    const P = f.me.root.position;
    if (this.updateTraining(dt, { x: P.x, z: P.z })) { f.me.playPose('Hit_A'); return 'Touché !'; }
    return null;
  }

  applyTick(tick: MinigameTick, f: Frame): void {
    this.applySkeletons(tick);
    for (const [id, x, z, yaw, anim] of tick.bots) f.remotes.get(id)?.setTransform({ p: [x, 0, z], r: yaw, a: anim });
  }

  hud(f: Frame): HudInfo {
    const mine = f.mg.caught[f.myId];
    const elapsed = f.phase === 'mgPlay' ? f.playMs : f.phase === 'mgResults' ? Math.max(0, ...(f.mg.results ?? []).map((r) => r.survivedMs)) : 0;
    let status: HudInfo['status'] = null;
    if (f.phase === 'mgPlay' && mine) {
      status = { text: f.simTime < this.stunUntil ? 'Touché ! Tu te relèves… maudit.' : 'Tu es maudit ! Touche les autres aventuriers.', cls: 'cursed' };
    } else if (f.phase === 'mgPlay' && f.playMs < 4000) status = { text: 'Ne te fais pas toucher !' };
    return {
      boxes: [
        { label: mine ? 'Touché à' : 'Survie', value: formatSurvival(mine ? mine.at : elapsed), cls: mine ? 'caught' : '' },
        { label: 'Squelettes', value: String(this.activeSkeletons), cls: 'sk' },
      ],
      chip: (id) => { const c = f.mg.caught[id]; return c ? { text: `Maudit · ${formatSurvival(c.at)}`, cls: 'cursed' } : { text: 'Libre' }; },
      status,
      vignette: !!mine && f.phase === 'mgPlay',
    };
  }

  exit(): void { this.clearMarks(); this.stopTraining(); }
}
