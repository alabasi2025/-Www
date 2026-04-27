import {
  Component, OnInit, signal, computed, inject, ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';

/** Row returned by the barcodes list endpoint. */
export interface BarcodeRow {
  NOP: string;
  NOA: number;
  NOOB: number;
  ITEM_NAME: string | null;
  AHSAR: string | null;
}

/** Minimal item row used in the item picker LOV. */
interface ItemLookup {
  NOA: number;
  NAMEA: string | null;
  AHSAR: string | null;
  NOPARCOD: string | null;
}

/** Writable form for adding a new barcode. */
interface AddForm {
  NOP: string;
  NOOB: number;
}

/**
 * PARCOD — ادخال باركودات الاصناف.
 * Allows multiple barcodes (one per pack size) to be mapped to an item.
 */
@Component({
  selector: 'app-parcod',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  templateUrl: './parcod.component.html',
  styleUrl: './parcod.component.scss',
})
export class ParcodComponent implements OnInit {
  private http = inject(HttpClient);
  private permSvc = inject(PermissionService);

  readonly screenCode = 'PARCOD.FMX';

  private readonly perms = computed(() => this.permSvc.forScreen(this.screenCode)());
  readonly canIns = computed(() => (this.perms()?.ins ?? 0) > 0);
  readonly canEd  = computed(() => (this.perms()?.ed  ?? 0) > 0);
  readonly canDe  = computed(() => (this.perms()?.de  ?? 0) > 0);
  readonly canPr  = computed(() => (this.perms()?.pr  ?? 0) > 0);
  readonly canSar = computed(() => (this.perms()?.sar ?? 0) > 0);

  // ── State ───────────────────────────────────────────
  readonly allBarcodes = signal<BarcodeRow[]>([]);
  readonly items       = signal<ItemLookup[]>([]);

  /** Currently selected item (for which barcodes are shown). */
  readonly selectedItem = signal<ItemLookup | null>(null);
  readonly addForm      = signal<AddForm>({ NOP: '', NOOB: 1 });

  readonly loading = signal(false);
  readonly saving  = signal(false);
  readonly err     = signal<string | null>(null);
  readonly info    = signal<string | null>(null);

  // Global barcode search
  readonly globalSearch = signal('');

  // Item-picker LOV
  readonly itemLovOpen   = signal(false);
  readonly itemLovSearch = signal('');

  // ── Derived ─────────────────────────────────────────
  readonly barcodesForItem = computed(() => {
    const it = this.selectedItem();
    if (!it) return [];
    return this.allBarcodes().filter(b => b.NOA === it.NOA);
  });

  readonly globalFiltered = computed(() => {
    const q = this.globalSearch().trim().toLowerCase();
    if (!q) return [] as BarcodeRow[];
    return this.allBarcodes().filter(b =>
      b.NOP.toLowerCase().includes(q) ||
      (b.ITEM_NAME ?? '').toLowerCase().includes(q) ||
      String(b.NOA).includes(q)
    ).slice(0, 200);
  });

  readonly itemLovFiltered = computed(() => {
    const q = this.itemLovSearch().trim().toLowerCase();
    if (!q) return this.items().slice(0, 100);
    return this.items().filter(i =>
      String(i.NOA).includes(q) ||
      (i.NAMEA ?? '').toLowerCase().includes(q) ||
      (i.AHSAR ?? '').toLowerCase().includes(q)
    ).slice(0, 100);
  });


  clearMessages(): void { this.err.set(null); this.info.set(null); }

  updateAddField<K extends keyof AddForm>(key: K, value: AddForm[K]): void {
    this.addForm.update(f => ({ ...f, [key]: value }));
  }

  // ── Lifecycle ──────────────────────────────────────
  async ngOnInit(): Promise<void> {
    await Promise.all([this.fetchAll(), this.fetchItems()]);
  }

  async fetchAll(): Promise<void> {
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: BarcodeRow[]; error?: string }>('/api/barcodes'),
      );
      if (!r.ok) throw new Error(r.error);
      this.allBarcodes.set(r.rows ?? []);
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.loading.set(false);
  }

  async fetchItems(): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: ItemLookup[] }>('/api/items'),
      );
      if (r.ok) this.items.set(r.rows ?? []);
    } catch { /* silent */ }
  }

  // ── Item picker ────────────────────────────────────
  openItemLov(): void {
    this.itemLovSearch.set('');
    this.itemLovOpen.set(true);
  }
  closeItemLov(): void { this.itemLovOpen.set(false); }
  pickItem(i: ItemLookup): void {
    this.selectedItem.set(i);
    this.addForm.set({ NOP: '', NOOB: 1 });
    this.itemLovOpen.set(false);
    this.clearMessages();
  }

  selectFromGlobal(b: BarcodeRow): void {
    const it = this.items().find(i => i.NOA === b.NOA);
    if (it) {
      this.selectedItem.set(it);
      this.globalSearch.set('');
      this.clearMessages();
    }
  }

  // ── Actions ────────────────────────────────────────
  async onAdd(): Promise<void> {
    const it = this.selectedItem();
    if (!it) { this.err.set('يجب اختيار الصنف أولاً'); return; }
    const f = this.addForm();
    const nop = f.NOP.trim();
    if (!nop) { this.err.set('الباركود مطلوب'); return; }

    this.saving.set(true); this.clearMessages();
    try {
      const r = await firstValueFrom(
        this.http.post<{ ok: boolean; message?: string; error?: string }>(
          '/api/barcodes',
          { NOP: nop, NOA: it.NOA, NOOB: f.NOOB || 1 },
        ),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الإضافة');
      this.addForm.set({ NOP: '', NOOB: 1 });
      await this.fetchAll();
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  async onUpdateNoob(row: BarcodeRow, newVal: number): Promise<void> {
    if (!newVal || newVal <= 0) return;
    this.clearMessages();
    try {
      const r = await firstValueFrom(
        this.http.put<{ ok: boolean; error?: string }>(
          `/api/barcodes/${encodeURIComponent(row.NOP)}`,
          { NOOB: newVal },
        ),
      );
      if (!r.ok) throw new Error(r.error);
      await this.fetchAll();
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
  }

  async onDelete(row: BarcodeRow): Promise<void> {
    if (!confirm(`هل أنت متأكد من حذف الباركود "${row.NOP}"؟`)) return;
    this.saving.set(true); this.clearMessages();
    try {
      const r = await firstValueFrom(
        this.http.delete<{ ok: boolean; message?: string; error?: string }>(
          `/api/barcodes/${encodeURIComponent(row.NOP)}`,
        ),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحذف');
      await this.fetchAll();
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  trackByNop  = (_: number, r: BarcodeRow) => r.NOP;
  trackByItem = (_: number, i: ItemLookup) => i.NOA;
}
