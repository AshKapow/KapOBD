// In-memory log of everything sent to and received from the adapter.
// The Console screen renders it; "Copy log" turns it into text for the owner
// to paste back into the project.

export const KINDS = ['tx', 'rx', 'frag', 'ble', 'info', 'warn', 'error'];

/** Make control characters visible: \r → ␍, \n → ␊, others as \xNN. */
export function visible(s) {
  return String(s).replace(/[\x00-\x1f\x7f]/g, (ch) => {
    if (ch === '\r') return '␍';
    if (ch === '\n') return '␊';
    return '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0');
  });
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

export function formatTime(t) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export class Logger {
  constructor({ max = 5000 } = {}) {
    this.max = max;
    this.entries = [];
    this.listeners = new Set();
    this.seq = 0;
  }

  add(kind, text, extra = {}) {
    const e = { id: ++this.seq, t: Date.now(), kind, text: String(text), ...extra };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a broken listener must not break logging */
      }
    }
    return e;
  }

  tx(text) { return this.add('tx', text); }
  rx(text, ms) { return this.add('rx', text, ms == null ? {} : { ms }); }
  frag(text) { return this.add('frag', text); }
  ble(text) { return this.add('ble', text); }
  info(text) { return this.add('info', text); }
  warn(text) { return this.add('warn', text); }
  error(text) { return this.add('error', text); }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  clear() {
    this.entries = [];
    this.add('info', 'Log cleared');
  }

  static formatEntry(e) {
    const label = e.kind.toUpperCase().padEnd(5);
    const ms = e.ms != null ? ` (${e.ms}ms)` : '';
    const text = e.kind === 'rx' || e.kind === 'frag' ? visible(e.text) : e.text;
    return `${formatTime(e.t)} ${label} ${text}${ms}`;
  }

  /** Plain-text log. `header` lines go first (app version, device, etc.). */
  format({ includeFrags = true, header = [], entries = this.entries } = {}) {
    const lines = [...header];
    for (const e of entries) {
      if (!includeFrags && e.kind === 'frag') continue;
      lines.push(Logger.formatEntry(e));
    }
    return lines.join('\n');
  }
}

/** A logger that discards everything (tests). */
export function nullLogger() {
  const l = new Logger({ max: 1 });
  return l;
}
