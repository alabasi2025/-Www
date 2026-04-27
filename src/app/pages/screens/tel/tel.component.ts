import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';
import { LegacyToolbarComponent } from '../../../shared/legacy-ui/legacy-toolbar/legacy-toolbar.component';
import { LegacyStatusBarComponent, type LegacyStatusBadge } from '../../../shared/legacy-ui/legacy-status-bar/legacy-status-bar.component';
import { LegacyPermissionModel, LegacyToolbarActionId } from '../../../shared/legacy-ui/contracts/legacy-contracts';

interface SupportContact { name: string; city: string; work: string; phone: string; }
interface SupportAction { id: string; label: string; risk: string; }

@Component({
  selector: 'app-tel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, LegacyToolbarComponent, LegacyStatusBarComponent],
  templateUrl: './tel.component.html',
  styleUrl: './tel.component.scss',
})
export class TelComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly perms = inject(PermissionService).forScreen('TEL.FMX');

  readonly contacts = signal<SupportContact[]>([]);
  readonly actions = signal<SupportAction[]>([]);
  readonly titl = signal<Record<string, unknown>>({});
  readonly sessions = signal<Record<string, unknown>>({});
  readonly schema = signal('');
  readonly host = signal('');
  readonly selectedAction = signal('database-update');
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);

  readonly permissionModel = computed<LegacyPermissionModel>(() => {
    const p = this.perms();
    return { ...p, pr: p.pr ?? 0 };
  });
  readonly statusBadges = computed<LegacyStatusBadge[]>(() => [
    { label: this.schema() || 'DATAALA', icon: 'pi-database', variant: 'info' },
    { label: `جلسات: ${Number(this.sessions()['C'] ?? 0).toLocaleString()}`, icon: 'pi-users', variant: 'warning' },
    { label: this.host() || 'الجهاز', icon: 'pi-desktop', variant: 'info' },
  ]);

  async ngOnInit(): Promise<void> { await this.refresh(); }

  @HostListener('document:keydown', ['$event'])
  handleLegacyKeys(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;

    switch (event.key) {
      case 'F10':
        if (!this.saving()) {
          event.preventDefault();
          void this.actionPlan();
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
      const r = await firstValueFrom(this.http.get<{ ok: boolean; contacts: SupportContact[]; actions: SupportAction[]; titl: Record<string, unknown>; sessions: Record<string, unknown>; schema: string; host: string; error?: string }>('/api/support-tools/summary'));
      if (!r.ok) throw new Error(r.error);
      this.contacts.set(r.contacts ?? []);
      this.actions.set(r.actions ?? []);
      this.titl.set(r.titl ?? {});
      this.sessions.set(r.sessions ?? {});
      this.schema.set(r.schema ?? '');
      this.host.set(r.host ?? '');
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally { this.loading.set(false); }
  }

  async actionPlan(action = this.selectedAction()): Promise<void> {
    this.saving.set(true);
    this.err.set(null);
    try {
      const r = await firstValueFrom(this.http.post<{ ok: boolean; message?: string; error?: string }>('/api/support-tools/action-plan', { action }));
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم تجهيز خطة العملية');
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally { this.saving.set(false); }
  }

  onToolbarAction(action: LegacyToolbarActionId): void {
    if (action === 'refresh' || action === 'search') void this.refresh();
    if (action === 'post' || action === 'save') void this.actionPlan();
    if (action === 'exit') this.onExit();
  }

  clearMessages(): void { this.err.set(null); this.info.set(null); }

  onExit(): void {
    void this.router.navigateByUrl('/app');
  }
}
