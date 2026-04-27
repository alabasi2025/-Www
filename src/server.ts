import {
  AngularNodeAppEngine,
  createWebRequestFromNodeRequest,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { existsSync, readFileSync as rfs, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import crypto from 'node:crypto';
import { hostname } from 'node:os';
import { authenticate, type SessionUser } from './server/auth';
import { queryOn, unitToSchema, getPool } from './server/db';
import { auditInsert, auditUpdate, clientTag as sharedClientTag } from './server/audit';
import {
  ensureNotFutureDate,
  ensureLegacyBackDateAllowed,
  ensureNomsUnique,
  ensureAkfaNotClosed,
  getAkfaMaxDate as sharedGetAkfaMaxDate,
} from './server/validation';
import { getPermissions, ensurePermission } from './server/permissions';
import { postVoucher, unpostVoucher, postJournal, postSndkd2, nextPostingNo, TYPEMS, type Typems } from './server/posting';
import { M } from './server/messages';
import { executeLov, listLovs, LOV_REGISTRY } from './server/lov';

const browserDistFolder = join(import.meta.dirname, '../browser');
const angularApp = new AngularNodeAppEngine();
const app = new Hono();

// تعطيل منع SSRF للـ localhost في بيئة التطوير
app.use('*', async (c, next) => {
  const host = c.req.header('host');
  if (host && (host.startsWith('localhost:') || host.startsWith('127.0.0.1:'))) {
    c.req.raw.headers.set('X-Forwarded-Host', host);
  }
  await next();
});

const SESSION_COOKIE = 'daty_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map<string, { user: SessionUser; expiresAt: number }>();

async function legacyPostingFlag(
  conn: Parameters<typeof nextPostingNo>[0],
): Promise<number> {
  const r = await conn.execute<{ SANDT: number }>(
    `SELECT NVL(MAX(SANDT),0) AS sandt FROM titl`,
    {},
    { outFormat: 4002 },
  );
  const row = (r.rows as { SANDT: number }[] | undefined)?.[0];
  // Legacy SYSALL.SANDT: 0 = auto-post on save (MRHL=0), >0 = manual posting (MRHL=1).
  return Number(row?.SANDT ?? 0) > 0 ? 1 : 0;
}

function legacyMrhlIsPosted(mrhl: unknown): boolean {
  // Legacy HMS procedure displays NVL(MRHL,0)=0 as "مستند مرحل".
  return Number(mrhl ?? 0) === 0;
}

async function legacyMornom(
  conn: Parameters<typeof nextPostingNo>[0],
  mrhl: unknown,
): Promise<number> {
  const sandt = await legacyPostingFlag(conn);
  return sandt > 0 && legacyMrhlIsPosted(mrhl) ? 1 : 0;
}

async function ensureLegacyNotPosted(
  conn: Parameters<typeof nextPostingNo>[0],
  mrhl: unknown,
  op: 'تعديل' | 'حذف' = 'تعديل',
): Promise<string | null> {
  const locked = await legacyMornom(conn, mrhl);
  return locked > 0 ? `لا يمكن ${op} مستند مرحل، يجب الغاء الترحيل اولا` : null;
}

async function legacyYearHly(
  conn: Parameters<typeof nextPostingNo>[0],
): Promise<number> {
  const r = await conn.execute<{ YEARHLY: number }>(
    `SELECT NVL(MAX(Y_YEAR),0) AS yearhly FROM year`,
    {},
    { outFormat: 4002 },
  );
  const row = (r.rows as { YEARHLY: number }[] | undefined)?.[0];
  return Number(row?.YEARHLY ?? 0);
}

async function legacyInsertPosting(
  conn: Parameters<typeof nextPostingNo>[0],
  dates: Date,
  forceUnposted = false,
): Promise<{ mrhl: number; nok: number }> {
  const mrhl = forceUnposted ? 1 : await legacyPostingFlag(conn);
  const yearHly = await legacyYearHly(conn);
  return { mrhl, nok: await nextPostingNo(conn, dates, yearHly) };
}

function readSession(sessionId: string | undefined): SessionUser | null {
  if (!sessionId) return null;
  const row = sessions.get(sessionId);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    sessions.delete(sessionId);
    return null;
  }
  return row.user;
}

function readUser(c: Context): SessionUser | null {
  const sessionId = getCookie(c, SESSION_COOKIE);
  return readSession(sessionId);
}

app.get('/api/health', (c) => {
  return c.json({ ok: true, now: new Date().toISOString() });
});

app.get('/api/units', async (c) => {
  try {
    const rows = await queryOn<{ NU: string; NA: string }>(
      'DATAALA',
      `SELECT nu, na FROM m_s ORDER BY nu`,
    );
    return c.json({
      ok: true,
      units: rows.map((r) => ({ NU: r.NU, NA: r.NA })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, error: message }, 500);
  }
});

app.get('/api/years', async (c) => {
  const unit = (c.req.query('unit') || 'A').toUpperCase();
  const schema = unitToSchema(unit);
  try {
    const rows = await queryOn<{ Y_YEAR: number }>(
      schema,
      `SELECT y_year FROM year ORDER BY y_year ASC`,
      {},
    );
    const years = rows.map(r => String(r.Y_YEAR)).filter(y => /^\d{4}$/.test(y));
    return c.json({ ok: true, years: years.length ? years : [String(new Date().getFullYear())] });
  } catch {
    return c.json({ ok: true, years: [String(new Date().getFullYear())] });
  }
});

app.get('/api/login-users', async (c) => {
  const unit = (c.req.query('unit') || 'A').toUpperCase();
  if (!/^[A-Z]$/.test(unit)) {
    return c.json({ ok: false, error: 'invalid unit' }, 400);
  }
  const schema = unitToSchema(unit);
  try {
    const rows = await queryOn<{
      NOU: number;
      NAMEU: string;
      STATU: number | null;
    }>(
      schema,
      `SELECT nou, nameu, NVL(statu, 0) AS statu
         FROM user_u
        ORDER BY statu DESC, nou`,
    );
    return c.json({
      ok: true,
      unit,
      schema,
      users: rows.map((u) => ({
        nou: u.NOU,
        name: u.NAMEU,
        isAdmin: (u.STATU || 0) > 0,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, error: message }, 500);
  }
});

app.post('/api/login', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const unit = String(body['unit'] || '').toUpperCase();
  const password = String(body['password'] || '');
  const userId = body['userId'];
  const yearIn = String(body['year'] || '').trim();
  const entryYearIn = String(body['entryYear'] || '').trim();
  if (!unit) return c.json({ ok: false, error: 'unit is required' }, 400);
  if (!password) return c.json({ ok: false, error: 'password is required' }, 400);

  const result = await authenticate({ unit, userId, password });
  if (!result.ok || !result.user) {
    return c.json({ ok: false, error: result.error || 'login failed' }, 401);
  }

  const fallbackYear = String(new Date().getFullYear());
  const year = /^\d{4}$/.test(yearIn) ? yearIn : fallbackYear;
  const entryYear = /^\d{4}$/.test(entryYearIn) ? entryYearIn : year;
  const sessionUser: SessionUser = {
    ...result.user,
    machine: hostname(),
    year,
    entryYear,
  };

  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    user: sessionUser,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });

  return c.json({ ok: true, user: sessionUser });
});

app.get('/api/me', (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  return c.json({ ok: true, user });
});

app.post('/api/logout', (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) sessions.delete(sessionId);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

app.get('/api/systems', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: 'no session' }, 401);

  try {
    const rows = await queryOn<{
      TSYS: number;
      TOTAL_ROWS: number;
      SCREEN_ROWS: number;
    }>(
      user.schema,
      `SELECT NVL(tsys,0) AS tsys,
              COUNT(*) AS total_rows,
              SUM(CASE
                    WHEN namee IS NOT NULL OR namef IS NOT NULL THEN 1
                    ELSE 0
                  END) AS screen_rows
         FROM data_acm
        WHERE NVL(rtba,0) <= 5
        GROUP BY NVL(tsys,0)
        ORDER BY NVL(tsys,0)`,
    );
    return c.json({
      ok: true,
      schema: user.schema,
      systems: rows.map((row) => ({
        tsys: Number(row.TSYS || 0),
        totalRows: Number(row.TOTAL_ROWS || 0),
        screenRows: Number(row.SCREEN_ROWS || 0),
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, error: message }, 500);
  }
});

app.get('/api/screens', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: 'no session' }, 401);

  const tsys = Number(c.req.query('tsys') || '1') || 1;
  try {
    type MenuNode = {
      noa: number;
      typea: number;
      namea: string;
      namee: string;
      namef: string;
      rtba: number;
      level: number;
      launchable: boolean;
      children: MenuNode[];
    };

    const rows = await queryOn<{
      NOA: number;
      TYPEA: number | null;
      NAMEA: string | null;
      NAMEE: string | null;
      NAMEF: string | null;
      RTBA: number | null;
      LVL: number | null;
    }>(
      user.schema,
      `SELECT d.noa, d.typea, d.namea, d.namee, d.namef, d.rtba, LEVEL AS lvl
         FROM data_acm d
        WHERE NVL(d.rtba, 0) <= 5
          AND (NVL(d.tsys, 0) = :t OR NVL(INSTR(d.noab, TO_CHAR(:t)), 0) > 0)
          AND (
            d.noa IN (SELECT nopr FROM usergn WHERE nou = :nou)
            OR :isAdmin > 0
            OR d.namef IS NULL
            OR UPPER(d.namef) IN ('USER.FMX', 'MEMO.FMX')
          )
        CONNECT BY PRIOR d.noa = d.typea
        START WITH d.typea = 0
        ORDER SIBLINGS BY d.noa`,
      { t: tsys, nou: user.nou, isAdmin: user.isAdmin ? 1 : 0 },
    );

    const normalized: MenuNode[] = rows.map((row) => {
      const namef = String(row.NAMEF || '').trim().toUpperCase();
      const nameeRaw = String(row.NAMEE || '').trim().toUpperCase();
      const nameeFromFile = namef
        .replace(/^.*[\\/]/, '')
        .replace(/\.(FMX|FMB|REP)$/i, '');
      const namee = nameeRaw || nameeFromFile;
      return {
        noa: Number(row.NOA || 0),
        typea: Number(row.TYPEA || 0),
        namea: String(row.NAMEA || ''),
        namee,
        namef,
        rtba: Number(row.RTBA || 0),
        level: Number(row.LVL || 0),
        launchable: namee.length > 0,
        children: [],
      };
    });

    const byNoa = new Map<number, MenuNode>();
    for (const row of normalized) byNoa.set(row.noa, row);

    const roots: MenuNode[] = [];
    for (const row of normalized) {
      const parent = byNoa.get(row.typea);
      if (parent) parent.children.push(row);
      else roots.push(row);
    }

    return c.json({
      ok: true,
      tsys,
      schema: user.schema,
      rows: normalized,
      tree: roots,
      total: normalized.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, error: message }, 500);
  }
});

// =============================================
// /api/data/:table  � generic CRUD (Oracle 10g)
// =============================================
app.get('/api/data/:table', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  const table = c.req.param('table').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  if (!table) return c.json({ ok: false, error: 'bad table' }, 400);
  const limit = Math.min(Number(c.req.query('limit') || '200'), 1000);
  const orderBy = (c.req.query('orderBy') || 'ROWID').replace(/[^A-Za-z0-9_ ,]/g, '');
  try {
    const rows = await queryOn(user.schema,
      `SELECT * FROM ${table} ORDER BY ${orderBy}`,
    );
    const total = rows.length;
    return c.json({ ok: true, rows: rows.slice(0, limit), total });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.post('/api/data/:table', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  const table = c.req.param('table').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const body = await c.req.json() as Record<string, unknown>;
  const cols = Object.keys(body).filter(k => !/[^A-Z0-9_]/i.test(k));
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(c => ':' + c).join(',')})`;
  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    await conn.execute(sql, body as never);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true });
  } catch (e) { await conn.execute('ROLLBACK', {} as never); return c.json({ ok: false, error: (e as Error).message }, 500); }
  finally { await conn.close(); }
});

// =============================================
// /api/lov  — see registry-driven handler below (duplicate legacy
// /api/lov/:name route removed; LovService now owns this surface).
// =============================================

// =============================================
// /api/titl — System parameters (TITL table, single row).
// Mirrors the Oracle Forms `SYSALL.fmb` screen (اعدادات اساسية).
//
// The TITL table is enormous (180+ columns) but SYSALL only exposes a
// focused subset — the "operational" flags that actually change the
// behaviour of the other screens. We keep a canonical field list here
// grouped by logical section so both the GET and PUT handlers stay in
// sync with the UI.
// =============================================
const TITL_FIELDS = [
  // ── Tab 1 — General options (خيارات عامة) ──
  // Field names confirmed by scanning the original SYSALL.fmb binary.
  'KY',        // الاقفال اليومي الياً
  'IHSAB',     // تسلسل أرقام الحسابات الياً
  'INSDS',     // السماح للمستخدمين بإدخال تاريخ سابق
  'AMLH1',     // نظام العملات عملة واحدة فقط للحساب
  'MRT',       // تفعيل حقل مركز التكلفة في المستندات
  'MRT2',      // إدخال مركز التكلفة إجباري (checkbox 0/1 — NOT a default id)
  'T_MRT_U',   // تفعيل ربط المستخدمين بمراكز التكلفة
  'SANDT',     // إلغاء الترحيل الآلي: 0=auto-post on save, 1=manual posting
  'TTSFIR',
  'P_R_SNDK',  // رصيد الحساب في شاشة الإدخال للمستندات المرحلة فقط
  'INDATE',    // التاريخ التلقائي (0 جهاز / 1 آخر مُدخَل / 2 آخر للمستند الحالي)
  'QXZ',       // توقيف العملاء بعد X يوم من آخر مديونية
  'PCS',       // اسم الجهاز الرئيسي
  'TSYS',      // رقم النظام الفرعي؛ SYSALL.SANDT يثبت على 0 عندما TSYS=2

  // ── Tab 2 — Header & footer (الترويسة والتذييل) ──
  'N1', 'N2', 'N3', 'N4',            // عنوان 1..4 (الجانب الأيمن)
  'NA1', 'NA2', 'NA3', 'NA4',        // عنوان 1..4 (الجانب الأيسر)
  'NF1', 'NF2', 'NF3', 'NF4',        // عناوين إضافية
  'TAHD',                             // إظهار/إخفاء نص أسفل صفحة التقرير (flag)
  'MEMO',  'MEMO2',                   // اشعار كشف الحساب / ملاحظة ثانية
  'MEWAEL',                           // الاسم التجاري / توقيع المصمم
  'CLR', 'C1', 'C2', 'C3', 'C4', 'CB',// ألوان التميّز

  // ── Tab 3 — Receipts & payment vouchers (سندات) ──
  'NOSMM',     // تسلسل سند القبض (1..5)
  'NOSMMS',    // تسلسل سند الصرف (1..5)
  'CBK',       // البيان الآلي لسند القبض
  'CBS',       // البيان الآلي لسند الصرف
  'TBK',       // عدم كتابة اسم الصندوق في بيان سند القبض
  'TBS',       // عدم كتابة اسم الصندوق في بيان سند الصرف

  // ── Tab 4 — Messaging (نظام الرسائل) ──
  'TSMS',      // نوع نظام الرسائل (1..3)
  'T_SMS',     // نوع البوابة (1..3 — Android 140 / Android 70 / USB 70)
  'INDA_SMS',  // إضافة التاريخ للرسالة (1..3)
  'SMS_SRB',   // إرسال رسائل للنزلاء
  'NWSMS',     // رقم المرسل
  'V_PDF',     // مجلد حفظ ملفات PDF

  // ── Tab 5 — Backup (النسخ الاحتياطي) ──
  'NAME_COPY1', // الاسم الافتراضي للنسخة
  'NAME_COPY2', // نسخة أخرى على القرص
  'TIM_COPY',   // إضافة وقت/تاريخ للاسم
  'DEL_COPY',   // حذف النسخ الأقدم من X يوم

  // ── Other legacy values exposed for LOV/defaults (not on the tabs) ──
  'SYSAML', 'AMLMHZ', 'ALLAML', 'TNOA', 'RTBA',
  'NOG', 'NOMHZN', 'NOMHZND', 'RSEM', 'NSBR',
  'PATHP', 'PATHP2', 'TITLFH', 'TITLFHF',
] as const;
type TitlField = typeof TITL_FIELDS[number];

/** Which fields are text (everything else is numeric). */
const TITL_TEXT_FIELDS: ReadonlySet<TitlField> = new Set<TitlField>([
  'NWSMS', 'CBS', 'CBK',
  'MEMO', 'MEMO2', 'MEWAEL',
  'PATHP', 'PATHP2', 'V_PDF',
  'TITLFH', 'TITLFHF',
  'NAME_COPY1', 'NAME_COPY2',
  'N1', 'N2', 'N3', 'N4',
  'NA1', 'NA2', 'NA3', 'NA4',
  'NF1', 'NF2', 'NF3', 'NF4',
  'PCS',
]);

const TITL_COLOR_FIELDS = ['C1', 'C2', 'C3', 'C4', 'CB'] as const satisfies readonly TitlField[];

async function readTitlNumber(
  conn: Parameters<typeof nextPostingNo>[0],
  field: TitlField,
): Promise<number> {
  const r = await conn.execute<Record<string, number>>(
    `SELECT NVL(MAX(${field}),0) AS v FROM titl`,
    {} as never,
    { outFormat: 4002 },
  );
  const row = (r.rows as unknown as { V?: number; v?: number }[] | undefined)?.[0];
  return Number(row?.V ?? row?.v ?? 0);
}

async function normalizeTitlUpdates(
  conn: Parameters<typeof nextPostingNo>[0],
  updates: Partial<Record<TitlField, unknown>>,
): Promise<{ fields: TitlField[]; warnings: string[]; normalized: Partial<Record<TitlField, unknown>> }> {
  const warnings: string[] = [];
  const normalized: Partial<Record<TitlField, unknown>> = {};

  const setField = (field: TitlField, value: unknown, warning?: string) => {
    if (updates[field] !== value) {
      updates[field] = value;
      normalized[field] = value;
      if (warning) warnings.push(warning);
    }
  };

  for (const field of TITL_COLOR_FIELDS) {
    if (field in updates && Number(updates[field] ?? 0) === 0) {
      setField(field, 1);
    }
  }

  for (const field of ['NOSMM', 'NOSMMS'] as const satisfies readonly TitlField[]) {
    if (field in updates && Number(updates[field] ?? 0) === 0) {
      setField(field, 1);
    }
  }

  if ('NOG' in updates) {
    const maxGroup = await conn.execute<{ X1: number }>(
      `SELECT NVL(MAX(typea),0) AS x1 FROM data_ag WHERE rtba = 2`,
      {} as never,
      { outFormat: 4002 },
    );
    const row = (maxGroup.rows as unknown as { X1: number }[] | undefined)?.[0];
    const x1 = Number(row?.X1 ?? 0);
    const current = Number(updates.NOG ?? 0);
    if (current === 0) setField('NOG', x1 > 0 ? x1 : 4);
    else if (x1 > 0 && current < x1) setField('NOG', x1);
  }

  if ('AMLH1' in updates && Number(updates.AMLH1 ?? 0) > 0) {
    const r = await conn.execute<{ X1: number; X2: number }>(
      `SELECT NVL(MAX(noaml),0) AS x1, NVL(MIN(noaml),0) AS x2 FROM amhsb`,
      {} as never,
      { outFormat: 4002 },
    );
    const row = (r.rows as unknown as { X1: number; X2: number }[] | undefined)?.[0];
    const maxNoaml = Number(row?.X1 ?? 0);
    const minNoaml = Number(row?.X2 ?? 0);
    if (maxNoaml > 0 && minNoaml > 0 && maxNoaml !== minNoaml) {
      setField('AMLH1', 0, 'تم إلغاء خيار عملة واحدة لأن الحسابات تحتوي أكثر من عملة كما في النظام القديم');
    }
  }

  if ('SANDT' in updates || 'TSYS' in updates) {
    const tsys = Number(('TSYS' in updates ? updates.TSYS : await readTitlNumber(conn, 'TSYS')) ?? 0);
    if (tsys === 2) {
      setField('SANDT', 0, 'النظام الفرعي الحالي يفرض الترحيل الآلي كما في النظام القديم');
    }
  }

  return {
    fields: Object.keys(updates) as TitlField[],
    warnings: [...new Set(warnings)],
    normalized,
  };
}

app.get('/api/titl', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  try {
    // We wrap each column in MAX() so the query works whether TITL is
    // expected to hold a single row (normal) or occasionally several
    // (legacy installs sometimes keep a dummy second row). A missing
    // column would blow the whole SELECT up, so we fetch a known-good
    // set — every name in TITL_FIELDS must exist in the table.
    const cols = TITL_FIELDS.map(f => `MAX(${f}) AS ${f}`).join(', ');
    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT ${cols} FROM titl`,
    );
    const t = rows[0] || {};
    const out: Record<string, unknown> = {};
    for (const f of TITL_FIELDS) {
      const v = t[f];
      if (TITL_TEXT_FIELDS.has(f)) {
        out[f] = v == null ? '' : String(v);
      } else {
        out[f] = v == null ? 0 : Number(v);
      }
    }
    return c.json({ ok: true, titl: out });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

// PUT /api/titl — admin-only save. Accepts a partial body with any subset
// of TITL_FIELDS. Missing fields are left untouched. The legacy screen
// only ever updates a single "settings" row, so we UPDATE with no WHERE
// clause — TITL is expected to hold exactly one row.
app.put('/api/titl', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  if (!user.isAdmin)
    return c.json({ ok: false, error: 'هذه العملية تتطلب صلاحية مدير النظام' }, 403);

  let body: Record<string, unknown>;
  try { body = await c.req.json<Record<string, unknown>>(); }
  catch { return c.json({ ok: false, error: 'invalid JSON body' }, 400); }

  // Collect only recognised fields — silently ignore anything else so a
  // caller cannot sneak in unrelated column updates.
  const updates: Partial<Record<TitlField, unknown>> = {};
  for (const f of TITL_FIELDS) {
    if (!(f in body)) continue;
    const raw = body[f];
    if (TITL_TEXT_FIELDS.has(f)) {
      updates[f] = raw == null ? null : String(raw).slice(0, 500);
    } else {
      if (raw == null || raw === '') updates[f] = null;
      else {
        const n = Number(raw);
        if (!Number.isFinite(n))
          return c.json({ ok: false, error: `قيمة غير صالحة للحقل ${f}` }, 400);
        updates[f] = n;
      }
    }
  }
  if (!Object.keys(updates).length)
    return c.json({ ok: false, error: 'لا توجد بيانات للحفظ' }, 400);

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    // Make sure the TITL row exists — if the table is empty we INSERT an
    // empty row first, which mirrors the legacy FORMS_DDL upgrade path.
    const cnt = await conn.execute<{ CNT: number }>(
      `SELECT COUNT(*) AS cnt FROM titl`, {} as never, { outFormat: 4002 });
    if (((cnt.rows as unknown as { CNT: number }[])[0]?.CNT ?? 0) === 0) {
      await conn.execute(`INSERT INTO titl (tnoa) VALUES (NULL)`, {} as never);
    }

    const normalized = await normalizeTitlUpdates(conn, updates);
    const fields = normalized.fields;
    if (!fields.length)
      return c.json({ ok: false, error: 'لا توجد بيانات للحفظ' }, 400);

    const setClause = fields.map(f => `${f} = :${f.toLowerCase()}`).join(', ');
    const binds: Record<string, unknown> = {};
    for (const f of fields) binds[f.toLowerCase()] = updates[f];

    await conn.execute(`UPDATE titl SET ${setClause}`, binds as never);
    await conn.execute('COMMIT', {} as never);
    const titl: Record<string, unknown> = {};
    for (const f of fields) titl[f] = updates[f] ?? (TITL_TEXT_FIELDS.has(f) ? '' : 0);
    return c.json({
      ok: true,
      message: M.SAVED_SUCCESS,
      updated: fields,
      titl,
      normalized: normalized.normalized,
      warnings: normalized.warnings,
    });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

// =============================================
// /api/permissions/:screen — USERGN permission matrix
// Returns { ok, perms: { ins, ed, de, pr, sar, saa, sarb, hs1, hs2, fnkd } }
// Used by the frontend to hide/disable UI actions per user+screen.
// =============================================
app.get('/api/permissions/:screen', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  const screen = c.req.param('screen');
  try {
    const perms = await getPermissions(user, screen);
    return c.json({ ok: true, perms, isAdmin: user.isAdmin });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

// =============================================
// /api/accounts  — Chart of Accounts (DATA_AC / TREE screen)
// Mirrors the original Oracle Forms TREE.fmb logic
// =============================================

// Audit helpers (auditInsert, auditUpdate, clientTag) are imported from
// ./server/audit — shared across all main-entity endpoints.
// clientTag is re-exposed under the original local name for backwards compatibility.
const clientTag = sharedClientTag;

// USERGN screen code for the Chart of Accounts / TREE screen (DATA_ACM.NAMEF)
const TREE_SCREEN = 'TREE.FMX';

app.get('/api/accounts/tree', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  try {
    const rows = await queryOn<{ NOA: number; NAMEA: string; TYPEA: number; RTBA: number;
        AHSAR: string | null; TSYS: number | null; NOSNDOK: number | null; AMLHH: number | null;
        NOYSOFT: number | null; NOYSOFR: number | null; TWKFX: number | null; HALL: number | null;
        NOKYED: number | null; MEMOH: string | null }>(user.schema,
      `SELECT noa, namea, NVL(typea,0) AS typea, NVL(rtba,0) AS rtba, ahsar, tsys,
              nosndok, amlhh, noysoft, noysofr, twkfx, hall, nokyed, memoh
         FROM data_ac ORDER BY noa`);
    return c.json({ ok: true, rows });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.get('/api/accounts/:noa', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  const noa = Number(c.req.param('noa'));
  if (!noa) return c.json({ ok: false, error: 'noa required' }, 400);
  try {
    // Mirror source: `select max(nameu) into :nms   from user_u where nou=:nousx`
    //                `select max(nameu) into :nmsU  from user_u where nou=NVL(:nousxU,0)`
    const rows = await queryOn(user.schema,
      `SELECT a.*,
              (SELECT MAX(u.nameu) FROM user_u u WHERE u.nou = a.nousx)  AS nms,
              (SELECT MAX(u.nameu) FROM user_u u WHERE u.nou = NVL(a.nousxu, 0)) AS nmsu
         FROM data_ac a
        WHERE a.noa = :noa`, { noa });
    if (!rows.length) return c.json({ ok: false, error: 'not found' }, 404);
    const row = rows[0] as Record<string, unknown>;

    // Opening balances: aggregate AMHSB across all currencies (local-currency amounts in RSM/RSD)
    const balance = { debit: 0, credit: 0, opening: { debit: 0, credit: 0 } };
    try {
      const op = await queryOn<{ M: number; D: number }>(user.schema,
        `SELECT NVL(SUM(NVL(rsm,0)),0) AS m, NVL(SUM(NVL(rsd,0)),0) AS d
           FROM amhsb WHERE noa = :noa`, { noa });
      balance.opening.debit  = Number(op[0]?.M ?? 0);
      balance.opening.credit = Number(op[0]?.D ?? 0);
    } catch { /* AMHSB may be empty */ }

    // Current period movement (only for detail accounts)
    if (Number(row['RTBA']) === 5) {
      try {
        const d = await queryOn<{ V: number }>(user.schema,
          `SELECT NVL(SUM(totals),0) AS v FROM snds WHERE noa = :noa`, { noa });
        const k = await queryOn<{ V: number }>(user.schema,
          `SELECT NVL(SUM(totals),0) AS v FROM sndk WHERE noa = :noa`, { noa });
        balance.debit  = Number(d[0]?.V ?? 0);
        balance.credit = Number(k[0]?.V ?? 0);
      } catch { /* */ }
    }
    return c.json({ ok: true, account: row, balance });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

// Per-currency balances from AMHSB
app.get('/api/accounts/:noa/balances', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  const noa = Number(c.req.param('noa'));
  if (!noa) return c.json({ ok: false, error: 'noa required' }, 400);
  try {
    const rows = await queryOn(user.schema,
      `SELECT a.noa, a.noaml, a.noanom, a.rsm, a.rsd, a.rsma, a.rsda, a.sarsf, a.hall, a.stop,
              m.namem3 AS amlname
         FROM amhsb a LEFT JOIN amlh m ON m.no = a.noaml
        WHERE a.noa = :noa
        ORDER BY a.noaml`, { noa });
    return c.json({ ok: true, rows });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

// Currency permissions block (SNF in the original form is a non-base-table block
// backed by AMHSB — confirmed from TREE.fmb/xxxx.md trigger
// `update amhsb set noanom=:snf.noanom, noa=:snf.noaa where noa=:snoa and NOAML=:snf.NOAML`)
//
// Mapping of form-item names → AMHSB columns:
//   :snf.noaa   → amhsb.noa
//   :snf.noaml  → amhsb.noaml
//   :snf.noanom → amhsb.noanom
//   :snf.halls  → amhsb.hall
//   :snf.hls    → amhsb.hl
//   :snf.skf    → amhsb.skf
//   :snf.cam    is not stored (form-local flag)
app.get('/api/accounts/:noa/snf', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  const noa = Number(c.req.param('noa'));
  if (!noa) return c.json({ ok: false, error: 'noa required' }, 400);
  try {
    const rows = await queryOn(user.schema,
      `SELECT a.noa AS noaa, a.noaml, a.noanom,
              a.hl AS hls, a.hall AS halls, a.skf,
              m.namem3 AS amlname
         FROM amhsb a LEFT JOIN amlh m ON m.no = a.noaml
        WHERE a.noa = :noa
        ORDER BY a.noaml`, { noa });
    return c.json({ ok: true, rows });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

// Add currency permission = create AMHSB row for (noa, noaml)
app.post('/api/accounts/:noa/snf', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  const noa = Number(c.req.param('noa'));
  const body = await c.req.json() as Record<string, unknown>;
  let noaml = Number(body['NOAML']);
  if (!noa || !noaml) return c.json({ ok: false, error: 'noa & noaml required' }, 400);

  // Load TITL params for auto-routing (mirrors WHEN-LIST-CHANGED SNF.NOAML)
  let amlh1 = 0, amlmhz = 1, nomhzn: number | null = null;
  try {
    const t = await queryOn<{AMLH1:number|null; AMLMHZ:number|null; NOMHZN:number|null}>(user.schema,
      `SELECT MAX(amlh1) AS amlh1, MAX(amlmhz) AS amlmhz, MAX(nomhzn) AS nomhzn FROM titl`);
    amlh1  = Number(t[0]?.AMLH1 ?? 0);
    amlmhz = Number(t[0]?.AMLMHZ ?? 1);
    nomhzn = t[0]?.NOMHZN !== undefined && t[0]?.NOMHZN !== null ? Number(t[0]?.NOMHZN) : null;
  } catch { /* */ }

  // Special stock accounts: NOA starts with NOMHZN AND starts with 1231 → force currency to AMLMHZ
  const noaStr = String(noa);
  let forced = false;
  if (nomhzn && noaStr.startsWith(String(nomhzn)) && noaStr.startsWith('1231')) {
    noaml  = amlmhz;
    forced = true;
  }

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    // Uniqueness check (AMHSB)
    const exists = await queryOn<{C:number}>(user.schema,
      `SELECT COUNT(*) AS c FROM amhsb WHERE noa = :noa AND noaml = :noaml`, { noa, noaml });
    if (Number(exists[0]?.C ?? 0) > 0)
      return c.json({ ok: false,
        error: forced ? `عملة المخزون الخاص (${amlmhz}) مسموحة مسبقاً لهذا الحساب` : 'هذه العملة مسموحة مسبقاً لهذا الحساب' }, 409);

    const hallRaw = body['HALLS'] !== undefined ? body['HALLS'] : null;
    const hall    = forced ? null : (hallRaw === null ? null : Number(hallRaw));
    // If single-currency mode (AMLH1=1) or forced-stock, HL is always 0
    const hl = (amlh1 === 1 || forced) ? 0 : (body['HLS'] !== undefined ? Number(body['HLS']) : 0);

    await conn.execute(
      `INSERT INTO amhsb (noa, noaml, noanom, hl, hall, skf, nos)
       VALUES (:noa, :noaml, :noanom, :hl, :hall, :skf, 1)`,
      {
        noa,
        noaml,
        noanom: Number(noaStr + String(noaml)),
        hl,
        hall,
        skf: body['SKF'] !== undefined ? Number(body['SKF']) : null,
      } as never,
      { autoCommit: true }
    );
    return c.json({ ok: true, noaml, forced });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
  finally { await conn.close(); }
});

// PATCH a single SNF flag (HLS = توقيف, HALLS = حساب عام) on an existing AMHSB row.
// This maps to the in-line grid editing in the original Forms SNF block.
app.patch('/api/accounts/:noa/snf/:noaml', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  const noa = Number(c.req.param('noa'));
  const noaml = Number(c.req.param('noaml'));
  if (!noa || !noaml) return c.json({ ok: false, error: 'noa & noaml required' }, 400);
  const body = await c.req.json() as Record<string, unknown>;

  // Map form flag names to AMHSB columns; only whitelist-safe values
  const sets: string[] = [];
  const vals: Record<string, unknown> = { noa, noaml };
  if (body['HLS'] !== undefined) {
    const v = Number(body['HLS']) ? 1 : 0;
    sets.push('hl = :hl');       // :snf.hls → amhsb.hl
    vals['hl'] = v;
  }
  if (body['HALLS'] !== undefined) {
    const v = Number(body['HALLS']) ? 1 : 0;
    sets.push('hall = :hall');   // :snf.halls → amhsb.hall
    vals['hall'] = v;
  }
  if (body['SKF'] !== undefined) {
    sets.push('skf = :skf');
    vals['skf'] = Number(body['SKF']);
  }
  if (!sets.length) return c.json({ ok: false, error: 'no recognised flags to update' }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    const res = await conn.execute(
      `UPDATE amhsb SET ${sets.join(', ')} WHERE noa = :noa AND noaml = :noaml`,
      vals as never
    );
    const affected = (res as { rowsAffected?: number }).rowsAffected ?? 0;
    if (!affected) return c.json({ ok: false, error: 'لم يُعثر على سجل العملة' }, 404);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, rowsAffected: affected });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.delete('/api/accounts/:noa/snf/:noaml', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  const noa = Number(c.req.param('noa'));
  const noaml = Number(c.req.param('noaml'));
  if (!noa || !noaml) return c.json({ ok: false, error: 'noa & noaml required' }, 400);
  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    // Don't allow deleting a currency that already has non-zero balances
    const used = await queryOn<{C:number}>(user.schema,
      `SELECT COUNT(*) AS c FROM amhsb WHERE noa = :noa AND noaml = :noaml
           AND (NVL(rsm,0)<>0 OR NVL(rsd,0)<>0 OR NVL(rsma,0)<>0 OR NVL(rsda,0)<>0)`, { noa, noaml });
    if (Number(used[0]?.C ?? 0) > 0)
      return c.json({ ok: false, error: 'لا يمكن حذف العملة — توجد أرصدة مرتبطة بها' }, 400);
    await conn.execute(`DELETE FROM amhsb WHERE noa = :noa AND noaml = :noaml`,
      { noa, noaml } as never, { autoCommit: true });
    return c.json({ ok: true });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
  finally { await conn.close(); }
});

app.post('/api/accounts', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);

  // Permission check: INS on TREE screen
  const permErr = await ensurePermission(user, TREE_SCREEN, 'ins');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const body = await c.req.json() as Record<string, unknown>;
  const noa = Number(body['NOA']);
  const namea = String(body['NAMEA'] || '').trim();
  const typea = Number(body['TYPEA'] || 0);
  const rtba = Number(body['RTBA'] || 0);
  if (!noa)   return c.json({ ok: false, error: 'رقم الحساب مطلوب' }, 400);
  if (!namea) return c.json({ ok: false, error: 'اسم الحساب مطلوب' }, 400);
  if (!rtba)  return c.json({ ok: false, error: 'رتبة الحساب مطلوبة' }, 400);

  // Uniqueness: NOA
  const dup = await queryOn<{C:number}>(user.schema,
    `SELECT COUNT(*) AS c FROM data_ac WHERE noa = :noa`, { noa });
  if (Number(dup[0]?.C ?? 0) > 0)
    return c.json({ ok: false, error: `رقم الحساب ${noa} موجود مسبقاً` }, 409);

  // Uniqueness: NAMEA under same TYPEA (mirrors original form)
  const dupName = await queryOn<{C:number}>(user.schema,
    `SELECT COUNT(*) AS c FROM data_ac WHERE namea = :namea AND NVL(typea,0) = :typea`,
    { namea, typea });
  if (Number(dupName[0]?.C ?? 0) > 0)
    return c.json({ ok: false, error: `الاسم "${namea}" مقيد مسبقاً تحت نفس الحساب الرئيسي` }, 409);

  // TWKFX permission: 3-level freeze
  //   1 = ceiling (السقف)
  //   2 = partial (freeze debits / warn on credits)
  //   3 = full freeze — requires STATU>0 or USER_U.USX>0
  const twkfx = body['TWKFX'] !== undefined ? Number(body['TWKFX']) : 0;
  if (twkfx === 3 && !user.isAdmin && !(user.usx && user.usx > 0))
    return c.json({ ok: false, error: 'ليس لديك صلاحية التجميد الكامل للحساب (مستوى 3) — يتطلب USX' }, 403);
  if (twkfx < 0 || twkfx > 3)
    return c.json({ ok: false, error: 'قيمة TWKFX غير صالحة (المسموح: 0,1,2,3)' }, 400);

  // NOYSOFT uniqueness under same TYPEA (only for detail accounts rtba=5)
  const noysoft = body['NOYSOFT'] !== undefined && body['NOYSOFT'] !== null ? Number(body['NOYSOFT']) : null;
  if (rtba === 5 && noysoft && noysoft > 0) {
    const dupNoysoft = await queryOn<{N: number; NA: string}>(user.schema,
      `SELECT noa AS n, namea AS na FROM data_ac
        WHERE noa <> :noa AND NVL(typea,0) = :typea AND rtba = 5
          AND NVL(noysoft,0) = :noysoft AND ROWNUM = 1`,
      { noa, typea, noysoft });
    if (dupNoysoft.length)
      return c.json({ ok: false,
        error: `الرقم ${noysoft} (NOYSOFT) مقيد مسبقاً للحساب ${dupNoysoft[0].N} — ${dupNoysoft[0].NA}` }, 409);
  }

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const fields = ['noa','namea','typea','rtba','ahsar','tsys','amlhh',
                    'noysoft','noysofr','nosndok','twkfx','hall','nokyed','nog','noan',
                    'rsm','rsd','rsma','rsda','memoh'];
    const vals: Record<string, unknown> = {};
    fields.forEach(f => { if (body[f.toUpperCase()] !== undefined) vals[f] = body[f.toUpperCase()]; });

    // Auto-set NOKYED=1 when freezing (TWKFX>0) — original: :NOKYED:=1
    if (twkfx > 0) vals['nokyed'] = 1;

    // PRE-INSERT: NOG=1 for detail asset accounts starting with 122 or 221
    if (rtba === 5 && !vals['nog']) {
      const typeaStr = String(typea);
      if (typeaStr.startsWith('122') || typeaStr.startsWith('221')) vals['nog'] = 1;
    }

    // NOAN auto-generate if not provided (sequence within parent TYPEA)
    if (vals['noan'] === undefined || vals['noan'] === null) {
      const nextAn = await queryOn<{N: number}>(user.schema,
        `SELECT NVL(MAX(noan),0)+1 AS n FROM data_ac WHERE typea = :typea`, { typea });
      vals['noan'] = Number(nextAn[0]?.N ?? 1);
    }

    // Audit
    Object.assign(vals, auditInsert(user));
    const cols = Object.keys(vals);
    const sql = `INSERT INTO data_ac (${cols.join(',')}) VALUES (${cols.map(k=>':'+k).join(',')})`;
    await conn.execute(sql, vals as never);

    // Auto-create AMHSB opening balance row for the default currency (mirrors original post-insert)
    const amlhh = vals['amlhh'] ? Number(vals['amlhh']) : 1;
    const rsm = vals['rsm'] ? Number(vals['rsm']) : null;
    const rsd = vals['rsd'] ? Number(vals['rsd']) : null;
    const rsma = vals['rsma'] ? Number(vals['rsma']) : null;
    const rsda = vals['rsda'] ? Number(vals['rsda']) : null;
    if (rtba === 5 && (rsm || rsd || rsma || rsda)) {
      try {
        await conn.execute(
          `INSERT INTO amhsb (noa, noaml, noanom, rsm, rsd, rsma, rsda, hall, nos)
           VALUES (:noa, :noaml, :noanom, :rsm, :rsd, :rsma, :rsda, :hall, 1)`,
          {
            noa, noaml: amlhh, noanom: Number(String(noa) + String(amlhh)),
            rsm, rsd, rsma, rsda,
            hall: vals['hall'] ?? null,
          } as never
        );
      } catch { /* AMHSB may have schema quirks; non-fatal */ }
    }
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, noa, noan: vals['noan'] });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.put('/api/accounts/:noa', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);

  // Permission check: ED on TREE screen
  const permErr = await ensurePermission(user, TREE_SCREEN, 'ed');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const noa = Number(c.req.param('noa'));
  const body = await c.req.json() as Record<string, unknown>;
  if (!noa) return c.json({ ok: false, error: 'noa required' }, 400);

  // Existence
  const cur = await queryOn<{NOA:number; TWKFX:number|null; RTBA:number|null; AMLHH:number|null;
    NAMEA:string|null; TYPEA:number|null; NOYSOFT:number|null}>(user.schema,
    `SELECT noa, twkfx, rtba, amlhh, namea, typea, noysoft FROM data_ac WHERE noa = :noa`, { noa });
  if (!cur.length) return c.json({ ok: false, error: 'الحساب غير موجود' }, 404);
  const curRow = cur[0];
  const effRtba = body['RTBA'] !== undefined ? Number(body['RTBA']) : Number(curRow.RTBA ?? 0);
  const effTypea = body['TYPEA'] !== undefined ? Number(body['TYPEA']) : Number(curRow.TYPEA ?? 0);

  // Uniqueness: NAMEA under same TYPEA (exclude self)
  if (body['NAMEA'] !== undefined) {
    const namea = String(body['NAMEA'] || '').trim();
    if (!namea) return c.json({ ok: false, error: 'اسم الحساب مطلوب' }, 400);
    const dupName = await queryOn<{C:number}>(user.schema,
      `SELECT COUNT(*) AS c FROM data_ac WHERE namea = :namea AND NVL(typea,0) = :typea AND noa <> :noa`,
      { namea, typea: effTypea, noa });
    if (Number(dupName[0]?.C ?? 0) > 0)
      return c.json({ ok: false, error: `الاسم "${namea}" مقيد مسبقاً تحت نفس الحساب الرئيسي` }, 409);
  }

  // TWKFX permission: 3-level freeze check (only level 3 requires USX)
  if (body['TWKFX'] !== undefined) {
    const newV = Number(body['TWKFX'] || 0);
    if (newV < 0 || newV > 3)
      return c.json({ ok: false, error: 'قيمة TWKFX غير صالحة (المسموح: 0,1,2,3)' }, 400);
    const oldV = Number(curRow.TWKFX ?? 0);
    if (newV === 3 && oldV !== 3 && !user.isAdmin && !(user.usx && user.usx > 0))
      return c.json({ ok: false, error: 'ليس لديك صلاحية التجميد الكامل للحساب (مستوى 3) — يتطلب USX' }, 403);
  }

  // NOYSOFT uniqueness (if changed)
  if (body['NOYSOFT'] !== undefined && effRtba === 5) {
    const newNoysoft = body['NOYSOFT'] === null ? null : Number(body['NOYSOFT']);
    if (newNoysoft && newNoysoft > 0) {
      const dupNoysoft = await queryOn<{N:number; NA:string}>(user.schema,
        `SELECT noa AS n, namea AS na FROM data_ac
          WHERE noa <> :noa AND NVL(typea,0) = :typea AND rtba = 5
            AND NVL(noysoft,0) = :noysoft AND ROWNUM = 1`,
        { noa, typea: effTypea, noysoft: newNoysoft });
      if (dupNoysoft.length)
        return c.json({ ok: false,
          error: `الرقم ${newNoysoft} (NOYSOFT) مقيد مسبقاً للحساب ${dupNoysoft[0].N} — ${dupNoysoft[0].NA}` }, 409);
    }
  }

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    // Pessimistic row lock — mirrors `eddl` procedure:
    //   Select NOa Into Rubbish From data_ac
    //    Where Rowid = :data_a.Rowid  For Update Of noa Nowait
    // If another session is editing this record, Oracle raises ORA-00054.
    try {
      await conn.execute(
        `SELECT noa FROM data_ac WHERE noa = :noa FOR UPDATE OF noa NOWAIT`,
        { noa } as never);
    } catch (e) {
      const msg = (e as Error).message || '';
      if (msg.includes('ORA-00054'))
        return c.json({ ok: false, error: 'الحساب قيد التعديل من مستخدم آخر — حاول لاحقاً' }, 409);
      throw e;
    }

    const fields = ['namea','typea','rtba','ahsar','tsys','amlhh',
                    'noysoft','noysofr','nosndok','twkfx','hall','nokyed','nog',
                    'rsm','rsd','rsma','rsda','memoh'];
    const sets: string[] = []; const vals: Record<string, unknown> = { noa };
    fields.forEach(f => {
      const v = body[f.toUpperCase()];
      if (v !== undefined) { sets.push(`${f} = :${f}`); vals[f] = v; }
    });

    // Auto-set NOKYED=1 when TWKFX transitions to >0 (mirrors original trigger)
    if (body['TWKFX'] !== undefined) {
      const newV = Number(body['TWKFX'] || 0);
      const oldV = Number(curRow.TWKFX ?? 0);
      if (newV > 0 && oldV === 0 && vals['nokyed'] === undefined) {
        sets.push('nokyed = :nokyed'); vals['nokyed'] = 1;
      }
    }

    if (!sets.length) return c.json({ ok: false, error: 'no fields' }, 400);

    // Audit scalar fields
    const aud = auditUpdate(user);
    Object.entries(aud).forEach(([k,v]) => { sets.push(`${k} = :${k}`); vals[k] = v; });
    // NED — edit counter, increments on every UPDATE (original: max(nvl(ned,0))+1)
    sets.push('ned = NVL(ned,0) + 1');

    await conn.execute(`UPDATE data_ac SET ${sets.join(', ')} WHERE noa = :noa`, vals as never);

    // Sync AMHSB for opening balances if provided (default currency)
    if ((Number(curRow.RTBA) === 5 || Number(body['RTBA']) === 5) &&
        (body['RSM'] !== undefined || body['RSD'] !== undefined ||
         body['RSMA'] !== undefined || body['RSDA'] !== undefined)) {
      const amlhh = body['AMLHH'] !== undefined ? Number(body['AMLHH']) : Number(curRow.AMLHH ?? 1);
      const noanom = Number(String(noa) + String(amlhh));
      const chk = await conn.execute<{C:number}>(
        `SELECT COUNT(*) AS c FROM amhsb WHERE noa = :noa AND noaml = :noaml`,
        { noa, noaml: amlhh } as never, { outFormat: 4002 });
      const exists = Number(((chk.rows as {C:number}[])[0]?.C) ?? 0) > 0;
      const amhsbVals = {
        noa, noaml: amlhh, noanom,
        rsm:  body['RSM']  !== undefined ? (body['RSM']  === null ? null : Number(body['RSM']))  : null,
        rsd:  body['RSD']  !== undefined ? (body['RSD']  === null ? null : Number(body['RSD']))  : null,
        rsma: body['RSMA'] !== undefined ? (body['RSMA'] === null ? null : Number(body['RSMA'])) : null,
        rsda: body['RSDA'] !== undefined ? (body['RSDA'] === null ? null : Number(body['RSDA'])) : null,
      };
      try {
        if (exists) {
          await conn.execute(
            `UPDATE amhsb SET rsm = :rsm, rsd = :rsd, rsma = :rsma, rsda = :rsda
              WHERE noa = :noa AND noaml = :noaml`,
            amhsbVals as never);
        } else if (amhsbVals.rsm || amhsbVals.rsd || amhsbVals.rsma || amhsbVals.rsda) {
          await conn.execute(
            `INSERT INTO amhsb (noa, noaml, noanom, rsm, rsd, rsma, rsda, nos)
             VALUES (:noa, :noaml, :noanom, :rsm, :rsd, :rsma, :rsda, 1)`,
            amhsbVals as never);
        }
      } catch { /* non-fatal */ }
    }

    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.delete('/api/accounts/:noa', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);

  // Permission check: DE on TREE screen
  const permErr = await ensurePermission(user, TREE_SCREEN, 'de');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const noa = Number(c.req.param('noa'));
  if (!noa) return c.json({ ok: false, error: 'noa required' }, 400);
  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();

  // Single helper: returns count of rows, tolerant of missing tables
  const countOn = async (sql: string, params: Record<string, unknown>): Promise<number> => {
    try {
      const r = await queryOn<{C:number}>(user.schema, sql, params);
      return Number(r[0]?.C ?? 0);
    } catch { return 0; }
  };

  try {
    // 1) Children (direct)
    if (await countOn(`SELECT COUNT(*) AS c FROM data_ac WHERE typea = :noa`, { noa }) > 0)
      return c.json({ ok: false, error: 'الحساب يحتوي على حسابات فرعية — لا يمكن الحذف' }, 400);

    // 2) AMHSB opening balances (non-zero) — original del_s checks this before allowing delete
    if (await countOn(
      `SELECT COUNT(*) AS c FROM amhsb WHERE noa = :noa
         AND (NVL(rsm,0)<>0 OR NVL(rsd,0)<>0 OR NVL(rsma,0)<>0 OR NVL(rsda,0)<>0)`, { noa }) > 0)
      return c.json({ ok: false, error: 'يوجد أرصدة افتتاحية مرتبطة بالحساب — لا يمكن الحذف' }, 400);

    // 4) Transaction usage: SNDS/SNDK (current period vouchers)
    if ((await countOn(`SELECT COUNT(*) AS c FROM snds WHERE noa = :noa`, { noa }))
      + (await countOn(`SELECT COUNT(*) AS c FROM sndk WHERE noa = :noa`, { noa })) > 0)
      return c.json({ ok: false, error: 'يوجد حركات (سندات صرف/قبض) مرتبطة بالحساب — لا يمكن الحذف' }, 400);

    // 5) Original del_s checks (extended) — each in its own try so a missing/tricky table
    //    doesn't block the whole delete when it actually has no rows
    const extra: Array<[string, string, string]> = [
      // [table, column, label]
      ['hwm',      'noa',    'حركات مخزنية (HWM)'],
      ['data_bl',  'noa',    'قوالب ميزانية (DATA_BL)'],
      ['swdar',    'noa',    'دورة مبيعات/مشتريات (SWDAR)'],
      ['data_br1', 'noa',    'فروع (DATA_BR1)'],
      ['mshri',    'noa',    'عقود مشتريات (MSHRI)'],
      ['mshri',    'noamlk', 'عقود عملاء (MSHRI)'],
      ['mzt',      'mhs',    'ميزانيات مزوّد (MZT)'],
      ['user_u',   'noah',   'مستخدمون مربوطون بهذا الحساب (USER_U.NOAH)'],
    ];
    for (const [tab, col, label] of extra) {
      if (await countOn(`SELECT COUNT(*) AS c FROM ${tab} WHERE ${col} = :noa`, { noa }) > 0)
        return c.json({ ok: false, error: `يوجد ${label} — لا يمكن حذف الحساب` }, 400);
    }

    // 6) Lock then cleanup — mirrors eddl FOR UPDATE NOWAIT before DELETE
    try {
      await conn.execute(
        `SELECT noa FROM data_ac WHERE noa = :noa FOR UPDATE OF noa NOWAIT`,
        { noa } as never);
    } catch (e) {
      const msg = (e as Error).message || '';
      if (msg.includes('ORA-00054'))
        return c.json({ ok: false, error: 'الحساب قيد التعديل من مستخدم آخر — لا يمكن الحذف' }, 409);
      throw e;
    }
    // Mirrors original: update data_ac set tsys=2 where noa=... (delete-in-progress marker)
    try { await conn.execute(`UPDATE data_ac SET tsys = 2 WHERE noa = :noa`, { noa } as never); } catch { /* */ }
    try { await conn.execute(`DELETE FROM amhsb WHERE noa = :noa`, { noa } as never); } catch { /* */ }
    await conn.execute(`DELETE FROM data_ac WHERE noa = :noa`, { noa } as never);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

// =============================================
// /api/voucher/:type  — SNDS/SNDK full CRUD
// TYPEMS mapping (original PL/SQL in sndk.md/snds.md):
//   SNDK (receipt)      → TYPEMS = 4  (noms||typems<>:sndk.nos||4)
//   SNDS (disbursement) → TYPEMS = 5  (noms||typems<>:sndk.nos||5)
// =============================================
// VCFG — Voucher Configuration per type.
//   mt   = master table
//   dt   = detail table
//   tc   = TYPEMS code written into the master row
//   scr  = DATA_ACM.NAMEF for USERGN permission lookup
const VCFG: Record<string, { mt: string; dt: string; tc: number; scr: string }> = {
  snds: { mt: 'SNDS', dt: 'SNDSF', tc: 5, scr: 'SNDS.FMX' },
  sndk: { mt: 'SNDK', dt: 'SNDKF', tc: 4, scr: 'SNDK.FMX' },
};

// getAkfaMaxDate is imported from ./server/validation (shared)
const getAkfaMaxDate = sharedGetAkfaMaxDate;

// =============================================
// /api/lov            — list all registered LOVs
// /api/lov/:name      — execute a single LOV with ?q= filter
//
// Canonical lookup endpoint used by <app-lov-picker>. Centralizes the
// 16+ "search for an account / currency / cost-center" queries that used
// to exist as bespoke routes.
// =============================================
app.get('/api/lov', (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  return c.json({ ok: true, lovs: listLovs() });
});

app.get('/api/lov/:name', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const name = String(c.req.param('name') || '').toLowerCase();
  if (!LOV_REGISTRY[name]) {
    return c.json({ ok: false, error: `LOV غير معروف: ${name}` }, 404);
  }

  const q     = c.req.query('q')     ?? '';
  const limit = Number(c.req.query('limit') ?? 50);
  const rtbaRaw = c.req.query('rtba');
  const rtbaNum = rtbaRaw == null || rtbaRaw === '' ? null : Number(rtbaRaw);
  const extraBinds: Record<string, unknown> = {};
  if (rtbaNum != null && Number.isFinite(rtbaNum)) extraBinds['rtba'] = rtbaNum;

  try {
    const result = await executeLov(user.schema, name, q, limit, extraBinds);
    // `items` alias keeps the old frontends (SNDS/SNDK/TREE + LovPicker) working;
    // new code should prefer the explicit `rows`/`columns`/`display` triple.
    return c.json({ ok: true, ...result, items: result.rows });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

const ACCOUNT_STATEMENT_TYPE_LABELS: Record<number, string> = {
  1: 'قيد يومي',
  2: 'قيد',
  3: 'فوارق عملة',
  4: 'سند قبض',
  5: 'سند صرف',
  10: 'قيد تحويل',
  18: 'إقفال',
};

function ymdParam(value: string | undefined): string | null {
  const v = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

app.get('/api/reports/account-statement', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const q = c.req.query.bind(c.req);
  const noa = Number(q('noa') ?? q('account') ?? 0);
  if (!noa) return c.json({ ok: false, error: 'رقم الحساب مطلوب' }, 400);

  const dateFrom = ymdParam(q('dateFrom'));
  const dateTo = ymdParam(q('dateTo'));
  const noaml = Number(q('currency') ?? q('noaml') ?? 0);
  const mrt = Number(q('mrt') ?? 0);
  const memo = String(q('q') ?? q('memo') ?? '').trim().toUpperCase();
  const limitRaw = Number(q('limit') ?? 2000);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 2000, 1), 10000);

  const baseWhere = ['d.noa = :noa'];
  const rowWhere = [...baseWhere];
  const openingWhere = [...baseWhere];
  const rowBinds: Record<string, unknown> = { noa };
  const openingBinds: Record<string, unknown> = { noa };

  if (dateFrom) {
    rowBinds['dateFrom'] = dateFrom;
    openingBinds['dateFrom'] = dateFrom;
    rowWhere.push(`d.datemo >= TO_DATE(:dateFrom, 'YYYY-MM-DD')`);
    openingWhere.push(`d.datemo < TO_DATE(:dateFrom, 'YYYY-MM-DD')`);
  }
  if (dateTo) {
    rowBinds['dateTo'] = dateTo;
    rowWhere.push(`d.datemo < TO_DATE(:dateTo, 'YYYY-MM-DD') + 1`);
  }
  if (noaml > 0) {
    rowBinds['noaml'] = noaml;
    openingBinds['noaml'] = noaml;
    rowWhere.push(`NVL(d.noaml,1) = :noaml`);
    openingWhere.push(`NVL(d.noaml,1) = :noaml`);
  }
  if (mrt > 0) {
    rowBinds['mrt'] = mrt;
    openingBinds['mrt'] = mrt;
    rowWhere.push(`NVL(d.mrt,0) = :mrt`);
    openingWhere.push(`NVL(d.mrt,0) = :mrt`);
  }
  if (memo) {
    rowBinds['memo'] = `%${memo}%`;
    rowWhere.push(`UPPER(NVL(d.memos,'')) LIKE :memo`);
  }

  try {
    const accountRows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT noa, namea, NVL(typea,0) AS typea, NVL(rtba,0) AS rtba,
              NVL(amlhh,1) AS amlhh, ahsar
         FROM data_ac
        WHERE noa = :noa`,
      { noa },
    );
    if (!accountRows.length) return c.json({ ok: false, error: 'الحساب غير موجود' }, 404);

    let opening = 0;
    let openingAml = 0;
    if (dateFrom) {
      const openingRows = await queryOn<{ BALANCE: number; BALANCEAML: number }>(
        user.schema,
        `SELECT NVL(SUM(NVL(d.mdin,0)-NVL(d.dan,0)),0) AS balance,
                NVL(SUM(NVL(d.mdinaml,0)-NVL(d.danaml,0)),0) AS balanceaml
           FROM datak d
          WHERE ${openingWhere.join(' AND ')}`,
        openingBinds,
      );
      opening = Number(openingRows[0]?.BALANCE ?? 0);
      openingAml = Number(openingRows[0]?.BALANCEAML ?? 0);
    }

    const summaryRows = await queryOn<{
      CNT: number; DEBIT: number; CREDIT: number; DEBITAML: number; CREDITAML: number;
    }>(
      user.schema,
      `SELECT COUNT(*) AS cnt,
              NVL(SUM(NVL(d.mdin,0)),0) AS debit,
              NVL(SUM(NVL(d.dan,0)),0) AS credit,
              NVL(SUM(NVL(d.mdinaml,0)),0) AS debitaml,
              NVL(SUM(NVL(d.danaml,0)),0) AS creditaml
         FROM datak d
        WHERE ${rowWhere.join(' AND ')}`,
      rowBinds,
    );
    const summary = summaryRows[0] ?? { CNT: 0, DEBIT: 0, CREDIT: 0, DEBITAML: 0, CREDITAML: 0 };

    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT *
         FROM (
           SELECT x.*,
                  :opening + SUM(x.delta) OVER (
                    ORDER BY x.datemo, x.nok, x.typems, x.noms, x.recno, x.rid
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                  ) AS balance,
                  :openingAml + SUM(x.deltaaml) OVER (
                    ORDER BY x.datemo, x.nok, x.typems, x.noms, x.recno, x.rid
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                  ) AS balanceaml
             FROM (
               SELECT TO_CHAR(d.datemo, 'YYYY-MM-DD') AS datemo,
                      d.nok, d.noms, d.nomsr, d.typems, d.recno,
                      NVL(d.noaml,1) AS noaml, m.namem3 AS noaml_name,
                      NVL(d.sarsf,1) AS sarsf,
                      NVL(d.mdin,0) AS mdin, NVL(d.dan,0) AS dan,
                      NVL(d.mdinaml,0) AS mdinaml, NVL(d.danaml,0) AS danaml,
                      NVL(d.mdin,0)-NVL(d.dan,0) AS delta,
                      NVL(d.mdinaml,0)-NVL(d.danaml,0) AS deltaaml,
                      d.memos, NVL(d.mrt,0) AS mrt, r.namem AS mrt_name,
                      NVL(d.mrhl,0) AS mrhl, NVL(d.kdant,0) AS kdant,
                      ROW_NUMBER() OVER (
                        ORDER BY d.datemo, d.nok, d.typems, d.noms, d.recno,
                                 d.nomsr, d.noaml, d.mrt, d.mdin, d.dan, NVL(d.memos,'')
                      ) AS rid
                 FROM datak d
                 LEFT JOIN amlh m ON m.no = d.noaml
                 LEFT JOIN mrt r ON r.nos = d.mrt
                WHERE ${rowWhere.join(' AND ')}
             ) x
            ORDER BY x.datemo, x.nok, x.typems, x.noms, x.recno, x.rid
         )
        WHERE ROWNUM <= :lim`,
      { ...rowBinds, opening, openingAml, lim: limit },
    );

    return c.json({
      ok: true,
      schema: user.schema,
      account: accountRows[0],
      filters: { noa, dateFrom, dateTo, noaml: noaml || null, mrt: mrt || null, memo: memo || null, limit },
      opening,
      openingAml,
      summary: {
        count: Number(summary.CNT ?? 0),
        debit: Number(summary.DEBIT ?? 0),
        credit: Number(summary.CREDIT ?? 0),
        debitAml: Number(summary.DEBITAML ?? 0),
        creditAml: Number(summary.CREDITAML ?? 0),
        ending: opening + Number(summary.DEBIT ?? 0) - Number(summary.CREDIT ?? 0),
        endingAml: openingAml + Number(summary.DEBITAML ?? 0) - Number(summary.CREDITAML ?? 0),
        limited: Number(summary.CNT ?? 0) > rows.length,
      },
      rows: rows.map((row) => ({
        ...row,
        TYPEMS_LABEL: ACCOUNT_STATEMENT_TYPE_LABELS[Number(row['TYPEMS'] ?? 0)] ?? `نوع ${Number(row['TYPEMS'] ?? 0) || ''}`.trim(),
      })),
    });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

// Read-only report backend for REPSK/REPSS.
// Keeps voucher reports out of the generic SQL table reader and mirrors the
// old report filters: date range, text/account search, posted state, and amount.
app.get('/api/voucher/:type/search', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const cfg = VCFG[c.req.param('type').toLowerCase()];
  if (!cfg) return c.json({ ok: false, error: 'unknown type' }, 400);

  const q = c.req.query.bind(c.req);
  const binds: Record<string, unknown> = {};
  const where: string[] = [];
  const addDate = (key: 'dateFrom' | 'dateTo', op: '>=' | '<') => {
    const value = q(key);
    if (!value) return;
    if (op === '<') {
      where.push(`v.dates < TO_DATE(:${key}, 'YYYY-MM-DD') + 1`);
    } else {
      where.push(`v.dates >= TO_DATE(:${key}, 'YYYY-MM-DD')`);
    }
    binds[key] = value;
  };
  addDate('dateFrom', '>=');
  addDate('dateTo', '<');

  const search = (q('memo') || q('q') || '').trim();
  const searchNo = Number(search);
  const hasSearchNo = search && Number.isFinite(searchNo) && searchNo > 0 ? 1 : 0;
  binds['hasSearchNo'] = hasSearchNo;
  binds['searchNo'] = hasSearchNo ? searchNo : -1;
  if (search) {
    binds['memo'] = `%${search.toUpperCase()}%`;
    where.push(`(
      UPPER(NVL(v.memos,'')) LIKE :memo
      OR UPPER(NVL(v.nameb,'')) LIKE :memo
      OR TO_CHAR(v.nos) LIKE :memo
      OR TO_CHAR(v.noson) LIKE :memo
      OR TO_CHAR(v.noms) LIKE :memo
      OR TO_CHAR(v.nok) LIKE :memo
    )`);
  }

  const posted = q('posted');
  if (posted === '1') where.push('NVL(v.mrhl,0) = 0');
  else if (posted === '0') where.push('NVL(v.mrhl,0) <> 0');

  const noa = Number(q('noa'));
  if (noa > 0) {
    binds['noa'] = noa;
    where.push(`(v.noa = :noa OR EXISTS (SELECT 1 FROM ${cfg.dt} f WHERE f.nos = v.nos AND f.noa = :noa))`);
  }

  const nosn = Number(q('nosn'));
  if (nosn > 0) {
    binds['nosn'] = nosn;
    where.push('v.nosn = :nosn');
  }

  const minAmount = Number(q('minAmount'));
  if (minAmount > 0) {
    binds['minAmount'] = minAmount;
    where.push('NVL(v.totals,0) >= :minAmount');
  }

  const maxAmount = Number(q('maxAmount'));
  if (maxAmount > 0) {
    binds['maxAmount'] = maxAmount;
    where.push('NVL(v.totals,0) <= :maxAmount');
  }

  const limit = Math.min(Number(q('limit') ?? 300), 1000);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const rows = await queryOn(
      user.schema,
      `SELECT * FROM (
         SELECT v.nos, v.noson, v.noms, v.dates, v.noa, a.namea,
                v.nosn,
                (SELECT MAX(c.namea) FROM data_ac c WHERE c.nosndok = v.nosn) AS cashbox_name,
                NVL(v.totals,0) AS totals, NVL(v.totals2,0) AS totals2,
                NVL(v.mrhl,0) AS mrhl, v.nok, v.memos, v.nameb,
                v.nohandshk, v.nobnks, v.sarsf,
                (SELECT COUNT(*) FROM ${cfg.dt} f WHERE f.nos = v.nos) AS line_count
           FROM ${cfg.mt} v
           LEFT JOIN data_ac a ON a.noa = v.noa
          ${whereSql}
          ORDER BY CASE
                     WHEN :hasSearchNo = 1
                      AND (v.nos = :searchNo OR v.noson = :searchNo OR v.noms = :searchNo OR v.nok = :searchNo)
                     THEN 0 ELSE 1
                   END,
                   v.dates DESC, v.nos DESC
       ) WHERE ROWNUM <= :lim`,
      { ...binds, lim: limit },
    );
    return c.json({ ok: true, rows, count: rows.length, type: cfg.mt });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.get('/api/voucher/:type', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  const cfg = VCFG[c.req.param('type').toLowerCase()];
  if (!cfg) return c.json({ ok: false, error: 'unknown type' }, 400);
  const nos = Number(c.req.query('nos'));
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);
  try {
    const master = await queryOn(user.schema,
      `SELECT v.*, a.namea AS namea
         FROM ${cfg.mt} v
         LEFT JOIN data_ac a ON a.noa = v.noa
        WHERE v.nos = :nos`,
      { nos });
    if (!master.length) return c.json({ ok: false, error: 'not found' }, 404);
    const details = await queryOn(user.schema,
      `SELECT d.*, a.namea AS nameaf
         FROM ${cfg.dt} d
         LEFT JOIN data_ac a ON a.noa = d.noa
        WHERE d.nos = :nos
        ORDER BY d.recno, d.rowid`,
      { nos });
    return c.json({ ok: true, master: master[0], details });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

// =============================================
// /api/voucher/:type/print — SNDS/SNDK printable HTML
//
// Mirrors the legacy `prn` PL/SQL from SNDS.FMB / SNDK.FMB (CONT.PR button).
// Returns a standalone Arabic-RTL HTML page with header + detail grid
// suitable for Ctrl+P. Used by the print button on the SNDS/SNDK screens.
// =============================================
app.get('/api/voucher/:type/print', async (c) => {
  const user = readUser(c);
  if (!user) return c.text('غير مصرح', 401);
  const type = c.req.param('type').toLowerCase();
  const cfg = VCFG[type];
  if (!cfg) return c.text('نوع سند غير معروف', 400);
  const nos = Number(c.req.query('nos'));
  if (!nos) return c.text('nos مطلوب', 400);

  try {
    const mRows = await queryOn<Record<string, unknown>>(
      user.schema, `SELECT * FROM ${cfg.mt} WHERE nos = :nos`, { nos });
    if (!mRows.length) return c.text('السند غير موجود', 404);
    const m = mRows[0]!;
    const details = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT d.noa, d.recno, d.toam, d.toaa, d.memos,
              d.noaml, d.sarsf, d.mrt, a.namea AS noaf_namea
         FROM ${cfg.dt} d LEFT JOIN data_ac a ON a.noa = d.noa
        WHERE d.nos = :nos ORDER BY d.recno`,
      { nos });

    // Fetch header account name
    const noa = Number(m['NOA'] ?? 0);
    let headerName = '—';
    if (noa) {
      const arow = await queryOn<{NAMEA:string}>(
        user.schema, `SELECT namea FROM data_ac WHERE noa = :n`, { n: noa });
      headerName = arow[0]?.NAMEA ?? `#${noa}`;
    }

    const fmt = (n: unknown) =>
      Number(n ?? 0).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const esc = (s: unknown) =>
      String(s ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[ch]!));
    const dateStr = m['DATES'] ? new Date(String(m['DATES'])).toLocaleDateString('ar-EG') : '—';
    const posted = legacyMrhlIsPosted(m['MRHL']);
    const isReceipt = type === 'sndk';
    const title = isReceipt ? 'سند قبض' : 'سند صرف';

    const rowsHtml = details.map((d, i) => `
      <tr>
        <td class="c">${i + 1}</td>
        <td><strong>${esc(d['NOA'])}</strong> · ${esc(d['NOAF_NAMEA'] ?? '—')}</td>
        <td class="n">${fmt(d['TOAM'])}</td>
        <td class="n">${fmt(d['TOAA'] ?? 0)}</td>
        <td>${esc(d['MEMOS'] ?? '')}</td>
      </tr>
    `).join('');
    const totalLocal   = details.reduce((s, d) => s + Number(d['TOAM'] ?? 0), 0);
    const totalForeign = details.reduce((s, d) => s + Number(d['TOAA'] ?? 0), 0);

    const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${title} رقم ${esc(m['NOS'])}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Tahoma', 'Arial', sans-serif; padding: 1rem; color: #0f172a; }
    h1 { font-size: 1.4rem; margin: 0 0 0.5rem; text-align: center; }
    .hdr { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem 1rem;
           border: 1px solid #333; padding: 0.75rem; margin-bottom: 1rem; border-radius: 4px; }
    .hdr div { font-size: 0.9rem; }
    .hdr b { color: #475569; display: block; font-size: 0.75rem; }
    .memo { grid-column: 1 / -1; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { border: 1px solid #94a3b8; padding: 0.3rem 0.5rem; }
    th { background: #e2e8f0; }
    .c { text-align: center; }
    .n { text-align: left; font-variant-numeric: tabular-nums; }
    tfoot td { font-weight: bold; background: #f1f5f9; }
    .status { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 12px;
              font-size: 0.8rem; margin-top: 0.3rem;
              ${posted ? 'background:#dcfce7;color:#166534;' : 'background:#fef3c7;color:#92400e;'} }
    .footer { margin-top: 2rem; display: grid; grid-template-columns: repeat(3, 1fr);
              gap: 2rem; font-size: 0.85rem; }
    .sig { border-top: 1px solid #333; padding-top: 0.4rem; text-align: center; }
    @media print { body { padding: 0.5rem; } .noprint { display: none; } }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div class="hdr">
    <div><b>رقم السند</b>${esc(m['NOS'])}</div>
    <div><b>التاريخ</b>${esc(dateStr)}</div>
    <div><b>${isReceipt ? 'المُسلِّم' : 'المستفيد'}</b>${esc(m['NOA'])} · ${esc(headerName)}</div>
    <div><b>المبلغ</b>${fmt(m['TOTALS'])}</div>
    <div class="memo"><b>البيان</b>${esc(m['MEMOS'] ?? m['MEMOS1'] ?? '')}
      <span class="status">${posted ? 'مُرحّل' : 'غير مُرحّل'}</span></div>
  </div>
  <table>
    <thead>
      <tr>
        <th style="width:3rem">#</th>
        <th>الحساب المقابل</th>
        <th style="width:7rem">المبلغ المحلي</th>
        <th style="width:7rem">المبلغ الأجنبي</th>
        <th>البيان</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
    <tfoot>
      <tr>
        <td colspan="2" class="c">الإجماليات</td>
        <td class="n">${fmt(totalLocal)}</td>
        <td class="n">${fmt(totalForeign)}</td>
        <td></td>
      </tr>
    </tfoot>
  </table>
  <div class="footer">
    <div class="sig">${isReceipt ? 'المُسلِّم' : 'المستلم'}</div>
    <div class="sig">المحاسب</div>
    <div class="sig">المدير</div>
  </div>
  <div class="noprint" style="text-align:center;margin-top:1.5rem">
    <button onclick="window.print()" style="padding:0.5rem 1.5rem;font-size:1rem;cursor:pointer">
      طباعة
    </button>
  </div>
</body>
</html>`;
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(html);
  } catch (e) {
    return c.text('خطأ: ' + (e as Error).message, 500);
  }
});

app.post('/api/voucher/:type', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  const cfg = VCFG[c.req.param('type').toLowerCase()];
  if (!cfg) return c.json({ ok: false, error: 'unknown type' }, 400);

  // Permission check: INS on this screen
  const permErr = await ensurePermission(user, cfg.scr, 'ins');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const { master, details } = await c.req.json() as { master: Record<string,unknown>; details: Record<string,unknown>[] };

  // ---- Business rule validations (shared helpers in ./server/validation) ----
  // R1: Future date check
  const dateErr = ensureNotFutureDate(master['DATES']);
  if (dateErr) return c.json({ ok: false, error: dateErr }, 422);
  const dateVal = new Date(String(master['DATES']));

  // R2: Duplicate NOMS1 check (unique across the table)
  if (master['NOMS1']) {
    const dupErr = await ensureNomsUnique(user.schema, cfg.mt, Number(master['NOMS1']));
    if (dupErr) return c.json({ ok: false, error: dupErr }, 422);
  }

  // R3: Required fields
  if (!master['NOA']) return c.json({ ok: false, error: 'يجب تحديد الحساب الرئيسي' }, 422);
  if (!master['NOSN']) return c.json({ ok: false, error: 'يجب تحديد الصندوق' }, 422);
  if (!master['TOTALS'] || Number(master['TOTALS']) <= 0)
    return c.json({ ok: false, error: 'يجب إدخال المبلغ' }, 422);

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {

    const year = dateVal.getFullYear();
    const nosonR = await conn.execute<{N:number}>(
      `SELECT NVL(MAX(noson),0)+1 AS n FROM ${cfg.mt} WHERE TO_CHAR(dates,'YYYY')=:y`,
      { y: String(year) }, { outFormat: 4002 });
    const noson = ((nosonR.rows as {N:number}[])[0]?.N) || 1;
    const nos = Number(String(noson) + String(year));
    const nomsR = await conn.execute<{N:number}>(`SELECT NVL(MAX(noms),0)+1 AS n FROM ${cfg.mt}`, {}, { outFormat: 4002 });
    const noms = ((nomsR.rows as {N:number}[])[0]?.N) || 1;

    // Audit INSERT: DI=sysdate, NOUSX=user, PCI=client, NED=0
    const aud = auditInsert(user);
    const posting = await legacyInsertPosting(conn, dateVal);

    await conn.execute(
      `INSERT INTO ${cfg.mt} (nos,noson,dates,noa,noaml,nosn,totals,totals2,sarsf,memos,mrhl,nok,mrt,nohandshk,dateshk,nameb,noms,typems,
                               di,nousx,pci,ned)
       VALUES (:nos,:noson,:dates,:noa,:noaml,:nosn,:totals,:totals2,:sarsf,:memos,:mrhl,:nok,:mrt,:nohandshk,:dateshk,:nameb,:noms,:typems,
                :di,:nousx,:pci,:ned)`,
      {
        nos, noson, dates: dateVal,
        noa: master['NOA'] ? Number(master['NOA']) : null,
        noaml: master['NOAML2'] ? Number(master['NOAML2']) : 1,
        nosn: master['NOSN'] ? Number(master['NOSN']) : 1,
        totals: master['TOTALS'] ? Number(master['TOTALS']) : 0,
        totals2: master['TOTALS2'] ? Number(master['TOTALS2']) : null,
        sarsf: master['SARSFS'] ? Number(master['SARSFS']) : 1,
        memos: master['MEMOS1'] || master['MEMOS'] || null,
        mrt: master['MRT2'] ? Number(master['MRT2']) : null,
        nohandshk: master['NOHANDSHK'] ? Number(master['NOHANDSHK']) : null,
        dateshk: master['DATESHK'] ? new Date(String(master['DATESHK'])) : null,
        nameb: master['NAMEB'] || null,
        noms: master['NOMS1'] ? Number(master['NOMS1']) : noms,
        typems: cfg.tc,
        mrhl: posting.mrhl,
        nok: posting.nok,
        ...aud,
      } as never
    );
    for (let i = 0; i < details.length; i++) {
      const d = details[i];
      if (!d['NOAF'] && !d['NOA']) continue;
      await conn.execute(
        `INSERT INTO ${cfg.dt} (nos,nosndok,noa,noaml,sarsf,toam,toaa,toas,memos,mrt,recno)
         VALUES (:nos,:nosndok,:noa,:noaml,:sarsf,:toam,:toaa,:toas,:memos,:mrt,:recno)`,
        {
          nos, nosndok: master['NOSN'] ? Number(master['NOSN']) : 1,
          noa: d['NOAF'] ? Number(d['NOAF']) : (d['NOA'] ? Number(d['NOA']) : null),
          noaml: d['NOAML'] ? Number(d['NOAML']) : 1,
          sarsf: d['SARSF'] ? Number(d['SARSF']) : 1,
          toam: d['TOAM'] ? Number(d['TOAM']) : null,
          toaa: d['TOAA'] ? Number(d['TOAA']) : null,
          toas: d['TOAS'] ? Number(d['TOAS']) : null,
          memos: d['MEMOS'] || d['MEMOSF'] || null,
          mrt: d['MRT'] ? Number(d['MRT']) : null,
          recno: i + 1,
        } as never
      );
    }
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, nos, noms: master['NOMS1'] || noms, message: 'تم حفظ السند بنجاح' });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.put('/api/voucher/:type', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  const cfg = VCFG[c.req.param('type').toLowerCase()];
  if (!cfg) return c.json({ ok: false, error: 'unknown type' }, 400);

  // Permission check: ED on this screen
  const permErr = await ensurePermission(user, cfg.scr, 'ed');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const { master, details } = await c.req.json() as { master: Record<string,unknown>; details: Record<string,unknown>[] };
  const nos = Number(master['NOS']);
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);

  // ---- Business rule validations (shared helpers) ----
  // R1: Future date check
  const dateErr = ensureNotFutureDate(master['DATES']);
  if (dateErr) return c.json({ ok: false, error: dateErr }, 422);
  const dateVal = new Date(String(master['DATES']));

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    // Load current record state (needed by guards below)
    const curR = await conn.execute<{ MRHL:number; NOMS:number; DATES:Date; NOK:number | null }>(
      `SELECT NVL(mrhl,0) AS mrhl, noms, dates, nok FROM ${cfg.mt} WHERE nos = :nos`,
      { nos } as never, { outFormat: 4002 });
    const curRow = (curR.rows as { MRHL:number; NOMS:number; DATES:Date; NOK:number | null }[])[0];
    if (!curRow) return c.json({ ok: false, error: 'السند غير موجود' }, 404);

    // R4: Legacy MORNOM guard: SANDT > 0 and MRHL = 0 blocks UPDATE.
    const postedErr = await ensureLegacyNotPosted(conn, curRow.MRHL, 'تعديل');
    if (postedErr) return c.json({ ok: false, error: postedErr }, 422);

    // R5: AKFA closure block (cannot modify records at/before the max AKFA date)
    const akfaErr = await ensureAkfaNotClosed(user.schema, curRow.DATES, 'تعديل');
    if (akfaErr) return c.json({ ok: false, error: akfaErr }, 422);

    // R2: Duplicate NOMS1 check (excluding current record — only if NOMS changed)
    if (master['NOMS1']) {
      const newNoms = Number(master['NOMS1']);
      if (newNoms !== curRow.NOMS) {
        const dupErr = await ensureNomsUnique(user.schema, cfg.mt, newNoms, nos);
        if (dupErr) return c.json({ ok: false, error: dupErr }, 422);
      }
    }

    // Audit UPDATE: DE=sysdate, NOUSXU=user, PCE=client, NED=NED+1
    const aud = auditUpdate(user);
    const mrhl = await legacyPostingFlag(conn);

    await conn.execute(
      `UPDATE ${cfg.mt} SET dates=:dates,noa=:noa,noaml=:noaml,nosn=:nosn,totals=:totals,totals2=:totals2,
         sarsf=:sarsf,memos=:memos,mrt=:mrt,nohandshk=:nohandshk,dateshk=:dateshk,nameb=:nameb,
          noms=:noms, mrhl=:mrhl,
          de=:de, nousxu=:nousxu, pce=:pce, ned = NVL(ned,0) + 1
       WHERE nos=:nos`,
      {
        nos, dates: dateVal,
        noa: master['NOA'] ? Number(master['NOA']) : null,
        noaml: master['NOAML2'] ? Number(master['NOAML2']) : 1,
        nosn: master['NOSN'] ? Number(master['NOSN']) : 1,
        totals: master['TOTALS'] ? Number(master['TOTALS']) : 0,
        totals2: master['TOTALS2'] ? Number(master['TOTALS2']) : null,
        sarsf: master['SARSFS'] ? Number(master['SARSFS']) : 1,
        memos: master['MEMOS1'] || master['MEMOS'] || null,
        mrt: master['MRT2'] ? Number(master['MRT2']) : null,
        nohandshk: master['NOHANDSHK'] ? Number(master['NOHANDSHK']) : null,
        dateshk: master['DATESHK'] ? new Date(String(master['DATESHK'])) : null,
        nameb: master['NAMEB'] || null,
        noms: master['NOMS1'] ? Number(master['NOMS1']) : curRow.NOMS,
        mrhl,
        ...aud,
      } as never
    );
    await conn.execute(`DELETE FROM ${cfg.dt} WHERE nos = :nos`, { nos } as never);
    for (let i = 0; i < details.length; i++) {
      const d = details[i];
      if (!d['NOAF'] && !d['NOA']) continue;
      await conn.execute(
        `INSERT INTO ${cfg.dt} (nos,nosndok,noa,noaml,sarsf,toam,toaa,toas,memos,mrt,recno)
         VALUES (:nos,:nosndok,:noa,:noaml,:sarsf,:toam,:toaa,:toas,:memos,:mrt,:recno)`,
        {
          nos, nosndok: master['NOSN'] ? Number(master['NOSN']) : 1,
          noa: d['NOAF'] ? Number(d['NOAF']) : (d['NOA'] ? Number(d['NOA']) : null),
          noaml: d['NOAML'] ? Number(d['NOAML']) : 1,
          sarsf: d['SARSF'] ? Number(d['SARSF']) : 1,
          toam: d['TOAM'] ? Number(d['TOAM']) : null,
          toaa: d['TOAA'] ? Number(d['TOAA']) : null,
          toas: d['TOAS'] ? Number(d['TOAS']) : null,
          memos: d['MEMOS'] || d['MEMOSF'] || null,
          mrt: d['MRT'] ? Number(d['MRT']) : null,
          recno: i + 1,
        } as never
      );
    }
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, nos, message: 'تم تعديل السند بنجاح' });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.delete('/api/voucher/:type', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  const cfg = VCFG[c.req.param('type').toLowerCase()];
  if (!cfg) return c.json({ ok: false, error: 'unknown type' }, 400);
  const nos = Number(c.req.query('nos'));
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);

  // Permission check: DE on this screen
  const permErr = await ensurePermission(user, cfg.scr, 'de');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const chk = await conn.execute<{MRHL:number; DATES:Date}>(
      `SELECT NVL(mrhl,0) AS mrhl, dates FROM ${cfg.mt} WHERE nos = :nos`,
      { nos } as never, { outFormat: 4002 });
    const row = (chk.rows as {MRHL:number; DATES:Date}[])[0];
    if (!row) return c.json({ ok: false, error: 'السند غير موجود' }, 404);

    // R4: Cannot delete posted voucher
    const postedErr = await ensureLegacyNotPosted(conn, row.MRHL, 'حذف');
    if (postedErr) return c.json({ ok: false, error: postedErr }, 422);

    // R5: AKFA closure block
    const akfaErr = await ensureAkfaNotClosed(user.schema, row.DATES, 'حذف');
    if (akfaErr) return c.json({ ok: false, error: akfaErr }, 422);

    await conn.execute(`DELETE FROM ${cfg.dt} WHERE nos = :nos`, { nos } as never);
    await conn.execute(`DELETE FROM ${cfg.mt} WHERE nos = :nos`, { nos } as never);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: 'تم حذف السند بنجاح' });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

// =============================================
// /api/voucher/:type/post   — TRSND(2): post to DATAK
// /api/voucher/:type/unpost — TRSND(1): delete DATAK rows and clear MRHL
//
// Both endpoints require EDIT permission on the screen (ترحيل + إلغاء
// ترحيل  are mutations of the master MRHL flag).
// =============================================
app.post('/api/voucher/:type/post', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const cfg = VCFG[c.req.param('type').toLowerCase()];
  if (!cfg) return c.json({ ok: false, error: 'unknown type' }, 400);

  const permErr = await ensurePermission(user, cfg.scr, 'ed');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const nos = Number(c.req.query('nos'));
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);

  try {
    // Load master + details so we can rebuild the journal rows.
    const masterRows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT nos, dates, noa, noaml2 AS noaml, totals, totals2, sarsfs,
              memos1, mrt2, nok, nomsro, nousx
         FROM ${cfg.mt} WHERE nos = :n`,
      { n: nos },
    );
    const m = masterRows[0];
    if (!m) return c.json({ ok: false, error: M.RECORD_NOT_FOUND }, 404);

    const detailRows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT recno, noaf, noaml, toam, toaa, sarsf, mrt, memosf
         FROM ${cfg.dt} WHERE nos = :n ORDER BY recno`,
      { n: nos },
    );

    const { nok, rows } = await postVoucher(user.schema, cfg.tc as Typems, {
      master: {
        NOS:     Number(m['NOS']),
        DATES:   new Date(String(m['DATES'])),
        NOA:     Number(m['NOA']),
        NOAML:   Number(m['NOAML']),
        TOTALS:  Number(m['TOTALS']),
        TOTALS2: m['TOTALS2'] == null ? null : Number(m['TOTALS2']),
        SARSFS:  m['SARSFS']  == null ? null : Number(m['SARSFS']),
        MEMOS1:  (m['MEMOS1'] as string | null) ?? null,
        MRT2:    m['MRT2']    == null ? null : Number(m['MRT2']),
        NOK:     m['NOK']     == null ? null : Number(m['NOK']),
        NOMSRO:  m['NOMSRO']  == null ? null : Number(m['NOMSRO']),
        NOUSX:   Number(m['NOUSX'] ?? user.nou),
      },
      details: detailRows.map(d => ({
        RECNO:  Number(d['RECNO']),
        NOAF:   Number(d['NOAF']),
        NOAML:  Number(d['NOAML']),
        TOAM:   Number(d['TOAM']),
        TOAA:   d['TOAA']   == null ? null : Number(d['TOAA']),
        SARSF:  d['SARSF']  == null ? null : Number(d['SARSF']),
        MRT:    d['MRT']    == null ? null : Number(d['MRT']),
        MEMOSF: (d['MEMOSF'] as string | null) ?? null,
      })),
    });

    return c.json({ ok: true, message: M.POSTED_SUCCESS, nok, rows });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

// =============================================
// /api/journal/sndkd — Journal-entry CRUD
//
// SNDKD differs from SNDK/SNDS:
//   - Master has no NOA / NOAML / TOTALS (just DATES + memo (NKYD) + NOK + MRHL)
//   - Every detail row carries its own MDIN/DAN (double-entry accounting)
//   - Invariant: SUM(MDIN) === SUM(DAN) before save or post
//
// Column name map (legacy SNDKD uses unusual names):
//   master.MEMOS   ↔  SNDKD.NKYD   (narrative / بيان)
//   master.NOMSRO  ↔  SNDKD.NOMRGA (project reference)
// Details table SNDKDF carries a real MEMOS column.
//
// We keep the same route shape as /api/voucher/:type so the front-end
// can reuse the toolbar dispatcher unchanged.
// =============================================
const SNDKD_SCR = 'SNDKD.FMX';
const sndkdHeaderMrtColumnBySchema = new Map<string, 'MRT2' | 'MRT'>();

interface SndkdMaster {
  NOS?: number; NOSON?: number; DATES?: string;
  MEMOS?: string; MRT2?: number; NOMSRO?: number; NOK?: number; TOTALS?: number; TYPEMS?: number; KDANT?: number;
  MRHL?: number;
}
interface SndkdDetail {
  RECNO?: number; NOA: number;
  MDIN?: number; DAN?: number;
  MDINAML?: number; DANAML?: number;
  NOAML?: number; SARSF?: number;
  MRT?: number; MEMOS?: string;
}

function sumSide(details: SndkdDetail[], side: 'MDIN' | 'DAN'): number {
  return details.reduce((s, d) => s + (Number(d[side]) || 0), 0);
}

/**
 * Legacy installations are not fully consistent:
 * some schemas store SNDKD header cost-centre in `MRT2`, older ones in `MRT`.
 * Resolve once per schema and reuse for reads/writes.
 */
async function getSndkdHeaderMrtColumn(schema: string): Promise<'MRT2' | 'MRT'> {
  const key = schema.trim().toUpperCase();
  const cached = sndkdHeaderMrtColumnBySchema.get(key);
  if (cached) return cached;
  try {
    const cols = await queryOn<{ COLUMN_NAME: string }>(
      schema,
      `SELECT column_name
         FROM user_tab_columns
        WHERE table_name = 'SNDKD'
          AND column_name IN ('MRT2', 'MRT')`,
    );
    const names = new Set(cols.map(c => String(c.COLUMN_NAME ?? '').toUpperCase()));
    const resolved: 'MRT2' | 'MRT' = names.has('MRT2') ? 'MRT2' : 'MRT';
    sndkdHeaderMrtColumnBySchema.set(key, resolved);
    return resolved;
  } catch {
    // Keep current behavior if dictionary lookup fails unexpectedly.
    sndkdHeaderMrtColumnBySchema.set(key, 'MRT2');
    return 'MRT2';
  }
}

app.get('/api/journal/sndkd/list', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const q = c.req.query('q') ?? '';
  const limit = Math.min(Number(c.req.query('limit') ?? 200), 500);
  try {
    const rows = await queryOn(
      user.schema,
      `SELECT * FROM (
         SELECT nos, noson, dates, nkyd AS memos, nok, NVL(mrhl,0) AS mrhl,
                NVL(totals,0) AS totals, NVL(typems,1) AS typems, nousx, di
           FROM sndkd
          WHERE :q IS NULL OR UPPER(NVL(nkyd,'')) LIKE :q
             OR TO_CHAR(nos) LIKE :q OR TO_CHAR(noson) LIKE :q
          ORDER BY dates DESC, nos DESC
       ) WHERE ROWNUM <= :lim`,
      { q: q ? `%${q.toUpperCase()}%` : null, lim: limit },
    );
    return c.json({ ok: true, rows });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.get('/api/journal/sndkd', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const nos = Number(c.req.query('nos'));
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);
  try {
    const headerMrtCol = await getSndkdHeaderMrtColumn(user.schema);
    const master = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT nos, noson, dates, nousx, nkyd AS memos, NVL(${headerMrtCol},0) AS mrt2, nomrga AS nomsro,
              totals, NVL(typems,1) AS typems, NVL(mrhl,0) AS mrhl, nok, di, de, pci, pce, ned, nousxu
         FROM sndkd WHERE nos = :n`,
      { n: nos },
    );
    if (!master.length) return c.json({ ok: false, error: M.RECORD_NOT_FOUND }, 404);
    const details = await queryOn(user.schema, `SELECT * FROM sndkdf WHERE nos = :n ORDER BY recno`, { n: nos });
    return c.json({ ok: true, master: master[0], details });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.post('/api/journal/sndkd', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const permErr = await ensurePermission(user, SNDKD_SCR, 'ins');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const { master, details } = await c.req.json() as { master: SndkdMaster; details: SndkdDetail[] };
  const dateErr = ensureNotFutureDate(master['DATES']);
  if (dateErr) return c.json({ ok: false, error: dateErr }, 422);
  const backDateErr = await ensureLegacyBackDateAllowed(user.schema, master['DATES'], user.isAdmin);
  if (backDateErr) return c.json({ ok: false, error: backDateErr }, 422);
  const typems = Number(master['TYPEMS'] ?? 1);
  const safeTypems = typems >= 1 && typems <= 6 ? typems : 1;

  if (!details?.length) return c.json({ ok: false, error: 'يجب إدخال سطر واحد على الأقل' }, 422);
  const sumMdin = sumSide(details, 'MDIN');
  const sumDan  = sumSide(details, 'DAN');
  if (Math.abs(sumMdin - sumDan) > 0.005) {
    return c.json({ ok: false, error: M.DEBIT_CREDIT_MISMATCH }, 422);
  }

  const dateVal = new Date(String(master['DATES']));
  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const headerMrtCol = await getSndkdHeaderMrtColumn(user.schema);
    const year = dateVal.getFullYear();
    const nosonR = await conn.execute<{N:number}>(
      `SELECT NVL(MAX(noson),0)+1 AS n FROM sndkd WHERE TO_CHAR(dates,'YYYY')=:y`,
      { y: String(year) }, { outFormat: 4002 });
    const noson = ((nosonR.rows as {N:number}[])[0]?.N) || 1;
    const nos = Number(String(noson) + String(year));
    const aud = auditInsert(user);
    const posting = await legacyInsertPosting(conn, dateVal, Number(master['KDANT'] ?? 0) > 0);

    await conn.execute(
      `INSERT INTO sndkd (nos, noson, dates, nkyd, nok, mrhl, ${headerMrtCol}, nomrga, typems,
                           di, nousx, pci, ned, totals)
       VALUES (:nos, :noson, :dates, :nkyd, :nok, :mrhl, :mrt2, :nomrga, :typems,
                :di, :nousx, :pci, :ned, :totals)`,
      {
        nos, noson, dates: dateVal,
        nkyd: master['MEMOS'] ?? null,
        nok: posting.nok,
        mrhl: posting.mrhl,
        mrt2: master['MRT2'] ?? 0,
        nomrga: master['NOMSRO'] ?? 0,
        typems: safeTypems,
        totals: sumMdin,                            // إجمالي المدين (= الدائن)
        ...aud,
      } as never,
    );

    for (let i = 0; i < details.length; i++) {
      const d = details[i]!;
      await conn.execute(
        `INSERT INTO sndkdf (nos, recno, noa, mdin, dan, mdinaml, danaml,
                             noaml, sarsf, mrt, memos)
         VALUES (:nos, :recno, :noa, :mdin, :dan, :mdinaml, :danaml,
                 :noaml, :sarsf, :mrt, :memos)`,
        {
          nos, recno: i + 1,
          noa: Number(d.NOA),
          mdin: Number(d.MDIN ?? 0),
          dan: Number(d.DAN ?? 0),
          mdinaml: Number(d.MDINAML ?? d.MDIN ?? 0),
          danaml:  Number(d.DANAML  ?? d.DAN  ?? 0),
          noaml: Number(d.NOAML ?? 1),
          sarsf: Number(d.SARSF ?? 1),
          mrt: Number(d.MRT ?? 0),
          memos: d.MEMOS ?? null,
        } as never,
      );
    }

    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS, nos, noson });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.put('/api/journal/sndkd', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const permErr = await ensurePermission(user, SNDKD_SCR, 'ed');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const { master, details } = await c.req.json() as { master: SndkdMaster; details: SndkdDetail[] };
  const nos = Number(master['NOS']);
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);
  const dateErr = ensureNotFutureDate(master['DATES']);
  if (dateErr) return c.json({ ok: false, error: dateErr }, 422);
  const backDateErr = await ensureLegacyBackDateAllowed(user.schema, master['DATES'], user.isAdmin);
  if (backDateErr) return c.json({ ok: false, error: backDateErr }, 422);
  const typems = Number(master['TYPEMS'] ?? 1);
  const safeTypems = typems >= 1 && typems <= 6 ? typems : 1;

  if (!details?.length) return c.json({ ok: false, error: 'يجب إدخال سطر واحد على الأقل' }, 422);
  const sumMdin = sumSide(details, 'MDIN');
  const sumDan  = sumSide(details, 'DAN');
  if (Math.abs(sumMdin - sumDan) > 0.005) {
    return c.json({ ok: false, error: M.DEBIT_CREDIT_MISMATCH }, 422);
  }

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const headerMrtCol = await getSndkdHeaderMrtColumn(user.schema);
    const chk = await conn.execute<{MRHL: number; NOK: number | null}>(
      `SELECT NVL(mrhl,0) AS mrhl, nok FROM sndkd WHERE nos = :n`,
      { n: nos }, { outFormat: 4002 });
    const row = (chk.rows as {MRHL:number; NOK:number | null}[])[0];
    if (!row) return c.json({ ok: false, error: M.RECORD_NOT_FOUND }, 404);
    const postedErr = await ensureLegacyNotPosted(conn, row.MRHL, 'تعديل');
    if (postedErr) return c.json({ ok: false, error: postedErr }, 422);

    const aud = auditUpdate(user);
    const mrhl = await legacyPostingFlag(conn);
    await conn.execute(
      `UPDATE sndkd
          SET dates = :dates, nkyd = :nkyd, ${headerMrtCol} = :mrt2, nomrga = :nomrga, typems = :typems,
              totals = :totals, mrhl = :mrhl,
              de = :de, nousxu = :nousxu, pce = :pce, ned = NVL(ned,0) + 1
        WHERE nos = :nos`,
      {
        dates: new Date(String(master['DATES'])),
        nkyd: master['MEMOS'] ?? null,
        mrt2: master['MRT2'] ?? 0,
        nomrga: master['NOMSRO'] ?? 0,
        typems: safeTypems,
        totals: sumMdin,
        mrhl,
        nos, ...aud,
      } as never,
    );

    await conn.execute(`DELETE FROM sndkdf WHERE nos = :n`, { n: nos } as never);
    for (let i = 0; i < details.length; i++) {
      const d = details[i]!;
      await conn.execute(
        `INSERT INTO sndkdf (nos, recno, noa, mdin, dan, mdinaml, danaml,
                             noaml, sarsf, mrt, memos)
         VALUES (:nos, :recno, :noa, :mdin, :dan, :mdinaml, :danaml,
                 :noaml, :sarsf, :mrt, :memos)`,
        {
          nos, recno: i + 1,
          noa: Number(d.NOA),
          mdin: Number(d.MDIN ?? 0),
          dan: Number(d.DAN ?? 0),
          mdinaml: Number(d.MDINAML ?? d.MDIN ?? 0),
          danaml:  Number(d.DANAML  ?? d.DAN  ?? 0),
          noaml: Number(d.NOAML ?? 1),
          sarsf: Number(d.SARSF ?? 1),
          mrt: Number(d.MRT ?? 0),
          memos: d.MEMOS ?? null,
        } as never,
      );
    }
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.delete('/api/journal/sndkd', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const permErr = await ensurePermission(user, SNDKD_SCR, 'de');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const nos = Number(c.req.query('nos'));
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const chk = await conn.execute<{MRHL: number}>(
      `SELECT NVL(mrhl,0) AS mrhl FROM sndkd WHERE nos = :n`,
      { n: nos }, { outFormat: 4002 });
    const row = (chk.rows as {MRHL:number}[])[0];
    if (!row) return c.json({ ok: false, error: M.RECORD_NOT_FOUND }, 404);
    const postedErr = await ensureLegacyNotPosted(conn, row.MRHL, 'حذف');
    if (postedErr) return c.json({ ok: false, error: postedErr }, 422);

    await conn.execute(`DELETE FROM sndkdf WHERE nos = :n`, { n: nos } as never);
    await conn.execute(`DELETE FROM sndkd  WHERE nos = :n`, { n: nos } as never);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.DELETED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

// =============================================
// /api/journal/sndkd/by-noson — Legacy "sqlonZ" jump-by-serial
//
// In the original SNDKD.FMB form the field NOSON is the year-scoped serial
// displayed alongside NOS. The KEY-UP / KEY-DOWN / POST-TEXT-ITEM triggers on
// NOSON call `sqlonZ` which re-queries the master block by NOSON+year of
// DATES. This endpoint offers the same quick-jump behaviour.
// =============================================
app.get('/api/journal/sndkd/by-noson', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const noson = Number(c.req.query('noson'));
  const year  = Number(c.req.query('year'));
  if (!noson || !year) return c.json({ ok: false, error: 'noson/year required' }, 400);
  try {
    const rows = await queryOn<{NOS: number}>(
      user.schema,
      `SELECT nos FROM sndkd
         WHERE noson = :s AND TO_CHAR(dates,'YYYY') = TO_CHAR(:y)`,
      { s: noson, y: String(year) },
    );
    if (!rows.length) return c.json({ ok: false, error: 'not_found' }, 404);
    return c.json({ ok: true, nos: rows[0]!.NOS });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

// =============================================
// /api/journal/sndkd/search — Advanced search modal backend
//
// Query parameters (all optional, AND-combined):
//   dateFrom / dateTo : YYYY-MM-DD
//   memo              : LIKE on NKYD (case-insensitive)
//   minAmount / maxAmount : filter on TOTALS
//   posted            : '1' | '0' to restrict by MRHL
//   nomsro            : cost-center match
//   noa               : match any detail row referencing this account
// =============================================
app.get('/api/journal/sndkd/search', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const q = c.req.query.bind(c.req);
  const binds: Record<string, unknown> = {};
  const where: string[] = [];
  const addDate = (k: 'dateFrom' | 'dateTo', op: '>=' | '<=') => {
    const v = q(k);
    if (v) {
      where.push(`dates ${op} TO_DATE(:${k},'YYYY-MM-DD')`);
      binds[k] = v;
    }
  };
  addDate('dateFrom', '>=');
  addDate('dateTo',   '<=');
  const memo = q('memo');
  if (memo) { where.push(`UPPER(NVL(nkyd,'')) LIKE :memo`); binds['memo'] = `%${memo.toUpperCase()}%`; }
  const minA = Number(q('minAmount')); if (minA > 0) { where.push(`NVL(totals,0) >= :minA`); binds['minA'] = minA; }
  const maxA = Number(q('maxAmount')); if (maxA > 0) { where.push(`NVL(totals,0) <= :maxA`); binds['maxA'] = maxA; }
  const posted = q('posted');
  if (posted === '1') where.push(`NVL(mrhl,0) = 0`);
  else if (posted === '0') where.push(`NVL(mrhl,0) <> 0`);
  const nomsro = Number(q('nomsro'));
  if (nomsro > 0) { where.push(`NVL(nomrga,0) = :nomsro`); binds['nomsro'] = nomsro; }
  const noa = Number(q('noa'));
  if (noa > 0) {
    where.push(`nos IN (SELECT nos FROM sndkdf WHERE noa = :noa)`);
    binds['noa'] = noa;
  }
  const limit = Math.min(Number(q('limit') ?? 200), 500);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  try {
    const rows = await queryOn(
      user.schema,
      `SELECT * FROM (
         SELECT nos, noson, dates, nkyd AS memos, nok, NVL(mrhl,0) AS mrhl,
                NVL(totals,0) AS totals, nomrga AS nomsro
           FROM sndkd ${whereSql}
          ORDER BY dates DESC, nos DESC
       ) WHERE ROWNUM <= :lim`,
      { ...binds, lim: limit },
    );
    return c.json({ ok: true, rows, count: rows.length });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

// =============================================
// /api/journal/sndkd/print — Printer-friendly HTML voucher
//
// Returns a standalone Arabic-RTL HTML page suitable for Ctrl+P.
// Mirrors the legacy `prn` procedure triggered from SNDKD.FMB (CONT.PR).
// =============================================
app.get('/api/journal/sndkd/print', async (c) => {
  const user = readUser(c);
  if (!user) return c.text('غير مصرح — يجب تسجيل الدخول', 401);
  const nos = Number(c.req.query('nos'));
  if (!nos) return c.text('nos مطلوب', 400);

  try {
    const mRows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT nos, noson, dates, nkyd AS memos, nok,
              NVL(mrhl,0) AS mrhl, NVL(totals,0) AS totals, nomrga
         FROM sndkd WHERE nos = :n`,
      { n: nos },
    );
    if (!mRows.length) return c.text('السند غير موجود', 404);
    const m = mRows[0]!;
    const details = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT f.recno, f.noa, a.namea,
              NVL(f.mdin,0) AS mdin, NVL(f.dan,0) AS dan,
              NVL(f.mdinaml,0) AS mdinaml, NVL(f.danaml,0) AS danaml,
              NVL(f.noaml,1) AS noaml, NVL(f.sarsf,1) AS sarsf,
              f.memos, NVL(f.mrt,0) AS mrt
         FROM sndkdf f
         LEFT JOIN data_ac a ON a.noa = f.noa
        WHERE f.nos = :n ORDER BY f.recno`,
      { n: nos },
    );

    const fmt = (n: unknown) =>
      Number(n ?? 0).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const esc = (s: unknown) =>
      String(s ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[ch]!));
    const dateStr = m['DATES'] ? new Date(String(m['DATES'])).toLocaleDateString('ar-EG') : '—';
    const posted = legacyMrhlIsPosted(m['MRHL']);

    const rowsHtml = details.map((d, i) => `
      <tr>
        <td class="c">${i + 1}</td>
        <td><strong>${esc(d['NOA'])}</strong> · ${esc(d['NAMEA'] ?? '—')}</td>
        <td class="n">${fmt(d['MDIN'])}</td>
        <td class="n">${fmt(d['DAN'])}</td>
        <td>${esc(d['MEMOS'] ?? '')}</td>
      </tr>
    `).join('');

    const totalDebit  = details.reduce((s, d) => s + Number(d['MDIN'] ?? 0), 0);
    const totalCredit = details.reduce((s, d) => s + Number(d['DAN']  ?? 0), 0);

    const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>قيد يومية رقم ${esc(m['NOSON'] ?? m['NOS'])}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Tahoma', 'Arial', sans-serif; padding: 1rem; color: #0f172a; }
    h1 { font-size: 1.4rem; margin: 0 0 0.5rem; text-align: center; }
    .hdr { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem 1rem;
           border: 1px solid #333; padding: 0.75rem; margin-bottom: 1rem; border-radius: 4px; }
    .hdr div { font-size: 0.9rem; }
    .hdr b { color: #475569; display: block; font-size: 0.75rem; }
    .memo { grid-column: 1 / -1; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { border: 1px solid #94a3b8; padding: 0.3rem 0.5rem; }
    th { background: #e2e8f0; }
    .c { text-align: center; }
    .n { text-align: left; font-variant-numeric: tabular-nums; }
    tfoot td { font-weight: bold; background: #f1f5f9; }
    .status { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 12px;
              font-size: 0.8rem; margin-top: 0.3rem;
              ${posted ? 'background:#dcfce7;color:#166534;' : 'background:#fef3c7;color:#92400e;'} }
    .footer { margin-top: 2rem; display: grid; grid-template-columns: repeat(3, 1fr);
              gap: 2rem; font-size: 0.85rem; }
    .sig { border-top: 1px solid #333; padding-top: 0.4rem; text-align: center; }
    @media print { body { padding: 0.5rem; } .noprint { display: none; } }
  </style>
</head>
<body>
  <h1>قيد يومية</h1>
  <div class="hdr">
    <div><b>رقم المسلسل</b>${esc(m['NOSON'] ?? '—')}</div>
    <div><b>رقم داخلي</b>${esc(m['NOS'])}</div>
    <div><b>التاريخ</b>${esc(dateStr)}</div>
    <div><b>رقم الدفتر (NOK)</b>${esc(m['NOK'] ?? '—')}</div>
    <div class="memo"><b>البيان</b>${esc(m['MEMOS'] ?? '')}
      <span class="status">${posted ? 'مُرحّل' : 'غير مُرحّل'}</span></div>
  </div>
  <table>
    <thead>
      <tr>
        <th style="width:3rem">#</th>
        <th>الحساب</th>
        <th style="width:7rem">مدين</th>
        <th style="width:7rem">دائن</th>
        <th>البيان</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
    <tfoot>
      <tr>
        <td colspan="2" class="c">الإجماليات</td>
        <td class="n">${fmt(totalDebit)}</td>
        <td class="n">${fmt(totalCredit)}</td>
        <td></td>
      </tr>
    </tfoot>
  </table>
  <div class="footer">
    <div class="sig">المحاسب</div>
    <div class="sig">المراجع</div>
    <div class="sig">المدير</div>
  </div>
  <div class="noprint" style="text-align:center;margin-top:1.5rem">
    <button onclick="window.print()" style="padding:0.5rem 1.5rem;font-size:1rem;cursor:pointer">
      طباعة
    </button>
  </div>
</body>
</html>`;
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(html);
  } catch (e) {
    return c.text('خطأ: ' + (e as Error).message, 500);
  }
});

app.post('/api/journal/sndkd/post', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const permErr = await ensurePermission(user, SNDKD_SCR, 'ed');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const nos = Number(c.req.query('nos'));
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);

  try {
    const masterRows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT nos, dates, nkyd AS memos, nok, nomrga AS nomsro, nousx, NVL(typems,1) AS typems
         FROM sndkd WHERE nos = :n`,
      { n: nos },
    );
    const m = masterRows[0];
    if (!m) return c.json({ ok: false, error: M.RECORD_NOT_FOUND }, 404);

    const detailRows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT recno, noa, mdin, dan, noaml, sarsf, mrt, memos
         FROM sndkdf WHERE nos = :n ORDER BY recno`,
      { n: nos },
    );

    // Re-validate the balance server-side before touching DATAK.
    const sumMdin = detailRows.reduce((s, r) => s + Number(r['MDIN'] ?? 0), 0);
    const sumDan  = detailRows.reduce((s, r) => s + Number(r['DAN']  ?? 0), 0);
    if (Math.abs(sumMdin - sumDan) > 0.005) {
      return c.json({ ok: false, error: M.DEBIT_CREDIT_MISMATCH }, 422);
    }

    const { nok, rows } = await postJournal(user.schema, {
      master: {
        NOS:    Number(m['NOS']),
        DATES:  new Date(String(m['DATES'])),
        MEMOS:  (m['MEMOS'] as string | null) ?? null,
        NOK:    m['NOK'] == null ? null : Number(m['NOK']),
        NOMSRO: m['NOMSRO'] == null ? null : Number(m['NOMSRO']),
        NOUSX:  Number(m['NOUSX'] ?? user.nou),
        TYPEMS: Number(m['TYPEMS'] ?? 1),
      },
      details: detailRows.map(d => ({
        RECNO: Number(d['RECNO']),
        NOA:   Number(d['NOA']),
        MDIN:  Number(d['MDIN'] ?? 0),
        DAN:   Number(d['DAN']  ?? 0),
        NOAML: Number(d['NOAML'] ?? 1),
        SARSF: d['SARSF'] == null ? null : Number(d['SARSF']),
        MRT:   d['MRT']   == null ? null : Number(d['MRT']),
        MEMOS: (d['MEMOS'] as string | null) ?? null,
      })),
    });

    return c.json({ ok: true, message: M.POSTED_SUCCESS, nok, rows });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.post('/api/journal/sndkd/unpost', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const permErr = await ensurePermission(user, SNDKD_SCR, 'ed');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const nos = Number(c.req.query('nos'));
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);

  try {
    const { deleted } = await unpostVoucher(user.schema, TYPEMS.JOURNAL as Typems, nos);
    return c.json({ ok: true, message: M.UNPOSTED_SUCCESS, deleted });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

// =============================================
// /api/journal/sndkd2 — Transfer-entry CRUD
//
// SNDKD2 (قيد تحويل) differs from SNDKD:
//   - Single-row-per-transfer (no *F detail table).
//   - Each row carries both sides of the entry: NOA/NOAML/SARSF/MDIN/MDINAML
//     (debit side) and NOA2/NOAML2/SARSF2/DAN/DANAML (credit side).
//   - Accounting invariant: MDIN === DAN (local currency) ⇒ one transfer
//     amount. Foreign amounts may differ when the two sides are in
//     different currencies.
//   - DATAK view UNIONs SNDKD2 with typems=10, projecting exactly two rows
//     per record (one per side) — posting flips MRHL=0 + assigns NOK.
//
// Column name map (frontend ↔ DB):
//   master.MEMOS     ↔  SNDKD2.MEMOSA1   (بيان الطرف المدين)
//   master.MEMOS2    ↔  SNDKD2.MEMOSA2   (بيان الطرف الدائن)
//   master.MEMOSGEN  ↔  SNDKD2.MEMOSA    (بيان عام)
// =============================================
const SNDKD2_SCR = 'SNDKD2.FMX';

interface Sndkd2Master {
  NOS?:      number;
  NOSON?:    number;
  DATES?:    string;
  NOK?:      number;
  MRHL?:     number;
  MRT?:      number;
  NOMSRO?:   number;
  NOMSRO2?:  number;
  NOAMLM?:   number;
  NOAMLM2?:  number;
  // Debit (from) side
  NOA?:      number;
  NOAML?:    number;
  SARSF?:    number;
  MDIN?:     number;
  MDINAML?:  number;
  MEMOSA1?:  string | null;   // aka "MEMOS" (from-side memo)
  // Credit (to) side
  NOA2?:     number;
  NOAML2?:   number;
  SARSF2?:   number;
  DAN?:      number;
  DANAML?:   number;
  MEMOSA2?:  string | null;   // aka "MEMOS2" (to-side memo)
  // General narrative
  MEMOSA?:   string | null;   // general memo (بيان عام)
  // Audit
  DI?:       string;
  DE?:       string;
  PCI?:      string;
  PCE?:      string;
  NED?:      number;
  NOUSXU?:   number;
  NOUSX?:    number;
}

app.get('/api/journal/sndkd2/list', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const q = c.req.query('q') ?? '';
  const limit = Math.min(Number(c.req.query('limit') ?? 200), 500);
  try {
    const rows = await queryOn(
      user.schema,
      `SELECT * FROM (
         SELECT nos, noson, dates, noa, noa2,
                NVL(mdin,0) AS mdin, NVL(dan,0) AS dan,
                NVL(noaml,1) AS noaml, NVL(noaml2,1) AS noaml2,
                memosa, NVL(mrhl,0) AS mrhl, nok, nousx
           FROM sndkd2
          WHERE :q IS NULL OR UPPER(NVL(memosa,'')) LIKE :q
             OR TO_CHAR(nos) LIKE :q OR TO_CHAR(noson) LIKE :q
          ORDER BY dates DESC, nos DESC
       ) WHERE ROWNUM <= :lim`,
      { q: q ? `%${q.toUpperCase()}%` : null, lim: limit },
    );
    return c.json({ ok: true, rows });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.get('/api/journal/sndkd2', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const nos = Number(c.req.query('nos'));
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);
  try {
    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT nos, noson, dates, nousx, nousxu, di, de, pci, pce, ned,
              nok, NVL(mrhl,0) AS mrhl, typems, mrt,
              noa,   NVL(noaml,1)  AS noaml,  NVL(sarsf,1)  AS sarsf,
              NVL(mdin,0) AS mdin, NVL(mdinaml,0) AS mdinaml,
              nomsro,  noamlm,  memosa1,
              noa2,  NVL(noaml2,1) AS noaml2, NVL(sarsf2,1) AS sarsf2,
              NVL(dan,0)  AS dan,  NVL(danaml,0)  AS danaml,
              nomsro2, noamlm2, memosa2,
              memosa
         FROM sndkd2 WHERE nos = :n`,
      { n: nos },
    );
    if (!rows.length) return c.json({ ok: false, error: M.RECORD_NOT_FOUND }, 404);
    return c.json({ ok: true, master: rows[0] });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

/** Validate an SNDKD2 payload. Returns an error string, or null when OK. */
function validateSndkd2(m: Sndkd2Master): string | null {
  if (!m.DATES) return 'يجب إدخال التاريخ';
  if (!m.NOA || !m.NOA2) return 'يجب اختيار حساب الطرفين (من / إلى)';
  if (m.NOA === m.NOA2) return 'لا يمكن التحويل من حساب إلى نفس الحساب';
  const mdin = Number(m.MDIN ?? 0);
  const dan  = Number(m.DAN  ?? 0);
  if (mdin <= 0) return 'يجب إدخال مبلغ التحويل';
  if (Math.abs(mdin - dan) > 0.005) return M.DEBIT_CREDIT_MISMATCH;
  return null;
}

async function validateSndkd2Rates(schema: string, m: Sndkd2Master): Promise<string | null> {
  const checks = [
    { label: 'سعر صرف الطرف المدين', no: Number(m.NOAML ?? 1), rate: Number(m.SARSF ?? 0) },
    { label: 'سعر صرف الطرف الدائن', no: Number(m.NOAML2 ?? 1), rate: Number(m.SARSF2 ?? 0) },
  ].filter(x => x.no > 1);

  if (!checks.length) return null;
  for (const check of checks) {
    if (check.rate <= 0) return `يجب إدخال ${check.label}`;
  }

  const uniqueNos = Array.from(new Set(checks.map(x => x.no)));
  const binds = Object.fromEntries(uniqueNos.map((no, index) => [`n${index}`, no]));
  const inSql = uniqueNos.map((_, index) => `:n${index}`).join(', ');
  const rows = await queryOn<Record<string, unknown>>(
    schema,
    `SELECT no, NVL(sars1,0) AS sars1, NVL(sars2,0) AS sars2
       FROM amlh
      WHERE no IN (${inSql})`,
    binds,
  );
  const byNo = new Map<number, { SARS1: number; SARS2: number }>();
  rows.forEach(row => {
    byNo.set(Number(row['NO'] ?? 0), {
      SARS1: Number(row['SARS1'] ?? 0),
      SARS2: Number(row['SARS2'] ?? 0),
    });
  });

  for (const check of checks) {
    const rateRow = byNo.get(check.no);
    if (!rateRow) continue;
    if (rateRow.SARS1 > 0 && check.rate > rateRow.SARS1) {
      return `${check.label} (${check.rate}) أكبر من الحد الأعلى (${rateRow.SARS1})`;
    }
    if (rateRow.SARS2 > 0 && check.rate < rateRow.SARS2) {
      return `${check.label} (${check.rate}) أقل من الحد الأدنى (${rateRow.SARS2})`;
    }
  }

  return null;
}

app.post('/api/journal/sndkd2', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const permErr = await ensurePermission(user, SNDKD2_SCR, 'ins');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const { master } = await c.req.json() as { master: Sndkd2Master };
  const dateErr = ensureNotFutureDate(master.DATES);
  if (dateErr) return c.json({ ok: false, error: dateErr }, 422);
  const akfaErr = await ensureAkfaNotClosed(user.schema, master.DATES);
  if (akfaErr) return c.json({ ok: false, error: akfaErr }, 422);
  const err = validateSndkd2(master);
  if (err) return c.json({ ok: false, error: err }, 422);
  const rateErr = await validateSndkd2Rates(user.schema, master);
  if (rateErr) return c.json({ ok: false, error: rateErr }, 422);

  const dateVal = new Date(String(master.DATES));
  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const year = dateVal.getFullYear();
    const nosonR = await conn.execute<{N:number}>(
      `SELECT NVL(MAX(noson),0)+1 AS n FROM sndkd2 WHERE TO_CHAR(dates,'YYYY')=:y`,
      { y: String(year) }, { outFormat: 4002 });
    const noson = ((nosonR.rows as {N:number}[])[0]?.N) || 1;
    const nos = Number(String(noson) + String(year));
    const aud = auditInsert(user);
    const posting = await legacyInsertPosting(conn, dateVal);

    await conn.execute(
      `INSERT INTO sndkd2
         (nos, noson, dates, typems, mrhl, nok,
          noa,  noaml,  sarsf,  mdin, mdinaml, nomsro,  noamlm,  memosa1,
          noa2, noaml2, sarsf2, dan,  danaml,  nomsro2, noamlm2, memosa2,
          memosa, mrt, nousx, di, pci, ned)
       VALUES
         (:nos, :noson, :dates, 10, :mrhl, :nok,
          :noa,  :noaml,  :sarsf,  :mdin, :mdinaml, :nomsro,  :noamlm,  :memosa1,
          :noa2, :noaml2, :sarsf2, :dan,  :danaml,  :nomsro2, :noamlm2, :memosa2,
          :memosa, :mrt, :nousx, :di, :pci, :ned)`,
      {
        nos, noson, dates: dateVal,
        mrhl: posting.mrhl,
        nok: posting.nok,
        noa:     Number(master.NOA),
        noaml:   Number(master.NOAML   ?? 1),
        sarsf:   Number(master.SARSF   ?? 1),
        mdin:    Number(master.MDIN    ?? 0),
        mdinaml: Number(master.MDINAML ?? master.MDIN ?? 0),
        nomsro:  master.NOMSRO  ?? 0,
        noamlm:  master.NOAMLM  ?? 0,
        memosa1: master.MEMOSA1 ?? null,
        noa2:    Number(master.NOA2),
        noaml2:  Number(master.NOAML2  ?? 1),
        sarsf2:  Number(master.SARSF2  ?? 1),
        dan:     Number(master.DAN     ?? master.MDIN ?? 0),
        danaml:  Number(master.DANAML  ?? master.DAN  ?? master.MDIN ?? 0),
        nomsro2: master.NOMSRO2 ?? 0,
        noamlm2: master.NOAMLM2 ?? 0,
        memosa2: master.MEMOSA2 ?? null,
        memosa:  master.MEMOSA  ?? null,
        mrt:     Number(master.MRT ?? 0),
        ...aud,
      } as never,
    );

    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS, nos, noson });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.put('/api/journal/sndkd2', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const permErr = await ensurePermission(user, SNDKD2_SCR, 'ed');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const { master } = await c.req.json() as { master: Sndkd2Master };
  const nos = Number(master.NOS);
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);
  const dateErr = ensureNotFutureDate(master.DATES);
  if (dateErr) return c.json({ ok: false, error: dateErr }, 422);
  const akfaErr = await ensureAkfaNotClosed(user.schema, master.DATES);
  if (akfaErr) return c.json({ ok: false, error: akfaErr }, 422);
  const err = validateSndkd2(master);
  if (err) return c.json({ ok: false, error: err }, 422);
  const rateErr = await validateSndkd2Rates(user.schema, master);
  if (rateErr) return c.json({ ok: false, error: rateErr }, 422);

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const chk = await conn.execute<{MRHL: number; NOK: number | null}>(
      `SELECT NVL(mrhl,0) AS mrhl, nok FROM sndkd2 WHERE nos = :n`,
      { n: nos }, { outFormat: 4002 });
    const row = (chk.rows as {MRHL:number; NOK:number | null}[])[0];
    if (!row) return c.json({ ok: false, error: M.RECORD_NOT_FOUND }, 404);
    const postedErr = await ensureLegacyNotPosted(conn, row.MRHL, 'تعديل');
    if (postedErr) return c.json({ ok: false, error: postedErr }, 422);

    const aud = auditUpdate(user);
    const dateVal = new Date(String(master.DATES));
    const mrhl = await legacyPostingFlag(conn);
    await conn.execute(
      `UPDATE sndkd2
          SET dates   = :dates,
              noa     = :noa,   noaml  = :noaml,  sarsf  = :sarsf,
              mdin    = :mdin,  mdinaml = :mdinaml,
              nomsro  = :nomsro,  noamlm  = :noamlm,  memosa1 = :memosa1,
              noa2    = :noa2, noaml2 = :noaml2, sarsf2 = :sarsf2,
              dan     = :dan,   danaml  = :danaml,
              nomsro2 = :nomsro2, noamlm2 = :noamlm2, memosa2 = :memosa2,
              memosa  = :memosa, mrt    = :mrt,
              mrhl    = :mrhl,
              de = :de, nousxu = :nousxu, pce = :pce, ned = NVL(ned,0) + 1
        WHERE nos = :nos`,
      {
        dates: dateVal,
        noa:     Number(master.NOA),
        noaml:   Number(master.NOAML   ?? 1),
        sarsf:   Number(master.SARSF   ?? 1),
        mdin:    Number(master.MDIN    ?? 0),
        mdinaml: Number(master.MDINAML ?? master.MDIN ?? 0),
        nomsro:  master.NOMSRO  ?? 0,
        noamlm:  master.NOAMLM  ?? 0,
        memosa1: master.MEMOSA1 ?? null,
        noa2:    Number(master.NOA2),
        noaml2:  Number(master.NOAML2  ?? 1),
        sarsf2:  Number(master.SARSF2  ?? 1),
        dan:     Number(master.DAN     ?? master.MDIN ?? 0),
        danaml:  Number(master.DANAML  ?? master.DAN  ?? master.MDIN ?? 0),
        nomsro2: master.NOMSRO2 ?? 0,
        noamlm2: master.NOAMLM2 ?? 0,
        memosa2: master.MEMOSA2 ?? null,
        memosa:  master.MEMOSA  ?? null,
        mrt:     Number(master.MRT ?? 0),
        mrhl,
        nos, ...aud,
      } as never,
    );

    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.delete('/api/journal/sndkd2', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const permErr = await ensurePermission(user, SNDKD2_SCR, 'de');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const nos = Number(c.req.query('nos'));
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const chk = await conn.execute<{MRHL: number; DATES: Date}>(
      `SELECT NVL(mrhl,0) AS mrhl, dates FROM sndkd2 WHERE nos = :n`,
      { n: nos }, { outFormat: 4002 });
    const row = (chk.rows as {MRHL:number; DATES:Date}[])[0];
    if (!row) return c.json({ ok: false, error: M.RECORD_NOT_FOUND }, 404);
    const postedErr = await ensureLegacyNotPosted(conn, row.MRHL, 'حذف');
    if (postedErr) return c.json({ ok: false, error: postedErr }, 422);
    const akfaErr = await ensureAkfaNotClosed(
      user.schema, row.DATES instanceof Date ? row.DATES.toISOString() : String(row.DATES));
    if (akfaErr) return c.json({ ok: false, error: akfaErr }, 422);

    await conn.execute(`DELETE FROM sndkd2 WHERE nos = :n`, { n: nos } as never);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.DELETED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.get('/api/journal/sndkd2/by-noson', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const noson = Number(c.req.query('noson'));
  const year  = Number(c.req.query('year'));
  if (!noson || !year) return c.json({ ok: false, error: 'noson/year required' }, 400);
  try {
    const rows = await queryOn<{NOS: number}>(
      user.schema,
      `SELECT nos FROM sndkd2
         WHERE noson = :s AND TO_CHAR(dates,'YYYY') = TO_CHAR(:y)`,
      { s: noson, y: String(year) },
    );
    if (!rows.length) return c.json({ ok: false, error: 'not_found' }, 404);
    return c.json({ ok: true, nos: rows[0]!.NOS });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.get('/api/journal/sndkd2/search', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const q = c.req.query.bind(c.req);
  const binds: Record<string, unknown> = {};
  const where: string[] = [];
  const addDate = (k: 'dateFrom' | 'dateTo', op: '>=' | '<=') => {
    const v = q(k);
    if (v) { where.push(`dates ${op} TO_DATE(:${k},'YYYY-MM-DD')`); binds[k] = v; }
  };
  addDate('dateFrom', '>=');
  addDate('dateTo',   '<=');
  const memo = q('memo');
  if (memo) {
    where.push(`(UPPER(NVL(memosa,'')) LIKE :memo
              OR UPPER(NVL(memosa1,'')) LIKE :memo
              OR UPPER(NVL(memosa2,'')) LIKE :memo)`);
    binds['memo'] = `%${memo.toUpperCase()}%`;
  }
  const minA = Number(q('minAmount')); if (minA > 0) { where.push(`NVL(mdin,0) >= :minA`); binds['minA'] = minA; }
  const maxA = Number(q('maxAmount')); if (maxA > 0) { where.push(`NVL(mdin,0) <= :maxA`); binds['maxA'] = maxA; }
  const posted = q('posted');
  if (posted === '1') where.push(`NVL(mrhl,0) = 0`);
  else if (posted === '0') where.push(`NVL(mrhl,0) <> 0`);
  const noa = Number(q('noa'));
  if (noa > 0) { where.push(`(noa = :noa OR noa2 = :noa)`); binds['noa'] = noa; }
  const limit = Math.min(Number(q('limit') ?? 200), 500);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  try {
    const rows = await queryOn(
      user.schema,
      `SELECT * FROM (
         SELECT nos, noson, dates, noa, noa2,
                NVL(mdin,0) AS mdin, NVL(dan,0) AS dan,
                NVL(noaml,1) AS noaml, NVL(noaml2,1) AS noaml2,
                memosa, NVL(mrhl,0) AS mrhl, nok
           FROM sndkd2 ${whereSql}
          ORDER BY dates DESC, nos DESC
       ) WHERE ROWNUM <= :lim`,
      { ...binds, lim: limit },
    );
    return c.json({ ok: true, rows, count: rows.length });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.get('/api/journal/sndkd2/print', async (c) => {
  const user = readUser(c);
  if (!user) return c.text('غير مصرح - يجب تسجيل الدخول', 401);
  const nos = Number(c.req.query('nos'));
  if (!nos) return c.text('nos مطلوب', 400);

  try {
    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT s.nos, s.noson, s.dates, s.nok, NVL(s.mrhl,0) AS mrhl, NVL(s.mrt,0) AS mrt,
              s.noa, a1.namea AS namea, NVL(s.noaml,1) AS noaml, NVL(s.sarsf,1) AS sarsf,
              NVL(s.mdin,0) AS mdin, NVL(s.mdinaml,0) AS mdinaml, s.nomsro, s.noamlm, s.memosa1,
              s.noa2, a2.namea AS namea2, NVL(s.noaml2,1) AS noaml2, NVL(s.sarsf2,1) AS sarsf2,
              NVL(s.dan,0) AS dan, NVL(s.danaml,0) AS danaml, s.nomsro2, s.noamlm2, s.memosa2,
              s.memosa
         FROM sndkd2 s
         LEFT JOIN data_ac a1 ON a1.noa = s.noa
         LEFT JOIN data_ac a2 ON a2.noa = s.noa2
        WHERE s.nos = :n`,
      { n: nos },
    );
    if (!rows.length) return c.text('السند غير موجود', 404);

    const m = rows[0]!;
    const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]!));
    const fmt = (value: unknown) =>
      Number(value ?? 0).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const posted = legacyMrhlIsPosted(m['MRHL']);
    const dateStr = m['DATES'] ? new Date(String(m['DATES'])).toLocaleDateString('ar-EG') : '-';

    const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>قيد تحويل رقم ${esc(m['NOSON'] ?? m['NOS'])}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: Tahoma, Arial, sans-serif; margin: 0; padding: 18px; color: #0f172a; background: #fff; }
    h1 { margin: 0 0 12px; text-align: center; font-size: 24px; color: #1e3a8a; }
    .head { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px 14px; margin-bottom: 14px; padding: 12px; border: 1px solid #94a3b8; border-radius: 8px; background: #f8fafc; }
    .head .wide { grid-column: 1 / -1; }
    .label { display: block; font-size: 12px; color: #475569; margin-bottom: 4px; }
    .value { font-weight: 700; }
    .status { display: inline-block; margin-inline-start: 10px; padding: 2px 10px; border-radius: 999px; font-size: 12px; ${posted ? 'background:#dcfce7;color:#166534;' : 'background:#fef3c7;color:#92400e;'} }
    .sides { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 14px; }
    .side { border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; }
    .side h2 { margin: 0; padding: 10px 12px; font-size: 18px; background: #dbeafe; color: #1e3a8a; }
    .side.credit h2 { background: #dcfce7; color: #166534; }
    table { width: 100%; border-collapse: collapse; }
    td { border: 1px solid #e2e8f0; padding: 8px 10px; font-size: 14px; vertical-align: top; }
    td.k { width: 34%; background: #f8fafc; color: #475569; font-weight: 700; }
    .note { min-height: 72px; white-space: pre-wrap; }
    .actions { text-align: center; margin-top: 18px; }
    .actions button { padding: 8px 18px; font-size: 16px; cursor: pointer; }
    @media print { .actions { display: none; } body { padding: 8px; } }
  </style>
</head>
<body>
  <h1>قيد تحويل</h1>
  <div class="head">
    <div><span class="label">المسلسل</span><span class="value">${esc(m['NOSON'] ?? '-')}</span></div>
    <div><span class="label">الرقم الداخلي</span><span class="value">${esc(m['NOS'])}</span></div>
    <div><span class="label">التاريخ</span><span class="value">${esc(dateStr)}</span></div>
    <div><span class="label">رقم القيد (NOK)</span><span class="value">${esc(m['NOK'] ?? '-')}</span></div>
    <div><span class="label">مركز التكلفة</span><span class="value">${esc(m['MRT'] ?? 0)}</span></div>
    <div class="wide"><span class="label">البيان العام</span><span class="value">${esc(m['MEMOSA'] ?? '')}<span class="status">${posted ? 'مرحل' : 'غير مرحل'}</span></span></div>
  </div>

  <div class="sides">
    <section class="side debit">
      <h2>الطرف المدين - من</h2>
      <table>
        <tr><td class="k">الحساب</td><td>${esc(m['NOA'])} - ${esc(m['NAMEA'] ?? '')}</td></tr>
        <tr><td class="k">العملة</td><td>${esc(m['NOAML'])}</td></tr>
        <tr><td class="k">سعر الصرف</td><td>${fmt(m['SARSF'])}</td></tr>
        <tr><td class="k">المبلغ المحلي</td><td>${fmt(m['MDIN'])}</td></tr>
        <tr><td class="k">المبلغ الأجنبي</td><td>${fmt(m['MDINAML'])}</td></tr>
        <tr><td class="k">المرجع</td><td>${esc(m['NOMSRO'] ?? '')}</td></tr>
        <tr><td class="k">بيان الطرف</td><td class="note">${esc(m['MEMOSA1'] ?? '')}</td></tr>
      </table>
    </section>

    <section class="side credit">
      <h2>الطرف الدائن - إلى</h2>
      <table>
        <tr><td class="k">الحساب</td><td>${esc(m['NOA2'])} - ${esc(m['NAMEA2'] ?? '')}</td></tr>
        <tr><td class="k">العملة</td><td>${esc(m['NOAML2'])}</td></tr>
        <tr><td class="k">سعر الصرف</td><td>${fmt(m['SARSF2'])}</td></tr>
        <tr><td class="k">المبلغ المحلي</td><td>${fmt(m['DAN'])}</td></tr>
        <tr><td class="k">المبلغ الأجنبي</td><td>${fmt(m['DANAML'])}</td></tr>
        <tr><td class="k">المرجع</td><td>${esc(m['NOMSRO2'] ?? '')}</td></tr>
        <tr><td class="k">بيان الطرف</td><td class="note">${esc(m['MEMOSA2'] ?? '')}</td></tr>
      </table>
    </section>
  </div>

  <div class="actions">
    <button onclick="window.print()">طباعة</button>
  </div>
</body>
</html>`;

    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(html);
  } catch (e) {
    return c.text('خطأ: ' + (e as Error).message, 500);
  }
});

app.post('/api/journal/sndkd2/post', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const permErr = await ensurePermission(user, SNDKD2_SCR, 'ed');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const nos = Number(c.req.query('nos'));
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);

  try {
    // Re-validate the accounting balance server-side before touching DATAK.
    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT NVL(mdin,0) AS mdin, NVL(dan,0) AS dan, NVL(mrhl,0) AS mrhl
         FROM sndkd2 WHERE nos = :n`,
      { n: nos },
    );
    const row = rows[0];
    if (!row) return c.json({ ok: false, error: M.RECORD_NOT_FOUND }, 404);
    if (Math.abs(Number(row['MDIN']) - Number(row['DAN'])) > 0.005) {
      return c.json({ ok: false, error: M.DEBIT_CREDIT_MISMATCH }, 422);
    }

    const { nok, rows: out } = await postSndkd2(user.schema, nos);
    return c.json({ ok: true, message: M.POSTED_SUCCESS, nok, rows: out });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.post('/api/journal/sndkd2/unpost', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const permErr = await ensurePermission(user, SNDKD2_SCR, 'ed');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const nos = Number(c.req.query('nos'));
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);

  try {
    const { deleted } = await unpostVoucher(user.schema, TYPEMS.TRANSFER as Typems, nos);
    return c.json({ ok: true, message: M.UNPOSTED_SUCCESS, deleted });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

// =============================================
// /api/journal/akfa — Currency-revaluation closing entry
//
// AKFA (قيد اقفال فوارق عملة) is a period-end closing entry that revalues
// foreign-currency account balances against current exchange rates and
// posts the differences to a system-configured "currency differences" P&L
// account. Unlike SNDKD/SNDKD2, AKFA has NO MRHL column — once inserted,
// the record is immediately "live" in the DATAK view (typems=3) and NOK
// is assigned on the INSERT itself via `squnx()`.
//
// Tables:
//   AKFA    — master (NOS, NOSON, DATES, NOUSX, NOK, ...)
//   AKFAF   — account-revaluation details (NOA, NOAML, SARSF, MDIN, DAN,
//             NOA2, MEMOS, MEMOS2, FARK, RSEDHY, RSEDHA, RSEDHYB, TY)
//   AKFAFS  — inventory-revaluation details (deferred to Phase 2)
//
// Business rules (from the FMB):
//   - Only one AKFA per date (`if :dates=:dateak then ms('يوجد قيد اقفال...')`)
//   - Dates cannot predate the last existing AKFA date
//   - The clearing (offset) account NOA2 is auto-resolved from DATA_AC where
//     SUBSTR(NOA,1,1)='4' AND THSYSTEM=1 (the P&L account flagged as the
//     "currency differences" system account).
//   - Candidates come from DATAK aggregated up to the closing date, filtered
//     to foreign-currency accounts (NOAML>1) that are not P&L accounts
//     (SUBSTR(NOA,1,1)<>'4') and whose local-currency balance is non-zero.
// =============================================
const AKFA_SCR = 'AKFA.FMX';

interface AkfafRow {
  RECNO?:   number;
  NOA?:     number;
  NAMEA?:   string | null;   // denormalized for display
  NOAML?:   number;
  NOAML_NAME?: string | null; // denormalized for display
  SARSF?:   number;
  MDIN?:    number;
  DAN?:     number;
  NOA2?:    number;
  MEMOS?:   string | null;
  MEMOS2?:  string | null;
  MRT?:     number;
  TY?:      number;
  TF?:      number;
  FARK?:    number;          // computed (RSEDHYB - RSEDHY), signed
  RSEDHY?:  number;          // book balance (local)
  RSEDHA?:  number;          // balance (foreign currency)
  RSEDHYB?: number;          // balance valued at current rate
}

interface AkfaMaster {
  NOS?:     number;
  NOSON?:   number;
  DATES?:   string;
  NOK?:     number;
  NOUSX?:   number;
  PCI?:     string;
  DI?:      string;
  TIN?:     string;
}

/**
 * Candidates endpoint — returns foreign-currency accounts that need
 * closure as of the given date, with balances in both currencies.
 * Mirrors the KEY-HELP SQL from the FMB.
 */
app.get('/api/journal/akfa/candidates', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const date = c.req.query('date');
  if (!date) return c.json({ ok: false, error: 'date required' }, 400);

  try {
    const rows = await queryOn(
      user.schema,
      `SELECT a.noa                                      AS noa,
              MAX(b.namea)                               AS namea,
              c.noaml                                    AS noaml,
              MAX(m.namem)                               AS noaml_name,
              MAX(NVL(m.sars,1))                         AS amlh_sars,
              NVL(a.mrt,0)                               AS mrt,
              SUM(NVL(a.mdin,0))    - SUM(NVL(a.dan,0))    AS rsedhy,
              SUM(NVL(a.mdinaml,0)) - SUM(NVL(a.danaml,0)) AS rsedha
         FROM datak a, data_ac b, amhsb c, amlh m
        WHERE a.noa = b.noa
          AND a.noa = c.noa
          AND a.noaml = c.noaml
          AND m.no  = c.noaml
          AND c.noaml > 1
          AND a.noaml > 1
          AND SUBSTR(a.noa, 1, 1) <> '4'
          AND a.datemo <= TO_DATE(:d, 'YYYY-MM-DD')
        GROUP BY a.noa, c.noaml, NVL(a.mrt,0)
       HAVING SUM(NVL(a.mdin,0)) - SUM(NVL(a.dan,0)) <> 0
        ORDER BY MAX(b.namea)`,
      { d: date },
    );
    return c.json({ ok: true, rows });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

/**
 * Clearing account lookup — the system-configured P&L account that
 * receives the offsetting entries. This is typically account 4xxxxxxx
 * with THSYSTEM=1.
 */
app.get('/api/journal/akfa/clearing-account', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  try {
    const rows = await queryOn<{NOA: number; NAMEA: string | null}>(
      user.schema,
      `SELECT MAX(noa) AS noa, MAX(namea) AS namea
         FROM data_ac
        WHERE SUBSTR(noa, 1, 1) = '4' AND NVL(thsystem, 0) = 1`,
    );
    const noa = rows[0]?.NOA ?? null;
    if (!noa) return c.json({
      ok: false,
      error: 'لم يتم ضبط حساب فروقات العملة في دليل الحسابات (THSYSTEM=1)',
    }, 404);
    return c.json({ ok: true, noa, namea: rows[0]?.NAMEA });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.get('/api/journal/akfa/list', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const q = c.req.query('q') ?? '';
  const limit = Math.min(Number(c.req.query('limit') ?? 200), 500);
  try {
    const rows = await queryOn(
      user.schema,
      `SELECT * FROM (
         SELECT a.nos, a.noson, a.dates, a.nok, a.nousx,
                (SELECT COUNT(*) FROM akfaf f WHERE f.nos = a.nos AND NVL(f.ty,0)=1) AS lines
           FROM akfa a
          WHERE :q IS NULL
             OR TO_CHAR(a.nos) LIKE :q
             OR TO_CHAR(a.noson) LIKE :q
             OR TO_CHAR(a.dates, 'YYYY-MM-DD') LIKE :q
          ORDER BY a.dates DESC, a.nos DESC
       ) WHERE ROWNUM <= :lim`,
      { q: q ? `%${q}%` : null, lim: limit },
    );
    return c.json({ ok: true, rows });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.get('/api/journal/akfa', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const nos = Number(c.req.query('nos'));
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);
  try {
    const master = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT nos, noson, dates, nousx, nok, typems, di, pci, tin
         FROM akfa WHERE nos = :n`,
      { n: nos },
    );
    if (!master.length) return c.json({ ok: false, error: M.RECORD_NOT_FOUND }, 404);
    const details = await queryOn(
      user.schema,
      `SELECT f.recno, f.noa,
              b.namea AS namea,
              f.noaml,
              m.namem AS noaml_name,
              NVL(f.sarsf,1) AS sarsf,
              NVL(f.mdin,0)  AS mdin,
              NVL(f.dan,0)   AS dan,
              f.noa2, f.memos, f.memos2,
              NVL(f.mrt,0)   AS mrt,
              NVL(f.ty,0)    AS ty,
              NVL(f.tf,0)    AS tf,
              NVL(f.fark,0)  AS fark,
              NVL(f.rsedhy,0)  AS rsedhy,
              NVL(f.rsedha,0)  AS rsedha,
              NVL(f.rsedhyb,0) AS rsedhyb
         FROM akfaf f
         LEFT JOIN data_ac b ON b.noa = f.noa
         LEFT JOIN amlh     m ON m.no  = f.noaml
        WHERE f.nos = :n
        ORDER BY f.recno`,
      { n: nos },
    );
    return c.json({ ok: true, master: master[0], details });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

/** Validates an AKFA payload. Returns an Arabic error string or null. */
function validateAkfa(master: AkfaMaster, details: AkfafRow[]): string | null {
  if (!master.DATES) return 'يجب إدخال التاريخ';
  const active = details.filter(d => Number(d.TY ?? 0) === 1);
  if (!active.length) return 'يجب اختيار حساب واحد على الأقل للإقفال';
  for (const d of active) {
    if (!d.NOA)  return 'حساب غير محدد في أحد السطور';
    if (!d.NOA2) return 'حساب المقابل (فروقات العملة) غير محدد';
    const mdin = Number(d.MDIN ?? 0);
    const dan  = Number(d.DAN  ?? 0);
    if (mdin <= 0 && dan <= 0) return 'أحد السطور بدون مبلغ — يجب إلغاء التحديد أو ضبط المبلغ';
    if (mdin > 0 && dan > 0)   return 'لا يمكن أن يكون السطر مدين ودائن معاً';
  }
  return null;
}

app.post('/api/journal/akfa', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const permErr = await ensurePermission(user, AKFA_SCR, 'ins');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const { master, details } = await c.req.json() as {
    master: AkfaMaster; details: AkfafRow[];
  };
  const dateErr = ensureNotFutureDate(master.DATES);
  if (dateErr) return c.json({ ok: false, error: dateErr }, 422);
  const err = validateAkfa(master, details ?? []);
  if (err) return c.json({ ok: false, error: err }, 422);

  const dateVal = new Date(String(master.DATES));
  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    // Business rule: at most one AKFA per calendar date.
    const dup = await conn.execute<{C: number}>(
      `SELECT COUNT(*) AS c FROM akfa WHERE TRUNC(dates) = TRUNC(TO_DATE(:d, 'YYYY-MM-DD'))`,
      { d: master.DATES!.slice(0, 10) }, { outFormat: 4002 });
    const dupCount = Number((dup.rows as {C:number}[])[0]?.C ?? 0);
    if (dupCount > 0) {
      return c.json({ ok: false, error: 'يوجد قيد اقفال بهذا التاريخ' }, 422);
    }

    // Business rule: cannot predate the last existing AKFA.
    const akfaMax = await sharedGetAkfaMaxDate(user.schema);
    if (akfaMax && dateVal < akfaMax) {
      const ymd = akfaMax.toISOString().slice(0, 10);
      return c.json({
        ok: false,
        error: `تاريخ الإقفال يجب أن يكون بعد ${ymd} (آخر قيد إقفال)`,
      }, 422);
    }

    const year = dateVal.getFullYear();
    const nosonR = await conn.execute<{N:number}>(
      `SELECT NVL(MAX(noson),0)+1 AS n FROM akfa WHERE TO_CHAR(dates,'YYYY')=:y`,
      { y: String(year) }, { outFormat: 4002 });
    const noson = ((nosonR.rows as {N:number}[])[0]?.N) || 1;
    const nos = Number(String(noson) + String(year));

    // NOK via squnx — AKFA assigns on INSERT (not on post).
    const nokR = await conn.execute<{N:number}>(
      `SELECT NVL(MAX(nok),1)+1 AS n FROM datak WHERE TO_CHAR(datemo,'YYYY')=:y`,
      { y: String(year) }, { outFormat: 4002 });
    const nok = ((nokR.rows as {N:number}[])[0]?.N) || 1;

    await conn.execute(
      `INSERT INTO akfa (nos, noson, dates, nousx, nok, typems, di, pci)
       VALUES (:nos, :noson, :dates, :nousx, :nok, 3, SYSDATE, :pci)`,
      {
        nos, noson, dates: dateVal,
        nousx: user.nou,
        nok,
        pci: sharedClientTag(user),
      } as never,
    );

    // Insert active AKFAF rows only (TY=1). The FMB discards TY=0 rows.
    const active = (details ?? []).filter(d => Number(d.TY ?? 0) === 1);
    let recno = 1;
    for (const d of active) {
      await conn.execute(
        `INSERT INTO akfaf
           (nos, recno, noa, noaml, sarsf, mdin, dan, noa2,
            memos, memos2, mrt, ty, tf,
            fark, rsedhy, rsedha, rsedhyb)
         VALUES
           (:nos, :recno, :noa, :noaml, :sarsf, :mdin, :dan, :noa2,
            :memos, :memos2, :mrt, 1, :tf,
            :fark, :rsedhy, :rsedha, :rsedhyb)`,
        {
          nos,
          recno: recno++,
          noa:     Number(d.NOA),
          noaml:   Number(d.NOAML ?? 1),
          sarsf:   Number(d.SARSF ?? 1),
          mdin:    Number(d.MDIN  ?? 0),
          dan:     Number(d.DAN   ?? 0),
          noa2:    Number(d.NOA2),
          memos:   d.MEMOS  ?? null,
          memos2:  d.MEMOS2 ?? null,
          mrt:     Number(d.MRT ?? 0),
          tf:      Number(d.TF  ?? 0),
          fark:    Number(d.FARK    ?? 0),
          rsedhy:  Number(d.RSEDHY  ?? 0),
          rsedha:  Number(d.RSEDHA  ?? 0),
          rsedhyb: Number(d.RSEDHYB ?? 0),
        } as never,
      );
    }

    await conn.execute('COMMIT', {} as never);
    return c.json({
      ok: true, message: M.SAVED_SUCCESS, nos, noson, nok,
      rows: active.length,
    });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.put('/api/journal/akfa', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const permErr = await ensurePermission(user, AKFA_SCR, 'ed');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const { master, details } = await c.req.json() as {
    master: AkfaMaster; details: AkfafRow[];
  };
  const nos = Number(master.NOS);
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);
  const err = validateAkfa(master, details ?? []);
  if (err) return c.json({ ok: false, error: err }, 422);

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    // Only the latest AKFA can be edited (editing an earlier one would
    // corrupt subsequent revaluations built on its figures).
    const maxR = await conn.execute<{M: number | null}>(
      `SELECT MAX(nos) AS m FROM akfa`, {}, { outFormat: 4002 });
    const maxNos = (maxR.rows as {M:number|null}[])[0]?.M ?? null;
    if (maxNos !== null && maxNos !== nos) {
      return c.json({
        ok: false,
        error: 'يمكن تعديل آخر قيد إقفال فقط — احذف القيود اللاحقة أولاً',
      }, 422);
    }

    // Replace detail rows atomically.
    await conn.execute(`DELETE FROM akfaf WHERE nos = :n`, { n: nos } as never);

    const active = (details ?? []).filter(d => Number(d.TY ?? 0) === 1);
    let recno = 1;
    for (const d of active) {
      await conn.execute(
        `INSERT INTO akfaf
           (nos, recno, noa, noaml, sarsf, mdin, dan, noa2,
            memos, memos2, mrt, ty, tf,
            fark, rsedhy, rsedha, rsedhyb)
         VALUES
           (:nos, :recno, :noa, :noaml, :sarsf, :mdin, :dan, :noa2,
            :memos, :memos2, :mrt, 1, :tf,
            :fark, :rsedhy, :rsedha, :rsedhyb)`,
        {
          nos,
          recno: recno++,
          noa:     Number(d.NOA),
          noaml:   Number(d.NOAML ?? 1),
          sarsf:   Number(d.SARSF ?? 1),
          mdin:    Number(d.MDIN  ?? 0),
          dan:     Number(d.DAN   ?? 0),
          noa2:    Number(d.NOA2),
          memos:   d.MEMOS  ?? null,
          memos2:  d.MEMOS2 ?? null,
          mrt:     Number(d.MRT ?? 0),
          tf:      Number(d.TF  ?? 0),
          fark:    Number(d.FARK    ?? 0),
          rsedhy:  Number(d.RSEDHY  ?? 0),
          rsedha:  Number(d.RSEDHA  ?? 0),
          rsedhyb: Number(d.RSEDHYB ?? 0),
        } as never,
      );
    }

    // Master edit — only date can change, and only to a valid value.
    if (master.DATES) {
      const dateErr = ensureNotFutureDate(master.DATES);
      if (dateErr) {
        try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
        return c.json({ ok: false, error: dateErr }, 422);
      }
      await conn.execute(
        `UPDATE akfa SET dates = :d WHERE nos = :n`,
        { d: new Date(String(master.DATES)), n: nos } as never,
      );
    }

    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS, rows: active.length });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.delete('/api/journal/akfa', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const permErr = await ensurePermission(user, AKFA_SCR, 'de');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const nos = Number(c.req.query('nos'));
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    // Only the latest AKFA can be deleted — historical closures are immutable.
    const maxR = await conn.execute<{M: number | null}>(
      `SELECT MAX(nos) AS m FROM akfa`, {}, { outFormat: 4002 });
    const maxNos = (maxR.rows as {M:number|null}[])[0]?.M ?? null;
    if (maxNos !== null && maxNos !== nos) {
      return c.json({
        ok: false,
        error: 'يمكن حذف آخر قيد إقفال فقط',
      }, 422);
    }

    await conn.execute(`DELETE FROM akfafs WHERE nos = :n`, { n: nos } as never);
    await conn.execute(`DELETE FROM akfaf  WHERE nos = :n`, { n: nos } as never);
    await conn.execute(`DELETE FROM akfa   WHERE nos = :n`, { n: nos } as never);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.DELETED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.get('/api/journal/akfa/by-noson', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const noson = Number(c.req.query('noson'));
  const year  = Number(c.req.query('year'));
  if (!noson || !year) return c.json({ ok: false, error: 'noson/year required' }, 400);
  try {
    const rows = await queryOn<{NOS: number}>(
      user.schema,
      `SELECT nos FROM akfa
         WHERE noson = :s AND TO_CHAR(dates,'YYYY') = TO_CHAR(:y)`,
      { s: noson, y: String(year) },
    );
    if (!rows.length) return c.json({ ok: false, error: 'not_found' }, 404);
    return c.json({ ok: true, nos: rows[0]!.NOS });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.post('/api/voucher/:type/unpost', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const cfg = VCFG[c.req.param('type').toLowerCase()];
  if (!cfg) return c.json({ ok: false, error: 'unknown type' }, 400);

  const permErr = await ensurePermission(user, cfg.scr, 'ed');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const nos = Number(c.req.query('nos'));
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);

  try {
    const { deleted } = await unpostVoucher(user.schema, cfg.tc as Typems, nos);
    return c.json({ ok: true, message: M.UNPOSTED_SUCCESS, deleted });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

// =============================================
// /api/opening-balances — RSEDIF opening balances
//
// Legacy source: form/RSEDIF.fmb
// Master: RSIF, details: RSIFF. The old SAVE_NEW enforces
// SUM(MDIN) = SUM(DAN) unless KDANT is enabled.
// =============================================
const RSEDIF_SCR = 'RSEDIF.FMX';

interface OpeningBalanceMaster {
  NOS?: number; NOSON?: number; DATES?: string; MEMOS?: string;
  KDANT?: number; MRHL?: number; NOK?: number; YK?: number;
}

interface OpeningBalanceDetail {
  NOA?: number; NAMEA?: string; NOAML?: number; SARSF?: number;
  MDIN?: number; DAN?: number; MDINAML?: number; DANAML?: number; MRT?: number;
}

function sumOpening(rows: OpeningBalanceDetail[] | undefined, key: keyof OpeningBalanceDetail): number {
  return (rows ?? []).reduce((sum, row) => sum + (Number(row[key] ?? 0) || 0), 0);
}

function normalizeOpeningDetail(row: OpeningBalanceDetail): Required<Omit<OpeningBalanceDetail, 'NAMEA'>> {
  return {
    NOA: Number(row.NOA ?? 0),
    NOAML: Number(row.NOAML ?? 1) || 1,
    SARSF: Number(row.SARSF ?? 1) || 1,
    MDIN: Number(row.MDIN ?? 0) || 0,
    DAN: Number(row.DAN ?? 0) || 0,
    MDINAML: Number(row.MDINAML ?? row.MDIN ?? 0) || 0,
    DANAML: Number(row.DANAML ?? row.DAN ?? 0) || 0,
    MRT: Number(row.MRT ?? 0) || 0,
  };
}

app.get('/api/opening-balances/list', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const q = (c.req.query('q') ?? '').trim().toUpperCase();
  const limit = Math.min(Number(c.req.query('limit') ?? 200), 500);
  try {
    const rows = await queryOn(
      user.schema,
      `SELECT * FROM (
         SELECT r.nos, r.noson, r.dates, r.memos, NVL(r.kdant,0) AS kdant,
                NVL(r.mrhl,0) AS mrhl, r.nok, NVL(r.yk,0) AS yk, r.nousx, r.nousxu,
                (SELECT COUNT(*) FROM rsiff f WHERE f.nos = r.nos) AS line_count,
                (SELECT NVL(SUM(NVL(f.mdin,0)),0) FROM rsiff f WHERE f.nos = r.nos) AS mdin,
                (SELECT NVL(SUM(NVL(f.dan,0)),0) FROM rsiff f WHERE f.nos = r.nos) AS dan
           FROM rsif r
          WHERE :q IS NULL OR TO_CHAR(r.nos) LIKE :q OR TO_CHAR(r.noson) LIKE :q
             OR UPPER(NVL(r.memos,'')) LIKE :q
          ORDER BY r.nos DESC
       ) WHERE ROWNUM <= :lim`,
      { q: q ? `%${q}%` : null, lim: limit },
    );
    return c.json({ ok: true, rows });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.get('/api/opening-balances', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const nos = Number(c.req.query('nos') || 1);
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);
  try {
    const master = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT r.nos, r.noson, r.dates, r.memos, NVL(r.kdant,0) AS kdant,
              NVL(r.mrhl,0) AS mrhl, r.nok, NVL(r.yk,0) AS yk,
              r.nousx, r.nousxu
         FROM rsif r
        WHERE r.nos = :nos`,
      { nos },
    );
    if (!master.length) return c.json({ ok: false, error: M.RECORD_NOT_FOUND }, 404);
    const details = await queryOn(
      user.schema,
      `SELECT f.noa, a.namea, NVL(f.noaml,1) AS noaml, NVL(f.sarsf,1) AS sarsf,
              NVL(f.mdin,0) AS mdin, NVL(f.dan,0) AS dan,
              NVL(f.mdinaml,0) AS mdinaml, NVL(f.danaml,0) AS danaml,
              NVL(f.mrt,0) AS mrt
         FROM rsiff f
         LEFT JOIN data_ac a ON a.noa = f.noa
        WHERE f.nos = :nos
        ORDER BY f.noa, f.noaml`,
      { nos },
    );
    if (details.length) return c.json({ ok: true, master: master[0], details });

    // Legacy RSEDIF opens with the account/currency rows from AMHSB even when
    // the RSIF/RSIFF document has no stored detail lines yet.
    const fallbackDetails = await queryOn(
      user.schema,
      `SELECT h.noa,
              a.namea,
              p.namea AS main_name,
              NVL(h.noaml, NVL(a.amlhh, 1)) AS noaml,
              NVL(h.sarsf, 1) AS sarsf,
              NVL(h.rsm, 0) AS mdin,
              NVL(h.rsd, 0) AS dan,
              NVL(h.rsma, 0) AS mdinaml,
              NVL(h.rsda, 0) AS danaml,
              0 AS mrt
         FROM amhsb h
         JOIN data_ac a ON a.noa = h.noa
         LEFT JOIN data_ac p ON p.noa = a.typea
        WHERE NVL(a.rtba, 0) = 5
        ORDER BY h.noa, NVL(h.noaml, NVL(a.amlhh, 1))`,
      {},
    );
    return c.json({ ok: true, master: master[0], details: fallbackDetails });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.post('/api/opening-balances', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const permErr = await ensurePermission(user, RSEDIF_SCR, 'ins');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const { master, details } = await c.req.json() as { master: OpeningBalanceMaster; details: OpeningBalanceDetail[] };
  const dateErr = ensureNotFutureDate(master?.DATES);
  if (dateErr) return c.json({ ok: false, error: dateErr }, 422);
  if (!details?.length) return c.json({ ok: false, error: 'يجب إدخال سطر واحد على الأقل' }, 422);

  const sumMdin = sumOpening(details, 'MDIN');
  const sumDan = sumOpening(details, 'DAN');
  if (Number(master?.KDANT ?? 0) === 0 && Math.abs(sumMdin - sumDan) > 0.005) {
    return c.json({ ok: false, error: M.DEBIT_CREDIT_MISMATCH }, 422);
  }

  const dateVal = new Date(String(master.DATES));
  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const existing = await conn.execute<{ C: number }>(
      `SELECT COUNT(*) AS c FROM rsif WHERE nos = 1`,
      {},
      { outFormat: 4002 },
    );
    const count = Number(((existing.rows as { C: number }[] | undefined)?.[0]?.C) ?? 0);
    if (count > 0) return c.json({ ok: false, error: 'رصيد افتتاحي رقم 1 موجود، استخدم التعديل' }, 409);

    await conn.execute(
      `INSERT INTO rsif (nos, noson, dates, memos, kdant, mrhl, nok, yk, nousx, nousxu)
       VALUES (1, 1, :dates, :memos, :kdant, :mrhl, 1, 0, :nousx, NULL)`,
      {
        dates: dateVal,
        memos: master.MEMOS || 'رصيد افتتاحي',
        kdant: Number(master.KDANT ?? 0),
        mrhl: Number(master.MRHL ?? 1),
        nousx: user.nou,
      } as never,
    );
    for (const raw of details) {
      const d = normalizeOpeningDetail(raw);
      if (!d.NOA) continue;
      await conn.execute(
        `INSERT INTO rsiff (noa, noaml, mdin, dan, mdinaml, danaml, mrt, sarsf, nos)
         VALUES (:noa, :noaml, :mdin, :dan, :mdinaml, :danaml, :mrt, :sarsf, 1)`,
        d as never,
      );
    }
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS, nos: 1, noson: 1 });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.put('/api/opening-balances', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const permErr = await ensurePermission(user, RSEDIF_SCR, 'ed');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const { master, details } = await c.req.json() as { master: OpeningBalanceMaster; details: OpeningBalanceDetail[] };
  const nos = Number(master?.NOS || 1);
  const dateErr = ensureNotFutureDate(master?.DATES);
  if (dateErr) return c.json({ ok: false, error: dateErr }, 422);
  if (!details?.length) return c.json({ ok: false, error: 'يجب إدخال سطر واحد على الأقل' }, 422);

  const sumMdin = sumOpening(details, 'MDIN');
  const sumDan = sumOpening(details, 'DAN');
  if (Number(master?.KDANT ?? 0) === 0 && Math.abs(sumMdin - sumDan) > 0.005) {
    return c.json({ ok: false, error: M.DEBIT_CREDIT_MISMATCH }, 422);
  }

  const dateVal = new Date(String(master.DATES));
  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const current = await conn.execute<{ MRHL: number; YK: number }>(
      `SELECT NVL(mrhl,0) AS mrhl, NVL(yk,0) AS yk FROM rsif WHERE nos = :nos FOR UPDATE OF nos NOWAIT`,
      { nos },
      { outFormat: 4002 },
    );
    const row = (current.rows as { MRHL: number; YK: number }[] | undefined)?.[0];
    if (!row) return c.json({ ok: false, error: M.RECORD_NOT_FOUND }, 404);
    if (Number(row.YK ?? 0) > 0) return c.json({ ok: false, error: 'هذه الأرصدة مرحلة من العام السابق ولا يمكن تعديلها' }, 422);
    const postedErr = await ensureLegacyNotPosted(conn, row.MRHL, 'تعديل');
    if (postedErr) return c.json({ ok: false, error: postedErr }, 422);

    await conn.execute(
      `UPDATE rsif
          SET dates = :dates, memos = :memos, kdant = :kdant, mrhl = :mrhl, nousxu = :nousxu
        WHERE nos = :nos`,
      {
        nos,
        dates: dateVal,
        memos: master.MEMOS || 'رصيد افتتاحي',
        kdant: Number(master.KDANT ?? 0),
        mrhl: Number(master.MRHL ?? row.MRHL ?? 1),
        nousxu: user.nou,
      } as never,
    );
    await conn.execute(`DELETE FROM rsiff WHERE nos = :nos`, { nos } as never);
    for (const raw of details) {
      const d = normalizeOpeningDetail(raw);
      if (!d.NOA) continue;
      await conn.execute(
        `INSERT INTO rsiff (noa, noaml, mdin, dan, mdinaml, danaml, mrt, sarsf, nos)
         VALUES (:noa, :noaml, :mdin, :dan, :mdinaml, :danaml, :mrt, :sarsf, :nos)`,
        { ...d, nos } as never,
      );
    }
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS, nos });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.delete('/api/opening-balances', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const permErr = await ensurePermission(user, RSEDIF_SCR, 'de');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const nos = Number(c.req.query('nos') || 1);
  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const current = await conn.execute<{ MRHL: number; YK: number }>(
      `SELECT NVL(mrhl,0) AS mrhl, NVL(yk,0) AS yk FROM rsif WHERE nos = :nos FOR UPDATE OF nos NOWAIT`,
      { nos },
      { outFormat: 4002 },
    );
    const row = (current.rows as { MRHL: number; YK: number }[] | undefined)?.[0];
    if (!row) return c.json({ ok: false, error: M.RECORD_NOT_FOUND }, 404);
    if (Number(row.YK ?? 0) > 0) return c.json({ ok: false, error: 'هذه الأرصدة مرحلة من العام السابق ولا يمكن حذفها' }, 422);
    const postedErr = await ensureLegacyNotPosted(conn, row.MRHL, 'حذف');
    if (postedErr) return c.json({ ok: false, error: postedErr }, 422);

    await conn.execute(`DELETE FROM rsiff WHERE nos = :nos`, { nos } as never);
    await conn.execute(`DELETE FROM rsif WHERE nos = :nos`, { nos } as never);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.DELETED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.get('/api/opening-balances/print', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const nos = Number(c.req.query('nos') || 1);
  const qs = new URLSearchParams({ report: 'RSEDIF', documentNo: String(nos) });
  return c.redirect(`/api/legacy-report/RSEDIF/print?${qs.toString()}`);
});

// =============================================
// /api/memos — MEMO appointment/reminder screen
//
// Legacy source: form/MEMO.fmb
// Table: MEMO(DATEM, MEMO, LOP, DALOP, LOPA, NOU).
// The original form identifies rows by Oracle's current record; in the web
// screen we expose ROWIDTOCHAR(rowid) as RID so the table schema stays intact.
// =============================================
const MEMO_SCR = 'MEMO.FMX';

interface MemoBody {
  RID?: string;
  DATEM?: string | null;
  MEMO?: string | null;
  LOP?: string | null;
  DALOP?: string | null;
  LOPA?: string | null;
  NOU?: number | null;
}

function memoDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function memoDayLabel(code: unknown): string | null {
  switch (String(code ?? '').toUpperCase()) {
    case 'SAT': return 'السبت';
    case 'SUN': return 'الأحد';
    case 'MON': return 'الإثنين';
    case 'TUE': return 'الثلاثاء';
    case 'WED': return 'الأربعاء';
    case 'THU': return 'الخميس';
    case 'FRI': return 'الجمعة';
    case 'MMM': return 'MMM';
    case 'NOT': return 'NOT';
    default: return null;
  }
}

function normalizeMemoBody(body: MemoBody, user: SessionUser): MemoBody {
  const datem = memoDate(body.DATEM);
  const dalop = memoDate(body.DALOP) ?? datem;
  const lop = datem ? 'NOT' : String(body.LOP || 'NOT').toUpperCase();
  return {
    DATEM: datem ? datem.toISOString().slice(0, 10) : null,
    MEMO: String(body.MEMO ?? '').trim(),
    LOP: lop,
    DALOP: dalop ? dalop.toISOString().slice(0, 10) : null,
    LOPA: datem ? 'NOT' : (body.LOPA || memoDayLabel(lop) || 'NOT'),
    NOU: Number(body.NOU ?? user.nou) || user.nou,
  };
}

app.get('/api/memos', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);

  const mode = c.req.query('mode') || 'today';
  const q = String(c.req.query('q') || '').trim().toUpperCase();
  const limit = Math.min(Number(c.req.query('limit') ?? 300), 1000);
  const where: string[] = [];
  const binds: Record<string, unknown> = {};

  if (mode === 'today') where.push('TRUNC(dalop) = TRUNC(SYSDATE)');
  else if (mode === 'future') where.push('TRUNC(dalop) >= TRUNC(SYSDATE)');
  else if (mode === 'past') where.push('TRUNC(dalop) < TRUNC(SYSDATE)');

  if (!user.isAdmin) {
    where.push('(NVL(nou,0) = 0 OR NVL(nou,0) = :nou)');
    binds['nou'] = user.nou;
  }
  if (q) {
    where.push(`(UPPER(NVL(memo,'')) LIKE :q OR UPPER(NVL(lopa,'')) LIKE :q OR TO_CHAR(nou) LIKE :q)`);
    binds['q'] = `%${q}%`;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const rows = await queryOn(
      user.schema,
      `SELECT * FROM (
         SELECT ROWIDTOCHAR(m.ROWID) AS rid,
                m.datem, m.memo, m.lop, m.dalop, m.lopa, m.nou,
                u.nameu
           FROM memo m
           LEFT JOIN user_u u ON u.nou = m.nou
          ${whereSql}
          ORDER BY NVL(m.dalop, m.datem) DESC, m.nou
       ) WHERE ROWNUM <= :lim`,
      { ...binds, lim: limit },
    );
    return c.json({ ok: true, rows, count: rows.length, mode });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.post('/api/memos', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const permErr = await ensurePermission(user, MEMO_SCR, 'ins');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const body = normalizeMemoBody(await c.req.json() as MemoBody, user);
  if (!body.MEMO) return c.json({ ok: false, error: 'يجب إدخال نص الملاحظة' }, 422);
  if (body.DATEM && new Date(body.DATEM) < new Date(new Date().toDateString())) {
    return c.json({ ok: false, error: 'التاريخ المدخل قد مضى' }, 422);
  }

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    await conn.execute(
      `INSERT INTO memo (datem, memo, lop, dalop, lopa, nou)
       VALUES (:datem, :memo, :lop, :dalop, :lopa, :nou)`,
      {
        datem: body.DATEM ? new Date(body.DATEM) : null,
        memo: body.MEMO,
        lop: body.LOP,
        dalop: body.DALOP ? new Date(body.DALOP) : null,
        lopa: body.LOPA,
        nou: body.NOU,
      } as never,
    );
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.put('/api/memos', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const permErr = await ensurePermission(user, MEMO_SCR, 'ed');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const raw = await c.req.json() as MemoBody;
  const rid = String(raw.RID || '').trim();
  if (!rid) return c.json({ ok: false, error: 'rid required' }, 400);
  const body = normalizeMemoBody(raw, user);
  if (!body.MEMO) return c.json({ ok: false, error: 'يجب إدخال نص الملاحظة' }, 422);

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const lock = await conn.execute<{NOU: number | null}>(
      `SELECT nou FROM memo WHERE ROWID = CHARTOROWID(:rid) FOR UPDATE NOWAIT`,
      { rid } as never,
      { outFormat: 4002 },
    );
    const row = (lock.rows as {NOU: number | null}[] | undefined)?.[0];
    if (!row) return c.json({ ok: false, error: M.RECORD_NOT_FOUND }, 404);
    if (!user.isAdmin && Number(row.NOU ?? 0) !== user.nou && Number(row.NOU ?? 0) !== 0) {
      return c.json({ ok: false, error: M.PERM_DENIED_ED }, 403);
    }

    await conn.execute(
      `UPDATE memo
          SET datem = :datem, memo = :memo, lop = :lop,
              dalop = :dalop, lopa = :lopa, nou = :nou
        WHERE ROWID = CHARTOROWID(:rid)`,
      {
        rid,
        datem: body.DATEM ? new Date(body.DATEM) : null,
        memo: body.MEMO,
        lop: body.LOP,
        dalop: body.DALOP ? new Date(body.DALOP) : null,
        lopa: body.LOPA,
        nou: body.NOU,
      } as never,
    );
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.delete('/api/memos', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const permErr = await ensurePermission(user, MEMO_SCR, 'de');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const rid = String(c.req.query('rid') || '').trim();
  if (!rid) return c.json({ ok: false, error: 'rid required' }, 400);
  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const lock = await conn.execute<{NOU: number | null}>(
      `SELECT nou FROM memo WHERE ROWID = CHARTOROWID(:rid) FOR UPDATE NOWAIT`,
      { rid } as never,
      { outFormat: 4002 },
    );
    const row = (lock.rows as {NOU: number | null}[] | undefined)?.[0];
    if (!row) return c.json({ ok: false, error: M.RECORD_NOT_FOUND }, 404);
    if (!user.isAdmin && Number(row.NOU ?? 0) !== user.nou && Number(row.NOU ?? 0) !== 0) {
      return c.json({ ok: false, error: M.PERM_DENIED_DE }, 403);
    }
    await conn.execute(`DELETE FROM memo WHERE ROWID = CHARTOROWID(:rid)`, { rid } as never);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.DELETED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

// =============================================
// /api/sms-numbers — SMSN.fmx
//
// Legacy source: form/SMSN.fmb
// Base table: DATA_AC. The original form only edits phone/SMS flags for
// existing RTBA=5 accounts; create/delete keys are disabled in the old form.
// Important legacy filters:
//   ty=2 => customers branch SUBSTR(NOA,1,3)=122
//   else => RTBA=5 excluding 122/123 and non-target TYPEA branches.
// =============================================
const SMSN_SCR = 'SMSN.FMX';

interface SmsnBody {
  NOTLL?: string | number | null;
  TEL2?: string | number | null;
  TEL?: string | number | null;
  SMS?: string | number | boolean | null;
  NOTDLL?: string | number | boolean | null;
  T_SMS?: string | number | boolean | null;
}

function smsnDigits(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '');
}

function smsnPhone(value: unknown, label: string): { value: number | null; error?: string } {
  const digits = smsnDigits(value);
  if (!digits) return { value: null };
  if (digits.length < 9) return { value: null, error: `${label}: رقم الهاتف قصير يرجى التأكد من الرقم` };
  if (digits.length > 9) return { value: null, error: `${label}: رقم الهاتف طويل يرجى التأكد من الرقم` };
  if (!/^(77|71|73|70|78)/.test(digits)) {
    return { value: null, error: `${label}: لا يوجد شركة اتصالات يبدأ رقمها بـ ${digits.slice(0, 2)} يرجى التأكد من الرقم` };
  }
  return { value: Number(digits) };
}

function boolNum(value: unknown): number {
  return value === true || value === 'true' || Number(value ?? 0) > 0 ? 1 : 0;
}

function normalizeSmsnBody(body: SmsnBody): {
  NOTLL: number | null;
  TEL2: number | null;
  TEL: number | null;
  SMS: number;
  NOTDLL: number;
  T_SMS: number;
  error?: string;
} {
  const phone1 = smsnPhone(body.NOTLL, 'رقم الهاتف 1');
  if (phone1.error) return { NOTLL: null, TEL2: null, TEL: null, SMS: 0, NOTDLL: 0, T_SMS: 0, error: phone1.error };
  const phone2 = smsnPhone(body.TEL2, 'رقم الهاتف 2');
  if (phone2.error) return { NOTLL: null, TEL2: null, TEL: null, SMS: 0, NOTDLL: 0, T_SMS: 0, error: phone2.error };
  const publicPhone = smsnPhone(body.TEL, 'رقم التلفون');
  if (publicPhone.error) return { NOTLL: null, TEL2: null, TEL: null, SMS: 0, NOTDLL: 0, T_SMS: 0, error: publicPhone.error };

  let notll = phone1.value;
  let tel2 = phone2.value;
  if (!notll && tel2) {
    notll = tel2;
    tel2 = null;
  } else if (notll && tel2 && notll === tel2) {
    tel2 = null;
  }

  return {
    NOTLL: notll,
    TEL2: tel2,
    TEL: publicPhone.value,
    SMS: boolNum(body.SMS),
    NOTDLL: boolNum(body.NOTDLL),
    T_SMS: boolNum(body.T_SMS),
  };
}

async function ensureSmsnUpdatePermission(user: SessionUser): Promise<string | null> {
  const p = await getPermissions(user, SMSN_SCR);
  // SMSN legacy uses USERGN.PR to control DATA_AC update_allowed.
  return (p.ed > 0 || p.pr > 0) ? null : 'ليس لديك صلاحية تعديل أرقام الرسائل في هذه الشاشة';
}

app.get('/api/sms-numbers', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const kind = c.req.query('kind') === 'other' ? 'other' : 'customers';
  const q = String(c.req.query('q') ?? '').trim().toUpperCase();
  const limit = Math.min(Number(c.req.query('limit') ?? 300), 1000);

  const where = kind === 'customers'
    ? `NVL(rtba,0)=5 AND SUBSTR(TO_CHAR(noa),1,3)='122'`
    : `NVL(rtba,0)=5
       AND SUBSTR(TO_CHAR(noa),1,3) NOT IN ('122','123')
       AND SUBSTR(TO_CHAR(typea),1,2) NOT IN ('11','21')
       AND SUBSTR(TO_CHAR(typea),1,1) NOT IN ('4','3')`;

  try {
    const rows = await queryOn(
      user.schema,
      `SELECT * FROM (
         SELECT noa, namea, typea, notll, tel, tel2,
                NVL(sms,0) AS sms, NVL(notdll,0) AS notdll, NVL(t_sms,0) AS t_sms
           FROM data_ac
          WHERE ${where}
            AND (:q IS NULL
              OR UPPER(NVL(namea,'')) LIKE :q
              OR TO_CHAR(noa) LIKE :q
              OR TO_CHAR(NVL(notll,0)) LIKE :q
              OR TO_CHAR(NVL(tel,0)) LIKE :q
              OR TO_CHAR(NVL(tel2,0)) LIKE :q)
          ORDER BY namea, noa
       ) WHERE ROWNUM <= :lim`,
      { q: q ? `%${q}%` : null, lim: limit },
    );
    const cfg = await queryOn<{ T_SMS: number }>(
      user.schema,
      `SELECT NVL(MAX(t_sms),0) AS t_sms FROM titl`,
    );
    return c.json({
      ok: true,
      rows,
      count: rows.length,
      kind,
      showWhatsApp: Number(cfg[0]?.T_SMS ?? 0) > 0,
    });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.put('/api/sms-numbers/:noa', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const permErr = await ensureSmsnUpdatePermission(user);
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const noa = Number(c.req.param('noa'));
  if (!noa) return c.json({ ok: false, error: 'noa required' }, 400);
  const body = normalizeSmsnBody(await c.req.json() as SmsnBody);
  if (body.error) return c.json({ ok: false, error: body.error }, 422);

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const lock = await conn.execute<{ NOA: number }>(
      `SELECT noa FROM data_ac WHERE noa = :noa AND NVL(rtba,0)=5 FOR UPDATE OF noa NOWAIT`,
      { noa } as never,
      { outFormat: 4002 },
    );
    if (!((lock.rows as { NOA: number }[] | undefined)?.length)) {
      return c.json({ ok: false, error: M.RECORD_NOT_FOUND }, 404);
    }

    await conn.execute(
      `UPDATE data_ac
          SET notll = :notll,
              tel2 = :tel2,
              tel = :tel,
              sms = :sms,
              notdll = :notdll,
              t_sms = :t_sms,
              de = SYSDATE,
              pce = :pce,
              nousxu = :nousxu,
              ned = NVL(ned,0) + 1
        WHERE noa = :noa AND NVL(rtba,0)=5`,
      {
        noa,
        notll: body.NOTLL,
        tel2: body.TEL2,
        tel: body.TEL,
        sms: body.SMS,
        notdll: body.NOTDLL,
        t_sms: body.T_SMS,
        pce: sharedClientTag(user),
        nousxu: user.nou,
      } as never,
    );
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

// =============================================
// /api/screen-keys — KF.fmx
//
// Legacy source: form/KF.fmb
// Table: KEYF(KEYF,FIELN), with DATA_ACM as the screen-name LOV.
// =============================================
const KF_SCR = 'KF.FMX';

interface ScreenKeyBody {
  KEYF?: string | null;
  FIELN?: string | null;
}

function normalizeScreenForm(value: unknown): string | null {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return null;
  const safe = raw.replace(/[^A-Z0-9_./-]/g, '');
  return safe.endsWith('.FMX') ? safe : `${safe}.FMX`;
}

app.get('/api/screen-keys', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  try {
    const rows = await queryOn(
      user.schema,
      `SELECT k.keyf, k.fieln, a.namea, a.namee
         FROM keyf k
         LEFT JOIN data_acm a ON UPPER(a.namef) = UPPER(k.fieln)
        ORDER BY k.keyf`,
    );
    return c.json({ ok: true, rows });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.get('/api/screen-keys/screens', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const q = String(c.req.query('q') ?? '').trim().toUpperCase();
  const limit = Math.min(Number(c.req.query('limit') ?? 500), 1000);
  try {
    const rows = await queryOn(
      user.schema,
      `SELECT * FROM (
         SELECT namef, namea, namee, tsys
           FROM data_acm
          WHERE namef IS NOT NULL
            AND (:q IS NULL
              OR UPPER(NVL(namea,'')) LIKE :q
              OR UPPER(NVL(namee,'')) LIKE :q
              OR UPPER(NVL(namef,'')) LIKE :q)
          ORDER BY tsys, namea
       ) WHERE ROWNUM <= :lim`,
      { q: q ? `%${q}%` : null, lim: limit },
    );
    return c.json({ ok: true, rows });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.put('/api/screen-keys/:keyf', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const permErr = await ensurePermission(user, KF_SCR, 'ed');
  if (permErr) return c.json({ ok: false, error: permErr }, 403);

  const keyf = String(c.req.param('keyf') || '').trim().toUpperCase();
  if (!/^F\d{1,2}$/.test(keyf)) return c.json({ ok: false, error: 'keyf required' }, 400);
  const body = await c.req.json() as ScreenKeyBody;
  const fieln = normalizeScreenForm(body.FIELN);

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    if (fieln) {
      const exists = await conn.execute<{ CNT: number }>(
        `SELECT COUNT(*) AS cnt FROM data_acm WHERE UPPER(namef)=UPPER(:f)`,
        { f: fieln },
        { outFormat: 4002 },
      );
      if (((exists.rows as { CNT: number }[] | undefined)?.[0]?.CNT ?? 0) === 0) {
        return c.json({ ok: false, error: `الشاشة ${fieln} غير موجودة في دليل الشاشات` }, 422);
      }
    }

    await conn.execute(
      `MERGE INTO keyf k
       USING (SELECT :keyf AS keyf, :fieln AS fieln FROM dual) s
          ON (UPPER(k.keyf) = UPPER(s.keyf))
        WHEN MATCHED THEN UPDATE SET k.fieln = s.fieln
        WHEN NOT MATCHED THEN INSERT (keyf, fieln) VALUES (s.keyf, s.fieln)`,
      { keyf, fieln } as never,
    );
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

// =============================================
// /api/posting-documents — TRHL.fmx
//
// Legacy source: form/TRHL.fmb
// Base view/table: TBTRHL. The old form toggles MRHL directly on the
// document master table named by NATB, with guards for pending entries,
// currency-difference journals and closed months.
// =============================================
const TRHL_SCR = 'TRHL.FMX';
const TRHL_TABLES: Record<string, string> = {
  SNDKD: 'SNDKD',
  SNDKD2: 'SNDKD2',
  SNDK: 'SNDK',
  SNDS: 'SNDS',
  FB: 'FB',
  FBM: 'FBM',
  FM: 'FM',
  FM2: 'FM',
  FMM: 'FMM',
  ATM: 'ATM',
  ASM: 'ASM',
  ATMM: 'ATMM',
};

interface TrhlToggleBody {
  targetMrhl?: number | string | boolean;
  rows?: Array<{ NOS?: number; NATB?: string | null }>;
  confirm?: string;
}

function trhlTarget(value: unknown): 0 | 1 {
  return Number(value ?? 1) === 0 ? 0 : 1;
}

function trhlTable(value: unknown): string | null {
  const key = String(value ?? '').trim().toUpperCase();
  return TRHL_TABLES[key] ?? null;
}

async function ensureTrhlPermission(user: SessionUser): Promise<string | null> {
  const p = await getPermissions(user, TRHL_SCR);
  // TRHL legacy enables PRN/TYXX using USERGN.PR.
  return p.pr > 0 ? null : 'ليس لديك صلاحية ترحيل او الغاء ترحيل المستندات';
}

async function trhlFxMaxDate(
  conn: Parameters<typeof nextPostingNo>[0],
): Promise<Date | null> {
  const r = await conn.execute<{ D: Date | null }>(
    `SELECT MAX(datemo) AS d FROM datak WHERE typems = 3`,
    {},
    { outFormat: 4002 },
  );
  return (r.rows as { D: Date | null }[] | undefined)?.[0]?.D ?? null;
}

async function trhlClosedMonth(
  conn: Parameters<typeof nextPostingNo>[0],
  dates: Date,
): Promise<boolean> {
  const r = await conn.execute<{ C: number }>(
    `SELECT COUNT(*) AS c FROM month
      WHERE nom = TO_NUMBER(TO_CHAR(:d,'MM'))
        AND year = TO_NUMBER(TO_CHAR(:d,'YYYY'))`,
    { d: dates } as never,
    { outFormat: 4002 },
  );
  return Number((r.rows as { C: number }[] | undefined)?.[0]?.C ?? 0) > 0;
}

async function trhlToggleOne(
  conn: Parameters<typeof nextPostingNo>[0],
  rowRef: { NOS?: number; NATB?: string | null },
  targetMrhl: 0 | 1,
): Promise<{ ok: boolean; message?: string; nos?: number; table?: string }> {
  const nos = Number(rowRef.NOS ?? 0);
  const table = trhlTable(rowRef.NATB);
  if (!nos || !table) return { ok: false, message: 'بيانات المستند غير مكتملة' };

  const doc = await conn.execute<{ NOS: number; DATES: Date; MRHL: number; KDANT: number | null }>(
    `SELECT nos, dates, NVL(mrhl,0) AS mrhl, NVL(kdant,0) AS kdant
       FROM tbtrhl
      WHERE nos = :nos AND UPPER(natb) = UPPER(:natb)
        AND ROWNUM = 1`,
    { nos, natb: String(rowRef.NATB ?? '').toUpperCase() },
    { outFormat: 4002 },
  );
  const current = (doc.rows as { NOS: number; DATES: Date; MRHL: number; KDANT: number | null }[] | undefined)?.[0];
  if (!current) return { ok: false, message: M.RECORD_NOT_FOUND, nos, table };

  if (Number(current.KDANT ?? 0) > 0) {
    return { ok: false, message: 'لا يمكن ترحيل او الغاء ترحيل مستند قيد الانتظار', nos, table };
  }

  const unposting = Number(current.MRHL ?? 0) === 0 && targetMrhl === 1;
  if (unposting) {
    const fxDate = await trhlFxMaxDate(conn);
    if (fxDate && fxDate >= current.DATES) {
      return { ok: false, message: 'لا يمكن الغاء الترحيل المستند يوجد قيد فوارق عملة بعد تاريخ المستند', nos, table };
    }
    if (await trhlClosedMonth(conn, current.DATES)) {
      return { ok: false, message: 'لا يمكن الغاء الترحيل المستند كون الشهر مقفل', nos, table };
    }
  }

  await conn.execute(
    `SELECT nos FROM ${table} WHERE nos = :nos FOR UPDATE NOWAIT`,
    { nos } as never,
  );
  await conn.execute(
    `UPDATE ${table} SET mrhl = :mrhl WHERE nos = :nos`,
    { mrhl: targetMrhl, nos } as never,
  );
  return { ok: true, nos, table };
}

app.get('/api/posting-documents/types', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  try {
    const rows = await queryOn(
      user.schema,
      `SELECT DISTINCT typems, tmc
         FROM tbtrhl
        WHERE NVL(typems,0) <> 18
        ORDER BY typems`,
    );
    return c.json({ ok: true, rows });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.get('/api/posting-documents', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const status = c.req.query('status') === 'posted' ? 'posted' : 'unposted';
  const type = Number(c.req.query('typems') ?? 0);
  const noson = Number(c.req.query('noson') ?? 0);
  const opRaw = String(c.req.query('op') ?? '<=');
  const op = opRaw === '=' || opRaw === '>=' ? opRaw : '<=';
  const dateRaw = String(c.req.query('date') ?? '').trim();
  const q = String(c.req.query('q') ?? '').trim().toUpperCase();
  const limit = Math.min(Number(c.req.query('limit') ?? 500), 1000);
  const where: string[] = ['NVL(typems,0) <> 18'];
  const binds: Record<string, unknown> = { lim: limit };

  where.push(status === 'posted' ? 'NVL(mrhl,0) = 0' : 'NVL(mrhl,0) > 0');
  if (type > 0) {
    where.push('NVL(typems,0) = :typems');
    binds['typems'] = type;
  }
  if (noson > 0) {
    where.push('NVL(noson,0) = :noson');
    binds['noson'] = noson;
  }
  if (dateRaw) {
    where.push(`TRUNC(dates) ${op} TRUNC(:d)`);
    binds['d'] = new Date(dateRaw);
  }
  if (q) {
    where.push(`(UPPER(NVL(tmc,'')) LIKE :q OR UPPER(NVL(natb,'')) LIKE :q OR TO_CHAR(nos) LIKE :q OR TO_CHAR(noson) LIKE :q)`);
    binds['q'] = `%${q}%`;
  }

  try {
    const rows = await queryOn(
      user.schema,
      `SELECT * FROM (
         SELECT noall, nos, noson, typems, dates, NVL(mrhl,0) AS mrhl,
                NVL(kdant,0) AS kdant, natb, tmc
           FROM tbtrhl
          WHERE ${where.join(' AND ')}
          ORDER BY dates DESC, typems, noson
       ) WHERE ROWNUM <= :lim`,
      binds,
    );
    return c.json({ ok: true, rows, count: rows.length, status });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.put('/api/posting-documents/:natb/:nos', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const permErr = await ensureTrhlPermission(user);
  if (permErr) return c.json({ ok: false, error: permErr }, 403);
  const targetMrhl = trhlTarget((await c.req.json().catch(() => ({} as TrhlToggleBody))).targetMrhl);
  const rowRef = { NATB: c.req.param('natb'), NOS: Number(c.req.param('nos')) };

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const result = await trhlToggleOne(conn, rowRef, targetMrhl);
    if (!result.ok) {
      await conn.execute('ROLLBACK', {} as never);
      return c.json({ ok: false, error: result.message }, 422);
    }
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: targetMrhl === 0 ? 'تم ترحيل المستند' : 'تم الغاء ترحيل المستند' });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.put('/api/posting-documents/bulk', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const permErr = await ensureTrhlPermission(user);
  if (permErr) return c.json({ ok: false, error: permErr }, 403);
  const body = await c.req.json().catch(() => ({} as TrhlToggleBody)) as TrhlToggleBody;
  if (body.confirm !== 'TRHL') return c.json({ ok: false, error: 'confirmation required' }, 400);
  const targetMrhl = trhlTarget(body.targetMrhl);
  const rows = (body.rows ?? []).slice(0, 500);
  if (!rows.length) return c.json({ ok: false, error: 'لا توجد مستندات محددة' }, 400);

  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  const results: Array<{ ok: boolean; message?: string; nos?: number; table?: string }> = [];
  try {
    for (const row of rows) {
      results.push(await trhlToggleOne(conn, row, targetMrhl));
    }
    await conn.execute('COMMIT', {} as never);
    const changed = results.filter(r => r.ok).length;
    const failed = results.length - changed;
    return c.json({ ok: true, changed, failed, results, message: `تم تحديث ${changed} مستند` });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message, results }, 500);
  } finally { await conn.close(); }
});

// =============================================
// /api/sms-center — SMS.fmx
//
// Legacy source: form/SMS.fmb. The old screen prepares rows in SENDSMS,
// exports them to D:\SMS and can call an external SMS gateway. The new
// implementation exposes the same screen state and keeps destructive /
// outbound operations behind explicit in-screen confirmation.
// =============================================
const SMS_SCR = 'SMS.FMX';

async function ensureSmsPermission(user: SessionUser): Promise<string | null> {
  const p = await getPermissions(user, SMS_SCR);
  return p.pr > 0 ? null : 'ليس لديك صلاحية شاشة الرسائل';
}

app.get('/api/sms-center/summary', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const limit = Math.min(Number(c.req.query('limit') ?? 200), 500);
  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const settings = await conn.execute(
      `SELECT MAX(t_sms) AS t_sms,
              MAX(inda_sms) AS inda_sms,
              MAX(nwsms) AS nwsms,
              MAX(NVL(tsms,0)) AS tsms,
              MAX(NVL(op,0)) AS op,
              MAX(NVL(sms_tb,0)) AS sms_tb,
              MAX(datesms) AS datesms
         FROM titl`,
      {},
      { outFormat: 4002 },
    );
    const movement = await conn.execute(
      `SELECT MAX(datemo) AS datesms
         FROM datak
        WHERE NVL(kdant,0)=0
          AND noa IN (SELECT noa FROM data_ac WHERE NVL(tel,0)>0 AND NVL(sms,0)=0)`,
      {},
      { outFormat: 4002 },
    );
    const counts = await conn.execute(
      `SELECT COUNT(*) AS rows_count,
              COUNT(DISTINCT phoneno) AS phone_count,
              SUM(CASE WHEN LENGTH(ms1)>70 THEN 1 ELSE 0 END) AS long_count
         FROM sendsms`,
      {},
      { outFormat: 4002 },
    );
    let rows;
    try {
      rows = await conn.execute(
        `SELECT * FROM (
           SELECT customern, phoneno, customername, ms1, ms2, noaml, noa, issent
             FROM sendsms
            ORDER BY customern DESC
         ) WHERE ROWNUM <= :lim`,
        { lim: limit },
        { outFormat: 4002 },
      );
    } catch {
      rows = await conn.execute(
        `SELECT * FROM (
           SELECT customern, phoneno, customername, ms1, ms2, noaml, noa
             FROM sendsms
            ORDER BY customern DESC
         ) WHERE ROWNUM <= :lim`,
        { lim: limit },
        { outFormat: 4002 },
      );
    }
    return c.json({
      ok: true,
      settings: (settings.rows as unknown[] | undefined)?.[0] ?? {},
      movementDate: (movement.rows as unknown[] | undefined)?.[0] ?? {},
      counts: (counts.rows as unknown[] | undefined)?.[0] ?? {},
      rows: rows.rows ?? [],
    });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.put('/api/sms-center/options', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const permErr = await ensureSmsPermission(user);
  if (permErr) return c.json({ ok: false, error: permErr }, 403);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    await conn.execute(
      `UPDATE titl
          SET tsms = :tsms,
              op = :op,
              sms_tb = :sms_tb,
              nwsms = :nwsms`,
      {
        tsms: Number(body['TSMS'] ?? body['tsms'] ?? 0),
        op: Number(body['OP'] ?? body['op'] ?? 0),
        sms_tb: Number(body['SMS_TB'] ?? body['sms_tb'] ?? 0),
        nwsms: String(body['NWSMS'] ?? body['nwsms'] ?? '').slice(0, 500),
      } as never,
    );
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.post('/api/sms-center/clear', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const permErr = await ensureSmsPermission(user);
  if (permErr) return c.json({ ok: false, error: permErr }, 403);
  const body = await c.req.json().catch(() => ({})) as { confirm?: string };
  if (body.confirm !== 'SMS') return c.json({ ok: false, error: 'confirmation required' }, 400);
  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const r = await conn.execute(`DELETE FROM sendsms`, {} as never);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, deleted: r.rowsAffected ?? 0, message: 'تم حذف الرسائل المصدرة' });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

// =============================================
// /api/legacy-copy — COPY.fmx
// =============================================
const COPY_SCR = 'COPY.FMX';

async function ensureCopyPermission(user: SessionUser): Promise<string | null> {
  const p = await getPermissions(user, COPY_SCR);
  return p.pr > 0 ? null : 'ليس لديك صلاحية شاشة النسخ الاحتياطي';
}

function copyDirFromPath(pathValue: string): string {
  const path = String(pathValue || '').trim();
  const slash = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return slash >= 0 ? path.slice(0, slash + 1) : '';
}

app.get('/api/legacy-copy/summary', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  try {
    const years = await queryOn(user.schema, `SELECT UPPER(yorzc) AS yorzc FROM arshf ORDER BY yorzc`);
    return c.json({
      ok: true,
      defaultPath: `D:\\${user.schema.toLowerCase()}.Dmp`,
      host: hostname(),
      schema: user.schema,
      archivedYears: years,
    });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.post('/api/legacy-copy/plan', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const permErr = await ensureCopyPermission(user);
  if (permErr) return c.json({ ok: false, error: permErr }, 403);
  const body = await c.req.json().catch(() => ({})) as { path?: string; includeArchived?: boolean };
  const path = String(body.path || `D:\\${user.schema.toLowerCase()}.Dmp`).trim();
  const years = body.includeArchived ? await queryOn<{ YORZC: string }>(
    user.schema,
    `SELECT UPPER(yorzc) AS yorzc FROM arshf ORDER BY yorzc`,
  ) : [];
  const dir = copyDirFromPath(path);
  const commands = [
    `Exp UserId =${user.schema.toLowerCase()}/${user.schema.toLowerCase()} File =${path}`,
    ...years.map((row) => `Exp UserId =${row.YORZC}/${row.YORZC} File =${dir}${row.YORZC}.Dmp`),
  ];
  return c.json({
    ok: true,
    path,
    includeArchived: !!body.includeArchived,
    commands,
    message: 'هذه خطة أوامر النسخ كما في القديم، ولم يتم تشغيل أي أمر من الخادم.',
  });
});

// =============================================
// /api/system-closures — AKFAL.fmx
// =============================================
const AKFAL_SCR = 'AKFAL.FMX';

async function ensureAkfalPermission(user: SessionUser): Promise<string | null> {
  const p = await getPermissions(user, AKFAL_SCR);
  return p.pr > 0 ? null : 'ليس لديك صلاحية اقفالات النظام';
}

app.get('/api/system-closures/summary', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const activeYear = await conn.execute(
      `SELECT MAX(y_year) AS yearz, MAX(akmhzon) AS akmhzon, MAX(stat) AS stat
         FROM year
        WHERE NVL(stat,0)>0`,
      {},
      { outFormat: 4002 },
    );
    const yearz = Number(((activeYear.rows as Record<string, unknown>[] | undefined)?.[0]?.['YEARZ']) ?? new Date().getFullYear());
    const lockedDays = await conn.execute(`SELECT COUNT(*) AS c FROM kday`, {}, { outFormat: 4002 });
    const lockedMonths = await conn.execute(
      `SELECT COUNT(*) AS c, NVL(SUM(nom),0) AS nom_sum FROM month WHERE year=:yearz`,
      { yearz },
      { outFormat: 4002 },
    );
    const checks = await conn.execute(
      `SELECT SUM(NVL(mdin,0))-SUM(NVL(dan,0)) AS trial_diff,
              MAX(NVL(mrhl,0)) AS max_mrhl,
              MAX(NVL(kdant,0)) AS max_kdant
         FROM datak
        WHERE TO_CHAR(datemo,'yyyy') <= TO_CHAR(:yearz)`,
      { yearz },
      { outFormat: 4002 },
    );
    const stock = await conn.execute(`SELECT MAX(datemo) AS max_stock_date FROM dataks`, {}, { outFormat: 4002 });
    const profit = await conn.execute(`SELECT COUNT(*) AS c, MAX(noarh) AS noarh FROM akrandh`, {}, { outFormat: 4002 });
    return c.json({
      ok: true,
      activeYear: (activeYear.rows as unknown[] | undefined)?.[0] ?? {},
      lockedDays: (lockedDays.rows as unknown[] | undefined)?.[0] ?? {},
      lockedMonths: (lockedMonths.rows as unknown[] | undefined)?.[0] ?? {},
      checks: (checks.rows as unknown[] | undefined)?.[0] ?? {},
      stock: (stock.rows as unknown[] | undefined)?.[0] ?? {},
      profit: (profit.rows as unknown[] | undefined)?.[0] ?? {},
    });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.get('/api/system-closures/preflight', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const permErr = await ensureAkfalPermission(user);
  if (permErr) return c.json({ ok: false, error: permErr }, 403);
  const kind = String(c.req.query('kind') || 'day');
  const dateRaw = String(c.req.query('date') || '').trim();
  const month = Number(c.req.query('month') || 0);
  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const active = await conn.execute<{ YEARZ: number }>(
      `SELECT MAX(y_year) AS yearz FROM year WHERE NVL(stat,0)>0`,
      {},
      { outFormat: 4002 },
    );
    const yearz = Number((active.rows as { YEARZ: number }[] | undefined)?.[0]?.YEARZ ?? new Date().getFullYear());
    const checks: Array<{ label: string; pass: boolean; detail: string }> = [];

    if (kind === 'day') {
      const d = dateRaw ? new Date(dateRaw) : new Date();
      const day = await conn.execute<{ C: number }>(
        `SELECT COUNT(*) AS c FROM kday WHERE TRUNC(kdate)=TRUNC(:d)`,
        { d },
        { outFormat: 4002 },
      );
      const mon = await conn.execute<{ C: number }>(
        `SELECT COUNT(*) AS c FROM month
          WHERE nom=TO_NUMBER(TO_CHAR(:d,'MM')) AND year=TO_NUMBER(TO_CHAR(:d,'YYYY'))`,
        { d },
        { outFormat: 4002 },
      );
      const docs = await conn.execute<{ CNT: number; MRHL: number; KDANT: number }>(
        `SELECT COUNT(*) AS cnt, MAX(NVL(mrhl,0)) AS mrhl, MAX(NVL(kdant,0)) AS kdant
           FROM datak
          WHERE TRUNC(datemo)=TRUNC(:d)`,
        { d },
        { outFormat: 4002 },
      );
      const dayLocked = Number((day.rows as { C: number }[] | undefined)?.[0]?.C ?? 0) > 0;
      const monthLocked = Number((mon.rows as { C: number }[] | undefined)?.[0]?.C ?? 0) > 0;
      const docRow = (docs.rows as { CNT: number; MRHL: number; KDANT: number }[] | undefined)?.[0];
      checks.push({ label: 'سنة التاريخ', pass: d.getFullYear() === yearz || d.getFullYear() === new Date().getFullYear(), detail: `${d.getFullYear()} / سنة النظام ${yearz}` });
      checks.push({ label: 'اليوم', pass: true, detail: dayLocked ? 'اليوم مقفل حاليا، القديم يعرض إلغاء الاقفال' : 'اليوم غير مقفل، القديم يعرض الاقفال' });
      checks.push({ label: 'الشهر', pass: !monthLocked, detail: monthLocked ? 'الشهر مقفل؛ القديم يمنع إلغاء اقفال اليوم قبل إلغاء الشهر' : 'الشهر غير مقفل' });
      checks.push({ label: 'مستندات غير مرحلة', pass: Number(docRow?.MRHL ?? 0) === 0, detail: `MRHL=${Number(docRow?.MRHL ?? 0)}` });
      checks.push({ label: 'قيد الانتظار', pass: Number(docRow?.KDANT ?? 0) === 0, detail: `KDANT=${Number(docRow?.KDANT ?? 0)}` });
    } else if (kind === 'month') {
      const mon = Math.min(12, Math.max(1, month || new Date().getMonth() + 1));
      const locked = await conn.execute<{ C: number }>(
        `SELECT COUNT(*) AS c FROM month WHERE nom=:mon AND year=:yearz`,
        { mon, yearz },
        { outFormat: 4002 },
      );
      const docs = await conn.execute<{ MRHL: number; KDANT: number }>(
        `SELECT MAX(NVL(mrhl,0)) AS mrhl, MAX(NVL(kdant,0)) AS kdant
           FROM datak
          WHERE TO_CHAR(datemo,'MM') = LPAD(:mon,2,'0')
            AND TO_CHAR(datemo,'YYYY') = TO_CHAR(:yearz)`,
        { mon, yearz },
        { outFormat: 4002 },
      );
      const prev = mon > 1 ? await conn.execute<{ C: number }>(
        `SELECT COUNT(*) AS c FROM month WHERE nom=:mon AND year=:yearz`,
        { mon: mon - 1, yearz },
        { outFormat: 4002 },
      ) : null;
      const isLocked = Number((locked.rows as { C: number }[] | undefined)?.[0]?.C ?? 0) > 0;
      const docRow = (docs.rows as { MRHL: number; KDANT: number }[] | undefined)?.[0];
      checks.push({ label: 'الشهر', pass: true, detail: isLocked ? 'الشهر مقفل حاليا، القديم يعرض إلغاء الاقفال' : 'الشهر غير مقفل، القديم يعرض الاقفال' });
      checks.push({ label: 'الشهر السابق', pass: mon === 1 || Number((prev?.rows as { C: number }[] | undefined)?.[0]?.C ?? 0) > 0, detail: mon === 1 ? 'يناير لا يحتاج شهر سابق' : 'يجب أن يكون الشهر السابق مقفل' });
      checks.push({ label: 'مستندات غير مرحلة', pass: Number(docRow?.MRHL ?? 0) === 0, detail: `MRHL=${Number(docRow?.MRHL ?? 0)}` });
      checks.push({ label: 'قيد الانتظار', pass: Number(docRow?.KDANT ?? 0) === 0, detail: `KDANT=${Number(docRow?.KDANT ?? 0)}` });
    } else {
      const year = await conn.execute<{ SUMN: number }>(`SELECT NVL(SUM(nom),0) AS sumn FROM month WHERE year=:yearz`, { yearz }, { outFormat: 4002 });
      const bal = await conn.execute<{ DIFF: number; MRHL: number; KDANT: number }>(
        `SELECT SUM(NVL(mdin,0))-SUM(NVL(dan,0)) AS diff,
                MAX(NVL(mrhl,0)) AS mrhl,
                MAX(NVL(kdant,0)) AS kdant
           FROM datak`,
        {},
        { outFormat: 4002 },
      );
      const activeYear = await conn.execute<{ AKMHZON: number; STAT: number }>(
        `SELECT MAX(NVL(akmhzon,0)) AS akmhzon, MAX(NVL(stat,0)) AS stat
           FROM year WHERE y_year=:yearz`,
        { yearz },
        { outFormat: 4002 },
      );
      const b = (bal.rows as { DIFF: number; MRHL: number; KDANT: number }[] | undefined)?.[0];
      const y = (year.rows as { SUMN: number }[] | undefined)?.[0];
      const a = (activeYear.rows as { AKMHZON: number; STAT: number }[] | undefined)?.[0];
      checks.push({ label: 'ميزان المراجعة', pass: Math.abs(Number(b?.DIFF ?? 0)) <= 1, detail: `الفارق ${Number(b?.DIFF ?? 0).toLocaleString()}` });
      checks.push({ label: 'مستندات غير مرحلة', pass: Number(b?.MRHL ?? 0) === 0, detail: `MRHL=${Number(b?.MRHL ?? 0)}` });
      checks.push({ label: 'قيد الانتظار', pass: Number(b?.KDANT ?? 0) === 0, detail: `KDANT=${Number(b?.KDANT ?? 0)}` });
      checks.push({ label: 'أشهر السنة', pass: Number(y?.SUMN ?? 0) === 78, detail: `مجموع الأشهر ${Number(y?.SUMN ?? 0)} من 78` });
      checks.push({ label: 'المخزون', pass: Number(a?.AKMHZON ?? 0) > 0, detail: Number(a?.AKMHZON ?? 0) > 0 ? 'المخزون مقفل' : 'يجب اقفال المخزون أولا' });
      checks.push({ label: 'حالة السنة', pass: Number(a?.STAT ?? 0) === 1, detail: `STAT=${Number(a?.STAT ?? 0)}` });
    }
    return c.json({ ok: true, kind, yearz, checks });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

// =============================================
// /api/support-tools — TEL.fmx
// =============================================
const SUPPORT_CONTACTS = [
  { name: 'المحاسب / عمار امين ناشر', city: 'صعدة', work: 'استشارات - تدريب - تنزيل النظام', phone: '775535121 - 715385453' },
  { name: 'المحاسب / عزالدين المقرمي', city: '', work: 'تنزيل النظام - صيانة شبكات', phone: '774421413 - 736232057' },
  { name: 'المهندس/ سليم الابي', city: 'صنعاء', work: 'استشارات - تدريب - تنزيل النظام', phone: '777373186' },
  { name: 'المحاسب / امين الغرافي', city: 'صنعاء', work: 'استشارات - تدريب - تنزيل النظام', phone: '777324294' },
  { name: 'المحاسب / امين الصلوي', city: 'الحديدة', work: 'تطوير - صيانة - استشارات', phone: '773964375 - 733633244' },
  { name: 'المهندس / ابراهيم ثابت عوض', city: 'الحديدة', work: 'تطوير - صيانة - استشارات', phone: '777153270 - 734570264' },
  { name: 'المهندس / وائل حمود محمد سيف مغلس', city: 'المخاء', work: 'صيانة - تنزيل النظام', phone: '772551540' },
  { name: 'المهندس / طه عبدالفتاح', city: 'الحديدة', work: 'تدريب - استشارات - تنزيل النظام', phone: '774453741' },
];

app.get('/api/support-tools/summary', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const pool = await getPool(user.schema);
  const conn = await pool.getConnection();
  try {
    const titl = await conn.execute(
      `SELECT MAX(nocopy) AS nocopy,
              MAX(nocopyx) AS nocopyx,
              MAX(nocopy2) AS nocopy2,
              MAX(msall) AS msall,
              MAX(t_sms) AS t_sms
         FROM titl`,
      {},
      { outFormat: 4002 },
    ).catch(() => ({ rows: [] }));
    const sessionsNow = await conn.execute(
      `SELECT COUNT(*) AS c FROM v$session WHERE UPPER(username)=UPPER(:schema)`,
      { schema: user.schema },
      { outFormat: 4002 },
    ).catch(() => ({ rows: [] }));
    return c.json({
      ok: true,
      host: hostname(),
      schema: user.schema,
      contacts: SUPPORT_CONTACTS,
      titl: (titl.rows as unknown[] | undefined)?.[0] ?? {},
      sessions: (sessionsNow.rows as unknown[] | undefined)?.[0] ?? {},
      actions: [
        { id: 'database-update', label: 'تحديث قاعدة البيانات', risk: 'DDL/DML واسع من شاشة TEL القديمة' },
        { id: 'disconnect-users', label: 'خروج جميع المستخدمين', risk: 'يؤثر على جلسات المستخدمين' },
        { id: 'export-tables', label: 'تصدير الجداول جدول جدول', risk: 'يشغل أوامر Exp خارجية' },
      ],
    });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.post('/api/support-tools/action-plan', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const body = await c.req.json().catch(() => ({})) as { action?: string };
  const action = String(body.action || '').trim();
  return c.json({
    ok: true,
    action,
    executable: false,
    message: 'تم تجهيز الشاشة كالمصدر القديم، لكن تنفيذ تحديثات TEL الحساسة يحتاج اعتماد تشغيل منفصل حتى لا تتغير قاعدة البيانات بالخطأ.',
  });
});


app.put('/api/data/:table', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  const body = await c.req.json() as { sql: string; binds: Record<string, unknown> };
  if (!body.sql || !body.sql.trim().toUpperCase().startsWith('UPDATE')) return c.json({ ok: false, error: 'invalid sql' }, 400);
  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    await conn.execute(body.sql, body.binds as never);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true });
  } catch (e) { await conn.execute('ROLLBACK', {} as never); return c.json({ ok: false, error: (e as Error).message }, 500); }
  finally { await conn.close(); }
});

app.delete('/api/data/:table', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  const table = c.req.param('table').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const where = c.req.query('where') || '';
  if (!where) return c.json({ ok: false, error: 'where required' }, 400);
  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    await conn.execute('DELETE FROM ' + table + ' WHERE ' + where, {} as never);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true });
  } catch (e) { await conn.execute('ROLLBACK', {} as never); return c.json({ ok: false, error: (e as Error).message }, 500); }
  finally { await conn.close(); }
});

// =============================================
// /api/currencies — Currency master-data CRUD (AMLH table)
//
// Mirrors Oracle Forms screen DATA_AML.fmx (block DATA_MO → table AMLH).
// Fields: NO (PK), NAMEM, NAMEM2, NAMEM3, NAMEH, NACHAR, FLS,
//         SARS (current rate), SARS1 (highest rate), SARS2 (lowest rate).
//
// Business rules (from FMB triggers):
//   - New NO is max(no)+1 in the UI, must be unique and > 0.
//   - NAMEM2 is the required currency name; NAMEH defaults to NAMEM2.
//   - NAMEM3 is generated as the legacy "بال..." display text.
//   - SARS1/SARS2 are normalized by the same DATA_AML item triggers.
//   - NO=1 is the local currency — editable but rate is always 1.
//   - NO in (1,2,3) cannot be deleted in the legacy screen.
//   - Cannot delete a currency referenced by any voucher/account.
// =============================================
app.get('/api/currencies', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const q = c.req.query('q') ?? '';
  try {
    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT no, namem, namem2, namem3, nameh, nachar, fls,
              NVL(sars,1) AS sars, NVL(sars1,0) AS sars1, NVL(sars2,0) AS sars2
         FROM amlh
        WHERE :q IS NULL
           OR UPPER(NVL(namem,''))  LIKE :q OR UPPER(NVL(namem2,'')) LIKE :q
           OR UPPER(NVL(nameh,''))  LIKE :q OR TO_CHAR(no) LIKE :q
        ORDER BY no`,
      { q: q ? `%${q.toUpperCase()}%` : null },
    );
    return c.json({ ok: true, rows });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.get('/api/currencies/:no', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const no = Number(c.req.param('no'));
  if (!no) return c.json({ ok: false, error: 'no required' }, 400);
  try {
    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT no, namem, namem2, namem3, nameh, nachar, fls,
              NVL(sars,1) AS sars, NVL(sars1,0) AS sars1, NVL(sars2,0) AS sars2
         FROM amlh WHERE no = :n`,
      { n: no },
    );
    if (!rows.length) return c.json({ ok: false, error: 'not_found' }, 404);
    return c.json({ ok: true, record: rows[0] });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

type NormalizedCurrencyPayload = {
  no: number;
  namem: string;
  namem2: string;
  namem3: string;
  nameh: string;
  nachar: string;
  fls: string;
  sars: number;
  sars1: number;
  sars2: number;
};

function currencyText(p: Record<string, unknown>, upper: string, lower = upper.toLowerCase()): string {
  return String(p[upper] ?? p[lower] ?? '').trim();
}

function legacyCurrencyName3(namem2: string): string {
  const value = namem2.trim();
  if (!value) return '';
  const firstSpace = value.search(/\s/);
  if (firstSpace > 0) {
    const first = value.slice(0, firstSpace);
    const rest = value.slice(firstSpace).trimStart();
    return `بال${first} ال${rest}`.slice(0, 40);
  }
  return `بال${value}`.slice(0, 40);
}

function normalizeLegacyCurrencyPayload(p: Record<string, unknown>): NormalizedCurrencyPayload {
  const no = Number(p['NO'] ?? p['no'] ?? 0);
  const namem2 = currencyText(p, 'NAMEM2').slice(0, 40);
  const namem = (currencyText(p, 'NAMEM') || namem2).slice(0, 20);
  const nameh = (currencyText(p, 'NAMEH') || namem2).slice(0, 40);
  const nachar = currencyText(p, 'NACHAR').slice(0, 10);
  const fls = currencyText(p, 'FLS').slice(0, 20);

  let sars = Number(p['SARS'] ?? p['sars'] ?? 1);
  let sars1 = Number(p['SARS1'] ?? p['sars1'] ?? 0);
  let sars2 = Number(p['SARS2'] ?? p['sars2'] ?? 0);
  if (!Number.isFinite(sars)) sars = 0;
  if (!Number.isFinite(sars1)) sars1 = 0;
  if (!Number.isFinite(sars2)) sars2 = 0;

  if (no === 1) {
    sars = 1;
    sars1 = 1;
    sars2 = 1;
  } else {
    if (sars1 === 0) sars1 = sars;
    if (sars2 === 0) sars2 = sars;
    if (sars > sars1) sars1 = sars;
    if (sars < sars2) sars2 = sars;
    if (sars1 < sars) sars1 = sars;
    if (sars1 < sars2) sars2 = sars;
    if (sars2 > sars) sars2 = sars;
    if (sars2 > sars1 || sars2 === 0) sars2 = sars1;
  }

  return {
    no,
    namem,
    namem2,
    namem3: legacyCurrencyName3(namem2),
    nameh,
    nachar,
    fls,
    sars,
    sars1,
    sars2,
  };
}

/** Validates currency-rate invariants shared by POST and PUT handlers. */
function validateCurrencyPayload(p: NormalizedCurrencyPayload): string | null {
  if (!p.no || p.no <= 0) return 'رقم العملة مطلوب ويجب أن يكون موجباً';
  if (!p.namem2) return 'اسم العملة مطلوب';
  if (p.sars <= 0) return 'سعر الصرف يجب أن يكون موجباً';
  if (p.sars1 > 0 && p.sars > p.sars1) return `سعر الصرف (${p.sars}) أكبر من أعلى سعر (${p.sars1})`;
  if (p.sars2 > 0 && p.sars < p.sars2) return `سعر الصرف (${p.sars}) أقل من أدنى سعر (${p.sars2})`;
  if (p.sars1 > 0 && p.sars2 > 0 && p.sars2 > p.sars1)
    return 'أدنى سعر لا يمكن أن يكون أكبر من أعلى سعر';
  return null;
}

async function currencyNameDuplicateError(
  conn: { execute<T = unknown>(
    sql: string,
    binds?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ rows?: T[] | unknown[] }> },
  no: number,
  namem: string,
  namem2: string,
): Promise<string | null> {
  const checks = [
    { col: 'namem2', value: namem2 },
    { col: 'namem', value: namem },
  ].filter(x => x.value);

  for (const check of checks) {
    const dup = await conn.execute<{CNT:number}>(
      `SELECT COUNT(*) AS cnt
         FROM amlh
        WHERE no <> :n
          AND TRIM(NVL(${check.col},'')) = :v`,
      { n: no, v: check.value },
      { outFormat: 4002 },
    );
    if ((dup.rows as unknown as {CNT:number}[])[0]!.CNT > 0) {
      return 'اسم العملة المدخل مقيد من قبل';
    }
  }
  return null;
}

app.post('/api/currencies', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const body = await c.req.json<Record<string, unknown>>();
  const payload = normalizeLegacyCurrencyPayload(body);
  const err = validateCurrencyPayload(payload);
  if (err) return c.json({ ok: false, error: err }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    const no = payload.no;
    // Uniqueness check
    const dup = await conn.execute<{CNT:number}>(
      `SELECT COUNT(*) AS cnt FROM amlh WHERE no = :n`,
      { n: no }, { outFormat: 4002 /* OUT_FORMAT_OBJECT */ },
    );
    if (dup.rows && (dup.rows as unknown as {CNT:number}[])[0]!.CNT > 0)
      return c.json({ ok: false, error: `العملة رقم ${no} موجودة مسبقاً` }, 400);
    const nameDup = await currencyNameDuplicateError(conn, no, payload.namem, payload.namem2);
    if (nameDup) return c.json({ ok: false, error: nameDup }, 400);

    await conn.execute(
      `INSERT INTO amlh (no, namem, namem2, namem3, nameh, nachar, fls, sars, sars1, sars2)
       VALUES (:no, :namem, :namem2, :namem3, :nameh, :nachar, :fls, :sars, :sars1, :sars2)`,
      {
        no,
        namem:  payload.namem || null,
        namem2: payload.namem2 || null,
        namem3: payload.namem3 || null,
        nameh:  payload.nameh || null,
        nachar: payload.nachar || null,
        fls:    payload.fls || null,
        sars:   payload.sars,
        sars1:  payload.sars1,
        sars2:  payload.sars2,
      } as never,
    );
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, no, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.put('/api/currencies/:no', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const no = Number(c.req.param('no'));
  if (!no) return c.json({ ok: false, error: 'no required' }, 400);
  const body = await c.req.json<Record<string, unknown>>();
  (body as Record<string, unknown>)['NO'] = no;   // ensure PK match
  const payload = normalizeLegacyCurrencyPayload(body);
  const err = validateCurrencyPayload(payload);
  if (err) return c.json({ ok: false, error: err }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    const nameDup = await currencyNameDuplicateError(conn, no, payload.namem, payload.namem2);
    if (nameDup) return c.json({ ok: false, error: nameDup }, 400);

    const r = await conn.execute(
      `UPDATE amlh SET
          namem  = :namem,  namem2 = :namem2, namem3 = :namem3,
          nameh  = :nameh,  nachar = :nachar, fls    = :fls,
          sars   = :sars,   sars1  = :sars1,  sars2  = :sars2
        WHERE no = :no`,
      {
        no,
        namem:  payload.namem || null,
        namem2: payload.namem2 || null,
        namem3: payload.namem3 || null,
        nameh:  payload.nameh || null,
        nachar: payload.nachar || null,
        fls:    payload.fls || null,
        sars:   payload.sars,
        sars1:  payload.sars1,
        sars2:  payload.sars2,
      } as never,
    );
    if (!r.rowsAffected) return c.json({ ok: false, error: `العملة رقم ${no} غير موجودة` }, 404);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.delete('/api/currencies/:no', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const no = Number(c.req.param('no'));
  if (!no) return c.json({ ok: false, error: 'no required' }, 400);
  if (no <= 3) return c.json({ ok: false, error: 'لا يمكن حذف العملات الأساسية 1 و2 و3 كما في النظام القديم' }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    // Referential integrity: check if currency is referenced anywhere
    const refs = await conn.execute<{CNT:number}>(
      `SELECT
         (SELECT COUNT(*) FROM data_ac WHERE amlhh = :n) +
         (SELECT COUNT(*) FROM datak   WHERE noaml = :n) AS cnt
         FROM dual`,
      { n: no }, { outFormat: 4002 },
    );
    const cnt = (refs.rows as unknown as {CNT:number}[])[0]!.CNT;
    if (cnt > 0) return c.json({
      ok: false, error: `لا يمكن حذف العملة — مستخدمة في ${cnt} سجل`,
    }, 400);

    const r = await conn.execute(`DELETE FROM amlh WHERE no = :n`, { n: no } as never);
    if (!r.rowsAffected) return c.json({ ok: false, error: 'not_found' }, 404);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.DELETED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

// =============================================
// /api/customers — Customer master-data CRUD
//
// Mirrors Oracle Forms screen DATA_AM.fmx — block DATA_A → table DATA_AC
// filtered by RTBA=5 (customer sub-ledger). DATA_MO also uses RTBA=5 in
// the legacy source; suppliers are separated by TYPEA=221x.
//
// Key fields (from the .fmb):
//   NOA   : account number (PK, assembled as TYPEA || NOAN)
//   NAMEA : customer name
//   TYPEA : parent account class from TREE (LOV → data_ac where noan=0)
//   NOAN  : sequential index within the class
//   NOYSOFT : external reference number (unique per TYPEA+RTBA)
//   MRT   : cost-centre id (FK → MRT.NOS)
//   TEL   : 9-digit Yemeni mobile (must start 77/71/73/70/78)
//   TWKFX : agent flag (3 = agent with separate ledger)
//   SARH  : price list id
//   NOG   : accounting group (default 1 via PRE-INSERT trigger)
// =============================================

const CUSTOMER_RTBA = 5;
// DATA_MO in the legacy form also uses RTBA=5; suppliers are separated by TYPEA=221x.
const SUPPLIER_RTBA = 5;

/** Field list re-used by list and detail queries. */
const PARTY_FIELDS = `noa, namea, typea, rtba, noan, noysoft, mrt, mntka, tel, tel2,
                      twkfx, sarh, nog, nokyed, adrs, nbin, namedmin, cname,
                      tin, ted, memoh, di, de, pci, pce, nousx, nousxu,
                      ahsar, NVL(hall,0) AS hall, NVL(ned,0) AS ned`;

/** Validates input common to both customer and supplier party payloads. */
function validatePartyPayload(p: Record<string, unknown>): string | null {
  const namea = String(p['NAMEA'] ?? p['namea'] ?? '').trim();
  if (!namea) return 'اسم الحساب (NAMEA) مطلوب';
  const typea = Number(p['TYPEA'] ?? p['typea'] ?? 0);
  if (!typea) return 'نوع الحساب (TYPEA) مطلوب — اختر من دليل الحسابات';
  const tel = String(p['TEL'] ?? p['tel'] ?? '').trim();
  if (tel) {
    if (tel.length !== 9) return 'رقم الهاتف يجب أن يكون 9 أرقام';
    if (!/^(77|71|73|70|78)/.test(tel))
      return 'رقم الهاتف يجب أن يبدأ بـ 77 أو 71 أو 73 أو 70 أو 78';
  }
  return null;
}

/** Generates the next NOA within a TYPEA parent (max(noan)+1 concatenated). */
async function nextPartyNoa(
  schema: string, typea: number, rtba: number,
): Promise<{noa: number; noan: number}> {
  const rows = await queryOn<{NEXT_NOAN:number}>(
    schema,
    `SELECT NVL(MAX(noan),0) + 1 AS next_noan
       FROM data_ac
      WHERE typea = :t AND rtba = :r`,
    { t: typea, r: rtba },
  );
  const noan = rows[0]?.NEXT_NOAN ?? 1;
  // NOA = TYPEA * 10^N + NOAN where N is the padding width (4 by default
  // so that max 9999 sub-accounts per class fit). The legacy form uses
  // a zero-padded suffix, reconstructed here as a plain number.
  const noa = Number(String(typea) + String(noan).padStart(4, '0'));
  return { noa, noan };
}

/** Builds the list handler — shared between /customers and /suppliers. */
function buildPartyListHandler(rtba: number) {
  return async (c: Context) => {
    const user = readUser(c);
    if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
    const q = String(c.req.query('q') ?? '').trim();
    const contains = c.req.query('contains') === '1';
    const qLike = q ? `${contains ? '%' : ''}${q.toUpperCase()}%` : null;
    const typea = Number(c.req.query('typea') ?? 0);
    const limit = Math.min(Number(c.req.query('limit') ?? 200), 500);
    try {
      const rows = await queryOn(
        user.schema,
         `SELECT * FROM (
            SELECT noa, namea, typea, noan, noysoft, tel, adrs, mrt
              FROM data_ac
             WHERE rtba = :r
               AND (:typea = 0 OR typea = :typea)
               AND (:qLike IS NULL
                OR UPPER(NVL(namea,'')) LIKE :qLike
                OR TO_CHAR(noa) LIKE :qLike
                OR TO_CHAR(noysoft) LIKE :qLike
                OR TO_CHAR(tel) LIKE :qLike)
             ORDER BY namea
          ) WHERE ROWNUM <= :lim`,
        { r: rtba, typea, qLike, lim: limit },
      );
      return c.json({ ok: true, rows });
    } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
  };
}

/** Builds the detail GET handler. */
function buildPartyGetHandler(rtba: number) {
  return async (c: Context) => {
    const user = readUser(c);
    if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
    const noa = Number(c.req.param('noa'));
    if (!noa) return c.json({ ok: false, error: 'noa required' }, 400);
    try {
      // Left-join user_u twice to resolve the audit user names — the
      // legacy form displayed "مدخل الحساب" / "معدل الحساب" by looking
      // up NOUSX/NOUSXU in USER_U; doing it here avoids a second roundtrip.
      const rows = await queryOn<Record<string, unknown>>(
        user.schema,
        `SELECT d.*,
                ui.nameu AS NAMEU_IN,
                ue.nameu AS NAMEU_ED
           FROM (SELECT ${PARTY_FIELDS} FROM data_ac
                  WHERE noa = :n AND rtba = :r) d
           LEFT JOIN user_u ui ON ui.nou = d.nousx
           LEFT JOIN user_u ue ON ue.nou = d.nousxu`,
        { n: noa, r: rtba },
      );
      if (!rows.length) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json({ ok: true, record: rows[0] });
    } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
  };
}

/** Builds the POST (create) handler. */
function buildPartyCreateHandler(rtba: number) {
  return async (c: Context) => {
    const user = readUser(c);
    if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
    const body = await c.req.json<Record<string, unknown>>();
    const errMsg = validatePartyPayload(body);
    if (errMsg) return c.json({ ok: false, error: errMsg }, 400);

    const pool = await getPool(user.schema); const conn = await pool.getConnection();
    try {
      const typea = Number(body['TYPEA']);
      // Validate that TYPEA exists and is a structural parent (RTBA < 5).
      // The legacy form uses an LOV restricted to parent nodes in the tree;
      // customer/supplier records (RTBA=5/6) are children one level below.
      const parent = await conn.execute<{NAMEA:string; RTBA:number}>(
        `SELECT namea, NVL(rtba,0) AS rtba FROM data_ac WHERE noa = :t`,
        { t: typea }, { outFormat: 4002 },
      );
      const pRows = parent.rows as unknown as Array<{NAMEA:string;RTBA:number}>;
      if (!pRows || !pRows.length)
        return c.json({ ok: false, error: `نوع الحساب ${typea} غير موجود في الدليل` }, 400);
      if (pRows[0]!.RTBA >= 5)
        return c.json({
          ok: false,
          error: `الحساب ${typea} (${pRows[0]!.NAMEA}) ليس فئة — اختر فئة من دليل الحسابات`,
        }, 400);

      // Uniqueness of NOYSOFT within TYPEA+RTBA (legacy POST-TEXT-ITEM on NOYSOFT)
      const noysoft = Number(body['NOYSOFT'] ?? 0);
      if (noysoft > 0) {
        const dup = await conn.execute<{CNT:number}>(
          `SELECT COUNT(*) AS cnt FROM data_ac
            WHERE typea = :t AND rtba = :r AND NVL(noysoft,0) = :s`,
          { t: typea, r: rtba, s: noysoft }, { outFormat: 4002 },
        );
        if ((dup.rows as unknown as {CNT:number}[])[0]!.CNT > 0)
          return c.json({ ok: false, error: `الرقم المرجعي ${noysoft} مستخدم لحساب آخر` }, 400);
      }

      // Cost-centre FK check (legacy POST-TEXT-ITEM on MRT2)
      const mrt = Number(body['MRT'] ?? 0);
      if (mrt > 0) {
        const m = await conn.execute<{CNT:number}>(
          `SELECT COUNT(*) AS cnt FROM mrt WHERE nos = :m`,
          { m: mrt }, { outFormat: 4002 },
        );
        if ((m.rows as unknown as {CNT:number}[])[0]!.CNT === 0)
          return c.json({ ok: false, error: `مركز التكلفة ${mrt} غير موجود` }, 400);
      }

      const { noa, noan } = await nextPartyNoa(user.schema, typea, rtba);
      await conn.execute(
        `INSERT INTO data_ac
           (noa, namea, typea, rtba, noan, noysoft, mrt, mntka, tel, tel2,
            twkfx, sarh, nog, nokyed, hall, adrs, nbin, namedmin, cname,
            tin, ted, memoh, di, pci, nousx)
         VALUES
           (:noa, :namea, :typea, :rtba, :noan, :noysoft, :mrt, :mntka, :tel, :tel2,
            :twkfx, :sarh, NVL(:nog,1), :nokyed, :hall, :adrs, :nbin, :namedmin, :cname,
            :tin, :ted, :memoh, SYSDATE, :pci, :nousx)`,
        {
          noa, typea, rtba, noan,
          namea: String(body['NAMEA'] ?? '').slice(0, 60),
          noysoft: noysoft || null,
          mrt: mrt || null,
          mntka: Number(body['MNTKA'] ?? 0) || null,
          tel:  String(body['TEL']  ?? '') || null,
          tel2: String(body['TEL2'] ?? '') || null,
          twkfx: Number(body['TWKFX'] ?? 0) || null,
          sarh:  Number(body['SARH']  ?? 0) || null,
          nog:   Number(body['NOG']   ?? 1) || 1,
          nokyed: Number(body['NOKYED'] ?? 0),
          hall: Number(body['HALL'] ?? 0),
          adrs: String(body['ADRS'] ?? '') || null,
          nbin: String(body['NBIN'] ?? '') || null,
          namedmin: String(body['NAMEDMIN'] ?? '') || null,
          cname: String(body['CNAME'] ?? '') || null,
          tin: String(body['TIN'] ?? '') || null,
          ted: String(body['TED'] ?? '') || null,
          memoh: String(body['MEMOH'] ?? '') || null,
          pci: sharedClientTag(user),
          nousx: user.nou,
        } as never,
      );
      await conn.execute('COMMIT', {} as never);
      return c.json({ ok: true, noa, noan, message: M.SAVED_SUCCESS });
    } catch (e) {
      try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
      return c.json({ ok: false, error: (e as Error).message }, 500);
    } finally { await conn.close(); }
  };
}

/** Builds the PUT (update) handler. */
function buildPartyUpdateHandler(rtba: number) {
  return async (c: Context) => {
    const user = readUser(c);
    if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
    const noa = Number(c.req.param('noa'));
    if (!noa) return c.json({ ok: false, error: 'noa required' }, 400);
    const body = await c.req.json<Record<string, unknown>>();
    const errMsg = validatePartyPayload(body);
    if (errMsg) return c.json({ ok: false, error: errMsg }, 400);

    const pool = await getPool(user.schema); const conn = await pool.getConnection();
    try {
      // Verify record exists with expected rtba
      const exists = await conn.execute<{TYPEA:number}>(
        `SELECT typea FROM data_ac WHERE noa = :n AND rtba = :r`,
        { n: noa, r: rtba }, { outFormat: 4002 },
      );
      if (!(exists.rows as unknown as {TYPEA:number}[]).length)
        return c.json({ ok: false, error: 'الحساب غير موجود' }, 404);
      const typea = (exists.rows as unknown as {TYPEA:number}[])[0]!.TYPEA;

      // NOYSOFT uniqueness (excluding self)
      const noysoft = Number(body['NOYSOFT'] ?? 0);
      if (noysoft > 0) {
        const dup = await conn.execute<{CNT:number}>(
          `SELECT COUNT(*) AS cnt FROM data_ac
            WHERE typea = :t AND rtba = :r AND NVL(noysoft,0) = :s AND noa <> :n`,
          { t: typea, r: rtba, s: noysoft, n: noa }, { outFormat: 4002 },
        );
        if ((dup.rows as unknown as {CNT:number}[])[0]!.CNT > 0)
          return c.json({ ok: false, error: `الرقم المرجعي ${noysoft} مستخدم لحساب آخر` }, 400);
      }

      // Cost-centre FK check
      const mrt = Number(body['MRT'] ?? 0);
      if (mrt > 0) {
        const m = await conn.execute<{CNT:number}>(
          `SELECT COUNT(*) AS cnt FROM mrt WHERE nos = :m`,
          { m: mrt }, { outFormat: 4002 },
        );
        if ((m.rows as unknown as {CNT:number}[])[0]!.CNT === 0)
          return c.json({ ok: false, error: `مركز التكلفة ${mrt} غير موجود` }, 400);
      }

      await conn.execute(
        `UPDATE data_ac SET
            namea = :namea,   noysoft = :noysoft, mrt = :mrt, mntka = :mntka,
            tel = :tel,       tel2 = :tel2,       twkfx = :twkfx,
            sarh = :sarh,     nog = :nog,         nokyed = :nokyed,
            hall = :hall,     adrs = :adrs,       nbin = :nbin,
            namedmin = :namedmin,
            cname = :cname,   tin = :tin,         ted = :ted,
            memoh = :memoh,   de = SYSDATE,       pce = :pce, nousxu = :nousxu
          WHERE noa = :noa AND rtba = :rtba`,
        {
          noa, rtba,
          namea: String(body['NAMEA'] ?? '').slice(0, 60),
          noysoft: noysoft || null,
          mrt: mrt || null,
          mntka: Number(body['MNTKA'] ?? 0) || null,
          tel:  String(body['TEL']  ?? '') || null,
          tel2: String(body['TEL2'] ?? '') || null,
          twkfx: Number(body['TWKFX'] ?? 0) || null,
          sarh:  Number(body['SARH']  ?? 0) || null,
          nog:   Number(body['NOG']   ?? 1) || 1,
          nokyed: Number(body['NOKYED'] ?? 0),
          hall: Number(body['HALL'] ?? 0),
          adrs: String(body['ADRS'] ?? '') || null,
          nbin: String(body['NBIN'] ?? '') || null,
          namedmin: String(body['NAMEDMIN'] ?? '') || null,
          cname: String(body['CNAME'] ?? '') || null,
          tin: String(body['TIN'] ?? '') || null,
          ted: String(body['TED'] ?? '') || null,
          memoh: String(body['MEMOH'] ?? '') || null,
          pce: sharedClientTag(user),
          nousxu: user.nou,
        } as never,
      );
      await conn.execute('COMMIT', {} as never);
      return c.json({ ok: true, message: M.SAVED_SUCCESS });
    } catch (e) {
      try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
      return c.json({ ok: false, error: (e as Error).message }, 500);
    } finally { await conn.close(); }
  };
}

/** Builds the DELETE handler. */
function buildPartyDeleteHandler(rtba: number) {
  return async (c: Context) => {
    const user = readUser(c);
    if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
    const noa = Number(c.req.param('noa'));
    if (!noa) return c.json({ ok: false, error: 'noa required' }, 400);

    const pool = await getPool(user.schema); const conn = await pool.getConnection();
    try {
      // Referential integrity: cannot delete if referenced by any voucher
      // or journal detail (legacy ON-CHECK-DELETE-MASTER + SNF relation).
      const refs = await conn.execute<{CNT:number}>(
        `SELECT
           (SELECT COUNT(*) FROM sndkf  WHERE noa = :n) +
           (SELECT COUNT(*) FROM sndsf  WHERE noa = :n) +
           (SELECT COUNT(*) FROM sndkdf WHERE noa = :n) +
           (SELECT COUNT(*) FROM datak  WHERE noa = :n) AS cnt
         FROM dual`,
        { n: noa }, { outFormat: 4002 },
      );
      const cnt = (refs.rows as unknown as {CNT:number}[])[0]!.CNT;
      if (cnt > 0) return c.json({
        ok: false, error: `لا يمكن حذف الحساب — مستخدم في ${cnt} حركة`,
      }, 400);

      const r = await conn.execute(
        `DELETE FROM data_ac WHERE noa = :n AND rtba = :r`,
        { n: noa, r: rtba } as never,
      );
      if (!r.rowsAffected) return c.json({ ok: false, error: 'not_found' }, 404);
      await conn.execute('COMMIT', {} as never);
      return c.json({ ok: true, message: M.DELETED_SUCCESS });
    } catch (e) {
      try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
      return c.json({ ok: false, error: (e as Error).message }, 500);
    } finally { await conn.close(); }
  };
}

// =============================================
// /api/cost-centres — MRT.fmx (cost-centre master data)
//
// Mirrors Oracle Forms MRT.fmx:
//   DATA_MO.NO     -> MRT.NOS
//   DATA_MO.NAMEM2 -> MRT.NAMEM
//   DATA_MO.DF     -> one default warehouse cost centre, never two.
// Shared as a LOV for many screens (DATA_AM, invoices, journal details).
// =============================================
app.get('/api/cost-centres', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const q = c.req.query('q') ?? '';
  try {
    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT nos, namem, NVL(df,0) AS df
         FROM mrt
        WHERE :q IS NULL OR UPPER(NVL(namem,'')) LIKE :q OR TO_CHAR(nos) LIKE :q
        ORDER BY nos`,
      { q: q ? `%${q.toUpperCase()}%` : null },
    );
    return c.json({ ok: true, rows });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.get('/api/cost-centres/:nos', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const nos = Number(c.req.param('nos'));
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);
  try {
    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT nos, namem, NVL(df,0) AS df FROM mrt WHERE nos = :n`,
      { n: nos },
    );
    if (!rows.length) return c.json({ ok: false, error: 'not_found' }, 404);
    return c.json({ ok: true, record: rows[0] });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

type NormalizedMrtPayload = {
  nos: number;
  namem: string;
  df: number;
};

type DbExecuteConnection = {
  execute<T = unknown>(
    sql: string,
    binds?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ rows?: T[] | unknown[]; rowsAffected?: number }>;
};

function normalizeMrtPayload(p: Record<string, unknown>): NormalizedMrtPayload {
  return {
    nos: Number(p['NOS'] ?? p['nos'] ?? 0),
    namem: String(p['NAMEM'] ?? p['namem'] ?? '').trim().slice(0, 50),
    df: Number(p['DF'] ?? p['df'] ?? 0) > 0 ? 1 : 0,
  };
}

/** Validates cost-centre payload — required NOS > 0 and non-empty legacy NAMEM2/NAMEM. */
function validateMrtPayload(p: NormalizedMrtPayload): string | null {
  if (!p.nos || p.nos <= 0) return 'رقم المركز مطلوب ويجب أن يكون موجباً';
  if (!p.namem) return 'يجب ادخال اسم المركز';
  return null;
}

async function mrtDuplicateNameError(
  conn: DbExecuteConnection,
  nos: number,
  namem: string,
): Promise<string | null> {
  const dup = await conn.execute<{CNT:number}>(
    `SELECT COUNT(*) AS cnt
       FROM mrt
      WHERE nos <> :n
        AND TRIM(NVL(namem,'')) = :v`,
    { n: nos, v: namem },
    { outFormat: 4002 },
  );
  if ((dup.rows as unknown as {CNT:number}[])[0]!.CNT > 0) {
    return 'اسم المركز  المدخل مقيد من قبل';
  }
  return null;
}

async function mrtDefaultConflictError(
  conn: DbExecuteConnection,
  nos: number,
): Promise<string | null> {
  const conflict = await conn.execute<{NOS:number | null}>(
    `SELECT MAX(nos) AS nos
       FROM mrt
      WHERE nos <> NVL(:n,0)
        AND NVL(df,0) > 0`,
    { n: nos },
    { outFormat: 4002 },
  );
  const row = (conflict.rows as unknown as {NOS:number | null}[])[0];
  const existing = Number(row?.NOS ?? 0);
  return existing > 0 ? `تم تحديد المركز رقم ${existing} لا يمكن تحديد مركزين` : null;
}

app.post('/api/cost-centres', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const body = await c.req.json<Record<string, unknown>>();
  const payload = normalizeMrtPayload(body);
  const err = validateMrtPayload(payload);
  if (err) return c.json({ ok: false, error: err }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    const nos = payload.nos;
    const dup = await conn.execute<{CNT:number}>(
      `SELECT COUNT(*) AS cnt FROM mrt WHERE nos = :n`,
      { n: nos }, { outFormat: 4002 },
    );
    if ((dup.rows as unknown as {CNT:number}[])[0]!.CNT > 0)
      return c.json({ ok: false, error: `المركز رقم ${nos} موجود مسبقاً` }, 400);
    const nameDup = await mrtDuplicateNameError(conn, nos, payload.namem);
    if (nameDup) return c.json({ ok: false, error: nameDup }, 400);

    const dfConflict = payload.df === 1 ? await mrtDefaultConflictError(conn, nos) : null;
    if (dfConflict) return c.json({ ok: false, error: dfConflict }, 400);

    await conn.execute(
      `INSERT INTO mrt (nos, namem, df) VALUES (:nos, :namem, :df)`,
      {
        nos,
        namem: payload.namem,
        df: payload.df,
      } as never,
    );
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, nos, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.put('/api/cost-centres/:nos', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const nos = Number(c.req.param('nos'));
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);
  const body = await c.req.json<Record<string, unknown>>();
  body['NOS'] = nos;
  const payload = normalizeMrtPayload(body);
  const err = validateMrtPayload(payload);
  if (err) return c.json({ ok: false, error: err }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    const nameDup = await mrtDuplicateNameError(conn, nos, payload.namem);
    if (nameDup) return c.json({ ok: false, error: nameDup }, 400);
    const dfConflict = payload.df === 1 ? await mrtDefaultConflictError(conn, nos) : null;
    if (dfConflict) return c.json({ ok: false, error: dfConflict }, 400);

    const r = await conn.execute(
      `UPDATE mrt SET namem = :namem, df = :df WHERE nos = :nos`,
      {
        nos,
        namem: payload.namem,
        df: payload.df,
      } as never,
    );
    if (!r.rowsAffected) return c.json({ ok: false, error: `المركز رقم ${nos} غير موجود` }, 404);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.delete('/api/cost-centres/:nos', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const nos = Number(c.req.param('nos'));
  if (!nos) return c.json({ ok: false, error: 'nos required' }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    // Legacy MRT.EDDL checks DATAK first, then USER_U.MRTALL, and shows
    // separate messages for document usage vs user linkage.
    const refs = await conn.execute<{NO_M:number | null; NO_M1:number | null}>(
      `SELECT
         (SELECT MAX(mrt) FROM datak WHERE mrt = :n) AS no_m,
         (SELECT MAX(mrtall) FROM user_u WHERE NVL(mrtall,0) = :n) AS no_m1
       FROM dual`,
      { n: nos }, { outFormat: 4002 },
    );
    const refRow = (refs.rows as unknown as {NO_M:number | null; NO_M1:number | null}[])[0]!;
    if (Number(refRow.NO_M1 ?? 0) > 0) {
      return c.json({ ok: false, error: 'لا يمكن حذف هذا المركز يوجد مستخدم مرتبطة به' }, 400);
    }
    if (Number(refRow.NO_M ?? 0) > 0) {
      return c.json({ ok: false, error: 'لا يمكن حذف هذا المركز يوجد مستندات مرتبطة به' }, 400);
    }

    const r = await conn.execute(`DELETE FROM mrt WHERE nos = :n`, { n: nos } as never);
    if (!r.rowsAffected) return c.json({ ok: false, error: 'not_found' }, 404);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.DELETED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

// =============================================
// /api/warehouses — DATA_MH.fmx (warehouse master data)
//
// Table: DATA_MH  — PK: NOG (warehouse id)
// Fields: NAMEG (name), ADR (address), TEL, NAMEAM (responsible),
//         NOA_S (linked GL account), USEM (unique operator user id).
//
// Business rule (legacy WHEN-LIST-CHANGED on USEM):
//   USEM must be unique — one user can manage only one warehouse.
// =============================================
app.get('/api/warehouses', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const q = c.req.query('q') ?? '';
  try {
    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT nog, nameg, adr, tel, nameam, noa_s, usem
         FROM data_mh
        WHERE :q IS NULL OR UPPER(NVL(nameg,'')) LIKE :q
          OR TO_CHAR(nog) LIKE :q OR UPPER(NVL(adr,'')) LIKE :q
        ORDER BY nog`,
      { q: q ? `%${q.toUpperCase()}%` : null },
    );
    return c.json({ ok: true, rows });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.get('/api/warehouses/:nog', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const nog = Number(c.req.param('nog'));
  if (!nog) return c.json({ ok: false, error: 'nog required' }, 400);
  try {
    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT nog, nameg, adr, tel, nameam, noa_s, usem
         FROM data_mh WHERE nog = :n`,
      { n: nog },
    );
    if (!rows.length) return c.json({ ok: false, error: 'not_found' }, 404);
    return c.json({ ok: true, record: rows[0] });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

function validateWarehousePayload(p: Record<string, unknown>): string | null {
  const nog = Number(p['NOG'] ?? p['nog'] ?? 0);
  if (!nog || nog <= 0) return 'رقم المخزن مطلوب ويجب أن يكون موجباً';
  const nameg = String(p['NAMEG'] ?? p['nameg'] ?? '').trim();
  if (!nameg) return ' يجب ادخال اسم المخزن';
  return null;
}

app.post('/api/warehouses', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const body = await c.req.json<Record<string, unknown>>();
  const err = validateWarehousePayload(body);
  if (err) return c.json({ ok: false, error: err }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    const nog = Number(body['NOG']);
    const dup = await conn.execute<{CNT:number}>(
      `SELECT COUNT(*) AS cnt FROM data_mh WHERE nog = :n`,
      { n: nog }, { outFormat: 4002 },
    );
    if ((dup.rows as unknown as {CNT:number}[])[0]!.CNT > 0)
      return c.json({ ok: false, error: `المخزن رقم ${nog} موجود مسبقاً` }, 400);

    const duplicateName = await conn.execute<{CNT:number}>(
      `SELECT COUNT(*) AS cnt FROM data_mh WHERE TRIM(nameg) = TRIM(:nameg)`,
      { nameg: String(body['NAMEG'] ?? '').trim() },
      { outFormat: 4002 },
    );
    if ((duplicateName.rows as unknown as {CNT:number}[])[0]!.CNT > 0)
      return c.json({ ok: false, error: 'اسم المخزن  المدخل مقيد من قبل' }, 400);

    // USEM uniqueness across warehouses
    const usem = Number(body['USEM'] ?? 0);
    if (usem > 0) {
      const dup2 = await conn.execute<{NOG:number}>(
        `SELECT nog FROM data_mh WHERE NVL(usem,0) = :u AND ROWNUM = 1`,
        { u: usem }, { outFormat: 4002 },
      );
      const r = dup2.rows as unknown as {NOG:number}[];
      if (r.length)
        return c.json({ ok: false, error: `المستخدم المدخل تم تعريفة مع المخزن ${r[0]!.NOG}` }, 400);
    }

    await conn.execute(
      `INSERT INTO data_mh (nog, nameg, adr, tel, nameam, noa_s, usem)
       VALUES (:nog, :nameg, :adr, :tel, :nameam, :noa_s, :usem)`,
      {
        nog,
        nameg: String(body['NAMEG'] ?? '').slice(0, 60),
        adr: String(body['ADR'] ?? '') || null,
        tel: String(body['TEL'] ?? '') || null,
        nameam: String(body['NAMEAM'] ?? '') || null,
        noa_s: Number(body['NOA_S'] ?? 0) || null,
        usem: usem || null,
      } as never,
    );
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, nog, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.put('/api/warehouses/:nog', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const nog = Number(c.req.param('nog'));
  if (!nog) return c.json({ ok: false, error: 'nog required' }, 400);
  const body = await c.req.json<Record<string, unknown>>();
  body['NOG'] = nog;
  const err = validateWarehousePayload(body);
  if (err) return c.json({ ok: false, error: err }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    const usem = Number(body['USEM'] ?? 0);
    if (usem > 0) {
      const dup = await conn.execute<{NOG:number}>(
        `SELECT nog FROM data_mh WHERE NVL(usem,0) = :u AND nog <> :n AND ROWNUM = 1`,
        { u: usem, n: nog }, { outFormat: 4002 },
      );
      const r = dup.rows as unknown as {NOG:number}[];
      if (r.length)
        return c.json({ ok: false, error: `المستخدم المدخل تم تعريفة مع المخزن ${r[0]!.NOG}` }, 400);
    }

    const duplicateName = await conn.execute<{CNT:number}>(
      `SELECT COUNT(*) AS cnt FROM data_mh WHERE nog <> :n AND TRIM(nameg) = TRIM(:nameg)`,
      { n: nog, nameg: String(body['NAMEG'] ?? '').trim() },
      { outFormat: 4002 },
    );
    if ((duplicateName.rows as unknown as {CNT:number}[])[0]!.CNT > 0)
      return c.json({ ok: false, error: 'اسم المخزن  المدخل مقيد من قبل' }, 400);

    const r = await conn.execute(
      `UPDATE data_mh SET
          nameg = :nameg, adr = :adr, tel = :tel,
          nameam = :nameam, noa_s = :noa_s, usem = :usem
        WHERE nog = :nog`,
      {
        nog,
        nameg: String(body['NAMEG'] ?? '').slice(0, 60),
        adr: String(body['ADR'] ?? '') || null,
        tel: String(body['TEL'] ?? '') || null,
        nameam: String(body['NAMEAM'] ?? '') || null,
        noa_s: Number(body['NOA_S'] ?? 0) || null,
        usem: usem || null,
      } as never,
    );
    if (!r.rowsAffected) return c.json({ ok: false, error: `المخزن رقم ${nog} غير موجود` }, 404);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.delete('/api/warehouses/:nog', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const nog = Number(c.req.param('nog'));
  if (!nog) return c.json({ ok: false, error: 'nog required' }, 400);
  if (nog <= 1) return c.json({ ok: false, error: 'لا يمكن حذف المخزن رقم 1' }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    for (const [table, col, message] of [
      ['datak_slf', 'nom', 'لا يمكن حذف المخزن يوجد  عملية صرف او توريد سلات فاضي  لهذا المخزن'],
      ['mzt', 'nozr', 'لا يمكن حذف المخزن  يوجد طرمبة مرتبطة به'],
    ] as const) {
      try {
        const r = await conn.execute<{CNT:number}>(
          `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${col} = :n`,
          { n: nog }, { outFormat: 4002 },
        );
        if (((r.rows as unknown as {CNT:number}[])[0]?.CNT ?? 0) > 0) {
          return c.json({ ok: false, error: message }, 400);
        }
      } catch { /* optional legacy table/column may be absent */ }
    }

    let linkedCount = 0;
    for (const [table, col] of [
      ['dataks', 'nomhzn'],
      ['rifmf', 'nomhzn'],
    ] as const) {
      try {
        const r = await conn.execute<{CNT:number}>(
          `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${col} = :n`,
          { n: nog }, { outFormat: 4002 },
        );
        linkedCount += (r.rows as unknown as {CNT:number}[])[0]?.CNT ?? 0;
      } catch { /* optional legacy table/column may be absent */ }
    }
    if (linkedCount > 0) {
      return c.json({ ok: false, error: 'لا يمكن حذف هذا المخزن يوجد عمليات مرتبطين بها ' }, 400);
    }

    // Referential integrity: stock movements reference the warehouse via
    // NOAMHZ (not NOG). ATM/ASM always exist; TM has NOAMHZ/NOMHZND pair.
    // Counting uses a single DUAL subquery wrapped in safe-EXISTS patterns
    // because some tables (FB/FM2) may be absent in older installations.
    let cnt = 0;
    for (const [table, col] of [
      ['atm', 'noamhz'],
      ['asm', 'noamhz'],
      ['tm',  'noamhz'],
      ['tm',  'nomhznd'],
    ] as const) {
      try {
        const r = await conn.execute<{CNT:number}>(
          `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${col} = :n`,
          { n: nog }, { outFormat: 4002 },
        );
        cnt += (r.rows as unknown as {CNT:number}[])[0]?.CNT ?? 0;
      } catch { /* table or column missing — skip */ }
    }
    if (cnt > 0) return c.json({
      ok: false, error: 'لا يمكن حذف هذا المخزن يوجد عمليات مرتبطين بها ',
    }, 400);

    const r = await conn.execute(`DELETE FROM data_mh WHERE nog = :n`, { n: nog } as never);
    if (!r.rowsAffected) return c.json({ ok: false, error: 'not_found' }, 404);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.DELETED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

// =============================================
// /api/items — DATA_SN.fmx (inventory item master data)
//
// Table: DATA_AG — shares structure with DATA_AC (chart of accounts) but for
//        inventory. Rows with RTBA=1 are roots, RTBA=2 are groups, RTBA>=3
//        are the actual item rows (what this screen manages).
//
// Identity rule (legacy POST-TEXT-ITEM on NOAN):
//   NOA = TYPEA || NOAN  (string concatenation cast to NUMBER)
//   e.g. TYPEA=501, NOAN=50  →  NOA=50150
//
// Business rules extracted from DATA_SN.fmb triggers:
//   - TYPEA must exist in DATA_AG with RTBA=2 (a valid group).
//   - NOAN must be unique inside TYPEA (same (TYPEA,NOAN) not allowed).
//   - If KSR=0 then WKS must be cleared (fraction-precision only when KSR=1).
//   - If any of X3/X4/X5 > 0 (computed-dimension items) → KSR forced to 0.
//   - If N_AML_SNF=0 then AML_SNF=0 (accounting currency link).
//   - MAXS >= MINS  and  MINSG >= MINS (pricing guard-rails, soft validation).
// =============================================

/** Returns the list of item groups (RTBA=2), used as TYPEA LOV. */
app.get('/api/items/groups', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  try {
    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT noa, namea, typea, rtba
         FROM data_ag
        WHERE NVL(rtba,0) = 2
        ORDER BY noa`,
    );
    return c.json({ ok: true, rows });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

/** Lightweight list for the left pane — includes only frequently shown cols. */
app.get('/api/items', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const q = c.req.query('q') ?? '';
  const group = Number(c.req.query('group') ?? 0);
  try {
    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT noa, namea, typea, noan, ahsar, noparcod,
              NVL(ksr,0) AS ksr, wg, mins, maxs
         FROM data_ag
        WHERE NVL(rtba,0) >= 3
          AND (:g = 0 OR typea = :g)
          AND (:q IS NULL
               OR UPPER(NVL(namea,'')) LIKE :q
               OR TO_CHAR(noa) LIKE :q
               OR UPPER(NVL(ahsar,'')) LIKE :q
               OR UPPER(NVL(noparcod,'')) LIKE :q)
        ORDER BY typea, noan`,
      {
        g: group || 0,
        q: q ? `%${q.toUpperCase()}%` : null,
      },
    );
    return c.json({ ok: true, rows });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.get('/api/items/:noa', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const noa = Number(c.req.param('noa'));
  if (!noa) return c.json({ ok: false, error: 'noa required' }, 400);
  try {
    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT * FROM data_ag WHERE noa = :n`,
      { n: noa },
    );
    if (!rows.length) return c.json({ ok: false, error: 'not_found' }, 404);
    return c.json({ ok: true, record: rows[0] });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

/** Validates the common (create + update) portion of the item payload. */
function validateItemPayload(p: Record<string, unknown>): string | null {
  const namea = String(p['NAMEA'] ?? p['namea'] ?? '').trim();
  if (!namea) return 'اسم الصنف مطلوب';
  const typea = Number(p['TYPEA'] ?? p['typea'] ?? 0);
  if (!typea) return 'يجب اختيار مجموعة الصنف';

  const ksr = Number(p['KSR'] ?? p['ksr'] ?? 0);
  const x3 = Number(p['X3'] ?? p['x3'] ?? 0);
  const x4 = Number(p['X4'] ?? p['x4'] ?? 0);
  const x5 = Number(p['X5'] ?? p['x5'] ?? 0);
  if ((x3 > 0 || x4 > 0 || x5 > 0) && ksr === 1) {
    return 'الأصناف ذات الأبعاد المحسوبة (X3/X4/X5) لا تقبل الكسور';
  }

  const mins  = Number(p['MINS']  ?? p['mins']  ?? 0);
  const maxs  = Number(p['MAXS']  ?? p['maxs']  ?? 0);
  if (mins > 0 && maxs > 0 && maxs < mins) return 'الحد الأقصى للبيع يجب أن يكون ≥ الحد الأدنى';

  const minsg = Number(p['MINSG'] ?? p['minsg'] ?? 0);
  const maxsg = Number(p['MAXSG'] ?? p['maxsg'] ?? 0);
  if (minsg > 0 && maxsg > 0 && maxsg < minsg) return 'الحد الأقصى للجملة يجب أن يكون ≥ الحد الأدنى';

  return null;
}

/** Normalises the payload according to legacy enforcement rules. */
function normaliseItemPayload(p: Record<string, unknown>): Record<string, unknown> {
  const ksr = Number(p['KSR'] ?? 0);
  const x3 = Number(p['X3'] ?? 0);
  const x4 = Number(p['X4'] ?? 0);
  const x5 = Number(p['X5'] ?? 0);
  const out: Record<string, unknown> = { ...p };
  // Computed-dimension items force KSR=0
  if (x3 > 0 || x4 > 0 || x5 > 0) out['KSR'] = 0;
  // KSR=0 clears fraction-precision field
  if (Number(out['KSR'] ?? 0) === 0) out['WKS'] = null;
  // AML_SNF requires N_AML_SNF>0
  if (Number(out['N_AML_SNF'] ?? 0) === 0) out['AML_SNF'] = 0;
  return out;
}

app.post('/api/items', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const raw = await c.req.json<Record<string, unknown>>();
  const err = validateItemPayload(raw);
  if (err) return c.json({ ok: false, error: err }, 400);
  const body = normaliseItemPayload(raw);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    const typea = Number(body['TYPEA']);

    // Group must exist with RTBA=2
    const grp = await conn.execute<{NAMEA:string; RTBA:number}>(
      `SELECT namea, NVL(rtba,0) AS rtba FROM data_ag WHERE noa = :t`,
      { t: typea }, { outFormat: 4002 },
    );
    const gRows = grp.rows as unknown as Array<{NAMEA:string;RTBA:number}>;
    if (!gRows.length)
      return c.json({ ok: false, error: `المجموعة ${typea} غير موجودة` }, 400);
    if (gRows[0]!.RTBA !== 2)
      return c.json({ ok: false, error: `الحساب ${typea} ليس مجموعة (RTBA=${gRows[0]!.RTBA})` }, 400);

    // Auto-assign NOAN if not provided = MAX(noan)+1 within group
    let noan = Number(body['NOAN'] ?? 0);
    if (!noan) {
      const m = await conn.execute<{MX:number}>(
        `SELECT NVL(MAX(noan),0) AS mx FROM data_ag WHERE typea = :t`,
        { t: typea }, { outFormat: 4002 },
      );
      noan = ((m.rows as unknown as {MX:number}[])[0]?.MX ?? 0) + 10;
    } else {
      const dup = await conn.execute<{CNT:number}>(
        `SELECT COUNT(*) AS cnt FROM data_ag WHERE typea = :t AND noan = :n`,
        { t: typea, n: noan }, { outFormat: 4002 },
      );
      if ((dup.rows as unknown as {CNT:number}[])[0]!.CNT > 0)
        return c.json({ ok: false, error: `الرقم التسلسلي ${noan} مستخدم في المجموعة ${typea}` }, 400);
    }

    // NOA = typea concatenated with noan (legacy rule)
    const noa = Number(String(typea) + String(noan));

    // Build the INSERT column list — only columns that exist in data_ag.
    // This map mirrors the item form fields.
    const cols: Array<[string, unknown]> = [
      ['noa', noa], ['typea', typea], ['noan', noan], ['rtba', 3],
      ['namea', String(body['NAMEA'] ?? '').slice(0, 120)],
      ['namea2', body['NAMEA2'] ? String(body['NAMEA2']) : null],
      ['namea3', body['NAMEA3'] ? String(body['NAMEA3']) : null],
      ['ahsar',  body['AHSAR']  ? String(body['AHSAR'])  : null],
      ['noparcod', body['NOPARCOD'] ? String(body['NOPARCOD']) : null],
      ['amlhh', Number(body['AMLHH'] ?? 0) || null],
      ['noasys', Number(body['NOASYS'] ?? 0) || null],
      // dimension / unit fields
      ['a1', body['A1'] ? String(body['A1']) : null],
      ['n1', Number(body['N1'] ?? 0) || null],
      ['a2', body['A2'] ? String(body['A2']) : null],
      ['n2', Number(body['N2'] ?? 0) || null],
      ['x2', Number(body['X2'] ?? 0) || null],
      ['a3', body['A3'] ? String(body['A3']) : null],
      ['n3', Number(body['N3'] ?? 0) || null],
      ['x3', Number(body['X3'] ?? 0) || null],
      ['a4', body['A4'] ? String(body['A4']) : null],
      ['n4', Number(body['N4'] ?? 0) || null],
      ['x4', Number(body['X4'] ?? 0) || null],
      ['a5', body['A5'] ? String(body['A5']) : null],
      ['n5', Number(body['N5'] ?? 0) || null],
      ['x5', Number(body['X5'] ?? 0) || null],
      // pricing / stock
      ['ksr',  Number(body['KSR']  ?? 0) || 0],
      ['wks',  body['WKS'] ?? null],
      ['nsbr', Number(body['NSBR'] ?? 0) || null],
      ['mins', Number(body['MINS'] ?? 0) || null],
      ['maxs', Number(body['MAXS'] ?? 0) || null],
      ['minsg', Number(body['MINSG'] ?? 0) || null],
      ['maxsg', Number(body['MAXSG'] ?? 0) || null],
      ['wg',   Number(body['WG']   ?? 0) || null],
      ['wb',   Number(body['WB']   ?? 0) || null],
      ['ws',   Number(body['WS']   ?? 0) || null],
      ['maxb', Number(body['MAXB'] ?? 0) || null],
      ['tlb',  Number(body['TLB']  ?? 0) || null],
      ['nht',  Number(body['NHT']  ?? 0) || null],
      ['nhg',  Number(body['NHG']  ?? 0) || null],
      // flags
      ['shd',  Number(body['SHD']  ?? 0) || 0],
      ['dn',   Number(body['DN']   ?? 0) || 0],
      ['hl',   Number(body['HL']   ?? 0) || 0],
      ['hgz',  Number(body['HGZ']  ?? 0) || 0],
      ['smr',  Number(body['SMR']  ?? 0) || 0],
      ['nkd',  Number(body['NKD']  ?? 0) || 0],
      ['norga', Number(body['NORGA'] ?? 0) || 0],
      // accounting link
      ['aml_snf',    Number(body['AML_SNF']    ?? 0) || 0],
      ['ab_aml_snf', Number(body['AB_AML_SNF'] ?? 0) || null],
      ['n_aml_snf',  Number(body['N_AML_SNF']  ?? 0) || null],
      // NAMEB is the free-text long description field (DATA_AG has no MEMOH)
      ['nameb', body['NAMEB'] ? String(body['NAMEB']) : null],
      ['moka',  body['MOKA']  ? String(body['MOKA'])  : null],
      ['nousx', user.nou],
    ];

    const colNames  = cols.map(([c]) => c);
    const binds = Object.fromEntries(cols);
    await conn.execute(
      `INSERT INTO data_ag (${colNames.join(',')})
       VALUES (${colNames.map(n => ':' + n).join(',')})`,
      binds as never,
    );
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, noa, noan, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.put('/api/items/:noa', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const noa = Number(c.req.param('noa'));
  if (!noa) return c.json({ ok: false, error: 'noa required' }, 400);
  const raw = await c.req.json<Record<string, unknown>>();
  const err = validateItemPayload(raw);
  if (err) return c.json({ ok: false, error: err }, 400);
  const body = normaliseItemPayload(raw);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    // Mutable fields — NOA/TYPEA/NOAN/RTBA are fixed once created.
    const r = await conn.execute(
      `UPDATE data_ag SET
          namea = :namea, namea2 = :namea2, namea3 = :namea3,
          ahsar = :ahsar, noparcod = :noparcod,
          amlhh = :amlhh, noasys = :noasys,
          a1 = :a1, n1 = :n1,
          a2 = :a2, n2 = :n2, x2 = :x2,
          a3 = :a3, n3 = :n3, x3 = :x3,
          a4 = :a4, n4 = :n4, x4 = :x4,
          a5 = :a5, n5 = :n5, x5 = :x5,
          ksr = :ksr, wks = :wks, nsbr = :nsbr,
          mins = :mins, maxs = :maxs, minsg = :minsg, maxsg = :maxsg,
          wg = :wg, wb = :wb, ws = :ws,
          maxb = :maxb, tlb = :tlb, nht = :nht, nhg = :nhg,
          shd = :shd, dn = :dn, hl = :hl, hgz = :hgz,
          smr = :smr, nkd = :nkd, norga = :norga,
          aml_snf = :aml_snf, ab_aml_snf = :ab_aml_snf, n_aml_snf = :n_aml_snf,
          nameb = :nameb, moka = :moka,
          nousxu = :nousxu
        WHERE noa = :noa`,
      {
        noa,
        namea:  String(body['NAMEA'] ?? '').slice(0, 120),
        namea2: body['NAMEA2'] ? String(body['NAMEA2']) : null,
        namea3: body['NAMEA3'] ? String(body['NAMEA3']) : null,
        ahsar:  body['AHSAR']  ? String(body['AHSAR'])  : null,
        noparcod: body['NOPARCOD'] ? String(body['NOPARCOD']) : null,
        amlhh: Number(body['AMLHH'] ?? 0) || null,
        noasys: Number(body['NOASYS'] ?? 0) || null,
        a1: body['A1'] ? String(body['A1']) : null,
        n1: Number(body['N1'] ?? 0) || null,
        a2: body['A2'] ? String(body['A2']) : null,
        n2: Number(body['N2'] ?? 0) || null,
        x2: Number(body['X2'] ?? 0) || null,
        a3: body['A3'] ? String(body['A3']) : null,
        n3: Number(body['N3'] ?? 0) || null,
        x3: Number(body['X3'] ?? 0) || null,
        a4: body['A4'] ? String(body['A4']) : null,
        n4: Number(body['N4'] ?? 0) || null,
        x4: Number(body['X4'] ?? 0) || null,
        a5: body['A5'] ? String(body['A5']) : null,
        n5: Number(body['N5'] ?? 0) || null,
        x5: Number(body['X5'] ?? 0) || null,
        ksr: Number(body['KSR'] ?? 0) || 0,
        wks: body['WKS'] ?? null,
        nsbr: Number(body['NSBR'] ?? 0) || null,
        mins: Number(body['MINS'] ?? 0) || null,
        maxs: Number(body['MAXS'] ?? 0) || null,
        minsg: Number(body['MINSG'] ?? 0) || null,
        maxsg: Number(body['MAXSG'] ?? 0) || null,
        wg: Number(body['WG'] ?? 0) || null,
        wb: Number(body['WB'] ?? 0) || null,
        ws: Number(body['WS'] ?? 0) || null,
        maxb: Number(body['MAXB'] ?? 0) || null,
        tlb:  Number(body['TLB']  ?? 0) || null,
        nht:  Number(body['NHT']  ?? 0) || null,
        nhg:  Number(body['NHG']  ?? 0) || null,
        shd:  Number(body['SHD']  ?? 0) || 0,
        dn:   Number(body['DN']   ?? 0) || 0,
        hl:   Number(body['HL']   ?? 0) || 0,
        hgz:  Number(body['HGZ']  ?? 0) || 0,
        smr:  Number(body['SMR']  ?? 0) || 0,
        nkd:  Number(body['NKD']  ?? 0) || 0,
        norga: Number(body['NORGA'] ?? 0) || 0,
        aml_snf: Number(body['AML_SNF'] ?? 0) || 0,
        ab_aml_snf: Number(body['AB_AML_SNF'] ?? 0) || null,
        n_aml_snf:  Number(body['N_AML_SNF']  ?? 0) || null,
        nameb: body['NAMEB'] ? String(body['NAMEB']) : null,
        moka:  body['MOKA']  ? String(body['MOKA'])  : null,
        nousxu: user.nou,
      } as never,
    );
    if (!r.rowsAffected) return c.json({ ok: false, error: `الصنف ${noa} غير موجود` }, 404);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.delete('/api/items/:noa', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const noa = Number(c.req.param('noa'));
  if (!noa) return c.json({ ok: false, error: 'noa required' }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    // Referential integrity — count stock/sales lines referencing this item
    let cnt = 0;
    for (const [table, col] of [
      ['atm', 'noa'],
      ['asm', 'noa'],
      ['tm',  'noa'],
    ] as const) {
      try {
        const r = await conn.execute<{CNT:number}>(
          `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${col} = :n`,
          { n: noa }, { outFormat: 4002 },
        );
        cnt += (r.rows as unknown as {CNT:number}[])[0]?.CNT ?? 0;
      } catch { /* table or column missing — skip */ }
    }
    if (cnt > 0) return c.json({
      ok: false, error: `لا يمكن حذف الصنف — مستخدم في ${cnt} حركة مخزنية`,
    }, 400);

    const r = await conn.execute(
      `DELETE FROM data_ag WHERE noa = :n AND NVL(rtba,0) >= 3`,
      { n: noa } as never,
    );
    if (!r.rowsAffected) return c.json({ ok: false, error: 'الصنف غير موجود أو هو مجموعة' }, 404);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.DELETED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

// =============================================
// /api/barcodes — PARCOD.fmx (item-barcode mapping)
//
// Table: PARCOD — three cols:
//   NOP  (VARCHAR2, PK) — the barcode string
//   NOA  (NUMBER)       — item id (→ DATA_AG.NOA)
//   NOOB (NUMBER)       — pack multiplier (qty per barcode scan)
//
// Each item may have multiple barcodes (one per pack size). NOP is unique.
// =============================================
app.get('/api/barcodes', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const item = Number(c.req.query('item') ?? 0);
  const q = c.req.query('q') ?? '';
  try {
    // Join with DATA_AG to enrich with item name for display
    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT p.nop, p.noa, NVL(p.noob,1) AS noob,
              a.namea AS item_name, a.ahsar
         FROM parcod p
         LEFT JOIN data_ag a ON a.noa = p.noa
        WHERE (:item = 0 OR p.noa = :item)
          AND (:q IS NULL
               OR UPPER(p.nop) LIKE :q
               OR UPPER(NVL(a.namea,'')) LIKE :q
               OR TO_CHAR(p.noa) LIKE :q)
        ORDER BY p.noa, p.nop`,
      {
        item: item || 0,
        q: q ? `%${q.toUpperCase()}%` : null,
      },
    );
    return c.json({ ok: true, rows });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.post('/api/barcodes', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const body = await c.req.json<Record<string, unknown>>();
  const nop = String(body['NOP'] ?? body['nop'] ?? '').trim();
  const noa = Number(body['NOA'] ?? body['noa'] ?? 0);
  const noob = Number(body['NOOB'] ?? body['noob'] ?? 1) || 1;

  if (!nop)       return c.json({ ok: false, error: 'الباركود مطلوب' }, 400);
  if (nop.length > 30)
    return c.json({ ok: false, error: 'الباركود طويل جداً (بحد أقصى 30 خانة)' }, 400);
  if (!noa || noa <= 0)
    return c.json({ ok: false, error: 'يجب اختيار الصنف' }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    // Verify item exists as an actual item (RTBA>=3)
    const it = await conn.execute<{NAMEA:string; RTBA:number}>(
      `SELECT namea, NVL(rtba,0) AS rtba FROM data_ag WHERE noa = :n`,
      { n: noa }, { outFormat: 4002 },
    );
    const itRows = it.rows as unknown as Array<{NAMEA:string;RTBA:number}>;
    if (!itRows.length)
      return c.json({ ok: false, error: `الصنف ${noa} غير موجود` }, 400);
    if (itRows[0]!.RTBA < 3)
      return c.json({ ok: false, error: `${noa} ليس صنفاً (هو مجموعة)` }, 400);

    // Barcode must be unique across all items
    const dup = await conn.execute<{NOA:number; NAMEA:string}>(
      `SELECT p.noa, a.namea
         FROM parcod p
         LEFT JOIN data_ag a ON a.noa = p.noa
        WHERE p.nop = :p AND ROWNUM = 1`,
      { p: nop }, { outFormat: 4002 },
    );
    const dRows = dup.rows as unknown as Array<{NOA:number;NAMEA:string}>;
    if (dRows.length)
      return c.json({
        ok: false,
        error: `الباركود "${nop}" مستخدم للصنف ${dRows[0]!.NOA} (${dRows[0]!.NAMEA ?? ''})`,
      }, 400);

    await conn.execute(
      `INSERT INTO parcod (nop, noa, noob) VALUES (:nop, :noa, :noob)`,
      { nop, noa, noob } as never,
    );
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, nop, noa, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

/** Update pack multiplier only — the barcode and the item are immutable keys. */
app.put('/api/barcodes/:nop', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const nop = String(c.req.param('nop') ?? '');
  if (!nop) return c.json({ ok: false, error: 'nop required' }, 400);
  const body = await c.req.json<Record<string, unknown>>();
  const noob = Number(body['NOOB'] ?? body['noob'] ?? 0);
  if (!noob || noob <= 0)
    return c.json({ ok: false, error: 'معامل العبوة يجب أن يكون موجباً' }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    const r = await conn.execute(
      `UPDATE parcod SET noob = :noob WHERE nop = :nop`,
      { nop, noob } as never,
    );
    if (!r.rowsAffected) return c.json({ ok: false, error: 'not_found' }, 404);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.delete('/api/barcodes/:nop', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const nop = String(c.req.param('nop') ?? '');
  if (!nop) return c.json({ ok: false, error: 'nop required' }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    const r = await conn.execute(`DELETE FROM parcod WHERE nop = :nop`, { nop } as never);
    if (!r.rowsAffected) return c.json({ ok: false, error: 'not_found' }, 404);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.DELETED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

// =============================================
// /api/shortcuts — AHTSAR.fmx (text shortcuts / abbreviations)
//
// Table: AHTSR  — small VARCHAR2 lookup
//   AHT   (PK, max 30)  — the shortcut key typed by user (e.g. "ف")
//   BAHT               — expansion text (e.g. "فاتورة")
//   BAHTB              — optional second expansion
//
// Used across voucher/invoice screens to auto-expand abbreviations on
// Enter. No composite key — AHT alone must be unique.
// =============================================
app.get('/api/shortcuts', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const q = c.req.query('q') ?? '';
  try {
    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT aht, baht, bahtb FROM ahtsr
        WHERE :q IS NULL
           OR UPPER(aht) LIKE :q
           OR UPPER(NVL(baht,''))  LIKE :q
           OR UPPER(NVL(bahtb,'')) LIKE :q
        ORDER BY aht`,
      { q: q ? `%${q.toUpperCase()}%` : null },
    );
    return c.json({ ok: true, rows });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

/** Payload validation shared by POST/PUT. */
function validateShortcutPayload(p: Record<string, unknown>): string | null {
  const aht = String(p['AHT'] ?? p['aht'] ?? '').trim();
  if (!aht)              return 'الاختصار مطلوب';
  if (aht.length > 30)   return 'الاختصار طويل (بحد أقصى 30)';
  const baht = String(p['BAHT'] ?? p['baht'] ?? '').trim();
  if (!baht)             return 'البيان مطلوب';
  return null;
}

app.post('/api/shortcuts', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const body = await c.req.json<Record<string, unknown>>();
  const err = validateShortcutPayload(body);
  if (err) return c.json({ ok: false, error: err }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    const aht = String(body['AHT'] ?? body['aht'] ?? '').trim();
    const baht = String(body['BAHT'] ?? body['baht'] ?? '').trim();
    const bahtb = String(body['BAHTB'] ?? body['bahtb'] ?? '').trim();
    const dup = await conn.execute<{CNT:number}>(
      `SELECT COUNT(*) AS cnt FROM ahtsr WHERE aht = :a`,
      { a: aht }, { outFormat: 4002 },
    );
    if ((dup.rows as unknown as {CNT:number}[])[0]!.CNT > 0)
      return c.json({ ok: false, error: 'هذه الاختصار مقيد من قبل' }, 400);

    await conn.execute(
      `INSERT INTO ahtsr (aht, baht, bahtb) VALUES (:aht, :baht, :bahtb)`,
      {
        aht,
        baht:  baht.slice(0, 500),
        bahtb: bahtb ? bahtb.slice(0, 500) : null,
      } as never,
    );
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, aht, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.put('/api/shortcuts/:aht', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const aht = decodeURIComponent(c.req.param('aht') ?? '');
  if (!aht) return c.json({ ok: false, error: 'aht required' }, 400);
  if (aht === 'ا') return c.json({ ok: false, error: 'لا يمكن تعديل هذا الاختصار اختصار نظام' }, 400);
  const body = await c.req.json<Record<string, unknown>>();
  body['AHT'] = aht;
  const err = validateShortcutPayload(body);
  if (err) return c.json({ ok: false, error: err }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    const baht = String(body['BAHT'] ?? body['baht'] ?? '').trim();
    const bahtb = String(body['BAHTB'] ?? body['bahtb'] ?? '').trim();
    const r = await conn.execute(
      `UPDATE ahtsr SET baht = :baht, bahtb = :bahtb WHERE aht = :aht`,
      {
        aht,
        baht:  baht.slice(0, 500),
        bahtb: bahtb ? bahtb.slice(0, 500) : null,
      } as never,
    );
    if (!r.rowsAffected) return c.json({ ok: false, error: 'not_found' }, 404);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.delete('/api/shortcuts/:aht', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const aht = decodeURIComponent(c.req.param('aht') ?? '');
  if (!aht) return c.json({ ok: false, error: 'aht required' }, 400);
  if (aht === 'ا') return c.json({ ok: false, error: 'لا يمكن تعديل هذا الاختصار اختصار نظام' }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    const r = await conn.execute(`DELETE FROM ahtsr WHERE aht = :a`, { a: aht } as never);
    if (!r.rowsAffected) return c.json({ ok: false, error: 'not_found' }, 404);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.DELETED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

// =============================================
// /api/users — USER.fmx (user master data)
//
// Table: USER_U — system users and their per-screen permissions flags.
// PK: NOU (2-digit user id, the one you type on the login screen).
//
// Notable columns:
//   NAMEU        — display name
//   PASS / PASSS — primary + backup passwords (legacy plaintext)
//   STATU        — 1 = super-user (bypasses screen permission checks)
//   SARSHALL     — "show all"  flag used by many LOVs
//   TKLF         — default cost centre
//   KSHR         — allow creating new accounts from voucher LOVs
//   SART         — default sales price list
//   TAB          — default printer / tab
//   NOAH         — user is "tied" to a single account
//   USX          — advanced permissions (freeze level 3, delete posted, …)
//   MRT          — allowed cost centre
//   MRTALL       — "all cost centres" flag
//
// Because password storage is legacy-plaintext, these endpoints keep it as-is
// (the login flow uses the same comparison). A future migration can wrap it
// in bcrypt without changing the UI.
// =============================================
app.get('/api/users', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const q = c.req.query('q') ?? '';
  try {
    // Never return the password to clients.
    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT nou, nameu, NVL(statu,0) AS statu,
              NVL(sarshall,0) AS sarshall,
              tklf, sart, tab, noah,
              NVL(usx,0) AS usx, mrt, NVL(mrtall,0) AS mrtall,
              NVL(kshr,0) AS kshr
         FROM user_u
        WHERE :q IS NULL
           OR UPPER(NVL(nameu,'')) LIKE :q
           OR TO_CHAR(nou) LIKE :q
        ORDER BY nou`,
      { q: q ? `%${q.toUpperCase()}%` : null },
    );
    return c.json({ ok: true, rows });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.get('/api/users/:nou', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const nou = Number(c.req.param('nou'));
  if (!nou) return c.json({ ok: false, error: 'nou required' }, 400);
  try {
    // Return everything except PASS/PASSS (passwords are write-only from the UI).
    const rows = await queryOn<Record<string, unknown>>(
      user.schema,
      `SELECT nou, nameu,
              NVL(statu,0)    AS statu,
              NVL(sarshall,0) AS sarshall,
              tklf, sart, tab, noah, mrt,
              NVL(mrtall,0)   AS mrtall,
              NVL(usx,0)      AS usx,
              NVL(kshr,0)     AS kshr,
              NVL(ed,0) AS ed, NVL(de,0) AS de,
              NVL(sy,0) AS sy, NVL(pr,0) AS pr, NVL(qs,0) AS qs
         FROM user_u WHERE nou = :n`,
      { n: nou },
    );
    if (!rows.length) return c.json({ ok: false, error: 'not_found' }, 404);
    return c.json({ ok: true, record: rows[0] });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

function validateUserPayload(p: Record<string, unknown>): string | null {
  const nou = Number(p['NOU'] ?? p['nou'] ?? 0);
  if (!nou || nou <= 0 || nou > 99)
    return 'رقم المستخدم مطلوب (بين 1 و 99)';
  const nameu = String(p['NAMEU'] ?? p['nameu'] ?? '').trim();
  if (!nameu) return 'اسم المستخدم مطلوب';
  return null;
}

/** Admin-only guard — requires STATU>0 on the current session user. */
function requireAdmin(c: Context): { ok: true } | { ok: false; res: Response } {
  const user = readUser(c);
  if (!user) return { ok: false, res: c.json({ ok: false, error: M.AUTH_REQUIRED }, 401) };
  if (!user.isAdmin) return {
    ok: false,
    res: c.json({ ok: false, error: 'هذه العملية تتطلب صلاحية مدير النظام' }, 403),
  };
  return { ok: true };
}

app.post('/api/users', async (c) => {
  const guard = requireAdmin(c); if (!guard.ok) return guard.res;
  const user = readUser(c)!;
  const body = await c.req.json<Record<string, unknown>>();
  const err = validateUserPayload(body);
  if (err) return c.json({ ok: false, error: err }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    const nou = Number(body['NOU']);
    const dup = await conn.execute<{CNT:number}>(
      `SELECT COUNT(*) AS cnt FROM user_u WHERE nou = :n`,
      { n: nou }, { outFormat: 4002 },
    );
    if ((dup.rows as unknown as {CNT:number}[])[0]!.CNT > 0)
      return c.json({ ok: false, error: `المستخدم رقم ${nou} موجود مسبقاً` }, 400);

    const pass = String(body['PASS'] ?? body['pass'] ?? '').trim();
    if (!pass) return c.json({ ok: false, error: 'كلمة المرور مطلوبة' }, 400);

    await conn.execute(
      `INSERT INTO user_u
         (nou, nameu, pass, passs, statu, sarshall, tklf, sart, tab,
          noah, mrt, mrtall, usx, kshr, ed, de, sy, pr, qs)
       VALUES
         (:nou, :nameu, :pass, :passs, :statu, :sarshall, :tklf, :sart, :tab,
          :noah, :mrt, :mrtall, :usx, :kshr, :ed, :de, :sy, :pr, :qs)`,
      {
        nou,
        nameu: String(body['NAMEU'] ?? '').slice(0, 60),
        pass,
        passs: body['PASSS'] ? String(body['PASSS']) : pass,
        statu: Number(body['STATU'] ?? 0) || 0,
        sarshall: Number(body['SARSHALL'] ?? 0) || 0,
        tklf: Number(body['TKLF'] ?? 0) || null,
        sart: Number(body['SART'] ?? 0) || null,
        tab:  Number(body['TAB']  ?? 0) || null,
        noah: Number(body['NOAH'] ?? 0) || null,
        mrt:  Number(body['MRT']  ?? 0) || null,
        mrtall: Number(body['MRTALL'] ?? 0) || 0,
        usx:  Number(body['USX']  ?? 0) || 0,
        kshr: Number(body['KSHR'] ?? 0) || 0,
        ed:   Number(body['ED']   ?? 0) || 0,
        de:   Number(body['DE']   ?? 0) || 0,
        sy:   Number(body['SY']   ?? 0) || 0,
        pr:   Number(body['PR']   ?? 0) || 0,
        qs:   Number(body['QS']   ?? 0) || 0,
      } as never,
    );
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, nou, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.put('/api/users/:nou', async (c) => {
  const guard = requireAdmin(c); if (!guard.ok) return guard.res;
  const user = readUser(c)!;
  const nou = Number(c.req.param('nou'));
  if (!nou) return c.json({ ok: false, error: 'nou required' }, 400);
  const body = await c.req.json<Record<string, unknown>>();
  body['NOU'] = nou;
  const err = validateUserPayload(body);
  if (err) return c.json({ ok: false, error: err }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    // Optional password change — only update when the caller sends PASS.
    const setPass = body['PASS'] !== undefined && String(body['PASS']).trim() !== '';
    const passSql = setPass ? ', pass = :pass, passs = :pass' : '';

    const r = await conn.execute(
      `UPDATE user_u SET
          nameu = :nameu, statu = :statu, sarshall = :sarshall,
          tklf = :tklf, sart = :sart, tab = :tab,
          noah = :noah, mrt = :mrt, mrtall = :mrtall,
          usx = :usx, kshr = :kshr,
          ed = :ed, de = :de, sy = :sy, pr = :pr, qs = :qs
          ${passSql}
        WHERE nou = :nou`,
      {
        nou,
        nameu: String(body['NAMEU'] ?? '').slice(0, 60),
        statu: Number(body['STATU'] ?? 0) || 0,
        sarshall: Number(body['SARSHALL'] ?? 0) || 0,
        tklf: Number(body['TKLF'] ?? 0) || null,
        sart: Number(body['SART'] ?? 0) || null,
        tab:  Number(body['TAB']  ?? 0) || null,
        noah: Number(body['NOAH'] ?? 0) || null,
        mrt:  Number(body['MRT']  ?? 0) || null,
        mrtall: Number(body['MRTALL'] ?? 0) || 0,
        usx:  Number(body['USX']  ?? 0) || 0,
        kshr: Number(body['KSHR'] ?? 0) || 0,
        ed:   Number(body['ED']   ?? 0) || 0,
        de:   Number(body['DE']   ?? 0) || 0,
        sy:   Number(body['SY']   ?? 0) || 0,
        pr:   Number(body['PR']   ?? 0) || 0,
        qs:   Number(body['QS']   ?? 0) || 0,
        ...(setPass ? { pass: String(body['PASS']).trim() } : {}),
      } as never,
    );
    if (!r.rowsAffected) return c.json({ ok: false, error: `المستخدم ${nou} غير موجود` }, 404);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.SAVED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.delete('/api/users/:nou', async (c) => {
  const guard = requireAdmin(c); if (!guard.ok) return guard.res;
  const user = readUser(c)!;
  const nou = Number(c.req.param('nou'));
  if (!nou) return c.json({ ok: false, error: 'nou required' }, 400);
  if (nou === user.nou)
    return c.json({ ok: false, error: 'لا يمكنك حذف نفسك' }, 400);

  const pool = await getPool(user.schema); const conn = await pool.getConnection();
  try {
    // Referential integrity — check a few common audit columns that point to NOU.
    let cnt = 0;
    for (const [table, col] of [
      ['data_ac', 'nousx'], ['data_ac', 'nousxu'],
      ['data_ag', 'nousx'], ['data_ag', 'nousxu'],
      ['sndkd',   'nousx'], ['sndk',    'nousx'], ['snds',    'nousx'],
    ] as const) {
      try {
        const r = await conn.execute<{CNT:number}>(
          `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${col} = :n AND ROWNUM <= 1`,
          { n: nou }, { outFormat: 4002 },
        );
        cnt += (r.rows as unknown as {CNT:number}[])[0]?.CNT ?? 0;
      } catch { /* ignore missing tables/cols */ }
    }
    if (cnt > 0) return c.json({
      ok: false, error: `لا يمكن حذف المستخدم — قام بعمليات على النظام (${cnt}+ سجل)`,
    }, 400);

    const r = await conn.execute(`DELETE FROM user_u WHERE nou = :n`, { n: nou } as never);
    if (!r.rowsAffected) return c.json({ ok: false, error: 'not_found' }, 404);
    await conn.execute('COMMIT', {} as never);
    return c.json({ ok: true, message: M.DELETED_SUCCESS });
  } catch (e) {
    try { await conn.execute('ROLLBACK', {} as never); } catch { /* */ }
    return c.json({ ok: false, error: (e as Error).message }, 500);
  } finally { await conn.close(); }
});

app.get('/api/party-groups', async (c) => {
  const accept = c.req.header('accept') ?? '';
  if (accept.includes('text/html')) return c.redirect('/app');
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  const tg = Number(c.req.query('tg') ?? 1) === 2 ? 2 : 1;
  const where = tg === 2
    ? '(NVL(tg,0) = 2 OR NVL(nog,0) = 1)'
    : 'NVL(tg,0) = 1';
  try {
    const rows = await queryOn(
      user.schema,
      `SELECT nog, nameg
         FROM grp
        WHERE ${where}
        ORDER BY nog`,
    );
    return c.json({ ok: true, rows });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.get('/api/regions', async (c) => {
  const accept = c.req.header('accept') ?? '';
  if (accept.includes('text/html')) return c.redirect('/app');
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: M.AUTH_REQUIRED }, 401);
  try {
    const rows = await queryOn(
      user.schema,
      `SELECT nog, nameg
         FROM mntka
        ORDER BY nog`,
    );
    return c.json({ ok: true, rows });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

// Customer routes (DATA_AM.fmx)
app.get(   '/api/customers',      buildPartyListHandler(CUSTOMER_RTBA));
app.get(   '/api/customers/:noa', buildPartyGetHandler(CUSTOMER_RTBA));
app.post(  '/api/customers',      buildPartyCreateHandler(CUSTOMER_RTBA));
app.put(   '/api/customers/:noa', buildPartyUpdateHandler(CUSTOMER_RTBA));
app.delete('/api/customers/:noa', buildPartyDeleteHandler(CUSTOMER_RTBA));

// Supplier routes (DATA_MO.fmx) — same logic, different RTBA
app.get(   '/api/suppliers',      buildPartyListHandler(SUPPLIER_RTBA));
app.get(   '/api/suppliers/:noa', buildPartyGetHandler(SUPPLIER_RTBA));
app.post(  '/api/suppliers',      buildPartyCreateHandler(SUPPLIER_RTBA));
app.put(   '/api/suppliers/:noa', buildPartyUpdateHandler(SUPPLIER_RTBA));
app.delete('/api/suppliers/:noa', buildPartyDeleteHandler(SUPPLIER_RTBA));

// =============================================
// /api/packages  — list all DB packages
// /api/packages/:name — get full package source
// =============================================
app.get('/api/packages', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  try {
    const rows = await queryOn<{ OBJECT_NAME: string; OBJECT_TYPE: string; STATUS: string }>(
      user.schema,
      `SELECT object_name, object_type, status
         FROM user_objects
        WHERE object_type IN ('PACKAGE','PACKAGE BODY')
        ORDER BY object_name, object_type`,
      {},
    );
    return c.json({ ok: true, packages: rows });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

app.get('/api/packages/:name', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  const name = c.req.param('name').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  try {
    const rows = await queryOn<{ TYPE: string; LINE: number; TEXT: string }>(
      user.schema,
      `SELECT type, line, text
         FROM user_source
        WHERE name = :n
        ORDER BY type, line`,
      { n: name },
    );
    if (!rows.length) return c.json({ ok: false, error: 'not found' }, 404);
    // Group by type (PACKAGE spec vs PACKAGE BODY)
    const spec: string[] = [], body: string[] = [];
    for (const r of rows) {
      if (r.TYPE === 'PACKAGE') spec.push(r.TEXT);
      else body.push(r.TEXT);
    }
    return c.json({ ok: true, name, spec: spec.join(''), body: body.join('') });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

// =============================================
// /api/kb/:namee  — serve KB JSON for screens
// =============================================
const KB_DIR = 'D:/daty/_forms_kb';

app.get('/api/kb/:namee', (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false }, 401);
  const namee = c.req.param('namee').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const kbPath = KB_DIR + '/' + namee + '.json';
  if (!existsSync(kbPath)) return c.json({ ok: false, error: 'not found' }, 404);
  try {
    const kb = JSON.parse(rfs(kbPath, 'utf8') as string);
    return c.json({ ok: true, kb });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});

// =============================================
// /api/legacy-report/:screen/print
// Safe browser-print bridge for old Oracle Reports metadata.
// =============================================
const LEGACY_CATALOG_DIR = 'D:/daty/_legacy_source_catalog_20260424_full/screens';
const LEGACY_REP_DIR = 'D:/daty/rep';

type LegacyCatalogMeta = {
  name?: string;
  relativePath?: string;
  dependencies?: {
    tables?: string[];
    calledForms?: string[];
    calledReports?: string[];
    dbRoutines?: string[];
    lovs?: string[];
  };
};

const LEGACY_REPORT_PARAM_LABELS: Record<string, string> = {
  accountFrom: 'من حساب',
  accountTo: 'إلى حساب',
  dateFrom: 'من تاريخ',
  dateTo: 'إلى تاريخ',
  costCenter: 'مركز التكلفة',
  currency: 'العملة',
  documentNo: 'رقم السند/القيد',
  memo: 'البيان يحتوي',
  minAmount: 'من مبلغ',
  maxAmount: 'إلى مبلغ',
  year: 'السنة',
  rankFrom: 'من رتبة',
  rankTo: 'إلى رتبة',
  tn: 'الحساب الرئيسي',
  nox: 'الرتبة',
  G1: 'من مجموعة',
  G2: 'إلى مجموعة',
};

function legacyReportFilters(deps: LegacyCatalogMeta['dependencies'] = {}) {
  const tables = new Set((deps.tables ?? []).map((table) => table.toUpperCase()));
  const lovs = new Set((deps.lovs ?? []).map((lov) => lov.toUpperCase()));
  const routines = new Set((deps.dbRoutines ?? []).map((routine) => routine.toUpperCase()));
  const reports = (deps.calledReports ?? []).map((report) => report.toUpperCase());
  const filters: { key: string; label: string; type: 'text' | 'number' | 'date'; placeholder?: string }[] = [];
  const add = (filter: { key: string; label: string; type: 'text' | 'number' | 'date'; placeholder?: string }) => {
    if (!filters.some((item) => item.key === filter.key)) filters.push(filter);
  };

  const hasAccounts = tables.has('DATA_AC') || lovs.has('NA2') || lovs.has('NAM');
  if (hasAccounts) {
    add({ key: 'accountFrom', label: LEGACY_REPORT_PARAM_LABELS['accountFrom'], type: 'text', placeholder: 'رقم الحساب' });
    add({ key: 'accountTo', label: LEGACY_REPORT_PARAM_LABELS['accountTo'], type: 'text', placeholder: 'رقم الحساب' });
  }

  const hasJournalOrVoucher = ['SNDKD', 'SNDKD2', 'SNDK', 'SNDS'].some((table) => tables.has(table) || reports.includes(table));
  const hasPeriodData = ['DATAK', 'DATAKMZ', 'HMH', 'HMHALL', 'AMHSB'].some((table) => tables.has(table));
  if (hasJournalOrVoucher || hasPeriodData || reports.length > 0) {
    add({ key: 'dateFrom', label: LEGACY_REPORT_PARAM_LABELS['dateFrom'], type: 'date' });
    add({ key: 'dateTo', label: LEGACY_REPORT_PARAM_LABELS['dateTo'], type: 'date' });
  }

  if (tables.has('MRT') || lovs.has('MRT') || lovs.has('MRT2') || routines.has('NAME_MRT')) {
    add({ key: 'costCenter', label: LEGACY_REPORT_PARAM_LABELS['costCenter'], type: 'text', placeholder: 'رقم المركز' });
  }

  if (tables.has('AMLH') || routines.has('CAMLH')) {
    add({ key: 'currency', label: LEGACY_REPORT_PARAM_LABELS['currency'], type: 'number', placeholder: 'رقم العملة' });
  }

  if (hasJournalOrVoucher) add({ key: 'documentNo', label: LEGACY_REPORT_PARAM_LABELS['documentNo'], type: 'number' });
  if (tables.has('YEAR')) add({ key: 'year', label: LEGACY_REPORT_PARAM_LABELS['year'], type: 'number', placeholder: 'السنة المالية' });
  if (reports.length > 0 || tables.has('TYPEMS')) add({ key: 'memo', label: LEGACY_REPORT_PARAM_LABELS['memo'], type: 'text' });

  return filters;
}

function htmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function legacyReportParams(url: string): Record<string, string> {
  const params = new URL(url).searchParams;
  const out: Record<string, string> = {};
  for (const key of Object.keys(LEGACY_REPORT_PARAM_LABELS)) {
    const value = String(params.get(key) || '').trim();
    if (value) out[key] = value;
  }
  return out;
}

app.get('/api/legacy-coverage/:tsys', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: 'no session' }, 401);

  const tsys = Number(c.req.param('tsys') || '1') || 1;
  try {
    const rows = await queryOn<{
      NOA: number;
      TYPEA: number | null;
      NAMEA: string | null;
      NAMEE: string | null;
      NAMEF: string | null;
      RTBA: number | null;
    }>(
      user.schema,
      `SELECT d.noa, d.typea, d.namea, d.namee, d.namef, d.rtba
         FROM data_acm d
        WHERE NVL(d.rtba, 0) <= 5
          AND (NVL(d.tsys, 0) = :t OR NVL(INSTR(d.noab, TO_CHAR(:t)), 0) > 0)
          AND (
            d.noa IN (SELECT nopr FROM usergn WHERE nou = :nou)
            OR :isAdmin > 0
            OR d.namef IS NULL
            OR UPPER(d.namef) IN ('USER.FMX', 'MEMO.FMX')
          )
        ORDER BY d.noa`,
      { t: tsys, nou: user.nou, isAdmin: user.isAdmin ? 1 : 0 },
    );

    const launchable = rows
      .map((row) => {
        const rawNamee = String(row.NAMEE || '').trim().toUpperCase();
        const rawNamef = String(row.NAMEF || '').trim().toUpperCase();
        const code = (rawNamee || rawNamef.replace(/\.(FMX|FMB)$/i, '')).replace(/[^A-Z0-9_]/g, '');
        return {
          noa: Number(row.NOA || 0),
          typea: Number(row.TYPEA || 0),
          namea: String(row.NAMEA || ''),
          code,
          namef: rawNamef,
          rtba: Number(row.RTBA || 0),
        };
      })
      .filter((row) => !!row.code && row.code !== 'TRMENU');

    const screens = launchable.map((row) => {
      const catalogPath = `${LEGACY_CATALOG_DIR}/${row.code}/screen.json`;
      const kbPath = `${KB_DIR}/${row.code}.json`;
      let catalog: {
        relativePath?: string;
        dependencies?: {
          tables?: string[];
          calledForms?: string[];
          calledReports?: string[];
          dbRoutines?: string[];
          lovs?: string[];
        };
      } | null = null;

      if (existsSync(catalogPath)) {
        try {
          catalog = JSON.parse(rfs(catalogPath, 'utf8') as string);
        } catch {
          catalog = null;
        }
      }

      const deps = catalog?.dependencies ?? {};
      return {
        ...row,
        hasCatalog: !!catalog,
        hasKb: existsSync(kbPath),
        sourcePath: catalog?.relativePath ?? '',
        tables: deps.tables ?? [],
        reports: deps.calledReports ?? [],
        calledForms: deps.calledForms ?? [],
        dbRoutines: deps.dbRoutines ?? [],
        lovs: deps.lovs ?? [],
      };
    });

    return c.json({
      ok: true,
      tsys,
      schema: user.schema,
      totalMenuRows: rows.length,
      totalScreens: screens.length,
      withCatalog: screens.filter((screen) => screen.hasCatalog).length,
      withKb: screens.filter((screen) => screen.hasKb).length,
      withReports: screens.filter((screen) => screen.reports.length > 0).length,
      withCalledForms: screens.filter((screen) => screen.calledForms.length > 0).length,
      missingCatalog: screens.filter((screen) => !screen.hasCatalog).map((screen) => screen.code),
      missingKb: screens.filter((screen) => !screen.hasKb).map((screen) => screen.code),
      screens,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, error: message }, 500);
  }
});

app.get('/api/legacy-report/:screen/meta', async (c) => {
  const user = readUser(c);
  if (!user) return c.json({ ok: false, error: 'no session' }, 401);

  const screen = c.req.param('screen').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const catalogPath = `${LEGACY_CATALOG_DIR}/${screen}/screen.json`;
  if (!screen || !existsSync(catalogPath)) {
    return c.json({ ok: false, error: 'تعريف الشاشة غير موجود' }, 404);
  }

  try {
    const meta = JSON.parse(rfs(catalogPath, 'utf8') as string) as LegacyCatalogMeta;
    const deps = meta.dependencies ?? {};
    const reports = (deps.calledReports ?? []).map((report) => {
      const reportCode = String(report).toUpperCase();
      const candidates = [
        `${LEGACY_REP_DIR}/${reportCode}.RDF`,
        `${LEGACY_REP_DIR}/${reportCode.toLowerCase()}.rdf`,
        `${LEGACY_REP_DIR}/${reportCode}.rep`,
      ];
      return {
        code: reportCode,
        exists: candidates.some((candidate) => existsSync(candidate)),
        file: candidates.find((candidate) => existsSync(candidate)) ?? '',
      };
    });

    return c.json({
      ok: true,
      screen,
      sourcePath: meta.relativePath ?? '',
      reports,
      filters: legacyReportFilters(deps),
      tables: deps.tables ?? [],
      calledForms: deps.calledForms ?? [],
      lovs: deps.lovs ?? [],
      dbRoutines: deps.dbRoutines ?? [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, error: message }, 500);
  }
});

app.get('/api/legacy-report/:screen/print', async (c) => {
  const user = readUser(c);
  if (!user) return c.text('غير مصرح - يجب تسجيل الدخول', 401);

  const screen = c.req.param('screen').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const report = String(c.req.query('report') || '').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  if (!screen || !report) return c.text('screen/report مطلوب', 400);

  const catalogPath = `${LEGACY_CATALOG_DIR}/${screen}/screen.json`;
  if (!existsSync(catalogPath)) return c.text('تعريف الشاشة غير موجود', 404);

  try {
    const meta = JSON.parse(rfs(catalogPath, 'utf8') as string) as LegacyCatalogMeta;
    const deps = meta.dependencies ?? {};
    const reports = (deps.calledReports ?? []).map((x) => String(x).toUpperCase());
    if (!reports.includes(report)) return c.text('التقرير غير مسجل ضمن تبعيات الشاشة القديمة', 400);

    const rdfPath = `${LEGACY_REP_DIR}/${report}.RDF`;
    const rdfPathLower = `${LEGACY_REP_DIR}/${report.toLowerCase()}.rdf`;
    const repPath = `${LEGACY_REP_DIR}/${report}.rep`;
    const repFile = existsSync(rdfPath)
      ? rdfPath
      : existsSync(rdfPathLower)
        ? rdfPathLower
        : existsSync(repPath)
          ? repPath
          : '';

    const list = (items: string[] | undefined) => (items ?? []).length
      ? `<ul>${(items ?? []).map((x) => `<li>${htmlEscape(x)}</li>`).join('')}</ul>`
      : '<div class="empty">لا يوجد</div>';
    const runParams = legacyReportParams(c.req.url);
    const runParamsHtml = Object.keys(runParams).length
      ? `<div class="params">${Object.entries(runParams).map(([key, value]) => `
          <span>${htmlEscape(LEGACY_REPORT_PARAM_LABELS[key] ?? key)}</span>
          <div>${htmlEscape(value)}</div>
        `).join('')}</div>`
      : '<div class="empty">لم يتم تحديد معايير تشغيل إضافية</div>';

    const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${htmlEscape(screen)} - ${htmlEscape(report)}</title>
  <style>
    body { font-family: Tahoma, Arial, sans-serif; background:#fff; color:#111; margin:0; padding:18px; }
    .page { border:1px solid #7890aa; padding:14px; }
    h1 { margin:0 0 8px; text-align:center; color:#0038af; font-size:22px; }
    h2 { margin:14px 0 6px; color:#0038af; font-size:15px; border-bottom:1px solid #9cb0c4; padding-bottom:4px; }
    .meta, .params { display:grid; grid-template-columns: 140px 1fr; gap:6px 10px; margin-top:12px; }
    .meta span, .params span { font-weight:700; color:#00306f; }
    .meta div, .params div { border:1px solid #a8b6c5; min-height:24px; line-height:24px; padding:0 8px; background:#eef4fa; }
    ul { margin:0; padding:0 20px; columns:2; }
    li { margin:3px 0; }
    .empty { color:#666; border:1px solid #ddd; padding:8px; background:#fafafa; }
    .note { margin-top:14px; border:1px dashed #999; padding:10px; background:#fffceb; color:#5c4200; }
    .actions { text-align:center; margin-top:16px; }
    button { padding:8px 24px; font-size:15px; cursor:pointer; }
    @media print { .actions { display:none; } body { padding:0; } .page { border:0; } }
  </style>
</head>
<body>
  <div class="page">
    <h1>معاينة تقرير النظام القديم</h1>
    <div class="meta">
      <span>الشاشة</span><div>${htmlEscape(screen)}</div>
      <span>التقرير</span><div>${htmlEscape(report)}</div>
      <span>ملف التقرير</span><div>${htmlEscape(repFile || 'غير موجود في D:/daty/rep')}</div>
      <span>المصدر</span><div>${htmlEscape(meta.relativePath ?? '')}</div>
      <span>المستخدم</span><div>${htmlEscape(user.name)}</div>
      <span>السنة</span><div>${htmlEscape(user.year ?? '')}</div>
    </div>
    <h2>معايير التشغيل</h2>
    ${runParamsHtml}
    <h2>الجداول المستخدمة</h2>
    ${list(deps.tables)}
    <h2>الشاشات المرتبطة</h2>
    ${list(deps.calledForms)}
    <h2>LOV / Packages</h2>
    ${list([...(deps.lovs ?? []), ...(deps.dbRoutines ?? [])])}
    <div class="note">
      هذه الصفحة جسر طباعة آمن داخل النظام الجديد مبني من تبعيات Oracle Forms/Reports القديمة.
      التنفيذ التفصيلي لنفس تصميم كل تقرير يتم اعتماده تقريرًا تقريرًا ضمن بوابة المطابقة.
    </div>
    <div class="actions"><button onclick="window.print()">طباعة</button></div>
  </div>
</body>
</html>`;

    return c.html(html);
  } catch (e) {
    return c.text(e instanceof Error ? e.message : String(e), 500);
  }
});

// =============================================
// /test-reports/latest
// Browser-visible bridge for exported local test reports.
// =============================================
const TEST_REPORT_EXPORT_DIR = 'D:/daty/app-ng/reports';

function latestTestReport(ext: '.html' | '.json'): string {
  if (!existsSync(TEST_REPORT_EXPORT_DIR)) return '';

  const files = readdirSync(TEST_REPORT_EXPORT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(ext))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));

  const final = files.find((name) => name.includes('-final.'));
  return final ? `${TEST_REPORT_EXPORT_DIR}/${final}` : files[0] ? `${TEST_REPORT_EXPORT_DIR}/${files[0]}` : '';
}

function testReportResponse(filePath: string, ext: '.html' | '.json') {
  const content = rfs(filePath, 'utf8') as string;
  return new Response(content, {
    headers: {
      'Content-Type': ext === '.html' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

app.get('/test-reports/latest', (c) => {
  const report = latestTestReport('.html');
  if (!report) return c.text('No exported HTML test report found.', 404);
  return testReportResponse(report, '.html');
});

app.get('/test-reports/latest.json', (c) => {
  const htmlReport = latestTestReport('.html');
  const jsonFromHtml = htmlReport ? htmlReport.replace(/\.html$/i, '.json') : '';
  const report = jsonFromHtml && existsSync(jsonFromHtml) ? jsonFromHtml : latestTestReport('.json');
  if (!report) return c.text('No exported JSON test report found.', 404);
  return testReportResponse(report, '.json');
});

app.get('/test-reports/:file', (c) => {
  const requested = basename(c.req.param('file'));
  const ext = requested.endsWith('.html') ? '.html' : requested.endsWith('.json') ? '.json' : '';
  if (!ext || requested !== c.req.param('file')) return c.text('Invalid report file.', 400);

  const report = `${TEST_REPORT_EXPORT_DIR}/${requested}`;
  if (!existsSync(report)) return c.text('Report file not found.', 404);
  return testReportResponse(report, ext);
});

// =============================================
// Static files from /browser output. We intentionally avoid `index` fallback here,
// because Angular SSR handles HTML routes and static middleware should only serve assets.
if (existsSync(browserDistFolder)) {
  app.use(
    '*',
    serveStatic({
      root: browserDistFolder,
      rewriteRequestPath: (path) => path.replace(/^\/+/, ''),
    }),
  );
}

// Fallback to Angular SSR for routes that are not static files and not API.
app.all('*', async (c) => {
  if (c.req.path.startsWith('/api/')) return c.notFound();
  const response = await angularApp.handle(c.req.raw);
  return response ?? c.notFound();
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  serve({
    fetch: app.fetch,
    port: Number(port),
  }, () => {
    console.log(`Node Hono server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(async (req, res, next) => {
  try {
    const webRes = await app.fetch(createWebRequestFromNodeRequest(req));
    if (webRes) {
      await writeResponseToNodeResponse(webRes, res);
    } else {
      next();
    }
  } catch (error) {
    next(error);
  }
});
