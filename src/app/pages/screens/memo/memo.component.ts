import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LegacyToolbarComponent } from '../../../shared/legacy-ui/legacy-toolbar/legacy-toolbar.component';
import { LegacyStatusBarComponent, type LegacyStatusBadge } from '../../../shared/legacy-ui/legacy-status-bar/legacy-status-bar.component';
import { LegacyToolbarActionId } from '../../../shared/legacy-ui/contracts/legacy-contracts';
import { resolveLegacyShortcut } from '../../../shared/legacy-ui/behaviors/legacy-keyboard-map';

type Mode = 'browse' | 'new' | 'edit';

interface MemoRow {
  RID?: string;
  DATEM?: string | null;
  MEMO?: string | null;
  LOP?: string | null;
  DALOP?: string | null;
  LOPA?: string | null;
  NOU?: number | null;
  NAMEU?: string | null;
}

const DAY_LABELS: Record<string, string> = {
  SAT: 'السبت',
  SUN: 'الأحد',
  MON: 'الإثنين',
  TUE: 'الثلاثاء',
  WED: 'الأربعاء',
  THU: 'الخميس',
  FRI: 'الجمعة',
  MMM: 'آخر الشهر',
  NOT: 'بلا تكرار',
};

@Component({
  selector: 'app-memo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, DatePipe, LegacyToolbarComponent, LegacyStatusBarComponent],
  templateUrl: './memo.component.html',
  styleUrl: './memo.component.scss',
})
export class MemoComponent implements OnInit {
  private readonly http = inject(HttpClient);

  readonly rows = signal<MemoRow[]>([]);
  readonly current = signal<MemoRow>({});
  readonly mode = signal<Mode>('browse');
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);
  readonly filterMode = signal<'today' | 'future' | 'past' | 'all'>('today');
  readonly search = signal('');
  readonly userNou = signal<number | null>(null);

  readonly editable = computed(() => this.mode() === 'new' || this.mode() === 'edit');
  readonly currentIdx = computed(() => {
    const rid = this.current().RID;
    if (!rid) return -1;
    return this.rows().findIndex(row => row.RID === rid);
  });
  readonly statusBadges = computed<LegacyStatusBadge[]>(() => [
    { label: `عدد: ${this.rows().length}`, icon: 'pi-list', variant: 'info' },
    { label: this.filterLabel(), icon: 'pi-filter', variant: 'info' },
    this.current().RID
      ? { label: this.current().NOU ? `مستخدم: ${this.current().NOU}` : 'عام', icon: 'pi-user', variant: 'success' }
      : { label: 'لا يوجد سجل محدد', icon: 'pi-info-circle', variant: 'warning' },
  ]);

  async ngOnInit(): Promise<void> {
    await this.loadCurrentUser();
    await this.fetchRows();
  }

  async fetchRows(): Promise<void> {
    this.loading.set(true);
    this.err.set(null);
    try {
      const params = new URLSearchParams({ mode: this.filterMode(), limit: '500' });
      if (this.search().trim()) params.set('q', this.search().trim());
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: MemoRow[]; error?: string }>(`/api/memos?${params.toString()}`),
      );
      if (!r.ok) throw new Error(r.error);
      this.rows.set(r.rows ?? []);
      if (!this.current().RID && this.rows()[0]) this.current.set(this.rows()[0]);
      if (this.current().RID && !this.rows().some(row => row.RID === this.current().RID)) {
        this.current.set(this.rows()[0] ?? {});
      }
      if (!this.rows().length) this.info.set('لا توجد مذكرات مطابقة');
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  selectRow(row: MemoRow): void {
    if (this.editable()) return;
    this.current.set({ ...row });
    this.err.set(null);
    this.info.set(null);
  }

  onNew(): void {
    const today = new Date().toISOString().slice(0, 10);
    this.current.set({
      DATEM: today,
      DALOP: today,
      LOP: 'NOT',
      LOPA: 'NOT',
      NOU: this.userNou(),
      MEMO: '',
    });
    this.mode.set('new');
    this.err.set(null);
    this.info.set('وضع إضافة مذكرة جديدة');
  }

  onEdit(): void {
    if (!this.current().RID) return;
    this.mode.set('edit');
    this.err.set(null);
    this.info.set('وضع تعديل المذكرة');
  }

  onCancel(): void {
    const rid = this.current().RID;
    this.mode.set('browse');
    if (rid) {
      const original = this.rows().find(row => row.RID === rid);
      if (original) this.current.set(original);
    } else {
      this.current.set(this.rows()[0] ?? {});
    }
    this.err.set(null);
  }

  async onSave(): Promise<void> {
    const row = this.current();
    if (!String(row.MEMO ?? '').trim()) {
      this.err.set('يجب إدخال نص الملاحظة');
      return;
    }
    this.saving.set(true);
    this.err.set(null);
    try {
      const url = '/api/memos';
      const method = this.mode() === 'new' ? 'POST' : 'PUT';
      const r = await firstValueFrom(
        this.http.request<{ ok: boolean; message?: string; error?: string }>(method, url, { body: row }),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحفظ');
      this.mode.set('browse');
      this.current.set({});
      await this.fetchRows();
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.saving.set(false);
    }
  }

  async onDelete(): Promise<void> {
    const rid = this.current().RID;
    if (!rid) return;
    if (!confirm('هل تريد حذف هذه المذكرة؟')) return;
    this.saving.set(true);
    this.err.set(null);
    try {
      const r = await firstValueFrom(
        this.http.delete<{ ok: boolean; message?: string; error?: string }>(`/api/memos?rid=${encodeURIComponent(rid)}`),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحذف');
      this.current.set({});
      await this.fetchRows();
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.saving.set(false);
    }
  }

  onToolbarAction(action: LegacyToolbarActionId): void {
    switch (action) {
      case 'new': this.onNew(); break;
      case 'edit': this.onEdit(); break;
      case 'delete': void this.onDelete(); break;
      case 'save': void this.onSave(); break;
      case 'cancel': this.onCancel(); break;
      case 'refresh':
      case 'search': void this.fetchRows(); break;
      case 'exit': this.onCancel(); break;
      default: break;
    }
  }

  @HostListener('document:keydown', ['$event'])
  handleLegacyKeys(event: KeyboardEvent): void {
    const shortcut = resolveLegacyShortcut(event, {
      allowWhenInput: { props: true, search: true, save: true, cancel: true },
    });
    if (!shortcut || this.saving() || this.loading()) return;

    switch (shortcut) {
      case 'props':
        event.preventDefault();
        if (!this.editable()) this.onNew();
        break;
      case 'search':
      case 'refresh':
        event.preventDefault();
        if (!this.editable()) void this.fetchRows();
        break;
      case 'edit':
        event.preventDefault();
        if (!this.editable() && this.current().RID) this.onEdit();
        break;
      case 'save':
        event.preventDefault();
        if (this.editable()) void this.onSave();
        break;
      case 'cancel':
      case 'exit':
        event.preventDefault();
        if (this.editable()) this.onCancel();
        else this.clearMessages();
        break;
      default:
        break;
    }
  }

  patch(patch: Partial<MemoRow>): void {
    if (!this.editable()) return;
    this.current.update(row => ({ ...row, ...patch }));
  }

  onDateChange(value: string): void {
    this.patch({
      DATEM: value || null,
      DALOP: value || this.current().DALOP || null,
      LOP: value ? 'NOT' : this.current().LOP,
      LOPA: value ? 'NOT' : this.current().LOPA,
    });
  }

  onRepeatChange(value: string): void {
    this.patch({
      LOP: value,
      LOPA: DAY_LABELS[value] ?? value,
      DATEM: value === 'NOT' ? this.current().DATEM ?? null : null,
    });
  }

  navTo(target: 'first' | 'last' | number): void {
    if (this.editable()) return;
    const list = this.rows();
    if (!list.length) return;
    const idx = this.currentIdx();
    const next = target === 'first' ? 0
      : target === 'last' ? list.length - 1
        : Math.min(list.length - 1, Math.max(0, idx + target));
    this.current.set(list[next] ?? {});
  }

  dateInput(value: unknown): string {
    if (!value) return '';
    const d = new Date(String(value));
    return Number.isNaN(d.getTime()) ? String(value).slice(0, 10) : d.toISOString().slice(0, 10);
  }

  repeatLabel(row: MemoRow): string {
    return row.LOPA || DAY_LABELS[String(row.LOP ?? 'NOT')] || '';
  }

  filterLabel(): string {
    switch (this.filterMode()) {
      case 'today': return 'مذكرات اليوم';
      case 'future': return 'القادمة';
      case 'past': return 'السابقة';
      default: return 'عرض الكل';
    }
  }

  clearMessages(): void {
    this.err.set(null);
    this.info.set(null);
  }

  private async loadCurrentUser(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; user?: { nou?: number } }>('/api/me'));
      this.userNou.set(Number(r.user?.nou ?? 0) || null);
    } catch {
      this.userNou.set(null);
    }
  }
}
