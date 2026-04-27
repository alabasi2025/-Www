import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { CommonModule } from '@angular/common';

export type LegacyStatusVariant = 'error' | 'warning' | 'success' | 'info';

export interface LegacyStatusBadge {
  label: string;
  icon?: string;
  variant?: LegacyStatusVariant;
}

@Component({
  selector: 'app-legacy-status-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  templateUrl: './legacy-status-bar.component.html',
  styleUrl: './legacy-status-bar.component.scss',
})
export class LegacyStatusBarComponent {
  readonly error = input<unknown>(null);
  readonly warning = input<unknown>(null);
  readonly info = input<unknown>(null);
  readonly badges = input<LegacyStatusBadge[]>([]);
  readonly dismissible = input<boolean>(true);

  readonly dismiss = output<void>();

  readonly current = computed((): { text: string; variant: LegacyStatusVariant } | null => {
    const e = this.toText(this.error());
    if (e) return { text: e, variant: 'error' };

    const w = this.toText(this.warning());
    if (w) return { text: w, variant: 'warning' };

    const i = this.toText(this.info());
    if (i) return { text: i, variant: 'success' };

    return null;
  });

  readonly visible = computed(() => !!this.current() || this.badges().length > 0);

  onDismiss(): void {
    this.dismiss.emit();
  }

  private toText(v: unknown): string {
    if (typeof v === 'string') return v.trim();
    if (v == null) return '';
    if (typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      const msg = obj['message'];
      const err = obj['error'];
      if (typeof msg === 'string' && msg.trim()) return msg.trim();
      if (typeof err === 'string' && err.trim()) return err.trim();
      try {
        const json = JSON.stringify(v);
        if (json && json !== '{}' && json !== '[]') return json;
      } catch {
        // Ignore and fall back to plain string conversion.
      }
    }
    return String(v).trim();
  }
}
