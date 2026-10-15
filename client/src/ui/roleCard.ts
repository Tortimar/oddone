import * as THREE from 'three';
import type { CharacterConfig } from '@oddone/shared';
import { $ } from './dom.ts';
import { composeCharacter, playAnimation, updateActor, type Actor } from '../characters/character.ts';

/**
 * Rôle secret, façon « Among Us » : après l'écran des règles, l'écran devient noir, ton héros
 * apparaît seul au milieu, éclairé en rouge (imposteur) ou en bleu (héros), le rôle en grand
 * au-dessus et une phrase en dessous. Ensuite, un petit rappel reste dans un coin jusqu'à la
 * révélation. Le rôle n'arrive qu'à ce joueur (événement `role:secret`).
 */

/** Durée de l'écran (la phase `roleReveal` dure 5,5 s). */
const SHOW_MS = 5400;

/** La petite scène 3D du personnage, créée une fois et réutilisée. */
class RoleStage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(24, 1, 0.1, 40);
  readonly rimL = new THREE.SpotLight('#ff2a2a', 0, 14, 0.7, 0.6, 1);
  readonly rimR = new THREE.SpotLight('#ff2a2a', 0, 14, 0.7, 0.6, 1);
  readonly key = new THREE.DirectionalLight('#ffffff', 0);
  readonly fill = new THREE.HemisphereLight('#ffffff', '#000000', 0);
  actor: Actor | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.rimL.position.set(-2.6, 3.2, -2.2); this.rimR.position.set(2.6, 3.2, -2.2);
    this.key.position.set(0.5, 2.5, 4);
    for (const l of [this.rimL, this.rimR]) { l.target.position.set(0, 1.1, 0); this.scene.add(l, l.target); }
    this.scene.add(this.key, this.fill);
  }

  /** Le héros du joueur, au centre ; teinte des lumières selon le rôle. */
  setup(cfg: CharacterConfig, imposter: boolean): void {
    this.clear();
    const model = composeCharacter({ ...cfg, right: 'none', left: 'none' });
    const root = new THREE.Group();
    root.add(model.holder);
    this.scene.add(root);
    this.actor = { root, model };
    const c = imposter ? '#ff2626' : '#3f9dff';
    this.rimL.color.set(c); this.rimR.color.set(c);
    this.key.color.set(imposter ? '#ffd6d0' : '#e8f2ff');
    playAnimation(this.actor, 'Idle', { fade: 0 });
  }

  clear(): void {
    if (!this.actor) return;
    this.actor.root.removeFromParent();
    this.actor.model?.mixer.stopAllAction();
    this.actor = null;
  }

  resize(): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** k : temps écoulé (s) depuis le début de l'écran. */
  frame(k: number, dt: number, imposter: boolean): void {
    const a = this.actor;
    if (!a) return;
    // les lumières s'allument : d'abord la silhouette à contre-jour, puis le visage
    const on = Math.min(1, Math.max(0, (k - 0.25) / 0.7));
    const flicker = imposter ? 0.85 + 0.15 * Math.sin(k * 23) * Math.sin(k * 7.1) : 1;
    this.rimL.intensity = this.rimR.intensity = 28 * on * flicker;
    this.key.intensity = 1.1 * Math.min(1, Math.max(0, (k - 0.7) / 0.8));
    this.fill.intensity = 0.3 * on;
    // le geste du rôle, une fois la lumière venue
    if (k > 0.9 && a.currentName === 'Idle') playAnimation(a, imposter ? 'Taunt' : 'Cheer', { once: true, fade: 0.25, restart: true });
    if (k > 3.4 && a.currentName !== (imposter ? 'Idle_Combat' : 'Idle_B')) playAnimation(a, imposter ? 'Idle_Combat' : 'Idle_B', { fade: 0.4 });
    // il se tourne doucement vers nous, la caméra s'approche un peu
    a.root.rotation.y = (imposter ? 0.5 : -0.5) * Math.max(0, 1 - k / 1.6) ** 2;
    const s = a.model?.size ?? 1;
    const dist = (7.6 - 0.7 * Math.min(1, k / 5)) * s;
    this.camera.position.set(0, 1.5 * s, dist);
    this.camera.lookAt(0, 1.15 * s, 0);
    updateActor(a, k, dt, false);
    this.renderer.render(this.scene, this.camera);
  }
}

export function initRoleCard() {
  const wrap = $('role'), badge = $('roleBadge');
  let hideTimer = 0, raf = 0;
  let stage: RoleStage | null = null;

  function stop() {
    cancelAnimationFrame(raf); raf = 0;
    stage?.clear();
  }

  return {
    /** `advantage` : ce que l'imposteur gagne dans ce mini-jeu (texte secret) ; `cfg` : la tenue du joueur. */
    show(imposter: boolean, quest: string, advantage: { name: string; secret: string } | undefined, cfg: CharacterConfig) {
      wrap.classList.toggle('imp', imposter);
      $('roleName').textContent = imposter ? 'Imposteur' : 'Héros';
      const text = $('roleText');
      text.innerHTML = '';
      const p = document.createElement('p');
      p.textContent = imposter
        ? `Sabote « ${quest} »… sans te faire démasquer au comptoir.`
        : `Gagne « ${quest} »… et démasque l'imposteur.`;
      text.append(p);
      if (imposter && advantage) {
        const adv = document.createElement('p');
        adv.className = 'adv';
        adv.innerHTML = `<b></b><span></span>`;
        adv.querySelector('b')!.textContent = advantage.name;
        adv.querySelector('span')!.textContent = advantage.secret;
        text.append(adv);
      }
      // relance les animations CSS
      wrap.classList.remove('play'); void wrap.offsetWidth; wrap.classList.add('play');
      wrap.hidden = false;
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => { wrap.hidden = true; stop(); }, SHOW_MS);
      badge.textContent = imposter ? 'Ton rôle : imposteur' : 'Ton rôle : héros';
      badge.classList.toggle('imp', imposter);

      // le personnage en 3D (si le rendu échoue, l'écran reste lisible sans lui)
      try {
        stage ??= new RoleStage($<HTMLCanvasElement>('roleCanvas'));
        stage.setup(cfg, imposter);
        stage.resize();
        const t0 = performance.now();
        let last = t0;
        cancelAnimationFrame(raf);
        const loop = (now: number) => {
          const dt = Math.min(0.05, (now - last) / 1000); last = now;
          stage!.frame((now - t0) / 1000, dt, imposter);
          if (!wrap.hidden) raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      } catch { /* pas de 3D : tant pis */ }
    },
    /** Le rappel n'est visible que tant que le rôle compte (jusqu'à la révélation). */
    setVisible(on: boolean) {
      badge.hidden = !on || !badge.textContent;
      if (!on) { wrap.hidden = true; stop(); }
    },
    reset() { badge.textContent = ''; badge.hidden = true; wrap.hidden = true; stop(); },
    /** L'écran noir couvre tout : inutile de dessiner la scène du jeu derrière. */
    get covering() { return !wrap.hidden; },
  };
}
