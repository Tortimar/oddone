import * as THREE from 'three';
import {
  BOMB, BOMB_HALF, SLOT_COLORS, mazeBoxes, mazeCellAt, mazeCellCenter, mazeNeighbors, mazeWalls,
  type Box, type Maze, type MinigameTick,
} from '@oddone/shared';
import { camera, canvasTexture, gradientMap, part } from '../engine/render.ts';
import { playAnimation, updateActor, type Actor } from '../characters/character.ts';
import { createSkeleton } from '../characters/skeletons.ts';
import { playSfx } from '../audio/audio.ts';
import { look } from '../game/input.ts';
import { setCustomCamera } from '../game/cameraRig.ts';
import { loadKit, type Kit } from '../world/kits.ts';
import { glow } from '../world/outside.ts';
import { buildChandelier } from '../world/tavernDecor.ts';
import type { World } from '../world/tavern.ts';
import { FLOAT_LOSS } from '../world/floatText.ts';
import { Particles, PodiumView, ceilingPlanks } from './effects.ts';
import type { Frame, GameView, HudInfo } from './view.ts';

/**
 * L'arène de « La Bombe du Labyrinthe » : un labyrinthe de donjon fermé (murs, plafond bas, torches),
 * tiré au hasard par le serveur. La bombe flotte au-dessus de celui qui la tient, sa mèche crépite ;
 * dans ses dernières secondes elle clignote en rouge et fait tic-tac (plus fort quand elle est près).
 * Toucher quelqu'un la lui passe : « ! » au-dessus de lui, puis des étoiles (étourdi 1 s).
 * À l'explosion, celui qui la tenait est éliminé : il reste à terre et sa caméra suit la bombe.
 * L'imposteur voit les autres joueurs à travers les murs (silhouettes de couleur).
 */

const CEILING = 4 * BOMB.wallScale;
const HEAD = 2.95;

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

/** La bombe : boule noire, bouchon, mèche et étincelle. */
class BombView {
  readonly group = new THREE.Group();
  private body: THREE.MeshToonMaterial;
  private spark: THREE.Sprite;
  private mats: THREE.Material[] = [];
  private xray = false;

  constructor() {
    this.body = new THREE.MeshToonMaterial({ color: '#25222a', gradientMap, emissive: '#ff2a1a', emissiveIntensity: 0 });
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.34, 20, 14), this.body);
    const capMat = new THREE.MeshToonMaterial({ color: '#8a8f99', gradientMap });
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.12, 12), capMat);
    cap.position.y = 0.36;
    const fuseMat = new THREE.MeshToonMaterial({ color: '#d9c49a', gradientMap });
    const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.26, 6), fuseMat);
    fuse.position.set(0.05, 0.52, 0); fuse.rotation.z = -0.4;
    this.spark = glow('#ffcf5a', 0.35, 0.9);
    this.spark.position.set(0.11, 0.66, 0);
    this.group.add(ball, cap, fuse, this.spark);
    this.mats = [this.body, capMat, fuseMat];
    this.group.visible = false;
  }

  /** Vue à travers les murs (imposteur). */
  setXray(on: boolean): void {
    if (on === this.xray) return;
    this.xray = on;
    for (const m of this.mats) { m.depthTest = !on; m.needsUpdate = true; }
    this.group.traverse((o) => { o.renderOrder = on ? 21 : 0; });
  }

  update(t: number, at: THREE.Vector3 | null, critical: boolean): void {
    this.group.visible = !!at;
    if (!at) return;
    this.group.position.set(at.x, at.y + HEAD + 0.25 + Math.sin(t * 6) * 0.06, at.z);
    this.group.rotation.y = t * 1.5;
    const blink = critical ? (Math.sin(t * 22) > 0 ? 1.4 : 0) : 0;
    this.body.emissiveIntensity = blink;
    this.spark.scale.setScalar((critical ? 0.5 : 0.32) + Math.random() * 0.15);
  }
}

interface Dizzy { until: number; ring: THREE.Group }

export class BombArena implements GameView {
  readonly scene = new THREE.Scene();
  readonly world: World;
  readonly particles: Particles;
  readonly podium: PodiumView;
  /** Caméra du labyrinthe (voir aimCamera) ; la souris la fait tourner et on se déplace par rapport à elle. */
  readonly cameras = { training: 'custom', play: 'custom' } as const;
  readonly thirdPerson = true;
  readonly hideOwnTag = true;
  private camPos = new THREE.Vector3();
  private camTarget = new THREE.Vector3();
  private walls = new THREE.Group();
  private roof = new THREE.Group();
  private boxes: Box[];
  private bomb = new BombView();
  private lantern = new THREE.PointLight('#ffc98a', 7, 13, 1.3);
  private flashLight = new THREE.PointLight('#ffb35c', 0, 22, 1.2);
  private dizzy = new Map<string, Dizzy>();
  private xrays = new Map<string, THREE.Object3D[]>();
  /** Derniers événements déjà montrés. */
  private seenPass = -1;
  private seenBoom = -1;
  private seenRound = '';
  private tickAt = 0;
  private flash: { text: string; until: number; cls?: string } | null = null;
  // entraînement : un mannequin squelette, la bombe passe de l'un à l'autre
  private dummy: Actor & { model: NonNullable<Actor['model']> };
  private train: { holder: 'me' | 'dummy'; fuseEnd: number; backAt: number; stunUntil: number } | null = null;
  private dummyCell: [number, number] = [0, 0];
  private get time(): number { return performance.now() / 1000; }

  private constructor(private maze: Maze, private kit: Kit, dummy: Actor & { model: NonNullable<Actor['model']> }) {
    this.boxes = mazeBoxes(maze);
    this.world = { colliders: this.boxes, circles: [], bounds: { halfX: BOMB_HALF, halfZ: BOMB_HALF } };
    this.build();
    this.particles = new Particles(this.scene);
    this.podium = new PodiumView(this.scene, [...BOMB.podium], this.world, this.particles);
    this.dummy = dummy;
    this.scene.add(dummy.root);
    dummy.root.visible = false;
  }

  static async create(maze: Maze): Promise<BombArena> {
    const [kit, dummy] = await Promise.all([loadKit('dungeon'), createSkeleton('minion')]);
    return new BombArena(maze, kit, dummy);
  }

  /** Au départ, tourné vers le centre du labyrinthe. */
  startYaw(x: number, z: number): number { return Math.atan2(-x, -z); }

  /* ================= Décor ================= */

  private build(): void {
    const s = this.scene, k = this.kit, m = this.maze, W = BOMB.cols * BOMB.cell;
    s.background = new THREE.Color('#0c0807');
    s.fog = new THREE.Fog('#0c0807', 9, 30);
    s.add(new THREE.HemisphereLight('#b9a7d6', '#2e2118', 0.7));
    s.add(this.lantern, this.flashLight);

    // dallage : une grande dalle par case
    for (let r = 0; r < m.rows; r++) for (let c = 0; c < m.cols; c++) {
      const [x, z] = mazeCellCenter(c, r);
      k.spawn('floor_tile_large', { x, z, ry: ((c * 3 + r * 5) % 4) * (Math.PI / 2), parent: s });
    }
    // les murs du labyrinthe (×1,2 : on ne voit pas par-dessus), quelques-uns fissurés
    s.add(this.walls);
    mazeWalls(m).forEach((w, i) => {
      const name = i % 7 === 3 && k.has('wall_cracked') ? 'wall_cracked' : 'wall';
      const o = k.spawn(name, { x: w.x, z: w.z, ry: w.alongX ? 0 : Math.PI / 2, parent: this.walls });
      o.scale.set(1, BOMB.wallScale, 1);
    });
    // un pilier à chaque coin du bord (jonctions nettes)
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const p = k.spawn('pillar', { x: sx * BOMB_HALF, z: sz * BOMB_HALF, parent: this.walls });
      p.scale.set(1, BOMB.wallScale, 1);
    }
    // torches sur une partie des murs (des halos ; quelques vraies lumières)
    let lights = 0;
    mazeWalls(m).forEach((w, i) => {
      if (i % 5 !== 2) return;
      // côté de la case voisine (on décale la torche vers l'intérieur d'une case)
      const side = (i % 2 ? 1 : -1) * 0.5;
      const x = w.x + (w.alongX ? 0 : side), z = w.z + (w.alongX ? side : 0);
      if (Math.abs(x) > BOMB_HALF - 0.4 || Math.abs(z) > BOMB_HALF - 0.4) return;
      const ry = w.alongX ? (side > 0 ? 0 : Math.PI) : (side > 0 ? Math.PI / 2 : -Math.PI / 2);
      k.spawn('torch_mounted', { x, y: 2.4, z, ry, parent: this.walls, shadows: false });
      const flame = glow('#ffae42', 1.3, 0.85);
      flame.position.set(x + Math.sin(ry) * 0.45, 3.05, z + Math.cos(ry) * 0.45);
      this.walls.add(flame);
      if (lights++ % 4 === 0) {
        const l = new THREE.PointLight('#ff9a3c', 5, 9, 1.4);
        l.position.set(x + Math.sin(ry) * 0.9, 3, z + Math.cos(ry) * 0.9);
        this.walls.add(l);
      }
    });
    // le plafond bas, ses poutres, et un lustre au-dessus de la salle du centre
    s.add(this.roof);
    const planks = ceilingPlanks.clone(); planks.repeat.set(8, 8); planks.needsUpdate = true;
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W + 2, W + 2), new THREE.MeshToonMaterial({ map: planks, gradientMap }));
    ceiling.rotation.x = Math.PI / 2; ceiling.position.y = CEILING;
    this.roof.add(ceiling);
    for (let r = 0; r <= m.rows; r += 2) part(this.roof, new THREE.BoxGeometry(W + 1, 0.4, 0.45), '#3d2617', { outline: true, shadow: false }).position.set(0, CEILING - 0.2, (r - m.rows / 2) * BOMB.cell);
    buildChandelier(this.roof as unknown as THREE.Scene, this.kit, 0, CEILING - 2, 0, (c, size, x, y, z, o) => {
      const g = glow(c, size, o); g.position.set(x, y, z); this.roof.add(g); return g;
    });
    const roomLight = new THREE.PointLight('#ffc77a', 6, 12, 1.3);
    roomLight.position.set(0, CEILING - 1.2, 0);
    this.roof.add(roomLight);
    // un peu de bric-à-brac dans la salle du centre
    for (const [name, x, z, ry] of [['barrel_small', -3.1, -3.1, 0.3], ['crates_stacked', 3.1, 3.0, 0.6], ['barrel_small_stack', 3.0, -3.1, Math.PI / 2]] as const) {
      if (k.has(name)) k.spawn(name, { x, z, ry, scale: 0.7, parent: this.walls });
    }
    s.add(this.bomb.group);
  }

  /* ================= Effets ================= */

  private actor(f: Frame, id: string | null | undefined): (Actor & { root: THREE.Object3D }) | null {
    if (!id) return null;
    if (id === f.myId) return f.me;
    return f.remotes.get(id) ?? null;
  }

  /** Étoiles qui tournent au-dessus d'un étourdi. */
  private stars(target: THREE.Object3D, key: string, ms: number): void {
    let d = this.dizzy.get(key);
    if (!d) {
      const ring = new THREE.Group();
      for (let k = 0; k < 4; k++) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: STAR, transparent: true, depthWrite: false }));
        const a = (k / 4) * Math.PI * 2;
        s.position.set(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5);
        s.scale.setScalar(0.42);
        ring.add(s);
      }
      d = { until: 0, ring };
      this.dizzy.set(key, d);
    }
    d.until = performance.now() + ms;
    d.ring.position.y = 2.65;
    target.add(d.ring);
  }

  private updateStars(t: number): void {
    const now = performance.now();
    for (const [key, d] of this.dizzy) {
      if (now >= d.until) { d.ring.removeFromParent(); this.dizzy.delete(key); continue; }
      d.ring.rotation.y = t * 5;
    }
  }

  private explosion(x: number, z: number): void {
    for (const [c, n, spread, size] of [['#ffcf5a', 22, 2.6, 1.3], ['#ff6a1a', 18, 2.2, 1.6], ['#5b4f48', 14, 1.4, 2.2]] as const) this.particles.burst(x, 1.4, z, c, n, spread, size);
    this.flashLight.position.set(x, 2.2, z);
    this.flashLight.intensity = 40;
    this.podium.shake = 1; // (la secousse de caméra du podium sert aussi ici)
  }

  /**
   * Imposteur : la silhouette des autres joueurs, de leur couleur, par-dessus les murs. On double
   * chaque morceau du personnage (mêmes os) avec un matériau qui ignore la profondeur.
   */
  private setXray(f: Frame, on: boolean, out: readonly string[]): void {
    for (const [id, r] of f.remotes) {
      const want = on && !out.includes(id);
      const have = this.xrays.get(id);
      if (!want) { if (have) { for (const o of have) o.removeFromParent(); this.xrays.delete(id); } continue; }
      if (have || !r.model) continue;
      const color = SLOT_COLORS[f.state.players.find((p) => p.id === id)?.slot ?? 0];
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.38, depthTest: false, depthWrite: false, fog: false });
      const made: THREE.Object3D[] = [], originals: THREE.Mesh[] = [];
      r.model.holder.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.parent && (m.material as THREE.Material).side !== THREE.BackSide) originals.push(m); // (pas les contours)
      });
      for (const m of originals) {
        let x: THREE.Mesh;
        if ((m as THREE.SkinnedMesh).isSkinnedMesh) {
          const sk = m as THREE.SkinnedMesh, xs = new THREE.SkinnedMesh(sk.geometry, mat);
          xs.bind(sk.skeleton, sk.bindMatrix);
          x = xs;
        } else x = new THREE.Mesh(m.geometry, mat);
        x.position.copy(m.position); x.quaternion.copy(m.quaternion); x.scale.copy(m.scale);
        x.renderOrder = 20; x.frustumCulled = false;
        m.parent!.add(x);
        made.push(x);
      }
      this.xrays.set(id, made);
    }
  }

  private clearXray(): void {
    for (const list of this.xrays.values()) for (const o of list) o.removeFromParent();
    this.xrays.clear();
  }

  /* ================= Entraînement ================= */

  startTraining(f: Frame): void {
    const [c, r] = mazeCellAt(f.me.root.position.x, f.me.root.position.z);
    const n = mazeNeighbors(this.maze, c, r)[0] ?? [c, r];
    this.dummyCell = n;
    const [x, z] = mazeCellCenter(n[0], n[1]);
    this.dummy.root.position.set(x, 0, z);
    this.dummy.root.rotation.y = Math.atan2(f.me.root.position.x - x, f.me.root.position.z - z);
    this.dummy.root.visible = true;
    playAnimation(this.dummy, 'Idle');
    this.train = { holder: 'me', fuseEnd: this.time + 9, backAt: 0, stunUntil: 0 };
  }

  stopTraining(): void {
    this.train = null;
    this.dummy.root.visible = false;
  }

  private updateTraining(f: Frame): string | null {
    const tr = this.train;
    if (!tr) return null;
    const P = f.me.root.position, D = this.dummy.root.position, now = this.time;
    let say: string | null = null;
    if (tr.holder === 'me' && now > tr.stunUntil && Math.hypot(P.x - D.x, P.z - D.z) < BOMB.passRadius) {
      tr.holder = 'dummy'; tr.backAt = now + 2.4;
      this.stars(this.dummy.root, 'dummy', BOMB.stunMs);
      playSfx('coup');
      say = 'Passée !';
    } else if (tr.holder === 'dummy' && now >= tr.backAt) {
      tr.holder = 'me'; tr.stunUntil = now + BOMB.stunMs / 1000;
      f.float(f.myId, '!', FLOAT_LOSS);
      this.stars(f.me.root, f.myId, BOMB.stunMs);
      playSfx('coup');
      say = 'Le squelette te la renvoie !';
    }
    if (now >= tr.fuseEnd) {
      const at = tr.holder === 'me' ? P : D;
      this.explosion(at.x, at.z);
      playSfx('erreur', { volume: 1.3 });
      say = tr.holder === 'me' ? 'Boum ! (pour de faux, cette fois)' : 'Boum ! Le squelette a sauté.';
      tr.holder = 'me'; tr.fuseEnd = now + 9; tr.stunUntil = 0;
    }
    return say;
  }

  /* ================= Partie ================= */

  onPhase(f: Frame): void {
    if (f.phase === 'mgResults') {
      // le podium tombe au centre : on enlève murs et plafond pour le voir
      this.walls.visible = false; this.roof.visible = false;
      this.world.colliders = [];
      this.bomb.group.visible = false;
      this.clearXray();
      for (const d of this.dizzy.values()) d.ring.removeFromParent();
      this.dizzy.clear();
      f.me.clearPose();
    }
  }

  beforeMove(f: Frame): void {
    f.me.speedMul = 1;
    if (f.phase === 'rules') { if (this.train && this.time < this.train.stunUntil) f.me.frozen = true; return; }
    const b = f.mg.bomb;
    if (!b) { f.me.frozen = true; return; }
    const out = b.out.includes(f.myId), stunned = f.playMs < (b.stunned[f.myId] ?? 0);
    if (out || stunned || b.stage !== 'play') f.me.frozen = true;
  }

  afterMove(f: Frame): string | null {
    return f.phase === 'rules' ? this.updateTraining(f) : null;
  }

  applyTick(tick: MinigameTick, f: Frame): void {
    for (const [id, x, z, yaw, anim] of tick.bots) f.remotes.get(id)?.setTransform({ p: [x, 0, z], r: yaw, a: anim });
  }

/** Part (0..1) du trajet à plat de (x0, z0) à (x1, z1) parcourue avant le premier mur. */
  private clearPath(x0: number, z0: number, x1: number, z1: number): number {
    const pad = 0.3, steps = 20;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps, x = x0 + (x1 - x0) * k, z = z0 + (z1 - z0) * k;
      if (this.boxes.some((b) => x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad)) return Math.max(0, (i - 1) / steps);
    }
    return 1;
  }

  /**
   * La caméra du labyrinthe : derrière le personnage, à hauteur d'épaule (un peu à droite), et elle
   * regarde devant lui, le long du couloir. Un mur derrière : elle se rapproche (sans passer au-dessus).
   * Éliminé : elle suit la bombe (ou un survivant).
   */
  private aimCamera(f: Frame): void {
    const b = f.mg.bomb;
    const out = f.phase === 'mgPlay' && !!b?.out.includes(f.myId);
    const P = (out ? this.actor(f, b!.holder ?? b!.alive[0])?.root.position : null) ?? f.me.root.position;
    const yaw = look.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    // par-dessus l'épaule droite : la tête (et la bombe au-dessus) restent sur le côté de l'image
    const back = 3.2, side = 0.8, ahead = 2.6, rx = -fz, rz = fx;
    const wx = P.x - fx * back + rx * side, wz = P.z - fz * back + rz * side;
    const k = this.clearPath(P.x, P.z, wx, wz);
    this.camPos.set(P.x + (wx - P.x) * k, P.y + 2.6, P.z + (wz - P.z) * k);
    this.camTarget.set(P.x + fx * ahead + rx * side * 0.4, P.y + 1.8, P.z + fz * ahead + rz * side * 0.4);
    setCustomCamera(this.camPos, this.camTarget, camera.aspect < 1 ? 78 : 62, 9);
  }

  /** Événements de la partie : manche, passage, explosion. */
  private syncPlay(f: Frame): void {
    const b = f.mg.bomb!;
    // nouvelle manche : chacun dans son coin
    const roundKey = `${b.round}|${b.stageAt}`;
    if (b.stage === 'intro' && this.seenRound !== roundKey) {
      this.seenRound = roundKey;
      const spawn = b.spawns[f.myId];
      if (spawn && b.alive.includes(f.myId)) {
        const yaw = Math.atan2(-spawn[0], -spawn[1]);
        f.me.placeAt(spawn[0], spawn[1], yaw);
        look.yaw = yaw + Math.PI; // (caméra derrière soi, face au labyrinthe)
        f.me.clearPose();
      }
      for (const id of Object.keys(b.spawns)) f.remotes.get(id)?.snapNext();
      const who = b.holder === f.myId ? 'Tu as la bombe !' : `${this.name(f, b.holder)} a la bombe !`;
      this.flash = { text: `Manche ${b.round} sur ${b.rounds} — ${who}`, until: this.time + BOMB.introMs / 1000, cls: b.holder === f.myId ? 'caught' : undefined };
      if (b.round > 1) playSfx('annonce', { duck: 1 });
    }
    if (b.pass && b.pass.at !== this.seenPass) {
      this.seenPass = b.pass.at;
      const to = this.actor(f, b.pass.to);
      if (f.playMs - b.pass.at < 1500 && to) {
        f.float(b.pass.to, '!', FLOAT_LOSS);
        this.stars(to.root, b.pass.to, BOMB.stunMs);
        if (b.pass.to === f.myId) { this.flash = { text: 'On t’a refilé la bombe !', until: this.time + 1.6, cls: 'caught' }; playSfx('coup', { volume: 1.3 }); }
        else if (b.pass.from === f.myId) { this.flash = { text: 'Passée ! Sauve-toi !', until: this.time + 1.4 }; playSfx('coup'); }
        else playSfx('coup', { volume: 0.5 });
      }
    }
    if (b.boom && b.boom.at !== this.seenBoom) {
      this.seenBoom = b.boom.at;
      if (f.playMs - b.boom.at < 2000) {
        this.explosion(b.boom.x, b.boom.z);
        playSfx('erreur', { volume: 1.5, duck: 1.5 });
        if (b.boom.id === f.myId) { f.me.playPose('Death_A', { hold: true }); this.flash = { text: 'Boum ! Tu as sauté… la caméra suit la bombe.', until: this.time + 3, cls: 'caught' }; }
        else this.flash = { text: `Boum ! ${this.name(f, b.boom.id)} a sauté !`, until: this.time + 3 };
      }
    }
  }

  private name(f: Frame, id: string | null | undefined): string {
    if (id === f.myId) return 'Toi';
    return f.state.players.find((p) => p.id === id)?.name ?? '?';
  }

  update(t: number, dt: number, f: Frame): void {
    this.particles.update(dt);
    this.podium.update(dt);
    this.updateStars(t);
    this.flashLight.intensity = Math.max(0, this.flashLight.intensity - dt * 90);
    // la lanterne du joueur (on voit ses couloirs)
    const P = f.me.root.position;
    this.lantern.position.set(P.x, 3, P.z);
    if (f.phase !== 'mgResults') this.aimCamera(f);
    if (f.phase === 'rules') {
      updateActor(this.dummy, t, dt, false);
      const tr = this.train, at = tr ? (tr.holder === 'me' ? P : this.dummy.root.position) : null;
      this.bomb.update(t, at, !!tr && tr.fuseEnd - this.time < 3);
      return;
    }
    const b = f.mg.bomb;
    if (f.phase !== 'mgPlay' || !b) { this.bomb.update(t, null, false); return; }
    this.syncPlay(f);
    const holder = this.actor(f, b.stage === 'boom' ? null : b.holder);
    this.bomb.update(t, holder?.root.position ?? null, b.critical);
    // l'imposteur voit les autres (et la bombe) à travers les murs
    this.setXray(f, f.imposter, b.out);
    this.bomb.setXray(f.imposter);
    // tic-tac des dernières secondes, plus fort quand la bombe est près
    if (b.critical && b.stage === 'play' && holder && this.time >= this.tickAt) {
      this.tickAt = this.time + 0.5;
      const d = Math.hypot(holder.root.position.x - P.x, holder.root.position.z - P.z);
      playSfx('tick', { volume: b.holder === f.myId ? 1.4 : Math.max(0.15, 1 - d / 22) });
    }
  }

  /* ================= HUD ================= */

  hud(f: Frame): HudInfo {
    const b = f.mg.bomb, me = f.myId;
    const mine = b?.holder === me, out = !!b?.out.includes(me), stunned = !!b && f.playMs < (b.stunned[me] ?? 0);
    let status: HudInfo['status'] = null;
    if (this.flash && this.time < this.flash.until) status = { text: this.flash.text, cls: this.flash.cls };
    else if (!b || f.phase !== 'mgPlay') status = null;
    else if (out) status = { text: 'Éliminé… la caméra suit la bombe.' };
    else if (stunned) status = { text: 'Étourdi !', cls: 'caught' };
    else if (mine) status = { text: b.critical ? 'ELLE VA SAUTER ! Touche quelqu’un, vite !' : 'Tu as la bombe ! Touche quelqu’un pour t’en débarrasser.', cls: 'caught' };
    else if (b.critical) status = { text: `Elle va sauter… ${this.name(f, b.holder)} la tient encore !` };
    return {
      boxes: [
        { label: 'Manche', value: b ? `${b.round} / ${b.rounds}` : '1', cls: 'sk' },
        { label: 'La bombe', value: f.phase === 'rules' ? (this.train?.holder === 'dummy' ? 'Squelette' : 'Toi !') : mine ? 'Toi !' : b?.holder ? this.name(f, b.holder) : '—', cls: mine || (f.phase === 'rules' && this.train?.holder === 'me') ? 'caught' : '' },
      ],
      chip: (id) => {
        if (!b) return { text: '' };
        if (b.out.includes(id)) return { text: `Sauté (manche ${b.outRound[id] ?? 1})`, cls: 'fall' };
        if (b.holder === id) return { text: 'La bombe !', cls: 'cursed' };
        if (f.playMs < (b.stunned[id] ?? 0)) return { text: 'Étourdi' };
        return { text: 'En fuite' };
      },
      status,
      vignette: mine && !!b?.critical,
    };
  }

  exit(): void {
    this.stopTraining();
    this.clearXray();
    for (const d of this.dizzy.values()) d.ring.removeFromParent();
    this.dizzy.clear();
  }
}
