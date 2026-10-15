import * as THREE from 'three';
import {
  DEFAULT_CONFIG, GORGON, GORGON_STARTS, GRAVE_SCALE, coverBox, gorgonSees, randomConfig,
  type CharacterConfig, type GorgonField, type GorgonStage, type MinigameSecret, type MinigameTick,
} from '@oddone/shared';
import { camera, canvasTexture, gradientMap, part } from '../engine/render.ts';
import { playAnimation, setActorModel, updateActor, type Actor } from '../characters/character.ts';
import { playSfx } from '../audio/audio.ts';
import { look } from '../game/input.ts';
import { setCustomCamera } from '../game/cameraRig.ts';
import { loadKit, type Kit } from '../world/kits.ts';
import { glow } from '../world/outside.ts';
import type { World } from '../world/tavern.ts';
import { FLOAT_LOSS } from '../world/floatText.ts';
import { Particles, PodiumView } from './effects.ts';
import type { Frame, GameView, HudInfo } from './view.ts';

/**
 * L'arène du « Regard de la Gorgone » : une longue allée de cimetière, des tombes (agrandies, à
 * hauteur d'homme) et des statues de héros pétrifiés avant vous, et au fond, sur son estrade devant
 * la crypte, la Gorgone géante (un héros du kit ×3,4, peau verte, chevelure de serpents).
 * De dos : on avance. Elle se retourne (ses yeux s'allument, une lueur rouge balaie l'allée) :
 * qui bouge en vue est pétrifié (le personnage devient une statue grise, figé dans sa pose).
 * La caméra est derrière le joueur, par-dessus l'épaule, comme dans le labyrinthe.
 * L'imposteur voit, dans le coin de l'écran, dans combien de temps elle va se retourner.
 */

const STONE = new THREE.MeshToonMaterial({ color: '#9d9a92', gradientMap });
/** Taille de la Gorgone (un héros du kit fait environ 2,5). */
const GORGON_SCALE = 3.4;
const GORGON_CFG: CharacterConfig = { ...DEFAULT_CONFIG, body: 'mage', head: 'mage', hat: 'none', cape: 'none', hue: 150, skin: '#7fb86a' };

const ground = canvasTexture(128, 128, (g, w, h) => {
  g.fillStyle = '#4d4338'; g.fillRect(0, 0, w, h);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let k = 0; k < 500; k++) {
    g.fillStyle = ['#574b3e', '#463c32', '#5e5244', '#3f4a35'][k % 4];
    g.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 4, 2 + rnd() * 3);
  }
});
ground.wrapS = ground.wrapT = THREE.RepeatWrapping;

const seeded = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

/** Un personnage changé en pierre : ses morceaux doublés en gris (mêmes os), les vrais cachés, l'animation figée. */
interface Stone { actor: Actor; made: THREE.Object3D[]; hidden: THREE.Object3D[] }

function petrify(actor: Actor): Stone | null {
  const model = actor.model;
  if (!model) return null;
  const originals: THREE.Mesh[] = [];
  model.holder.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.parent && m.visible && (m.material as THREE.Material).side !== THREE.BackSide) originals.push(m);
  });
  const made: THREE.Object3D[] = [];
  for (const m of originals) {
    let x: THREE.Mesh;
    if ((m as THREE.SkinnedMesh).isSkinnedMesh) {
      const sk = m as THREE.SkinnedMesh, xs = new THREE.SkinnedMesh(sk.geometry, STONE);
      xs.bind(sk.skeleton, sk.bindMatrix);
      x = xs;
    } else x = new THREE.Mesh(m.geometry, STONE);
    x.position.copy(m.position); x.quaternion.copy(m.quaternion); x.scale.copy(m.scale);
    x.castShadow = x.receiveShadow = true; x.frustumCulled = false;
    m.parent!.add(x);
    m.visible = false;
    made.push(x);
  }
  model.mixer.timeScale = 0; // figé dans sa pose
  return { actor, made, hidden: originals };
}

function unpetrify(s: Stone): void {
  for (const o of s.made) o.removeFromParent();
  for (const o of s.hidden) o.visible = true;
  if (s.actor.model) s.actor.model.mixer.timeScale = 1;
}

/** Attache `obj`, placé en (x, y, z) dans le modèle au repos, à l'os `bone` (comme les accessoires). */
function attachToBone(holder: THREE.Object3D, bone: string, at: THREE.Vector3, obj: THREE.Object3D): boolean {
  const b = holder.getObjectByName(bone);
  if (!b) return false;
  holder.updateMatrixWorld(true);
  const m = new THREE.Matrix4().makeTranslation(at.x, at.y, at.z).premultiply(b.matrixWorld.clone().invert());
  const wrap = new THREE.Group();
  m.decompose(wrap.position, wrap.quaternion, wrap.scale);
  wrap.add(obj);
  b.add(wrap);
  return true;
}

export class GorgonArena implements GameView {
  readonly scene = new THREE.Scene();
  readonly world: World;
  readonly particles: Particles;
  readonly podium: PodiumView;
  readonly cameras = { training: 'custom', play: 'custom' } as const;
  readonly thirdPerson = true;
  readonly hideOwnTag = true;
  readonly solidPlayers = true;
  readonly pushCooldownMs = GORGON.push.cooldownMs;
  readonly pushReach = GORGON.push.reach;
  private sun = new THREE.DirectionalLight('#c9d4ff', 1.5);
  private gorgon: Actor & { root: THREE.Group };
  private snakes: THREE.Group[] = [];
  private eyes: THREE.Sprite[] = [];
  private gaze = new THREE.SpotLight('#ff3b2f', 0, 60, 0.55, 0.6, 1.2);
  private stones = new Map<string, Stone>();
  private decor: Stone[] = [];
  private camPos = new THREE.Vector3();
  private camTarget = new THREE.Vector3();
  private secretTurnAt: number | null = null;
  private seenStage = '';
  private flash: { text: string; until: number; cls?: string } | null = null;
  // entraînement : une Gorgone rien que pour soi
  private train: { stage: GorgonStage; at: number; end: number; anchor: THREE.Vector3 | null; stoneUntil: number } | null = null;
  private get time(): number { return performance.now() / 1000; }

  private constructor(private field: GorgonField, private kit: Kit) {
    this.world = { colliders: field.covers.map(coverBox), circles: [], bounds: { ...GORGON.bounds } };
    this.gorgon = { root: new THREE.Group() };
    this.build();
    this.particles = new Particles(this.scene);
    this.podium = new PodiumView(this.scene, [...GORGON.podium], this.world, this.particles);
  }

  static async create(field: GorgonField): Promise<GorgonArena> {
    return new GorgonArena(field, await loadKit('halloween'));
  }

  /** Face à la Gorgone (vers −z). */
  startYaw(): number { return Math.PI; }

  /* ================= Décor ================= */

  private build(): void {
    const s = this.scene, k = this.kit, { halfX: HX, halfZ: HZ } = GORGON.bounds;
    const put = (name: string, x: number, z: number, ry = 0, scale = 1, shadows = true) => k.has(name) ? k.spawn(name, { x, z, ry, scale, parent: s, shadows }) : null;
    s.background = new THREE.Color('#141228');
    s.fog = new THREE.Fog('#141228', 26, 85);
    s.add(new THREE.HemisphereLight('#9fa8e6', '#3a2c22', 1.5));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 70 });
    this.sun.shadow.bias = -0.0008;
    s.add(this.sun, this.sun.target);
    const moon = glow('#e8ecff', 10, 0.9); moon.position.set(-24, 34, -70); s.add(moon);

    // sol de terre battue, une plaine sombre autour
    const dirt = new THREE.Mesh(new THREE.PlaneGeometry(HX * 2 + 2, HZ * 2 + 12), new THREE.MeshToonMaterial({ map: ground, gradientMap }));
    (dirt.material as THREE.MeshToonMaterial).map!.repeat.set(5, 18);
    dirt.rotation.x = -Math.PI / 2; dirt.position.set(0, 0.01, -3); dirt.receiveShadow = true;
    s.add(dirt);
    const plain = new THREE.Mesh(new THREE.CircleGeometry(110, 48), new THREE.MeshToonMaterial({ color: '#28331f', gradientMap }));
    plain.rotation.x = -Math.PI / 2; plain.receiveShadow = true;
    s.add(plain);

    // départ et arrivée : deux bandes de dalles, l'arrivée gravée de runes qui luisent
    const line = (z: number, color: string, glowing: boolean) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(HX * 2, 0.6), glowing ? new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75 }) : new THREE.MeshToonMaterial({ color, gradientMap }));
      m.rotation.x = -Math.PI / 2; m.position.set(0, 0.03, z);
      s.add(m);
    };
    line(GORGON.startZ + 0.8, '#7d7466', false);
    line(GORGON.finishZ, '#b34cff', true);
    for (let x = -HX + 1; x < HX; x += 2.2) { const g = glow('#c77dff', 1.2, 0.5); g.position.set(x, 0.3, GORGON.finishZ); s.add(g); }

    // clôtures de chaque côté (hautes), derrière la crypte, et basse au départ
    for (let z = -26; z <= HZ; z += 4) for (const side of [-1, 1]) {
      const f = put(z % 12 === 2 ? 'fence_broken' : 'fence', side * (HX + 0.3), z, Math.PI / 2);
      if (f) f.scale.y = 1.3;
      put('fence_pillar', side * (HX + 0.3), z - 2)?.scale.set(1, 1.3, 1);
    }
    for (let x = -8; x <= 8; x += 4) put('fence', x, HZ + 0.3, 0)?.scale.set(1, 0.6, 1);
    // le fond : la crypte, deux grands arbres morts, des sapins d'automne
    put('crypt', 0, GORGON.gorgonZ - 9.5, 0, 1.4);
    for (const [n, x, z, r, sc] of [
      ['tree_dead_large_decorated', -7, -23, 0.4, 1.6], ['tree_dead_large', 7.5, -22.5, 2.2, 1.7],
      ['tree_pine_orange_large', -13, -30, 0.3, 1.8], ['tree_pine_yellow_large', 14, -31, 1, 1.9],
    ] as const) put(n, x, z, r, sc, false);
    // des deux côtés de l'allée : arbres, lanternes, citrouilles (hors du terrain)
    for (let z = -20, i = 0; z <= HZ + 4; z += 5.5, i++) for (const side of [-1, 1]) {
      const name = ['tree_pine_orange_large', 'tree_dead_large', 'tree_pine_yellow_medium', 'tree_dead_medium'][(i + (side > 0 ? 1 : 0)) % 4];
      put(name, side * (HX + 4 + (i % 3) * 1.6), z + side * 1.3, i * 1.1, 1.25 + (i % 2) * 0.35, false);
      if (i % 3 === 1) { put('post_lantern', side * (HX + 1.4), z, side > 0 ? -Math.PI / 2 : Math.PI / 2); const g = glow('#ffb35c', 1.8, 0.8); g.position.set(side * (HX + 1.4), 3, z); s.add(g); }
      if (i % 4 === 2) put(side > 0 ? 'pumpkin_orange_jackolantern' : 'pumpkin_yellow_jackolantern', side * (HX + 1.6), z + 2, i);
    }

    // les tombes du terrain (identiques pour tous, tirées par le serveur) et les statues
    for (const c of this.field.covers) {
      if (c.kind === 'statue') this.statue(c.x, c.z, c.rot + Math.PI, c.seed);
      else put(c.kind, c.x, c.z, c.rot, GRAVE_SCALE);
    }
    // des statues de héros d'avant, sur des socles, le long de l'allée
    for (let i = 0; i < 6; i++) {
      const side = i % 2 ? 1 : -1, z = 22 - i * 7.5, x = side * (HX - 0.9);
      part(s, new THREE.BoxGeometry(1.3, 0.5, 1.3), '#7e7a72', { outline: true }).position.set(x, 0.25, z);
      this.statue(x, z, side > 0 ? -Math.PI / 2 + 0.3 : Math.PI / 2 - 0.3, 1000 + i * 37, 0.5);
      this.world.colliders.push({ x0: x - 0.7, x1: x + 0.7, z0: z - 0.7, z1: z + 0.7 });
    }

    this.buildGorgon();
  }

  /** Une statue de héros pétrifié (tenue au hasard, figé dans un geste). */
  private statue(x: number, z: number, ry: number, seed: number, y = 0): void {
    const rnd = seeded(seed + 1);
    const a: Actor = { root: new THREE.Group() };
    a.root.position.set(x, y, z); a.root.rotation.y = ry;
    this.scene.add(a.root);
    setActorModel(a, randomConfig(rnd));
    const poses = ['Running_A', 'Cheer', 'Taunt', 'Dodge_Backward', 'Block', 'Spellcast_Shoot', 'Hit_A'];
    playAnimation(a, poses[Math.floor(rnd() * poses.length)], { fade: 0 });
    a.model!.mixer.update(0.2 + rnd() * 0.8);
    const st = petrify(a);
    if (st) this.decor.push(st);
  }

  /** La Gorgone : un héros géant à la peau verte, des serpents pour chevelure, des yeux qui s'allument. */
  private buildGorgon(): void {
    const s = this.scene, g = this.gorgon;
    // l'estrade
    const dais = part(s, new THREE.CylinderGeometry(3.4, 3.8, 1, 24), '#6e6a63', { outline: true });
    dais.position.set(0, 0.5, GORGON.gorgonZ);
    part(s, new THREE.CylinderGeometry(2.6, 3.0, 0.5, 24), '#7f7a72', { outline: true }).position.set(0, 1.25, GORGON.gorgonZ);
    // (serpents et yeux se placent sur le modèle à taille réelle, avant de l'agrandir et de le tourner)
    setActorModel(g, GORGON_CFG);
    const holder = g.model!.holder;
    g.root.updateMatrixWorld(true);
    const top = new THREE.Box3().setFromObject(holder).max.y;
    // la chevelure de serpents, rattachée à l'os de la tête
    const green = new THREE.MeshToonMaterial({ color: '#4f9a3c', gradientMap }), dark = new THREE.MeshToonMaterial({ color: '#2f6a28', gradientMap });
    const eyeMat = new THREE.MeshBasicMaterial({ color: '#ffd23f' });
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2, tilt = 0.5 + (i % 3) * 0.25;
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.sin(a) * 0.2, 0.22, Math.cos(a) * 0.2),
        new THREE.Vector3(Math.sin(a) * 0.45, 0.34 + tilt * 0.15, Math.cos(a) * 0.45), new THREE.Vector3(Math.sin(a) * 0.62, 0.28 + tilt * 0.2, Math.cos(a) * 0.62),
      ]);
      const snake = new THREE.Group();
      const body = new THREE.Mesh(new THREE.TubeGeometry(curve, 14, 0.055, 7), i % 2 ? green : dark);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 6), green);
      head.position.copy(curve.getPoint(1));
      for (const sx of [-1, 1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.018, 4, 3), eyeMat); e.position.copy(head.position).add(new THREE.Vector3(sx * 0.04, 0.03, 0.05)); snake.add(e); }
      snake.add(body, head);
      if (attachToBone(holder, 'head', new THREE.Vector3(Math.sin(a) * 0.12, top - 0.28, Math.cos(a) * 0.12 - 0.02), snake)) this.snakes.push(snake);
    }
    // les yeux : deux lueurs sur le visage, éteintes de dos
    for (const sx of [-1, 1]) {
      const e = glow('#ff3b2f', 0.13, 0);
      if (attachToBone(holder, 'head', new THREE.Vector3(sx * 0.15, top - 0.6, 0.48), e)) this.eyes.push(e);
    }
    g.root.position.set(0, 1.5, GORGON.gorgonZ);
    g.root.scale.setScalar(GORGON_SCALE);
    g.root.rotation.y = Math.PI; // de dos
    s.add(g.root);
    playAnimation(g, 'Idle');
    // son regard : une lueur rouge qui balaie l'allée quand elle regarde
    this.gaze.position.set(0, GORGON.eyeY, GORGON.gorgonZ + 1);
    this.gaze.target.position.set(0, 0, GORGON.startZ - 10);
    s.add(this.gaze, this.gaze.target);
  }

  /* ================= Regard ================= */

  /** Orientation de la Gorgone (π : de dos ; 0 : face à l'allée), d'après l'étape et le temps. */
  private gorgonYaw(stage: GorgonStage, sinceMs: number): number {
    const ease = (k: number) => { const t = Math.min(1, Math.max(0, k)); return t * t * (3 - 2 * t); };
    if (stage === 'turning') return Math.PI * (1 - ease(sinceMs / GORGON.turnMs));
    if (stage === 'watch') return 0;
    return Math.PI * ease(sinceMs / 400); // elle se détourne
  }

  private showGorgon(t: number, stage: GorgonStage, sinceMs: number): void {
    const g = this.gorgon;
    g.root.rotation.y = this.gorgonYaw(stage, sinceMs);
    const watching = stage === 'watch' ? 1 : stage === 'turning' ? Math.min(1, sinceMs / GORGON.turnMs) : 0;
    for (const e of this.eyes) (e.material as THREE.SpriteMaterial).opacity = watching * (0.85 + Math.sin(t * 20) * 0.15);
    this.gaze.intensity = stage === 'watch' ? 60 : watching * 30;
    this.snakes.forEach((sn, i) => { sn.rotation.z = Math.sin(t * (2 + watching * 5) + i) * 0.25; sn.rotation.x = Math.cos(t * 1.7 + i * 1.3) * 0.15; });
  }

  private setStone(id: string, actor: Actor | null | undefined): void {
    if (this.stones.has(id) || !actor) return;
    const st = petrify(actor);
    if (st) this.stones.set(id, st);
  }

  private clearStones(): void {
    for (const st of this.stones.values()) unpetrify(st);
    this.stones.clear();
  }

  /* ================= Entraînement ================= */

  startTraining(): void {
    this.train = { stage: 'back', at: this.time, end: this.time + 1.5 + Math.random() * 3, anchor: null, stoneUntil: 0 };
  }

  stopTraining(): void { this.train = null; this.clearStones(); }

  private updateTraining(f: Frame): string | null {
    const tr = this.train, now = this.time, P = f.me.root.position;
    if (!tr) return null;
    let say: string | null = null;
    if (tr.stoneUntil) {
      if (now < tr.stoneUntil) return null;
      // on repart du départ
      tr.stoneUntil = 0;
      this.clearStones();
      const [x, z] = GORGON_STARTS[0];
      f.me.placeAt(x, z, Math.PI); look.yaw = 0;
      return null;
    }
    if (now >= tr.end) {
      if (tr.stage === 'back') { tr.stage = 'turning'; tr.at = now; tr.end = now + GORGON.turnMs / 1000; playSfx('annonce', { volume: 0.7 }); }
      else if (tr.stage === 'turning') { tr.stage = 'watch'; tr.at = now; tr.end = now + (GORGON.watchMs[0] + Math.random() * (GORGON.watchMs[1] - GORGON.watchMs[0])) / 1000; tr.anchor = null; }
      else { tr.stage = 'back'; tr.at = now; tr.end = now + (GORGON.backMs[0] + Math.random() * (GORGON.backMs[1] - GORGON.backMs[0])) / 1000; }
    }
    if (tr.stage === 'watch' && now - tr.at >= GORGON.graceMs / 1000) {
      if (!tr.anchor) tr.anchor = P.clone();
      else if (Math.hypot(P.x - tr.anchor.x, P.z - tr.anchor.z) > GORGON.moveTolerance) {
        if (gorgonSees(P, this.field.covers, [])) {
          this.setStone(f.myId, f.me);
          this.particles.burst(P.x, 1.2, P.z, '#b9b4aa', 14, 1.2, 0.9);
          playSfx('erreur');
          tr.stoneUntil = now + 1.8;
          say = 'Pétrifié ! (pour de faux : on recommence)';
        } else tr.anchor.copy(P);
      }
    }
    if (P.z < GORGON.finishZ) {
      say = 'Arrivé ! On recommence…';
      tr.stoneUntil = now + 0.01;
    }
    return say;
  }

  /* ================= Partie ================= */

  onPhase(f: Frame): void {
    if (f.phase === 'mgResults') {
      // tout le monde redevient de chair pour le podium
      this.clearStones();
      this.world.circles = [];
      f.me.clearPose();
      this.gaze.intensity = 0;
      for (const e of this.eyes) (e.material as THREE.SpriteMaterial).opacity = 0;
    }
  }

  onSecret(s: MinigameSecret): void {
    if ('turnAt' in s) this.secretTurnAt = s.turnAt;
  }

  beforeMove(f: Frame): void {
    f.me.speedMul = GORGON.playerSpeedMul;
    if (f.phase === 'rules') { if (this.train?.stoneUntil) f.me.frozen = true; return; }
    const g = f.mg.gorgon;
    if (g && (g.petrified.includes(f.myId) || g.finished.includes(f.myId))) f.me.frozen = true;
  }

  afterMove(f: Frame): string | null {
    return f.phase === 'rules' ? this.updateTraining(f) : null;
  }

  applyTick(tick: MinigameTick, f: Frame): void {
    for (const [id, x, z, yaw, anim] of tick.bots) {
      if (this.stones.has(id)) continue; // (une statue ne bouge plus)
      f.remotes.get(id)?.setTransform({ p: [x, 0, z], r: yaw, a: anim });
    }
  }

  private actor(f: Frame, id: string): Actor | null {
    return id === f.myId ? f.me : f.remotes.get(id) ?? null;
  }

  private name(f: Frame, id: string): string {
    return id === f.myId ? 'Toi' : f.state.players.find((p) => p.id === id)?.name ?? '?';
  }

  /** Étapes, pétrifiés et arrivées d'après l'état du serveur. */
  private syncPlay(f: Frame): void {
    const g = f.mg.gorgon!;
    const key = `${g.stage}|${g.stageAt}`;
    if (key !== this.seenStage) {
      this.seenStage = key;
      if (g.stage === 'turning') playSfx('annonce', { volume: 0.8 });
      if (g.stage === 'watch' && !g.petrified.includes(f.myId) && !g.finished.includes(f.myId)) this.flash = { text: 'Elle regarde… ne bouge plus !', until: this.time + 1.2, cls: 'caught' };
    }
    for (const id of g.petrified) {
      if (this.stones.has(id)) continue;
      const a = this.actor(f, id);
      // (sa statue est là où le serveur l'a figée)
      const at = g.stone[id];
      if (at && id !== f.myId) f.remotes.get(id)?.teleport({ p: [at[0], 0, at[1]], r: at[2], a: 'Idle' });
      this.setStone(id, a);
      if (a) this.particles.burst(a.root.position.x, 1.2, a.root.position.z, '#b9b4aa', 16, 1.2, 0.9);
      playSfx('erreur', { volume: id === f.myId ? 1.4 : 0.6 });
      f.float(id, 'Pétrifié !', FLOAT_LOSS);
      if (id === f.myId) { f.me.clearPose(); this.flash = { text: 'Pétrifié ! Tu es une statue…', until: this.time + 3, cls: 'caught' }; }
      playAnimation(this.gorgon, 'Spellcast_Shoot', { once: true, fade: 0.2, restart: true });
    }
    if (g.finished.includes(f.myId) && f.me.currentName !== 'Cheer') f.me.playPose('Cheer', { once: false });
    // les statues bloquent le passage
    this.world.circles = g.petrified.filter((id) => id !== f.myId).map((id) => ({ x: g.stone[id]?.[0] ?? 0, z: g.stone[id]?.[1] ?? 0, r: GORGON.playerR }));
  }

  update(t: number, dt: number, f: Frame): void {
    this.particles.update(dt);
    this.podium.update(dt);
    updateActor(this.gorgon, t, dt, false);
    if (this.gorgon.currentName === 'Spellcast_Shoot' && this.gorgon.current && !this.gorgon.current.isRunning()) playAnimation(this.gorgon, 'Idle', { fade: 0.3 });
    const P = f.me.root.position;
    this.sun.position.set(P.x - 8, 24, P.z + 10);
    this.sun.target.position.set(P.x, 0, P.z - 6);
    if (f.phase !== 'mgResults') this.aimCamera(f);
    if (f.phase === 'rules') {
      const tr = this.train;
      if (tr) this.showGorgon(t, tr.stage, (this.time - tr.at) * 1000);
      return;
    }
    const g = f.mg.gorgon;
    if (f.phase !== 'mgPlay' || !g) { this.showGorgon(t, 'back', 1e9); return; }
    this.syncPlay(f);
    this.showGorgon(t, g.stage, f.playMs - g.stageAt);
  }

  /** Derrière le joueur, à hauteur d'épaule et un peu à droite ; il regarde l'allée devant lui. */
  private aimCamera(f: Frame): void {
    const P = f.me.root.position, yaw = look.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const back = 3.6, side = 0.8, ahead = 3.2, rx = -fz, rz = fx;
    this.camPos.set(P.x - fx * back + rx * side, P.y + 2.7, P.z - fz * back + rz * side);
    this.camTarget.set(P.x + fx * ahead + rx * side * 0.4, P.y + 2, P.z + fz * ahead + rz * side * 0.4);
    setCustomCamera(this.camPos, this.camTarget, camera.aspect < 1 ? 78 : 62, 9);
  }

  /* ================= HUD ================= */

  hud(f: Frame): HudInfo {
    const g = f.mg.gorgon, now = this.time;
    const stage: GorgonStage = f.phase === 'rules' ? this.train?.stage ?? 'back' : g?.stage ?? 'back';
    const done = !!g?.finished.includes(f.myId), stone = !!g?.petrified.includes(f.myId);
    const look = stage === 'back' ? 'De dos' : stage === 'turning' ? 'Elle se retourne !' : 'ELLE REGARDE';
    const left = Math.max(0, f.me.root.position.z - GORGON.finishZ);
    const boxes: HudInfo['boxes'] = [
      { label: 'La Gorgone', value: look, cls: stage === 'back' ? 'sk' : 'caught' },
      { label: 'Arrivée', value: done ? 'Arrivé !' : `${Math.ceil(left)} m` },
    ];
    // l'imposteur sait quand elle va se retourner
    let soon = false;
    if (f.phase === 'mgPlay' && f.imposter && g?.stage === 'back' && this.secretTurnAt !== null && !done && !stone) {
      const ms = this.secretTurnAt - f.playMs;
      if (ms > 0) { boxes.push({ label: 'Elle se retourne dans', value: `${(ms / 1000).toFixed(1)} s`, cls: ms < 1200 ? 'caught' : '' }); soon = ms < 1200; }
    }
    let status: HudInfo['status'] = null;
    if (this.flash && now < this.flash.until) status = { text: this.flash.text, cls: this.flash.cls };
    else if (f.phase !== 'mgPlay' || !g) status = null;
    else if (stone) status = { text: 'Pétrifié… regarde les autres tenter leur chance.' };
    else if (done) status = { text: `Arrivé ${g.finished.indexOf(f.myId) === 0 ? 'le premier' : `en ${g.finished.indexOf(f.myId) + 1}e`} !` };
    else if (soon) status = { text: 'Stop ! Elle va se retourner…', cls: 'caught' };
    else if (stage === 'back') status = { text: 'Avance ! (E : pousser un autre joueur)' };
    else status = { text: 'Ne bouge plus ! (collé derrière une tombe, tu peux)', cls: 'caught' };
    return {
      boxes,
      chip: (id) => {
        if (!g) return { text: '' };
        if (g.finished.includes(id)) return { text: `Arrivé (${g.finished.indexOf(id) + 1}e)`, cls: 'done' };
        if (g.petrified.includes(id)) return { text: 'Pétrifié', cls: 'fall' };
        return { text: 'En route' };
      },
      status,
      vignette: soon,
    };
  }

  exit(): void {
    this.stopTraining();
    this.clearStones();
  }
}
