import {
  Component, OnInit, signal, computed, inject, ChangeDetectionStrategy, HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';

/** Cost-centre row (MRT table). */
export interface MrtRow {
  NOS:   number;
  NAMEM: string | null;
  DF:    number;
}

interface MrtForm {
  NOS:   number | null;
  NAMEM: string;
  DF:    number;
}

const EMPTY_FORM: MrtForm = { NOS: null, NAMEM: '', DF: 0 };

/**
 * MRT — انشاء مراكز التكلفة
 * Minimal master-data screen backed by the MRT table (3 columns).
 */
@Component({
  selector: 'app-mrt',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  templateUrl: './mrt.component.html',
  styleUrl: './mrt.component.scss',
})
export class MrtComponent implements OnInit {
  private http = inject(HttpClient);
  private permSvc = inject(PermissionService);
  private router = inject(Router);

  readonly screenCode = 'MRT.FMX';

  private readonly perms = computed(() => this.permSvc.forScreen(this.screenCode)());
  readonly canIns = computed(() => (this.perms()?.ins ?? 0) > 0);
  readonly canEd  = computed(() => (this.perms()?.ed  ?? 0) > 0);
  readonly canDe  = computed(() => (this.perms()?.de  ?? 0) > 0);
  readonly canPr  = computed(() => (this.perms()?.pr  ?? 0) > 0);
  readonly canSar = computed(() => (this.perms()?.sar ?? 0) > 0);

  readonly rows     = signal<MrtRow[]>([]);
  readonly form     = signal<MrtForm>({ ...EMPTY_FORM });
  readonly selected = signal<number | null>(null);
  readonly mode     = signal<'browse' | 'new' | 'edit'>('browse');
  readonly loading  = signal(false);
  readonly saving   = signal(false);
  readonly err      = signal<string | null>(null);
  readonly info     = signal<string | null>(null);
  readonly search   = signal('');

  readonly editable = computed(() => this.mode() !== 'browse');
  readonly hasCurrent = computed(() => this.selected() !== null);

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) return this.rows();
    return this.rows().filter(r =>
      String(r.NOS).includes(q) ||
      (r.NAMEM ?? '').toLowerCase().includes(q)
    );
  });


  clearMessages(): void { this.err.set(null); this.info.set(null); }

  updateField<K extends keyof MrtForm>(key: K, value: MrtForm[K]): void {
    this.form.update(f => ({ ...f, [key]: value }));
  }

  onDefaultChange(checked: boolean): void {
    this.clearMessages();
    if (!checked) {
      this.updateField('DF', 0);
      return;
    }

    const currentNo = Number(this.form().NOS ?? 0);
    const existingDefault = this.rows().find(row =>
      Number(row.DF ?? 0) > 0 && Number(row.NOS ?? 0) !== currentNo,
    );
    if (existingDefault) {
      this.updateField('DF', 0);
      this.err.set(`تم تحديد المركز رقم ${existingDefault.NOS} لا يمكن تحديد مركزين`);
      return;
    }

    this.updateField('DF', 1);
  }

  async ngOnInit(): Promise<void> { await this.fetchList(); }

  async fetchList(): Promise<void> {
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: MrtRow[]; error?: string }>('/api/cost-centres'),
      );
      if (!r.ok) throw new Error(r.error);
      this.rows.set(r.rows ?? []);
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.loading.set(false);
  }

  async openRow(nos: number): Promise<void> {
    this.clearMessages();
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; record: MrtRow; error?: string }>(`/api/cost-centres/${nos}`),
      );
      if (!r.ok) throw new Error(r.error);
      this.selected.set(nos);
      this.form.set({
        NOS: r.record.NOS,
        NAMEM: r.record.NAMEM ?? '',
        DF: Number(r.record.DF ?? 0),
      });
      this.mode.set('browse');
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.loading.set(false);
  }

  onNew(): void {
    this.clearMessages();
    this.selected.set(null);
    this.form.set({ ...EMPTY_FORM, NOS: this.nextNos() });
    this.mode.set('new');
  }

  onEdit(): void {
    if (this.selected() === null) return;
    this.clearMessages();
    this.mode.set('edit');
  }

  onCancel(): void {
    this.clearMessages();
    if (this.selected() !== null) void this.openRow(this.selected()!);
    else { this.form.set({ ...EMPTY_FORM }); this.mode.set('browse'); }
  }

  onExit(): void {
    void this.router.navigateByUrl('/app');
  }

  private nextNos(): number {
    const max = this.rows().reduce((acc, row) => Math.max(acc, Number(row.NOS ?? 0)), 0);
    return max + 1 || 1;
  }

  validate(): boolean {
    const f = {
      ...this.form(),
      NAMEM: this.form().NAMEM.trim(),
    };
    if (!f.NOS || f.NOS <= 0) { this.err.set('رقم المركز مطلوب'); return false; }
    if (!f.NAMEM.trim())      { this.err.set('اسم المركز مطلوب'); return false; }
    const existingDefault = this.rows().find(row =>
      Number(row.DF ?? 0) > 0 && Number(row.NOS ?? 0) !== Number(f.NOS ?? 0),
    );
    if (f.DF === 1 && existingDefault) {
      this.err.set(`تم تحديد المركز رقم ${existingDefault.NOS} لا يمكن تحديد مركزين`);
      return false;
    }
    return true;
  }

  async onSave(): Promise<void> {
    if (!this.validate()) return;
    this.saving.set(true); this.clearMessages();
    const f = { ...this.form(), NAMEM: this.form().NAMEM.trim() };
    try {
      const isNew = this.mode() === 'new';
      const url = isNew ? '/api/cost-centres' : `/api/cost-centres/${f.NOS}`;
      const method = isNew ? 'POST' : 'PUT';
      const r = await firstValueFrom(
        this.http.request<{ ok: boolean; message?: string; error?: string; nos?: number }>(
          method, url, { body: f },
        ),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحفظ');
      this.mode.set('browse');
      await this.fetchList();
      await this.openRow(f.NOS!);
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  async onDelete(): Promise<void> {
    const nos = this.selected();
    if (nos === null) return;
    const name = this.form().NAMEM || `رقم ${nos}`;
    if (!confirm(`هل انت متأكد من حذف  المركز :    ${name}`)) return;
    this.saving.set(true); this.clearMessages();
    try {
      const r = await firstValueFrom(
        this.http.delete<{ ok: boolean; message?: string; error?: string }>(`/api/cost-centres/${nos}`),
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

  trackByNos = (_: number, r: MrtRow) => r.NOS;

  @HostListener('document:keydown', ['$event'])
  handleLegacyKeys(event: KeyboardEvent): void {
    if (event.key === 'F2' && this.canIns() && !this.editable() && !this.saving()) {
      event.preventDefault();
      this.onNew();
    } else if (event.key === 'F8' && this.canEd() && this.hasCurrent() && !this.editable() && !this.saving()) {
      event.preventDefault();
      this.onEdit();
    } else if (event.key === 'F10' && this.editable() && !this.saving()) {
      event.preventDefault();
      void this.onSave();
    } else if (event.key === 'F7' && this.editable()) {
      event.preventDefault();
      this.onCancel();
    } else if (event.key === 'F6' && this.canDe() && this.hasCurrent() && !this.editable() && !this.saving()) {
      event.preventDefault();
      void this.onDelete();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (this.editable()) this.onCancel();
      else this.onExit();
    }
  }
}
