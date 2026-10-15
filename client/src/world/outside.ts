import * as THREE from 'three';
import { canvasTexture } from '../engine/toon.ts';
import type { Kit } from './kits.ts';

/**
 * L'extérieur de nuit vu par les fenêtres et la porte : ciel étoilé, lune, village médiéval
 * éclairé par des lanternes, arbres d'automne, collines. Tout est teinté en bleu nuit pour
 * contraster avec l'intérieur chaud. On ne le voit que par les fenêtres : la caméra reste
 * toujours dans la salle. Les objets sont rangés par côté (front/left/right) pour s'y retrouver.
 */

interface OutsideKits { medieval: Kit; halloween: Kit }

/** Teinte appliquée aux matériaux extérieurs (multiplie la texture). */
const NIGHT_TINT = new THREE.Color('#7f8fd6');
const nightMaterials = new Map<string, THREE.Material>();
function nightify(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const src = m.material as THREE.MeshToonMaterial;
    let night = nightMaterials.get(src.uuid);
    if (!night) {
      const c = src.clone();
      c.color = src.color.clone().multiply(NIGHT_TINT);
      night = c;
      nightMaterials.set(src.uuid, night);
    }
    m.material = night;
    m.receiveShadow = true;
    m.castShadow = false;
  });
}

/** Halo lumineux (lanternes, fenêtres) : un sprite additif, beaucoup moins cher qu'une lumière. */
const glowTexture = canvasTexture(128, 128, (g, w, h) => {
  const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25, 'rgba(255,255,255,.55)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});
export function glow(color: string, size: number, opacity = 0.9): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
  s.scale.set(size, size, 1);
  return s;
}

export interface Outside {
  bySide: Record<'front' | 'left' | 'right', THREE.Object3D[]>;
  update(t: number): void;
}

export function buildOutside(scene: THREE.Scene, kits: OutsideKits, room: { halfX: number; halfZ: number }): Outside {
  const { halfX: RX, halfZ: RZ } = room;
  const bySide: Outside['bySide'] = { front: [], left: [], right: [] };
  const twinkles: { s: THREE.Sprite; base: number; f: number }[] = [];

  /* ---------- ciel ---------- */
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(110, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color('#0b0d26') },
        mid: { value: new THREE.Color('#29245a') },
        horizon: { value: new THREE.Color('#8a4f63') },
      },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; varying vec3 vP;
        void main(){ float h = clamp(vP.y, -0.2, 1.0);
          vec3 c = mix(horizon, mid, smoothstep(-0.02, 0.22, h));
          c = mix(c, top, smoothstep(0.22, 0.75, h));
          gl_FragColor = vec4(c, 1.0); }`,
    }),
  );
  sky.renderOrder = -10;
  scene.add(sky);

  // étoiles
  const starCount = 900, pos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const u = Math.random() * Math.PI * 2, v = 0.08 + Math.random() * 0.9;
    const r = 100;
    pos[i * 3] = Math.cos(u) * Math.cos(v * Math.PI / 2) * r;
    pos[i * 3 + 1] = Math.sin(v * Math.PI / 2) * r;
    pos[i * 3 + 2] = Math.sin(u) * Math.cos(v * Math.PI / 2) * r;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: '#fff6dc', size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.85, fog: false, depthWrite: false }));
  stars.renderOrder = -9;
  scene.add(stars);

  // lune, vue par les fenêtres de la façade
  const moonTex = canvasTexture(256, 256, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, w * 0.18, w / 2, h / 2, w / 2);
    gr.addColorStop(0, 'rgba(255,240,205,.55)'); gr.addColorStop(1, 'rgba(255,240,205,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff3d6'; g.beginPath(); g.arc(w / 2, h / 2, w * 0.2, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(214,196,160,.55)';
    for (const [x, y, r] of [[0.45, 0.44, 0.05], [0.56, 0.55, 0.035], [0.47, 0.6, 0.025]]) { g.beginPath(); g.arc(w * x, h * y, w * r, 0, Math.PI * 2); g.fill(); }
  });
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTex, fog: false, depthWrite: false, transparent: true }));
  moon.position.set(-22, 24, 80);
  moon.scale.set(26, 26, 1);
  moon.renderOrder = -8;
  scene.add(moon);

  // nuages lointains
  for (const [x, y, z, s] of [[-30, 20, 70, 6], [25, 24, 75, 7], [60, 18, 20, 6], [-65, 22, -10, 7]] as const) {
    const c = kits.medieval.spawn('cloud_big', { x, y, z, scale: s, ry: Math.random() * 3, parent: scene, shadows: false });
    c.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = new THREE.MeshBasicMaterial({ color: '#4a4378', transparent: true, opacity: 0.55, fog: false, depthWrite: false });
    });
  }

  /* ---------- sol extérieur ---------- */
  const grass = new THREE.Mesh(new THREE.CircleGeometry(95, 48), new THREE.MeshToonMaterial({ color: '#2b3a4a' }));
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = -0.12;
  grass.receiveShadow = true;
  scene.add(grass);

  const put = (side: keyof Outside['bySide'], kit: Kit, name: string, x: number, z: number, scale = 1, ry = 0, y = 0) => {
    const o = kit.spawn(name, { x, y, z, ry, scale, parent: scene, shadows: false });
    nightify(o);
    bySide[side].push(o);
    return o;
  };
  const lamp = (side: keyof Outside['bySide'], x: number, z: number, ry = 0) => {
    put(side, kits.halloween, 'post_lantern', x, z, 1, ry);
    const g = glow('#ffb347', 3.2);
    g.position.set(x + Math.sin(ry) * 1.0, 2.75, z + Math.cos(ry) * 1.0);
    scene.add(g);
    bySide[side].push(g);
    twinkles.push({ s: g, base: 3.2, f: Math.random() * 6 });
  };
  /** Fenêtre éclairée d'une maison lointaine. */
  const windowGlow = (side: keyof Outside['bySide'], x: number, y: number, z: number, size = 1.6) => {
    const g = glow('#ffc46b', size, 0.75);
    g.position.set(x, y, z);
    scene.add(g);
    bySide[side].push(g);
    twinkles.push({ s: g, base: size, f: Math.random() * 6 });
  };

  /* ---------- façade : la rue du village ---------- */
  const F = RZ + 1;
  for (let x = -14; x <= 14; x += 1.9) for (const z of [F + 2.2, F + 4.1]) put('front', kits.halloween, (x * 7 + z) % 3 < 1.5 ? 'path_A' : 'path_B', x, z, 1, Math.floor(Math.abs(x)) % 4 * Math.PI / 2, -0.06);
  lamp('front', -3.2, F + 1.4, 0); lamp('front', 6.5, F + 1.4, 0);
  put('front', kits.medieval, 'building_home_B_red', -9, F + 11, 6, 0.3);
  windowGlow('front', -8.4, 3.2, F + 7.7);
  put('front', kits.medieval, 'building_well_blue', 1.5, F + 8.5, 3, 0.6);
  put('front', kits.medieval, 'building_tavern_red', 11, F + 13, 6, -0.4);
  windowGlow('front', 10, 3.5, F + 9.4); windowGlow('front', 12.6, 4.6, F + 9.8, 1.3);
  put('front', kits.medieval, 'building_church_yellow', -1, F + 22, 7, 0.1);
  windowGlow('front', -1.2, 5.5, F + 18, 1.4);
  put('front', kits.medieval, 'building_market_red', 4.5, F + 13, 4.5, Math.PI);
  put('front', kits.medieval, 'building_home_A_blue', -16, F + 9, 6, 0.9);
  put('front', kits.medieval, 'building_windmill_green', 20, F + 22, 7, -0.6);
  put('front', kits.medieval, 'mountain_B_grass_trees', -22, F + 40, 12, 0.5);
  put('front', kits.medieval, 'mountain_A_grass_trees', 6, F + 48, 14, 1.4);
  for (const [x, z, s] of [[-5.5, F + 5.5, 4.4], [16, F + 6, 5], [-13, F + 15, 5.5], [7.5, F + 19, 5]] as const)
    put('front', kits.medieval, Math.random() < 0.5 ? 'tree_single_A' : 'tree_single_B', x, z, s, Math.random() * 6);
  put('front', kits.halloween, 'pumpkin_orange_jackolantern', 4.6, F + 1.5, 0.9, -0.4);
  const jack = glow('#ff8a2a', 1.6, 0.8); jack.position.set(4.6, 0.7, F + 1.7); scene.add(jack); bySide.front.push(jack);
  put('front', kits.halloween, 'bench', -7, F + 1.6, 0.9, 0);

  /* ---------- côté gauche : la lisière de la forêt ---------- */
  const L = -RX - 1;
  for (let i = 0; i < 9; i++) {
    const z = -12 + i * 3.4, x = L - 4 - (i % 3) * 3.5;
    put('left', kits.halloween, i % 3 === 0 ? 'tree_pine_yellow_large' : 'tree_pine_orange_large', x, z, 0.9 + (i % 2) * 0.25, i);
  }
  put('left', kits.halloween, 'tree_dead_large', L - 2.5, 4.5, 1, 1.2);
  put('left', kits.medieval, 'hills_A_trees', L - 24, -2, 11, 0.4);
  put('left', kits.medieval, 'mountain_C_grass_trees', L - 40, 14, 14, 2.1);
  put('left', kits.halloween, 'fence', L - 1.2, -4, 1, Math.PI / 2);
  put('left', kits.halloween, 'fence', L - 1.2, 0, 1, Math.PI / 2);
  lamp('left', L - 1.4, 6.6, -Math.PI / 2); // devant la fenêtre du fond (la cheminée cache l'autre côté)

  /* ---------- côté droit : la place et le cimetière ---------- */
  const R = RX + 1;
  put('right', kits.medieval, 'building_blacksmith_red', R + 9, -6, 5.5, -Math.PI / 2);
  windowGlow('right', R + 6.4, 2.2, -6.2);
  put('right', kits.medieval, 'building_home_A_blue', R + 10, 7, 6, -1.9);
  windowGlow('right', R + 7.3, 3, 6.4);
  put('right', kits.halloween, 'fence', R + 3, 1.5, 1, Math.PI / 2);
  put('right', kits.halloween, 'gravestone', R + 4.6, 0, 1.1, -Math.PI / 2);
  put('right', kits.halloween, 'grave_A', R + 5.2, 2.6, 1.1, -Math.PI / 2);
  put('right', kits.halloween, 'tree_dead_medium', R + 6, 3.8, 1.1, 0.5);
  put('right', kits.halloween, 'tree_pine_orange_medium', R + 3.5, -2.5, 1.1, 0.8);
  put('right', kits.medieval, 'trees_A_large', R + 22, -18, 7, 0.2);
  put('right', kits.medieval, 'mountain_A_grass_trees', R + 45, 4, 14, 0.9);
  lamp('right', R + 1.5, 4.2, Math.PI / 2);

  return {
    bySide,
    update(t) {
      for (const g of twinkles) {
        const k = 0.9 + 0.08 * Math.sin(t * 6 + g.f) + 0.05 * Math.sin(t * 17 + g.f * 2);
        g.s.scale.set(g.base * k, g.base * k, 1);
      }
      stars.rotation.y = t * 0.004;
    },
  };
}
