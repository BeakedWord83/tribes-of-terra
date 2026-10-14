// The simulation: tribes, economy, nature, diplomacy, war.
// Pure logic, no DOM. One tick = one month.
import { B, BLD, isWater, classify, maxTrees, cellsWithin, angleBetween, nearWater } from './world.js';
import { makeRng } from './rng.js';

export const AGES = ['Stone Age', 'Bronze Age', 'Iron Age'];
const SYL = ['ka', 'ru', 'to', 'mi', 'zan', 'el', 'dor', 'ash', 'ul', 'ny', 'ber', 'tha', 'gor', 'vi',
  'sel', 'om', 'qua', 'ren', 'id', 'bal', 'ko', 'mar', 'esh', 'tu', 'lo', 'han', 'yr', 'pa', 'sun', 've'];
const END = ['', '', 'i', 'an', 'ar', 'os', 'ec', 'un'];

export function createSim(world, seed, opts = {}) {
  const state = {
    world, seed: String(seed), rng: makeRng('sim:' + seed),
    tick: 0, tribes: [], log: [], fx: [], weather: [],
    burning: new Set(), scorched: new Set(),
    nextId: 0, hueBase: 0,
  };
  state.hueBase = state.rng();
  const n = opts.tribes ?? 5 + state.rng.int(4);
  const placed = [];
  for (let i = 0; i < n; i++) {
    const cell = findStartCell(state, placed, 0.36);
    if (cell < 0) break;
    placed.push(cell);
    spawnTribe(state, cell, { quiet: true });
  }
  addLog(state, `A new world is born. ${state.tribes.length} tribes awaken.`, 'world');
  return state;
}

function findStartCell(state, placed, minAng) {
  const w = state.world, rng = state.rng;
  for (let tries = 0; tries < 4000; tries++) {
    const c = rng.int(w.count);
    if (isWater(w.biome[c]) || w.owner[c] >= 0) continue;
    if (w.fert[c] < 0.5 || w.level[c] > 5 || w.temp[c] < 0.3) continue;
    const ang = tries < 3000 ? minAng : minAng * 0.5;
    if (placed.every((p) => angleBetween(w, p, c) > ang)) return c;
  }
  return -1;
}

export function makeName(rng) {
  const k = 2 + (rng() < 0.3 ? 1 : 0);
  let s = '';
  for (let i = 0; i < k; i++) s += rng.pick(SYL);
  s += rng.pick(END);
  return s[0].toUpperCase() + s.slice(1);
}

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

export function addLog(state, text, kind = 'info', cell = -1) {
  state.log.push({ tick: state.tick, text, kind, cell });
  if (state.log.length > 300) state.log.shift();
}

export function pushFx(state, fx) {
  state.fx.push(fx);
  if (state.fx.length > 600) state.fx.splice(0, state.fx.length - 600);
}

export function tribeById(state, id) {
  return state.tribes[id];
}

export function setOwner(state, c, id) {
  const w = state.world;
  const old = w.owner[c];
  if (old === id) return;
  if (old >= 0) state.tribes[old].cells.delete(c);
  w.owner[c] = id;
  if (id >= 0) state.tribes[id].cells.add(c);
}

// Create a tribe at a land cell. Land owned by someone else is taken -> war.
export function spawnTribe(state, cell, opts = {}) {
  const w = state.world, rng = state.rng;
  if (cell < 0 || isWater(w.biome[cell])) return null;
  const id = state.nextId++;
  const hue = (state.hueBase + id * 0.618034) % 1;
  const t = {
    id, name: opts.name || makeName(rng), hue, color: hslToRgb(hue, 0.8, 0.55),
    alive: true, born: state.tick, pop: opts.pop ?? 30, food: 40, wood: 25, stone: 0, ore: 0,
    tech: 0, aggression: opts.aggression ?? rng.range(0.15, 1), capital: cell,
    cells: new Set(), rel: new Map(), allies: new Set(), enemies: new Set(), warTime: new Map(),
    soldiers: 0, plague: 0, blessed: 0, peakPop: 0, clearTarget: -1,
    foodRate: 0, housing: 0,
  };
  state.tribes.push(t);
  const victims = new Set();
  const area = cellsWithin(w, cell, opts.radius ?? 0.065);
  for (const c of area) {
    if (isWater(w.biome[c])) continue;
    if (w.owner[c] >= 0 && w.owner[c] !== id) {
      if (c !== cell && !opts.conquer) continue;
      victims.add(w.owner[c]);
    }
    setOwner(state, c, id);
    if (w.bld[c] === BLD.RUIN) w.bld[c] = BLD.NONE;
  }
  w.bld[cell] = BLD.HOUSE;
  w.trees[cell] = Math.min(w.trees[cell], 0.1);
  for (const v of victims) declareWar(state, t, state.tribes[v], true);
  if (!opts.quiet) addLog(state, `The ${t.name} tribe appears.`, 'birth', cell);
  pushFx(state, { type: 'spawn', cell, color: t.color });
  return t;
}

// ---------------------------------------------------------------- tick
export function step(state) {
  state.tick++;
  weather(state);
  nature(state);
  for (const t of state.tribes) if (t.alive) economy(state, t);
  if (state.tick % 3 === 0) diplomacy(state);
  wars(state);
  for (const t of state.tribes) if (t.alive) checkDeath(state, t);
  civilWar(state);
}

function weather(state) {
  const w = state.world;
  for (const wx of state.weather) {
    wx.ttl--;
    for (const c of wx.cells) {
      if (wx.type === 'rain') {
        w.wet[c] = Math.min(1, w.wet[c] + 0.12);
        w.moist[c] = Math.min(1, w.moist[c] + 0.004);
        if (w.fire[c]) { w.fire[c] = 0; state.burning.delete(c); }
      } else {
        w.wet[c] = Math.max(-1, w.wet[c] - 0.12);
        w.moist[c] = Math.max(0, w.moist[c] - 0.004);
        if (w.trees[c] > 0.5 && state.rng() < 0.0015) ignite(state, c);
      }
    }
    if (wx.ttl % 10 === 0) {
      for (const c of wx.cells) {
        if (isWater(w.biome[c]) || w.biome[c] === B.SCORCHED) continue;
        const before = w.biome[c];
        classify(w, c);
        if (w.biome[c] !== before && w.bld[c] === BLD.NONE && maxTrees(w, c) > 0.5) w.trees[c] = Math.max(w.trees[c], 0.1);
      }
    }
  }
  state.weather = state.weather.filter((wx) => wx.ttl > 0);
  for (let c = 0; c < w.count; c++) if (w.wet[c] !== 0) {
    w.wet[c] *= 0.97;
    if (Math.abs(w.wet[c]) < 0.01) w.wet[c] = 0;
  }
}

export function ignite(state, c) {
  const w = state.world;
  if (isWater(w.biome[c]) || w.wet[c] > 0.3 || w.fire[c]) return false;
  w.fire[c] = 10 + state.rng.int(12);
  state.burning.add(c);
  return true;
}

function nature(state) {
  const w = state.world, rng = state.rng;
  // Fire spreads through trees, burns them and leaves black ash
  for (const c of [...state.burning]) {
    const hadTrees = w.trees[c] > 0.05;
    w.trees[c] = Math.max(0, w.trees[c] - 0.06);
    const o = w.owner[c];
    if (o >= 0) state.tribes[o].pop = Math.max(0, state.tribes[o].pop - 0.25);
    if (w.bld[c] === BLD.FARM && rng() < 0.3) w.bld[c] = BLD.NONE;
    if (w.bld[c] === BLD.HOUSE && rng() < 0.08) w.bld[c] = BLD.RUIN;
    for (let k = 0; k < 3; k++) {
      const n = w.nbr[c * 3 + k];
      if (w.fire[n] || w.trees[n] <= 0.12 || w.wet[n] >= 0.3) continue;
      const dry = 1 + 0.8 * Math.max(0, -w.wet[n]);
      if (rng() < 0.34 * (1 - Math.max(0, w.wet[n])) * dry * (0.6 + 0.6 * w.trees[n])) ignite(state, n);
    }
    // Sparks jump over a tile now and then
    if (rng() < 0.04) {
      const a = w.nbr[c * 3 + rng.int(3)], n = w.nbr[a * 3 + rng.int(3)];
      if (w.trees[n] > 0.3) ignite(state, n);
    }
    w.fire[c]--;
    if (w.fire[c] <= 0 || w.trees[c] <= 0.01) {
      w.fire[c] = 0; state.burning.delete(c);
      state.fireBurned = (state.fireBurned || 0) + 1;
      state.fireLast = c;
      if (hadTrees && (w.bld[c] === BLD.NONE || w.bld[c] === BLD.RUIN) && !isWater(w.biome[c])) {
        w.trees[c] = Math.min(w.trees[c], 0.02);
        w.biome[c] = B.SCORCHED; // ash; grows back when the timer ends
        w.scorch[c] = Math.max(w.scorch[c], 50 + rng.int(60));
        state.scorched.add(c);
      }
    }
  }
  if (state.burning.size === 0 && state.fireBurned) {
    if (state.fireBurned >= 8) addLog(state, `The fire is out. It burned ${state.fireBurned} tiles.`, 'disaster', state.fireLast);
    state.fireBurned = 0;
  } else if (state.burning.size >= 25 && !state.fireWarned) {
    state.fireWarned = true;
    addLog(state, 'A great wildfire spreads through the forest!', 'disaster', [...state.burning][0]);
  }
  if (state.burning.size === 0) state.fireWarned = false;
  for (const c of [...state.scorched]) {
    w.scorch[c]--;
    if (w.scorch[c] <= 0) { state.scorched.delete(c); classify(w, c); }
  }
  // Trees regrow slowly, faster in rain, slower on owned land
  for (let i = 0; i < 700; i++) {
    const c = rng.int(w.count);
    if (w.fire[c] || w.scorch[c] || (w.bld[c] !== BLD.NONE && w.bld[c] !== BLD.RUIN)) continue;
    const mx = maxTrees(w, c);
    if (w.trees[c] >= mx) continue;
    const rate = 0.03 * (w.owner[c] >= 0 ? 0.4 : 1) * (1 + Math.max(-0.8, w.wet[c]));
    w.trees[c] = Math.min(mx, w.trees[c] + rate);
  }
}

export function fertEff(w, c) {
  return Math.max(0.02, w.fert[c] * (1 + 0.6 * w.wet[c]));
}

function economy(state, t) {
  const w = state.world, rng = state.rng;
  let farms = [], houses = 0, mines = [], forest = [], coast = 0, foodFert = 0;
  for (const c of t.cells) {
    const b = w.bld[c];
    if (b === BLD.FARM) { farms.push(c); foodFert += fertEff(w, c); }
    else if (b === BLD.HOUSE) houses++;
    else if (b === BLD.MINE) mines.push(c);
    if (w.trees[c] > 0.15 && b !== BLD.HOUSE) forest.push(c);
    if (nearWater(w, c)) coast++;
  }
  const cellsN = t.cells.size;
  const atWar = t.enemies.size > 0;
  t.soldiers = t.pop * (atWar ? 0.25 : 0.06);
  const workers = t.pop - t.soldiers;
  const bless = t.blessed > 0 ? 1.6 : 1;

  // Food: farms + gathering/fishing
  const farmCap = farms.length * 8;
  const farmers = Math.min(workers * 0.6, farmCap);
  const farmFood = farmCap > 0 ? foodFert * 2.4 * (farmers / farmCap) : 0;
  const gatherers = workers - farmers;
  const gatherFood = Math.min(gatherers * 0.09, cellsN * 0.05 + coast * 0.08);
  const produced = (farmFood + gatherFood) * bless;
  const eaten = t.pop * 0.1;
  t.foodRate = produced - eaten;
  t.food += t.foodRate;

  // Wood: cut trees, clearing a planned farm first
  const jacks = workers * 0.15;
  let cutBudget = jacks * 0.012;
  if (t.clearTarget >= 0 && w.owner[t.clearTarget] === t.id && w.trees[t.clearTarget] > 0) {
    const cut = Math.min(cutBudget, w.trees[t.clearTarget]);
    w.trees[t.clearTarget] -= cut; cutBudget -= cut; t.wood += cut * 30;
  }
  for (let i = 0; i < 4 && cutBudget > 0.0001 && forest.length; i++) {
    const c = rng.pick(forest);
    const cut = Math.min(cutBudget / (4 - i), w.trees[c]);
    w.trees[c] -= cut; cutBudget -= cut; t.wood += cut * 30;
  }

  // Mining
  if (mines.length) {
    const miners = Math.min(workers * 0.15, mines.length * 6);
    let st = 0, or = 0;
    for (const c of mines) { st += w.stone[c]; or += w.ore[c]; }
    t.stone += miners * 0.12 * (st / mines.length);
    t.ore += miners * 0.05 * (or / mines.length);
  }

  // Growth / famine
  t.housing = houses * 30 + 15;
  t.food = Math.min(t.food, 60 + t.pop * 3 + houses * 20);
  if (t.food < 0) {
    t.pop -= Math.min(t.pop * 0.04, -t.food * 0.5 + 0.5);
    t.food = 0;
  } else if (t.food > t.pop * 0.2) {
    const room = 1 - t.pop / t.housing;
    t.pop += t.pop * 0.03 * (t.blessed > 0 ? 1.6 : 1) * room;
  }
  if (t.plague > 0) {
    t.plague--;
    t.pop *= 0.975;
  }
  if (t.blessed > 0) t.blessed--;
  t.pop = Math.max(0, t.pop);
  t.wood = Math.min(t.wood, 250 + t.pop);
  t.stone = Math.min(t.stone, 200 + t.pop * 0.5);
  t.ore = Math.min(t.ore, 150 + t.pop * 0.3);
  t.peakPop = Math.max(t.peakPop, t.pop);

  // Decide what to build (one thing per tick)
  if (t.foodRate < eaten * 0.2 + 0.5 && t.wood >= 6 && buildFarm(state, t)) t.wood -= 6;
  else if (t.pop > t.housing * 0.8 && t.wood >= 12 && buildNear(state, t, BLD.HOUSE)) t.wood -= 12;
  else if (mines.length < 1 + t.pop / 70 && t.wood >= 8 && buildMine(state, t)) t.wood -= 8;

  // Expand the borders
  const want = 16 + t.pop * 0.5;
  if (cellsN < want && t.wood >= 2) {
    const got = expand(state, t, Math.min(3, 2 + Math.floor(t.wood / 60)));
    t.wood -= got * 2;
  }

  // Technology
  if (t.tech === 0 && t.stone >= 50 && t.ore >= 12 && t.pop >= 50) {
    t.stone -= 40; t.ore -= 10; t.tech = 1;
    addLog(state, `The ${t.name} enter the ${AGES[1]} and build boats.`, 'tech', t.capital);
  } else if (t.tech === 1 && t.stone >= 80 && t.ore >= 60 && t.pop >= 110) {
    t.stone -= 60; t.ore -= 50; t.tech = 2;
    addLog(state, `The ${t.name} enter the ${AGES[2]}.`, 'tech', t.capital);
  }

  // Boats: settle land across the sea
  if (t.tech >= 1 && t.pop > 100 && t.wood >= 30 && rng() < 0.005) colonize(state, t);

  // Plague spreads to neighbours
  if (t.plague > 10 && rng() < 0.04) {
    const nb = neighbourTribes(state, t);
    if (nb.length) {
      const o = rng.pick(nb);
      if (o.plague <= 0) { o.plague = 45; addLog(state, `Plague spreads to the ${o.name}.`, 'plague', o.capital); }
    }
  }
}

function frontier(state, t, samples) {
  const w = state.world, rng = state.rng;
  const cells = [...t.cells];
  const out = [];
  for (let i = 0; i < samples && cells.length; i++) {
    const c = cells[rng.int(cells.length)];
    for (let k = 0; k < 3; k++) {
      const n = w.nbr[c * 3 + k];
      if (w.owner[n] < 0 && !isWater(w.biome[n])) out.push(n);
    }
  }
  return out;
}

function cellValue(w, c) {
  const b = w.biome[c];
  let v = w.fert[c] + w.trees[c] * 0.5 + w.stone[c] * 0.5 + w.ore[c] * 0.8;
  if (b === B.SNOW) v -= 0.6;
  if (b === B.DESERT) v -= 0.2;
  if (w.bld[c] === BLD.RUIN) v += 0.3;
  return v;
}

function expand(state, t, k) {
  const w = state.world;
  const cand = frontier(state, t, 30);
  if (!cand.length) return 0;
  cand.sort((a, b) => cellValue(w, b) - cellValue(w, a));
  let got = 0;
  for (const c of cand) {
    if (got >= k) break;
    if (w.owner[c] >= 0) continue;
    setOwner(state, c, t.id);
    if (w.bld[c] === BLD.RUIN) w.bld[c] = BLD.NONE;
    got++;
  }
  return got;
}

function ownedNeighbour(w, c, id, bld) {
  for (let k = 0; k < 3; k++) {
    const n = w.nbr[c * 3 + k];
    if (w.owner[n] === id && (bld === undefined || w.bld[n] === bld)) return true;
  }
  return false;
}

function buildFarm(state, t) {
  const w = state.world;
  let best = -1, bestV = -1, clear = -1, clearV = -1;
  for (const c of t.cells) {
    if (w.bld[c] !== BLD.NONE || isWater(w.biome[c]) || w.biome[c] === B.MOUNTAIN || w.fire[c]) continue;
    const f = fertEff(w, c);
    if (f < 0.15) continue;
    const near = ownedNeighbour(w, c, t.id, BLD.HOUSE) || ownedNeighbour(w, c, t.id, BLD.FARM) ? 0.3 : 0;
    if (w.trees[c] < 0.35) {
      if (f + near > bestV) { bestV = f + near; best = c; }
    } else if (f + near - w.trees[c] * 0.3 > clearV) { clearV = f + near - w.trees[c] * 0.3; clear = c; }
  }
  if (best >= 0) {
    w.bld[best] = BLD.FARM;
    w.trees[best] = 0;
    if (best === t.clearTarget) t.clearTarget = -1;
    return true;
  }
  if (clear >= 0 && t.clearTarget < 0) t.clearTarget = clear; // cut the forest first
  return false;
}

function buildNear(state, t, type) {
  const w = state.world, rng = state.rng;
  const cand = [];
  for (const c of t.cells) {
    if (w.bld[c] !== BLD.NONE || isWater(w.biome[c]) || w.biome[c] === B.MOUNTAIN || w.fire[c]) continue;
    if (ownedNeighbour(w, c, t.id, BLD.HOUSE) || ownedNeighbour(w, c, t.id, BLD.FARM)) cand.push(c);
  }
  if (!cand.length) {
    for (const c of t.cells) if (w.bld[c] === BLD.NONE && !isWater(w.biome[c])) cand.push(c);
  }
  if (!cand.length) return false;
  const c = rng.pick(cand);
  w.bld[c] = type;
  w.trees[c] = Math.min(w.trees[c], 0.1);
  return true;
}

function buildMine(state, t) {
  const w = state.world;
  let best = -1, bestV = 0.3;
  for (const c of t.cells) {
    if (w.bld[c] !== BLD.NONE) continue;
    const v = w.stone[c] + w.ore[c] * 1.5;
    if (v > bestV) { bestV = v; best = c; }
  }
  if (best < 0) return false;
  w.bld[best] = BLD.MINE;
  return true;
}

function colonize(state, t) {
  const w = state.world, rng = state.rng;
  const coast = [...t.cells].filter((c) => nearWater(w, c));
  if (!coast.length) return;
  const from = rng.pick(coast);
  const area = cellsWithin(w, from, 0.45).filter((c) =>
    w.owner[c] < 0 && !isWater(w.biome[c]) && w.fert[c] > 0.4 && w.biome[c] !== B.SNOW);
  if (!area.length) return;
  const to = rng.pick(area);
  const ring = cellsWithin(w, to, 0.04);
  for (const c of ring) if (w.owner[c] < 0 && !isWater(w.biome[c])) setOwner(state, c, t.id);
  w.bld[to] = BLD.HOUSE;
  w.trees[to] = Math.min(w.trees[to], 0.1);
  t.wood -= 30;
  pushFx(state, { type: 'boat', from, to, color: t.color });
  addLog(state, `The ${t.name} sail across the sea and found a colony.`, 'colony', to);
}

// ---------------------------------------------------------------- diplomacy
export function strength(t) {
  return t.soldiers * (1 + 0.6 * t.tech) * (t.blessed > 0 ? 1.3 : 1) * (t.plague > 0 ? 0.7 : 1) + 1;
}

export function borders(state) {
  const w = state.world;
  const m = new Map();
  for (let c = 0; c < w.count; c++) {
    const o = w.owner[c];
    if (o < 0) continue;
    for (let k = 0; k < 3; k++) {
      const p = w.owner[w.nbr[c * 3 + k]];
      if (p >= 0 && p !== o) { const key = o * 4096 + p; m.set(key, (m.get(key) || 0) + 1); }
    }
  }
  return m;
}

function neighbourTribes(state, t) {
  const m = borders(state);
  return state.tribes.filter((o) => o.alive && o !== t && m.get(t.id * 4096 + o.id));
}

const getRel = (a, b) => a.rel.get(b.id) || 0;
// Fixed like/dislike between two peoples (culture, language...)
function affinity(state, a, b) {
  const lo = Math.min(a.id, b.id), hi = Math.max(a.id, b.id);
  const r = makeRng(state.seed + ':aff:' + lo + ':' + hi)();
  return (r * 2 - 1) * 1.1;
}
const setRel = (a, b, v) => { v = Math.max(-100, Math.min(100, v)); a.rel.set(b.id, v); b.rel.set(a.id, v); };

function diplomacy(state) {
  const rng = state.rng;
  const alive = state.tribes.filter((t) => t.alive);
  const bmap = borders(state);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j];
      const border = bmap.get(a.id * 4096 + b.id) || 0;
      let r = getRel(a, b) * 0.985;
      if (border > 0) {
        const crowd = Math.min(1.5, a.pop / (a.cells.size * 3 + 1) + b.pop / (b.cells.size * 3 + 1));
        r -= (a.aggression + b.aggression) * (border / (border + 8)) * (1.6 + crowd);
      } else r += 0.2 + 0.2 * Math.min(a.tech, b.tech); // far-away trade
      r += affinity(state, a, b);
      if (a.allies.has(b.id)) r += 0.8;
      for (const e of a.enemies) if (b.enemies.has(e)) { r += 3; break; }
      if (a.plague > 0 || b.plague > 0) r -= 0.5;
      r += rng.range(-1.5, 1.5);
      setRel(a, b, r);
      r = getRel(a, b);

      if (a.enemies.has(b.id)) {
        const wt = (a.warTime.get(b.id) || 0) + 3;
        a.warTime.set(b.id, wt); b.warTime.set(a.id, wt);
        if (wt > 36 && rng() < 0.05 + wt / 3000) makePeace(state, a, b);
      } else if (a.allies.has(b.id)) {
        if (r < 5) breakAlliance(state, a, b);
      } else if (r < -45 && border > 0) {
        const [att, def] = a.aggression >= b.aggression ? [a, b] : [b, a];
        if (strength(att) > strength(def) * 0.7) declareWar(state, att, def);
      } else if (r > 35) {
        a.allies.add(b.id); b.allies.add(a.id);
        addLog(state, `The ${a.name} and the ${b.name} form an alliance.`, 'ally', a.capital);
      }
    }
  }
}

export function declareWar(state, att, def, quiet = false) {
  if (att === def || att.enemies.has(def.id)) return;
  if (att.allies.has(def.id)) breakAlliance(state, att, def);
  att.enemies.add(def.id); def.enemies.add(att.id);
  att.warTime.set(def.id, 0); def.warTime.set(att.id, 0);
  setRel(att, def, Math.min(getRel(att, def), -50));
  addLog(state, `The ${att.name} declare war on the ${def.name}!`, 'war', def.capital);
  // allies of the defender join
  for (const aid of def.allies) {
    const ally = state.tribes[aid];
    if (!ally.alive || ally === att || ally.enemies.has(att.id) || ally.allies.has(att.id)) continue;
    ally.enemies.add(att.id); att.enemies.add(ally.id);
    ally.warTime.set(att.id, 0); att.warTime.set(ally.id, 0);
    setRel(ally, att, Math.min(getRel(ally, att), -40));
    addLog(state, `The ${ally.name} join the war to defend the ${def.name}.`, 'war', ally.capital);
  }
}

function makePeace(state, a, b) {
  a.enemies.delete(b.id); b.enemies.delete(a.id);
  a.warTime.delete(b.id); b.warTime.delete(a.id);
  setRel(a, b, -10);
  addLog(state, `The ${a.name} and the ${b.name} sign a peace treaty.`, 'peace', a.capital);
}

function breakAlliance(state, a, b) {
  a.allies.delete(b.id); b.allies.delete(a.id);
  addLog(state, `The alliance of the ${a.name} and the ${b.name} breaks.`, 'info', a.capital);
}

// ---------------------------------------------------------------- war
function wars(state) {
  const w = state.world, rng = state.rng;
  for (const a of state.tribes) {
    if (!a.alive) continue;
    for (const bid of a.enemies) {
      if (bid < a.id) continue; // each pair once
      const b = state.tribes[bid];
      if (!b.alive) continue;
      const sA = strength(a), sB = strength(b);
      const battles = Math.min(4, 1 + Math.floor(Math.min(sA, sB) / 30));
      for (let i = 0; i < battles; i++) {
        const aAttacks = rng() < sA / (sA + sB);
        const [att, def, sAtt, sDef] = aAttacks ? [a, b, sA, sB] : [b, a, sB, sA];
        const front = frontCells(state, att, def);
        if (!front.length) break;
        const [from, c] = rng.pick(front);
        const bonus = 1 + (w.biome[c] === B.HILLS ? 0.5 : 0) + (w.biome[c] === B.MOUNTAIN ? 1 : 0) + (w.bld[c] === BLD.HOUSE ? 0.6 : 0);
        const p = sAtt / (sAtt + sDef * bonus);
        att.pop = Math.max(0, att.pop - 0.5 - def.soldiers * 0.015);
        def.pop = Math.max(0, def.pop - 0.6 - att.soldiers * 0.02);
        if (rng() < p) {
          const lost = def.pop / Math.max(1, def.cells.size);
          def.pop = Math.max(0, def.pop - lost * 0.5);
          setOwner(state, c, att.id);
          if (w.bld[c] === BLD.HOUSE && rng() < 0.5) w.bld[c] = BLD.RUIN;
          if (c === def.capital) moveCapital(state, def);
          pushFx(state, { type: 'battle', from, cell: c, color: att.color, won: true });
        } else {
          pushFx(state, { type: 'battle', from, cell: c, color: att.color, won: false });
        }
      }
    }
  }
}

function frontCells(state, att, def) {
  const w = state.world;
  const out = [];
  for (const c of def.cells) {
    for (let k = 0; k < 3; k++) {
      const n = w.nbr[c * 3 + k];
      if (w.owner[n] === att.id) { out.push([n, c]); break; }
    }
  }
  return out;
}

function moveCapital(state, t) {
  const w = state.world;
  let best = -1;
  for (const c of t.cells) {
    if (w.bld[c] === BLD.HOUSE) { best = c; break; }
    if (best < 0) best = c;
  }
  if (best >= 0) {
    t.capital = best;
    if (t.cells.size > 3) addLog(state, `The ${t.name} lose their capital!`, 'war', best);
  }
}

function checkDeath(state, t) {
  if (t.pop >= 2 && t.cells.size > 0) return;
  const w = state.world;
  t.alive = false;
  for (const c of [...t.cells]) {
    setOwner(state, c, -1);
    if (w.bld[c] === BLD.HOUSE) w.bld[c] = BLD.RUIN;
    else if (w.bld[c] !== BLD.RUIN) w.bld[c] = BLD.NONE;
  }
  for (const o of state.tribes) {
    o.enemies.delete(t.id); o.allies.delete(t.id); o.warTime.delete(t.id);
  }
  t.enemies.clear(); t.allies.clear();
  t.pop = 0;
  addLog(state, `The ${t.name} have fallen.`, 'death', t.capital);
}

function civilWar(state) {
  const w = state.world, rng = state.rng;
  for (const t of state.tribes) {
    if (!t.alive || t.cells.size < 380 || t.pop < 400 || rng() > 0.002) continue;
    if (state.tribes.filter((x) => x.alive).length >= 14) return;
    const cells = [...t.cells];
    const far = cells.map((c) => [c, angleBetween(w, t.capital, c)]).sort((x, y) => y[1] - x[1]);
    const part = far.slice(0, Math.floor(cells.length * 0.4)).map((x) => x[0]);
    const seat = part.find((c) => w.bld[c] === BLD.HOUSE) ?? part[0];
    const rebels = spawnTribe(state, seat, { quiet: true, radius: 0.001, pop: 0, aggression: Math.min(1, t.aggression + 0.2) });
    if (!rebels) continue;
    for (const c of part) setOwner(state, c, rebels.id);
    const share = part.length / cells.length;
    rebels.pop = t.pop * share; t.pop -= rebels.pop;
    rebels.tech = t.tech; rebels.wood = t.wood * share; rebels.stone = t.stone * share; rebels.ore = t.ore * share;
    addLog(state, `Civil war! The ${rebels.name} break away from the ${t.name}.`, 'war', seat);
    declareWar(state, rebels, t);
    break;
  }
}

export function yearOf(tick) {
  return { year: Math.floor(tick / 12) + 1, month: (tick % 12) + 1 };
}
