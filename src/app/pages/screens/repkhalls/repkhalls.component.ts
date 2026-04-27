import { ChangeDetectionStrategy, Component, inject, signal, computed } from '@angular/core';
import { CommonModule, DecimalPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';
import { LegacyToolbarComponent } from '../../../shared/legacy-ui/legacy-toolbar/legacy-toolbar.component';
import { LegacyStatusBarComponent } from '../../../shared/legacy-ui/legacy-status-bar/legacy-status-bar.component';
import { LegacyToolbarActionId } from '../../../shared/legacy-ui/contracts/legacy-contracts';

type Row = Record<string, unknown>;

@Component({
  selector: 'app-repkhalls',
  imports: [CommonModule, DecimalPipe, DatePipe, FormsModule, LegacyToolbarComponent, LegacyStatusBarComponent],
  templateUrl: './repkhalls.component.html',
  styleUrl: './repkhalls.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RepkhallsComponent {
  private http = inject(HttpClient);
  readonly p = inject(PermissionService).forScreen('REPKHALLS');

  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly rows = signal<Row[]>([]);
  readonly searched = signal(false);
  readonly paramNoa = signal('');
  readonly paramFrom = signal('');
  readonly paramTo = signal('');

  readonly totalMdin = computed(() => this.rows().reduce((s, r) => s + Number(r['MDIN'] ?? 0), 0));
  readonly totalDan = computed(() => this.rows().reduce((s, r) => s + Number(r['DAN'] ?? 0), 0));

  async runReport() {
    this.loading.set(true); this.searched.set(true); this.err.set(null);
    try {
      const w: string[] = [];
      if (this.paramNoa()) w.push('NOA=' + this.paramNoa());
      if (this.paramFrom()) w.push("DATES>=TO_DATE('" + this.paramFrom() + "','YYYY-MM-DD')");
      if (this.paramTo()) w.push("DATES<=TO_DATE('" + this.paramTo() + "','YYYY-MM-DD')");
      const where = w.length ? '&where=' + encodeURIComponent(w.join(' AND ')) : '';
      const r = await firstValueFrom(this.http.get<{ok:boolean;rows:Row[]}>('/api/data/DATAK?limit=500' + where + '&orderBy=NOS DESC'));
      this.rows.set(r.rows || []);
    } catch (e) { this.err.set(e instanceof Error ? e.message : 'خطأ'); this.rows.set([]); }
    this.loading.set(false);
  }

  onToolbarAction(a: LegacyToolbarActionId) {
    if (a === 'search') this.runReport();
    else if (a === 'exit') window.history.back();
    else if (a === 'refresh') this.runReport();
  }

  clearMessages() { this.err.set(null); }
}
