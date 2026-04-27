import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-legacy-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  templateUrl: './legacy-dialog.component.html',
  styleUrl: './legacy-dialog.component.scss',
})
export class LegacyDialogComponent {
  readonly open = input<boolean>(false);
  readonly title = input<string>('Dialog');
  readonly close = output<void>();

  onBackdrop(): void {
    this.close.emit();
  }
}
