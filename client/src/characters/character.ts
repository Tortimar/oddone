import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CharacterConfig, KitClass } from '@oddone/shared';
import { CLIPS, LIB, kitMaterials, type SkinnedKey } from './library.ts';
import { buildAccessory, type Tick } from './accessories.ts';

/** Un personnage assemblé : pièces KayKit + accessoires, avec son mixer d'animation. */
export interface CharacterModel {
  holder: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Record<string, THREE.AnimationAction>;
  ticks: Tick[];
  size: number;
}

/** Tout ce qui joue des animations (joueurs, PNJ). */
export interface Actor {
  root: THREE.Group;
  model?: CharacterModel;
  current?: THREE.AnimationAction;
  currentName?: string;
}

export function composeCharacter(cfg: CharacterConfig): CharacterModel {
  const model = SkeletonUtils.clone(LIB.knight.gltf.scene);
  const bones: Record<string, THREE.Bone> = {};
  const toRemove: THREE.Object3D[] = [];
  let rig: THREE.Object3D | null = null;
  model.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones[o.name] = o as THREE.Bone;
    if ((o as THREE.Mesh).isMesh) toRemove.push(o);
  });
  for (const o of toRemove) {
    if (!rig && (o as THREE.SkinnedMesh).isSkinnedMesh) rig = o.parent;
    o.parent!.remove(o);
  }
  const rigParent: THREE.Object3D = rig ?? model;

  const skinnedPart = (cls: KitClass, key: SkinnedKey) => {
    const src = LIB[cls].skinned[key];
    if (!src) return;
    const m = new THREE.SkinnedMesh(src.geometry, kitMaterials(cls, cfg.hue, cfg.skin).skinned);
    m.position.copy(src.position); m.quaternion.copy(src.quaternion); m.scale.copy(src.scale);
    rigParent.add(m);
    m.bind(new THREE.Skeleton(src.skeleton.bones.map((b) => bones[b.name]), src.skeleton.boneInverses), src.bindMatrix);
    m.castShadow = true;
    m.frustumCulled = false;
  };
  const rigidPart = (cls: KitClass, key: string) => {
    const src = LIB[cls].rigid[key];
    const target = src && bones[src.parent!.name];
    if (!src || !target) return;
    const m = new THREE.Mesh(src.geometry, kitMaterials(cls, cfg.hue, cfg.skin).rigid);
    m.position.copy(src.position); m.quaternion.copy(src.quaternion); m.scale.copy(src.scale);
    m.castShadow = true;
    target.add(m);
  };

  const body = cfg.body as KitClass, head = cfg.head as KitClass;
  (['body', 'armL', 'armR', 'legL', 'legR'] as SkinnedKey[]).forEach((k) => skinnedPart(body, k));
  skinnedPart(head, 'head');
  if (cfg.hat !== 'none') rigidPart(cfg.hat as KitClass, 'hat');
  if (cfg.cape !== 'none') rigidPart(cfg.cape as KitClass, 'cape');
  for (const item of [cfg.right, cfg.left]) {
    if (item && item !== 'none') { const [cls, name] = item.split(':'); rigidPart(cls as KitClass, 'item:' + name); }
  }

  // accessoires modélisés : placés en pose de repos puis rattachés à leur os
  model.updateMatrixWorld(true);
  const ticks: Tick[] = [];
  for (const name of [cfg.face, cfg.top, cfg.neck, cfg.back]) {
    if (!name || name === 'none') continue;
    const a = buildAccessory(name, cfg.acol, head);
    const bone = a && bones[a.bone];
    if (!a || !bone) continue;
    const m = new THREE.Matrix4().makeTranslation(a.at.x, a.at.y, a.at.z).premultiply(bone.matrixWorld.clone().invert());
    const wrap = new THREE.Group();
    m.decompose(wrap.position, wrap.quaternion, wrap.scale);
    wrap.add(a.group);
    bone.add(wrap);
    if (a.tick) ticks.push(a.tick);
  }

  const size = Number(cfg.size) || 1;
  const holder = new THREE.Group();
  holder.scale.set(size, size > 1 ? size * 0.96 : size, size);
  holder.add(model);
  const mixer = new THREE.AnimationMixer(model);
  const actions: Record<string, THREE.AnimationAction> = {};
  for (const n in CLIPS) actions[n] = mixer.clipAction(CLIPS[n]);
  return { holder, mixer, actions, ticks, size };
}

/** Remplace le modèle d'un acteur (nouvelle tenue). */
export function setActorModel(actor: Actor, cfg: CharacterConfig): void {
  if (actor.model) { actor.root.remove(actor.model.holder); actor.model.mixer.stopAllAction(); }
  actor.model = composeCharacter(cfg);
  actor.root.add(actor.model.holder);
  actor.current = undefined;
  actor.currentName = undefined;
  playAnimation(actor, 'Idle');
}

export interface PlayOptions { once?: boolean; speed?: number; fade?: number; restart?: boolean }

/** Lance une animation avec fondu ; renvoie sa durée (secondes, vitesse comprise). */
export function playAnimation(actor: Actor, name: string, o: PlayOptions = {}): number {
  const a = actor.model?.actions[name];
  if (!a) return 0;
  const duration = a.getClip().duration / (o.speed ?? 1);
  if (actor.currentName === name && !o.restart) return duration;
  a.reset();
  a.enabled = true;
  a.setEffectiveTimeScale(o.speed ?? 1);
  a.setEffectiveWeight(1);
  a.setLoop(o.once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
  a.clampWhenFinished = !!o.once;
  if (actor.current && actor.current !== a && actor.current.getEffectiveWeight() > 0.01) a.crossFadeFrom(actor.current, o.fade ?? 0.18, false);
  a.play();
  actor.current = a;
  actor.currentName = name;
  return duration;
}

export function updateActor(actor: Actor, t: number, dt: number, airborne: boolean): void {
  if (!actor.model) return;
  actor.model.mixer.update(dt);
  for (const tick of actor.model.ticks) tick(t, dt, airborne);
}

/** Hanches en pose assise (racine au sol) : sert à régler la hauteur des tabourets. */
export function measureSitPose(cfg: CharacterConfig): THREE.Vector3 {
  const c = composeCharacter(cfg);
  c.holder.updateMatrixWorld(true);
  const hips = c.holder.getObjectByName('hips')!;
  c.actions.Sit_Chair_Idle.play();
  c.mixer.update(0.5);
  c.holder.updateMatrixWorld(true);
  const p = hips.getWorldPosition(new THREE.Vector3());
  c.mixer.stopAllAction();
  return p;
}
