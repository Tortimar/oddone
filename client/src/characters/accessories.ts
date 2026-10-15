import * as THREE from 'three';
import type { KitClass } from '@oddone/shared';
import { flatPart, part, shade } from '../engine/toon.ts';
import { ANCHORS, type HeadAnchor } from './library.ts';

/**
 * Accessoires modélisés en code. Chaque fabrique construit l'objet autour de (0,0,0),
 * axes du monde (+z devant, +y haut), et indique l'os où l'accrocher et la position
 * (en pose de repos) où il doit apparaître.
 */

export type Tick = (t: number, dt: number, airborne: boolean) => void;
export interface Accessory { group: THREE.Group; bone: 'head' | 'chest'; at: THREE.Vector3; tick?: Tick }
type Factory = (color: string, head: HeadAnchor) => Accessory;

const EYE_Y = -0.12; // hauteur des yeux relative au centre de la tête
const LENS = new THREE.MeshBasicMaterial({ color: '#bfe8ff', transparent: true, opacity: 0.45 });

const acc = (parent: THREE.Object3D, geo: THREE.BufferGeometry, c: string) => part(parent, geo, c, { outline: true });
const W = () => ANCHORS.head.size.x;
const D = () => ANCHORS.head.size.z;
const B = () => ANCHORS.bodySize.x;

function faceAt(h: HeadAnchor) {
  const k = ANCHORS.head;
  return new THREE.Vector3(k.center.x, k.center.y + EYE_Y * k.size.y, h.center.z + h.size.z * 0.5);
}
function topAt(h: HeadAnchor, off: number) {
  return new THREE.Vector3(h.center.x, h.center.y + h.size.y * 0.5 + ANCHORS.head.size.y * off, h.center.z);
}

export const ACCESSORIES: Record<string, Factory> = {
  glasses(c, h) {
    const w = W(), g = new THREE.Group();
    for (const sx of [-1, 1]) {
      acc(g, new THREE.TorusGeometry(0.13 * w, 0.022 * w, 10, 28), c).position.set(sx * 0.18 * w, 0, 0.03 * w);
      const l = new THREE.Mesh(new THREE.CircleGeometry(0.13 * w, 24), LENS); l.position.set(sx * 0.18 * w, 0, 0.025 * w); g.add(l);
      acc(g, new THREE.BoxGeometry(0.02 * w, 0.02 * w, D() * 0.55), c).position.set(sx * 0.31 * w, 0, -D() * 0.26);
    }
    const br = acc(g, new THREE.CylinderGeometry(0.016 * w, 0.016 * w, 0.1 * w, 8), c); br.rotation.z = Math.PI / 2; br.position.set(0, 0.02 * w, 0.03 * w);
    return { group: g, bone: 'head', at: faceAt(h) };
  },
  shades(c, h) {
    const w = W(), g = new THREE.Group();
    for (const sx of [-1, 1]) {
      flatPart(g, new THREE.BoxGeometry(0.26 * w, 0.14 * w, 0.03 * w), '#1d1830').position.set(sx * 0.17 * w, -0.01 * w, 0.03 * w);
      const sh = flatPart(g, new THREE.BoxGeometry(0.07 * w, 0.025 * w, 0.01 * w), '#ffffff'); sh.position.set(sx * 0.17 * w - 0.06 * w, 0.02 * w, 0.05 * w); sh.rotation.z = 0.5;
      acc(g, new THREE.BoxGeometry(0.02 * w, 0.02 * w, D() * 0.55), c).position.set(sx * 0.31 * w, 0.03 * w, -D() * 0.26);
    }
    acc(g, new THREE.BoxGeometry(0.62 * w, 0.035 * w, 0.04 * w), c).position.set(0, 0.065 * w, 0.03 * w);
    return { group: g, bone: 'head', at: faceAt(h) };
  },
  mustache(c, h) {
    const w = W(), g = new THREE.Group();
    for (const sx of [-1, 1]) {
      const m = acc(g, new THREE.SphereGeometry(0.09 * w, 16, 10), c); m.scale.set(1.7, 0.6, 0.7); m.position.set(sx * 0.11 * w, -0.2 * w, 0.03 * w); m.rotation.z = -0.3 * sx;
      acc(g, new THREE.SphereGeometry(0.045 * w, 10, 8), c).position.set(sx * 0.24 * w, -0.15 * w, 0.02 * w);
    }
    return { group: g, bone: 'head', at: faceAt(h) };
  },
  mask(c, h) {
    const w = W(), g = new THREE.Group();
    acc(g, new THREE.BoxGeometry(0.86 * w, 0.2 * w, 0.04 * w), c).position.set(0, 0, 0.02 * w);
    for (const sx of [-1, 1]) {
      const e = flatPart(g, new THREE.SphereGeometry(0.075 * w, 16, 10), '#ffffff'); e.scale.set(1.3, 0.8, 0.25); e.position.set(sx * 0.18 * w, 0, 0.045 * w);
      const tail = acc(g, new THREE.BoxGeometry(0.06 * w, 0.14 * w, 0.25 * w), c); tail.position.set(sx * 0.12 * w, -0.04 * w, -D()); tail.rotation.set(0.5, 0, 0.4 * sx);
    }
    return { group: g, bone: 'head', at: faceAt(h) };
  },
  patch(_c, h) {
    const w = W(), g = new THREE.Group();
    flatPart(g, new THREE.CircleGeometry(0.11 * w, 20), '#1d1830').position.set(0.18 * w, 0, 0.04 * w);
    const s = acc(g, new THREE.BoxGeometry(0.9 * w, 0.03 * w, 0.02 * w), '#1d1830'); s.position.set(0, 0.06 * w, 0.03 * w); s.rotation.z = -0.42;
    return { group: g, bone: 'head', at: faceAt(h) };
  },
  halo(_c, h) {
    const w = W(), g = new THREE.Group();
    const ring = flatPart(g, new THREE.TorusGeometry(0.28 * w, 0.035 * w, 10, 36), '#fff27a'); ring.rotation.x = Math.PI / 2;
    return { group: g, bone: 'head', at: topAt(h, 0.12), tick: (t) => { ring.position.y = Math.sin(t * 3) * 0.03 * w; ring.rotation.z = t; } };
  },
  crown(_c, h) {
    const w = W(), g = new THREE.Group(); g.rotation.z = 0.14;
    acc(g, new THREE.CylinderGeometry(0.26 * w, 0.23 * w, 0.16 * w, 20), '#ffcc2e');
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      acc(g, new THREE.ConeGeometry(0.06 * w, 0.15 * w, 10), '#ffcc2e').position.set(Math.sin(a) * 0.22 * w, 0.15 * w, Math.cos(a) * 0.22 * w);
      flatPart(g, new THREE.SphereGeometry(0.035 * w, 8, 6), i % 2 ? '#ff4d6d' : '#3d8bff').position.set(Math.sin(a) * 0.255 * w, 0, Math.cos(a) * 0.255 * w);
    }
    return { group: g, bone: 'head', at: topAt(h, -0.02) };
  },
  antennas(c, h) {
    const w = W(), g = new THREE.Group();
    for (const sx of [-1, 1]) {
      const s = acc(g, new THREE.CylinderGeometry(0.015 * w, 0.015 * w, 0.35 * w, 8), '#3a3d4a'); s.position.set(sx * 0.14 * w, 0.16 * w, 0); s.rotation.z = -0.3 * sx;
      acc(g, new THREE.SphereGeometry(0.07 * w, 12, 10), c).position.set(sx * 0.2 * w, 0.33 * w, 0);
    }
    return { group: g, bone: 'head', at: topAt(h, -0.04), tick: (t) => { g.rotation.z = Math.sin(t * 4) * 0.08; } };
  },
  flower(c, h) {
    const w = W(), g = new THREE.Group(); g.rotation.set(0.2, 0, -0.5);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const p = acc(g, new THREE.SphereGeometry(0.07 * w, 12, 8), c); p.scale.set(1, 0.4, 1); p.position.set(Math.sin(a) * 0.09 * w, 0, Math.cos(a) * 0.09 * w);
    }
    acc(g, new THREE.SphereGeometry(0.055 * w, 12, 8), '#ffd23f').position.y = 0.02 * w;
    const at = topAt(h, -0.07); at.x += 0.24 * w; at.z += 0.1 * w;
    return { group: g, bone: 'head', at };
  },
  ears(c, h) {
    const w = W(), g = new THREE.Group();
    for (const sx of [-1, 1]) {
      const e = acc(g, new THREE.ConeGeometry(0.11 * w, 0.26 * w, 14), c); e.position.set(sx * 0.3 * w, 0.08 * w, 0); e.rotation.z = -0.38 * sx;
      const n = flatPart(g, new THREE.ConeGeometry(0.06 * w, 0.16 * w, 10), '#ff9fb5'); n.position.set(sx * 0.3 * w, 0.07 * w, 0.05 * w); n.rotation.z = -0.38 * sx;
    }
    return { group: g, bone: 'head', at: topAt(h, -0.08) };
  },
  propeller(c, h) {
    const w = W(), g = new THREE.Group();
    acc(g, new THREE.SphereGeometry(0.17 * w, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), c);
    acc(g, new THREE.CylinderGeometry(0.015 * w, 0.015 * w, 0.14 * w, 8), '#3a3d4a').position.y = 0.22 * w;
    const blades = new THREE.Group(); blades.position.y = 0.29 * w; g.add(blades);
    acc(blades, new THREE.BoxGeometry(0.6 * w, 0.02 * w, 0.1 * w), '#ff4d6d');
    acc(blades, new THREE.BoxGeometry(0.1 * w, 0.02 * w, 0.6 * w), '#3d8bff');
    return { group: g, bone: 'head', at: topAt(h, -0.09), tick: (_t, dt, air) => { blades.rotation.y += dt * (air ? 30 : 8); } };
  },
  horn(c, h) {
    const w = W(), g = new THREE.Group(); g.rotation.x = 0.45;
    acc(g, new THREE.ConeGeometry(0.07 * w, 0.36 * w, 16), '#fff6c9').position.y = 0.18 * w;
    for (let i = 0; i < 3; i++) {
      const r = flatPart(g, new THREE.TorusGeometry(0.055 * w - i * 0.012 * w, 0.008 * w, 6, 16), c); r.rotation.x = Math.PI / 2; r.position.y = 0.08 * w + i * 0.08 * w;
    }
    const at = topAt(h, -0.18); at.z += D() * 0.3;
    return { group: g, bone: 'head', at };
  },
  medal() {
    const b = B(), g = new THREE.Group();
    for (const sx of [-1, 1]) { const r = acc(g, new THREE.BoxGeometry(0.06 * b, 0.32 * b, 0.015 * b), '#3d8bff'); r.position.set(sx * 0.08 * b, 0.1 * b, 0); r.rotation.z = 0.35 * sx; }
    const m = acc(g, new THREE.CylinderGeometry(0.11 * b, 0.11 * b, 0.03 * b, 24), '#ffcc2e'); m.rotation.x = Math.PI / 2; m.position.y = -0.08 * b;
    flatPart(g, new THREE.CircleGeometry(0.06 * b, 5), '#ffffff').position.set(0, -0.08 * b, 0.02 * b);
    return { group: g, bone: 'chest', at: new THREE.Vector3(0, ANCHORS.chestY + ANCHORS.bodySize.y * 0.12, ANCHORS.bodyMax.z + 0.01 * b) };
  },
  scarf(c) {
    const b = B(), g = new THREE.Group();
    const s = acc(g, new THREE.TorusGeometry(0.32 * b, 0.09 * b, 12, 30), c); s.rotation.x = Math.PI / 2; s.scale.set(1, ANCHORS.bodySize.z / ANCHORS.bodySize.x, 1);
    const tail = acc(g, new THREE.BoxGeometry(0.16 * b, 0.4 * b, 0.06 * b), c); tail.position.set(0.16 * b, -0.2 * b, ANCHORS.bodySize.z * 0.42); tail.rotation.z = 0.15;
    const st = flatPart(g, new THREE.BoxGeometry(0.165 * b, 0.05 * b, 0.065 * b), '#ffffff'); st.position.set(0.16 * b, -0.32 * b, ANCHORS.bodySize.z * 0.42); st.rotation.z = 0.15;
    return { group: g, bone: 'chest', at: new THREE.Vector3(0, ANCHORS.bodyMax.y - 0.05 * b, ANCHORS.bodyCenter.z) };
  },
  bowtie(c) {
    const b = B(), g = new THREE.Group();
    for (const sx of [-1, 1]) { const k = acc(g, new THREE.ConeGeometry(0.08 * b, 0.15 * b, 12), c); k.position.x = 0.075 * b * sx; k.rotation.z = (Math.PI / 2) * sx; }
    acc(g, new THREE.SphereGeometry(0.05 * b, 10, 8), c);
    return { group: g, bone: 'chest', at: new THREE.Vector3(0, ANCHORS.bodyMax.y - 0.12 * b, ANCHORS.bodyMax.z) };
  },
  backpack(c) {
    const b = B(), g = new THREE.Group();
    acc(g, new THREE.BoxGeometry(0.62 * b, 0.7 * b, 0.3 * b), c);
    acc(g, new THREE.BoxGeometry(0.66 * b, 0.24 * b, 0.34 * b), shade(c, 0.78)).position.y = 0.26 * b;
    acc(g, new THREE.BoxGeometry(0.4 * b, 0.22 * b, 0.08 * b), shade(c, 0.85)).position.set(0, -0.12 * b, -0.18 * b);
    return { group: g, bone: 'chest', at: new THREE.Vector3(0, ANCHORS.chestY, ANCHORS.bodyMin.z - 0.1 * b) };
  },
  wings(c) {
    const b = B(), g = new THREE.Group(), pivots: THREE.Group[] = [];
    for (const sx of [-1, 1]) {
      const piv = new THREE.Group(); piv.position.x = 0.08 * b * sx; piv.userData.sx = sx; g.add(piv); pivots.push(piv);
      for (let i = 0; i < 3; i++) {
        const f = acc(piv, new THREE.SphereGeometry(0.22 * b, 14, 10), i ? '#ffffff' : c);
        f.scale.set(1.5 - i * 0.3, 0.45, 0.18); f.position.set(sx * (0.32 * b + i * 0.1 * b), 0.18 * b - i * 0.17 * b, -0.02 * b * i); f.rotation.z = (0.35 + i * 0.2) * sx;
      }
    }
    return {
      group: g, bone: 'chest', at: new THREE.Vector3(0, ANCHORS.chestY + 0.1 * b, ANCHORS.bodyMin.z - 0.03 * b),
      tick: (t, _dt, air) => { const a = Math.sin(t * (air ? 18 : 3)) * (air ? 0.55 : 0.15); for (const p of pivots) p.rotation.y = a * p.userData.sx; },
    };
  },
  jetpack(c) {
    const b = B(), g = new THREE.Group(), flames: THREE.Mesh[] = [];
    for (const sx of [-1, 1]) {
      acc(g, new THREE.CylinderGeometry(0.14 * b, 0.14 * b, 0.6 * b, 16), c).position.x = sx * 0.17 * b;
      acc(g, new THREE.ConeGeometry(0.14 * b, 0.14 * b, 16), '#3a3d4a').position.set(sx * 0.17 * b, 0.37 * b, 0);
      acc(g, new THREE.CylinderGeometry(0.08 * b, 0.11 * b, 0.1 * b, 12), '#3a3d4a').position.set(sx * 0.17 * b, -0.35 * b, 0);
      const f = flatPart(g, new THREE.ConeGeometry(0.08 * b, 0.3 * b, 10), '#ffb02e'); f.rotation.x = Math.PI; f.position.set(sx * 0.17 * b, -0.53 * b, 0); flames.push(f);
    }
    acc(g, new THREE.BoxGeometry(0.22 * b, 0.4 * b, 0.14 * b), '#c9cbd6');
    return {
      group: g, bone: 'chest', at: new THREE.Vector3(0, ANCHORS.chestY, ANCHORS.bodyMin.z - 0.13 * b),
      tick: (t, _dt, air) => flames.forEach((f, i) => {
        const k = air ? 1.4 + Math.sin(t * 40 + i) * 0.3 : 0.35 + Math.sin(t * 25 + i) * 0.1;
        f.scale.set(k * 0.8 + 0.2, k, k * 0.8 + 0.2); f.position.y = -0.4 * b - 0.15 * b * k;
      }),
    };
  },
  shell(c) {
    const b = B(), g = new THREE.Group();
    const s = acc(g, new THREE.SphereGeometry(0.5 * b, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2), c); s.rotation.x = -Math.PI / 2; s.scale.set(1, 0.55, 1.1);
    for (const [x, y] of [[0, 0], [0.2, 0.18], [-0.2, 0.18], [0.2, -0.18], [-0.2, -0.18]]) {
      const p = part(g, new THREE.CircleGeometry(0.1 * b, 6), shade(c, 0.7)); p.position.set(x * b, y * b, -0.27 * b); p.rotation.y = Math.PI;
    }
    return { group: g, bone: 'chest', at: new THREE.Vector3(0, ANCHORS.chestY - 0.05 * b, ANCHORS.bodyMin.z + 0.05 * b) };
  },
};

export function buildAccessory(name: string, color: string, headClass: KitClass): Accessory | null {
  const f = ACCESSORIES[name];
  if (!f) return null;
  return f(color, ANCHORS.headByClass[headClass] ?? ANCHORS.head);
}
