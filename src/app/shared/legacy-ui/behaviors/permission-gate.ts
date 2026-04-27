import { LegacyPermissionKey, LegacyPermissionModel } from '../contracts/legacy-contracts';

const ALIASES: Record<LegacyPermissionKey, string[]> = {
  ins: ['ins'],
  ed: ['ed'],
  de: ['de'],
  pr: ['pr'],
  sar: ['sar'],
  post: ['post', 'ed'],
  unpost: ['unpost', 'ed'],
  exp: ['exp', 'pr'],
};

export function hasLegacyPermission(
  permissions: LegacyPermissionModel | null | undefined,
  key: LegacyPermissionKey | null | undefined,
): boolean {
  if (!key) return true;
  const model = permissions ?? {};
  const aliases = ALIASES[key] ?? [key];
  return aliases.some((alias) => (model[alias] ?? 0) > 0);
}
