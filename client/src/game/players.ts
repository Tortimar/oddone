import * as THREE from 'three';
import { SLOT_COLORS, type CharacterConfig, type PlayerInfo, type Transform } from '@oddone/shared';
import { angleDamp, damp, scene } from '../engine/render.ts';
import { CLIPS } from '../characters/library.ts';
import { playAnimation, setActorModel, updateActor, type Actor } from '../characters/character.ts';
import { NameTag } from '../characters/nameTag.ts';
import type { Tavern } from '../world/tavern.ts';
import { actions, keys, look } from './input.ts';
import { resolveCollisions } from './physics.ts';

const SPEED = 6.2, GRAVITY = 26, JUMP = 9;
const TAG_HEIGHT = 3.0;

/** Base commune joueur local / distant. */
abstract class PlayerBase implements Actor {
  root = new THREE.Group();
  model?: Actor['model'];
  current?: THREE.AnimationAction;
  currentName?: string;
  tag: NameTag;
  cfgKey = '';

  constructor(public name: string, public cfg: CharacterConfig, public slot: number) {
    scene.add(this.root);
    this.tag = new NameTag(this.root);
    this.applyLook(cfg, true);
    this.tag.set(name, SLOT_COLORS[slot % 4]);
  }

  applyLook(cfg: CharacterConfig, force = false): void {
    const key = JSON.stringify(cfg);
    if (!force && key === this.cfgKey) return;
    this.cfg = cfg; this.cfgKey = key;
    setActorModel(this, cfg);
    this.tag.setHeight(TAG_HEIGHT * (this.model?.size ?? 1));
  }

  setIdentity(name: string, slot: number): void {
    this.name = name; this.slot = slot;
    this.tag.set(name, SLOT_COLORS[slot % 4]);
  }

  dispose(): void { scene.remove(this.root); this.model?.mixer.stopAllAction(); }
}

type SitPhase = 'down' | 'idle' | 'up' | null;

export class LocalPlayer extends PlayerBase {
  velocity = new THREE.Vector3();
  grounded = true;
  yaw = Math.PI;
  seat = -1;
  sitPhase: SitPhase = null;
  private animTimer = 0;
  frozen = false; // atelier ouvert : pas de déplacement
  faceYaw: number | null = null;

  spawn(): void {
    this.root.position.set((Math.random() - 0.5) * 3, 0, 4.6);
    this.yaw = Math.PI; this.seat = -1; this.sitPhase = null; this.velocity.set(0, 0, 0); this.grounded = true;
    look.yaw = 0;
    playAnimation(this, 'Idle');
  }

  sit(seat: number, tavern: Tavern): void {
    const s = tavern.stools[seat];
    this.seat = seat; this.sitPhase = 'down';
    this.yaw = Math.PI; // face au comptoir
    this.velocity.set(0, 0, 0);
    // les hanches de la pose assise tombent au-dessus du tabouret (perso tourné vers -z)
    this.root.position.set(s.x + tavern.sitOffset.x, 0, s.z + tavern.sitOffset.z);
    this.animTimer = playAnimation(this, 'Sit_Chair_Down', { once: true, speed: 1.5, fade: 0.12, restart: true });
  }

  /** Renvoie true quand le joueur est complètement debout. */
  standUp(): void {
    if (this.seat < 0 || this.sitPhase === 'up') return;
    this.sitPhase = 'up';
    this.animTimer = playAnimation(this, 'Sit_Chair_StandUp', { once: true, speed: 1.6, fade: 0.12, restart: true });
  }

  update(t: number, dt: number, tavern: Tavern, others: THREE.Vector3[]): void {
    const P = this.root.position;
    if (this.seat >= 0) {
      this.animTimer -= dt;
      if (this.sitPhase === 'down' && this.animTimer <= 0) { this.sitPhase = 'idle'; playAnimation(this, 'Sit_Chair_Idle', { fade: 0.2 }); }
      if (this.sitPhase === 'up' && this.animTimer <= 0) {
        const s = tavern.stools[this.seat];
        P.set(s.x, 0, s.z + 1.2); this.yaw = 0; look.yaw = 0;
        this.seat = -1; this.sitPhase = null;
      }
      this.root.rotation.y = this.yaw;
      updateActor(this, t, dt, false);
      return;
    }

    let ix = keys.right - keys.left, iz = keys.down - keys.up;
    if (this.frozen) { ix = 0; iz = 0; }
    const len = Math.hypot(ix, iz);
    if (len > 0) { ix /= len; iz /= len; }
    // déplacement relatif à la caméra
    const fx = -Math.sin(look.yaw), fz = -Math.cos(look.yaw), rx = Math.cos(look.yaw), rz = -Math.sin(look.yaw);
    const wx = rx * ix - fx * iz, wz = rz * ix - fz * iz;
    this.velocity.x = damp(this.velocity.x, wx * SPEED, 12, dt);
    this.velocity.z = damp(this.velocity.z, wz * SPEED, 12, dt);

    if (actions.jump && this.grounded && !this.frozen) {
      this.velocity.y = JUMP; this.grounded = false;
      this.animTimer = 0.18;
      playAnimation(this, 'Jump_Start', { once: true, speed: 1.6, fade: 0.06, restart: true });
    }
    P.x += this.velocity.x * dt;
    P.z += this.velocity.z * dt;
    resolveCollisions(P, tavern.colliders, tavern.circles.concat(others.map((o) => ({ x: o.x, z: o.z, r: 0.45 }))));
    let landed = false;
    if (!this.grounded) {
      this.velocity.y -= GRAVITY * dt;
      P.y += this.velocity.y * dt;
      if (P.y <= 0) { P.y = 0; this.velocity.y = 0; this.grounded = true; landed = true; }
    }

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (speed > 0.5) this.yaw = angleDamp(this.yaw, Math.atan2(this.velocity.x, this.velocity.z), 12, dt);
    else if (this.faceYaw !== null) this.yaw = angleDamp(this.yaw, this.faceYaw, 8, dt);
    this.root.rotation.y = this.yaw;

    this.animTimer -= dt;
    if (landed) { playAnimation(this, 'Jump_Land', { once: true, speed: 1.8, fade: 0.05, restart: true }); this.animTimer = 0.2; }
    else if (!this.grounded) { if (this.animTimer <= 0) playAnimation(this, 'Jump_Idle', { fade: 0.2 }); }
    else if (this.animTimer > 0) { /* fin du saut */ }
    else if (speed > 0.6) {
      playAnimation(this, 'Running_A', { fade: 0.15 });
      this.current?.setEffectiveTimeScale(0.6 + 0.5 * Math.min(1, speed / SPEED));
    } else playAnimation(this, 'Idle', { fade: 0.25 });

    updateActor(this, t, dt, !this.grounded);
  }

  transform(): Transform {
    const P = this.root.position;
    return { p: [round(P.x), round(P.y), round(P.z)], r: round(this.yaw), a: this.currentName ?? 'Idle' };
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
const ONE_SHOT = /Down|StandUp|Jump_Start|Jump_Land|Interact/;

export class RemotePlayer extends PlayerBase {
  target = new THREE.Vector3(0, 0, 6);
  targetYaw = 0;
  anim = 'Idle';
  seat = -1;
  private placed = false;

  setInfo(info: PlayerInfo): void {
    this.applyLook(info.cfg);
    if (info.name !== this.name || info.slot !== this.slot) this.setIdentity(info.name, info.slot);
    this.seat = info.seat;
  }

  setTransform(t: Transform): void {
    this.target.set(t.p[0], t.p[1], t.p[2]);
    this.targetYaw = t.r;
    if (CLIPS[t.a]) this.anim = t.a;
    if (!this.placed) { this.root.position.copy(this.target); this.root.rotation.y = t.r; this.placed = true; }
  }

  update(t: number, dt: number): void {
    // interpolation douce entre deux messages (15 par seconde)
    this.root.position.lerp(this.target, 1 - Math.exp(-14 * dt));
    this.root.rotation.y = angleDamp(this.root.rotation.y, this.targetYaw, 14, dt);
    if (this.anim !== this.currentName) playAnimation(this, this.anim, { once: ONE_SHOT.test(this.anim), fade: 0.15 });
    updateActor(this, t, dt, this.anim === 'Jump_Idle');
  }
}
