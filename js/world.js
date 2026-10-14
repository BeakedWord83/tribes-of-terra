// The globe: a subdivided icosahedron. Each small triangle is one cell.
// Pure data, no DOM, no three.js — so Node tests can use it.
import { makeRng, makeNoise3, fbm } from './rng.js?v=mv81kvff';

export const B = {
  DEEP: 0, SHALLOW: 1, ICE: 2, BEACH: 3, GRASS: 4, FOREST: 5, JUNGLE: 6,
  DESERT: 7, TUNDRA: 8, SNOW: 9, HILLS: 10, MOUNTAIN: 11, SCORCHED: 12,
};
export const BIOME_NAMES = [
  'Deep ocean', 'Shallow sea', 'Sea ice', 'Beach', 'Grassland', 'Forest', 'Jungle',
  'Desert', 'Tundra', 'Snow', 'Hills', 'Mountain', 'Scorched land',
];
export const isWater = (b) => b <= B.ICE;

// Buildings on a cell
export const BLD = { NONE: 0, FARM: 1, HOUSE: 2, MINE: 3, RUIN: 4 };
export const BLD_NAMES = ['None', 'Farm', 'Village', 'Mine', 'Ruins'];

export const MAX_LEVEL = 10;

const T = 0.6180339887498949 + 1; // golden ratio
const ICO_V = [
  [-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0],
  [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T],
  [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1],
];
const ICO_F = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

// Build the cell grid. n = segments per icosahedron edge -> 20*n*n cells.
export function buildGrid(n = 32) {
  const verts = [];
  const vmap = new Map();
  const addV = (x, y, z) => {
    const l = Math.hypot(x, y, z);
    x /= l; y /= l; z /= l;
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    let id = vmap.get(key);
    if (id === undefined) { id = verts.length / 3; verts.push(x, y, z); vmap.set(key, id); }
    return id;
  };
  const faces = [];
  for (const [ia, ib, ic] of ICO_F) {
    const A = ICO_V[ia], Bv = ICO_V[ib], C = ICO_V[ic];
    const idx = []; // idx[i][j], i+j<=n
    for (let i = 0; i <= n; i++) {
      idx.push([]);
      for (let j = 0; j <= n - i; j++) {
        const a = (n - i - j) / n, b = i / n, c = j / n;
        idx[i].push(addV(
          A[0] * a + Bv[0] * b + C[0] * c,
          A[1] * a + Bv[1] * b + C[1] * c,
          A[2] * a + Bv[2] * b + C[2] * c));
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i; j++) {
        faces.push(idx[i][j], idx[i + 1][j], idx[i][j + 1]);
        if (j < n - i - 1) faces.push(idx[i + 1][j], idx[i + 1][j + 1], idx[i][j + 1]);
      }
    }
  }
  const count = faces.length / 3;
  const cellVerts = Int32Array.from(faces);
  const vertPos = Float32Array.from(verts);
  const center = new Float32Array(count * 3);
  for (let c = 0; c < count; c++) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 3; k++) {
      const v = cellVerts[c * 3 + k];
      x += vertPos[v * 3]; y += vertPos[v * 3 + 1]; z += vertPos[v * 3 + 2];
    }
    const l = Math.hypot(x, y, z);
    center[c * 3] = x / l; center[c * 3 + 1] = y / l; center[c * 3 + 2] = z / l;
  }
  // Neighbors: cells that share an edge
  const edgeMap = new Map();
  const nbr = new Int32Array(count * 3).fill(-1);
  for (let c = 0; c < count; c++) {
    for (let k = 0; k < 3; k++) {
      const a = cellVerts[c * 3 + k], b = cellVerts[c * 3 + ((k + 1) % 3)];
      const key = a < b ? a * 1e6 + b : b * 1e6 + a;
      const other = edgeMap.get(key);
      if (other === undefined) edgeMap.set(key, c);
      else {
        for (const [x, y] of [[c, other], [other, c]]) {
          for (let s = 0; s < 3; s++) if (nbr[x * 3 + s] === -1) { nbr[x * 3 + s] = y; break; }
        }
        edgeMap.delete(key);
      }
    }
  }
  return { count, cellVerts, vertPos, center, nbr };
}

let gridCache = null;
function getGrid() {
  if (!gridCache) gridCache = buildGrid(32);
  return gridCache;
}

export function generateWorld(seed) {
  const g = getGrid();
  const N = g.count;
  const rng = makeRng('world:' + seed);
  const nElev = makeNoise3(rng), nCont = makeNoise3(rng), nMoist = makeNoise3(rng);
  const nTemp = makeNoise3(rng), nOre = makeNoise3(rng);
  const off = () => rng.range(-50, 50);
  const o1 = [off(), off(), off()], o2 = [off(), off(), off()];

  const raw = new Float32Array(N);
  const temp = new Float32Array(N);
  const moist = new Float32Array(N);
  const oreBase = new Float32Array(N);
  for (let c = 0; c < N; c++) {
    const x = g.center[c * 3], y = g.center[c * 3 + 1], z = g.center[c * 3 + 2];
    const cont = fbm(nCont, x * 0.9 + o1[0], y * 0.9 + o1[1], z * 0.9 + o1[2], 3);
    const detail = fbm(nElev, x * 2.2, y * 2.2, z * 2.2, 6);
    raw[c] = cont * 0.75 + detail * 0.5;
    moist[c] = Math.min(1, Math.max(0, 0.5 + 0.75 * fbm(nMoist, x * 1.7 + o2[0], y * 1.7 + o2[1], z * 1.7 + o2[2], 4)));
    temp[c] = 1 - 1.08 * (Math.asin(Math.min(1, Math.abs(y))) / (Math.PI / 2)) + 0.12 * fbm(nTemp, x * 2, y * 2, z * 2, 3);
    oreBase[c] = Math.max(0, fbm(nOre, x * 5, y * 5, z * 5, 3) * 1.6);
  }
  const sorted = Float32Array.from(raw).sort();
  const sea = sorted[Math.floor(N * 0.6)];
  const top = sorted[N - 1];

  const level = new Uint8Array(N);
  for (let c = 0; c < N; c++) {
    if (raw[c] <= sea) level[c] = 0;
    else {
      const h = Math.pow((raw[c] - sea) / (top - sea), 0.95);
      level[c] = Math.min(MAX_LEVEL, 1 + Math.floor(h * MAX_LEVEL * 1.05));
      temp[c] -= h * 0.3; // high ground is colder
    }
  }

  const w = {
    seed: String(seed), ...g,
    raw, sea, level, temp, moist,
    biome: new Uint8Array(N),
    trees: new Float32Array(N),
    fert: new Float32Array(N),   // base fertility
    stone: new Float32Array(N),
    ore: new Float32Array(N),
    wet: new Float32Array(N),    // weather: >0 rain, <0 drought
    fire: new Uint8Array(N),     // ticks left burning
    scorch: new Uint16Array(N),  // ticks left scorched
    owner: new Int16Array(N).fill(-1),
    bld: new Uint8Array(N),
    oreBase,
    version: 0,                  // bump when terrain shape changes
  };
  for (let c = 0; c < N; c++) classify(w, c, rng, true);
  return w;
}

export function nearWater(w, c) {
  for (let k = 0; k < 3; k++) if (w.level[w.nbr[c * 3 + k]] === 0) return true;
  return false;
}

// Decide biome + base resources for a cell from level/temp/moisture.
export function classify(w, c, rng, initial = false) {
  const L = w.level[c], t = w.temp[c], m = w.moist[c];
  let b;
  if (L === 0) {
    if (t < 0.06) b = B.ICE;
    else {
      let shallow = w.raw[c] > w.sea - 0.05;
      for (let k = 0; k < 3 && !shallow; k++) if (w.level[w.nbr[c * 3 + k]] > 0) shallow = true;
      b = shallow ? B.SHALLOW : B.DEEP;
    }
  } else if (L >= 8) b = t < 0.4 ? B.SNOW : B.MOUNTAIN;
  else if (L >= 6) b = t < 0.15 ? B.SNOW : B.HILLS;
  else if (t < 0.12) b = B.SNOW;
  else if (t < 0.3) b = B.TUNDRA;
  else if (L === 1 && t > 0.35 && nearWater(w, c) && m < 0.7) b = B.BEACH;
  else if (t > 0.62 && m < 0.42) b = B.DESERT;
  else if (t > 0.6 && m > 0.6) b = B.JUNGLE;
  else if (m > 0.5) b = B.FOREST;
  else b = B.GRASS;
  w.biome[c] = b;

  const FERT = [0, 0, 0, 0.3, 1, 0.8, 0.7, 0.08, 0.25, 0, 0.5, 0.05, 0.4];
  w.fert[c] = FERT[b] * (0.75 + 0.5 * m);
  w.stone[c] = b === B.MOUNTAIN ? 1 : b === B.HILLS ? 0.6 : b === B.SNOW && L >= 6 ? 0.7 : 0.05;
  w.ore[c] = (b === B.MOUNTAIN || b === B.HILLS || (b === B.SNOW && L >= 6)) ? Math.min(1, 0.25 + w.oreBase[c]) : 0;
  if (initial) {
    const r = rng ? rng() : 0.5;
    const TREES = [0, 0, 0, 0, 0.1 + 0.2 * r, 0.75 + 0.25 * r, 0.9 + 0.1 * r, 0, 0.2 + 0.25 * r, 0, 0.25 * r, 0.05 * r, 0];
    w.trees[c] = TREES[b];
  } else if (maxTrees(w, c) < w.trees[c]) {
    w.trees[c] = maxTrees(w, c);
  }
}

// How many trees a cell can hold (regrowth target).
export function maxTrees(w, c) {
  const MAX = [0, 0, 0, 0, 0.3, 1, 1, 0, 0.45, 0, 0.3, 0.05, 0];
  return MAX[w.biome[c]];
}

// All cells whose center is within `ang` radians of cell c.
export function cellsWithin(w, c, ang) {
  const cx = w.center[c * 3], cy = w.center[c * 3 + 1], cz = w.center[c * 3 + 2];
  const cos = Math.cos(ang);
  const out = [];
  for (let i = 0; i < w.count; i++) {
    if (cx * w.center[i * 3] + cy * w.center[i * 3 + 1] + cz * w.center[i * 3 + 2] >= cos) out.push(i);
  }
  return out;
}

export function angleBetween(w, a, b) {
  const d = w.center[a * 3] * w.center[b * 3] + w.center[a * 3 + 1] * w.center[b * 3 + 1] + w.center[a * 3 + 2] * w.center[b * 3 + 2];
  return Math.acos(Math.max(-1, Math.min(1, d)));
}

export function worldHash(w) {
  let h = 2166136261;
  for (let c = 0; c < w.count; c++) {
    h ^= w.biome[c] * 31 + w.level[c] * 7 + (w.owner[c] + 1) * 131 + w.bld[c] * 1009;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
