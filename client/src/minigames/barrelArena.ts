import * as THREE from 'three';
import {
  BARRELS, BARREL_PODIUM, BarrelField, FINISH_S, RAMP, RAMP_LENGTH, TURN_RADIUS, barrelHits, formatSurvival, locate, predictBarrel,
  rampFloor, rampHeight, rampPoint, respawnS,
  type Barrel, type MinigameTick, type RampSeg,
} from '@oddone/shared';
import { OUTLINE, canvasTexture, gradientMap } from '../engine/render.ts';
import { playAnimation, updateActor, type Actor } from '../characters/character.ts';
import { createSkeleton } from '../characters/skeletons.ts';
import { loadKit, type Kit } from '../world/kits.ts';
import { glow } from '../world/outside.ts';
import type { World } from '../world/tavern.ts';
import { Particles, PodiumView } from './effects.ts';
import type { Frame, GameView, HudInfo } from './view.ts';

/**
 * L'arène des « Tonneaux Fous » : une rampe de bois en zigzag dans la cour d'un château, un squelette
 * qui lance des tonneaux du haut ; arrivés en bas, ils se brisent au pied de la rampe.
 * Côté joueur local : se déplacer sur la rampe (les parois arrêtent), sauter par-dessus les
 * tonneaux, pousser les autres (E). Écrasé : aplati un instant, puis on repart du début du
 * tronçon. L'imposteur voit des flèches sur la trajectoire de chaque tonneau.
 */

const W = BARRELS.width, WALL = BARRELS.wall, HALF = W / 2;
/** Le joueur garde ce jeu avec les parois. */
const PLAYER_U = HALF - 0.42;
const WALL_H = 0.8;
/**
 * La cour du château autour de la rampe (qui va de x = -15,5 à 19,5 et de z = 2,5 à -24,5, jusqu'à
 * 12 de haut) : murs à gauche, à droite et au fond, ouverte vers la caméra. Rangées de murs de 4.
 */
const CASTLE = { left: -24, right: 28, back: -28, front: 16, backRows: 4, sideRows: 3 } as const;

/** Dalles de la cour. */
const flagstones = canvasTexture(128, 128, (g, w, h) => {
  g.fillStyle = '#6f675b'; g.fillRect(0, 0, w, h);
  const tones = ['#a39a88', '#988f7d', '#ada593', '#928a79'];
  for (let y = 0, row = 0; y < h; y += 32, row++) {
    for (let x = row % 2 ? -32 : 0, k = 0; x < w; x += 64, k++) {
      g.fillStyle = tones[(row * 3 + k) % tones.length];
      g.fillRect(x + 2, y + 2, 60, 28);
    }
  }
});
flagstones.wrapS = flagstones.wrapT = THREE.RepeatWrapping;
flagstones.repeat.set((CASTLE.right - CASTLE.left) / 4, (CASTLE.front - CASTLE.back) / 4);

const planks = canvasTexture(128, 128, (g, w, h) => {
  const tones = ['#a8723f', '#b47c45', '#9c6838', '#ba844c'];
  for (let y = 0; y < h; y += 16) {
    g.fillStyle = tones[(y / 16) % tones.length]; g.fillRect(0, y, w, 16);
    g.fillStyle = 'rgba(60,35,15,.55)'; g.fillRect(0, y + 14, w, 2);
    const cut = ((y * 37) % 96) + 16;
    g.fillRect(cut, y, 2, 14);
    g.fillStyle = 'rgba(60,35,15,.35)';
    g.beginPath(); g.arc(cut + 8, y + 7, 1.4, 0, 7); g.arc(cut - 8, y + 7, 1.4, 0, 7); g.fill();
  }
});
planks.wrapS = planks.wrapT = THREE.RepeatWrapping;

const stone = canvasTexture(128, 128, (g, w, h) => {
  g.fillStyle = '#7d7468'; g.fillRect(0, 0, w, h);
  let seed = 5;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let y = 0; y < h; y += 21) {
    for (let x = (y / 21) % 2 ? -16 : 0; x < w; x += 32) {
      const c = 120 + rnd() * 40;
      g.fillStyle = `rgb(${c},${c - 6},${c - 16})`;
      g.fillRect(x + 2, y + 2, 28, 17);
    }
  }
});
stone.wrapS = stone.wrapT = THREE.RepeatWrapping;

function banner(text: string): THREE.CanvasTexture {
  return canvasTexture(512, 128, (g, w, h) => {
    for (let x = 0; x < w; x += 32) for (let y = 0; y < h; y += 32) { g.fillStyle = ((x + y) / 32) % 2 ? '#1d120c' : '#fbf1dc'; g.fillRect(x, y, 32, 32); }
    g.fillStyle = 'rgba(26,15,10,.85)'; g.fillRect(60, 22, w - 120, h - 44);
    g.font = '62px "Lilita One", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffd23f'; g.fillText(text, w / 2, h / 2 + 4);
  });
}

/** `broken` : le tonneau a dépassé le pied de la rampe, il s'est brisé (on ne le montre plus). */
interface BarrelView { holder: THREE.Group; roll: THREE.Group; state: Barrel; at: number; angle: number; drawn: boolean; broken: boolean }
/** Un joueur aplati par un tonneau. */
interface Squash { at: number; holder: THREE.Object3D | undefined; root: THREE.Object3D }

export class BarrelArena implements GameView {
  readonly scene = new THREE.Scene();
  readonly world: World;
  readonly particles: Particles;
  readonly podium: PodiumView;
  readonly cameras = { training: 'ramp', play: 'ramp' } as const;
  readonly pushCooldownMs = BARRELS.push.cooldownMs;
  readonly pushReach = BARRELS.push.reach;
  readonly solidPlayers = true;
  /** Au départ, tourné vers la montée. */
  startYaw(): number { return Math.PI / 2; }
  private sun!: THREE.DirectionalLight;
  private barrels = new Map<number, BarrelView>();
  private barrelProto!: THREE.Object3D;
  private arrows!: THREE.InstancedMesh;
  private thrower: (Actor & { model: NonNullable<Actor['model']> }) | null = null;
  private throwAt = 0;
  /** Position du joueur local sur la rampe (sert à retrouver (s, u) sans traverser les parois). */
  private trackS = 2;
  /** Sur la rampe (sinon : podium, dans le pré). */
  private onRamp = true;
  /**
   * Écrasement du joueur local : fin de l'aplatissement, d'où il repart, fin de l'invulnérabilité,
   * en ms sur l'horloge `clock` (celle du serveur pendant la partie : elle ne ralentit pas si
   * l'onglet rame, et c'est elle qui décide quand le joueur redevient « écrasable »).
   */
  private myCrush: { until: number; respawn: number; grace: number } | null = null;
  private seenCrush = new Map<string, number | null>();
  private squashes = new Map<string, Squash>();
  /** Entraînement : des tonneaux rien que pour soi. */
  private training: BarrelField | null = null;
  private trainingMs = 0;
  private flash: { text: string; until: number } | null = null;

  private constructor(private kits: { dungeon: Kit; medieval: Kit }, thrower: Actor & { model: NonNullable<Actor['model']> }) {
    this.world = {
      colliders: [], circles: [], bounds: { halfX: 200, halfZ: 200 },
      ground: (x, z) => this.groundAt(x, z),
    };
    this.build();
    this.particles = new Particles(this.scene);
    this.podium = new PodiumView(this.scene, [...BARREL_PODIUM], this.world, this.particles);
    this.thrower = thrower;
    this.placeThrower();
  }

  static async create(): Promise<BarrelArena> {
    const [dungeon, medieval, thrower] = await Promise.all([loadKit('dungeon'), loadKit('medieval'), createSkeleton('warrior')]);
    return new BarrelArena({ dungeon, medieval }, thrower);
  }

  /* ================= Décor ================= */

  private build(): void {
    const s = this.scene, { dungeon, medieval } = this.kits;
    s.background = canvasTexture(4, 256, (g, w, h) => {
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#6fb6e8'); grad.addColorStop(0.65, '#cbe6f2'); grad.addColorStop(1, '#eef2d8');
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
    });
    s.fog = new THREE.Fog('#d3e8ee', 45, 120);
    s.add(new THREE.HemisphereLight('#fff6e0', '#5f7a3c', 1.9));
    this.sun = new THREE.DirectionalLight('#fff3dc', 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 80 });
    this.sun.shadow.bias = -0.0008;
    s.add(this.sun, this.sun.target);

    // le pré (hors des murs)
    const grass = new THREE.Mesh(new THREE.CircleGeometry(140, 48), new THREE.MeshToonMaterial({ color: '#86b257', gradientMap }));
    grass.rotation.x = -Math.PI / 2; grass.receiveShadow = true;
    s.add(grass);
    // la cour du château : hauts murs de pierre sur trois côtés, créneaux, tours d'angle, donjon
    // derrière. On ne voit que le château autour de la montée. (Murs du kit dungeon, à l'échelle
    // des héros : un mur fait 4 × 4, un héros 2,5.)
    this.buildCastle();

    const plankMat = new THREE.MeshToonMaterial({ map: planks, gradientMap });
    const stoneMat = new THREE.MeshToonMaterial({ map: stone, gradientMap });
    const landingMat = new THREE.MeshToonMaterial({ map: stone, gradientMap, color: '#d8cdb8' });
    const capMat = new THREE.MeshToonMaterial({ color: '#5a3a22', gradientMap });
    for (const g of RAMP) {
      if (g.kind === 'turn') this.buildTurn(g, stoneMat, landingMat, capMat);
      else this.buildStraight(g, plankMat, stoneMat, capMat);
    }

    // l'arrivée : une arche, et la réserve de tonneaux du squelette au bout du palier
    const top = rampPoint(FINISH_S, 0);
    const wood = new THREE.MeshToonMaterial({ color: '#5a3a22', gradientMap });
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 4.6), wood);
      pole.position.set(top.x, top.y + 2.3, top.z + side * (HALF + WALL));
      pole.castShadow = true;
      s.add(pole);
    }
    const ban = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.2), new THREE.MeshToonMaterial({ map: banner('ARRIVÉE'), gradientMap, side: THREE.DoubleSide }));
    ban.position.set(top.x, top.y + 4.2, top.z); ban.rotation.y = Math.PI / 2;
    s.add(ban);
    const end = rampPoint(RAMP_LENGTH - 0.8, 0);
    dungeon.spawn('barrel_small_stack', { x: end.x, y: end.y, z: end.z - 1.6, ry: Math.PI / 2, parent: s });
    dungeon.spawn('barrel_large', { x: end.x - 0.4, y: end.y, z: end.z + 1.7, scale: 0.7, parent: s });
    dungeon.spawn('barrel_large', { x: end.x + 0.5, y: end.y, z: end.z + 0.9, scale: 0.7, parent: s });

    // le prototype de tonneau (couché, il roule autour de son axe)
    this.barrelProto = dungeon.create('barrel_large');
    this.barrelProto.scale.setScalar(0.6);

    // flèches de l'imposteur (trajectoires)
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.34); shape.lineTo(0.3, -0.05); shape.lineTo(0.13, -0.05); shape.lineTo(0.13, -0.3);
    shape.lineTo(-0.13, -0.3); shape.lineTo(-0.13, -0.05); shape.lineTo(-0.3, -0.05); shape.closePath();
    const geo = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).rotateY(Math.PI); // à plat, pointe vers +z
    this.arrows = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }), BARRELS.maxBarrels * 12);
    this.arrows.count = 0;
    this.arrows.frustumCulled = false;
    this.arrows.renderOrder = 2;
    s.add(this.arrows);
  }

  /** Les murs de la cour, de x = CASTLE.left à CASTLE.right et jusqu'à CASTLE.back (la rampe est au milieu). */
  private buildCastle(): void {
    const s = this.scene, { dungeon, medieval } = this.kits, C = CASTLE;
    // dallage de la cour
    const court = new THREE.Mesh(new THREE.PlaneGeometry(C.right - C.left, C.front - C.back), new THREE.MeshToonMaterial({ map: flagstones, gradientMap }));
    court.rotation.x = -Math.PI / 2;
    court.position.set((C.left + C.right) / 2, 0.01, (C.front + C.back) / 2);
    court.receiveShadow = true;
    s.add(court);
    const wallPiece = (row: number, k: number) => row === 0 ? (k % 4 === 2 ? 'wall_cracked' : 'wall') : row === 2 && k % 3 === 1 ? 'wall_window_closed' : 'wall';
    // le fond (4 rangées, plus haut que le sommet de la rampe) et les deux côtés (3 rangées)
    for (let x = C.left + 2, k = 0; x < C.right; x += 4, k++) {
      for (let row = 0; row < C.backRows; row++) dungeon.spawn(wallPiece(row, k), { x, y: row * 4, z: C.back - 0.5, parent: s, shadows: row < 2 });
      medieval.spawn('wall_straight', { x, y: C.backRows * 4, z: C.back - 0.5, scale: 2, parent: s, shadows: false });
    }
    for (const [x, ry] of [[C.left - 0.5, Math.PI / 2], [C.right + 0.5, -Math.PI / 2]] as const) {
      for (let z = C.back + 2, k = 0; z < C.front; z += 4, k++) {
        for (let row = 0; row < C.sideRows; row++) dungeon.spawn(wallPiece(row, k + (x > 0 ? 1 : 0)), { x, y: row * 4, z, ry, parent: s, shadows: row < 2 });
        medieval.spawn('wall_straight', { x, y: C.sideRows * 4, z, ry, scale: 2, parent: s, shadows: false });
      }
    }
    // piliers et tours aux angles, donjon derrière le mur du fond
    for (const x of [C.left - 0.5, C.right + 0.5]) {
      const p = dungeon.spawn('pillar', { x, z: C.back - 0.5, parent: s });
      p.scale.set(1.6, C.backRows, 1.6);
      for (const z of [C.back - 2, C.front + 1]) medieval.spawn(`building_tower_A_${x < 0 ? 'red' : 'blue'}`, { x: x + (x < 0 ? -2 : 2), z, ry: x < 0 ? Math.PI / 2 : -Math.PI / 2, scale: 9.5, parent: s, shadows: false });
    }
    medieval.spawn('building_castle_red', { x: 2, z: C.back - 17, scale: 9, parent: s, shadows: false });
    // bannières et torches sur les murs
    const colors = ['red', 'yellow', 'blue'];
    for (let x = C.left + 6, k = 0; x < C.right - 2; x += 8, k++) {
      dungeon.spawn(k % 2 ? `banner_patternA_${colors[k % 3]}` : `banner_triple_${colors[k % 3]}`, { x, y: 7.5, z: C.back + 0.05, scale: 1.6, parent: s, shadows: false });
      dungeon.spawn('torch_mounted', { x: x + 4, y: 3, z: C.back, parent: s, shadows: false });
      const flame = glow('#ffae42', 1.4, 0.8); flame.position.set(x + 4, 3.65, C.back + 0.45); s.add(flame);
    }
    for (const [x, ry, dx] of [[C.left, Math.PI / 2, 1], [C.right, -Math.PI / 2, -1]] as const) {
      for (let z = C.back + 6, k = 0; z < C.front - 2; z += 8, k++) {
        dungeon.spawn(`banner_patternC_${colors[(k + (dx > 0 ? 0 : 1)) % 3]}`, { x: x + dx * 0.05, y: 5.5, z, ry, scale: 1.4, parent: s, shadows: false });
        dungeon.spawn('torch_mounted', { x, y: 3, z: z + 4, ry, parent: s, shadows: false });
        const flame = glow('#ffae42', 1.4, 0.8); flame.position.set(x + dx * 0.45, 3.65, z + 4); s.add(flame);
      }
    }
    // provisions et armes le long des murs (loin de la rampe et du podium)
    const props: [string, number, number, number, number?][] = [
      ['barrel_large', C.left + 1.5, 4, 0.3], ['crates_stacked', C.left + 1.6, 8.5, 0.2], ['barrel_small_stack', C.left + 1.2, -4, Math.PI / 2],
      ['box_stacked', C.right - 2.2, 6, 0.4, 0.8], ['keg_decorated', C.right - 1.5, 11, -Math.PI / 2], ['barrel_large', C.right - 1.5, 1, 1.2],
      ['sword_shield', C.left + 0.6, 0, Math.PI / 2], ['barrel_small', C.right - 1.2, 3.2, 0],
    ];
    for (const [name, x, z, ry, scale] of props) {
      if (!dungeon.has(name)) continue;
      const o = dungeon.spawn(name, { x, z, ry, scale, parent: s });
      if (name === 'sword_shield') o.position.y = 2;
    }
  }

  /** Montée ou palier : plancher incliné, socle de pierre, parois. */
  private buildStraight(g: Extract<RampSeg, { kind: 'pad' | 'run' }>, plankMat: THREE.Material, stoneMat: THREE.Material, capMat: THREE.Material): void {
    const s = this.scene;
    const slope = Math.atan2(g.h1 - g.h0, g.len);
    const mid = rampPoint(g.s0 + g.len / 2, 0);
    const yaw = Math.atan2(-g.d[1], g.d[0]); // l'axe x local suit la montée
    // plancher
    const floor = new THREE.Mesh(new THREE.BoxGeometry(g.len / Math.cos(slope) + 0.02, 0.24, W + WALL * 2), plankMat);
    const tex = planks.clone(); tex.needsUpdate = true; tex.repeat.set(g.len / 3, 1.6);
    floor.material = new THREE.MeshToonMaterial({ map: tex, gradientMap });
    floor.position.set(mid.x, mid.y - 0.12, mid.z);
    floor.rotation.set(0, yaw, slope, 'YXZ');
    floor.receiveShadow = true; floor.castShadow = true;
    s.add(floor);
    // socle : du sol jusque sous le plancher (profil en trapèze, extrudé sur la largeur)
    if (g.h1 > 0.05 || g.h0 > 0.05) {
      const shape = new THREE.Shape();
      shape.moveTo(0, -0.05); shape.lineTo(g.len, -0.05); shape.lineTo(g.len, g.h1 - 0.2); shape.lineTo(0, g.h0 - 0.2); shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: W + WALL * 2, bevelEnabled: false });
      geo.translate(0, 0, -(W + WALL * 2) / 2);
      const base = new THREE.Mesh(geo, stoneMat);
      (stone as THREE.Texture).repeat.set(0.35, 0.35);
      base.position.set(g.start[0], 0, g.start[1]);
      base.rotation.y = yaw;
      base.receiveShadow = true;
      s.add(base);
    }
    // parois : devant (côté caméra) partout ; derrière seulement là où il n'y a pas de montée au-dessus
    const above = RAMP.some((q) => q.kind === 'run' && q.index === (g.kind === 'run' ? g.index + 1 : -1));
    for (const side of [-1, 1]) {
      const n = side * (HALF + WALL / 2);
      const p = rampPoint(g.s0 + g.len / 2, n);
      const towardCamera = p.z > mid.z;
      if (!towardCamera && above) continue;
      const wall = new THREE.Mesh(new THREE.BoxGeometry(g.len / Math.cos(slope), WALL_H, WALL), stoneMat);
      wall.position.set(p.x, mid.y + WALL_H / 2 - 0.02, p.z);
      wall.rotation.set(0, yaw, slope, 'YXZ');
      wall.castShadow = wall.receiveShadow = true;
      s.add(wall);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(g.len / Math.cos(slope), 0.1, WALL + 0.1), capMat);
      cap.position.set(p.x, mid.y + WALL_H + 0.03, p.z);
      cap.rotation.copy(wall.rotation);
      s.add(cap);
    }
    // les bouts ouverts du palier d'arrivée : un muret au fond
    if (g.kind === 'pad' && g.index === 1) {
      const e = rampPoint(g.s0 + g.len + WALL / 2, 0);
      const endWall = new THREE.Mesh(new THREE.BoxGeometry(WALL, WALL_H, W + WALL * 2), stoneMat);
      endWall.position.set(e.x, e.y + WALL_H / 2, e.z); endWall.rotation.y = yaw;
      s.add(endWall);
    }
  }

  /** Virage en épingle : palier plat en demi-cercle, paroi extérieure courbe, poteau au centre. */
  private buildTurn(g: Extract<RampSeg, { kind: 'turn' }>, stoneMat: THREE.Material, landingMat: THREE.Material, capMat: THREE.Material): void {
    const s = this.scene;
    const outer = TURN_RADIUS + HALF + WALL;
    const start = g.b[0] > 0 ? 0 : Math.PI;
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(outer, outer, g.h0 + 0.05, 32, 1, false, start, Math.PI), [stoneMat, landingMat, stoneMat]);
    deck.position.set(g.c[0], (g.h0 + 0.05) / 2 - 0.05, g.c[1]);
    deck.receiveShadow = deck.castShadow = true;
    this.scene.add(deck);
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(outer - WALL / 2, outer - WALL / 2, WALL_H, 32, 1, true, start, Math.PI), new THREE.MeshToonMaterial({ map: stone, gradientMap, side: THREE.DoubleSide }));
    wall.position.set(g.c[0], g.h0 + WALL_H / 2, g.c[1]);
    wall.castShadow = true;
    s.add(wall);
    const cap = new THREE.Mesh(new THREE.TorusGeometry(outer - WALL / 2, 0.12, 6, 32, Math.PI), capMat);
    cap.rotation.set(-Math.PI / 2, 0, g.b[0] > 0 ? -Math.PI / 2 : Math.PI / 2);
    cap.position.set(g.c[0], g.h0 + WALL_H + 0.02, g.c[1]);
    s.add(cap);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, g.h0 + WALL_H + 0.4, 12), stoneMat);
    post.position.set(g.c[0], (g.h0 + WALL_H + 0.4) / 2, g.c[1]);
    post.castShadow = true;
    const edge = new THREE.Mesh(post.geometry, OUTLINE); edge.scale.setScalar(1.06); post.add(edge);
    s.add(post);
  }

  /** Le squelette lanceur de tonneaux, en haut, à côté de sa réserve. */
  private placeThrower(): void {
    const t = this.thrower!;
    const p = rampPoint(RAMP_LENGTH - 2.2, -1.4);
    t.root.position.set(p.x, p.y, p.z);
    t.root.rotation.y = -Math.PI / 2; // face à la descente
    t.model.holder.scale.setScalar(1.25);
    this.scene.add(t.root);
    playAnimation(t, 'Idle_Combat', { fade: 0 });
  }

  /* ================= Sol et parois pour le joueur local ================= */

  private groundAt(x: number, z: number): number {
    if (!this.onRamp) return 0;
    const l = locate(x, z, this.trackS);
    return rampHeight(Math.max(0, Math.min(RAMP_LENGTH, l.s)));
  }

  /** Après le déplacement : on reste entre les parois (et sur la rampe). */
  private keepOnRamp(P: THREE.Vector3): void {
    const l = locate(P.x, P.z, this.trackS);
    const s = Math.max(0.4, Math.min(RAMP_LENGTH - 0.4, l.s));
    const u = Math.max(-PLAYER_U, Math.min(PLAYER_U, l.u));
    if (s !== l.s || u !== l.u) { const q = rampPoint(s, u); P.x = q.x; P.z = q.z; }
    this.trackS = s;
  }

  private placeAtS(f: Frame, s: number): void {
    const p = rampPoint(s, 0);
    f.me.placeAt(p.x, p.z, Math.atan2(p.t[0], p.t[1]), p.y);
    this.trackS = s;
  }

  /* ================= Joueur local ================= */

  startTraining(f: Frame): void {
    this.training = new BarrelField(); this.trainingMs = 0;
    this.myCrush = null;
    this.trackS = locate(f.me.root.position.x, f.me.root.position.z, 2).s;
  }
  stopTraining(): void { this.training = null; this.clearBarrels(); this.myCrush = null; }

  onPhase(f: Frame): void {
    if (f.phase === 'roleReveal' || f.phase === 'mgCountdown') {
      this.myCrush = null; this.seenCrush.clear();
      this.trackS = locate(f.me.root.position.x, f.me.root.position.z, 2).s;
    }
    this.onRamp = f.phase !== 'mgResults';
    if (f.phase === 'mgResults') {
      this.myCrush = null;
      this.clearBarrels();
      for (const [id] of this.squashes) this.unsquash(id);
      this.arrows.count = 0;
      f.me.model?.holder.scale.setScalar(1);
    }
  }

  beforeMove(f: Frame): void {
    const me = f.me;
    me.fourWay = false; me.canJump = true; me.controls = null; me.laneAssist = 0;
    me.speedMul = BARRELS.playerSpeed / 6.2;
    if (this.myCrush && this.clock(f) < this.myCrush.until) me.frozen = true;
  }

  afterMove(f: Frame): string | null {
    const me = f.me, P = me.root.position;
    // aplati : on repart du début du tronçon
    if (this.myCrush && this.clock(f) >= this.myCrush.until && this.myCrush.respawn >= 0) {
      this.unsquash(f.myId);
      this.placeAtS(f, this.myCrush.respawn);
      this.particles.burst(P.x, P.y + 0.6, P.z, '#fff3c2', 10, 0.9, 0.7);
      this.myCrush.respawn = -1;
    }
    this.keepOnRamp(P);
    // entraînement : les tonneaux sont locaux, on juge l'écrasement ici
    if (f.phase === 'rules' && this.training && !this.myCrush) {
      const above = P.y - rampHeight(this.trackS);
      if (this.training.barrels.some((b) => barrelHits(b, P.x, P.z, above))) {
        this.crushMe(f, respawnS(this.trackS), this.clock(f));
        return 'Écrasé !';
      }
    }
    if (this.myCrush && this.myCrush.respawn < 0 && this.clock(f) >= this.myCrush.grace) this.myCrush = null;
    return null;
  }

  /** Horloge des écrasements (ms) : celle du serveur pendant la partie, locale à l'entraînement. */
  private clock(f: Frame): number { return f.phase === 'mgPlay' ? f.playMs : f.simTime * 1000; }

  private crushMe(f: Frame, respawn: number, at: number): void {
    this.myCrush = { until: at + BARRELS.crushMs, respawn, grace: at + BARRELS.crushMs + BARRELS.graceMs };
    this.squash(f.myId, f.me.root, f.me.model?.holder, f);
    f.me.velocity.set(0, 0, 0);
    this.flash = { text: 'Écrasé ! Retour au début du tronçon…', until: f.simTime + BARRELS.crushMs / 1000 + 0.6 };
  }

  private squash(id: string, root: THREE.Object3D, holder: THREE.Object3D | undefined, f: Frame): void {
    this.squashes.set(id, { at: f.simTime, holder, root });
    this.particles.burst(root.position.x, root.position.y + 0.4, root.position.z, '#c58a4a', 16, 1.4, 0.8);
  }

  private unsquash(id: string): void {
    const sq = this.squashes.get(id);
    if (!sq) return;
    sq.holder?.scale.set(1, 1, 1);
    this.squashes.delete(id);
  }

  applyTick(tick: MinigameTick, f: Frame): void {
    for (const [id, x, z, yaw, anim, y] of tick.bots) f.remotes.get(id)?.setTransform({ p: [x, y ?? 0, z], r: yaw, a: anim });
    if (!tick.br || f.phase !== 'mgPlay') return;
    const seen = new Set<number>();
    for (const [id, s, u, vs, vu] of tick.br) {
      seen.add(id);
      const v = this.barrels.get(id) ?? this.addBarrel(id);
      v.state = { id, s, u, vs, vu }; v.at = f.simTime;
    }
    for (const [id] of this.barrels) if (!seen.has(id)) this.removeBarrel(id);
  }

  /* ================= Tonneaux ================= */

  private addBarrel(id: number): BarrelView {
    const holder = new THREE.Group(), roll = new THREE.Group(), axis = new THREE.Group();
    const model = this.barrelProto.clone();
    model.position.y = -0.6; // centré sur l'axe
    axis.add(model); axis.rotation.z = Math.PI / 2; // couché : l'axe du tonneau suit x
    roll.add(axis); holder.add(roll);
    this.scene.add(holder);
    const v: BarrelView = { holder, roll, state: { id, s: 0, u: 0, vs: 0, vu: 0 }, at: 0, angle: 0, drawn: false, broken: false };
    this.barrels.set(id, v);
    return v;
  }

  private removeBarrel(id: number): void {
    const v = this.barrels.get(id);
    if (!v) return;
    v.holder.removeFromParent();
    this.barrels.delete(id);
  }

  private clearBarrels(): void { for (const id of [...this.barrels.keys()]) this.removeBarrel(id); }

  /** Place un tonneau d'après son état (s, u), couché en travers de la rampe. */
  private drawBarrel(v: BarrelView, b: Barrel, dt: number, snap: boolean): void {
    // au pied de la rampe (plus de trou) : le tonneau se brise en éclats de bois et disparaît
    if (b.s < 0) {
      if (!v.broken && v.drawn) {
        const p = rampPoint(0, b.u);
        this.particles.burst(p.x - 0.4, BARRELS.radius, p.z, '#b07a45', 14, 1.6, 0.8);
      }
      v.broken = true; v.holder.visible = false;
      return;
    }
    const p = rampPoint(b.s, b.u);
    const y = rampHeight(b.s) + BARRELS.radius;
    if (snap || !v.drawn) v.holder.position.set(p.x, y, p.z);
    else v.holder.position.lerp(new THREE.Vector3(p.x, y, p.z), 1 - Math.exp(-25 * dt));
    v.drawn = true;
    v.holder.rotation.y = Math.atan2(-p.n[1], p.n[0]);
    v.angle += (b.vs * dt) / BARRELS.radius;
    v.roll.rotation.x = v.angle * (p.n[0] * p.t[1] - p.n[1] * p.t[0] > 0 ? 1 : -1);
  }

  /** Positions des tonneaux : état reçu du serveur, avancé jusqu'à maintenant (ou entraînement). */
  private barrelStates(f: Frame): Barrel[] {
    if (f.phase === 'rules' && this.training) return this.training.barrels;
    const out: Barrel[] = [];
    for (const v of this.barrels.values()) {
      const dt = Math.min(0.15, f.simTime - v.at);
      const u = Math.max(-(HALF - BARRELS.radius), Math.min(HALF - BARRELS.radius, v.state.u + v.state.vu * dt));
      out.push({ id: v.state.id, s: v.state.s + v.state.vs * dt, u, vs: v.state.vs, vu: v.state.vu });
    }
    return out;
  }

  /** Flèches de l'imposteur : la trajectoire probable de chaque tonneau. */
  private drawArrows(states: Barrel[]): void {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const near = new THREE.Color('#ff3b2f'), far = new THREE.Color('#ffc94a'), col = new THREE.Color();
    let n = 0;
    for (const b of states) {
      if (b.s < 0) continue;
      const path = predictBarrel(b, 1.6, 0.16);
      let prev = rampPoint(b.s, b.u);
      path.forEach(([s, u], k) => {
        if (n >= this.arrows.instanceMatrix.count) return;
        const p = rampPoint(s, u);
        const dx = p.x - prev.x, dz = p.z - prev.z;
        prev = p;
        if (Math.hypot(dx, dz) < 1e-3) return;
        q.setFromAxisAngle(up, Math.atan2(dx, dz));
        pos.set(p.x, rampHeight(s) + 0.08, p.z);
        const kk = k / Math.max(1, path.length - 1);
        sc.setScalar(1.15 - kk * 0.45);
        m.compose(pos, q, sc);
        this.arrows.setMatrixAt(n, m);
        this.arrows.setColorAt(n, col.copy(near).lerp(far, kk));
        n++;
      });
    }
    this.arrows.count = n;
    this.arrows.instanceMatrix.needsUpdate = true;
    if (this.arrows.instanceColor) this.arrows.instanceColor.needsUpdate = true;
  }

  update(t: number, dt: number, f: Frame): void {
    this.particles.update(dt);
    this.podium.update(dt);
    const P = f.me.root.position;
    this.sun.position.set(P.x - 9, P.y + 24, P.z + 12);
    this.sun.target.position.set(P.x, P.y, P.z - 4);

    // entraînement : des tonneaux locaux
    if (f.phase === 'rules' && this.training) {
      this.trainingMs += dt * 1000;
      this.training.step(dt * 1000, Math.min(this.trainingMs, 15_000), Math.random);
      const alive = new Set(this.training.barrels.map((b) => b.id));
      for (const [id] of this.barrels) if (!alive.has(id)) this.removeBarrel(id);
      for (const b of this.training.barrels) {
        const fresh = !this.barrels.has(b.id);
        const v = this.barrels.get(b.id) ?? this.addBarrel(b.id);
        this.drawBarrel(v, b, dt, fresh);
      }
    } else if (f.phase === 'mgPlay') {
      const states = this.barrelStates(f);
      for (const b of states) {
        const v = this.barrels.get(b.id)!;
        this.drawBarrel(v, b, dt, false);
      }
      if (f.imposter) this.drawArrows(states); else this.arrows.count = 0;
    }

    // le squelette lance un tonneau de temps en temps
    if (this.thrower) {
      if (f.simTime > this.throwAt) { this.throwAt = f.simTime + 1.4 + Math.random() * 1.2; playAnimation(this.thrower, 'Throw', { once: true, restart: true, fade: 0.1 }); }
      updateActor(this.thrower, t, dt, false);
    }

    // écrasements (serveur) : aplatir la victime, une fois par écrasement
    if (f.phase === 'mgPlay' && f.mg.ramp) {
      for (const [id, st] of Object.entries(f.mg.ramp)) {
        const seen = this.seenCrush.get(id) ?? null;
        if (st.crushedAt === null || st.crushedAt === seen) continue;
        this.seenCrush.set(id, st.crushedAt);
        if (id === f.myId) this.crushMe(f, st.respawnS, st.crushedAt);
        else { const r = f.remotes.get(id); if (r) this.squash(id, r.root, r.model?.holder, f); }
      }
    }
    for (const [id, sq] of this.squashes) {
      const age = f.simTime - sq.at, holder = sq.holder;
      if (age > BARRELS.crushMs / 1000) { if (id !== f.myId) this.unsquash(id); continue; }
      if (holder) { const k = Math.min(1, age / 0.08); holder.scale.set(1 + 0.35 * k, 1 - 0.78 * k, 1 + 0.35 * k); }
    }
    // invulnérable après la réapparition : il clignote
    const blink = !!this.myCrush && this.myCrush.respawn < 0 && this.clock(f) < this.myCrush.grace;
    f.me.root.visible = !blink || Math.floor(f.simTime * 10) % 2 === 0;
  }

  /* ================= HUD ================= */

  hud(f: Frame): HudInfo {
    const ramp = f.mg.ramp, st = ramp?.[f.myId];
    const runs = BARRELS.runs;
    const floor = Math.min(runs, Math.max(1, rampFloor(this.trackS)));
    let status: HudInfo['status'] = null;
    if (this.flash && f.simTime < this.flash.until) status = { text: this.flash.text, cls: 'cursed' };
    else if (f.phase === 'mgPlay') {
      if (st?.finishedAt != null) status = { text: 'Arrivé en haut ! Les autres ont encore un peu de temps…' };
      else if (f.playMs < 4500) status = { text: f.imposter ? 'Grimpe ! Les flèches montrent où vont les tonneaux' : 'Grimpe ! Espace pour sauter, E pour pousser' };
    }
    const myTime = st?.finishedAt ?? f.playMs;
    return {
      boxes: [
        { label: st?.finishedAt != null ? 'Arrivé en' : 'Temps', value: formatSurvival(f.phase === 'mgPlay' ? myTime : 0), cls: st?.finishedAt != null ? 'caught' : '' },
        { label: 'Rampe', value: st?.finishedAt != null ? 'Sommet !' : `${floor} / ${runs}`, cls: 'sk' },
      ],
      chip: (id) => {
        const r = ramp?.[id];
        if (!r) return { text: 'Au départ' };
        if (r.finishedAt !== null) return { text: `Arrivé · ${formatSurvival(r.finishedAt)}`, cls: 'done' };
        if (r.crushedAt !== null && f.playMs - r.crushedAt < BARRELS.crushMs) return { text: 'Écrasé !', cls: 'caught' };
        return { text: `Rampe ${Math.min(runs, Math.max(1, rampFloor(r.best)))} / ${runs}${r.crushes ? ` · ${r.crushes} ×💥` : ''}` };
      },
      status,
      extra: f.imposter && f.phase === 'mgPlay' ? '<div class="ctrl"><small>Imposteur</small><p>Tu vois les trajectoires des tonneaux</p></div>' : '',
    };
  }

  exit(): void {
    this.clearBarrels();
    for (const [id] of this.squashes) this.unsquash(id);
    this.arrows.count = 0;
    this.training = null; this.myCrush = null; this.onRamp = true;
  }
}
