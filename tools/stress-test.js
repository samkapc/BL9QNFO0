/*
 * Headless stress test for the coordination core.
 *   node tools/stress-test.js [hours=2] [seeds=6] [layout=bay-01]
 * Layouts: bay-01 (instance 1), bay-02 (instance 2).
 * Fails (exit 1) on any collision or on a robot stuck for more than 45 s.
 */
'use strict';
globalThis.WH_LAYOUT = process.argv[4] || 'bay-01';
require('../js/world.js');
console.log('layout', globalThis.WH.world.id, '·', globalThis.WH.world.kind);
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
  let maxWait = 0;
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
      const busy = r.v > 1 || r.motion === 'rotate' || r.mode === 'loading' || r.mode === 'unloading' || r.mode === 'idle';
      if (busy) stuck[k].since = sim.t;
      const d = sim.t - stuck[k].since;
      if (d > stuck[k].max) { stuck[k].max = d; stuck[k].at = sim.t; }
      if (r.mode === 'idle') idle[k] += DT;
    });
    for (const h of sim.humans) if (h.waitT > maxWait) maxWait = h.waitT;
  }
  return { sim, stuck, idle, maxWait };
}

const counts = {};
let failed = false;
for (let s = 1; s <= seeds; s++) {
  for (const chaos of [false, true]) {
    const { sim, stuck, idle, maxWait } = run(s * 7919, chaos);
    const st = sim.stats;
    for (const ev of sim.events) counts[ev.type] = (counts[ev.type] || 0) + 1;
    const maxStuck = Math.max(...stuck.map((x) => x.max));
    const perHour = (st.deliveries / hours).toFixed(0);
    console.log(
      `seed ${String(s * 7919).padStart(5)} ${chaos ? 'chaos' : 'calm '} | deliveries ${String(st.deliveries).padStart(4)} (${perHour}/h)` +
      ` | collisions ${st.collisions} | yields ${st.yields} | resolved ${st.conflicts} | reroutes ${st.reroutes}` +
      ` | negotiations ${st.negotiations} | deadlocks ${st.deadlocks} | minSep ${st.minSep.toFixed(1)}` +
      ` | max stall ${maxStuck.toFixed(1)} s @${stuck.map((x) => x.at.toFixed(0)).join('/')} | idle ${idle.map((x) => (100 * x / (hours * 3600)).toFixed(1) + '%').join(' ')}` +
      ` | people ${sim.humans.length}: ped stops ${st.pedStops}, kerb waits ${st.pedWaits || 0}, max kerb wait ${maxWait.toFixed(1)} s, closest ${isFinite(st.minPedSep) ? st.minPedSep.toFixed(1) : '-'}`
    );
    if (st.collisions > 0 || maxStuck > 45) failed = true;
  }
}
console.log(failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);
