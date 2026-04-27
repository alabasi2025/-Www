import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';
import { LegacyToolbarComponent } from '../../../shared/legacy-ui/legacy-toolbar/legacy-toolbar.component';
import { LegacyStatusBarComponent, type LegacyStatusBadge } from '../../../shared/legacy-ui/legacy-status-bar/legacy-status-bar.component';
import { LegacyPermissionModel, LegacyToolbarActionId } from '../../../shared/legacy-ui/contracts/legacy-contracts';
import { resolveLegacyShortcut } from '../../../shared/legacy-ui/behaviors/legacy-keyboard-map';

interface SmsSettings {
  T_SMS?: number | null;
  INDA_SMS?: number | null;
  NWSMS?: string | null;
  TSMS?: number | null;
  OP?: number | null;
  SMS_TB?: number | null;
  DATESMS?: string | null;
}

interface SmsCounts { ROWS_COUNT?: number; PHONE_COUNT?: number; LONG_COUNT?: number; }
interface SmsRow { CUSTOMERN?: number; PHONENO?: number; CUSTOMERNAME?: string; MS1?: string; MS2?: string; NOAML?: number; NOA?: number; ISSENT?: number; }

@Component({
  selector: 'app-sms',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, DatePipe, LegacyToolbarComponent, LegacyStatusBarComponent],
  templateUrl: './sms.component.html',
  styleUrl: './sms.component.scss',
})
export class SmsComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly perms = inject(PermissionService).forScreen('SMS.FMX');

  readonly settings = signal<SmsSettings>({});
  readonly counts = signal<SmsCounts>({});
  readonly rows = signal<SmsRow[]>([]);
  readonly movementDate = signal<string | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);
  readonly messageType = signal('4');
  readonly messageText = signal('');
  readonly manualText = signal('');
  readonly accountScope = signal('all');
  readonly addDate = signal(false);
  readonly fixedSelection = signal(false);

  readonly permissionModel = computed<LegacyPermissionModel>(() => {
    const p = this.perms();
    return { ...p, ed: p.pr ?? p.ed ?? 0, de: p.pr ?? p.de ?? 0 };
  });
  readonly statusBadges = computed<LegacyStatusBadge[]>(() => [
    { label: `عدد الرسائل: ${Number(this.counts().ROWS_COUNT ?? 0).toLocaleString()}`, icon: 'pi-envelope', variant: 'info' },
    { label: `عدد الحسابات: ${Number(this.counts().PHONE_COUNT ?? 0).toLocaleString()}`, icon: 'pi-users', variant: 'success' },
    { label: `طويلة: ${Number(this.counts().LONG_COUNT ?? 0).toLocaleString()}`, icon: 'pi-align-left', variant: 'warning' },
  ]);

  async ngOnInit(): Promise<void> { await this.refresh(); }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.err.set(null);
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; settings: SmsSettings; counts: SmsCounts; rows: SmsRow[]; movementDate: Record<string, string | null>; error?: string }>('/api/sms-center/summary?limit=250'));
      if (!r.ok) throw new Error(r.error);
      this.settings.set(r.settings ?? {});
      this.counts.set(r.counts ?? {});
      this.rows.set(r.rows ?? []);
      this.movementDate.set(r.movementDate?.['DATESMS'] ?? null);
      this.messageText.set(String(r.settings?.NWSMS ?? ''));
      this.messageType.set(String(Number(r.settings?.TSMS ?? 4) || 4));
      this.addDate.set(Number(r.settings?.OP ?? 0) > 0);
      this.fixedSelection.set(Number(r.settings?.SMS_TB ?? 0) > 0);
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  async saveOptions(): Promise<void> {
    this.saving.set(true);
    this.err.set(null);
    try {
      const r = await firstValueFrom(this.http.put<{ ok: boolean; message?: string; error?: string }>('/api/sms-center/options', {
        TSMS: Number(this.messageType()),
        OP: this.addDate() ? 1 : 0,
        SMS_TB: this.fixedSelection() ? 1 : 0,
        NWSMS: this.messageText(),
      }));
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحفظ');
      await this.refresh();
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.saving.set(false);
    }
  }

  async clearQueue(): Promise<void> {
    if (!confirm('هل أنت متأكد من حذف جميع الرسائل؟')) return;
    this.saving.set(true);
    this.err.set(null);
    try {
      const r = await firstValueFrom(this.http.post<{ ok: boolean; deleted?: number; message?: string; error?: string }>('/api/sms-center/clear', { confirm: 'SMS' }));
      if (!r.ok) throw new Error(r.error);
      this.info.set(`${r.message ?? 'تم الحذف'}: ${Number(r.deleted ?? 0).toLocaleString()}`);
      await this.refresh();
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.saving.set(false);
    }
  }

  onToolbarAction(action: LegacyToolbarActionId): void {
    if (action === 'refresh' || action === 'search') void this.refresh();
    if (action === 'save') void this.saveOptions();
    if (action === 'delete') void this.clearQueue();
    if (action === 'exit') this.clearMessages();
  }

  @HostListener('document:keydown', ['$event'])
  handleLegacyKeys(event: KeyboardEvent): void {
    const shortcut = resolveLegacyShortcut(event, {
      allowWhenInput: { search: true, save: true },
    });
    if (!shortcut || this.saving() || this.loading()) return;

    switch (shortcut) {
      case 'search':
      case 'refresh':
        event.preventDefault();
        void this.refresh();
        break;
      case 'save':
        event.preventDefault();
        void this.saveOptions();
        break;
      case 'exit':
        event.preventDefault();
        this.clearMessages();
        break;
      default:
        break;
    }
  }

  exportNotice(): void {
    this.info.set('تصدير D:\\SMS مسجل من المصدر القديم. لم يتم تشغيل أي تصدير الآن حتى لا نكتب ملفات بدون قصد.');
  }

  internetNotice(): void {
    this.info.set('الإرسال عبر النت في القديم يرسل أرقام هواتف لطرف خارجي. الشاشة الجديدة تعرضه كوظيفة محروسة ولا تنفذه بدون اعتماد تشغيل صريح.');
  }

  clearMessages(): void { this.err.set(null); this.info.set(null); }
}
