// Shareable health report: one self-contained HTML page plus a plain-text
// version. Pure: takes the data, returns { title, text, html }.

import { describeDtc, dtcSystem } from './obd/dtc.js';
import { readinessSummary } from './diagnostics.js';
import { readinessTip } from './obd/readiness-guide.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = (t) => new Date(t).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

const READY_TEXT = { ready: 'All self-checks complete', almost: 'One self-check not complete', 'not-ready': 'Several self-checks not complete', unknown: 'Not reported' };
const LEVEL = { good: 'Good', ok: 'OK', low: 'Low', weak: 'Attention', unknown: '—' };

/**
 * data: { appName, version, generatedAt, vehicle: { name, vin, make, region, modelYear, protocol, fuelType, simulated },
 *   ecus: [{ id, label, calIds, cvns }], diag, dtcTable, ecuLabel(id), selfTests, battery, maintenance: { due, entries }, values }
 */
export function buildReport(data) {
  const v = data.vehicle ?? {};
  const label = data.ecuLabel ?? ((id) => id);
  const title = `${data.appName ?? 'KapOBD'} health report: ${v.name ?? v.vin ?? 'vehicle'}`;
  const d = data.diag;
  const ready = d ? readinessSummary(d.monitor) : null;
  const sections = []; // [heading, htmlBody, textBody]

  // Vehicle
  const vehicleRows = [
    ['Vehicle', v.name],
    ['VIN', v.vin ?? 'Not reported'],
    ['Make', v.simulated ? 'Simulated car (demo)' : v.make],
    ['Built in', v.simulated ? null : v.region],
    ['Model year', v.modelYear],
    ['Fuel', v.fuelType],
    ['Protocol', v.protocol],
  ].filter(([, x]) => x != null && x !== '');
  sections.push(['Vehicle', table(vehicleRows), rowsText(vehicleRows)]);

  // Summary
  if (d) {
    const counts = ['stored', 'pending', 'permanent'].map((k) => [k, d[k]?.answered ? d[k].codes.length : null]);
    const rows = [
      ['Engine warning light', ready.mil ? 'ON' : 'Off'],
      ...counts.map(([k, n]) => [`${k[0].toUpperCase()}${k.slice(1)} codes`, n == null ? 'Not reported' : String(n)]),
      ['Readiness', READY_TEXT[ready.state]],
    ];
    if (data.selfTests?.supported) rows.push(['Self-test results', data.selfTests.failed.length ? `${data.selfTests.failed.length} outside limits` : 'All within limits']);
    if (data.battery) rows.push(['12 V battery', LEVEL[data.battery.overall] ?? '—']);
    sections.push(['Summary', table(rows), rowsText(rows)]);

    // Codes
    for (const kind of ['stored', 'pending', 'permanent']) {
      const s = d[kind];
      if (!s?.answered || !s.codes.length) continue;
      const items = s.ecus.flatMap((e) => e.codes.map((code) => ({ code, desc: describeDtc(code, data.dtcTable), sys: dtcSystem(code), ecu: label(e.ecu) })));
      sections.push([
        `${kind[0].toUpperCase()}${kind.slice(1)} codes`,
        `<ul class="codes">${items.map((i) => `<li><b>${esc(i.code)}</b> ${esc(i.desc)}<br><small>${esc(i.sys)} · ${esc(i.ecu)}</small></li>`).join('')}</ul>`,
        items.map((i) => `${i.code}  ${i.desc} (${i.ecu})`).join('\n'),
      ]);
    }
    if (d.freeze?.values?.length) {
      const rows = d.freeze.values.map((x) => [x.name, x.display ?? `${x.value}${x.unit ? ' ' + x.unit : ''}`]);
      sections.push([`Freeze frame for ${d.freeze.code}`, table(rows), rowsText(rows)]);
    }
    if (ready.monitors.length) {
      const rows = ready.monitors.map((m) => [m.name, m.status === 'ready' ? 'Complete' : 'Not complete']);
      const tips = ready.notReady.map((m) => readinessTip(m.name)).filter(Boolean);
      sections.push([
        'Readiness monitors',
        table(rows) + (tips.length ? `<p class="note">To complete the remaining checks: ${esc([...new Set(tips)].join(' '))}</p>` : ''),
        rowsText(rows),
      ]);
    }
  }

  // Self-tests (mode 06)
  if (data.selfTests?.supported && data.selfTests.failed.length) {
    const rows = data.selfTests.failed.map((t) => [`${t.monitor}: ${t.name}`, `${fmt(t.value)}${t.unit ? ' ' + t.unit : ''} (limits ${fmt(t.min)} to ${fmt(t.max)})`]);
    sections.push(['Self-test results outside limits', table(rows), rowsText(rows)]);
  }

  // Battery
  if (data.battery) {
    const b = data.battery;
    const rows = [
      ['Resting', b.resting == null ? '—' : `${b.resting.toFixed(2)} V · ${b.restingRating.text}`],
      ['While starting', b.skippedCrank ? 'Not tested (car doesn’t crank with the 12 V battery)' : b.crankMin == null ? '—' : `${b.crankMin.toFixed(2)} V lowest · ${b.crankRating.text}`],
      ['Charging', b.charging == null ? '—' : `${b.charging.toFixed(2)} V · ${b.chargingRating.text}`],
      ['Tested', date(b.at)],
    ];
    sections.push(['12 V battery and charging', table(rows), rowsText(rows)]);
  }

  // Current values
  if (data.values?.length) {
    const rows = data.values.map((x) => [x.name, x.text]);
    sections.push(['Current values', table(rows), rowsText(rows)]);
  }

  // Maintenance
  if (data.maintenance && (data.maintenance.due?.length || data.maintenance.entries?.length)) {
    const rows = [
      ...(data.maintenance.due ?? []).map((x) => [`${x.label} due`, `${x.date} (${x.text})`]),
      ...(data.maintenance.entries ?? []).slice(0, 8).map((e) => [`${e.date} · ${e.type}`, [e.mileage != null ? `${e.mileage.toLocaleString('en-GB')} miles` : null, e.note].filter(Boolean).join(' · ') || '—']),
    ];
    sections.push(['Maintenance', table(rows), rowsText(rows)]);
  }

  // Computers
  if (data.ecus?.length) {
    const rows = data.ecus.map((e) => [label(e.id), [e.calIds?.length ? `Calibration ${e.calIds.join(', ')}` : null, e.cvns?.length ? `CVN ${e.cvns.join(', ')}` : null].filter(Boolean).join(' · ') || '—']);
    sections.push(['Computers', table(rows), rowsText(rows)]);
  }

  const footer = `Created ${date(data.generatedAt ?? Date.now())} by ${data.appName ?? 'KapOBD'} v${data.version ?? ''}. Standard OBD-II data only; not a substitute for professional diagnosis. Clearing codes does not repair faults.`;

  const html = `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111; background: #fff; margin: 0 auto; max-width: 760px; padding: 20px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 22px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  table { border-collapse: collapse; width: 100%; } td { padding: 5px 8px 5px 0; vertical-align: top; border-bottom: 1px solid #eee; }
  td:first-child { color: #555; width: 42%; } .codes { padding-left: 18px; } .codes li { margin: 6px 0; } small, .note, footer { color: #555; }
  footer { margin-top: 28px; font-size: 12px; border-top: 1px solid #ddd; padding-top: 8px; }
  @media print { body { padding: 0; } h2 { break-after: avoid; } }
</style></head><body>
<h1>${esc(title)}</h1>
${sections.map(([h, body]) => `<h2>${esc(h)}</h2>\n${body}`).join('\n')}
<footer>${esc(footer)}</footer>
</body></html>`;

  const text = [title, '='.repeat(Math.min(60, title.length)), '', ...sections.flatMap(([h, , t]) => [h.toUpperCase(), t, '']), footer].join('\n');
  return { title, html, text };

  function table(rows) {
    return `<table>${rows.map(([k, val]) => `<tr><td>${esc(k)}</td><td>${esc(val)}</td></tr>`).join('')}</table>`;
  }
}

function rowsText(rows) {
  return rows.map(([k, val]) => `${k}: ${val}`).join('\n');
}

function fmt(n) {
  return typeof n === 'number' ? (Number.isInteger(n) ? String(n) : n.toFixed(2)) : String(n);
}
