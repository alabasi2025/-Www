import {
  LegacyToolbarAction,
  LegacyToolbarActionId,
  LegacyToolbarContext,
} from '../contracts/legacy-contracts';

function editable(ctx: LegacyToolbarContext): boolean {
  return ctx.mode === 'new' || ctx.mode === 'edit';
}

const ICON_BASE = '/legacy-icons';

export const LEGACY_TOOLBAR_ACTION_MANIFEST: Record<LegacyToolbarActionId, LegacyToolbarAction> = {
  new: {
    id: 'new',
    label: 'جديد',
    iconAsset: `${ICON_BASE}/n.ico`,
    shortcut: 'F4',
    permissionKey: 'ins',
    enabledRule: (ctx) => !editable(ctx) && !ctx.saving,
  },
  save: {
    id: 'save',
    label: 'حفظ',
    iconAsset: `${ICON_BASE}/s.ico`,
    shortcut: 'F10',
    enabledRule: (ctx) => editable(ctx) && !ctx.saving,
  },
  edit: {
    id: 'edit',
    label: 'تعديل',
    iconAsset: `${ICON_BASE}/e.ico`,
    shortcut: 'F8',
    permissionKey: 'ed',
    enabledRule: (ctx) => !editable(ctx) && ctx.hasCurrent && !ctx.posted && !ctx.saving,
  },
  delete: {
    id: 'delete',
    label: 'حذف',
    iconAsset: `${ICON_BASE}/d.ico`,
    permissionKey: 'de',
    enabledRule: (ctx) => !editable(ctx) && ctx.hasCurrent && !ctx.posted && !ctx.saving,
  },
  search: {
    id: 'search',
    label: 'بحث',
    iconAsset: `${ICON_BASE}/sa.ico`,
    shortcut: 'F3',
    enabledRule: (ctx) => !ctx.saving,
  },
  print: {
    id: 'print',
    label: 'طباعة',
    iconAsset: `${ICON_BASE}/pr.ico`,
    shortcut: 'F6',
    permissionKey: 'pr',
    enabledRule: (ctx) => ctx.hasCurrent && !editable(ctx) && !ctx.saving,
  },
  exit: {
    id: 'exit',
    label: 'خروج',
    iconAsset: `${ICON_BASE}/in.ico`,
    shortcut: 'Escape',
    enabledRule: (ctx) => !ctx.saving,
  },
  refresh: {
    id: 'refresh',
    label: 'تحديث',
    iconAsset: `${ICON_BASE}/nn.png`,
    shortcut: 'F4',
    enabledRule: (ctx) => !ctx.saving,
  },
  cancel: {
    id: 'cancel',
    label: 'تراجع',
    iconAsset: `${ICON_BASE}/z.ico`,
    shortcut: 'F7',
    enabledRule: (ctx) => editable(ctx) && !ctx.saving,
  },
  post: {
    id: 'post',
    label: 'ترحيل',
    iconAsset: `${ICON_BASE}/sar.ico`,
    permissionKey: 'post',
    enabledRule: (ctx) => ctx.hasCurrent && !editable(ctx) && !ctx.posted && !ctx.saving,
  },
  unpost: {
    id: 'unpost',
    label: 'إلغاء الترحيل',
    iconAsset: `${ICON_BASE}/u.ico`,
    permissionKey: 'unpost',
    enabledRule: (ctx) => ctx.hasCurrent && !editable(ctx) && ctx.posted && !ctx.saving,
  },
  export: {
    id: 'export',
    label: 'تصدير',
    iconAsset: `${ICON_BASE}/excel.ico`,
    permissionKey: 'exp',
    enabledRule: (ctx) => !ctx.saving,
  },
  report: {
    id: 'report',
    label: 'تقارير',
    iconAsset: `${ICON_BASE}/print.ico`,
    permissionKey: 'pr',
    enabledRule: (ctx) => !ctx.saving,
  },
  'add-line': {
    id: 'add-line',
    label: 'إضافة سطر',
    iconAsset: `${ICON_BASE}/a.ico`,
    enabledRule: (ctx) => editable(ctx) && !ctx.saving,
  },
  props: {
    id: 'props',
    label: 'خصائص',
    iconAsset: `${ICON_BASE}/k.ico`,
    shortcut: 'F2',
    enabledRule: (ctx) => ctx.hasCurrent && !ctx.saving,
  },
};
