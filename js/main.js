/*
 * main.js — routes between the instances overview and an instance console (#instance-1,
 * #instance-2, and #instance-N for instances created in this browser), and boots the console:
 * simulation, renderer, UI and the fixed-step loop.
 */
(function (root) {
  'use strict';
  const WH = root.WH;
  // Each instance runs its own layout and fleet, so moving between views reloads the page.
  root.addEventListener('hashchange', () => root.location.reload());

  // The floor plan style is light unless the viewer picked dark (remembered per viewer); the
  // console itself is always dark.
  WH.MAP_THEME_KEY = 'edgefleet.floorStyle';
  WH.savedMapTheme = () => {
    try { return root.localStorage.getItem(WH.MAP_THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; }
  };

  const home = document.getElementById('home');
  const appEl = document.getElementById('app');
  if (WH.route.view === 'home') {
    document.body.classList.add('is-home');
    home.hidden = false;
    appEl.hidden = true;
    new WH.Home(home);
    return;
  }
  home.hidden = true;
  appEl.hidden = false;
  const L = WH.world;
  document.title = `${L.name} · EdgeFleet`;
  document.getElementById('crumbName').textContent = L.name;
  document.getElementById('crumbInst').textContent = 'Instance ' + L.instance;
  document.getElementById('mapRev').textContent = 'rev ' + L.rev;
  document.getElementById('robotCount').textContent = `${L.robots.length}/${L.robots.length}`;
  document.getElementById('canvasWrap').style.setProperty('--map-ar', `${L.bounds.x1 - L.bounds.x0} / ${L.bounds.y1 - L.bounds.y0}`);
  document.getElementById('map').setAttribute('aria-label',
    `Floor map of ${L.name} (${L.kind.toLowerCase()}): ${L.robots.length} robots move payloads between ${L.stations.length} stations, reserving path segments and negotiating right of way`);

  const sim = new WH.Sim({});
  const canvas = document.getElementById('map');
  const renderer = new WH.Renderer(canvas, sim, { theme: WH.savedMapTheme() });
  const ui = new WH.UI(sim, renderer);
  WH.app = { sim, renderer, ui };

  // Re-render the cached floor plan once the label fonts are available.
  if (document.fonts && document.fonts.load) {
    Promise.all([
      document.fonts.load('500 10px "IBM Plex Sans"'),
      document.fonts.load('600 11px "IBM Plex Sans"'),
      document.fonts.load('500 10px "IBM Plex Mono"'),
      document.fonts.load('600 11px "IBM Plex Mono"'),
    ]).catch(() => {}).then(() => renderer.drawStatic());
  }

  let pending = false;
  const onResize = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; renderer.resize(); ui.updateViewInfo(); });
  };
  if (root.ResizeObserver) new ResizeObserver(onResize).observe(document.getElementById('canvasWrap'));
  else root.addEventListener('resize', onResize);

  const STEP = 1 / 120;
  // Warm up a few seconds so the first frame already shows tasks assigned and robots moving,
  // and paint it immediately (the page must look complete even before animation frames run).
  for (let i = 0; i < 5.5 / STEP; i++) sim.step(STEP);
  renderer.draw();
  ui.frame(performance.now());
  WH.app.advance = (seconds) => {
    for (let i = 0; i < seconds / STEP; i++) sim.step(STEP);
    renderer.draw();
    ui.frame(performance.now() + 1e6);
  };

  let last = performance.now(), acc = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!ui.paused) {
      acc += dt * ui.speed;
      let n = 0;
      while (acc >= STEP && n < 600) { sim.step(STEP); acc -= STEP; n++; }
      if (n >= 600) acc = 0;
    }
    renderer.draw();
    ui.frame(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame((t) => { last = t; frame(t); });
})(window);
