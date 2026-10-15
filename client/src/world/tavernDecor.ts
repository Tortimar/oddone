import * as THREE from 'three';
import { canvasTexture, gradientMap, part } from '../engine/toon.ts';
import type { Kit } from './kits.ts';
import { glow } from './outside.ts';
import type { Box, Circle } from './tavern.ts';

/**
 * Habillage de la taverne : lustre, tableau d'affichage, mannequin de la couturière,
 * nourriture, tapis, lanternes, braises et poussière dans la lumière.
 * Tout ce qui est purement décoratif vit ici ; la structure (murs, comptoir, cheminée,
 * collisions de base, PNJ) reste dans tavern.ts.
 */

export interface DecorKits { dungeon: Kit; furniture: Kit; restaurant: Kit; halloween: Kit }
export interface DecorContext {
  scene: THREE.Scene;
  kits: DecorKits;
  room: { halfX: number; halfZ: number };
  colliders: Box[];
  circles: Circle[];
  counterH: number;
  barZ: number;
  pointLight(color: string, intensity: number, dist: number, x: number, y: number, z: number, flicker?: number): THREE.PointLight;
}

export interface Decor { update(t: number, dt: number, cameraPos: THREE.Vector3): void }

export function decorateTavern(c: DecorContext): Decor {
  const { scene, kits, colliders, circles } = c;
  const { halfX: RX, halfZ: RZ } = c.room;
  const add = (kit: Kit, name: string, x: number, z: number, ry = 0, y = 0, scale = 1) => kit.spawn(name, { x, y, z, ry, scale, parent: scene });
  const glows: { s: THREE.Sprite; base: number; f: number }[] = [];
  const addGlow = (color: string, size: number, x: number, y: number, z: number, opacity = 0.8) => {
    const g = glow(color, size, opacity);
    g.position.set(x, y, z);
    scene.add(g);
    glows.push({ s: g, base: size, f: Math.random() * 6 });
    return g;
  };

  /* ---------- sol : tapis, teintés aux couleurs de la taverne ---------- */
  buildRunner(scene, 0, 3.4, 2.4, 6.2);  // tapis tissé de la porte au comptoir
  add(kits.furniture, 'rug_rectangle_A', -4.6, 5.0, 0, 0.011, 1.15);
  add(kits.furniture, 'rug_oval_A', 3.8, 5.1, 0, 0.011, 1.05);

  /* ---------- une petite table près du feu ---------- */
  add(kits.dungeon, 'table_small', -3.3, 0.4, 0.3, 0, 1);
  add(kits.dungeon, 'plate_food_B', -3.45, 0.3, 0.6, 0.99, 0.85);
  add(kits.dungeon, 'candle_lit', -2.95, 0.75, 0, 0.99, 0.55);
  addGlow('#ffb347', 0.8, -2.95, 1.6, 0.75);
  circles.push({ x: -3.3, z: 0.4, r: 0.8 });
  add(kits.dungeon, 'chair', -3.3, -0.85, 0.2, 0, 1);
  add(kits.dungeon, 'chair', -2.0, 1.25, Math.PI * 1.3, 0, 1);
  circles.push({ x: -3.3, z: -0.85, r: 0.4 }, { x: -2.0, z: 1.25, r: 0.4 });

  /* ---------- repas sur les tables existantes ---------- */
  add(kits.restaurant, 'food_stew', 3.4, 5.4, 0.4, 0.98, 0.6);
  add(kits.dungeon, 'candle_triple', 4.0, 4.8, 0, 0.98, 0.6);
  addGlow('#ffb347', 0.9, 4.0, 1.55, 4.8);
  add(kits.restaurant, 'stew_bowl', -4.0, 4.6, 0, 0.98, 0.7);

  /* ---------- derrière le bar : le trésor du tavernier ---------- */
  add(kits.dungeon, 'chest_gold', 6.0, -6.9, -0.35, 0, 0.75);
  add(kits.dungeon, 'coin_stack_small', 5.0, -6.6, 0.6, 0, 0.8);
  add(kits.dungeon, 'keyring_hanging', 1.7, -RZ + 0.25, 0, 2.6, 1);
  add(kits.dungeon, 'barrel_small', 6.3, -3.4, 0.3, 0, 0.85);
  add(kits.dungeon, 'barrel_small', -6.4, -3.3, 1.1, 0, 0.85);
  circles.push({ x: 6.3, z: -3.4, r: 0.5 }, { x: -6.4, z: -3.3, r: 0.5 });
  // deux petits fûts en perce sur le comptoir
  for (const x of [-5.0, 5.0]) add(kits.dungeon, 'keg', x, c.barZ, x > 0 ? -Math.PI / 2 : Math.PI / 2, c.counterH, 0.32);

  /* ---------- provisions dans le coin ---------- */
  add(kits.restaurant, 'crate_carrots', 8.7, 4.3, 0.1, 0, 0.6);
  add(kits.restaurant, 'crate_potatoes', 8.6, 4.35, -0.2, 0.58, 0.55);
  colliders.push({ x0: 7.9, x1: RX, z0: 3.6, z1: 5.1 });

  /* ---------- murs : armes, tableaux ---------- */
  add(kits.dungeon, 'sword_shield_gold', 7.8, RZ - 0.15, Math.PI, 2.7, 0.9);
  add(kits.dungeon, 'sword_shield', -RX + 0.15, -5.0, Math.PI / 2, 2.8, 0.85);
  add(kits.furniture, 'pictureframe_large_A', RX - 0.12, 3.1, -Math.PI / 2, 0.4, 0.95);
  add(kits.furniture, 'pictureframe_large_B', RX - 0.12, 3.0, -Math.PI / 2, 1.8, 0.8);

  /* ---------- entrée : lanternes et citrouilles ---------- */
  for (const sx of [-1, 1]) {
    add(kits.halloween, 'lantern_standing', sx * 1.65, RZ - 0.55, 0, 0, 0.85);
    addGlow('#ffb347', 1.6, sx * 1.65, 0.55, RZ - 0.55);
    circles.push({ x: sx * 1.65, z: RZ - 0.55, r: 0.35 });
  }
  add(kits.halloween, 'pumpkin_orange_jackolantern', 3.0, RZ - 0.8, Math.PI + 0.4, 0, 0.55);
  addGlow('#ff8a2a', 1.1, 3.0, 0.45, RZ - 0.95);
  add(kits.halloween, 'pumpkin_orange_small', 3.7, RZ - 0.55, 0.7, 0, 0.8);
  circles.push({ x: 3.3, z: RZ - 0.7, r: 0.6 });

  /* ---------- tableau d'avis de recherche ---------- */
  buildQuestBoard(scene, -6.6, RZ - 0.35);
  colliders.push({ x0: -8.0, x1: -5.2, z0: RZ - 0.7, z1: RZ });

  /* ---------- coin de la couturière : mannequin et lampe ---------- */
  buildMannequin(scene, 6.4, -1.8, -0.9);
  circles.push({ x: 6.4, z: -1.8, r: 0.45 });
  add(kits.halloween, 'lantern_standing', 9.2, 2.5, 0, 0, 0.85);
  addGlow('#ffb347', 1.5, 9.2, 0.55, 2.5);
  circles.push({ x: 9.2, z: 2.5, r: 0.35 });

  /* ---------- le lustre ---------- */
  const chandelier = buildChandelier(scene, kits.dungeon, 0, 6.3, 1.2, addGlow);
  c.pointLight('#ffc77a', 5, 14, 0, 5.6, 1.2, 0.9);

  /* ---------- lanternes suspendues aux poutres, au-dessus des tables ---------- */
  for (const [x, z] of [[-4, 5.0], [4, 5.2]] as const) {
    add(kits.halloween, 'lantern_hanging', x, z, 0, 7.5, 0.9);
    addGlow('#ffb347', 1.8, x, 6.55, z);
  }

  /* ---------- braises de la cheminée ---------- */
  const EMBERS = 36;
  const ember = new Float32Array(EMBERS * 3), emberLife = new Float32Array(EMBERS);
  const resetEmber = (i: number) => {
    ember[i * 3] = -RX + 0.9 + (Math.random() - 0.5) * 0.5;
    ember[i * 3 + 1] = 0.6 + Math.random() * 0.3;
    ember[i * 3 + 2] = 0.5 + (Math.random() - 0.5) * 1.4;
    emberLife[i] = Math.random();
  };
  for (let i = 0; i < EMBERS; i++) { resetEmber(i); ember[i * 3 + 1] += Math.random() * 1.6; }
  const emberGeo = new THREE.BufferGeometry();
  emberGeo.setAttribute('position', new THREE.BufferAttribute(ember, 3));
  const embers = new THREE.Points(emberGeo, new THREE.PointsMaterial({ color: '#ffae4a', size: 0.09, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(embers);

  /* ---------- poussière dorée dans la lumière ---------- */
  const DUST = 140;
  const dust = new Float32Array(DUST * 3), dustSeed = new Float32Array(DUST);
  for (let i = 0; i < DUST; i++) {
    dust[i * 3] = (Math.random() - 0.5) * RX * 1.8;
    dust[i * 3 + 1] = 0.5 + Math.random() * 3.6;
    dust[i * 3 + 2] = (Math.random() - 0.5) * RZ * 1.8;
    dustSeed[i] = Math.random() * 100;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dust, 3));
  const motes = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: '#ffe2a8', size: 0.05, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(motes);

  return {
    update(t, dt, cam) {
      for (const g of glows) { const k = 0.88 + 0.08 * Math.sin(t * 7 + g.f) + 0.05 * Math.sin(t * 19 + g.f * 3); g.s.scale.set(g.base * k, g.base * k, 1); }
      // le lustre se masque quand la caméra passe au-dessus ou juste à côté
      const dx = cam.x - chandelier.position.x, dz = cam.z - chandelier.position.z;
      chandelier.visible = !(Math.hypot(dx, dz) < 3.2 && cam.y > chandelier.position.y - 1.6);
      chandelier.rotation.y = Math.sin(t * 0.4) * 0.05;
      for (let i = 0; i < EMBERS; i++) {
        emberLife[i] += dt * 0.6;
        ember[i * 3 + 1] += dt * (0.7 + (i % 5) * 0.12);
        ember[i * 3] += Math.sin(t * 3 + i) * dt * 0.15;
        if (emberLife[i] > 1.4 || ember[i * 3 + 1] > 2.6) resetEmber(i);
      }
      emberGeo.attributes.position.needsUpdate = true;
      for (let i = 0; i < DUST; i++) {
        const s = dustSeed[i];
        dust[i * 3] += Math.sin(t * 0.3 + s) * dt * 0.05;
        dust[i * 3 + 1] += Math.sin(t * 0.21 + s * 2) * dt * 0.04;
        dust[i * 3 + 2] += Math.cos(t * 0.27 + s) * dt * 0.05;
      }
      dustGeo.attributes.position.needsUpdate = true;
    },
  };
}

/** Tapis tissé bordeaux à bordure dorée, dessiné sur une texture. */
function buildRunner(scene: THREE.Scene, x: number, z: number, w: number, d: number): void {
  const px = 128, tex = canvasTexture(px, Math.round((px * d) / w), (g, W, H) => {
    g.fillStyle = '#7a2a25'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#d4a640'; g.fillRect(6, 6, W - 12, H - 12);
    g.fillStyle = '#5c1d1b'; g.fillRect(11, 11, W - 22, H - 22);
    g.fillStyle = '#8f3530'; g.fillRect(17, 17, W - 34, H - 34);
    // motif de losanges
    const step = 44;
    for (let y = 17 + step / 2; y < H - 17; y += step) {
      g.fillStyle = '#d4a640';
      g.beginPath(); g.moveTo(W / 2, y - 16); g.lineTo(W / 2 + 16, y); g.lineTo(W / 2, y + 16); g.lineTo(W / 2 - 16, y); g.closePath(); g.fill();
      g.fillStyle = '#5c1d1b';
      g.beginPath(); g.moveTo(W / 2, y - 8); g.lineTo(W / 2 + 8, y); g.lineTo(W / 2, y + 8); g.lineTo(W / 2 - 8, y); g.closePath(); g.fill();
      g.fillStyle = 'rgba(212,166,64,.55)';
      for (const sx of [26, W - 26]) { g.beginPath(); g.arc(sx, y, 3, 0, Math.PI * 2); g.fill(); }
    }
    // franges
    g.fillStyle = '#e8d6a8';
    for (let i = 4; i < W - 4; i += 6) { g.fillRect(i, 0, 3, 5); g.fillRect(i, H - 5, 3, 5); }
  });
  const rug = new THREE.Mesh(new THREE.BoxGeometry(w, 0.03, d), new THREE.MeshToonMaterial({ map: tex, gradientMap }));
  rug.position.set(x, 0.075, z);
  rug.receiveShadow = true;
  scene.add(rug);
}

/** Lustre en bois : un anneau suspendu par des chaînes, des bougies et leur halo. */
export function buildChandelier(scene: THREE.Scene, dungeon: Kit, x: number, y: number, z: number,
  addGlow: (color: string, size: number, x: number, y: number, z: number, opacity?: number) => THREE.Sprite): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  scene.add(g);
  const R = 0.95;
  const ring = part(g, new THREE.TorusGeometry(R, 0.09, 10, 36), '#6b4226', { outline: true });
  ring.rotation.x = Math.PI / 2;
  part(g, new THREE.TorusGeometry(R, 0.035, 6, 36), '#d4a640').rotation.x = Math.PI / 2;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const chain = part(g, new THREE.CylinderGeometry(0.025, 0.025, 2.4, 6), '#3a3d4a');
    chain.position.set(Math.cos(a) * 0.5, 1.15, Math.sin(a) * 0.5);
    chain.rotation.set(Math.sin(a) * 0.14, 0, -Math.cos(a) * 0.14);
  }
  const candles = 6;
  for (let i = 0; i < candles; i++) {
    const a = (i / candles) * Math.PI * 2;
    const cx = Math.cos(a) * R, cz = Math.sin(a) * R;
    const candle = dungeon.create('candle_thin_lit');
    candle.position.set(cx, 0.05, cz);
    candle.scale.setScalar(0.38);
    g.add(candle);
    const halo = addGlow('#ffbf5e', 0.7, x + cx, y + 0.43, z + cz, 0.75);
    g.attach(halo);
  }
  return g;
}

/** Tableau d'affichage en bois (vide). */
function buildQuestBoard(scene: THREE.Scene, x: number, z: number): void {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = Math.PI;
  scene.add(g);
  for (const sx of [-1.2, 1.2]) part(g, new THREE.BoxGeometry(0.16, 3.1, 0.16), '#5a3a22', { outline: true }).position.set(sx, 1.55, 0);
  part(g, new THREE.BoxGeometry(2.7, 1.75, 0.1), '#7a4e2c', { outline: true }).position.set(0, 2.15, 0.02);
  part(g, new THREE.BoxGeometry(2.9, 0.18, 0.2), '#5a3a22', { outline: true }).position.set(0, 3.12, 0.02);
}

/** Mannequin de couture : pied, buste habillé d'un tissu, épingles et ruban. */
function buildMannequin(scene: THREE.Scene, x: number, z: number, ry: number): void {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  scene.add(g);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = part(g, new THREE.CylinderGeometry(0.04, 0.04, 0.6, 6), '#5a3a22');
    leg.position.set(Math.cos(a) * 0.2, 0.27, Math.sin(a) * 0.2);
    leg.rotation.set(Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6);
  }
  part(g, new THREE.CylinderGeometry(0.05, 0.05, 1.1, 8), '#6b4226').position.y = 0.95;
  const profile = [[0.001, 0], [0.32, 0.02], [0.38, 0.2], [0.3, 0.45], [0.36, 0.72], [0.4, 0.86], [0.24, 0.98], [0.1, 1.02], [0.001, 1.04]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const torso = part(g, new THREE.LatheGeometry(profile, 24), '#c94f7c', { outline: true });
  torso.position.y = 1.45;
  torso.scale.z = 0.75;
  const sash = part(g, new THREE.TorusGeometry(0.31, 0.04, 8, 24), '#ffd23f');
  sash.rotation.x = Math.PI / 2; sash.position.y = 1.9; sash.scale.y = 0.75;
  part(g, new THREE.SphereGeometry(0.09, 10, 8), '#8d6040').position.y = 2.55;
  for (const [px, py] of [[0.2, 2.2], [0.12, 2.05], [0.26, 1.75]]) {
    const pin = part(g, new THREE.SphereGeometry(0.03, 6, 5), '#3d8bff');
    pin.position.set(px, py, 0.27);
  }
}
