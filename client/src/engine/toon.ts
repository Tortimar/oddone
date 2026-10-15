import * as THREE from 'three';

/** Utilitaires de rendu sans effet de bord : matériaux toon, contours, textures dessinées, lissages. */

/** Rampe à 3 tons pour l'ombrage cartoon. */
export const gradientMap = (() => {
  const t = new THREE.DataTexture(new Uint8Array([120, 120, 120, 255, 200, 200, 200, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
})();

const toonCache = new Map<string, THREE.MeshToonMaterial>();
export function toon(color: string): THREE.MeshToonMaterial {
  let m = toonCache.get(color);
  if (!m) { m = new THREE.MeshToonMaterial({ color, gradientMap }); toonCache.set(color, m); }
  return m;
}
const flatCache = new Map<string, THREE.MeshBasicMaterial>();
export function flat(color: string): THREE.MeshBasicMaterial {
  let m = flatCache.get(color);
  if (!m) { m = new THREE.MeshBasicMaterial({ color }); flatCache.set(color, m); }
  return m;
}

/** Contour noir par coque inversée (le mesh est gonflé le long de ses normales). */
export const OUTLINE = new THREE.MeshBasicMaterial({ color: '#1d120c', side: THREE.BackSide });
OUTLINE.onBeforeCompile = (s) => {
  s.vertexShader = s.vertexShader.replace('#include <begin_vertex>', 'vec3 transformed = position + normal * 0.02;');
};

export interface PartOptions { outline?: boolean; shadow?: boolean; receive?: boolean; material?: THREE.Material }
export function part(parent: THREE.Object3D, geo: THREE.BufferGeometry, color: string, o: PartOptions = {}): THREE.Mesh {
  const m = new THREE.Mesh(geo, o.material ?? toon(color));
  m.castShadow = o.shadow !== false;
  m.receiveShadow = o.receive !== false;
  parent.add(m);
  if (o.outline) m.add(new THREE.Mesh(geo, OUTLINE));
  return m;
}
export function flatPart(parent: THREE.Object3D, geo: THREE.BufferGeometry, color: string): THREE.Mesh {
  const m = new THREE.Mesh(geo, flat(color));
  parent.add(m);
  return m;
}

export function shade(hex: string, k: number): string {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return '#' + c.getHexString();
}

export interface RedrawableTexture extends THREE.CanvasTexture { redraw(): void }
export function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): RedrawableTexture {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d')!;
  draw(g, w, h);
  const t = new THREE.CanvasTexture(cv) as RedrawableTexture;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.redraw = () => { g.clearRect(0, 0, w, h); draw(g, w, h); t.needsUpdate = true; };
  return t;
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt));
export function angleDamp(a: number, b: number, k: number, dt: number): number {
  const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * (1 - Math.exp(-k * dt));
}
