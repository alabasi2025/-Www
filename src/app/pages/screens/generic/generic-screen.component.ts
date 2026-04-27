import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  LEGACY_SCREEN_SPECS,
  LegacyDataGridComponent,
  LegacyStatusBarComponent,
  LegacyToolbarComponent,
  LegacyWindowComponent,
  resolveLegacyShortcut,
} from '../../../shared/legacy-ui';
import {
  LEGACY_SCREEN_TITLES,
  LEGACY_SYSTEM_1_SCREENS,
} from '../../../shared/legacy-ui/registry/legacy-system.registry';
import type {
  LegacyPermissionModel,
  LegacyStatusBadge,
  LegacyToolbarActionId,
} from '../../../shared/legacy-ui';

export type Row = Record<string, unknown>;

interface LegacyReportFilter {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date';
  placeholder?: string;
}

interface LegacyReportFileMeta {
  code: string;
  exists: boolean;
  file: string;
}

interface LegacyReportMeta {
  ok: boolean;
  screen: string;
  sourcePath: string;
  reports: LegacyReportFileMeta[];
  filters: LegacyReportFilter[];
  tables: string[];
  calledForms: string[];
  lovs: string[];
  dbRoutines: string[];
}

const GENERIC_REPORT_SCREENS = new Set([
  'REPKHALL',
  'REPKHR',
  'REPKHHR',
  'REPKHALLR',
  'REPSNDOK',
  'MSDKA',
  'REPDAY',
  'REPMEMO',
  'REPMZN',
  'REPRANDH',
  'REPMZNYH',
]);

interface KbBlock { name: string; items: string[]; triggers: string[]; }
interface KbTrigger { name: string; level: string; block: string | null; item: string | null; code: string; }
interface KbColumn { name: string; dataType: string; nullable: boolean; length?: number; precision?: number | null; scale?: number | null; }
interface KbTableSchema { columns: KbColumn[]; primaryKey: string[]; }
interface KB {
  screen: { namee: string; namea: string; hubName: string; tsys?: number; typea?: number };
  baseTable: string;
  tables: string[];
  blocks: KbBlock[];
  triggers: KbTrigger[];
  tableSchemas: Record<string, KbTableSchema>;
}

type LegacyGenericFieldKind = 'text' | 'number' | 'date' | 'checkbox' | 'button';

interface LegacyGenericField {
  key: string;
  block: string;
  item: string;
  kind: LegacyGenericFieldKind;
  value: string;
  triggers: string[];
  hasLov: boolean;
  isButton: boolean;
}

interface LegacyGenericBlock {
  name: string;
  fields: LegacyGenericField[];
  triggers: string[];
}

interface LegacyCompletionGate {
  label: string;
  pass: boolean;
  detail: string;
}

interface LegacyLovDialogState {
  field: LegacyGenericField;
  lovName: string;
  title: string;
  query: string;
  rows: Row[];
  columns: string[];
  display: string;
  loading: boolean;
  error: string | null;
  selected: Row | null;
}

interface LegacyLovResponse {
  ok: boolean;
  rows?: Row[];
  items?: Row[];
  columns?: string[];
  display?: string;
  error?: string;
}

@Component({
  selector: 'app-generic-screen',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    LegacyWindowComponent,
    LegacyToolbarComponent,
    LegacyDataGridComponent,
    LegacyStatusBarComponent,
  ],
  templateUrl: './generic-screen.component.html',
  styleUrl: './generic-screen.component.scss',
})
export class GenericScreenComponent implements OnInit {
  private http = inject(HttpClient);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly kb = signal<KB | null>(null);
  readonly rows = signal<Row[]>([]);
  readonly total = signal(0);
  readonly selected = signal<Row | null>(null);
  readonly mode = signal<'browse' | 'new' | 'edit'>('browse');
  readonly form = signal<Row>({});
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);
  readonly search = signal('');
  readonly namee = signal('');
  readonly selectedReport = signal('');
  readonly reportParams = signal<Record<string, string>>({});
  readonly reportMeta = signal<LegacyReportMeta | null>(null);
  readonly lovDialog = signal<LegacyLovDialogState | null>(null);

  readonly editable = computed(() => this.mode() === 'new' || this.mode() === 'edit');
  readonly spec = computed(() => LEGACY_SCREEN_SPECS[this.namee()] ?? null);
  readonly title = computed(() =>
    LEGACY_SCREEN_TITLES[this.namee()]
    || this.kb()?.screen?.namea
    || this.namee()
    || '\u0634\u0627\u0634\u0629 \u0627\u0644\u0646\u0638\u0627\u0645'
  );
  readonly screenMenuMeta = computed(() => LEGACY_SYSTEM_1_SCREENS.find((screen) => screen.namee === this.namee()));
  readonly screenTypea = computed(() => Number(this.kb()?.screen?.typea ?? this.screenMenuMeta()?.typea ?? 0));
  readonly isReportScreen = computed(() => GENERIC_REPORT_SCREENS.has(this.namee()) || [2, 210, 211].includes(this.screenTypea()));
  readonly baseTableLabel = computed(() => this.kb()?.baseTable || this.spec()?.dependencies.baseTable || '-');
  readonly sourceMeta = computed(() => this.spec()?.dependencies?.sourceMeta ?? null);
  readonly dependencyTables = computed(() => this.spec()?.dependencies.tables ?? []);
  readonly dependencyApi = computed(() => this.spec()?.dependencies.coverageApi ?? []);
  readonly reportOptions = computed(() => {
    const metaReports = this.reportMeta()?.reports.map((report) => report.code) ?? [];
    return metaReports.length ? metaReports : this.spec()?.dependencies.reports ?? [];
  });
  readonly currentReport = computed(() => this.selectedReport() || this.reportOptions()[0] || '');
  readonly missingReports = computed(() => this.reportMeta()?.reports.filter((report) => !report.exists) ?? []);
  readonly selectedReportMeta = computed(() => {
    const selected = this.currentReport();
    return this.reportMeta()?.reports.find((report) => report.code === selected) ?? null;
  });
  readonly reportFileLabel = computed(() => {
    const meta = this.selectedReportMeta();
    if (!meta) return '';
    return meta.exists ? meta.file : '\u063A\u064A\u0631 \u0645\u0648\u062C\u0648\u062F \u0641\u064A \u0645\u062C\u0644\u062F \u0627\u0644\u062A\u0642\u0627\u0631\u064A\u0631 \u0627\u0644\u0642\u062F\u064A\u0645';
  });
  readonly calledForms = computed(() => {
    const metaForms = this.reportMeta()?.calledForms ?? [];
    return metaForms.length ? metaForms : this.spec()?.dependencies.calledForms ?? [];
  });
  readonly lovsAndRoutines = computed(() => [
    ...(this.reportMeta()?.lovs ?? this.spec()?.dependencies.lovs ?? []),
    ...(this.reportMeta()?.dbRoutines ?? this.spec()?.dependencies.dbRoutines ?? []),
  ]);
  readonly reportFilters = computed<LegacyReportFilter[]>(() => {
    const metaFilters = this.reportMeta()?.filters ?? [];
    const deps = this.spec()?.dependencies;
    const filters: LegacyReportFilter[] = [];
    const add = (filter: LegacyReportFilter) => {
      if (!filters.some((item) => item.key === filter.key)) filters.push(filter);
    };

    metaFilters.forEach(add);

    if (deps) {
      const tables = new Set(deps.tables.map((table) => table.toUpperCase()));
      const lovs = new Set((deps.lovs ?? []).map((lov) => lov.toUpperCase()));
      const routines = new Set((deps.dbRoutines ?? []).map((routine) => routine.toUpperCase()));
      const reports = new Set((deps.reports ?? []).map((report) => report.toUpperCase()));
      const hasAccounts = tables.has('DATA_AC') || lovs.has('NA2') || lovs.has('NAM');
      const hasJournalOrVoucher = ['SNDKD', 'SNDKD2', 'SNDK', 'SNDS'].some((table) => tables.has(table) || reports.has(table));
      const hasPeriodData = ['DATAK', 'DATAKMZ', 'HMH', 'HMHALL', 'AMHSB'].some((table) => tables.has(table));

      if (hasAccounts) {
        add({ key: 'accountFrom', label: 'من حساب', type: 'text', placeholder: 'رقم الحساب' });
        add({ key: 'accountTo', label: 'إلى حساب', type: 'text', placeholder: 'رقم الحساب' });
      }

      if (hasJournalOrVoucher || hasPeriodData || reports.size > 0) {
        add({ key: 'dateFrom', label: 'من تاريخ', type: 'date' });
        add({ key: 'dateTo', label: 'إلى تاريخ', type: 'date' });
      }

      if (tables.has('MRT') || lovs.has('MRT') || lovs.has('MRT2') || routines.has('NAME_MRT')) {
        add({ key: 'costCenter', label: 'مركز التكلفة', type: 'text', placeholder: 'رقم المركز' });
      }

      if (tables.has('AMLH') || routines.has('CAMLH')) {
        add({ key: 'currency', label: 'العملة', type: 'number', placeholder: 'رقم العملة' });
      }

      if (hasJournalOrVoucher) add({ key: 'documentNo', label: 'رقم السند/القيد', type: 'number' });
      if (tables.has('YEAR')) add({ key: 'year', label: 'السنة', type: 'number', placeholder: 'السنة المالية' });
      if (reports.size > 0 || tables.has('TYPEMS')) add({ key: 'memo', label: 'البيان يحتوي', type: 'text' });
    }

    const kbItems = new Set(
      (this.kb()?.blocks ?? [])
        .flatMap((block) => block.items ?? [])
        .map((item) => item.toUpperCase()),
    );
    const hasAnyItem = (...items: string[]) => items.some((item) => kbItems.has(item));

    if (hasAnyItem('NOA', 'NO_A', 'NOAF', 'NOAD', 'NOAR', 'NOA1', 'NAMEA')) {
      add({ key: 'accountFrom', label: 'من حساب', type: 'text', placeholder: 'رقم الحساب' });
    }
    if (hasAnyItem('NOA2', 'NOAT', 'NOAT2', 'NAMEA2', 'NAMEM')) {
      add({ key: 'accountTo', label: 'إلى حساب', type: 'text', placeholder: 'رقم الحساب' });
    }
    if (hasAnyItem('D1', 'DATE1', 'DAT1', 'FROMDATE', 'XD1')) {
      add({ key: 'dateFrom', label: 'من تاريخ', type: 'date' });
    }
    if (hasAnyItem('D2', 'DATE2', 'DAT2', 'TODATE', 'XD2', 'TDATE')) {
      add({ key: 'dateTo', label: 'إلى تاريخ', type: 'date' });
    }
    if (hasAnyItem('MRT', 'NOMSH', 'NOMSRO', 'NOSMRT')) {
      add({ key: 'costCenter', label: 'مركز التكلفة', type: 'text', placeholder: 'رقم المركز' });
    }
    if (hasAnyItem('AML', 'NOAML', 'AML2', 'AML3')) add({ key: 'currency', label: 'العملة', type: 'number', placeholder: 'رقم العملة' });
    if (hasAnyItem('NOS', 'NOK')) add({ key: 'documentNo', label: 'رقم السند/القيد', type: 'number' });
    if (hasAnyItem('MEMOS', 'MEMO', 'BIAN', 'KMS')) add({ key: 'memo', label: 'البيان يحتوي', type: 'text' });
    if (hasAnyItem('MB')) add({ key: 'minAmount', label: 'من مبلغ', type: 'number' });
    if (hasAnyItem('MBN')) add({ key: 'maxAmount', label: 'إلى مبلغ', type: 'number' });
    if (hasAnyItem('RTBA')) add({ key: 'rankFrom', label: 'من رتبة', type: 'number' });
    if (hasAnyItem('RTBA2')) add({ key: 'rankTo', label: 'إلى رتبة', type: 'number' });

    return filters;
  });
  readonly showReportPanel = computed(() =>
    this.isReportScreen() || this.reportOptions().length > 0 || this.reportFilters().length > 0
  );
  readonly reportPanelCountLabel = computed(() => {
    const count = this.reportOptions().length;
    return count ? `${count} تقرير` : 'بدون ملف تقرير مسجل';
  });
  readonly reportDependencyItems = computed(() => [
    ...this.dependencyTables(),
    ...this.dependencyApi(),
    ...this.lovsAndRoutines(),
  ]);

  readonly permissionModel: LegacyPermissionModel = {
    ins: 1,
    ed: 1,
    de: 1,
    pr: 1,
    sar: 1,
    post: 1,
    unpost: 1,
    exp: 1,
  };

  readonly toolbarActions = computed<LegacyToolbarActionId[]>(() => {
    const actions = this.spec()?.requiredActions;
    const enabled = new Set(actions?.length ? actions : ['new', 'save', 'edit', 'delete', 'search', 'print', 'refresh', 'exit']);
    if (this.isReportScreen()) {
      return (['search', 'print', 'refresh', 'exit'] as LegacyToolbarActionId[]).filter(action =>
        action !== 'print' || this.reportOptions().length > 0
      );
    }
    const legacyOrder: LegacyToolbarActionId[] = [
      'new',
      'save',
      'edit',
      'delete',
      'search',
      'print',
      'refresh',
      'cancel',
      'export',
      'props',
      'exit',
    ];
    return legacyOrder
      .filter(action => enabled.has(action))
      .filter(action => this.allowGenericCrud() || !['new', 'save', 'edit', 'delete'].includes(action));
  });

  readonly enabledRules = computed<Partial<Record<LegacyToolbarActionId, boolean>>>(() => ({
    new: this.allowGenericCrud() && !this.editable() && !this.saving(),
    save: this.allowGenericCrud() && this.editable() && !this.saving(),
    edit: this.allowGenericCrud() && !!this.selected() && !this.editable() && !this.saving(),
    delete: this.allowGenericCrud() && !!this.selected() && !this.editable() && !this.saving(),
    search: !this.saving(),
    print: !this.saving(),
    refresh: !this.saving(),
    cancel: this.editable() && !this.saving(),
    exit: !this.saving(),
  }));

  readonly statusBadges = computed<LegacyStatusBadge[]>(() => {
    const deps = this.spec()?.dependencies;
    const badges: LegacyStatusBadge[] = [
      { label: `${this.total()} سجل`, icon: 'pi-database', variant: 'info' },
    ];
    const baseTable = this.kb()?.baseTable || deps?.baseTable;
    if (baseTable) badges.push({ label: `جدول: ${baseTable}`, icon: 'pi-table', variant: 'info' });
    if (deps) {
      badges.push({ label: `${deps.tables.length} جدول`, icon: 'pi-sitemap', variant: 'success' });
      if (deps.reports.length) badges.push({ label: `${deps.reports.length} تقرير`, icon: 'pi-print', variant: 'info' });
      if (deps.calledForms.length) {
        badges.push({ label: `${deps.calledForms.length} شاشة مرتبطة`, icon: 'pi-link', variant: 'warning' });
      }
    }
    if (this.isReportScreen()) {
      badges.push({ label: 'شاشة تقارير', icon: 'pi-file', variant: 'info' });
    }
    if (this.missingReports().length) {
      badges.push({ label: `${this.missingReports().length} تقرير ناقص`, icon: 'pi-exclamation-triangle', variant: 'warning' });
    }
    return badges;
  });

  readonly baseSchema = computed((): KbTableSchema | null => {
    const kb = this.kb();
    if (!kb) return null;
    return kb.tableSchemas[kb.baseTable] ?? null;
  });

  readonly columns = computed(() => this.baseSchema()?.columns ?? []);
  readonly pkCols = computed(() => this.baseSchema()?.primaryKey ?? []);
  readonly hasGridData = computed(() => this.columns().length > 0);
  readonly allowGenericCrud = computed(() => !this.isReportScreen() && this.pkCols().length > 0);
  readonly legacyFieldsEditable = computed(() => this.isReportScreen() || this.allowGenericCrud() || this.editable());
  readonly legacyBlocks = computed<LegacyGenericBlock[]>(() => {
    const kb = this.kb();
    if (!kb) return [];

    return (kb.blocks ?? []).map((block) => ({
      name: block.name,
      triggers: [...new Set(block.triggers ?? [])],
      fields: (block.items ?? []).map((item) => this.toLegacyField(block.name, item)),
    }));
  });
  readonly completionGates = computed<LegacyCompletionGate[]>(() => {
    const spec = this.spec();
    const kb = this.kb();
    const reports = this.reportMeta()?.reports ?? [];
    const missing = this.missingReports();
    return [
      {
        label: 'Catalog',
        pass: !!spec,
        detail: spec ? 'تم ربط تبعيات المصدر القديم' : 'لا يوجد سجل catalog',
      },
      {
        label: 'KB',
        pass: !!kb,
        detail: kb ? `${kb.blocks?.length ?? 0} block / ${kb.triggers?.length ?? 0} trigger` : 'لا يوجد KB تفصيلي',
      },
      {
        label: 'Reports',
        pass: !reports.length || missing.length === 0,
        detail: reports.length ? `${reports.length - missing.length}/${reports.length} ملفات موجودة` : 'لا توجد تقارير مسجلة',
      },
      {
        label: 'Mode',
        pass: !this.isReportScreen() || this.reportOptions().length > 0,
        detail: this.isReportScreen()
          ? 'حقول الشاشة تعمل كمعايير طباعة'
          : this.allowGenericCrud()
            ? 'CRUD عام بمفتاح أساسي'
            : 'عرض Legacy محمي حتى تنفيذ منطق خاص',
      },
    ];
  });
  readonly legacyReportParams = computed(() => this.buildLegacyReportParams());
  readonly activeReportCriteria = computed(() => {
    const merged = { ...this.legacyReportParams(), ...this.reportParams() };
    return Object.entries(merged)
      .map(([key, value]) => ({ key, value: String(value ?? '').trim() }))
      .filter((item) => item.value.length > 0)
      .slice(0, 18);
  });

  readonly filteredRows = computed(() => {
    const q = this.search().toLowerCase().trim();
    if (!q) return this.rows();
    return this.rows().filter(r => Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q)));
  });

  async ngOnInit(): Promise<void> {
    this.route.params.subscribe(async p => {
      const n = String(p['namee'] || '').toUpperCase();
      this.namee.set(n);
      this.selectedReport.set('');
      this.reportParams.set({});
      this.reportMeta.set(null);
      this.lovDialog.set(null);
      await this.loadReportMeta(n);
      await this.loadKb(n);
      this.ensureSelectedReport();
    });
  }

  private async loadReportMeta(namee: string): Promise<void> {
    if (!namee) return;
    try {
      const r = await firstValueFrom(this.http.get<LegacyReportMeta>(`/api/legacy-report/${namee}/meta`));
      if (r.ok) this.reportMeta.set(r);
    } catch {
      this.reportMeta.set(null);
    }
  }

  private ensureSelectedReport(): void {
    const current = this.selectedReport();
    const reports = this.reportOptions();
    if (!current && reports[0]) this.selectedReport.set(reports[0]);
    if (current && reports.length && !reports.includes(current)) this.selectedReport.set(reports[0]);
  }

  async loadKb(namee: string): Promise<void> {
    this.loading.set(true);
    this.err.set(null);
    this.info.set(null);
    this.kb.set(null);
    this.rows.set([]);
    this.total.set(0);
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; kb?: KB }>(`/api/kb/${namee}`));
      if (r.ok && r.kb) {
        this.kb.set(r.kb);
        this.ensureSelectedReport();
        await this.fetchRows();
      } else {
        this.useDependencyFallback(namee);
      }
    } catch (e) {
      this.useDependencyFallback(namee, e);
    }
    this.loading.set(false);
  }

  private useDependencyFallback(namee: string, reason?: unknown): void {
    this.ensureSelectedReport();
    if (this.spec()) {
      this.info.set('تم فتح الشاشة من سجل المصدر القديم. لا يوجد KB تفصيلي للجدول، لذلك تظهر التبعيات والتقارير كمرحلة مطابقة أولى.');
      return;
    }
    const suffix = reason ? ` - ${reason instanceof Error ? reason.message : String(reason)}` : '';
    this.err.set(`لا توجد بيانات معرفة لهذه الشاشة: ${namee}${suffix}`);
  }

  async fetchRows(): Promise<void> {
    const kb = this.kb();
    if (!kb) return;
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows?: Row[]; total?: number }>(
          `/api/data/${kb.baseTable}?limit=500`
        )
      );
      if (r.ok) {
        this.rows.set(r.rows ?? []);
        this.total.set(r.total ?? 0);
      } else {
        this.err.set('خطأ في جلب البيانات');
      }
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.loading.set(false);
  }

  selectRow(row: Row): void {
    this.selected.set(row);
    this.form.set({ ...row });
    this.mode.set('browse');
    this.err.set(null);
    this.info.set(null);
  }

  onNew(): void {
    if (!this.allowGenericCrud()) {
      this.info.set('هذه الشاشة تعمل حالياً بوضع Legacy محمي. تنفيذ الإضافة يحتاج منطق الشاشة القديمة الخاص وليس CRUD عام.');
      return;
    }
    this.selected.set(null);
    this.form.set({});
    this.mode.set('new');
    this.err.set(null);
    this.info.set(null);
  }

  onEdit(): void {
    if (!this.allowGenericCrud()) {
      this.info.set('التعديل العام معطل حتى ربط منطق الشاشة القديمة الخاص.');
      return;
    }
    if (this.selected()) this.mode.set('edit');
  }

  onCancel(): void {
    this.mode.set('browse');
  }

  async onSave(): Promise<void> {
    const kb = this.kb();
    if (!kb) return;
    if (!this.allowGenericCrud()) {
      this.info.set('الحفظ العام معطل لهذه الشاشة حتى لا نغير بيانات بطريقة لا تطابق Oracle Forms.');
      return;
    }
    this.saving.set(true);
    this.err.set(null);
    try {
      const isNew = this.mode() === 'new';
      if (isNew) {
        const r = await firstValueFrom(
          this.http.post<{ ok: boolean; error?: string }>(`/api/data/${kb.baseTable}`, this.form())
        );
        if (!r.ok) throw new Error(r.error);
        this.info.set('تم الحفظ بنجاح');
      } else {
        const pks = this.pkCols();
        const row = this.selected();
        if (!pks.length || !row) throw new Error('لا يوجد مفتاح أساسي');
        const where = pks.map(p => `${p}=:${p}`).join(' AND ');
        const sets = Object.keys(this.form()).filter(k => !pks.includes(k));
        if (!sets.length) throw new Error('لا توجد تغييرات');
        const setClause = sets.map(s => `${s}=:${s}`).join(',');
        const binds: Row = { ...this.form() };
        pks.forEach(p => { binds[p] = row[p]; });
        await firstValueFrom(
          this.http.put<{ ok: boolean; error?: string }>(
            `/api/data/${kb.baseTable}`,
            { sql: `UPDATE ${kb.baseTable} SET ${setClause} WHERE ${where}`, binds }
          )
        );
        this.info.set('تم التعديل بنجاح');
      }
      this.mode.set('browse');
      await this.fetchRows();
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.saving.set(false);
  }

  async onDelete(): Promise<void> {
    const kb = this.kb();
    const row = this.selected();
    if (!kb || !row) return;
    if (!this.allowGenericCrud()) {
      this.info.set('الحذف العام معطل لهذه الشاشة حتى لا نحذف بيانات لا تطابق شروط النظام القديم.');
      return;
    }
    if (!confirm('هل أنت متأكد من الحذف؟')) return;
    this.saving.set(true);
    try {
      const pks = this.pkCols();
      const where = pks.map(p => `${p}=${row[p]}`).join(' AND ');
      await firstValueFrom(
        this.http.delete<{ ok: boolean; error?: string }>(
          `/api/data/${kb.baseTable}?where=${encodeURIComponent(where)}`
        )
      );
      this.selected.set(null);
      this.form.set({});
      this.mode.set('browse');
      this.info.set('تم الحذف');
      await this.fetchRows();
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.saving.set(false);
  }

  onToolbarAction(action: LegacyToolbarActionId): void {
    switch (action) {
      case 'new':
        this.onNew();
        break;
      case 'edit':
        this.onEdit();
        break;
      case 'delete':
        void this.onDelete();
        break;
      case 'save':
        void this.onSave();
        break;
      case 'cancel':
        this.onCancel();
        break;
      case 'refresh':
        if (this.isReportScreen()) {
          void this.refreshReportScreen();
          break;
        }
        void this.fetchRows();
        break;
      case 'search':
        if (this.isReportScreen()) {
          this.onReportSearch();
          break;
        }
        void this.fetchRows();
        break;
      case 'print':
        this.onPrint();
        break;
      case 'export':
        this.onExport();
        break;
      case 'exit':
        void this.router.navigate(['/app']);
        break;
      default:
        this.info.set(`الأمر ${action} مسجل وسيتم ربطه بمنطق الشاشة القديم.`);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onLegacyKey(event: KeyboardEvent): void {
    const shortcutAction = resolveLegacyShortcut(event);
    if (!shortcutAction) return;
    const action = shortcutAction as LegacyToolbarActionId;
    if (!this.toolbarActions().includes(action)) return;
    if (this.enabledRules()[action] === false) return;
    event.preventDefault();
    this.onToolbarAction(action);
  }

  clearStatus(): void {
    this.err.set(null);
    this.info.set(null);
  }

  onReportSearch(): void {
    const count = this.activeReportCriteria().length;
    this.info.set(count ? `تم تجهيز ${count} معيار للتقرير.` : 'أدخل معايير التقرير ثم اضغط طباعة.');
  }

  async refreshReportScreen(): Promise<void> {
    const screen = this.namee();
    if (!screen) return;
    await this.loadReportMeta(screen);
    await this.loadKb(screen);
    this.ensureSelectedReport();
    this.info.set('تم تحديث بيانات التقرير.');
  }

  onPrint(): void {
    const reports = this.reportOptions();
    const report = this.currentReport() || reports[0];
    if (!report) {
      this.info.set('لا توجد تقارير مسجلة لهذه الشاشة في المصدر القديم.');
      return;
    }
    this.selectedReport.set(report);
    const params = new URLSearchParams({ report });
    for (const [key, value] of Object.entries(this.legacyReportParams())) {
      const clean = String(value ?? '').trim();
      if (clean) params.set(key, clean);
    }
    for (const [key, value] of Object.entries(this.reportParams())) {
      const clean = String(value ?? '').trim();
      if (clean) params.set(key, clean);
    }
    const url = `/api/legacy-report/${encodeURIComponent(this.namee())}/print?${params.toString()}`;
    const popup = window.open(url, '_blank');
    if (!popup) {
      window.location.assign(url);
    }
  }

  openCalledForm(formCode: string): void {
    const target = String(formCode || '').trim().toUpperCase();
    if (!target) return;
    void this.router.navigate(['/app/screens', target]);
  }

  setReportParam(key: string, value: string): void {
    this.reportParams.update((params) => ({ ...params, [key]: value }));
  }

  reportParam(key: string): string {
    return this.reportParams()[key] ?? '';
  }

  activateLegacyField(field: LegacyGenericField): void {
    const item = field.item.toUpperCase();
    if (/^PR\d*$/.test(item) || item === 'PRINT') {
      this.onPrint();
      return;
    }
    if (item === 'EX' || item === 'EXIT') {
      void this.router.navigate(['/app']);
      return;
    }
    if (item === 'XLS' || item === 'EXL' || item === 'TO_EXCEL') {
      this.onExport();
      return;
    }
    if (item === 'MSDK') {
      this.openLinkedReport('MSDKA');
      return;
    }
    if (field.hasLov) {
      void this.openLegacyLov(field);
      return;
    }
    this.info.set(`الحقل ${field.block}.${field.item} مسجل من المصدر القديم (${field.triggers.join(', ') || 'بدون triggers'}).`);
  }

  async openLegacyLov(field: LegacyGenericField): Promise<void> {
    const lov = this.resolveLegacyLov(field);
    if (!lov) {
      this.info.set(`الحقل ${field.block}.${field.item} لديه LOV في المصدر القديم، ولم يتم ربط نوعه بعد.`);
      return;
    }

    const query = this.asStr(this.form()[field.item] ?? field.value ?? '').trim();
    this.lovDialog.set({
      field,
      lovName: lov.name,
      title: lov.title,
      query,
      rows: [],
      columns: [],
      display: '',
      loading: true,
      error: null,
      selected: null,
    });
    await this.fetchLegacyLov();
  }

  async fetchLegacyLov(): Promise<void> {
    const state = this.lovDialog();
    if (!state) return;

    this.lovDialog.set({ ...state, loading: true, error: null });
    const params = new URLSearchParams({
      q: state.query || '%',
      limit: '100',
    });
    if (state.lovName === 'account') params.set('rtba', '5');

    try {
      const result = await firstValueFrom(
        this.http.get<LegacyLovResponse>(`/api/lov/${encodeURIComponent(state.lovName)}?${params.toString()}`)
      );
      if (!result.ok) throw new Error(result.error || 'فشل فتح LOV');
      const rows = result.rows ?? result.items ?? [];
      this.lovDialog.update((current) => current ? ({
        ...current,
        rows,
        columns: result.columns?.length ? [...result.columns] : this.columnsFromRows(rows),
        display: result.display || '',
        selected: rows[0] ?? null,
        loading: false,
      }) : current);
    } catch (error) {
      this.lovDialog.update((current) => current ? ({
        ...current,
        rows: [],
        columns: [],
        selected: null,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }) : current);
    }
  }

  setLegacyLovQuery(query: string): void {
    this.lovDialog.update((state) => state ? ({ ...state, query }) : state);
  }

  selectLegacyLovRow(row: Row): void {
    this.lovDialog.update((state) => state ? ({ ...state, selected: row }) : state);
  }

  confirmLegacyLov(): void {
    const state = this.lovDialog();
    if (state?.selected) this.applyLegacyLovRow(state.selected);
  }

  applyLegacyLovRow(row: Row): void {
    const state = this.lovDialog();
    if (!state) return;

    const updates = this.legacyLovUpdates(state.field, state.lovName, row);
    this.form.update((form) => ({ ...form, ...updates }));
    this.info.set(`تم اختيار ${state.title}: ${this.legacyLovDisplay(row, state)}`);
    this.lovDialog.set(null);
  }

  closeLegacyLov(): void {
    this.lovDialog.set(null);
  }

  rowCell(row: Row, col: string): string {
    return this.asStr(this.rowValue(row, col));
  }

  setField(col: string, val: string): void {
    this.form.update(f => ({ ...f, [col]: val }));
  }

  setLegacyField(field: LegacyGenericField, val: string | boolean): void {
    if (!this.legacyFieldsEditable()) return;
    this.form.update(f => ({ ...f, [field.item]: val }));
  }

  onExport(): void {
    const rows = this.filteredRows();
    if (!rows.length) {
      this.info.set('لا توجد بيانات ظاهرة لتصدير Excel.');
      return;
    }
    const cols = this.columns().length
      ? this.columns().slice(0, 50).map((column) => column.name)
      : Object.keys(rows[0] ?? {}).slice(0, 50);
    const csv = '\ufeff' + [
      cols.join(','),
      ...rows.map((row) => cols.map((col) => this.csvCell(this.rowValue(row, col))).join(',')),
    ].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.namee() || 'legacy'}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.info.set('تم تنفيذ تصدير Excel أولي من بيانات الشاشة الحالية، وربطه بزر XLS/TO_EXCEL.');
  }

  isDateCol(col: string): boolean {
    const c = this.columns().find(x => x.name === col);
    return c?.dataType === 'DATE';
  }

  isNumCol(col: string): boolean {
    const c = this.columns().find(x => x.name === col);
    return c?.dataType === 'NUMBER';
  }

  asStr(v: unknown): string {
    return String(v ?? '');
  }

  private toLegacyField(block: string, item: string): LegacyGenericField {
    const triggers = this.triggerNamesForItem(block, item);
    const schema = this.columnForItem(block, item);
    const upper = item.toUpperCase();
    const isButton = triggers.includes('WHEN-BUTTON-PRESSED') || ['PR', 'EX', 'XLS', 'SAR', 'Z'].includes(upper);
    const hasLov = triggers.includes('KEY-LISTVAL') || triggers.includes('KEY-HELP');
    const isCheckbox = triggers.includes('WHEN-CHECKBOX-CHANGED') || ['WZ', 'MM', 'XZ', 'LD', 'LM', 'KA', 'GD', 'IND', 'NEWM', 'XD1', 'XD2', 'TMS'].includes(upper);
    const dataType = schema?.dataType?.toUpperCase() ?? '';
    const value = this.asStr(this.form()[item] ?? this.form()[upper] ?? '');
    const kind = isButton
      ? 'button'
      : isCheckbox
        ? 'checkbox'
        : this.isLegacyDateItem(upper, dataType)
          ? 'date'
          : dataType === 'NUMBER'
            ? 'number'
            : 'text';
    return {
      key: `${block}.${item}`,
      block,
      item,
      value,
      triggers,
      hasLov,
      isButton,
      kind,
    };
  }

  private buildLegacyReportParams(): Record<string, string> {
    const params: Record<string, string> = {};
    for (const block of this.legacyBlocks()) {
      for (const field of block.fields) {
        if (field.isButton) continue;
        const raw = this.form()[field.item] ?? this.form()[field.item.toUpperCase()];
        const value = this.asStr(raw).trim();
        if (!value) continue;
        params[`field_${field.block}_${field.item}`] = value;
        this.applyCommonReportParam(params, field.item.toUpperCase(), value);
      }
    }
    for (const key of ['NOA', 'NO_A', 'NOA1', 'NOA2', 'NOAT', 'AML', 'NOAML', 'MRT', 'NOMSH', 'NOMSRO', 'NAMEM', 'MB', 'MBN', 'RTBA', 'RTBA2']) {
      const value = this.asStr(this.form()[key]).trim();
      if (value) this.applyCommonReportParam(params, key, value);
    }
    return params;
  }

  private openLinkedReport(reportCode: string): void {
    const report = this.reportOptions().find((item) => item.toUpperCase() === reportCode.toUpperCase());
    if (!report) {
      this.info.set(`التقرير ${reportCode} موجود في منطق Oracle Forms لكنه غير مسجل ضمن تبعيات هذه الشاشة.`);
      return;
    }
    this.selectedReport.set(report);
    this.onPrint();
  }

  private resolveLegacyLov(field: LegacyGenericField): { name: string; title: string } | null {
    const item = field.item.toUpperCase();
    if (['NAMEA', 'NAMEM', 'NOA', 'NO_A', 'NOAF', 'NOAD', 'NOAR', 'NOA1', 'NOA2', 'NOAT', 'NOAT2'].includes(item)) {
      return { name: 'account', title: item === 'NAMEM' ? 'دليل حسابات المشاريع' : 'دليل الحسابات' };
    }
    if (['AML', 'NOAML', 'AMLH', 'NOAMLC2'].includes(item)) {
      return { name: 'currency', title: 'العملات' };
    }
    if (['MRT', 'NOMSH', 'NOMSRO', 'NOSMRT', 'COSTCENTER'].includes(item)) {
      return { name: 'cost-center', title: 'مراكز التكلفة' };
    }
    if (['NOU', 'USER', 'NAMEU'].includes(item)) {
      return { name: 'user', title: 'المستخدمون' };
    }

    const sourceLovs = new Set((this.reportMeta()?.lovs ?? []).map((lov) => lov.toUpperCase()));
    if (field.hasLov && (sourceLovs.has('NA2') || sourceLovs.has('NAM'))) {
      return { name: 'account', title: 'دليل الحسابات' };
    }
    if (field.hasLov && sourceLovs.has('MRT')) return { name: 'cost-center', title: 'مراكز التكلفة' };
    return null;
  }

  private legacyLovUpdates(field: LegacyGenericField, lovName: string, row: Row): Row {
    const item = field.item.toUpperCase();
    const updates: Row = {};

    if (lovName === 'account') {
      const accountNo = this.rowValue(row, 'NOA', 'NO', 'CODE');
      const accountName = this.rowValue(row, 'NAMEA', 'NAMEM', 'NAME');
      const currency = this.rowValue(row, 'NOAML', 'AMLHH', 'AML');
      updates[field.item] = item.includes('NAME') ? (accountName ?? accountNo ?? '') : (accountNo ?? accountName ?? '');

      if (item === 'NAMEA') {
        updates['NAMEA'] = accountName ?? '';
        updates['NOA'] = accountNo ?? '';
        updates['NO_A'] = accountNo ?? '';
        if (currency != null && currency !== '') updates['AML'] = currency;
      } else if (item === 'NAMEM') {
        updates['NAMEM'] = accountName ?? '';
        updates['NOMSRO'] = accountNo ?? '';
        updates['NOMSH'] = accountNo ?? '';
      } else {
        updates[field.item] = accountNo ?? '';
        updates['NOA'] = accountNo ?? '';
        updates['NO_A'] = accountNo ?? '';
        if (accountName != null && accountName !== '') updates['NAMEA'] = accountName;
        if (currency != null && currency !== '') updates['AML'] = currency;
      }
      return updates;
    }

    if (lovName === 'currency') {
      const no = this.rowValue(row, 'NO', 'NOAML', 'AML');
      updates[field.item] = no ?? '';
      updates['AML'] = no ?? '';
      return updates;
    }

    if (lovName === 'cost-center') {
      const no = this.rowValue(row, 'NOS', 'MRT', 'NOMSH', 'NOMSRO');
      const name = this.rowValue(row, 'NAMEM', 'NAMEA', 'NAME');
      updates[field.item] = no ?? name ?? '';
      updates['MRT'] = no ?? '';
      updates['NOMSH'] = no ?? '';
      if (name != null && name !== '') updates['NAMEM'] = name;
      return updates;
    }

    const display = this.rowValue(row, field.item, 'NAMEA', 'NAMEM', 'NAME', 'CODE', 'NOA', 'NO');
    updates[field.item] = display ?? '';
    return updates;
  }

  private legacyLovDisplay(row: Row, state: LegacyLovDialogState): string {
    const displayValue = state.display ? this.rowValue(row, state.display) : null;
    return this.asStr(displayValue ?? this.rowValue(row, 'NAMEA', 'NAMEM', 'NAME', 'NOA', 'NO') ?? '');
  }

  private rowValue(row: Row, ...keys: string[]): unknown {
    for (const key of keys) {
      if (key in row) return row[key];
      const upper = key.toUpperCase();
      if (upper in row) return row[upper];
      const lower = key.toLowerCase();
      if (lower in row) return row[lower];
    }
    return undefined;
  }

  private columnsFromRows(rows: Row[]): string[] {
    return rows[0] ? Object.keys(rows[0]).slice(0, 8) : [];
  }

  private csvCell(value: unknown): string {
    const text = this.asStr(value).replace(/"/g, '""');
    return `"${text}"`;
  }

  private applyCommonReportParam(params: Record<string, string>, item: string, value: string): void {
    if (['NOA', 'NO_A', 'NOAF', 'NOAD', 'NOAR', 'NOA1'].includes(item) && !params['accountFrom']) {
      params['accountFrom'] = value;
    }
    if (['NOA2', 'NOAT', 'NOAT2'].includes(item) && !params['accountTo']) {
      params['accountTo'] = value;
    }
    if (['D1', 'DATE1', 'DAT1', 'FROMDATE'].includes(item) && !params['dateFrom']) {
      params['dateFrom'] = value;
    }
    if (['D2', 'DATE2', 'DAT2', 'TODATE'].includes(item) && !params['dateTo']) {
      params['dateTo'] = value;
    }
    if (['XD1'].includes(item) && !params['dateFrom']) {
      params['dateFrom'] = value;
    }
    if (['XD2', 'TDATE'].includes(item) && !params['dateTo']) {
      params['dateTo'] = value;
    }
    if (['DATES', 'DATEMO'].includes(item) && !params['dateFrom']) {
      params['dateFrom'] = value;
    }
    if (['AML', 'NOAML', 'AML2', 'AML3'].includes(item) && !params['currency']) {
      params['currency'] = value;
    }
    if (['MRT', 'NOMSH', 'NOMSRO'].includes(item) && !params['costCenter']) {
      params['costCenter'] = value;
    }
    if (['NOS', 'NOK', 'DOCUMENTNO'].includes(item) && !params['documentNo']) {
      params['documentNo'] = value;
    }
    if (['BIAN', 'MEMOS', 'MEMO', 'KMS'].includes(item) && !params['memo']) {
      params['memo'] = value;
    }
    if (item === 'MB' && !params['minAmount']) {
      params['minAmount'] = value;
    }
    if (item === 'MBN' && !params['maxAmount']) {
      params['maxAmount'] = value;
    }
    if (item === 'RTBA' && !params['rankFrom']) {
      params['rankFrom'] = value;
    }
    if (item === 'RTBA2' && !params['rankTo']) {
      params['rankTo'] = value;
    }
    if (['NAMEA', 'NAMEM'].includes(item) && !params['memo']) {
      params['memo'] = value;
    }
  }

  private isLegacyDateItem(item: string, dataType: string): boolean {
    return dataType === 'DATE' || ['D1', 'D2', 'DATES', 'DATEMO', 'XD1', 'XD2', 'TDATE'].includes(item) || item.startsWith('DATE');
  }

  private triggerNamesForItem(block: string, item: string): string[] {
    const kb = this.kb();
    if (!kb) return [];
    return [...new Set((kb.triggers ?? [])
      .filter((trigger) => (trigger.block ?? '').toUpperCase() === block.toUpperCase() && (trigger.item ?? '').toUpperCase() === item.toUpperCase())
      .map((trigger) => trigger.name))];
  }

  private columnForItem(block: string, item: string): KbColumn | null {
    const kb = this.kb();
    if (!kb) return null;
    const findIn = (schema?: KbTableSchema) => schema?.columns.find((column) => column.name.toUpperCase() === item.toUpperCase()) ?? null;
    return findIn(kb.tableSchemas[block])
      ?? findIn(kb.tableSchemas[kb.baseTable])
      ?? Object.values(kb.tableSchemas).map((schema) => findIn(schema)).find((column): column is KbColumn => !!column)
      ?? null;
  }
}
