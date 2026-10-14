// Wires world, sim, renderer and UI together and runs the game loop.
import { generateWorld, worldHash } from './world.js?v=mv80ti6g';
import { createSim, step } from './sim.js?v=mv80ti6g';
import { applyPower, POWERS, POWER_BY_ID } from './powers.js?v=mv80ti6g';
import { Renderer } from './render.js?v=mv80ti6g';
import { UI, randomSeed } from './ui.js?v=mv80ti6g';

const params = new URLSearchParams(location.search);
const TICKS_PER_SPEED = 4; // ticks per second at speed 1

const game = {
  state: null, power: null, hover: -1, selected: null, speed: 1,
  renderer: new Renderer(document.getElementById('globe')),
  newWorld(seed) {
    seed = String(seed);
    this.state = createSim(generateWorld(seed), seed);
    this.selected = null;
    this.renderer.setState(this.state);
    this.ui.setSeed(seed);
    this.ui.lastLogLen = -1;
    this.ui.update();
    const u = new URL(location.href); u.searchParams.set('seed', seed);
    history.replaceState(null, '', u);
  },
  setSpeed(s) { this.speed = s; this.ui.setSpeed(s); },
  setPower(id) {
    this.power = id;
    this.ui.setPower(id);
    this.renderer.canvas.classList.toggle('aiming', !!id);
    if (id) this.ui.toast(`${POWER_BY_ID[id].icon} ${POWER_BY_ID[id].name}: click the globe`);
    this.updateCursor();
  },
  selectTribe(id) { this.selected = id; this.ui.update(); },
  // Use a power like the player would (with the meteor fall animation).
  usePower(id, cell, done) {
    if (cell < 0) return;
    if (id === 'meteor') {
      const st = this.state;
      this.renderer.playMeteor(cell, () => {
        if (this.state !== st) return; // world was replaced mid-flight
        const r = applyPower(this.state, id, cell);
        this.ui.toast(r.msg);
        this.renderer.sync();
        this.ui.update();
        done?.(r);
      });
      return;
    }
    const r = applyPower(this.state, id, cell);
    this.ui.toast(r.msg);
    this.renderer.sync();
    this.ui.update();
    done?.(r);
    return r;
  },
  updateCursor() {
    const p = this.power ? POWER_BY_ID[this.power] : null;
    this.renderer.setCursor(this.hover, p ? p.radius : 0.02, p ? 0xffd84a : 0xffffff);
  },
  step(n = 1) { for (let i = 0; i < n; i++) step(this.state); this.renderer.sync(); this.ui.update(); },
  worldHash() { return worldHash(this.state.world); },
  pick(x, y) { return this.renderer.pick(x, y); },
  project(c) { return this.renderer.project(c); },
};
game.ui = new UI(game);
window.game = game;

// --- input
const canvas = game.renderer.canvas;
let down = null, idleTimer = null;
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, b: e.button }; });
canvas.addEventListener('pointermove', (e) => {
  game.hover = game.renderer.pick(e.clientX, e.clientY);
  game.updateCursor();
});
canvas.addEventListener('pointerleave', () => { game.hover = -1; game.updateCursor(); });
canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const button = down.b;
  down = null;
  if (moved > 6) return;
  if (button === 2) { game.setPower(null); return; }
  const cell = game.renderer.pick(e.clientX, e.clientY);
  if (game.power) game.usePower(game.power, cell);
  else { game.selected = null; game.ui.update(); }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
game.renderer.controls.addEventListener('start', () => {
  game.renderer.controls.autoRotate = false;
  clearTimeout(idleTimer);
});
game.renderer.controls.addEventListener('end', () => {
  clearTimeout(idleTimer);
  if (params.get('rotate') !== '0') idleTimer = setTimeout(() => { game.renderer.controls.autoRotate = true; }, 12000);
});
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') game.setPower(null);
  else if (e.key === ' ') { e.preventDefault(); game.setSpeed(game.speed === 0 ? 1 : 0); }
  else if (/^[1-9]$/.test(e.key) && POWERS[+e.key - 1]) {
    const id = POWERS[+e.key - 1].id;
    game.setPower(game.power === id ? null : id);
  }
});

// --- start
const seed = params.get('seed') || randomSeed();
if (params.get('rotate') === '0') game.renderer.controls.autoRotate = false;
if (params.get('pixel')) game.renderer.setPixelSize(params.get('pixel') === 'auto' ? 'auto' : Math.max(1, +params.get('pixel')));
game.ui.setPixelMode(game.renderer.pixelMode);
game.newWorld(seed);
game.setSpeed(params.has('speed') ? +params.get('speed') : 1);

// --- loop
let last = performance.now(), acc = 0, syncT = 0, uiT = 0, dirty = false;
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt * game.speed * TICKS_PER_SPEED;
  let n = 0;
  while (acc >= 1 && n < 30) { step(game.state); acc -= 1; n++; dirty = true; }
  if (n >= 30) acc = 0;
  syncT += dt; uiT += dt;
  if (dirty && syncT > 0.15) { game.renderer.sync(); syncT = 0; dirty = false; }
  if (uiT > 0.3) { game.ui.update(); uiT = 0; }
  game.renderer.frame(dt);
  game.ui.updateLabels();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
