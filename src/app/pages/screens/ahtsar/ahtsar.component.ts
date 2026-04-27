import {
  Component, OnInit, signal, computed, inject, ChangeDetectionStrategy, HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';

/** Row returned by /api/shortcuts. */
export interface ShortcutRow {
  AHT: string;
  BAHT: string | null;
  BAHTB: string | null;
}

interface ShortcutForm {
  AHT: string;   // read-only on edit
  BAHT: string;
  BAHTB: string;
}

const EMPTY_FORM: ShortcutForm = { AHT: '', BAHT: '', BAHTB: '' };

/** AHTSAR — قائمة الاختصارات (text expansions used across voucher/invoice screens). */
@Component({
  selector: 'app-ahtsar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  templateUrl: './ahtsar.component.html',
  styleUrl: './ahtsar.component.scss',
})
export class AhtsarComponent implements OnInit {
  private http = inject(HttpClient);
  private permSvc = inject(PermissionService);
  private router = inject(Router);

  readonly screenCode = 'AHTSAR.FMX';

  private readonly perms = computed(() => this.permSvc.forScreen(this.screenCode)());
  readonly canIns = computed(() => (this.perms()?.ins ?? 0) > 0);
  readonly canEd  = computed(() => (this.perms()?.ed  ?? 0) > 0);
  readonly canDe  = computed(() => (this.perms()?.de  ?? 0) > 0);
  readonly canPr  = computed(() => (this.perms()?.pr  ?? 0) > 0);
  readonly canSar = computed(() => (this.perms()?.sar ?? 0) > 0);

  readonly rows     = signal<ShortcutRow[]>([]);
  readonly form     = signal<ShortcutForm>({ ...EMPTY_FORM });
  readonly selected = signal<string | null>(null);
  readonly mode     = signal<'browse' | 'new' | 'edit'>('browse');
  readonly loading  = signal(false);
  readonly saving   = signal(false);
  readonly err      = signal<string | null>(null);
  readonly info     = signal<string | null>(null);
  readonly search   = signal('');

  readonly editable   = computed(() => this.mode() !== 'browse');
  readonly hasCurrent = computed(() => this.selected() !== null);
  readonly selectedIsSystemShortcut = computed(() => this.selected() === 'ا' || this.form().AHT === 'ا');

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) return this.rows();
    return this.rows().filter(r =>
      r.AHT.toLowerCase().includes(q) ||
      (r.BAHT  ?? '').toLowerCase().includes(q) ||
      (r.BAHTB ?? '').toLowerCase().includes(q)
    );
  });

  clearMessages(): void { this.err.set(null); this.info.set(null); }

  updateField<K extends keyof ShortcutForm>(k: K, v: ShortcutForm[K]): void {
    this.form.update(f => ({ ...f, [k]: v }));
  }

  async ngOnInit(): Promise<void> { await this.fetchList(); }

  async fetchList(): Promise<void> {
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: ShortcutRow[]; error?: string }>('/api/shortcuts'),
      );
      if (!r.ok) throw new Error(r.error);
      this.rows.set(r.rows ?? []);
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.loading.set(false);
  }

  openRow(row: ShortcutRow): void {
    this.clearMessages();
    this.selected.set(row.AHT);
    this.form.set({
      AHT: row.AHT,
      BAHT: row.BAHT ?? '',
      BAHTB: row.BAHTB ?? '',
    });
    this.mode.set('browse');
  }

  onNew(): void {
    this.clearMessages();
    this.selected.set(null);
    this.form.set({ ...EMPTY_FORM });
    this.mode.set('new');
  }

  onEdit(): void {
    if (this.selected() === null) return;
    this.clearMessages();
    if (this.selectedIsSystemShortcut()) {
      this.err.set('لا يمكن تعديل هذا الاختصار اختصار نظام');
      return;
    }
    this.mode.set('edit');
  }

  onCancel(): void {
    this.clearMessages();
    const sel = this.selected();
    if (sel !== null) {
      const row = this.rows().find(r => r.AHT === sel);
      if (row) this.openRow(row);
      else { this.form.set({ ...EMPTY_FORM }); this.mode.set('browse'); }
    } else {
      this.form.set({ ...EMPTY_FORM }); this.mode.set('browse');
    }
  }

  validate(): boolean {
    const f = this.form();
    if (!f.AHT.trim()) { this.err.set('الاختصار مطلوب'); return false; }
    if (!f.BAHT.trim()) { this.err.set('البيان مطلوب'); return false; }
    return true;
  }

  async onSave(): Promise<void> {
    if (!this.validate()) return;
    this.saving.set(true); this.clearMessages();
    const f = {
      ...this.form(),
      AHT: this.form().AHT.trim().slice(0, 30),
      BAHT: this.form().BAHT.trim(),
      BAHTB: this.form().BAHTB.trim(),
    };
    try {
      const isNew = this.mode() === 'new';
      const url = isNew
        ? '/api/shortcuts'
        : `/api/shortcuts/${encodeURIComponent(f.AHT)}`;
      const method = isNew ? 'POST' : 'PUT';
      const r = await firstValueFrom(
        this.http.request<{ ok: boolean; message?: string; error?: string; aht?: string }>(
          method, url, { body: f },
        ),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحفظ');
      this.mode.set('browse');
      await this.fetchList();
      const newAht = isNew ? r.aht ?? f.AHT : f.AHT;
      const row = this.rows().find(x => x.AHT === newAht);
      if (row) this.openRow(row);
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  async onDelete(): Promise<void> {
    const aht = this.selected();
    if (aht === null) return;
    if (aht === 'ا') { this.err.set('لا يمكن تعديل هذا الاختصار اختصار نظام'); return; }
    if (!confirm(`هل أنت متأكد من حذف الاختصار "${aht}"؟`)) return;
    this.saving.set(true); this.clearMessages();
    try {
      const r = await firstValueFrom(
        this.http.delete<{ ok: boolean; message?: string; error?: string }>(
          `/api/shortcuts/${encodeURIComponent(aht)}`,
        ),
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

  onPrint(): void {
    if (typeof window !== 'undefined') {
      window.open('/api/legacy-report/AHTSAR/print?report=REPATH', '_blank');
    }
  }

  onExit(): void {
    void this.router.navigateByUrl('/app');
  }

  @HostListener('document:keydown', ['$event'])
  handleLegacyKeys(event: KeyboardEvent): void {
    if (this.saving() || this.loading()) return;
    if (event.key === 'F2' && this.canIns() && !this.editable()) {
      event.preventDefault();
      this.onNew();
    } else if (event.key === 'F8' && this.canEd() && this.hasCurrent() && !this.editable()) {
      event.preventDefault();
      this.onEdit();
    } else if (event.key === 'F10' && this.editable()) {
      event.preventDefault();
      void this.onSave();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (this.editable()) this.onCancel();
      else this.onExit();
    }
  }

  trackByAht = (_: number, r: ShortcutRow) => r.AHT;
}
