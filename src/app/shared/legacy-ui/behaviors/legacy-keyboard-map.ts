import { LegacyShortcutKey } from '../contracts/legacy-contracts';

export type LegacyShortcutAction =
  | 'props'
  | 'search'
  | 'refresh'
  | 'print'
  | 'cancel'
  | 'edit'
  | 'save'
  | 'exit';

const KEY_TO_ACTION: Record<LegacyShortcutKey, LegacyShortcutAction> = {
  F2: 'props',
  F3: 'search',
  F4: 'refresh',
  F6: 'print',
  F7: 'cancel',
  F8: 'edit',
  F10: 'save',
  Escape: 'exit',
};

const DEFAULT_ALLOWED_IN_INPUT: Record<LegacyShortcutAction, boolean> = {
  props: true,
  search: true,
  refresh: false,
  print: false,
  cancel: true,
  edit: false,
  save: true,
  exit: false,
};

export interface LegacyShortcutResolveOptions {
  allowWhenInput?: Partial<Record<LegacyShortcutAction, boolean>>;
}

export function resolveLegacyShortcut(
  event: KeyboardEvent,
  options?: LegacyShortcutResolveOptions,
): LegacyShortcutAction | null {
  const key = normalizeShortcutKey(event.key);
  if (!key) return null;

  const action = KEY_TO_ACTION[key];
  const inInput = isInputTarget(event.target);
  const allowMap = { ...DEFAULT_ALLOWED_IN_INPUT, ...(options?.allowWhenInput ?? {}) };
  if (inInput && !allowMap[action]) return null;

  return action;
}

function normalizeShortcutKey(key: string): LegacyShortcutKey | null {
  if (key === 'Escape') return 'Escape';
  if (key === 'F2') return 'F2';
  if (key === 'F3') return 'F3';
  if (key === 'F4') return 'F4';
  if (key === 'F6') return 'F6';
  if (key === 'F7') return 'F7';
  if (key === 'F8') return 'F8';
  if (key === 'F10') return 'F10';
  return null;
}

function isInputTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
}
