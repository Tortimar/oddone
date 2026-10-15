import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  DEFAULT_CONFIG, MINE, SLOT_COLORS, cellCenter, makeMineTracks, raceDistance, raceSpan, raceTime, trackPieces, trackPoint,
  type MineState, type MineTrack, type MinigameSecret, type MinigameTick, type TrackPiece,
} from '@oddone/shared';
import { camera, canvasTexture, gradientMap, renderer, toon } from '../engine/render.ts';
import { setCustomCamera } from '../game/cameraRig.ts';
import { measureSitPose } from '../characters/character.ts';
import { playSfx } from '../audio/audio.ts';
import { loadKit, type Kit } from '../world/kits.ts';
import { glow } from '../world/outside.ts';
import type { World } from '../world/tavern.ts';
import { $, escapeHtml } from '../ui/dom.ts';
import { portraitImg } from '../ui/portraits.ts';
import { Particles, PodiumView } from './effects.ts';
import type { Frame, GameView, HudInfo } from './view.ts';
import { placeColor, placeLabel } from '../world/floatText.ts';

/**
 * L'arène des « Wagonnets de la Mine » : une galerie de mine vue de haut, fermée de parois de
 * roche et d'étais de bois, le quai en haut, la sortie en bas. Quatre voies serpentent entre les
 * deux. La caméra est menée par le mini-jeu lui-même (caméra `custom`) :
 *   - au quai (arrivée des wagons, malédiction, choix) : face aux joueurs, les voies dans le noir ;
 *   - survol : de haut, du quai à la sortie, une seule fois, à la lueur d'une lanterne ;
 *   - course et classement : toute la mine d'un coup d'œil.
 * Les personnages sont placés ici à chaque image (sur le quai, ou assis dans leur wagon) : leur
 * position se déduit du temps de course, la même chez tout le monde.
 */

const C = MINE.cell, H = C / 2, G = MINE.gauge;
const GRID_HALF = (MINE.cols * C) / 2;
const GATE_Z = cellCenter(0, -1)[1];
const EXIT_Z = cellCenter(0, MINE.rows)[1];
const WALL_X = GRID_HALF + 2.4;
const QUAY_FRONT = GATE_Z - H;
const NORTH_Z = QUAY_FRONT - MINE.quayDepth * C - 1.4;
const SOUTH_Z = EXIT_Z + H + 1.8;
/** Hauteur (depuis le sol) où l'on s'assoit dans un wagon. */
const SEAT_Y = 0.5;
const ROUND_NAMES = ['1er', '2e', '3e', '4e'];

const ease = (k: number) => { const x = Math.min(1, Math.max(0, k)); return x * x * (3 - 2 * x); };

/* ================= Rails ================= */

const railMat = new THREE.MeshToonMaterial({ color: '#c3c8d0', gradientMap, emissive: '#30343a' });
const sleeperMat = toon('#5e3b20');
const bumperMat = toon('#8a2b1e');

/** Bande de quadrilatères entre deux suites de points (une face d'un rail courbe). */
function strip(a: THREE.Vector3[], b: THREE.Vector3[]): THREE.BufferGeometry {
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i < a.length; i++) pos.push(a[i].x, a[i].y, a[i].z, b[i].x, b[i].y, b[i].z);
  for (let i = 0; i < a.length - 1; i++) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Rail en quart de cercle de rayon R autour du coin (H, −H) : du milieu du côté nord au milieu du côté est. */
function arcRail(R: number): THREE.BufferGeometry {
  const N = 14, w = 0.05, y0 = 0.08, y1 = 0.18;
  const ring = (r: number, y: number) => [...Array(N + 1).keys()].map((i) => {
    const t = (i / N) * (Math.PI / 2);
    return new THREE.Vector3(H - Math.cos(t) * r, y, -H + Math.sin(t) * r);
  });
  const top = strip(ring(R - w, y1), ring(R + w, y1));
  const outer = strip(ring(R + w, y1), ring(R + w, y0));
  const inner = strip(ring(R - w, y0), ring(R - w, y1));
  return mergeGeometries([top, outer, inner])!;
}

/** Les quatre géométries de voie (droite / courbe ; rails / traverses), construites une fois. */
const GEO = (() => {
  const straightRails = mergeGeometries([-G, G].map((x) => new THREE.BoxGeometry(0.1, 0.1, C).translate(x, 0.13, 0)))!;
  const straightSleepers = mergeGeometries([0, 1, 2, 3].map((k) => new THREE.BoxGeometry(1.22, 0.08, 0.26).translate(0, 0.04, -H + C / 8 + (k * C) / 4)))!;
  const curveRails = mergeGeometries([arcRail(H - G), arcRail(H + G)])!;
  const curveSleepers = mergeGeometries([0, 1, 2].map((k) => {
    const t = ((k + 0.5) / 3) * (Math.PI / 2);
    return new THREE.BoxGeometry(1.22, 0.08, 0.26).rotateY(Math.PI + t).translate(H - Math.cos(t) * H, 0.04, -H + Math.sin(t) * H);
  }))!;
  return { straightRails, straightSleepers, curveRails, curveSleepers };
})();

/** Orientation d'un morceau : droit nord-sud (0) / est-ouest (π/2) ; courbe nord-est tournée de −kπ/2. */
function pieceRotation(p: TrackPiece): number {
  if (p.straight) return p.a % 2 === 0 ? 0 : Math.PI / 2;
  const lo = Math.min(p.a, p.b), hi = Math.max(p.a, p.b);
  const k = lo === 0 && hi === 3 ? 3 : lo;
  return (-k * Math.PI) / 2;
}

/* ================= Wagon ================= */

const NUMBER_TEX = [1, 2, 3, 4].map((n) => canvasTexture(128, 128, (g, w, h) => {
  g.fillStyle = '#e9d3a4'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#3a2412'; g.lineWidth = 10; g.strokeRect(5, 5, w - 10, h - 10);
  g.font = '900 96px "Lilita One", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#3a2412'; g.fillText(String(n), w / 2, h / 2 + 6);
}));
const SKULL_TEX = canvasTexture(128, 128, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#6a2c91'; g.strokeStyle = '#1d120c'; g.lineWidth = 7;
  g.beginPath(); g.arc(w / 2, h / 2, 54, 0, Math.PI * 2); g.fill(); g.stroke();
  g.font = '78px serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#f3e6ff'; g.fillText('☠', w / 2, h / 2 + 4);
});

interface WagonView {
  i: number;
  root: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Mesh[];
  aura: THREE.Sprite;
  skull: THREE.Sprite;
  /** Arrivé (effets déjà joués) pour cette course. */
  arrived: boolean;
  smokeAt: number;
}

function makeWagon(i: number): Omit<WagonView, 'aura' | 'skull' | 'arrived' | 'smokeAt'> {
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body);
  const wood = toon('#8a5a32'), dark = toon('#5a3a22'), iron = toon('#4b4f57');
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; body.add(m); return m;
  };
  const L = 1.7, W = 1.24, B = 0.34, T = 1.02;
  add(new THREE.BoxGeometry(W, 0.1, L), dark, 0, B, 0);
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.1, T - B, L), wood, s * (W / 2), (B + T) / 2, 0);
    add(new THREE.BoxGeometry(W + 0.1, T - B, 0.1), wood, 0, (B + T) / 2, s * (L / 2));
  }
  // cerclages de fer et rebord
  for (const y of [B + 0.12, T - 0.06]) {
    for (const s of [-1, 1]) {
      add(new THREE.BoxGeometry(0.13, 0.08, L + 0.06), iron, s * (W / 2), y, 0);
      add(new THREE.BoxGeometry(W + 0.16, 0.08, 0.13), iron, 0, y, s * (L / 2));
    }
  }
  // numéro peint devant et derrière
  for (const s of [-1, 1]) {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.46), new THREE.MeshToonMaterial({ map: NUMBER_TEX[i], gradientMap }));
    plate.position.set(0, (B + T) / 2 + 0.02, s * (L / 2 + 0.065));
    plate.rotation.y = s > 0 ? 0 : Math.PI;
    body.add(plate);
  }
  const wheels: THREE.Mesh[] = [];
  const wheelGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.12, 14).rotateZ(Math.PI / 2);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const w = new THREE.Mesh(wheelGeo, iron);
    w.position.set(sx * G, 0.24, sz * 0.52); w.castShadow = true;
    root.add(w); wheels.push(w);
  }
  return { i, root, body, wheels };
}

/* ================= Arène ================= */

interface CamPose { pos: THREE.Vector3; target: THREE.Vector3; fov: number }

interface Train { tracks: MineTrack[]; phase: 'choose' | 'race' | 'end'; at: number; mine: number; ends: number }

export class MineArena implements GameView {
  readonly scene = new THREE.Scene();
  readonly world: World;
  readonly particles: Particles;
  readonly podium: PodiumView;
  readonly cameras = { training: 'custom', play: 'custom' } as const;
  private wagons: WagonView[] = [];
  private rows: THREE.Group[] = [];
  private trackKey = '';
  private pieces: TrackPiece[][] = [];
  private tracks: MineTrack[] = [];
  private hemi!: THREE.HemisphereLight;
  private key!: THREE.DirectionalLight;
  private lantern!: THREE.SpotLight;
  private flames: { light: THREE.PointLight; flame: THREE.Sprite; base: number }[] = [];
  private crystals: { s: THREE.Sprite; base: number }[] = [];
  private sitHips = measureSitPose(DEFAULT_CONFIG);
  private groundY = 0;
  private mySitting = false;
  private myCurse: { round: number; wagon: number } | null = null;
  private pending: { round: number; wagon: number } | null = null;
  private flash: { text: string; until: number; cls?: string } | null = null;
  private train: Train | null = null;
  private f: Frame | null = null;
  private layer: HTMLElement;
  private cards: HTMLElement[] = [];
  private active = false;
  private raceStarted = '';
  private lastTick = -1;
  private tmp = new THREE.Vector3();
  private camA: CamPose = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 50 };
  private camB: CamPose = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 50 };
  private get time(): number { return performance.now() / 1000; }

  private constructor(private dungeon: Kit, private medieval: Kit, private halloween: Kit) {
    this.world = { colliders: [], circles: [], bounds: { halfX: WALL_X + 2, halfZ: -NORTH_Z + 2 }, ground: () => this.groundY };
    this.build();
    this.particles = new Particles(this.scene);
    this.podium = new PodiumView(this.scene, [...MINE.podium], this.world, this.particles);
    for (let i = 0; i < MINE.wagons; i++) {
      const w = makeWagon(i);
      const aura = glow('#b45cff', 3.2, 0); aura.position.y = 0.9; w.root.add(aura);
      const skull = new THREE.Sprite(new THREE.SpriteMaterial({ map: SKULL_TEX, transparent: true, depthWrite: false, depthTest: false }));
      skull.scale.setScalar(0.8); skull.position.y = 2.3; skull.visible = false; skull.renderOrder = 6; w.root.add(skull);
      this.wagons.push({ ...w, aura, skull, arrived: false, smokeAt: 0 });
      this.scene.add(w.root);
    }
    // les étiquettes au-dessus des wagons (numéro, qui est dedans) : cliquables pour choisir
    this.layer = document.createElement('div');
    this.layer.id = 'mineFloat';
    this.layer.hidden = true;
    for (let i = 0; i < MINE.wagons; i++) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'mf';
      el.addEventListener('click', (e) => { e.stopPropagation(); this.choose(i); });
      this.layer.append(el);
      this.cards.push(el);
    }
    document.body.append(this.layer);
    window.addEventListener('keydown', this.onKey);
    renderer.domElement.addEventListener('pointerdown', this.onPointer);
  }

  static async create(): Promise<MineArena> {
    const [d, m, h] = await Promise.all([loadKit('dungeon'), loadKit('medieval'), loadKit('halloween')]);
    return new MineArena(d, m, h);
  }

  startYaw(): number { return 0; }

  /* ================= Décor ================= */

  /** Un modèle mis à la taille voulue (plus grande dimension), posé au sol. */
  private sized(kit: Kit, name: string, size: number, x: number, z: number, ry: number, y = 0): THREE.Object3D | null {
    if (!kit.has(name)) return null;
    const o = kit.spawn(name, { x, z, ry, parent: this.scene });
    const box = new THREE.Box3().setFromObject(o), s = box.getSize(this.tmp);
    o.scale.multiplyScalar(size / Math.max(s.x, s.y, s.z));
    o.position.y = y;
    return o;
  }

  private build(): void {
    const s = this.scene, k = this.dungeon;
    s.background = new THREE.Color('#0a0705');
    s.fog = new THREE.Fog('#0a0705', 38, 70);
    this.hemi = new THREE.HemisphereLight('#c9b6a0', '#2a1c12', 0.62);
    s.add(this.hemi);
    this.key = new THREE.DirectionalLight('#ffe2b8', 1);
    this.key.position.set(-6, 26, 10);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    Object.assign(this.key.shadow.camera, { left: -18, right: 18, top: 20, bottom: -20, near: 1, far: 60 });
    this.key.shadow.bias = -0.0008;
    s.add(this.key, this.key.target);
    // la lanterne du survol : elle suit la caméra et n'éclaire que ce qu'elle regarde
    this.lantern = new THREE.SpotLight('#ffd49a', 0, 60, 0.62, 0.75, 0);
    s.add(this.lantern, this.lantern.target);

    // sol de terre battue, un peu plus foncé sous les voies
    const dirt = canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = '#5a412d'; g.fillRect(0, 0, w, h);
      let seed = 7;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      for (let i = 0; i < 900; i++) {
        const v = rnd();
        g.fillStyle = v < 0.5 ? `rgba(40,26,16,${0.15 + rnd() * 0.25})` : `rgba(140,108,76,${0.1 + rnd() * 0.2})`;
        g.beginPath(); g.arc(rnd() * w, rnd() * h, 0.6 + rnd() * 2.6, 0, Math.PI * 2); g.fill();
      }
    });
    dirt.wrapS = dirt.wrapT = THREE.RepeatWrapping;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(WALL_X * 2 + 6, SOUTH_Z - NORTH_Z + 6), new THREE.MeshToonMaterial({ color: '#d2b89a', map: dirt.clone(), gradientMap }));
    (ground.material.map as THREE.Texture).repeat.set(8, 9);
    ground.rotation.x = -Math.PI / 2; ground.position.set(0, 0, (NORTH_Z + SOUTH_Z) / 2); ground.receiveShadow = true;
    s.add(ground);
    dirt.repeat.set(6, 7);
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(MINE.cols * C + 1.2, (MINE.rows + 2) * C + 0.2), new THREE.MeshToonMaterial({ color: '#a38a72', map: dirt, gradientMap }));
    bed.rotation.x = -Math.PI / 2; bed.position.set(0, 0.006, (GATE_Z + EXIT_Z) / 2); bed.receiveShadow = true;
    s.add(bed);
    // quelques dalles de terre caillouteuse le long des parois
    for (const [x, z] of [[-WALL_X + 1, -10], [WALL_X - 1, -2], [-WALL_X + 1, 6], [WALL_X - 1, 13]] as const) {
      if (k.has('floor_dirt_large_rocky')) k.spawn('floor_dirt_large_rocky', { x, z, ry: x > 0 ? Math.PI / 2 : 0, scale: 0.6, parent: s, shadows: false });
    }

    this.buildWalls();
    this.buildQuay();
    this.buildExit();
    this.buildProps();
  }

  /** Parois : murs de pierre, gros rochers devant et au-dessus (on ne voit jamais le dehors), étais de bois. */
  private buildWalls(): void {
    const s = this.scene, k = this.dungeon, m = this.medieval;
    const wall = (x: number, z: number, ry: number, h: number) => { const w = k.spawn('wall', { x, z, ry, parent: s }); w.scale.set(1, h, 1); };
    for (let z = NORTH_Z + 2; z <= SOUTH_Z; z += 4) { wall(-WALL_X - 0.5, z, Math.PI / 2, 1.7); wall(WALL_X + 0.5, z, -Math.PI / 2, 1.7); }
    for (let x = -WALL_X + 2; x <= WALL_X; x += 4) { wall(x, NORTH_Z - 0.5, 0, 1.7); wall(x, SOUTH_Z + 0.5, Math.PI, 1.7); }
    // la roche de la montagne, tout autour et par-dessus les murs : la galerie est creusée dedans
    const mountains = ['mountain_A', 'mountain_B', 'mountain_C'];
    let n = 0;
    const rock = (x: number, z: number, size: number, y = 0) => {
      const o = this.sized(m, mountains[n++ % 3], size, x, z, n * 1.7, y);
      if (o) this.darken(o, 0.42);
    };
    for (let z = NORTH_Z - 2; z <= SOUTH_Z + 2; z += 4.6) {
      rock(-WALL_X - 4.5, z, 11 + (n % 3) * 1.6, -1.5);
      rock(WALL_X + 4.5, z + 2.3, 11 + ((n + 1) % 3) * 1.6, -1.5);
    }
    for (let x = -WALL_X - 3; x <= WALL_X + 3; x += 5) rock(x, NORTH_Z - 4.5, 12 + (n % 3) * 1.5, -1.5);
    // gros blocs écroulés au pied des parois (cassent la ligne droite des murs)
    const singles = ['rock_single_A', 'rock_single_B', 'rock_single_C', 'rock_single_D', 'rock_single_E'];
    const boulder = (x: number, z: number, size: number) => { const o = this.sized(m, singles[n++ % 5], size, x, z, n * 2.3); if (o) this.darken(o, 0.6); };
    for (let z = NORTH_Z + 3; z <= SOUTH_Z - 1; z += 3.1) {
      if (n % 3 !== 0) boulder(-WALL_X + 0.4, z + (n % 2), 1.6 + (n % 4) * 0.5);
      if (n % 4 !== 1) boulder(WALL_X - 0.4, z + 1.2, 1.4 + (n % 3) * 0.6);
    }
    // étais de bois le long des parois : deux poteaux et une poutre en surplomb
    const beam = toon('#6b4426'), beamDark = toon('#4a2e18');
    for (let z = NORTH_Z + 4; z <= SOUTH_Z - 2; z += 5.4) {
      for (const sx of [-1, 1]) {
        const x = sx * (WALL_X - 0.35);
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.42, 6.6, 0.42), beam);
        post.position.set(x, 3.3, z); post.castShadow = true; s.add(post);
        const over = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.42, 0.46), beamDark);
        over.position.set(x - sx * 1.1, 6.4, z); over.castShadow = true; s.add(over);
        const brace = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.9, 0.22), beam);
        brace.position.set(x - sx * 0.62, 5.6, z); brace.rotation.z = sx * 0.78; s.add(brace);
      }
    }
    // poutres du plafond au-dessus du quai (on les voit depuis le quai, pas d'en haut)
    for (const x of [-9, -3, 3, 9]) {
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.46, MINE.quayDepth * C + 3.4), beamDark);
      lintel.position.set(x, 6.8, (NORTH_Z + QUAY_FRONT) / 2 - 0.4); s.add(lintel);
    }
    const across = new THREE.Mesh(new THREE.BoxGeometry(WALL_X * 2, 0.5, 0.5), beam);
    across.position.set(0, 6.6, QUAY_FRONT - 0.4); across.castShadow = true; s.add(across);
    // lanternes accrochées aux étais (vraies lumières)
    for (const [x, z] of [[-WALL_X + 1.6, -9], [WALL_X - 1.6, -3.6], [-WALL_X + 1.6, 1.8], [WALL_X - 1.6, 7.2], [-WALL_X + 1.6, 12.6], [WALL_X - 1.6, -14.4]] as const) {
      if (this.halloween.has('lantern_hanging')) this.halloween.spawn('lantern_hanging', { x, y: 6.2, z, parent: s, shadows: false });
      const flame = glow('#ffb14a', 1.6, 0.85); flame.position.set(x, 5.45, z); s.add(flame);
      const light = new THREE.PointLight('#ffa64a', 7, 13, 1.3); light.position.set(x, 5.2, z); s.add(light);
      this.flames.push({ light, flame, base: 7 });
    }
    // cristaux qui luisent dans la roche
    const crystalAt: [number, number, string, number][] = [
      [-WALL_X + 0.8, -6.5, '#5ee7ff', 1.1], [WALL_X - 0.9, 4.4, '#c77dff', 1.25], [-WALL_X + 1.1, 9.6, '#c77dff', 0.9],
      [WALL_X - 1, -11.5, '#5ee7ff', 1], [-WALL_X + 1.2, SOUTH_Z - 1.4, '#5ee7ff', 1.2], [WALL_X - 1.3, SOUTH_Z - 1.2, '#c77dff', 1],
    ];
    for (const [x, z, color, size] of crystalAt) this.crystal(x, z, color, size);
    for (const [x, z, color] of [[-WALL_X + 1, -6.5, '#5ee7ff'], [WALL_X - 1, 4.4, '#c77dff']] as const) {
      const l = new THREE.PointLight(color, 4, 8, 1.5); l.position.set(x, 1.4, z); s.add(l);
    }
  }

  /** Roche de la montagne, assombrie et brunie : on est sous terre. */
  private darken(o: THREE.Object3D, k: number): void {
    const brown = new THREE.Color('#5a4232');
    o.traverse((c) => {
      const mesh = c as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false; mesh.receiveShadow = true;
      const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
      if (mat.color) mat.color.lerp(brown, 0.45).multiplyScalar(k);
      mesh.material = mat;
    });
  }

  /** Une grappe de cristaux qui luisent. */
  private crystal(x: number, z: number, color: string, size: number): void {
    const g = new THREE.Group();
    const mat = new THREE.MeshToonMaterial({ color, gradientMap, emissive: color, emissiveIntensity: 0.55, transparent: true, opacity: 0.92 });
    const geo = new THREE.OctahedronGeometry(0.35, 0);
    for (let i = 0; i < 6; i++) {
      const c = new THREE.Mesh(geo, mat);
      const a = i * 1.9, r = i ? 0.25 + (i % 3) * 0.12 : 0;
      c.position.set(Math.cos(a) * r, 0.3, Math.sin(a) * r);
      c.scale.set(0.55, 1.5 + ((i * 7) % 4) * 0.45, 0.55);
      c.rotation.set(Math.cos(a) * 0.45, a, Math.sin(a) * 0.45);
      g.add(c);
    }
    g.position.set(x, 0, z); g.scale.setScalar(size);
    this.scene.add(g);
    const halo = glow(color, 3.2 * size, 0.5); halo.position.set(x, 0.9 * size, z);
    this.scene.add(halo);
    this.crystals.push({ s: halo, base: 0.5 });
  }

  /** Le quai de départ : plancher, butoir, et le bric-à-brac du mineur. */
  private buildQuay(): void {
    const s = this.scene, k = this.dungeon;
    const depth = QUAY_FRONT - NORTH_Z;
    const planks = toon('#7b5230'), planks2 = toon('#6a4428');
    for (let i = 0, z = QUAY_FRONT - 0.3; z > NORTH_Z + 0.2; i++, z -= 0.6) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(WALL_X * 2 - 0.4, 0.08, 0.56), i % 2 ? planks : planks2);
      p.position.set(0, 0.04, z); p.receiveShadow = true; s.add(p);
    }
    const edge = new THREE.Mesh(new THREE.BoxGeometry(WALL_X * 2 - 0.4, 0.26, 0.3), toon('#4a2e18'));
    edge.position.set(0, 0.13, QUAY_FRONT - 0.15); s.add(edge);
    void depth;
    // enseigne de la mine sur le mur du fond
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(7, 1.6), new THREE.MeshToonMaterial({ gradientMap, map: canvasTexture(512, 118, (g, w, h) => {
      g.fillStyle = '#6b4426'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#3a2412'; g.lineWidth = 10; g.strokeRect(5, 5, w - 10, h - 10);
      for (const y of [38, 80]) { g.strokeStyle = 'rgba(40,20,8,.35)'; g.lineWidth = 3; g.beginPath(); g.moveTo(12, y); g.lineTo(w - 12, y); g.stroke(); }
      g.font = '64px "Lilita One", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#ffd36a'; g.strokeStyle = '#2a1608'; g.lineWidth = 8;
      g.strokeText('MINE DU ROI', w / 2, h / 2 + 4); g.fillText('MINE DU ROI', w / 2, h / 2 + 4);
    }) }));
    sign.position.set(0, 3.9, NORTH_Z + 0.05); s.add(sign);
    // torches de part et d'autre de l'enseigne
    for (const x of [-6, 6]) {
      if (k.has('torch_mounted')) k.spawn('torch_mounted', { x, y: 2.6, z: NORTH_Z + 0.05, parent: s, shadows: false });
      const flame = glow('#ffae42', 1.4, 0.8); flame.position.set(x, 3.25, NORTH_Z + 0.5); s.add(flame);
    }
    for (const [name, x, z, ry] of [
      ['barrel_large', -WALL_X + 1.6, NORTH_Z + 1.3, 0.3], ['barrel_small_stack', -WALL_X + 3.4, NORTH_Z + 1.1, 0], ['crates_stacked', WALL_X - 1.7, NORTH_Z + 1.4, 0.4],
      ['box_small_decorated', WALL_X - 3.6, NORTH_Z + 1, 0.2], ['keg_decorated', -9.6, NORTH_Z + 0.9, Math.PI / 2], ['table_small_decorated_A', 9.6, NORTH_Z + 1.2, 0],
    ] as const) if (k.has(name)) k.spawn(name, { x, z, ry, parent: s });
    if (this.halloween.has('lantern_standing')) this.halloween.spawn('lantern_standing', { x: 9.6, y: 1.05, z: NORTH_Z + 1.2, parent: s, shadows: false });
  }

  /** La sortie : butoirs au bout des voies, et la galerie qui s'enfonce dans le noir. */
  private buildExit(): void {
    const s = this.scene;
    const beam = toon('#6b4426');
    // trois bouches de galerie dans le mur du fond, cadrées d'étais
    for (const x of [-8, 0, 8]) {
      const hole = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 4.6), new THREE.MeshBasicMaterial({ color: '#050302' }));
      hole.position.set(x, 2.3, SOUTH_Z - 0.02); hole.rotation.y = Math.PI; s.add(hole);
      for (const sx of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.42, 4.8, 0.42), beam);
        post.position.set(x + sx * 2.3, 2.4, SOUTH_Z - 0.3); post.castShadow = true; s.add(post);
      }
      const top = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.48, 0.5), beam);
      top.position.set(x, 4.9, SOUTH_Z - 0.3); s.add(top);
    }
  }

  private buildProps(): void {
    const k = this.dungeon, s = this.scene;
    // de vieux wagons garés contre les parois, pleins de minerai d'or
    const ore = new THREE.MeshToonMaterial({ color: '#f2c14a', gradientMap, emissive: '#6a4a00', emissiveIntensity: 0.4 });
    for (const [x, z, ry] of [[-WALL_X + 1.3, -1.2, 0.08], [WALL_X - 1.3, 10.4, -0.1]] as const) {
      const w = makeWagon(Math.abs(Math.round(x)) % 4);
      w.root.position.set(x, 0, z); w.root.rotation.y = ry;
      for (let i = 0; i < 9; i++) {
        const lump = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22 + (i % 3) * 0.05, 0), ore);
        lump.position.set(((i % 3) - 1) * 0.34, 1.02 + (i % 2) * 0.12, (Math.floor(i / 3) - 1) * 0.44);
        w.body.add(lump);
      }
      s.add(w.root);
    }
    for (const [name, x, z, ry, scale] of [
      ['rubble_large', -WALL_X + 1.2, 5.6, Math.PI / 2, 0.42], ['rubble_half', WALL_X - 1.1, -8.4, -Math.PI / 2, 0.55], ['barrel_small', WALL_X - 1.4, 1.2, 0, 1],
      ['crates_stacked', -WALL_X + 1.4, -11.8, 0.3, 0.8], ['box_stacked', WALL_X - 1.6, SOUTH_Z - 2.6, 0.2, 0.6], ['barrel_large', -WALL_X + 1.6, SOUTH_Z - 3.8, 0, 0.8],
    ] as const) if (k.has(name)) k.spawn(name, { x, z, ry, scale, parent: s });
  }

  /* ================= Voies ================= */

  private clearTracks(): void {
    for (const g of this.rows) g.removeFromParent();
    this.rows = []; this.pieces = []; this.tracks = []; this.trackKey = '';
  }

  /** Construit les voies (une fois par manche) : un groupe par ligne de la grille, pour pouvoir les cacher. */
  private ensureTracks(key: string, tracks: MineTrack[]): void {
    if (key === this.trackKey) return;
    this.clearTracks();
    this.trackKey = key;
    this.tracks = tracks;
    this.rows = [...Array(MINE.rows + 2).keys()].map(() => { const g = new THREE.Group(); this.scene.add(g); return g; });
    for (const t of tracks) {
      const pieces = trackPieces(t.cells);
      this.pieces.push(pieces);
      for (const p of pieces) {
        const [x, z] = cellCenter(p.col, p.row);
        const g = this.rows[p.row + 1];
        const rails = new THREE.Mesh(p.straight ? GEO.straightRails : GEO.curveRails, railMat);
        const sleepers = new THREE.Mesh(p.straight ? GEO.straightSleepers : GEO.curveSleepers, sleeperMat);
        for (const o of [rails, sleepers]) { o.position.set(x, 0, z); o.rotation.y = pieceRotation(p); o.receiveShadow = true; g.add(o); }
        if (p.row === MINE.rows) {
          // butoir au bout de la voie
          const bump = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 0.32), bumperMat);
          bump.position.set(x, 0.32, z + H - 0.18); bump.castShadow = true; g.add(bump);
        }
      }
    }
    for (const w of this.wagons) { w.arrived = false; w.skull.visible = false; }
  }

  /** Lignes visibles : au quai, seules les cases du départ ; pendant le survol et la course, tout. */
  private showRows(all: boolean): void {
    this.rows.forEach((g, i) => { g.visible = all || i === 0; });
  }

  /* ================= Partie ================= */

  private st(f: Frame): MineState | null {
    return f.phase === 'roleReveal' || f.phase === 'mgCountdown' || f.phase === 'mgPlay' ? f.mg.mine : null;
  }

  /** ms écoulées dans l'étape en cours. */
  private stageMs(f: Frame, s: MineState): number { return f.phase === 'mgPlay' ? f.playMs - s.stageAt : 0; }

  /** Wagon de chacun (y compris mon choix pas encore confirmé). */
  private wagonOf(f: Frame, s: MineState, id: string): number {
    if (id in s.picks) return s.picks[id];
    if (id === f.myId && this.pending?.round === s.round && s.stage === 'pick') return this.pending.wagon;
    return -1;
  }

  /** Position d'un wagon (et son cap) d'après l'étape et le temps de course. */
  private wagonPose(f: Frame, s: MineState, w: number): { d: number; y: number } {
    const t = s.tracks[w];
    const [d0, d1] = raceSpan(t);
    const occupied = Object.values(s.picks).includes(w);
    if (s.stage === 'intro') {
      // ils tombent du haut de la galerie, l'un après l'autre
      const k = f.phase === 'mgPlay' ? (this.stageMs(f, s) - w * 180) / 520 : 1;
      const y = k >= 1 ? 0 : k <= 0 ? 6 : 6 * (1 - k * k);
      return { d: d0, y };
    }
    if (s.stage === 'race' && occupied) return { d: raceDistance(t, this.raceMs(f, s), w === s.cursed), y: 0 };
    if (s.stage === 'score' && occupied) return { d: d1, y: 0 };
    return { d: d0, y: 0 };
  }

  private raceMs(f: Frame, s: MineState): number { return this.stageMs(f, s) - MINE.raceLeadMs; }

  private placeWagon(w: WagonView, pieces: TrackPiece[], d: number, y: number, t: number, moving: boolean): void {
    const [x, z, yaw] = trackPoint(pieces, d);
    w.root.position.set(x, y, z);
    w.root.rotation.y = yaw;
    // dans les virages, le wagon penche vers l'extérieur ; en roulant, il tressaute
    const [, , yaw2] = trackPoint(pieces, d + 0.4);
    let turn = yaw2 - yaw;
    if (turn > Math.PI) turn -= Math.PI * 2;
    if (turn < -Math.PI) turn += Math.PI * 2;
    w.body.rotation.z = moving ? Math.max(-0.2, Math.min(0.2, turn * 0.9)) : 0;
    w.body.position.y = moving ? Math.abs(Math.sin(t * 23 + w.i)) * 0.035 : 0;
    for (const wh of w.wheels) wh.rotation.x = -d / 0.24;
  }

  /** Où s'asseoir dans le wagon : la racine du personnage, pour que ses hanches tombent sur le banc. */
  private seat(w: WagonView): { x: number; y: number; z: number; yaw: number } {
    const yaw = w.root.rotation.y, c = Math.cos(yaw), s = Math.sin(yaw);
    const hx = this.sitHips.x, hz = this.sitHips.z - 0.12;
    const P = w.root.position;
    return { x: P.x - (hx * c + hz * s), y: P.y + w.body.position.y + SEAT_Y - (this.sitHips.y - 0.5), z: P.z - (-hx * s + hz * c), yaw };
  }

  /** Sur le quai ou dans son wagon : moi, les autres, les bots. */
  private placeActors(f: Frame, wagonOf: (id: string) => number): void {
    for (const p of f.state.players) {
      const w = wagonOf(p.id);
      const home = f.mg.starts[p.id] ?? [0, NORTH_Z + 2];
      if (p.id === f.myId) {
        const me = f.me;
        if (w >= 0) {
          const s = this.seat(this.wagons[w]);
          if (!this.mySitting) { this.mySitting = true; me.playPose('Sit_Chair_Idle', { once: false }); this.particles.burst(s.x, 0.8, s.z, '#d8c3a0', 8, 0.8, 0.6); }
          me.root.position.set(s.x, s.y, s.z); this.groundY = s.y;
          me.yaw = s.yaw; me.root.rotation.y = s.yaw;
        } else {
          if (this.mySitting) { this.mySitting = false; this.groundY = 0; me.placeAt(home[0], home[1], 0); }
          me.root.position.set(home[0], 0, home[1]);
          me.yaw = 0; me.root.rotation.y = 0;
        }
        continue;
      }
      const r = f.remotes.get(p.id);
      if (!r) continue;
      if (w >= 0) {
        const s = this.seat(this.wagons[w]);
        if (r.anim !== 'Sit_Chair_Idle') this.particles.burst(s.x, 0.8, s.z, '#d8c3a0', 8, 0.8, 0.6);
        r.teleport({ p: [s.x, s.y, s.z], r: s.yaw, a: 'Sit_Chair_Idle' });
      } else r.teleport({ p: [home[0], 0, home[1]], r: 0, a: 'Idle' });
    }
  }

  /* ================= Choix (clic, touches 1 à 4) ================= */

  private onKey = (e: KeyboardEvent): void => {
    if (!this.active || e.repeat) return;
    const m = /^(?:Digit|Numpad)([1-4])$/.exec(e.code);
    if (m) this.choose(Number(m[1]) - 1);
  };

  /** Un clic près d'un wagon le choisit (comme son étiquette). */
  private onPointer = (e: PointerEvent): void => {
    if (!this.active || !this.f || e.button !== 0) return;
    const rect = this.viewRect(this.f);
    let best = -1, bestD = 70;
    for (const w of this.wagons) {
      this.tmp.copy(w.root.position).setY(0.7).project(camera);
      const x = rect.left + ((this.tmp.x + 1) / 2) * rect.width, y = rect.top + ((1 - this.tmp.y) / 2) * rect.height;
      const d = Math.hypot(x - e.clientX, y - e.clientY);
      if (d < bestD) { bestD = d; best = w.i; }
    }
    if (best >= 0) this.choose(best);
  };

  private viewRect(f: Frame): { left: number; top: number; width: number; height: number } {
    if (f.phase === 'rules') return $('rsFrame').getBoundingClientRect();
    return { left: 0, top: 0, width: innerWidth, height: innerHeight };
  }

  private choose(w: number): void {
    const f = this.f;
    if (!f) return;
    if (f.phase === 'rules') {
      const tr = this.train;
      if (tr && tr.phase === 'choose' && tr.mine < 0) { tr.mine = w; playSfx('valider'); }
      return;
    }
    const s = this.st(f);
    if (!s || f.phase !== 'mgPlay') return;
    if (s.stage === 'curse' && f.imposter) {
      this.myCurse = { round: s.round, wagon: w };
      f.net.action('curse', w);
      playSfx('clic');
      return;
    }
    if (s.stage === 'pick' && !(f.myId in s.picks) && this.pending?.round !== s.round && !Object.values(s.picks).includes(w)) {
      this.pending = { round: s.round, wagon: w };
      f.net.action('board', w);
      playSfx('valider');
    }
  }

  onAct(): boolean { return true; }

  onSecret(sec: MinigameSecret): void {
    if (!('cursed' in sec)) return;
    this.myCurse = { round: sec.round, wagon: sec.cursed };
  }

  /* ================= Entraînement ================= */

  startTraining(): void { this.newTraining(); }
  stopTraining(): void { this.train = null; this.clearTracks(); }

  private newTraining(): void {
    const tracks = makeMineTracks(Math.random);
    this.train = { tracks, phase: 'choose', at: this.time, mine: -1, ends: 0 };
    this.ensureTracks(`train|${this.time}`, tracks);
  }

  private updateTraining(f: Frame, t: number): void {
    const tr = this.train;
    if (!tr) return;
    const k = this.time - tr.at;
    if (tr.phase === 'choose' && k > 4.5) {
      tr.phase = 'race'; tr.at = this.time;
      tr.ends = Math.max(...tr.tracks.map((x) => raceTime(x, false))) / 1000 + 1;
      playSfx('go');
    } else if (tr.phase === 'race' && k > tr.ends) {
      tr.phase = 'end'; tr.at = this.time;
      if (tr.mine >= 0) {
        const place = tr.tracks.map((x) => x.length).sort((a, b) => a - b).indexOf(tr.tracks[tr.mine].length);
        this.say(`Wagon ${tr.mine + 1} : ${ROUND_NAMES[place]} !`, 2.2, 'train');
      }
    } else if (tr.phase === 'end' && k > 2.4) {
      this.newTraining();
      return;
    }
    this.showRows(true);
    const raceMs = tr.phase === 'race' ? (this.time - tr.at) * 1000 - 400 : tr.phase === 'end' ? Infinity : 0;
    for (const w of this.wagons) {
      const tk = tr.tracks[w.i];
      const d = tr.phase === 'choose' ? raceSpan(tk)[0] : raceDistance(tk, raceMs, false);
      this.placeWagon(w, this.pieces[w.i], d, 0, t, tr.phase === 'race' && d < raceSpan(tk)[1]);
      w.aura.material.opacity = 0;
      w.skull.visible = false;
    }
    this.placeActors(f, (id) => (id === f.myId ? tr.mine : -1));
    this.shoot(this.overviewPose(this.camA));
  }

  /* ================= Caméras ================= */

  /**
   * Champ vertical pour voir `halfW` de large et `halfH` de haut (à `dist`), sans descendre sous
   * `minFov` : en écran large comme en portrait, tout tient dans le cadre.
   */
  private fit(halfW: number, dist: number, minFov: number, halfH = 0): number {
    const aspect = Math.max(0.3, camera.aspect);
    const v = 2 * Math.atan(Math.max(halfW / aspect, halfH) / dist) * (180 / Math.PI);
    return Math.min(100, Math.max(minFov, v));
  }

  /*
   * Les plans sont calculés à partir du temps de l'étape (et pas lissés image par image) : ils
   * tombent juste chez tout le monde, quelle que soit la fluidité de l'affichage.
   */

  /** Toute la mine d'un coup d'œil (course, classement, entraînement), le quai en haut. */
  private overviewPose(o: CamPose): CamPose {
    o.target.set(0, 0, 0.4);
    o.pos.set(0, 31, 14);
    o.fov = this.fit(GRID_HALF + 2.4, 32, 58);
    return o;
  }

  /** Le quai, vu depuis la mine : les wagons et les joueurs de face, les voies dans le noir. */
  private gatePose(o: CamPose): CamPose {
    o.target.set(0, 0.7, QUAY_FRONT - 0.9);
    o.pos.set(0, 10.5, QUAY_FRONT + 14.5);
    o.fov = this.fit(GRID_HALF + 2.6, 16.5, 38);
    return o;
  }

  /** Le survol : de haut, du quai à la sortie, à vitesse régulière (k de 0 à 1). */
  private flyoverPose(o: CamPose, k: number): CamPose {
    const z = GATE_Z - 1.2 + (EXIT_Z + 1.6 - (GATE_Z - 1.2)) * ease(k);
    const aspect = Math.max(0.3, camera.aspect);
    const h = Math.min(30, (GRID_HALF + 0.8) / (Math.tan((24 * Math.PI) / 180) * aspect));
    o.target.set(0, 0, z);
    o.pos.set(0, h, z + 3.2);
    o.fov = 48;
    return o;
  }

  /** Place la caméra : le plan `a`, ou un fondu de `a` vers `b` (k de 0 à 1). */
  private shoot(a: CamPose, b?: CamPose, k = 0): void {
    if (b) {
      const e = ease(k);
      a.pos.lerp(b.pos, e); a.target.lerp(b.target, e); a.fov += (b.fov - a.fov) * e;
    }
    setCustomCamera(a.pos, a.target, a.fov, Infinity);
  }

  /* ================= Boucle ================= */

  onPhase(f: Frame): void {
    if (f.phase === 'roleReveal' || f.phase === 'mgCountdown') {
      this.train = null;
      if (f.phase === 'roleReveal') { this.myCurse = null; this.pending = null; this.clearTracks(); }
    }
    if (f.phase === 'mgResults') {
      this.active = false;
      this.layer.hidden = true;
      this.groundY = 0; this.mySitting = false;
      this.clearTracks();
      for (const w of this.wagons) w.root.visible = false;
      this.setLights(false);
    }
  }

  beforeMove(f: Frame): void {
    f.me.frozen = true; // on ne marche pas : on choisit son wagon
    f.me.faceYaw = null;
  }

  afterMove(f: Frame): string | null {
    if (f.phase !== 'rules') return null;
    const msg = this.flash && this.flash.until > this.time && this.flash.cls === 'train' ? this.flash.text : null;
    if (msg) this.flash = null;
    return msg;
  }

  applyTick(_tick: MinigameTick): void { /* les positions se calculent ici, d'après le temps de course */ }

  private say(text: string, s = 2, cls?: string): void { this.flash = { text, until: this.time + s, cls }; }

  /** Lumière normale, ou pénombre du survol (seule la lanterne éclaire). */
  private setLights(dark: boolean): void {
    this.hemi.intensity = dark ? 0.16 : 0.62;
    this.key.intensity = dark ? 0.12 : 1;
    this.lantern.intensity = dark ? 2.6 : 0;
    for (const fl of this.flames) fl.base = dark ? 2.5 : 7;
  }

  update(_t: number, dt: number, f: Frame): void {
    const t = this.time;
    this.f = f;
    this.particles.update(dt);
    this.podium.update(dt);
    for (const fl of this.flames) {
      const k = 0.84 + 0.16 * Math.sin(t * 11 + fl.light.position.z) * Math.sin(t * 6.7 + fl.light.position.x);
      fl.light.intensity = fl.base * k;
      fl.flame.scale.setScalar(1.4 + 0.25 * k);
    }
    for (const c of this.crystals) c.s.material.opacity = c.base + 0.18 * Math.sin(t * 1.7 + c.s.position.x);

    const s = this.st(f);
    this.active = f.phase === 'rules' || (f.phase === 'mgPlay' && !!s && (s.stage === 'curse' || s.stage === 'pick'));
    if (f.phase === 'rules') {
      for (const w of this.wagons) w.root.visible = true;
      this.setLights(false);
      this.updateTraining(f, t);
      this.renderCards(f, null);
      return;
    }
    if (!s || !s.tracks.length) { this.layer.hidden = true; return; }
    this.ensureTracks(`${s.round}|${s.tracks.map((x) => x.cells[0][0]).join(',')}|${s.tracks[0].length}`, s.tracks);
    const ms = this.stageMs(f, s);
    const preview = s.stage === 'preview';
    this.setLights(preview);
    this.showRows(preview || s.stage === 'race' || s.stage === 'score');
    if (this.myCurse && this.myCurse.round !== s.round) this.myCurse = null;

    // wagons
    const raceMs = s.stage === 'race' ? this.raceMs(f, s) : -1;
    const startKey = `${s.round}`;
    if (s.stage === 'race' && raceMs >= 0 && this.raceStarted !== startKey && f.phase === 'mgPlay') {
      this.raceStarted = startKey;
      playSfx('go');
      if (s.cursed !== null) {
        const mine = s.picks[f.myId] === s.cursed;
        this.say(mine ? `Ton wagon (${s.cursed + 1}) est maudit !` : `Le wagon ${s.cursed + 1} était maudit !`, 3, 'caught');
        if (mine) playSfx('erreur');
      }
    }
    for (const w of this.wagons) {
      w.root.visible = true;
      const { d, y } = this.wagonPose(f, s, w.i);
      const end = raceSpan(s.tracks[w.i])[1];
      const moving = s.stage === 'race' && raceMs > 0 && d < end - 1e-3;
      this.placeWagon(w, this.pieces[w.i], d, y, t, moving);
      if (s.stage === 'intro' && y > 0 && y < 0.6 && !w.arrived) {
        w.arrived = true; // (sert de « déjà posé » pendant l'arrivée)
        this.particles.burst(w.root.position.x, 0.3, w.root.position.z, '#b9a07c', 10, 1.1, 0.7);
      }
      if (s.stage === 'preview' || s.stage === 'curse') w.arrived = false;
      // arrivée au butoir
      if (s.stage === 'race' && Object.values(s.picks).includes(w.i) && d >= end - 1e-3 && !w.arrived) {
        w.arrived = true;
        this.particles.burst(w.root.position.x, 0.8, w.root.position.z, '#ffd23f', 14, 1.3, 0.55);
        const rider = Object.keys(s.picks).find((id) => s.picks[id] === w.i);
        // sa place dans la manche jaillit au-dessus de lui, comme partout ailleurs
        if (rider) { const p = this.placeOf(s, rider); f.float(rider, placeLabel(p), placeColor(p)); }
        if (rider === f.myId) {
          const place = this.placeOf(s, f.myId);
          this.say(`Arrivé ${ROUND_NAMES[place - 1] ?? ''} !`, 2.4, place === 1 ? 'sk' : undefined);
          playSfx(place === 1 ? 'trouve' : 'prendre');
        } else playSfx('prendre', { volume: 0.5 });
      }
      // le maudit : fumée violette pendant la course (et le crâne, chez l'imposteur seul, avant)
      const cursedNow = s.cursed === w.i && (s.stage === 'race' || s.stage === 'score');
      w.aura.material.opacity = cursedNow ? 0.5 + 0.15 * Math.sin(t * 6) : 0;
      if (cursedNow && moving && t > w.smokeAt) {
        w.smokeAt = t + 0.09;
        this.particles.burst(w.root.position.x, 1.1, w.root.position.z, '#9a4dff', 1, 0.3, 0.75);
      }
      if (moving && t > w.smokeAt + 0.05 && Math.random() < 0.25) {
        this.particles.burst(w.root.position.x, 0.15, w.root.position.z, '#ffcf6a', 1, 0.9, 0.18);
      }
      w.skull.visible = f.imposter && this.myCurse?.round === s.round && this.myCurse.wagon === w.i && (s.stage === 'curse' || s.stage === 'pick');
      if (w.skull.visible) w.skull.position.y = 2.3 + Math.sin(t * 3) * 0.08;
    }

    this.placeActors(f, (id) => this.wagonOf(f, s, id));

    // la caméra : au quai (coupe nette, on ne repasse pas au-dessus des voies), survol, puis
    // travelling du quai vers toute la mine au départ de la course
    if (preview) {
      this.shoot(this.flyoverPose(this.camA, (ms - 250) / MINE.previewMoveMs));
      this.lantern.position.copy(this.camA.pos);
      this.lantern.target.position.copy(this.camA.target);
    } else if (s.stage === 'race') this.shoot(this.gatePose(this.camA), this.overviewPose(this.camB), ms / (MINE.raceLeadMs - 100));
    else if (s.stage === 'score') this.shoot(this.overviewPose(this.camA));
    else this.shoot(this.gatePose(this.camA));

    // décompte des dernières secondes pour choisir
    if (s.stage === 'pick' && !(f.myId in s.picks) && f.phase === 'mgPlay') {
      const left = Math.ceil((s.stageEndsAt - f.playMs) / 1000);
      if (left <= 3 && left >= 1 && left !== this.lastTick) { this.lastTick = left; playSfx('tick'); }
    }
    this.renderCards(f, s);
  }

  /** Place d'un joueur dans la course en cours (1 = premier). */
  private placeOf(s: MineState, id: string): number {
    const me = s.arrivals[id];
    if (me === undefined) return 0;
    return 1 + Object.values(s.arrivals).filter((t) => t < me - 1).length;
  }

  /** Les étiquettes au-dessus des wagons : numéro, qui est monté, malédiction, place à l'arrivée. */
  private renderCards(f: Frame, s: MineState | null): void {
    const tr = this.train;
    const show = f.phase === 'rules' ? !!tr && tr.phase !== 'end'
      : !!s && f.phase === 'mgPlay' && (s.stage === 'curse' || s.stage === 'pick' || s.stage === 'race');
    this.layer.hidden = !show;
    if (!show) return;
    const rect = this.viewRect(f);
    for (const w of this.wagons) {
      const el = this.cards[w.i];
      let cls = 'mf', who = '', tag = '';
      if (f.phase === 'rules' && tr) {
        if (tr.mine === w.i) { cls += ' mine'; who = this.face(f, f.myId); }
        else if (tr.phase === 'choose' && tr.mine < 0) cls += ' pickable';
      } else if (s) {
        const rider = f.state.players.find((p) => this.wagonOf(f, s, p.id) === w.i);
        if (rider) { who = this.face(f, rider.id); if (rider.id === f.myId) cls += ' mine'; }
        if (s.stage === 'curse' && f.imposter) cls += ' cursable';
        if (s.stage === 'pick' && !rider && !(f.myId in s.picks) && this.pending?.round !== s.round) cls += ' pickable';
        if (f.imposter && this.myCurse?.round === s.round && this.myCurse.wagon === w.i && s.cursed === null) { cls += ' doomed'; tag = '☠'; }
        if (s.cursed === w.i) { cls += ' doomed'; tag = 'Maudit'; }
        if (rider && (s.stage === 'race' || s.stage === 'score') && w.arrived) tag = ROUND_NAMES[this.placeOf(s, rider.id) - 1] ?? tag;
        if (s.stage === 'race' || s.stage === 'score') cls += ' small';
      }
      const html = `<b class="mf-n">${w.i + 1}</b>${who ? `<i>${who}</i>` : ''}${tag ? `<em>${escapeHtml(tag)}</em>` : ''}`;
      if (el.dataset.k !== html) { el.dataset.k = html; el.innerHTML = html; }
      if (el.className !== cls) el.className = cls;
      this.tmp.copy(w.root.position).setY(w.root.position.y + 1.65).project(camera);
      el.hidden = this.tmp.z > 1;
      el.style.left = `${rect.left + ((this.tmp.x + 1) / 2) * rect.width}px`;
      el.style.top = `${rect.top + ((1 - this.tmp.y) / 2) * rect.height}px`;
    }
  }

  private face(f: Frame, id: string): string {
    const p = f.state.players.find((q) => q.id === id);
    return p ? `<span class="mf-face" style="--c:${SLOT_COLORS[p.slot % 4]}">${portraitImg(p.cfg, p.name)}</span>` : '';
  }

  /* ================= HUD ================= */

  private name(f: Frame, id: string): string {
    if (id === f.myId) return 'toi';
    return f.state.players.find((p) => p.id === id)?.name ?? '?';
  }

  hud(f: Frame): HudInfo {
    const s = f.mg.mine;
    const flash = this.flash && this.flash.until > this.time && this.flash.cls !== 'train' ? this.flash : null;
    let status: HudInfo['status'] = null;
    const left = s ? Math.max(0, Math.ceil((s.stageEndsAt - f.playMs) / 1000)) : 0;
    const mine = s ? s.picks[f.myId] : undefined;
    if (flash) status = { text: flash.text, cls: flash.cls };
    else if (s && f.phase === 'mgPlay') {
      const raceMs = s.stage === 'race' ? this.raceMs(f, s) : 0;
      switch (s.stage) {
        case 'intro': status = { text: `Manche ${s.round + 1} sur ${MINE.rounds} : les wagons arrivent au quai…` }; break;
        case 'preview': status = { text: 'Mémorise les voies : on ne les verra qu’une fois !', cls: 'sk' }; break;
        case 'curse': status = f.imposter
          ? { text: this.myCurse?.round === s.round ? `Wagon ${this.myCurse.wagon + 1} maudit (tu peux changer d’avis)` : 'Maudis un wagon : clic ou touches 1 à 4', cls: 'caught' }
          : { text: 'L’imposteur maudit un wagon en secret… il roulera moins vite' };
          break;
        case 'pick': status = mine !== undefined || this.pending?.round === s.round
          ? { text: `Wagon ${(mine ?? this.pending!.wagon) + 1} : accroche-toi !` }
          : { text: `Choisis ton wagon : clic ou touches 1 à 4 · ${left} s`, cls: left <= 3 ? 'caught' : 'sk' };
          break;
        case 'race': status = raceMs < 0 ? { text: 'En voiture…' } : { text: 'Fonce, petit wagon !' }; break;
        case 'score': {
          const order = Object.entries(s.history[s.history.length - 1] ?? {}).sort((a, b) => a[1] - b[1]);
          status = { text: order.map(([id, p]) => `${ROUND_NAMES[p - 1]} ${this.name(f, id)}`).join(' · ') };
          break;
        }
        default: break;
      }
    }
    const label = !s ? 'Wagons' : s.stage === 'intro' ? 'Arrivée' : s.stage === 'preview' ? 'Mémorise !' : s.stage === 'curse' ? 'Malédiction'
      : s.stage === 'pick' ? 'Choix du wagon' : s.stage === 'race' ? 'Course' : 'Classement';
    const timed = s && (s.stage === 'curse' || s.stage === 'pick');
    let extra: string | undefined;
    if (s && f.phase === 'mgPlay') {
      const rows = [...f.state.players].sort((a, b) => (s.points[b.id] ?? 0) - (s.points[a.id] ?? 0))
        .map((p) => `<li${p.id === f.myId ? ' class="me"' : ''}><i style="--c:${SLOT_COLORS[p.slot % 4]}">${portraitImg(p.cfg, p.name)}</i><span>${escapeHtml(p.name)}</span><b>${s.points[p.id] ?? 0}</b></li>`).join('');
      extra = `<div class="mk-basket mn-board"><small>Points de manche</small><ol>${rows}</ol></div>`;
    }
    return {
      boxes: [
        { label: 'Manche', value: `${s ? s.round + 1 : 1} / ${MINE.rounds}` },
        { label, value: timed ? `${left} s` : s?.stage === 'race' ? '🚂' : '…', cls: timed && left <= 3 ? 'caught' : '' },
      ],
      chip: (id) => {
        if (!s) return { text: '' };
        const w = this.wagonOf(f, s, id);
        const pts = `${s.points[id] ?? 0} pt${(s.points[id] ?? 0) > 1 ? 's' : ''}`;
        if (s.stage === 'pick' && w < 0) return { text: `Choisit… · ${pts}` };
        if (w >= 0 && (s.stage === 'race' || s.stage === 'score')) {
          const arrived = this.wagons[w]?.arrived;
          const place = this.placeOf(s, id);
          return { text: arrived ? `${ROUND_NAMES[place - 1]} · ${pts}` : `Wagon ${w + 1} · ${pts}`, cls: arrived && place === 1 ? 'sk' : '' };
        }
        if (w >= 0) return { text: `Wagon ${w + 1} · ${pts}` };
        return { text: pts };
      },
      status,
      extra,
    };
  }

  exit(): void {
    this.active = false;
    this.train = null;
    this.clearTracks();
    this.groundY = 0; this.mySitting = false;
    window.removeEventListener('keydown', this.onKey);
    renderer.domElement.removeEventListener('pointerdown', this.onPointer);
    this.layer.remove();
  }
}
