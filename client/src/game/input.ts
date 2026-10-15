import { canvas } from '../engine/render.ts';

/** Clavier (ZQSD/WASD selon la disposition physique, flèches), souris pour la caméra, boutons tactiles. */

export const keys = { up: 0, down: 0, left: 0, right: 0 };
/** Impulsions d'une image : saut (Espace), action (E), valider (Entrée). */
export const actions = { jump: false, act: false, confirm: false, special: false };
export const look = { yaw: 0, pitch: 0.42 };
/** Clic gauche pendant que la souris est capturée (un coup d'épée, par exemple). */
export const pointer = { clicked: false };
let enabled = false;

const CODE_TO_KEY: Record<string, keyof typeof keys> = {
  KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
};

function releaseKeys(): void { for (const k of Object.keys(keys) as (keyof typeof keys)[]) keys[k] = 0; }

export function setInputEnabled(on: boolean): void {
  enabled = on;
  if (!on) releaseKeys();
}

/** À appeler en fin d'image : les actions sont des impulsions d'une image. */
export function consumeActions(): void { actions.jump = false; actions.act = false; actions.confirm = false; actions.special = false; pointer.clicked = false; }

const isTyping = (e: Event) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
};

/* ---------- Caméra à la souris (curseur capturé, comme dans un jeu à la 3e personne) ---------- */
let mouseLookWanted = false;
const MOUSE_YAW = 0.0024, MOUSE_PITCH = 0.0018;

/** Souris capturée : le curseur est caché et chaque mouvement tourne la caméra. */
export const mouseLocked = () => document.pointerLockElement === canvas;

/** Capture la souris si la caméra à la souris est voulue (à appeler sur un clic : le navigateur l'exige). */
export function captureMouse(): void { requestLock(); }

function requestLock(): void {
  if (!mouseLookWanted || mouseLocked() || !canvas.requestPointerLock) return;
  try {
    // « unadjustedMovement » : mouvement brut, sans l'accélération du système (repli si non géré)
    const p = (canvas.requestPointerLock as (o?: object) => Promise<void> | void)({ unadjustedMovement: true });
    if (p && typeof p.catch === 'function') p.catch(() => { try { void canvas.requestPointerLock(); } catch { /* refusé */ } });
  } catch { /* il faudra un clic */ }
}

/**
 * Active ou coupe la caméra à la souris. Le navigateur n'accepte de capturer la souris qu'après
 * une action du joueur (clic, touche) : sinon, un clic sur la scène la capture.
 */
export function setMouseLook(on: boolean): void {
  if (on === mouseLookWanted) return;
  mouseLookWanted = on;
  if (on) requestLock();
  else if (mouseLocked()) document.exitPointerLock();
  document.body.classList.toggle('mouselook-wanted', on);
}

export function initInput(onEscape: () => void): void {
  document.addEventListener('pointerlockchange', () => document.body.classList.toggle('mouselook', mouseLocked()));
  document.addEventListener('mousemove', (e) => {
    if (!mouseLocked() || !enabled) return;
    look.yaw -= e.movementX * MOUSE_YAW;
    look.pitch = Math.max(0.15, Math.min(0.85, look.pitch + e.movementY * MOUSE_PITCH));
  });

  window.addEventListener('keydown', (e) => {
    if (!enabled || isTyping(e)) return;
    const k = CODE_TO_KEY[e.code];
    if (k) { keys[k] = 1; e.preventDefault(); }
    else if (e.code === 'Space') { if (!e.repeat) actions.jump = true; e.preventDefault(); }
    else if (e.code === 'KeyE') { if (!e.repeat) actions.act = true; e.preventDefault(); }
    else if (e.code === 'KeyR') { if (!e.repeat) actions.special = true; e.preventDefault(); }
    else if (e.code === 'Enter' || e.code === 'NumpadEnter') { if (!e.repeat) actions.confirm = true; e.preventDefault(); }
    else if (e.code === 'Escape') onEscape();
  });
  window.addEventListener('keyup', (e) => { const k = CODE_TO_KEY[e.code]; if (k) keys[k] = 0; });
  window.addEventListener('blur', releaseKeys);

  // glisser pour tourner la caméra
  let drag: { x: number; y: number; id: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    // à la souris, un clic suffit pour (re)prendre la caméra ; au doigt, on garde le glisser
    if (e.pointerType === 'mouse' && mouseLocked() && e.button === 0) { pointer.clicked = true; return; }
    if (e.pointerType === 'mouse' && mouseLookWanted) { requestLock(); return; }
    if (mouseLocked()) return;
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId }; canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    look.yaw -= (e.clientX - drag.x) * 0.006;
    look.pitch = Math.max(0.15, Math.min(0.85, look.pitch + (e.clientY - drag.y) * 0.004));
    drag.x = e.clientX; drag.y = e.clientY;
  });
  const end = () => { drag = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  // boutons tactiles
  document.querySelectorAll<HTMLButtonElement>('#touch button').forEach((b) => {
    const k = b.dataset.k!;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); b.setPointerCapture(e.pointerId);
      if (k === 'jump') actions.jump = true; else if (k === 'act') actions.act = true; else keys[k as keyof typeof keys] = 1;
    });
    const up = () => { if (k in keys) keys[k as keyof typeof keys] = 0; };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
  });
}
