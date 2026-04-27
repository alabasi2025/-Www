/**
 * MSDKA — مصادقة الحسابات (Account Reconciliation)
 *
 * Reference: _forms_kb/MSDKA.json, _forms_plsql/msdka.md
 * Table: DATA_AC (column MSDKA = reconciliation flag)
 *
 * Blocks: TR (filter), DATA_A (account list), CONT (actions)
 * Logic:
 *   - Shows accounts (DATA_AC WHERE RTBA=5) with MSDKA flag
 *   - User can select/deselect accounts for reconciliation
 *   - Filter by TYPEA (NOA4 dropdown)
 *   - Show balances from DATAK view
 *   - T_MS = max date from DATAK (cutoff date)
 */
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, DecimalPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';
import { LegacyToolbarComponent } from '../../../shared/legacy-ui/legacy-toolbar/legacy-toolbar.component';
import { LegacyStatusBarComponent, type LegacyStatusBadge } from '../../../shared/legacy-ui/legacy-status-bar/legacy-status-bar.component';
import { LegacyToolbarActionId } from '../../../shared/legacy-ui/contracts/legacy-contracts';

interface Account {
  NOA: number;
  NAMEA: string;
  TYPEA: number;
  RTBA: number;
  MSDKA: number | null;
  AMLHH: number | null;
}

interface Balance {
  NOA: number;
  MDIN: number;
  DAN: number;
  BALANCE: number;
}

@Component({
  selector: 'app-msdka',
  imports: [CommonModule, FormsModule, DecimalPipe, DatePipe, LegacyToolbarComponent, LegacyStatusBarComponent],
  templateUrl: './msdka.component.html',
  styleUrl: './msdka.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MsdkaComponent implements OnInit {
  private http = inject(HttpClient);
  private route = inject(ActivatedRoute);
  private perms = inject(PermissionService);

  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);

  // Data
  readonly accounts = signal<Account[]>([]);
  readonly balances = signal<Map<number, Balance>>(new Map());
  readonly cutoffDate = signal<string>('');

  // Filter
  readonly filterTypea = signal<number | null>(null);
  readonly search = signal('');
  readonly showOnlySelected = signal(false);

  // Permissions
  readonly canEd = signal(false);

  // Computed
  readonly filteredAccounts = computed(() => {
    let list = this.accounts();
    const typea = this.filterTypea();
    if (typea != null) list = list.filter(a => a.TYPEA === typea);
    const q = this.search().trim().toLowerCase();
    if (q) list = list.filter(a =>
      a.NAMEA.toLowerCase().includes(q) || String(a.NOA).includes(q)
    );
    if (this.showOnlySelected()) list = list.filter(a => (a.MSDKA ?? 0) > 0);
    return list;
  });

  readonly typeaOptions = computed(() => {
    const types = new Set(this.accounts().map(a => a.TYPEA));
    return [...types].sort((a, b) => a - b);
  });

  readonly selectedCount = computed(() =>
    this.accounts().filter(a => (a.MSDKA ?? 0) > 0).length
  );

  readonly totalBalance = computed(() => {
    const bals = this.balances();
    let mdin = 0, dan = 0;
    for (const a of this.filteredAccounts()) {
      const b = bals.get(a.NOA);
      if (b) { mdin += b.MDIN; dan += b.DAN; }
    }
    return { mdin, dan, net: mdin - dan };
  });

  readonly p = this.perms.forScreen('MSDKA');

  async ngOnInit(): Promise<void> {
    this.canEd.set(true); // Will be updated by p() signal
    await this.loadData();
  }

  async loadData(): Promise<void> {
    this.loading.set(true);
    this.err.set(null);
    try {
      // Load accounts
      const acRes = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: Account[] }>('/api/data/DATA_AC?where=RTBA=5&limit=9999&orderBy=NOA')
      );
      if (acRes.ok) this.accounts.set(acRes.rows);

      // Load cutoff date from DATAK
      try {
        const dmRes = await firstValueFrom(
          this.http.get<{ ok: boolean; rows: { DM: string }[] }>(
            `/api/data/DATAK?limit=1&orderBy=DATEMO DESC&cols=MAX(DATEMO) AS DM`
          )
        );
        if (dmRes.ok && dmRes.rows?.[0]?.DM) {
          this.cutoffDate.set(String(dmRes.rows[0].DM).slice(0, 10));
        }
      } catch { /* non-critical */ }

    } catch (e) {
      this.err.set(e instanceof Error ? e.message : 'خطأ في التحميل');
    }
    this.loading.set(false);
  }

  toggleMsdka(noa: number): void {
    this.accounts.update(list =>
      list.map(a => a.NOA === noa ? { ...a, MSDKA: (a.MSDKA ?? 0) > 0 ? 0 : 1 } : a)
    );
  }

  selectAll(): void {
    this.accounts.update(list =>
      list.map(a => this.filteredAccounts().some(f => f.NOA === a.NOA) ? { ...a, MSDKA: 1 } : a)
    );
  }

  deselectAll(): void {
    this.accounts.update(list =>
      list.map(a => ({ ...a, MSDKA: 0 }))
    );
  }

  async save(): Promise<void> {
    this.saving.set(true);
    this.err.set(null);
    try {
      // Update MSDKA flag for all accounts
      const selected = this.accounts().filter(a => (a.MSDKA ?? 0) > 0);
      const deselected = this.accounts().filter(a => (a.MSDKA ?? 0) === 0);

      // Set MSDKA=1 for selected
      if (selected.length) {
        const noas = selected.map(a => a.NOA).join(',');
        await firstValueFrom(this.http.put('/api/data/DATA_AC', {
          _set: 'MSDKA=1',
          _where: `NOA IN (${noas}) AND RTBA=5`,
        }));
      }

      // Set MSDKA=0 for deselected
      if (deselected.length) {
        await firstValueFrom(this.http.put('/api/data/DATA_AC', {
          _set: 'MSDKA=0',
          _where: `RTBA=5 AND (MSDKA IS NOT NULL AND MSDKA<>0)`,
        }));
      }

      this.info.set(`تم حفظ المصادقة — ${selected.length} حساب محدد`);
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : 'خطأ في الحفظ');
    }
    this.saving.set(false);
  }

  clearMessages(): void {
    this.err.set(null);
    this.info.set(null);
  }

  onToolbarAction(action: LegacyToolbarActionId): void {
    switch (action) {
      case 'save': this.save(); break;
      case 'refresh': this.loadData(); break;
      case 'exit': window.history.back(); break;
    }
  }

  getBalance(noa: number): Balance | undefined {
    return this.balances().get(noa);
  }
}
