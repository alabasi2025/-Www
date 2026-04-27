import {
  Component, OnInit, signal, computed, inject, ChangeDetectionStrategy, HostListener,
} from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';

/**
 * Currency row as served by `/api/currencies`.
 * Mirrors the AMLH table from the legacy Oracle Forms screen DATA_AML.
 */
export interface CurrencyRow {
  NO:      number;
  NAMEM:   string | null;
  NAMEM2:  string | null;
  NAMEM3:  string | null;
  NAMEH:   string | null;
  NACHAR:  string | null;
  FLS:     string | null;
  SARS:    number;
  SARS1:   number;
  SARS2:   number;
}

/** Writable form model backing the Angular template. */
interface CurrencyForm {
  NO:     number | null;
  NAMEM:  string;
  NAMEM2: string;
  NAMEM3: string;
  NAMEH:  string;
  NACHAR: string;
  FLS:    string;
  SARS:   number;
  SARS1:  number;
  SARS2:  number;
}

const EMPTY_FORM: CurrencyForm = {
  NO: null, NAMEM: '', NAMEM2: '', NAMEM3: '', NAMEH: '',
  NACHAR: '', FLS: '', SARS: 1, SARS1: 0, SARS2: 0,
};

/**
 * DATA_AML — تهيئة العملات
 *
 * Oracle-Forms-style master-data screen backed by the AMLH table.
 * Left pane: searchable list of currencies.
 * Right pane: editable detail form with full CRUD + rate validation.
 */
@Component({
  selector: 'app-data-aml',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, DecimalPipe],
  templateUrl: './data-aml.component.html',
  styleUrl: './data-aml.component.scss',
})
export class DataAmlComponent implements OnInit {
  private http = inject(HttpClient);
  private permSvc = inject(PermissionService);
  private router = inject(Router);

  readonly screenCode = 'DATA_AML.FMX';

  // ── Permissions ─────────────────────────────────────
  private readonly perms = computed(() => this.permSvc.forScreen(this.screenCode)());
  readonly canIns = computed(() => (this.perms()?.ins ?? 0) > 0);
  readonly canEd  = computed(() => (this.perms()?.ed  ?? 0) > 0);
  readonly canDe  = computed(() => (this.perms()?.de  ?? 0) > 0);
  readonly canPr  = computed(() => (this.perms()?.pr  ?? 0) > 0);
  readonly canSar = computed(() => (this.perms()?.sar ?? 0) > 0);

  // ── State ───────────────────────────────────────────
  readonly rows    = signal<CurrencyRow[]>([]);
  readonly form    = signal<CurrencyForm>({ ...EMPTY_FORM });
  /** The NO of the row last loaded from the server (null = creating new). */
  readonly selected = signal<number | null>(null);
  readonly mode    = signal<'browse' | 'new' | 'edit'>('browse');
  readonly loading = signal(false);
  readonly saving  = signal(false);
  readonly err     = signal<string | null>(null);
  readonly info    = signal<string | null>(null);
  readonly search  = signal('');

  // ── Derived ─────────────────────────────────────────
  readonly editable = computed(() => this.mode() !== 'browse');
  readonly hasCurrent = computed(() => this.selected() !== null);
  readonly currentNo = computed(() => Number(this.form().NO ?? 0));
  readonly isLocalCurrency = computed(() => this.currentNo() === 1);
  readonly isBaseCurrency = computed(() => this.currentNo() >= 1 && this.currentNo() <= 3);
  readonly canEditLegacyName = computed(() => !(this.mode() === 'edit' && this.isBaseCurrency()));

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) return this.rows();
    return this.rows().filter(r =>
      String(r.NO).includes(q) ||
      (r.NAMEM ?? '').toLowerCase().includes(q) ||
      (r.NAMEM2 ?? '').toLowerCase().includes(q) ||
      (r.NAMEH ?? '').toLowerCase().includes(q)
    );
  });

  clearMessages(): void { this.err.set(null); this.info.set(null); }

  openGridRow(no: number): void {
    if (this.editable() || this.saving()) return;
    void this.openRow(no);
  }

  isEditingRow(no: number): boolean {
    return this.editable() && Number(this.form().NO ?? 0) === Number(no);
  }

  /** Updates a single form field immutably. */
  updateField<K extends keyof CurrencyForm>(key: K, value: CurrencyForm[K]): void {
    this.form.update(f => {
      const next = { ...f, [key]: value };
      if (key === 'NAMEM2') {
        const name = String(value ?? '').trim();
        if (!next.NAMEH.trim()) next.NAMEH = name;
      }
      if (key === 'NO' && Number(value) === 1) {
        next.SARS = 1;
        next.SARS1 = 1;
        next.SARS2 = 1;
      }
      return next;
    });
  }

  // ── Lifecycle ──────────────────────────────────────
  async ngOnInit(): Promise<void> {
    await this.fetchList();
  }

  async fetchList(): Promise<void> {
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: CurrencyRow[]; error?: string }>('/api/currencies'),
      );
      if (!r.ok) throw new Error(r.error);
      const rows = r.rows ?? [];
      this.rows.set(rows);
      if (this.mode() === 'browse' && this.selected() === null && rows.length > 0) {
        this.selected.set(rows[0]!.NO);
        this.form.set(this.toForm(rows[0]!));
      }
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.loading.set(false);
  }

  async openRow(no: number): Promise<void> {
    this.clearMessages();
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; record: CurrencyRow; error?: string }>(`/api/currencies/${no}`),
      );
      if (!r.ok) throw new Error(r.error);
      this.selected.set(no);
      this.form.set(this.toForm(r.record));
      this.mode.set('browse');
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.loading.set(false);
  }

  private toForm(r: CurrencyRow): CurrencyForm {
    return {
      NO:     r.NO,
      NAMEM:  r.NAMEM  ?? '',
      NAMEM2: r.NAMEM2 ?? '',
      NAMEM3: r.NAMEM3 ?? '',
      NAMEH:  r.NAMEH  ?? '',
      NACHAR: r.NACHAR ?? '',
      FLS:    r.FLS    ?? '',
      SARS:   Number(r.SARS  ?? 1),
      SARS1:  Number(r.SARS1 ?? 0),
      SARS2:  Number(r.SARS2 ?? 0),
    };
  }

  // ── Toolbar handlers ───────────────────────────────
  onNew(): void {
    this.clearMessages();
    this.selected.set(null);
    const no = this.nextCurrencyNo();
    this.form.set({ ...EMPTY_FORM, NO: no, SARS: 1, SARS1: no === 1 ? 1 : 0, SARS2: no === 1 ? 1 : 0 });
    this.mode.set('new');
  }

  onEdit(): void {
    if (this.selected() === null) return;
    this.clearMessages();
    this.mode.set('edit');
  }

  onCancel(): void {
    this.clearMessages();
    if (this.selected() !== null) { void this.openRow(this.selected()!); }
    else { this.form.set({ ...EMPTY_FORM }); this.mode.set('browse'); }
  }

  onExit(): void {
    void this.router.navigateByUrl('/app');
  }

  normalizeRateFields(): void {
    this.form.update(f => this.normalizeRates(f));
  }

  private nextCurrencyNo(): number {
    const max = this.rows().reduce((acc, row) => Math.max(acc, Number(row.NO ?? 0)), 0);
    return max + 1 || 1;
  }

  private legacyName3(namem2: string): string {
    const value = namem2.trim();
    if (!value) return '';
    const firstSpace = value.search(/\s/);
    if (firstSpace > 0) {
      const first = value.slice(0, firstSpace);
      const rest = value.slice(firstSpace).trimStart();
      return `بال${first} ال${rest}`.slice(0, 40);
    }
    return `بال${value}`.slice(0, 40);
  }

  private normalizeRates(form: CurrencyForm): CurrencyForm {
    const no = Number(form.NO ?? 0);
    if (no === 1) return { ...form, SARS: 1, SARS1: 1, SARS2: 1 };

    let sars = Number(form.SARS ?? 0);
    let sars1 = Number(form.SARS1 ?? 0);
    let sars2 = Number(form.SARS2 ?? 0);

    if (sars1 === 0) sars1 = sars;
    if (sars2 === 0) sars2 = sars;
    if (sars > sars1) sars1 = sars;
    if (sars < sars2) sars2 = sars;
    if (sars1 < sars) sars1 = sars;
    if (sars1 < sars2) sars2 = sars;
    if (sars2 > sars) sars2 = sars;
    if (sars2 > sars1 || sars2 === 0) sars2 = sars1;

    return { ...form, SARS: sars, SARS1: sars1, SARS2: sars2 };
  }

  private prepareForSave(form: CurrencyForm): CurrencyForm {
    const namem2 = form.NAMEM2.trim();
    const next: CurrencyForm = {
      ...form,
      NAMEM: form.NAMEM.trim() || namem2,
      NAMEM2: namem2,
      NAMEM3: this.legacyName3(namem2),
      NAMEH: form.NAMEH.trim() || namem2,
      NACHAR: form.NACHAR.trim(),
      FLS: form.FLS.trim(),
    };
    return this.normalizeRates(next);
  }

  /** Client-side mirror of the backend `validateCurrencyPayload` guard. */
  validate(f = this.form()): boolean {
    if (!f.NO || f.NO <= 0) { this.err.set('رقم العملة مطلوب'); return false; }
    if (!f.NAMEM2.trim())   { this.err.set('اسم العملة مطلوب'); return false; }
    if (f.SARS <= 0)        { this.err.set('سعر الصرف يجب أن يكون موجباً'); return false; }
    if (f.SARS1 > 0 && f.SARS > f.SARS1) {
      this.err.set(`سعر الصرف (${f.SARS}) أكبر من أعلى سعر (${f.SARS1})`); return false;
    }
    if (f.SARS2 > 0 && f.SARS < f.SARS2) {
      this.err.set(`سعر الصرف (${f.SARS}) أقل من أدنى سعر (${f.SARS2})`); return false;
    }
    if (f.SARS1 > 0 && f.SARS2 > 0 && f.SARS2 > f.SARS1) {
      this.err.set('أدنى سعر لا يمكن أن يكون أكبر من أعلى سعر'); return false;
    }
    return true;
  }

  async onSave(): Promise<void> {
    const prepared = this.prepareForSave(this.form());
    this.form.set(prepared);
    if (!this.validate(prepared)) return;
    this.saving.set(true); this.clearMessages();
    const f = prepared;
    try {
      const isNew = this.mode() === 'new';
      const url = isNew ? '/api/currencies' : `/api/currencies/${f.NO}`;
      const method = isNew ? 'POST' : 'PUT';
      const r = await firstValueFrom(
        this.http.request<{ ok: boolean; message?: string; error?: string; no?: number }>(
          method, url, { body: f },
        ),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحفظ');
      this.mode.set('browse');
      await this.fetchList();
      await this.openRow(f.NO!);
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  async onDelete(): Promise<void> {
    const no = this.selected();
    if (no === null) return;
    if (no <= 3) { this.err.set('لا يمكن حذف العملات الأساسية 1 و2 و3 كما في النظام القديم'); return; }
    if (!confirm(`هل أنت متأكد من حذف العملة رقم ${no}؟`)) return;
    this.saving.set(true); this.clearMessages();
    try {
      const r = await firstValueFrom(
        this.http.delete<{ ok: boolean; message?: string; error?: string }>(`/api/currencies/${no}`),
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

  // ── Template helpers ───────────────────────────────
  trackByNo = (_: number, r: CurrencyRow) => r.NO;

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
