import * as THREE from 'three';
import type { CharacterConfig } from '@oddone/shared';
import { composeCharacter } from '../characters/character.ts';

/**
 * Portraits des héros : la tête du personnage, rendue une fois hors écran puis gardée en cache
 * (une image par tenue). Sert partout où il faut reconnaître un joueur d'un coup d'œil :
 * pastilles « Prêt ! » de l'écran des règles, votants sur les cartes, cartes de vote.
 */

const SIZE = 128;
let renderer: THREE.WebGLRenderer | null = null;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 20);
const cache = new Map<string, string>();

function setup(): THREE.WebGLRenderer {
  const r = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true, antialias: true, preserveDrawingBuffer: true });
  r.setSize(SIZE, SIZE, false);
  r.setClearColor(0x000000, 0);
  scene.add(new THREE.HemisphereLight('#fff4e0', '#5a3a22', 2.2));
  const key = new THREE.DirectionalLight('#ffffff', 1.6);
  key.position.set(1.5, 2.5, 3);
  scene.add(key);
  return r;
}

const head = new THREE.Vector3();

/** Image (data URL) de la tête du personnage, de face. */
export function portrait(cfg: CharacterConfig): string {
  const key = JSON.stringify(cfg);
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    renderer ??= setup();
    const model = composeCharacter(cfg);
    model.actions.Idle?.play();
    model.mixer.update(0.4);
    scene.add(model.holder);
    model.holder.updateMatrixWorld(true);
    const bone = model.holder.getObjectByName('head');
    if (bone) bone.getWorldPosition(head); else head.set(0, 1.9 * model.size, 0);
    head.y += 0.32 * model.size; // le visage est un peu au-dessus de l'os du cou
    camera.position.set(head.x, head.y + 0.1, head.z + 3.4 * model.size);
    camera.lookAt(head);
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    scene.remove(model.holder);
    model.mixer.stopAllAction();
    cache.set(key, url);
    return url;
  } catch {
    return '';
  }
}

/** Cadrages des vignettes de l'atelier : la tête, tout le corps de face, ou de dos. */
export type Shot = 'head' | 'body' | 'back';

/** Vignette déjà rendue (sinon null : à demander à `characterShot`, qui coûte un rendu). */
export function cachedShot(cfg: CharacterConfig, shot: Shot): string | null {
  return cache.get(shot === 'head' ? JSON.stringify(cfg) : `${shot}:${JSON.stringify(cfg)}`) ?? null;
}

/** Le personnage en vignette : la tête (comme `portrait`), en pied de face, ou de dos (cape, sac…). */
export function characterShot(cfg: CharacterConfig, shot: Shot): string {
  if (shot === 'head') return portrait(cfg);
  const key = `${shot}:${JSON.stringify(cfg)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    renderer ??= setup();
    const model = composeCharacter(cfg);
    model.actions.Idle?.play();
    model.mixer.update(0.4);
    scene.add(model.holder);
    model.holder.updateMatrixWorld(true);
    const s = model.size, cy = 1.2 * s, dist = 4.7 * s;
    if (shot === 'body') camera.position.set(0.9 * s, cy + 0.5 * s, dist);
    else camera.position.set(-1.6 * s, cy + 0.9 * s, -dist * 0.95); // de dos, un peu de côté
    camera.lookAt(0, cy, 0);
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    scene.remove(model.holder);
    model.mixer.stopAllAction();
    cache.set(key, url);
    return url;
  } catch {
    return '';
  }
}

/** Balise <img> prête à insérer (vide si le rendu a échoué). */
export function portraitImg(cfg: CharacterConfig, alt = ''): string {
  const url = portrait(cfg);
  return url ? `<img class="face" src="${url}" alt="${alt.replace(/"/g, '&quot;')}" draggable="false">` : '';
}

const box = new THREE.Box3(), size = new THREE.Vector3(), center = new THREE.Vector3();

/**
 * Icône d'un objet 3D (ingrédient…) : rendu de trois quarts, cadré sur sa boîte englobante.
 * `key` sert de cache ; `build` n'est appelé qu'une fois par clé.
 */
export function objectIcon(key: string, build: () => THREE.Object3D | null): string {
  const hit = cache.get('obj:' + key);
  if (hit) return hit;
  try {
    const obj = build();
    if (!obj) return '';
    renderer ??= setup();
    scene.add(obj);
    obj.updateMatrixWorld(true);
    box.setFromObject(obj).getSize(size);
    box.getCenter(center);
    const r = Math.max(size.x, size.y, size.z) * 0.62;
    const dist = r / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.position.set(center.x + dist * 0.55, center.y + dist * 0.55, center.z + dist * 0.65);
    camera.lookAt(center);
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    scene.remove(obj);
    cache.set('obj:' + key, url);
    return url;
  } catch {
    return '';
  }
}
