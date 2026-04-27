import {
  Component, ChangeDetectionStrategy, inject, input, output, signal, effect, computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

/** Account entry returned by /api/lov/accounts. */
export interface LovAccount {
  NOA: number;
  NAMEA: string;
  NOAML: number;
  AHSAR: string | null;
  NOSNDOK?: number | null;
}

/**
 * LovPickerComponent — reusable Accounts LOV (List Of Values) dialog.
 *
 * Wraps the common pattern used across SNDK/SNDS, FB, TREE, and any
 * screen that needs to pick an account from DATA_AC.
 *
 * Usage:
 *
 *   <app-lov-picker
 *     [open]="lovOpen()"
 *     [rtba]="5"
 *     title="دليل الحسابات"
 *     (select)="onAccount($event)"
 *     (close)="closeLov()" />
 *
 * The component handles:
 *   - Debounced search against /api/lov/accounts?q=...&rtba=...&limit=...
 *   - Keyboard navigation (Esc closes, click outside closes)
 *   - Loading + empty states with Arabic labels
 *   - RTL layout
 */
@Component({
  selector: 'app-lov-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  templateUrl: './lov-picker.component.html',
  styleUrl: './lov-picker.component.scss',
})
export class LovPickerComponent {
  private http = inject(HttpClient);

  /** Whether the dialog is open. */
  readonly open = input.required<boolean>();

  /**
   * DATA_AC.RTBA (depth) filter. Defaults to 5 (leaf accounts, most common).
   * Use 0 to disable the filter (return all).
   */
  readonly rtba = input<number>(5);

  /**
   * Oracle-Forms-like table layout (Find / OK / Cancel + fixed columns).
   * Enabled only on screens that need legacy visual parity.
   */
  readonly legacy = input<boolean>(false);

  /** Dialog title shown in the header. */
  readonly title = input<string>('دليل الحسابات');

  /** Max rows to request from the API. Default 30. */
  readonly limit = input<number>(30);

  /** Placeholder for the search input. */
  readonly placeholder = input<string>('ابحث بالاسم أو الرقم أو الاختصار...');

  /** Emitted when a row is clicked. Receives the full LovAccount. */
  readonly select = output<LovAccount>();

  /** Emitted when the user dismisses the dialog (close icon, backdrop, Esc). */
  readonly close = output<void>();

  // ── internal state ────────────────────────────────────────
  readonly query = signal('');
  readonly results = signal<LovAccount[]>([]);
  readonly loading = signal(false);
  readonly selected = signal<LovAccount | null>(null);

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  readonly rowCount = computed(() => this.results().length);

  constructor() {
    // Re-search whenever the dialog opens.
    effect(() => {
      if (this.open()) {
        this.query.set('');
        this.selected.set(null);
        void this.fetch('');
      }
    });
  }

  onQueryChange(q: string): void {
    this.query.set(q);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.fetch(q), 250);
  }

  async fetch(q: string): Promise<void> {
    this.loading.set(true);
    try {
      const qq = (q && q.trim()) ? q.trim() : '%';
      const url =
        `/api/lov/accounts?q=${encodeURIComponent(qq)}` +
        `&rtba=${this.rtba()}&limit=${this.limit()}`;
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; items?: LovAccount[] }>(url),
      );
      const items = r.ok ? (r.items ?? []) : [];
      this.results.set(items);
      if (this.legacy()) this.selected.set(items[0] ?? null);
    } catch {
      this.results.set([]);
      this.selected.set(null);
    }
    this.loading.set(false);
  }

  pick(item: LovAccount): void {
    this.select.emit(item);
  }

  choose(item: LovAccount): void {
    if (this.legacy()) {
      this.selected.set(item);
      return;
    }
    this.pick(item);
  }

  confirmPick(): void {
    const row = this.selected();
    if (row) this.pick(row);
  }

  isSelected(item: LovAccount): boolean {
    return this.selected()?.NOA === item.NOA;
  }

  onFind(): void {
    void this.fetch(this.query());
  }

  onBackdrop(): void {
    this.close.emit();
  }

  onEscape(event: KeyboardEvent): void {
    if (event.key === 'Escape') this.close.emit();
  }

  onQueryKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.onFind();
    }
  }
}
