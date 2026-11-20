// Getting reports, logs and diagnostics off the device. Every method reports
// what happened (so a failure is visible in the app and the log), because
// in-app iPhone browsers differ in what they allow.

import { describeError } from './transport/ble.js';

/** "Dave's Golf (2019)" → "dave-s-golf-2019" */
export function slug(text, max = 40) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/** Registration if set, else nickname, else VIN. */
export function vehicleSlug(profile) {
  return slug(profile?.registration) || slug(profile?.nickname) || slug(profile?.vin) || 'vehicle';
}

const pad = (n) => String(n).padStart(2, '0');

export function stamp(date = new Date(), withTime = false) {
  const d = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime ? `${d}-${pad(date.getHours())}${pad(date.getMinutes())}` : d;
}

/** kapobd-report-dave-s-golf-2026-11-20.pdf, kapobd-log-dave-s-golf-2026-11-20-1343.txt */
export function fileName(kind, profile, ext, { date = new Date(), withTime = false } = {}) {
  return ['kapobd', kind, profile ? vehicleSlug(profile) : null, stamp(date, withTime)].filter(Boolean).join('-') + `.${ext}`;
}

export const MIME = { pdf: 'application/pdf', txt: 'text/plain', json: 'application/json', html: 'text/html' };

export function makeFile(name, content) {
  const ext = name.split('.').pop();
  return new File([content], name, { type: `${MIME[ext] ?? 'application/octet-stream'}${ext === 'txt' || ext === 'json' || ext === 'html' ? ';charset=utf-8' : ''}` });
}

function result(method, ok, extra = {}) {
  return { method, ok, ...extra };
}

/** What this browser says it can do (for the sharing test and the log). */
export function capabilities() {
  const n = typeof navigator === 'undefined' ? {} : navigator;
  let canShareText = null;
  let canShareFile = null;
  try {
    canShareText = typeof n.canShare === 'function' ? n.canShare({ text: 'test' }) : null;
    canShareFile = typeof n.canShare === 'function' ? n.canShare({ files: [new File(['test'], 'test.txt', { type: 'text/plain' })] }) : null;
  } catch {
    /* some browsers throw on unsupported shapes */
  }
  return {
    share: typeof n.share === 'function',
    canShare: typeof n.canShare === 'function',
    canShareText,
    canShareFile,
    clipboard: !!n.clipboard?.writeText,
    file: typeof File === 'function',
    download: typeof document !== 'undefined' && 'download' in document.createElement('a'),
  };
}

/** Share sheet with files. Must be called straight from a tap. */
export async function shareFiles(files, { title, text } = {}) {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return result('share-files', false, { error: 'This browser has no share sheet.' });
  try {
    if (typeof navigator.canShare === 'function' && !navigator.canShare({ files })) return result('share-files', false, { error: 'This browser can’t share files.' });
    await navigator.share({ files, title, text });
    return result('share-files', true);
  } catch (err) {
    const d = describeError(err);
    if (d.name === 'AbortError') return result('share-files', false, { cancelled: true, error: 'Cancelled.' });
    return result('share-files', false, { error: `${d.name}: ${d.message || d.raw}` });
  }
}

/** Share sheet with text only. Must be called straight from a tap. */
export async function shareText({ title, text }) {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return result('share-text', false, { error: 'This browser has no share sheet.' });
  try {
    await navigator.share({ title, text });
    return result('share-text', true);
  } catch (err) {
    const d = describeError(err);
    if (d.name === 'AbortError') return result('share-text', false, { cancelled: true, error: 'Cancelled.' });
    return result('share-text', false, { error: `${d.name}: ${d.message || d.raw}` });
  }
}

function clickLink(href, name) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
}

/** Download through a blob: link (most browsers). Success can't be detected. */
export function downloadBlob(file) {
  try {
    const url = URL.createObjectURL(file);
    clickLink(url, file.name);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return result('download-blob', true, { unconfirmed: true });
  } catch (err) {
    return result('download-blob', false, { error: describeError(err).message });
  }
}

/** Download through a data: link (some in-app browsers handle this but not blob: links). */
export function downloadDataUrl(file) {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => {
        clickLink(reader.result, file.name);
        resolve(result('download-data', true, { unconfirmed: true }));
      };
      reader.onerror = () => resolve(result('download-data', false, { error: 'Could not read the file.' }));
      reader.readAsDataURL(file);
    } catch (err) {
      resolve(result('download-data', false, { error: describeError(err).message }));
    }
  });
}

/** Open the email app. Email links can't carry attachments, and very long bodies may be cut. */
export function openEmail({ to = '', subject = '', body = '' }, maxBody = 12000) {
  const short = body.length > maxBody ? `${body.slice(0, maxBody)}\n\n[… shortened to fit in an email link]` : body;
  const href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(short)}`;
  try {
    location.href = href;
    return result('email', true, { unconfirmed: true, shortened: short.length !== body.length });
  } catch (err) {
    return result('email', false, { error: describeError(err).message });
  }
}

export function describeResult(r) {
  if (r.ok) return r.unconfirmed ? `${METHOD_TEXT[r.method]}: started (the browser doesn’t confirm whether it worked).` : `${METHOD_TEXT[r.method]}: done.`;
  if (r.cancelled) return `${METHOD_TEXT[r.method]}: cancelled.`;
  return `${METHOD_TEXT[r.method]} didn’t work: ${r.error}`;
}

export const METHOD_TEXT = {
  'share-files': 'Share file',
  'share-text': 'Share text',
  'download-blob': 'Download',
  'download-data': 'Download (alternative)',
  email: 'Email',
  copy: 'Copy',
};
