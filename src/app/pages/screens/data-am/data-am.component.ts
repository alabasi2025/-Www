import {
  Component, OnInit, ChangeDetectionStrategy,
  signal, computed, inject, input, HostListener, ViewChild, ElementRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';

/**
 * DATA_AM — بيانات العملاء  (kind='customer', RTBA=5)
 * DATA_MO — بيانات الموردين (kind='supplier', RTBA=5; separated by TYPEA=221x)
 *
 * Single component serving both screens; they share the DATA_AC table
 * and only differ by RTBA and a couple of labels. Layout mirrors the
 * original Forms 6i `DATA_AM.fmb`:
 *
 *   ┌──────────────────────── toolbar ────────────────────────┐
 *   ├── tabs (الأصول / الأصول المتداولة / عملاء محليون) ─────┤
 *   ├──────────────────────────────────┬─────────── sidebar ──┤
 *   │                                  │  [ search box ]      │
 *   │          main form               │  parent-category list│
 *   │  + currency-ceiling sub-grid     │  (click to filter)   │
 *   ├──────────────── audit footer ────┴──────────────────────┤
 *   │ مدخل / معدل / تاريخ / جهاز / عدد مرات التعديل          │
 *   └─────────────────────────────────────────────────────────┘
 */

/** Row returned by the list endpoint (subset for the sidebar). */
export interface PartyListRow {
  NOA: number;
  NAMEA: string | null;
  TYPEA: number;
  NOAN: number | null;
  NOYSOFT: number | null;
  TEL: number | string | null;
  ADRS: string | null;
  MRT: number | null;
  MNTKA: number | null;
}

/** Full record returned by GET /:noa, with audit + join columns. */
export interface PartyRow extends PartyListRow {
  RTBA: number;
  TEL2: number | string | null;
  TWKFX: number | null;
  SARH: number | null;
  NOG: number | null;
  NOKYED: number | null;
  NBIN: string | null;
  NAMEDMIN: string | null;
  CNAME: string | null;
  TIN: string | null;
  TED: string | null;
  MEMOH: string | null;
  AHSAR: string | null;
  HALL: number | null;
  NED: number | null;
  DI: string | null;
  DE: string | null;
  PCI: string | null;
  PCE: string | null;
  NOUSX: number | null;
  NOUSXU: number | null;
  NAMEU_IN: string | null;
  NAMEU_ED: string | null;
}

/** Tree node used for the sidebar category list. */
interface TreeNode {
  NOA: number;
  NAMEA: string;
  TYPEA: number;
  RTBA: number;
}

interface PartyGroup {
  NOG: number;
  NAMEG: string;
}

interface RegionGroup {
  NOG: number;
  NAMEG: string;
}

type PartyKind = 'customer' | 'supplier';

const LEGACY_PARTY_DEFAULTS: Record<PartyKind, { typea: number; path: TreeNode[] }> = {
  customer: {
    typea: 1221,
    path: [
      { NOA: 1, TYPEA: 0, RTBA: 1, NAMEA: '\u0627\u0644\u0627\u0635\u0648\u0644' },
      { NOA: 12, TYPEA: 1, RTBA: 2, NAMEA: '\u0627\u0644\u0627\u0635\u0648\u0644 \u0627\u0644\u0645\u062A\u062F\u0627\u0648\u0644\u0629' },
      { NOA: 122, TYPEA: 12, RTBA: 3, NAMEA: '\u0627\u0644\u0639\u0645\u0644\u0627\u0621' },
      { NOA: 1221, TYPEA: 122, RTBA: 4, NAMEA: '\u0639\u0645\u0644\u0627\u0621 \u0645\u062D\u0644\u064A\u064A\u0646' },
    ],
  },
  supplier: {
    typea: 2211,
    path: [
      { NOA: 2, TYPEA: 0, RTBA: 1, NAMEA: '\u0627\u0644\u062E\u0635\u0648\u0645' },
      { NOA: 22, TYPEA: 2, RTBA: 2, NAMEA: '\u0627\u0644\u062E\u0635\u0648\u0645 \u0627\u0644\u0645\u062A\u062F\u0627\u0648\u0644\u0629' },
      { NOA: 221, TYPEA: 22, RTBA: 3, NAMEA: '\u0627\u0644\u0645\u0648\u0631\u062F\u064A\u0646' },
      { NOA: 2211, TYPEA: 221, RTBA: 4, NAMEA: '\u0645\u0648\u0631\u062F\u064A\u0646 \u0645\u062D\u0644\u064A\u064A\u0646' },
    ],
  },
};

/** Writable form model shown in the editor. */
interface PartyForm {
  NOA: number | null;
  NAMEA: string;
  TYPEA: number | null;
  TYPEA_NAME: string;
  NOYSOFT: number | null;
  MRT: number | null;
  MNTKA: number | null;
  TEL: string;
  TEL2: string;
  TWKFX: number | null;
  SARH: number | null;
  NOG: number | null;
  NOKYED: number | null;
  ADRS: string;
  NBIN: string;
  NAMEDMIN: string;
  CNAME: string;
  TIN: string;
  TED: string;
  MEMOH: string;
  AHSAR: string;
  HALL: number;
}

/** Audit snapshot shown in the footer (read-only). */
interface AuditInfo {
  DI: string | null;
  DE: string | null;
  PCI: string | null;
  PCE: string | null;
  NOUSX: number | null;
  NOUSXU: number | null;
  NAMEU_IN: string | null;
  NAMEU_ED: string | null;
  NED: number | null;
}

const EMPTY_FORM: PartyForm = {
  NOA: null, NAMEA: '', TYPEA: null, TYPEA_NAME: '',
  NOYSOFT: null, MRT: null, MNTKA: null, TEL: '', TEL2: '',
  TWKFX: null, SARH: null, NOG: 1, NOKYED: null,
  ADRS: '', NBIN: '', NAMEDMIN: '', CNAME: '',
  TIN: '', TED: '', MEMOH: '',
  AHSAR: '', HALL: 0,
};

const EMPTY_AUDIT: AuditInfo = {
  DI: null, DE: null, PCI: null, PCE: null,
  NOUSX: null, NOUSXU: null,
  NAMEU_IN: null, NAMEU_ED: null, NED: null,
};

@Component({
  selector: 'app-data-am',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  templateUrl: './data-am.component.html',
  styleUrl: './data-am.component.scss',
})
export class DataAmComponent implements OnInit {
  private http = inject(HttpClient);
  private permSvc = inject(PermissionService);
  private router = inject(Router);
  @ViewChild('legacySearchInput') private legacySearchInput?: ElementRef<HTMLInputElement>;
  @ViewChild('legacyPrintButton') private legacyPrintButton?: ElementRef<HTMLButtonElement>;

  /** 'customer' or 'supplier' — wired from the screen router. */
  readonly kind = input<PartyKind>('customer');

  readonly endpoint   = computed(() => this.kind() === 'customer' ? '/api/customers' : '/api/suppliers');
  readonly screenCode = computed(() => this.kind() === 'customer' ? 'DATA_AM.FMX' : 'DATA_MO.FMX');
  readonly title      = computed(() => this.kind() === 'customer' ? 'بيانات العملاء' : 'بيانات الموردين');
  readonly windowTitle = computed(() => this.kind() === 'customer' ? 'شاشات ادخال بيانات العملاء' : 'شاشات ادخال بيانات الموردين');
  readonly entityLabel = computed(() => this.kind() === 'customer' ? 'عميل' : 'مورد');
  readonly entityNumberLabel = computed(() => this.kind() === 'customer' ? 'رقم العميل' : 'رقم المورد');
  readonly entityNameLabel = computed(() => this.kind() === 'customer' ? 'اسم العميل' : 'اسم المورد');
  readonly printActionTitle = computed(() => this.kind() === 'customer' ? 'F4 طباعة عملاء المجموعة' : 'F4 طباعة موردين المجموعة');
  readonly partyRtba   = computed(() => 5);
  readonly partyGroupTg = computed(() => this.kind() === 'customer' ? 1 : 2);
  readonly legacyTabs = computed(() => {
    const path = this.tabPath();
    if (path.length) return path.map(t => this.legacyDisplayName(t.NAMEA));
    return this.kind() === 'customer'
      ? ['الأصول', 'الأصول المتداولة', 'العملاء', 'عملاء محليين']
      : ['الخصوم', 'الخصوم المتداولة', 'الموردين', 'موردين محليين'];
  });
  readonly legacyPathFields = computed(() => {
    const path = this.tabPath().length ? this.tabPath() : this.legacyDefaultPath();
    return path.slice(0, 3).map(t => this.legacyDisplayName(t.NAMEA));
  });
  readonly legacyBranchOptions = computed(() => {
    const parent = this.legacyDefault().path[2]?.NOA;
    const rows = this.treeNodes()
      .filter(n => n.TYPEA === parent && n.RTBA === 4)
      .sort((a, b) => a.NOA - b.NOA);
    return rows.length ? rows : [this.legacyDefaultPath()[3]];
  });
  readonly legacyActiveNoa4 = computed(() => this.activeLegacyTypea());

  // ── Permissions (USERGN flags, same gates as the legacy form) ────
  private readonly perms = computed(() => this.permSvc.forScreen(this.screenCode())());
  readonly canIns = computed(() => (this.perms()?.ins ?? 0) > 0);
  readonly canEd  = computed(() => (this.perms()?.ed  ?? 0) > 0);
  readonly canDe  = computed(() => (this.perms()?.de  ?? 0) > 0);
  readonly canPr  = computed(() => (this.perms()?.pr  ?? 0) > 0);
  readonly canSar = computed(() => (this.perms()?.sar ?? 0) > 0);

  // ── Core state ────────────────────────────────────────────────
  readonly rows       = signal<PartyListRow[]>([]);
  readonly treeNodes  = signal<TreeNode[]>([]);
  readonly groups     = signal<PartyGroup[]>([]);
  readonly regions    = signal<RegionGroup[]>([]);
  readonly form       = signal<PartyForm>({ ...EMPTY_FORM });
  readonly audit      = signal<AuditInfo>({ ...EMPTY_AUDIT });
  readonly selected   = signal<number | null>(null);
  readonly previousSelected = signal<number | null>(null);
  readonly mode       = signal<'browse' | 'new' | 'edit'>('browse');
  readonly loading    = signal(false);
  readonly saving     = signal(false);
  readonly err        = signal<string | null>(null);
  readonly info       = signal<string | null>(null);
  readonly search     = signal('');
  readonly freezeOptions = [
    { value: 0, label: '' },
    { value: 1, label: '\u0639\u062F\u0645 \u0627\u0638\u0647\u0627\u0631 \u0627\u0644\u062D\u0633\u0627\u0628 \u0641\u064A \u0627\u064A \u0645\u0633\u062A\u0646\u062F' },
    { value: 2, label: '\u062A\u062C\u0645\u064A\u062F \u0644\u0644\u0639\u0645\u0644\u064A\u0627\u062A \u0627\u0644\u0645\u062F\u064A\u0646\u0629 \u0648\u0627\u0644\u062A\u0646\u0628\u064A\u0647 \u0641\u064A \u0627\u0644\u0639\u0645\u0644\u064A\u0627\u062A \u0627\u0644\u062F\u0627\u0626\u0646\u0629' },
    { value: 3, label: '\u062A\u062C\u0645\u064A\u062F \u0643\u0627\u0645\u0644' },
  ];

  /**
   * Tab state — an ordered list of parent-node IDs representing the
   * navigation depth in the chart of accounts tree. The last entry is
   * the "active" category; rows are filtered by it. An empty array means
   * "show the whole party RTBA", matching the legacy "all" default.
   */
  readonly tabPath = signal<TreeNode[]>([]);

  // ── TYPEA LOV overlay ─────────────────────────────────────────
  readonly typeaLovOpen   = signal(false);
  readonly typeaLovSearch = signal('');

  // ── Derived ──────────────────────────────────────────────────
  readonly editable   = computed(() => this.mode() !== 'browse');
  readonly hasCurrent = computed(() => this.selected() !== null);

  /** Current active category node (or null for root). */
  readonly currentTab = computed<TreeNode | null>(() => {
    const p = this.tabPath();
    return p.length ? p[p.length - 1] : null;
  });

  /**
   * Parties filtered by the active tab. We walk the chart tree to find
   * every descendant of the current TYPEA and keep rows whose TYPEA
   * falls in that set.
   */
  readonly tabRows = computed(() => {
    const tab = this.currentTab();
    const rows = this.rows();
    if (!tab) return rows;
    const descendants = this.descendantIds(tab.NOA);
    return rows.filter(r => descendants.has(r.TYPEA));
  });

  /** Rows after both tab filtering and the free-text search box. */
  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const rows = this.tabRows();
    if (!q) return rows;
    return rows.filter(r =>
      String(r.NOA).includes(q) ||
      (r.NAMEA ?? '').toLowerCase().includes(q) ||
      String(r.NOYSOFT ?? '').includes(q) ||
      String(r.TEL ?? '').includes(q),
    );
  });

  /** Parent categories (RTBA 1..4) filtered by search — used in TYPEA LOV. */
  readonly typeaLovFiltered = computed(() => {
    const q = this.typeaLovSearch().trim().toLowerCase();
    const parents = this.treeNodes().filter(n => n.RTBA > 0 && n.RTBA < 5);
    if (!q) return parents.slice(0, 200);
    return parents
      .filter(n => String(n.NOA).includes(q) || n.NAMEA.toLowerCase().includes(q))
      .slice(0, 200);
  });

  /**
   * The three "breadcrumb" tab buttons shown at the top. When no tab is
   * active we synthesize a default list that matches the legacy form's
   * starting state for a customer/supplier screen.
   */
  readonly tabButtons = computed(() => this.tabPath());

  ngOnInit(): void {
    void Promise.all([this.fetchTree(), this.fetchGroups(), this.fetchRegions()]).then(() => {
      this.applyDefaultLegacyTab();
      return this.fetchList();
    });
  }

  // ── Data fetchers ────────────────────────────────────────────
  async fetchList(): Promise<void> {
    this.loading.set(true);
    try {
      const params = new URLSearchParams();
      params.set('typea', String(this.activeLegacyTypea()));
      const { q, contains } = this.legacySearchQuery();
      if (q) params.set('q', q);
      if (contains) params.set('contains', '1');
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: PartyListRow[]; error?: string }>(
          `${this.endpoint()}?${params.toString()}`));
      if (!r.ok) throw new Error(r.error);
      const rows = r.rows ?? [];
      this.rows.set(rows);
      const firstVisible = this.filtered()[0];
      if (this.mode() === 'browse' && this.selected() === null && firstVisible) {
        await this.openRow(firstVisible.NOA);
      }
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally { this.loading.set(false); }
  }

  async fetchTree(): Promise<void> {
    if (this.treeNodes().length) return;
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: TreeNode[] }>('/api/accounts/tree'));
      if (r.ok) this.treeNodes.set(r.rows ?? []);
    } catch { /* silent */ }
  }

  async fetchGroups(): Promise<void> {
    if (this.groups().length) return;
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: PartyGroup[] }>(`/api/party-groups?tg=${this.partyGroupTg()}`));
      if (r.ok) this.groups.set(r.rows ?? []);
    } catch { /* silent */ }
  }

  async fetchRegions(): Promise<void> {
    if (this.kind() !== 'supplier' || this.regions().length) return;
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: RegionGroup[] }>('/api/regions'));
      if (r.ok) this.regions.set(r.rows ?? []);
    } catch { /* silent */ }
  }

  async openRow(noa: number): Promise<void> {
    this.clearMessages();
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; record: PartyRow; error?: string }>(
          `${this.endpoint()}/${noa}`));
      if (!r.ok) throw new Error(r.error);
      this.selected.set(noa);
      this.form.set(this.toForm(r.record));
      this.audit.set(this.toAudit(r.record));
      this.mode.set('browse');
      // Sync the tab path to the loaded party's category chain so the
      // user sees which branch the record belongs to.
      this.syncTabToRecord(r.record.TYPEA);
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally { this.loading.set(false); }
  }

  private toForm(r: PartyRow): PartyForm {
    const parent = this.treeNodes().find(n => n.NOA === r.TYPEA);
    return {
      NOA: r.NOA,
      NAMEA: this.cleanText(r.NAMEA),
      TYPEA: r.TYPEA,
      TYPEA_NAME: parent?.NAMEA ?? '',
      NOYSOFT: r.NOYSOFT,
      MRT: r.MRT,
      MNTKA: r.MNTKA,
      TEL:  this.cleanText(r.TEL),
      TEL2: this.cleanText(r.TEL2),
      TWKFX: r.TWKFX,
      SARH: r.SARH,
      NOG: r.NOG ?? 1,
      NOKYED: r.NOKYED,
      ADRS: this.cleanText(r.ADRS),
      NBIN: this.cleanText(r.NBIN),
      NAMEDMIN: this.cleanText(r.NAMEDMIN),
      CNAME: this.cleanText(r.CNAME),
      TIN: this.cleanText(r.TIN),
      TED: this.cleanText(r.TED),
      MEMOH: this.cleanText(r.MEMOH),
      AHSAR: this.cleanText(r.AHSAR),
      HALL: r.HALL ?? 0,
    };
  }

  private toAudit(r: PartyRow): AuditInfo {
    return {
      DI: r.DI, DE: r.DE,
      PCI: this.cleanNullableText(r.PCI),
      PCE: this.cleanNullableText(r.PCE),
      NOUSX: r.NOUSX, NOUSXU: r.NOUSXU,
      NAMEU_IN: this.cleanNullableText(r.NAMEU_IN),
      NAMEU_ED: this.cleanNullableText(r.NAMEU_ED),
      NED: r.NED,
    };
  }

  private cleanText(value: unknown): string {
    return String(value ?? '').replace(/\u0000/g, '').trimEnd();
  }

  private cleanNullableText(value: unknown): string | null {
    const text = this.cleanText(value);
    return text ? text : null;
  }

  legacyDisplayName(value: unknown): string {
    const text = this.cleanText(value);
    if (text === 'عملاء محليون') return 'عملاء محليين';
    if (text === 'موردون محليون') return 'موردين محليين';
    return text;
  }

  // ── Tab navigation ───────────────────────────────────────────
  /** Walks up the tree from the record's TYPEA to synthesise a tab path. */
  private syncTabToRecord(typea: number): void {
    const nodes = this.treeNodes();
    const path: TreeNode[] = [];
    if (typea === this.legacyDefault().typea) {
      this.tabPath.set(this.legacyDefaultPath());
      return;
    }
    let cur = nodes.find(n => n.NOA === typea);
    while (cur && cur.RTBA > 0) {
      path.unshift(cur);
      cur = nodes.find(n => n.NOA === cur!.TYPEA);
    }
    this.tabPath.set(path);
  }

  private applyDefaultLegacyTab(): void {
    this.syncTabToRecord(this.legacyDefault().typea);
  }

  private activeLegacyTypea(): number {
    return this.currentTab()?.NOA ?? this.legacyDefault().typea;
  }

  private legacyDefault(): { typea: number; path: TreeNode[] } {
    return LEGACY_PARTY_DEFAULTS[this.kind()];
  }

  private legacyDefaultPath(): TreeNode[] {
    return this.legacyDefault().path.map(node => ({ ...node }));
  }

  /** Returns the set of NOA's that are `root` or descendants of `root`. */
  private descendantIds(root: number): Set<number> {
    const out = new Set<number>([root]);
    const children = new Map<number, number[]>();
    for (const n of this.treeNodes()) {
      if (!children.has(n.TYPEA)) children.set(n.TYPEA, []);
      children.get(n.TYPEA)!.push(n.NOA);
    }
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const child of children.get(cur) ?? []) {
        if (!out.has(child)) { out.add(child); stack.push(child); }
      }
    }
    return out;
  }

  /** Pushes a tab onto the path (narrowing the visible rows). */
  setTab(node: TreeNode): void {
    this.tabPath.set([...this.tabPath(), node]);
  }

  /** Clicks on one of the breadcrumb tab buttons: truncates the path. */
  jumpTab(index: number): void {
    this.tabPath.set(this.tabPath().slice(0, index + 1));
  }

  clearTabs(): void { this.tabPath.set([]); }

  jumpLegacyTab(index: number): void {
    if (!this.tabPath().length) return;
    this.jumpTab(index);
  }

  async onLegacyNoa4Change(value: number | string): Promise<void> {
    if (this.editable() || this.saving()) return;
    const noa4 = Number(value) || this.legacyDefault().typea;
    this.clearMessages();
    this.syncTabToRecord(noa4);
    this.selected.set(null);
    this.form.set({ ...EMPTY_FORM });
    this.audit.set({ ...EMPTY_AUDIT });
    await this.fetchList();
  }

  // ── TYPEA LOV ────────────────────────────────────────────────
  openTypeaLov(): void {
    if (!this.editable()) return;
    this.typeaLovSearch.set('');
    this.typeaLovOpen.set(true);
  }
  closeTypeaLov(): void { this.typeaLovOpen.set(false); }
  pickTypea(n: TreeNode): void {
    this.form.update(f => ({ ...f, TYPEA: n.NOA, TYPEA_NAME: n.NAMEA }));
    this.typeaLovOpen.set(false);
  }

  // ── Toolbar handlers (match Forms 6i button semantics) ───────
  clearMessages(): void { this.err.set(null); this.info.set(null); }

  updateField<K extends keyof PartyForm>(key: K, value: PartyForm[K]): void {
    this.form.update(f => ({ ...f, [key]: value }));
  }

  onGroupChange(value: number | string): void {
    this.form.update(f => ({ ...f, NOG: Number(value) || 1 }));
  }

  onRegionChange(value: number | string): void {
    this.form.update(f => ({ ...f, MNTKA: Number(value) || null }));
  }

  onFreezeChange(value: number | string): void {
    const twkfx = Number(value) || null;
    this.form.update(f => ({
      ...f,
      TWKFX: twkfx,
      NOKYED: twkfx === 3 ? 1 : 0,
    }));
  }

  async onSearch(): Promise<void> {
    if (this.editable() || this.saving()) return;
    this.clearMessages();
    const q = this.search().trim();
    if (/^\d+$/.test(q)) {
      const numericNoa = Number(q);
      this.selected.set(null);
      await this.openRow(numericNoa);
      if (this.selected() !== numericNoa) {
        this.err.set(this.kind() === 'customer'
          ? 'لا يوجد عميل بهذا الرقم'
          : 'لا يوجد مورد بهذا الرقم');
      }
      return;
    }
    this.selected.set(null);
    await this.fetchList();
  }

  focusSearch(): void {
    if (this.editable() || this.saving()) return;
    this.legacySearchInput?.nativeElement.focus();
    this.legacySearchInput?.nativeElement.select();
  }

  private legacySearchQuery(): { q: string; contains: boolean } {
    const raw = this.search().trim();
    if (!raw) return { q: '', contains: false };
    return raw.startsWith('*')
      ? { q: raw.slice(1).trim(), contains: true }
      : { q: raw, contains: false };
  }

  onNew(): void {
    this.clearMessages();
    this.previousSelected.set(this.selected());
    this.selected.set(null);
    // If a tab is active, prefill TYPEA to that category to save clicks
    const t = this.currentTab();
    const base: PartyForm = t
      ? { ...EMPTY_FORM, TYPEA: t.NOA, TYPEA_NAME: t.NAMEA }
      : { ...EMPTY_FORM };
    this.form.set(base);
    this.audit.set({ ...EMPTY_AUDIT });
    this.mode.set('new');
  }

  onEdit(): void {
    if (this.selected() === null) return;
    this.clearMessages();
    this.mode.set('edit');
  }

  onCancel(): void {
    if (this.editable() && !confirm('هل تريد فعلاً التراجع عن المدخلات والتعديلات التي قمت بها')) return;
    this.clearMessages();
    const current = this.selected();
    const previous = this.previousSelected();
    if (current !== null) void this.openRow(current);
    else if (previous !== null) void this.openRow(previous);
    else {
      this.form.set({ ...EMPTY_FORM });
      this.audit.set({ ...EMPTY_AUDIT });
      this.mode.set('browse');
    }
    this.previousSelected.set(null);
  }

  /** Mirror of backend validatePartyPayload + legacy phone rule. */
  validate(): boolean {
    const f = this.form();
    if (!f.NAMEA.trim()) { this.err.set('اسم الحساب مطلوب'); return false; }
    if (!f.TYPEA || f.TYPEA <= 0) {
      this.err.set('يجب اختيار فئة الحساب'); return false;
    }
    const tel = f.TEL.trim();
    if (tel) {
      if (!/^\d+$/.test(tel)) { this.err.set('رقم الهاتف يجب أن يحتوي أرقاماً فقط'); return false; }
      if (tel.length !== 9)   { this.err.set('رقم الهاتف يجب أن يكون 9 أرقام'); return false; }
      if (!/^(77|71|73|70|78)/.test(tel)) {
        this.err.set('رقم الهاتف يجب أن يبدأ بـ 77 أو 71 أو 73 أو 70 أو 78');
        return false;
      }
    }
    return true;
  }

  async onSave(): Promise<void> {
    if (!this.validate()) return;
    this.saving.set(true); this.clearMessages();
    const f = this.form();
    const { TYPEA_NAME: _ignored, ...rawPayload } = f;
    void _ignored;
    const payload = {
      ...rawPayload,
      NOG: rawPayload.NOG || 1,
      NOKYED: Number(rawPayload.TWKFX ?? 0) === 3 ? 1 : 0,
    };
    try {
      const isNew = this.mode() === 'new';
      const url = isNew ? this.endpoint() : `${this.endpoint()}/${f.NOA}`;
      const method = isNew ? 'POST' : 'PUT';
      const r = await firstValueFrom(
        this.http.request<{ ok: boolean; message?: string; error?: string; noa?: number }>(
          method, url, { body: payload }));
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحفظ');
      this.mode.set('browse');
      this.previousSelected.set(null);
      const newNoa = isNew ? r.noa : f.NOA!;
      await this.fetchList();
      if (newNoa) await this.openRow(newNoa);
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally { this.saving.set(false); }
  }

  async onDelete(): Promise<void> {
    const noa = this.selected();
    if (noa === null) return;
    if (!confirm(`هل أنت متأكد من حذف ${this.entityLabel()} رقم ${noa}؟`)) return;
    this.saving.set(true); this.clearMessages();
    try {
      const r = await firstValueFrom(
        this.http.delete<{ ok: boolean; message?: string; error?: string }>(
          `${this.endpoint()}/${noa}`));
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحذف');
      this.selected.set(null);
      this.previousSelected.set(null);
      this.form.set({ ...EMPTY_FORM });
      this.audit.set({ ...EMPTY_AUDIT });
      this.mode.set('browse');
      await this.fetchList();
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally { this.saving.set(false); }
  }

  // ── Utilities ────────────────────────────────────────────────
  onPrint(): void {
    if (!this.canPr() || this.saving()) return;
    this.clearMessages();
    const screen = this.kind() === 'customer' ? 'DATA_AM' : 'DATA_MO';
    const report = this.kind() === 'customer' ? 'EXD2' : 'EXD3';
    const params = new URLSearchParams({
      report,
      tn: String(this.activeLegacyTypea()),
      nox: String(this.partyRtba()),
      G1: '0',
      G2: '1000',
    });
    this.info.set(this.kind() === 'customer' ? 'تم فتح تقرير عملاء المجموعة للطباعة' : 'تم فتح تقرير موردين المجموعة للطباعة');
    const opened = window.open(`/api/legacy-report/${screen}/print?${params.toString()}`, '_blank');
    if (!opened) {
      window.location.href = `/api/legacy-report/${screen}/print?${params.toString()}`;
    }
  }

  focusPrint(): void {
    if (this.saving()) return;
    this.legacyPrintButton?.nativeElement.focus();
  }

  openGroupScreen(): void {
    if (this.editable() || this.saving()) return;
    const groupScreen = this.kind() === 'customer' ? 'GRP22' : 'GRP';
    void this.router.navigate(['/app/screens', groupScreen], {
      queryParams: {
        from: this.kind() === 'customer' ? 'DATA_AM' : 'DATA_MO',
        tg_grp: this.partyGroupTg(),
      },
    });
  }

  @HostListener('document:keydown', ['$event'])
  handleLegacyKey(event: KeyboardEvent): void {
    if (this.typeaLovOpen() && event.key === 'Escape') {
      event.preventDefault();
      this.closeTypeaLov();
      return;
    }
    if (event.altKey && event.key === 'F4') {
      event.preventDefault();
      if (!this.saving()) this.onExit();
      return;
    }

    switch (event.key) {
      case 'F3':
        event.preventDefault();
        this.focusSearch();
        break;
      case 'F4':
        event.preventDefault();
        this.focusPrint();
        break;
      case 'F6':
        event.preventDefault();
        if (this.canDe() && this.hasCurrent() && !this.editable() && !this.saving()) void this.onDelete();
        break;
      case 'F7':
        event.preventDefault();
        if (this.editable() && !this.saving()) this.onCancel();
        break;
      case 'F8':
        event.preventDefault();
        if (this.canEd() && this.hasCurrent() && !this.editable() && !this.saving()) this.onEdit();
        break;
      case 'F10':
        event.preventDefault();
        if (this.editable() && !this.saving()) void this.onSave();
        else if (this.canIns() && !this.saving() && !this.loading()) this.onNew();
        break;
      case 'Escape':
        event.preventDefault();
        if (this.editable()) this.onCancel();
        else this.onExit();
        break;
    }
  }

  /** Localised date rendering: `dd/MM/yyyy hh:mm a` in Arabic text. */
  fmtDate(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    const hr = d.getHours() % 12 || 12;
    const ampm = d.getHours() < 12 ? 'AM' : 'PM';
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}  ${pad(hr)}:${pad(d.getMinutes())} ${ampm}`;
  }

  trackByNoa  = (_: number, r: PartyListRow) => r.NOA;
  trackByNode = (_: number, n: TreeNode) => n.NOA;
  trackByGroup = (_: number, g: PartyGroup) => g.NOG;

  onExit(): void {
    if (this.editable()) {
      const f = this.form();
      const blankNew = this.mode() === 'new' && !f.NAMEA.trim() && f.NOA === null;
      const leave = blankNew || confirm('\u0647\u0644 \u062A\u0631\u064A\u062F \u0627\u0644\u062E\u0631\u0648\u062C \u0628\u062F\u0648\u0646 \u062D\u0641\u0638\u061F');
      if (!leave) return;
      this.previousSelected.set(null);
      this.mode.set('browse');
    }
    void this.router.navigate(['/app']);
  }
}
