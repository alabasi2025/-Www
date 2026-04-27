export type LegacyScreenMode = 'browse' | 'new' | 'edit';

export type LegacyShortcutKey =
  | 'F2'
  | 'F3'
  | 'F4'
  | 'F6'
  | 'F7'
  | 'F8'
  | 'F10'
  | 'Escape';

export type LegacyPermissionKey =
  | 'ins'
  | 'ed'
  | 'de'
  | 'pr'
  | 'sar'
  | 'post'
  | 'unpost'
  | 'exp';

export interface LegacyPermissionModel {
  ins?: number;
  ed?: number;
  de?: number;
  pr?: number;
  sar?: number;
  [key: string]: number | undefined;
}

export interface LegacyTokenContract {
  colorWindowBg: string;
  colorPanelBg: string;
  colorPanelBorder: string;
  colorToolbarBg: string;
  colorInputBg: string;
  colorInputBorder: string;
  colorInputFocus: string;
  colorDisabledBg: string;
  colorDisabledFg: string;
  colorTextPrimary: string;
  colorTextMuted: string;
  colorDanger: string;
  colorSuccess: string;
  radiusSm: string;
  radiusMd: string;
  controlHeight: string;
  fontFamily: string;
  fontSize: string;
}

export type LegacyToolbarActionId =
  | 'new'
  | 'save'
  | 'edit'
  | 'delete'
  | 'search'
  | 'print'
  | 'exit'
  | 'refresh'
  | 'cancel'
  | 'post'
  | 'unpost'
  | 'export'
  | 'report'
  | 'add-line'
  | 'props';

export interface LegacyToolbarContext {
  mode: LegacyScreenMode;
  hasCurrent: boolean;
  posted: boolean;
  saving: boolean;
  permissions: LegacyPermissionModel;
}

export interface LegacyToolbarAction {
  id: LegacyToolbarActionId;
  label: string;
  iconAsset: string;
  shortcut?: LegacyShortcutKey;
  permissionKey?: LegacyPermissionKey;
  enabledRule?: (ctx: LegacyToolbarContext) => boolean;
}

export interface LegacyScreenDependency {
  baseTable?: string;
  tables: string[];
  reports: string[];
  calledForms: string[];
  coverageApi: string[];
  dbRoutines?: string[];
  lovs?: string[];
  legacyKeys?: string[];
  sourceMeta?: LegacyScreenSourceMeta;
}

export interface LegacyScreenSourceMeta {
  catalogPath: string;
  sourcePath: string;
  sourceSha256: string;
  lineCount: number;
  uniqueTriggerCount: number;
  rawTriggerHits: number;
  programUnitCount: number;
}

export interface LegacyVisualBaselineMeta {
  screenCode: string;
  stateLabel: string;
  legacyScreenshotPath: string;
  resolution: string;
  capturedAt: string;
  note?: string;
}

export interface LegacyScreenSpec {
  code: string;
  dependencies: LegacyScreenDependency;
  shortcuts: LegacyShortcutKey[];
  requiredActions: LegacyToolbarActionId[];
  acceptanceChecklist: string[];
}
