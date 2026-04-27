import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LovPickerComponent, type LovAccount } from '../../../shared/lov-picker/lov-picker.component';
import { PermissionService } from '../../../services/permission.service';

type Row = Record<string, unknown>;

interface OpeningDetail extends Row {
  _key: number;
  NOA?: number | null;
  NAMEA?: string | null;
  NOAML?: number;
  SARSF?: number;
  MDIN?: number;
  DAN?: number;
  MDINAML?: number;
  DANAML?: number;
  MRT?: number;
}

@Component({
  selector: 'app-rsedif',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, LovPickerComponent],
  templateUrl: './rsedif.component.html',
  styleUrl: './rsedif.component.scss',
})
export class RsedifComponent implements OnInit {
  private http = inject(HttpClient);
  private permSvc = inject(PermissionService);
  @ViewChild('gridScroll') private gridScroll?: ElementRef<HTMLDivElement>;

  readonly screenCode = 'RSEDIF.FMX';
  private readonly minVisibleRows = 16;
  private readonly perms = computed(() => this.permSvc.forScreen(this.screenCode)());

  readonly canIns = computed(() => (this.perms()?.ins ?? 0) > 0);
  readonly canEd  = computed(() => (this.perms()?.ed  ?? 0) > 0);
  readonly rows = signal<Row[]>([]);
  readonly master = signal<Row>({});
  readonly details = signal<OpeningDetail[]>([]);
  readonly mode = signal<'browse' | 'new' | 'edit'>('browse');
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);
  readonly search = signal('');
  readonly lovOpen = signal<number | null>(null);
  readonly activeRowIndex = signal(0);
  readonly updateRateOnSave = signal(false);

  private nextKey = 1;

  readonly editable = computed(() => this.mode() === 'new' || this.mode() === 'edit');
  readonly filteredRows = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) return this.rows();
    return this.rows().filter((row) => Object.values(row).some((v) => String(v ?? '').toLowerCase().includes(q)));
  });
  readonly currentIdx = computed(() => {
    const nos = String(this.master()['NOS'] ?? '');
    if (!nos) return -1;
    return this.rows().findIndex((row) => String(row['NOS']) === nos);
  });
  readonly persistableDetails = computed(() => this.details().filter((row) => this.num(row.NOA) > 0));
  readonly totalMdin = computed(() => this.details().reduce((s, r) => s + this.num(r.MDIN), 0));
  readonly totalDan = computed(() => this.details().reduce((s, r) => s + this.num(r.DAN), 0));
  readonly totalMdinAml = computed(() => this.details().reduce((s, r) => s + this.num(r.MDINAML), 0));
  readonly totalDanAml = computed(() => this.details().reduce((s, r) => s + this.num(r.DANAML), 0));
  readonly difference = computed(() => this.totalMdin() - this.totalDan());
  readonly balanced = computed(() => Math.abs(this.difference()) < 0.005);
  readonly canSave = computed(() => {
    if (!this.editable()) return false;
    if (!this.master()['DATES']) return false;
    if (!this.persistableDetails().length) return false;
    return Number(this.master()['KDANT'] ?? 0) > 0 || this.balanced();
  });
  readonly statusBadges = computed(() => [
    { label: `مدين: ${this.format(this.totalMdin())}`, variant: 'info' },
    { label: `دائن: ${this.format(this.totalDan())}`, variant: 'info' },
    { label: this.balanced() ? 'متوازن' : `فرق: ${this.format(this.difference())}`, variant: this.balanced() ? 'success' : 'warning' },
    { label: Number(this.master()['MRHL'] ?? 1) === 0 ? 'مستند مرحل' : 'مستند غير مرحل', variant: Number(this.master()['MRHL'] ?? 1) === 0 ? 'success' : 'info' },
  ]);

  async ngOnInit(): Promise<void> {
    await this.fetchList();
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
        if (this.editable() && !this.saving() && this.canSave()) {
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
        if (this.canEd() && this.master()['NOS'] && !this.editable() && !this.saving() && this.num(this.master()['MRHL']) !== 0) {
          event.preventDefault();
          this.onEdit();
        }
        break;
      case 'F6':
        if (this.master()['NOS'] && !this.editable() && !this.saving()) {
          event.preventDefault();
          this.onPrint();
        }
        break;
      case 'Escape':
        event.preventDefault();
        if (this.lovOpen() !== null) this.lovOpen.set(null);
        else if (this.editable() && !this.saving()) this.onCancel();
        else { this.err.set(null); this.info.set(null); }
        break;
      default:
        break;
    }
  }

  async fetchList(): Promise<void> {
    this.loading.set(true);
    this.err.set(null);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows: Row[]; error?: string }>('/api/opening-balances/list?limit=200'),
      );
      if (!r.ok) throw new Error(r.error);
      this.rows.set(r.rows ?? []);
      const first = this.rows()[0];
      if (first?.['NOS']) await this.openRow(Number(first['NOS']));
      else this.onNew();
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.loading.set(false);
  }

  async openRow(nos: number): Promise<void> {
    this.loading.set(true);
    this.err.set(null);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; master: Row; details: Row[]; error?: string }>(
          `/api/opening-balances?nos=${encodeURIComponent(String(nos))}`,
        ),
      );
      if (!r.ok) throw new Error(r.error);
      this.master.set(r.master ?? {});
      this.details.set(this.withVisualRows((r.details ?? []).map((row) => this.decorate(row))));
      this.resetGridScroll();
      this.activeRowIndex.set(0);
      this.mode.set('browse');
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.loading.set(false);
  }

  onNew(): void {
    this.master.set({
      NOS: 1,
      NOSON: 1,
      DATES: new Date().toISOString().slice(0, 10),
      MEMOS: 'رصيد افتتاحي',
      KDANT: 0,
      MRHL: 1,
      NOK: 1,
      YK: 0,
    });
    this.details.set(this.withVisualRows([this.blankRow()]));
    this.resetGridScroll();
    this.activeRowIndex.set(0);
    this.mode.set('new');
    this.err.set(null);
    this.info.set('وضع إضافة رصيد افتتاحي جديد');
  }

  onEdit(): void {
    if (!this.master()['NOS']) return;
    if (Number(this.master()['YK'] ?? 0) > 0) {
      this.err.set('هذه الأرصدة مرحلة من العام السابق ولا يمكن تعديلها');
      return;
    }
    this.mode.set('edit');
    this.err.set(null);
    this.info.set('وضع تعديل الأرصدة الافتتاحية');
  }

  async onSave(): Promise<void> {
    if (!this.canSave()) {
      this.err.set(this.balanced() ? 'أكمل التاريخ وسطر واحد على الأقل' : 'الجانب المدين لا يساوي الجانب الدائن');
      return;
    }
    this.saving.set(true);
    this.err.set(null);
    try {
      const body = {
        master: this.master(),
        details: this.persistableDetails(),
      };
      const method = this.mode() === 'new' ? 'post' : 'put';
      const r = await firstValueFrom(
        this.http.request<{ ok: boolean; message?: string; error?: string; nos?: number }>(
          method.toUpperCase(),
          '/api/opening-balances',
          { body },
        ),
      );
      if (!r.ok) throw new Error(r.error);
      this.info.set(r.message ?? 'تم الحفظ');
      this.mode.set('browse');
      await this.fetchList();
      await this.openRow(Number(r.nos ?? this.master()['NOS'] ?? 1));
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.saving.set(false);
  }

  async onDelete(): Promise<void> {
    this.err.set('الحذف غير مفعل من شاشة الأرصدة الافتتاحية الحالية لتجنب حذف أرصدة بالخطأ');
  }

  onCancel(): void {
    const nos = Number(this.master()['NOS'] ?? 0);
    this.mode.set('browse');
    this.err.set(null);
    if (nos) void this.openRow(nos);
    else void this.fetchList();
  }

  onPrint(): void {
    const nos = Number(this.master()['NOS'] ?? 1);
    const url = `/api/opening-balances/print?nos=${encodeURIComponent(String(nos))}`;
    const win = window.open(url, '_blank');
    if (!win) window.location.assign(url);
  }

  onExport(): void {
    const rows = this.persistableDetails();
    if (!rows.length) {
      this.info.set('لا توجد بيانات للتصدير');
      return;
    }
    const headers = ['NOA', 'NAMEA', 'NOAML', 'SARSF', 'MDIN', 'DAN', 'MDINAML', 'DANAML', 'MRT'];
    const csv = [
      headers.join(','),
      ...rows.map((row) => headers.map((key) => this.csvCell(row[key])).join(',')),
    ].join('\r\n');
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `RSEDIF-${this.master()['NOS'] ?? 1}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    this.info.set('تم تصدير تفاصيل الأرصدة الافتتاحية');
  }

  patchMaster(patch: Row): void {
    if (!this.editable()) return;
    this.master.update((m) => ({ ...m, ...patch }));
  }

  patchLegacyDate(value: string): void {
    this.patchMaster({ DATES: this.parseLegacyDate(value) });
  }

  patchRow(index: number, patch: Partial<OpeningDetail>): void {
    if (!this.editable()) return;
    this.activeRowIndex.set(index);
    this.details.update((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  addRow(): void {
    if (!this.editable()) return;
    this.details.update((rows) => [...rows, this.blankRow()]);
    this.activeRowIndex.set(this.details().length - 1);
  }

  removeRow(index: number): void {
    if (!this.editable()) return;
    this.details.update((rows) => this.withVisualRows(rows.filter((_, i) => i !== index)));
    this.activeRowIndex.set(Math.max(0, Math.min(index, this.details().length - 1)));
  }

  openLov(index: number): void {
    if (!this.editable()) return;
    this.activeRowIndex.set(index);
    this.lovOpen.set(index);
  }

  openActiveLov(): void {
    this.openLov(this.activeRowIndex());
  }

  pickAccount(account: LovAccount): void {
    const index = this.lovOpen();
    if (index == null) return;
    this.patchRow(index, {
      NOA: Number(account.NOA),
      NAMEA: account.NAMEA,
      NOAML: Number(account.NOAML ?? 1),
      SARSF: Number(account.NOAML ?? 1) === 1 ? 1 : this.num(this.details()[index]?.SARSF) || 1,
    });
    this.lovOpen.set(null);
  }

  onAccountNoInput(index: number, raw: string | number): void {
    const noa = Number(raw);
    if (!noa || noa <= 0) {
      this.patchRow(index, { NOA: null, NAMEA: null });
      return;
    }
    this.patchRow(index, { NOA: noa });
    void this.resolveAccountByNoa(index, noa);
  }

  onDebitInput(index: number, value: string | number): void {
    const v = this.toAmount(value);
    const line = this.details()[index];
    const rate = this.num(line?.SARSF) || 1;
    const isLocal = this.num(line?.NOAML) <= 1;
    const patch: Partial<OpeningDetail> = {
      MDIN: v,
      MDINAML: isLocal ? v : this.num(line?.MDINAML),
      DAN: v > 0 ? 0 : this.num(line?.DAN),
      DANAML: v > 0 ? 0 : this.num(line?.DANAML),
    };
    if (!isLocal && v > 0 && rate > 0) patch.MDINAML = +(v / rate).toFixed(2);
    this.patchRow(index, patch);
  }

  onCreditInput(index: number, value: string | number): void {
    const v = this.toAmount(value);
    const line = this.details()[index];
    const rate = this.num(line?.SARSF) || 1;
    const isLocal = this.num(line?.NOAML) <= 1;
    const patch: Partial<OpeningDetail> = {
      DAN: v,
      DANAML: isLocal ? v : this.num(line?.DANAML),
      MDIN: v > 0 ? 0 : this.num(line?.MDIN),
      MDINAML: v > 0 ? 0 : this.num(line?.MDINAML),
    };
    if (!isLocal && v > 0 && rate > 0) patch.DANAML = +(v / rate).toFixed(2);
    this.patchRow(index, patch);
  }

  onForeignDebitInput(index: number, value: string | number): void {
    const v = this.toAmount(value);
    const line = this.details()[index];
    const rate = this.num(line?.SARSF) || 1;
    this.patchRow(index, { MDINAML: v, MDIN: +(v * rate).toFixed(2), DAN: 0, DANAML: 0 });
  }

  onForeignCreditInput(index: number, value: string | number): void {
    const v = this.toAmount(value);
    const line = this.details()[index];
    const rate = this.num(line?.SARSF) || 1;
    this.patchRow(index, { DANAML: v, DAN: +(v * rate).toFixed(2), MDIN: 0, MDINAML: 0 });
  }

  onRateInput(index: number, value: string | number): void {
    const rate = this.toAmount(value) || 1;
    const line = this.details()[index];
    if (!line) return;
    if (this.num(line.MDINAML) > 0) {
      this.patchRow(index, { SARSF: rate, MDIN: +(this.num(line.MDINAML) * rate).toFixed(2) });
    } else if (this.num(line.DANAML) > 0) {
      this.patchRow(index, { SARSF: rate, DAN: +(this.num(line.DANAML) * rate).toFixed(2) });
    } else {
      this.patchRow(index, { SARSF: rate });
    }
  }

  navTo(target: 'first' | 'last' | number): void {
    const list = this.filteredRows();
    if (!list.length) return;
    const idx = this.currentIdx();
    let next = 0;
    if (target === 'first') next = 0;
    else if (target === 'last') next = list.length - 1;
    else next = Math.min(list.length - 1, Math.max(0, idx + target));
    const row = list[next];
    if (row?.['NOS']) void this.openRow(Number(row['NOS']));
  }

  asStr(value: unknown): string {
    return String(value ?? '');
  }

  dateInput(value: unknown): string {
    if (!value) return '';
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Riyadh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
  }

  legacyDate(value: unknown): string {
    const iso = this.dateInput(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!match) return String(value ?? '');
    return `${match[3]}/${match[2]}/${match[1]}`;
  }

  amountInputValue(value: unknown): number | '' {
    const v = this.num(value);
    return Math.abs(v) > 0.000001 ? v : '';
  }

  displayRate(row: OpeningDetail): number | '' {
    if (this.num(row.NOAML) <= 1) return '';
    return this.amountInputValue(row.SARSF || 1);
  }

  currencyName(value: unknown): string {
    const no = Number(value ?? 1) || 1;
    return no === 1 ? 'يمني' : String(no);
  }

  mainAccountName(row: OpeningDetail): string {
    const explicit = row['MAIN_NAME'] ?? row['MAINA'] ?? row['PARENT_NAME'] ?? row['NAMEP'] ?? row['GROUP_NAME'];
    return String(explicit ?? '');
  }

  rowHasData(row: OpeningDetail): boolean {
    return this.num(row.NOA) > 0 || !!String(row.NAMEA ?? '').trim() || this.num(row.MDIN) > 0 || this.num(row.DAN) > 0;
  }

  postedLabel(): string {
    return Number(this.master()['MRHL'] ?? 1) === 0 ? 'مستند مرحل' : 'مستند غير مرحل';
  }

  modeLabel(): string {
    switch (this.mode()) {
      case 'new': return 'إضافة';
      case 'edit': return 'تعديل';
      default: return 'استعراض';
    }
  }

  currentRecordLabel(): string {
    const total = this.filteredRows().length || 1;
    const index = this.currentIdx() >= 0 ? this.currentIdx() + 1 : 1;
    return `${index}/${total}`;
  }

  num(value: unknown): number {
    return Number(value ?? 0) || 0;
  }

  trackByKey(_index: number, row: OpeningDetail): number {
    return row._key;
  }

  private async resolveAccountByNoa(index: number, noa: number): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; items?: LovAccount[] }>(
          `/api/lov/accounts?q=${encodeURIComponent(String(noa))}&rtba=5&limit=10`,
        ),
      );
      const items = r.ok ? (r.items ?? []) : [];
      const hit = items.find((item) => Number(item.NOA) === noa);
      if (!hit || Number(this.details()[index]?.NOA ?? 0) !== noa) return;
      this.patchRow(index, {
        NOA: Number(hit.NOA),
        NAMEA: hit.NAMEA,
        NOAML: Number(hit.NOAML ?? 1),
        SARSF: Number(hit.NOAML ?? 1) === 1 ? 1 : this.num(this.details()[index]?.SARSF) || 1,
      });
    } catch {
      // Keep the typed number if the lookup is unavailable.
    }
  }

  private parseLegacyDate(value: string): string {
    const raw = String(value ?? '').trim();
    const legacy = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(raw);
    if (legacy) {
      const day = legacy[1].padStart(2, '0');
      const month = legacy[2].padStart(2, '0');
      return `${legacy[3]}-${month}-${day}`;
    }
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
    if (iso) {
      return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
    }
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? raw : d.toISOString().slice(0, 10);
  }

  private decorate(row: Row): OpeningDetail {
    return {
      _key: this.nextKey++,
      ...row,
      NOAML: Number(row['NOAML'] ?? 1) || 1,
      SARSF: Number(row['SARSF'] ?? 1) || 1,
      MDIN: Number(row['MDIN'] ?? 0) || 0,
      DAN: Number(row['DAN'] ?? 0) || 0,
      MDINAML: Number(row['MDINAML'] ?? row['MDIN'] ?? 0) || 0,
      DANAML: Number(row['DANAML'] ?? row['DAN'] ?? 0) || 0,
      MRT: Number(row['MRT'] ?? 0) || 0,
    };
  }

  private blankRow(): OpeningDetail {
    return {
      _key: this.nextKey++,
      NOA: null,
      NAMEA: null,
      NOAML: 1,
      SARSF: 1,
      MDIN: 0,
      DAN: 0,
      MDINAML: 0,
      DANAML: 0,
      MRT: 0,
    };
  }

  private withVisualRows(rows: OpeningDetail[]): OpeningDetail[] {
    const next = [...rows];
    while (next.length < this.minVisibleRows) next.push(this.blankRow());
    return next;
  }

  private resetGridScroll(): void {
    const reset = () => {
      const el = this.gridScroll?.nativeElement;
      if (!el) return;
      el.scrollTop = 0;
      el.scrollLeft = 0;
    };
    queueMicrotask(reset);
    requestAnimationFrame(reset);
    window.setTimeout(reset, 80);
  }

  private toAmount(value: string | number): number {
    const normalized = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
    return Number(normalized || 0) || 0;
  }

  private format(value: number): string {
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0);
  }

  private csvCell(value: unknown): string {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
}
