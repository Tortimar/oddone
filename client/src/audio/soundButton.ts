import { getVolume, isMuted, onLevelChange, playSfx, setVolume, toggleMute } from './audio.ts';

/**
 * Bouton du son, en haut à droite : un clic coupe ou remet le son, le curseur règle le volume.
 * Raccourci : M (sauf pendant la saisie d'un texte).
 */
export function initSoundButton(): void {
  const box = document.getElementById('sound')!;
  const btn = box.querySelector('button')!;
  const range = box.querySelector('input')!;

  const render = () => {
    const off = isMuted() || getVolume() === 0;
    btn.textContent = off ? '🔇' : getVolume() < 0.4 ? '🔉' : '🔊';
    btn.setAttribute('aria-label', off ? 'Remettre le son' : 'Couper le son');
    btn.title = (off ? 'Remettre le son' : 'Couper le son') + ' (M)';
    range.value = String(Math.round((isMuted() ? 0 : getVolume()) * 100));
  };
  onLevelChange(render);
  render();

  btn.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); btn.blur(); });
  range.addEventListener('input', () => setVolume(Number(range.value) / 100));
  range.addEventListener('change', () => { playSfx('clic'); range.blur(); });
  // le curseur ne doit pas voler les touches du jeu (flèches)
  range.addEventListener('keydown', (e) => e.stopPropagation());

  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyM' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    toggleMute();
  });
}
