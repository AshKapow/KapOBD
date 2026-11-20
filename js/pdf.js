// Minimal PDF writer (no library): A4 pages, Helvetica, headings, two-column
// rows, bullet lists, wrapping, page numbers. Text is encoded as WinAnsi
// (the standard PDF fonts' character set); anything outside it is replaced.

// Helvetica glyph widths (1/1000 em) for ASCII 32–126, from the standard AFM.
const W = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

// Characters outside Latin-1 that WinAnsi has, plus friendly substitutes.
const WIN = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };
const SUBST = { '✓': 'OK', '✗': 'X', '−': '-', '″': '"', '′': "'", 'λ': 'lambda', 'Ω': 'ohm', '→': '->', '≥': '>=', '≤': '<=', '×': 'x', ' ': ' ' };

/** Text → WinAnsi byte string (one char per byte). */
export function winAnsi(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    if (SUBST[ch]) out += SUBST[ch];
    else if (WIN[ch]) out += String.fromCharCode(WIN[ch]);
    else {
      const c = ch.codePointAt(0);
      out += c < 0x20 ? ' ' : c <= 0xff ? ch : '?';
    }
  }
  return out;
}

function width(s, size, bold) {
  let w = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? W[c - 32] : 556;
  }
  return (w * size * (bold ? 1.08 : 1)) / 1000;
}

/** Split WinAnsi text into lines no wider than maxW points. */
export function wrap(s, size, maxW, bold = false) {
  const words = s.split(/ +/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const tryLine = line ? `${line} ${word}` : word;
    if (width(tryLine, size, bold) <= maxW) {
      line = tryLine;
      continue;
    }
    if (line) lines.push(line);
    // A single word too long for the line: break it.
    let w = word;
    while (width(w, size, bold) > maxW) {
      let i = w.length;
      while (i > 1 && width(w.slice(0, i), size, bold) > maxW) i--;
      lines.push(w.slice(0, i));
      w = w.slice(i);
    }
    line = w;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/**
 * sections: [{ heading, rows?: [[key, value]], items?: [text], note?: text }]
 * Returns the PDF as a Uint8Array.
 */
export function makePdf({ title, subtitle, sections = [], footer = '' }) {
  const PW = 595.28;
  const PH = 841.89;
  const M = 50;
  const KEYW = 170;
  const pages = [];
  let ops = [];
  let y = PH - M;

  const newPage = () => {
    pages.push(ops);
    ops = [];
    y = PH - M;
  };
  const need = (h) => {
    if (y - h < M + 24) newPage();
  };
  const text = (x, size, font, s, gray = 0) => ops.push(`${gray} g BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(s)}) Tj ET`);
  const rule = () => ops.push(`0.8 G 0.6 w ${M} ${(y + 4).toFixed(2)} m ${(PW - M).toFixed(2)} ${(y + 4).toFixed(2)} l S`);

  // Title
  for (const l of wrap(winAnsi(title), 18, PW - 2 * M, true)) {
    need(24);
    text(M, 18, 'F2', l);
    y -= 24;
  }
  if (subtitle) {
    for (const l of wrap(winAnsi(subtitle), 9, PW - 2 * M)) {
      text(M, 9, 'F1', l, 0.35);
      y -= 13;
    }
  }
  y -= 6;

  for (const s of sections) {
    need(40);
    y -= 8;
    text(M, 13, 'F2', winAnsi(s.heading));
    y -= 6;
    rule();
    y -= 14;
    for (const [k, v] of s.rows ?? []) {
      const kl = wrap(winAnsi(k), 10, KEYW - 10);
      const vl = wrap(winAnsi(v), 10, PW - 2 * M - KEYW);
      const n = Math.max(kl.length, vl.length);
      need(n * 13 + 4);
      for (let i = 0; i < n; i++) {
        if (kl[i]) text(M, 10, 'F1', kl[i], 0.35);
        if (vl[i]) text(M + KEYW, 10, 'F1', vl[i]);
        y -= 13;
      }
      y -= 3;
    }
    for (const item of s.items ?? []) {
      const lines = wrap(winAnsi(item), 10, PW - 2 * M - 14);
      need(lines.length * 13 + 3);
      lines.forEach((l, i) => {
        if (i === 0) text(M, 10, 'F1', winAnsi('•'));
        text(M + 12, 10, 'F1', l);
        y -= 13;
      });
      y -= 3;
    }
    if (s.note) {
      const lines = wrap(winAnsi(s.note), 9, PW - 2 * M, false);
      need(lines.length * 12 + 4);
      for (const l of lines) {
        text(M, 9, 'F3', l, 0.35);
        y -= 12;
      }
    }
  }
  if (footer) {
    const lines = wrap(winAnsi(footer), 8, PW - 2 * M);
    need(lines.length * 11 + 16);
    y -= 12;
    for (const l of lines) {
      text(M, 8, 'F1', l, 0.4);
      y -= 11;
    }
  }
  pages.push(ops);

  // Page numbers.
  const total = pages.length;
  pages.forEach((p, i) => p.push(`0.45 g BT /F1 8 Tf ${(PW - M - 50).toFixed(2)} ${(M - 20).toFixed(2)} Td (Page ${i + 1} of ${total}) Tj ET`));

  // Assemble objects: 1 catalog, 2 pages, 3-5 fonts, then page + content pairs.
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pages.map((_, i) => `${6 + i * 2} 0 R`).join(' ');
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${total} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>';
  pages.forEach((p, i) => {
    const pageId = 6 + i * 2;
    const content = p.join('\n');
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objs[pageId + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info << /Producer (KapOBD) /Title (${esc(winAnsi(title))}) >> >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
