/**
 * Permission service — mirrors the original USERGN permission-matrix logic
 * used throughout every Oracle Forms screen:
 *
 *   SELECT MAX(NOA) INTO XNOPR
 *     FROM DATA_ACM WHERE UPPER(NAMEF) = UPPER(:screen_name);
 *
 *   SELECT MAX(INS), MAX(ED), MAX(DE), MAX(SAR), MAX(PR), MAX(SAA), ...
 *     INTO   XINS, XED, XDE, XSAR, XPR, XSAA, ...
 *     FROM   USERGN
 *    WHERE   NOU = :global.nou
 *      AND   NVL(NOPR,0) = NVL(XNOPR,0);
 *
 *   IF :global.STATU > 0 THEN
 *     -- super-admin bypass: all permissions = 4 (full)
 *   END IF;
 *
 * Permission columns in USERGN (0 = denied, non-zero = granted; 4 = full):
 *   INS   → INSERT
 *   ED    → EDIT / UPDATE
 *   DE    → DELETE
 *   PR    → PRINT
 *   SAR   → show cost-currency rate
 *   SAA   → show cost-currency amount
 *   SARB  → show sell-price
 *   HS1   → custom report access 1
 *   HS2   → custom report access 2
 *   FNKD  → flag (screen-specific)
 *
 * A 5-minute in-memory cache keyed by (schema, nou, screen) avoids hammering
 * the DB for every mutation request.
 */

import { queryOn } from './db';
import type { SessionUser } from './auth';

/** The full set of USERGN permission flags. */
export interface Permissions {
  ins:  number;  // INSERT
  ed:   number;  // EDIT
  de:   number;  // DELETE
  pr:   number;  // PRINT
  sar:  number;  // cost-currency rate
  saa:  number;  // cost amount
  sarb: number;  // sell price
  hs1:  number;
  hs2:  number;
  fnkd: number;
}

export const NO_PERMS: Readonly<Permissions> = Object.freeze({
  ins: 0, ed: 0, de: 0, pr: 0, sar: 0, saa: 0, sarb: 0, hs1: 0, hs2: 0, fnkd: 0,
});

export const FULL_PERMS: Readonly<Permissions> = Object.freeze({
  ins: 4, ed: 4, de: 4, pr: 4, sar: 4, saa: 4, sarb: 4, hs1: 4, hs2: 4, fnkd: 4,
});

// ── cache ───────────────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;
interface CacheEntry { perms: Permissions; expiresAt: number; }
const cache = new Map<string, CacheEntry>();

function cacheKey(schema: string, nou: number, screen: string): string {
  return `${schema}::${nou}::${screen.toUpperCase()}`;
}

/**
 * Clear cached permissions. Call this after user-role changes (e.g. from
 * the admin screens) to force re-fetching.
 */
export function clearPermissionCache(user?: SessionUser): void {
  if (!user) { cache.clear(); return; }
  const prefix = `${user.schema}::${user.nou}::`;
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

/**
 * Looks up the permission row for (user, screen) from USERGN, mirroring the
 * original Oracle Forms PRE-FORM trigger.
 *
 * @param screen  The NAMEF as stored in DATA_ACM (e.g. 'TREE.FMX', 'SNDK.FMX')
 */
export async function getPermissions(
  user: SessionUser,
  screen: string,
): Promise<Permissions> {
  // Super-admin bypass — exactly matches `IF :global.STATU > 0 THEN XINS:=4`
  if (user.isAdmin) return { ...FULL_PERMS };

  const key = cacheKey(user.schema, user.nou, screen);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.perms;

  try {
    const rows = await queryOn<{
      INS: number | null; ED: number | null; DE: number | null; PR: number | null;
      SAR: number | null; SAA: number | null; SARB: number | null;
      HS1: number | null; HS2: number | null; FNKD: number | null;
    }>(user.schema, `
      SELECT MAX(u.ins)  AS ins,  MAX(u.ed)   AS ed,   MAX(u.de)   AS de,
             MAX(u.pr)   AS pr,   MAX(u.sar)  AS sar,  MAX(u.saa)  AS saa,
             MAX(u.sarb) AS sarb, MAX(u.hs1)  AS hs1,  MAX(u.hs2)  AS hs2,
             MAX(u.fnkd) AS fnkd
        FROM usergn u
        JOIN data_acm a ON NVL(u.nopr,0) = NVL(a.noa,0)
       WHERE u.nou = :nou
         AND UPPER(a.namef) = UPPER(:sc)
    `, { nou: user.nou, sc: screen });

    const r = rows[0];
    const perms: Permissions = r ? {
      ins:  Number(r.INS  ?? 0),
      ed:   Number(r.ED   ?? 0),
      de:   Number(r.DE   ?? 0),
      pr:   Number(r.PR   ?? 0),
      sar:  Number(r.SAR  ?? 0),
      saa:  Number(r.SAA  ?? 0),
      sarb: Number(r.SARB ?? 0),
      hs1:  Number(r.HS1  ?? 0),
      hs2:  Number(r.HS2  ?? 0),
      fnkd: Number(r.FNKD ?? 0),
    } : { ...NO_PERMS };

    cache.set(key, { perms, expiresAt: now + CACHE_TTL_MS });
    return perms;
  } catch {
    // If DATA_ACM or USERGN is missing (e.g. in a stripped test schema),
    // fall back to deny-all so a mis-configured environment never accidentally
    // grants access. Super-admins are already handled above.
    return { ...NO_PERMS };
  }
}

/**
 * Guard: throw/return an Arabic error if the user lacks the requested action
 * on the given screen. Returns null on success.
 */
export async function ensurePermission(
  user: SessionUser,
  screen: string,
  action: keyof Permissions,
): Promise<string | null> {
  const p = await getPermissions(user, screen);
  if (p[action] > 0) return null;

  const labels: Record<keyof Permissions, string> = {
    ins:  'الإضافة',
    ed:   'التعديل',
    de:   'الحذف',
    pr:   'الطباعة',
    sar:  'عرض سعر صرف التكلفة',
    saa:  'عرض مبلغ التكلفة',
    sarb: 'عرض سعر البيع',
    hs1:  'الصلاحية الخاصة 1',
    hs2:  'الصلاحية الخاصة 2',
    fnkd: 'الصلاحية المحدودة',
  };
  return `ليس لديك صلاحية ${labels[action]} في هذه الشاشة`;
}
