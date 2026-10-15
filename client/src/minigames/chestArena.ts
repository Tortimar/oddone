import * as THREE from 'three';
import {
  CHESTS, SLOT_COLORS, chestSpot, nearestChest,
  type ChestSecret, type ChestsState, type MinigameSecret, type MinigameTick,
} from '@oddone/shared';
import { canvasTexture, gradientMap, part } from '../engine/render.ts';
import { pointer } from '../game/input.ts';
import { loadKit, type Kit } from '../world/kits.ts';
import { glow } from '../world/outside.ts';
import { buildChandelier } from '../world/tavernDecor.ts';
import type { World } from '../world/tavern.ts';
import { Particles, PodiumView, ceilingPlanks } from './effects.ts';
import type { Frame, GameView, HudInfo } from './view.ts';

/**
 * L'arène des « Coffres Piégés » : une salle de donjon fermée de murs de pierre, éclairée aux
 * torches, des coffres en cercle au milieu. Chacun son tour, on va ouvrir (E) ou inspecter (R)
 * un coffre ; les autres attendent dans leur coin, sans bouger. Le couvercle grince, puis :
 * des pièces… ou les dents de la mimique.
 * L'imposteur, lui, voit le résultat de sa première inspection (le coffre est marqué chez lui seul).
 */

const HALF = CHESTS.roomHalf + 0.7; // face intérieure des murs
const SUSPENSE = CHESTS.revealMs / 1000;
const OPEN_ANGLE = -1.95;
/** Murs ×1,6 (6,4 de haut) : le plafond pose dessus. */
const WALL_SCALE = 1.6, CEILING = 4 * WALL_SCALE;

/** Petit panneau peint (« ! », « ✓ », loupe) pour les marques au-dessus des coffres et des têtes. */
function signTexture(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  return canvasTexture(128, 128, (g, w, h) => { g.clearRect(0, 0, w, h); draw(g, w, h); });
}
const MARK_MIMIC = signTexture((g, w, h) => {
  g.fillStyle = '#c0262d'; g.strokeStyle = '#1d120c'; g.lineWidth = 8;
  g.beginPath(); g.arc(w / 2, h / 2, 52, 0, Math.PI * 2); g.fill(); g.stroke();
  g.font = '900 86px "Lilita One", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#fbf1dc'; g.fillText('!', w / 2, h / 2 + 6);
});
const MARK_SAFE = signTexture((g, w, h) => {
  g.fillStyle = '#36b24a'; g.strokeStyle = '#1d120c'; g.lineWidth = 8;
  g.beginPath(); g.arc(w / 2, h / 2, 52, 0, Math.PI * 2); g.fill(); g.stroke();
  g.strokeStyle = '#fbf1dc'; g.lineWidth = 14; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(38, 66); g.lineTo(56, 84); g.lineTo(90, 44); g.stroke();
});
const LOUPE = signTexture((g, w, h) => {
  g.fillStyle = '#fbf1dc'; g.strokeStyle = '#1d120c'; g.lineWidth = 7;
  g.beginPath(); g.arc(w / 2, h / 2, 54, 0, Math.PI * 2); g.fill(); g.stroke();
  g.lineWidth = 9; g.strokeStyle = '#5a3a22';
  g.beginPath(); g.moveTo(74, 74); g.lineTo(98, 98); g.stroke();
  g.fillStyle = '#bfe3ff'; g.strokeStyle = '#1d120c'; g.lineWidth = 7;
  g.beginPath(); g.arc(56, 56, 24, 0, Math.PI * 2); g.fill(); g.stroke();
});

const ease = (k: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 3);

/** Un coffre à l'écran, avec son couvercle sur charnière et la mimique cachée dedans. */
interface ChestView {
  i: number;
  root: THREE.Group;
  body: THREE.Group;
  hinge: THREE.Group;
  mimicParts: THREE.Group;
  coins: THREE.Object3D;
  aura: THREE.Sprite;
  mark: THREE.Sprite;
  x: number; z: number; a: number;
  /** closed → creak (suspense) → open (trésor) ou mimic (morsure). */
  mode: 'closed' | 'creak' | 'open' | 'mimic';
  /** Instant (s) du dernier changement de mode. */
  since: number;
  /** Ce que contient le coffre qu'on ouvre (connu dès le début, montré après le suspense). */
  isMimic: boolean;
  /** Vers qui la mimique bondit. */
  victim: THREE.Object3D | null;
  born: number;
}

export class ChestArena implements GameView {
  readonly scene = new THREE.Scene();
  readonly world: World;
  readonly particles: Particles;
  readonly podium: PodiumView;
  readonly cameras = { training: 'thirdPerson', play: 'thirdPerson' } as const;
  readonly thirdPerson = true;
  readonly cameraRadius = CHESTS.roomHalf - 0.4;
  readonly cameraCeiling = CEILING - 0.7;
  private chests: ChestView[] = [];
  private chestKey = '';
  private torches: { light: THREE.PointLight; flame: THREE.Sprite; base: number }[] = [];
  private turnRing: THREE.Mesh;
  private loupe: THREE.Sprite;
  private flash: { text: string; until: number; cls?: string } | null = null;
  /** Horloge murale (s) : les durées (suspense, inspection) collent à celles du serveur même si l'image rame. */
  private get time(): number { return performance.now() / 1000; }
  /** Ma vraie inspection (imposteur) a déjà servi. */
  private secretUsed = false;
  /** Ce que j'ai appris (imposteur), pour la manche en cours. */
  private secret: ChestSecret | null = null;
  /** Un coffre en cours d'ouverture déjà pris en compte (pour ne déclencher les effets qu'une fois). */
  private openingKey = '';
  private inspectedTurn = '';
  private bending = false;
  private bentAt = 0;
  private bitten = '';
  // entraînement
  private train: { count: number; mimic: number; opened: number[]; resetAt: number; inspectUntil: number; inspectChest: number } | null = null;

  private constructor(private kit: Kit) {
    this.world = { colliders: [], circles: [], bounds: { halfX: CHESTS.roomHalf, halfZ: CHESTS.roomHalf } };
    this.build();
    this.particles = new Particles(this.scene);
    this.podium = new PodiumView(this.scene, [...CHESTS.podium], this.world, this.particles);
    this.turnRing = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.78, 40),
      new THREE.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.turnRing.rotation.x = -Math.PI / 2;
    this.turnRing.visible = false;
    this.scene.add(this.turnRing);
    this.loupe = new THREE.Sprite(new THREE.SpriteMaterial({ map: LOUPE, transparent: true, depthWrite: false }));
    this.loupe.scale.setScalar(0.75);
    this.loupe.visible = false;
    this.scene.add(this.loupe);
  }

  static async create(): Promise<ChestArena> {
    return new ChestArena(await loadKit('dungeon'));
  }

  /** Au départ (et en attendant son tour), tourné vers les coffres. */
  startYaw(x: number, z: number): number { return Math.atan2(-x, -z); }

  /* ================= Décor ================= */

  private build(): void {
    const s = this.scene, k = this.kit;
    s.background = new THREE.Color('#120d0b');
    s.fog = new THREE.Fog('#120d0b', 18, 40);
    s.add(new THREE.HemisphereLight('#a7a2c9', '#3a2a1e', 0.75));
    // une lueur blafarde tombe d'en haut sur les coffres (et donne les ombres)
    const moon = new THREE.DirectionalLight('#ffe6c4', 1.25);
    moon.position.set(-4, 18, 6);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    Object.assign(moon.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 40 });
    moon.shadow.bias = -0.0008;
    s.add(moon);
    const pool = new THREE.SpotLight('#ffcf8a', 14, 16, 0.6, 0.7, 1.4);
    pool.position.set(0, CEILING - 0.4, 0); pool.target.position.set(0, 0, 0);
    s.add(pool, pool.target);

    // dallage
    for (let x = -10; x <= 10; x += 4) for (let z = -10; z <= 10; z += 4) {
      // (dalles à cailloux seulement le long des murs : le milieu reste dégagé)
      const edge = Math.abs(x) === 10 || Math.abs(z) === 10;
      const name = edge && (x * 7 + z * 3) % 3 === 0 ? 'floor_tile_large_rocks' : 'floor_tile_large';
      k.spawn(k.has(name) ? name : 'floor_tile_large', { x, z, ry: ((x + z) / 4) * (Math.PI / 2), parent: s });
    }
    // quatre murs (plus hauts que nature : on ne voit que la pierre), piliers dans les coins
    const H = WALL_SCALE;
    for (let t = -10; t <= 10; t += 4) {
      for (const [x, z, ry] of [[t, -HALF - 0.5, 0], [t, HALF + 0.5, Math.PI], [HALF + 0.5, t, -Math.PI / 2], [-HALF - 0.5, t, Math.PI / 2]] as const) {
        const w = k.spawn((t / 4 + 2) % 3 === 1 && k.has('wall_arched') ? 'wall_arched' : 'wall', { x, z, ry, parent: s });
        w.scale.set(1, H, 1);
      }
    }
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const p = k.spawn('pillar', { x: x * (HALF + 0.2), z: z * (HALF + 0.2), parent: s });
      p.scale.set(1.2, H, 1.2);
    }
    // le plafond, posé sur les murs : planches sombres, grosses poutres, un lustre au-dessus des coffres
    // (rien de tout ça ne porte d'ombre : la lueur d'en haut doit encore entrer)
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2 + 2, HALF * 2 + 2), new THREE.MeshToonMaterial({ map: ceilingPlanks, gradientMap }));
    ceiling.rotation.x = Math.PI / 2; ceiling.position.y = CEILING;
    s.add(ceiling);
    for (let z = -9; z <= 9; z += 4.5) part(s, new THREE.BoxGeometry(HALF * 2 + 1, 0.5, 0.5), '#4a2f1d', { outline: true, shadow: false }).position.set(0, CEILING - 0.25, z);
    for (const x of [-6, 6]) part(s, new THREE.BoxGeometry(0.6, 0.6, HALF * 2 + 1), '#3d2617', { outline: true, shadow: false }).position.set(x, CEILING - 0.55, 0);
    buildChandelier(s, k, 0, CEILING - 2.3, 0, (c, size, x, y, z, o) => {
      const g = glow(c, size, o); g.position.set(x, y, z); s.add(g); return g;
    });
    // torches au mur (avec de vraies lumières qui vacillent)
    for (const [x, z, ry] of [
      [-5, -HALF, 0], [5, -HALF, 0], [-5, HALF, Math.PI], [5, HALF, Math.PI],
      [HALF, -5, -Math.PI / 2], [HALF, 5, -Math.PI / 2], [-HALF, -5, Math.PI / 2], [-HALF, 5, Math.PI / 2],
    ] as const) {
      k.spawn('torch_mounted', { x, y: 2.6, z, ry, parent: s, shadows: false });
      const dx = Math.sin(ry) * 0.45, dz = Math.cos(ry) * 0.45;
      const flame = glow('#ffae42', 1.5, 0.8);
      flame.position.set(x + dx, 3.25, z + dz);
      s.add(flame);
      const light = new THREE.PointLight('#ff9a3c', 9, 11, 1.3);
      light.position.set(x + dx * 2, 3.1, z + dz * 2);
      s.add(light);
      this.torches.push({ light, flame, base: 9 });
    }
    // bannières et trophées sur les murs, entre les torches
    for (const [x, z, ry, name] of [
      [0, -HALF + 0.05, 0, 'banner_patternA_red'], [0, HALF - 0.05, Math.PI, 'banner_patternB_blue'],
      [HALF - 0.05, 0, -Math.PI / 2, 'banner_shield_yellow'], [-HALF + 0.05, 0, Math.PI / 2, 'banner_patternC_green'],
    ] as const) {
      if (k.has(name)) k.spawn(name, { x, y: 1.4, z, ry, parent: s, shadows: false });
    }
    // bric-à-brac du donjon, le long des murs (loin des coins où l'on attend son tour)
    const props: [string, number, number, number][] = [
      ['barrel_large', -1.8, -HALF + 1.2, 0.3], ['barrel_small_stack', 2.1, -HALF + 1, 0], ['crates_stacked', HALF - 1.4, 2.1, 0.4],
      ['keg_decorated', HALF - 1.2, -1.6, -Math.PI / 2], ['table_medium_decorated_A', -HALF + 1.4, 1.8, 0.2], ['barrel_small', -HALF + 1, -1.6, 0],
      ['coin_stack_large', 1.8, HALF - 1.2, 0.5], ['sword_shield_broken', -1.6, HALF - 0.9, Math.PI], ['candle_triple', -HALF + 1.4, 1.8, 0],
      ['rubble_half', -2.6, HALF - 1.2, Math.PI], ['keyring_hanging', HALF - 0.2, 5.4, -Math.PI / 2],
    ];
    for (const [name, x, z, ry] of props) {
      if (!k.has(name)) continue;
      const o = k.spawn(name, { x, z, ry, parent: s, scale: name === 'rubble_half' ? 0.5 : undefined });
      if (name === 'candle_triple') o.position.y = 1;
      this.world.colliders.push({ x0: x - 0.9, x1: x + 0.9, z0: z - 0.9, z1: z + 0.9 });
    }
    // les quatre coins d'attente, aux couleurs des joueurs (cercle runique au sol)
    for (let i = 0; i < 4; i++) {
      const a = ((45 + i * 90) * Math.PI) / 180;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.95, 40), new THREE.MeshBasicMaterial({ color: SLOT_COLORS[i], transparent: true, opacity: 0.35, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(Math.sin(a) * CHESTS.homeRadius, 0.04, Math.cos(a) * CHESTS.homeRadius);
      s.add(ring);
    }
    // le cercle des coffres, gravé au sol
    const circle = new THREE.Mesh(new THREE.RingGeometry(CHESTS.ringRadius - 0.08, CHESTS.ringRadius + 0.08, 64), new THREE.MeshBasicMaterial({ color: '#d9a441', transparent: true, opacity: 0.22, depthWrite: false }));
    circle.rotation.x = -Math.PI / 2; circle.position.y = 0.03;
    s.add(circle);
  }

  /* ================= Coffres ================= */

  private makeChest(i: number, count: number, t: number): ChestView {
    const [x, z, a] = chestSpot(i, count);
    const root = new THREE.Group();
    root.position.set(x, 0, z); root.rotation.y = a;
    const body = new THREE.Group();
    root.add(body);
    const model = this.kit.create('chest');
    model.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    body.add(model);
    // couvercle : on le remet sur une charnière à l'arrière (il tourne autour de son centre sinon)
    model.updateMatrixWorld(true);
    const lid = model.getObjectByName('chest_lid')!;
    const hinge = new THREE.Group();
    let front = 0.7, top = 0.8;
    if (lid) {
      const box = new THREE.Box3().setFromObject(lid);
      hinge.position.set(0, box.min.y, box.min.z);
      front = box.max.z; top = box.min.y;
      const parent = lid.parent!;
      parent.add(hinge);
      parent.remove(lid);
      lid.position.sub(hinge.position);
      hinge.add(lid);
    }
    // la mimique : dents en haut de la caisse et sous le couvercle, langue, yeux qui brillent
    const mimicParts = new THREE.Group();
    mimicParts.visible = false;
    const toothMat = new THREE.MeshToonMaterial({ color: '#fbf1dc', gradientMap });
    const toothGeo = new THREE.ConeGeometry(0.07, 0.2, 5);
    for (let k = 0; k < 7; k++) {
      const tx = -0.62 + k * 0.207;
      const lower = new THREE.Mesh(toothGeo, toothMat); lower.position.set(tx, top + 0.06, front - 0.08); mimicParts.add(lower);
    }
    const upperTeeth = new THREE.Group();
    for (let k = 0; k < 6; k++) {
      const upper = new THREE.Mesh(toothGeo, toothMat); upper.rotation.x = Math.PI;
      upper.position.set(-0.52 + k * 0.207, -0.04, front - hinge.position.z - 0.1);
      upperTeeth.add(upper);
    }
    const tongue = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 8), new THREE.MeshToonMaterial({ color: '#c0262d', gradientMap }));
    tongue.scale.set(0.8, 0.18, 1.1); tongue.position.set(0, top + 0.02, 0.1);
    mimicParts.add(tongue);
    const eyeMat = new THREE.MeshBasicMaterial({ color: '#ffe14a' });
    for (const ex of [-0.3, 0.3]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), eyeMat);
      eye.position.set(ex, -0.12, front - hinge.position.z - 0.35);
      upperTeeth.add(eye);
    }
    const eyeGlow = glow('#ff5a2a', 1.4, 0.6); eyeGlow.position.set(0, -0.1, front - hinge.position.z - 0.35);
    upperTeeth.add(eyeGlow);
    upperTeeth.visible = false;
    hinge.add(upperTeeth);
    mimicParts.userData.upper = upperTeeth;
    model.add(mimicParts);
    // le trésor (caché tant que le couvercle est fermé)
    const coins = this.kit.create('coin_stack_small');
    coins.scale.setScalar(0.6); coins.position.set(0, top - 0.32, 0); coins.visible = false;
    model.add(coins);
    const aura = glow('#ffd23f', 3, 0); aura.position.set(0, 1.1, 0);
    root.add(aura);
    const mark = new THREE.Sprite(new THREE.SpriteMaterial({ map: MARK_SAFE, transparent: true, depthWrite: false, depthTest: false }));
    mark.scale.setScalar(0.8); mark.position.set(0, 2.2, 0); mark.visible = false; mark.renderOrder = 5;
    root.add(mark);
    this.scene.add(root);
    return { i, root, body, hinge, mimicParts, coins, aura, mark, x, z, a, mode: 'closed', since: t, isMimic: false, victim: null, born: t };
  }

  private clearChests(): void {
    for (const c of this.chests) c.root.removeFromParent();
    this.chests = [];
    this.world.circles = [];
    this.chestKey = '';
  }

  /** Les coffres de la manche (ou de l'entraînement) : reconstruits quand la manche change. */
  private ensureChests(key: string, count: number, opened: readonly number[], t: number): void {
    if (key === this.chestKey) return;
    this.clearChests();
    this.chestKey = key;
    for (let i = 0; i < count; i++) {
      const c = this.makeChest(i, count, t);
      if (opened.includes(i)) { c.mode = 'open'; c.since = t - 5; } // (arrivé en cours de manche)
      this.chests.push(c);
      this.particles.burst(c.x, 0.3, c.z, '#b7a58c', 4, 1.2, 0.5);
    }
    this.world.circles = this.chests.map((c) => ({ x: c.x, z: c.z, r: CHESTS.chestRadius }));
  }

  /** Le couvercle commence à grincer : dans `SUSPENSE` secondes on saura. */
  private startOpening(c: ChestView, mimic: boolean, victim: THREE.Object3D | null, t: number): void {
    c.mode = 'creak'; c.since = t; c.isMimic = mimic; c.victim = victim;
  }

  private animateChest(c: ChestView, t: number, dt: number): void {
    // ils sortent du sol en début de manche
    const rise = ease((t - c.born) / 0.7);
    c.body.position.y = (rise - 1) * 1.4;
    let lid = 0, shake = 0;
    const k = t - c.since;
    if (c.mode === 'creak') {
      lid = -0.06 - 0.07 * Math.max(0, Math.sin(k * 9)) * Math.min(1, k * 1.5);
      shake = Math.sin(k * 47) * 0.025 * Math.min(1, k);
      if (k >= SUSPENSE) this.reveal(c, t);
    } else if (c.mode === 'open') {
      lid = OPEN_ANGLE * ease(k / 0.3);
      (c.aura.material as THREE.SpriteMaterial).opacity = Math.max(0, 0.7 - k * 0.35) + 0.12;
    } else if (c.mode === 'mimic') {
      // la mimique claque des dents et bondit vers sa victime
      const fast = k < 2.2 ? 26 : 9;
      lid = -0.35 - 0.6 * (0.5 + 0.5 * Math.sin(k * fast));
      const lunge = k < 0.35 ? ease(k / 0.35) : 1;
      if (c.victim) {
        const [sx, sz] = chestSpot(c.i, this.chests.length);
        const vx = c.victim.position.x - sx, vz = c.victim.position.z - sz, d = Math.hypot(vx, vz) || 1;
        const reach = Math.min(0.9, Math.max(0, d - 0.9));
        c.root.position.set(sx + (vx / d) * reach * lunge, Math.abs(Math.sin(k * fast * 0.5)) * 0.18 * (k < 2.2 ? 1 : 0.3), sz + (vz / d) * reach * lunge);
        c.root.rotation.y = Math.atan2(vx, vz);
      }
      shake = Math.sin(k * 31) * 0.04;
    }
    c.hinge.rotation.x = lid;
    c.body.rotation.z = shake;
    if (c.mark.visible) c.mark.position.y = 2.2 + Math.sin(t * 3 + c.i) * 0.08;
    void dt;
  }

  /** Fin du suspense : pièces d'or, ou la mimique. */
  private reveal(c: ChestView, t: number): void {
    c.since = t;
    if (c.isMimic) {
      c.mode = 'mimic';
      c.mimicParts.visible = true;
      (c.mimicParts.userData.upper as THREE.Object3D).visible = true;
      this.particles.burst(c.x, 1, c.z, '#c0262d', 16, 1.6, 0.6);
      this.particles.burst(c.x, 1, c.z, '#3a1e14', 10, 1.2, 0.8);
    } else {
      c.mode = 'open';
      c.coins.visible = true;
      this.particles.burst(c.x, 1.1, c.z, '#ffd23f', 18, 1.4, 0.45);
    }
  }

  /* ================= Joueur local ================= */

  startTraining(f: Frame): void {
    this.clearChests();
    this.newTrainingRound(f, this.time);
  }
  stopTraining(): void { this.train = null; this.clearChests(); }

  private newTrainingRound(_f: Frame, t: number): void {
    const count = 3;
    this.train = { count, mimic: Math.floor(Math.random() * count), opened: [], resetAt: 0, inspectUntil: 0, inspectChest: -1 };
    this.ensureChests(`train|${t}`, count, [], t);
  }

  onPhase(f: Frame): void {
    if (f.phase === 'roleReveal' || f.phase === 'mgCountdown') { this.train = null; this.clearChests(); this.secretUsed = false; this.secret = null; this.bitten = ''; }
    if (f.phase === 'mgResults') { this.clearChests(); this.turnRing.visible = false; this.loupe.visible = false; }
  }

  private st(f: Frame): ChestsState | null { return f.phase === 'mgPlay' ? f.mg.chests : null; }

  private home(f: Frame): [number, number] { return f.mg.starts[f.myId] ?? [CHESTS.homeRadius, CHESTS.homeRadius]; }

  beforeMove(f: Frame): void {
    const me = f.me;
    me.speedMul = 0.8; me.walkAnim = true; // on avance prudemment dans le donjon
    const c = this.st(f);
    if (f.phase === 'rules') {
      if (this.train && this.time < this.train.inspectUntil) me.frozen = true;
      else if (this.bending) { this.bending = false; me.clearPose(); }
      if (pointer.clicked && !me.frozen) this.onAct(f, false); // clic gauche = E
      return;
    }
    if (!c) return;
    const mine = c.turn === f.myId && c.stage === 'turn';
    const inspectingMe = c.inspecting?.by === f.myId;
    // (on laisse au serveur le temps de confirmer l'inspection avant de se relever)
    if (this.bending && !inspectingMe && this.time - this.bentAt > 0.8) { this.bending = false; me.clearPose(); }
    const out = c.out.includes(f.myId);
    const dying = c.stage === 'out' && c.out[c.out.length - 1] === f.myId;
    const busy = mine || (c.stage === 'opening' && c.opening?.by === f.myId) || dying;
    // pas mon tour : je retourne dans mon coin (assis par terre si la mimique m'a eu)
    if (!busy) {
      const [hx, hz] = this.home(f), P = me.root.position;
      if (Math.hypot(P.x - hx, P.z - hz) > 0.6) {
        me.placeAt(hx, hz, Math.atan2(-hx, -hz));
        this.particles.burst(hx, 0.6, hz, '#b7a58c', 6, 0.8, 0.6);
      }
      if (out && me.currentName !== 'Sit_Floor_Idle') me.playPose('Sit_Floor_Idle', { once: false });
    }
    me.frozen = !mine || inspectingMe;
    me.faceYaw = null;
    if (pointer.clicked && !me.frozen) this.onAct(f, false); // clic gauche = E
  }

  afterMove(f: Frame): string | null {
    if (f.phase !== 'rules' || !this.train) return null;
    const msg = this.flash && this.flash.until > this.time && this.flash.cls === 'train' ? this.flash.text : null;
    if (msg) this.flash = null;
    return msg;
  }

  /** E : ouvrir le coffre devant soi ; R : l'inspecter. */
  onAct(f: Frame, special: boolean): boolean {
    const me = f.me, P = me.root.position;
    if (f.phase === 'rules') return this.trainAct(f, special);
    const c = this.st(f);
    if (!c || c.turn !== f.myId || c.stage !== 'turn' || c.inspecting) return true;
    const k = nearestChest(P.x, P.z, c.count, c.opened);
    if (k < 0) { this.say('Approche-toi d’un coffre fermé'); return true; }
    const [cx, cz] = chestSpot(k, c.count);
    me.yaw = Math.atan2(cx - P.x, cz - P.z); me.root.rotation.y = me.yaw;
    const turnKey = `${c.round}|${c.stageAt}`;
    if (special) {
      if (this.inspectedTurn === turnKey) { this.say('Une seule inspection par tour'); return true; }
      this.inspectedTurn = turnKey;
      me.playPose('PickUp', { speed: 0.75, hold: true });
      this.bending = true; this.bentAt = this.time;
    } else me.playPose('Interact', { speed: 1.1 });
    f.net.sendMove(me.transform());
    f.net.action(special ? 'inspect' : 'open');
    return true;
  }

  private say(text: string, s = 1.6, cls?: string): void { this.flash = { text, until: this.time + s, cls }; }

  /** Entraînement : trois coffres rien que pour soi, la mimique tirée au sort. */
  private trainAct(f: Frame, special: boolean): boolean {
    const tr = this.train, me = f.me, P = me.root.position;
    if (!tr || tr.resetAt || this.time < tr.inspectUntil || this.chests.some((c) => c.mode === 'creak')) return true;
    const k = nearestChest(P.x, P.z, tr.count, tr.opened);
    if (k < 0) { this.say('Trop loin !', 1.6, 'train'); return true; }
    const [cx, cz] = chestSpot(k, tr.count);
    me.yaw = Math.atan2(cx - P.x, cz - P.z); me.root.rotation.y = me.yaw;
    if (special) {
      me.playPose('PickUp', { speed: 0.75, hold: true });
      this.bending = true;
      tr.inspectUntil = this.time + CHESTS.inspectMs / 1000; tr.inspectChest = k;
      return true;
    }
    me.playPose('Interact', { speed: 1.1 });
    tr.opened.push(k);
    this.startOpening(this.chests[k], k === tr.mimic, me.root, this.time);
    return true;
  }

  private updateTraining(f: Frame): void {
    const tr = this.train;
    if (!tr) return;
    if (tr.inspectChest >= 0 && this.time >= tr.inspectUntil) {
      const c = this.chests[tr.inspectChest];
      this.showMark(c, tr.inspectChest === tr.mimic);
      this.say(tr.inspectChest === tr.mimic ? 'Mimique !' : 'Sans danger', 2.4, 'train');
      tr.inspectChest = -1;
    }
    const bit = this.chests.find((c) => c.mode === 'mimic');
    if (bit && !tr.resetAt) {
      tr.resetAt = this.time + 2.4;
      f.me.knock([Math.sin(bit.root.rotation.y), Math.cos(bit.root.rotation.y)], true);
      this.say('Croqué !', 2.4, 'train');
    } else if (!tr.resetAt && tr.opened.length === tr.count - 1 && this.chests.every((c) => c.mode !== 'creak')) {
      tr.resetAt = this.time + 2.2;
      this.say('Plus que la mimique !', 2.2, 'train');
    }
    if (tr.resetAt && this.time >= tr.resetAt) this.newTrainingRound(f, this.time);
  }

  private showMark(c: ChestView | undefined, mimic: boolean): void {
    if (!c) return;
    c.mark.visible = true;
    (c.mark.material as THREE.SpriteMaterial).map = mimic ? MARK_MIMIC : MARK_SAFE;
    (c.mark.material as THREE.SpriteMaterial).needsUpdate = true;
    const a = c.aura.material as THREE.SpriteMaterial;
    a.color.set(mimic ? '#ff3b30' : '#5dff7a'); a.opacity = 0.45;
  }

  /** Ce que l'imposteur a vu dans le coffre (lui seul). */
  onSecret(s: MinigameSecret, f: Frame): void {
    if (!('chest' in s)) return;
    const sec: ChestSecret = s;
    this.secretUsed = true;
    const c = this.st(f);
    if (!c || sec.round !== c.round) return;
    this.secret = sec;
    this.showMark(this.chests[sec.chest], sec.mimic);
    this.say(sec.mimic ? 'Ce coffre est la MIMIQUE ! (toi seul le sais)' : 'Ce coffre est sans danger (toi seul le sais)', 3.2, sec.mimic ? 'caught' : 'sk');
  }

  applyTick(tick: MinigameTick, f: Frame): void {
    for (const [id, x, z, yaw, anim] of tick.bots) {
      const r = f.remotes.get(id);
      if (!r) continue;
      // retour au coin (ou départ de manche) : d'un coup, pas en glissant à travers la salle
      if (Math.hypot(r.target.x - x, r.target.z - z) > 2.5) r.teleport({ p: [x, 0, z], r: yaw, a: anim });
      else r.setTransform({ p: [x, 0, z], r: yaw, a: anim });
    }
  }

  /** Acteur (moi ou un autre) par id. */
  private actor(f: Frame, id: string | null | undefined): THREE.Object3D | null {
    if (!id) return null;
    return id === f.myId ? f.me.root : f.remotes.get(id)?.root ?? null;
  }

  update(_t: number, dt: number, f: Frame): void {
    const t = this.time;
    this.particles.update(dt);
    this.podium.update(dt);
    for (const tc of this.torches) {
      const flick = 0.82 + 0.18 * Math.sin(t * 13 + tc.base * 3.1) * Math.sin(t * 7.3 + tc.light.position.x);
      tc.light.intensity = tc.base * flick;
      tc.flame.scale.setScalar(1.3 + 0.25 * flick);
    }
    const c = this.st(f);
    if (f.phase === 'rules') this.updateTraining(f);
    if (c) this.syncPlay(c, f, t);
    else if (f.phase !== 'rules') { this.turnRing.visible = false; this.loupe.visible = false; }
    for (const ch of this.chests) this.animateChest(ch, t, dt);
    if (f.phase === 'rules' && this.train) {
      const insp = this.time < this.train.inspectUntil;
      this.loupe.visible = insp;
      if (insp) this.loupe.position.set(f.me.root.position.x, 2.7 + Math.sin(t * 5) * 0.08, f.me.root.position.z);
    }
  }

  /** Partie : coffres de la manche, ouverture en cours, anneau du joueur dont c'est le tour, loupe. */
  private syncPlay(c: ChestsState, f: Frame, t: number): void {
    this.ensureChests(`${c.round}|${c.count}`, c.count, c.opened, t);
    if (this.secret && this.secret.round !== c.round) this.secret = null;
    const o = c.opening;
    if (o && c.stage === 'opening') {
      const key = `${c.round}|${o.chest}|${c.stageAt}`;
      if (key !== this.openingKey) {
        this.openingKey = key;
        const ch = this.chests[o.chest];
        if (ch && ch.mode === 'closed') this.startOpening(ch, o.mimic, this.actor(f, o.by), t);
      }
    }
    // j'ai ouvert la mimique : je tombe ; un trésor : je me réjouis
    const mineOpen = this.chests.find((ch) => (ch.mode === 'mimic' || ch.mode === 'open') && ch.victim === f.me.root);
    if (mineOpen) {
      const key = `${c.round}|${mineOpen.i}`;
      if (key !== this.bitten) {
        this.bitten = key;
        if (mineOpen.mode === 'mimic') f.me.playPose('Death_A', { hold: true });
        else f.me.playPose('Cheer', { speed: 1.2 });
      }
    }
    // anneau doré sous les pieds de celui qui joue
    const who = c.stage === 'turn' || c.stage === 'intro' || c.stage === 'opening' ? this.actor(f, c.stage === 'opening' ? c.opening?.by : c.turn) : null;
    this.turnRing.visible = !!who;
    if (who) {
      this.turnRing.position.set(who.position.x, 0.05, who.position.z);
      (this.turnRing.material as THREE.MeshBasicMaterial).opacity = 0.6 + 0.3 * Math.sin(t * 5);
    }
    // loupe au-dessus de celui qui inspecte (vrai ou faux : personne ne sait)
    const insp = c.inspecting ? this.actor(f, c.inspecting.by) : null;
    this.loupe.visible = !!insp;
    if (insp) this.loupe.position.set(insp.position.x, 2.75 + Math.sin(t * 5) * 0.08, insp.position.z);
  }

  /* ================= HUD ================= */

  private name(f: Frame, id: string | null | undefined): string {
    if (!id) return '';
    if (id === f.myId) return 'toi';
    return f.state.players.find((p) => p.id === id)?.name ?? '?';
  }

  hud(f: Frame): HudInfo {
    const c = f.mg.chests;
    let status: HudInfo['status'] = null;
    const flash = this.flash && this.flash.until > this.time && this.flash.cls !== 'train' ? this.flash : null;
    const left = c ? Math.max(0, Math.ceil((c.stageEndsAt - f.playMs) / 1000)) : 0;
    if (flash) status = { text: flash.text, cls: flash.cls };
    else if (c && f.phase === 'mgPlay') {
      const who = this.name(f, c.turn), mine = c.turn === f.myId;
      if (c.stage === 'intro') status = { text: `Manche ${c.round + 1} : ${c.count} coffres… et une mimique` };
      else if (c.stage === 'turn' && c.inspecting) status = { text: `${c.inspecting.by === f.myId ? 'Tu inspectes' : `${this.name(f, c.inspecting.by)} inspecte`} un coffre…` };
      else if (c.stage === 'turn' && mine) status = { text: `À toi ! E : ouvrir un coffre · R : l’inspecter`, cls: 'sk' };
      else if (c.stage === 'turn') status = { text: `Au tour de ${who}…` };
      else if (c.stage === 'opening') status = { text: `${c.opening?.by === f.myId ? 'Tu ouvres' : `${this.name(f, c.opening?.by)} ouvre`} un coffre…` };
      else if (c.stage === 'out') {
        const v = c.out[c.out.length - 1];
        status = { text: v === f.myId ? 'Croqué par la mimique ! Tu regardes la suite' : `${this.name(f, v)} s’est fait croquer par la mimique !`, cls: 'caught' };
      }
    }
    const turnName = c?.turn ? this.name(f, c.turn) : '—';
    let extra: string | undefined;
    if (f.imposter && f.phase === 'mgPlay') {
      extra = `<div class="mk-basket"><small>Inspection secrète</small><p>${this.secretUsed ? 'Déjà utilisée' : 'Ta prochaine inspection (<span class="key">R</span>) te dira ce que contient le coffre'}</p></div>`;
    }
    return {
      boxes: [
        { label: `Manche ${c ? c.round + 1 : 1}`, value: `${c?.count ?? 3} coffres` },
        { label: c?.stage === 'turn' ? `Au tour de · ${left} s` : 'Au tour de', value: turnName, cls: c?.stage === 'turn' && left <= 5 ? 'caught' : '' },
      ],
      chip: (id) => {
        if (!c) return { text: '' };
        if (c.out.includes(id)) return { text: 'Croqué', cls: 'caught' };
        if (c.turn === id) return { text: 'Son tour', cls: 'sk' };
        return { text: 'En lice' };
      },
      status,
      extra,
    };
  }

  exit(): void {
    this.train = null;
    this.clearChests();
    this.turnRing.visible = false;
    this.loupe.visible = false;
  }
}
