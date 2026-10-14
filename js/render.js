// three.js view of the world: a voxel globe drawn at low resolution
// and scaled up with hard pixels.
import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { B, BLD, isWater } from './world.js';

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
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    this.gl.setPixelRatio(1);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060f);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
    this.camera.position.set(0, 0.8, 3.1);
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, { enablePan: false, enableDamping: true, dampingFactor: 0.08, minDistance: 1.25, maxDistance: 5, autoRotate: true, autoRotateSpeed: 0.35 });
    this.scene.add(this.camera);
    const sun = new THREE.DirectionalLight(0xfff3dd, 2.6);
    sun.position.set(-2, 2.5, 3);
    this.camera.add(sun);
    this.scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x302418, 1.1));
    this.addStars();
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.09, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0x5aa8ff, transparent: true, opacity: 0.13, side: THREE.BackSide, depthWrite: false }));
    this.scene.add(atmo);
    this.raycaster = new THREE.Raycaster();
    this.tmpColor = new THREE.Color();
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

  setPixelSize(p) { this.pixel = p; this.resize(); }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.gl.setSize(Math.max(1, Math.floor(w / this.pixel)), Math.max(1, Math.floor(h / this.pixel)), false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ world mesh
  setState(state) {
    this.state = state;
    const w = state.world;
    if (this.globe) {
      this.scene.remove(this.globe); this.globe.geometry.dispose();
      for (const m of [this.trees, this.walls, this.roofs, this.mines, this.unitMesh, this.flags, this.poles]) { this.scene.remove(m); m.geometry.dispose(); }
      for (const a of this.anims) a.dispose?.();
      this.anims = []; this.units = [];
      for (const o of this.weatherObjs?.values() || []) this.scene.remove(o.group);
    }
    this.weatherObjs = new Map();
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
      out.lerp(this.tmpColor, border ? 0.7 : bld === BLD.FARM ? 0.12 : 0.28);
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
  }

  // ------------------------------------------------------------ instances
  buildInstances() {
    const lam = (opts) => new THREE.MeshLambertMaterial({ flatShading: true, ...opts });
    const treeG = new THREE.ConeGeometry(0.0065, 0.02, 4); treeG.translate(0, 0.01, 0);
    this.trees = new THREE.InstancedMesh(treeG, lam({}), 14000);
    const wallG = new THREE.BoxGeometry(0.009, 0.007, 0.009); wallG.translate(0, 0.0035, 0);
    this.walls = new THREE.InstancedMesh(wallG, lam({ color: 0xe8dcc0 }), 5000);
    const roofG = new THREE.ConeGeometry(0.0085, 0.007, 4); roofG.rotateY(Math.PI / 4); roofG.translate(0, 0.0105, 0);
    this.roofs = new THREE.InstancedMesh(roofG, lam({}), 5000);
    const mineG = new THREE.ConeGeometry(0.008, 0.009, 3); mineG.translate(0, 0.0045, 0);
    this.mines = new THREE.InstancedMesh(mineG, lam({ color: 0x8a8580 }), 3000);
    const unitG = new THREE.BoxGeometry(0.0045, 0.007, 0.0045); unitG.translate(0, 0.0035, 0);
    this.unitMesh = new THREE.InstancedMesh(unitG, new THREE.MeshBasicMaterial({}), 600);
    const poleG = new THREE.CylinderGeometry(0.0009, 0.0009, 0.04, 4); poleG.translate(0, 0.02, 0);
    this.poles = new THREE.InstancedMesh(poleG, new THREE.MeshBasicMaterial({ color: 0x3a2a1a }), 64);
    const flagG = new THREE.PlaneGeometry(0.016, 0.01); flagG.translate(0.008, 0.035, 0);
    this.flags = new THREE.InstancedMesh(flagG, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), 64);
    for (const m of [this.trees, this.walls, this.roofs, this.mines, this.unitMesh, this.poles, this.flags]) {
      m.count = 0; m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(m);
    }
    this.m4 = new THREE.Matrix4(); this.q4 = new THREE.Quaternion(); this.v3 = new THREE.Vector3(); this.s3 = new THREE.Vector3();
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
    let nt = 0, nh = 0, nm = 0;
    const treeA = C(0x2f6b2a), treeB = C(0x1f4f22), treeJ = C(0x1d7a35), treeT = C(0x35553a);
    for (let c = 0; c < w.count; c++) {
      const b = w.bld[c];
      if (b === BLD.HOUSE && nh < 5000) {
        const m = this.placeMatrix(c, 1);
        this.walls.setMatrixAt(nh, m); this.roofs.setMatrixAt(nh, m);
        const o = w.owner[c];
        if (o >= 0) { const t = s.tribes[o].color; col.setRGB(t[0] * 0.8, t[1] * 0.8, t[2] * 0.8); } else col.set(0x666666);
        this.roofs.setColorAt(nh, col);
        nh++;
      } else if (b === BLD.MINE && nm < 3000) {
        this.mines.setMatrixAt(nm++, this.placeMatrix(c, 1));
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
    this.trees.count = nt; this.walls.count = nh; this.roofs.count = nh; this.mines.count = nm;
    for (const m of [this.trees, this.walls, this.roofs, this.mines]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    let nf = 0;
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
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.globe, false)[0];
    return hit ? Math.floor(hit.faceIndex / CELL_TRIS) : -1;
  }

  // Screen position (CSS px) of a cell, or null if on the far side.
  project(c) {
    const p = this.cellPos(c);
    const toCam = this.camera.position.clone().sub(p);
    if (toCam.dot(p) < 0) return null;
    p.project(this.camera);
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

  flyTo(cell) {
    const dist = Math.min(this.camera.position.length(), 2.4);
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
    const side = new THREE.Vector3().randomDirection().cross(target).normalize();
    const start = target.clone().normalize().multiplyScalar(3.2).add(side.multiplyScalar(1.4));
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.03, 0), new THREE.MeshBasicMaterial({ color: 0xffb040 }));
    const glow = new THREE.Mesh(new THREE.IcosahedronGeometry(0.055, 0), new THREE.MeshBasicMaterial({ color: 0xff4400, transparent: true, opacity: 0.5 }));
    rock.add(glow);
    this.scene.add(rock);
    const trail = [];
    this.anims.push({
      t: 0, dur: 1.3,
      step: (k) => {
        const e = k * k;
        rock.position.lerpVectors(start, target, e);
        rock.rotation.x += 0.3; rock.rotation.y += 0.2;
        if (trail.length < 40) {
          const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(0.02 + Math.random() * 0.02, 0), new THREE.MeshBasicMaterial({ color: Math.random() < 0.5 ? 0xff7a1a : 0x6b6b6b, transparent: true, opacity: 0.8 }));
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
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
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
      case 'bless': this.beam(fx.cell, 0xffe27a, 2.2); break;
      case 'plague': this.flash(this.cellPos(fx.cell), 0.12, 0x6bff4a, 1.4); break;
      case 'quake': this.shake = 0.6; this.flash(this.cellPos(fx.cell), fx.r * 1.3, 0x9a7a55, 1.2); break;
      case 'impact': break; // drawn by playMeteor
    }
  }

  // Little workers walking around villages.
  spawnWorkers() {
    const s = this.state, w = s.world;
    for (const t of s.tribes) {
      if (!t.alive || Math.random() > 0.5) continue;
      const cells = t._cellArr && t._cellArrTick === s.tick ? t._cellArr : (t._cellArr = [...t.cells], t._cellArrTick = s.tick, t._cellArr);
      if (!cells.length) continue;
      const from = cells[Math.floor(Math.random() * cells.length)];
      if (w.bld[from] !== BLD.HOUSE) continue;
      let to = from;
      for (let i = 0; i < 2; i++) to = w.nbr[to * 3 + Math.floor(Math.random() * 3)];
      if (isWater(w.biome[to])) continue;
      this.addUnit(from, to, t.color, 2 + Math.random() * 2, 'walk');
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
      const mat = new THREE.MeshLambertMaterial({ color: 0xc8ccd6, flatShading: true });
      for (let i = 0; i < 26; i++) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
        const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * chord * 0.9;
        box.position.set(Math.cos(a) * d, 1.17 + Math.random() * 0.02, Math.sin(a) * d);
        box.scale.set(0.03 + Math.random() * 0.05, 0.015 + Math.random() * 0.012, 0.03 + Math.random() * 0.05);
        group.add(box);
      }
    } else {
      const ring = new THREE.Mesh(new THREE.CircleGeometry(chord * 1.02, 40), new THREE.MeshBasicMaterial({ color: 0xffa830, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 1.1;
      group.add(ring);
    }
    const n = rain ? 260 : 90;
    const pos = new Float32Array(n * 3), seeds = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * chord * 0.9;
      seeds[i * 3] = Math.cos(a) * d; seeds[i * 3 + 1] = Math.random(); seeds[i * 3 + 2] = Math.sin(a) * d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: rain ? 0x7fb8ff : 0xffc060, size: rain ? 2 : 2, sizeAttenuation: false, transparent: true, opacity: 0.9 }));
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
    this.controls.update();
    const s = this.state;
    if (s) {
      for (const fx of s.fx) this.handleFx(fx);
      s.fx.length = 0;
      // fire flicker
      if (s.burning.size) {
        const col = new THREE.Color();
        for (const c of s.burning) this.writeCellColor(c, this.cellColor(c, col));
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
    // units
    if (this.unitMesh) {
      let n = 0;
      const v = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
      for (const u of this.units) {
        u.t += dt;
        const k = Math.min(1, u.t / u.dur);
        v.copy(u.a).lerp(u.b, k).normalize();
        const r = u.ra + (u.rb - u.ra) * k + (u.kind === 'boat' ? Math.sin(k * Math.PI) * 0.02 : Math.abs(Math.sin(u.t * 14)) * 0.002);
        const r2 = u.kind === 'boat' ? Math.max(r, 1.002) : r;
        q.setFromUnitVectors(up, v);
        sc.setScalar(u.kind === 'boat' ? 2.2 : u.kind === 'army' ? 1.3 : 0.9);
        v.multiplyScalar(r2);
        this.m4.compose(v, q, sc);
        this.unitMesh.setMatrixAt(n, this.m4);
        this.unitMesh.setColorAt(n, u.kind === 'boat' ? this.tmpColor.set(0x8b5a2b) : u.color);
        n++;
      }
      this.units = this.units.filter((u) => u.t < u.dur);
      this.unitMesh.count = n;
      this.unitMesh.instanceMatrix.needsUpdate = true;
      if (this.unitMesh.instanceColor) this.unitMesh.instanceColor.needsUpdate = true;
    }
    // camera shake
    let off = null;
    if (this.shake > 0) {
      off = new THREE.Vector3().randomDirection().multiplyScalar(this.shake * 0.03);
      this.camera.position.add(off);
      this.shake = Math.max(0, this.shake - dt);
    }
    this.gl.render(this.scene, this.camera);
    if (off) this.camera.position.sub(off);
  }
}
