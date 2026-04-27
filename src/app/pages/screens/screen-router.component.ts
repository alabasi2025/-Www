import { Component, OnInit, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { SndsComponent } from './snds/snds.component';
import { SndkdComponent } from './sndkd/sndkd.component';
import { Sndkd2Component } from './sndkd2/sndkd2.component';
import { AkfaComponent } from './akfa/akfa.component';
import { TreeComponent } from './tree/tree.component';
import { DataAmlComponent } from './data-aml/data-aml.component';
import { DataAmComponent } from './data-am/data-am.component';
import { MrtComponent } from './mrt/mrt.component';
import { DataMhComponent } from './data-mh/data-mh.component';
import { DataSnComponent } from './data-sn/data-sn.component';
import { ParcodComponent } from './parcod/parcod.component';
import { AhtsarComponent } from './ahtsar/ahtsar.component';
import { UserComponent } from './user/user.component';
import { TmComponent } from './tm/tm.component';
import { RepkdComponent } from './repkd/repkd.component';
import { SysallComponent } from './sysall/sysall.component';
import { RsedifComponent } from './rsedif/rsedif.component';
import { VoucherReportComponent } from './voucher-report/voucher-report.component';
import { MemoComponent } from './memo/memo.component';
import { SmsnComponent } from './smsn/smsn.component';
import { KfComponent } from './kf/kf.component';
import { TrhlComponent } from './trhl/trhl.component';
import { SmsComponent } from './sms/sms.component';
import { CopyComponent } from './copy/copy.component';
import { AkfalAdminComponent } from './akfal-admin/akfal-admin.component';
import { TelComponent } from './tel/tel.component';
import { InanouComponent } from './inanou/inanou.component';
import { SysSmsComponent } from './sys-sms/sys-sms.component';
import { MsdkaComponent } from './msdka/msdka.component';
import { FbComponent } from './fb/fb.component';
import { Fm2Component } from './fm2/fm2.component';
import { FbmComponent } from './fbm/fbm.component';
import { FbaComponent } from './fba/fba.component';
import { ArdsComponent } from './ards/ards.component';
import { FmmComponent } from './fmm/fmm.component';
import { AtmComponent } from './atm/atm.component';
import { AsmComponent } from './asm/asm.component';
import { AtmmComponent } from './atmm/atmm.component';
import { SmrComponent } from './smr/smr.component';
import { GmComponent } from './gm/gm.component';
import { TsmkComponent } from './tsmk/tsmk.component';
import { TsmComponent } from './tsm/tsm.component';
import { MMbComponent } from './m-mb/m-mb.component';
import { TreegComponent } from './treeg/treeg.component';
import { AbComponent } from './ab/ab.component';
import { TserComponent } from './tser/tser.component';
import { DataIntComponent } from './data-int/data-int.component';
import { Sysall2Component } from './sysall2/sysall2.component';
import { UpdeComponent } from './upde/upde.component';
import { RamtComponent } from './ramt/ramt.component';
import { RamtmComponent } from './ramtm/ramtm.component';
import { RasmComponent } from './rasm/rasm.component';
import { RepkhallComponent } from './repkhall/repkhall.component';
import { RepkhrComponent } from './repkhr/repkhr.component';
import { RepkhhrComponent } from './repkhhr/repkhhr.component';
import { RepkhallrComponent } from './repkhallr/repkhallr.component';
import { RepsndokComponent } from './repsndok/repsndok.component';
import { RepdayComponent } from './repday/repday.component';
import { RepmemoComponent } from './repmemo/repmemo.component';
import { RepmznComponent } from './repmzn/repmzn.component';
import { ReprandhComponent } from './reprandh/reprandh.component';
import { RepmznyhComponent } from './repmznyh/repmznyh.component';
import { RsedifmComponent } from './rsedifm/rsedifm.component';
import { RepfbComponent } from './repfb/repfb.component';
import { RepfbmComponent } from './repfbm/repfbm.component';
import { RepAmlhSnfComponent } from './rep-amlh-snf/rep-amlh-snf.component';
import { RmComponent } from './rm/rm.component';
import { RmmComponent } from './rmm/rmm.component';
import { RepkhallsComponent } from './repkhalls/repkhalls.component';
import { RsnfComponent } from './rsnf/rsnf.component';
import { RephsComponent } from './rephs/rephs.component';
import { RephshComponent } from './rephsh/rephsh.component';
import { RsmrComponent } from './rsmr/rsmr.component';
import { RtsmComponent } from './rtsm/rtsm.component';
import { RtmComponent } from './rtm/rtm.component';
import { RtiComponent } from './rti/rti.component';
import { AccountStatementComponent } from './account-statement/account-statement.component';
import { GenericScreenComponent } from './generic/generic-screen.component';
import { LEGACY_SCREEN_TITLES } from '../../shared/legacy-ui/registry/legacy-system.registry';

const VOUCHER_SCREENS  = new Set(['SNDS', 'SNDK']);
const JOURNAL_SCREENS  = new Set(['SNDKD']);
const TRANSFER_SCREENS = new Set(['SNDKD2']);
const CLOSURE_SCREENS  = new Set(['AKFA']);
const TREE_SCREENS     = new Set(['TREE', 'DATA_AC']);
const CURRENCY_SCREENS = new Set(['DATA_AML']);
const CUSTOMER_SCREENS = new Set(['DATA_AM']);
const SUPPLIER_SCREENS = new Set(['DATA_MO']);
const MRT_SCREENS      = new Set(['MRT']);
const WAREHOUSE_SCR    = new Set(['DATA_MH']);
const ITEM_SCREENS     = new Set(['DATA_SN']);
const BARCODE_SCREENS  = new Set(['PARCOD']);
const SHORTCUT_SCREENS = new Set(['AHTSAR']);
const USER_SCREENS     = new Set(['USER']);
const STOCK_SUPPLY_SCR = new Set(['TM', 'STARTN']);
const JOURNAL_REPORT_SCR = new Set(['REPKD', 'REPKD2']);
const VOUCHER_REPORT_SCREENS = new Set(['REPSK', 'REPSS']);
const SYSALL_SCREENS   = new Set(['SYSALL']);
const OPENING_BALANCE_SCREENS = new Set(['RSEDIF']);
const MEMO_SCREENS = new Set(['MEMO']);
const SMSN_SCREENS = new Set(['SMSN']);
const KF_SCREENS = new Set(['KF']);
const TRHL_SCREENS = new Set(['TRHL']);
const SMS_SCREENS = new Set(['SMS']);
const COPY_SCREENS = new Set(['COPY']);
const AKFAL_ADMIN_SCREENS = new Set(['AKFAL']);
const TEL_SCREENS = new Set(['TEL']);
const INANOU_SCREENS = new Set(['INANOU']);
const SYS_SMS_SCREENS = new Set(['SYS_SMS']);
const MSDKA_SCREENS = new Set(['MSDKA']);
const FB_SCREENS = new Set(['FB']);
const FM2_SCREENS = new Set(['FM2']);
const ACCOUNT_STATEMENT_SCREENS = new Set(['KSHF', 'KSHFHSAB', 'ACCOUNT_STATEMENT', 'REPKHALLNEW']);
const REMAINING_SCREENS = new Set(['FBM','FBA','ARDS','FMM','ATM','ASM','ATMM','SMR','GM','TSMK','TSM','M_MB','TREEG','AB','TSER','DATA_INT','SYSALL2','UPDE','RAMT','RAMTM','RASM','REPKHALL','REPKHR','REPKHHR','REPKHALLR','REPSNDOK','REPDAY','REPMEMO','REPMZN','REPRANDH','REPMZNYH','RSEDIFM','REPFB','REPFBM','REP_AMLH_SNF','RM','RMM','REPKHALLS','RSNF','REPHS','REPHSH','RSMR','RTSM','RTM','RTI']);

type Kind = 'voucher' | 'journal' | 'transfer' | 'closure' | 'tree' | 'currency'
          | 'customer' | 'supplier' | 'mrt' | 'warehouse'
          | 'item' | 'barcode' | 'shortcut' | 'user' | 'stock-supply'
          | 'journal-report' | 'voucher-report' | 'sysall' | 'opening-balance'
          | 'memo' | 'smsn' | 'kf' | 'trhl' | 'sms' | 'copy' | 'akfal-admin'
          | 'tel' | 'inanou-report' | 'sys-sms' | 'msdka' | 'fb' | 'fm2' | 'account-statement'
          | 'fbm' | 'fba' | 'ards' | 'fmm' | 'atm' | 'asm' | 'atmm' | 'smr' | 'gm'
          | 'tsmk' | 'tsm' | 'm-mb' | 'treeg' | 'ab' | 'tser' | 'data-int' | 'sysall2'
          | 'upde' | 'ramt' | 'ramtm' | 'rasm'
          | 'repkhall' | 'repkhr' | 'repkhhr' | 'repkhallr' | 'repsndok' | 'repday'
          | 'repmemo' | 'repmzn' | 'reprandh' | 'repmznyh' | 'rsedifm'
          | 'repfb' | 'repfbm' | 'rep-amlh-snf' | 'rm' | 'rmm'
          | 'repkhalls' | 'rsnf' | 'rephs' | 'rephsh' | 'rsmr' | 'rtsm' | 'rtm' | 'rti'
          | 'generic';

@Component({
  selector: 'app-screen-router',
  imports: [
    CommonModule, SndsComponent, SndkdComponent, Sndkd2Component, AkfaComponent, TreeComponent,
    DataAmlComponent, DataAmComponent, MrtComponent, DataMhComponent,
    DataSnComponent, ParcodComponent, AhtsarComponent, UserComponent,
    TmComponent, RepkdComponent, VoucherReportComponent, SysallComponent, RsedifComponent, MemoComponent,
    SmsnComponent, KfComponent, TrhlComponent,
    SmsComponent, CopyComponent, AkfalAdminComponent, TelComponent,
    InanouComponent, SysSmsComponent, MsdkaComponent, FbComponent, Fm2Component,
    FbmComponent, FbaComponent, ArdsComponent, FmmComponent,
    AtmComponent, AsmComponent, AtmmComponent, SmrComponent, GmComponent,
    TsmkComponent, TsmComponent, MMbComponent, TreegComponent, AbComponent,
    TserComponent, DataIntComponent, Sysall2Component,
    UpdeComponent, RamtComponent, RamtmComponent, RasmComponent,
    RepkhallComponent, RepkhrComponent, RepkhhrComponent, RepkhallrComponent,
    RepsndokComponent, RepdayComponent, RepmemoComponent, RepmznComponent,
    ReprandhComponent, RepmznyhComponent, RsedifmComponent,
    RepfbComponent, RepfbmComponent, RepAmlhSnfComponent,
    RmComponent, RmmComponent, RepkhallsComponent, RsnfComponent,
    RephsComponent, RephshComponent, RsmrComponent, RtsmComponent, RtmComponent, RtiComponent,
    AccountStatementComponent,
    GenericScreenComponent,
  ],
  template: `
    <div class="screen-shell"
         [class.legacy-mdi-shell]="kind() === 'customer' || kind() === 'supplier'"
         [class.legacy-mdi-customer]="kind() === 'customer'"
         [class.legacy-mdi-supplier]="kind() === 'supplier'"
         [class.legacy-floating-shell]="kind() !== 'customer' && kind() !== 'supplier'"
         dir="rtl">
      <div class="screen-topbar">
        <button class="back-btn" type="button" (click)="goBack()">
          <i class="pi pi-arrow-right"></i>
          <span>رجوع</span>
        </button>
        <div class="screen-title">{{ screenTitle() }}</div>
      </div>

      <div class="screen-body">
        @switch (kind()) {
          @case ('voucher')   { <app-snds /> }
          @case ('journal')   { <app-sndkd /> }
          @case ('transfer')  { <app-sndkd2 /> }
          @case ('closure')   { <app-akfa /> }
          @case ('tree')      { <app-tree /> }
          @case ('currency')  { <app-data-aml /> }
          @case ('customer')  { <app-data-am kind="customer" /> }
          @case ('supplier')  { <app-data-am kind="supplier" /> }
          @case ('mrt')       { <app-mrt /> }
          @case ('warehouse') { <app-data-mh /> }
          @case ('item')      { <app-data-sn /> }
          @case ('barcode')   { <app-parcod /> }
          @case ('shortcut')  { <app-ahtsar /> }
          @case ('user')      { <app-user-mgmt /> }
          @case ('stock-supply') { <app-tm /> }
          @case ('journal-report') { <app-repkd /> }
          @case ('voucher-report') { <app-voucher-report /> }
          @case ('sysall')    { <app-sysall /> }
          @case ('opening-balance') { <app-rsedif /> }
          @case ('memo')      { <app-memo /> }
          @case ('smsn')      { <app-smsn /> }
          @case ('kf')        { <app-kf /> }
          @case ('trhl')      { <app-trhl /> }
          @case ('sms')       { <app-sms /> }
          @case ('copy')      { <app-copy /> }
          @case ('akfal-admin') { <app-akfal-admin /> }
          @case ('tel')       { <app-tel /> }
          @case ('inanou-report') { <app-inanou /> }
          @case ('sys-sms')   { <app-sys-sms /> }
          @case ('msdka')     { <app-msdka /> }
          @case ('fb')        { <app-fb /> }
          @case ('fm2')       { <app-fm2 /> }
          @case ('account-statement') { <app-account-statement /> }
          @case ('fbm')       { <app-fbm /> }
          @case ('fba')       { <app-fba /> }
          @case ('ards')      { <app-ards /> }
          @case ('fmm')       { <app-fmm /> }
          @case ('atm')       { <app-atm /> }
          @case ('asm')       { <app-asm /> }
          @case ('atmm')      { <app-atmm /> }
          @case ('smr')       { <app-smr /> }
          @case ('gm')        { <app-gm /> }
          @case ('tsmk')      { <app-tsmk /> }
          @case ('tsm')       { <app-tsm /> }
          @case ('m-mb')      { <app-m-mb /> }
          @case ('treeg')     { <app-treeg /> }
          @case ('ab')        { <app-ab /> }
          @case ('tser')      { <app-tser /> }
          @case ('data-int')  { <app-data-int /> }
          @case ('sysall2')   { <app-sysall2 /> }
          @case ('upde')      { <app-upde /> }
          @case ('ramt')      { <app-ramt /> }
          @case ('ramtm')     { <app-ramtm /> }
          @case ('rasm')      { <app-rasm /> }
          @case ('repkhall')  { <app-repkhall /> }
          @case ('repkhr')    { <app-repkhr /> }
          @case ('repkhhr')   { <app-repkhhr /> }
          @case ('repkhallr') { <app-repkhallr /> }
          @case ('repsndok')  { <app-repsndok /> }
          @case ('repday')    { <app-repday /> }
          @case ('repmemo')   { <app-repmemo /> }
          @case ('repmzn')    { <app-repmzn /> }
          @case ('reprandh')  { <app-reprandh /> }
          @case ('repmznyh')  { <app-repmznyh /> }
          @case ('rsedifm')   { <app-rsedifm /> }
          @case ('repfb')     { <app-repfb /> }
          @case ('repfbm')    { <app-repfbm /> }
          @case ('rep-amlh-snf') { <app-rep-amlh-snf /> }
          @case ('rm')        { <app-rm /> }
          @case ('rmm')       { <app-rmm /> }
          @case ('repkhalls') { <app-repkhalls /> }
          @case ('rsnf')      { <app-rsnf /> }
          @case ('rephs')     { <app-rephs /> }
          @case ('rephsh')    { <app-rephsh /> }
          @case ('rsmr')      { <app-rsmr /> }
          @case ('rtsm')      { <app-rtsm /> }
          @case ('rtm')       { <app-rtm /> }
          @case ('rti')       { <app-rti /> }
          @default            { <app-generic-screen /> }
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display:block; height:100%; }

    .screen-shell {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      background: #d8dde3;
      border: 1px solid #a5adba;
    }

    .screen-topbar {
      height: 34px;
      background: #b8cde2;
      border-bottom: 1px solid #8ea7c0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 8px;
      gap: 10px;
      flex-shrink: 0;
    }

    .back-btn {
      height: 24px;
      min-width: 74px;
      border: 1px solid #6f8294;
      background: linear-gradient(#f8fbff, #dce7f2);
      color: #163754;
      font: 700 12px Tahoma, Arial, sans-serif;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      cursor: pointer;
    }

    .back-btn:hover {
      background: linear-gradient(#ffffff, #e9f1f9);
    }

    .screen-title {
      font: 700 13px Tahoma, Arial, sans-serif;
      color: #0f2f50;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .screen-body {
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    .legacy-mdi-shell .screen-topbar {
      display: none;
    }

    .legacy-floating-shell {
      height: 100%;
      border: 0;
      background: transparent;
      overflow: visible;
    }

    .legacy-floating-shell .screen-topbar {
      display: none;
    }

    .legacy-floating-shell .screen-body {
      height: 100%;
      overflow: visible;
      background: transparent;
    }

    .screen-shell.legacy-mdi-shell {
      --legacy-mdi-left: 188px;
      --legacy-mdi-top: 136px;
      position: fixed;
      left: var(--legacy-mdi-left);
      top: var(--legacy-mdi-top);
      width: min(1014px, calc(100vw - var(--legacy-mdi-left) - 8px));
      height: min(508px, calc(100vh - var(--legacy-mdi-top) - 8px));
      min-height: 0;
      z-index: 30;
      border: 0;
      background: transparent;
      overflow: visible;
    }

    .screen-shell.legacy-mdi-customer {
      --legacy-mdi-left: 170px;
    }

    .screen-shell.legacy-mdi-supplier {
      --legacy-mdi-top: 150px;
    }

    .legacy-mdi-shell .screen-body {
      width: 100%;
      height: 100%;
      overflow: auto;
      background: transparent;
    }
  `],
})
export class ScreenRouterComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  readonly kind = signal<Kind>('generic');
  readonly screenTitle = signal('الشاشة');

  ngOnInit(): void {
    this.route.params.subscribe(p => {
      const namee = String(p['namee'] || '').toUpperCase();
      this.screenTitle.set(this.mapTitle(namee));
      if (namee === 'TM' || namee === 'STARTN') this.screenTitle.set('أمر توريد مخزني');
      if      (VOUCHER_SCREENS.has(namee))   this.kind.set('voucher');
      else if (JOURNAL_SCREENS.has(namee))   this.kind.set('journal');
      else if (TRANSFER_SCREENS.has(namee))  this.kind.set('transfer');
      else if (CLOSURE_SCREENS.has(namee))   this.kind.set('closure');
      else if (TREE_SCREENS.has(namee))      this.kind.set('tree');
      else if (CURRENCY_SCREENS.has(namee)) this.kind.set('currency');
      else if (CUSTOMER_SCREENS.has(namee)) this.kind.set('customer');
      else if (SUPPLIER_SCREENS.has(namee)) this.kind.set('supplier');
      else if (MRT_SCREENS.has(namee))      this.kind.set('mrt');
      else if (WAREHOUSE_SCR.has(namee))    this.kind.set('warehouse');
      else if (ITEM_SCREENS.has(namee))     this.kind.set('item');
      else if (BARCODE_SCREENS.has(namee))  this.kind.set('barcode');
      else if (SHORTCUT_SCREENS.has(namee)) this.kind.set('shortcut');
      else if (USER_SCREENS.has(namee))     this.kind.set('user');
      else if (STOCK_SUPPLY_SCR.has(namee)) this.kind.set('stock-supply');
      else if (JOURNAL_REPORT_SCR.has(namee)) this.kind.set('journal-report');
      else if (VOUCHER_REPORT_SCREENS.has(namee)) this.kind.set('voucher-report');
      else if (SYSALL_SCREENS.has(namee)) this.kind.set('sysall');
      else if (OPENING_BALANCE_SCREENS.has(namee)) this.kind.set('opening-balance');
      else if (MEMO_SCREENS.has(namee)) this.kind.set('memo');
      else if (SMSN_SCREENS.has(namee)) this.kind.set('smsn');
      else if (KF_SCREENS.has(namee)) this.kind.set('kf');
      else if (TRHL_SCREENS.has(namee)) this.kind.set('trhl');
      else if (SMS_SCREENS.has(namee)) this.kind.set('sms');
      else if (COPY_SCREENS.has(namee)) this.kind.set('copy');
      else if (AKFAL_ADMIN_SCREENS.has(namee)) this.kind.set('akfal-admin');
      else if (TEL_SCREENS.has(namee)) this.kind.set('tel');
      else if (INANOU_SCREENS.has(namee)) this.kind.set('inanou-report');
      else if (SYS_SMS_SCREENS.has(namee)) this.kind.set('sys-sms');
      else if (MSDKA_SCREENS.has(namee)) this.kind.set('msdka');
      else if (FB_SCREENS.has(namee)) this.kind.set('fb');
      else if (FM2_SCREENS.has(namee)) this.kind.set('fm2');
      else if (ACCOUNT_STATEMENT_SCREENS.has(namee)) this.kind.set('account-statement');
      else if (REMAINING_SCREENS.has(namee)) this.kind.set(namee.toLowerCase().replace(/_/g, '-') as Kind);
      else this.kind.set('generic');
    });
  }

  goBack(): void {
    void this.router.navigate(['/app']);
  }

  private mapTitle(namee: string): string {
    const legacyTitle = LEGACY_SCREEN_TITLES[namee];
    if (legacyTitle) return legacyTitle;
    switch (namee) {
      case 'KSHF': return 'كشف الحساب';
      case 'KSHFHSAB': return 'كشف الحساب';
      case 'ACCOUNT_STATEMENT': return 'كشف الحساب';
      case 'REPKHALLNEW': return 'كشف الحساب';
      case 'SNDKD': return 'صفحة القيود اليومية';
      case 'SNDKD2': return 'صفحة قيد تحويل';
      case 'SNDK': return 'صفحة سندات القبض';
      case 'SNDS': return 'صفحة سندات الصرف';
      case 'AKFA': return 'صفحة إقفال فوارق العملة';
      case 'REPKD': return 'تقارير القيود اليومية';
      case 'SYSALL': return 'شاشة الإعدادات العامة';
      default: return 'الشاشة';
    }
  }
}
