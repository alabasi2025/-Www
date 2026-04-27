import {
  Component, OnInit, signal, computed, inject, ChangeDetectionStrategy, HostListener, ViewChild, ElementRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';

/** Warehouse row (DATA_MH table). */
export interface WarehouseRow {
  NOG: number;
  NAMEG: string | null;
  ADR: string | null;
  TEL: string | null;
  NAMEAM: string | null;
  NOA_S: number | null;
  USEM: number | null;
}

interface WarehouseForm {
  NOG: number | null;
  NAMEG: string;
  ADR: string;
  TEL: string;
  NAMEAM: string;
  NOA_S: number | null;
  USEM: number | null;
}

interface UserLovRow {
  NOU: number;
  NAMEU: string;
}

const EMPTY_FORM: WarehouseForm = {
  NOG: null, NAMEG: '', ADR: '', TEL: '', NAMEAM: '', NOA_S: null, USEM: null,
};

/** DATA_MH - شاشة ادخال اسماء المخازن. */
@Component({
  selector: 'app-data-mh',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  templateUrl: './data-mh.component.html',
  styleUrl: './data-mh.component.scss',
})
export class DataMhComponent implements OnInit {
  private http = inject(HttpClient);
  private permSvc = inject(PermissionService);
  private router = inject(Router);

  @ViewChild('legacySearchInput') private legacySearchInput?: ElementRef<HTMLInputElement>;

  readonly screenCode = 'DATA_MH.FMX';
  readonly windowTitle = 'شاشة  ادخال اسماء المخازن';

  private readonly perms = computed(() => this.permSvc.forScreen(this.screenCode)());
  readonly canIns = computed(() => (this.perms()?.ins ?? 0) > 0);
  readonly canEd  = computed(() => (this.perms()?.ed  ?? 0) > 0);
  readonly canDe  = computed(() => (this.perms()?.de  ?? 0) > 0);
  readonly canSar = computed(() => (this.perms()?.sar ?? 0) > 0);

  readonly rows     = signal<WarehouseRow[]>([]);
  readonly users    = signal<UserLovRow[]>([]);
  readonly form     = signal<WarehouseForm>({ ...EMPTY_FORM });
  readonly selected = signal<number | null>(null);
  readonly mode     = signal<'browse' | 'new' | 'edit'>('browse');
  readonly loading  = signal(false);
  readonly saving   = signal(false);
  readonly err      = signal<string | null>(null);
  readonly info     = signal<string | null>(null);
  readonly search   = signal('');

  readonly editable = computed(() => this.mode() !== 'browse');
  readonly hasCurrent = computed(() => this.selected() !== null);
  readonly canDeleteCurrent = computed(() => {
    const nog = Number(this.selected() ?? 0);
    return this.canDe() && this.hasCurrent() && nog > 1 && !this.editable() && !this.saving();
  });

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) return this.rows();
    return this.rows().filter(r =>
      String(r.NOG).includes(q) ||
      (r.NAMEG ?? '').toLowerCase().includes(q) ||
      (r.ADR   ?? '').toLowerCase().includes(q) ||
      String(r.TEL ?? '').includes(q),
    );
  });

  async ngOnInit(): Promise<void> {
    await Promise.all([this.fetchUsers(), this.fetchList()]);
  }

  clearMessages(): void { this.err.set(null); this.info.set(null); }

  updateField<K extends keyof WarehouseForm>(key: K, value: WarehouseForm[K]): void {
    this.form.update(f => ({ ...f, [key]: value }));
  }

  private cleanText(value: unknown): string {
    const text = String(value ?? '').replace(/\u0000/g, '').trimEnd();
    return this.repairLegacyArabic(text);
  }

  private repairLegacyArabic(text: string): string {
    const map: Record<string, string> = {
      '\u0637\u00a7': '\u0627', '\u0637\u00a3': '\u0623', '\u0637\u00a5': '\u0625', '\u0637\u00a2': '\u0622', '\u0637\u00a4': '\u0624', '\u0637\u00a6': '\u0626',
      '\u0637\u00a8': '\u0628', '\u0637\u00a9': '\u0629', '\u0637\u06be': '\u062a', '\u0637\u00ab': '\u062b', '\u0637\u00ac': '\u062c', '\u0637\u00ad': '\u062d',
      '\u0637\u00ae': '\u062e', '\u0637\u00af': '\u062f', '\u0637\u00b0': '\u0630', '\u0637\u00b1': '\u0631', '\u0637\u00b2': '\u0632', '\u0637\u00b3': '\u0633',
      '\u0637\u00b4': '\u0634', '\u0637\u00b5': '\u0635', '\u0637\u00b6': '\u0636', '\u0637\u00b7': '\u0637', '\u0637\u00b8': '\u0638', '\u0637\u00b9': '\u0639',
      '\u0637\u061b': '\u063a', '\u0638\u067e': '\u0641', '\u0638\u201a': '\u0642', '\u0638\u0192': '\u0643', '\u0638\u201e': '\u0644', '\u0638\u2026': '\u0645',
      '\u0638\u2020': '\u0646', '\u0638\u2021': '\u0647', '\u0638\u02c6': '\u0648', '\u0638\u2030': '\u0649', '\u0638\u0679': '\u064a',
    };
    const badKeys = Object.keys(map);
    if (!badKeys.some((bad) => text.includes(bad))) return text;
    let out = text;
    for (const bad of badKeys) out = out.split(bad).join(map[bad] ?? '');
    return out;
  }

  private toDisplayRow(row: WarehouseRow): WarehouseRow {
    return {
      ...row,
      NAMEG: this.cleanText(row.NAMEG),
      ADR: this.cleanText(row.ADR),
      TEL: this.cleanText(row.TEL),
      NAMEAM: this.cleanText(row.NAMEAM),
    };
  }

  private mapUser(row: Record<string, unknown>): UserLovRow {
    return {
      NOU: Number(row['NOU'] ?? row['nou'] ?? 0),
      NAMEU: this.cleanText(row['NAMEU'] ?? row['nameu'] ?? row['name'] ?? ''),
    };
  }

  async fetchUsers(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; rows?: Record<string, unknown>[] }>('/api/users'));
      if (r.ok) this.users.set((r.rows ?? []).map(row => this.mapUser(row)).filter(row => row.NOU > 0));
    } catch { /* the legacy list can stay empty if permissions/session fail */ }
  }

  async fetchList(): Promise<void> {
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: WarehouseRow[]; error?: string }>('/api/warehouses'),
      );
      if (!r.ok) throw new Error(r.error);
      const rows = (r.rows ?? []).map(row => this.toDisplayRow(row));
      this.rows.set(rows);
      if (this.mode() === 'browse' && this.selected() === null && rows.length) {
        await this.openRow(rows[0]!.NOG);
      }
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.loading.set(false);
  }

  async openRow(nog: number): Promise<void> {
    this.clearMessages();
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; record: WarehouseRow; error?: string }>(`/api/warehouses/${nog}`),
      );
      if (!r.ok) throw new Error(r.error);
      this.selected.set(nog);
      this.form.set({
        NOG: r.record.NOG,
        NAMEG: this.cleanText(r.record.NAMEG),
        ADR: this.cleanText(r.record.ADR),
        TEL: this.cleanText(r.record.TEL),
        NAMEAM: this.cleanText(r.record.NAMEAM),
        NOA_S: r.record.NOA_S,
        USEM: r.record.USEM,
      });
      this.mode.set('browse');
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.loading.set(false);
  }

  onNew(): void {
    this.clearMessages();
    this.selected.set(null);
    this.form.set({ ...EMPTY_FORM, NOG: this.nextNog() });
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

  focusSearch(): void {
    this.legacySearchInput?.nativeElement.focus();
    this.legacySearchInput?.nativeElement.select();
  }

  onUserChange(value: unknown): void {
    const usem = Number(value) || null;
    const currentNog = Number(this.form().NOG ?? 0);
    if (usem) {
      const duplicate = this.rows().find(row => Number(row.USEM ?? 0) === usem && Number(row.NOG ?? 0) !== currentNog);
      if (duplicate) {
        this.err.set(`المستخدم المدخل تم تعريفة مع المخزن ${duplicate.NOG}`);
        const original = this.rows().find(row => Number(row.NOG ?? 0) === currentNog);
        this.updateField('USEM', original?.USEM ?? null);
        return;
      }
    }
    this.clearMessages();
    this.updateField('USEM', usem);
  }

  private nextNog(): number {
    const max = this.rows().reduce((acc, row) => Math.max(acc, Number(row.NOG ?? 0)), 0);
    return max + 1 || 1;
  }

  validate(): boolean {
    const f = { ...this.form(), NAMEG: this.form().NAMEG.trim() };
    if (!f.NOG || f.NOG <= 0) { this.err.set('رقم المخزن مطلوب'); return false; }
    if (!f.NAMEG) { this.err.set(' يجب ادخال اسم المخزن'); return false; }

    const duplicateName = this.rows().find(row =>
      this.cleanText(row.NAMEG).trim() === f.NAMEG && Number(row.NOG ?? 0) !== Number(f.NOG ?? 0),
    );
    if (duplicateName) { this.err.set('اسم المخزن  المدخل مقيد من قبل'); return false; }

    const usem = Number(f.USEM ?? 0);
    if (usem > 0) {
      const duplicateUser = this.rows().find(row =>
        Number(row.USEM ?? 0) === usem && Number(row.NOG ?? 0) !== Number(f.NOG ?? 0),
      );
      if (duplicateUser) { this.err.set(`المستخدم المدخل تم تعريفة مع المخزن ${duplicateUser.NOG}`); return false; }
    }
    return true;
  }

  async onSave(): Promise<void> {
    if (!this.validate()) return;
    this.saving.set(true); this.clearMessages();
    const f = { ...this.form(), NAMEG: this.form().NAMEG.trim() };
    try {
      const isNew = this.mode() === 'new';
      const url = isNew ? '/api/warehouses' : `/api/warehouses/${f.NOG}`;
      const method = isNew ? 'POST' : 'PUT';
      const r = await firstValueFrom(
        this.http.request<{ ok: boolean; message?: string; error?: string; nog?: number }>(
          method, url, { body: f },
        ),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحفظ');
      this.mode.set('browse');
      const savedNog = Number(r.nog ?? f.NOG);
      await this.fetchList();
      if (savedNog) await this.openRow(savedNog);
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  async onDelete(): Promise<void> {
    const nog = this.selected();
    if (nog === null) return;
    if (nog <= 1) { this.err.set('لا يمكن حذف المخزن رقم 1'); return; }
    const name = this.form().NAMEG || `رقم ${nog}`;
    if (!confirm(`هل انت متأكد من حذف  مخزن  :    ${name}`)) return;
    this.saving.set(true); this.clearMessages();
    try {
      const r = await firstValueFrom(
        this.http.delete<{ ok: boolean; message?: string; error?: string }>(`/api/warehouses/${nog}`),
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

  trackByNog = (_: number, r: WarehouseRow) => r.NOG;
  trackByUser = (_: number, r: UserLovRow) => r.NOU;

  @HostListener('document:keydown', ['$event'])
  handleLegacyKeys(event: KeyboardEvent): void {
    if (event.key === 'F2' && this.canIns() && !this.editable() && !this.saving()) {
      event.preventDefault();
      this.onNew();
    } else if (event.key === 'F3' && this.canSar() && !this.saving()) {
      event.preventDefault();
      this.focusSearch();
    } else if (event.key === 'F8' && this.canEd() && this.hasCurrent() && !this.editable() && !this.saving()) {
      event.preventDefault();
      this.onEdit();
    } else if (event.key === 'F10' && this.editable() && !this.saving()) {
      event.preventDefault();
      void this.onSave();
    } else if (event.key === 'F7' && this.editable()) {
      event.preventDefault();
      this.onCancel();
    } else if (event.key === 'F6' && this.canDeleteCurrent()) {
      event.preventDefault();
      void this.onDelete();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (this.editable()) this.onCancel();
      else this.onExit();
    }
  }
}
