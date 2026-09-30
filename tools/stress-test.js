/*
 * Headless stress test for the coordination core.
 *   node tools/stress-test.js [hours=2] [seeds=6] [layout=bay-01]
 * Layouts: bay-01 (instance 1), bay-02 (instance 2), or a generated grid as created from the
 * Instances page, e.g. grid:aisles=5,rows=4,docks=n,faces=both,robots=5,dockWorkers=3,aisleWalkers=2
 * (add uncapped=1 to try more robots than the create form allows for that grid).
 * Fails (exit 1) on any collision, on a robot stuck for more than 45 s, or on a person standing
 * still inside a lane for more than 3 s.
 */
'use strict';
const layoutArg = process.argv[4] || 'bay-01';
if (layoutArg.startsWith('grid:')) {
  const rec = { id: 'test', n: 9, name: 'Test grid', rev: 1 };
  for (const kv of layoutArg.slice(5).split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    rec[k] = /^\d+$/.test(v) ? Number(v) : v;
  }
  if (rec.uncapped) globalThis.WH_TEST_UNCAPPED = true;
  globalThis.WH_SPECS = [rec];
  globalThis.WH_LAYOUT = 'custom-test';
} else globalThis.WH_LAYOUT = layoutArg;
require('../js/store.js');
require('../js/world.js');
const Lw = globalThis.WH.world;
console.log('layout', Lw.id, '·', Lw.kind, '·', Lw.stations.length, 'stations ·', Lw.robots.length, 'robots ·',
  Lw.peds ? Lw.peds.walkers.length : 0, 'people', Lw.spec ? JSON.stringify(Lw.spec) : '');
require('../js/sim.js');
const WH = globalThis.WH;

const hours = Number(process.argv[2] || 2);
const seeds = Number(process.argv[3] || 6);
const DT = 1 / 60;

function run(seed, chaos) {
  const sim = new WH.Sim({ seed });
  const steps = Math.round((hours * 3600) / DT);
  const stuck = sim.robots.map(() => ({ since: 0, max: 0, at: 0 }));
  const idle = sim.robots.map(() => 0);
  let maxWait = 0, maxLane = 0;
  let nextChaos = 20;
  for (let i = 0; i < steps; i++) {
    sim.step(DT);
    if (chaos && sim.t >= nextChaos) {
      nextChaos = sim.t + 12 + sim.rand() * 18;
      const pool = WH.world.edges.filter((e) => e.kind !== 'spur');
      const e = pool[Math.floor(sim.rand() * pool.length)];
      sim.toggleObstruction(e.id);
    }
    sim.robots.forEach((r, k) => {
      const busy = r.v > 1 || (r.motion === 'rotate' && !r.rotHold) || r.mode === 'loading' || r.mode === 'unloading' || r.mode === 'idle';
      if (busy) stuck[k].since = sim.t;
      const d = sim.t - stuck[k].since;
      if (d > stuck[k].max) { stuck[k].max = d; stuck[k].at = sim.t; }
      if (r.mode === 'idle') idle[k] += DT;
    });
    for (const h of sim.humans) {
      if (h.waitT > maxWait) maxWait = h.waitT;
      // A person standing still inside a lane's swept path (not aside) would block robots
      const still = h.onLane && !h.clear && h.v < 1 && h.state !== 'dwell';
      h.stillT = still ? (h.stillT || 0) + DT : 0;
      if (h.stillT > maxLane) maxLane = h.stillT;
    }
  }
  return { sim, stuck, idle, maxWait, maxLane };
}

const counts = {};
let failed = false;
for (let s = 1; s <= seeds; s++) {
  for (const chaos of [false, true]) {
    const { sim, stuck, idle, maxWait, maxLane } = run(s * 7919, chaos);
    const st = sim.stats;
    for (const ev of sim.events) counts[ev.type] = (counts[ev.type] || 0) + 1;
    const maxStuck = Math.max(...stuck.map((x) => x.max));
    const perHour = (st.deliveries / hours).toFixed(0);
    console.log(
      `seed ${String(s * 7919).padStart(5)} ${chaos ? 'chaos' : 'calm '} | deliveries ${String(st.deliveries).padStart(4)} (${perHour}/h)` +
      ` | collisions ${st.collisions} | yields ${st.yields} | resolved ${st.conflicts} | reroutes ${st.reroutes}` +
      ` | negotiations ${st.negotiations} | deadlocks ${st.deadlocks} | minSep ${st.minSep.toFixed(1)}` +
      ` | max stall ${maxStuck.toFixed(1)} s @${stuck.map((x) => x.at.toFixed(0)).join('/')} | idle ${idle.map((x) => (100 * x / (hours * 3600)).toFixed(1) + '%').join(' ')}` +
      ` | people ${sim.humans.length}: ped stops ${st.pedStops}, kerb waits ${st.pedWaits}, box waits ${st.boxWaits}, asides ${st.laneAsides},` +
      ` turn holds ${st.rotHolds}, max wait ${maxWait.toFixed(1)} s, max still in lane ${maxLane.toFixed(1)} s, closest ${isFinite(st.minPedSep) ? st.minPedSep.toFixed(1) : '-'}`
    );
    if (st.collisions > 0 || maxStuck > 45 || maxLane > 3) failed = true;
  }
}
console.log(failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);
