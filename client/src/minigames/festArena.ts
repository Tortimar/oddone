import * as THREE from 'three';
import {
  FEST, FEST_BOARDS, SLOT_COLORS, festBox, festBoxAt, festSortArg,
  type FestBoard, type FestBomb, type MinigameTick,
} from '@oddone/shared';
import { OUTLINE, camera, canvasTexture, gradientMap, part, shade } from '../engine/render.ts';
import { playSfx } from '../audio/audio.ts';
import { setCustomCamera } from '../game/cameraRig.ts';
import { glow } from '../world/outside.ts';
import type { World } from '../world/tavern.ts';
import { FLOAT_LOSS } from '../world/floatText.ts';
import { $ } from '../ui/dom.ts';
import { Particles, PodiumView } from './effects.ts';
import type { Frame, GameView, HudInfo } from './view.ts';

/**
 * L'arène du « Festival des Bombes » : quatre plateaux d'usine vus de dessus (l'écran coupé en
 * quatre), reliés par la machine au centre qui crache les bombes. Chaque plateau a une boîte par
 * couleur dans ses coins ; on trie ses bombes à la souris (cliquer, glisser, lâcher dans la boîte).
 * Sous chaque bombe, un anneau montre sa mèche (3 s) ; elle clignote à la fin. Les bombes d'une
 * boîte pleine volent jusqu'au plateau visé, et tout le monde voit tout.
 * Tout vient du serveur pendant la partie ; à l'entraînement, un plateau local.
 */

const BOMB_Y = 0.42;
const MACHINE = new THREE.Vector3(0, 3.2, 0);

const metal = canvasTexture(128, 128, (g, w, h) => {
  g.fillStyle = '#9aa0a8'; g.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 32) for (let x = 0; x < w; x += 32) {
    g.fillStyle = (x + y) % 64 ? '#a6acb4' : '#949aa2'; g.fillRect(x + 1, y + 1, 30, 30);
    g.fillStyle = '#7d838b'; for (const [dx, dy] of [[4, 4], [26, 4], [4, 26], [26, 26]]) { g.beginPath(); g.arc(x + dx, y + dy, 1.6, 0, 7); g.fill(); }
  }
});
metal.wrapS = metal.wrapT = THREE.RepeatWrapping;

/** Bordure jaune et noire d'une boîte, fond de sa couleur. */
function boxTexture(color: string): THREE.CanvasTexture {
  return canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = color; g.fillRect(0, 0, w, h);
    g.save(); g.beginPath(); g.rect(0, 0, w, h); g.rect(14, 14, w - 28, h - 28); g.clip('evenodd');
    for (let i = -h; i < w + h; i += 20) { g.fillStyle = (i / 20) % 2 ? '#1d120c' : '#f2c21e'; g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 10, 0); g.lineTo(i + 10 - h, h); g.lineTo(i - h, h); g.fill(); }
    g.restore();
    g.fillStyle = shade(color, 0.75); g.fillRect(14, 14, w - 28, 6);
  });
}

/** Une bombe à l'écran : boule de couleur, bouchon, mèche, étincelle, et l'anneau de la mèche au sol. */
interface BombView { root: THREE.Group; body: THREE.Mesh; mat: THREE.MeshToonMaterial; ring: THREE.Mesh; ringMat: THREE.MeshBasicMaterial; spark: THREE.Sprite; color: number; seen: number }

const bombGeo = new THREE.SphereGeometry(0.42, 16, 12);
const capGeo = new THREE.CylinderGeometry(0.14, 0.16, 0.14, 10);
const fuseGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.26, 6);
const ringGeo = new THREE.RingGeometry(0.55, 0.68, 32);
const capMat = new THREE.MeshToonMaterial({ color: '#5d636c', gradientMap });
const fuseMat = new THREE.MeshToonMaterial({ color: '#d9c49a', gradientMap });

function makeBomb(): BombView {
  const root = new THREE.Group();
  const mat = new THREE.MeshToonMaterial({ color: '#fff', gradientMap, emissive: '#ff2a1a', emissiveIntensity: 0 });
  const body = new THREE.Mesh(bombGeo, mat); body.castShadow = true;
  const edge = new THREE.Mesh(bombGeo, OUTLINE); edge.scale.setScalar(1.05); body.add(edge);
  const cap = new THREE.Mesh(capGeo, capMat); cap.position.y = 0.44;
  const fuse = new THREE.Mesh(fuseGeo, fuseMat); fuse.position.set(0.05, 0.6, 0); fuse.rotation.z = -0.4;
  const spark = glow('#ffcf5a', 0.4, 0.95); spark.position.set(0.11, 0.75, 0);
  body.add(cap, fuse, spark);
  const ringMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false });
  const ring = new THREE.Mesh(ringGeo, ringMat); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.06;
  root.add(body, ring);
  return { root, body, mat, ring, ringMat, spark, color: -1, seen: 0 };
}

/** Le compte d'une boîte (« 3 / 10 »), redessiné quand il change. */
interface BoxLabel { tex: THREE.CanvasTexture; ctx: CanvasRenderingContext2D; count: number }

function drawLabel(l: BoxLabel, n: number): void {
  const g = l.ctx, w = g.canvas.width, h = g.canvas.height;
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(26,15,10,.8)'; g.beginPath(); g.roundRect(6, 4, w - 12, h - 8, 14); g.fill();
  g.font = '30px "Lilita One", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = n >= FEST.capacity - 2 ? '#ffd23f' : '#fbf1dc'; g.fillText(`${n} / ${FEST.capacity}`, w / 2, h / 2 + 2);
  l.count = n; l.tex.needsUpdate = true;
}

export class FestArena implements GameView {
  readonly scene = new THREE.Scene();
  readonly world: World;
  readonly particles: Particles;
  readonly podium: PodiumView;
  readonly cameras = { training: 'custom', play: 'custom' } as const;
  private bombs = new Map<string, BombView>();
  private labels = new Map<string, BoxLabel>();
  private shades = new Map<number, THREE.Mesh>();
  private mineDrawn = false;
  private machine = new THREE.Group();
  private camPos = new THREE.Vector3();
  private camTarget = new THREE.Vector3();
  private flash: { text: string; until: number; cls?: string } | null = null;
  private seenBooms = new Set<string>();
  // glisser-déposer (souris)
  private frame: Frame | null = null;
  private drag: { key: string; id: number; color: number; home: THREE.Vector3 } | null = null;
  /** Bombes lâchées dans une boîte, en attente de la réponse du serveur (clé → heure). */
  private pending = new Map<string, number>();
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BOMB_Y);
  private hit = new THREE.Vector3();
  private onDown = (e: PointerEvent) => this.pointerDown(e);
  private onMove = (e: PointerEvent) => this.pointerMove(e);
  private onUp = (e: PointerEvent) => this.pointerUp(e);
  // entraînement : son plateau à soi, une machine locale
  private train: { board: FestBoard; nextSpawn: number; nextId: number } | null = null;
  private get time(): number { return performance.now() / 1000; }

  private constructor() {
    this.world = { colliders: [], circles: [], bounds: { halfX: 30, halfZ: 30 } };
    this.build();
    this.particles = new Particles(this.scene);
    this.podium = new PodiumView(this.scene, [...FEST.podium], this.world, this.particles);
    window.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
  }

  static async create(): Promise<FestArena> { return new FestArena(); }

  /** Les héros, au bord de leur plateau, regardent vers lui. */
  startYaw(x: number): number { return x < 0 ? Math.PI / 2 : -Math.PI / 2; }

  /* ================= Décor ================= */

  private build(): void {
    const s = this.scene;
    s.background = new THREE.Color('#1c1a22');
    s.add(new THREE.HemisphereLight('#f2f0ff', '#3a3440', 2));
    const sun = new THREE.DirectionalLight('#ffffff', 1.4);
    sun.position.set(-6, 30, 10); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 16, bottom: -16, near: 1, far: 60 });
    s.add(sun);
    // le sol de l'usine
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 60), new THREE.MeshToonMaterial({ color: '#4a4652', gradientMap }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    s.add(floor);
    // les quatre plateaux et leurs boîtes
    FEST_BOARDS.forEach(([cx, cz], slot) => {
      const tex = metal.clone(); tex.repeat.set(FEST.boardW / 2, FEST.boardD / 2); tex.needsUpdate = true;
      const plate = new THREE.Mesh(new THREE.BoxGeometry(FEST.boardW, 0.2, FEST.boardD), new THREE.MeshToonMaterial({ map: tex, gradientMap }));
      plate.position.set(cx, -0.08, cz); plate.receiveShadow = true;
      s.add(plate);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(FEST.boardW + 0.5, 0.18, FEST.boardD + 0.5), new THREE.MeshToonMaterial({ color: shade(SLOT_COLORS[slot], 0.6), gradientMap }));
      frame.position.set(cx, -0.14, cz);
      s.add(frame);
      for (let color = 0; color < 4; color++) {
        const [bx, bz] = festBox(slot, color);
        const pad = new THREE.Mesh(new THREE.PlaneGeometry(FEST.box, FEST.box), new THREE.MeshToonMaterial({ map: boxTexture(SLOT_COLORS[color]), gradientMap }));
        pad.rotation.x = -Math.PI / 2; pad.position.set(bx, 0.03, bz); pad.receiveShadow = true;
        s.add(pad);
        // le compte (« 3 / 10 ») sur le bord de la boîte
        const cv = document.createElement('canvas'); cv.width = 128; cv.height = 48;
        const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
        const label: BoxLabel = { tex, ctx: cv.getContext('2d')!, count: -1 };
        drawLabel(label, 0);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: label.tex, depthWrite: false }));
        sprite.scale.set(1.9, 0.72, 1); sprite.position.set(bx, 1.4, bz);
        s.add(sprite);
        this.labels.set(`${slot}:${color}`, label);
      }
      // un voile sombre quand le plateau a sauté
      const veil = new THREE.Mesh(new THREE.PlaneGeometry(FEST.boardW, FEST.boardD), new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0, depthWrite: false }));
      veil.rotation.x = -Math.PI / 2; veil.position.set(cx, 1.5, cz);
      s.add(veil);
      this.shades.set(slot, veil);
    });
    this.buildMachine();
  }

  /** La machine au centre : une cuve, un dôme, quatre tuyaux vers les plateaux, des voyants. */
  private buildMachine(): void {
    const g = this.machine;
    this.scene.add(g);
    part(g, new THREE.CylinderGeometry(1.7, 2.1, 2.4, 20), '#6f7682', { outline: true }).position.y = 1.2;
    part(g, new THREE.SphereGeometry(1.5, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), '#e8413c', { outline: true }).position.y = 2.4;
    part(g, new THREE.CylinderGeometry(0.5, 0.6, 0.6, 12), '#3d424a', { outline: true }).position.y = 3.9;
    FEST_BOARDS.forEach(([cx, cz], slot) => {
      const dir = new THREE.Vector3(cx, 0, cz).normalize(), len = Math.hypot(cx, cz) - FEST.boardW / 2 - 0.5;
      const pipe = part(g, new THREE.CylinderGeometry(0.32, 0.32, len, 10), '#8a919c', { outline: true });
      pipe.position.set(dir.x * (len / 2 + 1.2), 1.1, dir.z * (len / 2 + 1.2));
      // (couché le long de z, puis tourné vers son plateau)
      pipe.rotation.order = 'YXZ'; pipe.rotation.set(Math.PI / 2, Math.atan2(dir.x, dir.z), 0);
      const lamp = glow(SLOT_COLORS[slot], 1.1, 0.9); lamp.position.set(dir.x * 1.9, 2.2, dir.z * 1.9); g.add(lamp);
    });
  }

  /* ================= Bombes ================= */

  /** Plateaux à montrer : ceux du serveur pendant la partie, le sien à l'entraînement. */
  private boards(f: Frame): Record<string, FestBoard> {
    if (f.phase === 'rules') return this.train ? { [f.myId]: this.train.board } : {};
    return f.mg.fest?.boards ?? {};
  }
  private colors(f: Frame): number[] {
    return f.phase === 'rules' ? [...new Set(f.state.players.map((p) => p.slot % 4))].sort() : f.mg.fest?.colors ?? [];
  }
  /** Horloge des bombes (ms) : celle de la partie, ou l'horloge murale à l'entraînement. */
  private clock(f: Frame): number { return f.phase === 'rules' ? performance.now() : f.playMs; }
  private slotOf(f: Frame, id: string): number { return (f.state.players.find((p) => p.id === id)?.slot ?? 0) % 4; }

  /** D'où part une bombe : la machine, ou la boîte de sa couleur sur le plateau de l'envoyeur. */
  private origin(b: FestBomb, out: THREE.Vector3): THREE.Vector3 {
    if (b.from < 0) return out.copy(MACHINE);
    const [x, z] = festBox(b.from, b.color);
    return out.set(x, 1, z);
  }

  private syncBombs(f: Frame, t: number): void {
    const now = this.clock(f), seen = new Set<string>(), tmp = new THREE.Vector3();
    for (const [id, board] of Object.entries(this.boards(f))) {
      for (const b of board.bombs) {
        const key = `${id}:${b.id}`;
        seen.add(key);
        if (this.pending.has(key)) continue; // lâchée dans une boîte : on attend le serveur
        let v = this.bombs.get(key);
        if (!v) { v = makeBomb(); this.bombs.set(key, v); this.scene.add(v.root); }
        if (v.color !== b.color) { v.color = b.color; v.mat.color.set(SLOT_COLORS[b.color]); }
        v.root.visible = true;
        const k = (now - (b.at - FEST.flightMs)) / FEST.flightMs;
        if (k < 0) { v.root.visible = false; continue; }
        if (this.drag?.key === key) { v.ring.visible = false; continue; }
        if (k < 1) {
          // en vol : un arc de la machine (ou de la boîte de l'envoyeur) jusqu'au plateau
          this.origin(b, tmp);
          v.root.position.set(tmp.x + (b.x - tmp.x) * k, tmp.y * (1 - k) + Math.sin(k * Math.PI) * 4.5, tmp.z + (b.z - tmp.z) * k);
          v.ring.visible = false;
        } else {
          if (!v.seen) { v.seen = 1; this.particles.burst(b.x, 0.3, b.z, '#d9d4c8', 4, 0.8, 0.5); }
          v.root.position.set(b.x, 0, b.z);
          v.ring.visible = true;
          const left = Math.max(0, 1 - (now - b.at) / FEST.fuseMs);
          v.ring.scale.setScalar(0.4 + left * 0.6);
          v.ringMat.color.setRGB(1, 0.3 + left * 0.7, 0.25 + left * 0.75);
          v.mat.emissiveIntensity = left < 0.34 ? (Math.sin(t * 24) > 0 ? 1.1 : 0) : 0;
        }
        v.body.position.y = BOMB_Y + (v.ring.visible ? Math.abs(Math.sin(t * 5 + b.id)) * 0.05 : 0);
        v.spark.scale.setScalar(0.32 + Math.random() * 0.14);
      }
    }
    // les bombes triées (ou qui ont sauté) disparaissent
    for (const [key, v] of this.bombs) {
      if (seen.has(key) && !this.pending.has(key)) continue;
      if (this.pending.has(key) && seen.has(key) && performance.now() - this.pending.get(key)! > 700) {
        this.pending.delete(key); // refusée par le serveur : elle revient
        this.flash = { text: 'Mauvaise boîte !', until: this.time + 1, cls: 'caught' };
        continue;
      }
      if (seen.has(key)) continue;
      v.root.removeFromParent(); this.bombs.delete(key); this.pending.delete(key);
    }
  }

  /** Comptes des boîtes, voiles des plateaux qui ont sauté, explosions. */
  private syncBoards(f: Frame): void {
    for (const [id, board] of Object.entries(this.boards(f))) {
      const slot = this.slotOf(f, id);
      board.boxes.forEach((n, color) => {
        const l = this.labels.get(`${slot}:${color}`);
        if (!l || l.count === n) return;
        if (n < l.count && l.count >= FEST.capacity - 1) {
          const [bx, bz] = festBox(slot, color);
          this.particles.burst(bx, 1, bz, SLOT_COLORS[color], 18, 1.4, 0.8);
          if (id === f.myId) { this.flash = { text: 'Boîte pleine : envoyée !', until: this.time + 1.4 }; playSfx('annonce', { volume: 0.8 }); }
        }
        drawLabel(l, n);
      });
    }
    const fest = f.mg.fest;
    if (f.phase !== 'mgPlay' || !fest) return;
    for (const b of fest.booms) {
      if (this.seenBooms.has(b.id)) continue;
      this.seenBooms.add(b.id);
      const [cx, cz] = FEST_BOARDS[this.slotOf(f, b.id)];
      for (const [c, n, sp, sz] of [['#ffcf5a', 30, 4, 1.6], ['#ff6a1a', 24, 3.4, 2], ['#5b4f48', 18, 2.4, 2.6]] as const) this.particles.burst(cx, 1, cz, c, n, sp, sz);
      this.podium.shake = 0.8;
      playSfx('erreur', { volume: b.id === f.myId ? 1.5 : 0.8, duck: 1 });
      f.float(b.id, 'BOUM !', FLOAT_LOSS);
      if (b.id === f.myId) { f.me.playPose('Death_A', { hold: true }); this.flash = { text: 'Boum ! Ton plateau a sauté…', until: this.time + 3, cls: 'caught' }; }
    }
    for (const [slot, veil] of this.shades) {
      const id = f.state.players.find((p) => p.slot % 4 === slot)?.id;
      const target = id && fest.out.includes(id) ? 0.55 : 0;
      const m = veil.material as THREE.MeshBasicMaterial;
      m.opacity += (target - m.opacity) * 0.1;
    }
  }

  /* ================= Souris ================= */

  /** Rectangle de l'image où l'on dessine (le cadre d'entraînement sur l'écran des règles). */
  private viewRect(): DOMRect | { left: number; top: number; width: number; height: number } {
    return this.frame?.phase === 'rules' ? $('rsFrame').getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
  }

  private toWorld(e: PointerEvent): THREE.Vector3 | null {
    const r = this.viewRect();
    const x = ((e.clientX - r.left) / r.width) * 2 - 1, y = -((e.clientY - r.top) / r.height) * 2 + 1;
    if (Math.abs(x) > 1 || Math.abs(y) > 1) return null;
    this.ray.setFromCamera(new THREE.Vector2(x, y), camera);
    return this.ray.ray.intersectPlane(this.plane, this.hit);
  }

  private canSort(f: Frame): boolean {
    if (f.phase === 'rules') return !!this.train;
    return f.phase === 'mgPlay' && !!f.mg.fest && !f.mg.fest.out.includes(f.myId);
  }

  private pointerDown(e: PointerEvent): void {
    const f = this.frame;
    if (!f || e.button !== 0 || !this.canSort(f)) return;
    const p = this.toWorld(e);
    if (!p) return;
    const board = this.boards(f)[f.myId], now = this.clock(f);
    if (!board) return;
    let best: FestBomb | null = null, bestD = 1.1;
    for (const b of board.bombs) {
      if (now < b.at || this.pending.has(`${f.myId}:${b.id}`)) continue;
      const d = Math.hypot(b.x - p.x, b.z - p.z);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (!best) return;
    this.drag = { key: `${f.myId}:${best.id}`, id: best.id, color: best.color, home: new THREE.Vector3(best.x, 0, best.z) };
    document.body.style.cursor = 'grabbing';
    e.preventDefault();
  }

  private pointerMove(e: PointerEvent): void {
    if (!this.drag) return;
    const p = this.toWorld(e), v = this.bombs.get(this.drag.key);
    if (p && v) v.root.position.set(p.x, 0.9, p.z);
  }

  private pointerUp(e: PointerEvent): void {
    const f = this.frame, d = this.drag;
    if (!d) return;
    this.drag = null;
    document.body.style.cursor = '';
    if (!f) return;
    const p = this.toWorld(e), mySlot = this.slotOf(f, f.myId);
    const box = p ? festBoxAt(mySlot, this.colors(f), p.x, p.z) : -1;
    const v = this.bombs.get(d.key);
    if (box < 0) { v?.root.position.copy(d.home); return; } // lâchée ailleurs : elle reste sur le plateau
    // la bonne boîte (ou n'importe laquelle, pour l'imposteur, avec une bombe de sa couleur)
    const ok = box === d.color || (f.imposter && f.phase === 'mgPlay' && d.color === mySlot);
    if (!ok) {
      v?.root.position.copy(d.home);
      this.flash = { text: 'Mauvaise boîte !', until: this.time + 1, cls: 'caught' };
      playSfx('erreur', { volume: 0.6 });
      return;
    }
    const [bx, bz] = festBox(mySlot, box);
    this.particles.burst(bx, 0.8, bz, SLOT_COLORS[box], 6, 0.6, 0.5);
    playSfx('prendre', { volume: 0.7 });
    if (v) { if (box !== d.color) { v.mat.color.set(SLOT_COLORS[box]); v.color = box; } v.root.visible = false; }
    if (f.phase === 'rules') { this.trainSort(d.id, box); return; }
    this.pending.set(d.key, performance.now());
    f.net.action('sort', festSortArg(d.id, box));
  }

  /* ================= Entraînement ================= */

  startTraining(): void {
    this.train = { board: { bombs: [], boxes: [0, 0, 0, 0], sorted: 0 }, nextSpawn: performance.now() + 800, nextId: 1 };
  }

  stopTraining(): void { this.train = null; }

  private trainSort(id: number, box: number): void {
    const b = this.train?.board;
    if (!b) return;
    b.bombs = b.bombs.filter((x) => x.id !== id);
    b.sorted += 1; b.boxes[box] += 1;
    if (b.boxes[box] >= FEST.capacity) b.boxes[box] = 0;
  }

  private updateTraining(f: Frame): string | null {
    const tr = this.train, now = performance.now();
    if (!tr) return null;
    const [cx, cz] = FEST_BOARDS[this.slotOf(f, f.myId)], colors = this.colors(f);
    if (now >= tr.nextSpawn) {
      tr.nextSpawn = now + 1400;
      tr.board.bombs.push({ id: tr.nextId++, color: colors[Math.floor(Math.random() * colors.length)], at: now + FEST.flightMs, x: cx + (Math.random() * 2 - 1) * FEST.landHX, z: cz + (Math.random() * 2 - 1) * FEST.landHZ, from: -1 });
    }
    if (tr.board.bombs.some((b) => now >= b.at + FEST.fuseMs)) {
      this.particles.burst(cx, 1, cz, '#ff6a1a', 24, 3, 1.6);
      playSfx('erreur');
      tr.board.bombs = [];
      return 'Boum ! (pour de faux : on continue)';
    }
    return null;
  }

  /* ================= Partie ================= */

  onPhase(f: Frame): void {
    if (f.phase === 'mgPlay') this.stopTraining();
    if (f.phase === 'mgResults') {
      this.machine.visible = false; // le podium tombe à sa place
      for (const v of this.bombs.values()) v.root.removeFromParent();
      this.bombs.clear();
      f.me.clearPose();
    }
  }

  beforeMove(f: Frame): void { f.me.frozen = true; this.frame = f; }
  afterMove(f: Frame): string | null { return f.phase === 'rules' ? this.updateTraining(f) : null; }

  applyTick(tick: MinigameTick, f: Frame): void {
    for (const [id, x, z, yaw, anim] of tick.bots) f.remotes.get(id)?.setTransform({ p: [x, 0, z], r: yaw, a: anim });
  }

  update(t: number, _dt: number, f: Frame): void {
    this.frame = f;
    this.particles.update(_dt);
    this.podium.update(_dt);
    this.machine.rotation.y = Math.sin(t * 0.6) * 0.05;
    if (f.phase === 'mgResults') return;
    this.syncBombs(f, t);
    this.syncBoards(f);
    // mon plateau : un liseré de ma couleur autour
    if (!this.mineDrawn) {
      this.mineDrawn = true;
      const slot = this.slotOf(f, f.myId), [cx, cz] = FEST_BOARDS[slot];
      const rim = new THREE.Mesh(new THREE.BoxGeometry(FEST.boardW + 1.1, 0.12, FEST.boardD + 1.1), new THREE.MeshBasicMaterial({ color: SLOT_COLORS[slot] }));
      rim.position.set(cx, -0.2, cz);
      this.scene.add(rim);
    }
    this.aimCamera(f);
  }

  /** Vue de dessus sur les quatre plateaux ; à l'entraînement, sur le sien. */
  private aimCamera(f: Frame): void {
    if (f.phase === 'rules') {
      const [cx, cz] = FEST_BOARDS[this.slotOf(f, f.myId)];
      this.camPos.set(cx, 15, cz + 6); this.camTarget.set(cx, 0, cz + 0.4);
      setCustomCamera(this.camPos, this.camTarget, 50, Infinity);
      return;
    }
    const aspect = camera.aspect, need = Math.max(14.5, 21 / aspect); // tout doit tenir, même en portrait
    const h = need / Math.tan(THREE.MathUtils.degToRad(25));
    this.camPos.set(0, h, h * 0.16); this.camTarget.set(0, 0, 0.6);
    setCustomCamera(this.camPos, this.camTarget, 50, Infinity);
  }

  /* ================= HUD ================= */

  hud(f: Frame): HudInfo {
    const fest = f.mg.fest, mine = f.phase === 'rules' ? this.train?.board : fest?.boards[f.myId];
    const out = !!fest?.out.includes(f.myId);
    let status: HudInfo['status'] = null;
    if (this.flash && this.time < this.flash.until) status = { text: this.flash.text, cls: this.flash.cls };
    else if (out) status = { text: 'Ton plateau a sauté… regarde les autres.' };
    else if (f.phase === 'rules' || f.playMs < 5000) status = { text: 'Clique sur une bombe, glisse-la dans la boîte de sa couleur, lâche !' };
    return {
      boxes: [
        { label: 'Bombes triées', value: String(mine?.sorted ?? 0), cls: 'sk' },
        { label: 'Temps', value: `${Math.floor(f.playMs / 1000)} s` },
      ],
      chip: (id) => {
        if (!fest) return { text: '' };
        if (fest.out.includes(id)) return { text: 'Explosé', cls: 'fall' };
        return { text: `${fest.boards[id]?.sorted ?? 0} triées` };
      },
      status,
    };
  }

  exit(): void {
    window.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    document.body.style.cursor = '';
    this.stopTraining();
  }
}
