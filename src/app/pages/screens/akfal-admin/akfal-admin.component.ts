import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';
import { LegacyStatusBarComponent, type LegacyStatusBadge } from '../../../shared/legacy-ui/legacy-status-bar/legacy-status-bar.component';
import { LegacyPermissionModel } from '../../../shared/legacy-ui/contracts/legacy-contracts';

interface PreflightCheck { label: string; pass: boolean; detail: string; }

@Component({
  selector: 'app-akfal-admin',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, LegacyStatusBarComponent],
  templateUrl: './akfal-admin.component.html',
  styleUrl: './akfal-admin.component.scss',
})
export class AkfalAdminComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly perms = inject(PermissionService).forScreen('AKFAL.FMX');
  private readonly router = inject(Router);

  readonly summary = signal<Record<string, Record<string, unknown>>>({});
  readonly checks = signal<PreflightCheck[]>([]);
  readonly kind = signal<'day' | 'month' | 'year'>('day');
  readonly dayDate = signal('');
  readonly month = signal('');
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);

  readonly permissionModel = computed<LegacyPermissionModel>(() => {
    const p = this.perms();
    return { ...p, pr: p.pr ?? 0, post: p.pr ?? 0, unpost: p.pr ?? 0 };
  });
  readonly activeYear = computed(() => Number(this.summary()['activeYear']?.['YEARZ'] ?? 0));
  readonly statusBadges = computed<LegacyStatusBadge[]>(() => [
    { label: `السنة: ${this.activeYear() || '-'}`, icon: 'pi-calendar', variant: 'info' },
    { label: `أيام مقفلة: ${Number(this.summary()['lockedDays']?.['C'] ?? 0).toLocaleString()}`, icon: 'pi-lock', variant: 'success' },
    { label: `أشهر مقفلة: ${Number(this.summary()['lockedMonths']?.['C'] ?? 0).toLocaleString()}`, icon: 'pi-list', variant: 'info' },
  ]);

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  @HostListener('document:keydown', ['$event'])
  handleLegacyKeys(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;

    switch (event.key) {
      case 'F10':
        if (!this.saving()) {
          event.preventDefault();
          void this.preflight();
        }
        break;
      case 'Escape':
        event.preventDefault();
        this.clearMessages();
        break;
      default:
        break;
    }
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.err.set(null);
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; error?: string } & Record<string, Record<string, unknown>>>('/api/system-closures/summary'));
      if (!r.ok) throw new Error(r.error);
      this.summary.set(r);
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally { this.loading.set(false); }
  }

  async preflight(): Promise<void> {
    this.saving.set(true);
    this.err.set(null);
    try {
      const params = new URLSearchParams({ kind: this.kind() });
      if (this.kind() === 'day') params.set('date', this.dayDate());
      if (this.kind() === 'month') params.set('month', this.month());
      const r = await firstValueFrom(this.http.get<{ ok: boolean; checks: PreflightCheck[]; yearz: number; error?: string }>(`/api/system-closures/preflight?${params}`));
      if (!r.ok) throw new Error(r.error);
      this.checks.set(r.checks ?? []);
      this.info.set('تم فحص شروط الشاشة القديمة بدون تنفيذ اقفال أو الغاء اقفال.');
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally { this.saving.set(false); }
  }

  async runLegacyAction(kind: 'day' | 'month' | 'year'): Promise<void> {
    this.kind.set(kind);
    await this.preflight();
  }

  actionNotice(label: string): void {
    this.info.set(`${label}: العملية موجودة في واجهة القديم، لكن التنفيذ الفعلي محروس. تم الاكتفاء بفحص الشروط حتى لا نقفل أو نلغي اقفال بيانات بالخطأ.`);
  }

  onExit(): void { void this.router.navigateByUrl('/app'); }

  clearMessages(): void { this.err.set(null); this.info.set(null); }
}
