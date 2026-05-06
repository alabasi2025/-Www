import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule, DatePipe, DecimalPipe } from '@angular/common';
import { HttpClient, httpResource } from '@angular/common/http';
import { FormField, form } from '@angular/forms/signals';
import { firstValueFrom } from 'rxjs';
import type { LovAccount } from '../../../shared/lov-picker/lov-picker.component';

interface StatementFilters {
  noa: string;
  dateFrom: string;
  dateTo: string;
  currency: string;
  mrt: string;
  q: string;
  limit: number;
}

interface StatementAccount {
  NOA?: number;
  NAMEA?: string;
  TYPEA?: number;
  RTBA?: number;
  AMLHH?: number;
  AHSAR?: string | null;
}

interface StatementSummary {
  count: number;
  debit: number;
  credit: number;
  debitAml: number;
  creditAml: number;
  ending: number;
  endingAml: number;
  limited: boolean;
}

interface StatementRow {
  DATEMO: string;
  NOK: number;
  NOMS: number;
  NOMSR: number;
  TYPEMS: number;
  TYPEMS_LABEL: string;
  RECNO: number;
  NOAML: number;
  NOAML_NAME?: string | null;
  SARSF: number;
  MDIN: number;
  DAN: number;
  MDINAML: number;
  DANAML: number;
  DELTA: number;
  DELTAAML: number;
  BALANCE: number;
  BALANCEAML: number;
  MEMOS?: string | null;
  MRT: number;
  MRT_NAME?: string | null;
  MRHL: number;
  KDANT: number;
  RID: string;
}

interface StatementResponse {
  ok: boolean;
  schema?: string;
  account?: StatementAccount;
  opening: number;
  openingAml: number;
  summary: StatementSummary;
  rows: StatementRow[];
  error?: string;
}

interface CurrencyRow {
  NO: number;
  NAMEM?: string;
  NAMEM2?: string;
  NAMEM3?: string;
  NAMEH?: string;
}

interface CurrenciesResponse {
  ok: boolean;
  rows: CurrencyRow[];
}

const EMPTY_STATEMENT: StatementResponse = {
  ok: true,
  opening: 0,
  openingAml: 0,
  summary: {
    count: 0,
    debit: 0,
    credit: 0,
    debitAml: 0,
    creditAml: 0,
    ending: 0,
    endingAml: 0,
    limited: false,
  },
  rows: [],
};

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function cleanCsv(value: unknown): string {
  const text = String(value ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '""');
  return `"${text}"`;
}

@Component({
  selector: 'app-account-statement',
  imports: [CommonModule, DecimalPipe, DatePipe, FormField],
  templateUrl: './account-statement.component.html',
  styleUrl: './account-statement.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountStatementComponent {
  private readonly http = inject(HttpClient);

  readonly filtersModel = signal<StatementFilters>({
    noa: '12130001',
    dateFrom: '2022-01-01',
    dateTo: todayYmd(),
    currency: '',
    mrt: '',
    q: '',
    limit: 3000,
  });
  readonly filters = form(this.filtersModel);
  readonly applied = signal<StatementFilters>(this.filtersModel());
  readonly lovOpen = signal(false);
  readonly accountSearchQuery = signal('');
  readonly accountRows = signal<LovAccount[]>([]);
  readonly accountLookupLoading = signal(false);
  readonly accountLookupError = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  private accountSearchTimer: ReturnType<typeof setTimeout> | null = null;

  readonly statement = httpResource<StatementResponse>(() => {
    const f = this.applied();
    const noa = f.noa.trim();
    if (!noa) return undefined;
    return {
      url: '/api/reports/account-statement',
      params: {
        noa,
        dateFrom: f.dateFrom,
        dateTo: f.dateTo,
        currency: f.currency || '',
        mrt: f.mrt || '',
        q: f.q || '',
        limit: f.limit,
      },
    };
  }, {
    defaultValue: EMPTY_STATEMENT,
    parse: (value) => value as StatementResponse,
    debugName: 'account-statement',
  });

  readonly currencies = httpResource<CurrenciesResponse>(() => '/api/currencies', {
    defaultValue: { ok: true, rows: [] },
    parse: (value) => value as CurrenciesResponse,
    debugName: 'account-statement-currencies',
  });

  readonly data = computed(() => this.statement.value());
  readonly rows = computed(() => this.data().rows ?? []);
  readonly account = computed(() => this.data().account ?? {});
  readonly summary = computed(() => this.data().summary ?? EMPTY_STATEMENT.summary);
  readonly accountTitle = computed(() => {
    const account = this.account();
    const no = account.NOA ?? this.applied().noa;
    const name = account.NAMEA || 'حساب غير محدد';
    return `${no} - ${name}`;
  });
  readonly currencyRows = computed(() => this.currencies.value().rows ?? []);
  readonly hasForeign = computed(() => {
    const s = this.summary();
    return Math.abs(this.data().openingAml ?? 0) > 0.0001
      || Math.abs(s.debitAml ?? 0) > 0.0001
      || Math.abs(s.creditAml ?? 0) > 0.0001
      || this.rows().some((row) => Math.abs(Number(row.MDINAML ?? 0)) > 0.0001 || Math.abs(Number(row.DANAML ?? 0)) > 0.0001);
  });
  readonly resourceError = computed(() => {
    const err = this.statement.error();
    if (!err) return null;
    return err.message || String(err);
  });

  applyFilters(): void {
    const next = this.normalizeFilters(this.filtersModel());
    if (!next.noa) {
      this.notice.set('اختر الحساب أولا');
      return;
    }
    this.notice.set(null);
    this.filtersModel.set(next);
    this.applied.set(next);
  }

  refresh(): void {
    this.notice.set(null);
    this.statement.reload();
    this.currencies.reload();
  }

  openAccounts(): void {
    this.lovOpen.set(true);
    this.accountSearchQuery.set('');
    void this.fetchAccounts('');
  }

  closeAccounts(): void {
    this.lovOpen.set(false);
    this.accountLookupError.set(null);
    if (this.accountSearchTimer) {
      clearTimeout(this.accountSearchTimer);
      this.accountSearchTimer = null;
    }
  }

  pickAccount(account: LovAccount): void {
    this.filtersModel.update((f) => ({ ...f, noa: String(account.NOA) }));
    this.lovOpen.set(false);
    this.applyFilters();
  }

  searchAccounts(query: string): void {
    this.accountSearchQuery.set(query);
    if (this.accountSearchTimer) clearTimeout(this.accountSearchTimer);
    this.accountSearchTimer = setTimeout(() => void this.fetchAccounts(query), 180);
  }

  async fetchAccounts(query: string): Promise<void> {
    this.accountLookupLoading.set(true);
    this.accountLookupError.set(null);
    try {
      const q = query.trim() || '%';
      const url = `/api/lov/accounts?q=${encodeURIComponent(q)}&rtba=5&limit=80`;
      const response = await firstValueFrom(
        this.http.get<{ ok: boolean; items?: LovAccount[]; error?: string }>(url),
      );
      if (!response.ok) {
        this.accountRows.set([]);
        this.accountLookupError.set(response.error || 'تعذر تحميل الحسابات');
      } else {
        this.accountRows.set(response.items ?? []);
      }
    } catch (error) {
      this.accountRows.set([]);
      this.accountLookupError.set(error instanceof Error ? error.message : 'تعذر تحميل الحسابات');
    } finally {
      this.accountLookupLoading.set(false);
    }
  }

  setRange2022(): void {
    this.filtersModel.update((f) => ({ ...f, dateFrom: '2022-01-01', dateTo: todayYmd() }));
    this.applyFilters();
  }

  clearSearch(): void {
    this.filtersModel.update((f) => ({ ...f, q: '' }));
    this.applyFilters();
  }

  printReport(): void {
    if (typeof window === 'undefined') return;
    window.print();
  }

  exportCsv(): void {
    if (typeof document === 'undefined') return;
    const rows = this.rows();
    if (!rows.length) {
      this.notice.set('لا توجد حركة لتصديرها');
      return;
    }
    const header = [
      'التاريخ',
      'النوع',
      'رقم المستند',
      'رقم القيد',
      'البيان',
      'مدين',
      'دائن',
      'الرصيد',
      'العملة',
      'مدين عملة',
      'دائن عملة',
      'رصيد عملة',
      'مركز التكلفة',
    ];
    const lines = [
      header.map(cleanCsv).join(','),
      ...rows.map((row) => [
        row.DATEMO,
        row.TYPEMS_LABEL,
        row.NOMS,
        row.NOK,
        row.MEMOS,
        row.MDIN,
        row.DAN,
        row.BALANCE,
        row.NOAML_NAME || row.NOAML,
        row.MDINAML,
        row.DANAML,
        row.BALANCEAML,
        row.MRT_NAME || row.MRT || '',
      ].map(cleanCsv).join(',')),
    ];
    const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `account-statement-${this.applied().noa}-${this.applied().dateFrom || 'all'}-${this.applied().dateTo || 'all'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  balanceClass(value: unknown): string {
    const n = Number(value ?? 0);
    if (n > 0) return 'is-debit';
    if (n < 0) return 'is-credit';
    return 'is-zero';
  }

  trackRow(index: number, row: StatementRow): string {
    return row.RID || `${row.NOMS}-${row.RECNO}-${index}`;
  }

  private normalizeFilters(filters: StatementFilters): StatementFilters {
    return {
      noa: String(filters.noa ?? '').trim(),
      dateFrom: String(filters.dateFrom ?? '').trim(),
      dateTo: String(filters.dateTo ?? '').trim(),
      currency: String(filters.currency ?? '').trim(),
      mrt: String(filters.mrt ?? '').trim(),
      q: String(filters.q ?? '').trim(),
      limit: Math.min(Math.max(Number(filters.limit || 3000), 1), 10000),
    };
  }
}
