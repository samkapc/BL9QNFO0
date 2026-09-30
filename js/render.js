/*
 * render.js — floor map renderer for the EdgeFleet console.
 *
 * Drawn as a facility map, the way fleet-management software shows a site: flat surfaces,
 * building column grid, rack slots, the path network and its nodes, traffic zones.
 * The static layer is cached and re-rendered only when the view (zoom/pan/size) settles.
 */
(function (root) {
  'use strict';
  const WH = (root.WH = root.WH || {});
  const Wd = WH.world;

  const FONT = {
    sans: '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif',
    mono: '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace',
  };
  const C = {
    bg: '#141619',
    floor: '#191c1f',
    lane: '#22262b',
    grid: '#2a2f35',
    gridText: '#7f8791',
    wall: '#2f343a',
    wallEdge: '#4b525a',
    rack: '#24282d',
    rackEdge: '#3a4047',
    slot: '#2d3238',
    slotEdge: '#383e45',
    beam: '#4d545c',
    net: '#353c44',
    node: '#6a737d',
    zone: '#3a414a',
    label: '#6b737d',
    labelHi: '#8d959f',
    text: '#e1e4e8',
    text2: '#a0a7b0',
    tagBg: 'rgba(15,17,19,0.92)',
    tagEdge: '#3a4047',
    ok: '#3ea86b',
    warn: '#e3a42b',
    alarm: '#e5534b',
    work: '#5b9cf5',
    idle: '#8a919b',
    payload: '#a88353',
  };
  const TONE = { drive: C.ok, wait: C.warn, work: C.work, idle: C.idle, fault: C.alarm };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const rgbaCache = new Map();
  function rgba(hex, a) {
    let c = rgbaCache.get(hex);
    if (!c) {
      c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',');
      rgbaCache.set(hex, c);
    }
    return `rgba(${c},${a})`;
  }
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Building column grid (structural bays) and view bounds come with the layout
  const GRID_X = Wd.grid.xs, GRID_Y = Wd.grid.ys;
  const BOUNDS = Wd.bounds;

  class Renderer {
    constructor(canvas, sim) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.sim = sim;
      this.stat = document.createElement('canvas');
      this.layers = { paths: true, reservations: true, comms: true, safety: false, labels: true };
      this.tool = 'select';
      this.selected = -1;
      this.hover = null;
      this.k = 1;
      this.cx = (BOUNDS.x0 + BOUNDS.x1) / 2;
      this.cy = (BOUNDS.y0 + BOUNDS.y1) / 2;
      this.statView = null;
      this.viewChangedAt = 0;
      this.tmp = { x: 0, y: 0, h: 0 };
      this.resize();
    }

    // ------------------------------------------------------------------ view
    resize() {
      const box = this.cv.parentElement.getBoundingClientRect();
      this.dpr = Math.min(2, root.devicePixelRatio || 1);
      this.cw = Math.max(200, box.width);
      this.ch = Math.max(150, box.height);
      this.cv.width = Math.round(this.cw * this.dpr);
      this.cv.height = Math.round(this.ch * this.dpr);
      this.cv.style.width = this.cw + 'px';
      this.cv.style.height = this.ch + 'px';
      this.stat.width = this.cv.width;
      this.stat.height = this.cv.height;
      const pad = this.cw < 700 ? 4 : 10;
      this.fitScale = Math.min((this.cw - pad * 2) / (BOUNDS.x1 - BOUNDS.x0), (this.ch - pad * 2) / (BOUNDS.y1 - BOUNDS.y0));
      this.clampView();
      this.applyView();
      this.drawStatic();
      if (this.ready) this.draw();
      this.ready = true;
    }
    applyView() {
      this.scale = this.fitScale * this.k;
      this.ox = this.cw / 2 - this.cx * this.scale;
      this.oy = this.ch / 2 - this.cy * this.scale;
      this.compact = this.scale < 0.45;
    }
    clampView() {
      const s = this.fitScale * this.k;
      const hw = this.cw / 2 / s, hh = this.ch / 2 / s;
      const mx = (BOUNDS.x0 + BOUNDS.x1) / 2, my = (BOUNDS.y0 + BOUNDS.y1) / 2;
      this.cx = hw * 2 >= BOUNDS.x1 - BOUNDS.x0 ? mx : clamp(this.cx, BOUNDS.x0 + hw, BOUNDS.x1 - hw);
      this.cy = hh * 2 >= BOUNDS.y1 - BOUNDS.y0 ? my : clamp(this.cy, BOUNDS.y0 + hh, BOUNDS.y1 - hh);
    }
    viewChanged() { this.clampView(); this.applyView(); this.viewChangedAt = performance.now(); }
    zoomAt(px, py, factor) {
      const w = this.toWorld(px, py);
      const k = clamp(this.k * factor, 1, 6);
      if (Math.abs(k - this.k) < 1e-6) return;
      this.k = k;
      const s = this.fitScale * k;
      this.cx = w.x - (px - this.cw / 2) / s;
      this.cy = w.y - (py - this.ch / 2) / s;
      this.viewChanged();
    }
    zoomBy(factor) { this.zoomAt(this.cw / 2, this.ch / 2, factor); }
    panBy(dx, dy) {
      this.cx -= dx / this.scale;
      this.cy -= dy / this.scale;
      this.viewChanged();
    }
    fit() {
      this.k = 1;
      this.cx = (BOUNDS.x0 + BOUNDS.x1) / 2;
      this.cy = (BOUNDS.y0 + BOUNDS.y1) / 2;
      this.viewChanged();
    }
    viewKey() { return `${this.scale.toFixed(5)}|${this.ox.toFixed(2)}|${this.oy.toFixed(2)}|${this.cv.width}x${this.cv.height}|${this.layers.labels}`; }

    px(n) { return n / this.scale; }
    sx(x) { return this.ox + x * this.scale; }
    sy(y) { return this.oy + y * this.scale; }
    toWorld(px, py) { return { x: (px - this.ox) / this.scale, y: (py - this.oy) / this.scale }; }
    setWorld(ctx) {
      const k = this.dpr * this.scale;
      ctx.setTransform(k, 0, 0, k, this.dpr * this.ox, this.dpr * this.oy);
    }
    setScreen(ctx) { ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }
    fs(base) { return Math.round(clamp(base * Math.pow(this.scale / 0.9, 0.35), base * 0.85, base * 1.25)); }

    // ------------------------------------------------------------------ static layer
    drawStatic() {
      const ctx = this.stat.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, this.stat.width, this.stat.height);
      this.setWorld(ctx);
      this.drawFloor(ctx);
      this.drawAreas(ctx, false);
      this.drawLanes(ctx);
      const rng = mulberry32(20240517);
      Wd.racks.forEach((rk) => this.drawRack(ctx, rk, rng));
      this.drawBays(ctx);
      for (const st of Wd.stations) this.drawStationBase(ctx, st);
      this.drawNetwork(ctx);
      this.drawAreas(ctx, true);
      this.drawWalls(ctx);
      this.setScreen(ctx);
      this.drawStaticLabels(ctx);
      this.statView = { key: this.viewKey(), scale: this.scale, ox: this.ox, oy: this.oy };
    }

    drawFloor(ctx) {
      const { x0, y0, x1, y1 } = Wd.WALL;
      ctx.fillStyle = C.floor;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = this.px(1);
      ctx.setLineDash([22, 5, 3, 5]);
      for (const x of GRID_X) { ctx.beginPath(); ctx.moveTo(x, -8); ctx.lineTo(x, y1); ctx.stroke(); }
      for (const y of GRID_Y) { ctx.beginPath(); ctx.moveTo(-8, y); ctx.lineTo(x1, y); ctx.stroke(); }
      ctx.setLineDash([]);
    }

    // Storage and process areas. Overhead equipment is drawn after the path network.
    drawAreas(ctx, overheadPass) {
      const rng = mulberry32(99);
      for (const a of Wd.areas) {
        if (!!(a.kind === 'conveyor' && a.overhead) !== overheadPass) continue;
        const w = (a.x1 || 0) - (a.x0 || 0), h = (a.y1 || 0) - (a.y0 || 0);
        ctx.lineWidth = this.px(1);
        if (a.kind !== 'conveyor' && a.kind !== 'cube') {
          ctx.setLineDash([6, 4]);
          ctx.strokeStyle = C.zone;
          ctx.strokeRect(a.x0, a.y0, w, h);
          ctx.setLineDash([]);
        }
        if (a.kind === 'staging') {
          const cols = Math.max(1, Math.floor((w - 16) / 58));
          const sw = 48, sh = 40, gx = (w - cols * sw) / (cols + 1);
          for (let c = 0; c < cols; c++) {
            for (let r = 0; r < 2; r++) {
              const x = a.x0 + gx + c * (sw + gx), y = a.y0 + 8 + r * (sh + 8);
              if (y + sh > a.y1 - 4) continue;
              this.slot(ctx, x, y, sw, sh, rng() < 0.55);
            }
          }
        } else if (a.kind === 'pallets') {
          const cw = (w - 12) / a.cols, ch = (h - 12) / a.rows;
          const s = Math.min(cw, ch) - 8;
          for (let c = 0; c < a.cols; c++) {
            for (let r = 0; r < a.rows; r++) {
              this.slot(ctx, a.x0 + 6 + c * cw + (cw - s) / 2, a.y0 + 6 + r * ch + (ch - s) / 2, s, s, rng() < 0.78);
            }
          }
        } else if (a.kind === 'totes') {
          const n = Math.floor((w - 12) / 22);
          const gx = (w - n * 22) / 2 + 4;
          for (const y of [a.y0 + 18, a.y1 - 32]) {
            for (let i = 0; i < n; i++) this.slot(ctx, a.x0 + gx + i * 22, y, 14, 14, rng() < 0.7);
          }
        } else if (a.kind === 'carts') {
          const n = Math.floor((w - 16) / 30), rows = Math.floor((h - 12) / 46);
          for (let r = 0; r < rows; r++) {
            for (let i = 0; i < n; i++) {
              if (rng() < 0.25) continue;
              const x = a.x0 + 12 + i * 30, y = a.y0 + 10 + r * 46;
              ctx.fillStyle = '#23272b';
              ctx.fillRect(x, y, 20, 32);
              ctx.strokeStyle = C.slotEdge;
              ctx.strokeRect(x, y, 20, 32);
              ctx.beginPath(); ctx.moveTo(x + 3, y + 36); ctx.lineTo(x + 17, y + 36); ctx.stroke();
            }
          }
        } else if (a.kind === 'cube') {
          ctx.fillStyle = '#1f2327';
          ctx.fillRect(a.x0, a.y0, w, h);
          ctx.strokeStyle = '#2b3036';
          ctx.beginPath();
          for (let x = a.x0 + 13; x < a.x1; x += 13) { ctx.moveTo(x, a.y0); ctx.lineTo(x, a.y1); }
          for (let y = a.y0 + 13; y < a.y1; y += 13) { ctx.moveTo(a.x0, y); ctx.lineTo(a.x1, y); }
          ctx.stroke();
          ctx.fillStyle = '#343a41';
          for (let k = 0; k < 7; k++) {
            const cx = a.x0 + 13 * Math.floor(rng() * (w / 13)), cy = a.y0 + 13 * Math.floor(rng() * (h / 13));
            ctx.fillRect(cx + 2, cy + 2, 9, 9);
          }
          ctx.strokeStyle = C.rackEdge;
          ctx.strokeRect(a.x0, a.y0, w, h);
        } else if (a.kind === 'cell') {
          const cx = (a.x0 + a.x1) / 2;
          ctx.fillStyle = '#262a2f';
          ctx.fillRect(a.x0 + 12, a.y1 - 48, w - 24, 26);
          ctx.strokeStyle = '#454c55';
          ctx.strokeRect(a.x0 + 12, a.y1 - 48, w - 24, 26);
          ctx.fillStyle = '#23272b';
          ctx.beginPath(); ctx.arc(cx, a.y0 + 36, 11, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = C.node;
          ctx.lineWidth = this.px(1.2);
          ctx.stroke();
          ctx.strokeStyle = '#5a626b';
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(cx, a.y0 + 36); ctx.lineTo(cx + 20, a.y0 + 52); ctx.lineTo(cx + 12, a.y0 + 70); ctx.stroke();
          ctx.lineCap = 'butt';
          ctx.fillStyle = '#2d3238';
          ctx.fillRect(cx - 34, a.y0 + 14, 16, 22);
          ctx.fillRect(cx + 20, a.y0 + 14, 16, 22);
        } else if (a.kind === 'conveyor') {
          const trace = () => {
            ctx.beginPath();
            a.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          };
          ctx.lineJoin = 'miter';
          trace();
          ctx.strokeStyle = a.overhead ? 'rgba(90,98,107,0.9)' : '#4b525a';
          ctx.lineWidth = 16;
          if (a.overhead) ctx.setLineDash([10, 5]);
          ctx.stroke();
          ctx.setLineDash([]);
          trace();
          ctx.strokeStyle = a.overhead ? 'rgba(27,30,34,0.92)' : '#23272c';
          ctx.lineWidth = 13;
          ctx.stroke();
          trace();
          ctx.setLineDash([1.4, 6.6]);
          ctx.strokeStyle = '#3d434b';
          ctx.lineWidth = 11;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineJoin = 'round';
        }
      }
    }

    slot(ctx, x, y, w, h, used) {
      if (used) { ctx.fillStyle = C.slot; ctx.fillRect(x, y, w, h); }
      ctx.strokeStyle = used ? C.slotEdge : C.grid;
      ctx.lineWidth = this.px(1);
      ctx.strokeRect(x, y, w, h);
    }

    laneRect(ctx, e, inset, trim) {
      const A = Wd.nodeMap[e.a], B = Wd.nodeMap[e.b];
      const len = e.len, ux = (B.x - A.x) / len, uy = (B.y - A.y) / len;
      const half = (e.kind === 'spur' ? 32 : Wd.HALF) - inset;
      const t0 = trim && A.kind !== 'station' ? trim : 0;
      const t1 = trim && B.kind !== 'station' ? len - trim : len;
      const nx = -uy, ny = ux;
      ctx.beginPath();
      ctx.moveTo(A.x + ux * t0 + nx * half, A.y + uy * t0 + ny * half);
      ctx.lineTo(A.x + ux * t1 + nx * half, A.y + uy * t1 + ny * half);
      ctx.lineTo(A.x + ux * t1 - nx * half, A.y + uy * t1 - ny * half);
      ctx.lineTo(A.x + ux * t0 - nx * half, A.y + uy * t0 - ny * half);
      ctx.closePath();
    }

    drawLanes(ctx) {
      const H = Wd.HALF;
      ctx.fillStyle = C.lane;
      for (const e of Wd.edges) { this.laneRect(ctx, e, 0, 0); ctx.fill(); }
      for (const n of Wd.nodes) if (n.kind === 'cross') ctx.fillRect(n.x - H, n.y - H, H * 2, H * 2);
      // Intersection traffic zones
      ctx.strokeStyle = C.zone;
      ctx.lineWidth = this.px(1);
      ctx.setLineDash([4, 3]);
      for (const n of Wd.nodes) if (n.kind === 'cross') ctx.strokeRect(n.x - H + 2, n.y - H + 2, 2 * H - 4, 2 * H - 4);
      ctx.setLineDash([]);
    }

    drawRack(ctx, rk, rng) {
      const { x0, x1, y0, y1, faces } = rk;
      ctx.fillStyle = C.rack;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      if (faces.length === 2) {
        const m = (x0 + x1) / 2;
        this.drawRackRow(ctx, x0, m - 3, y0, y1, 'left', rng, rk.pitch);
        this.drawRackRow(ctx, m + 3, x1, y0, y1, 'right', rng, rk.pitch);
      } else this.drawRackRow(ctx, x0, x1, y0, y1, faces[0], rng, rk.pitch);
      ctx.strokeStyle = C.rackEdge;
      ctx.lineWidth = this.px(1);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }

    drawRackRow(ctx, x0, x1, y0, y1, face, rng, pitch) {
      const depth = x1 - x0;
      const nBays = Math.max(1, Math.round((y1 - y0) / (pitch || 53)));
      const bl = (y1 - y0) / nBays;
      const deep = depth > 100 ? 2 : 1;
      const pd = depth / deep;
      const inset = pd < 40 ? 2 : 3;
      ctx.lineWidth = this.px(1);
      for (let b = 0; b < nBays; b++) {
        for (let d = 0; d < deep; d++) {
          const x = x0 + d * pd + inset, y = y0 + b * bl + inset, w = pd - 2 * inset, h = bl - 2 * inset;
          if (rng() < 0.82) {
            ctx.fillStyle = C.slot;
            ctx.fillRect(x, y, w, h);
            ctx.strokeStyle = C.slotEdge;
          } else ctx.strokeStyle = C.grid;
          ctx.strokeRect(x, y, w, h);
        }
      }
      const faceX = face === 'left' ? x0 : x1;
      ctx.fillStyle = C.beam;
      ctx.fillRect(faceX - 1, y0, 2, y1 - y0);
      const u = Math.max(1, Math.round(53 / bl));
      for (let b = 0; b <= nBays; b += u) ctx.fillRect(faceX - 2.5, y0 + b * bl - 2.5, 5, 5);
    }

    drawBays(ctx) {
      for (const b of Wd.bays) {
        ctx.fillStyle = C.lane;
        ctx.fillRect(b.x0 - 1, b.y0, b.x1 - b.x0 + 1, b.y1 - b.y0);
        ctx.strokeStyle = C.rackEdge;
        ctx.lineWidth = this.px(1);
        ctx.beginPath();
        ctx.moveTo(b.x0, b.y0); ctx.lineTo(b.x1, b.y0); ctx.lineTo(b.x1, b.y1); ctx.lineTo(b.x0, b.y1);
        ctx.stroke();
      }
    }

    drawStationBase(ctx, st) {
      ctx.save();
      ctx.translate(st.x, st.y);
      ctx.rotate(Math.atan2(st.dir.y, st.dir.x));
      ctx.fillStyle = 'rgba(255,255,255,0.015)';
      ctx.fillRect(-30, -30, 60, 60);
      ctx.strokeStyle = '#5a636d';
      ctx.lineWidth = this.px(1);
      ctx.strokeRect(-30, -30, 60, 60);
      // Docking direction
      ctx.strokeStyle = '#444b53';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-8, -9); ctx.lineTo(2, 0); ctx.lineTo(-8, 9); ctx.stroke();
      // Transfer conveyor
      ctx.fillStyle = '#22262b';
      ctx.fillRect(28, -26, 30, 52);
      ctx.strokeStyle = '#4a525b';
      ctx.lineWidth = this.px(1);
      ctx.strokeRect(28, -26, 30, 52);
      ctx.strokeStyle = '#30353c';
      for (let x = 32; x <= 54; x += 4) { ctx.beginPath(); ctx.moveTo(x, -23); ctx.lineTo(x, 23); ctx.stroke(); }
      ctx.restore();
    }

    drawNetwork(ctx) {
      ctx.strokeStyle = C.net;
      ctx.lineWidth = this.px(1);
      for (const e of Wd.edges) {
        const A = Wd.nodeMap[e.a], B = Wd.nodeMap[e.b];
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
      }
      for (const n of Wd.nodes) {
        if (n.kind === 'station') {
          ctx.fillStyle = C.node;
          ctx.fillRect(n.x - 2.5, n.y - 2.5, 5, 5);
          continue;
        }
        const r = n.kind === 'cross' ? 3.6 : 2.6;
        ctx.fillStyle = C.floor;
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = C.node;
        ctx.lineWidth = this.px(1.2);
        ctx.stroke();
      }
    }

    drawWalls(ctx) {
      const { x0, y0, x1, y1 } = Wd.WALL;
      const T = 8;
      ctx.fillStyle = C.wall;
      ctx.fillRect(x0 - T, y0 - T, x1 - x0 + 2 * T, T);
      ctx.fillRect(x0 - T, y1, x1 - x0 + 2 * T, T);
      ctx.fillRect(x0 - T, y0, T, y1 - y0);
      ctx.fillRect(x1, y0, T, y1 - y0);
      ctx.strokeStyle = C.wallEdge;
      ctx.lineWidth = this.px(1);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeRect(x0 - T, y0 - T, x1 - x0 + 2 * T, y1 - y0 + 2 * T);
      // Dock door openings with roller-door lines
      for (const d of Wd.doors) {
        const hw = d.w / 2;
        ctx.strokeStyle = '#6a737d';
        if (d.side === 'top' || d.side === 'bottom') {
          const y = d.side === 'top' ? y0 : y1, s = d.side === 'top' ? -1 : 1, x = d.pos;
          ctx.fillStyle = C.bg;
          ctx.fillRect(x - hw, s < 0 ? y - T - 1 : y, d.w, T + 1);
          ctx.fillStyle = C.floor;
          ctx.fillRect(x - hw, y - 1, d.w, 2);
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(x - hw, y + s * T * 0.5); ctx.lineTo(x + hw, y + s * T * 0.5); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = C.wallEdge;
          ctx.fillRect(x - hw - 2, s < 0 ? y - T : y, 2, T);
          ctx.fillRect(x + hw, s < 0 ? y - T : y, 2, T);
        } else {
          const x = d.side === 'left' ? x0 : x1, s = d.side === 'left' ? -1 : 1, y = d.pos;
          ctx.fillStyle = C.bg;
          ctx.fillRect(s < 0 ? x - T - 1 : x, y - hw, T + 1, d.w);
          ctx.fillStyle = C.floor;
          ctx.fillRect(x - 1, y - hw, 2, d.w);
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(x + s * T * 0.5, y - hw); ctx.lineTo(x + s * T * 0.5, y + hw); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = C.wallEdge;
          ctx.fillRect(s < 0 ? x - T : x, y - hw - 2, T, 2);
          ctx.fillRect(s < 0 ? x - T : x, y + hw, T, 2);
        }
      }
      // Structural columns where the grid meets the walls (none inside door openings)
      const clear = (side, p) => !Wd.doors.some((d) => d.side === side && Math.abs(d.pos - p) < d.w / 2 + 10);
      ctx.fillStyle = '#3d434a';
      for (const x of GRID_X) {
        if (clear('top', x)) ctx.fillRect(x - 7, y0 - T / 2 - 7, 14, 14);
        if (clear('bottom', x)) ctx.fillRect(x - 7, y1 + T / 2 - 7, 14, 14);
      }
      for (const y of GRID_Y) {
        if (clear('left', y)) ctx.fillRect(x0 - T / 2 - 7, y - 7, 14, 14);
        if (clear('right', y)) ctx.fillRect(x1 + T / 2 - 7, y - 7, 14, 14);
      }
    }

    drawStaticLabels(ctx) {
      ctx.textBaseline = 'middle';
      // Grid bubbles
      const br = clamp(8 * Math.sqrt(this.scale / 0.7), 6, 11);
      ctx.font = `500 ${Math.round(br * 1.15)}px ${FONT.sans}`;
      ctx.textAlign = 'center';
      const bubble = (x, y, t) => {
        ctx.beginPath(); ctx.arc(x, y, br, 0, Math.PI * 2);
        ctx.fillStyle = C.bg; ctx.fill();
        ctx.strokeStyle = '#4a5159'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = C.gridText; ctx.fillText(t, x, y + 0.5);
      };
      GRID_X.forEach((x, i) => bubble(this.sx(x), this.sy(-16), String(i + 1)));
      GRID_Y.forEach((y, i) => bubble(this.sx(-16), this.sy(y), String.fromCharCode(65 + i)));
      if (!this.layers.labels || this.compact) return;
      const f = (w, size, fam) => `${w} ${this.fs(size)}px ${fam}`;
      // Zone, aisle and lane names from the layout
      for (const lb of Wd.labels) {
        ctx.font = f(lb.weight || 400, lb.size || 10, FONT.sans);
        ctx.fillStyle = C.label;
        ctx.textAlign = lb.align || 'center';
        if (lb.rot) {
          ctx.save();
          ctx.translate(this.sx(lb.x), this.sy(lb.y));
          ctx.rotate((lb.rot * Math.PI) / 180);
          ctx.fillText(lb.text, 0, 0);
          ctx.restore();
        } else ctx.fillText(lb.text, this.sx(lb.x), this.sy(lb.y));
      }
      // Area names
      for (const a of Wd.areas) {
        if (!a.label) continue;
        if (a.kind === 'cell') {
          ctx.font = f(500, 9.5, FONT.mono);
          ctx.textAlign = 'center';
          ctx.fillStyle = C.labelHi;
          ctx.fillText(a.label, this.sx((a.x0 + a.x1) / 2), this.sy(a.y0) + 10);
          continue;
        }
        ctx.font = f(500, 9.5, FONT.sans);
        ctx.textAlign = 'left';
        const x = a.kind === 'conveyor' ? this.sx(a.lx) : this.sx(a.x0) + 4;
        const y = a.kind === 'conveyor' ? this.sy(a.ly) : this.sy(a.y0) + 10;
        const tw = ctx.measureText(a.label).width;
        ctx.fillStyle = 'rgba(20,22,25,0.85)';
        ctx.fillRect(x - 3, y - 7, tw + 6, 14);
        ctx.fillStyle = C.label;
        ctx.fillText(a.label, x, y + 0.5);
      }
      // Rack ids
      ctx.font = f(500, 9.5, FONT.mono);
      ctx.textAlign = 'center';
      Wd.racks.forEach((rk) => {
        const x = this.sx((rk.x0 + rk.x1) / 2), y = this.sy(rk.y1) - 8;
        const w = ctx.measureText(rk.id).width + 8;
        ctx.fillStyle = C.rack;
        ctx.fillRect(x - w / 2, y - 7, w, 14);
        ctx.fillStyle = C.label;
        ctx.fillText(rk.id, x, y + 0.5);
      });
      // Doors
      ctx.font = f(500, 9, FONT.mono);
      ctx.fillStyle = C.label;
      const { x0, y0, x1, y1 } = Wd.WALL;
      for (const d of Wd.doors) {
        const hw = d.w / 2;
        if (d.side === 'top' || d.side === 'bottom') {
          ctx.textAlign = 'left';
          ctx.fillText(d.label, this.sx(d.pos + hw + 4), this.sy(d.side === 'top' ? y0 + 9 : y1 - 9));
        } else {
          ctx.textAlign = d.side === 'right' ? 'right' : 'left';
          ctx.fillText(d.label, this.sx(d.side === 'right' ? x1 - 5 : x0 + 5), this.sy(d.pos + hw + 9));
        }
      }
      // Node ids
      ctx.font = f(500, 10, FONT.mono);
      for (const n of Wd.nodes) {
        if (n.kind === 'cross') {
          ctx.textAlign = 'left';
          ctx.fillStyle = C.labelHi;
          ctx.fillText(n.id, this.sx(n.x - Wd.HALF + 5), this.sy(n.y - Wd.HALF + 10));
        } else if (n.kind === 'junction') {
          ctx.textAlign = 'right';
          ctx.fillStyle = C.label;
          ctx.fillText(n.id, this.sx(n.x - 8), this.sy(n.y + 14));
        }
      }
    }

    // ------------------------------------------------------------------ frame
    draw() {
      const ctx = this.ctx;
      const key = this.viewKey();
      if (!this.statView || (this.statView.key !== key && performance.now() - this.viewChangedAt > 160)) this.drawStatic();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const sv = this.statView;
      if (sv.key === key) ctx.drawImage(this.stat, 0, 0);
      else {
        ctx.fillStyle = C.bg;
        ctx.fillRect(0, 0, this.cv.width, this.cv.height);
        const k = this.scale / sv.scale;
        ctx.drawImage(this.stat, (this.ox - sv.ox * k) * this.dpr, (this.oy - sv.oy * k) * this.dpr, this.stat.width * k, this.stat.height * k);
      }
      const L = this.layers;
      this.setWorld(ctx);
      this.drawObstructions(ctx);
      if (L.reservations) this.drawReservations(ctx);
      this.drawStationsDyn(ctx);
      if (L.paths) { this.drawPreviews(ctx); this.drawGhosts(ctx); this.drawRoutes(ctx); }
      this.drawConflicts(ctx);
      this.drawHover(ctx);
      if (L.safety) this.drawSafety(ctx);
      for (const r of this.sim.robots) this.drawRobot(ctx, r);
      for (const r of this.sim.robots) this.drawTransfer(ctx, r);
      this.drawSelection(ctx);
      if (L.comms) this.drawLinks(ctx);
      this.setScreen(ctx);
      if (L.labels) this.drawStationLabels(ctx);
      this.drawZoneLabels(ctx);
      this.drawRobotTags(ctx);
      if (L.comms) this.drawCallouts(ctx);
    }

    pathSeg(geo, a, b) {
      const p = new Path2D();
      if (b <= a) return p;
      const t = this.tmp;
      geo.at(a, t);
      p.moveTo(t.x, t.y);
      for (let k = geo.index(a) + 1; k < geo.n && geo.cs[k] < b; k++) p.lineTo(geo.xs[k], geo.ys[k]);
      geo.at(b, t);
      p.lineTo(t.x, t.y);
      return p;
    }
    dimFor(i) { return this.selected >= 0 && this.selected !== i ? 0.3 : 1; }

    drawObstructions(ctx) {
      const sim = this.sim;
      for (const eid in sim.obstructions) {
        const o = sim.obstructions[eid];
        const e = Wd.edgeMap[eid];
        const A = Wd.nodeMap[e.a], B = Wd.nodeMap[e.b];
        const closing = o.state === 'closing';
        const col = closing ? C.warn : C.alarm;
        this.laneRect(ctx, e, 4, Wd.HALF + 2);
        ctx.fillStyle = rgba(col, closing ? 0.06 : 0.1);
        ctx.fill();
        if (!closing) {
          ctx.save();
          this.laneRect(ctx, e, 4, Wd.HALF + 2);
          ctx.clip();
          ctx.strokeStyle = rgba(C.alarm, 0.45);
          ctx.lineWidth = this.px(1.2);
          const x0 = Math.min(A.x, B.x) - 60, x1 = Math.max(A.x, B.x) + 60;
          const y0 = Math.min(A.y, B.y) - 60, y1 = Math.max(A.y, B.y) + 60;
          ctx.beginPath();
          for (let k = x0 - (y1 - y0); k < x1; k += 9) { ctx.moveTo(k, y1); ctx.lineTo(k + (y1 - y0), y0); }
          ctx.stroke();
          ctx.restore();
        }
        this.laneRect(ctx, e, 4, Wd.HALF + 2);
        ctx.setLineDash(closing ? [5, 4] : []);
        ctx.strokeStyle = rgba(col, 0.9);
        ctx.lineWidth = this.px(1.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    drawReservations(ctx) {
      const H = Wd.HALF;
      for (const r of this.sim.robots) {
        const a = this.dimFor(r.i);
        for (const eid of r.held.edges) {
          const e = Wd.edgeMap[eid];
          this.laneRect(ctx, e, 9, e.kind === 'spur' ? 0 : H);
          ctx.fillStyle = rgba(r.color, 0.12 * a);
          ctx.fill();
        }
        for (const nid of r.held.nodes) {
          const n = Wd.nodeMap[nid];
          if (n.kind !== 'cross') continue;
          ctx.fillStyle = rgba(r.color, 0.12 * a);
          ctx.fillRect(n.x - H + 2, n.y - H + 2, 2 * H - 4, 2 * H - 4);
          ctx.strokeStyle = rgba(r.color, 0.55 * a);
          ctx.lineWidth = this.px(1);
          ctx.strokeRect(n.x - H + 2, n.y - H + 2, 2 * H - 4, 2 * H - 4);
        }
      }
    }

    drawRoutes(ctx) {
      const sim = this.sim;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const r of sim.robots) {
        if (!r.route) continue;
        const R = r.route, geo = R.geo, a = this.dimFor(r.i);
        const gi = R.idx + R.granted;
        const claimEnd = gi < R.nodes.length ? Math.max(r.s, R.nodeS[gi] - sim.cfg.stopDist) : geo.length;
        ctx.strokeStyle = rgba(r.color, 0.95 * a);
        ctx.lineWidth = this.px(this.selected === r.i ? 3 : 2.2);
        ctx.stroke(this.pathSeg(geo, r.s, claimEnd));
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = rgba(r.color, 0.7 * a);
        ctx.lineWidth = this.px(1.4);
        ctx.stroke(this.pathSeg(geo, claimEnd, geo.length));
        ctx.setLineDash([]);
        const g = Wd.nodeMap[R.goal];
        ctx.strokeStyle = rgba(r.color, 0.95 * a);
        ctx.lineWidth = this.px(1.6);
        ctx.strokeRect(g.x - 30, g.y - 30, 60, 60);
      }
    }

    drawPreviews(ctx) {
      for (const r of this.sim.robots) {
        if (!r.task || !r.task.preview || r.mode !== 'toPickup') continue;
        ctx.setLineDash([2, 6]);
        ctx.strokeStyle = rgba(r.color, 0.4 * this.dimFor(r.i));
        ctx.lineWidth = this.px(1.2);
        ctx.stroke(this.pathSeg(r.task.preview, 0, r.task.preview.length));
        ctx.setLineDash([]);
      }
    }

    drawGhosts(ctx) {
      const t = this.sim.t;
      for (const g of this.sim.fx.ghosts) {
        if (g.pts.length < 4) continue;
        const a = (1 - (t - g.t0) / g.dur) * 0.7;
        ctx.beginPath();
        ctx.moveTo(g.pts[0], g.pts[1]);
        for (let i = 2; i < g.pts.length; i += 2) ctx.lineTo(g.pts[i], g.pts[i + 1]);
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = `rgba(160,168,178,${a})`;
        ctx.lineWidth = this.px(1.2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    drawStationsDyn(ctx) {
      const sim = this.sim;
      for (const st of Wd.stations) {
        const S = sim.stations[st.id];
        const ang = Math.atan2(st.dir.y, st.dir.x);
        const docked = sim.robots.find((r) => r.station === st.id);
        if (docked && (docked.mode === 'loading' || docked.mode === 'unloading')) {
          ctx.save();
          ctx.translate(st.x, st.y);
          ctx.rotate(ang);
          const dir = docked.mode === 'loading' ? -1 : 1;
          const off = (((sim.t * 24 * dir) % 4) + 4) % 4;
          ctx.strokeStyle = '#4d565f';
          ctx.lineWidth = this.px(1);
          for (let x = 32 + off; x <= 54; x += 4) { ctx.beginPath(); ctx.moveTo(x, -23); ctx.lineTo(x, 23); ctx.stroke(); }
          ctx.restore();
        }
        if (!S.obj) continue;
        if (docked && docked.mode === 'loading' && S.obj.state === 'waiting') continue;
        const alpha = S.obj.state === 'delivered' ? clamp((3.6 - (sim.t - S.obj.t0)) / 1.0, 0, 1) : 1;
        this.drawBox(ctx, st.stand.x, st.stand.y, ang, alpha, 1);
      }
      // Brief outline when a task is created or completed at a station
      for (const g of sim.fx.rings) {
        if (g.kind !== 'spawn' && g.kind !== 'done') continue;
        const life = (sim.t - g.t0) / g.dur;
        ctx.strokeStyle = rgba(g.kind === 'done' ? C.ok : C.payload, 0.8 * (1 - life));
        ctx.lineWidth = this.px(1.5);
        const s = g.kind === 'done' ? 34 : 20;
        ctx.strokeRect(g.x - s, g.y - s, 2 * s, 2 * s);
      }
    }

    drawBox(ctx, x, y, ang, alpha, sc) {
      ctx.save();
      ctx.globalAlpha *= alpha;
      ctx.save();
      ctx.translate(x + 1.5, y + 2);
      ctx.rotate(ang);
      ctx.scale(sc, sc);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(-11, -11, 22, 22);
      ctx.restore();
      ctx.translate(x, y);
      ctx.rotate(ang);
      ctx.scale(sc, sc);
      ctx.fillStyle = C.payload;
      ctx.fillRect(-11, -11, 22, 22);
      ctx.strokeStyle = '#5f4628';
      ctx.lineWidth = this.px(1);
      ctx.strokeRect(-11, -11, 22, 22);
      ctx.fillStyle = '#c3a26f';
      ctx.fillRect(-11, -2, 22, 4);
      ctx.fillStyle = '#e6e3da';
      ctx.fillRect(3, 4.5, 6, 4);
      ctx.restore();
    }

    drawConflicts(ctx) {
      const sim = this.sim, H = Wd.HALF;
      for (const r of sim.robots) {
        const b = r.block;
        if (!b || !b.logged || b.silent || !r.route) continue;
        const N = Wd.nodeMap[b.node];
        if (b.kind === 'corridor' && b.edge) {
          this.laneRect(ctx, Wd.edgeMap[b.edge], 6, H);
          ctx.strokeStyle = rgba(C.warn, 0.8);
          ctx.lineWidth = this.px(1.2);
          ctx.setLineDash([5, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        const zs = N.kind === 'cross' ? H - 2 : 26;
        ctx.fillStyle = rgba(C.warn, 0.16);
        ctx.fillRect(N.x - zs, N.y - zs, 2 * zs, 2 * zs);
        ctx.strokeStyle = C.warn;
        ctx.lineWidth = this.px(1.5);
        ctx.strokeRect(N.x - zs, N.y - zs, 2 * zs, 2 * zs);
        // Hold line in front of the waiting robot
        const R = r.route, gi = R.idx + R.granted;
        if (gi < R.nodes.length) {
          R.geo.at(Math.min(R.geo.length, R.nodeS[gi] - sim.cfg.stopDist + 29), this.tmp);
          const { x, y, h } = this.tmp;
          const nx = -Math.sin(h), ny = Math.cos(h);
          ctx.strokeStyle = C.warn;
          ctx.lineWidth = 3;
          ctx.lineCap = 'butt';
          ctx.beginPath(); ctx.moveTo(x - nx * 24, y - ny * 24); ctx.lineTo(x + nx * 24, y + ny * 24); ctx.stroke();
        }
      }
      for (const m of sim.fx.marks) {
        if (m.kind !== 'resolved') continue;
        const N = Wd.nodeMap[m.node];
        const life = (sim.t - m.t0) / m.dur;
        const zs = N.kind === 'cross' ? H - 2 : 26;
        ctx.strokeStyle = rgba(C.ok, 0.9 * (1 - life));
        ctx.lineWidth = this.px(1.5);
        ctx.strokeRect(N.x - zs, N.y - zs, 2 * zs, 2 * zs);
      }
    }

    drawHover(ctx) {
      const h = this.hover;
      if (!h) return;
      if (h.edge) {
        const blocked = !!this.sim.obstructions[h.edge];
        this.laneRect(ctx, Wd.edgeMap[h.edge], 2, Wd.HALF);
        if (this.tool === 'block') {
          ctx.fillStyle = blocked ? rgba(C.ok, 0.1) : rgba(C.alarm, 0.12);
          ctx.fill();
        }
        ctx.strokeStyle = this.tool === 'block' ? (blocked ? C.ok : C.alarm) : 'rgba(225,228,232,0.6)';
        ctx.lineWidth = this.px(1.2);
        ctx.setLineDash([5, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (h.station) {
        const st = Wd.stationMap[h.station];
        ctx.strokeStyle = 'rgba(225,228,232,0.7)';
        ctx.lineWidth = this.px(1.2);
        ctx.strokeRect(st.x - 33, st.y - 33, 66, 66);
      }
    }

    drawSafety(ctx) {
      const L = this.sim.cfg.L, W = this.sim.cfg.Wr;
      for (const r of this.sim.robots) {
        const warnLen = 26 + r.v * 0.5, protLen = 10 + r.v * 0.22;
        ctx.save();
        ctx.translate(r.x, r.y);
        ctx.rotate(r.h);
        if (r.follow >= 0) { ctx.fillStyle = rgba(C.warn, 0.1); ctx.fillRect(L / 2, -W / 2 - 8, warnLen, W + 16); }
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = rgba(C.warn, 0.7);
        ctx.lineWidth = this.px(1);
        ctx.strokeRect(L / 2, -W / 2 - 8, warnLen, W + 16);
        ctx.setLineDash([]);
        ctx.strokeStyle = rgba(C.alarm, 0.75);
        ctx.strokeRect(L / 2, -W / 2 - 3, protLen, W + 6);
        ctx.restore();
      }
    }

    drawRobot(ctx, r) {
      const sim = this.sim;
      const L = sim.cfg.L, W = sim.cfg.Wr;
      const tone = TONE[sim.status(r).tone] || C.ok;
      const a = this.dimFor(r.i) < 1 ? 0.75 : 1;
      ctx.save();
      ctx.globalAlpha = a;
      // Flat contact shadow, offset in world space
      ctx.save();
      ctx.translate(r.x + 2, r.y + 3);
      ctx.rotate(r.h);
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      rr(ctx, -L / 2, -W / 2, L, W, 6);
      ctx.fill();
      ctx.restore();
      ctx.translate(r.x, r.y);
      ctx.rotate(r.h);
      // Chassis
      ctx.fillStyle = '#4a5058';
      rr(ctx, -L / 2, -W / 2, L, W, 6);
      ctx.fill();
      ctx.strokeStyle = '#0e1012';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // Front bumper, and the rear bumper band in the robot's fleet colour
      ctx.fillStyle = '#1d2024';
      ctx.fillRect(L / 2 - 3.5, -W / 2 + 4, 2.5, W - 8);
      ctx.fillStyle = r.color;
      ctx.fillRect(-L / 2 + 1, -W / 2 + 4, 4, W - 8);
      // Top deck with status light strip
      ctx.fillStyle = '#2e3238';
      rr(ctx, -L / 2 + 7, -W / 2 + 5, L - 14, W - 10, 3);
      ctx.fill();
      ctx.strokeStyle = tone;
      ctx.lineWidth = 1.7;
      rr(ctx, -L / 2 + 6.5, -W / 2 + 3.4, L - 12, W - 6.8, 4);
      ctx.stroke();
      // Heading chevron
      ctx.strokeStyle = '#c7cdd4';
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(L / 2 - 14, -5); ctx.lineTo(L / 2 - 9, 0); ctx.lineTo(L / 2 - 14, 5); ctx.stroke();
      // Scanners on opposite corners
      for (const [x, y] of [[L / 2 - 5, -W / 2 + 5], [-L / 2 + 5, W / 2 - 5]]) {
        ctx.fillStyle = '#121417';
        ctx.beginPath(); ctx.arc(x, y, 3.3, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#59616a';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
      // Head and tail lamps
      ctx.fillStyle = '#e9edf1';
      ctx.fillRect(L / 2 - 1.4, -W / 2 + 5, 1.2, 4);
      ctx.fillRect(L / 2 - 1.4, W / 2 - 9, 1.2, 4);
      ctx.fillStyle = '#b8453f';
      ctx.fillRect(-L / 2 + 0.3, -W / 2 + 5, 1.2, 4);
      ctx.fillRect(-L / 2 + 0.3, W / 2 - 9, 1.2, 4);
      // Unit number on the deck
      if (!r.carrying && this.scale > 0.5) {
        ctx.rotate(Math.PI / 2);
        ctx.fillStyle = '#7b838d';
        ctx.font = `600 8px ${FONT.mono}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(r.id.slice(-2), 0, 5);
      }
      ctx.restore();
      if (r.carrying && r.mode !== 'unloading') this.drawBox(ctx, r.x - Math.cos(r.h) * 3, r.y - Math.sin(r.h) * 3, r.h, a, 0.9);
    }

    drawTransfer(ctx, r) {
      if (r.mode !== 'loading' && r.mode !== 'unloading') return;
      const st = Wd.stationMap[r.station];
      const cfg = this.sim.cfg;
      const p = ease(clamp((r.timer - 0.3) / (cfg.transferTime - 0.8), 0, 1));
      const from = r.mode === 'loading' ? st.stand : r, to = r.mode === 'loading' ? r : st.stand;
      this.drawBox(ctx, from.x + (to.x - from.x) * p, from.y + (to.y - from.y) * p, r.h, 1, r.mode === 'loading' ? 1 - p * 0.1 : 0.9 + p * 0.1);
    }

    drawSelection(ctx) {
      if (this.selected < 0) return;
      const r = this.sim.robots[this.selected];
      const L = this.sim.cfg.L + 12, W = this.sim.cfg.Wr + 12;
      ctx.save();
      ctx.translate(r.x, r.y);
      ctx.rotate(r.h);
      ctx.strokeStyle = '#e1e4e8';
      ctx.lineWidth = this.px(1);
      ctx.strokeRect(-L / 2, -W / 2, L, W);
      ctx.fillStyle = '#e1e4e8';
      const hs = this.px(4);
      for (const [x, y] of [[-L / 2, -W / 2], [L / 2, -W / 2], [L / 2, W / 2], [-L / 2, W / 2]]) ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
      ctx.restore();
    }

    drawLinks(ctx) {
      const sim = this.sim;
      for (const l of sim.fx.links) {
        const A = sim.robots[l.a], B = sim.robots[l.b];
        const life = (sim.t - l.t0) / l.dur;
        const env = clamp(life / 0.1, 0, 1) * clamp((1 - life) / 0.25, 0, 1);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = `rgba(200,206,214,${0.6 * env})`;
        ctx.lineWidth = this.px(1);
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
        ctx.setLineDash([]);
        // One message packet A → B, then the reply B → A
        const u = clamp(life / 0.35, 0, 1), v = clamp((life - 0.4) / 0.35, 0, 1);
        const dot = (P, Q, f) => {
          if (f <= 0 || f >= 1) return;
          ctx.fillStyle = `rgba(230,233,237,${env})`;
          ctx.beginPath(); ctx.arc(P.x + (Q.x - P.x) * f, P.y + (Q.y - P.y) * f, this.px(3), 0, Math.PI * 2); ctx.fill();
        };
        dot(A, B, u);
        dot(B, A, v);
      }
    }

    // ------------------------------------------------------------------ screen-space annotations
    tag(ctx, x, y, parts, opt) {
      opt = opt || {};
      const size = opt.size || this.fs(11);
      const padX = opt.padX == null ? 5 : opt.padX;
      const h = Math.round(size + (opt.padY == null ? 7 : opt.padY));
      let w = padX * 2;
      for (const p of parts) {
        ctx.font = `${p.weight || 500} ${p.size || size}px ${p.mono ? FONT.mono : FONT.sans}`;
        p.w = p.square ? 7 : ctx.measureText(p.text).width;
        w += p.w + (p.gap || 0);
      }
      w = Math.ceil(w);
      let x0 = opt.align === 'left' ? x : opt.align === 'right' ? x - w : x - w / 2;
      x0 = Math.round(clamp(x0, 2, this.cw - w - 2));
      const y0 = Math.round(clamp(y - h / 2, 2, this.ch - h - 2));
      ctx.globalAlpha = opt.alpha == null ? 1 : opt.alpha;
      ctx.fillStyle = opt.bg || C.tagBg;
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = opt.border || C.tagEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
      let tx = x0 + padX;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (const p of parts) {
        if (p.square) {
          ctx.fillStyle = p.color;
          ctx.fillRect(tx, Math.round(y0 + h / 2 - 3.5), 7, 7);
        } else {
          ctx.font = `${p.weight || 500} ${p.size || size}px ${p.mono ? FONT.mono : FONT.sans}`;
          ctx.fillStyle = p.color || C.text;
          ctx.fillText(p.text, tx, y0 + h / 2 + 0.5);
        }
        tx += p.w + (p.gap || 0);
      }
      ctx.globalAlpha = 1;
      return { x0, y0, w, h };
    }

    stationTarget(id) {
      for (const r of this.sim.robots) {
        if (!r.task) continue;
        const toPick = r.mode === 'toPickup' || r.mode === 'loading';
        if (toPick && r.task.pickup === id) return { r, kind: 'Pick' };
        if (!toPick && r.task.drop === id) return { r, kind: 'Drop' };
      }
      return null;
    }

    drawStationLabels(ctx) {
      const sim = this.sim;
      for (const st of Wd.stations) {
        let x, y, align;
        if (st.dir.y < 0) { x = this.sx(st.x - 36); y = this.sy(st.y - 18); align = 'right'; }
        else if (st.dir.y > 0) { x = this.sx(st.x - 36); y = this.sy(st.y + 18); align = 'right'; }
        else { x = this.sx(st.x - 30); y = this.sy(st.y - 58); align = 'left'; }
        const S = sim.stations[st.id];
        const tg = this.stationTarget(st.id);
        const size = this.compact ? 9 : this.fs(10.5);
        const parts = [{ text: st.id, mono: true, weight: 600, color: '#d3d7dc', size }];
        let border = C.tagEdge;
        if (tg) {
          border = tg.r.color;
          if (!this.compact) parts.push({ text: ' ' + tg.kind, color: tg.r.color, weight: 600, size: size - 0.5 });
        } else if (S.obj && S.obj.state === 'waiting' && !this.compact) {
          parts.push({ text: ' ' + S.obj.task, mono: true, color: '#c6a36f', size: size - 1 });
        }
        if (this.hover && this.hover.station === st.id) border = '#e1e4e8';
        this.tag(ctx, x, y, parts, { align, border, size, padX: this.compact ? 3 : 5, padY: this.compact ? 4 : 7 });
      }
    }

    drawZoneLabels(ctx) {
      const sim = this.sim;
      if (this.compact) return;
      const size = this.fs(10);
      for (const eid in sim.obstructions) {
        const o = sim.obstructions[eid];
        const e = Wd.edgeMap[eid];
        const A = Wd.nodeMap[e.a], B = Wd.nodeMap[e.b];
        const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
        const left = Math.max(0, Math.ceil(o.until - sim.t));
        const closing = o.state === 'closing';
        const parts = [{ text: closing ? 'Closing' : `Blocked ${left} s`, color: closing ? C.warn : C.alarm, weight: 600, size }];
        const opt = { border: closing ? C.warn : C.alarm, size };
        if (e.kind === 'aisle') this.tag(ctx, this.sx(mx - Wd.HALF - 6), this.sy(my), parts, Object.assign(opt, { align: 'right' }));
        else this.tag(ctx, this.sx(mx), this.sy(my - Wd.HALF - 12), parts, opt);
      }
      const shown = new Set();
      for (const r of sim.robots) {
        const b = r.block;
        if (!b || !b.logged || b.silent || shown.has(b.node)) continue;
        shown.add(b.node);
        const N = Wd.nodeMap[b.node];
        const zs = N.kind === 'cross' ? Wd.HALF - 2 : 26;
        this.tag(ctx, this.sx(N.x + zs), this.sy(N.y - zs) - 10, [{ text: 'Conflict ' + b.node, color: C.warn, weight: 600, size }], { align: 'left', border: C.warn, size });
      }
    }

    drawRobotTags(ctx) {
      const sim = this.sim;
      const placed = [];
      const QUIET = { move: 1, follow: 1, turn: 1 };
      for (const r of sim.robots) {
        const st = sim.status(r);
        const x = this.sx(r.x);
        const a = this.dimFor(r.i) < 1 ? 0.6 : 1;
        if (this.compact) {
          this.tag(ctx, x, this.sy(r.y) - this.scale * 30 - 9, [{ square: true, color: r.color, gap: 3 }, { text: r.id.slice(-2), mono: true, weight: 600, size: 9 }], { size: 9, padX: 3, padY: 4, alpha: a });
          continue;
        }
        let y = this.sy(r.y) - this.scale * 34 - 12;
        for (const p of placed) if (Math.abs(p.x - x) < 120 && Math.abs(p.y - y) < 21) y = p.y - 21;
        placed.push({ x, y });
        const size = this.fs(11);
        const parts = [{ square: true, color: r.color, gap: 5 }, { text: r.id, mono: true, weight: 600, size }];
        if (!QUIET[st.key]) parts.push({ text: '  ' + st.label, color: TONE[st.tone] || C.text2, weight: 600, size: size - 0.5 });
        this.tag(ctx, x, y, parts, { size, alpha: a, border: this.selected === r.i ? '#e1e4e8' : C.tagEdge });
      }
    }

    drawCallouts(ctx) {
      const sim = this.sim;
      if (this.compact) return;
      const boxes = [];
      for (let i = sim.fx.links.length - 1; i >= 0 && boxes.length < 3; i--) {
        const l = sim.fx.links[i];
        const A = sim.robots[l.a], B = sim.robots[l.b];
        const life = (sim.t - l.t0) / l.dur;
        const env = clamp(life / 0.1, 0, 1) * clamp((1 - life) / 0.25, 0, 1);
        const size = this.fs(10.5);
        const sm = size - 1;
        const lines = [
          [{ text: 'V2V  ', color: '#7f8791', mono: true, size: sm }, { text: A.id, color: A.color, mono: true, weight: 600, size: sm },
            { text: ' ↔ ', color: '#7f8791', size: sm }, { text: B.id, color: B.color, mono: true, weight: 600, size: sm }],
          [{ text: A.id.slice(-2) + '  ', color: A.color, mono: true, weight: 600, size }, { text: l.chipA || '', color: C.text, size }],
        ];
        if (l.chipB && life > 0.4) {
          const warn = l.kind === 'yield' || l.kind === 'corridor' || l.kind === 'deadlock';
          lines.push([{ text: B.id.slice(-2) + '  ', color: B.color, mono: true, weight: 600, size }, { text: l.chipB, color: warn ? C.warn : C.text, size }]);
        }
        const lh = size + 6, padX = 7, padY = 5;
        let w = 0;
        for (const ln of lines) {
          let lw = 0;
          for (const p of ln) { ctx.font = `${p.weight || 500} ${p.size}px ${p.mono ? FONT.mono : FONT.sans}`; p.w = ctx.measureText(p.text).width; lw += p.w; }
          w = Math.max(w, lw);
        }
        w = Math.ceil(w + padX * 2);
        const h = lines.length * lh + padY * 2 - 2;
        let x = (this.sx(A.x) + this.sx(B.x)) / 2 - w / 2;
        let y = Math.min(this.sy(A.y), this.sy(B.y)) - this.scale * 64 - h;
        if (y < 4) y = Math.max(this.sy(A.y), this.sy(B.y)) + this.scale * 46;
        for (const bx of boxes) if (x < bx.x + bx.w && x + w > bx.x && y < bx.y + bx.h && y + h > bx.y) y = bx.y - h - 6;
        x = Math.round(clamp(x, 4, this.cw - w - 4));
        y = Math.round(clamp(y, 4, this.ch - h - 4));
        boxes.push({ x, y, w, h });
        ctx.globalAlpha = env;
        ctx.fillStyle = 'rgba(12,14,16,0.95)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#4a5159';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        lines.forEach((ln, k) => {
          let tx = x + padX;
          const ty = y + padY + k * lh + lh / 2 - 1;
          for (const p of ln) {
            ctx.font = `${p.weight || 500} ${p.size}px ${p.mono ? FONT.mono : FONT.sans}`;
            ctx.fillStyle = p.color;
            ctx.fillText(p.text, tx, ty);
            tx += p.w;
          }
        });
        ctx.globalAlpha = 1;
      }
    }

    // ------------------------------------------------------------------ hit testing
    pick(px, py) {
      const p = this.toWorld(px, py);
      for (const r of this.sim.robots) if (Math.hypot(r.x - p.x, r.y - p.y) < 32) return { robot: r.i };
      for (const st of Wd.stations) {
        if (Math.abs(st.x - p.x) < 32 && Math.abs(st.y - p.y) < 32) return { station: st.id };
        if (Math.abs(st.stand.x - p.x) < 18 && Math.abs(st.stand.y - p.y) < 28) return { station: st.id };
      }
      let best = null, bd = Wd.HALF + 4;
      for (const e of Wd.edges) {
        if (e.kind === 'spur') continue;
        const A = Wd.nodeMap[e.a], B = Wd.nodeMap[e.b];
        const ux = (B.x - A.x) / e.len, uy = (B.y - A.y) / e.len;
        const t = (p.x - A.x) * ux + (p.y - A.y) * uy;
        if (t < Wd.HALF * 0.6 || t > e.len - Wd.HALF * 0.6) continue;
        const d = Math.abs((p.x - A.x) * -uy + (p.y - A.y) * ux);
        if (d < bd) { bd = d; best = e; }
      }
      return best ? { edge: best.id } : null;
    }
  }

  WH.Renderer = Renderer;
  WH.TONE = TONE;
  WH.COLORS = C;
})(typeof window !== 'undefined' ? window : globalThis);
