/**
 * Date helpers — MOYE (closed months) + KDAY (holidays) + Hijri.
 *
 * Reproduces the legacy POLICY / SEASONS / KDAY behaviors:
 *   - POLICY.MOYE stores the last closed month as YYYYMM. Dates whose YYYYMM
 *     is <= POLICY.MOYE cannot be used for new voucher entry.
 *   - KDAY holds official holidays (YYYY-MM-DD). Entries are still *allowed*
 *     here, but the UI warns the user.
 *
 * All helpers return `null` on success, or an Arabic error string on failure
 * (consistent with validation.ts).
 */

import { queryOn } from './db';
import { M } from './messages';

// ════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════

/** Result for the holiday check — `name` is the holiday label if hit. */
export interface HolidayCheck {
  isHoliday: boolean;
  name:      string | null;
}

// ════════════════════════════════════════════════════════
// POLICY.MOYE — closed-month guard
// ════════════════════════════════════════════════════════

/**
 * Reads POLICY.MOYE (YYYYMM of the last closed month).
 *
 * Returns `null` when POLICY is empty, MOYE is null, or the table is missing.
 * Callers should treat null as "no closure defined — everything allowed".
 */
export async function getClosedMonth(schema: string): Promise<number | null> {
  try {
    const rows = await queryOn<{ MOYE: number | null }>(
      schema,
      `SELECT moye FROM policy WHERE ROWNUM = 1`,
    );
    const v = rows[0]?.MOYE;
    return v == null ? null : Number(v);
  } catch {
    return null;
  }
}

/**
 * Guard: the given date must be AFTER the POLICY.MOYE cutoff (i.e. in an
 * open month). Returns Arabic error on violation.
 *
 * A date whose YYYYMM == POLICY.MOYE is considered *closed* (legacy match).
 */
export async function ensureMonthOpen(
  schema: string,
  value: unknown,
): Promise<string | null> {
  if (!value) return null;
  const d = new Date(String(value));
  if (isNaN(d.getTime())) return null;
  const cutoff = await getClosedMonth(schema);
  if (cutoff == null) return null;
  const ym = d.getFullYear() * 100 + (d.getMonth() + 1);
  return ym <= cutoff ? M.DATE_MONTH_CLOSED : null;
}

// ════════════════════════════════════════════════════════
// KDAY — holiday warning (soft check)
// ════════════════════════════════════════════════════════

/**
 * Returns whether the given date falls in the KDAY holiday table.
 *
 * Unlike MOYE, this is a *soft* check — the legacy system lets you record
 * vouchers on holidays after the user confirms. The client can decide
 * whether to warn or hard-block based on this result.
 */
export async function checkHoliday(
  schema: string,
  value: unknown,
): Promise<HolidayCheck> {
  if (!value) return { isHoliday: false, name: null };
  const d = new Date(String(value));
  if (isNaN(d.getTime())) return { isHoliday: false, name: null };
  try {
    const rows = await queryOn<{ NAMEA: string | null }>(
      schema,
      `SELECT namea FROM kday WHERE TRUNC(dates) = TRUNC(:d)`,
      { d },
    );
    const hit = rows[0];
    return hit ? { isHoliday: true, name: hit.NAMEA ?? 'إجازة' } : { isHoliday: false, name: null };
  } catch {
    return { isHoliday: false, name: null }; // KDAY table missing — ignore
  }
}

// ════════════════════════════════════════════════════════
// Hijri conversion (for display only)
// ════════════════════════════════════════════════════════

/**
 * Converts a Gregorian date to Hijri using Intl.DateTimeFormat.
 * Uses Umm al-Qura (the calendar officially adopted in Saudi Arabia/Yemen).
 *
 * Returns `yyyy-mm-dd` in Hijri digits (Arabic-Indic), matching the legacy
 * display. If conversion fails we return `null` so callers can fall back.
 */
export function toHijri(date: Date): string | null {
  try {
    const fmt = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura', {
      year:  'numeric',
      month: '2-digit',
      day:   '2-digit',
    });
    return fmt.format(date);
  } catch {
    return null;
  }
}

/**
 * Convenience: returns the YYYYMM integer for a date (useful for MOYE
 * comparisons outside of ensureMonthOpen).
 */
export function yyyymm(date: Date): number {
  return date.getFullYear() * 100 + (date.getMonth() + 1);
}
