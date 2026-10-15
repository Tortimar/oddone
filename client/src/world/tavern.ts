import * as THREE from 'three';
import { DEFAULT_CONFIG, SEAT_COUNT, type CharacterConfig } from '@oddone/shared';
import { camera, canvasTexture, gradientMap, part, scene, shade } from '../engine/render.ts';
import { LIB, kitMaterials } from '../characters/library.ts';
import { loadKit } from './kits.ts';
import { buildOutside } from './outside.ts';
import { decorateTavern } from './tavernDecor.ts';
import { measureSitPose, playAnimation, setActorModel, updateActor, type Actor } from '../characters/character.ts';

/**
 * La taverne : structure (murs et sol des kits KayKit, comptoir et cheminée modélisés en code),
 * PNJ, lumières et collisions. L'habillage est dans tavernDecor.ts, l'extérieur de nuit vu par
 * les fenêtres dans outside.ts.
 * Unités : celles des modèles KayKit (un mur = 4 × 4, un perso ≈ 2,5 de haut).
 */

export const ROOM = { halfX: 10, halfZ: 8 };
/** Hauteur des murs (deux rangées de murs KayKit de 4) et du plafond. */
export const WALL_HEIGHT = 8;
/** Zone où la caméra a le droit d'aller : l'intérieur de la salle, avec une marge. */
export const CAMERA_BOUNDS = { minX: -ROOM.halfX + 0.45, maxX: ROOM.halfX - 0.45, minY: 0.4, maxY: WALL_HEIGHT - 0.9, minZ: -ROOM.halfZ + 0.45, maxZ: ROOM.halfZ - 0.45 };
export type { Box, Circle } from '@oddone/shared';
import type { Box, Bounds, Circle } from '@oddone/shared';

export interface Npc extends Actor {
  id: 'barman' | 'tailor';
  name: string;
  home: THREE.Vector3;
  yaw: number;
  talkTime: number;
  busyTime: number;
}

/** Un lieu où l'on marche : obstacles et limites (taverne, arène d'un mini-jeu). */
export interface World {
  colliders: Box[];
  circles: Circle[];
  bounds: Bounds;
  /** Blocs sur lesquels on peut monter (podium) : boîte au sol + hauteur du dessus. */
  steps?: (Box & { top: number })[];
  /** Sol troué (gouffre) : false là où il n'y a que le vide. Absent : sol partout. */
  floor?: (x: number, z: number) => boolean;
  /** Hauteur du sol (rampe des Tonneaux Fous). Absent : sol à 0. */
  ground?: (x: number, z: number) => number;
}

export interface Tavern extends World {
  stools: { x: number; z: number }[];
  /** Décalage hanches/racine en pose assise (pour poser le perso sur le tabouret). */
  sitOffset: THREE.Vector3;
  npcs: Record<Npc['id'], Npc>;
  mugs: THREE.Mesh[];
  update(t: number, dt: number): void;
}

const BAR_Z = -4.6, BAR_HALF = 5.4;
const BARMAN_CFG: CharacterConfig = { ...DEFAULT_CONFIG, body: 'barbarian', head: 'barbarian', cape: 'none', hue: 22, right: 'barbarian:Mug', size: '1.14' };
const TAILOR_CFG: CharacterConfig = { ...DEFAULT_CONFIG, body: 'mage', head: 'mage', hat: 'mage', cape: 'none', hue: 325, face: 'glasses' };

/** Plafond de planches sombres, poutres et solives ; ne porte pas d'ombre. */
function buildCeiling(upperWalls: THREE.Object3D[]): void {
  const { halfX: RX, halfZ: RZ } = ROOM;
  const planks = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#3e2616'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i % 2 ? '#472c1a' : '#3a2314'; g.fillRect(0, i * 32, w, 32);
      g.fillStyle = '#24150c'; g.fillRect(0, i * 32, w, 3);
      g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(((i * 97) % 200) + 20, i * 32 + 3, 3, 29);
    }
  });
  planks.wrapS = planks.wrapT = THREE.RepeatWrapping;
  planks.repeat.set(5, 4);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(RX * 2 + 1, RZ * 2 + 1), new THREE.MeshToonMaterial({ map: planks, gradientMap, side: THREE.DoubleSide }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = WALL_HEIGHT;
  ceiling.receiveShadow = true;
  scene.add(ceiling);
  const beams: THREE.Mesh[] = [];
  for (let x = -8; x <= 8; x += 4) {
    const b = part(scene, new THREE.BoxGeometry(0.45, 0.5, RZ * 2), '#5a3a22', { outline: true });
    b.position.set(x, WALL_HEIGHT - 0.25, 0);
    beams.push(b);
  }
  for (const z of [-RZ + 0.25, RZ - 0.25]) {
    const b = part(scene, new THREE.BoxGeometry(RX * 2, 0.4, 0.5), '#4a2f1d', { outline: true });
    b.position.set(0, WALL_HEIGHT - 0.2, z);
    beams.push(b);
  }
  // bandeau de bois qui marque la jonction entre les deux rangées de murs
  for (const [x, z, w, d] of [[0, -RZ + 0.08, RX * 2, 0.16], [0, RZ - 0.08, RX * 2, 0.16], [-RX + 0.08, 0, 0.16, RZ * 2], [RX - 0.08, 0, 0.16, RZ * 2]] as const) {
    const b = part(scene, new THREE.BoxGeometry(w, 0.28, d), '#5a3a22', { outline: true });
    b.position.set(x, 4.05, z);
  }
  for (const o of [...upperWalls, ...beams]) o.traverse((m) => { m.castShadow = false; });
}

export async function buildTavern(): Promise<Tavern> {
  const [dungeon, furniture, restaurant, halloween, medieval] = await Promise.all(
    (['dungeon', 'furniture', 'restaurant', 'halloween', 'medieval'] as const).map((k) => loadKit(k)));

  const { halfX: RX, halfZ: RZ } = ROOM;
  const colliders: Box[] = [];
  const circles: Circle[] = [];
  const box = (x0: number, x1: number, z0: number, z1: number) => colliders.push({ x0, x1, z0, z1 });

  const prop = (name: string, x: number, z: number, ry = 0, y = 0, s = 1) => {
    const kit = dungeon.has(name) ? dungeon : furniture.has(name) ? furniture : null;
    if (!kit) { console.warn('Décor manquant :', name); return null; }
    return kit.spawn(name, { x, y, z, ry, scale: s, parent: scene });
  };

  /* ---------- lumière : chaude à l'intérieur, nuit bleutée dehors ---------- */
  scene.background = new THREE.Color('#0b0d26');
  scene.fog = new THREE.Fog('#2a2148', 30, 95);
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
    // (pas de fenêtre derrière la cheminée : celle du mur gauche est au fond, en z = 6)
    prop(z === 6 || z === -6 ? 'wall_window_open' : 'wall', -RX - 0.5, z, Math.PI / 2);
    prop(z === -2 || z === 6 ? 'wall_window_open' : 'wall', RX + 0.5, z, -Math.PI / 2);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) prop('pillar', sx * (RX + 0.5), sz * (RZ + 0.5));
  // deuxième rangée de murs pleins jusqu'au plafond (elle ne porte pas d'ombre : le soleil doit entrer)
  const upper: THREE.Object3D[] = [];
  for (let x = -8; x <= 8; x += 4) {
    upper.push(prop('wall', x, -RZ - 0.5, 0, 4)!, prop('wall', x, RZ + 0.5, Math.PI, 4)!);
  }
  for (let z = -6; z <= 6; z += 4) {
    upper.push(prop('wall', -RX - 0.5, z, Math.PI / 2, 4)!, prop('wall', RX + 0.5, z, -Math.PI / 2, 4)!);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) upper.push(prop('pillar', sx * (RX + 0.5), sz * (RZ + 0.5), 0, 4)!);
  buildCeiling(upper);
  // dehors : ciel étoilé, village, forêt (masqués avec le mur de leur côté)
  const outside = buildOutside(scene, { medieval, halloween }, ROOM);

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
  prop('torch_mounted', -RX, 4, Math.PI / 2); prop('torch_mounted', RX, -4, -Math.PI / 2);
  pointLight('#ffb35c', 4, 10, -RX + 0.7, 3.0, 4, 1.6);
  prop('torch_mounted', -2.2, RZ, Math.PI); prop('torch_mounted', 2.2, RZ, Math.PI);

  /* ---------- coin de la couturière ---------- */
  prop('rug_oval_A', 7.2, 1.0, 0, 0.01, 1.4);
  prop('cabinet_medium_decorated', RX - 0.55, 1.0, -Math.PI / 2, 0, 1.1);
  prop('shelf_B_large_decorated', RX - 0.4, -1.9, -Math.PI / 2);
  prop('pictureframe_standing_A', 8.6, 3.0, -2.2, 0, 2.4);
  prop('trunk_large_A', 8.7, -0.9, -Math.PI / 2, 0, 0.75);
  box(RX - 1.2, RX, -2.8, 2.2);
  pointLight('#ffd9a8', 4, 10, 7.5, 3.4, 1, 0.6);

  /* ---------- habillage ---------- */
  const decor = decorateTavern({
    scene, kits: { dungeon, furniture, restaurant, halloween }, room: ROOM, colliders, circles,
    counterH, barZ: BAR_Z, pointLight,
  });

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
    colliders, circles, bounds: ROOM, stools, npcs, mugs,
    sitOffset: new THREE.Vector3(sitHips.x, 0, sitHips.z),
    update(t, dt) {
      outside.update(t);
      decor.update(t, dt, camera.position);
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
