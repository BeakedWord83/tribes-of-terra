// DOM panels: powers, tribes, chronicle, inspector, toast.
import { BIOME_NAMES, BLD_NAMES, isWater } from './world.js?v=mv80qc5d';
import { AGES, yearOf, fertEff, strength } from './sim.js?v=mv80qc5d';
import { POWERS } from './powers.js?v=mv80qc5d';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rgb = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
const fmt = (n) => (n >= 10000 ? (n / 1000).toFixed(0) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : Math.round(n).toString());
const AGE_ICON = ['🪨', '🏺', '🛡️'];

export class UI {
  constructor(game) {
    this.game = game;
    this.lastLogLen = -1;
    this.lastLogTick = -1;
    this.buildPowers();
    $('speed').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) game.setSpeed(+b.dataset.speed);
    });
    $('newworld').addEventListener('click', () => game.newWorld($('seed').value.trim() || randomSeed()));
    $('randworld').addEventListener('click', () => { const s = randomSeed(); $('seed').value = s; game.newWorld(s); });
    $('seed').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('newworld').click(); e.stopPropagation(); });
    $('tribelist').addEventListener('click', (e) => {
      const row = e.target.closest('.tribe');
      if (!row) return;
      const t = game.state.tribes[+row.dataset.id];
      game.selectTribe(t.id);
      game.renderer.flyTo(t.capital, 1.45);
    });
    $('pixmode').addEventListener('click', () => {
      const order = ['auto', 3, 1];
      const next = order[(order.indexOf(game.renderer.pixelMode) + 1) % order.length];
      game.renderer.setPixelSize(next);
      this.setPixelMode(next);
    });
    $('labels').addEventListener('click', (e) => {
      const el = e.target.closest('.lbl');
      if (!el) return;
      const t = game.state.tribes[+el.dataset.id];
      game.selectTribe(t.id);
      game.renderer.flyTo(t.capital, 1.45);
    });
    this.labelEls = new Map();
    $('loglist').addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (li && +li.dataset.cell >= 0) game.renderer.flyTo(+li.dataset.cell);
    });
  }

  buildPowers() {
    $('powerlist').innerHTML = POWERS.map((p, i) =>
      `<button data-power="${p.id}" title="${esc(p.desc)}"><span class="ico">${p.icon}</span><span class="nm">${esc(p.name)}</span><span class="key">${i + 1}</span></button>`).join('');
    $('powerlist').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) this.game.setPower(this.game.power === b.dataset.power ? null : b.dataset.power);
    });
  }

  setPower(id) {
    for (const b of $('powerlist').querySelectorAll('button')) b.classList.toggle('on', b.dataset.power === id);
  }

  setSpeed(s) {
    for (const b of $('speed').querySelectorAll('button')) b.classList.toggle('on', +b.dataset.speed === s);
  }

  setSeed(seed) { $('seed').value = seed; }

  setPixelMode(m) {
    $('pixmode').textContent = 'Pixels: ' + (m === 'auto' ? 'Auto' : m === 1 ? 'Sharp' : 'Retro');
  }

  // Tribe names floating over their capitals.
  updateLabels() {
    const s = this.game.state, r = this.game.renderer;
    if (this.labelState !== s) {
      for (const el of this.labelEls.values()) el.remove();
      this.labelEls.clear();
      this.labelState = s;
    }
    const W = window.innerWidth, H = window.innerHeight;
    for (const t of s.tribes) {
      let el = this.labelEls.get(t.id);
      if (!t.alive) { if (el) { el.remove(); this.labelEls.delete(t.id); } continue; }
      if (!el) {
        el = document.createElement('div');
        el.className = 'lbl';
        el.dataset.id = t.id;
        el.style.color = rgb(t.color);
        $('labels').appendChild(el);
        this.labelEls.set(t.id, el);
      }
      const p = r.project(t.capital);
      const vis = p && p.x > 0 && p.y > 0 && p.x < W && p.y < H;
      el.style.display = vis ? '' : 'none';
      if (!vis) continue;
      const txt = `${AGE_ICON[t.tech]} ${t.name}${t.enemies.size ? ' ⚔️' : ''}`;
      if (el.textContent !== txt) el.textContent = txt;
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%) translateY(-14px)`;
    }
  }

  toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  update() {
    const s = this.game.state;
    const { year, month } = yearOf(s.tick);
    $('date').textContent = `Year ${year} · Month ${month}`;
    this.updateTribes();
    this.updateLog();
    this.updateInspect();
  }

  updateTribes() {
    const s = this.game.state;
    const alive = s.tribes.filter((t) => t.alive);
    $('tribecount').textContent = `(${alive.length})`;
    const sorted = [...alive].sort((a, b) => b.pop - a.pop);
    const dead = s.tribes.filter((t) => !t.alive).slice(-4).reverse();
    const sel = this.game.selected;
    $('tribelist').innerHTML = [...sorted, ...dead].map((t) => {
      const tags = [];
      if (t.enemies.size) tags.push(`⚔️${t.enemies.size}`);
      if (t.allies.size) tags.push(`🤝${t.allies.size}`);
      if (t.plague > 0) tags.push('☠️');
      if (t.blessed > 0) tags.push('✨');
      return `<div class="tribe${t.alive ? '' : ' dead'}${t.id === sel ? ' sel' : ''}" data-id="${t.id}">
        <div class="sw" style="background:${rgb(t.color)}"></div>
        <div class="nm">${esc(t.name)}</div>
        <div class="tags">${t.alive ? tags.join(' ') : 'fallen'}</div>
        <div class="st">${AGE_ICON[t.tech]} pop ${fmt(t.pop)} · land ${t.cells.size}</div>
      </div>`;
    }).join('');
  }

  updateLog() {
    const s = this.game.state;
    const last = s.log[s.log.length - 1];
    if (s.log.length === this.lastLogLen && last?.tick === this.lastLogTick) return;
    this.lastLogLen = s.log.length; this.lastLogTick = last?.tick;
    $('loglist').innerHTML = s.log.slice(-40).reverse().map((l) =>
      `<li class="k-${l.kind}" data-cell="${l.cell}"><span class="yr">Y${yearOf(l.tick).year}</span>${esc(l.text)}</li>`).join('');
  }

  updateInspect() {
    const g = this.game, s = g.state, w = s.world;
    if (g.selected != null && s.tribes[g.selected]) {
      const t = s.tribes[g.selected];
      const names = (set) => [...set].map((id) => s.tribes[id]).filter(Boolean).map((o) => `<span style="color:${rgb(o.color)}">${esc(o.name)}</span>`).join(', ') || '—';
      $('inspect').innerHTML = `
        <div class="title" style="color:${rgb(t.color)}">The ${esc(t.name)} ${t.alive ? '' : '(fallen)'}</div>
        <div class="row"><b>Age</b><span>${AGE_ICON[t.tech]} ${AGES[t.tech]}</span></div>
        <div class="row"><b>People</b><span>${fmt(t.pop)} / ${fmt(t.housing)} homes</span></div>
        <div class="row"><b>Land</b><span>${t.cells.size} tiles</span></div>
        <div class="row"><b>Food</b><span>${fmt(t.food)} (${t.foodRate >= 0 ? '+' : ''}${t.foodRate.toFixed(1)}/mo)</span></div>
        <div class="row"><b>Wood · Stone · Ore</b><span>${fmt(t.wood)} · ${fmt(t.stone)} · ${fmt(t.ore)}</span></div>
        <div class="row"><b>Army</b><span>${fmt(t.soldiers)} (power ${fmt(strength(t))})</span></div>
        <div class="row"><b>Temper</b><span>${t.aggression > 0.7 ? 'Warlike' : t.aggression > 0.4 ? 'Proud' : 'Peaceful'}</span></div>
        <div class="row"><b>Allies</b><span>${names(t.allies)}</span></div>
        <div class="row"><b>At war with</b><span>${names(t.enemies)}</span></div>
        <div class="row"><b></b><span style="color:var(--dim)">click the globe to close</span></div>`;
      return;
    }
    const c = g.hover;
    if (c == null || c < 0) {
      $('inspect').innerHTML = '<div class="title">Inspector</div><div style="color:var(--dim)">Point at the world to see a tile. Click a tribe to see its people.</div>';
      return;
    }
    const o = w.owner[c] >= 0 ? s.tribes[w.owner[c]] : null;
    const bar = (v, col = '#6fbf4a') => `<div class="bar"><i style="width:${Math.round(Math.max(0, Math.min(1, v)) * 100)}%;background:${col}"></i></div>`;
    const water = isWater(w.biome[c]);
    const weather = w.wet[c] > 0.15 ? '🌧️ Wet' : w.wet[c] < -0.15 ? '☀️ Dry' : 'Calm';
    $('inspect').innerHTML = `
      <div class="title">${BIOME_NAMES[w.biome[c]]}${w.fire[c] ? ' 🔥' : ''}</div>
      <div class="row"><b>Owner</b><span>${o ? `<span style="color:${rgb(o.color)}">${esc(o.name)}</span>` : 'Nobody'}</span></div>
      ${water ? '' : `<div class="row"><b>Height</b><span>${w.level[c]}</span></div>
      <div class="row"><b>Building</b><span>${BLD_NAMES[w.bld[c]]}</span></div>
      <div class="row"><b>Trees</b><span>${Math.round(w.trees[c] * 100)}%</span></div>${bar(w.trees[c], '#2f7a2a')}
      <div class="row"><b>Fertility</b><span>${Math.round(fertEff(w, c) * 100)}%</span></div>${bar(fertEff(w, c), '#d9b443')}
      <div class="row"><b>Stone · Ore</b><span>${Math.round(w.stone[c] * 100)}% · ${Math.round(w.ore[c] * 100)}%</span></div>`}
      <div class="row"><b>Weather</b><span>${weather}</span></div>`;
  }
}

export function randomSeed() {
  const words = ['amber', 'basalt', 'cedar', 'dune', 'ember', 'fjord', 'glacier', 'harbor', 'iris', 'jade', 'kelp', 'lumen', 'mesa', 'nectar', 'onyx', 'pine', 'quartz', 'reef', 'sable', 'tundra', 'umber', 'vale', 'willow', 'zephyr'];
  return words[Math.floor(Math.random() * words.length)] + '-' + Math.floor(Math.random() * 1000);
}
