import * as THREE from 'three';
import { PODIUM_STEPS, type PodiumStep } from '@oddone/shared';
import { OUTLINE, canvasTexture, gradientMap, shade } from '../engine/render.ts';
import type { World } from '../world/tavern.ts';

/**
 * Effets communs à tous les mini-jeux : particules (poussière, étoiles d'un coup, éclats de
 * téléportation) et podium des résultats qui tombe du ciel.
 */

const puffTexture = canvasTexture(64, 64, (g, w) => {
  const grad = g.createRadialGradient(w / 2, w / 2, 2, w / 2, w / 2, w / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, w, w);
});

export class Particles {
  private puffs: { s: THREE.Sprite; life: number; vy: number; vx: number; vz: number; size: number; span: number }[] = [];

  constructor(private scene: THREE.Scene) {}

  burst(x: number, y: number, z: number, color: string, count: number, spread = 0.6, size = 0.5): void {
    for (let i = 0; i < count; i++) {
      let p = this.puffs.find((q) => q.life <= 0);
      if (!p) {
        if (this.puffs.length > 160) return;
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTexture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
        this.scene.add(sp);
        p = { s: sp, life: 0, vy: 0, vx: 0, vz: 0, size: 0, span: 0.6 };
        this.puffs.push(p);
      }
      const a = Math.random() * Math.PI * 2, v = spread * (1 + Math.random() * 2);
      p.life = 1; p.vy = 0.5 + Math.random() * 1.6; p.vx = Math.cos(a) * v; p.vz = Math.sin(a) * v;
      p.size = size * (0.7 + Math.random() * 0.6); p.span = 0.45 + Math.random() * 0.35;
      p.s.material.color.set(color);
      p.s.visible = true;
      p.s.position.set(x, y + Math.random() * 0.4, z);
    }
  }

  update(dt: number): void {
    for (const p of this.puffs) {
      if (p.life <= 0) continue;
      p.life -= dt / p.span;
      p.s.position.x += p.vx * dt; p.s.position.z += p.vz * dt; p.s.position.y += p.vy * dt;
      p.s.scale.setScalar(p.size * (0.6 + (1 - p.life) * 1.2));
      p.s.material.opacity = Math.max(0, p.life) * 0.9;
      if (p.life <= 0) p.s.visible = false;
    }
  }
}

/** Planches sombres d'un plafond de donjon (Coffres Piégés, Bombe du Labyrinthe). */
export const ceilingPlanks = canvasTexture(256, 256, (g, w, h) => {
  g.fillStyle = '#2e1d12'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? '#3a2416' : '#332014'; g.fillRect(0, i * 32, w, 32);
    g.fillStyle = '#1c110a'; g.fillRect(0, i * 32, w, 3);
    g.fillStyle = 'rgba(0,0,0,.2)'; g.fillRect(((i * 97) % 200) + 20, i * 32 + 3, 3, 29);
  }
});
ceilingPlanks.wrapS = ceilingPlanks.wrapT = THREE.RepeatWrapping;
ceilingPlanks.repeat.set(6, 6);

/** Or, argent, bronze, bois : couleur d'une marche selon la place. */
const STEP_COLORS = ['#f2b81e', '#c9d2e0', '#d08a4a', '#9a6539'];

/** Une marche de podium : bloc de couleur, numéro de la place sur la face avant (+z), liseré de bois. */
export function podiumBlock(parent: THREE.Object3D, st: PodiumStep): void {
  const col = STEP_COLORS[Math.min(st.rank, STEP_COLORS.length) - 1];
  const tall = Math.max(1, Math.round(256 * Math.min(1, st.h / st.w)));
  const face = canvasTexture(256, tall, (c, w, h) => {
    c.fillStyle = col; c.fillRect(0, 0, w, h);
    c.fillStyle = shade(col, -0.18); c.fillRect(0, h * 0.9, w, h * 0.1); c.fillRect(0, 0, w, h * 0.055);
    const size = Math.min(170, h * 0.7);
    c.font = `${size}px "Lilita One", sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = shade(col, -0.35); c.fillText(String(st.rank), w / 2 + 6, h / 2 + 12);
    c.fillStyle = '#fff8e6'; c.fillText(String(st.rank), w / 2, h / 2 + 4);
  });
  const side = new THREE.MeshToonMaterial({ color: col, gradientMap });
  const front = new THREE.MeshToonMaterial({ map: face, gradientMap });
  // face avant (+z) avec le numéro, le reste uni ; un liseré de bois en haut
  const box = new THREE.Mesh(new THREE.BoxGeometry(st.w, st.h, st.d), [side, side, new THREE.MeshToonMaterial({ color: shade(col, 0.12), gradientMap }), side, front, side]);
  box.position.set(st.x, st.h / 2, st.z);
  box.castShadow = box.receiveShadow = true;
  const edge = new THREE.Mesh(box.geometry, OUTLINE);
  edge.scale.setScalar(1.04);
  box.add(edge);
  // bandeau de bois sous l'arête du haut
  const trim = new THREE.Mesh(new THREE.BoxGeometry(st.w + 0.06, 0.1, st.d + 0.06), new THREE.MeshToonMaterial({ color: '#5a3a22', gradientMap }));
  trim.position.set(st.x, st.h - 0.2, st.z);
  parent.add(box, trim);
}

/** Le podium : modélisé en code, il tombe au point `origin` de l'arène. */
export class PodiumView {
  readonly group = new THREE.Group();
  private landed = false;
  /** Secousse de caméra à l'atterrissage (0..1). */
  shake = 0;

  constructor(scene: THREE.Scene, readonly origin: [number, number], private world: World, private particles: Particles, private onLand?: () => void) {
    this.build();
    this.group.position.set(origin[0], 0, origin[1]);
    this.group.visible = false;
    scene.add(this.group);
  }

  get ready(): boolean { return this.landed; }

  /** `since` : secondes depuis le début des résultats (horloge du serveur : tout le monde voit la même chose). */
  setTime(since: number): void {
    const fallTime = 0.95, g = this.group;
    g.visible = true;
    if (since < fallTime) {
      const k = Math.max(0, since) / fallTime;
      g.position.y = 24 * (1 - k * k);
      g.scale.set(1, 1, 1);
      return;
    }
    g.position.y = 0;
    if (!this.landed) {
      this.landed = true;
      this.shake = 1;
      this.onLand?.();
      const [ox, oz] = this.origin;
      for (const st of PODIUM_STEPS) this.particles.burst(ox + st.x, 0.2, oz + st.z + 1.1, '#d9c7a8', 10, 2.2, 1.6);
      this.world.steps = PODIUM_STEPS.map((st) => ({ x0: ox + st.x - st.w / 2, x1: ox + st.x + st.w / 2, z0: oz + st.z - st.d / 2, z1: oz + st.z + st.d / 2, top: st.h }));
    }
    const after = since - fallTime;
    // petit écrasement à l'impact
    const squash = after < 0.5 ? Math.sin(after * Math.PI * 4) * Math.exp(-after * 6) * 0.12 : 0;
    g.scale.set(1 + squash, 1 - squash, 1 + squash);
  }

  update(dt: number): void { this.shake = Math.max(0, this.shake - dt * 2.5); }

  private build(): void {
    const g = this.group;
    for (const st of PODIUM_STEPS) podiumBlock(g, st);
    const base = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.16, 2.6), new THREE.MeshToonMaterial({ color: '#4a2f1d', gradientMap }));
    base.position.y = 0.06; base.receiveShadow = true;
    g.add(base);
    // petits fanions dorés de chaque côté
    for (const sx of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6), new THREE.MeshToonMaterial({ color: '#5a3a22', gradientMap }));
      pole.position.set(sx * 3.4, 1.3, -0.9);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), new THREE.MeshToonMaterial({ color: sx < 0 ? '#e8413c' : '#2f7de1', gradientMap, side: THREE.DoubleSide }));
      flag.position.set(sx * 3.4 + 0.42 * -sx, 2.3, -0.9);
      g.add(pole, flag);
    }
  }
}
