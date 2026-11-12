// Debug console: every command and raw response, plus a manual command box.
import { h, replace, copyText, confirmButton } from './dom.js';
import { Logger } from '../logger.js';

const MAX_ROWS = 1500;
const QUICK = ['ATI', 'ATRV', 'ATDPN', 'ATDP', '0100', '0101', '0902', '03'];

export function mountConsole(el, app) {
  const list = h('div', { class: 'log', role: 'log', 'aria-live': 'off' });
  const status = h('span', { class: 'hint' });
  const input = h('input', { type: 'text', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', placeholder: 'e.g. ATI or 010C', enterkeyhint: 'send' });

  const flash = (text) => {
    status.textContent = text;
    setTimeout(() => (status.textContent = ''), 4000);
  };
  const logText = () => app.logger.format({ includeFrags: app.settings.includeFrags, header: app.logHeader() });

  const send = async (cmd) => {
    if (!cmd.trim()) return;
    input.value = '';
    const r = await app.sendManual(cmd);
    if (r) flash(r.ok ? `${r.cmd}: ok (${r.ms}ms)` : `${r.cmd}: ${r.error}`);
  };

  const fragsBox = h('input', { type: 'checkbox', checked: app.settings.includeFrags, onchange: (e) => { app.updateSettings({ includeFrags: e.target.checked }); rebuild(); } });

  const toolbar = h(
    'div',
    { class: 'actions wrap' },
    h('button', { class: 'btn primary', onclick: async () => flash((await copyText(logText())) ? 'Log copied. Paste it wherever you are reporting the test.' : 'Copy failed: use Share or Download, or select the text below.') }, 'Copy log'),
    typeof navigator !== 'undefined' && navigator.share
      ? h('button', { class: 'btn', onclick: () => navigator.share({ title: `${app.name} log`, text: logText() }).catch(() => {}) }, 'Share')
      : null,
    h('button', { class: 'btn', onclick: () => download(`${app.name.toLowerCase()}-log-${stamp()}.txt`, logText()) }, 'Download'),
    confirmButton('Clear', () => (app.logger.clear(), rebuild()), { class: 'btn secondary' }),
  );

  const prev = app.previousLog?.entries?.length
    ? h(
        'details',
        { class: 'card' },
        h('summary', {}, `Previous session log (${new Date(app.previousLog.savedAt).toLocaleString()}, v${app.previousLog.version})`),
        h('div', { class: 'actions' }, h('button', { class: 'btn small', onclick: async () => flash((await copyText(prevText(app.previousLog))) ? 'Previous log copied.' : 'Copy failed.') }, 'Copy previous log')),
      )
    : null;

  const form = h(
    'form',
    { class: 'cmd', onsubmit: (e) => { e.preventDefault(); send(input.value); } },
    input,
    h('button', { class: 'btn primary', type: 'submit' }, 'Send'),
  );

  replace(
    el,
    h('h2', {}, 'Console'),
    toolbar,
    h('label', { class: 'check' }, fragsBox, 'Include raw BLE fragments'),
    status,
    prev,
    form,
    h('div', { class: 'actions wrap quick' }, QUICK.map((c) => h('button', { class: 'btn small', type: 'button', onclick: () => send(c) }, c))),
    h('p', { class: 'hint' }, 'Only AT commands and read-only OBD modes 01/02/03/07/09/0A can be sent here. Clearing codes is not available from the console.'),
    list,
  );

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

function prevText(prev) {
  return [...(prev.header ?? []), '# (previous session, restored from storage)', ...prev.entries.map((e) => Logger.formatEntry(e))].join('\n');
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}
