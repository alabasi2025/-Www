/**
 * Canonical Arabic messages catalog.
 *
 * Centralizes the Arabic error/warning strings that were previously sprinkled
 * across the Oracle Forms PL/SQL (e.g. `ms('لا يمكن تعديل...')`). Keeping them
 * here lets us:
 *   - Guarantee spelling/wording consistency
 *   - Localize once if we ever need English/Urdu
 *   - Search for a message ID instead of grepping for Arabic substrings
 *
 * Usage (backend):
 *   import { M, msg } from './messages';
 *   if (mrhl === 0) return c.json({ ok: false, error: M.POSTED_NO_EDIT }, 422);
 *   if (dup)       return c.json({ ok: false, error: msg('DUPLICATE_VOUCHER_NO', { noms: 1234 }) }, 422);
 */

// ── Message IDs grouped by domain ──────────────────────────
export const M = {
  // Authentication / session
  AUTH_REQUIRED:        'يجب تسجيل الدخول أولاً',
  AUTH_INVALID:         'اسم المستخدم أو كلمة المرور غير صحيحة',
  AUTH_EXPIRED:         'انتهت صلاحية الجلسة، يرجى تسجيل الدخول من جديد',

  // Permissions
  PERM_DENIED_GENERIC:  'صلاحيتك لا تسمح بتنفيذ هذا الإجراء',
  PERM_DENIED_INS:      'صلاحيتك لا تسمح بإضافة سجل جديد',
  PERM_DENIED_ED:       'صلاحيتك لا تسمح بتعديل السجل',
  PERM_DENIED_DE:       'صلاحيتك لا تسمح بحذف السجل',
  PERM_DENIED_PR:       'صلاحيتك لا تسمح بالطباعة',

  // Posted records in legacy forms display as MRHL = 0.
  POSTED_NO_EDIT:       'لا يمكن تعديل مستند مرحل، يجب الغاء الترحيل اولا',
  POSTED_NO_DELETE:     'لا يمكن حذف مستند مرحل، يجب الغاء الترحيل اولا',

  // Dates
  DATE_REQUIRED:        'يجب إدخال التاريخ',
  DATE_INVALID:         'التاريخ غير صحيح',
  DATE_IN_FUTURE:       'التاريخ المدخل اكبر من تاريخ الجهاز',
  DATE_MONTH_CLOSED:    'هذا الشهر مقفل محاسبياً ولا يمكن إدخال حركات فيه',
  DATE_HOLIDAY:         'هذا التاريخ يقع في إجازة — هل أنت متأكد؟',

  // Voucher numbers / uniqueness
  DUPLICATE_VOUCHER_NO: 'رقم السند المدخل مقيد من قبل',
  MISSING_VOUCHER_NO:   'يجب إدخال رقم السند',

  // Accounts
  ACCOUNT_NOT_FOUND:    'الحساب غير موجود في دليل الحسابات',
  ACCOUNT_INACTIVE:     'الحساب موقوف ولا يمكن استخدامه',
  ACCOUNT_FROZEN:       'الحساب مجمّد ولا يمكن التعامل معه',
  ACCOUNT_NOT_LEAF:     'لا يمكن الحركة على حساب رئيسي، استخدم حساب فرعي',
  ACCOUNT_CURRENCY_NOT_ALLOWED: 'العملة المختارة غير مسموحة لهذا الحساب',

  // Currency / rates
  CURRENCY_RATE_REQUIRED: 'يجب إدخال سعر الصرف',
  CURRENCY_RATE_TOO_LOW:  'سعر الصرف أقل من الحد الأدنى المسموح',
  CURRENCY_RATE_TOO_HIGH: 'سعر الصرف أعلى من الحد الأقصى المسموح',
  CURRENCY_RATE_ZERO:     'لا يمكن أن يكون سعر الصرف صفراً',

  // Amounts
  AMOUNT_REQUIRED:      'يجب إدخال المبلغ',
  AMOUNT_ZERO:          'لا يمكن أن يكون المبلغ صفراً',
  AMOUNT_NEGATIVE:      'لا يمكن أن يكون المبلغ سالباً',
  AMOUNT_MISMATCH:      'مجموع التفاصيل لا يطابق مبلغ الرأس',
  DEBIT_CREDIT_MISMATCH: 'مجموع المدين لا يساوي مجموع الدائن',

  // Closures
  AKFA_CLOSED:          'لقد تم اقفال فوارق العملة حتى هذا التاريخ — لا يمكن التعديل',

  // Generic CRUD success
  SAVED_SUCCESS:        'تم الحفظ بنجاح',
  DELETED_SUCCESS:      'تم الحذف بنجاح',
  POSTED_SUCCESS:       'تم الترحيل بنجاح',
  UNPOSTED_SUCCESS:     'تم إلغاء الترحيل',

  // Not found / validation
  RECORD_NOT_FOUND:     'السجل غير موجود',
  VALIDATION_FAILED:    'فشل التحقق من البيانات',

  // Internal / unexpected
  INTERNAL_ERROR:       'حدث خطأ داخلي، يرجى المحاولة لاحقاً',
  DB_ERROR:             'فشل الاتصال بقاعدة البيانات',
} as const;

export type MessageId = keyof typeof M;

/**
 * Interpolates `{placeholder}` tokens in a message template.
 * Use this when you need to include dynamic values (e.g. dates, ids).
 *
 * ```ts
 * msg('AKFA_CLOSED_UNTIL', { date: '2026-04-15' })
 *   // → "لقد تم اقفال فوارق العملة حتى تاريخ 2026-04-15 — لا يمكن التعديل"
 * ```
 */
export function msg(id: MessageId, params: Record<string, string | number> = {}): string {
  const template = M[id];
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = params[key];
    return v === undefined ? `{${key}}` : String(v);
  });
}

/**
 * Narrow a permission action name to the matching PERM_DENIED_* message.
 * Preserves backwards compatibility with {@link ensurePermission}.
 */
export function permDeniedMessage(action: 'ins' | 'ed' | 'de' | 'pr'): string {
  switch (action) {
    case 'ins': return M.PERM_DENIED_INS;
    case 'ed':  return M.PERM_DENIED_ED;
    case 'de':  return M.PERM_DENIED_DE;
    case 'pr':  return M.PERM_DENIED_PR;
  }
}
