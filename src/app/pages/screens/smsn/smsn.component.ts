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

type Mode = 'browse' | 'edit';
type SmsnKind = 'customers' | 'other';

interface SmsnRow {
  NOA: number;
  NAMEA: string | null;
  TYPEA: number | null;
  NOTLL: number | string | null;
  TEL: number | string | null;
  TEL2: number | string | null;
  SMS: number | null;
  NOTDLL: number | null;
  T_SMS: number | null;
}

@Component({
  selector: 'app-smsn',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, LegacyToolbarComponent, LegacyStatusBarComponent],
  templateUrl: './smsn.component.html',
  styleUrl: './smsn.component.scss',
})
export class SmsnComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly permSvc = inject(PermissionService);
  private readonly perms = this.permSvc.forScreen('SMSN.FMX');

  readonly rows = signal<SmsnRow[]>([]);
  readonly current = signal<SmsnRow | null>(null);
  readonly original = signal<SmsnRow | null>(null);
  readonly mode = signal<Mode>('browse');
  readonly kind = signal<SmsnKind>('customers');
  readonly search = signal('');
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);
  readonly showWhatsApp = signal(false);

  readonly editable = computed(() => this.mode() === 'edit');
  readonly hasCurrent = computed(() => !!this.current()?.NOA);
  readonly currentIdx = computed(() => {
    const noa = this.current()?.NOA;
    if (!noa) return -1;
    return this.rows().findIndex(row => row.NOA === noa);
  });
  readonly toolbarPermissions = computed<LegacyPermissionModel>(() => {
    const p = this.perms();
    const editGate = Math.max(p.ed ?? 0, p.pr ?? 0);
    return { ...p, ed: editGate };
  });
  readonly statusBadges = computed<LegacyStatusBadge[]>(() => [
    { label: `عدد: ${this.rows().length}`, icon: 'pi-list', variant: 'info' },
    { label: this.kind() === 'customers' ? 'حسابات العملاء' : 'حسابات أخرى', icon: 'pi-filter', variant: 'info' },
    this.current()?.NOA
      ? { label: `حساب: ${this.current()?.NOA}`, icon: 'pi-id-card', variant: 'success' }
      : { label: 'لا يوجد سجل محدد', icon: 'pi-info-circle', variant: 'warning' },
  ]);

  async ngOnInit(): Promise<void> {
    await this.fetchRows();
  }

  async fetchRows(): Promise<void> {
    this.loading.set(true);
    this.err.set(null);
    try {
      const params = new URLSearchParams({
        kind: this.kind(),
        limit: '700',
      });
      const q = this.search().trim();
      if (q) params.set('q', q);
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: SmsnRow[]; showWhatsApp?: boolean; error?: string }>(`/api/sms-numbers?${params}`),
      );
      if (!r.ok) throw new Error(r.error);
      this.rows.set(r.rows ?? []);
      this.showWhatsApp.set(!!r.showWhatsApp);
      const active = this.current()?.NOA;
      const next = active ? this.rows().find(row => row.NOA === active) : this.rows()[0];
      this.setCurrent(next ?? null);
      if (!this.rows().length) this.info.set('لا توجد حسابات مطابقة');
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  selectRow(row: SmsnRow): void {
    if (this.editable()) return;
    this.setCurrent(row);
    this.clearMessages();
  }

  onEdit(): void {
    if (!this.current()) return;
    this.original.set({ ...this.current()! });
    this.mode.set('edit');
    this.info.set('وضع تعديل أرقام الرسائل');
    this.err.set(null);
  }

  onCancel(): void {
    const old = this.original();
    if (old) this.setCurrent(old);
    this.mode.set('browse');
    this.original.set(null);
    this.clearMessages();
  }

  async onSave(): Promise<void> {
    const row = this.current();
    if (!row?.NOA) return;
    const localErr = this.validateRow(row);
    if (localErr) {
      this.err.set(localErr);
      return;
    }
    this.saving.set(true);
    this.err.set(null);
    try {
      const r = await firstValueFrom(
        this.http.put<{ ok: boolean; message?: string; error?: string }>(`/api/sms-numbers/${row.NOA}`, row),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحفظ');
      this.mode.set('browse');
      this.original.set(null);
      await this.fetchRows();
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.saving.set(false);
    }
  }

  onToolbarAction(action: LegacyToolbarActionId): void {
    switch (action) {
      case 'edit': this.onEdit(); break;
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
      allowWhenInput: { search: true, save: true, cancel: true },
    });
    if (!shortcut || this.saving() || this.loading()) return;

    switch (shortcut) {
      case 'search':
      case 'refresh':
        event.preventDefault();
        if (!this.editable()) void this.fetchRows();
        break;
      case 'edit':
        event.preventDefault();
        if (this.hasCurrent() && !this.editable()) this.onEdit();
        break;
      case 'save':
        event.preventDefault();
        if (this.editable()) void this.onSave();
        break;
      case 'cancel':
        event.preventDefault();
        if (this.editable()) this.onCancel();
        break;
      case 'exit':
        event.preventDefault();
        if (this.editable()) this.onCancel();
        else this.clearMessages();
        break;
      default:
        break;
    }
  }

  patch(patch: Partial<SmsnRow>): void {
    if (!this.editable()) return;
    this.current.update(row => row ? ({ ...row, ...patch }) : row);
  }

  navTo(target: 'first' | 'last' | number): void {
    if (this.editable()) return;
    const list = this.rows();
    if (!list.length) return;
    const idx = this.currentIdx();
    const next = target === 'first' ? 0
      : target === 'last' ? list.length - 1
        : Math.min(list.length - 1, Math.max(0, idx + target));
    this.setCurrent(list[next] ?? null);
  }

  switchKind(kind: SmsnKind): void {
    if (this.editable()) return;
    this.kind.set(kind);
    this.current.set(null);
    this.original.set(null);
    void this.fetchRows();
  }

  clearMessages(): void {
    this.err.set(null);
    this.info.set(null);
  }

  phoneText(value: unknown): string {
    return value == null ? '' : String(value);
  }

  boolValue(value: unknown): boolean {
    return Number(value ?? 0) > 0;
  }

  private setCurrent(row: SmsnRow | null): void {
    this.current.set(row ? { ...row } : null);
  }

  private validateRow(row: SmsnRow): string | null {
    for (const [label, value] of [
      ['رقم الهاتف 1', row.NOTLL],
      ['رقم الهاتف 2', row.TEL2],
      ['رقم التلفون', row.TEL],
    ] as const) {
      const digits = String(value ?? '').replace(/\D/g, '');
      if (!digits) continue;
      if (digits.length !== 9) return `${label} يجب أن يكون 9 أرقام`;
      if (!/^(77|71|73|70|78)/.test(digits)) return `${label} يجب أن يبدأ بـ 77 أو 71 أو 73 أو 70 أو 78`;
    }
    return null;
  }
}
