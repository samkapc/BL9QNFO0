/*
 * home.js — instances overview: one card per warehouse layout with a floor-plan preview drawn
 * from the layout data, the "Create instance" tile (see create.js), and the actions on
 * instances created in this browser: edit, duplicate and delete (with undo).
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

  const ICON = {
    device: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1"/><path d="M5.5 13.5h5M8 11v2.5"/></svg>',
    more: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
    arrow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
    close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>',
  };

  function cardHTML(L) {
    const nodes = L.nodes.filter((n) => n.kind !== 'station').length;
    const segs = L.edges.filter((e) => e.kind !== 'spur').length;
    const zones = [...new Set(L.stations.map((s) => L.zoneNames[s.zone]))];
    const local = L.custom
      ? `<span class="inst-local" title="Saved in this browser only">${ICON.device}This browser</span>
         <button class="btn icon inst-more" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Actions for ${esc(L.name)}" title="Actions">${ICON.more}</button>`
      : '';
    return `
      <article class="inst${L.custom ? ' custom' : ''}" data-layout="${L.id}">
        <div class="inst-thumb" style="aspect-ratio:${L.W} / ${L.H}"><canvas data-layout="${L.id}" aria-hidden="true"></canvas></div>
        <div class="inst-body">
          <div class="inst-top"><span class="inst-no">Instance ${L.instance}</span>
            <span class="inst-top-r"><span class="inst-state"><i class="led ok"></i>Ready</span>${local}</span></div>
          <h2><a class="inst-link" href="#${L.slug}">${esc(L.name)}</a> <span class="inst-kind">${esc(L.kind)}</span></h2>
          <p class="inst-sum">${esc(L.summary)}</p>
          <dl class="inst-meta">
            <div><dt>Floor</dt><dd>${L.floorM[0].toFixed(1)} × ${L.floorM[1].toFixed(1)} m</dd></div>
            <div><dt>Robots · people</dt><dd>${L.robots.length} · ${L.peds ? L.peds.walkers.length : 0}</dd></div>
            <div><dt>Stations</dt><dd>${L.stations.length}</dd></div>
            <div><dt>Nodes · path segments</dt><dd>${nodes} · ${segs}</dd></div>
          </dl>
          <p class="inst-zones">${zones.map((z) => `<span>${esc(z)}</span>`).join('')}</p>
        </div>
        <div class="inst-foot"><span>Open console</span>${ICON.arrow}</div>
      </article>`;
  }

  class Home {
    constructor(el) {
      this.el = el;
      this.grid = el.querySelector('#instGrid');
      this.createTile = this.grid.querySelector('.inst-new');
      this.count = document.getElementById('instCount');
      this.dialog = null;
      WH.layoutList.forEach((L) => this.grid.insertBefore(this.cardEl(L), this.createTile));
      this.updateCount();
      this.draw();
      this.buildMenu();
      this.toasts = document.createElement('div');
      this.toasts.className = 'toasts';
      this.toasts.setAttribute('aria-live', 'polite');
      document.body.appendChild(this.toasts);

      this.createTile.addEventListener('click', () => this.openDialog({ from: this.createTile }));
      this.grid.addEventListener('click', (ev) => {
        const more = ev.target.closest('.inst-more');
        if (more) { ev.preventDefault(); this.toggleMenu(more); }
      });
      root.addEventListener('keydown', (ev) => {
        // "N" opens the create dialog from anywhere on the page
        if (ev.key.toLowerCase() === 'n' && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !this.isTyping(ev.target) && !(this.dialog && this.dialog.el.open)) {
          ev.preventDefault();
          this.openDialog({ from: this.createTile });
        }
      });
      WH.store.onChange(() => this.sync());
      if (WH.route.missing) {
        const n = WH.route.missing.replace('instance-', '');
        this.toast(`Instance ${n} isn't saved in this browser. It may have been deleted, or created in another browser.`, [], { tone: 'warn' });
        if (root.history && root.history.replaceState) root.history.replaceState(null, '', root.location.pathname + root.location.search);
      }

      let pending = false;
      const redraw = () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; this.draw(); });
      };
      if (root.ResizeObserver) new ResizeObserver(redraw).observe(this.grid);
      else root.addEventListener('resize', redraw);
    }

    isTyping(t) { return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable); }

    openDialog(opts) {
      if (!this.dialog) this.dialog = new WH.CreateDialog(this);
      this.closeMenu();
      this.dialog.open(opts);
    }

    // ------------------------------------------------------------------ cards
    cardEl(L) {
      const t = document.createElement('template');
      t.innerHTML = cardHTML(L).trim();
      return t.content.firstElementChild;
    }
    cardFor(id) { return this.grid.querySelector(`.inst[data-layout="${id}"]`); }
    insertCard(L, fresh) {
      const el = this.cardEl(L);
      const after = [...this.grid.querySelectorAll('.inst')].find((c) => WH.layouts[c.dataset.layout] && WH.layouts[c.dataset.layout].instance > L.instance);
      this.grid.insertBefore(el, after || this.createTile);
      this.drawCard(el);
      if (fresh) {
        el.classList.add('fresh');
        setTimeout(() => el.classList.remove('fresh'), 2600);
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      return el;
    }
    replaceCard(L) {
      const old = this.cardFor(L.id);
      if (!old) return this.insertCard(L, true);
      const el = this.cardEl(L);
      old.replaceWith(el);
      this.drawCard(el);
      el.classList.add('fresh');
      setTimeout(() => el.classList.remove('fresh'), 2600);
      return el;
    }
    removeCard(id) {
      const el = this.cardFor(id);
      if (!el) return;
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    }
    updateCount() {
      const n = WH.layoutList.length;
      this.count.textContent = `${n} instance${n === 1 ? '' : 's'}`;
    }
    drawCard(el) {
      const cv = el.querySelector('canvas[data-layout]');
      if (cv) drawPreview(cv, WH.layouts[cv.dataset.layout]);
    }
    draw() {
      this.grid.querySelectorAll('canvas[data-layout]').forEach((cv) => {
        const L = WH.layouts[cv.dataset.layout];
        if (L) drawPreview(cv, L);
      });
    }

    // ------------------------------------------------------------------ card menu
    buildMenu() {
      const m = document.createElement('div');
      m.className = 'menu inst-menu';
      m.setAttribute('role', 'menu');
      m.hidden = true;
      m.innerHTML = `
        <button type="button" role="menuitem" data-act="edit">Edit layout…</button>
        <button type="button" role="menuitem" data-act="duplicate">Duplicate</button>
        <div class="menu-sep" role="separator"></div>
        <button type="button" role="menuitem" class="danger" data-act="delete">Delete</button>`;
      this.menu = m;
      m.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-act]');
        if (!b) return;
        const L = WH.layouts[this.menuFor];
        const btn = this.menuBtn;
        this.closeMenu(true);
        if (!L) return;
        if (b.dataset.act === 'edit') this.openDialog({ rec: L.record, from: btn });
        if (b.dataset.act === 'duplicate') this.duplicate(L.record);
        if (b.dataset.act === 'delete') this.remove(L.record);
      });
      m.addEventListener('keydown', (ev) => {
        const items = [...m.querySelectorAll('[role="menuitem"]')];
        const i = items.indexOf(document.activeElement);
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
        } else if (ev.key === 'Home' || ev.key === 'End') {
          ev.preventDefault();
          items[ev.key === 'Home' ? 0 : items.length - 1].focus();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          this.closeMenu(true);
        } else if (ev.key === 'Tab') this.closeMenu();
      });
      document.addEventListener('pointerdown', (ev) => {
        if (!m.hidden && !m.contains(ev.target) && ev.target !== this.menuBtn && !(this.menuBtn && this.menuBtn.contains(ev.target))) this.closeMenu();
      });
    }
    toggleMenu(btn) {
      if (!this.menu.hidden && this.menuBtn === btn) { this.closeMenu(true); return; }
      this.closeMenu();
      const card = btn.closest('.inst');
      this.menuFor = card.dataset.layout;
      this.menuBtn = btn;
      btn.parentElement.appendChild(this.menu);
      this.menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      this.menu.querySelector('[role="menuitem"]').focus();
    }
    closeMenu(refocus) {
      if (this.menu.hidden) return;
      this.menu.hidden = true;
      if (this.menuBtn) {
        this.menuBtn.setAttribute('aria-expanded', 'false');
        if (refocus && this.menuBtn.isConnected) this.menuBtn.focus();
      }
    }

    // ------------------------------------------------------------------ actions
    /** Called by the dialog once a record is safely stored. */
    saved(rec, mode) {
      const L = WH.grid.register(rec);
      if (mode === 'edit') {
        this.replaceCard(L);
        this.toast(`Saved changes to ${rec.name}.`, [{ label: 'Open console', href: '#' + L.slug }]);
      } else {
        this.insertCard(L, true);
        this.toast(`${rec.name} created and saved in this browser.`, [{ label: 'Open console', href: '#' + L.slug }]);
      }
      this.updateCount();
    }

    uniqueName(base) {
      const taken = new Set(WH.layoutList.map((l) => l.name.toLowerCase()));
      base = base.slice(0, 26);
      for (let k = 1; ; k++) {
        const nm = k === 1 ? `${base} copy` : `${base} copy ${k}`;
        if (!taken.has(nm.toLowerCase())) return nm;
      }
    }

    duplicate(rec) {
      const now = Date.now();
      const copy = Object.assign({}, rec, {
        id: WH.store.newId(), n: WH.grid.nextNumber(), name: this.uniqueName(rec.name), created: now, updated: now, rev: 1,
      });
      if (!WH.store.put(copy)) { this.toast('This browser refused to save the copy (storage is full or blocked).', [], { tone: 'warn' }); return; }
      const L = WH.grid.register(copy);
      this.insertCard(L, true);
      this.updateCount();
      this.toast(`Duplicated as ${copy.name}.`, [{ label: 'Edit', run: () => this.openDialog({ rec: copy }) }]);
    }

    remove(rec) {
      if (!WH.store.remove(rec.id)) { this.toast('This browser refused the change (storage is blocked).', [], { tone: 'warn' }); return; }
      const id = 'custom-' + rec.id;
      WH.grid.unregister(id);
      this.removeCard(id);
      this.updateCount();
      this.toast(`Deleted ${rec.name}.`, [{
        label: 'Undo',
        run: () => {
          if (!WH.store.put(rec)) return;
          const L = WH.grid.register(rec);
          this.insertCard(L, true);
          this.updateCount();
          this.toast(`Restored ${rec.name}.`, []);
        },
      }], { ms: 9000 });
      this.createTile.focus();
    }

    /** Another tab of this browser changed the saved instances: bring the cards up to date. */
    sync() {
      const recs = WH.store.list();
      const ids = new Set(recs.map((r) => 'custom-' + r.id));
      for (const L of WH.layoutList.filter((l) => l.custom)) {
        if (!ids.has(L.id)) { WH.grid.unregister(L.id); this.removeCard(L.id); }
      }
      for (const rec of recs) {
        const L0 = WH.layouts['custom-' + rec.id];
        if (L0 && L0.record.updated === rec.updated && L0.record.name === rec.name) continue;
        const L = WH.grid.register(rec);
        if (L0) this.replaceCard(L); else this.insertCard(L, false);
      }
      this.updateCount();
    }

    // ------------------------------------------------------------------ toasts
    toast(msg, actions, opts) {
      opts = opts || {};
      this.toasts.querySelectorAll('.toast-i').forEach((t) => t.remove());
      const t = document.createElement('div');
      t.className = 'toast-i' + (opts.tone ? ' ' + opts.tone : '');
      t.innerHTML = `<p>${esc(msg)}</p>${(actions || []).map((a, i) => (a.href
        ? `<a class="linkbtn" href="${esc(a.href)}">${esc(a.label)}</a>`
        : `<button type="button" class="linkbtn" data-i="${i}">${esc(a.label)}</button>`)).join('')}
        <button type="button" class="btn icon toast-x" aria-label="Dismiss">${ICON.close}</button>`;
      this.toasts.appendChild(t);
      requestAnimationFrame(() => t.classList.add('in'));
      let timer = null;
      const dismiss = () => {
        clearTimeout(timer);
        t.classList.remove('in');
        setTimeout(() => t.remove(), 200);
      };
      const arm = () => { clearTimeout(timer); timer = setTimeout(dismiss, opts.ms || 6500); };
      t.addEventListener('mouseenter', () => clearTimeout(timer));
      t.addEventListener('mouseleave', arm);
      t.addEventListener('focusin', () => clearTimeout(timer));
      t.addEventListener('focusout', arm);
      t.addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        if (b.classList.contains('toast-x')) { dismiss(); return; }
        const a = actions[Number(b.dataset.i)];
        dismiss();
        if (a && a.run) a.run();
      });
      arm();
    }
  }

  WH.drawPreview = drawPreview;
  WH.Home = Home;
})(window);
