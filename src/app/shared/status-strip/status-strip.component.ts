import {
  Component, ChangeDetectionStrategy, input, output, computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';

/** Convenience variant mapping for quick messages. */
export type StatusVariant = 'success' | 'warning' | 'error' | 'info';

export interface StatusBadge {
  label: string;
  /** PrimeIcons class without leading 'pi ' (e.g. 'pi-hashtag'). */
  icon?: string;
  variant?: StatusVariant;
  title?: string;
}

/**
 * StatusStripComponent — unified error/info/status display.
 *
 * Replaces the ad-hoc pattern found in most legacy-converted screens:
 * ```html
 * @if (err()) { <div class="alert alert-err">...</div> }
 * @if (info()) { <div class="alert alert-ok">...</div> }
 * ```
 *
 * Supports:
 *   - A primary message (`error` | `info`) with dismissible option
 *   - A set of contextual badges (e.g. "رقم: 1234", "مُرحّل")
 *   - Implicit color coding by variant
 *
 * Usage:
 * ```html
 * <app-status-strip
 *   [error]="err()"
 *   [info]="info()"
 *   [badges]="statusBadges()"
 *   (dismiss)="clearMessages()" />
 * ```
 */
@Component({
  selector: 'app-status-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  templateUrl: './status-strip.component.html',
  styleUrl: './status-strip.component.scss',
})
export class StatusStripComponent {
  /** Error message (red bar). Rendered first when set. */
  readonly error = input<unknown>(null);

  /** Info / success message (green bar). Rendered if `error` is falsy. */
  readonly info = input<unknown>(null);

  /** Optional warning message. Takes precedence over info but not error. */
  readonly warning = input<unknown>(null);

  /** Optional right-side context badges. */
  readonly badges = input<StatusBadge[]>([]);

  /** When true, a close button is rendered on the primary message. */
  readonly dismissible = input<boolean>(true);

  /** Emitted when the user clicks the close button. */
  readonly dismiss = output<void>();

  private toText(v: unknown): string {
    if (typeof v === 'string') return v.trim();
    if (v == null) return '';
    if (typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      const msg = obj['message'];
      const err = obj['error'];
      if (typeof msg === 'string' && msg.trim()) return msg.trim();
      if (typeof err === 'string' && err.trim()) return err.trim();
      try { return JSON.stringify(v); } catch { return String(v); }
    }
    return String(v).trim();
  }

  /** Effective displayed message + variant (error > warning > info). */
  readonly current = computed<{ message: string; variant: StatusVariant } | null>(() => {
    const e = this.toText(this.error());
    if (e) return { message: e, variant: 'error' };
    const w = this.toText(this.warning());
    if (w) return { message: w, variant: 'warning' };
    const i = this.toText(this.info());
    if (i) return { message: i, variant: 'success' };
    return null;
  });

  /** Show the strip whenever there is any content to render. */
  readonly visible = computed(() => !!this.current() || this.badges().length > 0);

  readonly iconFor = (v: StatusVariant): string => {
    switch (v) {
      case 'error':   return 'pi-exclamation-triangle';
      case 'warning': return 'pi-exclamation-circle';
      case 'success': return 'pi-check-circle';
      case 'info':    return 'pi-info-circle';
    }
  };

  onDismiss(): void { this.dismiss.emit(); }
}
