export interface LegacySystemScreen {
  noa: number;
  typea: number;
  rtba: number;
  namea: string;
  namee: string;
  namef: string;
}

export interface LegacySystemGroup {
  noa: number;
  typea: number;
  rtba: number;
  namea: string;
}

export interface LegacySystemSummary {
  tsys: number;
  label: string;
  totalRows: number;
  screenRows: number;
}

export const LEGACY_SYSTEM_LABELS: Record<number, string> = {
  1: 'النظام المحاسبي الشامل',
  2: 'إدارة المشاريع',
  3: 'إدارة التخليص الجمركي',
  4: 'إدارة المبيعات والمشتريات والمخزون',
  5: 'إدارة الفواتير والإرساليات والتسقيف',
  50: 'توقيف فواتير من النظام القديم',
  88: 'الحوالات المالية',
  99: 'تبويب جديد',
};

export const LEGACY_SYSTEM_1_GROUPS: LegacySystemGroup[] = [
  { noa: 1, typea: 0, rtba: 1, namea: 'عمليات النظام' },
  { noa: 2, typea: 0, rtba: 1, namea: 'تقارير النظام' },
  { noa: 3, typea: 0, rtba: 1, namea: 'إدارة النظام' },
  { noa: 4, typea: 0, rtba: 1, namea: 'إدارة قاعدة البيانات' },
  { noa: 5, typea: 0, rtba: 1, namea: 'نظام الرسائل' },
  { noa: 11, typea: 1, rtba: 2, namea: 'القيود اليومية' },
  { noa: 210, typea: 2, rtba: 2, namea: 'تقارير المستندات' },
  { noa: 211, typea: 2, rtba: 2, namea: 'تقارير دورية وختامية' },
];

export const LEGACY_SYSTEM_1_SCREENS: LegacySystemScreen[] = [
  { noa: 12, typea: 1, rtba: 2, namea: 'سندات القبض', namee: 'SNDK', namef: 'SNDK.FMX' },
  { noa: 13, typea: 1, rtba: 2, namea: 'سندات الصرف', namee: 'SNDS', namef: 'SNDS.FMX' },
  { noa: 21, typea: 2, rtba: 2, namea: 'كشف حساب فرعي', namee: 'REPKHALL', namef: 'REPKHALL.FMX' },
  { noa: 22, typea: 2, rtba: 2, namea: 'كشف حساب رئيسي', namee: 'REPKHR', namef: 'REPKHR.FMX' },
  { noa: 23, typea: 2, rtba: 2, namea: 'كشوفات أرصدة الحسابات', namee: 'REPKHHR', namef: 'REPKHHR.FMX' },
  { noa: 24, typea: 2, rtba: 2, namea: 'كشف حساب لحسابات متعددة', namee: 'REPKHALLR', namef: 'REPKHALLR.FMX' },
  { noa: 25, typea: 2, rtba: 2, namea: 'كشف حركة الصناديق', namee: 'REPSNDOK', namef: 'REPSNDOK.FMX' },
  { noa: 26, typea: 2, rtba: 2, namea: 'مصادقة الحسابات', namee: 'MSDKA', namef: 'MSDKA.FMX' },
  { noa: 31, typea: 3, rtba: 2, namea: 'دليل  الحسابات', namee: 'TREE', namef: 'TREE.FMX' },
  { noa: 32, typea: 3, rtba: 2, namea: 'بيانات العملاء', namee: 'DATA_AM', namef: 'DATA_AM.FMX' },
  { noa: 33, typea: 3, rtba: 2, namea: 'بيانات الموردين', namee: 'DATA_MO', namef: 'DATA_MO.FMX' },
  { noa: 34, typea: 3, rtba: 2, namea: 'بيانات المستخدمين', namee: 'USER', namef: 'USER.FMX' },
  { noa: 35, typea: 3, rtba: 2, namea: 'تهيئة العملات', namee: 'DATA_AML', namef: 'DATA_AML.FMX' },
  { noa: 36, typea: 3, rtba: 2, namea: 'الأرصدة الافتتاحية', namee: 'RSEDIF', namef: 'RSEDIF.FMX' },
  { noa: 37, typea: 3, rtba: 2, namea: 'إنشاء مراكز التكلفة', namee: 'MRT', namef: 'MRT.FMX' },
  { noa: 38, typea: 3, rtba: 2, namea: 'قائمة الاختصارات', namee: 'AHTSAR', namef: 'AHTSAR.FMX' },
  { noa: 41, typea: 4, rtba: 2, namea: 'إقفالات النظام', namee: 'AKFAL', namef: 'AKFAL.FMX' },
  { noa: 42, typea: 4, rtba: 2, namea: 'النسخ الاحتياطي', namee: 'COPY', namef: 'COPY.FMX' },
  { noa: 43, typea: 4, rtba: 2, namea: 'تقرير دخول وخروج المستخدمين', namee: 'INANOU', namef: 'INANOU.FMX' },
  { noa: 44, typea: 4, rtba: 2, namea: 'ترحيل وإلغاء ترحيل المستندات', namee: 'TRHL', namef: 'TRHL.FMX' },
  { noa: 45, typea: 4, rtba: 2, namea: 'الدعم الفني', namee: 'TEL', namef: 'TEL.FMX' },
  { noa: 46, typea: 4, rtba: 2, namea: 'تخصيص مفاتيح الشاشات', namee: 'KF', namef: 'KF.FMX' },
  { noa: 51, typea: 5, rtba: 2, namea: 'إرسال رسائل', namee: 'SMS', namef: 'SMS.FMX' },
  { noa: 52, typea: 5, rtba: 2, namea: 'إدخال أرقام التلفونات', namee: 'SMSN', namef: 'SMSN.FMX' },
  { noa: 53, typea: 5, rtba: 2, namea: 'تقرير الرسائل', namee: 'SYS_SMS', namef: 'SYS_SMS.FMX' },
  { noa: 54, typea: 5, rtba: 2, namea: 'مذكرة مواعيد', namee: 'MEMO', namef: 'MEMO.FMX' },
  { noa: 111, typea: 11, rtba: 2, namea: 'قيد يومية', namee: 'SNDKD', namef: 'SNDKD.FMX' },
  { noa: 112, typea: 11, rtba: 3, namea: 'قيد تحويل', namee: 'SNDKD2', namef: 'SNDKD2.FMX' },
  { noa: 113, typea: 11, rtba: 3, namea: 'قيد إقفال فوارق عملة', namee: 'AKFA', namef: 'AKFA.FMX' },
  { noa: 313, typea: 3, rtba: 2, namea: 'إعدادات أساسية', namee: 'SYSALL', namef: 'SYSALL.FMX' },
  { noa: 2101, typea: 210, rtba: 3, namea: 'تقارير سندات القبض', namee: 'REPSK', namef: 'REPSK.FMX' },
  { noa: 2102, typea: 210, rtba: 3, namea: 'تقارير سندات الصرف', namee: 'REPSS', namef: 'REPSS.FMX' },
  { noa: 2103, typea: 210, rtba: 3, namea: 'تقرير القيود اليومية', namee: 'REPKD', namef: 'REPKD.FMX' },
  { noa: 2104, typea: 210, rtba: 3, namea: 'تقرير قيود التحويل', namee: 'REPKD2', namef: 'REPKD2.FMX' },
  { noa: 2105, typea: 210, rtba: 3, namea: 'اليومية العامة', namee: 'REPDAY', namef: 'REPDAY.FMX' },
  { noa: 2108, typea: 210, rtba: 4, namea: 'البحث بواسطة بيان أو مبلغ المستند', namee: 'REPMEMO', namef: 'REPMEMO.FMX' },
  { noa: 2111, typea: 211, rtba: 3, namea: 'ميزان المراجعة', namee: 'REPMZN', namef: 'REPMZN.FMX' },
  { noa: 2112, typea: 211, rtba: 3, namea: 'قائمة الأرباح والخسائر', namee: 'REPRANDH', namef: 'REPRANDH.FMX' },
  { noa: 2113, typea: 211, rtba: 3, namea: 'الميزانية العمومية', namee: 'REPMZNYH', namef: 'REPMZNYH.FMX' },
];

export const LEGACY_SYSTEM_SUMMARIES: LegacySystemSummary[] = [
  {
    tsys: 1,
    label: LEGACY_SYSTEM_LABELS[1],
    totalRows: LEGACY_SYSTEM_1_GROUPS.length + LEGACY_SYSTEM_1_SCREENS.length,
    screenRows: LEGACY_SYSTEM_1_SCREENS.length,
  },
];

export const LEGACY_SCREEN_TITLES: Record<string, string> = Object.fromEntries(
  LEGACY_SYSTEM_1_SCREENS.map((screen) => [screen.namee, screen.namea]),
);
