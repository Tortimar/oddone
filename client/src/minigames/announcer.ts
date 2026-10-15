import { BARRELS, rampFloor, type MinigameState } from '@oddone/shared';
import { FLOAT_GAIN, placeColor, placeLabel } from '../world/floatText.ts';

/**
 * Ce qu'il faut annoncer au-dessus des joueurs entre deux états du mini-jeu reçus du serveur :
 * - des points gagnés : « +1 », « +3 », « +5 »… (Festin du Roi, Horde de Gobelins, Wagonnets) ;
 * - une place quand on termine un tronçon ou qu'on est éliminé : « 1er », « 2e »… (Pont Branlant :
 *   chaque pont et l'arrivée ; Tonneaux Fous : chaque montée et l'arrivée ; Coffres Piégés et Bal
 *   des Squelettes : la place de l'éliminé, puis « 1er » pour le dernier en lice).
 * Les Wagonnets annoncent aussi la place de chaque wagon à son arrivée (mineArena.ts : l'arrivée
 * se calcule à l'image près, pas d'après l'état).
 */

export interface FloatEvent { id: string; text: string; color: string }

const place = (id: string, rank: number): FloatEvent => ({ id, text: placeLabel(rank), color: placeColor(rank) });

export function scoreFloats(a: MinigameState, b: MinigameState): FloatEvent[] {
  if (a.id !== b.id) return [];
  const out: FloatEvent[] = [];

  // points gagnés
  const gains = (pa: Record<string, number> | undefined, pb: Record<string, number> | undefined) => {
    if (!pa || !pb) return;
    for (const [id, n] of Object.entries(pb)) {
      const d = n - (pa[id] ?? 0);
      if (d > 0) out.push({ id, text: `+${d}`, color: FLOAT_GAIN });
    }
  };
  gains(a.market?.points, b.market?.points);
  gains(a.horde?.points, b.horde?.points);
  gains(a.mine?.points, b.mine?.points);

  // Pont Branlant : place à chaque pont (parmi ceux qui l'ont atteint), puis à l'arrivée
  if (a.race && b.race) {
    const all = Object.values(b.race);
    for (const [id, now] of Object.entries(b.race)) {
      const was = a.race[id];
      if (!was) continue;
      if (now.finishedAt !== null && was.finishedAt === null) out.push(place(id, all.filter((r) => r.finishedAt !== null).length));
      else if (now.cp > was.cp) out.push(place(id, all.filter((r) => r.cp >= now.cp).length));
    }
  }

  // Tonneaux Fous : place au haut de chaque montée, puis à l'arrivée
  if (a.ramp && b.ramp) {
    const all = Object.values(b.ramp);
    for (const [id, now] of Object.entries(b.ramp)) {
      const was = a.ramp[id];
      if (!was) continue;
      const k = rampFloor(now.best), before = rampFloor(was.best);
      if (now.finishedAt !== null && was.finishedAt === null) out.push(place(id, all.filter((r) => r.finishedAt !== null).length));
      // (k : la montée où l'on vient d'entrer ; la 1re ne compte pas, c'est le départ)
      else if (k > before && k >= 2 && k <= BARRELS.runs) out.push(place(id, all.filter((r) => rampFloor(r.best) >= k).length));
    }
  }

  // Coffres Piégés : la place de chaque éliminé, puis « 1er » au dernier en lice
  if (a.chests && b.chests) {
    const c = b.chests;
    c.out.forEach((id, i) => { if (!a.chests!.out.includes(id)) out.push(place(id, c.alive.length + (c.out.length - i))); });
    if (c.alive.length === 1 && a.chests.alive.length > 1) out.push(place(c.alive[0], 1));
  }

  // Bombe du Labyrinthe : la place de chaque éliminé (à l'explosion), puis « 1er » au dernier debout
  if (a.bomb && b.bomb) {
    const c = b.bomb;
    c.out.forEach((id, i) => { if (!a.bomb!.out.includes(id)) out.push(place(id, c.alive.length + (c.out.length - i))); });
    if (c.stage === 'done' && a.bomb.stage !== 'done' && c.alive.length === 1) out.push(place(c.alive[0], 1));
  }

  // Regard de la Gorgone : la place à l'arrivée ; le premier pétrifié est dernier, puis l'avant-dernier…
  if (a.gorgon && b.gorgon) {
    const n = Object.keys(b.starts).length;
    b.gorgon.finished.forEach((id, i) => { if (!a.gorgon!.finished.includes(id)) out.push(place(id, i + 1)); });
    b.gorgon.petrified.forEach((id, i) => { if (!a.gorgon!.petrified.includes(id)) out.push(place(id, n - i)); });
  }

  // Festival des Bombes : la place de chaque plateau qui saute, puis « 1er » au dernier debout
  if (a.fest && b.fest) {
    const n = Object.keys(b.starts).length;
    b.fest.out.forEach((id, i) => { if (!a.fest!.out.includes(id)) out.push(place(id, n - i)); });
    const alive = Object.keys(b.fest.boards).filter((id) => !b.fest!.out.includes(id));
    if (n > 1 && alive.length === 1 && Object.keys(a.fest.boards).filter((id) => !a.fest!.out.includes(id)).length > 1) out.push(place(alive[0], 1));
  }

  // Course des Moutons : la place à l'arrivée
  if (a.sheep && b.sheep) b.sheep.finished.forEach((id, i) => { if (!a.sheep!.finished.includes(id)) out.push(place(id, i + 1)); });

  // Bal des Squelettes : la place de chaque joueur touché, puis « 1er » au dernier libre
  if (a.arena && b.arena) {
    const ids = Object.keys(b.starts), n = ids.length;
    const order = Object.entries(b.caught).sort(([, p], [, q]) => p.at - q.at).map(([id]) => id);
    order.forEach((id, i) => { if (!(id in a.caught)) out.push(place(id, n - i)); });
    const free = ids.filter((id) => !(id in b.caught));
    if (n > 1 && free.length === 1 && ids.filter((id) => !(id in a.caught)).length > 1) out.push(place(free[0], 1));
  }
  return out;
}
