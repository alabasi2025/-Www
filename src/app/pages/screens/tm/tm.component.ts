import {
  Component, OnInit, signal, computed, inject, ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PermissionService } from '../../../services/permission.service';

type Row = Record<string, unknown>;

interface MasterRow extends Row {
  NOS: number;
  NOSON: number;
  DATES: string;
  NOA: number | null;
  NOBN: number | null;
  NOAML2: number | null;
  SARSF2: number | null;
  NOMHZND: number | null;
  NOMHZND2: number | null;
  MRT: number | null;
  MEMOS1: string | null;
  TOTALF: number | null;
  TOTALFYM: number | null;
  TOTALFAM: number | null;
  MRHL: number | null;
  DI: string | null;
  DE: string | null;
  NOUSX: number | null;
  NOUSXU: number | null;
  NED: number | null;
  NPR: number | null;
  SQ: number | null;
}

interface DetailRow extends Row {
  _key: number;
  NOS?: number;
  RECNO?: number;
  NOA?: number | null;
  NOAG?: number | null;
  KMAG?: number | null;
  KMA?: number | null;
  SARWG?: number | null;
  DISCOUNT?: number | null;
  FREE_QTY?: number | null;
  TOTLSH?: number | null;
  TOTLSHY?: number | null;
  TOTLSHA?: number | null;
  TKTOG?: number | null;
  NOOB?: number | null;
  NOMHZN?: number | null;
  NOMHZN2?: number | null;
  DATEN?: string | null;
  DATEN2?: number | null;
  MEMOSF?: string | null;
  ITEM_NAME?: string | null;
  ITEM_UNIT?: number | null;
}

interface SupplierRow { NOA: number; NAMEA: string | null; TYPEA: number; }
interface ItemRow { NOA: number; NAMEA: string | null; TYPEA: number; NOAN: number | null; }
interface WarehouseRow { NOG: number; NAMEG: string | null; }
interface Currency { NO: number; NAMEM3: string; SARS: number; SARS1: number; SARS2: number; }

@Component({
  selector: 'app-tm',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  templateUrl: './tm.component.html',
  styleUrl: './tm.component.scss',
})
export class TmComponent implements OnInit {
  private http = inject(HttpClient);
  private permSvc = inject(PermissionService);
  private router = inject(Router);

  readonly screenCode = 'TM.FMX';
  private readonly perms = computed(() => this.permSvc.forScreen(this.screenCode)());
  readonly canIns = computed(() => (this.perms()?.ins ?? 0) > 0);
  readonly canEd = computed(() => (this.perms()?.ed ?? 0) > 0);
  readonly canDe = computed(() => (this.perms()?.de ?? 0) > 0);
  readonly canPr = computed(() => (this.perms()?.pr ?? 0) > 0);

  readonly masters = signal<MasterRow[]>([]);
  readonly master = signal<Partial<MasterRow>>({});
  readonly details = signal<DetailRow[]>([]);
  readonly suppliers = signal<SupplierRow[]>([]);
  readonly items = signal<ItemRow[]>([]);
  readonly warehouses = signal<WarehouseRow[]>([]);
  readonly currencies = signal<Currency[]>([]);

  readonly mode = signal<'browse' | 'new' | 'edit'>('browse');
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);
  readonly search = signal('');

  readonly editable = computed(() => this.mode() === 'new' || this.mode() === 'edit');

  readonly filteredMasters = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) return this.masters();
    return this.masters().filter(r =>
      String(r.NOS ?? '').includes(q) ||
      String(r.NOSON ?? '').includes(q) ||
      String(r.NOBN ?? '').includes(q) ||
      this.toInputDate(r.DATES).includes(q),
    );
  });

  readonly currentIdx = computed(() => {
    const nos = Number(this.master()['NOS']) || 0;
    if (!nos) return -1;
    return this.masters().findIndex(r => Number(r.NOS) === nos);
  });

  readonly validDetails = computed(() =>
    this.details().filter(d => (Number(d.NOA) || 0) > 0 && (Number(d.KMAG) || 0) > 0),
  );

  readonly totalDiscount = computed(() =>
    this.validDetails().reduce((s, d) => s + (Number(d.DISCOUNT) || 0), 0),
  );

  readonly totalLocal = computed(() =>
    this.validDetails().reduce((s, d) => s + (Number(d.TOTLSH) || 0), 0),
  );

  readonly totalForeign = computed(() => {
    const rate = Number(this.master()['SARSF2']) || 1;
    if (rate <= 0) return 0;
    return this.round2(this.totalLocal() / rate);
  });

  readonly itemCount = computed(() => this.validDetails().length);

  readonly placeholderRows = computed(() =>
    Array.from({ length: Math.max(0, 8 - this.details().length) }, (_, i) => i),
  );

  readonly supplierName = computed(() => {
    const noa = Number(this.master()['NOA']) || 0;
    if (!noa) return '';
    return this.suppliers().find(x => x.NOA === noa)?.NAMEA ?? '';
  });

  readonly currencyName = computed(() => {
    const no = Number(this.master()['NOAML2']) || 1;
    return this.currencies().find(c => c.NO === no)?.NAMEM3 ?? '';
  });

  async ngOnInit(): Promise<void> {
    await Promise.all([this.fetchMasters(), this.fetchLookups()]);
  }

  async fetchLookups(): Promise<void> {
    await Promise.all([
      this.fetchSuppliers(),
      this.fetchItems(),
      this.fetchWarehouses(),
      this.fetchCurrencies(),
    ]);
  }

  async fetchMasters(): Promise<void> {
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows?: MasterRow[]; error?: string }>(
          '/api/data/TM?limit=800&orderBy=NOS+DESC',
        ),
      );
      if (!r.ok) throw new Error(r.error || 'تعذر جلب أوامر التوريد');
      this.masters.set((r.rows ?? []) as MasterRow[]);
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.loading.set(false);
  }

  async fetchSuppliers(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; rows?: SupplierRow[] }>('/api/suppliers'));
      if (r.ok) this.suppliers.set(r.rows ?? []);
    } catch { /* */ }
  }

  async fetchItems(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; rows?: ItemRow[] }>('/api/items'));
      if (r.ok) this.items.set(r.rows ?? []);
    } catch { /* */ }
  }

  async fetchWarehouses(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; rows?: WarehouseRow[] }>('/api/warehouses'));
      if (r.ok) this.warehouses.set(r.rows ?? []);
    } catch { /* */ }
  }

  async fetchCurrencies(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; items?: Currency[] }>('/api/lov/currencies'));
      if (r.ok) this.currencies.set(r.items ?? []);
    } catch { /* */ }
  }

  async selectMaster(r: MasterRow): Promise<void> {
    this.err.set(null);
    this.info.set(null);
    this.master.set({ ...r });
    await this.fetchDetails(Number(r.NOS));
    this.mode.set('browse');
  }

  async fetchDetails(nos: number): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; rows?: Row[]; error?: string }>(
          '/api/data/TMF?limit=5000&orderBy=NOS+DESC',
        ),
      );
      if (!r.ok) throw new Error(r.error || 'تعذر جلب تفاصيل أمر التوريد');
      const rows = (r.rows ?? [])
        .filter(x => Number(x['NOS']) === nos)
        .sort((a, b) => Number(a['RECNO'] || 0) - Number(b['RECNO'] || 0))
        .map((x, i) => this.normalizeDetail(x, i + 1));
      this.details.set(rows.length ? rows : [this.emptyDetail()]);
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
      this.details.set([this.emptyDetail()]);
    }
  }

  onNew(): void {
    const today = this.today();
    const currency = this.currencies().find(c => c.NO === 1) ?? this.currencies()[0];
    const wh1 = this.warehouses()[0]?.NOG ?? null;
    const wh2 = this.warehouses()[1]?.NOG ?? wh1;
    this.master.set({
      DATES: today,
      NOSON: this.nextNoson(Number(today.slice(0, 4))),
      NOBN: null,
      NOA: null,
      NOAML2: currency?.NO ?? 1,
      SARSF2: currency?.SARS ?? 1,
      NOMHZND: wh1,
      NOMHZND2: wh2,
      MRT: null,
      MEMOS1: '',
      MRHL: 0,
      NED: 0,
      NPR: 0,
    });
    this.details.set([this.emptyDetail()]);
    this.mode.set('new');
    this.err.set(null);
    this.info.set(null);
  }

  onEdit(): void {
    if (!this.master()['NOS']) return;
    this.mode.set('edit');
    this.err.set(null);
    this.info.set(null);
  }

  onCancel(): void {
    const nos = Number(this.master()['NOS']) || 0;
    this.mode.set('browse');
    this.err.set(null);
    if (nos) {
      const row = this.masters().find(x => Number(x.NOS) === nos);
      if (row) void this.selectMaster(row);
      return;
    }
    this.master.set({});
    this.details.set([]);
  }

  async onDelete(): Promise<void> {
    const nos = Number(this.master()['NOS']) || 0;
    if (!nos) return;
    if (!confirm(`هل أنت متأكد من حذف أمر التوريد رقم ${this.master()['NOSON'] || nos}؟`)) return;
    this.saving.set(true);
    this.err.set(null);
    try {
      await this.execSql('TMF', 'DELETE FROM TMF WHERE NOS=:NOS', { NOS: nos });
      await this.execSql('TM', 'DELETE FROM TM WHERE NOS=:NOS', { NOS: nos });
      this.info.set('تم حذف أمر التوريد');
      this.master.set({});
      this.details.set([]);
      this.mode.set('browse');
      await this.fetchMasters();
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.saving.set(false);
  }

  async onSave(): Promise<void> {
    if (!this.validate()) return;
    this.saving.set(true);
    this.err.set(null);
    try {
      const payload = this.buildMasterPayload();
      const nos = Number(payload['NOS']);

      if (this.mode() === 'new') {
        await this.execSql(
          'TM',
          `INSERT INTO TM (
             NOS, NOSON, DATES, NOUSX, NOBN, MRHL, TYPEMS, NOA, NOK, NOUSXU,
             SARSF2, NOAML2, NOAMHZ, MEMOS1, MEMOS, TOTALFYM, TOTALFAM, TOTALF,
             NOMHZND, NOMHZND2, SQ, MRT, MRHLM, NED, NPR
           ) VALUES (
             :NOS, :NOSON, TO_DATE(:DATES,'YYYY-MM-DD'), :NOUSX, :NOBN, :MRHL, :TYPEMS, :NOA, :NOK, :NOUSXU,
             :SARSF2, :NOAML2, :NOAMHZ, :MEMOS1, :MEMOS, :TOTALFYM, :TOTALFAM, :TOTALF,
             :NOMHZND, :NOMHZND2, :SQ, :MRT, :MRHLM, :NED, :NPR
           )`,
          payload,
        );
      } else {
        await this.execSql(
          'TM',
          `UPDATE TM SET
             NOSON=:NOSON, DATES=TO_DATE(:DATES,'YYYY-MM-DD'), NOBN=:NOBN, NOA=:NOA,
             SARSF2=:SARSF2, NOAML2=:NOAML2, MEMOS1=:MEMOS1, MEMOS=:MEMOS,
             TOTALFYM=:TOTALFYM, TOTALFAM=:TOTALFAM, TOTALF=:TOTALF,
             NOMHZND=:NOMHZND, NOMHZND2=:NOMHZND2, MRT=:MRT, NED=:NED, NPR=:NPR
           WHERE NOS=:NOS`,
          payload,
        );
      }

      await this.execSql('TMF', 'DELETE FROM TMF WHERE NOS=:NOS', { NOS: nos });
      const rows = this.buildDetailPayloads(nos);
      for (const row of rows) {
        await this.execSql(
          'TMF',
          `INSERT INTO TMF (
             NOS, RECNO, NOA, NOAG, TOTLSH, KMA, NOMHZN, NOMHZN2, KMAG,
             NOOB, SARWG, TOTLSHA, TOTLSHY, TKTOG, MEMOSF, DATEN, DATEN2
           ) VALUES (
             :NOS, :RECNO, :NOA, :NOAG, :TOTLSH, :KMA, :NOMHZN, :NOMHZN2, :KMAG,
             :NOOB, :SARWG, :TOTLSHA, :TOTLSHY, :TKTOG, :MEMOSF,
             CASE WHEN :DATEN IS NULL THEN NULL ELSE TO_DATE(:DATEN,'YYYY-MM-DD') END,
             :DATEN2
           )`,
          row,
        );
      }

      this.info.set('تم حفظ أمر التوريد بنجاح');
      this.mode.set('browse');
      await this.fetchMasters();
      const after = this.masters().find(x => Number(x.NOS) === nos);
      if (after) await this.selectMaster(after);
    } catch (e) {
      this.err.set(e instanceof Error ? e.message : String(e));
    }
    this.saving.set(false);
  }

  addDetailRow(): void {
    this.details.update(d => [...d, this.emptyDetail()]);
  }

  removeDetailRow(index: number): void {
    this.details.update(d => d.filter((_, i) => i !== index));
  }

  updateMaster(field: keyof MasterRow | string, value: unknown): void {
    this.master.update(m => ({ ...m, [field]: value }));
    if (field === 'NOAML2') {
      const cur = this.currencies().find(c => c.NO === Number(value));
      if (cur) this.master.update(m => ({ ...m, SARSF2: cur.SARS }));
      this.recalculateAllRows();
    }
    if (field === 'SARSF2') {
      this.recalculateAllRows();
    }
  }

  updateDetail(index: number, field: keyof DetailRow | string, value: unknown): void {
    this.details.update(rows => rows.map((r, i) => i === index ? { ...r, [field]: value } : r));

    if (field === 'NOA') {
      this.applyItem(index, Number(value) || 0);
      return;
    }
    if (field === 'KMAG' || field === 'SARWG' || field === 'DISCOUNT') {
      this.recalculateDetail(index);
    }
  }

  applyItem(index: number, noa: number): void {
    const item = this.items().find(i => i.NOA === noa);
    this.details.update(rows => rows.map((r, i) => {
      if (i !== index) return r;
      return this.calcDetail({
        ...r,
        NOA: noa || null,
        ITEM_NAME: item?.NAMEA ?? '',
        ITEM_UNIT: item?.NOAN ?? null,
        NOAG: item?.TYPEA ?? null,
      });
    }));
  }

  onSupplierChange(noa: string | number): void {
    const n = Number(noa) || null;
    this.updateMaster('NOA', n);
  }

  onSearchSelect(nos: string | number): void {
    const n = Number(nos) || 0;
    if (!n) return;
    const r = this.masters().find(x => Number(x.NOS) === n);
    if (r) void this.selectMaster(r);
  }

  navTo(delta: number | 'first' | 'last'): void {
    const list = this.masters();
    if (!list.length) return;
    const idx = this.currentIdx();
    const next = delta === 'first'
      ? 0
      : delta === 'last'
        ? list.length - 1
        : Math.max(0, Math.min(list.length - 1, idx + delta));
    const row = list[next];
    if (row) void this.selectMaster(row);
  }

  onPrint(): void {
    if (!this.master()['NOS']) return;
    this.info.set('وظيفة الطباعة ستُربط لاحقًا بتقرير أمر التوريد');
  }

  onExit(): void {
    void this.router.navigateByUrl('/app');
  }

  validate(): boolean {
    const m = this.master();
    if (!this.toInputDate(m['DATES'])) {
      this.err.set('يجب إدخال تاريخ التوريد');
      return false;
    }
    if (!Number(m['NOA'])) {
      this.err.set('يجب اختيار المورد');
      return false;
    }
    if (!this.validDetails().length) {
      this.err.set('يجب إدخال صنف واحد على الأقل');
      return false;
    }
    if (this.totalLocal() <= 0) {
      this.err.set('إجمالي أمر التوريد يجب أن يكون أكبر من صفر');
      return false;
    }
    return true;
  }

  private buildMasterPayload(): Record<string, unknown> {
    const m = this.master();
    const date = this.toInputDate(m['DATES']) || this.today();
    const year = Number(date.slice(0, 4));

    let noson = Number(m['NOSON']) || 0;
    if (!noson) noson = this.nextNoson(year);

    let nos = Number(m['NOS']) || 0;
    if (!nos) nos = Number(`${noson}${year}`);

    const sq = Number(m['SQ']) || this.nextSq();
    const rate = Number(m['SARSF2']) || 1;
    const local = this.round2(this.totalLocal());
    const foreign = rate > 0 ? this.round2(local / rate) : 0;

    return {
      NOS: nos,
      NOSON: noson,
      DATES: date,
      NOUSX: Number(m['NOUSX']) || null,
      NOBN: Number(m['NOBN']) || null,
      MRHL: Number(m['MRHL']) || 0,
      TYPEMS: 21,
      NOA: Number(m['NOA']) || null,
      NOK: Number(m['NOK']) || null,
      NOUSXU: Number(m['NOUSXU']) || null,
      SARSF2: rate,
      NOAML2: Number(m['NOAML2']) || 1,
      NOAMHZ: Number(m['NOAMHZ']) || null,
      MEMOS1: String(m['MEMOS1'] ?? ''),
      MEMOS: String(m['MEMOS'] ?? m['MEMOS1'] ?? ''),
      TOTALFYM: local,
      TOTALFAM: foreign,
      TOTALF: local,
      NOMHZND: Number(m['NOMHZND']) || null,
      NOMHZND2: Number(m['NOMHZND2']) || null,
      SQ: sq,
      MRT: Number(m['MRT']) || null,
      MRHLM: Number(m['MRHLM']) || 0,
      NED: Number(m['NED']) || 0,
      NPR: Number(m['NPR']) || 0,
    };
  }

  private buildDetailPayloads(nos: number): Array<Record<string, unknown>> {
    const rate = Number(this.master()['SARSF2']) || 1;
    const defaultWh = Number(this.master()['NOMHZND']) || null;
    const defaultWh2 = Number(this.master()['NOMHZND2']) || defaultWh;
    return this.validDetails().map((d, i) => {
      const total = Number(d.TOTLSH) || 0;
      return {
        NOS: nos,
        RECNO: i + 1,
        NOA: Number(d.NOA) || null,
        NOAG: Number(d.NOAG) || 0,
        TOTLSH: this.round2(total),
        KMA: Number(d.KMAG) || 0,
        NOMHZN: Number(d.NOMHZN) || defaultWh,
        NOMHZN2: Number(d.NOMHZN2) || defaultWh2,
        KMAG: Number(d.KMAG) || 0,
        NOOB: Number(d.NOOB) || 1,
        SARWG: Number(d.SARWG) || 0,
        TOTLSHA: rate > 0 ? this.round2(total / rate) : 0,
        TOTLSHY: this.round2(total),
        TKTOG: Number(d.TKTOG) || 1,
        MEMOSF: String(d.MEMOSF ?? ''),
        DATEN: this.toInputDate(d.DATEN),
        DATEN2: Number(d.DATEN2) || null,
      };
    });
  }

  private async execSql(table: string, sql: string, binds: Record<string, unknown>): Promise<void> {
    const r = await firstValueFrom(
      this.http.put<{ ok?: boolean; error?: string }>(`/api/data/${table}`, { sql, binds }),
    );
    if (r && Object.prototype.hasOwnProperty.call(r, 'ok') && r.ok === false) {
      throw new Error(r.error || 'فشل تنفيذ العملية');
    }
  }

  private normalizeDetail(r: Row, index: number): DetailRow {
    const itemNo = Number(r['NOA']) || 0;
    const item = this.items().find(x => x.NOA === itemNo);
    return this.calcDetail({
      _key: Date.now() + index,
      ...r,
      NOA: itemNo || null,
      NOAG: Number(r['NOAG']) || item?.TYPEA || null,
      KMAG: Number(r['KMAG']) || Number(r['KMA']) || 0,
      KMA: Number(r['KMA']) || Number(r['KMAG']) || 0,
      SARWG: Number(r['SARWG']) || 0,
      DISCOUNT: Number(r['DISCOUNT']) || 0,
      FREE_QTY: Number(r['FREE_QTY']) || 0,
      NOOB: Number(r['NOOB']) || 1,
      TKTOG: Number(r['TKTOG']) || 1,
      TOTLSH: Number(r['TOTLSH']) || 0,
      TOTLSHY: Number(r['TOTLSHY']) || Number(r['TOTLSH']) || 0,
      TOTLSHA: Number(r['TOTLSHA']) || 0,
      ITEM_NAME: item?.NAMEA ?? '',
      ITEM_UNIT: item?.NOAN ?? null,
      DATEN: this.toInputDate(r['DATEN']),
    });
  }

  private emptyDetail(): DetailRow {
    return this.calcDetail({
      _key: Date.now() + Math.floor(Math.random() * 1000),
      NOA: null,
      NOAG: null,
      KMAG: 1,
      KMA: 1,
      SARWG: 0,
      DISCOUNT: 0,
      FREE_QTY: 0,
      NOOB: 1,
      TKTOG: 1,
      NOMHZN: Number(this.master()['NOMHZND']) || null,
      NOMHZN2: Number(this.master()['NOMHZND2']) || Number(this.master()['NOMHZND']) || null,
      DATEN: null,
      MEMOSF: '',
      ITEM_NAME: '',
      ITEM_UNIT: null,
    });
  }

  private recalculateDetail(index: number): void {
    this.details.update(rows => rows.map((r, i) => i === index ? this.calcDetail(r) : r));
  }

  private recalculateAllRows(): void {
    this.details.update(rows => rows.map(r => this.calcDetail(r)));
  }

  private calcDetail(r: DetailRow): DetailRow {
    const qty = Number(r.KMAG) || 0;
    const price = Number(r.SARWG) || 0;
    const disc = Number(r.DISCOUNT) || 0;
    const gross = this.round2(qty * price);
    const total = this.round2(gross - disc);
    const rate = Number(this.master()['SARSF2']) || 1;
    return {
      ...r,
      KMA: qty,
      TOTLSH: total,
      TOTLSHY: total,
      TOTLSHA: rate > 0 ? this.round2(total / rate) : 0,
    };
  }

  private nextNoson(year: number): number {
    const inYear = this.masters().filter(r => this.recordYear(r.DATES) === year);
    const max = inYear.reduce((s, r) => Math.max(s, Number(r.NOSON) || 0), 0);
    return max + 1;
  }

  private nextSq(): number {
    const max = this.masters().reduce((s, r) => Math.max(s, Number(r.SQ) || 0), 0);
    return max + 1;
  }

  private round2(v: number): number {
    return Math.round((v + Number.EPSILON) * 100) / 100;
  }

  private recordYear(dateVal: unknown): number {
    const d = this.toInputDate(dateVal);
    if (!d) return 0;
    return Number(d.slice(0, 4)) || 0;
  }

  private today(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  toInputDate(v: unknown): string {
    const s = String(v ?? '').trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  asNum(v: unknown): number { return Number(v) || 0; }
  asStr(v: unknown): string { return String(v ?? ''); }
  trackByKey = (_: number, d: DetailRow) => d._key;
}
