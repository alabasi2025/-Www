/**
 * FB — فاتورة مبيعات (Sales Invoice)
 *
 * Reference: _forms_kb/FB.json (605KB), _forms_plsql/fb.md (229KB)
 * Tables: FB (83 cols, master) + FBF (66 cols, detail)
 * TYPEMS=6, 103 items, 327 triggers, 17 tables
 *
 * Master: FB (customer NOA, date, amounts, currency, warehouse, cost center)
 * Detail: FBF (item NOA from DATA_AG, quantity KMA, price SARW, total TOTLSH, discount HSMG)
 *
 * Key features:
 *   - Item LOV from DATA_AG (by name, NOA, or barcode PARCOD)
 *   - Auto-compute: TOTLSH = KMA * SARW, discount, net total
 *   - Currency conversion (SARSF)
 *   - Warehouse (NOMHZND from DATA_MH)
 *   - Posting: UPDATE FB SET MRHL=0, NOK=:k
 *   - Sales rep commission (NO_MB from M_MB)
 */
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, DecimalPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';
import { LegacyToolbarComponent } from '../../../shared/legacy-ui/legacy-toolbar/legacy-toolbar.component';
import { LegacyStatusBarComponent } from '../../../shared/legacy-ui/legacy-status-bar/legacy-status-bar.component';
import { LegacyAuditFooterComponent } from '../../../shared/legacy-ui/legacy-audit-footer/legacy-audit-footer.component';
import { LovPickerComponent, type LovAccount } from '../../../shared/lov-picker/lov-picker.component';
import { LegacyToolbarActionId } from '../../../shared/legacy-ui/contracts/legacy-contracts';

type Row = Record<string, unknown>;
type Mode = 'browse' | 'new' | 'edit';

interface DetailRow extends Row {
  _key: number;
  RECNO: number;
  NOA: number | null;
  NAMEA: string;
  NOAG: number | null;
  KMA: number;
  SARW: number;
  TOTLSH: number;
  HSMG: number;
  NRB: number;
  MEMOSF: string;
  NOMHZN: number | null;
}

interface ItemResult { NOA: number; NAMEA: string; NOAN: number; SART: number; }

const emptyDetail = (): DetailRow => ({
  _key: Date.now() + Math.random(), RECNO: 0, NOA: null, NAMEA: '', NOAG: null,
  KMA: 0, SARW: 0, TOTLSH: 0, HSMG: 0, NRB: 0, MEMOSF: '', NOMHZN: null,
});

@Component({
  selector: 'app-fb',
  imports: [CommonModule, FormsModule, DecimalPipe, DatePipe,
    LegacyToolbarComponent, LegacyStatusBarComponent, LegacyAuditFooterComponent, LovPickerComponent],
  templateUrl: './fb.component.html',
  styleUrl: './fb.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FbComponent implements OnInit {
  private http = inject(HttpClient);
  private route = inject(ActivatedRoute);
  private perms = inject(PermissionService);

  // State
  readonly mode = signal<Mode>('browse');
  readonly saving = signal(false);
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);

  // Data
  readonly master = signal<Row>({});
  readonly details = signal<DetailRow[]>([emptyDetail()]);
  readonly invoices = signal<Row[]>([]);
  readonly currentIdx = signal(0);

  // LOV
  readonly lovIsOpen = signal(false);
  readonly lovTarget = signal<'master' | number>('master');
  readonly itemLovOpen = signal(false);
  readonly itemLovTarget = signal(0);
  readonly itemSearchResults = signal<ItemResult[]>([]);
  readonly itemSearchQ = signal('');

  // Permissions
  readonly canIns = signal(true);
  readonly canEd = signal(true);
  readonly canDe = signal(true);

  // Computed
  readonly editable = computed(() => this.mode() === 'new' || this.mode() === 'edit');
  readonly posted = computed(() => Number(this.master()['MRHL'] ?? 1) === 0);

  readonly subtotal = computed(() =>
    this.details().reduce((s, d) => s + Number(d.TOTLSH || 0), 0)
  );
  readonly totalDiscount = computed(() =>
    this.details().reduce((s, d) => s + (Number(d.TOTLSH || 0) * Number(d.HSMG || 0) / 100), 0)
  );
  readonly netTotal = computed(() => this.subtotal() - this.totalDiscount());

  readonly statusBadges = computed(() => {
    const badges = [];
    if (this.posted()) badges.push({ label: 'مُرحّل', type: 'success' as const });
    else badges.push({ label: 'غير مُرحّل', type: 'warn' as const });
    return badges;
  });

  readonly p = this.perms.forScreen('FB');

  async ngOnInit(): Promise<void> {
    this.canIns.set(true);
    this.canEd.set(true);
    this.canDe.set(true);
    // Permissions will be resolved async via p() signal
    await this.loadList();
  }

  // ─── Load ─────────────────────────────────────────────
  async loadList(): Promise<void> {
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: Row[] }>('/api/data/FB?limit=500&orderBy=NOS DESC')
      );
      if (r.ok) {
        this.invoices.set(r.rows);
        if (r.rows.length) {
          this.currentIdx.set(0);
          await this.loadInvoice(Number(r.rows[0]['NOS']));
        }
      }
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : 'خطأ');
    }
    this.loading.set(false);
  }

  async loadInvoice(nos: number): Promise<void> {
    this.loading.set(true);
    try {
      const [mR, dR] = await Promise.all([
        firstValueFrom(this.http.get<{ ok: boolean; rows: Row[] }>(`/api/data/FB?where=NOS=${nos}&limit=1`)),
        firstValueFrom(this.http.get<{ ok: boolean; rows: Row[] }>(`/api/data/FBF?where=NOS=${nos}&orderBy=RECNO`)),
      ]);
      if (mR.ok && mR.rows[0]) {
        this.master.set(mR.rows[0]);
        const rows = (dR.rows || []).map((d, i) => ({
          ...emptyDetail(), ...d, _key: Date.now() + i,
          RECNO: Number(d['RECNO'] ?? i + 1),
          NOA: Number(d['NOA'] ?? 0),
          NAMEA: String(d['NAMEA'] ?? ''),
          NOAG: d['NOAG'] ? Number(d['NOAG']) : null,
          KMA: Number(d['KMA'] ?? 0),
          SARW: Number(d['SARW'] ?? 0),
          TOTLSH: Number(d['TOTLSH'] ?? 0),
          HSMG: Number(d['HSMG'] ?? 0),
          NRB: Number(d['NRB'] ?? 0),
          MEMOSF: String(d['MEMOSF'] ?? ''),
          NOMHZN: d['NOMHZN'] ? Number(d['NOMHZN']) : null,
        }));
        this.details.set(rows.length ? rows : [emptyDetail()]);
        this.mode.set('browse');
      }
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : 'خطأ');
    }
    this.loading.set(false);
  }

  // ─── Navigation ───────────────────────────────────────
  navTo(action: 'first' | 'last' | number): void {
    const list = this.invoices();
    if (!list.length) return;
    let idx = this.currentIdx();
    if (action === 'first') idx = 0;
    else if (action === 'last') idx = list.length - 1;
    else idx = Math.max(0, Math.min(list.length - 1, idx + action));
    this.currentIdx.set(idx);
    this.loadInvoice(Number(list[idx]['NOS']));
  }

  // ─── Toolbar ──────────────────────────────────────────
  onToolbarAction(action: LegacyToolbarActionId): void {
    switch (action) {
      case 'new': this.startNew(); break;
      case 'edit': this.startEdit(); break;
      case 'save': this.save(); break;
      case 'delete': this.delete(); break;
      case 'cancel': this.cancel(); break;
      case 'refresh': this.loadList(); break;
      case 'post': this.post(); break;
      case 'unpost': this.unpost(); break;
      case 'add-line': this.addDetailRow(); break;
      case 'exit': window.history.back(); break;
    }
  }

  startNew(): void {
    this.mode.set('new');
    this.master.set({ DATES: new Date().toISOString().slice(0, 10), NOAML: 1, SARSF: 1, TYPEMS: 6, NOMHZND: 1 });
    this.details.set([emptyDetail()]);
    this.clearMessages();
  }

  startEdit(): void {
    if (this.posted()) { this.err.set('الفاتورة مُرحّلة — لا يمكن التعديل'); return; }
    this.mode.set('edit');
  }

  cancel(): void {
    const nos = Number(this.master()['NOS']);
    if (nos) this.loadInvoice(nos);
    else this.mode.set('browse');
  }

  // ─── Save ─────────────────────────────────────────────
  async save(): Promise<void> {
    const m = this.master();
    if (!m['NOA']) { this.err.set('الرجاء اختيار حساب العميل'); return; }
    if (!m['DATES']) { this.err.set('الرجاء إدخال التاريخ'); return; }
    const valid = this.details().filter(d => d.NOA && d.KMA > 0);
    if (!valid.length) { this.err.set('أضف صنف واحد على الأقل'); return; }

    this.saving.set(true); this.clearMessages();
    try {
      const isNew = this.mode() === 'new';
      const body = {
        ...m,
        TYPEMS: 6,
        TOTALFY: this.subtotal(),
        TOTALF: this.netTotal(),
        NOUSX: isNew ? undefined : m['NOUSX'], // server sets on insert
        DI: isNew ? new Date().toISOString() : m['DI'],
        DE: !isNew ? new Date().toISOString() : m['DE'],
        PCI: isNew ? 'WEB' : m['PCI'],
        PCE: !isNew ? 'WEB' : m['PCE'],
        NED: !isNew ? (Number(m['NED'] ?? 0) + 1) : 0,
      };

      const endpoint = `/api/data/FB`;
      const r = await firstValueFrom(
        isNew
          ? this.http.post<{ ok: boolean; error?: string }>(endpoint, { ...body, details: valid })
          : this.http.put<{ ok: boolean; error?: string }>(endpoint, { ...body, _where: `NOS=${m['NOS']}`, details: valid })
      );
      if (!r.ok) { this.err.set(r.error || 'فشل الحفظ'); this.saving.set(false); return; }
      this.info.set(isNew ? 'تم إنشاء الفاتورة' : 'تم تحديث الفاتورة');
      await this.loadList();
      this.mode.set('browse');
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : 'خطأ');
    }
    this.saving.set(false);
  }

  // ─── Delete ───────────────────────────────────────────
  async delete(): Promise<void> {
    const nos = Number(this.master()['NOS']);
    if (!nos || !confirm(`حذف الفاتورة ${nos}؟`)) return;
    if (this.posted()) { this.err.set('الفاتورة مُرحّلة'); return; }
    this.saving.set(true);
    try {
      await firstValueFrom(this.http.delete<{ ok: boolean }>(`/api/data/FB?where=NOS=${nos}`));
      await firstValueFrom(this.http.delete<{ ok: boolean }>(`/api/data/FBF?where=NOS=${nos}`));
      await this.loadList();
    } catch (e) { this.err.set(e instanceof Error ? e.message : 'خطأ'); }
    this.saving.set(false);
  }

  // ─── Post / Unpost ────────────────────────────────────
  async post(): Promise<void> {
    const nos = Number(this.master()['NOS']);
    if (!nos) return;
    this.saving.set(true);
    try {
      const r = await firstValueFrom(
        this.http.post<{ ok: boolean; error?: string }>('/api/voucher/post', { type: 'fb', nos })
      );
      if (r.ok) { this.info.set('تم الترحيل'); this.loadInvoice(nos); }
      else this.err.set(r.error || 'فشل');
    } catch (e) { this.err.set(e instanceof Error ? e.message : 'خطأ'); }
    this.saving.set(false);
  }

  async unpost(): Promise<void> {
    const nos = Number(this.master()['NOS']);
    if (!nos) return;
    this.saving.set(true);
    try {
      const r = await firstValueFrom(
        this.http.post<{ ok: boolean; error?: string }>('/api/voucher/unpost', { type: 'fb', nos })
      );
      if (r.ok) { this.info.set('تم إلغاء الترحيل'); this.loadInvoice(nos); }
      else this.err.set(r.error || 'فشل');
    } catch (e) { this.err.set(e instanceof Error ? e.message : 'خطأ'); }
    this.saving.set(false);
  }

  // ─── Detail management ────────────────────────────────
  addDetailRow(): void {
    this.details.update(d => [...d, { ...emptyDetail(), RECNO: d.length + 1 }]);
  }

  removeDetailRow(idx: number): void {
    this.details.update(d => d.length > 1 ? d.filter((_, i) => i !== idx) : d);
  }

  updateDetail(idx: number, field: string, value: unknown): void {
    this.details.update(list => list.map((d, i) => {
      if (i !== idx) return d;
      const updated = { ...d, [field]: value };
      // Auto-compute total
      if (field === 'KMA' || field === 'SARW') {
        updated.TOTLSH = Number(updated.KMA) * Number(updated.SARW);
      }
      return updated;
    }));
  }

  setMasterField(field: string, value: unknown): void {
    this.master.update(m => ({ ...m, [field]: value }));
  }

  // ─── Account LOV ──────────────────────────────────────
  openCustomerLov(): void {
    this.lovTarget.set('master');
    this.lovIsOpen.set(true);
  }

  selectFromLov(acc: LovAccount): void {
    this.master.update(m => ({
      ...m, NOA: acc.NOA, NAMES: acc.NAMEA, NOAML: acc.NOAML ?? 1,
    }));
    this.lovIsOpen.set(false);
  }

  closeLov(): void { this.lovIsOpen.set(false); }

  // ─── Item LOV ─────────────────────────────────────────
  openItemLov(idx: number): void {
    this.itemLovTarget.set(idx);
    this.itemLovOpen.set(true);
    this.itemSearchQ.set('');
    this.itemSearchResults.set([]);
  }

  async searchItems(q: string): Promise<void> {
    this.itemSearchQ.set(q);
    if (q.length < 1) { this.itemSearchResults.set([]); return; }
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: ItemResult[] }>(
          `/api/data/DATA_AG?limit=20&where=UPPER(NAMEA) LIKE UPPER('%25${q}%25') OR TO_CHAR(NOA) LIKE '%25${q}%25'`
        )
      );
      this.itemSearchResults.set(r.rows || []);
    } catch { /* */ }
  }

  selectItem(item: ItemResult): void {
    const idx = this.itemLovTarget();
    this.details.update(list => list.map((d, i) => i === idx ? {
      ...d, NOA: item.NOA, NAMEA: item.NAMEA, NOAG: item.NOAN,
      SARW: item.SART || d.SARW,
      TOTLSH: (d.KMA || 0) * (item.SART || d.SARW || 0),
    } : d));
    this.itemLovOpen.set(false);
  }

  closeItemLov(): void { this.itemLovOpen.set(false); }

  // ─── Helpers ──────────────────────────────────────────
  clearMessages(): void { this.err.set(null); this.info.set(null); }

  asStr(v: unknown): string { return v == null ? '' : String(v); }
  asNum(v: unknown): number { return Number(v ?? 0); }

  masterRecord(): Row { return this.master(); }
}
