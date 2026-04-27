import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';

/**
 * AuditCardComponent — reusable Audit trail card.
 *
 * Displays the standard Oracle Forms audit fields:
 *   DI      → date inserted        (الإدخال)
 *   DE      → date edited          (آخر تعديل)
 *   NED     → edit counter         (عدد مرات التعديل)
 *   NOUSX   → inserting user       (المستخدم المُدخِل)
 *   NOUSXU  → updating user        (المستخدم المُعدِّل)
 *   PCI     → inserting machine    (الجهاز المدخل)
 *   PCE     → editing machine      (الجهاز المعدل)
 *
 * Accepts a generic `record` input (Record<string, unknown>) and renders
 * only the parts that have data. Used across all main-entity screens
 * (SNDS, SNDK, TREE, FB, AKFA, etc.).
 */
@Component({
  selector: 'app-audit-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, DatePipe],
  templateUrl: './audit-card.component.html',
  styleUrl: './audit-card.component.scss',
})
export class AuditCardComponent {
  /** The record whose audit fields should be displayed. */
  readonly record = input.required<Record<string, unknown>>();

  /** Whether to render the full card (title + frame) or just inline fields. */
  readonly inline = input<boolean>(false);

  asStr(v: unknown): string { return String(v ?? ''); }

  get hasAny(): boolean {
    const r = this.record();
    return !!(r['DI'] || r['DE']);
  }
}
