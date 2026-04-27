import fs from 'node:fs';
import { createRequire } from 'node:module';
import type * as OracleDb from 'oracledb';

const CLIENT_DIR = (process.env['ORACLE_CLIENT_DIR'] || '').trim();
const require = createRequire(import.meta.url);
const oracledb = require('oracledb') as typeof OracleDb;

declare global {
  // eslint-disable-next-line no-var
  var __ngOracleClientInit: boolean | undefined;
  // eslint-disable-next-line no-var
  var __ngOraclePools: Map<string, OracleDb.Pool> | undefined;
}

if (!globalThis.__ngOracleClientInit) {
  try {
    if (CLIENT_DIR && fs.existsSync(CLIENT_DIR)) {
      oracledb.initOracleClient({ libDir: CLIENT_DIR });
      console.log('[db] Oracle thick mode enabled.');
    } else {
      console.log('[db] Oracle thick mode skipped (ORACLE_CLIENT_DIR not configured or client not found).');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('__dirname is not defined')) {
      console.log('[db] Oracle client init warning:', message);
    }
  }
  globalThis.__ngOracleClientInit = true;
}

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

const pools = globalThis.__ngOraclePools ?? new Map<string, OracleDb.Pool>();
globalThis.__ngOraclePools = pools;

export function unitToSchema(unit?: string | null): string {
  if (!unit) return 'DATAALA';
  return 'DATAAL' + String(unit).toUpperCase();
}

function oracleEnvName(schema: string, suffix: 'USER' | 'PASSWORD'): string {
  return `ORACLE_${schema.replace(/[^A-Z0-9_]/g, '_')}_${suffix}`;
}

function oracleCredentials(schema: string): { user: string; password: string; connectString: string } {
  const connectString = (process.env['ORACLE_CONNECT_STRING'] || '').trim();
  if (!connectString) {
    throw new Error('ORACLE_CONNECT_STRING is required');
  }

  const userKey = oracleEnvName(schema, 'USER');
  const passKey = oracleEnvName(schema, 'PASSWORD');
  const user = (process.env[userKey] || process.env['ORACLE_USER'] || schema.toLowerCase()).trim();
  const password = (process.env[passKey] || process.env['ORACLE_PASSWORD'] || '').trim();
  if (!password) {
    throw new Error(`${passKey} or ORACLE_PASSWORD is required`);
  }

  return { user, password, connectString };
}

export async function getPool(schema: string): Promise<OracleDb.Pool> {
  const key = String(schema).toUpperCase();
  const existing = pools.get(key);
  if (existing) return existing;
  const credentials = oracleCredentials(key);

  const pool = await oracledb.createPool({
    user: credentials.user,
    password: credentials.password,
    connectString: credentials.connectString,
    poolMin: 0,
    poolMax: 6,
    poolIncrement: 1,
    poolTimeout: 60,
  });
  pools.set(key, pool);
  return pool;
}

export async function queryOn<T = Record<string, unknown>>(
  schema: string,
  sql: string,
  binds: Record<string, unknown> | unknown[] = {},
  options: OracleDb.ExecuteOptions = {},
): Promise<T[]> {
  const pool = await getPool(schema);
  const conn = await pool.getConnection();
  try {
    const result = await conn.execute<T>(sql, binds as OracleDb.BindParameters, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      ...options,
    });
    return (result.rows ?? []) as T[];
  } finally {
    await conn.close();
  }
}
