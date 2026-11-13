// Every file the page or manifest refers to must exist and be published by tools/build-site.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

function publishedTopLevel() {
  const m = /app_files=\(([^)]*)\)/.exec(read('tools/build-site.sh'));
  assert.ok(m, 'app_files list found in build-site.sh');
  return m[1].trim().split(/\s+/);
}

function localRefs() {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)].map((m) => m[1]).filter((u) => !/^[a-z]+:/i.test(u));
  const manifest = JSON.parse(read('manifest.webmanifest'));
  return [...new Set([...refs, ...manifest.icons.map((i) => i.src)])];
}

test('every file referenced by index.html and the manifest exists', () => {
  for (const ref of localRefs()) assert.ok(existsSync(new URL(ref, root)), `missing: ${ref}`);
});

test('every referenced file is published to GitHub Pages', () => {
  const published = publishedTopLevel();
  for (const ref of localRefs()) {
    const top = ref.split('/')[0];
    assert.ok(published.includes(top), `${ref} is not in build-site.sh app_files (${published.join(' ')})`);
  }
});

test('icons are the sizes the manifest and page claim', () => {
  const size = (p) => {
    const b = readFileSync(new URL(p, root));
    assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${p} is a PNG`);
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  };
  assert.deepEqual(size('icons/apple-touch-icon.png'), [180, 180]);
  assert.deepEqual(size('icons/favicon-32.png'), [32, 32]);
  for (const i of JSON.parse(read('manifest.webmanifest')).icons) {
    if (i.type !== 'image/png') continue;
    const [w, h] = i.sizes.split('x').map(Number);
    assert.deepEqual(size(i.src), [w, h], i.src);
  }
});
