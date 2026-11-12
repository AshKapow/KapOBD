// ELM327 protocol layer: safety allow-list, command queue, response
// buffering and parsing, init sequence.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Safety allow-list (brief section 8). Everything sent goes through here.
// ---------------------------------------------------------------------------

export const ALLOWED_MODES = ['01', '02', '03', '04', '07', '09', '0A'];

// AT commands that are blocked even though AT commands are generally allowed.
const BLOCKED_AT = [
  [/^ATPP/, 'programmable parameters write to the adapter’s memory'],
  [/^ATBR[DT]/, 'changing the baud rate can leave the adapter unreachable'],
  [/^ATM[ART]/, 'bus monitoring floods the BLE link'],
];

// Exact request lengths in hex characters (mode byte included).
const LENGTHS = { '01': [4, 14], '02': [6, 6], '03': [2, 2], '04': [2, 2], '07': [2, 2], '09': [4, 4], '0A': [2, 2], '22': [6, 6] };

export function normalizeCommand(cmd) {
  return String(cmd ?? '').toUpperCase().replace(/\s+/g, '');
}

/**
 * Decide whether a command may be sent.
 * opts.allowMode22 – only the Experimental screen passes this
 * opts.clearConfirmed – only the clear-codes confirmation flow passes this
 */
export function checkCommand(cmd, { allowMode22 = false, clearConfirmed = false } = {}) {
  // Line breaks or other control characters could smuggle a second command.
  if (/[^\x20-\x7e]/.test(String(cmd ?? ''))) return { ok: false, reason: 'Control characters are not allowed in a command' };
  const c = normalizeCommand(cmd);
  if (!c) return { ok: false, reason: 'Empty command (an empty line makes the ELM327 repeat the previous command)' };
  if (c.length > 20) return { ok: false, reason: 'Command too long' };

  if (c.startsWith('AT')) {
    if (!/^AT[0-9A-Z@.,]+$/.test(c)) return { ok: false, reason: 'Malformed AT command' };
    for (const [re, why] of BLOCKED_AT) if (re.test(c)) return { ok: false, reason: `Blocked: ${why}` };
    return { ok: true, kind: 'at', cmd: c };
  }

  if (!/^[0-9A-F]+$/.test(c) || c.length % 2) {
    return { ok: false, reason: 'Not an AT command or a hex OBD request' };
  }
  const mode = c.slice(0, 2);
  if (mode === '22') {
    if (!allowMode22) return { ok: false, reason: 'Mode 22 is only allowed from the Experimental screen' };
  } else if (!ALLOWED_MODES.includes(mode)) {
    return { ok: false, reason: `Service ${mode} is not on the allow-list (only modes ${ALLOWED_MODES.join(', ')})` };
  }
  const [min, max] = LENGTHS[mode];
  if (c.length < min || c.length > max) return { ok: false, reason: `Wrong request length for mode ${mode}` };
  if (mode === '04' && !clearConfirmed) {
    return { ok: false, reason: 'Mode 04 (clear codes) can only be sent from the Clear codes confirmation flow' };
  }
  return { ok: true, kind: 'obd', mode, cmd: c };
}

export class CommandRejected extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'CommandRejected';
  }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export function hexToBytes(hex) {
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

export function bytesToHex(bytes, sep = ' ') {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(sep);
}

// Order matters: first match wins.
const ERROR_PATTERNS = [
  [/^NO DATA$/, 'NO DATA'],
  [/^UNABLE TO CONNECT$/, 'UNABLE TO CONNECT'],
  [/^BUS INIT:?.*ERROR$/, 'BUS INIT ERROR'],
  [/^CAN ERROR$/, 'CAN ERROR'],
  [/^BUS ERROR$/, 'BUS ERROR'],
  [/^BUS BUSY$/, 'BUS BUSY'],
  [/^BUFFER FULL$/, 'BUFFER FULL'],
  [/^<?DATA ERROR/, 'DATA ERROR'],
  [/^<?RX ERROR/, 'RX ERROR'],
  [/^FB ERROR$/, 'FB ERROR'],
  [/^STOPPED$/, 'STOPPED'],
  [/^LV RESET$/, 'LV RESET'],
  [/^ACT ALERT$/, 'ACT ALERT'],
  [/^ERR\d+$/, 'ERR'],
  [/^\?$/, '?'],
];

export function classifyLine(line) {
  const u = line.toUpperCase();
  for (const [re, code] of ERROR_PATTERNS) if (re.test(u)) return code;
  return null;
}

export const NRC_NAMES = {
  0x10: 'general reject',
  0x11: 'service not supported',
  0x12: 'sub-function not supported',
  0x13: 'incorrect message length',
  0x14: 'response too long',
  0x21: 'busy, repeat request',
  0x22: 'conditions not correct',
  0x24: 'request sequence error',
  0x31: 'request out of range',
  0x33: 'security access denied',
  0x78: 'response pending',
  0x7e: 'sub-function not supported in active session',
  0x7f: 'service not supported in active session',
};

/** Map ATDPN output ("A6", "6") to a frame layout. */
export function protocolKind(dpn) {
  const p = String(dpn ?? '').toUpperCase().replace(/^A/, '').trim();
  if (['6', '8'].includes(p)) return 'can11';
  if (['7', '9', 'A'].includes(p)) return 'can29';
  if (['1', '2', '3', '4', '5'].includes(p)) return 'legacy';
  return null; // unknown/auto: guess per line
}

export const PROTOCOL_NAMES = {
  0: 'Automatic',
  1: 'SAE J1850 PWM',
  2: 'SAE J1850 VPW',
  3: 'ISO 9141-2',
  4: 'ISO 14230-4 KWP (5 baud init)',
  5: 'ISO 14230-4 KWP (fast init)',
  6: 'ISO 15765-4 CAN (11 bit, 500 kbaud)',
  7: 'ISO 15765-4 CAN (29 bit, 500 kbaud)',
  8: 'ISO 15765-4 CAN (11 bit, 250 kbaud)',
  9: 'ISO 15765-4 CAN (29 bit, 250 kbaud)',
  A: 'SAE J1939 CAN',
};

/** Guess the frame layout of one header-on line (spaces removed). */
export function guessLineKind(hex) {
  if (hex.length % 2 === 1) return 'can11'; // 3-char header + whole bytes
  if (/^18DA/.test(hex)) return 'can29';
  return 'legacy';
}

/**
 * Turn data lines into messages.
 * Returns [{ ecu, bytes, can, incomplete? }]
 */
export function assembleMessages(dataLines, { headers = true, protocol = null } = {}) {
  const messages = [];

  if (!headers) {
    // CAN multi-frame with headers off: "014" then "0:..." "1:..."
    let multi = null;
    for (const line of dataLines) {
      const m = /^([0-9A-F]):(.*)$/.exec(line);
      if (/^[0-9A-F]{3}$/.test(line)) {
        if (multi) messages.push({ ecu: 'ECU', bytes: multi.bytes.slice(0, multi.len), can: true, incomplete: multi.bytes.length < multi.len });
        multi = { len: parseInt(line, 16), bytes: [] };
      } else if (m && multi) {
        multi.bytes.push(...hexToBytes(m[2]));
      } else {
        messages.push({ ecu: 'ECU', bytes: hexToBytes(line), can: protocol ? protocol !== 'legacy' : undefined });
      }
    }
    if (multi) messages.push({ ecu: 'ECU', bytes: multi.bytes.slice(0, multi.len), can: true, incomplete: multi.bytes.length < multi.len });
    return messages;
  }

  const pendingByEcu = new Map();
  for (const line of dataLines) {
    const kind = protocol ?? guessLineKind(line);
    if (kind === 'legacy') {
      // 3 header bytes (priority, target, source), data, checksum
      const bytes = hexToBytes(line);
      if (bytes.length < 4) continue;
      messages.push({ ecu: bytesToHex([bytes[2]], ''), bytes: bytes.slice(3, -1), can: false });
      continue;
    }
    const hlen = kind === 'can29' ? 8 : 3;
    const ecu = line.slice(0, hlen);
    const frame = hexToBytes(line.slice(hlen));
    if (!frame.length) continue;
    const type = frame[0] >> 4;
    if (type === 0) {
      const len = frame[0] & 0x0f;
      messages.push({ ecu, bytes: frame.slice(1, 1 + len), can: true });
    } else if (type === 1) {
      const len = ((frame[0] & 0x0f) << 8) | frame[1];
      const msg = { ecu, bytes: frame.slice(2), len, can: true };
      pendingByEcu.set(ecu, msg);
    } else if (type === 2) {
      const msg = pendingByEcu.get(ecu);
      if (!msg) continue; // consecutive frame without a first frame
      msg.bytes.push(...frame.slice(1));
      if (msg.bytes.length >= msg.len) {
        messages.push({ ecu, bytes: msg.bytes.slice(0, msg.len), can: true });
        pendingByEcu.delete(ecu);
      }
    }
    // type 3 = flow control: ignore
  }
  for (const [ecu, msg] of pendingByEcu) messages.push({ ecu, bytes: msg.bytes, can: true, incomplete: true });
  return messages;
}

/**
 * Parse one raw response (everything before the '>' prompt).
 * Returns { cmd, ok, error, lines, notices, messages, negatives, raw }
 */
export function parseResponse(raw, { cmd = '', headers = true, protocol = null } = {}) {
  const c = normalizeCommand(cmd);
  let lines = String(raw).split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length && normalizeCommand(lines[0]) === c) lines.shift(); // echo

  const notices = [];
  const errors = [];
  const data = [];
  const isObd = c && !c.startsWith('AT');

  for (const line of lines) {
    const u = line.toUpperCase();
    if (/^SEARCHING/.test(u) || /^BUS INIT:?\s*(\.\.\.)?\s*(OK)?$/.test(u)) {
      notices.push(line);
      continue;
    }
    const err = classifyLine(u);
    if (err) {
      errors.push(err);
      continue;
    }
    const compact = u.replace(/\s+/g, '');
    if (isObd && /^([0-9A-F]+|[0-9A-F]:[0-9A-F]*)$/.test(compact)) data.push(compact);
    else if (isObd) notices.push(line);
    else data.push(line);
  }

  const result = { cmd: c, ok: true, error: null, lines: data, notices, messages: [], negatives: [], raw };

  if (!isObd) {
    if (errors.length) {
      result.ok = false;
      result.error = errors[0];
    }
    return result;
  }

  let messages = assembleMessages(data, { headers, protocol });
  const negatives = [];
  for (const m of messages) {
    if (m.bytes[0] === 0x7f) negatives.push({ ecu: m.ecu, service: m.bytes[1], nrc: m.bytes[2], nrcName: NRC_NAMES[m.bytes[2]] ?? 'unknown' });
  }
  // "Response pending" from an ECU that later answered properly is noise.
  const positiveEcus = new Set(messages.filter((m) => m.bytes[0] !== 0x7f).map((m) => m.ecu));
  result.negatives = negatives.filter((n) => !(n.nrc === 0x78 && positiveEcus.has(n.ecu)));
  result.messages = messages.filter((m) => m.bytes[0] !== 0x7f);

  if (!result.messages.length) {
    result.ok = false;
    result.error = result.negatives.length ? 'NEGATIVE_RESPONSE' : errors[0] ?? 'NO_DATA_LINES';
  } else if (errors.length) {
    result.warnings = errors;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Adapter driver
// ---------------------------------------------------------------------------

export class Elm327 {
  constructor(transport, log, opts = {}) {
    this.t = transport;
    this.log = log;
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.searchTimeoutMs = opts.searchTimeoutMs ?? 12000;
    this.resetDelayMs = opts.resetDelayMs ?? 1000;
    this.lateGraceMs = opts.lateGraceMs ?? 600;
    this.clearCooldownMs = opts.clearCooldownMs ?? 15000;
    this.buffer = '';
    this.pending = null;
    this.queue = Promise.resolve();
    this.headers = false;
    this.protocol = null; // 'can11' | 'can29' | 'legacy' | null
    this.protocolNumber = null;
    this.searched = false;
    this.lastClearAt = 0;
    this._lateWait = null;
    this._lateWake = null;
    this.stats = { sent: 0, timeouts: 0, errors: 0 };
    transport.ondata = (s) => this._onData(s);
  }

  _onData(s) {
    this.log.frag(s);
    this.buffer += s;
    let i;
    while ((i = this.buffer.indexOf('>')) >= 0) {
      const raw = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      const p = this.pending;
      if (p) {
        this.pending = null;
        clearTimeout(p.timer);
        p.resolve(raw);
      } else {
        if (raw.trim()) this.log.warn(`Late response discarded: ${raw.replace(/[\r\n]+/g, ' ').trim()}`);
        this._lateWake?.();
      }
    }
  }

  _startLateWait() {
    this._lateWait = new Promise((resolve) => {
      this._lateWake = resolve;
      setTimeout(resolve, this.lateGraceMs);
    });
  }

  /**
   * Queue a command. Resolves with the parsed response; never retries.
   * Rejects with CommandRejected if the allow-list refuses it.
   */
  send(cmd, opts = {}) {
    const check = checkCommand(cmd, opts);
    if (!check.ok) {
      this.log.error(`BLOCKED "${normalizeCommand(cmd)}": ${check.reason}`);
      return Promise.reject(new CommandRejected(check.reason));
    }
    const c = check.cmd;
    const run = () => this._run(c, check, opts);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async _run(c, check, opts) {
    if (check.mode === '04') {
      const since = Date.now() - this.lastClearAt;
      if (since < this.clearCooldownMs) {
        const reason = 'Clear codes was sent moments ago; wait before trying again';
        this.log.error(`BLOCKED "04": ${reason}`);
        throw new CommandRejected(reason);
      }
      this.lastClearAt = Date.now();
    }
    if (this._lateWait) {
      await this._lateWait;
      this._lateWait = null;
      this._lateWake = null;
    }
    this.buffer = '';

    const isObd = check.kind === 'obd';
    const timeout = opts.timeoutMs ?? (isObd && !this.searched ? this.searchTimeoutMs : this.timeoutMs);
    const started = Date.now();
    this.stats.sent++;
    this.log.tx(c);

    const raw = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending?.timer === timer) this.pending = null;
        this._startLateWait();
        resolve(null);
      }, timeout);
      this.pending = { resolve, timer };
      this.t.write(c + '\r').catch((err) => {
        if (this.pending?.timer === timer) {
          clearTimeout(timer);
          this.pending = null;
        }
        resolve({ writeError: err });
      });
    });
    const ms = Date.now() - started;

    if (raw === null) {
      this.stats.timeouts++;
      this.log.error(`TIMEOUT "${c}" after ${timeout}ms`);
      return { cmd: c, ok: false, error: 'TIMEOUT', lines: [], notices: [], messages: [], negatives: [], raw: null, ms };
    }
    if (typeof raw === 'object') {
      this.stats.errors++;
      this.log.error(`WRITE FAILED "${c}": ${raw.writeError?.message ?? raw.writeError}`);
      return { cmd: c, ok: false, error: 'WRITE_FAILED', lines: [], notices: [], messages: [], negatives: [], raw: null, ms };
    }

    this.log.rx(raw, ms);
    const res = parseResponse(raw, { cmd: c, headers: this.headers, protocol: this.protocol });
    res.ms = ms;
    this._track(c, res, isObd);
    if (!res.ok) {
      this.stats.errors++;
      const neg = res.negatives.map((n) => `${n.ecu}: 7F ${bytesToHex([n.service])} ${bytesToHex([n.nrc])} (${n.nrcName})`).join('; ');
      this.log.warn(`"${c}" → ${res.error}${neg ? ` [${neg}]` : ''}`);
    }
    return res;
  }

  /** Keep our idea of the adapter's settings in step with what it accepted. */
  _track(c, res, isObd) {
    if (isObd) {
      if (res.error !== 'UNABLE TO CONNECT' && res.error !== 'BUS INIT ERROR') this.searched = true;
      return;
    }
    if (c === 'ATZ' || c === 'ATD' || c === 'ATWS') {
      this.headers = false;
      this.searched = false;
      this.protocol = null;
    }
    if (!res.ok) return;
    if (c === 'ATH1') this.headers = true;
    if (c === 'ATH0') this.headers = false;
    if (/^ATSPA?[0-9A-C]$/.test(c)) {
      this.searched = false;
      this.protocol = null;
    }
  }

  setProtocol(dpn) {
    const p = String(dpn ?? '').toUpperCase().trim();
    this.protocolNumber = p || null;
    this.protocol = protocolKind(p);
  }

  get protocolName() {
    if (!this.protocolNumber) return null;
    const auto = this.protocolNumber.startsWith('A');
    const n = this.protocolNumber.replace(/^A/, '');
    return `${PROTOCOL_NAMES[n] ?? `protocol ${n}`}${auto ? ' (auto-detected)' : ''}`;
  }

  /** Just reset and identify the adapter (Phase 0 check). */
  async identify() {
    const z = await this.send('ATZ', { timeoutMs: 4000 });
    await sleep(this.resetDelayMs);
    const i = await this.send('ATI');
    const id = i.ok ? i.lines.join(' ') : null;
    return { ok: i.ok, id, reset: z };
  }

  /**
   * Full init sequence (brief section 5). Never throws for adapter/car
   * errors; the result says what worked.
   */
  async init({ onStep } = {}) {
    const step = (s) => {
      this.log.info(`Init: ${s}`);
      onStep?.(s);
    };
    const out = { ok: false, adapterId: null, voltage: null, protocol: null, protocolName: null, carResponded: false, error: null };

    step('resetting adapter (ATZ)');
    const z = await this.send('ATZ', { timeoutMs: 4000 });
    if (!z.ok) this.log.warn('ATZ gave no clean reply; carrying on');
    await sleep(this.resetDelayMs);

    for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH1']) {
      step(c);
      const r = await this.send(c);
      if (!r.ok) {
        out.error = `Adapter did not accept ${c} (${r.error}). Check it is powered and connected.`;
        return out;
      }
    }

    const i = await this.send('ATI');
    out.adapterId = i.ok ? i.lines.join(' ') : null;
    await this.send('AT@1'); // device description; many clones answer "?"
    const rv = await this.send('ATRV');
    out.voltage = rv.ok ? rv.lines.join(' ') : null;

    step('ATSP0 (auto protocol)');
    await this.send('ATSP0');

    step('0100: first request to the car (protocol search, can take ~10 s)');
    const first = await this.send('0100', { timeoutMs: this.searchTimeoutMs });

    const dpn = await this.send('ATDPN');
    if (dpn.ok && dpn.lines[0]) this.setProtocol(dpn.lines[0]);
    out.protocol = this.protocolNumber;
    out.protocolName = this.protocolName;
    if (this.protocolName) this.log.info(`Protocol: ${this.protocolNumber} = ${this.protocolName}`);

    if (!first.ok) {
      out.error =
        first.error === 'UNABLE TO CONNECT' || first.error === 'NO DATA'
          ? `The car did not answer (${first.error}). Is the ignition on?`
          : `The car's first reply was an error: ${first.error}`;
      return out;
    }
    out.carResponded = true;
    out.ecus = [...new Set(first.messages.map((m) => m.ecu))];
    out.ok = true;
    step(`done: ${out.ecus.length} ECU(s) answered (${out.ecus.join(', ')})`);
    return out;
  }
}
