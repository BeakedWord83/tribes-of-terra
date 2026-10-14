# Tribes of Terra

A pixel civilization simulation on a 3D globe. You are a god.

**Play:** https://beakedword83.github.io/tribes-of-terra/

- The whole world is made from a seed: land, seas, climate, biomes, and the first tribes.
- Tribes farm, cut trees, mine stone and ore, build villages, grow, and spread.
- They advance from the Stone Age to the Bronze Age (boats, colonies) and the Iron Age.
- They make alliances, declare war, sign peace, split in civil wars, and fall.
- God powers: Spawn Tribe, Meteor, Rain, Drought, Grow Forest, Earthquake, Plague, Bless.

## Controls
- Drag: spin the globe. Scroll: zoom.
- Pick a power (or press 1–8), then click the globe. Esc or right-click: cancel.
- Space: pause. Click a tribe or a chronicle line to fly there.
- Same seed = same world. URL: `?seed=amber-12`.

## Run locally
Browser only — no server code. Any static server works:

```
python3 -m http.server 8000
```

## Tests
```
npm install                 # dev only: playwright
npx playwright install chromium
node --test tests/sim.test.mjs   # simulation rules, headless
node tests/e2e.mjs               # real browser: clicks, powers, rendering
BASE_URL=https://beakedword83.github.io/tribes-of-terra/ node tests/e2e.mjs   # test the live site
```

Built with [three.js](https://threejs.org) (vendored in `vendor/`, MIT).
