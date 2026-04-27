import {
  Component, OnInit, signal, computed, inject, ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ActionToolbarComponent, type ToolbarAction } from '../../../shared/action-toolbar/action-toolbar.component';
import { StatusStripComponent, type StatusBadge } from '../../../shared/status-strip/status-strip.component';
import { PermissionService } from '../../../services/permission.service';

/** Row shape returned by the lightweight list endpoint. */
export interface ItemListRow {
  NOA: number;
  NAMEA: string | null;
  TYPEA: number;
  NOAN: number | null;
  AHSAR: string | null;
  NOPARCOD: string | null;
  KSR: number;
  WG: number | null;
  MINS: number | null;
  MAXS: number | null;
}

/** Full item record — mirrors DATA_AG columns relevant to the screen. */
export interface ItemRow {
  NOA: number;
  TYPEA: number;
  NOAN: number | null;
  RTBA: number;
  NAMEA: string | null;
  NAMEA2: string | null;
  NAMEA3: string | null;
  NAMEB: string | null;
  AHSAR: string | null;
  NOPARCOD: string | null;
  AMLHH: number | null;
  NOASYS: number | null;
  // dimensions
  A1: string | null; N1: number | null;
  A2: string | null; N2: number | null; X2: number | null;
  A3: string | null; N3: number | null; X3: number | null;
  A4: string | null; N4: number | null; X4: number | null;
  A5: string | null; N5: number | null; X5: number | null;
  // pricing / stock
  KSR: number; WKS: unknown;
  NSBR: number | null;
  MINS: number | null;  MAXS: number | null;
  MINSG: number | null; MAXSG: number | null;
  WG: number | null; WB: number | null; WS: number | null;
  MAXB: number | null; TLB: number | null;
  NHT: number | null; NHG: number | null;
  // flags
  SHD: number; DN: number; HL: number; HGZ: number;
  SMR: number; NKD: number; NORGA: number;
  // accounting
  AML_SNF: number; AB_AML_SNF: number | null; N_AML_SNF: number | null;
  MOKA: string | null;
  // audit
  NOUSX: number | null; NOUSXU: number | null;
}

/** Group node for TYPEA LOV (RTBA=2). */
interface GroupNode {
  NOA: number;
  NAMEA: string;
  TYPEA: number;
  RTBA: number;
}

/** Writable form model backing the template. */
interface ItemForm {
  NOA: number | null;
  TYPEA: number | null;
  TYPEA_NAME: string;
  NOAN: number | null;
  NAMEA: string;  NAMEA2: string;  NAMEA3: string;
  NAMEB: string;
  AHSAR: string;
  NOPARCOD: string;
  AMLHH: number | null;
  NOASYS: number | null;
  A1: string; N1: number | null;
  A2: string; N2: number | null; X2: number | null;
  A3: string; N3: number | null; X3: number | null;
  A4: string; N4: number | null; X4: number | null;
  A5: string; N5: number | null; X5: number | null;
  KSR: number; WKS: number | null;
  NSBR: number | null;
  MINS: number | null;  MAXS: number | null;
  MINSG: number | null; MAXSG: number | null;
  WG: number | null; WB: number | null; WS: number | null;
  MAXB: number | null; TLB: number | null;
  NHT: number | null; NHG: number | null;
  SHD: number; DN: number; HL: number; HGZ: number;
  SMR: number; NKD: number; NORGA: number;
  AML_SNF: number; AB_AML_SNF: number | null; N_AML_SNF: number | null;
  MOKA: string;
}

const EMPTY_FORM: ItemForm = {
  NOA: null, TYPEA: null, TYPEA_NAME: '', NOAN: null,
  NAMEA: '', NAMEA2: '', NAMEA3: '', NAMEB: '',
  AHSAR: '', NOPARCOD: '', AMLHH: null, NOASYS: null,
  A1: '', N1: null,
  A2: '', N2: null, X2: null,
  A3: '', N3: null, X3: null,
  A4: '', N4: null, X4: null,
  A5: '', N5: null, X5: null,
  KSR: 0, WKS: null,
  NSBR: null,
  MINS: null, MAXS: null, MINSG: null, MAXSG: null,
  WG: null, WB: null, WS: null,
  MAXB: null, TLB: null, NHT: null, NHG: null,
  SHD: 0, DN: 0, HL: 0, HGZ: 0, SMR: 0, NKD: 0, NORGA: 0,
  AML_SNF: 0, AB_AML_SNF: null, N_AML_SNF: null,
  MOKA: '',
};

type TabKey = 'basic' | 'dimensions' | 'pricing' | 'flags' | 'accounting';

/**
 * DATA_SN — بيانات الأصناف (inventory item master data).
 * Mirrors the legacy DATA_SN.fmb screen. The 80+ columns are split across
 * five tabs for ergonomics while sharing a single form model.
 */
@Component({
  selector: 'app-data-sn',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ActionToolbarComponent, StatusStripComponent],
  templateUrl: './data-sn.component.html',
  styleUrl: './data-sn.component.scss',
})
export class DataSnComponent implements OnInit {
  private http = inject(HttpClient);
  private permSvc = inject(PermissionService);

  readonly screenCode = 'DATA_SN.FMX';

  // ── Permissions ─────────────────────────────────────
  private readonly perms = computed(() => this.permSvc.forScreen(this.screenCode)());
  readonly canIns = computed(() => (this.perms()?.ins ?? 0) > 0);
  readonly canEd  = computed(() => (this.perms()?.ed  ?? 0) > 0);
  readonly canDe  = computed(() => (this.perms()?.de  ?? 0) > 0);

  // ── State ───────────────────────────────────────────
  readonly rows       = signal<ItemListRow[]>([]);
  readonly form       = signal<ItemForm>({ ...EMPTY_FORM });
  readonly selected   = signal<number | null>(null);
  readonly mode       = signal<'browse' | 'new' | 'edit'>('browse');
  readonly loading    = signal(false);
  readonly saving     = signal(false);
  readonly err        = signal<string | null>(null);
  readonly info       = signal<string | null>(null);
  readonly search     = signal('');
  readonly groupFilter = signal<number>(0);
  readonly activeTab  = signal<TabKey>('basic');

  // Groups LOV
  readonly groups     = signal<GroupNode[]>([]);
  readonly groupLovOpen   = signal(false);
  readonly groupLovSearch = signal('');

  // ── Derived ─────────────────────────────────────────
  readonly editable   = computed(() => this.mode() !== 'browse');
  readonly hasCurrent = computed(() => this.selected() !== null);

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const g = this.groupFilter();
    return this.rows().filter(r => {
      if (g > 0 && r.TYPEA !== g) return false;
      if (!q) return true;
      return String(r.NOA).includes(q)
          || (r.NAMEA ?? '').toLowerCase().includes(q)
          || (r.AHSAR ?? '').toLowerCase().includes(q)
          || (r.NOPARCOD ?? '').toLowerCase().includes(q);
    });
  });

  readonly groupLovFiltered = computed(() => {
    const q = this.groupLovSearch().trim().toLowerCase();
    if (!q) return this.groups();
    return this.groups().filter(n =>
      String(n.NOA).includes(q) || n.NAMEA.toLowerCase().includes(q),
    );
  });

  readonly statusBadges = computed<StatusBadge[]>(() => {
    const f = this.form(); const out: StatusBadge[] = [];
    if (f.NOA !== null) out.push({ label: `رقم: ${f.NOA}`, icon: 'pi-hashtag', variant: 'info' });
    if (f.TYPEA) {
      out.push({
        label: `فئة: ${f.TYPEA}${f.TYPEA_NAME ? ' — ' + f.TYPEA_NAME : ''}`,
        icon: 'pi-folder', variant: 'info',
      });
    }
    if (f.NOPARCOD) out.push({ label: `باركود: ${f.NOPARCOD}`, icon: 'pi-barcode', variant: 'info' });
    if (f.KSR === 1) out.push({ label: 'يقبل كسور', icon: 'pi-calculator', variant: 'success' });
    if (f.SHD === 1) out.push({ label: 'خدمي', icon: 'pi-briefcase', variant: 'info' });
    if (f.DN === 1)  out.push({ label: 'موقوف', icon: 'pi-ban', variant: 'warning' });
    return out;
  });

  /** Quick access to disable flag across tabs. */
  readonly disabled = computed(() => !this.editable());

  // Rule-based effects for UI hints
  readonly computedDimension = computed(() => {
    const f = this.form();
    return (f.X3 ?? 0) > 0 || (f.X4 ?? 0) > 0 || (f.X5 ?? 0) > 0;
  });

  clearMessages(): void { this.err.set(null); this.info.set(null); }

  updateField<K extends keyof ItemForm>(key: K, value: ItemForm[K]): void {
    this.form.update(f => ({ ...f, [key]: value }));
  }

  setTab(t: TabKey): void { this.activeTab.set(t); }

  // ── Lifecycle ──────────────────────────────────────
  async ngOnInit(): Promise<void> {
    await Promise.all([this.fetchList(), this.fetchGroups()]);
  }

  async fetchList(): Promise<void> {
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: ItemListRow[]; error?: string }>('/api/items'),
      );
      if (!r.ok) throw new Error(r.error);
      this.rows.set(r.rows ?? []);
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.loading.set(false);
  }

  async fetchGroups(): Promise<void> {
    if (this.groups().length) return;
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: GroupNode[] }>('/api/items/groups'),
      );
      if (r.ok) this.groups.set(r.rows ?? []);
    } catch { /* silent */ }
  }

  async openRow(noa: number): Promise<void> {
    this.clearMessages();
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; record: ItemRow; error?: string }>(`/api/items/${noa}`),
      );
      if (!r.ok) throw new Error(r.error);
      this.selected.set(noa);
      this.form.set(this.toForm(r.record));
      this.mode.set('browse');
      this.activeTab.set('basic');
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.loading.set(false);
  }

  private toForm(r: ItemRow): ItemForm {
    const group = this.groups().find(g => g.NOA === r.TYPEA);
    return {
      NOA: r.NOA, TYPEA: r.TYPEA, TYPEA_NAME: group?.NAMEA ?? '',
      NOAN: r.NOAN,
      NAMEA: r.NAMEA ?? '', NAMEA2: r.NAMEA2 ?? '', NAMEA3: r.NAMEA3 ?? '',
      NAMEB: r.NAMEB ?? '',
      AHSAR: r.AHSAR ?? '', NOPARCOD: r.NOPARCOD ?? '',
      AMLHH: r.AMLHH, NOASYS: r.NOASYS,
      A1: r.A1 ?? '', N1: r.N1,
      A2: r.A2 ?? '', N2: r.N2, X2: r.X2,
      A3: r.A3 ?? '', N3: r.N3, X3: r.X3,
      A4: r.A4 ?? '', N4: r.N4, X4: r.X4,
      A5: r.A5 ?? '', N5: r.N5, X5: r.X5,
      KSR: Number(r.KSR ?? 0),
      WKS: typeof r.WKS === 'number' ? r.WKS : null,
      NSBR: r.NSBR,
      MINS: r.MINS, MAXS: r.MAXS, MINSG: r.MINSG, MAXSG: r.MAXSG,
      WG: r.WG, WB: r.WB, WS: r.WS,
      MAXB: r.MAXB, TLB: r.TLB, NHT: r.NHT, NHG: r.NHG,
      SHD: Number(r.SHD ?? 0), DN: Number(r.DN ?? 0),
      HL: Number(r.HL ?? 0), HGZ: Number(r.HGZ ?? 0),
      SMR: Number(r.SMR ?? 0), NKD: Number(r.NKD ?? 0),
      NORGA: Number(r.NORGA ?? 0),
      AML_SNF: Number(r.AML_SNF ?? 0),
      AB_AML_SNF: r.AB_AML_SNF, N_AML_SNF: r.N_AML_SNF,
      MOKA: r.MOKA ?? '',
    };
  }

  // ── Group LOV ──────────────────────────────────────
  openGroupLov(): void {
    if (!this.editable() || this.mode() === 'edit') return;
    this.groupLovSearch.set('');
    this.groupLovOpen.set(true);
  }
  closeGroupLov(): void { this.groupLovOpen.set(false); }
  pickGroup(n: GroupNode): void {
    this.form.update(f => ({ ...f, TYPEA: n.NOA, TYPEA_NAME: n.NAMEA }));
    this.groupLovOpen.set(false);
  }

  // ── Toolbar handlers ───────────────────────────────
  onNew(): void {
    this.clearMessages();
    this.selected.set(null);
    this.form.set({ ...EMPTY_FORM });
    this.mode.set('new');
    this.activeTab.set('basic');
  }

  onEdit(): void {
    if (this.selected() === null) return;
    this.clearMessages();
    this.mode.set('edit');
  }

  onCancel(): void {
    this.clearMessages();
    if (this.selected() !== null) void this.openRow(this.selected()!);
    else { this.form.set({ ...EMPTY_FORM }); this.mode.set('browse'); }
  }

  /** Mirror of backend validateItemPayload. */
  validate(): boolean {
    const f = this.form();
    if (!f.NAMEA.trim()) { this.err.set('اسم الصنف مطلوب'); this.activeTab.set('basic'); return false; }
    if (!f.TYPEA || f.TYPEA <= 0) {
      this.err.set('يجب اختيار مجموعة الصنف'); this.activeTab.set('basic'); return false;
    }
    if (this.computedDimension() && f.KSR === 1) {
      this.err.set('الأصناف ذات الأبعاد المحسوبة لا تقبل الكسور');
      this.activeTab.set('dimensions');
      return false;
    }
    if ((f.MINS ?? 0) > 0 && (f.MAXS ?? 0) > 0 && (f.MAXS ?? 0) < (f.MINS ?? 0)) {
      this.err.set('الحد الأقصى للبيع يجب أن يكون ≥ الحد الأدنى');
      this.activeTab.set('pricing'); return false;
    }
    if ((f.MINSG ?? 0) > 0 && (f.MAXSG ?? 0) > 0 && (f.MAXSG ?? 0) < (f.MINSG ?? 0)) {
      this.err.set('الحد الأقصى للجملة يجب أن يكون ≥ الحد الأدنى');
      this.activeTab.set('pricing'); return false;
    }
    return true;
  }

  async onSave(): Promise<void> {
    if (!this.validate()) return;
    this.saving.set(true); this.clearMessages();
    const f = this.form();
    const { TYPEA_NAME: _ignore, ...payload } = f;
    void _ignore;
    try {
      const isNew = this.mode() === 'new';
      const url = isNew ? '/api/items' : `/api/items/${f.NOA}`;
      const method = isNew ? 'POST' : 'PUT';
      const r = await firstValueFrom(
        this.http.request<{ ok: boolean; message?: string; error?: string; noa?: number }>(
          method, url, { body: payload },
        ),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحفظ');
      this.mode.set('browse');
      const newNoa = isNew ? r.noa : f.NOA!;
      await this.fetchList();
      if (newNoa) await this.openRow(newNoa);
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  async onDelete(): Promise<void> {
    const noa = this.selected();
    if (noa === null) return;
    if (!confirm(`هل أنت متأكد من حذف الصنف رقم ${noa}؟`)) return;
    this.saving.set(true); this.clearMessages();
    try {
      const r = await firstValueFrom(
        this.http.delete<{ ok: boolean; message?: string; error?: string }>(`/api/items/${noa}`),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحذف');
      this.selected.set(null);
      this.form.set({ ...EMPTY_FORM });
      this.mode.set('browse');
      await this.fetchList();
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  onToolbarAction(a: ToolbarAction): void {
    switch (a) {
      case 'new':     this.onNew(); break;
      case 'edit':    this.onEdit(); break;
      case 'delete':  void this.onDelete(); break;
      case 'save':    void this.onSave(); break;
      case 'cancel':  this.onCancel(); break;
      case 'refresh': void this.fetchList(); break;
      default: break;
    }
  }

  trackByNoa  = (_: number, r: ItemListRow) => r.NOA;
  trackByNode = (_: number, n: GroupNode)   => n.NOA;
}
