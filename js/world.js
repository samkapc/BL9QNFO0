/*
 * world.js — warehouse layouts ("instances") for EdgeFleet.
 *
 * Each layout is plain data: a traffic graph (intersections, junctions, path segments and the
 * dead-end station spurs robots dock in) plus scenery for the floor plan (racks, storage areas,
 * doors, labels, column grid). The page picks a layout from the URL hash (#instance-1,
 * #instance-2); with no hash it shows the instances overview.
 *
 * World units: 1 unit ≈ 2 cm. Path segments between nodes are kept ≥ 130 units so a robot
 * waiting at a hold line has always cleared the node behind it.
 */
(function (root) {
  'use strict';
  const WH = (root.WH = root.WH || {});

  const UNITS_PER_M = 50;
  const HALF = 36;                         // lane half-width (72-unit corridors)
  const pad2 = (n) => String(n).padStart(2, '0');
  const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

  function makeLayout(meta) {
    return Object.assign({
      nodes: [], nodeMap: Object.create(null),
      edges: [], edgeMap: Object.create(null), pairMap: Object.create(null),
      stations: [], stationMap: Object.create(null),
      racks: [], bays: [], areas: [], doors: [], labels: [], grid: { xs: [], ys: [] },
      UNITS_PER_M, HALF, AISLE: HALF * 2,
    }, meta);
  }
  function addNode(L, id, x, y, kind) {
    const n = { id, x, y, kind, adj: [] };
    L.nodes.push(n);
    L.nodeMap[id] = n;
    return n;
  }
  function addEdge(L, a, b, kind, label, sub) {
    const A = L.nodeMap[a], B = L.nodeMap[b];
    const e = { id: 'E' + pad2(L.edges.length), a, b, kind, label, sub, len: Math.hypot(B.x - A.x, B.y - A.y) };
    e.name = kind === 'spur' ? label + ' approach' : label + ' ' + sub;
    L.edges.push(e);
    L.edgeMap[e.id] = e;
    L.pairMap[pairKey(a, b)] = e;
    A.adj.push({ to: b, e });
    B.adj.push({ to: a, e });
    return e;
  }
  function addStation(L, num, x, y, dir, junction, zone) {
    const id = 'S' + pad2(num);
    const n = addNode(L, id, x, y, 'station');
    const st = { id, num, x, y, dir, junction, zone, stand: { x: x + dir.x * 42, y: y + dir.y * 42 } };
    n.station = st;
    L.stations.push(st);
    L.stationMap[id] = st;
    return st;
  }
  function finalize(L) {
    L.stations.sort((a, b) => a.num - b.num);
    L.stations.forEach((st) => addEdge(L, st.id, st.junction, 'spur', st.id, 'lane'));
    L.edgeBetween = (a, b) => L.pairMap[pairKey(a, b)] || null;
    L.floorM = [(L.WALL.x1 - L.WALL.x0) / UNITS_PER_M, (L.WALL.y1 - L.WALL.y0) / UNITS_PER_M];
    return L;
  }

  // ---- Pedestrians ---------------------------------------------------------------------------
  // People walk on their own network: painted walkways, work spots, and zebra crosswalks where a
  // walkway crosses a robot lane (detected automatically from the lane geometry). The aisles are
  // shared too: some people walk the robot lanes themselves (see laneWalks).
  function pointSegDist(px, py, A, B) {
    const dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - A.x) * dx + (py - A.y) * dy) / l2)) : 0;
    return Math.hypot(px - (A.x + dx * t), py - (A.y + dy * t));
  }
  function addPeds(L, spec) {
    const P = { nodes: Object.create(null), list: [], edges: [], adj: Object.create(null), walkers: spec.walkers };
    for (const [id, x, y, opt] of spec.nodes) {
      const n = { id, x, y, spot: !!(opt && opt.spot), face: opt && opt.face != null ? opt.face : null };
      if (opt && opt.box) n.box = opt.box;       // robot intersection: only entered when clear
      if (opt && opt.side) n.side = opt.side;    // lane work spot: stand aside on this side
      P.nodes[id] = n;
      P.list.push(n);
      P.adj[id] = [];
    }
    for (const [a, b, opt] of spec.edges) {
      const A = P.nodes[a], B = P.nodes[b];
      const e = { a, b, len: Math.hypot(B.x - A.x, B.y - A.y), vis: !(opt && opt.hidden), cross: null, lane: null };
      if (opt && opt.lane) { e.lane = opt.lane; e.vis = false; }
      const steps = Math.ceil(e.len / 4);
      for (const re of e.lane ? [] : L.edges) {
        const half = re.kind === 'spur' ? 32 : HALF;
        const RA = L.nodeMap[re.a], RB = L.nodeMap[re.b];
        for (let k = 0; k <= steps && !e.cross; k++) {
          const f = k / steps;
          if (pointSegDist(A.x + (B.x - A.x) * f, A.y + (B.y - A.y) * f, RA, RB) < half - 2) e.cross = re.id;
        }
        if (e.cross) break;
      }
      P.edges.push(e);
      P.adj[a].push({ to: b, e });
      P.adj[b].push({ to: a, e });
    }
    L.peds = P;
    return L;
  }
  // Shared aisles: a walking network along every robot lane centreline. Its nodes at robot
  // intersections are "boxes" people cross only when no robot is in or about to enter them;
  // spots are rack-face work positions where a person stands aside at the lane edge.
  //   spots: [id, nodeA, nodeB, distance from nodeA, side [x, y]]
  function laneWalks(L, peds, spots) {
    const byEdge = Object.create(null);
    for (const [id, a, b, d, side] of spots) {
      const e = L.edgeBetween(a, b);
      (byEdge[e.id] = byEdge[e.id] || []).push({ id, t: e.a === a ? d : e.len - d, side });
    }
    const lanes = L.edges.filter((e) => e.kind !== 'spur');
    const used = new Set();
    lanes.forEach((e) => { used.add(e.a); used.add(e.b); });
    used.forEach((id) => { const N = L.nodeMap[id]; peds.nodes.push(['L' + id, N.x, N.y, { box: id }]); });
    for (const e of lanes) {
      const A = L.nodeMap[e.a], B = L.nodeMap[e.b];
      const ux = (B.x - A.x) / e.len, uy = (B.y - A.y) / e.len;
      let prev = 'L' + e.a;
      for (const s of (byEdge[e.id] || []).sort((p, q) => p.t - q.t)) {
        peds.nodes.push([s.id, A.x + ux * s.t, A.y + uy * s.t, { spot: true, side: s.side, face: Math.atan2(s.side[1], s.side[0]) }]);
        peds.edges.push([prev, s.id, { lane: e.id }]);
        prev = s.id;
      }
      peds.edges.push([prev, 'L' + e.b, { lane: e.id }]);
    }
    return spots.map((s) => s[0]);
  }

  // ======================================================================== Instance 1 · Bay 01
  // A regular cross-aisle grid: four storage aisles, three cross-aisles, pick-face bays cut into
  // the racking, and dock doors on the north and south walls.
  function buildBay01() {
    const COLS = [250, 610, 970, 1330], ROWS = [200, 500, 800], ROW_IDS = ['A', 'B', 'C'], MIDS = [350, 650];
    const BAY = 82, DOCK_Y = [95, 905];
    const L = makeLayout({
      id: 'bay-01', slug: 'instance-1', instance: 1, name: 'Bay 01', site: 'DC-02', rev: 7,
      kind: 'Cross-aisle grid',
      summary: 'Four storage aisles crossed by three cross-aisles, pick faces cut into the racking, and dock doors on the north and south walls.',
      W: 1600, H: 1000, WALL: { x0: 30, y0: 30, x1: 1570, y1: 970 },
      bounds: { x0: -30, y0: -30, x1: 1588, y1: 988 },
      zoneNames: { inbound: 'Inbound dock', storage: 'Storage pick face', outbound: 'Outbound dock' },
      robots: [
        { id: 'AMR-01', color: '#4bb0c8', start: 'S02' },
        { id: 'AMR-02', color: '#8f88ea', start: 'S08' },
        { id: 'AMR-03', color: '#cc76b8', start: 'S13' },
      ],
      flows: [
        { w: 0.34, from: 'inbound', to: 'storage' },
        { w: 0.34, from: 'storage', to: 'outbound' },
        { w: 0.16, from: 'storage', to: 'storage' },
        { w: 0.16, from: 'inbound', to: 'outbound' },
      ],
    });
    ROW_IDS.forEach((r, ri) => COLS.forEach((x, ci) => addNode(L, r + (ci + 1), x, ROWS[ri], 'cross')));
    COLS.forEach((x, ci) => {
      addNode(L, 'J' + pad2(5 + ci), x, MIDS[0], 'junction');
      addNode(L, 'J' + pad2(9 + ci), x, MIDS[1], 'junction');
    });
    COLS.forEach((x, ci) => addStation(L, 1 + ci, x, DOCK_Y[0], { x: 0, y: -1 }, 'A' + (ci + 1), 'inbound'));
    COLS.forEach((x, ci) => addStation(L, 5 + ci, x + BAY, MIDS[0], { x: 1, y: 0 }, 'J' + pad2(5 + ci), 'storage'));
    COLS.forEach((x, ci) => addStation(L, 9 + ci, x + BAY, MIDS[1], { x: 1, y: 0 }, 'J' + pad2(9 + ci), 'storage'));
    COLS.forEach((x, ci) => addStation(L, 13 + ci, x, DOCK_Y[1], { x: 0, y: 1 }, 'C' + (ci + 1), 'outbound'));
    ROW_IDS.forEach((r) => {
      for (let c = 1; c < 4; c++) addEdge(L, r + c, r + (c + 1), 'cross', 'Cross-aisle ' + r, c + '–' + (c + 1));
    });
    COLS.forEach((_, ci) => {
      const a = ci + 1, j1 = 'J' + pad2(5 + ci), j2 = 'J' + pad2(9 + ci);
      addEdge(L, 'A' + a, j1, 'aisle', 'Aisle ' + a, 'A–B');
      addEdge(L, j1, 'B' + a, 'aisle', 'Aisle ' + a, 'A–B');
      addEdge(L, 'B' + a, j2, 'aisle', 'Aisle ' + a, 'B–C');
      addEdge(L, j2, 'C' + a, 'aisle', 'Aisle ' + a, 'B–C');
    });

    // Scenery
    [[244, 456], [544, 756]].forEach(([y0, y1]) => {
      L.racks.push({ x0: 46, x1: COLS[0] - HALF - 8, y0, y1, faces: ['right'] });
      for (let c = 0; c < 3; c++) L.racks.push({ x0: COLS[c] + HALF + 8, x1: COLS[c + 1] - HALF - 8, y0, y1, faces: ['left', 'right'] });
      L.racks.push({ x0: COLS[3] + HALF + 8, x1: 1554, y0, y1, faces: ['left'] });
    });
    L.racks.forEach((rk, i) => { rk.id = 'R' + pad2(i + 1); rk.pitch = 53; });
    COLS.forEach((x) => MIDS.forEach((y) => L.bays.push({ x0: x + HALF, x1: x + HALF + 118, y0: y - 46, y1: y + 46 })));
    [[48, 148], [852, 952]].forEach(([y0, y1]) => {
      L.areas.push({ kind: 'staging', x0: 48, x1: COLS[0] - 64, y0, y1 });
      for (let c = 0; c < 3; c++) L.areas.push({ kind: 'staging', x0: COLS[c] + 64, x1: COLS[c + 1] - 64, y0, y1 });
      L.areas.push({ kind: 'staging', x0: COLS[3] + 64, x1: 1552, y0, y1 });
    });
    COLS.forEach((x, i) => {
      L.doors.push({ side: 'top', pos: x, w: 80, label: 'D' + (i + 1) });
      L.doors.push({ side: 'bottom', pos: x, w: 80, label: 'D' + (i + 5) });
    });
    L.labels.push({ text: 'Inbound docks', x: 52, y: 160, align: 'left', size: 10.5, weight: 500 });
    L.labels.push({ text: 'Outbound docks', x: 52, y: 840, align: 'left', size: 10.5, weight: 500 });
    COLS.forEach((x, i) => [275, 575].forEach((y) => L.labels.push({ text: 'Aisle ' + (i + 1), x: x - 22, y, rot: -90 })));
    ROWS.forEach((y, i) => [430, 1150].forEach((x) => L.labels.push({ text: 'Cross-aisle ' + ROW_IDS[i], x, y: y - 22 })));
    for (let k = 0; k <= 8; k++) L.grid.xs.push(L.WALL.x0 + k * 192.5);
    for (let k = 0; k <= 5; k++) L.grid.ys.push(L.WALL.y0 + k * 188);
    finalize(L);

    // Pedestrians: a walkway along each dock apron (crossing the dock lanes on zebra crosswalks),
    // with work spots in the gaps between the staged pallets.
    const peds = { nodes: [], edges: [], walkers: [] };
    const north = [], south = [];
    [[156, 'n', -1], [844, 's', 1]].forEach(([y, pre, side]) => {
      const stops = [{ x: 60 }, { x: 1540 }];
      COLS.forEach((x) => stops.push({ x: x - 44 }, { x: x + 44 }));
      L.areas.filter((a) => a.kind === 'staging' && (side < 0 ? a.y1 < 500 : a.y0 > 500)).forEach((a) => {
        const w = a.x1 - a.x0, cols = Math.max(1, Math.floor((w - 16) / 58)), gx = (w - cols * 48) / (cols + 1);
        if (gx < 20) return;
        for (let c = 0; c < cols - 1; c++) stops.push({ x: a.x0 + gx + c * (48 + gx) + 48 + gx / 2, gap: true });
      });
      stops.sort((p, q) => p.x - q.x);
      stops.forEach((s, i) => {
        const id = pre + i;
        peds.nodes.push([id, s.x, y, { spot: i === 0 || i === stops.length - 1, face: side * Math.PI / 2 }]);
        if (i) peds.edges.push([pre + (i - 1), id]);
        (side < 0 ? north : south).push(id);
        if (s.gap) {
          const gid = pre + 'g' + i;
          peds.nodes.push([gid, s.x, y + side * 38, { spot: true, face: side * Math.PI / 2 }]);
          peds.edges.push([id, gid, { hidden: true }]);
          (side < 0 ? north : south).push(gid);
        }
      });
    });
    const spotsOf = (ids, test) => ids.filter((id) => {
      const n = peds.nodes.find((q) => q[0] === id);
      return n[3].spot && test(n[1]);
    });
    // Shared aisles: a supervisor and an auditor walk the robot lanes between rack faces
    const W = [-1, 0], E = [1, 0], N = [0, -1], S = [0, 1];
    const lane = laneWalks(L, peds, [
      ['la1', 'A1', 'J05', 75, W], ['la2', 'A2', 'J06', 75, W], ['la3', 'J06', 'B2', 75, E], ['la4', 'J07', 'B3', 75, E],
      ['la5', 'B1', 'J09', 75, E], ['la6', 'B3', 'J11', 75, W], ['la7', 'J12', 'C4', 75, E], ['la8', 'A4', 'J08', 75, W],
      ['lc1', 'A1', 'A2', 180, S], ['lc2', 'B1', 'B2', 180, N], ['lc3', 'B2', 'B3', 180, S], ['lc4', 'B3', 'B4', 180, N],
      ['lc5', 'C2', 'C3', 180, N], ['lc6', 'A3', 'A4', 180, S],
    ]);
    peds.walkers = [
      { id: 'P1', role: 'Dock operator', vest: '#d8e02a', hat: '#f2f2ee', home: spotsOf(north, (x) => x < 800) },
      { id: 'P2', role: 'Dock operator', vest: '#f08a24', hat: '#f2c230', home: spotsOf(north, (x) => x > 800) },
      { id: 'P3', role: 'Shipping clerk', vest: '#d8e02a', hat: '#3b6fd1', home: spotsOf(south, () => true) },
      { id: 'P4', role: 'Shift supervisor', vest: '#f08a24', hat: '#f2f2ee', home: lane },
      { id: 'P5', role: 'Inventory auditor', vest: '#d8e02a', hat: '#2f9e62', home: lane.filter((id) => id[1] === 'a') },
    ];
    return addPeds(L, peds);
  }

  // ======================================================================== Instance 2 · Bay 02
  // A mixed-use hall: two banks of high-bay racking on the west side with rack-end P&D points on
  // the main aisle, bulk floor storage in the centre, packing cells fed by an overhead conveyor
  // along the north wall, dock doors on the east wall, and cube storage plus pallet floor
  // storage in the south-east.
  function buildBay02() {
    const L = makeLayout({
      id: 'bay-02', slug: 'instance-2', instance: 2, name: 'Bay 02', site: 'DC-02', rev: 3,
      kind: 'Mixed-use hall',
      summary: 'High-bay racking with rack-end P&D points, bulk floor storage, packing cells on an overhead conveyor, cube storage and east-wall dock doors.',
      W: 1800, H: 1120, WALL: { x0: 30, y0: 30, x1: 1770, y1: 1090 },
      bounds: { x0: -30, y0: -30, x1: 1788, y1: 1108 },
      zoneNames: {
        racking: 'Racking P&D point', bulk: 'Bulk storage P&D point', packing: 'Packing cell',
        dock: 'Dock door', cube: 'Cube storage port',
      },
      robots: [
        { id: 'AMR-01', color: '#4bb0c8', start: 'S03' },
        { id: 'AMR-02', color: '#8f88ea', start: 'S09' },
        { id: 'AMR-03', color: '#cc76b8', start: 'S15' },
      ],
      flows: [
        { w: 0.22, from: 'dock', to: 'racking' },
        { w: 0.22, from: 'racking', to: 'packing' },
        { w: 0.16, from: 'cube', to: 'packing' },
        { w: 0.2, from: 'packing', to: 'dock' },
        { w: 0.1, from: 'dock', to: 'bulk' },
        { w: 0.1, from: 'bulk', to: 'racking' },
      ],
    });
    const n = (id, x, y, kind) => addNode(L, id, x, y, kind || 'cross');
    // Top aisle, west perimeter aisle and bottom aisle around the racking
    n('N1', 75, 75); n('N2', 720, 75); n('N3', 1000, 75);
    n('W1', 75, 560); n('B1', 75, 1045); n('B2', 720, 1045);
    // Main aisle (east–west) through the racking and across the hall
    n('M1', 270, 560, 'junction'); n('M2', 422, 560, 'junction'); n('M3', 574, 560, 'junction');
    n('M4', 720, 560); n('M5', 860, 560, 'junction'); n('M6', 1000, 560); n('M7', 1280, 560); n('M8', 1560, 560);
    // Packing aisle under the packing cells
    n('P1', 1000, 330); n('P2', 1140, 330, 'junction'); n('P3', 1280, 330); n('P4', 1420, 330, 'junction'); n('P5', 1560, 330);
    // South aisle along the storage areas
    n('H1', 720, 780); n('H2', 1000, 780); n('H3', 1130, 780, 'junction'); n('H4', 1280, 780); n('H5', 1560, 780);
    // Dead-end dock lane at the north-east corner
    n('E1', 1560, 120, 'junction');

    // Stations
    const up = { x: 0, y: -1 }, down = { x: 0, y: 1 }, east = { x: 1, y: 0 };
    addStation(L, 1, 270, 480, up, 'M1', 'racking');
    addStation(L, 2, 270, 640, down, 'M1', 'racking');
    addStation(L, 3, 422, 480, up, 'M2', 'racking');
    addStation(L, 4, 422, 640, down, 'M2', 'racking');
    addStation(L, 5, 574, 480, up, 'M3', 'racking');
    addStation(L, 6, 574, 640, down, 'M3', 'racking');
    addStation(L, 7, 860, 480, up, 'M5', 'bulk');
    addStation(L, 8, 1140, 250, up, 'P2', 'packing');
    addStation(L, 9, 1280, 250, up, 'P3', 'packing');
    addStation(L, 10, 1420, 250, up, 'P4', 'packing');
    addStation(L, 11, 1670, 120, east, 'E1', 'dock');
    addStation(L, 12, 1670, 330, east, 'P5', 'dock');
    addStation(L, 13, 1670, 560, east, 'M8', 'dock');
    addStation(L, 14, 1670, 780, east, 'H5', 'dock');
    addStation(L, 15, 1130, 860, down, 'H3', 'cube');
    addStation(L, 16, 1280, 860, down, 'H4', 'cube');

    const path = (label, ids) => { for (let i = 1; i < ids.length; i++) addEdge(L, ids[i - 1], ids[i], 'aisle', label, ids[i - 1] + '–' + ids[i]); };
    path('Top aisle', ['N1', 'N2', 'N3']);
    path('West aisle', ['N1', 'W1', 'B1']);
    path('Bottom aisle', ['B1', 'B2']);
    path('Main aisle', ['W1', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8']);
    path('Aisle 1', ['N2', 'M4', 'H1', 'B2']);
    path('Aisle 2', ['N3', 'P1', 'M6', 'H2']);
    path('Packing aisle', ['P1', 'P2', 'P3', 'P4', 'P5']);
    path('Aisle 3', ['P3', 'M7', 'H4']);
    path('Dock aisle', ['E1', 'P5', 'M8', 'H5']);
    path('South aisle', ['H1', 'H2', 'H3', 'H4', 'H5']);

    // Scenery: two banks of seven racks, pick aisles between them too narrow for the AMRs
    for (let bank = 0; bank < 2; bank++) {
      for (let i = 0; i < 7; i++) {
        const x0 = 130 + 76 * i;
        L.racks.push({ x0, x1: x0 + 52, y0: bank ? 725 : 140, y1: bank ? 1000 : 415, faces: ['left', 'right'], pitch: 27 });
      }
    }
    L.racks.forEach((rk, i) => { rk.id = 'R' + pad2(i + 1); });
    L.areas.push({ kind: 'pallets', x0: 790, y0: 140, x1: 930, y1: 415, cols: 4, rows: 8, label: 'Bulk storage' });
    L.areas.push({ kind: 'conveyor', pts: [[1070, 432], [1070, 52], [1210, 52], [1210, 300]], overhead: true, label: 'Overhead conveyor', lx: 1224, ly: 290 });
    [[1085, 'PC-1'], [1225, 'PC-2'], [1365, 'PC-3']].forEach(([x0, label]) => {
      L.areas.push({ kind: 'cell', x0, y0: 64, x1: x0 + 110, y1: 186, label });
    });
    L.areas.push({ kind: 'totes', x0: 1060, y0: 614, x1: 1236, y1: 720, label: 'Staging' });
    L.areas.push({ kind: 'totes', x0: 1324, y0: 614, x1: 1500, y1: 720, label: 'Staging' });
    L.areas.push({ kind: 'cube', x0: 1062, y0: 924, x1: 1334, y1: 1066, label: 'Cube storage' });
    L.areas.push({ kind: 'pallets', x0: 1384, y0: 858, x1: 1746, y1: 1066, cols: 8, rows: 4, label: 'Pallet floor storage' });
    L.areas.push({ kind: 'carts', x0: 784, y0: 852, x1: 1030, y1: 1000, label: 'Cart parking' });
    [120, 330, 560, 780].forEach((y, i) => L.doors.push({ side: 'right', pos: y, w: 80, label: 'D' + (i + 1) }));
    L.labels.push({ text: 'High-bay racking', x: 132, y: 128, align: 'left', size: 10.5, weight: 500 });
    L.labels.push({ text: 'Rack-end P&D', x: 132, y: 690, align: 'left', size: 10 });
    L.labels.push({ text: 'Main aisle', x: 1140, y: 538 });
    L.labels.push({ text: 'Main aisle', x: 350, y: 538 });
    L.labels.push({ text: 'Packing aisle', x: 1490, y: 308 });
    L.labels.push({ text: 'South aisle', x: 860, y: 758 });
    L.labels.push({ text: 'Top aisle', x: 400, y: 53 });
    L.labels.push({ text: 'Bottom aisle', x: 400, y: 1023 });
    L.labels.push({ text: 'West aisle', x: 53, y: 320, rot: -90 });
    L.labels.push({ text: 'Dock doors', x: 1742, y: 450, rot: -90, size: 10.5, weight: 500 });
    for (let k = 0; k <= 9; k++) L.grid.xs.push(L.WALL.x0 + (k * (L.WALL.x1 - L.WALL.x0)) / 9);
    for (let k = 0; k <= 6; k++) L.grid.ys.push(L.WALL.y0 + (k * (L.WALL.y1 - L.WALL.y0)) / 6);
    finalize(L);

    // Pedestrians
    const pn = [], pe = [];
    const node = (id, x, y, opt) => pn.push([id, x, y, opt]);
    const walk = (ids, opt) => { for (let i = 1; i < ids.length; i++) pe.push([ids[i - 1], ids[i], opt]); };
    const fL = Math.PI, fR = 0, fU = -Math.PI / 2, fD = Math.PI / 2;
    // Racking: walkways along the top of the upper bank and the top of the lower bank, the narrow
    // pick aisles between racks (too narrow for the AMRs), and one zebra crosswalk over the main aisle.
    const AX = [194, 270, 346, 422, 498, 574];
    const WX = [120].concat(AX, [650]);
    WX.forEach((x, i) => { node('wn' + i, x, 125, i === 0 || i === WX.length - 1 ? { spot: true, face: fD } : null); node('ws' + i, x, 711); });
    walk(WX.map((_, i) => 'wn' + i));
    walk(WX.map((_, i) => 'ws' + i));
    AX.forEach((x, i) => {
      const k = i + 1, pd = x === 270 || x === 422 || x === 574;
      node('an' + k, x, 262, { spot: true, face: i % 2 ? fL : fR });
      node('ab' + k, x, 398, { spot: true, face: pd ? fD : i % 2 ? fR : fL });
      node('as' + k, x, 850, { spot: true, face: i % 2 ? fR : fL });
      node('at' + k, x, 985, { spot: true, face: i % 2 ? fL : fR });
      walk(['wn' + k, 'an' + k, 'ab' + k], { hidden: true });
      walk(['ws' + k, 'as' + k, 'at' + k], { hidden: true });
    });
    node('x1', 194, 440); node('x2', 172, 478); node('xn', 172, 512); node('xs', 172, 608); node('x3', 172, 650); node('x4', 194, 690);
    walk(['ab1', 'x1', 'x2', 'xn', 'xs', 'x3', 'x4', 'ws1']);
    // Packing cells: an operator moves between the three cells along the north wall
    [1140, 1280, 1420].forEach((cx, i) => {
      node('pt' + i, cx - 45, 46); node('pv' + i, cx - 45, 122); node('pc' + i, cx - 30, 122, { spot: true, face: fR });
      walk(['pt' + i, 'pv' + i, 'pc' + i], { hidden: true });
    });
    walk(['pt0', 'pt1', 'pt2']);
    // Staging: a worker between the tote rows, crossing Aisle 3 on a crosswalk
    node('sa', 1072, 667, { spot: true, face: fU }); node('sb', 1150, 667, { spot: true, face: fD }); node('sc', 1232, 667);
    node('sd', 1328, 667); node('se', 1410, 667, { spot: true, face: fU }); node('sf', 1488, 667, { spot: true, face: fD });
    walk(['sa', 'sb', 'sc'], { hidden: true }); walk(['sc', 'sd']); walk(['sd', 'se', 'sf'], { hidden: true });
    // Pallet floor storage: a stock checker along the storage edge
    [1400, 1480, 1560, 1640, 1728].forEach((x, i) => node('fs' + i, x, 838, { spot: true, face: fD }));
    walk(['fs0', 'fs1', 'fs2', 'fs3', 'fs4']);

    // Shared aisles: a supervisor and an auditor walk the robot lanes themselves
    const lane = laneWalks(L, { nodes: pn, edges: pe }, [
      ['lm1', 'M6', 'M7', 140, [0, 1]], ['lm2', 'M7', 'M8', 140, [0, 1]],
      ['lh1', 'H1', 'H2', 140, [0, 1]], ['lh2', 'H4', 'H5', 150, [0, -1]],
      ['la1', 'N2', 'M4', 200, [1, 0]], ['la2', 'N2', 'M4', 330, [-1, 0]],
      ['lb1', 'B1', 'B2', 235, [0, -1]], ['lb2', 'B1', 'B2', 387, [0, -1]],
      ['lw1', 'W1', 'B1', 200, [1, 0]], ['lw2', 'N1', 'W1', 240, [1, 0]],
    ]);
    const spots = (re) => pn.filter((q) => q[3] && q[3].spot && re.test(q[0])).map((q) => q[0]);
    return addPeds(L, {
      nodes: pn, edges: pe,
      walkers: [
        { id: 'P1', role: 'Picker', vest: '#d8e02a', hat: '#f2f2ee', home: spots(/^(wn|an|ab|as|at)/) },
        { id: 'P2', role: 'Packer', vest: '#f08a24', hat: '#f2c230', home: spots(/^pc/) },
        { id: 'P3', role: 'Staging operator', vest: '#d8e02a', hat: '#3b6fd1', home: spots(/^s[a-f]$/) },
        { id: 'P4', role: 'Stock checker', vest: '#f08a24', hat: '#f2f2ee', home: spots(/^fs/) },
        { id: 'P5', role: 'Shift supervisor', vest: '#f08a24', hat: '#f2f2ee', home: lane },
        { id: 'P6', role: 'Inventory auditor', vest: '#d8e02a', hat: '#2f9e62', home: lane.filter((id) => /^l[abw]/.test(id)) },
      ],
    });
  }

  // ======================================================================== geometry helpers
  const TAU = Math.PI * 2;
  function angDiff(a, b) {
    let d = (a - b) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return d;
  }

  /** Sampled path with rounded corners, parametrised by arc length. */
  function Path(xs, ys, cs, vh, length, nodeS, corners) {
    this.xs = xs; this.ys = ys; this.cs = cs; this.vh = vh;
    this.n = xs.length; this.length = length; this.nodeS = nodeS; this.corners = corners;
  }
  Path.prototype.index = function (s) {
    const cs = this.cs;
    if (s <= 0) return 0;
    if (s >= this.length) return this.n - 1;
    let lo = 0, hi = this.n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cs[mid] <= s) lo = mid; else hi = mid;
    }
    return lo;
  };
  Path.prototype.at = function (s, out) {
    out = out || {};
    const k = this.index(s);
    if (k >= this.n - 1) {
      out.x = this.xs[this.n - 1]; out.y = this.ys[this.n - 1]; out.h = this.vh[this.n - 1];
      return out;
    }
    const seg = this.cs[k + 1] - this.cs[k];
    const t = seg > 1e-9 ? Math.min(1, Math.max(0, (s - this.cs[k]) / seg)) : 0;
    out.x = this.xs[k] + (this.xs[k + 1] - this.xs[k]) * t;
    out.y = this.ys[k] + (this.ys[k + 1] - this.ys[k]) * t;
    out.h = this.vh[k] + angDiff(this.vh[k + 1], this.vh[k]) * t;
    return out;
  };
  Path.prototype.headingAt = function (s) { return this.at(s).h; };

  function buildPath(pts, radius) {
    const xs = [], ys = [], cs = [];
    const nodeS = new Array(pts.length).fill(0);
    const corners = [];
    let total = 0;
    const push = (x, y) => {
      const n = xs.length;
      if (n) {
        const d = Math.hypot(x - xs[n - 1], y - ys[n - 1]);
        if (d < 1e-4) return;
        total += d;
      }
      xs.push(x); ys.push(y); cs.push(total);
    };
    const lineTo = (x, y) => {
      const n = xs.length, x0 = xs[n - 1], y0 = ys[n - 1];
      const d = Math.hypot(x - x0, y - y0);
      const steps = Math.max(1, Math.ceil(d / 5));
      for (let k = 1; k <= steps; k++) push(x0 + ((x - x0) * k) / steps, y0 + ((y - y0) * k) / steps);
    };
    push(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const P = pts[i];
      if (i === pts.length - 1) { lineTo(P.x, P.y); nodeS[i] = total; break; }
      const Pp = pts[i - 1], N = pts[i + 1];
      let d1x = P.x - Pp.x, d1y = P.y - Pp.y;
      const l1 = Math.hypot(d1x, d1y);
      let d2x = N.x - P.x, d2y = N.y - P.y;
      const l2 = Math.hypot(d2x, d2y);
      if (l1 < 1e-6 || l2 < 1e-6) { lineTo(P.x, P.y); nodeS[i] = total; continue; }
      d1x /= l1; d1y /= l1; d2x /= l2; d2y /= l2;
      const dot = d1x * d2x + d1y * d2y;
      const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (theta < 0.02 || theta > Math.PI - 0.05) { lineTo(P.x, P.y); nodeS[i] = total; continue; }
      const inAvail = Math.hypot(P.x - xs[xs.length - 1], P.y - ys[ys.length - 1]);
      const tanH = Math.tan(theta / 2);
      const t = Math.min(radius * tanH, inAvail - 0.01, l2 * 0.5);
      if (t < 0.5) { lineTo(P.x, P.y); nodeS[i] = total; continue; }
      const r = t / tanH;
      const ax = P.x - d1x * t, ay = P.y - d1y * t;
      const bx = P.x + d2x * t, by = P.y + d2y * t;
      lineTo(ax, ay);
      const s0 = total;
      let nx = d2x - d1x * dot, ny = d2y - d1y * dot;
      const nl = Math.hypot(nx, ny);
      nx /= nl; ny /= nl;
      const ccx = ax + nx * r, ccy = ay + ny * r;
      const a0 = Math.atan2(ay - ccy, ax - ccx);
      const sweep = angDiff(Math.atan2(by - ccy, bx - ccx), a0);
      const arcLen = Math.abs(sweep) * r;
      const steps = Math.max(3, Math.ceil(arcLen / 2));
      for (let k = 1; k <= steps; k++) {
        const a = a0 + (sweep * k) / steps;
        push(ccx + Math.cos(a) * r, ccy + Math.sin(a) * r);
      }
      nodeS[i] = s0 + arcLen / 2;
      corners.push({ s0, s1: total, r });
    }
    const n = xs.length;
    const seg = new Float64Array(Math.max(1, n - 1));
    for (let k = 0; k < n - 1; k++) seg[k] = Math.atan2(ys[k + 1] - ys[k], xs[k + 1] - xs[k]);
    const vh = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      if (n === 1) vh[k] = 0;
      else if (k === 0) vh[k] = seg[0];
      else if (k === n - 1) vh[k] = seg[n - 2];
      else vh[k] = seg[k - 1] + angDiff(seg[k], seg[k - 1]) / 2;
    }
    return new Path(xs, ys, cs, vh, total, nodeS, corners);
  }

  // ======================================================================== registry & routing
  const layouts = { 'bay-01': buildBay01(), 'bay-02': buildBay02() };
  const list = [layouts['bay-01'], layouts['bay-02']];

  function routeFromHash() {
    const h = ((root.location && root.location.hash) || '').replace(/^#/, '');
    const hit = list.find((l) => l.slug === h);
    return hit ? { view: 'console', layout: hit.id } : { view: 'home', layout: null };
  }
  // WH_LAYOUT lets headless tools (stress test) pick a layout without a URL.
  const route = root.WH_LAYOUT ? { view: 'console', layout: root.WH_LAYOUT } : routeFromHash();

  WH.layouts = layouts;
  WH.layoutList = list;
  WH.route = route;
  WH.world = layouts[route.layout] || layouts['bay-01'];
  WH.geom = { buildPath, angDiff, TAU };
})(typeof window !== 'undefined' ? window : globalThis);
