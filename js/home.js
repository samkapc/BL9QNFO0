/*
 * home.js — instances overview: one card per warehouse layout with a floor-plan preview drawn
 * from the layout data, plus the "Create instance" tile (UI only in this demo).
 */
(function (root) {
  'use strict';
  const WH = root.WH;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Preview colours for the two floor plan styles (the console itself is always dark)
  const PREVIEW = {
    dark: { bg: '#141619', floor: '#1b1e22', lane: '#262a2f', rack: '#2d3238', rackEdge: null, bay: '#262a2f', conveyor: '#4b525a',
      cube: '#2d3238', cell: '#24282d', area: '#212529', areaEdge: '#363b42', net: '#3d444c', station: '#6a737d', wall: '#4b525a', robot: '#4a5058' },
    light: { bg: '#d9dde1', floor: '#e7e9eb', lane: '#dcdfe2', rack: '#fbfbfc', rackEdge: '#d2bf98', bay: '#dcdfe2', conveyor: '#9aa3ab',
      cube: '#cfd4d8', cell: '#f1f2f3', area: '#eceef0', areaEdge: '#b6bcc2', net: '#c3c9ce', station: '#8f979f', wall: '#f6f7f8', wallEdge: '#a9b0b7', robot: '#474d55' },
  };

  /** Simplified floor plan of a layout, fitted into its canvas. */
  function drawPreview(canvas, L) {
    const P = PREVIEW[(WH.savedMapTheme && WH.savedMapTheme()) || 'light'];
    const box = canvas.parentElement.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const dpr = Math.min(2, root.devicePixelRatio || 1);
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
    const ctx = canvas.getContext('2d');
    const W = L.WALL, m = 26;
    const s = Math.min(box.width / (W.x1 - W.x0 + 2 * m), box.height / (W.y1 - W.y0 + 2 * m));
    const ox = (box.width - (W.x1 - W.x0) * s) / 2 - W.x0 * s;
    const oy = (box.height - (W.y1 - W.y0) * s) / 2 - W.y0 * s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    const px = 1 / s;
    ctx.fillStyle = P.floor;
    ctx.fillRect(W.x0, W.y0, W.x1 - W.x0, W.y1 - W.y0);
    // Lanes
    ctx.strokeStyle = P.lane;
    ctx.lineCap = 'square';
    for (const e of L.edges) {
      const A = L.nodeMap[e.a], B = L.nodeMap[e.b];
      ctx.lineWidth = e.kind === 'spur' ? 64 : L.AISLE;
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
    }
    // Racks and areas
    for (const rk of L.racks) {
      ctx.fillStyle = P.rack;
      ctx.fillRect(rk.x0, rk.y0, rk.x1 - rk.x0, rk.y1 - rk.y0);
      if (P.rackEdge) { ctx.strokeStyle = P.rackEdge; ctx.lineWidth = 1.2 * px; ctx.strokeRect(rk.x0, rk.y0, rk.x1 - rk.x0, rk.y1 - rk.y0); }
    }
    for (const b of L.bays) { ctx.fillStyle = P.bay; ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); }
    for (const a of L.areas) {
      if (a.kind === 'conveyor') {
        ctx.strokeStyle = P.conveyor;
        ctx.lineWidth = 14;
        ctx.lineCap = 'butt';
        ctx.beginPath();
        a.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        continue;
      }
      const w = a.x1 - a.x0, h = a.y1 - a.y0;
      ctx.fillStyle = a.kind === 'cube' ? P.cube : a.kind === 'cell' ? P.cell : P.area;
      ctx.fillRect(a.x0, a.y0, w, h);
      ctx.strokeStyle = P.areaEdge;
      ctx.lineWidth = px;
      ctx.strokeRect(a.x0, a.y0, w, h);
    }
    // Path network
    ctx.strokeStyle = P.net;
    ctx.lineWidth = px;
    for (const e of L.edges) {
      const A = L.nodeMap[e.a], B = L.nodeMap[e.b];
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
    }
    // Stations
    for (const st of L.stations) {
      ctx.strokeStyle = P.station;
      ctx.lineWidth = 1.2 * px;
      ctx.strokeRect(st.x - 28, st.y - 28, 56, 56);
    }
    // Walls and doors
    ctx.strokeStyle = P.wall;
    ctx.lineWidth = 8;
    ctx.strokeRect(W.x0 - 4, W.y0 - 4, W.x1 - W.x0 + 8, W.y1 - W.y0 + 8);
    if (P.wallEdge) {
      ctx.strokeStyle = P.wallEdge;
      ctx.lineWidth = px;
      ctx.strokeRect(W.x0, W.y0, W.x1 - W.x0, W.y1 - W.y0);
      ctx.strokeRect(W.x0 - 8, W.y0 - 8, W.x1 - W.x0 + 16, W.y1 - W.y0 + 16);
    }
    ctx.fillStyle = P.bg;
    for (const d of L.doors) {
      if (d.side === 'top') ctx.fillRect(d.pos - d.w / 2, W.y0 - 9, d.w, 10);
      else if (d.side === 'bottom') ctx.fillRect(d.pos - d.w / 2, W.y1 - 1, d.w, 10);
      else if (d.side === 'right') ctx.fillRect(W.x1 - 1, d.pos - d.w / 2, 10, d.w);
      else ctx.fillRect(W.x0 - 9, d.pos - d.w / 2, 10, d.w);
    }
    // Fleet at its start positions
    for (const r of L.robots) {
      const st = L.stationMap[r.start];
      ctx.save();
      ctx.translate(st.x, st.y);
      ctx.rotate(Math.atan2(st.dir.y, st.dir.x));
      ctx.fillStyle = P.robot;
      ctx.fillRect(-24, -17, 48, 34);
      ctx.fillStyle = r.color;
      ctx.fillRect(-24, -17, 7, 34);
      ctx.restore();
    }
  }

  function cardHTML(L) {
    const nodes = L.nodes.filter((n) => n.kind !== 'station').length;
    const segs = L.edges.filter((e) => e.kind !== 'spur').length;
    const zones = [...new Set(L.stations.map((s) => L.zoneNames[s.zone]))];
    return `
      <a class="inst" href="#${L.slug}" aria-label="Open ${esc(L.name)} (instance ${L.instance})">
        <div class="inst-thumb" style="aspect-ratio:${L.W} / ${L.H}"><canvas data-layout="${L.id}" aria-hidden="true"></canvas></div>
        <div class="inst-body">
          <div class="inst-top"><span class="inst-no">Instance ${L.instance}</span><span class="inst-state"><i class="led ok"></i>Ready</span></div>
          <h2>${esc(L.name)} <span class="inst-kind">${esc(L.kind)}</span></h2>
          <p class="inst-sum">${esc(L.summary)}</p>
          <dl class="inst-meta">
            <div><dt>Floor</dt><dd>${L.floorM[0].toFixed(1)} × ${L.floorM[1].toFixed(1)} m</dd></div>
            <div><dt>Robots · people</dt><dd>${L.robots.length} · ${L.peds ? L.peds.walkers.length : 0}</dd></div>
            <div><dt>Stations</dt><dd>${L.stations.length}</dd></div>
            <div><dt>Nodes · path segments</dt><dd>${nodes} · ${segs}</dd></div>
          </dl>
          <p class="inst-zones">${zones.map((z) => `<span>${esc(z)}</span>`).join('')}</p>
        </div>
        <div class="inst-foot"><span>Open console</span><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg></div>
      </a>`;
  }

  class Home {
    constructor(el) {
      this.el = el;
      this.grid = el.querySelector('#instGrid');
      const create = this.grid.querySelector('.inst-new');
      this.grid.insertAdjacentHTML('afterbegin', WH.layoutList.map(cardHTML).join(''));
      this.grid.appendChild(create);
      document.getElementById('instCount').textContent = `${WH.layoutList.length} instances`;
      this.draw();
      let pending = false;
      const redraw = () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; this.draw(); });
      };
      if (root.ResizeObserver) new ResizeObserver(redraw).observe(this.grid);
      else root.addEventListener('resize', redraw);
    }
    draw() {
      this.grid.querySelectorAll('canvas[data-layout]').forEach((cv) => drawPreview(cv, WH.layouts[cv.dataset.layout]));
    }
  }

  WH.Home = Home;
})(window);
