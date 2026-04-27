import { CommonModule, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';
import { LegacyToolbarComponent } from '../../../shared/legacy-ui/legacy-toolbar/legacy-toolbar.component';
import { LegacyStatusBarComponent, type LegacyStatusBadge } from '../../../shared/legacy-ui/legacy-status-bar/legacy-status-bar.component';
import { LegacyPermissionModel, LegacyToolbarActionId } from '../../../shared/legacy-ui/contracts/legacy-contracts';
import { resolveLegacyShortcut } from '../../../shared/legacy-ui/behaviors/legacy-keyboard-map';

interface UseinRow {
  NO?: number | null;
  DATEI?: string | null;
  TIEMI?: string | null;
  HL?: number | null;
  PC?: string | null;
  MEMO?: string | null;
  INDX?: number | null;
}

interface UserRow {
  NOU?: number | null;
  NAMEU?: string | null;
}

interface ReportFilters {
  fromDate: string;
  toDate: string;
  userNo: number | null;
}

const SCREEN_CODE = 'INANOU.FMX';
const DATE_DISPLAY = 'yyyy/MM/dd';

@Component({
  selector: 'app-inanou',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, DatePipe, LegacyToolbarComponent, LegacyStatusBarComponent],
  templateUrl: './inanou.component.html',
  styleUrl: './inanou.component.scss',
})
export class InanouComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly permissionService = inject(PermissionService);
  private readonly perms = this.permissionService.forScreen(SCREEN_CODE);

  @ViewChild('userSelect') private userSelect?: ElementRef<HTMLSelectElement>;

  readonly rows = signal<UseinRow[]>([]);
  readonly users = signal<UserRow[]>([]);
  readonly filters = signal<ReportFilters>({
    fromDate: '',
    toDate: this.todayInput(),
    userNo: null,
  });
  readonly minUseinDate = signal<string | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);

  readonly permissionModel = computed<LegacyPermissionModel>(() => {
    const p = this.perms();
    return { ...p, pr: p.pr ?? 1, de: p.de ?? 0 };
  });
  readonly canDelete = computed(() => this.permissionService.isAdmin() || Number(this.perms().de ?? 0) > 0);

  readonly usersByNo = computed(() => {
    const map = new Map<number, string>();
    for (const user of this.users()) {
      const no = Number(user.NOU ?? 0);
      if (no > 0) map.set(no, String(user.NAMEU ?? '').trim() || `مستخدم ${no}`);
    }
    return map;
  });

  readonly filteredRows = computed(() => {
    const filter = this.filters();
    const fromTime = this.inputDateToTime(filter.fromDate, false);
    const toTime = this.inputDateToTime(filter.toDate, true);
    const userNo = Number(filter.userNo ?? 0);

    return this.rows().filter((row) => {
      const rowTime = this.rowDateToTime(row.DATEI);
      const rowUser = Number(row.NO ?? 0);
      if (fromTime !== null && (rowTime === null || rowTime < fromTime)) return false;
      if (toTime !== null && (rowTime === null || rowTime > toTime)) return false;
      if (userNo > 0 && rowUser !== userNo) return false;
      return true;
    });
  });

  readonly dateRangeLabel = computed(() => {
    const filter = this.filters();
    const from = filter.fromDate ? this.formatInputDate(filter.fromDate) : 'أول تاريخ';
    const to = filter.toDate ? this.formatInputDate(filter.toDate) : 'آخر تاريخ';
    return `${from} - ${to}`;
  });

  readonly statusBadges = computed<LegacyStatusBadge[]>(() => [
    { label: `السجلات: ${this.filteredRows().length.toLocaleString()}`, icon: 'pi-list', variant: 'info' },
    { label: `المستخدمون: ${this.users().length.toLocaleString()}`, icon: 'pi-users', variant: 'success' },
    { label: this.dateRangeLabel(), icon: 'pi-calendar', variant: 'warning' },
  ]);

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.err.set(null);
    try {
      const [usein, users] = await Promise.all([
        firstValueFrom(this.http.get<{ ok: boolean; rows: UseinRow[]; error?: string }>('/api/data/USEIN?limit=1000&orderBy=DATEI DESC, INDX DESC')),
        firstValueFrom(this.http.get<{ ok: boolean; rows: UserRow[]; error?: string }>('/api/data/USER_U?limit=1000&orderBy=NOU')),
      ]);
      if (!usein.ok) throw new Error(usein.error || 'تعذر تحميل عمليات الدخول والخروج');
      if (!users.ok) throw new Error(users.error || 'تعذر تحميل المستخدمين');

      this.rows.set(usein.rows ?? []);
      this.users.set((users.rows ?? []).filter((user) => Number(user.NOU ?? 0) > 0));
      this.applyInitialDates(usein.rows ?? []);
      this.info.set('تم تحديث بيانات دخول وخروج المستخدمين');
    } catch (error) {
      this.err.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loading.set(false);
    }
  }

  setFilter<K extends keyof ReportFilters>(key: K, value: ReportFilters[K]): void {
    this.filters.update((current) => ({ ...current, [key]: value }));
    this.clearMessages();
  }

  resetFilters(): void {
    this.filters.set({
      fromDate: this.minUseinDate() ?? '',
      toDate: this.todayInput(),
      userNo: null,
    });
    this.info.set('تمت إعادة معايير التقرير إلى القيم الافتراضية');
  }

  printReport(): void {
    const params = new URLSearchParams({ report: 'TIM' });
    const filter = this.filters();
    if (filter.fromDate) params.set('dr1', this.formatInputDate(filter.fromDate));
    if (filter.toDate) params.set('dr2', this.formatInputDate(filter.toDate));
    if (Number(filter.userNo ?? 0) > 0) {
      const userNo = String(filter.userNo);
      params.set('nox1', userNo);
      params.set('nox2', userNo);
    }

    const url = `/api/legacy-report/INANOU/print?${params.toString()}`;
    const opened = window.open(url, '_blank');
    if (!opened) window.location.href = url;
  }

  async deleteAllOperations(): Promise<void> {
    if (!this.canDelete()) {
      this.err.set('لا توجد صلاحية لحذف جميع عمليات الدخول والخروج');
      return;
    }
    if (!confirm('هل أنت متأكد من حذف جميع العمليات المسجلة؟')) return;
    this.saving.set(true);
    this.err.set(null);
    try {
      const response = await firstValueFrom(this.http.delete<{ ok: boolean; error?: string }>('/api/data/USEIN?where=1=1'));
      if (!response.ok) throw new Error(response.error || 'تعذر حذف العمليات');
      this.rows.set([]);
      this.info.set('تمت عملية الحذف');
    } catch (error) {
      this.err.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.saving.set(false);
    }
  }

  onToolbarAction(action: LegacyToolbarActionId): void {
    if (action === 'refresh' || action === 'search') void this.refresh();
    if (action === 'print') this.printReport();
    if (action === 'delete') void this.deleteAllOperations();
    if (action === 'cancel') this.resetFilters();
    if (action === 'exit') this.clearMessages();
  }

  focusUserFilter(): void {
    this.userSelect?.nativeElement.focus();
    this.info.set('تم الانتقال إلى فلتر اسم المستخدم');
  }

  clearMessages(): void {
    this.err.set(null);
    this.info.set(null);
  }

  userName(no: number | null | undefined): string {
    const userNo = Number(no ?? 0);
    return this.usersByNo().get(userNo) ?? (userNo > 0 ? `مستخدم ${userNo}` : '-');
  }

  rowDate(value: string | null | undefined): Date | null {
    const time = this.rowDateToTime(value);
    return time === null ? null : new Date(time);
  }

  @HostListener('document:keydown', ['$event'])
  handleLegacyKeys(event: KeyboardEvent): void {
    const shortcut = resolveLegacyShortcut(event, {
      allowWhenInput: { print: true, cancel: true, edit: true, save: true, exit: true, refresh: true, search: true },
    });
    if (!shortcut || this.loading() || this.saving()) return;

    switch (shortcut) {
      case 'print':
      case 'save':
        event.preventDefault();
        this.printReport();
        break;
      case 'cancel':
        event.preventDefault();
        this.resetFilters();
        break;
      case 'edit':
        event.preventDefault();
        this.focusUserFilter();
        break;
      case 'refresh':
      case 'search':
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

  private applyInitialDates(rows: UseinRow[]): void {
    const times = rows
      .map((row) => this.rowDateToTime(row.DATEI))
      .filter((time): time is number => time !== null);
    const min = times.length ? this.dateToInput(new Date(Math.min(...times))) : '';
    this.minUseinDate.set(min || null);
    this.filters.update((current) => ({
      ...current,
      fromDate: current.fromDate || min,
      toDate: current.toDate || this.todayInput(),
    }));
  }

  private rowDateToTime(value: string | null | undefined): number | null {
    if (!value) return null;
    const native = Date.parse(value);
    if (!Number.isNaN(native)) return this.startOfDay(native);

    const parts = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!parts) return null;
    return new Date(Number(parts[3]), Number(parts[2]) - 1, Number(parts[1])).getTime();
  }

  private inputDateToTime(value: string, endOfDay: boolean): number | null {
    if (!value) return null;
    const time = Date.parse(value);
    if (Number.isNaN(time)) return null;
    const date = new Date(time);
    if (endOfDay) date.setHours(23, 59, 59, 999);
    else date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  private startOfDay(time: number): number {
    const date = new Date(time);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  private formatInputDate(value: string): string {
    if (!value) return '';
    const date = new Date(`${value}T00:00:00`);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}/${month}/${day}`;
  }

  private dateToInput(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private todayInput(): string {
    return this.dateToInput(new Date());
  }

  readonly dateDisplayFormat = DATE_DISPLAY;
}
