// three.js view of the world: a voxel globe drawn at low resolution
// and scaled up with hard pixels.
import * as THREE from '../vendor/three.module.js?v=mv80zrn6';
import { OrbitControls } from '../vendor/OrbitControls.js?v=mv80zrn6';
import { B, BLD, isWater, cellsWithin } from './world.js?v=mv80zrn6';

const CELL_TRIS = 7; // 1 top + 3 side quads
const LEVEL_H = 0.011;
const BASE_R = 0.985;
export const topRadius = (L) => 1 + L * LEVEL_H;

const PALETTE = {
  [B.DEEP]: 0x1b3a6b, [B.SHALLOW]: 0x2e6ea6, [B.ICE]: 0xd9e6f0, [B.BEACH]: 0xe3cf8c,
  [B.GRASS]: 0x72b04a, [B.FOREST]: 0x5a9a3c, [B.JUNGLE]: 0x3f8f3a, [B.DESERT]: 0xddb560,
  [B.TUNDRA]: 0x9aa483, [B.SNOW]: 0xf2f6fa, [B.HILLS]: 0x8d9156, [B.MOUNTAIN]: 0x7f7468,
  [B.SCORCHED]: 0x3b2a22,
};
const C = (hex) => new THREE.Color(hex);
const BIOME_COL = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, C(v)]));
const TREE_DARK = C(0x2a5a26), FARM_A = C(0xd9b443), FARM_B = C(0xa98f34), MINE_COL = C(0x4c4a48);
const SMOKE = [C(0x6a6662), C(0x8a8580), C(0x4e4a47)];
const STEAM = C(0xe8eef2);
const SKIN = [C(0xf1c9a5), C(0xd9a273), C(0xa8724a), C(0x6e4a2e)];
const RUIN_COL = C(0x6b5d50), FIRE_A = C(0xff5a00), FIRE_B = C(0xffd23a), DRY = C(0xc9a25a);

function hash01(i) {
  let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.pixel = 3;
    this.pixelMode = 'auto'; // 'auto' or a fixed pixel size
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    this.gl.setPixelRatio(1);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060f);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
    this.camera.position.set(0, 0.8, 3.1);
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, { enablePan: false, enableDamping: true, dampingFactor: 0.08, minDistance: 1.16, maxDistance: 5, autoRotate: true, autoRotateSpeed: 0.35 });
    // `camera` is driven by OrbitControls; `view` is what we draw with (camera + tilt near the ground)
    this.view = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
    this.scene.add(this.view);
    const sun = new THREE.DirectionalLight(0xfff3dd, 2.6);
    sun.position.set(-2, 2.5, 3);
    this.view.add(sun);
    this.scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x302418, 1.1));
    this.addStars();
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.09, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0x5aa8ff, transparent: true, opacity: 0.13, side: THREE.BackSide, depthWrite: false }));
    this.scene.add(atmo);
    this.raycaster = new THREE.Raycaster();
    this.tmpColor = new THREE.Color();
    this.tmpColor2 = new THREE.Color();
    this.units = [];
    this.anims = [];
    this.shake = 0;
    this.time = 0;
    this.makeCursor();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  addStars() {
    const n = 1500, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(60 + Math.random() * 40);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1, sizeAttenuation: false })));
  }

  // 'auto': chunky pixels far away, sharp when zoomed in. A number: fixed pixel size.
  setPixelSize(p) {
    this.pixelMode = p;
    if (p !== 'auto') this.pixel = p;
    this.resize();
  }

  autoPixel() {
    const d = this.camera.position.length();
    return d > 2.7 ? 3 : d > 1.8 ? 2 : 1;
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.gl.setSize(Math.max(1, Math.floor(w / this.pixel)), Math.max(1, Math.floor(h / this.pixel)), false);
    for (const cam of [this.camera, this.view]) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
  }

  // ------------------------------------------------------------ world mesh
  setState(state) {
    this.state = state;
    const w = state.world;
    if (this.globe) {
      this.scene.remove(this.globe); this.globe.geometry.dispose();
      for (const m of this.inst) { this.scene.remove(m); m.geometry.dispose(); }
      for (const a of this.anims) a.dispose?.();
      this.anims = []; this.units = [];
      for (const o of this.weatherObjs?.values() || []) this.scene.remove(o.group);
    }
    this.weatherObjs = new Map();
    this.terrT = 0;
    const N = w.count;
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(N * CELL_TRIS * 9), 3);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(N * CELL_TRIS * 9), 3);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    this.globe = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    this.scene.add(this.globe);
    this.version = -1;
    this.jitter = new Float32Array(N);
    for (let c = 0; c < N; c++) this.jitter[c] = 0.93 + 0.14 * hash01(c);
    this.quat = new Float32Array(N * 4);
    const up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), q = new THREE.Quaternion(), spin = new THREE.Quaternion();
    for (let c = 0; c < N; c++) {
      n.set(w.center[c * 3], w.center[c * 3 + 1], w.center[c * 3 + 2]);
      q.setFromUnitVectors(up, n);
      spin.setFromAxisAngle(up, hash01(c + 7) * Math.PI * 2);
      q.multiply(spin);
      this.quat.set([q.x, q.y, q.z, q.w], c * 4);
    }
    // edgeNbr[c*3+k] = cell across the edge (vert k -> vert k+1)
    this.edgeNbr = new Int32Array(N * 3).fill(-1);
    for (let c = 0; c < N; c++) {
      for (let k = 0; k < 3; k++) {
        const a = w.cellVerts[c * 3 + k], b = w.cellVerts[c * 3 + ((k + 1) % 3)];
        for (let j = 0; j < 3; j++) {
          const n2 = w.nbr[c * 3 + j];
          let hits = 0;
          for (let m = 0; m < 3; m++) { const x = w.cellVerts[n2 * 3 + m]; if (x === a || x === b) hits++; }
          if (hits === 2) { this.edgeNbr[c * 3 + k] = n2; break; }
        }
      }
    }
    this.buildInstances();
    this.rebuildShape();
    this.sync();
  }

  rebuildShape() {
    const w = this.state.world, p = this.posAttr.array;
    let o = 0;
    for (let c = 0; c < w.count; c++) {
      const r = topRadius(w.level[c]);
      const v = [0, 1, 2].map((k) => w.cellVerts[c * 3 + k]);
      const P = (vi, rad) => [w.vertPos[vi * 3] * rad, w.vertPos[vi * 3 + 1] * rad, w.vertPos[vi * 3 + 2] * rad];
      const tops = v.map((vi) => P(vi, r));
      const put = (a) => { p[o++] = a[0]; p[o++] = a[1]; p[o++] = a[2]; };
      put(tops[0]); put(tops[1]); put(tops[2]);
      for (let k = 0; k < 3; k++) {
        const k2 = (k + 1) % 3;
        // Wall only down to the lower neighbour on this edge (no hidden walls -> no z-fighting)
        const nb = this.edgeNbr[c * 3 + k];
        const nl = nb >= 0 ? w.level[nb] : 0;
        if (nl >= w.level[c]) {
          for (let i = 0; i < 6; i++) put(tops[k]); // degenerate
          continue;
        }
        const rb = nl === 0 ? BASE_R : topRadius(nl);
        const b0 = P(v[k], rb), b1 = P(v[k2], rb);
        put(tops[k]); put(b0); put(b1);
        put(tops[k]); put(b1); put(tops[k2]);
      }
    }
    this.posAttr.needsUpdate = true;
    this.globe.geometry.computeVertexNormals();
    this.globe.geometry.computeBoundingSphere();
    this.version = w.version;
  }

  cellColor(c, out) {
    const w = this.state.world, s = this.state;
    const b = w.biome[c];
    out.copy(BIOME_COL[b]);
    if (isWater(b)) {
      if (b !== B.ICE) out.multiplyScalar(0.85 + 0.3 * Math.min(1, Math.max(0, (w.raw[c] - w.sea + 0.25) * 2.5)));
      return out.multiplyScalar(this.jitter[c] * 0.5 + 0.5);
    }
    const bld = w.bld[c];
    if (bld === BLD.FARM) out.copy(((c * 7) % 3) ? FARM_A : FARM_B);
    else if (bld === BLD.MINE) out.copy(MINE_COL);
    else if (bld === BLD.RUIN) out.copy(RUIN_COL);
    else if (w.trees[c] > 0.05) out.lerp(TREE_DARK, Math.min(1, w.trees[c]) * 0.55);
    if (w.wet[c] < -0.2) out.lerp(DRY, -w.wet[c] * 0.5);
    else if (w.wet[c] > 0.2) out.multiplyScalar(1 - w.wet[c] * 0.18);
    out.multiplyScalar((0.9 + w.level[c] * 0.025) * this.jitter[c]);
    const own = w.owner[c];
    if (own >= 0) {
      const t = s.tribes[own];
      let border = false;
      for (let k = 0; k < 3; k++) if (w.owner[w.nbr[c * 3 + k]] !== own) border = true;
      this.tmpColor.setRGB(t.color[0], t.color[1], t.color[2]);
      // zoomed out = political map: stronger country colours
      const map = this.pixel === 3 ? 1 : this.pixel === 2 ? 0.5 : 0;
      out.lerp(this.tmpColor, border ? 0.45 + 0.4 * map : bld === BLD.FARM ? 0.15 + 0.2 * map : 0.36 + 0.2 * map);
    }
    const hot = this.hot?.get(c);
    if (hot !== undefined && !isWater(b)) {
      const k = Math.max(0, 1 - (this.time - hot) / 14);
      this.tmpColor.setHex(0xff3a00).lerp(FIRE_B, 0.3 * (0.5 + 0.5 * Math.sin(this.time * 6 + c)));
      out.lerp(this.tmpColor, 0.85 * k);
    }
    if (w.fire[c]) {
      const f = 0.5 + 0.5 * Math.sin(this.time * 18 + c);
      this.tmpColor.copy(FIRE_A).lerp(FIRE_B, f);
      out.lerp(this.tmpColor, 0.85);
    }
    return out;
  }

  writeCellColor(c, col) {
    const a = this.colAttr.array;
    let o = c * CELL_TRIS * 9;
    for (let i = 0; i < 3; i++) { a[o++] = col.r; a[o++] = col.g; a[o++] = col.b; }
    const sr = col.r * 0.62, sg = col.g * 0.58, sb = col.b * 0.55;
    for (let i = 0; i < 18; i++) { a[o++] = sr; a[o++] = sg; a[o++] = sb; }
  }

  // Called after sim ticks: colors, trees, buildings, flags.
  sync() {
    const w = this.state.world;
    if (w.version !== this.version) this.rebuildShape();
    const col = new THREE.Color();
    for (let c = 0; c < w.count; c++) this.writeCellColor(c, this.cellColor(c, col));
    this.colAttr.needsUpdate = true;
    this.syncInstances();
    this.buildBorders();
    const now = performance.now();
    if (!this.terrT || now - this.terrT > 700) { this.computeTerritories(); this.terrT = now; }
  }

  // ------------------------------------------------------------ instances
  buildInstances() {
    const lam = (opts) => new THREE.MeshLambertMaterial({ flatShading: true, ...opts });
    const basic = (opts) => new THREE.MeshBasicMaterial(opts);
    this.inst = [];
    const mk = (geo, mat, max) => {
      const m = new THREE.InstancedMesh(geo, mat, max);
      m.count = 0; m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(m); this.inst.push(m);
      return m;
    };
    const treeG = new THREE.ConeGeometry(0.0075, 0.022, 4); treeG.translate(0, 0.011, 0);
    this.trees = mk(treeG, lam({}), 14000);
    // Stone Age: hide tents
    const hutG = new THREE.ConeGeometry(0.0055, 0.0095, 6); hutG.translate(0, 0.00475, 0);
    this.huts = mk(hutG, lam({}), 12000);
    // Bronze / Iron Age: walls + roof + door
    const wallG = new THREE.BoxGeometry(0.0075, 0.0065, 0.0075); wallG.translate(0, 0.00325, 0);
    this.walls = mk(wallG, lam({}), 12000);
    const roofG = new THREE.ConeGeometry(0.0068, 0.0055, 4); roofG.rotateY(Math.PI / 4); roofG.translate(0, 0.0065 + 0.00275, 0);
    this.roofs = mk(roofG, lam({}), 12000);
    const doorG = new THREE.PlaneGeometry(0.0021, 0.0036); doorG.translate(0, 0.0018, 0.00377);
    this.doors = mk(doorG, basic({ color: 0x2a1a10 }), 12000);
    this.houseOffsets = [[-0.0062, -0.0042], [0.0062, -0.0032], [0.0004, 0.0068]].map(([x, z]) => new THREE.Matrix4().makeTranslation(x, 0, z));
    // Campfire: ring of stones + flame
    const pitG = new THREE.CylinderGeometry(0.003, 0.0033, 0.0012, 7); pitG.translate(0, 0.0006, 0);
    this.pits = mk(pitG, lam({ color: 0x55504b }), 4000);
    const flameG = new THREE.ConeGeometry(0.0019, 0.0058, 5); flameG.translate(0, 0.0012 + 0.0029, 0);
    this.flames = mk(flameG, basic({}), 4000);
    // Farms: crop rows
    const cropG = new THREE.BoxGeometry(0.0017, 0.0022, 0.0105); cropG.translate(0, 0.0011, 0);
    this.crops = mk(cropG, lam({}), 12000);
    this.cropOffsets = [-0.0045, 0, 0.0045].map((x) => new THREE.Matrix4().makeTranslation(x, 0, 0));
    // Mines: rock pile with a dark entrance
    const mineG = new THREE.DodecahedronGeometry(0.0062, 0); mineG.scale(1, 0.65, 1); mineG.translate(0, 0.0015, 0);
    this.mines = mk(mineG, lam({ color: 0x8a8580 }), 3000);
    const shaftG = new THREE.PlaneGeometry(0.0028, 0.0026); shaftG.translate(0, 0.0016, 0.0058);
    this.shafts = mk(shaftG, basic({ color: 0x141210 }), 3000);
    // People: body + head (+ spear for soldiers)
    const bodyG = new THREE.BoxGeometry(0.0021, 0.0034, 0.0015); bodyG.translate(0, 0.0017, 0);
    this.bodies = mk(bodyG, lam({}), 5000);
    const headG = new THREE.BoxGeometry(0.0017, 0.0017, 0.0017); headG.translate(0, 0.0034 + 0.00095, 0);
    this.heads = mk(headG, lam({}), 5000);
    const spearG = new THREE.BoxGeometry(0.00045, 0.0078, 0.00045); spearG.translate(0.0016, 0.0036, 0);
    this.spears = mk(spearG, lam({ color: 0xd8d8d8 }), 1200);
    // Boats: hull + sail
    const hullG = new THREE.BoxGeometry(0.0095, 0.0025, 0.0042); hullG.translate(0, 0.00125, 0);
    this.hulls = mk(hullG, lam({ color: 0x7a4a24 }), 300);
    const sailG = new THREE.PlaneGeometry(0.0048, 0.0062); sailG.rotateY(Math.PI / 2); sailG.translate(0, 0.0058, 0);
    this.sails = mk(sailG, basic({ side: THREE.DoubleSide }), 300);
    // Capital flags
    const poleG = new THREE.CylinderGeometry(0.0006, 0.0006, 0.03, 4); poleG.translate(0, 0.015, 0);
    this.poles = mk(poleG, basic({ color: 0x3a2a1a }), 64);
    const flagG = new THREE.PlaneGeometry(0.011, 0.007); flagG.translate(0.0055, 0.026, 0);
    this.flags = mk(flagG, basic({ side: THREE.DoubleSide }), 64);
    this.m4 = new THREE.Matrix4(); this.q4 = new THREE.Quaternion(); this.v3 = new THREE.Vector3(); this.s3 = new THREE.Vector3();
    this.villages = []; this.people = [];
    this.buildEffects();
  }

  placeMatrix(c, scale, rOffset = 0) {
    const w = this.state.world;
    const r = topRadius(w.level[c]) + rOffset;
    this.v3.set(w.center[c * 3] * r, w.center[c * 3 + 1] * r, w.center[c * 3 + 2] * r);
    this.q4.fromArray(this.quat, c * 4);
    this.s3.set(scale, scale, scale);
    return this.m4.compose(this.v3, this.q4, this.s3);
  }

  syncInstances() {
    const s = this.state, w = s.world, col = this.tmpColor;
    let nt = 0, nh = 0, nw = 0, nm = 0, nc = 0, nf = 0;
    const treeA = C(0x2f6b2a), treeB = C(0x1f4f22), treeJ = C(0x1d7a35), treeT = C(0x35553a);
    const HIDE = C(0x9a7650), CREAM = C(0xe8dcc0), STONE = C(0xaaa69d), RUINC = C(0x77706a);
    const CROP_A = C(0xe2c04a), CROP_B = C(0x9cba3c);
    const tmp = new THREE.Matrix4(), scaleM = new THREE.Matrix4();
    const villages = [];
    const perTribe = new Map();
    for (let c = 0; c < w.count; c++) {
      const b = w.bld[c];
      if ((b === BLD.HOUSE || b === BLD.RUIN) && nh < 11990 && nw < 11990) {
        const base = this.placeMatrix(c, 1).clone();
        const o = b === BLD.HOUSE ? w.owner[c] : -1;
        const t = o >= 0 ? s.tribes[o] : null;
        const tech = t ? t.tech : 1;
        const cap = t && t.capital === c;
        const k = b === BLD.RUIN ? 2 : 2 + (c % 2);
        for (let i = 0; i < k; i++) {
          tmp.multiplyMatrices(base, this.houseOffsets[i]);
          if (cap && i === 0) tmp.multiply(scaleM.makeScale(1.55, 1.55, 1.55));
          if (b === BLD.RUIN) {
            tmp.multiply(scaleM.makeScale(1, 0.35, 1));
            this.walls.setMatrixAt(nw, tmp); this.walls.setColorAt(nw, RUINC);
            this.roofs.setMatrixAt(nw, scaleM.makeScale(0, 0, 0)); this.doors.setMatrixAt(nw, scaleM);
            this.roofs.setColorAt(nw, RUINC);
            nw++;
          } else if (tech === 0) {
            this.huts.setMatrixAt(nh, tmp);
            col.copy(HIDE).lerp(this.tmpColor2.setRGB(t.color[0], t.color[1], t.color[2]), 0.35);
            this.huts.setColorAt(nh, col);
            nh++;
          } else {
            if (tech === 2) tmp.multiply(scaleM.makeScale(1, 1.25, 1));
            this.walls.setMatrixAt(nw, tmp); this.roofs.setMatrixAt(nw, tmp); this.doors.setMatrixAt(nw, tmp);
            this.walls.setColorAt(nw, tech === 2 ? STONE : CREAM);
            this.roofs.setColorAt(nw, col.setRGB(t.color[0] * 0.85, t.color[1] * 0.85, t.color[2] * 0.85));
            nw++;
          }
        }
        if (t) {
          villages.push({ c, t, base });
          perTribe.set(t.id, (perTribe.get(t.id) || 0) + 1);
        }
      } else if (b === BLD.MINE && nm < 3000) {
        const m = this.placeMatrix(c, 1);
        this.mines.setMatrixAt(nm, m); this.shafts.setMatrixAt(nm, m);
        nm++;
      } else if (b === BLD.FARM && nc < 11990) {
        const base = this.placeMatrix(c, 1).clone();
        const ripe = w.wet[c] < -0.3 ? 0.2 : 0.5 + 0.5 * hash01(c * 3 + 1);
        col.copy(CROP_B).lerp(CROP_A, ripe);
        for (const off of this.cropOffsets) {
          this.crops.setMatrixAt(nc, tmp.multiplyMatrices(base, off));
          this.crops.setColorAt(nc, col);
          nc++;
        }
      }
      if (w.trees[c] > 0.3 && b === BLD.NONE && nt < 14000 && !isWater(w.biome[c])) {
        const sc = 0.55 + w.trees[c] * 0.6;
        this.trees.setMatrixAt(nt, this.placeMatrix(c, sc * (0.85 + 0.3 * this.jitter[c] - 0.3)));
        const bi = w.biome[c];
        col.copy(bi === B.JUNGLE ? treeJ : bi === B.TUNDRA || bi === B.SNOW ? treeT : (hash01(c) < 0.5 ? treeA : treeB));
        if (w.fire[c]) col.set(0x331a10);
        this.trees.setColorAt(nt, col);
        nt++;
      }
    }
    this.trees.count = nt; this.huts.count = nh; this.mines.count = nm; this.shafts.count = nm; this.crops.count = nc;
    this.walls.count = nw; this.roofs.count = nw; this.doors.count = nw;

    // Campfires (flames flicker every frame) and the people of each village
    this.villages = villages.slice(0, 4000);
    this.pits.count = this.villages.length;
    const FLAME_A = C(0xff8a1a), FLAME_B = C(0xffd23a);
    const people = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < this.villages.length; i++) {
      const vil = this.villages[i];
      this.pits.setMatrixAt(i, vil.base);
      this.flames.setColorAt(i, i % 2 ? FLAME_A : FLAME_B);
      const t = vil.t;
      const n = Math.max(1, Math.min(4, Math.round(t.pop / ((perTribe.get(t.id) || 1) * 9))));
      // Work places within 2 steps: farms, mines, forest
      const work = [];
      for (let k = 0; k < 3; k++) {
        const a = w.nbr[vil.c * 3 + k];
        for (const x of [a, w.nbr[a * 3], w.nbr[a * 3 + 1], w.nbr[a * 3 + 2]]) {
          if (x === vil.c || w.owner[x] !== t.id || isWater(w.biome[x])) continue;
          if (w.bld[x] === BLD.FARM || w.bld[x] === BLD.MINE || w.trees[x] > 0.3) work.push(x);
        }
      }
      for (let p = 0; p < n && people.length < 4500; p++) {
        const h = hash01(vil.c * 31 + p * 7);
        tmp.multiplyMatrices(vil.base, this.houseOffsets[p % 3]);
        v.setFromMatrixPosition(tmp);
        const home = v.clone().normalize(), rh = topRadius(w.level[vil.c]);
        const dst = work.length ? work[Math.floor(h * work.length)] : vil.c;
        const jx = (hash01(vil.c + p * 13) - 0.5) * 0.008, jz = (hash01(vil.c + p * 17) - 0.5) * 0.008;
        tmp.copy(this.placeMatrix(dst, 1)).multiply(scaleM.makeTranslation(jx, 0, jz));
        v.setFromMatrixPosition(tmp);
        people.push({
          home, rh, dst: v.clone().normalize(), rd: topRadius(w.level[dst]),
          phase: h, speed: 1 / (9 + 8 * hash01(vil.c * 5 + p)),
          body: new THREE.Color(t.color[0], t.color[1], t.color[2]),
          skin: SKIN[Math.floor(hash01(vil.c * 11 + p) * SKIN.length)],
        });
      }
    }
    this.people = people;
    for (const m of this.inst) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    for (const t of s.tribes) {
      if (!t.alive || nf >= 64) continue;
      const m = this.placeMatrix(t.capital, 1);
      this.poles.setMatrixAt(nf, m); this.flags.setMatrixAt(nf, m);
      col.setRGB(t.color[0], t.color[1], t.color[2]);
      this.flags.setColorAt(nf, col);
      nf++;
    }
    this.poles.count = nf; this.flags.count = nf;
    this.poles.instanceMatrix.needsUpdate = true; this.flags.instanceMatrix.needsUpdate = true;
    if (this.flags.instanceColor) this.flags.instanceColor.needsUpdate = true;
  }

  // Orientation matrix standing on the globe at unit dir `up`, facing `fwd` (any vector).
  standMatrix(up, r, fwd, scale, out) {
    const f = this._f || (this._f = new THREE.Vector3());
    const x = this._x || (this._x = new THREE.Vector3());
    f.copy(fwd).addScaledVector(up, -fwd.dot(up));
    if (f.lengthSq() < 1e-12) f.set(up.y, -up.x, 0).addScaledVector(up, 0);
    f.normalize();
    x.crossVectors(up, f); // right
    out.makeBasis(f, up, x.negate());
    out.scale(this.s3.set(scale, scale, scale));
    return out.setPosition(up.x * r, up.y * r, up.z * r);
  }

  // Every frame: flicker campfires, walk villagers, move armies and boats.
  updateLife(dt) {
    const near = this.camera.position.length() < 2.4;
    const T = this.time;
    // flames
    const sc = new THREE.Matrix4();
    for (let i = 0; i < this.villages.length; i++) {
      const f = 0.75 + 0.35 * Math.abs(Math.sin(T * 11 + i * 1.7)) + 0.15 * Math.sin(T * 23 + i);
      this.m4.multiplyMatrices(this.villages[i].base, sc.makeScale(0.9 + 0.2 * Math.sin(T * 17 + i), f, 0.9 + 0.2 * Math.cos(T * 13 + i)));
      this.flames.setMatrixAt(i, this.m4);
    }
    this.flames.count = this.villages.length;
    this.flames.instanceMatrix.needsUpdate = true;

    let nb = 0, ns = 0, nboat = 0;
    const up = new THREE.Vector3(), fwd = new THREE.Vector3();
    const putPerson = (dir, r, face, body, skin, scale, spear) => {
      this.standMatrix(dir, r, face, scale, this.m4);
      this.bodies.setMatrixAt(nb, this.m4); this.bodies.setColorAt(nb, body);
      this.heads.setMatrixAt(nb, this.m4); this.heads.setColorAt(nb, skin);
      nb++;
      if (spear && ns < 1200) this.spears.setMatrixAt(ns++, this.m4);
    };
    if (near) {
      for (const p of this.people) {
        if (nb >= 4900) break;
        const ph = (T * p.speed + p.phase) % 1;
        let s, out = true;
        if (ph < 0.4) s = ph / 0.4;
        else if (ph < 0.6) s = 1;
        else if (ph < 0.95) { s = 1 - (ph - 0.6) / 0.35; out = false; }
        else s = 0;
        s = s * s * (3 - 2 * s);
        up.copy(p.home).lerp(p.dst, s).normalize();
        const walking = s > 0 && s < 1;
        const r = (s < 0.5 ? p.rh : p.rd) + (walking ? Math.abs(Math.sin(T * 14 + p.phase * 40)) * 0.0005 : 0);
        fwd.copy(out ? p.dst : p.home).sub(up);
        if (!walking) fwd.set(Math.sin(T * 0.7 + p.phase * 9), Math.cos(T * 0.5 + p.phase * 7), Math.sin(p.phase * 50));
        putPerson(up, r, fwd, p.body, p.skin, 1, false);
      }
    }
    // armies + boats
    for (const u of this.units) {
      u.t += dt;
      const k = Math.min(1, u.t / u.dur);
      up.copy(u.a).lerp(u.b, k).normalize();
      fwd.copy(u.b).sub(u.a);
      if (u.kind === 'boat') {
        if (nboat >= 300) continue;
        const r = Math.max(1.0005, u.ra + (u.rb - u.ra) * k);
        this.standMatrix(up, r + Math.sin(T * 3 + u.a.x * 9) * 0.0004, fwd, 1.6, this.m4);
        this.hulls.setMatrixAt(nboat, this.m4); this.sails.setMatrixAt(nboat, this.m4);
        this.sails.setColorAt(nboat, u.color);
        nboat++;
      } else if (nb < 4990) {
        const r = u.ra + (u.rb - u.ra) * k + Math.abs(Math.sin(u.t * 14)) * 0.0006;
        putPerson(up, r, fwd, u.color, SKIN[1], 1.25, u.kind === 'army');
      }
    }
    this.units = this.units.filter((u) => u.t < u.dur);
    this.bodies.count = nb; this.heads.count = nb; this.spears.count = ns;
    this.hulls.count = nboat; this.sails.count = nboat;
    for (const m of [this.bodies, this.heads, this.spears, this.hulls, this.sails]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------ particles + fire
  buildEffects() {
    const fireG = new THREE.ConeGeometry(0.0036, 0.011, 5); fireG.translate(0, 0.0055, 0);
    this.fireMesh = new THREE.InstancedMesh(fireG, new THREE.MeshBasicMaterial({}), 3600);
    const partG = new THREE.BoxGeometry(1, 1, 1);
    this.partMesh = new THREE.InstancedMesh(partG, new THREE.MeshBasicMaterial({}), 5000);
    for (const m of [this.fireMesh, this.partMesh]) {
      m.count = 0; m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(m); this.inst.push(m);
    }
    this.parts = [];
    this.hot = new Map(); // crater cell -> time it was hit
    this.fireOffsets = [[0, 0], [-0.0045, 0.003], [0.004, -0.0035]];
  }

  // pos: world position; vel: world velocity; grow: size multiplier over life; grav: pull to center
  emit(pos, vel, life, size, color, grow = 1, grav = 0) {
    if (this.parts.length >= 5000) return;
    this.parts.push({ p: pos.clone(), v: vel.clone(), age: 0, life, size, grow, grav, color: color.isColor ? color : new THREE.Color(color) });
  }

  // Random unit vector near `up` (for upward bursts)
  jitterUp(up, spread, out = new THREE.Vector3()) {
    return out.randomDirection().multiplyScalar(spread).add(up).normalize();
  }

  burst(cell, r, n, colors, speed, size, life, grav) {
    const w = this.state.world;
    const up = this.cellPos(cell).normalize();
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const p = this.cellPos(cell).add(v.randomDirection().multiplyScalar(Math.sin(r) * Math.random()));
      p.setLength(this.cellPos(cell).length() + 0.004); // start on the surface
      const dir = this.jitterUp(up, 1.1);
      this.emit(p, dir.multiplyScalar(speed * (0.4 + Math.random())), life * (0.6 + 0.8 * Math.random()), size * (0.6 + 0.8 * Math.random()),
        colors[Math.floor(Math.random() * colors.length)], 1, grav);
    }
  }

  updateEffects(dt) {
    const s = this.state, w = s.world, T = this.time;
    const v = new THREE.Vector3(), up = new THREE.Vector3(), tmp = new THREE.Matrix4(), sc = new THREE.Matrix4();
    // Flames on burning tiles + smoke and sparks rising from them
    let nf = 0, i = 0;
    for (const c of s.burning) {
      if (nf >= 3590) break;
      const base = this.placeMatrix(c, 1).clone();
      const big = 0.7 + 0.6 * Math.min(1, w.trees[c] + 0.3);
      for (let k = 0; k < 3; k++) {
        const o = this.fireOffsets[k];
        const f = big * (0.7 + 0.45 * Math.abs(Math.sin(T * 9 + c * 0.37 + k * 2.1)));
        tmp.multiplyMatrices(base, sc.makeTranslation(o[0], 0, o[1])).multiply(sc.makeScale(f * 0.9, f * (1 + 0.3 * Math.sin(T * 15 + c + k)), f * 0.9));
        this.fireMesh.setMatrixAt(nf, tmp);
        this.fireMesh.setColorAt(nf, this.tmpColor.setHex((c + k) % 3 === 0 ? 0xffd23a : (c + k) % 3 === 1 ? 0xff7a1a : 0xff4a10));
        nf++;
      }
      if (i++ < 400) {
        up.copy(this.cellPos(c)).normalize();
        if (Math.random() < dt * 1.1) this.emit(this.cellPos(c, 0.008), this.jitterUp(up, 0.25, v).multiplyScalar(0.035), 2.8, 0.006, SMOKE[Math.floor(Math.random() * 3)], 2.6);
        if (Math.random() < dt * 4) this.emit(this.cellPos(c, 0.004), this.jitterUp(up, 0.6, v).multiplyScalar(0.05), 0.9, 0.0028, Math.random() < 0.5 ? 0xffb030 : 0xff5a10, 0.3);
      }
    }
    this.fireMesh.count = nf;
    this.fireMesh.instanceMatrix.needsUpdate = true;
    if (this.fireMesh.instanceColor) this.fireMesh.instanceColor.needsUpdate = true;

    // Hot craters: glowing, smoking
    for (const [c, t0] of this.hot) {
      const age = T - t0;
      if (age > 14) {
        this.hot.delete(c);
        this.writeCellColor(c, this.cellColor(c, new THREE.Color()));
        this.colAttr.needsUpdate = true;
        continue;
      }
      if (Math.random() < dt * 0.35 * (1 - age / 14)) {
        up.copy(this.cellPos(c)).normalize();
        const wet = isWater(this.state.world.biome[c]);
        this.emit(this.cellPos(c, 0.004), this.jitterUp(up, 0.2, v).multiplyScalar(0.03), 3, 0.008, wet ? STEAM : SMOKE[Math.floor(Math.random() * 3)], 2.6);
      }
    }
    // Sick and blessed tribes
    for (const vil of this.villages) {
      const t = vil.t;
      if (t.plague > 0 && Math.random() < dt * 0.9) {
        up.copy(this.cellPos(vil.c)).normalize();
        this.emit(this.cellPos(vil.c, 0.006).add(v.randomDirection().multiplyScalar(0.008)), this.jitterUp(up, 0.5, v).multiplyScalar(0.012), 3, 0.008, Math.random() < 0.5 ? 0x7dff4a : 0x3fae2a, 2.2);
      }
      if (t.blessed > 0 && Math.random() < dt * 1.2) {
        up.copy(this.cellPos(vil.c)).normalize();
        this.emit(this.cellPos(vil.c, 0.004).add(v.randomDirection().multiplyScalar(0.01)), this.jitterUp(up, 0.15, v).multiplyScalar(0.03), 1.6, 0.0035, Math.random() < 0.5 ? 0xffe27a : 0xffffff, 0.2);
      }
    }
    // Lightning in rain clouds
    for (const [wx, obj] of this.weatherObjs) {
      if (wx.type === 'rain' && Math.random() < dt * 0.8) this.lightning(wx);
    }

    // Move particles
    let n = 0;
    const q = new THREE.Quaternion(), s3 = new THREE.Vector3(), cen = new THREE.Vector3();
    for (const p of this.parts) {
      p.age += dt;
      if (p.age >= p.life) continue;
      if (p.grav) p.v.addScaledVector(cen.copy(p.p).normalize(), -p.grav * dt);
      p.p.addScaledVector(p.v, dt);
      p.v.multiplyScalar(1 - 0.6 * dt);
      const k = p.age / p.life;
      const size = p.size * (1 + (p.grow - 1) * k) * (k > 0.7 ? (1 - k) / 0.3 : 1);
      if (p.p.length() < 0.995) { p.age = p.life; continue; } // hit the ground
      s3.setScalar(Math.max(0.0001, size));
      tmp.compose(p.p, q, s3);
      this.partMesh.setMatrixAt(n, tmp);
      this.partMesh.setColorAt(n, p.color);
      n++;
    }
    this.parts = this.parts.filter((p) => p.age < p.life);
    this.partMesh.count = n;
    this.partMesh.instanceMatrix.needsUpdate = true;
    if (this.partMesh.instanceColor) this.partMesh.instanceColor.needsUpdate = true;
  }

  lightning(wx) {
    const w = this.state.world;
    const c = wx.cells[Math.floor(Math.random() * wx.cells.length)];
    const ground = this.cellPos(c);
    const top = ground.clone().normalize().multiplyScalar(1.17);
    const pts = [top];
    for (let i = 1; i < 6; i++) {
      const p = top.clone().lerp(ground, i / 6).add(new THREE.Vector3().randomDirection().multiplyScalar(0.008));
      pts.push(p);
    }
    pts.push(ground);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xf4f0ff, transparent: true }));
    this.scene.add(line);
    this.flash(ground, 0.025, 0xc8d8ff, 0.25);
    this.anims.push({ t: 0, dur: 0.25, step: (k) => { line.material.opacity = 1 - k; }, done: () => this.scene.remove(line) });
  }

  // ------------------------------------------------------------ borders + territory shapes
  // A dark line on every land edge where the owner changes, with a band of the tribe's colour inside it.
  buildBorders() {
    const s = this.state, w = s.world;
    if (!this.borderMesh) {
      this.borderMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }));
      this.borderMesh.frustumCulled = false;
      this.scene.add(this.borderMesh);
    }
    const band = this.pixel === 3 ? 0.8 : this.pixel === 2 ? 0.5 : 0.3; // wider when far away
    const line = band * 0.28;
    const pos = [], col = [];
    const V = (vi, r) => [w.vertPos[vi * 3] * r, w.vertPos[vi * 3 + 1] * r, w.vertPos[vi * 3 + 2] * r];
    const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    const quad = (a, b, c, d, rgb) => {
      pos.push(...a, ...b, ...c, ...a, ...c, ...d);
      for (let i = 0; i < 6; i++) col.push(rgb[0], rgb[1], rgb[2]);
    };
    for (let c = 0; c < w.count; c++) {
      const o = w.owner[c];
      if (o < 0) continue;
      let any = false;
      for (let k = 0; k < 3; k++) {
        const n = this.edgeNbr[c * 3 + k];
        if (n >= 0 && w.owner[n] !== o && !isWater(w.biome[n])) { any = true; break; }
      }
      if (!any) continue;
      const t = s.tribes[o];
      const bright = [Math.min(1, t.color[0] * 1.15 + 0.08), Math.min(1, t.color[1] * 1.15 + 0.08), Math.min(1, t.color[2] * 1.15 + 0.08)];
      const dark = [t.color[0] * 0.18, t.color[1] * 0.18, t.color[2] * 0.18];
      const r = topRadius(w.level[c]) + 0.0012;
      const vs = [0, 1, 2].map((k) => V(w.cellVerts[c * 3 + k], r));
      const C = [(vs[0][0] + vs[1][0] + vs[2][0]) / 3, (vs[0][1] + vs[1][1] + vs[2][1]) / 3, (vs[0][2] + vs[1][2] + vs[2][2]) / 3];
      for (let k = 0; k < 3; k++) {
        const n = this.edgeNbr[c * 3 + k];
        if (n < 0 || w.owner[n] === o || isWater(w.biome[n])) continue;
        const a = vs[k], b = vs[(k + 1) % 3];
        const a1 = lerp(a, C, line), b1 = lerp(b, C, line), a2 = lerp(a, C, band), b2 = lerp(b, C, band);
        quad(a, b, b1, a1, dark);
        quad(a1, b1, b2, a2, bright);
      }
    }
    const g = this.borderMesh.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeBoundingSphere();
    this.borderPixel = this.pixel;
  }

  // For each tribe: its biggest connected piece of land, the centre, and the long axis.
  // Used to write the tribe's name across its land like a world map.
  computeTerritories() {
    const s = this.state, w = s.world;
    const seen = new Uint8Array(w.count);
    const out = new Map();
    for (const t of s.tribes) {
      if (!t.alive || t.cells.size < 12) continue;
      let best = null;
      for (const start of t.cells) {
        if (seen[start]) continue;
        const comp = [start];
        seen[start] = 1;
        for (let i = 0; i < comp.length; i++) {
          const c = comp[i];
          for (let k = 0; k < 3; k++) {
            const n = w.nbr[c * 3 + k];
            if (!seen[n] && w.owner[n] === t.id) { seen[n] = 1; comp.push(n); }
          }
        }
        if (!best || comp.length > best.length) best = comp;
      }
      if (!best || best.length < 12) continue;
      const u = new THREE.Vector3();
      for (const c of best) u.x += w.center[c * 3], u.y += w.center[c * 3 + 1], u.z += w.center[c * 3 + 2];
      u.normalize();
      const e1 = new THREE.Vector3(0, 1, 0).cross(u);
      if (e1.lengthSq() < 1e-6) e1.set(1, 0, 0).cross(u);
      e1.normalize();
      const e2 = new THREE.Vector3().crossVectors(u, e1);
      let sxx = 0, syy = 0, sxy = 0;
      const xs = [], ys = [];
      for (const c of best) {
        const x = w.center[c * 3] * e1.x + w.center[c * 3 + 1] * e1.y + w.center[c * 3 + 2] * e1.z;
        const y = w.center[c * 3] * e2.x + w.center[c * 3 + 1] * e2.y + w.center[c * 3 + 2] * e2.z;
        xs.push(x); ys.push(y); sxx += x * x; syy += y * y; sxy += x * y;
      }
      const phi = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      const axis = e1.clone().multiplyScalar(Math.cos(phi)).addScaledVector(e2, Math.sin(phi));
      const minor = e1.clone().multiplyScalar(-Math.sin(phi)).addScaledVector(e2, Math.cos(phi));
      const pa = xs.map((x, i) => x * Math.cos(phi) + ys[i] * Math.sin(phi)).sort((a, b) => a - b);
      const pb = xs.map((x, i) => -x * Math.sin(phi) + ys[i] * Math.cos(phi)).sort((a, b) => a - b);
      const q = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))];
      const lo = q(pa, 0.06), hi = q(pa, 0.94), mlo = q(pb, 0.1), mhi = q(pb, 0.9);
      const R = 1.035;
      const at = (a, b) => u.clone().addScaledVector(axis, a).addScaledVector(minor, b).normalize().multiplyScalar(R);
      const mid = (lo + hi) / 2, mm = (mlo + mhi) / 2;
      out.set(t.id, { center: at(mid, mm), A: at(lo, mm), B: at(hi, mm), M1: at(mid, mlo), M2: at(mid, mhi), size: best.length });
    }
    this.territories = out;
  }

  // Screen position (CSS px) of a world point, or null if behind the globe.
  projectPoint(v) {
    const toCam = this.view.position.clone().sub(v);
    if (toCam.dot(v) < 0) return null;
    const p = v.clone().project(this.view);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + (p.x + 1) / 2 * rect.width, y: rect.top + (1 - p.y) / 2 * rect.height };
  }

  // ------------------------------------------------------------ helpers
  cellPos(c, extra = 0, out = new THREE.Vector3()) {
    const w = this.state.world;
    const r = topRadius(w.level[c]) + extra;
    return out.set(w.center[c * 3] * r, w.center[c * 3 + 1] * r, w.center[c * 3 + 2] * r);
  }

  pick(clientX, clientY) {
    if (!this.globe) return -1;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.view);
    const hit = this.raycaster.intersectObject(this.globe, false)[0];
    return hit ? Math.floor(hit.faceIndex / CELL_TRIS) : -1;
  }

  // Screen position (CSS px) of a cell, or null if on the far side.
  project(c) {
    const p = this.cellPos(c);
    const toCam = this.view.position.clone().sub(p);
    if (toCam.dot(p) < 0) return null;
    p.project(this.view);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + (p.x + 1) / 2 * rect.width, y: rect.top + (1 - p.y) / 2 * rect.height };
  }

  makeCursor() {
    const g = new THREE.RingGeometry(0.92, 1, 40);
    this.cursor = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false }));
    this.cursor.renderOrder = 10;
    this.cursor.visible = false;
    this.scene.add(this.cursor);
  }

  setCursor(cell, angRadius, color = 0xffffff) {
    if (cell < 0 || !this.state) { this.cursor.visible = false; return; }
    const p = this.cellPos(cell, 0.004);
    this.cursor.position.copy(p);
    this.cursor.lookAt(p.clone().multiplyScalar(2));
    const s = Math.sin(Math.max(angRadius, 0.02)) * p.length();
    this.cursor.scale.set(s, s, s);
    this.cursor.material.color.set(color);
    this.cursor.visible = true;
  }

  flyTo(cell, toDist) {
    const dist = toDist ?? Math.min(this.camera.position.length(), 2.4);
    const target = this.cellPos(cell).normalize().multiplyScalar(dist);
    const start = this.camera.position.clone();
    this.anims.push({
      t: 0, dur: 1.1,
      step: (k) => {
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        const v = start.clone().normalize().lerp(target.clone().normalize(), e).normalize();
        this.camera.position.copy(v.multiplyScalar(start.length() + (dist - start.length()) * e));
      },
    });
  }

  // ------------------------------------------------------------ effects
  playMeteor(cell, onImpact) {
    const target = this.cellPos(cell);
    // Come in from the top corner of the current view, so the player sees the fall.
    const camRight = new THREE.Vector3().setFromMatrixColumn(this.view.matrixWorld, 0);
    const camUp = new THREE.Vector3().setFromMatrixColumn(this.view.matrixWorld, 1);
    const dist = this.view.position.distanceTo(target);
    const start = target.clone()
      .add(camRight.multiplyScalar((Math.random() < 0.5 ? -0.32 : 0.32) * dist))
      .add(camUp.multiplyScalar(0.26 * dist))
      .add(target.clone().normalize().multiplyScalar(0.25 * dist));
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05, 0), new THREE.MeshBasicMaterial({ color: 0xffd060 }));
    const glow = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 0), new THREE.MeshBasicMaterial({ color: 0xff4400, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
    rock.add(glow);
    this.scene.add(rock);
    const trail = [];
    this.anims.push({
      t: 0, dur: 1.3,
      step: (k) => {
        const e = Math.pow(k, 1.6);
        rock.position.lerpVectors(start, target, e);
        rock.rotation.x += 0.3; rock.rotation.y += 0.2;
        if (trail.length < 60) {
          const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(0.03 + Math.random() * 0.035, 0), new THREE.MeshBasicMaterial({ color: Math.random() < 0.7 ? 0xff7a1a : 0xffd27a, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
          puff.position.copy(rock.position);
          this.scene.add(puff); trail.push(puff);
        }
        for (const p of trail) { p.material.opacity *= 0.93; p.scale.multiplyScalar(1.02); }
      },
      done: () => {
        this.scene.remove(rock);
        for (const p of trail) this.fade(p, 0.6);
        this.flash(target, 0.32, 0xfff1b0, 0.7);
        this.flash(target, 0.2, 0xff5a1a, 1.1);
        this.shake = 0.5;
        onImpact?.();
      },
    });
  }

  flash(pos, size, color, dur) {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.position.copy(pos);
    m.scale.setScalar(0.01);
    this.scene.add(m);
    this.anims.push({
      t: 0, dur,
      step: (k) => { m.scale.setScalar(0.01 + size * Math.sqrt(k)); m.material.opacity = 0.9 * (1 - k); },
      done: () => this.scene.remove(m),
    });
  }

  fade(obj, dur) {
    const o0 = obj.material.opacity;
    this.anims.push({ t: 0, dur, step: (k) => { obj.material.opacity = o0 * (1 - k); }, done: () => this.scene.remove(obj) });
  }

  beam(cell, color, dur = 1.6) {
    const p = this.cellPos(cell);
    const g = new THREE.CylinderGeometry(0.012, 0.02, 0.5, 6); g.translate(0, 0.25, 0);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthWrite: false }));
    m.position.copy(p);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p.clone().normalize());
    this.scene.add(m);
    this.anims.push({ t: 0, dur, step: (k) => { m.material.opacity = 0.7 * (1 - k); m.scale.set(1 + k, 1, 1 + k); }, done: () => this.scene.remove(m) });
  }

  addUnit(fromCell, toCell, color, dur, kind = 'walk') {
    if (this.units.length >= 600) return;
    const a = this.cellPos(fromCell).normalize(), b = this.cellPos(toCell).normalize();
    const w = this.state.world;
    const ra = topRadius(w.level[fromCell]), rb = topRadius(w.level[toCell]);
    this.units.push({ a, b, ra, rb, t: 0, dur, color: new THREE.Color(color[0], color[1], color[2]), kind });
  }

  handleFx(fx) {
    const col = fx.color;
    switch (fx.type) {
      case 'battle':
        if (this.units.length < 500) this.addUnit(fx.from, fx.cell, col, 0.9, 'army');
        if (Math.random() < 0.35) this.flash(this.cellPos(fx.cell, 0.01), 0.02, fx.won ? 0xff3030 : 0xffffff, 0.35);
        break;
      case 'boat': this.addUnit(fx.from, fx.to, col, 3.5, 'boat'); break;
      case 'spawn': this.beam(fx.cell, new THREE.Color(col[0], col[1], col[2])); break;
      case 'quake':
        this.shake = 0.8;
        this.burst(fx.cell, fx.r, 220, [0x8a6a48, 0x6b5238, 0xa88a68, 0x5a4a3a], 0.05, 0.01, 2.6, 0.02);
        break;
      case 'impact': {
        const w = this.state.world;
        for (const c of cellsWithin(w, fx.cell, fx.r)) this.hot.set(c, this.time);
        this.burst(fx.cell, fx.r * 0.5, 260, [0x5a4030, 0x3a2a20, 0xff7a1a, 0xffc040, 0x777070], 0.22, 0.006, 2.2, 0.35);
        this.burst(fx.cell, fx.r * 0.4, 60, [0x3a3633, 0x55504c], 0.04, 0.02, 4, 0);
        break;
      }
      case 'grow':
        this.burst(fx.cell, fx.r, 120, [0x7dff6a, 0x3fbf3a, 0xc8ff9a], 0.03, 0.004, 1.8, 0);
        break;
      case 'plague': this.burst(fx.cell, 0.04, 80, [0x7dff4a, 0x3fae2a], 0.02, 0.009, 2.5, 0); break;
      case 'bless': this.beam(fx.cell, 0xffe27a, 2.2); this.burst(fx.cell, 0.04, 90, [0xffe27a, 0xffffff], 0.05, 0.004, 1.6, 0); break;
    }
  }

  syncWeather() {
    const s = this.state;
    const live = new Set(s.weather);
    for (const [wx, obj] of this.weatherObjs) if (!live.has(wx)) { this.scene.remove(obj.group); this.weatherObjs.delete(wx); }
    for (const wx of s.weather) if (!this.weatherObjs.has(wx)) this.weatherObjs.set(wx, this.makeWeather(wx));
  }

  makeWeather(wx) {
    const group = new THREE.Group();
    const center = this.cellPos(wx.cell).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), center);
    const rain = wx.type === 'rain';
    const chord = Math.sin(wx.r);
    if (rain) {
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x9aa0b8, flatShading: true, transparent: true, opacity: 0.78, depthWrite: false });
      for (let i = 0; i < 22; i++) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
        const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * chord * 0.9;
        box.position.set(Math.cos(a) * d, 1.17 + Math.random() * 0.02, Math.sin(a) * d);
        box.scale.set(0.025 + Math.random() * 0.04, 0.014 + Math.random() * 0.01, 0.025 + Math.random() * 0.04);
        group.add(box);
      }
    } else {
      const ring = new THREE.Mesh(new THREE.CircleGeometry(chord * 1.02, 40), new THREE.MeshBasicMaterial({ color: 0xffa830, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 1.1;
      group.add(ring);
    }
    const n = rain ? 500 : 90;
    const pos = new Float32Array(n * 3), seeds = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * chord * 0.9;
      seeds[i * 3] = Math.cos(a) * d; seeds[i * 3 + 1] = Math.random(); seeds[i * 3 + 2] = Math.sin(a) * d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: rain ? 0xa8d8ff : 0xffc060, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.9 }));
    pts.frustumCulled = false;
    group.add(pts);
    group.quaternion.copy(q);
    this.scene.add(group);
    return { group, pts, seeds, n, rain };
  }

  // ------------------------------------------------------------ frame
  frame(dt) {
    this.time += dt;
    this.controls.rotateSpeed = 0.35 * Math.max(0.15, this.camera.position.length() - 1);
    // OrbitControls owns the 'base' camera; we restore it before each update.
    this.controls.update();
    this.camera.updateMatrixWorld();
    this.view.position.copy(this.camera.position);
    this.view.quaternion.copy(this.camera.quaternion);
    // Close to the ground: swing the camera back and look at the same spot from the side.
    const dist = this.camera.position.length();
    const tilt = Math.min(1, Math.max(0, (1.85 - dist) / (1.85 - 1.16)));
    if (tilt > 0) {
      const up = this.camera.position.clone().normalize();
      const focus = up.clone().multiplyScalar(1.03);
      const scrUp = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      const h = dist - 1.03, ang = tilt * 0.95;
      this.view.position.copy(focus).addScaledVector(up, Math.cos(ang) * h).addScaledVector(scrUp, -Math.sin(ang) * h);
      this.view.up.copy(scrUp);
      this.view.lookAt(focus);
    }
    this.view.updateMatrixWorld();
    if (this.pixelMode === 'auto') {
      const want = this.autoPixel();
      if (want !== this.pixel) { this.pixel = want; this.resize(); }
    }
    if (this.state && this.borderMesh && this.borderPixel !== this.pixel) this.sync(); // recolour + rebuild borders for the new zoom
    const s = this.state;
    if (s) {
      for (const fx of s.fx) this.handleFx(fx);
      s.fx.length = 0;
      // fire flicker
      if (s.burning.size || this.hot.size) {
        const col = new THREE.Color();
        for (const c of s.burning) this.writeCellColor(c, this.cellColor(c, col));
        for (const c of this.hot.keys()) this.writeCellColor(c, this.cellColor(c, col));
        this.colAttr.needsUpdate = true;
      }
      this.syncWeather();
      for (const obj of this.weatherObjs.values()) {
        const a = obj.pts.geometry.attributes.position.array;
        for (let i = 0; i < obj.n; i++) {
          let ph = (obj.seeds[i * 3 + 1] + this.time * (obj.rain ? 1.6 : -0.25)) % 1;
          if (ph < 0) ph += 1;
          const y = obj.rain ? 1.16 - ph * 0.15 : 1.0 + ph * 0.1;
          a[i * 3] = obj.seeds[i * 3]; a[i * 3 + 1] = y; a[i * 3 + 2] = obj.seeds[i * 3 + 2];
        }
        obj.pts.geometry.attributes.position.needsUpdate = true;
        if (obj.rain) obj.group.rotation.y += dt * 0.05;
      }
    }
    // tweens
    for (const a of this.anims) {
      a.t += dt;
      a.step(Math.min(1, a.t / a.dur));
      if (a.t >= a.dur) { a.done?.(); a.finished = true; }
    }
    this.anims = this.anims.filter((a) => !a.finished);
    if (this.state && this.bodies) { this.updateLife(dt); this.updateEffects(dt); }
    // camera shake
    let off = null;
    if (this.shake > 0) {
      off = new THREE.Vector3().randomDirection().multiplyScalar(this.shake * 0.03);
      this.view.position.add(off);
      this.shake = Math.max(0, this.shake - dt);
    }
    this.view.updateMatrixWorld();
    this.gl.render(this.scene, this.view);
    if (off) { this.view.position.sub(off); this.view.updateMatrixWorld(); }
  }
}
