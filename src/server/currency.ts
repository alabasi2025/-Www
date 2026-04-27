/**
 * Currency / rate helpers — replicates the legacy THWL procedure.
 *
 * THWL (طَحْوَل = convert) was used on voucher screens to synchronize three
 * amounts around a single exchange rate:
 *
 *   TOTALS   — local amount (base currency, usually YER)
 *   TOTALS2  — foreign amount (in NOAML)
 *   SARSFS   — exchange rate (local per foreign unit)
 *
 * Invariant: TOTALS == TOTALS2 * SARSFS
 *
 * Plus SARS1/SARS2 bounds (per-currency soft limits from DATA_AML):
 *   - If the rate falls outside [SARS1, SARS2] the user gets a warning.
 *   - A zero/negative rate is always rejected.
 */

import { queryOn } from './db';
import { M } from './messages';

// ════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════

export interface CurrencyRow {
  NO:     number;
  NAMEM3: string;
  SARS:   number;   // default / last-used rate
  SARS1:  number;   // minimum allowed rate
  SARS2:  number;   // maximum allowed rate
}

/** Result of a THWL conversion — mirrors the three items it synced in Forms. */
export interface ThwlResult {
  local:   number;   // TOTALS
  foreign: number;   // TOTALS2
  rate:    number;   // SARSFS
}

// ════════════════════════════════════════════════════════
// Lookups
// ════════════════════════════════════════════════════════

export async function getCurrency(
  schema: string,
  no: number,
): Promise<CurrencyRow | null> {
  const n = Number(no);
  if (!n) return null;
  const rows = await queryOn<CurrencyRow>(
    schema,
    `SELECT no, namem3, sars, sars1, sars2 FROM data_aml WHERE no = :n`,
    { n },
  );
  return rows[0] ?? null;
}

/** Cached full currency list (used by LOVs + voucher headers). */
export async function listCurrencies(schema: string): Promise<CurrencyRow[]> {
  return queryOn<CurrencyRow>(
    schema,
    `SELECT no, namem3, sars, sars1, sars2 FROM data_aml ORDER BY no`,
  );
}

// ════════════════════════════════════════════════════════
// THWL — synchronize {local, foreign, rate}
// ════════════════════════════════════════════════════════

/**
 * Recomputes the missing amount given the other two.
 *
 * Which field changed (driver) tells us what to recompute:
 *   - driver='local'   → foreign = local / rate
 *   - driver='foreign' → local   = foreign * rate
 *   - driver='rate'    → local   = foreign * rate   (keeps foreign stable)
 *
 * Rounds `local` to 2 decimals and `foreign` to 4 decimals to match
 * the legacy DATA_AML display precision.
 */
export function thwl(
  driver: 'local' | 'foreign' | 'rate',
  values: Partial<ThwlResult>,
): ThwlResult {
  const local   = Number(values.local   ?? 0);
  const foreign = Number(values.foreign ?? 0);
  const rate    = Number(values.rate    ?? 0);

  const r2 = (v: number) => Math.round(v * 100) / 100;
  const r4 = (v: number) => Math.round(v * 10000) / 10000;

  if (rate <= 0) {
    return { local: r2(local), foreign: r4(foreign), rate: r4(rate) };
  }

  switch (driver) {
    case 'local':   return { local: r2(local), foreign: r4(local / rate), rate: r4(rate) };
    case 'foreign': return { local: r2(foreign * rate), foreign: r4(foreign), rate: r4(rate) };
    case 'rate':    return { local: r2(foreign * rate), foreign: r4(foreign), rate: r4(rate) };
  }
}

// ════════════════════════════════════════════════════════
// Validation guards
// ════════════════════════════════════════════════════════

/**
 * Rate must be:
 *   - strictly positive
 *   - within [SARS1, SARS2] if those bounds are set
 *
 * The original Forms emitted a soft warning when outside the bounds; here
 * we return an Arabic string so the caller can decide whether to hard-block
 * or just surface a warning.
 */
export function validateRate(
  rate: number,
  currency: Pick<CurrencyRow, 'SARS1' | 'SARS2'> | null,
): string | null {
  const r = Number(rate);
  if (!r || r <= 0) return M.CURRENCY_RATE_ZERO;
  if (!currency) return null;
  const lo = Number(currency.SARS1 ?? 0);
  const hi = Number(currency.SARS2 ?? 0);
  if (lo > 0 && r < lo) return M.CURRENCY_RATE_TOO_LOW;
  if (hi > 0 && r > hi) return M.CURRENCY_RATE_TOO_HIGH;
  return null;
}

/**
 * Combined guard: fetches the currency row and validates the rate against
 * its SARS1/SARS2 bounds. Returns Arabic error string or `null`.
 */
export async function ensureRateInBounds(
  schema: string,
  noaml: number,
  rate: number,
): Promise<string | null> {
  if (Number(noaml) === 1) return null; // base currency — rate irrelevant
  const cur = await getCurrency(schema, noaml);
  return validateRate(rate, cur);
}
