import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LegacyToolbarComponent } from '../../../shared/legacy-ui/legacy-toolbar/legacy-toolbar.component';
import { LegacyStatusBarComponent, type LegacyStatusBadge } from '../../../shared/legacy-ui/legacy-status-bar/legacy-status-bar.component';
import { LegacyToolbarActionId } from '../../../shared/legacy-ui/contracts/legacy-contracts';
import { PermissionService } from '../../../services/permission.service';

type Mode = 'browse' | 'edit';

interface KeyRow {
  KEYF: string;
  FIELN: string | null;
  NAMEA: string | null;
  NAMEE: string | null;
}

interface ScreenOption {
  NAMEF: string;
  NAMEA: string | null;
  NAMEE: string | null;
  TSYS: number | null;
}

@Component({
  selector: 'app-kf',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, LegacyToolbarComponent, LegacyStatusBarComponent],
  templateUrl: './kf.component.html',
  styleUrl: './kf.component.scss',
})
export class KfComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly perms = inject(PermissionService).forScreen('KF.FMX');

  readonly rows = signal<KeyRow[]>([]);
  readonly screens = signal<ScreenOption[]>([]);
  readonly current = signal<KeyRow | null>(null);
  readonly original = signal<KeyRow | null>(null);
  readonly mode = signal<Mode>('browse');
  readonly search = signal('');
  readonly screenSearch = signal('');
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);

  readonly editable = computed(() => this.mode() === 'edit');
  readonly canEd = computed(() => (this.perms()?.ed ?? 0) > 0);
  readonly hasCurrent = computed(() => !!this.current()?.KEYF);
  readonly currentIdx = computed(() => {
    const key = this.current()?.KEYF;
    if (!key) return -1;
    return this.filteredRows().findIndex(row => row.KEYF === key);
  });
  readonly filteredRows = computed(() => {
    const q = this.search().trim().toUpperCase();
    if (!q) return this.rows();
    return this.rows().filter(row =>
      row.KEYF.toUpperCase().includes(q) ||
      String(row.FIELN ?? '').toUpperCase().includes(q) ||
      String(row.NAMEA ?? '').toUpperCase().includes(q) ||
      String(row.NAMEE ?? '').toUpperCase().includes(q));
  });
  readonly filteredScreens = computed(() => {
    const q = this.screenSearch().trim().toUpperCase();
    const list = this.screens();
    if (!q) return list.slice(0, 250);
    return list.filter(row =>
      String(row.NAMEF ?? '').toUpperCase().includes(q) ||
      String(row.NAMEA ?? '').toUpperCase().includes(q) ||
      String(row.NAMEE ?? '').toUpperCase().includes(q)).slice(0, 250);
  });
  readonly statusBadges = computed<LegacyStatusBadge[]>(() => [
    { label: `عدد: ${this.rows().length}`, icon: 'pi-list', variant: 'info' },
    this.current()?.KEYF
      ? { label: `المفتاح: ${this.current()?.KEYF}`, icon: 'pi-key', variant: 'success' }
      : { label: 'لا يوجد مفتاح محدد', icon: 'pi-info-circle', variant: 'warning' },
  ]);

  async ngOnInit(): Promise<void> {
    await Promise.all([this.fetchRows(), this.fetchScreens()]);
  }

  @HostListener('document:keydown', ['$event'])
  handleLegacyKeys(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;

    switch (event.key) {
      case 'F8':
        if (this.canEd() && this.hasCurrent() && !this.editable() && !this.saving()) {
          event.preventDefault();
          this.onEdit();
        }
        break;
      case 'F10':
        if (this.editable() && !this.saving()) {
          event.preventDefault();
          void this.onSave();
        }
        break;
      case 'F7':
        if (this.editable() && !this.saving()) {
          event.preventDefault();
          this.onCancel();
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

  async fetchRows(): Promise<void> {
    this.loading.set(true);
    this.err.set(null);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: KeyRow[]; error?: string }>('/api/screen-keys'),
      );
      if (!r.ok) throw new Error(r.error);
      this.rows.set(r.rows ?? []);
      const active = this.current()?.KEYF;
      const next = active ? this.rows().find(row => row.KEYF === active) : this.rows()[0];
      this.setCurrent(next ?? null);
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  async fetchScreens(): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: ScreenOption[]; error?: string }>('/api/screen-keys/screens?limit=1000'),
      );
      if (!r.ok) throw new Error(r.error);
      this.screens.set(r.rows ?? []);
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
  }

  selectRow(row: KeyRow): void {
    if (this.editable()) return;
    this.setCurrent(row);
    this.clearMessages();
  }

  onEdit(): void {
    if (!this.current()) return;
    this.original.set({ ...this.current()! });
    this.mode.set('edit');
    this.info.set('وضع تعديل مفتاح الشاشة');
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
    if (!row?.KEYF) return;
    this.saving.set(true);
    this.err.set(null);
    try {
      const r = await firstValueFrom(
        this.http.put<{ ok: boolean; message?: string; error?: string }>(
          `/api/screen-keys/${encodeURIComponent(row.KEYF)}`,
          { FIELN: row.FIELN },
        ),
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

  patch(patch: Partial<KeyRow>): void {
    if (!this.editable()) return;
    this.current.update(row => row ? ({ ...row, ...patch, ...this.screenName(patch.FIELN ?? row.FIELN) }) : row);
  }

  navTo(target: 'first' | 'last' | number): void {
    if (this.editable()) return;
    const list = this.filteredRows();
    if (!list.length) return;
    const idx = this.currentIdx();
    const next = target === 'first' ? 0
      : target === 'last' ? list.length - 1
        : Math.min(list.length - 1, Math.max(0, idx + target));
    this.setCurrent(list[next] ?? null);
  }

  clearMessages(): void {
    this.err.set(null);
    this.info.set(null);
  }

  labelFor(row: KeyRow | null): string {
    if (!row?.FIELN) return 'غير مخصص';
    return row.NAMEA ? `${row.NAMEA} - ${row.FIELN}` : row.FIELN;
  }

  private setCurrent(row: KeyRow | null): void {
    this.current.set(row ? { ...row } : null);
  }

  private screenName(fieln: string | null | undefined): Partial<KeyRow> {
    const option = this.screens().find(s => String(s.NAMEF).toUpperCase() === String(fieln ?? '').toUpperCase());
    return {
      NAMEA: option?.NAMEA ?? null,
      NAMEE: option?.NAMEE ?? null,
    };
  }
}
