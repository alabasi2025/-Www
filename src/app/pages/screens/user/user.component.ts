import {
  Component, OnInit, signal, computed, inject, ChangeDetectionStrategy, HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';

/** Row returned by the users list endpoint (password never included). */
export interface UserListRow {
  NOU: number;
  NAMEU: string | null;
  STATU: number;
  SARSHALL: number;
  TKLF: number | null;
  SART: number | null;
  TAB: number | null;
  NOAH: number | null;
  USX: number;
  MRT: number | null;
  MRTALL: number;
  KSHR: number;
}

export interface UserRow extends UserListRow {
  ED: number; DE: number; SY: number; PR: number; QS: number;
}

interface UserForm {
  NOU: number | null;
  NAMEU: string;
  PASS: string;
  STATU: number;
  SARSHALL: number;
  TKLF: number | null;
  SART: number | null;
  TAB: number | null;
  NOAH: number | null;
  MRT: number | null;
  MRTALL: number;
  USX: number;
  KSHR: number;
  ED: number; DE: number; SY: number; PR: number; QS: number;
}

const EMPTY_FORM: UserForm = {
  NOU: null, NAMEU: '', PASS: '',
  STATU: 0, SARSHALL: 0, TKLF: null, SART: null, TAB: null,
  NOAH: null, MRT: null, MRTALL: 0, USX: 0, KSHR: 0,
  ED: 0, DE: 0, SY: 0, PR: 0, QS: 0,
};

type LegacyTab = 'users' | 'funds' | 'costs' | 'other';

/** USER - بيانات المستخدمين. */
@Component({
  selector: 'app-user-mgmt',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  templateUrl: './user.component.html',
  styleUrl: './user.component.scss',
})
export class UserComponent implements OnInit {
  private http = inject(HttpClient);
  private permSvc = inject(PermissionService);

  readonly screenCode = 'USER.FMX';

  private readonly perms = computed(() => this.permSvc.forScreen(this.screenCode)());
  readonly canIns = computed(() => (this.perms()?.ins ?? 0) > 0);
  readonly canEd  = computed(() => (this.perms()?.ed  ?? 0) > 0);
  readonly canDe  = computed(() => (this.perms()?.de  ?? 0) > 0);
  readonly canPr  = computed(() => (this.perms()?.pr  ?? 0) > 0);
  readonly canSar = computed(() => (this.perms()?.sar ?? 0) > 0);

  readonly rows     = signal<UserListRow[]>([]);
  readonly form     = signal<UserForm>({ ...EMPTY_FORM });
  readonly selected = signal<number | null>(null);
  readonly mode     = signal<'browse' | 'new' | 'edit'>('browse');
  readonly loading  = signal(false);
  readonly saving   = signal(false);
  readonly err      = signal<string | null>(null);
  readonly info     = signal<string | null>(null);
  readonly search   = signal('');
  readonly activeTab = signal<LegacyTab>('users');

  readonly blankRows = Array.from({ length: 5 });

  readonly editable   = computed(() => this.mode() !== 'browse');
  readonly hasCurrent = computed(() => this.selected() !== null);

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) return this.rows();
    return this.rows().filter(r =>
      String(r.NOU).includes(q) ||
      (r.NAMEU ?? '').toLowerCase().includes(q)
    );
  });

  readonly visualSelected = computed(() => {
    if (this.mode() === 'new') return null;
    return this.selected() ?? this.filtered()[0]?.NOU ?? null;
  });

  clearMessages(): void { this.err.set(null); this.info.set(null); }

  @HostListener('document:keydown', ['$event'])
  handleLegacyKeys(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;

    switch (event.key) {
      case 'F2':
        if (this.canIns() && !this.editable() && !this.saving() && !this.loading()) {
          event.preventDefault();
          this.onNew();
        }
        break;
      case 'F10':
        if (this.editable() && !this.saving()) {
          event.preventDefault();
          void this.onSave();
        } else if (this.canIns() && !this.editable() && !this.saving() && !this.loading()) {
          event.preventDefault();
          this.onNew();
        }
        break;
      case 'F7':
        if (this.editable() && !this.saving()) {
          event.preventDefault();
          this.onCancel();
        }
        break;
      case 'F8':
        if (this.canEd() && this.hasCurrent() && !this.editable() && !this.saving()) {
          event.preventDefault();
          this.onEdit();
        }
        break;
      case 'F6':
        if (this.canDe() && this.hasCurrent() && !this.editable() && !this.saving()) {
          event.preventDefault();
          void this.onDelete();
        }
        break;
      case 'Escape':
        event.preventDefault();
        if (this.editable() && !this.saving()) this.onCancel();
        else this.clearMessages();
        break;
      default:
        break;
    }
  }

  updateField<K extends keyof UserForm>(k: K, v: UserForm[K]): void {
    this.form.update(f => ({ ...f, [k]: v }));
  }

  async ngOnInit(): Promise<void> { await this.fetchList(); }

  async fetchList(): Promise<void> {
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: UserListRow[]; error?: string }>('/api/users'),
      );
      if (!r.ok) throw new Error(r.error);
      this.rows.set(r.rows ?? []);
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.loading.set(false);
  }

  selectRow(row: UserListRow): void {
    if (this.editable() || this.saving()) return;
    void this.openRow(row.NOU);
  }

  async openRow(nou: number): Promise<void> {
    this.clearMessages();
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; record: UserRow; error?: string }>(`/api/users/${nou}`),
      );
      if (!r.ok) throw new Error(r.error);
      this.selected.set(nou);
      this.form.set({
        NOU: r.record.NOU, NAMEU: r.record.NAMEU ?? '',
        PASS: '',
        STATU: Number(r.record.STATU ?? 0),
        SARSHALL: Number(r.record.SARSHALL ?? 0),
        TKLF: r.record.TKLF, SART: r.record.SART, TAB: r.record.TAB,
        NOAH: r.record.NOAH, MRT: r.record.MRT,
        MRTALL: Number(r.record.MRTALL ?? 0),
        USX: Number(r.record.USX ?? 0),
        KSHR: Number(r.record.KSHR ?? 0),
        ED: Number(r.record.ED ?? 0), DE: Number(r.record.DE ?? 0),
        SY: Number(r.record.SY ?? 0), PR: Number(r.record.PR ?? 0),
        QS: Number(r.record.QS ?? 0),
      });
      this.mode.set('browse');
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.loading.set(false);
  }

  onNew(): void {
    this.clearMessages();
    this.selected.set(null);
    this.form.set({ ...EMPTY_FORM });
    this.activeTab.set('users');
    this.mode.set('new');
  }

  onEdit(): void {
    if (this.selected() === null) return;
    this.clearMessages();
    this.activeTab.set('users');
    this.mode.set('edit');
  }

  onCancel(): void {
    this.clearMessages();
    if (this.selected() !== null) void this.openRow(this.selected()!);
    else { this.form.set({ ...EMPTY_FORM }); this.mode.set('browse'); }
  }

  displayPassword(row: UserListRow): string {
    if (row.NOU === this.selected()) {
      const typed = this.form().PASS.trim();
      if (typed) return '*'.repeat(Math.min(Math.max(typed.length, 3), 12));
    }
    return row.NOU === this.visualSelected() ? '***' : '**********';
  }

  validate(): boolean {
    const f = this.form();
    if (!f.NOU || f.NOU <= 0 || f.NOU > 99) {
      this.err.set('رقم المستخدم مطلوب (بين 1 و 99)');
      return false;
    }
    if (!f.NAMEU.trim()) { this.err.set('اسم المستخدم مطلوب'); return false; }
    if (this.mode() === 'new' && !f.PASS.trim()) {
      this.err.set('كلمة المرور مطلوبة'); return false;
    }
    return true;
  }

  async onSave(): Promise<void> {
    if (!this.validate()) return;
    this.saving.set(true); this.clearMessages();
    const f = this.form();
    try {
      const isNew = this.mode() === 'new';
      const url = isNew ? '/api/users' : `/api/users/${f.NOU}`;
      const method = isNew ? 'POST' : 'PUT';
      const { PASS, ...rest } = f;
      const payload: Record<string, unknown> = { ...rest };
      if (isNew || PASS.trim()) payload['PASS'] = PASS;
      const r = await firstValueFrom(
        this.http.request<{ ok: boolean; message?: string; error?: string }>(
          method, url, { body: payload },
        ),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحفظ');
      this.mode.set('browse');
      await this.fetchList();
      await this.openRow(f.NOU!);
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  async onDelete(): Promise<void> {
    const nou = this.selected();
    if (nou === null) return;
    if (!confirm(`هل أنت متأكد من حذف المستخدم رقم ${nou}؟`)) return;
    this.saving.set(true); this.clearMessages();
    try {
      const r = await firstValueFrom(
        this.http.delete<{ ok: boolean; message?: string; error?: string }>(`/api/users/${nou}`),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحذف');
      this.selected.set(null);
      this.form.set({ ...EMPTY_FORM });
      this.mode.set('browse');
      await this.fetchList();
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  trackByNou = (_: number, r: UserListRow) => r.NOU;
}