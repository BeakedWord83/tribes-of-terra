// End-to-end browser test for "Tribes of Terra".
// Run:  node tests/e2e.mjs            (starts its own python http.server)
//       BASE_URL=https://host/path/ node tests/e2e.mjs   (test a deployed copy)
// Env:  SHOT_DIR=dir for screenshots (default tests/shots/)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.resolve(process.env.SHOT_DIR || path.join(ROOT, 'tests', 'shots'));
fs.mkdirSync(SHOT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const shots = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  return ok;
}
async function shot(page, name) {
  const p = path.join(SHOT_DIR, name + '.png');
  await page.screenshot({ path: p });
  shots.push(p);
  return p;
}

function freePort(start) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const s = net.createServer();
      s.once('error', () => tryPort(p + 1));
      s.once('listening', () => s.close(() => resolve(p)));
      s.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

async function startServer() {
  if (process.env.BASE_URL) return { base: process.env.BASE_URL.replace(/\/?$/, '/'), stop() {} };
  const port = await freePort(8790);
  const proc = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base); if (r.ok) break; } catch {}
    await sleep(100);
  }
  return { base, stop() { proc.kill(); } };
}

// ---- helpers injected into the page (re-installed after each navigation)
const HELPERS = () => {
  const g = window.game;
  const H = (window.__H = {});
  H.snaps = {};
  H.canvasCtx = () => {
    const c = g.renderer.canvas;
    const t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
    const x = t.getContext('2d', { willReadFrequently: true });
    x.drawImage(c, 0, 0);
    return { x, w: c.width, h: c.height, c };
  };
  // region in CSS px -> ImageData
  H.region = (x0, y0, x1, y1) => {
    const { x, w, h, c } = H.canvasCtx();
    const sx = w / c.clientWidth, sy = h / c.clientHeight;
    const ax = Math.max(0, Math.floor(x0 * sx)), ay = Math.max(0, Math.floor(y0 * sy));
    const bx = Math.min(w, Math.ceil(x1 * sx)), by = Math.min(h, Math.ceil(y1 * sy));
    return x.getImageData(ax, ay, Math.max(1, bx - ax), Math.max(1, by - ay));
  };
  H.snap = (name, x0, y0, x1, y1) => { H.snaps[name] = H.region(x0, y0, x1, y1); return true; };
  // fraction of pixels whose colour differs noticeably between two snaps (same region)
  H.diff = (a, b) => {
    const A = H.snaps[a].data, B = H.snaps[b].data;
    if (A.length !== B.length) return 1;
    let n = 0;
    for (let i = 0; i < A.length; i += 4) {
      if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 30) n++;
    }
    return n / (A.length / 4);
  };
  H.colorStats = (x0, y0, x1, y1) => {
    const d = H.region(x0, y0, x1, y1).data;
    const set = new Set();
    let lum = 0, blue = 0, green = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      set.add(((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3));
      lum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (d[i + 2] > d[i] + 25 && d[i + 2] > d[i + 1]) blue++;
      if (d[i + 1] > d[i + 2] + 10 && d[i + 1] >= d[i]) green++;
      n++;
    }
    return { unique: set.size, avgLum: lum / n, blueFrac: blue / n, greenFrac: green / n, n };
  };
  H.camDir = () => g.renderer.camera.position.clone().normalize();
  H.dotCam = (c) => {
    const w = g.state.world, p = g.renderer.camera.position, l = p.length();
    return (w.center[c * 3] * p.x + w.center[c * 3 + 1] * p.y + w.center[c * 3 + 2] * p.z) / l;
  };
  // Candidate cell the mouse can really hit: facing the camera, on screen, not covered by a
  // panel (elementFromPoint is the canvas), and pick() maps the screen point back to the cell.
  H.find = (pred, { minDot = 0.6, avoid = null, minAngle = 0 } = {}) => {
    const w = g.state.world, cv = g.renderer.canvas;
    const cands = [];
    for (let c = 0; c < w.count; c++) {
      if (H.dotCam(c) < minDot) continue;
      if (avoid != null) {
        const d = w.center[c * 3] * w.center[avoid * 3] + w.center[c * 3 + 1] * w.center[avoid * 3 + 1] + w.center[c * 3 + 2] * w.center[avoid * 3 + 2];
        if (Math.acos(Math.min(1, d)) < minAngle) continue;
      }
      if (!pred(c, w, g.state)) continue;
      const p = g.project(c);
      if (!p || p.x < 5 || p.y < 5 || p.x > innerWidth - 5 || p.y > innerHeight - 5) continue;
      const el = document.elementFromPoint(p.x, p.y);
      if (el !== cv) continue;
      if (g.pick(p.x, p.y) !== c) continue;
      cands.push({ c, x: p.x, y: p.y, d: Math.hypot(p.x - innerWidth / 2, p.y - innerHeight / 2) });
    }
    cands.sort((a, b) => a.d - b.d);
    return cands.length ? cands[Math.min(cands.length - 1, 3)] : null; // a few off the exact middle
  };
  H.alive = () => g.state.tribes.filter((t) => t.alive).length;
  return true;
};

async function main() {
  const server = await startServer();
  const base = server.base;
  console.log('Testing', base);
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 } });
  const page = await ctx.newPage();
  const errors = [];
  const IGNORE = /fonts\.(googleapis|gstatic)|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|Failed to load resource/i;
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  const load = async (qs) => {
    await page.goto(base + qs, { waitUntil: 'load' });
    await page.waitForFunction(() => window.game && window.game.state && window.game.renderer.globe, null, { timeout: 20000 });
    await page.evaluate(HELPERS);
    await sleep(500);
  };
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const mouseTo = async (x, y) => { await page.mouse.move(x, y, { steps: 3 }); await sleep(100); };
  const clickBtn = async (sel) => { await page.click(sel); await sleep(100); };
  const W = 1400, H_ = 850;

  // ============================================================ 1. load
  try {
    await load('?seed=42&rotate=0&speed=0');
    const title = await page.title();
    const hash42 = await ev(() => game.worldHash());
    await sleep(500);
    const center = await ev(([w, h]) => __H.colorStats(w / 2 - 200, h / 2 - 200, w / 2 + 200, h / 2 + 200), [W, H_]);
    const corners = await ev(([w, h]) => [
      __H.colorStats(0, 0, 30, 30), __H.colorStats(w - 30, 0, w, 30),
      __H.colorStats(0, h - 30, 30, h), __H.colorStats(w - 30, h - 30, w, h),
    ], [W, H_]);
    await shot(page, '01-load');
    check('1a title contains "Tribes of Terra"', /Tribes of Terra/i.test(title), `title="${title}"`);
    check('1b globe center has many colors incl. water and land', center.unique > 30 && center.blueFrac > 0.03 && center.greenFrac > 0.03,
      `unique=${center.unique} blue=${center.blueFrac.toFixed(2)} green=${center.greenFrac.toFixed(2)}`);
    const maxCornerLum = Math.max(...corners.map((c) => c.avgLum));
    check('1c corners are near-black space', maxCornerLum < 40, `corner avg luminance=${corners.map((c) => c.avgLum.toFixed(1)).join(',')}`);
    check('1d no console errors / pageerrors on load', errors.length === 0, errors.join(' | '));
    globalThis.__hash42 = hash42;
  } catch (e) { check('1 load', false, e.message); }

  // ============================================================ 2. drag rotate
  try {
    await ev(([w, h]) => __H.snap('before', w / 2 - 200, h / 2 - 200, w / 2 + 200, h / 2 + 200), [W, H_]);
    const cam0 = await ev(() => game.renderer.camera.position.toArray());
    await page.mouse.move(W / 2 - 150, H_ / 2);
    await page.mouse.down();
    await page.mouse.move(W / 2 + 150, H_ / 2, { steps: 15 });
    await page.mouse.up();
    await sleep(800);
    const cam1 = await ev(() => game.renderer.camera.position.toArray());
    const moved = Math.hypot(...cam0.map((v, i) => v - cam1[i]));
    await ev(([w, h]) => __H.snap('after', w / 2 - 200, h / 2 - 200, w / 2 + 200, h / 2 + 200), [W, H_]);
    const frac = await ev(() => __H.diff('before', 'after'));
    await shot(page, '02-after-drag');
    check('2a real mouse drag moves the camera', moved > 0.3, `camera moved ${moved.toFixed(3)}`);
    check('2b center pixels changed after drag', frac > 0.2, `${(frac * 100).toFixed(1)}% pixels differ`);
  } catch (e) { check('2 drag', false, e.message); }

  // ============================================================ 3. inspector hover
  try {
    await page.mouse.move(10, 400);
    // wait for drag inertia (damping) to settle so hover and inspector agree
    let prev = null;
    for (let i = 0; i < 40; i++) {
      const p = JSON.stringify(await ev(() => game.renderer.camera.position.toArray().map((v) => +v.toFixed(4))));
      if (p === prev) break;
      prev = p; await sleep(250);
    }
    await mouseTo(W / 2, H_ / 2);
    await sleep(700);
    const r = await ev(async () => {
      const { BIOME_NAMES } = await import(new URL('js/world.js', location.href).href);
      const c = game.hover;
      return { c, expect: BIOME_NAMES[game.state.world.biome[c]], title: document.querySelector('#inspect .title')?.textContent || '', text: document.getElementById('inspect').innerText, names: BIOME_NAMES };
    });
    check('3 hover shows biome name in #inspect', r.c >= 0 && r.title.includes(r.expect), `cell=${r.c} expected "${r.expect}" got title="${r.title}"`);
  } catch (e) { check('3 inspector', false, e.message); }

  // ============================================================ 4. spawn tribe
  let spawnedCap = -1;
  try {
    // Find a land cell with a free, un-owned neighbourhood
    const pick = await ev(() => __H.find((c, w) => w.biome[c] > 2 && w.owner[c] < 0 && w.level[c] > 0));
    if (!pick) throw new Error('no visible free land cell');
    const before = await ev(() => ({ n: game.state.tribes.length, a: __H.alive(), rows: document.querySelectorAll('#tribelist .tribe').length }));
    await clickBtn('#powerlist [data-power="tribe"]');
    const sel = await ev(() => game.power);
    await mouseTo(pick.x, pick.y);
    await page.mouse.click(pick.x, pick.y);
    await sleep(400);
    const after = await ev(() => {
      const t = game.state.tribes[game.state.tribes.length - 1];
      return { n: game.state.tribes.length, rows: document.querySelectorAll('#tribelist .tribe').length, cap: t.capital, birth: game.state.log.some((l) => l.kind === 'birth' && l.text.includes(t.name)), name: t.name, power: game.power };
    });
    spawnedCap = after.cap;
    await shot(page, '04-tribe-spawned');
    check('4a Spawn Tribe button selects the power', sel === 'tribe', `game.power=${sel}`);
    check('4b click on land adds a tribe (+1 in state)', after.n === before.n + 1, `${before.n} -> ${after.n}`);
    check('4c tribe list rows +1', after.rows === before.rows + 1, `${before.rows} -> ${after.rows}`);
    check('4d new tribe capital is the clicked cell', after.cap === pick.c, `clicked ${pick.c}, capital ${after.cap}`);
    check('4e log has a "birth" entry for the new tribe', after.birth, `name=${after.name}`);
    // water click
    const water = await ev(() => __H.find((c, w) => w.biome[c] <= 2));
    if (!water) throw new Error('no visible water cell');
    await ev(() => { document.getElementById('toast').textContent = ''; });
    await mouseTo(water.x, water.y);
    await page.mouse.click(water.x, water.y);
    await sleep(300);
    const w2 = await ev(() => ({ n: game.state.tribes.length, toast: document.getElementById('toast').textContent }));
    check('4f click on water spawns nothing and toast mentions water', w2.n === after.n && /water/i.test(w2.toast), `tribes ${after.n} -> ${w2.n}, toast="${w2.toast}"`);
    await page.keyboard.press('Escape');
  } catch (e) { check('4 spawn tribe', false, e.message); }

  // ============================================================ 5. meteor
  try {
    const pick = await ev(() => __H.find((c, w) => w.biome[c] > 2 && w.level[c] >= 3));
    if (!pick) throw new Error('no visible land cell with level >= 3');
    await clickBtn('#powerlist [data-power="meteor"]');
    await mouseTo(pick.x, pick.y);
    await sleep(300);
    const rg = [pick.x - 60, pick.y - 60, pick.x + 60, pick.y + 60];
    const before = await ev(([c, rg]) => {
      __H.snap('m0', ...rg);
      const w = game.state.world;
      return { level: w.level[c], biome: w.biome[c], disasters: game.state.log.filter((l) => l.kind === 'disaster').length };
    }, [pick.c, rg]);
    await page.mouse.click(pick.x, pick.y);
    await sleep(2800);
    const after = await ev(([c, rg]) => {
      __H.snap('m1', ...rg);
      const w = game.state.world;
      return { level: w.level[c], biome: w.biome[c], disasters: game.state.log.filter((l) => l.kind === 'disaster').length, frac: __H.diff('m0', 'm1') };
    }, [pick.c, rg]);
    await shot(page, '05-meteor-after');
    check('5a meteor lowers terrain level at hit cell', after.level < before.level, `level ${before.level} -> ${after.level}`);
    check('5b log has a "disaster" entry', after.disasters > before.disasters, `${before.disasters} -> ${after.disasters}`);
    check('5c pixels around hit point changed', after.frac > 0.05, `${(after.frac * 100).toFixed(1)}% of 120x120px region differ`);
    await page.keyboard.press('Escape');
  } catch (e) { check('5 meteor', false, e.message); }

  // ============================================================ 6. rain / drought
  try {
    const rain = await ev(() => __H.find((c, w) => w.biome[c] > 2 && w.level[c] > 0 && w.wet[c] === 0));
    if (!rain) throw new Error('no visible land for rain');
    await clickBtn('#powerlist [data-power="rain"]');
    await mouseTo(rain.x, rain.y);
    await page.mouse.click(rain.x, rain.y);
    await sleep(300);
    const wx = await ev((c) => game.state.weather.some((x) => x.type === 'rain' && x.cell === c), rain.c);
    const wet = await ev((c) => { game.step(20); return game.state.world.wet[c]; }, rain.c);
    check('6a rain adds a rain weather entry at the clicked cell', wx, `cell ${rain.c}`);
    check('6b wet > 0 after 20 ticks', wet > 0, `wet=${wet.toFixed(3)}`);
    await page.keyboard.press('Escape');

    const dr = await ev((a) => __H.find((c, w) => w.biome[c] > 2 && w.level[c] > 0 && w.wet[c] === 0, { avoid: a, minAngle: 0.5, minDot: 0.5 }), rain.c);
    if (!dr) throw new Error('no visible land for drought away from rain');
    await clickBtn('#powerlist [data-power="drought"]');
    await mouseTo(dr.x, dr.y);
    await page.mouse.click(dr.x, dr.y);
    await sleep(300);
    const dx = await ev((c) => game.state.weather.some((x) => x.type === 'drought' && x.cell === c), dr.c);
    const dwet = await ev((c) => { game.step(20); return game.state.world.wet[c]; }, dr.c);
    await shot(page, '06-rain-drought');
    check('6c drought adds a drought weather entry', dx, `cell ${dr.c}`);
    check('6d wet < 0 after 20 ticks', dwet < 0, `wet=${dwet.toFixed(3)}`);
    await page.keyboard.press('Escape');
  } catch (e) { check('6 rain/drought', false, e.message); }

  // ============================================================ 7. forest, quake, plague, bless
  try {
    // forest
    const f = await ev(() => __H.find((c, w) => w.biome[c] > 2 && w.biome[c] !== 9 && w.level[c] > 0 && w.trees[c] === 0 && w.bld[c] === 0 && w.owner[c] < 0 && w.wet[c] === 0));
    if (!f) throw new Error('no visible bare land for forest');
    const f0 = await ev((c) => game.state.world.trees[c], f.c);
    await clickBtn('#powerlist [data-power="forest"]');
    await mouseTo(f.x, f.y);
    await page.mouse.click(f.x, f.y);
    await sleep(300);
    const f1 = await ev((c) => game.state.world.trees[c], f.c);
    check('7a forest raises tree cover on a bare cell', f1 > f0, `trees ${f0} -> ${f1.toFixed(2)}`);
    await page.keyboard.press('Escape');

    // quake
    const q = await ev(() => __H.find((c, w) => w.biome[c] > 2 && w.level[c] >= 1 && w.level[c] <= 4 && w.wet[c] === 0, { minDot: 0.7 }));
    if (!q) throw new Error('no visible land for quake');
    const q0 = await ev((c) => game.state.world.level[c], q.c);
    await clickBtn('#powerlist [data-power="quake"]');
    await mouseTo(q.x, q.y);
    await page.mouse.click(q.x, q.y);
    await sleep(300);
    const q1 = await ev((c) => game.state.world.level[c], q.c);
    check('7b earthquake raises the level', q1 > q0, `level ${q0} -> ${q1}`);
    await page.keyboard.press('Escape');

    // plague / bless: need a visible owned cell. Fly to a tribe first.
    const flyToTribe = async () => {
      await ev(() => { const t = game.state.tribes.find((t) => t.alive); game.renderer.flyTo(t.capital); });
      await sleep(2500);
    };
    await flyToTribe();
    let own = await ev(() => __H.find((c, w, s) => w.owner[c] >= 0 && s.tribes[w.owner[c]].alive && w.biome[c] > 2, { minDot: 0.5 }));
    if (!own) throw new Error('no visible owned cell after flying to a tribe');
    const tid = await ev((c) => game.state.world.owner[c], own.c);
    await clickBtn('#powerlist [data-power="plague"]');
    await mouseTo(own.x, own.y);
    await page.mouse.click(own.x, own.y);
    await sleep(300);
    const pl = await ev((id) => game.state.tribes[id].plague, tid);
    check('7c plague sets tribe.plague > 0', pl > 0, `tribe ${tid} plague=${pl}`);
    await page.keyboard.press('Escape');

    own = await ev(() => __H.find((c, w, s) => w.owner[c] >= 0 && s.tribes[w.owner[c]].alive && w.biome[c] > 2, { minDot: 0.5 }));
    const tid2 = await ev((c) => game.state.world.owner[c], own.c);
    await clickBtn('#powerlist [data-power="bless"]');
    await mouseTo(own.x, own.y);
    await page.mouse.click(own.x, own.y);
    await sleep(300);
    const bl = await ev((id) => ({ blessed: game.state.tribes[id].blessed, plague: game.state.tribes[id].plague }), tid2);
    await shot(page, '07-bless');
    check('7d bless sets tribe.blessed > 0', bl.blessed > 0, `tribe ${tid2} blessed=${bl.blessed}`);
    await page.keyboard.press('Escape');
  } catch (e) { check('7 other powers', false, e.message); }

  // ============================================================ 8. sim speed
  try {
    await ev(() => game.setSpeed(0));
    await sleep(200);
    const d0 = await ev(() => ({ tick: game.state.tick, date: document.getElementById('date').textContent }));
    await clickBtn('#speed [data-speed="8"]');
    const on = await ev(() => document.querySelector('#speed [data-speed="8"]').classList.contains('on') && game.speed === 8);
    await sleep(5000);
    const d1 = await ev(() => ({ tick: game.state.tick, date: document.getElementById('date').textContent }));
    await shot(page, '08-sim-running');
    check('8a fastest button sets speed 8', on);
    check('8b tick advanced > 100 in 5s', d1.tick - d0.tick > 100, `tick ${d0.tick} -> ${d1.tick} (+${d1.tick - d0.tick})`);
    check('8c #date text changed', d1.date !== d0.date, `"${d0.date}" -> "${d1.date}"`);
    await clickBtn('#speed [data-speed="0"]');
    await sleep(300);
    const p0 = await ev(() => game.state.tick);
    await sleep(1000);
    const p1 = await ev(() => game.state.tick);
    check('8d pause button stops the sim', p1 === p0 && (await ev(() => game.speed)) === 0, `tick ${p0} -> ${p1}`);
  } catch (e) { check('8 speed', false, e.message); }

  // ============================================================ 9. tribe list click
  try {
    const info = await ev(() => {
      const row = document.querySelector('#tribelist .tribe');
      const id = +row.dataset.id, t = game.state.tribes[id], w = game.state.world, cam = game.renderer.camera;
      const n = [w.center[t.capital * 3], w.center[t.capital * 3 + 1], w.center[t.capital * 3 + 2]];
      // put the camera 90 degrees away from the capital so "moves toward" is measurable
      let ax = [n[1], -n[0], 0]; const l = Math.hypot(...ax);
      if (l < 1e-3) ax = [0, n[2], -n[1]];
      const l2 = Math.hypot(...ax);
      const len = cam.position.length();
      cam.position.set(ax[0] / l2 * len, ax[1] / l2 * len, ax[2] / l2 * len);
      return { id, name: t.name, n };
    });
    await sleep(500);
    const dotOf = (n) => ev((n) => { const p = game.renderer.camera.position, l = p.length(); return (n[0] * p.x + n[1] * p.y + n[2] * p.z) / l; }, n);
    const d0 = await dotOf(info.n);
    await page.click('#tribelist .tribe');
    await sleep(1800);
    const d1 = await dotOf(info.n);
    const st = await ev(() => ({ sel: game.selected, title: document.querySelector('#inspect .title')?.textContent || '' }));
    await shot(page, '09-tribe-selected');
    check('9a game.selected equals clicked tribe id', st.sel === info.id, `selected=${st.sel} expected ${info.id}`);
    check('9b #inspect shows "The <name>"', st.title.includes('The ' + info.name), `title="${st.title}"`);
    check('9c camera moved toward the capital', d1 > d0 + 0.3, `dot(cam, capital) ${d0.toFixed(2)} -> ${d1.toFixed(2)}`);
  } catch (e) { check('9 tribe list click', false, e.message); }

  // ============================================================ 10. seed determinism
  try {
    const r = await ev(() => {
      game.newWorld('abc'); const a = game.worldHash();
      game.newWorld('xyz'); const b = game.worldHash();
      game.newWorld('abc'); const a2 = game.worldHash();
      return { a, b, a2 };
    });
    check('10a same seed -> same world hash, different seed -> different', r.a === r.a2 && r.a !== r.b, `abc=${r.a} xyz=${r.b} abc again=${r.a2}`);
    await page.fill('#seed', 'moon42');
    await clickBtn('#newworld');
    await sleep(300);
    const u = new URL(page.url());
    const ui = await ev(() => ({ h: game.worldHash(), seedBox: document.getElementById('seed').value }));
    const expect = await ev(() => { game.newWorld('moon42'); return game.worldHash(); });
    check('10b UI new world puts ?seed=moon42 in the URL', u.searchParams.get('seed') === 'moon42', `url=${u.search}`);
    check('10c UI new world hash equals newWorld("moon42")', ui.h === expect, `ui=${ui.h} api=${expect}`);
  } catch (e) { check('10 seed determinism', false, e.message); }

  // ============================================================ 11. reload
  try {
    await load('?seed=42&rotate=0&speed=0');
    const h = await ev(() => game.worldHash());
    const ok = await ev(() => game.state.tick === 0 && game.state.tribes.length > 0);
    check('11 reload ?seed=42 gives same world hash as test 1 and a fresh state', h === globalThis.__hash42 && ok, `${globalThis.__hash42} vs ${h}, fresh=${ok}`);
  } catch (e) { check('11 reload', false, e.message); }

  // ============================================================ 12. cancel power
  try {
    await clickBtn('#powerlist [data-power="rain"]');
    const a = await ev(() => game.power);
    await page.keyboard.press('Escape');
    const b = await ev(() => game.power);
    await clickBtn('#powerlist [data-power="quake"]');
    const c = await ev(() => game.power);
    const pt = await ev(() => __H.find((c, w) => w.biome[c] > 2) || __H.find(() => true));
    await mouseTo(pt.x, pt.y);
    await page.mouse.click(pt.x, pt.y, { button: 'right' });
    await sleep(200);
    const d = await ev(() => ({ power: game.power, on: document.querySelectorAll('#powerlist button.on').length, tribes: game.state.tribes.length }));
    check('12a Esc cancels selected power', a === 'rain' && b === null, `before=${a} after=${b}`);
    check('12b right-click cancels selected power (and does not apply it)', c === 'quake' && d.power === null && d.on === 0, `before=${c} after=${d.power}, highlighted buttons=${d.on}`);
  } catch (e) { check('12 cancel', false, e.message); }

  // ============================================================ 14. zoom in: sharp pixels + tilted view (real mouse wheel)
  const settle = async () => {
    // wait until the camera stops moving (damping / fly animation)
    let last = null;
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      const p = await ev(() => game.renderer.camera.position.toArray().map((v) => +v.toFixed(4)).join(','));
      if (p === last) return;
      last = p;
    }
  };
  try {
    await load('?seed=42&rotate=0&speed=0');
    const far = await ev(() => ({ px: game.renderer.pixel, cw: game.renderer.canvas.width, css: game.renderer.canvas.clientWidth }));
    const cap = await ev(() => { game.step(260); const t = [...game.state.tribes].filter((t) => t.alive).sort((a, b) => b.pop - a.pop)[0]; game.renderer.flyTo(t.capital); return { id: t.id, c: t.capital, name: t.name }; });
    await settle();
    await page.mouse.move(W / 2, H_ / 2);
    for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, -250); await sleep(40); }
    await settle();
    // centre the capital again after zooming (zoom is toward the globe center)
    await ev((c) => game.renderer.flyTo(c, 1.3), cap.c);
    await settle();
    const near = await ev(() => ({ px: game.renderer.pixel, cw: game.renderer.canvas.width, css: game.renderer.canvas.clientWidth, dist: (game.renderer.camBase || game.renderer.camera.position).length() }));
    await shot(page, '14-zoomed-village');
    check('14a far view uses chunky pixels', far.px === 3 && far.cw <= Math.ceil(far.css / 3), `pixel=${far.px} canvas=${far.cw} css=${far.css}`);
    check('14b mouse wheel zooms close; close view is sharp (canvas = CSS size)', near.px === 1 && near.cw === near.css && near.dist < 1.5, `dist=${near.dist.toFixed(2)} pixel=${near.px} canvas=${near.cw} css=${near.css}`);

    // ---- measure real on-screen sizes of a house and a person near the capital
    const sz = await ev(async (capCell) => {
      const THREE = await import(new URL('vendor/three.module.js', location.href).href);
      const R = game.renderer, cam = R.camera;
      const rect = R.canvas.getBoundingClientRect();
      const toPx = (v) => { const p = v.clone().project(cam); return { x: (p.x + 1) / 2 * rect.width, y: (1 - p.y) / 2 * rect.height, z: p.z }; };
      const capPos = R.cellPos(capCell);
      const measure = (mesh) => {
        mesh.geometry.computeBoundingBox();
        const bb = mesh.geometry.boundingBox, m = new THREE.Matrix4(), pos = new THREE.Vector3();
        let best = -1, bd = 1e9;
        for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, m); pos.setFromMatrixPosition(m); const d = pos.distanceTo(capPos); if (d < bd) { bd = d; best = i; } }
        if (best < 0) return null;
        mesh.getMatrixAt(best, m);
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) {
          const p = toPx(new THREE.Vector3(x, y, z).applyMatrix4(m));
          x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
        }
        return { w: x1 - x0, h: y1 - y0, dist: bd };
      };
      const house = R.walls.count ? measure(R.walls) : measure(R.huts);
      const body = measure(R.bodies), head = measure(R.heads);
      return { house, person: body && head ? { h: body.h + head.h, w: Math.max(body.w, head.w) } : null, people: R.bodies.count, villages: R.villages.length, flames: R.flames.count };
    }, cap.c);
    check('14c a house near the capital is big on screen (>= 18 px)', sz.house && Math.max(sz.house.w, sz.house.h) >= 18, `house ${sz.house?.w.toFixed(1)}x${sz.house?.h.toFixed(1)} px`);
    check('14d a person is visible on screen (>= 7 px tall)', sz.person && sz.person.h >= 7, `person ${sz.person?.w.toFixed(1)}x${sz.person?.h.toFixed(1)} px, people drawn=${sz.people}`);
    const villCheck = await ev(() => {
      const w = game.state.world; let n = 0;
      for (let c = 0; c < w.count; c++) if (w.bld[c] === 2 && w.owner[c] >= 0 && game.state.tribes[w.owner[c]].alive) n++;
      return n;
    });
    check('14e one campfire per village', sz.flames === sz.villages && sz.villages === Math.min(villCheck, 4000) && sz.villages > 0, `flames=${sz.flames} villages drawn=${sz.villages} village tiles=${villCheck}`);

    // people walk and flames flicker (compare instance matrices over time)
    const motion = await ev(async () => {
      const R = game.renderer;
      const grab = (m, n) => Array.from(m.instanceMatrix.array.slice(0, n * 16));
      const n = Math.min(200, R.bodies.count), nf = Math.min(50, R.flames.count);
      const b0 = grab(R.bodies, n), f0 = grab(R.flames, nf);
      await new Promise((r) => setTimeout(r, 1500));
      const b1 = grab(R.bodies, n), f1 = grab(R.flames, nf);
      let moved = 0;
      for (let i = 0; i < n; i++) { const d = Math.hypot(b1[i * 16 + 12] - b0[i * 16 + 12], b1[i * 16 + 13] - b0[i * 16 + 13], b1[i * 16 + 14] - b0[i * 16 + 14]); if (d > 1e-5) moved++; }
      let flick = 0;
      for (let i = 0; i < nf; i++) if (Math.abs(f1[i * 16 + 5] - f0[i * 16 + 5]) > 1e-6 || Math.abs(f1[i * 16 + 1] - f0[i * 16 + 1]) > 1e-6) flick++;
      return { n, moved, nf, flick };
    });
    check('14f villagers walk (positions change over 1.5 s)', motion.moved >= motion.n * 0.3, `${motion.moved}/${motion.n} people moved`);
    check('14g campfire flames flicker', motion.flick >= motion.nf * 0.5, `${motion.flick}/${motion.nf} flames changed`);

    // ---- tribe name label sits over the capital and is clickable
    const lbl = await ev((id) => {
      const el = document.querySelector(`#labels .lbl[data-id="${id}"]`);
      const t = game.state.tribes[id];
      const p = game.project(t.capital);
      if (!el || !p) return null;
      const r = el.getBoundingClientRect();
      return { text: el.textContent, cx: r.left + r.width / 2, bottom: r.bottom, px: p.x, py: p.y, shown: el.style.display !== 'none', w: r.width };
    }, cap.id);
    check('14h tribe name label is shown above its capital', lbl && lbl.shown && lbl.text.includes(cap.name) && Math.abs(lbl.cx - lbl.px) < 6 && lbl.bottom <= lbl.py && lbl.py - lbl.bottom < 40,
      lbl ? `label "${lbl.text}" centre x=${lbl.cx.toFixed(0)} vs capital x=${lbl.px.toFixed(0)}, bottom=${lbl.bottom.toFixed(0)} capital y=${lbl.py.toFixed(0)}` : 'no label');
    await ev(() => { game.selected = null; });
    if (lbl) { await page.mouse.click(lbl.cx, lbl.bottom - 6); await sleep(300); }
    const selId = await ev(() => game.selected);
    check('14i clicking a label selects that tribe', selId === cap.id, `selected=${selId} expected ${cap.id}`);

    // ---- pixel mode button
    const modes = [];
    for (let i = 0; i < 3; i++) {
      await clickBtn('#pixmode');
      await sleep(250);
      modes.push(await ev(() => ({ text: document.getElementById('pixmode').textContent, px: game.renderer.pixel, cw: game.renderer.canvas.width })));
    }
    check('14j pixel button: Retro forces chunky pixels up close', /Retro/.test(modes[0].text) && modes[0].px === 3, JSON.stringify(modes[0]));
    check('14k pixel button: Sharp forces full resolution', /Sharp/.test(modes[1].text) && modes[1].px === 1, JSON.stringify(modes[1]));
    check('14l pixel button: back to Auto (sharp because we are close)', /Auto/.test(modes[2].text) && modes[2].px === 1, JSON.stringify(modes[2]));
  } catch (e) { check('14 zoom/village', false, e.message); }

  // ============================================================ 15. meteor into a forest -> wildfire you can see
  try {
    await load('?seed=7&rotate=0&speed=0');
    // a spot in the middle of a big forest (most tiles within ~0.25 rad are wooded)
    const tgt = await ev(() => __H.find((c, w) => {
      if (w.owner[c] >= 0 || w.biome[c] !== 5 || w.trees[c] < 0.7) return false;
      let n = 0, wood = 0;
      const cos = Math.cos(0.25);
      for (let i = 0; i < w.count; i++) {
        if (w.center[i * 3] * w.center[c * 3] + w.center[i * 3 + 1] * w.center[c * 3 + 1] + w.center[i * 3 + 2] * w.center[c * 3 + 2] < cos) continue;
        n++; if (w.trees[i] > 0.4) wood++;
      }
      return wood / n > 0.6;
    }, { minDot: 0.75 }));
    if (!tgt) throw new Error('no visible forest cell');
    await ev(([x, y]) => __H.snap('f0', x - 120, y - 120, x + 120, y + 120), [tgt.x, tgt.y]);
    const orange = (name) => ev((n) => { const d = __H.snaps[n].data; let k = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 60 && d[i + 1] < 200 && d[i + 2] < 90) k++; return k; }, name);
    const o0 = await orange('f0');
    await clickBtn('#powerlist [data-power="meteor"]');
    await mouseTo(tgt.x, tgt.y);
    await page.mouse.click(tgt.x, tgt.y);
    await sleep(2600);
    await ev(([x, y]) => __H.snap('f1', x - 120, y - 120, x + 120, y + 120), [tgt.x, tgt.y]);
    const o1 = await orange('f1');
    const fx = await ev(() => ({ flames: game.renderer.fireMesh.count, parts: game.renderer.partMesh.count, hot: game.renderer.hot.size, burning: game.state.burning.size }));
    await shot(page, '15-meteor-forest');
    check('15a meteor sets the forest on fire (burning tiles + flame meshes)', fx.burning > 5 && fx.flames >= fx.burning, `burning=${fx.burning} flames=${fx.flames}`);
    check('15b impact makes debris/smoke particles and a glowing crater', fx.parts > 30 && fx.hot > 5, `particles=${fx.parts} hot crater tiles=${fx.hot}`);
    check('15c fire shows on screen (orange pixels near the hit)', o1 > o0 + 50, `orange px ${o0} -> ${o1}`);
    // let the sim run: fire must spread beyond the blast
    await clickBtn('#speed [data-speed="1"]');
    await sleep(4000);
    await clickBtn('#speed [data-speed="0"]');
    const spread = await ev((c) => {
      const w = game.state.world;
      let beyond = 0, ash = 0;
      for (let i = 0; i < w.count; i++) {
        const d = Math.acos(Math.min(1, w.center[i * 3] * w.center[c * 3] + w.center[i * 3 + 1] * w.center[c * 3 + 1] + w.center[i * 3 + 2] * w.center[c * 3 + 2]));
        if (d > 0.09 * 2.2 && (w.fire[i] || w.biome[i] === 12)) beyond++;
        if (w.biome[i] === 12) ash++;
      }
      return { beyond, ash, wild: game.state.log.some((l) => /wildfire|fire is out/i.test(l.text)), smoke: game.renderer.partMesh.count };
    }, tgt.c);
    await shot(page, '15-wildfire');
    check('15d the fire spreads past the blast zone', spread.beyond > 10, `burning/ash tiles beyond blast=${spread.beyond}`);
    check('15e burnt forest turns to ash', spread.ash > 10, `ash tiles=${spread.ash}`);
    check('15f chronicle reports the wildfire', spread.wild);
    // rain on the fire puts it out
    const fire = await ev(() => { const b = [...game.state.burning]; return b.length ? b[0] : -1; });
    if (fire >= 0) {
      await ev((c) => game.renderer.flyTo(c), fire);
      await settle();
      const p = await ev((c) => game.project(c), fire);
      await clickBtn('#powerlist [data-power="rain"]');
      await mouseTo(p.x, p.y);
      await page.mouse.click(p.x, p.y);
      await sleep(300);
      const r = await ev((c) => { const w = game.state.world; const wx = game.state.weather.at(-1); return { inArea: wx ? wx.cells.filter((x) => w.fire[x]).length : -1, at: wx?.cell }; }, fire);
      check('15g rain on the fire puts it out in the rain area', r.inArea === 0, `burning tiles under the rain=${r.inArea}`);
    } else check('15g rain on the fire puts it out in the rain area', false, 'fire already out');
  } catch (e) { check('15 wildfire', false, e.message); }

  // ============================================================ 16. other powers have visible effects
  try {
    await load('?seed=42&rotate=0&speed=0');
    const countParts = (test) => ev((t) => {
      const R = game.renderer, f = new Function('p', 'return ' + t);
      return R.parts.filter((p) => f(p)).length;
    }, test);
    const land = await ev(() => __H.find((c, w) => w.biome[c] > 2 && w.level[c] < 5));
    await clickBtn('#powerlist [data-power="quake"]');
    await mouseTo(land.x, land.y);
    await page.mouse.click(land.x, land.y);
    await sleep(250);
    const dust = await countParts('p.color.r > p.color.b && p.color.g < 0.7 && p.color.r < 0.8');
    const shake = await ev(() => game.renderer.shake);
    await shot(page, '16-quake');
    check('16a earthquake throws up dust and shakes the camera', dust > 80 && shake > 0, `dust particles=${dust} shake=${shake.toFixed(2)}`);

    const t = await ev(() => { const t = game.state.tribes.find((t) => t.alive); game.renderer.flyTo(t.capital); return { id: t.id, c: t.capital }; });
    await settle();
    let p = await ev((c) => game.project(c), t.c);
    await clickBtn('#powerlist [data-power="plague"]');
    await mouseTo(p.x, p.y);
    await page.mouse.click(p.x, p.y);
    await sleep(300);
    const green = await countParts('p.color.g > p.color.r * 1.3 && p.color.g > p.color.b * 1.3');
    await shot(page, '16-plague');
    check('16b plague makes a green sickness cloud', green > 30, `green particles=${green}`);
    await clickBtn('#powerlist [data-power="bless"]');
    await page.mouse.click(p.x, p.y);
    await sleep(300);
    const gold = await countParts('p.color.r > 0.9 && p.color.g > 0.8');
    check('16c bless makes golden sparkles', gold > 30, `gold particles=${gold}`);
    const forestPt = await ev(() => __H.find((c, w) => w.biome[c] > 2 && w.trees[c] < 0.2 && w.biome[c] !== 7 && w.biome[c] !== 9 && w.owner[c] < 0));
    await clickBtn('#powerlist [data-power="forest"]');
    await mouseTo(forestPt.x, forestPt.y);
    await page.mouse.click(forestPt.x, forestPt.y);
    await sleep(250);
    const sprouts = await countParts('p.color.g > 0.7 && p.color.r < 0.8');
    check('16d grow forest makes green sparkles', sprouts > 30, `green sparkles=${sprouts}`);
    const rainPt = await ev(() => __H.find((c, w) => w.biome[c] > 2));
    await clickBtn('#powerlist [data-power="rain"]');
    await page.mouse.click(rainPt.x, rainPt.y);
    const bolts = await ev(async () => {
      let n = 0;
      for (let i = 0; i < 80; i++) { await new Promise((r) => setTimeout(r, 100)); n = Math.max(n, game.renderer.scene.children.filter((o) => o.type === 'Line').length); if (n) break; }
      return n;
    });
    check('16e rain storms show lightning', bolts > 0, `lightning bolts seen=${bolts}`);
  } catch (e) { check('16 power effects', false, e.message); }

  // ============================================================ final
  check('13 no console errors / pageerrors during the whole run', errors.length === 0, errors.slice(0, 5).join(' | '));

  await browser.close();
  server.stop();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log('Screenshots:\n  ' + shots.join('\n  '));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
