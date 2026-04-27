import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule, DecimalPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { form, required } from '@angular/forms/signals';
import { PermissionService } from '../../../services/permission.service';
import { LegacyToolbarComponent } from '../../../shared/legacy-ui/legacy-toolbar/legacy-toolbar.component';
import { LegacyStatusBarComponent } from '../../../shared/legacy-ui/legacy-status-bar/legacy-status-bar.component';
import { LegacyAuditFooterComponent } from '../../../shared/legacy-ui/legacy-audit-footer/legacy-audit-footer.component';
import { LegacyToolbarActionId } from '../../../shared/legacy-ui/contracts/legacy-contracts';

type Row = Record<string, unknown>;

@Component({
  selector: 'app-ramt',
  imports: [CommonModule, DecimalPipe, DatePipe, FormsModule, LegacyToolbarComponent, LegacyStatusBarComponent, LegacyAuditFooterComponent],
  templateUrl: './ramt.component.html',
  styleUrl: './ramt.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RamtComponent implements OnInit {
  private http = inject(HttpClient);
  private perms = inject(PermissionService);
  readonly p = this.perms.forScreen('RAMT');

  readonly model = signal({ DATES: '', NOA: 0, NAMES: '', MEMOS1: '', NOAML: 1, SARSF: 1, MRT: 0, TYPEMS: 0 });
  readonly f = form(this.model, p => { required(p.DATES, { message: 'التاريخ مطلوب' }); });

  readonly mode = signal<'browse' | 'new' | 'edit'>('browse');
  readonly saving = signal(false);
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly info = signal<string | null>(null);
  readonly rows = signal<Row[]>([]);
  readonly details = signal<Row[]>([]);
  readonly currentIdx = signal(0);
  readonly masterRaw = signal<Row>({});

  readonly editable = computed(() => this.mode() !== 'browse');
  readonly posted = computed(() => Number(this.masterRaw()['MRHL'] ?? 1) === 0);

  async ngOnInit() { await this.loadList(); }

  async loadList() {
    this.loading.set(true);
    try {
      const r = await firstValueFrom(this.http.get<{ok:boolean;rows:Row[]}>('/api/data/ATM?limit=500&orderBy=NOS DESC'));
      if (r.ok) { this.rows.set(r.rows); if (r.rows.length) { this.currentIdx.set(0); await this.loadOne(Number(r.rows[0]['NOS'])); } }
    } catch(e) { this.err.set(e instanceof Error ? e.message : 'خطأ'); }
    this.loading.set(false);
  }

  async loadOne(nos: number) {
    this.loading.set(true);
    try {
      const mR = await firstValueFrom(this.http.get<{ok:boolean;rows:Row[]}>(`/api/data/ATM?where=NOS=${nos}&limit=1`));
      if (mR.ok && mR.rows[0]) {
        const m = mR.rows[0]; this.masterRaw.set(m);
        this.model.set({ DATES: String(m['DATES']??'').slice(0,10), NOA: Number(m['NOA']??0), NAMES: String(m['NAMES']??m['NAMEA']??''), MEMOS1: String(m['MEMOS1']??''), NOAML: Number(m['NOAML']??1), SARSF: Number(m['SARSF']??1), MRT: Number(m['MRT']??0), TYPEMS: 0 });
        
        this.mode.set('browse');
      }
    } catch(e) { this.err.set(e instanceof Error ? e.message : 'خطأ'); }
    this.loading.set(false);
  }

  navTo(a:'first'|'last'|number) { const l=this.rows(); if(!l.length)return; let i=this.currentIdx(); if(a==='first')i=0; else if(a==='last')i=l.length-1; else i=Math.max(0,Math.min(l.length-1,i+a)); this.currentIdx.set(i); this.loadOne(Number(l[i]['NOS'])); }

  onToolbarAction(action: LegacyToolbarActionId) {
    switch(action) {
      case 'new': this.mode.set('new'); this.model.set({DATES:new Date().toISOString().slice(0,10),NOA:0,NAMES:'',MEMOS1:'',NOAML:1,SARSF:1,MRT:0,TYPEMS:0}); this.masterRaw.set({}); this.details.set([]); this.clearMessages(); break;
      case 'edit': if(this.posted()){this.err.set('مُرحّل');return;} this.mode.set('edit'); break;
      case 'save': this.save(); break;
      case 'delete': this.del(); break;
      case 'cancel': { const n=Number(this.masterRaw()['NOS']); if(n)this.loadOne(n); else this.mode.set('browse'); } break;
      case 'refresh': this.loadList(); break;
      case 'exit': window.history.back(); break;
    }
  }

  async save() {
    const fState=this.f(); if(fState.invalid()){this.err.set('تحقق من الحقول المطلوبة');return;}
    this.saving.set(true); this.clearMessages();
    try {
      const isNew=this.mode()==='new'; const fv=this.model();
      const body={...this.masterRaw(),...fv,DI:isNew?new Date().toISOString():this.masterRaw()['DI'],DE:!isNew?new Date().toISOString():this.masterRaw()['DE'],PCI:isNew?'WEB':this.masterRaw()['PCI'],PCE:!isNew?'WEB':this.masterRaw()['PCE']};
      const r = await firstValueFrom(isNew ? this.http.post<{ok:boolean;error?:string}>('/api/data/ATM',body) : this.http.put<{ok:boolean;error?:string}>('/api/data/ATM',{...body,_where:'NOS='+this.masterRaw()['NOS']}));
      if(!r.ok){this.err.set(r.error||'فشل');this.saving.set(false);return;}
      this.info.set(isNew?'تم الإنشاء':'تم التحديث'); await this.loadList(); this.mode.set('browse');
    } catch(e){this.err.set(e instanceof Error?e.message:'خطأ');} this.saving.set(false);
  }

  async del() {
    const nos=Number(this.masterRaw()['NOS']); if(!nos||this.posted()||!confirm('حذف '+nos+'؟'))return;
    this.saving.set(true);
    try { await firstValueFrom(this.http.delete('/api/data/ATM?where=NOS='+nos)); await this.loadList(); }
    catch(e){this.err.set(e instanceof Error?e.message:'خطأ');} this.saving.set(false);
  }

  clearMessages() { this.err.set(null); this.info.set(null); }
  masterRecord(): Row { return this.masterRaw(); }
}
