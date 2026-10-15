import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SHEEP, SHEEP_STARTS, type MinigameTick } from '@oddone/shared';
import { OUTLINE, angleDamp, camera, canvasTexture, gradientMap } from '../engine/render.ts';
import { setCustomCamera } from '../game/cameraRig.ts';
import { loadKit, type Kit } from '../world/kits.ts';
import type { World } from '../world/tavern.ts';
import { placeLabel } from '../world/floatText.ts';
import { Particles, PodiumView } from './effects.ts';
import type { Frame, GameView, HudInfo } from './view.ts';

/**
 * L'arène de « La Course des Moutons » : un chemin de terre tout droit entre deux murets de pierre,
 * des prés fleuris, des arbres, une rivière et un village au loin. Le troupeau (modélisé en code :
 * laine en boules, tête crème, cornes enroulées, pattes qui trottent) erre sur le chemin ; les
 * positions viennent du serveur. Les moutons sont des obstacles pour le joueur local.
 * La caméra est devant les coureurs, tournée vers eux, et recule avec eux le long du chemin ; les
 * commandes sont les commandes classiques à l'écran (bas : vers la caméra, donc vers l'arrivée).
 */

const HX = SHEEP.halfX, LEN0 = SHEEP.startZ - 8, LEN1 = SHEEP.endZ + 2;

const dirt = canvasTexture(128, 128, (g, w, h) => {
  g.fillStyle = '#a8794a'; g.fillRect(0, 0, w, h);
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let k = 0; k < 420; k++) {
    g.fillStyle = ['#b98a58', '#9a6c40', '#c09460', '#8e6339'][k % 4];
    g.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 5, 2 + rnd() * 3);
  }
});
dirt.wrapS = dirt.wrapT = THREE.RepeatWrapping;

const stones = canvasTexture(128, 128, (g, w, h) => {
  g.fillStyle = '#8f7b5c'; g.fillRect(0, 0, w, h);
  const tones = ['#d8c49c', '#cdb88e', '#e0cda6', '#c4ae84'];
  for (let y = 0, row = 0; y < h; y += 26, row++) {
    for (let x = row % 2 ? -22 : 0, k = 0; x < w; x += 44, k++) {
      g.fillStyle = tones[(row * 3 + k) % 4];
      g.beginPath(); g.ellipse(x + 22, y + 13, 19, 10.5, 0, 0, 7); g.fill();
    }
  }
});
stones.wrapS = stones.wrapT = THREE.RepeatWrapping;

/* ================= Le mouton ================= */

const WOOL = new THREE.MeshToonMaterial({ color: '#fbf8f1', gradientMap });
const FACE = new THREE.MeshToonMaterial({ color: '#f1dcc0', gradientMap });
const HORN = new THREE.MeshToonMaterial({ color: '#c4935e', gradientMap });
const LEG = new THREE.MeshToonMaterial({ color: '#6b4a34', gradientMap });
const EYE = new THREE.MeshBasicMaterial({ color: '#1d120c' });

/** La laine : des boules fondues en une seule géométrie (un seul dessin par mouton). */
const woolGeo = (() => {
  const parts: THREE.BufferGeometry[] = [];
  const ball = (x: number, y: number, z: number, r: number) => { const g = new THREE.SphereGeometry(r, 12, 9); g.translate(x, y, z); parts.push(g); };
  ball(0, 0.95, 0, 0.55); ball(0, 0.98, 0.38, 0.48); ball(0, 0.96, -0.4, 0.5);
  ball(0.3, 0.92, 0.1, 0.42); ball(-0.3, 0.92, 0.1, 0.42); ball(0.28, 0.9, -0.3, 0.4); ball(-0.28, 0.9, -0.3, 0.4);
  ball(0, 1.32, 0.05, 0.38); ball(0, 0.92, -0.86, 0.17); // le dessus, la queue
  return mergeGeometries(parts)!;
})();
const headGeo = (() => {
  const g = new THREE.SphereGeometry(0.3, 14, 10); g.scale(0.9, 1, 1.05);
  const snout = new THREE.SphereGeometry(0.2, 10, 8); snout.translate(0, -0.08, 0.2);
  const ears = [-1, 1].map((s) => { const e = new THREE.SphereGeometry(0.1, 8, 6); e.scale(1.6, 0.6, 1); e.translate(s * 0.3, 0.05, -0.05); return e; });
  return mergeGeometries([g, snout, ...ears])!;
})();
const hornGeo = (() => {
  const parts = [-1, 1].map((s) => { const t = new THREE.TorusGeometry(0.13, 0.055, 8, 16, Math.PI * 1.6); t.rotateY(Math.PI / 2); t.translate(s * 0.27, 0.1, -0.02); return t; });
  return mergeGeometries(parts)!;
})();
const legGeo = new THREE.CylinderGeometry(0.075, 0.065, 0.62, 7).translate(0, -0.31, 0);

interface SheepView { root: THREE.Group; legs: THREE.Mesh[]; head: THREE.Group; target: THREE.Vector3; yaw: number; moving: number; phase: number }

function makeSheep(): SheepView {
  const root = new THREE.Group();
  const wool = new THREE.Mesh(woolGeo, WOOL); wool.castShadow = true;
  const edge = new THREE.Mesh(woolGeo, OUTLINE); edge.scale.setScalar(1.03); wool.add(edge);
  const head = new THREE.Group(); head.position.set(0, 1.12, 1.02); head.scale.setScalar(1.25);
  const face = new THREE.Mesh(headGeo, FACE); face.castShadow = true;
  const horns = new THREE.Mesh(hornGeo, HORN);
  for (const s of [-1, 1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 4), EYE); e.position.set(s * 0.13, 0.08, 0.24); head.add(e); }
  head.add(face, horns);
  const legs = [[-0.26, 0.38], [0.26, 0.38], [-0.26, -0.38], [0.26, -0.38]].map(([x, z]) => {
    const l = new THREE.Mesh(legGeo, LEG); l.position.set(x, 0.62, z); l.castShadow = true; root.add(l); return l;
  });
  root.add(wool, head);
  return { root, legs, head, target: new THREE.Vector3(), yaw: 0, moving: 0, phase: Math.random() * 6 };
}

/* ================= L'arène ================= */

export class SheepArena implements GameView {
  readonly scene = new THREE.Scene();
  readonly world: World;
  readonly particles: Particles;
  readonly podium: PodiumView;
  readonly cameras = { training: 'custom', play: 'custom' } as const;
  readonly solidPlayers = true;
  private sun = new THREE.DirectionalLight('#fff3dc', 2.1);
  private flock = new Map<number, SheepView>();
  private camPos = new THREE.Vector3();
  private camTarget = new THREE.Vector3();
  private finishSeen = new Set<string>();
  // entraînement : quelques moutons locaux autour du départ
  private train: { s: SheepView; x: number; z: number; yaw: number; speed: number; changeAt: number }[] = [];

  private constructor(private kits: { medieval: Kit; halloween: Kit }) {
    this.world = { colliders: [], circles: [], bounds: { halfX: HX, halfZ: SHEEP.endZ } };
    this.build();
    this.particles = new Particles(this.scene);
    this.podium = new PodiumView(this.scene, [...SHEEP.podium], this.world, this.particles);
  }

  static async create(): Promise<SheepArena> {
    const [medieval, halloween] = await Promise.all([loadKit('medieval'), loadKit('halloween')]);
    return new SheepArena({ medieval, halloween });
  }

  /** Face à l'arrivée (vers +z, vers la caméra). */
  startYaw(): number { return 0; }

  /* ================= Décor ================= */

  private build(): void {
    const s = this.scene, { medieval } = this.kits;
    s.background = canvasTexture(4, 256, (g, w, h) => {
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#6fb6e8'); grad.addColorStop(0.7, '#cbe6f2'); grad.addColorStop(1, '#eef2d8');
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
    });
    s.fog = new THREE.Fog('#d9ecef', 60, 170);
    s.add(new THREE.HemisphereLight('#fff6e0', '#6a8a3c', 2));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -16, right: 16, top: 18, bottom: -18, near: 1, far: 70 });
    this.sun.shadow.bias = -0.0008;
    s.add(this.sun, this.sun.target);

    // les prés, le chemin de terre, les murets de pierre
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshToonMaterial({ color: '#7cc04e', gradientMap }));
    grass.rotation.x = -Math.PI / 2; grass.receiveShadow = true;
    s.add(grass);
    const path = new THREE.Mesh(new THREE.PlaneGeometry(HX * 2, LEN1 - LEN0), new THREE.MeshToonMaterial({ map: dirt, gradientMap }));
    (path.material as THREE.MeshToonMaterial).map!.repeat.set(3, (LEN1 - LEN0) / 3.5);
    path.rotation.x = -Math.PI / 2; path.position.set(0, 0.02, (LEN0 + LEN1) / 2); path.receiveShadow = true;
    s.add(path);
    const wallMat = new THREE.MeshToonMaterial({ map: stones, gradientMap });
    (wallMat.map as THREE.Texture).repeat.set((LEN1 - LEN0) / 2.2, 1);
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 1.25, LEN1 - LEN0), wallMat);
      wall.position.set(side * (HX + 0.5), 0.62, (LEN0 + LEN1) / 2); wall.castShadow = wall.receiveShadow = true;
      const edge = new THREE.Mesh(wall.geometry, OUTLINE); edge.scale.setScalar(1.005); wall.add(edge);
      // le dessus arrondi du muret, tout du long (couché le long de z, aplati)
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, LEN1 - LEN0, 12), wallMat);
      cap.rotation.x = Math.PI / 2; cap.scale.set(1, 1, 0.4); cap.position.set(side * (HX + 0.5), 1.25, (LEN0 + LEN1) / 2);
      cap.castShadow = true;
      s.add(wall, cap);
    }
    // le chemin continue au loin en serpentant (vers le départ et au-delà)
    const far = new THREE.Mesh(new THREE.PlaneGeometry(5, 60), new THREE.MeshToonMaterial({ map: dirt, gradientMap }));
    far.rotation.x = -Math.PI / 2; far.rotation.z = 0.25; far.position.set(-5, 0.015, LEN0 - 28);
    s.add(far);

    // fleurs jaunes en touffes dans les prés
    const yellow = new THREE.MeshToonMaterial({ color: '#ffd23f', gradientMap }), stem = new THREE.MeshToonMaterial({ color: '#4f8f2a', gradientMap });
    const flowerGeo = new THREE.SphereGeometry(0.16, 6, 4);
    const flowers = new THREE.InstancedMesh(flowerGeo, yellow, 900), stems = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 4), stem, 900);
    const m = new THREE.Matrix4();
    let seed = 5;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 900; i++) {
      // en touffes : un centre, des fleurs autour
      const patch = Math.floor(i / 30), side = patch % 2 ? 1 : -1;
      const cx = side * (HX + 4 + (patch * 7.3) % 22), cz = LEN0 + ((patch * 13.7) % (LEN1 - LEN0 + 30)) - 10;
      const x = cx + (rnd() - 0.5) * 6, z = cz + (rnd() - 0.5) * 5;
      m.makeTranslation(x, 0.32, z); flowers.setMatrixAt(i, m);
      m.makeTranslation(x, 0.15, z); stems.setMatrixAt(i, m);
    }
    s.add(flowers, stems);

    // arbres ronds le long du chemin, sapins plus loin
    const trees: [string, number][] = [['tree_single_A', 7], ['tree_single_B', 7], ['trees_A_large', 5]];
    for (let z = LEN0 - 30, i = 0; z < LEN1 + 20; z += 11, i++) for (const side of [-1, 1]) {
      const [name, sc] = trees[(i + (side > 0 ? 1 : 0)) % trees.length];
      medieval.spawn(name, { x: side * (HX + 7 + (i % 3) * 4), z: z + side * 3, ry: i, scale: sc, parent: s, shadows: Math.abs(z) < 30 });
    }
    // au loin, au-delà du départ : une rivière, et le village sur l'autre rive
    const river = new THREE.Mesh(new THREE.PlaneGeometry(400, 14), new THREE.MeshBasicMaterial({ color: '#7ec4f0' }));
    river.rotation.x = -Math.PI / 2; river.position.set(0, 0.03, LEN0 - 70);
    s.add(river);
    const town = ['building_church', 'building_home_B', 'building_tavern', 'building_home_A', 'building_tower_A', 'building_home_B', 'building_market', 'building_home_A', 'building_windmill'];
    town.forEach((b, i) => {
      const name = `${b}_${['red', 'blue', 'yellow'][i % 3]}`;
      if (medieval.has(name)) medieval.spawn(name, { x: -26 + i * 6.5, z: LEN0 - 88 - (i % 2) * 5, ry: Math.PI, scale: 7, parent: s, shadows: false });
    });
    medieval.spawn('building_castle_blue', { x: 12, z: LEN0 - 108, ry: Math.PI, scale: 8, parent: s, shadows: false });

    // la ligne d'arrivée : deux poteaux et une banderole
    const wood = new THREE.MeshToonMaterial({ color: '#5a3a22', gradientMap });
    for (const side of [-1, 1]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 4.4), wood); p.position.set(side * (HX + 0.2), 2.2, SHEEP.finishZ); p.castShadow = true; s.add(p); }
    const ban = new THREE.Mesh(new THREE.PlaneGeometry(HX * 2, 1), new THREE.MeshToonMaterial({ map: canvasTexture(512, 64, (g, w, h) => {
      for (let i = 0; i < 16; i++) { g.fillStyle = i % 2 ? '#fbf1dc' : '#1d120c'; g.fillRect((i * w) / 16, 0, w / 16, h / 2); g.fillStyle = i % 2 ? '#1d120c' : '#fbf1dc'; g.fillRect((i * w) / 16, h / 2, w / 16, h / 2); }
    }), gradientMap, side: THREE.DoubleSide }));
    ban.position.set(0, 3.9, SHEEP.finishZ);
    s.add(ban);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(HX * 2, 0.5), new THREE.MeshBasicMaterial({ color: '#fbf1dc' }));
    line.rotation.x = -Math.PI / 2; line.position.set(0, 0.04, SHEEP.finishZ);
    s.add(line);
  }

  /* ================= Moutons ================= */

  private sheepView(id: number): SheepView {
    let v = this.flock.get(id);
    if (!v) { v = makeSheep(); this.flock.set(id, v); this.scene.add(v.root); }
    return v;
  }

  /** Avance chaque mouton vers sa position reçue, pattes et tête qui bougent quand il marche. */
  private animateSheep(v: SheepView, t: number, dt: number): void {
    v.root.position.lerp(v.target, 1 - Math.exp(-10 * dt));
    v.root.rotation.y = angleDamp(v.root.rotation.y, v.yaw, 8, dt);
    v.phase += dt * (v.moving ? 9 : 0);
    v.legs.forEach((l, i) => { l.rotation.x = v.moving ? Math.sin(v.phase + (i % 2 === (i < 2 ? 0 : 1) ? 0 : Math.PI)) * 0.55 : 0; });
    // au repos, il broute (la tête descend de temps en temps)
    const graze = v.moving ? 0 : Math.max(0, Math.sin(t * 0.8 + v.phase * 3)) * 0.5;
    v.head.rotation.x = graze; v.head.position.y = 1.12 - graze * 0.35;
    v.root.position.y = v.moving ? Math.abs(Math.sin(v.phase)) * 0.06 : 0;
  }

  /* ================= Entraînement ================= */

  startTraining(): void {
    this.stopTraining();
    for (let i = 0; i < 14; i++) {
      const s = makeSheep();
      const x = (Math.random() * 2 - 1) * (HX - 1), z = SHEEP.startZ + 4 + i * 1;
      s.root.position.set(x, 0, z); s.target.set(x, 0, z);
      this.scene.add(s.root);
      this.train.push({ s, x, z, yaw: Math.random() * 6.28, speed: 0, changeAt: 0 });
    }
  }

  stopTraining(): void {
    for (const t of this.train) t.s.root.removeFromParent();
    this.train = [];
  }

  private updateTraining(dt: number, now: number): void {
    for (const t of this.train) {
      if (now >= t.changeAt) {
        t.changeAt = now + 1 + Math.random() * 2;
        t.speed = Math.random() < SHEEP.grazeChance ? 0 : 0.6 + Math.random() * (SHEEP.walkMax - 0.6);
        t.yaw = Math.random() * Math.PI * 2;
      }
      t.x = Math.max(-HX + SHEEP.radius, Math.min(HX - SHEEP.radius, t.x + Math.sin(t.yaw) * t.speed * dt));
      t.z = Math.max(SHEEP.startZ + 3, Math.min(SHEEP.startZ + 18, t.z + Math.cos(t.yaw) * t.speed * dt));
      t.s.target.set(t.x, 0, t.z); t.s.yaw = t.yaw; t.s.moving = t.speed > 0.1 ? 1 : 0;
    }
  }

  /* ================= Partie ================= */

  onPhase(f: Frame): void {
    if (f.phase === 'mgPlay') this.stopTraining();
    if (f.phase === 'mgResults') { this.world.circles = []; f.me.clearPose(); }
  }

  /** Les moutons sont des obstacles (on ne les pousse pas : c'est le joueur qui est repoussé). */
  beforeMove(f: Frame): void {
    const list = f.phase === 'rules' ? this.train.map((t) => t.s) : [...this.flock.values()];
    this.world.circles = list.map((v) => ({ x: v.root.position.x, z: v.root.position.z, r: SHEEP.radius }));
    if (f.phase === 'mgPlay' && f.mg.sheep?.finished.includes(f.myId)) f.me.frozen = true;
  }

  afterMove(f: Frame): string | null {
    const P = f.me.root.position;
    // à l'entraînement, on revient au départ une fois le troupeau traversé
    if (f.phase === 'rules' && P.z > SHEEP.startZ + 22) { const [x, z] = SHEEP_STARTS[0]; f.me.placeAt(x, z, 0); return 'Bien joué ! Encore une fois…'; }
    return null;
  }

  applyTick(tick: MinigameTick, f: Frame): void {
    for (const [id, x, z, yaw, anim] of tick.bots) f.remotes.get(id)?.setTransform({ p: [x, 0, z], r: yaw, a: anim });
    for (const [id, x, z, yaw, moving] of tick.sh ?? []) {
      const v = this.sheepView(id);
      if (!v.root.parent || v.target.lengthSq() === 0) v.root.position.set(x, 0, z);
      v.target.set(x, 0, z); v.yaw = yaw; v.moving = moving;
    }
  }

  update(t: number, dt: number, f: Frame): void {
    this.particles.update(dt);
    this.podium.update(dt);
    if (f.phase === 'rules') this.updateTraining(dt, t);
    for (const v of this.flock.values()) this.animateSheep(v, t, dt);
    for (const tr of this.train) this.animateSheep(tr.s, t, dt);
    const P = f.me.root.position;
    this.sun.position.set(P.x - 10, 26, P.z + 14);
    this.sun.target.position.set(P.x, 0, P.z);
    // arrivées : confettis de poussière et place au-dessus de la tête
    for (const id of f.mg.sheep?.finished ?? []) {
      if (this.finishSeen.has(id)) continue;
      this.finishSeen.add(id);
      const a = id === f.myId ? f.me.root : f.remotes.get(id)?.root;
      if (a) this.particles.burst(a.position.x, 1, a.position.z, '#ffd23f', 14, 1.2, 0.8);
      if (id === f.myId) f.me.playPose('Cheer', { once: false });
    }
    if (f.phase !== 'mgResults') this.aimCamera(f);
  }

  /** Devant les coureurs, un peu en hauteur, tournée vers eux ; elle recule avec le joueur. */
  private aimCamera(f: Frame): void {
    const P = f.me.root.position, z = Math.min(P.z, SHEEP.endZ - 6);
    this.camPos.set(P.x * 0.35, 8.2, z + 11.5);
    this.camTarget.set(P.x * 0.35, 0.6, z - 3.5);
    setCustomCamera(this.camPos, this.camTarget, camera.aspect < 1 ? 72 : 52, 5);
  }

  /* ================= HUD ================= */

  /** Place actuelle : les arrivés d'abord, puis selon l'avance sur le chemin. */
  private placeOf(f: Frame, id: string): number {
    const done = f.mg.sheep?.finished ?? [];
    if (done.includes(id)) return done.indexOf(id) + 1;
    const z = (pid: string) => (pid === f.myId ? f.me.root.position.z : f.remotes.get(pid)?.root.position.z ?? -999);
    const mine = z(id);
    return done.length + 1 + f.state.players.filter((p) => p.id !== id && !done.includes(p.id) && z(p.id) > mine).length;
  }

  hud(f: Frame): HudInfo {
    const done = !!f.mg.sheep?.finished.includes(f.myId);
    const left = Math.max(0, SHEEP.finishZ - f.me.root.position.z), place = this.placeOf(f, f.myId);
    let status: HudInfo['status'] = null;
    if (f.phase === 'rules') status = { text: 'S / ↓ : courir vers la caméra · les moutons ne se poussent pas, contourne-les !' };
    else if (done) status = { text: `Arrivé ${place === 1 ? 'premier' : `${place}e`} !` };
    else if (f.phase === 'mgPlay' && f.playMs < 4000) status = { text: 'S / ↓ : courir · contourne les moutons !' };
    return {
      boxes: [
        { label: 'Place', value: placeLabel(place), cls: place === 1 ? 'sk' : '' },
        { label: 'Arrivée', value: done ? 'Arrivé !' : `${Math.ceil(left)} m` },
      ],
      chip: (id) => {
        const p = this.placeOf(f, id);
        return { text: f.mg.sheep?.finished.includes(id) ? `Arrivé (${placeLabel(p)})` : placeLabel(p), cls: f.mg.sheep?.finished.includes(id) ? 'done' : '' };
      },
      status,
    };
  }

  exit(): void {
    this.stopTraining();
    for (const v of this.flock.values()) v.root.removeFromParent();
    this.flock.clear();
  }
}

