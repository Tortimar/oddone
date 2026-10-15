import { FINALE, SLOT_COLORS, finaleRevealAt, isCeremony, isMinigamePhase, isVotePhase, type Phase, type RoomState } from '@oddone/shared';
import { $, escapeHtml } from './dom.ts';
import { RULES } from '../minigames/rules.ts';
import { portraitImg } from './portraits.ts';

/**
 * La soirée de quêtes vue par le joueur : bulle du tavernier (texte qui s'écrit),
 * cartes de vote, minuteur. Tout se déduit de l'état envoyé par le serveur ; ce module
 * ne fait qu'afficher et transmettre les votes.
 */

/** `at` : moment de la réplique (ms depuis le début de la phase) ; sans lui, la phase est partagée à parts égales. */
interface Line { step?: string; text: string; note?: string; at?: number }

/** Ce que dit le tavernier à chaque phase. Le texte entre ** ** est mis en valeur. */
function linesFor(s: RoomState, myId: string): Line[] {
  const g = s.game, chosen = g.chosen?.label ?? '';
  const name = (id: string | undefined) => s.players.find((p) => p.id === id)?.name ?? 'un fantôme';
  const step = `Quête ${g.round} sur ${g.totalRounds}`;
  const tieNote = g.tie ? 'Égalité ! Les dés ont tranché.' : undefined;
  switch (s.phase as Exclude<Phase, 'lobby' | 'countdown'>) {
    case 'intro': return [
      { text: 'Ah, vous voilà enfin, aventuriers ! Bienvenue au **Tortibar**.' },
      { text: "À chaque quête, l'un de vous jouera double jeu… Après chaque quête, vous tenterez de le démasquer. Gardez vos pièces d'or près du cœur !" },
    ];
    case 'roundsVote': return [{ step: 'Avant de partir', text: "Combien de quêtes vous sentez-vous d'affronter ce soir ?" }];
    case 'roundsReveal': return [{ step: 'Avant de partir', text: `**${chosen}** ! Voilà qui va faire des légendes… ou des tombes.`, note: tieNote }];
    case 'questVote': return [{ step: `Quête ${g.round} sur ${g.totalRounds}`, text: "Voici ce que j'ai sur mon tableau. Laquelle tentez-vous ?" }];
    case 'questReveal': return [{ step: `Quête ${g.round} sur ${g.totalRounds}`, text: `Vous partez pour… **${chosen}** !`, note: tieNote }];
    case 'rules': case 'roleReveal': case 'mgCountdown': case 'mgPlay': case 'mgResults': return [];
    case 'debrief': {
      const res = s.mg?.results ?? [];
      const winners = res.filter((r) => r.rank === 1).map((r) => `**${name(r.id)}**`);
      const hint = RULES[s.mg?.id ?? '']?.debriefHint ?? "Mais l'un de vous avait un drôle d'avantage…";
      return [
        { step, text: winners.length ? `Quel spectacle ! ${winners.join(' et ')} ${winners.length > 1 ? 'remportent' : 'remporte'} **${chosen}** !` : `Vous voilà revenus de **${chosen}** !` },
        { step, text: hint },
      ];
    }
    case 'scoreReveal': return [{
      step, text: "Voyons les **scores** ! Des pièces d'or pour tout le monde…",
      note: '4 pièces au premier, 3 au deuxième, 2 au troisième, 1 au dernier.',
    }];
    case 'imposterVote': return [{
      step, text: "Alors… qui était l'**imposteur** ? Désignez-le !",
      note: "Trouvé : il te donne 1 pièce d'or. Raté (ou pas de vote) : c'est toi qui lui en donnes une.",
    }];
    case 'imposterReveal': {
      const r = g.reveal;
      if (!r) return [];
      const others = s.players.length - 1;
      const imp = r.imposterId === myId ? 'toi' : name(r.imposterId);
      const verdict = r.found === others ? 'Démasqué par tout le monde !' : r.found === 0 ? 'Personne ne l\'a vu venir…' : `${r.found} sur ${others} l'ont démasqué.`;
      const d = r.deltas[r.imposterId] ?? 0;
      const coins = (n: number) => `${n} pièce${n > 1 ? 's' : ''} d'or`;
      return [{ step, text: `L'imposteur était… **${imp}** ! ${verdict}`, note: d === 0 ? "Pas une pièce ne change de main… ou presque." : `L'imposteur ${d > 0 ? 'empoche' : 'perd'} ${coins(Math.abs(d))}.` }];
    }
    case 'quest': return [{
      step: `Quête ${g.round} sur ${g.totalRounds}`, text: `Bonne route ! Que la quête **${chosen}** commence.`,
      note: 'Le mini-jeu arrive bientôt : retour au comptoir dans quelques secondes.',
    }];
    case 'finale': {
      // grand podium : une réplique par place, de la dernière à la première, au rythme des apparitions
      const final = g.final ?? [], n = final.length, podium = 'Grand podium';
      const coins = (c: number) => `${c} pièce${c > 1 ? 's' : ''} d'or`;
      const place = (rank: number) => `${final.filter((f) => f.rank === rank).length > 1 ? 'Ex aequo à' : 'À'} la **${rank}${rank === 1 ? 're' : 'e'} place**`;
      const lines: Line[] = [{ at: 0, step: podium, text: 'Toutes les quêtes sont accomplies ! Voyons qui repart le plus **riche**…' }];
      for (let i = n - 1; i >= 1; i--) lines.push({ at: finaleRevealAt(i, n), step: podium, text: `${place(final[i].rank)}, avec ${coins(final[i].coins)} : **${name(final[i].id)}** !` });
      if (n > 1) lines.push({ at: finaleRevealAt(0, n) - FINALE.drumMs, step: podium, text: 'Et la bourse la plus lourde de la soirée revient à…' });
      if (n > 0) lines.push({
        at: finaleRevealAt(0, n), step: podium, text: `**${name(final[0].id)}**, avec **${coins(final[0].coins)}** !`,
        note: "Mais l'imposteur court toujours… À la prochaine tournée !",
      });
      return lines;
    }
    default: return [];
  }
}

const CHARS_PER_SECOND = 42;
const rich = (t: string) => escapeHtml(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
/** Texte partiellement écrit, en gardant le gras correct. */
function typed(text: string, count: number): string {
  let out = '', shown = 0, bold = false;
  for (let i = 0; i < text.length && shown < count; i++) {
    if (text.startsWith('**', i)) { bold = !bold; out += bold ? '<b>' : '</b>'; i++; continue; }
    out += escapeHtml(text[i]);
    shown++;
  }
  if (bold) out += '</b>';
  return out;
}

export interface QuestDialogHooks {
  myId(): string;
  serverNow(): number;
  vote(optionId: string): void;
  /** Phase changée : le tavernier réagit (animation). */
  onPhase(phase: Phase): void;
}

export function initQuestDialog(h: QuestDialogHooks) {
  const root = $('quest'), bubble = $('qBubble'), stepEl = $('qStep'), textEl = $('qText'), noteEl = $('qNote');
  const timer = $('qTimer'), cards = $('qCards'), choices = $('qChoices'), hint = $('qHint');
  let state: RoomState | null = null;
  let phaseKey = '', cardsKey = '', dealtFor = '';
  let shownVoters = new Set<string>();

  for (const el of [cards, choices]) el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.qcard');
    if (b && !b.disabled) h.vote(b.dataset.id!);
  });
  window.addEventListener('keydown', (e) => {
    if (!state || !isVotePhase(state.phase)) return;
    const i = Number(e.key) - 1;
    const opt = state.game.options[i];
    if (opt && !(state.phase === 'imposterVote' && opt.id === h.myId())) { h.vote(opt.id); e.preventDefault(); }
  });

  function renderCards(s: RoomState) {
    const voting = isVotePhase(s.phase);
    const imposterRound = s.phase === 'imposterVote' || s.phase === 'imposterReveal';
    const reveal = s.phase === 'roundsReveal' || s.phase === 'questReveal' || s.phase === 'imposterReveal';
    if (!voting && !reveal) { cards.innerHTML = ''; choices.innerHTML = ''; cardsKey = ''; hint.textContent = ''; return; }
    // l'imposteur se désigne en cliquant sur les joueurs au comptoir (voir suspectPicker.ts) : pas de cartes
    if (imposterRound) {
      cards.innerHTML = ''; choices.innerHTML = ''; cardsKey = '';
      hint.textContent = s.phase === 'imposterVote' ? "Clique sur un joueur au comptoir (ou touches 1 à 4). Tu peux changer d'avis jusqu'à la fin." : '';
      return;
    }
    // le nombre de quêtes et le choix de la quête : des bulles de dialogue empilées au-dessus de celle du tavernier
    const bubbles = s.phase === 'questVote' || s.phase === 'questReveal' || s.phase === 'roundsVote' || s.phase === 'roundsReveal';
    const target = bubbles ? choices : cards;
    (bubbles ? cards : choices).innerHTML = '';
    const mine = s.game.votes[h.myId()];
    const chosenId = s.phase === 'imposterReveal' ? s.game.reveal?.imposterId : s.game.chosen?.id;
    const key = JSON.stringify([s.phase, s.game.round, s.game.options, s.game.votes, chosenId]);
    if (key === cardsKey) return;
    const dealt = dealtFor === `${s.phase}|${s.game.round}`; // déjà distribuées : pas de nouvelle animation
    if (!dealt) shownVoters = new Set();
    dealtFor = `${s.phase}|${s.game.round}`;
    cardsKey = key;
    target.innerHTML = s.game.options.map((o, i) => {
      const voters = s.players.filter((p) => s.game.votes[p.id] === o.id).map((p) => {
        const k = `${p.id}>${o.id}`, fresh = !shownVoters.has(k); // seuls les nouveaux votes « tombent » sur la carte
        return `<span class="voter" style="--c:${SLOT_COLORS[p.slot % 4]};${fresh ? '' : 'animation:none'}" title="${escapeHtml(p.name)}">${portraitImg(p.cfg, p.name)}</span>`;
      }).join('');
      const self = imposterRound && o.id === h.myId();
      const player = imposterRound ? s.players.find((p) => p.id === o.id) : undefined;
      const delta = s.phase === 'imposterReveal' ? s.game.reveal?.deltas[o.id] ?? 0 : null;
      const cls = ['qcard', bubbles ? 'qchoice' : '', imposterRound ? 'who' : '', mine === o.id ? 'mine' : '', reveal ? (chosenId === o.id ? 'win' : 'lose') : '', s.phase === 'imposterReveal' ? 'imp' : ''].join(' ');
      const keyText = voting ? (self ? "C'est toi" : mine === o.id ? 'Ton choix' : `Touche ${i + 1}`) : delta !== null ? `${delta > 0 ? '+' : ''}${delta} pièce${Math.abs(delta) > 1 ? 's' : ''}` : ' ';
      return `<button class="${cls}" data-id="${escapeHtml(o.id)}" ${voting && !self ? '' : 'disabled'} style="${dealt ? 'animation:none;' : ''}${player ? `--seal:${SLOT_COLORS[player.slot % 4]}` : ''}">
        <span class="seal">${i + 1}</span>${player ? `<span class="who-face" style="--c:${SLOT_COLORS[player.slot % 4]}">${portraitImg(player.cfg, player.name)}</span>` : ''}<span class="qt">${escapeHtml(o.label)}</span>
        <span class="key ${delta !== null ? (delta >= 0 ? 'up' : 'down') : ''}">${keyText}</span>
        <span class="voters">${voters}</span></button>`;
    }).join('');
    shownVoters = new Set(Object.entries(s.game.votes).map(([id, opt]) => `${id}>${opt}`));
    const keys = s.game.options.map((_, i) => String(i + 1));
    const keyList = keys.length > 1 ? `${keys.slice(0, -1).join(', ')} ou ${keys.at(-1)}` : keys[0];
    hint.textContent = voting ? `Clique une carte ou appuie sur ${keyList}. Tu peux changer d'avis jusqu'à la fin.` : '';
  }

  /** À appeler à chaque image : texte qui s'écrit, minuteur. */
  function frame() {
    const s = state;
    if (!s || !isCeremony(s.phase) || isMinigamePhase(s.phase)) { root.hidden = true; return; }
    root.hidden = false;
    const now = h.serverNow();
    const start = s.phaseStartedAt ?? now, end = s.phaseEndsAt ?? now;
    const lines = linesFor(s, h.myId());
    // plusieurs répliques dans la même phase : réparties sur la durée
    const share = Math.max(1, end - start) / Math.max(1, lines.length);
    const timed = lines.some((l) => l.at !== undefined);
    const idx = timed ? Math.max(0, lines.filter((l) => now - start >= (l.at ?? 0)).length - 1) // (répliques dans l'ordre)
      : Math.min(lines.length - 1, Math.max(0, Math.floor((now - start) / share)));
    const line = lines[idx];
    const key = `${s.phase}|${s.game.round}|${idx}`;
    if (key !== phaseKey) {
      const newPhase = !phaseKey.startsWith(`${s.phase}|${s.game.round}|`);
      phaseKey = key;
      bubble.style.animation = 'none'; void bubble.offsetWidth; bubble.style.animation = '';
      if (newPhase) h.onPhase(s.phase);
    }
    if (line) {
      stepEl.textContent = line.step ?? '';
      const elapsed = (now - start - (timed ? line.at ?? 0 : idx * share)) / 1000;
      const plainLength = line.text.replace(/\*\*/g, '').length;
      const count = Math.floor(elapsed * CHARS_PER_SECOND);
      textEl.innerHTML = count >= plainLength ? rich(line.text) : typed(line.text, count);
      noteEl.textContent = count >= plainLength ? line.note ?? '' : '';
    }
    const showTimer = isVotePhase(s.phase) || s.phase === 'quest';
    timer.hidden = !showTimer;
    if (showTimer) {
      const left = Math.max(0, end - now), total = Math.max(1, end - start);
      (timer.firstElementChild as HTMLElement).style.width = `${(left / total) * 100}%`;
      timer.lastElementChild!.textContent = `${Math.ceil(left / 1000)} s`;
      timer.classList.toggle('low', left < 4000 && isVotePhase(s.phase));
    }
  }

  return {
    update(s: RoomState | null) { state = s; if (s) renderCards(s); else { cards.innerHTML = ''; choices.innerHTML = ''; cardsKey = dealtFor = ''; } },
    frame,
    /** Place la bulle au-dessus de la tête du tavernier (coordonnées écran en px). */
    anchor(x: number, y: number) {
      const half = bubble.offsetWidth / 2 + 16;
      // les bulles de choix (vote de la quête) s'empilent au-dessus : on laisse la place
      const above = choices.childElementCount ? choices.offsetHeight + 22 : 0;
      const left = Math.max(half, Math.min(innerWidth - half, x));
      const bottom = Math.max(bubble.offsetHeight + above + 24, y);
      bubble.style.left = `${left}px`;
      bubble.style.top = `${bottom}px`;
      if (above) {
        choices.style.left = `${left}px`;
        choices.style.top = `${bottom - bubble.offsetHeight - 22}px`;
      }
    },
  };
}
