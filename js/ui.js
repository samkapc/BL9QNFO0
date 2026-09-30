/*
 * ui.js — console chrome for EdgeFleet: robots table and detail, tasks table, summary,
 * event log, playback, map tools, layers, zoom/pan and map hover/click.
 */
(function (root) {
  'use strict';
  const WH = root.WH;
  const Wd = WH.world;
  const C = WH.COLORS;
  const TONE = WH.TONE;

  const BOX = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 5 8 2.5 13.5 5v6L8 13.5 2.5 11z"/><path d="M2.5 5 8 7.5 13.5 5M8 7.5v6"/></svg>';
  const LEVEL_ICON = {
    info: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="2.2" fill="currentColor"/></svg>',
    notice: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="6" cy="6" r="4.6"/><path d="M6 5.2v3.2M6 3.4v.1"/></svg>',
    warn: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M6 1.6 11 10.4H1z"/><path d="M6 5v2.4M6 8.8v.1"/></svg>',
    alarm: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="currentColor"/><path d="M6 3.4v3.4M6 8.3v.2" stroke="#1a1d20" stroke-width="1.4"/></svg>',
  };
  const LEVEL = {
    system: 'info', task: 'info', claim: 'info', pickup: 'info', deliver: 'info',
    negotiate: 'notice', reroute: 'notice', resolve: 'notice', clear: 'notice',
    conflict: 'warn', deadlock: 'warn', block: 'warn', alert: 'alarm',
  };
  const TASK_TYPES = { system: 1, task: 1, claim: 1, pickup: 1, deliver: 1 };
  const HINT = {
    select: 'Click a robot or station to inspect it. Drag to pan, scroll to zoom.',
    block: 'Click a path segment to block it for 25 s. Click a blocked segment to reopen it.',
  };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const p2 = (n) => String(n).padStart(2, '0');
  const toM = (u) => (u / Wd.UNITS_PER_M);

  class UI {
    constructor(sim, renderer) {
      this.sim = sim;
      this.rd = renderer;
      this.speed = 1;
      this.paused = false;
      this.filter = 'all';
      this.lastEv = 0;
      this.log = [];
      this.nextPanel = 0;
      this.deliveryTimes = [];
      const start = new Date();
      start.setMilliseconds(0);
      this.t0 = start.getTime();
      const $ = (id) => document.getElementById(id);
      this.el = {
        clock: $('clock'), btnPlay: $('btnPlay'), icoPause: $('icoPause'), icoPlay: $('icoPlay'), speedSel: $('speedSel'),
        wrap: $('canvasWrap'), canvas: $('map'), tip: $('tip'), toast: $('toast'), hint: $('toolHint'),
        cursorPos: $('cursorPos'), zoomPct: $('zoomPct'), scaleBar: $('scaleBar'),
        robotRows: $('robotRows'), detail: $('robotDetail'), taskRows: $('taskRows'), taskMeta: $('taskMeta'), logEl: $('log'),
        kDel: $('kDel'), kThr: $('kThr'), kAct: $('kAct'), kCon: $('kCon'), kRer: $('kRer'), kCol: $('kCol'),
        btnLayers: $('btnLayers'), layersMenu: $('layersMenu'),
      };
      this.buildRobotRows();
      this.bindControls();
      this.bindMap();
      this.bindKeys();
      this.updateViewInfo();
      this.setMapTheme(this.rd.theme, true);
    }

    // Floor plan style: only the map switches, the console around it stays dark
    setMapTheme(theme, initial) {
      if (!initial) this.rd.setTheme(theme);
      const t = this.rd.theme;
      document.querySelectorAll('.btn.theme').forEach((b) => {
        const on = b.dataset.theme === t;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
      this.el.wrap.classList.toggle('light', t === 'light');
      if (!initial) { try { root.localStorage.setItem('edgefleet.mapTheme', t); } catch (e) { /* storage unavailable */ } }
    }

    clock(t) {
      const d = new Date(this.t0 + t * 1000);
      return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    }

    // ------------------------------------------------------------------ robots
    buildRobotRows() {
      this.rows = this.sim.robots.map((r) => {
        const row = document.createElement('div');
        row.className = 'row';
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-pressed', 'false');
        row.innerHTML = `
          <div class="cells">
            <span class="rid"><i class="idsq" style="background:${r.color}"></i>${r.id}</span>
            <span class="state">–</span>
            <span class="route">–</span>
            <span class="load r">${BOX}</span>
          </div>
          <div class="sub">–</div>
          <div class="bar"><i></i></div>`;
        const toggle = () => this.select(this.rd.selected === r.i ? -1 : r.i);
        row.addEventListener('click', toggle);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        this.el.robotRows.appendChild(row);
        return {
          row, state: row.querySelector('.state'), route: row.querySelector('.route'), load: row.querySelector('.load'),
          sub: row.querySelector('.sub'), bar: row.querySelector('.bar i'), key: '',
        };
      });
    }

    select(i) {
      this.rd.selected = i;
      this.rows.forEach((x, k) => {
        x.row.classList.toggle('sel', k === i);
        x.row.setAttribute('aria-pressed', String(k === i));
      });
      this.el.detail.hidden = i < 0;
      this.updateDetail();
    }

    taskProgress(r) {
      const lp = this.sim.legProgress(r);
      if (r.mode === 'toPickup') return lp * 0.5;
      if (r.mode === 'loading') return 0.5;
      if (r.mode === 'toDrop') return 0.5 + lp * 0.5;
      return r.mode === 'unloading' ? 1 : 0;
    }

    updateRobots() {
      const sim = this.sim;
      sim.robots.forEach((r, k) => {
        const x = this.rows[k];
        const st = sim.status(r);
        if (x.state.textContent !== st.label) x.state.textContent = st.label;
        x.state.style.setProperty('--c', TONE[st.tone]);
        const t = r.task;
        const toPick = r.mode === 'toPickup' || r.mode === 'loading';
        const key = t ? t.id + (toPick ? 'p' : 'd') : 'none';
        if (key !== x.key) {
          x.key = key;
          x.route.innerHTML = t
            ? (toPick ? `<b>${t.pickup}</b><span class="arr">→</span>${t.drop}` : `${t.pickup}<span class="arr">→</span><b>${t.drop}</b>`)
            : '<span class="arr">–</span>';
        }
        const carrying = r.carrying || r.mode === 'unloading';
        x.load.classList.toggle('on', carrying);
        x.load.title = carrying ? 'Carrying payload' : 'Empty';
        if (x.sub.textContent !== st.text) x.sub.textContent = st.text;
        x.bar.style.width = (this.taskProgress(r) * 100).toFixed(1) + '%';
      });
    }

    updateDetail() {
      const i = this.rd.selected;
      if (i < 0) return;
      const sim = this.sim, r = sim.robots[i], st = sim.status(r), t = r.task;
      const reserved = [];
      for (const n of r.held.nodes) if (Wd.nodeMap[n].kind !== 'station') reserved.push(n);
      for (const e of r.held.edges) reserved.push(Wd.edgeMap[e].name);
      const heading = ((Math.round((r.h * 180) / Math.PI) % 360) + 360) % 360;
      const seg = r.route && r.route.idx < r.route.nodes.length
        ? `${Wd.edgeBetween(r.prev, r.route.nodes[r.route.idx]).name} → ${r.route.nodes[r.route.idx]}`
        : r.station ? `Docked at ${r.station}` : '–';
      const leg = !t ? '–' : r.mode === 'toPickup' ? `To pickup ${t.pickup}, ${Math.round(sim.legProgress(r) * 100)}%`
        : r.mode === 'toDrop' ? `To drop-off ${t.drop}, ${Math.round(sim.legProgress(r) * 100)}%`
        : r.mode === 'loading' ? `Loading at ${t.pickup}` : `Unloading at ${t.drop}`;
      const rows = [
        ['State', `<span class="state" style="--c:${TONE[st.tone]}">${esc(st.label)}</span>`],
        ['Detail', esc(st.text)],
        ['Task', t ? `<span class="mono">${t.id}</span> · ${t.pickup} → ${t.drop}` : 'None'],
        ['Leg', esc(leg)],
        ['Payload', r.carrying || r.mode === 'unloading' ? `Carton for ${t ? t.drop : '–'}` : 'None'],
        ['Speed', `<span class="mono">${toM(r.v).toFixed(2)} m/s</span>`],
        ['Pose', `<span class="mono">${toM(r.x - Wd.WALL.x0).toFixed(2)}, ${toM(r.y - Wd.WALL.y0).toFixed(2)} m · ${heading}°</span>`],
        ['Segment', esc(seg)],
        ['Reserved', reserved.length ? esc(reserved.join(', ')) : 'None'],
        ['Completed', `${r.deliveries} task${r.deliveries === 1 ? '' : 's'} · ${toM(r.odo).toFixed(0)} m driven`],
      ];
      this.el.detail.innerHTML =
        `<h3><i class="idsq" style="background:${r.color}"></i><span class="mono">${r.id}</span><span class="x">Esc to close</span></h3>` +
        `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
    }

    // ------------------------------------------------------------------ tasks & summary
    updateTasks() {
      const sim = this.sim;
      const active = sim.tasks.filter((t) => t.state === 'assigned' || t.state === 'picked');
      const rows = active.concat(sim.pending);
      const status = (t) => {
        if (t.state === 'pending') return ['Queued', C.idle];
        const r = sim.robots[t.robot];
        if (r.mode === 'loading') return ['Loading', C.work];
        if (r.mode === 'unloading') return ['Unloading', C.work];
        return t.state === 'picked' ? ['In transit', C.ok] : ['To pickup', C.ok];
      };
      const html = rows.map((t) => {
        const [label, col] = status(t);
        const r = t.robot >= 0 ? sim.robots[t.robot] : null;
        return `<div class="row${t.state === 'pending' ? ' queued' : ''}"><div class="cells">` +
          `<span>${t.id}</span><span>${t.pickup}</span><span>${t.drop}</span>` +
          `<span>${r ? `<span class="rid"><i class="idsq" style="background:${r.color}"></i>${r.id.slice(-2)}</span>` : '–'}</span>` +
          `<span class="st"><span class="state" style="--c:${col}">${label}</span></span></div></div>`;
      }).join('') || '<div class="empty">No tasks</div>';
      if (html !== this.taskHTML) { this.el.taskRows.innerHTML = html; this.taskHTML = html; }
      this.el.taskMeta.textContent = `${active.length} active · ${sim.pending.length} queued`;
      this.activeCount = active.length;
    }

    updateSummary() {
      const sim = this.sim, st = sim.stats;
      const cut = sim.t - 300;
      while (this.deliveryTimes.length && this.deliveryTimes[0] < cut) this.deliveryTimes.shift();
      const win = Math.min(300, sim.t);
      this.el.kDel.textContent = st.deliveries;
      this.el.kThr.textContent = sim.t < 45 ? '–' : ((this.deliveryTimes.length / win) * 60).toFixed(1);
      this.el.kAct.textContent = this.activeCount || 0;
      this.el.kCon.textContent = st.conflicts + st.negotiations + st.deadlocks;
      this.el.kRer.textContent = st.reroutes;
      this.el.kCol.textContent = st.collisions;
      this.el.kCol.classList.toggle('alarm', st.collisions > 0);
      this.el.kCon.parentElement.title = `${st.yields} yields, ${st.negotiations} negotiated, ${st.deadlocks} deadlocks resolved`;
      this.el.kCol.parentElement.title = isFinite(st.minSep) ? `Closest approach ${toM(st.minSep).toFixed(2)} m centre to centre` : '';
      this.el.clock.textContent = this.clock(sim.t);
    }

    // ------------------------------------------------------------------ event log
    partHTML(p) {
      if (typeof p === 'string') return esc(p);
      if (p.r != null) { const r = this.sim.robots[p.r]; return `<span class="r" style="--rc:${r.color}"><i></i>${r.id}</span>`; }
      if (p.n) return `<span class="n">${esc(p.n)}</span>`;
      if (p.s) return `<span class="s">${esc(p.s)}</span>`;
      if (p.task) return `<span class="t">${esc(p.task)}</span>`;
      if (p.e) { const e = Wd.edgeMap[p.e]; return `<span class="e">${esc(e ? e.name : p.e)}</span>`; }
      return '';
    }
    evHTML(ev, fresh) {
      const lv = LEVEL[ev.type] || 'info';
      return `<div class="ev ${lv}${fresh ? ' fresh' : ''}"><time>${this.clock(ev.t)}</time><span class="lv">${LEVEL_ICON[lv]}</span><p>${ev.parts.map((p) => this.partHTML(p)).join('')}</p></div>`;
    }
    passes(ev) {
      if (this.filter === 'all') return true;
      return this.filter === 'tasks' ? !!TASK_TYPES[ev.type] : !TASK_TYPES[ev.type];
    }
    updateLog() {
      const fresh = this.sim.events.filter((e) => e.id > this.lastEv);
      if (!fresh.length) return;
      this.lastEv = fresh[fresh.length - 1].id;
      let html = '';
      for (let i = fresh.length - 1; i >= 0; i--) {
        const ev = fresh[i];
        if (ev.type === 'deliver') this.deliveryTimes.push(ev.t);
        this.log.unshift(ev);
        if (this.passes(ev)) html += this.evHTML(ev, true);
      }
      if (this.log.length > 300) this.log.length = 300;
      if (html) {
        this.el.logEl.insertAdjacentHTML('afterbegin', html);
        while (this.el.logEl.children.length > 120) this.el.logEl.lastElementChild.remove();
      }
    }
    renderLog() {
      this.el.logEl.innerHTML = this.log.filter((e) => this.passes(e)).slice(0, 120).map((e) => this.evHTML(e, false)).join('');
    }

    // ------------------------------------------------------------------ controls
    setPaused(p) {
      this.paused = p;
      this.el.icoPause.toggleAttribute('hidden', p);
      this.el.icoPlay.toggleAttribute('hidden', !p);
      this.el.btnPlay.setAttribute('aria-label', p ? 'Resume simulation' : 'Pause simulation');
      this.el.btnPlay.title = p ? 'Resume (Space)' : 'Pause (Space)';
    }
    setSpeed(s) {
      this.speed = s;
      this.el.speedSel.value = String(s);
    }
    setTool(tool) {
      this.rd.tool = tool;
      document.querySelectorAll('.btn.tool').forEach((b) => {
        const on = b.dataset.tool === tool;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
      this.el.wrap.classList.toggle('tool-block', tool === 'block');
      this.el.hint.textContent = HINT[tool];
      if (this.mouse) this.hoverAt(this.mouse);
    }
    setLayer(name, on) {
      this.rd.layers[name] = on;
      const box = document.querySelector(`.mi input[data-layer="${name}"]`);
      if (box) box.checked = on;
    }
    toggleMenu(open) {
      const m = this.el.layersMenu;
      const show = open == null ? m.hidden : open;
      m.hidden = !show;
      this.el.btnLayers.setAttribute('aria-expanded', String(show));
    }
    dropObstruction() {
      const before = Object.keys(this.sim.obstructions).length;
      this.sim.spawnAutoObstruction('user');
      if (Object.keys(this.sim.obstructions).length === before) {
        this.toast('No segment can be blocked right now without trapping a robot or isolating a station.');
      }
    }
    toggleFull() {
      const d = document;
      try {
        if (!d.fullscreenElement) {
          const p = d.documentElement.requestFullscreen && d.documentElement.requestFullscreen();
          if (p && p.catch) p.catch(() => this.toast('Full screen is not available in this view.'));
        } else if (d.exitFullscreen) d.exitFullscreen();
      } catch (e) { this.toast('Full screen is not available in this view.'); }
    }
    toast(msg, good) {
      const t = this.el.toast;
      t.textContent = msg;
      t.classList.toggle('good', !!good);
      t.hidden = false;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
    }

    bindControls() {
      this.el.btnPlay.addEventListener('click', () => this.setPaused(!this.paused));
      this.el.speedSel.addEventListener('change', () => { this.speed = Number(this.el.speedSel.value); });
      document.getElementById('btnFull').addEventListener('click', () => this.toggleFull());
      document.getElementById('btnObstacle').addEventListener('click', () => this.dropObstruction());
      document.querySelectorAll('.btn.tool').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
      document.querySelectorAll('.btn.theme').forEach((b) => b.addEventListener('click', () => this.setMapTheme(b.dataset.theme)));
      document.getElementById('zoomIn').addEventListener('click', () => { this.rd.zoomBy(1.4); this.updateViewInfo(); });
      document.getElementById('zoomOut').addEventListener('click', () => { this.rd.zoomBy(1 / 1.4); this.updateViewInfo(); });
      document.getElementById('zoomFit').addEventListener('click', () => { this.rd.fit(); this.updateViewInfo(); });
      this.el.btnLayers.addEventListener('click', (e) => { e.stopPropagation(); this.toggleMenu(); });
      this.el.layersMenu.addEventListener('click', (e) => e.stopPropagation());
      document.querySelectorAll('.mi input').forEach((b) => b.addEventListener('change', () => this.setLayer(b.dataset.layer, b.checked)));
      document.addEventListener('click', () => this.toggleMenu(false));
      document.querySelectorAll('.filter button').forEach((b) => b.addEventListener('click', () => {
        this.filter = b.dataset.f;
        document.querySelectorAll('.filter button').forEach((x) => x.classList.toggle('on', x === b));
        this.renderLog();
      }));
    }

    bindKeys() {
      root.addEventListener('keydown', (e) => {
        if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const k = e.key.toLowerCase();
        const onButton = e.target && (e.target.tagName === 'BUTTON' || e.target.getAttribute('role') === 'button');
        if (k === ' ' && !onButton) { e.preventDefault(); this.setPaused(!this.paused); }
        else if (k >= '1' && k <= '4') this.setSpeed([0.5, 1, 2, 4][Number(k) - 1]);
        else if (k === 'v') this.setTool('select');
        else if (k === 'b') this.setTool('block');
        else if (k === 'o') this.dropObstruction();
        else if (k === '+' || k === '=') { this.rd.zoomBy(1.4); this.updateViewInfo(); }
        else if (k === '-' || k === '_') { this.rd.zoomBy(1 / 1.4); this.updateViewInfo(); }
        else if (k === '0') { this.rd.fit(); this.updateViewInfo(); }
        else if (k === 'f') this.toggleFull();
        else if (k === 'l') this.setMapTheme(this.rd.theme === 'light' ? 'dark' : 'light');
        else if (k === 'escape') { this.toggleMenu(false); this.select(-1); }
      });
    }

    // ------------------------------------------------------------------ map interaction
    bindMap() {
      const cv = this.el.canvas;
      const pos = (e) => { const b = cv.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
      let down = null;
      cv.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        down = { p: pos(e), last: pos(e), moved: false, id: e.pointerId };
        cv.setPointerCapture(e.pointerId);
      });
      cv.addEventListener('pointermove', (e) => {
        const p = pos(e);
        this.mouse = p;
        if (down) {
          if (!down.moved && Math.hypot(p.x - down.p.x, p.y - down.p.y) > 4) {
            down.moved = true;
            this.el.wrap.classList.add('panning');
            this.el.tip.hidden = true;
          }
          if (down.moved) {
            this.rd.panBy(p.x - down.last.x, p.y - down.last.y);
            down.last = p;
            this.updateViewInfo();
          }
        } else this.hoverAt(p);
        const w = this.rd.toWorld(p.x, p.y);
        this.el.cursorPos.textContent = `X ${toM(w.x - Wd.WALL.x0).toFixed(2)}  Y ${toM(w.y - Wd.WALL.y0).toFixed(2)} m`;
      });
      cv.addEventListener('pointerup', (e) => {
        if (!down) return;
        const click = !down.moved;
        this.el.wrap.classList.remove('panning');
        down = null;
        if (click) this.clickAt(pos(e));
      });
      cv.addEventListener('pointercancel', () => { down = null; this.el.wrap.classList.remove('panning'); });
      cv.addEventListener('pointerleave', () => {
        if (down) return;
        this.mouse = null;
        this.rd.hover = null;
        this.el.tip.hidden = true;
        this.el.cursorPos.textContent = 'X –  Y –';
      });
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const p = pos(e);
        this.rd.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
        this.updateViewInfo();
      }, { passive: false });
      cv.addEventListener('dblclick', (e) => {
        const p = pos(e);
        this.rd.zoomAt(p.x, p.y, 1.8);
        this.updateViewInfo();
      });
    }

    clickAt(p) {
      const hit = this.rd.pick(p.x, p.y);
      if (this.rd.tool === 'block') {
        if (hit && hit.edge) {
          const res = this.sim.toggleObstruction(hit.edge);
          if (!res.ok) this.toast(res.msg);
          else if (res.cleared) this.toast(Wd.edgeMap[hit.edge].name + ' reopened', true);
        } else this.toast('Pick a path segment between two nodes to block it.');
        this.hoverAt(p);
        return;
      }
      if (hit && hit.robot != null) this.select(this.rd.selected === hit.robot ? -1 : hit.robot);
      else if (hit && hit.station) {
        const docked = this.sim.robots.find((r) => r.station === hit.station);
        const owner = this.rd.stationTarget(hit.station);
        const r = docked || (owner && owner.r);
        if (r) this.select(r.i);
      } else if (!hit) this.select(-1);
    }

    hoverAt(p) {
      let hit = this.rd.pick(p.x, p.y);
      if (this.rd.tool === 'block' && hit && !hit.edge) hit = null;
      this.rd.hover = hit && hit.robot == null ? hit : null;
      const tip = this.el.tip;
      if (!hit) { tip.hidden = true; this.el.canvas.style.cursor = ''; return; }
      this.el.canvas.style.cursor = this.rd.tool === 'select' && (hit.robot != null || hit.station) ? 'pointer' : '';
      tip.innerHTML = this.tipHTML(hit);
      tip.hidden = false;
      const W = this.el.wrap.clientWidth, H = this.el.wrap.clientHeight;
      let x = p.x + 14, y = p.y + 16;
      if (x + tip.offsetWidth > W - 6) x = p.x - tip.offsetWidth - 10;
      if (y + tip.offsetHeight > H - 6) y = p.y - tip.offsetHeight - 10;
      tip.style.left = Math.max(6, x) + 'px';
      tip.style.top = Math.max(6, y) + 'px';
    }

    tipHTML(hit) {
      const sim = this.sim;
      if (hit.robot != null) {
        const r = sim.robots[hit.robot], st = sim.status(r);
        return `<b>${r.id}</b> · ${esc(st.label)}<span class="k">${esc(st.text)}</span><span class="a">Click to inspect</span>`;
      }
      if (hit.station) {
        const def = Wd.stationMap[hit.station], S = sim.stations[hit.station];
        const zone = (Wd.zoneNames && Wd.zoneNames[def.zone]) || 'Station';
        const docked = sim.robots.find((r) => r.station === hit.station);
        const tg = this.rd.stationTarget(hit.station);
        let state = 'Available';
        if (docked && (docked.mode === 'loading' || docked.mode === 'unloading')) state = `${docked.id} ${docked.mode}`;
        else if (docked) state = `${docked.id} parked`;
        else if (tg) state = `${tg.kind === 'Pick' ? 'Pickup' : 'Drop-off'} for ${tg.r.id} (${tg.r.task.id})`;
        else if (S.obj && S.obj.state === 'waiting') state = `Payload waiting (${S.obj.task}, queued)`;
        else if (S.res) state = `Reserved by ${S.res}`;
        return `<b>${hit.station}</b> · ${zone}<span class="k">${esc(state)}</span>`;
      }
      const e = Wd.edgeMap[hit.edge];
      const o = sim.obstructions[hit.edge];
      const eh = sim.edgeHold[hit.edge];
      let state = 'Free';
      if (o) state = o.state === 'closing' ? 'Closing after current traffic' : `Blocked, ${Math.max(0, Math.ceil(o.until - sim.t))} s left`;
      else if (eh && eh.set.size) state = 'Reserved by ' + [...eh.set].map((i) => sim.robots[i].id).join(', ');
      const action = this.rd.tool === 'block' ? (o ? 'Click to reopen' : 'Click to block for 25 s') : 'Use Block segment to close it';
      return `<b>${esc(e.name)}</b><span class="k">${esc(state)} · ${toM(e.len).toFixed(1)} m</span><span class="a">${action}</span>`;
    }

    updateViewInfo() {
      this.el.zoomPct.textContent = Math.round(this.rd.k * 100) + '%';
      this.el.scaleBar.style.width = Math.round(5 * Wd.UNITS_PER_M * this.rd.scale) + 'px';
    }

    frame(now) {
      this.updateLog();
      if (now >= this.nextPanel) {
        this.nextPanel = now + 150;
        this.updateRobots();
        this.updateTasks();
        this.updateSummary();
        this.updateDetail();
        if (this.mouse && !this.el.wrap.classList.contains('panning')) this.hoverAt(this.mouse);
      }
    }
  }

  WH.UI = UI;
})(window);
