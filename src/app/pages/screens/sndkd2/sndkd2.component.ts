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
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LovPickerComponent, type LovAccount } from '../../../shared/lov-picker/lov-picker.component';
import { PermissionService } from '../../../services/permission.service';
import { LegacyToolbarComponent } from '../../../shared/legacy-ui/legacy-toolbar/legacy-toolbar.component';
import { LegacyStatusBarComponent, type LegacyStatusBadge } from '../../../shared/legacy-ui/legacy-status-bar/legacy-status-bar.component';
import { LegacyAuditFooterComponent } from '../../../shared/legacy-ui/legacy-audit-footer/legacy-audit-footer.component';
import { LegacyToolbarActionId } from '../../../shared/legacy-ui/contracts/legacy-contracts';
import { resolveLegacyShortcut } from '../../../shared/legacy-ui/behaviors/legacy-keyboard-map';
import { LEGACY_SCREEN_SPECS } from '../../../shared/legacy-ui/manifests/legacy-screen-specs';
interface Sndkd2Row {
  NOS: number;
  NOSON: number | null;
  DATES: string;
  NOA: number;
  NOA2: number;
  MDIN: number;
  DAN: number;
  NOAML: number;
  NOAML2: number;
  MEMOSA: string | null;
  MRHL: number;
  NOK: number | null;
  NOUSX: number | null;
}

interface Sndkd2Master {
  NOS?: number;
  NOSON?: number;
  DATES?: string;
  NOK?: number;
  MRHL?: number;
  MRT?: number;

  NOA?: number;
  NAMEA?: string | null;
  NOAML?: number;
  SARSF?: number;
  MDIN?: number;
  MDINAML?: number;
  NOMSRO?: number;
  NOAMLM?: number;
  MEMOSA1?: string | null;

  NOA2?: number;
  NAMEA2?: string | null;
  NOAML2?: number;
  SARSF2?: number;
  DAN?: number;
  DANAML?: number;
  NOMSRO2?: number;
  NOAMLM2?: number;
  MEMOSA2?: string | null;

  MEMOSA?: string | null;

  DI?: string;
  DE?: string;
  PCI?: string;
  PCE?: string;
  NED?: number;
  NOUSX?: number;
  NOUSXU?: number;
}

interface Currency {
  NO: number;
  NAMEM3: string;
  SARS: number;
  SARS1: number;
  SARS2: number;
}

@Component({
  selector: 'app-sndkd2',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, DatePipe, DecimalPipe,
    LovPickerComponent,
    LegacyToolbarComponent,
    LegacyStatusBarComponent,
    LegacyAuditFooterComponent,
  ],
  templateUrl: './sndkd2.component.html',
  styleUrl: './sndkd2.component.scss',
})
export class Sndkd2Component implements OnInit {
  private http = inject(HttpClient);
  private permSvc = inject(PermissionService);

  readonly screenCode = 'SNDKD2.FMX';
  readonly screenSpec = LEGACY_SCREEN_SPECS['SNDKD2'];

  private readonly perms = computed(() => this.permSvc.forScreen(this.screenCode)());
  readonly canIns = computed(() => (this.perms()?.ins ?? 0) > 0);
  readonly canEd = computed(() => (this.perms()?.ed ?? 0) > 0);
  readonly canDe = computed(() => (this.perms()?.de ?? 0) > 0);
  readonly canPr = computed(() => (this.perms()?.pr ?? 0) > 0);

  readonly rows = signal<Sndkd2Row[]>([]);
  readonly master = signal<Sndkd2Master>({});
  readonly mode = signal<'browse' | 'new' | 'edit'>('browse');
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);
  readonly search = signal('');
  readonly manualPosting = signal(false);
  readonly currencies = signal<Currency[]>([]);
  readonly printAfterSave = signal(false);

  readonly lovPickingSide = signal<1 | 2 | null>(null);
  readonly lovOpen = computed(() => this.lovPickingSide() !== null);

  readonly searchOpen = signal(false);
  readonly searchBusy = signal(false);
  readonly searchResults = signal<Sndkd2Row[]>([]);
  readonly searchCriteria = signal<{
    dateFrom: string; dateTo: string; memo: string;
    minAmount: string; maxAmount: string;
    posted: '' | '1' | '0';
    noa: string;
  }>({
    dateFrom: '', dateTo: '', memo: '',
    minAmount: '', maxAmount: '', posted: '',
    noa: '',
  });

  updateCriterion<K extends keyof ReturnType<typeof this.searchCriteria>>(
    key: K,
    value: ReturnType<typeof this.searchCriteria>[K],
  ): void {
    this.searchCriteria.update(criteria => ({ ...criteria, [key]: value }));
  }

  readonly posted = computed(() => !!this.master().NOS && Number(this.master().MRHL ?? 0) === 0);
  readonly postingLocked = computed(() => this.manualPosting() && this.posted());
  readonly editable = computed(() => this.mode() !== 'browse');
  readonly amount = computed(() => Number(this.master().MDIN ?? 0));
  readonly balanced = computed(() => {
    const mdin = Number(this.master().MDIN ?? 0);
    const dan = Number(this.master().DAN ?? 0);
    return Math.abs(mdin - dan) < 0.005;
  });

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) return this.rows();
    return this.rows().filter(row =>
      String(row.NOS).includes(q)
      || String(row.NOSON ?? '').includes(q)
      || String(row.NOA).includes(q)
      || String(row.NOA2).includes(q)
      || String(row.MEMOSA ?? '').toLowerCase().includes(q)
    );
  });

  readonly currentIdx = computed(() => {
    const nos = this.master().NOS;
    if (!nos) return -1;
    return this.rows().findIndex(row => row.NOS === nos);
  });

  readonly debitRateWarning = computed(() => this.rateWarning(1));
  readonly creditRateWarning = computed(() => this.rateWarning(2));

  readonly statusBadges = computed<LegacyStatusBadge[]>(() => {
    const m = this.master();
    const out: LegacyStatusBadge[] = [];
    if (m.NOSON) out.push({ label: `مسلسل: ${m.NOSON}`, icon: 'pi-hashtag', variant: 'info' });
    if (m.NOS) out.push({ label: `رقم داخلي: ${m.NOS}`, icon: 'pi-key', variant: 'info' });
    if (m.DATES) {
      const d = new Date(String(m.DATES));
      if (!Number.isNaN(d.getTime())) {
        out.push({
          label: d.toLocaleDateString('ar-EG', { year: 'numeric', month: '2-digit', day: '2-digit' }),
          icon: 'pi-calendar',
          variant: 'info',
        });
      }
    }
    if (this.posted()) out.push({ label: `مرحل - قيد ${m.NOK ?? '-'}`, icon: 'pi-check-square', variant: 'success' });
    else if (m.NOS) out.push({ label: 'غير مرحل', icon: 'pi-clock', variant: 'warning' });
    if (m.NOA || m.NOA2) {
      out.push(this.balanced()
        ? { label: `متوازن: ${this.amount().toLocaleString('ar-EG')}`, icon: 'pi-check', variant: 'success' }
        : { label: 'غير متوازن', icon: 'pi-exclamation-triangle', variant: 'warning' });
    }
    if (this.debitRateWarning()) {
      out.push({ label: this.debitRateWarning()!, icon: 'pi-exclamation-triangle', variant: 'warning' });
    }
    if (this.creditRateWarning()) {
      out.push({ label: this.creditRateWarning()!, icon: 'pi-exclamation-triangle', variant: 'warning' });
    }
    return out;
  });

  readonly masterAsRecord = computed<Record<string, unknown>>(() =>
    this.master() as unknown as Record<string, unknown>,
  );

  clearMessages(): void {
    this.err.set(null);
    this.info.set(null);
  }

  async ngOnInit(): Promise<void> {
    await Promise.all([this.fetchList(), this.fetchCurrencies(), this.fetchTitl()]);
  }

  async fetchTitl(): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.http.get<{ ok: boolean; titl?: { SANDT?: number | string | null } }>('/api/titl'),
      );
      if (response.ok) {
        this.manualPosting.set(Number(response.titl?.SANDT ?? 0) > 0);
      }
    } catch {
      this.manualPosting.set(false);
    }
  }

  async fetchList(): Promise<void> {
    this.loading.set(true);
    try {
      const currentNos = this.master().NOS;
      const response = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: Sndkd2Row[]; error?: string }>('/api/journal/sndkd2/list?limit=200'),
      );
      if (!response.ok) throw new Error(response.error);
      const list = response.rows ?? [];
      this.rows.set(list);

      if (this.mode() === 'browse') {
        if (!list.length) {
          this.master.set({});
        } else {
          const targetNos = currentNos && list.some(row => row.NOS === currentNos) ? currentNos : list[0]!.NOS;
          if (targetNos && this.master().NOS !== targetNos) await this.openRow(targetNos);
        }
      }
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.loading.set(false);
  }

  async fetchCurrencies(): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.http.get<{ ok: boolean; rows?: Array<Record<string, unknown>>; error?: string }>('/api/currencies'),
      );
      if (!response.ok) throw new Error(response.error);
      this.currencies.set((response.rows ?? []).map(row => ({
        NO: Number(row['NO'] ?? 0),
        NAMEM3: String(row['NAMEM3'] ?? row['NAMEM'] ?? row['NO'] ?? ''),
        SARS: Number(row['SARS'] ?? 1),
        SARS1: Number(row['SARS1'] ?? 0),
        SARS2: Number(row['SARS2'] ?? 0),
      })));
    } catch {
      this.currencies.set([]);
    }
  }

  async openRow(nos: number): Promise<void> {
    this.loading.set(true);
    this.err.set(null);
    try {
      const response = await firstValueFrom(
        this.http.get<{ ok: boolean; master: Record<string, unknown>; error?: string }>(`/api/journal/sndkd2?nos=${nos}`),
      );
      if (!response.ok) throw new Error(response.error);
      const m = response.master ?? {};
      const noa = Number(m['NOA'] ?? 0);
      const noa2 = Number(m['NOA2'] ?? 0);
      const accounts = await this.ensureAccountNames([noa, noa2]);

      this.master.set({
        NOS: Number(m['NOS']),
        NOSON: m['NOSON'] == null ? undefined : Number(m['NOSON']),
        DATES: m['DATES'] ? String(m['DATES']) : undefined,
        NOK: m['NOK'] == null ? undefined : Number(m['NOK']),
        MRHL: Number(m['MRHL'] ?? 0),
        MRT: Number(m['MRT'] ?? 0),

        NOA: noa,
        NAMEA: accounts.get(noa) ?? null,
        NOAML: Number(m['NOAML'] ?? 1),
        SARSF: Number(m['SARSF'] ?? 1),
        MDIN: Number(m['MDIN'] ?? 0),
        MDINAML: Number(m['MDINAML'] ?? 0),
        NOMSRO: Number(m['NOMSRO'] ?? 0),
        NOAMLM: Number(m['NOAMLM'] ?? 0),
        MEMOSA1: (m['MEMOSA1'] as string | null) ?? null,

        NOA2: noa2,
        NAMEA2: accounts.get(noa2) ?? null,
        NOAML2: Number(m['NOAML2'] ?? 1),
        SARSF2: Number(m['SARSF2'] ?? 1),
        DAN: Number(m['DAN'] ?? 0),
        DANAML: Number(m['DANAML'] ?? 0),
        NOMSRO2: Number(m['NOMSRO2'] ?? 0),
        NOAMLM2: Number(m['NOAMLM2'] ?? 0),
        MEMOSA2: (m['MEMOSA2'] as string | null) ?? null,

        MEMOSA: (m['MEMOSA'] as string | null) ?? null,

        DI: m['DI'] ? String(m['DI']) : undefined,
        DE: m['DE'] ? String(m['DE']) : undefined,
        PCI: (m['PCI'] as string | undefined) ?? undefined,
        PCE: (m['PCE'] as string | undefined) ?? undefined,
        NED: m['NED'] == null ? undefined : Number(m['NED']),
        NOUSX: m['NOUSX'] == null ? undefined : Number(m['NOUSX']),
        NOUSXU: m['NOUSXU'] == null ? undefined : Number(m['NOUSXU']),
      });
      this.mode.set('browse');
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.loading.set(false);
  }

  private async ensureAccountNames(noas: number[]): Promise<Map<number, string>> {
    const ids = Array.from(new Set(noas.filter(noa => noa > 0)));
    const out = new Map<number, string>();
    await Promise.all(ids.map(async noa => {
      try {
        const response = await firstValueFrom(
          this.http.get<{ ok: boolean; items?: LovAccount[] }>(`/api/lov/accounts?q=${noa}&rtba=5&limit=5`),
        );
        const hit = response.items?.find(item => Number(item.NOA) === noa);
        if (hit) out.set(noa, String(hit.NAMEA));
      } catch {
        // ignore
      }
    }));
    return out;
  }

  navTo(target: 'first' | 'last' | number): void {
    const list = this.rows();
    if (!list.length) return;
    const idx = this.currentIdx();
    let next = 0;
    if (target === 'first') next = 0;
    else if (target === 'last') next = list.length - 1;
    else next = Math.min(list.length - 1, Math.max(0, idx + target));
    const row = list[next];
    if (row) void this.openRow(row.NOS);
  }

  onNew(): void {
    this.master.set({
      DATES: new Date().toISOString().slice(0, 10),
      NOAML: 1,
      NOAML2: 1,
      SARSF: 1,
      SARSF2: 1,
      MDIN: 0,
      DAN: 0,
      MDINAML: 0,
      DANAML: 0,
      MEMOSA: '',
      MEMOSA1: '',
      MEMOSA2: '',
    });
    this.mode.set('new');
    this.clearMessages();
  }

  onEdit(): void {
    if (!this.master().NOS) return;
    if (this.postingLocked()) {
      this.err.set('لا يمكن تعديل مستند مرحل، يجب إلغاء الترحيل أولاً');
      return;
    }
    this.mode.set('edit');
  }

  onCancel(): void {
    this.mode.set('browse');
    this.err.set(null);
    if (this.master().NOS) void this.openRow(this.master().NOS!);
    else this.master.set({});
  }

  patchMaster(patch: Partial<Sndkd2Master>): void {
    this.master.update(master => ({ ...master, ...patch }));
  }

  private round2(value: number): number {
    return +((Number(value) || 0).toFixed(2));
  }

  private round4(value: number): number {
    return +((Number(value) || 0).toFixed(4));
  }

  private normalizeCurrencyNo(no: unknown): number {
    const value = Number(no ?? 1);
    return value > 0 ? value : 1;
  }

  private findCurrency(no: unknown): Currency | null {
    const wanted = this.normalizeCurrencyNo(no);
    return this.currencies().find(currency => currency.NO === wanted) ?? null;
  }

  private defaultRateFor(no: unknown): number {
    const currencyNo = this.normalizeCurrencyNo(no);
    if (currencyNo === 1) return 1;
    const currency = this.findCurrency(currencyNo);
    return this.round4(Number(currency?.SARS ?? 1) || 1);
  }

  private normalizeRate(no: unknown, rate: unknown): number {
    const currencyNo = this.normalizeCurrencyNo(no);
    if (currencyNo === 1) return 1;
    const numericRate = Number(rate ?? 0);
    return this.round4(numericRate > 0 ? numericRate : this.defaultRateFor(currencyNo));
  }

  private foreignFromLocal(local: number, no: unknown, rate: unknown): number {
    const currencyNo = this.normalizeCurrencyNo(no);
    if (currencyNo === 1) return this.round2(local);
    const numericRate = Number(rate ?? 0);
    if (numericRate <= 0) return 0;
    return this.round2(local / numericRate);
  }

  private localFromForeign(foreign: number, no: unknown, rate: unknown): number {
    const currencyNo = this.normalizeCurrencyNo(no);
    if (currencyNo === 1) return this.round2(foreign);
    return this.round2(foreign * (Number(rate ?? 0) || 1));
  }

  private syncFromLocal(localValue: number, patch: Partial<Sndkd2Master> = {}): void {
    const base = { ...this.master(), ...patch };
    const noaml = this.normalizeCurrencyNo(base.NOAML);
    const noaml2 = this.normalizeCurrencyNo(base.NOAML2);
    const rate1 = this.normalizeRate(noaml, base.SARSF);
    const rate2 = this.normalizeRate(noaml2, base.SARSF2);
    const local = this.round2(localValue);
    this.patchMaster({
      ...patch,
      NOAML: noaml,
      NOAML2: noaml2,
      SARSF: rate1,
      SARSF2: rate2,
      MDIN: local,
      DAN: local,
      MDINAML: this.foreignFromLocal(local, noaml, rate1),
      DANAML: this.foreignFromLocal(local, noaml2, rate2),
    });
  }

  private rateWarning(side: 1 | 2): string | null {
    const master = this.master();
    const currencyNo = side === 1
      ? this.normalizeCurrencyNo(master.NOAML)
      : this.normalizeCurrencyNo(master.NOAML2);
    const rate = side === 1 ? Number(master.SARSF ?? 0) : Number(master.SARSF2 ?? 0);
    const label = side === 1 ? 'سعر صرف الطرف المدين' : 'سعر صرف الطرف الدائن';
    if (currencyNo === 1) return null;
    if (rate <= 0) return `يجب إدخال ${label}`;
    const currency = this.findCurrency(currencyNo);
    if (!currency) return null;
    if (currency.SARS1 > 0 && rate > currency.SARS1) {
      return `${label} (${rate}) أكبر من الحد الأعلى (${currency.SARS1})`;
    }
    if (currency.SARS2 > 0 && rate < currency.SARS2) {
      return `${label} (${rate}) أقل من الحد الأدنى (${currency.SARS2})`;
    }
    return null;
  }

  private validateDateNotFuture(): string | null {
    const raw = String(this.master().DATES ?? '').trim();
    if (!raw) return null;
    const candidate = new Date(raw);
    if (Number.isNaN(candidate.getTime())) return 'التاريخ غير صالح';
    const today = new Date();
    candidate.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    if (candidate > today) return 'لا يمكن إدخال تاريخ أكبر من تاريخ اليوم';
    return null;
  }

  onAmountInput(value: number): void {
    this.syncFromLocal(+value || 0);
  }

  onForeignDebitInput(value: number): void {
    const foreign = this.round2(+value || 0);
    const master = this.master();
    const rate1 = this.normalizeRate(master.NOAML, master.SARSF);
    const local = this.localFromForeign(foreign, master.NOAML, rate1);
    const rate2 = this.normalizeRate(master.NOAML2, master.SARSF2);
    this.patchMaster({
      SARSF: rate1,
      SARSF2: rate2,
      MDINAML: foreign,
      MDIN: local,
      DAN: local,
      DANAML: this.foreignFromLocal(local, master.NOAML2, rate2),
    });
  }

  onForeignCreditInput(value: number): void {
    const foreign = this.round2(+value || 0);
    const master = this.master();
    const rate2 = this.normalizeRate(master.NOAML2, master.SARSF2);
    const local = this.localFromForeign(foreign, master.NOAML2, rate2);
    const rate1 = this.normalizeRate(master.NOAML, master.SARSF);
    this.patchMaster({
      SARSF: rate1,
      SARSF2: rate2,
      DANAML: foreign,
      DAN: local,
      MDIN: local,
      MDINAML: this.foreignFromLocal(local, master.NOAML, rate1),
    });
  }

  onRateInput(side: 1 | 2, value: number): void {
    const master = this.master();
    if (side === 1) {
      const rate1 = this.normalizeRate(master.NOAML, value);
      const foreign = Number(master.MDINAML ?? 0);
      if (foreign > 0) {
        const local = this.localFromForeign(foreign, master.NOAML, rate1);
        const rate2 = this.normalizeRate(master.NOAML2, master.SARSF2);
        this.patchMaster({
          SARSF: rate1,
          SARSF2: rate2,
          MDIN: local,
          DAN: local,
          DANAML: this.foreignFromLocal(local, master.NOAML2, rate2),
        });
      } else {
        this.syncFromLocal(Number(master.MDIN ?? 0), { SARSF: rate1 });
      }
      return;
    }

    const rate2 = this.normalizeRate(master.NOAML2, value);
    const foreign = Number(master.DANAML ?? 0);
    if (foreign > 0) {
      const local = this.localFromForeign(foreign, master.NOAML2, rate2);
      const rate1 = this.normalizeRate(master.NOAML, master.SARSF);
      this.patchMaster({
        SARSF: rate1,
        SARSF2: rate2,
        DAN: local,
        MDIN: local,
        MDINAML: this.foreignFromLocal(local, master.NOAML, rate1),
      });
    } else {
      this.syncFromLocal(Number(master.DAN ?? master.MDIN ?? 0), { SARSF2: rate2 });
    }
  }

  onCurrencyInput(side: 1 | 2, value: number): void {
    const currency = this.normalizeCurrencyNo(value);
    const local = Number(this.master().MDIN ?? 0);
    if (side === 1) {
      this.syncFromLocal(local, { NOAML: currency, SARSF: this.defaultRateFor(currency) });
    } else {
      this.syncFromLocal(local, { NOAML2: currency, SARSF2: this.defaultRateFor(currency) });
    }
  }

  openLovFor(side: 1 | 2): void {
    this.lovPickingSide.set(side);
  }

  closeLov(): void {
    this.lovPickingSide.set(null);
  }

  onLovSelect(acc: LovAccount): void {
    const side = this.lovPickingSide();
    const currency = Number(acc.NOAML ?? 1);
    const local = Number(this.master().MDIN ?? 0);
    if (side === 1) {
      this.syncFromLocal(local, {
        NOA: Number(acc.NOA),
        NAMEA: acc.NAMEA,
        NOAML: currency,
        SARSF: this.defaultRateFor(currency),
      });
    } else if (side === 2) {
      this.syncFromLocal(local, {
        NOA2: Number(acc.NOA),
        NAMEA2: acc.NAMEA,
        NOAML2: currency,
        SARSF2: this.defaultRateFor(currency),
      });
    }
    this.closeLov();
  }

  validate(): boolean {
    const master = this.master();
    if (!master.DATES) { this.err.set('يجب إدخال التاريخ'); return false; }
    const futureDateErr = this.validateDateNotFuture();
    if (futureDateErr) { this.err.set(futureDateErr); return false; }
    if (!master.NOA) { this.err.set('يجب اختيار الطرف المدين (من)'); return false; }
    if (!master.NOA2) { this.err.set('يجب اختيار الطرف الدائن (إلى)'); return false; }
    if (master.NOA === master.NOA2) { this.err.set('لا يمكن التحويل من حساب إلى نفس الحساب'); return false; }
    if (Number(master.MDIN ?? 0) <= 0) { this.err.set('يجب إدخال مبلغ التحويل'); return false; }
    if (this.debitRateWarning()) { this.err.set(this.debitRateWarning()!); return false; }
    if (this.creditRateWarning()) { this.err.set(this.creditRateWarning()!); return false; }
    if (!this.balanced()) { this.err.set('مجموع المدين لا يساوي مجموع الدائن'); return false; }
    return true;
  }

  async onSave(): Promise<void> {
    if (!this.validate()) return;
    this.saving.set(true);
    this.err.set(null);
    try {
      const verb = this.mode() === 'edit' ? 'PUT' : 'POST';
      const response = await firstValueFrom(
        this.http.request<{ ok: boolean; message?: string; error?: string; nos?: number }>(
          verb,
          '/api/journal/sndkd2',
          { body: { master: this.master() } },
        ),
      );
      if (!response.ok) throw new Error(response.error);
      this.info.set(response.message ?? 'تم الحفظ');
      const targetNos = response.nos ?? this.master().NOS;
      this.mode.set('browse');
      await this.fetchList();
      if (targetNos && this.master().NOS !== targetNos) await this.openRow(targetNos);
      if (this.printAfterSave() && targetNos) this.onPrint(targetNos);
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.saving.set(false);
  }

  async onDelete(): Promise<void> {
    const nos = this.master().NOS;
    if (!nos) return;
    if (this.postingLocked()) {
      this.err.set('لا يمكن حذف مستند مرحل، يجب إلغاء الترحيل أولاً');
      return;
    }
    if (!confirm(`هل أنت متأكد من حذف قيد التحويل رقم ${nos}؟`)) return;
    this.saving.set(true);
    this.err.set(null);
    try {
      const response = await firstValueFrom(
        this.http.delete<{ ok: boolean; message?: string; error?: string }>(`/api/journal/sndkd2?nos=${nos}`),
      );
      if (!response.ok) throw new Error(response.error);
      this.info.set(response.message ?? 'تم الحذف');
      this.master.set({});
      this.mode.set('browse');
      await this.fetchList();
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.saving.set(false);
  }

  async onPost(): Promise<void> {
    const nos = this.master().NOS;
    if (!nos) return;
    if (!this.manualPosting()) {
      this.info.set('القيد يترحل آلياً حسب الإعدادات الأساسية');
      return;
    }
    if (this.posted()) {
      this.info.set('القيد مرحل بالفعل');
      return;
    }
    if (!confirm(`ترحيل قيد التحويل ${nos} إلى دفتر اليومية؟`)) return;
    this.saving.set(true);
    this.err.set(null);
    try {
      const response = await firstValueFrom(
        this.http.post<{ ok: boolean; message?: string; error?: string; nok?: number; rows?: number }>(
          `/api/journal/sndkd2/post?nos=${nos}`,
          {},
        ),
      );
      if (!response.ok) throw new Error(response.error);
      this.info.set(`${response.message ?? 'تم الترحيل'} - قيد ${response.nok}, ${response.rows} سطر`);
      await this.openRow(nos);
      await this.fetchList();
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.saving.set(false);
  }

  async onUnpost(): Promise<void> {
    const nos = this.master().NOS;
    if (!nos) return;
    if (!this.manualPosting()) {
      this.info.set('إلغاء الترحيل يدوي فقط حسب الإعدادات الأساسية');
      return;
    }
    if (!this.posted()) return;
    if (!confirm(`إلغاء ترحيل قيد التحويل ${nos}؟`)) return;
    this.saving.set(true);
    this.err.set(null);
    try {
      const response = await firstValueFrom(
        this.http.post<{ ok: boolean; message?: string; error?: string; deleted?: number }>(
          `/api/journal/sndkd2/unpost?nos=${nos}`,
          {},
        ),
      );
      if (!response.ok) throw new Error(response.error);
      this.info.set(response.message ?? 'تم إلغاء الترحيل');
      await this.openRow(nos);
      await this.fetchList();
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.saving.set(false);
  }

  onPrint(nos = this.master().NOS): void {
    if (!nos) {
      this.info.set('لا يوجد قيد للطباعة');
      return;
    }
    const popup = window.open(`/api/journal/sndkd2/print?nos=${nos}`, '_blank');
    if (!popup) {
      this.err.set('فشل فتح نافذة الطباعة - الرجاء السماح للنوافذ المنبثقة');
    }
  }

  onToolbarAction(action: LegacyToolbarActionId): void {
    switch (action) {
      case 'new': this.onNew(); break;
      case 'edit': this.onEdit(); break;
      case 'delete': void this.onDelete(); break;
      case 'save': void this.onSave(); break;
      case 'cancel': this.onCancel(); break;
      case 'refresh': void this.fetchList(); break;
      case 'post': void this.onPost(); break;
      case 'unpost': void this.onUnpost(); break;
      case 'print': this.onPrint(); break;
      case 'search': this.openSearch(); break;
      case 'exit': this.clearMessages(); break;
      default: break;
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(ev: KeyboardEvent): void {
    const shortcut = resolveLegacyShortcut(ev, {
      allowWhenInput: { refresh: true },
    });
    if (!shortcut) return;

    switch (shortcut) {
      case 'search':
        ev.preventDefault();
        this.openSearch();
        break;
      case 'refresh':
        ev.preventDefault();
        void this.fetchList();
        break;
      case 'print':
        ev.preventDefault();
        this.onPrint();
        break;
      case 'cancel':
        ev.preventDefault();
        this.onCancel();
        break;
      case 'edit':
        ev.preventDefault();
        this.onEdit();
        break;
      case 'save':
        ev.preventDefault();
        if (this.editable()) void this.onSave();
        break;
      case 'props':
        ev.preventDefault();
        this.openSearch();
        break;
      case 'exit':
        ev.preventDefault();
        this.clearMessages();
        break;
    }
  }

  openSearch(): void {
    this.searchOpen.set(true);
    const master = this.master();
    if (master.DATES && !this.searchCriteria().dateFrom) {
      const year = String(master.DATES).slice(0, 4);
      this.updateCriterion('dateFrom', `${year}-01-01`);
      this.updateCriterion('dateTo', `${year}-12-31`);
    }
  }

  closeSearch(): void {
    this.searchOpen.set(false);
  }

  resetSearch(): void {
    this.searchCriteria.set({
      dateFrom: '',
      dateTo: '',
      memo: '',
      minAmount: '',
      maxAmount: '',
      posted: '',
      noa: '',
    });
    this.searchResults.set([]);
  }

  async executeSearch(): Promise<void> {
    this.searchBusy.set(true);
    try {
      const criteria = this.searchCriteria();
      const params = new URLSearchParams();
      if (criteria.dateFrom) params.set('dateFrom', criteria.dateFrom);
      if (criteria.dateTo) params.set('dateTo', criteria.dateTo);
      if (criteria.memo) params.set('memo', criteria.memo);
      if (criteria.minAmount) params.set('minAmount', criteria.minAmount);
      if (criteria.maxAmount) params.set('maxAmount', criteria.maxAmount);
      if (criteria.posted) params.set('posted', criteria.posted);
      if (criteria.noa) params.set('noa', criteria.noa);

      const response = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: Sndkd2Row[]; count: number; error?: string }>(
          `/api/journal/sndkd2/search?${params.toString()}`,
        ),
      );
      if (!response.ok) throw new Error(response.error);
      this.searchResults.set(response.rows ?? []);
      if (response.count === 0) this.info.set('لم يتم العثور على قيود مطابقة');
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.searchBusy.set(false);
  }

  async pickSearchResult(nos: number): Promise<void> {
    this.closeSearch();
    await this.openRow(nos);
  }

  async jumpByNoson(noson: number): Promise<void> {
    const year = Number(String(this.master().DATES ?? new Date().toISOString()).slice(0, 4));
    if (!noson || !year) return;
    try {
      const response = await firstValueFrom(
        this.http.get<{ ok: boolean; nos?: number; error?: string }>(
          `/api/journal/sndkd2/by-noson?noson=${noson}&year=${year}`,
        ),
      );
      if (!response.ok || !response.nos) {
        this.info.set(`لا يوجد قيد برقم مسلسل ${noson} لعام ${year}`);
        return;
      }
      await this.openRow(response.nos);
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
  }

  asStr(v: unknown): string {
    return String(v ?? '');
  }

  asNum(v: unknown): number {
    return Number(v) || 0;
  }
}

