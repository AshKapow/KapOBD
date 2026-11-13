// Offline support: the service worker must save every app file, be
// published, and be registered per version so updates replace the old copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

function walk(dir) {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(root, rel)).isDirectory() ? walk(rel) : [rel];
  });
}

function swFiles() {
  const m = /const FILES = \[([\s\S]*?)\];/.exec(read('sw.js'));
  assert.ok(m, 'FILES list found in sw.js');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('the offline file list matches the app files exactly', () => {
  const appFiles = ['index.html', 'manifest.webmanifest', ...['css', 'data', 'icons', 'js'].flatMap(walk)].sort();
  const listed = swFiles().filter((f) => f !== './').sort();
  const missing = appFiles.filter((f) => !listed.includes(f));
  const extra = listed.filter((f) => !appFiles.includes(f));
  assert.deepEqual(missing, [], 'files the app uses but sw.js would not save offline');
  assert.deepEqual(extra, [], 'files sw.js lists that do not exist');
  assert.ok(swFiles().includes('./'), 'the start page itself is saved');
});

test('every listed file exists', () => {
  for (const f of swFiles()) if (f !== './') assert.ok(existsSync(join(root, f)), f);
});

test('the service worker is published and registered per version', () => {
  const m = /app_files=\(([^)]*)\)/.exec(read('tools/build-site.sh'));
  assert.ok(m[1].split(/\s+/).includes('sw.js'), 'build-site.sh publishes sw.js');
  assert.match(read('js/main.js'), /register\(`sw\.js\?v=\$\{app\.version\}`\)/, 'registered with the app version');
  assert.match(read('sw.js'), /searchParams\.get\('v'\)/, 'cache name follows the version');
});

test('branch previews are never answered from the main site’s copy', () => {
  const sw = read('sw.js');
  assert.match(sw, /rest\.startsWith\('preview\/'\)/);
  assert.match(sw, /request\.method !== 'GET'/, 'only GET requests are handled');
});
