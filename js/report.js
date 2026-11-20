// Shareable health report. Pure: takes the data and returns structured
// sections plus three renderings built from them (HTML page, plain text, PDF),
// so every format says exactly the same thing.

import { describeDtc, dtcSystem } from './obd/dtc.js';
import { readinessSummary } from './diagnostics.js';
import { readinessTip } from './obd/readiness-guide.js';
import { makePdf } from './pdf.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = (t) => new Date(t).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

const READY_TEXT = { ready: 'All self-checks complete', almost: 'One self-check not complete', 'not-ready': 'Several self-checks not complete', unknown: 'Not reported' };
const LEVEL = { good: 'Good', ok: 'OK', low: 'Low', weak: 'Attention', unknown: '—' };
const cap = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;

function fmt(n) {
  return typeof n === 'number' ? (Number.isInteger(n) ? String(n) : n.toFixed(2)) : String(n);
}

/**
 * data: { appName, version, generatedAt, vehicle: { name, registration, vin, make, region, modelYear, protocol, fuelType, simulated },
 *   ecus: [{ id, calIds, cvns }], diag, dtcTable, ecuLabel(id), selfTests, battery, maintenance: { due, entries }, values, otherModules }
 * Returns { title, sections, html, text, pdf() }.
 */
export function buildReport(data) {
  const v = data.vehicle ?? {};
  const label = data.ecuLabel ?? ((id) => id);
  const title = `${data.appName ?? 'KapOBD'} health report: ${v.name ?? v.registration ?? v.vin ?? 'vehicle'}`;
  const d = data.diag;
  const ready = d ? readinessSummary(d.monitor) : null;
  const sections = []; // { heading, rows?, items?, note? }

  sections.push({
    heading: 'Vehicle',
    rows: [
      ['Vehicle', v.name],
      ['Registration', v.registration],
      ['VIN', v.vin ?? 'Not reported'],
      ['Make', v.simulated ? 'Simulated car (demo)' : v.make],
      ['Built in', v.simulated ? null : v.region],
      ['Model year', v.modelYear],
      ['Fuel', v.fuelType],
      ['Protocol', v.protocol],
    ].filter(([, x]) => x != null && x !== ''),
  });

  if (d) {
    const rows = [
      ['Engine warning light', ready.mil ? 'ON' : 'Off'],
      ...['stored', 'pending', 'permanent'].map((k) => [`${cap(k)} codes`, d[k]?.answered ? String(d[k].codes.length) : 'Not reported']),
      ['Readiness', READY_TEXT[ready.state]],
    ];
    if (data.selfTests?.supported) rows.push(['Self-test results', data.selfTests.failed.length ? `${data.selfTests.failed.length} outside limits` : 'All within limits']);
    if (data.battery) rows.push(['12 V battery', LEVEL[data.battery.overall] ?? '—']);
    const others = (data.otherModules ?? []).filter((m) => m.codes?.length);
    if (data.otherModules) rows.push(['Other warning lights', others.length ? `${others.reduce((n, m) => n + m.codes.length, 0)} code(s) found` : 'No codes found (experimental check)']);
    sections.push({ heading: 'Summary', rows, note: 'The engine warning light and codes above cover engine and emissions systems only. Tyre pressure, ABS, airbag and other dashboard warnings are kept by other computers.' });

    for (const kind of ['stored', 'pending', 'permanent']) {
      const s = d[kind];
      if (!s?.answered || !s.codes.length) continue;
      sections.push({
        heading: `${cap(kind)} codes`,
        items: s.ecus.flatMap((e) => e.codes.map((code) => `${code}: ${describeDtc(code, data.dtcTable)} (${dtcSystem(code)}, ${label(e.ecu)})`)),
      });
    }
    if (d.freeze?.values?.length) {
      sections.push({ heading: `Freeze frame for ${d.freeze.code}`, rows: d.freeze.values.map((x) => [x.name, x.display ?? `${x.value}${x.unit ? ' ' + x.unit : ''}`]) });
    }
    if (ready.monitors.length) {
      const tips = [...new Set(ready.notReady.map((m) => readinessTip(m.name)).filter(Boolean))];
      sections.push({
        heading: 'Readiness monitors',
        rows: ready.monitors.map((m) => [m.name, m.status === 'ready' ? 'Complete' : 'Not complete']),
        note: tips.length ? `To complete the remaining checks: ${tips.join(' ')}` : null,
      });
    }
  }

  if (data.selfTests?.supported && data.selfTests.failed.length) {
    sections.push({
      heading: 'Self-test results outside limits',
      rows: data.selfTests.failed.map((t) => [`${t.monitor}: ${t.name}`, `${fmt(t.value)}${t.unit ? ' ' + t.unit : ''} (limits ${fmt(t.min)} to ${fmt(t.max)})`]),
    });
  }

  const others = (data.otherModules ?? []).filter((m) => m.codes?.length);
  if (others.length) {
    sections.push({
      heading: 'Other warning lights (experimental)',
      items: others.flatMap((m) => m.codes.map((c) => `${c.code} (${c.flagsText}) from ${m.label}`)),
      note: 'Manufacturer-specific codes read directly from other computers. KapOBD has no descriptions for them; a dealer or manufacturer-specific tool can explain them.',
    });
  }

  if (data.battery) {
    const b = data.battery;
    sections.push({
      heading: '12 V battery and charging',
      rows: [
        ['Resting', b.resting == null ? '—' : `${b.resting.toFixed(2)} V · ${b.restingRating.text}`],
        ['While starting', b.skippedCrank ? 'Not tested (car doesn’t crank with the 12 V battery)' : b.crankMin == null ? '—' : `${b.crankMin.toFixed(2)} V lowest · ${b.crankRating.text}`],
        ['Charging', b.charging == null ? '—' : `${b.charging.toFixed(2)} V · ${b.chargingRating.text}`],
        ['Tested', date(b.at)],
      ],
      note: b.calibrationNote ?? null,
    });
  }

  if (data.values?.length) sections.push({ heading: 'Current values', rows: data.values.map((x) => [x.name, x.text]) });

  if (data.maintenance && (data.maintenance.due?.length || data.maintenance.entries?.length)) {
    sections.push({
      heading: 'Maintenance',
      rows: [
        ...(data.maintenance.due ?? []).map((x) => [`${x.label} due`, `${x.date} (${x.text})`]),
        ...(data.maintenance.entries ?? []).slice(0, 8).map((e) => [`${e.date} · ${e.type}`, [e.mileage != null ? `${e.mileage.toLocaleString('en-GB')} miles` : null, e.note].filter(Boolean).join(' · ') || '—']),
      ],
    });
  }

  if (data.ecus?.length) {
    sections.push({
      heading: 'Computers',
      rows: data.ecus.map((e) => [label(e.id), [e.calIds?.length ? `Calibration ${e.calIds.join(', ')}` : null, e.cvns?.length ? `CVN ${e.cvns.join(', ')}` : null].filter(Boolean).join(' · ') || '—']),
    });
  }

  const created = `Created ${date(data.generatedAt ?? Date.now())} by ${data.appName ?? 'KapOBD'} v${data.version ?? ''}`;
  const footer = `${created}. Standard OBD-II data only; not a substitute for professional diagnosis. Clearing codes does not repair faults.`;

  const htmlSection = (s) =>
    `<h2>${esc(s.heading)}</h2>\n` +
    (s.rows?.length ? `<table>${s.rows.map(([k, val]) => `<tr><td>${esc(k)}</td><td>${esc(val)}</td></tr>`).join('')}</table>` : '') +
    (s.items?.length ? `<ul class="codes">${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '') +
    (s.note ? `<p class="note">${esc(s.note)}</p>` : '');

  const html = `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111; background: #fff; margin: 0 auto; max-width: 760px; padding: 20px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 22px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  table { border-collapse: collapse; width: 100%; } td { padding: 5px 8px 5px 0; vertical-align: top; border-bottom: 1px solid #eee; }
  td:first-child { color: #555; width: 42%; } .codes { padding-left: 18px; } .codes li { margin: 6px 0; } .note, footer { color: #555; }
  footer { margin-top: 28px; font-size: 12px; border-top: 1px solid #ddd; padding-top: 8px; }
  @media print { body { padding: 0; } h2 { break-after: avoid; } }
</style></head><body>
<h1>${esc(title)}</h1>
${sections.map(htmlSection).join('\n')}
<footer>${esc(footer)}</footer>
</body></html>`;

  const textSection = (s) =>
    [s.heading.toUpperCase(), ...(s.rows ?? []).map(([k, val]) => `${k}: ${val}`), ...(s.items ?? []).map((i) => `- ${i}`), s.note ? `(${s.note})` : null, ''].filter((x) => x != null).join('\n');
  const text = [title, '='.repeat(Math.min(60, title.length)), '', ...sections.map(textSection), footer].join('\n');

  return { title, sections, html, text, pdf: () => makePdf({ title, subtitle: created, sections, footer }) };
}
