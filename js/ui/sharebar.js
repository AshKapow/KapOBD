// One row of "get this off the phone" buttons, used for the log, the health
// report and the diagnostics bundle. Every attempt says what happened, on
// screen and in the log, because in-app iPhone browsers differ in what works.
import { h, copyText } from './dom.js';
import { shareFiles, shareText, downloadBlob, downloadDataUrl, openEmail, describeResult } from '../share.js';

/**
 * opts: { files: () => File[], text: () => string, title, subject, emailTo: () => string, what }
 * `what` names the thing for messages, e.g. "the log".
 */
export function deliveryButtons(app, opts) {
  const status = h('p', { class: 'hint share-status', role: 'status' });
  const report = (r) => {
    const msg = describeResult(r);
    status.textContent = msg;
    app.logger[r.ok || r.cancelled ? 'info' : 'warn'](`Share ${opts.what}: ${msg}`);
  };
  const share = async () => {
    // Files first (attachments); if the browser can't, fall back to sharing the text.
    let r = await shareFiles(opts.files(), { title: opts.title });
    if (!r.ok && !r.cancelled) {
      report(r);
      r = await shareText({ title: opts.title, text: opts.text() });
    }
    report(r);
  };
  const download = () => {
    for (const f of opts.files()) report({ ...downloadBlob(f), method: 'download-blob' });
  };
  const downloadAlt = async () => {
    for (const f of opts.files()) report(await downloadDataUrl(f));
  };
  const copy = async () => report({ method: 'copy', ok: await copyText(opts.text()), error: 'the browser blocked copying.' });
  const email = () => report(openEmail({ to: opts.emailTo?.() ?? '', subject: opts.subject ?? opts.title, body: opts.text() }));

  return h(
    'div',
    { class: 'delivery' },
    h(
      'div',
      { class: 'actions wrap' },
      h('button', { class: 'btn primary', type: 'button', onclick: share }, 'Share'),
      h('button', { class: 'btn', type: 'button', onclick: download }, 'Download'),
      h('button', { class: 'btn', type: 'button', onclick: copy }, 'Copy as text'),
      h('button', { class: 'btn', type: 'button', onclick: email }, 'Email'),
      h('button', { class: 'btn small secondary', type: 'button', onclick: downloadAlt, title: 'For browsers where the normal download saves the wrong file' }, 'Download (other way)'),
    ),
    status,
  );
}
