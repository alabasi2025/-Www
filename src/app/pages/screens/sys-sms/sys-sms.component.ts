import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';
import { LegacyToolbarComponent } from '../../../shared/legacy-ui/legacy-toolbar/legacy-toolbar.component';
import { LegacyStatusBarComponent, type LegacyStatusBadge } from '../../../shared/legacy-ui/legacy-status-bar/legacy-status-bar.component';
import { LegacyPermissionModel, LegacyToolbarActionId } from '../../../shared/legacy-ui/contracts/legacy-contracts';
import { resolveLegacyShortcut } from '../../../shared/legacy-ui/behaviors/legacy-keyboard-map';

type StatusFilter = '' | '0' | '1' | '2';
type SourceTable = 'SENDSMS_S' | 'SENDSMS';

interface ApiRows<T> {
  ok: boolean;
  rows?: T[];
  total?: number;
  error?: string;
}

interface SysSmsRow {
  CUSTOMERN?: number | string | null;
  PHONENO?: number | string | null;
  CUSTOMERNAME?: string | null;
  SMS?: string | null;
  MS1?: string | null;
  MS2?: string | null;
  DATESMS?: string | null;
  TIMESMS?: string | null;
  DATE_?: string | null;
  TIME_?: string | null;
  TYPESMS?: number | string | null;
  ST?: number | string | null;
  ISSENT?: number | string | null;
  F?: string | null;
  D?: string | Date | null;
  T_M?: number | string | null;
  T_M2?: number | string | null;
  F_P_H?: string | null;
  NOA?: number | string | null;
  NOAML?: number | string | null;
}

@Component({
  selector: 'app-sys-sms',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, LegacyToolbarComponent, LegacyStatusBarComponent],
  templateUrl: './sys-sms.component.html',
  styleUrl: './sys-sms.component.scss',
})
export class SysSmsComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly perms = inject(PermissionService).forScreen('SYS_SMS.FMX');

  readonly rows = signal<SysSmsRow[]>([]);
  readonly sourceTable = signal<SourceTable>('SENDSMS_S');
  readonly serverTotal = signal(0);
  readonly limit = signal(1000);
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);

  readonly dateFrom = signal('');
  readonly dateTo = signal('');
  readonly status = signal<StatusFilter>('');
  readonly text = signal('');
  readonly sender = signal('');

  readonly permissionModel = computed<LegacyPermissionModel>(() => {
    const p = this.perms();
    return { ...p, pr: p.pr ?? 1 };
  });

  readonly filteredRows = computed(() => {
    const from = this.dateFrom();
    const to = this.dateTo();
    const status = this.status();
    const text = this.normalizeSearch(this.text());
    const sender = this.normalizeSearch(this.sender());

    return this.rows().filter((row) => {
      const rowDate = this.rowDateKey(row);
      if (from && rowDate && rowDate < from) return false;
      if (to && rowDate && rowDate > to) return false;
      if ((from || to) && !rowDate) return false;

      if (status !== '' && String(this.rowStatus(row)) !== status) return false;

      if (text) {
        const haystack = this.normalizeSearch(`${this.rowMessage(row)} ${row.PHONENO ?? ''} ${row.CUSTOMERN ?? ''}`);
        if (!haystack.includes(text)) return false;
      }

      if (sender) {
        const haystack = this.normalizeSearch(`${row.F ?? ''} ${row.CUSTOMERNAME ?? ''} ${row.NOA ?? ''}`);
        if (!haystack.includes(sender)) return false;
      }

      return true;
    });
  });

  readonly statusBadges = computed<LegacyStatusBadge[]>(() => {
    const rows = this.filteredRows();
    const sent = rows.filter(row => this.rowStatus(row) === 1).length;
    const failed = rows.filter(row => this.rowStatus(row) === 2).length;
    const pending = rows.filter(row => this.rowStatus(row) === 0).length;
    return [
      { label: `المعروض: ${rows.length.toLocaleString()}`, icon: 'pi-list', variant: 'info' },
      { label: `غير مرسل: ${pending.toLocaleString()}`, icon: 'pi-clock', variant: 'warning' },
      { label: `مرسل: ${sent.toLocaleString()}`, icon: 'pi-check', variant: 'success' },
      { label: `فشل: ${failed.toLocaleString()}`, icon: 'pi-times-circle', variant: failed ? 'error' : 'info' },
    ];
  });

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.err.set(null);
    this.info.set(null);

    try {
      const archive = await this.fetchRows('SENDSMS_S', 'D DESC');
      if (archive.rows?.length) {
        this.applyRows('SENDSMS_S', archive);
      } else {
        const active = await this.fetchRows('SENDSMS', 'ROWID');
        if (active.ok && (active.rows?.length || !archive.ok)) this.applyRows('SENDSMS', active);
        else this.applyRows('SENDSMS_S', archive);
      }

      this.seedDateFilters();
      if (!this.rows().length) this.info.set('لا توجد رسائل مطابقة في الدفعة المقروءة.');
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  onToolbarAction(action: LegacyToolbarActionId): void {
    switch (action) {
      case 'search':
      case 'refresh':
        void this.refresh();
        break;
      case 'print':
        this.print();
        break;
      case 'cancel':
        this.clearFilters();
        break;
      case 'exit':
        this.clearMessages();
        break;
      default:
        break;
    }
  }

  @HostListener('document:keydown', ['$event'])
  handleLegacyKeys(event: KeyboardEvent): void {
    const shortcut = resolveLegacyShortcut(event, {
      allowWhenInput: { search: true, refresh: true, print: true, cancel: true, exit: true },
    });
    if (!shortcut || this.loading()) return;

    switch (shortcut) {
      case 'print':
        event.preventDefault();
        this.print();
        break;
      case 'cancel':
        event.preventDefault();
        this.clearFilters();
        break;
      case 'search':
      case 'refresh':
      case 'edit':
        event.preventDefault();
        void this.refresh();
        break;
      case 'exit':
        event.preventDefault();
        this.clearMessages();
        break;
      default:
        break;
    }
  }

  clearFilters(): void {
    this.dateFrom.set('');
    this.dateTo.set('');
    this.status.set('');
    this.text.set('');
    this.sender.set('');
    this.info.set('تم تنظيف الفلاتر. اضغط F8 للبحث/التحديث.');
    this.err.set(null);
  }

  setStatus(value: string): void {
    this.status.set(value === '0' || value === '1' || value === '2' ? value : '');
  }

  clearMessages(): void {
    this.err.set(null);
    this.info.set(null);
  }

  print(): void {
    this.info.set('تم تجهيز معاينة الطباعة للنتائج المعروضة.');
    setTimeout(() => window.print(), 0);
  }

  statusLabel(row: SysSmsRow): string {
    const status = this.rowStatus(row);
    if (status === 1) return 'مرسل';
    if (status === 2) return 'فشل الارسال';
    return 'غير مرسل';
  }

  statusClass(row: SysSmsRow): string {
    const status = this.rowStatus(row);
    if (status === 1) return 'sent';
    if (status === 2) return 'failed';
    return 'pending';
  }

  rowMessage(row: SysSmsRow): string {
    return String(row.SMS ?? `${row.MS1 ?? ''} ${row.MS2 ?? ''}`).trim();
  }

  rowDateDisplay(row: SysSmsRow): string {
    return row.DATESMS || row.DATE_ || this.formatDate(row.D) || '';
  }

  rowTimeDisplay(row: SysSmsRow): string {
    return row.TIMESMS || row.TIME_ || '';
  }

  private async fetchRows(table: SourceTable, orderBy: string): Promise<ApiRows<SysSmsRow>> {
    const params = new URLSearchParams({
      limit: String(this.limit()),
      orderBy,
    });
    return firstValueFrom(this.http.get<ApiRows<SysSmsRow>>(`/api/data/${table}?${params.toString()}`));
  }

  private applyRows(table: SourceTable, response: ApiRows<SysSmsRow>): void {
    if (!response.ok) throw new Error(response.error || `تعذر تحميل ${table}`);
    this.sourceTable.set(table);
    this.rows.set(response.rows ?? []);
    this.serverTotal.set(Number(response.total ?? response.rows?.length ?? 0));
  }

  private seedDateFilters(): void {
    if (this.dateFrom() || this.dateTo()) return;
    const dates = this.rows()
      .map(row => this.rowDateKey(row))
      .filter((date): date is string => !!date)
      .sort();
    const latest = dates[dates.length - 1];
    if (!latest) return;
    this.dateFrom.set(latest);
    this.dateTo.set(latest);
  }

  private rowStatus(row: SysSmsRow): number {
    return Number(row.ST ?? row.ISSENT ?? 0) || 0;
  }

  private rowDateKey(row: SysSmsRow): string {
    const direct = this.parseDateKey(row.D);
    if (direct) return direct;
    return this.parseDateKey(row.DATESMS) || this.parseDateKey(row.DATE_) || '';
  }

  private parseDateKey(value: unknown): string {
    if (!value) return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) return this.toDateInput(value);
    const raw = String(value).trim();
    if (!raw) return '';

    const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;

    const legacy = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (legacy) return `${legacy[3]}-${legacy[2].padStart(2, '0')}-${legacy[1].padStart(2, '0')}`;

    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? '' : this.toDateInput(date);
  }

  private formatDate(value: unknown): string {
    const key = this.parseDateKey(value);
    if (!key) return '';
    const [year, month, day] = key.split('-');
    return `${day}/${month}/${year}`;
  }

  private toDateInput(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private normalizeSearch(value: string): string {
    return value.trim().toLocaleLowerCase('ar-SA');
  }
}
