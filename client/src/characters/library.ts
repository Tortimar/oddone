import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { KitClass } from '@oddone/shared';
import { gradientMap } from '../engine/render.ts';

/**
 * Bibliothèque de pièces KayKit Adventurers (CC0).
 * Les 5 modèles partagent le même squelette : on peut donc mélanger tête, tenue, chapeau…
 * Les fichiers sont produits par tools/ (animations triées, armes conservées).
 */

export type SkinnedKey = 'body' | 'armL' | 'armR' | 'legL' | 'legR' | 'head';

export interface KitParts {
  gltf: GLTF;
  skinned: Partial<Record<SkinnedKey, THREE.SkinnedMesh>>;
  /** 'hat', 'cape' ou 'item:<NomDuMesh>' → mesh rigide accroché à un os. */
  rigid: Record<string, THREE.Mesh>;
  image: CanvasImageSource & { width: number; height: number };
}

export const KIT_CLASSES: KitClass[] = ['knight', 'mage', 'rogue', 'hood', 'barbarian'];
export const LIB = {} as Record<KitClass, KitParts>;
/** Animations (communes à tous les modèles), indexées par nom. */
export const CLIPS: Record<string, THREE.AnimationClip> = {};

export const loader = new GLTFLoader();

export async function loadCharacterLibrary(base = '/assets/characters/'): Promise<void> {
  const gltfs = await Promise.all(KIT_CLASSES.map((k) => loader.loadAsync(`${base}${k}.glb`)));
  KIT_CLASSES.forEach((k, i) => {
    const gltf = gltfs[i];
    gltf.scene.updateMatrixWorld(true);
    const parts: KitParts = { gltf, skinned: {}, rigid: {}, image: null as never };
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (!parts.image && mat.map) parts.image = mat.map.image;
      const n = mesh.name;
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
        const key: SkinnedKey | null = /ArmLeft/.test(n) ? 'armL' : /ArmRight/.test(n) ? 'armR' : /LegLeft/.test(n) ? 'legL'
          : /LegRight/.test(n) ? 'legR' : /Head/.test(n) ? 'head' : /Body/.test(n) ? 'body' : null;
        if (key) parts.skinned[key] = mesh as THREE.SkinnedMesh;
      } else if (/^handslot/.test(mesh.parent?.name ?? '')) {
        parts.rigid['item:' + n] = mesh;
      } else if (/Cape/.test(n)) parts.rigid.cape = mesh;
      else if (/Hat|Helmet/.test(n)) parts.rigid.hat = mesh;
    });
    LIB[k] = parts;
  });
  for (const clip of LIB.knight.gltf.animations) CLIPS[clip.name] = clip;
}

/* ---------------- Recoloration des atlas de dégradés ---------------- */

/** Teinte dominante de la tenue de chaque classe (mesurée sur les textures). */
const DOMINANT_HUE: Record<KitClass, number> = { knight: 352, mage: 262, rogue: 158, hood: 158, barbarian: 205 };
const SKIN_BASE = [247, 199, 164];

export interface KitMaterials { skinned: THREE.MeshToonMaterial; rigid: THREE.MeshToonMaterial }
const materialCache = new Map<string, KitMaterials>();

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h /= 360;
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

/**
 * Matériaux d'une classe avec une teinte de tenue et un ton de peau donnés.
 * - teinte : rotation des pixels saturés hors cuir/peau/or (8°–62°)
 * - peau : la colonne 0 de l'atlas (x < 1/8, y < 1/4) est remplacée en gardant la luminance
 */
export function kitMaterials(cls: KitClass, hue: number | null, skin: string | null): KitMaterials {
  const key = `${cls}|${hue}|${skin}`;
  const cached = materialCache.get(key);
  if (cached) return cached;
  const img = LIB[cls].image;
  const W = img.width, H = img.height;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  if (hue !== null || skin) {
    const data = g.getImageData(0, 0, W, H), a = data.data, cell = W / 8;
    const rot = hue === null ? 0 : hue - DOMINANT_HUE[cls];
    const sk = skin ? new THREE.Color(skin) : null;
    if (sk) sk.convertLinearToSRGB();
    const baseL = SKIN_BASE[0] * 0.3 + SKIN_BASE[1] * 0.59 + SKIN_BASE[2] * 0.11;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (sk && x < cell && y < H / 4) {
        const L = (a[i] * 0.3 + a[i + 1] * 0.59 + a[i + 2] * 0.11) / baseL;
        a[i] = Math.min(255, sk.r * 255 * L); a[i + 1] = Math.min(255, sk.g * 255 * L); a[i + 2] = Math.min(255, sk.b * 255 * L);
        continue;
      }
      if (rot) {
        const [h, s, l] = rgbToHsl(a[i] / 255, a[i + 1] / 255, a[i + 2] / 255);
        if (s > 0.18 && l > 0.1 && !(h >= 8 && h <= 62)) {
          const c = hslToRgb((h + rot + 720) % 360, s, l);
          a[i] = c[0] * 255; a[i + 1] = c[1] * 255; a[i + 2] = c[2] * 255;
        }
      }
    }
    g.putImageData(data, 0, 0);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  const res: KitMaterials = {
    skinned: new THREE.MeshToonMaterial({ map: tex, gradientMap }),
    rigid: new THREE.MeshToonMaterial({ map: tex, gradientMap }),
  };
  materialCache.set(key, res);
  return res;
}

/* ---------------- Repères pour les accessoires ---------------- */

export interface HeadAnchor { center: THREE.Vector3; size: THREE.Vector3 }
export interface Anchors {
  head: HeadAnchor;
  headByClass: Partial<Record<KitClass, HeadAnchor>>;
  bodyCenter: THREE.Vector3;
  bodySize: THREE.Vector3;
  bodyMin: THREE.Vector3;
  bodyMax: THREE.Vector3;
  chestY: number;
}
export let ANCHORS: Anchors;

/** Mesure têtes et torse en pose de repos (une fois la bibliothèque chargée). */
export function computeAnchors(): void {
  const box = new THREE.Box3();
  const headBox = (m: THREE.Object3D): HeadAnchor => {
    box.setFromObject(m);
    return { center: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()) };
  };
  const knight = LIB.knight;
  const body = new THREE.Box3().setFromObject(knight.skinned.body!);
  let chestY = body.getCenter(new THREE.Vector3()).y;
  knight.gltf.scene.traverse((o) => { if ((o as THREE.Bone).isBone && o.name === 'chest') chestY = o.getWorldPosition(new THREE.Vector3()).y; });
  const headByClass: Anchors['headByClass'] = {};
  for (const k of KIT_CLASSES) { const h = LIB[k].skinned.head; if (h) headByClass[k] = headBox(h); }
  ANCHORS = {
    head: headByClass.knight!,
    headByClass,
    bodyCenter: body.getCenter(new THREE.Vector3()),
    bodySize: body.getSize(new THREE.Vector3()),
    bodyMin: body.min.clone(),
    bodyMax: body.max.clone(),
    chestY,
  };
}
