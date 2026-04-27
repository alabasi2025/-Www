/**
 * Posting service — TRSND engine.
 *
 * Replicates the original Oracle Forms `PROCEDURE TRSND(RNN NUMBER)` which,
 * for every voucher header + detail combination, generates the matching rows
 * in the DATAK journal ledger. This is the most critical procedure in the
 * system (called 50+ times across legacy Forms).
 *
 * Key mapping (from Plan §6.1 — the sign of the balance depends on typems):
 *
 *   | Doc  | TYPEMS | Master side        | Detail side            |
 *   |------|--------|--------------------|------------------------|
 *   | SNDK |   4    | DAN  = TOTALS      | MDIN = TOAM (cashbox)  |
 *   | SNDS |   5    | MDIN = TOTALS      | DAN  = TOAM (cashbox)  |
 *   | FB   |   6    | MDIN = TOTALS      | DAN  = TOAM (sales)    |
 *   | FBM  |   7    | DAN  = TOTALS      | MDIN = TOAM (returns)  |
 *   | FM   |   8    | DAN  = TOTALS      | MDIN = TOAM (inv)      |
 *   | FMM  |   9    | MDIN = TOTALS      | DAN  = TOAM (inv ret)  |
 *
 * The service is stateless — each public method opens a single oracledb
 * connection, runs its work inside one transaction, and commits on success.
 *
 * NOTE: kdant (contra-entry marker) is 0 for the master row and 1 for each
 * detail row — preserved from legacy for report filters that ignore the
 * master half when summing balances.
 */

import { createRequire } from 'node:module';
import type * as OracleDb from 'oracledb';
import { getPool } from './db';
import { buildNos, nextNoson } from './sequence';

const require = createRequire(import.meta.url);
const oracledb = require('oracledb') as typeof OracleDb;

// ════════════════════════════════════════════════════════
// TYPEMS catalog
// ════════════════════════════════════════════════════════

export const TYPEMS = {
  /** Journal entry (SNDKD) — details carry raw MDIN/DAN. */
  JOURNAL: 1,
  /**
   * Transfer entry (SNDKD2) — single row with two sides (NOA debit, NOA2 credit).
   * The DATAK view projects one row per side with typems=10; this constant is
   * only used internally for `tableForTypems` / `unpostVoucher`.
   */
  TRANSFER: 2,
  SNDK: 4,
  SNDS: 5,
  FB:   6,
  FBM:  7,
  FM:   8,
  FMM:  9,
  ATM:  10,
  ASM:  11,
  ATMM: 12,
} as const;

export type Typems = typeof TYPEMS[keyof typeof TYPEMS];

/** Maps TYPEMS → header table name. */
function tableForTypems(t: number): string {
  switch (t) {
    case TYPEMS.JOURNAL:  return 'SNDKD';
    case TYPEMS.TRANSFER: return 'SNDKD2';
    case TYPEMS.SNDK:    return 'SNDK';
    case TYPEMS.SNDS:    return 'SNDS';
    case TYPEMS.FB:      return 'FB';
    case TYPEMS.FBM:     return 'FBM';
    case TYPEMS.FM:      return 'FM';
    case TYPEMS.FMM:     return 'FMM';
    case TYPEMS.ATM:     return 'ATM';
    case TYPEMS.ASM:     return 'ASM';
    case TYPEMS.ATMM:    return 'ATMM';
    default: throw new Error('Unknown TYPEMS: ' + t);
  }
}

/** Maps TYPEMS → detail table name (same as header + "F" suffix by convention). */
function detailTableForTypems(t: number): string {
  return tableForTypems(t) + 'F';
}

// ════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════

/** Single row to be inserted into DATAK. */
export interface DatakEntry {
  noms:     number;
  typems:   number;
  noa:      number;
  datemo:   Date;
  mdin:     number;      // debit (local currency)
  dan:      number;      // credit (local currency)
  mdinaml:  number;      // debit (foreign currency)
  danaml:   number;      // credit (foreign currency)
  noaml:    number;
  sarsf:    number;
  memos:    string | null;
  mrt:      number;
  nok:      number;
  an1:      number;      // NOMSRO (project)
  kdant:    number;      // 0 = master row, 1 = detail row
  nousx:    number;
  mrhl:     number;      // always 0 when (re)posting fresh
  recno:    number;      // 0 for master, detail RECNO otherwise
}

/**
 * Master/detail shape for a journal entry (SNDKD).
 *
 * Unlike the standard voucher types, journal-entry details carry BOTH
 * MDIN and DAN directly — there is no master-side account being balanced
 * against detail-side accounts. The sum of MDIN across all details MUST
 * equal the sum of DAN; callers should enforce this before posting.
 */
export interface JournalPayload {
  master: {
    NOS:    number;
    DATES:  Date;
    MEMOS:  string | null;
    NOK:    number | null;
    NOUSX:  number;
    NOMSRO: number | null;
    TYPEMS?: number | null;
  };
  details: Array<{
    RECNO:  number;
    NOA:    number;
    MDIN:   number;
    DAN:    number;
    NOAML:  number;
    SARSF:  number | null;
    MRT:    number | null;
    MEMOS:  string | null;
    /** Foreign-currency counterparts, optional. */
    MDINAML?: number | null;
    DANAML?:  number | null;
  }>;
}

/** Master/detail shape for a voucher being posted. */
export interface VoucherPayload {
  master: {
    NOS:     number;
    DATES:   Date;
    NOA:     number;
    NOAML:   number;
    TOTALS:  number;
    TOTALS2: number | null;
    SARSFS:  number | null;
    MEMOS1:  string | null;
    MRT2:    number | null;
    NOK:     number | null;
    NOMSRO:  number | null;
    NOUSX:   number;
  };
  details: Array<{
    RECNO:   number;
    NOAF:    number;
    NOAML:   number;
    TOAM:    number;
    TOAA:    number | null;
    SARSF:   number | null;
    MRT:     number | null;
    MEMOSF:  string | null;
  }>;
}

// ════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════

/**
 * (Re)post a single voucher.
 *
 * IMPORTANT — DATAK is a UNION-ALL view over the voucher base tables
 * (SNDK/SNDKF, SNDS/SNDSF, SNDKD/SNDKDF, FB/FBF, …). It has no INSTEAD OF
 * trigger, so direct INSERT/DELETE are illegal (ORA-01732). The legacy
 * TRSND procedure mirrored this: it only flipped MRHL = 0 on the master
 * and assigned an annual NOK — the view projects the detail rows
 * automatically.
 *
 * Contract:
 *   1. Assign NOK via {@link squnx} when the master lacks one.
 *   2. Flip MRHL = 0 on the master table.
 *
 * Caller MUST have already enforced accounting invariants (balance,
 * permissions, not-future-date) at the endpoint layer.
 */
export async function postVoucher(
  schema: string,
  typems: Typems,
  payload: VoucherPayload,
): Promise<{ nok: number; rows: number }> {
  const pool = await getPool(schema);
  const conn = await pool.getConnection();
  try {
    let nok = Number(payload.master.NOK ?? 0);
    if (!nok) nok = await squnx(conn, payload.master.DATES, /*yearly=*/ 1);

    // Row count is still useful for the caller (matches what the DATAK
    // view will expose once posted); compute it without hitting the DB.
    const entries = buildEntries(typems, { ...payload, master: { ...payload.master, NOK: nok } });

    const tbl = tableForTypems(typems);
    await conn.execute(
      `UPDATE ${tbl} SET mrhl = 0, nok = :k WHERE nos = :n`,
      { k: nok, n: payload.master.NOS },
    );

    await conn.commit();
    return { nok, rows: entries.length };
  } catch (err) {
    try { await conn.rollback(); } catch { /* best-effort */ }
    throw err;
  } finally {
    await conn.close();
  }
}

/**
 * (Re)post a journal entry (SNDKD). Mirrors {@link postVoucher} but for
 * the flat-details model — still just an MRHL flip + NOK assignment.
 *
 * Caller MUST ensure `SUM(MDIN) === SUM(DAN)`.
 */
export async function postJournal(
  schema: string,
  payload: JournalPayload,
): Promise<{ nok: number; rows: number }> {
  const pool = await getPool(schema);
  const conn = await pool.getConnection();
  try {
    let nok = Number(payload.master.NOK ?? 0);
    if (!nok) nok = await squnx(conn, payload.master.DATES, /*yearly=*/ 1);

    const entries = buildJournalEntries({ ...payload, master: { ...payload.master, NOK: nok } });

    await conn.execute(
      `UPDATE SNDKD SET mrhl = 0, nok = :k WHERE nos = :n`,
      { k: nok, n: payload.master.NOS },
    );

    await conn.commit();
    return { nok, rows: entries.length };
  } catch (err) {
    try { await conn.rollback(); } catch { /* best-effort */ }
    throw err;
  } finally {
    await conn.close();
  }
}

/**
 * (Re)post a transfer entry (SNDKD2).
 *
 * SNDKD2 has a single-row-per-transfer schema (no detail table) — the DATAK
 * view projects two rows from each SNDKD2 record (`typems=10`): one debit on
 * NOA (MDIN/MDINAML, currency NOAML, rate SARSF) and one credit on NOA2
 * (DAN/DANAML, currency NOAML2, rate SARSF2). Like {@link postVoucher} and
 * {@link postJournal}, posting just assigns an annual NOK via SQUNX and
 * flips MRHL=0 on the master.
 *
 * Caller MUST ensure the row already exists and the accounting balance is
 * respected in local currency (`MDIN == DAN`).
 */
export async function postSndkd2(
  schema: string,
  nos: number,
): Promise<{ nok: number; rows: number }> {
  const pool = await getPool(schema);
  const conn = await pool.getConnection();
  try {
    // Load DATES/NOK so SQUNX has a year to key off.
    const r = await conn.execute<{DATES: Date; NOK: number | null}>(
      `SELECT dates, nok FROM SNDKD2 WHERE nos = :n`,
      { n: nos },
      { outFormat: 4002 },
    );
    const row = (r.rows as {DATES: Date; NOK: number | null}[])[0];
    if (!row) throw new Error('SNDKD2 record not found: ' + nos);

    let nok = Number(row.NOK ?? 0);
    if (!nok) nok = await squnx(conn, row.DATES, /*yearly=*/ 1);

    await conn.execute(
      `UPDATE SNDKD2 SET mrhl = 0, nok = :k WHERE nos = :n`,
      { k: nok, n: nos },
    );

    await conn.commit();
    // Every SNDKD2 row produces exactly 2 DATAK rows (debit + credit).
    return { nok, rows: 2 };
  } catch (err) {
    try { await conn.rollback(); } catch { /* best-effort */ }
    throw err;
  } finally {
    await conn.close();
  }
}

/**
 * Unpost — flip MRHL to 1 on the master (legacy "غير مرحل").
 *
 * Safe to call when the voucher isn't posted (the update just no-ops).
 */
export async function unpostVoucher(
  schema: string,
  typems: Typems,
  nos: number,
): Promise<{ deleted: number }> {
  const pool = await getPool(schema);
  const conn = await pool.getConnection();
  try {
    const tbl = tableForTypems(typems);
    const upd = await conn.execute(
      `UPDATE ${tbl} SET mrhl = 1 WHERE nos = :n`,
      { n: nos },
    );
    await conn.commit();
    return { deleted: Number(upd.rowsAffected ?? 0) };
  } catch (err) {
    try { await conn.rollback(); } catch { /* best-effort */ }
    throw err;
  } finally {
    await conn.close();
  }
}

/**
 * Pure helper: build the journal entries for a voucher payload.
 * Exposed so unit tests can verify TRSND math without hitting Oracle.
 */
export function buildEntries(
  typems: Typems,
  payload: VoucherPayload & { master: VoucherPayload['master'] & { NOK: number } },
): DatakEntry[] {
  const m = payload.master;
  const masterDebits = isMasterDebit(typems);

  const out: DatakEntry[] = [];

  // Master row — side depends on typems
  out.push({
    noms:     m.NOS,
    typems,
    noa:      m.NOA,
    datemo:   m.DATES,
    mdin:     masterDebits ? Number(m.TOTALS) : 0,
    dan:      masterDebits ? 0 : Number(m.TOTALS),
    mdinaml:  masterDebits ? Number(m.TOTALS2 ?? 0) : 0,
    danaml:   masterDebits ? 0 : Number(m.TOTALS2 ?? 0),
    noaml:    Number(m.NOAML),
    sarsf:    Number(m.SARSFS ?? 0),
    memos:    m.MEMOS1,
    mrt:      Number(m.MRT2 ?? 0),
    nok:      m.NOK,
    an1:      Number(m.NOMSRO ?? 0),
    kdant:    0,
    nousx:    m.NOUSX,
    mrhl:     0,
    recno:    0,
  });

  // Detail rows — opposite side of master
  for (const d of payload.details) {
    out.push({
      noms:     m.NOS,
      typems,
      noa:      d.NOAF,
      datemo:   m.DATES,
      mdin:     masterDebits ? 0 : Number(d.TOAM),
      dan:      masterDebits ? Number(d.TOAM) : 0,
      mdinaml:  masterDebits ? 0 : Number(d.TOAA ?? 0),
      danaml:   masterDebits ? Number(d.TOAA ?? 0) : 0,
      noaml:    Number(d.NOAML),
      sarsf:    Number(d.SARSF ?? m.SARSFS ?? 0),
      memos:    d.MEMOSF ?? m.MEMOS1,
      mrt:      Number(d.MRT ?? 0),
      nok:      m.NOK,
      an1:      Number(m.NOMSRO ?? 0),
      kdant:    1,
      nousx:    m.NOUSX,
      mrhl:     0,
      recno:    Number(d.RECNO),
    });
  }

  return out;
}

/**
 * Pure helper for journal entries (SNDKD) — every detail becomes one DATAK
 * row, carrying its own MDIN/DAN directly (no master-side accounting).
 *
 * Exposed for unit testing.
 */
export function buildJournalEntries(
  payload: JournalPayload & { master: JournalPayload['master'] & { NOK: number } },
): DatakEntry[] {
  const m = payload.master;
  const typems = Number(m.TYPEMS ?? TYPEMS.JOURNAL);
  const safeTypems = typems > 0 ? typems : TYPEMS.JOURNAL;
  return payload.details.map(d => ({
    noms:    m.NOS,
    typems:  safeTypems,
    noa:     Number(d.NOA),
    datemo:  m.DATES,
    mdin:    Number(d.MDIN ?? 0),
    dan:     Number(d.DAN ?? 0),
    mdinaml: Number(d.MDINAML ?? d.MDIN ?? 0),
    danaml:  Number(d.DANAML  ?? d.DAN  ?? 0),
    noaml:   Number(d.NOAML),
    sarsf:   Number(d.SARSF ?? 0),
    memos:   d.MEMOS ?? m.MEMOS,
    mrt:     Number(d.MRT ?? 0),
    nok:     m.NOK,
    an1:     Number(m.NOMSRO ?? 0),
    kdant:   1,
    nousx:   m.NOUSX,
    mrhl:    0,
    recno:   Number(d.RECNO),
  }));
}

/**
 * Returns true when the master account of the given voucher type is *debited*
 * (and therefore details are credited). Matches the accounting direction
 * table in Plan §6.1 exactly.
 */
function isMasterDebit(typems: Typems): boolean {
  switch (typems) {
    case TYPEMS.SNDK: return false; // master = payer → CREDIT
    case TYPEMS.SNDS: return true;  // master = beneficiary → DEBIT
    case TYPEMS.FB:   return true;  // master = customer → DEBIT (receivable)
    case TYPEMS.FBM:  return false; // master = customer → CREDIT (return)
    case TYPEMS.FM:   return false; // master = supplier → CREDIT (payable)
    case TYPEMS.FMM:  return true;  // master = supplier → DEBIT (return)
    default: return true;
  }
}

/**
 * SQUNX generates the next legacy journal number.
 *
 * The old DB function compares the document year with :global.yearhly:
 * future-year entries advance SQUN.NOKN, otherwise SQUN.NOK.
 */
async function squnx(
  conn: OracleDb.Connection,
  dates: Date,
  yearly: number,
): Promise<number> {
  const year = dates.getFullYear();

  try {
    const r = await conn.execute<{ K: number }>(
      `SELECT squnx(:year, :yearly) AS k FROM dual`,
      { year, yearly },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const k = Number((r.rows?.[0] as { K?: number } | undefined)?.K ?? 0);
    if (k > 0) return k;
  } catch {
    // Test/dev schemas may not expose the legacy PL/SQL function.
    // Fall through to the same SQUN-table algorithm used by that function.
  }

  const useNextYearCounter = year > Number(yearly ?? 0);
  const column = useNextYearCounter ? 'nokn' : 'nok';
  const r = await conn.execute<{ K: number }>(
    `SELECT NVL(MAX(NVL(${column},0)),0) + 1 AS k FROM squn`,
    {},
    { outFormat: oracledb.OUT_FORMAT_OBJECT },
  );
  let k = Number((r.rows?.[0] as { K?: number } | undefined)?.K ?? 1);
  if (useNextYearCounter && k === 1) k = 2;
  const u = await conn.execute(
    `UPDATE squn SET ${column} = :k`,
    { k } as never,
  );
  if (!u.rowsAffected) {
    await conn.execute(
      `INSERT INTO squn (${column}) VALUES (:k)`,
      { k } as never,
    );
  }
  return k;
}

export async function nextPostingNo(
  conn: OracleDb.Connection,
  dates: Date,
  yearly = 1,
): Promise<number> {
  return squnx(conn, dates, yearly);
}

// Re-export for callers that generate new vouchers + post in the same tx.
export { buildNos, nextNoson };
// Silences "detail table unused" — kept for forward compatibility.
void detailTableForTypems;

