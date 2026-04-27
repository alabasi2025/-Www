import type { LegacyVisualBaselineMeta } from '../contracts/legacy-contracts';

export const LEGACY_SYSTEM1_VISUAL_BASELINES: LegacyVisualBaselineMeta[] = [
  { screenCode: 'COPY', stateLabel: 'dialog', legacyScreenshotPath: '/legacy-baselines/system1/COPY.jpg', resolution: '1366x768', capturedAt: '2026-04-25', note: 'النسخ الاحتياطي' },
  { screenCode: 'DATA_AM', stateLabel: 'browse', legacyScreenshotPath: '/legacy-baselines/system1/DATA_AM.jpg', resolution: '1366x768', capturedAt: '2026-04-25', note: 'بيانات العملاء' },
  { screenCode: 'USER', stateLabel: 'grid', legacyScreenshotPath: '/legacy-baselines/system1/USER.jpg', resolution: '1366x768', capturedAt: '2026-04-25', note: 'بيانات المستخدمين' },
  { screenCode: 'DATA_MO', stateLabel: 'browse', legacyScreenshotPath: '/legacy-baselines/system1/DATA_MO.jpg', resolution: '1366x768', capturedAt: '2026-04-25', note: 'بيانات الموردين' },
  { screenCode: 'DATA_AML', stateLabel: 'grid', legacyScreenshotPath: '/legacy-baselines/system1/DATA_AML.jpg', resolution: '1366x768', capturedAt: '2026-04-25', note: 'تهيئة العملات' },
  { screenCode: 'TREE', stateLabel: 'browse', legacyScreenshotPath: '/legacy-baselines/system1/TREE.jpg', resolution: '1366x768', capturedAt: '2026-04-25', note: 'دليل الحسابات' },
  { screenCode: 'SNDS', stateLabel: 'grid', legacyScreenshotPath: '/legacy-baselines/system1/SNDS.jpg', resolution: '1366x768', capturedAt: '2026-04-25', note: 'سند الصرف' },
  { screenCode: 'SNDK', stateLabel: 'grid', legacyScreenshotPath: '/legacy-baselines/system1/SNDK.jpg', resolution: '1366x768', capturedAt: '2026-04-25', note: 'سند القبض' },
  { screenCode: 'AKFAL', stateLabel: 'dialog', legacyScreenshotPath: '/legacy-baselines/system1/AKFAL.jpg', resolution: '1366x768', capturedAt: '2026-04-25', note: 'إقفالات النظام' },
  { screenCode: 'RSEDIF', stateLabel: 'grid', legacyScreenshotPath: '/legacy-baselines/system1/RSEDIF.jpg', resolution: '1366x768', capturedAt: '2026-04-25', note: 'الأرصدة الافتتاحية' },
  { screenCode: 'MAIN_OR_MEMO', stateLabel: 'main', legacyScreenshotPath: '/legacy-baselines/system1/MAIN_OR_MEMO.jpg', resolution: '1366x768', capturedAt: '2026-04-25', note: 'الشاشة الرئيسية أو مذكرة مواعيد' },
];

export const LEGACY_SYSTEM1_BASELINE_SCREEN_CODES = new Set(
  LEGACY_SYSTEM1_VISUAL_BASELINES.map((baseline) => baseline.screenCode),
);
