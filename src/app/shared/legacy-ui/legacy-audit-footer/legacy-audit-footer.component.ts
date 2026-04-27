import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-legacy-audit-footer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  templateUrl: './legacy-audit-footer.component.html',
  styleUrl: './legacy-audit-footer.component.scss',
})
export class LegacyAuditFooterComponent {
  readonly record = input<Record<string, unknown>>({});

  readonly creator = computed(() => this.pick(['NMS', 'NOUSX']));
  readonly createdAt = computed(() => this.pick(['DI']));
  readonly createMachine = computed(() => this.pick(['PCI']));
  readonly editCount = computed(() => this.pick(['NED']));
  readonly updater = computed(() => this.pick(['NMSU', 'NOUSXU']));
  readonly updatedAt = computed(() => this.pick(['DE']));
  readonly updateMachine = computed(() => this.pick(['PCE']));

  private pick(keys: string[]): string {
    const row = this.record();
    for (const key of keys) {
      const value = row[key];
      if (value !== null && value !== undefined && String(value).trim()) {
        return String(value);
      }
    }
    return '';
  }
}
