import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { gradientMap } from '../engine/toon.ts';
import { CLIPS, loader } from './library.ts';
import type { Actor, CharacterModel } from './character.ts';

/**
 * Squelettes KayKit (CC0) : ennemis ou figurants pour les mini-jeux.
 * Ils ont exactement le même squelette d'os que les héros : toutes les animations de CLIPS
 * marchent dessus, plus les leurs (Skeletons_Awaken_Standing, Spawn_Ground_Skeletons,
 * Death_C_Skeletons, Death_C_Skeletons_Resurrect…).
 *
 *   const minion = await createSkeleton('minion');
 *   scene.add(minion.root);
 *   playAnimation(minion, 'Skeletons_Awaken_Standing', { once: true });
 *   // dans la boucle : updateActor(minion, t, dt, false)
 */

export type SkeletonKind = 'minion' | 'warrior' | 'rogue' | 'mage';

const sources = new Map<SkeletonKind, Promise<THREE.Object3D>>();

function source(kind: SkeletonKind): Promise<THREE.Object3D> {
  let p = sources.get(kind);
  if (!p) {
    p = loader.loadAsync(`/assets/characters/skeleton_${kind}.glb`).then((g) => {
      const mats = new Map<string, THREE.MeshToonMaterial>();
      g.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const src = m.material as THREE.MeshStandardMaterial;
        if (!mats.has(src.uuid)) mats.set(src.uuid, new THREE.MeshToonMaterial({ map: src.map, color: src.color, gradientMap }));
        m.material = mats.get(src.uuid)!;
        m.castShadow = true;
        m.frustumCulled = false;
      });
      return g.scene;
    });
    sources.set(kind, p);
  }
  return p;
}

export async function createSkeleton(kind: SkeletonKind): Promise<Actor & { model: CharacterModel }> {
  const model = SkeletonUtils.clone(await source(kind));
  const holder = new THREE.Group();
  holder.add(model);
  const mixer = new THREE.AnimationMixer(model);
  const actions: Record<string, THREE.AnimationAction> = {};
  for (const n in CLIPS) actions[n] = mixer.clipAction(CLIPS[n]);
  const root = new THREE.Group();
  root.add(holder);
  return { root, model: { holder, mixer, actions, ticks: [], size: 1 } };
}
