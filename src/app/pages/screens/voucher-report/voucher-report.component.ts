import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule, DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LegacyWindowComponent } from '../../../shared/legacy-ui';
import { LEGACY_SCREEN_TITLES } from '../../../shared/legacy-ui/registry/legacy-system.registry';

interface VoucherReportRow {
  NOS: number;
  NOSON: number | null;
  NOMS: number | null;
  DATES: string;
  NOA: number | null;
  NAMEA: string | null;
  NOSN: number | null;
  CASHBOX_NAME: string | null;
  TOTALS: number | null;
  TOTALS2: number | null;
  MRHL: number;
  NOK: number | null;
  MEMOS: string | null;
  NAMEB: string | null;
  NOHANDSHK: number | null;
  LINE_COUNT: number | null;
}

@Component({
  selector: 'app-voucher-report',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, DatePipe, DecimalPipe, LegacyWindowComponent],
  templateUrl: './voucher-report.component.html',
  styleUrl: './voucher-report.component.scss',
})
export class VoucherReportComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly reportCode = signal<'REPSK' | 'REPSS'>('REPSK');
  readonly voucherType = signal<'sndk' | 'snds'>('sndk');
  readonly targetScreen = signal<'SNDK' | 'SNDS'>('SNDK');
  readonly title = signal(LEGACY_SCREEN_TITLES['REPSK'] ?? 'تقارير سندات القبض');

  readonly dateFrom = signal('');
  readonly dateTo = signal('');
  readonly memo = signal('');
  readonly posted = signal<'' | '1' | '0'>('');
  readonly minAmount = signal('');
  readonly maxAmount = signal('');

  readonly rows = signal<VoucherReportRow[]>([]);
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);

  ngOnInit(): void {
    this.route.params.subscribe((params) => {
      const namee = String(params['namee'] || 'REPSK').toUpperCase();
      void this.configureRoute(namee);
    });
  }

  private async configureRoute(namee: string): Promise<void> {
    this.reportCode.set('REPSK');
    this.voucherType.set('sndk');
    this.targetScreen.set('SNDK');
    this.title.set(LEGACY_SCREEN_TITLES['REPSK'] ?? 'تقارير سندات القبض');
    if (namee === 'REPSS') {
      this.reportCode.set('REPSS');
      this.voucherType.set('snds');
      this.targetScreen.set('SNDS');
      this.title.set(LEGACY_SCREEN_TITLES['REPSS'] ?? 'تقارير سندات الصرف');
    }
    await this.setDefaultYear();
    await this.run();
  }

  async run(): Promise<void> {
    this.loading.set(true);
    this.err.set(null);
    this.info.set(null);
    try {
      const params = new URLSearchParams();
      if (this.dateFrom()) params.set('dateFrom', this.dateFrom());
      if (this.dateTo()) params.set('dateTo', this.dateTo());
      if (this.memo().trim()) params.set('memo', this.memo().trim());
      if (this.posted()) params.set('posted', this.posted());
      if (this.minAmount()) params.set('minAmount', this.minAmount());
      if (this.maxAmount()) params.set('maxAmount', this.maxAmount());
      params.set('limit', '500');

      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: VoucherReportRow[]; count: number; error?: string }>(
          `/api/voucher/${this.voucherType()}/search?${params.toString()}`,
        ),
      );
      if (!r.ok) throw new Error(r.error || 'فشل تحميل التقرير');
      this.rows.set(r.rows ?? []);
      if ((r.count ?? 0) === 0) this.info.set('لا توجد نتائج مطابقة');
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.loading.set(false);
  }

  openVoucher(nos: number): void {
    void this.router.navigate(['/app/screens', this.targetScreen()], { queryParams: { nos } });
  }

  printVoucher(nos: number): void {
    window.open(`/api/voucher/${this.voucherType()}/print?nos=${nos}`, '_blank');
  }

  exportCsv(): void {
    const rows = this.rows();
    if (!rows.length) {
      this.info.set('لا توجد بيانات للتصدير');
      return;
    }
    const headers = ['NOMS', 'DATES', 'NOA', 'NAMEA', 'NOSN', 'CASHBOX_NAME', 'TOTALS', 'MRHL', 'NOK', 'MEMOS'];
    const csv = [
      headers.join(','),
      ...rows.map(row => headers.map(key => this.csvCell((row as unknown as Record<string, unknown>)[key])).join(',')),
    ].join('\r\n');
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.reportCode()}-${this.dateFrom() || 'all'}-${this.dateTo() || 'all'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  totalAmount(): number {
    return this.rows().reduce((sum, row) => sum + (Number(row.TOTALS ?? 0) || 0), 0);
  }

  rowNo(row: VoucherReportRow): number {
    return Number(row.NOMS ?? row.NOSON ?? row.NOS) || 0;
  }

  statusText(row: VoucherReportRow): string {
    return Number(row.MRHL ?? 0) === 0 ? 'مرحل' : 'غير مرحل';
  }

  private async setDefaultYear(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; user?: { year?: string } }>('/api/me'));
      const year = /^\d{4}$/.test(String(r.user?.year ?? '')) ? String(r.user?.year) : String(new Date().getFullYear());
      this.dateFrom.set(`${year}-01-01`);
      this.dateTo.set(`${year}-12-31`);
    } catch {
      const year = String(new Date().getFullYear());
      this.dateFrom.set(`${year}-01-01`);
      this.dateTo.set(`${year}-12-31`);
    }
  }

  private csvCell(value: unknown): string {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
}
