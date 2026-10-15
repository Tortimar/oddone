import * as THREE from 'three';
import { BRAWL, DIR_VEC, SLOT_COLORS, type Box, type CharacterConfig, type ControlMap, type Dir, type PlayerInfo, type Transform } from '@oddone/shared';
import { angleDamp, damp, scene } from '../engine/render.ts';
import { CLIPS } from '../characters/library.ts';
import { playAnimation, setActorModel, updateActor, type Actor } from '../characters/character.ts';
import { NameTag } from '../characters/nameTag.ts';
import type { Tavern, World } from '../world/tavern.ts';
import { actions, keys, look } from './input.ts';
import { resolveCollisions } from './physics.ts';

const SPEED = 6.2, GRAVITY = 26, JUMP = 9;
/** Hauteur qu'on franchit sans sauter (petite marche). */
const STEP_UP = 0.35;
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

  /** Objet imposé dans la main droite (l'épée de la Horde de Gobelins), quelle que soit la tenue. */
  equipped: string | null = null;

  applyLook(cfg: CharacterConfig, force = false): void {
    const eff = this.equipped ? { ...cfg, right: this.equipped } : cfg;
    const key = JSON.stringify(eff);
    if (!force && key === this.cfgKey) return;
    this.cfg = cfg; this.cfgKey = key;
    setActorModel(this, eff);
    this.tag.setHeight(TAG_HEIGHT * (this.model?.size ?? 1));
  }

  /** Met (ou retire, avec null) un objet dans la main droite, le temps d'un mini-jeu. */
  equip(item: string | null): void {
    if (item === this.equipped) return;
    this.equipped = item;
    this.applyLook(this.cfg, true);
  }

  setIdentity(name: string, slot: number): void {
    this.name = name; this.slot = slot;
    this.tag.set(name, SLOT_COLORS[slot % 4]);
  }

  dispose(): void { this.root.removeFromParent(); this.model?.mixer.stopAllAction(); }

  /** Réaction en cours (au comptoir : content ou pas, quand les pièces d'or changent de main). */
  protected reaction: { name: string; until: number } | null = null;

  /** Joue une réaction courte (une seule à la fois), puis l'animation normale reprend. */
  react(name: string): void {
    const now = performance.now() / 1000;
    if (this.reaction && this.reaction.until > now) return;
    const clip = CLIPS[name];
    if (!clip) return;
    this.reaction = { name, until: now + Math.min(2.2, clip.duration) };
    playAnimation(this, name, { once: true, fade: 0.15, restart: true });
  }
}

type SitPhase = 'down' | 'idle' | 'up' | null;

export class LocalPlayer extends PlayerBase {
  velocity = new THREE.Vector3();
  grounded = true;
  yaw = Math.PI;
  seat = -1;
  sitPhase: SitPhase = null;
  private animTimer = 0;
  frozen = false; // atelier ouvert, compte à rebours… : pas de déplacement
  faceYaw: number | null = null;
  /** Multiplicateur de vitesse (mini-jeux : joueur maudit, sprint de l'imposteur). */
  speedMul = 1;
  /** Animation imposée tant qu'elle n'est pas finie (mini-jeux : « touché ! », victoire). */
  private pose: string | null = null;
  private stool = { x: 0, z: 0 };
  /** Recul après un coup : pendant ce temps, les touches ne pilotent plus. */
  private knockTimer = 0;
  private punchSide = false;
  /** Mini-jeux en grille : déplacements dans 4 directions seulement (la dernière touche gagne). */
  fourWay = false;
  /** Touches haut, droite, bas, gauche → direction réellement prise (commandes mélangées). */
  controls: ControlMap | null = null;
  /** Taille des cases : en ligne droite, on se recentre doucement sur l'axe du chemin. */
  laneAssist = 0;
  canJump = true;
  /** Démarche traînante (zombie, maudit du Bal des Squelettes) au lieu de la course. */
  walkAnim = false;
  /** Ordre d'appui des touches (la plus récente en dernier). */
  private pressed: Dir[] = [];

  spawn(): void {
    this.root.position.set((Math.random() - 0.5) * 3, 0, 4.6);
    this.yaw = Math.PI; this.seat = -1; this.sitPhase = null; this.velocity.set(0, 0, 0); this.grounded = true;
    look.yaw = 0;
    playAnimation(this, 'Idle');
  }

  sit(seat: number, tavern: Tavern): void {
    const s = tavern.stools[seat];
    this.stool = { x: s.x, z: s.z };
    this.seat = seat; this.sitPhase = 'down';
    this.yaw = Math.PI; // face au comptoir
    this.velocity.set(0, 0, 0);
    // les hanches de la pose assise tombent au-dessus du tabouret (perso tourné vers -z)
    this.root.position.set(s.x + tavern.sitOffset.x, 0, s.z + tavern.sitOffset.z);
    this.animTimer = playAnimation(this, 'Sit_Chair_Down', { once: true, speed: 1.5, fade: 0.12, restart: true });
  }

  /** Assis d'un coup, sans animation (retour d'un mini-jeu). */
  sitInstant(seat: number, tavern: Tavern): void {
    this.sit(seat, tavern);
    this.sitPhase = 'idle'; this.animTimer = 0; this.pose = null;
    playAnimation(this, 'Sit_Chair_Idle', { fade: 0, restart: true });
  }

  /** Debout à un endroit précis (départ d'un mini-jeu, marche du podium). */
  placeAt(x: number, z: number, yaw: number, y = 0): void {
    // (animTimer aussi : une pose « sans fin », comme la chute, le laisserait à Infinity et le
    // héros glisserait ensuite sans plus jamais courir)
    this.seat = -1; this.sitPhase = null; this.pose = null; this.knockTimer = 0; this.animTimer = 0;
    this.root.position.set(x, y, z);
    this.velocity.set(0, 0, 0); this.grounded = true;
    this.yaw = yaw; this.root.rotation.y = yaw;
    playAnimation(this, 'Idle', { fade: 0.1 });
  }

  /**
   * Joue une animation qui prend le pas sur la marche. `once: false` (boucle) ou `hold` (jouée une
   * fois puis figée sur sa dernière image) : on la garde jusqu'à `clearPose` ou `placeAt`.
   */
  playPose(name: string, o: { once?: boolean; speed?: number; hold?: boolean } = {}): number {
    this.pose = name;
    const d = playAnimation(this, name, { once: o.once ?? true, speed: o.speed, fade: 0.1, restart: true });
    this.animTimer = o.once === false || o.hold ? Infinity : d;
    return d;
  }
  clearPose(): void { this.pose = null; this.animTimer = 0; }

  /** Coup de poing (au sol, gauche et droite en alternance) ou coup de pied (en l'air). */
  attack(kick: boolean): void {
    this.punchSide = !this.punchSide;
    this.playPose(kick ? 'Unarmed_Melee_Attack_Kick' : this.punchSide ? 'Unarmed_Melee_Attack_Punch_A' : 'Unarmed_Melee_Attack_Punch_B', { speed: 1.5 });
  }

  /** Coup d'épée (Horde de Gobelins) : taille et revers en alternance. */
  slash(): void {
    this.punchSide = !this.punchSide;
    this.playPose(this.punchSide ? '1H_Melee_Attack_Slice_Horizontal' : '1H_Melee_Attack_Chop', { speed: 1.8 });
  }

  /** Reçu un coup : projeté dans la direction du coup, un peu en l'air. */
  knock(dir: [number, number], kick: boolean): void {
    const f = kick ? BRAWL.kick : BRAWL.punch;
    this.velocity.set(dir[0] * f.push, f.lift, dir[1] * f.push);
    this.grounded = false;
    this.knockTimer = 0.5;
    this.yaw = Math.atan2(-dir[0], -dir[1]); // face à l'agresseur
    this.playPose('Hit_A', { speed: 1.2 });
  }

  /** Renvoie true quand le joueur est complètement debout. */
  standUp(): void {
    if (this.seat < 0 || this.sitPhase === 'up') return;
    this.sitPhase = 'up';
    this.animTimer = playAnimation(this, 'Sit_Chair_StandUp', { once: true, speed: 1.6, fade: 0.12, restart: true });
  }

  update(t: number, dt: number, world: World, others: THREE.Vector3[]): void {
    const P = this.root.position;
    if (this.seat >= 0) {
      // fin d'une réaction : on se rassoit comme il faut
      if (this.reaction && performance.now() / 1000 >= this.reaction.until) {
        this.reaction = null;
        if (this.sitPhase === 'idle') playAnimation(this, 'Sit_Chair_Idle', { fade: 0.25 });
      }
      this.animTimer -= dt;
      if (this.sitPhase === 'down' && this.animTimer <= 0) { this.sitPhase = 'idle'; playAnimation(this, 'Sit_Chair_Idle', { fade: 0.2 }); }
      if (this.sitPhase === 'up' && this.animTimer <= 0) {
        const s = this.stool;
        P.set(s.x, 0, s.z + 1.2); this.yaw = 0; look.yaw = 0;
        this.seat = -1; this.sitPhase = null;
      }
      this.root.rotation.y = this.yaw;
      updateActor(this, t, dt, false);
      return;
    }

    let wx = 0, wz = 0;
    if (this.fourWay) {
      // la dernière touche enfoncée l'emporte ; la caméra est fixe (haut = −z)
      const held: Record<Dir, number> = { up: keys.up, right: keys.right, down: keys.down, left: keys.left };
      this.pressed = this.pressed.filter((d) => held[d]);
      for (const d of ['up', 'right', 'down', 'left'] as Dir[]) if (held[d] && !this.pressed.includes(d)) this.pressed.push(d);
      const key = this.pressed[this.pressed.length - 1];
      if (key && !this.frozen) {
        const idx = ['up', 'right', 'down', 'left'].indexOf(key);
        [wx, wz] = DIR_VEC[this.controls ? this.controls[idx] : key];
      }
    } else {
      let ix = keys.right - keys.left, iz = keys.down - keys.up;
      if (this.frozen) { ix = 0; iz = 0; }
      const len = Math.hypot(ix, iz);
      if (len > 0) { ix /= len; iz /= len; }
      // déplacement relatif à la caméra
      const fx = -Math.sin(look.yaw), fz = -Math.cos(look.yaw), rx = Math.cos(look.yaw), rz = -Math.sin(look.yaw);
      wx = rx * ix - fx * iz; wz = rz * ix - fz * iz;
    }
    const top = SPEED * this.speedMul;
    if (this.knockTimer > 0) {
      // projeté : on glisse, les touches attendront
      this.knockTimer -= dt;
      this.velocity.x = damp(this.velocity.x, 0, 1.5, dt);
      this.velocity.z = damp(this.velocity.z, 0, 1.5, dt);
    } else {
      this.velocity.x = damp(this.velocity.x, wx * top, 12, dt);
      this.velocity.z = damp(this.velocity.z, wz * top, 12, dt);
      if (this.laneAssist > 0 && this.grounded) {
        // dans un couloir d'une case, on glisse vers son axe (comme dans un labyrinthe)
        const c = this.laneAssist;
        if (wx !== 0) P.z = damp(P.z, Math.round(P.z / c) * c, 9, dt);
        if (wz !== 0) P.x = damp(P.x, Math.round(P.x / c) * c, 9, dt);
      }
    }

    if (actions.jump && this.grounded && !this.frozen && this.canJump) {
      this.velocity.y = JUMP; this.grounded = false;
      this.animTimer = 0.18;
      playAnimation(this, 'Jump_Start', { once: true, speed: 1.6, fade: 0.06, restart: true });
    }
    P.x += this.velocity.x * dt;
    P.z += this.velocity.z * dt;
    // marches (podium) : trop hautes, ce sont des murs ; sinon on peut se tenir dessus
    let walls: Box[] = world.colliders, ground = world.ground ? world.ground(P.x, P.z) : 0;
    if (world.steps?.length) {
      walls = world.colliders.concat(world.steps.filter((s) => s.top > P.y + STEP_UP));
      resolveCollisions(P, world.bounds, walls, world.circles.concat(others.map((o) => ({ x: o.x, z: o.z, r: 0.45 }))));
      for (const s of world.steps) if (s.top <= P.y + STEP_UP && P.x >= s.x0 && P.x <= s.x1 && P.z >= s.z0 && P.z <= s.z1) ground = Math.max(ground, s.top);
    } else resolveCollisions(P, world.bounds, walls, world.circles.concat(others.map((o) => ({ x: o.x, z: o.z, r: 0.45 }))));
    // gouffre : pas de sol sous les pieds (ou déjà trop bas pour remonter sur le bord)
    if (world.floor && (!world.floor(P.x, P.z) || P.y < -0.4)) ground = -Infinity;
    if (this.grounded && P.y > ground + 0.02) {
      if (P.y - ground <= STEP_UP) P.y = ground; // petite descente : on suit le sol
      else { this.grounded = false; this.velocity.y = 0; } // au bord d'une marche : on tombe
    } else if (this.grounded) P.y = ground;
    let landed = false;
    if (!this.grounded) {
      this.velocity.y -= GRAVITY * dt;
      P.y += this.velocity.y * dt;
      if (P.y <= ground) { P.y = ground; this.velocity.y = 0; this.grounded = true; landed = true; }
    }

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.knockTimer > 0) { /* garde la face vers l'agresseur */ }
    else if (speed > 0.5) this.yaw = angleDamp(this.yaw, Math.atan2(this.velocity.x, this.velocity.z), 12, dt);
    else if (this.faceYaw !== null) this.yaw = angleDamp(this.yaw, this.faceYaw, 8, dt);
    this.root.rotation.y = this.yaw;

    this.animTimer -= dt;
    if (this.pose) {
      if (this.animTimer <= 0) this.pose = null;
      else { updateActor(this, t, dt, false); return; }
    }
    if (landed) { playAnimation(this, 'Jump_Land', { once: true, speed: 1.8, fade: 0.05, restart: true }); this.animTimer = 0.2; }
    else if (!this.grounded) { if (this.animTimer <= 0) playAnimation(this, 'Jump_Idle', { fade: 0.2 }); }
    else if (this.animTimer > 0) { /* fin du saut */ }
    else if (speed > 0.6 && this.walkAnim) {
      playAnimation(this, 'Walking_A', { fade: 0.2 });
      this.current?.setEffectiveTimeScale(Math.min(1.8, Math.max(0.6, speed / 2.6)));
    } else if (speed > 0.6) {
      playAnimation(this, 'Running_A', { fade: 0.15 });
      this.current?.setEffectiveTimeScale(0.6 + 0.5 * Math.min(1.4, speed / SPEED));
    } else playAnimation(this, 'Idle', { fade: 0.25 });

    updateActor(this, t, dt, !this.grounded);
  }

  transform(): Transform {
    const P = this.root.position;
    return { p: [round(P.x), round(P.y), round(P.z)], r: round(this.yaw), a: this.currentName ?? 'Idle' };
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
const ONE_SHOT = /Down|StandUp|Jump_Start|Jump_Land|Interact|PickUp|Hit_|Death_|Attack/;

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

  /** Le prochain message le placera d'un coup (changement de lieu : taverne ↔ arène). */
  snapNext(): void { this.placed = false; }

  /** Place le joueur sans interpolation (bots qui changent d'état). */
  teleport(t: Transform): void { this.placed = false; this.setTransform(t); }

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
    if (this.reaction && performance.now() / 1000 >= this.reaction.until) this.reaction = null;
    if (!this.reaction && this.anim !== this.currentName) playAnimation(this, this.anim, { once: ONE_SHOT.test(this.anim), fade: 0.15 });
    updateActor(this, t, dt, this.anim === 'Jump_Idle');
  }
}
