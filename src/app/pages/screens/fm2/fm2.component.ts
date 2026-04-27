/**
 * FM2 — فاتورة مشتريات (Purchase Invoice)
 * 🆕 Built with Angular 21 Signal Forms
 *
 * Reference: _forms_kb/FM2.json (351KB), _forms_plsql/fm2.md (132KB)
 * Tables: FM (74 cols) + FMF (50 cols), TYPEMS=8
 */
import {
  ChangeDetectionStrategy, Component, OnInit, computed, inject, signal,
} from '@angular/core';
import { CommonModule, DecimalPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { form, required } from '@angular/forms/signals';
import { PermissionService } from '../../../services/permission.service';
import { LegacyToolbarComponent } from '../../../shared/legacy-ui/legacy-toolbar/legacy-toolbar.component';
import { LegacyStatusBarComponent } from '../../../shared/legacy-ui/legacy-status-bar/legacy-status-bar.component';
import { LegacyAuditFooterComponent } from '../../../shared/legacy-ui/legacy-audit-footer/legacy-audit-footer.component';
import { LovPickerComponent, type LovAccount } from '../../../shared/lov-picker/lov-picker.component';
import { LegacyToolbarActionId } from '../../../shared/legacy-ui/contracts/legacy-contracts';

type Row = Record<string, unknown>;

interface FmDetail {
  _key: number;
  RECNO: number;
  NOA: number | null;
  NAMEA: string;
  KMA: number;
  SARW: number;
  TOTLSH: number;
  HSMG: number;
  MEMOSF: string;
}

const emptyDetail = (): FmDetail => ({
  _key: Date.now() + Math.random(), RECNO: 0, NOA: null, NAMEA: '',
  KMA: 0, SARW: 0, TOTLSH: 0, HSMG: 0, MEMOSF: '',
});

@Component({
  selector: 'app-fm2',
  imports: [
    CommonModule, DecimalPipe, DatePipe, FormsModule,
    LegacyToolbarComponent, LegacyStatusBarComponent,
    LegacyAuditFooterComponent, LovPickerComponent,
  ],
  templateUrl: './fm2.component.html',
  styleUrl: './fm2.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Fm2Component implements OnInit {
  private http = inject(HttpClient);
  private perms = inject(PermissionService);

  // ─── Signal Form (Angular 21 Signal Forms!) ──────────
  readonly model = signal({
    DATES: '',
    NOA: 0,
    NAMES: '',
    NOAML: 1,
    SARSF: 1,
    MEMOS1: '',
    MRT: 0,
    NOMHZND: 1,
    NOK: 0,
    TYPEMS: 8,
  });
  readonly f = form(this.model, p => {
    required(p.DATES, { message: 'التاريخ مطلوب' });
    required(p.NOA, { message: 'حساب المورد مطلوب' });
  });

  // ─── State ────────────────────────────────────────────
  readonly mode = signal<'browse' | 'new' | 'edit'>('browse');
  readonly saving = signal(false);
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);
  readonly details = signal<FmDetail[]>([emptyDetail()]);
  readonly invoices = signal<Row[]>([]);
  readonly currentIdx = signal(0);
  readonly masterRaw = signal<Row>({});

  // LOV
  readonly lovIsOpen = signal(false);
  readonly itemLovOpen = signal(false);
  readonly itemLovTarget = signal(0);
  readonly itemResults = signal<Row[]>([]);
  readonly itemQ = signal('');

  // Permissions
  readonly p = this.perms.forScreen('FM2');

  // Computed
  readonly editable = computed(() => this.mode() !== 'browse');
  readonly posted = computed(() => Number(this.masterRaw()['MRHL'] ?? 1) === 0);
  readonly subtotal = computed(() => this.details().reduce((s, d) => s + d.TOTLSH, 0));
  readonly totalDiscount = computed(() => this.details().reduce((s, d) => s + (d.TOTLSH * d.HSMG / 100), 0));
  readonly netTotal = computed(() => this.subtotal() - this.totalDiscount());

  async ngOnInit(): Promise<void> {
    await this.loadList();
  }

  // ─── Load ─────────────────────────────────────────────
  async loadList(): Promise<void> {
    this.loading.set(true);
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; rows: Row[] }>('/api/data/FM?limit=500&orderBy=NOS DESC'));
      if (r.ok) {
        this.invoices.set(r.rows);
        if (r.rows.length) { this.currentIdx.set(0); await this.loadOne(Number(r.rows[0]['NOS'])); }
      }
    } catch (e) { this.err.set(e instanceof Error ? e.message : 'خطأ'); }
    this.loading.set(false);
  }

  async loadOne(nos: number): Promise<void> {
    this.loading.set(true);
    try {
      const [mR, dR] = await Promise.all([
        firstValueFrom(this.http.get<{ ok: boolean; rows: Row[] }>(`/api/data/FM?where=NOS=${nos}&limit=1`)),
        firstValueFrom(this.http.get<{ ok: boolean; rows: Row[] }>(`/api/data/FMF?where=NOS=${nos}&orderBy=RECNO`)),
      ]);
      if (mR.ok && mR.rows[0]) {
        const m = mR.rows[0];
        this.masterRaw.set(m);

        // Update Signal Form values
        this.model.set({
          DATES: String(m['DATES'] ?? '').slice(0, 10),
          NOA: Number(m['NOA'] ?? 0),
          NAMES: String(m['NAMES'] ?? m['NAMEA'] ?? ''),
          NOAML: Number(m['NOAML'] ?? 1),
          SARSF: Number(m['SARSF'] ?? 1),
          MEMOS1: String(m['MEMOS1'] ?? ''),
          MRT: Number(m['MRT'] ?? 0),
          NOMHZND: Number(m['NOMHZND'] ?? 1),
          NOK: Number(m['NOK'] ?? 0),
          TYPEMS: 8,
        });

        const rows = (dR.rows || []).map((d, i) => ({
          ...emptyDetail(), _key: Date.now() + i,
          RECNO: Number(d['RECNO'] ?? i + 1),
          NOA: Number(d['NOA'] ?? 0), NAMEA: String(d['NAMEA'] ?? ''),
          KMA: Number(d['KMA'] ?? 0), SARW: Number(d['SARW'] ?? 0),
          TOTLSH: Number(d['TOTLSH'] ?? 0), HSMG: Number(d['HSMG'] ?? 0),
          MEMOSF: String(d['MEMOSF'] ?? ''),
        }));
        this.details.set(rows.length ? rows : [emptyDetail()]);
        this.mode.set('browse');
      }
    } catch (e) { this.err.set(e instanceof Error ? e.message : 'خطأ'); }
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
    this.loadOne(Number(list[idx]['NOS']));
  }

  // ─── Actions ──────────────────────────────────────────
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
      case 'add-line': this.addDetail(); break;
      case 'exit': window.history.back(); break;
    }
  }

  startNew(): void {
    this.mode.set('new');
    this.model.set({ DATES: new Date().toISOString().slice(0, 10), NOA: 0, NAMES: '', NOAML: 1, SARSF: 1, MEMOS1: '', MRT: 0, NOMHZND: 1, NOK: 0, TYPEMS: 8 });
    this.details.set([emptyDetail()]);
    this.masterRaw.set({});
    this.clearMessages();
  }

  startEdit(): void {
    if (this.posted()) { this.err.set('الفاتورة مُرحّلة'); return; }
    this.mode.set('edit');
  }

  cancel(): void {
    const nos = Number(this.masterRaw()['NOS']);
    if (nos) this.loadOne(nos);
    else this.mode.set('browse');
  }

  // ─── Save (using Signal Form validation!) ─────────────
  async save(): Promise<void> {
    // Signal Forms auto-validate!
    // Signal Forms validation
    const fState = this.f();
    if (fState.invalid()) {
      this.err.set('يوجد أخطاء في النموذج — تحقق من الحقول المطلوبة');
      return;
    }

    const valid = this.details().filter(d => d.NOA && d.KMA > 0);
    if (!valid.length) { this.err.set('أضف صنف واحد على الأقل'); return; }

    this.saving.set(true); this.clearMessages();
    try {
      const isNew = this.mode() === 'new';
      const fv = this.model();
      const body = {
        ...this.masterRaw(),
        ...fv,
        TYPEMS: 8,
        TOTALFY: this.subtotal(),
        TOTALF: this.netTotal(),
        DI: isNew ? new Date().toISOString() : this.masterRaw()['DI'],
        DE: !isNew ? new Date().toISOString() : this.masterRaw()['DE'],
        PCI: isNew ? 'WEB' : this.masterRaw()['PCI'],
        PCE: !isNew ? 'WEB' : this.masterRaw()['PCE'],
        NED: !isNew ? (Number(this.masterRaw()['NED'] ?? 0) + 1) : 0,
      };

      const r = await firstValueFrom(
        isNew
          ? this.http.post<{ ok: boolean; error?: string }>('/api/data/FM', { ...body, details: valid })
          : this.http.put<{ ok: boolean; error?: string }>('/api/data/FM', { ...body, _where: `NOS=${this.masterRaw()['NOS']}`, details: valid })
      );
      if (!r.ok) { this.err.set(r.error || 'فشل'); this.saving.set(false); return; }
      this.info.set(isNew ? 'تم إنشاء الفاتورة' : 'تم التحديث');
      await this.loadList();
      this.mode.set('browse');
    } catch (e) { this.err.set(e instanceof Error ? e.message : 'خطأ'); }
    this.saving.set(false);
  }

  async delete(): Promise<void> {
    const nos = Number(this.masterRaw()['NOS']);
    if (!nos || this.posted() || !confirm(`حذف الفاتورة ${nos}؟`)) return;
    this.saving.set(true);
    try {
      await firstValueFrom(this.http.delete(`/api/data/FM?where=NOS=${nos}`));
      await firstValueFrom(this.http.delete(`/api/data/FMF?where=NOS=${nos}`));
      await this.loadList();
    } catch (e) { this.err.set(e instanceof Error ? e.message : 'خطأ'); }
    this.saving.set(false);
  }

  async post(): Promise<void> {
    const nos = Number(this.masterRaw()['NOS']);
    if (!nos) return;
    this.saving.set(true);
    try {
      const r = await firstValueFrom(this.http.post<{ ok: boolean; error?: string }>('/api/voucher/post', { type: 'fm', nos }));
      if (r.ok) { this.info.set('تم الترحيل'); this.loadOne(nos); }
      else this.err.set(r.error || 'فشل');
    } catch (e) { this.err.set(e instanceof Error ? e.message : 'خطأ'); }
    this.saving.set(false);
  }

  async unpost(): Promise<void> {
    const nos = Number(this.masterRaw()['NOS']);
    if (!nos) return;
    this.saving.set(true);
    try {
      const r = await firstValueFrom(this.http.post<{ ok: boolean; error?: string }>('/api/voucher/unpost', { type: 'fm', nos }));
      if (r.ok) { this.info.set('تم إلغاء الترحيل'); this.loadOne(nos); }
      else this.err.set(r.error || 'فشل');
    } catch (e) { this.err.set(e instanceof Error ? e.message : 'خطأ'); }
    this.saving.set(false);
  }

  // ─── Detail management ────────────────────────────────
  addDetail(): void { this.details.update(d => [...d, { ...emptyDetail(), RECNO: d.length + 1 }]); }
  removeDetail(i: number): void { this.details.update(d => d.length > 1 ? d.filter((_, j) => j !== i) : d); }
  updateDetail(i: number, field: string, value: unknown): void {
    this.details.update(list => list.map((d, j) => {
      if (j !== i) return d;
      const u = { ...d, [field]: value };
      if (field === 'KMA' || field === 'SARW') u.TOTLSH = Number(u.KMA) * Number(u.SARW);
      return u;
    }));
  }

  // ─── LOV ──────────────────────────────────────────────
  openSupplierLov(): void { this.lovIsOpen.set(true); }
  selectFromLov(acc: LovAccount): void {
    this.model.update(v => ({ ...v, NOA: acc.NOA, NAMES: acc.NAMEA ?? '', NOAML: acc.NOAML ?? 1 }));
    this.lovIsOpen.set(false);
  }
  closeLov(): void { this.lovIsOpen.set(false); }

  openItemLov(idx: number): void { this.itemLovTarget.set(idx); this.itemLovOpen.set(true); this.itemQ.set(''); this.itemResults.set([]); }
  async searchItems(q: string): Promise<void> {
    this.itemQ.set(q);
    if (q.length < 1) { this.itemResults.set([]); return; }
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; rows: Row[] }>(`/api/data/DATA_AG?limit=20&where=UPPER(NAMEA) LIKE UPPER('%25${q}%25') OR TO_CHAR(NOA) LIKE '%25${q}%25'`));
      this.itemResults.set(r.rows || []);
    } catch { /* */ }
  }
  selectItem(item: Row): void {
    const idx = this.itemLovTarget();
    this.details.update(list => list.map((d, i) => i === idx ? {
      ...d, NOA: Number(item['NOA']), NAMEA: String(item['NAMEA'] ?? ''),
      SARW: Number(item['SARSH'] ?? item['SART'] ?? d.SARW),
      TOTLSH: (d.KMA || 0) * Number(item['SARSH'] ?? item['SART'] ?? d.SARW),
    } : d));
    this.itemLovOpen.set(false);
  }
  closeItemLov(): void { this.itemLovOpen.set(false); }

  clearMessages(): void { this.err.set(null); this.info.set(null); }
  masterRecord(): Row { return this.masterRaw(); }
}
