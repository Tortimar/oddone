import * as THREE from 'three';
import { SLOT_COLORS, finaleRevealAt, type PodiumStep, type RoomState } from '@oddone/shared';
import { camera, canvasTexture, damp, gradientMap } from '../engine/render.ts';
import { setCustomCamera } from '../game/cameraRig.ts';
import { Particles, podiumBlock } from '../minigames/effects.ts';
import { $, escapeHtml } from '../ui/dom.ts';
import type { World } from './tavern.ts';

/**
 * Le grand podium de fin de soirée (phase `finale`), au milieu de la taverne, face à la porte :
 * il tombe du plafond, puis chaque joueur quitte son tabouret pour apparaître sur sa marche, de la
 * dernière place à la première (`game.final`, programme de `finaleRevealAt`), avec sa pile de
 * pièces d'or et sa plaque (place, nom, pièces). Confettis pour le vainqueur.
 * Tout est calé sur l'horloge du serveur : chez tout le monde, les mêmes apparitions en même temps.
 */

export type FinaleMood = 'win' | 'ok' | 'last';

export interface FinaleHooks {
  /** Position du joueur (là où il est avant d'apparaître sur sa marche), null s'il est parti. */
  where(id: string): THREE.Vector3 | null;
  /** Le joueur apparaît sur sa marche, face à la porte. */
  place(id: string, x: number, y: number, z: number, mood: FinaleMood): void;
  sound(kind: 'land' | 'reveal' | 'winner'): void;
  /** Fin de la cérémonie : le podium disparaît, chacun reprend la main. */
  done(): void;
}

/** Centre du podium (z), largeur et profondeur d'une marche. */
const Z = 2.6, STEP = 1.6;
/** Marches dans l'ordre du classement : 2e à gauche du 1er, 3e et 4e à sa droite, en escalier. */
const HEIGHTS = [1.6, 1.25, 0.95, 0.65], OFFSETS = [-0.8, -2.4, 0.8, 2.4];
/** Chute du podium (s depuis le début de la phase) et hauteur de départ (sous le plafond). */
const FALL_AT = 0.35, FALL = 0.8, DROP = 6;
/** Hauteur de la plaque au-dessus des pieds. */
const PLAQUE = 2.95;
const CONFETTI = 150, CONFETTI_COLORS = ['#f2b81e', '#e8413c', '#2f7de1', '#4fae5a', '#fff8e6', '#b45cff'];

const coinEdges = canvasTexture(8, 16, (g, w, h) => {
  g.fillStyle = '#ffcf3a'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#b97d0e'; g.fillRect(0, h - 4, w, 4);
});

interface Spot { id: string; i: number; x: number; y: number; z: number; at: number; mood: FinaleMood; pile: THREE.Mesh | null; pileH: number; el: HTMLElement }

export class FinaleShow {
  private podium = new THREE.Group();
  private particles: Particles;
  private light = new THREE.PointLight('#ffe2a8', 0, 13, 1.4);
  private confetti: THREE.InstancedMesh;
  private bits: { x: number; y: number; z: number; vy: number; spin: number; a: number; sway: number }[] = [];
  private key = '';
  private steps: PodiumStep[] = [];
  private spots: Spot[] = [];
  private shown = new Set<string>();
  private landed = false;
  private party = false;
  /** Marche que la caméra regarde (x), et gros plan sur le vainqueur (0..1). */
  private focus = 0; private focusX = 0; private zoom = 0; private zoomK = 0;
  private float = $('finaleFloat');
  private tmp = new THREE.Vector3(); private camPos = new THREE.Vector3(); private camTarget = new THREE.Vector3();
  private dummy = new THREE.Object3D();

  constructor(private scene: THREE.Scene, private world: World) {
    this.particles = new Particles(scene);
    this.podium.visible = false;
    // (toujours dans la scène, éteinte : allumer une lumière de plus recompilerait tous les matériaux)
    this.light.position.set(0, 4.8, Z + 2.4);
    this.confetti = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.13, 0.2), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), CONFETTI);
    this.confetti.frustumCulled = false; this.confetti.visible = false;
    const c = new THREE.Color();
    for (let i = 0; i < CONFETTI; i++) {
      this.confetti.setColorAt(i, c.set(CONFETTI_COLORS[i % CONFETTI_COLORS.length]));
      this.bits.push({ x: 0, y: 0, z: 0, vy: 0, spin: 0, a: 0, sway: 0 });
    }
    scene.add(this.podium, this.light, this.confetti);
  }

  get active(): boolean { return this.key !== ''; }

  /** Donne à la caméra `custom` son cadre : tout le podium, un peu tourné vers la marche annoncée. */
  aim(): void {
    const fov = Math.min(100, THREE.MathUtils.radToDeg(2 * Math.atan(Math.max(Math.tan(THREE.MathUtils.degToRad(29)), 0.95 / camera.aspect))));
    const k = this.zoomK;
    // (à hauteur d'homme, un peu en contre-plongée : le bas de l'écran reste à la bulle du tavernier)
    this.camPos.set(this.focusX * 0.15, 2.7 - k * 0.2, 7.4 - k * 0.3);
    this.camTarget.set(this.focusX * (0.3 + k * 0.4), 2.3 + k * 0.2, Z);
    setCustomCamera(this.camPos, this.camTarget, fov, 3);
  }

  update(s: RoomState | null, now: number, dt: number, h: FinaleHooks): void {
    this.particles.update(dt);
    const on = !!s && s.phase === 'finale' && !!s.game.final && s.phaseStartedAt !== null;
    const key = on ? `${s!.code}|${s!.phaseStartedAt}` : '';
    if (key !== this.key) {
      if (this.key) this.end(h);
      this.key = key;
      if (on) this.begin(s!);
    }
    if (!on || !s) return;
    const ms = now - s.phaseStartedAt!, since = ms / 1000;

    // le podium tombe du plafond
    const k = Math.min(1, Math.max(0, (since - FALL_AT) / FALL));
    this.podium.visible = since >= FALL_AT;
    this.podium.position.y = DROP * (1 - k * k);
    if (k >= 1 && !this.landed) {
      this.landed = true;
      h.sound('land');
      for (const st of this.steps) this.particles.burst(this.podium.position.x + st.x, 0.2, Z + st.d / 2 + 0.3, '#d9c7a8', 6, 2, 1.1);
      const gx = this.podium.position.x;
      this.world.steps = this.steps.map((st) => ({ x0: gx + st.x - st.w / 2, x1: gx + st.x + st.w / 2, z0: Z + st.z - st.d / 2, z1: Z + st.z + st.d / 2, top: st.h }));
    }
    const after = since - FALL_AT - FALL;
    const squash = after > 0 && after < 0.5 ? Math.sin(after * Math.PI * 4) * Math.exp(-after * 6) * 0.1 : 0;
    this.podium.scale.set(1 + squash, 1 - squash, 1 + squash);
    this.light.intensity = damp(this.light.intensity, 4, 3, dt);

    // les places, de la dernière à la première
    for (const sp of this.spots) {
      if (ms < sp.at || this.shown.has(sp.id)) continue;
      this.shown.add(sp.id);
      const color = SLOT_COLORS[(s.players.find((p) => p.id === sp.id)?.slot ?? 0) % 4];
      const from = h.where(sp.id);
      if (!from) continue; // parti pendant la cérémonie : sa marche reste vide
      this.particles.burst(from.x, from.y + 1.2, from.z, color, 10, 1, 0.8);
      h.place(sp.id, sp.x, sp.y, sp.z, sp.mood);
      this.particles.burst(sp.x, sp.y + 1.1, sp.z, color, 18, 1.3, 1);
      sp.el.hidden = false;
      this.focus = sp.x;
      if (sp.i === 0) { this.party = true; this.zoom = 1; this.startConfetti(); h.sound('winner'); }
      else h.sound('reveal');
    }
    // gros plan sur le vainqueur, puis retour au plan large
    if (this.party && ms > this.spots[0].at + 3200) { this.zoom = 0; this.focus = 0; }
    this.focusX = damp(this.focusX, this.focus, 2.5, dt);
    this.zoomK = damp(this.zoomK, this.zoom, 2, dt);
    this.aim();

    // piles de pièces qui montent, plaques au-dessus des têtes
    for (const sp of this.spots) {
      if (!this.shown.has(sp.id) || sp.el.hidden) continue;
      if (sp.pile) {
        const grow = Math.min(1, Math.max(0.001, (ms - sp.at - 250) / 700)), e = 1 - (1 - grow) ** 3;
        sp.pile.visible = ms >= sp.at + 250;
        sp.pile.scale.y = sp.pileH * e;
        sp.pile.position.y = sp.y + (sp.pileH * e) / 2;
      }
      this.tmp.set(sp.x, sp.y + PLAQUE, sp.z).project(camera);
      sp.el.style.left = `${((this.tmp.x + 1) / 2) * innerWidth}px`;
      sp.el.style.top = `${((1 - this.tmp.y) / 2) * innerHeight}px`;
    }
    if (this.party) this.updateConfetti(dt);
  }

  private begin(s: RoomState): void {
    const final = s.game.final!, n = Math.max(3, Math.min(HEIGHTS.length, final.length));
    this.podium.clear();
    this.steps = Array.from({ length: n }, (_, i) => ({ rank: i + 1, x: OFFSETS[i], z: 0, w: STEP, d: STEP, h: HEIGHTS[i] }));
    for (const st of this.steps) podiumBlock(this.podium, st);
    // l'ensemble est centré dans la salle, sur un tapis rouge
    const xs = this.steps.map((st) => st.x), mid = (Math.min(...xs) + Math.max(...xs)) / 2, span = Math.max(...xs) - Math.min(...xs) + STEP;
    const carpet = new THREE.Mesh(new THREE.BoxGeometry(span + 0.8, 0.06, STEP + 1.5), new THREE.MeshToonMaterial({ color: '#9c2a2a', gradientMap }));
    carpet.position.set(mid, 0.03, 0.3); carpet.receiveShadow = true;
    const hem = new THREE.Mesh(new THREE.BoxGeometry(span + 1.0, 0.04, STEP + 1.7), new THREE.MeshToonMaterial({ color: '#f2b81e', gradientMap }));
    hem.position.set(mid, 0.02, 0.3);
    this.podium.add(carpet, hem);
    this.podium.position.set(-mid, DROP, Z);
    this.podium.visible = false;

    this.shown.clear(); this.landed = false; this.party = false;
    this.focus = this.focusX = this.zoom = this.zoomK = 0;
    this.float.innerHTML = '';
    this.spots = final.slice(0, n).map((f, i) => {
      const st = this.steps[i], p = s.players.find((q) => q.id === f.id);
      const el = document.createElement('div');
      el.className = `ff${f.rank === 1 ? ' first' : ''}`;
      el.style.setProperty('--c', SLOT_COLORS[(p?.slot ?? 0) % 4]);
      el.innerHTML = `<b>${f.rank}<sup>${f.rank === 1 ? 'er' : 'e'}</sup></b><span>${escapeHtml(p?.name ?? '')}</span><em><i class="coin"></i>${f.coins}</em>`;
      el.hidden = true;
      this.float.append(el);
      let pile: THREE.Mesh | null = null;
      const pileH = Math.min(f.coins, 45) * 0.03;
      if (f.coins > 0) {
        const map = coinEdges.clone();
        map.wrapT = THREE.RepeatWrapping; map.repeat.set(1, Math.min(f.coins, 45)); map.needsUpdate = true;
        pile = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 1, 18), new THREE.MeshToonMaterial({ map, gradientMap, emissive: '#5a3a00', emissiveIntensity: 0.35 }));
        pile.position.set(-mid + st.x + 0.52, st.h, Z + 0.52);
        pile.castShadow = true; pile.visible = false;
        this.scene.add(pile);
      }
      const mood: FinaleMood = f.rank === 1 ? 'win' : i === final.length - 1 && final.length >= 3 ? 'last' : 'ok';
      return { id: f.id, i, x: -mid + st.x, y: st.h, z: Z, at: finaleRevealAt(i, final.length), mood, pile, pileH, el };
    });
    this.float.hidden = false;
  }

  private end(h: FinaleHooks): void {
    for (const sp of this.spots) {
      if (this.podium.visible) this.particles.burst(sp.x, sp.y * 0.5 + 0.2, sp.z, '#d9c7a8', 8, 1.6, 1.3);
      if (sp.pile) {
        const mat = sp.pile.material as THREE.MeshToonMaterial;
        sp.pile.removeFromParent(); sp.pile.geometry.dispose(); mat.map?.dispose(); mat.dispose();
      }
    }
    this.spots = [];
    this.podium.visible = false;
    this.confetti.visible = false; this.party = false;
    this.light.intensity = 0;
    this.float.hidden = true; this.float.innerHTML = '';
    this.world.steps = undefined;
    h.done();
  }

  private startConfetti(): void {
    this.confetti.visible = true;
    for (const b of this.bits) this.resetBit(b, 3 + Math.random() * 4.5);
  }

  private resetBit(b: FinaleShow['bits'][number], y: number): void {
    b.x = (Math.random() - 0.5) * 9; b.y = y; b.z = Z - 1.2 + Math.random() * 4.2;
    b.vy = 1.1 + Math.random() * 1.3; b.spin = 3 + Math.random() * 6; b.a = Math.random() * 6.28; b.sway = 0.4 + Math.random() * 0.8;
  }

  private updateConfetti(dt: number): void {
    const d = this.dummy;
    this.bits.forEach((b, i) => {
      b.y -= b.vy * dt; b.a += b.spin * dt;
      if (b.y < 0) this.resetBit(b, 7.4);
      d.position.set(b.x + Math.sin(b.a * 0.4) * b.sway * 0.3, b.y, b.z);
      d.rotation.set(b.a, b.a * 0.7, b.a * 0.3);
      d.updateMatrix();
      this.confetti.setMatrixAt(i, d.matrix);
    });
    this.confetti.instanceMatrix.needsUpdate = true;
  }
}
