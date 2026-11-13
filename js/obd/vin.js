// Offline VIN decoding: manufacturer (from the first three characters),
// region, and model year where it's reliably encoded (North America).

import { WMI } from '../../data/wmi.js';

const REGIONS = [
  [/^[A-H]/, 'Africa'],
  [/^J/, 'Japan'],
  [/^K[L-R]/, 'South Korea'],
  [/^L/, 'China'],
  [/^M[A-E]/, 'India'],
  [/^N[L-R]/, 'Turkey'],
  [/^S[A-M]/, 'United Kingdom'],
  [/^S[N-T]/, 'Germany (former East)'],
  [/^S[U-Z]/, 'Poland'],
  [/^T[A-H]/, 'Switzerland'],
  [/^T[J-P]/, 'Czech Republic'],
  [/^T[R-V]/, 'Hungary'],
  [/^T[W-Z1]/, 'Portugal'],
  [/^U[U-Z]/, 'Romania'],
  [/^V[A-E]/, 'Austria'],
  [/^V[F-R]/, 'France'],
  [/^V[S-W]/, 'Spain'],
  [/^W/, 'Germany'],
  [/^X[L-R]/, 'Netherlands'],
  [/^X[S-W3-9]/, 'Russia'],
  [/^Y[A-E]/, 'Belgium'],
  [/^Y[F-K]/, 'Finland'],
  [/^Y[S-W]/, 'Sweden'],
  [/^Z[A-R]/, 'Italy'],
  [/^[145]/, 'United States'],
  [/^2/, 'Canada'],
  [/^3/, 'Mexico'],
  [/^6/, 'Australia'],
  [/^7/, 'New Zealand'],
  [/^9/, 'Brazil'],
];

const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';

export function decodeVin(vin, now = new Date()) {
  const v = String(vin ?? '').toUpperCase().trim();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return { valid: false, vin: v };
  const wmi = v.slice(0, 3);
  const manufacturer = WMI[wmi] ?? WMI[wmi.slice(0, 2)] ?? null;
  const region = REGIONS.find(([re]) => re.test(v))?.[1] ?? null;

  // Model year (10th character) is only dependable on North American VINs;
  // many European and Japanese makers don't use it. The code repeats every
  // 30 years: a letter in position 7 means 2010 onwards.
  let modelYear = null;
  if (/^[1-5]/.test(v)) {
    const i = YEAR_CODES.indexOf(v[9]);
    if (i >= 0) {
      const base = /[A-Z]/.test(v[6]) ? 2010 : 1980;
      modelYear = base + i;
      if (modelYear > now.getFullYear() + 1) modelYear -= 30;
    }
  }
  return { valid: true, vin: v, wmi, manufacturer, region, modelYear, serial: v.slice(11) };
}
