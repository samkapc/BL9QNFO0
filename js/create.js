/*
 * create.js — the "Create instance" dialog on the Instances page. A short form (layout, fleet,
 * floor staff) sits next to a live preview of the floor plan it generates; the unsaved draft is
 * kept in this browser while you work. The same dialog edits an instance created earlier.
 */
(function (root) {
  'use strict';
  const WH = root.WH;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const MAC = /Mac|iPhone|iPad/.test((root.navigator && root.navigator.platform) || '');

  const PRESETS = [
    { id: 'standard', label: 'Standard', hint: 'The Bay 01 arrangement',
      v: { aisles: 4, rows: 3, docks: 'ns', faces: 'one', robots: 3, dockWorkers: 3, aisleWalkers: 2, mix: 'balanced' } },
    { id: 'compact', label: 'Compact', hint: 'Two aisles, two robots',
      v: { aisles: 2, rows: 2, docks: 'ns', faces: 'one', robots: 2, dockWorkers: 2, aisleWalkers: 1, mix: 'balanced' } },
    { id: 'large', label: 'Large hall', hint: 'Five aisles, pick faces on both sides',
      v: { aisles: 5, rows: 4, docks: 'ns', faces: 'both', robots: 5, dockWorkers: 3, aisleWalkers: 2, mix: 'balanced' } },
    { id: 'uflow', label: 'U-flow', hint: 'All dock doors on the north wall',
      v: { aisles: 4, rows: 3, docks: 'n', faces: 'one', robots: 3, dockWorkers: 3, aisleWalkers: 2, mix: 'balanced' } },
  ];

  // Form fields; `help` explains the current choice in one line.
  const SECTIONS = [
    { title: 'Layout', fields: [
      { key: 'docks', label: 'Dock doors', opts: [['ns', 'North and south'], ['n', 'North only']],
        help: (v) => (v.docks === 'ns' ? 'Flow-through: goods arrive on the north wall and leave on the south wall.'
          : 'U-flow: inbound and outbound doors alternate on the north wall, floor storage along the south wall.') },
      { key: 'aisles', label: 'Storage aisles', opts: [2, 3, 4, 5], help: () => 'Aisles running north–south between the rack rows.' },
      { key: 'rows', label: 'Cross-aisles', opts: [2, 3, 4], help: () => 'Aisles running east–west; the racking sits between them.' },
      { key: 'faces', label: 'Pick faces', opts: [['one', 'One side'], ['both', 'Both sides']],
        help: (v) => (v.faces === 'one' ? 'One pick-face station beside each aisle section.' : 'A pick-face station on each side of every aisle section.') },
    ] },
    { title: 'Fleet and floor staff', fields: [
      { key: 'robots', label: 'Robots', opts: [1, 2, 3, 4, 5], help: null },
      { key: 'mix', label: 'Task mix', opts: [['balanced', 'Balanced'], ['inbound', 'Receiving peak'], ['outbound', 'Shipping peak']],
        help: (v) => ({ balanced: 'Even mix of receiving, put-away, picking and shipping moves.',
          inbound: 'Half of all moves take goods from the docks into storage.',
          outbound: 'Half of all moves take goods from storage to the docks.' }[v.mix]) },
      { key: 'dockWorkers', label: 'Dock workers', opts: [0, 1, 2, 3], help: () => 'They stay on the walkways and use the crosswalks.' },
      { key: 'aisleWalkers', label: 'Shared-aisle walkers', opts: [0, 1, 2],
        help: () => 'They walk the robot lanes; robots slow down and pass them.' },
    ] },
  ];
  const FIELD = Object.fromEntries(SECTIONS.flatMap((s) => s.fields).map((f) => [f.key, f]));
  const KEYS = Object.keys(FIELD);

  const ICON = {
    close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
    device: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1"/><path d="M5.5 13.5h5M8 11v2.5"/></svg>',
    check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>',
    warn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3M8 11.5v.1"/></svg>',
  };

  function segHTML(f) {
    const opts = f.opts.map((o) => (Array.isArray(o) ? o : [o, String(o)]));
    return `
      <fieldset class="cd-field" data-key="${f.key}">
        <legend>${esc(f.label)}</legend>
        <div class="seg${opts.length > 3 ? ' num' : ''}">
          ${opts.map(([v, t]) => `<label><input type="radio" name="cd-${f.key}" value="${v}"><span>${esc(t)}</span></label>`).join('')}
        </div>
        <p class="cd-help" id="cd-help-${f.key}"></p>
      </fieldset>`;
  }

  function dialogHTML() {
    return `
      <form class="cd-form" method="dialog" novalidate>
        <header class="cd-head">
          <div>
            <h2 id="cdTitle">Create instance</h2>
            <p class="cd-sub" id="cdSub">Generates a cross-aisle warehouse, its path network, fleet and floor staff.</p>
          </div>
          <button class="btn icon cd-x" type="button" data-act="cancel" aria-label="Close" title="Close (Esc)">${ICON.close}</button>
        </header>
        <div class="cd-draftbar" id="cdDraftBar" hidden>
          <span>Restored your unsaved draft.</span>
          <button type="button" class="linkbtn" data-act="fresh">Start over</button>
        </div>
        <div class="cd-body">
          <div class="cd-left">
            <div class="cd-name">
              <label for="cdName">Name</label>
              <input id="cdName" name="name" type="text" maxlength="32" autocomplete="off" spellcheck="false"
                aria-describedby="cdNameMsg" required>
              <p class="cd-msg" id="cdNameMsg" aria-live="polite"></p>
            </div>
            <div class="cd-presets" role="group" aria-labelledby="cdPresetsLbl">
              <span class="cd-lbl" id="cdPresetsLbl">Start from</span>
              <div class="chips">
                ${PRESETS.map((p) => `<button type="button" class="chip" data-preset="${p.id}" title="${esc(p.hint)}" aria-pressed="false">${esc(p.label)}</button>`).join('')}
              </div>
            </div>
            ${SECTIONS.map((s) => `<section class="cd-sec"><h3>${esc(s.title)}</h3>${s.fields.map(segHTML).join('')}</section>`).join('')}
          </div>
          <div class="cd-right">
            <div class="cd-preview" id="cdPreview">
              <canvas class="pv front" aria-hidden="true"></canvas>
              <canvas class="pv" aria-hidden="true"></canvas>
              <span class="cd-pv-tag">Live preview</span>
            </div>
            <div class="cd-facts" id="cdFacts" aria-live="polite"></div>
          </div>
        </div>
        <footer class="cd-foot">
          <p class="cd-note" id="cdNote"></p>
          <div class="cd-actions">
            <button class="btn" type="button" data-act="cancel">Cancel</button>
            <button class="btn primary" type="submit" id="cdSubmit">Create instance<kbd>${MAC ? '⌘' : 'Ctrl'} ↵</kbd></button>
          </div>
        </footer>
      </form>`;
  }

  class CreateDialog {
    constructor(home) {
      this.home = home;
      const d = document.createElement('dialog');
      d.className = 'cd';
      d.setAttribute('aria-labelledby', 'cdTitle');
      d.innerHTML = dialogHTML();
      document.body.appendChild(d);
      this.el = d;
      this.form = d.querySelector('form');
      this.name = d.querySelector('#cdName');
      this.nameMsg = d.querySelector('#cdNameMsg');
      this.facts = d.querySelector('#cdFacts');
      this.note = d.querySelector('#cdNote');
      this.submitBtn = d.querySelector('#cdSubmit');
      this.canvases = [...d.querySelectorAll('.cd-preview canvas')];
      this.mode = 'create';
      this.rec = null;
      this.touched = false;
      this.prevFacts = {};
      this.bind();
    }

    bind() {
      const d = this.el;
      this.form.addEventListener('change', (ev) => {
        if (ev.target.type === 'radio') this.update({ fade: true, save: true });
      });
      this.name.addEventListener('input', () => {
        if (this.touched) this.validateName();
        this.renderFacts(true);
        this.saveDraftSoon();
      });
      this.name.addEventListener('blur', () => { if (this.name.value.trim()) { this.touched = true; this.validateName(); } });
      d.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
        const p = PRESETS.find((q) => q.id === b.dataset.preset);
        this.setValues(p.v);
        this.update({ fade: true, save: true });
      }));
      d.addEventListener('click', (ev) => {
        const act = ev.target.closest('[data-act]');
        if (act && act.dataset.act === 'cancel') this.close();
        if (act && act.dataset.act === 'fresh') this.startOver();
        // Click on the backdrop (outside the panel) closes; the draft is kept
        if (ev.target === d) this.close();
      });
      d.addEventListener('cancel', (ev) => { ev.preventDefault(); this.close(); });
      this.form.addEventListener('submit', (ev) => { ev.preventDefault(); this.submit(); });
      d.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); this.submit(); }
      });
      let pending = false;
      const redraw = () => {
        if (pending || !d.open) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; this.drawPreview(false); });
      };
      if (root.ResizeObserver) new ResizeObserver(redraw).observe(d.querySelector('#cdPreview'));
    }

    // ------------------------------------------------------------------ open / close
    open(opts) {
      opts = opts || {};
      this.mode = opts.rec ? 'edit' : 'create';
      this.rec = opts.rec || null;
      this.returnFocus = opts.from || document.activeElement;
      this.touched = false;
      this.dirty = false;
      this.nameMsg.textContent = '';
      this.name.removeAttribute('aria-invalid');
      const bar = this.el.querySelector('#cdDraftBar');
      bar.hidden = true;
      const title = this.el.querySelector('#cdTitle'), sub = this.el.querySelector('#cdSub');
      if (this.mode === 'edit') {
        title.textContent = 'Edit ' + this.rec.name;
        sub.textContent = `Instance ${this.rec.n} · changes apply the next time its console opens.`;
        this.submitBtn.firstChild.textContent = 'Save changes';
        this.setValues(WH.grid.spec(this.rec));
        this.name.value = this.rec.name;
        this.number = this.rec.n;
      } else {
        title.textContent = 'Create instance';
        sub.textContent = 'Generates a cross-aisle warehouse, its path network, fleet and floor staff.';
        this.submitBtn.firstChild.textContent = 'Create instance';
        this.number = WH.grid.nextNumber();
        const draft = WH.store.draft.get();
        if (draft && draft.v) {
          this.setValues(WH.grid.spec(draft.v));
          this.name.value = draft.name != null ? draft.name : this.defaultName();
          bar.hidden = false;
        } else {
          this.setValues(PRESETS[0].v);
          this.name.value = this.defaultName();
        }
      }
      this.update({ instant: true });
      this.renderNote();
      document.body.classList.add('modal-open');
      if (this.el.showModal) this.el.showModal(); else this.el.setAttribute('open', '');
      requestAnimationFrame(() => {
        this.el.classList.add('in');
        this.drawPreview(false);
        this.name.focus();
        this.name.select();
      });
    }

    close() {
      if (!this.el.open) return;
      clearTimeout(this.draftTimer);
      if (this.mode === 'create' && this.dirty) this.saveDraft();
      this.el.classList.remove('in');
      const done = () => {
        this.el.removeEventListener('transitionend', done);
        clearTimeout(timer);
        if (this.el.close) this.el.close(); else this.el.removeAttribute('open');
        document.body.classList.remove('modal-open');
        if (this.returnFocus && this.returnFocus.isConnected && this.returnFocus.focus) this.returnFocus.focus();
      };
      const timer = setTimeout(done, 220);
      this.el.addEventListener('transitionend', done);
    }

    startOver() {
      WH.store.draft.clear();
      this.el.querySelector('#cdDraftBar').hidden = true;
      this.setValues(PRESETS[0].v);
      this.name.value = this.defaultName();
      this.touched = false;
      this.dirty = false;
      this.nameMsg.textContent = '';
      this.name.removeAttribute('aria-invalid');
      this.update({ fade: true });
      this.renderNote();
      this.name.focus();
      this.name.select();
    }

    defaultName() {
      const taken = new Set(WH.layoutList.map((l) => l.name.toLowerCase()));
      for (let k = this.number; ; k++) {
        const nm = 'Bay ' + String(k).padStart(2, '0');
        if (!taken.has(nm.toLowerCase())) return nm;
      }
    }

    // ------------------------------------------------------------------ values
    values() {
      const v = {};
      for (const k of KEYS) {
        const r = this.form.querySelector(`input[name="cd-${k}"]:checked`);
        v[k] = r ? (/^\d+$/.test(r.value) ? Number(r.value) : r.value) : undefined;
      }
      return v;
    }
    setValues(v) {
      for (const k of KEYS) {
        const r = this.form.querySelector(`input[name="cd-${k}"][value="${v[k]}"]`);
        if (r) r.checked = true;
      }
    }

    /** Re-derive everything after a change: fleet cap, help lines, preset chip, preview, facts. */
    update(opts) {
      opts = opts || {};
      const raw = this.values();
      const max = WH.grid.maxRobots(raw);
      let clampNote = '';
      if (raw.robots > max) {
        raw.robots = max;
        this.setValues(raw);
        clampNote = `Reduced to ${max} robot${max === 1 ? '' : 's'} to fit the smaller grid.`;
      }
      this.form.querySelectorAll('input[name="cd-robots"]').forEach((r) => {
        const off = Number(r.value) > max;
        r.disabled = off;
        r.parentElement.title = off ? `Up to ${max} robots on a ${raw.aisles} × ${raw.rows} grid` : '';
      });
      const v = WH.grid.spec(raw);
      this.v = v;
      for (const k of KEYS) {
        const f = FIELD[k], p = this.form.querySelector('#cd-help-' + k);
        if (k === 'robots') {
          p.textContent = clampNote || `Up to ${max} on a ${v.aisles} × ${v.rows} grid. Each has its own colour on the map.`;
          p.classList.toggle('flash', !!clampNote);
        } else p.textContent = f.help(v);
      }
      const match = PRESETS.find((p) => KEYS.every((k) => p.v[k] === v[k]));
      this.el.querySelectorAll('[data-preset]').forEach((b) => {
        const on = !!match && b.dataset.preset === match.id;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
      try {
        this.layout = WH.grid.build(v, { name: this.name.value.trim() || 'Untitled', instance: this.number });
      } catch (e) {
        this.layout = null;
      }
      this.drawPreview(!!opts.fade);
      this.renderFacts(!!opts.instant);
      if (opts.save) this.saveDraftSoon();
    }

    drawPreview(fade) {
      if (!this.layout || !WH.drawPreview) return;
      const [a, b] = this.canvases;
      const front = a.classList.contains('front') ? a : b, back = front === a ? b : a;
      if (!fade) { WH.drawPreview(front, this.layout); return; }
      WH.drawPreview(back, this.layout);
      back.classList.add('front');
      front.classList.remove('front');
    }

    renderFacts(instant) {
      const L = this.layout;
      if (!L) { this.facts.innerHTML = '<p class="cd-sum">This combination could not be generated.</p>'; return; }
      const zones = { inbound: 0, storage: 0, outbound: 0 };
      L.stations.forEach((s) => { zones[s.zone]++; });
      const nodes = L.nodes.filter((n) => n.kind !== 'station').length;
      const segs = L.edges.filter((e) => e.kind !== 'spur').length;
      const people = L.peds ? L.peds.walkers.length : 0;
      const name = this.name.value.trim() || 'Untitled';
      const facts = {
        floor: `${L.floorM[0].toFixed(1)} × ${L.floorM[1].toFixed(1)} m`,
        stations: String(L.stations.length),
        split: `${zones.inbound} inbound · ${zones.storage} pick face · ${zones.outbound} outbound`,
        net: `${nodes} · ${segs}`,
        fleet: String(L.robots.length),
        people: String(people),
      };
      const bump = (k) => (!instant && this.prevFacts[k] != null && this.prevFacts[k] !== facts[k] ? ' bump' : '');
      this.facts.innerHTML = `
        <div class="cd-id"><span class="inst-no">Instance ${this.number}</span><b>${esc(name)}</b><span class="inst-kind">${esc(L.kind)}</span></div>
        <p class="cd-sum">${esc(L.summary)}</p>
        <dl class="inst-meta">
          <div><dt>Floor</dt><dd class="${bump('floor')}">${facts.floor}</dd></div>
          <div><dt>Stations</dt><dd class="${bump('stations')}">${facts.stations}<small>${facts.split}</small></dd></div>
          <div><dt>Nodes · path segments</dt><dd class="${bump('net')}">${facts.net}</dd></div>
          <div><dt>Robots · people</dt><dd class="${bump('fleet') || bump('people')}">${facts.fleet} · ${facts.people}
            <span class="fleet">${L.robots.map((r) => `<i style="background:${r.color}" title="${r.id}"></i>`).join('')}</span></dd></div>
        </dl>`;
      this.prevFacts = facts;
    }

    renderNote(state) {
      if (state === 'error') return;
      const where = WH.store.persistent
        ? `${ICON.device}<span>Saved in this browser only. It stays here after you close the tab, but is not shared with other browsers.</span>`
        : `${ICON.warn}<span>This browser is blocking storage, so the instance will be lost when the page reloads.</span>`;
      this.note.className = 'cd-note' + (WH.store.persistent ? '' : ' warn');
      this.note.innerHTML = where + (state === 'draft' && this.mode === 'create' ? `<em class="cd-saved">${ICON.check}Draft saved</em>` : '');
    }

    // ------------------------------------------------------------------ draft
    saveDraftSoon() {
      this.dirty = true;
      if (this.mode !== 'create' || !this.el.open) return;
      clearTimeout(this.draftTimer);
      this.draftTimer = setTimeout(() => { this.saveDraft(); this.renderNote('draft'); }, 450);
    }
    saveDraft() {
      if (this.mode !== 'create') return;
      WH.store.draft.set({ v: this.values(), name: this.name.value, t: Date.now() });
    }

    // ------------------------------------------------------------------ submit
    validateName() {
      const nm = this.name.value.trim();
      let msg = '';
      if (!nm) msg = 'Give the instance a name.';
      else if (WH.layoutList.some((l) => l.name.toLowerCase() === nm.toLowerCase() && !(this.rec && l.id === 'custom-' + this.rec.id))) {
        msg = `There is already an instance called “${nm}”.`;
      }
      this.nameMsg.textContent = msg;
      if (msg) this.name.setAttribute('aria-invalid', 'true'); else this.name.removeAttribute('aria-invalid');
      return !msg;
    }

    submit() {
      this.touched = true;
      if (!this.validateName()) { this.name.focus(); return; }
      const v = this.values(), spec = WH.grid.spec(v), name = this.name.value.trim(), now = Date.now();
      let rec;
      if (this.mode === 'edit') {
        const old = this.rec;
        const same = name === old.name && KEYS.every((k) => WH.grid.spec(old)[k] === spec[k]);
        if (same) { this.close(); return; }
        rec = Object.assign({}, old, spec, { name, updated: now, rev: (old.rev || 1) + 1 });
      } else {
        rec = Object.assign({ id: WH.store.newId(), n: this.number, name, created: now, updated: now, rev: 1 }, spec);
      }
      if (!WH.store.put(rec)) {
        this.note.className = 'cd-note err';
        this.note.innerHTML = `${ICON.warn}<span>This browser refused to save it (storage is full or blocked). Nothing was changed.</span>`;
        return;
      }
      if (this.mode === 'create') WH.store.draft.clear();
      const mode = this.mode;
      this.close();
      this.home.saved(rec, mode);
    }
  }

  WH.CreateDialog = CreateDialog;
})(window);
