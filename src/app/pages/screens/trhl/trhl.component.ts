import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';
import { LegacyToolbarComponent } from '../../../shared/legacy-ui/legacy-toolbar/legacy-toolbar.component';
import { LegacyStatusBarComponent, type LegacyStatusBadge } from '../../../shared/legacy-ui/legacy-status-bar/legacy-status-bar.component';
import { LegacyPermissionModel, LegacyToolbarActionId } from '../../../shared/legacy-ui/contracts/legacy-contracts';

type PostingStatus = 'unposted' | 'posted';

interface PostingType {
  TYPEMS: number;
  TMC: string | null;
}

interface PostingRow {
  NOALL: string | null;
  NOS: number;
  NOSON: number | null;
  TYPEMS: number | null;
  DATES: string | null;
  MRHL: number | null;
  KDANT: number | null;
  NATB: string | null;
  TMC: string | null;
}

@Component({
  selector: 'app-trhl',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, DatePipe, LegacyToolbarComponent, LegacyStatusBarComponent],
  templateUrl: './trhl.component.html',
  styleUrl: './trhl.component.scss',
})
export class TrhlComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly permSvc = inject(PermissionService);
  private readonly perms = this.permSvc.forScreen('TRHL.FMX');

  readonly rows = signal<PostingRow[]>([]);
  readonly types = signal<PostingType[]>([]);
  readonly current = signal<PostingRow | null>(null);
  readonly status = signal<PostingStatus>('unposted');
  readonly typems = signal<number | null>(null);
  readonly op = signal<'<=' | '=' | '>='>('<=');
  readonly date = signal('');
  readonly noson = signal('');
  readonly search = signal('');
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);

  readonly posted = computed(() => Number(this.current()?.MRHL ?? 1) === 0);
  readonly hasCurrent = computed(() => !!this.current()?.NOS && !!this.current()?.NATB);
  readonly currentIdx = computed(() => {
    const row = this.current();
    if (!row) return -1;
    return this.rows().findIndex(r => r.NOS === row.NOS && r.NATB === row.NATB);
  });
  readonly toolbarPermissions = computed<LegacyPermissionModel>(() => {
    const p = this.perms();
    const gate = p.pr ?? 0;
    return { ...p, post: gate, unpost: gate };
  });
  readonly statusBadges = computed<LegacyStatusBadge[]>(() => [
    { label: `عدد: ${this.rows().length}`, icon: 'pi-list', variant: 'info' },
    { label: this.status() === 'unposted' ? 'الغير مرحلة' : 'المرحلة', icon: 'pi-filter', variant: 'info' },
    this.hasCurrent()
      ? { label: `${this.current()?.TMC || this.current()?.NATB} رقم ${this.current()?.NOSON || this.current()?.NOS}`, icon: 'pi-file', variant: 'success' }
      : { label: 'لا يوجد مستند محدد', icon: 'pi-info-circle', variant: 'warning' },
  ]);

  async ngOnInit(): Promise<void> {
    await Promise.all([this.fetchTypes(), this.fetchRows()]);
  }

  @HostListener('document:keydown', ['$event'])
  handleLegacyKeys(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;

    switch (event.key) {
      case 'F10':
        if (this.canPost()) {
          event.preventDefault();
          void this.applyCurrent(0);
        } else if (this.canUnpost()) {
          event.preventDefault();
          void this.applyCurrent(1);
        }
        break;
      case 'Escape':
        event.preventDefault();
        this.clearMessages();
        break;
      default:
        break;
    }
  }

  async fetchTypes(): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: PostingType[]; error?: string }>('/api/posting-documents/types'),
      );
      if (!r.ok) throw new Error(r.error);
      this.types.set(r.rows ?? []);
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
  }

  async fetchRows(): Promise<void> {
    this.loading.set(true);
    this.err.set(null);
    try {
      const params = new URLSearchParams({
        status: this.status(),
        op: this.op(),
        limit: '500',
      });
      if (this.typems()) params.set('typems', String(this.typems()));
      if (this.date()) params.set('date', this.date());
      if (this.noson().trim()) params.set('noson', this.noson().trim());
      if (this.search().trim()) params.set('q', this.search().trim());
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: PostingRow[]; error?: string }>(`/api/posting-documents?${params}`),
      );
      if (!r.ok) throw new Error(r.error);
      this.rows.set(r.rows ?? []);
      const cur = this.current();
      const next = cur ? this.rows().find(row => row.NOS === cur.NOS && row.NATB === cur.NATB) : this.rows()[0];
      this.current.set(next ? { ...next } : null);
      if (!this.rows().length) this.info.set('لا توجد مستندات مطابقة');
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  selectRow(row: PostingRow): void {
    this.current.set({ ...row });
    this.clearMessages();
  }

  navTo(target: 'first' | 'last' | number): void {
    const list = this.rows();
    if (!list.length) return;
    const idx = this.currentIdx();
    const next = target === 'first' ? 0
      : target === 'last' ? list.length - 1
        : Math.min(list.length - 1, Math.max(0, idx + target));
    this.current.set(list[next] ? { ...list[next] } : null);
  }

  async applyCurrent(targetMrhl: 0 | 1): Promise<void> {
    const row = this.current();
    if (!row?.NOS || !row.NATB) return;
    const action = targetMrhl === 0 ? 'ترحيل' : 'إلغاء ترحيل';
    if (!confirm(`هل تريد ${action} المستند رقم ${row.NOSON || row.NOS}؟`)) return;
    this.saving.set(true);
    this.err.set(null);
    try {
      const r = await firstValueFrom(
        this.http.put<{ ok: boolean; message?: string; error?: string }>(
          `/api/posting-documents/${encodeURIComponent(row.NATB)}/${row.NOS}`,
          { targetMrhl },
        ),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم التحديث');
      await this.fetchRows();
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.saving.set(false);
    }
  }

  async applyAllDisplayed(targetMrhl: 0 | 1): Promise<void> {
    const list = this.rows();
    if (!list.length) return;
    const action = targetMrhl === 0 ? 'ترحيل' : 'إلغاء ترحيل';
    if (!confirm(`سيتم ${action} ${list.length} مستند من القائمة المعروضة. هل أنت متأكد؟`)) return;
    this.saving.set(true);
    this.err.set(null);
    try {
      const r = await firstValueFrom(
        this.http.put<{ ok: boolean; changed?: number; failed?: number; message?: string; error?: string }>(
          '/api/posting-documents/bulk',
          {
            targetMrhl,
            confirm: 'TRHL',
            rows: list.map(row => ({ NOS: row.NOS, NATB: row.NATB })),
          },
        ),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(`${r.message ?? 'تم التحديث'}${r.failed ? `، فشل ${r.failed}` : ''}`);
      await this.fetchRows();
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.saving.set(false);
    }
  }

  onToolbarAction(action: LegacyToolbarActionId): void {
    switch (action) {
      case 'post': void this.applyCurrent(0); break;
      case 'unpost': void this.applyCurrent(1); break;
      case 'refresh':
      case 'search': void this.fetchRows(); break;
      case 'exit': this.onExit(); break;
      default: break;
    }
  }

  clearMessages(): void {
    this.err.set(null);
    this.info.set(null);
  }

  onExit(): void {
    void this.router.navigateByUrl('/app');
  }

  statusText(row: PostingRow | null): string {
    return Number(row?.MRHL ?? 1) === 0 ? 'مرحلة' : 'غير مرحلة';
  }

  canPost(row: PostingRow | null = this.current()): boolean {
    return (this.toolbarPermissions()['post'] ?? 0) > 0 && !!row && Number(row.MRHL ?? 1) !== 0 && !this.saving();
  }

  canUnpost(row: PostingRow | null = this.current()): boolean {
    return (this.toolbarPermissions()['unpost'] ?? 0) > 0 && !!row && Number(row.MRHL ?? 1) === 0 && !this.saving();
  }
}
