/**
 * Sequence helpers — per-year auto-numbering for vouchers.
 *
 * Oracle Forms screens compute the next NOS via two columns:
 *   - NOSON  = yearly sequence (1, 2, 3, …)
 *   - NOS    = (NOSON * 10000) + (YY) — e.g. NOSON=15, DATES=2026-04-19 → NOS=150026
 *
 * Original PL/SQL (from SNDK/SNDS pre-insert):
 *   select nvl(max(noson),0)+1 into :sndk.noson
 *     from sndk
 *     where to_char(dates,'YYYY') = to_char(:sndk.dates,'YYYY');
 *   :sndk.nos := :sndk.noson * 10000 + to_number(to_char(:sndk.dates,'YY'));
 *
 * We reproduce the exact behavior here so the web layer produces identical
 * NOS values to legacy clients (critical for TRSND and reports).
 */

import { queryOn } from './db';

/**
 * Returns the next NOSON (per-year row number) for a voucher table.
 * Fails loudly if the table doesn't accept a `dates` column.
 */
export async function nextNoson(
  schema: string,
  table: string,
  dates: Date,
): Promise<number> {
  const tbl = table.replace(/[^A-Za-z0-9_]/g, '');
  const year = dates.getFullYear();
  const rows = await queryOn<{ N: number | null }>(
    schema,
    `SELECT NVL(MAX(noson),0) AS n FROM ${tbl} WHERE EXTRACT(YEAR FROM dates) = :y`,
    { y: year },
  );
  return Number(rows[0]?.N ?? 0) + 1;
}

/**
 * Builds the canonical NOS from a NOSON + date pair.
 * Matches the original PL/SQL formula exactly (NOSON * 10000 + YY).
 *
 * Year is the two-digit year (YY); the function accepts either a Date
 * or a 4-digit year number for convenience.
 */
export function buildNos(noson: number, dates: Date | number): number {
  const yyyy = dates instanceof Date ? dates.getFullYear() : Number(dates);
  const yy = yyyy % 100;
  return (noson * 10000) + yy;
}

/**
 * Shortcut: fetch next NOSON and compute the matching NOS atomically.
 *
 * NOTE: This is NOT transaction-safe by itself. Callers should hold a row
 * lock on the target table (e.g. via `SELECT ... FOR UPDATE` of a sentinel
 * row, or simply run inside a serializable transaction) when uniqueness
 * of NOS matters.
 */
export async function nextVoucherIds(
  schema: string,
  table: string,
  dates: Date,
): Promise<{ noson: number; nos: number }> {
  const noson = await nextNoson(schema, table, dates);
  return { noson, nos: buildNos(noson, dates) };
}

/**
 * Reserves the next NOSON/NOS using a DB sequence if one is defined.
 * Falls back to max(NOSON)+1 if the sequence is missing.
 *
 * Some legacy units have per-table sequences named `<TABLE>_SEQ`.
 * Prefer this helper when you want the DB to serialize concurrent inserts.
 */
export async function reserveVoucherIds(
  schema: string,
  table: string,
  dates: Date,
  sequenceName?: string,
): Promise<{ noson: number; nos: number }> {
  const seq = (sequenceName || '').trim();
  if (seq) {
    try {
      const rows = await queryOn<{ N: number }>(
        schema,
        `SELECT ${seq.replace(/[^A-Za-z0-9_]/g, '')}.NEXTVAL AS n FROM dual`,
      );
      const noson = Number(rows[0]?.N ?? 0);
      if (noson > 0) return { noson, nos: buildNos(noson, dates) };
    } catch {
      // Sequence missing or revoked — fall through to MAX() strategy.
    }
  }
  return nextVoucherIds(schema, table, dates);
}
