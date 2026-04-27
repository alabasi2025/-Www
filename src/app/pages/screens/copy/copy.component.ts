import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';
import { type LegacyStatusBadge } from '../../../shared/legacy-ui/legacy-status-bar/legacy-status-bar.component';
import { LegacyPermissionModel, LegacyToolbarActionId } from '../../../shared/legacy-ui/contracts/legacy-contracts';

interface ArchivedYear { YORZC: string; }
interface CopyPlan { commands: string[]; message: string; path: string; }

@Component({
  selector: 'app-copy',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  templateUrl: './copy.component.html',
  styleUrl: './copy.component.scss',
})
export class CopyComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly perms = inject(PermissionService).forScreen('COPY.FMX');

  readonly path = signal('D:\\DATY\\COPYDATAALA.Dmp');
  readonly host = signal('');
  readonly schema = signal('');
  readonly archivedYears = signal<ArchivedYear[]>([]);
  readonly includeArchived = signal(false);
  readonly plan = signal<CopyPlan | null>(null);
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
    { label: `${this.archivedYears().length} سنوات مقفلة`, icon: 'pi-calendar', variant: this.archivedYears().length ? 'success' : 'warning' },
    { label: this.host() || 'الجهاز', icon: 'pi-desktop', variant: 'info' },
  ]);

  async ngOnInit(): Promise<void> { await this.refresh(); }

  @HostListener('document:keydown', ['$event'])
  handleLegacyKeys(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;

    switch (event.key) {
      case 'F6':
      case 'F10':
        if (!this.saving()) {
          event.preventDefault();
          void this.buildPlan();
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
      const r = await firstValueFrom(this.http.get<{ ok: boolean; defaultPath: string; host: string; schema: string; archivedYears: ArchivedYear[]; error?: string }>('/api/legacy-copy/summary'));
      if (!r.ok) throw new Error(r.error);
      this.schema.set(r.schema || '');
      const fallbackPath = this.legacyDefaultPath(r.schema || 'DATAALA');
      const defaultPath = String(r.defaultPath || '').trim();
      this.path.set(defaultPath.toUpperCase().includes('COPY') ? defaultPath : fallbackPath);
      this.host.set(r.host || '');
      this.archivedYears.set(r.archivedYears ?? []);
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally { this.loading.set(false); }
  }

  async buildPlan(): Promise<void> {
    this.saving.set(true);
    this.err.set(null);
    try {
      const r = await firstValueFrom(this.http.post<{ ok: boolean; commands: string[]; message: string; path: string; error?: string }>('/api/legacy-copy/plan', {
        path: this.path(),
        includeArchived: this.includeArchived(),
      }));
      if (!r.ok) throw new Error(r.error);
      this.plan.set({ commands: r.commands ?? [], message: r.message, path: r.path });
      this.info.set(r.message);
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally { this.saving.set(false); }
  }

  executeNotice(): void {
    this.info.set('عمل نسخة احتياطية في القديم يشغل Host/Exp على الجهاز الرئيسي. هنا تم تجهيز الخطة فقط ولم يتم تشغيل أي أمر.');
  }

  onToolbarAction(action: LegacyToolbarActionId): void {
    if (action === 'refresh' || action === 'search') void this.refresh();
    if (action === 'print' || action === 'export') void this.buildPlan();
    if (action === 'exit') this.onExit();
  }

  clearMessages(): void { this.err.set(null); this.info.set(null); }

  onExit(): void { void this.router.navigate(['/app']); }

  private legacyDefaultPath(schema: string): string {
    const cleanSchema = (schema || 'DATAALA').replace(/[^A-Za-z0-9_]/g, '') || 'DATAALA';
    return `D:\\DATY\\COPY${cleanSchema}.Dmp`;
  }
}
