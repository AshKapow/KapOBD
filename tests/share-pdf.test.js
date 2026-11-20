// File names for shared files, and the PDF writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slug, vehicleSlug, fileName } from '../js/share.js';
import { makePdf, winAnsi, wrap } from '../js/pdf.js';

const text = (bytes) => String.fromCharCode(...bytes);

test('file names: registration, then nickname, then VIN; date and time', () => {
  const d = new Date(2026, 10, 20, 13, 43);
  assert.equal(slug("Dave's Golf (2019)"), 'dave-s-golf-2019');
  assert.equal(vehicleSlug({ registration: 'AB12 CDE', nickname: 'Dave’s Golf', vin: 'X' }), 'ab12-cde');
  assert.equal(vehicleSlug({ nickname: 'Work van', vin: 'VF1AAA00000000001' }), 'work-van');
  assert.equal(vehicleSlug({ vin: 'VF1AAA00000000001' }), 'vf1aaa00000000001');
  assert.equal(vehicleSlug(null), 'vehicle');
  assert.equal(fileName('report', { nickname: 'Test car 3' }, 'pdf', { date: d }), 'kapobd-report-test-car-3-2026-11-20.pdf');
  assert.equal(fileName('log', { nickname: 'Test car 3' }, 'txt', { date: d, withTime: true }), 'kapobd-log-test-car-3-2026-11-20-1343.txt');
  assert.equal(fileName('log', null, 'txt', { date: d }), 'kapobd-log-2026-11-20.txt');
});

test('WinAnsi text: typographic characters kept, others substituted', () => {
  assert.equal(winAnsi('Coolant 90°C'), 'Coolant 90\xb0C');
  assert.equal(winAnsi('Dave’s'), 'Dave\x92s');
  assert.equal(winAnsi('✓ pass · 14 Ω'), 'OK pass \xb7 14 ohm');
  assert.equal(winAnsi('车'), '?');
});

test('wrapping keeps lines inside the width and breaks long words', () => {
  const lines = wrap('a '.repeat(200).trim(), 10, 100);
  assert.ok(lines.length > 5);
  const long = wrap('X'.repeat(200), 10, 100);
  assert.ok(long.length > 1, 'a single long word is broken across lines');
});

test('PDF structure: header, objects at their xref offsets, pages, EOF', () => {
  const sections = Array.from({ length: 12 }, (_, i) => ({
    heading: `Section ${i + 1}`,
    rows: Array.from({ length: 8 }, (_, j) => [`Key ${j}`, `Value ${j} with (brackets) and a backslash \\ and 90°C`]),
    items: [`Item for section ${i + 1}`],
    note: 'A note.',
  }));
  const bytes = makePdf({ title: 'KapOBD health report: Dave’s Golf', subtitle: 'Created today', sections, footer: 'Footer text.' });
  const s = text(bytes);
  assert.ok(s.startsWith('%PDF-1.4\n'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  const xrefAt = Number(/startxref\n(\d+)\n%%EOF/.exec(s)[1]);
  assert.equal(s.slice(xrefAt, xrefAt + 4), 'xref');
  const entries = [...s.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  entries.forEach((off, i) => assert.equal(s.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `object ${i + 1} offset`));
  const count = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(s)[1]);
  assert.ok(count >= 2, `long report flows onto ${count} pages`);
  assert.equal((s.match(/\/Type \/Page /g) ?? []).length, count);
  assert.match(s, /Page 1 of \d+/);
  assert.match(s, /\\\(brackets\\\)/, 'brackets escaped in PDF strings');
  for (const m of s.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
    const start = m.index + m[0].length;
    assert.equal(s.slice(start + Number(m[1]), start + Number(m[1]) + 10), '\nendstream', 'stream length is exact');
  }
});
