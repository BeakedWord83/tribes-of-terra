// Headless tests for the pure-JS simulation. Run: node --test tests/sim.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, worldHash, B, BLD, isWater, cellsWithin, angleBetween } from '../js/world.js';
import { createSim, step, fertEff } from '../js/sim.js';
import { applyPower } from '../js/powers.js';

const fresh = (seed = '42') => createSim(generateWorld(seed), seed);
const run = (s, n) => { for (let i = 0; i < n; i++) step(s); return s; };
const alive = (s) => s.tribes.filter((t) => t.alive);
const lastLog = (s) => s.log[s.log.length - 1];

// ------------------------------------------------------------------ helpers
function findCell(s, pred) {
  const w = s.world;
  for (let c = 0; c < w.count; c++) if (pred(c, w)) return c;
  return -1;
}
// Land cell not owned, whose whole radius-r disc is free of tribe land
function freeLand(s, pred, r = 0.2) {
  const w = s.world;
  const caps = alive(s).map((t) => t.capital);
  return findCell(s, (c) => !isWater(w.biome[c]) && w.owner[c] < 0 && pred(c, w)
    && caps.every((p) => angleBetween(w, p, c) > r * 2));
}
const sumTrees = (w, cells) => cells.reduce((a, c) => a + w.trees[c], 0);

// ------------------------------------------------------------------ 1. world
test('world: deterministic per seed, different across seeds', () => {
  const h1 = worldHash(generateWorld('42'));
  assert.equal(worldHash(generateWorld('42')), h1);
  assert.notEqual(worldHash(generateWorld('7')), h1);
  assert.notEqual(worldHash(generateWorld('abc')), worldHash(generateWorld('7')));
  assert.notEqual(worldHash(generateWorld('abc')), h1);
});

test('world: every cell has 3 valid, distinct, symmetric neighbours', () => {
  const w = generateWorld('42');
  assert.equal(w.count, 20480);
  for (let c = 0; c < w.count; c++) {
    const ns = [w.nbr[c * 3], w.nbr[c * 3 + 1], w.nbr[c * 3 + 2]];
    for (const n of ns) {
      assert.ok(Number.isInteger(n) && n >= 0 && n < w.count, `cell ${c} bad neighbour ${n}`);
      assert.notEqual(n, c);
      const back = [w.nbr[n * 3], w.nbr[n * 3 + 1], w.nbr[n * 3 + 2]];
      assert.ok(back.includes(c), `cell ${c} -> ${n} not symmetric`);
    }
    assert.equal(new Set(ns).size, 3, `cell ${c} has duplicate neighbours`);
  }
});

test('world: all biomes except SCORCHED appear across seeds; 55-65% water', () => {
  const seen = new Set();
  for (const seed of ['42', '7', 'abc']) {
    const w = generateWorld(seed);
    let water = 0;
    for (let c = 0; c < w.count; c++) {
      seen.add(w.biome[c]);
      if (isWater(w.biome[c])) water++;
      assert.ok(w.biome[c] <= B.SCORCHED);
    }
    const f = water / w.count;
    assert.ok(f >= 0.55 && f <= 0.65, `seed ${seed} water fraction ${f}`);
  }
  for (const [name, id] of Object.entries(B)) {
    if (id === B.SCORCHED) continue;
    assert.ok(seen.has(id), `biome ${name} never appears`);
  }
  assert.ok(!seen.has(B.SCORCHED), 'fresh worlds have no scorched land');
});

// ------------------------------------------------------------------ 2. economy
test('economy: seed 42 for 300 ticks (pop, farms, trees, resources, territory, tech)', () => {
  const s = fresh('42');
  const w = s.world;
  const start = s.tribes.map((t) => ({ pop: t.pop, cells: t.cells.size }));
  assert.ok(s.tribes.length >= 5);
  for (const t of s.tribes) assert.equal(t.pop, 30);
  const trees0 = Float32Array.from(w.trees);
  let maxWood = 0, maxStone = 0, maxOre = 0, sawFarm = false, maxTech = 0;
  for (let i = 0; i < 300; i++) {
    step(s);
    for (const t of alive(s)) {
      maxWood = Math.max(maxWood, t.wood); maxStone = Math.max(maxStone, t.stone);
      maxOre = Math.max(maxOre, t.ore); maxTech = Math.max(maxTech, t.tech);
    }
  }
  const surv = alive(s);
  assert.ok(surv.length >= 1, 'someone survives');
  for (const t of surv) {
    assert.ok(t.peakPop > 30, `tribe ${t.id} never grew past 30`);
    assert.ok(t.pop > 30, `tribe ${t.id} pop ${t.pop} not above start 30`);
  }
  // farms
  let farms = 0, owned = [];
  for (let c = 0; c < w.count; c++) {
    if (w.owner[c] >= 0) { owned.push(c); if (w.bld[c] === BLD.FARM) farms++; }
  }
  assert.ok(farms > 0, 'farms exist on owned land');
  // every farm is owned, houses/mines too (no buildings leak on dead land)
  // trees on owned land decreased
  const before = owned.reduce((a, c) => a + trees0[c], 0);
  const after = sumTrees(w, owned);
  assert.ok(after < before, `trees on owned land: ${before} -> ${after}`);
  // resources
  assert.ok(maxWood > 25, `wood gained (max ${maxWood})`);
  assert.ok(maxStone > 0, 'stone gained');
  assert.ok(maxOre > 0, 'ore gained');
  // territory
  const totalStart = start.reduce((a, x) => a + x.cells, 0);
  assert.ok(owned.length > totalStart, `territory ${totalStart} -> ${owned.length}`);
  assert.ok(maxTech >= 1, 'some tribe reached tech 1');
  // ownership bookkeeping consistent
  for (const t of s.tribes) for (const c of t.cells) assert.equal(w.owner[c], t.id);
  let count = 0;
  for (const t of s.tribes) count += t.cells.size;
  assert.equal(count, owned.length);
});

// ------------------------------------------------------------------ 3. diplomacy / war
test('diplomacy: logs, cell conquest, no ally+enemy overlap, dead tribes clean', () => {
  const kinds = new Set();
  let conquests = 0;
  let violations = 0, rebelMoves = 0;
  const deadSeen = new Set();
  for (const seed of ['42', '7', 'abc', '1', '2']) {
    const s = fresh(seed);
    const w = s.world;
    let prev = Int16Array.from(w.owner);
    for (let i = 0; i < 1200; i++) {
      const nBefore = s.tribes.length;
      step(s);
      for (let c = 0; c < w.count; c++) {
        const a = prev[c], b = w.owner[c];
        if (a !== b && a >= 0 && b >= 0) {
          // a was taken by b: they must be enemies (war) at this point.
          // Exception: b is a rebel tribe born this very tick (civil war moves cells that
          // may have been conquered earlier in the same tick, so a != parent).
          if (b >= nBefore) { rebelMoves++; continue; }
          const ta = s.tribes[a], tb = s.tribes[b];
          if (ta.enemies.has(b) || tb.enemies.has(a) || !ta.alive) conquests++;
          else violations++;
        }
      }
      prev = Int16Array.from(w.owner);
      for (const t of s.tribes) {
        for (const x of t.allies) if (t.enemies.has(x)) throw new Error(`seed ${seed} tick ${s.tick}: tribe ${t.id} both ally and enemy of ${x}`);
        if (!t.alive) {
          deadSeen.add(`${seed}:${t.id}`);
          assert.equal(t.cells.size, 0, 'dead tribe owns no cells');
          assert.equal(t.allies.size, 0);
          assert.equal(t.enemies.size, 0);
          for (const o of s.tribes) {
            assert.ok(!o.allies.has(t.id) && !o.enemies.has(t.id), 'nobody allied/at war with the dead');
          }
        }
      }
    }
    for (const l of s.log) kinds.add(l.kind);
    // log entries accumulate in a capped buffer: also scan live as we go isn't needed, final tail is enough per seed
    for (let c = 0; c < w.count; c++) if (w.owner[c] >= 0) assert.ok(s.tribes[w.owner[c]].alive);
  }
  assert.ok(conquests > 0, 'a war changed cell owners');
  assert.equal(violations, 0, 'owner changed between tribes that were not at war');
  assert.ok(deadSeen.size > 0, 'at least one tribe died across seeds');
});

test('diplomacy: log kinds ally / war / peace-or-death appear (scanning every tick)', () => {
  const kinds = new Set();
  for (const seed of ['42', '7', 'abc', '1', '2']) {
    const s = fresh(seed);
    for (let i = 0; i < 1200; i++) {
      step(s);
      // log is capped at 300 so collect new entries each tick
      for (let k = s.log.length - 1; k >= 0 && s.log[k].tick === s.tick; k--) kinds.add(s.log[k].kind);
    }
  }
  assert.ok(kinds.has('ally'), 'alliance logged');
  assert.ok(kinds.has('war'), 'war logged');
  assert.ok(kinds.has('peace') || kinds.has('death'), 'peace or death logged');
  assert.ok(kinds.has('peace'), 'peace logged');
  assert.ok(kinds.has('death'), 'death logged');
});

// ------------------------------------------------------------------ 4. powers
test('powers: unknown id / no cell', () => {
  const s = fresh();
  assert.equal(applyPower(s, 'nope', 5).ok, false);
  assert.equal(applyPower(s, 'rain', -1).ok, false);
  assert.equal(applyPower(s, 'rain', null).ok, false);
});

test('power tribe: on free land spawns a tribe that owns the cell', () => {
  const s = fresh();
  const w = s.world;
  const n = s.tribes.length;
  const cell = freeLand(s, () => true, 0.1);
  assert.ok(cell >= 0);
  const r = applyPower(s, 'tribe', cell);
  assert.equal(r.ok, true);
  assert.equal(s.tribes.length, n + 1);
  const t = s.tribes[n];
  assert.equal(w.owner[cell], t.id);
  assert.ok(t.cells.has(cell));
  assert.ok(!isWater(w.biome[cell]));
  assert.equal(w.bld[cell], BLD.HOUSE);
  assert.equal(t.alive, true);
  assert.equal(t.enemies.size, 0, 'no war on empty land');
});

test('power tribe: on water fails, no new tribe', () => {
  const s = fresh();
  const n = s.tribes.length;
  for (const bio of [B.DEEP, B.SHALLOW]) {
    const cell = findCell(s, (c, w) => w.biome[c] === bio);
    assert.ok(cell >= 0);
    const r = applyPower(s, 'tribe', cell);
    assert.equal(r.ok, false);
  }
  assert.equal(s.tribes.length, n);
});

test('power tribe: on another tribe\'s land makes them enemies', () => {
  const s = fresh();
  const w = s.world;
  const victim = s.tribes[0];
  const cell = [...victim.cells].find((c) => c !== victim.capital && !isWater(w.biome[c]));
  assert.ok(cell >= 0);
  const n = s.tribes.length;
  const r = applyPower(s, 'tribe', cell);
  assert.equal(r.ok, true);
  const t = s.tribes[n];
  assert.equal(w.owner[cell], t.id);
  assert.ok(t.enemies.has(victim.id));
  assert.ok(victim.enemies.has(t.id));
  assert.ok(s.log.some((l) => l.kind === 'war'));
  assert.ok(!victim.cells.has(cell));
});

test('power tribe: world too crowded (24 alive) is refused', () => {
  const s = fresh();
  let guard = 0;
  while (alive(s).length < 24 && guard++ < 200) {
    const c = freeLand(s, () => true, 0.01);
    if (c < 0) break;
    applyPower(s, 'tribe', c);
  }
  assert.equal(alive(s).length, 24);
  const c = freeLand(s, () => true, 0.01);
  const n = s.tribes.length;
  assert.equal(applyPower(s, 'tribe', c).ok, false);
  assert.equal(s.tribes.length, n);
});

test('power meteor: on a tribe\'s land', () => {
  const s = fresh();
  const w = s.world;
  const t = s.tribes[0];
  const cell = t.capital;
  const lvl = w.level[cell];
  assert.ok(lvl > 0);
  const pop = t.pop, v = w.version;
  const area = cellsWithin(w, cell, 0.09);
  const r = applyPower(s, 'meteor', cell);
  assert.equal(r.ok, true);
  assert.ok(t.pop < pop, `pop ${pop} -> ${t.pop}`);
  assert.ok(w.level[cell] < lvl, 'level at centre lowered');
  for (const c of area) if (angleBetween(w, cell, c) <= 0.09) assert.equal(w.trees[c], 0, 'crater has no trees');
  assert.equal(w.bld[cell], BLD.NONE);
  assert.equal(w.version, v + 1);
  assert.equal(lastLog(s).kind, 'disaster');
  assert.ok(r.killed > 0);
  assert.ok(s.fx.some((f) => f.type === 'impact'));
});

test('power meteor: scorched crater on high ground; deep crater turns to sea', () => {
  const s = fresh();
  const w = s.world;
  const hi = findCell(s, (c) => w.level[c] >= 5 && w.level[c] <= 7 && w.owner[c] < 0 && cellsWithin(w, c, 0.1).every((x) => w.owner[x] < 0));
  assert.ok(hi >= 0);
  applyPower(s, 'meteor', hi);
  assert.ok(s.scorched.size > 0 || w.biome[hi] === B.SCORCHED || isWater(w.biome[hi]));
  const lo = findCell(s, (c) => w.level[c] === 1 && !isWater(w.biome[c]) && w.owner[c] < 0);
  assert.ok(lo >= 0);
  applyPower(s, 'meteor', lo);
  assert.equal(w.level[lo], 0);
  assert.ok(isWater(w.biome[lo]), 'level-1 land becomes sea');
});

test('power meteor: on water -> ok, no crash, tsunami may hurt coast', () => {
  const s = fresh();
  const w = s.world;
  const v = w.version;
  const cell = findCell(s, (c) => w.biome[c] === B.SHALLOW && cellsWithin(w, c, 0.17).some((x) => w.owner[x] >= 0));
  const cell2 = cell >= 0 ? cell : findCell(s, (c) => w.biome[c] === B.DEEP);
  const r = applyPower(s, 'meteor', cell2);
  assert.equal(r.ok, true);
  assert.equal(w.version, v + 1);
  assert.equal(lastLog(s).kind, 'disaster');
  assert.match(r.msg, /sea/);
  run(s, 5); // still stable
});

test('power rain: douses fires; wet > 0 later; fertEff of a farm rises', () => {
  const s = fresh();
  const w = s.world;
  const cell = freeLand(s, (c) => w.biome[c] === B.GRASS || w.biome[c] === B.FOREST, 0.2);
  assert.ok(cell >= 0);
  const area = cellsWithin(w, cell, 0.16);
  const land = area.filter((c) => !isWater(w.biome[c]));
  const burning = land.slice(0, 15);
  for (const c of burning) { w.fire[c] = 5; s.burning.add(c); }
  // farm on a fertile cell in the area
  const farm = land.find((c) => w.fert[c] > 0.3 && w.owner[c] < 0);
  assert.ok(farm >= 0);
  w.bld[farm] = BLD.FARM; w.trees[farm] = 0; w.fire[farm] = 0; s.burning.delete(farm);
  const before = fertEff(w, farm);
  const r = applyPower(s, 'rain', cell);
  assert.equal(r.ok, true);
  for (const c of burning) { assert.equal(w.fire[c], 0); assert.ok(!s.burning.has(c)); }
  assert.match(r.msg, /puts out \d+ fires/);
  run(s, 30);
  const wetCells = area.filter((c) => w.wet[c] > 0).length;
  assert.ok(wetCells > area.length * 0.9, `wet cells ${wetCells}/${area.length}`);
  assert.ok(w.wet[farm] > 0);
  assert.ok(fertEff(w, farm) > before, `fertEff ${before} -> ${fertEff(w, farm)}`);
});

test('power rain: rain during weather also douses new fires', () => {
  const s = fresh();
  const w = s.world;
  const cell = freeLand(s, (c) => w.biome[c] === B.FOREST, 0.2);
  assert.ok(cell >= 0);
  applyPower(s, 'rain', cell);
  const c = cellsWithin(w, cell, 0.1).find((x) => !isWater(w.biome[x]));
  w.fire[c] = 9; s.burning.add(c);
  step(s);
  assert.equal(w.fire[c], 0);
  assert.ok(!s.burning.has(c));
});

test('power drought: wet < 0 later; fertEff of a farm drops', () => {
  const s = fresh();
  const w = s.world;
  const cell = freeLand(s, (c) => w.biome[c] === B.GRASS || w.biome[c] === B.FOREST, 0.2);
  assert.ok(cell >= 0);
  const area = cellsWithin(w, cell, 0.2);
  const land = area.filter((c) => !isWater(w.biome[c]));
  const farm = land.find((c) => w.fert[c] > 0.3 && w.owner[c] < 0);
  assert.ok(farm >= 0);
  w.bld[farm] = BLD.FARM; w.trees[farm] = 0;
  const before = fertEff(w, farm);
  const r = applyPower(s, 'drought', cell);
  assert.equal(r.ok, true);
  run(s, 30);
  const dry = area.filter((c) => w.wet[c] < 0).length;
  assert.ok(dry > area.length * 0.9, `dry cells ${dry}/${area.length}`);
  assert.ok(fertEff(w, farm) < before, `fertEff ${before} -> ${fertEff(w, farm)}`);
});

test('power drought: weather expires and wet decays back to 0', () => {
  const s = fresh();
  const w = s.world;
  const cell = freeLand(s, () => true, 0.2);
  applyPower(s, 'drought', cell);
  assert.equal(s.weather.length, 1);
  run(s, 400);
  assert.equal(s.weather.length, 0);
  assert.equal(w.wet[cell], 0);
});

test('power forest: bare unowned land grows trees', () => {
  const s = fresh();
  const w = s.world;
  const cell = freeLand(s, (c) => w.biome[c] === B.GRASS && w.trees[c] < 0.3, 0.15);
  assert.ok(cell >= 0);
  const area = cellsWithin(w, cell, 0.12).filter((c) => !isWater(w.biome[c]) && w.bld[c] === BLD.NONE);
  const before = sumTrees(w, area);
  const tc = w.trees[cell];
  const r = applyPower(s, 'forest', cell);
  assert.equal(r.ok, true);
  assert.ok(r.grown > 0);
  assert.ok(sumTrees(w, area) > before, 'total trees rise');
  assert.ok(w.trees[cell] > tc, `centre trees ${tc} -> ${w.trees[cell]}`);
  assert.ok(w.trees[cell] >= 0.3);
  assert.equal(lastLog(s).kind, 'nature');
});

test('power forest: on open sea does nothing (ok false)', () => {
  const s = fresh();
  const w = s.world;
  const cell = findCell(s, (c) => w.biome[c] === B.DEEP && cellsWithin(w, c, 0.12).every((x) => isWater(w.biome[x])));
  assert.ok(cell >= 0);
  assert.equal(applyPower(s, 'forest', cell).ok, false);
});

test('power forest: does not erase houses', () => {
  const s = fresh();
  const w = s.world;
  const t = s.tribes[0];
  const house = t.capital;
  applyPower(s, 'forest', house);
  assert.equal(w.bld[house], BLD.HOUSE);
  assert.ok(w.trees[house] <= 0.1 + 1e-6, 'trees on a house stay cleared');
});

test('power quake: levels rise at centre, version increments', () => {
  const s = fresh();
  const w = s.world;
  const cell = findCell(s, (c) => !isWater(w.biome[c]) && w.level[c] >= 1 && w.level[c] <= 4 && w.owner[c] < 0);
  assert.ok(cell >= 0);
  const lv = w.level[cell], v = w.version;
  const area = cellsWithin(w, cell, 0.1);
  const lvBefore = area.map((c) => w.level[c]);
  const r = applyPower(s, 'quake', cell);
  assert.equal(r.ok, true);
  assert.ok(w.level[cell] >= lv + 4, `centre ${lv} -> ${w.level[cell]}`);
  assert.equal(w.version, v + 1);
  assert.equal(lastLog(s).kind, 'disaster');
  area.forEach((c, i) => assert.ok(w.level[c] >= lvBefore[i], 'no level decreases'));
  assert.ok(s.fx.some((f) => f.type === 'quake'));
});

test('power quake: on a tribe hurts pop and topples buildings; on sea uplifts', () => {
  const s = fresh();
  const w = s.world;
  const t = s.tribes[0];
  const pop = t.pop;
  const houses = [...t.cells].filter((c) => w.bld[c] !== BLD.NONE).length;
  applyPower(s, 'quake', t.capital);
  assert.ok(t.pop < pop);
  assert.ok([...t.cells].filter((c) => w.bld[c] !== BLD.NONE).length <= houses);
  // sea cell (deep): level 0 with rise >=3 becomes land
  const sea = findCell(s, (c) => w.biome[c] === B.DEEP && cellsWithin(w, c, 0.1).every((x) => w.owner[x] < 0));
  assert.ok(sea >= 0);
  applyPower(s, 'quake', sea);
  assert.ok(w.level[sea] >= 4);
  assert.ok(!isWater(w.biome[sea]), 'sea floor rises to land');
});

test('power plague: sets plague and reduces pop vs control', () => {
  const a = fresh('plague1'), b = fresh('plague1');
  assert.equal(worldHash(a.world), worldHash(b.world));
  const ta = a.tribes[0];
  const r = applyPower(a, 'plague', ta.capital);
  assert.equal(r.ok, true);
  assert.equal(r.tribe, ta.id);
  assert.ok(ta.plague > 0);
  assert.equal(lastLog(a).kind, 'plague');
  run(a, 20); run(b, 20);
  const tb = b.tribes[0];
  assert.ok(ta.pop < tb.pop, `plague pop ${ta.pop} vs control ${tb.pop}`);
  assert.ok(ta.pop < tb.pop * 0.8, 'at least 20% lower');
});

test('power plague: nearby unowned cell still finds tribe; empty ocean fails', () => {
  const s = fresh();
  const w = s.world;
  const t = s.tribes[0];
  const near = cellsWithin(w, t.capital, 0.09).find((c) => w.owner[c] < 0);
  if (near !== undefined) assert.equal(applyPower(s, 'plague', near).ok, true);
  const far = findCell(s, (c) => isWater(w.biome[c]) && alive(s).every((x) => angleBetween(w, x.capital, c) > 0.2));
  assert.ok(far >= 0);
  const before = s.tribes.map((x) => x.plague);
  assert.equal(applyPower(s, 'plague', far).ok, false);
  assert.deepEqual(s.tribes.map((x) => x.plague), before);
});

test('power bless: boosts pop/food/tech vs control; tech capped at 2; ocean fails', () => {
  const a = fresh('bless1'), b = fresh('bless1');
  const ta = a.tribes[0], tb = b.tribes[0];
  ta.plague = 30;
  assert.equal(ta.tech, 0);
  const pop0 = ta.pop, food0 = ta.food;
  const r = applyPower(a, 'bless', ta.capital);
  assert.equal(r.ok, true);
  assert.equal(ta.tech, 1, 'tech +1');
  assert.ok(ta.pop > pop0 && ta.food > food0);
  assert.equal(ta.plague, 0, 'bless cures plague');
  assert.ok(ta.blessed > 0);
  assert.equal(lastLog(a).kind, 'bless');
  run(a, 20); run(b, 20);
  assert.ok(ta.pop > tb.pop, `blessed ${ta.pop} vs control ${tb.pop}`);
  assert.ok(ta.food > tb.food);
  // tech 2 -> stays 2
  const c = fresh('bless1'); const tc = c.tribes[0]; tc.tech = 2;
  applyPower(c, 'bless', tc.capital);
  assert.equal(tc.tech, 2);
  // tech 1 -> 2
  const d = fresh('bless1'); const td = d.tribes[0]; td.tech = 1;
  applyPower(d, 'bless', td.capital);
  assert.equal(td.tech, 2);
  // ocean far from everyone
  const w = a.world;
  const far = findCell(a, (x) => isWater(w.biome[x]) && alive(a).every((t) => angleBetween(w, t.capital, x) > 0.2));
  assert.ok(far >= 0);
  const logN = a.log.length;
  assert.equal(applyPower(a, 'bless', far).ok, false);
  assert.equal(a.log.length, logN);
});

// ------------------------------------------------------------------ 5. determinism
test('determinism: same seed, 200 steps -> identical world and pops', () => {
  const a = fresh('det'), b = fresh('det');
  run(a, 200); run(b, 200);
  assert.equal(worldHash(a.world), worldHash(b.world));
  assert.deepEqual(a.tribes.map((t) => t.pop), b.tribes.map((t) => t.pop));
  assert.deepEqual(a.log.map((l) => l.text), b.log.map((l) => l.text));
  const c = fresh('det2'); run(c, 200);
  assert.notEqual(worldHash(c.world), worldHash(a.world));
});

test('determinism: powers applied identically give identical results', () => {
  const mk = () => { const s = fresh('det3'); run(s, 50); applyPower(s, 'meteor', s.tribes[0].capital); applyPower(s, 'quake', s.tribes[1].capital); run(s, 100); return s; };
  const a = mk(), b = mk();
  assert.equal(worldHash(a.world), worldHash(b.world));
  assert.deepEqual(a.tribes.map((t) => t.pop), b.tribes.map((t) => t.pop));
});
