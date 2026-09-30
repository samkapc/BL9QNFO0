/*
 * sim.js — decentralized multi-AMR coordination for the EdgeFleet digital twin.
 *
 * Every robot plans its own route and broadcasts it as an "intent" (directed corridor
 * segments with time windows). Shared space is claimed through peer-to-peer reservations:
 *   • before crossing a node a robot must hold the node AND the corridor segment after it;
 *   • corridor segments are single-track: robots may share one only in the same direction;
 *   • contested claims are negotiated by priority (payload > arrival time > waiting time);
 *   • robots that can take a cheaper detour re-plan instead of waiting;
 *   • wait-for cycles are detected and broken by the lowest-priority robot backing off.
 * A continuous safety envelope sits underneath as a last line of defence.
 *
 * DOM-free and seedable so it can be stress-tested headless (see tools/stress-test.js).
 */
(function (root) {
  'use strict';
  const WH = (root.WH = root.WH || {});
  const Wd = WH.world, G = WH.geom;

  const CFG = {
    vMax: 92,            // units/s (≈ 1.8 m/s)
    accel: 95,
    decel: 140,
    hardDecel: 420,
    latAcc: 90,          // cornering limit
    omegaMax: 2.4,       // rad/s, in-place rotation
    alpha: 6,
    L: 48, Wr: 34,       // robot footprint
    stopDist: 64,        // hold line distance before a node centre
    releaseDist: 64,     // node lock released once this far past it
    entryGap: 140,       // same-direction spacing needed to enter a corridor
    safeDist: 62,        // safety envelope (centre to centre)
    reqRange: 120,       // reservations requested this far before the hold line
    fillet: 26,
    dockSpeed: 34,
    transferTime: 2.1,
    idleDelay: 0.8,
    humanR: 11.5,        // person body radius (≈ 0.46 m shoulder width)
    pedSafe: 40,         // protective field against people (path to person)
    pedWarn: 58,         // warning field: slow down when a person is this close to the path
    pedSlow: 50,         // speed cap inside the warning field (≈ 1 m/s)
    crossClear: 42,      // a crosswalk is clear when no robot is within this distance of it
    pedKeep: 12,         // people walking a shared aisle keep a little right of the centre line
    pedAside: 40,        // ... and step aside to this offset (the lane edge) to let a robot by
    pedStep: 75,         // sideways stepping speed
    pedSee: 46,          // people step aside for a robot whose path comes within this distance
    pedPass: 34,         // robots pass a person standing aside if the path stays this far away
    pedCreep: 30,        // passing speed next to a person in a shared aisle (0.6 m/s)
    boxLen: 58,          // people wait this far before a robot intersection until it is clear
    rotClear: 43,        // a robot holds an in-place turn while a person is this close
    unitsPerM: Wd.UNITS_PER_M,
  };

  // Fleet and task flows come with the layout (instance)
  const ROBOT_DEFS = Wd.robots;

  const OBSTACLE_REASONS = ['stray pallet', 'spill clean-up', 'manual forklift at work', 'pedestrian crossing'];

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const sameNodes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  function turnCost(prev, node, to) {
    if (!prev) return 0;
    const P = Wd.nodeMap[prev], N = Wd.nodeMap[node], T = Wd.nodeMap[to];
    const d = Math.abs(G.angDiff(Math.atan2(T.y - N.y, T.x - N.x), Math.atan2(N.y - P.y, N.x - P.x)));
    return d < 0.1 ? 0 : 0.55 * (d / (Math.PI / 2));
  }

  function footprint(r) {
    const c = Math.cos(r.h), s = Math.sin(r.h), hl = CFG.L / 2, hw = CFG.Wr / 2;
    return [
      [r.x + c * hl - s * hw, r.y + s * hl + c * hw],
      [r.x + c * hl + s * hw, r.y + s * hl - c * hw],
      [r.x - c * hl + s * hw, r.y - s * hl - c * hw],
      [r.x - c * hl - s * hw, r.y - s * hl + c * hw],
    ];
  }
  function pointSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  }
  function segsDist(px, py, segs) {
    let d = Infinity;
    for (const g of segs) d = Math.min(d, pointSeg(px, py, g[0], g[1], g[2], g[3]));
    return d;
  }
  /** Distance from a point to a robot's rectangular footprint (0 when inside). */
  function footprintDist(r, px, py) {
    const c = Math.cos(r.h), s = Math.sin(r.h), dx = px - r.x, dy = py - r.y;
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    const ex = Math.max(0, Math.abs(lx) - CFG.L / 2), ey = Math.max(0, Math.abs(ly) - CFG.Wr / 2);
    return Math.hypot(ex, ey);
  }
  function obbOverlap(a, b) {
    const A = footprint(a), B = footprint(b);
    for (const ang of [a.h, a.h + Math.PI / 2, b.h, b.h + Math.PI / 2]) {
      const ax = Math.cos(ang), ay = Math.sin(ang);
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const p of A) { const d = p[0] * ax + p[1] * ay; if (d < amin) amin = d; if (d > amax) amax = d; }
      for (const p of B) { const d = p[0] * ax + p[1] * ay; if (d < bmin) bmin = d; if (d > bmax) bmax = d; }
      if (amax < bmin || bmax < amin) return false;
    }
    return true;
  }

  const tmp = { x: 0, y: 0, h: 0 };

  class Sim {
    constructor(opts) {
      opts = opts || {};
      this.cfg = CFG;
      this.seed = opts.seed != null ? opts.seed >>> 0 : (Math.random() * 4294967296) >>> 0;
      this.rand = mulberry32(this.seed);
      this.t = 0;
      this.autoObstructions = opts.autoObstructions !== false;
      this.nodeHolder = Object.create(null);
      this.edgeHold = Object.create(null);
      this.obstructions = Object.create(null);
      this.stations = Object.create(null);
      for (const s of Wd.stations) this.stations[s.id] = { id: s.id, def: s, obj: null, res: null };
      this.tasks = [];
      this.pending = [];
      this.taskSeq = 0;
      this.events = [];
      this.eventSeq = 0;
      this.recent = Object.create(null);
      this.fx = { links: [], rings: [], marks: [], ghosts: [], taskLinks: [], edges: [] };
      this.stats = {
        deliveries: 0, collisions: 0, conflicts: 0, yields: 0, reroutes: 0,
        negotiations: 0, deadlocks: 0, minSep: Infinity, tasksCreated: 0, pedStops: 0, minPedSep: Infinity,
        pedWaits: 0, laneAsides: 0, boxWaits: 0, rotHolds: 0,
      };
      this.negotiated = Object.create(null);
      this.nextIntent = 0.6;
      this.nextTaskT = 0.3;
      this.nextObsT = 28 + this.rand() * 10;
      this.deadlockCD = 0;
      this.contacts = new Set();
      this.robots = ROBOT_DEFS.map((d, i) => this.makeRobot(d, i));
      this.humans = ((Wd.peds && Wd.peds.walkers) || []).map((d, i) => this.makeHuman(d, i));
      this.emit('system', [`Session started: ${this.robots.length} robot${this.robots.length === 1 ? '' : 's'} connected, ${Wd.stations.length} stations loaded`]);
    }

    makeRobot(d, i) {
      const st = Wd.stationMap[d.start];
      const r = {
        i, id: d.id, color: d.color,
        x: st.x, y: st.y, h: Math.atan2(st.dir.y, st.dir.x), v: 0, w: 0,
        mode: 'idle', motion: 'parked', station: st.id, prev: st.id,
        route: null, s: 0, targetH: 0, arrived: false,
        task: null, carrying: false,
        held: { nodes: new Set(), edges: new Set() },
        block: null, waitAcc: 0, follow: -1,
        timer: 0.5 + i * 0.9,
        deliveries: 0, odo: 0, legOdo: 0,
        replanCD: 0, lastReroute: -99, rerouteText: '', pendingReplan: null, needRoute: false,
        expectHold: null,
        beacon: 0.4 + i * 0.8,
        humanStop: -1, humanNear: false, humanPass: false, pedCap: Infinity, rotHold: false,
      };
      this.holdNode(r, st.id);
      return r;
    }

    // ------------------------------------------------------------------ events & fx
    emit(type, parts, key, gap) {
      if (key) {
        const last = this.recent[key];
        if (last != null && this.t - last < (gap || 6)) return null;
        this.recent[key] = this.t;
      }
      const ev = { id: ++this.eventSeq, t: this.t, type, parts };
      this.events.push(ev);
      if (this.events.length > 160) this.events.splice(0, this.events.length - 160);
      return ev;
    }
    fxLink(a, b, kind, chipA, chipB, dur) {
      this.fx.links.push({ a, b, kind, chipA, chipB, t0: this.t, dur: dur || 2.4 });
    }

    // ------------------------------------------------------------------ locks
    holdNode(r, n) { this.nodeHolder[n] = r.i; r.held.nodes.add(n); }
    releaseNode(r, n) {
      if (this.nodeHolder[n] === r.i) delete this.nodeHolder[n];
      r.held.nodes.delete(n);
    }
    holdEdge(r, e, to) {
      let eh = this.edgeHold[e.id];
      if (!eh) eh = this.edgeHold[e.id] = { to, set: new Set() };
      if (eh.set.size === 0) eh.to = to;
      eh.set.add(r.i);
      r.held.edges.add(e.id);
    }
    releaseEdge(r, eid) {
      const eh = this.edgeHold[eid];
      if (eh) { eh.set.delete(r.i); if (!eh.set.size) delete this.edgeHold[eid]; }
      r.held.edges.delete(eid);
    }
    edgeHeld(eid) { const eh = this.edgeHold[eid]; return !!(eh && eh.set.size); }

    // ------------------------------------------------------------------ main step
    step(dt) {
      this.t += dt;
      this.updateObstructions();
      this.updateStations();
      this.updateTasks();
      for (const r of this.robots) this.updateMode(r, dt);
      if (this.t >= this.nextIntent) { this.nextIntent = this.t + 0.3; this.intentCheck(); }
      this.arbitrate();
      this.handleWaits(dt);
      this.updateHumans(dt);
      for (const r of this.robots) this.move(r, dt);
      for (const r of this.robots) this.progress(r);
      this.checkSafety();
      this.updateFx();
    }

    updateMode(r, dt) {
      r.replanCD = Math.max(0, r.replanCD - dt);
      r.beacon -= dt;
      if (r.beacon <= 0) {
        r.beacon = 2.6 + this.rand() * 0.8;
        this.fx.rings.push({ kind: 'beacon', x: r.x, y: r.y, t0: this.t, dur: 1.9, color: r.color });
      }
      switch (r.mode) {
        case 'idle':
          r.timer -= dt;
          break;
        case 'loading':
        case 'unloading':
          r.timer += dt;
          if (r.timer >= CFG.transferTime) this.finishTransfer(r);
          break;
        default:
          if (r.needRoute) { if (r.replanCD <= 0) { r.replanCD = 1; this.startLeg(r); } break; }
          if (r.pendingReplan && this.canReplan(r)) {
            const p = r.pendingReplan;
            r.pendingReplan = null;
            this.applyReroute(r, p);
          }
          if (r.route && r.arrived) this.arrive(r);
      }
    }

    // ------------------------------------------------------------------ stations & tasks
    updateStations() {
      for (const id in this.stations) {
        const st = this.stations[id];
        if (st.obj && st.obj.state === 'delivered' && this.t - st.obj.t0 > 3.6) st.obj = null;
      }
    }

    stationFree(id) {
      const st = this.stations[id];
      if (st.res || st.obj) return false;
      if (this.nodeHolder[id] !== undefined) return false;
      for (const r of this.robots) {
        if (r.station === id) return false;
        if (r.route && r.route.goal === id) return false;
      }
      return true;
    }

    pickWeighted(list, wf) {
      let tot = 0;
      for (const it of list) tot += wf(it);
      let x = this.rand() * tot;
      for (const it of list) { x -= wf(it); if (x <= 0) return it; }
      return list[list.length - 1];
    }

    createTask() {
      const free = Wd.stations.filter((s) => this.stationFree(s.id));
      if (free.length < 2) return null;
      const zone = (z) => free.filter((s) => s.zone === z);
      const flows = Wd.flows
        .map((f) => ({ w: f.w, from: zone(f.from), to: zone(f.to) }))
        .filter((f) => f.from.length && f.to.some((s) => f.from.some((p) => p !== s)));
      if (!flows.length) return null;
      const flow = this.pickWeighted(flows, (f) => f.w);
      const fromList = flow.from.filter((p) => flow.to.some((s) => s !== p));
      const p = fromList[Math.floor(this.rand() * fromList.length)];
      const d = this.pickWeighted(flow.to.filter((s) => s !== p),
        (s) => 0.25 + Math.pow(Math.hypot(s.x - p.x, s.y - p.y) / 400, 1.4));
      const task = {
        id: 'T-' + (1000 + ++this.taskSeq),
        pickup: p.id, drop: d.id, state: 'pending', robot: -1, created: this.t, preview: null,
      };
      this.tasks.push(task);
      this.pending.push(task);
      this.stats.tasksCreated++;
      this.stations[p.id].res = task.id;
      this.stations[d.id].res = task.id;
      this.stations[p.id].obj = { state: 'waiting', task: task.id, t0: this.t };
      this.emit('task', ['Task ', { task: task.id }, ' created: ', { s: p.id }, ' → ', { s: d.id }]);
      this.fx.rings.push({ kind: 'spawn', x: p.stand.x, y: p.stand.y, t0: this.t, dur: 1.4, color: '#e8b46a' });
      return task;
    }

    updateTasks() {
      if (this.t >= this.nextTaskT && this.pending.length < 2) {
        this.nextTaskT = this.t + (this.createTask() ? 1.2 + this.rand() * 1.6 : 0.6);
      }
      const ready = this.robots.filter((r) => r.mode === 'idle' && r.timer <= 0);
      if (!ready.length || !this.pending.length) return;
      let best = null;
      for (const r of ready) {
        for (const task of this.pending) {
          const plan = this.planFrom(r, task.pickup, { noIntent: true });
          if (plan && (!best || plan.cost < best.bid)) best = { r, task, bid: plan.cost };
        }
      }
      if (best) this.assign(best.r, best.task, best.bid);
    }

    assign(r, task, bid) {
      this.pending.splice(this.pending.indexOf(task), 1);
      task.state = 'assigned';
      task.robot = r.i;
      task.assignedAt = this.t;
      task.preview = this.previewPath(task.pickup, task.drop);
      r.task = task;
      r.mode = 'toPickup';
      this.emit('claim', ['Task ', { task: task.id }, ' assigned to ', { r: r.i }, ` (lowest bid, ${bid.toFixed(1)} s)`]);
      this.fx.taskLinks.push({ robot: r.i, station: task.pickup, t0: this.t, dur: 1.8 });
      this.startLeg(r);
    }

    startLeg(r) {
      const goal = r.mode === 'toPickup' ? r.task.pickup : r.task.drop;
      const plan = this.planFrom(r, goal, {});
      if (!plan) { r.needRoute = true; return; }
      r.needRoute = false;
      const naive = this.planFrom(r, goal, { noIntent: true });
      const stId = r.station;
      this.holdEdge(r, Wd.edgeBetween(stId, plan.nodes[0]), plan.nodes[0]);
      r.station = null;
      r.legOdo = r.odo;
      this.setRoute(r, plan, 0);
      this.fx.rings.push({ kind: 'intent', x: r.x, y: r.y, t0: this.t, dur: 1.5, color: r.color });
      if (naive && !sameNodes(naive.nodes, plan.nodes)) this.explainPlan(r, plan, naive);
    }

    /** A freshly planned route differs from the shortest one: say whose intent it avoided. */
    explainPlan(r, plan, naive) {
      const intents = this.collectIntents(r);
      let prev = r.prev, t = 1.2, cause = null, causeEdge = null;
      for (const n of naive.nodes) {
        const e = Wd.edgeBetween(prev, n);
        const tEnd = t + e.len / CFG.vMax;
        for (const it of intents) {
          if (it.eid === e.id && it.to !== n && t < it.tOut + 1.5 && it.tIn < tEnd + 1.5) { cause = it.robot; causeEdge = e.id; break; }
        }
        if (cause != null) break;
        t = tEnd; prev = n;
      }
      if (cause == null) return;
      const via = this.viaEdge(plan.nodes, naive.nodes, r.prev);
      this.stats.negotiations++;
      this.emit('negotiate', [{ r: r.i }, ' planned via ', { e: via }, ' to avoid ', { r: cause }, ' on ', { e: causeEdge }],
        'plan|' + r.i, 3);
      this.fxLink(cause, r.i, 'intent', 'Intent: ' + this.edgeName(causeEdge), 'Route via ' + this.edgeName(via), 2.6);
    }

    arrive(r) {
      const goal = r.route.goal;
      r.route = null;
      r.arrived = false;
      r.station = goal;
      r.motion = 'parked';
      r.v = 0;
      r.timer = 0;
      r.block = null;
      r.mode = r.mode === 'toPickup' ? 'loading' : 'unloading';
    }

    finishTransfer(r) {
      const task = r.task;
      if (r.mode === 'loading') {
        r.carrying = true;
        task.state = 'picked';
        task.pickedAt = this.t;
        const st = this.stations[task.pickup];
        st.obj = null;
        st.res = null;
        this.emit('pickup', [{ r: r.i }, ' picked up payload at ', { s: task.pickup }, ' (', { task: task.id }, ')']);
        r.mode = 'toDrop';
        this.startLeg(r);
      } else {
        r.carrying = false;
        task.state = 'done';
        task.doneAt = this.t;
        const st = this.stations[task.drop];
        st.obj = { state: 'delivered', t0: this.t, task: task.id };
        st.res = null;
        r.deliveries++;
        this.stats.deliveries++;
        this.emit('deliver', ['Task ', { task: task.id }, ' completed by ', { r: r.i }, ' at ', { s: task.drop },
          ` in ${(this.t - task.assignedAt).toFixed(1)} s`]);
        this.fx.rings.push({ kind: 'done', x: st.def.x, y: st.def.y, t0: this.t, dur: 1.4, color: '#4ade9b' });
        this.tasks.splice(this.tasks.indexOf(task), 1);
        r.task = null;
        r.mode = 'idle';
        r.timer = CFG.idleDelay;
      }
    }

    // ------------------------------------------------------------------ planning
    intentsOf(q, maxEdges) {
      const out = [];
      if (!q.route) return out;
      const R = q.route;
      let prev = q.prev, t = q.motion === 'rotate' ? 1.0 : 0, sPrev = q.s;
      for (let k = R.idx; k < R.nodes.length && out.length < (maxEdges || 6); k++) {
        const n = R.nodes[k];
        const e = Wd.edgeBetween(prev, n);
        const d = Math.max(0, R.nodeS[k] - sPrev) / (CFG.vMax * 0.85);
        out.push({ robot: q.i, eid: e.id, from: prev, to: n, tIn: t, tOut: t + d, held: q.held.edges.has(e.id) });
        t += d; sPrev = R.nodeS[k]; prev = n;
      }
      return out;
    }
    collectIntents(r) {
      const all = [];
      for (const q of this.robots) if (q !== r) all.push(...this.intentsOf(q, 6));
      return all;
    }

    planCtx(r, opts) {
      opts = opts || {};
      const avoid = opts.avoid || null;
      const intents = opts.noIntent || !r ? [] : this.collectIntents(r);
      const heldEdges = r ? r.held.edges : new Set();
      return {
        edgeOK: (e) => {
          if (avoid && avoid.has(e.id)) return false;
          if (this.obstructions[e.id] && !heldEdges.has(e.id)) return false;
          return true;
        },
        penalty: (from, to, e, tArr) => {
          let p = 0;
          const tEnd = tArr + e.len / CFG.vMax;
          for (const it of intents) {
            if (it.eid === e.id) {
              if (it.to !== to) { if (tArr < it.tOut + 1.5 && it.tIn < tEnd + 1.5) p += it.held ? 6 : 2.6; }
              else p += 0.15;
            } else if (it.to === to && Math.abs(it.tOut - tEnd) < 1.2) p += 0.3;
          }
          return p;
        },
      };
    }

    dijkstra(starts, goal, ctx) {
      const best = new Map();
      const open = [];
      for (const s of starts) {
        const k = s.prev + '>' + s.node;
        const ex = best.get(k);
        if (ex && ex.cost <= s.cost) continue;
        const st = { prev: s.prev, node: s.node, cost: s.cost, parent: null, root: s };
        best.set(k, st);
        open.push(st);
      }
      while (open.length) {
        let bi = 0;
        for (let i = 1; i < open.length; i++) if (open[i].cost < open[bi].cost) bi = i;
        const cur = open[bi];
        open[bi] = open[open.length - 1];
        open.pop();
        if (best.get(cur.prev + '>' + cur.node) !== cur) continue;
        if (cur.node === goal) {
          const tail = [];
          let s = cur, rootS = null;
          while (s) { if (!s.parent) rootS = s.root; else tail.push(s.node); s = s.parent; }
          tail.reverse();
          return { nodes: rootS.path.concat(tail), cost: cur.cost, reverse: !!rootS.reverse };
        }
        const N = Wd.nodeMap[cur.node];
        for (const { to, e } of N.adj) {
          if (to === cur.prev) continue;
          if (Wd.nodeMap[to].kind === 'station' && to !== goal) continue;
          if (!ctx.edgeOK(e)) continue;
          const turn = turnCost(cur.prev, cur.node, to);
          const c = cur.cost + turn + e.len / CFG.vMax + ctx.penalty(cur.node, to, e, cur.cost + turn * 0.5);
          const k = cur.node + '>' + to;
          const ex = best.get(k);
          if (ex && ex.cost <= c) continue;
          const st = { prev: cur.node, node: to, cost: c, parent: cur };
          best.set(k, st);
          open.push(st);
        }
      }
      return null;
    }

    planFrom(r, goal, opts) {
      opts = opts || {};
      const ctx = this.planCtx(r, opts);
      const starts = [];
      if (!r.route || r.station) {
        const stId = r.station || r.prev;
        const n = Wd.nodeMap[stId];
        const { to: j, e } = n.adj[0];
        const J = Wd.nodeMap[j];
        const rot = Math.abs(G.angDiff(Math.atan2(J.y - n.y, J.x - n.x), r.h)) / 1.8;
        starts.push({ prev: stId, node: j, cost: rot + 0.4 + e.len / CFG.vMax, path: [j] });
      } else {
        const R = r.route;
        if (R.idx >= R.nodes.length) return null;
        const lastIdx = Math.min(R.nodes.length - 1, R.idx + R.granted);
        const prefix = R.nodes.slice(R.idx, lastIdx + 1);
        if (prefix[prefix.length - 1] === goal) return null;
        const prevOfLast = prefix.length > 1 ? prefix[prefix.length - 2] : r.prev;
        const rot = r.motion === 'rotate' ? 1.0 : 0;
        starts.push({
          prev: prevOfLast, node: prefix[prefix.length - 1],
          cost: rot + Math.max(0, R.nodeS[lastIdx] - r.s) / CFG.vMax, path: prefix,
        });
        if (opts.allowReverse && this.canReverse(r)) {
          const back = r.prev, P = Wd.nodeMap[back];
          starts.push({
            prev: R.nodes[R.idx], node: back, reverse: true, path: [back],
            cost: 2.2 + Math.hypot(P.x - r.x, P.y - r.y) / CFG.vMax,
          });
        }
      }
      return this.dijkstra(starts, goal, ctx);
    }

    routeCost(r, ctx) {
      const R = r.route;
      if (!R) return Infinity;
      let cost = r.motion === 'rotate' ? 1.0 : 0;
      let prevPrev = null, prev = r.prev, sPrev = r.s;
      const commitEnd = R.idx + R.granted;
      for (let k = R.idx; k < R.nodes.length; k++) {
        const n = R.nodes[k];
        const e = Wd.edgeBetween(prev, n);
        if (k <= commitEnd) cost += Math.max(0, R.nodeS[k] - sPrev) / CFG.vMax;
        else {
          if (!ctx.edgeOK(e)) return Infinity;
          const turn = turnCost(prevPrev, prev, n);
          cost += turn + e.len / CFG.vMax + ctx.penalty(prev, n, e, cost + turn * 0.5);
        }
        prevPrev = prev; prev = n; sPrev = R.nodeS[k];
      }
      return cost;
    }

    previewPath(from, to) {
      const n = Wd.nodeMap[from];
      const j = n.adj[0].to;
      const plan = this.dijkstra([{ prev: from, node: j, cost: 0, path: [j] }], to, this.planCtx(null, { noIntent: true }));
      return plan ? G.buildPath([n].concat(plan.nodes.map((id) => Wd.nodeMap[id])), CFG.fillet) : null;
    }

    setRoute(r, plan, granted) {
      const pts = [{ x: r.x, y: r.y }].concat(plan.nodes.map((id) => Wd.nodeMap[id]));
      const geo = G.buildPath(pts, CFG.fillet);
      r.route = {
        nodes: plan.nodes, geo, nodeS: geo.nodeS.slice(1), idx: 0, granted,
        goal: plan.nodes[plan.nodes.length - 1], t0: this.t,
      };
      r.s = 0;
      r.arrived = false;
      const h0 = geo.headingAt(0);
      const diff = G.angDiff(h0, r.h);
      if (Math.abs(diff) > 0.05) { r.motion = 'rotate'; r.targetH = r.h + diff; r.w = 0; }
      else { r.motion = 'drive'; r.h = h0; }
    }

    canReplan(r) {
      const R = r.route;
      if (!R || R.idx >= R.nodes.length) return false;
      if (R.nodes[R.idx] === R.goal) return false;
      if (r.motion === 'rotate') return r.s === 0;
      const next = Wd.nodeMap[R.nodes[R.idx]], pv = Wd.nodeMap[r.prev];
      if (Math.hypot(next.x - r.x, next.y - r.y) < 32) return false;
      if (pv.kind !== 'station' && Math.hypot(pv.x - r.x, pv.y - r.y) < 32) return false;
      return true;
    }

    canReverse(r) {
      const R = r.route;
      if (!R || R.granted > 0 || r.v > 6 || r.motion !== 'drive') return false;
      const pv = Wd.nodeMap[r.prev];
      if (!pv || pv.kind === 'station' || r.held.nodes.has(r.prev)) return false;
      const e = Wd.edgeBetween(r.prev, R.nodes[R.idx]);
      if (!e || e.kind === 'spur') return false;
      const eh = this.edgeHold[e.id];
      if (!eh || eh.set.size !== 1 || !eh.set.has(r.i)) return false;
      return Math.hypot(pv.x - r.x, pv.y - r.y) >= CFG.stopDist + 2;
    }

    /** Try an alternative route. Returns the plan when adopted, otherwise null. */
    replan(r, opts) {
      if (!this.canReplan(r)) return null;
      const R = r.route;
      const plan = this.planFrom(r, R.goal, opts);
      if (!plan) return null;
      const cur = R.nodes.slice(R.idx);
      if (!plan.reverse && sameNodes(plan.nodes, cur)) return null;
      const curCost = this.routeCost(r, this.planCtx(r, {}));
      let ok;
      switch (opts.mode) {
        case 'deadlock': ok = true; break;
        case 'obstruction': ok = curCost === Infinity || plan.cost < curCost; break;
        case 'intent': ok = plan.cost + 0.25 < curCost; break;
        case 'congestion': ok = plan.cost < curCost + Math.min(4, 0.6 + (opts.waited || 0)); break;
        case 'optimize': ok = plan.cost + 1.0 < curCost; break;
        default: ok = plan.cost < curCost;
      }
      if (!ok) return null;
      const ghost = this.remainingPolyline(r);
      const oldPrev = r.prev;
      if (plan.reverse) {
        const e = Wd.edgeBetween(r.prev, R.nodes[R.idx]);
        const eh = this.edgeHold[e.id];
        if (eh) eh.to = r.prev;
        r.prev = R.nodes[R.idx];
      }
      this.setRoute(r, plan, plan.reverse ? 0 : R.granted);
      r.block = null;
      r.waitAcc = 0;
      r.lastReroute = this.t;
      r.replanCD = 2.5;
      plan.via = this.viaEdge(plan.nodes, cur, r.prev, oldPrev);
      this.stats.reroutes++;
      this.fx.ghosts.push({ robot: r.i, pts: ghost, t0: this.t, dur: 2.8, color: r.color });
      return plan;
    }

    /** First corridor on the new route that the old route did not use. */
    viaEdge(newNodes, oldNodes, newPrev, oldPrev) {
      const set = new Set();
      let p = oldPrev || newPrev;
      for (const n of oldNodes) { const e = Wd.edgeBetween(p, n); if (e) set.add(e.id); p = n; }
      p = newPrev;
      let firstCorridor = null;
      for (const n of newNodes) {
        const e = Wd.edgeBetween(p, n);
        p = n;
        if (!e || e.kind === 'spur') continue;
        if (!firstCorridor) firstCorridor = e.id;
        if (!set.has(e.id)) return e.id;
      }
      return firstCorridor;
    }

    remainingPolyline(r) {
      const geo = r.route.geo, out = [];
      for (let k = geo.index(r.s); k < geo.n; k += 2) out.push(geo.xs[k], geo.ys[k]);
      out.push(geo.xs[geo.n - 1], geo.ys[geo.n - 1]);
      return out;
    }

    edgeName(eid) { const e = Wd.edgeMap[eid]; return e ? e.name : ''; }

    shortEdge(eid) {
      const e = Wd.edgeMap[eid];
      if (!e) return '';
      return e.kind === 'aisle' ? 'AISLE ' + e.label.slice(-1) + ' ' + e.sub : e.kind === 'cross' ? 'X-AISLE ' + e.label.slice(-1) + ' ' + e.sub : e.label;
    }

    applyReroute(r, p) {
      const plan = this.replan(r, p);
      if (!plan) return null;
      const via = { e: plan.via };
      let parts;
      switch (p.mode) {
        case 'obstruction':
          parts = [{ r: r.i }, ' rerouted via ', via, ' (', { e: p.edge }, ' blocked)'];
          r.rerouteText = 'Rerouted around blocked ' + Wd.edgeMap[p.edge].name;
          break;
        case 'congestion':
          parts = [{ r: r.i }, ' rerouted via ', via, ' (congestion at ', { n: p.node }, ')'];
          r.rerouteText = 'Rerouted via ' + Wd.edgeMap[plan.via].name + ' to avoid congestion at ' + p.node;
          break;
        case 'optimize':
          parts = [{ r: r.i }, ' re-optimized route via ', via];
          r.rerouteText = 'Shorter route via ' + Wd.edgeMap[plan.via].name;
          break;
        default:
          parts = [{ r: r.i }, ' rerouted via ', via];
          r.rerouteText = 'Rerouted via ' + Wd.edgeMap[plan.via].name;
      }
      this.emit('reroute', parts);
      return plan;
    }

    // ------------------------------------------------------------------ coordination
    prio(r) { return (r.carrying ? 10 : 0) + Math.min(r.waitAcc, 12) * 0.4 - r.i * 0.01; }

    makeRequest(r) {
      const R = r.route;
      if (!R || r.motion !== 'drive' || (r.mode !== 'toPickup' && r.mode !== 'toDrop')) return null;
      const gi = R.idx + R.granted;
      if (gi >= R.nodes.length) return null;
      const dist = R.nodeS[gi] - CFG.stopDist - r.s;
      if (dist > CFG.reqRange) return null;
      if (!this.isLead(r, gi)) return null;
      const last = R.nodes.length - 1;
      const n = R.nodes[gi];
      const to = gi < last ? R.nodes[gi + 1] : null;
      const e = to ? Wd.edgeBetween(n, to) : null;
      const goalNode = gi + 1 === last ? to : null;
      const eta = Math.max(0, dist) / Math.max(r.v, 35);
      const score = (r.carrying ? 2.2 : 0) - eta + Math.min(r.waitAcc, 12) * 0.5 - r.i * 0.001;
      return { r, gi, n, to, e, goalNode, dist, eta, score };
    }

    isLead(r, gi) {
      const R = r.route;
      const from = gi === R.idx ? r.prev : R.nodes[gi - 1];
      const n = R.nodes[gi], N = Wd.nodeMap[n];
      const myD = gi === R.idx ? Math.hypot(N.x - r.x, N.y - r.y) : Infinity;
      for (const q of this.robots) {
        if (q === r || !q.route) continue;
        const Q = q.route;
        if (Q.idx < Q.nodes.length && q.prev === from && Q.nodes[Q.idx] === n
          && Math.hypot(N.x - q.x, N.y - q.y) < myD) return false;
      }
      return true;
    }

    tryGrant(q) {
      const r = q.r;
      const nh = this.nodeHolder[q.n];
      if (nh !== undefined && nh !== r.i) return { kind: 'node', others: [nh], node: q.n };
      if (q.e) {
        if (this.obstructions[q.e.id] && !r.held.edges.has(q.e.id)) {
          return { kind: 'obstruction', others: [], node: q.n, edge: q.e.id };
        }
        const eh = this.edgeHold[q.e.id];
        if (eh && eh.set.size) {
          const others = [...eh.set].filter((i) => i !== r.i);
          if (others.length) {
            if (eh.to !== q.to) return { kind: 'corridor', others, node: q.n, edge: q.e.id };
            const N = Wd.nodeMap[q.n], T = Wd.nodeMap[q.to];
            const ux = (T.x - N.x) / q.e.len, uy = (T.y - N.y) / q.e.len;
            for (const i of others) {
              const o = this.robots[i];
              if ((o.x - N.x) * ux + (o.y - N.y) * uy < CFG.entryGap) {
                return { kind: 'queue', others: [i], node: q.n, edge: q.e.id };
              }
            }
          }
        }
      }
      if (q.e) {
        // Look through transit nodes (aisle junctions, corners): never enter a chain of
        // single-track segments while another robot is already coming the other way along it.
        const R = r.route;
        let a = q.n, b = q.to;
        for (let k = q.gi + 2; k < R.nodes.length && this.isTransit(b); k++) {
          const c = R.nodes[k];
          const e2 = Wd.edgeBetween(b, c);
          const eh2 = this.edgeHold[e2.id];
          if (eh2 && eh2.set.size && eh2.to === b) {
            const others = [...eh2.set].filter((i) => i !== r.i && this.routeHasStep(this.robots[i], b, a));
            if (others.length) return { kind: 'corridor', others, node: q.n, edge: e2.id };
          }
          a = b; b = c;
        }
      }
      if (q.goalNode) {
        const gh = this.nodeHolder[q.goalNode];
        if (gh !== undefined && gh !== r.i) return { kind: 'station', others: [gh], node: q.goalNode };
      }
      return null;
    }

    isTransit(id) {
      const n = Wd.nodeMap[id];
      if (n.kind === 'station') return false;
      let k = 0;
      for (const a of n.adj) if (a.e.kind !== 'spur') k++;
      return k === 2;
    }

    routeHasStep(q, from, to) {
      const R = q.route;
      if (!R) return false;
      let prev = q.prev;
      for (let k = R.idx; k < R.nodes.length; k++) {
        if (prev === from && R.nodes[k] === to) return true;
        prev = R.nodes[k];
      }
      return false;
    }

    arbitrate() {
      for (const r of this.robots) if (r.block) r.block.fresh = false;
      const reqs = [];
      for (const r of this.robots) { const q = this.makeRequest(r); if (q) reqs.push(q); }
      reqs.sort((a, b) => b.score - a.score);
      for (const q of reqs) {
        const res = this.tryGrant(q);
        if (res) this.setBlock(q.r, res, q, reqs);
        else this.grant(q);
      }
      for (const r of this.robots) if (r.block && !r.block.fresh) { r.block = null; r.waitAcc = 0; }
    }

    setBlock(r, res, q, reqs) {
      const key = res.kind + '|' + res.others.join(',') + '|' + res.node + '|' + (res.edge || '');
      if (!r.block || r.block.key !== key) {
        const sameNode = r.block && r.block.node === res.node;
        const contested = res.kind === 'node' && reqs.some((o) => o.r.i === res.others[0] && o.n === res.node);
        r.block = Object.assign({}, res, {
          key, since: sameNode ? r.block.since : this.t, logged: false,
          reqEdge: q.e ? q.e.id : null, contested,
        });
      }
      r.block.fresh = true;
    }

    grant(q) {
      const r = q.r;
      this.holdNode(r, q.n);
      if (q.e) this.holdEdge(r, q.e, q.to);
      let adv = 1;
      if (q.goalNode) { this.holdNode(r, q.goalNode); adv = 2; }
      r.route.granted += adv;
      if (r.block) {
        const b = r.block;
        if (b.logged && !b.silent) {
          this.stats.conflicts++;
          this.fx.marks.push({ node: b.node, kind: 'resolved', t0: this.t, dur: 1.8 });
          const waited = this.t - b.since;
          if (waited > 1.8) {
            this.emit('resolve', [{ r: r.i }, ' cleared to pass ', { n: b.node }, ` after ${waited.toFixed(1)} s`], 'res|' + r.i, 4);
          }
        }
        r.block = null;
        r.waitAcc = 0;
      }
    }

    mustSlow(r) {
      const R = r.route;
      if (!R) return false;
      const gi = R.idx + R.granted;
      if (gi >= R.nodes.length) return false;
      const d = R.nodeS[gi] - CFG.stopDist - r.s;
      return d < (r.v * r.v) / (2 * CFG.decel) + 60;
    }

    yieldReason(r, W, node) {
      const N = Wd.nodeMap[node];
      if (Math.hypot(W.x - N.x, W.y - N.y) < 70) return 'is crossing';
      if (W.carrying && !r.carrying) return 'has payload priority';
      return 'arrives first';
    }

    logBlock(r) {
      const b = r.block;
      b.logged = true;
      const W = b.others.length ? this.robots[b.others[0]] : null;
      if (!W) { b.silent = true; return; }
      if (b.kind === 'node') {
        this.stats.yields++;
        b.reason = this.yieldReason(r, W, b.node);
        const why = b.reason === 'is crossing' ? 'intersection occupied' : b.reason === 'has payload priority' ? 'payload priority' : 'earlier arrival';
        this.emit('conflict', ['Conflict at ', { n: b.node }, ': ', { r: r.i }, ' yields to ', { r: W.i }, ' (' + why + ')'],
          'y|' + r.i + '|' + W.i + '|' + b.node, 8);
        this.fxLink(W.i, r.i, 'yield', b.reason === 'has payload priority' ? 'Right of way (payload)' : 'Right of way', 'Yield at ' + b.node, 2.6);
        this.fx.marks.push({ node: b.node, kind: 'conflict', t0: this.t, dur: 1.2 });
      } else if (b.kind === 'corridor') {
        this.stats.yields++;
        b.reason = 'clearing';
        const expected = r.expectHold && r.expectHold.eid === b.edge && this.t - r.expectHold.t < 12;
        if (!expected) {
          this.emit('conflict', ['Head-on conflict on ', { e: b.edge }, ': ', { r: r.i }, ' holds at ', { n: b.node }, ' for ', { r: W.i }],
            'c|' + r.i + '|' + b.edge, 8);
        }
        this.fxLink(W.i, r.i, 'corridor', 'Occupying ' + this.edgeName(b.edge), 'Hold at ' + b.node, 2.6);
        this.fx.edges.push({ eid: b.edge, t0: this.t, dur: 2.2 });
      } else {
        b.silent = true;
      }
    }

    handleWaits(dt) {
      for (const r of this.robots) {
        const b = r.block;
        if (!b) continue;
        if (r.v < 20) r.waitAcc += dt;
        const age = this.t - b.since;
        if (b.kind === 'obstruction') {
          if (r.replanCD <= 0) {
            r.replanCD = 0.8;
            this.applyReroute(r, { mode: 'obstruction', edge: b.edge, allowReverse: true });
          }
          continue;
        }
        if (!b.logged && age > 0.25 && this.mustSlow(r)) this.logBlock(r);
        if (r.replanCD > 0 || r.v > 5) continue;
        if ((b.kind === 'corridor' && age > 1.2) || (b.kind === 'node' && age > 4)) {
          const avoid = this.edgesHeldByOthers(r);
          avoid.add(b.reqEdge);
          const plan = this.applyReroute(r, { mode: 'congestion', avoid, waited: age, node: b.node });
          if (!plan) r.replanCD = 1.5;
        }
      }
      this.detectDeadlocks();
    }

    edgesHeldByOthers(r) {
      const out = new Set();
      for (const eid in this.edgeHold) {
        for (const i of this.edgeHold[eid].set) if (i !== r.i) { out.add(eid); break; }
      }
      return out;
    }

    detectDeadlocks() {
      if (this.t < this.deadlockCD) return;
      const deps = this.robots.map((r) => {
        const s = new Set();
        if (r.block && this.t - r.block.since > 0.5 && r.v < 3) r.block.others.forEach((o) => s.add(o));
        if (r.follow >= 0 && r.v < 3) s.add(r.follow);
        return s;
      });
      let cycle = null;
      for (let a = 0; a < deps.length && !cycle; a++) {
        for (const b of deps[a]) {
          if (deps[b].has(a)) { cycle = [a, b]; break; }
          for (const c of deps[b]) if (c !== a && deps[c].has(a)) { cycle = [a, b, c]; break; }
          if (cycle) break;
        }
      }
      if (!cycle) return;
      this.deadlockCD = this.t + 1.0;
      const cand = cycle.map((i) => this.robots[i]).sort((x, y) => this.prio(x) - this.prio(y));
      for (const c of cand) {
        // Only a genuinely free corridor (or backing off) can break the cycle.
        const avoid = this.edgesHeldByOthers(c);
        if (c.block && c.block.reqEdge) avoid.add(c.block.reqEdge);
        const plan = this.replan(c, { mode: 'deadlock', avoid, allowReverse: true });
        if (!plan) continue;
        this.stats.deadlocks++;
        const other = this.robots[cycle.find((i) => i !== c.i)];
        this.emit('deadlock', ['Deadlock resolved: ', { r: c.i }, plan.reverse ? ' reversed and re-planned via ' : ' re-planned via ', { e: plan.via }, ', ', { r: other.i }, ' proceeds'],
          'dl|' + c.i, 4);
        this.fxLink(other.i, c.i, 'deadlock', 'Proceeding', plan.reverse ? 'Reversing' : 'Re-planning', 2.8);
        c.rerouteText = plan.reverse ? 'Reversed to let ' + other.id + ' pass' : 'Re-planned to clear a deadlock';
        this.deadlockCD = this.t + 0.8;
        return;
      }
    }

    /** Pairwise check of broadcast intents for head-on corridor conflicts. */
    intentCheck() {
      for (const r of this.robots) {
        if (r.route && !r.pendingReplan && r.replanCD <= 0 && this.routeCost(r, this.planCtx(r, { noIntent: true })) === Infinity) {
          const eid = this.firstBlockedEdge(r);
          if (!this.applyReroute(r, { mode: 'obstruction', edge: eid, allowReverse: true })) r.replanCD = 0.8;
        }
      }
      const I = this.robots.map((r) => this.intentsOf(r, 5));
      for (let a = 0; a < I.length; a++) {
        for (let b = a + 1; b < I.length; b++) {
          let found = null;
          for (const ia of I[a]) {
            for (const ib of I[b]) {
              if (ia.eid !== ib.eid || ia.to === ib.to || (ia.held && ib.held)) continue;
              if (ia.tIn < ib.tOut + 1.5 && ib.tIn < ia.tOut + 1.5) { found = [ia, ib]; break; }
            }
            if (found) break;
          }
          if (!found) continue;
          const key = a + '|' + b + '|' + found[0].eid;
          if (this.negotiated[key] != null && this.t - this.negotiated[key] < 10) continue;
          if (this.negotiateCorridor(this.robots[a], this.robots[b], found[0], found[1])) this.negotiated[key] = this.t;
        }
      }
    }

    firstBlockedEdge(r) {
      const R = r.route;
      let prev = r.prev;
      for (let k = R.idx; k < R.nodes.length; k++) {
        const e = Wd.edgeBetween(prev, R.nodes[k]);
        if (this.obstructions[e.id] && !r.held.edges.has(e.id)) return e.id;
        prev = R.nodes[k];
      }
      return null;
    }

    negotiateCorridor(A, B, ia, ib) {
      const aFirst = ia.held || (!ib.held && ia.tIn <= ib.tIn);
      const first = aFirst ? A : B, second = aFirst ? B : A;
      const secondI = aFirst ? ib : ia;
      if (secondI.held || !this.canReplan(second)) return false;
      const eid = ia.eid;
      const plan = this.replan(second, { mode: 'intent', avoid: new Set([eid]) });
      this.stats.negotiations++;
      if (plan) {
        second.rerouteText = 'Diverted via ' + Wd.edgeMap[plan.via].name + ' after negotiating with ' + first.id;
        this.emit('negotiate', [{ r: second.i }, ' and ', { r: first.i }, ' negotiated ', { e: eid }, ': ', { r: second.i }, ' diverts via ', { e: plan.via }]);
        this.fxLink(first.i, second.i, 'intent', 'Intent: ' + this.edgeName(eid), 'Divert via ' + this.edgeName(plan.via), 2.6);
      } else {
        second.expectHold = { eid, t: this.t, other: first.i };
        this.emit('negotiate', [{ r: second.i }, ' and ', { r: first.i }, ' negotiated ', { e: eid }, ': ', { r: first.i }, ' has right of way'],
          'neg|' + second.i + '|' + eid, 10);
        this.fxLink(first.i, second.i, 'intent', 'Intent: ' + this.edgeName(eid), 'Acknowledged, will hold', 2.6);
      }
      return true;
    }

    // ------------------------------------------------------------------ motion
    move(r, dt) {
      r.follow = -1;
      if (r.motion === 'rotate') {
        // Hold an in-place turn while a person is within reach of the robot's swinging corners
        const hold = this.humans.some((h) => Math.abs(h.x - r.x) < CFG.rotClear && Math.hypot(h.x - r.x, h.y - r.y) < CFG.rotClear);
        if (hold && !r.rotHold) this.stats.rotHolds++;
        r.rotHold = hold;
        if (hold) { r.w = 0; r.v = 0; return; }
        const diff = G.angDiff(r.targetH, r.h);
        const wLim = Math.min(CFG.omegaMax, Math.sqrt(2 * CFG.alpha * Math.abs(diff)));
        r.w += clamp(Math.sign(diff) * wLim - r.w, -CFG.alpha * dt, CFG.alpha * dt);
        const step = r.w * dt;
        if (Math.abs(diff) < 0.004 || (Math.sign(step) === Math.sign(diff) && Math.abs(step) >= Math.abs(diff))) {
          r.h = r.targetH; r.w = 0; r.motion = 'drive';
        } else r.h += step;
        r.v = 0;
        return;
      }
      r.rotHold = false;
      if (r.motion !== 'drive' || !r.route) { r.v = 0; r.humanStop = -1; r.humanNear = false; r.humanPass = false; return; }
      const R = r.route, geo = R.geo;
      let stopS = geo.length;
      const gi = R.idx + R.granted;
      if (gi < R.nodes.length) stopS = Math.min(stopS, R.nodeS[gi] - CFG.stopDist);
      r.humanNear = false;
      r.humanPass = false;
      r.pedCap = Infinity;
      const sf = this.safetyStop(r, stopS);
      let pedStop = -1;
      if (sf && sf.s < stopS) {
        stopS = sf.s;
        if (sf.human != null) pedStop = sf.human; else r.follow = sf.q;
      }
      const d = stopS - r.s;
      let vLim = Math.min(CFG.vMax, Math.sqrt(2 * CFG.decel * Math.max(0, d)));
      // Scanner warning field: slow down near a person (braking curve set in safetyStop)
      vLim = Math.min(vLim, r.pedCap);
      for (const c of geo.corners) {
        if (c.s1 < r.s) continue;
        if (c.s0 > r.s + 160) break;
        const vc = Math.sqrt(CFG.latAcc * c.r);
        vLim = Math.min(vLim, r.s >= c.s0 ? vc : Math.sqrt(vc * vc + 2 * CFG.decel * (c.s0 - r.s)));
      }
      if (R.idx >= R.nodes.length - 1) vLim = Math.min(vLim, CFG.dockSpeed + (geo.length - r.s) * 0.9);
      if (r.v < vLim) r.v = Math.min(vLim, r.v + CFG.accel * dt);
      else r.v = Math.max(vLim, r.v - CFG.hardDecel * dt);
      let ds = r.v * dt;
      if (r.s + ds >= stopS) { ds = Math.max(0, stopS - r.s); if (d < 0.6) r.v = 0; }
      r.s += ds;
      r.odo += ds;
      geo.at(r.s, tmp);
      r.x = tmp.x; r.y = tmp.y; r.h = tmp.h;
      if (gi >= R.nodes.length && r.s >= geo.length - 0.05 && r.v < 1) { r.s = geo.length; r.v = 0; r.arrived = true; }
      // Stopped for a person: log it once per stop
      const stoppedForPed = pedStop >= 0 && r.v < 3 && stopS - r.s < 2;
      if (stoppedForPed && r.humanStop < 0) {
        const h = this.humans[pedStop];
        const cw = h.path && h.edges[h.k] && h.edges[h.k].cross;
        const box = h.inBox && Wd.peds.nodes[h.inBox].box;
        this.stats.pedStops++;
        const ce = R.idx < R.nodes.length ? Wd.edgeBetween(r.prev, R.nodes[R.idx]) : null;
        this.emit('safety', cw
          ? [{ r: r.i }, ' stopped for a person on the crosswalk at ', { e: cw }]
          : box ? [{ r: r.i }, ` stopped for ${h.id} crossing intersection `, { n: box }]
            : [{ r: r.i }, ` stopped: ${h.id} in its path`, ce ? ' on ' : '', ce ? { e: ce.id } : ''],
          'ped|' + r.i, 15);
      }
      r.humanStop = stoppedForPed ? pedStop : -1;
    }

    safetyStop(r, limitS) {
      const geo = r.route.geo;
      const look = Math.min(limitS, r.s + (r.v * r.v) / (2 * CFG.decel) + 70);
      if (look <= r.s) return null;
      let best = null;
      const k0 = geo.index(r.s) + 1;
      for (const q of this.robots) {
        if (q === r) continue;
        const d0 = Math.hypot(q.x - r.x, q.y - r.y);
        if (d0 > look - r.s + CFG.safeDist) continue;
        for (let k = k0; k < geo.n && geo.cs[k] <= look; k++) {
          const dq = Math.hypot(geo.xs[k] - q.x, geo.ys[k] - q.y);
          if (dq < CFG.safeDist && dq < d0 - 0.05) {
            const s = Math.max(r.s, geo.cs[k - 1]);
            if (!best || s < best.s) best = { s, q: q.i };
            break;
          }
        }
      }
      // People: the obstacle is where the person is and where they are about to walk (a person
      // on a crosswalk or crossing an intersection blocks the rest of that crossing). Near a
      // person the robot slows along a braking curve: to walking pace beside a walkway, to a
      // creep when passing someone standing aside in a shared aisle. It stops for anyone in its
      // path. People waiting at a kerb stand outside the lane and are not obstacles.
      const lookP = Math.max(look, Math.min(limitS, r.s + 130));
      for (const h of this.humans) {
        if (h.state === 'wait' && !h.onLane) continue;
        const ob = this.humanObstacle(h);
        const d0 = segsDist(r.x, r.y, ob);
        if (d0 > lookP - r.s + CFG.pedWarn) continue;
        const stopD = h.clear ? CFG.pedPass : h.inBox ? CFG.pedSafe + 8 : CFG.pedSafe;
        let warned = false;
        for (let k = k0; k < geo.n && geo.cs[k] <= lookP; k++) {
          const dq = segsDist(geo.xs[k], geo.ys[k], ob);
          if (!warned && dq < CFG.pedWarn) {
            warned = true;
            r.humanNear = true;
            if (h.onLane) r.humanPass = true;
            const vc = h.onLane ? CFG.pedCreep : CFG.pedSlow;
            r.pedCap = Math.min(r.pedCap, Math.sqrt(vc * vc + 2 * CFG.decel * Math.max(0, geo.cs[k] - r.s - 12)));
          }
          if (geo.cs[k] <= look && dq < stopD && dq < d0 - 0.05) {
            const s = Math.max(r.s, geo.cs[k - 1]);
            if (!best || s < best.s) best = { s, q: -1, human: h.i };
            break;
          }
        }
      }
      return best;
    }

    /** Where a person is and is about to be, as line segments [x0, y0, x1, y1]. */
    humanObstacle(h) {
      if (h.state !== 'walk' || !h.path) return [[h.x, h.y, h.x, h.y]];
      const e = h.edges[h.k];
      const B = Wd.peds.nodes[h.path[h.k + 1]];
      if (e.cross) return [[h.x, h.y, B.x, B.y]];
      if (e.lane && h.inBox) {
        if (h.inBox === B.id) { const X = this.boxExit(h, h.k + 1); return [[h.x, h.y, B.x, B.y], [B.x, B.y, X.x, X.y]]; }
        const X = this.boxExit(h, h.k);
        return [[h.x, h.y, X.x, X.y]];
      }
      const dx = B.x - h.x, dy = B.y - h.y, l = Math.hypot(dx, dy) || 1, f = Math.min(1, 16 / l);
      return [[h.x, h.y, h.x + dx * f, h.y + dy * f]];
    }

    /** The point where the intersection box at the start of path edge k ends (centre line). */
    boxExit(h, k) {
      const P = Wd.peds, e = h.edges[k], A = P.nodes[h.path[k]];
      if (!e) return A;
      const B = P.nodes[h.path[k + 1]], f = Math.min(1, CFG.boxLen / e.len);
      return { x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f };
    }

    // ------------------------------------------------------------------ people
    makeHuman(d, i) {
      const P = Wd.peds;
      const start = P.nodes[d.home[Math.floor(this.rand() * d.home.length)]];
      const sd = start.side ? CFG.pedAside : 0, sx = start.side ? start.side[0] : 0, sy = start.side ? start.side[1] : 0;
      return {
        i, id: d.id, role: d.role, vest: d.vest, hat: d.hat, home: d.home,
        x: start.x + sx * sd, y: start.y + sy * sd, h: start.face != null ? start.face : 0, v: 0,
        state: 'dwell', timer: 0.5 + this.rand() * 4, node: start.id, faceH: start.face,
        path: null, edges: null, k: 0, t: 0, phase: this.rand() * 6.28,
        speed: 54 + this.rand() * 14, waitT: 0, goal: null,
        // shared aisles: lateral offset from the lane centre (+ = right of walking direction),
        // offset at a lane work spot, intersection being crossed, and who they stand aside for
        off: 0, doff: sd, inBox: null, onLane: !!start.side, clear: !!start.side, asideFor: -1, asideT: 0, passing: -1,
      };
    }

    pedPath(from, to) {
      const P = Wd.peds;
      const dist = Object.create(null), prev = Object.create(null), done = new Set();
      dist[from] = 0;
      for (;;) {
        let u = null;
        for (const id in dist) if (!done.has(id) && (u === null || dist[id] < dist[u])) u = id;
        if (u === null) return null;
        if (u === to) break;
        done.add(u);
        for (const { to: v, e } of P.adj[u]) {
          const c = dist[u] + e.len + (e.cross ? 40 : 0) + (e.lane && this.obstructions[e.lane] ? 2000 : 0);
          if (dist[v] === undefined || c < dist[v]) { dist[v] = c; prev[v] = { u, e }; }
        }
      }
      const nodes = [to], edges = [];
      for (let v = to; v !== from; v = prev[v].u) { nodes.push(prev[v].u); edges.push(prev[v].e); }
      return { nodes: nodes.reverse(), edges: edges.reverse() };
    }

    pickHumanTarget(h) {
      const choices = h.home.filter((id) => id !== h.node);
      const goal = choices[Math.floor(this.rand() * choices.length)];
      const p = goal && this.pedPath(h.node, goal);
      if (!p || p.nodes.length < 2) { h.timer = 2; return; }
      h.path = p.nodes; h.edges = p.edges; h.k = 0; h.t = 0; h.goal = goal; h.inBox = null;
      h.state = 'walk';
      if (p.edges[0].lane) this.projectOnto(h, 0);
    }

    /** Express the person's position as distance along / offset across path edge k. */
    projectOnto(h, k) {
      const P = Wd.peds, e = h.edges[k], A = P.nodes[h.path[k]], B = P.nodes[h.path[k + 1]];
      const ux = (B.x - A.x) / e.len, uy = (B.y - A.y) / e.len, dx = h.x - A.x, dy = h.y - A.y;
      h.t = dx * ux + dy * uy;
      h.off = dy * ux - dx * uy;
    }

    dwellTime(h) {
      const base = { 'Picker': 3.5, 'Packer': 5, 'Inventory auditor': 5, 'Shift supervisor': 3 }[h.role] || 2.5;
      return base + this.rand() * 4;
    }

    /** A person may step onto a crosswalk when no robot is on it and none is about to reach it. */
    crosswalkClear(A, B) { return this.zoneClear([[A.x, A.y, B.x, B.y]]); }

    /** ... and into a robot intersection on the same terms (entry → centre → exit). */
    boxClear(h, e, A, B) {
      const f = Math.max(0, e.len - CFG.boxLen) / e.len, X = this.boxExit(h, h.k + 1);
      const ex = A.x + (B.x - A.x) * f, ey = A.y + (B.y - A.y) * f;
      return this.zoneClear([[ex, ey, B.x, B.y], [B.x, B.y, X.x, X.y]]);
    }

    zoneClear(segs) {
      for (const r of this.robots) {
        if (segsDist(r.x, r.y, segs) < CFG.crossClear) return false;
        if (!r.route || r.motion !== 'drive' || r.v < 3) continue;
        const geo = r.route.geo;
        const look = r.s + (r.v * r.v) / (2 * CFG.decel) + 90;
        for (let k = geo.index(r.s) + 1; k < geo.n && geo.cs[k] <= look; k += 2) {
          if (segsDist(geo.xs[k], geo.ys[k], segs) < CFG.crossClear) return false;
        }
      }
      return true;
    }

    /** What a person walking a shared aisle has to react to: a robot heading their way, or a
     *  standing robot on their walking line ahead (passed at the lane edge). */
    laneThreat(h, ux, uy, rx, ry) {
      const out = { moving: -1, stat: -1, side: 0, turning: false };
      let best = Infinity;
      for (const r of this.robots) {
        const dx = r.x - h.x, dy = r.y - h.y, d = Math.hypot(dx, dy);
        if (d > 300) continue;
        if (r.motion === 'rotate' && d < 52) out.turning = true;
        if (r.motion === 'drive' && r.route && r.v > 2) {
          let hit = d < CFG.pedSee;
          const geo = r.route.geo, look = r.s + (r.v * r.v) / (2 * CFG.decel) + 110;
          for (let k = geo.index(r.s) + 1; !hit && k < geo.n && geo.cs[k] <= look; k += 2) {
            hit = Math.hypot(geo.xs[k] - h.x, geo.ys[k] - h.y) < CFG.pedSee;
          }
          if (hit && d < best) { best = d; out.moving = r.i; }
        } else {
          // (only a robot standing inside the lane: one on a dock spur is off the walking line)
          const along = dx * ux + dy * uy, lat = dx * rx + dy * ry, latC = lat + h.off;
          if (along > -26 && along < 90 && Math.abs(latC) < Wd.HALF + 8) {
            out.stat = r.i;
            out.side = latC > 6 ? -1 : latC < -6 ? 1 : 0;
          }
        }
      }
      return out;
    }

    robotTurningNear(h) {
      return this.robots.some((r) => r.motion === 'rotate' && Math.hypot(r.x - h.x, r.y - h.y) < 52);
    }

    humanStatus(h) {
      const P = Wd.peds;
      if (h.state === 'wait') {
        return h.onLane ? `Waiting to cross intersection ${P.nodes[h.path[h.k + 1]].box}, robot traffic`
          : 'Waiting at the crosswalk for robot traffic to pass';
      }
      if (h.state === 'aside') return h.asideFor >= 0 ? `Stepped aside for ${this.robots[h.asideFor].id} to pass` : 'Stepped aside for a colleague';
      if (h.state === 'walk') {
        const e = h.edges[h.k];
        if (e && e.lane) {
          if (h.inBox) return `Crossing intersection ${P.nodes[h.inBox].box}`;
          if (h.passing >= 0) return `Keeping to the lane edge past ${this.robots[h.passing].id}`;
          return `Walking ${Wd.edgeMap[e.lane].name} (shared aisle)`;
        }
        return e && e.cross && h.t > 0 ? 'Crossing the robot lane on the crosswalk' : 'Walking to the next work spot';
      }
      return {
        'Picker': 'Picking from the rack face', 'Packer': 'Packing at the cell', 'Dock operator': 'Checking staged pallets',
        'Shipping clerk': 'Checking outbound pallets', 'Staging operator': 'Sorting totes', 'Stock checker': 'Counting pallet stock',
        'Shift supervisor': 'Checking the rack face', 'Inventory auditor': 'Auditing rack locations',
      }[h.role] || 'Working';
    }

    turnHuman(h, target, dt) {
      if (target == null) return;
      const d = G.angDiff(target, h.h);
      const step = 7 * dt;
      h.h += Math.abs(d) <= step ? d : Math.sign(d) * step;
    }

    updateHumans(dt) {
      const P = Wd.peds;
      for (const h of this.humans) {
        if (h.state === 'dwell') { this.dwellHuman(h, dt); continue; }
        const A = P.nodes[h.path[h.k]], B = P.nodes[h.path[h.k + 1]];
        const e = h.edges[h.k];
        if (e.lane) { this.walkLane(h, dt); continue; }
        h.onLane = false;
        h.clear = false;
        const dir = Math.atan2(B.y - A.y, B.x - A.x);
        // Wait at the kerb until the crosswalk is clear; once on it, keep going
        if (e.cross && h.t < 0.01) {
          if (!this.crosswalkClear(A, B)) {
            if (h.state !== 'wait') this.stats.pedWaits++;
            h.state = 'wait';
            h.v = 0;
            h.waitT += dt;
            this.turnHuman(h, dir, dt);
            continue;
          }
          h.waitT = 0;
        }
        h.state = 'walk';
        // Give way to a colleague walking just ahead (lower id keeps walking, so nobody deadlocks).
        // Never on a crosswalk, and never to someone standing still: they may be waiting for a
        // robot that is itself waiting for this person to clear the lane.
        let give = false;
        if (!(e.cross && h.t > 0)) give = this.colleagueAhead(h, Math.cos(dir), Math.sin(dir));
        let rest = e.len - h.t;
        for (let k = h.k + 1; k < h.edges.length; k++) rest += h.edges[k].len;
        const target = give ? 0 : Math.min(h.speed * (e.cross ? 1.15 : 1), 8 + rest * 2.2);
        h.v += clamp(target - h.v, -180 * dt, 120 * dt);
        h.t += h.v * dt;
        h.phase += h.v * dt * 0.34;
        if (h.t >= e.len) {
          h.k++;
          h.t = 0;
          if (h.k >= h.path.length - 1) {
            h.node = h.goal;
            h.x = B.x; h.y = B.y;
            h.state = 'dwell';
            h.faceH = B.face != null ? B.face : h.h;
            h.timer = this.dwellTime(h);
            h.path = null;
            continue;
          }
        }
        const A2 = P.nodes[h.path[h.k]], B2 = P.nodes[h.path[h.k + 1]], e2 = h.edges[h.k];
        const f = e2.len ? h.t / e2.len : 1;
        h.x = A2.x + (B2.x - A2.x) * f;
        h.y = A2.y + (B2.y - A2.y) * f;
        this.turnHuman(h, Math.atan2(B2.y - A2.y, B2.x - A2.x), dt);
      }
    }

    colleagueAhead(h, ux, uy) {
      for (const o of this.humans) {
        if (o.i >= h.i || o.state !== 'walk' || o.v < 5) continue;
        const dx = o.x - h.x, dy = o.y - h.y;
        if (dx * dx + dy * dy < 26 * 26 && dx * ux + dy * uy > 0) return true;
      }
      return false;
    }

    dwellHuman(h, dt) {
      h.v = 0;
      const N = Wd.peds.nodes[h.node];
      if (N.side) {
        // At a rack face in a shared aisle: stand at the lane edge (a step further back while a
        // robot next to them turns in place)
        const target = CFG.pedAside + (this.robotTurningNear(h) ? 8 : 0);
        h.doff += clamp(target - h.doff, -CFG.pedStep * dt, CFG.pedStep * dt);
        h.x = N.x + N.side[0] * h.doff;
        h.y = N.y + N.side[1] * h.doff;
        h.onLane = true;
        h.clear = h.doff >= CFG.pedAside - 3;
      } else {
        h.onLane = false;
        h.clear = false;
      }
      this.turnHuman(h, h.faceH, dt);
      h.timer -= dt;
      if (h.timer <= 0) this.pickHumanTarget(h);
    }

    // Walking a shared aisle: along the lane a little right of the centre line, stepping aside to
    // the lane edge to let robots by, and entering an intersection only when no robot is in it
    // or about to enter it. A person never stands still inside the swept path of a lane: they
    // wait at the lane edge, so a robot is never held up by someone who is waiting for it.
    walkLane(h, dt) {
      const P = Wd.peds;
      const e = h.edges[h.k];
      const A = P.nodes[h.path[h.k]], B = P.nodes[h.path[h.k + 1]];
      const ux = (B.x - A.x) / e.len, uy = (B.y - A.y) / e.len, rx = -uy, ry = ux;
      const G = P.nodes[h.goal];
      h.onLane = true;
      h.passing = -1;
      if (h.inBox && h.inBox === A.id && h.t >= CFG.boxLen) h.inBox = null;
      let rest = e.len - h.t;
      for (let k = h.k + 1; k < h.edges.length; k++) rest += h.edges[k].len;
      const lastLeg = h.k === h.edges.length - 1;
      // Step aside to the side they are on (never across the lane); drift to the work spot's side
      // of the lane only while walking freely
      const goalSide = lastLeg && G.side ? (G.side[0] * rx + G.side[1] * ry > 0 ? 1 : -1) : 0;
      let side = h.off < -4 ? -1 : h.off > 4 ? 1 : goalSide || 1;
      let offT = (goalSide || side) * (goalSide && rest < 90 ? CFG.pedAside : CFG.pedKeep);
      let vT = h.speed, state = 'walk';
      // A robot heading their way: stand aside until it has been clear for a moment
      const th = this.laneThreat(h, ux, uy, rx, ry);
      if (th.moving >= 0) { h.asideT = 0.7; h.asideFor = th.moving; }
      else if ((h.asideT -= dt) <= 0) h.asideFor = -1;
      const give = this.colleagueAhead(h, ux, uy);
      const entry = e.len - CFG.boxLen;
      const needBox = B.box && h.inBox !== B.id;
      if (h.inBox) {
        // Committed to an intersection: cross it on the centre line without stopping
        offT = 0;
        vT = h.speed * 1.15;
      } else if (h.asideFor >= 0 || give) {
        state = 'aside';
        vT = 0;
        offT = side * CFG.pedAside;
        if (h.asideFor >= 0 && h.state !== 'aside') {
          this.stats.laneAsides++;
          this.emit('people', [`${h.id} stepped aside on `, { e: e.lane }, ' to let ', { r: h.asideFor }, ' pass'], 'aside|' + h.i, 25);
        }
      } else {
        if (needBox && h.t >= entry - 25) {
          if (!th.turning && this.boxClear(h, e, A, B)) {
            h.inBox = B.id;
            h.waitT = 0;
            offT = 0;
            vT = h.speed * 1.15;
          } else if (h.t >= entry - 0.5) {
            state = 'wait';
            if (h.state !== 'wait') this.stats.boxWaits++;
            vT = 0;
            offT = side * CFG.pedAside;
            h.waitT += dt;
          } else vT = Math.min(vT, Math.sqrt(2 * 150 * Math.max(0, entry - h.t)));
        }
        if (state === 'walk' && !h.inBox && (th.stat >= 0 || this.obstructions[e.lane])) {
          // A standing robot or a closed corridor ahead: pass it at the lane edge
          if (th.stat >= 0 && th.side) side = th.side;
          offT = side * CFG.pedAside;
          vT = Math.abs(h.off) < CFG.pedAside - 4 ? 0 : Math.min(vT, h.speed * 0.7);
          h.passing = th.stat;
        }
      }
      if (th.turning && !h.inBox) offT = (offT < 0 ? -1 : 1) * (CFG.pedAside + 8);
      if (state === 'walk') vT = Math.min(vT, 8 + rest * 2.2);
      h.v += clamp(vT - h.v, -180 * dt, 120 * dt);
      const off0 = h.off;
      let nt = h.t + h.v * dt;
      let noff = h.off + clamp(offT - h.off, -CFG.pedStep * dt, CFG.pedStep * dt);
      if (needBox && h.inBox !== B.id && nt > entry) { nt = entry; h.v = 0; }
      if (!h.inBox) {
        // Last line of defence: never step closer to a robot body that is already within reach
        const tooClose = (t, o) => {
          const x = A.x + ux * t + rx * o, y = A.y + uy * t + ry * o;
          for (const r of this.robots) {
            if (Math.abs(r.x - x) > 50 || Math.abs(r.y - y) > 50) continue;
            const d = footprintDist(r, x, y);
            if (d < CFG.humanR + 4 && d < footprintDist(r, h.x, h.y) - 0.01) return true;
          }
          return false;
        };
        if (tooClose(nt, noff)) {
          if (!tooClose(h.t, noff)) nt = h.t;
          else if (!tooClose(nt, h.off)) noff = h.off;
          else { nt = h.t; noff = h.off; }
          if (nt === h.t) h.v = 0;
        }
      }
      h.t = nt;
      h.off = noff;
      h.phase += (h.v + Math.abs(h.off - off0) / dt) * dt * 0.34;
      h.state = state;
      h.x = A.x + ux * h.t + rx * h.off;
      h.y = A.y + uy * h.t + ry * h.off;
      if (h.t >= e.len) {
        if (lastLeg) {
          // Arrived at the work spot: stand at the lane edge facing the rack
          h.node = h.goal;
          h.state = 'dwell';
          h.path = null;
          h.inBox = null;
          h.doff = G.side ? (h.x - G.x) * G.side[0] + (h.y - G.y) * G.side[1] : 0;
          if (G.side) { h.x = G.x + G.side[0] * h.doff; h.y = G.y + G.side[1] * h.doff; }
          h.faceH = G.face != null ? G.face : h.h;
          h.timer = this.dwellTime(h);
          return;
        }
        h.k++;
        this.projectOnto(h, h.k);
      }
      h.clear = !h.inBox && Math.abs(h.off) >= CFG.pedAside - 3;
      let face = Math.atan2(uy, ux);
      if (state === 'aside' && h.asideFor >= 0) { const q = this.robots[h.asideFor]; face = Math.atan2(q.y - h.y, q.x - h.x); }
      else if (h.v > 4 || Math.abs(h.off - off0) > 0.02) face = Math.atan2(uy * h.v + ry * (h.off - off0) / dt, ux * h.v + rx * (h.off - off0) / dt);
      this.turnHuman(h, face, dt);
    }

    progress(r) {
      const R = r.route;
      if (R) {
        while (R.idx < R.nodes.length && r.s >= R.nodeS[R.idx] - 0.01) {
          const n = R.nodes[R.idx];
          const e = Wd.edgeBetween(r.prev, n);
          if (e) this.releaseEdge(r, e.id);
          r.prev = n;
          R.idx++;
          R.granted = Math.max(0, R.granted - 1);
        }
      }
      // A node lock is kept only while the node lies in the granted window ahead, or while
      // the robot is still physically inside its clearance radius (passing through or docked).
      for (const n of [...r.held.nodes]) {
        if (R) {
          const k = R.nodes.indexOf(n, R.idx);
          if (k >= 0 && k < R.idx + R.granted) continue;
        }
        const N = Wd.nodeMap[n];
        if (Math.hypot(N.x - r.x, N.y - r.y) >= CFG.releaseDist) this.releaseNode(r, n);
      }
    }

    checkSafety() {
      const rs = this.robots;
      for (let a = 0; a < rs.length; a++) {
        for (let b = a + 1; b < rs.length; b++) {
          const d = Math.hypot(rs[a].x - rs[b].x, rs[a].y - rs[b].y);
          if (d < this.stats.minSep) this.stats.minSep = d;
          const key = a + '-' + b;
          if (d < 60 && obbOverlap(rs[a], rs[b])) {
            if (!this.contacts.has(key)) {
              this.contacts.add(key);
              this.stats.collisions++;
              this.emit('alert', ['Collision detected: ', { r: a }, ' and ', { r: b }]);
            }
          } else this.contacts.delete(key);
        }
        // Robot–person contacts (robot footprint against a 10-unit body radius)
        for (const h of this.humans) {
          const r = rs[a];
          const d = Math.hypot(r.x - h.x, r.y - h.y);
          if (d < this.stats.minPedSep) this.stats.minPedSep = d;
          const key = a + '-h' + h.i;
          if (d < 45 && footprintDist(r, h.x, h.y) < CFG.humanR) {
            if (!this.contacts.has(key)) {
              this.contacts.add(key);
              this.stats.collisions++;
              this.stats.pedCollisions = (this.stats.pedCollisions || 0) + 1;
              this.emit('alert', ['Collision detected: ', { r: a }, ' and person ' + h.id]);
            }
          } else this.contacts.delete(key);
        }
      }
    }

    updateFx() {
      const t = this.t;
      for (const k in this.fx) {
        const arr = this.fx[k];
        let w = 0;
        for (let i = 0; i < arr.length; i++) if (t - arr[i].t0 < arr[i].dur) arr[w++] = arr[i];
        arr.length = w;
      }
    }

    // ------------------------------------------------------------------ obstructions
    updateObstructions() {
      for (const id in this.obstructions) {
        const o = this.obstructions[id];
        if (o.state === 'closing' && !this.edgeHeld(id)) { o.state = 'closed'; o.t0 = this.t; o.until = this.t + o.dur; }
        if (o.state === 'closed' && this.t >= o.until) this.clearObstruction(id, 'expired');
      }
      if (this.autoObstructions && this.t >= this.nextObsT) {
        this.nextObsT = this.t + 40 + this.rand() * 20;
        if (!Object.values(this.obstructions).some((o) => o.source === 'auto')) this.spawnAutoObstruction();
      }
    }

    spawnAutoObstruction(source) {
      // Prefer a corridor some robot is about to use, so the fleet visibly adapts.
      const onRoute = [];
      for (const r of this.robots) {
        const R = r.route;
        if (!R) continue;
        for (let k = R.idx + R.granted + 2; k < R.nodes.length; k++) {
          const e = Wd.edgeBetween(R.nodes[k - 1], R.nodes[k]);
          if (e.kind !== 'spur' && !this.edgeHeld(e.id) && !this.obstructions[e.id]) onRoute.push(e);
        }
      }
      const pool = Wd.edges.filter((x) => x.kind !== 'spur' && !this.edgeHeld(x.id) && !this.obstructions[x.id]);
      const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
      for (const e of shuffle(onRoute).concat(shuffle(pool))) {
        const src = source || 'auto';
        if (this.placeObstruction(e.id, src, src === 'user' ? 25 : 16 + this.rand() * 8).ok) return;
      }
    }

    /** Would closing this corridor cut a station off, or trap a robot already committed to it? */
    obstructionProblem(eid) {
      const closed = new Set(Object.keys(this.obstructions));
      closed.add(eid);
      const seen = new Set([Wd.stations[0].id]);
      const stack = [Wd.stations[0].id];
      while (stack.length) {
        const id = stack.pop();
        for (const { to, e } of Wd.nodeMap[id].adj) {
          if (closed.has(e.id) || seen.has(to)) continue;
          seen.add(to);
          stack.push(to);
        }
      }
      const cut = Wd.stations.find((s) => !seen.has(s.id));
      if (cut) return `Closing it would cut off ${cut.id}`;
      const avoid = new Set([eid]);
      for (const r of this.robots) {
        const R = r.route;
        if (!R || !this.routeHasEdgeAfterCommit(r, eid)) continue;
        if (!this.planFrom(r, R.goal, { avoid, noIntent: true })) return `${r.id} would be trapped`;
      }
      return null;
    }

    routeHasEdgeAfterCommit(r, eid) {
      const R = r.route;
      for (let k = R.idx + R.granted + 1; k < R.nodes.length; k++) {
        if (Wd.edgeBetween(R.nodes[k - 1], R.nodes[k]).id === eid) return true;
      }
      return false;
    }

    placeObstruction(eid, source, dur) {
      const e = Wd.edgeMap[eid];
      if (!e || e.kind === 'spur') return { ok: false, msg: 'Dock lanes stay open' };
      if (this.obstructions[eid]) return { ok: false, msg: 'Already blocked' };
      if (Object.keys(this.obstructions).length >= 3) return { ok: false, msg: 'Up to 3 corridors can be closed at once' };
      const problem = this.obstructionProblem(eid);
      if (problem) return { ok: false, msg: problem + ' · pick another corridor' };
      const held = this.edgeHeld(eid);
      const reason = OBSTACLE_REASONS[Math.floor(this.rand() * OBSTACLE_REASONS.length)];
      this.obstructions[eid] = {
        eid, source, reason, dur, state: held ? 'closing' : 'closed', t0: this.t, until: this.t + dur,
      };
      this.emit('block', ['Segment ', { e: eid }, ' blocked (' + (source === 'user' ? 'operator' : reason) + ')',
        held ? ', closes after current traffic clears' : '']);
      for (const r of this.robots) {
        const R = r.route;
        if (!R) continue;
        for (let k = R.idx + R.granted + 1; k < R.nodes.length; k++) {
          if (Wd.edgeBetween(R.nodes[k - 1], R.nodes[k]).id === eid) {
            r.pendingReplan = { mode: 'obstruction', edge: eid, allowReverse: true };
            break;
          }
        }
      }
      return { ok: true };
    }

    clearObstruction(eid, why) {
      if (!this.obstructions[eid]) return;
      delete this.obstructions[eid];
      this.emit('clear', ['Segment ', { e: eid }, why === 'user' ? ' reopened by operator' : ' reopened']);
      for (const r of this.robots) {
        if (r.route && r.replanCD <= 0 && this.canReplan(r)) this.applyReroute(r, { mode: 'optimize' });
      }
    }

    toggleObstruction(eid) {
      if (this.obstructions[eid]) { this.clearObstruction(eid, 'user'); return { ok: true, cleared: true }; }
      return this.placeObstruction(eid, 'user', 25);
    }

    // ------------------------------------------------------------------ read-outs for the UI
    status(r) {
      const id = (i) => this.robots[i].id;
      if (r.mode === 'idle') return { key: 'idle', label: 'Idle', tone: 'idle', text: `Parked at ${r.station}, awaiting task` };
      if (r.mode === 'loading') return { key: 'work', label: 'Loading', tone: 'work', text: `Receiving payload at ${r.station}` };
      if (r.mode === 'unloading') return { key: 'work', label: 'Unloading', tone: 'work', text: `Handing off payload at ${r.station}` };
      if (r.humanStop >= 0) {
        const h = this.humans[r.humanStop];
        return { key: 'ped', label: 'Stopped', tone: 'wait', text: `Person ${h.id} ${h.onLane && !h.inBox ? 'in the aisle' : 'crossing'} ahead, waiting` };
      }
      if (r.rotHold) return { key: 'ped', label: 'Holding', tone: 'wait', text: 'Person close by, holding the turn' };
      const b = r.block;
      if (b && b.kind === 'obstruction') return { key: 'replan', label: 'Replanning', tone: 'wait', text: `${Wd.edgeMap[b.edge].name} blocked, computing new route` };
      if (b && b.logged && b.kind === 'node') {
        const why = b.reason === 'has payload priority' ? 'payload priority' : b.reason === 'is crossing' ? 'intersection occupied' : 'earlier arrival';
        return { key: 'yield', label: 'Yielding', tone: 'wait', text: `Holding at ${b.node}, ${id(b.others[0])} has right of way (${why})` };
      }
      if (b && b.logged && b.kind === 'corridor') {
        return { key: 'yield', label: 'Holding', tone: 'wait', text: `Holding at ${b.node}, ${id(b.others[0])} occupying ${Wd.edgeMap[b.edge].name}` };
      }
      if (b && b.kind === 'queue' && r.v < 10) return { key: 'queue', label: 'Queued', tone: 'wait', text: `Queued behind ${id(b.others[0])} for ${Wd.edgeMap[b.edge].name}` };
      if (r.needRoute) return { key: 'blocked', label: 'No route', tone: 'fault', text: 'All routes to goal blocked' };
      if (this.t - r.lastReroute < 3.2 && r.rerouteText) return { key: 'reroute', label: 'Rerouted', tone: 'drive', text: r.rerouteText };
      if (r.follow >= 0) return { key: 'follow', label: 'Following', tone: 'drive', text: `Keeping safe gap to ${id(r.follow)}` };
      if (r.motion === 'rotate') return { key: 'turn', label: 'Turning', tone: 'drive', text: 'Rotating in place to route heading' };
      return {
        key: 'move', label: r.mode === 'toPickup' ? 'To pickup' : 'In transit', tone: 'drive',
        text: r.humanNear && r.v > 2 ? (r.humanPass ? 'Passing a person at reduced speed' : 'Slowing: person near path') : 'Via ' + this.viaText(r),
      };
    }

    viaText(r) {
      const R = r.route;
      if (!R) return '';
      const names = [];
      let prev = r.prev;
      for (let k = R.idx; k < R.nodes.length && names.length < 2; k++) {
        const e = Wd.edgeBetween(prev, R.nodes[k]);
        prev = R.nodes[k];
        if (!e || e.kind === 'spur') continue;
        if (names[names.length - 1] !== e.label) names.push(e.label);
      }
      return names.length ? names.join(' → ') : 'dock lane';
    }

    legProgress(r) {
      if (!r.task) return 0;
      if (!r.route) return r.mode === 'loading' || r.mode === 'unloading' ? 1 : 0;
      const done = r.odo - r.legOdo, rem = Math.max(0, r.route.geo.length - r.s);
      return done + rem > 0 ? done / (done + rem) : 0;
    }
  }

  WH.Sim = Sim;
  WH.SIM_CFG = CFG;
  WH.obbOverlap = obbOverlap;
})(typeof window !== 'undefined' ? window : globalThis);
