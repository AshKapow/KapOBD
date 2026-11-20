// Debug console: every command and raw response, plus a manual command box,
// sharing tools (log, diagnostics bundle, sharing test).
import { h, replace, copyText, confirmButton } from './dom.js';
import { Logger } from '../logger.js';
import { deliveryButtons } from './sharebar.js';
import { capabilities, fileName, makeFile, shareText, shareFiles, downloadBlob, downloadDataUrl, openEmail, describeResult } from '../share.js';

const MAX_ROWS = 1500;
const QUICK = ['ATI', 'ATRV', 'ATDPN', 'ATDP', '0100', '0101', '0902', '03'];

export function mountConsole(el, app) {
  const list = h('div', { class: 'log', role: 'log', 'aria-live': 'off' });
  const status = h('span', { class: 'hint' });
  const input = h('input', { type: 'text', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', placeholder: 'e.g. ATI or 010C', enterkeyhint: 'send' });
  const diagBox = h('div');

  const flash = (text) => {
    status.textContent = text;
    setTimeout(() => (status.textContent = ''), 4000);
  };

  const send = async (cmd) => {
    if (!cmd.trim()) return;
    input.value = '';
    const r = await app.sendManual(cmd);
    if (r) flash(r.ok ? `${r.cmd}: ok (${r.ms}ms)` : `${r.cmd}: ${r.error}`);
  };

  const fragsBox = h('input', { type: 'checkbox', checked: app.settings.includeFrags, onchange: (e) => { app.updateSettings({ includeFrags: e.target.checked }); rebuild(); } });

  const logFile = () => makeFile(fileName('log', app.profile, 'txt', { withTime: true }), app.logText());
  const logShare = deliveryButtons(app, {
    what: 'the log',
    title: `${app.name} log`,
    files: () => [logFile()],
    text: () => app.logText(),
    emailTo: () => app.settings.diagnosticsEmail,
  });

  const emailInput = h('input', {
    type: 'email',
    inputmode: 'email',
    autocomplete: 'email',
    placeholder: 'you@example.com',
    value: app.settings.diagnosticsEmail ?? '',
    onchange: (e) => app.updateSettings({ diagnosticsEmail: e.target.value.trim() }),
  });

  const prev = app.previousLog?.entries?.length
    ? h(
        'details',
        { class: 'card' },
        h('summary', {}, `Previous session log (${new Date(app.previousLog.savedAt).toLocaleString('en-GB')}, v${app.previousLog.version})`),
        h('div', { class: 'actions' }, h('button', { class: 'btn small', onclick: async () => flash((await copyText(prevText(app.previousLog))) ? 'Previous log copied.' : 'Copy failed.') }, 'Copy previous log')),
      )
    : null;

  const form = h('form', { class: 'cmd', onsubmit: (e) => { e.preventDefault(); send(input.value); } }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Send'));

  replace(
    el,
    h('h2', {}, 'Console'),
    h('section', { class: 'card' }, h('h3', {}, 'Send diagnostics'), h('p', { class: 'hint' }, 'Gathers everything in one go: a PDF health report, the full log, the car’s details, current values and self-test results, ready to share or email.'), h('label', { class: 'row' }, 'Send to ', emailInput), diagBox),
    h('section', { class: 'card' }, h('h3', {}, 'This log'), logShare, h('div', { class: 'actions' }, confirmButton('Clear log', () => (app.logger.clear(), rebuild()), { class: 'btn small secondary' }))),
    sharingTest(app),
    h('label', { class: 'check' }, fragsBox, 'Include raw BLE fragments'),
    status,
    prev,
    form,
    h('div', { class: 'actions wrap quick' }, QUICK.map((c) => h('button', { class: 'btn small', type: 'button', onclick: () => send(c) }, c))),
    h('p', { class: 'hint' }, 'Only AT commands and read-only OBD requests can be sent here. Clearing codes is not available from the console.'),
    list,
  );

  // The diagnostics part changes with app state; the rest of the console doesn't.
  const renderDiag = () => replace(diagBox, diagnosticsPanel(app));
  app.on(renderDiag);
  renderDiag();

  function row(e) {
    return h('div', { class: `entry ${e.kind}` }, Logger.formatEntry(e));
  }
  function rebuild() {
    const show = app.settings.includeFrags ? app.logger.entries : app.logger.entries.filter((e) => e.kind !== 'frag');
    replace(list, show.slice(-MAX_ROWS).map(row));
    list.scrollTop = list.scrollHeight;
  }
  rebuild();

  app.logger.subscribe((e) => {
    if (e.kind === 'frag' && !app.settings.includeFrags) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    list.append(row(e));
    while (list.childElementCount > MAX_ROWS) list.firstElementChild.remove();
    if (nearBottom) list.scrollTop = list.scrollHeight;
  });
}

// The bundle panel is cached so its buttons (and their status line) survive app re-renders.
let lastBundle = null;
let lastPanel = null;

function diagnosticsPanel(app) {
  const b = app.diagBundle;
  if (!b) {
    lastBundle = null;
    return h('button', { class: 'btn primary', disabled: !!app.busy || !app.connected || !app.profile, onclick: () => app.runDiagnostics() }, app.connected ? 'Gather diagnostics' : 'Connect first to gather diagnostics');
  }
  if (b === lastBundle && lastPanel) return lastPanel;
  lastBundle = b;
  lastPanel = h(
    'div',
    {},
    h('p', {}, `Ready: ${b.files.map((f) => f.name).join(', ')}`),
    deliveryButtons(app, { what: 'diagnostics', title: b.title, subject: b.title, files: () => b.files, text: () => b.text, emailTo: () => app.settings.diagnosticsEmail }),
    h('p', { class: 'hint' }, '“Share” sends the files as attachments where the browser allows it (choose Mail). “Email” works everywhere but can only include the text, and a long log may be shortened. The files include the car’s VIN.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn small', disabled: !!app.busy, onclick: () => app.runDiagnostics() }, 'Gather again'), h('button', { class: 'btn small secondary', onclick: () => app.set({ diagBundle: null }) }, 'Close')),
  );
  return lastPanel;
}

/** One button per way of getting a file off the device, each logging its result. */
function sharingTest(app) {
  const out = h('p', { class: 'hint share-status' });
  const sample = () => makeFile(fileName('sharing-test', null, 'txt', { withTime: true }), `KapOBD sharing test, ${new Date().toString()}\n`);
  const log = (r) => {
    const msg = describeResult(r);
    out.textContent = msg;
    app.logger[r.ok || r.cancelled ? 'info' : 'warn'](`Sharing test: ${msg}`);
  };
  const tests = [
    ['Share text', async () => log(await shareText({ title: 'KapOBD sharing test', text: 'KapOBD sharing test' }))],
    ['Share a file', async () => log(await shareFiles([sample()], { title: 'KapOBD sharing test' }))],
    ['Download', () => log(downloadBlob(sample()))],
    ['Download (other way)', async () => log(await downloadDataUrl(sample()))],
    ['Copy', async () => log({ method: 'copy', ok: await copyText('KapOBD sharing test'), error: 'the browser blocked copying.' })],
    ['Email', () => log(openEmail({ to: app.settings.diagnosticsEmail ?? '', subject: 'KapOBD sharing test', body: 'If this arrives, email links work.' }))],
  ];
  return h(
    'details',
    { class: 'card' },
    h('summary', {}, 'Sharing test'),
    h('p', { class: 'hint' }, 'Tap each button once, note whether it worked, then copy the log. Each result is written to the log so we can see what this browser supports.'),
    h('div', { class: 'actions wrap' }, tests.map(([label, fn]) => h('button', { class: 'btn small', type: 'button', onclick: fn }, label))),
    out,
    h(
      'button',
      {
        class: 'btn small secondary',
        type: 'button',
        onclick: () => {
          const c = capabilities();
          out.textContent = Object.entries(c).map(([k, v]) => `${k}: ${v}`).join(' · ');
          app.logger.info(`Sharing test: browser reports ${JSON.stringify(c)}`);
        },
      },
      'What this browser says it supports',
    ),
  );
}

function prevText(prev) {
  return [...(prev.header ?? []), '# (previous session, restored from storage)', ...prev.entries.map((e) => Logger.formatEntry(e))].join('\n');
}
