/**
 * Shared validation helpers reused across the translated backend.
 *
 * All helpers return `null` on success, or an Arabic error string on failure.
 */

import { queryOn } from './db';

/** Reject dates after today. */
export function ensureNotFutureDate(value: unknown): string | null {
  if (!value) return 'يجب إدخال التاريخ';
  const d = new Date(String(value));
  if (isNaN(d.getTime())) return 'التاريخ غير صحيح';
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  return d > today ? 'التاريخ المدخل أكبر من تاريخ الجهاز' : null;
}

function atStartOfDay(value: Date): Date {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Legacy TITL.INSDS rule:
 * when INSDS = 0, non-admin users cannot save a voucher with a past date.
 */
export async function ensureLegacyBackDateAllowed(
  schema: string,
  recordDate: unknown,
  isAdmin = false,
): Promise<string | null> {
  if (isAdmin || !recordDate) return null;

  const d = new Date(String(recordDate));
  if (isNaN(d.getTime())) return null;

  const rows = await queryOn<{ INSDS: number | null }>(
    schema,
    `SELECT MAX(NVL(insds,0)) AS insds FROM titl`,
  );
  const insds = Number(rows[0]?.INSDS ?? 0);
  if (insds > 0) return null;

  const recordDay = atStartOfDay(d).getTime();
  const today = atStartOfDay(new Date()).getTime();
  return recordDay < today ? 'لا يمكن إدخال تاريخ سابق حسب الإعدادات الأساسية' : null;
}

/** Ensures a visible voucher number is unique in the target table. */
export async function ensureNomsUnique(
  schema: string,
  table: string,
  noms: number,
  excludeNos?: number,
): Promise<string | null> {
  const tbl = table.replace(/[^A-Za-z0-9_]/g, '');
  const sql = excludeNos
    ? `SELECT COUNT(*) AS c FROM ${tbl} WHERE noms = :n AND nos <> :nos`
    : `SELECT COUNT(*) AS c FROM ${tbl} WHERE noms = :n`;
  const binds: Record<string, unknown> = excludeNos ? { n: noms, nos: excludeNos } : { n: noms };
  const rows = await queryOn<{ C: number }>(schema, sql, binds);
  const count = Number(rows[0]?.C ?? 0);
  return count > 0 ? 'رقم السند المدخل مقيد من قبل' : null;
}

/** Prevent editing/deleting posted records.
 *
 * Legacy HMS procedure displays:
 *   MRHL = 0  -> مستند مرحل
 *   MRHL <> 0 -> مستند غير مرحل
 *
 * Full legacy MORNOM locking also checks TITL.SANDT. Use the server route
 * helper when the caller must mirror that exact edit/delete behavior.
 */
export function ensureNotPosted(mrhl: unknown, op: 'تعديل' | 'حذف' = 'تعديل'): string | null {
  const v = Number(mrhl ?? 0);
  return v === 0 ? `لا يمكن ${op} مستند مرحل، يجب الغاء الترحيل اولا` : null;
}

/** Returns the latest AKFA closure date, or null when unavailable. */
export async function getAkfaMaxDate(schema: string): Promise<Date | null> {
  try {
    const rows = await queryOn<{ D: Date | null }>(
      schema,
      `SELECT MAX(dates) AS d FROM akfa`,
    );
    return rows[0]?.D ?? null;
  } catch {
    return null;
  }
}

/** Guard against modifying records before the AKFA closure date. */
export async function ensureAkfaNotClosed(
  schema: string,
  recordDate: unknown,
  op: 'تعديل' | 'حذف' = 'تعديل',
): Promise<string | null> {
  if (!recordDate) return null;
  const akfaMax = await getAkfaMaxDate(schema);
  if (!akfaMax) return null;
  const d = new Date(String(recordDate));
  if (isNaN(d.getTime())) return null;
  if (d <= akfaMax) {
    const ymd = akfaMax.toISOString().slice(0, 10);
    return `لقد تم اقفال فوارق العملة حتى تاريخ ${ymd} - لا يمكن ال${op}`;
  }
  return null;
}
