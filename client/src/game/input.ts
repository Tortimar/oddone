import { canvas } from '../engine/render.ts';

/** Clavier (ZQSD/WASD selon la disposition physique, flèches), souris pour la caméra, boutons tactiles. */

export const keys = { up: 0, down: 0, left: 0, right: 0 };
export const actions = { jump: false, act: false };
export const look = { yaw: 0, pitch: 0.42 };
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
export function consumeActions(): void { actions.jump = false; actions.act = false; }

const isTyping = (e: Event) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
};

export function initInput(onEscape: () => void): void {
  window.addEventListener('keydown', (e) => {
    if (!enabled || isTyping(e)) return;
    const k = CODE_TO_KEY[e.code];
    if (k) { keys[k] = 1; e.preventDefault(); }
    else if (e.code === 'Space') { if (!e.repeat) actions.jump = true; e.preventDefault(); }
    else if (e.code === 'KeyE' || e.code === 'Enter') { if (!e.repeat) actions.act = true; e.preventDefault(); }
    else if (e.code === 'Escape') onEscape();
  });
  window.addEventListener('keyup', (e) => { const k = CODE_TO_KEY[e.code]; if (k) keys[k] = 0; });
  window.addEventListener('blur', releaseKeys);

  // glisser pour tourner la caméra
  let drag: { x: number; y: number; id: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, id: e.pointerId }; canvas.setPointerCapture(e.pointerId); canvas.focus(); });
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
