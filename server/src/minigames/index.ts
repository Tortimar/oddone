import { BOMB, FEST, GORGON, SHEEP, BARRELS, CHESTS, MINE, GORGE, HORDE, MARKET, SKELETON_BALL, type MinigameState } from '@oddone/shared';
import { BarrelSim } from './barrels.ts';
import { BombSim } from './bomb.ts';
import { GorgonSim } from './gorgon.ts';
import { SheepSim } from './sheep.ts';
import { FestSim } from './bombfest.ts';
import { HordeSim } from './horde.ts';
import { ChestsSim } from './chests.ts';
import { MineSim } from './mine.ts';
import { GorgeRaceSim } from './gorge.ts';
import { MarketSim } from './market.ts';
import { SkeletonBallSim } from './skeletonBall.ts';
import type { MinigameSim, SimEntrant } from './types.ts';

/** Crée la simulation du mini-jeu `mg.id` et branche son état public sur `mg`. */
export function createSim(mg: MinigameState, entrants: SimEntrant[], random: () => number): MinigameSim {
  if (mg.id === MARKET.id) {
    const sim = new MarketSim(entrants, random);
    mg.market = sim.state; // même objet : room:state suit les manches en direct
    return sim;
  }
  if (mg.id === FEST.id) {
    const sim = new FestSim(entrants, random);
    mg.fest = sim.state; // même objet : room:state suit les plateaux en direct
    return sim;
  }
  if (mg.id === SHEEP.id) {
    const sim = new SheepSim(entrants, random);
    mg.sheep = sim.state; // même objet : room:state suit les arrivées en direct
    return sim;
  }
  if (mg.id === GORGON.id) {
    const sim = new GorgonSim(mg.cemetery!, entrants, random);
    mg.gorgon = sim.state; // même objet : room:state suit le regard, les arrivées et les statues en direct
    return sim;
  }
  if (mg.id === BOMB.id) {
    const sim = new BombSim(mg.labyrinth!, entrants, random);
    mg.bomb = sim.state; // même objet : room:state suit les manches et la bombe en direct
    return sim;
  }
  if (mg.id === MINE.id) {
    const sim = new MineSim(entrants, random);
    mg.mine = sim.state; // même objet : room:state suit les manches en direct
    return sim;
  }
  if (mg.id === CHESTS.id) {
    const sim = new ChestsSim(entrants, random);
    mg.chests = sim.state; // même objet : room:state suit les tours en direct
    return sim;
  }
  if (mg.id === HORDE.id) {
    const sim = new HordeSim(entrants, random);
    mg.horde = sim.state; // même objet : room:state suit les points en direct
    return sim;
  }
  if (mg.id === BARRELS.id) {
    const sim = new BarrelSim(entrants, random);
    mg.ramp = sim.ramp; // même objet : room:state suit la progression en direct
    return sim;
  }
  if (mg.id === GORGE.id) {
    const sim = new GorgeRaceSim(mg.course!, entrants, random);
    mg.race = sim.race; // même objet : room:state montre la progression en direct
    return sim;
  }
  const sim = new SkeletonBallSim(mg.arena!, entrants, random);
  return {
    get elapsed() { return sim.elapsed; },
    get isFinished() { return sim.isFinished; },
    maxMs: SKELETON_BALL.maxDurationMs,
    step(dtMs) {
      const r = sim.step(dtMs);
      for (const c of r.caught) mg.caught[c.id] = { at: Math.round(sim.elapsed), by: c.by };
      return { done: r.done, changed: r.caught.length > 0, hits: [] };
    },
    tick: () => sim.tick(),
    results: () => sim.results(),
    setHumanPosition: (id, x, z) => sim.setHumanPosition(id, x, z),
    remove: (id) => sim.remove(id),
  };
}
