import * as THREE from 'three';
import { DEFAULT_CONFIG, SEAT_COUNT, type CharacterConfig } from '@oddone/shared';
import { canvasTexture, gradientMap, part, scene, shade } from '../engine/render.ts';
import { loader, LIB, kitMaterials } from '../characters/library.ts';
import { measureSitPose, playAnimation, setActorModel, updateActor, type Actor } from '../characters/character.ts';

/**
 * La taverne : décor KayKit Dungeon Remastered + Furniture Bits (CC0), comptoir et cheminée
 * modélisés en code, PNJ, lumières, et données de collision.
 * Unités : celles des modèles KayKit (un mur = 4 × 4, un perso ≈ 2,5 de haut).
 */

export const ROOM = { halfX: 10, halfZ: 8 };
export interface Box { x0: number; x1: number; z0: number; z1: number }
export interface Circle { x: number; z: number; r: number }
export type WallSide = 'front' | 'back' | 'left' | 'right';

export interface Npc extends Actor {
  id: 'barman' | 'tailor';
  name: string;
  home: THREE.Vector3;
  yaw: number;
  talkTime: number;
  busyTime: number;
}

export interface Tavern {
  colliders: Box[];
  circles: Circle[];
  stools: { x: number; z: number }[];
  /** Décalage hanches/racine en pose assise (pour poser le perso sur le tabouret). */
  sitOffset: THREE.Vector3;
  wallsBySide: Record<WallSide, THREE.Object3D[]>;
  npcs: Record<Npc['id'], Npc>;
  mugs: THREE.Mesh[];
  update(t: number, dt: number): void;
}

const BAR_Z = -4.6, BAR_HALF = 5.4;
const BARMAN_CFG: CharacterConfig = { ...DEFAULT_CONFIG, body: 'barbarian', head: 'barbarian', cape: 'none', hue: 22, right: 'barbarian:Mug', size: '1.14' };
const TAILOR_CFG: CharacterConfig = { ...DEFAULT_CONFIG, body: 'mage', head: 'mage', hat: 'mage', cape: 'none', hue: 325, face: 'glasses', left: 'mage:Spellbook_open' };

export async function buildTavern(): Promise<Tavern> {
  const gltf = await loader.loadAsync('/assets/props/tavern-props.glb');
  const protos: Record<string, THREE.Object3D> = {};
  for (const c of gltf.scene.children) protos[c.name] = c;
  const mats = new Map<string, THREE.MeshToonMaterial>();
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const src = m.material as THREE.MeshStandardMaterial;
    if (!mats.has(src.uuid)) mats.set(src.uuid, new THREE.MeshToonMaterial({ map: src.map, color: src.color, gradientMap }));
    m.material = mats.get(src.uuid)!;
    m.castShadow = m.receiveShadow = true;
  });

  const { halfX: RX, halfZ: RZ } = ROOM;
  const colliders: Box[] = [];
  const circles: Circle[] = [];
  const wallsBySide: Record<WallSide, THREE.Object3D[]> = { front: [], back: [], left: [], right: [] };
  const box = (x0: number, x1: number, z0: number, z1: number) => colliders.push({ x0, x1, z0, z1 });
  const sideOf = (x: number, z: number): WallSide | null =>
    Math.abs(z) >= RZ - 0.05 && Math.abs(z) <= RZ + 1.7 ? (z > 0 ? 'front' : 'back')
      : Math.abs(x) >= RX - 0.05 && Math.abs(x) <= RX + 1.7 ? (x > 0 ? 'right' : 'left') : null;

  const prop = (name: string, x: number, z: number, ry = 0, y = 0, s = 1) => {
    const p = protos[name];
    if (!p) { console.warn('Décor manquant :', name); return null; }
    const c = p.clone();
    c.position.set(x, y, z); c.rotation.y = ry; c.scale.setScalar(s);
    scene.add(c);
    const side = sideOf(x, z);
    if (side) wallsBySide[side].push(c);
    return c;
  };

  /* ---------- lumière : chaude, un peu de lune aux fenêtres ---------- */
  scene.background = new THREE.Color('#1a0f0a');
  scene.fog = new THREE.Fog('#1a0f0a', 26, 48);
  scene.add(new THREE.HemisphereLight('#ffd9a8', '#3a2418', 1.7));
  const sun = new THREE.DirectionalLight('#ffe2b8', 1.4);
  sun.position.set(-6, 16, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -13, right: 13, top: 12, bottom: -12, near: 1, far: 40 });
  sun.shadow.bias = -0.0008;
  scene.add(sun);
  const flickers: { light: THREE.PointLight; base: number; f: number }[] = [];
  const pointLight = (c: string, intensity: number, dist: number, x: number, y: number, z: number, f = 0) => {
    const l = new THREE.PointLight(c, intensity, dist, 1.4);
    l.position.set(x, y, z);
    scene.add(l);
    if (f) flickers.push({ light: l, base: intensity, f });
    return l;
  };

  /* ---------- sol et murs ---------- */
  for (let x = -8; x <= 8; x += 4) for (let z = -6; z <= 6; z += 4) prop((x + z) % 8 === 0 ? 'floor_wood_large' : 'floor_wood_large_dark', x, z);
  for (let x = -8; x <= 8; x += 4) {
    prop('wall', x, -RZ - 0.5);
    prop(x === 0 ? 'wall_doorway' : Math.abs(x) === 4 ? 'wall_window_open' : 'wall', x, RZ + 0.5, Math.PI);
  }
  for (let z = -6; z <= 6; z += 4) {
    prop(z === 2 || z === -6 ? 'wall_window_open' : 'wall', -RX - 0.5, z, Math.PI / 2);
    prop(z === -2 || z === 6 ? 'wall_window_open' : 'wall', RX + 0.5, z, -Math.PI / 2);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) prop('pillar', sx * (RX + 0.5), sz * (RZ + 0.5));
  const night = new THREE.MeshBasicMaterial({ color: '#22345e' });
  const pane = (x: number, z: number, ry: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), night);
    m.position.set(x, 2, z); m.rotation.y = ry; scene.add(m);
    wallsBySide[sideOf(x, z)!].push(m);
  };
  pane(-4, RZ + 1.6, Math.PI); pane(4, RZ + 1.6, Math.PI); pane(0, RZ + 1.6, Math.PI);
  pane(-RX - 1.6, 2, Math.PI / 2); pane(-RX - 1.6, -6, Math.PI / 2); pane(RX + 1.6, -2, -Math.PI / 2); pane(RX + 1.6, 6, -Math.PI / 2);

  /* ---------- le comptoir, hauteur réglée sur l'animation assise ---------- */
  const sitHips = measureSitPose(DEFAULT_CONFIG);
  const seatH = Math.max(0.3, sitHips.y - 0.08);
  const counterH = seatH + 0.72;
  const stools = Array.from({ length: SEAT_COUNT }, (_, i) => ({ x: -3 + i * 2, z: -3.25 }));
  const planks = canvasTexture(256, 128, (g, w, h) => {
    g.fillStyle = '#6b4226'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#74482a' : '#653d22'; g.fillRect(i * 32, 0, 32, h); g.fillStyle = '#3e2414'; g.fillRect(i * 32, 0, 3, h); }
    g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(0, h - 12, w, 12);
  });
  planks.wrapS = THREE.RepeatWrapping; planks.repeat.set(5, 1);
  part(scene, new THREE.BoxGeometry(BAR_HALF * 2, counterH - 0.14, 0.9), '', { material: new THREE.MeshToonMaterial({ map: planks, gradientMap }) }).position.set(0, (counterH - 0.14) / 2, BAR_Z);
  part(scene, new THREE.BoxGeometry(BAR_HALF * 2 + 0.4, 0.16, 1.3), '#9a6539', { outline: true }).position.set(0, counterH - 0.08, BAR_Z);
  const rail = part(scene, new THREE.CylinderGeometry(0.05, 0.05, BAR_HALF * 2, 10), '#d4a640');
  rail.rotation.z = Math.PI / 2; rail.position.set(0, 0.42, BAR_Z + 0.62);
  for (const s of stools) {
    const g = new THREE.Group(); g.position.set(s.x, 0, s.z); scene.add(g);
    part(g, new THREE.CylinderGeometry(0.42, 0.38, 0.14, 20), '#9a6539', { outline: true }).position.y = seatH - 0.07;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      const l = part(g, new THREE.CylinderGeometry(0.045, 0.055, seatH - 0.1, 8), '#5a3a22');
      l.position.set(Math.sin(a) * 0.22, (seatH - 0.1) / 2, Math.cos(a) * 0.22);
    }
    circles.push({ x: s.x, z: s.z, r: 0.4 });
  }
  box(-BAR_HALF - 0.2, BAR_HALF + 0.2, BAR_Z - 0.65, BAR_Z + 0.6);
  for (const [n, x] of [['bottle_A_brown', -4.6], ['bottle_B_green', -4.2], ['candle_lit', -2], ['bottle_A_labeled_brown', 4.3], ['candle_triple', 2], ['plate_stack', 4.9]] as const)
    prop(n, x, BAR_Z - 0.2, x, counterH, 0.55);
  const mugSrc = LIB.barbarian.rigid['item:Mug'];
  const mugs = stools.map((s) => {
    const m = new THREE.Mesh(mugSrc.geometry, kitMaterials('barbarian', null, null).rigid);
    m.position.set(s.x + 0.6, counterH + 0.02, BAR_Z + 0.1); m.rotation.y = -0.6; m.visible = false; m.castShadow = true;
    scene.add(m);
    return m;
  });

  /* ---------- derrière le bar ---------- */
  prop('shelves', -4, -RZ - 0.5); prop('shelves', 4, -RZ - 0.5); prop('shelf_small_candles', 0, -RZ - 0.5);
  for (const [n, x] of [['bottle_A_green', -4.6], ['bottle_C_brown', -4.1], ['bottle_A_brown', -3.5], ['bottle_B_green', 3.4], ['bottle_A_labeled_brown', 4], ['bottle_C_brown', 4.6]] as const)
    prop(n, x, -RZ + 0.45, 0, 1.53, 0.5);
  prop('keg_decorated', -7.6, -6.6, 0.3, 0, 0.8); prop('keg', 7.6, -6.6, -0.3, 0, 0.8); prop('barrel_small_stack', -8.6, -4.6, 0, 0, 0.8);
  box(-RX, -6.6, -RZ, -5.3); box(6.6, RX, -RZ, -5.6);
  prop('banner_patternA_red', -8, -RZ - 0.5); prop('banner_patternA_red', 8, -RZ - 0.5);
  prop('torch_mounted', -2, -RZ); prop('torch_mounted', 2, -RZ);
  pointLight('#ffb35c', 5, 12, -2, 3.2, -7.2, 1); pointLight('#ffb35c', 5, 12, 2, 3.2, -7.2, 1.3);
  pointLight('#ffd08a', 3, 10, 0, 3.6, -3.5);

  /* ---------- la cheminée ---------- */
  const fire = new THREE.Group(); fire.position.set(-RX + 0.1, 0, 0.5); fire.rotation.y = Math.PI / 2; scene.add(fire);
  const stone = '#8d8378';
  part(fire, new THREE.BoxGeometry(3.6, 0.3, 1.8), shade(stone, 0.85), { outline: true }).position.set(0, 0.15, 0.4);
  for (const sx of [-1, 1]) part(fire, new THREE.BoxGeometry(0.7, 2.7, 1.3), stone, { outline: true }).position.set(sx * 1.35, 1.35, 0.15);
  part(fire, new THREE.BoxGeometry(3.9, 0.4, 1.6), '#6b4226', { outline: true }).position.set(0, 2.85, 0.25);
  part(fire, new THREE.BoxGeometry(2.6, 1.5, 1.0), stone, { outline: true }).position.set(0, 3.8, 0);
  part(fire, new THREE.BoxGeometry(2.1, 2.4, 0.3), '#24160f').position.set(0, 1.4, -0.35);
  for (const r of [0.5, -0.5]) { const l = part(fire, new THREE.CylinderGeometry(0.13, 0.13, 1.5, 10), '#5a3a22'); l.rotation.set(0, r, Math.PI / 2); l.position.set(0, 0.42, 0.2); }
  const flames: { mesh: THREE.Mesh; h: number; i: number }[] = [];
  ([['#ff6a1a', 0.45, 1.3, 0], ['#ffb02e', 0.32, 1.0, 0.25], ['#ffe27a', 0.2, 0.7, -0.2], ['#ff8a2a', 0.3, 0.9, -0.4], ['#ffb02e', 0.26, 0.8, 0.45]] as const).forEach(([c, r, h, x], i) => {
    const f = new THREE.Mesh(new THREE.ConeGeometry(r, h, 8), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending, depthWrite: false }));
    f.position.set(x, 0.45 + h / 2, 0.2); fire.add(f); flames.push({ mesh: f, h, i });
  });
  pointLight('#ff8a3c', 9, 16, -RX + 1.6, 1.4, 0.5, 2.2);
  box(-RX, -RX + 1.6, -1.6, 2.6);
  prop('rug_rectangle_stripes_A', -6.8, 0.5, Math.PI / 2, 0.01, 1.3);
  prop('armchair', -6.2, -1.6, Math.PI * 0.75); prop('armchair', -6.2, 2.6, Math.PI * 0.25);
  box(-7.1, -5.3, -2.5, -0.7); box(-7.1, -5.3, 1.7, 3.5);

  /* ---------- tables et fond de salle ---------- */
  prop('table_medium_decorated_A', -4.5, 5.0); box(-5.5, -3.5, 4.0, 6.0);
  prop('stool', -4.5, 3.5); prop('stool', -4.5, 6.5); prop('stool', -6.0, 5.0);
  circles.push({ x: -4.5, z: 3.5, r: 0.4 }, { x: -6, z: 5, r: 0.4 });
  prop('table_small_decorated_A', 3.6, 5.2); box(2.9, 4.3, 4.5, 5.9);
  prop('stool', 3.6, 3.9); prop('stool', 5.0, 5.2);
  circles.push({ x: 3.6, z: 3.9, r: 0.4 }, { x: 5, z: 5.2, r: 0.4 });
  pointLight('#ffcf8a', 3, 9, -4.5, 2.6, 5.0, 0.8);
  prop('barrel_large', -8.6, 6.6, 0, 0, 0.75); prop('crates_stacked', 8.4, 6.7, 0.2, 0, 0.8); prop('barrel_small_stack', -8.8, 4.4, 0, 0, 0.7);
  box(-RX, -7.7, 3.7, RZ); box(7.4, RX, 5.9, RZ);
  prop('banner_shield_blue', -RX - 0.5, -2, Math.PI / 2); prop('banner_patternB_green', RX + 0.5, 2, -Math.PI / 2);
  prop('torch_mounted', -RX, 6, Math.PI / 2); prop('torch_mounted', RX, -4, -Math.PI / 2);
  pointLight('#ffb35c', 4, 10, -RX + 0.7, 3.0, 6, 1.6);
  prop('torch_mounted', -2.2, RZ, Math.PI); prop('torch_mounted', 2.2, RZ, Math.PI);

  /* ---------- coin de la couturière ---------- */
  prop('rug_oval_A', 7.2, 1.0, 0, 0.01, 1.4);
  prop('cabinet_medium_decorated', RX - 0.55, 1.0, -Math.PI / 2, 0, 1.1);
  prop('shelf_B_large_decorated', RX - 0.4, -1.9, -Math.PI / 2);
  prop('pictureframe_standing_A', 8.6, 3.0, -2.2, 0, 2.4);
  prop('trunk_large_A', 8.7, -0.9, -Math.PI / 2, 0, 0.75);
  box(RX - 1.2, RX, -2.8, 2.2);
  pointLight('#ffd9a8', 4, 10, 7.5, 3.4, 1, 0.6);

  /* ---------- PNJ ---------- */
  const makeNpc = (id: Npc['id'], name: string, cfg: CharacterConfig, home: THREE.Vector3, yaw: number): Npc => {
    const npc: Npc = { id, name, home, yaw, root: new THREE.Group(), talkTime: 0, busyTime: 0 };
    npc.root.position.copy(home); npc.root.rotation.y = yaw; scene.add(npc.root);
    setActorModel(npc, cfg);
    circles.push({ x: home.x, z: home.z, r: 0.7 });
    return npc;
  };
  const npcs = {
    barman: makeNpc('barman', 'Gaspard, tavernier', BARMAN_CFG, new THREE.Vector3(-4.3, 0, -5.9), 0.4),
    tailor: makeNpc('tailor', 'Mirabelle, couturière', TAILOR_CFG, new THREE.Vector3(7.3, 0, 0.8), -Math.PI / 2),
  };

  return {
    colliders, circles, stools, wallsBySide, npcs, mugs,
    sitOffset: new THREE.Vector3(sitHips.x, 0, sitHips.z),
    update(t, dt) {
      for (const f of flames) { const k = 1 + Math.sin(t * (9 + f.i * 2.3) + f.i) * 0.12 + Math.sin(t * 23 + f.i * 5) * 0.06; f.mesh.scale.set(1, k, 1); f.mesh.position.y = 0.45 + (f.h * k) / 2; }
      for (const f of flickers) f.light.intensity = f.base * (0.85 + 0.1 * Math.sin(t * (7 + f.f)) + 0.06 * Math.sin(t * (19 + f.f * 3)));
      for (const n of Object.values(npcs)) {
        updateActor(n, t, dt, false);
        n.talkTime -= dt;
        if (n.busyTime > 0) { n.busyTime -= dt; if (n.busyTime <= 0) playAnimation(n, 'Idle', { fade: 0.3 }); }
      }
    },
  };
}
