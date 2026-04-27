/**
 * SNDKD — قيد يومية
 * Rebuilt with Angular 21 Signal Forms
 *
 * Tables: SNDKD/SNDKDF (TYPEMS=2)
 * Signal Forms: form(), required(), validate()
 */
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { form, required, validate } from '@angular/forms/signals';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LovPickerComponent, type LovAccount } from '../../../shared/lov-picker/lov-picker.component';
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

export interface SndkdRow {
  NOS:    number;
  NOSON:  number | null;
  DATES:  string;
  MEMOS:  string | null;
  NOK:    number | null;
  MRHL:   number;
  TOTALS: number | null;
  NOUSX:  number | null;
}

export type Row = Record<string, unknown>;

export interface TitlSettings {
  INSDS: number; RSEM: number; SANDT: number; MRT2: number; T_MRT_U: number;
  NWSMS: string; TSMS: number; T_SMS: number; V_PDF: number;
}

export interface SessionUserInfo {
  nou: number; isAdmin: boolean; tklf: number | null; mrt: number | null; mrtall: number | null;
}

export interface SndkdLine {
  _key:     number;
  RECNO?:   number;
  NOA:      number | null;
  NAMEA?:   string | null;
  MDIN:     number;
  DAN:      number;
  MDINAML:  number;
  DANAML:   number;
  NOAML:    number;
  SARSF:    number;
  MRT:      number;
  MEMOS:    string | null;
}

/** Signal Form model — حقول القيد الرئيسية */
export interface JournalModel {
  DATES:   string;
  MEMOS:   string;
  MRT2:    number;
  NOMSRO:  number;
  TYPEMS:  number;
}

// ══════════════════════════════════════════════════
// Component
// ══════════════════════════════════════════════════

@Component({
  selector: 'app-sndkd',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, DatePipe, DecimalPipe,
    LovPickerComponent,
    LegacyToolbarComponent,
    LegacyStatusBarComponent,
    LegacyAuditFooterComponent,
  ],
  templateUrl: './sndkd.component.html',
  styleUrl: './sndkd.component.scss',
})
export class SndkdComponent implements OnInit {
  private http    = inject(HttpClient);
  private permSvc = inject(PermissionService);
  private router  = inject(Router);
  private route   = inject(ActivatedRoute);

  readonly screenCode = 'SNDKD.FMX';
  readonly screenSpec = LEGACY_SCREEN_SPECS['SNDKD'];

  // ── الصلاحيات ──────────────────────────────────────
  private readonly perms = computed(() => this.permSvc.forScreen(this.screenCode)());
  readonly canIns = computed(() => (this.perms()?.ins ?? 0) > 0);
  readonly canEd  = computed(() => (this.perms()?.ed  ?? 0) > 0);
  readonly canDe  = computed(() => (this.perms()?.de  ?? 0) > 0);
  readonly canPr  = computed(() => (this.perms()?.pr  ?? 0) > 0);
  readonly canSar = computed(() => (this.perms()?.sar ?? 0) > 0);

  // ══════════════════════════════════════════════════
  // Signal Form — النموذج والتحققات
  // ══════════════════════════════════════════════════

  readonly model = signal<JournalModel>({
    DATES: '', MEMOS: '', MRT2: 0, NOMSRO: 0, TYPEMS: 1,
  });

  readonly f = form(this.model, p => {
    required(p.DATES, { message: 'يجب إدخال تاريخ القيد' });
    validate(p.DATES, ctx => {
      const v = ctx.value();
      if (!v) return null;
      const d = new Date(v);
      const today = new Date(); today.setHours(23, 59, 59, 999);
      return d > today ? [{ kind: 'custom', message: 'التاريخ أكبر من تاريخ اليوم' }] : null;
    });
  });

  // ── حالة الشاشة وقوائم البيانات ─────────────────────
  readonly masterRaw = signal<Row>({});
  readonly details   = signal<SndkdLine[]>([]);
  readonly rows      = signal<SndkdRow[]>([]);
  readonly mode      = signal<'browse' | 'new' | 'edit'>('browse');
  readonly loading   = signal(false);
  readonly saving    = signal(false);
  readonly err       = signal<string | null>(null);
  readonly info      = signal<string | null>(null);
  readonly search    = signal('');

  readonly titl = signal<TitlSettings | null>(null);
  readonly me   = signal<SessionUserInfo | null>(null);

  readonly holdVoucher       = signal(false);
  readonly recurringVoucher  = signal(false);
  readonly privatePostOnly   = signal(false);
  readonly fillVoucherAmount = signal(false);
  readonly printAfterSave    = signal(false);

  readonly canPostNow = computed(() => !this.holdVoucher());
  readonly minDetailRows = 12;
  private nextKey = 1;

  readonly voucherTypes = [
    { id: 1, label: 'قيد يومية' },
    { id: 2, label: 'قيد عكسي' },
    { id: 3, label: 'قيد قبض' },
    { id: 4, label: 'قيد صرف' },
    { id: 5, label: 'قيد حولات' },
    { id: 6, label: 'قيد مصارفة' },
  ] as const;

  // ── حالة البحث المتقدم ─────────────────────────────
  readonly searchOpen     = signal(false);
  readonly searchBusy     = signal(false);
  readonly searchResults  = signal<SndkdRow[]>([]);
  readonly searchCriteria = signal({
    dateFrom: '', dateTo: '', memo: '', minAmount: '', maxAmount: '', posted: '' as ''|'1'|'0', nomsro: '', noa: '',
  });

  // ── حالة الـ LOV ──────────────────────────────────
  readonly lovPickingKey   = signal<number | null>(null);
  readonly lovOpen         = computed(() => this.lovPickingKey() !== null);
  readonly accountHints    = signal<LovAccount[]>([]);
  readonly accountHintsKey = signal<number | null>(null);
  private hintsTimer: ReturnType<typeof setTimeout> | null = null;

  // ══════════════════════════════════════════════════
  // Computed Helpers
  // ══════════════════════════════════════════════════

  readonly editable      = computed(() => this.mode() !== 'browse');
  readonly posted        = computed(() => !!this.masterRaw()['NOS'] && Number(this.masterRaw()['MRHL'] ?? 0) === 0);
  readonly manualPosting = computed(() => Number(this.titl()?.SANDT ?? 0) > 0);
  readonly postingLocked = computed(() => this.manualPosting() && this.posted());
  readonly totalDebit    = computed(() => this.details().reduce((s, d) => s + (+d.MDIN || 0), 0));
  readonly totalCredit   = computed(() => this.details().reduce((s, d) => s + (+d.DAN  || 0), 0));
  readonly diff          = computed(() => this.totalDebit() - this.totalCredit());
  readonly balanced      = computed(() => Math.abs(this.diff()) < 0.005);
  readonly amountInWords = computed(() => this.numberToArabicWords(this.totalDebit()));

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) return this.rows();
    return this.rows().filter(r => String(r.NOS).includes(q) || (r.MEMOS ?? '').toLowerCase().includes(q));
  });

  readonly currentIdx = computed(() => {
    const nos = this.masterRaw()['NOS'];
    if (!nos) return -1;
    return this.rows().findIndex(r => r.NOS === nos);
  });

  readonly voucherTypeLabel = computed(() => {
    const t = this.model().TYPEMS;
    return this.voucherTypes.find(x => x.id === t)?.label ?? 'قيد';
  });

  readonly statusBadges = computed<LegacyStatusBadge[]>(() => {
    const m = this.masterRaw();
    const mv = this.model();
    const out: LegacyStatusBadge[] = [];
    if (m['NOSON']) out.push({ label: `مسلسل: ${m['NOSON']}`, icon: 'pi-hashtag', variant: 'info' });
    if (m['NOS'])   out.push({ label: `رقم داخلي: ${m['NOS']}`, icon: 'pi-key', variant: 'info' });
    if (mv.DATES) {
      const d = new Date(mv.DATES);
      if (!isNaN(d.getTime()))
        out.push({ label: d.toLocaleDateString('ar-EG', { year: 'numeric', month: '2-digit', day: '2-digit' }), icon: 'pi-calendar', variant: 'info' });
    }
    if (this.posted()) out.push({ label: `مُرحّل — قيد ${m['NOK']}`, icon: 'pi-check-square', variant: 'success' });
    else if (m['NOS']) out.push({ label: 'غير مُرحّل', icon: 'pi-clock', variant: 'warning' });

    if (this.details().length > 0) {
      out.push(this.balanced()
        ? { label: `متوازن: ${this.totalDebit().toLocaleString()}`, icon: 'pi-check', variant: 'success' }
        : { label: `فارق: ${this.diff().toLocaleString()}`, icon: 'pi-exclamation-triangle', variant: 'warning' });
    }
    return out;
  });

  // ══════════════════════════════════════════════════
  // Lifecycle & Init
  // ══════════════════════════════════════════════════

  async ngOnInit(): Promise<void> {
    await Promise.all([this.fetchContext(), this.fetchList()]);
    const nosQ = Number(this.route.snapshot.queryParamMap.get('nos'));
    if (nosQ > 0) await this.openRow(nosQ);
  }

  async fetchContext(): Promise<void> {
    try {
      const [titlRes, meRes] = await Promise.all([
        firstValueFrom(this.http.get<{ ok: boolean; titl?: Partial<TitlSettings> }>('/api/titl')),
        firstValueFrom(this.http.get<{ ok: boolean; user?: Partial<SessionUserInfo> }>('/api/me')),
      ]);
      if (titlRes.ok && titlRes.titl) {
        this.titl.set({
          INSDS: Number(titlRes.titl.INSDS ?? 0), RSEM: Number(titlRes.titl.RSEM ?? 0),
          SANDT: Number(titlRes.titl.SANDT ?? 0), MRT2: Number(titlRes.titl.MRT2 ?? 0),
          T_MRT_U: Number(titlRes.titl.T_MRT_U ?? 0), NWSMS: String(titlRes.titl.NWSMS ?? ''),
          TSMS: Number(titlRes.titl.TSMS ?? 0), T_SMS: Number(titlRes.titl.T_SMS ?? 0), V_PDF: Number(titlRes.titl.V_PDF ?? 0),
        });
      }
      if (meRes.ok && meRes.user) {
        this.me.set({
          nou: Number(meRes.user.nou ?? 0), isAdmin: !!meRes.user.isAdmin,
          tklf: meRes.user.tklf == null ? null : Number(meRes.user.tklf),
          mrt: meRes.user.mrt == null ? null : Number(meRes.user.mrt),
          mrtall: meRes.user.mrtall == null ? null : Number(meRes.user.mrtall),
        });
      }
    } catch {}
  }

  // ══════════════════════════════════════════════════
  // Data Loading
  // ══════════════════════════════════════════════════

  async fetchList(): Promise<void> {
    this.loading.set(true);
    try {
      const currentNos = this.masterRaw()['NOS'];
      const r = await firstValueFrom(this.http.get<{ ok: boolean; rows: SndkdRow[]; error?: string }>('/api/journal/sndkd/list?limit=200'));
      if (!r.ok) throw new Error(r.error);
      const list = r.rows ?? [];
      this.rows.set(list);

      if (this.mode() === 'browse' && list.length > 0) {
        const targetNos = currentNos && list.some(x => x.NOS === currentNos) ? currentNos : list[0]!.NOS;
        const mustOpen = !!targetNos && (this.masterRaw()['NOS'] !== targetNos || this.details().length === 0);
        if (targetNos && mustOpen) {
          const orderedNos = [targetNos, ...list.map(x => x.NOS).filter(n => n !== targetNos)];
          let opened = false;
          let lastError: string | null = null;
          for (const nos of orderedNos) {
            const result = await this.openRow(nos as number, { keepLoadingState: true, suppressError: true });
            if (result.ok) { opened = true; break; }
            if (result.error) lastError = result.error;
          }
          if (!opened) this.err.set(lastError ?? 'تعذر فتح أي قيد من القائمة.');
        }
      }
    } catch (e) { this.err.set(this.toMsg(e)); }
    this.loading.set(false);
  }

  async openRow(nos: number, options: { keepLoadingState?: boolean; suppressError?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
    if (!options.keepLoadingState) this.loading.set(true);
    this.clearMessages();
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; master: Row; details: Array<Row>; error?: string }>(`/api/journal/sndkd?nos=${nos}`)
      );
      if (!r.ok) throw new Error(r.error);
      this.masterRaw.set(r.master ?? {});
      this._syncModelFromRaw(r.master ?? {});
      const accounts = await this.ensureAccountNames(r.details);
      this.details.set(r.details.map((d) => ({
        _key:    this.nextKey++,
        RECNO:   Number(d['RECNO']),
        NOA:     Number(d['NOA']),
        NAMEA:   accounts.get(Number(d['NOA'])) ?? null,
        MDIN:    Number(d['MDIN'] ?? 0),
        DAN:     Number(d['DAN'] ?? 0),
        MDINAML: Number(d['MDINAML'] ?? d['MDIN'] ?? 0),
        DANAML:  Number(d['DANAML'] ?? d['DAN'] ?? 0),
        NOAML:   Number(d['NOAML'] ?? 1),
        SARSF:   Number(d['SARSF'] ?? 1),
        MRT:     Number(d['MRT'] ?? 0),
        MEMOS:   (d['MEMOS'] as string | null) ?? null,
      })));
      this.mode.set('browse');
      return { ok: true };
    } catch (e) {
      const msg = this.toMsg(e);
      if (!options.suppressError) this.err.set(msg);
      return { ok: false, error: msg };
    } finally {
      if (!options.keepLoadingState) this.loading.set(false);
    }
  }

  private _syncModelFromRaw(m: Row): void {
    this.model.set({
      DATES:   String(m['DATES'] ?? '').slice(0, 10),
      MEMOS:   String(m['MEMOS'] ?? ''),
      MRT2:    Number(m['MRT2']  ?? 0),
      NOMSRO:  Number(m['NOMSRO'] ?? 0),
      TYPEMS:  Number(m['TYPEMS'] ?? 1),
    });
  }

  private async ensureAccountNames(details: Array<Row>): Promise<Map<number, string>> {
    const ids = Array.from(new Set(details.map(d => Number(d['NOA'])).filter(n => n > 0)));
    const out = new Map<number, string>();
    await Promise.all(ids.map(async (noa) => {
      try {
        const r = await firstValueFrom(this.http.get<{ ok: boolean; items?: LovAccount[] }>(`/api/lov/accounts?q=${noa}&rtba=5&limit=5`));
        const hit = r.items?.find(it => Number(it.NOA) === noa);
        if (hit) out.set(noa, String(hit.NAMEA));
      } catch {}
    }));
    return out;
  }

  // ══════════════════════════════════════════════════
  // Actions
  // ══════════════════════════════════════════════════

  private defaultHeaderCostCenter(): number {
    const userDefault = Number(this.me()?.tklf ?? 0) || Number(this.me()?.mrt ?? 0);
    if (userDefault > 0) return userDefault;
    const systemDefault = Number(this.titl()?.MRT2 ?? 0);
    return systemDefault > 0 ? systemDefault : 0;
  }

  onNew(): void {
    const mrt2 = this.defaultHeaderCostCenter();
    this.model.set({ DATES: new Date().toISOString().slice(0, 10), MEMOS: '', MRT2: mrt2, NOMSRO: 0, TYPEMS: 1 });
    this.masterRaw.set({});
    this.details.set([this.makeLine(mrt2), this.makeLine(mrt2)]);
    this.mode.set('new');
    this.clearMessages();
  }

  onNewFromCurrent(): void {
    const cur = this.masterRaw();
    if (!cur['NOS']) return;
    const mv = this.model();
    this.model.set({ DATES: new Date().toISOString().slice(0, 10), MEMOS: mv.MEMOS, MRT2: mv.MRT2, NOMSRO: mv.NOMSRO, TYPEMS: mv.TYPEMS });
    this.masterRaw.set({});
    const cloned = this.details().map((d) => ({ ...d, _key: this.nextKey++ }));
    this.details.set(cloned.length ? cloned : [this.makeLine(mv.MRT2), this.makeLine(mv.MRT2)]);
    this.mode.set('new');
    this.err.set(null);
    this.info.set('تم فتح قيد جديد من القيد الحالي');
  }

  onEdit(): void {
    if (!this.masterRaw()['NOS']) return;
    if (this.postingLocked()) { this.err.set('لا يمكن تعديل مستند مرحل، يجب الغاء الترحيل اولا'); return; }
    this.mode.set('edit');
  }

  onCancel(): void {
    this.mode.set('browse');
    this.clearMessages();
    const nos = Number(this.masterRaw()['NOS']);
    if (nos) void this.openRow(nos);
    else { this.masterRaw.set({}); this.model.set({ DATES:'', MEMOS:'', MRT2:0, NOMSRO:0, TYPEMS:1 }); this.details.set([]); }
  }

  async onSave(): Promise<void> {
    if (this.f().invalid()) {
      this.err.set(this.f().errors()[0]?.message ?? 'خطأ في البيانات الأساسية');
      return;
    }
    const lines = this.details();
    if (lines.length === 0) { this.err.set('يجب إدخال سطر واحد على الأقل'); return; }

    for (const [i, d] of lines.entries()) {
      if (!d.NOA) { this.err.set(`السطر ${i+1}: يجب اختيار الحساب`); return; }
      const mdin = +d.MDIN || 0, dan = +d.DAN || 0;
      if (mdin === 0 && dan === 0) { this.err.set(`السطر ${i+1}: يجب إدخال مبلغ مدين أو دائن`); return; }
      if (mdin > 0 && dan > 0)     { this.err.set(`السطر ${i+1}: لا يمكن إدخال مبلغين (مدين ودائن)`); return; }
    }
    if (!this.balanced()) { this.err.set('مجموع المدين لا يساوي مجموع الدائن'); return; }

    this.saving.set(true); this.clearMessages();
    try {
      const mv = this.model();
      const payload = {
        master: { ...this.masterRaw(), ...mv },
        details: this.details().map(d => ({
          NOA: d.NOA, MDIN: d.MDIN, DAN: d.DAN, MDINAML: d.MDINAML, DANAML: d.DANAML,
          NOAML: d.NOAML, SARSF: d.SARSF, MRT: d.MRT, MEMOS: d.MEMOS,
        })),
      };
      const verb = this.mode() === 'edit' ? 'put' : 'post';
      const r = await firstValueFrom(
        this.http.request<{ ok: boolean; message?: string; error?: string; nos?: number }>(
          verb.toUpperCase(), '/api/journal/sndkd', { body: payload }
        )
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(this.toMsg(r.message ?? 'تم الحفظ'));
      const targetNos = r.nos ?? Number(this.masterRaw()['NOS']);
      this.mode.set('browse');
      await this.fetchList();
      if (targetNos) await this.openRow(targetNos);
      if (this.printAfterSave() && targetNos) this.onPrint();
    } catch (e) { this.err.set(this.toMsg(e)); }
    this.saving.set(false);
  }

  async onDelete(): Promise<void> {
    const nos = Number(this.masterRaw()['NOS']);
    if (!nos) return;
    if (this.postingLocked()) { this.err.set('لا يمكن حذف مستند مرحل، يجب الغاء الترحيل اولا'); return; }
    if (!confirm(`هل أنت متأكد من حذف القيد رقم ${nos}؟`)) return;
    this.saving.set(true); this.clearMessages();
    try {
      const r = await firstValueFrom(this.http.delete<{ ok: boolean; message?: string; error?: string }>(`/api/journal/sndkd?nos=${nos}`));
      if (!r.ok) throw new Error(r.error);
      this.info.set(this.toMsg(r.message ?? 'تم الحذف'));
      this.masterRaw.set({}); this.details.set([]); this.mode.set('browse');
      await this.fetchList();
    } catch (e) { this.err.set(this.toMsg(e)); }
    this.saving.set(false);
  }

  async onPost(): Promise<void> {
    const nos = Number(this.masterRaw()['NOS']);
    if (!nos) return;
    if (this.holdVoucher()) { this.err.set('القيد تحت الانتظار: يجب إلغاء هذا الخيار قبل الترحيل'); return; }
    if (!this.manualPosting()) { this.info.set('القيد يترحل آلياً'); return; }
    if (this.posted()) { this.info.set('القيد مُرحّل بالفعل'); return; }
    if (!confirm(`ترحيل القيد ${nos} إلى دفتر اليومية؟`)) return;
    this.saving.set(true); this.clearMessages();
    try {
      const r = await firstValueFrom(this.http.post<{ ok: boolean; message?: string; error?: string; nok?: number; rows?: number }>(`/api/journal/sndkd/post?nos=${nos}`, {}));
      if (!r.ok) throw new Error(r.error);
      this.info.set(`${this.toMsg(r.message ?? 'تم الترحيل')} - قيد ${r.nok}, ${r.rows} سطر`);
      await this.openRow(nos);
      await this.fetchList();
    } catch (e) { this.err.set(this.toMsg(e)); }
    this.saving.set(false);
  }

  async onUnpost(): Promise<void> {
    const nos = Number(this.masterRaw()['NOS']);
    if (!nos || !this.posted()) return;
    if (!this.manualPosting()) { this.info.set('إلغاء الترحيل يدوي فقط'); return; }
    if (!confirm(`إلغاء ترحيل القيد ${nos}؟`)) return;
    this.saving.set(true); this.clearMessages();
    try {
      const r = await firstValueFrom(this.http.post<{ ok: boolean; message?: string; error?: string; deleted?: number }>(`/api/journal/sndkd/unpost?nos=${nos}`, {}));
      if (!r.ok) throw new Error(r.error);
      this.info.set(`${this.toMsg(r.message ?? 'تم إلغاء الترحيل')} - حذف ${r.deleted} سطر`);
      await this.openRow(nos);
      await this.fetchList();
    } catch (e) { this.err.set(this.toMsg(e)); }
    this.saving.set(false);
  }

  // ══════════════════════════════════════════════════
  // Model Fields
  // ══════════════════════════════════════════════════

  setMasterField(field: string, value: unknown): void {
    this.masterRaw.update(m => ({ ...m, [field]: value }));
    const key = field as keyof JournalModel;
    if (key in this.model()) this.model.update(m => ({ ...m, [key]: value } as JournalModel));
  }

  onHeaderCostCenterChange(raw: string | number): void {
    const value = Number(raw) || 0;
    this.setMasterField('MRT2', value);
    if (!this.editable()) return;
    this.details.update(list => list.map(d => {
      if ((Number(d.MRT ?? 0) || 0) > 0) return d;
      return { ...d, MRT: value };
    }));
  }

  // ══════════════════════════════════════════════════
  // Details
  // ══════════════════════════════════════════════════

  private makeLine(defaultMrt = 0): SndkdLine {
    return {
      _key: this.nextKey++, NOA: null, MDIN: 0, DAN: 0, MDINAML: 0, DANAML: 0,
      NOAML: 1, SARSF: 1, MRT: Number(defaultMrt ?? 0) || 0, MEMOS: null,
    };
  }

  addLine(): void { this.details.update(list => [...list, this.makeLine(this.model().MRT2)]); }
  removeLine(key: number): void { this.details.update(list => list.filter(d => d._key !== key)); }
  updateLine(key: number, patch: Partial<SndkdLine>): void {
    this.details.update(list => list.map(d => d._key === key ? { ...d, ...patch } : d));
  }
  private getLine(key: number): SndkdLine | undefined { return this.details().find(d => d._key === key); }

  onAccountNoInput(key: number, raw: string | number): void {
    const noa = Number(raw);
    if (!noa || noa <= 0) { this.updateLine(key, { NOA: null, NAMEA: null }); return; }
    this.updateLine(key, { NOA: noa });
    void this.resolveAccountByNoa(key, noa);
  }

  private async resolveAccountByNoa(key: number, noa: number): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; items?: LovAccount[] }>(`/api/lov/accounts?q=${noa}&rtba=5&limit=10`));
      const hit = (r.ok ? r.items ?? [] : []).find(x => Number(x.NOA) === noa);
      if (hit) this.onAccountPicked(key, hit);
    } catch {}
  }

  onAccountPicked(key: number, acc: LovAccount): void {
    const currency = Number(acc.NOAML ?? 1);
    this.updateLine(key, {
      NOA: Number(acc.NOA), NAMEA: acc.NAMEA, NOAML: currency,
      SARSF: currency === 1 ? 1 : this.getLine(key)?.SARSF ?? 1,
    });
  }

  // ── Amounts Calculation ──
  onDebitInput(key: number, value: number): void {
    const v = +value || 0;
    const line = this.getLine(key);
    const rate = line?.SARSF ?? 1;
    const isLocal = (line?.NOAML ?? 1) === 1;
    this.updateLine(key, { MDIN: v, MDINAML: isLocal ? v : (line?.MDINAML ?? 0), DAN: v > 0 ? 0 : line?.DAN ?? 0, DANAML: v > 0 ? 0 : line?.DANAML ?? 0 });
    if (!isLocal && v > 0 && rate > 0) this.updateLine(key, { MDINAML: +(v / rate).toFixed(2) });
  }

  onCreditInput(key: number, value: number): void {
    const v = +value || 0;
    const line = this.getLine(key);
    const rate = line?.SARSF ?? 1;
    const isLocal = (line?.NOAML ?? 1) === 1;
    this.updateLine(key, { DAN: v, DANAML: isLocal ? v : (line?.DANAML ?? 0), MDIN: v > 0 ? 0 : line?.MDIN ?? 0, MDINAML: v > 0 ? 0 : line?.MDINAML ?? 0 });
    if (!isLocal && v > 0 && rate > 0) this.updateLine(key, { DANAML: +(v / rate).toFixed(2) });
  }

  onForeignDebitInput(key: number, value: number): void {
    const v = +value || 0;
    const rate = this.getLine(key)?.SARSF ?? 1;
    this.updateLine(key, { MDINAML: v, MDIN: +(v * rate).toFixed(2), DAN: 0, DANAML: 0 });
  }

  onForeignCreditInput(key: number, value: number): void {
    const v = +value || 0;
    const rate = this.getLine(key)?.SARSF ?? 1;
    this.updateLine(key, { DANAML: v, DAN: +(v * rate).toFixed(2), MDIN: 0, MDINAML: 0 });
  }

  onRateInput(key: number, value: number): void {
    const rate = +value || 1;
    const line = this.getLine(key);
    if (!line) return;
    if (line.MDINAML > 0) this.updateLine(key, { SARSF: rate, MDIN: +(line.MDINAML * rate).toFixed(2) });
    else if (line.DANAML > 0) this.updateLine(key, { SARSF: rate, DAN: +(line.DANAML * rate).toFixed(2) });
    else this.updateLine(key, { SARSF: rate });
  }

  onCurrencyInput(key: number, value: number): void {
    const nx = +value || 1;
    this.updateLine(key, { NOAML: nx, SARSF: nx === 1 ? 1 : this.getLine(key)?.SARSF ?? 1 });
  }

  // ══════════════════════════════════════════════════
  // UI Helpers & LOV
  // ══════════════════════════════════════════════════

  clearMessages(): void { this.err.set(null); this.info.set(null); }
  master(): Row { return this.masterRaw(); }
  masterRecord(): Row { return this.masterRaw(); }
  asStr(v: unknown): string { return String(v ?? ''); }
  trackByKey(_: number, d: SndkdLine): number { return d._key; }
  emptyGridRows(): number[] {
    const minRows = 12;
    return Array.from({ length: Math.max(0, minRows - this.details().length) }, (_, i) => i);
  }

  onTypeChange(val: string): void {
    const t = Number(val) || 1;
    this.setMasterField('TYPEMS', t);
  }

  onNosonEnter(val: string): void {
    const noson = Number(val);
    if (!noson) return;
    this.search.set(String(noson));
    const hit = this.rows().find(r => r.NOSON === noson);
    if (hit) void this.openRow(hit.NOS);
  }

  onPrint(): void {
    const nos = this.masterRaw()['NOS'];
    if (!nos) return;
    window.open(`/api/journal/sndkd/print?nos=${nos}`, '_blank');
  }

  openLovFor(key: number): void { this.lovPickingKey.set(key); }
  closeLov(): void { this.lovPickingKey.set(null); }
  onLovSelect(acc: LovAccount): void {
    const key = this.lovPickingKey();
    if (key != null) this.onAccountPicked(key, acc);
    this.closeLov();
  }

  onAccountNameInput(key: number, raw: string): void {
    const text = String(raw ?? '');
    this.updateLine(key, { NAMEA: text });
    this.accountHintsKey.set(key);
    if (this.hintsTimer) clearTimeout(this.hintsTimer);
    if (!text.trim()) { this.accountHints.set([]); return; }
    this.hintsTimer = setTimeout(() => { void this.loadAccountHints(key, text.trim()); }, 160);
  }

  private async loadAccountHints(key: number, query: string): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; items?: LovAccount[] }>(`/api/lov/accounts?q=${encodeURIComponent(query)}&rtba=5&limit=25`));
      if (this.accountHintsKey() !== key) return;
      this.accountHints.set(r.ok ? (r.items ?? []) : []);
    } catch {
      if (this.accountHintsKey() === key) this.accountHints.set([]);
    }
  }

  pickAccountFromHint(ev: MouseEvent, acc: LovAccount): void {
    ev.preventDefault();
    const key = this.accountHintsKey();
    if (key != null) this.onAccountPicked(key, acc);
    this.accountHints.set([]);
  }

  onAccountNameEnter(ev: KeyboardEvent): void {
    if (ev.key !== 'Enter') return;
    const first = this.accountHints()[0];
    if (!first) return;
    ev.preventDefault();
    const key = this.accountHintsKey();
    if (key != null) this.onAccountPicked(key, first);
    this.accountHints.set([]);
  }

  onAccountNameBlur(): void { setTimeout(() => this.accountHints.set([]), 120); }

  // ══════════════════════════════════════════════════
  // Toolbar / Navigation
  // ══════════════════════════════════════════════════

  navTo(target: 'first' | 'last' | number): void {
    const list = this.rows();
    if (!list.length) return;
    const idx = this.currentIdx();
    let next = 0;
    if (target === 'first') next = 0;
    else if (target === 'last') next = list.length - 1;
    else next = Math.min(list.length - 1, Math.max(0, idx + (target as number)));
    const row = list[next];
    if (row) void this.openRow(row.NOS);
  }

  onToolbarAction(a: LegacyToolbarActionId): void {
    switch (a) {
      case 'new':     this.onNew(); break;
      case 'edit':    this.onEdit(); break;
      case 'delete':  void this.onDelete(); break;
      case 'save':    void this.onSave(); break;
      case 'cancel':  this.onCancel(); break;
      case 'refresh': this.onNewFromCurrent(); break;
      case 'post':    void this.onPost(); break;
      case 'unpost':  void this.onUnpost(); break;
      case 'print':   this.onPrint(); break;
      case 'search':  this.openSearch(); break;
      case 'report':  void this.router.navigate(['/app/screens/REPKD']); break;
      case 'export':  this.exportToExcel(); break;
      case 'exit':    void this.router.navigate(['/app']); break;
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(ev: KeyboardEvent): void {
    const shortcut = resolveLegacyShortcut(ev, { allowWhenInput: { refresh: true } });
    if (!shortcut) return;
    switch (shortcut) {
      case 'search':  ev.preventDefault(); if (this.canSar()) this.openSearch(); break;
      case 'refresh': ev.preventDefault(); if (!this.editable() && this.masterRaw()['NOS']) this.onNewFromCurrent(); break;
      case 'print':   ev.preventDefault(); if (this.canPr() && this.masterRaw()['NOS']) this.onPrint(); break;
      case 'cancel':  ev.preventDefault(); if (this.editable()) this.onCancel(); break;
      case 'edit':    ev.preventDefault(); if (!this.editable() && this.masterRaw()['NOS']) this.onEdit(); break;
      case 'save':    ev.preventDefault(); if (this.editable()) void this.onSave(); break;
      case 'exit':    ev.preventDefault(); void this.router.navigate(['/app']); break;
    }
  }

  // ── Search (Stubs for missing advanced search methods) ──
  openSearch(): void { this.searchOpen.set(true); }
  closeSearch(): void { this.searchOpen.set(false); }

  updateCriterion(key: keyof ReturnType<typeof this.searchCriteria>, value: unknown): void {
    this.searchCriteria.update(c => ({ ...c, [key]: value }));
  }

  executeSearch(): void {
    this.searchBusy.set(true);
    // Stub implementation to mimic API filter locally for demonstration
    setTimeout(() => {
      const criteria = this.searchCriteria();
      const filtered = this.rows().filter(r => {
        if (criteria.memo && !String(r.MEMOS ?? '').includes(criteria.memo)) return false;
        if (criteria.posted && String(r.MRHL) !== (criteria.posted === '1' ? '0' : '1')) return false;
        // More criteria handling...
        return true;
      });
      this.searchResults.set(filtered);
      this.searchBusy.set(false);
    }, 400);
  }

  resetSearch(): void {
    this.searchCriteria.set({ dateFrom: '', dateTo: '', memo: '', minAmount: '', maxAmount: '', posted: '' as ''|'1'|'0', nomsro: '', noa: '' });
    this.searchResults.set([]);
  }

  pickSearchResult(nos: number): void {
    this.closeSearch();
    if (nos) void this.openRow(nos);
  }

  onLegacySelectNos(raw: string | number): void {
    const nos = Number(raw);
    if (nos) void this.openRow(nos);
  }

  // Error normalization utility
  private toMsg(v: unknown): string {
    if (v instanceof HttpErrorResponse) return v.error?.message || v.message || 'خطأ في الاتصال بالخادم';
    if (v instanceof Error) return v.message;
    if (typeof v === 'string') return v;
    return 'حدث خطأ غير متوقع';
  }

  /** تصدير القيد الحالي إلى Excel (XHTML → .xls) مع تنسيق كامل RTL */
  exportToExcel(): void {
    const d = this.details();
    if (!d.length) { this.err.set('لا توجد بيانات للتصدير'); return; }
    const nos = this.masterRaw()['NOS'] || 'export';
    const noson = this.masterRaw()['NOSON'] || '';
    const rawDate = this.masterRaw()['DATES'] || '';
    const dates = rawDate ? new Date(String(rawDate)).toLocaleDateString('en-GB') : '';
    const xls = `
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="UTF-8">
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>قيد ${noson}</x:Name>
<x:WorksheetOptions><x:DisplayRightToLeft/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>
  td,th { font-family: Tahoma; font-size: 12px; border: 1px solid #808080; padding: 3px 6px; }
  th { background: #6B8CAE; color: #fff; font-weight: bold; text-align: center; }
  .num { mso-number-format:"\\#\\,\\#\\#0\\.00"; text-align: left; font-family: Consolas; }
  .hdr { background: #C0C0C0; font-weight: bold; }
  .total { background: #FFB6C1; font-weight: bold; font-family: Consolas; }
</style></head>
<body>
<table dir="rtl">
  <tr><td class="hdr" colspan="5">قيد رقم: ${noson}</td><td class="hdr" colspan="5">التاريخ: ${dates}</td></tr>
  <tr>
    <th>رقم الحساب</th>
    <th>اسم الحساب</th>
    <th>العملة</th>
    <th>سعر الصرف</th>
    <th>مدين عملة محلية</th>
    <th>دائن عملة محلية</th>
    <th>مدين عملة اجنبية</th>
    <th>دائن عملة اجنبية</th>
    <th>البيان</th>
    <th>مركز التكلفة</th>
  </tr>
  ${d.map(r => `<tr>
    <td class="num">${r.NOA || ''}</td>
    <td>${r.NAMEA || ''}</td>
    <td class="num">${r.NOAML || ''}</td>
    <td class="num">${r.SARSF || ''}</td>
    <td class="num">${r.MDIN || 0}</td>
    <td class="num">${r.DAN || 0}</td>
    <td class="num">${r.MDINAML || 0}</td>
    <td class="num">${r.DANAML || 0}</td>
    <td>${r.MEMOS || ''}</td>
    <td class="num">${r.MRT || ''}</td>
  </tr>`).join('')}
  <tr>
    <td class="total" colspan="4">الاجمالي</td>
    <td class="total">${this.totalDebit().toLocaleString('en', {minimumFractionDigits:2})}</td>
    <td class="total">${this.totalCredit().toLocaleString('en', {minimumFractionDigits:2})}</td>
    <td class="total" colspan="4"></td>
  </tr>
</table></body></html>`;
    const blob = new Blob(['\uFEFF' + xls], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `SNDKD_${noson || nos}.xls`; a.click();
    URL.revokeObjectURL(url);
    this.info.set('تم التصدير بنجاح');
  }

  /** تحويل مبلغ إلى كلمات عربية (تفقيط) — مبسّط */
  private numberToArabicWords(n: number): string {
    if (!n || n === 0) return '';
    const ones = ['','واحد','اثنان','ثلاثة','أربعة','خمسة','ستة','سبعة','ثمانية','تسعة',
                  'عشرة','أحد عشر','اثنا عشر','ثلاثة عشر','أربعة عشر','خمسة عشر',
                  'ستة عشر','سبعة عشر','ثمانية عشر','تسعة عشر'];
    const tens = ['','','عشرون','ثلاثون','أربعون','خمسون','ستون','سبعون','ثمانون','تسعون'];
    const toWords = (num: number): string => {
      if (num === 0) return '';
      if (num < 20) return ones[num];
      if (num < 100) {
        const t = Math.floor(num / 10), o = num % 10;
        return o ? `${ones[o]} و${tens[t]}` : tens[t];
      }
      if (num < 1000) {
        const h = Math.floor(num / 100), rest = num % 100;
        const hWord = h === 1 ? 'مائة' : h === 2 ? 'مائتان' : `${ones[h]}مائة`;
        return rest ? `${hWord} و${toWords(rest)}` : hWord;
      }
      if (num < 1000000) {
        const th = Math.floor(num / 1000), rest = num % 1000;
        let thWord: string;
        if (th === 1) thWord = 'ألف';
        else if (th === 2) thWord = 'ألفان';
        else if (th >= 3 && th <= 10) thWord = `${toWords(th)} آلاف`;
        else thWord = `${toWords(th)} ألف`;
        return rest ? `${thWord} و${toWords(rest)}` : thWord;
      }
      if (num < 1000000000) {
        const m = Math.floor(num / 1000000), rest = num % 1000000;
        let mWord: string;
        if (m === 1) mWord = 'مليون';
        else if (m === 2) mWord = 'مليونان';
        else if (m >= 3 && m <= 10) mWord = `${toWords(m)} ملايين`;
        else mWord = `${toWords(m)} مليون`;
        return rest ? `${mWord} و${toWords(rest)}` : mWord;
      }
      return String(num);
    };
    const intPart = Math.floor(Math.abs(n));
    const words = toWords(intPart);
    // العملة — ريال يمني
    return words ? `${words} ريال يمني` : '';
  }
}
