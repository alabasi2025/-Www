/**
 * Audit helpers — shared across all main-entity endpoints.
 *
 * Matches Oracle Forms audit pattern used throughout the original system:
 *
 *   On INSERT:
 *     DI    = sysdate           (date inserted)
 *     NOUSX = current user NO   (USER_U.NOU)
 *     PCI   = inserting machine (max 30 chars)
 *     NED   = 0                 (edit counter — increments on every UPDATE)
 *
 *   On UPDATE:
 *     DE     = sysdate
 *     NOUSXU = current user NO
 *     PCE    = editing machine
 *     NED    = NED + 1          (NOTE: caller must append `ned = NVL(ned,0) + 1`
 *                                 to the SET clause — NED is NOT returned here
 *                                 so the SQL expression can be used directly)
 */

import type { SessionUser } from './auth';

/**
 * Web-client identifier stored in PCI/PCE.
 * Original Oracle Forms stored machine hostname (max 30 chars).
 * In the web version we use "WEB-<unit>" to preserve unit info.
 */
export function clientTag(user: SessionUser): string {
  return ('WEB-' + (user.unit || '?')).slice(0, 30);
}

/** Returns the audit bind fields to merge into an INSERT statement. */
export function auditInsert(user: SessionUser): Record<string, unknown> {
  return {
    di:    new Date(),
    nousx: user.nou,
    pci:   clientTag(user),
    ned:   0,
  };
}

/**
 * Returns the scalar audit bind fields to merge into an UPDATE statement.
 * IMPORTANT: NED is intentionally NOT returned here — the calling SQL
 * MUST include `ned = NVL(ned,0) + 1` in the SET clause to preserve the
 * original increment semantics.
 */
export function auditUpdate(user: SessionUser): Record<string, unknown> {
  return {
    de:     new Date(),
    nousxu: user.nou,
    pce:    clientTag(user),
  };
}

/**
 * Convenience: SQL fragment to include in the SET clause for UPDATEs that
 * want the standard audit update behavior.
 *
 * Example:
 *   `UPDATE ${tbl} SET ${cols}, ${AUDIT_UPDATE_SET} WHERE ...`
 */
export const AUDIT_UPDATE_SET =
  'de = :de, nousxu = :nousxu, pce = :pce, ned = NVL(ned,0) + 1';

/**
 * Convenience: comma-separated audit column names for INSERT statements.
 * Matches the order returned by auditInsert().
 */
export const AUDIT_INSERT_COLS = 'di, nousx, pci, ned';
export const AUDIT_INSERT_VALS = ':di, :nousx, :pci, :ned';
