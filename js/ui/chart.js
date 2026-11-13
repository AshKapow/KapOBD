// Canvas line charts for live data: a tile sparkline and a full detail graph.
// No library. Specs: 2px line with round joins, ~10% area wash, end dot
// (r=4) with a 2px surface-coloured ring, hairline solid gridlines, clean
// y ticks, text in text colours (never the series colour), one y axis.

// Series colour validated against the dark tile surface (#181d23): passes
// the lightness band, chroma floor and 3:1 contrast checks.
export const SERIES = '#3987e5';
const SURFACE = '#181d23';
const GRID = '#2c3540';
const TEXT_MUTED = '#8b98a6';
const TEXT_PRIMARY = '#e8edf2';

/** Clean, round tick values covering [min, max]. */
export function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    const pad = Math.abs(min) > 1 ? Math.abs(min) * 0.05 : 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

/** Decimal places needed to tell ticks `step` apart (0.05 → 2, 0.5 → 1, 5 → 0). */
export function tickDecimals(step) {
  if (!(step > 0) || step >= 1) return 0;
  const s = String(Number(step.toFixed(10)));
  return s.includes('.') ? s.split('.')[1].length : 0;
}

/** Format a tick: full numbers under 10,000 (with the decimals the step needs), compact (12K) above. */
export function formatTick(v, decimals = 0) {
  if (Math.abs(v) >= 10000) return `${Math.round(v / 1000)}K`;
  const [int, frac] = v.toFixed(decimals).split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
}

/** Size a canvas's backing store for the device pixel ratio; returns a 2D context in CSS pixels. */
function prepare(canvas) {
  const dpr = globalThis.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function yRange(points, ticks) {
  if (ticks?.length >= 2) return [ticks[0], ticks[ticks.length - 1]];
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    min = Math.min(min, p.v);
    max = Math.max(max, p.v);
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.12;
  return [min - pad, max + pad];
}

function plot(ctx, points, x, y, bottom) {
  // Area wash, then the line, then the end dot with its surface ring.
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v))));
  ctx.lineTo(x(points[points.length - 1].t), bottom);
  ctx.lineTo(x(points[0].t), bottom);
  ctx.closePath();
  ctx.fillStyle = 'rgba(57, 135, 229, 0.10)';
  ctx.fill();

  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v))));
  ctx.strokeStyle = SERIES;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  const last = points[points.length - 1];
  dot(ctx, x(last.t), y(last.v));
}

function dot(ctx, cx, cy) {
  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, Math.PI * 2);
  ctx.fillStyle = SURFACE;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = SERIES;
  ctx.fill();
}

/** Small trend line for a tile: no axes, last `seconds` of points. */
export function drawSparkline(canvas, points, { seconds = 60, now = Date.now() } = {}) {
  const { ctx, w, h } = prepare(canvas);
  if (points.length < 2) return;
  const t0 = now - seconds * 1000;
  const [lo, hi] = yRange(points);
  const pad = 7; // room for the end dot and its ring
  const x = (t) => pad + ((t - t0) / (now - t0)) * (w - pad * 2);
  const y = (v) => h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2);
  plot(ctx, points, x, y, h);
}

/**
 * Full graph with a y axis, hairline grid and time labels. Returns a
 * `pick(px)` function mapping a pointer x (CSS px) to the nearest point and
 * its position, for the crosshair/tooltip layer.
 */
export function drawLineChart(canvas, points, { seconds = 60, now = Date.now(), crosshair = null } = {}) {
  const { ctx, w, h } = prepare(canvas);
  const left = 48;
  const right = 14;
  const top = 12;
  const bottom = 26;
  const t0 = now - seconds * 1000;
  const x = (t) => left + ((t - t0) / (now - t0)) * (w - left - right);

  ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textBaseline = 'middle';

  // Time labels along the bottom.
  ctx.fillStyle = TEXT_MUTED;
  ctx.textAlign = 'center';
  const marks = seconds <= 60 ? [60, 30, 0] : [300, 240, 180, 120, 60, 0];
  for (const s of marks) {
    if (s > seconds) continue;
    const label = s === 0 ? 'now' : s < 60 ? `−${s} s` : `−${s / 60} min`;
    ctx.fillText(label, Math.min(w - right - 12, Math.max(left + 12, x(now - s * 1000))), h - bottom / 2);
  }

  if (points.length < 2) {
    ctx.fillStyle = TEXT_MUTED;
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for values…', (left + w - right) / 2, (top + h - bottom) / 2);
    return { pick: () => null };
  }

  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    min = Math.min(min, p.v);
    max = Math.max(max, p.v);
  }
  const ticks = niceTicks(min, max, 4);
  const decimals = tickDecimals(ticks[1] - ticks[0]);
  const [lo, hi] = yRange(points, ticks);
  const y = (v) => h - bottom - ((v - lo) / (hi - lo)) * (h - top - bottom);

  // Hairline solid gridlines and y labels.
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  for (const t of ticks) {
    const yy = Math.round(y(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(left, yy);
    ctx.lineTo(w - right, yy);
    ctx.stroke();
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText(formatTick(t, decimals), left - 8, yy);
  }

  const visible = points.filter((p) => p.t >= t0);
  if (visible.length >= 2) plot(ctx, visible, x, y, h - bottom);

  const pick = (px) => {
    if (!visible.length) return null;
    let best = visible[0];
    for (const p of visible) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
    return { point: best, x: x(best.t), y: y(best.v) };
  };

  if (crosshair != null) {
    const hit = pick(crosshair);
    if (hit) {
      ctx.strokeStyle = TEXT_MUTED;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(hit.x) + 0.5, top);
      ctx.lineTo(Math.round(hit.x) + 0.5, h - bottom);
      ctx.stroke();
      dot(ctx, hit.x, hit.y);
    }
  }
  return { pick };
}

export { TEXT_PRIMARY, TEXT_MUTED };
