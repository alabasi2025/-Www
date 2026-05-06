import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';
import { LegacyToolbarComponent } from '../../../shared/legacy-ui/legacy-toolbar/legacy-toolbar.component';
import { LegacyStatusBarComponent } from '../../../shared/legacy-ui/legacy-status-bar/legacy-status-bar.component';
import { LegacyAuditFooterComponent } from '../../../shared/legacy-ui/legacy-audit-footer/legacy-audit-footer.component';
import { LegacyToolbarActionId } from '../../../shared/legacy-ui/contracts/legacy-contracts';
import { resolveLegacyShortcut } from '../../../shared/legacy-ui/behaviors/legacy-keyboard-map';
import { LEGACY_SCREEN_SPECS } from '../../../shared/legacy-ui/manifests/legacy-screen-specs';

export interface Account {
  NOA: number;
  NAMEA: string;
  TYPEA: number;
  RTBA: number;
  AHSAR: string | null;
  TSYS: number | null;
  NOSNDOK: number | null;
  AMLHH: number | null;
  NOYSOFT: number | null;
  NOYSOFR: number | null;
  TWKFX: number | null;  // 0=none, 1=ceiling, 2=partial, 3=full (USX required)
  HALL: number | null;
  NOKYED: number | null; // 1 = hide from documents
  NOG: number | null;    // 1 = auto-set for asset accounts (122xxx/221xxx)
  NOAN: number | null;   // sequence within parent TYPEA
  RSM: number | null;   // رصيد افتتاحي مدين
  RSD: number | null;   // رصيد افتتاحي دائن
  RSMA: number | null;  // مدين بالعملة الأجنبية
  RSDA: number | null;  // دائن بالعملة الأجنبية
  MEMOH: string | null;
  // Audit fields (read-only)
  DI?: string | null;   // Date inserted
  DE?: string | null;   // Date edited
  NED?: number | null;  // Edit counter (incremented on every UPDATE)
  PCI?: string | null;  // Client tag at creation
  PCE?: string | null;  // Client tag at last edit
  NOUSX?: number | null;
  NOUSXU?: number | null;
  // From subquery JOIN user_u (mirrors :nms / :nmsU variables in TREE.fmb)
  NMS?: string | null;
  NMSU?: string | null;
}

export interface TreeNode {
  acc: Account;
  children: TreeNode[];
  expanded: boolean;
  depth: number;
}

export interface Currency { NO: number; NAMEM3: string; }

export interface AmhsbRow {
  NOA: number;
  NOAML: number;
  AMLNAME: string | null;
  RSM: number | null;
  RSD: number | null;
  RSMA: number | null;
  RSDA: number | null;
  SARSF: number | null;
  HALL: number | null;
  STOP: number | null;
}

export interface SnfRow {
  NOAA: number;
  NOAML: number;
  AMLNAME: string | null;
  HLS: number | null;
  HALLS: number | null;
  SKF: number | null;
  CAM: number | null;
}

export interface TitlParams {
  AMLH1: number;    // 1 = single-currency mode
  SYSAML: number;   // default currency id
  AMLMHZ: number;   // foreign currency for special stock accounts
  NOMHZN: number | null;  // special stock account prefix
  NOMHZND: number | null;
  ALLAML: number;
}

export const RTBA_LABELS: Record<number, string> = {
  1: 'المستوى 1 — مجموعة رئيسية',
  2: 'المستوى 2',
  3: 'المستوى 3',
  4: 'المستوى 4',
  5: 'حساب تفصيلي',
};

interface MeResponse {
  ok: boolean;
  user?: {
    nou: number;
    name: string;
    statu: number;
    isAdmin: boolean;
    usx: number | null;
    unit: string;
    schema: string;
  };
}

@Component({
  selector: 'app-tree',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    DecimalPipe,
    LegacyToolbarComponent,
    LegacyStatusBarComponent,
    LegacyAuditFooterComponent,
  ],
  templateUrl: './tree.component.html',
  styleUrl: './tree.component.scss',
})
export class TreeComponent implements OnInit {
  private http = inject(HttpClient);
  private permSvc = inject(PermissionService);

  // USERGN screen identifier (matches DATA_ACM.NAMEF for TREE.fmb)
  readonly screenCode = 'TREE.FMX';
  readonly screenSpec = LEGACY_SCREEN_SPECS['TREE'];
  private readonly permsSig = computed(() => this.permSvc.forScreen(this.screenCode)());
  readonly canIns = computed(() => (this.permsSig()?.ins ?? 0) > 0);
  readonly canEd  = computed(() => (this.permsSig()?.ed  ?? 0) > 0);
  readonly canDe  = computed(() => (this.permsSig()?.de  ?? 0) > 0);
  readonly canPr  = computed(() => (this.permsSig()?.pr  ?? 0) > 0);
  readonly canSar = computed(() => (this.permsSig()?.sar ?? 0) > 0);

  // CONT block â€” the 4 cascading hierarchy selectors at the top of the form
  // Mirrors TREE.fmb CONT.NOA1 -> CONT.NOA2 -> CONT.NOA3 -> CONT.NOA4.
  readonly noa1 = signal<number | null>(null);
  readonly noa2 = signal<number | null>(null);
  readonly noa3 = signal<number | null>(null);
  readonly noa4 = signal<number | null>(null);
  // CONT.SNAMEA â€” the text search field in the top-left of the CONT block
  readonly snamea = signal<string>('');

  readonly accounts = signal<Account[]>([]);
  readonly currencies = signal<Currency[]>([]);
  readonly selected = signal<Account | null>(null);
  readonly balance = signal<{ debit: number; credit: number; opening: { debit: number; credit: number } } | null>(null);
  readonly amhsbRows = signal<AmhsbRow[]>([]);
  readonly snfRows = signal<SnfRow[]>([]);
  readonly titl = signal<TitlParams | null>(null);
  readonly me = signal<MeResponse['user'] | null>(null);
  readonly search = signal('');
  readonly expandedSet = signal<Set<number>>(new Set([0])); // root expanded
  readonly mode = signal<'browse' | 'new' | 'edit'>('browse');
  readonly form = signal<Partial<Account>>({});
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);
  readonly filterRtba = signal<number | null>(null);

  // SNF (currency permissions) modal state
  readonly snfModalOpen = signal(false);
  readonly snfNewCurrency = signal<number>(0);
  readonly snfSaving = signal(false);

  // Secondary-canvas properties modal (TWKFX / NOKYED / NOYSOFR / NOYSOFT)
  readonly propsModalOpen = signal(false);
  // Window chrome state
  readonly maximized = signal(false);
  readonly minimized = signal(false);

  // ONYX conditional visibility â€” mirrors :PARAMETER.ysr flag in WHEN-NEW-FORM-INSTANCE
  // IF TSYS=4 AND NOCOPYX=56  OR TSYS=5 AND NOCOPYX=3 AND NOCOPYX2=2 THEN :PARAMETER.ysr := 1
  // In the Angular port, we don't have global.NOCOPYX available, so we derive it
  // conservatively: only admins can see the ONYX fields, and only on level-5 detail accounts.
  readonly showOnyx = computed(() => {
    const u = this.me();
    const r = this.form().RTBA ?? 0;
    return !!u?.isAdmin && r === 5;
  });

  // Build tree from flat list using TYPEA as parent pointer
  readonly tree = computed<TreeNode[]>(() => {
    const all = this.accounts();
    const byParent = new Map<number, Account[]>();
    for (const a of all) {
      const p = a.TYPEA || 0;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p)!.push(a);
    }
    const buildChildren = (parent: number, depth: number): TreeNode[] => {
      const kids = byParent.get(parent) ?? [];
      kids.sort((a, b) => a.NOA - b.NOA);
      return kids.map(acc => ({
        acc,
        children: buildChildren(acc.NOA, depth + 1),
        expanded: this.expandedSet().has(acc.NOA),
        depth,
      }));
    };
    return buildChildren(0, 0);
  });

  // Flatten tree for display — only expanded nodes
  readonly flatRows = computed<TreeNode[]>(() => {
    const rows: TreeNode[] = [];
    const q = this.search().trim().toLowerCase();
    const rtbaF = this.filterRtba();
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        const matchesSearch = !q ||
          n.acc.NAMEA?.toLowerCase().includes(q) ||
          String(n.acc.NOA).includes(q) ||
          n.acc.AHSAR?.toLowerCase().includes(q);
        const matchesRtba = rtbaF === null || n.acc.RTBA === rtbaF;
        if (matchesSearch && matchesRtba) rows.push(n);
        if (n.expanded || q) walk(n.children);
      }
    };
    walk(this.tree());
    return rows;
  });

  readonly counts = computed(() => {
    const acc = this.accounts();
    const byR: Record<number, number> = {};
    acc.forEach(a => { byR[a.RTBA] = (byR[a.RTBA] ?? 0) + 1; });
    return { total: acc.length, byR };
  });

  readonly currencyName = computed(() => {
    const c = this.form()['AMLHH'] ?? this.selected()?.AMLHH;
    return this.currencies().find(x => x.NO === Number(c))?.NAMEM3 ?? 'ريال يمني';
  });

  readonly editable = computed(() => this.mode() === 'new' || this.mode() === 'edit');

  // TWKFX freeze permission: only admin (statu>0) or users with USX>0
  readonly canFreeze = computed(() => {
    const u = this.me();
    if (!u) return false;
    return u.isAdmin || (u.usx !== null && u.usx > 0);
  });

  // Whether this account is a "special stock" account (TITL.NOMHZN prefix match on NOA)
  readonly isSpecialStock = computed(() => {
    const t = this.titl();
    const s = this.selected() ?? (this.form() as Account);
    if (!t || !t.NOMHZN || !s?.NOA) return false;
    return String(s.NOA).startsWith(String(t.NOMHZN));
  });

  async ngOnInit(): Promise<void> {
    await Promise.all([
      this.fetchAccounts(),
      this.fetchCurrencies(),
      this.fetchTitl(),
      this.fetchMe(),
    ]);
  }

  async fetchTitl(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; titl?: TitlParams }>('/api/titl'));
      if (r.ok && r.titl) this.titl.set(r.titl);
    } catch { /**/ }
  }

  async fetchMe(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<MeResponse>('/api/me'));
      if (r.ok) this.me.set(r.user ?? null);
    } catch { /**/ }
  }

  async fetchAccounts(): Promise<void> {
    this.loading.set(true); this.err.set(null);
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; rows?: Account[]; error?: string }>('/api/accounts/tree'));
      if (!r.ok) throw new Error(r.error);
      this.accounts.set(r.rows ?? []);
      // Start collapsed — only the implicit "root" (NOA=0) is "expanded" so
      // the 4 top-level accounts render as collapsed folder nodes (+ icon),
      // matching the original TR.HTREE initial state in TREE.fmb.
      this.expandedSet.set(new Set<number>([0]));
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.loading.set(false);
  }

  async fetchCurrencies(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; items?: Currency[] }>('/api/lov/currencies'));
      if (r.ok) this.currencies.set(r.items ?? []);
    } catch { /**/ }
  }

  toggleExpand(noa: number): void {
    this.expandedSet.update(s => {
      const n = new Set(s);
      if (n.has(noa)) n.delete(noa); else n.add(noa);
      return n;
    });
  }

  expandAll(): void {
    const e = new Set<number>([0]);
    this.accounts().forEach(a => e.add(a.NOA));
    this.expandedSet.set(e);
  }

  collapseAll(): void {
    this.expandedSet.set(new Set<number>());
  }

  async selectAccount(acc: Account): Promise<void> {
    this.err.set(null); this.info.set(null);
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; account?: Account;
        balance?: { debit: number; credit: number; opening: { debit: number; credit: number } }; error?: string }>(`/api/accounts/${acc.NOA}`));
      if (!r.ok) throw new Error(r.error);
      this.selected.set(r.account ?? acc);
      this.balance.set(r.balance ?? null);
      this.form.set({ ...(r.account ?? acc) });
      this.mode.set('browse');
      // Load per-currency balances and SNF in parallel
      await Promise.all([
        this.fetchAmhsbRows(acc.NOA),
        this.fetchSnfRows(acc.NOA),
      ]);
    } catch (e) { this.err.set(String(e)); }
  }

  async fetchAmhsbRows(noa: number): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows?: AmhsbRow[] }>(`/api/accounts/${noa}/balances`)
      );
      this.amhsbRows.set((r.ok && r.rows) ? r.rows : []);
    } catch { this.amhsbRows.set([]); }
  }

  async fetchSnfRows(noa: number): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows?: SnfRow[] }>(`/api/accounts/${noa}/snf`)
      );
      this.snfRows.set((r.ok && r.rows) ? r.rows : []);
    } catch { this.snfRows.set([]); }
  }

  // ═══════ SNF block management ═══════
  openSnfModal(): void {
    this.err.set(null); this.info.set(null);
    this.snfNewCurrency.set(0);
    this.snfModalOpen.set(true);
  }

  closeSnfModal(): void { this.snfModalOpen.set(false); }

  async addSnfRow(): Promise<void> {
    const s = this.selected();
    const noaml = this.snfNewCurrency();
    if (!s || !noaml) { this.err.set('اختر العملة أولاً'); return; }
    // Prevent duplicate client-side
    if (this.snfRows().some(r => r.NOAML === noaml)) {
      this.err.set('هذه العملة مسموحة مسبقاً'); return;
    }
    this.snfSaving.set(true); this.err.set(null);
    try {
      const r = await firstValueFrom(
        this.http.post<{ ok: boolean; error?: string }>(`/api/accounts/${s.NOA}/snf`,
          { NOAML: noaml, HALLS: s.HALL ?? null, HLS: 0 })
      );
      if (!r.ok) throw new Error(r.error);
      await this.fetchSnfRows(s.NOA);
      this.info.set('تمت إضافة العملة');
      this.snfNewCurrency.set(0);
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.snfSaving.set(false);
  }

  async removeSnfRow(row: SnfRow): Promise<void> {
    const s = this.selected();
    if (!s) return;
    if (!confirm(`حذف العملة ${row.AMLNAME ?? row.NOAML} من هذا الحساب؟`)) return;
    this.snfSaving.set(true); this.err.set(null);
    try {
      const r = await firstValueFrom(
        this.http.delete<{ ok: boolean; error?: string }>(`/api/accounts/${s.NOA}/snf/${row.NOAML}`)
      );
      if (!r.ok) throw new Error(r.error);
      await this.fetchSnfRows(s.NOA);
      this.info.set('تم حذف العملة');
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.snfSaving.set(false);
  }

  // Toggle a flag (HLS = توقيف, HALLS = حساب عام) on an existing SNF row
  async toggleSnfFlag(row: SnfRow, flag: 'HLS' | 'HALLS', value: 0 | 1): Promise<void> {
    const s = this.selected();
    if (!s) return;
    // Optimistic update so the UI reflects the change immediately
    const prev = this.snfRows();
    const next = prev.map(r =>
      r.NOAML === row.NOAML ? { ...r, [flag]: value } : r);
    this.snfRows.set(next);
    this.snfSaving.set(true); this.err.set(null);
    try {
      const r = await firstValueFrom(
        this.http.patch<{ ok: boolean; error?: string }>(
          `/api/accounts/${s.NOA}/snf/${row.NOAML}`,
          { [flag]: value })
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(flag === 'HLS'
        ? (value ? 'تم توقيف العملة' : 'تم إلغاء التوقيف')
        : (value ? 'تم تعيين العملة كعامة' : 'تم إلغاء صفة العامة'));
    } catch (e) {
      // Roll back
      this.snfRows.set(prev);
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.snfSaving.set(false);
  }

  getParentName(typea: number): string {
    if (!typea) return 'لا يوجد — حساب رئيسي';
    const p = this.accounts().find(a => a.NOA === typea);
    return p ? `${p.NOA} — ${p.NAMEA}` : `#${typea}`;
  }

  clearMessages(): void { this.err.set(null); this.info.set(null); }

  onToolbarAction(action: LegacyToolbarActionId): void {
    switch (action) {
      case 'new': this.onNew(); break;
      case 'save': void this.onSave(); break;
      case 'search': this.onSnameaSearch(); break;
      case 'print': this.onPrint(); break;
      case 'exit': this.ex1(); break;
      case 'cancel': this.confirmCancel(); break;
      case 'edit': this.onEdit(); break;
      case 'delete': void this.onDelete(); break;
      case 'props': this.openPropsModal(); break;
      default: break;
    }
  }

  selectedRecord(): Record<string, unknown> {
    return (this.selected() ?? {}) as Record<string, unknown>;
  }

  // ══ CONT block cascading selectors ═════════════════
  // NOA1: top-level — mirrors listx ('CONT.noa1',â€¦ where nvl(noa,0)<5)
  readonly noa1Options = computed<Account[]>(() =>
    this.accounts().filter(a => (a.RTBA ?? 0) === 1 && (a.TYPEA ?? 0) === 0).sort((a,b)=>a.NOA-b.NOA));
  // NOA2: rtba=2 (optionally filtered by typea=:noa1)
  //   Matches:  listx ('CONT.noa2' ,â€¦ '  where  nvl(rtba,0)=2 and typea=â€™||:noa1||â€™ order by noa')
  readonly noa2Options = computed<Account[]>(() => {
    const p = this.noa1();
    return this.accounts()
      .filter(a => (a.RTBA ?? 0) === 2 && (p == null || (a.TYPEA ?? 0) === p))
      .sort((a,b)=>a.NOA-b.NOA);
  });
  // NOA3: rtba=3 (optionally filtered by typea=:noa2, else substr(typea,1,1)=:noa1)
  readonly noa3Options = computed<Account[]>(() => {
    const p2 = this.noa2(); const p1 = this.noa1();
    return this.accounts()
      .filter(a => {
        if ((a.RTBA ?? 0) !== 3) return false;
        if (p2) return (a.TYPEA ?? 0) === p2;
        if (p1) return String(a.TYPEA ?? '').startsWith(String(p1));
        return true;
      })
      .sort((a,b)=>a.NOA-b.NOA);
  });
  // NOA4: rtba=4 (optionally filtered by typea=:noa3, else substr(typea,1,2)=:noa2, else substr(typea,1,1)=:noa1)
  readonly noa4Options = computed<Account[]>(() => {
    const p3 = this.noa3(); const p2 = this.noa2(); const p1 = this.noa1();
    return this.accounts()
      .filter(a => {
        if ((a.RTBA ?? 0) !== 4) return false;
        if (p3) return (a.TYPEA ?? 0) === p3;
        if (p2) return String(a.TYPEA ?? '').startsWith(String(p2));
        if (p1) return String(a.TYPEA ?? '').startsWith(String(p1));
        return true;
      })
      .sort((a,b)=>a.NOA-b.NOA);
  });

  onNoa1Change(v: number | null): void {
    this.noa1.set(v); this.noa2.set(null); this.noa3.set(null); this.noa4.set(null);
    if (v) { const a = this.accounts().find(x => x.NOA === v); if (a) void this.selectAccount(a); }
  }
  onNoa2Change(v: number | null): void {
    this.noa2.set(v); this.noa3.set(null); this.noa4.set(null);
    if (v) { const a = this.accounts().find(x => x.NOA === v); if (a) void this.selectAccount(a); }
  }
  onNoa3Change(v: number | null): void {
    this.noa3.set(v); this.noa4.set(null);
    if (v) { const a = this.accounts().find(x => x.NOA === v); if (a) void this.selectAccount(a); }
  }
  onNoa4Change(v: number | null): void {
    this.noa4.set(v);
    if (v) { const a = this.accounts().find(x => x.NOA === v); if (a) void this.selectAccount(a); }
  }

  // Keep the top-left search input dual-purpose:
  // - live filter in the tree list
  // - Enter key still executes the legacy NAMEA/NOA lookup.
  onSnameaInput(v: string): void {
    this.snamea.set(v ?? '');
    this.search.set((v ?? '').trim());
  }

  // CONT.SNAMEA — KEY-NEXT-ITEM trigger: search by name or NOA
  // Mirrors:  select max(namea),max(noa) into :snamea,:NOA from data_ac where noa = to_number(:snamea)
  async onSnameaSearch(): Promise<void> {
    const s = this.snamea().trim();
    if (!s) return;
    this.clearMessages();
    const asNum = Number(s);
    if (Number.isFinite(asNum) && asNum > 0) {
      const acc = this.accounts().find(a => a.NOA === asNum);
      if (acc) { this.snamea.set(acc.NAMEA); await this.selectAccount(acc); return; }
      this.err.set('لا يوجد حساب بهذا الرقم');
      return;
    }
    const q = s.toLowerCase();
    const hit = this.accounts().find(a => (a.NAMEA || '').toLowerCase().includes(q));
    if (hit) { this.snamea.set(hit.NAMEA); await this.selectAccount(hit); }
    else this.err.set('لا يوجد حساب مطابق');
  }

  onNew(): void {
    this.err.set(null); this.info.set(null);
    const parent = this.selected();
    const t = this.titl();
    this.form.set({
      TYPEA: parent?.NOA ?? 0,
      RTBA: parent ? Math.min(5, parent.RTBA + 1) : 1,
      AMLHH: t?.SYSAML ?? 1,     // default currency from TITL.SYSAML
      TSYS: 1,
    });
    this.mode.set('new');
  }

  onEdit(): void {
    if (!this.selected()) return;
    this.err.set(null); this.info.set(null);
    this.form.set({ ...this.selected()! });
    this.mode.set('edit');
  }

  onCancel(): void {
    this.form.set(this.selected() ? { ...this.selected()! } : {});
    this.mode.set('browse');
  }

  // `ex1` — procedure from TREE.fmb that collapses the tree, clears all
  // CONT cascading selectors, and resets the selection before the form
  // actually exits. Wired to the red close button (EX) and Escape key.
  //
  // Mirrors KEY-EXIT trigger: if the form has unsaved changes show the
  // alert 'ms' with text "هل تريد الخروج بدون حفظ" before calling ex1.
  ex1(): void {
    if (this.editable()) {
      if (!confirm('هل تريد الخروج بدون حفظ  ')) return;
    }
    this.collapseAll();
    this.noa1.set(null); this.noa2.set(null);
    this.noa3.set(null); this.noa4.set(null);
    this.snamea.set('');
    this.search.set('');
    this.selected.set(null); this.form.set({});
    this.amhsbRows.set([]); this.snfRows.set([]);
    this.mode.set('browse');
    this.err.set(null); this.info.set(null);
    this.propsModalOpen.set(false);
    this.snfModalOpen.set(false);
  }

  // F7 تراجع — mirrors the alert `mss` in TREE.fmb (KEY-ENTQRY / cz procedure)
  // Alert text (from strings[]): "هل تريد فعلاً التراجع عن المدخلات والتعديلات التي قمت بها"
  confirmCancel(): void {
    if (!this.editable()) return;
    if (confirm('هل تريد فعلاً التراجع عن المدخلات والتعديلات التي قمت بها')) {
      this.onCancel();
    }
  }

  setField(f: keyof Account, v: unknown): void {
    this.form.update(x => ({ ...x, [f]: v }));
  }

  async onSave(): Promise<void> {
    const f = this.form();
    if (!f.NOA) { this.err.set('رقم الحساب مطلوب'); return; }
    if (!f.NAMEA?.trim()) { this.err.set('اسم الحساب مطلوب'); return; }
    if (!f.RTBA) { this.err.set('رتبة الحساب مطلوبة'); return; }

    // Client-side uniqueness pre-check: NAMEA under same TYPEA
    const nameLower = (f.NAMEA || '').trim().toLowerCase();
    const typea = Number(f.TYPEA ?? 0);
    const dup = this.accounts().find(a =>
      a.NOA !== f.NOA &&
      Number(a.TYPEA ?? 0) === typea &&
      (a.NAMEA || '').trim().toLowerCase() === nameLower);
    if (dup) {
      this.err.set(`الاسم "${f.NAMEA}" مقيد مسبقاً تحت نفس الحساب الرئيسي (رقم ${dup.NOA})`);
      return;
    }

    // TWKFX validation: only level 3 requires USX (levels 1, 2 are open)
    const twkfxVal = Number(f.TWKFX ?? 0);
    if (twkfxVal < 0 || twkfxVal > 3) {
      this.err.set('قيمة مستوى التجميد غير صالحة (المسموح 0-3)');
      return;
    }
    if (twkfxVal === 3 && !this.canFreeze()) {
      this.err.set('المستوى 3 (تجميد كامل) يتطلب صلاحية USER_U.USX');
      return;
    }

    this.saving.set(true); this.err.set(null);
    try {
      const isNew = this.mode() === 'new';
      const url = isNew ? '/api/accounts' : `/api/accounts/${f.NOA}`;
      const r = await firstValueFrom(
        this.http.request<{ ok: boolean; error?: string }>(
          isNew ? 'POST' : 'PUT', url, { body: f }
        )
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(isNew ? 'تم إنشاء الحساب' : 'تم حفظ التعديلات');
      this.mode.set('browse');
      await this.fetchAccounts();
      // re-select
      const saved = this.accounts().find(a => a.NOA === f.NOA);
      if (saved) await this.selectAccount(saved);
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  async onDelete(): Promise<void> {
    const s = this.selected();
    if (!s) return;
    if (!confirm(`حذف الحساب ${s.NOA} — ${s.NAMEA}؟`)) return;
    this.saving.set(true); this.err.set(null);
    try {
      const r = await firstValueFrom(
        this.http.delete<{ ok: boolean; error?: string }>(`/api/accounts/${s.NOA}`)
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set('تم الحذف');
      this.selected.set(null); this.balance.set(null); this.form.set({});
      this.amhsbRows.set([]); this.snfRows.set([]);
      await this.fetchAccounts();
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  // ══ Window chrome handlers (Oracle Forms 6i feel) ═════════
  onMinimize(): void { this.minimized.set(!this.minimized()); }
  onMaximize(): void {
    this.maximized.set(!this.maximized());
    this.minimized.set(false);
  }

  // POST-TEXT-ITEM on DATA_A.NAMEA — original trigger fires on field-exit:
  //   select namea into s_na from data_ac where namea=:data_a.NAMEa and typea=:data_a.typea
  //   → raise form_trigger_failure if duplicate found under same parent.
  onNameaBlur(): void {
    const f = this.form();
    if (!this.editable() || !f.NAMEA?.trim()) return;
    const nameLower = f.NAMEA.trim().toLowerCase();
    const typea = Number(f.TYPEA ?? 0);
    const dup = this.accounts().find(a =>
      a.NOA !== f.NOA &&
      Number(a.TYPEA ?? 0) === typea &&
      (a.NAMEA || '').trim().toLowerCase() === nameLower);
    if (dup) {
      this.err.set(`الاسم "${f.NAMEA}" مقيد مسبقاً تحت الحساب الرئيسي رقم ${dup.NOA} — ${dup.NAMEA}`);
    } else if (this.err()?.startsWith('الاسم')) {
      this.err.set(null);
    }
  }

  // ══ Secondary canvas (TWKFX / NOKYED / NOYSOFR / NOYSOFT) ═
  openPropsModal(): void {
    if (!this.selected()) return;
    this.propsModalOpen.set(true);
  }
  closePropsModal(): void { this.propsModalOpen.set(false); }

  // ══ PRN — F6/print button. Mirrors PROCEDURE PRN in TREE.fmb. ═
  // The original generated a printable list of account details via
  // Oracle Reports. We render the same information as a browser-print
  // friendly view and invoke window.print().
  onPrint(): void {
    const a = this.selected();
    if (!a) { this.err.set('لا يوجد حساب محدد للطباعة'); return; }
    // Legacy Reports "exd" output included the tree context header and the
    // account fields (noa, namea, rtba, ahsar, hall, twkfx, memoh) plus the
    // currency permissions grid from amhsb. We replicate the same report
    // body in a hidden iframe so the user can print without losing state.
    const frame = document.createElement('iframe');
    frame.style.position = 'fixed';
    frame.style.left = '-9999px'; frame.style.width = '0'; frame.style.height = '0';
    document.body.appendChild(frame);
    const d = frame.contentDocument!;
    const money = (n: number | null | undefined) =>
      n == null ? '' : Number(n).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const escape = (s: unknown) => String(s ?? '').replace(/[<>&]/g,
      c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] ?? c));
    const snf = this.snfRows().map(r => `
      <tr><td>${escape(this.currencyNameById(r.NOAML))}</td>
          <td>${r.HLS === 1 ? '✓' : ''}</td>
          <td>${money(r.SKF)}</td></tr>`).join('');
    d.open();
    d.write(`<!doctype html><html dir="rtl" lang="ar"><head>
      <meta charset="utf-8"><title>دليل الحسابات — ${escape(a.NAMEA)}</title>
      <style>
        body{font:12pt Tahoma,Arial;padding:20mm;color:#000;}
        h1{font-size:14pt;text-align:center;border-bottom:2px solid #000;padding-bottom:6pt;}
        table{width:100%;border-collapse:collapse;margin:8pt 0;}
        td,th{border:1px solid #000;padding:4pt 6pt;text-align:right;}
        th{background:#ddd;font-weight:bold;}
        .lbl{width:140px;font-weight:bold;background:#f0f0f0;}
        .footer{margin-top:16pt;font-size:9pt;color:#555;text-align:center;}
      </style></head><body>
      <h1>دليل الحسابات — بطاقة حساب</h1>
      <table>
        <tr><td class="lbl">رقم الحساب</td><td>${escape(a.NOA)}</td>
            <td class="lbl">الرتبة</td><td>${escape(a.RTBA)}</td></tr>
        <tr><td class="lbl">اسم الحساب</td><td colspan="3">${escape(a.NAMEA)}</td></tr>
        <tr><td class="lbl">اختصار</td><td>${escape(a.AHSAR)}</td>
            <td class="lbl">حساب عام</td><td>${a.HALL === 1 ? 'نعم' : 'لا'}</td></tr>
        <tr><td class="lbl">تجميد</td><td>${this.twkfxLabel(a.TWKFX)}</td>
            <td class="lbl">ملاحظة</td><td>${escape(a.MEMOH)}</td></tr>
      </table>
      <h2 style="font-size:12pt">عملات الحساب</h2>
      <table><thead><tr><th>العملة</th><th>توقيف</th><th>السقف</th></tr></thead>
        <tbody>${snf || '<tr><td colspan="3" style="text-align:center">-</td></tr>'}</tbody>
      </table>
      <div class="footer">
        مدخل: ${escape(a.NMS ?? a.NOUSX)} | تاريخ الإدخال: ${escape(a.DI)} |
        معدل: ${escape(a.NMSU ?? a.NOUSXU)} | تاريخ التعديل: ${escape(a.DE)} |
        عدد مرات التعديل: ${escape(a.NED)}
      </div>
    </body></html>`);
    d.close();
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    setTimeout(() => document.body.removeChild(frame), 1000);
  }

  // Keyboard shortcuts (match TREE.fmb KEY-* triggers)
  @HostListener('keydown', ['$event'])
  onKeydown(ev: KeyboardEvent): void {
    const shortcut = resolveLegacyShortcut(ev, {
      allowWhenInput: {
        refresh: true,
      },
    });
    if (!shortcut) return;

    switch (shortcut) {
      case 'search':
        ev.preventDefault();
        (document.querySelector<HTMLInputElement>('.cont-search input'))?.focus();
        break;
      case 'refresh':
        ev.preventDefault();
        (document.querySelector<HTMLButtonElement>('.legacy-toolbar .lgt-btn[data-action="print"]'))?.focus();
        break;
      case 'print':
        ev.preventDefault();
        if (this.canPr() && this.selected()) this.onPrint();
        break;
      case 'cancel':
        ev.preventDefault();
        this.confirmCancel();
        break;
      case 'edit':
        ev.preventDefault();
        if (!this.editable() && this.canEd() && this.selected()) this.onEdit();
        break;
      case 'save':
        ev.preventDefault();
        if (this.editable()) void this.onSave();
        break;
      case 'props':
        ev.preventDefault();
        if (this.selected()) this.openPropsModal();
        break;
      case 'exit':
        ev.preventDefault();
        this.ex1();
        break;
    }
  }
  // Helpers
  rtbaLabel(r: number): string { return RTBA_LABELS[r] ?? `مستوى ${r}`; }
  trackByNoa(_: number, n: TreeNode): number { return n.acc.NOA; }
  trackByNoaml(_: number, r: { NOAML: number }): number { return r.NOAML; }
  currencyNameById(id: number | null | undefined): string {
    if (!id) return '-';
    return this.currencies().find(c => c.NO === Number(id))?.NAMEM3 ?? `#${id}`;
  }
  twkfxLabel(v: number | null | undefined): string {
    const n = Number(v ?? 0);
    return n === 1 ? 'السقف'
      : n === 2 ? 'تجميد مدين / تنبيه دائن'
      : n === 3 ? 'تجميد كامل - يتطلب USX'
      : 'بدون تجميد';
  }
  // Currencies not already in the SNF list for this account
  readonly availableCurrencies = computed<Currency[]>(() => {
    const used = new Set(this.snfRows().map(r => r.NOAML));
    return this.currencies().filter(c => !used.has(c.NO));
  });
  Math = Math;
}
