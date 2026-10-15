import * as THREE from 'three';
import {
  INGREDIENTS, INGREDIENT_BY_ID, MARKET, MARKET_CIRCLES, STALLS, nearCauldron, stallInReach,
  type MarketEvent, type MinigameTick,
} from '@oddone/shared';
import { OUTLINE, camera, canvasTexture, gradientMap, shade } from '../engine/render.ts';
import { loadKit, type Kit } from '../world/kits.ts';
import { glow } from '../world/outside.ts';
import { escapeHtml } from '../ui/dom.ts';
import { objectIcon } from '../ui/portraits.ts';
import type { World } from '../world/tavern.ts';
import { Particles, PodiumView } from './effects.ts';
import type { Frame, GameView, HudInfo } from './view.ts';

/**
 * L'arène du « Festin du Roi » : la place d'un village médiéval, dix échoppes en cercle, la
 * grande marmite au centre. Côté joueur local : prendre (E), verser dans la marmite (E),
 * transformer (R, imposteur) ; recette affichée puis cachée, panier en icônes.
 */

/** On marche jusqu'à la bordure de la place ; les façades commencent un peu plus loin. */
const WALK_RADIUS = 13;
const FACADES = 15.6;
/** La caméra reste devant les façades. */
const CAMERA_RADIUS = 15;
/** Les rues pavées vont jusqu'aux remparts. */
const STREET_RADIUS = 72;
/** Hauteur des guirlandes de fanions. */
const GARLAND_Y = 7.4;
/** Les objets plus près de la caméra que ça s'effacent (sinon ils bouchent la vue). */
const FADE_NEAR = 2.2, FADE_FAR = 4.2;
/** Caméra à moins de ça (à plat) du centre d'une échoppe : l'échoppe devient transparente. */
const STALL_FADE = 2.4;

/**
 * Les maisons autour de la place, dans l'ordre, avec leur échelle. Le kit medieval est une
 * maquette : ×8 environ, la porte d'une maison est un peu plus haute qu'un héros (2,5), une maison
 * en fait trois à quatre fois la hauteur, l'église six.
 */
const TOWN: [string, number][] = [
  ['building_church', 9.2], ['building_home_A', 8], ['building_tavern', 7.8], ['building_home_B', 8.1],
  ['building_blacksmith', 7.6], ['building_home_A', 8], ['building_tower_A', 8.1], ['building_home_B', 8.1],
  ['building_lumbermill', 7.3], ['building_home_A', 8], ['building_barracks', 7.3], ['building_home_B', 8.1],
];
const TOWN_COLORS = ['red', 'blue', 'yellow', 'green'];

const AWNINGS = ['#e8413c', '#2f7de1', '#f2b81e', '#36b24a', '#9a5cd6', '#e8742c', '#2fb3b3', '#d94f8a', '#7a9c2f', '#c8372d'];

const cobbles = canvasTexture(256, 256, (g, w, h) => {
  g.fillStyle = '#8f8576'; g.fillRect(0, 0, w, h);
  let seed = 3;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let y = 0; y < h; y += 32) {
    for (let x = (y / 32) % 2 ? -16 : 0; x < w; x += 32) {
      const c = 150 + rnd() * 40;
      g.fillStyle = `rgb(${c},${c - 8},${c - 22})`;
      g.beginPath(); g.ellipse(x + 16, y + 16, 13 + rnd() * 2, 12 + rnd() * 2, rnd(), 0, 7); g.fill();
    }
  }
});
cobbles.wrapS = cobbles.wrapT = THREE.RepeatWrapping;
cobbles.repeat.set(48, 48); // (pavés de la même taille quelle que soit la taille du disque : 20 pour un rayon de 30)

function stripes(color: string): THREE.CanvasTexture {
  return canvasTexture(128, 64, (g, w, h) => {
    for (let x = 0; x < w; x += 32) { g.fillStyle = (x / 32) % 2 ? '#fbf1dc' : color; g.fillRect(x, 0, 32, h); }
    g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(0, h - 8, w, 8);
  });
}

function nameBoard(text: string): THREE.CanvasTexture {
  return canvasTexture(256, 64, (g, w, h) => {
    g.fillStyle = '#6b4426'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#3e2616'; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
    g.font = '38px "Lilita One", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#fbf1dc'; g.fillText(text, w / 2, h / 2 + 3, w - 20);
  });
}

const tmp = new THREE.Vector3();

interface StallView {
  group: THREE.Group; content: THREE.Group; board: THREE.Mesh; item: string;
  /** Matériaux propres à l'échoppe : ils deviennent transparents quand la caméra est dedans. */
  mats: THREE.Material[]; fade: number; edge: THREE.Object3D;
}

export class MarketArena implements GameView {
  readonly scene = new THREE.Scene();
  readonly world: World;
  readonly particles: Particles;
  readonly podium: PodiumView;
  readonly cameras = { training: 'thirdPerson', play: 'thirdPerson' } as const;
  /** Même caméra et mêmes déplacements que dans la taverne : à la 3e personne, à la souris. */
  readonly thirdPerson = true;
  readonly cameraRadius = CAMERA_RADIUS;
  /** Au départ, face à la marmite (la recette flotte au-dessus). */
  startYaw(x: number, z: number): number { return Math.atan2(-x, -z); }
  private stalls: StallView[] = [];
  private recipeGroup = new THREE.Group();
  private recipeKey = '';
  private soup!: THREE.Mesh;
  private fire!: THREE.PointLight;
  private lastEvent = -1;
  /** Message affiché quelques secondes (réussite, raté, ramassé…). */
  private flash: { text: string; cls: string; until: number } | null = null;
  // entraînement (avant le tirage du serveur) : échoppes et panier locaux
  private trainStalls: string[] = INGREDIENTS.map((i) => i.id);
  private trainCarry: string[] = [];

  private constructor(private kits: { restaurant: Kit; halloween: Kit; medieval: Kit; dungeon: Kit }) {
    this.world = { colliders: [], circles: [...MARKET_CIRCLES], bounds: MARKET.bounds };
    this.build();
    this.particles = new Particles(this.scene);
    this.podium = new PodiumView(this.scene, [0, 5.2], this.world, this.particles);
  }

  static async create(): Promise<MarketArena> {
    const [restaurant, halloween, medieval, dungeon] = await Promise.all([loadKit('restaurant'), loadKit('halloween'), loadKit('medieval'), loadKit('dungeon')]);
    return new MarketArena({ restaurant, halloween, medieval, dungeon });
  }

  /** Modèle d'un ingrédient (nouveau clone). */
  private ingredient(id: string): THREE.Object3D | null {
    const ing = INGREDIENT_BY_ID.get(id);
    if (!ing) return null;
    const kit = this.kits[ing.kit];
    return kit.has(ing.model) ? kit.create(ing.model) : null;
  }

  icon(id: string): string { return objectIcon(id, () => this.ingredient(id)); }

  /* ================= Décor ================= */

  private build(): void {
    const s = this.scene, { dungeon } = this.kits;
    s.background = canvasTexture(4, 256, (g, w, h) => {
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#7ec4ee'); grad.addColorStop(0.7, '#cfe8f4'); grad.addColorStop(1, '#f2e6c9');
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
    });
    s.fog = new THREE.Fog('#cfe2e8', 50, 150);
    s.add(new THREE.HemisphereLight('#fff6e0', '#6a7a4a', 1.9));
    const sun = new THREE.DirectionalLight('#fff3dc', 2);
    sun.position.set(-14, 34, 17);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -27, right: 27, top: 27, bottom: -27, near: 1, far: 90 });
    sun.shadow.bias = -0.0008;
    s.add(sun);

    // la place pavée, puis la terre battue au-delà des remparts
    const grass = new THREE.Mesh(new THREE.CircleGeometry(140, 48), new THREE.MeshToonMaterial({ color: '#8f8470', gradientMap }));
    grass.rotation.x = -Math.PI / 2; grass.receiveShadow = true;
    s.add(grass);
    const square = new THREE.Mesh(new THREE.CircleGeometry(STREET_RADIUS, 96), new THREE.MeshToonMaterial({ map: cobbles, gradientMap }));
    square.rotation.x = -Math.PI / 2; square.position.y = 0.01; square.receiveShadow = true;
    s.add(square);
    // bordure de la place (on ne va pas plus loin) : un petit muret de pierre
    const curb = new THREE.Mesh(new THREE.CylinderGeometry(WALK_RADIUS + 0.75, WALK_RADIUS + 0.75, 0.3, 96, 1, true), new THREE.MeshToonMaterial({ color: '#6e6457', gradientMap, side: THREE.DoubleSide }));
    curb.position.y = 0.15; curb.receiveShadow = true;
    s.add(curb);
    const curbTop = new THREE.Mesh(new THREE.RingGeometry(WALK_RADIUS + 0.45, WALK_RADIUS + 1.05, 96), new THREE.MeshToonMaterial({ color: '#857a6b', gradientMap }));
    curbTop.rotation.x = -Math.PI / 2; curbTop.position.y = 0.3;
    s.add(curbTop);

    this.buildCauldron();
    STALLS.forEach((st, i) => this.stalls.push(this.buildStall(st, i)));
    this.setStalls(this.trainStalls);
    s.add(this.recipeGroup);

    this.buildTown();
    // guirlandes de fanions entre les échoppes
    const flagColors = AWNINGS.map((c) => new THREE.MeshToonMaterial({ color: c, gradientMap, side: THREE.DoubleSide }));
    const rope = new THREE.LineBasicMaterial({ color: '#5a3a22' });
    const poleMat = new THREE.MeshToonMaterial({ color: '#5a3a22', gradientMap });
    STALLS.forEach((a, i) => {
      const b = STALLS[(i + 1) % STALLS.length];
      // tendues en hauteur, au-dessus de la caméra à la 3e personne
      const p0 = new THREE.Vector3(a.x * 1.05, GARLAND_Y, a.z * 1.05), p1 = new THREE.Vector3(b.x * 1.05, GARLAND_Y, b.z * 1.05);
      const mid = p0.clone().lerp(p1, 0.5).setY(GARLAND_Y - 0.6);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, GARLAND_Y + 0.2, 6), poleMat);
      pole.position.set(p0.x, (GARLAND_Y + 0.2) / 2, p0.z); pole.castShadow = true;
      s.add(pole);
      const curve = new THREE.QuadraticBezierCurve3(p0, mid, p1);
      s.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(12)), rope));
      for (let f = 1; f < 8; f++) {
        const flag = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 3), flagColors[(i + f) % flagColors.length]);
        flag.position.copy(curve.getPoint(f / 8)); flag.position.y -= 0.22; flag.rotation.x = Math.PI;
        s.add(flag);
      }
    });
    // quelques tonneaux et caisses près des échoppes
    STALLS.forEach((st, i) => {
      if (i % 2) return;
      const out = 1.18;
      dungeon.spawn(i % 4 ? 'barrel_small' : 'crates_stacked', { x: st.x * out + Math.cos(st.yaw) * 1.6, z: st.z * out - Math.sin(st.yaw) * 1.6, ry: i, scale: i % 4 ? 1 : 0.6, parent: s });
    });
  }

  /**
   * La ville tout autour, jusqu'à l'horizon : une couronne de grandes maisons dont les façades
   * bordent la place, des ruelles encombrées entre elles, puis deux rangs de toits et de tours de
   * plus en plus hauts, les remparts et le château. Pas un arbre : on est au cœur de la ville.
   */
  private buildTown(): void {
    const s = this.scene, { medieval, dungeon } = this.kits;
    const step = (Math.PI * 2) / TOWN.length, turn = 0.5 * step;
    TOWN.forEach(([model, scale], k) => {
      const name = `${model}_${TOWN_COLORS[k % 4]}`;
      if (!medieval.has(name)) return;
      const a = k * step + turn + Math.PI; // l'église au fond
      const depth = (medieval.info(name)?.size[2] ?? 1.2) * scale;
      const r = FACADES + depth / 2;
      medieval.spawn(name, { x: Math.sin(a) * r, z: Math.cos(a) * r, ry: a + Math.PI, scale, parent: s });
    });
    // ruelles entre les maisons : charrettes, tonneaux et caisses (on ne peut pas y aller)
    TOWN.forEach((_, k) => {
      const a = (k + 0.5) * step + turn + Math.PI, r = FACADES + 1.4;
      const x = Math.sin(a) * r, z = Math.cos(a) * r;
      if (k % 3 === 0) medieval.spawn('wheelbarrow', { x, z, ry: a + 1.2, scale: 3.4, parent: s });
      else if (k % 3 === 1) dungeon.spawn('barrel_large', { x, z, ry: k, parent: s });
      else dungeon.spawn('crates_stacked', { x, z, ry: a, scale: 0.8, parent: s });
      const a2 = a + 0.06 * (k % 2 ? 1 : -1), r2 = r + 2.4;
      dungeon.spawn(k % 2 ? 'barrel_small_stack' : 'box_stacked', { x: Math.sin(a2) * r2, z: Math.cos(a2) * r2, ry: k * 1.7, parent: s });
      if (k % 2 === 0) medieval.spawn('sack', { x: Math.sin(a - 0.05) * (r - 0.7), z: Math.cos(a - 0.05) * (r - 0.7), ry: k, scale: 3, parent: s });
    });
    // rangs de toits derrière, de plus en plus hauts : on ne voit que de la ville
    // (pas d'ombres si loin : la carte d'ombres du soleil ne va pas jusque-là)
    const ring = (models: string[], count: number, r0: number, rStep: number, scale: number, shift: number) => {
      for (let k = 0; k < count; k++) {
        const name = `${models[k % models.length]}_${TOWN_COLORS[(k + shift) % 4]}`;
        if (!medieval.has(name)) continue;
        const a = (k / count) * Math.PI * 2 + shift * 0.07, r = r0 + (k % 3) * rStep;
        medieval.spawn(name, { x: Math.sin(a) * r, z: Math.cos(a) * r, ry: a + Math.PI, scale: scale * (0.92 + (k % 4) * 0.05), parent: s, shadows: false });
      }
    };
    ring(['building_home_B', 'building_tower_B', 'building_home_A', 'building_tavern', 'building_windmill', 'building_home_B', 'building_church', 'building_market', 'building_home_A', 'building_watermill'], 22, 33, 2.5, 9.5, 2);
    ring(['building_tower_A', 'building_home_B', 'building_church', 'building_tower_B', 'building_barracks', 'building_home_B', 'building_archeryrange', 'building_tower_catapult'], 20, 50, 3, 11, 1);
    // les remparts ferment l'horizon, avec une tour toutes les trois sections
    const WALLS = 26, wallR = 68, wallScale = 9.5;
    for (let k = 0; k < WALLS; k++) {
      const a = (k / WALLS) * Math.PI * 2, x = Math.sin(a) * wallR, z = Math.cos(a) * wallR;
      // (le mur du kit court le long de x : on le tourne pour qu'il suive le cercle)
      medieval.spawn('wall_straight', { x, z, ry: a, scale: wallScale, parent: s, shadows: false });
      if (k % 3 === 0) medieval.spawn(`building_tower_base_${TOWN_COLORS[k % 4]}`, { x, z, ry: a + Math.PI, scale: wallScale * 1.1, parent: s, shadows: false });
    }
    // le château du roi domine la ville, derrière l'église
    medieval.spawn('building_castle_blue', { x: 0, z: -82, ry: 0, scale: 10, parent: s, shadows: false });
  }

  private buildCauldron(): void {
    const g = new THREE.Group();
    const iron = new THREE.MeshToonMaterial({ color: '#2c2a2e', gradientMap });
    const pts = [[0.2, 0], [1.05, 0.15], [1.42, 0.65], [1.45, 1.05], [1.32, 1.35], [1.42, 1.42]].map(([x, y]) => new THREE.Vector2(x, y));
    const pot = new THREE.Mesh(new THREE.LatheGeometry(pts, 28), iron);
    pot.position.y = 0.35; pot.castShadow = true;
    const edge = new THREE.Mesh(pot.geometry, OUTLINE); edge.scale.setScalar(1.035); pot.add(edge);
    g.add(pot);
    for (let k = 0; k < 3; k++) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.08, 0.5), iron);
      const a = (k / 3) * Math.PI * 2;
      leg.position.set(Math.sin(a) * 0.9, 0.25, Math.cos(a) * 0.9);
      g.add(leg);
    }
    this.soup = new THREE.Mesh(new THREE.CircleGeometry(1.3, 28), new THREE.MeshToonMaterial({ color: '#7cc04a', gradientMap, emissive: '#2a4a10' }));
    this.soup.rotation.x = -Math.PI / 2; this.soup.position.y = 1.55;
    g.add(this.soup);
    // feu de bois sous la marmite
    const wood = new THREE.MeshToonMaterial({ color: '#6b4426', gradientMap });
    for (let k = 0; k < 4; k++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1.6), wood);
      log.rotation.z = Math.PI / 2; log.rotation.y = (k / 4) * Math.PI; log.position.y = 0.12;
      g.add(log);
    }
    const flame = glow('#ffae42', 1.5, 0.8);
    flame.position.y = 0.4; g.add(flame);
    this.fire = new THREE.PointLight('#ff9a3c', 6, 8, 1.4);
    this.fire.position.y = 0.6; g.add(this.fire);
    this.scene.add(g);
  }

  private buildStall(st: { x: number; z: number; yaw: number }, i: number): StallView {
    const g = new THREE.Group();
    g.position.set(st.x, 0, st.z); g.rotation.y = st.yaw;
    const wood = new THREE.MeshToonMaterial({ color: '#8a5a32', gradientMap });
    const dark = new THREE.MeshToonMaterial({ color: shade('#8a5a32', -0.25), gradientMap });
    const counter = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1, 1.1), wood);
    counter.position.set(0, 0.5, 0.3); counter.castShadow = counter.receiveShadow = true;
    const cEdge = new THREE.Mesh(counter.geometry, OUTLINE); cEdge.scale.setScalar(1.03); counter.add(cEdge);
    g.add(counter);
    const top = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.1, 1.3), dark);
    top.position.set(0, 1.03, 0.3); g.add(top);
    for (const [px, pz] of [[-1.3, -0.4], [1.3, -0.4], [-1.3, 0.85], [1.3, 0.85]]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, pz > 0 ? 2.6 : 3.1), dark);
      post.position.set(px, pz > 0 ? 1.3 : 1.55, pz); g.add(post);
    }
    // auvent rayé, incliné vers l'avant
    // l'auvent ne couvre que l'arrière : vu d'en haut, on voit ce qui est sur le comptoir
    const awning = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.25), new THREE.MeshToonMaterial({ map: stripes(AWNINGS[i % AWNINGS.length]), gradientMap, side: THREE.DoubleSide }));
    awning.position.set(0, 2.95, -0.35); awning.rotation.x = -Math.PI / 2 - 0.35; awning.castShadow = true;
    g.add(awning);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.45), new THREE.MeshToonMaterial({ gradientMap }));
    board.position.set(0, 2.45, -0.38); board.rotation.x = -0.25;
    // grosse icône de l'ingrédient au-dessus de l'échoppe : lisible depuis la caméra en hauteur
    const sign = new THREE.Sprite(new THREE.SpriteMaterial({ depthWrite: false }));
    sign.scale.set(1.2, 1.2, 1); sign.position.set(0, 4.3, 0.6); sign.name = 'sign';
    g.add(sign);
    g.add(board);
    const content = new THREE.Group();
    content.position.set(0, 1.08, 0.3);
    g.add(content);
    this.scene.add(g);
    const mats = [wood, dark, awning.material, board.material as THREE.Material];
    for (const m of mats) m.transparent = true;
    return { group: g, content, board, item: '', mats, fade: 1, edge: cEdge };
  }

  /** Ce que vend chaque échoppe (change à chaque manche). */
  private setStalls(items: string[]): void {
    items.forEach((id, i) => {
      const v = this.stalls[i];
      if (!v || v.item === id) return;
      v.item = id;
      v.content.clear();
      const ing = INGREDIENT_BY_ID.get(id);
      if (!ing) return;
      const { restaurant } = this.kits;
      const crate = restaurant.create(ing.crate ?? 'crate');
      crate.scale.setScalar(0.62);
      v.content.add(crate);
      if (!ing.crate) for (let k = 0; k < 3; k++) {
        const extra = this.ingredient(id);
        if (extra) { extra.position.set((k - 1) * 0.42, 0.55, (k % 2) * 0.2 - 0.1); extra.scale.setScalar(0.8); v.content.add(extra); }
      }
      const hover = this.ingredient(id);
      if (hover) { hover.position.set(0, 1.15, 0.3); hover.name = 'hover'; v.content.add(hover); }
      const sign = v.group.getObjectByName('sign') as THREE.Sprite;
      const url = this.icon(id);
      if (url) new THREE.TextureLoader().load(url, (tex) => { tex.colorSpace = THREE.SRGBColorSpace; sign.material.map = tex; sign.material.needsUpdate = true; });
      (v.board.material as THREE.MeshToonMaterial).map = nameBoard(ing.name);
      (v.board.material as THREE.MeshToonMaterial).needsUpdate = true;
      this.particles?.burst(v.group.position.x * 0.8, 1.6, v.group.position.z * 0.8, '#fff3c2', 6, 0.8, 0.6);
    });
  }

  /** La recette flotte au-dessus de la marmite pendant qu'on peut la lire. */
  private showRecipe(recipe: string[] | null): void {
    const key = recipe?.join() ?? '';
    if (key === this.recipeKey) return;
    this.recipeKey = key;
    this.recipeGroup.clear();
    (recipe ?? []).forEach((id, k) => {
      const m = this.ingredient(id);
      if (!m) return;
      m.scale.setScalar(1.6);
      m.position.set((k - 1) * 2.2, 4.4, 0);
      this.recipeGroup.add(m);
      const halo = glow('#fff3c2', 2.6, 0.55);
      halo.position.copy(m.position);
      this.recipeGroup.add(halo);
    });
  }

  /* ================= Joueur local ================= */

  private market(f: Frame) { return f.mg.market; }
  private carry(f: Frame): string[] { return this.market(f)?.carry[f.myId] ?? (f.phase === 'rules' ? this.trainCarry : []); }

  startTraining(): void {
    this.trainCarry = [];
    const shuffled = [...this.trainStalls].sort(() => Math.random() - 0.5);
    this.setStalls(shuffled);
    this.trainStalls = shuffled;
  }
  stopTraining(): void { this.trainCarry = []; }

  onPhase(): void { /* rien de particulier : tout suit mg.market */ }

  beforeMove(f: Frame): void {
    f.me.speedMul = 1;
    const m = this.market(f);
    if (f.phase === 'mgPlay' && m && m.stage !== 'hunt') f.me.frozen = true; // on lit la recette
    if (f.phase === 'mgPlay' && m?.delivered.includes(f.myId)) f.me.frozen = false;
  }

  /** On ne sort pas de la place : la bordure arrête le joueur. */
  afterMove(f: Frame): string | null {
    const P = f.me.root.position, r = Math.hypot(P.x, P.z);
    if (r > WALK_RADIUS) { P.x *= WALK_RADIUS / r; P.z *= WALK_RADIUS / r; }
    return null;
  }

  onAct(f: Frame, special: boolean): boolean {
    const P = f.me.root.position, stall = stallInReach(P.x, P.z);
    if (f.phase === 'rules') {
      // entraînement : tout se passe ici, sans le serveur
      if (special) return false;
      if (stall >= 0) {
        const item = this.trainStalls[stall];
        if (!this.trainCarry.includes(item)) { this.trainCarry.push(item); if (this.trainCarry.length > MARKET.carry) this.trainCarry.shift(); }
        f.me.playPose('Interact', { speed: 1.6 });
        this.flashMsg(`${INGREDIENT_BY_ID.get(item)?.name} dans le panier`, '', f, 1.5);
        return true;
      }
      if (nearCauldron(P.x, P.z) && this.trainCarry.length) {
        this.trainCarry = [];
        this.particles.burst(0, 1.8, 0, '#9cff6a', 16, 1.2, 0.9);
        this.flashMsg('Plouf ! (en vrai, il faudra la bonne recette)', '', f, 2);
        return true;
      }
      return false;
    }
    const m = this.market(f);
    if (!m || m.stage !== 'hunt' || m.delivered.includes(f.myId)) return false;
    if (special) {
      if (!f.imposter || stall < 0) return false;
      f.net.action('transform');
      f.me.playPose('Interact', { speed: 1.6 });
      return true;
    }
    if (stall >= 0) { f.net.action('pick'); f.me.playPose('Interact', { speed: 1.6 }); return true; }
    if (nearCauldron(P.x, P.z) && this.carry(f).length) { f.net.action('deliver'); f.me.playPose('Interact', { speed: 1.2 }); return true; }
    return false;
  }

  applyTick(tick: MinigameTick, f: Frame): void {
    for (const [id, x, z, yaw, anim] of tick.bots) f.remotes.get(id)?.setTransform({ p: [x, 0, z], r: yaw, a: anim });
  }

  private flashMsg(text: string, cls: string, f: Frame, seconds = 2.2): void { this.flash = { text, cls, until: f.simTime + seconds }; }

  /** Réactions aux événements du serveur (livraisons, ramassages). */
  private onEvents(events: MarketEvent[], f: Frame): void {
    for (const e of events) {
      if (e.at <= this.lastEvent) continue;
      this.lastEvent = e.at;
      const mine = e.id === f.myId;
      const who = mine ? f.me.root : f.remotes.get(e.id)?.root;
      if (e.kind === 'ok') {
        this.particles.burst(0, 2, 0, '#ffd23f', 24, 1.6, 1.1);
        if (mine) this.flashMsg(`Délicieux ! +${e.points} points`, 'ok', f, 3);
      } else if (e.kind === 'fail') {
        this.particles.burst(0, 2, 0, '#4a3a2a', 18, 1.2, 1.4);
        if (mine) this.flashMsg('Beurk ! Mauvaise recette : ton panier est vidé', 'bad', f, 3);
      } else if (who) {
        // ramassé (ou transformé : pour les autres, c'est exactement pareil)
        this.particles.burst(who.position.x, 1.6, who.position.z, '#fff3c2', 6, 0.8, 0.6);
        if (mine) this.flashMsg(e.kind === 'magic' ? `Abracadabra : ${INGREDIENT_BY_ID.get(e.item ?? '')?.name} !` : `${INGREDIENT_BY_ID.get(e.item ?? '')?.name} dans le panier`, e.kind === 'magic' ? 'magic' : '', f, 1.6);
      }
    }
  }

  update(t: number, dt: number, f: Frame): void {
    this.particles.update(dt);
    this.podium.update(dt);
    const m = this.market(f);
    if (m) { this.setStalls(m.stalls); this.onEvents(m.events, f); }
    this.showRecipe(f.phase === 'mgPlay' && m && m.stage !== 'hunt' ? m.recipe : null);
    this.recipeGroup.children.forEach((c, k) => {
      c.position.y = 4.4 + Math.sin(t * 2 + k) * 0.15;
      if (!(c instanceof THREE.Sprite)) c.rotation.y = t * 0.8;
      c.visible = c.position.distanceTo(camera.position) > FADE_FAR; // trop près de la caméra : il cacherait tout
    });
    for (const v of this.stalls) {
      const h = v.content.getObjectByName('hover');
      if (h) {
        h.rotation.y = t * 0.9; h.position.y = 1.15 + Math.sin(t * 2 + v.group.position.x) * 0.06;
        h.visible = h.getWorldPosition(tmp).distanceTo(camera.position) > FADE_NEAR;
      }
      // la caméra traverse l'échoppe : elle devient transparente (on voit le joueur au travers)
      const P = v.group.position, inside = Math.hypot(camera.position.x - P.x, camera.position.z - P.z) < STALL_FADE;
      const want = inside ? 0.18 : 1;
      if (Math.abs(v.fade - want) > 0.01) {
        v.fade += (want - v.fade) * Math.min(1, dt * 10);
        for (const m of v.mats) { m.opacity = v.fade; m.depthWrite = v.fade > 0.95; }
        v.content.visible = v.edge.visible = v.fade > 0.5;
      }
      // à la 3e personne, la caméra passe parfois juste à côté des panneaux : ils s'effacent
      const sign = v.group.getObjectByName('sign') as THREE.Sprite | undefined;
      if (sign) {
        const d = sign.getWorldPosition(tmp).distanceTo(camera.position);
        sign.material.opacity = THREE.MathUtils.clamp((d - FADE_NEAR) / (FADE_FAR - FADE_NEAR), 0, 1);
        sign.visible = sign.material.opacity > 0.02;
      }
    }
    this.fire.intensity = 5 + Math.sin(t * 11) * 0.8 + Math.sin(t * 7.3) * 0.6;
    (this.soup.material as THREE.MeshToonMaterial).emissiveIntensity = 0.8 + Math.sin(t * 3) * 0.2;
    if (Math.random() < dt * 4) this.particles.burst((Math.random() - 0.5) * 1.6, 1.6, (Math.random() - 0.5) * 1.6, '#c8f5a0', 1, 0.2, 0.5);
  }

  /* ================= HUD ================= */

  hud(f: Frame): HudInfo {
    const m = this.market(f);
    const left = m ? Math.max(0, Math.ceil((m.stageEndsAt - f.playMs) / 1000)) : 0;
    const carry = this.carry(f);
    const P = f.me.root.position, stall = stallInReach(P.x, P.z);
    const slot = (id: string | undefined) => id
      ? `<span class="mk-slot"><img src="${this.icon(id)}" alt=""><small>${escapeHtml(INGREDIENT_BY_ID.get(id)?.name ?? '')}</small></span>`
      : '<span class="mk-slot empty"></span>';
    let extra = `<div class="mk-basket"><small>Ton panier</small><div>${[0, 1, 2].map((k) => slot(carry[k])).join('')}</div>${f.imposter && f.phase === 'mgPlay' ? '<p><span class="key">R</span> transformer un produit (1 fois par manche)</p>' : ''}</div>`;
    if (f.phase === 'mgPlay' && m && m.stage !== 'hunt' && m.recipe) {
      extra += `<div class="mk-recipe ${m.stage}"><small>${m.stage === 'show' ? 'Retiens la recette du roi !' : 'La recette était…'}</small><div>${m.recipe.map((id) => slot(id)).join('')}</div>${m.stage === 'show' ? `<b>${left}</b>` : ''}</div>`;
    }
    let status: HudInfo['status'] = null;
    if (this.flash && f.simTime < this.flash.until) status = { text: this.flash.text, cls: this.flash.cls === 'bad' ? 'cursed' : '' };
    else if (f.phase === 'mgPlay' && m) {
      if (m.stage === 'hunt' && m.delivered.includes(f.myId)) status = { text: 'Ta soupe est servie ! Attends les autres…' };
      else if (m.stage === 'hunt' && stall >= 0) status = { text: `E : prendre ${INGREDIENT_BY_ID.get(m.stalls[stall])?.name ?? ''}${f.imposter ? ' · R : transformer' : ''}` };
      else if (m.stage === 'hunt' && nearCauldron(P.x, P.z) && carry.length) status = { text: 'E : verser dans la marmite' };
      else if (m.stage === 'pause') status = { text: m.round >= MARKET.rounds ? 'Dernière manche terminée !' : 'Manche terminée !' };
    } else if (f.phase === 'rules' && stall >= 0) status = { text: `E : prendre ${INGREDIENT_BY_ID.get(this.trainStalls[stall])?.name ?? ''}` };
    return {
      boxes: [
        { label: 'Manche', value: `${m?.round ?? 1} / ${MARKET.rounds}` },
        { label: m?.stage === 'show' ? 'Recette' : m?.stage === 'hunt' ? 'Temps' : 'Suite', value: `${left} s`, cls: m?.stage === 'hunt' && left <= 8 ? 'caught' : 'sk' },
      ],
      chip: (id) => {
        const pts = m?.points[id] ?? 0, done = m?.delivered.indexOf(id) ?? -1;
        return { text: `${pts} pts${done >= 0 ? ` · servi ${done + 1}e` : ''}`, cls: done >= 0 ? 'done' : '' };
      },
      status,
      extra,
    };
  }

  exit(): void { this.trainCarry = []; }
}
