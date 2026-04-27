/**
 * Shared account-lookup + validation helpers.
 *
 * Mirrors the `data_ac` logic embedded across legacy Forms: when a user enters
 * a NOA (account number) we must:
 *   1. Confirm the row exists in DATA_AC
 *   2. Ensure it's a *leaf* account (RTBA = 5 — terminal level)
 *   3. Ensure it's not frozen (TWKFX in (1,2,3) restricts movement)
 *   4. If a currency was entered, confirm it's allowed via DATA_ACM (SNF)
 *
 * All public helpers return `null` on success or an Arabic error string.
 * This contract lets callers stay terse:
 *
 *   const err = await ensureAccountUsable(schema, noa, noaml);
 *   if (err) return c.json({ ok: false, error: err }, 422);
 */

import { queryOn } from './db';
import { M } from './messages';

// ════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════

/** Minimal projection of DATA_AC used by lookups. */
export interface AccountRow {
  NOA:   number;
  NAMEA: string;
  RTBA:  number;                    // 1..5 — depth level (5 = leaf)
  TYPEA: number;                    // parent NOA
  TWKFX: number | null;             // 0=none, 1=ceiling, 2=partial, 3=full freeze
  AHSAR: string | null;             // shortcut / alias
  AMLHH: number | null;             // default currency
  NOSNDOK: number | null;           // cashbox number (NOT NULL for cashbox accounts)
}

// ════════════════════════════════════════════════════════
// Core lookups
// ════════════════════════════════════════════════════════

/**
 * Fetches a single account by NOA. Returns `null` when missing.
 * Cached per-request by the caller — we don't add server-side caching here
 * because account data can change (freezes, renames) during a session.
 */
export async function getAccount(
  schema: string,
  noa: number,
): Promise<AccountRow | null> {
  const n = Number(noa);
  if (!n) return null;
  const rows = await queryOn<AccountRow>(
    schema,
    `SELECT noa, namea, rtba, typea, twkfx, ahsar, amlhh, nosndok
       FROM data_ac
      WHERE noa = :n`,
    { n },
  );
  return rows[0] ?? null;
}

/**
 * Returns the account name (NAMEA), or `null` if the NOA doesn't exist.
 * Cheap version of {@link getAccount} that skips other columns.
 */
export async function getAccountName(
  schema: string,
  noa: number,
): Promise<string | null> {
  const n = Number(noa);
  if (!n) return null;
  const rows = await queryOn<{ NAMEA: string }>(
    schema,
    `SELECT namea FROM data_ac WHERE noa = :n`,
    { n },
  );
  return rows[0]?.NAMEA ?? null;
}

// ════════════════════════════════════════════════════════
// Validation guards
// ════════════════════════════════════════════════════════

/**
 * Full usability guard — the check every voucher insert/update should run
 * before writing a row that references this NOA.
 *
 * Rules (in order, first failure returned):
 *   1. NOA must map to an existing row     → ACCOUNT_NOT_FOUND
 *   2. Row must be a leaf (RTBA = 5)       → ACCOUNT_NOT_LEAF
 *   3. TWKFX must be 0 (any freeze blocks) → ACCOUNT_FROZEN
 *   4. If `noaml` provided, currency must be allowed in SNF
 *
 * Pass `requireLeaf=false` for master-data screens that legitimately operate
 * on parent accounts (e.g. TREE edit).
 */
export async function ensureAccountUsable(
  schema: string,
  noa: number,
  noaml?: number | null,
  opts: { requireLeaf?: boolean } = {},
): Promise<string | null> {
  const requireLeaf = opts.requireLeaf !== false;
  const acc = await getAccount(schema, noa);
  if (!acc) return M.ACCOUNT_NOT_FOUND;
  if (requireLeaf && Number(acc.RTBA) !== 5) return M.ACCOUNT_NOT_LEAF;
  if (Number(acc.TWKFX ?? 0) > 0) return M.ACCOUNT_FROZEN;
  if (noaml && Number(noaml) > 0) {
    const ok = await isCurrencyAllowed(schema, noa, Number(noaml));
    if (!ok) return M.ACCOUNT_CURRENCY_NOT_ALLOWED;
  }
  return null;
}

/**
 * True if the (NOA, NOAML) pair is allowed per the SNF restrictions.
 *
 * SNF rules (from legacy screens):
 *   - If no SNF row exists for (NOA, NOAML) → check AMLHH (default currency)
 *     If AMLHH == NOAML → allowed; otherwise → blocked.
 *   - If SNF row exists with HLS > 0 → blocked (explicit stop)
 *   - Otherwise → allowed.
 */
export async function isCurrencyAllowed(
  schema: string,
  noa: number,
  noaml: number,
): Promise<boolean> {
  const rows = await queryOn<{ HLS: number | null; AMLHH: number | null }>(
    schema,
    `
    SELECT snf.hls AS hls, ac.amlhh AS amlhh
      FROM data_ac ac
      LEFT JOIN data_acm snf
        ON snf.noa   = ac.noa
       AND snf.noaml = :m
     WHERE ac.noa = :n
    `,
    { n: noa, m: noaml },
  );
  const row = rows[0];
  if (!row) return false; // account doesn't exist at all
  // If there is an explicit SNF row, honor its HLS flag.
  if (row.HLS !== null) return Number(row.HLS) === 0;
  // Otherwise fall back to the account default currency.
  return Number(row.AMLHH ?? 0) === Number(noaml);
}

// ════════════════════════════════════════════════════════
// Batched loader (for voucher screens listing many NOAs)
// ════════════════════════════════════════════════════════

/**
 * Fetches the NAMEA for a list of NOAs in a single round-trip.
 * Returns a Map for O(1) template lookups.
 *
 * Chunks the input into pieces of <= 900 so we never exceed Oracle's
 * 1000-value IN-list limit even with overhead.
 */
export async function getAccountNamesBatch(
  schema: string,
  noas: readonly number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const clean = Array.from(new Set(noas.map(Number).filter(n => n > 0)));
  const CHUNK = 900;
  for (let i = 0; i < clean.length; i += CHUNK) {
    const slice = clean.slice(i, i + CHUNK);
    if (slice.length === 0) continue;
    const placeholders = slice.map((_, j) => `:n${j}`).join(',');
    const binds: Record<string, number> = {};
    slice.forEach((n, j) => { binds['n' + j] = n; });
    const rows = await queryOn<{ NOA: number; NAMEA: string }>(
      schema,
      `SELECT noa, namea FROM data_ac WHERE noa IN (${placeholders})`,
      binds,
    );
    for (const r of rows) out.set(Number(r.NOA), String(r.NAMEA));
  }
  return out;
}
