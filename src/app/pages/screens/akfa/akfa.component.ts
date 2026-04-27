import {
  Component, OnInit, signal, computed, inject, ChangeDetectionStrategy, HostListener,
} from '@angular/core';
import { CommonModule, DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuditCardComponent } from '../../../shared/audit-card/audit-card.component';
import { ActionToolbarComponent, type ToolbarAction } from '../../../shared/action-toolbar/action-toolbar.component';
import { StatusStripComponent, type StatusBadge } from '../../../shared/status-strip/status-strip.component';
import { PermissionService } from '../../../services/permission.service';

// ── Types ─────────────────────────────────────────────────

/** Server-returned balance candidate — one foreign-currency account with a non-zero balance. */
interface Candidate {
  NOA:         number;
  NAMEA:       string | null;
  NOAML:       number;
  NOAML_NAME:  string | null;
  AMLH_SARS:   number;   // current exchange rate from AMLH
  MRT:         number;
  RSEDHY:      number;   // book balance (local)
  RSEDHA:      number;   // balance (foreign)
}

/**
 * A line in the closing entry — based on AKFAF schema.
 *
 * Computed fields:
 *   RSEDHYB = RSEDHA * SARSF     (balance valued at current rate)
 *   FARK    = RSEDHYB - RSEDHY   (revaluation gain/loss; signed)
 *     FARK > 0 → currency account is credited (DAN = FARK)
 *     FARK < 0 → currency account is debited  (MDIN = |FARK|)
 */
interface AkfafRow {
  RECNO?:   number;
  NOA:      number;
  NAMEA:    string | null;
  NOAML:    number;
  NOAML_NAME: string | null;
  SARSF:    number;      // revaluation rate (editable)
  MDIN:     number;      // computed from FARK
  DAN:      number;      // computed from FARK
  NOA2:     number;      // system clearing account
  MEMOS:    string | null;
  MEMOS2:   string | null;
  MRT:      number;
  TY:       number;      // 0 = unchecked, 1 = include in closure
  TF?:      number;
  FARK:     number;      // signed difference
  RSEDHY:   number;      // book balance
  RSEDHA:   number;      // foreign balance
  RSEDHYB:  number;      // valued balance
  _initialSars?: number; // original AMLH rate (for reset/highlight)
}

interface AkfaMaster {
  NOS?:   number;
  NOSON?: number;
  DATES?: string;
  NOK?:   number;
  NOUSX?: number;
  DI?:    string;
  PCI?:   string;
  TIN?:   string;
}

interface AkfaListRow {
  NOS:   number;
  NOSON: number | null;
  DATES: string;
  NOK:   number | null;
  LINES: number;
  NOUSX: number | null;
}

@Component({
  selector: 'app-akfa',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, DatePipe, DecimalPipe,
    AuditCardComponent, ActionToolbarComponent, StatusStripComponent,
  ],
  templateUrl: './akfa.component.html',
  styleUrl: './akfa.component.scss',
})
export class AkfaComponent implements OnInit {
  private http = inject(HttpClient);
  private permSvc = inject(PermissionService);
  private router = inject(Router);

  readonly screenCode = 'AKFA.FMX';

  // ── Permissions ─────────────────────────────────────
  private readonly perms = computed(() => this.permSvc.forScreen(this.screenCode)());
  readonly canIns = computed(() => (this.perms()?.ins ?? 0) > 0);
  readonly canEd  = computed(() => (this.perms()?.ed  ?? 0) > 0);
  readonly canDe  = computed(() => (this.perms()?.de  ?? 0) > 0);

  // ── State ────────────────────────────────────────────
  readonly rows     = signal<AkfaListRow[]>([]);
  readonly master   = signal<AkfaMaster>({});
  readonly details  = signal<AkfafRow[]>([]);
  readonly mode     = signal<'browse' | 'new' | 'edit'>('browse');
  readonly loading  = signal(false);
  readonly saving   = signal(false);
  readonly fetching = signal(false);   // fetching candidates
  readonly err      = signal<string | null>(null);
  readonly info     = signal<string | null>(null);
  readonly search   = signal('');

  /** Clearing account resolved from server (SUBSTR(NOA,1,1)='4' AND THSYSTEM=1). */
  readonly clearingNoa   = signal<number | null>(null);
  readonly clearingName  = signal<string | null>(null);

  // ── Derived ──────────────────────────────────────────
  readonly editable = computed(() => this.mode() !== 'browse');
  readonly activeRows = computed(() => this.details().filter(d => d.TY === 1));
  readonly totalMdin  = computed(() =>
    this.activeRows().reduce((s, d) => s + Number(d.MDIN || 0), 0));
  readonly totalDan   = computed(() =>
    this.activeRows().reduce((s, d) => s + Number(d.DAN  || 0), 0));
  readonly netFark    = computed(() => this.totalDan() - this.totalMdin());

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) return this.rows();
    return this.rows().filter(r =>
      String(r.NOS).includes(q) ||
      String(r.NOSON ?? '').includes(q) ||
      (r.DATES ?? '').toLowerCase().includes(q)
    );
  });

  onExit(): void {
    void this.router.navigateByUrl('/app');
  }

  readonly currentIdx = computed(() => {
    const nos = this.master().NOS;
    if (!nos) return -1;
    return this.rows().findIndex(r => r.NOS === nos);
  });

  readonly statusBadges = computed<StatusBadge[]>(() => {
    const m = this.master();
    const out: StatusBadge[] = [];
    if (m.NOSON) out.push({ label: `مسلسل: ${m.NOSON}`, icon: 'pi-hashtag', variant: 'info' });
    if (m.NOS)   out.push({ label: `رقم داخلي: ${m.NOS}`, icon: 'pi-key', variant: 'info' });
    if (m.NOK)   out.push({ label: `رقم القيد: ${m.NOK}`, icon: 'pi-link', variant: 'success' });
    if (m.DATES) {
      const d = new Date(String(m.DATES));
      if (!isNaN(d.getTime())) {
        out.push({
          label: d.toLocaleDateString('ar-EG', { year: 'numeric', month: '2-digit', day: '2-digit' }),
          icon: 'pi-calendar', variant: 'info',
        });
      }
    }
    const n = this.activeRows().length;
    if (n > 0) out.push({ label: `${n} حساب مشمول`, icon: 'pi-list', variant: 'info' });
    return out;
  });

  clearMessages(): void { this.err.set(null); this.info.set(null); }

  // ── Lifecycle ────────────────────────────────────────
  async ngOnInit(): Promise<void> {
    await Promise.all([this.fetchList(), this.fetchClearingAccount()]);
  }

  @HostListener('document:keydown', ['$event'])
  handleLegacyKeys(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;

    switch (event.key) {
      case 'F2':
        if (this.canIns() && !this.editable() && !this.saving()) {
          event.preventDefault();
          this.onNew();
        }
        break;
      case 'F10':
        if (this.editable() && !this.saving()) {
          event.preventDefault();
          void this.onSave();
        } else if (this.canIns() && !this.editable() && !this.saving()) {
          event.preventDefault();
          this.onNew();
        }
        break;
      case 'F7':
        if (this.editable() && !this.saving()) {
          event.preventDefault();
          this.onCancel();
        }
        break;
      case 'F8':
        if (this.canEd() && this.master().NOS && !this.editable() && !this.saving()) {
          event.preventDefault();
          this.onEdit();
        }
        break;
      case 'F6':
        if (this.canDe() && this.master().NOS && !this.editable() && !this.saving()) {
          event.preventDefault();
          void this.onDelete();
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

  // ── Server calls ─────────────────────────────────────
  async fetchList(): Promise<void> {
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: AkfaListRow[]; error?: string }>('/api/journal/akfa/list?limit=200'),
      );
      if (!r.ok) throw new Error(r.error);
      this.rows.set(r.rows ?? []);
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.loading.set(false);
  }

  async fetchClearingAccount(): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; noa?: number; namea?: string; error?: string }>(
          '/api/journal/akfa/clearing-account',
        ),
      );
      if (!r.ok) {
        this.clearingNoa.set(null);
        this.clearingName.set(null);
        // Don't set err() here — it's a warning, shown as a banner instead.
        return;
      }
      this.clearingNoa.set(r.noa ?? null);
      this.clearingName.set(r.namea ?? null);
    } catch { /* silent */ }
  }

  async openRow(nos: number): Promise<void> {
    this.loading.set(true); this.err.set(null);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; master: Record<string, unknown>; details: Record<string, unknown>[]; error?: string }>(
          `/api/journal/akfa?nos=${nos}`,
        ),
      );
      if (!r.ok) throw new Error(r.error);
      const m = r.master ?? {};
      this.master.set({
        NOS:   Number(m['NOS']),
        NOSON: m['NOSON'] == null ? undefined : Number(m['NOSON']),
        DATES: m['DATES'] ? String(m['DATES']) : undefined,
        NOK:   m['NOK']   == null ? undefined : Number(m['NOK']),
        NOUSX: m['NOUSX'] == null ? undefined : Number(m['NOUSX']),
        DI:    m['DI']  ? String(m['DI'])  : undefined,
        PCI:   (m['PCI'] as string | undefined) ?? undefined,
        TIN:   (m['TIN'] as string | undefined) ?? undefined,
      });
      const rows: AkfafRow[] = (r.details ?? []).map(d => ({
        RECNO:      Number(d['RECNO'] ?? 0),
        NOA:        Number(d['NOA']),
        NAMEA:      (d['NAMEA'] as string | null) ?? null,
        NOAML:      Number(d['NOAML']  ?? 1),
        NOAML_NAME: (d['NOAML_NAME'] as string | null) ?? null,
        SARSF:      Number(d['SARSF']  ?? 1),
        MDIN:       Number(d['MDIN']   ?? 0),
        DAN:        Number(d['DAN']    ?? 0),
        NOA2:       Number(d['NOA2']),
        MEMOS:      (d['MEMOS']  as string | null) ?? null,
        MEMOS2:     (d['MEMOS2'] as string | null) ?? null,
        MRT:        Number(d['MRT']     ?? 0),
        TY:         Number(d['TY']      ?? 1),
        TF:         Number(d['TF']      ?? 0),
        FARK:       Number(d['FARK']    ?? 0),
        RSEDHY:     Number(d['RSEDHY']  ?? 0),
        RSEDHA:     Number(d['RSEDHA']  ?? 0),
        RSEDHYB:    Number(d['RSEDHYB'] ?? 0),
      }));
      this.details.set(rows);
      this.mode.set('browse');
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.loading.set(false);
  }

  /**
   * Fetch the current foreign-currency balances as of the master DATES and
   * populate the details grid with TY=0 (unchecked). The user then reviews
   * exchange rates and ticks rows to include in the closure.
   */
  async fetchCandidates(): Promise<void> {
    const date = this.master().DATES;
    if (!date) { this.err.set('يجب إدخال التاريخ قبل جلب الأرصدة'); return; }
    const clearingNoa = this.clearingNoa();
    if (!clearingNoa) {
      this.err.set('لم يتم ضبط حساب فروقات العملة في دليل الحسابات');
      return;
    }
    this.fetching.set(true); this.err.set(null);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: Candidate[]; error?: string }>(
          `/api/journal/akfa/candidates?date=${encodeURIComponent(date)}`,
        ),
      );
      if (!r.ok) throw new Error(r.error);
      if (!r.rows.length) {
        this.details.set([]);
        this.info.set('لا توجد حسابات بأرصدة عملة أجنبية حتى هذا التاريخ');
        return;
      }
      const rows: AkfafRow[] = r.rows.map(c => this.makeLineFromCandidate(c, clearingNoa));
      this.details.set(rows);
      this.info.set(`تم جلب ${rows.length} حساب — راجع أسعار الصرف واختر الحسابات المطلوب إقفالها`);
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.fetching.set(false);
  }

  /** Build an AKFAF line from a Candidate using the AMLH exchange rate. */
  private makeLineFromCandidate(c: Candidate, clearingNoa: number): AkfafRow {
    const sars    = Number(c.AMLH_SARS) || 1;
    const rsedhy  = Number(c.RSEDHY)    || 0;
    const rsedha  = Number(c.RSEDHA)    || 0;
    const rsedhyb = +(rsedha * sars).toFixed(2);
    const fark    = +(rsedhyb - rsedhy).toFixed(2);
    const { MDIN, DAN } = this.amountsFromFark(fark);
    return {
      NOA:        Number(c.NOA),
      NAMEA:      c.NAMEA ?? null,
      NOAML:      Number(c.NOAML),
      NOAML_NAME: c.NOAML_NAME ?? null,
      SARSF:      sars,
      MDIN, DAN,
      NOA2:       clearingNoa,
      MEMOS:      this.buildMemos(fark, sars, /*side*/ 1, c.NAMEA),
      MEMOS2:     this.buildMemos(fark, sars, /*side*/ 2, c.NAMEA),
      MRT:        Number(c.MRT) || 0,
      TY:         0,
      TF:         0,
      FARK:       fark,
      RSEDHY:     rsedhy,
      RSEDHA:     rsedha,
      RSEDHYB:    rsedhyb,
      _initialSars: sars,
    };
  }

  private amountsFromFark(fark: number): { MDIN: number; DAN: number } {
    if (Math.abs(fark) < 0.005) return { MDIN: 0, DAN: 0 };
    return fark > 0
      ? { MDIN: 0,               DAN: +fark.toFixed(2) }
      : { MDIN: +Math.abs(fark).toFixed(2), DAN: 0 };
  }

  private buildMemos(fark: number, sars: number, side: 1 | 2, accName: string | null): string {
    if (Math.abs(fark) < 0.005) return '';
    if (side === 1) {
      return fark > 0
        ? ` قيد دائن فوارق عملة سعر صرف ${sars}`
        : `قيد مدين  فوارق عملة سعر صرف ${sars}`;
    }
    const prefix = fark > 0 ? 'عليكم فارق عملة' : 'لكم فارق عملة';
    return `${prefix}  ${accName ?? ''} سعر صرف ${sars}`;
  }

  // ── Row editing ──────────────────────────────────────
  toggleRow(idx: number): void {
    if (!this.editable()) return;
    this.details.update(rows => {
      const next = [...rows];
      const r = next[idx];
      if (!r) return rows;
      next[idx] = { ...r, TY: r.TY === 1 ? 0 : 1 };
      return next;
    });
  }

  toggleAll(checked: boolean): void {
    if (!this.editable()) return;
    this.details.update(rows =>
      rows.map(r => ({ ...r, TY: (checked && Math.abs(r.FARK) >= 0.005) ? 1 : 0 })),
    );
  }

  /** User overrides the rate — recompute RSEDHYB and FARK, refresh MDIN/DAN/memos. */
  onRateChange(idx: number, sarsf: number): void {
    if (!this.editable()) return;
    this.details.update(rows => {
      const next = [...rows];
      const r = next[idx];
      if (!r) return rows;
      const newSars = +sarsf || 1;
      const rsedhyb = +(r.RSEDHA * newSars).toFixed(2);
      const fark    = +(rsedhyb - r.RSEDHY).toFixed(2);
      const { MDIN, DAN } = this.amountsFromFark(fark);
      next[idx] = {
        ...r,
        SARSF: newSars,
        RSEDHYB: rsedhyb,
        FARK: fark,
        MDIN, DAN,
        MEMOS:  this.buildMemos(fark, newSars, 1, r.NAMEA),
        MEMOS2: this.buildMemos(fark, newSars, 2, r.NAMEA),
      };
      return next;
    });
  }

  onMemoChange(idx: number, field: 'MEMOS' | 'MEMOS2', value: string): void {
    if (!this.editable()) return;
    this.details.update(rows => {
      const next = [...rows];
      const r = next[idx];
      if (!r) return rows;
      next[idx] = { ...r, [field]: value };
      return next;
    });
  }

  // ── Navigation ──────────────────────────────────────
  navTo(target: 'first' | 'last' | number): void {
    const list = this.rows();
    if (!list.length) return;
    const idx = this.currentIdx();
    let next = 0;
    if (target === 'first') next = 0;
    else if (target === 'last') next = list.length - 1;
    else next = Math.min(list.length - 1, Math.max(0, idx + (target as number)));
    const row = list[next];
    if (row) void this.openRow(row.NOS);
  }

  // ── Mode transitions ─────────────────────────────────
  onNew(): void {
    this.master.set({ DATES: new Date().toISOString().slice(0, 10) });
    this.details.set([]);
    this.mode.set('new');
    this.err.set(null); this.info.set(null);
  }

  onEdit(): void {
    if (!this.master().NOS) return;
    this.mode.set('edit');
  }

  onCancel(): void {
    this.mode.set('browse');
    this.err.set(null);
    const nos = this.master().NOS;
    if (nos) void this.openRow(nos);
    else { this.master.set({}); this.details.set([]); }
  }

  patchMaster(patch: Partial<AkfaMaster>): void {
    this.master.update(m => ({ ...m, ...patch }));
  }

  // ── Save / Delete ───────────────────────────────────
  validate(): boolean {
    const m = this.master();
    if (!m.DATES) { this.err.set('يجب إدخال التاريخ'); return false; }
    const active = this.activeRows();
    if (!active.length) {
      this.err.set('يجب اختيار حساب واحد على الأقل بوضع علامة ✓');
      return false;
    }
    for (const d of active) {
      if (!d.NOA2) {
        this.err.set('حساب فروقات العملة (المقابل) غير محدد');
        return false;
      }
      if (Number(d.MDIN || 0) <= 0 && Number(d.DAN || 0) <= 0) {
        this.err.set(`الحساب ${d.NAMEA ?? d.NOA} بدون فارق — يجب إلغاء تحديده`);
        return false;
      }
    }
    return true;
  }

  async onSave(): Promise<void> {
    if (!this.validate()) return;
    this.saving.set(true); this.err.set(null);
    try {
      const payload = { master: this.master(), details: this.details() };
      const verb = this.mode() === 'edit' ? 'PUT' : 'POST';
      const r = await firstValueFrom(
        this.http.request<{
          ok: boolean; message?: string; error?: string; nos?: number; nok?: number; rows?: number;
        }>(verb, '/api/journal/akfa', { body: payload }),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(`${r.message ?? 'تم الحفظ'} — ${r.rows ?? 0} حساب، قيد ${r.nok ?? ''}`);
      const targetNos = r.nos ?? this.master().NOS;
      this.mode.set('browse');
      await this.fetchList();
      if (targetNos) await this.openRow(targetNos);
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  async onDelete(): Promise<void> {
    const nos = this.master().NOS;
    if (!nos) return;
    if (!confirm(`هل أنت متأكد من حذف قيد إقفال رقم ${nos}؟\n\nسيتم حذف جميع سطور الإقفال وأثرها على الحسابات.`)) return;
    this.saving.set(true); this.err.set(null);
    try {
      const r = await firstValueFrom(
        this.http.delete<{ ok: boolean; message?: string; error?: string }>(
          `/api/journal/akfa?nos=${nos}`,
        ),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحذف');
      this.master.set({}); this.details.set([]);
      this.mode.set('browse');
      await this.fetchList();
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
    this.saving.set(false);
  }

  async jumpByNoson(noson: number): Promise<void> {
    const year = Number(String(this.master().DATES ?? new Date().toISOString()).slice(0, 4));
    if (!noson || !year) return;
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; nos?: number; error?: string }>(
          `/api/journal/akfa/by-noson?noson=${noson}&year=${year}`,
        ),
      );
      if (!r.ok || !r.nos) { this.info.set(`لا يوجد قيد بمسلسل ${noson} لعام ${year}`); return; }
      await this.openRow(r.nos);
    } catch (e) { this.err.set(e instanceof Error ? e.message : String(e)); }
  }

  onPrint(): void { this.info.set('الطباعة غير متوفرة حالياً'); }

  onToolbarAction(a: ToolbarAction): void {
    switch (a) {
      case 'new':     this.onNew(); break;
      case 'edit':    this.onEdit(); break;
      case 'delete':  void this.onDelete(); break;
      case 'save':    void this.onSave(); break;
      case 'cancel':  this.onCancel(); break;
      case 'refresh': void this.fetchList(); break;
      case 'print':   this.onPrint(); break;
      default: break;
    }
  }

  // ── Template helpers ─────────────────────────────────
  asStr(v: unknown): string { return String(v ?? ''); }

  readonly masterAsRecord = computed<Record<string, unknown>>(() =>
    this.master() as unknown as Record<string, unknown>,
  );

  /** Deterministic trackBy to keep rows stable while user edits rates. */
  trackByNoa = (_idx: number, row: AkfafRow): string => `${row.NOA}-${row.NOAML}-${row.MRT}`;

  /** Flag rows where the rate was adjusted away from AMLH (for UI highlighting). */
  isRateOverridden(row: AkfafRow): boolean {
    if (row._initialSars == null) return false;
    return Math.abs(row.SARSF - row._initialSars) >= 0.0001;
  }

  /** Template helper — Math.abs is not accessible in Angular templates by default. */
  abs(v: number): number { return Math.abs(v); }

  /** Template helper — check if a difference is "effectively zero" (< 0.005). */
  isZeroFark(v: number): boolean { return Math.abs(v) < 0.005; }
}
