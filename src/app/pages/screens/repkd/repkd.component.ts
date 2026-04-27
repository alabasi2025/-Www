import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule, DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LegacyWindowComponent } from '../../../shared/legacy-ui';
import { LEGACY_SCREEN_TITLES } from '../../../shared/legacy-ui/registry/legacy-system.registry';

interface RepkdRow {
  NOS: number;
  NOSON: number | null;
  DATES: string;
  MEMOS: string | null;
  MEMOSA?: string | null;
  NOK: number | null;
  MRHL: number;
  TOTALS: number | null;
  MDIN?: number | null;
  DAN?: number | null;
}

@Component({
  selector: 'app-repkd',
  standalone: true,
  imports: [CommonModule, FormsModule, DatePipe, DecimalPipe, LegacyWindowComponent],
  templateUrl: './repkd.component.html',
  styleUrl: './repkd.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RepkdComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly screenCode = signal<'REPKD' | 'REPKD2'>('REPKD');
  readonly screenTitle = signal(LEGACY_SCREEN_TITLES['REPKD'] ?? 'تقرير القيود اليومية');
  readonly dateFrom = signal('');
  readonly dateTo = signal('');
  readonly memo = signal('');
  readonly posted = signal<'' | '1' | '0'>('');

  readonly loading = signal(false);
  readonly rows = signal<RepkdRow[]>([]);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);

  ngOnInit(): void {
    this.route.params.subscribe((params) => {
      const namee = String(params['namee'] || 'REPKD').toUpperCase();
      this.configureRoute(namee);
      void this.run();
    });
  }

  private configureRoute(namee: string): void {
    this.screenCode.set(namee === 'REPKD2' ? 'REPKD2' : 'REPKD');
    this.screenTitle.set(LEGACY_SCREEN_TITLES[this.screenCode()] ?? (this.screenCode() === 'REPKD2' ? 'تقرير قيود التحويل' : 'تقرير القيود اليومية'));

    const today = new Date();
    const yyyy = String(today.getFullYear());
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    this.dateFrom.set(`${yyyy}-01-01`);
    this.dateTo.set(`${yyyy}-${mm}-${dd}`);
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

      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: RepkdRow[]; count: number; error?: string }>(
          `${this.apiBase()}/search?${params.toString()}`,
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
    void this.router.navigate(['/app/screens', this.screenCode() === 'REPKD2' ? 'SNDKD2' : 'SNDKD'], { queryParams: { nos } });
  }

  printVoucher(nos: number): void {
    window.open(`${this.apiBase()}/print?nos=${nos}`, '_blank');
  }

  rowMemo(row: RepkdRow): string {
    return row.MEMOS || row.MEMOSA || '';
  }

  rowTotal(row: RepkdRow): number {
    return Number(row.TOTALS ?? row.MDIN ?? row.DAN ?? 0) || 0;
  }

  private apiBase(): string {
    return this.screenCode() === 'REPKD2' ? '/api/journal/sndkd2' : '/api/journal/sndkd';
  }
}
