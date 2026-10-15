import {
  ACCESSORY_COLORS, BACK_ACC, BODIES, CAPES, FACE_ACC, HATS, HEADS, HUES, NECK_ACC,
  SKINS, TOP_ACC, randomConfig, sanitizeName, type CharacterConfig, type Option,
} from '@oddone/shared';
import { $, escapeHtml } from './dom.ts';
import { cachedShot, characterShot, type Shot } from './portraits.ts';

/**
 * Atelier de la couturière : modifie la tenue du joueur local.
 * Chaque choix est une vignette cliquable : ton personnage, tel qu'il serait avec ce choix
 * (la tête pour les têtes et accessoires du visage, en pied pour les tenues, de dos pour la cape
 * et le dos). Les vignettes sont rendues hors écran, quelques-unes par image, puis gardées en cache.
 */

type ListKey = 'body' | 'head' | 'hat' | 'cape' | 'top' | 'face' | 'neck' | 'back';
const LISTS: [string, readonly Option[], ListKey, Shot][] = [
  ['op-body', BODIES, 'body', 'body'], ['op-head', HEADS, 'head', 'head'], ['op-hat', HATS, 'hat', 'head'], ['op-cape', CAPES, 'cape', 'back'],
  ['op-top', TOP_ACC, 'top', 'head'], ['op-face', FACE_ACC, 'face', 'head'], ['op-neck', NECK_ACC, 'neck', 'body'],
  ['op-back', BACK_ACC, 'back', 'back'],
];
/** Vignettes rendues par image (un rendu de personnage coûte quelques millisecondes). */
const SHOTS_PER_FRAME = 3;

export interface AtelierHooks {
  getProfile(): { name: string; cfg: CharacterConfig };
  /** Appelé à chaque modification (tenue ou pseudo). */
  onChange(name: string, cfg: CharacterConfig): void;
  onClose(): void;
}


export function initAtelier(h: AtelierHooks) {
  const panel = $('panel');
  const update = (patch: Partial<CharacterConfig>) => {
    const { name, cfg } = h.getProfile();
    h.onChange(name, { ...cfg, ...patch });
    sync();
  };

  for (const [id, list, key] of LISTS) {
    const el = $(id);
    el.classList.add('pics');
    el.innerHTML = list.map(([v, l]) => `<button data-v="${escapeHtml(v)}" title="${escapeHtml(l)}" aria-label="${escapeHtml(l)}" class="${v === 'none' ? 'none' : ''}"><img alt="" draggable="false"><span>${escapeHtml(l)}</span></button>`).join('');
    el.onclick = (e) => { const b = (e.target as HTMLElement).closest('button'); if (b) update({ [key]: b.dataset.v } as Partial<CharacterConfig>); };
  }

  // vignettes à rendre : la plus récente demande l'emporte (on change vite d'avis à l'atelier)
  let queue: { img: HTMLImageElement; cfg: CharacterConfig; shot: Shot }[] = [];
  let pumping = false;
  const pump = () => {
    for (let k = 0; k < SHOTS_PER_FRAME && queue.length; k++) {
      const job = queue.shift()!;
      const url = characterShot(job.cfg, job.shot);
      if (url && job.img.dataset.want === `${job.shot}:${JSON.stringify(job.cfg)}`) job.img.src = url;
    }
    if (queue.length && !panel.hidden) requestAnimationFrame(pump); else pumping = false;
  };
  function refreshPictures(cfg: CharacterConfig) {
    queue = [];
    for (const [id, , key, shot] of LISTS) {
      $(id).querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
        const img = b.querySelector('img')!;
        const c = { ...cfg, [key]: b.dataset.v };
        // pour un accessoire, on enlève ceux qui gêneraient (un chapeau cache la couronne)
        if (key === 'top' || key === 'face') c.hat = 'none';
        if (key === 'back') c.cape = 'none';
        if (key === 'cape') c.back = 'none';
        const want = `${shot}:${JSON.stringify(c)}`;
        if (img.dataset.want === want) return;
        img.dataset.want = want;
        const hit = cachedShot(c, shot);
        if (hit) img.src = hit;
        else queue.push({ img, cfg: c, shot });
      });
    }
    // d'abord la section affichée
    const visible = (j: { img: HTMLImageElement }) => !j.img.closest<HTMLElement>('[data-sec]')!.hidden;
    queue.sort((a, b) => Number(visible(b)) - Number(visible(a)));
    if (queue.length && !pumping) { pumping = true; requestAnimationFrame(pump); }
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
    refreshPictures(h.getProfile().cfg);
  };

  const nameInput = $<HTMLInputElement>('name');
  nameInput.addEventListener('input', () => { const { cfg } = h.getProfile(); h.onChange(sanitizeName(nameInput.value), cfg); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); e.stopPropagation(); });

  $('rand').onclick = () => update(randomConfig());
  const close = () => { if (panel.hidden) return; panel.hidden = true; h.onClose(); };
  $('closePanel').onclick = close;
  $('donePanel').onclick = close;

  function sync() {
    const { name, cfg } = h.getProfile();
    for (const [id, , key] of LISTS) $(id).querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === cfg[key])));
    refreshPictures(cfg);
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
