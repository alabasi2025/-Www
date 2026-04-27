import { queryOn, unitToSchema } from './db';

export interface SessionUser {
  nou: number;
  name: string;
  statu: number;
  isAdmin: boolean;
  tklf: number | null;
  kshr: number | null;
  mrt: number | null;
  mrtall: number | null;
  noah: number | null;
  usx: number | null;
  unit: string;
  schema: string;
  machine?: string;
  year?: string;
  entryYear?: string;
  loginAt: string;
}

interface DbUserRow {
  NOU: number | null;
  NAMEU: string | null;
  STATU: number | null;
  TKLF: number | null;
  KSHR: number | null;
  MRT: number | null;
  MRTALL: number | null;
  NOAH: number | null;
  USX: number | null;
}

export interface AuthInput {
  unit: string;
  userId?: unknown;
  password: string;
}

export interface AuthResult {
  ok: boolean;
  user?: SessionUser;
  error?: string;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function authenticate(input: AuthInput): Promise<AuthResult> {
  const unit = String(input.unit || '').toUpperCase();
  const schema = unitToSchema(unit);
  const nou = toNumber(input.userId);

  try {
    let rows: DbUserRow[];
    if (nou !== null) {
      rows = await queryOn<DbUserRow>(
        schema,
        `SELECT NVL(statu,0) AS statu, nameu, tklf, kshr, mrt, NVL(mrtall,0) AS mrtall, noah, nou, usx
           FROM user_u
          WHERE pass = :p AND nou = :n`,
        { p: input.password, n: nou },
      );
    } else {
      rows = await queryOn<DbUserRow>(
        schema,
        `SELECT NVL(statu,0) AS statu, nameu, tklf, kshr, mrt, NVL(mrtall,0) AS mrtall, noah, nou, usx
           FROM user_u
          WHERE pass = :p`,
        { p: input.password },
      );
    }

    const row = rows[0];
    if (!row || row.NOU === null) {
      return { ok: false, error: 'كلمة المرور غير صحيحة' };
    }

    const user: SessionUser = {
      nou: row.NOU,
      name: String(row.NAMEU || ''),
      statu: Number(row.STATU || 0),
      isAdmin: Number(row.STATU || 0) > 0,
      tklf: row.TKLF ?? null,
      kshr: row.KSHR ?? null,
      mrt: row.MRT ?? null,
      mrtall: row.MRTALL ?? null,
      noah: row.NOAH ?? null,
      usx: row.USX ?? null,
      unit,
      schema,
      loginAt: new Date().toISOString(),
    };

    return { ok: true, user };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}
