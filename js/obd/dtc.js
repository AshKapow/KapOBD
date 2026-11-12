// DTC decoding: two bytes → "P0301", plus plain-English descriptions.

const SYSTEMS = { P: 'Powertrain', C: 'Chassis', B: 'Body', U: 'Network' };

export function decodeDtc(a, b) {
  const letter = 'PCBU'[a >> 6];
  const h = (n) => n.toString(16).toUpperCase();
  return `${letter}${(a >> 4) & 0x03}${h(a & 0x0f)}${h(b >> 4)}${h(b & 0x0f)}`;
}

/**
 * Extract DTCs from mode 03/07/0A response messages.
 * CAN: [43, count, A, B, A, B, …]. Older protocols: [43, A, B, A, B, A, B] per
 * message, no count byte, padded with 00 00. When the protocol is unknown the
 * byte count tells them apart (CAN is even, legacy is odd).
 * Returns [{ ecu, codes: [...] }].
 */
export function parseDtcMessages(messages, service) {
  const byEcu = new Map();
  for (const m of messages) {
    if (m.bytes[0] !== service + 0x40) continue;
    const can = m.can ?? m.bytes.length % 2 === 0;
    const body = can ? m.bytes.slice(2) : m.bytes.slice(1);
    const codes = byEcu.get(m.ecu) ?? [];
    for (let i = 0; i + 1 < body.length; i += 2) {
      if (body[i] === 0 && body[i + 1] === 0) continue;
      const code = decodeDtc(body[i], body[i + 1]);
      if (!codes.includes(code)) codes.push(code);
    }
    byEcu.set(m.ecu, codes);
  }
  return [...byEcu].map(([ecu, codes]) => ({ ecu, codes }));
}

export function dtcSystem(code) {
  return SYSTEMS[code[0]] ?? 'Unknown';
}

/** Generic (SAE) codes have 0 as the second character; also P2xxx and P34xx–P39xx. */
export function isGeneric(code) {
  return code[1] === '0' || (code[0] === 'P' && (code[1] === '2' || (code[1] === '3' && code[2] >= '4')));
}

export function describeDtc(code, table = {}) {
  if (table[code]) return table[code];
  if (isGeneric(code)) return 'Generic code (description not in the built-in list)';
  return 'Manufacturer-specific code';
}

let tablePromise = null;

/** Browser only: load data/dtc-codes.json once. Resolves to {} on failure. */
export function loadDtcTable(url = new URL('../../data/dtc-codes.json', import.meta.url)) {
  tablePromise ??= fetch(url)
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  return tablePromise;
}
