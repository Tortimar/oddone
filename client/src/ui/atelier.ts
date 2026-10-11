import {
  ACCESSORY_COLORS, BACK_ACC, BODIES, CAPES, FACE_ACC, HATS, HEADS, HUES, LEFT_HAND, NECK_ACC, RIGHT_HAND,
  SIZES, SKINS, TOP_ACC, sanitizeName, type CharacterConfig, type Option,
} from '@oddone/shared';
import { $ } from './dom.ts';

/** Atelier de la couturière : modifie la tenue du joueur local. */

type ListKey = 'body' | 'head' | 'hat' | 'cape' | 'size' | 'top' | 'face' | 'neck' | 'back' | 'right' | 'left';
const LISTS: [string, readonly Option[], ListKey][] = [
  ['op-body', BODIES, 'body'], ['op-head', HEADS, 'head'], ['op-hat', HATS, 'hat'], ['op-cape', CAPES, 'cape'],
  ['op-size', SIZES, 'size'], ['op-top', TOP_ACC, 'top'], ['op-face', FACE_ACC, 'face'], ['op-neck', NECK_ACC, 'neck'],
  ['op-back', BACK_ACC, 'back'], ['op-right', RIGHT_HAND, 'right'], ['op-left', LEFT_HAND, 'left'],
];

export interface AtelierHooks {
  getProfile(): { name: string; cfg: CharacterConfig };
  /** Appelé à chaque modification (tenue ou pseudo). */
  onChange(name: string, cfg: CharacterConfig): void;
  onClose(): void;
}

const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
const maybe = (a: readonly Option[], p: number) => (Math.random() < p ? pick(a.slice(1))[0] : 'none');

export function initAtelier(h: AtelierHooks) {
  const panel = $('panel');
  const update = (patch: Partial<CharacterConfig>) => {
    const { name, cfg } = h.getProfile();
    h.onChange(name, { ...cfg, ...patch });
    sync();
  };

  for (const [id, list, key] of LISTS) {
    const el = $(id);
    el.innerHTML = list.map(([v, l]) => `<button data-v="${v}">${l}</button>`).join('');
    el.onclick = (e) => { const b = (e.target as HTMLElement).closest('button'); if (b) update({ [key]: b.dataset.v } as Partial<CharacterConfig>); };
  }
  $('sw-hue').innerHTML = HUES.map((hue) => hue === null
    ? '<button class="orig" data-v="" aria-label="Couleurs d\'origine"></button>'
    : `<button style="--c:hsl(${hue},68%,50%)" data-v="${hue}" aria-label="Teinte ${hue}"></button>`).join('');
  $('sw-hue').onclick = (e) => { const b = (e.target as HTMLElement).closest('button'); if (b) update({ hue: b.dataset.v === '' ? null : Number(b.dataset.v) }); };
  $('sw-skin').innerHTML = SKINS.map((c) => c === null
    ? '<button class="orig" data-v="" aria-label="Peau d\'origine"></button>'
    : `<button style="--c:${c}" data-v="${c}" aria-label="Peau ${c}"></button>`).join('');
  $('sw-skin').onclick = (e) => { const b = (e.target as HTMLElement).closest('button'); if (b) update({ skin: b.dataset.v || null }); };
  $('sw-acol').innerHTML = ACCESSORY_COLORS.map((c) => `<button style="--c:${c}" data-v="${c}" aria-label="Couleur ${c}"></button>`).join('');
  $('sw-acol').onclick = (e) => { const b = (e.target as HTMLElement).closest('button'); if (b) update({ acol: b.dataset.v! }); };

  const tabs = panel.querySelector<HTMLElement>('.tabs')!;
  tabs.onclick = (e) => {
    const b = (e.target as HTMLElement).closest('button'); if (!b) return;
    tabs.querySelectorAll('button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    panel.querySelectorAll<HTMLElement>('[data-sec]').forEach((x) => { x.hidden = x.dataset.sec !== b.dataset.tab; });
  };

  const nameInput = $<HTMLInputElement>('name');
  nameInput.addEventListener('input', () => { const { cfg } = h.getProfile(); h.onChange(sanitizeName(nameInput.value), cfg); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); e.stopPropagation(); });

  $('rand').onclick = () => update({
    body: pick(BODIES)[0], head: pick(HEADS)[0], hat: maybe(HATS, 0.4), cape: maybe(CAPES, 0.6),
    hue: pick(HUES), skin: pick(SKINS), top: maybe(TOP_ACC, 0.4), face: maybe(FACE_ACC, 0.5), neck: maybe(NECK_ACC, 0.4),
    back: maybe(BACK_ACC, 0.4), right: maybe(RIGHT_HAND, 0.4), left: maybe(LEFT_HAND, 0.3), acol: pick(ACCESSORY_COLORS), size: pick(SIZES)[0],
  });
  const close = () => { panel.hidden = true; h.onClose(); };
  $('closePanel').onclick = close;
  $('donePanel').onclick = close;

  function sync() {
    const { name, cfg } = h.getProfile();
    for (const [id, , key] of LISTS) $(id).querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === cfg[key])));
    $('sw-acol').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === cfg.acol)));
    $('sw-hue').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.v === '' ? null : Number(b.dataset.v)) === cfg.hue)));
    $('sw-skin').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.v || null) === cfg.skin)));
    if (document.activeElement !== nameInput) nameInput.value = name;
  }

  return {
    open() { panel.hidden = false; sync(); },
    close,
    get isOpen() { return !panel.hidden; },
  };
}
