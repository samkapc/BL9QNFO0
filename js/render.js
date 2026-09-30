/*
 * render.js — floor map renderer for the EdgeFleet console.
 *
 * Drawn as a facility map, the way fleet-management software shows a site: flat surfaces,
 * building column grid, rack slots, the path network and its nodes, traffic zones.
 * The static layer is cached and re-rendered only when the view (zoom/pan/size) settles.
 *
 * Two map styles: "light" (the default: a daylight hall modelled on a photoreal render, with
 * pale concrete, white walls, white cartons on wooden pallets, soft shadows) and "dark"
 * (operator console). Only the map switches; the surrounding console stays dark.
 */
(function (root) {
  'use strict';
  const WH = (root.WH = root.WH || {});
  const Wd = WH.world;

  const FONT = {
    sans: '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif',
    mono: '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace',
  };

  const DARK = {
    light: false,
    bg: '#141619', floor: '#191c1f', lane: '#22262b', grid: '#2a2f35', joint: null, gridText: '#7f8791',
    bubbleBg: '#141619', bubbleEdge: '#4a5159',
    wall: '#2f343a', wallEdge: '#4b525a', doorLine: '#6a737d', column: '#3d434a',
    rack: '#24282d', rackEdge: '#3a4047', slot: '#2d3238', slotEdge: '#383e45', beam: '#4d545c',
    net: '#353c44', node: '#6a737d', zone: '#3a414a',
    label: '#6b737d', labelHi: '#8d959f', areaLabelBg: 'rgba(20,22,25,0.85)',
    stationEdge: '#5a636d', stationArrow: '#444b53', stand: '#22262b', standEdge: '#4a525b', roller: '#30353c', rollerOn: '#4d565f',
    cellBench: '#262a2f', cellEdge: '#454c55', cellArm: '#5a626b', cellBase: '#23272b', cellBlock: '#2d3238',
    convEdge: '#4b525a', convFill: '#23272c', convRoller: '#3d434b', convOver: 'rgba(90,98,107,0.9)', convOverFill: 'rgba(27,30,34,0.92)',
    cube: '#1f2327', cubeLine: '#2b3036', cubeBin: '#343a41', cart: '#23272b', cartEdge: '#383e45',
    robotBody: '#4a5058', robotEdge: '#0e1012', robotDeck: '#2e3238', robotShadow: 'rgba(0,0,0,0.4)', chevron: '#c7cdd4',
    boxShadow: 'rgba(0,0,0,0.35)',
    text: '#e1e4e8', text2: '#a0a7b0', muted: '#7f8791', stationText: '#d3d7dc', waitingText: '#c6a36f',
    tagBg: 'rgba(15,17,19,0.92)', tagEdge: '#3a4047', calloutBg: 'rgba(12,14,16,0.95)', calloutEdge: '#4a5159',
    hover: 'rgba(225,228,232,0.6)', select: '#e1e4e8', link: '200,206,214', packet: '230,233,237', ghost: '160,168,178',
    ok: '#3ea86b', warn: '#e3a42b', alarm: '#e5534b', work: '#5b9cf5', idle: '#8a919b', payload: '#a88353',
  };
  const LIGHT = Object.assign({}, DARK, {
    light: true,
    bg: '#d9dde1', floor: '#e7e9eb', lane: '#dfe2e5', grid: '#c8cdd2', joint: '#d6dadd', gridText: '#5f6770',
    bubbleBg: '#f3f4f5', bubbleEdge: '#a3aab1',
    wall: '#f6f7f8', wallEdge: '#a9b0b7', doorLine: '#8a9199', column: '#8b939b',
    rack: '#d3d7db', rackEdge: '#b4bac0', slot: '#fbfbfc', slotEdge: '#cdd2d6', beam: '#c39a55',
    net: '#c3c9ce', node: '#8f979f', zone: '#b6bcc2',
    label: '#727a83', labelHi: '#4f5760', areaLabelBg: 'rgba(243,244,245,0.92)',
    stationEdge: '#8f979f', stationArrow: '#b5bbc1', stand: '#d8dce0', standEdge: '#9aa1a8', roller: '#bcc2c8', rollerOn: '#7c848c',
    cellBench: '#dfe2e5', cellEdge: '#9ea5ac', cellArm: '#6b737c', cellBase: '#f4f5f6', cellBlock: '#c9ced3',
    convEdge: '#9aa3ab', convFill: '#d4d8dc', convRoller: '#a9b0b7', convOver: 'rgba(130,139,148,0.95)', convOverFill: 'rgba(214,218,222,0.92)',
    cube: '#cfd4d8', cubeLine: '#b3b9bf', cubeBin: '#fbfbfc', cart: '#f1f2f3', cartEdge: '#a6adb4',
    robotBody: '#474d55', robotEdge: '#15181b', robotDeck: '#2f3339', robotShadow: 'rgba(45,52,60,0.3)', chevron: '#d5dae0',
    boxShadow: 'rgba(45,52,60,0.28)',
    text: '#1f2328', text2: '#565e67', muted: '#6b737c', stationText: '#2a2f35', waitingText: '#8a6528',
    tagBg: 'rgba(255,255,255,0.95)', tagEdge: '#b8bec4', calloutBg: 'rgba(255,255,255,0.97)', calloutEdge: '#aeb5bb',
    hover: 'rgba(42,47,53,0.7)', select: '#1f2328', link: '80,87,95', packet: '42,47,53', ghost: '124,132,141',
    ok: '#1f8a4c', warn: '#c77f00', alarm: '#d23a32', work: '#2f6fd6', idle: '#7a818a', payload: '#b0854e',
  });
  // Darker fleet colours so routes and tags stay legible on the light floor
  const LIGHT_ID = { '#4bb0c8': '#1b86a4', '#8f88ea': '#5a51cf', '#cc76b8': '#ab3f91', '#d98a5f': '#b5602f', '#8fb45a': '#5b8a2a' };
  const tones = (P) => ({ drive: P.ok, wait: P.warn, work: P.work, idle: P.idle, fault: P.alarm });

  let C = DARK;
  let TONE = tones(C);
  const idc = (r) => (C.light && LIGHT_ID[r.color]) || r.color;

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
  function segDist(px, py, A, B) {
    const dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((px - A.x) * dx + (py - A.y) * dy) / l2, 0, 1) : 0;
    return Math.hypot(px - (A.x + dx * t), py - (A.y + dy * t));
  }

  // Building column grid (structural bays) and view bounds come with the layout
  const GRID_X = Wd.grid.xs, GRID_Y = Wd.grid.ys;
  const BOUNDS = Wd.bounds;

  // Structural columns inside the hall: grid intersections that are clear of lanes and equipment
  const COLUMNS = (() => {
    const out = [];
    const W = Wd.WALL, m = 16;
    const inside = (x, y, b, pad) => x > b.x0 - pad && x < b.x1 + pad && y > b.y0 - pad && y < b.y1 + pad;
    for (const x of GRID_X) {
      for (const y of GRID_Y) {
        if (x <= W.x0 + 1 || x >= W.x1 - 1 || y <= W.y0 + 1 || y >= W.y1 - 1) continue;
        let clear = true;
        for (const e of Wd.edges) {
          if (segDist(x, y, Wd.nodeMap[e.a], Wd.nodeMap[e.b]) < (e.kind === 'spur' ? 32 : Wd.HALF) + m) { clear = false; break; }
        }
        if (!clear) continue;
        if (Wd.stations.some((s) => Math.abs(s.x - x) < 46 + m && Math.abs(s.y - y) < 46 + m)) continue;
        if (Wd.racks.some((b) => inside(x, y, b, 6)) || Wd.bays.some((b) => inside(x, y, b, 6))) continue;
        if (Wd.areas.some((a) => a.x0 != null && inside(x, y, a, 8))) continue;
        out.push({ x, y });
      }
    }
    return out;
  })();

  class Renderer {
    constructor(canvas, sim, opts) {
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
      this.theme = (opts && opts.theme) === 'dark' ? 'dark' : 'light';
      C = this.theme === 'light' ? LIGHT : DARK;
      TONE = tones(C);
      this.resize();
    }

    setTheme(theme) {
      this.theme = theme === 'dark' ? 'dark' : 'light';
      C = this.theme === 'light' ? LIGHT : DARK;
      TONE = tones(C);
      this.drawStatic();
      this.draw();
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
    viewKey() { return `${this.scale.toFixed(5)}|${this.ox.toFixed(2)}|${this.oy.toFixed(2)}|${this.cv.width}x${this.cv.height}|${this.layers.labels}|${this.theme}`; }

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
    // Soft drop shadow for the light style (device pixels, independent of the world transform)
    shadow(ctx, on, blur, dx, dy, col) {
      if (!on || !C.light) { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; return; }
      const k = this.dpr * this.scale;
      ctx.shadowColor = col || 'rgba(60,68,78,0.22)';
      ctx.shadowBlur = blur * k;
      ctx.shadowOffsetX = dx * k;
      ctx.shadowOffsetY = dy * k;
    }

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
      this.drawWalkways(ctx);
      const rng = mulberry32(20240517);
      Wd.racks.forEach((rk) => this.drawRack(ctx, rk, rng));
      this.drawBays(ctx);
      for (const st of Wd.stations) this.drawStationBase(ctx, st);
      this.drawNetwork(ctx);
      this.drawColumns(ctx);
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
      if (C.light) {
        // Daylight falling across the hall, brighter in the middle
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rad = Math.hypot(x1 - x0, y1 - y0) / 1.8;
        const g = ctx.createRadialGradient(cx, cy * 0.9, rad * 0.1, cx, cy, rad);
        g.addColorStop(0, 'rgba(255,255,255,0.45)');
        g.addColorStop(0.6, 'rgba(255,255,255,0.08)');
        g.addColorStop(1, 'rgba(120,130,140,0.12)');
        ctx.fillStyle = g;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        // Saw-cut slab joints between the column lines
        ctx.strokeStyle = C.joint;
        ctx.lineWidth = this.px(1);
        ctx.beginPath();
        for (let i = 1; i < GRID_X.length; i++) { const x = (GRID_X[i - 1] + GRID_X[i]) / 2; ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
        for (let i = 1; i < GRID_Y.length; i++) { const y = (GRID_Y[i - 1] + GRID_Y[i]) / 2; ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
        ctx.stroke();
      }
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = this.px(1);
      if (!C.light) ctx.setLineDash([22, 5, 3, 5]);
      for (const x of GRID_X) { ctx.beginPath(); ctx.moveTo(x, C.light ? y0 : -8); ctx.lineTo(x, y1); ctx.stroke(); }
      for (const y of GRID_Y) { ctx.beginPath(); ctx.moveTo(C.light ? x0 : -8, y); ctx.lineTo(x1, y); ctx.stroke(); }
      ctx.setLineDash([]);
    }

    // A pallet position: in the dark style a flat slot, in the light style a wooden pallet,
    // usually carrying a white load
    pallet(ctx, x, y, w, h, used, rng, loadedShare) {
      if (!C.light) { this.slot(ctx, x, y, w, h, used); return; }
      if (!used) {
        ctx.strokeStyle = C.grid;
        ctx.lineWidth = this.px(1);
        ctx.strokeRect(x, y, w, h);
        return;
      }
      this.shadow(ctx, true, 5, 1.5, 2.5);
      ctx.fillStyle = '#b98f5b';
      ctx.fillRect(x, y, w, h);
      this.shadow(ctx, false);
      ctx.fillStyle = '#94703f';
      const n = w > 30 ? 5 : 3;
      for (let i = 0; i < n; i++) ctx.fillRect(x, y + ((i + 0.5) * h) / n - 0.7, w, 1.4);
      if (rng() < loadedShare) {
        const ins = Math.max(1.5, Math.min(w, h) * 0.06);
        this.shadow(ctx, true, 4, 1, 2);
        ctx.fillStyle = C.slot;
        ctx.fillRect(x + ins, y + ins, w - 2 * ins, h - 2 * ins);
        this.shadow(ctx, false);
        ctx.strokeStyle = C.slotEdge;
        ctx.lineWidth = this.px(1);
        ctx.strokeRect(x + ins, y + ins, w - 2 * ins, h - 2 * ins);
        ctx.beginPath();
        ctx.moveTo(x + w / 2, y + ins); ctx.lineTo(x + w / 2, y + h - ins);
        if (h > 24) { ctx.moveTo(x + ins, y + h / 2); ctx.lineTo(x + w - ins, y + h / 2); }
        ctx.stroke();
      }
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
              this.pallet(ctx, x, y, sw, sh, rng() < 0.55, rng, 0.75);
            }
          }
        } else if (a.kind === 'pallets') {
          const cw = (w - 12) / a.cols, ch = (h - 12) / a.rows;
          const s = Math.min(cw, ch) - 8;
          const loaded = a.fill != null ? a.fill : /floor/i.test(a.label || '') ? 0.9 : 0.15;
          for (let c = 0; c < a.cols; c++) {
            for (let r = 0; r < a.rows; r++) {
              this.pallet(ctx, a.x0 + 6 + c * cw + (cw - s) / 2, a.y0 + 6 + r * ch + (ch - s) / 2, s, s, rng() < 0.78, rng, loaded);
            }
          }
        } else if (a.kind === 'totes') {
          const n = Math.floor((w - 12) / 22);
          const gx = (w - n * 22) / 2 + 4;
          for (const y of [a.y0 + 18, a.y1 - 32]) {
            for (let i = 0; i < n; i++) {
              const used = rng() < 0.7;
              this.shadow(ctx, used, 4, 1.5, 2.5);
              this.slot(ctx, a.x0 + gx + i * 22, y, 14, 14, used);
              this.shadow(ctx, false);
            }
          }
        } else if (a.kind === 'carts') {
          const n = Math.floor((w - 16) / 30), rows = Math.floor((h - 12) / 46);
          for (let r = 0; r < rows; r++) {
            for (let i = 0; i < n; i++) {
              if (rng() < 0.25) continue;
              const x = a.x0 + 12 + i * 30, y = a.y0 + 10 + r * 46;
              this.shadow(ctx, true, 4, 1.5, 2.5);
              ctx.fillStyle = C.cart;
              ctx.fillRect(x, y, 20, 32);
              this.shadow(ctx, false);
              ctx.strokeStyle = C.cartEdge;
              ctx.strokeRect(x, y, 20, 32);
              ctx.beginPath(); ctx.moveTo(x + 3, y + 36); ctx.lineTo(x + 17, y + 36); ctx.stroke();
              if (C.light) { ctx.beginPath(); ctx.moveTo(x + 4, y + 11); ctx.lineTo(x + 16, y + 11); ctx.moveTo(x + 4, y + 21); ctx.lineTo(x + 16, y + 21); ctx.stroke(); }
            }
          }
        } else if (a.kind === 'cube') {
          this.shadow(ctx, true, 10, 3, 5);
          ctx.fillStyle = C.cube;
          ctx.fillRect(a.x0, a.y0, w, h);
          this.shadow(ctx, false);
          ctx.strokeStyle = C.cubeLine;
          ctx.beginPath();
          for (let x = a.x0 + 13; x < a.x1; x += 13) { ctx.moveTo(x, a.y0); ctx.lineTo(x, a.y1); }
          for (let y = a.y0 + 13; y < a.y1; y += 13) { ctx.moveTo(a.x0, y); ctx.lineTo(a.x1, y); }
          ctx.stroke();
          ctx.fillStyle = C.cubeBin;
          for (let k = 0; k < 7; k++) {
            const cx = a.x0 + 13 * Math.floor(rng() * (w / 13)), cy = a.y0 + 13 * Math.floor(rng() * (h / 13));
            this.shadow(ctx, true, 3, 1, 1.5);
            ctx.fillRect(cx + 2, cy + 2, 9, 9);
          }
          this.shadow(ctx, false);
          ctx.strokeStyle = C.rackEdge;
          ctx.strokeRect(a.x0, a.y0, w, h);
        } else if (a.kind === 'cell') {
          const cx = (a.x0 + a.x1) / 2;
          this.shadow(ctx, true, 5, 2, 3);
          ctx.fillStyle = C.cellBench;
          ctx.fillRect(a.x0 + 12, a.y1 - 48, w - 24, 26);
          ctx.fillStyle = C.cellBlock;
          ctx.fillRect(cx - 34, a.y0 + 14, 16, 22);
          ctx.fillRect(cx + 20, a.y0 + 14, 16, 22);
          ctx.fillStyle = C.cellBase;
          ctx.beginPath(); ctx.arc(cx, a.y0 + 36, 11, 0, Math.PI * 2); ctx.fill();
          this.shadow(ctx, false);
          ctx.strokeStyle = C.cellEdge;
          ctx.strokeRect(a.x0 + 12, a.y1 - 48, w - 24, 26);
          ctx.strokeStyle = C.node;
          ctx.lineWidth = this.px(1.2);
          ctx.beginPath(); ctx.arc(cx, a.y0 + 36, 11, 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = C.cellArm;
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(cx, a.y0 + 36); ctx.lineTo(cx + 20, a.y0 + 52); ctx.lineTo(cx + 12, a.y0 + 70); ctx.stroke();
          ctx.lineCap = 'butt';
        } else if (a.kind === 'conveyor') {
          const trace = () => {
            ctx.beginPath();
            a.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          };
          ctx.lineJoin = 'miter';
          trace();
          this.shadow(ctx, a.overhead, 8, 5, 9, 'rgba(60,68,78,0.2)');
          ctx.strokeStyle = a.overhead ? C.convOver : C.convEdge;
          ctx.lineWidth = 16;
          if (a.overhead && !C.light) ctx.setLineDash([10, 5]);
          ctx.stroke();
          this.shadow(ctx, false);
          ctx.setLineDash([]);
          trace();
          ctx.strokeStyle = a.overhead ? C.convOverFill : C.convFill;
          ctx.lineWidth = 13;
          ctx.stroke();
          trace();
          ctx.setLineDash([1.4, 6.6]);
          ctx.strokeStyle = C.convRoller;
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
      this.shadow(ctx, true, 14, 5, 8, 'rgba(60,68,78,0.26)');
      ctx.fillStyle = C.rack;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      this.shadow(ctx, false);
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
          const used = rng() < 0.82;
          if (C.light) {
            if (!used) { ctx.strokeStyle = C.grid; ctx.strokeRect(x, y, w, h); continue; }
            // Wooden pallet edge under a white carton load, with the carton seams
            ctx.fillStyle = '#c4a063';
            ctx.fillRect(x, y + h - 2.2, w, 2.2);
            ctx.fillStyle = C.slot;
            ctx.fillRect(x, y, w, h - 2.2);
            ctx.strokeStyle = C.slotEdge;
            ctx.strokeRect(x, y, w, h - 2.2);
            ctx.beginPath();
            ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + h - 2.2);
            if (h > 26) { ctx.moveTo(x, y + (h - 2.2) / 2); ctx.lineTo(x + w, y + (h - 2.2) / 2); }
            ctx.stroke();
            continue;
          }
          if (used) {
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
      ctx.fillStyle = C.light ? '#7b838b' : C.beam;
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
      ctx.fillStyle = C.light ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.015)';
      ctx.fillRect(-30, -30, 60, 60);
      ctx.strokeStyle = C.stationEdge;
      ctx.lineWidth = this.px(1);
      ctx.strokeRect(-30, -30, 60, 60);
      // Docking direction
      ctx.strokeStyle = C.stationArrow;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-8, -9); ctx.lineTo(2, 0); ctx.lineTo(-8, 9); ctx.stroke();
      // Transfer conveyor
      this.shadow(ctx, true, 5, 1.5, 3);
      ctx.fillStyle = C.stand;
      ctx.fillRect(28, -26, 30, 52);
      this.shadow(ctx, false);
      ctx.strokeStyle = C.standEdge;
      ctx.lineWidth = this.px(1);
      ctx.strokeRect(28, -26, 30, 52);
      ctx.strokeStyle = C.roller;
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

    // Painted pedestrian walkways (green), zebra crosswalks where they cross a robot lane, and the
    // yellow standing boxes at the lane edge where people work a rack face in a shared aisle
    drawWalkways(ctx) {
      const P = Wd.peds;
      if (!P) return;
      const hw = 11;
      const green = C.light ? '40,145,78' : '63,168,107';
      const aside = this.sim.cfg.pedAside;
      for (const n of P.list) {
        if (!n.side) continue;
        const cx = n.x + n.side[0] * aside, cy = n.y + n.side[1] * aside;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Math.atan2(n.side[1], n.side[0]));
        ctx.fillStyle = C.light ? 'rgba(226,186,40,0.16)' : 'rgba(214,178,58,0.07)';
        ctx.fillRect(-12, -13, 16, 26);
        ctx.strokeStyle = C.light ? 'rgba(196,150,20,0.85)' : 'rgba(214,178,58,0.5)';
        ctx.lineWidth = this.px(1.2);
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(-12, -13, 16, 26);
        ctx.setLineDash([]);
        ctx.fillStyle = ctx.strokeStyle;
        for (const fy of [-4, 4]) { ctx.beginPath(); ctx.ellipse(-4, fy, 3.6, 1.9, 0, 0, Math.PI * 2); ctx.fill(); }
        ctx.restore();
      }
      for (const e of P.edges) {
        const A = P.nodes[e.a], B = P.nodes[e.b];
        const ux = (B.x - A.x) / e.len, uy = (B.y - A.y) / e.len, nx = -uy, ny = ux;
        if (e.cross) {
          // Stripes run with the robot traffic, repeated along the walking direction
          ctx.fillStyle = C.light ? 'rgba(255,255,255,0.95)' : 'rgba(215,220,226,0.24)';
          const n = Math.floor(e.len / 10);
          const off = (e.len - n * 10) / 2 + 2.5;
          for (let i = 0; i < n; i++) {
            const cx = A.x + ux * (off + i * 10), cy = A.y + uy * (off + i * 10);
            ctx.beginPath();
            ctx.moveTo(cx + nx * 14 - ux * 2.5, cy + ny * 14 - uy * 2.5);
            ctx.lineTo(cx + nx * 14 + ux * 2.5, cy + ny * 14 + uy * 2.5);
            ctx.lineTo(cx - nx * 14 + ux * 2.5, cy - ny * 14 + uy * 2.5);
            ctx.lineTo(cx - nx * 14 - ux * 2.5, cy - ny * 14 - uy * 2.5);
            ctx.closePath();
            ctx.fill();
          }
          if (C.light) {
            ctx.strokeStyle = 'rgba(150,158,166,0.6)';
            ctx.lineWidth = this.px(1);
            ctx.beginPath();
            ctx.moveTo(A.x + nx * 15, A.y + ny * 15); ctx.lineTo(B.x + nx * 15, B.y + ny * 15);
            ctx.moveTo(A.x - nx * 15, A.y - ny * 15); ctx.lineTo(B.x - nx * 15, B.y - ny * 15);
            ctx.stroke();
          }
          continue;
        }
        if (!e.vis) continue;
        ctx.beginPath();
        ctx.moveTo(A.x + nx * hw, A.y + ny * hw); ctx.lineTo(B.x + nx * hw, B.y + ny * hw);
        ctx.lineTo(B.x - nx * hw, B.y - ny * hw); ctx.lineTo(A.x - nx * hw, A.y - ny * hw);
        ctx.closePath();
        ctx.fillStyle = `rgba(${green},${C.light ? 0.1 : 0.06})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(${green},${C.light ? 0.75 : 0.42})`;
        ctx.lineWidth = this.px(1.2);
        ctx.beginPath();
        ctx.moveTo(A.x + nx * hw, A.y + ny * hw); ctx.lineTo(B.x + nx * hw, B.y + ny * hw);
        ctx.moveTo(A.x - nx * hw, A.y - ny * hw); ctx.lineTo(B.x - nx * hw, B.y - ny * hw);
        ctx.stroke();
        // Pedestrian pictogram painted on longer walkway sections
        if (e.len > 150) {
          const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
          ctx.save();
          ctx.translate(mx, my);
          ctx.rotate(Math.atan2(uy, ux));
          ctx.strokeStyle = `rgba(${green},${C.light ? 0.8 : 0.5})`;
          ctx.fillStyle = ctx.strokeStyle;
          ctx.lineWidth = 1.6;
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.arc(0, -5.5, 1.8, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath();
          ctx.moveTo(0, -3); ctx.lineTo(0, 2.5); ctx.moveTo(0, 2.5); ctx.lineTo(-2.5, 7); ctx.moveTo(0, 2.5); ctx.lineTo(2.5, 7);
          ctx.moveTo(-3, -1); ctx.lineTo(3, 0.5);
          ctx.stroke();
          ctx.restore();
          ctx.lineCap = 'butt';
        }
      }
    }

    // A crosswalk or robot intersection in use: outlined while someone is on it or waiting to cross
    drawCrosswalkUse(ctx) {
      const P = Wd.peds;
      if (!P) return;
      for (const h of this.sim.humans) {
        if (!h.path) continue;
        const e = h.edges[h.k];
        if (e && e.lane) {
          const id = h.inBox || (h.state === 'wait' ? h.path[h.k + 1] : null);
          const N = id && P.nodes[id];
          if (!N || !N.box) continue;
          const s = Wd.HALF + 3, onIt = !!h.inBox;
          ctx.beginPath();
          ctx.rect(N.x - s, N.y - s, s * 2, s * 2);
          ctx.fillStyle = rgba(onIt ? C.warn : C.ok, 0.08);
          ctx.fill();
          ctx.strokeStyle = rgba(onIt ? C.warn : C.ok, 0.8);
          ctx.lineWidth = this.px(1.4);
          ctx.setLineDash(onIt ? [] : [4, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
          continue;
        }
        if (!e || !e.cross) continue;
        const onIt = h.state === 'walk' && h.t > 0;
        if (!onIt && h.state !== 'wait') continue;
        const A = P.nodes[e.a], B = P.nodes[e.b];
        const ux = (B.x - A.x) / e.len, uy = (B.y - A.y) / e.len, nx = -uy, ny = ux;
        ctx.beginPath();
        ctx.moveTo(A.x + nx * 17, A.y + ny * 17); ctx.lineTo(B.x + nx * 17, B.y + ny * 17);
        ctx.lineTo(B.x - nx * 17, B.y - ny * 17); ctx.lineTo(A.x - nx * 17, A.y - ny * 17);
        ctx.closePath();
        ctx.fillStyle = rgba(onIt ? C.warn : C.ok, 0.1);
        ctx.fill();
        ctx.strokeStyle = rgba(onIt ? C.warn : C.ok, 0.85);
        ctx.lineWidth = this.px(1.4);
        ctx.setLineDash(onIt ? [] : [4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // A person seen from above: hard hat, hi-vis vest with a reflective band, swinging arms and legs
    drawHuman(ctx, h) {
      const walking = h.state === 'walk' && h.v > 4;
      const sw = walking ? Math.sin(h.phase) * 4.2 : 0;
      if (this.layers.safety) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = rgba(C.warn, 0.55);
        ctx.lineWidth = this.px(1);
        ctx.beginPath(); ctx.arc(h.x, h.y, this.sim.cfg.pedSafe, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      // Thin ring in the vest colour so people are easy to spot at full-map zoom
      ctx.strokeStyle = rgba(h.vest, C.light ? 0.7 : 0.45);
      ctx.lineWidth = this.px(1.2);
      ctx.beginPath(); ctx.arc(h.x, h.y, 17, 0, Math.PI * 2); ctx.stroke();
      ctx.save();
      ctx.fillStyle = C.light ? 'rgba(45,52,60,0.26)' : 'rgba(0,0,0,0.5)';
      ctx.beginPath(); ctx.ellipse(h.x + 2, h.y + 3.2, 8.5, 13.5, h.h, 0, Math.PI * 2); ctx.fill();
      ctx.translate(h.x, h.y);
      ctx.rotate(h.h);
      ctx.scale(1.25, 1.25);
      const blob = (x, y, rx, ry) => { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); };
      ctx.fillStyle = '#2b313a';
      blob(sw, -3.6, 4.2, 2.6);
      blob(-sw, 3.6, 4.2, 2.6);
      ctx.fillStyle = '#3a4250';
      blob(-sw * 0.8, -9.2, 3.8, 2.5);
      blob(sw * 0.8, 9.2, 3.8, 2.5);
      ctx.fillStyle = '#d6a888';
      blob(-sw * 0.8 + 3.2, -9.4, 1.5, 1.5);
      blob(sw * 0.8 + 3.2, 9.4, 1.5, 1.5);
      ctx.fillStyle = h.vest;
      blob(0, 0, 5.4, 9.2);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.ellipse(0, 0, 5.4, 9.2, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(225,230,236,0.85)';
      ctx.fillRect(-2.2, -8.4, 1.5, 16.8);
      ctx.fillStyle = h.hat;
      blob(0.8, 0, 4.7, 4.5);
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath(); ctx.ellipse(0.8, 0, 4.7, 4.5, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      blob(4.6, 0, 1.2, 3.2);
      ctx.restore();
    }

    drawColumns(ctx) {
      for (const c of COLUMNS) {
        this.shadow(ctx, true, 4, 1.5, 2.5);
        ctx.fillStyle = C.column;
        if (C.light) { ctx.beginPath(); ctx.arc(c.x, c.y, 6.5, 0, Math.PI * 2); ctx.fill(); }
        else ctx.fillRect(c.x - 7, c.y - 7, 14, 14);
        this.shadow(ctx, false);
        if (C.light) {
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.beginPath(); ctx.arc(c.x - 1.5, c.y - 1.5, 2.5, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    drawWalls(ctx) {
      const { x0, y0, x1, y1 } = Wd.WALL;
      const T = 8;
      if (C.light) {
        // Inner shading where the walls meet the floor
        const sh = 26;
        const band = (gx0, gy0, gx1, gy1, x, y, w, h) => {
          const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
          g.addColorStop(0, 'rgba(90,100,110,0.16)');
          g.addColorStop(1, 'rgba(90,100,110,0)');
          ctx.fillStyle = g;
          ctx.fillRect(x, y, w, h);
        };
        band(0, y0, 0, y0 + sh, x0, y0, x1 - x0, sh);
        band(0, y1, 0, y1 - sh, x0, y1 - sh, x1 - x0, sh);
        band(x0, 0, x0 + sh, 0, x0, y0, sh, y1 - y0);
        band(x1, 0, x1 - sh, 0, x1 - sh, y0, sh, y1 - y0);
      }
      ctx.fillStyle = C.wall;
      ctx.fillRect(x0 - T, y0 - T, x1 - x0 + 2 * T, T);
      ctx.fillRect(x0 - T, y1, x1 - x0 + 2 * T, T);
      ctx.fillRect(x0 - T, y0, T, y1 - y0);
      ctx.fillRect(x1, y0, T, y1 - y0);
      ctx.strokeStyle = C.wallEdge;
      ctx.lineWidth = this.px(1);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeRect(x0 - T, y0 - T, x1 - x0 + 2 * T, y1 - y0 + 2 * T);
      // Dock door openings with roller-door lines (and dock leveller plates in the light style)
      for (const d of Wd.doors) {
        const hw = d.w / 2;
        const horiz = d.side === 'top' || d.side === 'bottom';
        const s = d.side === 'top' || d.side === 'left' ? -1 : 1;
        if (C.light) {
          const plate = horiz
            ? { x: d.pos - hw + 8, y: s < 0 ? y0 : y1 - 22, w: d.w - 16, h: 22 }
            : { x: s < 0 ? x0 : x1 - 22, y: d.pos - hw + 8, w: 22, h: d.w - 16 };
          ctx.fillStyle = '#2b3036';
          ctx.fillRect(plate.x - 1.5, plate.y - 1.5, plate.w + 3, plate.h + 3);
          ctx.fillStyle = '#e0ae3a';
          ctx.fillRect(plate.x, plate.y, plate.w, plate.h);
          ctx.fillStyle = 'rgba(120,80,10,0.45)';
          const n = 5;
          for (let i = 1; i < n; i++) {
            if (horiz) ctx.fillRect(plate.x + (i * plate.w) / n - 0.6, plate.y, 1.2, plate.h);
            else ctx.fillRect(plate.x, plate.y + (i * plate.h) / n - 0.6, plate.w, 1.2);
          }
        }
        ctx.strokeStyle = C.doorLine;
        ctx.lineWidth = this.px(1);
        if (horiz) {
          const y = d.side === 'top' ? y0 : y1, x = d.pos;
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
          const x = d.side === 'left' ? x0 : x1, y = d.pos;
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
      ctx.fillStyle = C.light ? '#c7ccd1' : '#3d434a';
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
        ctx.fillStyle = C.bubbleBg; ctx.fill();
        ctx.strokeStyle = C.bubbleEdge; ctx.lineWidth = 1; ctx.stroke();
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
        ctx.fillStyle = C.areaLabelBg;
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
        ctx.fillStyle = C.light ? 'rgba(243,244,245,0.92)' : C.rack;
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
      this.drawCrosswalkUse(ctx);
      for (const h of this.sim.humans) this.drawHuman(ctx, h);
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
      const fillA = C.light ? 0.14 : 0.12;
      for (const r of this.sim.robots) {
        const a = this.dimFor(r.i), col = idc(r);
        for (const eid of r.held.edges) {
          const e = Wd.edgeMap[eid];
          this.laneRect(ctx, e, 9, e.kind === 'spur' ? 0 : H);
          ctx.fillStyle = rgba(col, fillA * a);
          ctx.fill();
        }
        for (const nid of r.held.nodes) {
          const n = Wd.nodeMap[nid];
          if (n.kind !== 'cross') continue;
          ctx.fillStyle = rgba(col, fillA * a);
          ctx.fillRect(n.x - H + 2, n.y - H + 2, 2 * H - 4, 2 * H - 4);
          ctx.strokeStyle = rgba(col, 0.55 * a);
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
        const R = r.route, geo = R.geo, a = this.dimFor(r.i), col = idc(r);
        const gi = R.idx + R.granted;
        const claimEnd = gi < R.nodes.length ? Math.max(r.s, R.nodeS[gi] - sim.cfg.stopDist) : geo.length;
        ctx.strokeStyle = rgba(col, 0.95 * a);
        ctx.lineWidth = this.px(this.selected === r.i ? 3 : 2.2);
        ctx.stroke(this.pathSeg(geo, r.s, claimEnd));
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = rgba(col, 0.75 * a);
        ctx.lineWidth = this.px(1.4);
        ctx.stroke(this.pathSeg(geo, claimEnd, geo.length));
        ctx.setLineDash([]);
        const g = Wd.nodeMap[R.goal];
        ctx.strokeStyle = rgba(col, 0.95 * a);
        ctx.lineWidth = this.px(1.6);
        ctx.strokeRect(g.x - 30, g.y - 30, 60, 60);
      }
    }

    drawPreviews(ctx) {
      for (const r of this.sim.robots) {
        if (!r.task || !r.task.preview || r.mode !== 'toPickup') continue;
        ctx.setLineDash([2, 6]);
        ctx.strokeStyle = rgba(idc(r), (C.light ? 0.55 : 0.4) * this.dimFor(r.i));
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
        ctx.strokeStyle = `rgba(${C.ghost},${a})`;
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
          ctx.strokeStyle = C.rollerOn;
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
      ctx.fillStyle = C.boxShadow;
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
        ctx.fillStyle = rgba(C.warn, C.light ? 0.18 : 0.16);
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
        ctx.strokeStyle = this.tool === 'block' ? (blocked ? C.ok : C.alarm) : C.hover;
        ctx.lineWidth = this.px(1.2);
        ctx.setLineDash([5, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (h.station) {
        const st = Wd.stationMap[h.station];
        ctx.strokeStyle = C.hover;
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
      // Status lights sit on the robot's own dark deck, so they keep the bright tones in both styles
      const tone = TONE_ON_DARK[sim.status(r).tone] || DARK.ok;
      const a = this.dimFor(r.i) < 1 ? 0.75 : 1;
      ctx.save();
      ctx.globalAlpha = a;
      // Contact shadow, offset in world space
      ctx.save();
      ctx.translate(r.x + 2, r.y + 3);
      ctx.rotate(r.h);
      ctx.fillStyle = C.robotShadow;
      rr(ctx, -L / 2, -W / 2, L, W, 6);
      ctx.fill();
      ctx.restore();
      ctx.translate(r.x, r.y);
      ctx.rotate(r.h);
      // Chassis
      ctx.fillStyle = C.robotBody;
      rr(ctx, -L / 2, -W / 2, L, W, 6);
      ctx.fill();
      ctx.strokeStyle = C.robotEdge;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // Front bumper, and the rear bumper band in the robot's fleet colour
      ctx.fillStyle = '#1d2024';
      ctx.fillRect(L / 2 - 3.5, -W / 2 + 4, 2.5, W - 8);
      ctx.fillStyle = r.color;
      ctx.fillRect(-L / 2 + 1, -W / 2 + 4, 4, W - 8);
      // Top deck with status light strip
      ctx.fillStyle = C.robotDeck;
      rr(ctx, -L / 2 + 7, -W / 2 + 5, L - 14, W - 10, 3);
      ctx.fill();
      ctx.strokeStyle = tone;
      ctx.lineWidth = 1.7;
      rr(ctx, -L / 2 + 6.5, -W / 2 + 3.4, L - 12, W - 6.8, 4);
      ctx.stroke();
      // Heading chevron
      ctx.strokeStyle = C.chevron;
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
      ctx.strokeStyle = C.select;
      ctx.lineWidth = this.px(1);
      ctx.strokeRect(-L / 2, -W / 2, L, W);
      ctx.fillStyle = C.select;
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
        ctx.strokeStyle = `rgba(${C.link},${0.6 * env})`;
        ctx.lineWidth = this.px(1);
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
        ctx.setLineDash([]);
        // One message packet A → B, then the reply B → A
        const u = clamp(life / 0.35, 0, 1), v = clamp((life - 0.4) / 0.35, 0, 1);
        const dot = (P, Q, f) => {
          if (f <= 0 || f >= 1) return;
          ctx.fillStyle = `rgba(${C.packet},${env})`;
          ctx.beginPath(); ctx.arc(P.x + (Q.x - P.x) * f, P.y + (Q.y - P.y) * f, this.px(3), 0, Math.PI * 2); ctx.fill();
        };
        dot(A, B, u);
        dot(B, A, v);
      }
    }

    // ------------------------------------------------------------------ screen-space annotations
    tag(ctx, x, y, parts, opt) {
      opt = opt || {};
      // Labels belong to something on the map: skip them when that thing is out of view
      if (x < -80 || x > this.cw + 80 || y < -30 || y > this.ch + 30) return null;
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
      if (C.light) {
        ctx.shadowColor = 'rgba(40,48,56,0.18)';
        ctx.shadowBlur = 4 * this.dpr;
        ctx.shadowOffsetY = 1 * this.dpr;
      }
      ctx.fillStyle = opt.bg || C.tagBg;
      ctx.fillRect(x0, y0, w, h);
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
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
        const parts = [{ text: st.id, mono: true, weight: 600, color: C.stationText, size }];
        let border = C.tagEdge;
        if (tg) {
          border = idc(tg.r);
          if (!this.compact) parts.push({ text: ' ' + tg.kind, color: idc(tg.r), weight: 600, size: size - 0.5 });
        } else if (S.obj && S.obj.state === 'waiting' && !this.compact) {
          parts.push({ text: ' ' + S.obj.task, mono: true, color: C.waitingText, size: size - 1 });
        }
        if (this.hover && this.hover.station === st.id) border = C.select;
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
          this.tag(ctx, x, this.sy(r.y) - this.scale * 30 - 9, [{ square: true, color: idc(r), gap: 3 }, { text: r.id.slice(-2), mono: true, weight: 600, size: 9 }], { size: 9, padX: 3, padY: 4, alpha: a });
          continue;
        }
        let y = this.sy(r.y) - this.scale * 34 - 12;
        for (const p of placed) if (Math.abs(p.x - x) < 120 && Math.abs(p.y - y) < 21) y = p.y - 21;
        placed.push({ x, y });
        const size = this.fs(11);
        const parts = [{ square: true, color: idc(r), gap: 5 }, { text: r.id, mono: true, weight: 600, size }];
        if (!QUIET[st.key]) parts.push({ text: '  ' + st.label, color: TONE[st.tone] || C.text2, weight: 600, size: size - 0.5 });
        this.tag(ctx, x, y, parts, { size, alpha: a, border: this.selected === r.i ? C.select : C.tagEdge });
      }
    }

    drawCallouts(ctx) {
      const sim = this.sim;
      if (this.compact) return;
      const boxes = [];
      for (let i = sim.fx.links.length - 1; i >= 0 && boxes.length < 3; i--) {
        const l = sim.fx.links[i];
        const A = sim.robots[l.a], B = sim.robots[l.b];
        const ca = idc(A), cb = idc(B);
        const life = (sim.t - l.t0) / l.dur;
        const env = clamp(life / 0.1, 0, 1) * clamp((1 - life) / 0.25, 0, 1);
        const size = this.fs(10.5);
        const sm = size - 1;
        const lines = [
          [{ text: 'V2V  ', color: C.muted, mono: true, size: sm }, { text: A.id, color: ca, mono: true, weight: 600, size: sm },
            { text: ' ↔ ', color: C.muted, size: sm }, { text: B.id, color: cb, mono: true, weight: 600, size: sm }],
          [{ text: A.id.slice(-2) + '  ', color: ca, mono: true, weight: 600, size }, { text: l.chipA || '', color: C.text, size }],
        ];
        if (l.chipB && life > 0.4) {
          const warn = l.kind === 'yield' || l.kind === 'corridor' || l.kind === 'deadlock';
          lines.push([{ text: B.id.slice(-2) + '  ', color: cb, mono: true, weight: 600, size }, { text: l.chipB, color: warn ? C.warn : C.text, size }]);
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
        if (C.light) { ctx.shadowColor = 'rgba(40,48,56,0.2)'; ctx.shadowBlur = 8 * this.dpr; ctx.shadowOffsetY = 2 * this.dpr; }
        ctx.fillStyle = C.calloutBg;
        ctx.fillRect(x, y, w, h);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
        ctx.strokeStyle = C.calloutEdge;
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
      for (const h of this.sim.humans) if (Math.hypot(h.x - p.x, h.y - p.y) < 16) return { human: h.i };
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

  // The robot's own status lights sit on its dark deck, so they keep the bright console tones
  const TONE_ON_DARK = tones(DARK);

  WH.Renderer = Renderer;
  // The side panel is always dark: it uses the dark palette and tones
  WH.TONE = TONE_ON_DARK;
  WH.COLORS = DARK;
  WH.MAP_PALETTES = { dark: DARK, light: LIGHT };
})(typeof window !== 'undefined' ? window : globalThis);
