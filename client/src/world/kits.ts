import * as THREE from 'three';
import { gradientMap } from '../engine/toon.ts';
import { loader } from '../characters/library.ts';

/**
 * Kits de décor KayKit (CC0) : un .glb par pack, un nœud racine par modèle.
 * Le manifeste JSON à côté donne la liste des modèles, leur catégorie et leurs dimensions.
 *
 *   const dungeon = await loadKit('dungeon');
 *   const wall = dungeon.spawn('wall', { x: 0, z: -8 });
 *
 * Les noms de modèles sont ceux des fichiers KayKit : voir la page /catalog.html pour les parcourir.
 */

export const KIT_NAMES = ['dungeon', 'furniture', 'restaurant', 'halloween', 'prototype', 'medieval', 'skeletons'] as const;
export type KitName = (typeof KIT_NAMES)[number];

export interface KitModelInfo {
  name: string;
  category: string | null;
  /** Dimensions de la boîte englobante [x, y, z], en unités du modèle. */
  size: [number, number, number];
  min: [number, number, number];
}

export interface SpawnOptions {
  x?: number; y?: number; z?: number;
  /** Rotation autour de l'axe vertical (radians). */
  ry?: number;
  scale?: number;
  parent?: THREE.Object3D;
  /** true par défaut : le modèle porte et reçoit les ombres. */
  shadows?: boolean;
}

export class Kit {
  private protos = new Map<string, THREE.Object3D>();

  constructor(readonly name: KitName, scene: THREE.Object3D, readonly models: KitModelInfo[]) {
    for (const child of scene.children) this.protos.set(child.name, child);
  }

  has(model: string): boolean { return this.protos.has(model); }
  info(model: string): KitModelInfo | undefined { return this.models.find((m) => m.name === model); }

  /** Clone un modèle (géométrie et matériaux partagés, donc peu coûteux). */
  create(model: string): THREE.Object3D {
    const proto = this.protos.get(model);
    if (!proto) throw new Error(`Modèle « ${model} » absent du kit ${this.name}`);
    const c = proto.clone();
    c.position.set(0, 0, 0);
    return c;
  }

  /** Clone un modèle, le place et l'ajoute à la scène (ou au parent donné). */
  spawn(model: string, o: SpawnOptions & { parent: THREE.Object3D }): THREE.Object3D {
    const c = this.create(model);
    c.position.set(o.x ?? 0, o.y ?? 0, o.z ?? 0);
    c.rotation.y = o.ry ?? 0;
    if (o.scale) c.scale.setScalar(o.scale);
    if (o.shadows === false) c.traverse((m) => { m.castShadow = m.receiveShadow = false; });
    o.parent.add(c);
    return c;
  }
}

const cache = new Map<KitName, Promise<Kit>>();
const toonByMaterial = new Map<string, THREE.MeshToonMaterial>();

/** Convertit les matériaux du kit en matériaux toon (même rendu que les personnages). */
function toToon(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const src = m.material as THREE.MeshStandardMaterial;
    let mat = toonByMaterial.get(src.uuid);
    if (!mat) {
      mat = new THREE.MeshToonMaterial({ map: src.map, color: src.color, gradientMap, transparent: src.transparent, opacity: src.opacity });
      toonByMaterial.set(src.uuid, mat);
    }
    m.material = mat;
    m.castShadow = m.receiveShadow = true;
  });
}

export function loadKit(name: KitName, base = '/assets/kits/'): Promise<Kit> {
  let p = cache.get(name);
  if (!p) {
    p = Promise.all([
      loader.loadAsync(`${base}${name}.glb`),
      fetch(`${base}${name}.json`).then((r) => r.json() as Promise<{ models: KitModelInfo[] }>),
    ]).then(([gltf, manifest]) => {
      toToon(gltf.scene);
      return new Kit(name, gltf.scene, manifest.models);
    });
    cache.set(name, p);
  }
  return p;
}
