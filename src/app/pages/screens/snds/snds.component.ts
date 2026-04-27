/**
 * SNDS / SNDK — سندات الصرف والقبض
 * Rebuilt with Angular 21 Signal Forms
 *
 * Tables: SNDS/SNDSF (TYPEMS=5) | SNDK/SNDKF (TYPEMS=4)
 * Signal Forms: form(), required(), min(), validate()
 */
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { form, required, min, validate } from '@angular/forms/signals';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { DomSanitizer } from '@angular/platform-browser';
import { firstValueFrom } from 'rxjs';
import { AuditCardComponent } from '../../../shared/audit-card/audit-card.component';
import { LovPickerComponent, type LovAccount } from '../../../shared/lov-picker/lov-picker.component';
import { ActionToolbarComponent, type ToolbarAction } from '../../../shared/action-toolbar/action-toolbar.component';
import { StatusStripComponent } from '../../../shared/status-strip/status-strip.component';
import { PermissionService } from '../../../services/permission.service';
import { LegacyToolbarComponent } from '../../../shared/legacy-ui/legacy-toolbar/legacy-toolbar.component';
import { LegacyStatusBarComponent, type LegacyStatusBadge } from '../../../shared/legacy-ui/legacy-status-bar/legacy-status-bar.component';
import { LegacyAuditFooterComponent } from '../../../shared/legacy-ui/legacy-audit-footer/legacy-audit-footer.component';
import { LegacyToolbarActionId } from '../../../shared/legacy-ui/contracts/legacy-contracts';
import { resolveLegacyShortcut } from '../../../shared/legacy-ui/behaviors/legacy-keyboard-map';
import { LEGACY_SCREEN_SPECS } from '../../../shared/legacy-ui/manifests/legacy-screen-specs';

// ══════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════

export interface Currency  { NO: number; NAMEM3: string; SARS: number; SARS1: number; SARS2: number; }
export interface Cashbox   { NOSN: number; NAMEA: string; NOA: number; TYPEA: number; }
export interface CashboxGroup { label: string; icon: string; items: Cashbox[]; }
export type Row = Record<string, unknown>;
export interface DetailRow extends Row { _key: number; }

/** Signal Form model — حقول السند الرئيسية */
interface VoucherModel {
  DATES:   string;   // تاريخ السند
  NOA:     number;   // رقم الحساب (العميل/المورد/المستفيد)
  NAMES:   string;   // اسم الحساب
  TOTALS:  number;   // المبلغ بالعملة المحلية
  TOTALS2: number;   // المبلغ بالعملة الأجنبية
  NOAML:   number;   // رقم العملة
  SARSFS:  number;   // سعر الصرف
  NOSN:    number;   // رقم الصندوق
  MEMOS1:  string;   // البيان
  MRT2:    number;   // مركز التكلفة
  NOMSRO:  number;   // رقم المشروع
}

// ══════════════════════════════════════════════════
// Component
// ══════════════════════════════════════════════════

@Component({
  selector: 'app-snds',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, DatePipe, DecimalPipe,
    AuditCardComponent,
    LovPickerComponent,
    ActionToolbarComponent,
    StatusStripComponent,
    LegacyToolbarComponent,
    LegacyStatusBarComponent,
    LegacyAuditFooterComponent,
  ],
  templateUrl: './snds.component.html',
  styleUrl:    './snds.component.scss',
})
export class SndsComponent implements OnInit, OnDestroy {

  private http     = inject(HttpClient);
  private route    = inject(ActivatedRoute);
  private permSvc  = inject(PermissionService);
  private sanitizer = inject(DomSanitizer);

  // ── نوع السند (يُحدَّد من الـ route) ─────────────────
  vType     = 'snds';            // 'snds' | 'sndk'
  typeLabel = 'سندات الصرف';
  readonly screenCode = signal<'SNDS.FMX' | 'SNDK.FMX'>('SNDS.FMX');
  readonly screenSpec = computed(() =>
    this.vType === 'sndk' ? LEGACY_SCREEN_SPECS['SNDK'] : LEGACY_SCREEN_SPECS['SNDS']
  );

  // ── الصلاحيات ──────────────────────────────────────
  private readonly permsSig = computed(() => this.permSvc.forScreen(this.screenCode())());
  readonly canIns = computed(() => (this.permsSig()?.ins ?? 0) > 0);
  readonly canEd  = computed(() => (this.permsSig()?.ed  ?? 0) > 0);
  readonly canDe  = computed(() => (this.permsSig()?.de  ?? 0) > 0);
  readonly canPr  = computed(() => (this.permsSig()?.pr  ?? 0) > 0);

  // ══════════════════════════════════════════════════
  // Signal Form — النموذج + التحققات
  // ══════════════════════════════════════════════════

  readonly model = signal<VoucherModel>({
    DATES: '', NOA: 0, NAMES: '', TOTALS: 0, TOTALS2: 0,
    NOAML: 1, SARSFS: 1, NOSN: 0, MEMOS1: '', MRT2: 0, NOMSRO: 0,
  });

  readonly f = form(this.model, p => {
    // R1: التاريخ مطلوب
    required(p.DATES,  { message: 'يجب إدخال تاريخ السند' });
    // R2: الحساب مطلوب
    required(p.NOA,    { message: 'يجب تحديد الحساب' });
    // R3: المبلغ موجب
    min(p.TOTALS, 0.01, { message: 'يجب إدخال مبلغ موجب' });
    // R4: الصندوق مطلوب
    required(p.NOSN,   { message: 'يجب تحديد الصندوق' });
    // R5: تاريخ لا يتجاوز اليوم
    validate(p.DATES, ctx => {
      const v = ctx.value();
      if (!v) return null;
      const d = new Date(v);
      const today = new Date(); today.setHours(23, 59, 59, 999);
      return d > today
        ? [{ kind: 'custom', message: 'التاريخ المدخل أكبر من تاريخ الجهاز' }]
        : null;
    });
    // R6: سعر الصرف موجب عند وجود عملة أجنبية
    validate(p.SARSFS, ctx => {
      if (this.model().NOAML <= 1) return null;
      return (ctx.value() ?? 0) <= 0
        ? [{ kind: 'custom', message: 'يجب إدخال سعر صرف موجب' }]
        : null;
    });
  });

  // ── حالة الشاشة ───────────────────────────────────
  readonly mode      = signal<'browse' | 'new' | 'edit'>('browse');
  readonly loading   = signal(false);
  readonly saving    = signal(false);
  readonly err       = signal<string | null>(null);
  readonly info      = signal<string | null>(null);
  readonly editable  = computed(() => this.mode() !== 'browse');

  // ── قوائم البيانات ────────────────────────────────
  readonly vouchers  = signal<Row[]>([]);
  readonly details   = signal<DetailRow[]>([]);
  readonly masterRaw = signal<Row>({});    // البيانات الخام من DB (للـ audit وغيره)
  readonly currencies = signal<Currency[]>([]);
  readonly cashboxes  = signal<Cashbox[]>([]);
  readonly manualPosting = signal(false);

  // ── LOV ───────────────────────────────────────────
  readonly lovOpen   = signal<'master' | number | null>(null);
  readonly lovIsOpen = computed(() => this.lovOpen() !== null);
  readonly cashboxPickerOpen = signal(false);
  readonly cashboxQuery      = signal('');

  // ── بحث وقائمة ────────────────────────────────────
  readonly search = signal('');
  readonly total  = signal(0);
  readonly searchDialogOpen = signal(false);
  readonly searchDialogQuery = signal('');
  readonly printPreviewOpen = signal(false);
  readonly printPreviewUrl = signal('');
  readonly printPreviewSafeUrl = computed(() => {
    const url = this.printPreviewUrl();
    return url ? this.sanitizer.bypassSecurityTrustResourceUrl(url) : null;
  });

  // ── اختيارات Footer ───────────────────────────────
  readonly legacyApplyMemoToAll    = signal(true);
  readonly legacyMultipleVouchers  = signal(false);
  readonly legacyPrintAfterSave    = signal(false);
  readonly payMode = signal<'cash' | 'cheque' | 'transfer'>('cash');

  // ── Cache أسماء الحسابات ──────────────────────────
  accountNames = new Map<number, string>();

  // ══════════════════════════════════════════════════
  // Computed Helpers
  // ══════════════════════════════════════════════════

  readonly filteredVouchers = computed(() => {
    const q = this.search().toLowerCase().trim();
    if (!q) return this.vouchers();
    return this.vouchers().filter(v =>
      Object.values(v).some(val => String(val ?? '').toLowerCase().includes(q))
    );
  });

  readonly nosn = computed(() => this.model().NOSN || null);

  readonly cashboxCategory = computed<'cash'|'bank'|'exchange'|'other'>(() => {
    const n = this.nosn();
    if (!n) return 'other';
    const box = this.cashboxes().find(c => c.NOSN === n);
    if (!box) return 'other';
    if (box.TYPEA === 1211) return 'cash';
    if (box.TYPEA === 1212) return 'bank';
    if (box.TYPEA === 1213) return 'exchange';
    return 'other';
  });

  readonly filteredCashboxCount = computed(() =>
    this.filteredCashboxGroups().reduce((s, g) => s + g.items.length, 0)
  );

  readonly currentIdx = computed(() => {
    const nos = this.masterRaw()['NOS'];
    if (!nos) return -1;
    return this.vouchers().findIndex(v => String(v['NOS']) === String(nos));
  });

  readonly posted = computed(() =>
    !!this.masterRaw()['NOS'] && Number(this.masterRaw()['MRHL'] ?? 1) === 0
  );

  readonly postingLocked = computed(() => this.manualPosting() && this.posted());

  readonly hasForeign = computed(() => this.model().NOAML > 1);

  readonly currency = computed(() =>
    this.currencies().find(c => c.NO === this.model().NOAML)
  );

  readonly currencyLabel = computed(() => this.currency()?.NAMEM3 || 'يمني');

  readonly detailSum = computed(() =>
    this.details().reduce((s, d) => s + (Number(d['TOAM']) || 0), 0)
  );

  readonly sumMismatch = computed(() => {
    const t = this.model().TOTALS;
    return t > 0 && Math.abs(this.detailSum() - t) > 0.01;
  });

  readonly sarsWarning = computed(() => {
    const cur = this.currency();
    if (!cur || !this.hasForeign()) return null;
    const sars = this.model().SARSFS;
    if (sars > 0 && cur.SARS1 > 0 && sars > cur.SARS1)
      return `سعر الصرف (${sars}) أكبر من الحد الأعلى (${cur.SARS1})`;
    if (sars > 0 && cur.SARS2 > 0 && sars < cur.SARS2)
      return `سعر الصرف (${sars}) أقل من الحد الأدنى (${cur.SARS2})`;
    return null;
  });

  readonly cashboxGroups = computed<CashboxGroup[]>(() => {
    const all = this.cashboxes();
    const groups: CashboxGroup[] = [];
    const cash  = all.filter(c => c.TYPEA === 1211);
    const banks = all.filter(c => c.TYPEA === 1212);
    const exch  = all.filter(c => c.TYPEA === 1213);
    const other = all.filter(c => ![1211,1212,1213].includes(c.TYPEA));
    if (cash.length)  groups.push({ label: '🏦 الصناديق النقدية',           icon: 'pi-wallet',   items: cash  });
    if (banks.length) groups.push({ label: '🏛️ البنوك',                      icon: 'pi-building', items: banks });
    if (exch.length)  groups.push({ label: '💱 الصرافين (شركات الحوالات)',  icon: 'pi-send',     items: exch  });
    if (other.length) groups.push({ label: 'أخرى',                           icon: 'pi-ellipsis-h', items: other });
    return groups;
  });

  readonly filteredCashboxGroups = computed<CashboxGroup[]>(() => {
    const q = this.cashboxQuery().trim().toLowerCase();
    if (!q) return this.cashboxGroups();
    return this.cashboxGroups()
      .map(g => ({ ...g, items: g.items.filter(b =>
        b.NAMEA?.toLowerCase().includes(q) ||
        String(b.NOSN).includes(q) ||
        String(b.NOA).includes(q)
      )}))
      .filter(g => g.items.length > 0);
  });

  readonly cashboxName = computed(() => {
    const nosn = this.model().NOSN;
    if (!nosn) return '—';
    return this.cashboxes().find(c => c.NOSN === nosn)?.NAMEA ?? `صندوق ${nosn}`;
  });

  readonly isCheque   = computed(() => !!this.masterRaw()['NOHANDSHK']);
  readonly isTransfer = computed(() => !!this.masterRaw()['NAMEB'] && !this.isCheque());

  readonly statusBadges = computed<LegacyStatusBadge[]>(() => {
    const m  = this.masterRaw();
    const mv = this.model();
    const out: LegacyStatusBadge[] = [];
    if (m['NOS'])  out.push({ label: `رقم: ${m['NOS']}`,  icon: 'pi-hashtag', variant: 'info' });
    if (m['NOK'])  out.push({ label: `قيد: ${m['NOK']}`,  icon: 'pi-key',     variant: 'info' });
    if (mv.DATES) {
      const d = new Date(mv.DATES);
      if (!isNaN(d.getTime()))
        out.push({ label: d.toLocaleDateString('ar-EG', { year:'numeric', month:'2-digit', day:'2-digit' }), icon: 'pi-calendar', variant: 'info' });
    }
    if (this.posted())
      out.push({ label: `مُرحّل — قيد ${m['NOK'] ?? ''}`.trim(), icon: 'pi-check-square', variant: 'success' });
    else if (m['NOS'])
      out.push({ label: 'غير مُرحّل', icon: 'pi-clock', variant: 'warning' });
    if (mv.TOTALS > 0)
      out.push({ label: `إجمالي: ${mv.TOTALS.toLocaleString()}`, icon: 'pi-dollar', variant: 'info' });
    if (this.sumMismatch())
      out.push({ label: `تباين الإجمالي والتفاصيل (${(this.detailSum() - mv.TOTALS).toLocaleString()})`, icon: 'pi-exclamation-triangle', variant: 'warning' });
    return out;
  });

  // ── Labels حسب نوع السند ──────────────────────────
  get headerAccountTitle(): string {
    return this.vType === 'sndk' ? 'المُسلِّم / الحساب الدائن' : 'المستفيد / الحساب المدين';
  }
  get headerAccountLabel(): string {
    return this.vType === 'sndk' ? 'اسم المُسلِّم' : 'اسم المستفيد';
  }
  get detailAccountLabel(): string {
    return this.vType === 'sndk' ? 'الحساب المدين' : 'الحساب الدائن';
  }
  get distributionTitle(): string {
    return this.vType === 'sndk'
      ? 'توزيع المبالغ على الحسابات المدينة'
      : 'توزيع المبالغ على الحسابات الدائنة';
  }

  // ══════════════════════════════════════════════════
  // Lifecycle
  // ══════════════════════════════════════════════════

  async ngOnInit(): Promise<void> {
    await Promise.all([
      this.fetchCurrencies(),
      this.fetchCashboxes(),
      this.fetchTitl(),
    ]);
    this.route.params.subscribe(p => {
      const namee = String(p['namee'] || 'SNDS').toUpperCase();
      void this.loadScreen(namee);
    });
  }

  ngOnDestroy(): void {}

  private async loadScreen(namee: string): Promise<void> {
    this.vType     = namee === 'SNDK' ? 'sndk' : 'snds';
    this.typeLabel = this.vType === 'snds' ? 'سندات الصرف' : 'سندات القبض';
    this.screenCode.set(this.vType === 'sndk' ? 'SNDK.FMX' : 'SNDS.FMX');
    this.masterRaw.set({});
    this.details.set([]);
    this.mode.set('browse');
    await this.fetchList();
    const first = this.vouchers()[0];
    if (first) await this.selectVoucher(first);
  }

  // ══════════════════════════════════════════════════
  // Data Fetching
  // ══════════════════════════════════════════════════

  async fetchList(): Promise<void> {
    this.loading.set(true);
    try {
      const params = new URLSearchParams({ limit: '500' });
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows?: Row[]; count?: number; total?: number }>(
          `/api/voucher/${this.vType}/search?${params.toString()}`
        )
      );
      if (r.ok) {
        this.vouchers.set(r.rows ?? []);
        this.total.set(r.total ?? r.count ?? 0);
      }
    } catch (e) { this.err.set(String(e)); }
    this.loading.set(false);
  }

  async fetchCurrencies(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; items?: Currency[] }>('/api/lov/currencies'));
      if (r.ok) this.currencies.set(r.items ?? []);
    } catch {}
  }

  async fetchCashboxes(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; items?: Cashbox[] }>('/api/lov/cashboxes'));
      if (r.ok) this.cashboxes.set(r.items ?? []);
    } catch {}
  }

  async fetchTitl(): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; titl?: { SANDT?: number | null } }>('/api/titl')
      );
      if (r.ok) this.manualPosting.set(Number(r.titl?.SANDT ?? 0) > 0);
    } catch { this.manualPosting.set(false); }
  }

  async selectVoucher(v: Row): Promise<void> {
    this.clearMessages();
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; master?: Row; details?: Row[]; error?: string }>(
          `/api/voucher/${this.vType}?nos=${v['NOS']}`
        )
      );
      if (!r.ok) throw new Error(r.error);
      this.masterRaw.set(r.master ?? {});
      this.details.set((r.details ?? []).map((d, i) => ({ ...d, _key: i })));
      this._syncModelFromRaw(r.master ?? {});
      this.mode.set('browse');
    } catch (e) { this.err.set(String(e)); }
  }

  /** مزامنة Signal Form model من بيانات DB */
  private _syncModelFromRaw(m: Row): void {
    this.model.set({
      DATES:   String(m['DATES'] ?? '').slice(0, 10),
      NOA:     Number(m['NOA']     ?? 0),
      NAMES:   String(m['NAMES']   ?? m['NAMEA'] ?? ''),
      TOTALS:  Number(m['TOTALS']  ?? 0),
      TOTALS2: Number(m['TOTALS2'] ?? 0),
      NOAML:   Number(m['NOAML']   ?? m['NOAML2'] ?? 1),
      SARSFS:  Number(m['SARSFS']  ?? m['SARSF']  ?? 1),
      NOSN:    Number(m['NOSN']    ?? 0),
      MEMOS1:  String(m['MEMOS1']  ?? m['MEMOS']  ?? ''),
      MRT2:    Number(m['MRT2']    ?? m['MRT']    ?? 0),
      NOMSRO:  Number(m['NOMSRO']  ?? 0),
    });
  }

  // ══════════════════════════════════════════════════
  // Actions
  // ══════════════════════════════════════════════════

  onNew(): void {
    const firstBox = this.cashboxes()[0];
    this.model.set({
      DATES: new Date().toISOString().slice(0, 10),
      NOA: 0, NAMES: '', TOTALS: 0, TOTALS2: 0,
      NOAML: 1, SARSFS: 1,
      NOSN: firstBox?.NOSN ?? 0,
      MEMOS1: '', MRT2: 0, NOMSRO: 0,
    });
    this.masterRaw.set({});
    this.details.set([{ _key: Date.now(), NOSNDOK: firstBox?.NOSN ?? null }]);
    this.payMode.set('cash');
    this.mode.set('new');
    this.clearMessages();
  }

  onEdit(): void {
    if (!this.masterRaw()['NOS']) return;
    if (this.postingLocked()) {
      this.err.set('لا يمكن تعديل مستند مرحل، يجب الغاء الترحيل اولا');
      return;
    }
    this.payMode.set(this.isCheque() ? 'cheque' : this.isTransfer() ? 'transfer' : 'cash');
    this.mode.set('edit');
  }

  onCancel(): void {
    const nos = Number(this.masterRaw()['NOS']);
    if (nos) void this.selectVoucher({ NOS: nos });
    else this.mode.set('browse');
  }

  async onSave(): Promise<void> {
    // ← Signal Forms تتحقق تلقائياً
    if (this.f().invalid()) {
      // اعرض أول خطأ
      const errors = this.f().errors();
      this.err.set(errors[0]?.message ?? 'يوجد خطأ في البيانات');
      return;
    }

    // تحقق إضافي: تباين الإجمالي
    if (this.sumMismatch()) {
      this.err.set(
        `مجموع التفاصيل (${this.detailSum().toLocaleString('ar-EG')}) لا يساوي المبلغ الإجمالي (${this.model().TOTALS.toLocaleString('ar-EG')})`
      );
      return;
    }

    // تحقق: تفاصيل موجودة
    const validDetails = this.details().filter(d => d['NOA'] || d['NOAF']);
    if (!validDetails.length) {
      this.err.set(`يجب إدخال تفاصيل السند (${this.detailAccountLabel} واحد على الأقل)`);
      return;
    }

    // تحقق: سعر الصرف
    if (this.sarsWarning()) {
      this.err.set(this.sarsWarning()!);
      return;
    }

    this.saving.set(true); this.clearMessages();
    try {
      const isNew = this.mode() === 'new';
      const mv = this.model();

      // دمج model مع masterRaw (للحقول الغير موجودة في model كـ audit fields)
      const master = {
        ...this.masterRaw(),
        DATES:   mv.DATES,
        NOA:     mv.NOA,
        NAMES:   mv.NAMES,
        TOTALS:  mv.TOTALS,
        TOTALS2: mv.TOTALS2,
        NOAML:   mv.NOAML,
        NOAML2:  mv.NOAML,
        SARSFS:  mv.SARSFS,
        NOSN:    mv.NOSN,
        MEMOS1:  mv.MEMOS1,
        MRT2:    mv.MRT2,
        NOMSRO:  mv.NOMSRO,
      };

      const r = await firstValueFrom(
        this.http.request<{ ok: boolean; nos?: number; message?: string; error?: string }>(
          isNew ? 'POST' : 'PUT',
          `/api/voucher/${this.vType}`,
          { body: { master, details: this.details() } }
        )
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message || 'تم الحفظ بنجاح');
      this.mode.set('browse');
      await this.fetchList();
      if (r.nos) {
        await this.selectVoucher({ NOS: r.nos });
        if (this.legacyPrintAfterSave()) this.onPrint();
      }
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  async onPost(): Promise<void> {
    const nos = this.masterRaw()['NOS'];
    if (!nos) return;
    if (!this.manualPosting()) { this.info.set('السند يترحل آلياً حسب الإعدادات الأساسية'); return; }
    if (this.posted()) { this.info.set('السند مُرحّل بالفعل'); return; }
    if (!confirm(`ترحيل السند ${this.masterRaw()['NOMS'] ?? nos} إلى دفتر اليومية؟`)) return;
    this.saving.set(true); this.clearMessages();
    try {
      const r = await firstValueFrom(
        this.http.post<{ ok: boolean; message?: string; error?: string; nok?: number; rows?: number }>(
          `/api/voucher/${this.vType}/post?nos=${nos}`, {}
        )
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(`${r.message ?? 'تم الترحيل'} — قيد رقم ${r.nok}, ${r.rows} سطر`);
      await this.fetchList();
      await this.selectVoucher({ NOS: nos });
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  async onUnpost(): Promise<void> {
    const nos = this.masterRaw()['NOS'];
    if (!nos || !this.posted()) return;
    if (!this.manualPosting()) { this.info.set('إلغاء الترحيل يدوي فقط'); return; }
    if (!confirm(`إلغاء ترحيل السند ${this.masterRaw()['NOMS'] ?? nos}؟`)) return;
    this.saving.set(true); this.clearMessages();
    try {
      const r = await firstValueFrom(
        this.http.post<{ ok: boolean; message?: string; error?: string; deleted?: number }>(
          `/api/voucher/${this.vType}/unpost?nos=${nos}`, {}
        )
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(`${r.message ?? 'تم إلغاء الترحيل'} — حذف ${r.deleted} سطر`);
      await this.fetchList();
      await this.selectVoucher({ NOS: nos });
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  async onDelete(): Promise<void> {
    const nos = this.masterRaw()['NOS'];
    if (!nos) return;
    if (this.postingLocked()) { this.err.set('لا يمكن حذف مستند مرحل، يجب الغاء الترحيل اولا'); return; }
    if (!confirm(`هل أنت متأكد من حذف السند رقم ${this.masterRaw()['NOMS'] || nos}؟`)) return;
    this.saving.set(true); this.clearMessages();
    try {
      const r = await firstValueFrom(
        this.http.delete<{ ok: boolean; message?: string; error?: string }>(
          `/api/voucher/${this.vType}?nos=${nos}`
        )
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحذف');
      this.masterRaw.set({}); this.details.set([]); this.mode.set('browse');
      this.model.set({ DATES:'', NOA:0, NAMES:'', TOTALS:0, TOTALS2:0, NOAML:1, SARSFS:1, NOSN:0, MEMOS1:'', MRT2:0, NOMSRO:0 });
      await this.fetchList();
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  onSearch(): void {
    this.searchDialogQuery.set(this.search());
    this.searchDialogOpen.set(true);
  }

  closeSearchDialog(): void {
    this.searchDialogOpen.set(false);
  }

  async submitSearchDialog(): Promise<void> {
    const q = this.searchDialogQuery().trim();
    if (!q) return;
    this.searchDialogOpen.set(false);
    await this.runVoucherSearch(q);
  }

  private async runVoucherSearch(q: string): Promise<void> {
    if (!q) return;

    const asExactVoucher = (v: Row): boolean => {
      const n = Number(q);
      if (!Number.isFinite(n) || n <= 0) return false;
      return [v['NOS'], v['NOSON'], v['NOMS']].some(x => Number(x) === n);
    };

    const current = this.vouchers().find(asExactVoucher);
    if (current) {
      this.search.set(q);
      await this.selectVoucher(current);
      return;
    }

    this.loading.set(true);
    this.clearMessages();
    try {
      const params = new URLSearchParams({ limit: '500', q });
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows?: Row[]; count?: number; total?: number; error?: string }>(
          `/api/voucher/${this.vType}/search?${params.toString()}`
        )
      );
      if (!r.ok) throw new Error(r.error);
      const rows = r.rows ?? [];
      this.vouchers.set(rows);
      this.total.set(r.total ?? r.count ?? rows.length);
      this.search.set(q);

      const selected = rows.find(asExactVoucher) ?? rows[0];
      if (selected) {
        await this.selectVoucher(selected);
        this.info.set(`تم العثور على ${rows.length} نتيجة`);
      } else {
        this.masterRaw.set({});
        this.details.set([]);
        this.info.set('لا توجد نتائج للبحث');
      }
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  onPrint(): void {
    const nos = this.masterRaw()['NOS'];
    if (!nos) { this.info.set('لا يوجد سند للطباعة'); return; }
    const url = `/api/voucher/${this.vType}/print?nos=${encodeURIComponent(String(nos))}`;
    this.clearMessages();
    const w = window.open(url, '_blank', 'noopener,noreferrer,width=1024,height=720');
    if (w) {
      w.focus();
      return;
    }
    this.printPreviewUrl.set(url);
    this.printPreviewOpen.set(true);
    this.info.set('تم فتح معاينة الطباعة داخل النظام لأن المتصفح منع فتح نافذة جديدة');
  }

  closePrintPreview(): void {
    this.printPreviewOpen.set(false);
    this.printPreviewUrl.set('');
  }

  printPreviewFrame(): void {
    const frame = document.getElementById('voucher-print-frame') as HTMLIFrameElement | null;
    const win = frame?.contentWindow;
    if (!win) {
      this.err.set('تعذر تحميل معاينة الطباعة');
      return;
    }
    win.focus();
    win.print();
  }

  // ══════════════════════════════════════════════════
  // Model Field Handlers
  // ══════════════════════════════════════════════════

  onTotalsChange(val: string): void {
    const t    = Number(val) || 0;
    const sars = this.model().SARSFS || 1;
    this.model.update(m => ({
      ...m, TOTALS: t,
      ...(this.hasForeign() && t > 0 ? { TOTALS2: Math.round(t / sars * 100) / 100 } : {}),
    }));
  }

  onTotals2Change(val: string): void {
    const t2   = Number(val) || 0;
    const sars = this.model().SARSFS || 1;
    this.model.update(m => ({ ...m, TOTALS2: t2, ...(t2 > 0 ? { TOTALS: Math.round(t2 * sars) } : {}) }));
  }

  onSarsChange(val: string): void {
    const sars = Number(val) || 1;
    const t2   = this.model().TOTALS2;
    this.model.update(m => ({ ...m, SARSFS: sars, ...(t2 > 0 ? { TOTALS: Math.round(t2 * sars) } : {}) }));
  }

  onMasterAccountSelected(noa: number, namea: string, noaml: number): void {
    const cur = this.currencies().find(c => c.NO === noaml);
    this.model.update(m => ({
      ...m, NOA: noa, NAMES: namea, NOAML: noaml,
      SARSFS: cur ? cur.SARS : m.SARSFS,
    }));
    this.closeLov();
  }

  setCashbox(nosn: number): void {
    this.model.update(m => ({ ...m, NOSN: nosn }));
    this.details.update(ds => ds.map(d => ({ ...d, NOSNDOK: nosn })));
    this.cashboxPickerOpen.set(false);
  }

  onPayModeChange(m: 'cash' | 'cheque' | 'transfer'): void {
    this.payMode.set(m);
    if (m !== 'cheque')   this.masterRaw.update(x => ({ ...x, NOHANDSHK: null, DATESHK: null }));
    if (m !== 'transfer') this.masterRaw.update(x => ({ ...x, NAMEB: null, NOBNKS: null }));
  }

  // ══════════════════════════════════════════════════
  // Detail Rows
  // ══════════════════════════════════════════════════

  addDetailRow(): void {
    this.details.update(d => [...d, { _key: Date.now(), NOSNDOK: this.model().NOSN }]);
  }

  removeDetailRow(idx: number): void {
    this.details.update(d => d.filter((_, i) => i !== idx));
  }

  updateDetail(idx: number, field: string, value: unknown): void {
    this.details.update(d => d.map((row, i) => i === idx ? { ...row, [field]: value } : row));
  }

  onDetailToamChange(idx: number, val: string): void {
    const toam  = Number(val) || 0;
    const d     = this.details()[idx];
    const sarsf = Number(d['SARSF']) || 1;
    const noaml = Number(d['NOAML']) || 1;
    this.details.update(ds => ds.map((row, i) => i !== idx ? row : {
      ...row, TOAM: toam,
      ...(noaml > 1 && sarsf > 0 && toam > 0
        ? { TOAA: Math.round(toam / sarsf * 100) / 100 }
        : {}),
    }));
  }

  onDetailAccountSelected(idx: number, noa: number, namea: string, noaml: number): void {
    const cur = this.currencies().find(c => c.NO === noaml);
    this.details.update(ds => ds.map((row, i) => i !== idx ? row : {
      ...row, NOAF: noa, NAMEAF: namea, NOAML: noaml, SARSF: cur ? cur.SARS : 1,
    }));
    this.closeLov();
  }

  // ══════════════════════════════════════════════════
  // LOV
  // ══════════════════════════════════════════════════

  openLov(target: 'master' | number): void { this.lovOpen.set(target); }
  closeLov(): void { this.lovOpen.set(null); }

  selectFromLov(item: LovAccount): void {
    const target = this.lovOpen();
    if (target === 'master') {
      this.onMasterAccountSelected(item.NOA, item.NAMEA, item.NOAML);
    } else if (typeof target === 'number') {
      this.onDetailAccountSelected(target, item.NOA, item.NAMEA, item.NOAML);
    }
  }

  openCashboxPicker(): void { this.cashboxQuery.set(''); this.cashboxPickerOpen.set(true); }
  closeCashboxPicker(): void { this.cashboxPickerOpen.set(false); }

  // ══════════════════════════════════════════════════
  // Navigation
  // ══════════════════════════════════════════════════

  navTo(delta: number | 'first' | 'last'): void {
    const vs  = this.vouchers();
    const idx = delta === 'first' ? 0
      : delta === 'last'  ? vs.length - 1
      : Math.max(0, Math.min(vs.length - 1, this.currentIdx() + (delta as number)));
    if (vs[idx]) void this.selectVoucher(vs[idx]);
  }

  // ══════════════════════════════════════════════════
  // Toolbar Dispatch
  // ══════════════════════════════════════════════════

  onLegacyToolbarAction(a: LegacyToolbarActionId): void {
    switch (a) {
      case 'new':      this.onNew();           break;
      case 'edit':     this.onEdit();          break;
      case 'save':     void this.onSave();     break;
      case 'delete':   void this.onDelete();   break;
      case 'cancel':   this.onCancel();        break;
      case 'refresh':  void this.fetchList();  break;
      case 'search':   void this.onSearch();    break;
      case 'post':     void this.onPost();     break;
      case 'unpost':   void this.onUnpost();   break;
      case 'print':    this.onPrint();         break;
      case 'export':   this.exportToExcel();   break;
      case 'add-line': this.addDetailRow();    break;
      case 'exit':     this.onCancel();        break;
    }
  }

  // ══════════════════════════════════════════════════
  // Keyboard Shortcuts
  // ══════════════════════════════════════════════════

  @HostListener('document:keydown', ['$event'])
  onKeydown(ev: KeyboardEvent): void {
    const shortcut = resolveLegacyShortcut(ev, { allowWhenInput: { refresh: true } });
    if (!shortcut) return;
    switch (shortcut) {
      case 'search':  ev.preventDefault(); void this.onSearch();  break;
      case 'refresh': ev.preventDefault(); void this.fetchList(); break;
      case 'print':   ev.preventDefault(); this.onPrint();        break;
      case 'cancel':  ev.preventDefault(); this.onCancel();       break;
      case 'edit':    ev.preventDefault(); this.onEdit();         break;
      case 'save':    ev.preventDefault(); if (this.editable()) void this.onSave(); break;
      case 'props':   ev.preventDefault(); this.openLov('master'); break;
      case 'exit':    ev.preventDefault(); this.onCancel();       break;
    }
  }

  // ══════════════════════════════════════════════════
  // Template Helpers
  // ══════════════════════════════════════════════════

  clearMessages(): void { this.err.set(null); this.info.set(null); }
  asStr(v: unknown): string { return String(v ?? ''); }
  asNum(v: unknown): number { return Number(v) || 0; }
  detailSumN(): number { return this.detailSum(); }

  /** تفقيط — المبلغ بالكلمات العربية */
  amountInWords(): string {
    const n = Number(this.masterRaw()['TOTALS']) || 0;
    if (!n) return '';
    const ones = ['','واحد','اثنان','ثلاثة','أربعة','خمسة','ستة','سبعة','ثمانية','تسعة',
                  'عشرة','أحد عشر','اثنا عشر','ثلاثة عشر','أربعة عشر','خمسة عشر',
                  'ستة عشر','سبعة عشر','ثمانية عشر','تسعة عشر'];
    const tens = ['','','عشرون','ثلاثون','أربعون','خمسون','ستون','سبعون','ثمانون','تسعون'];
    const toW = (num: number): string => {
      if (num === 0) return '';
      if (num < 20) return ones[num];
      if (num < 100) { const t = Math.floor(num/10), o = num%10; return o ? `${ones[o]} و${tens[t]}` : tens[t]; }
      if (num < 1000) { const h = Math.floor(num/100), r = num%100; const hw = h===1?'مائة':h===2?'مائتان':`${ones[h]}مائة`; return r ? `${hw} و${toW(r)}` : hw; }
      if (num < 1000000) { const th = Math.floor(num/1000), r = num%1000; let tw: string; if(th===1) tw='ألف'; else if(th===2) tw='ألفان'; else if(th>=3&&th<=10) tw=`${toW(th)} آلاف`; else tw=`${toW(th)} ألف`; return r ? `${tw} و${toW(r)}` : tw; }
      if (num < 1000000000) { const m = Math.floor(num/1000000), r = num%1000000; let mw: string; if(m===1) mw='مليون'; else if(m===2) mw='مليونان'; else if(m>=3&&m<=10) mw=`${toW(m)} ملايين`; else mw=`${toW(m)} مليون`; return r ? `${mw} و${toW(r)}` : mw; }
      return String(num);
    };
    return `${toW(Math.floor(Math.abs(n)))} ريال يمني`;
  }
  legacyDiff(): number { return this.model().TOTALS - this.detailSum(); }
  getAccountName(noa: unknown): string { return this.accountNames.get(Number(noa)) ?? ''; }
  masterRecord(): Row { return this.masterRaw(); }
  trackByKey(_: number, d: DetailRow): number { return d._key; }

  /** master() alias — يُستخدم في HTML القديم */
  master(): Row { return this.masterRaw(); }

  /** setMasterField — يحدّث كِلا model و masterRaw */
  setMasterField(field: string, value: unknown): void {
    this.masterRaw.update(m => ({ ...m, [field]: value }));
    // مزامنة مع Signal Form model
    const key = field as keyof VoucherModel;
    if (key in this.model()) {
      this.model.update(m => ({ ...m, [key]: value } as VoucherModel));
    }
  }

  currencyName(no: unknown): string {
    const key = Number(no) || 0;
    return this.currencies().find(c => c.NO === key)?.NAMEM3 ?? '';
  }

  lineBalance(row: DetailRow): number {
    return Number(row['RSED'] ?? row['RSEDA'] ?? row['RSEDF'] ?? 0) || 0;
  }

  lineBalanceText(row: DetailRow): string {
    const v = this.lineBalance(row);
    return v ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
  }

  pickCashbox(nosn: number): void { this.setCashbox(nosn); this.closeCashboxPicker(); }

  legacyPlaceholderRows(): number[] {
    const minRows = 10;
    return Array.from({ length: Math.max(0, minRows - this.details().length) }, (_, i) => i);
  }

  async onLegacySelectNos(rawNos: string | number): Promise<void> {
    const nos = Number(rawNos) || 0;
    if (!nos) return;
    const row = this.vouchers().find(v => Number(v['NOS']) === nos);
    if (row) await this.selectVoucher(row);
  }

  /** تصدير Excel */
  exportToExcel(): void {
    const m = this.masterRaw();
    const ds = this.details();
    if (!m['NOS']) { this.info.set('لا يوجد سند للتصدير'); return; }
    const dateStr = String(m['DATES'] ?? '').slice(0, 10);
    const title = `${this.typeLabel} رقم ${m['NOMS'] || m['NOS']} - ${dateStr}`;
    const cols = ['رقم الحساب','اسم الحساب','العملة','المبلغ بالريال اليمني','سعر الصرف','المبلغ بالعملة الاجنبية','البيان','الرصيد الحالي','مركز التكلفة'];
    const hdrStyle = 'background:#6495ED;color:#fff;font-weight:bold;text-align:center;font-size:11pt;';
    const numStyle = 'font-family:Consolas;text-align:left;mso-number-format:"#\\,##0\\.00";';
    const pinkStyle = 'background:#FFB6C1;font-weight:bold;font-family:Consolas;text-align:left;';
    let rows = '';
    for (const d of ds) {
      if (!d['NOAF'] && !d['NOA']) continue;
      rows += '<Row>';
      rows += `<Cell><Data ss:Type="Number">${d['NOAF'] || d['NOA'] || ''}</Data></Cell>`;
      rows += `<Cell><Data ss:Type="String">${d['NAMEAF'] || this.getAccountName(d['NOAF'] || d['NOA']) || ''}</Data></Cell>`;
      rows += `<Cell><Data ss:Type="String">${this.currencyName(d['NOAML']) || ''}</Data></Cell>`;
      rows += `<Cell ss:StyleID="num"><Data ss:Type="Number">${Number(d['TOAM']) || 0}</Data></Cell>`;
      rows += `<Cell ss:StyleID="num"><Data ss:Type="Number">${Number(d['SARSF']) || 1}</Data></Cell>`;
      rows += `<Cell ss:StyleID="num"><Data ss:Type="Number">${Number(d['TOAA']) || 0}</Data></Cell>`;
      rows += `<Cell><Data ss:Type="String">${d['MEMOS'] || d['MEMOSF'] || ''}</Data></Cell>`;
      rows += `<Cell ss:StyleID="num"><Data ss:Type="Number">${this.lineBalance(d)}</Data></Cell>`;
      rows += `<Cell><Data ss:Type="String">${d['MRT'] || ''}</Data></Cell>`;
      rows += '</Row>\n';
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:x="urn:schemas-microsoft-com:office:excel">
<ExcelWorkbook xmlns="urn:schemas-microsoft-com:office:excel"><WindowWidth>16000</WindowWidth></ExcelWorkbook>
<Styles>
  <Style ss:ID="Default"><Alignment ss:Horizontal="Right" ss:Vertical="Center"/><Font ss:FontName="Tahoma" ss:Size="11"/></Style>
  <Style ss:ID="hdr"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Tahoma" ss:Size="11" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#6495ED" ss:Pattern="Solid"/></Style>
  <Style ss:ID="num"><Alignment ss:Horizontal="Left" ss:Vertical="Center"/><Font ss:FontName="Consolas" ss:Size="11"/><NumberFormat ss:Format="#,##0.00"/></Style>
  <Style ss:ID="pink"><Alignment ss:Horizontal="Left" ss:Vertical="Center"/><Font ss:FontName="Consolas" ss:Size="11" ss:Bold="1"/><Interior ss:Color="#FFB6C1" ss:Pattern="Solid"/><NumberFormat ss:Format="#,##0.00"/></Style>
  <Style ss:ID="title"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Tahoma" ss:Size="14" ss:Bold="1"/></Style>
</Styles>
<Worksheet ss:Name="${this.typeLabel}">
  <Table ss:DefaultRowHeight="20" ss:StyleID="Default" ss:Direction="rtl">
    <Row ss:Height="28"><Cell ss:MergeAcross="8" ss:StyleID="title"><Data ss:Type="String">${title}</Data></Cell></Row>
    <Row>${cols.map(c => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${c}</Data></Cell>`).join('')}</Row>
    ${rows}
    <Row>
      <Cell ss:MergeAcross="2" ss:StyleID="pink"><Data ss:Type="String">الإجمالي</Data></Cell>
      <Cell ss:StyleID="pink"><Data ss:Type="Number">${this.detailSum()}</Data></Cell>
      <Cell ss:StyleID="pink"><Data ss:Type="String"></Data></Cell>
      <Cell ss:StyleID="pink"><Data ss:Type="String"></Data></Cell>
      <Cell ss:MergeAcross="2" ss:StyleID="pink"><Data ss:Type="String"></Data></Cell>
    </Row>
  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><DisplayRightToLeft/></WorksheetOptions>
</Worksheet>
</Workbook>`;
    const blob = new Blob(['\uFEFF' + xml], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.typeLabel}_${m['NOMS'] || m['NOS']}_${dateStr}.xls`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  onToolbarAction(a: ToolbarAction): void {
    switch (a) {
      case 'new':     this.onNew(); break;
      case 'edit':    this.onEdit(); break;
      case 'delete':  void this.onDelete(); break;
      case 'save':    void this.onSave(); break;
      case 'cancel':  this.onCancel(); break;
      case 'refresh': void this.fetchList(); break;
      case 'post':    void this.onPost(); break;
      case 'unpost':  void this.onUnpost(); break;
      case 'print':   this.onPrint(); break;
      default: break;
    }
  }
}
