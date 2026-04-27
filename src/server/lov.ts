/**
 * Central Lookup-of-Values (LOV) service.
 *
 * Every picker/autocomplete in the UI used to hit a bespoke endpoint:
 *   /api/data_ac, /api/data_aml, /api/cashboxes, …
 *
 * This file replaces all of them with one registry + one executor. Front-end
 * code hits `GET /api/lov/:name?q=<filter>&limit=50` and the backend:
 *
 *   1. Looks up the LovDefinition in LOV_REGISTRY
 *   2. Binds `:q` (uppercased, trimmed) into the query
 *   3. Runs it against the caller's schema (`unit` → DATAAL<X>`)
 *   4. Returns `{ ok, rows, columns, display }`
 *
 * Adding a new LOV = adding an entry here. No code elsewhere changes.
 */

import { queryOn } from './db';

// ════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════

export interface LovDefinition {
  /** Stable name used in the URL (e.g. "account-leaf"). */
  name: string;

  /** Short Arabic label surfaced in the picker header. */
  label: string;

  /** Optional Lucide-like icon ID for the LovPicker UI. */
  icon?: string;

  /**
   * SQL SELECT that must:
   *   - expose at least `NOA`/`NO`/`CODE` + a display column
   *   - accept `:q` as a case-insensitive filter (use `UPPER(...) LIKE :q`)
   *   - cap rows via `ROWNUM <= :lim` (Oracle 10g compatible — no FETCH FIRST).
   *
   * Recommended shape:
   *     SELECT * FROM (
   *       SELECT ... FROM tab WHERE ... ORDER BY ...
   *     ) WHERE ROWNUM <= :lim
   */
  query: string;

  /** Columns to surface in the JSON response (UPPER-CASE Oracle keys). */
  columns: readonly string[];

  /** Column name the UI should display as the "name" of each row. */
  display: string;

  /**
   * Optional extra binds — used when a LOV needs context (e.g. account
   * currencies filtered by a NOA already chosen upstream).
   */
  extraBinds?: readonly string[];
}

/** Result of a LOV execution. */
export interface LovResult {
  name:    string;
  columns: readonly string[];
  display: string;
  rows:    Array<Record<string, unknown>>;
}

// ════════════════════════════════════════════════════════
// Registry — 16 LOVs covering the most frequent pickers
// ════════════════════════════════════════════════════════

export const LOV_REGISTRY: Record<string, LovDefinition> = {
  // ── Accounts ─────────────────────────────────────────
  'account': {
    name: 'account', label: 'دليل الحسابات', icon: 'pi-sitemap',
    query: `SELECT * FROM (
              SELECT noa, namea, rtba, typea,
                     NVL(amlhh,1) AS amlhh,
                     NVL(amlhh,1) AS noaml,
                     ahsar, nosndok
                FROM data_ac
               WHERE (:rtba IS NULL OR rtba = :rtba)
                 AND (:q IS NULL
                      OR UPPER(namea) LIKE :q
                      OR TO_CHAR(noa) LIKE :q
                      OR UPPER(NVL(ahsar,'_')) LIKE :q)
               ORDER BY rtba, noa
            ) WHERE ROWNUM <= :lim`,
    columns: ['NOA', 'NAMEA', 'RTBA', 'TYPEA', 'AMLHH', 'NOAML', 'AHSAR', 'NOSNDOK'],
    display: 'NAMEA',
    extraBinds: ['rtba'],
  },
  'account-leaf': {
    name: 'account-leaf', label: 'حسابات فرعية', icon: 'pi-bookmark',
    query: `SELECT * FROM (
              SELECT noa, namea, typea,
                     NVL(amlhh,1) AS amlhh,
                     NVL(amlhh,1) AS noaml,
                     ahsar, nosndok
                FROM data_ac
               WHERE rtba = 5
                 AND NVL(twkfx,0) = 0
                 AND (:q IS NULL
                      OR UPPER(namea) LIKE :q
                      OR TO_CHAR(noa) LIKE :q
                      OR UPPER(NVL(ahsar,'_')) LIKE :q)
               ORDER BY noa
            ) WHERE ROWNUM <= :lim`,
    columns: ['NOA', 'NAMEA', 'TYPEA', 'AMLHH', 'NOAML', 'AHSAR', 'NOSNDOK'],
    display: 'NAMEA',
  },
  'account-cashbox': {
    name: 'account-cashbox', label: 'الصناديق', icon: 'pi-wallet',
    query: `SELECT * FROM (
              SELECT noa, namea,
                     nosndok AS nosn,
                     nosndok,
                     NVL(amlhh,1) AS amlhh,
                     NVL(amlhh,1) AS noaml,
                     NVL(typea,0) AS typea
                FROM data_ac
               WHERE nosndok IS NOT NULL
                 AND (:q IS NULL
                      OR UPPER(namea) LIKE :q
                      OR TO_CHAR(noa) LIKE :q
                      OR TO_CHAR(nosndok) LIKE :q)
               ORDER BY nosndok, noa
            ) WHERE ROWNUM <= :lim`,
    columns: ['NOA', 'NAMEA', 'NOSN', 'NOSNDOK', 'AMLHH', 'NOAML', 'TYPEA'],
    display: 'NAMEA',
  },

  // ── Currencies ───────────────────────────────────────
  'currency': {
    name: 'currency', label: 'العملات', icon: 'pi-dollar',
    query: `SELECT * FROM (
              SELECT no, namem3, NVL(sars,1) AS sars, NVL(sars1,0) AS sars1, NVL(sars2,0) AS sars2
                FROM amlh
               WHERE :q IS NULL
                  OR UPPER(namem3) LIKE :q
                  OR TO_CHAR(no) LIKE :q
               ORDER BY no
            ) WHERE ROWNUM <= :lim`,
    columns: ['NO', 'NAMEM3', 'SARS', 'SARS1', 'SARS2'],
    display: 'NAMEM3',
  },

  // ── Cost centers / projects ──────────────────────────
  'cost-center': {
    name: 'cost-center', label: 'مراكز التكلفة', icon: 'pi-compass',
    query: `SELECT * FROM (
              SELECT nos, namem
                FROM mrt
               WHERE :q IS NULL
                  OR UPPER(namem) LIKE :q
                  OR TO_CHAR(nos) LIKE :q
               ORDER BY nos
            ) WHERE ROWNUM <= :lim`,
    columns: ['NOS', 'NAMEM'],
    display: 'NAMEM',
  },

  // ── Users ────────────────────────────────────────────
  'user': {
    name: 'user', label: 'المستخدمون', icon: 'pi-user',
    query: `SELECT * FROM (
              SELECT nou, nameu, NVL(statu,0) AS statu
                FROM user_u
               WHERE :q IS NULL
                  OR UPPER(nameu) LIKE :q
                  OR TO_CHAR(nou) LIKE :q
               ORDER BY statu DESC, nou
            ) WHERE ROWNUM <= :lim`,
    columns: ['NOU', 'NAMEU', 'STATU'],
    display: 'NAMEU',
  },

  // ── Account shortcuts (AHTSR) ────────────────────────
  'shortcut': {
    name: 'shortcut', label: 'اختصارات', icon: 'pi-bolt',
    query: `SELECT * FROM (
              SELECT aht, baht
                FROM ahtsr
               WHERE :q IS NULL
                  OR UPPER(aht)  LIKE :q
                  OR UPPER(baht) LIKE :q
               ORDER BY aht
            ) WHERE ROWNUM <= :lim`,
    columns: ['AHT', 'BAHT'],
    display: 'AHT',
  },
};

// ────────────────────────────────────────────────────────
// Legacy aliases — keep old frontends (SNDS/SNDK/TREE) working
// after the old bespoke /api/lov/:name route has been removed.
// Each alias maps the plural/alternate name to the canonical entry.
// ────────────────────────────────────────────────────────
const LEGACY_ALIASES: Record<string, string> = {
  'accounts':     'account',
  'currencies':   'currency',
  'cashboxes':    'account-cashbox',
  'cost-centers': 'cost-center',
  'users':        'user',
  'shortcuts':    'shortcut',
};
for (const [alias, target] of Object.entries(LEGACY_ALIASES)) {
  const def = LOV_REGISTRY[target];
  if (def) LOV_REGISTRY[alias] = { ...def, name: alias };
}

// ════════════════════════════════════════════════════════
// Executor
// ════════════════════════════════════════════════════════

/**
 * Runs a LOV query against the caller's schema and returns the result.
 *
 * The filter `q` is:
 *   - trimmed + uppercased
 *   - wrapped in `%…%` so LIKE works naturally
 *   - passed as NULL when empty so the "WHERE :q IS NULL" shortcut kicks in
 *
 * `limit` is clamped to [1, 500] to protect the DB.
 */
export async function executeLov(
  schema: string,
  name: string,
  q: string,
  limit: number,
  extra: Record<string, unknown> = {},
): Promise<LovResult> {
  const def = LOV_REGISTRY[name];
  if (!def) throw new Error(`unknown lov: ${name}`);

  const qTrim = String(q || '').trim();
  const qBind = qTrim ? `%${qTrim.toUpperCase()}%` : null;
  const lim   = Math.max(1, Math.min(500, Number(limit) || 50));

  const binds: Record<string, unknown> = { q: qBind, lim };
  for (const key of def.extraBinds ?? []) {
    if (key in extra) binds[key] = extra[key];
  }

  const rows = await queryOn<Record<string, unknown>>(schema, def.query, binds);
  return {
    name:    def.name,
    columns: def.columns,
    display: def.display,
    rows,
  };
}

/**
 * Lightweight catalog surfaced at `GET /api/lov` — lets the UI build menus.
 *
 * Legacy aliases (e.g. `accounts` → `account`) are filtered out so the
 * catalog exposes only the canonical, singular names. Aliases remain
 * resolvable via {@link executeLov} for backwards compatibility.
 */
export function listLovs(): Array<Pick<LovDefinition, 'name' | 'label' | 'icon'>> {
  const aliases = new Set(Object.keys(LEGACY_ALIASES));
  return Object.entries(LOV_REGISTRY)
    .filter(([key]) => !aliases.has(key))
    .map(([, d]) => ({ name: d.name, label: d.label, icon: d.icon }));
}
