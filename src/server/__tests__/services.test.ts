/**
 * Phase-1 services — pure unit tests (no Oracle connection required).
 *
 * Covers the deterministic math / string-building functions exported by
 * `messages.ts`, `sequence.ts`, `currency.ts`, `dates.ts`, and `posting.ts`.
 *
 * Run with:  D:\daty\tools\node-v20.19.0-win-x64\node.exe node_modules/vitest/vitest.mjs run --reporter verbose
 */

import { describe, it, expect } from 'vitest';

import { M, msg, permDeniedMessage } from '../messages';
import { buildNos } from '../sequence';
import { thwl, validateRate } from '../currency';
import { yyyymm, toHijri } from '../dates';
import { buildEntries, buildJournalEntries, TYPEMS, type VoucherPayload, type JournalPayload } from '../posting';

// ════════════════════════════════════════════════════════
// messages.ts
// ════════════════════════════════════════════════════════

describe('messages.ts', () => {
  it('exposes canonical IDs as string constants', () => {
    expect(typeof M.AUTH_REQUIRED).toBe('string');
    expect(M.AUTH_REQUIRED).toContain('تسجيل');
    expect(M.POSTED_NO_EDIT).toContain('مرحل');
    expect(M.DUPLICATE_VOUCHER_NO).toContain('مقيد من قبل');
  });

  it('msg() returns the template verbatim when no placeholders', () => {
    expect(msg('AUTH_REQUIRED')).toBe(M.AUTH_REQUIRED);
  });

  it('msg() ignores unknown placeholders for messages without them', () => {
    expect(msg('DATE_IN_FUTURE', { foo: 'bar' })).toBe(M.DATE_IN_FUTURE);
  });

  it('permDeniedMessage() maps action codes to the right message', () => {
    expect(permDeniedMessage('ins')).toBe(M.PERM_DENIED_INS);
    expect(permDeniedMessage('ed')).toBe(M.PERM_DENIED_ED);
    expect(permDeniedMessage('de')).toBe(M.PERM_DENIED_DE);
    expect(permDeniedMessage('pr')).toBe(M.PERM_DENIED_PR);
  });
});

// ════════════════════════════════════════════════════════
// sequence.ts — buildNos
// ════════════════════════════════════════════════════════

describe('sequence.ts :: buildNos()', () => {
  it('formats NOSON*10000 + YY for 4-digit year input', () => {
    expect(buildNos(15, 2026)).toBe(150026);
    expect(buildNos(1, 2025)).toBe(10025);
    expect(buildNos(999, 2030)).toBe(9990030);
  });

  it('accepts a Date and extracts YY from it', () => {
    expect(buildNos(15, new Date('2026-04-19'))).toBe(150026);
    expect(buildNos(42, new Date('1999-12-31'))).toBe(420099);
  });

  it('wraps YY at the century boundary (mod 100)', () => {
    expect(buildNos(3, 2100)).toBe(30000);   // YY=0
    expect(buildNos(3, 2099)).toBe(30099);   // YY=99
  });
});

// ════════════════════════════════════════════════════════
// currency.ts — thwl + validateRate
// ════════════════════════════════════════════════════════

describe('currency.ts :: thwl()', () => {
  it("driver='local' recomputes foreign = local/rate", () => {
    const r = thwl('local', { local: 100, rate: 2 });
    expect(r.local).toBe(100);
    expect(r.foreign).toBe(50);
    expect(r.rate).toBe(2);
  });

  it("driver='foreign' recomputes local = foreign*rate", () => {
    const r = thwl('foreign', { foreign: 50, rate: 2 });
    expect(r.local).toBe(100);
    expect(r.foreign).toBe(50);
    expect(r.rate).toBe(2);
  });

  it("driver='rate' recomputes local = foreign*rate (keeps foreign stable)", () => {
    const r = thwl('rate', { foreign: 50, rate: 3 });
    expect(r.local).toBe(150);
    expect(r.foreign).toBe(50);
    expect(r.rate).toBe(3);
  });

  it('does not divide by zero when rate is 0', () => {
    const r = thwl('local', { local: 100, rate: 0 });
    expect(r.local).toBe(100);
    expect(Number.isFinite(r.foreign)).toBe(true);
  });

  it('rounds local to 2 decimals and foreign to 4 decimals', () => {
    const r = thwl('local', { local: 100, rate: 3 });
    expect(r.local).toBe(100);
    expect(r.foreign).toBeCloseTo(33.3333, 4);
  });
});

describe('currency.ts :: validateRate()', () => {
  it('rejects zero or negative rate', () => {
    expect(validateRate(0, null)).toBe(M.CURRENCY_RATE_ZERO);
    expect(validateRate(-1, null)).toBe(M.CURRENCY_RATE_ZERO);
  });

  it('accepts a positive rate with no bounds', () => {
    expect(validateRate(5, null)).toBeNull();
  });

  it('accepts a rate within [SARS1, SARS2]', () => {
    expect(validateRate(5, { SARS1: 1, SARS2: 10 })).toBeNull();
    expect(validateRate(1, { SARS1: 1, SARS2: 10 })).toBeNull();
    expect(validateRate(10, { SARS1: 1, SARS2: 10 })).toBeNull();
  });

  it('rejects a rate above SARS2', () => {
    expect(validateRate(15, { SARS1: 1, SARS2: 10 })).toBe(M.CURRENCY_RATE_TOO_HIGH);
  });

  it('rejects a rate below SARS1', () => {
    expect(validateRate(0.5, { SARS1: 1, SARS2: 10 })).toBe(M.CURRENCY_RATE_TOO_LOW);
  });

  it('treats SARS1=0 / SARS2=0 as "no bound"', () => {
    expect(validateRate(100, { SARS1: 0, SARS2: 0 })).toBeNull();
  });
});

// ════════════════════════════════════════════════════════
// dates.ts — pure helpers
// ════════════════════════════════════════════════════════

describe('dates.ts :: yyyymm()', () => {
  it('encodes year*100 + month for any Date', () => {
    expect(yyyymm(new Date('2026-04-19'))).toBe(202604);
    expect(yyyymm(new Date('2025-01-01'))).toBe(202501);
    expect(yyyymm(new Date('1999-12-31'))).toBe(199912);
  });
});

describe('dates.ts :: toHijri()', () => {
  it('returns a non-empty Arabic-formatted string for a valid date', () => {
    const h = toHijri(new Date('2026-04-19'));
    expect(h).toBeTruthy();
    expect(typeof h).toBe('string');
    // The Intl output uses Arabic-Indic digits and the Hijri calendar era.
    expect(h!.length).toBeGreaterThan(5);
  });
});

// ════════════════════════════════════════════════════════
// posting.ts — buildEntries() direction table
// ════════════════════════════════════════════════════════

/**
 * Helper: minimal VoucherPayload factory for TRSND tests.
 *
 * The master is typed with `NOK: number` (not `number|null`) because that is
 * exactly what {@link buildEntries} expects — it's called *after* the runtime
 * has resolved a NOK from the sequence service.
 */
type TestVoucher = VoucherPayload & { master: VoucherPayload['master'] & { NOK: number } };

function makePayload(overrides: Partial<VoucherPayload['master']> = {}): TestVoucher {
  const master: VoucherPayload['master'] = {
    NOS:     123456,
    DATES:   new Date('2026-04-19'),
    NOA:     1001,
    NOAML:   1,
    TOTALS:  1000,
    TOTALS2: 1000,
    SARSFS:  1,
    MEMOS1:  'اختبار',
    MRT2:    0,
    NOK:     500,
    NOMSRO:  0,
    NOUSX:   7,
    ...overrides,
  };
  return {
    master: master as TestVoucher['master'],
    details: [
      { RECNO: 1, NOAF: 2001, NOAML: 1, TOAM: 600, TOAA: 600, SARSF: 1, MRT: 0, MEMOSF: 'نقداً' },
      { RECNO: 2, NOAF: 2002, NOAML: 1, TOAM: 400, TOAA: 400, SARSF: 1, MRT: 0, MEMOSF: 'شيك' },
    ],
  };
}

describe('posting.ts :: buildEntries()', () => {
  it('SNDK master is CREDIT (dan) and details are DEBIT (mdin)', () => {
    const rows = buildEntries(TYPEMS.SNDK, makePayload());
    expect(rows).toHaveLength(3);

    const master = rows[0]!;
    expect(master.typems).toBe(4);
    expect(master.dan).toBe(1000);
    expect(master.mdin).toBe(0);
    expect(master.kdant).toBe(0);
    expect(master.recno).toBe(0);

    for (const d of rows.slice(1)) {
      expect(d.typems).toBe(4);
      expect(d.mdin).toBeGreaterThan(0);
      expect(d.dan).toBe(0);
      expect(d.kdant).toBe(1);
    }

    // Detail amounts should equal the master total
    const detailSum = rows.slice(1).reduce((s, r) => s + r.mdin, 0);
    expect(detailSum).toBe(master.dan);
  });

  it('SNDS master is DEBIT (mdin) and details are CREDIT (dan)', () => {
    const rows = buildEntries(TYPEMS.SNDS, makePayload());
    expect(rows).toHaveLength(3);

    const master = rows[0]!;
    expect(master.typems).toBe(5);
    expect(master.mdin).toBe(1000);
    expect(master.dan).toBe(0);

    for (const d of rows.slice(1)) {
      expect(d.typems).toBe(5);
      expect(d.dan).toBeGreaterThan(0);
      expect(d.mdin).toBe(0);
    }

    const detailSum = rows.slice(1).reduce((s, r) => s + r.dan, 0);
    expect(detailSum).toBe(master.mdin);
  });

  it('propagates NOS/NOK/NOUSX to every row', () => {
    const rows = buildEntries(TYPEMS.SNDK, makePayload());
    for (const r of rows) {
      expect(r.noms).toBe(123456);
      expect(r.nok).toBe(500);
      expect(r.nousx).toBe(7);
    }
  });

  it('uses master memo for details lacking an explicit MEMOSF', () => {
    const p = makePayload();
    p.details[0]!.MEMOSF = null;
    const rows = buildEntries(TYPEMS.SNDK, p);
    expect(rows[1]!.memos).toBe('اختبار');     // inherited from master
    expect(rows[2]!.memos).toBe('شيك');         // kept from detail
  });

  it('falls back to master SARSFS when a detail has no SARSF', () => {
    const p = makePayload();
    p.master.SARSFS = 250;
    p.details[0]!.SARSF = null;
    const rows = buildEntries(TYPEMS.SNDK, p);
    expect(rows[1]!.sarsf).toBe(250);
  });

  it('maps the foreign amounts (TOTALS2 / TOAA) to mdinaml/danaml correctly', () => {
    const p = makePayload();
    p.master.TOTALS2 = 500;
    p.details[0]!.TOAA = 300;
    p.details[1]!.TOAA = 200;

    const rows = buildEntries(TYPEMS.SNDK, p);
    const master = rows[0]!;
    expect(master.danaml).toBe(500);           // SNDK master credits foreign
    expect(master.mdinaml).toBe(0);

    const detailForeignSum = rows.slice(1).reduce((s, r) => s + r.mdinaml, 0);
    expect(detailForeignSum).toBe(500);
  });

  it('emits no rows when there are zero details', () => {
    const p = makePayload();
    p.details = [];
    const rows = buildEntries(TYPEMS.SNDK, p);
    expect(rows).toHaveLength(1);              // master only
    expect(rows[0]!.kdant).toBe(0);
  });
});

// ════════════════════════════════════════════════════════
// posting.ts — buildJournalEntries() for SNDKD
// ════════════════════════════════════════════════════════

/** Minimal balanced 2-line journal payload. */
type TestJournal = JournalPayload & { master: JournalPayload['master'] & { NOK: number } };

function makeJournal(overrides: Partial<JournalPayload['master']> = {}): TestJournal {
  const master: JournalPayload['master'] = {
    NOS:    700001,
    DATES:  new Date('2026-04-19'),
    MEMOS:  'مصاريف عامة',
    NOK:    250,
    NOUSX:  5,
    NOMSRO: 0,
    ...overrides,
  };
  return {
    master: master as TestJournal['master'],
    details: [
      { RECNO: 1, NOA: 3100, NOAML: 1, MDIN: 500, DAN: 0,   SARSF: 1, MRT: 0, MEMOS: 'صندوق' },
      { RECNO: 2, NOA: 4100, NOAML: 1, MDIN: 0,   DAN: 500, SARSF: 1, MRT: 0, MEMOS: 'مصروف' },
    ],
  };
}

describe('posting.ts :: buildJournalEntries()', () => {
  it('emits one DATAK row per detail (no synthetic master row)', () => {
    const rows = buildJournalEntries(makeJournal());
    expect(rows).toHaveLength(2);
  });

  it('keeps each detail raw MDIN/DAN as-is (no direction flip)', () => {
    const rows = buildJournalEntries(makeJournal());
    expect(rows[0]!.mdin).toBe(500); expect(rows[0]!.dan).toBe(0);
    expect(rows[1]!.mdin).toBe(0);   expect(rows[1]!.dan).toBe(500);
  });

  it('marks every row as a detail (kdant=1) — journal entries have no master side', () => {
    const rows = buildJournalEntries(makeJournal());
    for (const r of rows) expect(r.kdant).toBe(1);
  });

  it('tags every row with TYPEMS.JOURNAL = 1', () => {
    const rows = buildJournalEntries(makeJournal());
    for (const r of rows) expect(r.typems).toBe(TYPEMS.JOURNAL);
    expect(TYPEMS.JOURNAL).toBe(1);
  });

  it('propagates NOS / NOK / NOUSX and DATES to every row', () => {
    const rows = buildJournalEntries(makeJournal({ NOK: 999 }));
    for (const r of rows) {
      expect(r.noms).toBe(700001);
      expect(r.nok).toBe(999);
      expect(r.nousx).toBe(5);
      expect(r.datemo).toEqual(new Date('2026-04-19'));
    }
  });

  it('falls back to master memo when detail memo is null', () => {
    const p = makeJournal();
    p.details[0]!.MEMOS = null;
    const rows = buildJournalEntries(p);
    expect(rows[0]!.memos).toBe('مصاريف عامة');   // inherited
    expect(rows[1]!.memos).toBe('مصروف');         // kept
  });

  it('defaults foreign amounts (MDINAML/DANAML) to the local ones when missing', () => {
    const rows = buildJournalEntries(makeJournal());
    expect(rows[0]!.mdinaml).toBe(500);
    expect(rows[0]!.danaml).toBe(0);
    expect(rows[1]!.mdinaml).toBe(0);
    expect(rows[1]!.danaml).toBe(500);
  });

  it('preserves explicit foreign amounts when provided', () => {
    const p = makeJournal();
    p.details[0]!.MDINAML = 120;
    p.details[1]!.DANAML  = 120;
    const rows = buildJournalEntries(p);
    expect(rows[0]!.mdinaml).toBe(120);
    expect(rows[1]!.danaml).toBe(120);
  });
});
