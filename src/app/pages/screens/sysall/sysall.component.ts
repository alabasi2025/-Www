import {
  Component, OnInit, ChangeDetectionStrategy, signal, computed, inject, HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

/**
 * TITL row shape — only the fields exposed by the SYSALL screen. Numeric
 * flags use `number` (0 when unset) and textual ones use `string` (empty
 * when unset). Field names mirror the Oracle column names so the PUT
 * payload needs no re-mapping.
 */
interface TitlForm {
  // Tab 1 — خيارات عامة (field names confirmed from SYSALL.fmb binary)
  KY: number; IHSAB: number; INSDS: number; AMLH1: number;
  MRT: number; MRT2: number; T_MRT_U: number; SANDT: number; TTSFIR: number; P_R_SNDK: number;
  INDATE: number; QXZ: number; PCS: string; TSYS: number; NOG: number;

  // Tab 2 — الترويسة والتذييل
  N1: string;  N2: string;  N3: string;  N4: string;
  NA1: string; NA2: string; NA3: string; NA4: string;
  NF1: string; NF2: string; NF3: string; NF4: string;
  TAHD: number;
  MEMO: string; MEMO2: string; MEWAEL: string;
  CLR: number; C1: number; C2: number; C3: number; C4: number; CB: number;

  // Tab 3 — سندات القبض والصرف
  NOSMM: number; NOSMMS: number;
  CBK: string;   CBS: string;
  TBK: number;   TBS: number;

  // Tab 4 — نظام الرسائل
  TSMS: number;  T_SMS: number;  INDA_SMS: number; SMS_SRB: number;
  NWSMS: string; V_PDF: string;

  // Tab 5 — النسخ الاحتياطي
  NAME_COPY1: string; NAME_COPY2: string;
  TIM_COPY: number;   DEL_COPY: number;
}

const EMPTY_FORM: TitlForm = {
  KY: 0, IHSAB: 0, INSDS: 0, AMLH1: 0,
  MRT: 0, MRT2: 0, T_MRT_U: 0, SANDT: 0, TTSFIR: 0, P_R_SNDK: 0,
  INDATE: 0, QXZ: 0, PCS: '', TSYS: 0, NOG: 0,
  N1: '',  N2: '',  N3: '',  N4: '',
  NA1: '', NA2: '', NA3: '', NA4: '',
  NF1: '', NF2: '', NF3: '', NF4: '',
  TAHD: 0,
  MEMO: '', MEMO2: '', MEWAEL: '',
  CLR: 0, C1: 0, C2: 0, C3: 0, C4: 0, CB: 0,
  NOSMM: 1, NOSMMS: 1,
  CBK: '', CBS: '',
  TBK: 0, TBS: 0,
  TSMS: 0, T_SMS: 0, INDA_SMS: 0, SMS_SRB: 0,
  NWSMS: '', V_PDF: '',
  NAME_COPY1: '', NAME_COPY2: '',
  TIM_COPY: 0, DEL_COPY: 0,
};

type TabKey = 'general' | 'header' | 'vouchers' | 'sms' | 'backup';

interface TabDef {
  key: TabKey;
  label: string;
}

/** Order matches the Oracle Forms tabs right-to-left. */
const TABS: readonly TabDef[] = [
  { key: 'general',  label: 'خيارات عامة' },
  { key: 'header',   label: 'الترويسة والتذييل' },
  { key: 'vouchers', label: 'خيارات سندات القبض والصرف' },
  { key: 'sms',      label: 'نظام الرسائل' },
  { key: 'backup',   label: 'خيارات النسخ الاحتياطي' },
];

const COLOR_FIELDS = ['C1', 'C2', 'C3', 'C4', 'CB'] as const;
type ColorField = typeof COLOR_FIELDS[number];

interface TitlSaveResponse {
  ok: boolean;
  message?: string;
  error?: string;
  titl?: Partial<TitlForm>;
  warnings?: string[];
}

/**
 * SYSALL — شاشة الإعدادات العامة.
 *
 * Direct translation of the Oracle Forms `SYSALL.fmb` canvas. The form
 * reads/writes a single row of the `TITL` table. Layout mirrors the
 * original five tabs (right-to-left):
 *   1. خيارات عامة
 *   2. الترويسة والتذييل
 *   3. خيارات سندات القبض والصرف
 *   4. نظام الرسائل
 *   5. خيارات النسخ الاحتياطي
 *
 * Visual language follows the same Forms-6i "legacy" palette used by
 * {@link SndkdComponent} (light-blue chrome, panel borders, 12px Tahoma,
 * .ico toolbar buttons). The save/exit actions are gated by admin rights
 * (`STATU > 0`) on both the UI (hidden for non-admins) and the server
 * (`PUT /api/titl` rejects non-admin callers).
 */
@Component({
  selector: 'app-sysall',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  templateUrl: './sysall.component.html',
  styleUrl: './sysall.component.scss',
})
export class SysallComponent implements OnInit {
  private http = inject(HttpClient);
  private router = inject(Router);

  /** Available tabs (exposed to the template for rendering the header). */
  readonly tabs = TABS;

  /** Currently active tab — defaults to the first one like Forms does. */
  readonly active = signal<TabKey>('general');

  /** Working copy of the row — mutated by every user keystroke. */
  readonly form = signal<TitlForm>({ ...EMPTY_FORM });

  /** Snapshot taken on load/save; used by the "تراجع" button. */
  private pristine = signal<TitlForm>({ ...EMPTY_FORM });

  readonly loading = signal<boolean>(false);
  readonly saving  = signal<boolean>(false);
  readonly err  = signal<string | null>(null);
  readonly info = signal<string | null>(null);

  /** Admin gate — hide the save button for non-admins. */
  readonly isAdmin = signal<boolean>(false);

  /** Dirty flag — cheap shallow compare over the flat record. */
  readonly dirty = computed(() => {
    const a = this.form(); const b = this.pristine();
    for (const k of Object.keys(a) as (keyof TitlForm)[])
      if (a[k] !== b[k]) return true;
    return false;
  });

  /** SYSALL.SANDT in the old form is forced to 0 when TSYS=2. */
  readonly sandtLockedBySystem = computed(() => Number(this.form().TSYS ?? 0) === 2);

  ngOnInit(): void { void this.load(); }

  /** Check session + TITL row in parallel. */
  async load(): Promise<void> {
    this.loading.set(true); this.err.set(null); this.info.set(null);
    try {
      const [me, res] = await Promise.all([
        firstValueFrom(this.http.get<{ ok: boolean; user?: { isAdmin?: boolean } }>('/api/me')),
        firstValueFrom(this.http.get<{ ok: boolean; titl?: Partial<TitlForm>; error?: string }>('/api/titl')),
      ]);
      this.isAdmin.set(!!me.user?.isAdmin);
      if (!res.ok) { this.err.set(res.error || 'فشل تحميل الإعدادات'); return; }

      const merged = this.normalizeForDisplay({ ...EMPTY_FORM, ...(res.titl ?? {}) } as TitlForm);
      this.form.set(merged);
      this.pristine.set({ ...merged });
    } catch (e) {
      this.err.set((e as Error).message || 'فشل تحميل الإعدادات');
    } finally {
      this.loading.set(false);
    }
  }

  /** Switch the active tab (no data side-effects). */
  setTab(tab: TabKey): void { this.active.set(tab); }

  /** Mutate one field in-place on the working copy. */
  update<K extends keyof TitlForm>(key: K, value: TitlForm[K]): void {
    this.form.update(f => ({ ...f, [key]: value }));
  }

  onSandtChange(checked: boolean): void {
    this.clearMessages();
    if (this.sandtLockedBySystem()) {
      this.update('SANDT', 0);
      this.info.set('النظام الفرعي الحالي يفرض الترحيل الآلي كما في النظام القديم');
      return;
    }
    this.update('SANDT', checked ? 1 : 0);
  }

  onColorChange(key: ColorField, value: unknown): void {
    const next = Number(value);
    this.update(key, (Number.isFinite(next) && next > 0 ? next : 1) as TitlForm[ColorField]);
  }

  onVoucherSequenceChange(key: 'NOSMM' | 'NOSMMS', value: unknown): void {
    const next = Number(value);
    this.update(key, (Number.isFinite(next) && next > 0 ? next : 1) as TitlForm['NOSMM']);
  }

  /**
   * Read a text field by its dynamic name (e.g. `N1`, `NA2`, `NF3`). Used
   * by the header/footer tab to render the three families of title lines
   * without repeating the same markup twelve times.
   */
  getStr(key: string): string {
    const v = (this.form() as unknown as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : '';
  }

  /**
   * Update one of the dynamic-name text fields (`${prefix}${i}`). Invalid
   * keys are silently ignored so the template never blows up if a value
   * is typo'd.
   */
  onDynStr(prefix: 'N' | 'NA' | 'NF', i: number, value: string): void {
    const key = `${prefix}${i}` as keyof TitlForm;
    if (!(key in EMPTY_FORM)) return;
    this.form.update(f => ({ ...f, [key]: value }));
  }

  /**
   * Admin-only save. Sends the minimal diff (`cur[k] !== old[k]`) to keep
   * writes small and to preserve any legacy columns we don't expose here.
   */
  async save(): Promise<void> {
    if (!this.isAdmin()) { this.err.set('هذه العملية تتطلب صلاحية مدير النظام'); return; }

    const normalized = this.normalizeBeforeSave(this.form());
    this.form.set(normalized);
    if (!this.dirty())   { this.info.set('لا توجد تعديلات للحفظ'); return; }

    this.saving.set(true); this.err.set(null); this.info.set(null);
    try {
      const diff: Partial<TitlForm> = {};
      const cur = this.form(); const old = this.pristine();
      for (const k of Object.keys(cur) as (keyof TitlForm)[])
        if (cur[k] !== old[k]) (diff as Record<string, unknown>)[k] = cur[k];

      const res = await firstValueFrom(
        this.http.put<TitlSaveResponse>('/api/titl', diff));
      if (!res.ok) { this.err.set(res.error || 'فشل الحفظ'); return; }

      const saved = this.normalizeForDisplay({ ...this.form(), ...(res.titl ?? {}) } as TitlForm);
      this.form.set(saved);
      this.pristine.set({ ...saved });
      const warning = (res.warnings ?? []).filter(Boolean).join('، ');
      this.info.set(warning || res.message || 'تم حفظ الإعدادات بنجاح');
    } catch (e) {
      this.err.set((e as Error).message || 'فشل الحفظ');
    } finally {
      this.saving.set(false);
    }
  }

  /** Discard edits — reset working copy to the last snapshot. */
  revert(): void {
    this.form.set({ ...this.pristine() });
    this.info.set('تم التراجع عن التعديلات');
    this.err.set(null);
  }

  onExit(): void {
    void this.router.navigateByUrl('/app');
  }

  private normalizeForDisplay(form: TitlForm): TitlForm {
    return Number(form.TSYS ?? 0) === 2 ? { ...form, SANDT: 0 } : form;
  }

  private normalizeBeforeSave(form: TitlForm): TitlForm {
    const next = { ...form };
    if (Number(next.TSYS ?? 0) === 2) next.SANDT = 0;

    for (const key of COLOR_FIELDS) {
      if (Number(next[key] ?? 0) === 0) next[key] = 1;
    }
    if (Number(next.NOSMM ?? 0) === 0) next.NOSMM = 1;
    if (Number(next.NOSMMS ?? 0) === 0) next.NOSMMS = 1;
    if (next.T_SMS == null) next.T_SMS = 0;
    return next;
  }

  @HostListener('document:keydown', ['$event'])
  handleLegacyKeys(event: KeyboardEvent): void {
    if (this.saving() || this.loading()) return;
    if (event.key === 'F10') {
      event.preventDefault();
      void this.save();
    } else if (event.key === 'F7') {
      event.preventDefault();
      if (this.dirty()) this.revert();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (this.dirty()) this.revert();
      else this.onExit();
    }
  }

  clearMessages(): void { this.err.set(null); this.info.set(null); }
}
