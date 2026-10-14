// God powers. Each one takes the sim state and a target cell.
// Returns { ok, msg }. No DOM.
import { B, BLD, isWater, classify, maxTrees, cellsWithin, angleBetween, MAX_LEVEL } from './world.js';
import { spawnTribe, addLog, pushFx, ignite, AGES } from './sim.js';

export const POWERS = [
  { id: 'tribe', name: 'Spawn Tribe', icon: '👣', radius: 0.065, desc: 'Plant a new people on land.' },
  { id: 'meteor', name: 'Meteor', icon: '☄️', radius: 0.09, desc: 'Smash a crater. Kills, burns, reshapes land.' },
  { id: 'rain', name: 'Rain', icon: '🌧️', radius: 0.16, desc: 'Rain clouds: crops grow, fires die, deserts bloom.' },
  { id: 'drought', name: 'Drought', icon: '☀️', radius: 0.2, desc: 'Dry heat: crops fail, forests catch fire.' },
  { id: 'forest', name: 'Grow Forest', icon: '🌲', radius: 0.12, desc: 'Trees spring up.' },
  { id: 'quake', name: 'Earthquake', icon: '⛰️', radius: 0.1, desc: 'Raise mountains, topple villages.' },
  { id: 'plague', name: 'Plague', icon: '☠️', radius: 0.05, desc: 'Sickness hits the tribe here.' },
  { id: 'bless', name: 'Bless', icon: '✨', radius: 0.05, desc: 'Food, growth and wisdom for a tribe.' },
];
export const POWER_BY_ID = Object.fromEntries(POWERS.map((p) => [p.id, p]));

export function applyPower(state, id, cell) {
  const fn = HANDLERS[id];
  if (!fn) return { ok: false, msg: 'Unknown power' };
  if (cell == null || cell < 0) return { ok: false, msg: 'Pick a place on the globe' };
  return fn(state, cell, POWER_BY_ID[id].radius);
}

function tribeAt(state, cell, radius) {
  const w = state.world;
  if (w.owner[cell] >= 0) return state.tribes[w.owner[cell]];
  let best = null, bestA = radius * 2;
  for (const t of state.tribes) {
    if (!t.alive) continue;
    const a = angleBetween(w, cell, t.capital);
    if (a < bestA) { bestA = a; best = t; }
  }
  return best;
}

const HANDLERS = {
  tribe(state, cell) {
    const w = state.world;
    if (isWater(w.biome[cell])) return { ok: false, msg: 'Tribes need land, not water.' };
    if (state.tribes.filter((t) => t.alive).length >= 24) return { ok: false, msg: 'The world is too crowded.' };
    const t = spawnTribe(state, cell);
    return { ok: !!t, msg: t ? `The ${t.name} tribe appears.` : 'Could not spawn' };
  },

  meteor(state, cell, r) {
    const w = state.world, rng = state.rng;
    const hitWater = isWater(w.biome[cell]);
    const area = cellsWithin(w, cell, r * 1.9);
    const killed = new Map();
    let destroyed = 0;
    for (const c of area) {
      const d = angleBetween(w, cell, c) / r; // 0 at center, 1 at crater edge
      const o = w.owner[c];
      if (d <= 1) {
        if (o >= 0) {
          const t = state.tribes[o];
          const share = t.pop / Math.max(1, t.cells.size);
          const loss = Math.min(t.pop, share * 1.5 + 2);
          t.pop -= loss;
          killed.set(o, (killed.get(o) || 0) + loss);
        }
        if (w.bld[c] !== BLD.NONE) destroyed++;
        w.bld[c] = BLD.NONE;
        w.trees[c] = 0;
        w.fire[c] = 0; state.burning.delete(c);
        if (!isWater(w.biome[c])) {
          const drop = Math.round(4 * (1 - d * d)) + 1;
          const L = Math.max(0, w.level[c] - drop);
          w.level[c] = L;
          if (L === 0) { w.raw[c] = w.sea - 0.01; classify(w, c); }
          else { classify(w, c); w.biome[c] = B.SCORCHED; w.fert[c] = 0.05; w.scorch[c] = 120 + rng.int(80); state.scorched.add(c); }
        }
      } else if (hitWater) {
        // Tsunami: wash out coast
        if (!isWater(w.biome[c]) && w.level[c] <= 2) {
          if (w.bld[c] === BLD.FARM || (w.bld[c] === BLD.HOUSE && rng() < 0.5)) { w.bld[c] = w.bld[c] === BLD.HOUSE ? BLD.RUIN : BLD.NONE; destroyed++; }
          if (o >= 0) { const t = state.tribes[o]; const l = Math.min(t.pop, 1.5); t.pop -= l; killed.set(o, (killed.get(o) || 0) + l); }
        }
      } else if (w.trees[c] > 0.2 && rng() < 0.6) ignite(state, c);
      else if (w.bld[c] === BLD.HOUSE && rng() < 0.3) { w.bld[c] = BLD.RUIN; destroyed++; }
    }
    // Rim cells next to the crater get classified again (beaches etc.)
    for (const c of area) if (!isWater(w.biome[c]) && w.biome[c] !== B.SCORCHED) classify(w, c);
    for (const c of area) if (isWater(w.biome[c])) classify(w, c);
    w.version++;
    let dead = 0;
    for (const v of killed.values()) dead += v;
    pushFx(state, { type: 'impact', cell, r });
    const msg = `A meteor strikes${hitWater ? ' the sea' : ''}! ${Math.round(dead)} die, ${destroyed} buildings lost.`;
    addLog(state, msg, 'disaster', cell);
    return { ok: true, msg, killed: dead, destroyed };
  },

  rain(state, cell, r) {
    const cells = cellsWithin(state.world, cell, r);
    state.weather.push({ type: 'rain', cell, r, ttl: 70, cells });
    let doused = 0;
    for (const c of cells) if (state.world.fire[c]) { state.world.fire[c] = 0; state.burning.delete(c); doused++; }
    const msg = doused ? `Rain falls and puts out ${doused} fires.` : 'Rain clouds gather.';
    addLog(state, msg, 'weather', cell);
    return { ok: true, msg };
  },

  drought(state, cell, r) {
    const cells = cellsWithin(state.world, cell, r);
    state.weather.push({ type: 'drought', cell, r, ttl: 90, cells });
    addLog(state, 'A burning drought begins.', 'weather', cell);
    return { ok: true, msg: 'A burning drought begins.' };
  },

  forest(state, cell, r) {
    const w = state.world;
    let grown = 0;
    for (const c of cellsWithin(w, cell, r)) {
      if (isWater(w.biome[c]) || w.bld[c] === BLD.HOUSE || w.bld[c] === BLD.MINE) continue;
      w.moist[c] = Math.min(1, w.moist[c] + 0.15);
      if (w.biome[c] === B.SCORCHED) { w.scorch[c] = 0; state.scorched.delete(c); }
      classify(w, c);
      if (w.bld[c] === BLD.FARM) continue;
      const mx = Math.max(maxTrees(w, c), w.biome[c] === B.DESERT || w.biome[c] === B.SNOW ? 0 : 0.6);
      if (mx > w.trees[c]) { w.trees[c] = mx; grown++; }
    }
    addLog(state, `A forest springs up (${grown} groves).`, 'nature', cell);
    return { ok: grown > 0, msg: grown ? 'A forest springs up.' : 'Nothing can grow here.', grown };
  },

  quake(state, cell, r) {
    const w = state.world, rng = state.rng;
    let toppled = 0, dead = 0;
    for (const c of cellsWithin(w, cell, r)) {
      const d = angleBetween(w, cell, c) / r;
      const rise = Math.round(4 * (1 - d)) + (rng() < 0.5 ? 1 : 0);
      if (rise <= 0) continue;
      if (w.level[c] === 0 && rise < 3) continue; // shallow uplift stays sea
      w.level[c] = Math.min(MAX_LEVEL, w.level[c] + rise);
      if (w.raw[c] <= w.sea) w.raw[c] = w.sea + 0.01;
      if (w.biome[c] === B.SCORCHED) { w.scorch[c] = 0; state.scorched.delete(c); }
      w.temp[c] -= 0.04 * rise;
      classify(w, c);
      if ((w.bld[c] === BLD.HOUSE || w.bld[c] === BLD.FARM) && rng() < 0.55) {
        w.bld[c] = w.bld[c] === BLD.HOUSE ? BLD.RUIN : BLD.NONE; toppled++;
      }
      const o = w.owner[c];
      if (o >= 0) { const t = state.tribes[o]; const l = Math.min(t.pop, 1 + t.pop / Math.max(1, t.cells.size)); t.pop -= l; dead += l; }
    }
    w.version++;
    pushFx(state, { type: 'quake', cell, r });
    const msg = `The earth shakes! Mountains rise, ${toppled} buildings fall.`;
    addLog(state, msg, 'disaster', cell);
    return { ok: true, msg, toppled, dead };
  },

  plague(state, cell, r) {
    const t = tribeAt(state, cell, r);
    if (!t) return { ok: false, msg: 'No tribe lives here.' };
    t.plague = 60;
    pushFx(state, { type: 'plague', cell: t.capital });
    addLog(state, `Plague strikes the ${t.name}!`, 'plague', t.capital);
    return { ok: true, msg: `Plague strikes the ${t.name}!`, tribe: t.id };
  },

  bless(state, cell, r) {
    const t = tribeAt(state, cell, r);
    if (!t) return { ok: false, msg: 'No tribe lives here.' };
    t.blessed = 80;
    t.plague = 0;
    t.food += t.pop * 2;
    t.pop *= 1.1;
    t.stone += 40; t.ore += 25; t.wood += 40;
    let extra = '';
    if (t.tech < 2) { t.tech++; extra = ` They reach the ${AGES[t.tech]}.`; }
    pushFx(state, { type: 'bless', cell: t.capital });
    addLog(state, `The gods bless the ${t.name}.${extra}`, 'bless', t.capital);
    return { ok: true, msg: `The gods bless the ${t.name}.${extra}`, tribe: t.id };
  },
};
