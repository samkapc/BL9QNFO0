/*
 * store.js — instances the viewer creates are kept in this browser (localStorage), so they
 * survive reloads and restarts of this browser but are not shared with other browsers. Each
 * record holds the generator settings of one instance (see WH.gridSpec in world.js); the layout
 * itself is rebuilt from them on load. The create form's unsaved draft is kept alongside.
 */
(function (root) {
  'use strict';
  const WH = (root.WH = root.WH || {});

  const KEY = 'edgefleet.instances.v1';
  const DRAFT_KEY = 'edgefleet.createDraft.v1';

  // Probe once: storage can be missing (headless), blocked (privacy settings) or full.
  let ls = null;
  try {
    ls = root.localStorage;
    ls.setItem('edgefleet.probe', '1');
    ls.removeItem('edgefleet.probe');
  } catch (e) {
    ls = null;
  }
  // Headless tools hand their instance specs in directly.
  let memory = Array.isArray(root.WH_SPECS) ? root.WH_SPECS.slice() : [];
  let memDraft = null;

  function readAll() {
    if (!ls) return memory.slice();
    try {
      const data = JSON.parse(ls.getItem(KEY) || 'null');
      return data && Array.isArray(data.items) ? data.items.filter((s) => s && typeof s.id === 'string') : [];
    } catch (e) {
      return [];
    }
  }
  function writeAll(items) {
    if (!ls) { memory = items.slice(); return true; }
    try {
      ls.setItem(KEY, JSON.stringify({ v: 1, items }));
      return true;
    } catch (e) {
      return false;   // quota exceeded or storage revoked
    }
  }

  const listeners = new Set();
  if (ls && root.addEventListener) {
    // Another tab of this browser created, changed or deleted an instance
    root.addEventListener('storage', (ev) => {
      if (ev.key === KEY || ev.key === null) listeners.forEach((fn) => fn());
    });
  }

  WH.store = {
    /** False when this browser blocks storage: instances then last only until the page reloads. */
    persistent: !!ls,
    list() { return readAll().sort((a, b) => a.n - b.n); },
    get(id) { return readAll().find((s) => s.id === id) || null; },
    /** Insert or replace by id. Returns false if the browser refused to store it. */
    put(spec) {
      const items = readAll();
      const i = items.findIndex((s) => s.id === spec.id);
      if (i >= 0) items[i] = spec; else items.push(spec);
      return writeAll(items);
    },
    remove(id) {
      const items = readAll();
      const i = items.findIndex((s) => s.id === id);
      if (i < 0) return null;
      const [gone] = items.splice(i, 1);
      return writeAll(items) ? gone : null;
    },
    newId() { return 'i' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0'); },
    onChange(fn) { listeners.add(fn); },
    draft: {
      get() {
        if (!ls) return memDraft;
        try { return JSON.parse(ls.getItem(DRAFT_KEY) || 'null'); } catch (e) { return null; }
      },
      set(d) {
        if (!ls) { memDraft = d; return; }
        try { ls.setItem(DRAFT_KEY, JSON.stringify(d)); } catch (e) { /* a lost draft is not worth an error */ }
      },
      clear() {
        memDraft = null;
        if (ls) { try { ls.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ } }
      },
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
