/*
 * Bundles the twin into one self-contained HTML file (styles and scripts inlined).
 *   node tools/build-single.js                 → dist/edgefleet-twin.html
 *   node tools/build-single.js --fragment out  → page body only (for hosts that add their own <head>)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('index.html');
const css = read('styles.css');
const scripts = ['js/world.js', 'js/sim.js', 'js/render.js', 'js/ui.js', 'js/home.js', 'js/main.js'].map(read);

const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
const fonts = html.match(/<link\s+rel="stylesheet"\s+href="https:\/\/fonts[^>]+>/)[0];
const app = html.slice(html.indexOf('<!--APP-START-->') + 16, html.indexOf('<!--APP-END-->')).trim();
const inlineJs = scripts.map((s) => '<script>\n' + s.replace(/<\/script/gi, '<\\/script') + '\n</script>').join('\n');

const fragIdx = process.argv.indexOf('--fragment');
if (fragIdx > -1) {
  const out = process.argv[fragIdx + 1];
  const body = [title, fonts, '<style>\n' + css + '\n</style>', app, inlineJs].join('\n');
  fs.writeFileSync(out, body);
  console.log('fragment →', out, (body.length / 1024).toFixed(0) + ' KB');
} else {
  // Function replacers: the inlined code contains `$` sequences that string replacers would expand.
  const doc = html
    .replace(/<link\s+rel="stylesheet"\s+href="styles\.css">/, () => '<style>\n' + css + '\n</style>')
    .replace(/(<script src="js\/[^"]+"><\/script>\s*)+/, () => inlineJs + '\n');
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const out = path.join(root, 'dist', 'edgefleet-twin.html');
  fs.writeFileSync(out, doc);
  console.log('single file →', out, (doc.length / 1024).toFixed(0) + ' KB');
}
